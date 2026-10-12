// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Tip generation (spec section 4): where under each overhang a branch starts, and which overhang parts
//! become roofs instead.

use super::node::{Class, Node, Recovery};
use super::ops::{self, P};
use super::params::{MIN_ROOF_AREA, Params};
use super::sample::{self, Lines};
use super::volumes::{Kind, Volumes};
use crate::perimeters::Shapes;
use std::collections::HashSet;

/// What tip generation makes: tips by layer, and roof areas by layer and depth below the overhang.
#[derive(Debug, Default)]
pub(crate) struct Tips {
    pub(crate) tips: Vec<(usize, Node)>,
    pub(crate) roofs: Vec<(usize, u32, Shapes)>,
}

struct Ctx<'a, 'b> {
    p: &'a Params,
    v: &'a Volumes<'b>,
    center: [f64; 2],
    min_gap: bool,
    connect: f64,
    force_roof: bool,
}

impl Ctx<'_, '_> {
    /// Where a tip must not go on `layer` (spec 4.2).
    fn forbidden(&self, layer: usize) -> Shapes {
        let r = self.p.r_tip;
        let base = if self.p.model_rest {
            self.v.collision(r, layer, self.min_gap)
        } else {
            self.v.avoidance(r, layer, Kind::Fast, false, self.min_gap)
        };
        ops::grow(&base, 0.005)
    }

    fn outside(region: &Shapes, pt: P) -> bool {
        !ops::contains(region, pt)
    }

    /// The class of a point (spec 4.6); None when no branch can start there.
    fn classify(&self, pt: P, layer: usize) -> Option<Class> {
        let (r, g, v) = (self.p.r_tip, self.min_gap, self.v);
        if Self::outside(&v.avoidance(r, layer, Kind::FastSafe, false, g), pt) {
            return Some(Class::BedSafe);
        }
        if Self::outside(&v.avoidance(r, layer, Kind::Fast, false, g), pt) {
            return Some(Class::Bed);
        }
        if !self.p.model_rest {
            return None;
        }
        if Self::outside(&v.avoidance(r, layer, Kind::FastSafe, true, g), pt) {
            return Some(Class::ModelFlatSafe);
        }
        if Self::outside(&v.avoidance(r, layer, Kind::Fast, true, g), pt) {
            return Some(Class::ModelFlat);
        }
        if Self::outside(&v.collision(r, layer, g), pt) {
            return Some(Class::Model);
        }
        None
    }

    /// A point of `class` can still go one layer further down from `layer` (spec 4.7).
    fn valid_below(&self, pt: P, class: Class, layer: usize) -> bool {
        let Some(below) = layer.checked_sub(1) else {
            return false;
        };
        let (r, g, v) = (self.p.r_tip, self.min_gap, self.v);
        let bed_kind = if class == Class::BedSafe {
            Kind::FastSafe
        } else {
            Kind::Fast
        };
        if Self::outside(&v.avoidance(r, below, bed_kind, false, g), pt) {
            return true;
        }
        if !self.p.model_rest || class.to_bed() {
            return false;
        }
        match class {
            Class::ModelFlatSafe => Self::outside(&v.avoidance(r, below, Kind::FastSafe, true, g), pt),
            Class::ModelFlat => Self::outside(&v.avoidance(r, below, Kind::Fast, true, g), pt),
            Class::Model => Self::outside(&v.collision(r, below, g), pt),
            Class::BedSafe | Class::Bed => false,
        }
    }

    /// Classifies the points of each line; points no branch can start from split their line.
    fn classify_lines(&self, lines: &[Vec<P>], layer: usize) -> Vec<Vec<(P, Class)>> {
        let mut out = Vec::new();
        for l in lines {
            let mut cur: Vec<(P, Class)> = Vec::new();
            for &pt in l {
                if let Some(c) = self.classify(pt, layer) {
                    cur.push((pt, c));
                } else if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            if !cur.is_empty() {
                out.push(cur);
            }
        }
        out
    }
}

/// Tip half-line step: how far along the tip circle's edge the circle falls half a line inside.
fn half_step(p: &Params) -> f64 {
    let (r, w) = (p.r_tip, p.w);
    if r < w {
        r / 2.0
    } else {
        (r * r - (r - w / 2.0) * (r - w / 2.0)).max(0.0).sqrt()
    }
}

/// The overhang parts a tip can reach, pulled away from walls they hug (spec 4.3).
fn regular_area(c: &Ctx<'_, '_>, overhang: &Shapes, forbidden: &Shapes, layer: usize) -> Shapes {
    let p = c.p;
    let mut reg = ops::diff(overhang, forbidden);
    let mut remaining = ops::inter(&ops::diff(overhang, &ops::grow(&reg, p.w / 2.0)), forbidden);
    let extra = (p.r_tip - p.w / 2.0).max(0.0) + if c.min_gap { p.w / 2.0 } else { 0.0 };
    let s_h = half_step(p);
    let wall = c.v.collision(0.0, layer, true);
    let step = p.gap_min + p.w;
    let mut a = 0.0;
    while !remaining.is_empty() && a + p.w / 8.0 < extra {
        let st = (if a + 2.0 * p.w > p.r_tip { p.w / 8.0 } else { s_h }).min(extra - a);
        if st <= 0.0 {
            break;
        }
        a += st;
        remaining = ops::diff(&remaining, &ops::safe_grow(&reg, 1.5 * a, &wall, step, 0.0));
        let pulled = ops::diff(&ops::safe_grow(&remaining, a, &wall, step, 0.0), forbidden);
        reg = ops::union(&reg, &pulled);
    }
    reg
}

/// Tips and roofs for the overhang held up from `layer`.
fn layer_tips(c: &Ctx<'_, '_>, overhang: &Shapes, layer: usize) -> Tips {
    let mut out = Tips::default();
    if overhang.is_empty() {
        return out;
    }
    let forbidden = c.forbidden(layer);
    let mut reg = regular_area(c, overhang, &forbidden, layer);
    let n_roof = c.p.s.top_layers as usize;
    if n_roof > 0 {
        let roof = ops::diff(overhang, &forbidden);
        reg = ops::diff(&reg, &roof);
        for part in ops::islands(&roof) {
            sample_part(c, &part, true, layer, &mut out);
        }
    }
    for part in ops::islands(&reg) {
        sample_part(c, &part, false, layer, &mut out);
    }
    out
}

/// Samples one overhang part into tips, walking roof layers down first for a large roof (spec 4.5).
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "point counts"
)]
fn sample_part(c: &Ctx<'_, '_>, part: &Shapes, large: bool, layer: usize, out: &mut Tips) {
    let p = c.p;
    let n_roof = p.s.top_layers as usize;
    let mut cur = part.clone();
    let mut roof_parts: Vec<Shapes> = Vec::new();
    let mut from_roof: Option<Vec<Vec<(P, Class)>>> = None;
    let mut reached_bed = false;
    if large {
        while roof_parts.len() < n_roof {
            let k = roof_parts.len();
            let here = layer - k;
            if here <= 1 {
                reached_bed = true;
                break;
            }
            let next = ops::diff(&cur, &c.forbidden(here - 1));
            if ops::area(&next) < MIN_ROOF_AREA {
                if let Some(last) = roof_parts.last() {
                    // Tips along the roof lines of the last full roof layer.
                    let at = layer - roof_parts.len();
                    let lines = sample::lines(p, last, Lines::Roof { layer: at + 1 }, c.center);
                    let pts: Vec<Vec<P>> = lines
                        .iter()
                        .map(|l| sample::resample(l, false, c.connect, 1))
                        .collect();
                    let classed = c.classify_lines(&pts, at);
                    let kept: Vec<Vec<(P, Class)>> = classed
                        .into_iter()
                        .map(|l| l.into_iter().filter(|&(q, k)| c.valid_below(q, k, at)).collect())
                        .filter(|l: &Vec<(P, Class)>| !l.is_empty())
                        .collect();
                    from_roof = Some(kept);
                }
                break;
            }
            roof_parts.push(cur);
            cur = next;
        }
        // Roof parts too narrow for lines end the roof there.
        let no_lines =
            |k: usize, r: &Shapes| sample::lines(p, r, Lines::Roof { layer: layer - k }, c.center).is_empty();
        let n = roof_parts.len();
        if n > 0
            && roof_parts.last().is_some_and(|r| no_lines(n - 1, r))
            && let Some(cut) = roof_parts.iter().enumerate().position(|(k, r)| no_lines(k, r))
        {
            roof_parts.truncate(cut);
        }
    }
    let placed = roof_parts.len();
    for (k, r) in roof_parts.iter().enumerate() {
        out.roofs
            .push((layer - k, u32::try_from(k).unwrap_or(u32::MAX), r.clone()));
    }
    let at = layer - placed;
    if reached_bed {
        // A roof down to the bed: what is left becomes roof on every layer below, without tips.
        for l in (0..=at).rev() {
            let depth = u32::try_from(layer - l).unwrap_or(u32::MAX);
            out.roofs.push((l, depth, cur.clone()));
        }
        return;
    }
    let lines: Vec<Vec<(P, Class)>> = match from_roof {
        Some(l) if !l.is_empty() => l,
        _ => {
            let kind = if placed > 0 {
                Lines::Roof { layer: at }
            } else {
                Lines::Base {
                    distance: p.s.branch_distance,
                }
            };
            let mut ls = sample::lines(p, &cur, kind, c.center);
            let spacing = if continuous_tips(large, placed) {
                p.r_tip / 2.0
            } else {
                c.connect
            };
            let need = ((ops::perimeter(&cur) / c.connect) as usize).clamp(1, 3);
            let mut pts: Vec<Vec<P>> = ls
                .iter()
                .map(|l| sample::resample(l, false, spacing, 1))
                .collect();
            if pts.iter().map(Vec::len).sum::<usize>() <= need {
                // Too few: walk the outline instead (or the outline pulled in, for a part that is all
                // edge).
                let shrunk = ops::grow(&cur, -p.w / 2.2);
                let band = ops::grow(&ops::diff(&cur, &shrunk), p.w.max(c.connect));
                let ring_src = if !shrunk.is_empty() && ops::tiny(&band, 0.001) {
                    shrunk
                } else {
                    cur.clone()
                };
                ls = ring_src.iter().flatten().cloned().collect();
                pts = ls
                    .iter()
                    .map(|l| sample::resample(l, true, spacing, need))
                    .collect();
            }
            c.classify_lines(&pts, at)
        }
    };
    insert(c, &lines, at, placed, out);
}

/// Tips close together in a line, half the tip radius apart, so they form the roof themselves (spec 4.5
/// and E5): a large roof part where the roof walk placed no roof layer.
fn continuous_tips(large: bool, placed: usize) -> bool {
    large && placed == 0
}

/// Inserts tips along classified lines at `layer`, keeping some as roof circles while the roof below
/// the overhang still has layers to go (spec 4.10).
fn insert(c: &Ctx<'_, '_>, lines: &[Vec<(P, Class)>], layer: usize, roof_above: usize, out: &mut Tips) {
    let p = c.p;
    let n_roof = p.s.top_layers as usize;
    let roof_tips = if c.force_roof {
        n_roof.saturating_sub(roof_above)
    } else {
        0
    };
    let stay = if n_roof > 0 {
        n_roof.saturating_sub(roof_above)
    } else {
        0
    };
    let as_u32 = |v: usize| u32::try_from(v).unwrap_or(u32::MAX);
    let mut pending: Vec<Vec<(P, Class)>> = lines.to_vec();
    let mut k = 0usize;
    while k < roof_tips && layer > k {
        let at = layer - k;
        let mut next: Vec<Vec<(P, Class)>> = Vec::new();
        for l in &pending {
            let mut keep = Vec::new();
            for &(q, cls) in l {
                if c.valid_below(q, cls, at) {
                    keep.push((q, cls));
                } else {
                    out.tips
                        .push((at, make_tip(c, q, at, cls, roof_tips - k, k + roof_above)));
                }
            }
            // The points that go on down are drawn as small roof circles on this layer.
            for &(q, _) in &keep {
                out.roofs.push((
                    at,
                    as_u32(k + roof_above),
                    ops::circle(q, p.r_tip, ops::circle_sides(p.r_tip)),
                ));
            }
            if !keep.is_empty() {
                next.push(keep);
            }
        }
        pending = next;
        k += 1;
    }
    let Some(at) = layer.checked_sub(k) else {
        return;
    };
    for l in &pending {
        let skip_oval = p.r_tip < 3.0 * p.w && roof_tips == 0 && l.len() > 5;
        for &(q, cls) in l {
            let mut n = make_tip(c, q, at, cls, stay.saturating_sub(k), k + roof_above);
            n.skip_oval = skip_oval;
            out.tips.push((at, n));
        }
    }
}

fn make_tip(c: &Ctx<'_, '_>, q: P, layer: usize, class: Class, stay: usize, depth: usize) -> Node {
    let mut n = Node::tip(q, layer, class, c.min_gap);
    let stay = u32::try_from(stay).unwrap_or(u32::MAX);
    let depth = u32::try_from(depth).unwrap_or(u32::MAX);
    n.stay_until = stay;
    n.supports_roof = depth > 0;
    n.recovery = c.force_roof.then_some(Recovery { count: stay, depth });
    n
}

/// Tips for every layer from the overhangs (indexed by tree layer), up to `top`.
pub(crate) fn generate(
    p: &Params,
    v: &Volumes<'_>,
    overhangs: &[Shapes],
    top: usize,
    center: [f64; 2],
) -> Tips {
    let r_t = p.r_tip;
    let force_roof =
        p.s.top_layers > 0 && (p.s.zero_top_gap || std::f64::consts::PI * r_t * r_t > MIN_ROOF_AREA);
    let c = Ctx {
        p,
        v,
        center,
        min_gap: p.min_gap_active(),
        connect: p.connect_length(),
        force_roof,
    };
    let lift = p.z_top + 1;
    let first = p.s.raft_layers.saturating_sub(lift).max(1);
    let layers: Vec<usize> = (first..=top).collect();
    let per: Vec<Tips> = crate::par::map(&layers, |&l| {
        let empty = Vec::new();
        let o = overhangs.get(l + lift).unwrap_or(&empty);
        layer_tips(&c, o, l)
    });
    // De-duplicate tips per layer by position on a grid a tenth of the tip radius wide.
    let cell = ((r_t + 1e-4) / 10.0 * crate::geom::SCALE).max(1.0);
    let mut seen: HashSet<(usize, i64, i64)> = HashSet::new();
    let mut out = Tips::default();
    for t in per {
        for (l, n) in t.tips {
            #[allow(clippy::cast_possible_truncation, reason = "grid cells on the plate")]
            let key = (
                l,
                (f64::from(n.target.x) / cell).round() as i64,
                (f64::from(n.target.y) / cell).round() as i64,
            );
            if !p.model_rest && !n.to_bed {
                continue;
            }
            if seen.insert(key) {
                out.tips.push((l, n));
            }
        }
        out.roofs.extend(t.roofs);
    }
    // With a raft: nothing below the first tree layer.
    if p.s.raft_layers > 0 {
        let first_tree = p.s.raft_layers - 1;
        out.tips.retain(|(l, _)| *l >= first_tree);
        out.roofs.retain(|(l, _, _)| *l >= first_tree);
    }
    out
}

/// Removes tips on the first tree layer that lie inside the expanded raft (spec 4.11).
pub(crate) fn drop_inside_raft(p: &Params, tips: &mut Tips, raft_contact: &Shapes) {
    if p.s.raft_layers == 0 || p.s.raft_expansion <= 0.0 || raft_contact.is_empty() {
        return;
    }
    let first_tree = p.s.raft_layers - 1;
    // Inside the expanded raft: a negative signed distance to its outline.
    tips.tips
        .retain(|(l, n)| *l != first_tree || !ops::contains(raft_contact, n.target));
}

#[cfg(test)]
mod tests {
    use super::super::params::{Settings, u};
    use super::*;

    #[test]
    fn half_step_matches_tip_geometry() {
        let p = Params::new(Settings {
            support_width: 0.4,
            ..Settings::default()
        });
        // r_t 0.4 is not under w 0.4: sqrt(0.16 - 0.04).
        assert!((half_step(&p) - 0.12f64.sqrt()).abs() < 1e-9);
    }

    #[test]
    fn slab_gets_tips_under_it() {
        // A 20 x 20 slab from layer 20 up, nothing under it: tips z_top + 1 layers under its first layer.
        let p = Params::new(Settings {
            support_width: 0.4,
            top_layers: 0,
            ..Settings::default()
        });
        let n = 30;
        let mut outl: Vec<Shapes> = vec![Vec::new(); n];
        for o in outl.iter_mut().skip(20) {
            *o = ops::rect([90.0, 90.0, 110.0, 110.0]);
        }
        let mut over: Vec<Shapes> = vec![Vec::new(); n];
        if let Some(o) = over.get_mut(20) {
            *o = ops::rect([90.0, 90.0, 110.0, 110.0]);
        }
        let v = Volumes::new(&p, &outl, Vec::new(), [0.0, 0.0, 200.0, 200.0], n);
        let t = generate(&p, &v, &over, 20 - p.z_top - 1, [100.0, 100.0]);
        assert!(!t.tips.is_empty());
        assert!(t.tips.iter().all(|(l, _)| *l == 20 - p.z_top - 1));
        // Tips stay under the slab and clear of nothing else.
        assert!(
            t.tips
                .iter()
                .all(|(_, n)| ops::contains(&ops::rect([89.0, 89.0, 111.0, 111.0]), n.target))
        );
        // Spaced about the connect length: roughly area / (c * line pitch) of them.
        assert!(t.tips.len() > 20, "{}", t.tips.len());
        assert!(t.tips.iter().all(|(_, n)| n.target.x >= u(90.0) - 1));
    }
}
