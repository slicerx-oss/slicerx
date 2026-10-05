// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The model volumes organic trees avoid, as Orca's `TreeModelVolumes` (Support/TreeModelVolumes.cpp) computes
//! them for one object:
//!
//! - collision per radius and layer: the outlines grown by the radius and the minimum XY distance over the
//!   bottom Z gap layers, plus the layers of the top Z gap grown by a share of the XY distance that shrinks
//!   with height;
//! - hole-free collision: the collision of the radius branches always grow to, rounded, with its holes gone;
//! - avoidance to the bed (`Slow`, `FastSafe`, `Fast`) and to the model: the collision of each layer united
//!   with the avoidance of the layer below shrunk by the branch movement, in steps;
//! - placeable areas: the top surfaces a branch of a radius fits on;
//! - wall restrictions: what a branch may not cross between two layers.
//!
//! Radii are rounded up to the steps of `ceil_radius`, and every area is cached per rounded radius and layer.
//! As in Orca, the outlines of the object only (no machine border) are used, and the collision of the current
//! mesh uses the minimum XY distance with the difference to the regular one added to the radius on request.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::indexing_slicing,
    reason = "layer indices in i64 as Orca's LayerIndex, plate units in i64"
)]

use super::geo::{self, Join};
use super::settings::Settings;
use crate::perimeters::Shapes;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};

pub(crate) type Area = Arc<Shapes>;

/// `SUPPORT_TREE_EXPONENTIAL_FACTOR`, and its threshold and the collision resolution in plate units.
const EXPONENTIAL_FACTOR: f64 = 1.5;
fn exponential_threshold() -> i64 {
    geo::sc(1.0 * EXPONENTIAL_FACTOR)
}
fn collision_resolution() -> i64 {
    geo::sc(0.5)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum AvoidanceType {
    Slow,
    FastSafe,
    Fast,
}

/// Areas per layer and rounded radius.
#[derive(Default)]
struct Cache {
    data: RwLock<Vec<BTreeMap<i64, Area>>>,
}

impl Cache {
    fn get(&self, radius: i64, layer: i64) -> Option<Area> {
        if layer < 0 {
            return None;
        }
        let d = self.data.read().ok()?;
        d.get(layer as usize)?.get(&radius).cloned()
    }

    fn lower_bound(&self, radius: i64, layer: i64) -> Option<(i64, Area)> {
        let d = self.data.read().ok()?;
        let l = d.get(layer as usize)?;
        l.range(..=radius).next_back().map(|(k, v)| (*k, v.clone()))
    }

    /// `getMaxCalculatedLayer`: the highest layer above 0 that has `radius`, or -1.
    fn max_layer(&self, radius: i64) -> i64 {
        let Ok(d) = self.data.read() else { return -1 };
        let mut l = d.len() as i64 - 1;
        while l > 0 {
            if d[l as usize].contains_key(&radius) {
                break;
            }
            l -= 1;
        }
        if l <= 0 { -1 } else { l }
    }

    fn insert(&self, radius: i64, first: i64, areas: Vec<Shapes>) {
        let Ok(mut d) = self.data.write() else { return };
        let end = first as usize + areas.len();
        if d.len() < end {
            d.resize_with(end, BTreeMap::new);
        }
        for (i, a) in areas.into_iter().enumerate() {
            d[first as usize + i].entry(radius).or_insert_with(|| Arc::new(a));
        }
    }

    fn insert_pairs(&self, items: Vec<((i64, i64), Shapes)>) {
        let Ok(mut d) = self.data.write() else { return };
        for ((radius, layer), a) in items {
            let l = layer as usize;
            if d.len() <= l {
                d.resize_with(l + 1, BTreeMap::new);
            }
            d[l].entry(radius).or_insert_with(|| Arc::new(a));
        }
    }
}

/// `TreeModelVolumes` for one object.
pub(crate) struct Volumes {
    /// The object's outlines per layer, simplified by the resolution.
    outlines: Vec<Shapes>,
    /// Support blockers per layer.
    anti_overhang: Vec<Shapes>,
    /// The bed, which the drawn branches are clipped to.
    pub(crate) bed_area: Shapes,
    max_move: i64,
    max_move_slow: i64,
    min_resolution: i64,
    current_min_xy_dist: i64,
    current_min_xy_dist_delta: i64,
    support_rests_on_model: bool,
    increase_until_radius: i64,
    radius_0: i64,
    ignorable_radii: Vec<i64>,
    z_distance_bottom_layers: i64,
    z_distance_top_layers: i64,
    precalculated: bool,
    collision: Cache,
    collision_holefree: Cache,
    avoidance: [Cache; 3],
    avoidance_to_model: [Cache; 3],
    placeable: Cache,
    wall_restrictions: Cache,
    wall_restrictions_min: Cache,
}

fn type_index(t: AvoidanceType) -> usize {
    match t {
        AvoidanceType::Slow => 0,
        AvoidanceType::FastSafe => 1,
        AvoidanceType::Fast => 2,
    }
}

fn round_up_divide(x: i64, y: i64) -> i64 {
    (x + y - 1) / y
}

impl Volumes {
    /// `outlines` are the object's slices per layer, `blockers` the support blockers per layer.
    pub(crate) fn new(cfg: &Settings, outlines: &[Shapes], blockers: &[Shapes], bed_area: Shapes) -> Self {
        let res = cfg.resolution as f64;
        let outlines: Vec<Shapes> = crate::par::map(outlines, |o| geo::simplify(o, res));
        Self {
            outlines,
            anti_overhang: blockers.to_vec(),
            bed_area,
            // Orca takes 2 nm off "to avoid rounding errors", less than a plate unit here.
            max_move: cfg.maximum_move_distance.max(0),
            max_move_slow: cfg.maximum_move_distance_slow.max(0),
            min_resolution: cfg.resolution,
            current_min_xy_dist: cfg.xy_min_distance,
            current_min_xy_dist_delta: cfg.xy_distance - cfg.xy_min_distance,
            support_rests_on_model: !cfg.support_material_buildplate_only,
            increase_until_radius: cfg.increase_radius_until_radius,
            radius_0: cfg.get_radius(0, 0.0),
            ignorable_radii: Vec::new(),
            z_distance_bottom_layers: (cfg.support_bottom_distance as f64 / cfg.layer_height as f64).round()
                as i64,
            z_distance_top_layers: (cfg.support_top_distance as f64 / cfg.layer_height as f64).round() as i64,
            precalculated: false,
            collision: Cache::default(),
            collision_holefree: Cache::default(),
            avoidance: Default::default(),
            avoidance_to_model: Default::default(),
            placeable: Cache::default(),
            wall_restrictions: Cache::default(),
            wall_restrictions_min: Cache::default(),
        }
    }

    fn cache(&self, t: AvoidanceType, to_model: bool) -> &Cache {
        if to_model {
            &self.avoidance_to_model[type_index(t)]
        } else {
            &self.avoidance[type_index(t)]
        }
    }

    /// `ceilRadius(radius)`: rounded up to the steps below the exponential threshold, then by factors of 1.5.
    pub(crate) fn ceil_radius_raw(&self, radius: i64) -> i64 {
        if radius == 0 {
            return 0;
        }
        let ignore = |r: i64| self.ignorable_radii.binary_search(&r).is_ok();
        let mut out = self.radius_0;
        if radius > self.radius_0 {
            let initial_delta = exponential_threshold() - self.radius_0;
            if initial_delta > collision_resolution() {
                let num_steps = round_up_divide(initial_delta, exponential_threshold());
                let stepsize = initial_delta / num_steps;
                out += stepsize;
                for _ in 0..num_steps {
                    if out >= radius && !ignore(out) {
                        return out;
                    }
                    out += stepsize;
                }
            } else {
                out += collision_resolution();
            }
            while out < radius || ignore(out) {
                out = (out as f64 * EXPONENTIAL_FACTOR) as i64;
            }
        }
        out
    }

    /// `ceilRadius(radius, min_xy_dist)`: without the minimum XY distance the difference to the regular
    /// one is added first.
    pub(crate) fn ceil_radius(&self, radius: i64, min_xy_dist: bool) -> i64 {
        if min_xy_dist {
            self.ceil_radius_raw(radius)
        } else if radius > 0 {
            self.ceil_radius_raw(radius + self.current_min_xy_dist_delta)
        } else {
            self.current_min_xy_dist_delta
        }
    }

    /// `getRadiusNextCeil`.
    pub(crate) fn radius_next_ceil(&self, radius: i64, min_xy_dist: bool) -> i64 {
        if min_xy_dist {
            self.ceil_radius_raw(radius)
        } else {
            self.ceil_radius_raw(radius + self.current_min_xy_dist_delta) - self.current_min_xy_dist_delta
        }
    }

    /// `precalculate`: every collision, avoidance, placeable area and wall restriction the trees may ask for
    /// up to `max_layer`.
    pub(crate) fn precalculate(&mut self, cfg: &Settings, max_layer: i64) {
        self.precalculated = true;
        // The radii the tip can have; others between the first and the branch radius are never asked for.
        let mut tips: Vec<i64> = Vec::new();
        for dtt in 0..=cfg.tip_layers {
            tips.push(self.ceil_radius_raw(cfg.get_radius(dtt, 0.0)));
            tips.push(self.ceil_radius_raw(cfg.get_radius(dtt, 0.0) + self.current_min_xy_dist_delta));
        }
        tips.sort_unstable();
        tips.dedup();
        let mut ignorable = Vec::new();
        let mut r = self.radius_0;
        while r <= cfg.branch_radius {
            if tips.binary_search(&r).is_err() {
                ignorable.push(r);
            }
            r = self.ceil_radius_raw(r + 1);
        }
        self.ignorable_radii = ignorable;

        // The highest layer each radius is needed on.
        let mut until: HashMap<i64, i64> = HashMap::new();
        for dtt in 0..=max_layer {
            let current = max_layer - dtt;
            let mut up = |r: i64| {
                until.entry(r).or_insert(current);
            };
            up(self.ceil_radius_raw(cfg.get_radius(dtt as usize, 0.0) + self.current_min_xy_dist_delta));
            up(self.ceil_radius_raw(cfg.get_radius(dtt as usize, 0.0)));
            up(self.ceil_radius_raw(cfg.recommended_min_radius(current) + self.current_min_xy_dist_delta));
        }
        let mut avoidance_keys: Vec<(i64, i64)> = until.iter().map(|(&r, &l)| (r, l)).collect();
        avoidance_keys.sort_unstable();
        until.insert(
            self.ceil_radius_raw(self.increase_until_radius + self.current_min_xy_dist_delta),
            max_layer,
        );
        until.insert(0, max_layer);
        if self.current_min_xy_dist_delta != 0 {
            until.insert(self.current_min_xy_dist_delta, max_layer);
        }
        let mut collision_keys: Vec<(i64, i64)> = until.iter().map(|(&r, &l)| (r, l)).collect();
        collision_keys.sort_unstable();

        // Radius 0 first: its placeable areas feed the placeable areas of every other radius.
        crate::par::map(&collision_keys, |&(r, l)| self.calculate_collision(r, l));
        let holefree: Vec<(i64, i64)> = avoidance_keys
            .iter()
            .copied()
            .filter(|&(r, _)| r < self.increase_until_radius + self.current_min_xy_dist_delta)
            .collect();
        self.calculate_collision_holefree(&holefree);
        if self.support_rests_on_model {
            crate::par::map(&avoidance_keys, |&(r, l)| self.calculate_placeables(r, l));
        }
        self.calculate_avoidance(&avoidance_keys, true, self.support_rests_on_model);
        self.calculate_wall_restrictions(&avoidance_keys);
    }

    /// `getCollision`.
    pub(crate) fn collision(&self, orig_radius: i64, layer: i64, min_xy_dist: bool) -> Area {
        let radius = self.ceil_radius(orig_radius, min_xy_dist);
        if let Some(a) = self.collision.get(radius, layer) {
            return a;
        }
        self.calculate_collision(radius, layer);
        self.collision.get(radius, layer).unwrap_or_default()
    }

    /// `get_collision_lower_bound_area`: the collision of the largest cached radius not above `max_radius`.
    pub(crate) fn collision_lower_bound(&self, layer: i64, max_radius: i64) -> Option<(i64, Area)> {
        self.collision.lower_bound(max_radius, layer)
    }

    fn collision_holefree(&self, radius: i64, layer: i64) -> Area {
        if let Some(a) = self.collision_holefree.get(radius, layer) {
            return a;
        }
        self.calculate_collision_holefree(&[(radius, layer)]);
        self.collision_holefree.get(radius, layer).unwrap_or_default()
    }

    /// `getAvoidance`.
    pub(crate) fn avoidance(
        &self,
        orig_radius: i64,
        layer: i64,
        mut t: AvoidanceType,
        to_model: bool,
        min_xy_dist: bool,
    ) -> Area {
        if layer <= 0 {
            return self.collision(orig_radius, 0, min_xy_dist);
        }
        let radius = self.ceil_radius(orig_radius, min_xy_dist);
        if t == AvoidanceType::FastSafe
            && radius >= self.increase_until_radius + self.current_min_xy_dist_delta
        {
            t = AvoidanceType::Fast;
        }
        if let Some(a) = self.cache(t, to_model).get(radius, layer) {
            return a;
        }
        self.calculate_avoidance(&[(radius, layer)], !to_model, to_model);
        self.cache(t, to_model).get(radius, layer).unwrap_or_default()
    }

    /// `getPlaceableAreas`.
    pub(crate) fn placeable(&self, orig_radius: i64, layer: i64) -> Area {
        let radius = self.ceil_radius_raw(orig_radius);
        if let Some(a) = self.placeable.get(radius, layer) {
            return a;
        }
        if orig_radius == 0 {
            return self.collision(0, layer, true);
        }
        self.calculate_placeables(radius, layer);
        self.placeable.get(radius, layer).unwrap_or_default()
    }

    /// `getWallRestriction`.
    pub(crate) fn wall_restriction(&self, orig_radius: i64, layer: i64, min_xy_dist: bool) -> Area {
        if layer == 0 {
            return self.collision(orig_radius, layer, min_xy_dist);
        }
        let min = min_xy_dist && self.current_min_xy_dist_delta > 0;
        let radius = self.ceil_radius_raw(orig_radius);
        let cache = if min {
            &self.wall_restrictions_min
        } else {
            &self.wall_restrictions
        };
        if let Some(a) = cache.get(radius, layer) {
            return a;
        }
        self.calculate_wall_restrictions(&[(radius, layer)]);
        cache.get(radius, layer).unwrap_or_default()
    }

    /// `calculateCollision` for `radius` from the first layer not yet cached up to `max_layer`, and the
    /// placeable areas of radius 0 with it.
    fn calculate_collision(&self, radius: i64, max_layer: i64) {
        let begin = self.collision.max_layer(radius) + 1;
        let end = max_layer + 1;
        if begin >= end {
            return;
        }
        let n = self.outlines.len() as i64;
        let xy = self.current_min_xy_dist;
        let bottom = self.z_distance_bottom_layers;
        let top = self.z_distance_top_layers;
        let off_begin = (begin - bottom).max(0);
        let off_end = n.min(end + top);
        let offset_value = radius + xy;
        // 1) The outlines grown by the radius and the XY distance.
        let grown: Vec<Shapes> = if off_end > off_begin {
            crate::par::map_range(off_begin as u32..off_end as u32, |l| {
                let o = &self.outlines[l as usize];
                if offset_value == 0 {
                    geo::union(o)
                } else {
                    geo::offset_miter(o, offset_value as f64)
                }
            })
        } else {
            Vec::new()
        };
        let grown_at = |j: i64| -> Option<&Shapes> {
            if j >= off_begin && j < off_end {
                grown.get((j - off_begin) as usize)
            } else {
                None
            }
        };
        // 2) Summed over the Z gaps.
        let data: Vec<Shapes> = crate::par::map_range(begin as u32..end as u32, |l| {
            let l = i64::from(l);
            let mut parts: Vec<&Shapes> = Vec::new();
            for i in -bottom..=0 {
                if let Some(g) = grown_at(l + i) {
                    parts.push(g);
                }
            }
            let mut above: Vec<Shapes> = Vec::new();
            for i in 1..=top {
                let j = l + i;
                if j < n {
                    // The XY distance of a layer above shrinks with its height above this one, so an overhang
                    // thinner than the XY distance still gets tips.
                    let half = if top == 1 { 0.5 } else { 0.0 };
                    let range_x = (xy as f64 - ((i as f64 - half) * xy as f64 / top as f64)) as i64;
                    above.push(geo::offset_miter(
                        &self.outlines[j as usize],
                        (radius + range_x) as f64,
                    ));
                }
            }
            for a in &above {
                parts.push(a);
            }
            // Orca's mesh loop never sees its last mesh here, so blockers and simplification are skipped.
            crate::perimeters::union_all(&parts)
        });
        if self.support_rests_on_model && radius == 0 {
            let pb = (bottom + 1).max(begin);
            let placeable: Vec<Shapes> = (begin..end)
                .map(|l| {
                    if l < pb {
                        return Vec::new();
                    }
                    let below = l - bottom - 1;
                    let current = grown_at(l).cloned().unwrap_or_default();
                    let blocked = match self.anti_overhang.get(below as usize) {
                        Some(b) if !b.is_empty() => geo::union2(&current, b),
                        _ => current,
                    };
                    let Some(o) = self.outlines.get(below as usize) else {
                        return Vec::new();
                    };
                    geo::diff(&geo::offset(o, xy as f64, Join::Miter(3.0)), &blocked)
                })
                .collect();
            self.placeable.insert(radius, begin, placeable);
        }
        self.collision.insert(radius, begin, data);
    }

    /// `calculateCollisionHolefree`.
    fn calculate_collision_holefree(&self, keys: &[(i64, i64)]) {
        let max_layer = keys.iter().map(|k| k.1).max().unwrap_or(0);
        let inc = self.increase_until_radius;
        let base: Vec<Area> = (0..=max_layer).map(|l| self.collision(inc, l, false)).collect();
        let items: Vec<Vec<((i64, i64), Shapes)>> = crate::par::map_range(0..(max_layer + 1) as u32, |l| {
            let l = i64::from(l);
            let mut out = Vec::new();
            for &(radius, until) in keys {
                if l > until {
                    continue;
                }
                let increase_radius_ceil = self.ceil_radius(inc, false) - radius;
                // Orca offsets by 5 nm less than the difference, a twentieth of a plate unit here.
                let a = geo::offset(
                    &base[l as usize],
                    0.05 - increase_radius_ceil as f64,
                    Join::Round(self.min_resolution as f64),
                );
                out.push(((radius, l), geo::simplify(&a, self.min_resolution as f64)));
            }
            out
        });
        self.collision_holefree
            .insert_pairs(items.into_iter().flatten().collect());
    }

    /// `calculatePlaceables` for `radius` up to `max_layer`.
    fn calculate_placeables(&self, radius: i64, max_layer: i64) {
        let start = 1 + self.placeable.max_layer(radius);
        if start > max_layer {
            return;
        }
        let shrink = -((radius + self.current_min_xy_dist + self.current_min_xy_dist_delta) as f64);
        let data: Vec<Shapes> = crate::par::map_range(start as u32..(max_layer + 1) as u32, |l| {
            let l = i64::from(l);
            if l == 0 {
                // The machine border is empty in Orca, so nothing is placeable on the bed layer.
                return Vec::new();
            }
            geo::offset_miter(&self.placeable(0, l), shrink)
        });
        self.placeable.insert(radius, start, data);
    }

    /// `calculateAvoidance`: the avoidance of every key to the bed and to the model, of each type.
    fn calculate_avoidance(&self, keys: &[(i64, i64)], to_bed: bool, to_model: bool) {
        struct Task {
            t: AvoidanceType,
            radius: i64,
            max_layer: i64,
            to_model: bool,
            start: i64,
        }
        let mut tasks: Vec<Task> = Vec::new();
        for &(radius, max_layer) in keys {
            for model in [false, true] {
                for t in [AvoidanceType::Slow, AvoidanceType::FastSafe, AvoidanceType::Fast] {
                    let start = 1.max(1 + self.cache(t, model).max_layer(radius));
                    if start > max_layer {
                        continue;
                    }
                    let wanted = if model { to_model } else { to_bed };
                    if wanted
                        && (t != AvoidanceType::FastSafe
                            || radius < self.increase_until_radius + self.current_min_xy_dist_delta)
                    {
                        tasks.push(Task {
                            t,
                            radius,
                            max_layer,
                            to_model: model,
                            start,
                        });
                    }
                }
            }
        }
        // Placeable areas first, which the avoidances to the model subtract.
        for task in tasks.iter().filter(|t| t.to_model) {
            self.placeable(task.radius, task.max_layer);
        }
        crate::par::map(&tasks, |task| {
            let slow = task.t == AvoidanceType::Slow;
            let holefree = (slow || task.t == AvoidanceType::FastSafe)
                && task.radius < self.increase_until_radius + self.current_min_xy_dist_delta;
            let max_move = if slow { self.max_move_slow } else { self.max_move } as f64;
            // Steps no longer than 1.9 radii, so the shrunk avoidance united with the collision of the layer leaves
            // no gap a branch could tunnel through.
            let mut move_step = 1.9 * task.radius.max(self.current_min_xy_dist) as f64;
            if move_step < 1e-4 {
                return;
            }
            let mut move_steps = round_up_divide(max_move as i64, move_step as i64).max(1);
            let mut last_step = max_move - (move_steps - 1) as f64 * move_step;
            if last_step < geo::sc(0.05) as f64 && move_steps > 1 {
                move_steps -= 1;
                move_step = max_move / move_steps as f64;
                last_step = move_step;
            }
            let mut latest: Shapes =
                (*self.avoidance(task.radius, task.start - 1, task.t, task.to_model, true)).clone();
            let mut data: Vec<Shapes> = Vec::with_capacity((task.max_layer + 1 - task.start) as usize);
            for l in task.start..=task.max_layer {
                let coll = if holefree {
                    self.collision_holefree(task.radius, l)
                } else {
                    self.collision(task.radius, l, true)
                };
                for istep in 0..move_steps {
                    let d = if istep + 1 == move_steps {
                        -last_step
                    } else {
                        -move_step
                    };
                    latest = geo::union2(
                        &coll,
                        &geo::offset(&latest, d, Join::Round(self.min_resolution as f64)),
                    );
                }
                if task.to_model {
                    latest = geo::diff(&latest, &self.placeable(task.radius, l));
                }
                latest = geo::simplify(&latest, self.min_resolution as f64);
                data.push(latest.clone());
            }
            self.cache(task.t, task.to_model)
                .insert(task.radius, task.start, data);
        });
    }

    /// `calculateWallRestrictions`.
    fn calculate_wall_restrictions(&self, keys: &[(i64, i64)]) {
        crate::par::map(keys, |&(radius, max_layer)| {
            let bottom = 1.max(self.wall_restrictions.max_layer(radius));
            if bottom > max_layer {
                return;
            }
            let with_min = self.current_min_xy_dist_delta > 0;
            let res = self.min_resolution as f64;
            let both: Vec<(Shapes, Shapes)> =
                crate::par::map_range(bottom as u32..(max_layer + 1) as u32, |l| {
                    let l = i64::from(l);
                    let below = self.collision(radius, l - 1, true);
                    let regular = geo::simplify(&geo::inter(&self.collision(0, l, false), &below), res);
                    let min = if with_min {
                        geo::simplify(&geo::inter(&self.collision(0, l, true), &below), res)
                    } else {
                        Vec::new()
                    };
                    (regular, min)
                });
            let (regular, min): (Vec<Shapes>, Vec<Shapes>) = both.into_iter().unzip();
            self.wall_restrictions.insert(radius, bottom, regular);
            if with_min {
                self.wall_restrictions_min.insert(radius, bottom, min);
            }
        });
    }

    /// Drops everything but the collisions (`clear_all_but_object_collision`).
    pub(crate) fn clear_all_but_collision(&mut self) {
        self.collision_holefree = Cache::default();
        self.avoidance = Default::default();
        self.avoidance_to_model = Default::default();
        self.wall_restrictions = Cache::default();
        self.wall_restrictions_min = Cache::default();
        // Placeable areas keep radius 0 only.
        if let Ok(mut d) = self.placeable.data.write() {
            for l in d.iter_mut() {
                let first = l.iter().next().map(|(k, v)| (*k, v.clone()));
                l.clear();
                if let Some((k, v)) = first {
                    l.insert(k, v);
                }
            }
        }
    }
}
