// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Fitting shared by the sketch imports: the segment builder, circles, spline error, placement, tidy and counts.
// sample and span indices stay inside the lists built here
#![allow(clippy::indexing_slicing)]

use crate::fm::Fm;
use crate::sketch::{CLOSE_MM, Loop, Segment};
use crate::sketch_spline;
use crate::vec3::V2;
use serde::Serialize;

/// Shorter than this a piece is dropped.
pub const MIN_MM: f64 = 1e-4;
/// The most points one spline takes.
pub const MAX_SAMPLES: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub lines: usize,
    pub arcs: usize,
    pub splines: usize,
    pub circles: usize,
}

pub(crate) fn sub2(a: V2, b: V2) -> V2 {
    [a[0] - b[0], a[1] - b[1]]
}

pub(crate) fn dist(a: V2, b: V2) -> f64 {
    (a[0] - b[0]).m_hypot(a[1] - b[1])
}

/// a cubic bezier at `t`
pub(crate) fn bez(p: &[V2; 4], t: f64) -> V2 {
    let u = 1.0 - t;
    let (w0, w1, w2, w3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    [
        w0 * p[0][0] + w1 * p[1][0] + w2 * p[2][0] + w3 * p[3][0],
        w0 * p[0][1] + w1 * p[1][1] + w2 * p[2][1] + w3 * p[3][1],
    ]
}

pub(crate) fn circumcenter(a: V2, b: V2, c: V2) -> Option<V2> {
    let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    let scale = dist(a, b).max(dist(a, c)).max(1e-9);
    if d.abs() < 1e-9 * scale * scale {
        return None;
    }
    let (a2, b2, c2) = (
        a[0] * a[0] + a[1] * a[1],
        b[0] * b[0] + b[1] * b[1],
        c[0] * c[0] + c[1] * c[1],
    );
    Some([
        (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
        (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
    ])
}

/// how far `p` is from the segment `a`-`b`
pub(crate) fn to_segment(p: V2, a: V2, b: V2) -> f64 {
    let ab = sub2(b, a);
    let l2 = ab[0] * ab[0] + ab[1] * ab[1];
    let t = if l2 > 0.0 {
        (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    dist(p, [a[0] + t * ab[0], a[1] + t * ab[1]])
}

/// The farthest the spline through `through` strays from `at`, the curve it follows: span `j` at `s` against
/// `at(j, s)`, a few points inside each span.
pub fn spline_error(through: &[V2], at: impl Fn(usize, f64) -> V2) -> f64 {
    sketch_spline::spans(through, false)
        .iter()
        .enumerate()
        .flat_map(|(j, b)| {
            let at = &at;
            (1..4).map(move |q| {
                let s = f64::from(q) / 4.0;
                dist(bez(b, s), at(j, s))
            })
        })
        .fold(0.0, f64::max)
}

/// Builds one loop's segments: lines, three point arcs and splines, with each arc's circle kept.
pub struct Builder {
    pub segs: Vec<Segment>,
    // each arc's center and radius, for loops that are whole circles
    round: Vec<Option<(V2, f64)>>,
    pub at: V2,
    start: V2,
}

impl Builder {
    pub fn new(start: V2) -> Self {
        Self {
            segs: Vec::new(),
            round: Vec::new(),
            at: start,
            start,
        }
    }

    pub fn line(&mut self, to: V2) {
        if dist(self.at, to) < MIN_MM {
            return;
        }
        self.segs.push(Segment {
            kind: "line".into(),
            to: Some(to),
            ..Segment::default()
        });
        self.round.push(None);
        self.at = to;
    }

    pub fn arc(&mut self, to: V2, through: V2, center: V2, radius: f64) {
        // a sliver of an arc is a line; the three point form refuses it
        if dist(self.at, to) < MIN_MM || to_segment(through, self.at, to) < MIN_MM {
            self.line(to);
        } else {
            self.segs.push(Segment {
                kind: "arc".into(),
                to: Some(to),
                through: Some(through),
                ..Segment::default()
            });
            self.round.push(Some((center, radius)));
            self.at = to;
        }
    }

    pub fn spline(&mut self, to: V2, points: Vec<V2>) {
        self.segs.push(Segment {
            kind: "spline".into(),
            to: Some(to),
            points,
            ..Segment::default()
        });
        self.round.push(None);
        self.at = to;
    }

    /// The loop, closed back to its start, or None when under two pieces are left; arcs round one center all the
    /// way within `tol` are a circle.
    pub fn finish(mut self, tol: f64) -> Option<Loop> {
        let start = self.start;
        if dist(self.at, start) >= CLOSE_MM {
            self.line(start);
        } else if let Some(last) = self.segs.last_mut() {
            last.to = Some(start);
        }
        if self.segs.len() < 2 {
            return None;
        }
        if let Some(Some((c, r))) = self.round.first().copied() {
            let whole = self
                .round
                .iter()
                .all(|x| x.is_some_and(|(c2, r2)| dist(c, c2) <= tol && (r - r2).abs() <= tol));
            if whole {
                return Some(circle(c, r));
            }
        }
        Some(Loop {
            start: Some(start),
            segments: self.segs,
            ..Loop::default()
        })
    }
}

/// A circle loop.
pub fn circle(center: V2, radius: f64) -> Loop {
    Loop {
        kind: Some("circle".into()),
        center: Some(center),
        diameter_mm: Some(2.0 * radius),
        ..Loop::default()
    }
}

/// The scale and shift that put the middle of `lo` to `hi`, times `f`, at `center`: `[f, 0, 0, f, dx, dy]`.
pub fn placement(lo: V2, hi: V2, f: f64, center: V2) -> [f64; 6] {
    let mid = [f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1])];
    [f, 0.0, 0.0, f, center[0] - f * mid[0], center[1] - f * mid[1]]
}

/// to a millionth of a mm, and never -0
pub fn tidy(v: f64) -> f64 {
    (v * 1e6).round() / 1e6 + 0.0
}

fn tidy2(p: V2) -> V2 {
    [tidy(p[0]), tidy(p[1])]
}

pub fn tidy_loop(l: &mut Loop) {
    l.start = l.start.map(tidy2);
    l.center = l.center.map(tidy2);
    l.diameter_mm = l.diameter_mm.map(tidy);
    for s in &mut l.segments {
        s.to = s.to.map(tidy2);
        s.through = s.through.map(tidy2);
        for p in &mut s.points {
            *p = tidy2(*p);
        }
    }
}

pub fn count(loops: &[Loop]) -> Counts {
    let mut n = Counts::default();
    for l in loops {
        if l.kind.as_deref() == Some("circle") {
            n.circles += 1;
        }
        for s in &l.segments {
            match s.kind.as_str() {
                "line" => n.lines += 1,
                "arc" => n.arcs += 1,
                _ => n.splines += 1,
            }
        }
    }
    n
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::float_cmp)]
    use super::*;

    #[test]
    fn a_loop_closes_to_its_start_and_drops_slivers() {
        let mut b = Builder::new([0.0, 0.0]);
        b.line([10.0, 0.0]);
        b.line([10.0, 0.00001]);
        b.line([10.0, 10.0]);
        // ends a hair from the start, so the last piece moves onto it
        b.line([0.0, 0.0005]);
        let l = b.finish(0.01).unwrap();
        assert_eq!(l.start, Some([0.0, 0.0]));
        assert_eq!(l.segments.len(), 3);
        assert_eq!(l.segments[2].to, Some([0.0, 0.0]));
        // nothing but slivers is no loop
        let mut none = Builder::new([0.0, 0.0]);
        none.line([0.00005, 0.0]);
        assert!(none.finish(0.01).is_none());
        let mut open = Builder::new([0.0, 0.0]);
        open.line([5.0, 0.0]);
        open.line([5.0, 5.0]);
        assert_eq!(open.finish(0.01).unwrap().segments.len(), 3);
    }

    #[test]
    fn arcs_round_one_center_make_a_circle_and_others_stay_arcs() {
        let mut b = Builder::new([10.0, 0.0]);
        b.arc([-10.0, 0.0], [0.0, 10.0], [0.0, 0.0], 10.0);
        b.arc([10.0, 0.0], [0.0, -10.0], [0.0, 0.0], 10.0);
        let l = b.finish(0.01).unwrap();
        assert_eq!(l.kind.as_deref(), Some("circle"));
        assert_eq!(l.diameter_mm, Some(20.0));
        let mut s = Builder::new([10.0, 0.0]);
        s.arc([-10.0, 0.0], [0.0, 10.0], [0.0, 0.0], 10.0);
        s.line([10.0, 0.0]);
        let l = s.finish(0.01).unwrap();
        assert_eq!(l.kind, None);
        assert_eq!(
            count(&[l]),
            Counts {
                lines: 1,
                arcs: 1,
                splines: 0,
                circles: 0
            }
        );
        // a sliver of an arc is a line
        let mut t = Builder::new([0.0, 0.0]);
        t.arc([10.0, 0.0], [5.0, 0.00001], [5.0, -1e6], 1e6);
        assert_eq!(t.segs[0].kind, "line");
    }

    #[test]
    fn a_spline_through_points_of_a_line_is_on_it() {
        let line = |j: usize, s: f64| [10.0 * (j as f64 + s), 0.0];
        let through: Vec<V2> = (0..4).map(|k| [10.0 * f64::from(k), 0.0]).collect();
        assert!(spline_error(&through, line) < 1e-12);
        let bent = [[0.0, 0.0], [10.0, 3.0], [20.0, 0.0]];
        assert!(spline_error(&bent, line) > 1.0);
    }

    #[test]
    fn placement_puts_the_middle_at_the_center_and_tidy_rounds() {
        let p = placement([0.0, 0.0], [10.0, 4.0], 2.0, [100.0, 50.0]);
        assert_eq!(p, [2.0, 0.0, 0.0, 2.0, 90.0, 46.0]);
        assert_eq!(tidy(-0.000_000_1), 0.0);
        assert!(tidy(-0.000_000_1).is_sign_positive());
        assert_eq!(tidy(1.234_567_89), 1.234_568);
        let mut l = circle([1.000_000_4, 2.0], 3.000_000_4);
        tidy_loop(&mut l);
        assert_eq!((l.center, l.diameter_mm), (Some([1.0, 2.0]), Some(6.000_001)));
    }
}
