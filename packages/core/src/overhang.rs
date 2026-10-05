// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Walls that hang over the layer below. A wall bead whose center lies more
//! than half its width outside the lower layer hangs completely free; a wall
//! ring is cut where it crosses that boundary and the stretches outside are
//! written as overhang walls at the bridge speed, as Orca labels them. The
//! slowdown by how far a wall hangs is set point by point in `quality.rs`.
//!
//! Rings are short and support regions have few edges next to the mesh, so
//! the cuts are computed directly on a coarse edge grid instead of through
//! polygon clipping, which costs far more per ring than the walls themselves.

// Grid indices and cell counts are small (a bed of 2 mm cells), so these casts are exact.
#![allow(
    clippy::cast_possible_wrap,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

use crate::config::PrintConfig;
use crate::fm::Fm;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

type Pt = IntPoint<i32>;

/// Boundary edges of a region on a uniform grid, for point tests and
/// segment crossings.
#[derive(Debug, Clone, Default)]
pub(crate) struct Support {
    edges: Vec<[Pt; 2]>,
    min_x: i64,
    min_y: i64,
    nx: usize,
    ny: usize,
    /// CSR: edges overlapping cell `c` are `items[start[c]..start[c + 1]]`.
    start: Vec<u32>,
    items: Vec<u32>,
}

/// Grid cell size, 2 mm.
const CELL: i64 = 20_000;

impl Support {
    pub(crate) fn new(shapes: &Shapes) -> Self {
        let mut edges: Vec<[Pt; 2]> = Vec::new();
        for ring in shapes.iter().flat_map(|s| s.iter()) {
            let n = ring.len();
            for i in 0..n {
                if let (Some(&a), Some(&b)) = (ring.get(i), ring.get((i + 1) % n))
                    && a != b
                {
                    edges.push([a, b]);
                }
            }
        }
        Self::from_edges(edges)
    }

    /// A grid over loose segments, kept in the given order (edge `i` is segment `i`), zero-length ones
    /// included.
    pub(crate) fn from_edges(edges: Vec<[Pt; 2]>) -> Self {
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for p in edges.iter().flatten() {
            (x0, y0, x1, y1) = (x0.min(p.x), y0.min(p.y), x1.max(p.x), y1.max(p.y));
        }
        if edges.is_empty() {
            return Self::default();
        }
        let b = [x0, y0, x1, y1];
        let (min_x, min_y) = (i64::from(b[0]), i64::from(b[1]));
        let nx = usize::try_from((i64::from(b[2]) - min_x) / CELL + 1).unwrap_or(1);
        let ny = usize::try_from((i64::from(b[3]) - min_y) / CELL + 1).unwrap_or(1);
        let mut me = Self {
            edges,
            min_x,
            min_y,
            nx,
            ny,
            start: Vec::new(),
            items: Vec::new(),
        };
        let mut counts = vec![0u32; nx * ny + 1];
        for e in &me.edges {
            for (cx, cy) in me.cells(e[0], e[1]) {
                if let Some(c) = counts.get_mut(cy * nx + cx) {
                    *c += 1;
                }
            }
        }
        let mut acc = 0u32;
        me.start = counts
            .iter()
            .map(|c| {
                let s = acc;
                acc += c;
                s
            })
            .collect();
        let mut fill = me.start.clone();
        me.items = vec![0; acc as usize];
        for (i, e) in me.edges.iter().enumerate() {
            for (cx, cy) in me.cells(e[0], e[1]) {
                if let Some(f) = fill.get_mut(cy * nx + cx) {
                    if let Some(slot) = me.items.get_mut(*f as usize) {
                        *slot = u32::try_from(i).unwrap_or(0);
                    }
                    *f += 1;
                }
            }
        }
        me
    }

    #[allow(clippy::cast_sign_loss, reason = "coordinates are clamped to the grid first")]
    fn cell_of(&self, x: i64, y: i64) -> (usize, usize) {
        let cx = ((x - self.min_x) / CELL).clamp(0, self.nx as i64 - 1) as usize;
        let cy = ((y - self.min_y) / CELL).clamp(0, self.ny as i64 - 1) as usize;
        (cx, cy)
    }

    /// Cells the bounding box of a segment touches.
    fn cells(&self, a: Pt, b: Pt) -> impl Iterator<Item = (usize, usize)> + use<> {
        let (x0, y0) = self.cell_of(i64::from(a.x.min(b.x)), i64::from(a.y.min(b.y)));
        let (x1, y1) = self.cell_of(i64::from(a.x.max(b.x)), i64::from(a.y.max(b.y)));
        (y0..=y1).flat_map(move |cy| (x0..=x1).map(move |cx| (cx, cy)))
    }

    fn cell_edges(&self, cx: usize, cy: usize) -> &[u32] {
        let c = cy * self.nx + cx;
        match (self.start.get(c), self.start.get(c + 1)) {
            (Some(&a), Some(&b)) => self.items.get(a as usize..b as usize).unwrap_or(&[]),
            _ => &[],
        }
    }

    /// Distance in mm from `p` to the nearest boundary edge, negative when `p` is inside (Orca's signed
    /// `distance_from_lines`). Infinite for a region without edges.
    pub(crate) fn signed_distance(&self, p: Pt) -> f64 {
        let Some((d, _)) = self.nearest(p) else {
            return f64::INFINITY;
        };
        if self.inside(p) { -d } else { d }
    }

    /// The nearest edge to `p`: its distance in mm and its index. None without edges.
    #[allow(clippy::cast_precision_loss, reason = "a few cells of 2 mm")]
    pub(crate) fn nearest(&self, p: Pt) -> Option<(f64, usize)> {
        if self.edges.is_empty() {
            return None;
        }
        let mut best = (f64::INFINITY, 0usize);
        let take = |best: &mut (f64, usize), ei: usize, e: &[Pt; 2]| {
            let d = seg_dist2(p, e);
            // The first of equal edges, as a scan in edge order finds it.
            if d < best.0 || (d.to_bits() == best.0.to_bits() && ei < best.1) {
                *best = (d, ei);
            }
        };
        let (px, py) = (i64::from(p.x), i64::from(p.y));
        let inside_grid = px >= self.min_x
            && py >= self.min_y
            && px < self.min_x + self.nx as i64 * CELL
            && py < self.min_y + self.ny as i64 * CELL;
        if inside_grid {
            let (cx, cy) = self.cell_of(px, py);
            let max_r = self.nx.max(self.ny) as i64;
            for r in 0..=max_r {
                for gy in (cy as i64 - r)..=(cy as i64 + r) {
                    for gx in (cx as i64 - r)..=(cx as i64 + r) {
                        // Only the ring of cells at distance r.
                        if (gx - cx as i64).abs().max((gy - cy as i64).abs()) != r {
                            continue;
                        }
                        if gx < 0 || gy < 0 || gx >= self.nx as i64 || gy >= self.ny as i64 {
                            continue;
                        }
                        for &ei in self.cell_edges(gx as usize, gy as usize) {
                            if let Some(e) = self.edges.get(ei as usize) {
                                take(&mut best, ei as usize, e);
                            }
                        }
                    }
                }
                if best.0.is_finite() && best.0.sqrt() <= (r * CELL) as f64 {
                    break;
                }
            }
        }
        if !best.0.is_finite() {
            for (ei, e) in self.edges.iter().enumerate() {
                take(&mut best, ei, e);
            }
        }
        Some((best.0.sqrt() / crate::geom::SCALE, best.1))
    }

    /// Indices of the edges within `r` (internal units) of `p`, each once, in edge order.
    pub(crate) fn within(&self, p: Pt, r: f64) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        if self.edges.is_empty() {
            return out;
        }
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a radius of a few mm in internal units"
        )]
        let ri = r.ceil() as i64;
        let (x0, y0) = self.cell_of(i64::from(p.x) - ri, i64::from(p.y) - ri);
        let (x1, y1) = self.cell_of(i64::from(p.x) + ri, i64::from(p.y) + ri);
        for cy in y0..=y1 {
            for cx in x0..=x1 {
                for &ei in self.cell_edges(cx, cy) {
                    if let Some(e) = self.edges.get(ei as usize)
                        && seg_dist2(p, e) <= r * r
                    {
                        out.push(ei as usize);
                    }
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Edge `i`.
    pub(crate) fn edge(&self, i: usize) -> Option<[Pt; 2]> {
        self.edges.get(i).copied()
    }

    /// Even-odd containment: a ray toward +x, counting each edge once, in the
    /// cell where the edge crosses the ray's row.
    pub(crate) fn inside(&self, p: Pt) -> bool {
        if self.edges.is_empty() {
            return false;
        }
        let (px, py) = (i64::from(p.x), i64::from(p.y));
        if py < self.min_y || px > self.min_x + self.nx as i64 * CELL {
            return false;
        }
        let (cx0, cy) = self.cell_of(px, py);
        let mut inside = false;
        for cx in cx0..self.nx {
            for &ei in self.cell_edges(cx, cy) {
                let Some([a, b]) = self.edges.get(ei as usize) else {
                    continue;
                };
                let (ay, by) = (i64::from(a.y), i64::from(b.y));
                if (ay > py) == (by > py) {
                    continue;
                }
                // x of the crossing, compared to the point, in exact integers.
                let (ax, bx) = (i64::from(a.x), i64::from(b.x));
                let num = (bx - ax) * (py - ay);
                let den = by - ay;
                let x_cross_minus_px = ax * den + num - px * den;
                let right = if den > 0 {
                    x_cross_minus_px > 0
                } else {
                    x_cross_minus_px < 0
                };
                if !right {
                    continue;
                }
                // An edge sits in every cell its bounds touch; count it in the
                // first of those the ray reaches.
                if cx == cx0.max(self.cell_of(ax.min(bx), py).0) {
                    inside = !inside;
                }
            }
        }
        inside
    }

    /// Proper crossings of segment `ab` with the boundary, as `(t, point)`
    /// sorted along the segment.
    pub(crate) fn crossings(&self, a: Pt, b: Pt, out: &mut Vec<(f64, Pt)>) {
        out.clear();
        if self.edges.is_empty() {
            return;
        }
        let (sx0, sy0) = self.cell_of(i64::from(a.x.min(b.x)), i64::from(a.y.min(b.y)));
        let (sx1, sy1) = self.cell_of(i64::from(a.x.max(b.x)), i64::from(a.y.max(b.y)));
        let (lo_x, hi_x, lo_y, hi_y) = (a.x.min(b.x), a.x.max(b.x), a.y.min(b.y), a.y.max(b.y));
        for cy in sy0..=sy1 {
            for cx in sx0..=sx1 {
                for &ei in self.cell_edges(cx, cy) {
                    let Some([c, d]) = self.edges.get(ei as usize) else {
                        continue;
                    };
                    if c.x.max(d.x) < lo_x
                        || c.x.min(d.x) > hi_x
                        || c.y.max(d.y) < lo_y
                        || c.y.min(d.y) > hi_y
                    {
                        continue;
                    }
                    // An edge sits in every cell its bounds touch; test it once,
                    // in the first cell shared with the segment's bounds.
                    let (ex, ey) = self.cell_of(i64::from(c.x.min(d.x)), i64::from(c.y.min(d.y)));
                    if (cx, cy) != (sx0.max(ex), sy0.max(ey)) {
                        continue;
                    }
                    if let Some(hit) = cross(a, b, *c, *d) {
                        out.push(hit);
                    }
                }
            }
        }
        if out.len() > 1 {
            crate::sorting::sort_by(out, |x, y| x.0.total_cmp(&y.0));
        }
    }
}

/// Squared distance from `p` to segment `e`, in internal units.
pub(crate) fn seg_dist2(p: Pt, e: &[Pt; 2]) -> f64 {
    let (px, py) = (f64::from(p.x), f64::from(p.y));
    let (ax, ay) = (f64::from(e[0].x), f64::from(e[0].y));
    let (dx, dy) = (f64::from(e[1].x) - ax, f64::from(e[1].y) - ay);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 {
        (((px - ax) * dx + (py - ay) * dy) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (cx, cy) = (ax + t * dx, ay + t * dy);
    (px - cx).m_powi(2) + (py - cy).m_powi(2)
}

fn orient(a: Pt, b: Pt, c: Pt) -> i64 {
    let v = (i64::from(b.x) - i64::from(a.x)) * (i64::from(c.y) - i64::from(a.y))
        - (i64::from(b.y) - i64::from(a.y)) * (i64::from(c.x) - i64::from(a.x));
    v.signum()
}

/// Where segment `ab` properly crosses `cd`: the parameter along `ab` and the
/// point, rounded to integer coordinates.
#[allow(
    clippy::cast_possible_truncation,
    reason = "the point lies on a segment of i32 coordinates"
)]
fn cross(a: Pt, b: Pt, c: Pt, d: Pt) -> Option<(f64, Pt)> {
    let (o1, o2, o3, o4) = (orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b));
    if o1 == 0 || o2 == 0 || o3 == 0 || o4 == 0 || o1 == o2 || o3 == o4 {
        return None;
    }
    let (ax, ay) = (f64::from(a.x), f64::from(a.y));
    let (rx, ry) = (f64::from(b.x) - ax, f64::from(b.y) - ay);
    let (sx, sy) = (f64::from(d.x) - f64::from(c.x), f64::from(d.y) - f64::from(c.y));
    let den = rx * sy - ry * sx;
    let t = ((f64::from(c.x) - ax) * sy - (f64::from(c.y) - ay) * sx) / den;
    Some((
        t,
        Pt::new((ax + t * rx).round() as i32, (ay + t * ry).round() as i32),
    ))
}

/// Cuts a path where it crosses `support`, returning the pieces in order
/// with whether each lies outside. The path's first point decides the start.
pub(crate) fn split_polyline(path: &[Pt], support: &Support) -> Vec<(Vec<Pt>, bool)> {
    let Some(&first) = path.first() else {
        return Vec::new();
    };
    let mut inside = support.inside(first);
    let mut pieces: Vec<(Vec<Pt>, bool)> = Vec::new();
    let mut cur: Vec<Pt> = vec![first];
    let mut hits: Vec<(f64, Pt)> = Vec::new();
    for w in path.windows(2) {
        let [a, b] = w else { continue };
        support.crossings(*a, *b, &mut hits);
        for &(_, x) in &hits {
            if cur.last() != Some(&x) {
                cur.push(x);
            }
            if cur.len() >= 2 {
                pieces.push((std::mem::take(&mut cur), !inside));
            }
            cur = vec![x];
            inside = !inside;
        }
        if cur.last() != Some(b) {
            cur.push(*b);
        }
    }
    if cur.len() >= 2 {
        pieces.push((cur, !inside));
    }
    pieces
}

#[derive(Debug, Clone, Default)]
struct Tier {
    support: Support,
    /// Speed for this degree, or the wall's own when unset.
    speed: Option<f32>,
    /// Walls at this degree or beyond are labeled overhang walls: those whose bead
    /// hangs completely free (its center is more than half a line width past the
    /// layer below), as `OrcaSlicer` labels them.
    label: bool,
}

/// Where the walls of one layer hang over the layer below.
#[derive(Debug, Clone, Default)]
pub(crate) struct Overhang {
    /// Support region per degree, from the least: only degrees that have a speed
    /// set, then the full overhang (100 percent hanging).
    tiers: Vec<Tier>,
    /// `overhang_reverse`: where a wall counts as steeply overhanging, and whether outer walls stay put.
    reverse: Option<Reverse>,
}

#[derive(Debug, Clone)]
struct Reverse {
    /// The layer below grown by the threshold less half a line; walls outside it are steep. `None` when the
    /// threshold is zero, which reverses every odd layer.
    limit: Option<Support>,
    internal_only: bool,
}

fn speed_of(v: f64) -> Option<f32> {
    #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
    (v > 0.0).then_some(v as f32)
}

impl Overhang {
    /// `below` is the material of the layer below, `w` the line width in
    /// internal units.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "offsets are a fraction of a line width"
    )]
    pub(crate) fn new(below: &Shapes, w: i32, cfg: &PrintConfig) -> Self {
        let wf = f64::from(w);
        // Overhang walls print at the bridge speed (Orca `GCode::_extrude` for `erOverhangPerimeter`); the
        // slowdown on the way out over the edge is worked out point by point (`quality.rs`).
        let tiers = vec![Tier {
            support: Support::new(&perimeters::offset(below, (wf * 0.5).round() as i32)),
            speed: speed_of(cfg.bridge_speed),
            label: true,
        }];
        let reverse = crate::tower::flag(cfg, "overhang_reverse").then(|| {
            // The threshold is a percent of the line width (or mm); the walls may sit this far past the layer
            // below, less half a line, before the layer counts as steeply overhanging.
            let threshold = match cfg.raw.get("overhang_reverse_threshold") {
                Some(serde_json::Value::String(t)) if t.trim().ends_with('%') => {
                    t.trim()
                        .trim_end_matches('%')
                        .trim()
                        .parse::<f64>()
                        .map_or(0.5, |p| p / 100.0)
                        * wf
                }
                Some(v) => v
                    .as_f64()
                    .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
                    .map_or(0.5 * wf, |mm| mm * crate::geom::SCALE),
                None => 0.5 * wf,
            };
            Reverse {
                limit: (threshold > 1.0)
                    .then(|| Support::new(&perimeters::offset(below, (threshold - 0.5 * wf).round() as i32))),
                internal_only: crate::tower::flag(cfg, "overhang_reverse_internal_only"),
            }
        });
        Self { tiers, reverse }
    }

    /// Whether `overhang_reverse` is on.
    pub(crate) fn reverses(&self) -> bool {
        self.reverse.is_some()
    }

    /// Whether a wall ring hangs far enough past the layer below to turn the layer's walls round.
    pub(crate) fn steep(&self, ring: &[Pt]) -> bool {
        match &self.reverse {
            Some(Reverse { limit: Some(l), .. }) => ring.iter().any(|p| !l.inside(*p)),
            Some(Reverse { limit: None, .. }) => true,
            None => false,
        }
    }

    /// Whether outer walls keep their direction (`overhang_reverse_internal_only`).
    pub(crate) fn keeps_outer(&self) -> bool {
        self.reverse.as_ref().is_some_and(|r| r.internal_only)
    }

    /// True when a wall point has no support: it is more than half a line width past the layer below.
    pub(crate) fn hangs(&self, p: Pt) -> bool {
        self.tiers.last().is_some_and(|t| !t.support.inside(p))
    }

    /// True when pieces of this tier are overhang walls.
    pub(crate) fn labeled(&self, tier: usize) -> bool {
        self.tiers.get(tier).is_some_and(|t| t.label)
    }

    /// Speed for a tier, when one is set.
    pub(crate) fn speed(&self, tier: usize) -> Option<f32> {
        self.tiers.get(tier).and_then(|t| t.speed)
    }

    /// Splits a closed ring, starting at its first point, into pieces in
    /// order: `None` where the wall is supported, `Some(tier)` where it hangs.
    /// None when the ring does not hang anywhere.
    pub(crate) fn split(&self, ring: &[Pt]) -> Option<Vec<(Vec<Pt>, Option<usize>)>> {
        let mut closed = ring.to_vec();
        closed.push(*ring.first()?);
        self.split_path(&closed)
    }

    /// [`Overhang::split`] for an open path, which starts at its first point.
    pub(crate) fn split_path(&self, path: &[Pt]) -> Option<Vec<(Vec<Pt>, Option<usize>)>> {
        let first = &self.tiers.first()?.support;
        let mut pieces: Vec<(Vec<Pt>, Option<usize>)> = split_polyline(path, first)
            .into_iter()
            .map(|(p, out)| (p, out.then_some(0)))
            .collect();
        if !pieces.iter().any(|(_, t)| t.is_some()) {
            return None;
        }
        for (i, tier) in self.tiers.iter().enumerate().skip(1) {
            let mut next = Vec::with_capacity(pieces.len());
            for (p, t) in pieces {
                if t == Some(i - 1) {
                    next.extend(
                        split_polyline(&p, &tier.support)
                            .into_iter()
                            .map(|(q, out)| (q, Some(if out { i } else { i - 1 }))),
                    );
                } else {
                    next.push((p, t));
                }
            }
            pieces = next;
        }
        Some(pieces)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x0: i32, y0: i32, x1: i32, y1: i32) -> Shapes {
        vec![vec![vec![
            Pt::new(x0, y0),
            Pt::new(x1, y0),
            Pt::new(x1, y1),
            Pt::new(x0, y1),
        ]]]
    }

    #[test]
    fn containment_and_crossings() {
        let s = Support::new(&square(0, 0, 100_000, 100_000));
        assert!(s.inside(Pt::new(50_000, 50_000)));
        assert!(!s.inside(Pt::new(150_000, 50_000)));
        assert!(!s.inside(Pt::new(50_000, 150_000)));
        let mut hits = Vec::new();
        s.crossings(Pt::new(-10_000, 50_000), Pt::new(50_000, 50_000), &mut hits);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].1, Pt::new(0, 50_000));
    }

    #[test]
    fn a_ring_half_outside_splits_in_two() {
        // Support covers x < 100_000; the ring spans 50_000 to 150_000.
        let s = Support::new(&square(0, 0, 100_000, 100_000));
        let ring = [
            Pt::new(50_000, 20_000),
            Pt::new(150_000, 20_000),
            Pt::new(150_000, 80_000),
            Pt::new(50_000, 80_000),
        ];
        let mut closed = ring.to_vec();
        closed.push(ring[0]);
        let pieces = split_polyline(&closed, &s);
        assert_eq!(pieces.iter().filter(|p| p.1).count(), 1);
        assert_eq!(pieces.iter().filter(|p| !p.1).count(), 2);
        // Pieces chain end to start and cover the whole ring.
        for w in pieces.windows(2) {
            assert_eq!(w[0].0.last(), w[1].0.first());
        }
        assert_eq!(pieces[0].0.first(), Some(&ring[0]));
        assert_eq!(pieces.last().and_then(|p| p.0.last()), Some(&ring[0]));
    }
}
