// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sketch edit tools: where curves cross, trim, extend, mirror and pattern
// loop and segment indices are checked against the parsed loops
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::sketch::{self, Loop, Segment};
use crate::vec3::V2;
use serde::{Deserialize, Serialize};
use std::f64::consts::TAU;

// params this close to a curve's end are its end
const EPS_T: f64 = 1e-9;
// points this close are one, mm
const EPS_MM: f64 = 1e-7;
const MAX_COPIES: usize = 1000;

/// a line from a to b, or an arc around c from angle a0 through sweep (radians, ccw when positive)
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Curve {
    Line { a: V2, b: V2 },
    Arc { c: V2, r: f64, a0: f64, sweep: f64 },
}

impl Curve {
    pub fn at(self, t: f64) -> V2 {
        match self {
            Self::Line { a, b } => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
            Self::Arc { c, r, a0, sweep } => {
                let (s, co) = (a0 + sweep * t).m_sin_cos();
                [c[0] + r * co, c[1] + r * s]
            }
        }
    }

    // the part from t0 to t1, as a curve of its own
    fn part(self, t0: f64, t1: f64) -> Self {
        match self {
            Self::Line { .. } => Self::Line {
                a: self.at(t0),
                b: self.at(t1),
            },
            Self::Arc { c, r, a0, sweep } => Self::Arc {
                c,
                r,
                a0: a0 + sweep * t0,
                sweep: sweep * (t1 - t0),
            },
        }
    }

    fn full_circle(self) -> bool {
        matches!(self, Self::Arc { sweep, .. } if sweep.abs() >= TAU - 1e-12)
    }

    // where a point on the carrier sits along the curve, None when off its ends
    fn param(self, p: V2) -> Option<f64> {
        match self {
            Self::Line { a, b } => {
                let d = sub(b, a);
                let l2 = dot(d, d);
                let t = if l2 > 0.0 { dot(sub(p, a), d) / l2 } else { 0.0 };
                let tol = EPS_MM / l2.sqrt().max(EPS_MM);
                (t >= -tol && t <= 1.0 + tol).then(|| t.clamp(0.0, 1.0))
            }
            Self::Arc { c, r, a0, sweep } => {
                let th = (p[1] - c[1]).m_atan2(p[0] - c[0]);
                let mut d = ((th - a0) * sweep.signum()).rem_euclid(TAU);
                let tol = EPS_MM / r.max(EPS_MM);
                // just before the start counts as the start
                if d > TAU - tol {
                    d = 0.0;
                }
                let t = d / sweep.abs();
                (t <= 1.0 + tol).then(|| t.min(1.0))
            }
        }
    }
}

fn sub(a: V2, b: V2) -> V2 {
    [a[0] - b[0], a[1] - b[1]]
}

fn dot(a: V2, b: V2) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

fn cross(a: V2, b: V2) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

fn dist(a: V2, b: V2) -> f64 {
    (a[0] - b[0]).m_hypot(a[1] - b[1])
}

/// a loop as curves: a circle, or a chain from its start, open or closed
#[derive(Debug, Clone, PartialEq)]
pub struct Shape {
    pub curves: Vec<Curve>,
    pub circle: bool,
    pub closed: bool,
    pub construction: bool,
}

/// the loops as curves; lines need their ends as points
pub fn shapes(loops: &[Loop]) -> Result<Vec<Shape>> {
    loops.iter().enumerate().map(|(l, lp)| shape(l, lp)).collect()
}

fn shape(l: usize, lp: &Loop) -> Result<Shape> {
    let bad = |why: String| Error::invalid("loops", format!("loop {}: {why}", l + 1));
    if lp.kind.as_deref() == Some("circle") {
        let (Some(c), Some(d)) = (lp.center, lp.diameter_mm) else {
            return Err(bad("a circle needs center and diameterMm".into()));
        };
        if !(d > 0.0 && d.is_finite()) {
            return Err(bad("a circle needs a diameter above 0".into()));
        }
        return Ok(Shape {
            curves: vec![Curve::Arc {
                c,
                r: d / 2.0,
                a0: 0.0,
                sweep: TAU,
            }],
            circle: true,
            closed: true,
            construction: lp.construction,
        });
    }
    if !lp.points.is_empty() {
        let p = &lp.points;
        let curves = (0..p.len())
            .map(|i| Curve::Line {
                a: p[i],
                b: p[(i + 1) % p.len()],
            })
            .collect();
        return Ok(Shape {
            curves,
            circle: false,
            closed: true,
            construction: lp.construction,
        });
    }
    let Some(start) = lp.start else {
        return Err(bad("a chain needs a start".into()));
    };
    let mut pos = start;
    let mut dir = [1.0, 0.0];
    let mut curves = Vec::with_capacity(lp.segments.len());
    for (s, seg) in lp.segments.iter().enumerate() {
        let c = if seg.kind == "arc" {
            let (c, a0, sweep, _) =
                sketch::arc_of(l, s, seg, pos, dir).map_err(|i| Error::invalid("loops", i.message))?;
            Curve::Arc {
                c,
                r: dist(pos, c),
                a0,
                sweep,
            }
        } else {
            let Some(to) = seg.to else {
                return Err(bad(format!("segment {} needs its end as to", s + 1)));
            };
            Curve::Line { a: pos, b: to }
        };
        let end = match (seg.kind.as_str(), seg.to) {
            ("arc", Some(to)) => to,
            _ => c.at(1.0),
        };
        dir = tangent(c, 1.0);
        pos = end;
        curves.push(c);
    }
    let closed = curves.len() > 1 && dist(pos, start) < sketch::CLOSE_MM;
    Ok(Shape {
        curves,
        circle: false,
        closed,
        construction: lp.construction,
    })
}

// unit direction of travel at t
fn tangent(c: Curve, t: f64) -> V2 {
    match c {
        Curve::Line { a, b } => {
            let d = sub(b, a);
            let l = d[0].m_hypot(d[1]).max(1e-300);
            [d[0] / l, d[1] / l]
        }
        Curve::Arc { a0, sweep, .. } => {
            let (s, co) = (a0 + sweep * t).m_sin_cos();
            if sweep > 0.0 { [-s, co] } else { [s, -co] }
        }
    }
}

/// where two curves meet: (param on a, param on b, point); lines along each other meet nowhere
pub fn meet(a: Curve, b: Curve) -> Vec<(f64, f64, V2)> {
    let pts: Vec<V2> = match (a, b) {
        (Curve::Line { a: p, b: q }, Curve::Line { a: r, b: s }) => {
            let (d1, d2) = (sub(q, p), sub(s, r));
            let den = cross(d1, d2);
            if den.abs() <= 1e-12 * dot(d1, d1).sqrt() * dot(d2, d2).sqrt() {
                return Vec::new();
            }
            let t = cross(sub(r, p), d2) / den;
            vec![[p[0] + d1[0] * t, p[1] + d1[1] * t]]
        }
        (Curve::Line { a: p, b: q }, Curve::Arc { c, r, .. })
        | (Curve::Arc { c, r, .. }, Curve::Line { a: p, b: q }) => line_circle(p, q, c, r),
        (Curve::Arc { c: c1, r: r1, .. }, Curve::Arc { c: c2, r: r2, .. }) => circle_circle(c1, r1, c2, r2),
    };
    pts.into_iter()
        .filter_map(|p| Some((a.param(p)?, b.param(p)?, p)))
        .collect()
}

// the infinite line through p and q against a circle
fn line_circle(p: V2, q: V2, c: V2, r: f64) -> Vec<V2> {
    let d = sub(q, p);
    let f = sub(p, c);
    let aa = dot(d, d);
    if aa <= 0.0 {
        return Vec::new();
    }
    let bb = 2.0 * dot(f, d);
    let cc = dot(f, f) - r * r;
    let disc = bb * bb - 4.0 * aa * cc;
    // a line just touching counts once
    let tol = 4.0 * aa * (2.0 * r * EPS_MM);
    if disc < -tol {
        return Vec::new();
    }
    let root = disc.max(0.0).sqrt();
    let at = |t: f64| [p[0] + d[0] * t, p[1] + d[1] * t];
    if root * root <= tol {
        return vec![at(-bb / (2.0 * aa))];
    }
    vec![at((-bb - root) / (2.0 * aa)), at((-bb + root) / (2.0 * aa))]
}

fn circle_circle(c1: V2, r1: f64, c2: V2, r2: f64) -> Vec<V2> {
    let d = dist(c1, c2);
    if d < EPS_MM || d > r1 + r2 + EPS_MM || d < (r1 - r2).abs() - EPS_MM {
        return Vec::new();
    }
    let a = (r1 * r1 - r2 * r2 + d * d) / (2.0 * d);
    let h2 = r1 * r1 - a * a;
    let u = [(c2[0] - c1[0]) / d, (c2[1] - c1[1]) / d];
    let m = [c1[0] + u[0] * a, c1[1] + u[1] * a];
    if h2 <= (2.0 * r1 * EPS_MM).max(0.0) {
        return vec![m];
    }
    let h = h2.sqrt();
    vec![
        [m[0] - u[1] * h, m[1] + u[0] * h],
        [m[0] + u[1] * h, m[1] - u[0] * h],
    ]
}

/// one place a segment is crossed or touched by another
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Hit {
    #[serde(rename = "loop")]
    pub loop_index: usize,
    pub segment: usize,
    pub t: f64,
    pub at: V2,
}

// every curve with its loop and segment
fn all(shapes: &[Shape]) -> Vec<(usize, usize, Curve)> {
    shapes
        .iter()
        .enumerate()
        .flat_map(|(l, s)| s.curves.iter().enumerate().map(move |(k, &c)| (l, k, c)))
        .collect()
}

// where curve (l, k) is met by the others, sorted, its own ends left out
fn hits_on(shapes: &[Shape], l: usize, k: usize) -> Vec<f64> {
    let me = shapes[l].curves[k];
    let mut ts: Vec<f64> = all(shapes)
        .into_iter()
        .filter(|&(ol, ok, _)| (ol, ok) != (l, k))
        .flat_map(|(_, _, o)| meet(me, o).into_iter().map(|(t, _, _)| t))
        .filter(|&t| me.full_circle() || (t > EPS_T && t < 1.0 - EPS_T))
        .collect();
    ts.sort_by(f64::total_cmp);
    ts.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    ts
}

/// every crossing and touch between segments, once for each segment it lies on
pub fn intersections(loops: &[Loop]) -> Result<Vec<Hit>> {
    let shapes = shapes(loops)?;
    let curves = all(&shapes);
    let mut out = Vec::new();
    for (i, &(la, ka, a)) in curves.iter().enumerate() {
        for &(lb, kb, b) in &curves[i + 1..] {
            for (ta, tb, at) in meet(a, b) {
                // a chain's own corners are not crossings
                let ends = |t: f64| t < EPS_T || t > 1.0 - EPS_T;
                if la == lb && ends(ta) && ends(tb) && !a.full_circle() {
                    continue;
                }
                out.push(Hit {
                    loop_index: la,
                    segment: ka,
                    t: ta,
                    at,
                });
                out.push(Hit {
                    loop_index: lb,
                    segment: kb,
                    t: tb,
                    at,
                });
            }
        }
    }
    Ok(out)
}

// a run of curves joined end to end
struct Run {
    curves: Vec<Curve>,
    closed: bool,
    construction: bool,
}

/// what the edits give back: the loops, a trimmed one's pieces in its place and copies at the end
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Edited {
    pub loops: Vec<Loop>,
    /// for each loop out, the loops it came from: one, or more where trim joined pieces end to end
    pub from: Vec<Vec<usize>>,
    /// what trim took off, to show before the click
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<Loop>,
}

/// takes off the piece of segment `seg` of loop `l` under `at`, between the nearest crossings either side
pub fn trim(loops: &[Loop], l: usize, seg: usize, at: V2) -> Result<Edited> {
    let sh = shapes(loops)?;
    let Some(s) = sh.get(l) else {
        return Err(Error::invalid("loop", format!("there is no loop {}", l + 1)));
    };
    let Some(&me) = s.curves.get(seg) else {
        return Err(Error::invalid(
            "segment",
            format!("loop {} has no segment {}", l + 1, seg + 1),
        ));
    };
    let tc = nearest_param(me, at);
    let ts = hits_on(&sh, l, seg);
    let mut runs: Vec<Run> = Vec::new();
    let removed;
    if s.circle {
        // two crossings at least leave an arc from the one after the cursor round to the one before
        if ts.len() >= 2 {
            let hi = ts.iter().copied().find(|&t| t > tc).unwrap_or(ts[0]);
            let lo = ts
                .iter()
                .copied()
                .rev()
                .find(|&t| t < tc)
                .unwrap_or(ts[ts.len() - 1]);
            let span = (lo - hi).rem_euclid(1.0);
            removed = to_loop(&Run {
                curves: vec![me.part(lo, lo + (hi - lo).rem_euclid(1.0))],
                closed: false,
                construction: s.construction,
            });
            runs.push(Run {
                curves: vec![me.part(hi, hi + span)],
                closed: false,
                construction: s.construction,
            });
        } else {
            removed = loops[l].clone();
        }
    } else {
        let lo = ts.iter().copied().rev().find(|&t| t < tc).unwrap_or(0.0);
        let hi = ts.iter().copied().find(|&t| t > tc).unwrap_or(1.0);
        removed = to_loop(&Run {
            curves: vec![me.part(lo, hi)],
            closed: false,
            construction: s.construction,
        });
        let n = s.curves.len();
        // the chain read from just after the cut round to just before it
        let mut before: Vec<Curve> = s.curves[..seg].to_vec();
        if lo > EPS_T {
            before.push(me.part(0.0, lo));
        }
        let mut after: Vec<Curve> = Vec::new();
        if hi < 1.0 - EPS_T {
            after.push(me.part(hi, 1.0));
        }
        after.extend_from_slice(&s.curves[seg + 1..n]);
        if s.closed {
            after.extend(before);
            if !after.is_empty() {
                runs.push(Run {
                    curves: after,
                    closed: false,
                    construction: s.construction,
                });
            }
        } else {
            for r in [before, after] {
                if !r.is_empty() {
                    runs.push(Run {
                        curves: r,
                        closed: false,
                        construction: s.construction,
                    });
                }
            }
        }
    }
    let mut out = rebuild(loops, &sh, l, &runs);
    out.removed = Some(removed);
    Ok(out)
}

// a loop on its way out: open ones keep their curves to join by
struct Item {
    lp: Loop,
    from: Vec<usize>,
    open: Option<Vec<Curve>>,
    construction: bool,
    // a piece of the trimmed loop, or joined to one
    touched: bool,
}

// the loops with loop `l` replaced by `runs` in its place, each piece joined end to end with the open chains it
// meets, so an outline trimmed out of crossing shapes closes into one loop
fn rebuild(loops: &[Loop], sh: &[Shape], l: usize, runs: &[Run]) -> Edited {
    let mut items: Vec<Item> = Vec::with_capacity(loops.len() + runs.len());
    for (i, lp) in loops.iter().enumerate() {
        if i == l {
            for r in runs {
                // a chain whose cut left its two ends on one point closes
                let (a, b) = (r.curves[0].at(0.0), r.curves[r.curves.len() - 1].at(1.0));
                let closed = r.curves.len() > 1 && dist(a, b) < sketch::CLOSE_MM;
                items.push(Item {
                    lp: to_loop(&Run {
                        curves: r.curves.clone(),
                        closed,
                        construction: r.construction,
                    }),
                    from: vec![l],
                    open: (!closed).then(|| r.curves.clone()),
                    construction: r.construction,
                    touched: true,
                });
            }
        } else {
            let s = &sh[i];
            items.push(Item {
                lp: lp.clone(),
                from: vec![i],
                open: (!s.circle && !s.closed && !s.curves.is_empty()).then(|| s.curves.clone()),
                construction: s.construction,
                touched: false,
            });
        }
    }
    while join_once(&mut items) {}
    Edited {
        from: items.iter().map(|i| i.from.clone()).collect(),
        loops: items.into_iter().map(|i| i.lp).collect(),
        removed: None,
    }
}

// joins one touched open chain to another whose end meets one of its ends; false when none do
fn join_once(items: &mut Vec<Item>) -> bool {
    let near = |p: V2, q: V2| dist(p, q) < sketch::CLOSE_MM;
    let ends = |c: &[Curve]| (c[0].at(0.0), c[c.len() - 1].at(1.0));
    for a in 0..items.len() {
        let Some(ca) = items[a].open.as_deref().filter(|_| items[a].touched) else {
            continue;
        };
        let (a0, a1) = ends(ca);
        for b in 0..items.len() {
            if b == a || items[b].construction != items[a].construction {
                continue;
            }
            let Some(cb) = items[b].open.as_deref() else {
                continue;
            };
            let (b0, b1) = ends(cb);
            let curves: Vec<Curve> = if near(a1, b0) {
                ca.iter().chain(cb).copied().collect()
            } else if near(a1, b1) {
                ca.iter().copied().chain(backwards(cb)).collect()
            } else if near(a0, b1) {
                cb.iter().chain(ca).copied().collect()
            } else if near(a0, b0) {
                backwards(cb).chain(ca.iter().copied()).collect()
            } else {
                continue;
            };
            let (s0, s1) = ends(&curves);
            let closed = curves.len() > 1 && near(s0, s1);
            let construction = items[a].construction;
            let mut from = items[a].from.clone();
            from.extend_from_slice(&items[b].from);
            from.sort_unstable();
            from.dedup();
            let (keep, gone) = (a.min(b), a.max(b));
            items[keep] = Item {
                lp: to_loop(&Run {
                    curves: curves.clone(),
                    closed,
                    construction,
                }),
                from,
                open: (!closed).then_some(curves),
                construction,
                touched: true,
            };
            items.remove(gone);
            return true;
        }
    }
    false
}

fn backwards(c: &[Curve]) -> impl Iterator<Item = Curve> + '_ {
    c.iter().rev().map(|&k| reverse(k))
}

fn nearest_param(c: Curve, p: V2) -> f64 {
    match c {
        Curve::Line { a, b } => {
            let d = sub(b, a);
            let l2 = dot(d, d);
            if l2 > 0.0 {
                (dot(sub(p, a), d) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            }
        }
        Curve::Arc { c: ctr, r, .. } => {
            let d = dist(p, ctr).max(1e-300);
            let on = [ctr[0] + (p[0] - ctr[0]) * r / d, ctr[1] + (p[1] - ctr[1]) * r / d];
            c.param(on).unwrap_or_else(|| {
                if dist(on, c.at(0.0)) <= dist(on, c.at(1.0)) {
                    0.0
                } else {
                    1.0
                }
            })
        }
    }
}

fn arc_seg(c: Curve) -> Segment {
    Segment {
        kind: "arc".into(),
        to: Some(c.at(1.0)),
        through: Some(c.at(0.5)),
        ..Segment::default()
    }
}

fn line_seg(to: V2) -> Segment {
    Segment {
        kind: "line".into(),
        to: Some(to),
        ..Segment::default()
    }
}

fn to_loop(r: &Run) -> Loop {
    let start = r.curves.first().map_or([0.0, 0.0], |c| c.at(0.0));
    let segments = r
        .curves
        .iter()
        .enumerate()
        .map(|(i, &c)| {
            // a closed run ends exactly on its start
            let last = r.closed && i + 1 == r.curves.len();
            match c {
                Curve::Line { b, .. } => line_seg(if last { start } else { b }),
                Curve::Arc { .. } => {
                    let mut s = arc_seg(c);
                    if last {
                        s.to = Some(start);
                    }
                    s
                }
            }
        })
        .collect();
    Loop {
        start: Some(start),
        segments,
        construction: r.construction,
        ..Loop::default()
    }
}

/// which end of an open chain
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum End {
    Start,
    End,
}

/// runs the end segment of open chain `l` on to the nearest curve it would meet
pub fn extend(loops: &[Loop], l: usize, end: End) -> Result<Edited> {
    let sh = shapes(loops)?;
    let Some(s) = sh.get(l) else {
        return Err(Error::invalid("loop", format!("there is no loop {}", l + 1)));
    };
    if s.circle || s.closed || s.curves.is_empty() {
        return Err(Error::invalid(
            "loop",
            format!("loop {} is closed; only an open end extends", l + 1),
        ));
    }
    let k = if end == End::End { s.curves.len() - 1 } else { 0 };
    // read the end segment so that it leaves through t = 1
    let me = match end {
        End::End => s.curves[k],
        End::Start => reverse(s.curves[k]),
    };
    let others: Vec<Curve> = all(&sh)
        .into_iter()
        .filter(|&(ol, ok, _)| (ol, ok) != (l, k))
        .map(|(_, _, c)| c)
        .collect();
    let grown = match me {
        Curve::Line { a, b } => {
            // the line carried on past b
            let reach = Curve::Line {
                a: b,
                b: [b[0] + (b[0] - a[0]) * 1e6, b[1] + (b[1] - a[1]) * 1e6],
            };
            let t = others
                .iter()
                .flat_map(|&o| meet(reach, o))
                .map(|(t, _, _)| t)
                .filter(|&t| t * dist(reach.at(0.0), reach.at(1.0)) > EPS_MM * 10.0)
                .fold(f64::INFINITY, f64::min);
            t.is_finite().then(|| Curve::Line { a, b: reach.at(t) })
        }
        Curve::Arc { c, r, a0, sweep } => {
            // the rest of the circle past the end, in the same direction
            let rest = TAU - sweep.abs();
            if rest <= 1e-9 {
                None
            } else {
                let reach = Curve::Arc {
                    c,
                    r,
                    a0: a0 + sweep,
                    sweep: rest * sweep.signum(),
                };
                let t = others
                    .iter()
                    .flat_map(|&o| meet(reach, o))
                    .map(|(t, _, _)| t)
                    .filter(|&t| t * rest * r > EPS_MM * 10.0)
                    .fold(f64::INFINITY, f64::min);
                t.is_finite().then(|| Curve::Arc {
                    c,
                    r,
                    a0,
                    sweep: sweep + rest * sweep.signum() * t,
                })
            }
        }
    };
    let Some(grown) = grown else {
        return Err(Error::invalid(
            "loop",
            "nothing to extend to: the end would meet no other curve",
        ));
    };
    let mut curves = s.curves.clone();
    curves[k] = match end {
        End::End => grown,
        End::Start => reverse(grown),
    };
    let mut out = loops.to_vec();
    out[l] = to_loop(&Run {
        curves,
        closed: false,
        construction: s.construction,
    });
    Ok(Edited {
        from: (0..out.len()).map(|i| vec![i]).collect(),
        loops: out,
        removed: None,
    })
}

fn reverse(c: Curve) -> Curve {
    match c {
        Curve::Line { a, b } => Curve::Line { a: b, b: a },
        Curve::Arc { c, r, a0, sweep } => Curve::Arc {
            c,
            r,
            a0: a0 + sweep,
            sweep: -sweep,
        },
    }
}

fn map_loop(lp: &Loop, sh: &Shape, f: &dyn Fn(V2) -> V2) -> Loop {
    if sh.circle {
        return Loop {
            center: lp.center.map(f),
            ..lp.clone()
        };
    }
    let start = sh.curves.first().map_or([0.0, 0.0], |c| c.at(0.0));
    let segments = sh
        .curves
        .iter()
        .enumerate()
        .map(|(i, &c)| {
            let last = sh.closed && i + 1 == sh.curves.len();
            let to = if last { f(start) } else { f(c.at(1.0)) };
            match c {
                Curve::Line { .. } => line_seg(to),
                Curve::Arc { .. } => Segment {
                    kind: "arc".into(),
                    to: Some(to),
                    through: Some(f(c.at(0.5))),
                    ..Segment::default()
                },
            }
        })
        .collect();
    Loop {
        start: Some(f(start)),
        segments,
        construction: lp.construction,
        ..Loop::default()
    }
}

fn picked<'a>(loops: &'a [Loop], sh: &'a [Shape], pick: &[usize]) -> Result<Vec<(&'a Loop, &'a Shape)>> {
    if pick.is_empty() {
        return Err(Error::invalid("pick", "pick at least one loop"));
    }
    pick.iter()
        .map(|&i| match (loops.get(i), sh.get(i)) {
            (Some(l), Some(s)) => Ok((l, s)),
            _ => Err(Error::invalid("pick", format!("there is no loop {}", i + 1))),
        })
        .collect()
}

/// the picked loops mirrored across the line through `point` along `direction`, added after the rest
pub fn mirror(loops: &[Loop], pick: &[usize], point: V2, direction: V2) -> Result<Edited> {
    let sh = shapes(loops)?;
    let len = direction[0].m_hypot(direction[1]);
    if len.is_nan() || len <= 1e-12 {
        return Err(Error::invalid("axis", "the mirror line needs a direction"));
    }
    let u = [direction[0] / len, direction[1] / len];
    let f = move |p: V2| {
        let d = sub(p, point);
        let along = dot(d, u);
        [
            point[0] + 2.0 * u[0] * along - d[0],
            point[1] + 2.0 * u[1] * along - d[1],
        ]
    };
    let mut out = loops.to_vec();
    let mut from: Vec<Vec<usize>> = (0..loops.len()).map(|i| vec![i]).collect();
    for (&i, (lp, s)) in pick.iter().zip(picked(loops, &sh, pick)?) {
        out.push(map_loop(lp, s, &f));
        from.push(vec![i]);
    }
    Ok(Edited {
        loops: out,
        from,
        removed: None,
    })
}

/// copies of the picked loops: along a step, or round a center through a total angle
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Spread {
    Line {
        count: usize,
        step: V2,
    },
    #[serde(rename_all = "camelCase")]
    Circle {
        count: usize,
        center: V2,
        angle_deg: f64,
    },
}

pub fn pattern(loops: &[Loop], pick: &[usize], spread: Spread) -> Result<Edited> {
    let sh = shapes(loops)?;
    let count = match spread {
        Spread::Line { count, .. } | Spread::Circle { count, .. } => count,
    };
    if count < 2 || count * pick.len() > MAX_COPIES {
        return Err(Error::invalid(
            "count",
            format!("give 2 or more, at most {MAX_COPIES} loops in all"),
        ));
    }
    let base = picked(loops, &sh, pick)?;
    let mut out = loops.to_vec();
    let mut from: Vec<Vec<usize>> = (0..loops.len()).map(|i| vec![i]).collect();
    for n in 1..count {
        #[allow(clippy::cast_precision_loss, reason = "counts are small")]
        let k = n as f64;
        let f: Box<dyn Fn(V2) -> V2> = match spread {
            Spread::Line { step, .. } => Box::new(move |p: V2| [p[0] + step[0] * k, p[1] + step[1] * k]),
            Spread::Circle {
                center,
                angle_deg,
                count,
            } => {
                // a full turn spreads the copies evenly without one landing on the first
                #[allow(clippy::cast_precision_loss, reason = "counts are small")]
                let each = if (angle_deg.abs() - 360.0).abs() < 1e-9 {
                    angle_deg / count as f64
                } else {
                    angle_deg / (count as f64 - 1.0)
                };
                let (s, c) = (each * k).to_radians().m_sin_cos();
                Box::new(move |p: V2| {
                    let d = sub(p, center);
                    [center[0] + d[0] * c - d[1] * s, center[1] + d[0] * s + d[1] * c]
                })
            }
        };
        for (&i, &(lp, s)) in pick.iter().zip(&base) {
            out.push(map_loop(lp, s, &f));
            from.push(vec![i]);
        }
    }
    Ok(Edited {
        loops: out,
        from,
        removed: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn loops(v: serde_json::Value) -> Vec<Loop> {
        serde_json::from_value(v).unwrap()
    }

    fn close(a: V2, b: V2) -> bool {
        dist(a, b) < 1e-6
    }

    #[test]
    fn lines_and_circles_meet() {
        let x = meet(
            Curve::Line {
                a: [0.0, 0.0],
                b: [10.0, 0.0],
            },
            Curve::Line {
                a: [5.0, -5.0],
                b: [5.0, 5.0],
            },
        );
        assert_eq!(x.len(), 1);
        assert!((x[0].0 - 0.5).abs() < 1e-12 && close(x[0].2, [5.0, 0.0]));
        let c = Curve::Arc {
            c: [0.0, 0.0],
            r: 5.0,
            a0: 0.0,
            sweep: TAU,
        };
        assert_eq!(
            meet(
                Curve::Line {
                    a: [-10.0, 0.0],
                    b: [10.0, 0.0]
                },
                c
            )
            .len(),
            2
        );
        // touching once
        assert_eq!(
            meet(
                Curve::Line {
                    a: [-10.0, 5.0],
                    b: [10.0, 5.0]
                },
                c
            )
            .len(),
            1
        );
        // half a circle meets the line only on its own side
        let half = Curve::Arc {
            c: [0.0, 0.0],
            r: 5.0,
            a0: 0.0,
            sweep: TAU / 2.0,
        };
        assert_eq!(
            meet(
                Curve::Line {
                    a: [-10.0, 3.0],
                    b: [10.0, 3.0]
                },
                half
            )
            .len(),
            2
        );
        assert_eq!(
            meet(
                Curve::Line {
                    a: [-10.0, -3.0],
                    b: [10.0, -3.0]
                },
                half
            )
            .len(),
            0
        );
        let d = Curve::Arc {
            c: [6.0, 0.0],
            r: 5.0,
            a0: 0.0,
            sweep: TAU,
        };
        assert_eq!(meet(c, d).len(), 2);
        // parallel lines never meet
        assert!(
            meet(
                Curve::Line {
                    a: [0.0, 0.0],
                    b: [1.0, 0.0]
                },
                Curve::Line {
                    a: [0.0, 1.0],
                    b: [1.0, 1.0]
                }
            )
            .is_empty()
        );
    }

    #[test]
    fn crossings_skip_a_chains_own_corners() {
        let sq = loops(
            json!([{ "points": [[0, 0], [10, 0], [10, 10], [0, 10]] }, { "start": [5, -5], "segments": [{ "type": "line", "to": [5, 15] }] }]),
        );
        let hits = intersections(&sq).unwrap();
        // the line crosses the bottom and the top, each hit on both curves
        assert_eq!(hits.len(), 4);
        assert!(
            hits.iter()
                .any(|h| h.loop_index == 1 && (h.t - 0.25).abs() < 1e-9)
        );
    }

    #[test]
    fn trims_the_piece_under_the_cursor() {
        // two squares overlapping: trim the first's right side inside the second
        let two = loops(json!([
            { "start": [0, 0], "segments": [{ "type": "line", "to": [10, 0] }, { "type": "line", "to": [10, 10] }, { "type": "line", "to": [0, 10] }, { "type": "line", "to": [0, 0] }] },
            { "start": [5, 5], "segments": [{ "type": "line", "to": [15, 5] }, { "type": "line", "to": [15, 15] }, { "type": "line", "to": [5, 15] }, { "type": "line", "to": [5, 5] }] }
        ]));
        let out = trim(&two, 0, 1, [10.0, 8.0]).unwrap();
        assert_eq!(out.from, vec![vec![0], vec![1]]);
        let sh = shapes(&out.loops).unwrap();
        let cut = &sh[0];
        assert!(!cut.closed);
        // the open chain runs from the top right corner round to the crossing at (10, 5)
        assert!(close(cut.curves[0].at(0.0), [10.0, 10.0]));
        assert!(close(cut.curves.last().unwrap().at(1.0), [10.0, 5.0]));
        let gone = shapes(&[out.removed.unwrap()]).unwrap()[0].curves[0];
        assert!(close(gone.at(0.0), [10.0, 5.0]) && close(gone.at(1.0), [10.0, 10.0]));
        // an open line with no crossing goes whole
        let lone = loops(json!([{ "start": [0, 0], "segments": [{ "type": "line", "to": [1, 0] }] }]));
        assert!(trim(&lone, 0, 0, [0.5, 0.0]).unwrap().loops.is_empty());
    }

    #[test]
    fn trimmed_crossing_squares_close_into_one_outline() {
        let sq = |x: f64, y: f64| json!({ "points": [[x, y], [x + 10.0, y], [x + 10.0, y + 10.0], [x, y + 10.0]] });
        let two = loops(json!([sq(0.0, 0.0), sq(5.0, 5.0)]));
        assert!(!sketch::check(&two).ok);
        // the first's corner inside the second, then the second's inside the first
        let a = trim(&two, 0, 1, [10.0, 8.0]).unwrap();
        // the open chain starts on the top now
        let a = trim(&a.loops, 0, 0, [8.0, 10.0]).unwrap();
        assert_eq!(a.loops.len(), 2);
        let b = trim(&a.loops, 1, 0, [8.0, 5.0]).unwrap();
        // the second's open chain met the first's ends: one loop from both
        assert_eq!(b.loops.len(), 1);
        assert_eq!(b.from, vec![vec![0, 1]]);
        // the last piece goes and the chain's ends meet
        let last = shapes(&b.loops).unwrap()[0].curves.len() - 1;
        let b = trim(&b.loops, 0, last, [5.0, 8.0]).unwrap();
        let c = sketch::check(&b.loops);
        assert!(c.ok, "{:?}", c.issues);
        // the union of the two squares
        assert!((c.area_mm2 - 175.0).abs() < 1e-6, "{}", c.area_mm2);
    }

    #[test]
    fn trims_a_circle_to_an_arc_or_takes_it_off() {
        let lc = loops(
            json!([{ "type": "circle", "center": [0, 0], "diameterMm": 10 }, { "start": [-10, 0], "segments": [{ "type": "line", "to": [10, 0] }] }]),
        );
        let out = trim(&lc, 0, 0, [0.0, 5.0]).unwrap();
        let sh = shapes(&out.loops).unwrap();
        // the lower half is left
        let arc = sh[0].curves[0];
        let gone = shapes(&[out.removed.unwrap()]).unwrap()[0].curves[0];
        assert!(close(gone.at(0.5), [0.0, 5.0]));
        assert!(close(arc.at(0.5), [0.0, -5.0]));
        assert!(close(arc.at(0.0), [-5.0, 0.0]) && close(arc.at(1.0), [5.0, 0.0]));
        let lone = loops(json!([{ "type": "circle", "center": [0, 0], "diameterMm": 10 }]));
        assert!(trim(&lone, 0, 0, [5.0, 0.0]).unwrap().loops.is_empty());
    }

    #[test]
    fn extends_a_line_and_an_arc_to_the_next_curve() {
        let l = loops(
            json!([{ "start": [0, 0], "segments": [{ "type": "line", "to": [4, 0] }] }, { "start": [10, -5], "segments": [{ "type": "line", "to": [10, 5] }] }]),
        );
        let out = extend(&l, 0, End::End).unwrap();
        assert_eq!(out.loops[0].segments[0].to, Some([10.0, 0.0]));
        let back = extend(&l, 0, End::Start);
        assert!(back.is_err());
        // a quarter arc runs on round its circle to the line
        let a = loops(
            json!([{ "start": [5, 0], "segments": [{ "type": "arc", "through": [3.535_533_905_932_737_8, 3.535_533_905_932_737_8], "to": [0, 5] }] }, { "start": [-10, -1], "segments": [{ "type": "line", "to": [10, -1] }] }]),
        );
        let out = extend(&a, 0, End::End).unwrap();
        let end = out.loops[0].segments[0].to.unwrap();
        assert!((end[1] + 1.0).abs() < 1e-9 && end[0] < 0.0);
        assert!(
            extend(
                &loops(json!([{ "points": [[0, 0], [1, 0], [0, 1]] }])),
                0,
                End::End
            )
            .is_err()
        );
    }

    #[test]
    fn mirrors_and_patterns() {
        let tri = loops(
            json!([{ "start": [1, 0], "segments": [{ "type": "line", "to": [3, 0] }, { "type": "line", "to": [1, 2] }, { "type": "line", "to": [1, 0] }] }]),
        );
        let m = mirror(&tri, &[0], [0.0, 0.0], [0.0, 1.0]).unwrap();
        assert_eq!(m.loops.len(), 2);
        assert_eq!(m.loops[1].start, Some([-1.0, 0.0]));
        assert!(sketch::check(&m.loops).ok);
        let p = pattern(
            &tri,
            &[0],
            Spread::Line {
                count: 3,
                step: [5.0, 0.0],
            },
        )
        .unwrap();
        assert_eq!(p.loops.len(), 3);
        assert_eq!(p.loops[2].start, Some([11.0, 0.0]));
        let c = pattern(
            &tri,
            &[0],
            Spread::Circle {
                count: 4,
                center: [0.0, 0.0],
                angle_deg: 360.0,
            },
        )
        .unwrap();
        assert!(close(c.loops[2].start.unwrap(), [-1.0, 0.0]));
        assert!(sketch::check(&c.loops).ok);
        assert!(
            pattern(
                &tri,
                &[0],
                Spread::Line {
                    count: 1,
                    step: [1.0, 0.0]
                }
            )
            .is_err()
        );
    }
}
