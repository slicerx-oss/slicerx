// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Print order of an island's variable-width walls. Follows Orca 2.4.2's
//! `WallToolPaths::getRegionOrder` and the topological walk in `PerimeterGenerator::process_arachne`:
//! two walls whose junctions lie within 1.9 bead widths of each other and whose insets differ by one
//! must print in the wall sequence's order, a middle (odd) bead after the even wall outside it, and
//! among the walls free to print next the one starting nearest to where the last one ended goes
//! first. Sorting by inset alone printed every wall of one depth across the island before the next
//! depth, so a ring with a hole crossed between the outline and the hole once per wall.

use crate::fm::Fm as _;
use std::collections::{HashMap, HashSet};

use super::WallLine;

/// How much farther apart two junctions of adjacent walls may be than their half widths, for corners.
const DIAGONAL_EXTENSION: f64 = 1.9;

/// The order to print `lines` in. `outer_to_inner` puts the outer wall before the walls inside it.
pub(crate) fn wall_order(lines: &[WallLine], outer_to_inner: bool) -> Vec<usize> {
    // Orca lists the walls from the first inset to print to the last, each inset in generation order.
    let max_inset = lines.iter().map(|l| l.inset).max().unwrap_or(0);
    let mut all: Vec<usize> = Vec::with_capacity(lines.len());
    for k in 0..=max_inset {
        let inset = if outer_to_inner { k } else { max_inset - k };
        all.extend((0..lines.len()).filter(|&i| lines.get(i).is_some_and(|l| l.inset == inset)));
    }
    let line = |slot: usize| all.get(slot).and_then(|&i| lines.get(i));

    let mut blocked = vec![0_usize; all.len()];
    let mut blocking: Vec<Vec<usize>> = vec![Vec::new(); all.len()];
    for (before, after) in constraints(&all, lines, outer_to_inner) {
        if let Some(b) = blocked.get_mut(after) {
            *b += 1;
        }
        if let Some(v) = blocking.get_mut(before) {
            v.push(after);
        }
    }

    let mut processed = vec![false; all.len()];
    let mut order = Vec::with_capacity(all.len());
    let mut here = line(0).and_then(|l| l.points.first().copied());
    while order.len() < all.len() {
        // Open lines are considered first; a closed one wins only when strictly nearer.
        let mut free: Vec<usize> = (0..all.len())
            .filter(|&s| {
                !processed.get(s).copied().unwrap_or(true) && blocked.get(s).copied().unwrap_or(0) == 0
            })
            .collect();
        if free.is_empty() {
            // A cycle of constraints (not expected): take the first wall left.
            free.extend(
                (0..all.len())
                    .filter(|&s| !processed.get(s).copied().unwrap_or(true))
                    .take(1),
            );
        }
        crate::sorting::sort_by_key(&mut free, |&s| line(s).is_some_and(|l| l.closed));
        let mut best: Option<(usize, f64, bool)> = None;
        for &s in &free {
            let Some(l) = line(s) else { continue };
            let Some(start) = l.points.first() else {
                if best.is_none() {
                    best = Some((s, f64::MAX, l.closed));
                }
                continue;
            };
            let d = here.map_or(0.0, |h| {
                let (dx, dy) = (
                    f64::from(h.x) - f64::from(start.x),
                    f64::from(h.y) - f64::from(start.y),
                );
                dx.m_hypot(dy)
            });
            let best_d = best.map_or(f64::MAX, |b| b.1);
            if d < best_d {
                let best_closed = best.is_some_and(|b| b.2);
                if l.closed || best_d < f64::MAX || !best_closed {
                    best = Some((s, d, l.closed));
                }
            }
        }
        let Some((s, _, _)) = best else { break };
        if let Some(p) = processed.get_mut(s) {
            *p = true;
        }
        for &u in blocking.get(s).map_or(&[][..], Vec::as_slice) {
            if let Some(b) = blocked.get_mut(u) {
                *b = b.saturating_sub(1);
            }
        }
        if let Some(l) = line(s) {
            let end = if l.closed {
                l.points.first()
            } else {
                l.points.last()
            };
            if let Some(p) = end {
                here = Some(*p);
            }
        }
        if let Some(&i) = all.get(s) {
            order.push(i);
        }
    }
    order
}

/// The (before, after) pairs of slots in `all` that must keep their order.
#[allow(
    clippy::cast_possible_truncation,
    reason = "grid cell indices of coordinates in range"
)]
fn constraints(all: &[usize], lines: &[WallLine], outer_to_inner: bool) -> HashSet<(usize, usize)> {
    let mut out = HashSet::new();
    let max_w = all
        .iter()
        .filter_map(|&i| lines.get(i))
        .flat_map(|l| l.widths.iter().copied())
        .max()
        .unwrap_or(0);
    if max_w <= 0 {
        return out;
    }
    let radius = f64::from(max_w) * DIAGONAL_EXTENSION;
    let cell_of = |x: i32| -> i64 { (f64::from(x) / radius).floor() as i64 };
    let mut grid: HashMap<(i64, i64), Vec<(usize, usize)>> = HashMap::new();
    for (s, l) in all
        .iter()
        .enumerate()
        .filter_map(|(s, &i)| lines.get(i).map(|l| (s, l)))
    {
        for (j, p) in l.points.iter().enumerate() {
            grid.entry((cell_of(p.x), cell_of(p.y))).or_default().push((s, j));
        }
    }
    let at = |s: usize| all.get(s).and_then(|&i| lines.get(i));
    for (s, l) in all
        .iter()
        .enumerate()
        .filter_map(|(s, &i)| lines.get(i).map(|l| (s, l)))
    {
        for (j, p) in l.points.iter().enumerate() {
            let w = l.widths.get(j).copied().unwrap_or(0);
            let (cx, cy) = (cell_of(p.x), cell_of(p.y));
            for gx in cx - 1..=cx + 1 {
                for gy in cy - 1..=cy + 1 {
                    let Some(cell) = grid.get(&(gx, gy)) else { continue };
                    for &(t, k) in cell {
                        if t == s {
                            continue;
                        }
                        let Some(n) = at(t) else { continue };
                        if n.inset == l.inset || n.inset > l.inset + 1 || l.inset > n.inset + 1 {
                            continue;
                        }
                        let Some(q) = n.points.get(k) else { continue };
                        let nw = n.widths.get(k).copied().unwrap_or(0);
                        let (dx, dy) = (f64::from(p.x) - f64::from(q.x), f64::from(p.y) - f64::from(q.y));
                        let reach = f64::midpoint(f64::from(w), f64::from(nw)) * DIAGONAL_EXTENSION;
                        if dx.m_hypot(dy) >= reach || dx.m_hypot(dy) >= radius {
                            continue;
                        }
                        if l.is_odd || n.is_odd {
                            if l.is_odd && !n.is_odd && n.inset < l.inset {
                                out.insert((t, s));
                            }
                            if n.is_odd && !l.is_odd && l.inset < n.inset {
                                out.insert((s, t));
                            }
                        } else if (n.inset < l.inset) == outer_to_inner {
                            out.insert((t, s));
                        } else {
                            out.insert((s, t));
                        }
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::cast_possible_truncation, reason = "test rings")]
mod tests {
    use super::*;
    use i_overlay::i_float::int::point::IntPoint;

    fn ring(inset: usize, cx: i32, r: i32, hole: bool) -> WallLine {
        let mut points: Vec<IntPoint<i32>> = (0..16)
            .map(|k| {
                let a = f64::from(k) * std::f64::consts::TAU / 16.0;
                IntPoint::new(
                    cx + (f64::from(r) * a.m_cos()) as i32,
                    (f64::from(r) * a.m_sin()) as i32,
                )
            })
            .collect();
        if hole {
            points.reverse();
        }
        points.push(points[0]);
        let n = points.len();
        WallLine {
            inset,
            is_odd: false,
            closed: true,
            points,
            widths: vec![4200; n],
        }
    }

    #[test]
    fn walls_of_a_ring_print_side_by_side_not_depth_by_depth() {
        // Outline walls at radius 100, 95.8 and 91.6 (0.1 um units scaled), hole walls at 50, 54.2 and 58.4.
        let s = 1000;
        let lines = vec![
            ring(0, 0, 100 * s, false),
            ring(0, 0, 50 * s, true),
            ring(1, 0, 100 * s - 4200, false),
            ring(1, 0, 50 * s + 4200, true),
            ring(2, 0, 100 * s - 8400, false),
            ring(2, 0, 50 * s + 8400, true),
        ];
        let order = wall_order(&lines, false);
        // Inner first: each side finishes its walls inside out before the other side starts.
        let insets: Vec<(usize, bool)> = order.iter().map(|&i| (lines[i].inset, i % 2 == 1)).collect();
        assert_eq!(insets.len(), 6);
        let first_side = insets[0].1;
        assert!(insets[..3].iter().all(|x| x.1 == first_side), "{insets:?}");
        assert_eq!(
            insets.iter().map(|x| x.0).collect::<Vec<_>>(),
            vec![2, 1, 0, 2, 1, 0]
        );
        let outer_first = wall_order(&lines, true);
        let insets: Vec<usize> = outer_first.iter().map(|&i| lines[i].inset).collect();
        assert_eq!(insets, vec![0, 1, 2, 0, 1, 2]);
    }

    #[test]
    fn a_middle_bead_follows_the_walls_beside_it() {
        let s = 1000;
        let mut odd = ring(1, 0, 100 * s - 4200, false);
        odd.is_odd = true;
        odd.closed = false;
        odd.points.pop();
        odd.widths.pop();
        let lines = vec![odd, ring(0, 0, 100 * s, false)];
        assert_eq!(wall_order(&lines, false), vec![1, 0]);
        assert_eq!(wall_order(&lines, true), vec![1, 0]);
    }
}
