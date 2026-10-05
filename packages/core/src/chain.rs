// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The order Orca prints a set of paths in (`chain_extrusion_entities`, `ShortestPath.cpp`): a greedy
//! traveling salesman tour over the end points of the paths, built one edge at a time with the shortest
//! edge that neither gives an end point a second link nor closes a loop (the multi-fragment heuristic),
//! then walked from the end point nearest the start. Our own implementation: the nearest-valid-end-point
//! queries scan a list sorted by x instead of walking Orca's k-d tree, and ties go to the lower index.

#![allow(
    clippy::indexing_slicing,
    reason = "every index is below the end point count, and all the lists have that length"
)]

use crate::geom::Point;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// One thing to order: where it starts and ends, and whether it may be printed backward.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Ent {
    pub(crate) first: Point,
    pub(crate) last: Point,
    pub(crate) reversible: bool,
}

fn d2(a: Point, b: Point) -> i64 {
    let (dx, dy) = (i64::from(a.x) - i64::from(b.x), i64::from(a.y) - i64::from(b.y));
    dx * dx + dy * dy
}

/// A sorted view of the end points for nearest queries.
struct Index {
    /// End point numbers by x.
    by_x: Vec<usize>,
    xs: Vec<i32>,
}

impl Index {
    fn new(pos: &[Point]) -> Self {
        let mut by_x: Vec<usize> = (0..pos.len()).collect();
        crate::sorting::sort_by_key(&mut by_x, |&i| (pos.get(i).map_or(0, |p| p.x), i));
        let xs = by_x.iter().map(|&i| pos.get(i).map_or(0, |p| p.x)).collect();
        Self { by_x, xs }
    }

    /// The accepted end point nearest `at`, by squared distance then number.
    fn nearest(&self, pos: &[Point], at: Point, accept: &mut dyn FnMut(usize) -> bool) -> Option<usize> {
        let split = self.xs.partition_point(|&x| x < at.x);
        let mut best: Option<(i64, usize)> = None;
        let mut visit = |k: usize, best: &mut Option<(i64, usize)>| -> bool {
            let Some(&i) = self.by_x.get(k) else { return false };
            let Some(&p) = pos.get(i) else { return false };
            let dx = i64::from(p.x) - i64::from(at.x);
            if best.is_some_and(|(d, _)| dx * dx > d) {
                return false;
            }
            if accept(i) {
                let d = d2(p, at);
                if best.is_none_or(|b| (d, i) < b) {
                    *best = Some((d, i));
                }
            }
            true
        };
        let (mut left, mut right) = (split, split);
        let (mut go_left, mut go_right) = (true, true);
        while go_left || go_right {
            if go_left {
                if left == 0 {
                    go_left = false;
                } else {
                    left -= 1;
                    go_left = visit(left, &mut best);
                }
            }
            if go_right {
                if right >= self.by_x.len() {
                    go_right = false;
                } else {
                    go_right = visit(right, &mut best);
                    right += 1;
                }
            }
        }
        best.map(|b| b.1)
    }
}

/// Equivalent chain ids, as Orca's `EquivalentChains`.
struct Chains {
    equivalent: Vec<usize>,
}

impl Chains {
    fn new() -> Self {
        Self { equivalent: vec![0] }
    }
    fn next(&mut self) -> usize {
        let id = self.equivalent.len();
        self.equivalent.push(id);
        id
    }
    fn get(&mut self, id: usize) -> usize {
        if id == 0 {
            return 0;
        }
        let mut last = id;
        loop {
            let lower = self.equivalent.get(last).copied().unwrap_or(last);
            if lower == last {
                if let Some(e) = self.equivalent.get_mut(id) {
                    *e = lower;
                }
                return lower;
            }
            last = lower;
        }
    }
    fn merge(&mut self, a: usize, b: usize) -> usize {
        let id = self.get(a).min(self.get(b));
        for x in [a, b] {
            if let Some(e) = self.equivalent.get_mut(x) {
                *e = id;
            }
        }
        id
    }
}

/// The order and the direction to print `ents` in, starting near `start`: (entity, reversed). A greedy tour
/// over the end points; entities that cannot reverse and would have to are handled as Orca does, by taking
/// the nearest end point each time instead.
pub(crate) fn chain(ents: &[Ent], start: Point) -> Vec<(usize, bool)> {
    let n = ents.len();
    match n {
        0 => return Vec::new(),
        1 => {
            let e = ents[0];
            return vec![(0, e.reversible && d2(e.last, start) < d2(e.first, start))];
        }
        _ => {}
    }
    let pos: Vec<Point> = ents.iter().flat_map(|e| [e.first, e.last]).collect();
    let could_reverse = |seg: usize| ents.get(seg).is_some_and(|e| e.reversible);
    let index = Index::new(&pos);
    // Per end point: the chain it belongs to (0: none yet), its link out and the distance to it.
    let mut chain_id = vec![0usize; 2 * n];
    let mut edge_out: Vec<Option<usize>> = vec![None; 2 * n];
    let mut dist = vec![i64::MAX; 2 * n];
    let mut queued = vec![true; 2 * n];
    let mut version = vec![0u32; 2 * n];
    let mut chains = Chains::new();
    // The first end point: the one nearest the start that may begin a segment.
    let first_idx = index
        .nearest(&pos, start, &mut |i| i % 2 == 0 || could_reverse(i / 2))
        .unwrap_or(0);
    dist[first_idx] = 0;
    chain_id[first_idx] = chains.next();
    queued[first_idx] = false;
    for i in 0..2 * n {
        if i == first_idx {
            continue;
        }
        let p = pos[i];
        let next = index.nearest(&pos, p, &mut |j| j != first_idx && (j ^ i) > 1);
        if let Some(j) = next {
            edge_out[i] = Some(j);
            dist[i] = d2(pos[j], p);
        }
    }
    let mut heap: BinaryHeap<Reverse<(i64, usize, u32)>> = BinaryHeap::new();
    for (i, &d) in dist.iter().enumerate() {
        if i != first_idx {
            heap.push(Reverse((d, i, 0)));
        }
    }
    let mut last_point: Option<usize> = None;
    #[allow(clippy::cast_possible_wrap, reason = "a count of paths")]
    let mut iter = n as i64 - 2;
    loop {
        // The queue's top: the end point whose link is shortest.
        let top = loop {
            let Some(Reverse((_, i, v))) = heap.peek().copied() else {
                break None;
            };
            if queued[i] && version[i] == v {
                break Some(i);
            }
            heap.pop();
        };
        let Some(e1) = top else { break };
        let Some(e2) = edge_out[e1] else { break };
        let mut valid = true;
        let (mut o1, mut o2) = (0, 0);
        if chain_id[e2] > 0 {
            valid = false;
        } else {
            o1 = chains.get(chain_id[e1 ^ 1]);
            o2 = chains.get(chain_id[e2 ^ 1]);
            if o1 == o2 && o1 != 0 {
                valid = false;
            }
        }
        if valid {
            queued[e1] = false;
            queued[e2] = false;
            edge_out[e2] = Some(e1);
            dist[e2] = dist[e1];
            let id = match (o1, o2) {
                (0, 0) => chains.next(),
                (0, b) => b,
                (a, 0) => a,
                (a, b) if a == b => a,
                (a, b) => chains.merge(a, b),
            };
            chain_id[e1] = id;
            chain_id[e2] = id;
            if iter == 0 {
                // One end point is left waiting: the end of the tour.
                last_point = (0..2 * n).find(|&i| queued[i]);
                break;
            }
            iter -= 1;
        } else {
            edge_out[e1] = None;
            let c1 = chain_id[e1 ^ 1];
            let next = index.nearest(&pos, pos[e1], &mut |j| {
                if (j ^ e1) <= 1 || chain_id[j] != 0 {
                    return false;
                }
                let a = chains.get(c1);
                let b = chains.get(chain_id[j ^ 1]);
                a != b || a == 0
            });
            if let Some(j) = next {
                edge_out[e1] = Some(j);
                dist[e1] = d2(pos[j], pos[e1]);
            } else {
                dist[e1] = i64::MAX;
            }
            version[e1] += 1;
            heap.push(Reverse((dist[e1], e1, version[e1])));
        }
    }
    let _ = last_point;
    // Walk the tour from the first end point.
    let mut out: Vec<(usize, bool)> = Vec::with_capacity(n);
    let mut at = Some(first_idx);
    let mut failed = false;
    while let Some(i) = at {
        let (seg, reversed) = (i / 2, i % 2 == 1);
        if reversed && !could_reverse(seg) {
            failed = true;
            break;
        }
        out.push((seg, reversed));
        at = edge_out[i ^ 1];
        if out.len() > n {
            failed = true;
            break;
        }
    }
    if failed || out.len() != n {
        return nearest_chain(&pos, ents, first_idx);
    }
    out
}

/// Orca's last resort: take the nearest end point of an unused segment each time.
fn nearest_chain(pos: &[Point], ents: &[Ent], first_idx: usize) -> Vec<(usize, bool)> {
    let n = ents.len();
    let mut used = vec![false; 2 * n];
    let mut out = vec![(first_idx / 2, first_idx % 2 == 1)];
    used[first_idx] = true;
    used[first_idx ^ 1] = true;
    let mut here = first_idx ^ 1;
    while out.len() < n {
        let at = pos[here];
        let best = (0..2 * n)
            .filter(|&j| !used[j] && (j % 2 == 0 || ents.get(j / 2).is_some_and(|e| e.reversible)))
            .min_by_key(|&j| (d2(pos[j], at), j));
        let Some(j) = best else { break };
        used[j] = true;
        used[j ^ 1] = true;
        out.push((j / 2, j % 2 == 1));
        here = j ^ 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(x0: i32, y0: i32, x1: i32, y1: i32) -> Ent {
        Ent {
            first: Point::new(x0, y0),
            last: Point::new(x1, y1),
            reversible: true,
        }
    }

    #[test]
    fn parallel_lines_run_in_a_zigzag_from_the_start() {
        // Four lines side by side, each given the same way: the tour reverses every other one.
        let lines: Vec<Ent> = (0..4).map(|k| seg(k * 100, 0, k * 100, 1000)).collect();
        let order = chain(&lines, Point::new(0, 0));
        assert_eq!(order.iter().map(|o| o.0).collect::<Vec<_>>(), [0, 1, 2, 3]);
        assert_eq!(
            order.iter().map(|o| o.1).collect::<Vec<_>>(),
            [false, true, false, true]
        );
    }

    #[test]
    fn the_start_picks_the_end_to_begin_at() {
        let lines = vec![seg(0, 0, 1000, 0), seg(0, 100, 1000, 100)];
        let order = chain(&lines, Point::new(1100, 0));
        assert_eq!(order, [(0, true), (1, false)]);
    }

    #[test]
    fn a_path_that_cannot_reverse_is_not_reversed() {
        let mut lines = vec![seg(0, 0, 1000, 0), seg(1000, 100, 0, 100)];
        lines[1].reversible = false;
        let order = chain(&lines, Point::new(0, 0));
        assert!(order.iter().all(|&(i, r)| i != 1 || !r));
        assert_eq!(order.len(), 2);
    }

    #[test]
    fn every_entity_appears_once() {
        let lines: Vec<Ent> = (0..50)
            .map(|k| seg((k * 37) % 500, (k * 91) % 500, (k * 53) % 500, (k * 17) % 500))
            .collect();
        let mut seen: Vec<usize> = chain(&lines, Point::new(250, 250)).iter().map(|o| o.0).collect();
        seen.sort_unstable();
        assert_eq!(seen, (0..50).collect::<Vec<_>>());
    }
}
