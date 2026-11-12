// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! profiles with arcs or splines matched piece to piece for a loft's rails: arc to arc, spline to spline and line to
//! line, and where two profiles have different pieces, each split where the other's corners land on it
// piece and rail indices come from the lists built here
#![allow(clippy::indexing_slicing)]
// a corner's place is copied from rail to rail and never worked out twice, so places are compared as they are
#![allow(clippy::float_cmp)]

use super::{LANDMARK_TOL_MM, MAX_RING, Profile, alongs, frame_of, landmarked, ring_of};
use crate::error::Error;
use crate::fm::Fm;
use crate::sketch::{self, CurveLoop, Loop, Prim};
use crate::sketch_spline;
use crate::vec3::{self, Frame, V2, V3};
use std::f64::consts::TAU;
use std::sync::Arc;

/// How close two places along a profile are one place, mm: the landmark tolerance. A corner of one profile that lands
/// this near a corner of the next is that corner, so no piece (and later no face) comes out thinner than a point marked
/// by hand could tell apart.
pub(super) const SAME_PLACE_MM: f64 = LANDMARK_TOL_MM;
/// The share of the shorter piece beside a profile's own corner within which another profile's corner landing there
/// is that corner. Without it a sharp corner that lands just beside the end of a facing round makes a sliver piece,
/// and sliver faces are a hazard for every exact operation that comes after. A 24 mm square against a 30 by 20
/// rectangle rounded at 4 mm lands its corners 0.661 mm from where the rounds' ends land on it and 0.641 mm from
/// those ends on the rectangle. The share is taken on every profile that owns one of the two corners, and either
/// one passing joins them: here the square's 24 mm sides reach 1.2 mm, where the rectangle's 6.28 mm rounds alone
/// would reach 0.314 mm and join nothing. So a rail leans by at most this share of a piece of the profile that owns
/// the corner. `SAME_PLACE_MM` stays the least reach.
const SNAP_SHARE: f64 = 0.05;
/// The least a matched piece measures along any profile, mm; thinner ones are refused. Also how near two corners'
/// claims on one rail are a tie.
const THIN_MM: f64 = 1e-6;
/// About how many points each profile is sampled at to find the least twist.
const TWIST_SAMPLES: usize = 360;
/// The offsets around a profile tried for the least twist before the best is closed in on.
const TWIST_TURNS: usize = 120;
/// The samples a spline's span is measured at, so places along a spline go by its length.
const SPLINE_SAMPLES: usize = 64;

/// One piece of a profile in its plane, between two ring points.
#[derive(Debug, Clone, PartialEq)]
pub enum Curve {
    /// A straight line.
    Line,
    /// Part of a circle: from the angle `from` through `sweep`, radians, counterclockwise positive.
    Arc {
        center: V2,
        radius: f64,
        from: f64,
        sweep: f64,
    },
    /// Part of an ellipse whose width axis is turned `turn` radians from the plane's x. `from` and `sweep` are the
    /// angle that maps the ellipse to a circle, not the angle seen from its center.
    Ellipse {
        center: V2,
        half_width: f64,
        half_height: f64,
        turn: f64,
        from: f64,
        sweep: f64,
    },
    /// Part of a spline drawn through points: from the share `from` of its length to the share `to`.
    Spline {
        spans: Arc<SplineSpans>,
        from: f64,
        to: f64,
    },
}

impl Curve {
    /// Whether it is anything but a straight line: an arc of a circle or an ellipse, or a spline.
    pub fn curved(&self) -> bool {
        !matches!(self, Self::Line)
    }

    /// What it pairs with piece for piece: a line with a line, an arc of a circle or an ellipse with either, and a
    /// spline with a spline.
    fn kind(&self) -> u8 {
        match self {
            Self::Line => 0,
            Self::Arc { .. } | Self::Ellipse { .. } => 1,
            Self::Spline { .. } => 2,
        }
    }

    /// A spline piece as drawn: its cubic spans from its start to its end, cut from the spline's own where the piece
    /// begins and ends within them. None for any other piece.
    pub fn spline_spans(&self) -> Option<Vec<[V2; 4]>> {
        let Self::Spline { spans, from, to } = self else {
            return None;
        };
        let forward = spans.portion(spans.step_at(from.min(*to)), spans.step_at(from.max(*to)));
        Some(if from <= to {
            forward
        } else {
            forward.iter().rev().map(|&[a, b, c, d]| [d, c, b, a]).collect()
        })
    }

    /// How far around it goes, radians; 0 for a line. A spline's is how far it turns, all its bends summed.
    fn sweep(&self) -> f64 {
        match *self {
            Self::Line => 0.0,
            Self::Arc { sweep, .. } | Self::Ellipse { sweep, .. } => sweep.abs(),
            Self::Spline { ref spans, from, to } => spans.turning(from, to),
        }
    }
}

/// A spline as the cubic spans the mesh loft flattens, measured along so that places on it go by its length and by
/// how sharply it bends.
///
/// Each chord between samples counts its length, and the square root of its length times its turn (half the turn at
/// each of its ends), scaled so the two halves of the measure are as long as each other. How far a chord strays from
/// the curve goes as its length times its turn, so evenly spread places gather into tight bends, where a face skinned
/// through them needs them, without piling onto a near cusp, which has little length to stray over. Every profile's
/// spline is measured the same way, so a place the same share along each is the same place on each.
#[derive(Debug, PartialEq)]
pub struct SplineSpans {
    /// From each drawn point to the next.
    pub spans: Vec<[V2; 4]>,
    /// How far along it each sample is by that measure, `SPLINE_SAMPLES` to a span evenly by its parameter, from its
    /// start to its end.
    along: Vec<f64>,
}

impl SplineSpans {
    fn new(spans: Vec<[V2; 4]>) -> Self {
        let mut points = vec![spans[0][0]];
        for b in &spans {
            points.extend(sketch_spline::flatten(b, SPLINE_SAMPLES));
        }
        let chords: Vec<V2> = points
            .windows(2)
            .map(|w| [w[1][0] - w[0][0], w[1][1] - w[0][1]])
            .collect();
        let lengths: Vec<f64> = chords.iter().map(|c| c[0].m_hypot(c[1])).collect();
        // the turn at each sample between two chords
        let turns: Vec<f64> = chords
            .windows(2)
            .map(|w| {
                let (u, v) = (w[0], w[1]);
                (u[0] * v[1] - u[1] * v[0])
                    .m_atan2(u[0] * v[0] + u[1] * v[1])
                    .abs()
            })
            .collect();
        // how far a chord's points stray from the curve goes as its length times how far it turns, so each chord
        // also counts the square root of that, and places spread evenly by it stray evenly
        let bends: Vec<f64> = lengths
            .iter()
            .enumerate()
            .map(|(i, len)| {
                let before = if i > 0 { turns[i - 1] } else { 0.0 };
                let after = turns.get(i).copied().unwrap_or(0.0);
                (len * (before + after) / 2.0).sqrt()
            })
            .collect();
        let (length, bending) = (lengths.iter().sum::<f64>(), bends.iter().sum::<f64>());
        let scale = if bending > 0.0 { length / bending } else { 0.0 };
        let mut along = vec![0.0];
        for (len, bend) in lengths.iter().zip(&bends) {
            along.push(along[along.len() - 1] + len + scale * bend);
        }
        Self { spans, along }
    }

    /// How long it is by its measure.
    fn length(&self) -> f64 {
        self.along[self.along.len() - 1]
    }

    /// Where the share `g` of its length is, in samples from its start: measured to the sample before, and on to the
    /// next by the share of the chord between them.
    #[allow(clippy::cast_precision_loss, reason = "a sample count")]
    fn step_at(&self, g: f64) -> f64 {
        let d = g.clamp(0.0, 1.0) * self.length();
        let i = self
            .along
            .partition_point(|&a| a <= d)
            .saturating_sub(1)
            .min(self.along.len() - 2);
        let (a, b) = (self.along[i], self.along[i + 1]);
        i as f64 + if b > a { (d - a) / (b - a) } else { 0.0 }
    }

    /// The share of its length the place `step` samples from its start is at; [`Self::step_at`] the other way.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "a sample count"
    )]
    fn share_at(&self, step: f64) -> f64 {
        let i = (step.max(0.0).floor() as usize).min(self.along.len() - 2);
        let f = step - i as f64;
        (self.along[i] + (self.along[i + 1] - self.along[i]) * f) / self.length()
    }

    /// Its spans from the place `from` samples along to the place `to`, each cut where those places fall in it.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "a sample count"
    )]
    fn portion(&self, from: f64, to: f64) -> Vec<[V2; 4]> {
        let per = SPLINE_SAMPLES as f64;
        let last = self.spans.len() - 1;
        // the span a place is in and how far along that span, as its own parameter
        let place = |step: f64, end: bool| {
            let at = step.max(0.0) / per;
            let k = (at.floor() as usize).min(last);
            // a place on a span's end is the end of that span, not the start of the next, when it ends a portion
            let k = if end && k > 0 && at == k as f64 { k - 1 } else { k };
            (k, at - k as f64)
        };
        let ((k0, t0), (k1, t1)) = (place(from, false), place(to, true));
        (k0..=k1)
            .map(|k| {
                let (a, b) = (if k == k0 { t0 } else { 0.0 }, if k == k1 { t1 } else { 1.0 });
                cut_span(&self.spans[k], a, b)
            })
            .collect()
    }

    /// The point `step` samples from its start, on the spans themselves.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "a sample count"
    )]
    fn point(&self, step: f64) -> V2 {
        let per = SPLINE_SAMPLES as f64;
        let k = ((step.max(0.0) / per).floor() as usize).min(self.spans.len() - 1);
        sketch_spline::point(&self.spans[k], step / per - k as f64)
    }

    /// How far it turns between the shares `from` and `to` of its length, radians: the turns from each chord to
    /// the next, a chord to a sample.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "a sample count"
    )]
    fn turning(&self, from: f64, to: f64) -> f64 {
        let (a, b) = (self.step_at(from.min(to)), self.step_at(from.max(to)));
        let n = ((b - a).ceil() as usize).max(1);
        let points: Vec<V2> = (0..=n)
            .map(|i| self.point(a + (b - a) * i as f64 / n as f64))
            .collect();
        points
            .windows(3)
            .map(|w| {
                let u = [w[1][0] - w[0][0], w[1][1] - w[0][1]];
                let v = [w[2][0] - w[1][0], w[2][1] - w[1][1]];
                (u[0] * v[1] - u[1] * v[0])
                    .m_atan2(u[0] * v[0] + u[1] * v[1])
                    .abs()
            })
            .sum()
    }
}

/// How many rails a matched piece gets. The faces of an exact loft are skinned across them, so more rails hold the
/// loft's shape closer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Density {
    /// A piece with an arc gets a rail at least every this many degrees of its widest arc.
    pub arc_step_deg: f64,
    /// The fewest stretches between rails a piece is cut into.
    pub least: usize,
}

impl Default for Density {
    /// A rail every 10 degrees held circles to 0.0004 mm, and 12 stretches held line pieces between rounded
    /// rectangles of different sizes to 0.0073 mm.
    fn default() -> Self {
        Self {
            arc_step_deg: 10.0,
            least: 12,
        }
    }
}

/// Why profiles got no rails: something is wrong with them, or they are fine and cannot be matched piece to piece.
pub(super) enum No {
    Bad(Error),
    Unmatched(String),
}

impl From<Error> for No {
    fn from(e: Error) -> Self {
        Self::Bad(e)
    }
}

type Try<T> = std::result::Result<T, No>;

fn unmatched<T>(why: impl Into<String>) -> Try<T> {
    Err(No::Unmatched(why.into()))
}

/// The part of the cubic Bezier `b` from its parameter `a` to `t`, as a cubic Bezier of its own.
fn cut_span(b: &[V2; 4], a: f64, t: f64) -> [V2; 4] {
    let mix = |p: V2, q: V2, f: f64| [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
    // split at a and keep the part after it, then split that at where t falls in it
    let after = |b: [V2; 4], f: f64| -> [V2; 4] {
        let (p01, p12, p23) = (mix(b[0], b[1], f), mix(b[1], b[2], f), mix(b[2], b[3], f));
        let (p012, p123) = (mix(p01, p12, f), mix(p12, p23, f));
        [mix(p012, p123, f), p123, p23, b[3]]
    };
    let before = |b: [V2; 4], f: f64| -> [V2; 4] {
        let (p01, p12, p23) = (mix(b[0], b[1], f), mix(b[1], b[2], f), mix(b[2], b[3], f));
        let (p012, p123) = (mix(p01, p12, f), mix(p12, p23, f));
        [b[0], p01, p012, mix(p012, p123, f)]
    };
    let tail = if a > 0.0 { after(*b, a) } else { *b };
    let rest = if a < 1.0 { (t - a) / (1.0 - a) } else { 1.0 };
    let mut out = if rest < 1.0 { before(tail, rest) } else { tail };
    // the drawn points themselves where the piece starts or ends on them
    if a == 0.0 {
        out[0] = b[0];
    }
    if t == 1.0 {
        out[3] = b[3];
    }
    out
}

/// One drawn piece of a profile, from one of its corners to the next.
#[derive(Debug, Clone)]
struct Part {
    from: V2,
    to: V2,
    curve: Curve,
}

impl Part {
    /// The point the fraction `f` along it: by length on a line, by angle on an arc. A closed curve goes on around
    /// past 1.
    fn at(&self, f: f64) -> V2 {
        // the ends are the drawn points themselves
        if f == 0.0 {
            return self.from;
        }
        if f == 1.0 {
            return self.to;
        }
        match self.curve {
            Curve::Line => [
                self.from[0] + (self.to[0] - self.from[0]) * f,
                self.from[1] + (self.to[1] - self.from[1]) * f,
            ],
            Curve::Arc {
                center,
                radius,
                from,
                sweep,
            } => {
                let (s, c) = (from + sweep * f).m_sin_cos();
                [center[0] + radius * c, center[1] + radius * s]
            }
            Curve::Ellipse {
                center,
                half_width,
                half_height,
                turn,
                from,
                sweep,
            } => ellipse_at(center, half_width, half_height, turn, from + sweep * f),
            Curve::Spline {
                ref spans, from, to, ..
            } => spans.point(spans.step_at(from + (to - from) * f)),
        }
    }

    /// How long it is. An ellipse is measured by the angle that maps it to a circle of its longer half axis, as its
    /// flattening steps are, so places along it go by that angle and not by true length. A spline is measured along
    /// its chords, a few dozen to a span.
    fn measure(&self) -> f64 {
        match self.curve {
            Curve::Line => (self.to[0] - self.from[0]).m_hypot(self.to[1] - self.from[1]),
            Curve::Arc { radius, sweep, .. } => radius * sweep.abs(),
            Curve::Ellipse {
                half_width,
                half_height,
                sweep,
                ..
            } => half_width.max(half_height) * sweep.abs(),
            Curve::Spline {
                ref spans, from, to, ..
            } => spans.length() * (to - from).abs(),
        }
    }

    /// The part of it from the fraction `f0` to `f1`.
    fn cut(&self, f0: f64, f1: f64) -> Curve {
        match self.curve {
            Curve::Line => Curve::Line,
            Curve::Arc {
                center,
                radius,
                from,
                sweep,
            } => Curve::Arc {
                center,
                radius,
                from: from + sweep * f0,
                sweep: sweep * (f1 - f0),
            },
            Curve::Ellipse {
                center,
                half_width,
                half_height,
                turn,
                from,
                sweep,
            } => Curve::Ellipse {
                center,
                half_width,
                half_height,
                turn,
                from: from + sweep * f0,
                sweep: sweep * (f1 - f0),
            },
            Curve::Spline {
                ref spans, from, to, ..
            } => Curve::Spline {
                spans: Arc::clone(spans),
                from: from + (to - from) * f0,
                to: from + (to - from) * f1,
            },
        }
    }

    /// The same piece run the other way.
    fn reversed(&self) -> Self {
        let back = |from: f64, sweep: f64| (from + sweep, -sweep);
        let curve = match self.curve {
            Curve::Line => Curve::Line,
            Curve::Arc {
                center,
                radius,
                from,
                sweep,
            } => {
                let (from, sweep) = back(from, sweep);
                Curve::Arc {
                    center,
                    radius,
                    from,
                    sweep,
                }
            }
            Curve::Ellipse {
                center,
                half_width,
                half_height,
                turn,
                from,
                sweep,
            } => {
                let (from, sweep) = back(from, sweep);
                Curve::Ellipse {
                    center,
                    half_width,
                    half_height,
                    turn,
                    from,
                    sweep,
                }
            }
            Curve::Spline {
                ref spans, from, to, ..
            } => Curve::Spline {
                spans: Arc::clone(spans),
                from: to,
                to: from,
            },
        };
        Self {
            from: self.to,
            to: self.from,
            curve,
        }
    }

    /// The fraction along it nearest `p`, and how far from `p` that point is.
    fn nearest(&self, p: V2) -> (f64, f64) {
        let f = match self.curve {
            Curve::Line => {
                let d = [self.to[0] - self.from[0], self.to[1] - self.from[1]];
                let l2 = d[0] * d[0] + d[1] * d[1];
                if l2 > 0.0 {
                    ((p[0] - self.from[0]) * d[0] + (p[1] - self.from[1]) * d[1]) / l2
                } else {
                    0.0
                }
            }
            Curve::Arc {
                center, from, sweep, ..
            } => turn_from((p[1] - center[1]).m_atan2(p[0] - center[0]), from, sweep),
            Curve::Ellipse {
                center,
                half_width,
                half_height,
                turn,
                from,
                sweep,
            } => {
                // exact for a point on the ellipse, and a landmark is within its tolerance of it
                let (s, c) = turn.m_sin_cos();
                let d = [p[0] - center[0], p[1] - center[1]];
                let (x, y) = (c * d[0] + s * d[1], c * d[1] - s * d[0]);
                turn_from((y / half_height).m_atan2(x / half_width), from, sweep)
            }
            Curve::Spline {
                ref spans, from, to, ..
            } => {
                // the nearest of its samples, then closed in on between the samples either side
                let (s0, s1) = (spans.step_at(from), spans.step_at(to));
                let (lo, hi) = (s0.min(s1), s0.max(s1));
                let off = |s: f64| {
                    let q = spans.point(s);
                    (p[0] - q[0]).m_hypot(p[1] - q[1])
                };
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    clippy::cast_precision_loss,
                    reason = "a sample count"
                )]
                let (n, step) = {
                    let n = ((hi - lo).ceil() as usize).max(1);
                    (n, (hi - lo) / n as f64)
                };
                #[allow(clippy::cast_precision_loss, reason = "a sample count")]
                let best = (0..=n)
                    .map(|i| lo + step * i as f64)
                    .min_by(|&a, &b| off(a).total_cmp(&off(b)))
                    .unwrap_or(lo);
                let (mut a, mut b) = ((best - step).max(lo), (best + step).min(hi));
                for _ in 0..60 {
                    let (m1, m2) = (a + (b - a) / 3.0, b - (b - a) / 3.0);
                    if off(m1) <= off(m2) {
                        b = m2;
                    } else {
                        a = m1;
                    }
                }
                let g = spans.share_at(f64::midpoint(a, b));
                if to == from { 0.0 } else { (g - from) / (to - from) }
            }
        };
        let f = f.clamp(0.0, 1.0);
        let q = self.at(f);
        (f, (p[0] - q[0]).m_hypot(p[1] - q[1]))
    }
}

/// The fraction of `sweep` from the angle `from` that the angle `a` is at, taken the way the sweep goes; past the
/// sweep's end it is the nearer end.
fn turn_from(a: f64, from: f64, sweep: f64) -> f64 {
    let f = ((a - from) * sweep.signum()).rem_euclid(TAU) / sweep.abs();
    if f <= 1.0 {
        return f;
    }
    // outside the arc: the gap is shared between its two ends
    let past = TAU / sweep.abs();
    if f - 1.0 < past - f { 1.0 } else { 0.0 }
}

fn ellipse_at(center: V2, a: f64, b: f64, turn: f64, angle: f64) -> V2 {
    let (st, ct) = turn.m_sin_cos();
    let (s, c) = angle.m_sin_cos();
    let (x, y) = (a * c, b * s);
    [center[0] + ct * x - st * y, center[1] + st * x + ct * y]
}

/// A profile as its drawn pieces in order around it, measured along from its first.
#[derive(Debug, Clone)]
pub(super) struct Outline {
    parts: Vec<Part>,
    /// Where each part starts, and last the whole way around.
    at: Vec<f64>,
    /// A circle, an ellipse or one arc all the way around: where it starts is no corner, so it turns freely.
    free: bool,
}

impl Outline {
    fn new(parts: Vec<Part>) -> Self {
        let mut at = Vec::with_capacity(parts.len() + 1);
        let mut run = 0.0;
        for p in &parts {
            at.push(run);
            run += p.measure();
        }
        at.push(run);
        let free = parts.len() == 1;
        Self { parts, at, free }
    }

    /// The whole way around.
    fn total(&self) -> f64 {
        self.at[self.parts.len()]
    }

    /// 0 with corners, 1 a closed curve that is no circle, 2 a circle.
    fn roundness(&self) -> u8 {
        if !self.free {
            0
        } else if matches!(self.parts[0].curve, Curve::Arc { .. }) {
            2
        } else {
            1
        }
    }

    /// The same outline wound the other way, from the same start.
    fn reversed(&self) -> Self {
        Self::new(self.parts.iter().rev().map(Part::reversed).collect())
    }

    /// Where its corners are: the start of each part, or none on a free one.
    fn corners(&self) -> &[f64] {
        if self.free {
            &[]
        } else {
            &self.at[..self.parts.len()]
        }
    }

    /// The part the place `t` is on, the one that starts there when `t` is a corner.
    fn part_at(&self, t: f64) -> usize {
        let t = t.rem_euclid(self.total());
        self.at
            .partition_point(|&a| a <= t)
            .saturating_sub(1)
            .min(self.parts.len() - 1)
    }

    /// The fraction of part `i` the place `t` is at. A place at the part's start is its end when `end`.
    fn fraction(&self, i: usize, t: f64, end: bool) -> f64 {
        let d = (t - self.at[i]).rem_euclid(self.total());
        let d = if end && d == 0.0 { self.total() } else { d };
        (d / (self.at[i + 1] - self.at[i])).min(1.0)
    }

    fn point(&self, t: f64) -> V2 {
        let i = self.part_at(t);
        self.parts[i].at(self.fraction(i, t, false))
    }

    /// How far apart two places are, the short way around.
    fn gap(&self, a: f64, b: f64) -> f64 {
        let d = (a - b).rem_euclid(self.total());
        d.min(self.total() - d)
    }

    /// How near the place `t` another profile's corner is the same place: `SNAP_SHARE` of the shorter piece beside it
    /// when it is one of this outline's corners, and never less than `SAME_PLACE_MM`.
    fn reach(&self, t: f64) -> f64 {
        let n = self.parts.len();
        let len = |i: usize| self.at[i + 1] - self.at[i];
        self.corners()
            .iter()
            .position(|&c| c == t)
            .map_or(SAME_PLACE_MM, |i| {
                SAME_PLACE_MM.max(SNAP_SHARE * len(i).min(len((i + n - 1) % n)))
            })
    }

    /// `t`, or the corner within `SAME_PLACE_MM` of it.
    fn snapped(&self, t: f64) -> f64 {
        self.corners()
            .iter()
            .copied()
            .filter(|&c| self.gap(c, t) <= SAME_PLACE_MM)
            .min_by(|&a, &b| self.gap(a, t).total_cmp(&self.gap(b, t)))
            .unwrap_or(t)
    }

    /// Where the point `p` is along it, when it is within the landmark tolerance of it.
    fn place_of(&self, p: V2) -> Option<f64> {
        let mut best: Option<(f64, f64)> = None;
        for (i, part) in self.parts.iter().enumerate() {
            let (f, off) = part.nearest(p);
            if best.is_none_or(|(o, _)| off < o) {
                best = Some((off, self.at[i] + (self.at[i + 1] - self.at[i]) * f));
            }
        }
        best.filter(|&(o, _)| o <= LANDMARK_TOL_MM)
            .map(|(_, t)| self.snapped(t.rem_euclid(self.total())))
    }
}

/// The outline of profile `k` (from 0), counterclockwise in its plane.
fn outline_of(k: usize, p: &Profile) -> Try<Outline> {
    // what the mesh loft refuses is refused here in the same words
    ring_of(k, p)?;
    let name = k + 1;
    if p.open {
        return unmatched(format!(
            "profile {name} is an open chain, and open chains with arcs have no piece matching yet"
        ));
    }
    let drawn: Vec<Loop> = p.loops.iter().filter(|l| !l.construction).cloned().collect();
    if drawn.iter().any(sketch::has_spline) {
        return spline_outline(name, &drawn);
    }
    let mut curves = match sketch::curves(&drawn) {
        Ok(c) => c,
        Err(e) => return unmatched(format!("profile {name}: {e}")),
    };
    let Some(shape) = curves.pop().filter(|c| curves.is_empty() && c.holes.is_empty()) else {
        return unmatched(format!("profile {name} is not one closed loop"));
    };
    let parts = match shape.outer {
        CurveLoop::Circle { center, diameter_mm } => {
            let radius = diameter_mm / 2.0;
            let seam = [center[0] + radius, center[1]];
            vec![Part {
                from: seam,
                to: seam,
                curve: Curve::Arc {
                    center,
                    radius,
                    from: 0.0,
                    sweep: TAU,
                },
            }]
        }
        CurveLoop::Ellipse {
            center,
            width_mm,
            height_mm,
            angle_deg,
        } => {
            let (a, b, turn) = (width_mm / 2.0, height_mm / 2.0, angle_deg.to_radians());
            let seam = ellipse_at(center, a, b, turn, 0.0);
            vec![Part {
                from: seam,
                to: seam,
                curve: Curve::Ellipse {
                    center,
                    half_width: a,
                    half_height: b,
                    turn,
                    from: 0.0,
                    sweep: TAU,
                },
            }]
        }
        CurveLoop::Pieces { start, segments } => {
            let mut from = start;
            let mut parts = Vec::with_capacity(segments.len());
            for s in segments {
                let curve = match (s.center, s.sweep_deg) {
                    (Some(center), Some(sweep)) => Curve::Arc {
                        center,
                        radius: (from[0] - center[0]).m_hypot(from[1] - center[1]),
                        from: (from[1] - center[1]).m_atan2(from[0] - center[0]),
                        sweep: sweep.to_radians(),
                    },
                    _ => Curve::Line,
                };
                parts.push(Part {
                    from,
                    to: s.to,
                    curve,
                });
                from = s.to;
            }
            parts
        }
    };
    Ok(Outline::new(parts))
}

/// The outline of a profile drawn with lines and spline segments, counterclockwise in its plane. A spline matches only
/// a spline, so a spline all the way around (with no corner to match from) and an arc beside a spline are left
/// unmatched.
fn spline_outline(name: usize, drawn: &[Loop]) -> Try<Outline> {
    let [lp] = drawn else {
        return unmatched(format!("profile {name} is not one closed loop"));
    };
    let closed = || {
        unmatched(format!(
            "profile {name} is a closed spline, which has no corners to match its pieces between"
        ))
    };
    if lp.kind.as_deref() == Some("spline") {
        return closed();
    }
    let (start, pieces) = match sketch::drawn_pieces(0, lp) {
        Ok(d) => d,
        Err(e) => return unmatched(format!("profile {name}: {e}")),
    };
    if pieces.len() < 2 {
        return closed();
    }
    let mut parts = Vec::with_capacity(pieces.len());
    // twice the area it winds around, to know which way that is
    let mut area2 = 0.0;
    let mut from = start;
    for (prim, points) in pieces {
        let (to, curve) = match prim {
            Prim::Line { to } => {
                area2 += from[0] * to[1] - from[1] * to[0];
                (to, Curve::Line)
            }
            Prim::Spline { to } => {
                let mut through = vec![from];
                through.extend(points);
                through.push(to);
                let spans = sketch_spline::spans(&through, false);
                area2 += sketch_spline::area2(&spans);
                let spans = Arc::new(SplineSpans::new(spans));
                (
                    to,
                    Curve::Spline {
                        spans,
                        from: 0.0,
                        to: 1.0,
                    },
                )
            }
            Prim::Arc { .. } => {
                return unmatched(format!(
                    "profile {name} has an arc beside a spline, which has no pieces to match yet"
                ));
            }
        };
        parts.push(Part { from, to, curve });
        from = to;
    }
    let outline = Outline::new(parts);
    Ok(if area2 < 0.0 { outline.reversed() } else { outline })
}

/// A profile ready to match: its outline wound the way the loft goes, on its plane.
struct Lined {
    outline: Outline,
    frame: Frame,
    center: V3,
    /// Its twist samples: where along the outline each is, the share of the outline it stands for, and the point
    /// from the center.
    samples: Vec<(f64, f64, V3)>,
}

impl Lined {
    fn new(outline: Outline, frame: Frame) -> Self {
        let total = outline.total();
        // each piece is sampled evenly about its own middle, so a shape and its mirror image are sampled at
        // mirrored points wherever each was started
        let mut samples = Vec::with_capacity(TWIST_SAMPLES + outline.parts.len());
        for i in 0..outline.parts.len() {
            let len = outline.at[i + 1] - outline.at[i];
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a share of the sample count"
            )]
            let m = ((TWIST_SAMPLES as f64 * len / total).round() as usize).max(1);
            for j in 0..m {
                let t = outline.at[i] + len * (j as f64 + 0.5) / m as f64;
                samples.push((t, len / (m as f64 * total), frame.at(outline.point(t), 0.0)));
            }
        }
        let center = samples
            .iter()
            .fold([0.0; 3], |c, &(_, w, p)| vec3::add(c, vec3::scale(p, w)));
        for sample in &mut samples {
            sample.2 = vec3::sub(sample.2, center);
        }
        Self {
            outline,
            frame,
            center,
            samples,
        }
    }

    /// The place `t` in space, from the center.
    fn about_center(&self, t: f64) -> V3 {
        vec3::sub(self.frame.at(self.outline.point(t), 0.0), self.center)
    }
}

/// Where `a` and `b` line up with the least twist: a place on each that match. Profiles with as many pieces as each
/// other, line for line and arc for arc at some turn, match corner to corner at the best such turn. Any others match
/// by how far along each is, at the offset with the least summed squared distance between matching places, each
/// profile taken about its own center as the mesh loft takes them. Of turns or offsets that twist as little as each
/// other the first is taken; they are as good as each other only on shapes that repeat, where each gives the same
/// rails.
///
/// Also says which of the two it was: whether the pieces pair.
fn least_twist(a: &Lined, b: &Lined) -> ((f64, f64), bool) {
    let (oa, ob) = (&a.outline, &b.outline);
    let n = oa.parts.len();
    if !oa.free && !ob.free && n == ob.parts.len() {
        let kinds = |o: &Outline, i: usize| o.parts[i % n].curve.kind();
        let mid = |o: &Outline, i: usize| f64::midpoint(o.at[i % n], o.at[i % n + 1]);
        let mut best: Option<(f64, usize)> = None;
        for s in (0..n).filter(|&s| (0..n).all(|i| kinds(oa, i) == kinds(ob, i + s))) {
            let cost: f64 = (0..n)
                .map(|i| {
                    let e = vec3::sub(a.about_center(oa.at[i]), b.about_center(ob.at[(i + s) % n]));
                    let m = vec3::sub(a.about_center(mid(oa, i)), b.about_center(mid(ob, i + s)));
                    vec3::dot(e, e) + vec3::dot(m, m)
                })
                .sum();
            if best.is_none_or(|(c, _)| cost < c) {
                best = Some((cost, s));
            }
        }
        if let Some((_, s)) = best {
            return ((oa.at[0], ob.at[s]), true);
        }
    }
    // The samples of the profile with corners are matched to places on the other, found exactly; of two without
    // corners, the one that is no circle. A circle has no place its samples could start from that means anything.
    let (from, to, way) = if oa.roundness() <= ob.roundness() {
        (a, b, 1.0)
    } else {
        (b, a, -1.0)
    };
    // how far apart the profiles are with `b` the share `turn` of the way around ahead of `a`
    let cost = |turn: f64| -> f64 {
        let (tf, tt) = (from.outline.total(), to.outline.total());
        from.samples
            .iter()
            .map(|&(t, w, p)| {
                let e = vec3::sub(p, to.about_center((t / tf + way * turn) * tt));
                w * vec3::dot(e, e)
            })
            .sum()
    };
    let step = 1.0 / TWIST_TURNS as f64;
    let costs: Vec<f64> = (0..TWIST_TURNS).map(|s| cost(s as f64 * step)).collect();
    let s = (0..TWIST_TURNS).fold(0, |best, s| if costs[s] < costs[best] { s } else { best });
    // Close in on the offset that twists as much half a step to either side of it. On a shape that mirrors itself
    // that is its mirror line, to the last bit that tells, so mirrored profiles get mirrored rails.
    let lean = |turn: f64| cost(turn + step / 2.0) - cost(turn - step / 2.0);
    let (mut lo, mut hi) = ((s as f64 - 1.0) * step, (s as f64 + 1.0) * step);
    let mut turn = s as f64 * step;
    if lean(lo) < 0.0 && lean(hi) > 0.0 {
        for _ in 0..60 {
            let mid = f64::midpoint(lo, hi);
            if lean(mid) < 0.0 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        turn = f64::midpoint(lo, hi);
    }
    let t = (turn * ob.total()).rem_euclid(ob.total());
    // a hair under no offset comes around as the whole way
    let t = if t < ob.total() { t } else { 0.0 };
    ((0.0, ob.snapped(t)), false)
}

/// How places along one outline go to places along the next: matched places (`a` on the first, `b` on the second,
/// each list in order around from its first), and evenly between them.
struct Map {
    a: Vec<f64>,
    b: Vec<f64>,
    ta: f64,
    tb: f64,
}

impl Map {
    /// The map that takes each of `anchors`' places on `a` to its place on `b`. Between two anchors, with `pair`,
    /// pieces pair in order when both have as many there, line for line and arc for arc; else places go by how far
    /// along they are.
    fn new(a: &Outline, b: &Outline, anchors: &[(f64, f64)], pair: bool) -> Self {
        let mut m = Self {
            a: Vec::new(),
            b: Vec::new(),
            ta: a.total(),
            tb: b.total(),
        };
        // the corners strictly inside the run of `o` from `from` over `len`, and the kind of each piece in it
        let inside = |o: &Outline, from: f64, len: f64| -> (Vec<f64>, Vec<u8>) {
            let mut c: Vec<f64> = o
                .corners()
                .iter()
                .copied()
                .filter(|&c| {
                    let d = (c - from).rem_euclid(o.total());
                    d > 0.0 && d < len
                })
                .collect();
            c.sort_by(|&x, &y| {
                (x - from)
                    .rem_euclid(o.total())
                    .total_cmp(&(y - from).rem_euclid(o.total()))
            });
            let kinds = std::iter::once(from)
                .chain(c.iter().copied())
                .map(|t| o.parts[o.part_at(t)].curve.kind())
                .collect();
            (c, kinds)
        };
        let run = |o: &Outline, from: f64, to: f64| {
            let d = (to - from).rem_euclid(o.total());
            if d == 0.0 { o.total() } else { d }
        };
        for (j, &(fa, fb)) in anchors.iter().enumerate() {
            let (na, nb) = anchors[(j + 1) % anchors.len()];
            let (ca, ka) = inside(a, fa, run(a, fa, na));
            let (cb, kb) = inside(b, fb, run(b, fb, nb));
            m.a.push(fa);
            m.b.push(fb);
            if pair && ka == kb {
                m.a.extend(ca);
                m.b.extend(cb);
            }
        }
        m
    }

    /// Where the place `t` on the first outline is on the second.
    fn to(&self, t: f64) -> f64 {
        across(&self.a, &self.b, self.ta, self.tb, t)
    }

    /// Where the place `t` on the second outline is on the first.
    fn back(&self, t: f64) -> f64 {
        across(&self.b, &self.a, self.tb, self.ta, t)
    }
}

/// `t` among the places `xs` (around a loop of `tx`) taken to the same way between the matching `ys` (around `ty`).
/// A place that is one of `xs` goes to its `ys` exactly.
fn across(xs: &[f64], ys: &[f64], tx: f64, ty: f64, t: f64) -> f64 {
    let n = xs.len();
    let from = |v: &[f64], i: usize, total: f64| {
        if i == n {
            total
        } else {
            (v[i] - v[0]).rem_euclid(total)
        }
    };
    let u = (t - xs[0]).rem_euclid(tx);
    let i = (1..n).rev().find(|&i| from(xs, i, tx) <= u).unwrap_or(0);
    let (x0, x1) = (from(xs, i, tx), from(xs, i + 1, tx));
    if u == x0 {
        return ys[i];
    }
    let (y0, y1) = (from(ys, i, ty), from(ys, i + 1, ty));
    (ys[0] + y0 + (u - x0) / (x1 - x0) * (y1 - y0)).rem_euclid(ty)
}

/// One rail's place on each profile so far, and whether that profile has a corner or a landmark there.
#[derive(Debug, Clone)]
struct Rail {
    at: Vec<f64>,
    own: Vec<bool>,
}

/// Carries `rails` on to profile `k` through `maps` and adds the profile's own `breaks`. A break is the rail that
/// lands within reach of it ([`Outline::reach`]), measured on this profile or on an earlier profile that has the
/// rail as a corner of its own; any other break starts a rail of its own, taken back through `maps` to the earlier
/// profiles.
///
/// No two breaks become one rail, so the profile keeps every corner and every piece: when two are within reach of
/// the same rail the nearer takes it. When they are equally near (a sharp corner facing the middle of a short
/// round), neither takes it and the rail stays between them, so a shape that mirrors itself is matched to its
/// mirror image.
fn join(rails: &mut Vec<Rail>, outlines: &[Outline], maps: &[Map], k: usize, breaks: &[f64]) {
    let o = &outlines[k];
    if k > 0 {
        for r in rails.iter_mut() {
            r.at.push(maps[k - 1].to(r.at[k - 1]));
            r.own.push(false);
        }
    }
    // each break's place on every profile so far
    let places: Vec<Vec<f64>> = breaks
        .iter()
        .map(|&c| {
            let mut at = vec![c; k + 1];
            for j in (0..k).rev() {
                at[j] = maps[j].back(at[j + 1]);
            }
            at
        })
        .collect();
    // the rail each break would take and how far from it the rail lands
    let wants: Vec<Option<(usize, f64)>> = places
        .iter()
        .map(|at| {
            let near = |r: &Rail| {
                o.gap(r.at[k], at[k]) <= o.reach(at[k])
                    || (0..k)
                        .any(|j| r.own[j] && outlines[j].gap(r.at[j], at[j]) <= outlines[j].reach(r.at[j]))
            };
            rails
                .iter()
                .enumerate()
                .filter(|(_, r)| !r.own[k] && near(r))
                .map(|(i, r)| (i, o.gap(r.at[k], at[k])))
                .min_by(|x, y| x.1.total_cmp(&y.1))
        })
        .collect();
    for (b, at) in places.into_iter().enumerate() {
        let taken = wants[b].filter(|&(i, gap)| {
            // the nearest claim wins, and a tie goes to neither
            wants
                .iter()
                .enumerate()
                .all(|(other, w)| other == b || w.is_none_or(|(j, g)| j != i || g > gap + THIN_MM))
        });
        if let Some((i, _)) = taken {
            rails[i].at[k] = at[k];
            rails[i].own[k] = true;
        } else {
            let mut own = vec![false; k + 1];
            own[k] = true;
            rails.push(Rail { at, own });
        }
    }
}

/// Each profile's landmarks as places along its outline, in the order the outlines wind. The same refusals as the mesh
/// loft's: a landmark off its profile, landmarks out of order, and profiles whose landmarks run opposite ways.
fn marks(profiles: &[Profile], outlines: &[Outline]) -> Try<Vec<Vec<f64>>> {
    let mut places = Vec::with_capacity(profiles.len());
    let mut ways: Vec<Option<bool>> = Vec::with_capacity(profiles.len());
    for (k, (p, o)) in profiles.iter().zip(outlines).enumerate() {
        let bad = |why: String| Error::invalid("profiles", format!("profile {}: {why}", k + 1));
        let mut at = Vec::with_capacity(p.landmarks.len());
        for (j, &l) in p.landmarks.iter().enumerate() {
            at.push(o.place_of(l).ok_or_else(|| {
                bad(format!(
                    "landmark {} at ({:.3}, {:.3}) is not on the profile",
                    j + 1,
                    l[0],
                    l[1]
                ))
            })?);
        }
        let t = o.total();
        let eps = t * 1e-9;
        let rising = |v: &[f64]| v.windows(2).all(|w| w[1] - w[0] > eps);
        let fwd: Vec<f64> = at.iter().map(|&s| (s - at[0]).rem_euclid(t)).collect();
        let back: Vec<f64> = fwd.iter().map(|&s| (t - s).rem_euclid(t)).collect();
        let (f, b) = (rising(&fwd), rising(&back));
        if !f && !b {
            return Err(bad("its landmarks are not in order around it".into()).into());
        }
        ways.push((at.len() >= 3).then_some(f));
        places.push(at);
    }
    let set = ways.iter().position(Option::is_some);
    let want = set.and_then(|r| ways[r]).unwrap_or(true);
    if let Some(k) = ways.iter().position(|w| w.is_some_and(|f| f != want)) {
        return Err(Error::invalid(
            "profiles",
            format!(
                "profile {}'s landmarks run around the other way from profile {}'s; list them in the same order on every profile",
                k + 1,
                set.unwrap_or(0) + 1
            ),
        )
        .into());
    }
    if !want {
        // listed against the winding: the same points, the first still first
        for at in &mut places {
            at[1..].reverse();
        }
    }
    Ok(places)
}

/// One matched piece: the rails it runs between and what it is on each profile.
#[derive(Debug, Clone, PartialEq)]
pub struct Piece {
    /// The rail it starts at; it ends at rail `first + stretches`, around to the first rail again on a closed ring.
    pub first: usize,
    /// How many stretches between neighboring rails it covers.
    pub stretches: usize,
    /// What it is on each profile, in the profiles' order: a face over lines alone can be ruled across its rails,
    /// and one with an arc or a spline is skinned across them.
    pub curves: Vec<Curve>,
}

/// Profiles matched piece to piece: each one's ring points and which of them it has itself, and the pieces.
pub(super) struct Matched {
    pub(super) frames: Vec<Frame>,
    pub(super) flats: Vec<Vec<V2>>,
    pub(super) corners: Vec<Vec<bool>>,
    pub(super) pieces: Vec<Piece>,
}

/// Matches closed `profiles` piece to piece for a loft that is `closed` into a ring or not.
///
/// Every profile is wound counterclockwise about the way the loft goes, as the mesh loft winds them, so the way a
/// profile was drawn never matters. Neighbors line up at the least twist ([`least_twist`]), or at their landmarks
/// when they have them: landmark `j` of every profile is on one rail, and the pieces between two landmarks are
/// matched among themselves. Where two neighbors pair piece for piece, their corners match. Where they do not, places
/// match by how far along each profile they are, and each is split where the other's corners land on it, so a line
/// may pair with an arc (a hexagon's side with a sixth of a circle). A circle, an ellipse or one arc all the way
/// around has no corner: it is split only where other profiles' corners land, and with none anywhere the loft is one
/// piece all the way around, its first rail at the first profile's start.
///
/// A spline is matched only to a spline. Refused as unmatched: open chains, closed splines, arcs beside splines, a
/// spline that would pair with anything but a spline, and a ring whose rails do not come back onto themselves after
/// one time around.
pub(super) fn matched(profiles: &[Profile], closed: bool, density: &Density) -> Try<Matched> {
    if !(density.arc_step_deg.is_finite() && density.arc_step_deg > 0.0 && density.least >= 1) {
        return Err(Error::invalid(
            "density",
            "needs an arc step above 0 degrees and 1 or more stretches a piece",
        )
        .into());
    }
    let count = profiles.len();
    let mut frames = Vec::with_capacity(count);
    let mut lined = Vec::with_capacity(count);
    for (k, p) in profiles.iter().enumerate() {
        let frame = frame_of(p)?;
        frames.push(frame);
        lined.push(Lined::new(outline_of(k, p)?, frame));
    }
    let along = alongs(&lined.iter().map(|l| l.center).collect::<Vec<V3>>(), closed);
    for (l, a) in lined.iter_mut().zip(&along) {
        if vec3::dot(l.frame.w, *a) < 0.0 {
            *l = Lined::new(l.outline.reversed(), l.frame);
        }
    }
    let outlines: Vec<Outline> = lined.iter().map(|l| l.outline.clone()).collect();
    let places = if landmarked(profiles)? {
        Some(marks(profiles, &outlines)?)
    } else {
        None
    };
    let map = |i: usize, j: usize| -> Map {
        let (anchors, pair): (Vec<(f64, f64)>, bool) = if let Some(p) = &places {
            (p[i].iter().copied().zip(p[j].iter().copied()).collect(), true)
        } else {
            let (anchor, pair) = least_twist(&lined[i], &lined[j]);
            (vec![anchor], pair)
        };
        Map::new(&outlines[i], &outlines[j], &anchors, pair)
    };
    let maps: Vec<Map> = (1..count).map(|k| map(k - 1, k)).collect();
    let mut rails: Vec<Rail> = Vec::new();
    for (k, o) in outlines.iter().enumerate() {
        let mut breaks = o.corners().to_vec();
        if let Some(p) = &places {
            breaks.extend(p[k].iter().filter(|&&t| !o.corners().contains(&t)));
        }
        join(&mut rails, &outlines, &maps, k, &breaks);
    }
    if rails.is_empty() {
        // no corner anywhere: one piece all the way around, from the first profile's start
        let mut at = vec![0.0];
        for m in &maps {
            at.push(m.to(at[at.len() - 1]));
        }
        rails.push(Rail {
            at,
            own: vec![false; count],
        });
    }
    rails.sort_by(|x, y| x.at[0].total_cmp(&y.at[0]));
    if closed {
        let around = map(count - 1, 0);
        if rails
            .iter()
            .any(|r| outlines[0].gap(around.to(r.at[count - 1]), r.at[0]) > SAME_PLACE_MM)
        {
            return unmatched(
                "the pieces do not come back onto themselves around the ring, so its rails would not close",
            );
        }
    }
    cut(&frames, &outlines, &rails, density)
}

/// The ring points and pieces of `rails`: each stretch from one rail to the next around is a piece, cut by as many
/// rails of its own as `density` asks.
fn cut(frames: &[Frame], outlines: &[Outline], rails: &[Rail], density: &Density) -> Try<Matched> {
    let count = outlines.len();
    let mut flats = vec![Vec::new(); count];
    let mut corners = vec![Vec::new(); count];
    let mut pieces = Vec::with_capacity(rails.len());
    let mut first = 0;
    for (j, r) in rails.iter().enumerate() {
        let next = &rails[(j + 1) % rails.len()];
        // on each profile: the part the piece is on and the fractions of it the piece runs between
        let mut on = Vec::with_capacity(count);
        for (k, o) in outlines.iter().enumerate() {
            let i = o.part_at(r.at[k]);
            let past = (next.at[k] - r.at[k]).rem_euclid(o.total());
            let past = if rails.len() == 1 { o.total() } else { past };
            let f0 = o.fraction(i, r.at[k], false);
            // a closed curve runs on through its start; a drawn piece ends at its own end
            let f1 = if o.free {
                f0 + past / o.total()
            } else {
                o.fraction(i, next.at[k], true)
            };
            let len = (f1 - f0) * (o.at[i + 1] - o.at[i]);
            // the next rail must lie ahead on this same part
            let ahead = (past - len).abs() <= THIN_MM;
            if !(ahead && len > THIN_MM) {
                return unmatched(format!(
                    "profile {} would be cut into a piece too thin to match",
                    k + 1
                ));
            }
            on.push((i, f0, f1));
        }
        let curves: Vec<Curve> = on
            .iter()
            .zip(outlines)
            .map(|(&(i, f0, f1), o)| o.parts[i].cut(f0, f1))
            .collect();
        let spline = |c: &Curve| matches!(c, Curve::Spline { .. });
        if let (Some(s), Some(o)) = (
            curves.iter().position(spline),
            curves.iter().position(|c| !spline(c)),
        ) {
            return unmatched(format!(
                "a spline is matched only to a spline, and profile {} has none where profile {} has one",
                o + 1,
                s + 1
            ));
        }
        let widest = curves.iter().map(Curve::sweep).fold(0.0, f64::max).to_degrees();
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "at most 360 degrees over a step above 0, checked against MAX_RING below"
        )]
        let by_angle = (widest / density.arc_step_deg - 1e-9)
            .ceil()
            .clamp(0.0, MAX_RING as f64 + 1.0) as usize;
        let stretches = density.least.max(by_angle);
        if first + stretches > MAX_RING {
            return Err(Error::invalid(
                "profiles",
                format!("the matched profiles would have more than {MAX_RING} points each"),
            )
            .into());
        }
        for (k, (&(i, f0, f1), o)) in on.iter().zip(outlines).enumerate() {
            for g in 0..stretches {
                flats[k].push(o.parts[i].at(f0 + (f1 - f0) * g as f64 / stretches as f64));
                corners[k].push(g == 0 && r.own[k]);
            }
        }
        pieces.push(Piece {
            first,
            stretches,
            curves,
        });
        first += stretches;
    }
    Ok(Matched {
        frames: frames.to_vec(),
        flats,
        corners,
        pieces,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(side: f64) -> Outline {
        let p = [[0.0, 0.0], [side, 0.0], [side, side], [0.0, side]];
        Outline::new(
            (0..4)
                .map(|i| Part {
                    from: p[i],
                    to: p[(i + 1) % 4],
                    curve: Curve::Line,
                })
                .collect(),
        )
    }

    /// The rails of a square joined to a square with breaks of its own at `second`, places matched by how far along.
    fn joined(first: &[f64], second: &[f64]) -> Vec<Rail> {
        let outlines = [square(10.0), square(10.0)];
        let maps = [Map {
            a: vec![0.0],
            b: vec![0.0],
            ta: 40.0,
            tb: 40.0,
        }];
        let mut rails = Vec::new();
        join(&mut rails, &outlines, &maps, 0, first);
        join(&mut rails, &outlines, &maps, 1, second);
        rails
    }

    #[test]
    fn places_within_the_tolerance_are_one_rail() {
        // marks along a side, no corner near: only the least reach holds
        let inside = joined(&[5.0], &[5.0 + SAME_PLACE_MM * 0.9]);
        assert_eq!(inside.len(), 1);
        // the rail takes each profile's own place
        assert_eq!(inside[0].at[1].to_bits(), (5.0 + SAME_PLACE_MM * 0.9).to_bits());
        assert!(inside[0].own[0] && inside[0].own[1]);
        let outside = joined(&[5.0], &[5.0 + SAME_PLACE_MM * 1.1]);
        assert_eq!(outside.len(), 2);
        assert!(outside[0].own[0] && !outside[0].own[1], "{outside:?}");
    }

    #[test]
    fn a_place_within_the_share_of_a_corner_s_sides_is_that_corner() {
        // the corner at 10 has 10 mm sides, so it reaches half a millimeter
        let corners = [0.0, 10.0, 20.0, 30.0];
        let reach = SNAP_SHARE * 10.0;
        let inside = joined(&corners, &[10.0 + reach * 0.9]);
        assert_eq!(inside.len(), 4);
        let r = inside.iter().find(|r| r.at[0] == 10.0).unwrap();
        assert!(r.own[1] && r.at[1] == 10.0 + reach * 0.9, "{r:?}");
        let outside = joined(&corners, &[10.0 + reach * 1.1]);
        assert_eq!(outside.len(), 5);
        // the same from the other side: the corner is the later profile's own
        let later = joined(&[10.0 + reach * 0.9], &corners);
        assert_eq!(later.len(), 4);
        assert_eq!(joined(&[10.0 + reach * 1.1], &corners).len(), 5);
    }

    #[test]
    fn two_places_never_take_one_rail() {
        let corners = [0.0, 10.0, 20.0, 30.0];
        // both within reach of the corner at 10: the nearer takes it and the other keeps a rail of its own
        let both = joined(&corners, &[9.9, 10.3]);
        assert_eq!(both.len(), 5);
        let r = both.iter().find(|r| r.at[0] == 10.0).unwrap();
        assert!(r.own[1] && r.at[1] == 9.9, "{r:?}");
        assert!(both.iter().any(|r| r.at[1] == 10.3 && r.own[1] && !r.own[0]));
        // equally near: neither takes it, and the corner's rail stays between them
        let tie = joined(&corners, &[9.75, 10.25]);
        assert_eq!(tie.len(), 6);
        let r = tie.iter().find(|r| r.at[0] == 10.0).unwrap();
        assert!(!r.own[1] && r.at[1] == 10.0, "{r:?}");
    }

    #[test]
    fn a_matched_place_goes_across_exactly_and_others_evenly() {
        let m = Map {
            a: vec![30.0, 5.0],
            b: vec![1.0, 9.0],
            ta: 40.0,
            tb: 16.0,
        };
        assert_eq!(m.to(30.0).to_bits(), 1.0f64.to_bits());
        assert_eq!(m.to(5.0).to_bits(), 9.0f64.to_bits());
        assert_eq!(m.back(9.0).to_bits(), 5.0f64.to_bits());
        // halfway from 30 around to 5 is 37.5, and halfway from 1 to 9 is 5
        assert!((m.to(37.5) - 5.0).abs() < 1e-12);
        // halfway from 5 to 30 is 17.5, and halfway from 9 around to 1 is 13
        assert!((m.to(17.5) - 13.0).abs() < 1e-12);
        assert!((m.back(13.0) - 17.5).abs() < 1e-12);
    }

    #[test]
    fn an_arc_takes_the_nearest_end_for_a_point_past_it() {
        let quarter = Part {
            from: [1.0, 0.0],
            to: [0.0, 1.0],
            curve: Curve::Arc {
                center: [0.0, 0.0],
                radius: 1.0,
                from: 0.0,
                sweep: TAU / 4.0,
            },
        };
        let (f, off) = quarter.nearest([0.5f64.sqrt(), 0.5f64.sqrt()]);
        assert!((f - 0.5).abs() < 1e-12 && off < 1e-12);
        assert_eq!(quarter.nearest([0.9, -0.3]).0, 0.0);
        assert_eq!(quarter.nearest([-0.3, 0.9]).0, 1.0);
        let back = quarter.reversed();
        let (f, off) = back.nearest([0.5f64.sqrt(), 0.5f64.sqrt()]);
        assert!((f - 0.5).abs() < 1e-12 && off < 1e-12);
        let p = back.at(0.25);
        let q = quarter.at(0.75);
        assert!((p[0] - q[0]).abs() < 1e-12 && (p[1] - q[1]).abs() < 1e-12);
    }
}
