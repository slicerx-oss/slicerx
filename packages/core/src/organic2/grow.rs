// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Growing branches down one layer at a time (spec 5.1): each node tries growth settings from the most
//! to the least preferred until one leaves an area from which the bed, or a flat model top, can still
//! be reached.

use super::node::{Node, Recovery, Setting, Speed};
use super::ops;
use super::params::{HAIR, Params};
use super::volumes::{Kind, Volumes};
use crate::perimeters::Shapes;

/// The outcome of growing one node.
pub(crate) enum Grown {
    Child(Box<Node>),
    /// No setting worked: the parent loses its center and is flagged.
    Failed,
}

/// Speeds of one node for the step down.
struct Speeds {
    slow: f64,
    fast: f64,
}

fn speeds(p: &Params, n: &Node, layer: usize) -> Speeds {
    let mut extra = HAIR;
    let mut extra_slow = 0.0;
    let r_now = p.collision_radius(n.e, n.f);
    let r_next = p.radius(n.e + 1.0, n.f);
    let dr = r_next - r_now;
    if p.same_grid(r_now, r_next) || r_next < p.r_until {
        // The radius will grow, so the wall moves less than the center.
        extra += dr;
    } else {
        extra_slow += dr.min((p.m_fast + extra) - (p.m_slow + extra_slow));
    }
    let below = layer.saturating_sub(1);
    if layer < p.bed_layer && foot_bonus(p, p.recommended_min_radius(below), r_next) {
        // The foot widens toward the bed: a speed allowance.
        if p.same_grid(p.radius(n.e + 1.0, n.f + 1.0), r_next) {
            extra += p.widen_bed;
        } else {
            extra_slow += p.widen_bed.min(p.m_fast - (p.m_slow + extra_slow));
        }
    }
    Speeds {
        slow: p.m_slow + extra + extra_slow,
        fast: p.m_fast + extra,
    }
}

/// The foot speed bonus applies (spec 5.1, flag Q7): meant for a foot that will widen, so the recommended
/// radius below is larger than the next radius; the reference tests the opposite.
fn foot_bonus(p: &Params, recommended: f64, next: f64) -> bool {
    if p.s.quirks.foot_bonus_inverted {
        recommended < next
    } else {
        recommended > next
    }
}

fn setting(kind: Kind, speed: Speed, grow: bool, moves: bool) -> Setting {
    Setting {
        kind,
        speed,
        grow,
        error: false,
        min_gap: false,
        moves,
    }
}

/// The growth settings to try, in order (spec 5.1).
fn settings(p: &Params, v: &Volumes<'_>, n: &Node, layer: usize, merge_layer: bool) -> Vec<Setting> {
    use Kind::{Fast, FastSafe, Slow as KSlow};
    let child_d = n.d + 1;
    let t = u32::try_from(p.tip_layers).unwrap_or(u32::MAX);
    let mut list: Vec<Setting> = Vec::new();
    if let Some(last) = n.last {
        let matches = matches!(
            (last.kind, last.speed),
            (KSlow, Speed::Slow) | (Fast | FastSafe, Speed::Fast)
        );
        if last.moves
            && !last.error
            && n.safe
            && !merge_layer
            && matches
            && (n.d >= t || last.speed == Speed::Slow)
        {
            list.push(Setting { grow: true, ..last });
            list.push(Setting { grow: false, ..last });
        }
    }
    if n.safe {
        list.push(setting(KSlow, Speed::Slow, true, true));
        list.push(setting(KSlow, Speed::Slow, false, true));
        if n.d < t {
            list.push(setting(FastSafe, Speed::Slow, true, true));
        }
        list.push(setting(FastSafe, Speed::Fast, true, true));
        list.push(setting(FastSafe, Speed::Fast, false, true));
    } else {
        list.push(setting(KSlow, Speed::Slow, true, false));
        if n.d < t.div_ceil(2) {
            list.push(setting(Fast, Speed::Slow, true, false));
        }
        list.push(setting(FastSafe, Speed::Fast, true, false));
        list.push(setting(FastSafe, Speed::Fast, false, true));
        list.push(setting(Fast, Speed::Fast, false, true));
    }
    if n.min_gap {
        list = list
            .into_iter()
            .flat_map(|s| [s, Setting { min_gap: true, ..s }])
            .collect();
    }
    let no_place = || {
        let r = p.collision_radius(n.e, n.f);
        let below = layer.saturating_sub(1);
        ops::inter(&n.area, &v.placeable(r, below)).is_empty()
    };
    if n.to_bed || (n.flat && no_place()) {
        list.push(Setting {
            kind: Fast,
            speed: Speed::Fast,
            grow: false,
            error: true,
            min_gap: n.min_gap,
            moves: true,
        });
    }
    if child_d < n.stay_until && n.safe {
        list.insert(0, setting(KSlow, Speed::Zero, true, false));
    }
    let mut seen = std::collections::HashSet::new();
    list.retain(|s| seen.insert(*s));
    list
}

/// The areas a setting leaves, checked against where the bed or a flat top can still be reached.
struct Check {
    bed: Shapes,
    model: Shapes,
    to_bed: bool,
    flat: bool,
}

impl Check {
    fn area(&self) -> &Shapes {
        if self.to_bed { &self.bed } else { &self.model }
    }
}

#[allow(clippy::too_many_arguments, reason = "the state of one growth check")]
fn check(
    p: &Params,
    v: &Volumes<'_>,
    a: &Shapes,
    r: f64,
    below: usize,
    s: Setting,
    merge_layer: bool,
    mut to_bed: bool,
    mut flat: bool,
) -> Check {
    let mut bed = Vec::new();
    if merge_layer || to_bed {
        bed = ops::diff(a, &v.avoidance(r, below, s.kind, false, s.min_gap));
        if !bed.is_empty() {
            to_bed = true;
        }
    }
    let mut model = Vec::new();
    if p.model_rest {
        if merge_layer || flat {
            model = ops::diff(a, &v.avoidance(r, below, s.kind, true, s.min_gap));
        }
        if !flat {
            if merge_layer && !model.is_empty() {
                flat = true;
            } else {
                model = ops::diff(a, &v.collision(r, below, s.min_gap));
            }
        }
    }
    Check {
        bed,
        model,
        to_bed,
        flat,
    }
}

fn big_enough(s: &Shapes) -> bool {
    !ops::tiny(s, 0.001)
}

/// Grows node `n` (on `layer`) one layer down.
pub(crate) fn grow(
    p: &Params,
    v: &Volumes<'_>,
    n: &Node,
    idx: usize,
    layer: usize,
    merge_layer: bool,
) -> Grown {
    let Some(below) = layer.checked_sub(1) else {
        return Grown::Failed;
    };
    let sp = speeds(p, n, layer);
    let safe_step = {
        let gap = if n.min_gap { p.gap_min } else { p.gap_xy };
        let feature = if p.z_top >= 1 && p.z_bot >= 1 {
            p.s.min_feature_size
        } else {
            0.0
        };
        let s = gap + feature;
        if s <= 0.0 { 0.1 } else { s }
    };
    let r_parent = p.collision_radius(n.e, n.f);
    let wall = v.wall(r_parent, layer, n.min_gap);
    let mut slow_area: Option<Shapes> = None;
    let mut fast_area: Option<Shapes> = None;
    let drawn_child = p.drawn_radius(f64::from(n.d + 1), n.e, n.f);
    for s in settings(p, v, n, layer, merge_layer) {
        let grown: Shapes = if s.error {
            let edge = ops::stroke(&ops::outlines(&n.area), 0.005);
            ops::safe_grow(
                &ops::union(&n.area, &edge),
                1.5 * sp.fast,
                &wall,
                safe_step,
                safe_step + r_parent,
            )
        } else if !s.moves || s.speed == Speed::Zero {
            n.area.clone()
        } else {
            let slow = slow_area
                .get_or_insert_with(|| {
                    ops::safe_grow(&n.area, sp.slow, &wall, safe_step, safe_step + r_parent)
                })
                .clone();
            if s.speed == Speed::Slow {
                slow
            } else {
                fast_area
                    .get_or_insert_with(|| {
                        ops::safe_grow(
                            &slow,
                            (sp.fast - sp.slow).max(0.0),
                            &wall,
                            safe_step,
                            safe_step + r_parent,
                        )
                    })
                    .clone()
            }
        };
        let mut e = n.e;
        let mut f = n.f;
        let mut r = p.collision_radius(e, f);
        let mut c = check(p, v, &grown, r, below, s, merge_layer, n.to_bed, n.flat);
        // The radius depth advances one layer when a growing setting is still valid at the next radius
        // (spec silent; decided by black-box comparison of trunk widening, see design.md). The catch-up
        // below bounds e by the drawn radius from before this step.
        if s.grow && !c.area().is_empty() && e + 1.0 < f64::from(n.d + 1) + 1e-9 {
            let r1 = p.collision_radius(e + 1.0, f);
            let t = check(p, v, &grown, r1, below, s, merge_layer, n.to_bed, n.flat);
            if !t.area().is_empty() {
                e += 1.0;
                r = r1;
                c = t;
            }
        }
        if s.grow && !c.area().is_empty() {
            // Raise the collision radius one cached step at a time toward the drawn radius.
            let target = drawn_child.min(p.r_until);
            let mut accepted = p.quantize(r);
            let changed_from = accepted;
            let steps: Vec<f64> = p.grid.iter().copied().filter(|&g| g > accepted + 1e-9).collect();
            for g in steps {
                if g > p.quantize(target) + 1e-9 {
                    break;
                }
                let t = check(p, v, &grown, g, below, s, merge_layer, n.to_bed, n.flat);
                if t.area().is_empty() {
                    break;
                }
                accepted = g;
            }
            let child_d = f64::from(n.d + 1);
            while e + 2.0 < child_d
                && p.radius(e + 2.0, f) <= accepted + 1e-9
                && p.radius(e + 2.0, f) <= drawn_child + 1e-9
            {
                e += 1.0;
            }
            // Bed widening.
            let widen_room = p.widen_bed - p.widen;
            if widen_room > 0.0 {
                let planned = ((p.recommended_min_radius(below) - drawn_child) / widen_room).min(1.0);
                if planned > 0.0 && c.to_bed && drawn_child >= p.r_branch && drawn_child >= p.r_until {
                    let rr = p.collision_radius(e, f + planned);
                    let t = check(p, v, &grown, rr, below, s, merge_layer, n.to_bed, n.flat);
                    if !t.area().is_empty() {
                        f += planned;
                    }
                }
            }
            let r_new = p.collision_radius(e, f);
            if (p.quantize(r_new) - changed_from).abs() > 1e-9 || (r_new - r).abs() > 1e-12 {
                r = r_new;
                c = check(p, v, &grown, r, below, s, merge_layer, n.to_bed, n.flat);
            }
        }
        if !big_enough(c.area()) {
            continue;
        }
        let mut child = n.clone();
        child.d = n.d + 1;
        child.e = e;
        child.f = f;
        child.center = None;
        child.skip_oval = false;
        child.recovery = n.recovery.and_then(|rc| {
            (rc.count > 0).then_some(Recovery {
                count: rc.count - 1,
                depth: rc.depth + 1,
            })
        });
        child.last = Some(s);
        child.safe = s.kind != Kind::Fast;
        child.min_gap = n.min_gap && s.min_gap;
        child.to_bed = c.to_bed;
        child.flat = c.flat;
        child.lost = n.lost || s.error;
        if s.moves {
            child.stay_until = 0;
        } else {
            child.center = n.center;
        }
        child.bypass = !s.moves || (s.min_gap && (n.d as usize) < p.tip_layers);
        child.parents = vec![idx];
        child.child = None;
        let free = ops::diff(&grown, &v.collision(r, below, s.min_gap));
        child.area = ops::simplify(&ops::safe_union(&[&free, &c.bed, &c.model]), p.s.resolution);
        child.bed_area = if !child.bypass && c.to_bed {
            c.bed
        } else {
            Vec::new()
        };
        child.model_area = if !child.bypass && p.model_rest {
            c.model
        } else {
            Vec::new()
        };
        child.reached = false;
        child.deleted = false;
        return Grown::Child(Box::new(child));
    }
    Grown::Failed
}

/// Which growth steps merge (spec 5.2, flag Q4). With the flag on, every step merges. Off, a step merges
/// when its layer is fresh (it held nodes of its own before the step above saved its children there) or
/// when the interval since the last merge has passed; the interval grows by one, up to a cap, after each
/// merge that removed no node.
pub(crate) struct Cadence {
    every: bool,
    /// The longest interval: one merge per 5 mm of fast travel, 1 mm of slow travel or 3 mm of height.
    cap: usize,
    interval: usize,
    /// Layer of the last merge step.
    last: usize,
}

impl Cadence {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a layer count"
    )]
    pub(crate) fn new(p: &Params, top: usize) -> Self {
        let fast = (5.0 / p.m_fast.max(0.1)).floor() as usize;
        let slow = (1.0 / p.m_slow.max(0.02)).floor() as usize;
        let height = (3.0 / p.h).floor() as usize;
        Self {
            every: p.s.quirks.merge_every_layer,
            cap: fast.min(slow).min(height).max(1),
            interval: 1,
            last: top + 1,
        }
    }

    /// True when the step from `layer` down merges. A fresh layer resets the interval.
    pub(crate) fn merges(&mut self, layer: usize, fresh: bool) -> bool {
        if self.every {
            return true;
        }
        if fresh {
            self.interval = 1;
        }
        fresh || self.last.saturating_sub(layer) >= self.interval
    }

    /// Records a merge step: whether it removed any node.
    pub(crate) fn merged(&mut self, layer: usize, fresh: bool, reduced: bool) {
        self.last = layer;
        if !reduced && !fresh {
            self.interval = (self.interval + 1).min(self.cap);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::params::Settings;
    use super::*;

    #[test]
    fn cadence_merges_every_layer_with_the_flag() {
        let p = Params::new(Settings::default());
        assert!(p.s.quirks.merge_every_layer);
        let mut c = Cadence::new(&p, 100);
        assert!((1..100).rev().all(|l| {
            let m = c.merges(l, false);
            c.merged(l, false, false);
            m
        }));
    }

    #[test]
    fn cadence_backs_off_without_the_flag() {
        let mut s = Settings::default();
        s.quirks.merge_every_layer = false;
        let p = Params::new(s);
        let mut c = Cadence::new(&p, 200);
        // Defaults: min(29, 10, 15) = 10 layers at most between merges.
        assert_eq!(c.cap, 10);
        let mut steps = Vec::new();
        for l in (1..200).rev() {
            if c.merges(l, false) {
                steps.push(l);
                c.merged(l, false, false);
            }
        }
        let gaps: Vec<usize> = steps.windows(2).map(|w| w[0] - w[1]).collect();
        assert_eq!(&gaps[..4], &[2, 3, 4, 5]);
        assert!(gaps.iter().all(|&g| g <= 10));
        // A fresh layer always merges and resets the interval.
        assert!(c.merges(0, true));
    }
}
