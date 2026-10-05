// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The filament order inside a layer when the profile or the flush volumes decide it (Orca's
//! `ToolOrdering::reorder_extruders_for_minimum_flush_volume` and `reorder_filaments_for_minimum_flush_volume`
//! in `ToolOrderUtils.cpp`, `apply_first_layer_order`, `get_other_layers_print_sequence`):
//!
//! - `first_layer_print_sequence`: the first layer's filaments in that order (1-based ids), when it names at
//!   least as many as the layer prints.
//! - `other_layers_print_sequence` with `other_layers_print_sequence_nums`: blocks of
//!   `[first layer, last layer, filaments...]` (1-based); the last block that covers a layer orders it.
//! - Otherwise, when changes purge by the flush matrix (a Bambu Lab printer, or `purge_in_prime_tower` with
//!   `single_extruder_multi_material`), the order with the least flush: for up to five filaments on this
//!   layer and the next, every order of both layers is tried and the cheapest pair wins, fewer changes
//!   breaking ties; up to 20 the cheapest path through this layer alone (Held and Karp); past that the
//!   cheapest next filament each time.
//!
//! A sequence that leaves out a filament the layer prints gets it appended, where Orca's would drop it.

use crate::config::PrintConfig;

/// How the layers' filament orders are chosen beyond the default.
#[derive(Debug, Clone, Default)]
pub(crate) struct Choice {
    first: Vec<u8>,
    /// 0-based first and last layer, and the filaments.
    ranges: Vec<(usize, usize, Vec<u8>)>,
    /// Flush volume from slot `a` to slot `b` (1-based), mm3, when changes purge by the matrix.
    flush: Option<Vec<Vec<f64>>>,
    /// On a printer with a filament map (H2D, H2C): the extruder of each slot and the flush on each
    /// extruder, `[extruder][a][b]` by 1-based slot (0 between filaments in nozzles of their own).
    groups: Option<(crate::nozzles::Groups, Vec<Vec<Vec<f64>>>)>,
}

fn ints(cfg: &PrintConfig, key: &str) -> Vec<i64> {
    let num = |v: &serde_json::Value| match v {
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    };
    match cfg.raw.get(key) {
        Some(serde_json::Value::Array(a)) => a.iter().filter_map(num).collect(),
        Some(serde_json::Value::String(s)) => s.split(',').filter_map(|t| t.trim().parse().ok()).collect(),
        Some(v) => num(v).into_iter().collect(),
        None => Vec::new(),
    }
}

fn slots(v: &[i64]) -> Vec<u8> {
    v.iter()
        .filter_map(|&x| u8::try_from(x).ok().filter(|&s| s > 0))
        .collect()
}

impl Choice {
    pub(crate) fn of(cfg: &PrintConfig, tools: u8) -> Self {
        let first = slots(&ints(cfg, "first_layer_print_sequence"));
        let flat = ints(cfg, "other_layers_print_sequence");
        let nums = usize::try_from(
            ints(cfg, "other_layers_print_sequence_nums")
                .first()
                .copied()
                .unwrap_or(0),
        )
        .unwrap_or(0);
        let mut ranges = Vec::new();
        if nums > 0 && !flat.is_empty() && flat.len().is_multiple_of(nums) {
            for block in flat.chunks(flat.len() / nums) {
                if let [a, b, rest @ ..] = block {
                    let (a, b) = (usize::try_from(*a).unwrap_or(0), usize::try_from(*b).unwrap_or(0));
                    if a >= 1 && b >= a && !rest.is_empty() {
                        ranges.push((a - 1, b - 1, slots(rest)));
                    }
                }
            }
        }
        let flush = (crate::tower::type1(cfg) || crate::tower::flush_on_tower(cfg)).then(|| {
            (0..=usize::from(tools))
                .map(|a| {
                    (0..=usize::from(tools))
                        .map(|b| match (a.checked_sub(1), b.checked_sub(1)) {
                            (Some(a), Some(b)) => crate::tower::flush_entry(cfg, tools, a, b).unwrap_or(0.0),
                            _ => 0.0,
                        })
                        .collect()
                })
                .collect()
        });
        let groups = crate::nozzles::shared(cfg).then(|| {
            let map = |key: &str| -> Vec<u8> {
                (1..=tools)
                    .map(|slot| {
                        #[allow(
                            clippy::cast_possible_truncation,
                            clippy::cast_sign_loss,
                            reason = "a small index"
                        )]
                        let v = crate::tower::per_slot_raw(
                            cfg,
                            key,
                            slot,
                            if key == "filament_map" { 1.0 } else { 0.0 },
                        )
                        .round()
                        .max(0.0) as u8;
                        v
                    })
                    .collect()
            };
            let extruder: Vec<u8> = map("filament_map").iter().map(|&e| e.max(1) - 1).collect();
            let nozzle = map("filament_nozzle_map");
            let ext = crate::nozzles::extruders(cfg);
            let n = usize::from(tools);
            let tables = (0..ext)
                .map(|e| {
                    (0..=n)
                        .map(|a| {
                            (0..=n)
                                .map(|b| match (a.checked_sub(1), b.checked_sub(1)) {
                                    (Some(a), Some(b)) if nozzle.get(a) == nozzle.get(b) => {
                                        crate::tower::flush_block(cfg, tools, e, a, b).unwrap_or(0.0)
                                    }
                                    _ => 0.0,
                                })
                                .collect()
                        })
                        .collect()
                })
                .collect();
            (crate::nozzles::Groups { extruder }, tables)
        });
        Self {
            first,
            ranges,
            flush,
            groups,
        }
    }

    /// True when the layers' orders follow a filament map: each extruder's filaments together.
    pub(crate) fn grouped(&self) -> bool {
        self.groups.is_some()
    }

    /// The extruder (0-based) of `slot` under the filament map, 0 without one.
    pub(crate) fn extruder_of(&self, slot: u8) -> usize {
        self.groups.as_ref().map_or(0, |(g, _)| {
            usize::from(g.extruder.get(usize::from(slot.max(1) - 1)).copied().unwrap_or(0))
        })
    }

    /// The first layer's order with `first_layer_print_sequence` applied.
    pub(crate) fn first_layer(&self, order: Vec<u8>) -> Vec<u8> {
        if self.first.len() < order.len() || self.first.is_empty() {
            return order;
        }
        let mut o = order;
        o.sort_by_key(|t| self.first.iter().position(|f| f == t).unwrap_or(usize::MAX));
        o
    }

    /// The order of layer `l` (from 1), printing `here` (sorted) after the filament `cur` (0: none) and
    /// before a layer printing `next`, when a sequence or the flush volumes decide it.
    /// `last` is the filament each extruder printed last (0: none), which a filament map orders from.
    pub(crate) fn order(&self, l: usize, here: &[u8], next: &[u8], cur: u8, last: &[u8]) -> Option<Vec<u8>> {
        if let Some((_, _, seq)) = self.ranges.iter().rev().find(|(a, b, _)| *a <= l && l <= *b) {
            let mut o: Vec<u8> = seq.iter().copied().filter(|t| here.contains(t)).collect();
            o.dedup();
            o.extend(here.iter().copied().filter(|t| !seq.contains(t)));
            return Some(o);
        }
        if let Some((g, tables)) = &self.groups {
            let w = |e: usize, a: u8, b: u8| {
                tables
                    .get(e)
                    .and_then(|t| t.get(usize::from(a)))
                    .and_then(|r| r.get(usize::from(b)))
                    .copied()
                    .unwrap_or(0.0)
            };
            return Some(g.order(&w, here, next, cur, last));
        }
        let flush = self.flush.as_ref()?;
        if here.len() < 2 {
            return None;
        }
        let w = |a: u8, b: u8| {
            flush
                .get(usize::from(a))
                .and_then(|r| r.get(usize::from(b)))
                .copied()
                .unwrap_or(0.0)
        };
        let start = (cur != 0).then_some(cur);
        Some(if here.len() <= 5 && next.len() <= 5 {
            forecast(&w, here, next, start)
        } else if here.len() <= 20 {
            held_karp(&w, here, start)
        } else {
            greedy(&w, here, start)
        })
    }
}

/// The order of `here` with the least flush from `start` (Orca's `get_extruders_order`): every order of this
/// layer and the next for up to five filaments each, the cheapest path (Held and Karp) for up to 20, else the
/// cheapest next filament each time.
pub(crate) fn cheapest(w: &dyn Fn(u8, u8) -> f64, here: &[u8], next: &[u8], start: Option<u8>) -> Vec<u8> {
    if here.len() < 2 {
        return here.to_vec();
    }
    if here.len() <= 5 && next.len() <= 5 {
        forecast(w, here, next, start)
    } else if here.len() <= 20 {
        held_karp(w, here, start)
    } else {
        greedy(w, here, start)
    }
}

/// The next order of `p` in lexicographic order (`std::next_permutation`); false after the last.
fn next_perm(p: &mut [u8]) -> bool {
    let Some(i) = (1..p.len()).rev().find(|&i| p.get(i - 1) < p.get(i)) else {
        return false;
    };
    let pivot = p.get(i - 1).copied();
    let Some(j) = (i..p.len()).rev().find(|&j| p.get(j).copied() > pivot) else {
        return false;
    };
    p.swap(i - 1, j);
    if let Some(tail) = p.get_mut(i..) {
        tail.reverse();
    }
    true
}

/// Every order of `v` in lexicographic order, from sorted.
fn permutations(v: &[u8]) -> Vec<Vec<u8>> {
    let mut p = v.to_vec();
    p.sort_unstable();
    let mut out = vec![p.clone()];
    while next_perm(&mut p) {
        out.push(p.clone());
    }
    out
}

fn path_cost(w: &dyn Fn(u8, u8) -> f64, seq: &[u8], mut prev: Option<u8>) -> (f64, usize, Option<u8>) {
    let (mut cost, mut changes) = (0.0, 0);
    for &t in seq {
        if let Some(p) = prev {
            cost += w(p, t);
            changes += usize::from(p != t);
        }
        prev = Some(t);
    }
    (cost, changes, prev)
}

/// Orca's `solve_extruder_order_with_forcast`.
fn forecast(w: &dyn Fn(u8, u8) -> f64, here: &[u8], next: &[u8], start: Option<u8>) -> Vec<u8> {
    let nexts = permutations(next);
    let (mut best_cost, mut best_changes, mut best) = (f64::INFINITY, usize::MAX, here.to_vec());
    for cur in permutations(here) {
        let (c1, n1, last) = path_cost(w, &cur, start);
        if c1 > best_cost {
            continue;
        }
        for nx in &nexts {
            let (c2, n2, _) = path_cost(w, nx, last);
            let (cost, changes) = (c1 + c2, n1 + n2);
            if cost < best_cost || ((cost - best_cost).abs() < 1e-9 && changes < best_changes) {
                (best_cost, best_changes, best) = (cost, changes, cur.clone());
            }
        }
    }
    best
}

/// Orca's `solve_extruder_order`: the cheapest path through all of `here` from `start` (Held and Karp).
fn held_karp(w: &dyn Fn(u8, u8) -> f64, here: &[u8], start: Option<u8>) -> Vec<u8> {
    let mut all = here.to_vec();
    let mut added = false;
    match start.and_then(|s| all.iter().position(|&t| t == s)) {
        Some(i) => all.swap(0, i),
        None => {
            if let Some(s) = start {
                all.insert(0, s);
                added = true;
            }
        }
    }
    let n = all.len();
    if n == 0 {
        return Vec::new();
    }
    let full = (1usize << n) - 1;
    let at = |state: usize, t: usize| state * n + t;
    let mut cost = vec![f64::INFINITY; (full + 1) * n];
    let mut prev = vec![usize::MAX; (full + 1) * n];
    if let Some(c) = cost.get_mut(at(1, 0)) {
        *c = 0.0;
    }
    let slot = |k: usize| all.get(k).copied().unwrap_or(0);
    for state in (1..=full).filter(|s| s & 1 == 1) {
        for t in (0..n).filter(|t| state >> t & 1 == 1) {
            for m in (0..n).filter(|m| state >> m & 1 == 1) {
                let from = cost
                    .get(at(state - (1 << t), m))
                    .copied()
                    .unwrap_or(f64::INFINITY);
                if from.is_infinite() {
                    continue;
                }
                let c = from + w(slot(m), slot(t));
                if let (Some(best), Some(p)) = (cost.get_mut(at(state, t)), prev.get_mut(at(state, t)))
                    && c < *best
                {
                    *best = c;
                    *p = m;
                }
            }
        }
    }
    let end_cost = |d: usize| cost.get(at(full, d)).copied().unwrap_or(f64::INFINITY);
    let end = (0..n)
        .filter(|&d| d != 0 || n == 1)
        .min_by(|&a, &b| end_cost(a).total_cmp(&end_cost(b)))
        .unwrap_or(0);
    let (mut path, mut state, mut k) = (Vec::with_capacity(n), full, end);
    while k != usize::MAX && path.len() < n {
        path.push(slot(k));
        let m = prev.get(at(state, k)).copied().unwrap_or(usize::MAX);
        state -= 1 << k;
        k = m;
    }
    if added {
        path.pop();
    }
    path.reverse();
    path
}

/// Orca's `solve_extruder_order_with_greedy`.
fn greedy(w: &dyn Fn(u8, u8) -> f64, here: &[u8], start: Option<u8>) -> Vec<u8> {
    let mut left = here.to_vec();
    let mut out = Vec::with_capacity(left.len());
    let mut prev = start;
    while let Some(&head) = left.first() {
        let p = prev.unwrap_or(head);
        let k = left
            .iter()
            .enumerate()
            .min_by(|&(_, &a), &(_, &b)| w(p, a).total_cmp(&w(p, b)).then_with(|| (b == p).cmp(&(a == p))))
            .map_or(0, |(k, _)| k);
        let t = left.remove(k);
        out.push(t);
        prev = Some(t);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pairs: &[(&str, serde_json::Value)]) -> PrintConfig {
        let mut c = PrintConfig::default();
        for (k, v) in pairs {
            c.raw.insert((*k).to_owned(), v.clone());
        }
        c
    }

    #[test]
    fn sequences_from_the_profile() {
        let c = Choice::of(
            &cfg(&[
                ("first_layer_print_sequence", serde_json::json!([3, 1, 2])),
                (
                    "other_layers_print_sequence",
                    serde_json::json!([2, 5, 2, 1, 3, 4, 9, 3, 2, 1]),
                ),
                ("other_layers_print_sequence_nums", serde_json::json!(2)),
            ]),
            3,
        );
        assert_eq!(c.first_layer(vec![1, 2, 3]), vec![3, 1, 2]);
        // Layers 2 to 5 (index 1 to 4) and 4 to 9; the later block wins where they overlap.
        assert_eq!(c.order(1, &[1, 2, 3], &[], 0, &[]), Some(vec![2, 1, 3]));
        assert_eq!(c.order(4, &[1, 2, 3], &[], 0, &[]), Some(vec![3, 2, 1]));
        assert_eq!(c.order(4, &[1, 3], &[], 0, &[]), Some(vec![3, 1]));
        // Past the blocks the flush decides; without a matrix every order costs the same and the first wins.
        assert_eq!(c.order(10, &[1, 2, 3], &[], 0, &[]), Some(vec![1, 2, 3]));
        let off = Choice::of(&cfg(&[("purge_in_prime_tower", serde_json::json!(false))]), 3);
        assert_eq!(off.order(10, &[1, 2, 3], &[], 0, &[]), None);
        // Too short a first layer sequence is ignored.
        let short = Choice::of(&cfg(&[("first_layer_print_sequence", serde_json::json!([2]))]), 3);
        assert_eq!(short.first_layer(vec![1, 2]), vec![1, 2]);
    }

    #[test]
    fn the_flush_matrix_picks_the_cheapest_order() {
        // 1 to 2 and 2 to 3 are cheap, the rest dear.
        let m = serde_json::json!([0, 10, 500, 500, 0, 10, 500, 500, 0]);
        let c = Choice::of(
            &cfg(&[
                ("printer_model", serde_json::json!("Bambu Lab X1 Carbon")),
                ("flush_volumes_matrix", m),
            ]),
            3,
        );
        assert_eq!(c.order(3, &[1, 2, 3], &[1], 1, &[]), Some(vec![1, 2, 3]));
        // With nothing loaded yet, the cheap chain ends on what the next layer starts with.
        assert_eq!(c.order(3, &[1, 2, 3], &[3], 0, &[]), Some(vec![1, 2, 3]));
        let w = |a: u8, b: u8| {
            [[0.0, 10.0, 500.0], [500.0, 0.0, 10.0], [500.0, 500.0, 0.0]][usize::from(a) - 1]
                [usize::from(b) - 1]
        };
        assert_eq!(held_karp(&w, &[1, 2, 3], Some(2)), vec![2, 3, 1]);
        assert_eq!(held_karp(&w, &[2, 3], Some(1)), vec![2, 3]);
        assert_eq!(greedy(&w, &[3, 2, 1], Some(1)), vec![1, 2, 3]);
        assert_eq!(permutations(&[2, 1, 3]).len(), 6);
    }
}
