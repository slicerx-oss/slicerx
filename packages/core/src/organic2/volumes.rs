// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What the model leaves free for a branch of a given radius on each layer:
//! collision, hole-free collision, placeable areas, avoidance (where a branch can no longer reach the bed
//! or a flat model top within the movement limits) and the wall limit. Every region is cached per
//! layer and per cached radius; the avoidance columns are built bottom-up, one radius per job.

use super::ops;
use super::params::{Params, u};
use crate::fm::Fm as _;
use crate::par::Init as _;
use crate::perimeters::Shapes;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// How fast a branch is allowed to move, and whether it must stay out of holes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Kind {
    /// The preferred angle, holes filled.
    Slow,
    /// The steepest angle, plain collision.
    Fast,
    /// The steepest angle, holes filled.
    FastSafe,
}

type Column = Arc<Vec<OnceLock<Arc<Shapes>>>>;
/// One avoidance table: a layer column worked out whole, bottom-up.
type AvoidTable = Arc<OnceLock<Vec<Arc<Shapes>>>>;

/// The model volumes of one support plan.
pub(crate) struct Volumes<'a> {
    p: &'a Params,
    /// Object outline per layer (raft layers empty).
    outlines: Vec<Shapes>,
    /// Support blockers per layer.
    blockers: Vec<Shapes>,
    /// Everything outside the bed (empty when the bed border is ignored).
    border: Shapes,
    /// The bed.
    bed: Shapes,
    /// Layers held (the highest layer that needs support work, plus one).
    count: usize,
    collision: Mutex<HashMap<i32, Column>>,
    hole_free: Mutex<HashMap<i32, Column>>,
    place0: Vec<OnceLock<Arc<Shapes>>>,
    placeable: Mutex<HashMap<i32, Column>>,
    avoid: Mutex<HashMap<(i32, Kind, bool), AvoidTable>>,
    wall: Mutex<HashMap<(i32, bool), Column>>,
}

fn column(n: usize) -> Column {
    Arc::new((0..n).map(|_| OnceLock::new()).collect())
}

fn cell(map: &Mutex<HashMap<i32, Column>>, key: i32, n: usize) -> Column {
    let mut m = match map.lock() {
        Ok(m) => m,
        Err(poisoned) => poisoned.into_inner(),
    };
    m.entry(key).or_insert_with(|| column(n)).clone()
}

impl<'a> Volumes<'a> {
    pub(crate) fn new(
        p: &'a Params,
        outlines: &[Shapes],
        blockers: Vec<Shapes>,
        bed_rect: [f64; 4],
        count: usize,
    ) -> Self {
        let bed = ops::rect(bed_rect);
        let border = if p.s.quirks.ignore_bed_edge {
            Vec::new()
        } else {
            // Outside the bed is a wall, out to more than any branch travels: the bed diagonal.
            let [x0, y0, x1, y1] = bed_rect;
            let m = (x1 - x0).m_hypot(y1 - y0).max(10.0);
            let frame = ops::rect([x0 - m, y0 - m, x1 + m, y1 + m]);
            ops::diff(&frame, &bed)
        };
        let outlines = outlines
            .iter()
            .map(|o| ops::simplify(o, p.s.resolution))
            .collect();
        let count = count.max(1);
        Self {
            p,
            outlines,
            blockers,
            border,
            bed,
            count,
            collision: Mutex::new(HashMap::new()),
            hole_free: Mutex::new(HashMap::new()),
            place0: (0..count).map(|_| OnceLock::new()).collect(),
            placeable: Mutex::new(HashMap::new()),
            avoid: Mutex::new(HashMap::new()),
            wall: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn bed(&self) -> &Shapes {
        &self.bed
    }

    pub(crate) fn outline(&self, layer: usize) -> &Shapes {
        static EMPTY: Shapes = Vec::new();
        self.outlines.get(layer).unwrap_or(&EMPTY)
    }

    fn blocker(&self, layer: usize) -> &Shapes {
        static EMPTY: Shapes = Vec::new();
        self.blockers.get(layer).unwrap_or(&EMPTY)
    }

    /// Cache key of a query radius in internal units.
    fn key(&self, r: f64, min_gap: bool) -> i32 {
        u(self.p.key_radius(r, min_gap))
    }

    fn mm(k: i32) -> f64 {
        f64::from(k) / crate::geom::SCALE
    }

    /// Collision C(r, L): where a branch center of radius `r` must not be on `layer`.
    pub(crate) fn collision(&self, r: f64, layer: usize, min_gap: bool) -> Arc<Shapes> {
        self.collision_k(self.key(r, min_gap), layer)
    }

    fn collision_k(&self, k: i32, layer: usize) -> Arc<Shapes> {
        let col = cell(&self.collision, k, self.count);
        let Some(slot) = col.get(layer) else {
            return Arc::new(self.collision_raw(k, layer));
        };
        slot.once(|| Arc::new(self.collision_raw(k, layer))).clone()
    }

    #[allow(clippy::cast_precision_loss, reason = "a small layer count")]
    fn collision_raw(&self, k: i32, layer: usize) -> Shapes {
        let p = self.p;
        let r = Self::mm(k);
        let mut parts: Vec<Shapes> = Vec::new();
        // Layers below (and this one) keep the full minimum gap.
        let below: Vec<&Shapes> = (0..=p.z_bot)
            .filter_map(|i| layer.checked_sub(i))
            .map(|l| self.outline(l))
            .filter(|o| !o.is_empty())
            .collect();
        if !below.is_empty() {
            parts.push(ops::grow(&ops::union_many(&below), r + p.gap_min));
        }
        // Layers above: the XY gap narrows linearly over the Z gap.
        let c = if p.z_top == 1 { 0.5 } else { 0.0 };
        for i in 1..=p.z_top {
            let o = self.outline(layer + i);
            if o.is_empty() {
                continue;
            }
            let frac = 1.0 - (i as f64 - c) / p.z_top as f64;
            parts.push(ops::grow(o, r + p.gap_min * frac));
        }
        let b = self.blocker(layer);
        if !b.is_empty() {
            parts.push(ops::grow(b, r));
        }
        if !self.border.is_empty() {
            parts.push(ops::grow(&self.border, r));
        }
        let refs: Vec<&Shapes> = parts.iter().collect();
        ops::simplify(&ops::union_many(&refs), p.s.resolution)
    }

    /// The key radius below which holes are filled.
    fn hole_limit(&self) -> i32 {
        u(self.p.r_until + self.p.delta_xy)
    }

    /// Hole-free collision H(r, L) by cache radius: the collision at the grow-until radius pulled back to
    /// radius `k`, so holes a grown branch could not leave are closed. Plain collision at larger
    /// radii.
    fn hole_free_k(&self, k: i32, layer: usize) -> Arc<Shapes> {
        if k >= self.hole_limit() {
            return self.collision_k(k, layer);
        }
        let col = cell(&self.hole_free, k, self.count);
        let make = || {
            let ku = self.hole_free_base();
            let c = self.collision_k(ku, layer);
            // Pulled back to radius k, less a 5 nm hair (under one internal unit, so it rounds away).
            let back = Self::mm(ku - k) - 5e-6;
            Arc::new(ops::simplify(&ops::grow_round(&c, -back), self.p.s.resolution))
        };
        match col.get(layer) {
            Some(slot) => slot.once(make).clone(),
            None => make(),
        }
    }

    /// The radius holes are filled at: the full-gap cache radius of the grow-until
    /// radius, that is the grid radius at or above `r_u` + `delta_xy`.
    fn hole_free_base(&self) -> i32 {
        self.key(self.p.r_until, false)
    }

    /// How far the top surfaces shrink for cache radius `k`. A full-gap key already
    /// holds the extra XY gap; the reference adds it again.
    fn placeable_shrink(&self, k: i32) -> f64 {
        let base = Self::mm(k) + self.p.gap_min;
        if self.p.s.quirks.placeable_double_gap {
            base + self.p.delta_xy
        } else {
            base
        }
    }

    /// The top surfaces a branch can stand on, before the radius is taken off.
    fn place_zero(&self, layer: usize) -> Arc<Shapes> {
        let make = || {
            let p = self.p;
            if layer == 0 {
                // The free bed; with the bed edge ignored the reference takes it from an empty border.
                if p.s.quirks.ignore_bed_edge {
                    return Arc::new(Vec::new());
                }
                let c0 = self.collision_k(0, 0);
                return Arc::new(ops::diff(&self.bed, &c0));
            }
            if layer <= p.z_bot {
                return Arc::new(Vec::new());
            }
            let low = layer - p.z_bot - 1;
            let top = self.outline(low);
            if top.is_empty() {
                return Arc::new(Vec::new());
            }
            let cover = ops::union(&ops::grow(self.outline(layer), p.gap_min), self.blocker(low));
            Arc::new(ops::diff(&ops::grow(top, p.gap_min), &cover))
        };
        match self.place0.get(layer) {
            Some(slot) => slot.once(make).clone(),
            None => make(),
        }
    }

    /// Placeable area P(r, L): where a branch of radius `r` can stand flat on the model or the bed.
    pub(crate) fn placeable(&self, r: f64, layer: usize) -> Arc<Shapes> {
        self.placeable_k(self.key(r, true), layer)
    }

    fn placeable_k(&self, k: i32, layer: usize) -> Arc<Shapes> {
        if !self.p.model_rest {
            return Arc::new(Vec::new());
        }
        let col = cell(&self.placeable, k, self.count);
        let make = || {
            let z = self.place_zero(layer);
            Arc::new(ops::grow(&z, -self.placeable_shrink(k)))
        };
        match col.get(layer) {
            Some(slot) => slot.once(make).clone(),
            None => make(),
        }
    }

    /// Avoidance V(r, L): where a branch of radius `r` on `layer` can no longer reach the bed (or with
    /// `to_model` a flat model top) moving at the speed of `kind`.
    pub(crate) fn avoidance(
        &self,
        r: f64,
        layer: usize,
        kind: Kind,
        to_model: bool,
        min_gap: bool,
    ) -> Arc<Shapes> {
        let k = self.key(r, min_gap);
        let col = self.avoid_column(k, kind, to_model);
        col.get()
            .and_then(|c| c.get(layer))
            .cloned()
            .unwrap_or_else(|| self.collision_k(k, layer))
    }

    /// The avoidance column of key radius `k`, built on first use.
    fn avoid_column(&self, k: i32, kind: Kind, to_model: bool) -> Arc<OnceLock<Vec<Arc<Shapes>>>> {
        // Safe fast avoidance is plain fast avoidance where there are no holes to fill.
        let kind = if kind == Kind::FastSafe && k >= self.hole_limit() {
            Kind::Fast
        } else {
            kind
        };
        let to_model = to_model && self.p.model_rest;
        let slot = {
            let mut m = match self.avoid.lock() {
                Ok(m) => m,
                Err(poisoned) => poisoned.into_inner(),
            };
            m.entry((k, kind, to_model))
                .or_insert_with(|| Arc::new(OnceLock::new()))
                .clone()
        };
        slot.once(|| self.avoid_raw(k, kind, to_model));
        slot
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "a step count of a few"
    )]
    fn avoid_raw(&self, k: i32, kind: Kind, to_model: bool) -> Vec<Arc<Shapes>> {
        let p = self.p;
        let speed = match kind {
            Kind::Slow => p.m_slow,
            Kind::Fast | Kind::FastSafe => p.m_fast,
        };
        let r = Self::mm(k);
        let bound = 1.9 * r.max(p.gap_min).max(0.01);
        let steps = (speed / bound).ceil().max(1.0) as usize;
        let step = speed / steps as f64;
        let mut out: Vec<Arc<Shapes>> = Vec::with_capacity(self.count);
        let mut prev: Arc<Shapes> = Arc::new(Vec::new());
        for layer in 0..self.count {
            let obstacle = if kind == Kind::Fast {
                self.collision_k(k, layer)
            } else {
                self.hole_free_k(k, layer)
            };
            let mut cur: Shapes = if layer == 0 {
                (*self.collision_k(k, 0)).clone()
            } else {
                let mut c = (*prev).clone();
                for _ in 0..steps {
                    c = ops::union(&ops::grow_round(&c, -step), &obstacle);
                }
                c
            };
            if to_model {
                cur = ops::diff(&cur, &self.placeable_k(k, layer));
            }
            let cur = Arc::new(ops::simplify(&cur, p.s.resolution));
            out.push(cur.clone());
            prev = cur;
        }
        out
    }

    /// The wall limit W(r, L): a printed wall a reach area must not cross in one step.
    pub(crate) fn wall(&self, r: f64, layer: usize, min_gap: bool) -> Arc<Shapes> {
        let k = self.key(r, true);
        let map_key = (k, min_gap);
        let col = {
            let mut m = match self.wall.lock() {
                Ok(m) => m,
                Err(poisoned) => poisoned.into_inner(),
            };
            m.entry(map_key).or_insert_with(|| column(self.count)).clone()
        };
        let make = || {
            if layer == 0 {
                return self.collision(0.0, 0, min_gap);
            }
            let here = self.collision(0.0, layer, min_gap);
            let below = self.collision_k(k, layer - 1);
            Arc::new(ops::inter(&here, &below))
        };
        match col.get(layer) {
            Some(slot) => slot.once(make).clone(),
            None => make(),
        }
    }

    /// Builds the avoidance columns of every radius in `radii` (each in both gap modes, every kind, to the
    /// bed and to the model), one radius per job.
    pub(crate) fn precompute(&self, radii: &[f64]) {
        let mut keys: Vec<i32> = radii
            .iter()
            .flat_map(|&r| [self.key(r, true), self.key(r, false)])
            .collect();
        keys.sort_unstable();
        keys.dedup();
        // Placeable areas come first: the to-model tables read them.
        if self.p.model_rest {
            crate::par::map_range(0..u32::try_from(self.count).unwrap_or(u32::MAX), |l| {
                self.place_zero(l as usize);
            });
        }
        let jobs: Vec<(i32, Kind, bool)> = keys
            .iter()
            .flat_map(|&k| {
                [Kind::Slow, Kind::Fast, Kind::FastSafe]
                    .into_iter()
                    .flat_map(move |kind| [(k, kind, false), (k, kind, true)])
            })
            .filter(|&(_, _, m)| !m || self.p.model_rest)
            .collect();
        crate::par::map(&jobs, |&(k, kind, m)| {
            let _ = self.avoid_column(k, kind, m);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::super::ops::P;
    use super::super::params::Settings;
    use super::*;

    fn params() -> Params {
        Params::new(Settings {
            support_width: 0.4,
            ..Settings::default()
        })
    }

    /// A 10 mm square column 20 layers tall at the plate middle.
    fn column_outlines(n: usize) -> Vec<Shapes> {
        (0..n).map(|_| ops::rect([95.0, 95.0, 105.0, 105.0])).collect()
    }

    #[test]
    fn collision_keeps_the_gap() {
        let p = params();
        let v = Volumes::new(&p, &column_outlines(20), Vec::new(), [0.0, 0.0, 200.0, 200.0], 20);
        let c = v.collision(0.0, 5, true);
        // The gap is the minimum XY gap around the column.
        assert!(ops::contains(&c, P::new(u(105.0 + p.gap_min - 0.01), u(100.0))));
        assert!(!ops::contains(&c, P::new(u(105.0 + p.gap_min + 0.02), u(100.0))));
        let c1 = v.collision(1.0, 5, true);
        assert!(ops::contains(&c1, P::new(u(105.0 + p.gap_min + 0.9), u(100.0))));
    }

    #[test]
    fn avoidance_of_an_overhang_grows_down() {
        // A slab floating at layers 10..20: under it a branch must move out at most m_fast per layer.
        let p = params();
        let mut outl: Vec<Shapes> = vec![Vec::new(); 20];
        for o in outl.iter_mut().skip(10) {
            *o = ops::rect([90.0, 90.0, 110.0, 110.0]);
        }
        let v = Volumes::new(&p, &outl, Vec::new(), [0.0, 0.0, 200.0, 200.0], 20);
        let a = v.avoidance(p.r_tip, 9, Kind::Fast, false, true);
        assert!(ops::contains(&a, P::new(u(100.0), u(100.0))));
        assert!(!ops::contains(&a, P::new(u(130.0), u(100.0))));
        // Nothing to avoid below: the slab's shadow shrinks away layer by layer.
        let a0 = v.avoidance(p.r_tip, 0, Kind::Fast, false, true);
        assert!(!ops::contains(&a0, P::new(u(100.0), u(100.0))));
    }

    #[test]
    fn bed_border_is_a_wall_unless_ignored() {
        let mut p = params();
        let v = Volumes::new(&p, &column_outlines(5), Vec::new(), [0.0, 0.0, 200.0, 200.0], 5);
        assert!(ops::contains(
            &v.collision(1.0, 2, true),
            P::new(u(199.5), u(100.0))
        ));
        p.s.quirks.ignore_bed_edge = true;
        let v = Volumes::new(&p, &column_outlines(5), Vec::new(), [0.0, 0.0, 200.0, 200.0], 5);
        assert!(!ops::contains(
            &v.collision(1.0, 2, true),
            P::new(u(199.5), u(100.0))
        ));
    }
}
