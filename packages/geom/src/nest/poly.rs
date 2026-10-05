// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! polygon helpers for nesting: booleans, offsets, conservative simplification,
//! convex pieces and minkowski sums
// vertex and piece indices are built and checked in this module
#![allow(clippy::indexing_slicing)]

use crate::fm::Fm;
use crate::poly2d::{self, Polygon};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::overlay::FloatOverlay;
use i_overlay::float::simplify::SimplifyShape;
use std::collections::{BTreeMap, BTreeSet};

pub type Pt = [f64; 2];
pub type Ring = Vec<Pt>;
/// outer ring counterclockwise first, then holes clockwise
pub type Shape = Vec<Ring>;
pub type Region = Vec<Shape>;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bbox {
    pub min: Pt,
    pub max: Pt,
}

impl Bbox {
    pub const EMPTY: Self = Self {
        min: [f64::INFINITY; 2],
        max: [f64::NEG_INFINITY; 2],
    };

    pub fn add(&mut self, p: Pt) {
        self.min = [self.min[0].min(p[0]), self.min[1].min(p[1])];
        self.max = [self.max[0].max(p[0]), self.max[1].max(p[1])];
    }

    #[must_use]
    pub fn merge(&self, o: &Self) -> Self {
        Self {
            min: [self.min[0].min(o.min[0]), self.min[1].min(o.min[1])],
            max: [self.max[0].max(o.max[0]), self.max[1].max(o.max[1])],
        }
    }

    pub fn is_empty(&self) -> bool {
        !(self.min[0] <= self.max[0] && self.min[1] <= self.max[1])
    }

    pub fn w(&self) -> f64 {
        self.max[0] - self.min[0]
    }

    pub fn h(&self) -> f64 {
        self.max[1] - self.min[1]
    }

    pub fn area(&self) -> f64 {
        if self.is_empty() { 0.0 } else { self.w() * self.h() }
    }

    pub fn center(&self) -> Pt {
        [
            f64::midpoint(self.min[0], self.max[0]),
            f64::midpoint(self.min[1], self.max[1]),
        ]
    }

    #[must_use]
    pub fn shifted(&self, d: Pt) -> Self {
        Self {
            min: [self.min[0] + d[0], self.min[1] + d[1]],
            max: [self.max[0] + d[0], self.max[1] + d[1]],
        }
    }

    pub fn overlaps(&self, o: &Self) -> bool {
        self.min[0] < o.max[0] && o.min[0] < self.max[0] && self.min[1] < o.max[1] && o.min[1] < self.max[1]
    }
}

pub fn bbox(r: &Region) -> Bbox {
    let mut b = Bbox::EMPTY;
    for p in r.iter().flatten().flatten() {
        b.add(*p);
    }
    b
}

pub fn ring_bbox(r: &[Pt]) -> Bbox {
    let mut b = Bbox::EMPTY;
    for p in r {
        b.add(*p);
    }
    b
}

pub fn area(r: &Region) -> f64 {
    r.iter()
        .map(|s| s.iter().map(|ring| poly2d::signed_area(ring)).sum::<f64>())
        .sum()
}

pub fn vertex_count(r: &Region) -> usize {
    r.iter().flatten().map(Vec::len).sum()
}

pub fn translate(r: &Region, d: Pt) -> Region {
    r.iter()
        .map(|s| {
            s.iter()
                .map(|ring| ring.iter().map(|p| [p[0] + d[0], p[1] + d[1]]).collect())
                .collect()
        })
        .collect()
}

/// sine and cosine of a turn in degrees, exact at quarter turns
pub fn turn(deg: f64) -> (f64, f64) {
    let d = deg.rem_euclid(360.0);
    #[allow(clippy::float_cmp, reason = "exact quarter turns")]
    if d == 0.0 {
        (0.0, 1.0)
    } else if d == 90.0 {
        (1.0, 0.0)
    } else if d == 180.0 {
        (0.0, -1.0)
    } else if d == 270.0 {
        (-1.0, 0.0)
    } else {
        d.to_radians().m_sin_cos()
    }
}

pub fn rotate_pt(p: Pt, sc: (f64, f64)) -> Pt {
    let (s, c) = sc;
    [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
}

pub fn rotate_ring(r: &[Pt], sc: (f64, f64)) -> Ring {
    r.iter().map(|p| rotate_pt(*p, sc)).collect()
}

pub fn rotate(r: &Region, sc: (f64, f64)) -> Region {
    r.iter()
        .map(|s| s.iter().map(|ring| rotate_ring(ring, sc)).collect())
        .collect()
}

fn normalized(shapes: Vec<Vec<Ring>>, min_area: f64) -> Region {
    shapes
        .into_iter()
        .filter_map(|mut s| {
            s.retain(|ring| ring.len() >= 3);
            let first = s.first()?;
            if poly2d::signed_area(first) < 0.0 {
                for ring in &mut s {
                    ring.reverse();
                }
            }
            let outer_area = poly2d::signed_area(s.first()?);
            if outer_area <= min_area {
                return None;
            }
            let mut out = Vec::with_capacity(s.len());
            let mut it = s.into_iter();
            out.push(it.next()?);
            for mut h in it {
                if poly2d::signed_area(&h) > 0.0 {
                    h.reverse();
                }
                if poly2d::signed_area(&h).abs() > min_area {
                    out.push(h);
                }
            }
            Some(out)
        })
        .collect()
}

/// union of rings under the nonzero rule; outer rings must be counterclockwise and holes clockwise
pub fn union_rings(rings: &[Ring]) -> Region {
    if rings.is_empty() {
        return Vec::new();
    }
    normalized(rings.simplify_shape(FillRule::NonZero), 1e-9)
}

pub fn union(r: &Region) -> Region {
    let rings: Vec<Ring> = r.iter().flatten().cloned().collect();
    union_rings(&rings)
}

pub fn difference(subject: &Region, clip: &Region) -> Region {
    if subject.is_empty() {
        return Vec::new();
    }
    if clip.is_empty() {
        return subject.clone();
    }
    let out =
        FloatOverlay::with_subj_and_clip(subject, clip).overlay(OverlayRule::Difference, FillRule::NonZero);
    normalized(out, 1e-9)
}

pub fn intersection(a: &Region, b: &Region) -> Region {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let out = FloatOverlay::with_subj_and_clip(a, b).overlay(OverlayRule::Intersect, FillRule::NonZero);
    normalized(out, 1e-9)
}

/// grows (or shrinks) a region by `d` mm with round corners no more than `arc_tol` off the true arc
pub fn offset(r: &Region, d: f64, arc_tol: f64) -> Region {
    use i_overlay::mesh::float::outline::offset::OutlineOffset;
    use i_overlay::mesh::float::style::{LineJoin, OutlineStyle};
    if r.is_empty() || d.abs() < 1e-9 {
        return r.clone();
    }
    let step = (2.0 * (1.0 - (arc_tol / d.abs()).min(1.0)).m_acos()).max(0.05);
    let style = OutlineStyle::new(d).line_join(LineJoin::Round(step));
    normalized(r.outline(&style), 1e-9)
}

fn dist_to_segment(p: Pt, a: Pt, b: Pt) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (qx, qy) = (a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
    (qx * qx + qy * qy).sqrt()
}

/// douglas peucker on a closed ring, iterative
pub fn simplify_ring(ring: &[Pt], tol: f64) -> Ring {
    let n = ring.len();
    if n <= 4 || tol <= 0.0 {
        return ring.to_vec();
    }
    // split at the vertex farthest from the first one so both halves are open chains
    let a = ring[0];
    let far = (1..n)
        .max_by(|&i, &j| {
            let di = (ring[i][0] - a[0]).m_powi(2) + (ring[i][1] - a[1]).m_powi(2);
            let dj = (ring[j][0] - a[0]).m_powi(2) + (ring[j][1] - a[1]).m_powi(2);
            di.total_cmp(&dj).then(j.cmp(&i))
        })
        .unwrap_or(n / 2);
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[far] = true;
    let mut stack = vec![(0usize, far), (far, n)];
    while let Some((s, e)) = stack.pop() {
        if e <= s + 1 {
            continue;
        }
        let pe = ring[e % n];
        let mut best = (0.0, 0usize);
        for (i, p) in ring.iter().enumerate().take(e).skip(s + 1) {
            let d = dist_to_segment(*p, ring[s], pe);
            if d > best.0 {
                best = (d, i);
            }
        }
        if best.0 > tol {
            keep[best.1] = true;
            stack.push((s, best.1));
            stack.push((best.1, e));
        }
    }
    ring.iter()
        .zip(&keep)
        .filter(|(_, k)| **k)
        .map(|(p, _)| *p)
        .collect()
}

/// a simpler region that still covers `r`: grown by `tol`, then simplified by `tol`
pub fn cover(r: &Region, tol: f64) -> Region {
    if tol <= 0.0 {
        return union(r);
    }
    let grown = offset(r, tol, tol * 0.25);
    let rings: Vec<Ring> = grown
        .iter()
        .flatten()
        .map(|ring| simplify_ring(ring, tol))
        .filter(|ring| ring.len() >= 3)
        .collect();
    union_rings(&rings)
}

pub fn cross(o: Pt, a: Pt, b: Pt) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// convex hull, counterclockwise, no collinear points
pub fn hull(pts: &[Pt]) -> Ring {
    let mut p: Vec<Pt> = pts.to_vec();
    p.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    p.dedup();
    if p.len() < 3 {
        return p;
    }
    let mut lower: Vec<Pt> = Vec::with_capacity(p.len());
    for q in &p {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], *q) <= 0.0 {
            lower.pop();
        }
        lower.push(*q);
    }
    let mut upper: Vec<Pt> = Vec::with_capacity(p.len());
    for q in p.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], *q) <= 0.0 {
            upper.pop();
        }
        upper.push(*q);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// splits a region into convex pieces: ear clipping, then hertel mehlhorn merging
pub fn convex_pieces(r: &Region) -> Vec<Ring> {
    let mut out = Vec::new();
    for s in r {
        let Some(outer) = s.first() else { continue };
        let poly = Polygon {
            outer: outer.clone(),
            holes: s.iter().skip(1).cloned().collect(),
        };
        let pts: Vec<Pt> = poly.vertices().collect();
        let Ok(tris) = poly2d::triangulate(&poly) else {
            out.push(hull(outer));
            continue;
        };
        out.extend(merge_triangles(&pts, &tris));
    }
    out
}

fn merge_triangles(pts: &[Pt], tris: &[[u32; 3]]) -> Vec<Ring> {
    let mut pieces: Vec<Option<Vec<u32>>> = Vec::with_capacity(tris.len());
    for t in tris {
        let (a, b, c) = (pts[t[0] as usize], pts[t[1] as usize], pts[t[2] as usize]);
        let o = cross(a, b, c);
        if o.abs() < 1e-12 {
            continue;
        }
        pieces.push(Some(if o > 0.0 {
            vec![t[0], t[1], t[2]]
        } else {
            vec![t[0], t[2], t[1]]
        }));
    }
    let mut owner: BTreeMap<(u32, u32), usize> = BTreeMap::new();
    let mut shared: BTreeSet<(u32, u32)> = BTreeSet::new();
    for (i, p) in pieces.iter().enumerate() {
        let Some(p) = p else { continue };
        for k in 0..p.len() {
            let e = (p[k], p[(k + 1) % p.len()]);
            if owner.insert(e, i).is_some() {
                shared.insert(e);
            }
        }
    }
    let diagonals: Vec<(u32, u32)> = owner
        .keys()
        .filter(|&&(a, b)| a < b && owner.contains_key(&(b, a)))
        .copied()
        .collect();
    for (a, b) in diagonals {
        if shared.contains(&(a, b)) || shared.contains(&(b, a)) {
            continue;
        }
        let (Some(&pi), Some(&qi)) = (owner.get(&(a, b)), owner.get(&(b, a))) else {
            continue;
        };
        if pi == qi {
            continue;
        }
        let (Some(p), Some(q)) = (pieces[pi].as_ref(), pieces[qi].as_ref()) else {
            continue;
        };
        // p holds a->b, q holds b->a; walk p from b round to a, then q from a round to b
        let Some(ia) = p.iter().position(|&v| v == a) else {
            continue;
        };
        let Some(jb) = q.iter().position(|&v| v == b) else {
            continue;
        };
        let mut merged: Vec<u32> = Vec::with_capacity(p.len() + q.len() - 2);
        for k in 0..p.len() {
            merged.push(p[(ia + 1 + k) % p.len()]);
        }
        for k in 2..q.len() {
            merged.push(q[(jb + k) % q.len()]);
        }
        let n = merged.len();
        let convex_at = |v: u32| {
            merged.iter().enumerate().filter(|&(_, &x)| x == v).all(|(i, _)| {
                let prev = pts[merged[(i + n - 1) % n] as usize];
                let next = pts[merged[(i + 1) % n] as usize];
                cross(prev, pts[v as usize], next) >= -1e-9
            })
        };
        if !(convex_at(a) && convex_at(b)) {
            continue;
        }
        owner.remove(&(a, b));
        owner.remove(&(b, a));
        for k in 0..n {
            owner.insert((merged[k], merged[(k + 1) % n]), pi);
        }
        pieces[pi] = Some(merged);
        pieces[qi] = None;
    }
    pieces
        .into_iter()
        .flatten()
        .map(|p| hull(&p.iter().map(|&i| pts[i as usize]).collect::<Vec<_>>()))
        .filter(|r| r.len() >= 3)
        .collect()
}

/// sum of two convex rings as the hull of the vertex sums
pub fn minkowski_convex(a: &[Pt], b: &[Pt]) -> Ring {
    let mut sums = Vec::with_capacity(a.len() * b.len());
    for p in a {
        for q in b {
            sums.push([p[0] + q[0], p[1] + q[1]]);
        }
    }
    hull(&sums)
}

/// no fit polygon of `b` around `a` from their convex pieces: where b's origin may not go
/// (a + (-b)), boundary included as touching
pub fn no_fit(a: &[Ring], b: &[Ring]) -> Region {
    let neg: Vec<Ring> = b
        .iter()
        .map(|r| r.iter().map(|p| [-p[0], -p[1]]).collect())
        .collect();
    let rows: Vec<Region> = a
        .iter()
        .map(|pa| {
            let sums: Vec<Region> = neg
                .iter()
                .map(|pb| minkowski_convex(pa, pb))
                .filter(|s| s.len() >= 3)
                .map(|s| vec![vec![s]])
                .collect();
            union_tree(sums)
        })
        .collect();
    union_tree(rows)
}

/// unions neighbors pairwise, level by level: far fewer crossings than one overlay of everything
pub fn union_tree(mut parts: Vec<Region>) -> Region {
    while parts.len() > 1 {
        let mut next = Vec::with_capacity(parts.len().div_ceil(2));
        let mut it = parts.into_iter();
        while let Some(x) = it.next() {
            match it.next() {
                Some(y) => {
                    let rings: Vec<Ring> = x.into_iter().chain(y).flatten().collect();
                    next.push(union_rings(&rings));
                }
                None => next.push(x),
            }
        }
        parts = next;
    }
    parts.pop().unwrap_or_default()
}

/// true when `p` lies strictly inside the region (more than `eps` from its boundary)
pub fn strictly_inside(r: &Region, p: Pt, eps: f64) -> bool {
    for s in r {
        let Some(outer) = s.first() else { continue };
        if !poly2d::point_in_ring(p, outer) {
            continue;
        }
        if s.iter().skip(1).any(|h| poly2d::point_in_ring(p, h)) {
            continue;
        }
        let near = s.iter().any(|ring| {
            (0..ring.len()).any(|i| dist_to_segment(p, ring[i], ring[(i + 1) % ring.len()]) <= eps)
        });
        if !near {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f64, y: f64, s: f64) -> Ring {
        vec![[x, y], [x + s, y], [x + s, y + s], [x, y + s]]
    }

    fn ell() -> Region {
        vec![vec![vec![
            [0.0, 0.0],
            [40.0, 0.0],
            [40.0, 10.0],
            [10.0, 10.0],
            [10.0, 40.0],
            [0.0, 40.0],
        ]]]
    }

    #[test]
    fn pieces_cover_the_shape_and_are_convex() {
        let l = ell();
        let pieces = convex_pieces(&l);
        assert!(pieces.len() <= 3, "{}", pieces.len());
        let sum: f64 = pieces.iter().map(|p| poly2d::signed_area(p)).sum();
        assert!((sum - area(&l)).abs() < 1e-6);
        for p in &pieces {
            for i in 0..p.len() {
                assert!(cross(p[i], p[(i + 1) % p.len()], p[(i + 2) % p.len()]) > -1e-9);
            }
        }
    }

    #[test]
    fn pieces_of_a_ring_leave_the_hole_open() {
        let mut hole = square(10.0, 10.0, 20.0);
        hole.reverse();
        let ring: Region = vec![vec![square(0.0, 0.0, 40.0), hole]];
        let pieces = convex_pieces(&ring);
        let sum: f64 = pieces.iter().map(|p| poly2d::signed_area(p)).sum();
        assert!((sum - 1200.0).abs() < 1e-6);
        assert!(!pieces.iter().any(|p| poly2d::point_in_ring([20.0, 20.0], p)));
    }

    #[test]
    fn no_fit_of_two_squares_is_their_sum() {
        let a = vec![square(0.0, 0.0, 10.0)];
        let b = vec![square(0.0, 0.0, 4.0)];
        let nfp = no_fit(&a, &b);
        assert_eq!(nfp.len(), 1);
        let bb = bbox(&nfp);
        assert!((bb.min[0] + 4.0).abs() < 1e-6 && (bb.max[0] - 10.0).abs() < 1e-6);
        assert!((area(&nfp) - 196.0).abs() < 1e-6);
    }

    #[test]
    fn no_fit_keeps_room_inside_a_frame() {
        let mut hole = square(10.0, 10.0, 30.0);
        hole.reverse();
        let frame: Region = vec![vec![square(0.0, 0.0, 50.0), hole]];
        let small = vec![square(0.0, 0.0, 10.0)];
        let nfp = no_fit(&convex_pieces(&frame), &small);
        assert_eq!(nfp.len(), 1);
        assert_eq!(
            nfp[0].len(),
            2,
            "the hole of the frame stays a hole of the no fit polygon"
        );
        assert!(!strictly_inside(&nfp, [20.0, 20.0], 1e-6));
        assert!(strictly_inside(&nfp, [5.0, 20.0], 1e-6));
    }

    #[test]
    fn cover_contains_the_original() {
        let pts: Ring = (0..400)
            .map(|i| {
                let a = std::f64::consts::TAU * f64::from(i) / 400.0;
                let r = 20.0 + 2.0 * (a * 7.0).m_sin();
                [r * a.m_cos(), r * a.m_sin()]
            })
            .collect();
        let r: Region = vec![vec![pts]];
        let c = cover(&r, 0.1);
        assert!(vertex_count(&c) < 300, "{}", vertex_count(&c));
        assert!(
            difference(&r, &c)
                .iter()
                .map(|s| poly2d::signed_area(&s[0]))
                .sum::<f64>()
                < 1e-6
        );
    }

    #[test]
    #[allow(clippy::float_cmp, reason = "quarter turns must be exact")]
    fn quarter_turns_are_exact() {
        assert_eq!(rotate_pt([1.0, 2.0], turn(90.0)), [-2.0, 1.0]);
        assert_eq!(rotate_pt([1.0, 2.0], turn(-90.0)), [2.0, -1.0]);
        assert_eq!(rotate_pt([1.0, 2.0], turn(180.0)), [-1.0, -2.0]);
    }
}
