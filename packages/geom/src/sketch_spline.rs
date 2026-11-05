// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! splines through points: centripetal catmull-rom, each span a cubic bezier
// span indices stay inside the point lists built here
#![allow(clippy::indexing_slicing)]

use crate::fm::Fm;
use crate::vec3::V2;

/// chord error of a flattened spline, mm; arcs use the same, half the default slice resolution
pub const TOL_MM: f64 = 0.005;
const MAX_STEPS: usize = 1024;

fn sub(a: V2, b: V2) -> V2 {
    [a[0] - b[0], a[1] - b[1]]
}

fn len(a: V2) -> f64 {
    a[0].m_hypot(a[1])
}

// the knot step: square root of the chord, so no cusps or loops inside a span
fn knot(a: V2, b: V2) -> f64 {
    len(sub(b, a)).sqrt().max(1e-12)
}

/// the bezier of the span from `p1` to `p2`, with `p0` before it and `p3` after
pub fn span(p0: V2, p1: V2, p2: V2, p3: V2) -> [V2; 4] {
    let (t01, t12, t23) = (knot(p0, p1), knot(p1, p2), knot(p2, p3));
    // tangents at p1 and p2, scaled to the span
    let m1 = |i: usize| p2[i] - p1[i] + t12 * ((p1[i] - p0[i]) / t01 - (p2[i] - p0[i]) / (t01 + t12));
    let m2 = |i: usize| p2[i] - p1[i] + t12 * ((p3[i] - p2[i]) / t23 - (p3[i] - p1[i]) / (t12 + t23));
    let (m1, m2) = ([m1(0), m1(1)], [m2(0), m2(1)]);
    [
        p1,
        [p1[0] + m1[0] / 3.0, p1[1] + m1[1] / 3.0],
        [p2[0] - m2[0] / 3.0, p2[1] - m2[1] / 3.0],
        p2,
    ]
}

/// the spans through `pts`, closing round to the first when `closed`; open ends mirror their neighbor
#[allow(
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    reason = "point counts are small"
)]
pub fn spans(pts: &[V2], closed: bool) -> Vec<[V2; 4]> {
    let n = pts.len();
    if n < 2 {
        return Vec::new();
    }
    let last = n as isize - 1;
    let at = |i: isize| -> V2 {
        if closed {
            return pts[i.rem_euclid(n as isize) as usize];
        }
        let mirror = |a: V2, b: V2| [2.0 * a[0] - b[0], 2.0 * a[1] - b[1]];
        if i < 0 {
            mirror(pts[0], pts[1])
        } else if i > last {
            mirror(pts[n - 1], pts[n - 2])
        } else {
            pts[i as usize]
        }
    };
    let count = if closed { n } else { n - 1 };
    (0..count as isize)
        .map(|i| span(at(i - 1), at(i), at(i + 1), at(i + 2)))
        .collect()
}

/// the points after `b[0]` along the span, every chord within [`TOL_MM`]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "clamped"
)]
pub fn flatten(b: &[V2; 4]) -> Vec<V2> {
    // a polyline's error is at most h^2/8 of the largest second derivative
    let dd = |i: usize, j: usize, k: usize| {
        len([
            b[i][0] - 2.0 * b[j][0] + b[k][0],
            b[i][1] - 2.0 * b[j][1] + b[k][1],
        ])
    };
    let m = 6.0 * dd(0, 1, 2).max(dd(1, 2, 3));
    let n = ((m / (8.0 * TOL_MM)).sqrt().ceil() as usize).clamp(1, MAX_STEPS);
    (1..=n)
        .map(|s| {
            if s == n {
                return b[3];
            }
            let t = s as f64 / n as f64;
            let u = 1.0 - t;
            let (w0, w1, w2, w3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            [
                w0 * b[0][0] + w1 * b[1][0] + w2 * b[2][0] + w3 * b[3][0],
                w0 * b[0][1] + w1 * b[1][1] + w2 * b[2][1] + w3 * b[3][1],
            ]
        })
        .collect()
}

/// the unit direction the span leaves its end in
pub fn end_dir(b: &[V2; 4]) -> V2 {
    let d = [sub(b[3], b[2]), sub(b[3], b[1]), sub(b[3], b[0])]
        .into_iter()
        .find(|d| len(*d) > 1e-12)
        .unwrap_or([1.0, 0.0]);
    let l = len(d);
    [d[0] / l, d[1] / l]
}

/// twice the signed area the spans sweep about the origin, exact for cubic beziers
pub fn area2(spans: &[[V2; 4]]) -> f64 {
    let cr = |a: V2, b: V2| a[0] * b[1] - a[1] * b[0];
    spans
        .iter()
        .map(|b| {
            let [p0, p1, p2, p3] = *b;
            (6.0 * cr(p0, p1)
                + 3.0 * cr(p0, p2)
                + cr(p0, p3)
                + 3.0 * cr(p1, p2)
                + 3.0 * cr(p1, p3)
                + 6.0 * cr(p2, p3))
                / 10.0
        })
        .sum()
}

#[cfg(test)]
#[allow(clippy::float_cmp, reason = "the span ends are the points given")]
mod tests {
    use super::*;

    #[test]
    fn a_span_passes_its_points() {
        let s = spans(&[[0.0, 0.0], [10.0, 5.0], [20.0, 0.0]], false);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0][0], [0.0, 0.0]);
        assert_eq!(s[0][3], [10.0, 5.0]);
        assert_eq!(s[1][3], [20.0, 0.0]);
        // c1 at the shared point
        let a = end_dir(&s[0]);
        let b = sub(s[1][1], s[1][0]);
        assert!((a[0] * b[1] - a[1] * b[0]).abs() < 1e-9, "{a:?} {b:?}");
    }

    #[test]
    fn a_straight_run_stays_straight() {
        let s = spans(&[[0.0, 0.0], [1.0, 0.0], [5.0, 0.0], [6.0, 0.0]], false);
        for b in &s {
            for p in flatten(b) {
                assert!(p[1].abs() < 1e-12, "{p:?}");
            }
        }
    }

    #[test]
    fn the_exact_area_matches_a_fine_polyline() {
        let pts: Vec<V2> = (0..7)
            .map(|i| {
                let a = f64::from(i) * std::f64::consts::TAU / 7.0;
                let r = if i % 2 == 0 { 20.0 } else { 14.0 };
                [r * a.m_cos(), r * a.m_sin()]
            })
            .collect();
        let s = spans(&pts, true);
        let mut ring = vec![s[0][0]];
        for b in &s {
            ring.extend(flatten(b));
        }
        ring.pop();
        let poly: f64 = (0..ring.len())
            .map(|i| {
                let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
                a[0] * b[1] - a[1] * b[0]
            })
            .sum();
        let exact = area2(&s);
        let per: f64 = (0..ring.len())
            .map(|i| len(sub(ring[(i + 1) % ring.len()], ring[i])))
            .sum();
        assert!((poly - exact).abs() / 2.0 <= per * TOL_MM, "{poly} {exact}");
    }
}
