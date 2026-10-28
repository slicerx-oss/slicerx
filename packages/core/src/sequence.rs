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
use crate::output::{Feature, LayerPaths, PathInfo, SliceOutput, StageMicros, TurnRoom};
use crate::session::{HandOver, PlateTurn, SliceSession};
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
            // Its paths carry the object's index on the plate (`owners.rs`).
            for l in &mut out.layers {
                crate::owners::to_plate(l, sub.plate_index());
            }
            take_over(&incoming(session, k), sub, &mut out.layers);
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
            if let Some(model) = session.collide() {
                out.collisions = crate::collide::walk::object_layers(
                    model,
                    k,
                    &out.layers,
                    cfg.travel_speed,
                    crate::collide::lifts_over_print(config),
                );
            }
            match merged.as_mut() {
                None => merged = Some(out),
                Some(m) => {
                    m.collisions.merge(std::mem::take(&mut out.collisions));
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
                        bridges: a.bridges + b.bridges,
                        seams: a.seams + b.seams,
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
    // The plate's top, not the top of the objects this range prints: `max_layer_z` in the end G-code and the
    // header's `max_z_height` read it, so every range reports the whole plate's, as one range does.
    #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
    {
        out.plate_top_z = below_top as f32;
    }
    out.layer_count = total;
    out.first_layer = layers.start;
    out.tool_count = session.tool_count();
    out.plate_bounds = session.plate_bounds();
    out.first_layer_info = session.first_layer_info(config);
    out.objects = session.footprints().to_vec();
    Ok(out)
}

/// The settings of config index `cfg` (0 is `base`, `k` is `configs[k - 1]`).
/// What the objects before the `k`th leave it, from their plans: the filament the last of them that prints
/// ends on, the tools they print with, their tool changes and the changes between them, and what each
/// nozzle holds. Plans alone, so a layer range that starts at the `k`th object gets the same as one that
/// printed the objects before it.
fn incoming(session: &SliceSession, k: usize) -> HandOver {
    let mut came = HandOver::default();
    for h in session.sequence().take(k).map(SliceSession::hand_over) {
        if h.first == 0 {
            continue;
        }
        came.changes += h.changes + u32::from(came.last != 0 && h.first != came.last);
        came.tools |= h.tools;
        if came.held.len() < h.held.len() {
            came.held.resize(h.held.len(), 0);
        }
        for (c, &n) in came.held.iter_mut().zip(&h.held) {
            if n != 0 {
                *c = n;
            }
        }
        if came.first == 0 {
            came.first = h.first;
        }
        came.last = h.last;
    }
    came
}

/// An object's own session starts as if nothing printed before it, and one of a single filament plans no
/// tool order, so its layers start on no known filament: the writer then selects the filament with a bare
/// `T` instead of the profile's change G-code, at the object's first layer and at every layer after. Its
/// layers start on what the objects before it ended on (`came`), and later on the filament the object
/// itself holds, and count the tools and changes before them.
fn take_over(came: &HandOver, sub: &SliceSession, layers: &mut [LayerPaths]) {
    let own = sub.hand_over();
    let switch = u32::from(came.last != 0 && own.first != 0 && own.first != came.last);
    for l in layers {
        if l.start_tool == 0 {
            l.start_tool = if l.local == 0 {
                came.last
            } else {
                sub.tool_after(l.local)
            };
        }
        l.tools_before |= came.tools;
        l.changes_before += came.changes + if l.local > 0 { switch } else { 0 };
        if !came.held.is_empty() {
            if l.held_before.len() < came.held.len() {
                l.held_before.resize(came.held.len(), 0);
            }
            for (h, &c) in l.held_before.iter_mut().zip(&came.held) {
                if *h == 0 {
                    *h = c;
                }
            }
        }
    }
}

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

/// Objects that print layer by layer with settings of their own: every layer holds the paths of
/// each object that has that layer, in the layer's object order (`objorder.rs`; plate order with `print_order` as
/// object list). The layer below the range is sliced too, for where
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
        below_end = below.exit_point();
        below_wipe = below.wipe_tail();
        // An empty layer below leaves the nozzle where the last layer with paths ended, as one range over the
        // whole plate carries it up.
        if below.paths.is_empty() && lo > 0 {
            let under = slice_interleaved(session, config, lo.saturating_sub(8)..lo, &crate::NoProgress)?;
            (below_end, below_wipe) = under
                .layers
                .iter()
                .rev()
                .find(|l| !l.paths.is_empty())
                .map(|l| (l.exit_point(), l.wipe_tail()))
                .or_else(|| under.layers.first().map(|l| (l.enter_from, l.below_wipe.clone())))
                .unwrap_or_default();
        }
    }
    for l in &mut out.layers {
        l.enter_from = below_end;
        below_end = l.exit_point().or(below_end);
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
    // Per merged layer, where each object's paths start and what its layer reported for the tower.
    let mut sources: Vec<Sources> = Vec::new();
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
        // Its paths carry the object's index on the plate (`owners.rs`).
        for l in &mut out.layers {
            crate::owners::to_plate(l, sub.plate_index());
        }
        let Some(m) = merged.as_mut() else {
            for l in out.layers.iter_mut().filter(|l| l.cfg == 0) {
                carry_flow(&mut l.paths, &cfg, config, l.index == 0);
            }
            sources = out.layers.iter_mut().map(|l| Sources::of(k, l)).collect();
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
                if let Some(src) = sources.get_mut(i) {
                    src.add(k, dst.paths.len(), &mut l);
                }
                join_speeds(dst, &l);
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
                sources.push(Sources::of(k, &mut l));
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
    if let Some(m) = merged.as_mut() {
        for (l, src) in m.layers.iter_mut().zip(sources.iter_mut()) {
            in_object_order(session, config, l, src);
        }
    }
    let mut out = match merged {
        Some(m) => m,
        None => session.slice_object_range(config, 0..0, progress)?,
    };
    if session.plate_tools().is_some() {
        let merged: Vec<(u32, LayerPaths, Sources)> = std::mem::take(&mut out.layers)
            .into_iter()
            .zip(sources)
            .enumerate()
            .map(|(i, (l, src))| (layers.start + u32::try_from(i).unwrap_or(u32::MAX), l, src))
            .collect();
        out.layers = print_as_plate(session, config, &out.configs, merged);
    }
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
    let mut sources: Vec<Sources> = std::iter::repeat_with(Sources::default)
        .take(span.len())
        .collect();
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
        // Its paths carry the object's index on the plate (`owners.rs`).
        for l in &mut out.layers {
            crate::owners::to_plate(l, sub.plate_index());
        }
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
                    if let Some(src) = sources.get_mut(g) {
                        src.add(k, dst.paths.len(), &mut l);
                    }
                    join_speeds(dst, &l);
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
                Some(slot) => {
                    if let Some(src) = sources.get_mut(g) {
                        *src = Sources::of(k, &mut l);
                    }
                    *slot = Some(l);
                }
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
    for (l, src) in slots.iter_mut().zip(sources.iter_mut()) {
        if let Some(l) = l {
            in_object_order(session, config, l, src);
        }
    }
    let mut out = match merged {
        Some(m) => m,
        None => session.slice_object_range(config, 0..0, progress)?,
    };
    out.layers = if session.plate_tools().is_some() {
        // Each plate layer holds the objects' layers it pairs by height.
        let merged: Vec<(u32, LayerPaths, Sources)> = slots
            .into_iter()
            .zip(sources)
            .enumerate()
            .filter_map(|(g, (l, src))| {
                l.map(|l| (layers.start + u32::try_from(g).unwrap_or(u32::MAX), l, src))
            })
            .collect();
        print_as_plate(session, config, &out.configs, merged)
    } else {
        slots.into_iter().flatten().collect()
    };
    out.layer_count = session.layer_count();
    out.first_layer = layers.start;
    out.tool_count = session.tool_count();
    out.plate_bounds = session.plate_bounds();
    out.first_layer_info = session.first_layer_info(config);
    out.objects = session.footprints().to_vec();
    Ok(out)
}

/// Puts the objects of a merged layer in the order the objects on it print in (`objorder.rs`), unless the plate
/// prints in object list order. Each object's paths stay together and in their own order, and `src` follows them.
/// The paths of no object the layer starts with (the skirt) stay first, with the object that now prints first.
fn in_object_order(session: &SliceSession, config: &PrintConfig, l: &mut LayerPaths, src: &mut Sources) {
    if src.runs.len() < 2 || crate::objorder::list_order(config) {
        return;
    }
    let n = l.paths.len();
    let subs: Vec<&SliceSession> = session.sequence().collect();
    let plate = |k: usize| subs.get(k).map_or(u16::MAX, |s| s.plate_index());
    // Each object's paths: (object of the sequence, first path, past its last).
    let mut runs: Vec<(usize, usize, usize)> = src
        .runs
        .iter()
        .enumerate()
        .map(|(r, &(k, at))| (k, at, src.runs.get(r + 1).map_or(n, |x| x.1)))
        .collect();
    let lead = runs.first().map_or(0, |r| {
        l.paths.get(r.1..r.2).map_or(0, |p| {
            p.iter()
                .take_while(|p| p.owner == crate::preview::OBJECT_NONE)
                .count()
        }) + r.1
    });
    if let Some(r) = runs.first_mut() {
        r.1 = lead;
    }
    // Numbered by plate object for the order's ties.
    crate::sorting::sort_by_key(&mut runs, |r| plate(r.0));
    let centers: Vec<[f64; 2]> = runs
        .iter()
        .map(|r| {
            session
                .footprints()
                .get(usize::from(plate(r.0)))
                .map_or([0.0, 0.0], |o| o.center)
        })
        .collect();
    let order: Vec<(usize, usize, usize)> = crate::objorder::order(&centers)
        .into_iter()
        .filter_map(|i| runs.get(i).copied())
        .collect();
    if order.len() != runs.len() {
        return;
    }
    let old = std::mem::take(&mut l.paths);
    let old_speeds = l.unslowed.take().filter(|s| s.len() == old.len());
    let mut speeds: Vec<f32> = Vec::with_capacity(n);
    let mut new_runs: Vec<(usize, usize)> = Vec::with_capacity(order.len());
    let ranges = std::iter::once((usize::MAX, 0, lead)).chain(order.iter().copied());
    for (k, from, to) in ranges {
        if k != usize::MAX {
            new_runs.push((k, if new_runs.is_empty() { 0 } else { l.paths.len() }));
        }
        for i in from..to {
            if let Some(p) = old.get(i) {
                l.paths.push(*p);
                speeds.push(
                    old_speeds
                        .as_ref()
                        .and_then(|s| s.get(i))
                        .copied()
                        .unwrap_or(p.speed_mm_s),
                );
            }
        }
    }
    if old_speeds.is_some() {
        l.unslowed = Some(speeds.into_boxed_slice());
    }
    src.runs = new_runs;
}

/// Each object's layer was slowed for cooling on its own; the speeds before that go along with its paths into the
/// merged layer, so the cooling slowdown is worked out again for the whole layer (`gcode::settle_cooling`).
fn join_speeds(dst: &mut LayerPaths, l: &LayerPaths) {
    if dst.unslowed.is_none() && l.unslowed.is_none() {
        return;
    }
    let own = |x: &LayerPaths| -> Vec<f32> {
        match x.unslowed.as_ref().filter(|s| s.len() == x.paths.len()) {
            Some(s) => s.to_vec(),
            None => x.paths.iter().map(|p| p.speed_mm_s).collect(),
        }
    };
    let mut speeds = own(dst);
    speeds.extend(own(l));
    dst.unslowed = Some(speeds.into_boxed_slice());
}

/// What a merged layer holds of each object: where the object's paths start (objects in print order), and the first
/// work of each filament its layer reported (`LayerPaths::turns`).
#[derive(Debug, Clone, Default)]
struct Sources {
    /// (object of the sequence, index of its first path)
    runs: Vec<(usize, usize)>,
    turns: Vec<(usize, TurnRoom)>,
}

impl Sources {
    /// A merged layer that starts with the `k`th object's layer `l`.
    fn of(k: usize, l: &mut LayerPaths) -> Self {
        let mut s = Self::default();
        s.add(k, 0, l);
        s
    }

    /// The `k`th object's layer `l` joins the merged layer at path `at`.
    fn add(&mut self, k: usize, at: usize, l: &mut LayerPaths) {
        self.runs.push((k, at));
        self.turns
            .extend(std::mem::take(&mut l.turns).into_iter().map(|t| (k, t)));
    }

    /// The object of the sequence path `i` belongs to.
    fn object_of(&self, i: usize) -> usize {
        self.runs
            .iter()
            .take_while(|r| r.1 <= i)
            .last()
            .map_or(0, |r| r.0)
    }

    /// The first work of filament `tool` on the `k`th object's layer.
    fn turn(&self, k: usize, tool: u8) -> Option<&TurnRoom> {
        self.turns
            .iter()
            .find(|(o, t)| *o == k && t.tool == tool)
            .map(|(_, t)| t)
    }
}

/// Prints the merged layers of a plate whose objects come from sessions of their own (each with its own settings) as
/// one session of the whole plate prints them: the paths of each filament together across the objects, in the
/// plate's tool order (`SliceSession::plate_tools`), the objects in the layer's order within one filament, and the
/// prime tower once for the plate's changes. Every path keeps its own settings, flow and object. `layers` are the
/// merged layers in order, each with its plate layer.
fn print_as_plate(
    session: &SliceSession,
    config: &PrintConfig,
    configs: &[PrintConfig],
    layers: Vec<(u32, LayerPaths, Sources)>,
) -> Vec<LayerPaths> {
    let Some(tools) = session.plate_tools() else {
        return layers.into_iter().map(|(_, l, _)| l).collect();
    };
    let mut done: Vec<LayerPaths> = Vec::with_capacity(layers.len());
    let mut below: Option<(u32, u8)> = None;
    for (g, mut l, src) in layers {
        // The layer starts on the filament the plate layer below ended on; the plan's when that layer is not here.
        let start = below
            .filter(|b| Some(b.0) == g.checked_sub(1) && b.1 != 0)
            .map_or_else(|| session.plate_start(g), |b| b.1);
        let order: &[u8] = tools.orders.get(g as usize).map_or(&[], Vec::as_slice);
        print_layer_as_plate(
            session,
            config_of(configs, config, l.cfg),
            g,
            start,
            order,
            &mut l,
            &src,
        );
        below = Some((g, l.paths.last().map_or(0, |p| p.tool)));
        done.push(l);
    }
    done
}

/// [`print_as_plate`] for one layer, plate layer `g`, that starts on filament `start` and prints its filaments in
/// `order` (filaments the plan does not have follow as they come, so where the layer ends does not depend on where it
/// starts, and a range that starts on the next layer starts as the whole plate does).
fn print_layer_as_plate(
    session: &SliceSession,
    layer_cfg: &PrintConfig,
    g: u32,
    start: u8,
    order: &[u8],
    l: &mut LayerPaths,
    src: &Sources,
) {
    let mut extra: Vec<u8> = Vec::new();
    for p in &l.paths {
        if !order.contains(&p.tool) && !extra.contains(&p.tool) {
            extra.push(p.tool);
        }
    }
    let tools: Vec<u8> = order
        .iter()
        .copied()
        .filter(|t| l.paths.iter().any(|p| p.tool == *t))
        .chain(extra)
        .collect();
    // Each filament's paths, the objects in the layer's order.
    let groups: Vec<Vec<usize>> = tools
        .iter()
        .map(|&t| {
            (0..l.paths.len())
                .filter(|&i| l.paths.get(i).is_some_and(|p| p.tool == t))
                .collect()
        })
        .collect();
    // The print's first layer prints with its own line widths, the tower's too.
    let first = matches!(session.plate_tower_layer(layer_cfg, g, start), Some((at, None)) if at.first);
    let first_cfg;
    let cfg = if first {
        first_cfg = layer_cfg.for_first_layer();
        &first_cfg
    } else {
        layer_cfg
    };
    let plate_layer = session.plate_tower_layer(cfg, g, start);
    let support_only = matches!(plate_layer, Some((_, Some(_))));
    let mut turns: Vec<PlateTurn> = tools
        .iter()
        .zip(&groups)
        .map(|(&tool, paths)| {
            let mut turn = PlateTurn {
                tool,
                ..PlateTurn::default()
            };
            let mut seen: Vec<usize> = Vec::new();
            for &i in paths {
                let k = src.object_of(i);
                if seen.contains(&k) {
                    continue;
                }
                seen.push(k);
                let Some(r) = src.turn(k, tool) else { continue };
                if support_only {
                    turn.support += r.support;
                    continue;
                }
                // The sparse infill of every object that prints it first takes up the purge (printed first below);
                // solid infill and support only of the object right after the change.
                if r.flush_first {
                    turn.infill += r.infill;
                }
                if seen.len() == 1 {
                    turn.solid = r.solid;
                    turn.support = r.support;
                }
            }
            turn
        })
        .collect();
    let changes = match &plate_layer {
        Some((at, None)) => session.tower_turns(cfg, at, &mut turns),
        Some((at, Some(walled))) => {
            session.support_tower_turns(cfg, at, *walled, &mut turns);
            Vec::new()
        }
        None => Vec::new(),
    };
    l.tower_changes = changes;
    let old = std::mem::take(&mut l.paths);
    let old_speeds = l.unslowed.take().filter(|s| s.len() == old.len());
    let mut speeds: Vec<f32> = Vec::new();
    let mut seconds = 0.0;
    for (turn, paths) in turns.iter().zip(&groups) {
        let from = l.paths.len();
        seconds += crate::paths::push_tower(l, cfg, turn.tool, &turn.tower, true);
        speeds.extend(l.paths.get(from..).into_iter().flatten().map(|p| p.speed_mm_s));
        // After a purge the objects that print their sparse infill first print it before anything else.
        let mut front: Vec<usize> = Vec::new();
        let mut rest: Vec<usize> = Vec::new();
        let mut k_at: Option<(usize, bool)> = None;
        for &i in paths {
            let k = src.object_of(i);
            let leading = match k_at {
                Some((o, leading)) if o == k => leading,
                _ => turn.flush_first && src.turn(k, turn.tool).is_some_and(|r| r.flush_first),
            };
            let sparse = old.get(i).is_some_and(|p| p.feature == Feature::SparseInfill);
            k_at = Some((k, leading && sparse));
            if leading && sparse {
                front.push(i);
            } else {
                rest.push(i);
            }
        }
        for i in front.into_iter().chain(rest) {
            if let Some(p) = old.get(i) {
                l.paths.push(*p);
                speeds.push(
                    old_speeds
                        .as_ref()
                        .and_then(|s| s.get(i))
                        .copied()
                        .unwrap_or(p.speed_mm_s),
                );
            }
        }
        let from = l.paths.len();
        seconds += crate::paths::push_tower(l, cfg, turn.tool, &turn.tower_after, false);
        speeds.extend(l.paths.get(from..).into_iter().flatten().map(|p| p.speed_mm_s));
    }
    if old_speeds.is_some() {
        l.unslowed = Some(speeds.into_boxed_slice());
    }
    #[allow(clippy::cast_possible_truncation, reason = "layer times are small")]
    {
        l.time_s += seconds as f32;
    }
    // Without sparse tower layers a change prints on top of the tower as it stands, below the layer.
    crate::session::sink_tower(l, session.plate_tower_sunk(cfg, g));
    l.start_tool = start;
    (l.tools_before, l.changes_before, l.held_before) = session.plate_before(g);
}
