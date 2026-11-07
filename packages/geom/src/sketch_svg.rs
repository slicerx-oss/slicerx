// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sketch.svg`: svg paths as sketch loops of lines, arcs, circles and splines
// sample and span indices stay inside the lists built here
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::poly2d;
use crate::sketch::{self, CLOSE_MM, Loop, MAX_MM, Segment, SketchCheck};
use crate::sketch_spline;
use crate::svg::{self, Mat, Seg, Sub, apply, mul};
use crate::vec3::V2;
use serde::{Deserialize, Serialize};

// shorter than this a piece is dropped
const MIN_MM: f64 = 1e-4;
// most points one curve takes
const MAX_SAMPLES: usize = 64;
// most path pieces one file may have, so the fit stays bounded
const MAX_PIECES: usize = 50_000;
// the finest tolerance a fit is asked for
const MIN_TOL_MM: f64 = 0.001;

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

/// what one svg curve becomes; a spline says whether it met the tolerance
enum Piece {
    Line,
    Arc { through: V2, center: V2, radius: f64 },
    Spline(Vec<V2>, bool),
}

/// a cubic as a line when straight, an arc when round, else a spline through samples of it
#[allow(clippy::cast_precision_loss, reason = "sample counts are small")]
fn cubic(p: [V2; 4], tol: f64) -> Piece {
    // the curve stays inside its control polygon, so a short one is within tol of its chord
    if dist(p[0], p[1]) + dist(p[1], p[2]) + dist(p[2], p[3]) <= tol {
        return Piece::Line;
    }
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
    let mut n = 2;
    loop {
        let through: Vec<V2> = (0..=n).map(|k| bez(&p, k as f64 / n as f64)).collect();
        // the error at matching t, a few points inside each span
        let off = sketch_spline::spans(&through, false)
            .iter()
            .enumerate()
            .flat_map(|(j, b)| {
                (1..4).map(move |q| {
                    let s = f64::from(q) / 4.0;
                    dist(bez(b, s), bez(&p, (j as f64 + s) / n as f64))
                })
            })
            .fold(0.0, f64::max);
        let met = off <= tol;
        if met || n >= MAX_SAMPLES {
            return Piece::Spline(through[1..n].to_vec(), met);
        }
        n = (n * 3 / 2).clamp(n + 1, MAX_SAMPLES);
    }
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
    // splines that missed the tolerance at the most points
    missed: usize,
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
            Piece::Spline(points, met) => {
                self.missed += usize::from(!met);
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

/// one subpath as a loop, closed back to its start, or None when nothing of it is left; counts missed fits
fn to_loop(sub: &Sub, m: &Mat, tol: f64, missed: &mut usize) -> Option<Loop> {
    let start = apply(m, sub.start);
    let mut b = Builder {
        segs: Vec::new(),
        round: Vec::new(),
        at: start,
        missed: 0,
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
    *missed += b.missed;
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
    if !(tol.is_finite() && (MIN_TOL_MM..=1.0).contains(&tol)) {
        return Err(Error::invalid("toleranceMm", "between 0.001 and 1 mm"));
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
    if s > MAX_MM {
        return Err(Error::invalid("scale", "at most 100000 mm per unit"));
    }
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

    let pieces: usize = found
        .iter()
        .flat_map(|(subs, ..)| subs)
        .map(|sub| sub.segs.len())
        .sum();
    if pieces > MAX_PIECES {
        return Err(Error::mesh(
            "svg",
            format!("the artwork has {pieces} path pieces, more than {MAX_PIECES}; simplify it first"),
        ));
    }
    let out_of_range = || Error::mesh("svg", "the artwork's coordinates are out of range");
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
            if ring.iter().flatten().any(|v| !v.is_finite()) {
                return Err(out_of_range());
            }
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
    if !(w.is_finite() && h.is_finite()) {
        return Err(out_of_range());
    }
    let f = if opts.scale.is_some() {
        1.0
    } else {
        opts.fit_width_mm
            .map(|t| t / w)
            .or_else(|| opts.fit_height_mm.map(|t| t / h))
            .filter(|f| f.is_finite() && *f > 0.0)
            .unwrap_or(1.0)
    };
    if w * f > MAX_MM || h * f > MAX_MM {
        return Err(Error::mesh(
            "svg",
            format!(
                "the artwork is {:.0} x {:.0} mm, over the {MAX_MM:.0} mm a sketch takes",
                w * f,
                h * f
            ),
        ));
    }
    let mid = [f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1])];
    let place: Mat = [
        f,
        0.0,
        0.0,
        f,
        opts.center[0] - f * mid[0],
        opts.center[1] - f * mid[1],
    ];
    let mut missed = 0usize;
    let mut loops: Vec<Loop> = kept
        .iter()
        .filter_map(|(sub, m)| to_loop(sub, &mul(&place, m), tol, &mut missed))
        .collect();
    if missed > 0 {
        warnings.push(format!(
            "{missed} {} needed more than {MAX_SAMPLES} points for the {tol} mm tolerance and {} a little further off",
            if missed == 1 { "curve" } else { "curves" },
            if missed == 1 { "stays" } else { "stay" }
        ));
    }
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

    fn finite(r: &SvgSketch) -> bool {
        let p = |p: &Option<V2>| p.is_none_or(|p| p.iter().all(|v| v.is_finite()));
        r.size_mm.iter().all(|v| v.is_finite())
            && r.loops.iter().all(|l| {
                p(&l.start)
                    && p(&l.center)
                    && l.segments
                        .iter()
                        .all(|s| p(&s.to) && p(&s.through) && s.points.iter().all(|q| p(&Some(*q))))
            })
    }

    #[test]
    fn a_curve_that_never_leaves_its_start_is_dropped() {
        let r = sketch_svg(
            &wrap(r#"<path d="M10 10 H50 c0,0 0,0 0,0 V50 s0 0 0 0 H10 Z"/>"#),
            &SvgSketchOptions::default(),
        )
        .unwrap();
        assert_eq!(kinds(&r.loops[0]), ["line", "line", "line", "line"]);
        assert!(r.check.ok, "{:?}", r.check.issues);
    }

    #[test]
    fn the_fit_is_bounded_and_says_when_it_falls_short() {
        let fine = SvgSketchOptions {
            tolerance_mm: 0.0005,
            ..SvgSketchOptions::default()
        };
        assert!(sketch_svg(&wrap(r#"<rect width="10" height="10"/>"#), &fine).is_err());
        // a wave ten meters across cannot meet a micron with 64 points
        let wave = SvgSketchOptions {
            fit_width_mm: Some(10_000.0),
            tolerance_mm: 0.001,
            ..SvgSketchOptions::default()
        };
        let r = sketch_svg(&wrap(r#"<path d="M0 0 C30 90 60 -90 90 0 V20 H0 Z"/>"#), &wave).unwrap();
        assert!(
            r.warnings.iter().any(|w| w.contains("64 points")),
            "{:?}",
            r.warnings
        );
        // too many pieces is an error, not a long wait
        let mut d = String::from("M0 0");
        for k in 0..50_001 {
            d.push_str(if k % 2 == 0 { " h0.001" } else { " v0.001" });
        }
        d.push_str(" Z");
        let many = sketch_svg(
            &wrap(&format!(r#"<path d="{d}"/>"#)),
            &SvgSketchOptions::default(),
        );
        assert!(many.is_err());
    }

    #[test]
    fn many_curves_fit_in_bounded_time() {
        let mut d = String::from("M0 0");
        for _ in 0..1_000 {
            d.push_str(" c0.03 0.09 0.06 -0.09 0.09 0");
        }
        d.push_str(" V20 H0 Z");
        let wave = SvgSketchOptions {
            fit_width_mm: Some(10_000.0),
            tolerance_mm: 0.001,
            ..SvgSketchOptions::default()
        };
        let t = std::time::Instant::now();
        let r = sketch_svg(&wrap(&format!(r#"<path d="{d}"/>"#)), &wave).unwrap();
        assert_eq!(r.counts.splines, 1_000);
        assert!(t.elapsed().as_secs() < 20, "{:?}", t.elapsed());
    }

    #[test]
    fn numbers_out_of_range_are_refused_or_cut() {
        // an overflowing number cuts its path short and leaves the rest whole
        let r = sketch_svg(
            &wrap(r#"<rect width="10" height="10"/><path d="M0 0 L1e999 0 L0 10 Z"/>"#),
            &SvgSketchOptions::default(),
        )
        .unwrap();
        assert!(finite(&r), "{r:?}");
        assert_eq!(r.size_mm, [10.0, 10.0]);
        assert!(
            r.warnings.iter().any(|w| w.contains("cut short")),
            "{:?}",
            r.warnings
        );
        for (bad, says) in [
            (wrap(r#"<path d="M0 0 H1e308 V1e308 Z"/>"#), "over the 100000 mm"),
            (
                r#"<svg width="1e308mm" viewBox="0 0 1e-300 1"><rect width="1" height="1"/></svg>"#
                    .to_owned(),
                "no usable size",
            ),
        ] {
            let out = sketch_svg(&bad, &SvgSketchOptions::default());
            assert!(
                out.as_ref().is_err_and(|e| e.to_string().contains(says)),
                "{bad}: {out:?}"
            );
        }
        let huge = SvgSketchOptions {
            scale: Some(1e308),
            ..SvgSketchOptions::default()
        };
        assert!(sketch_svg(&wrap(r#"<rect width="10" height="10"/>"#), &huge).is_err());
    }

    fn circle4(r: f64) -> String {
        let k = 0.552_284_749_8 * r;
        wrap(&format!(
            "<path d=\"M{r} 0 C{r} {k} {k} {r} 0 {r} C-{k} {r} -{r} {k} -{r} 0 C-{r} -{k} -{k} -{r} 0 -{r} C{k} -{r} {r} -{k} {r} 0 Z\"/>"
        ))
    }

    #[test]
    fn round_and_straight_cubics_become_arcs_and_lines() {
        // a circle written as four cubics, as editors save one
        let small = sketch_svg(&circle4(5.0), &SvgSketchOptions::default()).unwrap();
        assert_eq!(small.loops[0].kind.as_deref(), Some("circle"));
        assert!((small.loops[0].diameter_mm.unwrap() - 10.0).abs() <= 0.01);
        // at 50 the four cubics stray past half the default tolerance, so splines; a looser one makes it a circle
        let big = sketch_svg(&circle4(50.0), &SvgSketchOptions::default()).unwrap();
        assert_eq!(kinds(&big.loops[0]), ["spline"; 4]);
        let loose = SvgSketchOptions {
            tolerance_mm: 0.1,
            ..SvgSketchOptions::default()
        };
        let big = sketch_svg(&circle4(50.0), &loose).unwrap();
        assert_eq!(big.loops[0].kind.as_deref(), Some("circle"));
        assert!((big.loops[0].diameter_mm.unwrap() - 100.0).abs() <= 0.1);
        // controls on the chord make a line; one past its end does not
        let straight = sketch_svg(
            &wrap(r#"<path d="M0 0 C10 0 20 0 30 0 V10 H0 Z"/>"#),
            &SvgSketchOptions::default(),
        )
        .unwrap();
        assert_eq!(kinds(&straight.loops[0]), ["line", "line", "line", "line"]);
        let over = sketch_svg(
            &wrap(r#"<path d="M0 0 C10 0 45 0 30 0 V10 H0 Z"/>"#),
            &SvgSketchOptions::default(),
        )
        .unwrap();
        assert_ne!(kinds(&over.loops[0])[0], "line");
    }

    #[test]
    fn only_arcs_round_one_center_make_a_circle() {
        // a stadium: two half circles at different centers, with and without lines between
        for (d, lines) in [
            ("M20 10 H60 A10 10 0 0 1 60 30 H20 A10 10 0 0 1 20 10 Z", 2),
            ("M20 10 A10 10 0 0 1 20 30 A15 15 0 0 1 20 10 Z", 0),
        ] {
            let r = sketch_svg(
                &wrap(&format!(r#"<path d="{d}"/>"#)),
                &SvgSketchOptions::default(),
            )
            .unwrap();
            assert_eq!(r.counts.circles, 0, "{d}");
            assert_eq!((r.counts.lines, r.counts.arcs), (lines, 2), "{d}");
        }
        let rounded = sketch_svg(
            &wrap(r#"<rect x="10" y="10" width="40" height="20" rx="5"/>"#),
            &SvgSketchOptions::default(),
        )
        .unwrap();
        assert_eq!(rounded.counts.circles, 0);
        assert_eq!((rounded.counts.lines, rounded.counts.arcs), (4, 4));
        // three quarters of a circle with the large flag, a quarter without; the middle lands on the far side
        let mut thrus = Vec::new();
        for (large, sweep, want) in [
            (1, 1, 10.0 + 10.0 / 2f64.sqrt()),
            (1, 0, 10.0 + 10.0 / 2f64.sqrt()),
            (0, 1, 10.0 - 10.0 / 2f64.sqrt()),
        ] {
            let r = sketch_svg(
                &wrap(&format!(r#"<path d="M30 20 A10 10 0 {large} {sweep} 20 10 Z"/>"#)),
                &SvgSketchOptions::default(),
            )
            .unwrap();
            let l = &r.loops[0];
            let (s, arc) = (l.start.unwrap(), &l.segments[0]);
            assert_eq!(arc.kind, "arc");
            let (e, t) = (arc.to.unwrap(), arc.through.unwrap());
            let mid = [f64::midpoint(s[0], e[0]), f64::midpoint(s[1], e[1])];
            assert!(
                (dist(t, mid) - want).abs() < 1e-6,
                "{large} {sweep}: {}",
                dist(t, mid)
            );
            thrus.push(t);
        }
        assert!(dist(thrus[0], thrus[1]) > 1.0);
    }

    #[test]
    fn hostile_files_are_refused_or_read_whole() {
        let none = SvgSketchOptions::default();
        for bad in [
            String::new(),
            "not svg at all".to_owned(),
            "<svg/>".to_owned(),
            wrap("<path/>"),
            wrap(r#"<path d=""/>"#),
            wrap(r#"<path d="M5 5"/>"#),
            wrap(r#"<rect width="10" height="10" fill="none"/>"#),
        ] {
            assert!(sketch_svg(&bad, &none).is_err(), "{bad}");
        }
        // a zero or negative viewBox falls back to the default size
        for vb in ["0 0 0 0", "0 0 -10 10"] {
            let r = sketch_svg(
                &format!(r#"<svg viewBox="{vb}" width="10mm"><rect width="10" height="10"/></svg>"#),
                &none,
            )
            .unwrap();
            assert!(finite(&r) && r.size_mm[0] > 0.0, "{r:?}");
        }
        // deep nesting walks without recursion
        let deep = wrap(&format!(
            "{}<rect width=\"10\" height=\"10\"/>{}",
            "<g>".repeat(5_000),
            "</g>".repeat(5_000)
        ));
        assert_eq!(sketch_svg(&deep, &none).unwrap().loops.len(), 1);
        // the warnings that say what was cut or ignored
        let r = sketch_svg(
            &wrap(r#"<clipPath id="c"><rect width="5" height="5"/></clipPath><rect width="10" height="10" clip-path="url(#c)"/><path d="M20 20 H30 V30 Z L x"/>"#),
            &none,
        )
        .unwrap();
        assert!(
            r.warnings.iter().any(|w| w.contains("clip paths")),
            "{:?}",
            r.warnings
        );
        assert!(
            r.warnings.iter().any(|w| w.contains("cut short")),
            "{:?}",
            r.warnings
        );
        // a filled polyline closes
        let poly = sketch_svg(&wrap(r#"<polyline points="0 0 10 0 10 10" fill="red"/>"#), &none).unwrap();
        assert_eq!(kinds(&poly.loops[0]), ["line", "line", "line"]);
    }
}
