// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! shell: a body hollowed to a wall thickness with some faces left open, for boxes, trays and enclosures
//!
//! A body whose faces are all flat gets an exact wall: each face's plane moves inward by the wall (an open face's
//! moves outward, so the cavity breaks through it), each corner goes where its planes meet again, and the moved
//! body is cut out of the original. When that does not hold (curved faces, a wall thick enough to change the
//! body's shape), the voxel hollow (`hollow.rs`) makes the wall and each open face is cut through, and the report
//! says so.
// vertex, triangle and face indices come from the validated, welded mesh and the lists built here; the small
// matrices are fixed 3 by 3
#![allow(clippy::indexing_slicing)]

use crate::boolean::{self, BoolOp, BooleanOptions, BooleanReport};
use crate::error::{Error, Result};
use crate::faces::{self, Faces, Surface};
use crate::hollow::{self, HollowOptions};
use crate::mesh::{self, TriMesh};
use crate::vec3::{self, V3};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A face to leave open: a point on it and its outward normal, world coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFace {
    pub at: V3,
    pub normal: V3,
    /// The face's key (faces.rs), looked for first; `at` and `normal` find the face when it has none, or the key is
    /// gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellReport {
    /// The wall is exact: every face moved inward by the wall.
    pub exact: bool,
    /// Why the wall is not exact, in words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub open_faces: usize,
    /// The key of each face in `open` as found (0 when it has none), for the history step to keep.
    pub open_keys: Vec<u64>,
    pub volume_change_mm3: f64,
    pub watertight: bool,
    pub shells: usize,
    pub boolean: BooleanReport,
}

/// Why the exact wall does not hold.
enum Inexact {
    Curved,
    Thick,
}

fn too_thick() -> Error {
    Error::invalid("wallMm", "the wall is too thick for this body; try a thinner one")
}

/// The body hollowed to `wall_mm`, open at `open`.
pub fn shell(
    mesh: &TriMesh,
    open: &[OpenFace],
    wall_mm: f64,
    opts: &BooleanOptions,
) -> Result<(TriMesh, ShellReport)> {
    if !(wall_mm.is_finite() && wall_mm > 0.0 && wall_mm <= 1000.0) {
        return Err(Error::invalid("wallMm", "must be above 0 (at most 1000 mm)"));
    }
    mesh.validate("shell")?;
    let w = mesh.weld(mesh::weld_tolerance(mesh.bounds()));
    let faces = w
        .faces
        .clone()
        .filter(|f| f.fit(&w))
        .unwrap_or_else(|| faces::recognize(&w));
    let (opened, open_keys) = open_faces(&w, &faces, open)?;
    let v0 = boolean::Solid::new(&w)?.volume();
    let (out, r, note) = match exact_inner(&w, &faces, &opened, wall_mm) {
        Ok(inner) => {
            let (out, r) = boolean::boolean(std::slice::from_ref(&w), &[inner], BoolOp::Difference, opts)?;
            (out, r, None)
        }
        Err(why) => {
            let (out, r, voxel) = voxel_shell(&w, &faces, &opened, wall_mm, *opts)?;
            let note = match why {
                Inexact::Curved => format!(
                    "The body has curved faces, so the wall follows them to within a {voxel:.2} mm voxel."
                ),
                Inexact::Thick => format!(
                    "The wall changes the body's shape inside, so it follows the faces to within a {voxel:.2} mm voxel."
                ),
            };
            (out, r, Some(note))
        }
    };
    if r.empty || out.triangles.is_empty() {
        return Err(too_thick());
    }
    if !r.watertight {
        return Err(Error::geometry(
            "shell",
            "the result is not watertight; try another wall",
        ));
    }
    Ok((
        out,
        ShellReport {
            exact: note.is_none(),
            note,
            open_faces: opened.len(),
            open_keys,
            volume_change_mm3: r.volume_mm3 - v0,
            watertight: r.watertight,
            shells: r.shells,
            boolean: r,
        },
    ))
}

/// The face ids of the faces to open, each found by a point on it and its normal.
fn open_faces(w: &TriMesh, faces: &Faces, open: &[OpenFace]) -> Result<(Vec<u32>, Vec<u64>)> {
    let size = w.bounds().map_or(1.0, |b| b.diagonal());
    let tol = (size * 1e-5).max(1e-3);
    let mut out: Vec<u32> = Vec::new();
    let mut keys: Vec<u64> = Vec::new();
    for o in open {
        let by_key = o
            .key
            .filter(|&k| k != 0)
            .and_then(|k| faces.keys.iter().position(|&x| x == k))
            .and_then(|f| u32::try_from(f).ok());
        if let Some(f) = by_key {
            keys.push(faces.keys[f as usize]);
            if !out.contains(&f) {
                out.push(f);
            }
            continue;
        }
        let n = vec3::normalize(o.normal)
            .ok_or_else(|| Error::invalid("open", "a face's normal must not be zero"))?;
        let hit = w.triangles.iter().position(|&t| {
            let c = w.corners(t);
            let tn = vec3::normalize(w.normal(t)).unwrap_or([0.0; 3]);
            vec3::dot(tn, n) > 0.999
                && vec3::dot(vec3::sub(o.at, c[0]), tn).abs() <= tol
                && inside(c, tn, o.at, tol)
        });
        let t = hit.ok_or_else(|| {
            Error::invalid(
                "open",
                "a face to open is not on a face of the body; pick it again",
            )
        })?;
        let f = faces.ids[t];
        keys.push(faces.keys.get(f as usize).copied().unwrap_or(0));
        if !out.contains(&f) {
            out.push(f);
        }
    }
    let mut all: Vec<u32> = faces.ids.clone();
    all.sort_unstable();
    all.dedup();
    if !all.is_empty() && all.iter().all(|f| out.contains(f)) {
        return Err(Error::invalid(
            "open",
            "opening every face leaves no body; leave at least one face closed",
        ));
    }
    Ok((out, keys))
}

/// Whether `p`, on the triangle's plane, lies in the triangle (within `tol`).
fn inside(c: [V3; 3], n: V3, p: V3, tol: f64) -> bool {
    (0..3).all(|i| {
        let (a, b) = (c[i], c[(i + 1) % 3]);
        let edge = vec3::sub(b, a);
        let out = vec3::normalize(vec3::cross(edge, n)).unwrap_or([0.0; 3]);
        vec3::dot(vec3::sub(p, a), out) <= tol
    })
}

/// The cavity of a flat-faced body: every face's plane moved inward by `wall` (an open face's outward, past the
/// body), each vertex where its planes meet again.
fn exact_inner(
    w: &TriMesh,
    faces: &Faces,
    opened: &[u32],
    wall: f64,
) -> std::result::Result<TriMesh, Inexact> {
    let past = wall.max(1.0);
    let mut planes_at: Vec<Vec<u32>> = vec![Vec::new(); w.positions.len()];
    for (t, tri) in w.triangles.iter().enumerate() {
        let f = faces.ids[t];
        if !matches!(faces.table.get(f as usize), Some(Surface::Plane { .. })) {
            return Err(Inexact::Curved);
        }
        for &v in tri {
            let list = &mut planes_at[v as usize];
            if !list.contains(&f) {
                list.push(f);
            }
        }
    }
    let size = w.bounds().map_or(1.0, |b| b.diagonal());
    let mut positions = Vec::with_capacity(w.positions.len());
    for (v, p) in w.positions.iter().enumerate() {
        // Each plane once by its normal, and how far along it the vertex moves.
        let mut rows: Vec<(V3, f64)> = Vec::new();
        for &f in &planes_at[v] {
            let Some(&Surface::Plane { normal, .. }) = faces.table.get(f as usize) else {
                return Err(Inexact::Curved);
            };
            let d = if opened.contains(&f) { past } else { -wall };
            match rows.iter().find(|(n, _)| vec3::dot(*n, normal) > 1.0 - 1e-9) {
                Some(&(_, d0)) if (d0 - d).abs() > 1e-9 => return Err(Inexact::Thick),
                Some(_) => {}
                None => rows.push((normal, d)),
            }
        }
        let delta = solve(&rows).ok_or(Inexact::Thick)?;
        if rows
            .iter()
            .any(|(n, d)| (vec3::dot(*n, delta) - d).abs() > 1e-6 * size.max(1.0))
        {
            return Err(Inexact::Thick);
        }
        positions.push(vec3::add(*p, delta));
    }
    let inner = TriMesh::new(positions, w.triangles.clone());
    // A wall that turns a face over has changed the body's shape inside.
    for &t in &w.triangles {
        let (a, b) = (w.normal(t), inner.normal(t));
        if vec3::dot(a, b) <= 0.0 || vec3::len(b) <= 1e-12 {
            return Err(Inexact::Thick);
        }
    }
    Ok(inner)
}

/// The smallest move `d` with `dot(n, d) == k` for every row, or none when the rows do not meet in one point.
fn solve(rows: &[(V3, f64)]) -> Option<V3> {
    match rows {
        [] => Some([0.0; 3]),
        [(n, k)] => Some(vec3::scale(*n, *k)),
        [(n1, k1), (n2, k2)] => {
            let g = vec3::dot(*n1, *n2);
            let det = 1.0 - g * g;
            if det.abs() < 1e-12 {
                return None;
            }
            let l1 = (k1 - g * k2) / det;
            let l2 = (k2 - g * k1) / det;
            Some(vec3::add(vec3::scale(*n1, l1), vec3::scale(*n2, l2)))
        }
        _ => {
            // Least squares over every plane; the caller checks they all hold.
            let mut a = [[0.0f64; 3]; 3];
            let mut b = [0.0f64; 3];
            for (n, k) in rows {
                for i in 0..3 {
                    for j in 0..3 {
                        a[i][j] += n[i] * n[j];
                    }
                    b[i] += n[i] * k;
                }
            }
            solve3(a, b)
        }
    }
}

fn solve3(a: [[f64; 3]; 3], b: [f64; 3]) -> Option<V3> {
    let det = |m: [[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let d = det(a);
    if d.abs() < 1e-12 {
        return None;
    }
    let mut x = [0.0; 3];
    for (k, xk) in x.iter_mut().enumerate() {
        let mut m = a;
        for (row, bi) in m.iter_mut().zip(b) {
            row[k] = bi;
        }
        *xk = det(m) / d;
    }
    Some(x)
}

/// The voxel hollow with each open face cut through: the cavity, moved out through the face by the wall and a
/// little more, removes the wall under it. Returns the result and the voxel size.
fn voxel_shell(
    w: &TriMesh,
    faces: &Faces,
    opened: &[u32],
    wall: f64,
    opts: BooleanOptions,
) -> Result<(TriMesh, BooleanReport, f64)> {
    let mut faces_w = w.clone();
    faces_w.faces = None;
    let (hollowed, rep) = hollow::hollow(
        &faces_w,
        &HollowOptions {
            wall_mm: wall,
            ..HollowOptions::default()
        },
    )
    .map_err(|_| too_thick())?;
    if rep.inner_triangles == 0 {
        return Err(too_thick());
    }
    if opened.is_empty() {
        let (out, r) = boolean::boolean(&[hollowed], &[], BoolOp::Union, &opts)?;
        return Ok((out, r, rep.voxel_mm));
    }
    let cavity = boolean::boolean(
        &[faces_w],
        std::slice::from_ref(&hollowed),
        BoolOp::Difference,
        &opts,
    )?
    .0;
    let mut body = hollowed;
    let mut last = None;
    for &f in opened {
        let Some(&Surface::Plane { normal, .. }) = faces.table.get(f as usize) else {
            return Err(Error::invalid("open", "pick flat faces to open"));
        };
        let reach = wall + 2.0 * rep.voxel_mm + 0.5;
        let mut moved = cavity.clone();
        moved.translate(vec3::scale(normal, reach));
        let slab = prism(w, faces, f, normal, 1.0, reach + rep.voxel_mm);
        let cutter = boolean::boolean(&[moved], &[slab], BoolOp::Intersection, &opts)?.0;
        let (out, r) = boolean::boolean(&[body], &[cutter], BoolOp::Difference, &opts)?;
        body = out;
        last = Some(r);
    }
    let r = last.ok_or_else(too_thick)?;
    Ok((body, r, rep.voxel_mm))
}

/// The prism over face `f`: its triangles moved `out` along the normal and `inward` against it, closed along the
/// face's outline.
#[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
fn prism(w: &TriMesh, faces: &Faces, f: u32, n: V3, out: f64, inward: f64) -> TriMesh {
    let tris: Vec<[u32; 3]> = w
        .triangles
        .iter()
        .zip(&faces.ids)
        .filter(|&(_, &id)| id == f)
        .map(|(t, _)| *t)
        .collect();
    let mut m = TriMesh::default();
    let mut top: HashMap<u32, (u32, u32)> = HashMap::new();
    let mut at = |m: &mut TriMesh, v: u32| -> (u32, u32) {
        *top.entry(v).or_insert_with(|| {
            let p = w.positions[v as usize];
            (
                m.push_vertex(vec3::add(p, vec3::scale(n, out))),
                m.push_vertex(vec3::sub(p, vec3::scale(n, inward))),
            )
        })
    };
    let mut edges: HashMap<(u32, u32), u32> = HashMap::new();
    for t in &tris {
        let [a, b, c] = t.map(|v| at(&mut m, v));
        m.triangles.push([a.0, b.0, c.0]);
        m.triangles.push([a.1, c.1, b.1]);
        for i in 0..3 {
            let (p, q) = (t[i], t[(i + 1) % 3]);
            *edges.entry((p, q)).or_insert(0) += 1;
        }
    }
    let outline: Vec<(u32, u32)> = edges
        .keys()
        .filter(|(p, q)| !edges.contains_key(&(*q, *p)))
        .copied()
        .collect();
    for (p, q) in outline {
        let (a, b) = (at(&mut m, p), at(&mut m, q));
        m.triangles.push([a.1, b.1, b.0]);
        m.triangles.push([a.1, b.0, a.0]);
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boolean::{self, BoolOp};
    use crate::build;
    use crate::vec3::Frame;

    fn o() -> BooleanOptions {
        BooleanOptions::default()
    }

    fn top(z: f64) -> OpenFace {
        OpenFace {
            at: [5.0, 5.0, z],
            normal: [0.0, 0.0, 1.0],
            key: None,
        }
    }

    #[test]
    fn a_box_open_at_the_top_is_a_tray() {
        let m = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        let (out, r) = shell(&m, &[top(20.0)], 2.0, &o()).unwrap();
        assert!(r.exact && r.note.is_none() && r.watertight && r.shells == 1 && r.open_faces == 1);
        let want = 40.0 * 30.0 * 20.0 - 36.0 * 26.0 * 18.0;
        assert!((out.volume() - want).abs() < 1e-6, "{} vs {want}", out.volume());
        assert!((r.volume_change_mm3 + 36.0 * 26.0 * 18.0).abs() < 1e-6);
    }

    #[test]
    fn a_closed_shell_keeps_a_void_inside() {
        let m = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        let (out, r) = shell(&m, &[], 2.0, &o()).unwrap();
        assert!(r.exact && r.shells == 2);
        assert!((out.volume() - (24_000.0 - 36.0 * 26.0 * 16.0)).abs() < 1e-6);
    }

    #[test]
    fn two_open_faces_and_a_body_that_bends() {
        // An L: 30 by 10 and 10 by 30 in plan, 20 tall.
        let a = build::box_mesh([0.0; 3], [30.0, 10.0, 20.0]);
        let b = build::box_mesh([0.0; 3], [10.0, 30.0, 20.0]);
        let l = boolean::boolean(&[a], &[b], BoolOp::Union, &o()).unwrap().0;
        let (out, r) = shell(&l, &[top(20.0)], 2.0, &o()).unwrap();
        assert!(r.exact && r.watertight && r.shells == 1, "{r:?}");
        // The inner L is 2 to 28 by 2 to 8 and 2 to 8 by 2 to 28, from 2 mm up.
        let want = 500.0 * 20.0 - 276.0 * 18.0;
        assert!((out.volume() - want).abs() < 1e-6, "{} vs {want}", out.volume());
        // Open at the top and at the end of one arm: a channel.
        let end = OpenFace {
            at: [30.0, 5.0, 10.0],
            normal: [1.0, 0.0, 0.0],
            key: None,
        };
        let (out, r) = shell(&l, &[top(20.0), end], 2.0, &o()).unwrap();
        assert!(r.exact && r.watertight && r.open_faces == 2);
        let want = 500.0 * 20.0 - (276.0 + 2.0 * 6.0) * 18.0;
        assert!((out.volume() - want).abs() < 1e-6, "{} vs {want}", out.volume());
    }

    #[test]
    fn a_round_body_falls_back_to_the_voxel_wall_and_says_so() {
        let f = Frame::WORLD;
        let m = build::cylinder(&f, 15.0, 0.0, 20.0, 64);
        let (out, r) = shell(&m, &[top(20.0)], 2.0, &o()).unwrap();
        assert!(!r.exact && r.watertight && r.shells == 1, "{r:?}");
        assert!(r.note.as_deref().unwrap().contains("curved"), "{:?}", r.note);
        // About a cup: the outer cylinder less a 13 mm one from 2 mm up, within a voxel or so.
        let want = std::f64::consts::PI * (225.0 * 20.0 - 169.0 * 18.0);
        assert!(
            (out.volume() - want).abs() / want < 0.12,
            "{} vs {want}",
            out.volume()
        );
    }

    #[test]
    fn an_open_face_is_found_by_its_key_when_its_place_is_old() {
        // Each request is its own scope, as in the worker.
        let keyed = |m: &mut TriMesh| crate::faces::with_key_salt(Some(9), || crate::faces::base_keys(m));
        let mut m = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        keyed(&mut m);
        let (_, first) = shell(&m, &[top(20.0)], 2.0, &o()).unwrap();
        let key = first.open_keys[0];
        assert_ne!(key, 0);
        // The box got taller since: the top is at 25 now, and only the key still finds it.
        let mut tall = build::box_mesh([0.0; 3], [40.0, 30.0, 25.0]);
        keyed(&mut tall);
        let stale = OpenFace {
            key: Some(key),
            ..top(20.0)
        };
        let (out, r) = shell(&tall, &[stale], 2.0, &o()).unwrap();
        assert!(r.exact && r.shells == 1 && r.open_keys == vec![key]);
        let want = 40.0 * 30.0 * 25.0 - 36.0 * 26.0 * 23.0;
        assert!((out.volume() - want).abs() < 1e-6);
        // Without the key the old place is not on a face.
        assert!(shell(&tall, &[top(20.0)], 2.0, &o()).is_err());
    }

    #[test]
    fn what_cannot_be_shelled_is_refused_in_words() {
        let m = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        let e = shell(&m, &[top(20.0)], 0.0, &o()).unwrap_err().to_string();
        assert!(e.contains("wallMm"), "{e}");
        let e = shell(&m, &[top(20.0)], 16.0, &o()).unwrap_err().to_string();
        assert!(e.contains("too thick"), "{e}");
        let off = OpenFace {
            at: [5.0, 5.0, 25.0],
            normal: [0.0, 0.0, 1.0],
            key: None,
        };
        let e = shell(&m, &[off], 2.0, &o()).unwrap_err().to_string();
        assert!(e.contains("not on a face"), "{e}");
        let every = [
            top(20.0),
            OpenFace {
                at: [5.0, 5.0, 0.0],
                normal: [0.0, 0.0, -1.0],
                key: None,
            },
            OpenFace {
                at: [0.0, 5.0, 5.0],
                normal: [-1.0, 0.0, 0.0],
                key: None,
            },
            OpenFace {
                at: [40.0, 5.0, 5.0],
                normal: [1.0, 0.0, 0.0],
                key: None,
            },
            OpenFace {
                at: [5.0, 0.0, 5.0],
                normal: [0.0, -1.0, 0.0],
                key: None,
            },
            OpenFace {
                at: [5.0, 30.0, 5.0],
                normal: [0.0, 1.0, 0.0],
                key: None,
            },
        ];
        let e = shell(&m, &every, 2.0, &o()).unwrap_err().to_string();
        assert!(e.contains("every face"), "{e}");
    }
}
