// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Copies of one object on a plate printed layer by layer: each object is sliced once and every copy prints
//! its paths moved to its place, as Orca and Bambu Studio print the instances of an object.
//! Each plate layer then gets its time and cooling slowdown as one layer. When the copies' first layers
//! (brims included) would meet, the whole plate is sliced as one instead, so brims stay plate wide.

use crate::Progress;
use crate::config::PrintConfig;
use crate::error::Result;
use crate::fm::Fm;
use crate::output::{LayerPaths, SliceOutput};
use crate::session::SliceSession;
use std::ops::Range;

/// Slices `layers` of a plate of copies (`SliceSession::instances`).
pub(crate) fn slice(
    session: &SliceSession,
    config: &PrintConfig,
    layers: Range<u32>,
    progress: &dyn Progress,
) -> Result<SliceOutput> {
    let mut cfg = config.clone();
    cfg.slow_down_for_layer_cooling = false;
    let subs: Vec<&SliceSession> = session.sequence().collect();
    let mut outs: Vec<Option<SliceOutput>> = Vec::with_capacity(subs.len());
    for sub in &subs {
        if progress.cancelled() {
            return Err(crate::Error::Cancelled);
        }
        let hi = layers.end.min(sub.plan_count());
        outs.push(if layers.start < hi {
            Some(sub.slice_object_range(&cfg, layers.start..hi, progress)?)
        } else {
            None
        });
    }
    // Where each object's first layer reaches, brim included.
    let mut extents: Vec<Option<[i32; 4]>> = Vec::with_capacity(subs.len());
    for (sub, out) in subs.iter().zip(&outs) {
        let first = match out.as_ref().filter(|_| layers.start == 0) {
            Some(o) => extent(o.layers.first()),
            None => extent(
                sub.slice_object_range(&cfg, 0..1.min(sub.plan_count()), progress)?
                    .layers
                    .first(),
            ),
        };
        extents.push(first);
    }
    let placed: Vec<Option<[i32; 4]>> = session
        .instances()
        .iter()
        .map(|c| {
            let e = extents.get(c.sub).copied().flatten()?;
            Some([
                e[0] + c.shift[0],
                e[1] + c.shift[1],
                e[2] + c.shift[0],
                e[3] + c.shift[1],
            ])
        })
        .collect();
    let meet = placed.iter().enumerate().any(|(i, a)| {
        placed.iter().skip(i + 1).any(|b| match (a, b) {
            (Some(a), Some(b)) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3],
            _ => false,
        })
    });
    if meet && let Some(whole) = session.whole_plate() {
        let mut out = whole.slice_range_with(config, layers, progress)?;
        for w in session.warnings() {
            if !out.warnings.contains(w) {
                out.warnings.push(w.clone());
            }
        }
        return Ok(out);
    }
    // Every layer prints the copies nearest first, from the bed's origin: the order is the same on each layer
    // and in each shard.
    let center = |b: &Option<[i32; 4]>| {
        b.map_or([0.0, 0.0], |b| {
            [
                f64::midpoint(f64::from(b[0]), f64::from(b[2])),
                f64::midpoint(f64::from(b[1]), f64::from(b[3])),
            ]
        })
    };
    let mut left: Vec<usize> = (0..placed.len()).collect();
    let mut order: Vec<usize> = Vec::with_capacity(left.len());
    let mut at = [0.0, 0.0];
    while !left.is_empty() {
        let d = |k: &usize| {
            let c = placed.get(*k).map_or([0.0, 0.0], center);
            (c[0] - at[0]).m_powi(2) + (c[1] - at[1]).m_powi(2)
        };
        let (pos, _) =
            left.iter().enumerate().fold(
                (0, f64::MAX),
                |best, (i, k)| if d(k) < best.1 { (i, d(k)) } else { best },
            );
        let k = left.remove(pos);
        at = placed.get(k).map_or([0.0, 0.0], center);
        order.push(k);
    }
    let mut merged: Vec<LayerPaths> = Vec::new();
    let mut info = crate::output::FirstLayerInfo::default();
    for c in order.iter().filter_map(|&k| session.instances().get(k)) {
        #[allow(clippy::cast_possible_truncation, reason = "outlines are single precision")]
        let (dx, dy) = (
            (f64::from(c.shift[0]) / crate::geom::SCALE) as f32,
            (f64::from(c.shift[1]) / crate::geom::SCALE) as f32,
        );
        if let Some(sub) = subs.get(c.sub) {
            let own = sub.first_layer_info(&cfg);
            info.area_mm2 += own.area_mm2;
            info.rings.extend(
                own.rings
                    .iter()
                    .map(|r| r.iter().map(|p| [p[0] + dx, p[1] + dy]).collect()),
            );
            info.skirt_outline.extend(own.skirt_outline.iter().map(|p| {
                [
                    p[0] + f64::from(c.shift[0]) / crate::geom::SCALE,
                    p[1] + f64::from(c.shift[1]) / crate::geom::SCALE,
                ]
            }));
        }
        let Some(out) = outs.get(c.sub).and_then(Option::as_ref) else {
            continue;
        };
        for (i, l) in out.layers.iter().enumerate() {
            let mut l = l.clone();
            move_layer(&mut l, c.shift);
            crate::owners::to_plate(&mut l, c.object);
            match merged.get_mut(i) {
                Some(dst) => append_layer(dst, l),
                None => merged.push(l),
            }
        }
    }
    let Some(mut out) = outs.iter_mut().find_map(Option::take) else {
        return session.slice_object_range(config, 0..0, progress);
    };
    for other in outs.into_iter().flatten() {
        out.plate_top_z = out.plate_top_z.max(other.plate_top_z);
        for w in other.warnings {
            if !out.warnings.contains(&w) {
                out.warnings.push(w);
            }
        }
    }
    for l in &mut merged {
        let own = usize::from(l.cfg)
            .checked_sub(1)
            .and_then(|i| out.configs.get(i))
            .unwrap_or(config);
        crate::paths::cool(l, own);
    }
    out.layers = merged;
    out.layer_count = session.layer_count();
    out.first_layer = layers.start;
    out.tool_count = session.tool_count();
    out.plate_bounds = session.plate_bounds();
    out.first_layer_info = info;
    out.objects = session.footprints().to_vec();
    Ok(out)
}

/// Bounds of a layer's points, internal units.
fn extent(l: Option<&LayerPaths>) -> Option<[i32; 4]> {
    let mut it = l?.points.iter();
    let f = it.next()?;
    Some(it.fold([f.x, f.y, f.x, f.y], |b, p| {
        [b[0].min(p.x), b[1].min(p.y), b[2].max(p.x), b[3].max(p.y)]
    }))
}

/// Moves a layer's paths and areas by `shift`, internal units.
fn move_layer(l: &mut LayerPaths, shift: [i32; 2]) {
    let moved = |shapes: &mut crate::perimeters::Shapes| {
        for p in shapes.iter_mut().flatten().flatten() {
            p.x += shift[0];
            p.y += shift[1];
        }
    };
    for p in &mut l.points {
        p.x += shift[0];
        p.y += shift[1];
    }
    if let Some(a) = l.areas.as_mut() {
        for s in [&mut a.slice, &mut a.top, &mut a.bottom, &mut a.solid] {
            moved(s);
        }
    }
    if let Some(s) = l.support_areas.as_mut() {
        moved(&mut s.islands);
    }
    if let Some(s) = l.lift_overhangs.as_mut() {
        moved(s);
    }
    for p in l.joins.iter_mut().flatten() {
        p.x += shift[0];
        p.y += shift[1];
    }
}

/// Adds the paths and areas of `l` after those of `dst` (the same layer of another copy).
fn append_layer(dst: &mut LayerPaths, mut l: LayerPaths) {
    let shift = u32::try_from(dst.points.len()).unwrap_or(0);
    // Per point heights and flows: a layer without them prints at its own height and usual flow.
    if !dst.zs.is_empty() || !l.zs.is_empty() {
        for x in [&mut *dst, &mut l] {
            if x.zs.is_empty() {
                x.zs = vec![x.z; x.points.len()];
                x.flows = vec![1.0; x.points.len()];
            }
        }
        dst.zs.append(&mut l.zs);
        dst.flows.append(&mut l.flows);
    }
    dst.points.append(&mut l.points);
    for mut p in l.paths {
        p.start += shift;
        p.end += shift;
        dst.paths.push(p);
    }
    match (dst.areas.as_mut(), l.areas) {
        (Some(d), Some(a)) => {
            let a = *a;
            d.slice.extend(a.slice);
            d.top.extend(a.top);
            d.bottom.extend(a.bottom);
            d.solid.extend(a.solid);
        }
        (None, Some(a)) => dst.areas = Some(a),
        _ => {}
    }
    match (dst.support_areas.as_mut(), l.support_areas) {
        (Some(d), Some(a)) => d.islands.extend(a.islands),
        (None, Some(a)) => dst.support_areas = Some(a),
        _ => {}
    }
    match (dst.lift_overhangs.as_mut(), l.lift_overhangs) {
        (Some(d), Some(a)) => d.extend(*a),
        (None, Some(a)) => dst.lift_overhangs = Some(a),
        _ => {}
    }
    dst.joins.append(&mut l.joins);
}
