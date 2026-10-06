// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! free sketches
// ring and vertex indices are taken modulo their lengths or come from the
// rings built here
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::faces::{Faces, Surface};
use crate::fm::Fm;
use crate::measure::Topology;
use crate::mesh::TriMesh;
use crate::poly2d::{self, Polygon};
use crate::vec3::{self, Frame, V2, V3};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::f64::consts::{PI, TAU};

pub const CLOSE_MM: f64 = 0.001;
const ARC_TOL_MM: f64 = 0.005;
const MIN_LEN_MM: f64 = 1e-6;
const MAX_MM: f64 = 100_000.0;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Segment {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<V2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angle_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub center: Option<V2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sweep_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub through: Option<V2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius_mm: Option<f64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub clockwise: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub large: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Loop {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<V2>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub segments: Vec<Segment>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<V2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub center: Option<V2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diameter_mm: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueKind {
    Open,
    ZeroLength,
    SelfCrossing,
    LoopsCross,
    BadArc,
    TooSmall,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    #[serde(rename = "loop")]
    pub loop_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment: Option<usize>,
    pub kind: IssueKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<V2>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Outer,
    Hole,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopInfo {
    pub index: usize,
    pub role: Role,
    pub area_mm2: f64,
    pub length_mm: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchCheck {
    pub ok: bool,
    pub polygons: Vec<Polygon>,
    pub area_mm2: f64,
    pub loops: Vec<LoopInfo>,
    pub issues: Vec<Issue>,
}

struct Ring {
    pts: Vec<V2>,
    seg: Vec<usize>,
    prims: Vec<Prim>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Prim {
    Line { to: V2 },
    Arc { to: V2 },
}

impl Prim {
    pub(crate) fn to(self) -> V2 {
        match self {
            Self::Line { to } | Self::Arc { to } => to,
        }
    }
}

pub(crate) fn resolve(l: usize, lp: &Loop) -> std::result::Result<(V2, Vec<Prim>), Issue> {
    let r = flatten(l, lp)?;
    let start = r.pts.first().copied().unwrap_or([0.0, 0.0]);
    Ok((start, r.prims))
}

fn finite2(p: V2) -> bool {
    p.iter().all(|c| c.is_finite() && c.abs() <= MAX_MM)
}

fn sub2(a: V2, b: V2) -> V2 {
    [a[0] - b[0], a[1] - b[1]]
}

fn len2(a: V2) -> f64 {
    a[0].m_hypot(a[1])
}

fn dir_of(a: f64) -> V2 {
    let (s, c) = a.m_sin_cos();
    [c, s]
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "clamped")]
pub(crate) fn circle_steps(r: f64) -> usize {
    let half = (1.0 - (ARC_TOL_MM / r).min(1.0)).m_acos();
    if half.is_nan() || half <= 0.0 {
        return 256;
    }
    ((PI / half).ceil() as usize).clamp(24, 256).next_multiple_of(4)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "clamped")]
fn arc_points(c: V2, r: f64, a0: f64, sweep: f64, end: Option<V2>) -> Vec<V2> {
    let n = ((sweep.abs() / TAU * circle_steps(r) as f64).ceil() as usize).clamp(1, 1024);
    let mut out: Vec<V2> = (1..=n)
        .map(|i| {
            let d = dir_of(a0 + sweep * i as f64 / n as f64);
            [c[0] + r * d[0], c[1] + r * d[1]]
        })
        .collect();
    if let (Some(e), Some(last)) = (end, out.last_mut()) {
        *last = e;
    }
    out
}

fn issue(l: usize, seg: Option<usize>, kind: IssueKind, message: String, at: Option<V2>) -> Issue {
    Issue {
        loop_index: l,
        segment: seg,
        kind,
        message,
        at,
    }
}

fn bad_arc(l: usize, s: usize, why: &str, at: V2) -> Issue {
    issue(
        l,
        Some(s),
        IssueKind::BadArc,
        format!("Loop {}: segment {} {why}.", l + 1, s + 1),
        Some(at),
    )
}

fn arc_of(
    l: usize,
    s: usize,
    seg: &Segment,
    pos: V2,
    dir: V2,
) -> std::result::Result<(V2, f64, f64, Option<V2>), Issue> {
    let num = |v: Option<f64>| v.filter(|x| x.is_finite());
    let sweep_ok = |sw: f64| sw != 0.0 && sw.abs() <= 360.0;
    if let (Some(c), Some(sw)) = (seg.center, num(seg.sweep_deg)) {
        let r = len2(sub2(pos, c));
        if !finite2(c) || r < MIN_LEN_MM || !sweep_ok(sw) {
            return Err(bad_arc(
                l,
                s,
                "needs a center away from its start and a sweep between -360 and 360 degrees, not 0",
                pos,
            ));
        }
        let a0 = (pos[1] - c[1]).m_atan2(pos[0] - c[0]);
        return Ok((c, a0, sw.to_radians(), None));
    }
    if let (Some(to), Some(th)) = (seg.to, seg.through) {
        if !(finite2(to) && finite2(th)) {
            return Err(bad_arc(l, s, "has a point that is not a number", pos));
        }
        let (ax, ay) = (pos[0], pos[1]);
        let (bx, by) = (th[0], th[1]);
        let (cx, cy) = (to[0], to[1]);
        let d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        let scale = len2(sub2(th, pos)).max(len2(sub2(to, pos))).max(1e-9);
        if d.abs() < 1e-12 * scale * scale {
            return Err(bad_arc(l, s, "has its three points on one line", pos));
        }
        let a2 = ax * ax + ay * ay;
        let b2 = bx * bx + by * by;
        let c2 = cx * cx + cy * cy;
        let c = [
            (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d,
            (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d,
        ];
        let ccw = poly2d::orient(pos, th, to) > 0.0;
        let a0 = (pos[1] - c[1]).m_atan2(pos[0] - c[0]);
        let a1 = (to[1] - c[1]).m_atan2(to[0] - c[0]);
        return Ok((c, a0, sweep_between(a0, a1, ccw), Some(to)));
    }
    if let (Some(to), Some(r)) = (seg.to, num(seg.radius_mm)) {
        let chord = sub2(to, pos);
        let half = len2(chord) / 2.0;
        if !finite2(to) || half < MIN_LEN_MM || r <= 0.0 {
            return Err(bad_arc(
                l,
                s,
                "needs an end away from its start and a radius above 0",
                pos,
            ));
        }
        if r < half - 1e-9 {
            return Err(bad_arc(
                l,
                s,
                &format!("has a radius of {r:.3} mm, less than half the distance to its end ({half:.3} mm)"),
                pos,
            ));
        }
        let h = (r * r - half * half).max(0.0).sqrt();
        let left = [-chord[1] / (2.0 * half), chord[0] / (2.0 * half)];
        let ccw = !seg.clockwise;
        let side = if ccw == seg.large { -1.0 } else { 1.0 };
        let m = [f64::midpoint(pos[0], to[0]), f64::midpoint(pos[1], to[1])];
        let c = [m[0] + side * h * left[0], m[1] + side * h * left[1]];
        let a0 = (pos[1] - c[1]).m_atan2(pos[0] - c[0]);
        let a1 = (to[1] - c[1]).m_atan2(to[0] - c[0]);
        return Ok((c, a0, sweep_between(a0, a1, ccw), Some(to)));
    }
    if let (Some(r), Some(sw)) = (num(seg.radius_mm), num(seg.sweep_deg)) {
        if r <= 0.0 || r > MAX_MM || !sweep_ok(sw) {
            return Err(bad_arc(
                l,
                s,
                "needs a radius above 0 and a sweep between -360 and 360 degrees, not 0",
                pos,
            ));
        }
        let left = [-dir[1], dir[0]];
        let k = if sw > 0.0 { r } else { -r };
        let c = [pos[0] + k * left[0], pos[1] + k * left[1]];
        let a0 = (pos[1] - c[1]).m_atan2(pos[0] - c[0]);
        return Ok((c, a0, sw.to_radians(), None));
    }
    Err(bad_arc(
        l,
        s,
        "needs a center and sweepDeg, to and through, to and radiusMm, or radiusMm and sweepDeg",
        pos,
    ))
}

/// sweep from angle `a0` to `a1` going counterclockwise or clockwise, never 0
fn sweep_between(a0: f64, a1: f64, ccw: bool) -> f64 {
    let mut d = (a1 - a0).rem_euclid(TAU);
    if d < 1e-12 {
        d = TAU;
    }
    if ccw { d } else { d - TAU }
}

#[allow(clippy::too_many_lines, reason = "one arm per segment form")]
fn flatten(l: usize, lp: &Loop) -> std::result::Result<Ring, Issue> {
    let name = l + 1;
    if lp.kind.as_deref() == Some("circle") {
        let (Some(c), Some(d)) = (lp.center, lp.diameter_mm) else {
            return Err(issue(
                l,
                None,
                IssueKind::BadArc,
                format!("Loop {name}: a circle needs a center and diameterMm."),
                None,
            ));
        };
        if !(finite2(c) && d.is_finite() && d > 2.0 * MIN_LEN_MM && d <= MAX_MM) {
            return Err(issue(
                l,
                None,
                IssueKind::TooSmall,
                format!("Loop {name}: the circle needs a diameter above 0."),
                Some(c),
            ));
        }
        let pts = arc_points(c, d / 2.0, 0.0, TAU, None);
        let seg = vec![0; pts.len()];
        return Ok(Ring {
            pts,
            seg,
            prims: Vec::new(),
        });
    }
    if let Some(k) = lp.kind.as_deref().filter(|k| *k != "path" && *k != "points") {
        return Err(issue(
            l,
            None,
            IssueKind::TooSmall,
            format!("Loop {name}: unknown loop type \"{k}\"."),
            None,
        ));
    }
    if !lp.points.is_empty() {
        if let Some(i) = lp.points.iter().position(|p| !finite2(*p)) {
            return Err(issue(
                l,
                Some(i),
                IssueKind::ZeroLength,
                format!("Loop {name}: point {} is not a number.", i + 1),
                None,
            ));
        }
        let n = lp.points.len();
        for i in 0..n {
            if len2(sub2(lp.points[(i + 1) % n], lp.points[i])) < MIN_LEN_MM {
                return Err(issue(
                    l,
                    Some(i),
                    IssueKind::ZeroLength,
                    format!("Loop {name}: side {} has no length.", i + 1),
                    Some(lp.points[i]),
                ));
            }
        }
        return Ok(Ring {
            pts: lp.points.clone(),
            seg: (0..n).collect(),
            prims: (0..n)
                .map(|i| Prim::Line {
                    to: lp.points[(i + 1) % n],
                })
                .collect(),
        });
    }
    let Some(start) = lp.start.filter(|p| finite2(*p)) else {
        return Err(issue(
            l,
            None,
            IssueKind::Open,
            format!("Loop {name} needs a start point, points, or a circle."),
            None,
        ));
    };
    if lp.segments.is_empty() {
        return Err(issue(
            l,
            None,
            IssueKind::TooSmall,
            format!("Loop {name} has no segments."),
            Some(start),
        ));
    }
    let mut pts = vec![start];
    let mut seg = Vec::new();
    let mut prims = Vec::new();
    let (mut pos, mut dir) = (start, [1.0, 0.0]);
    for (s, sg) in lp.segments.iter().enumerate() {
        let num = |v: Option<f64>| v.filter(|x| x.is_finite());
        let new: Vec<V2> = match sg.kind.as_str() {
            "line" => {
                let to = if let Some(to) = sg.to {
                    if !finite2(to) {
                        return Err(issue(
                            l,
                            Some(s),
                            IssueKind::ZeroLength,
                            format!(
                                "Loop {name}: segment {} ends at a point that is not a number.",
                                s + 1
                            ),
                            Some(pos),
                        ));
                    }
                    to
                } else if let Some(len) = num(sg.length_mm) {
                    let a = if let Some(a) = num(sg.angle_deg) {
                        a.to_radians()
                    } else if let Some(t) = num(sg.turn_deg) {
                        dir[1].m_atan2(dir[0]) + t.to_radians()
                    } else {
                        return Err(issue(
                            l,
                            Some(s),
                            IssueKind::ZeroLength,
                            format!(
                                "Loop {name}: segment {} needs angleDeg or turnDeg with its length.",
                                s + 1
                            ),
                            Some(pos),
                        ));
                    };
                    if len.abs() > MAX_MM {
                        return Err(issue(
                            l,
                            Some(s),
                            IssueKind::ZeroLength,
                            format!("Loop {name}: segment {} is too long.", s + 1),
                            Some(pos),
                        ));
                    }
                    let d = dir_of(a);
                    [pos[0] + len * d[0], pos[1] + len * d[1]]
                } else {
                    return Err(issue(
                        l,
                        Some(s),
                        IssueKind::ZeroLength,
                        format!("Loop {name}: segment {} needs an end point or a length.", s + 1),
                        Some(pos),
                    ));
                };
                let v = sub2(to, pos);
                let len = len2(v);
                if len < MIN_LEN_MM {
                    return Err(issue(
                        l,
                        Some(s),
                        IssueKind::ZeroLength,
                        format!("Loop {name}: segment {} has no length.", s + 1),
                        Some(pos),
                    ));
                }
                dir = [v[0] / len, v[1] / len];
                prims.push(Prim::Line { to });
                vec![to]
            }
            "arc" => {
                let (c, a0, sweep, end) = arc_of(l, s, sg, pos, dir)?;
                let r = len2(sub2(pos, c));
                let pts = arc_points(c, r, a0, sweep, end);
                let a1 = a0 + sweep;
                let t = [-a1.m_sin(), a1.m_cos()];
                dir = if sweep > 0.0 { t } else { [-t[0], -t[1]] };
                prims.push(Prim::Arc {
                    to: pts.last().copied().unwrap_or(pos),
                });
                pts
            }
            other => {
                return Err(issue(
                    l,
                    Some(s),
                    IssueKind::BadArc,
                    format!(
                        "Loop {name}: segment {} has unknown type \"{other}\"; use line or arc.",
                        s + 1
                    ),
                    Some(pos),
                ));
            }
        };
        for p in new {
            pts.push(p);
            seg.push(s);
        }
        pos = *pts.last().unwrap_or(&pos);
    }
    let gap = len2(sub2(pos, start));
    if gap > CLOSE_MM {
        let last = lp.segments.len();
        return Err(issue(
            l,
            Some(last - 1),
            IssueKind::Open,
            format!("Loop {name} is open: segment {last} ends {gap:.3} mm from the start."),
            Some(pos),
        ));
    }
    pts.pop();
    Ok(Ring { pts, seg, prims })
}

fn edge(r: &[V2], i: usize) -> (V2, V2) {
    (r[i], r[(i + 1) % r.len()])
}

fn meet(a: V2, b: V2, c: V2, d: V2, eps: f64) -> bool {
    let lo = |p: f64, q: f64| p.min(q);
    let hi = |p: f64, q: f64| p.max(q);
    if hi(a[0], b[0]) + eps < lo(c[0], d[0])
        || hi(c[0], d[0]) + eps < lo(a[0], b[0])
        || hi(a[1], b[1]) + eps < lo(c[1], d[1])
        || hi(c[1], d[1]) + eps < lo(a[1], b[1])
    {
        return false;
    }
    let side = |p: V2, q: V2, r: V2| {
        let o = poly2d::orient(p, q, r);
        let l = len2(sub2(q, p)).max(1e-12);
        let dist = o / l;
        if dist > eps {
            1
        } else if dist < -eps {
            -1
        } else {
            0
        }
    };
    let (d1, d2) = (side(a, b, c), side(a, b, d));
    let (d3, d4) = (side(c, d, a), side(c, d, b));
    if d1 * d2 < 0 && d3 * d4 < 0 {
        return true;
    }
    let on = |p: V2, q: V2, r: V2| {
        r[0] >= p[0].min(q[0]) - eps
            && r[0] <= p[0].max(q[0]) + eps
            && r[1] >= p[1].min(q[1]) - eps
            && r[1] <= p[1].max(q[1]) + eps
    };
    (d1 == 0 && on(a, b, c))
        || (d2 == 0 && on(a, b, d))
        || (d3 == 0 && on(c, d, a))
        || (d4 == 0 && on(c, d, b))
}

fn crossings(rings: &[&[V2]], eps: f64) -> Vec<(usize, usize, usize, usize)> {
    let mut edges: Vec<(f64, f64, usize, usize)> = Vec::new();
    for (ri, r) in rings.iter().enumerate() {
        for i in 0..r.len() {
            let (a, b) = edge(r, i);
            edges.push((a[0].min(b[0]), a[0].max(b[0]), ri, i));
        }
    }
    edges.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut out = Vec::new();
    let mut active: Vec<usize> = Vec::new();
    for k in 0..edges.len() {
        let (lo, _, ri, i) = edges[k];
        active.retain(|&j| edges[j].1 + eps >= lo);
        for &j in &active {
            let (_, _, rj, jj) = edges[j];
            let n = rings[ri].len();
            let (a, b) = edge(rings[ri], i);
            let (c, d) = edge(rings[rj], jj);
            if ri == rj {
                let next = (i + 1) % n == jj || (jj + 1) % n == i;
                if next {
                    let (p, q, s) = if (i + 1) % n == jj { (a, b, d) } else { (c, d, b) };
                    let u = sub2(q, p);
                    let w = sub2(s, q);
                    let cross = u[0] * w[1] - u[1] * w[0];
                    let dot = u[0] * w[0] + u[1] * w[1];
                    if cross.abs() <= eps * len2(u).max(len2(w)) && dot < 0.0 {
                        out.push((ri, i.min(jj), rj, i.max(jj)));
                    }
                    continue;
                }
            }
            if meet(a, b, c, d, eps) {
                out.push((
                    ri.min(rj),
                    if ri <= rj { i } else { jj },
                    ri.max(rj),
                    if ri <= rj { jj } else { i },
                ));
            }
        }
        active.push(k);
    }
    out.sort_unstable();
    out
}

pub fn check(loops: &[Loop]) -> SketchCheck {
    let mut issues = Vec::new();
    let mut rings: Vec<(usize, Ring)> = Vec::new();
    for (l, lp) in loops.iter().enumerate() {
        match flatten(l, lp) {
            Ok(r) if r.pts.len() < 3 => issues.push(issue(
                l,
                None,
                IssueKind::TooSmall,
                format!("Loop {} encloses no area.", l + 1),
                r.pts.first().copied(),
            )),
            Ok(r) => rings.push((l, r)),
            Err(e) => issues.push(e),
        }
    }
    if loops.is_empty() {
        issues.push(issue(
            0,
            None,
            IssueKind::TooSmall,
            "The sketch has no loops.".to_owned(),
            None,
        ));
    }
    let size = rings
        .iter()
        .flat_map(|(_, r)| r.pts.iter())
        .fold(0.0f64, |m, p| m.max(p[0].abs()).max(p[1].abs()));
    let eps = (size * 1e-9).max(1e-9);
    let refs: Vec<&[V2]> = rings.iter().map(|(_, r)| r.pts.as_slice()).collect();
    let mut bad = vec![false; rings.len()];
    let mut seen: Vec<(usize, usize, usize, usize)> = Vec::new();
    for (ri, i, rj, j) in crossings(&refs, eps) {
        let (la, ra) = (&rings[ri].0, &rings[ri].1);
        let (lb, rb) = (&rings[rj].0, &rings[rj].1);
        let (sa, sb) = (ra.seg[i], rb.seg[j]);
        let key = (*la, sa, *lb, sb);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        bad[ri] = true;
        bad[rj] = true;
        let at = Some(ra.pts[i]);
        if ri == rj {
            let (x, y) = (sa.min(sb) + 1, sa.max(sb) + 1);
            let message = if x == y {
                format!("Loop {}: segment {x} crosses itself.", la + 1)
            } else {
                format!("Loop {}: segment {y} crosses segment {x}.", la + 1)
            };
            issues.push(issue(*la, Some(sa.max(sb)), IssueKind::SelfCrossing, message, at));
        } else {
            issues.push(issue(
                *lb,
                Some(sb),
                IssueKind::LoopsCross,
                format!(
                    "Loop {} crosses loop {} (segment {} of loop {} meets segment {} of loop {}).",
                    lb + 1,
                    la + 1,
                    sb + 1,
                    lb + 1,
                    sa + 1,
                    la + 1
                ),
                at,
            ));
        }
    }
    for (i, (l, r)) in rings.iter().enumerate() {
        if !bad[i] && poly2d::signed_area(&r.pts).abs() < 1e-9 {
            bad[i] = true;
            issues.push(issue(
                *l,
                None,
                IssueKind::TooSmall,
                format!("Loop {} encloses no area.", l + 1),
                r.pts.first().copied(),
            ));
        }
    }
    issues.sort_by_key(|i| (i.loop_index, i.segment));
    let good: Vec<usize> = (0..rings.len()).filter(|&i| !bad[i]).collect();
    let infos = loop_infos(&rings, &good);
    let polygons = if issues.is_empty() {
        poly2d::nest(good.iter().map(|&i| rings[i].1.pts.clone()).collect())
    } else {
        Vec::new()
    };
    SketchCheck {
        ok: issues.is_empty(),
        area_mm2: polygons.iter().map(Polygon::area).sum(),
        polygons,
        loops: infos,
        issues,
    }
}

fn loop_infos(rings: &[(usize, Ring)], good: &[usize]) -> Vec<LoopInfo> {
    let probes: Vec<V2> = good
        .iter()
        .map(|&i| poly2d::interior_point(&rings[i].1.pts))
        .collect();
    good.iter()
        .zip(&probes)
        .map(|(&i, &probe)| {
            let depth = good
                .iter()
                .filter(|&&j| j != i && poly2d::point_in_ring(probe, &rings[j].1.pts))
                .count();
            let r = &rings[i].1.pts;
            LoopInfo {
                index: rings[i].0,
                role: if depth % 2 == 0 { Role::Outer } else { Role::Hole },
                area_mm2: poly2d::signed_area(r).abs(),
                length_mm: poly2d::ring_length(r),
            }
        })
        .collect()
}

pub fn polygons(loops: &[Loop]) -> Result<Vec<Polygon>> {
    let c = check(loops);
    match c.issues.into_iter().next() {
        Some(i) => Err(Error::invalid("sketch", i.message)),
        None => Ok(c.polygons),
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Join {
    #[default]
    Round,
    Miter,
}

pub fn offset(polys: &[Polygon], distance_mm: f64, join: Join) -> Result<Vec<Polygon>> {
    use i_overlay::mesh::float::outline::offset::OutlineOffset;
    use i_overlay::mesh::float::style::{LineJoin, OutlineStyle};
    if !(distance_mm.is_finite() && distance_mm.abs() <= 10_000.0) {
        return Err(Error::invalid("distanceMm", "between -10000 and 10000 mm"));
    }
    if polys.is_empty() {
        return Err(Error::invalid("polygons", "nothing to offset"));
    }
    if distance_mm == 0.0 {
        return Ok(polys.to_vec());
    }
    let shapes: Vec<Vec<Vec<V2>>> = polys
        .iter()
        .map(|p| {
            let mut p = p.clone();
            p.normalize_orientation();
            std::iter::once(p.outer).chain(p.holes).collect()
        })
        .collect();
    let step = (2.0 * (1.0 - (ARC_TOL_MM / distance_mm.abs()).min(1.0)).m_acos()).max(0.01);
    let style = OutlineStyle::new(distance_mm).line_join(match join {
        Join::Round => LineJoin::Round(step),
        Join::Miter => LineJoin::Miter(PI / 36.0),
    });
    let out: Vec<Polygon> = shapes
        .outline(&style)
        .into_iter()
        .filter_map(|mut rings| {
            if rings.is_empty() {
                return None;
            }
            let outer = rings.remove(0);
            let mut p = Polygon { outer, holes: rings };
            p.normalize_orientation();
            (p.outer.len() >= 3 && p.area() > 1e-9).then_some(p)
        })
        .collect();
    if out.is_empty() {
        return Err(Error::invalid("distanceMm", "the offset leaves nothing"));
    }
    Ok(out)
}

pub fn inset_keeping_vertices(polys: &[Polygon], d: f64) -> Option<Vec<Polygon>> {
    if d == 0.0 {
        return Some(polys.to_vec());
    }
    let ring = |r: &[V2]| -> Option<Vec<V2>> {
        let n = r.len();
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let (p, a, b) = (r[(i + n - 1) % n], r[i], r[(i + 1) % n]);
            let (e0, e1) = (sub2(a, p), sub2(b, a));
            let (l0, l1) = (len2(e0), len2(e1));
            if l0 < 1e-12 || l1 < 1e-12 {
                return None;
            }
            let n0 = [-e0[1] / l0, e0[0] / l0];
            let n1 = [-e1[1] / l1, e1[0] / l1];
            let k = 1.0 + n0[0] * n1[0] + n0[1] * n1[1];
            if k < 1e-6 {
                return None;
            }
            out.push([a[0] + (n0[0] + n1[0]) * d / k, a[1] + (n0[1] + n1[1]) * d / k]);
        }
        for i in 0..n {
            let (o, q) = (sub2(r[(i + 1) % n], r[i]), sub2(out[(i + 1) % n], out[i]));
            if o[0] * q[0] + o[1] * q[1] <= 0.0 {
                return None;
            }
        }
        Some(out)
    };
    let res = polys
        .iter()
        .map(|p| {
            Some(Polygon {
                outer: ring(&p.outer)?,
                holes: p.holes.iter().map(|h| ring(h)).collect::<Option<_>>()?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let all: Vec<&[V2]> = res
        .iter()
        .flat_map(|p| std::iter::once(p.outer.as_slice()).chain(p.holes.iter().map(Vec::as_slice)))
        .collect();
    let size = all
        .iter()
        .flat_map(|r| r.iter())
        .fold(0.0f64, |m, p| m.max(p[0].abs()).max(p[1].abs()));
    crossings(&all, (size * 1e-9).max(1e-9)).is_empty().then_some(res)
}

pub fn revolve(
    frame: &Frame,
    polys: &[Polygon],
    point: V2,
    direction: V2,
    angle_deg: f64,
) -> Result<TriMesh> {
    revolve_steps(frame, polys, point, direction, angle_deg, None)
}

/// `revolve` in `steps` equal steps when given (a rim's tool takes the rim's own count), else as many as the
/// size needs. The turn starts in the frame's `u` direction from the axis.
#[allow(clippy::too_many_lines, reason = "sides, axis points and caps in one pass")]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "clamped step counts"
)]
pub(crate) fn revolve_steps(
    frame: &Frame,
    polys: &[Polygon],
    point: V2,
    direction: V2,
    angle_deg: f64,
    steps: Option<usize>,
) -> Result<TriMesh> {
    let dl = len2(direction);
    if !(finite2(point) && dl.is_finite() && dl > 1e-12) {
        return Err(Error::invalid("axis", "direction must not be zero"));
    }
    if !(angle_deg.is_finite() && angle_deg > 0.0 && angle_deg <= 360.0) {
        return Err(Error::invalid("angleDeg", "between 0 and 360 degrees, not 0"));
    }
    if polys.is_empty() {
        return Err(Error::invalid("sketch", "nothing to revolve"));
    }
    let d = [direction[0] / dl, direction[1] / dl];
    let perp = [-d[1], d[0]];
    let size = polys
        .iter()
        .flat_map(Polygon::vertices)
        .fold(0.0f64, |m, p| m.max(len2(sub2(p, point))));
    let on_axis = (size * 1e-9).max(1e-9);
    let mut side = 0.0f64;
    for p in polys.iter().flat_map(Polygon::vertices) {
        let q = sub2(p, point);
        let r = q[0] * perp[0] + q[1] * perp[1];
        if r.abs() <= on_axis {
            continue;
        }
        if side == 0.0 {
            side = r.signum();
        } else if (r > 0.0) != (side > 0.0) {
            return Err(Error::invalid("axis", "the profile crosses the axis"));
        }
    }
    if side == 0.0 {
        return Err(Error::invalid("axis", "the profile lies on the axis"));
    }
    let to_tr = |p: V2| -> V2 {
        let q = sub2(p, point);
        let r = side * (q[0] * perp[0] + q[1] * perp[1]);
        [
            q[0] * d[0] + q[1] * d[1],
            if r.abs() <= on_axis { 0.0 } else { r },
        ]
    };
    let a3 = vec3::add(vec3::scale(frame.u, d[0]), vec3::scale(frame.v, d[1]));
    let r0 = vec3::scale(
        vec3::add(vec3::scale(frame.u, perp[0]), vec3::scale(frame.v, perp[1])),
        side,
    );
    let t3 = vec3::cross(a3, r0);
    let o = frame.at(point, 0.0);
    let full = angle_deg >= 360.0;
    let sweep = angle_deg.to_radians();
    let steps = steps.map_or_else(
        || ((sweep / TAU * circle_steps(size) as f64).ceil() as usize).clamp(if full { 8 } else { 1 }, 1024),
        |n| n.clamp(3, 4096),
    );
    let rows = if full { steps } else { steps + 1 };
    let mut mesh = TriMesh::default();
    let mut faces = Faces::default();
    let tol = on_axis * 10.0;
    let at3 = |t: f64| vec3::add(o, vec3::scale(a3, t));
    for poly in polys {
        let mut p = Polygon {
            outer: poly.outer.iter().map(|&q| to_tr(q)).collect(),
            holes: poly
                .holes
                .iter()
                .map(|h| h.iter().map(|&q| to_tr(q)).collect())
                .collect(),
        };
        p.normalize_orientation();
        let pts: Vec<V2> = p.vertices().collect();
        let mut ids = vec![0u32; pts.len() * rows];
        for (i, q) in pts.iter().enumerate() {
            for k in 0..rows {
                if q[1] == 0.0 && k > 0 {
                    ids[i * rows + k] = ids[i * rows];
                    continue;
                }
                let (s, c) = (sweep * k as f64 / steps as f64).m_sin_cos();
                let radial = vec3::add(vec3::scale(r0, c), vec3::scale(t3, s));
                ids[i * rows + k] = mesh.push_vertex(vec3::add(
                    o,
                    vec3::add(vec3::scale(a3, q[0]), vec3::scale(radial, q[1])),
                ));
            }
        }
        let id = |i: usize, k: usize| ids[i * rows + k % rows];
        let mut start = 0;
        for ring in std::iter::once(&p.outer).chain(&p.holes) {
            let n = ring.len();
            // In the (along, radius) half plane each side sweeps a face: a run of sides along an arc centered on
            // the axis a sphere, other arcs a torus (no known surface), a side along the axis a cylinder, a side
            // across it a flat ring, any other side a cone. The outward side of each is on its right.
            let side_ids = crate::build::ring_faces(
                ring,
                &mut faces,
                |(c, r)| {
                    if c[1].abs() <= tol {
                        Surface::Sphere {
                            center: at3(c[0]),
                            radius: r,
                        }
                    } else {
                        Surface::Other
                    }
                },
                |a, b| {
                    if (a[1] - b[1]).abs() <= tol {
                        Surface::Cylinder {
                            origin: o,
                            axis: a3,
                            radius: a[1],
                        }
                    } else if (a[0] - b[0]).abs() <= tol {
                        let normal = vec3::scale(a3, (b[1] - a[1]).signum());
                        Surface::Plane {
                            normal,
                            offset: vec3::dot(normal, at3(a[0])),
                        }
                    } else {
                        let apex = a[0] - a[1] * (b[0] - a[0]) / (b[1] - a[1]);
                        let mid = f64::midpoint(a[0], b[0]);
                        Surface::Cone {
                            apex: at3(apex),
                            axis: vec3::scale(a3, (mid - apex).signum()),
                            half_angle: ((b[1] - a[1]).abs() / (b[0] - a[0]).abs()).m_atan(),
                        }
                    }
                },
            );
            for (e, &face) in side_ids.iter().enumerate().take(n) {
                let (i, j) = (start + e, start + (e + 1) % n);
                let (ai, bj) = (pts[i][1] == 0.0, pts[j][1] == 0.0);
                if ai && bj {
                    continue;
                }
                for k in 0..steps {
                    let (a0, a1, b0, b1) = (id(i, k), id(i, k + 1), id(j, k), id(j, k + 1));
                    if !bj {
                        mesh.triangles.push([a0, b0, b1]);
                        faces.ids.push(face);
                    }
                    if !ai {
                        mesh.triangles.push([a0, b1, a1]);
                        faces.ids.push(face);
                    }
                }
            }
            start += n;
        }
        if !full {
            // The two ends of a partial turn are flat, facing back along the turn and on along it.
            let (s, c) = sweep.m_sin_cos();
            let back = vec3::scale(t3, -1.0);
            let on = vec3::add(vec3::scale(r0, -s), vec3::scale(t3, c));
            let first = faces.push(Surface::Plane {
                normal: back,
                offset: vec3::dot(back, o),
            });
            let last = faces.push(Surface::Plane {
                normal: on,
                offset: vec3::dot(on, o),
            });
            let tris = poly2d::triangulate(&p)?;
            for t in tris {
                mesh.triangles
                    .push([id(t[0] as usize, 0), id(t[2] as usize, 0), id(t[1] as usize, 0)]);
                mesh.triangles.push([
                    id(t[0] as usize, steps),
                    id(t[1] as usize, steps),
                    id(t[2] as usize, steps),
                ]);
                faces.ids.extend([first, last]);
            }
        }
    }
    mesh.faces = Some(crate::faces::merge_meeting_planes(&mesh, faces));
    Ok(mesh)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapPoint {
    pub at: V2,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius_mm: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SnapEdge {
    pub a: V2,
    pub b: V2,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Snaps {
    pub points: Vec<SnapPoint>,
    pub edges: Vec<SnapEdge>,
}

impl Snaps {
    fn point(&mut self, at: V2, kind: &'static str, radius_mm: Option<f64>) {
        let near = |p: &SnapPoint| p.kind == kind && len2(sub2(p.at, at)) < 1e-6;
        if !self.points.iter().any(near) {
            self.points.push(SnapPoint { at, kind, radius_mm });
        }
    }
}

fn circle3(a: V2, b: V2, c: V2) -> Option<(V2, f64)> {
    let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if d.abs() < 1e-12 {
        return None;
    }
    let (a2, b2, c2) = (
        a[0] * a[0] + a[1] * a[1],
        b[0] * b[0] + b[1] * b[1],
        c[0] * c[0] + c[1] * c[1],
    );
    let o = [
        (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
        (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
    ];
    Some((o, len2(sub2(a, o))))
}

fn ring_snaps(ring: &[V2], out: &mut Snaps) {
    let n0 = ring.len();
    let pts: Vec<V2> = (0..n0)
        .filter(|&i| {
            let (p, a, b) = (ring[(i + n0 - 1) % n0], ring[i], ring[(i + 1) % n0]);
            let (u, w) = (sub2(a, p), sub2(b, a));
            let cross = u[0] * w[1] - u[1] * w[0];
            let m = len2(u).max(len2(w)).max(1e-12);
            cross.abs() > 1e-9 * m * m || u[0] * w[0] + u[1] * w[1] < 0.0
        })
        .map(|i| ring[i])
        .collect();
    let n = pts.len();
    if n < 3 {
        return;
    }
    let turn = |i: usize| {
        let (p, a, b) = (pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]);
        let (u, w) = (sub2(a, p), sub2(b, a));
        (u[0] * w[1] - u[1] * w[0]).m_atan2(u[0] * w[0] + u[1] * w[1])
    };
    let turns: Vec<f64> = (0..n).map(turn).collect();
    let alike = |i: usize, j: usize| {
        let (x, y) = (turns[i % n], turns[j % n]);
        x.abs() > 1e-4 && x.abs() < PI / 6.0 && x * y > 0.0 && (x - y).abs() <= 0.25 * x.abs().max(y.abs())
    };
    let mut in_arc = vec![false; n];
    let first = (0..n).find(|&i| !alike(i + n - 1, i)).unwrap_or(0);
    let mut i = 0;
    while i < n {
        let s = (first + i) % n;
        let mut len = 1;
        while len < n && alike(s, s + len) {
            len += 1;
        }
        if len >= 3 {
            let a = pts[(s + n - 1) % n];
            let m = pts[(s + len / 2) % n];
            let b = pts[(s + len) % n];
            if let Some((c, r)) = circle3(a, m, b) {
                let fits = (0..=len + 1)
                    .all(|k| (len2(sub2(pts[(s + n - 1 + k) % n], c)) - r).abs() <= (r * 1e-3).max(0.002));
                if fits {
                    out.point(c, "center", Some(r));
                    for k in 0..len {
                        in_arc[(s + k) % n] = true;
                    }
                }
            }
        }
        i += len;
    }
    for k in 0..n {
        let (a, b) = (pts[k], pts[(k + 1) % n]);
        if !in_arc[k] {
            out.point(a, "vertex", None);
        }
        if !(in_arc[k] && in_arc[(k + 1) % n]) {
            out.point(
                [f64::midpoint(a[0], b[0]), f64::midpoint(a[1], b[1])],
                "midpoint",
                None,
            );
        }
        out.edges.push(SnapEdge { a, b });
    }
}

pub fn snaps(frame: &Frame, outline: &[Polygon], meshes: &[TriMesh], near_mm: f64) -> Snaps {
    let mut out = Snaps::default();
    for p in outline {
        for r in std::iter::once(&p.outer).chain(&p.holes) {
            ring_snaps(r, &mut out);
        }
    }
    let near = if near_mm.is_finite() && near_mm >= 0.0 {
        near_mm
    } else {
        0.01
    };
    for m in meshes {
        if m.validate("meshes").is_err() {
            continue;
        }
        let topo = Topology::new(m);
        let key = |p: V3| p.map(|c| (c + 0.0).to_bits());
        let mut seen = HashSet::new();
        for t in 0..m.triangles.len() {
            #[allow(clippy::cast_possible_truncation, reason = "triangle counts fit u32")]
            let c = topo.corners(t as u32);
            for j in 0..3 {
                let (a, b) = (c[j], c[(j + 1) % 3]);
                if frame.height(a).abs() > near || frame.height(b).abs() > near {
                    continue;
                }
                let k = if key(a) <= key(b) {
                    (key(a), key(b))
                } else {
                    (key(b), key(a))
                };
                if !seen.insert(k) || !topo.is_sharp(a, b) {
                    continue;
                }
                let (a, b) = (frame.project(a), frame.project(b));
                out.point(a, "vertex", None);
                out.point(b, "vertex", None);
                out.point(
                    [f64::midpoint(a[0], b[0]), f64::midpoint(a[1], b[1])],
                    "midpoint",
                    None,
                );
                out.edges.push(SnapEdge { a, b });
            }
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::float_cmp, reason = "typed values come back exactly")]
mod tests {
    use super::*;
    use serde_json::json;

    fn loops(v: serde_json::Value) -> Vec<Loop> {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn rectangle_with_round_hole_by_lengths_and_angles() {
        let l = loops(json!([
            { "start": [0, 0], "segments": [
                { "type": "line", "lengthMm": 40, "angleDeg": 0 },
                { "type": "line", "lengthMm": 20, "turnDeg": 90 },
                { "type": "line", "lengthMm": 40, "turnDeg": 90 },
                { "type": "line", "to": [0, 0] },
            ]},
            { "type": "circle", "center": [20, 10], "diameterMm": 8 },
        ]));
        let c = check(&l);
        assert!(c.ok, "{:?}", c.issues);
        assert_eq!(c.polygons.len(), 1);
        assert_eq!(c.polygons[0].holes.len(), 1);
        let hole = PI * 16.0;
        assert!((c.area_mm2 - (800.0 - hole)).abs() < 0.15, "{}", c.area_mm2);
        assert_eq!(c.loops[1].role, Role::Hole);
        assert!((c.loops[0].length_mm - 120.0).abs() < 1e-9);
    }

    #[test]
    fn arcs_in_every_form() {
        let l = loops(json!([
            { "start": [0, 0], "segments": [
                { "type": "line", "to": [20, 0] },
                { "type": "arc", "radiusMm": 5, "sweepDeg": 180 },
                { "type": "line", "to": [0, 10] },
                { "type": "arc", "center": [0, 5], "sweepDeg": 180 },
            ]},
            { "start": [40, 0], "segments": [
                { "type": "arc", "to": [40, 10], "through": [45, 5] },
                { "type": "line", "to": [40, 0] },
            ]},
            { "start": [60, 0], "segments": [
                { "type": "arc", "to": [60, 10], "radiusMm": 5 },
                { "type": "line", "to": [60, 0] },
            ]},
        ]));
        let c = check(&l);
        assert!(c.ok, "{:?}", c.issues);
        let stadium = 200.0 + PI * 25.0;
        let half = PI * 25.0 / 2.0;
        assert!(
            (c.loops[0].area_mm2 - stadium).abs() < 0.15,
            "{}",
            c.loops[0].area_mm2
        );
        assert!(
            (c.loops[1].area_mm2 - half).abs() < 0.1,
            "{}",
            c.loops[1].area_mm2
        );
        assert!(
            (c.loops[2].area_mm2 - half).abs() < 0.1,
            "{}",
            c.loops[2].area_mm2
        );
        let big = loops(json!([{ "start": [0, 0], "segments": [
            { "type": "arc", "to": [0, 6], "radiusMm": 5, "large": true },
            { "type": "line", "to": [0, 0] },
        ]}]));
        let c = check(&big);
        assert!(c.ok && c.loops[0].area_mm2 > PI * 25.0 / 2.0, "{c:?}");
    }

    #[test]
    fn problems_name_the_segment() {
        let open = loops(json!([{ "start": [0, 0], "segments": [
            { "type": "line", "to": [10, 0] }, { "type": "line", "to": [10, 10] },
        ]}]));
        let c = check(&open);
        assert!(!c.ok);
        assert_eq!(c.issues[0].kind, IssueKind::Open);
        assert_eq!(c.issues[0].segment, Some(1));
        assert!(
            c.issues[0].message.contains("segment 2 ends 14.142 mm"),
            "{}",
            c.issues[0].message
        );
        let bow = loops(json!([{ "points": [[0, 0], [10, 10], [10, 0], [0, 10]] }]));
        let c = check(&bow);
        assert_eq!(c.issues[0].kind, IssueKind::SelfCrossing);
        assert!(
            c.issues[0].message.contains("segment 3 crosses segment 1"),
            "{:?}",
            c.issues
        );
        let cross = loops(json!([
            { "points": [[0, 0], [10, 0], [10, 10], [0, 10]] },
            { "type": "circle", "center": [10, 5], "diameterMm": 4 },
        ]));
        let c = check(&cross);
        assert_eq!(c.issues[0].kind, IssueKind::LoopsCross, "{:?}", c.issues);
        assert!(
            polygons(&cross)
                .unwrap_err()
                .to_string()
                .starts_with("sketch: Loop 2 crosses loop 1")
        );
        let zero = loops(json!([{ "start": [0, 0], "segments": [
            { "type": "line", "to": [0, 0] },
        ]}]));
        assert_eq!(check(&zero).issues[0].kind, IssueKind::ZeroLength);
        let line = loops(json!([{ "start": [0, 0], "segments": [
            { "type": "arc", "to": [4, 0], "through": [2, 0] }, { "type": "line", "to": [0, 0] },
        ]}]));
        assert_eq!(check(&line).issues[0].kind, IssueKind::BadArc);
        let small_r = loops(json!([{ "start": [0, 0], "segments": [
            { "type": "arc", "to": [10, 0], "radiusMm": 2 }, { "type": "line", "to": [0, 0] },
        ]}]));
        assert!(check(&small_r).issues[0].message.contains("less than half"));
        let touch = loops(json!([
            { "points": [[0, 0], [10, 0], [10, 10], [0, 10]] },
            { "points": [[10, 10], [20, 10], [20, 20], [10, 20]] },
        ]));
        assert!(!check(&touch).ok);
        let back = loops(json!([{ "points": [[0, 0], [10, 0], [5, 0], [5, 5]] }]));
        assert!(!check(&back).ok);
        assert!(!check(&[]).ok);
    }

    #[test]
    fn islands_and_offsets() {
        let l = loops(json!([
            { "points": [[0, 0], [30, 0], [30, 30], [0, 30]] },
            { "points": [[5, 5], [25, 5], [25, 25], [5, 25]] },
            { "points": [[10, 10], [20, 10], [20, 20], [10, 20]] },
        ]));
        let c = check(&l);
        assert!(c.ok);
        assert_eq!(c.polygons.len(), 2);
        assert!((c.area_mm2 - (900.0 - 400.0 + 100.0)).abs() < 1e-9);
        let sq = vec![Polygon::simple(poly2d::rect([0.0, 0.0], [10.0, 10.0]))];
        let grown = offset(&sq, 1.0, Join::Miter).unwrap();
        assert!((grown.iter().map(Polygon::area).sum::<f64>() - 144.0).abs() < 1e-3);
        let round = offset(&sq, 1.0, Join::Round).unwrap();
        let a = round.iter().map(Polygon::area).sum::<f64>();
        assert!((a - (100.0 + 40.0 + PI)).abs() < 0.05, "{a}");
        let shrunk = offset(&sq, -2.0, Join::Miter).unwrap();
        assert!((shrunk.iter().map(Polygon::area).sum::<f64>() - 36.0).abs() < 1e-3);
        assert!(offset(&sq, -6.0, Join::Round).is_err());
        assert!(offset(&sq, f64::NAN, Join::Round).is_err());
        let inset = inset_keeping_vertices(&sq, 1.0).unwrap();
        assert!((inset[0].area() - 64.0).abs() < 1e-9);
        assert!(inset_keeping_vertices(&sq, 6.0).is_none());
    }

    fn surfaces(m: &TriMesh) -> Vec<&'static str> {
        use crate::faces::Surface;
        crate::faces::check::faces_agree(m);
        let mut k: Vec<&'static str> = m
            .faces
            .as_ref()
            .unwrap()
            .table
            .iter()
            .map(|s| match s {
                Surface::Plane { .. } => "plane",
                Surface::Cylinder { .. } => "cylinder",
                Surface::Cone { .. } => "cone",
                Surface::Sphere { .. } => "sphere",
                Surface::Other => "other",
            })
            .collect();
        k.sort_unstable();
        k
    }

    #[test]
    fn a_revolved_profile_knows_its_round_faces() {
        let washer = vec![Polygon::simple(poly2d::rect([5.0, 0.0], [15.0, 4.0]))];
        let m = revolve(&Frame::WORLD, &washer, [0.0, 0.0], [0.0, 1.0], 360.0).unwrap();
        assert_eq!(surfaces(&m), ["cylinder", "cylinder", "plane", "plane"]);
        let tri = vec![Polygon::simple(vec![[0.0, 0.0], [5.0, 0.0], [0.0, 10.0]])];
        let cone = revolve(&Frame::WORLD, &tri, [0.0, 0.0], [0.0, 1.0], 360.0).unwrap();
        assert_eq!(surfaces(&cone), ["cone", "plane"]);
        // Half a cone: its flat side is one face across the axis.
        let half = revolve(&Frame::WORLD, &tri, [0.0, 0.0], [0.0, 1.0], 180.0).unwrap();
        assert_eq!(surfaces(&half), ["cone", "plane", "plane"]);
        let quarter = revolve(&Frame::WORLD, &washer, [0.0, 0.0], [0.0, 1.0], 90.0).unwrap();
        assert_eq!(
            surfaces(&quarter),
            ["cylinder", "cylinder", "plane", "plane", "plane", "plane"]
        );
        let mut half_disc: Vec<V2> = (0..=32)
            .map(|k| {
                let a = (-90.0 + 180.0 * f64::from(k) / 32.0_f64).to_radians();
                [5.0 * a.m_cos(), 5.0 * a.m_sin()]
            })
            .collect();
        half_disc[0][0] = 0.0;
        half_disc[32][0] = 0.0;
        let ball = revolve(
            &Frame::WORLD,
            &[Polygon::simple(half_disc)],
            [0.0, 0.0],
            [0.0, 1.0],
            360.0,
        )
        .unwrap();
        assert_eq!(surfaces(&ball), ["sphere"]);
        let Some(crate::faces::Surface::Sphere { center, radius }) = ball.faces.as_ref().map(|f| f.table[0])
        else {
            panic!("not a sphere")
        };
        assert!(
            vec3::len(center) < 1e-9 && (radius - 5.0).abs() < 1e-9,
            "{center:?} {radius}"
        );
    }

    #[test]
    fn revolve_a_washer_and_a_cone() {
        let poly = vec![Polygon::simple(poly2d::rect([5.0, 0.0], [15.0, 4.0]))];
        let m = revolve(&Frame::WORLD, &poly, [0.0, 0.0], [0.0, 1.0], 360.0).unwrap();
        assert!(m.edge_report().is_watertight());
        let v = PI * (225.0 - 25.0) * 4.0;
        assert!((m.volume() - v).abs() < 0.01 * v, "{} {v}", m.volume());
        let tri = vec![Polygon::simple(vec![[0.0, 0.0], [5.0, 0.0], [0.0, 10.0]])];
        let cone = revolve(&Frame::WORLD, &tri, [0.0, 0.0], [0.0, 1.0], 360.0).unwrap();
        assert!(cone.edge_report().is_watertight());
        let vc = PI * 25.0 * 10.0 / 3.0;
        assert!((cone.volume() - vc).abs() < 0.01 * vc, "{}", cone.volume());
        let half = revolve(&Frame::WORLD, &tri, [0.0, 0.0], [0.0, 1.0], 180.0).unwrap();
        assert!(half.edge_report().is_watertight());
        assert!((half.volume() - vc / 2.0).abs() < 0.01 * vc, "{}", half.volume());
        let left = vec![Polygon::simple(vec![[0.0, 0.0], [-5.0, 0.0], [0.0, 10.0]])];
        let m = revolve(&Frame::WORLD, &left, [0.0, 0.0], [0.0, 1.0], 90.0).unwrap();
        assert!(m.volume() > 0.0 && m.edge_report().is_watertight());
        let across = vec![Polygon::simple(poly2d::rect([-1.0, 0.0], [1.0, 1.0]))];
        assert!(revolve(&Frame::WORLD, &across, [0.0, 0.0], [0.0, 1.0], 360.0).is_err());
        assert!(revolve(&Frame::WORLD, &poly, [0.0, 0.0], [0.0, 0.0], 360.0).is_err());
        assert!(revolve(&Frame::WORLD, &poly, [0.0, 0.0], [0.0, 1.0], 0.0).is_err());
    }

    #[test]
    fn snaps_find_corners_midpoints_and_centers() {
        let mut ring = vec![[0.0, 0.0], [10.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]];
        ring.reverse();
        let mut p = Polygon::simple(ring);
        p.holes
            .push(poly2d::circle([10.0, 10.0], 3.0, 48).into_iter().rev().collect());
        let s = snaps(&Frame::WORLD, &[p], &[], 0.01);
        let centers: Vec<_> = s.points.iter().filter(|p| p.kind == "center").collect();
        assert_eq!(centers.len(), 1, "{:?}", s.points);
        assert!(len2(sub2(centers[0].at, [10.0, 10.0])) < 1e-6);
        assert!((centers[0].radius_mm.unwrap() - 3.0).abs() < 1e-6);
        let corners = s.points.iter().filter(|p| p.kind == "vertex").count();
        assert_eq!(corners, 4, "{:?}", s.points);
        assert!(
            s.points
                .iter()
                .any(|p| p.kind == "midpoint" && p.at == [10.0, 0.0])
        );
        let m = crate::build::box_mesh([0.0; 3], [8.0, 4.0, 2.0]);
        let s = snaps(&Frame::WORLD, &[], &[m], 0.01);
        assert!(s.points.iter().any(|p| p.kind == "vertex" && p.at == [8.0, 4.0]));
        assert_eq!(s.edges.len(), 4);
    }

    #[test]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "test values in range"
    )]
    fn fuzzed_sketches_never_panic() {
        let mut seed = 7u64;
        let mut next = || {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let kinds = ["line", "arc", "nope"];
        for _ in 0..400 {
            let mut segs = Vec::new();
            let count = 1 + (next() * 6.0) as usize;
            for _ in 0..count {
                let pick = |x: f64| -> serde_json::Value {
                    if x < 0.1 {
                        json!(0.0)
                    } else if x < 0.15 {
                        json!(1e30)
                    } else {
                        json!((x - 0.5) * 40.0)
                    }
                };
                let k = kinds[(next() * 2.95) as usize];
                let mut s = json!({ "type": k });
                if next() < 0.5 {
                    s["to"] = json!([pick(next()), pick(next())]);
                }
                if next() < 0.3 {
                    s["lengthMm"] = pick(next());
                }
                if next() < 0.3 {
                    s["angleDeg"] = pick(next());
                }
                if next() < 0.3 {
                    s["turnDeg"] = pick(next());
                }
                if next() < 0.3 {
                    s["center"] = json!([pick(next()), pick(next())]);
                }
                if next() < 0.3 {
                    s["sweepDeg"] = pick(next());
                }
                if next() < 0.3 {
                    s["through"] = json!([pick(next()), pick(next())]);
                }
                if next() < 0.3 {
                    s["radiusMm"] = pick(next());
                }
                if next() < 0.2 {
                    s["large"] = json!(true);
                }
                segs.push(s);
            }
            let lp = json!([{ "start": [0, 0], "segments": segs }, { "points": [[next(), next()], [next(), 2.0], [3.0, next()]] }]);
            let l: Vec<Loop> = serde_json::from_value(lp).unwrap();
            let c = check(&l);
            if c.ok {
                let m = crate::build::extrude(&c.polygons, &Frame::WORLD, 0.0, 1.0).unwrap();
                assert!(m.edge_report().is_watertight());
            } else {
                assert!(c.issues.iter().all(|i| !i.message.is_empty()));
            }
        }
    }
}
