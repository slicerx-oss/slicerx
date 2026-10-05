// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Print by object: every object prints completely before the next one starts.
//!
//! Each object is a [`SliceSession`] of its own (layers, first layer, brim, skirt and supports
//! per object), and the plate's layer list is theirs one after the other. The first layer of every
//! object after the first carries a lift height, so the G-code clears what is already printed
//! before it travels there. Sharding works on that combined layer list like on any other.

use crate::config::PrintConfig;
use crate::error::Result;
use crate::fm::Fm as _;
use crate::output::{PathInfo, SliceOutput, StageMicros};
use crate::plate::{Plate, PlateObject};
use crate::session::SliceSession;
use crate::{Progress, Stage};
use std::ops::Range;

/// Slices `layers` of the combined layer list of a by-object plate.
pub(crate) fn slice_range(
    session: &SliceSession,
    config: &PrintConfig,
    layers: Range<u32>,
    progress: &dyn Progress,
) -> Result<SliceOutput> {
    let total = session.layer_count();
    if layers.start > layers.end || layers.end > total {
        return Err(crate::Error::LayerRange {
            range: layers,
            count: total,
        });
    }
    if session.is_interleaved() {
        return slice_interleaved(session, config, layers, progress);
    }
    let margin = config.z_hop.max(1.0);
    let mut merged: Option<SliceOutput> = None;
    let mut offset = 0u32;
    let mut below_top = 0.0f64;
    for (k, sub) in session.sequence().enumerate() {
        let n = sub.plan_count();
        let lo = layers.start.max(offset);
        let hi = layers.end.min(offset + n);
        if lo < hi {
            if progress.cancelled() {
                return Err(crate::Error::Cancelled);
            }
            let cfg = session.object_config(k, config)?;
            let mut out = sub.slice_object_range(&cfg, lo - offset..hi - offset, progress)?;
            // Layers outside a height range are written with the plate's settings: the object's own flow
            // goes into its paths.
            if session.has_object_settings(k) {
                for l in out.layers.iter_mut().filter(|l| l.cfg == 0) {
                    carry_flow(&mut l.paths, &cfg, config, l.index + offset == 0);
                }
            }
            // The writer sets what changes from the layer below; below a later object's first layer is the
            // last layer of the object before it, which may have ended inside a height range.
            let starts = offset > 0 && out.layers.iter().any(|l| l.local == 0);
            let before = k
                .checked_sub(1)
                .and_then(|p| session.sequence().nth(p))
                .and_then(SliceSession::last_layer_override);
            let mut entry = 0u16;
            if starts && (before.is_some() || out.layers.iter().any(|l| l.local == 0 && l.cfg > 0)) {
                let mut c = match before {
                    Some(_) => session.object_config(k - 1, config)?,
                    None => config.clone(),
                };
                if let Some(v) = before {
                    c.apply_value(v)?;
                    crate::preflight::hold_temperatures(&mut c);
                }
                out.configs.push(c);
                entry = u16::try_from(out.configs.len()).unwrap_or(u16::MAX);
            }
            let base = merged
                .as_ref()
                .map_or(0, |m| u16::try_from(m.configs.len()).unwrap_or(u16::MAX));
            for l in &mut out.layers {
                if l.local == 0 && entry > 0 {
                    l.prev_cfg = entry;
                }
                if offset > 0 {
                    #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
                    {
                        l.below_top = below_top as f32;
                        if l.local == 0 {
                            l.lift_z = (below_top + margin) as f32;
                        }
                    }
                }
                l.index += offset;
                if l.cfg > 0 {
                    l.cfg += base;
                }
                if l.prev_cfg > 0 {
                    l.prev_cfg += base;
                }
            }
            match merged.as_mut() {
                None => merged = Some(out),
                Some(m) => {
                    m.layers.append(&mut out.layers);
                    m.configs.append(&mut out.configs);
                    m.plate_top_z = m.plate_top_z.max(out.plate_top_z);
                    for w in out.warnings {
                        if !m.warnings.contains(&w) {
                            m.warnings.push(w);
                        }
                    }
                    let (a, b) = (&mut m.stage_micros, &out.stage_micros);
                    *a = StageMicros {
                        layers: a.layers + b.layers,
                        contours: a.contours + b.contours,
                        perimeters: a.perimeters + b.perimeters,
                        surfaces: a.surfaces + b.surfaces,
                        infill: a.infill + b.infill,
                        paths: a.paths + b.paths,
                        gcode: 0,
                        preview: 0,
                    };
                }
            }
        }
        below_top = below_top.max(sub.plate_top());
        offset += n;
    }
    progress.report(Stage::Paths, 1.0);
    let mut out = match merged {
        Some(m) => m,
        None => session.slice_object_range(config, 0..0, progress)?,
    };
    out.layer_count = total;
    out.first_layer = layers.start;
    out.tool_count = session.tool_count();
    out.plate_bounds = session.plate_bounds();
    out.first_layer_info = session.first_layer_info(config);
    out.objects = session.footprints().to_vec();
    Ok(out)
}

/// The settings of config index `cfg` (0 is `base`, `k` is `configs[k - 1]`).
fn config_of<'a>(configs: &'a [PrintConfig], base: &'a PrintConfig, cfg: u16) -> &'a PrintConfig {
    usize::from(cfg)
        .checked_sub(1)
        .and_then(|i| configs.get(i))
        .unwrap_or(base)
}

/// Paths planned with `own` but written with `writer` (another object's settings, or the plate's):
/// their flow carries the difference in flow ratios, so each object extrudes what its own settings ask.
fn carry_flow(paths: &mut [PathInfo], own: &PrintConfig, writer: &PrintConfig, first_layer: bool) {
    if std::ptr::eq(own, writer) {
        return;
    }
    let ratio =
        |c: &PrintConfig, p: &PathInfo| c.flow_ratio(p.tool) * c.role_flow_ratio(p.feature, first_layer);
    for p in paths {
        let (a, b) = (ratio(own, p), ratio(writer, p));
        if (a - b).abs() > 1e-12 && b > 0.0 {
            #[allow(clippy::cast_possible_truncation, reason = "flow multipliers are small")]
            {
                p.flow = (f64::from(p.flow) * a / b) as f32;
            }
        }
    }
}

/// Problems of a by-object plate: objects closer than the extruder clearance, and objects that
/// stand taller than the gantry clears while another prints after them. Bambu Studio's
/// `sequential_print_clearance_valid`, the printer maker's own rule for the A1 and its kin.
pub(crate) fn clearance_problems(objects: &[&PlateObject], config: &PrintConfig) -> Vec<String> {
    let radius = config.raw_number("extruder_clearance_radius", 40.0);
    let rod = config.raw_number("extruder_clearance_height_to_rod", 40.0);
    let lid = config.raw_number("extruder_clearance_height_to_lid", 120.0);
    let to_rod = config.raw_number("extruder_clearance_dist_to_rod", 40.0);
    let plate = Plate {
        objects: objects.iter().map(|o| (*o).clone()).collect(),
        ..Plate::default()
    };
    let hulls = crate::firmware::footprints(&plate);
    let heights: Vec<f64> = objects
        .iter()
        .map(|o| {
            o.mesh
                .parts
                .iter()
                .flat_map(|p| p.positions.iter())
                .map(|&v| o.apply(v)[2])
                .fold(0.0, f64::max)
        })
        .collect();
    let name = |i: usize| objects.get(i).map_or("object", |o| o.name.as_str()).to_owned();
    // objects under the nozzle height never meet the hotend, only the nozzle (orca's is_all_objects_are_short)
    let short = heights
        .iter()
        .all(|&h| h < config.raw_number("nozzle_height", 2.5));
    let skirt = skirt_offset(config, short);
    // each hull grows by half of this less 0.1 mm, so placing exactly at the radius passes
    let need = if short {
        2.0 * (skirt.max(0.5 * MAX_OUTER_NOZZLE_DIAMETER) - 0.1)
    } else {
        radius + 2.0 * skirt - 0.2
    };
    let mut out = Vec::new();
    for i in 0..hulls.len() {
        for j in i + 1..hulls.len() {
            let (Some(a), Some(b)) = (hulls.get(i), hulls.get(j)) else {
                continue;
            };
            let gap = hull_distance(&a.hull, &b.hull);
            if gap < need {
                out.push(format!(
                    "{} and {} are {gap:.1} mm apart; printing by object needs {:.0} mm between objects so the toolhead clears them",
                    name(i),
                    name(j),
                    need.ceil()
                ));
            }
        }
    }
    // the gantry passes over an earlier object while a later one prints in a band of y around it
    let band = |i: usize| {
        hulls.get(i).map(|h| {
            let ys = h.hull.iter().map(|p| p[1]);
            let lo = ys.clone().fold(f64::INFINITY, f64::min);
            let hi = ys.fold(f64::NEG_INFINITY, f64::max);
            (lo - 0.5 * to_rod, hi + 0.5 * to_rod)
        })
    };
    let last = heights.len().saturating_sub(1);
    for (i, h) in heights.iter().enumerate().take(last) {
        let under = band(i).is_some_and(|(lo, hi)| {
            (i + 1..heights.len()).any(|j| band(j).is_some_and(|(l, u)| hi.min(u) - lo.max(l) > 0.0))
        });
        let (limit, what) = if under {
            (rod, "the gantry")
        } else {
            (lid, "the lid")
        };
        if *h > limit {
            out.push(format!(
                "{} is {h:.1} mm tall and prints before another object; {what} clears {limit:.0} mm, so print it last or lower it",
                name(i)
            ));
        }
    }
    out
}

/// Orca's `MAX_OUTER_NOZZLE_DIAMETER`, mm.
const MAX_OUTER_NOZZLE_DIAMETER: f64 = 4.0;

/// Orca's `object_skirt_offset`: how far a skirt around each object reaches past the clearance
/// the objects already keep, mm.
fn skirt_offset(config: &PrintConfig, short: bool) -> f64 {
    let per_object =
        matches!(config.raw.get("skirt_type"), Some(serde_json::Value::String(t)) if t == "perobject");
    if !per_object || config.skirt_loops == 0 {
        return 0.0;
    }
    let width =
        config.line_width + f64::from(config.skirt_loops - 1) * crate::session::skirt_spacing_mm(config);
    let shield =
        matches!(config.raw.get("draft_shield"), Some(serde_json::Value::String(t)) if t == "enabled");
    let layer = config.raw_number("max_layer_height", 0.0);
    if short {
        config.skirt_distance + width
    } else if shield || f64::from(config.skirt_height) * layer > config.raw_number("nozzle_height", 2.5) {
        config.skirt_distance + config.line_width
    } else if config.skirt_distance + width > config.raw_number("extruder_clearance_radius", 40.0) / 2.0 {
        config.skirt_distance + width - config.raw_number("extruder_clearance_radius", 40.0) / 2.0
    } else {
        0.0
    }
}

/// Distance between two convex polygons, 0 when they touch or overlap.
fn hull_distance(a: &[[f64; 2]], b: &[[f64; 2]]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return f64::INFINITY;
    }
    if a.iter().any(|&p| contains(b, p)) || b.iter().any(|&p| contains(a, p)) || crosses(a, b) {
        return 0.0;
    }
    let edges = |poly: &[[f64; 2]]| -> Vec<([f64; 2], [f64; 2])> {
        (0..poly.len())
            .filter_map(|k| Some((*poly.get(k)?, *poly.get((k + 1) % poly.len())?)))
            .collect()
    };
    let mut best = f64::INFINITY;
    for &p in a {
        for (s, e) in edges(b) {
            best = best.min(point_segment(p, s, e));
        }
    }
    for &p in b {
        for (s, e) in edges(a) {
            best = best.min(point_segment(p, s, e));
        }
    }
    best
}

fn point_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 <= 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    };
    (p[0] - (a[0] + t * dx)).m_hypot(p[1] - (a[1] + t * dy))
}

/// Inside test for a convex polygon of either winding.
fn contains(poly: &[[f64; 2]], p: [f64; 2]) -> bool {
    let (mut pos, mut neg) = (false, false);
    for k in 0..poly.len() {
        let (Some(a), Some(b)) = (poly.get(k), poly.get((k + 1) % poly.len())) else {
            continue;
        };
        let cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        pos |= cross > 0.0;
        neg |= cross < 0.0;
    }
    !(pos && neg)
}

fn crosses(a: &[[f64; 2]], b: &[[f64; 2]]) -> bool {
    let orient =
        |p: [f64; 2], q: [f64; 2], r: [f64; 2]| (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    for i in 0..a.len() {
        let (Some(&p1), Some(&p2)) = (a.get(i), a.get((i + 1) % a.len())) else {
            continue;
        };
        for j in 0..b.len() {
            let (Some(&q1), Some(&q2)) = (b.get(j), b.get((j + 1) % b.len())) else {
                continue;
            };
            let (d1, d2) = (orient(p1, p2, q1), orient(p1, p2, q2));
            let (d3, d4) = (orient(q1, q2, p1), orient(q1, q2, p2));
            if d1 * d2 < 0.0 && d3 * d4 < 0.0 {
                return true;
            }
        }
    }
    false
}

/// Objects that print layer by layer with settings of their own: every layer holds the paths of
/// each object that has that layer, in plate order. The layer below the range is sliced too, for where
/// it ends (`LayerPaths::enter_from`), then dropped.
fn slice_interleaved(
    session: &SliceSession,
    config: &PrintConfig,
    layers: Range<u32>,
    progress: &dyn Progress,
) -> Result<SliceOutput> {
    let lo = layers.start.saturating_sub(1);
    let mut out = slice_interleaved_from(session, config, lo..layers.end, progress)?;
    let mut below_end = None;
    let mut below_wipe = crate::output::WipeTail::default();
    if lo < layers.start && !out.layers.is_empty() {
        let below = out.layers.remove(0);
        below_end = below.points.last().copied();
        below_wipe = below.wipe_tail();
    }
    for l in &mut out.layers {
        l.enter_from = below_end;
        below_end = l.points.last().copied().or(below_end);
        let tail = l.wipe_tail();
        l.below_wipe = if tail.points.is_empty() {
            below_wipe.clone()
        } else {
            std::mem::replace(&mut below_wipe, tail)
        };
    }
    out.warnings.retain(|w| w.layer.is_none_or(|i| i >= layers.start));
    out.first_layer = layers.start;
    Ok(out)
}

fn slice_interleaved_from(
    session: &SliceSession,
    config: &PrintConfig,
    layers: Range<u32>,
    progress: &dyn Progress,
) -> Result<SliceOutput> {
    if !session.interleaved_layers().is_empty() {
        return slice_interleaved_by_height(session, config, layers, progress);
    }
    if !session.instances().is_empty() {
        return crate::copies::slice(session, config, layers, progress);
    }
    let mut merged: Option<SliceOutput> = None;
    for (k, sub) in session.sequence().enumerate() {
        let hi = layers.end.min(sub.plan_count());
        if layers.start >= hi {
            continue;
        }
        if progress.cancelled() {
            return Err(crate::Error::Cancelled);
        }
        let cfg = session.object_config(k, config)?;
        let mut out = sub.slice_object_range(&cfg, layers.start..hi, progress)?;
        let Some(m) = merged.as_mut() else {
            for l in out.layers.iter_mut().filter(|l| l.cfg == 0) {
                carry_flow(&mut l.paths, &cfg, config, l.index == 0);
            }
            merged = Some(out);
            continue;
        };
        let base = u16::try_from(m.configs.len()).unwrap_or(u16::MAX);
        // Each object's paths print with the settings of the layer they join: its own flow goes into them.
        for (i, l) in out.layers.iter_mut().enumerate() {
            let own = config_of(&out.configs, &cfg, l.cfg);
            let writer = match m.layers.get(i) {
                Some(dst) => config_of(&m.configs, config, dst.cfg),
                None => config_of(&out.configs, config, l.cfg),
            };
            carry_flow(&mut l.paths, own, writer, l.index == 0);
        }
        m.configs.append(&mut out.configs);
        for (i, mut l) in out.layers.into_iter().enumerate() {
            if let Some(dst) = m.layers.get_mut(i) {
                let shift = u32::try_from(dst.points.len()).unwrap_or(0);
                dst.points.append(&mut l.points);
                for mut p in l.paths {
                    p.start += shift;
                    p.end += shift;
                    dst.paths.push(p);
                }
                dst.time_s += l.time_s;
            } else {
                if l.cfg > 0 {
                    l.cfg += base;
                }
                if l.prev_cfg > 0 {
                    l.prev_cfg += base;
                }
                m.layers.push(l);
            }
        }
        m.plate_top_z = m.plate_top_z.max(out.plate_top_z);
        for w in out.warnings {
            if !m.warnings.contains(&w) {
                m.warnings.push(w);
            }
        }
    }
    let mut out = match merged {
        Some(m) => m,
        None => session.slice_object_range(config, 0..0, progress)?,
    };
    out.layer_count = session.layer_count();
    out.first_layer = layers.start;
    out.tool_count = session.tool_count();
    out.plate_bounds = session.plate_bounds();
    out.first_layer_info = session.first_layer_info(config);
    out.objects = session.footprints().to_vec();
    Ok(out)
}

/// [`slice_interleaved`] when the objects have layers of different heights (support on layers of
/// its own): the plate's layers pair the objects' layers by height, and each object adds its paths
/// to the plate layers it has a layer in, its beads scaled to that layer's height.
fn slice_interleaved_by_height(
    session: &SliceSession,
    config: &PrintConfig,
    layers: Range<u32>,
    progress: &dyn Progress,
) -> Result<SliceOutput> {
    let plan = session.interleaved_layers();
    let span = plan
        .get(layers.start as usize..layers.end as usize)
        .unwrap_or(&[]);
    let mut slots: Vec<Option<crate::output::LayerPaths>> = vec![None; span.len()];
    let mut merged: Option<SliceOutput> = None;
    for (k, sub) in session.sequence().enumerate() {
        // The object's print layers in this range, and which plate layer each one goes to.
        let mine: Vec<(usize, u32)> = span
            .iter()
            .enumerate()
            .filter_map(|(g, l)| l.1.get(k).copied().flatten().map(|i| (g, i)))
            .collect();
        let (Some(&(_, lo)), Some(&(_, hi))) = (mine.first(), mine.last()) else {
            continue;
        };
        if progress.cancelled() {
            return Err(crate::Error::Cancelled);
        }
        let cfg = session.object_config(k, config)?;
        let mut out = sub.slice_object_range(&cfg, lo..hi + 1, progress)?;
        let base = merged
            .as_ref()
            .map_or(0, |m| u16::try_from(m.configs.len()).unwrap_or(u16::MAX));
        let earlier: &[PrintConfig] = merged.as_ref().map_or(&[], |m| &m.configs);
        for (l, &(g, _)) in std::mem::take(&mut out.layers).into_iter().zip(&mine) {
            let mut l = l;
            let global = layers.start + u32::try_from(g).unwrap_or(u32::MAX);
            // Each object's paths print with the settings of the layer they join: its own flow goes into them.
            let own = config_of(&out.configs, &cfg, l.cfg);
            let writer = match slots.get(g) {
                Some(Some(dst)) => config_of(earlier, config, dst.cfg),
                _ => config_of(&out.configs, config, l.cfg),
            };
            carry_flow(&mut l.paths, own, writer, global == 0);
            l.index = global;
            l.local = global;
            if l.cfg > 0 {
                l.cfg += base;
            }
            if l.prev_cfg > 0 {
                l.prev_cfg += base;
            }
            match slots.get_mut(g) {
                Some(Some(dst)) => {
                    let shift = u32::try_from(dst.points.len()).unwrap_or(0);
                    let (from, to) = (f64::from(l.height), f64::from(dst.height));
                    dst.points.append(&mut l.points);
                    for mut p in l.paths {
                        p.start += shift;
                        p.end += shift;
                        if (from - to).abs() > 1e-6 {
                            p.flow *= crate::session::bead_ratio(f64::from(p.width_mm), from, to)
                                .max(f32::MIN_POSITIVE);
                        }
                        dst.paths.push(p);
                    }
                    dst.time_s += l.time_s;
                }
                Some(slot) => *slot = Some(l),
                None => {}
            }
        }
        match merged.as_mut() {
            None => merged = Some(out),
            Some(m) => {
                m.configs.append(&mut out.configs);
                m.plate_top_z = m.plate_top_z.max(out.plate_top_z);
                for w in out.warnings {
                    if !m.warnings.contains(&w) {
                        m.warnings.push(w);
                    }
                }
            }
        }
    }
    let mut out = match merged {
        Some(m) => m,
        None => session.slice_object_range(config, 0..0, progress)?,
    };
    out.layers = slots.into_iter().flatten().collect();
    out.layer_count = session.layer_count();
    out.first_layer = layers.start;
    out.tool_count = session.tool_count();
    out.plate_bounds = session.plate_bounds();
    out.first_layer_info = session.first_layer_info(config);
    out.objects = session.footprints().to_vec();
    Ok(out)
}
