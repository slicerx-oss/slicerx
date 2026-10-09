// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Regions (stage 2, after cutting) and stage 3, perimeters: classic
//! fixed-width wall loops from inward offsets, on `i_overlay`.

use crate::fm::Fm as _;
use crate::geom::{Point, Polygon};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay::{IntOverlayOptions, Overlay};
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::core::solver::Solver;
use i_overlay::i_float::int::point::IntPoint;
use i_overlay::i_shape::int::shape::IntShapes;

/// Polygons with holes: each shape is an outer contour (counterclockwise)
/// followed by its holes (clockwise).
pub(crate) type Shapes = IntShapes<i32>;

/// Points closer than this to the previous one are dropped as slicing noise (0.01 mm).
const MIN_EDGE: i64 = 100;

fn to_int(poly: &[Point], resolution: i64) -> Vec<IntPoint<i32>> {
    let min_edge = MIN_EDGE.min(resolution * 4 / 5);
    let mut out: Vec<IntPoint<i32>> = Vec::with_capacity(poly.len());
    for p in poly {
        if let Some(last) = out.last() {
            let (dx, dy) = (i64::from(p.x - last.x), i64::from(p.y - last.y));
            if dx * dx + dy * dy < min_edge * min_edge {
                continue;
            }
        }
        out.push(IntPoint::new(p.x, p.y));
    }
    simplify_ring(&out, resolution)
}

/// Contour resolution, 0.0125 mm (Orca's `resolution` defaults to 0.012 mm).
const RESOLUTION: i64 = 125;

/// Douglas-Peucker on a closed ring: drops points closer than `tol` to the
/// chord between the points kept around them.
pub(crate) fn simplify_ring(c: &[IntPoint<i32>], tol: i64) -> Vec<IntPoint<i32>> {
    let n = c.len();
    if n < 4 {
        return c.to_vec();
    }
    // Twice the triangle area |(b - a) x (p - a)|: for one chord it orders
    // points by distance, and distance > tol means area2^2 > tol^2 * |b - a|^2.
    let area2 = |a: IntPoint<i32>, b: IntPoint<i32>, p: IntPoint<i32>| -> i64 {
        let (ax, ay) = (i64::from(b.x) - i64::from(a.x), i64::from(b.y) - i64::from(a.y));
        let (px, py) = (i64::from(p.x) - i64::from(a.x), i64::from(p.y) - i64::from(a.y));
        (ax * py - ay * px).abs()
    };
    let first = c.first().copied().unwrap_or_default();
    // Split the ring at the point farthest from the first one.
    let far = (1..n)
        .max_by_key(|&i| {
            c.get(i).map_or(0, |p| {
                let (dx, dy) = (i64::from(p.x - first.x), i64::from(p.y - first.y));
                dx * dx + dy * dy
            })
        })
        .unwrap_or(n / 2);
    let mut keep = vec![false; n];
    if let Some(k) = keep.get_mut(0) {
        *k = true;
    }
    if let Some(k) = keep.get_mut(far) {
        *k = true;
    }
    let tol2 = i128::from(tol) * i128::from(tol);
    let mut stack = vec![(0usize, far), (far, n)];
    while let Some((lo, hi)) = stack.pop() {
        if hi <= lo + 1 {
            continue;
        }
        let (Some(&a), Some(&b)) = (c.get(lo), c.get(hi % n)) else {
            continue;
        };
        let mut best = (0i64, lo);
        for i in lo + 1..hi {
            if let Some(&p) = c.get(i) {
                let d = area2(a, b, p);
                if d > best.0 {
                    best = (d, i);
                }
            }
        }
        let (dx, dy) = (
            i128::from(b.x) - i128::from(a.x),
            i128::from(b.y) - i128::from(a.y),
        );
        let far_enough = i128::from(best.0) * i128::from(best.0) > tol2 * (dx * dx + dy * dy);
        if far_enough {
            if let Some(k) = keep.get_mut(best.1) {
                *k = true;
            }
            stack.push((lo, best.1));
            stack.push((best.1, hi));
        }
    }
    c.iter()
        .zip(&keep)
        .filter(|(_, k)| **k)
        .map(|(p, _)| *p)
        .collect()
}

/// Cleans raw loops into shapes with the non-zero rule (overlapping loops of
/// one filament slot merge).
pub(crate) fn shapes_from_loops(loops: &[Polygon]) -> Shapes {
    shapes_from_loops_res(loops, RESOLUTION)
}

/// How the loops of a cut become areas (`slicing_mode`; Orca `MeshSlicingParams::SlicingMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Slicing {
    /// Loops keep their winding: counterclockwise ones fill, clockwise ones are holes (non-zero rule).
    Regular,
    /// Fill where an odd number of loops cover, whatever their winding.
    EvenOdd,
    /// Every loop is turned counterclockwise, so nested loops are filled and cavities close.
    CloseHoles,
}

/// [`shapes_from_loops_res`] for a slicing mode, with the gaps narrower than twice `closing` filled
/// (`slice_closing_radius`: Orca grows the union by the radius and shrinks it back).
pub(crate) fn shapes_from_loops_mode(
    loops: &[Polygon],
    resolution: i64,
    mode: Slicing,
    closing: i32,
) -> Shapes {
    let shapes = if mode == Slicing::Regular {
        shapes_from_loops_res(loops, resolution)
    } else {
        let mut contours: Vec<Vec<IntPoint<i32>>> = loops
            .iter()
            .map(|l| to_int(l, resolution))
            .filter(|c| c.len() >= 3)
            .collect();
        if mode == Slicing::CloseHoles {
            for c in &mut contours {
                if crate::geom::area2_int(c) < 0 {
                    c.reverse();
                }
            }
        }
        if contours.is_empty() {
            return Vec::new();
        }
        let rule = if mode == Slicing::EvenOdd {
            FillRule::EvenOdd
        } else {
            FillRule::NonZero
        };
        simplified(&contours, rule)
    };
    if closing > 0 && !shapes.is_empty() {
        // Orca then simplifies the contours (0.0025 mm), which also drops the vertices the offsets left on
        // straight edges.
        offset(&offset(&shapes, closing), -closing)
            .into_iter()
            .map(|s| s.into_iter().map(|r| simplify_ring(&r, 25)).collect())
            .collect()
    } else {
        shapes
    }
}

/// [`shapes_from_loops`] with a chosen contour resolution in internal units.
pub(crate) fn shapes_from_loops_res(loops: &[Polygon], resolution: i64) -> Shapes {
    let contours: Vec<Vec<IntPoint<i32>>> = loops
        .iter()
        .map(|l| to_int(l, resolution))
        .filter(|c| c.len() >= 3)
        .collect();
    if contours.is_empty() {
        return Vec::new();
    }
    if let Some(shapes) = nest_simple(&contours) {
        return shapes;
    }
    simplified(&contours, FillRule::NonZero)
}

/// Builds shapes straight from loops that do not touch each other: outer
/// loops (counterclockwise) and holes (clockwise), each hole going to the
/// smallest outer loop around it. `None` when the loops need a real union
/// (crossings, or a hole with no outer loop).
fn nest_simple(contours: &[Vec<IntPoint<i32>>]) -> Option<Shapes> {
    if any_crossing(contours) {
        return None;
    }
    let areas: Vec<i64> = contours.iter().map(|c| crate::geom::area2_int(c)).collect();
    let mut shapes: Shapes = Vec::new();
    let mut outer_of: Vec<(usize, i64)> = Vec::new();
    for (c, &a) in contours.iter().zip(&areas) {
        if a > 0 {
            outer_of.push((shapes.len(), a));
            shapes.push(vec![c.clone()]);
        } else if a == 0 {
            return None;
        }
    }
    let outers: Vec<&Vec<IntPoint<i32>>> = contours
        .iter()
        .zip(&areas)
        .filter(|(_, a)| **a > 0)
        .map(|(c, _)| c)
        .collect();
    for (c, &a) in contours.iter().zip(&areas) {
        if a >= 0 {
            continue;
        }
        let probe = *c.first()?;
        let owner = outers
            .iter()
            .zip(&outer_of)
            .filter(|(o, _)| point_in(o, probe))
            .min_by_key(|(_, (_, area))| *area)
            .map(|(_, (i, _))| *i)?;
        shapes.get_mut(owner)?.push(c.clone());
    }
    // A loop of one winding inside another of the same winding is an overlap.
    for (i, o) in outers.iter().enumerate() {
        let probe = *o.first()?;
        let depth = outers
            .iter()
            .enumerate()
            .filter(|(j, p)| *j != i && point_in(p, probe))
            .count();
        let holes = contours
            .iter()
            .zip(&areas)
            .filter(|(h, a)| **a < 0 && point_in(h, probe))
            .count();
        if depth != holes {
            return None;
        }
    }
    Some(shapes)
}

/// Even-odd point in polygon.
pub(crate) fn point_in(poly: &[IntPoint<i32>], p: IntPoint<i32>) -> bool {
    let n = poly.len();
    let mut inside = false;
    for i in 0..n {
        let (Some(a), Some(b)) = (poly.get(i), poly.get((i + 1) % n)) else {
            continue;
        };
        if (a.y > p.y) != (b.y > p.y) {
            let t = i64::from(p.y - a.y) * i64::from(b.x - a.x);
            let x = i64::from(a.x) + t / i64::from(b.y - a.y);
            if i64::from(p.x) < x {
                inside = !inside;
            }
        }
    }
    inside
}

/// `a` minus `b`.
pub(crate) fn difference(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() || b.is_empty() {
        return a.clone();
    }
    let solver = solver_for(edge_count(&[a, b]));
    Overlay::from_subj_and_clip_custom(a, b, IntOverlayOptions::default(), solver)
        .overlay(OverlayRule::Difference, FillRule::NonZero)
}

/// [`difference`] without the islands and holes smaller than `min_area` square units (see [`union_min_area`]).
pub(crate) fn difference_min_area(a: &Shapes, b: &Shapes, min_area: u64) -> Shapes {
    if a.is_empty() || b.is_empty() {
        return union_min_area(&[a], min_area);
    }
    let solver = solver_for(edge_count(&[a, b]));
    let options = IntOverlayOptions {
        min_output_area: min_area,
        ..IntOverlayOptions::default()
    };
    Overlay::from_subj_and_clip_custom(a, b, options, solver)
        .overlay(OverlayRule::Difference, FillRule::NonZero)
}

/// `a` minus a clip that lies apart from it: the same overlay as [`difference`] with no clip edges to split.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn difference_apart(a: &Shapes) -> Shapes {
    if a.is_empty() {
        return Vec::new();
    }
    let solver = solver_for(edge_count(&[a]));
    Overlay::from_subj_and_clip_custom(
        a,
        &Vec::<Vec<Vec<IntPoint<i32>>>>::new(),
        IntOverlayOptions::default(),
        solver,
    )
    .overlay(OverlayRule::Difference, FillRule::NonZero)
}

/// `a` clipped to `b`.
pub(crate) fn intersection(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let solver = solver_for(edge_count(&[a, b]));
    Overlay::from_subj_and_clip_custom(a, b, IntOverlayOptions::default(), solver)
        .overlay(OverlayRule::Intersect, FillRule::NonZero)
}

/// True when `a` and `b` share some area: the answer of `!intersection(a, b).is_empty()`. Exact integer
/// tests settle most cases without the overlay (see [`overlap_quick`]); the rest run the intersection.
pub(crate) fn overlap(a: &Shapes, b: &Shapes) -> bool {
    overlap_quick(a, b).unwrap_or_else(|| !intersection(a, b).is_empty())
}

type Seg = (IntPoint<i32>, IntPoint<i32>);

/// The edges of a ring, closing edge included.
fn ring_edges(r: &[IntPoint<i32>]) -> impl Iterator<Item = Seg> + '_ {
    r.iter().copied().zip(r.iter().copied().cycle().skip(1))
}

/// The winding number of `shapes` around `p`, for a point on none of their edges (exact).
fn winding(shapes: &Shapes, p: IntPoint<i32>) -> i64 {
    let mut w = 0;
    for r in shapes.iter().flatten() {
        if ring_bounds(r).is_none_or(|b| p.y < b[1] || p.y > b[3] || p.x > b[2]) {
            continue;
        }
        for (a, b) in ring_edges(r) {
            if a.y <= p.y {
                if b.y > p.y && orient(a, b, p) > 0 {
                    w += 1;
                }
            } else if b.y <= p.y && orient(a, b, p) < 0 {
                w -= 1;
            }
        }
    }
    w
}

/// [`overlap`] where exact tests decide it, `None` where only the overlay can. Both operands are read with
/// the nonzero rule, as the overlay reads them.
///
/// When no edge of `a` meets an edge of `b`, each ring lies wholly inside or wholly outside the other
/// operand's area (the winding number is constant along a path that crosses no edge), and the two areas
/// share a part exactly when the border of that part, made of whole rings, lies inside the other operand:
/// one point per ring decides it. With no crossing the overlay snaps nothing, so it keeps that part.
/// When edges meet, a point of `b` inside `a` with no edge of `a` within a few units shows a shared part
/// wide enough to survive the overlay's snapping of crossings to whole units.
fn overlap_quick(a: &Shapes, b: &Shapes) -> Option<bool> {
    // Units of clearance around the bounds of `b` and around a point taken as deep inside `a`.
    const MARGIN: i32 = 4;
    let Some(bb) = bounds(b) else {
        return Some(false);
    };
    // The edges of `a` that come within the margin of the bounds of `b`.
    let grown = Some([bb[0] - MARGIN, bb[1] - MARGIN, bb[2] + MARGIN, bb[3] + MARGIN]);
    let seg_bounds = |(p, q): Seg| Some([p.x.min(q.x), p.y.min(q.y), p.x.max(q.x), p.y.max(q.y)]);
    let close: Vec<Seg> = a
        .iter()
        .flatten()
        .filter(|r| overlaps(ring_bounds(r), grown))
        .flat_map(|r| ring_edges(r))
        .filter(|&s| overlaps(seg_bounds(s), grown))
        .collect();
    let met = b.iter().flatten().flat_map(|r| ring_edges(r)).any(|s| {
        close
            .iter()
            .any(|&c| overlaps(seg_bounds(c), seg_bounds(s)) && segments_touch(s.0, s.1, c.0, c.1))
    });
    if !met {
        let b_in_a = b
            .iter()
            .flatten()
            .filter_map(|r| r.first())
            .any(|&p| winding(a, p) != 0);
        let a_in_b = || {
            a.iter()
                .flatten()
                .filter(|r| overlaps(ring_bounds(r), Some(bb)))
                .filter_map(|r| r.first())
                .any(|&p| winding(b, p) != 0)
        };
        return Some(b_in_a || a_in_b());
    }
    let clear = |p: IntPoint<i32>| {
        close.iter().all(|&(s, t)| {
            let (dx, dy) = (f64::from(t.x) - f64::from(s.x), f64::from(t.y) - f64::from(s.y));
            let (px, py) = (f64::from(p.x) - f64::from(s.x), f64::from(p.y) - f64::from(s.y));
            let len2 = dx * dx + dy * dy;
            let k = if len2 > 0.0 {
                ((px * dx + py * dy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let (ex, ey) = (px - k * dx, py - k * dy);
            ex * ex + ey * ey > f64::from(MARGIN * MARGIN)
        })
    };
    b.iter()
        .flatten()
        .flatten()
        .any(|&p| clear(p) && winding(a, p) != 0)
        .then_some(true)
}

/// Union of several shape sets.
pub(crate) fn union_all(sets: &[&Shapes]) -> Shapes {
    let mut all: Shapes = Vec::new();
    for s in sets {
        all.extend(s.iter().cloned());
    }
    if all.is_empty() {
        return all;
    }
    simplified_shapes(&all, FillRule::NonZero)
}

/// [`union_all`] without the islands and holes smaller than `min_area` square units. Booleans round their
/// crossings to whole units, so regions cut from one outline meet again with specks and pinholes between
/// them; this drops them.
pub(crate) fn union_min_area(sets: &[&Shapes], min_area: u64) -> Shapes {
    let all: Shapes = sets.iter().flat_map(|s| s.iter().cloned()).collect();
    if all.is_empty() {
        return all;
    }
    let capacity = all.iter().flatten().map(Vec::len).sum();
    let options = IntOverlayOptions {
        min_output_area: min_area,
        ..IntOverlayOptions::default()
    };
    Overlay::new_custom(capacity, options, solver_for(capacity)).simplify_source(&all, FillRule::NonZero)
}

/// How `i_overlay` finds crossings. Its automatic choice sweeps over x below 4000 edges and moves to an
/// interval tree above, also partway through when splitting pushes the count past 4000. Raw offset loops
/// that fold back over each other split into many pieces, and finishing them in the tree took 2.5 to 4
/// times as long as staying in the sweep (110 against 46 ms for a 1600-point outline grown by 1.5 mm), so
/// the sweep is kept up to the size where `i_overlay` itself switches to splitting in fragments. Both
/// visit the same pairs of edges and snap the same way, so the result does not depend on the choice.
fn solver_for(edges: usize) -> Solver {
    if edges < 16_000 {
        Solver::LIST
    } else {
        Solver::AUTO
    }
}

fn edge_count(sets: &[&Shapes]) -> usize {
    sets.iter().flat_map(|s| s.iter()).flatten().map(Vec::len).sum()
}

/// `contours` merged by `rule`, as `Simplify::simplify` does, with the solver from [`solver_for`].
fn simplified(contours: &[Vec<IntPoint<i32>>], rule: FillRule) -> Shapes {
    let capacity = contours.iter().map(Vec::len).sum();
    Overlay::new_custom(capacity, IntOverlayOptions::default(), solver_for(capacity))
        .simplify_source(contours, rule)
}

/// [`simplified`] for shapes.
fn simplified_shapes(shapes: &Shapes, rule: FillRule) -> Shapes {
    let capacity = shapes.iter().flatten().map(Vec::len).sum();
    Overlay::new_custom(capacity, IntOverlayOptions::default(), solver_for(capacity))
        .simplify_source(shapes, rule)
}

/// Axis-aligned bounds `[min_x, min_y, max_x, max_y]` of shapes.
pub(crate) fn bounds(shapes: &[Vec<Vec<IntPoint<i32>>>]) -> Option<[i32; 4]> {
    let mut it = shapes.iter().flat_map(|s| s.iter()).flat_map(|c| c.iter());
    let f = it.next()?;
    let mut b = [f.x, f.y, f.x, f.y];
    for p in it {
        b[0] = b[0].min(p.x);
        b[1] = b[1].min(p.y);
        b[2] = b[2].max(p.x);
        b[3] = b[3].max(p.y);
    }
    Some(b)
}

/// Bounds of one ring, as [`bounds`].
pub(crate) fn ring_bounds(r: &[IntPoint<i32>]) -> Option<[i32; 4]> {
    let f = r.first()?;
    Some(r.iter().fold([f.x, f.y, f.x, f.y], |b, p| {
        [b[0].min(p.x), b[1].min(p.y), b[2].max(p.x), b[3].max(p.y)]
    }))
}

/// The part of `shapes` that can meet the box `b`: the shapes whose outline meets it, each without the holes
/// that lie apart from it, or `None` when that is all of `shapes`. Inside the box the area is the same, so a
/// boolean with something inside the box gives the same result with fewer edges to sort and split. Native
/// builds only: the browser module has no bytes to spare.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn near(shapes: &Shapes, b: Option<[i32; 4]>) -> Option<Shapes> {
    let mut dropped = false;
    let out: Shapes = shapes
        .iter()
        .filter_map(|sh| {
            let (outer, holes) = sh.split_first()?;
            if !overlaps(ring_bounds(outer), b) {
                dropped = true;
                return None;
            }
            let kept: Vec<Vec<IntPoint<i32>>> = std::iter::once(outer.clone())
                .chain(holes.iter().filter(|h| overlaps(ring_bounds(h), b)).cloned())
                .collect();
            dropped |= kept.len() < sh.len();
            Some(kept)
        })
        .collect();
    dropped.then_some(out)
}

pub(crate) fn overlaps(a: Option<[i32; 4]>, b: Option<[i32; 4]>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3],
        _ => false,
    }
}

/// Offsets shapes by `delta` internal units (negative shrinks).
///
/// Most wall offsets of printed parts are simple: moving every edge along its
/// normal and joining neighbors with miters gives a polygon with no
/// crossings. That fast path is tried first per shape and checked; shapes
/// where it fails (thin features, collapsing islands, holes meeting the outer
/// contour) go through [`clipper_offset`] instead. Both paths are
/// deterministic, so the choice does not depend on thread or shard.
/// Growing offsets (the brim) always take the union path, since separate
/// islands can merge.
pub(crate) fn offset(shapes: &Shapes, delta: i32) -> Shapes {
    if delta > 0 {
        // Growing shapes can merge, so they go through one union.
        let all: Vec<Vec<IntPoint<i32>>> = shapes.iter().flat_map(|s| s.iter().cloned()).collect();
        return clipper_offset(&all, delta);
    }
    let mut out = Vec::with_capacity(shapes.len());
    for shape in shapes {
        match fast_offset(shape, delta) {
            Some(s) => out.push(s),
            None => out.extend(clipper_offset(shape, delta)),
        }
    }
    out
}

/// Offset by union: every contour is moved edge by edge, joined with a miter
/// where the offset lines diverge and through the original vertex where they
/// overlap, and the loops are merged with the positive fill rule, which drops
/// the reversed pieces. This is the method of Clipper's `ClipperOffset`.
fn clipper_offset(shape: &[Vec<IntPoint<i32>>], delta: i32) -> Shapes {
    let d = f64::from(delta);
    let raw: Option<Vec<Vec<IntPoint<i32>>>> = shape
        .iter()
        .filter(|c| c.len() >= 3)
        .map(|c| raw_loop(c, d, true))
        .collect();
    if let Some(raw) = raw {
        if raw.is_empty() {
            return Vec::new();
        }
        return simplified(&raw, FillRule::Positive);
    }
    // A shrink met a corner sharper than the miter limit. Grow the complement
    // instead (the shape's contours reversed inside a bounding box), where
    // such corners are on the side that gets a bevel, then cut the result
    // out of the box.
    let Some(b) = bounds(std::slice::from_ref(&shape.to_vec())) else {
        return Vec::new();
    };
    let m = delta.saturating_abs().saturating_mul(4).saturating_add(10_000);
    let bx = vec![
        IntPoint::new(b[0] - m, b[1] - m),
        IntPoint::new(b[2] + m, b[1] - m),
        IntPoint::new(b[2] + m, b[3] + m),
        IntPoint::new(b[0] - m, b[3] + m),
    ];
    let mut raw: Vec<Vec<IntPoint<i32>>> = vec![bx.clone()];
    for c in shape.iter().filter(|c| c.len() >= 3) {
        let rev: Vec<IntPoint<i32>> = c.iter().rev().copied().collect();
        if let Some(r) = raw_loop(&rev, -d, true) {
            raw.push(r);
        }
    }
    let grown = simplified(&raw, FillRule::Positive);
    let frame: Shapes = vec![vec![bx]];
    let solver = solver_for(edge_count(&[&frame, &grown]));
    Overlay::from_subj_and_clip_custom(&frame, &grown, IntOverlayOptions::default(), solver)
        .overlay(OverlayRule::Difference, FillRule::NonZero)
}

/// Grows `shapes` by `delta` (positive) with round corners: the offset of Orca's `jtRound`, which the brim
/// uses. Edges move along their normals; where the offset lines diverge an arc of the vertex goes between
/// them; where they overlap the loop runs back through the vertex and the union drops it.
pub(crate) fn offset_round(shapes: &Shapes, delta: i32) -> Shapes {
    // Chord error of the arcs, 0.0125 mm (Orca's resolution).
    grow_round(shapes, delta, 125.0, false)
}

/// [`offset_round`] with arcs to a chord error of `chord` units; with `shallow_miter`, a corner whose arc
/// would be a single chord gets one mitered point instead of the chord's two ends (curved outlines, whose
/// every vertex is such a corner, then keep their point count).
fn grow_round(shapes: &Shapes, delta: i32, chord: f64, shallow_miter: bool) -> Shapes {
    if delta <= 0 {
        return offset(shapes, delta);
    }
    let d = f64::from(delta);
    let tol = chord.min(d / 2.0);
    let step = 2.0 * (1.0 - tol / d).clamp(-1.0, 1.0).m_acos();
    let mut raw: Vec<Vec<IntPoint<i32>>> = Vec::new();
    for c in shapes.iter().flat_map(|s| s.iter()) {
        let n = c.len();
        if n < 3 {
            continue;
        }
        let normal = |i: usize| -> Option<(f64, f64)> {
            let a = c.get(i % n)?;
            let b = c.get((i + 1) % n)?;
            let (dx, dy) = (f64::from(b.x) - f64::from(a.x), f64::from(b.y) - f64::from(a.y));
            let len = (dx * dx + dy * dy).sqrt();
            (len > 0.0).then(|| (dy / len, -dx / len))
        };
        let Some(mut prev) = normal(n - 1) else { continue };
        let mut r: Vec<IntPoint<i32>> = Vec::with_capacity(n * 2);
        for i in 0..n {
            let Some(p) = c.get(i) else { continue };
            let Some(cur) = normal(i) else { continue };
            let (px, py) = (f64::from(p.x), f64::from(p.y));
            let cross = prev.0 * cur.1 - prev.1 * cur.0;
            let dot = prev.0 * cur.0 + prev.1 * cur.1;
            if shallow_miter && dot > 0.0 && cross.abs().m_atan2(dot) < step {
                // Within the chord error either way: the offset lines meet at one point.
                let k = d / (1.0 + dot);
                r.push(round_pt(px + (prev.0 + cur.0) * k, py + (prev.1 + cur.1) * k));
            } else if cross > 0.0 {
                // The offset lines diverge: an arc from the previous normal to this one.
                let ang = cross.m_atan2(prev.0 * cur.0 + prev.1 * cur.1);
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a small step count"
                )]
                let steps = ((ang / step).ceil() as usize).max(1);
                for k in 0..=steps {
                    #[allow(clippy::cast_precision_loss, reason = "a small step count")]
                    let a = ang * k as f64 / steps as f64;
                    let (s, co) = a.m_sin_cos();
                    let (nx, ny) = (prev.0 * co - prev.1 * s, prev.0 * s + prev.1 * co);
                    r.push(round_pt(px + nx * d, py + ny * d));
                }
            } else {
                r.push(round_pt(px + prev.0 * d, py + prev.1 * d));
                r.push(*p);
                r.push(round_pt(px + cur.0 * d, py + cur.1 * d));
            }
            prev = cur;
        }
        raw.push(r);
    }
    if raw.is_empty() {
        return Vec::new();
    }
    simplified(&raw, FillRule::Positive)
}

/// Shrinks `shapes` by `delta` (positive) with round corners, Clipper's `jtRound` for a negative offset:
/// the complement inside a frame grows by `delta` with arcs at its convex corners (the shape's concave
/// ones), then comes off the frame.
pub(crate) fn shrink_round(shapes: &Shapes, delta: i32) -> Shapes {
    shrink_round_with(shapes, delta, 125.0, false)
}

/// [`shrink_round`] with arcs to a chord error of `chord` units, and one mitered point at each corner whose
/// arc would be a single chord. The walls of thick islands use it: the points of every inner offset of a
/// curved outline, where the arcs at its concave corners are invisible, stay as many as the outline's.
pub(crate) fn shrink_round_coarse(shapes: &Shapes, delta: i32, chord: f64) -> Shapes {
    shrink_round_with(shapes, delta, chord, true)
}

fn shrink_round_with(shapes: &Shapes, delta: i32, chord: f64, shallow_miter: bool) -> Shapes {
    if delta <= 0 {
        return shapes.clone();
    }
    let Some(b) = bounds(shapes) else {
        return Vec::new();
    };
    let m = delta.saturating_mul(4).saturating_add(10_000);
    let bx = vec![
        IntPoint::new(b[0] - m, b[1] - m),
        IntPoint::new(b[2] + m, b[1] - m),
        IntPoint::new(b[2] + m, b[3] + m),
        IntPoint::new(b[0] - m, b[3] + m),
    ];
    let mut rings: Vec<Vec<IntPoint<i32>>> = vec![bx.clone()];
    for c in shapes.iter().flat_map(|s| s.iter()).filter(|c| c.len() >= 3) {
        rings.push(c.iter().rev().copied().collect());
    }
    let grown = grow_round(&vec![rings], delta, chord, shallow_miter);
    let frame: Shapes = vec![vec![bx]];
    let solver = solver_for(edge_count(&[&frame, &grown]));
    Overlay::from_subj_and_clip_custom(&frame, &grown, IntOverlayOptions::default(), solver)
        .overlay(OverlayRule::Difference, FillRule::NonZero)
}

/// Grows `shapes` by `delta` (positive) with square corners, Clipper's `jtSquare` (the join Orca uses for
/// support and raft areas): where the offset lines diverge a corner is cut square, reaching up to twice the
/// distance past a sharp vertex.
pub(crate) fn offset_square(shapes: &Shapes, delta: i32) -> Shapes {
    if delta <= 0 {
        return offset(shapes, delta);
    }
    let d = f64::from(delta);
    let mut raw: Vec<Vec<IntPoint<i32>>> = Vec::new();
    for c in shapes.iter().flat_map(|s| s.iter()) {
        let n = c.len();
        if n < 3 {
            continue;
        }
        let normal = |i: usize| -> Option<(f64, f64)> {
            let a = c.get(i % n)?;
            let b = c.get((i + 1) % n)?;
            let (dx, dy) = (f64::from(b.x) - f64::from(a.x), f64::from(b.y) - f64::from(a.y));
            let len = (dx * dx + dy * dy).sqrt();
            (len > 0.0).then(|| (dy / len, -dx / len))
        };
        let Some(mut prev) = normal(n - 1) else { continue };
        let mut r: Vec<IntPoint<i32>> = Vec::with_capacity(n * 2);
        for i in 0..n {
            let Some(p) = c.get(i) else { continue };
            let Some(cur) = normal(i) else { continue };
            let (px, py) = (f64::from(p.x), f64::from(p.y));
            let cross = prev.0 * cur.1 - prev.1 * cur.0;
            if cross > 0.0 {
                let t = (cross.m_atan2(prev.0 * cur.0 + prev.1 * cur.1) / 4.0).m_tan();
                r.push(round_pt(
                    px + d * (prev.0 - prev.1 * t),
                    py + d * (prev.1 + prev.0 * t),
                ));
                r.push(round_pt(
                    px + d * (cur.0 + cur.1 * t),
                    py + d * (cur.1 - cur.0 * t),
                ));
            } else {
                r.push(round_pt(px + prev.0 * d, py + prev.1 * d));
                r.push(*p);
                r.push(round_pt(px + cur.0 * d, py + cur.1 * d));
            }
            prev = cur;
        }
        raw.push(r);
    }
    if raw.is_empty() {
        return Vec::new();
    }
    simplified(&raw, FillRule::Positive)
}

/// Miter length limit, as a multiple of the offset distance.
const MITER_LIMIT: f64 = 3.0;

/// The raw offset of one contour by `d` (positive grows the area on the
/// contour's left): edges moved along their normals and joined. Where the
/// offset lines diverge the join is a miter, or a bevel past 120 degrees.
/// Where they overlap, a growing offset loops back through the vertex (the
/// reversed loop drops out of a positive union) and a shrinking one takes
/// the miter point, or with `through` loops back through the vertex too, as
/// Clipper does (so a shape shrunk past its width vanishes in the union
/// instead of coming out turned inside out). Returns `None` when a shrinking offset meets a corner
/// whose miter would pass the limit, since its point could land outside the
/// shape.
fn raw_loop(c: &[IntPoint<i32>], d: f64, through: bool) -> Option<Vec<IntPoint<i32>>> {
    let n = c.len();
    let normal = |i: usize| -> Option<(f64, f64)> {
        let a = c.get(i % n)?;
        let b = c.get((i + 1) % n)?;
        let (dx, dy) = (f64::from(b.x) - f64::from(a.x), f64::from(b.y) - f64::from(a.y));
        let len = (dx * dx + dy * dy).sqrt();
        (len > 0.0).then(|| (dy / len, -dx / len))
    };
    let min_cos = 2.0 / (MITER_LIMIT * MITER_LIMIT) - 1.0;
    let mut prev = normal(n.checked_sub(1)?)?;
    let mut r = Vec::with_capacity(n + n / 4 + 4);
    for i in 0..n {
        let p = c.get(i)?;
        let Some(cur) = normal(i) else { continue };
        let dot = prev.0 * cur.0 + prev.1 * cur.1;
        let cross = prev.0 * cur.1 - prev.1 * cur.0;
        let (px, py) = (f64::from(p.x), f64::from(p.y));
        let gap = (cross > 0.0) == (d > 0.0);
        if gap && dot < -0.5 {
            r.push(round_pt(px + prev.0 * d, py + prev.1 * d));
            r.push(round_pt(px + cur.0 * d, py + cur.1 * d));
        } else if !gap && (d > 0.0 || through) {
            r.push(round_pt(px + prev.0 * d, py + prev.1 * d));
            r.push(*p);
            r.push(round_pt(px + cur.0 * d, py + cur.1 * d));
        } else if dot < min_cos {
            return None;
        } else {
            let k = d / (1.0 + dot);
            r.push(round_pt(px + (prev.0 + cur.0) * k, py + (prev.1 + cur.1) * k));
        }
        prev = cur;
    }
    Some(r)
}

/// A ring and, per corner, how far the corner moves for an offset of one unit.
type RingSteps<'a> = (&'a Vec<IntPoint<i32>>, Vec<(f64, f64)>);

/// True when offsetting `shapes` inward (into the area) by each of `dists` internal units is certain to give the
/// plain moved polygon: every edge moved in, each corner where its two moved edges meet. That holds when every
/// moved edge keeps its direction and a length above zero up to the farthest distance, no corner turns by more
/// than 120 degrees (so every offset in or out joins corners with a miter, never a bevel), and the moved edges
/// meet no other edge at any of the distances, nor 100 units past the farthest, where every moved hole also
/// stays inside the bounds of its moved outline (a ring thinner than twice the way has its outline and hole pass
/// each other, and nearly concentric ones need not meet at any of the distances looked at). The offsets in by
/// those distances, and out again from them by part of the way, are then these moved polygons up to rounding.
/// `accept` is asked first, with the shortest edge over the way and the largest miter factor (how far a corner
/// moves when its edges move by one unit); the crossings are only looked for when it agrees. Shapes with an edge
/// shorter than `shortest` are turned down before anything else.
pub(crate) fn plain_offsets(
    shapes: &Shapes,
    dists: &[f64],
    shortest: f64,
    accept: impl Fn(f64, f64) -> bool,
) -> bool {
    let quick = shortest * shortest;
    #[allow(clippy::cast_precision_loss, reason = "squared plate distances")]
    let long = |a: &IntPoint<i32>, b: &IntPoint<i32>| {
        let (dx, dy) = (i64::from(b.x) - i64::from(a.x), i64::from(b.y) - i64::from(a.y));
        (dx * dx + dy * dy) as f64 >= quick
    };
    if !shapes
        .iter()
        .flatten()
        .all(|r| r.iter().zip(r.iter().cycle().skip(1)).all(|(a, b)| long(a, b)))
    {
        return false;
    }
    let far = dists.iter().copied().fold(0.0, f64::max) + 100.0;
    // Each ring with, per corner, the step the corner takes per unit of offset.
    let mut rings: Vec<RingSteps<'_>> = Vec::new();
    let mut shortest = f64::INFINITY;
    let mut dot_min = 1.0f64;
    for ring in shapes.iter().flatten() {
        let n = ring.len();
        if n < 3 {
            return false;
        }
        let mut edges = Vec::with_capacity(n);
        let mut normals = Vec::with_capacity(n);
        for i in 0..n {
            let (Some(a), Some(b)) = (ring.get(i), ring.get((i + 1) % n)) else {
                return false;
            };
            let (dx, dy) = (f64::from(b.x) - f64::from(a.x), f64::from(b.y) - f64::from(a.y));
            let len = (dx * dx + dy * dy).sqrt();
            if len <= 0.0 {
                return false;
            }
            edges.push((dx, dy, len));
            // The area lies to the left of every edge: counterclockwise outlines, clockwise holes.
            normals.push((-dy / len, dx / len));
        }
        let mut steps = Vec::with_capacity(n);
        for i in 0..n {
            let (Some(&prev), Some(&cur)) = (normals.get((i + n - 1) % n), normals.get(i)) else {
                return false;
            };
            let dot = prev.0 * cur.0 + prev.1 * cur.1;
            if dot < -0.5 {
                return false;
            }
            dot_min = dot_min.min(dot);
            let k = 1.0 / (1.0 + dot);
            steps.push(((prev.0 + cur.0) * k, (prev.1 + cur.1) * k));
        }
        // An edge's moved length along its own direction changes linearly with the distance, so one above zero at
        // both ends of the way stays above zero between them.
        for i in 0..n {
            let (Some(&(dx, dy, len)), Some(&sa), Some(&sb)) =
                (edges.get(i), steps.get(i), steps.get((i + 1) % n))
            else {
                return false;
            };
            let along = ((dx + (sb.0 - sa.0) * far) * dx + (dy + (sb.1 - sa.1) * far) * dy) / len;
            if along <= 0.0 {
                return false;
            }
            shortest = shortest.min(len).min(along);
        }
        rings.push((ring, steps));
    }
    if rings.is_empty() || !accept(shortest, (2.0 / (1.0 + dot_min)).sqrt()) {
        return false;
    }
    dists.iter().copied().chain([far]).all(|s| {
        let moved: Vec<Vec<IntPoint<i32>>> = rings
            .iter()
            .map(|(ring, steps)| {
                ring.iter()
                    .zip(steps)
                    .map(|(p, st)| round_pt(f64::from(p.x) + st.0 * s, f64::from(p.y) + st.1 * s))
                    .collect()
            })
            .collect();
        // Every ring of the shapes is in `rings`, in order.
        let mut at = 0;
        shapes.iter().all(|sh| {
            let part = moved.get(at..at + sh.len());
            at += sh.len();
            part.is_some_and(|p| nested(p, None))
        }) && !any_crossing(&moved)
    })
}

/// Miter offset of one shape, or `None` when the result is not a valid shape
/// (a contour flipped or any two edges touch).
fn fast_offset(shape: &[Vec<IntPoint<i32>>], delta: i32) -> Option<Vec<Vec<IntPoint<i32>>>> {
    let d = f64::from(delta);
    let mut out: Vec<Vec<IntPoint<i32>>> = Vec::with_capacity(shape.len());
    // Each contour's bounds, so the check below skips contours far from a point (a plate with dozens of holes
    // would otherwise measure every hole's points against every other hole's edges).
    let boxes: Vec<Option<[i32; 4]>> = if d < 0.0 {
        shape.iter().map(|c| ring_bounds(c)).collect()
    } else {
        Vec::new()
    };
    let mut outline_ccw = None;
    for c in shape {
        let n = c.len();
        if n < 3 {
            return None;
        }
        let area_in = crate::geom::area2_int(c);
        outline_ccw.get_or_insert(area_in > 0);
        let mut r = raw_loop(c, d, false)?;
        r.dedup();
        if r.first() == r.last() {
            r.pop();
        }
        remove_swallowtails(&mut r, area_in > 0);
        if r.len() < 3 {
            return None;
        }
        let area_out = crate::geom::area2_int(&r);
        if area_out == 0 || (area_out > 0) != (area_in > 0) {
            return None;
        }
        // Shrunk past its narrowest width, a convex contour comes out turned inside out with the same
        // winding (every vertex crossed to the far side), and the outline of a ring thinner than twice the
        // offset passes inside its grown hole without crossing it. Then its points mostly sit closer to some
        // contour of the shape than the offset: check a few against all of them.
        if d < 0.0
            && !shape
                .iter()
                .zip(&boxes)
                .all(|(other, b)| far_enough(other, *b, &r, -d))
        {
            return None;
        }
        out.push(r);
    }
    // Not when the island or the ring is much thinner than the offset: every moved point is then about the offset
    // from every contour. What came out inside out has grown past its old bounds, or has holes around its outline.
    if d < 0.0 && outline_ccw == Some(true) && !nested(&out, boxes.first().copied().flatten()) {
        return None;
    }
    if any_crossing(&out) {
        return None;
    }
    Some(out)
}

/// True when the first of `rings`, a shape's outline moved in, lies inside `outer` (the outline's bounds before
/// the move, when given) and every other ring, a hole moved out, inside the moved outline's bounds, as an inward
/// offset keeps them.
fn nested(rings: &[Vec<IntPoint<i32>>], outer: Option<[i32; 4]>) -> bool {
    let within = |a: Option<[i32; 4]>, b: Option<[i32; 4]>| match (a, b) {
        (Some(a), Some(b)) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3],
        _ => false,
    };
    let Some((outline, holes)) = rings.split_first() else {
        return true;
    };
    let b = ring_bounds(outline);
    (outer.is_none() || within(b, outer)) && holes.iter().all(|h| within(ring_bounds(h), b))
}

/// True when sampled points of `r` are at least `d` (less a margin) from every edge of `c`, whose bounds are `b`.
fn far_enough(c: &[IntPoint<i32>], b: Option<[i32; 4]>, r: &[IntPoint<i32>], d: f64) -> bool {
    let n = c.len();
    let step = (r.len() / 8).max(1);
    let need = (d * 0.9 - 2.0).max(0.0);
    for p in r.iter().step_by(step) {
        let (px, py) = (f64::from(p.x), f64::from(p.y));
        // No edge comes closer than the bounds. The distance to them is exact, the margin covers the rounding of
        // the edge distances below, so a point skipped here is one no edge would have stopped.
        if let Some(b) = b {
            let bx = (f64::from(b[0]) - px).max(px - f64::from(b[2])).max(0.0);
            let by = (f64::from(b[1]) - py).max(py - f64::from(b[3])).max(0.0);
            if bx * bx + by * by > need * need * 1.000_001 + 4.0 {
                continue;
            }
        }
        for i in 0..n {
            let (Some(a), Some(b)) = (c.get(i), c.get((i + 1) % n)) else {
                continue;
            };
            let (ax, ay) = (f64::from(a.x), f64::from(a.y));
            let (vx, vy) = (f64::from(b.x) - ax, f64::from(b.y) - ay);
            let l2 = vx * vx + vy * vy;
            let t = if l2 > 0.0 {
                (((px - ax) * vx + (py - ay) * vy) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let (dx, dy) = (px - ax - vx * t, py - ay - vy * t);
            if dx * dx + dy * dy < need * need {
                return false;
            }
        }
    }
    true
}

/// Twice the area (internal units) below which a crossing loop is noise to
/// cut whatever its winding: 0.01 mm2.
const TINY_LOOP: i64 = 2_000_000;

/// Edges this far apart (in vertices) are checked for the small reversed
/// loops a miter offset makes where it overruns short edges.
const TAIL_SPAN: usize = 6;

/// Cuts out small loops whose winding is opposite to the contour's
/// (`ccw` is the contour's winding), replacing them by the crossing point.
fn remove_swallowtails(r: &mut Vec<IntPoint<i32>>, ccw: bool) {
    let mut i = 0;
    let mut guard = 0;
    while i < r.len() && r.len() > 3 && guard < 100_000 {
        guard += 1;
        let n = r.len();
        let (Some(&a), Some(&b)) = (r.get(i), r.get((i + 1) % n)) else {
            break;
        };
        let mut cut = None;
        for step in 2..=TAIL_SPAN.min(n.saturating_sub(2)) {
            let j = (i + step) % n;
            let (Some(&c), Some(&d)) = (r.get(j), r.get((j + 1) % n)) else {
                break;
            };
            if a.x.max(b.x) < c.x.min(d.x)
                || c.x.max(d.x) < a.x.min(b.x)
                || a.y.max(b.y) < c.y.min(d.y)
                || c.y.max(d.y) < a.y.min(b.y)
                || !proper_cross(a, b, c, d)
            {
                continue;
            }
            // Loop: crossing point, then vertices i + 1 ..= j.
            let x = cross_point(a, b, c, d);
            let mut loop_pts = Vec::with_capacity(step + 1);
            loop_pts.push(x);
            loop_pts.extend((1..=step).filter_map(|k| r.get((i + k) % n)).copied());
            let area = crate::geom::area2_int(&loop_pts);
            if (area != 0 && (area > 0) != ccw) || area.abs() <= TINY_LOOP {
                cut = Some((step, x));
            }
            break;
        }
        match cut {
            Some((step, x)) => {
                // Replace vertices i + 1 ..= i + step with x.
                let mut next = Vec::with_capacity(n - step + 1);
                for k in 0..n {
                    let off = (k + n - i) % n;
                    if off == 1 {
                        next.push(x);
                    } else if (off <= 1 || off > step)
                        && let Some(&p) = r.get(k)
                    {
                        next.push(p);
                    }
                }
                let removed_before = (1..=step).filter(|off| (i + off) >= n).count();
                *r = next;
                i = i.saturating_sub(removed_before).saturating_sub(1);
            }
            None => i += 1,
        }
    }
}

fn proper_cross(a: IntPoint<i32>, b: IntPoint<i32>, c: IntPoint<i32>, d: IntPoint<i32>) -> bool {
    let (o1, o2, o3, o4) = (orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b));
    o1 * o2 < 0 && o3 * o4 < 0
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "the crossing lies between the segment ends"
)]
fn cross_point(a: IntPoint<i32>, b: IntPoint<i32>, c: IntPoint<i32>, d: IntPoint<i32>) -> IntPoint<i32> {
    let (ax, ay) = (f64::from(a.x), f64::from(a.y));
    let (rx, ry) = (f64::from(b.x) - ax, f64::from(b.y) - ay);
    let (sx, sy) = (f64::from(d.x) - f64::from(c.x), f64::from(d.y) - f64::from(c.y));
    let den = rx * sy - ry * sx;
    if den == 0.0 {
        return a;
    }
    let t = ((f64::from(c.x) - ax) * sy - (f64::from(c.y) - ay) * sx) / den;
    IntPoint::new((ax + t * rx).round() as i32, (ay + t * ry).round() as i32)
}

#[allow(clippy::cast_possible_truncation, reason = "offset points stay on the bed")]
fn round_pt(x: f64, y: f64) -> IntPoint<i32> {
    IntPoint::new(x.round() as i32, y.round() as i32)
}

/// True when any two non-adjacent edges of the contours touch or cross.
fn any_crossing(contours: &[Vec<IntPoint<i32>>]) -> bool {
    struct E {
        a: IntPoint<i32>,
        b: IntPoint<i32>,
        min_x: i32,
        max_x: i32,
        c: u32,
        i: u32,
        n: u32,
    }
    let mut edges: Vec<E> = Vec::with_capacity(contours.iter().map(Vec::len).sum());
    for (ci, c) in contours.iter().enumerate() {
        let n = c.len();
        for i in 0..n {
            let (Some(&a), Some(&b)) = (c.get(i), c.get((i + 1) % n)) else {
                continue;
            };
            #[allow(clippy::cast_possible_truncation, reason = "contour sizes fit in u32")]
            edges.push(E {
                a,
                b,
                min_x: a.x.min(b.x),
                max_x: a.x.max(b.x),
                c: ci as u32,
                i: i as u32,
                n: n as u32,
            });
        }
    }
    edges.sort_unstable_by_key(|e| e.min_x);
    for (k, e) in edges.iter().enumerate() {
        for f in edges.iter().skip(k + 1) {
            if f.min_x > e.max_x {
                break;
            }
            if e.c == f.c {
                let (i, j, n) = (e.i, f.i, e.n);
                if (i + 1) % n == j || (j + 1) % n == i {
                    continue;
                }
            }
            if segments_touch(e.a, e.b, f.a, f.b) {
                return true;
            }
        }
    }
    false
}

fn orient(a: IntPoint<i32>, b: IntPoint<i32>, c: IntPoint<i32>) -> i64 {
    let v = (i64::from(b.x) - i64::from(a.x)) * (i64::from(c.y) - i64::from(a.y))
        - (i64::from(b.y) - i64::from(a.y)) * (i64::from(c.x) - i64::from(a.x));
    v.signum()
}

fn on_segment(a: IntPoint<i32>, b: IntPoint<i32>, p: IntPoint<i32>) -> bool {
    p.x >= a.x.min(b.x) && p.x <= a.x.max(b.x) && p.y >= a.y.min(b.y) && p.y <= a.y.max(b.y)
}

fn segments_touch(a: IntPoint<i32>, b: IntPoint<i32>, c: IntPoint<i32>, d: IntPoint<i32>) -> bool {
    if a.y.max(b.y) < c.y.min(d.y) || c.y.max(d.y) < a.y.min(b.y) {
        return false;
    }
    let (o1, o2, o3, o4) = (orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b));
    if o1 != o2 && o3 != o4 && o1 != 0 && o2 != 0 && o3 != 0 && o4 != 0 {
        return true;
    }
    (o1 == 0 && on_segment(a, b, c))
        || (o2 == 0 && on_segment(a, b, d))
        || (o3 == 0 && on_segment(c, d, a))
        || (o4 == 0 && on_segment(c, d, b))
        || (o1 != o2 && o3 != o4)
}

/// Wall loops of one island, innermost wall first, and the region left for infill.
#[derive(Debug, Clone, Default)]
pub(crate) struct IslandWalls {
    /// `(wall index, loop)`; wall 0 is the outer wall.
    pub(crate) loops: Vec<(u32, Vec<IntPoint<i32>>)>,
    /// Beads for the strips the loops leave, with their widths.
    pub(crate) gaps: Vec<crate::gapfill::Gap>,
    /// Variable-width lines when the walls come from the Arachne generator (then `loops` and
    /// `gaps` are empty).
    pub(crate) wide: Vec<crate::arachne::WallLine>,
    /// Gap fill as variable-width lines, for the classic walls when Orca's gap finder ran.
    pub(crate) gap_lines: Vec<crate::arachne::WallLine>,
}

/// What `only_one_wall_top` needs to know about the neighbor layers: the material above (the
/// slice of the layer above) and, when there is one, the material below.
pub(crate) struct TopCtx<'a> {
    pub(crate) upper: &'a Shapes,
    pub(crate) lower: Option<&'a Shapes>,
}

/// The walls of `region` by the generator the settings ask for: fixed-width loops of width `w`, or
/// the variable-width lines of the Arachne generator. `layer_height` and `top_or_bottom` tune the
/// latter.
pub(crate) fn walls_for(
    cfg: &crate::config::PrintConfig,
    region: &Shapes,
    wall_loops: u32,
    w: i32,
    overlap: i32,
    layer_height: f64,
    top_or_bottom: bool,
) -> (Vec<IslandWalls>, Shapes) {
    walls_for_top(
        cfg,
        region,
        wall_loops,
        w,
        overlap,
        layer_height,
        top_or_bottom,
        None,
    )
}

/// [`walls_for`] with the neighbor layers known, so `only_one_wall_top` can give top surfaces one wall.
#[allow(
    clippy::too_many_arguments,
    reason = "the walls' inputs, as in walls_for, plus the top context"
)]
pub(crate) fn walls_for_top(
    cfg: &crate::config::PrintConfig,
    region: &Shapes,
    wall_loops: u32,
    w: i32,
    overlap: i32,
    layer_height: f64,
    top_or_bottom: bool,
    top: Option<&TopCtx>,
) -> (Vec<IslandWalls>, Shapes) {
    if cfg.arachne_walls() {
        crate::arachne::island_walls(region, cfg, wall_loops, overlap, layer_height, top_or_bottom, top)
    } else {
        let mm = crate::geom::mm;
        let (ext, inner) = if cfg.has_feature_widths() {
            (mm(cfg.outer_wall_width()), mm(cfg.inner_wall_width()))
        } else {
            (w, w)
        };
        // Orca's gap regions use the loop pitch (width less the rounded corners); the first inner
        // wall sits the average width from the outer one under `precise_outer_wall`, else the
        // average pitch.
        let pitch = |width: i32| mm(cfg.spacing_for(f64::from(width) / crate::geom::SCALE));
        let precise = crate::tower::flag_or(cfg, "precise_outer_wall", true)
            && cfg.wall_sequence == crate::config::WallSequence::InnerOuter;
        let spacing2 = if precise {
            i32::midpoint(ext, inner)
        } else {
            i32::midpoint(pitch(ext), pitch(inner))
        };
        walls_gapped(
            region,
            wall_loops,
            ext,
            inner,
            overlap,
            Some((pitch(inner), spacing2, layer_height)),
        )
    }
}

/// Builds `wall_loops` walls of width `w` for each island of `region`, and
/// returns the infill area, inset by the walls minus `overlap`.
pub(crate) fn walls(region: &Shapes, wall_loops: u32, w: i32, overlap: i32) -> (Vec<IslandWalls>, Shapes) {
    walls_with(region, wall_loops, w, w, overlap)
}

/// [`walls`] with an outer wall of width `ext` and inner walls of width `inner`: the outer wall's center
/// lies half its width in, the first inner wall half of each width beyond it, and so on.
pub(crate) fn walls_with(
    region: &Shapes,
    wall_loops: u32,
    ext: i32,
    inner: i32,
    overlap: i32,
) -> (Vec<IslandWalls>, Shapes) {
    walls_gapped(region, wall_loops, ext, inner, overlap, None)
}

/// [`walls_with`] that finds gaps the way Orca does when given the loop pitch and the pitch between
/// the outer and first inner wall.
pub(crate) fn walls_gapped(
    region: &Shapes,
    wall_loops: u32,
    ext: i32,
    inner: i32,
    overlap: i32,
    gap_pitches: Option<(i32, i32, f64)>,
) -> (Vec<IslandWalls>, Shapes) {
    let mut islands = Vec::with_capacity(region.len());
    let mut core_all: Shapes = Vec::new();
    // The width the gap finder and the smallest infill strip are measured in.
    let w = if wall_loops > 1 { inner } else { ext };
    for shape in region {
        let one: Shapes = vec![shape.clone()];
        let mut island = IslandWalls::default();
        // The loop areas from the outer wall in, which the gap finder walks again.
        let mut chain: Vec<Shapes> = Vec::new();
        if let Some((spacing, spacing2, _)) = gap_pitches {
            // Orca's loop chain: each loop is the previous one pulled in by a loop pitch and opened by
            // the squish tolerance, so a loop vanishes where the part is too thin for it and a
            // narrow crescent does not keep a sliver of a wall.
            let min_spacing = spacing * 6 / 10;
            for k in 0..wall_loops {
                let last = if let Some(prev) = chain.last() {
                    let d = if k == 1 { spacing2 } else { spacing };
                    offset(&offset(prev, -(d + min_spacing / 2 - 1)), min_spacing / 2 - 1)
                } else {
                    offset(&one, -(ext / 2))
                };
                let empty = last.is_empty();
                chain.push(last);
                if empty {
                    break;
                }
                for s in chain.last().into_iter().flatten() {
                    for c in s {
                        island.loops.push((k, c.clone()));
                    }
                }
            }
            island.loops.reverse();
        } else {
            for k in (0..wall_loops).rev() {
                #[allow(clippy::cast_possible_wrap, reason = "wall counts are capped at 50")]
                let d = if k == 0 {
                    -(ext / 2)
                } else {
                    -(ext + inner * (2 * k as i32 - 1) / 2)
                };
                for s in offset(&one, d) {
                    for c in s {
                        island.loops.push((k, c));
                    }
                }
            }
        }
        #[allow(clippy::cast_possible_wrap, reason = "wall counts are capped at 50")]
        let inset = if wall_loops == 0 {
            0
        } else {
            ext + inner * (wall_loops as i32 - 1)
        } - overlap;
        // Orca (`PerimeterGenerator`): the infill area is the last wall's centerline pulled in by the rest of
        // the wall, opened by the smallest infill width (0.6 of a solid spacing, about 0.54 of the width) so
        // strips too narrow to hold a line are dropped.
        let min = w * 27 / 50;
        let mut core = if inset > 0 {
            offset(&offset(&one, -(inset + min / 2)), min / 2)
        } else {
            one.clone()
        };
        if let (true, Some((spacing, spacing2, height))) = (wall_loops > 0, gap_pitches) {
            let (lines, covered) =
                crate::gapfill::find_orca(&one, &chain, wall_loops, ext, inner, spacing, spacing2, height);
            island.gap_lines = lines;
            if !covered.is_empty() {
                // Orca takes the filled strips out of the innermost wall's area before the infill's inset,
                // so the infill keeps half a loop pitch away from a gap bead.
                core = difference(&core, &offset(&covered, spacing / 2));
            }
        } else if wall_loops > 0 && has_gaps(&one, &island, &core, wall_loops, w, overlap) {
            island.gaps = crate::gapfill::find(&one, wall_loops, w);
        }
        core_all.extend(core);
        islands.push(island);
    }
    (islands, core_all)
}

/// A cheap test for strips the walls leave open: the island's area, less the
/// beads (loop length times width) and the infill area, should be near
/// nothing. Only when a sizable remainder is left does gap fill run its
/// offsets. `core` is the infill area, inset by the walls minus `overlap`.
#[allow(clippy::cast_precision_loss, reason = "areas of one layer fit f64")]
fn has_gaps(
    one: &Shapes,
    island: &IslandWalls,
    core: &Shapes,
    wall_loops: u32,
    w: i32,
    overlap: i32,
) -> bool {
    let area = |s: &Shapes| -> f64 {
        s.iter()
            .flat_map(|sh| sh.iter())
            .map(|r| crate::geom::area2_int(r))
            .sum::<i64>() as f64
            / 2.0
    };
    let perimeter = |r: &[IntPoint<i32>]| -> f64 {
        r.iter()
            .zip(r.iter().cycle().skip(1))
            .map(|(a, b)| f64::from(a.x - b.x).m_hypot(f64::from(a.y - b.y)))
            .sum()
    };
    let wf = f64::from(w);
    let beads: f64 = island.loops.iter().map(|(_, l)| perimeter(l) * wf).sum();
    let core_perimeter: f64 = core.iter().flat_map(|s| s.iter()).map(|r| perimeter(r)).sum();
    // The infill area reaches `overlap` into the innermost bead.
    let core_area = area(core) - core_perimeter * f64::from(overlap.max(0)).min(wf);
    let loops_len: f64 = island.loops.iter().map(|(_, l)| perimeter(l)).sum();
    let _ = wall_loops;
    let residual = area(one) - beads - core_area.max(0.0);
    residual > (2.0 * wf * wf).max(0.03 * wf * loops_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_gets_two_walls_and_a_smaller_core() {
        let sq = vec![vec![
            Point::new(0, 0),
            Point::new(200_000, 0),
            Point::new(200_000, 200_000),
            Point::new(0, 200_000),
        ]];
        let shapes = shapes_from_loops(&sq);
        let (islands, inner) = walls(&shapes, 2, 4_200, 630);
        assert_eq!(islands.len(), 1);
        assert_eq!(islands[0].loops.len(), 2);
        assert_eq!(islands[0].loops[0].0, 1);
        let b = bounds(&inner).unwrap();
        assert_eq!(b[0], 8_400 - 630);
    }

    /// A ring `width` units wide around a hole of radius `r`, both circles of `n` points.
    #[allow(clippy::cast_precision_loss, reason = "a point count")]
    fn ring(r: f64, width: f64, n: usize) -> Shapes {
        let circle = |rad: f64| -> Vec<IntPoint<i32>> {
            (0..n)
                .map(|k| {
                    let (s, c) = (std::f64::consts::TAU * k as f64 / n as f64).m_sin_cos();
                    round_pt(1_000_000.0 + rad * c, 1_000_000.0 + rad * s)
                })
                .collect()
        };
        let hole: Vec<IntPoint<i32>> = circle(r).into_iter().rev().collect();
        vec![vec![circle(r + width), hole]]
    }

    #[test]
    fn a_ring_much_thinner_than_the_offset_shrinks_to_nothing() {
        // The 0.0022 mm sliver of sparse infill a bridge's solid ring can leave along a hole's walls, pulled in by
        // half a spacing before the pattern is laid.
        let sliver = ring(37_800.0, 22.0, 64);
        assert!(offset(&sliver, -2_250).is_empty());
        assert!(!plain_offsets(&sliver, &[1_000.0, 2_250.0], 1.0, |_, _| true));
        // A ring wide enough keeps a ring.
        let wide = ring(37_800.0, 6_000.0, 64);
        assert_eq!(offset(&wide, -2_250).first().map(Vec::len), Some(2));
        assert!(plain_offsets(&wide, &[1_000.0, 2_250.0], 1.0, |_, _| true));
    }

    fn rect(x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<IntPoint<i32>> {
        vec![
            IntPoint::new(x0, y0),
            IntPoint::new(x1, y0),
            IntPoint::new(x1, y1),
            IntPoint::new(x0, y1),
        ]
    }

    #[test]
    fn specks_and_pinholes_go_and_real_holes_stay() {
        // A 10 mm square with a 2 mm hole and a 0.05 mm pinhole, and a 0.05 mm speck beside it.
        let mut pinhole = rect(50_000, 50_000, 50_500, 50_500);
        pinhole.reverse();
        let mut hole = rect(20_000, 20_000, 40_000, 40_000);
        hole.reverse();
        let shapes: Shapes = vec![
            vec![rect(0, 0, 100_000, 100_000), hole, pinhole],
            vec![rect(120_000, 0, 120_500, 500)],
        ];
        let all = union_all(&[&shapes]);
        assert_eq!((all.len(), all.iter().map(Vec::len).sum::<usize>()), (2, 4));
        // 0.01 mm2: the square keeps its real hole only.
        let clean = union_min_area(&[&shapes], 1_000_000);
        assert_eq!((clean.len(), clean.first().map(Vec::len)), (1, Some(2)));
        // Cut from a square, a sliver half a micron wide is a speck too.
        let cut = difference_min_area(
            &vec![vec![rect(0, 0, 100_000, 100_000)]],
            &vec![vec![rect(-10, 5, 100_010, 100_000)]],
            1_000_000,
        );
        assert!(cut.is_empty(), "{cut:?}");
    }

    #[test]
    fn a_speck_much_smaller_than_the_offset_shrinks_to_nothing() {
        let speck: Shapes = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(20, 0),
            IntPoint::new(20, 20),
            IntPoint::new(0, 20),
        ]]];
        assert!(offset(&speck, -2_000).is_empty());
    }
}
