// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Floating vertical shell, on Bambu Lab printers: a narrow piece of internal solid infill (no 6 mm circle fits,
//! `narrow::split_pieces`) that rests partly on the sparse infill of the layer below. The band a sloped wall leaves
//! under its top shells is the usual one: each layer's band sits a little further in than the one below, so its
//! inner edge lies over sparse infill.
//!
//! - Which pieces: one that overlaps the lower layer's unsupported area (the sparse infill areas of every region
//!   of the layer below, empty ones at 0% density included) is a floating vertical shell; the other narrow pieces
//!   stay internal solid infill. Each piece is decided on its own.
//! - How: concentric variable-width beads, like the other narrow pieces. A bead that encloses another prints
//!   first, otherwise the nearest next. The first closed bead starts where its longest supported run starts
//!   (supported: not over the unsupported area, or on the lower layer's sparse lines); each later closed bead
//!   starts at the supported point nearest the nozzle.
//! - Band: the beads fill the piece from the inner wall's spacing edge, without `infill_wall_overlap` into the wall,
//!   to [`reach`] past its edge over the sparse infill. A ring that rests wholly on the sparse infill below (under
//!   the top shells beside a vertical wall) keeps its edge there.
//! - Speed: `vertical_shell_speed` (mm/s, or a percent of `internal_solid_infill_speed`, 80% by default). With
//!   `detect_floating_vertical_shell` on, the parts of a bead over the unsupported area print at `bridge_speed`
//!   (or the printing filament's `filament_bridge_speed` when its `override_process_overhang_speed` is on),
//!   between `; Slow Down Start` and `; Slow Down End` lines. Supported gaps under 2 mm between two such parts
//!   are slowed too, then slowed parts under 2 mm are not; a bead that crosses itself is not slowed at all.
//! - It prints with the region's internal solid infill filament, and the preview and the reports count it as
//!   internal solid infill. The G-code names it `Floating vertical shell`.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "plate coordinates in internal units and lengths along a bead in mm"
)]

use crate::arachne::WallLine;
use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::geom::SCALE;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

type Pt = IntPoint<i32>;

/// The hair the lower layer's sparse area shrinks by and a piece grows by before they are checked for overlap,
/// internal units (0.001 mm): a piece that only meets the sparse area along an edge does not rest on it.
const EPS: i32 = 10;

/// Half the width of the slivers of sparse infill along the infill area's edge that do not pull a floating band in,
/// internal units (0.005 mm).
const HAIR: i32 = 50;

/// Slowed parts and the supported gaps between them shorter than this are smoothed away, mm.
const SMOOTH_MM: f64 = 2.0;

/// The default `vertical_shell_speed`: this percent of `internal_solid_infill_speed`.
const DEFAULT_PERCENT: f64 = 80.0;

/// True when some region of the print can have a floating vertical shell: a Bambu Lab printer with
/// `detect_narrow_internal_solid_infill` on in the base settings or a modifier's.
pub(crate) fn wanted(cfg: &PrintConfig, mods: &[PrintConfig]) -> bool {
    std::iter::once(cfg).chain(mods).any(wanted_for)
}

/// True when this region's narrow internal solid infill may become a floating vertical shell.
pub(crate) fn wanted_for(cfg: &PrintConfig) -> bool {
    crate::firmware::bambu_printer(cfg, cfg.gcode_flavor)
        && crate::tower::flag_or(cfg, "detect_narrow_internal_solid_infill", true)
}

/// True when the spans over the sparse infill below slow down (`detect_floating_vertical_shell`, on by default).
pub(crate) fn slows(cfg: &PrintConfig) -> bool {
    crate::tower::flag_or(cfg, "detect_floating_vertical_shell", true)
}

/// The speed of the floating vertical shell outside its slowed spans, mm/s: `vertical_shell_speed`, a speed or a
/// percent of `internal_solid_infill_speed`.
pub(crate) fn speed(cfg: &PrintConfig) -> f64 {
    let solid = cfg.internal_solid_infill_speed;
    let value = match cfg.raw.get("vertical_shell_speed") {
        Some(serde_json::Value::Array(a)) => a.first().cloned(),
        v => v.cloned(),
    };
    let parsed = match &value {
        Some(serde_json::Value::String(t)) => {
            let t = t.trim();
            match t.strip_suffix('%') {
                Some(p) => p.trim().parse::<f64>().ok().map(|p| solid * p / 100.0),
                None => t.parse::<f64>().ok(),
            }
        }
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        _ => None,
    };
    parsed
        .filter(|v| *v > 0.0)
        .unwrap_or(solid * DEFAULT_PERCENT / 100.0)
}

/// The speed of a slowed span printed with filament `slot`, mm/s: `bridge_speed` (the region's, `bridge`), or the
/// filament's `filament_bridge_speed` when its `override_process_overhang_speed` is on.
pub(crate) fn slow_speed(cfg: &PrintConfig, slot: u8, bridge: f64) -> f64 {
    if crate::tower::per_slot_raw(cfg, "override_process_overhang_speed", slot, 0.0) != 0.0 {
        let own = crate::tower::per_slot_raw(cfg, "filament_bridge_speed", slot, 0.0);
        if own > 0.0 {
            return own;
        }
    }
    bridge
}

/// The lower layer's unsupported area from its sparse infill area: shrunk by a hair.
pub(crate) fn unsupported(lower_sparse: &Shapes) -> Shapes {
    if lower_sparse.is_empty() {
        return Shapes::new();
    }
    perimeters::offset(lower_sparse, -EPS)
}

/// The narrow pieces that rest on the unsupported area (the floating vertical shell), and the others.
pub(crate) fn split(narrow: &Shapes, unsupported: &Shapes) -> (Shapes, Shapes) {
    let (mut floating, mut rest) = (Shapes::new(), Shapes::new());
    let ub = perimeters::bounds(unsupported);
    for shape in narrow {
        let one: Shapes = vec![shape.clone()];
        let near = match (ub, perimeters::bounds(&one)) {
            (Some(u), Some(b)) => {
                b[0] - EPS <= u[2] && u[0] <= b[2] + EPS && b[1] - EPS <= u[3] && u[1] <= b[3] + EPS
            }
            _ => false,
        };
        if near && !perimeters::intersection(&perimeters::offset(&one, EPS), unsupported).is_empty() {
            floating.push(shape.clone());
        } else {
            rest.push(shape.clone());
        }
    }
    (floating, rest)
}

/// How far past its piece a floating band reaches over the sparse infill, as a share of the internal solid infill
/// spacing; `infill_wall_overlap` of the mean of the inner wall's and the internal solid infill's spacings comes off.
const SPARSE_REACH: f64 = 0.21;

/// How far a floating band reaches past its piece over the sparse infill, internal units: [`SPARSE_REACH`] of the
/// internal solid infill spacing less `infill_wall_overlap` of the mean of the inner wall's and the internal solid
/// infill's spacings (0.0204 mm with 0.42 mm lines, 0.20 mm layers and 15%). Negative when the overlap is larger:
/// the band then stops short of the piece's edge.
pub(crate) fn reach(cfg: &PrintConfig) -> i32 {
    let solid = cfg.spacing_for(cfg.solid_infill_width());
    let wall = cfg.spacing_for(cfg.inner_wall_width());
    let mm = SPARSE_REACH * solid - cfg.infill_wall_overlap / 100.0 * f64::midpoint(wall, solid);
    (mm * SCALE).round() as i32
}

/// How far the infill area without its overlap with the inner wall reaches past the inner wall's spacing edge,
/// toward the wall, internal units: what the band's wall side grows by so it starts at that spacing edge. Variable
/// width walls start the infill area there (0). Fixed-width walls start it at their widths from the outline (the
/// outer wall's and one inner wall's per further loop), with the innermost wall's centerline placed by the precise
/// outer wall setting, at the layer's `height`.
pub(crate) fn wall_shift(cfg: &PrintConfig, height: f64) -> i32 {
    if cfg.arachne_walls() {
        return 0;
    }
    let spacing = |w: f64| (w - height * (1.0 - std::f64::consts::FRAC_PI_4)).max(w * 0.5);
    let (outer, inner) = (cfg.outer_wall_width(), cfg.inner_wall_width());
    let past = if cfg.wall_loops < 2 {
        inner / 2.0
    } else {
        let precise = crate::tower::flag_or(cfg, "precise_outer_wall", true)
            && cfg.wall_sequence == crate::config::WallSequence::InnerOuter;
        let first = if precise {
            f64::midpoint(outer, inner)
        } else {
            f64::midpoint(spacing(outer), spacing(inner))
        };
        let innermost = outer / 2.0 + first + f64::from(cfg.wall_loops - 2) * spacing(inner);
        outer + inner * f64::from(cfg.wall_loops - 1) - innermost
    };
    ((past - spacing(inner) / 2.0) * SCALE).round() as i32
}

/// The band the beads of floating pieces fill: the pieces inside `flat` (the infill area without its overlap with
/// the inner wall, so the beads start at the inner wall's spacing edge), with their edges over `sparse` moved
/// `reach` (internal units) out over it, or in when `reach` is negative. A piece that rests almost wholly on the
/// `unsupported` area below ([`on_air`]: the ring a vertical wall leaves under its top shells) keeps its edges.
pub(crate) fn band(
    pieces: &Shapes,
    flat: &Shapes,
    sparse: &Shapes,
    unsupported: &Shapes,
    reach: i32,
) -> Shapes {
    if sparse.is_empty() || reach == 0 {
        return perimeters::intersection(pieces, flat);
    }
    let (rings, leaning): (Shapes, Shapes) = pieces
        .iter()
        .cloned()
        .partition(|s| on_air(std::slice::from_ref(s), unsupported));
    let moved = reached(&leaning, flat, sparse, reach);
    if rings.is_empty() {
        return moved;
    }
    let kept = perimeters::intersection(&rings, flat);
    if moved.is_empty() {
        return kept;
    }
    perimeters::union_all(&[&moved, &kept])
}

/// True when less than a quarter of a piece lies off the `unsupported` area below.
fn on_air(piece: &[Vec<Vec<Pt>>], unsupported: &Shapes) -> bool {
    let all = area(piece);
    all > 0 && area(&perimeters::difference(&piece.to_vec(), unsupported)) * 4 < all
}

/// Twice the area of `s`, internal units squared.
fn area(s: &[Vec<Vec<Pt>>]) -> i64 {
    s.iter()
        .flat_map(|sh| sh.iter())
        .map(|r| crate::geom::area2_int(r))
        .sum::<i64>()
        .abs()
}

/// [`band`] for pieces whose edges over `sparse` move by `reach`.
fn reached(pieces: &Shapes, flat: &Shapes, sparse: &Shapes, reach: i32) -> Shapes {
    if pieces.is_empty() {
        return Shapes::new();
    }
    if reach > 0 {
        let over = perimeters::intersection(&perimeters::offset(pieces, reach), sparse);
        return perimeters::intersection(&perimeters::union_all(&[pieces, &over]), flat);
    }
    let inside = perimeters::intersection(pieces, flat);
    if inside.is_empty() {
        return inside;
    }
    // Only the sparse infill inside `flat` pulls the band in: the strip of it over the wall overlap, outside `flat`,
    // would cut the band's wall side too. The opening drops the hairs that clipping leaves along `flat`'s edge.
    let open = perimeters::offset(&perimeters::intersection(sparse, flat), -HAIR);
    if open.is_empty() {
        return inside;
    }
    perimeters::difference(&inside, &perimeters::offset(&open, HAIR - reach))
}

/// A piece of a floating vertical shell bead, in print order: its points and widths, and whether it is a slowed
/// span.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Piece {
    pub(crate) points: Vec<Pt>,
    pub(crate) widths: Vec<i32>,
    pub(crate) slow: bool,
}

/// Where a bead counts as supported: off the unsupported area, or on one of the lower layer's sparse lines.
pub(crate) struct Support<'a> {
    unsupported: &'a Shapes,
    /// The unsupported area's edges, for the crossings of a bead.
    edges: Vec<[Pt; 2]>,
    /// The lower layer's sparse lines and half their width, internal units.
    lines: Vec<[Pt; 2]>,
    half: f64,
}

impl<'a> Support<'a> {
    pub(crate) fn new(unsupported: &'a Shapes, lines: Vec<[Pt; 2]>, line_width_mm: f64) -> Self {
        let mut edges = Vec::new();
        for ring in unsupported.iter().flat_map(|s| s.iter()) {
            for (i, &a) in ring.iter().enumerate() {
                if let Some(&b) = ring.get((i + 1) % ring.len()) {
                    edges.push([a, b]);
                }
            }
        }
        Self {
            unsupported,
            edges,
            lines,
            half: line_width_mm / 2.0 * SCALE,
        }
    }

    fn over_air(&self, p: Pt) -> bool {
        inside(self.unsupported, p)
    }

    /// Not over the unsupported area, or on a sparse line of the layer below.
    fn supported(&self, p: Pt) -> bool {
        !self.over_air(p) || self.lines.iter().any(|l| seg_dist(p, l[0], l[1]) <= self.half)
    }
}

/// Even-odd inside test over every ring of `s`.
fn inside(s: &Shapes, p: Pt) -> bool {
    s.iter()
        .flat_map(|sh| sh.iter())
        .filter(|r| perimeters::point_in(r, p))
        .count()
        % 2
        == 1
}

fn seg_dist(p: Pt, a: Pt, b: Pt) -> f64 {
    let (px, py) = (f64::from(p.x), f64::from(p.y));
    let (ax, ay) = (f64::from(a.x), f64::from(a.y));
    let (dx, dy) = (f64::from(b.x) - ax, f64::from(b.y) - ay);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (px - ax - t * dx).m_hypot(py - ay - t * dy)
}

fn dist(a: Pt, b: Pt) -> f64 {
    f64::from(a.x - b.x).m_hypot(f64::from(a.y - b.y))
}

/// The floating vertical shell of a region on one layer: its pieces' beads ordered, started on support and cut
/// into slowed and plain pieces (`slowed` false keeps every bead in one plain piece).
pub(crate) fn beads(
    floating: &Shapes,
    cfg: &PrintConfig,
    spacing_mm: f64,
    layer_height: f64,
    support: &Support<'_>,
    slowed: bool,
) -> Vec<Piece> {
    let clip = crate::narrow::loop_clipping(cfg);
    let mut out = Vec::new();
    for lines in crate::narrow::concentric_beads(floating, cfg, spacing_mm, layer_height) {
        for l in order(lines, clip, support) {
            let spans = if slowed {
                slow_spans(&l.points, support)
            } else {
                Vec::new()
            };
            out.extend(cut(l, &spans));
        }
    }
    out
}

/// One piece's beads in print order: a bead enclosing another first, otherwise the nearest next. Closed beads
/// start on support and lose `clip` mm at their end, as the other concentric fills do.
fn order(lines: Vec<WallLine>, clip: f64, support: &Support<'_>) -> Vec<WallLine> {
    // (points without the closing repeat, widths, closed)
    let mut beads: Vec<(Vec<Pt>, Vec<i32>, bool)> = Vec::with_capacity(lines.len());
    for l in lines {
        if l.points.len() < 2 || l.widths.len() != l.points.len() {
            continue;
        }
        let (mut pts, mut ws) = (l.points, l.widths);
        let closed = pts.len() > 2 && pts.first() == pts.last() && ws.first() == ws.last();
        if closed {
            pts.pop();
            ws.pop();
        }
        beads.push((pts, ws, closed));
    }
    let n = beads.len();
    // encloses[i][j]: closed bead i holds bead j.
    let encloses = |i: usize, j: usize| -> bool {
        i != j
            && beads.get(i).is_some_and(|b| b.2)
            && match (beads.get(i), beads.get(j).and_then(|b| b.0.first())) {
                (Some(bi), Some(&p)) => perimeters::point_in(&bi.0, p),
                _ => false,
            }
    };
    let held: Vec<Vec<usize>> = (0..n)
        .map(|j| (0..n).filter(|&i| encloses(i, j)).collect())
        .collect();
    let mut used = vec![false; n];
    let mut at = Pt::new(0, 0);
    let mut first_closed = true;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        // The nearest bead no bead still to print encloses; a closed bead counts from its nearest point.
        let free = |j: usize| {
            !used.get(j).copied().unwrap_or(true)
                && held
                    .get(j)
                    .is_some_and(|h| h.iter().all(|&i| used.get(i).copied().unwrap_or(true)))
        };
        let reach = |j: usize| -> f64 {
            beads.get(j).map_or(f64::MAX, |b| {
                if b.2 {
                    b.0.iter().map(|&p| dist(p, at)).fold(f64::MAX, f64::min)
                } else {
                    b.0.first().map_or(f64::MAX, |&p| dist(p, at))
                }
            })
        };
        let pick = (0..n)
            .filter(|&j| free(j))
            .min_by(|&a, &b| reach(a).total_cmp(&reach(b)))
            .or_else(|| (0..n).find(|&j| !used.get(j).copied().unwrap_or(true)));
        let Some(k) = pick else { break };
        if let Some(u) = used.get_mut(k) {
            *u = true;
        }
        let Some((pts, ws, closed)) = beads.get(k).cloned() else {
            continue;
        };
        let (mut pts, mut ws) = (pts, ws);
        if closed {
            let start = if first_closed {
                longest_supported_start(&pts, support)
            } else {
                nearest_supported(&pts, support, at)
            };
            first_closed = false;
            pts.rotate_left(start);
            ws.rotate_left(start);
            if let (Some(&p), Some(&w)) = (pts.first(), ws.first()) {
                pts.push(p);
                ws.push(w);
            }
        }
        crate::narrow::clip_end(&mut pts, &mut ws, clip);
        if pts.len() < 2 || !pts.windows(2).any(|s| matches!(s, [a, b] if a != b)) {
            continue;
        }
        at = pts.last().copied().unwrap_or(at);
        out.push(WallLine {
            inset: 0,
            is_odd: false,
            closed: false,
            points: pts,
            widths: ws,
        });
    }
    out
}

/// The first point of a closed ring's longest run of supported points (by length); its point nearest the origin
/// when no point is supported or every point is.
fn longest_supported_start(ring: &[Pt], support: &Support<'_>) -> usize {
    let n = ring.len();
    let ok: Vec<bool> = ring.iter().map(|&p| support.supported(p)).collect();
    let fallback = || {
        (0..n)
            .min_by(|&a, &b| {
                let d = |i: usize| ring.get(i).map_or(f64::MAX, |&p| dist(p, Pt::new(0, 0)));
                d(a).total_cmp(&d(b))
            })
            .unwrap_or(0)
    };
    // Start counting just after an unsupported point, so no run is split by the ring's start.
    let Some(gap) = ok.iter().position(|o| !o) else {
        return fallback();
    };
    if !ok.iter().any(|o| *o) {
        return fallback();
    }
    let (mut best, mut best_len) = (0usize, -1.0f64);
    let mut run: Option<(usize, f64)> = None;
    for step in 1..=n {
        let i = (gap + step) % n;
        let prev = (gap + step - 1) % n;
        if ok.get(i).copied().unwrap_or(false) {
            let seg = match (ring.get(prev), ring.get(i)) {
                (Some(&a), Some(&b)) if run.is_some() => dist(a, b),
                _ => 0.0,
            };
            run = Some(run.map_or((i, 0.0), |(s, l)| (s, l + seg)));
        } else if let Some((s, l)) = run.take()
            && l > best_len
        {
            (best, best_len) = (s, l);
        }
    }
    if let Some((s, l)) = run
        && l > best_len
    {
        best = s;
    }
    best
}

/// The supported point of a ring nearest `at`; the nearest point when none is supported.
fn nearest_supported(ring: &[Pt], support: &Support<'_>, at: Pt) -> usize {
    let nearest = |only: bool| {
        (0..ring.len())
            .filter(|&i| !only || ring.get(i).is_some_and(|&p| support.supported(p)))
            .min_by(|&a, &b| {
                let d = |i: usize| ring.get(i).map_or(f64::MAX, |&p| dist(p, at));
                d(a).total_cmp(&d(b))
            })
    };
    nearest(true).or_else(|| nearest(false)).unwrap_or(0)
}

/// The spans of a bead's center line over the unsupported area, as distances along it from its start (internal
/// units), smoothed: supported gaps under 2 mm between two spans join them, then spans under 2 mm go. None for a
/// bead that crosses itself.
pub(crate) fn slow_spans(points: &[Pt], support: &Support<'_>) -> Vec<(f64, f64)> {
    if points.len() < 2 || crosses_itself(points) {
        return Vec::new();
    }
    let Some(bb) = bbox(points) else {
        return Vec::new();
    };
    let edges: Vec<&[Pt; 2]> = support
        .edges
        .iter()
        .filter(|e| {
            let (x0, x1) = (e[0].x.min(e[1].x), e[0].x.max(e[1].x));
            let (y0, y1) = (e[0].y.min(e[1].y), e[0].y.max(e[1].y));
            x1 >= bb[0] && x0 <= bb[2] && y1 >= bb[1] && y0 <= bb[3]
        })
        .collect();
    let mut spans: Vec<(f64, f64)> = Vec::new();
    let mut base = 0.0;
    for w in points.windows(2) {
        let [a, b] = w else { continue };
        let len = dist(*a, *b);
        if len <= 0.0 {
            continue;
        }
        let mut cuts = vec![0.0, 1.0];
        for e in &edges {
            if let Some(t) = crossing(*a, *b, e[0], e[1]) {
                cuts.push(t);
            }
        }
        cuts.sort_by(f64::total_cmp);
        cuts.dedup_by(|x, y| (*x - *y).abs() < 1e-12);
        for c in cuts.windows(2) {
            let [t0, t1] = c else { continue };
            let tm = f64::midpoint(*t0, *t1);
            let m = Pt::new(
                (f64::from(a.x) + f64::from(b.x - a.x) * tm).round() as i32,
                (f64::from(a.y) + f64::from(b.y - a.y) * tm).round() as i32,
            );
            if support.over_air(m) {
                let (s, e) = (base + t0 * len, base + t1 * len);
                match spans.last_mut() {
                    Some(last) if (last.1 - s).abs() < 1.0 => last.1 = e,
                    _ => spans.push((s, e)),
                }
            }
        }
        base += len;
    }
    smooth(spans, SMOOTH_MM * SCALE)
}

/// Joins spans whose gap is under `limit`, then drops spans shorter than `limit`.
fn smooth(spans: Vec<(f64, f64)>, limit: f64) -> Vec<(f64, f64)> {
    let mut joined: Vec<(f64, f64)> = Vec::with_capacity(spans.len());
    for s in spans {
        match joined.last_mut() {
            Some(last) if s.0 - last.1 < limit => last.1 = s.1,
            _ => joined.push(s),
        }
    }
    joined.retain(|s| s.1 - s.0 >= limit);
    joined
}

fn bbox(points: &[Pt]) -> Option<[i32; 4]> {
    let f = points.first()?;
    Some(points.iter().fold([f.x, f.y, f.x, f.y], |b, p| {
        [b[0].min(p.x), b[1].min(p.y), b[2].max(p.x), b[3].max(p.y)]
    }))
}

/// Where segment `a b` crosses segment `c d`, as the fraction along `a b` strictly inside it.
fn crossing(a: Pt, b: Pt, c: Pt, d: Pt) -> Option<f64> {
    let (ax, ay) = (f64::from(a.x), f64::from(a.y));
    let (rx, ry) = (f64::from(b.x) - ax, f64::from(b.y) - ay);
    let (cx, cy) = (f64::from(c.x), f64::from(c.y));
    let (sx, sy) = (f64::from(d.x) - cx, f64::from(d.y) - cy);
    let den = rx * sy - ry * sx;
    if den == 0.0 {
        return None;
    }
    let t = ((cx - ax) * sy - (cy - ay) * sx) / den;
    let u = ((cx - ax) * ry - (cy - ay) * rx) / den;
    (t > 0.0 && t < 1.0 && (0.0..=1.0).contains(&u)).then_some(t)
}

/// True when two segments of the bead that do not share a point cross.
fn crosses_itself(points: &[Pt]) -> bool {
    let segs: Vec<(Pt, Pt)> = points
        .windows(2)
        .filter_map(|w| match w {
            [a, b] if a != b => Some((*a, *b)),
            _ => None,
        })
        .collect();
    let boxes: Vec<[i32; 4]> = segs
        .iter()
        .map(|(a, b)| [a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y)])
        .collect();
    for i in 0..segs.len() {
        for j in i + 2..segs.len() {
            let (Some(&(a, b)), Some(&(c, d)), Some(p), Some(q)) =
                (segs.get(i), segs.get(j), boxes.get(i), boxes.get(j))
            else {
                continue;
            };
            if p[2] < q[0] || q[2] < p[0] || p[3] < q[1] || q[3] < p[1] {
                continue;
            }
            // Neighbors through the bead's start and end of a loop share a point; they meet, not cross.
            if a == d || b == c || a == c || b == d {
                continue;
            }
            if proper_cross(a, b, c, d) {
                return true;
            }
        }
    }
    false
}

fn proper_cross(a: Pt, b: Pt, c: Pt, d: Pt) -> bool {
    let o = |p: Pt, q: Pt, r: Pt| {
        (i64::from(q.x) - i64::from(p.x)) * (i64::from(r.y) - i64::from(p.y))
            - (i64::from(q.y) - i64::from(p.y)) * (i64::from(r.x) - i64::from(p.x))
    };
    let (d1, d2, d3, d4) = (o(a, b, c), o(a, b, d), o(c, d, a), o(c, d, b));
    (d1 > 0) != (d2 > 0) && d1 != 0 && d2 != 0 && (d3 > 0) != (d4 > 0) && d3 != 0 && d4 != 0
}

/// A bead cut at the ends of its slowed spans (distances along it, internal units) into pieces in order.
fn cut(l: WallLine, spans: &[(f64, f64)]) -> Vec<Piece> {
    if spans.is_empty() {
        return vec![Piece {
            points: l.points,
            widths: l.widths,
            slow: false,
        }];
    }
    let bounds: Vec<f64> = spans.iter().flat_map(|s| [s.0, s.1]).collect();
    // Every point with its distance along the bead, and a point at each bound inside a segment.
    let mut pts: Vec<(Pt, i32, f64)> = Vec::with_capacity(l.points.len() + bounds.len());
    let mut along = 0.0;
    for (i, (&p, &w)) in l.points.iter().zip(&l.widths).enumerate() {
        if i > 0
            && let Some(&(a, wa, _)) = pts.last()
        {
            let len = dist(a, p);
            for &c in &bounds {
                if c > along + 0.5 && c < along + len - 0.5 {
                    let t = (c - along) / len;
                    let q = Pt::new(
                        (f64::from(a.x) + f64::from(p.x - a.x) * t).round() as i32,
                        (f64::from(a.y) + f64::from(p.y - a.y) * t).round() as i32,
                    );
                    pts.push((q, (f64::from(wa) + f64::from(w - wa) * t).round() as i32, c));
                }
            }
            along += len;
        }
        pts.push((p, w, along));
    }
    let in_span = |d: f64| spans.iter().any(|s| d > s.0 && d < s.1);
    let mut out: Vec<Piece> = Vec::new();
    let mut cur: Vec<(Pt, i32, f64)> = Vec::new();
    let last = pts.len().saturating_sub(1);
    for (k, &q) in pts.iter().enumerate() {
        cur.push(q);
        let at_bound = k > 0 && k < last && bounds.iter().any(|c| (c - q.2).abs() <= 0.5);
        if at_bound || k == last {
            if let (Some(f), Some(e)) = (cur.first(), cur.last())
                && e.2 - f.2 > 0.5
            {
                out.push(Piece {
                    points: cur.iter().map(|x| x.0).collect(),
                    widths: cur.iter().map(|x| x.1).collect(),
                    slow: in_span(f64::midpoint(f.2, e.2)),
                });
            }
            cur = vec![q];
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, reason = "small fixed test data")]
mod tests {
    use super::*;
    use crate::geom::mm;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Pt> {
        vec![
            Pt::new(mm(x0), mm(y0)),
            Pt::new(mm(x1), mm(y0)),
            Pt::new(mm(x1), mm(y1)),
            Pt::new(mm(x0), mm(y1)),
        ]
    }

    fn line(x0: f64, x1: f64, y: f64) -> Vec<Pt> {
        let n = 40;
        (0..=n)
            .map(|i| Pt::new(mm(x0 + (x1 - x0) * f64::from(i) / f64::from(n)), mm(y)))
            .collect()
    }

    fn spans_mm(points: &[Pt], sparse: &[Vec<Pt>]) -> Vec<(f64, f64)> {
        let area: Shapes = sparse.iter().map(|r| vec![r.clone()]).collect();
        let u = unsupported(&area);
        let s = Support::new(&u, Vec::new(), 0.45);
        slow_spans(points, &s)
            .into_iter()
            .map(|(a, b)| {
                (
                    (a / SCALE * 100.0).round() / 100.0,
                    (b / SCALE * 100.0).round() / 100.0,
                )
            })
            .collect()
    }

    #[test]
    fn a_ten_mm_stretch_over_sparse_is_one_slowed_span() {
        // A 30 mm bead along y = 1 whose layer below is sparse from x 10 to 20 and solid elsewhere.
        let s = spans_mm(&line(0.0, 30.0, 1.0), &[rect(10.0, 0.0, 20.0, 2.0)]);
        assert_eq!(s.len(), 1, "{s:?}");
        assert!(
            (s[0].0 - 10.0).abs() < 0.01 && (s[0].1 - 20.0).abs() < 0.01,
            "{s:?}"
        );
    }

    #[test]
    fn a_stretch_under_2_mm_is_not_slowed() {
        assert!(spans_mm(&line(0.0, 30.0, 1.0), &[rect(10.0, 0.0, 11.5, 2.0)]).is_empty());
    }

    #[test]
    fn a_gap_under_2_mm_between_two_stretches_is_slowed_too() {
        let s = spans_mm(
            &line(0.0, 30.0, 1.0),
            &[rect(5.0, 0.0, 10.0, 2.0), rect(11.0, 0.0, 16.0, 2.0)],
        );
        assert_eq!(s.len(), 1, "{s:?}");
        assert!(
            (s[0].0 - 5.0).abs() < 0.01 && (s[0].1 - 16.0).abs() < 0.01,
            "{s:?}"
        );
    }

    #[test]
    fn a_bead_that_crosses_itself_is_not_slowed() {
        // A figure eight over the sparse area.
        let pts = vec![
            Pt::new(mm(0.0), mm(0.0)),
            Pt::new(mm(20.0), mm(10.0)),
            Pt::new(mm(20.0), mm(0.0)),
            Pt::new(mm(0.0), mm(10.0)),
        ];
        assert!(spans_mm(&pts, &[rect(-5.0, -5.0, 25.0, 15.0)]).is_empty());
    }

    #[test]
    fn a_bead_is_cut_at_its_spans_into_plain_and_slowed_pieces() {
        let pts = line(0.0, 30.0, 1.0);
        let n = pts.len();
        let l = WallLine {
            inset: 0,
            is_odd: false,
            closed: false,
            points: pts,
            widths: vec![mm(0.45); n],
        };
        let pieces = cut(l, &[(10.3 * SCALE, 20.1 * SCALE)]);
        let kinds: Vec<bool> = pieces.iter().map(|p| p.slow).collect();
        assert_eq!(kinds, vec![false, true, false]);
        let len = |p: &Piece| p.points.windows(2).map(|w| dist(w[0], w[1])).sum::<f64>() / SCALE;
        assert!((len(&pieces[1]) - 9.8).abs() < 0.01, "{}", len(&pieces[1]));
        assert!((pieces.iter().map(len).sum::<f64>() - 30.0).abs() < 0.01);
        // The pieces join end to start.
        assert_eq!(pieces[0].points.last(), pieces[1].points.first());
        assert_eq!(pieces[1].points.last(), pieces[2].points.first());
    }

    #[test]
    fn a_piece_that_overlaps_the_sparse_below_floats_and_one_beside_it_does_not() {
        let sparse: Shapes = vec![vec![rect(0.0, 0.0, 10.0, 10.0)]];
        let u = unsupported(&sparse);
        let over = vec![rect(9.0, 2.0, 12.0, 8.0)];
        let beside = vec![rect(10.0, 2.0, 13.0, 8.0)];
        let (f, r) = split(&vec![over.clone(), beside.clone()], &u);
        assert_eq!(f, vec![over]);
        assert_eq!(r, vec![beside]);
    }

    fn stock_widths(overlap_percent: f64) -> PrintConfig {
        let mut c = PrintConfig {
            layer_height: 0.2,
            line_width: 0.42,
            infill_wall_overlap: overlap_percent,
            ..PrintConfig::default()
        };
        c.feature_widths.inner_wall = Some(0.45);
        c.feature_widths.internal_solid_infill = Some(0.42);
        c
    }

    /// The band's x range in mm.
    fn x_range(s: &Shapes) -> (f64, f64) {
        let b = perimeters::bounds(s).expect("a band");
        (f64::from(b[0]) / SCALE, f64::from(b[2]) / SCALE)
    }

    #[test]
    fn the_band_reaches_a_share_of_a_solid_spacing_less_the_overlap_over_the_sparse() {
        // 0.21 x 0.3771 less 15% of the mean of 0.4071 and 0.3771: 0.0204 mm.
        let r = f64::from(reach(&stock_widths(15.0))) / SCALE;
        assert!((r - 0.0204).abs() < 0.0002, "{r}");
        assert!((f64::from(reach(&stock_widths(0.0))) / SCALE - 0.0792).abs() < 0.0002);
        // With 30% the overlap is the larger: the band stops 0.0384 mm short of the piece's edge.
        assert!((f64::from(reach(&stock_widths(30.0))) / SCALE + 0.0384).abs() < 0.0002);
    }

    #[test]
    fn fixed_width_walls_move_the_band_to_the_inner_wall_spacing_edge() {
        // Two 0.42 mm classic walls with the precise outer wall: the innermost wall's centerline sits 0.63 mm in and
        // the infill area 0.84 mm in, 0.21 mm past it, where the spacing edge is 0.1885 mm past it.
        let mut c = PrintConfig {
            layer_height: 0.2,
            line_width: 0.42,
            wall_loops: 2,
            wall_sequence: crate::config::WallSequence::InnerOuter,
            ..PrintConfig::default()
        };
        c.raw
            .insert("wall_generator".into(), serde_json::json!("classic"));
        c.raw.insert("precise_outer_wall".into(), serde_json::json!(true));
        let s = f64::from(wall_shift(&c, 0.2)) / SCALE;
        assert!((s - 0.0215).abs() < 0.0002, "{s}");
        // Without it the first inner wall sits the two spacings' mean in: 0.587 mm, 0.253 mm short of the area.
        c.raw
            .insert("precise_outer_wall".into(), serde_json::json!(false));
        let s = f64::from(wall_shift(&c, 0.2)) / SCALE;
        assert!((s - 0.0644).abs() < 0.0002, "{s}");
        // Variable-width walls already start the infill area at the spacing edge.
        c.raw
            .insert("wall_generator".into(), serde_json::json!("arachne"));
        assert_eq!(wall_shift(&c, 0.2), 0);
    }

    #[test]
    fn the_band_starts_at_the_inner_wall_spacing_edge_and_reaches_over_the_sparse() {
        // The infill area (with its 0.063 mm overlap) starts at x 0, so its flat part at 0.063; the piece runs to
        // x 0.5 and the sparse infill on from there.
        let flat: Shapes = vec![vec![rect(0.063, -5.0, 20.0, 15.0)]];
        let piece: Shapes = vec![vec![rect(0.0, 0.0, 0.5, 10.0)]];
        let sparse: Shapes = vec![vec![rect(0.5, -5.0, 20.0, 15.0)]];
        let (x0, x1) = x_range(&band(&piece, &flat, &sparse, &Shapes::new(), mm(0.0204)));
        assert!(
            (x0 - 0.063).abs() < 0.0002 && (x1 - 0.5204).abs() < 0.0002,
            "{x0} {x1}"
        );
        // A negative reach pulls the sparse side in.
        let (x0, x1) = x_range(&band(&piece, &flat, &sparse, &Shapes::new(), mm(-0.0384)));
        assert!(
            (x0 - 0.063).abs() < 0.0002 && (x1 - 0.4616).abs() < 0.0002,
            "{x0} {x1}"
        );
        // Sparse infill over the wall overlap, beside a piece that starts at the spacing edge, moves neither edge
        // on the wall side.
        let piece: Shapes = vec![vec![rect(0.063, 0.0, 0.5, 10.0)]];
        let strip: Shapes = vec![
            vec![rect(0.0, -5.0, 0.063, 15.0)],
            vec![rect(0.5, -5.0, 20.0, 15.0)],
        ];
        for r in [mm(0.0204), mm(-0.0384)] {
            let (x0, x1) = x_range(&band(&piece, &flat, &strip, &Shapes::new(), r));
            let far = 0.5 + f64::from(r) / SCALE;
            assert!(
                (x0 - 0.063).abs() < 0.0002 && (x1 - far).abs() < 0.0002,
                "{x0} {x1}"
            );
        }
    }

    #[test]
    fn a_ring_wholly_over_the_sparse_below_keeps_its_edge() {
        let flat: Shapes = vec![vec![rect(0.063, -5.0, 20.0, 15.0)]];
        let piece: Shapes = vec![vec![rect(0.0, 0.0, 0.44, 10.0)]];
        let sparse: Shapes = vec![vec![rect(0.44, -5.0, 20.0, 15.0)]];
        // The layer below is sparse under all of it: a ring.
        let below = unsupported(&vec![vec![rect(-0.2, -5.0, 20.0, 15.0)]]);
        let (x0, x1) = x_range(&band(&piece, &flat, &sparse, &below, mm(0.0204)));
        assert!(
            (x0 - 0.063).abs() < 0.0002 && (x1 - 0.44).abs() < 0.0002,
            "{x0} {x1}"
        );
        // Sparse below only its inner fifth (a band a leaning wall leaves): it reaches.
        let below = unsupported(&vec![vec![rect(0.36, -5.0, 20.0, 15.0)]]);
        let (x0, x1) = x_range(&band(&piece, &flat, &sparse, &below, mm(0.0204)));
        assert!(
            (x0 - 0.063).abs() < 0.0002 && (x1 - 0.4604).abs() < 0.0002,
            "{x0} {x1}"
        );
    }

    #[test]
    fn a_slot_band_runs_between_the_two_spacing_edges() {
        // A 1.515 mm slot between two walls, each overlapped by 0.063 mm: no sparse beside it, so the band is the
        // 1.389 mm between the spacing edges whatever the reach.
        let flat: Shapes = vec![vec![rect(0.063, -5.0, 1.452, 15.0)]];
        let piece: Shapes = vec![vec![rect(0.0, 0.0, 1.515, 10.0)]];
        let sparse: Shapes = vec![vec![rect(5.0, -5.0, 20.0, 15.0)]];
        for r in [mm(0.0204), mm(-0.0384), 0] {
            let (x0, x1) = x_range(&band(&piece, &flat, &sparse, &Shapes::new(), r));
            assert!(
                (x0 - 0.063).abs() < 0.0002 && (x1 - 1.452).abs() < 0.0002,
                "{x0} {x1}"
            );
            let (x0, x1) = x_range(&band(&piece, &flat, &Shapes::new(), &Shapes::new(), r));
            assert!(
                (x0 - 0.063).abs() < 0.0002 && (x1 - 1.452).abs() < 0.0002,
                "{x0} {x1}"
            );
        }
    }

    #[test]
    fn the_speed_is_a_percent_of_the_solid_infill_speed_or_mm_per_s() {
        let mut c = PrintConfig {
            internal_solid_infill_speed: 250.0,
            ..PrintConfig::default()
        };
        assert!((speed(&c) - 200.0).abs() < 1e-9);
        c.raw
            .insert("vertical_shell_speed".into(), serde_json::json!(["60%"]));
        assert!((speed(&c) - 150.0).abs() < 1e-9);
        c.raw
            .insert("vertical_shell_speed".into(), serde_json::json!("150"));
        assert!((speed(&c) - 150.0).abs() < 1e-9);
        c.raw
            .insert("vertical_shell_speed".into(), serde_json::json!([120]));
        assert!((speed(&c) - 120.0).abs() < 1e-9);
    }

    #[test]
    fn a_filament_that_overrides_the_overhang_speeds_slows_at_its_own_bridge_speed() {
        let mut c = PrintConfig::default();
        assert!((slow_speed(&c, 1, 50.0) - 50.0).abs() < 1e-9);
        c.raw.insert(
            "override_process_overhang_speed".into(),
            serde_json::json!(["0", "1"]),
        );
        c.raw
            .insert("filament_bridge_speed".into(), serde_json::json!(["30", "25"]));
        assert!((slow_speed(&c, 1, 50.0) - 50.0).abs() < 1e-9);
        assert!((slow_speed(&c, 2, 50.0) - 25.0).abs() < 1e-9);
    }
}
