// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! fit check for print-in-place parts
// indices run over three-element corner and axis arrays (0..3, k % 3)
#![allow(clippy::indexing_slicing)]

use crate::convex;
use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::import::auto::edge_shells;
use crate::mesh::{Aabb, TriMesh};
use crate::vec3::{self, V3};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_GAPS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FitOptions {
    /// smallest gap the printer keeps open between side-by-side faces, per side
    pub min_gap_mm: f64,
    #[serde(default)]
    pub min_vertical_gap_mm: Option<f64>,
    #[serde(default)]
    pub layer_height_mm: Option<f64>,
    /// leave out parts that touch: one object's touching parts print as one piece, and they would crowd out real gaps
    #[serde(default)]
    pub skip_fused: bool,
    /// also report separate pieces closer than this that do not touch, the closest pair per two pieces
    #[serde(default)]
    pub apart_mm: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GapKind {
    Horizontal,
    Vertical,
    Fused,
    /// two pieces that do not touch, so they print loose
    Apart,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub parts: [usize; 2],
    pub gap_mm: f64,
    pub limit_mm: f64,
    pub kind: GapKind,
    pub from: V3,
    pub to: V3,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FitPart {
    pub bounds: Aabb,
    pub volume_mm3: f64,
    pub triangles: usize,
    /// the input mesh the body came from
    pub item: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FitReport {
    pub parts: Vec<FitPart>,
    pub gaps: Vec<Gap>,
    pub limit_mm: f64,
    pub vertical_limit_mm: f64,
    /// bodies that touch, joined: how many separate pieces print
    pub pieces: usize,
    pub warnings: Vec<String>,
}

pub fn fit_check(mesh: &TriMesh, opts: &FitOptions) -> Result<FitReport> {
    fit_check_items(std::slice::from_ref(mesh), opts)
}

/// bodies are found per input mesh and keep its index, so a gap names the meshes it lies between
pub fn fit_check_items(items: &[TriMesh], opts: &FitOptions) -> Result<FitReport> {
    for m in items {
        m.validate("fit")?;
    }
    let g = opts.min_gap_mm;
    if !(g.is_finite() && g > 0.0 && g <= 5.0) {
        return Err(Error::invalid("minGapMm", "between 0 and 5 mm"));
    }
    let layer = opts
        .layer_height_mm
        .filter(|h| h.is_finite() && *h > 0.0)
        .unwrap_or(0.0);
    let gv = opts.min_vertical_gap_mm.unwrap_or(g.max(layer));
    if !(gv.is_finite() && gv > 0.0 && gv <= 5.0) {
        return Err(Error::invalid("minVerticalGapMm", "between 0 and 5 mm"));
    }
    let apart = opts.apart_mm.filter(|a| a.is_finite() && *a > 0.0 && *a <= 20.0);
    let (shells, boxes, from) = item_bodies(items);
    let parts: Vec<FitPart> = shells
        .iter()
        .zip(&boxes)
        .zip(&from)
        .map(|((s, b), &item)| FitPart {
            bounds: *b,
            volume_mm3: s.volume(),
            triangles: s.triangles.len(),
            item,
        })
        .collect();
    let reach = g.max(gv).max(apart.unwrap_or(0.0));
    let mut piece: Vec<usize> = (0..shells.len()).collect();
    let mut loose: Vec<Gap> = Vec::new();
    let mut gaps = Vec::new();
    for (i, (a, ba)) in shells.iter().zip(&boxes).enumerate() {
        for (j, (b, bb)) in shells.iter().zip(&boxes).enumerate().skip(i + 1) {
            if !boxes_within(ba, bb, reach) {
                continue;
            }
            if let Some(gap) = pair_gap(a, b, ba, bb, reach) {
                let kind = classify(&gap);
                if kind == GapKind::Fused {
                    let (ri, rj) = (root(&mut piece, i), root(&mut piece, j));
                    piece[rj] = ri;
                    if opts.skip_fused {
                        continue;
                    }
                }
                let limit = if kind == GapKind::Vertical { gv } else { g };
                if let Some(a) = apart
                    && kind != GapKind::Fused
                    && gap.d >= limit
                    && gap.d < a
                {
                    loose.push(Gap {
                        parts: [i, j],
                        gap_mm: gap.d,
                        limit_mm: a,
                        kind: GapKind::Apart,
                        from: gap.p,
                        to: gap.q,
                    });
                }
                if kind == GapKind::Fused || gap.d < limit {
                    gaps.push(Gap {
                        parts: [i, j],
                        gap_mm: gap.d,
                        limit_mm: limit,
                        kind,
                        from: gap.p,
                        to: gap.q,
                    });
                }
            }
        }
    }
    // pieces joined through other bodies are one piece; of the rest, the closest pair per two pieces
    loose.sort_by(|x, y| x.gap_mm.total_cmp(&y.gap_mm));
    let mut told = std::collections::HashSet::new();
    for l in loose {
        let (a, b) = (root(&mut piece, l.parts[0]), root(&mut piece, l.parts[1]));
        if a != b && told.insert((a.min(b), a.max(b))) {
            gaps.push(l);
        }
    }
    let pieces = (0..piece.len()).filter(|&i| root(&mut piece, i) == i).count();
    gaps.sort_by(|x, y| x.gap_mm.total_cmp(&y.gap_mm));
    gaps.truncate(MAX_GAPS);
    let warnings = gaps.iter().map(sentence).collect();
    Ok(FitReport {
        parts,
        gaps,
        limit_mm: g,
        vertical_limit_mm: gv,
        pieces,
        warnings,
    })
}

/// the bodies of each mesh with their bounds and the mesh's index
fn item_bodies(items: &[TriMesh]) -> (Vec<TriMesh>, Vec<Aabb>, Vec<usize>) {
    let (mut shells, mut boxes, mut from) = (Vec::new(), Vec::new(), Vec::new());
    for (k, m) in items.iter().enumerate() {
        for s in bodies(m) {
            if let Some(b) = s.bounds() {
                shells.push(s);
                boxes.push(b);
                from.push(k);
            }
        }
    }
    (shells, boxes, from)
}

fn root(p: &mut [usize], mut i: usize) -> usize {
    while p[i] != i {
        p[i] = p[p[i]];
        i = p[i];
    }
    i
}

/// shells by their index in the mesh
type Shells = Vec<(usize, TriMesh)>;

fn bodies(mesh: &TriMesh) -> Vec<TriMesh> {
    let shells = edge_shells(mesh);
    let vols: Vec<f64> = shells.iter().map(TriMesh::volume).collect();
    let boxes: Vec<Option<Aabb>> = shells.iter().map(TriMesh::bounds).collect();
    // the shells move into the bodies (no copy of a big mesh); the inside-out ones wait for a holder
    let (mut out, mut cavities): (Shells, Shells) = (Vec::new(), Vec::new());
    for (i, s) in shells.into_iter().enumerate() {
        if vols[i] > 0.0 {
            out.push((i, s));
        } else if vols[i] < 0.0 {
            cavities.push((i, s));
        }
    }
    for (i, s) in &cavities {
        let i = *i;
        let (Some(bi), Some(&probe)) = (boxes[i], s.positions.first()) else {
            continue;
        };
        let holder = out
            .iter_mut()
            .filter(|(j, h)| {
                boxes[*j].is_some_and(|bj| contains(&bj, &bi)) && convex::point_inside_mesh(h, probe)
            })
            .min_by(|(a, _), (b, _)| vols[*a].total_cmp(&vols[*b]));
        if let Some((_, h)) = holder {
            h.append(s);
        }
    }
    out.into_iter().map(|(_, m)| m).collect()
}

fn sentence(g: &Gap) -> String {
    let [a, b] = g.parts.map(|k| k + 1);
    match g.kind {
        GapKind::Fused => format!("Parts {a} and {b} touch or overlap, so they print as one piece."),
        GapKind::Horizontal => format!(
            "Parts {a} and {b} are {:.2} mm apart side by side; your printer needs {:.2} mm, so they may fuse.",
            g.gap_mm, g.limit_mm
        ),
        GapKind::Vertical => format!(
            "Parts {a} and {b} are {:.2} mm apart vertically, less than {:.2} mm, so the gap closes when sliced.",
            g.gap_mm, g.limit_mm
        ),
        GapKind::Apart => format!(
            "Parts {a} and {b} are {:.2} mm apart and do not touch, so they print as separate pieces.",
            g.gap_mm
        ),
    }
}

fn boxes_within(a: &Aabb, b: &Aabb, d: f64) -> bool {
    (0..3).all(|k| a.min[k] - d <= b.max[k] && b.min[k] - d <= a.max[k])
}

struct Closest {
    d: f64,
    p: V3,
    q: V3,
    fused: bool,
}

fn classify(c: &Closest) -> GapKind {
    if c.fused || c.d <= 1e-9 {
        return GapKind::Fused;
    }
    let v = vec3::sub(c.q, c.p);
    if v[2].abs() > v[0].m_hypot(v[1]) {
        GapKind::Vertical
    } else {
        GapKind::Horizontal
    }
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "grid coordinates are clamped to the grid"
)]
fn pair_gap(a: &TriMesh, b: &TriMesh, ba: &Aabb, bb: &Aabb, reach: f64) -> Option<Closest> {
    if let (Some(&pa), Some(&pb)) = (a.positions.first(), b.positions.first())
        && ((contains(bb, ba) && convex::point_inside_mesh(b, pa))
            || (contains(ba, bb) && convex::point_inside_mesh(a, pb)))
    {
        return Some(Closest {
            d: 0.0,
            p: pa,
            q: pa,
            fused: true,
        });
    }
    let lo = [0, 1, 2].map(|k| ba.min[k].max(bb.min[k]) - reach);
    let hi = [0, 1, 2].map(|k| ba.max[k].min(bb.max[k]) + reach);
    // the triangles in reach of the other body's box, by index: corners are read from the mesh when needed, so a part
    // of millions of triangles is not copied
    let near = |m: &TriMesh| -> Vec<u32> {
        (0..m.triangles.len())
            .filter(|&n| {
                let c = m.corners(m.triangles[n]);
                (0..3).all(|k| {
                    let (mn, mx) = span(&c, k);
                    mn <= hi[k] && mx >= lo[k]
                })
            })
            .map(|n| n as u32)
            .collect()
    };
    let (ta, tb) = (near(a), near(b));
    if ta.is_empty() || tb.is_empty() {
        return None;
    }
    let corners_a = |m: usize| a.corners(a.triangles[ta[m] as usize]);
    let corners_b = |n: usize| b.corners(b.triangles[tb[n] as usize]);
    let size = [0, 1, 2].map(|k| (hi[k] - lo[k]).max(1e-9));
    let longest = size.iter().copied().fold(0.0, f64::max);
    let cell = (longest / 64.0).max(reach).max(1e-6);
    let dims = size.map(|s| ((s / cell).ceil() as usize).clamp(1, 256));
    let idx = |x: f64, k: usize| (((x - lo[k]) / cell).floor().max(0.0) as usize).min(dims[k] - 1);
    let range = |c: &[V3; 3], grow: f64| {
        [0, 1, 2].map(|k| {
            let (mn, mx) = span(c, k);
            (idx(mn - grow, k), idx(mx + grow, k))
        })
    };
    let grid = CellLists::new(
        &(0..tb.len())
            .map(|n| range(&corners_b(n), reach))
            .collect::<Vec<_>>(),
    );
    let mut seen = vec![u32::MAX; tb.len()];
    let mut best: Option<Closest> = None;
    for m in 0..ta.len() {
        let c = corners_a(m);
        let r = range(&c, 0.0);
        let cb = [0, 1, 2].map(|k| span(&c, k));
        for x in r[0].0..=r[0].1 {
            for y in r[1].0..=r[1].1 {
                for z in r[2].0..=r[2].1 {
                    for &n in grid.get(x, y, z) {
                        let n = n as usize;
                        if seen[n] == m as u32 {
                            continue;
                        }
                        seen[n] = m as u32;
                        let t = corners_b(n);
                        // no pair of points of two triangles is closer than their boxes: a pair whose boxes are farther
                        // apart than the closest pair so far cannot take its place (with room for rounding)
                        if let Some(b) = &best {
                            let reach = b.d + 1e-9 * b.d.max(1.0);
                            if box_gap2(&cb, &t) > reach * reach {
                                continue;
                            }
                        }
                        let (d, p, q, crosses) = tri_tri(&c, &t);
                        if best.as_ref().is_none_or(|b| d < b.d) {
                            best = Some(Closest {
                                d,
                                p,
                                q,
                                fused: crosses,
                            });
                            // nothing is closer than touching: the first such pair is the answer
                            if d == 0.0 {
                                return best;
                            }
                        }
                    }
                }
            }
        }
    }
    best.filter(|b| b.d < reach || b.fused)
}

/// The squared distance between a box (its span on each axis) and a triangle's box.
fn box_gap2(cb: &[(f64, f64); 3], t: &[V3; 3]) -> f64 {
    (0..3)
        .map(|k| {
            let (mn, mx) = span(t, k);
            let g = (cb[k].0 - mx).max(mn - cb[k].1).max(0.0);
            g * g
        })
        .sum()
}

/// The grid of a fit check as compact lists: the triangles of each occupied cell, side by side in one array, in
/// triangle order within a cell, so a search visits them as a map of lists would, without a list per cell. A cell fits 8
/// bits per axis (at most 256 cells).
struct CellLists {
    /// occupied cell -> its place in `starts`
    at: HashMap<u32, u32>,
    starts: Vec<u32>,
    tris: Vec<u32>,
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "cells are under 256 per axis and triangles and grid entries under 2^32"
)]
impl CellLists {
    fn key(x: usize, y: usize, z: usize) -> u32 {
        ((x << 16) | (y << 8) | z) as u32
    }

    /// `ranges`: the cells each triangle covers, per axis, in triangle order
    fn new(ranges: &[[(usize, usize); 3]]) -> Self {
        let cells = |r: &[(usize, usize); 3]| {
            let r = *r;
            (r[0].0..=r[0].1).flat_map(move |x| {
                (r[1].0..=r[1].1).flat_map(move |y| (r[2].0..=r[2].1).map(move |z| Self::key(x, y, z)))
            })
        };
        let mut count: HashMap<u32, u32> = HashMap::new();
        for r in ranges {
            for k in cells(r) {
                *count.entry(k).or_insert(0) += 1;
            }
        }
        let mut keys: Vec<u32> = count.keys().copied().collect();
        keys.sort_unstable();
        let mut starts = Vec::with_capacity(keys.len() + 1);
        let mut at = HashMap::with_capacity(keys.len());
        let mut total = 0u32;
        for (i, k) in keys.iter().enumerate() {
            at.insert(*k, i as u32);
            starts.push(total);
            total += count[k];
        }
        starts.push(total);
        drop(count);
        let mut fill: Vec<u32> = starts.clone();
        let mut tris = vec![0u32; total as usize];
        for (n, r) in ranges.iter().enumerate() {
            for k in cells(r) {
                let i = at[&k] as usize;
                tris[fill[i] as usize] = n as u32;
                fill[i] += 1;
            }
        }
        Self { at, starts, tris }
    }

    /// the triangles in a cell
    fn get(&self, x: usize, y: usize, z: usize) -> &[u32] {
        self.at.get(&Self::key(x, y, z)).map_or(&[], |&i| {
            let i = i as usize;
            &self.tris[self.starts[i] as usize..self.starts[i + 1] as usize]
        })
    }
}

fn span(c: &[V3; 3], k: usize) -> (f64, f64) {
    let v = c.map(|p| p[k]);
    (v[0].min(v[1]).min(v[2]), v[0].max(v[1]).max(v[2]))
}

fn contains(outer: &Aabb, inner: &Aabb) -> bool {
    (0..3).all(|k| outer.min[k] <= inner.min[k] && inner.max[k] <= outer.max[k])
}

/// closest point to `p` on triangle `abc` (Ericson, Real-Time Collision Detection 5.1.5)
fn closest_on_tri(p: V3, [a, b, c]: &[V3; 3]) -> V3 {
    let (ab, ac, ap) = (vec3::sub(*b, *a), vec3::sub(*c, *a), vec3::sub(p, *a));
    let (d1, d2) = (vec3::dot(ab, ap), vec3::dot(ac, ap));
    if d1 <= 0.0 && d2 <= 0.0 {
        return *a;
    }
    let bp = vec3::sub(p, *b);
    let (d3, d4) = (vec3::dot(ab, bp), vec3::dot(ac, bp));
    if d3 >= 0.0 && d4 <= d3 {
        return *b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return vec3::add(*a, vec3::scale(ab, d1 / (d1 - d3)));
    }
    let cp = vec3::sub(p, *c);
    let (d5, d6) = (vec3::dot(ab, cp), vec3::dot(ac, cp));
    if d6 >= 0.0 && d5 <= d6 {
        return *c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return vec3::add(*a, vec3::scale(ac, d2 / (d2 - d6)));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return vec3::add(*b, vec3::scale(vec3::sub(*c, *b), w));
    }
    let denom = va + vb + vc;
    if denom.abs() < 1e-300 {
        return *a;
    }
    let (v, w) = (vb / denom, vc / denom);
    vec3::add(*a, vec3::add(vec3::scale(ab, v), vec3::scale(ac, w)))
}

/// closest points of segments `p1 q1` and `p2 q2` (Ericson 5.1.9)
fn seg_seg(p1: V3, q1: V3, p2: V3, q2: V3) -> (V3, V3) {
    let (d1, d2, r) = (vec3::sub(q1, p1), vec3::sub(q2, p2), vec3::sub(p1, p2));
    let (a, e, f) = (vec3::dot(d1, d1), vec3::dot(d2, d2), vec3::dot(d2, r));
    let eps = 1e-24;
    let (s, t) = if a <= eps && e <= eps {
        (0.0, 0.0)
    } else if a <= eps {
        (0.0, (f / e).clamp(0.0, 1.0))
    } else {
        let c = vec3::dot(d1, r);
        if e <= eps {
            ((-c / a).clamp(0.0, 1.0), 0.0)
        } else {
            let b = vec3::dot(d1, d2);
            let denom = a * e - b * b;
            let mut s = if denom > eps {
                ((b * f - c * e) / denom).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let mut t = (b * s + f) / e;
            if t < 0.0 {
                t = 0.0;
                s = (-c / a).clamp(0.0, 1.0);
            } else if t > 1.0 {
                t = 1.0;
                s = ((b - c) / a).clamp(0.0, 1.0);
            }
            (s, t)
        }
    };
    (
        vec3::add(p1, vec3::scale(d1, s)),
        vec3::add(p2, vec3::scale(d2, t)),
    )
}

fn seg_hits_tri(p: V3, q: V3, [a, b, c]: &[V3; 3]) -> Option<V3> {
    let dir = vec3::sub(q, p);
    let (e1, e2) = (vec3::sub(*b, *a), vec3::sub(*c, *a));
    let h = vec3::cross(dir, e2);
    let det = vec3::dot(e1, h);
    if det.abs() < 1e-18 {
        return None;
    }
    let s = vec3::sub(p, *a);
    let u = vec3::dot(s, h) / det;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let qv = vec3::cross(s, e1);
    let v = vec3::dot(dir, qv) / det;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = vec3::dot(e2, qv) / det;
    (0.0..=1.0)
        .contains(&t)
        .then(|| vec3::add(p, vec3::scale(dir, t)))
}

fn tri_tri(x: &[V3; 3], y: &[V3; 3]) -> (f64, V3, V3, bool) {
    for (s, t) in [(x, y), (y, x)] {
        for k in 0..3 {
            if let Some(h) = seg_hits_tri(s[k], s[(k + 1) % 3], t) {
                return (0.0, h, h, true);
            }
        }
    }
    let mut best = (f64::INFINITY, x[0], y[0]);
    let mut keep = |p: V3, q: V3| {
        let d = vec3::len(vec3::sub(q, p));
        if d < best.0 {
            best = (d, p, q);
        }
    };
    for &p in x {
        keep(p, closest_on_tri(p, y));
    }
    for &q in y {
        keep(closest_on_tri(q, x), q);
    }
    for i in 0..3 {
        for j in 0..3 {
            let (p, q) = seg_seg(x[i], x[(i + 1) % 3], y[j], y[(j + 1) % 3]);
            keep(p, q);
        }
    }
    (best.0, best.1, best.2, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;

    fn opts(g: f64) -> FitOptions {
        FitOptions {
            min_gap_mm: g,
            min_vertical_gap_mm: None,
            layer_height_mm: Some(0.2),
            skip_fused: false,
            apart_mm: None,
        }
    }

    #[test]
    fn side_gap_below_the_clearance_is_reported() {
        let mut m = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        m.append(&build::box_mesh([10.15, 2.0, 0.0], [20.0, 8.0, 10.0]));
        let r = fit_check(&m, &opts(0.2)).unwrap();
        assert_eq!(r.parts.len(), 2);
        assert_eq!(r.gaps.len(), 1);
        let g = &r.gaps[0];
        assert_eq!(g.kind, GapKind::Horizontal);
        assert!((g.gap_mm - 0.15).abs() < 1e-9, "{}", g.gap_mm);
        assert!((g.to[0] - g.from[0] - 0.15).abs() < 1e-9);
        assert!(r.warnings[0].contains("0.15 mm apart side by side"));
        assert!(fit_check(&m, &opts(0.1)).unwrap().gaps.is_empty());
    }

    #[test]
    fn vertical_gap_uses_the_layer_height() {
        let mut m = build::box_mesh([0.0; 3], [10.0, 10.0, 5.0]);
        m.append(&build::box_mesh([2.0, 2.0, 5.15], [8.0, 8.0, 9.0]));
        let r = fit_check(&m, &opts(0.1)).unwrap();
        assert_eq!(r.gaps.len(), 1, "{r:?}");
        assert_eq!(r.gaps[0].kind, GapKind::Vertical);
        assert!((r.gaps[0].limit_mm - 0.2).abs() < 1e-12);
    }

    #[test]
    fn crossing_and_nested_parts_are_fused() {
        let mut m = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        m.append(&build::box_mesh([8.0, 8.0, 8.0], [14.0, 14.0, 14.0]));
        let r = fit_check(&m, &opts(0.2)).unwrap();
        assert_eq!(r.gaps.len(), 1);
        assert_eq!(r.gaps[0].kind, GapKind::Fused);
        let mut n = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        n.append(&build::box_mesh([3.0; 3], [6.0, 6.0, 6.0]));
        let r = fit_check(&n, &opts(0.2)).unwrap();
        assert_eq!(r.gaps.len(), 1);
        assert_eq!(r.gaps[0].kind, GapKind::Fused);
        let skip = FitOptions {
            skip_fused: true,
            ..opts(0.2)
        };
        assert!(fit_check(&n, &skip).unwrap().gaps.is_empty());
        let mut far = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        far.append(&build::box_mesh([30.0, 0.0, 0.0], [40.0, 10.0, 10.0]));
        assert!(fit_check(&far, &opts(0.2)).unwrap().gaps.is_empty());
    }

    #[test]
    fn bodies_keep_the_mesh_they_came_from() {
        // a small body first in one mesh, a large one in the next: indices follow the input, not body order
        let a = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        let mut b = build::box_mesh([10.0, 0.0, 0.0], [20.0, 10.0, 10.0]);
        b.append(&build::box_mesh([40.0, 0.0, 0.0], [41.0, 1.0, 1.0]));
        let r = fit_check_items(&[a, b], &opts(0.2)).unwrap();
        assert_eq!(r.parts.iter().map(|p| p.item).collect::<Vec<_>>(), vec![0, 1, 1]);
        assert_eq!(r.gaps.len(), 1);
        let [i, j] = r.gaps[0].parts;
        assert_eq!((r.parts[i].item, r.parts[j].item), (0, 1));
        assert_eq!(r.pieces, 2);
    }

    #[test]
    fn pieces_that_do_not_touch_are_reported_apart() {
        // a ring 0.76 mm off its foot, and a part joined to the foot through another
        let mut m = build::box_mesh([0.0; 3], [10.0, 10.0, 2.0]);
        m.append(&build::box_mesh([10.76, 0.0, 0.0], [16.0, 10.0, 8.0]));
        m.append(&build::box_mesh([0.0, 0.0, 2.0], [10.0, 10.0, 4.0]));
        let far = FitOptions {
            apart_mm: Some(1.0),
            skip_fused: true,
            ..opts(0.2)
        };
        let r = fit_check(&m, &far).unwrap();
        assert_eq!(r.pieces, 2);
        assert_eq!(r.gaps.len(), 1, "{r:?}");
        assert_eq!(r.gaps[0].kind, GapKind::Apart);
        assert!((r.gaps[0].gap_mm - 0.76).abs() < 1e-9);
        assert!(r.warnings[0].contains("print as separate pieces"));
        assert!(
            fit_check(&m, &opts(0.2))
                .unwrap()
                .gaps
                .iter()
                .all(|g| g.kind != GapKind::Apart)
        );
        let close = FitOptions {
            apart_mm: Some(0.5),
            ..far
        };
        assert!(fit_check(&m, &close).unwrap().gaps.is_empty());
    }

    #[test]
    fn the_grid_and_its_shortcuts_find_the_closest_pair_of_all() {
        // two faceted cylinders side by side (a gap, a near miss, and crossing), against every pair of triangles
        let w = crate::vec3::Frame::WORLD;
        for (dx, segments) in [(10.13, 131), (10.6, 127), (9.6, 113)] {
            let a = build::cylinder(&w, 5.0, 0.0, 6.0, 120);
            let mut b = build::cylinder(&w, 5.0, 0.3, 5.0, segments);
            for p in &mut b.positions {
                p[0] += dx;
            }
            let (ba, bb) = (a.bounds().unwrap(), b.bounds().unwrap());
            let reach = 1.0;
            let mut every = f64::INFINITY;
            for &x in &a.triangles {
                for &y in &b.triangles {
                    every = every.min(tri_tri(&a.corners(x), &b.corners(y)).0);
                }
            }
            match pair_gap(&a, &b, &ba, &bb, reach) {
                Some(c) => assert!((c.d - every).abs() < 1e-12, "{dx}: {} against {every}", c.d),
                None => assert!(every >= reach, "{dx}: none against {every}"),
            }
        }
    }

    #[test]
    fn captive_pin_in_a_closed_socket() {
        let w = crate::vec3::Frame::WORLD;
        let mut m = build::box_mesh([-10.0, -10.0, 0.0], [10.0, 10.0, 10.0]);
        let mut cavity = build::cylinder(&w, 5.1, 2.0, 8.0, 96);
        cavity.flip();
        m.append(&cavity);
        m.append(&build::cylinder(&w, 5.0, 3.0, 7.0, 96));
        let r = fit_check(&m, &opts(0.2)).unwrap();
        assert_eq!(r.parts.len(), 2, "{:?}", r.parts);
        assert_eq!(r.gaps.len(), 1, "{r:?}");
        assert!((r.gaps[0].gap_mm - 0.1).abs() < 0.01, "{}", r.gaps[0].gap_mm);
        assert_eq!(r.gaps[0].kind, GapKind::Horizontal);
        assert!(fit_check(&m, &opts(0.05)).unwrap().gaps.is_empty());
    }
}
