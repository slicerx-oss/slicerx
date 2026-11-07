// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! edges, faces and whole bodies projected onto a sketch plane as sketch curves
// point, run and triangle indices stay inside the lists built here
#![allow(clippy::indexing_slicing)]

use crate::edge::EdgeRef;
use crate::error::{Error, Result};
use crate::faces::{self, Faces};
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::poly2d;
use crate::sketch::{CLOSE_MM, Loop, Segment};
use crate::sketch_spline;
use crate::vec3::{self, Frame, V2, V3};
use crate::xform::{self, Mat4};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

/// how far a curve may stray from the projected points, mm
const TOL_MM: f64 = sketch_spline::TOL_MM;
/// a saved edge or face point is found this close to the mesh
const REF_MM: f64 = 0.01;
/// a facet of a round turns at most this much, degrees; a coarser polygon stays lines
const ARC_STEP_DEG: f64 = 40.0;
/// lines that each turn less than this, degrees, read as one smooth curve
const SMOOTH_DEG: f64 = 20.0;
const RUN_POINTS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceRef {
    pub at: V3,
    pub normal: V3,
    #[serde(default)]
    pub key: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    Edges {
        #[serde(default)]
        part: usize,
        edges: Vec<EdgeRef>,
    },
    Face {
        #[serde(default)]
        part: usize,
        face: FaceRef,
    },
    Silhouette,
}

/// a part of the source body and where it stands
pub struct Part {
    pub mesh: TriMesh,
    pub transform: Mat4,
}

fn pkey(p: V3) -> [u64; 3] {
    p.map(|c| (c + 0.0).to_bits())
}

fn gone(what: &str) -> Error {
    Error::invalid(
        "source",
        format!("The {what} this projected is gone; project it again or remove it."),
    )
}

fn split(what: &str) -> Error {
    Error::invalid(
        "source",
        format!("The {what} this projected was split; project it again or remove it."),
    )
}

/// the sketch curves of `source` on the plane of `frame`
pub fn project(parts: &[Part], frame: &Frame, source: &Source) -> Result<Vec<Loop>> {
    let part = |i: usize| {
        parts
            .get(i)
            .ok_or_else(|| Error::invalid("part", format!("the body has no part {}", i + 1)))
    };
    let lines = match source {
        Source::Edges { part: i, edges } => {
            let p = part(*i)?;
            p.mesh.validate("mesh")?;
            if edges.is_empty() {
                return Err(Error::invalid("edges", "pick at least one edge"));
            }
            let mut runs = Vec::new();
            for e in edges {
                runs.extend(edge_runs(&p.mesh, e)?);
            }
            let flat = runs
                .iter()
                .map(|(r, closed)| (on_plane(frame, &p.transform, r), *closed))
                .collect();
            joined(flat)
        }
        Source::Face { part: i, face } => {
            let p = part(*i)?;
            p.mesh.validate("mesh")?;
            let rings: Vec<(Vec<V2>, bool)> = face_rings(&p.mesh, face)?
                .iter()
                .map(|r| (on_plane(frame, &p.transform, r), true))
                .filter(|(r, _)| poly2d::signed_area(r).abs() > 1e-9)
                .collect();
            if rings.is_empty() {
                return Err(Error::invalid(
                    "face",
                    "The face is seen edge on from the sketch, so its outline has no area.",
                ));
            }
            rings
        }
        Source::Silhouette => shadow(parts, frame)?,
    };
    let loops: Vec<Loop> = lines.iter().filter_map(|(r, closed)| fit(r, *closed)).collect();
    if loops.is_empty() {
        return Err(Error::invalid(
            "source",
            "The edges are seen end on from the sketch, so they project to points.",
        ));
    }
    Ok(loops)
}

fn on_plane(frame: &Frame, t: &Mat4, run: &[V3]) -> Vec<V2> {
    run.iter().map(|&p| frame.project(xform::apply(t, p))).collect()
}

/// the edge found again on the mesh, as runs of points and whether each closes
fn edge_runs(mesh: &TriMesh, e: &EdgeRef) -> Result<Vec<(Vec<V3>, bool)>> {
    let keyed = mesh.faces.as_ref().filter(|f| !f.keys.is_empty());
    if let (Some([k0, k1]), Some(f)) = (e.keys, keyed) {
        let runs = chain(&between(mesh, f, k0, k1));
        if runs.is_empty() {
            return Err(gone("edge"));
        }
        if runs.len() == 1 {
            return Ok(runs);
        }
        // the faces meet in several places: the run the saved edge sat on
        let mid = vec3::scale(vec3::add(e.a, e.b), 0.5);
        let mut on: Vec<_> = runs
            .into_iter()
            .filter(|(r, closed)| near_run(r, *closed, mid) || near_run(r, *closed, e.a))
            .collect();
        return if on.len() == 1 {
            Ok(vec![on.remove(0)])
        } else {
            Err(split("edge"))
        };
    }
    let tol = REF_MM.max(mesh.bounds().map_or(0.0, |b| b.diagonal()) * 1e-7);
    if !mesh.positions.iter().any(|&p| vec3::len(vec3::sub(p, e.a)) < tol) {
        return Err(gone("edge"));
    }
    if let Some(c) = e.center {
        // a round edge: its circle, in the plane square to its flat face
        let n = vec3::normalize(e.face).ok_or_else(|| gone("edge"))?;
        let x = vec3::sub(e.a, c);
        let r = vec3::len(x);
        let x = vec3::normalize(x).ok_or_else(|| gone("edge"))?;
        let y = vec3::cross(n, x);
        let ring = (0..128)
            .map(|k| {
                let a = f64::from(k) * std::f64::consts::TAU / 128.0;
                let (s, co) = a.m_sin_cos();
                vec3::add(c, vec3::add(vec3::scale(x, r * co), vec3::scale(y, r * s)))
            })
            .collect();
        return Ok(vec![(ring, true)]);
    }
    if !mesh.positions.iter().any(|&p| vec3::len(vec3::sub(p, e.b)) < tol) {
        return Err(gone("edge"));
    }
    Ok(vec![(vec![e.a, e.b], false)])
}

fn near_run(run: &[V3], closed: bool, p: V3) -> bool {
    let n = run.len();
    let sides = if closed { n } else { n.saturating_sub(1) };
    (0..sides).any(|i| dist_to_segment(p, run[i], run[(i + 1) % n]) < REF_MM)
}

fn dist_to_segment(p: V3, a: V3, b: V3) -> f64 {
    let ab = vec3::sub(b, a);
    let l2 = vec3::dot(ab, ab);
    let t = if l2 > 0.0 {
        (vec3::dot(vec3::sub(p, a), ab) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    vec3::len(vec3::sub(p, vec3::add(a, vec3::scale(ab, t))))
}

/// the mesh sides shared by a triangle of face `k0` and one of face `k1`
fn between(mesh: &TriMesh, f: &Faces, k0: u64, k1: u64) -> Vec<(V3, V3)> {
    let key = |t: usize| f.keys.get(f.ids[t] as usize).copied().unwrap_or(0);
    let mut sides: HashMap<([u64; 3], [u64; 3]), u64> = HashMap::new();
    let mut out = Vec::new();
    for (t, tri) in mesh.triangles.iter().enumerate() {
        let k = key(t);
        if k != k0 && k != k1 {
            continue;
        }
        let c = mesh.corners(*tri);
        for j in 0..3 {
            let (a, b) = (c[j], c[(j + 1) % 3]);
            if sides.get(&(pkey(b), pkey(a))).is_some_and(|&o| o != k) {
                out.push((a, b));
            }
            sides.insert((pkey(a), pkey(b)), k);
        }
    }
    out
}

/// sides joined end to end: open runs from their ends first, then closed rings
fn chain(segs: &[(V3, V3)]) -> Vec<(Vec<V3>, bool)> {
    let mut at: HashMap<[u64; 3], Vec<usize>> = HashMap::new();
    for (i, (a, b)) in segs.iter().enumerate() {
        at.entry(pkey(*a)).or_default().push(i);
        at.entry(pkey(*b)).or_default().push(i);
    }
    let degree = |p: V3| at.get(&pkey(p)).map_or(0, Vec::len);
    let mut used = vec![false; segs.len()];
    let mut out = Vec::new();
    let ends = (0..segs.len()).filter(|&i| degree(segs[i].0) == 1 || degree(segs[i].1) == 1);
    let order: Vec<usize> = ends.chain(0..segs.len()).collect();
    for i in order {
        if used[i] {
            continue;
        }
        let (a, b) = segs[i];
        let start = if degree(a) != 1 && degree(b) == 1 { b } else { a };
        let mut pts = vec![start];
        let mut s = i;
        loop {
            used[s] = true;
            let (p, q) = segs[s];
            let cur = if pkey(p) == pkey(pts[pts.len() - 1]) { q } else { p };
            pts.push(cur);
            let next = at
                .get(&pkey(cur))
                .and_then(|list| list.iter().copied().find(|&j| !used[j]));
            match next {
                Some(j) => s = j,
                None => break,
            }
        }
        let closed = pts.len() > 3 && pkey(pts[0]) == pkey(pts[pts.len() - 1]);
        if closed {
            pts.pop();
        }
        out.push((pts, closed));
    }
    out
}

/// open runs joined where their ends meet on the plane; a run whose ends meet closes
fn joined(runs: Vec<(Vec<V2>, bool)>) -> Vec<(Vec<V2>, bool)> {
    let close = |a: V2, b: V2| (a[0] - b[0]).m_hypot(a[1] - b[1]) <= CLOSE_MM;
    let (mut done, mut open): (Vec<_>, Vec<_>) = runs.into_iter().partition(|(_, c)| *c);
    while let Some((mut run, _)) = open.pop() {
        loop {
            let (head, tail) = (run[0], run[run.len() - 1]);
            let Some(k) = open.iter().position(|(r, _)| {
                close(r[0], tail)
                    || close(r[r.len() - 1], tail)
                    || close(r[0], head)
                    || close(r[r.len() - 1], head)
            }) else {
                break;
            };
            let (mut r, _) = open.swap_remove(k);
            if close(r[0], tail) {
                run.extend(r.drain(1..));
            } else if close(r[r.len() - 1], tail) {
                r.reverse();
                run.extend(r.drain(1..));
            } else if close(r[r.len() - 1], head) {
                r.extend(run.drain(1..));
                run = r;
            } else {
                r.reverse();
                r.extend(run.drain(1..));
                run = r;
            }
        }
        let closed = run.len() > 3 && close(run[0], run[run.len() - 1]);
        if closed {
            run.pop();
        }
        done.push((run, closed));
    }
    done
}

/// the triangle at `at` facing `normal`, on an unkeyed mesh
fn triangle_at(mesh: &TriMesh, at: V3, normal: V3) -> Option<usize> {
    let n = vec3::normalize(normal)?;
    mesh.triangles.iter().position(|t| {
        let [a, b, c] = mesh.corners(*t);
        let Some(m) = vec3::normalize(mesh.normal(*t)) else {
            return false;
        };
        if vec3::dot(m, n) < 0.9999 || vec3::dot(vec3::sub(at, a), m).abs() > REF_MM {
            return false;
        }
        // inside, with the tolerance on each side
        [(a, b), (b, c), (c, a)].iter().all(|&(p, q)| {
            vec3::dot(vec3::cross(vec3::sub(q, p), vec3::sub(at, p)), m)
                >= -REF_MM * vec3::len(vec3::sub(q, p))
        })
    })
}

/// the face's boundary as closed rings of points, holes too
fn face_rings(mesh: &TriMesh, face: &FaceRef) -> Result<Vec<Vec<V3>>> {
    let found;
    let f = if let Some(f) = &mesh.faces {
        f
    } else {
        found = faces::recognize(mesh);
        &found
    };
    let id = match face.key {
        Some(k) if k != 0 && !f.keys.is_empty() => {
            let present: HashSet<u32> = f.ids.iter().copied().collect();
            let n = (0..f.keys.len())
                .filter(|&i| f.keys[i] == k && u32::try_from(i).is_ok_and(|i| present.contains(&i)))
                .count();
            if n == 0 {
                return Err(gone("face"));
            }
            if n > 1 {
                return Err(split("face"));
            }
            faces::resolve_key(mesh, f, k).map_err(|_| split("face"))?
        }
        _ => {
            let t = triangle_at(mesh, face.at, face.normal).ok_or_else(|| gone("face"))?;
            f.ids[t]
        }
    };
    let mut sides: HashMap<([u64; 3], [u64; 3]), (V3, V3)> = HashMap::new();
    for (t, tri) in mesh.triangles.iter().enumerate() {
        if f.ids[t] != id {
            continue;
        }
        let c = mesh.corners(*tri);
        for j in 0..3 {
            let (a, b) = (c[j], c[(j + 1) % 3]);
            // a side shared inside the face cancels its twin
            if sides.remove(&(pkey(b), pkey(a))).is_none() {
                sides.insert((pkey(a), pkey(b)), (a, b));
            }
        }
    }
    let mut next: HashMap<[u64; 3], Vec<(V3, V3)>> = HashMap::new();
    for &(a, b) in sides.values() {
        next.entry(pkey(a)).or_default().push((a, b));
    }
    let mut rings = Vec::new();
    let mut starts: Vec<[u64; 3]> = next.keys().copied().collect();
    starts.sort_unstable();
    for s in starts {
        while let Some((a, mut b)) = next.get_mut(&s).and_then(Vec::pop) {
            let mut ring = vec![a];
            while pkey(b) != s {
                ring.push(b);
                match next.get_mut(&pkey(b)).and_then(Vec::pop) {
                    Some((_, q)) => b = q,
                    None => break,
                }
            }
            if ring.len() >= 3 {
                rings.push(ring);
            }
        }
    }
    if rings.is_empty() {
        return Err(gone("face"));
    }
    Ok(rings)
}

/// the body's shadow on the plane: every triangle filled, outer rings and the holes right through
fn shadow(parts: &[Part], frame: &Frame) -> Result<Vec<(Vec<V2>, bool)>> {
    let mut tris = Vec::new();
    for p in parts {
        p.mesh.validate("mesh")?;
        for t in &p.mesh.triangles {
            let [a, b, c] = p
                .mesh
                .corners(*t)
                .map(|q| frame.project(xform::apply(&p.transform, q)));
            let s = poly2d::orient(a, b, c);
            if s.abs() < 1e-12 {
                continue;
            }
            tris.push(if s > 0.0 { vec![a, b, c] } else { vec![a, c, b] });
        }
    }
    let polys = poly2d::fill_nonzero(tris, 1e-6);
    if polys.is_empty() {
        return Err(Error::invalid(
            "source",
            "The body casts no outline on the sketch plane.",
        ));
    }
    Ok(polys
        .into_iter()
        .flat_map(|p| std::iter::once(p.outer).chain(p.holes))
        .map(|r| (r, true))
        .collect())
}

fn d2(a: V2, b: V2) -> f64 {
    (a[0] - b[0]).m_hypot(a[1] - b[1])
}

/// the circle through three points
fn circle3(a: V2, b: V2, c: V2) -> Option<(V2, f64)> {
    let (bx, by) = (b[0] - a[0], b[1] - a[1]);
    let (cx, cy) = (c[0] - a[0], c[1] - a[1]);
    let d = 2.0 * (bx * cy - by * cx);
    if d.abs() < 1e-12 {
        return None;
    }
    let (b2, c2) = (bx * bx + by * by, cx * cx + cy * cy);
    let o = [a[0] + (cy * b2 - by * c2) / d, a[1] + (bx * c2 - cx * b2) / d];
    let r = d2(o, a);
    (r.is_finite() && r < 1e5).then_some((o, r))
}

fn line_fits(q: &[V2]) -> bool {
    let (a, b) = (q[0], q[q.len() - 1]);
    let l = d2(a, b);
    if l < 1e-9 {
        return false;
    }
    let d = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    let mut last = 0.0;
    q.iter().all(|p| {
        let t = (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1];
        let off = ((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]).abs();
        let ahead = t >= last - TOL_MM;
        last = t;
        off <= TOL_MM && ahead
    })
}

/// whether every point of `q` sits on the circle, turning one way in steps no longer than a facet of a round
fn round(q: &[V2], o: V2, r: f64) -> bool {
    let step = 2.0 * (ARC_STEP_DEG.to_radians() / 2.0).m_sin() * r;
    let turn = poly2d::orient(q[0], q[1], q[2]).signum();
    q.iter().all(|&p| (d2(p, o) - r).abs() <= TOL_MM)
        && q.windows(2).all(|w| d2(w[0], w[1]) <= step)
        && q.windows(3)
            .all(|w| poly2d::orient(w[0], w[1], w[2]) * turn > 0.0)
}

/// an arc through the points that sags off its chord
fn arc_fits(q: &[V2]) -> bool {
    let n = q.len();
    n >= 4 && circle3(q[0], q[n / 2], q[n - 1]).is_some_and(|(o, r)| round(q, o, r)) && !line_fits(q)
}

#[derive(Clone, Copy)]
enum Piece {
    Line(V2),
    Arc(V2, V2),
}

fn turn_deg(a: V2, b: V2, c: V2) -> f64 {
    let (u, v) = ([b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]]);
    (u[0] * v[1] - u[1] * v[0])
        .m_atan2(u[0] * v[0] + u[1] * v[1])
        .to_degrees()
}

/// the pieces along an open run of points, each with the index it ends at: the longest arc from each point, else
/// the longest line
fn pieces(p: &[V2]) -> Vec<(Piece, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < p.len() {
        let mut best = None;
        let mut j = i + 3;
        while j < p.len() && j - i < RUN_POINTS && arc_fits(&p[i..=j]) {
            best = Some(j);
            j += 1;
        }
        if let Some(j) = best {
            out.push((Piece::Arc(p[usize::midpoint(i, j)], p[j]), j));
            i = j;
            continue;
        }
        let mut j = i + 1;
        while j + 1 < p.len() && j - i < RUN_POINTS && line_fits(&p[i..=j + 1]) {
            j += 1;
        }
        out.push((Piece::Line(p[j]), j));
        i = j;
    }
    out
}

fn segment(kind: &str, to: V2) -> Segment {
    Segment {
        kind: kind.to_owned(),
        to: Some(to),
        ..Segment::default()
    }
}

/// pieces as sketch segments: four or more lines that bend smoothly become one spline through their points
fn segments(start: V2, pieces: &[(Piece, usize)]) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut from = start;
    let mut i = 0;
    while i < pieces.len() {
        if let (Piece::Arc(through, to), _) = pieces[i] {
            out.push(Segment {
                through: Some(through),
                ..segment("arc", to)
            });
            from = to;
            i += 1;
            continue;
        }
        let mut pts = vec![from];
        let mut j = i;
        while let Some((Piece::Line(to), _)) = pieces.get(j) {
            let n = pts.len();
            if n >= 2 && turn_deg(pts[n - 2], pts[n - 1], *to).abs() >= SMOOTH_DEG {
                break;
            }
            pts.push(*to);
            j += 1;
        }
        if j - i >= 4 {
            let to = pts[pts.len() - 1];
            out.push(Segment {
                points: pts[1..pts.len() - 1].to_vec(),
                ..segment("spline", to)
            });
            from = to;
            i = j;
        } else if let (Piece::Line(to), _) = pieces[i] {
            out.push(segment("line", to));
            from = to;
            i += 1;
        }
    }
    out
}

/// the corner a closed ring turns most at
fn sharpest(p: &[V2]) -> usize {
    let n = p.len();
    (0..n)
        .max_by(|&a, &b| {
            let t = |i: usize| turn_deg(p[(i + n - 1) % n], p[i], p[(i + 1) % n]).abs();
            t(a).total_cmp(&t(b))
        })
        .unwrap_or(0)
}

/// a projected run of points as one sketch loop: a circle, or lines, arcs and splines
pub fn fit(pts: &[V2], closed: bool) -> Option<Loop> {
    let mut p: Vec<V2> = Vec::with_capacity(pts.len());
    for &q in pts {
        if p.last().is_none_or(|&l| d2(l, q) > 1e-6) {
            p.push(q);
        }
    }
    if closed {
        while p.len() > 1 && d2(p[0], p[p.len() - 1]) <= 1e-6 {
            p.pop();
        }
    }
    if p.len() < 2 || (closed && p.len() < 3) {
        return None;
    }
    if closed {
        let n = p.len();
        let mut ring = p.clone();
        ring.push(p[0]);
        if n >= 8
            && let Some((o, r)) = circle3(p[0], p[n / 3], p[2 * n / 3])
            && round(&ring, o, r)
        {
            return Some(Loop {
                kind: Some("circle".to_owned()),
                center: Some(o),
                diameter_mm: Some(2.0 * r),
                ..Loop::default()
            });
        }
        // start at a break between two pieces, so the seam never cuts an arc or a line in two
        let k = sharpest(&p);
        p.rotate_left(k);
        ring.clone_from(&p);
        ring.push(p[0]);
        let first = pieces(&ring);
        if first.len() >= 2 {
            p.rotate_left(first[0].1 % n);
        }
        p.push(p[0]);
    }
    let start = p[0];
    Some(Loop {
        start: Some(start),
        segments: segments(start, &pieces(&p)),
        ..Loop::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_square_stays_four_lines() {
        let l = fit(&[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]], true).unwrap();
        assert_eq!(l.segments.len(), 4);
        assert!(l.segments.iter().all(|s| s.kind == "line"));
    }

    #[test]
    fn collinear_points_merge_into_one_line() {
        let l = fit(&[[0.0, 0.0], [2.0, 0.0], [5.0, 0.0], [9.0, 0.0]], false).unwrap();
        assert_eq!(l.segments.len(), 1);
        assert_eq!(l.segments[0].to, Some([9.0, 0.0]));
    }

    #[test]
    fn facets_of_a_round_come_back_as_its_circle() {
        let ring: Vec<V2> = (0..48)
            .map(|k| {
                let (s, c) = (f64::from(k) * std::f64::consts::TAU / 48.0).m_sin_cos();
                [3.0 + 5.0 * c, -2.0 + 5.0 * s]
            })
            .collect();
        let l = fit(&ring, true).unwrap();
        assert_eq!(l.kind.as_deref(), Some("circle"));
        let c = l.center.unwrap();
        assert!((c[0] - 3.0).abs() < 1e-9 && (c[1] + 2.0).abs() < 1e-9);
        assert!((l.diameter_mm.unwrap() - 10.0).abs() < 1e-9);
    }

    #[test]
    fn a_slot_is_two_lines_and_two_arcs() {
        let mut ring = vec![[0.0, -5.0], [20.0, -5.0]];
        for k in 1..24 {
            let (s, c) =
                (-std::f64::consts::FRAC_PI_2 + f64::from(k) * std::f64::consts::PI / 24.0).m_sin_cos();
            ring.push([20.0 + 5.0 * c, 5.0 * s]);
        }
        ring.extend([[20.0, 5.0], [0.0, 5.0]]);
        for k in 1..24 {
            let (s, c) =
                (std::f64::consts::FRAC_PI_2 + f64::from(k) * std::f64::consts::PI / 24.0).m_sin_cos();
            ring.push([5.0 * c, 5.0 * s]);
        }
        let l = fit(&ring, true).unwrap();
        let kinds: Vec<&str> = l.segments.iter().map(|s| s.kind.as_str()).collect();
        assert_eq!(kinds.iter().filter(|k| **k == "arc").count(), 2, "{kinds:?}");
        assert_eq!(kinds.iter().filter(|k| **k == "line").count(), 2, "{kinds:?}");
    }
}
