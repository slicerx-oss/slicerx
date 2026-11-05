// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Narrow internal solid infill. Orca splits an internal solid surface into the part where full
//! scanlines fit and the narrow rest, the bands a sloped wall leaves. The narrow rest is not filled with
//! lines: it gets concentric beads from the variable-width wall generator, so a band a line and a half
//! wide gets one or two beads that follow it.
//!
//! The split follows Orca's and Prusa's anti-vibration rule: scanline
//! sections longer than one spacing are kept, chains of short ones are dropped, and the area the kept
//! sections cover is the normal infill.
//!
//! Bambu Lab printers decide per connected piece instead ([`split_pieces`], card ohvk spec 2): a piece that holds no
//! 6 mm circle is narrow as a whole, any other piece keeps its lines, thin arms included. The circle is the largest the
//! piece really holds ([`holds_lines`]), so the corner of a ring, where the band widens, can keep a ring's lines that a
//! straight band of the same width would not.

use crate::fm::Fm as _;
use crate::geom::mm;
use crate::infill::Dir;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

/// Sections shorter than this (4 mm) may be filtered out.
fn max_line() -> i64 {
    crate::paths::t_units(4.0)
}

const MAX_SKIPS_ALLOWED: i32 = 2;
const MIN_DEPTH_FOR_LINE_REMOVING: i32 = 5;

#[derive(Clone, Copy, Default)]
struct State {
    min_skips_taken: i32,
    total_short_lines: i32,
    initial_touches_long_lines: bool,
    initialized: bool,
}

struct Node {
    t0: i64,
    t1: i64,
    next: Vec<usize>,
    prev: Vec<usize>,
    removed: bool,
    state: State,
}

impl Node {
    fn len(&self) -> i64 {
        self.t1 - self.t0
    }
}

fn overlapping(a: (i64, i64), b: (i64, i64)) -> bool {
    (b.0 <= a.0 && a.0 <= b.1)
        || (b.0 <= a.1 && a.1 <= b.1)
        || (a.0 <= b.0 && b.0 <= a.1)
        || (a.0 <= b.1 && b.1 <= a.1)
}

/// Drops chains of short sections, as Orca's narrow solid infill does. Sections are per scanline,
/// `(t0, t1)`, in line order.
fn filter_vibrating(sections: &[Vec<(i64, i64)>]) -> Vec<Vec<(i64, i64)>> {
    let limit = max_line();
    // Nodes of all sections in one list, with the index of each section's first node.
    let mut nodes: Vec<Node> = Vec::new();
    let mut first: Vec<usize> = Vec::with_capacity(sections.len() + 1);
    for sec in sections {
        first.push(nodes.len());
        for &(t0, t1) in sec {
            nodes.push(Node {
                t0,
                t1,
                next: Vec::new(),
                prev: Vec::new(),
                removed: false,
                state: State::default(),
            });
        }
    }
    first.push(nodes.len());
    let range = |s: usize| first.get(s).copied().unwrap_or(0)..first.get(s + 1).copied().unwrap_or(0);
    for s in 0..sections.len() {
        if s > 0 {
            for c in range(s) {
                for p in range(s - 1) {
                    let (a, b) = match (nodes.get(c), nodes.get(p)) {
                        (Some(a), Some(b)) => ((a.t0, a.t1), (b.t0, b.t1)),
                        _ => continue,
                    };
                    if overlapping(a, b)
                        && let Some(n) = nodes.get_mut(c)
                    {
                        n.prev.push(p);
                    }
                }
            }
        }
        if s + 1 < sections.len() {
            for c in range(s) {
                for nx in range(s + 1) {
                    let (a, b) = match (nodes.get(c), nodes.get(nx)) {
                        (Some(a), Some(b)) => ((a.t0, a.t1), (b.t0, b.t1)),
                        _ => continue,
                    };
                    if overlapping(a, b)
                        && let Some(n) = nodes.get_mut(c)
                    {
                        n.next.push(nx);
                    }
                }
            }
        }
    }
    let touching_long_before = |nodes: &[Node], i: usize| -> bool {
        nodes.get(i).is_some_and(|n| {
            n.prev
                .iter()
                .any(|&p| nodes.get(p).is_some_and(|q| !q.removed && q.len() >= limit))
        })
    };
    let initial_touching = |nodes: &[Node], i: usize| -> bool {
        nodes.get(i).is_some_and(|n| {
            n.prev
                .iter()
                .any(|&p| nodes.get(p).is_some_and(|q| q.state.initial_touches_long_lines))
        })
    };
    let has_next = |nodes: &[Node], i: usize| -> bool {
        nodes
            .get(i)
            .is_some_and(|n| n.next.iter().any(|&p| nodes.get(p).is_some_and(|q| !q.removed)))
    };
    let can_remove = |nodes: &[Node], i: usize| -> bool {
        nodes.get(i).is_some_and(|n| {
            n.len() < limit
                && (n.state.total_short_lines > MIN_DEPTH_FOR_LINE_REMOVING
                    || (!initial_touching(nodes, i) && !has_next(nodes, i)))
        })
    };
    for init in 0..sections.len() {
        for i in range(init) {
            let short_live = nodes.get(i).is_some_and(|n| !n.removed && n.len() < limit);
            if !short_live {
                continue;
            }
            let touches = touching_long_before(&nodes, i);
            if let Some(n) = nodes.get_mut(i) {
                n.state = State {
                    min_skips_taken: 0,
                    total_short_lines: 1,
                    initial_touches_long_lines: touches,
                    initialized: true,
                };
            }
        }
        for prop in init..sections.len() {
            if prop + 1 < sections.len() {
                for i in range(prop + 1) {
                    if let Some(n) = nodes.get_mut(i) {
                        n.state = State::default();
                    }
                }
            }
            for i in range(prop) {
                let Some(cur) = nodes.get(i) else { continue };
                if cur.removed || !cur.state.initialized {
                    continue;
                }
                let (cs, nexts) = (cur.state, cur.next.clone());
                for nb in nexts {
                    let Some(n) = nodes.get(nb) else { continue };
                    if n.removed {
                        continue;
                    }
                    let short = n.len() < limit;
                    let skip_allowed = cs.min_skips_taken < MAX_SKIPS_ALLOWED;
                    if !short && !skip_allowed {
                        continue;
                    }
                    let total = cs.total_short_lines + i32::from(short);
                    let skips = cs.min_skips_taken + i32::from(!short);
                    if let Some(n) = nodes.get_mut(nb) {
                        if n.state.initialized {
                            n.state.min_skips_taken = n.state.min_skips_taken.max(total).min(skips);
                            if n.state.initial_touches_long_lines {
                                n.state.initial_touches_long_lines = cs.initial_touches_long_lines;
                            }
                        } else {
                            n.state.total_short_lines = total;
                            n.state.min_skips_taken = skips;
                            n.state.initial_touches_long_lines = cs.initial_touches_long_lines;
                            n.state.initialized = true;
                        }
                    }
                }
                if can_remove(&nodes, i) {
                    if let Some(n) = nodes.get_mut(i) {
                        n.removed = true;
                    }
                    // The removal goes back through the previous sections.
                    let mut queue: std::collections::VecDeque<usize> = nodes
                        .get(i)
                        .map(|n| {
                            n.prev
                                .iter()
                                .copied()
                                .filter(|&p| nodes.get(p).is_some_and(|q| !q.removed))
                                .collect()
                        })
                        .unwrap_or_default();
                    while let Some(q) = queue.pop_front() {
                        if can_remove(&nodes, q) {
                            let prevs: Vec<usize> = nodes.get(q).map(|n| n.prev.clone()).unwrap_or_default();
                            if let Some(n) = nodes.get_mut(q) {
                                n.removed = true;
                            }
                            for p in prevs {
                                if nodes.get(p).is_some_and(|x| !x.removed) {
                                    queue.push_back(p);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    (0..sections.len())
        .map(|s| {
            range(s)
                .filter_map(|i| nodes.get(i))
                .filter(|n| !n.removed)
                .map(|n| (n.t0, n.t1))
                .collect()
        })
        .collect()
}

/// The sections of `rings` (points in `(s, t)`) along the line `s = at`: pairs of crossings, even-odd.
fn sections_at(rings: &[Vec<(i64, i64)>], at: i64) -> Vec<(i64, i64)> {
    let mut ts: Vec<i64> = Vec::new();
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            let (Some(&p), Some(&q)) = (ring.get(i), ring.get((i + 1) % n)) else {
                continue;
            };
            let (lo, hi) = if p.0 <= q.0 { (p, q) } else { (q, p) };
            if lo.0 <= at && at < hi.0 {
                #[allow(clippy::cast_precision_loss, reason = "coordinates stay far below 2^52")]
                let f = (at - lo.0) as f64 / (hi.0 - lo.0) as f64;
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_precision_loss,
                    reason = "a coordinate between two i64 points"
                )]
                ts.push(lo.1 + ((hi.1 - lo.1) as f64 * f).round() as i64);
            }
        }
    }
    ts.sort_unstable();
    ts.as_chunks::<2>().0.iter().map(|c| (c[0], c[1])).collect()
}

fn union_shapes(s: &Shapes) -> Shapes {
    if s.is_empty() {
        Vec::new()
    } else {
        perimeters::union_all(&[s])
    }
}

/// Normal and narrow parts of an internal solid region whose pattern is made of straight lines along `dir`
/// at `spacing` (in `s` units, `spacing_mm` in mm), as Orca splits them.
pub(crate) fn split_lines(region: &Shapes, dir: Dir, spacing: i64, spacing_mm: f64) -> (Shapes, Shapes) {
    if region.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let sp = mm(spacing_mm);
    let spacing = spacing.max(1);
    let mut normal: Shapes = Vec::new();
    // Orca works one expolygon at a time: its opening, and the scanlines from the low side of its own box.
    for shape in region {
        let one: Shapes = vec![shape.clone()];
        // The core where lines fit: the shape opened by 2 spacings (eroded) and 3 (dilated), pulled in by half.
        let eroded = perimeters::offset(&one, -(2 * sp));
        let opened = if eroded.is_empty() {
            Vec::new()
        } else {
            perimeters::offset(&eroded, 3 * sp)
        };
        let core = perimeters::intersection(&one, &opened);
        if core.is_empty() {
            continue;
        }
        let inner_area = perimeters::offset(&core, -(sp / 2));
        let rings: Vec<Vec<(i64, i64)>> = inner_area
            .iter()
            .flat_map(|s| s.iter())
            .map(|r| r.iter().map(|p| dir.st(p.x, p.y)).collect())
            .collect();
        let outline: Vec<i64> = shape.iter().flatten().map(|p| dir.st(p.x, p.y).0).collect();
        let (Some(&s_min), Some(&s_max)) = (outline.iter().min(), outline.iter().max()) else {
            continue;
        };
        let n_lines = usize::try_from((s_max - s_min + spacing - 1) / spacing).unwrap_or(0);
        let mut sections: Vec<Vec<(i64, i64)>> = Vec::with_capacity(n_lines);
        for i in 0..n_lines {
            let at = s_min + i64::try_from(i).unwrap_or(0) * spacing;
            sections.push(
                sections_at(&rings, at)
                    .into_iter()
                    .filter(|&(a, b)| (b - a).abs() > spacing)
                    .collect(),
            );
        }
        let sections = filter_vibrating(&sections);
        normal.extend(reconstruct(&sections, s_min, spacing, dir));
    }
    let normal_ex = union_shapes(&normal);
    let narrow = if normal_ex.is_empty() {
        region.clone()
    } else {
        perimeters::difference(region, &normal_ex)
    };
    // Pieces smaller than a line that touch normal infill join it.
    let mut normal_all = normal_ex;
    let mut keep: Shapes = Vec::new();
    for piece in narrow {
        let one: Shapes = vec![piece.clone()];
        if perimeters::offset(&one, -(sp / 2)).is_empty() {
            let grown = perimeters::offset(&one, sp * 3 / 10);
            // Natively only the part of the normal area near the sliver is cut (see `perimeters::near`).
            #[cfg(not(target_arch = "wasm32"))]
            let nearby = perimeters::near(&normal_all, perimeters::bounds(&grown));
            #[cfg(not(target_arch = "wasm32"))]
            let base = nearby.as_ref().unwrap_or(&normal_all);
            #[cfg(target_arch = "wasm32")]
            let base = &normal_all;
            if !normal_all.is_empty() && perimeters::overlap(base, &grown) {
                normal_all.push(piece);
                continue;
            }
        }
        keep.push(piece);
    }
    if keep.is_empty() {
        return (region.clone(), Vec::new());
    }
    let normal_out = if normal_all.is_empty() {
        Vec::new()
    } else {
        perimeters::intersection(&perimeters::offset(&union_shapes(&normal_all), sp / 2), region)
    };
    (normal_out, keep)
}

/// Radius of the circle Bambu's narrow test looks for on a straight band, mm: a band narrower than 6 mm is narrow.
const BAMBU_NARROW_MM: f64 = 3.0;

/// How far past its edges a piece reaches for Bambu's narrow test, internal units: half the line spacing of the
/// innermost wall, so the piece's outer edge sits at that wall's centerline, where the wall's bead and the solid
/// infill meet. The circle the piece must hold grows by the same reach on both sides, so a straight band is decided by
/// its own width as before; only a corner, where the grown piece widens, can hold the circle where the band alone
/// could not.
#[allow(
    clippy::cast_possible_truncation,
    reason = "half a line spacing in internal units"
)]
pub(crate) fn corner_reach(cfg: &crate::config::PrintConfig) -> i32 {
    if cfg.wall_loops == 0 {
        return 0;
    }
    let width = if cfg.wall_loops > 1 {
        cfg.inner_wall_width()
    } else {
        cfg.outer_wall_width()
    };
    (cfg.spacing_for(width) / 2.0 * crate::geom::SCALE).round() as i32
}

/// Whether a piece keeps its lines on a Bambu Lab printer: the piece grown by `reach` ([`corner_reach`]) holds a
/// circle 6 mm plus twice the reach across. The circle is the largest the shape really holds, so the corner of a ring,
/// where the band widens, counts; on a straight band the test is the 6 mm width test.
pub(crate) fn holds_lines(piece: &[Vec<IntPoint<i32>>], reach: i32) -> bool {
    let r = f64::from(mm(BAMBU_NARROW_MM)) + f64::from(reach.max(0));
    if reach <= 0 {
        return perimeters::disc_fits(piece, r);
    }
    perimeters::offset_round(&vec![piece.to_vec()], reach)
        .iter()
        .any(|grown| perimeters::disc_fits(grown, r))
}

/// Normal and narrow pieces as Bambu Lab printers decide them: each connected piece (an outline with its holes) is
/// narrow as a whole when it does not hold the circle [`holds_lines`] asks for, whatever the pattern, line direction
/// or width, and normal as a whole otherwise. A piece is never cut into a narrow and a normal part.
pub(crate) fn split_pieces(region: &Shapes, reach: i32) -> (Shapes, Shapes) {
    let (mut normal, mut narrow) = (Vec::new(), Vec::new());
    for shape in region {
        if holds_lines(shape, reach) {
            normal.push(shape.clone());
        } else {
            narrow.push(shape.clone());
        }
    }
    (normal, narrow)
}

/// Normal and narrow parts for patterns that are not straight lines: the region opened by one spacing is normal.
pub(crate) fn split_core(region: &Shapes, spacing_mm: f64) -> (Shapes, Shapes) {
    if region.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let sp = mm(spacing_mm);
    let eroded = perimeters::offset(region, -sp);
    let opened = if eroded.is_empty() {
        Vec::new()
    } else {
        perimeters::offset(&eroded, sp)
    };
    let core = perimeters::intersection(region, &opened);
    if core.is_empty() {
        return (Vec::new(), region.clone());
    }
    let narrow = perimeters::difference(region, &core);
    if narrow.is_empty() {
        return (core, Vec::new());
    }
    (core, narrow)
}

/// Orca's polygon reconstruction from the kept sections: each section is widened by half a spacing along
/// the line, and sections on neighboring lines that overlap are joined into one polygon.
#[allow(clippy::cast_precision_loss, reason = "coordinates stay far below 2^52")]
fn reconstruct(sections: &[Vec<(i64, i64)>], s_min: i64, spacing: i64, dir: Dir) -> Shapes {
    type P = (i64, i64);
    struct Traced {
        lows: Vec<P>,
        highs: Vec<P>,
    }
    let half = spacing / 2;
    let limit2 = {
        let l = 2.0 * spacing as f64;
        l * l
    };
    let d2 = |a: P, b: P| {
        let (x, y) = ((a.0 - b.0) as f64, (a.1 - b.1) as f64);
        x * x + y * y
    };
    let mut out: Vec<Vec<P>> = Vec::new();
    let mut current: Vec<Traced> = Vec::new();
    for (i, slice) in sections.iter().enumerate() {
        let x = s_min + i64::try_from(i).unwrap_or(0) * spacing;
        // Sections widened by half a spacing at both ends.
        let segs: Vec<(P, P)> = slice
            .iter()
            .map(|&(a, b)| ((x, a - half), (x, b + half)))
            .collect();
        let mut used = vec![false; segs.len()];
        for tr in &mut current {
            let (Some(&low), Some(&high)) = (tr.lows.last(), tr.highs.last()) else {
                continue;
            };
            let begin = segs.partition_point(|s| s.1.1 <= low.1);
            let end = segs.partition_point(|s| s.0.1 <= high.1);
            let mut added = false;
            let mut c = begin;
            while c < end && !added {
                if used.get(c).copied().unwrap_or(true) {
                    c += 1;
                    continue;
                }
                let Some(&(a, b)) = segs.get(begin) else { break };
                if d2(low, a) < limit2 {
                    tr.lows.push(a);
                } else {
                    tr.lows.push((low.0 + half, low.1));
                    tr.lows.push((a.0 - half, a.1));
                    tr.lows.push(a);
                }
                if d2(high, b) < limit2 {
                    tr.highs.push(b);
                } else {
                    tr.highs.push((high.0 + half, high.1));
                    tr.highs.push((b.0 - half, b.1));
                    tr.highs.push(b);
                }
                added = true;
                if let Some(u) = used.get_mut(begin) {
                    *u = true;
                }
            }
            if !added {
                tr.lows.push((low.0 + half, low.1));
                tr.highs.push((high.0 + half, high.1));
                let mut poly = std::mem::take(&mut tr.lows);
                poly.extend(std::mem::take(&mut tr.highs).into_iter().rev());
                out.push(poly);
            }
        }
        current.retain(|t| !t.lows.is_empty());
        for (k, &(a, b)) in segs.iter().enumerate() {
            if !used.get(k).copied().unwrap_or(true) {
                current.push(Traced {
                    lows: vec![(a.0 - half, a.1), a],
                    highs: vec![(b.0 - half, b.1), b],
                });
            }
        }
    }
    for tr in current {
        let mut poly = tr.lows;
        poly.extend(tr.highs.into_iter().rev());
        out.push(poly);
    }
    out.into_iter()
        .filter(|p| p.len() >= 3)
        .map(|p| {
            let ring: Vec<IntPoint<i32>> = p
                .iter()
                .map(|&(s, t)| {
                    let q = dir.point(s, t);
                    IntPoint::new(q.x, q.y)
                })
                .collect();
            vec![ring]
        })
        .collect()
}

/// The concentric fill of a narrow region: its variable-width walls, as thick lines (points with a
/// width each), filling the region to its middle.
pub(crate) fn concentric_lines(
    narrow: &Shapes,
    cfg: &crate::config::PrintConfig,
    spacing_mm: f64,
    layer_height: f64,
) -> Vec<crate::arachne::WallLine> {
    let clip = loop_clipping(cfg);
    concentric_beads(narrow, cfg, spacing_mm, layer_height)
        .into_iter()
        .flat_map(|w| order_band(w, clip))
        .collect()
}

/// The variable-width beads that fill each piece of a narrow region to its middle, one list per piece, unordered.
pub(crate) fn concentric_beads(
    narrow: &Shapes,
    cfg: &crate::config::PrintConfig,
    spacing_mm: f64,
    layer_height: f64,
) -> Vec<Vec<crate::arachne::WallLine>> {
    let Some(b) = perimeters::bounds(narrow) else {
        return Vec::new();
    };
    let size = f64::from(b[2] - b[0]).max(f64::from(b[3] - b[1])) / crate::geom::SCALE;
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a small loop count"
    )]
    let loops = (size / spacing_mm) as usize + 1;
    let nozzle = cfg.nozzle_diameter;
    let prm = crate::arachne::Params {
        bead_width_0: spacing_mm,
        bead_width_x: spacing_mm,
        inset_count: loops,
        wall_0_inset: 0.0,
        layer_height,
        nozzle_diameter: nozzle,
        min_feature_size: 25.0,
        min_bead_width: 85.0,
        wall_transition_length: 40.0 / nozzle.max(0.01),
        wall_transition_filter_deviation: 25.0,
        wall_transition_angle: 10.0,
        wall_distribution_count: 1,
        ..crate::arachne::Params::default()
    };
    let mut out = Vec::new();
    for shape in narrow {
        let one: Shapes = vec![shape.clone()];
        let run = |s: &Shapes| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| crate::arachne::walls(s, &prm)))
        };
        // The Voronoi builder can reject a sliver left by clipping; a 0.01 mm opening removes it.
        let walls = if let Ok(w) = run(&one) {
            w
        } else {
            #[allow(clippy::cast_possible_truncation, reason = "a few hundred units")]
            let eps = (0.01 * crate::geom::SCALE).round() as i32;
            let opened = perimeters::offset(&perimeters::offset(&one, -eps), eps);
            run(&opened).unwrap_or(None)
        };
        if let Some(w) = walls {
            out.push(w.lines);
        }
    }
    out
}

/// The clipping at the end of a fill loop: `seam_gap`, a length or a percent of the nozzle.
pub(crate) fn loop_clipping(cfg: &crate::config::PrintConfig) -> f64 {
    let nozzle = cfg.nozzle_diameter;
    match cfg.raw.get("seam_gap") {
        Some(serde_json::Value::String(t)) if t.trim().ends_with('%') => t
            .trim()
            .trim_end_matches('%')
            .trim()
            .parse::<f64>()
            .map_or(0.0, |p| nozzle * p / 100.0),
        Some(v) => v
            .as_f64()
            .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
            .unwrap_or(0.0),
        None => nozzle * 0.1,
    }
    .max(0.0)
}

/// The beads of one band in the order Orca prints them: a closed bead starts
/// at its point nearest the origin, every bead loses `clip` mm at its end (so a loop does not print over its
/// own start), and the beads are chained by their start points.
fn order_band(lines: Vec<crate::arachne::WallLine>, clip: f64) -> Vec<crate::arachne::WallLine> {
    let mut kept: Vec<crate::arachne::WallLine> = Vec::with_capacity(lines.len());
    for mut l in lines {
        if l.points.len() < 2 || l.widths.len() != l.points.len() {
            continue;
        }
        let closed = l.points.first() == l.points.last() && l.widths.first() == l.widths.last();
        if closed && l.points.len() > 2 {
            l.points.pop();
            l.widths.pop();
            let d2 = |p: &IntPoint<i32>| i64::from(p.x).pow(2) + i64::from(p.y).pow(2);
            let k = (0..l.points.len())
                .min_by_key(|&i| l.points.get(i).map_or(i64::MAX, d2))
                .unwrap_or(0);
            l.points.rotate_left(k);
            l.widths.rotate_left(k);
            if let (Some(&p), Some(&w)) = (l.points.first(), l.widths.first()) {
                l.points.push(p);
                l.widths.push(w);
            }
        }
        clip_end(&mut l.points, &mut l.widths, clip);
        l.closed = false;
        let long = l.points.windows(2).any(|s| matches!(s, [a, b] if a != b));
        if l.points.len() >= 2 && long {
            kept.push(l);
        }
    }
    // OrcaSlicer chains the beads by their start points alone, so a bead may start far from where
    // the one before it ended. Taking next the bead whose start is nearest the last bead's end, from the origin
    // as Orca's loop starts are, keeps the beads of a band in one sweep.
    let mut order: Vec<usize> = Vec::with_capacity(kept.len());
    let mut used = vec![false; kept.len()];
    let mut at = IntPoint::new(0, 0);
    for _ in 0..kept.len() {
        let d2 = |p: &IntPoint<i32>| i64::from(p.x - at.x).pow(2) + i64::from(p.y - at.y).pow(2);
        let Some(next) = (0..kept.len())
            .filter(|&i| !used.get(i).copied().unwrap_or(true))
            .min_by_key(|&i| kept.get(i).and_then(|l| l.points.first()).map_or(i64::MAX, d2))
        else {
            break;
        };
        if let Some(u) = used.get_mut(next) {
            *u = true;
        }
        at = kept
            .get(next)
            .and_then(|l| l.points.last().copied())
            .unwrap_or(at);
        order.push(next);
    }
    let mut slots: Vec<Option<crate::arachne::WallLine>> = kept.into_iter().map(Some).collect();
    order
        .into_iter()
        .filter_map(|i| slots.get_mut(i).and_then(Option::take))
        .collect()
}

/// Takes `d` mm off the end of a bead; the cut end keeps the width of the point it replaces.
pub(crate) fn clip_end(points: &mut Vec<IntPoint<i32>>, widths: &mut Vec<i32>, d: f64) {
    let mut left = d * crate::geom::SCALE;
    while left > 0.0 && points.len() >= 2 {
        let (Some(&b), Some(&a)) = (points.last(), points.get(points.len() - 2)) else {
            break;
        };
        let len = f64::from(b.x - a.x).m_hypot(f64::from(b.y - a.y));
        if len > left {
            let t = (len - left) / len;
            #[allow(clippy::cast_possible_truncation, reason = "a point between two i32 points")]
            let cut = IntPoint::new(
                (f64::from(a.x) + f64::from(b.x - a.x) * t).round() as i32,
                (f64::from(a.y) + f64::from(b.y - a.y) * t).round() as i32,
            );
            if let Some(last) = points.last_mut() {
                *last = cut;
            }
            return;
        }
        left -= len;
        points.pop();
        widths.pop();
    }
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)]
mod tests {
    use super::*;

    /// A shape from rings of points in mm (outer counterclockwise, holes clockwise).
    fn shape(rings: &[&[[f64; 2]]]) -> Vec<Vec<IntPoint<i32>>> {
        rings
            .iter()
            .map(|r| r.iter().map(|p| IntPoint::new(mm(p[0]), mm(p[1]))).collect())
            .collect()
    }

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<[f64; 2]> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    #[test]
    fn a_bambu_piece_is_narrow_when_no_6_mm_circle_fits() {
        // A 40 mm bar just under and just over 6 mm wide.
        let thin = vec![shape(&[&rect(0.0, 0.0, 40.0, 5.95)])];
        let wide = vec![shape(&[&rect(0.0, 0.0, 40.0, 6.05)])];
        assert_eq!(split_pieces(&thin, 0), (Vec::new(), thin.clone()));
        assert_eq!(split_pieces(&wide, 0), (wide.clone(), Vec::new()));
        // Turned, it is the same: no line direction enters the test.
        let diag = |w: f64| {
            let (c, s) = (std::f64::consts::FRAC_1_SQRT_2, std::f64::consts::FRAC_1_SQRT_2);
            let pts: Vec<[f64; 2]> = rect(0.0, 0.0, 40.0, w)
                .iter()
                .map(|p| [50.0 + p[0] * c - p[1] * s, 50.0 + p[0] * s + p[1] * c])
                .collect();
            vec![shape(&[&pts])]
        };
        assert!(split_pieces(&diag(5.95), 0).0.is_empty());
        assert!(split_pieces(&diag(6.05), 0).1.is_empty());
    }

    #[test]
    fn a_bambu_piece_is_never_cut() {
        // A 30 by 12 mm body with a 2.5 mm wide arm: one piece, wide somewhere, so all of it keeps its lines.
        let t: Vec<[f64; 2]> = vec![
            [0.0, 0.0],
            [30.0, 0.0],
            [30.0, 12.0],
            [16.25, 12.0],
            [16.25, 27.5],
            [13.75, 27.5],
            [13.75, 12.0],
            [0.0, 12.0],
        ];
        let piece = vec![shape(&[&t])];
        assert_eq!(split_pieces(&piece, 0), (piece.clone(), Vec::new()));
        // Two pieces side by side are decided apart.
        let two = vec![
            shape(&[&rect(0.0, 0.0, 30.0, 5.0)]),
            shape(&[&rect(0.0, 11.0, 30.0, 23.0)]),
        ];
        let (normal, narrow) = split_pieces(&two, 0);
        assert_eq!((normal, narrow), (vec![two[1].clone()], vec![two[0].clone()]));
    }

    /// Whether `shape`'s outer ring spans less than `w` internal units in x or in y.
    fn box_side_under(shape: &[Vec<IntPoint<i32>>], w: i64) -> bool {
        shape
            .first()
            .filter(|r| r.len() >= 3)
            .and_then(|r| perimeters::ring_bounds(r))
            .is_some_and(|b| i64::from(b[2]) - i64::from(b[0]) < w || i64::from(b[3]) - i64::from(b[1]) < w)
    }

    /// `split_lines` with every inward offset taken in full, so none of them can leave early. A shape whose outer box
    /// is under `skip_under` units across is also dropped before its opening (0 drops none): a stand-in for a wrong
    /// bound. The property tests below hold `split_lines` equal to it with no bound.
    fn split_lines_reference(
        region: &Shapes,
        dir: Dir,
        spacing: i64,
        spacing_mm: f64,
        skip_under: i64,
    ) -> (Shapes, Shapes) {
        if region.is_empty() {
            return (Vec::new(), Vec::new());
        }
        let sp = mm(spacing_mm);
        let spacing = spacing.max(1);
        let mut normal: Shapes = Vec::new();
        for shape in region {
            if skip_under > 0 && box_side_under(shape, skip_under) {
                continue;
            }
            let one: Shapes = vec![shape.clone()];
            let eroded = perimeters::offset_full(&one, -(2 * sp));
            let opened = if eroded.is_empty() {
                Vec::new()
            } else {
                perimeters::offset(&eroded, 3 * sp)
            };
            let core = perimeters::intersection(&one, &opened);
            if core.is_empty() {
                continue;
            }
            let inner_area = perimeters::offset_full(&core, -(sp / 2));
            let rings: Vec<Vec<(i64, i64)>> = inner_area
                .iter()
                .flat_map(|s| s.iter())
                .map(|r| r.iter().map(|p| dir.st(p.x, p.y)).collect())
                .collect();
            let outline: Vec<i64> = shape.iter().flatten().map(|p| dir.st(p.x, p.y).0).collect();
            let (Some(&s_min), Some(&s_max)) = (outline.iter().min(), outline.iter().max()) else {
                continue;
            };
            let n_lines = usize::try_from((s_max - s_min + spacing - 1) / spacing).unwrap_or(0);
            let mut sections: Vec<Vec<(i64, i64)>> = Vec::with_capacity(n_lines);
            for i in 0..n_lines {
                let at = s_min + i64::try_from(i).unwrap_or(0) * spacing;
                sections.push(
                    sections_at(&rings, at)
                        .into_iter()
                        .filter(|&(a, b)| (b - a).abs() > spacing)
                        .collect(),
                );
            }
            let sections = filter_vibrating(&sections);
            normal.extend(reconstruct(&sections, s_min, spacing, dir));
        }
        let normal_ex = union_shapes(&normal);
        let narrow = if normal_ex.is_empty() {
            region.clone()
        } else {
            perimeters::difference(region, &normal_ex)
        };
        let mut normal_all = normal_ex;
        let mut keep: Shapes = Vec::new();
        for piece in narrow {
            let one: Shapes = vec![piece.clone()];
            if perimeters::offset_full(&one, -(sp / 2)).is_empty() {
                let grown = perimeters::offset(&one, sp * 3 / 10);
                #[cfg(not(target_arch = "wasm32"))]
                let nearby = perimeters::near(&normal_all, perimeters::bounds(&grown));
                #[cfg(not(target_arch = "wasm32"))]
                let base = nearby.as_ref().unwrap_or(&normal_all);
                #[cfg(target_arch = "wasm32")]
                let base = &normal_all;
                if !normal_all.is_empty() && perimeters::overlap(base, &grown) {
                    normal_all.push(piece);
                    continue;
                }
            }
            keep.push(piece);
        }
        if keep.is_empty() {
            return (region.clone(), Vec::new());
        }
        let normal_out = if normal_all.is_empty() {
            Vec::new()
        } else {
            perimeters::intersection(&perimeters::offset(&union_shapes(&normal_all), sp / 2), region)
        };
        (normal_out, keep)
    }

    /// A small deterministic generator (xorshift), so the cases repeat.
    struct Rng(u64);

    impl Rng {
        #[allow(clippy::cast_precision_loss, reason = "a unit fraction")]
        fn unit(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }

        fn range(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (hi - lo) * self.unit()
        }

        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss,
            reason = "a small index"
        )]
        fn pick(&mut self, n: usize) -> usize {
            ((self.unit() * f64::from(u32::try_from(n).unwrap_or(u32::MAX))) as usize).min(n - 1)
        }
    }

    /// Points in internal units, turned by `angle` about the origin and moved to `at`.
    fn placed(points: &[[f64; 2]], angle: f64, at: [f64; 2]) -> Vec<IntPoint<i32>> {
        let (s, c) = angle.m_sin_cos();
        #[allow(clippy::cast_possible_truncation, reason = "plate coordinates")]
        points
            .iter()
            .map(|p| {
                IntPoint::new(
                    (at[0] + p[0] * c - p[1] * s).round() as i32,
                    (at[1] + p[0] * s + p[1] * c).round() as i32,
                )
            })
            .collect()
    }

    /// One random shape, sized around `sp` internal units: a strip, an L, a ring, a tiny island, a star, or an
    /// axis-aligned box whose narrow side is within a few units of 4 spacings.
    fn random_shape(rng: &mut Rng, sp: f64) -> Vec<Vec<IntPoint<i32>>> {
        let at = [rng.range(-2.0e5, 2.0e5), rng.range(-2.0e5, 2.0e5)];
        let angle = if rng.unit() < 0.3 {
            0.0
        } else {
            rng.range(0.0, std::f64::consts::TAU)
        };
        let box_pts = |w: f64, h: f64| vec![[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]];
        match rng.pick(6) {
            0 => {
                let w = rng.range(0.5, 7.0) * sp;
                let l = rng.range(4.0, 60.0) * sp;
                vec![placed(&box_pts(l, w), angle, at)]
            }
            1 => {
                let (w1, w2) = (rng.range(0.8, 8.0) * sp, rng.range(0.8, 8.0) * sp);
                let (l1, l2) = (rng.range(6.0, 40.0) * sp, rng.range(6.0, 40.0) * sp);
                let pts = vec![[0.0, 0.0], [l1, 0.0], [l1, w1], [w2, w1], [w2, l2], [0.0, l2]];
                vec![placed(&pts, angle, at)]
            }
            2 => {
                let side = rng.range(5.0, 40.0) * sp;
                let band = rng.range(0.5, 6.0) * sp;
                let mut hole = placed(
                    &box_pts(side - 2.0 * band, side - 2.0 * band),
                    angle,
                    [
                        at[0] + band * angle.m_cos() - band * angle.m_sin(),
                        at[1] + band * angle.m_sin() + band * angle.m_cos(),
                    ],
                );
                hole.reverse();
                vec![placed(&box_pts(side, side), angle, at), hole]
            }
            3 => {
                let (w, h) = (rng.range(0.05, 3.0) * sp, rng.range(0.05, 3.0) * sp);
                vec![placed(&box_pts(w, h), angle, at)]
            }
            4 => {
                let n = 5 + u32::try_from(rng.pick(20)).unwrap_or(0);
                let r0 = rng.range(1.0, 6.0) * sp;
                let pts: Vec<[f64; 2]> = (0..n)
                    .map(|i| {
                        let a = std::f64::consts::TAU * f64::from(i) / f64::from(n);
                        let r = r0 * rng.range(0.4, 1.0);
                        [r * a.m_cos(), r * a.m_sin()]
                    })
                    .collect();
                vec![placed(&pts, 0.0, at)]
            }
            _ => {
                // Right at the bound: the narrow side is 4 spacings give or take 3 units, axis-aligned so the box is exact.
                let w = (4.0 * sp).round() + f64::from(i32::try_from(rng.pick(7)).unwrap_or(0) - 3);
                let l = rng.range(5.0, 50.0) * sp;
                let pts = if rng.unit() < 0.5 {
                    box_pts(l, w)
                } else {
                    box_pts(w, l)
                };
                vec![placed(&pts, 0.0, at)]
            }
        }
    }

    #[test]
    fn the_early_exit_in_offset_leaves_the_split_unchanged() {
        let mut rng = Rng(0x5eed_5b1f_7a11_ce55);
        let (mut cases, mut small, mut large) = (0, 0, 0);
        for &spacing_mm in &[0.35, 0.42, 0.45, 0.5, 0.62, 0.8] {
            let sp = mm(spacing_mm);
            let spacing = crate::paths::t_units(spacing_mm);
            for _ in 0..200 {
                let n = 1 + rng.pick(4);
                let region: Shapes = (0..n).map(|_| random_shape(&mut rng, f64::from(sp))).collect();
                for s in &region {
                    if box_side_under(s, 4 * i64::from(sp)) {
                        small += 1;
                    } else {
                        large += 1;
                    }
                }
                for dir in [Dir::D45, Dir::D135] {
                    assert_eq!(
                        split_lines(&region, dir, spacing, spacing_mm),
                        split_lines_reference(&region, dir, spacing, spacing_mm, 0),
                        "spacing {spacing_mm} mm, {dir:?}, region {region:?}"
                    );
                    cases += 1;
                }
            }
        }
        // Both sides of the bound are covered.
        assert_eq!(cases, 2400);
        assert!(
            small > 500 && large > 500,
            "under the bound {small}, over it {large}"
        );
    }

    #[test]
    fn the_early_exit_in_offset_holds_right_at_4_spacings() {
        // Axis-aligned bars whose narrow side runs from 4 spacings less 8 units to 4 spacings plus 8, every unit.
        for &spacing_mm in &[0.42, 0.45, 0.5] {
            let sp = mm(spacing_mm);
            let spacing = crate::paths::t_units(spacing_mm);
            for dw in -8..=8 {
                let w = 4 * sp + dw;
                let l = 40 * sp;
                let flat = vec![vec![
                    IntPoint::new(0, 0),
                    IntPoint::new(l, 0),
                    IntPoint::new(l, w),
                    IntPoint::new(0, w),
                ]];
                let tall = vec![vec![
                    IntPoint::new(0, 0),
                    IntPoint::new(w, 0),
                    IntPoint::new(w, l),
                    IntPoint::new(0, l),
                ]];
                assert_eq!(box_side_under(&flat, 4 * i64::from(sp)), dw < 0);
                for region in [vec![flat], vec![tall]] {
                    for dir in [Dir::D45, Dir::D135] {
                        assert_eq!(
                            split_lines(&region, dir, spacing, spacing_mm),
                            split_lines_reference(&region, dir, spacing, spacing_mm, 0),
                            "spacing {spacing_mm} mm, width {w}, {dir:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn an_early_exit_at_5_spacings_is_caught() {
        // The same comparison with the bound moved out to 5 spacings, which drops shapes that have a core, must
        // disagree with the split somewhere across the spacings.
        let mut rng = Rng(0x5eed_5b1f_7a11_ce55);
        let mut caught = 0;
        for &spacing_mm in &[0.35, 0.42, 0.45, 0.5, 0.62, 0.8] {
            let sp = mm(spacing_mm);
            let spacing = crate::paths::t_units(spacing_mm);
            for _ in 0..200 {
                let n = 1 + rng.pick(4);
                let region: Shapes = (0..n).map(|_| random_shape(&mut rng, f64::from(sp))).collect();
                for dir in [Dir::D45, Dir::D135] {
                    if split_lines(&region, dir, spacing, spacing_mm)
                        != split_lines_reference(&region, dir, spacing, spacing_mm, 5 * i64::from(sp))
                    {
                        caught += 1;
                    }
                }
            }
        }
        assert!(caught > 0, "a bound of 5 spacings went unnoticed");
    }

    /// The diameter of the largest circle in `shape`, mm, to half a micron.
    fn inscribed(shape: &[Vec<IntPoint<i32>>]) -> f64 {
        let (mut lo, mut hi) = (0.0, 100.0);
        while hi - lo > 0.0005 {
            let mid = f64::midpoint(lo, hi);
            if perimeters::disc_fits(shape, f64::from(mm(mid / 2.0))) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        lo
    }

    /// A 40 mm square ring `w` wide round a square hole.
    fn square_ring(w: f64) -> Vec<Vec<IntPoint<i32>>> {
        let hole: Vec<[f64; 2]> = rect(w, w, 40.0 - w, 40.0 - w).into_iter().rev().collect();
        shape(&[&rect(0.0, 0.0, 40.0, 40.0), &hole])
    }

    #[test]
    fn the_largest_circle_in_a_sharp_corner_is_1_17_band_widths() {
        // At a sharp 90 degree corner of a band w wide, the circle touches both outer sides and the hole's corner:
        // 2 w / (1 + sin 45 degrees), about 1.172 w. A straight strip holds w.
        let corner = 2.0 / (1.0 + std::f64::consts::FRAC_1_SQRT_2);
        for w in [3.0, 4.0, 5.0] {
            let d = inscribed(&square_ring(w));
            assert!((d - corner * w).abs() < 0.002, "ring {w}: {d}");
            let d = inscribed(&shape(&[&rect(0.0, 0.0, 40.0, w)]));
            assert!((d - w).abs() < 0.002, "strip {w}: {d}");
        }
        // A hexagon ring (120 degree corners): 2 w / (1 + sin 60 degrees).
        let hex = |r: f64| -> Vec<[f64; 2]> {
            (0..6)
                .map(|k| {
                    let a = (60.0 * f64::from(k)).to_radians();
                    [50.0 + r * a.m_cos(), 50.0 + r * a.m_sin()]
                })
                .collect()
        };
        let w = 4.0;
        let (ro, ri) = (15.0, 15.0 - w);
        let to_corner = 2.0 / 3.0_f64.sqrt();
        let hole: Vec<[f64; 2]> = hex(ri * to_corner).into_iter().rev().collect();
        let d = inscribed(&shape(&[&hex(ro * to_corner), &hole]));
        let want = 2.0 * w / (1.0 + 60.0_f64.to_radians().m_sin());
        assert!((d - want).abs() < 0.002, "hexagon {d} against {want}");
    }

    #[test]
    fn a_sharp_ring_keeps_its_lines_where_its_corner_holds_6_mm() {
        // A 5.3 mm ring's corners hold a 6.2 mm circle; a 5.0 mm ring's hold 5.86 mm, and a 5.3 mm strip 5.3 mm.
        let wide = vec![square_ring(5.3)];
        assert_eq!(split_pieces(&wide, 0), (wide.clone(), Vec::new()));
        let thin = vec![square_ring(5.0)];
        assert_eq!(split_pieces(&thin, 0), (Vec::new(), thin.clone()));
        let strip = vec![shape(&[&rect(0.0, 0.0, 40.0, 5.3)])];
        assert_eq!(split_pieces(&strip, 0), (Vec::new(), strip.clone()));
    }

    #[test]
    fn the_corner_reach_leaves_a_straight_band_as_it_was() {
        // The circle grows with the reach, so a strip is still decided at 6 mm.
        let reach = mm(0.2035);
        let strip = |w: f64| vec![shape(&[&rect(0.0, 0.0, 40.0, w)])];
        assert!(split_pieces(&strip(5.95), reach).0.is_empty());
        assert!(split_pieces(&strip(6.05), reach).1.is_empty());
        // At a ring's corner the grown piece rounds the hole's corner, which widens it a little: a 5.1 mm ring holds
        // the circle with the reach (6.04 mm) and not without (5.98 mm); a 5.0 mm ring holds it with neither.
        let ring = |w: f64| vec![square_ring(w)];
        assert!(split_pieces(&ring(5.1), reach).1.is_empty());
        assert!(split_pieces(&ring(5.1), 0).0.is_empty());
        assert!(split_pieces(&ring(5.0), reach).0.is_empty());
    }

    #[test]
    fn a_ring_round_a_hole_is_narrow() {
        // A 12 mm square round a 7 mm hole: a 2.5 mm ring.
        let hole: Vec<[f64; 2]> = rect(2.5, 2.5, 9.5, 9.5).into_iter().rev().collect();
        let ring = vec![shape(&[&rect(0.0, 0.0, 12.0, 12.0), &hole])];
        assert_eq!(split_pieces(&ring, 0), (Vec::new(), ring.clone()));
    }
}
