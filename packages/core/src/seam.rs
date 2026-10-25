// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Painted seams (`paint_seam`): where the user painted the model, a wall ring starts its seam
//! on the painted stretch (enforcer) or stays off it (blocker).
//!
//! A ring point is enforced when a painted enforcer triangle lies within one line width of it in
//! 3D, blocked when a blocker does (a blocker wins). Edges near an enforcer get a point every
//! 0.2 mm, so the seam can land inside the stretch. With enforcers on a ring, only enforced points
//! can hold the seam; the aligned modes pick the middle of the longest stretch, or its sharpest
//! corner when it has one. With only blockers, the seam stays on the unblocked points.

use crate::config::SeamPosition;
use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use i_overlay::i_float::int::point::IntPoint;

/// One painted triangle in plate coordinates, mm.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SeamFace {
    pub(crate) tri: [[f64; 3]; 3],
    pub(crate) enforcer: bool,
}

/// Step between the extra points along an edge near an enforcer, mm.
pub(crate) const OVERSAMPLE_MM: f64 = 0.2;
/// A corner this sharp takes the seam from the middle of an enforced stretch.
pub(crate) const SHARP_TURN: f64 = 55.0 * std::f64::consts::PI / 180.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Blocked,
    Neutral,
    Enforced,
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Squared distance from `p` to the closest point of triangle `t`.
fn dist2_to_triangle(p: [f64; 3], t: &[[f64; 3]; 3]) -> f64 {
    let [a, b, c] = *t;
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    let at = |q: [f64; 3]| {
        let d = sub(p, q);
        dot(d, d)
    };
    if d1 <= 0.0 && d2 <= 0.0 {
        return at(a);
    }
    let bp = sub(p, b);
    let (d3, d4) = (dot(ab, bp), dot(ac, bp));
    if d3 >= 0.0 && d4 <= d3 {
        return at(b);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return at([a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]);
    }
    let cp = sub(p, c);
    let (d5, d6) = (dot(ab, cp), dot(ac, cp));
    if d6 >= 0.0 && d5 <= d6 {
        return at(c);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return at([a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]);
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return at([
            b[0] + (c[0] - b[0]) * w,
            b[1] + (c[1] - b[1]) * w,
            b[2] + (c[2] - b[2]) * w,
        ]);
    }
    let denom = 1.0 / (va + vb + vc);
    let (v, w) = (vb * denom, vc * denom);
    at([
        a[0] + ab[0] * v + ac[0] * w,
        a[1] + ab[1] * v + ac[1] * w,
        a[2] + ab[2] * v + ac[2] * w,
    ])
}

/// Whether a painted triangle of the given kind lies within `radius` of `p`, testing every
/// triangle. [`SeamIndex::near`] gives the same answer faster.
#[cfg(test)]
fn near(p: [f64; 3], faces: &[SeamFace], enforcer: bool, radius: f64) -> bool {
    faces
        .iter()
        .filter(|f| f.enforcer == enforcer)
        .any(|f| dist2_to_triangle(p, &f.tri) <= radius * radius)
}

/// Most cells along one side of a grid.
const GRID_MAX_SIDE: usize = 1024;

/// A box from its lowest to its highest corner, mm.
type Bounds = ([f64; 3], [f64; 3]);

fn bounds(t: &[[f64; 3]; 3]) -> Bounds {
    let [a, b, c] = *t;
    (
        [
            a[0].min(b[0]).min(c[0]),
            a[1].min(b[1]).min(c[1]),
            a[2].min(b[2]).min(c[2]),
        ],
        [
            a[0].max(b[0]).max(c[0]),
            a[1].max(b[1]).max(c[1]),
            a[2].max(b[2]).max(c[2]),
        ],
    )
}

/// One axis of a grid: where its first cell starts, the cell size and the number of cells.
#[derive(Debug, Clone, Copy)]
struct Axis {
    origin: f64,
    cell: f64,
    cells: usize,
}

impl Axis {
    const EMPTY: Self = Self {
        origin: 0.0,
        cell: 1.0,
        cells: 0,
    };

    /// The cell holding coordinate `v`, clamped to the axis. The same clamped mapping places the
    /// triangles and the queries, so a query box that overlaps a triangle's box shares a cell with it.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "clamped to the axis"
    )]
    fn at(self, v: f64) -> usize {
        let f = ((v - self.origin) / self.cell).floor();
        let last = self.cells.saturating_sub(1);
        #[allow(clippy::cast_precision_loss, reason = "a grid side is at most GRID_MAX_SIDE")]
        let top = last as f64;
        if f >= top {
            last
        } else if f > 0.0 {
            f as usize
        } else {
            0
        }
    }

    /// The first and last cell (inclusive) that the span from `lo` to `hi` covers.
    fn span(self, lo: f64, hi: f64) -> std::ops::RangeInclusive<usize> {
        self.at(lo)..=self.at(hi)
    }
}

/// The painted triangles of one kind, bucketed by a uniform grid over their XY bounds. A query
/// looks only at the cells its radius covers and tests a triangle exactly only when the point lies
/// within the radius of its bounding box, so it answers as testing every triangle would.
#[derive(Debug)]
struct KindGrid {
    tris: Vec<[[f64; 3]; 3]>,
    boxes: Vec<Bounds>,
    /// Triangles with a coordinate that is not finite; they stay out of the grid and are always
    /// tested.
    loose: Vec<usize>,
    x: Axis,
    y: Axis,
    /// Cell `c` (row major) holds `items[starts[c]..starts[c + 1]]`.
    starts: Vec<usize>,
    items: Vec<usize>,
}

impl KindGrid {
    const EMPTY: Self = Self {
        tris: Vec::new(),
        boxes: Vec::new(),
        loose: Vec::new(),
        x: Axis::EMPTY,
        y: Axis::EMPTY,
        starts: Vec::new(),
        items: Vec::new(),
    };

    /// The cells, row major, that the XY box covers.
    fn cells(&self, lo: [f64; 2], hi: [f64; 2]) -> impl Iterator<Item = usize> + '_ {
        let cols = self.x.span(lo[0], hi[0]);
        let width = self.x.cells;
        self.y
            .span(lo[1], hi[1])
            .flat_map(move |row| cols.clone().map(move |col| row * width + col))
    }

    fn new(tris: Vec<[[f64; 3]; 3]>) -> Self {
        let boxes: Vec<Bounds> = tris.iter().map(bounds).collect();
        let (held, loose): (Vec<usize>, Vec<usize>) = (0..tris.len()).partition(|&i| {
            tris.get(i)
                .is_some_and(|t| t.iter().flatten().all(|c| c.is_finite()))
        });
        let mut grid = Self {
            tris,
            boxes,
            loose,
            ..Self::EMPTY
        };
        let held: Vec<(usize, Bounds)> = held
            .iter()
            .filter_map(|&i| Some((i, *grid.boxes.get(i)?)))
            .collect();
        let Some((lo, hi, extent)) =
            held.iter()
                .map(|(_, b)| b)
                .fold(None, |acc: Option<([f64; 2], [f64; 2], f64)>, (l, h)| {
                    let e = (h[0] - l[0]).max(h[1] - l[1]);
                    Some(match acc {
                        None => ([l[0], l[1]], [h[0], h[1]], e),
                        Some((lo, hi, sum)) => (
                            [lo[0].min(l[0]), lo[1].min(l[1])],
                            [hi[0].max(h[0]), hi[1].max(h[1])],
                            sum + e,
                        ),
                    })
                })
        else {
            return grid;
        };
        let (w, h) = (hi[0] - lo[0], hi[1] - lo[1]);
        #[allow(clippy::cast_precision_loss, reason = "a triangle count")]
        let n = held.len() as f64;
        #[allow(clippy::cast_precision_loss, reason = "a small constant")]
        let side = (GRID_MAX_SIDE - 1) as f64;
        let cell = (extent / n)
            .max((w * h / n).sqrt())
            .max(w.max(h) / side)
            .max(1e-6);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "at most GRID_MAX_SIDE"
        )]
        let count = |len: f64| ((len / cell) as usize + 1).min(GRID_MAX_SIDE);
        let x = Axis {
            origin: lo[0],
            cell,
            cells: count(w),
        };
        let y = Axis {
            origin: lo[1],
            cell,
            cells: count(h),
        };
        grid.x = x;
        grid.y = y;
        let total = x.cells * y.cells;
        let mut starts = vec![0usize; total + 1];
        for (_, (l, h)) in &held {
            for c in grid.cells([l[0], l[1]], [h[0], h[1]]) {
                if let Some(s) = starts.get_mut(c + 1) {
                    *s += 1;
                }
            }
        }
        let mut sum = 0;
        for s in &mut starts {
            sum += *s;
            *s = sum;
        }
        let mut fill = starts.clone();
        let mut items = vec![0usize; sum];
        for &(i, (l, h)) in &held {
            for c in grid.cells([l[0], l[1]], [h[0], h[1]]) {
                if let Some(f) = fill.get_mut(c) {
                    if let Some(slot) = items.get_mut(*f) {
                        *slot = i;
                    }
                    *f += 1;
                }
            }
        }
        grid.starts = starts;
        grid.items = items;
        grid
    }

    fn near(&self, p: [f64; 3], radius: f64) -> bool {
        let r2 = radius * radius;
        let hit = |i: usize| self.tris.get(i).is_some_and(|t| dist2_to_triangle(p, t) <= r2);
        // The box test widens the radius past any rounding in the exact test.
        let pad = radius.abs() * (1.0 + 1e-9) + 1e-6 + 1e-12 * p[0].abs().max(p[1].abs()).max(p[2].abs());
        let n = self.tris.len();
        if self.x.cells == 0 || self.y.cells == 0 || !pad.is_finite() || !p.iter().all(|c| c.is_finite()) {
            return (0..n).any(hit);
        }
        if self.loose.iter().any(|&i| hit(i)) {
            return true;
        }
        let within = |i: usize| {
            self.boxes.get(i).is_some_and(|(l, h)| {
                p.iter()
                    .zip(l.iter().zip(h))
                    .all(|(v, (lo, hi))| *v >= lo - pad && *v <= hi + pad)
            })
        };
        let (lo, hi) = ([p[0] - pad, p[1] - pad], [p[0] + pad, p[1] + pad]);
        let visits = self.x.span(lo[0], hi[0]).count() * self.y.span(lo[1], hi[1]).count();
        if visits > n {
            return (0..n).any(|i| within(i) && hit(i));
        }
        self.cells(lo, hi).any(|c| {
            let (Some(&s), Some(&e)) = (self.starts.get(c), self.starts.get(c + 1)) else {
                return false;
            };
            self.items
                .get(s..e)
                .is_some_and(|cell| cell.iter().any(|&i| within(i) && hit(i)))
        })
    }
}

/// The painted triangles near one layer, indexed for [`SeamIndex::near`].
#[derive(Debug)]
pub(crate) struct SeamIndex {
    blockers: KindGrid,
    enforcers: KindGrid,
}

/// No painted triangles.
pub(crate) static NO_SEAMS: SeamIndex = SeamIndex {
    blockers: KindGrid::EMPTY,
    enforcers: KindGrid::EMPTY,
};

impl SeamIndex {
    pub(crate) fn new(faces: &[SeamFace]) -> Self {
        let of = |enforcer: bool| {
            faces
                .iter()
                .filter(|f| f.enforcer == enforcer)
                .map(|f| f.tri)
                .collect::<Vec<_>>()
        };
        Self {
            blockers: KindGrid::new(of(false)),
            enforcers: KindGrid::new(of(true)),
        }
    }

    /// The same triangles with no grid: every query tests every triangle, as the scan did.
    #[cfg(test)]
    fn scan(faces: &[SeamFace]) -> Self {
        let of = |enforcer: bool| {
            let tris: Vec<[[f64; 3]; 3]> = faces
                .iter()
                .filter(|f| f.enforcer == enforcer)
                .map(|f| f.tri)
                .collect();
            KindGrid {
                boxes: tris.iter().map(bounds).collect(),
                tris,
                ..KindGrid::EMPTY
            }
        };
        Self {
            blockers: of(false),
            enforcers: of(true),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.blockers.tris.is_empty() && self.enforcers.tris.is_empty()
    }

    /// Whether a painted triangle of the given kind lies within `radius` of `p`.
    pub(crate) fn near(&self, p: [f64; 3], enforcer: bool, radius: f64) -> bool {
        if enforcer { &self.enforcers } else { &self.blockers }.near(p, radius)
    }
}

fn mm(p: IntPoint<i32>) -> (f64, f64) {
    (f64::from(p.x) / SCALE, f64::from(p.y) / SCALE)
}

#[allow(clippy::cast_possible_truncation, reason = "a point on the ring grid")]
fn unmm(x: f64, y: f64) -> IntPoint<i32> {
    IntPoint::new((x * SCALE).round() as i32, (y * SCALE).round() as i32)
}

/// The ring rotated to start at its painted seam, or `None` when nothing painted touches it (the
/// caller then uses the seam setting alone).
pub(crate) fn painted(
    c: &[IntPoint<i32>],
    faces: &SeamIndex,
    z: f64,
    mode: SeamPosition,
    cursor: Point,
    key: u64,
    radius: f64,
) -> Option<Vec<IntPoint<i32>>> {
    if faces.is_empty() || c.len() < 3 {
        return None;
    }
    let classify = |x: f64, y: f64| {
        if faces.near([x, y, z], false, radius) {
            Kind::Blocked
        } else if faces.near([x, y, z], true, radius) {
            Kind::Enforced
        } else {
            Kind::Neutral
        }
    };
    let n = c.len();
    let mut ring: Vec<IntPoint<i32>> = Vec::with_capacity(n);
    let mut kinds: Vec<Kind> = Vec::with_capacity(n);
    // Turns are read on the original vertices only; the extra points count as straight.
    let mut turns: Vec<f64> = Vec::with_capacity(n);
    for i in 0..n {
        let (a, b) = (*c.get(i)?, *c.get((i + 1) % n)?);
        let (ax, ay) = mm(a);
        let (bx, by) = mm(b);
        ring.push(a);
        kinds.push(classify(ax, ay));
        turns.push(crate::paths::turn_at(c, i).unwrap_or(0.0));
        let len = (bx - ax).m_hypot(by - ay);
        if len > OVERSAMPLE_MM && faces.near([ax, ay, z], true, len) {
            let mut step = OVERSAMPLE_MM;
            while step < len {
                let (x, y) = (ax + (bx - ax) * step / len, ay + (by - ay) * step / len);
                ring.push(unmm(x, y));
                kinds.push(classify(x, y));
                turns.push(0.0);
                step += OVERSAMPLE_MM;
            }
        }
    }
    if kinds.iter().all(|k| *k == Kind::Neutral) {
        return None;
    }
    let m = ring.len();
    let enforced = kinds.contains(&Kind::Enforced);
    let aligned = matches!(mode, SeamPosition::Aligned | SeamPosition::AlignedBack);
    let center = if enforced && aligned {
        central_enforced(&kinds, &turns)
    } else {
        None
    };
    let at = center.or_else(|| {
        let want = if enforced { Kind::Enforced } else { Kind::Neutral };
        let allowed: Vec<bool> = kinds
            .iter()
            .map(|k| if enforced { *k == want } else { *k != Kind::Blocked })
            .collect();
        let any = allowed.iter().any(|a| *a);
        crate::paths::seam_index(&ring, mode, cursor, key, any.then_some(allowed.as_slice()))
    })?;
    Some((0..m).filter_map(|i| ring.get((at + i) % m).copied()).collect())
}

/// The middle of the longest enforced stretch, or its sharpest-turn middle when it has sharp
/// corners. `None` when the whole ring is enforced.
fn central_enforced(kinds: &[Kind], turns: &[f64]) -> Option<usize> {
    let m = kinds.len();
    let is = |i: usize| kinds.get(i % m).copied() == Some(Kind::Enforced);
    // A stretch starts at an enforced point that follows a non-enforced one.
    let start = (0..m).find(|i| !is(*i))?;
    let mut best: Vec<usize> = Vec::new();
    let mut run: Vec<usize> = Vec::new();
    for k in 1..=m {
        let i = (start + k) % m;
        if is(i) {
            run.push(i);
        } else {
            if run.len() > best.len() {
                best = std::mem::take(&mut run);
            }
            run.clear();
        }
    }
    let sharp: Vec<usize> = best
        .iter()
        .copied()
        .filter(|i| turns.get(*i).is_some_and(|t| t.abs() > SHARP_TURN))
        .collect();
    if sharp.is_empty() {
        best.get(best.len() / 2).copied()
    } else {
        sharp.get(sharp.len() / 2).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance_to_a_triangle_covers_face_edge_and_corner() {
        let t = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [0.0, 10.0, 0.0]];
        assert!((dist2_to_triangle([2.0, 2.0, 3.0], &t) - 9.0).abs() < 1e-9);
        assert!((dist2_to_triangle([5.0, 5.0, 0.0], &t)).abs() < 1e-9);
        assert!((dist2_to_triangle([-3.0, -4.0, 0.0], &t) - 25.0).abs() < 1e-9);
        assert!((dist2_to_triangle([12.0, -1.0, 0.0], &t) - 5.0).abs() < 1e-9);
    }

    /// A small deterministic generator (xorshift), so the cases repeat.
    struct Rng(u64);

    impl Rng {
        #[allow(clippy::cast_precision_loss, reason = "a unit fraction")]
        fn unit(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }

        fn range(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (hi - lo) * self.unit()
        }
    }

    fn assert_same(faces: &[SeamFace], idx: &SeamIndex, p: [f64; 3], radius: f64) {
        for enforcer in [false, true] {
            assert_eq!(
                idx.near(p, enforcer, radius),
                near(p, faces, enforcer, radius),
                "{p:?} r {radius} enforcer {enforcer}"
            );
        }
    }

    /// Painted patches: a cluster of small triangles with a few long slivers, of both kinds.
    fn patch(rng: &mut Rng, n: usize, spread: f64) -> Vec<SeamFace> {
        (0..n)
            .map(|i| {
                let c = [
                    rng.range(0.0, spread),
                    rng.range(0.0, spread),
                    rng.range(0.0, 20.0),
                ];
                let size = if i % 17 == 0 { 30.0 } else { rng.range(0.05, 2.0) };
                let mut v = || {
                    [
                        c[0] + rng.range(-size, size),
                        c[1] + rng.range(-size, size),
                        c[2] + rng.range(-1.0, 1.0),
                    ]
                };
                SeamFace {
                    tri: [v(), v(), v()],
                    enforcer: rng.unit() < 0.6,
                }
            })
            .collect()
    }

    #[test]
    fn the_index_answers_as_testing_every_triangle() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for (n, spread) in [
            (0, 10.0),
            (1, 5.0),
            (3, 0.0),
            (40, 20.0),
            (400, 80.0),
            (3000, 200.0),
        ] {
            let faces = patch(&mut rng, n, spread);
            let idx = SeamIndex::new(&faces);
            assert_eq!(idx.is_empty(), faces.is_empty());
            for _ in 0..4000 {
                let p = [
                    rng.range(-20.0, spread + 20.0),
                    rng.range(-20.0, spread + 20.0),
                    rng.range(-2.0, 22.0),
                ];
                let radius = match rng.0 % 5 {
                    0 => 0.0,
                    1 => rng.range(0.0, 0.6),
                    2 => rng.range(0.6, 5.0),
                    3 => rng.range(5.0, 300.0),
                    _ => 0.42,
                };
                assert_same(&faces, &idx, p, radius);
            }
        }
    }

    #[test]
    fn a_point_exactly_one_radius_away_counts_as_near() {
        // Points at exactly the radius from a corner, an edge and the face (ties of the `<=` test).
        let faces = [
            SeamFace {
                tri: [[0.0, 0.0, 1.0], [4.0, 0.0, 1.0], [0.0, 4.0, 1.0]],
                enforcer: true,
            },
            SeamFace {
                tri: [[10.0, 10.0, 0.0], [10.5, 10.0, 0.0], [10.0, 10.5, 0.5]],
                enforcer: false,
            },
        ];
        let idx = SeamIndex::new(&faces);
        for (p, r) in [
            ([-0.5, 0.0, 1.0], 0.5),
            ([2.0, -0.25, 1.0], 0.25),
            ([1.0, 1.0, 1.75], 0.75),
            ([1.0, 1.0, 1.0], 0.0),
            ([9.5, 10.0, 0.0], 0.5),
            ([10.0, 9.0, 0.0], 1.0),
        ] {
            assert!(near(p, &faces, true, r) || near(p, &faces, false, r), "{p:?}");
            assert_same(&faces, &idx, p, r);
            // Just inside and just outside the tie.
            assert_same(&faces, &idx, p, r * (1.0 - 1e-15));
            assert_same(&faces, &idx, p, f64::from_bits(r.to_bits() + 1));
        }
        // Grid cell borders: points walked across the whole patch in steps finer than a cell.
        let mut rng = Rng(7);
        let many = patch(&mut rng, 600, 30.0);
        let big = SeamIndex::new(&many);
        for i in 0..300 {
            for j in 0..300 {
                let p = [f64::from(i) * 0.1 - 1.0, f64::from(j) * 0.1 - 1.0, 10.0];
                assert_same(&many, &big, p, 0.45);
            }
        }
    }

    #[test]
    fn empty_and_odd_inputs_match_too() {
        let none = SeamIndex::new(&[]);
        assert!(none.is_empty());
        assert!(NO_SEAMS.is_empty());
        assert!(!NO_SEAMS.near([0.0, 0.0, 0.0], true, 1e9));
        // One kind only: the other kind is never near.
        let only = [SeamFace {
            tri: [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            enforcer: true,
        }];
        let idx = SeamIndex::new(&only);
        assert!(idx.near([0.2, 0.2, 0.0], true, 0.1));
        assert!(!idx.near([0.2, 0.2, 0.0], false, 100.0));
        // Flat and degenerate triangles, a negative radius, and coordinates that are not finite.
        let odd = [
            SeamFace {
                tri: [[5.0, 5.0, 5.0]; 3],
                enforcer: true,
            },
            SeamFace {
                tri: [[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [6.0, 0.0, 0.0]],
                enforcer: false,
            },
            SeamFace {
                tri: [[f64::NAN, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
                enforcer: true,
            },
            SeamFace {
                tri: [[f64::INFINITY, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
                enforcer: false,
            },
            SeamFace {
                tri: [[20.0, 20.0, 0.0], [21.0, 20.0, 0.0], [20.0, 21.0, 0.0]],
                enforcer: true,
            },
        ];
        let idx = SeamIndex::new(&odd);
        for p in [
            [5.0, 5.3, 5.0],
            [4.0, 0.2, 0.0],
            [0.5, 0.9, 0.0],
            [20.2, 20.2, 0.3],
            [f64::NAN, 0.0, 0.0],
            [1e300, 0.0, 0.0],
        ] {
            for r in [0.0, 0.4, -0.4, 1.0, 50.0, f64::INFINITY, f64::NAN] {
                assert_same(&odd, &idx, p, r);
            }
        }
    }

    #[test]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "small test counts"
    )]
    fn a_painted_ring_starts_where_the_scan_puts_it() {
        let mut rng = Rng(0x2545_f491_4f6c_dd1d);
        let modes = [
            SeamPosition::Back,
            SeamPosition::Nearest,
            SeamPosition::Aligned,
            SeamPosition::AlignedBack,
            SeamPosition::Random,
        ];
        let mut placed = 0;
        for case in 0..60 {
            // A ring of 3 to 40 points around (50, 50), wobbly enough to have sharp corners.
            let n = 3 + case % 38;
            let r0 = rng.range(2.0, 20.0);
            let ring: Vec<IntPoint<i32>> = (0..n)
                .map(|i| {
                    let a = std::f64::consts::TAU * f64::from(i) / f64::from(n);
                    let r = r0 * rng.range(0.6, 1.0);
                    unmm(50.0 + r * a.m_cos(), 50.0 + r * a.m_sin())
                })
                .collect();
            // Painted pieces near the ring at this height, some touching it, some not.
            let z = rng.range(0.2, 10.0);
            let faces: Vec<SeamFace> = (0..rng.range(1.0, 300.0) as usize)
                .map(|_| {
                    let a = rng.range(0.0, std::f64::consts::TAU);
                    let r = r0 * rng.range(0.4, 1.3);
                    let c = [
                        50.0 + r * a.m_cos(),
                        50.0 + r * a.m_sin(),
                        z + rng.range(-0.6, 0.6),
                    ];
                    let s = rng.range(0.05, 3.0);
                    let mut v = || {
                        [
                            c[0] + rng.range(-s, s),
                            c[1] + rng.range(-s, s),
                            c[2] + rng.range(-s, s),
                        ]
                    };
                    SeamFace {
                        tri: [v(), v(), v()],
                        enforcer: rng.unit() < 0.7,
                    }
                })
                .collect();
            let (idx, scan) = (SeamIndex::new(&faces), SeamIndex::scan(&faces));
            let width = rng.range(0.3, 0.6);
            let cursor = Point::from_mm(rng.range(0.0, 100.0), rng.range(0.0, 100.0));
            for mode in modes {
                let got = painted(&ring, &idx, z, mode, cursor, case as u64, width);
                let want = painted(&ring, &scan, z, mode, cursor, case as u64, width);
                placed += usize::from(want.is_some());
                assert_eq!(got, want, "case {case} {mode:?}");
            }
        }
        // Most cases touch paint, so the comparison covers placed seams, not only `None`.
        assert!(placed > 150, "{placed}");
        assert_eq!(
            painted(
                &[unmm(0.0, 0.0); 4],
                &NO_SEAMS,
                0.0,
                SeamPosition::Back,
                Point::from_mm(0.0, 0.0),
                0,
                0.4
            ),
            None
        );
    }
}
