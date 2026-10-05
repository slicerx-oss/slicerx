// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Extra perimeters on overhangs (`extra_perimeters_on_overhangs`): where the infill area of a layer hangs
//! over air and a bridge could not be anchored, it is filled with overhang wall loops that grow out from
//! the supported side, each one resting on the last, and the infill there goes.
//!
//! Our implementation of `OrcaSlicer` 2.4.2's `generate_extra_perimeters_over_overhangs`,
//! `sort_extra_perimeters`, `reconnect_polylines` and `paths_touch` (`PerimeterGenerator.cpp`), with the
//! floating-edge cost of `detect_bridging_direction` (`BridgeDetector.hpp`). `PrusaSlicer` has the same
//! algorithm; Bambu Studio has none.

use crate::fm::Fm as _;
use crate::overhang::Support;
use crate::perimeters::{self, Shapes};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::i_float::int::point::IntPoint;
use i_overlay::string::clip::{ClipRule, IntClip};
use std::collections::BTreeSet;

type Pt = IntPoint<i32>;

/// Orca `EXTERNAL_INFILL_MARGIN`, mm.
const EXTERNAL_INFILL_MARGIN: f64 = 3.0;
/// Orca `SCALED_EPSILON` in internal units (100 nm).
const SCALED_EPSILON: i32 = 1;

fn sub(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() || b.is_empty() {
        a.clone()
    } else {
        perimeters::difference(a, b)
    }
}

fn meet(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() || b.is_empty() {
        Vec::new()
    } else {
        perimeters::intersection(a, b)
    }
}

fn grow(s: &Shapes, d: i32) -> Shapes {
    if s.is_empty() || d == 0 {
        s.clone()
    } else {
        perimeters::offset(s, d)
    }
}

/// The part of the polylines inside (or outside, `invert`) the shapes.
fn clip_lines(lines: &[Vec<Pt>], by: &Shapes, invert: bool) -> Vec<Vec<Pt>> {
    if lines.is_empty() {
        return Vec::new();
    }
    if by.is_empty() {
        return if invert { lines.to_vec() } else { Vec::new() };
    }
    by.clip_paths(
        lines,
        FillRule::NonZero,
        ClipRule {
            invert,
            boundary_included: true,
        },
    )
    .into_iter()
    .filter(|p| p.len() >= 2)
    .collect()
}

/// Every ring as a closed polyline (first point repeated), Orca `to_polylines`.
fn rings(s: &Shapes) -> Vec<Vec<Pt>> {
    s.iter()
        .flat_map(|sh| sh.iter())
        .filter(|r| r.len() >= 2)
        .map(|r| {
            let mut p = r.clone();
            p.push(r[0]);
            p
        })
        .collect()
}

fn d2(a: Pt, b: Pt) -> f64 {
    let (dx, dy) = (f64::from(a.x) - f64::from(b.x), f64::from(a.y) - f64::from(b.y));
    dx * dx + dy * dy
}

fn length(p: &[Pt]) -> f64 {
    p.windows(2).map(|w| d2(w[0], w[1]).sqrt()).sum()
}

#[allow(clippy::cast_precision_loss, reason = "areas of one layer")]
fn area(s: &Shapes) -> f64 {
    s.iter()
        .flat_map(|sh| sh.iter())
        .map(|r| crate::geom::area2_int(r) as f64 / 2.0)
        .sum()
}

/// Orca `detect_bridging_direction(to_cover, anchors)`, the cost only: the length of the floating edges
/// (the outline of what the anchors leave uncovered, outside the anchors) measured across the best bridge
/// direction. Zero when nothing floats.
fn unsupported_distance(to_cover: &Shapes, anchors: &Shapes) -> f64 {
    let overhang = sub(to_cover, anchors);
    let floating: Vec<[Pt; 2]> = clip_lines(&rings(&overhang), &grow(anchors, SCALED_EPSILON), true)
        .iter()
        .flat_map(|p| p.windows(2).map(|w| [w[0], w[1]]).collect::<Vec<_>>())
        .collect();
    if floating.is_empty() {
        return 0.0;
    }
    let mut normals: Vec<(i64, (f64, f64))> = Vec::new();
    for l in &floating {
        let (dx, dy) = (f64::from(l[1].x - l[0].x), f64::from(l[1].y - l[0].y));
        let len = dx.m_hypot(dy);
        if len == 0.0 {
            continue;
        }
        // Orca's `Line::normal` is (dy, -dx).
        let n = (dy / len, -dx / len);
        #[allow(clippy::cast_possible_truncation, reason = "a key for equal angles")]
        let key = (n.1.m_atan2(n.0) * 1000.0).ceil() as i64;
        if !normals.iter().any(|(k, _)| *k == key) {
            normals.push((key, n));
        }
    }
    normals
        .iter()
        .map(|(_, n)| {
            floating
                .iter()
                .map(|l| (f64::from(l[1].x - l[0].x) * n.0 + f64::from(l[1].y - l[0].y) * n.1).abs())
                .sum::<f64>()
        })
        .fold(f64::MAX, f64::min)
}

/// Orca `reconnect_polylines`: polylines whose ends meet within `limit` are joined, each with the later
/// ones in order. The result keeps the input order (Orca's comes out in its hash map's order).
fn reconnect(lines: Vec<Vec<Pt>>, limit: f64) -> Vec<Vec<Pt>> {
    let lim2 = limit * limit;
    let mut slots: Vec<Option<Vec<Pt>>> = lines.into_iter().map(|l| (!l.is_empty()).then_some(l)).collect();
    for a in 0..slots.len() {
        if slots[a].is_none() {
            continue;
        }
        for b in a + 1..slots.len() {
            let Some(next) = slots[b].take() else { continue };
            let Some(base) = slots[a].as_mut() else { break };
            let (bf, bl) = (base[0], base[base.len() - 1]);
            let (nf, nl) = (next[0], next[next.len() - 1]);
            if d2(bl, nf) < lim2 {
                base.extend(next);
            } else if d2(bl, nl) < lim2 {
                base.extend(next.into_iter().rev());
            } else if d2(bf, nl) < lim2 {
                let mut joined = next;
                joined.extend(base.iter().copied());
                joined.reverse();
                *base = joined;
            } else if d2(bf, nf) < lim2 {
                base.reverse();
                base.extend(next);
                base.reverse();
            } else {
                slots[b] = Some(next);
            }
        }
    }
    slots.into_iter().flatten().collect()
}

/// Orca `paths_touch`: some point of either path lies within `limit` of the other path's lines.
fn touch(a: &[Pt], b: &[Pt], limit: f64) -> bool {
    let near = |p: Pt, path: &[Pt]| {
        path.windows(2)
            .any(|w| crate::overhang::seg_dist2(p, &[w[0], w[1]]) < limit * limit)
            || (path.len() == 1 && d2(p, path[0]) < limit * limit)
    };
    a.iter().any(|&p| near(p, b)) || b.iter().any(|&p| near(p, a))
}

/// Orca `sort_extra_perimeters`: anchored paths first, each unanchored one after a path it touches, nearest
/// end next; paths that end within two spacings of the next one's start are joined, and paths no longer
/// than three spacings are dropped.
fn sort(paths: &[Vec<Pt>], first_unanchored: usize, spacing: f64) -> Vec<Vec<Pt>> {
    let Some(first) = paths.first() else {
        return Vec::new();
    };
    let n = paths.len();
    // `usize::MAX` stands for Orca's "printed" marker in a dependency set.
    let mut deps: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
    for i in 0..n {
        for j in 0..i {
            if touch(&paths[i], &paths[j], spacing * 1.5) {
                deps[i].insert(j);
            }
        }
    }
    let mut processed = vec![false; n];
    for p in processed.iter_mut().take(first_unanchored) {
        *p = true;
    }
    for _ in first_unanchored..n {
        let mut change = false;
        for i in first_unanchored..n {
            if processed[i] || !deps[i].iter().any(|&d| d != usize::MAX && processed[d]) {
                continue;
            }
            let list: Vec<usize> = deps[i].iter().copied().collect();
            for d in list {
                if d != usize::MAX && !processed[d] {
                    deps[d].insert(i);
                    deps[i].remove(&d);
                }
            }
            processed[i] = true;
            change = true;
        }
        if !change {
            break;
        }
    }
    let mut current = first[0];
    let mut sorted: Vec<Vec<Pt>> = Vec::new();
    loop {
        let mut best: Option<(f64, usize, bool)> = None;
        for (i, p) in paths.iter().enumerate() {
            if !deps[i].is_empty() {
                continue;
            }
            let (a, b) = (d2(p[0], current), d2(p[p.len() - 1], current));
            if best.is_none_or(|(d, _, _)| a < d) {
                best = Some((a, i, false));
            }
            if best.is_none_or(|(d, _, _)| b < d) {
                best = Some((b, i, true));
            }
        }
        let Some((_, i, rev)) = best else { break };
        let mut p = paths[i].clone();
        if rev {
            p.reverse();
        }
        current = p[p.len() - 1];
        sorted.push(p);
        deps[i].insert(usize::MAX);
        for d in &mut deps {
            d.remove(&i);
        }
    }
    let mut joined: Vec<Vec<Pt>> = Vec::with_capacity(sorted.len());
    for p in sorted {
        if let Some(last) = joined.last_mut()
            && d2(last[last.len() - 1], p[0]) < spacing * spacing * 4.0
        {
            last.extend(p);
        } else {
            joined.push(p);
        }
    }
    joined.retain(|p| length(p) > 3.0 * spacing);
    joined
}

/// The extra perimeters of one region's infill area: per overhang, the paths in print order, and the area
/// they fill (taken out of the infill). `lower` is the slice of the layer below, `width` and `spacing` the
/// overhang bead (Orca's bridging flow of the walls), internal units.
#[allow(
    clippy::cast_possible_truncation,
    clippy::too_many_lines,
    reason = "offsets in internal units"
)]
pub(crate) fn generate(
    infill: &Shapes,
    lower: &Shapes,
    wall_loops: u32,
    width: i32,
    spacing: i32,
) -> (Vec<Vec<Pt>>, Shapes) {
    let sp = f64::from(spacing);
    let anchors_size = (crate::geom::mm(EXTERNAL_INFILL_MARGIN))
        .min(spacing.saturating_mul(i32::try_from(wall_loops).unwrap_or(1) + 1));
    let overhangs = sub(infill, lower);
    if overhangs.is_empty() || area(&overhangs).abs() < 1.0 {
        return (Vec::new(), Vec::new());
    }
    let lower_support = Support::new(lower);
    let anchors = meet(infill, lower);
    let inset_anchors = sub(
        &anchors,
        &perimeters::offset_square(&overhangs, anchors_size + (0.1 * f64::from(width)) as i32),
    );
    let inset_overhang_area = sub(infill, &inset_anchors);
    let mut left_unfilled: Shapes = Vec::new();
    let mut extra: Vec<Vec<Pt>> = Vec::new();
    for overhang in perimeters::union_all(&[&inset_overhang_area]) {
        let to_cover: Shapes = vec![overhang];
        let expanded = grow(&to_cover, (1.1 * sp) as i32);
        let shrunk = grow(&to_cover, -(0.1 * sp) as i32);
        let real_overhang = meet(&to_cover, &overhangs);
        if real_overhang.is_empty() {
            left_unfilled.extend(to_cover);
            continue;
        }
        let anchoring = meet(&expanded, &inset_anchors);
        let mut perimeter_polygon = grow(
            &perimeters::union_all(&[&grow(&to_cover, (0.1 * sp) as i32), &anchoring]),
            -(sp * 0.6) as i32,
        );
        let hull_pts: Vec<Pt> = anchoring.iter().flatten().flatten().copied().collect();
        let hull = crate::session::convex_hull(hull_pts);
        let unbridgeable = if hull.len() >= 3 {
            area(&sub(&real_overhang, &vec![vec![hull]]))
        } else {
            area(&real_overhang)
        };
        let unsupported = unsupported_distance(&real_overhang, &anchors);
        let total_len: f64 = rings(&real_overhang).iter().map(|r| length(r)).sum();
        if unbridgeable < 0.2 * area(&real_overhang) && unsupported < total_len * 0.2 {
            // A bridge holds here.
            left_unfilled.extend(to_cover);
            continue;
        }
        let mut region: Vec<Vec<Pt>> = Vec::new();
        let mut continuation = 2i32;
        while continuation >= 0 {
            let prev = perimeter_polygon.clone();
            let perimeter = clip_lines(&rings(&perimeter_polygon), &shrunk, false);
            perimeter_polygon = perimeters::union_all(&[&perimeter_polygon, &anchoring]);
            perimeter_polygon = meet(&grow(&perimeter_polygon, -spacing), &expanded);
            if perimeter_polygon.is_empty() {
                // Too small for a whole loop: fill a gap of one bead first.
                let shrunk_prev = meet(&grow(&prev, -(0.3 * sp) as i32), &expanded);
                if !shrunk_prev.is_empty() {
                    region.extend(reconnect(perimeter, sp));
                }
                let gap = if shrunk_prev.is_empty() {
                    grow(&prev, (sp * 0.5) as i32)
                } else {
                    shrunk_prev
                };
                let mut fills: Vec<Vec<Pt>> = Vec::new();
                let scale = crate::geom::SCALE;
                for piece in &gap {
                    let one: Shapes = vec![piece.clone()];
                    for l in
                        crate::arachne::medial_lines(&one, 0.75 * f64::from(width) / scale, 3.0 * sp / scale)
                    {
                        fills.push(l.points);
                    }
                }
                if !fills.is_empty() {
                    region.extend(reconnect(clip_lines(&fills, &shrunk, false), sp));
                }
                break;
            }
            region.extend(reconnect(perimeter, sp));
            if meet(&perimeter_polygon, &real_overhang).is_empty() {
                continuation -= 1;
            }
            if prev == perimeter_polygon {
                break;
            }
        }
        perimeter_polygon = grow(&perimeter_polygon, (0.5 * sp) as i32);
        perimeter_polygon = perimeters::union_all(&[&perimeter_polygon, &anchoring]);
        left_unfilled.extend(perimeter_polygon);
        region.retain(|p| p.len() >= 2);
        if region.is_empty() {
            continue;
        }
        let front = &region[0];
        let closed_anchored = front.first() == front.last()
            && !clip_lines(std::slice::from_ref(front), lower, false).is_empty();
        if closed_anchored {
            // Start the closed first loop where it rests deepest on the layer below. Orca means to do the
            // same, but its comparison assigns a bool and ends up at the last point within 1 mm.
            let at = front
                .iter()
                .enumerate()
                .min_by(|a, b| {
                    lower_support
                        .signed_distance(*a.1)
                        .total_cmp(&lower_support.signed_distance(*b.1))
                })
                .map_or(0, |(i, _)| i);
            // The loop repeats its first point at the end: drop it, turn the ring, close it again.
            let mut ring = front[..front.len() - 1].to_vec();
            let turn = at.min(ring.len().saturating_sub(1));
            ring.rotate_left(turn);
            if let Some(&f) = ring.first() {
                ring.push(f);
            }
            region[0] = ring;
        } else {
            region.reverse();
        }
        let anchored = |p: &Vec<Pt>| {
            lower_support.signed_distance(p[0]) <= 0.0 || lower_support.signed_distance(p[p.len() - 1]) <= 0.0
        };
        let (mut yes, no): (Vec<Vec<Pt>>, Vec<Vec<Pt>>) = region.into_iter().partition(anchored);
        let first_unanchored = yes.len();
        yes.extend(no);
        extra.extend(sort(&yes, first_unanchored, sp));
    }
    let left = perimeters::union_all(&[&left_unfilled]);
    (extra, sub(&inset_overhang_area, &left))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        let m = crate::geom::mm;
        vec![vec![vec![
            Pt::new(m(x0), m(y0)),
            Pt::new(m(x1), m(y0)),
            Pt::new(m(x1), m(y1)),
            Pt::new(m(x0), m(y1)),
        ]]]
    }

    #[test]
    fn a_ledge_over_air_gets_loops_and_a_bridge_does_not() {
        let m = crate::geom::mm;
        // The infill area reaches 8 mm past the layer below on one side only: nothing anchors its far end.
        let (paths, filled) = generate(
            &rect(0.0, 0.0, 20.0, 10.0),
            &rect(0.0, 0.0, 12.0, 10.0),
            2,
            m(0.4),
            m(0.45),
        );
        assert!(!paths.is_empty());
        assert!(area(&filled) > 0.5 * 8.0 * 10.0 * 1e8, "{}", area(&filled) / 1e8);
        // Held on both sides, a bridge does it.
        let lower = perimeters::union_all(&[&rect(0.0, 0.0, 6.0, 10.0), &rect(14.0, 0.0, 20.0, 10.0)]);
        let (paths, filled) = generate(&rect(0.0, 0.0, 20.0, 10.0), &lower, 2, m(0.4), m(0.45));
        assert!(paths.is_empty() && filled.is_empty());
    }

    #[test]
    fn reconnect_joins_ends_in_order() {
        let p = |x: i32| Pt::new(x, 0);
        let out = reconnect(
            vec![vec![p(0), p(10)], vec![p(11), p(20)], vec![p(100), p(110)]],
            5.0,
        );
        assert_eq!(out, vec![vec![p(0), p(10), p(11), p(20)], vec![p(100), p(110)]]);
    }
}
