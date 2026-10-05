// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Walls of islands that are thick everywhere, without the skeleton.
//!
//! Where an island is thicker than the full bead count everywhere, the variable-width generator gives
//! every wall its full bead count and its nominal width all the way round, and each wall is the set of
//! points at its bead's center distance from the outline: sharp at convex corners, an arc round concave
//! ones. Building the Voronoi diagram and the skeleton for such an island (most islands of most layers)
//! only finds that out. This module checks the condition with offsets and then writes each wall as the
//! outline moved in by that distance with round joins, with the bead centers and widths of the same
//! beading strategy.
//!
//! The check is conservative. No convex corner may be sharper than [`SHARPEST_CORNER`]. The island shrunk
//! by half the needed thickness and grown back (both with mitered corners, which give convex corners back
//! whole) must have the same islands and holes, and what it leaves out of the island may only be slivers
//! the rounding of the offsets leaves along the outline, or bumps of the outline shallower than half the
//! smallest printable feature. A thin neck, rib or slot loses a piece that reaches deeper than that.
//! Anything else takes the skeleton.

use super::beading::Strategy;
use super::graph::{Junction, P};
use super::skeleton::Line;
use super::{InsetsAndContour, NM_PER_UNIT, to_units};
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

/// Convex corners sharper than this (radians, the interior angle) take the skeleton.
const SHARPEST_CORNER: f64 = std::f64::consts::FRAC_PI_3;

/// The largest mean thickness (units) of a piece the opening may leave out: two rounding steps.
const SLIVER: f64 = 2.0;

/// The walls (per inset) and the inner contour of the prepared `shapes`, or `None` when an island is not
/// thick enough everywhere. `max_beads` is the bead count across (two per wall), `inner_width` the
/// inner bead width and `bump` the depth of outline bumps that do not count as thin parts, nm.
pub(super) fn walls(
    shapes: &[Vec<Vec<P>>],
    strat: &dyn Strategy,
    max_beads: i64,
    inner_width: i64,
    bump: i64,
) -> Option<InsetsAndContour> {
    if max_beads < 2 || max_beads % 2 != 0 {
        return None;
    }
    let units: Shapes = shapes
        .iter()
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.iter()
                .map(|r| r.iter().map(|p| to_units(*p)).collect())
                .collect()
        })
        .collect();
    if units.is_empty() || units.iter().flatten().any(|r| r.len() < 3 || has_sharp_corner(r)) {
        return None;
    }
    // Thick enough: past the thickness where the bead count goes over the full count (the walls then stop
    // and the infill area starts), with another bead width to spare, so no part of the skeleton's middle
    // takes fewer beads and no transition starts.
    let needed = strat.transition_thickness(max_beads) + inner_width;
    // Rounded up to whole units (`div_ceil` on signed integers is not stable on every toolchain we build with).
    let radius = i32::try_from((needed + 2 * NM_PER_UNIT - 1) / (2 * NM_PER_UNIT)).ok()?;
    if !keeps_shape(&units, radius, i32::try_from(bump / NM_PER_UNIT).ok()?) {
        return None;
    }

    // The beads of a very thick island: the walls from the outline inward, then a zero-width bead where
    // the infill area starts.
    let beading = strat.compute(needed * 4, max_beads + 1);
    let half = usize::try_from(max_beads / 2).ok()?;
    if beading.bead_widths.get(half) != Some(&0) || beading.bead_widths.iter().take(half).any(|&w| w <= 0) {
        return None;
    }
    let mut insets: Vec<Vec<Line>> = Vec::with_capacity(half);
    for k in 0..half {
        let (d, w) = (*beading.toolpath_locations.get(k)?, *beading.bead_widths.get(k)?);
        let rings = moved_in(&units, d)?;
        if rings.len() != units.iter().map(Vec::len).sum::<usize>() {
            return None;
        }
        let lines: Vec<Line> = rings
            .into_iter()
            .map(|ring| {
                // The skeleton's walls run the other way round from the outline (contours clockwise).
                let mut junctions: Vec<Junction> = ring
                    .into_iter()
                    .rev()
                    .map(|p| Junction {
                        p,
                        w,
                        perimeter_index: k,
                    })
                    .collect();
                if let Some(first) = junctions.first().copied() {
                    junctions.push(first);
                }
                Line {
                    inset_idx: k,
                    is_odd: false,
                    is_closed: true,
                    junctions,
                }
            })
            .collect();
        insets.push(lines);
    }
    let contour = moved_in(&units, *beading.toolpath_locations.get(half)?)?;
    Some((insets, contour))
}

/// Whether `units` opened by a disk of `radius` (mitered) keeps its islands and holes and loses only
/// rounding slivers, or pieces that lie within `bump` of the outline: bumps of a rough outline (a mesh
/// from a scan or an implicit surface) too shallow to hold a bead, which the skeleton follows the same
/// way the offsets do.
fn keeps_shape(units: &Shapes, radius: i32, bump: i32) -> bool {
    let shrunk = perimeters::offset(units, -radius);
    if shrunk.len() != units.len() || ring_count(&shrunk) != ring_count(units) {
        return false;
    }
    let opened = perimeters::offset(&shrunk, radius);
    if opened.len() != units.len() || ring_count(&opened) != ring_count(units) {
        return false;
    }
    let sliver = |piece: &Vec<Vec<IntPoint<i32>>>| area(piece) <= SLIVER / 2.0 * perimeter(piece);
    let lost: Shapes = perimeters::difference(units, &opened)
        .into_iter()
        .filter(|p| !sliver(p))
        .collect();
    if lost.is_empty() || bump <= 0 {
        return lost.is_empty();
    }
    perimeters::intersection(&lost, &perimeters::offset(units, -bump))
        .iter()
        .all(sliver)
}

fn ring_count(s: &Shapes) -> usize {
    s.iter().map(Vec::len).sum()
}

/// The rings of `shapes` moved in by `d` nm with round joins (the points at that distance from the
/// outline), in nm.
fn moved_in(shapes: &Shapes, d: i64) -> Option<Vec<Vec<P>>> {
    #[allow(clippy::cast_possible_truncation, reason = "a wall distance in units")]
    let delta = (d as f64 / NM_PER_UNIT as f64).round() as i32;
    // Arcs to the chord error of the brim's round offsets (0.0125 mm); shallow corners stay one point.
    let moved = if delta > 0 {
        perimeters::shrink_round_coarse(shapes, delta, 125.0)
    } else {
        shapes.clone()
    };
    let rings: Vec<Vec<P>> = moved
        .iter()
        .flatten()
        .filter(|r| r.len() >= 3)
        .map(|r| {
            r.iter()
                .map(|q| P::new(i64::from(q.x) * NM_PER_UNIT, i64::from(q.y) * NM_PER_UNIT))
                .collect()
        })
        .collect();
    (!rings.is_empty()).then_some(rings)
}

/// A convex corner (the inside on the left) with an interior angle under [`SHARPEST_CORNER`].
fn has_sharp_corner(ring: &[IntPoint<i32>]) -> bool {
    use crate::fm::Fm as _;
    let n = ring.len();
    (0..n).any(|i| {
        let (a, b, c) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
        let (ux, uy) = (f64::from(a.x) - f64::from(b.x), f64::from(a.y) - f64::from(b.y));
        let (vx, vy) = (f64::from(c.x) - f64::from(b.x), f64::from(c.y) - f64::from(b.y));
        // Turning left at b (counter-clockwise outer, clockwise holes alike) is a convex corner.
        let cross = -ux * vy + uy * vx;
        if cross <= 0.0 {
            return false;
        }
        let angle = (ux * vy - uy * vx).abs().m_atan2(ux * vx + uy * vy);
        angle < SHARPEST_CORNER
    })
}

fn area(rings: &[Vec<IntPoint<i32>>]) -> f64 {
    #[allow(clippy::cast_precision_loss, reason = "areas in units squared")]
    rings
        .iter()
        .map(|r| crate::geom::area2_int(r) as f64 / 2.0)
        .sum::<f64>()
        .abs()
}

fn perimeter(rings: &[Vec<IntPoint<i32>>]) -> f64 {
    use crate::fm::Fm as _;
    rings
        .iter()
        .map(|r| {
            let n = r.len();
            (0..n)
                .map(|i| {
                    let (a, b) = (r[i], r[(i + 1) % n]);
                    (f64::from(b.x) - f64::from(a.x)).m_hypot(f64::from(b.y) - f64::from(a.y))
                })
                .sum::<f64>()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::super::{
        Params, max_beads, plain_bump, prepared_outline, simplify_insets, skeleton_walls, strategy, to_nm,
    };
    use super::*;
    use crate::fm::Fm as _;

    /// A point in units from mm.
    fn pt(x: f64, y: f64) -> IntPoint<i32> {
        IntPoint::new((x * 10_000.0).round() as i32, (y * 10_000.0).round() as i32)
    }

    /// A regular polygon, counter-clockwise (an outline) or clockwise (a hole).
    fn circle(cx: f64, cy: f64, r: f64, n: usize, ccw: bool) -> Vec<IntPoint<i32>> {
        let mut c: Vec<IntPoint<i32>> = (0..n)
            .map(|i| {
                let (s, co) = (std::f64::consts::TAU * i as f64 / n as f64).m_sin_cos();
                pt(cx + r * co, cy + r * s)
            })
            .collect();
        if !ccw {
            c.reverse();
        }
        c
    }

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<IntPoint<i32>> {
        vec![pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)]
    }

    /// A bar of `w` by `l` mm centered on the origin, turned by `a` radians.
    fn bar(w: f64, l: f64, a: f64) -> Vec<IntPoint<i32>> {
        let (s, c) = a.m_sin_cos();
        [
            (-l / 2.0, -w / 2.0),
            (l / 2.0, -w / 2.0),
            (l / 2.0, w / 2.0),
            (-l / 2.0, w / 2.0),
        ]
        .iter()
        .map(|&(x, y)| pt(x * c - y * s, x * s + y * c))
        .collect()
    }

    fn seg_dist2(p: P, a: P, b: P) -> f64 {
        let (dx, dy) = ((b.x - a.x) as f64, (b.y - a.y) as f64);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 {
            (((p.x - a.x) as f64 * dx + (p.y - a.y) as f64 * dy) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (qx, qy) = (a.x as f64 + t * dx - p.x as f64, a.y as f64 + t * dy - p.y as f64);
        qx * qx + qy * qy
    }

    /// The largest squared distance from a junction of `a` to the lines of `b`.
    fn farthest2(a: &[Line], b: &[Line]) -> f64 {
        a.iter()
            .flat_map(|l| l.junctions.iter())
            .map(|j| {
                b.iter()
                    .flat_map(|l| l.junctions.windows(2))
                    .map(|w| seg_dist2(j.p, w[0].p, w[1].p))
                    .fold(f64::MAX, f64::min)
            })
            .fold(0.0, f64::max)
    }

    /// Runs both paths on `shape`; `None` when the island does not take the fast path. Panics when the fast
    /// path's walls differ from the skeleton's in line count or bead width, or lie more than 0.05 mm off.
    fn compare(shape: Vec<Vec<IntPoint<i32>>>, prm: &Params, what: &str) -> Option<()> {
        let prepared = prepared_outline(&vec![shape], prm);
        let (strat, st) = strategy(prm);
        let (mut fast, _) = walls(
            &prepared,
            &*strat,
            max_beads(prm),
            to_nm(prm.bead_width_x),
            plain_bump(prm),
        )?;
        let (mut slow, _) = skeleton_walls(&prepared, prm, &*strat, &st).expect("the skeleton's walls");
        simplify_insets(&mut fast, prm);
        simplify_insets(&mut slow, prm);
        assert_eq!(fast.len(), slow.len(), "{what}: insets");
        for (k, (a, b)) in fast.iter().zip(&slow).enumerate() {
            assert_eq!(a.len(), b.len(), "{what}: lines of inset {k}");
            assert!(
                b.iter().all(|l| !l.is_odd),
                "{what}: the skeleton has a gap fill line in inset {k}"
            );
            let w = a[0].junctions[0].w;
            assert!(
                a.iter()
                    .chain(b)
                    .flat_map(|l| l.junctions.iter())
                    .all(|j| (j.w - w).abs() <= to_nm(0.001)),
                "{what}: bead widths of inset {k}"
            );
            let far = farthest2(a, b).max(farthest2(b, a));
            assert!(
                far <= (to_nm(0.05) as f64).m_powi(2),
                "{what}: inset {k} is {:.1} um off",
                far.sqrt() / 1000.0
            );
        }
        Some(())
    }

    #[test]
    fn thick_islands_take_the_fast_path_with_the_skeletons_walls() {
        let x_mark = perimeters::union_all(&[
            &vec![vec![bar(6.0, 40.0, std::f64::consts::FRAC_PI_4)]],
            &vec![vec![bar(6.0, 40.0, -std::f64::consts::FRAC_PI_4)]],
        ]);
        let mut plate = vec![rect(0.0, 0.0, 60.0, 40.0)];
        for i in 0..4 {
            for j in 0..2 {
                plate.push(circle(
                    10.0 + 13.0 * f64::from(i),
                    12.0 + 16.0 * f64::from(j),
                    3.0,
                    64,
                    false,
                ));
            }
        }
        let bracket = vec![vec![
            pt(0.0, 0.0),
            pt(30.0, 0.0),
            pt(30.0, 8.0),
            pt(8.0, 8.0),
            pt(8.0, 30.0),
            pt(0.0, 30.0),
        ]];
        let ring = vec![
            circle(0.0, 0.0, 20.0, 180, true),
            circle(0.0, 0.0, 12.0, 120, false),
        ];
        for inset_count in [2, 3, 4] {
            let prm = Params {
                inset_count,
                bead_width_0: 0.42,
                bead_width_x: 0.45,
                athena: Some((0.38, 0.41)),
                ..Params::default()
            };
            let thick = [
                ("drum", vec![circle(0.0, 0.0, 60.0, 360, true)]),
                ("x-mark", x_mark[0].clone()),
                ("plate with holes", plate.clone()),
                ("bracket", bracket.clone()),
                ("ring", ring.clone()),
            ];
            for (what, shape) in thick {
                assert!(
                    compare(shape, &prm, what).is_some(),
                    "{what} with {inset_count} walls took the skeleton"
                );
            }
            // Thin somewhere: a bar narrower than the walls, a ring with a thin wall, a sharp spike.
            let thin = [
                ("thin bar", vec![rect(0.0, 0.0, 1.0, 20.0)]),
                (
                    "thin ring",
                    vec![
                        circle(0.0, 0.0, 20.0, 180, true),
                        circle(0.0, 0.0, 19.0, 180, false),
                    ],
                ),
                (
                    "spike",
                    vec![vec![
                        pt(0.0, 0.0),
                        pt(20.0, 0.0),
                        pt(20.0, 10.0),
                        pt(10.0, 3.0),
                        pt(0.0, 10.0),
                    ]],
                ),
            ];
            for (what, shape) in thin {
                assert!(
                    compare(shape, &prm, what).is_none(),
                    "{what} with {inset_count} walls took the fast path"
                );
            }
        }
    }
}
