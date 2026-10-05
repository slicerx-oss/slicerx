// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Normal supports. Where a layer's outline reaches further past the layer
//! below than the threshold angle allows, everything under it down to the
//! bed (or to the model, or only to the bed when the setting says so) gets a
//! column of support, kept a gap away from the part in XY and in Z. The
//! layers just under an overhang are interface layers, printed denser.
//!
//! The area on layer `i` depends on every layer above it, so it is planned
//! once for the whole plate, not per layer range.

use crate::config::{SupportConfig, SupportStyle};
use crate::fm::Fm as _;
use crate::geom::SCALE;
use crate::perimeters::{self, Shapes};
use crate::supportgrid::GridPattern;
use i_overlay::i_float::int::point::IntPoint;

/// Support to print on one layer.
#[derive(Debug, Clone, Default)]
pub(crate) struct SupportLayer {
    /// Base support (sparse lines), without the interface.
    pub(crate) base: Shapes,
    /// The layers directly under an overhang (dense lines).
    pub(crate) interface: Shapes,
    /// Hybrid trees: the part of `base` that is normal support (rows, no walls) rather than branches.
    pub(crate) normal: Shapes,
    /// The part of `interface` that is the top contact (the layer right under an overhang), which
    /// contact loops and support ironing work on.
    pub(crate) contact: Shapes,
    /// The overhangs that contact holds up.
    pub(crate) hang: Shapes,
    /// The part of `interface` that is bottom interface only (resting on the part, not under an overhang),
    /// printed at `support_bottom_interface_spacing`.
    pub(crate) bottom: Shapes,
    /// Slim, strong and hybrid trees: the layer's areas by kind, which their toolpaths read.
    pub(crate) classic: Option<std::sync::Arc<crate::treeclassic::TreeLayer>>,
    /// Organic trees: the layer's areas by kind, which their toolpaths read.
    pub(crate) organic: Option<std::sync::Arc<crate::organic::OrganicLayer>>,
}

pub(crate) fn units(mm: f64) -> i32 {
    #[allow(clippy::cast_possible_truncation, reason = "distances are a few millimeters")]
    {
        (mm * SCALE).round() as i32
    }
}

/// Areas narrower than 1.5 line widths are dropped; a strand that thin
/// would not stand.
pub(crate) fn open(area: &Shapes, w: i32) -> Shapes {
    if area.is_empty() {
        return Vec::new();
    }
    let r = w * 3 / 4;
    perimeters::offset(&perimeters::offset(area, -r), r)
}

/// Rings simplified to 0.0125 mm (Orca's `resolution`), rings left with fewer than three points dropped.
fn tidy(area: Shapes) -> Shapes {
    area.into_iter()
        .filter_map(|sh| {
            let mut rings = sh
                .into_iter()
                .map(|r| perimeters::simplify_ring(&r, 125))
                .filter(|r| r.len() >= 3);
            let outer = rings.next()?;
            Some(std::iter::once(outer).chain(rings).collect::<Vec<_>>())
        })
        .collect()
}

/// Gaps between support and part in whole layers of `layer_mm`: above the support, below it.
pub(crate) fn gap_layers(cfg: &SupportConfig, layer_mm: f64) -> (usize, usize) {
    let layer_mm = layer_mm.max(0.01);
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "gaps are a few layers"
    )]
    (
        (cfg.top_z_distance / layer_mm).round() as usize,
        (cfg.bottom_z_distance / layer_mm).round() as usize,
    )
}

/// What each layer needs held up: its outline beyond what the layer below, grown by the step the
/// threshold angle allows, reaches; plus what enforcers ask for, less what blockers keep out.
pub(crate) fn overhangs(
    models: &[Shapes],
    thickness: &[f64],
    cfg: &SupportConfig,
    w: i32,
    force: &[Shapes],
    block: &[Shapes],
) -> Vec<Shapes> {
    let n = models.len();
    let tree = cfg.style.is_tree() || cfg.tree;
    let layer_mm = thickness.first().copied().unwrap_or(0.2).max(0.01);
    let empty: Shapes = Vec::new();
    let model = |i: usize| models.get(i).unwrap_or(&empty);
    let hang: Vec<Shapes> = (0..n)
        .map(|i| {
            let here = model(i);
            if i == 0 || here.is_empty() {
                return Vec::new();
            }
            if tree {
                let slope = cfg.threshold_angle.max(1.0).to_radians().m_tan();
                let step = units(thickness.get(i).copied().unwrap_or(layer_mm) / slope);
                let reach = perimeters::offset(model(i - 1), step);
                return open(&perimeters::difference(here, &reach), w);
            }
            let lower_mm = thickness.get(i - 1).copied().unwrap_or(layer_mm);
            open(&normal_overhang(here, model(i - 1), i, lower_mm, cfg), w)
        })
        .collect();
    // Manual supports come only from enforcers; enforcers add overhangs of any angle (the
    // underside of the part inside them), and blockers take support away.
    hang.into_iter()
        .enumerate()
        .map(|(i, h)| {
            let mut h = if cfg.manual { Vec::new() } else { h };
            if let (Some(f), true) = (force.get(i).filter(|f| !f.is_empty()), i > 0) {
                let under = perimeters::difference(model(i), model(i - 1));
                // On a gentle slope the ring is thin each layer: grow it one line inward so
                // the column under it is wide enough to print.
                let ring = perimeters::intersection(&perimeters::offset(&under, w), model(i));
                let forced = perimeters::intersection(&ring, f);
                h = perimeters::union_all(&[&h, &forced]);
            }
            match block.get(i).filter(|b| !b.is_empty()) {
                // Normal supports take blockers grown by 0.1 mm (Orca's `SupportAnnotations`); blockers only
                // cut the overhangs, so the grid may still reach back into them by up to a cell.
                Some(b) if !tree => perimeters::difference(&h, &perimeters::offset(b, units(0.1))),
                Some(b) => perimeters::difference(&h, b),
                None => h,
            }
        })
        .collect()
}

/// The overhang of layer `i` for normal supports, as Orca's `detect_overhangs` finds it: the outline
/// beyond the layer below grown by the step the threshold angle allows (the angle plus one degree, at most
/// 89; an angle of 0 uses `support_threshold_overlap` of the outer wall width instead), grown back by that
/// step inside the outline so the column under it is as wide as the whole overhang. On the first
/// `enforce_support_layers` layers everything beyond the layer below counts. Bridges are left out with
/// `bridge_no_support`; `support_expansion` grows the result.
fn normal_overhang(here: &Shapes, lower: &Shapes, i: usize, lower_mm: f64, cfg: &SupportConfig) -> Shapes {
    let fw = cfg.walls.1;
    let step_mm = if i < cfg.enforce_layers as usize {
        0.0
    } else if cfg.threshold_angle > 0.0 {
        lower_mm / (cfg.threshold_angle + 1.0).min(89.0).to_radians().m_tan()
    } else {
        fw - fw * cfg.threshold_overlap / 100.0
    };
    let step = units(step_mm);
    let mut diff = if step == 0 {
        perimeters::difference(here, lower)
    } else {
        let d = perimeters::difference(here, &perimeters::offset(lower, step));
        if d.is_empty() {
            return d;
        }
        perimeters::difference(
            &perimeters::intersection(&perimeters::offset(&d, step), here),
            lower,
        )
    };
    if cfg.bridge_no_support && !diff.is_empty() {
        diff = perimeters::difference(&diff, &bridges(here, lower, cfg));
    }
    // Drop it when nothing is wider than a fifth of the outer wall.
    if perimeters::offset(&diff, -units(0.1 * fw)).is_empty() {
        return Vec::new();
    }
    if cfg.expansion.abs() > 1e-9 {
        diff = perimeters::offset(&diff, units(cfg.expansion));
    }
    diff
}

/// What `bridge_no_support` leaves unsupported on a layer (Orca's `remove_bridges_from_contacts`): the
/// bottom surfaces over air inside the walls (all bridges when the top gap is above zero), and every wall
/// piece over air that is straight and rests on the layer below at both ends, as a band of its width.
fn bridges(here: &Shapes, lower: &Shapes, cfg: &SupportConfig) -> Shapes {
    let (loops, outer, inner, nozzle) = cfg.walls;
    let fw = units(outer);
    // The area the walls leave for the fill.
    let walls_mm = outer + inner * f64::from(loops.saturating_sub(1));
    let fill = perimeters::offset(here, -units(walls_mm));
    let mut out = perimeters::difference(&fill, lower);
    // The walls over air, outside the lower layer grown by half the nozzle.
    let grown = perimeters::offset(lower, units(0.5 * nozzle));
    let mut bands: Vec<Shapes> = Vec::new();
    for k in 0..loops.max(1) {
        let inset = if k == 0 {
            0.5 * outer
        } else {
            outer + inner * (f64::from(k) - 0.5)
        };
        for ring in perimeters::offset(here, -units(inset))
            .iter()
            .flat_map(|s| s.iter())
        {
            let count = ring.len();
            for e in 0..count {
                let (Some(&a), Some(&b)) = (ring.get(e), ring.get((e + 1) % count)) else {
                    continue;
                };
                for piece in outside_pieces(a, b, &grown) {
                    // A straight piece: extend it by the outer wall width at both ends and check that both
                    // ends land on the layer below.
                    let (p, q) = piece;
                    let (dx, dy) = (f64::from(q.x - p.x), f64::from(q.y - p.y));
                    let len = dx.m_hypot(dy);
                    if len < 1.0 {
                        continue;
                    }
                    let (ux, uy) = (dx / len * f64::from(fw), dy / len * f64::from(fw));
                    #[allow(clippy::cast_possible_truncation, reason = "a point inside the bed")]
                    let (p2, q2) = (
                        IntPoint::new(
                            (f64::from(p.x) - ux).round() as i32,
                            (f64::from(p.y) - uy).round() as i32,
                        ),
                        IntPoint::new(
                            (f64::from(q.x) + ux).round() as i32,
                            (f64::from(q.y) + uy).round() as i32,
                        ),
                    );
                    if inside(lower, p2) && inside(lower, q2) {
                        let half = f64::from(fw.max(units(inner))) / 2.0 + 0.001 * SCALE;
                        bands.push(vec![vec![band(p2, q2, half)]]);
                    }
                }
            }
        }
    }
    if !bands.is_empty() {
        let refs: Vec<&Shapes> = bands.iter().collect();
        out = perimeters::union_all(&[&out, &perimeters::union_all(&refs)]);
    }
    out
}

/// The pieces of segment `a`-`b` outside `area`.
fn outside_pieces(a: IntPoint<i32>, b: IntPoint<i32>, area: &Shapes) -> Vec<(IntPoint<i32>, IntPoint<i32>)> {
    let (ax, ay, bx, by) = (f64::from(a.x), f64::from(a.y), f64::from(b.x), f64::from(b.y));
    let mut ts: Vec<f64> = vec![0.0, 1.0];
    for ring in area.iter().flat_map(|s| s.iter()) {
        let count = ring.len();
        for e in 0..count {
            let (Some(c), Some(d)) = (ring.get(e), ring.get((e + 1) % count)) else {
                continue;
            };
            let (cx, cy, dx, dy) = (f64::from(c.x), f64::from(c.y), f64::from(d.x), f64::from(d.y));
            let den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
            if den.abs() < 1e-9 {
                continue;
            }
            let t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
            let u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
            if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
                ts.push(t);
            }
        }
    }
    ts.sort_by(f64::total_cmp);
    #[allow(clippy::cast_possible_truncation, reason = "a point inside the bed")]
    let at = |t: f64| {
        IntPoint::new(
            (ax + (bx - ax) * t).round() as i32,
            (ay + (by - ay) * t).round() as i32,
        )
    };
    ts.windows(2)
        .filter_map(|p| match p {
            [t0, t1] if t1 - t0 > 1e-6 && !inside(area, at(f64::midpoint(*t0, *t1))) => {
                Some((at(*t0), at(*t1)))
            }
            _ => None,
        })
        .collect()
}

/// True when the point (`x`, `y`) in internal units lies inside `area`.
pub(crate) fn point_in(area: &Shapes, x: i32, y: i32) -> bool {
    inside(area, IntPoint::new(x, y))
}

/// The pieces of the polyline `line` inside `area`.
pub(crate) fn clip_inside(line: &[IntPoint<i32>], area: &Shapes) -> Vec<Vec<IntPoint<i32>>> {
    let mut out: Vec<Vec<IntPoint<i32>>> = Vec::new();
    let mut cur: Vec<IntPoint<i32>> = Vec::new();
    for seg in line.windows(2) {
        let [a, b] = seg else { continue };
        // The segment cut where it crosses the outline, each part inside or out.
        let outside = outside_pieces(*a, *b, area);
        let mut cuts: Vec<(IntPoint<i32>, IntPoint<i32>, bool)> = Vec::new();
        let mut at = *a;
        for (p, q) in outside {
            if p != at {
                cuts.push((at, p, true));
            }
            cuts.push((p, q, false));
            at = q;
        }
        if at != *b {
            cuts.push((at, *b, true));
        }
        for (p, q, keep) in cuts {
            if keep {
                if cur.last() != Some(&p) {
                    if cur.len() >= 2 {
                        out.push(std::mem::take(&mut cur));
                    }
                    cur = vec![p];
                }
                cur.push(q);
            } else if cur.len() >= 2 {
                out.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
    }
    if cur.len() >= 2 {
        out.push(cur);
    }
    out
}

/// The polylines `lines` thickened to `half_mm` on each side.
pub(crate) fn stroke(lines: &[Vec<crate::geom::Point>], half_mm: f64) -> Shapes {
    let half = half_mm * SCALE;
    let mut parts: Shapes = Vec::new();
    for l in lines {
        for seg in l.windows(2) {
            let [a, b] = seg else { continue };
            let (p, q) = (IntPoint::new(a.x, a.y), IntPoint::new(b.x, b.y));
            let (dx, dy) = (f64::from(q.x - p.x), f64::from(q.y - p.y));
            let len = dx.m_hypot(dy).max(1.0);
            // Extend each piece by its half width so the joints are covered.
            #[allow(clippy::cast_possible_truncation, reason = "a point inside the bed")]
            let ext = |pt: IntPoint<i32>, s: f64| {
                IntPoint::new(
                    (f64::from(pt.x) + dx / len * half * s).round() as i32,
                    (f64::from(pt.y) + dy / len * half * s).round() as i32,
                )
            };
            parts.push(vec![band(ext(p, -1.0), ext(q, 1.0), half)]);
        }
    }
    perimeters::union_all(&[&parts])
}

/// True when `p` lies inside `area` (even-odd over all rings).
fn inside(area: &Shapes, p: IntPoint<i32>) -> bool {
    let (px, py) = (f64::from(p.x), f64::from(p.y));
    let mut odd = false;
    for ring in area.iter().flat_map(|s| s.iter()) {
        let count = ring.len();
        for e in 0..count {
            let (Some(a), Some(b)) = (ring.get(e), ring.get((e + 1) % count)) else {
                continue;
            };
            let (ay, by) = (f64::from(a.y), f64::from(b.y));
            if (ay > py) != (by > py) {
                let x = f64::from(a.x) + (py - ay) / (by - ay) * (f64::from(b.x) - f64::from(a.x));
                if px < x {
                    odd = !odd;
                }
            }
        }
    }
    odd
}

/// A rectangle around segment `p`-`q`, `half` units to each side.
fn band(p: IntPoint<i32>, q: IntPoint<i32>, half: f64) -> Vec<IntPoint<i32>> {
    let (dx, dy) = (f64::from(q.x - p.x), f64::from(q.y - p.y));
    let len = dx.m_hypot(dy).max(1.0);
    let (nx, ny) = (-dy / len * half, dx / len * half);
    #[allow(clippy::cast_possible_truncation, reason = "a point inside the bed")]
    let at = |x: i32, y: i32, s: f64| {
        IntPoint::new(
            (f64::from(x) + nx * s).round() as i32,
            (f64::from(y) + ny * s).round() as i32,
        )
    };
    vec![
        at(p.x, p.y, -1.0),
        at(q.x, q.y, -1.0),
        at(q.x, q.y, 1.0),
        at(p.x, p.y, 1.0),
    ]
}

/// `models[i]` is the part's outline on layer `i`, `thickness[i]` the layer's
/// thickness in mm and `w` the line width in internal units. Returns one
/// entry per layer.
pub(crate) fn plan(
    models: &[Shapes],
    thickness: &[f64],
    cfg: &SupportConfig,
    w: i32,
    force: &[Shapes],
    block: &[Shapes],
    center: [f64; 2],
) -> Vec<SupportLayer> {
    let n = models.len();
    let (top_gap, bottom_gap) = gap_layers(cfg, thickness.first().copied().unwrap_or(0.2));
    let hang = overhangs(models, thickness, cfg, w, force, block);
    if hang.iter().all(Vec::is_empty) {
        return vec![SupportLayer::default(); n];
    }
    let mut starts: Vec<Vec<usize>> = vec![Vec::new(); n];
    for l in (top_gap + 1)..n {
        if let Some(s) = starts.get_mut(l - top_gap - 1) {
            s.push(l);
        }
    }
    let layer_mm = thickness.first().copied().unwrap_or(0.2);
    columns_from(
        models,
        &hang,
        &starts,
        cfg,
        w,
        bottom_gap,
        block,
        center,
        false,
        half_spacing(w, layer_mm),
        layer_mm,
    )
    .0
}

/// The grid style's cell: the base line pitch, `support_base_pattern_spacing` plus the support flow spacing at
/// layer height `layer_mm` (Orca's `SupportGridParams::grid_resolution`).
/// `area` stretched to the support grid, with nothing to trim it: read back half a line spacing past the
/// cells (what a contact layer prints, Orca's `expansion_to_slice`) and a hair inside them (what the layers
/// below grow from, `expansion_to_propagate`).
pub(crate) fn to_grid(
    area: &Shapes,
    cfg: &SupportConfig,
    w: i32,
    layer_mm: f64,
    center: [f64; 2],
) -> Option<(Shapes, Shapes)> {
    GridPattern::new(
        area,
        &Vec::new(),
        cell(cfg, w, layer_mm),
        flow_spacing(w, layer_mm),
        cfg.angle,
        center,
    )
    .map(|g| (g.extract(half_spacing(w, layer_mm), true), g.extract(-1, true)))
}

fn cell(cfg: &SupportConfig, w: i32, layer_mm: f64) -> f64 {
    flow_spacing(w, layer_mm) + cfg.base_spacing
}

/// The support flow spacing, mm, for a line `w` units wide at layer height `layer_mm`.
fn flow_spacing(w: i32, layer_mm: f64) -> f64 {
    (f64::from(w) - f64::from(units(layer_mm * (1.0 - std::f64::consts::FRAC_PI_4)))) / SCALE
}

/// Half a support line spacing at layer height `layer_mm`: how far the printed area of grid style
/// support reaches past its cells, so the outer rows run on the cell edges (Orca's
/// `expansion_to_slice`, half the flow spacing plus 5 units).
fn half_spacing(w: i32, layer_mm: f64) -> i32 {
    (w - units(layer_mm * (1.0 - std::f64::consts::FRAC_PI_4))) / 2 + 5
}

/// [`columns`] with the layer each column starts on given per overhang: `starts[i]` lists the
/// overhang layers whose column begins on layer `i`. With `landing`, also returns, per layer, the
/// part of its top surface that columns from above come down on.
#[allow(clippy::too_many_arguments, reason = "one plan's inputs")]
pub(crate) fn columns_from(
    models: &[Shapes],
    hang: &[Shapes],
    starts: &[Vec<usize>],
    cfg: &SupportConfig,
    w: i32,
    bottom_gap: usize,
    _block: &[Shapes],
    center: [f64; 2],
    landing: bool,
    grow: i32,
    layer_mm: f64,
) -> (Vec<SupportLayer>, Vec<Shapes>) {
    let n = models.len();
    let mut lands: Vec<Shapes> = vec![Vec::new(); if landing { n } else { 0 }];
    let starting = |i: usize| -> Shapes {
        let list = starts.get(i).map_or(&[][..], Vec::as_slice);
        let sets: Vec<&Shapes> = list.iter().filter_map(|&l| hang.get(l)).collect();
        perimeters::union_all(&sets)
    };
    let xy = units(cfg.xy_distance);
    let empty: Shapes = Vec::new();
    let model = |i: usize| models.get(i).unwrap_or(&empty);
    // Where support may stand when it must reach the bed: not under the part.
    let mut allowed: Vec<Option<Shapes>> = Vec::new();
    if cfg.on_build_plate_only {
        let mut shadow: Shapes = Vec::new();
        for i in 0..n {
            allowed.push(Some(shadow.clone()));
            let grown = perimeters::offset(model(i), xy);
            shadow = perimeters::union_all(&[&shadow, &grown]);
        }
    }
    let mut out: Vec<SupportLayer> = vec![SupportLayer::default(); n];
    // Where support wanted to stand but the part was in the way (or just below): what the layers above
    // rest on, for the bottom interface.
    let mut rest: Vec<Shapes> = vec![Vec::new(); n];
    let mut column: Shapes = Vec::new();
    for i in (0..n).rev() {
        let fresh = starting(i);
        if !fresh.is_empty() {
            column = perimeters::union_all(&[&column, &fresh]);
        }
        if column.is_empty() {
            continue;
        }
        // The part first blocks the column `bottom_gap` layers above its own top surface.
        if landing
            && let Some(b) = i.checked_sub(bottom_gap)
            && let Some(slot) = lands.get_mut(b)
        {
            let top = perimeters::difference(model(b), model(b + 1));
            if !top.is_empty() {
                *slot = perimeters::intersection(&column, &top);
            }
        }
        // Keep clear of the part on this layer and the ones just below (the bottom gap).
        let lo = i.saturating_sub(bottom_gap);
        let near: Vec<&Shapes> = (lo..=i).map(model).collect();
        let blocked = perimeters::offset(&perimeters::union_all(&near), xy);
        if cfg.interface_bottom_layers > 0
            && let Some(slot) = rest.get_mut(i)
        {
            // What the column comes down on: the part itself (Orca's `touching`), not its clearance.
            *slot = perimeters::intersection(&column, &perimeters::union_all(&near));
        }
        column = perimeters::difference(&column, &blocked);
        let mut area = column.clone();
        // The grid style stretches the islands to a coarse grid, then trims them by the part again
        // (Orca's `project_support_to_grid`). Support that must reach the bed stays tight: stretching it would
        // leave rims beside the part.
        if matches!(cfg.style, SupportStyle::Default | SupportStyle::Grid)
            && !cfg.on_build_plate_only
            && let Some(g) = GridPattern::new(
                &area,
                &blocked,
                cell(cfg, w, layer_mm),
                flow_spacing(w, layer_mm),
                cfg.angle,
                center,
            )
        {
            // The stretched islands, a hair inside the cells, are what the layers below start from, so
            // they stay beside the part (`expansion_to_propagate`).
            column = g.extract(-1, true);
            // The printed area reaches half a line spacing past the cells, so the outer rows run on
            // the cell edges (`expansion_to_slice`).
            area = if grow > 0 {
                g.extract(grow, true)
            } else {
                column.clone()
            };
        } else if cfg.style == SupportStyle::Snug && !area.is_empty() {
            // Snug columns merge by a 2 mm morphological closing, then lose the notches narrower than a line
            // (Orca SupportMaterial.cpp `SupportGridPattern::extract_support`, smsSnug, with its fixed
            // `support_closing_radius` of 2 mm; MutablePolygon.cpp `smooth_outward`). The layers below start
            // from the merged area too.
            let r = crate::geom::mm(2.0);
            let closed = perimeters::offset(&perimeters::offset(&area, r), -r);
            area = crate::smooth::smooth_outward(&closed, w);
            column.clone_from(&area);
        }
        if let Some(Some(a)) = allowed.get(i) {
            // Only from the bed: nothing stands where the part is below.
            area = perimeters::difference(&area, a);
        }
        // Orca's support areas come from slices at its 0.0125 mm resolution and square offsets; the round joins
        // of these offsets would otherwise put hundreds of points on each curved edge.
        let area = tidy(open(&area, w));
        if area.is_empty() {
            continue;
        }
        // Interface: the footprint of the overhangs this layer is directly under.
        let mut iface: Shapes = Vec::new();
        // The contact layer counts besides the interface layers (OrcaSlicer prints three for a setting of two).
        for k in 0..=cfg.interface_top_layers as usize {
            let h = starting(i + k);
            if !h.is_empty() {
                iface = perimeters::union_all(&[&iface, &h]);
            }
        }
        let grid =
            matches!(cfg.style, SupportStyle::Default | SupportStyle::Grid) && !cfg.on_build_plate_only;
        let to_grid = |f: &Shapes| -> Shapes {
            if !grid {
                return f.clone();
            }
            // The islands are trimmed by the part before they are stretched (Orca's contact polygons are).
            let f = perimeters::difference(f, &blocked);
            GridPattern::new(
                &f,
                &blocked,
                cell(cfg, w, layer_mm),
                flow_spacing(w, layer_mm),
                cfg.angle,
                center,
            )
            .map(|g| g.extract(grow.max(0), false))
            .unwrap_or_default()
        };
        iface = to_grid(&iface);
        let interface = tidy(open(&perimeters::intersection(&area, &iface), w));
        let hang_here = starting(i);
        let contact = if hang_here.is_empty() || interface.is_empty() {
            Vec::new()
        } else {
            perimeters::intersection(&interface, &to_grid(&hang_here))
        };
        let base = if interface.is_empty() {
            area
        } else {
            perimeters::difference(&area, &interface)
        };
        if let Some(slot) = out.get_mut(i) {
            *slot = SupportLayer {
                base,
                interface,
                normal: Shapes::new(),
                contact,
                hang: hang_here,
                bottom: Shapes::new(),
                classic: None,
                organic: None,
            };
        }
    }
    bottom_interface(&mut out, &rest, cfg, w);
    (out, lands)
}

/// Turns the support layers that rest on the part into interface: the contact layer and
/// `support_interface_bottom_layers` more, where they stand over what the layers below had to leave out.
fn bottom_interface(out: &mut [SupportLayer], rest: &[Shapes], cfg: &SupportConfig, w: i32) {
    let layers = cfg.interface_bottom_layers as usize;
    if layers == 0 {
        return;
    }
    for i in 0..out.len() {
        // The layer just above the gap rests on the landing of the layer below it, and so do the
        // `layers` layers above that one.
        let mut landing: Shapes = Vec::new();
        for k in 0..=layers {
            let Some(j) = i.checked_sub(1 + k) else { break };
            if let Some(r) = rest.get(j).filter(|r| !r.is_empty()) {
                landing = perimeters::union_all(&[&landing, r]);
            }
        }
        if landing.is_empty() {
            continue;
        }
        let Some(layer) = out.get_mut(i) else { continue };
        let all = perimeters::union_all(&[&layer.base, &layer.interface]);
        let want = open(
            &perimeters::intersection(&all, &perimeters::offset(&landing, w)),
            w,
        );
        if want.is_empty() {
            continue;
        }
        // Where it is top interface too, the top interface wins (Orca merges the bottom contact into it).
        let only_bottom = perimeters::difference(&want, &layer.interface);
        layer.bottom = perimeters::union_all(&[&layer.bottom, &only_bottom]);
        layer.interface = perimeters::union_all(&[&layer.interface, &want]);
        layer.base = perimeters::difference(&layer.base, &want);
    }
}

/// Heights two support layers closer than this are merged at (Orca's `EPSILON`).
const Z_EPS: f64 = 1e-4;

/// Heights of the support layer stack: the slicing parameters of the plate.
#[derive(Debug, Clone, Copy)]
pub(crate) struct StackHeights {
    /// Top of the first print layer, mm.
    pub(crate) first: f64,
    /// Thinnest support layer: the smallest `min_layer_height` and object layer, mm.
    pub(crate) min_h: f64,
    /// Thickest support layer (`max_layer_height`, or three quarters of the nozzle), mm.
    pub(crate) max_h: f64,
    /// Thickness of the layer that rests on a top surface of the part (the interface flow's), mm.
    pub(crate) bottom_contact_h: f64,
    /// The raft under the part, when there is one: the top of its interface layers, the top and
    /// thickness of its contact layer, and its layer count (`SlicingParameters`). The object tops are
    /// then lifted by the raft and its gap.
    pub(crate) raft: Option<RaftHeights>,
}

/// The heights of a raft that support stands on.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RaftHeights {
    pub(crate) interface_top: f64,
    pub(crate) contact_top: f64,
    pub(crate) contact_h: f64,
    pub(crate) layers: usize,
}

/// One layer of the independent support stack.
#[derive(Debug, Clone, Default)]
pub(crate) struct StackLayer {
    /// Top of the layer, mm.
    pub(crate) top: f64,
    pub(crate) height: f64,
    pub(crate) layer: SupportLayer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Top,
    Bottom,
    Between,
}

/// A layer of the stack being planned: where it ends and how thick it is (0 while unknown).
#[derive(Debug, Clone, Copy)]
struct Slab {
    kind: Kind,
    top: f64,
    bottom: f64,
    height: f64,
}

impl Slab {
    /// Where the slab bounds the layers between contacts: the bottom of a top contact, the top of
    /// anything else.
    fn extreme(&self) -> f64 {
        if self.kind == Kind::Top {
            self.bottom
        } else {
            self.top
        }
    }
}

/// `area` of a support layer from `bottom` to `t` (mm), kept clear of every object layer it overlaps
/// (by the XY distance) and of those within the Z gaps above and below it (by 0.2 mm), as Orca's
/// `trim_support_layers_by_object`.
pub(crate) fn clear_of_part(
    area: &Shapes,
    t: f64,
    bottom: f64,
    models: &[Shapes],
    tops: &[f64],
    thickness: &[f64],
    cfg: &SupportConfig,
) -> Shapes {
    let (xy, near) = (units(cfg.xy_distance), units(0.2));
    let lo = bottom - cfg.bottom_z_distance + Z_EPS;
    let hi = t + cfg.top_z_distance - Z_EPS;
    let mut keep: Vec<Shapes> = Vec::new();
    for k in tops.partition_point(|&z| z < lo)..tops.len() {
        let (Some(&kt), Some(&kh), Some(m)) = (tops.get(k), thickness.get(k), models.get(k)) else {
            break;
        };
        if kt - kh > hi {
            break;
        }
        let overlaps = (t - kt).abs() < Z_EPS || (t < kt && t > kt - kh) || (t > kt && bottom < kt - Z_EPS);
        keep.push(perimeters::offset(m, if overlaps { xy } else { near }));
    }
    if keep.is_empty() {
        return area.clone();
    }
    let refs: Vec<&Shapes> = keep.iter().collect();
    perimeters::difference(area, &perimeters::union_all(&refs))
}

/// Support printed on layers of its own height (`independent_support_layer_height`), as Orca's
/// `PrintObjectSupportMaterial` plans it: a contact layer the top gap under each overhang (contacts
/// closer than `min_h` merge), a contact layer over each top surface support stands on, and between
/// those the fewest layers no thicker than `max_h`, all the same thickness. The area of each layer is
/// the column of the object layer at or below it, kept clear of the part in the layers it overlaps
/// and the gaps above and below it. `tops` and `thickness` are the object layers.
#[allow(clippy::too_many_arguments, reason = "one plan's inputs")]
pub(crate) fn stack(
    models: &[Shapes],
    tops: &[f64],
    thickness: &[f64],
    cfg: &SupportConfig,
    w: i32,
    force: &[Shapes],
    block: &[Shapes],
    center: [f64; 2],
    h: StackHeights,
) -> Vec<StackLayer> {
    let n = models.len();
    let hang = overhangs(models, thickness, cfg, w, force, block);
    if hang.iter().all(Vec::is_empty) {
        return Vec::new();
    }
    let top_of = |i: usize| tops.get(i).copied().unwrap_or(0.0);
    let thick_of = |i: usize| thickness.get(i).copied().unwrap_or(0.0);
    let zero_top = cfg.top_z_distance <= 0.0;

    // Top contacts, one per overhang layer, then merged where closer than the thinnest layer.
    let mut contacts: Vec<(Slab, Vec<usize>)> = Vec::new();
    for l in 1..n {
        if hang.get(l).is_none_or(Vec::is_empty) {
            continue;
        }
        let bottom_l = top_of(l) - thick_of(l);
        let slab = if zero_top {
            // The contact takes the place of the layer under the overhang.
            let below = thick_of(l - 1);
            Slab {
                kind: Kind::Top,
                top: bottom_l,
                bottom: bottom_l - below,
                height: below,
            }
        } else {
            let z = bottom_l - cfg.top_z_distance;
            if z < h.first - Z_EPS {
                // Under the first layer: nothing can be printed there.
                continue;
            }
            // Contacts this low sit on the first layer, or on the raft's contact layer (which they join).
            let raft = h.raft.filter(|r| r.layers > 1);
            let floor = raft.map_or(h.first, |r| r.contact_top);
            if z < floor + h.min_h {
                match raft {
                    Some(r) => Slab {
                        kind: Kind::Top,
                        top: r.contact_top,
                        bottom: r.interface_top,
                        height: r.contact_h,
                    },
                    None => Slab {
                        kind: Kind::Top,
                        top: h.first,
                        bottom: 0.0,
                        height: h.first,
                    },
                }
            } else {
                // Its thickness is decided with the layers under it.
                Slab {
                    kind: Kind::Top,
                    top: z,
                    bottom: z,
                    height: 0.0,
                }
            }
        };
        contacts.push((slab, vec![l]));
    }
    if let Some(r) = h.raft {
        // The raft's contact layer (Orca's contact of the first object layer) bounds the first span.
        contacts.push((
            Slab {
                kind: Kind::Top,
                top: r.contact_top,
                bottom: r.interface_top,
                height: r.contact_h,
            },
            Vec::new(),
        ));
    }
    crate::sorting::sort_by(&mut contacts, |a, b| a.0.top.total_cmp(&b.0.top));
    let mut merged: Vec<(Slab, Vec<usize>)> = Vec::new();
    for (slab, ls) in contacts {
        let join = match merged.last() {
            // Everything printed at the first layer height becomes one first-layer contact.
            Some(last) if slab.top < h.first + h.min_h - Z_EPS => last.0.top < h.first + h.min_h - Z_EPS,
            Some(last) => slab.top < last.0.top + h.min_h + Z_EPS,
            None => false,
        };
        match merged.last_mut() {
            Some(last) if join => last.1.extend(ls),
            _ => {
                let mut slab = slab;
                if slab.top < h.first + h.min_h - Z_EPS && h.raft.is_none() {
                    slab = Slab {
                        kind: Kind::Top,
                        top: h.first,
                        bottom: 0.0,
                        height: h.first,
                    };
                }
                merged.push((slab, ls));
            }
        }
    }
    let mut contacts = merged;

    // Each column starts on the highest object layer at or under its contact.
    let mut starts: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (slab, ls) in &contacts {
        let j = tops.partition_point(|&t| t <= slab.top + Z_EPS);
        if let Some(s) = j.checked_sub(1).and_then(|j| starts.get_mut(j)) {
            s.extend(ls.iter().copied());
        }
    }
    let layer_mm = thickness.first().copied().unwrap_or(0.2);
    let (_, bottom_gap) = gap_layers(cfg, layer_mm);
    let (mut areas, lands) = columns_from(
        models,
        &hang,
        &starts,
        cfg,
        w,
        bottom_gap,
        block,
        center,
        true,
        half_spacing(w, layer_mm),
        layer_mm,
    );

    // Bottom contacts: over each top surface the columns come down on.
    let zero_bottom = cfg.interface_bottom_layers > 0 && (cfg.bottom_z_distance <= 0.0 || zero_top);
    let mut bottoms: Vec<(Slab, Shapes, usize)> = Vec::new();
    // Support that must reach the bed never rests on the part.
    let rests = if cfg.on_build_plate_only {
        0
    } else {
        n.saturating_sub(1)
    };
    for b in (0..rests).rev() {
        let Some(touch) = lands.get(b).filter(|t| !t.is_empty()) else {
            continue;
        };
        let (mut z, mut height) = if zero_bottom {
            (top_of(b + 1), thick_of(b + 1))
        } else {
            (
                top_of(b) + h.bottom_contact_h + cfg.bottom_z_distance,
                h.bottom_contact_h,
            )
        };
        if !zero_bottom {
            // Snap to a top contact closer than the thinnest layer, so no layer comes out thinner.
            for (c, _) in contacts.iter().filter(|(c, _)| c.top > top_of(b) - Z_EPS) {
                if c.top >= z + h.min_h + Z_EPS {
                    break;
                }
                if c.top <= z - h.min_h - Z_EPS {
                    continue;
                }
                let diff = z - c.top;
                if diff > 0.0 && height - diff <= h.min_h {
                    continue;
                }
                z = c.top;
                height -= diff;
                break;
            }
        }
        let grown = perimeters::offset(touch, w);
        // The columns of the object layers under the contact no longer pass through it.
        for j in (b + 1)..n {
            if top_of(j) > z - Z_EPS {
                break;
            }
            if let Some(a) = areas
                .get_mut(j)
                .filter(|a| !a.base.is_empty() || !a.interface.is_empty())
            {
                let all = perimeters::union_all(&[&a.base, &a.interface]);
                a.base = perimeters::difference(&all, touch);
                a.interface = Vec::new();
            }
        }
        bottoms.push((
            Slab {
                kind: Kind::Bottom,
                top: z,
                bottom: top_of(b),
                height,
            },
            grown,
            b,
        ));
    }
    bottoms.reverse();

    // The layers between: from each extreme to the next, in equal steps no thicker than `max_h`.
    let mut ext: Vec<(Kind, usize)> = (0..contacts.len())
        .map(|i| (Kind::Top, i))
        .chain((0..bottoms.len()).map(|i| (Kind::Bottom, i)))
        .collect();
    let slab_of = |k: &(Kind, usize), contacts: &[(Slab, Vec<usize>)], bottoms: &[(Slab, Shapes, usize)]| {
        match k.0 {
            Kind::Top => contacts.get(k.1).map(|c| c.0),
            _ => bottoms.get(k.1).map(|b| b.0),
        }
        .unwrap_or(Slab {
            kind: Kind::Between,
            top: 0.0,
            bottom: 0.0,
            height: 0.0,
        })
    };
    crate::sorting::sort_by(&mut ext, |a, b| {
        let (sa, sb) = (slab_of(a, &contacts, &bottoms), slab_of(b, &contacts, &bottoms));
        sa.extreme()
            .total_cmp(&sb.extreme())
            .then_with(|| (sa.kind != Kind::Top).cmp(&(sb.kind != Kind::Top)))
    });
    let raft_top = h.raft.map_or(0.0, |r| r.interface_top);
    let mut between: Vec<Slab> = Vec::new();
    let mut first_ext = 0;
    if ext
        .first()
        .is_some_and(|e| (slab_of(e, &contacts, &bottoms).extreme() - raft_top).abs() < Z_EPS)
    {
        first_ext = 1;
    }
    let push = |between: &mut Vec<Slab>, bottom: f64, top: f64| {
        between.push(Slab {
            kind: Kind::Between,
            top,
            bottom,
            height: top - bottom,
        });
    };
    for idx in first_ext..ext.len() {
        let Some(&e2) = ext.get(idx) else { continue };
        let s2 = slab_of(&e2, &contacts, &bottoms);
        let mut e2z = s2.extreme();
        if (e2z - h.first).abs() < Z_EPS {
            // A contact resting on the first layer: the first layer goes under it.
            if between.last().is_none_or(|l| l.top < h.first) {
                push(&mut between, 0.0, h.first);
            }
            continue;
        }
        let s1 = (idx > first_ext)
            .then(|| ext.get(idx - 1))
            .flatten()
            .map(|e| slab_of(e, &contacts, &bottoms));
        let mut e1z = s1.map_or(raft_top, |s| s.extreme());
        if e1z.abs() < Z_EPS {
            // The span starts on the bed: its first layer is the first layer height.
            push(&mut between, 0.0, h.first);
            e1z = h.first;
        }
        let mut dist = e2z - e1z;
        if dist <= 0.0 {
            continue;
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a layer count"
        )]
        let count = |d: f64| ((d - Z_EPS) / h.max_h).ceil().max(0.0) as usize;
        let mut steps = count(dist).max(1);
        #[allow(clippy::cast_precision_loss, reason = "a layer count")]
        let mut step = dist / steps as f64;
        if let Some(s1) = s1.filter(|s| s.kind == Kind::Top && s.top + h.min_h > s.bottom + step) {
            // Over a top contact: a layer level with it first, so the next one is not too thin.
            push(&mut between, s1.bottom, s1.top);
            e1z = s1.top;
            dist = e2z - e1z;
            steps = count(dist);
            if steps == 0 {
                continue;
            }
            #[allow(clippy::cast_precision_loss, reason = "a layer count")]
            {
                step = dist / steps as f64;
            }
        }
        if !zero_top && e2.0 == Kind::Top {
            // The contact itself takes the last step.
            if let Some(c) = contacts.get_mut(e2.1) {
                c.0.height = step;
                c.0.bottom = c.0.top - step;
                e2z = c.0.bottom;
            }
            steps -= 1;
            if steps == 0 {
                continue;
            }
        }
        for i in 0..steps {
            if i + 1 == steps {
                let bottom = if i == 0 {
                    e1z
                } else {
                    between.last().map_or(e1z, |l| l.top)
                };
                push(&mut between, bottom, e2z);
            } else {
                #[allow(clippy::cast_precision_loss, reason = "a layer count")]
                let bottom = e1z + i as f64 * step;
                push(&mut between, bottom, bottom + step);
            }
        }
    }

    // Every layer height in the stack, merged where they are the same.
    let mut zs: Vec<(f64, f64)> = contacts
        .iter()
        .map(|c| c.0)
        .chain(bottoms.iter().map(|b| b.0))
        .chain(between.iter().copied())
        // The raft prints everything up to its contact layer.
        .filter(|s| s.height > 0.0 && h.raft.is_none_or(|r| s.top > r.contact_top + Z_EPS))
        .map(|s| (s.top, s.height))
        .collect();
    crate::sorting::sort_by(&mut zs, |a, b| a.0.total_cmp(&b.0));
    let mut stack: Vec<StackLayer> = Vec::new();
    let mut i = 0;
    while let Some(&(z0, h0)) = zs.get(i) {
        let mut j = i + 1;
        let mut height = h0;
        let mut last = z0;
        while let Some(&(z, hh)) = zs.get(j).filter(|(z, _)| *z <= z0 + Z_EPS) {
            height = height.min(hh);
            last = z;
            j += 1;
        }
        stack.push(StackLayer {
            top: f64::midpoint(z0, last),
            height,
            layer: SupportLayer::default(),
        });
        i = j;
    }
    let index_of = |z: f64| stack.partition_point(|s| s.top < z - Z_EPS);

    // The area of each layer, kept clear of the part.
    let empty: Shapes = Vec::new();
    let grid = matches!(cfg.style, SupportStyle::Default | SupportStyle::Grid) && !cfg.on_build_plate_only;
    let grow = half_spacing(w, layer_mm);
    let footprint = |ls: &[usize]| -> Shapes {
        let sets: Vec<&Shapes> = ls.iter().filter_map(|&l| hang.get(l)).collect();
        let f = perimeters::union_all(&sets);
        if grid {
            GridPattern::new(
                &f,
                &Vec::new(),
                cell(cfg, w, layer_mm),
                flow_spacing(w, layer_mm),
                cfg.angle,
                center,
            )
            .map(|g| g.extract(grow, false))
            .unwrap_or_default()
        } else {
            f
        }
    };
    // Top interface: each contact and the `interface_top_layers` layers under it.
    let mut iface: Vec<Vec<usize>> = vec![Vec::new(); stack.len()];
    // The contacts each layer is the top contact of.
    let mut contact_at: Vec<Vec<usize>> = vec![Vec::new(); stack.len()];
    for (k, (slab, _)) in contacts.iter().enumerate() {
        let at = index_of(slab.top);
        if let Some(v) = contact_at.get_mut(at) {
            v.push(k);
        }
        for s in at.saturating_sub(cfg.interface_top_layers as usize)..=at {
            if let Some(v) = iface.get_mut(s) {
                v.push(k);
            }
        }
    }
    let mut extra: Vec<Shapes> = vec![Vec::new(); stack.len()];
    let mut landing: Vec<Shapes> = vec![Vec::new(); stack.len()];
    for (slab, grown, b) in &bottoms {
        let at = index_of(slab.top);
        if let Some(e) = extra.get_mut(at) {
            *e = perimeters::union_all(&[e, grown]);
        }
        if cfg.interface_bottom_layers > 0 {
            let touch = lands.get(*b).unwrap_or(&empty);
            for s in at..=at + cfg.interface_bottom_layers as usize {
                if let Some(l) = landing.get_mut(s) {
                    *l = perimeters::union_all(&[l, touch]);
                }
            }
        }
    }
    let mut out: Vec<StackLayer> = Vec::with_capacity(stack.len());
    for (s, mut layer) in stack.into_iter().enumerate() {
        let (t, bottom) = (layer.top, layer.top - layer.height);
        // Under the first object layer (over a raft) the first layer's columns stand.
        let j = tops.partition_point(|&z| z <= t + Z_EPS).max(1);
        let column = j
            .checked_sub(1)
            .and_then(|j| areas.get(j))
            .map(|a| perimeters::union_all(&[&a.base, &a.interface]))
            .unwrap_or_default();
        let mut area = match extra.get(s).filter(|e| !e.is_empty()) {
            Some(e) => perimeters::union_all(&[&column, e]),
            None => column,
        };
        if area.is_empty() {
            continue;
        }
        area = clear_of_part(&area, t, bottom, models, tops, thickness, cfg);
        let area = open(&area, w);
        if area.is_empty() {
            continue;
        }
        let mut dense: Shapes = Vec::new();
        if let Some(ks) = iface.get(s).filter(|k| !k.is_empty()) {
            let ls: Vec<usize> = ks
                .iter()
                .filter_map(|&k| contacts.get(k))
                .flat_map(|c| c.1.iter().copied())
                .collect();
            dense = footprint(&ls);
        }
        let top_dense = dense.clone();
        if let Some(l) = landing.get(s).filter(|l| !l.is_empty()) {
            // Orca grows the bottom contact by one support line width.
            dense = perimeters::union_all(&[&dense, &perimeters::offset(l, w)]);
        }
        let interface = if dense.is_empty() {
            Vec::new()
        } else {
            open(&perimeters::intersection(&area, &dense), w)
        };
        let (mut contact, mut hang_here) = (Vec::new(), Vec::new());
        if let Some(ks) = contact_at
            .get(s)
            .filter(|k| !k.is_empty() && !interface.is_empty())
        {
            let ls: Vec<usize> = ks
                .iter()
                .filter_map(|&k| contacts.get(k))
                .flat_map(|c| c.1.iter().copied())
                .collect();
            contact = perimeters::intersection(&interface, &footprint(&ls));
            let sets: Vec<&Shapes> = ls.iter().filter_map(|&l| hang.get(l)).collect();
            hang_here = perimeters::union_all(&sets);
        }
        let base = if interface.is_empty() {
            area
        } else {
            perimeters::difference(&area, &interface)
        };
        let bottom = if top_dense.len() == dense.len() && top_dense == dense {
            Vec::new()
        } else {
            perimeters::difference(&interface, &top_dense)
        };
        layer.layer = SupportLayer {
            base,
            interface,
            normal: Vec::new(),
            contact,
            hang: hang_here,
            bottom,
            classic: None,
            organic: None,
        };
        out.push(layer);
    }
    out
}

#[cfg(test)]
mod grid_tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        let p = |x: f64, y: f64| IntPoint::new(units(x), units(y));
        vec![vec![vec![p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]]]
    }

    #[test]
    fn independent_support_layers_step_evenly_up_to_the_contact() {
        // A 20 mm square floating from 10 to 12 mm on 0.2 mm layers: its support stands on the bed.
        let n = 60_u32;
        let tops: Vec<f64> = (1..=n).map(|i| f64::from(i) * 0.2).collect();
        let thickness = vec![0.2; tops.len()];
        let models: Vec<Shapes> = (0..n)
            .map(|i| {
                if i >= 50 {
                    rect(100.0, 100.0, 120.0, 120.0)
                } else {
                    Vec::new()
                }
            })
            .collect();
        let none: Vec<Shapes> = vec![Vec::new(); tops.len()];
        let h = StackHeights {
            first: 0.2,
            min_h: 0.07,
            max_h: 0.3,
            bottom_contact_h: 0.2,
            raft: None,
        };
        let cfg = SupportConfig::default();
        let stack = stack(
            &models,
            &tops,
            &thickness,
            &cfg,
            units(0.42),
            &none,
            &none,
            [110.0, 110.0],
            h,
        );
        // Orca on the same layout: the first layer, 32 layers of 0.3 mm, the contact at 9.8 mm.
        assert_eq!(stack.len(), 33);
        assert!((stack[0].top - 0.2).abs() < 1e-9);
        assert!(stack[1..].iter().all(|l| (l.height - 0.3).abs() < 1e-6));
        assert!((stack[32].top - 9.8).abs() < 1e-6);
        // The contact and the two layers under it are interface.
        assert!(
            stack[30..]
                .iter()
                .all(|l| l.layer.base.is_empty() && !l.layer.interface.is_empty())
        );
        assert!(stack[29].layer.interface.is_empty());
    }
}

#[cfg(test)]
mod table_tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        let p = |x: f64, y: f64| IntPoint::new(units(x), units(y));
        vec![vec![vec![p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]]]
    }

    #[test]
    fn a_table_top_gets_grid_support_with_an_interface() {
        // Two legs up to 10 mm, a top from 10 to 12 mm.
        let n = 60_usize;
        let legs = perimeters::union_all(&[
            &rect(100.0, 100.0, 108.0, 120.0),
            &rect(132.0, 100.0, 140.0, 120.0),
        ]);
        let models: Vec<Shapes> = (0..n)
            .map(|i| {
                if i >= 50 {
                    rect(100.0, 100.0, 140.0, 120.0)
                } else {
                    legs.clone()
                }
            })
            .collect();
        let thickness = vec![0.2; n];
        let none: Vec<Shapes> = vec![Vec::new(); n];
        let cfg = SupportConfig::default();
        let out = plan(
            &models,
            &thickness,
            &cfg,
            units(0.42),
            &none,
            &none,
            [120.0, 110.0],
        );
        let with_iface = out.iter().filter(|l| !l.interface.is_empty()).count();
        let with_base = out.iter().filter(|l| !l.base.is_empty()).count();
        assert!(with_iface >= 3, "{with_iface} {with_base}");
    }
}
