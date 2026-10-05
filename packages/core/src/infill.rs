// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Stages 4 and 5: surfaces and infill on scanlines.
//!
//! Regions are sampled on a global grid of diagonal scanlines, and top, bottom
//! and sparse areas are interval arithmetic on those lines. The same lines are
//! the infill, so classification and line generation are one pass. Lines at
//! 45 degrees satisfy `y - x = s`; lines at 135 degrees satisfy `x + y = s`.
//! Both keep integer coordinates exact. Scanline k sits at `s = k * spacing`
//! on every layer, so sparse infill stacks from layer to layer.

use crate::geom::Point;
use i_overlay::i_float::int::point::IntPoint;

/// Scanline direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Dir {
    D45,
    D135,
}

impl Dir {
    pub(crate) fn for_layer(layer: u32) -> Self {
        if layer.is_multiple_of(2) {
            Self::D45
        } else {
            Self::D135
        }
    }

    pub(crate) fn st(self, x: i32, y: i32) -> (i64, i64) {
        let (x, y) = (i64::from(x), i64::from(y));
        match self {
            Self::D45 => (y - x, x + y),
            Self::D135 => (x + y, y - x),
        }
    }

    #[allow(clippy::cast_possible_truncation, reason = "results are plate coordinates")]
    pub(crate) fn point(self, s: i64, t: i64) -> Point {
        match self {
            Self::D45 => Point::new(((t - s).div_euclid(2)) as i32, ((t + s).div_euclid(2)) as i32),
            Self::D135 => Point::new(((s - t).div_euclid(2)) as i32, ((s + t).div_euclid(2)) as i32),
        }
    }
}

/// One inside span on scanline `k`, from `t0` to `t1` along the line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Iv {
    pub(crate) k: i32,
    pub(crate) t0: i64,
    pub(crate) t1: i64,
}

/// Spans sorted by `(k, t0)`, disjoint within each line.
pub(crate) type Spans = Vec<Iv>;

/// A scanline family: direction and spacing in `s` units.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Family {
    pub(crate) dir: Dir,
    pub(crate) spacing: i64,
}

impl Family {
    /// Spans of the area enclosed by `contours` (even-odd, so contours of
    /// disjoint regions can be mixed). Touching spans merge.
    pub(crate) fn scan<'a>(
        self,
        contours: impl Iterator<Item = &'a [IntPoint<i32>]>,
        events: &mut Vec<(i32, i64)>,
    ) -> Spans {
        events.clear();
        let sp = self.spacing.max(1);
        for c in contours {
            let Some(last) = c.last() else { continue };
            let mut prev = self.dir.st(last.x, last.y);
            for p in c {
                let cur = self.dir.st(p.x, p.y);
                let (a, b) = (prev, cur);
                prev = cur;
                if a.0 == b.0 {
                    continue;
                }
                let (lo, hi) = if a.0 < b.0 { (a, b) } else { (b, a) };
                // Lines with lo.s <= s < hi.s cross this edge.
                let k0 = ceil_div(lo.0, sp);
                let k1 = ceil_div(hi.0, sp);
                // Products stay below 2^50 on any bed that fits i32 coordinates,
                // so i64 is exact (and i128 division is slow).
                let ds = hi.0 - lo.0;
                let dt = hi.1 - lo.1;
                for k in k0..k1 {
                    let s = k * sp;
                    #[allow(clippy::cast_possible_truncation, reason = "t stays between the edge ends")]
                    let t = lo.1 + (s - lo.0) * dt / ds;
                    #[allow(
                        clippy::cast_possible_truncation,
                        reason = "scanline index on a bed fits in i32"
                    )]
                    events.push((k as i32, t));
                }
            }
        }
        events.sort_unstable();
        let mut out: Spans = Vec::with_capacity(events.len() / 2);
        let mut i = 0;
        while let (Some(&(ka, ta)), Some(&(kb, tb))) = (events.get(i), events.get(i + 1)) {
            if ka != kb {
                i += 1;
                continue;
            }
            match out.last_mut() {
                Some(l) if l.k == ka && ta <= l.t1 => l.t1 = l.t1.max(tb),
                _ if tb > ta => out.push(Iv {
                    k: ka,
                    t0: ta,
                    t1: tb,
                }),
                _ => {}
            }
            i += 2;
        }
        out
    }
}

fn ceil_div(a: i64, b: i64) -> i64 {
    let q = a.div_euclid(b);
    if q * b == a { q } else { q + 1 }
}

#[cfg(test)]
/// Spans in both `a` and `b`.
pub(crate) fn intersect(a: &[Iv], b: &[Iv]) -> Spans {
    let mut out = Vec::with_capacity(a.len().min(b.len()));
    let (mut i, mut j) = (0, 0);
    while let (Some(x), Some(y)) = (a.get(i), b.get(j)) {
        if x.k != y.k {
            if x.k < y.k {
                i += 1;
            } else {
                j += 1;
            }
            continue;
        }
        let t0 = x.t0.max(y.t0);
        let t1 = x.t1.min(y.t1);
        if t0 < t1 {
            out.push(Iv { k: x.k, t0, t1 });
        }
        if x.t1 < y.t1 { i += 1 } else { j += 1 }
    }
    out
}

#[cfg(test)]
/// Spans of `a` not in `b`.
pub(crate) fn subtract(a: &[Iv], b: &[Iv]) -> Spans {
    let mut out = Vec::with_capacity(a.len());
    let mut j = 0;
    for x in a {
        while b
            .get(j)
            .is_some_and(|y| y.k < x.k || (y.k == x.k && y.t1 <= x.t0))
        {
            j += 1;
        }
        let mut t0 = x.t0;
        let mut jj = j;
        while let Some(y) = b.get(jj) {
            if y.k != x.k || y.t0 >= x.t1 {
                break;
            }
            if y.t0 > t0 {
                out.push(Iv { k: x.k, t0, t1: y.t0 });
            }
            t0 = t0.max(y.t1);
            jj += 1;
        }
        if t0 < x.t1 {
            out.push(Iv { k: x.k, t0, t1: x.t1 });
        }
    }
    out
}

/// Shortens each span by `trim` at both ends and drops spans shorter than `min_len`.
pub(crate) fn trim(spans: &mut Spans, trim: i64, min_len: i64) {
    spans.retain_mut(|iv| {
        iv.t0 += trim;
        iv.t1 -= trim;
        iv.t1 - iv.t0 >= min_len
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iv(k: i32, t0: i64, t1: i64) -> Iv {
        Iv { k, t0, t1 }
    }

    #[test]
    fn interval_ops() {
        let a = vec![iv(0, 0, 10), iv(1, 0, 10), iv(2, 5, 6)];
        let b = vec![iv(0, 2, 4), iv(0, 6, 12), iv(2, 0, 20)];
        assert_eq!(intersect(&a, &b), vec![iv(0, 2, 4), iv(0, 6, 10), iv(2, 5, 6)]);
        assert_eq!(subtract(&a, &b), vec![iv(0, 0, 2), iv(0, 4, 6), iv(1, 0, 10)]);
    }

    #[test]
    fn square_scans_to_spans() {
        let sq = [
            IntPoint::new(0, 0),
            IntPoint::new(100, 0),
            IntPoint::new(100, 100),
            IntPoint::new(0, 100),
        ];
        let fam = Family {
            dir: Dir::D45,
            spacing: 10,
        };
        let mut ev = Vec::new();
        let spans = fam.scan(std::iter::once(&sq[..]), &mut ev);
        // y - x runs from -100 to 100: lines k = -10..=9 (k = 10 touches only a corner).
        assert_eq!(spans.len(), 19);
        for s in &spans {
            let a = Dir::D45.point(i64::from(s.k) * 10, s.t0);
            assert!(a.x >= -1 && a.x <= 101 && a.y >= -1 && a.y <= 101);
        }
    }
}
