// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where tips go along an overhang: fill lines laid over the overhang (spec 4.8), and points spaced
//! along those lines (spec 4.9).

use super::ops::{self, P};
use super::params::Params;
use crate::geom::{Point, SCALE};
use crate::perimeters::Shapes;

/// The pattern lines are drawn with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Lines {
    /// Base lines, `distance` mm apart in the gaps.
    Base { distance: f64 },
    /// Roof lines at the top interface density, for the roof on `layer`.
    Roof { layer: usize },
}

/// Fill lines over `area`, as polylines.
pub(crate) fn lines(p: &Params, area: &Shapes, kind: Lines, center: [f64; 2]) -> Vec<Vec<P>> {
    if area.is_empty() {
        return Vec::new();
    }
    let spacing = p.spacing();
    let (pitch, angle) = match kind {
        Lines::Base { distance } => (spacing + distance.max(0.0), p.s.support_angle),
        Lines::Roof { layer } => {
            // Q2: the reference always lays them at -45 degrees; meant was 45 degrees either side of the
            // interface angle, turning from layer to layer.
            let angle = if p.s.quirks.roof_angle_fixed {
                -45.0
            } else if layer.is_multiple_of(2) {
                p.s.support_angle + 90.0 + 45.0
            } else {
                p.s.support_angle + 90.0 - 45.0
            };
            (spacing + p.s.interface_spacing.max(0.0), angle)
        }
    };
    let mut out = Vec::new();
    for island in ops::islands(area) {
        // Joined like the normal infill, so a walk over one joined line spaces tips across rows too.
        let ls: Vec<Vec<Point>> = crate::patterns::support_lines(
            &island,
            p.w,
            pitch.max(p.w * 0.5),
            angle,
            false,
            p.s.line_join.max(0.0),
            center,
        );
        out.extend(
            ls.into_iter()
                .filter(|l| l.len() >= 2)
                .map(|l| l.into_iter().map(|q| P::new(q.x, q.y)).collect()),
        );
    }
    out
}

fn fx(p: P) -> (f64, f64) {
    (f64::from(p.x), f64::from(p.y))
}

/// The first point on segment `a`-`b`, at or after parameter `t0`, at distance `r` (units) from `c`,
/// going outward; None when the segment stays inside the circle.
fn leave_circle(a: P, b: P, t0: f64, c: (f64, f64), r: f64) -> Option<f64> {
    let (ax, ay) = fx(a);
    let (bx, by) = fx(b);
    let (dx, dy) = (bx - ax, by - ay);
    let (fx0, fy0) = (ax - c.0, ay - c.1);
    let qa = dx * dx + dy * dy;
    if qa <= 0.0 {
        return None;
    }
    let qb = 2.0 * (fx0 * dx + fy0 * dy);
    let qc = fx0 * fx0 + fy0 * fy0 - r * r;
    let disc = qb * qb - 4.0 * qa * qc;
    if disc < 0.0 {
        return None;
    }
    let sq = disc.sqrt();
    let t = (-qb + sq) / (2.0 * qa);
    (t >= t0 - 1e-12 && t <= 1.0 + 1e-12).then_some(t.max(t0))
}

fn lerp(a: P, b: P, t: f64) -> P {
    let (ax, ay) = fx(a);
    let (bx, by) = fx(b);
    ops::to_p(ax + (bx - ax) * t, ay + (by - ay) * t)
}

/// The two vertices farthest apart (by index); for long rings an approximate pair.
fn farthest_pair(pl: &[P]) -> (usize, usize) {
    let n = pl.len();
    let stride = (n / 400).max(1);
    let mut best = (0, 0, 0i64);
    for i in (0..n).step_by(stride) {
        let Some(&a) = pl.get(i) else { continue };
        for j in (i + 1..n).step_by(stride) {
            let Some(&b) = pl.get(j) else { continue };
            let d = crate::geom::Point::new(a.x, a.y).dist2(crate::geom::Point::new(b.x, b.y));
            if d > best.2 {
                best = (i, j, d);
            }
        }
    }
    (best.0, best.1)
}

/// The point at `len` mm along an open polyline.
fn at_length(pl: &[P], len: f64) -> Option<P> {
    let mut left = len * SCALE;
    for w in pl.windows(2) {
        let [a, b] = w else { continue };
        let d = ops::dist(*a, *b) * SCALE;
        if d >= left && d > 0.0 {
            return Some(lerp(*a, *b, left / d));
        }
        left -= d;
    }
    pl.last().copied()
}

/// Points along a polyline about `spacing` mm apart, at least `min_count` of them where the spacing can
/// shrink to fit (spec 4.9). A closed polyline starts at one end of its longest chord.
pub(crate) fn resample(line: &[P], closed: bool, spacing: f64, min_count: usize) -> Vec<P> {
    let Some(&first) = line.first() else {
        return Vec::new();
    };
    let length = ops::ring_length(line, closed);
    if length < 2.0 * spacing && min_count <= 1 {
        let mut pl = line.to_vec();
        if closed {
            pl.push(first);
        }
        return at_length(&pl, length / 2.0).into_iter().collect();
    }
    // The walk runs over an open polyline: a closed one is rotated to start at one end of its longest
    // chord and closed back to its start.
    let (pl, far) = if closed {
        let (i, j) = farthest_pair(line);
        let n = line.len();
        let mut pl: Vec<P> = (0..=n).filter_map(|k| line.get((i + k) % n).copied()).collect();
        if pl.len() < 2 {
            pl = line.to_vec();
        }
        let far = line.get(j).copied().unwrap_or(first);
        (pl, far)
    } else {
        (line.to_vec(), line.last().copied().unwrap_or(first))
    };
    let Some(&start) = pl.first() else {
        return Vec::new();
    };
    let mut s = spacing.max(0.1);
    loop {
        let su = s * SCALE;
        let mut placed: Vec<P> = vec![start];
        if min_count > 1 || ops::dist(start, far) > s {
            placed.push(far);
        }
        // Walk: segment index and parameter of the search position, and the circle it searches.
        let mut center = fx(start);
        let mut radius = su;
        let mut seg = 0usize;
        let mut t = 0.0f64;
        while let (Some(&a), Some(&b)) = (pl.get(seg), pl.get(seg + 1)) {
            if let Some(tt) = leave_circle(a, b, t, center, radius) {
                let cand = lerp(a, b, tt);
                let nearest = placed
                    .iter()
                    .map(|q| ops::dist(*q, cand))
                    .fold(f64::INFINITY, f64::min);
                t = tt + 1e-9;
                if nearest + 1e-9 < s {
                    // Too close to a point already placed: look again further on.
                    center = fx(cand);
                    radius = ((s - nearest) * SCALE).max(1.0);
                } else {
                    placed.push(cand);
                    center = fx(cand);
                    radius = su;
                }
            } else {
                seg += 1;
                t = 0.0;
            }
        }
        if placed.len() >= min_count || s <= 0.1 {
            return placed;
        }
        s = (s * 0.9).max(0.1);
    }
}

#[cfg(test)]
mod tests {
    use super::super::params::u;
    use super::*;
    use crate::fm::Fm as _;

    fn line(len: f64) -> Vec<P> {
        vec![P::new(0, 0), P::new(u(len), 0)]
    }

    #[test]
    fn roof_lines_turn_by_layer_unless_fixed() {
        use super::super::params::Settings;
        let sq = ops::rect([0.0, 0.0, 10.0, 10.0]);
        let dir = |p: &Params, layer: usize| {
            let ls = lines(p, &sq, Lines::Roof { layer }, [5.0, 5.0]);
            let l = ls.iter().max_by_key(|l| l.len()).cloned().unwrap_or_default();
            let (a, b) = (
                l.first().copied().unwrap_or(P::new(0, 0)),
                l.last().copied().unwrap_or(P::new(0, 0)),
            );
            (f64::from(b.y - a.y))
                .m_atan2(f64::from(b.x - a.x))
                .to_degrees()
                .rem_euclid(180.0)
                .round()
        };
        let mut s = Settings::default();
        s.quirks.roof_angle_fixed = false;
        let p = Params::new(s.clone());
        assert!((dir(&p, 0) - dir(&p, 1)).abs() > 80.0);
        s.quirks.roof_angle_fixed = true;
        let p = Params::new(s);
        assert!((dir(&p, 0) - dir(&p, 1)).abs() < 1.0);
    }

    #[test]
    fn short_line_gets_its_middle() {
        let pts = resample(&line(2.0), false, 1.73, 1);
        assert_eq!(pts, vec![P::new(u(1.0), 0)]);
    }

    #[test]
    fn long_line_is_spaced() {
        let pts = resample(&line(10.0), false, 1.0, 1);
        // Start, far end, then every 1 mm between, never closer than 1 mm to the far end.
        assert!(pts.len() >= 10 && pts.len() <= 11, "{}", pts.len());
        for (i, a) in pts.iter().enumerate() {
            for b in pts.iter().skip(i + 1) {
                assert!(ops::dist(*a, *b) >= 0.999);
            }
        }
    }

    #[test]
    fn spacing_shrinks_to_reach_the_count() {
        let pts = resample(&line(1.0), false, 1.73, 3);
        assert!(pts.len() >= 3);
    }

    #[test]
    fn closed_ring_starts_at_its_longest_chord() {
        let sq = vec![
            P::new(0, 0),
            P::new(u(4.0), 0),
            P::new(u(4.0), u(4.0)),
            P::new(0, u(4.0)),
        ];
        let pts = resample(&sq, true, 1.0, 1);
        assert!(pts.len() >= 12, "{}", pts.len());
    }
}
