// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! linear and circular arrays

use crate::boolean::{self, BoolOp, BooleanOptions, BooleanReport};
use crate::error::{Error, Result};
use crate::faces::{Faces, Surface};
use crate::fm::Fm as _;
use crate::mesh::{Aabb, TriMesh};
use crate::vec3::{self, V3};
use crate::xform::{self, Mat4};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::f64::consts::{PI, TAU};

pub const MAX_COPIES: usize = 2000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ArraySpec {
    Linear {
        count: usize,
        /// offset between neighbors in mm, for example `[25, 0, 0]`
        step: V3,
        #[serde(default)]
        count2: Option<usize>,
        #[serde(default)]
        step2: Option<V3>,
    },
    Circular {
        count: usize,
        center: V3,
        /// default +Z
        #[serde(default)]
        axis: Option<V3>,
        #[serde(default)]
        angle_deg: Option<f64>,
        #[serde(default)]
        rotate_copies: Option<bool>,
    },
}

pub fn transforms(spec: &ArraySpec) -> Result<Vec<Mat4>> {
    let check = |n: usize, what: &'static str| {
        if n == 0 {
            Err(Error::invalid(what, "must be at least 1"))
        } else {
            Ok(n)
        }
    };
    match spec {
        ArraySpec::Linear {
            count,
            step,
            count2,
            step2,
        } => {
            let n1 = check(*count, "count")?;
            let n2 = check(count2.unwrap_or(1), "count2")?;
            if n1.saturating_mul(n2) > MAX_COPIES {
                return Err(Error::invalid("count", format!("at most {MAX_COPIES} copies")));
            }
            let s2 = step2.unwrap_or([0.0; 3]);
            if !step.iter().chain(&s2).all(|c| c.is_finite()) {
                return Err(Error::invalid("step", "must be finite"));
            }
            if n2 > 1 && vec3::len(s2) == 0.0 {
                return Err(Error::invalid("step2", "needed for a grid"));
            }
            let mut out = Vec::with_capacity(n1 * n2);
            for j in 0..n2 {
                for i in 0..n1 {
                    let d = vec3::add(vec3::scale(*step, i as f64), vec3::scale(s2, j as f64));
                    out.push(xform::translation(d));
                }
            }
            Ok(out)
        }
        ArraySpec::Circular {
            count,
            center,
            axis,
            angle_deg,
            ..
        } => {
            let n = check(*count, "count")?;
            if n > MAX_COPIES {
                return Err(Error::invalid("count", format!("at most {MAX_COPIES} copies")));
            }
            let axis = vec3::normalize(axis.unwrap_or([0.0, 0.0, 1.0]))
                .ok_or_else(|| Error::invalid("axis", "must be a non-zero vector"))?;
            let sweep = angle_deg.unwrap_or(360.0);
            if !(sweep.is_finite() && sweep.abs() <= 360.0) {
                return Err(Error::invalid("angleDeg", "between -360 and 360"));
            }
            let full = (sweep.abs() - 360.0).abs() < 1e-9;
            let step = if full {
                sweep / n as f64
            } else if n > 1 {
                sweep / (n - 1) as f64
            } else {
                0.0
            };
            Ok((0..n)
                .map(|i| xform::rotation_about(*center, axis, (step * i as f64).to_radians()))
                .collect())
        }
    }
}

pub fn transforms_for(mesh: &TriMesh, spec: &ArraySpec) -> Result<Vec<Mat4>> {
    let ts = transforms(spec)?;
    if let ArraySpec::Circular {
        rotate_copies: Some(false),
        ..
    } = spec
    {
        let c = mesh.bounds().map_or([0.0; 3], |b| b.center());
        return Ok(ts
            .iter()
            .map(|t| xform::translation(vec3::sub(xform::apply(t, c), c)))
            .collect());
    }
    Ok(ts)
}

/// copies whose bounds overlap another copy's (a quick check; touching bounds count when they overlap by more than 1 micron)
pub fn overlapping(mesh: &TriMesh, ts: &[Mat4]) -> bool {
    let boxes: Vec<Aabb> = ts
        .iter()
        .filter_map(|t| xform::transformed(mesh, t).bounds())
        .collect();
    let eps = 1e-3;
    boxes.iter().enumerate().any(|(i, a)| {
        boxes.iter().skip(i + 1).any(|b| {
            a.min
                .iter()
                .zip(&a.max)
                .zip(b.min.iter().zip(&b.max))
                .all(|((amin, amax), (bmin, bmax))| amin + eps < *bmax && bmin + eps < *amax)
        })
    })
}

pub fn merged(mesh: &TriMesh, spec: &ArraySpec, opts: &BooleanOptions) -> Result<(TriMesh, BooleanReport)> {
    let ts = transforms_for(mesh, spec)?;
    let lined = match turn(spec) {
        Some(t) => lined_up(mesh, &t, *opts)?,
        None => None,
    };
    let (mut all, part) = match &lined {
        Some((once, part)) => (once.clone(), part),
        None => (Vec::new(), mesh),
    };
    if !part.triangles.is_empty() {
        let copies = distinct(part, &ts, &all);
        all.extend(copies);
    }
    boolean::boolean(&all, &[], BoolOp::Union, opts)
}

/// a circular array's axis, as a frame with `w` along it, and the copies a full turn would take
struct Turn {
    frame: vec3::Frame,
    steps: usize,
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "steps is a whole number at most MAX_COPIES"
)]
fn turn(spec: &ArraySpec) -> Option<Turn> {
    let ArraySpec::Circular {
        count,
        center,
        axis,
        angle_deg,
        rotate_copies,
    } = spec
    else {
        return None;
    };
    if *count < 2 || *rotate_copies == Some(false) {
        return None;
    }
    let w = vec3::normalize(axis.unwrap_or([0.0, 0.0, 1.0]))?;
    let sweep = angle_deg.unwrap_or(360.0);
    let full = (sweep.abs() - 360.0).abs() < 1e-9;
    let step = (sweep / if full { *count } else { *count - 1 } as f64).abs();
    let steps = (360.0 / step).round();
    // only a step that closes a full turn can line facets up
    if !(step > 1e-9 && steps >= 2.0 && steps <= MAX_COPIES as f64 && (steps * step - 360.0).abs() < 1e-6) {
        return None;
    }
    let u = vec3::normalize(vec3::any_perpendicular(w))?;
    Some(Turn {
        frame: vec3::Frame {
            origin: *center,
            u,
            v: vec3::cross(w, u),
            w,
        },
        steps: steps as usize,
    })
}

/// a faceted round on the array's axis: its radius, heights along the axis, facet count, the angle of its first
/// corner, and its side triangles
struct Round {
    radius: f64,
    h: (f64, f64),
    facets: usize,
    phase: f64,
    sides: Vec<usize>,
}

/// how close corners must be to count as on one round, in mm
const ROUND_TOL: f64 = 1e-4;

/// What to join once and what to copy when the part's rounds on the array's axis are lined up with the copies,
/// or none when it has none to line up: copies whose facets miss each other by microns leave slivers in every
/// union after them. A plain revolve is rebuilt with a facet count that is a multiple of the steps and copied.
/// Any other part gets each misaligned round wrapped in such a prism, a few microns out; the prisms are joined
/// once and only the part outside them is copied, since every copy of a prism is the prism.
fn lined_up(mesh: &TriMesh, t: &Turn, opts: BooleanOptions) -> Result<Option<(Vec<TriMesh>, TriMesh)>> {
    let local: Vec<V3> = mesh
        .positions
        .iter()
        .map(|&p| {
            let d = vec3::sub(p, t.frame.origin);
            [
                vec3::dot(d, t.frame.u),
                vec3::dot(d, t.frame.v),
                vec3::dot(d, t.frame.w),
            ]
        })
        .collect();
    let rounds = rounds(mesh, &local);
    let facets = |r: &Round| r.facets.div_ceil(t.steps) * t.steps;
    if let [r] = &rounds[..]
        && plain(mesh, &local, r)
    {
        return Ok(Some((Vec::new(), prism(mesh, &local, t, r, facets(r), false))));
    }
    let wraps: Vec<TriMesh> = rounds
        .iter()
        .filter(|r| r.facets % t.steps != 0)
        .map(|r| prism(mesh, &local, t, r, facets(r), true))
        .collect();
    if wraps.is_empty() {
        return Ok(None);
    }
    let rest = boolean::boolean(std::slice::from_ref(mesh), &wraps, BoolOp::Difference, &opts)?.0;
    Ok(Some((wraps, rest)))
}

fn radius_of(p: V3) -> f64 {
    p[0].m_hypot(p[1])
}

/// the faceted rounds on the axis: side facets with all three corners at one radius and parallel to the axis
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a facet count checked to a small positive range"
)]
fn rounds(mesh: &TriMesh, local: &[V3]) -> Vec<Round> {
    let at = |i: u32| local.get(i as usize).copied().unwrap_or_default();
    let mut sides: Vec<(f64, usize)> = mesh
        .triangles
        .iter()
        .enumerate()
        .filter_map(|(k, tri)| {
            let rs = tri.map(|i| radius_of(at(i)));
            let r = rs.iter().sum::<f64>() / 3.0;
            let [a, b, c] = tri.map(at);
            let n = vec3::normalize(vec3::tri_normal(a, b, c))?;
            (r > ROUND_TOL && rs.iter().all(|x| (x - r).abs() < ROUND_TOL) && n[2].abs() < 1e-6)
                .then_some((r, k))
        })
        .collect();
    sides.sort_by(|a, b| a.0.total_cmp(&b.0));
    sides
        .chunk_by(|a, b| b.0 - a.0 < ROUND_TOL)
        .filter_map(|group| {
            let radius = group.iter().map(|g| g.0).sum::<f64>() / group.len() as f64;
            let mut corners: Vec<V3> = group
                .iter()
                .filter_map(|g| mesh.triangles.get(g.1))
                .flat_map(|tri| tri.map(at))
                .collect();
            let h0 = corners.iter().map(|p| p[2]).fold(f64::INFINITY, f64::min);
            let h1 = corners.iter().map(|p| p[2]).fold(f64::NEG_INFINITY, f64::max);
            // straight facets from one height to the other
            if h1 - h0 < ROUND_TOL
                || corners
                    .iter()
                    .any(|p| (p[2] - h0).abs() > ROUND_TOL && (p[2] - h1).abs() > ROUND_TOL)
            {
                return None;
            }
            let eps = ROUND_TOL / radius;
            corners.sort_by(|a, b| a[1].m_atan2(a[0]).total_cmp(&b[1].m_atan2(b[0])));
            let mut angles: Vec<f64> = corners.iter().map(|p| p[1].m_atan2(p[0])).collect();
            angles.dedup_by(|b, a| *b - *a < eps);
            let gap = angles
                .windows(2)
                .filter_map(|w| Some(w.get(1)? - w.first()?))
                .fold(f64::INFINITY, f64::min);
            let facets = (TAU / gap).round();
            if !(3.0..=16384.0).contains(&facets) {
                return None;
            }
            let phase = *angles.first()?;
            let pitch = TAU / facets;
            let regular = angles.iter().all(|a| {
                let k = (a - phase) / pitch;
                (k - k.round()).abs() * pitch < eps
            });
            // a tessellated round, not a polygon: its facets sit within 0.05 mm of the circle, and wrapping it
            // moves the surface out by at most 0.01 mm
            let half = (PI / facets).m_cos();
            let fine = radius * (1.0 - half) <= 0.05 && radius * (1.0 / half - 1.0) <= 0.01;
            (regular && fine && 2 * angles.len() >= facets as usize).then(|| Round {
                radius,
                h: (h0, h1),
                facets: facets as usize,
                phase,
                sides: group.iter().map(|g| g.1).collect(),
            })
        })
        .collect()
}

/// whether the mesh is the whole round and its two flat caps, closed, and nothing else
fn plain(mesh: &TriMesh, local: &[V3], r: &Round) -> bool {
    let at = |i: u32| local.get(i as usize).copied().unwrap_or_default();
    let caps = mesh
        .triangles
        .iter()
        .filter(|tri| {
            let ps = tri.map(at);
            [r.h.0, r.h.1].iter().any(|h| {
                ps.iter()
                    .all(|p| (p[2] - h).abs() < ROUND_TOL && radius_of(*p) < r.radius + ROUND_TOL)
            })
        })
        .count();
    caps + r.sides.len() == mesh.triangles.len()
        && r.sides.len() == 2 * r.facets
        && mesh.edge_report().is_watertight()
}

/// The round as a prism of `facets` sides from its first corner, its caps fanned from the axis so every copy is
/// the same triangles. Wrapped, its sides touch the round's circle from outside, so it holds the old facets.
#[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
fn prism(mesh: &TriMesh, local: &[V3], t: &Turn, r: &Round, facets: usize, wrap: bool) -> TriMesh {
    let f = &t.frame;
    let radius = if wrap {
        r.radius / (PI / facets as f64).m_cos()
    } else {
        r.radius
    };
    let point = |x: f64, y: f64, h: f64| {
        vec3::add(
            f.origin,
            vec3::add(
                vec3::add(vec3::scale(f.u, x), vec3::scale(f.v, y)),
                vec3::scale(f.w, h),
            ),
        )
    };
    let mut positions = Vec::with_capacity(2 * facets + 2);
    for h in [r.h.0, r.h.1] {
        for j in 0..facets {
            let (s, c) = (r.phase + TAU * j as f64 / facets as f64).m_sin_cos();
            positions.push(point(radius * c, radius * s, h));
        }
    }
    positions.push(point(0.0, 0.0, r.h.0));
    positions.push(point(0.0, 0.0, r.h.1));
    let n = facets as u32;
    let mut triangles = Vec::with_capacity(4 * facets);
    let mut ids = Vec::with_capacity(4 * facets);
    for j in 0..n {
        let k = (j + 1) % n;
        triangles.extend([
            [j, k, n + k],
            [j, n + k, n + j],
            [2 * n, k, j],
            [2 * n + 1, n + j, n + k],
        ]);
        ids.extend([1, 1, 0, 2]);
    }
    let mut out = TriMesh::new(positions, triangles);
    // the faces the round had, with their keys, so a later step still finds them
    let base = vec3::dot(f.w, f.origin);
    let table = vec![
        Surface::Plane {
            normal: vec3::scale(f.w, -1.0),
            offset: -(base + r.h.0),
        },
        Surface::Cylinder {
            origin: f.origin,
            axis: f.w,
            radius: r.radius,
        },
        Surface::Plane {
            normal: f.w,
            offset: base + r.h.1,
        },
    ];
    let keys = mesh
        .faces
        .as_ref()
        .filter(|faces| !faces.keys.is_empty())
        .map(|faces| {
            let key_of = |tri: Option<usize>| {
                tri.and_then(|t| faces.ids.get(t))
                    .and_then(|&id| faces.keys.get(id as usize))
                    .copied()
                    .unwrap_or(0)
            };
            let cap = |h: f64| {
                mesh.triangles.iter().position(|tri| {
                    tri.iter().all(|&i| {
                        let p = local.get(i as usize).copied().unwrap_or_default();
                        (p[2] - h).abs() < ROUND_TOL && radius_of(p) < r.radius + ROUND_TOL
                    })
                })
            };
            vec![
                key_of(cap(r.h.0)),
                key_of(r.sides.first().copied()),
                key_of(cap(r.h.1)),
            ]
        })
        .unwrap_or_default();
    out.faces = Some(Faces { ids, table, keys });
    out
}

/// The copies, each corner within a micron of a corner of `once` or of an earlier copy moved onto it, without the
/// copies that land on one kept before: they add nothing to a union, and exact corners let the kernel see faces
/// that meet.
fn distinct(part: &TriMesh, ts: &[Mat4], once: &[TriMesh]) -> Vec<TriMesh> {
    let mut seen: HashMap<[i64; 3], V3> = HashMap::new();
    for &p in once.iter().flat_map(|m| &m.positions) {
        seen.entry(grid(p)).or_insert(p);
    }
    let mut kept: Vec<(TriMesh, Vec<[[i64; 3]; 3]>)> = Vec::new();
    for t in ts {
        let mut c = xform::transformed(part, t);
        for p in &mut c.positions {
            if let Some(q) = near(&seen, *p) {
                *p = q;
            }
        }
        for &p in &c.positions {
            seen.entry(grid(p)).or_insert(p);
        }
        let shape = shape(&c);
        if !kept.iter().any(|(_, s)| *s == shape) {
            kept.push((c, shape));
        }
    }
    kept.into_iter().map(|(c, _)| c).collect()
}

const GRID: f64 = 1e-6;

#[allow(
    clippy::cast_possible_truncation,
    reason = "coordinates in mm over 1e-6 stay far inside i64"
)]
fn grid(p: V3) -> [i64; 3] {
    p.map(|c| (c / GRID).round() as i64)
}

/// a corner kept before within a micron of `p`
fn near(seen: &HashMap<[i64; 3], V3>, p: V3) -> Option<V3> {
    let [x, y, z] = grid(p);
    let close = |k: [i64; 3]| {
        seen.get(&k)
            .copied()
            .filter(|&q| vec3::len(vec3::sub(p, q)) < GRID)
    };
    close([x, y, z]).or_else(|| {
        (-1..=1)
            .flat_map(|i| (-1..=1).flat_map(move |j| (-1..=1).map(move |k| [x + i, y + j, z + k])))
            .find_map(close)
    })
}

/// the triangles as grid corners, each turned to start at its least corner, sorted: equal for meshes that are the
/// same triangles in any order
fn shape(m: &TriMesh) -> Vec<[[i64; 3]; 3]> {
    let mut out: Vec<[[i64; 3]; 3]> = m
        .triangles
        .iter()
        .map(|&t| {
            let [a, b, c] = m.corners(t).map(grid);
            if a <= b && a <= c {
                [a, b, c]
            } else if b <= c {
                [b, c, a]
            } else {
                [c, a, b]
            }
        })
        .collect();
    out.sort_unstable();
    out
}

#[cfg(test)]
#[allow(clippy::float_cmp, reason = "transforms are built from exact values")]
mod tests {
    use super::*;
    use crate::build;

    #[test]
    fn linear_grid_and_merge() {
        let m = build::box_mesh([0.0; 3], [10.0, 10.0, 5.0]);
        let spec = ArraySpec::Linear {
            count: 3,
            step: [12.0, 0.0, 0.0],
            count2: Some(2),
            step2: Some([0.0, 12.0, 0.0]),
        };
        let ts = transforms(&spec).unwrap();
        assert_eq!(ts.len(), 6);
        assert_eq!(ts[0], xform::IDENTITY);
        assert!(!overlapping(&m, &ts));
        let (u, r) = merged(&m, &spec, &BooleanOptions::default()).unwrap();
        assert_eq!(r.shells, 6);
        assert!((u.volume() - 3000.0).abs() < 1e-6);
        let spec = ArraySpec::Linear {
            count: 3,
            step: [8.0, 0.0, 0.0],
            count2: None,
            step2: None,
        };
        assert!(overlapping(&m, &transforms(&spec).unwrap()));
        let (u, r) = merged(&m, &spec, &BooleanOptions::default()).unwrap();
        assert_eq!(r.shells, 1);
        assert!((u.volume() - 26.0 * 10.0 * 5.0).abs() < 1e-6);
    }

    #[test]
    fn circular_full_and_partial() {
        let m = build::box_mesh([20.0, -2.0, 0.0], [24.0, 2.0, 4.0]);
        let spec = ArraySpec::Circular {
            count: 4,
            center: [0.0; 3],
            axis: None,
            angle_deg: None,
            rotate_copies: None,
        };
        let ts = transforms_for(&m, &spec).unwrap();
        let c = xform::apply(&ts[1], [22.0, 0.0, 2.0]);
        assert!(vec3::len(vec3::sub(c, [0.0, 22.0, 2.0])) < 1e-9);
        let spec = ArraySpec::Circular {
            count: 3,
            center: [0.0; 3],
            axis: Some([0.0, 0.0, 1.0]),
            angle_deg: Some(90.0),
            rotate_copies: Some(false),
        };
        let ts = transforms_for(&m, &spec).unwrap();
        let c = xform::apply(&ts[2], [22.0, 0.0, 2.0]);
        assert!(vec3::len(vec3::sub(c, [0.0, 22.0, 2.0])) < 1e-9);
        assert!((ts[1][0] - 1.0).abs() < 1e-12 && ts[1][1].abs() < 1e-12);
        assert!(
            transforms(&ArraySpec::Circular {
                count: 0,
                center: [0.0; 3],
                axis: None,
                angle_deg: None,
                rotate_copies: None
            })
            .is_err()
        );
    }

    fn around_z(count: usize, center: V3) -> ArraySpec {
        ArraySpec::Circular {
            count,
            center,
            axis: None,
            angle_deg: None,
            rotate_copies: None,
        }
    }

    fn joined(m: &TriMesh, spec: &ArraySpec) -> (TriMesh, BooleanReport, f64) {
        let t = std::time::Instant::now();
        let (u, r) = merged(m, spec, &BooleanOptions::default()).unwrap();
        (u, r, t.elapsed().as_secs_f64())
    }

    #[test]
    fn a_round_part_arrayed_about_its_own_axis_joins_fast() {
        // 100 facets in 12 copies miss each other by under 5 microns: the fold used to run for minutes
        let m = build::cylinder(&crate::vec3::Frame::WORLD, 9.5, 0.0, 10.0, 100);
        let (u, r, secs) = joined(&m, &around_z(12, [0.0; 3]));
        assert!(secs < 2.0, "{secs} s");
        assert!(
            (u.volume() - m.volume()).abs() < 1e-3 * m.volume(),
            "{} vs {}",
            u.volume(),
            m.volume()
        );
        assert!(r.watertight && r.shells == 1, "{r:?}");
        // one prism of 108 facets, no slivers
        assert_eq!(u.triangles.len(), 4 * 108);
        // 9 copies of an 84 facet one, off its center
        let m = build::cylinder(
            &crate::vec3::Frame {
                origin: [21.0, 0.0, 0.0],
                ..crate::vec3::Frame::WORLD
            },
            6.5,
            0.0,
            10.0,
            84,
        );
        let (u, r, secs) = joined(&m, &around_z(9, [21.0, 0.0, 0.0]));
        assert!(secs < 2.0, "{secs} s");
        assert!(
            (u.volume() - m.volume()).abs() < 1e-3 * m.volume(),
            "{} vs {}",
            u.volume(),
            m.volume()
        );
        assert!(r.watertight && r.shells == 1, "{r:?}");
        assert_eq!(u.triangles.len(), 4 * 90);
    }

    #[test]
    fn a_hub_with_one_tooth_arrayed_about_the_hub_makes_a_gear() {
        // a 100 facet hub of r 9.5 with one tooth, as a client drew it
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/array-hub-tooth.json")).unwrap();
        let nums = |k: &str| {
            v[k].as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_f64().unwrap())
                .collect::<Vec<_>>()
        };
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "fixture indices"
        )]
        let idx: Vec<u32> = nums("indices").iter().map(|&i| i as u32).collect();
        let m = TriMesh::from_flat(&nums("positions"), &idx).unwrap();
        let hub = build::cylinder(&crate::vec3::Frame::WORLD, 9.5, 0.0, 10.0, 100).volume();
        let tooth = m.volume() - hub;
        assert!(tooth > 1.0, "{tooth}");
        let (u, r, secs) = joined(&m, &around_z(12, [0.0; 3]));
        assert!(r.watertight && r.shells == 1, "{r:?}");
        let want = hub + 12.0 * tooth;
        assert!(
            (u.volume() - want).abs() < 2e-3 * want,
            "{} vs {want} ({secs} s)",
            u.volume()
        );
        // the hub once and twelve teeth, not twelve hubs' slivers
        assert!(u.triangles.len() < 2 * m.triangles.len(), "{}", u.triangles.len());
        assert!(secs < 2.0, "{secs} s");
    }

    #[test]
    fn copies_that_land_on_the_part_add_nothing() {
        // 96 facets already line up with 12 copies: one prism comes back, no union in between
        let m = build::cylinder(&crate::vec3::Frame::WORLD, 9.5, 0.0, 10.0, 96);
        let (u, r, _) = joined(&m, &around_z(12, [0.0; 3]));
        assert_eq!(u.triangles.len(), 4 * 96);
        assert!((u.volume() - m.volume()).abs() < 1e-9 * m.volume() && r.shells == 1);
        // a box's diagonals turn onto other diagonals, so its copies stay and join to the same box
        let m = build::box_mesh([-5.0, -5.0, 0.0], [5.0, 5.0, 4.0]);
        let (u, r, _) = joined(&m, &around_z(4, [0.0; 3]));
        assert!((u.volume() - 400.0).abs() < 1e-9 && r.shells == 1 && r.watertight);
    }
}
