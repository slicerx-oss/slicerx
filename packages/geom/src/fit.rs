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
use manifold_rust::linalg::{Vec2, Vec3};
use manifold_rust::robust::exact::Sign;
use manifold_rust::robust::exact::filtered::{orient2d, orient3d};
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
    /// per two bodies, the closest side-by-side pair and the closest pair above and below, each against its own limit;
    /// without it, the one closest pair, so a tight vertical gap can hide behind a wider side gap
    #[serde(default)]
    pub by_direction: bool,
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
            let found = closest_pairs(a, b, ba, bb, reach, opts.by_direction);
            if found.iter().any(|c| classify(c) == GapKind::Fused) {
                let (ri, rj) = (root(&mut piece, i), root(&mut piece, j));
                piece[rj] = ri;
            }
            let mut tight = false;
            for c in &found {
                let kind = classify(c);
                if kind == GapKind::Fused && opts.skip_fused {
                    continue;
                }
                let limit = if kind == GapKind::Vertical { gv } else { g };
                if kind == GapKind::Fused || c.d < limit {
                    tight = true;
                    gaps.push(Gap {
                        parts: [i, j],
                        gap_mm: c.d,
                        limit_mm: limit,
                        kind,
                        from: c.p,
                        to: c.q,
                    });
                }
            }
            // two bodies with no tight gap and no touch: their closest pair, when it is near
            let closest = found.iter().min_by(|x, y| x.d.total_cmp(&y.d));
            if let (Some(a), Some(c)) = (apart, closest)
                && !tight
                && classify(c) != GapKind::Fused
                && c.d < a
            {
                loose.push(Gap {
                    parts: [i, j],
                    gap_mm: c.d,
                    limit_mm: a,
                    kind: GapKind::Apart,
                    from: c.p,
                    to: c.q,
                });
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
    if runs_vertical(c.p, c.q) {
        GapKind::Vertical
    } else {
        GapKind::Horizontal
    }
}

/// whether the gap from `p` to `q` runs more up and down than sideways
fn runs_vertical(p: V3, q: V3) -> bool {
    let v = vec3::sub(q, p);
    v[2].abs() > v[0].m_hypot(v[1])
}

/// the closest pair of points of two bodies however far apart, and whether they cross or one holds the other
pub(crate) fn closest(a: &TriMesh, b: &TriMesh) -> Option<(f64, V3, V3, bool)> {
    let (ba, bb) = (a.bounds()?, b.bounds()?);
    // two corners found by walking nearest corner to nearest corner bound the gap from above, so the search keeps
    // only the triangles that can beat them
    let nearest = |m: &TriMesh, to: V3| {
        m.positions.iter().copied().min_by(|x, y| {
            let d2 = |v: V3| {
                let d = vec3::sub(v, to);
                vec3::dot(d, d)
            };
            d2(*x).total_cmp(&d2(*y))
        })
    };
    let mut q = bb.center();
    let mut p = q;
    for _ in 0..4 {
        p = nearest(a, q)?;
        q = nearest(b, p)?;
    }
    let reach = vec3::len(vec3::sub(p, q)) * (1.0 + 1e-9) + 1e-9;
    // bodies that touch or cross are settled in a thin band first, where few triangle pairs are tried
    [reach.min(0.05), reach]
        .into_iter()
        .find_map(|r| closest_pairs(a, b, &ba, &bb, r, false).into_iter().next())
        .map(|c| (c.d, c.p, c.q, c.fused))
}

/// the closest pair of points of two bodies within `reach`, or the pair where they touch
#[cfg(test)]
fn pair_gap(a: &TriMesh, b: &TriMesh, ba: &Aabb, bb: &Aabb, reach: f64) -> Option<Closest> {
    closest_pairs(a, b, ba, bb, reach, false).into_iter().next()
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "grid coordinates are clamped to the grid"
)]
/// The closest pair of points of two bodies within `reach`, or the pair where they touch. With `by_direction`, the
/// closest pair that runs sideways and the closest that runs up and down, each found on its own (one pair when they
/// touch).
fn closest_pairs(
    a: &TriMesh,
    b: &TriMesh,
    ba: &Aabb,
    bb: &Aabb,
    reach: f64,
    by_direction: bool,
) -> Vec<Closest> {
    if let (Some(&pa), Some(&pb)) = (a.positions.first(), b.positions.first())
        && ((contains(bb, ba) && convex::point_inside_mesh(b, pa))
            || (contains(ba, bb) && convex::point_inside_mesh(a, pb)))
    {
        return vec![Closest {
            d: 0.0,
            p: pa,
            q: pa,
            fused: true,
        }];
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
        return Vec::new();
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
    // the closest pair so far: sideways, then up and down when they are kept apart
    let mut best: [Option<Closest>; 2] = [None, None];
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
                        // apart than every closest pair so far, or than the reach, cannot take a place (with room for
                        // rounding)
                        let kept = if by_direction { &best[..] } else { &best[..1] };
                        let far = kept
                            .iter()
                            .map(|b| b.as_ref().map_or(f64::INFINITY, |b| b.d))
                            .fold(0.0, f64::max)
                            .min(reach);
                        let bound = far + 1e-9 * far.max(1.0);
                        if box_gap2(&cb, &t) > bound * bound {
                            continue;
                        }
                        let (d, p, q, crosses) = tri_tri(&c, &t);
                        // nothing is closer than touching: the first such pair is the answer
                        if d == 0.0 {
                            return vec![Closest {
                                d,
                                p,
                                q,
                                fused: crosses,
                            }];
                        }
                        let k = usize::from(by_direction && runs_vertical(p, q));
                        if best[k].as_ref().is_none_or(|b| d < b.d) {
                            best[k] = Some(Closest {
                                d,
                                p,
                                q,
                                fused: crosses,
                            });
                        }
                    }
                }
            }
        }
    }
    best.into_iter()
        .flatten()
        .filter(|b| b.d < reach || b.fused)
        .collect()
}

/// The smallest distance between two bodies, mm: 0 where they touch or one holds the other.
#[cfg(feature = "cad")]
pub(crate) fn gap_mm(a: &TriMesh, b: &TriMesh) -> f64 {
    let (Some(ba), Some(bb)) = (a.bounds(), b.bounds()) else {
        return 0.0;
    };
    // no pair of points is closer than the boxes, so the search starts there and reaches twice as far each time
    let floor = vec3::len([0, 1, 2].map(|k| (ba.min[k] - bb.max[k]).max(bb.min[k] - ba.max[k]).max(0.0)));
    let most = floor + ba.diagonal() + bb.diagonal();
    let mut reach = 2.0 * floor + 0.1;
    while reach < 4.0 * most + 1.0 {
        if let Some(c) = closest_pairs(a, b, &ba, &bb, reach, false).first() {
            return if c.fused { 0.0 } else { c.d };
        }
        reach *= 2.0;
    }
    floor
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
pub(crate) fn closest_on_tri(p: V3, [a, b, c]: &[V3; 3]) -> V3 {
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

/// the corner of `v` as the exact predicates take it
fn pt(v: V3) -> Vec3 {
    Vec3::new(v[0], v[1], v[2])
}

/// Where the closed segment `p q` meets the closed triangle `t`, given the exact sides of `p` and `q` against the
/// triangle's plane (`orient3d` of the triangle and the point). Whether they meet is decided by exact orientation
/// signs only, so facets a rounding error out of one plane are never taken for touching; the point given back is
/// rounded. A triangle with no area meets nothing here: its neighbors, and the closest points, cover it.
fn seg_hits_tri(p: V3, q: V3, sp: Sign, sq: Sign, t: &[V3; 3]) -> Option<V3> {
    if sp == sq && sp != Sign::Zero {
        return None;
    }
    if sp == Sign::Zero && sq == Sign::Zero {
        return coplanar_hit(p, q, t);
    }
    // the line crosses the plane once: the crossing is in the closed triangle when no two of its edges see the line
    // turn opposite ways
    let [a, b, c] = t.map(pt);
    let (pp, pq) = (pt(p), pt(q));
    let turns = [
        orient3d(pp, pq, a, b),
        orient3d(pp, pq, b, c),
        orient3d(pp, pq, c, a),
    ];
    if turns.contains(&Sign::Pos) && turns.contains(&Sign::Neg) {
        return None;
    }
    let n = vec3::cross(vec3::sub(t[1], t[0]), vec3::sub(t[2], t[0]));
    let (dp, dq) = (vec3::dot(n, vec3::sub(p, t[0])), vec3::dot(n, vec3::sub(q, t[0])));
    // the rounded heights can agree where the exact sides differ: then either end will do as the point
    let rise = dp - dq;
    let s = if rise == 0.0 {
        0.0
    } else {
        (dp / rise).clamp(0.0, 1.0)
    };
    Some(vec3::add(p, vec3::scale(vec3::sub(q, p), s)))
}

/// Where the closed segment `p q`, in the plane of triangle `t`, meets it, decided exactly in a projection that keeps
/// the triangle's area (dropping an axis its plane is not parallel to keeps every side test's sign).
fn coplanar_hit(p: V3, q: V3, t: &[V3; 3]) -> Option<V3> {
    let n = vec3::cross(vec3::sub(t[1], t[0]), vec3::sub(t[2], t[0]));
    let mut axes = [0, 1, 2];
    axes.sort_by(|&i, &j| n[j].abs().total_cmp(&n[i].abs()));
    let (drop, turn) = axes.into_iter().find_map(|k| {
        let flat = |v: V3| Vec2::new(v[(k + 1) % 3], v[(k + 2) % 3]);
        let s = orient2d(flat(t[0]), flat(t[1]), flat(t[2]));
        (s != Sign::Zero).then_some((k, s))
    })?;
    let flat = |v: V3| Vec2::new(v[(drop + 1) % 3], v[(drop + 2) % 3]);
    let [a, b, c] = t.map(flat);
    let edges = [(a, b), (b, c), (c, a)];
    let inside = |x: Vec2| edges.iter().all(|&(u, v)| orient2d(u, v, x) != turn.flip());
    if inside(flat(p)) {
        return Some(p);
    }
    if inside(flat(q)) {
        return Some(q);
    }
    let (fp, fq) = (flat(p), flat(q));
    (0..3)
        .find(|&k| segments_meet(fp, fq, edges[k].0, edges[k].1))
        .map(|k| seg_seg(p, q, t[k], t[(k + 1) % 3]).0)
}

/// whether closed segments `p q` and `u v` in a plane meet, by exact orientation signs
fn segments_meet(p: Vec2, q: Vec2, u: Vec2, v: Vec2) -> bool {
    let (su, sv) = (orient2d(p, q, u), orient2d(p, q, v));
    let (sp, sq) = (orient2d(u, v, p), orient2d(u, v, q));
    if (su == sv && su != Sign::Zero) || (sp == sq && sp != Sign::Zero) {
        return false;
    }
    if [su, sv, sp, sq].iter().all(|&s| s == Sign::Zero) {
        // on one line: they meet where their spans overlap on both axes (exact comparisons)
        let over = |a: f64, b: f64, c: f64, d: f64| a.max(b) >= c.min(d) && c.max(d) >= a.min(b);
        return over(p.x, q.x, u.x, v.x) && over(p.y, q.y, u.y, v.y);
    }
    true
}

#[cfg(test)]
thread_local! {
    /// triangle pairs measured on this thread, so tests can bound a fit check's work
    static TRI_PAIRS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The closest points of two triangles and their distance, or a point where they touch or cross (distance 0, true).
/// Touching is decided exactly (`seg_hits_tri`); the distances are rounded.
fn tri_tri(x: &[V3; 3], y: &[V3; 3]) -> (f64, V3, V3, bool) {
    #[cfg(test)]
    TRI_PAIRS.with(|n| n.set(n.get() + 1));
    let side = |t: &[V3; 3], v: V3| orient3d(pt(t[0]), pt(t[1]), pt(t[2]), pt(v));
    let sy = y.map(|v| side(x, v));
    // one triangle wholly on one side of the other's plane: no edge of either meets the other
    let apart = |s: &[Sign; 3]| s[0] != Sign::Zero && s[0] == s[1] && s[1] == s[2];
    if !apart(&sy) {
        let sx = x.map(|v| side(y, v));
        if !apart(&sx) {
            for (s, signs, t) in [(x, &sx, y), (y, &sy, x)] {
                for k in 0..3 {
                    let k1 = (k + 1) % 3;
                    if let Some(h) = seg_hits_tri(s[k], s[k1], signs[k], signs[k1], t) {
                        return (0.0, h, h, true);
                    }
                }
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
            by_direction: false,
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

    /// a pin 0.35 mm from its socket all round, side and above and below, by the json options a client sends
    fn uniform_pin(by_direction: bool) -> FitReport {
        let w = crate::vec3::Frame::WORLD;
        let mut m = build::box_mesh([-10.0, -10.0, 0.0], [10.0, 10.0, 10.0]);
        let mut cavity = build::cylinder(&w, 5.35, 1.65, 8.35, 96);
        cavity.flip();
        m.append(&cavity);
        m.append(&build::cylinder(&w, 5.0, 2.0, 8.0, 96));
        fit_check(&m, &side_and_vertical(by_direction, None)).unwrap()
    }

    /// 0.3 mm side by side and 0.4 mm above or below, as the json a client sends
    fn side_and_vertical(by_direction: bool, apart_mm: Option<f64>) -> FitOptions {
        serde_json::from_value(serde_json::json!({
            "minGapMm": 0.3, "minVerticalGapMm": 0.4, "layerHeightMm": 0.2, "byDirection": by_direction, "apartMm": apart_mm
        }))
        .unwrap()
    }

    #[test]
    fn a_tight_vertical_gap_is_not_hidden_by_a_wider_side_gap() {
        // the side gap (0.347 mm across the facets) is the closest pair and clears 0.3 mm; the 0.35 mm above and
        // below the pin is under 0.4 mm and closes when sliced
        let r = uniform_pin(true);
        assert_eq!(r.pieces, 2, "{r:?}");
        // one gap per two bodies and direction: the closer of the two 0.35 mm gaps over and under the pin
        assert_eq!(r.gaps.len(), 1, "{r:?}");
        let g = &r.gaps[0];
        assert_eq!(g.kind, GapKind::Vertical);
        assert!((g.gap_mm - 0.35).abs() < 1e-9, "{}", g.gap_mm);
        assert!((g.limit_mm - 0.4).abs() < 1e-12);
        assert!((g.to[2] - g.from[2]).abs() > 0.34, "{g:?}");
        assert!(
            r.warnings[0].contains("0.35 mm apart vertically, less than 0.40 mm"),
            "{:?}",
            r.warnings
        );
        // without byDirection, the one closest pair per two bodies as before: the side gap, which clears its limit
        assert!(uniform_pin(false).gaps.is_empty());
    }

    #[test]
    fn by_direction_reports_each_tight_direction_and_one_closest_pair_apart() {
        // side 0.2 under 0.3 and above 0.6 clear of 0.4: only the side gap; both clear: the closest pair, apart
        let mut m = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        m.append(&build::box_mesh([10.2, 0.0, 0.0], [12.0, 10.0, 10.0]));
        m.append(&build::box_mesh([0.0, 0.0, 10.6], [10.0, 10.0, 12.0]));
        let r = fit_check(&m, &side_and_vertical(true, Some(2.0))).unwrap();
        let kinds: Vec<_> = r.gaps.iter().map(|g| (g.parts, g.kind)).collect();
        assert!(kinds.contains(&([0, 1], GapKind::Horizontal)), "{kinds:?}");
        assert!(kinds.contains(&([0, 2], GapKind::Apart)), "{kinds:?}");
        assert_eq!(
            r.gaps.iter().filter(|g| g.parts == [0, 1]).count(),
            1,
            "{kinds:?}"
        );
        assert_eq!(
            r.gaps.iter().filter(|g| g.parts == [0, 2]).count(),
            1,
            "{kinds:?}"
        );
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

    /// The hinge-box pair from a fit check that said the lid touched the base: a base knuckle facet (x 4 to 16) and the
    /// lid knuckle facet beside it (x 16.6 to 43.4), on one cylinder of radius 1.8, 0.6 mm apart along the axis. `z` is
    /// one corner height, as drawn (bits 403dcd3900000000) or read one ulp low (403dcd38ffffffff).
    fn hinge_pair(z: f64) -> ([V3; 3], [V3; 3]) {
        let f = f64::from_bits;
        let (y0, z0) = (f(0x4044_09a0_a000_0000), f(0x403d_2ae5_6000_0000));
        let y1 = f(0x4044_2607_2000_0000);
        let (lid0, lid1) = (f(0x4030_9999_a000_0000), f(0x4045_b333_4000_0000));
        (
            [[16.0, y0, z0], [16.0, y1, z], [4.0, y1, z]],
            [[lid0, y0, z0], [lid1, y0, z0], [lid0, y1, z]],
        )
    }

    #[test]
    fn facets_of_one_cylinder_apart_along_it_do_not_touch() {
        // the facets are in one plane with either z. With z one ulp low, the edge test once found a lid edge in the base
        // facet: its parallel test compared a determinant to a fixed 1e-18, rounding made it -4.4e-16 where it is 0,
        // and the ratios of that noise (u -0, v 1, t 1) put the lid corner on the facet, so fit.check said 0.0 mm
        let gap = f64::from_bits(0x4030_9999_a000_0000) - 16.0;
        for bits in [0x403d_cd39_0000_0000_u64, 0x403d_cd38_ffff_ffff] {
            let (base, lid) = hinge_pair(f64::from_bits(bits));
            for (x, y) in [(&base, &lid), (&lid, &base)] {
                let (d, p, q, crosses) = tri_tri(x, y);
                assert!(!crosses, "{bits:016x}: a contact at {p:?}");
                assert!(
                    (d - gap).abs() < 1e-9,
                    "{bits:016x}: {d} mm from {p:?} to {q:?}, not {gap}"
                );
            }
            let a = TriMesh {
                positions: base.to_vec(),
                triangles: vec![[0, 1, 2]],
                faces: None,
            };
            let b = TriMesh {
                positions: lid.to_vec(),
                triangles: vec![[0, 1, 2]],
                faces: None,
            };
            let (d, _, _, fused) = closest(&a, &b).unwrap();
            assert!(!fused && (d - gap).abs() < 1e-9, "{bits:016x}: {d}");
        }
    }

    #[test]
    fn a_few_ulps_never_make_a_contact_of_coplanar_facets_apart() {
        // every corner of the pair nudged by up to two ulps each way: the facets stay 0.6 mm apart, never touching
        let nudge = |v: f64, k: i64| f64::from_bits(v.to_bits().wrapping_add_signed(k));
        let (base, lid) = hinge_pair(f64::from_bits(0x403d_cd39_0000_0000));
        let gap = lid[0][0] - base[0][0];
        let mut tried = 0;
        for c in 0..3 {
            for k in -2..=2 {
                for (which, axis) in [(0, 1), (0, 2), (1, 1), (1, 2)] {
                    let (mut x, mut y) = (base, lid);
                    let t = if which == 0 { &mut x } else { &mut y };
                    t[c][axis] = nudge(t[c][axis], k);
                    let (d, p, _, crosses) = tri_tri(&x, &y);
                    assert!(
                        !crosses && (d - gap).abs() < 1e-9,
                        "corner {c} axis {axis} by {k}: {d} at {p:?}"
                    );
                    tried += 1;
                }
            }
        }
        assert_eq!(tried, 60);
    }

    #[test]
    fn coplanar_contacts_still_touch() {
        // touching within the plane still counts: an edge on an edge, a corner on an edge, and overlapping facets
        let a = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        for b in [
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]],
            [[0.5, 0.5, 0.0], [1.0, 1.0, 0.0], [2.0, 0.5, 0.0]],
            [[0.2, 0.2, 0.0], [3.0, 0.2, 0.0], [0.2, 3.0, 0.0]],
            [[-1.0, 0.25, 0.0], [2.0, 0.25, 0.0], [2.0, 0.3, 0.0]],
        ] {
            let (d, _, _, crosses) = tri_tri(&a, &b);
            assert!(crosses && d == 0.0, "{b:?}: {d}");
        }
        // and the same facet moved 0.6 off its edge does not
        let b = [[1.3, 0.0, 0.0], [0.6, 0.7, 0.0], [1.6, 1.0, 0.0]];
        let (d, _, _, crosses) = tri_tri(&a, &b);
        assert!(!crosses && d > 0.2, "{d}");
    }

    #[test]
    fn a_hinge_with_one_ulp_low_corners_is_two_pieces_in_bounded_work() {
        // two knuckles on one axis and radius, 0.6 mm apart: one ring of corners read one ulp low at a time
        let along_x = crate::vec3::Frame {
            origin: [0.0, 40.0, 27.5],
            u: [0.0, 1.0, 0.0],
            v: [0.0, 0.0, 1.0],
            w: [1.0, 0.0, 0.0],
        };
        let knuckles = || {
            (
                build::cylinder(&along_x, 1.8, 4.0, 16.0, 24),
                build::cylinder(&along_x, 1.8, 16.6, 43.4, 24),
            )
        };
        let (a, _) = knuckles();
        let rings: Vec<(u64, u64)> = {
            let mut r: Vec<(u64, u64)> = a
                .positions
                .iter()
                .map(|p| (p[1].to_bits(), p[2].to_bits()))
                .collect();
            r.sort_unstable();
            r.dedup();
            r
        };
        assert_eq!(rings.len(), 24);
        let opts: FitOptions = serde_json::from_value(serde_json::json!({
            "minGapMm": 0.4, "minVerticalGapMm": 0.6, "layerHeightMm": 0.2, "byDirection": true, "apartMm": 2
        }))
        .unwrap();
        for &(y, z) in &rings {
            let (mut a, mut b) = knuckles();
            for p in a.positions.iter_mut().chain(b.positions.iter_mut()) {
                if (p[1].to_bits(), p[2].to_bits()) == (y, z) {
                    p[2] = f64::from_bits(z - 1);
                }
            }
            TRI_PAIRS.with(|n| n.set(0));
            let r = fit_check_items(&[a.clone(), b.clone()], &opts).unwrap();
            let tried = TRI_PAIRS.with(|n| n.replace(0));
            assert_eq!(r.pieces, 2, "ring ({y:016x}, {z:016x}): {r:?}");
            assert!(
                r.gaps.iter().all(|g| g.kind != GapKind::Fused && g.gap_mm > 0.59),
                "{r:?}"
            );
            // the work: no more triangle pairs measured than the pairs whose boxes are in reach (2 mm here), which
            // is what the search may not skip; a false touch used to end it early instead
            let reach: f64 = 2.0;
            let in_reach = a
                .triangles
                .iter()
                .flat_map(|&x| b.triangles.iter().map(move |&y| (x, y)))
                .filter(|&(x, y)| {
                    let c = a.corners(x);
                    box_gap2(&[0, 1, 2].map(|k| span(&c, k)), &b.corners(y)) <= reach * reach
                })
                .count();
            assert!(
                tried > 0 && tried <= in_reach,
                "{tried} pairs measured, {in_reach} in reach"
            );
        }
    }
}
