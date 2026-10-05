// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Arc fitting: runs of short straight segments that follow a circle are written as
//! one `G2` or `G3` move. Greedy: from each point, extend a circle through the first,
//! middle and last point of the run while every point in it stays within the tolerance
//! of that circle and the run keeps turning one way.

use crate::fm::Fm as _;
use crate::geom::Point;

/// One move of a fitted path.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Seg {
    /// A straight move to this point.
    Line(Point),
    /// An arc to `end`; `center` is relative to the start, mm; `ccw` is `G3`; `len` is the arc length, mm.
    Arc {
        end: Point,
        center: [f64; 2],
        ccw: bool,
        len: f64,
    },
}

/// Arcs with a larger radius (mm) stay as lines.
const MAX_RADIUS: f64 = 2000.0;
/// A run turns less than this much (radians); a full circle is left as two arcs.
const MAX_SWEEP: f64 = 1.9 * std::f64::consts::PI;

fn mm(p: Point) -> [f64; 2] {
    [p.x_mm(), p.y_mm()]
}

/// Center and radius of the circle through three points, None when they are collinear.
fn circle(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> Option<([f64; 2], f64)> {
    let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if d.abs() < 1e-9 {
        return None;
    }
    let (a2, b2, c2) = (
        a[0] * a[0] + a[1] * a[1],
        b[0] * b[0] + b[1] * b[1],
        c[0] * c[0] + c[1] * c[1],
    );
    let ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    let uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    let r = ((a[0] - ux).m_powi(2) + (a[1] - uy).m_powi(2)).sqrt();
    Some(([ux, uy], r))
}

/// Signed sweep of the run about `center` and whether every step turns the same way.
fn sweep(run: &[[f64; 2]], center: [f64; 2]) -> Option<f64> {
    let mut total = 0.0;
    let mut sign = 0.0f64;
    // Each point's angle is worked out once and serves the steps on both sides of it.
    let angle = |p: &[f64; 2]| (p[1] - center[1]).m_atan2(p[0] - center[0]);
    let Some(first) = run.first() else {
        return Some(0.0);
    };
    let mut a0 = angle(first);
    for q in run.iter().skip(1) {
        let a1 = angle(q);
        let mut d = a1 - a0;
        a0 = a1;
        while d > std::f64::consts::PI {
            d -= 2.0 * std::f64::consts::PI;
        }
        while d < -std::f64::consts::PI {
            d += 2.0 * std::f64::consts::PI;
        }
        if d.abs() < 1e-9 {
            continue;
        }
        if sign == 0.0 {
            sign = d.signum();
        } else if (d.signum() - sign).abs() > 0.5 {
            return None;
        }
        total += d;
    }
    Some(total)
}

/// Arc length may differ from the polyline length it replaces by less than this share.
const LENGTH_TOLERANCE: f64 = 0.05;

/// Whether a point at squared distance `q` from the center lies more than `tol` off the circle of radius
/// `r`: the answer of `(q.sqrt() - r).abs() > tol`. Points clearly inside or outside the band are told
/// apart by the squared distance alone; the margin keeps them at least 5e-10 of the outer radius from
/// the band's edges, far beyond the rounding of the square root, so only points within it take the root.
fn off_circle(q: f64, r: f64, tol: f64) -> bool {
    let (lo, hi) = (r - tol, r + tol);
    let m = 1e-9 * hi * hi;
    if q < hi * hi - m && (lo <= 0.0 || q > lo * lo + m) {
        return false;
    }
    if q > hi * hi + m || (lo > 0.0 && q < lo * lo - m) {
        return true;
    }
    (q.sqrt() - r).abs() > tol
}

/// Largest distance from the circle over the run's points and over the feet of the
/// perpendiculars from the center to each segment, or None when a point is beyond `tol`.
/// Returns the sum of squared deviations of the inner points when `sum` is set, else 0. With `sum` set to
/// a cap, a sum that reaches the cap gives None too: the caller keeps only sums below it, and the sum of
/// squares only grows as points are added, so its answer is the same.
///
/// `hint` is the inner point that failed last time, tested first: the circles tried for one run
/// usually fail at the same point (a corner), and the answer does not depend on the order of the tests.
fn deviation(
    run: &[[f64; 2]],
    center: [f64; 2],
    r: f64,
    tol: f64,
    hint: &mut usize,
    sum: Option<f64>,
) -> Option<f64> {
    let dist2 = |p: [f64; 2]| (p[0] - center[0]).m_powi(2) + (p[1] - center[1]).m_powi(2);
    let last = run.len().saturating_sub(1);
    if *hint > 0
        && *hint < last
        && let Some(&p) = run.get(*hint)
        && off_circle(dist2(p), r, tol)
    {
        return None;
    }
    let mut total = 0.0;
    for (k, &p) in run.iter().enumerate() {
        if k == 0 || k == last {
            continue;
        }
        let q = dist2(p);
        if off_circle(q, r, tol) {
            *hint = k;
            return None;
        }
        if let Some(cap) = sum {
            let d = (q.sqrt() - r).abs();
            total += d * d;
            if total >= cap {
                return None;
            }
        }
    }
    for w in run.windows(2) {
        let [p, q] = w else { continue };
        let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
        let len2 = dx * dx + dy * dy;
        if len2 <= 0.0 {
            continue;
        }
        let t = ((center[0] - p[0]) * dx + (center[1] - p[1]) * dy) / len2;
        if t <= 1e-6 || t >= 1.0 - 1e-6 {
            continue;
        }
        let foot = [p[0] + t * dx, p[1] + t * dy];
        if off_circle(dist2(foot), r, tol) {
            return None;
        }
    }
    Some(total)
}

/// The circle through the first and the last point of `run` and its middle (the middle point of three, else
/// halfway between the two points around the middle), when it is not too large: the circle tried first.
fn mid_circle(run: &[[f64; 2]]) -> Option<([f64; 2], f64)> {
    let n = run.len();
    let (first, last) = (*run.first()?, *run.last()?);
    let mid = n / 2;
    let mid_point = if n == 3 {
        *run.get(1)?
    } else if n.is_multiple_of(2) {
        let (p, q) = (*run.get(mid)?, *run.get(mid - 1)?);
        [f64::midpoint(p[0], q[0]), f64::midpoint(p[1], q[1])]
    } else {
        let (p, q) = (*run.get(mid - 1)?, *run.get(mid + 1)?);
        [f64::midpoint(p[0], q[0]), f64::midpoint(p[1], q[1])]
    };
    circle(first, mid_point, last).filter(|&(_, r)| r <= MAX_RADIUS)
}

/// The circle tried when the middle one does not fit a run of more than three points: through the first and
/// the last point and the inner point that gives the least deviation.
fn other_circle(run: &[[f64; 2]], tol: f64, hint: &mut usize) -> Option<([f64; 2], f64)> {
    let n = run.len();
    let (first, last) = (*run.first()?, *run.last()?);
    let mid = n / 2;
    // The least deviation wins, the first such point in run order on a tie. The points are tried from the
    // middle out, where the best circle usually lies, so its sum caps the others' early; the choice by
    // (deviation, index) does not depend on the order.
    let mut best: Option<([f64; 2], f64, f64, usize)> = None;
    let order = (1..n)
        .flat_map(|d| [mid.checked_sub(d), Some(mid + d)])
        .flatten()
        .filter(|&k| k >= 1 && k < n - 1);
    for k in order {
        let Some(&p) = run.get(k) else { continue };
        let Some((c, r)) = circle(first, p, last) else {
            continue;
        };
        if r > MAX_RADIUS {
            continue;
        }
        // An earlier point also wins with an equal sum, so its cap is the next value up.
        let cap = best.map_or(f64::INFINITY, |b| {
            if k < b.3 {
                f64::from_bits(b.2.to_bits() + 1)
            } else {
                b.2
            }
        });
        if let Some(dev) = deviation(run, c, r, tol, hint, Some(cap))
            && best.is_none_or(|(_, _, d, j)| dev.total_cmp(&d).then(k.cmp(&j)).is_lt())
        {
            best = Some((c, r, dev, k));
        }
    }
    best.map(|(c, r, ..)| (c, r))
}

/// Center, radius and signed sweep of a fitted arc.
type Fitted = ([f64; 2], f64, f64);

/// Length of a segment, as a run's path length adds them up.
fn seg_len(p: [f64; 2], q: [f64; 2]) -> f64 {
    ((q[0] - p[0]).m_powi(2) + (q[1] - p[1]).m_powi(2)).sqrt()
}

/// The tests a run makes once its circle is chosen: every step turns one way, the sweep stays short of a
/// full turn and above nothing, and the arc is about as long as the run's path. Returns the signed sweep.
fn finish(run: &[[f64; 2]], c: [f64; 2], r: f64, path: f64) -> Option<f64> {
    let s = sweep(run, c)?;
    if s.abs() > MAX_SWEEP || s.abs() < 1e-4 {
        return None;
    }
    if path <= 0.0 || ((r * s.abs() - path) / path).abs() >= LENGTH_TOLERANCE {
        return None;
    }
    Some(s)
}

/// Room the bounds of [`Track`] leave for rounding, mm or radians: far beyond the rounding of the values they
/// bound (plate coordinates are below 10^4 mm, their rounding below 10^-11) and far below what any test
/// compares.
const SLACK: f64 = 1e-9;

fn dist(p: [f64; 2], c: [f64; 2]) -> f64 {
    ((p[0] - c[0]).m_powi(2) + (p[1] - c[1]).m_powi(2)).sqrt()
}

/// Direction of `p` seen from `c`.
fn direction(p: [f64; 2], c: [f64; 2]) -> f64 {
    (p[1] - c[1]).m_atan2(p[0] - c[0])
}

/// An angle difference brought into -pi..pi, as [`sweep`] does.
fn wrap(mut d: f64) -> f64 {
    while d > std::f64::consts::PI {
        d -= 2.0 * std::f64::consts::PI;
    }
    while d < -std::f64::consts::PI {
        d += 2.0 * std::f64::consts::PI;
    }
    d
}

/// A run measured once against one circle, its reference, and kept up to date as the run grows, so that a
/// longer run whose own circle lies close to the reference passes its step without every point being visited
/// again.
///
/// Moving the center by `delta` and changing the radius by `dr` moves the distance of a point, or of the line
/// through a segment, from the circle by at most `delta + dr`. Seen from the center, a point at distance `rho`
/// turns by at most `asin(delta / rho)`, which is at most `pi / 2 * delta / rho`; a step of the run (from a point
/// to the next) turns by at most twice that, and so does the whole sweep, since the turns of the points in
/// between cancel. When these bounds keep every test of the step on its passing side with room to spare, the
/// step passes as it does when every point is visited; otherwise it is decided by visiting them. The sweep of
/// the arc a run ends with is measured exactly, once.
struct Track {
    c: [f64; 2],
    r: f64,
    /// Largest distance from the circle of the run's inner points and of the lines through its segments.
    far: f64,
    /// Least distance of the run's points from the center.
    near: f64,
    /// Direction of the run's last point seen from the center.
    last_dir: f64,
    /// The least and the largest turn of a step of the run seen from the center, all of one sign; a step between
    /// two equal points never turns and is left out.
    turn_min: f64,
    turn_max: f64,
    sign: f64,
    /// False once a step turns the other way or hardly at all: the bounds are not used then.
    clean: bool,
    /// The run's sweep seen from the center.
    sweep: f64,
}

impl Track {
    fn new(run: &[[f64; 2]], c: [f64; 2], r: f64) -> Option<Self> {
        let first = *run.first()?;
        let mut t = Self {
            c,
            r,
            far: 0.0,
            near: dist(first, c),
            last_dir: direction(first, c),
            turn_min: f64::INFINITY,
            turn_max: 0.0,
            sign: 0.0,
            clean: true,
            sweep: 0.0,
        };
        for (k, w) in run.windows(2).enumerate() {
            if let [p, q] = w {
                t.add(*p, *q, k > 0);
            }
        }
        Some(t)
    }

    /// The run grows from `p`, its last point so far, to `q`; `p` is an inner point from now on when `inner`
    /// (it is not the run's first).
    fn add(&mut self, p: [f64; 2], q: [f64; 2], inner: bool) {
        let (c, r) = (self.c, self.r);
        if inner {
            self.far = self.far.max((dist(p, c) - r).abs());
        }
        self.near = self.near.min(dist(q, c));
        let dir_q = direction(q, c);
        let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
        if dx != 0.0 || dy != 0.0 {
            let len = (dx * dx + dy * dy).sqrt();
            if len > 0.0 {
                let line = ((c[0] - p[0]) * dy - (c[1] - p[1]) * dx).abs() / len;
                self.far = self.far.max((line - r).abs());
            }
            let d = wrap(dir_q - self.last_dir);
            if d.abs() < 1e-6 || (self.sign != 0.0 && (d.signum() - self.sign).abs() > 0.5) {
                self.clean = false;
            } else {
                self.sign = d.signum();
                self.turn_min = self.turn_min.min(d.abs());
                self.turn_max = self.turn_max.max(d.abs());
                self.sweep += d;
            }
        }
        self.last_dir = dir_q;
    }

    /// True when every inner point of the run and every foot of a perpendicular is within `tol` of the circle
    /// `(c, r)`, by the bounds above: the circle passes [`deviation`].
    fn holds(&self, c: [f64; 2], r: f64, tol: f64) -> bool {
        self.far + dist(c, self.c) + (r - self.r).abs() <= tol - SLACK
    }

    /// True when the circle `(c, r)` passes [`finish`] for the run as it is now (path length `path`), by the
    /// bounds above: every step turns the same way, by more than the least turn the sweep counts and by less
    /// than half a turn, the sweep stays above the least and short of the limit, and the arc is about as long as
    /// the path.
    fn finishes(&self, c: [f64; 2], r: f64, path: f64) -> bool {
        use std::f64::consts::PI;
        let delta = dist(c, self.c);
        let turning = self.clean && self.sign != 0.0 && path > 0.0 && delta < 0.5 * self.near;
        if !turning {
            return false;
        }
        let turn = PI * delta / self.near + SLACK;
        let steps = self.turn_min - turn > 1e-9 + SLACK && self.turn_max + turn < PI - SLACK;
        let (lo, hi) = (self.sweep.abs() - turn - SLACK, self.sweep.abs() + turn + SLACK);
        let close = |s: f64| ((r * s - path) / path).abs() < LENGTH_TOLERANCE - SLACK;
        steps && hi < MAX_SWEEP && lo > 1e-4 && close(lo) && close(hi)
    }

    /// True when [`other_circle`] is certain to find a circle for the run as it is now and that circle passes
    /// [`finish`], without finding which one it is: the circle of every inner point either finishes by the
    /// bounds or misses one of a few inner points by more than the tolerance (so it is never picked), and one
    /// of them is certain to fit, by the bounds or by visiting the run once.
    fn vouches(&self, run: &[[f64; 2]], tol: f64, hint: &mut usize, path: f64) -> bool {
        let n = run.len();
        let (Some(&first), Some(&last)) = (run.first(), run.last()) else {
            return false;
        };
        let probes = [*hint, n / 2, n / 4, 3 * n / 4];
        let misses = |c: [f64; 2], r: f64| {
            probes.iter().any(|&j| {
                j >= 1
                    && j + 1 < n
                    && run.get(j).is_some_and(|&q| {
                        off_circle((q[0] - c[0]).m_powi(2) + (q[1] - c[1]).m_powi(2), r, tol)
                    })
            })
        };
        let mut certain = false;
        // The circle nearest the reference among those not yet certain to fit, to visit the run with.
        let mut nearest: Option<([f64; 2], f64, f64)> = None;
        // The inner points `other_circle` tries: all but the middle one.
        for k in (1..n.saturating_sub(1)).filter(|&k| k != n / 2) {
            let Some(&p) = run.get(k) else { continue };
            let Some((c, r)) = circle(first, p, last) else {
                continue;
            };
            if r > MAX_RADIUS {
                continue;
            }
            if !self.finishes(c, r, path) {
                if misses(c, r) {
                    continue;
                }
                return false;
            }
            if !certain {
                if self.holds(c, r, tol) {
                    certain = true;
                } else {
                    let d = dist(c, self.c) + (r - self.r).abs();
                    if nearest.is_none_or(|(_, _, e)| d < e) {
                        nearest = Some((c, r, d));
                    }
                }
            }
        }
        certain || nearest.is_some_and(|(c, r, _)| deviation(run, c, r, tol, hint, None).is_some())
    }
}

/// How a run passed its step.
enum Passed {
    /// With this circle and signed sweep.
    Exact([f64; 2], f64, f64),
    /// With this circle, through the run's middle; the sweep is measured when the arc ends here.
    Mid([f64; 2], f64),
    /// With the circle [`other_circle`] picks, which is found when the arc ends here.
    Other,
}

/// One step of the greedy fit: whether `run` (at least three points, path length `path`) follows one circle,
/// tried in this order: the circle through its middle, else the inner point's circle with the least deviation.
/// `track` is asked first, and set up again whenever a circle passes with every point visited.
fn step(
    run: &[[f64; 2]],
    tol: f64,
    hint: &mut usize,
    track: &mut Option<Track>,
    path: f64,
) -> Option<Passed> {
    if let Some((c, r)) = mid_circle(run)
        && (track.as_ref().is_some_and(|t| t.holds(c, r, tol))
            || deviation(run, c, r, tol, hint, None).is_some())
    {
        if track.as_ref().is_some_and(|t| t.finishes(c, r, path)) {
            return Some(Passed::Mid(c, r));
        }
        let s = finish(run, c, r, path)?;
        *track = Track::new(run, c, r);
        return Some(Passed::Exact(c, r, s));
    }
    if run.len() == 3 {
        return None;
    }
    if track.as_ref().is_some_and(|t| t.vouches(run, tol, hint, path)) {
        return Some(Passed::Other);
    }
    let (c, r) = other_circle(run, tol, hint)?;
    let s = finish(run, c, r, path)?;
    *track = Track::new(run, c, r);
    Some(Passed::Exact(c, r, s))
}

/// Fits `pts` with lines and arcs; every arc stays within `tol` mm of the points it replaces.
pub fn fit(pts: &[Point], tol: f64) -> Vec<Seg> {
    let xy: Vec<[f64; 2]> = pts.iter().map(|&p| mm(p)).collect();
    let n = pts.len();
    let mut out = Vec::new();
    let mut front = 0;
    let push_arc = |out: &mut Vec<Seg>, front: usize, end: usize, arc: Fitted| {
        if let (Some(&e), Some(start)) = (pts.get(end), xy.get(front)) {
            out.push(Seg::Arc {
                end: e,
                center: [arc.0[0] - start[0], arc.0[1] - start[1]],
                ccw: arc.2 > 0.0,
                len: arc.1 * arc.2.abs(),
            });
        }
    };
    while front + 1 < n {
        let mut last: Option<(usize, Passed)> = None;
        let mut back = front + 2;
        let mut hint = 0;
        let mut track: Option<Track> = None;
        // The run's path length, added up segment by segment in the order a sum over the run takes them.
        let mut path: f64 = std::iter::empty::<f64>().sum();
        if let (Some(&a), Some(&b)) = (xy.get(front), xy.get(front + 1)) {
            path += seg_len(a, b);
        }
        while back < n {
            let (Some(&p), Some(&q)) = (xy.get(back - 1), xy.get(back)) else {
                break;
            };
            path += seg_len(p, q);
            if let Some(t) = track.as_mut() {
                t.add(p, q, true);
            }
            match xy
                .get(front..=back)
                .and_then(|run| step(run, tol, &mut hint, &mut track, path))
            {
                Some(passed) => last = Some((back, passed)),
                None => break,
            }
            back += 1;
        }
        // The circle and sweep of an arc whose last step passed by the bounds are worked out now.
        let arc = last.and_then(|(end, passed)| {
            let run = xy.get(front..=end)?;
            let (c, r, s) = match passed {
                Passed::Exact(c, r, s) => (c, r, Some(s)),
                Passed::Mid(c, r) => (c, r, sweep(run, c)),
                Passed::Other => {
                    let found = other_circle(run, tol, &mut hint);
                    debug_assert!(found.is_some(), "a run the bounds vouched for has a circle");
                    let (c, r) = found?;
                    (c, r, sweep(run, c))
                }
            };
            debug_assert!(s.is_some(), "a run that passed by the bounds turns one way");
            Some((end, (c, r, s?)))
        });
        if let Some((end, arc)) = arc {
            push_arc(&mut out, front, end, arc);
            front = end;
        } else {
            if let Some(&e) = pts.get(front + 1) {
                out.push(Seg::Line(e));
            }
            front += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn circle_pts(r: f64, from: f64, to: f64, n: usize) -> Vec<Point> {
        (0..=n)
            .map(|k| {
                let a = from
                    + (to - from) * f64::from(u32::try_from(k).unwrap_or(0))
                        / f64::from(u32::try_from(n).unwrap_or(1));
                Point::from_mm(50.0 + r * a.m_cos(), 50.0 + r * a.m_sin())
            })
            .collect()
    }

    #[test]
    fn a_half_circle_becomes_one_arc() {
        let segs = fit(&circle_pts(10.0, 0.0, std::f64::consts::PI, 40), 0.02);
        assert_eq!(segs.len(), 1, "{segs:?}");
        let Seg::Arc { ccw, len, center, .. } = segs[0] else {
            panic!("not an arc")
        };
        assert!(ccw);
        assert!((len - 10.0 * std::f64::consts::PI).abs() < 0.05, "{len}");
        assert!(
            (center[0] - -10.0).abs() < 0.01 && center[1].abs() < 0.01,
            "{center:?}"
        );
    }

    #[test]
    fn clockwise_runs_and_straight_lines() {
        let cw = fit(&circle_pts(5.0, 3.0, 0.5, 20), 0.02);
        assert!(matches!(cw[0], Seg::Arc { ccw: false, .. }));
        let line: Vec<Point> = (0..10).map(|k| Point::from_mm(f64::from(k), 0.0)).collect();
        let segs = fit(&line, 0.02);
        assert_eq!(segs.len(), 9);
        assert!(segs.iter().all(|s| matches!(s, Seg::Line(_))));
    }

    #[test]
    fn a_corner_ends_the_arc_and_a_full_circle_is_split() {
        let mut pts = circle_pts(8.0, 0.0, 1.5, 12);
        pts.extend([Point::from_mm(50.0, 60.0), Point::from_mm(40.0, 60.0)]);
        let segs = fit(&pts, 0.02);
        assert!(matches!(segs[0], Seg::Arc { .. }));
        assert!(segs.len() >= 3);
        let full = fit(&circle_pts(8.0, 0.0, 2.0 * std::f64::consts::PI, 60), 0.02);
        assert!(full.iter().filter(|s| matches!(s, Seg::Arc { .. })).count() >= 2);
    }

    /// The fit as it ran before [`Track`]: every step visits the whole run.
    fn fit_plain(pts: &[Point], tol: f64) -> Vec<Seg> {
        let xy: Vec<[f64; 2]> = pts.iter().map(|&p| mm(p)).collect();
        let n = pts.len();
        let mut out = Vec::new();
        let mut front = 0;
        while front + 1 < n {
            let mut last: Option<(usize, Fitted)> = None;
            let mut back = front + 2;
            let mut hint = 0;
            while back < n {
                let run = &xy[front..=back];
                let mut chosen = None;
                if let Some((c, r)) = mid_circle(run)
                    && deviation(run, c, r, tol, &mut hint, None).is_some()
                {
                    chosen = Some((c, r));
                }
                if chosen.is_none() && run.len() > 3 {
                    chosen = other_circle(run, tol, &mut hint);
                }
                let path: f64 = run.windows(2).map(|w| seg_len(w[0], w[1])).sum();
                match chosen.and_then(|(c, r)| finish(run, c, r, path).map(|s| (c, r, s))) {
                    Some(arc) => last = Some((back, arc)),
                    None => break,
                }
                back += 1;
            }
            if let Some((end, (c, r, s))) = last {
                out.push(Seg::Arc {
                    end: pts[end],
                    center: [c[0] - xy[front][0], c[1] - xy[front][1]],
                    ccw: s > 0.0,
                    len: r * s.abs(),
                });
                front = end;
            } else {
                out.push(Seg::Line(pts[front + 1]));
                front += 1;
            }
        }
        out
    }

    /// A small deterministic generator of numbers in 0..1.
    struct Rng(u64);

    impl Rng {
        fn unit(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            f64::from(u32::try_from(self.0 >> 40).unwrap_or(0)) / f64::from(1u32 << 24)
        }

        fn range(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (hi - lo) * self.unit()
        }

        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a small count"
        )]
        fn count(&mut self, lo: u32, hi: u32) -> u32 {
            (lo + (self.unit() * f64::from(hi - lo + 1)) as u32).min(hi)
        }
    }

    /// A path of arcs (exact, rounded to the plate grid, or with noise), straight runs, corners and repeated
    /// points, as wall and infill paths have them.
    fn random_path(rng: &mut Rng) -> Vec<Point> {
        let mut pts = vec![Point::from_mm(rng.range(-100.0, 100.0), rng.range(-100.0, 100.0))];
        let pieces = rng.count(1, 6);
        for _ in 0..pieces {
            let last = *pts.last().unwrap();
            let (x, y) = (last.x_mm(), last.y_mm());
            match rng.count(0, 5) {
                0..=2 => {
                    // An arc from the last point: radius from 0.3 to 80 mm, steps of 0.005 to 0.6 rad.
                    let radius = 0.3 * (80.0f64 / 0.3).m_powf(rng.unit());
                    let start = rng.range(-3.2, 3.2);
                    let (cx, cy) = (x - radius * start.m_cos(), y - radius * start.m_sin());
                    let step = rng.range(0.005, 0.6) * if rng.unit() < 0.5 { -1.0 } else { 1.0 };
                    let noise = [0.0, 0.0, 1e-4, 5e-4, 2e-3, 1e-2][rng.count(0, 5) as usize];
                    for k in 1..=rng.count(2, 140) {
                        let a = start + step * f64::from(k);
                        pts.push(Point::from_mm(
                            cx + radius * a.m_cos() + rng.range(-noise, noise),
                            cy + radius * a.m_sin() + rng.range(-noise, noise),
                        ));
                    }
                }
                3 => {
                    let (dx, dy) = (rng.range(-2.0, 2.0), rng.range(-2.0, 2.0));
                    for k in 1..=rng.count(1, 20) {
                        pts.push(Point::from_mm(x + dx * f64::from(k), y + dy * f64::from(k)));
                    }
                }
                4 => pts.push(Point::from_mm(x + rng.range(-5.0, 5.0), y + rng.range(-5.0, 5.0))),
                _ => pts.push(last),
            }
        }
        pts
    }

    #[test]
    fn the_tracked_fit_gives_what_visiting_every_point_gives() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        let mut arcs = 0;
        for _ in 0..20_000 {
            let pts = random_path(&mut rng);
            let tol = [0.005, 0.012, 0.02, 0.0375, 0.04][rng.count(0, 4) as usize];
            let fast = fit(&pts, tol);
            assert_eq!(fast, fit_plain(&pts, tol), "{pts:?} {tol}");
            arcs += fast.iter().filter(|s| matches!(s, Seg::Arc { .. })).count();
        }
        // The paths do make arcs, many of them long.
        assert!(arcs > 20_000, "{arcs}");
    }

    #[test]
    fn noise_beyond_the_tolerance_stays_lines() {
        let mut pts = circle_pts(10.0, 0.0, 1.0, 10);
        pts[5] = Point::from_mm(pts[5].x_mm() + 0.3, pts[5].y_mm());
        let segs = fit(&pts, 0.02);
        assert!(segs.iter().filter(|s| matches!(s, Seg::Arc { .. })).count() == 0 || segs.len() > 1);
    }
}
