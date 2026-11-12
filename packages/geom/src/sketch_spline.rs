// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! splines through points: centripetal catmull-rom, each span a cubic bezier
// span indices stay inside the point lists built here
#![allow(clippy::indexing_slicing)]

use crate::fm::Fm;
use crate::vec3::V2;

/// chord error of a flattened spline, mm; arcs use the same, half the default slice resolution
pub const TOL_MM: f64 = 0.005;
/// most steps one span may take; a span that needs more is refused, so the tolerance holds
pub const MAX_STEPS: usize = 1024;

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

/// the steps that keep every chord of the span within [`TOL_MM`], or None past [`MAX_STEPS`]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "checked against MAX_STEPS first"
)]
pub fn steps(b: &[V2; 4]) -> Option<usize> {
    // a polyline's error is at most h^2/8 of the largest second derivative
    let dd = |i: usize, j: usize, k: usize| {
        len([
            b[i][0] - 2.0 * b[j][0] + b[k][0],
            b[i][1] - 2.0 * b[j][1] + b[k][1],
        ])
    };
    let m = 6.0 * dd(0, 1, 2).max(dd(1, 2, 3));
    let n = (m / (8.0 * TOL_MM)).sqrt().ceil();
    (n.is_finite() && n <= MAX_STEPS as f64).then(|| (n as usize).max(1))
}

/// why a spline was not flattened
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dense {
    /// span `n` bends too sharply for [`MAX_STEPS`]
    Span(usize),
    /// more points than the budget allows
    Budget,
}

/// the points after the first along the spline through `pts`, at most `budget` of them
pub fn flatten_all(pts: &[V2], closed: bool, budget: usize) -> Result<Vec<V2>, Dense> {
    // each span takes a step at least
    if pts.len().saturating_sub(usize::from(!closed)) > budget {
        return Err(Dense::Budget);
    }
    let mut out = Vec::new();
    for (k, b) in spans(pts, closed).iter().enumerate() {
        let n = steps(b).ok_or(Dense::Span(k))?;
        if out.len() + n > budget {
            return Err(Dense::Budget);
        }
        out.extend(flatten(b, n));
    }
    Ok(out)
}

/// the `n` points after `b[0]` along the span
#[allow(clippy::cast_precision_loss, reason = "n is at most MAX_STEPS")]
pub fn flatten(b: &[V2; 4], n: usize) -> Vec<V2> {
    (1..=n)
        .map(|s| {
            if s == n {
                return b[3];
            }
            point(b, s as f64 / n as f64)
        })
        .collect()
}

/// the point at `t` along the span, from 0 at its start to 1 at its end
pub fn point(b: &[V2; 4], t: f64) -> V2 {
    let u = 1.0 - t;
    let (w0, w1, w2, w3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    [
        w0 * b[0][0] + w1 * b[1][0] + w2 * b[2][0] + w3 * b[3][0],
        w0 * b[0][1] + w1 * b[1][1] + w2 * b[2][1] + w3 * b[3][1],
    ]
}

/// the unit direction the span leaves its start in
pub fn start_dir(b: &[V2; 4]) -> V2 {
    let d = [sub(b[1], b[0]), sub(b[2], b[0]), sub(b[3], b[0])]
        .into_iter()
        .find(|d| len(*d) > 1e-12)
        .unwrap_or([1.0, 0.0]);
    let l = len(d);
    [d[0] / l, d[1] / l]
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

    const GOLDEN_LEN: usize = 102;
    const GOLDEN_P7: V2 = [4.959_081_098_252_148, 2.464_100_649_779_922];

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

    fn off_chord(p: V2, a: V2, b: V2) -> f64 {
        let ab = sub(b, a);
        let l2 = ab[0] * ab[0] + ab[1] * ab[1];
        let t = if l2 < 1e-24 {
            0.0
        } else {
            (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2).clamp(0.0, 1.0)
        };
        len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]))
    }

    #[test]
    #[allow(clippy::cast_precision_loss, reason = "small counts")]
    fn every_chord_stays_within_the_tolerance() {
        let star: Vec<V2> = (0..9)
            .map(|i| {
                let a = f64::from(i) * std::f64::consts::TAU / 9.0;
                let r = if i % 2 == 0 { 40.0 } else { 3.0 };
                [r * a.m_cos(), r * a.m_sin()]
            })
            .collect();
        let shapes: [(Vec<V2>, bool); 4] = [
            (star, true),
            // a hairpin: out and straight back
            (vec![[0.0, 0.0], [50.0, 0.0], [50.0, 0.5], [0.0, 0.5]], false),
            // one long span between short ones
            (vec![[0.0, 0.0], [1.0, 1.0], [800.0, 1.0], [801.0, 0.0]], false),
            (vec![[0.0, 0.0], [30.0, 20.0], [60.0, -20.0], [90.0, 0.0]], false),
        ];
        for (pts, closed) in &shapes {
            for b in &spans(pts, *closed) {
                let n = steps(b).unwrap();
                let mut poly = vec![b[0]];
                poly.extend(flatten(b, n));
                let mut worst = 0.0f64;
                for k in 0..n {
                    for j in 0..=64 {
                        let t = (k as f64 + f64::from(j) / 64.0) / n as f64;
                        worst = worst.max(off_chord(point(b, t), poly[k], poly[k + 1]));
                    }
                }
                assert!(worst <= TOL_MM + 1e-12, "{worst} on {b:?}");
            }
        }
    }

    #[test]
    fn a_span_past_max_steps_is_refused() {
        let s = spans(&[[0.0, 0.0], [90_000.0, 0.0], [90_000.0, 10.0]], false);
        assert!(s.iter().any(|b| steps(b).is_none()));
        assert!(matches!(
            flatten_all(
                &[[0.0, 0.0], [90_000.0, 0.0], [90_000.0, 10.0]],
                false,
                usize::MAX
            ),
            Err(Dense::Span(_))
        ));
        let ok = [[0.0, 0.0], [10.0, 5.0], [20.0, 0.0]];
        let n = flatten_all(&ok, false, usize::MAX).unwrap().len();
        assert_eq!(flatten_all(&ok, false, n - 1), Err(Dense::Budget));
        assert_eq!(flatten_all(&ok, false, n).map(|f| f.len()), Ok(n));
    }

    #[test]
    fn the_end_direction_falls_back_past_a_handle_on_the_end() {
        assert_eq!(
            end_dir(&[[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [2.0, 0.0]]),
            [1.0, 0.0]
        );
        assert_eq!(
            end_dir(&[[0.0, 0.0], [0.0, 2.0], [0.0, 2.0], [0.0, 2.0]]),
            [0.0, 1.0]
        );
    }

    #[test]
    fn a_fixed_spline_flattens_the_same_everywhere() {
        let pts: Vec<V2> = vec![[6.0, 0.0], [2.0, 5.0], [-5.0, 3.0], [-4.0, -4.0], [3.0, -5.0]];
        let flat = flatten_all(&pts, true, usize::MAX).unwrap();
        assert_eq!(flat.len(), GOLDEN_LEN);
        let p = flat[7];
        assert!(
            (p[0] - GOLDEN_P7[0]).abs() < 1e-12 && (p[1] - GOLDEN_P7[1]).abs() < 1e-12,
            "{p:?}"
        );
    }

    #[test]
    fn a_straight_run_stays_straight() {
        let s = spans(&[[0.0, 0.0], [1.0, 0.0], [5.0, 0.0], [6.0, 0.0]], false);
        for b in &s {
            for p in flatten(b, steps(b).unwrap()) {
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
            ring.extend(flatten(b, steps(b).unwrap()));
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
