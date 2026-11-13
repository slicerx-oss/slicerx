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
use std::collections::{BTreeMap, HashMap};

/// A face to leave open: a point on it and its outward normal, world coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFace {
    pub at: V3,
    pub normal: V3,
    /// the face's key; missing or split keys require repair. unkeyed selections use `at` and `normal`.
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
            let (out, r, voxel, _) = voxel_shell(&w, &faces, &opened, wall_mm, *opts)?;
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
        let by_key = if let Some(key) = o.key.filter(|&k| k != 0) {
            Some(faces::resolve_key(w, faces, key)?)
        } else {
            None
        };
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
    // A wall that turns a face over, or round in its plane, has changed the body's shape inside. Past the middle on
    // every axis the whole cavity comes out inside out with each normal kept, so the edges tell.
    let edge = |m: &TriMesh, t: [u32; 3], i: usize| {
        vec3::sub(m.positions[t[(i + 1) % 3] as usize], m.positions[t[i] as usize])
    };
    for &t in &w.triangles {
        let (a, b) = (w.normal(t), inner.normal(t));
        let turned = (0..3).any(|i| vec3::dot(edge(w, t, i), edge(&inner, t, i)) <= 0.0);
        if vec3::dot(a, b) <= 0.0 || vec3::len(b) <= 1e-12 || turned {
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

/// Why the hollow's inner wall, turned over, does not stand for the cavity; the cavity then comes from cutting the
/// hollowed body out of the body, as it always did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unusable {
    /// open or non-manifold edges
    Open,
    /// it encloses no volume
    Empty,
    /// cutting the open faces through with it fails or leaves the result open
    Cut,
}

/// A voxel shell: the result, its report, the voxel size, and why the cavity came from a boolean if it did.
type Shelled = (TriMesh, BooleanReport, f64, Option<Unusable>);

/// The voxel hollow open at each open face. The room past each open face counts as body while the wall is made, so
/// the inner wall runs out through the face and the cavity, cut out of the body, opens it. When that cavity does not
/// hold, the cavity of the closed hollow, moved out through each face by the wall and a little more, removes the wall
/// under it.
fn voxel_shell(
    w: &TriMesh,
    faces: &Faces,
    opened: &[u32],
    wall: f64,
    opts: BooleanOptions,
) -> Result<Shelled> {
    let hollow_opts = HollowOptions {
        wall_mm: wall,
        ..HollowOptions::default()
    };
    if !opened.is_empty()
        && let Some(done) = open_by_room(w, faces, opened, wall, &hollow_opts, opts)?
    {
        return Ok(done);
    }
    let (inner, voxel) = hollow::inner_wall(w, &hollow_opts).map_err(|_| too_thick())?;
    if inner.triangles.is_empty() {
        return Err(too_thick());
    }
    let (out, r, why) = open_through(w, faces, opened, wall, voxel, &inner, opts)?;
    Ok((out, r, voxel, why))
}

/// The body less a cavity that runs out through each open face, or none when that cavity does not hold. The cavity's
/// sides cross the face, so the cut meets them across; a cavity moved out through the face instead runs alongside its
/// own sides below the face wherever the body is not straight up and down, and leaves slivers and faces that cross
/// there.
fn open_by_room(
    w: &TriMesh,
    faces: &Faces,
    opened: &[u32],
    wall: f64,
    hollow_opts: &HollowOptions,
    opts: BooleanOptions,
) -> Result<Option<Shelled>> {
    let voxel = hollow::voxel_for(w, wall).map_err(|_| too_thick())?;
    // past the face by the wall and three voxels, so the cavity's top stays clear of the face; into the body by a
    // voxel, so the room and the body share their cells
    let past = wall + 3.0 * voxel;
    let mut rooms = Vec::with_capacity(opened.len());
    for &f in opened {
        let Some(&Surface::Plane { normal, .. }) = faces.table.get(f as usize) else {
            return Err(Error::invalid("open", "pick flat faces to open"));
        };
        rooms.push(prism(w, faces, f, normal, past, voxel));
    }
    corners(w, faces, opened, past, &mut rooms);
    let (inner, voxel) = hollow::inner_wall_through(w, hollow_opts, &rooms).map_err(|_| too_thick())?;
    if inner.triangles.is_empty() {
        return Err(too_thick());
    }
    let Ok(cavity) = turned_over(&inner) else {
        return Ok(None);
    };
    let mut body = w.clone();
    body.faces = None;
    let before = body.volume();
    let Ok((out, r)) = boolean::boolean(&[body], &[cavity], BoolOp::Difference, &opts) else {
        return Ok(None);
    };
    // a body too thin for the wall has its only cavity in the room past the face, and loses nothing
    let hollowed = r.volume_mm3 < before * (1.0 - 1e-6);
    Ok((r.watertight && !r.empty && hollowed).then_some((out, r, voxel, None)))
}

/// The room past open faces that meet at an edge or a corner, added to `rooms`, so no wall is left along it.
fn corners(w: &TriMesh, faces: &Faces, opened: &[u32], past: f64, rooms: &mut Vec<TriMesh>) {
    let mut across: HashMap<(u32, u32), usize> = HashMap::new();
    for (t, tri) in w.triangles.iter().enumerate() {
        for i in 0..3 {
            across.insert((tri[i], tri[(i + 1) % 3]), t);
        }
    }
    let middle = |t: [u32; 3]| {
        let [a, b, c] = w.corners(t);
        vec3::scale(vec3::add(vec3::add(a, b), c), 1.0 / 3.0)
    };
    for (t, tri) in w.triangles.iter().enumerate() {
        let f = faces.ids[t];
        if !opened.contains(&f) {
            continue;
        }
        let Some(&Surface::Plane { normal: n, .. }) = faces.table.get(f as usize) else {
            continue;
        };
        for i in 0..3 {
            let (a, b) = (tri[i], tri[(i + 1) % 3]);
            let Some(&t2) = across.get(&(b, a)) else { continue };
            // each edge between two open faces once; a kept neighbor keeps the lip the wall has always ended in
            let g = faces.ids[t2];
            if g <= f || !opened.contains(&g) {
                continue;
            }
            let (p, q) = (w.positions[a as usize], w.positions[b as usize]);
            let Some(m) = vec3::normalize(w.normal(w.triangles[t2])) else {
                continue;
            };
            // a fold in: the rooms past the two faces already meet
            if vec3::dot(m, vec3::sub(middle(*tri), p)) >= 0.0 {
                continue;
            }
            let ring = [
                [0.0; 3],
                vec3::scale(n, past),
                vec3::scale(vec3::add(n, m), past),
                vec3::scale(m, past),
            ];
            rooms.push(swept(p, q, &ring));
        }
    }
    // the corners where three open faces meet, each face once by its normal with a triangle's middle on it
    let mut at: BTreeMap<u32, Vec<(V3, V3)>> = BTreeMap::new();
    for (t, tri) in w.triangles.iter().enumerate() {
        let f = faces.ids[t];
        if !opened.contains(&f) {
            continue;
        }
        let Some(&Surface::Plane { normal, .. }) = faces.table.get(f as usize) else {
            continue;
        };
        for &v in tri {
            let list = at.entry(v).or_default();
            if !list.iter().any(|(m, _)| vec3::dot(*m, normal) > 1.0 - 1e-9) {
                list.push((normal, middle(*tri)));
            }
        }
    }
    for (v, l) in at {
        let &[(a, _), (b, _), (c, _)] = l.as_slice() else {
            continue;
        };
        let p = w.positions[v as usize];
        // a corner that folds in is inside the rooms already
        let folds_in = |i: usize, j: usize| i != j && vec3::dot(l[i].0, vec3::sub(l[j].1, p)) >= 0.0;
        if (0..3).any(|i| (0..3).any(|j| folds_in(i, j))) {
            continue;
        }
        let ring = [
            [0.0; 3],
            vec3::scale(a, past),
            vec3::scale(vec3::add(a, b), past),
            vec3::scale(b, past),
        ];
        rooms.push(swept(p, vec3::add(p, vec3::scale(c, past)), &ring));
    }
}

/// The closed prism of the polygon `ring`, offsets from a point, along the edge from `p` to `q`.
fn swept(p: V3, q: V3, ring: &[V3]) -> TriMesh {
    let mut m = TriMesh::default();
    let a: Vec<u32> = ring.iter().map(|o| m.push_vertex(vec3::add(p, *o))).collect();
    let b: Vec<u32> = ring.iter().map(|o| m.push_vertex(vec3::add(q, *o))).collect();
    let n = ring.len();
    for i in 1..n - 1 {
        m.triangles.push([a[0], a[i + 1], a[i]]);
        m.triangles.push([b[0], b[i], b[i + 1]]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        m.triangles.push([a[i], a[j], b[j]]);
        m.triangles.push([a[i], b[j], b[i]]);
    }
    m
}

/// The body with the inner wall `inner` (as the hollow makes it, facing into the cavity) and each open face cut
/// through, and why the cavity came from a boolean if it did.
fn open_through(
    w: &TriMesh,
    faces: &Faces,
    opened: &[u32],
    wall: f64,
    voxel: f64,
    inner: &TriMesh,
    opts: BooleanOptions,
) -> Result<(TriMesh, BooleanReport, Option<Unusable>)> {
    let mut faces_w = w.clone();
    faces_w.faces = None;
    let mut hollowed = faces_w.clone();
    hollowed.append(inner);
    if opened.is_empty() {
        let (out, r) = boolean::boolean(&[hollowed], &[], BoolOp::Union, &opts)?;
        return Ok((out, r, None));
    }
    // The inner wall turned over is the cavity, the same surface a boolean would cut out at many times the cost.
    let why = match turned_over(inner) {
        Ok(cavity) => match cut_open(w, faces, opened, wall, voxel, hollowed.clone(), &cavity, opts) {
            Ok((out, r)) if r.watertight && !r.empty => return Ok((out, r, None)),
            _ => Unusable::Cut,
        },
        Err(why) => why,
    };
    let cavity = boolean::boolean(
        &[faces_w],
        std::slice::from_ref(&hollowed),
        BoolOp::Difference,
        &opts,
    )?
    .0;
    let (out, r) = cut_open(w, faces, opened, wall, voxel, hollowed, &cavity, opts)?;
    Ok((out, r, Some(why)))
}

/// The inner wall turned over into the cavity's own closed surface. Faces that cross are left to the cut: the kernel
/// checks every input for them anyway and takes the robust engine when it finds some.
fn turned_over(inner: &TriMesh) -> std::result::Result<TriMesh, Unusable> {
    let mut cavity = inner.clone();
    cavity.flip();
    if !cavity.edge_report().is_watertight() {
        return Err(Unusable::Open);
    }
    if cavity.volume() <= 0.0 {
        return Err(Unusable::Empty);
    }
    Ok(cavity)
}

/// `body` with the wall under each open face removed by `cavity`, moved out through the face.
#[allow(
    clippy::too_many_arguments,
    reason = "the shell's inputs, passed through from one caller"
)]
fn cut_open(
    w: &TriMesh,
    faces: &Faces,
    opened: &[u32],
    wall: f64,
    voxel: f64,
    mut body: TriMesh,
    cavity: &TriMesh,
    opts: BooleanOptions,
) -> Result<(TriMesh, BooleanReport)> {
    let mut last = None;
    for &f in opened {
        let Some(&Surface::Plane { normal, .. }) = faces.table.get(f as usize) else {
            return Err(Error::invalid("open", "pick flat faces to open"));
        };
        let reach = wall + 2.0 * voxel + 0.5;
        let mut moved = cavity.clone();
        moved.translate(vec3::scale(normal, reach));
        let slab = prism(w, faces, f, normal, 1.0, reach + voxel);
        let cutter = boolean::boolean(&[moved], &[slab], BoolOp::Intersection, &opts)?.0;
        let (out, r) = boolean::boolean(&[body], &[cutter], BoolOp::Difference, &opts)?;
        body = out;
        last = Some(r);
    }
    last.map(|r| (body, r)).ok_or_else(too_thick)
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
    // sorted: map order differs between runs and builds
    let mut outline: Vec<(u32, u32)> = edges
        .keys()
        .filter(|(p, q)| !edges.contains_key(&(*q, *p)))
        .copied()
        .collect();
    outline.sort_unstable();
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
    use crate::fm::Fm;
    use crate::poly2d::Polygon;
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

    /// 40 long in x, a box on a half round in y and z: flat at y 0, y 20 and z 20, round below z 10.
    fn on_a_half_round() -> TriMesh {
        let f = Frame {
            origin: [0.0; 3],
            u: [0.0, 1.0, 0.0],
            v: [0.0, 0.0, 1.0],
            w: [1.0, 0.0, 0.0],
        };
        let mut ring = vec![[0.0, 20.0], [0.0, 10.0]];
        for i in 1..32 {
            let a = std::f64::consts::PI * (1.0 + f64::from(i) / 32.0);
            ring.push([10.0 + 10.0 * a.m_cos(), 10.0 + 10.0 * a.m_sin()]);
        }
        ring.extend([[20.0, 10.0], [20.0, 20.0]]);
        build::extrude(&[Polygon::simple(ring)], &f, 0.0, 40.0).unwrap()
    }

    #[test]
    fn open_faces_that_meet_leave_nothing_along_their_edge() {
        let solid = |m: &TriMesh, p: V3| crate::convex::point_inside_mesh(m, p);
        let side = OpenFace {
            at: [20.0, 0.0, 15.0],
            normal: [0.0, -1.0, 0.0],
            key: None,
        };
        let m = on_a_half_round();
        let (out, r) = shell(&m, &[top(20.0), side], 1.5, &o()).unwrap();
        assert!(!r.exact && r.watertight && r.shells == 1, "{r:?}");
        // nothing along the edge of the top and the side, which both open; the wall on the far side stays
        for p in [[20.0, 0.3, 19.7], [20.0, 0.7, 19.3], [20.0, 1.0, 19.0]] {
            assert!(!solid(&out, p), "{p:?}");
        }
        assert!(solid(&out, [20.0, 19.25, 15.0]));
        // and nothing where the end opens as well, along its edges and at the corner of all three
        let end = OpenFace {
            at: [0.0, 10.0, 15.0],
            normal: [-1.0, 0.0, 0.0],
            key: None,
        };
        let (out, r) = shell(&m, &[top(20.0), side, end], 1.5, &o()).unwrap();
        assert!(!r.exact && r.watertight && r.shells == 1, "{r:?}");
        for p in [
            [0.3, 0.3, 19.7],
            [0.3, 10.0, 19.7],
            [0.3, 0.3, 15.0],
            [20.0, 0.3, 19.7],
        ] {
            assert!(!solid(&out, p), "{p:?}");
        }
        assert!(solid(&out, [40.0 - 0.75, 10.0, 15.0]));
        // and nothing along the top of a half hull open on top and on its centerline, sent without its faces as an
        // app sends a mesh
        let f = Frame {
            origin: [0.0; 3],
            u: [0.0, 1.0, 0.0],
            v: [0.0, 0.0, 1.0],
            w: [1.0, 0.0, 0.0],
        };
        let outline = vec![
            [0.0, 30.0],
            [0.0, 8.0],
            [3.0, 3.0],
            [8.0, 0.5],
            [15.0, 0.0],
            [22.0, 2.0],
            [25.0, 8.0],
            [25.0, 30.0],
        ];
        let mut hull = build::extrude(&[Polygon::simple(outline)], &f, 0.0, 120.0).unwrap();
        hull.faces = None;
        let centerline = OpenFace {
            at: [60.0, 0.0, 20.0],
            normal: [0.0, -1.0, 0.0],
            key: None,
        };
        let (out, r) = shell(&hull, &[top(30.0), centerline], 1.5, &o()).unwrap();
        assert!(!r.exact && r.watertight && r.shells == 1, "{r:?}");
        assert!(!solid(&out, [60.0, 0.3, 29.7]));
        // the slanted kept face meets the centerline at z 8 and keeps its rounded lip, solid at y 0.05 up to z 9.4;
        // a wall run on flush to z 10.9 would end in a knife edge too thin to print
        assert!(solid(&out, [60.0, 0.1, 9.0]));
        assert!(!solid(&out, [60.0, 0.1, 10.0]));
        assert!(!solid(&out, [60.0, 0.1, 11.5]));
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

    /// The body, its faces and the faces at `open`, as `shell` finds them.
    fn prepared(m: &TriMesh, open: &[OpenFace]) -> (TriMesh, Faces, Vec<u32>) {
        let w = m.weld(mesh::weld_tolerance(m.bounds()));
        let f = faces::recognize(&w);
        let (opened, _) = open_faces(&w, &f, open).unwrap();
        (w, f, opened)
    }

    /// The open shell as it was made before the inner wall stood for the cavity: the hollowed body cut out of the
    /// body, then each open face cut through with that.
    fn by_boolean(
        w: &TriMesh,
        f: &Faces,
        opened: &[u32],
        wall: f64,
        voxel: f64,
        inner: &TriMesh,
    ) -> (TriMesh, BooleanReport) {
        let mut body = w.clone();
        body.faces = None;
        let mut hollowed = body.clone();
        hollowed.append(inner);
        let cavity = boolean::boolean(&[body], std::slice::from_ref(&hollowed), BoolOp::Difference, &o())
            .unwrap()
            .0;
        cut_open(w, f, opened, wall, voxel, hollowed, &cavity, o()).unwrap()
    }

    /// The wall at the result's inner points (those off the outer surface, below the top 2 mm): min, mean, max.
    fn wall_at(out: &TriMesh, outer: &TriMesh, top: f64) -> (f64, f64, f64) {
        let to_outer = |p: V3| {
            outer
                .triangles
                .iter()
                .map(|&t| {
                    let [a, b, c] = outer.corners(t);
                    vec3::len(vec3::sub(p, hollow::closest_point_on_triangle(p, a, b, c)))
                })
                .fold(f64::MAX, f64::min)
        };
        let ds: Vec<f64> = out
            .positions
            .iter()
            .filter(|p| p[2] < top - 2.0)
            .map(|&p| to_outer(p))
            .filter(|&d| d > 1e-3)
            .collect();
        let lo = ds.iter().copied().fold(f64::MAX, f64::min);
        let hi = ds.iter().copied().fold(0.0, f64::max);
        (lo, ds.iter().sum::<f64>() / ds.len() as f64, hi)
    }

    #[test]
    fn the_inner_wall_turned_over_is_the_cavity() {
        let m = build::cylinder(&Frame::WORLD, 15.0, 0.0, 20.0, 64);
        let (w, f, opened) = prepared(&m, &[top(20.0)]);
        let (out, r, voxel, why) = voxel_shell(&w, &f, &opened, 2.0, o()).unwrap();
        assert_eq!(why, None);
        assert!(r.watertight && r.shells == 1, "{r:?}");
        assert!(out.welded().edge_report().is_watertight());
        // The same cup as the boolean made, to well under a voxel, with the same wall.
        let inner = hollow::inner_wall(&w, &HollowOptions::default()).unwrap().0;
        let (old, old_r) = by_boolean(&w, &f, &opened, 2.0, voxel, &inner);
        assert!(old_r.watertight && old_r.shells == 1, "{old_r:?}");
        assert!(
            (out.volume() - old.volume()).abs() < 1e-3 * old.volume(),
            "{} vs {}",
            out.volume(),
            old.volume()
        );
        let (now, then) = (wall_at(&out, &w, 20.0), wall_at(&old, &w, 20.0));
        for (a, b) in [(now.0, then.0), (now.1, then.1), (now.2, then.2)] {
            assert!((a - b).abs() < 0.05 * voxel, "wall {now:?} vs {then:?}");
        }
        assert!(now.0 > 1.0 && (now.1 - 2.0).abs() < 0.5 && now.2 < 3.0, "{now:?}");
    }

    #[test]
    fn an_unusable_inner_wall_makes_the_cavity_by_a_boolean_as_before() {
        // An inner wall facing out of the cavity encloses no cavity, so the boolean makes it, as it always did.
        let m = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        let (w, f, opened) = prepared(&m, &[top(20.0)]);
        let ball = |x: f64| build::uv_sphere([x, 15.0, 12.0], 6.0, 16, 32);
        let outward = ball(15.0);
        assert_eq!(turned_over(&outward).unwrap_err(), Unusable::Empty);
        let (out, r, why) = open_through(&w, &f, &opened, 2.0, 0.7, &outward, o()).unwrap();
        assert_eq!(why, Some(Unusable::Empty));
        let (old, old_r) = by_boolean(&w, &f, &opened, 2.0, 0.7, &outward);
        assert_eq!((&out.positions, &out.triangles), (&old.positions, &old.triangles));
        assert_eq!(r, old_r);
        // One with a hole is no cavity either.
        let mut open = ball(15.0);
        open.flip();
        open.triangles.pop();
        assert_eq!(turned_over(&open).unwrap_err(), Unusable::Open);
        // Two cavities that run into each other: their faces cross, and the cut takes the robust engine for them.
        let mut inner = ball(15.0);
        inner.append(&ball(22.0));
        inner.flip();
        let (out, r, why) = open_through(&w, &f, &opened, 2.0, 0.7, &inner, o()).unwrap();
        assert_eq!(why, None);
        assert!(r.watertight && r.shells == 1, "{r:?}");
        let (old, _) = by_boolean(&w, &f, &opened, 2.0, 0.7, &inner);
        assert!(
            (out.volume() - old.volume()).abs() < 1e-6 * old.volume(),
            "{} vs {}",
            out.volume(),
            old.volume()
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
    fn a_disconnected_open_face_key_requires_repair() {
        let mesh = TriMesh::new(
            vec![
                [0.0, 0.0, 20.0],
                [2.0, 0.0, 20.0],
                [0.0, 2.0, 20.0],
                [10.0, 0.0, 20.0],
                [11.0, 0.0, 20.0],
                [10.0, 1.0, 20.0],
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
            ],
            vec![[0, 1, 2], [3, 4, 5], [6, 7, 8]],
        );
        let faces = Faces {
            ids: vec![0, 0, 1],
            keys: vec![7, 8],
            table: vec![
                Surface::Plane {
                    normal: [0.0, 0.0, 1.0],
                    offset: 20.0,
                },
                Surface::Plane {
                    normal: [0.0, 0.0, 1.0],
                    offset: 0.0,
                },
            ],
        };
        let reference = OpenFace {
            key: Some(7),
            ..top(20.0)
        };
        let error = open_faces(&mesh, &faces, &[reference]).unwrap_err().to_string();
        assert!(error.contains("split") && error.contains("repair"), "{error}");
    }

    #[test]
    fn a_missing_open_face_key_requires_repair() {
        let mut m = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        crate::faces::with_key_salt(Some(9), || crate::faces::base_keys(&mut m));
        let missing = OpenFace {
            key: Some(1),
            ..top(20.0)
        };
        let error = shell(&m, &[missing], 2.0, &o()).unwrap_err().to_string();
        assert!(error.contains("missing") && error.contains("repair"), "{error}");
    }

    #[test]
    fn a_shallow_round_body_open_at_the_top_is_a_dish() {
        // 3 mm tall: closed, a 2 mm wall leaves no cavity; open at the top it leaves a dish 1 mm deep, as a box does
        let m = build::cylinder(&Frame::WORLD, 15.0, 0.0, 3.0, 64);
        let (out, r) = shell(&m, &[top(3.0)], 2.0, &o()).unwrap();
        assert!(!r.exact && r.watertight && r.shells == 1, "{r:?}");
        let want = std::f64::consts::PI * (225.0 * 3.0 - 169.0);
        assert!(
            (out.volume() - want).abs() / want < 0.12,
            "{} vs {want}",
            out.volume()
        );
        // 1.5 mm tall, the cavity only reaches the room past the top: too thick
        let m = build::cylinder(&Frame::WORLD, 15.0, 0.0, 1.5, 64);
        let e = shell(&m, &[top(1.5)], 2.0, &o()).unwrap_err().to_string();
        assert!(e.contains("too thick"), "{e}");
    }

    #[test]
    fn what_cannot_be_shelled_is_refused_in_words() {
        let m = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        let e = shell(&m, &[top(20.0)], 0.0, &o()).unwrap_err().to_string();
        assert!(e.contains("wallMm"), "{e}");
        let e = shell(&m, &[top(20.0)], 16.0, &o()).unwrap_err().to_string();
        assert!(e.contains("too thick"), "{e}");
        // Closed, a wall past half of every side leaves no cavity, though each face keeps its normal.
        let cube = build::box_mesh([0.0; 3], [20.0; 3]);
        for wall in [10.1, 12.0, 19.0] {
            let e = shell(&cube, &[], wall, &o()).unwrap_err().to_string();
            assert!(e.contains("too thick"), "{wall}: {e}");
        }
        // Just under half is still a cavity, 0.2 mm across.
        let (out, r) = shell(&cube, &[], 9.9, &o()).unwrap();
        assert!(r.exact && r.shells == 2, "{r:?}");
        assert!(
            (out.volume() - (8000.0 - 0.2 * 0.2 * 0.2)).abs() < 1e-6,
            "{}",
            out.volume()
        );
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

    #[test]
    fn a_face_prism_is_built_the_same_every_time() {
        let m = build::cylinder(&Frame::WORLD, 6.0, 0.0, 4.0, 48);
        let f = faces::recognize(&m);
        let t = m.triangles.iter().position(|&t| m.normal(t)[2] > 0.0).unwrap();
        let first = prism(&m, &f, f.ids[t], [0.0, 0.0, 1.0], 1.0, 2.0);
        for _ in 0..16 {
            assert_eq!(prism(&m, &f, f.ids[t], [0.0, 0.0, 1.0], 1.0, 2.0), first);
        }
    }
}
