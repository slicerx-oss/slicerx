// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sketch.svg`: svg paths as sketch loops of lines, arcs, circles and splines
// sample and span indices stay inside the lists built here
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::poly2d;
use crate::sketch::{self, CLOSE_MM, Loop, Segment, SketchCheck};
use crate::sketch_spline;
use crate::svg::{self, Mat, Seg, Sub, apply, mul};
use crate::vec3::V2;
use serde::{Deserialize, Serialize};

// shorter than this a piece is dropped
const MIN_MM: f64 = 1e-4;
// most points one curve takes
const MAX_SAMPLES: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SvgSketchOptions {
    /// mm per svg unit; the file's own size when absent, and fit is ignored when set
    pub scale: Option<f64>,
    pub fit_width_mm: Option<f64>,
    pub fit_height_mm: Option<f64>,
    /// where the middle of the artwork lands, sketch mm
    pub center: V2,
    pub tolerance_mm: f64,
}

impl Default for SvgSketchOptions {
    fn default() -> Self {
        Self {
            scale: None,
            fit_width_mm: None,
            fit_height_mm: None,
            center: [0.0, 0.0],
            tolerance_mm: 0.01,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub lines: usize,
    pub arcs: usize,
    pub splines: usize,
    pub circles: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgSketch {
    pub loops: Vec<Loop>,
    pub counts: Counts,
    pub size_mm: V2,
    pub mm_per_unit: f64,
    pub check: SketchCheck,
    pub warnings: Vec<String>,
}

fn sub2(a: V2, b: V2) -> V2 {
    [a[0] - b[0], a[1] - b[1]]
}

fn dist(a: V2, b: V2) -> f64 {
    (a[0] - b[0]).m_hypot(a[1] - b[1])
}

fn bez(p: &[V2; 4], t: f64) -> V2 {
    let u = 1.0 - t;
    let (w0, w1, w2, w3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    [
        w0 * p[0][0] + w1 * p[1][0] + w2 * p[2][0] + w3 * p[3][0],
        w0 * p[0][1] + w1 * p[1][1] + w2 * p[2][1] + w3 * p[3][1],
    ]
}

fn circumcenter(a: V2, b: V2, c: V2) -> Option<V2> {
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
fn to_segment(p: V2, a: V2, b: V2) -> f64 {
    let ab = sub2(b, a);
    let l2 = ab[0] * ab[0] + ab[1] * ab[1];
    let t = if l2 > 0.0 {
        (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    dist(p, [a[0] + t * ab[0], a[1] + t * ab[1]])
}

/// the farthest any point of `a` is from the polyline `b`
fn farthest(a: &[V2], b: &[V2]) -> f64 {
    a.iter()
        .map(|&p| {
            b.windows(2)
                .map(|w| to_segment(p, w[0], w[1]))
                .fold(f64::INFINITY, f64::min)
        })
        .fold(0.0, f64::max)
}

/// what one svg curve becomes
enum Piece {
    Line,
    Arc { through: V2, center: V2, radius: f64 },
    Spline(Vec<V2>),
}

/// a cubic as a line when straight, an arc when round, else a spline through samples of it
#[allow(clippy::cast_precision_loss, reason = "sample counts are small")]
fn cubic(p: [V2; 4], tol: f64) -> Piece {
    let chord = sub2(p[3], p[0]);
    let len = chord[0].m_hypot(chord[1]);
    if len > MIN_MM {
        let flat = [p[1], p[2]].iter().all(|&c| {
            let t = ((c[0] - p[0][0]) * chord[0] + (c[1] - p[0][1]) * chord[1]) / (len * len);
            let off = ((c[0] - p[0][0]) * chord[1] - (c[1] - p[0][1]) * chord[0]).abs() / len;
            off <= tol && t > -tol / len && t < 1.0 + tol / len
        });
        if flat {
            return Piece::Line;
        }
        let mid = bez(&p, 0.5);
        if let Some(c) = circumcenter(p[0], mid, p[3]) {
            let r = dist(p[0], c);
            if r < 1e5 && (1..8).all(|k| (dist(bez(&p, f64::from(k) / 8.0), c) - r).abs() <= tol / 2.0) {
                return Piece::Arc {
                    through: mid,
                    center: c,
                    radius: r,
                };
            }
        }
    }
    let fine: Vec<V2> = (0..=256).map(|k| bez(&p, f64::from(k) / 256.0)).collect();
    let mut best = Vec::new();
    for n in 2..=MAX_SAMPLES {
        let inner: Vec<V2> = (1..n).map(|k| bez(&p, k as f64 / n as f64)).collect();
        let mut through = vec![p[0]];
        through.extend(&inner);
        through.push(p[3]);
        let mut drawn = vec![p[0]];
        drawn.extend(
            sketch_spline::spans(&through, false)
                .iter()
                .flat_map(|b| sketch_spline::flatten(b, 16)),
        );
        best = inner;
        if farthest(&drawn, &fine) <= tol && farthest(&fine, &drawn) <= tol {
            break;
        }
    }
    Piece::Spline(best)
}

/// whether `m` keeps circles round: no skew and the same scale both ways
fn keeps_circles(m: &Mat) -> bool {
    let (u, v) = (m[0] * m[0] + m[1] * m[1], m[2] * m[2] + m[3] * m[3]);
    (m[0] * m[2] + m[1] * m[3]).abs() <= 1e-9 * u && (u - v).abs() <= 1e-9 * u
}

struct Builder {
    segs: Vec<Segment>,
    // each arc's center and radius, for loops that are whole circles
    round: Vec<Option<(V2, f64)>>,
    at: V2,
}

impl Builder {
    fn line(&mut self, to: V2) {
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

    fn arc(&mut self, to: V2, through: V2, center: V2, radius: f64) {
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

    fn cubic(&mut self, c1: V2, c2: V2, to: V2, tol: f64) {
        match cubic([self.at, c1, c2, to], tol) {
            Piece::Line => self.line(to),
            Piece::Arc {
                through,
                center,
                radius,
            } => self.arc(to, through, center, radius),
            Piece::Spline(points) => {
                self.segs.push(Segment {
                    kind: "spline".into(),
                    to: Some(to),
                    points,
                    ..Segment::default()
                });
                self.round.push(None);
                self.at = to;
            }
        }
    }
}

/// one subpath as a loop, closed back to its start, or None when nothing of it is left
fn to_loop(sub: &Sub, m: &Mat, tol: f64) -> Option<Loop> {
    let start = apply(m, sub.start);
    let mut b = Builder {
        segs: Vec::new(),
        round: Vec::new(),
        at: start,
    };
    let mut cur = sub.start;
    for &seg in &sub.segs {
        match seg {
            Seg::Line(to) => b.line(apply(m, to)),
            Seg::Cubic(c1, c2, to) => b.cubic(apply(m, c1), apply(m, c2), apply(m, to), tol),
            Seg::Arc {
                rx,
                ry,
                rot,
                large,
                sweep,
                to,
            } => {
                let e = (dist(cur, to) > 1e-12)
                    .then(|| svg::ellipse(cur, rx, ry, rot, large, sweep, to))
                    .flatten();
                match e {
                    Some(e) if (e.rx - e.ry).abs() <= 1e-9 * e.rx && keeps_circles(m) => {
                        let (s, c) = (e.theta + e.delta / 2.0).m_sin_cos();
                        let k = (m[0] * m[3] - m[1] * m[2]).abs().sqrt();
                        b.arc(apply(m, to), apply(m, e.point(c, s)), apply(m, e.c), e.rx * k);
                    }
                    // an ellipse, or a skewed circle: each quarter as a curve
                    Some(_) => {
                        for [c1, c2, end] in svg::arc_to_cubics(cur, rx, ry, rot, large, sweep, to) {
                            b.cubic(apply(m, c1), apply(m, c2), apply(m, end), tol);
                        }
                    }
                    None => b.line(apply(m, to)),
                }
            }
        }
        cur = seg.to();
    }
    if dist(b.at, start) >= CLOSE_MM {
        b.line(start);
    } else if let Some(last) = b.segs.last_mut() {
        last.to = Some(start);
    }
    if b.segs.len() < 2 {
        return None;
    }
    // arcs round one center all the way are a circle
    if let Some(Some((c, r))) = b.round.first().copied() {
        let whole = b
            .round
            .iter()
            .all(|x| x.is_some_and(|(c2, r2)| dist(c, c2) <= tol && (r - r2).abs() <= tol));
        if whole {
            return Some(Loop {
                kind: Some("circle".into()),
                center: Some(c),
                diameter_mm: Some(2.0 * r),
                ..Loop::default()
            });
        }
    }
    Some(Loop {
        start: Some(start),
        segments: b.segs,
        ..Loop::default()
    })
}

// to a millionth of a mm, and never -0
fn tidy(v: f64) -> f64 {
    (v * 1e6).round() / 1e6 + 0.0
}

fn tidy2(p: V2) -> V2 {
    [tidy(p[0]), tidy(p[1])]
}

fn tidy_loop(l: &mut Loop) {
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

fn count(loops: &[Loop]) -> Counts {
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

/// the closed paths of `svg` as sketch loops, holes kept as loops inside; strokes and fills alike, open strokes left out
#[allow(clippy::too_many_lines, reason = "checks, the walk, then sizing in one pass")]
pub fn sketch_svg(svg: &str, opts: &SvgSketchOptions) -> Result<SvgSketch> {
    let tol = opts.tolerance_mm;
    if !(tol.is_finite() && tol > 0.0 && tol <= 1.0) {
        return Err(Error::invalid("toleranceMm", "between 0 and 1 mm"));
    }
    if opts.scale.is_some_and(|s| !(s.is_finite() && s > 0.0)) {
        return Err(Error::invalid("scale", "must be above 0"));
    }
    for (what, v) in [
        ("fitWidthMm", opts.fit_width_mm),
        ("fitHeightMm", opts.fit_height_mm),
    ] {
        if v.is_some_and(|v| !(v.is_finite() && v > 0.0 && v <= 10_000.0)) {
            return Err(Error::invalid(what, "between 0 and 10000 mm"));
        }
    }
    if !opts.center.iter().all(|c| c.is_finite() && c.abs() <= 10_000.0) {
        return Err(Error::invalid("center", "within 10000 mm of the origin"));
    }
    let own = svg::own_scale(svg)?;
    let s = opts.scale.unwrap_or(own);
    let defs = svg::scan_defs(svg);
    let mut warnings = Vec::new();
    let mut found: Vec<(Vec<Sub>, Mat, bool)> = Vec::new();
    svg::shapes(
        svg,
        &defs,
        &[s, 0.0, 0.0, -s, 0.0, 0.0],
        [0, 0, 0],
        tol,
        &mut warnings,
        |name, attrs, style, w| {
            if style.fill.is_none() && !style.stroke {
                return;
            }
            let Some(d) = svg::shape_path(name, attrs) else {
                return;
            };
            let (subs, ok) = svg::parse_path(&d);
            if !ok {
                svg::warn("malformed path data was cut short", w);
            }
            if !style.clips.is_empty() {
                svg::warn(
                    "clip paths do not apply in a sketch; the whole shapes were kept",
                    w,
                );
            }
            found.push((subs, style.m, style.fill.is_some()));
        },
    );

    let mut open = 0usize;
    let mut kept: Vec<(&Sub, Mat)> = Vec::new();
    let mut rings: Vec<Vec<V2>> = Vec::new();
    for (subs, m, filled) in &found {
        for sub in subs {
            let Some(end) = sub.segs.last().copied().map(Seg::to) else {
                continue;
            };
            // a fill closes its paths; a bare stroke has to come back to its start
            if !(sub.closed || *filled || dist(apply(m, end), apply(m, sub.start)) < CLOSE_MM) {
                open += 1;
                continue;
            }
            let ring = svg::flatten_sub(sub, m, tol);
            if ring.len() < 3 || poly2d::signed_area(&ring).abs() < 1e-9 {
                continue;
            }
            rings.push(ring);
            kept.push((sub, *m));
        }
    }
    if open > 0 {
        warnings.push(format!(
            "{open} open {} with no fill {} left out; a sketch loop has to close",
            if open == 1 { "path" } else { "paths" },
            if open == 1 { "was" } else { "were" }
        ));
    }
    let (lo, hi) =
        svg::bounds(&rings).ok_or_else(|| Error::mesh("svg", "the artwork has no closed shapes"))?;
    let (w, h) = (hi[0] - lo[0], hi[1] - lo[1]);
    let f = if opts.scale.is_some() {
        1.0
    } else {
        opts.fit_width_mm
            .map(|t| t / w)
            .or_else(|| opts.fit_height_mm.map(|t| t / h))
            .filter(|f| f.is_finite() && *f > 0.0)
            .unwrap_or(1.0)
    };
    let mid = [f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1])];
    let place: Mat = [
        f,
        0.0,
        0.0,
        f,
        opts.center[0] - f * mid[0],
        opts.center[1] - f * mid[1],
    ];
    let mut loops: Vec<Loop> = kept
        .iter()
        .filter_map(|(sub, m)| to_loop(sub, &mul(&place, m), tol))
        .collect();
    loops.iter_mut().for_each(tidy_loop);
    if loops.is_empty() {
        return Err(Error::mesh("svg", "the artwork has no closed shapes"));
    }
    Ok(SvgSketch {
        counts: count(&loops),
        check: sketch::check(&loops),
        loops,
        size_mm: [tidy(w * f), tidy(h * f)],
        mm_per_unit: s * f,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::float_cmp)]
    use super::*;
    use crate::sketch::Role;

    fn wrap(body: &str) -> String {
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\" width=\"100mm\">{body}</svg>"
        )
    }

    fn kinds(l: &Loop) -> Vec<&str> {
        l.segments.iter().map(|s| s.kind.as_str()).collect()
    }

    #[test]
    fn a_square_with_a_round_hole_keeps_the_hole() {
        let r = sketch_svg(
            &wrap(r#"<path d="M10 10 H50 V50 H10 Z M30 22 A8 8 0 1 0 30 38 A8 8 0 1 0 30 22 Z" fill-rule="evenodd"/>"#),
            &SvgSketchOptions::default(),
        )
        .unwrap();
        assert_eq!(r.loops.len(), 2);
        assert_eq!(kinds(&r.loops[0]), ["line", "line", "line", "line"]);
        assert_eq!(r.loops[1].kind.as_deref(), Some("circle"));
        assert!((r.loops[1].diameter_mm.unwrap() - 16.0).abs() < 1e-6);
        assert_eq!(
            r.counts,
            Counts {
                lines: 4,
                arcs: 0,
                splines: 0,
                circles: 1
            }
        );
        assert!(r.check.ok, "{:?}", r.check.issues);
        let roles: Vec<Role> = r.check.loops.iter().map(|l| l.role).collect();
        assert_eq!(roles, [Role::Outer, Role::Hole]);
        let want = 40.0 * 40.0 - std::f64::consts::PI * 64.0;
        // the hole is drawn as chords inside the circle, so the area comes out a little over
        assert!((r.check.area_mm2 - want).abs() < 0.5, "{}", r.check.area_mm2);
        // centered on the origin, y up
        assert_eq!(r.size_mm, [40.0, 40.0]);
        assert_eq!(r.loops[0].start, Some([-20.0, 20.0]));
    }

    #[test]
    fn curves_become_arcs_and_splines_within_tolerance() {
        // a cubic, a quadratic, a circular arc and an elliptical one
        let d = "M0 0 L40 0 C50 0 60 10 60 20 Q60 40 40 40 A10 10 0 0 1 20 40 A20 10 0 0 1 0 40 Z";
        let tol = 0.01;
        let r = sketch_svg(
            &wrap(&format!(r#"<path d="{d}"/>"#)),
            &SvgSketchOptions {
                scale: Some(1.0),
                ..SvgSketchOptions::default()
            },
        )
        .unwrap();
        assert_eq!(r.loops.len(), 1);
        assert_eq!(
            kinds(&r.loops[0]),
            ["line", "spline", "spline", "arc", "spline", "line"]
        );
        assert!(r.check.ok, "{:?}", r.check.issues);
        // the drawn loop stays within the tolerance of the artwork, flattened finely
        let (subs, _) = svg::parse_path(d);
        // y runs 0 to 50 down the page, so the middle lands at the origin this way
        let place = [1.0, 0.0, 0.0, -1.0, -30.0, 25.0];
        let truth = svg::flatten_sub(&subs[0], &place, 1e-4);
        let checked = sketch::check(&r.loops);
        let drawn = &checked.polygons[0].outer;
        let mut closed = drawn.clone();
        closed.push(drawn[0]);
        let mut truth_closed = truth.clone();
        truth_closed.push(truth[0]);
        assert!(
            farthest(&truth, &closed) < tol + 0.006,
            "{}",
            farthest(&truth, &closed)
        );
        assert!(
            farthest(drawn, &truth_closed) < tol + 0.006,
            "{}",
            farthest(drawn, &truth_closed)
        );
        // the arc is exact: its middle is the bottom of the half circle round (30, 40)
        let th = r.loops[0].segments[3].through.unwrap();
        assert!(dist(th, [0.0, -25.0]) < 1e-6, "{th:?}");
    }

    #[test]
    fn transforms_on_groups_and_paths_apply() {
        let svg = wrap(
            r#"<g transform="translate(50 50) rotate(90)"><rect x="0" y="0" width="20" height="10" transform="scale(2 1)"/></g>"#,
        );
        let r = sketch_svg(&svg, &SvgSketchOptions::default()).unwrap();
        assert_eq!(r.loops.len(), 1);
        // 40 by 10 turned a quarter: 10 wide, 40 tall
        assert_eq!(r.size_mm, [10.0, 40.0]);
        assert!((r.check.area_mm2 - 400.0).abs() < 1e-6);
        // a circle under a skew is an ellipse, so splines; under a plain scale it stays a circle
        let skew = sketch_svg(
            &wrap(r#"<circle cx="50" cy="50" r="10" transform="skewX(20)"/><circle cx="20" cy="20" r="5" transform="scale(2)"/>"#),
            &SvgSketchOptions::default(),
        )
        .unwrap();
        assert!(skew.loops[0].segments.iter().all(|s| s.kind == "spline"));
        assert_eq!(skew.loops[1].kind.as_deref(), Some("circle"));
        assert!((skew.loops[1].diameter_mm.unwrap() - 20.0).abs() < 1e-6);
    }

    #[test]
    fn fit_center_and_what_is_left_out() {
        let svg = wrap(
            r#"<rect x="0" y="0" width="10" height="5"/><path d="M0 50 L30 50" fill="none" stroke="black"/><text x="0" y="0">hi</text>"#,
        );
        let r = sketch_svg(
            &svg,
            &SvgSketchOptions {
                fit_width_mm: Some(40.0),
                center: [100.0, 50.0],
                ..SvgSketchOptions::default()
            },
        )
        .unwrap();
        assert_eq!(r.loops.len(), 1);
        assert_eq!(r.size_mm, [40.0, 20.0]);
        assert_eq!(r.loops[0].start, Some([80.0, 60.0]));
        assert!((r.mm_per_unit - 4.0).abs() < 1e-9);
        assert!(
            r.warnings.iter().any(|w| w.contains("1 open path")),
            "{:?}",
            r.warnings
        );
        assert!(
            r.warnings.iter().any(|w| w.contains("<text>")),
            "{:?}",
            r.warnings
        );
        // a closed stroke with no fill is kept
        let ring = sketch_svg(
            &wrap(r#"<path d="M0 0 H10 V10 H0 Z" fill="none" stroke="red"/>"#),
            &SvgSketchOptions::default(),
        )
        .unwrap();
        assert_eq!(ring.loops.len(), 1);
        assert!(
            sketch_svg(
                &wrap(r#"<path d="M0 0 L10 0" fill="none" stroke="red"/>"#),
                &SvgSketchOptions::default()
            )
            .is_err()
        );
        let bad = SvgSketchOptions {
            fit_width_mm: Some(0.0),
            ..SvgSketchOptions::default()
        };
        assert!(sketch_svg(&svg, &bad).is_err());
    }
}
