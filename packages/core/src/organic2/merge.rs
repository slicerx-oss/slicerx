// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Merging branches that meet (spec 5.2), and the top-down loop that grows and merges every layer.

use super::grow::{self, Cadence, Grown};
use super::node::{Node, Setting, Speed};
use super::ops;
use super::params::{MODEL_MERGE_ALLOWANCE, Params, u};
use super::volumes::{Kind, Volumes};

fn coll_r(p: &Params, n: &Node) -> f64 {
    p.collision_radius(n.e, n.f)
}

fn drawn_r(p: &Params, n: &Node) -> f64 {
    p.drawn_radius(f64::from(n.d), n.e, n.f)
}

/// The less restrictive of two growth settings, field by field.
fn looser(a: Option<Setting>, b: Option<Setting>) -> Option<Setting> {
    let (a, b) = match (a, b) {
        (Some(a), Some(b)) => (a, b),
        (x, None) | (None, x) => return x,
    };
    let rank_kind = |k: Kind| match k {
        Kind::Slow => 0,
        Kind::FastSafe => 1,
        Kind::Fast => 2,
    };
    let rank_speed = |s: Speed| match s {
        Speed::Zero => 0,
        Speed::Slow => 1,
        Speed::Fast => 2,
    };
    Some(Setting {
        kind: if rank_kind(a.kind) >= rank_kind(b.kind) {
            a.kind
        } else {
            b.kind
        },
        speed: if rank_speed(a.speed) >= rank_speed(b.speed) {
            a.speed
        } else {
            b.speed
        },
        grow: a.grow || b.grow,
        error: a.error || b.error,
        min_gap: a.min_gap || b.min_gap,
        moves: a.moves || b.moves,
    })
}

/// Tries to merge `a` and `b` (candidates for layer `layer`); the merged node when they meet.
fn try_merge(p: &Params, v: &Volumes<'_>, a: &Node, b: &Node, layer: usize) -> Option<Node> {
    if a.flat != b.flat || a.min_gap != b.min_gap {
        return None;
    }
    let (small, big) = if coll_r(p, a) <= coll_r(p, b) {
        (a, b)
    } else {
        (b, a)
    };
    let diff = (drawn_r(p, big) - drawn_r(p, small)).max(0.0);
    if !ops::boxes_touch(ops::bbox(&small.area), ops::bbox(&big.area), u(diff)) {
        return None;
    }
    let mut merge_used: Option<f64> = None;
    if !(a.to_bed && b.to_bed) {
        if a.to_bed != b.to_bed {
            let model = if a.to_bed { b } else { a };
            let used = model.merge_used + diff;
            if used > MODEL_MERGE_ALLOWANCE {
                return None;
            }
            merge_used = Some(used);
        }
        if !a.supports_roof && !b.supports_roof && (a.d.max(b.d) as usize) < p.model_min_layers {
            return None;
        }
    }
    if !big.safe && small.safe {
        return None;
    }
    let both_bed = a.to_bed && b.to_bed;
    let r_small = coll_r(p, small);
    let obstacle = v.collision(r_small, layer, small.min_gap && big.min_gap);
    let step = 2.0 * (p.gap_xy + r_small - 3.0 * super::params::HAIR).max(0.01);
    let (sa, ba) = if both_bed {
        (&small.bed_area, &big.bed_area)
    } else {
        (&small.model_area, &big.model_area)
    };
    let grown = ops::safe_grow(sa, diff, &obstacle, step, 0.0);
    let meet = ops::inter(&grown, ba);
    if ops::tiny(&meet, 0.001) || ops::grow(&meet, -0.025).is_empty() {
        return None;
    }
    let grown_full = ops::safe_grow(&small.area, diff, &obstacle, step, 0.0);
    let area = ops::union(&ops::inter(&grown_full, &big.area), &meet);
    let e = a.e.max(b.e);
    let max_coll = coll_r(p, a).max(coll_r(p, b));
    let widen_room = p.widen_bed - p.widen;
    let f = if p.widen_bed > 0.0 && widen_room > 0.0 {
        (max_coll - p.collision_radius(e, 0.0)).abs() / widen_room
    } else {
        0.0
    };
    let flat = a.flat && b.flat;
    let (bed_area, model_area) = if both_bed {
        let model = if flat {
            let gm = ops::safe_grow(&small.model_area, diff, &obstacle, step, 0.0);
            ops::union(&ops::inter(&gm, &big.model_area), &meet)
        } else {
            area.clone()
        };
        (meet.clone(), model)
    } else {
        (Vec::new(), meet.clone())
    };
    let (hi, _) = if a.target_layer >= b.target_layer {
        (a, b)
    } else {
        (b, a)
    };
    let mut parents = a.parents.clone();
    for &q in &b.parents {
        if !parents.contains(&q) {
            parents.push(q);
        }
    }
    let recovery = match (a.recovery, b.recovery) {
        (Some(x), Some(y)) => Some(super::node::Recovery {
            count: x.count.max(y.count),
            depth: x.depth.max(y.depth),
        }),
        (x, None) | (None, x) => x,
    };
    Some(Node {
        d: a.d.max(b.d),
        e,
        f,
        target_layer: hi.target_layer,
        target: hi.target,
        hint: ops::move_inside(&meet, a.hint),
        center: None,
        to_bed: a.to_bed && b.to_bed,
        flat,
        min_gap: a.min_gap || b.min_gap,
        supports_roof: a.supports_roof || b.supports_roof,
        safe: a.safe || b.safe,
        skip_oval: false,
        stay_until: a.stay_until.max(b.stay_until),
        last: looser(a.last, b.last),
        recovery,
        merge_used: merge_used.unwrap_or(a.merge_used.max(b.merge_used)),
        lost: a.lost || b.lost,
        very_lost: a.very_lost || b.very_lost,
        parents,
        child: None,
        area,
        bed_area,
        model_area,
        bypass: false,
        deleted: false,
        reached: false,
    })
}

/// Merges within `set` until no pair merges; true when something merged.
fn merge_all_pairs(p: &Params, v: &Volumes<'_>, set: &mut Vec<Node>, layer: usize) -> bool {
    let mut any = false;
    let mut i = 0;
    while i < set.len() {
        let mut j = i + 1;
        let mut merged = false;
        while j < set.len() {
            let m = match (set.get(i), set.get(j)) {
                (Some(a), Some(b)) => try_merge(p, v, a, b, layer),
                _ => None,
            };
            if let Some(m) = m {
                set.swap_remove(j);
                if let Some(slot) = set.get_mut(i) {
                    *slot = m;
                }
                merged = true;
                any = true;
                // The merged node may now reach nodes it skipped: look again from the start.
                j = i + 1;
            } else {
                j += 1;
            }
        }
        if merged {
            i = 0;
        } else {
            i += 1;
        }
    }
    any
}

/// Merges a set of candidates: neighbors in small buckets first, then bucket groups up a box tree
/// (split at the median along the longer side of their bounds).
fn merge_tree(p: &Params, v: &Volumes<'_>, mut set: Vec<Node>, layer: usize) -> (Vec<Node>, bool) {
    if set.len() <= 4 {
        let any = merge_all_pairs(p, v, &mut set, layer);
        return (set, any);
    }
    let centers: Vec<(i64, i64)> = set
        .iter()
        .map(|n| {
            ops::bbox(&n.area).map_or((0, 0), |[x0, y0, x1, y1]| {
                (
                    i64::midpoint(i64::from(x0), i64::from(x1)),
                    i64::midpoint(i64::from(y0), i64::from(y1)),
                )
            })
        })
        .collect();
    let (minx, maxx) = centers
        .iter()
        .fold((i64::MAX, i64::MIN), |(lo, hi), c| (lo.min(c.0), hi.max(c.0)));
    let (miny, maxy) = centers
        .iter()
        .fold((i64::MAX, i64::MIN), |(lo, hi), c| (lo.min(c.1), hi.max(c.1)));
    let by_x = maxx - minx >= maxy - miny;
    let mut order: Vec<usize> = (0..set.len()).collect();
    order.sort_by_key(|&k| {
        centers
            .get(k)
            .map_or((0, 0), |c| if by_x { (c.0, c.1) } else { (c.1, c.0) })
    });
    let mut slots: Vec<Option<Node>> = set.into_iter().map(Some).collect();
    let sorted: Vec<Node> = order
        .iter()
        .filter_map(|&k| slots.get_mut(k).and_then(Option::take))
        .collect();
    let half = sorted.len() / 2;
    let mut left = sorted;
    let right = left.split_off(half);
    let ((mut l, la), (r, ra)) = crate::par::join(
        || merge_tree(p, v, left, layer),
        || merge_tree(p, v, right, layer),
    );
    // Across the halves: each node of the right half is merged into the left half while it meets
    // something there, and a merged node goes on merging.
    let mut any = la || ra;
    for mut n in r {
        loop {
            let hit = l
                .iter()
                .enumerate()
                .find_map(|(k, m)| try_merge(p, v, m, &n, layer).map(|x| (k, x)));
            match hit {
                Some((k, merged)) => {
                    l.swap_remove(k);
                    n = merged;
                    any = true;
                }
                None => break,
            }
        }
        l.push(n);
    }
    (l, any)
}

/// Grows every node from the top layer down, merging as the cadence says. `layers` holds the tips on
/// entry and every node on return; `child` and `parents` link neighbors.
pub(crate) fn descend(p: &Params, v: &Volumes<'_>, layers: &mut [Vec<Node>]) {
    let top = layers.len().saturating_sub(1);
    let mut cadence = Cadence::new(p, top);
    // A layer is fresh (spec 5.2 and E6) when it already holds a node as the step from above reaches it:
    // a tip, or a child of that step that skipped merging. The topmost step is never fresh.
    let mut fresh: Vec<bool> = layers.iter().map(|l| !l.is_empty()).collect();
    if let Some(f) = fresh.get_mut(top) {
        *f = false;
    }
    for layer in (1..layers.len()).rev() {
        let Some(here) = layers.get(layer) else { continue };
        if here.is_empty() {
            continue;
        }
        let is_fresh = fresh.get(layer).copied().unwrap_or(false);
        let merge_layer = cadence.merges(layer, is_fresh);
        let idx: Vec<usize> = (0..here.len()).collect();
        let results: Vec<Grown> = crate::par::map(&idx, |&k| match here.get(k) {
            Some(n) => grow::grow(p, v, n, k, layer, merge_layer),
            None => Grown::Failed,
        });
        let mut children: Vec<Node> = Vec::new();
        let mut failed: Vec<usize> = Vec::new();
        for (k, g) in results.into_iter().enumerate() {
            match g {
                Grown::Child(c) => children.push(*c),
                Grown::Failed => failed.push(k),
            }
        }
        if let Some(here) = layers.get_mut(layer) {
            for k in failed {
                if let Some(n) = here.get_mut(k) {
                    n.center = None;
                    n.flat = false;
                    n.very_lost = true;
                }
            }
            // The step is taken: the merge areas of this layer are no longer needed.
            for n in here.iter_mut() {
                n.bed_area = Vec::new();
                n.model_area = Vec::new();
            }
        }
        let (pass, cands): (Vec<Node>, Vec<Node>) = children
            .into_iter()
            .partition(|c| c.bypass || (c.bed_area.is_empty() && c.model_area.is_empty()));
        if !pass.is_empty()
            && let Some(f) = fresh.get_mut(layer - 1)
        {
            *f = true;
        }
        let merged = if merge_layer {
            let before = cands.len();
            let m = if before > 1 {
                merge_tree(p, v, cands, layer - 1).0
            } else {
                cands
            };
            cadence.merged(layer, is_fresh, m.len() < before);
            m
        } else {
            cands
        };
        let below_start = layers.get(layer - 1).map_or(0, Vec::len);
        let mut new_nodes: Vec<Node> = pass.into_iter().chain(merged).collect();
        for n in &mut new_nodes {
            n.area = ops::safe_union(&[&n.area]);
        }
        // Link parents to their new children.
        if let Some(here) = layers.get_mut(layer) {
            for (k, n) in new_nodes.iter().enumerate() {
                for &q in &n.parents {
                    if let Some(par) = here.get_mut(q) {
                        par.child = Some(below_start + k);
                    }
                }
            }
        }
        if let Some(below) = layers.get_mut(layer - 1) {
            below.extend(new_nodes);
        }
    }
}

/// The reach area of a candidate, for tests.
#[cfg(test)]
pub(crate) fn area_of(n: &Node) -> &crate::perimeters::Shapes {
    &n.area
}

#[cfg(test)]
mod tests {
    use super::super::node::Class;
    use super::super::ops::P;
    use super::super::params::Settings;
    use super::*;

    #[test]
    fn close_bed_nodes_merge_far_ones_do_not() {
        let p = Params::new(Settings {
            support_width: 0.4,
            ..Settings::default()
        });
        let v = Volumes::new(
            &p,
            &vec![Vec::new(); 10],
            Vec::new(),
            [0.0, 0.0, 200.0, 200.0],
            10,
        );
        let mk = |x: f64| {
            let mut n = Node::tip(P::new(u(x), u(100.0)), 5, Class::BedSafe, false);
            n.d = 6;
            n.e = 6.0;
            n.area = ops::circle(P::new(u(x), u(100.0)), 0.5, 32);
            n.bed_area = n.area.clone();
            n.model_area = n.area.clone();
            n
        };
        let (a, b, far) = (mk(100.0), mk(100.6), mk(150.0));
        let m = try_merge(&p, &v, &a, &b, 4);
        assert!(m.is_some());
        assert!(try_merge(&p, &v, &a, &far, 4).is_none());
        let m = m.unwrap_or_else(|| a.clone());
        assert!(!area_of(&m).is_empty());
    }
}
