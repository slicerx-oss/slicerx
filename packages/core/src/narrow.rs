// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Narrow internal solid infill. Orca (`split_solid_surface` in `Fill/Fill.cpp`) splits an internal solid
//! surface into the part where full scanlines fit and the narrow rest, the bands a sloped wall leaves.
//! The narrow rest is not filled with lines: `FillConcentricInternal` runs the variable-width wall
//! generator over it, so a band a line and a half wide gets one or two beads that follow it.
//!
//! The split follows Orca's anti-vibration rule (from `PrusaSlicer`'s `FillEnsuring.cpp`): scanline
//! sections longer than one spacing are kept, chains of short ones are dropped, and the area the kept
//! sections cover is the normal infill.

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

/// Orca's `filter_vibrating_extrusions`: drops chains of short sections. Sections are per scanline,
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
/// at `spacing` (in `s` units, `spacing_mm` in mm), as `split_solid_surface` does.
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

/// `FillConcentricInternal`: the variable-width walls of the narrow region, as thick lines (points with a
/// width each), filling the region to its middle.
pub(crate) fn concentric_lines(
    narrow: &Shapes,
    cfg: &crate::config::PrintConfig,
    spacing_mm: f64,
    layer_height: f64,
) -> Vec<crate::arachne::WallLine> {
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
            out.extend(order_band(w.lines, loop_clipping(cfg)));
        }
    }
    out
}

/// Orca's `loop_clipping` for fills: `seam_gap`, a length or a percent of the nozzle.
fn loop_clipping(cfg: &crate::config::PrintConfig) -> f64 {
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

/// The beads of one band as `FillConcentricInternal::fill_surface_extrusion` hands them on: a closed bead starts
/// at its point nearest the origin, every bead loses `clip` mm at its end (so a loop does not print over its
/// own start), and the beads are chained by their start points (`reorder_by_shortest_traverse`).
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
    // Orca chains the beads by their start points alone (`chain_points`), so a bead may start far from where
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
fn clip_end(points: &mut Vec<IntPoint<i32>>, widths: &mut Vec<i32>, d: f64) {
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
