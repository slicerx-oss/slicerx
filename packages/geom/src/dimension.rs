// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! dimensions that stay on the model
// feature and triangle indices come from the meshes they were picked on
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::measure::{self, Feature, Measurement, Pick};
use crate::mesh::TriMesh;
use crate::push::Moved;
use crate::vec3::{self, V2, V3};
use crate::xform::{self, Mat4};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const POS_MM: f64 = 0.001;
/// directions match within this many degrees
const DIR_DEG: f64 = 0.01;
const CHANGED: f64 = 0.0005;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub object: String,
    pub pick: Pick,
    #[serde(default)]
    pub snap_mm: f64,
    pub feature: Feature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Distance,
    Angle,
    Radius,
    Diameter,
    Length,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dimension {
    pub id: String,
    pub kind: Kind,
    pub a: Anchor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<Anchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMove {
    pub object: String,
    #[serde(flatten)]
    pub moved: Moved,
}

pub struct Object<'a> {
    pub mesh: &'a TriMesh,
    pub transform: Mat4,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluated {
    pub id: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    pub unit: &'static str,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measurement: Option<Measurement>,
    pub a: Anchor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub b: Option<Anchor>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lost: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn normal_matrix(m: &Mat4) -> Option<Mat4> {
    let inv = xform::invert(m)?;
    let mut t = [0.0; 16];
    for r in 0..3 {
        for c in 0..3 {
            t[c * 4 + r] = inv[r * 4 + c];
        }
    }
    t[15] = 1.0;
    Some(t)
}

fn plane_scale(m: &Mat4, axis: V3) -> f64 {
    let e1 = vec3::any_perpendicular(axis);
    let e2 = vec3::cross(axis, e1);
    vec3::len(vec3::cross(xform::apply_dir(m, e1), xform::apply_dir(m, e2))).sqrt()
}

pub fn transform_feature(f: &Feature, m: &Mat4) -> Feature {
    let p = |q: V3| xform::apply(m, q);
    let d = |q: V3| vec3::normalize(xform::apply_dir(m, q)).unwrap_or(q);
    let nm = normal_matrix(m);
    let n = |q: V3| {
        nm.as_ref()
            .and_then(|k| vec3::normalize(xform::apply_dir(k, q)))
            .unwrap_or(q)
    };
    match f.clone() {
        Feature::Point { at } => Feature::Point { at: p(at) },
        Feature::Edge { a, b } => Feature::Edge { a: p(a), b: p(b) },
        Feature::Circle {
            center,
            axis,
            radius,
            sweep_deg,
        } => Feature::Circle {
            center: p(center),
            axis: n(axis),
            radius: radius * plane_scale(m, axis),
            sweep_deg,
        },
        Feature::Plane {
            point,
            normal,
            area_mm2,
            triangles,
        } => {
            let s = plane_scale(m, normal);
            Feature::Plane {
                point: p(point),
                normal: n(normal),
                area_mm2: area_mm2 * s * s,
                triangles,
            }
        }
        Feature::Cylinder {
            point,
            axis,
            radius,
            triangles,
        } => Feature::Cylinder {
            point: p(point),
            axis: d(axis),
            radius: radius * plane_scale(m, axis),
            triangles,
        },
        Feature::Surface {
            at,
            normal,
            triangles,
        } => Feature::Surface {
            at: p(at),
            normal: n(normal),
            triangles,
        },
    }
}

fn same_dir(a: V3, b: V3, either_way: bool) -> bool {
    let c = vec3::dot(a, b);
    let c = if either_way { c.abs() } else { c };
    c >= DIR_DEG.to_radians().m_cos()
}

fn near(a: V3, b: V3, tol: f64) -> bool {
    vec3::len(vec3::sub(a, b)) <= tol
}

fn line_dist(p: V3, a: V3, d: V3) -> f64 {
    let v = vec3::sub(p, a);
    vec3::len(vec3::sub(v, vec3::scale(d, vec3::dot(v, d))))
}

fn matches(want: &Feature, found: &Feature, tol: f64) -> bool {
    match (want, found) {
        (Feature::Point { at: a }, Feature::Point { at: b })
        | (Feature::Surface { at: a, .. }, Feature::Surface { at: b, .. }) => near(*a, *b, tol),
        (Feature::Edge { a, b }, Feature::Edge { a: c, b: d }) => {
            let (Some(u), Some(w)) = (
                vec3::normalize(vec3::sub(*b, *a)),
                vec3::normalize(vec3::sub(*d, *c)),
            ) else {
                return false;
            };
            same_dir(u, w, true) && line_dist(*c, *a, u) <= tol && line_dist(*d, *a, u) <= tol
        }
        (
            Feature::Circle {
                center: c0,
                axis: a0,
                radius: r0,
                ..
            },
            Feature::Circle {
                center: c1,
                axis: a1,
                radius: r1,
                ..
            },
        ) => near(*c0, *c1, tol) && same_dir(*a0, *a1, true) && (r0 - r1).abs() <= tol,
        (
            Feature::Plane {
                point: p0,
                normal: n0,
                ..
            },
            Feature::Plane {
                point: p1,
                normal: n1,
                ..
            },
        ) => same_dir(*n0, *n1, false) && vec3::dot(vec3::sub(*p1, *p0), *n0).abs() <= tol,
        (
            Feature::Cylinder {
                point: p0,
                axis: a0,
                radius: r0,
                ..
            },
            Feature::Cylinder {
                point: p1,
                axis: a1,
                radius: r1,
                ..
            },
        ) => same_dir(*a0, *a1, true) && line_dist(*p1, *p0, *a0) <= tol && (r0 - r1).abs() <= tol,
        _ => false,
    }
}

fn tri_dist2(p: V3, a: V3, b: V3, c: V3) -> f64 {
    // closest point by regions (Ericson, Real-Time Collision Detection 5.1.5)
    let (ab, ac, ap) = (vec3::sub(b, a), vec3::sub(c, a), vec3::sub(p, a));
    let (d1, d2) = (vec3::dot(ab, ap), vec3::dot(ac, ap));
    let q = if d1 <= 0.0 && d2 <= 0.0 {
        a
    } else {
        let bp = vec3::sub(p, b);
        let (d3, d4) = (vec3::dot(ab, bp), vec3::dot(ac, bp));
        let cp = vec3::sub(p, c);
        let (d5, d6) = (vec3::dot(ab, cp), vec3::dot(ac, cp));
        let vc = d1 * d4 - d3 * d2;
        let vb = d5 * d2 - d1 * d6;
        let va = d3 * d6 - d5 * d4;
        if d3 >= 0.0 && d4 <= d3 {
            b
        } else if d6 >= 0.0 && d5 <= d6 {
            c
        } else if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
            vec3::add(a, vec3::scale(ab, d1 / (d1 - d3)))
        } else if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
            vec3::add(a, vec3::scale(ac, d2 / (d2 - d6)))
        } else if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
            vec3::add(
                b,
                vec3::scale(vec3::sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))),
            )
        } else {
            let den = 1.0 / (va + vb + vc);
            vec3::add(a, vec3::add(vec3::scale(ab, vb * den), vec3::scale(ac, vc * den)))
        }
    };
    let d = vec3::sub(p, q);
    vec3::dot(d, d)
}

fn nearest_triangle(mesh: &TriMesh, p: V3, hint: u32, tol: f64) -> Option<u32> {
    let t2 = tol * tol;
    if let Some(&t) = mesh.triangles.get(hint as usize) {
        let [a, b, c] = mesh.corners(t);
        if tri_dist2(p, a, b, c) <= t2 {
            return Some(hint);
        }
    }
    let mut best = (f64::INFINITY, None);
    for (i, &t) in mesh.triangles.iter().enumerate() {
        let [a, b, c] = mesh.corners(t);
        let d = tri_dist2(p, a, b, c);
        if d < best.0 {
            best = (d, u32::try_from(i).ok());
        }
    }
    best.1.filter(|_| best.0 <= t2)
}

fn on_moved_face(m: &Moved, p: V3, tol: f64) -> bool {
    let Ok(f) = m.frame.checked() else {
        return false;
    };
    if f.height(p).abs() > tol {
        return false;
    }
    let q = f.project(p);
    m.outline.iter().any(|poly| {
        poly.contains(q)
            || std::iter::once(&poly.outer)
                .chain(&poly.holes)
                .any(|r| ring_dist(r, q) <= tol)
    })
}

fn ring_dist(r: &[V2], q: V2) -> f64 {
    let n = r.len();
    (0..n)
        .map(|i| {
            let (a, b) = (r[i], r[(i + 1) % n]);
            let ab = [b[0] - a[0], b[1] - a[1]];
            let l2 = ab[0] * ab[0] + ab[1] * ab[1];
            let t = if l2 > 0.0 {
                (((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let d = [q[0] - a[0] - t * ab[0], q[1] - a[1] - t * ab[1]];
            d[0].m_hypot(d[1])
        })
        .fold(f64::INFINITY, f64::min)
}

fn apply_move(f: &Feature, at: V3, m: &Moved, tol: f64) -> (Feature, V3) {
    let Ok(fr) = m.frame.checked() else {
        return (f.clone(), at);
    };
    let shift = vec3::scale(fr.w, m.distance_mm);
    let mv = |p: V3| {
        if on_moved_face(m, p, tol) {
            vec3::add(p, shift)
        } else {
            p
        }
    };
    let f2 = match f.clone() {
        Feature::Point { at } => Feature::Point { at: mv(at) },
        Feature::Edge { a, b } => Feature::Edge { a: mv(a), b: mv(b) },
        Feature::Circle {
            center,
            axis,
            radius,
            sweep_deg,
        } => {
            let rim = vec3::add(center, vec3::scale(vec3::any_perpendicular(axis), radius));
            let moved = same_dir(axis, fr.w, true) && on_moved_face(m, rim, tol);
            Feature::Circle {
                center: if moved { vec3::add(center, shift) } else { center },
                axis,
                radius,
                sweep_deg,
            }
        }
        Feature::Plane {
            point,
            normal,
            area_mm2,
            triangles,
        } => Feature::Plane {
            point: if same_dir(normal, fr.w, true) {
                mv(point)
            } else {
                point
            },
            normal,
            area_mm2,
            triangles,
        },
        other => other,
    };
    let on_plane = matches!(f, Feature::Plane { normal, .. } if !same_dir(*normal, fr.w, true));
    (f2, if on_plane { at } else { mv(at) })
}

fn refind<S: std::hash::BuildHasher>(
    anchor: &Anchor,
    objects: &HashMap<&str, Object<'_>, S>,
    moves: &[ObjectMove],
) -> std::result::Result<(Anchor, Feature), &'static str> {
    let Some(obj) = objects.get(anchor.object.as_str()) else {
        return Err("object");
    };
    let world_mesh = xform::transformed(obj.mesh, &obj.transform);
    let size = world_mesh.bounds().map_or(1.0, |b| b.diagonal());
    let tol = POS_MM.max(size * 1e-7);
    let mut want = transform_feature(&anchor.feature, &obj.transform);
    let mut at = xform::apply(&obj.transform, anchor.pick.at);
    for m in moves.iter().filter(|m| m.object == anchor.object) {
        (want, at) = apply_move(&want, at, &m.moved, tol);
    }
    let tri = nearest_triangle(&world_mesh, at, anchor.pick.triangle, tol).ok_or("feature")?;
    let pick = Pick { triangle: tri, at };
    let found = measure::resolve(&world_mesh, pick, anchor.snap_mm).map_err(|_| "feature")?;
    if !matches(&want, &found, tol) {
        return Err("feature");
    }
    let inv = xform::invert(&obj.transform).ok_or("object")?;
    Ok((
        Anchor {
            object: anchor.object.clone(),
            pick: Pick {
                triangle: tri,
                at: xform::apply(&inv, at),
            },
            snap_mm: anchor.snap_mm,
            feature: transform_feature(&found, &inv),
        },
        found,
    ))
}

fn lost_message(which: &str, why: &str) -> String {
    let end = if which == "a" { "started from" } else { "ended on" };
    match why {
        "object" => format!("The object this dimension {end} is gone."),
        _ => format!("The feature this dimension {end} is gone."),
    }
}

fn value_of(kind: Kind, m: &Measurement) -> Option<f64> {
    match kind {
        Kind::Distance => m.distance_mm,
        Kind::Angle => m.angle_deg,
        Kind::Radius => m.radius_mm,
        Kind::Diameter => m.diameter_mm,
        Kind::Length => m.length_mm,
    }
}

pub fn evaluate<S: std::hash::BuildHasher>(
    dims: &[Dimension],
    objects: &HashMap<&str, Object<'_>, S>,
    moves: &[ObjectMove],
) -> Vec<Evaluated> {
    dims.iter()
        .map(|d| {
            let unit = if d.kind == Kind::Angle { "deg" } else { "mm" };
            let mut out = Evaluated {
                id: d.id.clone(),
                status: "lost",
                value: None,
                unit,
                changed: false,
                measurement: None,
                a: d.a.clone(),
                b: d.b.clone(),
                lost: Vec::new(),
                message: None,
            };
            let needs_b = matches!(d.kind, Kind::Distance | Kind::Angle);
            if needs_b && d.b.is_none() {
                out.message = Some("A distance or an angle needs two ends.".to_owned());
                return out;
            }
            let ra = refind(&d.a, objects, moves);
            let rb = d.b.as_ref().map(|b| refind(b, objects, moves));
            let mut messages = Vec::new();
            if let Err(why) = &ra {
                out.lost.push("a");
                messages.push(lost_message("a", why));
            }
            if let Some(Err(why)) = &rb {
                out.lost.push("b");
                messages.push(lost_message("b", why));
            }
            if !messages.is_empty() {
                out.message = Some(messages.join(" "));
                return out;
            }
            let Ok((a, fa)) = ra else {
                return out;
            };
            let (b, fb) = match rb {
                Some(Ok((b, fb))) => (Some(b), Some(fb)),
                _ => (None, None),
            };
            let m = measure::measure(&fa, if needs_b { fb.as_ref() } else { None });
            let Some(v) = value_of(d.kind, &m) else {
                out.message = Some("This feature has no such measurement.".to_owned());
                return out;
            };
            out.status = "ok";
            out.value = Some(v);
            out.changed = d.value.is_some_and(|old| (old - v).abs() > CHANGED);
            out.measurement = Some(m);
            out.a = a;
            out.b = b;
            out
        })
        .collect()
}

pub fn anchor(
    object: &str,
    mesh: &TriMesh,
    transform: &Mat4,
    pick: Pick,
    snap_mm: f64,
) -> Result<(Anchor, Feature)> {
    let world = xform::transformed(mesh, transform);
    let f = measure::resolve(&world, pick, snap_mm)?;
    let inv = xform::invert(transform)
        .ok_or_else(|| Error::invalid("transform", "must not flatten the part (scale 0)"))?;
    Ok((
        Anchor {
            object: object.to_owned(),
            pick: Pick {
                triangle: pick.triangle,
                at: xform::apply(&inv, pick.at),
            },
            snap_mm,
            feature: transform_feature(&f, &inv),
        },
        f,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boolean::BooleanOptions;
    use crate::build;
    use crate::push;

    fn tri_facing(m: &TriMesh, dir: V3, level: f64) -> (u32, V3) {
        let i = m
            .triangles
            .iter()
            .position(|&t| {
                let n = vec3::normalize(m.normal(t)).unwrap_or([0.0; 3]);
                vec3::dot(n, dir) > 0.999 && vec3::dot(m.corners(t)[0], dir) >= level - 1e-9
            })
            .unwrap();
        let c = m.corners(m.triangles[i]);
        (
            u32::try_from(i).unwrap(),
            vec3::scale(vec3::add(vec3::add(c[0], c[1]), c[2]), 1.0 / 3.0),
        )
    }

    fn translate(d: V3) -> Mat4 {
        xform::translation(d)
    }

    #[test]
    fn height_dimension_survives_moves_and_follows_a_pull() {
        let m = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let id = xform::IDENTITY;
        let (tt, at_top) = tri_facing(&m, [0.0, 0.0, 1.0], 5.0);
        let (tb, at_bot) = tri_facing(&m, [0.0, 0.0, -1.0], 0.0);
        let (a, _) = anchor(
            "box",
            &m,
            &id,
            Pick {
                triangle: tt,
                at: at_top,
            },
            0.0,
        )
        .unwrap();
        let (b, _) = anchor(
            "box",
            &m,
            &id,
            Pick {
                triangle: tb,
                at: at_bot,
            },
            0.0,
        )
        .unwrap();
        let dim = Dimension {
            id: "h".into(),
            kind: Kind::Distance,
            a,
            b: Some(b),
            value: Some(5.0),
        };
        let rot = xform::mul(
            &translate([100.0, -40.0, 3.0]),
            &xform::rotation_about([0.0; 3], [0.0, 0.6, 0.8], 1.1),
        );
        let mut scale_mirror = xform::IDENTITY;
        scale_mirror[0] = -2.0;
        scale_mirror[5] = 2.0;
        scale_mirror[10] = 2.0;
        for (t, want) in [(rot, 5.0), (scale_mirror, 10.0)] {
            let objs = HashMap::from([(
                "box",
                Object {
                    mesh: &m,
                    transform: t,
                },
            )]);
            let r = evaluate(std::slice::from_ref(&dim), &objs, &[]);
            assert_eq!(r[0].status, "ok", "{:?}", r[0]);
            assert!((r[0].value.unwrap() - want).abs() < 1e-6, "{:?}", r[0].value);
        }
        let p = push::push_face(&m, tt, at_top, 3.0, &BooleanOptions::default()).unwrap();
        let objs = HashMap::from([(
            "box",
            Object {
                mesh: &p.mesh,
                transform: id,
            },
        )]);
        let mv = ObjectMove {
            object: "box".into(),
            moved: p.moved.clone(),
        };
        let r = evaluate(std::slice::from_ref(&dim), &objs, &[mv]);
        assert_eq!(r[0].status, "ok", "{:?}", r[0]);
        assert!((r[0].value.unwrap() - 8.0).abs() < 1e-6);
        assert!(r[0].changed);
        let r = evaluate(std::slice::from_ref(&dim), &objs, &[]);
        assert_eq!(r[0].status, "lost");
        assert_eq!(r[0].lost, vec!["a"]);
        assert!(r[0].message.as_deref().unwrap().contains("started from is gone"));
        let none: HashMap<&str, Object<'_>> = HashMap::new();
        let r = evaluate(&[dim], &none, &[]);
        assert_eq!(r[0].lost, vec!["a", "b"]);
    }

    #[test]
    fn hole_diameter_and_edge_length_after_an_unrelated_cut() {
        let plate = build::box_mesh([0.0; 3], [40.0, 20.0, 4.0]);
        let frame = vec3::Frame {
            origin: [10.0, 10.0, -1.0],
            ..vec3::Frame::WORLD
        };
        let hole = build::cylinder(&frame, 3.0, 0.0, 6.0, 48);
        let (m, _) = crate::boolean::boolean(
            &[plate],
            &[hole],
            crate::boolean::BoolOp::Difference,
            &BooleanOptions::default(),
        )
        .unwrap();
        // on the rim, half way along its first segment: a pick on the top face beside the rim
        let a = 7.5f64.to_radians();
        let rim_at = [10.0 + 1.5 * (1.0 + a.m_cos()), 10.0 + 1.5 * a.m_sin(), 4.0];
        let (t, _) = (0..m.triangles.len())
            .map(|i| {
                let [a, b, c] = m.corners(m.triangles[i]);
                (u32::try_from(i).unwrap(), tri_dist2(rim_at, a, b, c))
            })
            .min_by(|x, y| x.1.total_cmp(&y.1))
            .unwrap();
        let (a, f) = anchor(
            "p",
            &m,
            &xform::IDENTITY,
            Pick {
                triangle: t,
                at: rim_at,
            },
            0.5,
        )
        .unwrap();
        assert!(matches!(f, Feature::Circle { .. }), "{f:?}");
        let dia = Dimension {
            id: "d".into(),
            kind: Kind::Diameter,
            a,
            b: None,
            value: None,
        };
        let notch = build::box_mesh([35.0, -1.0, 2.0], [41.0, 21.0, 5.0]);
        let (m2, _) = crate::boolean::boolean(
            &[m],
            &[notch],
            crate::boolean::BoolOp::Difference,
            &BooleanOptions::default(),
        )
        .unwrap();
        let objs = HashMap::from([(
            "p",
            Object {
                mesh: &m2,
                transform: xform::IDENTITY,
            },
        )]);
        let r = evaluate(&[dia], &objs, &[]);
        assert_eq!(r[0].status, "ok", "{:?}", r[0]);
        assert!((r[0].value.unwrap() - 6.0).abs() < 0.01, "{:?}", r[0].value);
        assert_eq!(r[0].unit, "mm");
    }
}
