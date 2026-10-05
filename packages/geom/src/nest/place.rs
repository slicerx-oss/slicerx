// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! true shape placement on no fit polygons: each part goes to the best vertex of the region where
//! it touches nothing, at the best of its turns, and several orders and scores are tried
// shape, item and pass indices are built and checked in this module
#![allow(clippy::indexing_slicing)]

use super::poly::{self, Bbox, Pt, Region, Ring};
use crate::error::{Error, Result};
use crate::poly2d::Polygon;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::rc::Rc;

/// millidegrees in a degree; turns are kept as whole millidegrees so they compare exactly
const MDEG: i64 = 1000;
const FULL: i64 = 360 * MDEG;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestItem {
    pub id: String,
    pub polygons: Vec<Polygon>,
    /// how far the part's own first layer reaches past its outline (brim, raft, pads), mm
    #[serde(default)]
    pub grow: f64,
    /// how far everything printed for it reaches (skirt included), mm
    #[serde(default)]
    pub reach: f64,
    /// how many copies to place; fill the bed asks for more than fit
    #[serde(default = "one")]
    pub copies: u32,
    /// the exact convex hull when the polygons are simplified, for the fit against the bed edge
    #[serde(default)]
    pub hull: Vec<Pt>,
}

const fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestFixed {
    #[serde(default)]
    pub id: String,
    pub polygons: Vec<Polygon>,
    #[serde(default)]
    pub grow: f64,
    #[serde(default)]
    pub reach: f64,
    #[serde(default)]
    pub hull: Vec<Pt>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestZone {
    pub polygons: Vec<Polygon>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestBed {
    pub width_mm: f64,
    pub depth_mm: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the switches of the request, one each"
)]
pub struct NestOptions {
    /// space between parts and from the bed edge, mm
    pub gap_mm: f64,
    /// the least space between parts, whatever their brims, mm: printing by object keeps the extruder
    /// clearance between them, as Orca's arrange does. the bed edge keeps `gap_mm`
    pub apart_mm: f64,
    /// room kept beyond computed brims, mm
    pub safety_mm: f64,
    pub rotate: bool,
    /// turn step, degrees
    pub rotation_step_deg: f64,
    /// try every turn for every part instead of coarse turns refined near the best
    pub all_turns: bool,
    /// a skirt or draft shield goes round the whole print, so its hull must stay off the zones
    pub skirt: bool,
    /// move the finished layout to the middle of the bed when nothing is in the way
    pub center: bool,
    /// how far simplified outlines may grow past the true ones, mm
    pub tolerance_mm: f64,
    /// passes to try (orders and scores); 0 picks by size
    pub passes: u32,
    /// work allowed after the first pass, in vertices through boolean operations; 0 picks the default
    pub budget: f64,
}

impl Default for NestOptions {
    fn default() -> Self {
        Self {
            gap_mm: 6.0,
            apart_mm: 0.0,
            safety_mm: 1.0,
            rotate: true,
            rotation_step_deg: 10.0,
            all_turns: false,
            skirt: false,
            center: true,
            tolerance_mm: 0.1,
            passes: 0,
            budget: 0.0,
        }
    }
}

/// the default work budget, about a second of native time on a typical plate
pub const DEFAULT_BUDGET: f64 = 6.0e6;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestProblem {
    pub bed: NestBed,
    pub items: Vec<NestItem>,
    #[serde(default)]
    pub fixed: Vec<NestFixed>,
    #[serde(default)]
    pub zones: Vec<NestZone>,
    #[serde(default)]
    pub options: NestOptions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub id: String,
    pub copy: u32,
    /// turn about z, degrees, counterclockwise
    pub angle_deg: f64,
    /// a point p of the part goes to rotate(p) + offset
    pub offset: Pt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftOver {
    pub id: String,
    pub copies: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TooLarge {
    pub id: String,
    /// true when only its brim and skirt make it too large
    pub without_margin: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestStats {
    pub placed: u32,
    pub wanted: u32,
    pub passes: u32,
    pub best_pass: u32,
    pub work: f64,
    /// outline area of the placed parts over the bed area
    pub utilization: f64,
    pub area_mm2: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestResult {
    pub placements: Vec<Placement>,
    pub left_over: Vec<LeftOver>,
    pub too_large: Vec<TooLarge>,
    pub stats: NestStats,
}

/// one distinct outline with its margins
struct ShapeData {
    /// outline centered on its own bounds, turn 0
    raw: Region,
    /// convex pieces of the outline grown by half the part to part spacing
    pieces: Vec<Ring>,
    hull: Ring,
    area: f64,
    /// half spacing, and the spacing to the bed edge and the zones
    half: f64,
    edge: f64,
    reach: f64,
    turns: Vec<i64>,
    bounds: BTreeMap<i64, Bbox>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Order {
    Area,
    Long,
    /// the largest parts last, for more parts when not all fit
    Defer(usize),
    Shuffle(u64),
}

/// the turns a pass may use: all, or only half or quarter turns, which keep copies in a regular pattern
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Turns {
    All,
    Half,
    Quarter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Score {
    Rows,
    Columns,
    Envelope,
    Square,
}

/// where one part may not go at one turn, built up as parts are placed
#[derive(Default)]
struct Blocked {
    region: Region,
    folded: usize,
    zones: bool,
}

#[derive(Debug, Clone, Copy)]
struct Put {
    shape: usize,
    turn: i64,
    pos: Pt,
}

#[derive(Debug, Clone)]
struct Layout {
    /// per moving slot (item, copy): where it went
    puts: Vec<Option<Put>>,
    placed: u32,
    area: f64,
    envelope: Bbox,
    pass: u32,
}

impl Layout {
    /// more parts, then more area, then a smaller envelope, then the earlier pass
    fn better_than(&self, o: &Self) -> bool {
        if self.placed != o.placed {
            return self.placed > o.placed;
        }
        if (self.area - o.area).abs() > 1e-6 {
            return self.area > o.area;
        }
        let (a, b) = (self.envelope.area(), o.envelope.area());
        if (a - b).abs() > 1e-6 {
            return a < b;
        }
        self.pass < o.pass
    }
}

pub struct Nester {
    bed: NestBed,
    opts: NestOptions,
    shapes: Vec<ShapeData>,
    /// moving slots: (item index, copy, shape)
    slots: Vec<(usize, u32, usize)>,
    items: Vec<NestItem>,
    fixed: Vec<Put>,
    zones: Vec<Region>,
    zone_hulls: Vec<Ring>,
    /// where each item's outline center sat in the input
    centers: Vec<Pt>,
    nfp: BTreeMap<(usize, usize, i64), Rc<Region>>,
    zone_nfp: BTreeMap<(usize, usize, i64), Rc<Region>>,
    plan: Vec<(Order, Score, Turns)>,
    /// every grown outline may be closed by this radius without losing a place: no other part fits a narrower gap
    close: f64,
    next: usize,
    best: Option<Layout>,
    work: f64,
    budget: f64,
    too_large: Vec<TooLarge>,
}

fn region_of(polys: &[Polygon]) -> Region {
    let rings: Vec<Ring> = polys
        .iter()
        .flat_map(|p| {
            let mut p = p.clone();
            p.normalize_orientation();
            std::iter::once(p.outer).chain(p.holes)
        })
        .filter(|r| r.len() >= 3)
        .collect();
    poly::union_rings(&rings)
}

fn fnv(h: &mut u64, v: i64) {
    for b in v.to_le_bytes() {
        *h ^= u64::from(b);
        *h = h.wrapping_mul(0x0100_0000_01b3);
    }
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "rounded millimeters stay far inside i64"
)]
fn key_of(r: &Region, extra: &[f64]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325_u64;
    for s in r {
        fnv(&mut h, -1);
        for ring in s {
            fnv(&mut h, -2);
            for p in ring {
                fnv(&mut h, (p[0] * 1e4).round() as i64);
                fnv(&mut h, (p[1] * 1e4).round() as i64);
            }
        }
    }
    for x in extra {
        fnv(&mut h, (x * 1e4).round() as i64);
    }
    h
}

fn xorshift(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

#[allow(clippy::cast_possible_truncation, reason = "turn counts are small")]
fn turn_list(opts: &NestOptions) -> Vec<i64> {
    let deg = opts.rotation_step_deg;
    if !opts.rotate || deg.is_nan() || deg <= 0.0 || deg >= 360.0 {
        return vec![0];
    }
    let step = (deg.max(0.1) * MDEG as f64).round() as i64;
    (0..(FULL + step - 1) / step).map(|k| k * step).collect()
}

impl Nester {
    #[allow(clippy::too_many_lines, reason = "checks, then one loop per kind of input")]
    pub fn new(p: NestProblem) -> Result<Self> {
        let NestProblem {
            bed,
            items,
            fixed,
            zones,
            options: opts,
        } = p;
        if !(bed.width_mm > 0.0 && bed.depth_mm > 0.0 && bed.width_mm < 1e5 && bed.depth_mm < 1e5) {
            return Err(Error::invalid("bed", "width and depth must be positive"));
        }
        if !(opts.gap_mm >= 0.0
            && opts.gap_mm < 1000.0
            && opts.apart_mm >= 0.0
            && opts.apart_mm < 1000.0
            && opts.safety_mm >= 0.0
            && opts.tolerance_mm >= 0.0)
        {
            return Err(Error::invalid(
                "options",
                "gap, apart, safety and tolerance must be zero or more",
            ));
        }
        let finite = |polys: &[Polygon], hull: &[Pt], more: &[f64]| {
            polys
                .iter()
                .flat_map(Polygon::vertices)
                .chain(hull.iter().copied())
                .all(|p| p[0].is_finite() && p[1].is_finite())
                && more.iter().all(|x| x.is_finite())
        };
        if !(items
            .iter()
            .all(|i| finite(&i.polygons, &i.hull, &[i.grow, i.reach]))
            && fixed
                .iter()
                .all(|f| finite(&f.polygons, &f.hull, &[f.grow, f.reach]))
            && zones.iter().all(|z| finite(&z.polygons, &[], &[])))
        {
            return Err(Error::invalid(
                "polygons",
                "every point and margin must be a finite number",
            ));
        }
        let total: u64 = items.iter().map(|i| u64::from(i.copies)).sum();
        if total > 2000 {
            return Err(Error::invalid("items", "at most 2000 parts at once"));
        }
        let turns = turn_list(&opts);
        let mut me = Self {
            bed,
            shapes: Vec::new(),
            slots: Vec::new(),
            items: Vec::new(),
            fixed: Vec::new(),
            zones: Vec::new(),
            zone_hulls: Vec::new(),
            centers: vec![[0.0, 0.0]; items.len()],
            nfp: BTreeMap::new(),
            zone_nfp: BTreeMap::new(),
            plan: Vec::new(),
            close: 0.0,
            next: 0,
            best: None,
            work: 0.0,
            budget: if opts.budget > 0.0 {
                opts.budget
            } else {
                DEFAULT_BUDGET
            },
            too_large: Vec::new(),
            opts,
        };
        me.close = items
            .iter()
            .map(|i| me.half_of(i.grow))
            .chain(fixed.iter().map(|f| me.half_of(f.grow)))
            .fold(f64::INFINITY, f64::min);
        let mut by_key: BTreeMap<u64, usize> = BTreeMap::new();
        for (ii, it) in items.iter().enumerate() {
            let region = region_of(&it.polygons);
            if region.is_empty() || it.copies == 0 {
                continue;
            }
            let half = me.half_of(it.grow);
            let edge = me.edge_of(it.reach);
            let (s, center) = me.add_shape(
                &region,
                &it.hull,
                half,
                edge,
                it.reach.max(0.0),
                &turns,
                &mut by_key,
            );
            me.centers[ii] = center;
            if !me.fits_alone(s, edge) {
                let without = me.fits_alone(s, me.opts.gap_mm);
                me.too_large.push(TooLarge {
                    id: it.id.clone(),
                    without_margin: without,
                });
                continue;
            }
            for c in 0..it.copies {
                me.slots.push((ii, c, s));
            }
        }
        for f in &fixed {
            let region = region_of(&f.polygons);
            if region.is_empty() {
                continue;
            }
            let half = me.half_of(f.grow);
            let edge = me.edge_of(f.reach);
            let (s, pos) = me.add_shape(&region, &f.hull, half, edge, f.reach.max(0.0), &[0], &mut by_key);
            me.fixed.push(Put {
                shape: s,
                turn: 0,
                pos,
            });
        }
        me.zones = zones
            .iter()
            .map(|z| region_of(&z.polygons))
            .filter(|r| !r.is_empty())
            .collect();
        me.zone_hulls = me
            .zones
            .iter()
            .map(|z| {
                poly::hull(
                    &z.iter()
                        .flat_map(|s| s.first().cloned().unwrap_or_default())
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        me.items = items;
        me.plan = me.make_plan();
        Ok(me)
    }

    /// how far a part's outline grows: two parts keep the sum of theirs between them
    fn half_of(&self, grow: f64) -> f64 {
        let g = grow.max(0.0);
        (self.opts.gap_mm / 2.0)
            .max(self.opts.apart_mm / 2.0)
            .max(if g > 0.0 {
                g + self.opts.safety_mm / 2.0
            } else {
                0.0
            })
    }

    fn edge_of(&self, reach: f64) -> f64 {
        let r = reach.max(0.0);
        self.opts
            .gap_mm
            .max(if r > 0.0 { r + self.opts.safety_mm } else { 0.0 })
    }

    /// the shape for an outline (shared with an equal one) and where its center sat. the outline
    /// grows a little where it is simplified, but the fit against the bed edge uses the exact hull
    #[allow(clippy::too_many_arguments, reason = "one outline and its margins")]
    fn add_shape(
        &mut self,
        region: &Region,
        exact: &[Pt],
        half: f64,
        edge: f64,
        reach: f64,
        turns: &[i64],
        by_key: &mut BTreeMap<u64, usize>,
    ) -> (usize, Pt) {
        let tol = self.opts.tolerance_mm;
        let pts: Vec<Pt> = if exact.len() >= 3 {
            exact.to_vec()
        } else {
            region
                .iter()
                .flat_map(|s| s.first().cloned().unwrap_or_default())
                .collect()
        };
        let hull0 = poly::hull(&pts);
        let center = poly::ring_bbox(&hull0).center();
        let hull: Ring = hull0
            .iter()
            .map(|p| [p[0] - center[0], p[1] - center[1]])
            .collect();
        let raw = poly::translate(&poly::cover(region, tol), [-center[0], -center[1]]);
        let mut key_region = raw.clone();
        key_region.push(vec![hull.clone()]);
        let key = key_of(&key_region, &[half, edge, reach, turns.len() as f64]);
        if let Some(&s) = by_key.get(&key)
            && self.shapes[s].raw == raw
            && self.shapes[s].hull == hull
        {
            return (s, center);
        }
        let grown = if half > 0.0 {
            poly::cover(&poly::offset(&raw, half, tol.max(0.02)), tol)
        } else {
            raw.clone()
        };
        let mut pieces = poly::convex_pieces(&grown);
        let r = self.close.min(half);
        if r > 0.0 && r.is_finite() {
            // closing fills gaps no part can enter; keep it when it gives fewer pieces
            let closed = poly::cover(
                &poly::offset(&poly::offset(&raw, half + r, tol.max(0.02)), -r, tol.max(0.02)),
                tol,
            );
            let fewer = poly::convex_pieces(&closed);
            if fewer.len() < pieces.len() {
                pieces = fewer;
            }
        }
        self.work += poly::vertex_count(&grown) as f64;
        let area = poly::area(region);
        let mut shape = ShapeData {
            raw,
            pieces,
            hull,
            area,
            half,
            edge,
            reach,
            turns: Vec::new(),
            bounds: BTreeMap::new(),
        };
        shape.turns = Self::distinct_turns(&grown, turns, tol);
        for &t in &shape.turns {
            let rb = poly::ring_bbox(&poly::rotate_ring(
                &shape.hull,
                poly::turn(t as f64 / MDEG as f64),
            ));
            shape.bounds.insert(t, rb);
        }
        self.shapes.push(shape);
        let s = self.shapes.len() - 1;
        by_key.insert(key, s);
        (s, center)
    }

    /// turns that give a different outline: a ring needs one, a rectangle half of them
    fn distinct_turns(grown: &Region, turns: &[i64], tol: f64) -> Vec<i64> {
        let n = turns.len();
        if n <= 1 {
            return turns.to_vec();
        }
        let per: f64 = grown
            .iter()
            .flatten()
            .map(|r| crate::poly2d::ring_length(r))
            .sum();
        let same = |t: i64| {
            let r = poly::rotate(grown, poly::turn(t as f64 / MDEG as f64));
            let a = poly::difference(&r, grown);
            let b = poly::difference(grown, &r);
            poly::area(&a) + poly::area(&b) <= per * tol.max(0.01) * 0.5
        };
        let even = turns[1] * i64::try_from(n).unwrap_or(0) == FULL;
        for k in 1..=n / 2 {
            if (even && !n.is_multiple_of(k)) || (!even && k > 1) {
                continue;
            }
            if same(turns[k]) {
                return turns[..k].to_vec();
            }
        }
        turns.to_vec()
    }

    fn fits_alone(&self, s: usize, edge: f64) -> bool {
        let sh = &self.shapes[s];
        sh.turns.iter().any(|t| {
            let b = sh.bounds[t];
            b.w() + 2.0 * edge <= self.bed.width_mm + 1e-6 && b.h() + 2.0 * edge <= self.bed.depth_mm + 1e-6
        })
    }

    fn make_plan(&self) -> Vec<(Order, Score, Turns)> {
        use {Order as O, Score as S, Turns as T};
        let distinct: std::collections::BTreeSet<usize> = self.slots.iter().map(|s| s.2).collect();
        let turning = distinct.iter().any(|s| self.shapes[*s].turns.len() > 1);
        let scores = [Score::Rows, Score::Envelope, Score::Square, Score::Columns];
        let mixed = distinct.len() > 1;
        let long = mixed && self.order(Order::Long) != self.order(Order::Area);
        // the passes that most often win come first, so a small budget still tries them
        let ranked = [
            (O::Area, S::Rows, T::All),
            (O::Area, S::Envelope, T::All),
            (O::Defer(1), S::Rows, T::All),
            (O::Area, S::Rows, T::Quarter),
            (O::Long, S::Rows, T::All),
            (O::Area, S::Square, T::All),
            (O::Defer(1), S::Envelope, T::All),
            (O::Area, S::Envelope, T::Quarter),
            (O::Long, S::Envelope, T::All),
            (O::Area, S::Columns, T::All),
            (O::Area, S::Rows, T::Half),
            (O::Defer(2), S::Rows, T::All),
            (O::Area, S::Square, T::Quarter),
            (O::Area, S::Envelope, T::Half),
            (O::Long, S::Square, T::All),
            (O::Area, S::Columns, T::Quarter),
            (O::Defer(2), S::Envelope, T::All),
            (O::Long, S::Columns, T::All),
            (O::Area, S::Square, T::Half),
            (O::Area, S::Columns, T::Half),
        ];
        let mut plan: Vec<(Order, Score, Turns)> = ranked
            .into_iter()
            .filter(|(o, _, t)| {
                (*t == T::All || turning)
                    && match o {
                        O::Defer(_) => mixed,
                        O::Long => long,
                        _ => true,
                    }
            })
            .collect();
        if mixed {
            // more budget, more shuffled orders to try
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a small positive count"
            )]
            let extra = if self.opts.passes > 0 {
                self.opts.passes as usize
            } else {
                (24.0 * self.budget / DEFAULT_BUDGET).round().clamp(8.0, 400.0) as usize
            };
            for k in 0..extra {
                plan.push((Order::Shuffle(k as u64 + 1), scores[k % 2], Turns::All));
            }
        }
        if self.opts.passes > 0 {
            plan.truncate(self.opts.passes as usize);
        }
        plan
    }

    fn order(&self, o: Order) -> Vec<usize> {
        let mut idx: Vec<usize> = (0..self.slots.len()).collect();
        let size: Vec<f64> = self
            .slots
            .iter()
            .map(|slot| {
                let sh = &self.shapes[slot.2];
                match o {
                    Order::Long => sh.bounds.get(&0).map_or(0.0, |b| b.w().max(b.h())),
                    _ => crate::poly2d::signed_area(&sh.hull) + sh.area,
                }
            })
            .collect();
        idx.sort_by(|&a, &b| size[b].total_cmp(&size[a]).then(a.cmp(&b)));
        if let Order::Defer(k) = o {
            let n = idx.len();
            idx.rotate_left(k.min(n));
        }
        if let Order::Shuffle(seed) = o {
            let mut s = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
            let n = idx.len();
            if n > 1 {
                for _ in 0..n.div_ceil(3).max(1) {
                    let i = usize::try_from(xorshift(&mut s) % (n as u64 - 1)).unwrap_or(0);
                    idx.swap(i, i + 1);
                }
            }
        }
        idx
    }

    pub fn passes(&self) -> usize {
        self.plan.len()
    }

    pub fn done(&self) -> usize {
        self.next
    }

    pub fn finished(&self) -> bool {
        self.next >= self.plan.len() || (self.best.as_ref().is_some() && self.work > self.budget)
    }

    /// runs the next pass; false when nothing is left to try
    pub fn step(&mut self) -> bool {
        if self.finished() {
            return false;
        }
        let (order, score, turns) = self.plan[self.next];
        let pass = u32::try_from(self.next).unwrap_or(u32::MAX);
        self.next += 1;
        let layout = self.run_pass(order, score, turns, pass);
        if self.best.as_ref().is_none_or(|b| layout.better_than(b)) {
            self.best = Some(layout);
        }
        !self.finished()
    }

    fn nfp(&mut self, a: usize, b: usize, rel: i64) -> Rc<Region> {
        if let Some(r) = self.nfp.get(&(a, b, rel)) {
            return Rc::clone(r);
        }
        let sc = poly::turn(rel as f64 / MDEG as f64);
        let pb: Vec<Ring> = self.shapes[b]
            .pieces
            .iter()
            .map(|p| poly::rotate_ring(p, sc))
            .collect();
        let pa = &self.shapes[a].pieces;
        self.work += (pa.iter().map(Vec::len).sum::<usize>() * pb.len()
            + pb.iter().map(Vec::len).sum::<usize>() * pa.len()) as f64;
        let r = Rc::new(poly::no_fit(pa, &pb));
        self.nfp.insert((a, b, rel), Rc::clone(&r));
        r
    }

    fn zone_nfp(&mut self, z: usize, b: usize, turn: i64) -> Rc<Region> {
        if let Some(r) = self.zone_nfp.get(&(z, b, turn)) {
            return Rc::clone(r);
        }
        let sh = &self.shapes[b];
        let extra = (sh.edge - sh.half).max(0.0);
        let zone = &self.zones[z];
        let grown = if extra > 0.0 {
            poly::offset(zone, extra, 0.05)
        } else {
            zone.clone()
        };
        let zp = poly::convex_pieces(&grown);
        let sc = poly::turn(turn as f64 / MDEG as f64);
        let pb: Vec<Ring> = sh.pieces.iter().map(|p| poly::rotate_ring(p, sc)).collect();
        self.work += (zp.len() * pb.len() * 8) as f64;
        let r = Rc::new(poly::no_fit(&zp, &pb));
        self.zone_nfp.insert((z, b, turn), Rc::clone(&r));
        r
    }

    /// where part `b` turned by `turn` may not go because of `obstacle`
    fn blocked_by(&mut self, ob: &Put, b: usize, turn: i64) -> Region {
        let rel = (turn - ob.turn).rem_euclid(FULL);
        let base = self.nfp(ob.shape, b, rel);
        let turned = if ob.turn == 0 {
            (*base).clone()
        } else {
            poly::rotate(&base, poly::turn(ob.turn as f64 / MDEG as f64))
        };
        poly::translate(&turned, ob.pos)
    }

    /// the box the part's origin must stay in so its print stays on the bed
    fn inner_fit(&self, b: usize, turn: i64) -> Option<Bbox> {
        let sh = &self.shapes[b];
        let bb = sh.bounds.get(&turn)?;
        let e = sh.edge;
        let mut f = Bbox {
            min: [e - bb.min[0], e - bb.min[1]],
            max: [
                self.bed.width_mm - e - bb.max[0],
                self.bed.depth_mm - e - bb.max[1],
            ],
        };
        for k in 0..2 {
            if f.min[k] > f.max[k] + 1e-9 {
                return None;
            }
            if f.max[k] - f.min[k] < 1e-4 {
                let c = f64::midpoint(f.min[k], f.max[k]);
                f.min[k] = c - 5e-5;
                f.max[k] = c + 5e-5;
            }
        }
        Some(f)
    }

    fn score(&self, s: Score, part: &Bbox, pile: &Bbox) -> f64 {
        let (w, d) = (self.bed.width_mm, self.bed.depth_mm);
        let rows = part.max[1] + 0.1 * part.max[0];
        match s {
            Score::Rows => rows,
            Score::Columns => part.max[0] + 0.1 * part.max[1],
            Score::Envelope => pile.merge(part).area() / (w * d) * (w + d) + 1e-3 * rows,
            Score::Square => (part.max[0] / w).max(part.max[1] / d) * (w + d) + 0.1 * rows,
        }
    }

    fn turn_candidates(&self, b: usize, turns: Turns) -> (Vec<i64>, usize) {
        let t = &self.shapes[b].turns;
        match turns {
            Turns::Half => return (t.iter().copied().filter(|x| x % (180 * MDEG) == 0).collect(), 1),
            Turns::Quarter => return (t.iter().copied().filter(|x| x % (90 * MDEG) == 0).collect(), 1),
            Turns::All => {}
        }
        if self.opts.all_turns || t.len() <= 12 {
            return (t.clone(), 1);
        }
        let m = t.len().div_ceil(12);
        (t.iter().step_by(m).copied().collect(), m)
    }

    #[allow(clippy::too_many_arguments, reason = "the pass state travels together")]
    fn best_at(
        &mut self,
        b: usize,
        turn: i64,
        score: Score,
        pile: &Bbox,
        obstacles: &[Put],
        unions: &mut BTreeMap<(usize, i64), Blocked>,
        hull_pts: &[Pt],
    ) -> Option<(f64, Pt)> {
        let fit = self.inner_fit(b, turn)?;
        let mut bl = unions.remove(&(b, turn)).unwrap_or_default();
        if !bl.zones || bl.folded < obstacles.len() {
            let mut rings: Vec<Ring> = bl.region.iter().flatten().cloned().collect();
            if !bl.zones {
                for z in 0..self.zones.len() {
                    rings.extend(self.zone_nfp(z, b, turn).iter().flatten().cloned());
                }
                bl.zones = true;
            }
            for ob in &obstacles[bl.folded..] {
                rings.extend(self.blocked_by(ob, b, turn).into_iter().flatten());
            }
            bl.folded = obstacles.len();
            self.work += rings.iter().map(Vec::len).sum::<usize>() as f64;
            bl.region = poly::union_rings(&rings);
        }
        let rect: Region = vec![vec![poly2_rect(fit)]];
        let u = &bl.region;
        let free = if u.is_empty() || !poly::bbox(u).overlaps(&fit) {
            rect
        } else {
            poly::difference(&rect, u)
        };
        self.work += (poly::vertex_count(u) + 4) as f64;
        unions.insert((b, turn), bl);
        let bb = self.shapes[b].bounds[&turn];
        let mut cands: Vec<(f64, Pt)> = free
            .iter()
            .flatten()
            .flatten()
            .map(|p| (self.score(score, &bb.shifted(*p), pile), *p))
            .collect();
        cands.sort_by(|a, c| {
            a.0.total_cmp(&c.0)
                .then(a.1[1].total_cmp(&c.1[1]))
                .then(a.1[0].total_cmp(&c.1[0]))
        });
        if self.opts.skirt && !self.zones.is_empty() {
            return cands
                .into_iter()
                .find(|(_, p)| self.hull_clear(b, turn, *p, hull_pts));
        }
        cands.into_iter().next()
    }

    /// with a skirt round the whole print, its hull must stay off the zones
    fn hull_clear(&self, b: usize, turn: i64, pos: Pt, hull_pts: &[Pt]) -> bool {
        let mut pts = hull_pts.to_vec();
        pts.extend(self.reach_points(b, turn, pos));
        let h = poly::hull(&pts);
        !self.zone_hulls.iter().any(|z| convex_overlap(&h, z))
    }

    /// the hull of a part pushed out by its reach in eight directions
    fn reach_points(&self, b: usize, turn: i64, pos: Pt) -> Vec<Pt> {
        let sh = &self.shapes[b];
        let sc = poly::turn(turn as f64 / MDEG as f64);
        // an octagon round each hull point holds the circle of the reach
        let r = sh.reach / 0.923_879_532_511_286_7;
        let h = std::f64::consts::FRAC_1_SQRT_2;
        let dirs = [
            [1.0, 0.0],
            [h, h],
            [0.0, 1.0],
            [-h, h],
            [-1.0, 0.0],
            [-h, -h],
            [0.0, -1.0],
            [h, -h],
        ];
        let mut out = Vec::with_capacity(sh.hull.len() * 8);
        for p in &sh.hull {
            let q = poly::rotate_pt(*p, sc);
            for d in &dirs {
                out.push([q[0] + pos[0] + r * d[0], q[1] + pos[1] + r * d[1]]);
            }
        }
        out
    }

    fn run_pass(&mut self, order: Order, score: Score, turns: Turns, pass: u32) -> Layout {
        let idx = self.order(order);
        let mut puts: Vec<Option<Put>> = vec![None; self.slots.len()];
        let mut obstacles: Vec<Put> = self.fixed.clone();
        let mut unions: BTreeMap<(usize, i64), Blocked> = BTreeMap::new();
        let mut full: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
        let mut pile = Bbox::EMPTY;
        let mut hull_pts: Vec<Pt> = Vec::new();
        if self.opts.skirt && !self.zones.is_empty() {
            for f in &self.fixed {
                hull_pts.extend(self.reach_points(f.shape, 0, f.pos));
            }
            hull_pts = poly::hull(&hull_pts);
        }
        let (mut placed, mut area) = (0u32, 0.0);
        for &i in &idx {
            let b = self.slots[i].2;
            if full.contains(&b) {
                continue;
            }
            let (coarse, m) = self.turn_candidates(b, turns);
            let mut best: Option<(f64, i64, Pt)> = None;
            let mut scored: Vec<(f64, i64)> = Vec::new();
            for &t in &coarse {
                if let Some((s, p)) = self.best_at(b, t, score, &pile, &obstacles, &mut unions, &hull_pts) {
                    scored.push((s, t));
                    if best.is_none_or(|(bs, bt, _)| s < bs - 1e-9 || (s <= bs + 1e-9 && t < bt)) {
                        best = Some((s, t, p));
                    }
                }
            }
            if m > 1 && !scored.is_empty() {
                // refine round the two best coarse turns
                scored.sort_by(|a, c| a.0.total_cmp(&c.0).then(a.1.cmp(&c.1)));
                let all = self.shapes[b].turns.clone();
                let mut extra: Vec<i64> = Vec::new();
                for &(_, t) in scored.iter().take(2) {
                    let Some(k) = all.iter().position(|x| *x == t) else {
                        continue;
                    };
                    for d in 1..m {
                        extra.push(all[(k + d) % all.len()]);
                        extra.push(all[(k + all.len() - d) % all.len()]);
                    }
                }
                extra.sort_unstable();
                extra.dedup();
                for t in extra {
                    if coarse.contains(&t) {
                        continue;
                    }
                    if let Some((s, p)) = self.best_at(b, t, score, &pile, &obstacles, &mut unions, &hull_pts)
                        && best.is_none_or(|(bs, bt, _)| s < bs - 1e-9 || (s <= bs + 1e-9 && t < bt))
                    {
                        best = Some((s, t, p));
                    }
                }
            }
            let Some((_, t, p)) = best else {
                full.insert(b);
                continue;
            };
            let put = Put {
                shape: b,
                turn: t,
                pos: p,
            };
            puts[i] = Some(put);
            obstacles.push(put);
            pile = pile.merge(&self.shapes[b].bounds[&t].shifted(p));
            placed += 1;
            area += self.shapes[b].area;
            if self.opts.skirt && !self.zones.is_empty() {
                hull_pts.extend(self.reach_points(b, t, p));
                hull_pts = poly::hull(&hull_pts);
            }
        }
        Layout {
            puts,
            placed,
            area,
            envelope: pile,
            pass,
        }
    }

    /// the shift that centers the layout on the bed, when nothing gets in the way
    fn centered(&mut self, layout: &Layout) -> Pt {
        if !self.opts.center || layout.placed == 0 {
            return [0.0, 0.0];
        }
        let (mut lo, mut hi) = ([f64::NEG_INFINITY; 2], [f64::INFINITY; 2]);
        let mut env = Bbox::EMPTY;
        for p in layout.puts.iter().flatten() {
            let sh = &self.shapes[p.shape];
            let b = sh.bounds[&p.turn].shifted(p.pos);
            env = env.merge(&b);
            lo = [lo[0].max(sh.edge - b.min[0]), lo[1].max(sh.edge - b.min[1])];
            hi = [
                hi[0].min(self.bed.width_mm - sh.edge - b.max[0]),
                hi[1].min(self.bed.depth_mm - sh.edge - b.max[1]),
            ];
        }
        let want = [
            self.bed.width_mm / 2.0 - env.center()[0],
            self.bed.depth_mm / 2.0 - env.center()[1],
        ];
        let shift = [
            want[0].clamp(lo[0].min(0.0), hi[0].max(0.0)),
            want[1].clamp(lo[1].min(0.0), hi[1].max(0.0)),
        ];
        if shift[0].abs() < 1e-9 && shift[1].abs() < 1e-9 {
            return [0.0, 0.0];
        }
        if self.fixed.is_empty() && self.zones.is_empty() {
            return shift;
        }
        // something stays put: every part must stay clear of it after the shift
        let fixed = self.fixed.clone();
        for p in layout.puts.iter().flatten() {
            let at = [p.pos[0] + shift[0], p.pos[1] + shift[1]];
            for f in &fixed {
                if poly::strictly_inside(&self.blocked_by(f, p.shape, p.turn), at, 1e-6) {
                    return [0.0, 0.0];
                }
            }
            for z in 0..self.zones.len() {
                if poly::strictly_inside(&self.zone_nfp(z, p.shape, p.turn), at, 1e-6) {
                    return [0.0, 0.0];
                }
            }
        }
        if self.opts.skirt && !self.zones.is_empty() {
            let mut pts: Vec<Pt> = Vec::new();
            for f in &fixed {
                pts.extend(self.reach_points(f.shape, 0, f.pos));
            }
            for p in layout.puts.iter().flatten() {
                pts.extend(self.reach_points(p.shape, p.turn, [p.pos[0] + shift[0], p.pos[1] + shift[1]]));
            }
            let h = poly::hull(&pts);
            if self.zone_hulls.iter().any(|z| convex_overlap(&h, z)) {
                return [0.0, 0.0];
            }
        }
        shift
    }

    pub fn result(&mut self) -> NestResult {
        let Some(best) = self.best.clone() else {
            let mut left: BTreeMap<String, u32> = BTreeMap::new();
            for (ii, _, _) in &self.slots {
                *left.entry(self.items[*ii].id.clone()).or_default() += 1;
            }
            return NestResult {
                placements: Vec::new(),
                left_over: left
                    .into_iter()
                    .map(|(id, copies)| LeftOver { id, copies })
                    .collect(),
                too_large: self.too_large.clone(),
                stats: NestStats {
                    wanted: u32::try_from(self.slots.len()).unwrap_or(u32::MAX),
                    work: self.work,
                    ..NestStats::default()
                },
            };
        };
        let shift = self.centered(&best);
        let mut placements = Vec::new();
        let mut left: Vec<LeftOver> = Vec::new();
        for (k, (ii, copy, _)) in self.slots.iter().enumerate() {
            let id = &self.items[*ii].id;
            match best.puts[k] {
                Some(p) => {
                    let deg = p.turn as f64 / MDEG as f64;
                    let c = poly::rotate_pt(self.centers[*ii], poly::turn(deg));
                    placements.push(Placement {
                        id: id.clone(),
                        copy: *copy,
                        angle_deg: deg,
                        offset: [p.pos[0] + shift[0] - c[0], p.pos[1] + shift[1] - c[1]],
                    });
                }
                None => match left.last_mut() {
                    Some(l) if &l.id == id => l.copies += 1,
                    _ => left.push(LeftOver {
                        id: id.clone(),
                        copies: 1,
                    }),
                },
            }
        }
        NestResult {
            placements,
            left_over: left,
            too_large: self.too_large.clone(),
            stats: NestStats {
                placed: best.placed,
                wanted: u32::try_from(self.slots.len()).unwrap_or(u32::MAX),
                passes: u32::try_from(self.next).unwrap_or(u32::MAX),
                best_pass: best.pass,
                work: self.work,
                utilization: best.area / (self.bed.width_mm * self.bed.depth_mm),
                area_mm2: best.area,
            },
        }
    }
}

fn poly2_rect(b: Bbox) -> Ring {
    vec![b.min, [b.max[0], b.min[1]], b.max, [b.min[0], b.max[1]]]
}

/// separating axis test for two convex counterclockwise rings
fn convex_overlap(a: &[Pt], b: &[Pt]) -> bool {
    if a.len() < 3 || b.len() < 3 {
        return false;
    }
    let apart = |p: &[Pt], q: &[Pt]| {
        (0..p.len()).any(|i| {
            let (u, v) = (p[i], p[(i + 1) % p.len()]);
            q.iter().all(|x| poly::cross(u, v, *x) <= 1e-9)
        })
    };
    !(apart(a, b) || apart(b, a))
}

/// places everything in one go
pub fn nest(p: NestProblem) -> Result<NestResult> {
    let mut n = Nester::new(p)?;
    while n.step() {}
    Ok(n.result())
}
