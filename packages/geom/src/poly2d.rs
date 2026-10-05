// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! 2D polygons
// node and point indices come from the lists built in this module
#![allow(clippy::indexing_slicing)]
// exact equality on purpose: a tolerance would merge distinct vertices
#![allow(clippy::float_cmp)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::vec3::V2;
use serde::{Deserialize, Serialize};

/// a polygon with holes. the outer ring is counterclockwise, holes clockwise.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Polygon {
    pub outer: Vec<V2>,
    #[serde(default)]
    pub holes: Vec<Vec<V2>>,
}

impl Polygon {
    pub fn simple(mut outer: Vec<V2>) -> Self {
        if signed_area(&outer) < 0.0 {
            outer.reverse();
        }
        Self {
            outer,
            holes: Vec::new(),
        }
    }

    pub fn area(&self) -> f64 {
        signed_area(&self.outer).abs() - self.holes.iter().map(|h| signed_area(h).abs()).sum::<f64>()
    }

    pub fn perimeter(&self) -> f64 {
        std::iter::once(&self.outer)
            .chain(&self.holes)
            .map(|r| ring_length(r))
            .sum()
    }

    pub fn contains(&self, p: V2) -> bool {
        point_in_ring(p, &self.outer) && !self.holes.iter().any(|h| point_in_ring(p, h))
    }

    pub fn vertices(&self) -> impl Iterator<Item = V2> + '_ {
        self.outer.iter().chain(self.holes.iter().flatten()).copied()
    }

    pub fn normalize_orientation(&mut self) {
        if signed_area(&self.outer) < 0.0 {
            self.outer.reverse();
        }
        for h in &mut self.holes {
            if signed_area(h) > 0.0 {
                h.reverse();
            }
        }
    }
}

pub fn signed_area(ring: &[V2]) -> f64 {
    let n = ring.len();
    (0..n)
        .map(|i| {
            let a = ring[i];
            let b = ring[(i + 1) % n];
            a[0] * b[1] - b[0] * a[1]
        })
        .sum::<f64>()
        * 0.5
}

pub fn ring_length(ring: &[V2]) -> f64 {
    let n = ring.len();
    (0..n)
        .map(|i| {
            let a = ring[i];
            let b = ring[(i + 1) % n];
            (b[0] - a[0]).m_hypot(b[1] - a[1])
        })
        .sum()
}

pub fn point_in_ring(p: V2, ring: &[V2]) -> bool {
    let n = ring.len();
    let mut inside = false;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) {
            let x = a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
            if p[0] < x {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

pub fn orient(a: V2, b: V2, c: V2) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

pub fn interior_point(ring: &[V2]) -> V2 {
    let n = ring.len();
    let ccw = signed_area(ring) >= 0.0;
    let scale = ring_length(ring).max(1e-12);
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = dx.m_hypot(dy);
        if l < 1e-12 * scale {
            continue;
        }
        let (nx, ny) = if ccw { (-dy / l, dx / l) } else { (dy / l, -dx / l) };
        let mid = [f64::midpoint(a[0], b[0]), f64::midpoint(a[1], b[1])];
        let mut step = l * 1e-3;
        for _ in 0..20 {
            let p = [mid[0] + nx * step, mid[1] + ny * step];
            if point_in_ring(p, ring) {
                return p;
            }
            step *= 0.25;
        }
    }
    ring.first().copied().unwrap_or([0.0, 0.0])
}

pub fn nest(rings: Vec<Vec<V2>>) -> Vec<Polygon> {
    let rings: Vec<Vec<V2>> = rings.into_iter().filter(|r| r.len() >= 3).collect();
    let areas: Vec<f64> = rings.iter().map(|r| signed_area(r).abs()).collect();
    let probes: Vec<V2> = rings.iter().map(|r| interior_point(r)).collect();
    let n = rings.len();
    let mut parent = vec![usize::MAX; n];
    let mut depth = vec![0usize; n];
    for i in 0..n {
        let mut best = usize::MAX;
        for j in 0..n {
            if i == j || areas[j] <= areas[i] {
                continue;
            }
            if point_in_ring(probes[i], &rings[j]) && (best == usize::MAX || areas[j] < areas[best]) {
                best = j;
            }
        }
        parent[i] = best;
    }
    for i in 0..n {
        let mut d = 0;
        let mut p = parent[i];
        while p != usize::MAX && d <= n {
            d += 1;
            p = parent[p];
        }
        depth[i] = d;
    }
    let mut out: Vec<Polygon> = Vec::new();
    let mut slot = vec![usize::MAX; n];
    for i in 0..n {
        if depth[i].is_multiple_of(2) {
            slot[i] = out.len();
            out.push(Polygon::simple(rings[i].clone()));
        }
    }
    for i in 0..n {
        if depth[i] % 2 == 1
            && let Some(poly) = out.get_mut(slot[parent[i]])
        {
            let mut h = rings[i].clone();
            if signed_area(&h) > 0.0 {
                h.reverse();
            }
            poly.holes.push(h);
        }
    }
    out
}

pub fn triangulate(poly: &Polygon) -> Result<Vec<[u32; 3]>> {
    let pts: Vec<V2> = poly.vertices().collect();
    if u32::try_from(pts.len()).is_err() {
        return Err(Error::invalid("triangulate", "too many vertices"));
    }
    let mut ear = Ears::default();
    let outer_ccw = signed_area(&poly.outer) >= 0.0;
    let Some(start) = ear.ring(&pts, 0, poly.outer.len(), outer_ccw) else {
        return Ok(Vec::new());
    };
    let mut offset = poly.outer.len();
    let mut holes = Vec::new();
    for h in &poly.holes {
        let ccw = signed_area(h) >= 0.0;
        if let Some(node) = ear.ring(&pts, offset, h.len(), !ccw) {
            holes.push(node);
        }
        offset += h.len();
    }
    holes.sort_by(|&a, &b| {
        let (pa, pb) = (
            ear.p(&pts, ear.rightmost(&pts, a)),
            ear.p(&pts, ear.rightmost(&pts, b)),
        );
        pb[0].total_cmp(&pa[0]).then(pb[1].total_cmp(&pa[1]))
    });
    let mut start = start;
    for h in holes {
        start = ear.bridge(&pts, start, h)?;
    }
    Ok(ear.clip(&pts, start))
}

#[derive(Default)]
struct Ears {
    pt: Vec<u32>,
    prev: Vec<usize>,
    next: Vec<usize>,
    alive: Vec<bool>,
}

impl Ears {
    fn p(&self, pts: &[V2], n: usize) -> V2 {
        pts[self.pt[n] as usize]
    }

    fn node(&mut self, pt: usize) -> usize {
        let id = self.pt.len();
        #[allow(
            clippy::cast_possible_truncation,
            reason = "checked against u32 in triangulate"
        )]
        self.pt.push(pt as u32);
        self.prev.push(id);
        self.next.push(id);
        self.alive.push(true);
        id
    }

    fn ring(&mut self, pts: &[V2], first: usize, len: usize, ccw: bool) -> Option<usize> {
        let order: Vec<usize> = if ccw {
            (first..first + len).collect()
        } else {
            (first..first + len).rev().collect()
        };
        let mut head: Option<usize> = None;
        let mut last: Option<usize> = None;
        for i in order {
            if let Some(l) = last
                && pts[self.pt[l] as usize] == pts[i]
            {
                continue;
            }
            let n = self.node(i);
            if let Some(l) = last {
                self.next[l] = n;
                self.prev[n] = l;
            }
            head.get_or_insert(n);
            last = Some(n);
        }
        let (h, l) = (head?, last?);
        if h != l && pts[self.pt[h] as usize] == pts[self.pt[l] as usize] {
            let before = self.prev[l];
            self.alive[l] = false;
            self.next[before] = h;
            self.prev[h] = before;
        } else {
            self.next[l] = h;
            self.prev[h] = l;
        }
        let count = self.count(h);
        (count >= 3).then_some(h)
    }

    fn count(&self, start: usize) -> usize {
        let mut n = 1;
        let mut i = self.next[start];
        while i != start && n <= self.pt.len() {
            n += 1;
            i = self.next[i];
        }
        n
    }

    fn rightmost(&self, pts: &[V2], start: usize) -> usize {
        let mut best = start;
        let mut i = self.next[start];
        while i != start {
            let (p, b) = (self.p(pts, i), self.p(pts, best));
            if p[0] > b[0] || (p[0] == b[0] && p[1] < b[1]) {
                best = i;
            }
            i = self.next[i];
        }
        best
    }

    fn bridge(&mut self, pts: &[V2], outer: usize, hole: usize) -> Result<usize> {
        let m_node = self.rightmost(pts, hole);
        let m = self.p(pts, m_node);
        let mut best_x = f64::INFINITY;
        let mut cand: Option<usize> = None;
        let mut i = outer;
        loop {
            let j = self.next[i];
            let (a, b) = (self.p(pts, i), self.p(pts, j));
            if (a[1] <= m[1] && b[1] >= m[1] || b[1] <= m[1] && a[1] >= m[1]) && a[1] != b[1] {
                let x = a[0] + (m[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
                if x >= m[0] && x < best_x {
                    best_x = x;
                    cand = Some(if a[0] > b[0] { i } else { j });
                    if x == m[0] {
                        break;
                    }
                }
            } else if a[1] == m[1] && a[0] >= m[0] && a[0] < best_x {
                best_x = a[0];
                cand = Some(i);
            }
            i = j;
            if i == outer {
                break;
            }
        }
        let Some(mut p) = cand else {
            return Err(Error::geometry("triangulate", "a hole is outside its outer ring"));
        };
        let hit = [best_x, m[1]];
        let pp = self.p(pts, p);
        let mut best_tan = f64::INFINITY;
        let mut i = self.next[p];
        let stop = p;
        while i != stop {
            let q = self.p(pts, i);
            if q[0] >= m[0] && q[0] <= pp[0] && q != m && q != pp && in_triangle_closed(q, m, hit, pp) {
                let tan = (q[1] - m[1]).abs() / (q[0] - m[0]).max(1e-300);
                let reflex = orient(self.p(pts, self.prev[i]), q, self.p(pts, self.next[i])) <= 0.0;
                if reflex && (tan < best_tan || (tan == best_tan && q[0] > self.p(pts, p)[0])) {
                    best_tan = tan;
                    p = i;
                }
            }
            i = self.next[i];
        }
        if !self.sees(pts, outer, hole, m, p) {
            let mut best: Option<(f64, usize)> = None;
            let mut i = outer;
            loop {
                let q = self.p(pts, i);
                let d = (q[0] - m[0]).m_powi(2) + (q[1] - m[1]).m_powi(2);
                if q != m && best.is_none_or(|(bd, _)| d < bd) && self.sees(pts, outer, hole, m, i) {
                    best = Some((d, i));
                }
                i = self.next[i];
                if i == outer {
                    break;
                }
            }
            if let Some((_, q)) = best {
                p = q;
            }
        }
        let p2 = self.node(self.pt[p] as usize);
        let m2 = self.node(self.pt[m_node] as usize);
        let p_next = self.next[p];
        let m_prev = self.prev[m_node];
        self.next[p] = m_node;
        self.prev[m_node] = p;
        self.next[m_prev] = m2;
        self.prev[m2] = m_prev;
        self.next[m2] = p2;
        self.prev[p2] = m2;
        self.next[p2] = p_next;
        self.prev[p_next] = p2;
        Ok(p)
    }

    fn sees(&self, pts: &[V2], outer: usize, hole: usize, m: V2, p: usize) -> bool {
        let pp = self.p(pts, p);
        let (a, c) = (self.p(pts, self.prev[p]), self.p(pts, self.next[p]));
        let inside = if orient(a, pp, c) >= 0.0 {
            orient(pp, c, m) >= 0.0 && orient(a, pp, m) >= 0.0
        } else {
            orient(pp, c, m) >= 0.0 || orient(a, pp, m) >= 0.0
        };
        if !inside {
            return false;
        }
        for start in [outer, hole] {
            let mut i = start;
            loop {
                let j = self.next[i];
                let (e0, e1) = (self.p(pts, i), self.p(pts, j));
                if !(e0 == pp || e1 == pp || e0 == m || e1 == m) && segments_touch(m, pp, e0, e1) {
                    return false;
                }
                i = j;
                if i == start {
                    break;
                }
            }
        }
        true
    }

    fn remove(&mut self, n: usize) {
        let (a, b) = (self.prev[n], self.next[n]);
        self.next[a] = b;
        self.prev[b] = a;
        self.alive[n] = false;
    }

    fn is_ear(&self, pts: &[V2], b: usize, strict: bool) -> bool {
        let a = self.prev[b];
        let c = self.next[b];
        let (pa, pb, pc) = (self.p(pts, a), self.p(pts, b), self.p(pts, c));
        if orient(pa, pb, pc) <= 0.0 {
            return false;
        }
        let mut i = self.next[c];
        while i != a {
            let q = self.p(pts, i);
            if q != pa && q != pb && q != pc {
                let inside = if strict {
                    in_triangle_closed(q, pa, pb, pc)
                } else {
                    in_triangle_open(q, pa, pb, pc)
                };
                if inside {
                    let r = orient(self.p(pts, self.prev[i]), q, self.p(pts, self.next[i]));
                    if r <= 0.0 {
                        return false;
                    }
                }
            } else if q == pb && strict {
                // bridge duplicate of the ear tip: the ear must not swallow the other side
                let (qa, qc) = (self.p(pts, self.prev[i]), self.p(pts, self.next[i]));
                if in_triangle_open(qa, pa, pb, pc) || in_triangle_open(qc, pa, pb, pc) {
                    return false;
                }
            }
            i = self.next[i];
        }
        true
    }

    fn clip(&mut self, pts: &[V2], start: usize) -> Vec<[u32; 3]> {
        let mut out = Vec::with_capacity(self.count(start).saturating_sub(2));
        let mut remaining = self.count(start);
        let mut n = start;
        let mut stalled = 0usize;
        let mut pass = 0u8;
        while remaining > 3 {
            if self.is_ear(pts, n, pass == 0) {
                let (a, c) = (self.prev[n], self.next[n]);
                out.push([self.pt[a], self.pt[n], self.pt[c]]);
                self.remove(n);
                remaining -= 1;
                n = c;
                stalled = 0;
                continue;
            }
            n = self.next[n];
            stalled += 1;
            if stalled > remaining {
                stalled = 0;
                pass += 1;
                if pass == 2 {
                    // last resort for self-touching input: clip the most convex vertex
                    let mut best = n;
                    let mut best_o = f64::NEG_INFINITY;
                    let mut i = n;
                    loop {
                        let o = orient(
                            self.p(pts, self.prev[i]),
                            self.p(pts, i),
                            self.p(pts, self.next[i]),
                        );
                        if o > best_o {
                            best_o = o;
                            best = i;
                        }
                        i = self.next[i];
                        if i == n {
                            break;
                        }
                    }
                    if best_o <= 0.0 {
                        return out;
                    }
                    let (a, c) = (self.prev[best], self.next[best]);
                    out.push([self.pt[a], self.pt[best], self.pt[c]]);
                    self.remove(best);
                    remaining -= 1;
                    n = c;
                    pass = 1;
                }
            }
        }
        let (a, c) = (self.prev[n], self.next[n]);
        if orient(self.p(pts, a), self.p(pts, n), self.p(pts, c)) > 0.0 {
            out.push([self.pt[a], self.pt[n], self.pt[c]]);
        }
        out
    }
}

fn segments_touch(a: V2, b: V2, c: V2, d: V2) -> bool {
    let (o1, o2) = (orient(a, b, c), orient(a, b, d));
    let (o3, o4) = (orient(c, d, a), orient(c, d, b));
    if o1 * o2 < 0.0 && o3 * o4 < 0.0 {
        return true;
    }
    let on = |p: V2, q: V2, r: V2| {
        orient(p, q, r) == 0.0
            && r[0] >= p[0].min(q[0])
            && r[0] <= p[0].max(q[0])
            && r[1] >= p[1].min(q[1])
            && r[1] <= p[1].max(q[1])
    };
    on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)
}

fn in_triangle_closed(p: V2, a: V2, b: V2, c: V2) -> bool {
    orient(a, b, p) >= 0.0 && orient(b, c, p) >= 0.0 && orient(c, a, p) >= 0.0
}

fn in_triangle_open(p: V2, a: V2, b: V2, c: V2) -> bool {
    orient(a, b, p) > 0.0 && orient(b, c, p) > 0.0 && orient(c, a, p) > 0.0
}

pub fn circle(center: V2, r: f64, segments: usize) -> Vec<V2> {
    let n = segments.max(3);
    (0..n)
        .map(|i| {
            let a = std::f64::consts::TAU * i as f64 / n as f64;
            [center[0] + r * a.m_cos(), center[1] + r * a.m_sin()]
        })
        .collect()
}

pub fn rect(min: V2, max: V2) -> Vec<V2> {
    vec![min, [max[0], min[1]], max, [min[0], max[1]]]
}

pub fn fill_nonzero(contours: Vec<Vec<V2>>, min_area: f64) -> Vec<Polygon> {
    use i_overlay::core::fill_rule::FillRule;
    use i_overlay::float::simplify::SimplifyShape;
    let contours: Vec<Vec<V2>> = contours.into_iter().filter(|c| c.len() >= 3).collect();
    if contours.is_empty() {
        return Vec::new();
    }
    contours
        .simplify_shape(FillRule::NonZero)
        .into_iter()
        .filter_map(|mut rings| {
            if rings.is_empty() {
                return None;
            }
            let outer = rings.remove(0);
            let mut p = Polygon { outer, holes: rings };
            p.normalize_orientation();
            p.holes
                .retain(|h| h.len() >= 3 && signed_area(h).abs() > min_area);
            (p.outer.len() >= 3 && p.area() > min_area).then_some(p)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tri_area(pts: &[V2], tris: &[[u32; 3]]) -> f64 {
        tris.iter()
            .map(|t| orient(pts[t[0] as usize], pts[t[1] as usize], pts[t[2] as usize]) * 0.5)
            .sum()
    }

    #[test]
    fn neighboring_holes_do_not_block_a_bridge() {
        // a "2" beside a "-" once lost 6 triangles (ray hit a corner the dash was in front of)
        for text in ["2-", "0.", "0.3", "0.5", "1.25", "2-1"] {
            let mut poly = Polygon::simple(rect([-30.0, -20.0], [30.0, 20.0]));
            let glyphs = crate::font::text_polygons(text, 5.0, 0.8);
            for g in &glyphs {
                poly.holes.push(g.outer.iter().rev().copied().collect());
            }
            let pts: Vec<V2> = poly.vertices().collect();
            let tris = triangulate(&poly).unwrap();
            assert_eq!(tris.len(), pts.len() + 2 * poly.holes.len() - 2, "{text}");
            assert!((tri_area(&pts, &tris) - poly.area()).abs() < 1e-6, "{text}");
        }
    }

    #[test]
    fn square_with_hole() {
        let poly = Polygon {
            outer: rect([0.0, 0.0], [10.0, 10.0]),
            holes: vec![{
                let mut h = rect([3.0, 3.0], [6.0, 7.0]);
                h.reverse();
                h
            }],
        };
        let tris = triangulate(&poly).unwrap();
        let pts: Vec<V2> = poly.vertices().collect();
        assert!((tri_area(&pts, &tris) - 88.0).abs() < 1e-9);
        assert!(
            tris.iter()
                .all(|t| orient(pts[t[0] as usize], pts[t[1] as usize], pts[t[2] as usize]) > 0.0)
        );
    }

    #[test]
    fn many_holes_and_collinear_points() {
        let mut outer = Vec::new();
        for i in 0..20 {
            outer.push([f64::from(i), 0.0]);
        }
        outer.extend([[20.0, 0.0], [20.0, 5.0], [0.0, 5.0]]);
        let holes: Vec<Vec<V2>> = (0..6)
            .map(|k| {
                let mut c = circle([2.0 + 3.0 * f64::from(k), 2.5], 1.0, 12);
                c.reverse();
                c
            })
            .collect();
        let poly = Polygon { outer, holes };
        let tris = triangulate(&poly).unwrap();
        let pts: Vec<V2> = poly.vertices().collect();
        assert!((tri_area(&pts, &tris) - poly.area()).abs() < 1e-9);
        let mut used = vec![false; pts.len()];
        for t in &tris {
            for &i in t {
                used[i as usize] = true;
            }
        }
        assert!(used.iter().all(|u| *u));
    }

    #[test]
    fn nest_finds_islands_in_holes() {
        let rings = vec![
            rect([0.0, 0.0], [10.0, 10.0]),
            rect([2.0, 2.0], [8.0, 8.0]),
            rect([4.0, 4.0], [6.0, 6.0]),
        ];
        let polys = nest(rings);
        assert_eq!(polys.len(), 2);
        assert_eq!(polys.iter().map(|p| p.holes.len()).sum::<usize>(), 1);
        assert!((polys.iter().map(Polygon::area).sum::<f64>() - 68.0).abs() < 1e-9);
    }
}
