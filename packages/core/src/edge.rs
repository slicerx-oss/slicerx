// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Walking along the edge of a region: the path between two points that lie on (or just inside)
//! its rings. Infill lines that end next to each other on a wall are joined this way, following
//! the wall's vertices instead of cutting a chord across a curve, as Orca's `FillRectilinear.cpp`
//! does with `emit_perimeter_prev_next_segment`.

use crate::fm::Fm as _;
use crate::geom::Point;
use crate::perimeters::Shapes;
use std::collections::HashMap;

/// Where a point lies on the rings: ring, segment and arc length position.
pub(crate) type Place = (usize, usize, f64);

struct Ring {
    pts: Vec<[f64; 2]>,
    /// Arc length at each vertex, `pts.len() + 1` entries; the last is the ring's length.
    cum: Vec<f64>,
}

/// The rings of a region with a grid over their segments for nearest-segment queries.
pub(crate) struct Edge {
    rings: Vec<Ring>,
    grid: HashMap<(i32, i32), Vec<(u32, u32)>>,
    /// Sorted arc length positions of the line ends that lie on each ring (see [`Edge::mark_ends`]).
    ends: Vec<Vec<f64>>,
}

/// Grid cell size and the farthest a point may be from a ring and still count as on it, mm.
const CELL: f64 = 2.0;
const REACH: f64 = 1.0;
/// How close a line end is to a ring position for the two to count as the same place, mm.
const ON_RING_END: f64 = 0.3;

#[allow(
    clippy::cast_possible_truncation,
    reason = "cell indices of plate coordinates"
)]
fn cell(v: f64) -> i32 {
    (v / CELL).floor() as i32
}

/// How far the walk may stray from the real wall, mm: only collinear runs are dropped. A coarser
/// tolerance gave fewer moves than Orca writes on the gear and the X plate.
const SIMPLIFY: f64 = 0.005;

/// Douglas-Peucker on a closed ring, split at its first point and the point farthest from it.
fn simplify(pts: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    let n = pts.len();
    if n < 8 {
        return pts;
    }
    let Some(first) = pts.first().copied() else {
        return pts;
    };
    let far = pts
        .iter()
        .enumerate()
        .max_by(|a, b| {
            let d = |p: &[f64; 2]| (p[0] - first[0]).m_hypot(p[1] - first[1]);
            d(a.1).total_cmp(&d(b.1))
        })
        .map_or(n / 2, |(i, _)| i);
    let mut keep = vec![false; n];
    let mut stack = vec![(0usize, far), (far, n)];
    if let Some(k) = keep.first_mut() {
        *k = true;
    }
    if let Some(k) = keep.get_mut(far) {
        *k = true;
    }
    while let Some((lo, hi)) = stack.pop() {
        let (Some(a), Some(b)) = (pts.get(lo), pts.get(hi % n)) else {
            continue;
        };
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = dx.m_hypot(dy);
        let mut worst = (0.0, lo);
        for i in lo + 1..hi {
            let Some(p) = pts.get(i) else { continue };
            let d = if len > 0.0 {
                ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / len
            } else {
                (p[0] - a[0]).m_hypot(p[1] - a[1])
            };
            if d > worst.0 {
                worst = (d, i);
            }
        }
        if worst.0 > SIMPLIFY {
            if let Some(k) = keep.get_mut(worst.1) {
                *k = true;
            }
            stack.push((lo, worst.1));
            stack.push((worst.1, hi));
        }
    }
    pts.into_iter()
        .zip(keep)
        .filter_map(|(p, k)| k.then_some(p))
        .collect()
}

impl Edge {
    pub(crate) fn new(shapes: &Shapes) -> Self {
        let mut rings = Vec::new();
        for ring in shapes.iter().flat_map(|s| s.iter()) {
            let pts: Vec<[f64; 2]> = ring
                .iter()
                .map(|p| {
                    [
                        f64::from(p.x) / crate::geom::SCALE,
                        f64::from(p.y) / crate::geom::SCALE,
                    ]
                })
                .collect();
            let pts = simplify(pts);
            if pts.len() < 3 {
                continue;
            }
            let mut cum = Vec::with_capacity(pts.len() + 1);
            let mut acc = 0.0;
            cum.push(0.0);
            for (i, p) in pts.iter().enumerate() {
                let q = pts.get((i + 1) % pts.len()).unwrap_or(p);
                acc += (q[0] - p[0]).m_hypot(q[1] - p[1]);
                cum.push(acc);
            }
            rings.push(Ring { pts, cum });
        }
        let mut grid: HashMap<(i32, i32), Vec<(u32, u32)>> = HashMap::new();
        for (r, ring) in rings.iter().enumerate() {
            let n = ring.pts.len();
            for i in 0..n {
                let (Some(p), Some(q)) = (ring.pts.get(i), ring.pts.get((i + 1) % n)) else {
                    continue;
                };
                let (x0, x1) = (cell(p[0].min(q[0]) - REACH), cell(p[0].max(q[0]) + REACH));
                let (y0, y1) = (cell(p[1].min(q[1]) - REACH), cell(p[1].max(q[1]) + REACH));
                for cx in x0..=x1 {
                    for cy in y0..=y1 {
                        #[allow(
                            clippy::cast_possible_truncation,
                            reason = "ring and segment counts fit u32"
                        )]
                        grid.entry((cx, cy)).or_default().push((r as u32, i as u32));
                    }
                }
            }
        }
        let ends = vec![Vec::new(); rings.len()];
        Self { rings, grid, ends }
    }

    /// The ring, segment and arc length position of the point of a ring nearest `p`, when within `REACH`.
    fn project(&self, p: [f64; 2]) -> Option<(usize, usize, f64)> {
        let mut best: Option<(f64, usize, usize, f64)> = None;
        for &(r, i) in self
            .grid
            .get(&(cell(p[0]), cell(p[1])))
            .map_or(&[][..], Vec::as_slice)
        {
            let ring = self.rings.get(r as usize)?;
            let n = ring.pts.len();
            let (a, b) = (ring.pts.get(i as usize)?, ring.pts.get((i as usize + 1) % n)?);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let len2 = dx * dx + dy * dy;
            let t = if len2 > 0.0 {
                (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let (ex, ey) = (p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
            // A squared distance well past the reach or the best so far rules the segment out before the exact
            // length is taken; the slack covers the rounding of both.
            let cap = best.map_or(REACH, |(bd, ..)| bd.min(REACH));
            if ex * ex + ey * ey > cap * cap * (1.0 + 1e-6) {
                continue;
            }
            let d = ex.m_hypot(ey);
            if d <= REACH && best.is_none_or(|(bd, ..)| d < bd) {
                best = Some((
                    d,
                    r as usize,
                    i as usize,
                    ring.cum.get(i as usize)? + t * len2.sqrt(),
                ));
            }
        }
        best.map(|(_, r, i, pos)| (r, i, pos))
    }

    /// The ring and arc length position of `p` when it lies within `tol` mm of a ring.
    pub(crate) fn locate(&self, p: Point, tol: f64) -> Option<(usize, f64)> {
        let (r, i, pos) = self.project([p.x_mm(), p.y_mm()])?;
        let ring = self.rings.get(r)?;
        let n = ring.pts.len();
        let (a, b) = (ring.pts.get(i)?, ring.pts.get((i + 1) % n)?);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len2 = dx * dx + dy * dy;
        let t = if len2 > 0.0 {
            (((p.x_mm() - a[0]) * dx + (p.y_mm() - a[1]) * dy) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let d = (p.x_mm() - (a[0] + t * dx)).m_hypot(p.y_mm() - (a[1] + t * dy));
        (d <= tol).then_some((r, pos))
    }

    /// Length of ring `r`, mm.
    pub(crate) fn ring_length(&self, r: usize) -> f64 {
        self.rings
            .get(r)
            .and_then(|g| g.cum.last().copied())
            .unwrap_or(0.0)
    }

    /// The point of ring `r` at arc length `pos`.
    pub(crate) fn point_at(&self, r: usize, pos: f64) -> Option<Point> {
        let ring = self.rings.get(r)?;
        let total = *ring.cum.last()?;
        let pos = pos.rem_euclid(total);
        let n = ring.pts.len();
        let i = ring
            .cum
            .partition_point(|&c| c <= pos)
            .saturating_sub(1)
            .min(n - 1);
        let (a, b) = (ring.pts.get(i)?, ring.pts.get((i + 1) % n)?);
        let seg = ring.cum.get(i + 1)? - ring.cum.get(i)?;
        let t = if seg > 0.0 {
            (pos - ring.cum.get(i)?) / seg
        } else {
            0.0
        };
        Some(Point::from_mm(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    }

    /// The vertices of ring `r` strictly between arc length `from` and `to` walking along the ring
    /// (`forward`) or against it, in travel order, then the point at `to`.
    pub(crate) fn walk(&self, r: usize, from: f64, to: f64, forward: bool) -> Vec<Point> {
        let Some(ring) = self.rings.get(r) else {
            return Vec::new();
        };
        let total = ring.cum.last().copied().unwrap_or(0.0);
        if total <= 0.0 {
            return Vec::new();
        }
        let n = ring.pts.len();
        let dist = if forward {
            (to - from).rem_euclid(total)
        } else {
            (from - to).rem_euclid(total)
        };
        let mut out = Vec::new();
        // Vertices at positions cum[k]; those within (0, dist) ahead of `from`. Only the vertices whose
        // position lies in that stretch, widened by a micron, are tested: the others are farther outside it
        // than the rounding of the test could reach, so the test would reject them anyway.
        for k in window(ring.cum.get(..n).unwrap_or(&[]), total, from, dist, forward) {
            let c = ring.cum.get(k).copied().unwrap_or(0.0);
            let ahead = if forward {
                (c - from).rem_euclid(total)
            } else {
                (from - c).rem_euclid(total)
            };
            if ahead > 1e-9 && ahead < dist - 1e-9 {
                out.push((ahead, k));
            }
        }
        crate::sorting::sort_by(&mut out, |a, b| a.0.total_cmp(&b.0));
        let mut pts: Vec<Point> = out
            .into_iter()
            .filter_map(|(_, k)| ring.pts.get(k).map(|v| Point::from_mm(v[0], v[1])))
            .collect();
        if let Some(end) = self.point_at(r, to) {
            pts.push(end);
        }
        pts
    }

    /// Records where line ends lie on the rings, so a walk between two of them refuses to pass another
    /// (Orca's `connect_segment_intersections_by_contours` marks such a link invalid).
    pub(crate) fn mark_ends(&mut self, pts: impl Iterator<Item = Point>) {
        for p in pts {
            if let Some((r, pos)) = self.locate(p, ON_RING_END)
                && let Some(v) = self.ends.get_mut(r)
            {
                v.push(pos);
            }
        }
        for v in &mut self.ends {
            v.sort_by(f64::total_cmp);
        }
    }

    /// True when no marked end lies strictly between `from` and `to` walking `forward` on ring `r`,
    /// not counting ends within `ON_RING_END` of either.
    fn clear(&self, r: usize, from: f64, to: f64, forward: bool) -> bool {
        let Some(v) = self.ends.get(r) else { return true };
        let total = self.ring_length(r);
        let span = if forward {
            (to - from).rem_euclid(total)
        } else {
            (from - to).rem_euclid(total)
        };
        !v.iter().any(|&q| {
            let ahead = if forward {
                (q - from).rem_euclid(total)
            } else {
                (from - q).rem_euclid(total)
            };
            ahead > ON_RING_END && ahead < span - ON_RING_END
        })
    }

    /// The ring containing `p` (within `tol` mm), if any.
    pub(crate) fn ring_of(&self, p: Point, tol: f64) -> Option<usize> {
        self.locate(p, tol).map(|(r, _)| r)
    }

    /// The ring, segment and arc length position of the point of a ring nearest `p` (within reach), which
    /// [`Edge::measure`] and [`Edge::via`] take.
    pub(crate) fn place(&self, p: Point) -> Option<Place> {
        self.project([p.x_mm(), p.y_mm()])
    }

    /// How Orca measures a link between line ends `a` (on the wall at `pa`) and `b` on a wall
    /// (`distance_of_segmens`), with `pb` where `b` lies on the wall ([`Edge::place`]): the number of wall segments from the one `a` lies on to the one `b` lies on
    /// walking `forward` (with the ring) or against it, the length walked, and where `b` is on the wall. Two
    /// ends on one segment are zero apart, joined by a straight line.
    pub(crate) fn measure(
        &self,
        pa: Place,
        a: Point,
        b: Point,
        pb: Option<Place>,
        forward: bool,
    ) -> Option<(usize, f64, Place)> {
        let (ra, sa, pos_a) = pa;
        let pb = pb?;
        let (rb, sb, pos_b) = pb;
        if ra != rb {
            return None;
        }
        if sa == sb {
            return Some((0, a.dist_mm(b), pb));
        }
        let n = i64::try_from(self.rings.get(ra)?.pts.len()).ok()?;
        let mut d = i64::try_from(sb).ok()? - i64::try_from(sa).ok()?;
        if !forward {
            d = -d;
        }
        if d < 0 {
            d += n;
        }
        let total = self.ring_length(ra);
        let len = if forward {
            (pos_b - pos_a).rem_euclid(total)
        } else {
            (pos_a - pos_b).rem_euclid(total)
        };
        Some((usize::try_from(d).ok()?, len, pb))
    }

    /// The wall vertices a link from `pa` to `pb` on one ring passes (`emit_perimeter_prev_next_segment`), in
    /// order; none when both lie on one segment.
    pub(crate) fn via(&self, pa: Place, pb: Place, forward: bool) -> Vec<Point> {
        if pa.1 == pb.1 {
            return Vec::new();
        }
        let mut via = self.walk(pa.0, pa.2, pb.2, forward);
        via.pop();
        via
    }

    /// The ring vertices between `a` and `b` along the shorter way round, in order from `a`, when both
    /// lie on the same ring and that way is at most `max_len` mm long (the points themselves not included).
    pub(crate) fn arc(&self, a: Point, b: Point, max_len: f64) -> Option<Vec<Point>> {
        let (ra, _, pa) = self.project([a.x_mm(), a.y_mm()])?;
        let (rb, _, pb) = self.project([b.x_mm(), b.y_mm()])?;
        if ra != rb {
            return None;
        }
        let total = self.ring_length(ra);
        let fwd = (pb - pa).rem_euclid(total);
        let bwd = total - fwd;
        // The shorter way first; the other when that one passes a line end or is too long.
        let order = if fwd <= bwd { [true, false] } else { [false, true] };
        for forward in order {
            let len = if forward { fwd } else { bwd };
            if len > max_len || !self.clear(ra, pa, pb, forward) {
                continue;
            }
            let mut via = self.walk(ra, pa, pb, forward);
            // The walk ends with the point at `b`.
            via.pop();
            return Some(via);
        }
        None
    }
}

/// The indices of the sorted positions `cum` (on a ring of length `total`) that lie within a micron of the
/// stretch of length `dist` that starts at `from` walking `forward`, or ends there walking back, in index
/// order; every index when the widened stretch covers the ring or wraps past its start.
fn window(cum: &[f64], total: f64, from: f64, dist: f64, forward: bool) -> std::ops::Range<usize> {
    const SLACK: f64 = 1e-6;
    let lo = if forward { from } else { from - dist } - SLACK;
    let span = dist + 2.0 * SLACK;
    if span.partial_cmp(&total) != Some(std::cmp::Ordering::Less) || !lo.is_finite() {
        return 0..cum.len();
    }
    let lo = lo.rem_euclid(total);
    let hi = lo + span;
    let first = cum.partition_point(|&c| c < lo);
    if hi < total {
        first..cum.partition_point(|&c| c <= hi)
    } else {
        0..cum.len()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use i_overlay::i_float::int::point::IntPoint;

    fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        let p = |x: f64, y: f64| {
            let q = Point::from_mm(x, y);
            IntPoint::new(q.x, q.y)
        };
        vec![vec![vec![p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]]]
    }

    #[test]
    fn the_short_way_round_a_corner_includes_the_corner() {
        let e = Edge::new(&square(0.0, 0.0, 10.0, 10.0));
        // Two points on the bottom and right sides, near the lower right corner.
        let arc = e
            .arc(Point::from_mm(8.0, 0.1), Point::from_mm(9.9, 2.0), 10.0)
            .unwrap();
        assert_eq!(arc.len(), 1);
        assert!((arc[0].x_mm() - 10.0).abs() < 1e-3 && arc[0].y_mm().abs() < 1e-3);
    }

    #[test]
    fn points_on_one_side_have_no_vertices_between_and_far_points_are_refused() {
        let e = Edge::new(&square(0.0, 0.0, 10.0, 10.0));
        let arc = e
            .arc(Point::from_mm(2.0, 0.1), Point::from_mm(5.0, 0.1), 10.0)
            .unwrap();
        assert!(arc.is_empty());
        assert!(
            e.arc(Point::from_mm(2.0, 0.1), Point::from_mm(5.0, 9.9), 4.0)
                .is_none()
        );
        assert!(
            e.arc(Point::from_mm(5.0, 5.0), Point::from_mm(5.0, 0.1), 40.0)
                .is_none()
        );
    }
}
