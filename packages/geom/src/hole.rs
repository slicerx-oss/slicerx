// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the hole tool: find a round hole from a pick, and make it another size in place, with a counterbore or a
//! countersink at its entry
//!
//! A hole is a cylinder face with the material outside it, ending at a flat face at its entry and at another flat
//! face at its far end (a through hole) or at a floor (a blind hole). Its faces come from the mesh's face ids, or
//! from recognition. The new hole is one turned profile, shaft and head together, cut in one boolean; a smaller
//! one first fills the old hole flush with its two ends.

use crate::boolean::{self, BoolOp, BooleanOptions, BooleanReport};
use crate::edge::{Rim, rims_on};
use crate::error::{Error, Result};
use crate::faces::{Faces, Surface};
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::poly2d::Polygon;
use crate::vec3::{self, Frame, V2, V3};
use serde::{Deserialize, Serialize};
/// The new hole reaches this far past the faces it opens through, so the boolean never meets them flush, mm.
const OVERLAP_MM: f64 = 0.01;

/// A round hole: where it enters, which way is out of it, its size and how deep it goes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hole {
    /// The center of the hole on its entry face.
    pub entry: V3,
    /// Unit, out of the hole through its entry (the entry face's outward normal).
    pub axis: V3,
    pub diameter_mm: f64,
    /// From the entry to the far face or the floor.
    pub depth_mm: f64,
    /// Open at the far end too.
    pub through: bool,
}

/// What the hole becomes, in mm. A counterbore and a countersink are at the entry; with neither it is a plain hole.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoleSpec {
    pub diameter_mm: f64,
    /// A blind hole's new depth; the hole's own depth when absent. A through hole stays through.
    #[serde(default)]
    pub depth_mm: Option<f64>,
    #[serde(default)]
    pub counterbore: Option<Counterbore>,
    #[serde(default)]
    pub countersink: Option<Countersink>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counterbore {
    pub diameter_mm: f64,
    pub depth_mm: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Countersink {
    pub diameter_mm: f64,
    /// The cone's full angle, 90 for most metric flat heads.
    #[serde(default = "ninety")]
    pub angle_deg: f64,
}

const fn ninety() -> f64 {
    90.0
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoleReport {
    pub volume_change_mm3: f64,
    pub watertight: bool,
    pub shells: usize,
    pub boolean: BooleanReport,
}

const PICK_A_HOLE: &str = "pick the wall of a round hole that starts at a flat face";

/// The faces of `mesh`: its own when they fit it, else recognized.
fn faces_of(mesh: &TriMesh) -> Faces {
    mesh.faces
        .clone()
        .filter(|f| f.fit(mesh))
        .unwrap_or_else(|| crate::faces::recognize(mesh))
}

/// What the face of triangle `t` is, in a maker's words, for a pick that is not on a hole's wall.
fn face_words(mesh: &TriMesh, faces: &Faces, t: usize) -> &'static str {
    let (Some(&tri), Some(s)) = (
        mesh.triangles.get(t),
        faces.ids.get(t).and_then(|&f| faces.table.get(f as usize)),
    ) else {
        return "no face of the part";
    };
    match *s {
        Surface::Plane { .. } => "a flat face",
        Surface::Cylinder { origin, axis, .. } => {
            let c = mesh.corners(tri);
            let mid = vec3::scale(vec3::add(vec3::add(c[0], c[1]), c[2]), 1.0 / 3.0);
            let d = vec3::sub(mid, origin);
            let radial = vec3::sub(d, vec3::scale(axis, vec3::dot(d, axis)));
            if vec3::dot(mesh.normal(tri), radial) > 0.0 {
                "the outside of a boss or rod"
            } else {
                "a round wall that does not start at a flat face"
            }
        }
        Surface::Cone { .. } => "a cone, such as a countersink or a chamfer",
        Surface::Sphere { .. } => "a ball-shaped face",
        Surface::Other => "a curved face that is not round",
    }
}

/// A pick on triangle `t` that is not on a hole's wall, with what the face there is.
fn not_a_hole(mesh: &TriMesh, t: usize) -> Error {
    let what = face_words(mesh, &faces_of(mesh), t);
    Error::invalid(
        "hole",
        format!("no round hole there: the pick is on {what}; {PICK_A_HOLE}"),
    )
}

/// The hole whose wall triangle `t` is on, entered from the end nearest `at`.
pub fn find(mesh: &TriMesh, t: u32, at: V3) -> Result<Hole> {
    mesh.validate("hole")?;
    let t = t as usize;
    let (cyl, rims) = rims_on(mesh, t).ok_or_else(|| not_a_hole(mesh, t))?;
    let Surface::Cylinder { radius, .. } = cyl else {
        return Err(not_a_hole(mesh, t));
    };
    // The hole's ends: a convex rim where it opens through a face, a concave one at a floor.
    let openings: Vec<&Rim> = rims.iter().filter(|r| r.convex && r.out > 0.0).collect();
    let floors: Vec<&Rim> = rims.iter().filter(|r| !r.convex && r.out < 0.0).collect();
    let near = |r: &&Rim| vec3::len(vec3::sub(r.center, at));
    let entry = *openings
        .iter()
        .min_by(|a, b| near(a).total_cmp(&near(b)))
        .ok_or_else(|| not_a_hole(mesh, t))?;
    let (far, through) = if let Some(f) = openings.iter().find(|r| !std::ptr::eq(**r, entry)) {
        (*f, true)
    } else if let Some(f) = floors.first() {
        (*f, false)
    } else {
        return Err(Error::invalid(
            "hole",
            "the hole does not end at a flat face or a flat floor; pick a plain round hole",
        ));
    };
    let depth = vec3::dot(vec3::sub(entry.center, far.center), entry.normal);
    if depth <= 1e-6 {
        return Err(not_a_hole(mesh, t));
    }
    Ok(Hole {
        entry: entry.center,
        axis: entry.normal,
        diameter_mm: 2.0 * radius,
        depth_mm: depth,
        through,
    })
}

/// The hole whose axis line runs through `at` along `axis` (either way round), entered from the end nearest `at`:
/// how a client that knows where a hole is, but not a triangle of its wall, picks it. `at` may be anywhere inside
/// the hole's circle on that line. Where holes share the line (a counterbore over its shaft), the narrowest is the
/// hole.
pub fn find_on_axis(mesh: &TriMesh, at: V3, axis: V3) -> Result<Hole> {
    mesh.validate("hole")?;
    let axis = vec3::normalize(axis).ok_or_else(|| Error::invalid("axis", "must not be zero"))?;
    let faces = faces_of(mesh);
    let size = mesh.bounds().map_or(1.0, |b| b.diagonal());
    let tol = (size * 1e-5).max(1e-3);
    // each cylinder face round the line, narrowest first, with a triangle of it
    let mut round: Vec<(f64, usize)> = faces
        .table
        .iter()
        .enumerate()
        .filter_map(|(f, s)| {
            let Surface::Cylinder {
                origin,
                axis: a,
                radius,
            } = *s
            else {
                return None;
            };
            let d = vec3::sub(at, origin);
            let off = vec3::len(vec3::sub(d, vec3::scale(a, vec3::dot(d, a))));
            if vec3::dot(a, axis).abs() < 0.9999 || off > radius + tol {
                return None;
            }
            let t = faces.ids.iter().position(|&id| id as usize == f)?;
            Some((radius, t))
        })
        .collect();
    round.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut why = None;
    for (_, t) in round {
        match find(mesh, u32::try_from(t).unwrap_or(u32::MAX), at) {
            Ok(h) => return Ok(h),
            Err(e) => match under_countersink(mesh, &faces, t) {
                Some(h) => return Ok(h),
                None => why = why.or(Some(e)),
            },
        }
    }
    // a round face there that is not a hole says why; with none, the face nearest the point says what is there
    if let Some(e) = why {
        return Err(e);
    }
    let nearest = mesh
        .triangles
        .iter()
        .enumerate()
        .map(|(t, &tri)| {
            (
                t,
                vec3::len(vec3::sub(crate::fit::closest_on_tri(at, &mesh.corners(tri)), at)),
            )
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(t, _)| t);
    let what = nearest.map_or("no face of the part", |t| face_words(mesh, &faces, t));
    Err(Error::invalid(
        "hole",
        format!(
            "no round hole on that axis line; the nearest face to the point is {what}. Give a point on the hole's axis, such as its center on the face it starts at, and the axis"
        ),
    ))
}

/// A shaft that opens onto a flat face at one end, while its other end leads out of the part along its axis with no
/// flat face square to it (a countersunk hole: the cone opens to the face): the hole from its flat end, through, as
/// deep as the shaft is long. Read back only: the hole tool works on holes that start at a flat face.
fn under_countersink(mesh: &TriMesh, faces: &Faces, t: usize) -> Option<Hole> {
    let (Surface::Cylinder { radius, .. }, rims) = rims_on(mesh, t)? else {
        return None;
    };
    let openings: Vec<&Rim> = rims.iter().filter(|r| r.convex && r.out > 0.0).collect();
    let [entry] = openings[..] else { return None };
    if rims.iter().any(|r| !r.convex && r.out < 0.0) {
        return None;
    }
    let f = *faces.ids.get(t)?;
    let depth = mesh
        .triangles
        .iter()
        .zip(&faces.ids)
        .filter(|&(_, &id)| id == f)
        .flat_map(|(&tri, _)| mesh.corners(tri))
        .map(|p| vec3::dot(vec3::sub(entry.center, p), entry.normal))
        .fold(0.0, f64::max);
    // open beyond the far end: nothing of the part crosses the axis from there on (a drill point's cone would)
    let far = vec3::sub(entry.center, vec3::scale(entry.normal, depth));
    let out = vec3::scale(entry.normal, -1.0);
    let open = mesh.triangles.iter().all(|&tri| {
        let [a, b, c] = mesh.corners(tri);
        crate::convex::ray_distance(far, out, a, b, c).is_none()
    });
    (open && depth > 1e-6).then_some(Hole {
        entry: entry.center,
        axis: entry.normal,
        diameter_mm: 2.0 * radius,
        depth_mm: depth,
        through: true,
    })
}

fn positive(what: &'static str, v: f64) -> Result<f64> {
    if v.is_finite() && v > 0.0 && v <= 10_000.0 {
        Ok(v)
    } else {
        Err(Error::invalid(what, "must be above 0 (at most 10000 mm)"))
    }
}

/// The new hole's profile in (radius, height above the far end) with the head at the entry, `top` high.
fn profile(spec: &HoleSpec, bottom: f64, top: f64) -> Result<Vec<V2>> {
    let r = positive("diameterMm", spec.diameter_mm)? / 2.0;
    let up = top + OVERLAP_MM;
    let mut ring = vec![[0.0, bottom], [r, bottom]];
    match (spec.counterbore, spec.countersink) {
        (Some(_), Some(_)) => {
            return Err(Error::invalid(
                "hole",
                "a hole takes a counterbore or a countersink, not both",
            ));
        }
        (Some(c), None) => {
            let rc = positive("counterbore.diameterMm", c.diameter_mm)? / 2.0;
            let d = positive("counterbore.depthMm", c.depth_mm)?;
            if rc <= r {
                return Err(Error::invalid(
                    "counterbore.diameterMm",
                    "must be above the hole's diameter",
                ));
            }
            if top - d <= bottom {
                return Err(Error::invalid(
                    "counterbore.depthMm",
                    "must be less than the hole's depth",
                ));
            }
            ring.extend([[r, top - d], [rc, top - d], [rc, up]]);
        }
        (None, Some(c)) => {
            let rh = positive("countersink.diameterMm", c.diameter_mm)? / 2.0;
            if rh <= r {
                return Err(Error::invalid(
                    "countersink.diameterMm",
                    "must be above the hole's diameter",
                ));
            }
            if !(30.0..=150.0).contains(&c.angle_deg) {
                return Err(Error::invalid(
                    "countersink.angleDeg",
                    "must be between 30 and 150",
                ));
            }
            let tan = (c.angle_deg.to_radians() * 0.5).m_tan();
            let cone = (rh - r) / tan;
            if top - cone <= bottom {
                return Err(Error::invalid(
                    "countersink.diameterMm",
                    "the countersink is deeper than the hole",
                ));
            }
            ring.extend([[r, top - cone], [rh + OVERLAP_MM * tan, up]]);
        }
        (None, None) => ring.push([r, up]),
    }
    ring.push([0.0, up]);
    Ok(ring)
}

/// The hole `hole` describes, found again on `mesh`: a hole wall on the same axis line with the same diameter,
/// with its depth and ends as they are now (an earlier step may have made the part thicker).
pub fn locate(mesh: &TriMesh, hole: &Hole) -> Result<Hole> {
    let gone = || Error::invalid("hole", "the hole is not there any more; pick it again");
    let axis = vec3::normalize(hole.axis).ok_or_else(gone)?;
    let faces = faces_of(mesh);
    let size = mesh.bounds().map_or(1.0, |b| b.diagonal());
    let tol = (size * 1e-5).max(1e-3);
    let on_line = |origin: V3, a: V3, r: f64| {
        let d = vec3::sub(hole.entry, origin);
        let off = vec3::len(vec3::sub(d, vec3::scale(a, vec3::dot(d, a))));
        vec3::dot(a, axis).abs() > 0.9999 && off < tol && (2.0 * r - hole.diameter_mm).abs() < tol
    };
    let t = faces
        .ids
        .iter()
        .position(|&f| matches!(faces.table.get(f as usize), Some(&Surface::Cylinder { origin, axis: a, radius }) if on_line(origin, a, radius)))
        .ok_or_else(gone)?;
    let found = find(mesh, u32::try_from(t).map_err(|_| gone())?, hole.entry)?;
    if vec3::dot(found.axis, axis) < 0.9999 {
        return Err(gone());
    }
    Ok(found)
}

/// The hole made to `spec` in place: a larger one cut around it, a smaller one cut after the old one is filled. The
/// hole is found again first, so a replay works on it as it is now.
pub fn apply(
    mesh: &TriMesh,
    hole: &Hole,
    spec: &HoleSpec,
    opts: &BooleanOptions,
) -> Result<(TriMesh, HoleReport)> {
    mesh.validate("hole")?;
    let hole = &locate(mesh, hole)?;
    let axis = vec3::normalize(hole.axis).ok_or_else(|| Error::invalid("hole.axis", "must not be zero"))?;
    let new_r = positive("diameterMm", spec.diameter_mm)? / 2.0;
    let old_r = hole.diameter_mm / 2.0;
    let depth = match spec.depth_mm {
        Some(d) if !hole.through => positive("depthMm", d)?,
        _ => hole.depth_mm,
    };
    let far = vec3::sub(hole.entry, vec3::scale(axis, hole.depth_mm));
    let frame =
        Frame::from_normal(far, axis, None).ok_or_else(|| Error::invalid("hole.axis", "must not be zero"))?;
    let solid0 = boolean::Solid::new(mesh)?;
    let v0 = solid0.volume();
    let mut body = mesh.clone();
    // A smaller hole, or a blind one made shallower, needs the old one filled first: flush with its two ends,
    // and wide enough to cover the old wall's facets.
    if new_r < old_r || depth < hole.depth_mm {
        let pad = (old_r * 0.02).max(0.05);
        let fill = crate::build::cylinder(
            &frame,
            old_r + pad,
            0.0,
            hole.depth_mm,
            crate::build::circle_segments(old_r + pad, 0.01),
        );
        body = boolean::boolean(&[body], &[fill], BoolOp::Union, opts)?.0;
    }
    let bottom = if hole.through {
        -OVERLAP_MM
    } else {
        hole.depth_mm - depth
    };
    let ring = profile(spec, bottom, hole.depth_mm)?;
    let tool = crate::sketch::revolve(
        &Frame {
            origin: far,
            u: frame.u,
            v: axis,
            w: vec3::cross(frame.u, axis),
        },
        &[Polygon::simple(ring)],
        [0.0, 0.0],
        [0.0, 1.0],
        360.0,
    )?;
    let (out, r) = boolean::boolean(&[body], &[tool], BoolOp::Difference, opts)?;
    if r.empty || out.triangles.is_empty() {
        return Err(Error::geometry("hole", "the change removes the whole body"));
    }
    if !r.watertight {
        return Err(Error::geometry(
            "hole",
            "the result is not watertight; try another size",
        ));
    }
    Ok((
        out,
        HoleReport {
            volume_change_mm3: r.volume_mm3 - v0,
            watertight: r.watertight,
            shells: r.shells,
            boolean: r,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;
    use std::f64::consts::PI;

    fn post(r: f64, h0: f64, h1: f64) -> TriMesh {
        let f = Frame {
            origin: [15.0, 10.0, 0.0],
            ..Frame::WORLD
        };
        build::cylinder(&f, r, h0, h1, 48)
    }

    fn plate_minus(tool: TriMesh) -> TriMesh {
        let plate = build::box_mesh([0.0; 3], [30.0, 20.0, 5.0]);
        boolean::boolean(&[plate], &[tool], BoolOp::Difference, &BooleanOptions::default())
            .unwrap()
            .0
    }

    /// A triangle of the hole's wall, and a point near its top.
    fn wall(m: &TriMesh) -> (u32, V3) {
        for (t, &tri) in m.triangles.iter().enumerate() {
            let c = m.corners(tri);
            let n = vec3::normalize(m.normal(tri)).unwrap_or([0.0; 3]);
            let mid = vec3::scale(vec3::add(vec3::add(c[0], c[1]), c[2]), 1.0 / 3.0);
            if n[2].abs() < 0.01 && (mid[0] - 15.0).m_hypot(mid[1] - 10.0) < 4.0 {
                return (u32::try_from(t).unwrap(), [mid[0], mid[1], 4.9]);
            }
        }
        panic!("no wall")
    }

    /// a 30 x 20 x 5 plate drilled the way the subtract op drills, the hole 6 mm from `z0` up through the top
    #[allow(clippy::cast_possible_truncation, reason = "rounding to f32 on purpose")]
    fn subtracted(z0: f64, f32ed: bool) -> TriMesh {
        let mut cube = build::box_mesh([0.0; 3], [30.0, 20.0, 5.0]);
        if f32ed {
            for p in &mut cube.positions {
                *p = p.map(|v| f64::from(v as f32));
            }
        }
        let c = crate::solids::SolidSpec::Cylinder {
            origin: Some([15.0, 10.0, z0]),
            axis: None,
            diameter_mm: Some(6.0),
            radius_mm: None,
            height_mm: 5.5 - z0,
            segments: None,
        };
        let mut out = cube;
        for piece in c.to_convex().unwrap() {
            out = crate::convex::subtract(&out, &crate::convex::overshoot_flush(&piece, &out, 0.01)).unwrap();
        }
        crate::emboss::merge_coplanar(&out).unwrap()
    }

    #[test]
    fn a_subtract_hole_is_found() {
        // the subtract op's cutters: through, flush with the bottom, blind, and on f32 positions as the app sends them;
        // its many-sided cylinder splits the faces at the rims, so the rims have corners on chords
        for (z0, f32ed, through) in [
            (-1.0, false, true),
            (0.0, false, true),
            (2.0, false, false),
            (2.0, true, false),
        ] {
            let m = subtracted(z0, f32ed);
            let (t, at) = wall(&m);
            let h = find(&m, t, at).unwrap_or_else(|e| panic!("z0 {z0}: {e}"));
            assert_eq!(h.through, through, "z0 {z0}");
            assert!((h.diameter_mm - 6.0).abs() < 1e-3, "z0 {z0}: {h:?}");
            assert!((h.depth_mm - (5.0 - z0.max(0.0))).abs() < 1e-3, "z0 {z0}: {h:?}");
            // the thread tool finds the same hole
            #[cfg(feature = "threads")]
            assert!(
                crate::thread::find(&m, t, at).is_ok_and(|th| th.internal),
                "z0 {z0}"
            );
        }
    }

    #[test]
    fn a_through_hole_and_a_blind_one_are_found() {
        let m = plate_minus(post(3.0, -1.0, 6.0));
        let (t, at) = wall(&m);
        let h = find(&m, t, at).unwrap();
        assert!(
            h.through && (h.depth_mm - 5.0).abs() < 1e-6 && (h.diameter_mm - 6.0).abs() < 1e-6,
            "{h:?}"
        );
        assert!(
            vec3::len(vec3::sub(h.entry, [15.0, 10.0, 5.0])) < 1e-6 && h.axis[2] > 0.999,
            "{h:?}"
        );
        let blind = plate_minus(post(3.0, 2.0, 6.0));
        let (t, at) = wall(&blind);
        let h = find(&blind, t, at).unwrap();
        assert!(!h.through && (h.depth_mm - 3.0).abs() < 1e-6, "{h:?}");
        let block = build::box_mesh([0.0; 3], [10.0; 3]);
        assert!(
            find(&block, 0, [0.0; 3])
                .unwrap_err()
                .to_string()
                .contains("round hole")
        );
    }

    #[test]
    fn a_hole_is_found_by_its_axis_from_either_end() {
        let m = plate_minus(post(3.0, -1.0, 6.0));
        // from the top, the axis given either way round
        for axis in [[0.0, 0.0, 1.0], [0.0, 0.0, -1.0]] {
            let h = find_on_axis(&m, [15.0, 10.0, 5.0], axis).unwrap();
            assert!(
                h.through && (h.diameter_mm - 6.0).abs() < 1e-6 && (h.depth_mm - 5.0).abs() < 1e-6,
                "{h:?}"
            );
            assert!(
                vec3::len(vec3::sub(h.entry, [15.0, 10.0, 5.0])) < 1e-6 && h.axis[2] > 0.999,
                "{h:?}"
            );
        }
        // a point off the center but inside the circle, nearer the bottom: entered from the bottom
        let h = find_on_axis(&m, [16.0, 10.5, 0.5], [0.0, 0.0, 1.0]).unwrap();
        assert!(h.entry[2].abs() < 1e-6 && h.axis[2] < -0.999, "{h:?}");
        // the same hole as a pick on its wall finds
        let (t, at) = wall(&m);
        assert_eq!(
            find(&m, t, at).unwrap(),
            find_on_axis(&m, [15.0, 10.0, 5.0], [0.0, 0.0, 1.0]).unwrap()
        );
    }

    #[test]
    fn a_counterbored_hole_is_found_by_its_shaft() {
        let m = plate_minus(post(3.0, -1.0, 6.0));
        let h = find_on_axis(&m, [15.0, 10.0, 5.0], [0.0, 0.0, 1.0]).unwrap();
        let spec = HoleSpec {
            diameter_mm: 3.4,
            depth_mm: None,
            counterbore: Some(Counterbore {
                diameter_mm: 6.5,
                depth_mm: 3.0,
            }),
            countersink: None,
        };
        let (out, _) = apply(&m, &h, &spec, &BooleanOptions::default()).unwrap();
        let shaft = find_on_axis(&out, [15.0, 10.0, 5.0], [0.0, 0.0, 1.0]).unwrap();
        assert!(
            (shaft.diameter_mm - 3.4).abs() < 1e-6 && shaft.through,
            "{shaft:?}"
        );
        assert!(
            (shaft.entry[2] - 2.0).abs() < 1e-6 && (shaft.depth_mm - 2.0).abs() < 1e-6,
            "{shaft:?}"
        );
    }

    #[test]
    fn a_countersunk_hole_is_found_by_its_shaft_from_the_flat_end() {
        let m = plate_minus(post(3.0, -1.0, 6.0));
        let h = find_on_axis(&m, [15.0, 10.0, 5.0], [0.0, 0.0, 1.0]).unwrap();
        let spec = HoleSpec {
            diameter_mm: 3.4,
            depth_mm: None,
            counterbore: None,
            countersink: Some(Countersink {
                diameter_mm: 6.5,
                angle_deg: 90.0,
            }),
        };
        let (out, _) = apply(&m, &h, &spec, &BooleanOptions::default()).unwrap();
        let shaft = find_on_axis(&out, [15.0, 10.0, 5.0], [0.0, 0.0, 1.0]).unwrap();
        // the cone is (6.5 - 3.4) / 2 deep at 90 degrees, so the shaft runs from the bottom up to z = 3.45
        assert!(
            (shaft.diameter_mm - 3.4).abs() < 1e-6 && shaft.through,
            "{shaft:?}"
        );
        assert!(shaft.entry[2].abs() < 1e-6 && shaft.axis[2] < -0.999, "{shaft:?}");
        assert!((shaft.depth_mm - 3.45).abs() < 0.02, "{shaft:?}");
    }

    #[test]
    fn a_pick_with_no_hole_says_what_face_is_there() {
        let m = plate_minus(post(3.0, -1.0, 6.0));
        let miss = find_on_axis(&m, [5.0, 5.0, 5.0], [0.0, 0.0, 1.0])
            .unwrap_err()
            .to_string();
        assert!(
            miss.contains("no round hole on that axis line") && miss.contains("a flat face"),
            "{miss}"
        );
        let top = (0..m.triangles.len())
            .find(|&t| m.normal(m.triangles[t])[2] > 0.999)
            .unwrap();
        let flat = find(&m, u32::try_from(top).unwrap(), [5.0, 5.0, 5.0])
            .unwrap_err()
            .to_string();
        assert!(flat.contains("the pick is on a flat face"), "{flat}");
        // the side of a post is a cylinder with the material inside it
        let boss = post(3.0, 0.0, 6.0);
        let side = (0..boss.triangles.len())
            .find(|&t| boss.normal(boss.triangles[t])[2].abs() < 0.01)
            .unwrap();
        let out = find(&boss, u32::try_from(side).unwrap(), [18.0, 10.0, 3.0])
            .unwrap_err()
            .to_string();
        assert!(out.contains("the outside of a boss or rod"), "{out}");
        let along = find_on_axis(&boss, [15.0, 10.0, 6.0], [0.0, 0.0, 1.0])
            .unwrap_err()
            .to_string();
        assert!(along.contains("the outside of a boss or rod"), "{along}");
    }

    #[test]
    fn a_hole_made_smaller_and_larger_in_place() {
        let m = plate_minus(post(3.0, -1.0, 6.0));
        let (t, at) = wall(&m);
        let h = find(&m, t, at).unwrap();
        let o = BooleanOptions::default();
        for d in [3.4, 8.0] {
            let spec = HoleSpec {
                diameter_mm: d,
                depth_mm: None,
                counterbore: None,
                countersink: None,
            };
            let (out, r) = apply(&m, &h, &spec, &o).unwrap();
            assert!(r.watertight && r.shells == 1);
            let hole = PI * (d / 2.0).m_powi(2) * 5.0;
            let want = 30.0 * 20.0 * 5.0 - hole;
            assert!(
                (out.volume() - want).abs() < 0.02 * hole,
                "{d}: {} {want}",
                out.volume()
            );
            let (t2, at2) = wall(&out);
            let again = find(&out, t2, at2).unwrap();
            assert!((again.diameter_mm - d).abs() < 1e-6 && again.through, "{again:?}");
        }
    }

    #[test]
    fn a_counterbore_and_a_countersink_at_the_entry() {
        let m = plate_minus(post(1.7, -1.0, 6.0));
        let (t, at) = wall(&m);
        let h = find(&m, t, at).unwrap();
        let o = BooleanOptions::default();
        let bore = HoleSpec {
            diameter_mm: 3.4,
            depth_mm: None,
            counterbore: Some(Counterbore {
                diameter_mm: 6.5,
                depth_mm: 3.0,
            }),
            countersink: None,
        };
        let (out, r) = apply(&m, &h, &bore, &o).unwrap();
        assert!(r.watertight);
        let want = PI * (1.7f64.m_powi(2) * 2.0 + 3.25f64.m_powi(2) * 3.0);
        assert!(
            (-r.volume_change_mm3 - (want - PI * 1.7 * 1.7 * 5.0)).abs() < 0.03 * want,
            "{} {want}",
            r.volume_change_mm3
        );
        assert!(
            out.faces
                .as_ref()
                .unwrap()
                .table
                .iter()
                .filter(|s| matches!(s, Surface::Cylinder { .. }))
                .count()
                >= 2
        );
        let sink = HoleSpec {
            diameter_mm: 3.4,
            depth_mm: None,
            counterbore: None,
            countersink: Some(Countersink {
                diameter_mm: 6.4,
                angle_deg: 90.0,
            }),
        };
        let (out, r) = apply(&m, &h, &sink, &o).unwrap();
        assert!(r.watertight);
        let cone =
            out.faces.as_ref().unwrap().table.iter().any(
                |s| matches!(s, Surface::Cone { half_angle, .. } if (half_angle - PI / 4.0).abs() < 1e-6),
            );
        assert!(cone);
        let both = HoleSpec {
            countersink: sink.countersink,
            ..bore
        };
        assert!(
            apply(&m, &h, &both, &o)
                .unwrap_err()
                .to_string()
                .contains("not both")
        );
    }

    #[test]
    fn a_hole_is_found_again_on_a_thicker_part_and_not_where_it_is_gone() {
        let thin = plate_minus(post(3.0, -1.0, 6.0));
        let (t, at) = wall(&thin);
        let h = find(&thin, t, at).unwrap();
        let thick = {
            let plate = build::box_mesh([0.0; 3], [30.0, 20.0, 7.0]);
            boolean::boolean(
                &[plate],
                &[post(3.0, -1.0, 8.0)],
                BoolOp::Difference,
                &BooleanOptions::default(),
            )
            .unwrap()
            .0
        };
        let spec = HoleSpec {
            diameter_mm: 3.4,
            depth_mm: None,
            counterbore: None,
            countersink: None,
        };
        let (out, r) = apply(&thick, &h, &spec, &BooleanOptions::default()).unwrap();
        assert!(r.watertight);
        let hole = PI * 1.7 * 1.7 * 7.0;
        assert!(
            (out.volume() - (30.0 * 20.0 * 7.0 - hole)).abs() < 0.02 * hole,
            "{}",
            out.volume()
        );
        let solid = build::box_mesh([0.0; 3], [30.0, 20.0, 5.0]);
        let err = apply(&solid, &h, &spec, &BooleanOptions::default())
            .unwrap_err()
            .to_string();
        assert!(err.contains("not there any more"), "{err}");
    }

    #[test]
    fn a_blind_hole_made_shallower_and_narrower() {
        let m = plate_minus(post(3.0, 2.0, 6.0));
        let (t, at) = wall(&m);
        let h = find(&m, t, at).unwrap();
        let spec = HoleSpec {
            diameter_mm: 4.0,
            depth_mm: Some(1.5),
            counterbore: None,
            countersink: None,
        };
        let (out, r) = apply(&m, &h, &spec, &BooleanOptions::default()).unwrap();
        assert!(r.watertight && r.shells == 1);
        let hole = PI * 4.0 * 1.5;
        let want = 30.0 * 20.0 * 5.0 - hole;
        assert!(
            (out.volume() - want).abs() < 0.02 * hole,
            "{} {want}",
            out.volume()
        );
    }
}
