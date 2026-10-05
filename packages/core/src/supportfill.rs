// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The support base fill: straight lines across each support island, joined along the island's outline
//! the way Orca's `FillSupportBase` does it (`FillRectilinear.cpp`, and `Fill::connect_base_support` in
//! `FillBase.cpp`).
//!
//! Each island is turned so the lines run vertically, pulled in half a line spacing, and cut by vertical
//! lines on a lattice through the middle of the plate. The line ends become points on the outline, and the
//! outline between neighboring ends is an arch that may join two lines. The outline next to other lines is
//! masked first. Then, in Orca's order:
//! - outlines no line touches print as loops;
//! - arches that touch a line on both sides print their free middle;
//! - line ends slide along a nearly vertical outline to continue the line;
//! - vertical arches (back to the same line position) are taken, then arches that stand out from the
//!   line (by how far they leave the band between their ends), then zig-zag connections, end caps,
//!   T joints, and finally very long arches and caps even where their ends were used.

#![allow(
    clippy::indexing_slicing,
    clippy::cast_precision_loss,
    reason = "a graph of line ends that index their outline and its arc lengths, as Orca's does; coordinates are plate units"
)]

use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use crate::perimeters::{self, Shapes};

type Pt = (i64, i64);

/// Support base lines for `region` at `spacing_mm` between neighbors at full density, `density` of that,
/// with the lines along `angle_deg` (0 runs them along x) on a lattice through `center` (mm).
pub(crate) fn support_base(
    region: &Shapes,
    spacing_mm: f64,
    density: f64,
    angle_deg: f64,
    center: [f64; 2],
) -> Vec<Vec<Point>> {
    if density <= 0.0 || spacing_mm <= 0.0 {
        return Vec::new();
    }
    // Orca draws vertical lines after turning by the fill angle plus a right angle.
    let turn = -(angle_deg + 90.0);
    let mut out = Vec::new();
    for island in region {
        let rotated = crate::supportgrid::turn(&vec![island.clone()], turn, center);
        let inner = perimeters::offset(&rotated, -crate::geom::mm(0.5 * spacing_mm));
        let rings = outlines(&inner);
        if rings.is_empty() {
            continue;
        }
        let src_bounds = perimeters::bounds(&rotated);
        let Some(b) = src_bounds else { continue };
        let lines = vertical_lines(
            &rings,
            [i64::from(b[0]), i64::from(b[2])],
            spacing_mm * SCALE / density,
            center,
        );
        let polylines = connect(lines, &rings, spacing_mm * SCALE, density);
        out.extend(
            polylines
                .into_iter()
                .filter(|p| p.len() >= 2)
                .map(|p| unturn(&p, -turn, center)),
        );
    }
    out
}

/// The rings of `shapes` as integer points, outer contours counterclockwise and holes clockwise.
fn outlines(shapes: &Shapes) -> Vec<Vec<Pt>> {
    let mut out = Vec::new();
    for shape in shapes {
        for (k, ring) in shape.iter().enumerate() {
            let mut r: Vec<Pt> = ring.iter().map(|p| (i64::from(p.x), i64::from(p.y))).collect();
            r.dedup();
            if r.len() > 1 && r.first() == r.last() {
                r.pop();
            }
            if r.len() < 3 {
                continue;
            }
            let ccw = area2(&r) > 0;
            if ccw != (k == 0) {
                r.reverse();
            }
            out.push(r);
        }
    }
    out
}

fn area2(r: &[Pt]) -> i128 {
    let n = r.len();
    (0..n)
        .map(|i| {
            let (a, b) = (r[i], r[(i + 1) % n]);
            i128::from(a.0) * i128::from(b.1) - i128::from(b.0) * i128::from(a.1)
        })
        .sum()
}

#[allow(clippy::cast_possible_truncation, reason = "plate coordinates")]
fn unturn(p: &[Pt], deg: f64, center: [f64; 2]) -> Vec<Point> {
    let (sn, cs) = deg.to_radians().m_sin_cos();
    let (ox, oy) = (center[0] * SCALE, center[1] * SCALE);
    p.iter()
        .map(|&(x, y)| {
            #[allow(clippy::cast_precision_loss, reason = "plate coordinates")]
            let (dx, dy) = (x as f64 - ox, y as f64 - oy);
            Point::new(
                (ox + dx * cs - dy * sn).round() as i32,
                (oy + dx * sn + dy * cs).round() as i32,
            )
        })
        .collect()
}

/// Vertical lines `ls` apart on a lattice through `center`, from the source box's left `xs.0` to its right
/// `xs.1`, cut to the inside of `rings` (Orca's `make_fill_lines`).
fn vertical_lines(rings: &[Vec<Pt>], xs: [i64; 2], ls: f64, center: [f64; 2]) -> Vec<Vec<Pt>> {
    #[allow(clippy::cast_possible_truncation, reason = "a pitch in internal units")]
    let ls = (ls.round() as i64).max(1);
    #[allow(clippy::cast_possible_truncation, reason = "plate coordinates")]
    let refx = (center[0] * SCALE).round() as i64;
    let min = refx + (xs[0] - refx).div_euclid(ls) * ls;
    let mut out = Vec::new();
    let mut x = min;
    while x <= xs[1] {
        if x >= xs[0] {
            let mut ys: Vec<i64> = Vec::new();
            for r in rings {
                let n = r.len();
                for i in 0..n {
                    let (a, b) = (r[i], r[(i + 1) % n]);
                    if (a.0 < x) != (b.0 < x) {
                        #[allow(
                            clippy::cast_precision_loss,
                            clippy::cast_possible_truncation,
                            reason = "plate coordinates"
                        )]
                        let y = a.1 as f64 + (x - a.0) as f64 * (b.1 - a.1) as f64 / (b.0 - a.0) as f64;
                        #[allow(clippy::cast_possible_truncation, reason = "plate coordinates")]
                        ys.push(y.round() as i64);
                    }
                }
            }
            ys.sort_unstable();
            for pair in ys.chunks(2) {
                if let [lo, hi] = pair
                    && hi > lo
                {
                    out.push(vec![(x, *lo), (x, *hi)]);
                }
            }
        }
        x += ls;
    }
    out
}

/// A line end on an outline: Orca's `ContourIntersectionPoint`.
#[derive(Debug, Clone)]
struct Cp {
    contour: usize,
    point: usize,
    param: f64,
    prev: usize,
    next: usize,
    left_prev: f64,
    left_next: f64,
    consumed: bool,
    prev_trimmed: bool,
    next_trimmed: bool,
}

impl Cp {
    fn consume_prev(&mut self) {
        self.left_prev = 0.0;
        self.prev_trimmed = true;
        self.consumed = true;
    }
    fn consume_next(&mut self) {
        self.left_next = 0.0;
        self.next_trimmed = true;
        self.consumed = true;
    }
    fn trim_prev(&mut self, l: f64) {
        if l < self.left_prev {
            self.left_prev = l;
            self.prev_trimmed = true;
        }
    }
    fn trim_next(&mut self, l: f64) {
        if l < self.left_next {
            self.left_next = l;
            self.next_trimmed = true;
        }
    }
    fn could_take_prev(&self) -> bool {
        !self.consumed && self.left_prev > EPS
    }
    fn could_take_next(&self) -> bool {
        !self.consumed && self.left_next > EPS
    }
}

/// Orca's `SCALED_EPSILON`, in internal units.
const EPS: f64 = 1.0;

struct Graph {
    boundary: Vec<Vec<Pt>>,
    params: Vec<Vec<f64>>,
    cps: Vec<Cp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dir {
    Left,
    Right,
    Up,
    Down,
    Taken,
}

impl Graph {
    fn point(&self, i: usize) -> Pt {
        let c = &self.cps[i];
        self.boundary[c.contour][c.point]
    }
    fn dir(p1: Pt, p2: Pt) -> Dir {
        match p1.0.cmp(&p2.0) {
            std::cmp::Ordering::Equal if p1.1 < p2.1 => Dir::Up,
            std::cmp::Ordering::Equal => Dir::Down,
            std::cmp::Ordering::Less => Dir::Right,
            std::cmp::Ordering::Greater => Dir::Left,
        }
    }
    fn dir_prev(&self, i: usize) -> Dir {
        if self.cps[i].could_take_prev() {
            Self::dir(self.point(i), self.point(self.cps[i].prev))
        } else {
            Dir::Taken
        }
    }
    fn dir_next(&self, i: usize) -> Dir {
        if self.cps[i].could_take_next() {
            Self::dir(self.point(i), self.point(self.cps[i].next))
        } else {
            Dir::Taken
        }
    }
    fn len(&self, contour: usize) -> f64 {
        self.params[contour].last().copied().unwrap_or(0.0)
    }
}

fn ccw_dist(p1: f64, p2: f64, len: f64) -> f64 {
    let d = p2 - p1;
    if d < 0.0 { d + len } else { d }
}

fn cw_dist(p1: f64, p2: f64, len: f64) -> f64 {
    ccw_dist(p2, p1, len)
}

fn dist(a: Pt, b: Pt) -> f64 {
    #[allow(clippy::cast_precision_loss, reason = "plate coordinates")]
    ((b.0 - a.0) as f64).m_hypot((b.1 - a.1) as f64)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "plate coordinates"
)]
fn lerp(a: Pt, b: Pt, t: f64) -> Pt {
    (
        (a.0 as f64 + (b.0 - a.0) as f64 * t).round() as i64,
        (a.1 as f64 + (b.1 - a.1) as f64 * t).round() as i64,
    )
}

fn next_i(i: usize, n: usize) -> usize {
    if i + 1 == n { 0 } else { i + 1 }
}

fn prev_i(i: usize, n: usize) -> usize {
    if i == 0 { n - 1 } else { i - 1 }
}

fn take_cw_full(pl: &mut Vec<Pt>, contour: &[Pt], start: usize, end: usize) {
    let n = contour.len();
    let mut i = prev_i(start, n);
    while i != end {
        pl.push(contour[i]);
        i = prev_i(i, n);
    }
    pl.push(contour[i]);
}

fn take_ccw_full(pl: &mut Vec<Pt>, contour: &[Pt], start: usize, end: usize) {
    let n = contour.len();
    let mut i = next_i(start, n);
    while i != end {
        pl.push(contour[i]);
        i = next_i(i, n);
    }
    pl.push(contour[i]);
}

fn take_cw_limited(
    pl: &mut Vec<Pt>,
    contour: &[Pt],
    params: &[f64],
    start: usize,
    end: usize,
    take: f64,
) -> f64 {
    let n = contour.len();
    let length = params[n];
    let p0 = params[start];
    let mut i = prev_i(start, n);
    let (mut iprev, mut lprev) = (start, 0.0);
    loop {
        let l = cw_dist(p0, params[i], length);
        if l >= take {
            pl.push(lerp(contour[iprev], contour[i], (take - lprev) / (l - lprev)));
            return take;
        }
        pl.push(contour[i]);
        if i == end {
            return l;
        }
        iprev = i;
        lprev = l;
        i = prev_i(i, n);
    }
}

fn take_ccw_limited(
    pl: &mut Vec<Pt>,
    contour: &[Pt],
    params: &[f64],
    start: usize,
    end: usize,
    take: f64,
) -> f64 {
    let n = contour.len();
    let length = params[n];
    let p0 = params[start];
    let mut i = next_i(start, n);
    let (mut iprev, mut lprev) = (start, 0.0);
    loop {
        let l = ccw_dist(p0, params[i], length);
        if l >= take {
            pl.push(lerp(contour[iprev], contour[i], (take - lprev) / (l - lprev)));
            return take;
        }
        pl.push(contour[i]);
        if i == end {
            return l;
        }
        iprev = i;
        lprev = l;
        i = next_i(i, n);
    }
}

fn pl_length(pl: &[Pt]) -> f64 {
    pl.windows(2).map(|w| dist(w[0], w[1])).sum()
}

/// Orca's `Polyline::clip_end`.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "plate coordinates"
)]
fn clip_end(pl: &mut Vec<Pt>, mut d: f64) {
    while d > 0.0 {
        let Some(last) = pl.pop() else { return };
        let Some(&p) = pl.last() else { return };
        let l = dist(last, p);
        if l > d {
            let t = d / l;
            pl.push((
                (last.0 as f64 + (p.0 - last.0) as f64 * t).round() as i64,
                (last.1 as f64 + (p.1 - last.1) as f64 * t).round() as i64,
            ));
            return;
        }
        d -= l;
    }
}

fn clip_start(pl: &mut Vec<Pt>, d: f64) {
    pl.reverse();
    clip_end(pl, d);
    pl.reverse();
}

/// Builds the graph of line ends on the outlines (Orca's `create_boundary_infill_graph`): each end is added
/// to its outline as a point, the ends on an outline are chained in order, and the outline next to other
/// lines is masked.
fn build_graph(lines: &[Vec<Pt>], rings: &[Vec<Pt>], spacing: f64) -> Graph {
    // Each line end: the outline segment it lies on and where.
    let mut hits: Vec<(usize, usize, f64, usize)> = Vec::new();
    for (li, l) in lines.iter().enumerate() {
        for (k, &p) in [l[0], l[l.len() - 1]].iter().enumerate() {
            let mut best: Option<(f64, usize, usize, f64)> = None;
            for (ci, r) in rings.iter().enumerate() {
                let n = r.len();
                for s in 0..n {
                    let (a, b) = (r[s], r[(s + 1) % n]);
                    #[allow(clippy::cast_precision_loss, reason = "plate coordinates")]
                    let (vx, vy, wx, wy) = (
                        (b.0 - a.0) as f64,
                        (b.1 - a.1) as f64,
                        (p.0 - a.0) as f64,
                        (p.1 - a.1) as f64,
                    );
                    let l2 = vx * vx + vy * vy;
                    let t = if l2 > 0.0 {
                        ((wx * vx + wy * vy) / l2).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let d = (wx - t * vx).m_hypot(wy - t * vy);
                    if best.is_none_or(|bb| d < bb.0) {
                        best = Some((d, ci, s, t));
                    }
                }
            }
            if let Some((_, ci, s, t)) = best {
                hits.push((ci, s, t, li * 2 + k));
            }
        }
    }
    crate::sorting::sort_by(&mut hits, |a, b| {
        a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.total_cmp(&b.2))
    });
    let n_cp = lines.len() * 2;
    let mut cps: Vec<Cp> = vec![
        Cp {
            contour: usize::MAX,
            point: usize::MAX,
            param: 0.0,
            prev: usize::MAX,
            next: usize::MAX,
            left_prev: f64::MAX,
            left_next: f64::MAX,
            consumed: false,
            prev_trimmed: false,
            next_trimmed: false,
        };
        n_cp
    ];
    let mut boundary: Vec<Vec<Pt>> = Vec::with_capacity(rings.len());
    let mut params: Vec<Vec<f64>> = Vec::with_capacity(rings.len());
    let mut on_contour: Vec<Vec<usize>> = vec![Vec::new(); rings.len()];
    let mut it = 0;
    for (ci, src) in rings.iter().enumerate() {
        let mut dst: Vec<Pt> = Vec::with_capacity(src.len());
        let (mut first, mut prev): (Option<usize>, Option<usize>) = (None, None);
        for (pi, &ipt) in src.iter().enumerate() {
            if dst.last() != Some(&ipt) {
                dst.push(ipt);
            }
            while let Some(&(hc, hs, _, idx)) = hits.get(it).filter(|h| h.0 == ci && h.1 == pi) {
                let _ = (hc, hs);
                let line = &lines[idx / 2];
                let pt = if idx & 1 == 1 {
                    line[line.len() - 1]
                } else {
                    line[0]
                };
                let mut at = 0;
                if pi + 1 < src.len() || Some(&pt) != dst.first() {
                    if dst.last() != Some(&pt) {
                        dst.push(pt);
                    }
                    at = dst.len() - 1;
                }
                cps[idx].contour = ci;
                cps[idx].point = at;
                if let Some(p) = prev {
                    cps[p].next = idx;
                    cps[idx].prev = p;
                } else {
                    first = Some(idx);
                }
                on_contour[ci].push(idx);
                prev = Some(idx);
                it += 1;
            }
            if let (Some(f), Some(p)) = (first, prev) {
                cps[p].next = f;
                cps[f].prev = p;
            }
        }
        let n = dst.len();
        let mut pr = vec![0.0; n + 1];
        for i in 1..n {
            pr[i] = pr[i - 1] + dist(dst[i - 1], dst[i]);
        }
        if n > 0 {
            pr[n] = pr[n - 1] + dist(dst[n - 1], dst[0]);
        }
        let length = pr[n];
        for &c in &on_contour[ci] {
            cps[c].param = pr[cps[c].point];
        }
        for &c in &on_contour[ci] {
            if cps[c].next == c {
                cps[c].left_prev = length;
                cps[c].left_next = length;
            } else {
                cps[c].left_prev = ccw_dist(cps[cps[c].prev].param, cps[c].param, length);
                cps[c].left_next = ccw_dist(cps[c].param, cps[cps[c].next].param, length);
            }
        }
        boundary.push(dst);
        params.push(pr);
    }
    let mut g = Graph {
        boundary,
        params,
        cps,
    };
    mark_touching(&mut g, &on_contour, lines, 1.7 * spacing, 0.8 * spacing);
    g
}

/// The interval of segment `line_a`-`line_b` (lengths from `line_a`) within `offset` of segment
/// `seg_a`-`seg_b` (Orca's `line_rounded_thick_segment_collision`).
#[allow(clippy::cast_precision_loss, reason = "plate coordinates")]
fn thick_collision(line_a: Pt, line_b: Pt, seg_a: Pt, seg_b: Pt, offset: f64) -> Option<(f64, f64)> {
    let f = |p: Pt| (p.0 as f64, p.1 as f64);
    let (la, lb, sa, sb) = (f(line_a), f(line_b), f(seg_a), f(seg_b));
    let lv0 = (lb.0 - la.0, lb.1 - la.1);
    let lv = lv0.0 * lv0.0 + lv0.1 * lv0.1;
    let sv = (sb.0 - sa.0, sb.1 - sa.1);
    let sl = sv.0.m_hypot(sv.1);
    let off2 = offset * offset;
    if lv < EPS * EPS {
        let lpt = (f64::midpoint(la.0, lb.0), f64::midpoint(la.1, lb.1));
        let hit = if sl > EPS {
            seg_dist2(sa, sb, lpt) < off2
        } else {
            let m = (f64::midpoint(sa.0, sb.0), f64::midpoint(sa.1, sb.1));
            (m.0 - lpt.0).m_powi(2) + (m.1 - lpt.1).m_powi(2) < off2
        };
        return hit.then(|| (0.0, lv.sqrt()));
    }
    let (mut tmin, mut tmax) = (f64::MAX, -f64::MAX);
    let mut circle = |c: (f64, f64), r2: f64| {
        // Points of the line inside the circle around `c`.
        let p0 = (la.0 - c.0, la.1 - c.1);
        let a = lv;
        let b = 2.0 * (p0.0 * lv0.0 + p0.1 * lv0.1);
        let cc = p0.0 * p0.0 + p0.1 * p0.1 - r2;
        let disc = b * b - 4.0 * a * cc;
        if disc > 0.0 {
            let s = disc.sqrt();
            let (t1, t2) = (((-b - s) / (2.0 * a)).max(0.0), ((-b + s) / (2.0 * a)).min(1.0));
            if t1 <= t2 {
                tmin = tmin.min(t1);
                tmax = tmax.max(t2);
            }
        }
    };
    if sl > EPS {
        circle(sa, off2);
        circle(sb, off2);
        // The line in the frame of the segment, clipped to the box from (0, -offset) to (sl, offset).
        let dx = (sv.0 / sl, sv.1 / sl);
        let dy = (-dx.1, dx.0);
        let p = (la.0 - sa.0, la.1 - sa.1);
        let (px, py) = (p.0 * dx.0 + p.1 * dx.1, p.0 * dy.0 + p.1 * dy.1);
        let (vx, vy) = (lv0.0 * dx.0 + lv0.1 * dx.1, lv0.0 * dy.0 + lv0.1 * dy.1);
        if let Some((a, b)) = liang_barsky((px, py), (vx, vy), (0.0, -offset), (sl, offset)) {
            tmin = tmin.min(a);
            tmax = tmax.max(b);
        }
    } else {
        // Orca passes the radius here, not its square.
        circle((f64::midpoint(sa.0, sb.0), f64::midpoint(sa.1, sb.1)), offset);
    }
    if tmin <= tmax {
        let l = lv.sqrt();
        Some((tmin * l, tmax * l))
    } else {
        None
    }
}

fn seg_dist2(a: (f64, f64), b: (f64, f64), p: (f64, f64)) -> f64 {
    let v = (b.0 - a.0, b.1 - a.1);
    let w = (p.0 - a.0, p.1 - a.1);
    let l2 = v.0 * v.0 + v.1 * v.1;
    let t = if l2 > 0.0 {
        ((w.0 * v.0 + w.1 * v.1) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (w.0 - t * v.0).m_powi(2) + (w.1 - t * v.1).m_powi(2)
}

fn seg_dist(a: Pt, b: Pt, p: Pt) -> f64 {
    #[allow(clippy::cast_precision_loss, reason = "plate coordinates")]
    let f = |q: Pt| (q.0 as f64, q.1 as f64);
    seg_dist2(f(a), f(b), f(p)).sqrt()
}

/// The parameter interval within 0 to 1 of `p0 + t v` inside the box `lo`-`hi`.
fn liang_barsky(p0: (f64, f64), v: (f64, f64), lo: (f64, f64), hi: (f64, f64)) -> Option<(f64, f64)> {
    let (mut t0, mut t1) = (0.0_f64, 1.0_f64);
    for (p, q) in [
        (-v.0, p0.0 - lo.0),
        (v.0, hi.0 - p0.0),
        (-v.1, p0.1 - lo.1),
        (v.1, hi.1 - p0.1),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                if r > t1 {
                    return None;
                }
                t0 = t0.max(r);
            } else {
                if r < t0 {
                    return None;
                }
                t1 = t1.min(r);
            }
        }
    }
    Some((t0, t1))
}

/// Masks the outline next to each line, the line's ends clipped by `clip` (Orca's
/// `mark_boundary_segments_touching_infill`).
fn mark_touching(g: &mut Graph, on_contour: &[Vec<usize>], lines: &[Vec<Pt>], clip: f64, radius: f64) {
    for l in lines {
        let (a, b) = (l[0], l[l.len() - 1]);
        let len = dist(a, b);
        if len <= 2.0 * clip {
            continue;
        }
        let (p1, p2) = (lerp(a, b, clip / len), lerp(a, b, 1.0 - clip / len));
        let (bx0, bx1) = (
            p1.0.min(p2.0) as f64 - radius - EPS,
            p1.0.max(p2.0) as f64 + radius + EPS,
        );
        let (by0, by1) = (
            p1.1.min(p2.1) as f64 - radius - EPS,
            p1.1.max(p2.1) as f64 + radius + EPS,
        );
        for (ci, ips) in on_contour.iter().enumerate() {
            if ips.is_empty() {
                continue;
            }
            let n = g.boundary[ci].len();
            for s in 0..n {
                let (sa, sb) = (g.boundary[ci][s], g.boundary[ci][(s + 1) % n]);
                #[allow(clippy::cast_precision_loss, reason = "plate coordinates")]
                let overlap = (sa.0.max(sb.0) as f64) >= bx0
                    && (sa.0.min(sb.0) as f64) <= bx1
                    && (sa.1.max(sb.1) as f64) >= by0
                    && (sa.1.min(sb.1) as f64) <= by1;
                if !overlap {
                    continue;
                }
                let Some((i0, i1)) = thick_collision(sa, sb, p1, p2, radius) else {
                    continue;
                };
                let length = g.len(ci);
                let (ps1, ps2) = (g.params[ci][s], g.params[ci][s + 1]);
                let (o1, o2) = ((ps1 + i0).min(ps2), (ps1 + i1).min(ps2));
                let (lo, hi) = if ips.len() == 1 {
                    (ips[0], ips[0])
                } else {
                    let find = |v: f64| ips.iter().position(|&c| g.cps[c].param >= v);
                    let mut lo = find(o1).map_or(ips[0], |k| ips[k]);
                    let hi = find(o2).map_or(ips[0], |k| ips[k]);
                    if (g.cps[lo].param - o1).abs() > 0.0 {
                        lo = g.cps[lo].prev;
                    }
                    (lo, hi)
                };
                if g.cps[lo].next != hi {
                    let mut c = g.cps[lo].next;
                    while c != hi {
                        g.cps[c].consume_prev();
                        g.cps[c].consume_next();
                        c = g.cps[c].next;
                    }
                }
                let tl = ccw_dist(g.cps[lo].param, o1, length);
                g.cps[lo].trim_next(tl);
                let th = ccw_dist(o2, g.cps[hi].param, length);
                g.cps[hi].trim_prev(th);
            }
        }
    }
}

/// Masks short arches that lie along the line they start from (Orca's
/// `mark_boundary_segments_overlapping_infill`).
fn mark_overlapping(g: &mut Graph, lines: &[Vec<Pt>], spacing: f64) {
    let radius = f64::midpoint(spacing, EPS);
    for i in 0..g.cps.len() {
        let line = &lines[i / 2];
        let (la, lb) = (line[0], line[line.len() - 1]);
        let ci = g.cps[i].contour;
        let contour = g.boundary[ci].clone();
        let params = g.params[ci].clone();
        let n = contour.len();
        let length = params[n];
        let start = g.cps[i].point;
        if g.cps[i].could_take_next() {
            let mut inside = true;
            let end = g.cps[g.cps[i].next].point;
            let mut s = start;
            while s != end {
                let j = next_i(s, n);
                if seg_dist(la, lb, contour[j]) >= radius {
                    if let Some((_, hi)) = thick_collision(contour[s], contour[j], la, lb, radius) {
                        let out = ccw_dist(params[start], params[s], length) + hi;
                        if out < g.cps[i].left_next {
                            inside = false;
                            break;
                        }
                    } else {
                        // No overlap at all: this piece of outline is free.
                        inside = false;
                        break;
                    }
                }
                if ccw_dist(params[start], params[j], length) >= g.cps[i].left_next {
                    break;
                }
                s = j;
            }
            if inside {
                if !g.cps[i].next_trimmed {
                    let nx = g.cps[i].next;
                    g.cps[nx].trim_prev(0.0);
                }
                g.cps[i].trim_next(0.0);
            }
        } else {
            g.cps[i].trim_next(0.0);
        }
        if g.cps[i].could_take_prev() {
            let mut inside = true;
            let end = g.cps[g.cps[i].prev].point;
            let mut s = start;
            while s != end {
                let j = prev_i(s, n);
                if seg_dist(la, lb, contour[j]) >= radius {
                    if let Some((_, hi)) = thick_collision(contour[s], contour[j], la, lb, radius) {
                        let out = cw_dist(params[start], params[s], length) + hi;
                        if out < g.cps[i].left_prev {
                            inside = false;
                            break;
                        }
                    } else {
                        inside = false;
                        break;
                    }
                }
                if cw_dist(params[start], params[j], length) >= g.cps[i].left_prev {
                    break;
                }
                s = j;
            }
            if inside {
                if !g.cps[i].prev_trimmed {
                    let pv = g.cps[i].prev;
                    g.cps[pv].trim_next(0.0);
                }
                g.cps[i].trim_prev(0.0);
            }
        } else {
            g.cps[i].trim_prev(0.0);
        }
    }
}

/// Lets a line end slide along a nearly vertical outline to continue the line (Orca's
/// `base_support_extend_infill_lines`).
fn extend_lines(lines: &mut [Vec<Pt>], g: &mut Graph, line_spacing: f64) {
    #[allow(clippy::cast_possible_truncation, reason = "a distance in internal units")]
    let (max_x, min_y) = ((line_spacing * 0.33) as i64, (line_spacing * 0.5) as i64);
    for c in 0..g.cps.len() {
        let ci = g.cps[c].contour;
        let n = g.boundary[ci].len();
        let length = g.len(ci);
        let pt = g.boundary[ci][g.cps[c].point];
        let first = c & 1 == 0;
        let (mut ext_next, mut ext_prev): (Option<usize>, Option<usize>) = (None, None);
        let (mut arc_next, mut arc_prev) = (0.0, 0.0);
        let next_pt = g.point(g.cps[c].next);
        if pt.0 != next_pt.0 {
            let mut i = g.cps[c].point;
            let mut j = next_i(i, n);
            while j != g.cps[g.cps[c].next].point {
                if (g.boundary[ci][j].0 - pt.0).abs() > max_x {
                    break;
                }
                i = j;
                j = next_i(j, n);
            }
            if i != g.cps[c].point {
                let mut dy = g.boundary[ci][i].1 - pt.1;
                if first {
                    dy = -dy;
                }
                if dy > min_y {
                    let a = ccw_dist(g.params[ci][g.cps[c].point], g.params[ci][i], length);
                    if a < g.cps[c].left_next {
                        ext_next = Some(i);
                        arc_next = a;
                    }
                }
            }
        }
        let prev_pt = g.point(g.cps[c].prev);
        if pt.0 != prev_pt.0 {
            let mut i = g.cps[c].point;
            let mut j = prev_i(i, n);
            while j != g.cps[g.cps[c].prev].point {
                if (g.boundary[ci][j].0 - pt.0).abs() > max_x {
                    break;
                }
                i = j;
                j = prev_i(j, n);
            }
            if i != g.cps[c].point {
                let mut dy = g.boundary[ci][i].1 - pt.1;
                if first {
                    dy = -dy;
                }
                if dy > min_y {
                    let a = ccw_dist(g.params[ci][i], g.params[ci][g.cps[c].point], length);
                    if a < g.cps[c].left_prev {
                        ext_prev = Some(i);
                        arc_prev = a;
                    }
                }
            }
        }
        // Orca keeps the previous side when both qualify.
        if ext_prev.is_some() {
            ext_next = None;
        }
        let line = &mut lines[c / 2];
        if let Some(e) = ext_prev {
            if first {
                line.reverse();
            }
            take_cw_full(line, &g.boundary[ci], g.cps[c].point, e);
            if first {
                line.reverse();
            }
            g.cps[c].point = e;
            if g.cps[c].prev_trimmed {
                g.cps[c].left_prev -= arc_prev;
            } else {
                let pv = g.cps[c].prev;
                let l = ccw_dist(g.params[ci][g.cps[pv].point], g.params[ci][e], length);
                g.cps[c].left_prev = l;
                g.cps[pv].left_next = l;
            }
            g.cps[c].trim_next(0.0);
            let nx = g.cps[c].next;
            g.cps[nx].prev_trimmed = true;
        } else if let Some(e) = ext_next {
            if first {
                line.reverse();
            }
            take_ccw_full(line, &g.boundary[ci], g.cps[c].point, e);
            if first {
                line.reverse();
            }
            g.cps[c].point = e;
            g.cps[c].trim_prev(0.0);
            let pv = g.cps[c].prev;
            g.cps[pv].next_trimmed = true;
            if g.cps[c].next_trimmed {
                g.cps[c].left_next -= arc_next;
            } else {
                let nx = g.cps[c].next;
                let l = ccw_dist(g.params[ci][e], g.params[ci][g.cps[nx].point], length);
                g.cps[c].left_next = l;
                g.cps[nx].left_prev = l;
            }
        }
    }
}

/// The outline from `tbegin` to `tend` (arc parameters) kept inside the vertical band `left`-`right`,
/// pieces longer than `min_length` (Orca's `emit_loops_in_band`).
#[allow(clippy::too_many_arguments, reason = "one band's inputs")]
fn emit_loops_in_band(
    left: i64,
    right: i64,
    contour: &[Pt],
    params: &[f64],
    tbegin: f64,
    tend: f64,
    min_length: f64,
    out: &mut Vec<Vec<Pt>>,
) {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Side {
        Left,
        Right,
        Mid,
        Unknown,
    }
    let n = contour.len();
    let lb = |t: f64| params.partition_point(|&p| p < t);
    let mut ib = lb(tbegin);
    // Orca steps back unless the parameter is exactly on a point.
    #[allow(clippy::float_cmp, reason = "an exact match, as in Orca")]
    let exact = params.get(ib).is_some_and(|&p| p == tbegin);
    if ib < params.len() && !exact && ib > 0 {
        ib -= 1;
    }
    let mut ie = lb(tend);
    if ib == n {
        ib = 0;
    }
    if ie >= n {
        ie = 0;
    }
    if ib == ie {
        return;
    }
    let pbegin = {
        let (t1, t2) = (params[ib], params[ib + 1]);
        lerp(contour[ib], contour[next_i(ib, n)], (tbegin - t1) / (t2 - t1))
    };
    let pend = {
        let t1 = params[ie];
        let t2 = if ie == 0 { params[n] } else { params[ie - 1] };
        lerp(contour[ie], contour[prev_i(ie, n)], (tend - t1) / (t2 - t1))
    };
    let side = |p: Pt| {
        if p.0 < left {
            Side::Left
        } else if p.0 > right {
            Side::Right
        } else {
            Side::Mid
        }
    };
    let mut poly: Vec<Pt> = Vec::new();
    let mut end_mark: usize = 0;
    let finalize = |poly: &mut Vec<Pt>, end_mark: usize, out: &mut Vec<Vec<Pt>>| {
        // Orca drops everything from the last split on, which is all of it when there was none.
        poly.truncate(end_mark);
        if !poly.is_empty() {
            let joins = out.last().and_then(|l| l.last()).is_some_and(|&b| {
                let (dx, dy) = (b.0 - poly[0].0, b.1 - poly[0].1);
                (dx * dx + dy * dy) < 1
            });
            if joins {
                if let Some(l) = out.last_mut() {
                    l.extend(poly.iter().skip(1).copied());
                }
            } else if pl_length(poly) > min_length {
                out.push(poly.clone());
            }
            poly.clear();
        }
    };
    let interp = |p1: Pt, p2: Pt, s: Side| -> Pt {
        let x = if s == Side::Left { left } else { right };
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_precision_loss,
            reason = "plate coordinates"
        )]
        let y = p1.1 + ((x - p1.0) as f64 * (p2.1 - p1.1) as f64 / (p2.0 - p1.0) as f64) as i64;
        (x, y)
    };
    let mut p1 = pbegin;
    let mut side1 = side(p1);
    let mut side2 = Side::Unknown;
    let _ = side2;
    if side1 == Side::Mid {
        poly.push(p1);
    }
    let mut i = ib;
    while i != ie {
        let inext = next_i(i, n);
        let p2 = if inext == ie { pend } else { contour[inext] };
        side2 = side(p2);
        let leaving = |poly: &mut Vec<Pt>, end_mark: &mut usize, pt: Pt| {
            *end_mark = poly.len();
            poly.push(pt);
        };
        let entering =
            |poly: &mut Vec<Pt>, end_mark: &mut usize, pt: Pt, side1: Side, out: &mut Vec<Vec<Pt>>| {
                if *end_mark > 0 {
                    if (side1 == Side::Left) == (pt.1 - poly[*end_mark].1 < 0) {
                        poly.remove(*end_mark);
                    } else {
                        finalize(poly, *end_mark, out);
                        poly.push(pt);
                    }
                    *end_mark = 0;
                } else {
                    poly.push(pt);
                }
            };
        if side1 == Side::Mid {
            if side2 == Side::Mid {
                poly.push(p2);
            } else {
                leaving(&mut poly, &mut end_mark, interp(p1, p2, side2));
                if end_mark > 0 {
                    poly.push(p2);
                }
            }
        } else if side2 == Side::Mid {
            entering(&mut poly, &mut end_mark, interp(p1, p2, side1), side1, out);
            poly.push(p2);
        } else if side1 != side2 {
            entering(&mut poly, &mut end_mark, interp(p1, p2, side1), side1, out);
            leaving(&mut poly, &mut end_mark, interp(p1, p2, side2));
        } else if end_mark > 0 {
            poly.push(p2);
        }
        side1 = side2;
        p1 = p2;
        i = inext;
    }
    finalize(&mut poly, end_mark, out);
}

/// How far an arch leaves the band between its ends (Orca's `evaluate_support_arch_cost`).
fn arch_cost(pl: &[Pt]) -> f64 {
    let (front, back) = (pl[0], pl[pl.len() - 1]);
    let (ymin, ymax) = (front.1.min(back.1), front.1.max(back.1));
    let mut d = 0.0_f64;
    for &p in pl {
        #[allow(clippy::cast_precision_loss, reason = "plate coordinates")]
        let out = ((p.1 - ymax).max(ymin - p.1)) as f64;
        d = d.max(seg_dist(front, back, p)).max(out);
    }
    d
}

#[derive(Clone, Copy, Default)]
struct ArcCost {
    self_loop: bool,
    cost: f64,
}

fn evaluate_arches(g: &Graph) -> Vec<ArcCost> {
    let mut arches = vec![ArcCost::default(); g.cps.len() * 2];
    for c in 0..g.cps.len() {
        let other = c ^ 1;
        let cp = &g.cps[c];
        let ci = cp.contour;
        arches[c * 2].self_loop = cp.prev == other;
        arches[c * 2 + 1].self_loop = cp.next == other;
        if cp.left_next > EPS {
            let mut pl = vec![g.point(c)];
            if cp.next_trimmed {
                take_ccw_limited(
                    &mut pl,
                    &g.boundary[ci],
                    &g.params[ci],
                    cp.point,
                    g.cps[cp.next].point,
                    cp.left_next,
                );
            } else {
                take_ccw_full(&mut pl, &g.boundary[ci], cp.point, g.cps[cp.next].point);
            }
            arches[c * 2 + 1].cost = arch_cost(&pl);
        }
        if cp.left_prev > EPS {
            let mut pl = vec![g.point(c)];
            if cp.prev_trimmed {
                take_cw_limited(
                    &mut pl,
                    &g.boundary[ci],
                    &g.params[ci],
                    cp.point,
                    g.cps[cp.prev].point,
                    cp.left_prev,
                );
            } else {
                take_cw_full(&mut pl, &g.boundary[ci], cp.point, g.cps[cp.prev].point);
            }
            arches[c * 2].cost = arch_cost(&pl);
        }
    }
    arches
}

/// Orca's `take_limited`: extends `pl` from `start` along the outline toward `end`, as far as it is free.
#[allow(clippy::too_many_arguments, reason = "one step's inputs")]
fn take_limited(
    pl: &mut Vec<Pt>,
    g: &mut Graph,
    start: usize,
    end: usize,
    clockwise: bool,
    max_len: f64,
    lhw: f64,
) {
    let ok = if clockwise {
        g.cps[start].could_take_prev()
    } else {
        g.cps[start].could_take_next()
    };
    if !ok {
        return;
    }
    let ci = g.cps[start].contour;
    let contour = g.boundary[ci].clone();
    let params = g.params[ci].clone();
    let start_pt = contour[g.cps[start].point];
    let at_start = pl.first() == Some(&start_pt);
    let mut tmp: Vec<Pt> = Vec::new();
    if at_start {
        tmp = std::mem::take(pl);
    }
    let length = params[contour.len()];
    let mut to_go = max_len;
    g.cps[start].consumed = true;
    if start == end {
        to_go = (to_go.min(length - lhw)).max(0.0);
        to_go = to_go.min(if clockwise {
            g.cps[start].left_prev
        } else {
            g.cps[start].left_next
        });
        g.cps[start].consume_prev();
        g.cps[start].consume_next();
        if to_go > EPS {
            let p = g.cps[start].point;
            if clockwise {
                take_cw_limited(pl, &contour, &params, p, p, to_go);
            } else {
                take_ccw_limited(pl, &contour, &params, p, p, to_go);
            }
        }
    } else if clockwise {
        let mut cp = start;
        while cp != end {
            let pv = g.cps[cp].prev;
            let l = cw_dist(g.cps[cp].param, g.cps[pv].param, length);
            to_go = to_go.min(g.cps[cp].left_prev);
            to_go = (to_go.min(l - lhw)).max(0.0);
            g.cps[cp].consume_prev();
            if l >= to_go {
                if to_go > EPS {
                    g.cps[pv].trim_next(l - to_go);
                    take_cw_limited(pl, &contour, &params, g.cps[cp].point, g.cps[pv].point, to_go);
                }
                break;
            }
            g.cps[pv].trim_next(0.0);
            take_cw_full(pl, &contour, g.cps[cp].point, g.cps[pv].point);
            to_go -= l;
            cp = pv;
        }
    } else {
        let mut cp = start;
        while cp != end {
            let nx = g.cps[cp].next;
            let l = ccw_dist(g.cps[cp].param, g.cps[nx].param, length);
            to_go = to_go.min(g.cps[cp].left_next);
            to_go = (to_go.min(l - lhw)).max(0.0);
            g.cps[cp].consume_next();
            if l >= to_go {
                if to_go > EPS {
                    g.cps[nx].trim_prev(l - to_go);
                    take_ccw_limited(pl, &contour, &params, g.cps[cp].point, g.cps[nx].point, to_go);
                }
                break;
            }
            g.cps[nx].trim_prev(0.0);
            take_ccw_full(pl, &contour, g.cps[cp].point, g.cps[nx].point);
            to_go -= l;
            cp = nx;
        }
    }
    if at_start {
        pl.reverse();
        pl.extend(tmp);
    }
}

/// Joins `pl1` (ending at `a`) through the outline counterclockwise to `pl2` (starting at `b`), and marks
/// the outline between them as used (Orca's `take` with contour points).
fn take(pl1: &mut Vec<Pt>, pl2: &[Pt], g: &mut Graph, a: usize, b: usize) {
    let ci = g.cps[a].contour;
    take_ccw_full(pl1, &g.boundary[ci], g.cps[a].point, g.cps[b].point);
    pl1.extend(pl2.iter().skip(1).copied());
    if g.cps[a].next != b {
        let mut c = g.cps[a].next;
        while g.cps[c].next != b {
            g.cps[c].consume_prev();
            g.cps[c].consume_next();
            c = g.cps[c].next;
        }
    }
    g.cps[a].consume_next();
    g.cps[b].consume_prev();
}

/// The line `cp`'s end belongs to after merges (Orca's `get_and_update_merged_with`).
fn root(merged: &mut [usize], cp: usize) -> usize {
    let idx = cp / 2;
    let mut last = idx;
    loop {
        let lower = merged[last];
        if lower == last {
            merged[idx] = last;
            return last;
        }
        last = lower;
    }
}

/// Orca's `Fill::connect_base_support` for vertical `lines` inside `rings`.
#[allow(clippy::too_many_lines, reason = "one algorithm, in Orca's order")]
fn connect(mut lines: Vec<Vec<Pt>>, rings: &[Vec<Pt>], spacing: f64, density: f64) -> Vec<Vec<Pt>> {
    let mut out: Vec<Vec<Pt>> = Vec::new();
    let mut g = build_graph(&lines, rings, spacing);
    let lhw = 0.5 * spacing;
    let line_spacing = spacing / density;
    let min_arch = 1.3 * line_spacing;
    let trim_length = lhw * 0.3;
    mark_overlapping(&mut g, &lines, spacing);

    // Outlines no line touches print as loops.
    let mut count = vec![0_usize; g.boundary.len()];
    for cp in &g.cps {
        if cp.contour < count.len() {
            count[cp.contour] += 1;
        }
    }
    for (ci, &k) in count.iter().enumerate() {
        if k == 0 && g.len(ci) > trim_length + 0.5 * line_spacing {
            let mut pl = g.boundary[ci].clone();
            pl.push(pl[0]);
            clip_end(&mut pl, trim_length);
            if pl.len() > 1 {
                out.push(pl);
            }
        }
    }
    if g.cps.is_empty() {
        return out;
    }

    // Arches trimmed by lines on both sides: their free middle, inside the band next to the line.
    for c in 0..g.cps.len() {
        let nx = g.cps[c].next;
        if g.cps[c].next_trimmed && g.cps[nx].prev_trimmed {
            let first = c & 1 == 0;
            let x = g.point(c).0;
            #[allow(clippy::cast_possible_truncation, reason = "a distance in internal units")]
            let (lhw_i, ls_i) = (lhw as i64, line_spacing as i64);
            let (left, right) = if first {
                (x + lhw_i, x + ls_i - lhw_i)
            } else {
                (x - (ls_i - lhw_i), x - lhw_i)
            };
            let ci = g.cps[c].contour;
            let length = g.len(ci);
            let mut ps = g.cps[c].param + g.cps[c].left_next;
            let mut pe = g.cps[nx].param - g.cps[nx].left_prev;
            if ps >= length {
                ps -= length;
            }
            if pe < 0.0 {
                pe += length;
            }
            if left < right {
                emit_loops_in_band(
                    left,
                    right,
                    &g.boundary[ci],
                    &g.params[ci],
                    ps,
                    pe,
                    0.5 * line_spacing,
                    &mut out,
                );
            }
        }
    }

    extend_lines(&mut lines, &mut g, line_spacing);

    let mut merged: Vec<usize> = (0..lines.len()).collect();
    let vertical = |d: Dir| d == Dir::Up || d == Dir::Down;

    // Joins the line at `c` (take_first) or at its next end through the arch between them.
    let take_next =
        |c: usize, take_first: bool, g: &mut Graph, lines: &mut Vec<Vec<Pt>>, merged: &mut Vec<usize>| {
            let (c1, c2) = (c, g.cps[c].next);
            if if take_first {
                g.cps[c1].consumed
            } else {
                g.cps[c2].consumed
            } {
                return;
            }
            let (p1, p2) = (root(merged, c1), root(merged, c2));
            let ci = g.cps[c1].contour;
            let mut trimmed = if take_first {
                g.cps[c1].next_trimmed
            } else {
                g.cps[c2].prev_trimmed
            };
            if !trimmed {
                trimmed = c1 == c2
                    || p1 == p2
                    || if take_first {
                        g.cps[c2].consumed
                    } else {
                        g.cps[c1].consumed
                    };
                if !trimmed {
                    trimmed = c2 == (c1 ^ 1);
                }
                if trimmed {
                    let length = g.len(ci);
                    let len = if c1 == c2 {
                        length
                    } else {
                        ccw_dist(g.cps[c1].param, g.cps[c2].param, length)
                    };
                    if take_first {
                        g.cps[c1].trim_next((len - trim_length - EPS).max(0.0));
                        g.cps[c2].trim_prev(0.0);
                    } else {
                        g.cps[c1].trim_next(0.0);
                        g.cps[c2].trim_prev((len - trim_length - EPS).max(0.0));
                    }
                }
            }
            if trimmed {
                if take_first {
                    let mut pl = std::mem::take(&mut lines[p1]);
                    take_limited(&mut pl, g, c1, c2, false, 1e10, lhw);
                    lines[p1] = pl;
                } else {
                    let mut pl = std::mem::take(&mut lines[p2]);
                    take_limited(&mut pl, g, c2, c1, true, 1e10, lhw);
                    lines[p2] = pl;
                }
            } else if !g.cps[c1].consumed && !g.cps[c2].consumed {
                let a = g.boundary[ci][g.cps[c1].point];
                let b = g.boundary[ci][g.cps[c2].point];
                if lines[p1].first() == Some(&a) {
                    lines[p1].reverse();
                }
                if lines[p2].last() == Some(&b) {
                    lines[p2].reverse();
                }
                let pl2 = lines[p2].clone();
                let mut pl1 = std::mem::take(&mut lines[p1]);
                take(&mut pl1, &pl2, g, c1, c2);
                if p2 < p1 {
                    lines[p2] = pl1;
                    lines[p1] = Vec::new();
                    merged[p1] = merged[p2];
                } else {
                    lines[p1] = pl1;
                    lines[p2] = Vec::new();
                    merged[p2] = merged[p1];
                }
            }
        };

    // Vertical arches first.
    for c in 0..g.cps.len() {
        if g.cps[c].consumed {
            continue;
        }
        let other = c ^ 1;
        let (dp, dn) = (g.dir_prev(c), g.dir_next(c));
        let (pv, nx) = (g.cps[c].prev, g.cps[c].next);
        let can_prev = vertical(dp) && !g.cps[pv].consumed && pv != other;
        let can_next = vertical(dn) && !g.cps[nx].consumed && nx != other;
        let take_prev = {
            let cp = &g.cps[c];
            if cp.prev_trimmed == cp.next_trimmed {
                cp.left_prev > cp.left_next
            } else {
                !cp.prev_trimmed && cp.next_trimmed
            }
        };
        if can_prev && (!can_next || take_prev) {
            if !g.cps[c].prev_trimmed || g.cps[c].left_prev > min_arch {
                take_next(pv, false, &mut g, &mut lines, &mut merged);
            }
        } else if can_next && (!g.cps[c].next_trimmed || g.cps[c].left_next > min_arch) {
            take_next(c, true, &mut g, &mut lines, &mut merged);
        }
    }

    let arches = evaluate_arches(&g);
    let (cost_low, cost_high, cost_veryhigh) = (line_spacing * 1.3, line_spacing * 2.0, line_spacing * 3.0);
    {
        let mut selected: Vec<usize> = Vec::new();
        for c in 0..g.cps.len() {
            if g.cps[c].consumed {
                continue;
            }
            let (cp_, cn) = (arches[c * 2].cost, arches[c * 2 + 1].cost);
            let (lo, hi) = (cp_.min(cn), cp_.max(cn));
            if hi < cost_low || lo > cost_high {
                continue;
            }
            if (hi - lo) / hi < 0.25 {
                continue;
            }
            if cp_ > cost_low {
                selected.push(c * 2);
            }
            if cn > cost_low {
                selected.push(c * 2 + 1);
            }
        }
        crate::sorting::sort_by(&mut selected, |a, b| arches[*b].cost.total_cmp(&arches[*a].cost));
        for a in selected {
            let c = a / 2;
            if !g.cps[c].consumed {
                if a & 1 == 0 {
                    let pv = g.cps[c].prev;
                    take_next(pv, false, &mut g, &mut lines, &mut merged);
                } else {
                    take_next(c, true, &mut g, &mut lines, &mut merged);
                }
            }
        }
    }

    // Zig-zag through the lines left over.
    for c in 0..g.cps.len() {
        if g.cps[c].consumed {
            continue;
        }
        if c & 1 == 0 {
            let nx = g.cps[c].next;
            if root(&mut merged, c) != root(&mut merged, nx) {
                take_next(c, true, &mut g, &mut lines, &mut merged);
            }
        } else {
            let pv = g.cps[c].prev;
            if root(&mut merged, c) != root(&mut merged, pv) {
                take_next(pv, false, &mut g, &mut lines, &mut merged);
            }
        }
    }

    // End caps.
    for c in 0..g.cps.len() {
        let other = c ^ 1;
        let loop_next = g.cps[c].next == other;
        let loop_prev = g.cps[other].next == c;
        if loop_prev && g.cps[c].could_take_prev() {
            let pv = g.cps[c].prev;
            take_next(pv, false, &mut g, &mut lines, &mut merged);
        }
        if loop_next && g.cps[c].could_take_next() {
            take_next(c, true, &mut g, &mut lines, &mut merged);
        }
    }

    // T joints along long arches.
    {
        let mut cand: Vec<usize> = Vec::new();
        for c in 0..g.cps.len() {
            if g.cps[c].could_take_prev() {
                cand.push(c * 2);
            }
            if g.cps[c].could_take_next() {
                cand.push(c * 2 + 1);
            }
        }
        crate::sorting::sort_by(&mut cand, |a, b| arches[*b].cost.total_cmp(&arches[*a].cost));
        for a in cand {
            let c = a / 2;
            if a & 1 == 0 {
                let pv = g.cps[c].prev;
                if g.cps[c].could_take_prev()
                    && (root(&mut merged, c) != root(&mut merged, pv) || arches[a].cost > cost_high)
                {
                    take_next(pv, false, &mut g, &mut lines, &mut merged);
                }
            } else {
                let nx = g.cps[c].next;
                if g.cps[c].could_take_next()
                    && (root(&mut merged, c) != root(&mut merged, nx) || arches[a].cost > cost_high)
                {
                    take_next(c, true, &mut g, &mut lines, &mut merged);
                }
            }
        }
    }

    // Very long arches and reasonably long caps, even where their ends were used.
    let cap_cost = 0.5 * line_spacing;
    for c in 0..g.cps.len() {
        let (ap, an) = (arches[c * 2], arches[c * 2 + 1]);
        let ci = g.cps[c].contour;
        if g.cps[c].left_prev > EPS
            && if ap.self_loop {
                ap.cost > cap_cost
            } else {
                ap.cost > cost_veryhigh
            }
        {
            let mut pl = vec![g.point(c)];
            if !g.cps[c].prev_trimmed {
                let l = g.cps[c].left_prev - lhw;
                g.cps[c].trim_prev(l);
                let pv = g.cps[c].prev;
                g.cps[pv].trim_next(0.0);
            }
            if g.cps[c].left_prev > EPS {
                let pv = g.cps[c].prev;
                take_cw_limited(
                    &mut pl,
                    &g.boundary[ci],
                    &g.params[ci],
                    g.cps[c].point,
                    g.cps[pv].point,
                    g.cps[c].left_prev,
                );
                g.cps[c].trim_prev(0.0);
                clip_start(&mut pl, lhw);
                out.push(pl);
            }
        }
        if g.cps[c].left_next > EPS
            && if an.self_loop {
                an.cost > cap_cost
            } else {
                an.cost > cost_veryhigh
            }
        {
            let mut pl = vec![g.point(c)];
            if !g.cps[c].next_trimmed {
                let l = g.cps[c].left_next - lhw;
                g.cps[c].trim_next(l);
                let nx = g.cps[c].next;
                g.cps[nx].trim_prev(0.0);
            }
            if g.cps[c].left_next > EPS {
                let nx = g.cps[c].next;
                take_ccw_limited(
                    &mut pl,
                    &g.boundary[ci],
                    &g.params[ci],
                    g.cps[c].point,
                    g.cps[nx].point,
                    g.cps[c].left_next,
                );
                g.cps[c].trim_next(0.0);
                clip_start(&mut pl, lhw);
                out.push(pl);
            }
        }
    }

    out.extend(lines.into_iter().filter(|l| !l.is_empty()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use i_overlay::i_float::int::point::IntPoint;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        let p = |x: f64, y: f64| IntPoint::new(crate::geom::mm(x), crate::geom::mm(y));
        vec![vec![vec![p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]]]
    }

    fn total(paths: &[Vec<Point>]) -> f64 {
        paths
            .iter()
            .flat_map(|p| p.windows(2))
            .map(|w| f64::from(w[1].x - w[0].x).m_hypot(f64::from(w[1].y - w[0].y)) / SCALE)
            .sum()
    }

    #[test]
    fn a_rectangle_fills_with_joined_rows() {
        // 20 by 10 mm at 2.877 mm pitch: rows along x across 10 mm, joined at the ends into a zig-zag.
        let paths = support_base(
            &rect(100.0, 100.0, 120.0, 110.0),
            0.377,
            0.377 / 2.877,
            0.0,
            [110.0, 105.0],
        );
        assert!(!paths.is_empty());
        let len = total(&paths);
        // Rows at 102.1, 105 and 107.9 mm and the long edges of the area, joined along the short sides.
        for p in &paths {
            eprintln!(
                "{:?}",
                p.iter()
                    .map(|q| (f64::from(q.x) / SCALE, f64::from(q.y) / SCALE))
                    .collect::<Vec<_>>()
            );
        }
        assert!(len > 5.0 * 19.0 && len < 5.0 * 19.7 + 2.0 * 9.7 + 0.5, "{len}");
        let a_hole = {
            let outer = rect(100.0, 100.0, 120.0, 120.0);
            let hole = rect(108.0, 108.0, 112.0, 112.0);
            crate::perimeters::difference(&outer, &hole)
        };
        let with_hole = support_base(&a_hole, 0.377, 0.377 / 2.877, 0.0, [110.0, 110.0]);
        assert!(total(&with_hole) > 0.0);
    }
}

#[cfg(test)]
mod circle_tests {
    use super::*;
    use i_overlay::i_float::int::point::IntPoint;

    #[test]
    fn print_circle_fill() {
        let ring: Vec<IntPoint<i32>> = (0..100)
            .map(|k| {
                let a = std::f64::consts::TAU * f64::from(k) / 100.0;
                IntPoint::new(
                    crate::geom::mm(100.0 + 5.0 * a.m_cos()),
                    crate::geom::mm(100.0 + 5.0 * a.m_sin()),
                )
            })
            .collect();
        let paths = support_base(&vec![vec![ring]], 0.377, 0.377 / 2.877, 0.0, [100.0, 100.0]);
        for p in &paths {
            let l: f64 = p
                .windows(2)
                .map(|w| f64::from(w[1].x - w[0].x).m_hypot(f64::from(w[1].y - w[0].y)) / SCALE)
                .sum();
            eprintln!(
                "len {l:.2} pts {} from {:?} to {:?}",
                p.len(),
                p.first(),
                p.last()
            );
        }
    }
}
