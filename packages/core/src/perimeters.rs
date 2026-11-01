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
    difference_min_area(a, b, 0)
}

/// [`difference`] without the islands and holes smaller than `min_area` square units (see [`union_min_area`]).
pub(crate) fn difference_min_area(a: &Shapes, b: &Shapes, min_area: u64) -> Shapes {
    if a.is_empty() || b.is_empty() {
        return if min_area == 0 {
            a.clone()
        } else {
            union_min_area(&[a], min_area)
        };
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
    union_min_area(sets, 0)
}

/// [`union_all`] without the islands and holes smaller than `min_area` square units. Booleans round their
/// crossings to whole units, so regions cut from one outline meet again with specks and pinholes between
/// them; this drops them.
pub(crate) fn union_min_area(sets: &[&Shapes], min_area: u64) -> Shapes {
    let mut all: Shapes = Vec::new();
    for s in sets {
        all.extend(s.iter().cloned());
    }
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

/// [`union_all`] with the list sweep at every size, for many small rings that overlap heavily, such as tree
/// branches drawn as circles, a few hundred to a layer. Their crossings split them into short pieces that
/// the sweep finishes sooner than the interval tree: about a third less time for one model's branches,
/// at up to 45,000 edges a layer. The result is the same as [`union_all`]'s (see [`solver_for`]).
pub(crate) fn union_swept(sets: &[&Shapes]) -> Shapes {
    let mut all: Shapes = Vec::new();
    for s in sets {
        all.extend(s.iter().cloned());
    }
    if all.is_empty() {
        return all;
    }
    let capacity = all.iter().flatten().map(Vec::len).sum();
    Overlay::new_custom(capacity, IntOverlayOptions::default(), Solver::LIST)
        .simplify_source(&all, FillRule::NonZero)
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
        let hole: Vec<bool> = shapes.iter().flat_map(|s| (0..s.len()).map(|i| i > 0)).collect();
        return grow_union(&all, &hole, delta);
    }
    let mut out = Vec::with_capacity(shapes.len());
    for shape in shapes {
        if shrinks_away(shape, -f64::from(delta)) {
            continue;
        }
        match fast_offset(shape, delta) {
            Some(s) => out.extend(s),
            None if nothing_left(shape, -f64::from(delta)) => {}
            None => out.extend(clipper_offset(shape, delta)),
        }
    }
    out
}

/// True when shrinking `shape` by `d` internal units must leave nothing. A point that far from every edge is the
/// center of a disc of radius `d` inside the outline, so the outline's bounds are at least `2 d` across both ways and
/// its area at least pi d^2; a shape short of either has no such point. The union of moved loops can still keep a
/// sliver there, and on wide circle unions (tree support areas shrunk by a few millimeters) it costs 100 ms or more
/// to find nothing, so these shapes are skipped before it.
fn shrinks_away(shape: &[Vec<IntPoint<i32>>], d: f64) -> bool {
    let Some(outer) = shape.first().filter(|r| r.len() >= 3) else {
        return false;
    };
    let Some(b) = ring_bounds(outer) else {
        return false;
    };
    if f64::from(b[2]) - f64::from(b[0]) < 2.0 * d || f64::from(b[3]) - f64::from(b[1]) < 2.0 * d {
        return true;
    }
    let twice: f64 = outer
        .iter()
        .zip(outer.iter().cycle().skip(1))
        .map(|(p, q)| f64::from(p.x) * f64::from(q.y) - f64::from(q.x) * f64::from(p.y))
        .sum();
    twice.abs() < 2.0 * std::f64::consts::PI * d * d
}

/// What [`disc_fit`] found out about a disc of radius `d` inside a shape.
#[derive(Debug, PartialEq, Eq)]
enum DiscFit {
    /// A point inside the shape lies `d` or more from every edge.
    Fits,
    /// No point inside the shape lies `d` from every edge.
    Nowhere,
    /// The cells ran out before either was shown.
    Undecided,
}

/// Most cells [`disc_fit`] looks at before it gives up. Over a corpus of test slices, the empty shrinks that cost the
/// union the most were settled within about 210 cells, while the few that ran to 4096 cost the test more than the
/// union it could save.
const DISC_FIT_CELLS: usize = 256;

/// Fewest points a shape needs before [`nothing_left`] asks [`disc_fit`]: on smaller shapes the union takes tens of
/// microseconds, about what the test would cost.
const DISC_FIT_POINTS: usize = 128;

/// True when [`disc_fit`] shows that shrinking `shape` by `d` internal units leaves nothing. Small shapes are not
/// tested, and undecided counts as something left, so in both cases the offset is done in full.
fn nothing_left(shape: &[Vec<IntPoint<i32>>], d: f64) -> bool {
    shape.iter().map(Vec::len).sum::<usize>() >= DISC_FIT_POINTS
        && disc_fit(shape, d, DISC_FIT_CELLS) == DiscFit::Nowhere
}

/// One square of [`disc_fit`]'s search: its center, half its side, and the most any point in it can be from the
/// nearest edge.
struct FitCell {
    x: f64,
    y: f64,
    half: f64,
    most: f64,
}

impl PartialEq for FitCell {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl Eq for FitCell {}

impl PartialOrd for FitCell {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for FitCell {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.most.total_cmp(&other.most)
    }
}

/// Whether a disc of radius `d` fits inside `shape` (by the positive winding rule over all of its rings), looking
/// at no more than `cells` squares. The bounds are split into squares, the one that could hold the farthest point
/// first. Moving a point changes its distance to the nearest edge by at most the distance moved, so no point of a
/// square is farther from the edges than its center plus half the square's diagonal. A square that falls short of
/// `d` that way, or lies wholly outside the shape (its center outside and no edge within half the diagonal), cannot
/// hold the center of such a disc and is dropped; any other square is split in four. A square center inside the
/// shape and at least `d` from every edge shows the disc fits. One unit of margin covers rounding. When every square
/// is dropped there is no point `d` from the edges, so an inward offset by `d` leaves nothing.
fn disc_fit(shape: &[Vec<IntPoint<i32>>], d: f64, cells: usize) -> DiscFit {
    let edges: Vec<[f64; 4]> = shape
        .iter()
        .filter(|r| r.len() >= 3)
        .flat_map(|r| {
            r.iter()
                .zip(r.iter().cycle().skip(1))
                .map(|(a, b)| [f64::from(a.x), f64::from(a.y), f64::from(b.x), f64::from(b.y)])
        })
        .collect();
    let Some(b) = bounds(&[shape.to_vec()]) else {
        return DiscFit::Undecided;
    };
    if edges.is_empty() || d.is_nan() || d <= 0.0 {
        return DiscFit::Undecided;
    }
    // Distance to the nearest edge, and whether the point is inside.
    let probe = |x: f64, y: f64| -> (f64, bool) {
        let mut near = f64::INFINITY;
        let mut winding = 0i32;
        for &[ax, ay, bx, by] in &edges {
            let (dx, dy) = (bx - ax, by - ay);
            let len2 = dx * dx + dy * dy;
            let t = if len2 > 0.0 {
                (((x - ax) * dx + (y - ay) * dy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let (ex, ey) = (ax + t * dx - x, ay + t * dy - y);
            near = near.min(ex * ex + ey * ey);
            let side = dx * (y - ay) - (x - ax) * dy;
            if ay <= y && by > y && side > 0.0 {
                winding += 1;
            } else if by <= y && ay > y && side < 0.0 {
                winding -= 1;
            }
        }
        (near.sqrt(), winding > 0)
    };
    let mut heap = std::collections::BinaryHeap::new();
    let mut seen = 0usize;
    // Looks at one square: Some(fits) settles it, None leaves it pushed or dropped.
    let mut look =
        |x: f64, y: f64, half: f64, heap: &mut std::collections::BinaryHeap<FitCell>| -> Option<DiscFit> {
            if seen >= cells {
                return Some(DiscFit::Undecided);
            }
            seen += 1;
            let (near, inside) = probe(x, y);
            if inside && near >= d {
                return Some(DiscFit::Fits);
            }
            let reach = half * std::f64::consts::SQRT_2;
            let most = near + reach;
            if most < d - 1.0 || (!inside && near >= reach) {
                return None;
            }
            heap.push(FitCell { x, y, half, most });
            None
        };
    let (cx, cy) = (
        f64::midpoint(f64::from(b[0]), f64::from(b[2])),
        f64::midpoint(f64::from(b[1]), f64::from(b[3])),
    );
    let half = 0.5 * (f64::from(b[2]) - f64::from(b[0])).max(f64::from(b[3]) - f64::from(b[1]));
    if let Some(found) = look(cx, cy, half, &mut heap) {
        return found;
    }
    while let Some(c) = heap.pop() {
        let h = 0.5 * c.half;
        for (sx, sy) in [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)] {
            if let Some(found) = look(c.x + sx * h, c.y + sy * h, h, &mut heap) {
                return found;
            }
        }
    }
    DiscFit::Nowhere
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

/// Growing unions of at least this many points, most of them in holes turned inside out, leave out the holes
/// that close. Smaller unions have smaller buffers and go through as they are.
const CLOSED_HOLES_MIN: usize = 32_000;

/// [`clipper_offset`] of `contours` grown by `delta` (positive), as one union; `hole` marks the holes. A hole
/// narrower than twice the offset closes: its moved contour turns inside out, crosses itself, and the union
/// fills it. A painted layer has thousands, and the union's buffers grow with every edge and crossing, so small
/// holes that provably close are left out first. The result is the same, point for point. When the proof
/// fails, all of them go through, as before.
fn grow_union(contours: &[Vec<IntPoint<i32>>], hole: &[bool], delta: i32) -> Shapes {
    grow_union_with(contours, hole, delta, false)
}

/// [`grow_union`], with the corners that turn past 120 degrees cut square when `square` is set (see
/// [`grow_open`]).
fn grow_union_with(contours: &[Vec<IntPoint<i32>>], hole: &[bool], delta: i32, square: bool) -> Shapes {
    let d = f64::from(delta);
    let (mut raw, mut turned) = (Vec::new(), Vec::new());
    for (c, &h) in contours.iter().zip(hole).filter(|(c, _)| c.len() >= 3) {
        let Some(r) = raw_loop_with(c, d, true, square) else {
            return clipper_offset(contours, delta);
        };
        // A hole that closes winds nowhere below zero, so its moved contour has a positive area.
        turned.push(h && crate::geom::area2_int(&r) > 0);
        raw.push(r);
    }
    let total: usize = raw.iter().map(Vec::len).sum();
    let in_turned: usize = raw
        .iter()
        .zip(&turned)
        .filter(|(_, t)| **t)
        .map(|(r, _)| r.len())
        .sum();
    let gone = if total < CLOSED_HOLES_MIN || in_turned * 2 < total {
        Vec::new()
    } else {
        untouched(&raw, &turned, delta)
    };
    if !gone.contains(&true) {
        return simplified(&raw, FillRule::Positive);
    }
    let pick = |g: bool| -> Vec<Vec<IntPoint<i32>>> {
        raw.iter()
            .zip(&gone)
            .filter(|(_, x)| **x == g)
            .map(|(r, _)| r.clone())
            .collect()
    };
    let (kept, left) = (pick(false), pick(true));
    // The solver of the whole union, so the edges kept are split the same way.
    let capacity = kept.iter().map(Vec::len).sum();
    let out = Overlay::new_custom(capacity, IntOverlayOptions::default(), solver_for(total))
        .simplify_source(&kept, FillRule::Positive);
    // No edge comes near a hole left out, so the loops kept wind the same number of times all over its bounds.
    // When that is at least once and the holes left out wind nowhere below zero, together the loops wind at
    // least once there, the union covers it, and none of the edges left out is on its outline.
    let covered = left
        .iter()
        .all(|r| r.first().is_some_and(|&p| winding(&out, p) > 0));
    if covered
        && left
            .chunks(256)
            .all(|b| simplified(b, FillRule::Negative).is_empty())
    {
        return out;
    }
    simplified(&raw, FillRule::Positive)
}

/// Which loops of `raw` that `turned` marks can be left out of the union: those no edge of a loop kept comes
/// near, within 0.1 mm of their bounds, past the drift of the points the union snaps over its passes (the snap
/// radius doubles its square each pass; this covers about sixteen). Their edges then meet no edge kept, so no
/// edge kept is split differently.
fn untouched(raw: &[Vec<IntPoint<i32>>], turned: &[bool], delta: i32) -> Vec<bool> {
    const MARGIN: i32 = 1_000;
    let boxes: Vec<([i32; 4], usize)> = raw
        .iter()
        .zip(turned)
        .enumerate()
        .filter_map(|(i, (r, &t))| {
            let [x0, y0, x1, y1] = ring_bounds(r).filter(|_| t)?;
            Some((
                [
                    x0.saturating_sub(MARGIN),
                    y0.saturating_sub(MARGIN),
                    x1.saturating_add(MARGIN),
                    y1.saturating_add(MARGIN),
                ],
                i,
            ))
        })
        .collect();
    let mut out = vec![false; raw.len()];
    for (_, i) in &boxes {
        if let Some(o) = out.get_mut(*i) {
            *o = true;
        }
    }
    // Most are small: sorted by their lowest y, those an edge can meet are a short run. The few tall ones are
    // looked at for every edge.
    let tall = delta.saturating_mul(16);
    let (mut small, big): (Vec<_>, Vec<_>) = boxes.into_iter().partition(|(b, _)| b[3] - b[1] <= tall);
    small.sort_unstable_by_key(|(b, _)| b[1]);
    // A loop kept brings its edges in, until none comes near a loop left out.
    let mut fresh: Vec<usize> = (0..raw.len()).filter(|&i| out.get(i) == Some(&false)).collect();
    while !fresh.is_empty() {
        let mut next = Vec::new();
        for (a, b) in fresh
            .iter()
            .filter_map(|&k| raw.get(k))
            .flat_map(|r| ring_edges(r))
        {
            let e = [a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y)];
            let lo = small.partition_point(|(bx, _)| bx[1] < e[1].saturating_sub(tall));
            let hi = small.partition_point(|(bx, _)| bx[1] <= e[3]);
            for (bx, i) in small.get(lo..hi).unwrap_or(&[]).iter().chain(&big) {
                if let Some(o) = out.get_mut(*i)
                    && *o
                    && overlaps(Some(*bx), Some(e))
                {
                    *o = false;
                    next.push(*i);
                }
            }
        }
        fresh = next;
    }
    out
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

/// Grows `shapes` by `delta` as [`offset`] does, except at a corner that turns past 120 degrees (sharper than 60):
/// there the corner is cut square, by the line at right angles to its bisector `delta` past the vertex, between the
/// two moved edges, where [`offset`] bevels through the ends of the moved edges, `delta` (1 - sin a) nearer the
/// vertex (a is half the corner's angle). This is the grow that opens a loop's area in the classic loop chain and
/// the gap walk, so the tip of a sharp wedge reaches as far as the area it was shrunk from allows. Every other
/// corner is joined as in [`offset`]. A `delta` of zero or less is [`offset`].
pub(crate) fn grow_open(shapes: &Shapes, delta: i32) -> Shapes {
    if delta <= 0 {
        return offset(shapes, delta);
    }
    let all: Vec<Vec<IntPoint<i32>>> = shapes.iter().flat_map(|s| s.iter().cloned()).collect();
    let hole: Vec<bool> = shapes.iter().flat_map(|s| (0..s.len()).map(|i| i > 0)).collect();
    grow_union_with(&all, &hole, delta, true)
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
    raw_loop_with(c, d, through, false)
}

/// [`raw_loop`]; with `square` and a growing `d`, a corner that turns past 120 degrees is cut square at `d` past
/// the vertex (Clipper's square join) in place of the bevel.
fn raw_loop_with(c: &[IntPoint<i32>], d: f64, through: bool, square: bool) -> Option<Vec<IntPoint<i32>>> {
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
        if gap && dot < -0.5 && square && d > 0.0 {
            // Each moved edge runs on past the vertex by d tan(turn / 4) to the square cut.
            let t = (cross.m_atan2(dot) / 4.0).m_tan();
            r.push(round_pt(
                px + d * (prev.0 - prev.1 * t),
                py + d * (prev.1 + prev.0 * t),
            ));
            r.push(round_pt(
                px + d * (cur.0 + cur.1 * t),
                py + d * (cur.1 - cur.0 * t),
            ));
        } else if gap && dot < -0.5 {
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
/// (a contour flipped or any two edges touch). A shape that comes apart
/// where the miter loop cut a piece away comes back as the union's pieces.
fn fast_offset(shape: &[Vec<IntPoint<i32>>], delta: i32) -> Option<Shapes> {
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
    let mut split = false;
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
        let lobes = remove_swallowtails(&mut r, area_in > 0);
        if r.len() < 3 {
            return None;
        }
        // A loop cut with a piece of the contour's own winding in it may have taken a piece of the shape with
        // it: the far arm of a U whose band closed. Not when the piece lies inside what is left (covered twice).
        if !lobes.is_empty() {
            let left = vec![vec![r.clone()]];
            split |= lobes
                .iter()
                .any(|l| inner_point(l).is_none_or(|p| winding(&left, p) == 0));
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
    // Most pieces cut that way are corners of the miters, which the union drops too. When the union keeps more
    // contours, the shape came apart into pieces one contour per input contour cannot hold, so the union's
    // result is the offset.
    if split {
        let union = clipper_offset(shape, delta);
        if union.iter().map(Vec::len).sum::<usize>() > out.len() {
            return Some(union);
        }
    }
    Some(vec![out])
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

/// Twice the area (internal units) of a piece of the contour's own winding that a cut loop is checked for:
/// 0.0001 mm2.
const LOST_PIECE: i64 = 20_000;

/// Cuts out small loops whose winding is opposite to the contour's
/// (`ccw` is the contour's winding), replacing them by the crossing point.
/// Returns the pieces of the loops cut that wind the contour's way and are
/// larger than [`LOST_PIECE`], as when the band joining the two arms of a U
/// closes and the loop around the band takes in the far arm too.
fn remove_swallowtails(r: &mut Vec<IntPoint<i32>>, ccw: bool) -> Vec<Vec<IntPoint<i32>>> {
    let mut lobes = Vec::new();
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
                own_pieces(&loop_pts, area, ccw, &mut lobes);
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
    lobes
}

/// Adds to `out` the pieces of loop `l` (twice signed area `area`) that wind the way `ccw` says and are larger
/// than [`LOST_PIECE`]. A simple loop is one piece; one that crosses itself goes through the union.
fn own_pieces(l: &[IntPoint<i32>], area: i64, ccw: bool, out: &mut Vec<Vec<IntPoint<i32>>>) {
    let ring = [l.to_vec()];
    if !any_crossing(&ring) {
        if (area > 0) == ccw && area.abs() > LOST_PIECE {
            out.extend(ring);
        }
        return;
    }
    let [mut ring] = ring;
    if !ccw {
        ring.reverse();
    }
    for piece in simplified(&[ring], FillRule::Positive) {
        if piece.iter().map(|c| crate::geom::area2_int(c)).sum::<i64>().abs() > LOST_PIECE
            && let Some(outline) = piece.into_iter().next()
        {
            out.push(outline);
        }
    }
}

/// A point inside ring `r`: halfway between the first two crossings of the line across the middle of its bounds.
#[allow(
    clippy::cast_possible_truncation,
    reason = "the point lies inside the ring's bounds"
)]
fn inner_point(r: &[IntPoint<i32>]) -> Option<IntPoint<i32>> {
    let b = ring_bounds(r)?;
    let y = f64::from(b[1]) + (f64::from(b[3]) - f64::from(b[1])) / 2.0 + 0.25;
    let mut xs: Vec<f64> = ring_edges(r)
        .filter(|(p, q)| (f64::from(p.y) <= y) != (f64::from(q.y) <= y))
        .map(|(p, q)| {
            let t = (y - f64::from(p.y)) / (f64::from(q.y) - f64::from(p.y));
            f64::from(p.x) + t * (f64::from(q.x) - f64::from(p.x))
        })
        .collect();
    xs.sort_by(f64::total_cmp);
    let (&x0, &x1) = (xs.first()?, xs.get(1)?);
    Some(IntPoint::new(
        f64::midpoint(x0, x1).round() as i32,
        y.round() as i32,
    ))
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
    /// Where the top surfaces over the island end beside the walls, with variable-width walls (`arachne::top_edge`).
    pub(crate) top_edge: Option<TopEdge>,
    /// Classic walls under a one-wall top's band (`only_one_wall_top`), whose infill area starts where the band's
    /// rules put it.
    pub(crate) band: bool,
    /// The band's own part of the infill area, out to where its lines end ([`BandEnds`]): it prints as top surface,
    /// also where the layer above leaves sparse infill under it.
    pub(crate) band_area: Shapes,
}

/// The top surfaces over an island of variable-width walls start at the innermost wall's spacing edge, without the
/// `overlap` (internal units) the infill area reaches into the wall, except in `keep`, which keeps it.
#[derive(Debug, Clone, Default)]
pub(crate) struct TopEdge {
    pub(crate) overlap: i32,
    pub(crate) keep: Shapes,
}

/// Whether top surfaces get one wall. A Bambu Studio config says so with `top_one_wall_type`: `all top` and `topmost`
/// give one wall, `not apply` keeps every wall, and that printer's slicer does not read `only_one_wall_top` at all, so
/// a config with one of those values goes by it whatever `only_one_wall_top` says. `topmost` reads as `all top`: the
/// two print the same on a part with one top level, and they have not been compared on parts with more. Any other
/// config, and a value of another name, goes by `only_one_wall_top`.
pub(crate) fn one_wall_top(cfg: &crate::config::PrintConfig) -> bool {
    let kind = cfg.raw.get("top_one_wall_type").and_then(|v| match v {
        serde_json::Value::Array(a) if a.len() == 1 => a.first().and_then(serde_json::Value::as_str),
        other => other.as_str(),
    });
    match kind.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("all top" | "topmost") => true,
        Some("not apply") => false,
        _ => crate::tower::flag(cfg, "only_one_wall_top"),
    }
}

/// What `only_one_wall_top` needs to know about the neighbor layers: the material above (the
/// slice of the layer above) and, when there is one, the material below.
pub(crate) struct TopCtx<'a> {
    pub(crate) upper: &'a Shapes,
    pub(crate) lower: Option<&'a Shapes>,
    /// The slice two layers up, when the layer above is not the topmost one: where the layer above keeps its inner
    /// walls, which a classic one-wall top band stays outside of.
    pub(crate) above: Option<&'a Shapes>,
}

/// At sparse infill density 0 with fixed-width walls, a narrow top or first-layer piece too narrow for one surface
/// line (R under the surface's line spacing) keeps its gap fill bead. With `false` it prints walls only, which
/// leaves a slot up to about a line wide open between the walls.
pub(crate) const SPARSE0_NARROW_GAP_FILL: bool = true;

/// How far a surface line's room is pulled in from each end, along the line, to test that the line prints, for lines
/// `spacing` apart (internal units): a line prints where the free width along it is at least the surface's own
/// spacing, the same width at which lines along a strip start, whatever pitch the lines spread to across them. Half
/// a micrometer less, so an edge that strays a few tenths of a micrometer keeps the line.
pub(crate) fn line_room(spacing: f64) -> f64 {
    spacing / 2.0 - 2.5
}

/// The part of `shapes` that stays covered when moved `reach` both ways along the unit vector `dir`: the shapes
/// pulled in by `reach` along that direction only (internal units).
pub(crate) fn erode_along(shapes: &Shapes, dir: (f64, f64), reach: f64) -> Shapes {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a fraction of a millimeter in internal units"
    )]
    let (dx, dy) = ((dir.0 * reach).round() as i32, (dir.1 * reach).round() as i32);
    let shift = |dx: i32, dy: i32| -> Shapes {
        shapes
            .iter()
            .map(|s| {
                s.iter()
                    .map(|r| r.iter().map(|p| IntPoint::new(p.x + dx, p.y + dy)).collect())
                    .collect()
            })
            .collect()
    };
    intersection(&shift(dx, dy), &shift(-dx, -dy))
}

/// A layer's surfaces whose lines spread evenly across each piece (the top surfaces, or the first layer's bottom
/// surface), as narrow pieces between fixed-width walls at sparse infill density 0 see them: such a piece prints
/// surface lines when they fit, else gap fill.
pub(crate) struct NarrowSurface<'a> {
    /// The outline of the layer above, so the surfaces are what it leaves uncovered; `None` when all of the layer
    /// is surface (the first layer, or nothing above).
    pub(crate) upper: Option<&'a Shapes>,
    /// The material of the layer below, above the first layer: a piece over air is a bridge, not this surface.
    pub(crate) lower: Option<&'a Shapes>,
    /// The surface's own line spacing, internal units.
    pub(crate) spacing: i32,
    /// How far the surface's lines spread past the edge of the infill area, internal units (negative: in).
    pub(crate) edge: i32,
    /// The direction the surface's lines run on the plate, a unit vector.
    pub(crate) line: (f64, f64),
    /// Sparse infill density 0 with fixed-width walls: narrow pieces wide enough for a line print one.
    pub(crate) no_sparse: bool,
    /// How far an uncovered area is opened, which drops the slivers along its edge (a tenth of the outer wall's
    /// width, as the surfaces are found), internal units.
    pub(crate) opening: i32,
    /// A monotonic line top on a Bambu Lab printer, whose lines keep one grid: every narrow piece of the surface is
    /// surface, printing the grid's lines that fit and gap fill around them; narrow pieces elsewhere keep their gap
    /// fill.
    pub(crate) grid: bool,
    /// Lines across a piece fit once it is one spacing wide along them ([`line_room`]), as the surface fill's room
    /// rule prints them. Off on Bambu Lab printers, whose surface fill has no room rule: there a line fits where the
    /// piece holds a line of its pitch plus 0.05 mm, as the fill prints it.
    pub(crate) room: bool,
}

impl NarrowSurface<'_> {
    /// The part of `one` that is surface.
    fn exposed(&self, one: &Shapes) -> Shapes {
        let free = match self.upper {
            None => one.clone(),
            Some(up) => {
                let free = difference(one, up);
                if free.is_empty() {
                    return free;
                }
                offset(&offset(&free, -self.opening), self.opening)
            }
        };
        match self.lower {
            Some(below) if !free.is_empty() => intersection(&free, below),
            _ => free,
        }
    }

    /// Whether the surface's lines fit in `piece` of the infill area anywhere: the piece with its edge moved out as
    /// the lines spread is somewhere at least the surface's own spacing wide along the lines ([`line_room`]),
    /// whatever pitch the lines spread to across them, or without [`Self::room`] holds a line of that pitch plus
    /// 0.05 mm. A piece the lines run across, narrower than that along them, holds none.
    fn lines_fit(&self, piece: &Shapes) -> bool {
        let moved = if self.edge == 0 {
            piece.clone()
        } else {
            offset(piece, self.edge)
        };
        if self.room {
            return !erode_along(&moved, self.line, line_room(f64::from(self.spacing))).is_empty();
        }
        // The piece's extent across the lines sets their pitch.
        let (u, v) = self.line;
        let (lo, hi) = moved
            .iter()
            .flat_map(|s| s.iter())
            .flat_map(|r| r.iter())
            .map(|p| v.mul_add(-f64::from(p.x), u * f64::from(p.y)))
            .fold((f64::MAX, f64::MIN), |(a, b), q| (a.min(q), b.max(q)));
        if hi <= lo {
            return false;
        }
        let (pitch, _) = crate::session::stretch_pitch(hi - lo, f64::from(self.spacing.max(1)));
        // The line's ends keep a hair less than half the pitch in; half a micrometer more, so a line that would come
        // out a few tenths of a micrometer short does not count.
        #[allow(clippy::cast_precision_loss, reason = "a few internal units")]
        let hair = crate::bridging::HAIR as f64;
        let reach = f64::midpoint(pitch - 2.0 * hair, f64::from(crate::geom::mm(0.05))) + 5.0;
        !erode_along(&moved, self.line, reach).is_empty()
    }

    /// Whether any of `region` is surface, so its walls may differ from the walls the layers around share.
    pub(crate) fn touches(&self, region: &Shapes) -> bool {
        self.upper.is_none_or(|_| !self.exposed(region).is_empty())
    }
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
        false,
        None,
    )
}

/// How far a classic one-wall top band's step is pulled in before it is grown back into the band: the mean of half
/// the outer wall and the inner wall, and half a micrometer more. Whether a piece of the step gets a band at all is
/// [`classic_top_room`]'s test.
fn classic_top_cut(ext: i32, inner: i32) -> i32 {
    i32::midpoint(ext / 2, inner) + 5
}

/// The width a piece of a classic one-wall top's step must clear for a band, internal units: `top_area_threshold`
/// of the larger of the inner wall's width and the outer wall's spacing. The setting is a percent of that width (200
/// by default) or a width in mm. With 0.42 and 0.45 mm walls on 0.2 mm layers it is 0.90 mm.
fn classic_top_threshold(cfg: &crate::config::PrintConfig, ext: i32, inner: i32) -> i32 {
    let scale = crate::geom::SCALE;
    let base = (f64::from(inner) / scale).max(cfg.spacing_for(f64::from(ext) / scale));
    let value = match cfg.raw.get("top_area_threshold") {
        Some(serde_json::Value::Array(a)) => a.first(),
        other => other,
    };
    let width = value
        .and_then(|v| crate::config::float_or_percent(v, base))
        .filter(|t| t.is_finite())
        .unwrap_or(2.0 * base);
    crate::geom::mm(width.max(0.0))
}

/// Where a classic one-wall top band can start on the island `one`: the points more than half the outer wall's
/// width (`ext`) inside its outline that lie more than half the threshold width ([`classic_top_threshold`]) from the
/// layer above, given as `clear`, the layer above grown by that half. A piece of the step gets a band only when it
/// reaches into this area, so a slot from an edge needs to be wider than the threshold and longer than half the
/// outer wall plus half the threshold, and a straight ledge deeper than that second width. Half a micrometer more
/// each way, so a step of exactly those widths, a few tenths of a micrometer off, prints none.
fn classic_top_room(one: &Shapes, clear: &Shapes, ext: i32) -> Shapes {
    difference(&offset(one, -(ext / 2 + 5)), clear)
}

/// The layer above grown by half the threshold width and half a micrometer, for [`classic_top_room`].
fn classic_top_clear(upper: &Shapes, threshold: i32) -> Shapes {
    offset(upper, threshold / 2 + 5)
}

/// Where a classic one-wall top band's lines end, internal units: `near` from this layer's outer wall center line,
/// `far` and `ledge` from the layer above's, so a sloped band's far end is its step plus `far`. Measured on 0.42 mm
/// outer and 0.45 mm inner walls (and 0.40 and 0.44, 0.50 inner, 0.62 on a 0.6 mm nozzle) at 0.12 to 0.3 mm layers
/// and 0 to 30 percent overlap.
#[derive(Debug, Clone, Copy)]
pub(crate) struct BandEnds {
    /// 0.55 of the outer wall's width less 0.12 of the layer height, at any overlap.
    pub(crate) near: i32,
    /// 0.954 of the outer wall's width plus 0.6 of an inner wall spacing per wall past the first, the spacing taken at
    /// the layer's height. The overlap does not move it.
    pub(crate) far: i32,
    /// Where the layer above is a flat ledge (the layer over it covers it), the far end: the nearer of `far` and
    /// 0.9932 of the way to the inner edge of the walls (half the outer wall plus the inner walls) less 0.9286 of the
    /// overlap. On 0.42 mm outer and 0.45 mm inner walls that is 0.6555 mm less 0.39 mm times the overlap's share
    /// of the line width.
    pub(crate) ledge: i32,
}

/// [`BandEnds`] for outer and inner walls `ext` and `inner` wide, `wall_loops` of them (two or more), on a layer
/// `layer_height` mm thick, at the walls' `overlap`.
pub(crate) fn band_line_ends(
    ext: i32,
    inner: i32,
    wall_loops: u32,
    layer_height: f64,
    overlap: i32,
) -> BandEnds {
    let mm = crate::geom::mm;
    let inner_mm = f64::from(inner) / crate::geom::SCALE;
    let spacing = mm((inner_mm - layer_height * (1.0 - std::f64::consts::FRAC_PI_4)).max(inner_mm * 0.5));
    #[allow(clippy::cast_possible_wrap, reason = "wall counts are capped at 50")]
    let inners = (wall_loops as i32 - 1).max(1);
    let far = ext * 954 / 1000 + inners * spacing * 3 / 5;
    let edge = ext / 2 + inner * inners;
    let ledge = (edge * 1311 / 1320 - overlap * 13 / 14).min(far);
    BandEnds {
        near: ext * 55 / 100 - mm(0.12 * layer_height),
        far,
        ledge,
    }
}

/// The outer wall's width and how far in from its outline a classic one-wall top's surface starts so its lines end
/// half that width in from the wall's center line at any overlap, internal units, for line width `w`.
pub(crate) fn classic_top_start(cfg: &crate::config::PrintConfig, w: i32) -> (i32, i32) {
    let ext = if cfg.has_feature_widths() {
        crate::geom::mm(cfg.outer_wall_width())
    } else {
        w
    };
    let ends = crate::geom::mm(cfg.top_surface_width()) * 45 / 1000;
    (ext, ext - ends)
}

/// How far past the cut a classic one-wall top band's tail runs on, internal units, before the band's own growth: with
/// that growth the band ends about 0.7 mm past where a step that narrows along the outline falls below the cut-off.
const CLASSIC_TOP_TAIL: i32 = 2_500;

/// The tails of a classic one-wall top band, the parts of `step` past the sharp tips of `wide` (the step shrunk by
/// `cut`) where the step narrows along the outline of `one`, for the band to grow from. A step that narrows gradually
/// leaves `wide` ending in a thin point, and growing it back bevels that point, so without a tail the band would stop
/// short of where the step falls below the cut-off. A tip that runs along the outline keeps a line from it, `cut` plus
/// [`CLASSIC_TOP_TAIL`] on, inside `one` and no further than twice `cut` from its outline. A tip that points into the
/// part, as the end of a slot the layer above cuts into the step does, or out of it, gets none, so a slot keeps its
/// gap fill. Each tail is the step within `cut` plus the tail of `wide`, in a strip along the tip's axis from `cut`
/// behind the tip to that line's end, four times `cut` wide.
fn classic_top_tails(wide: &Shapes, step: &Shapes, one: &Shapes, cut: i32) -> Shapes {
    let c = f64::from(cut);
    let run = c + f64::from(CLASSIC_TOP_TAIL);
    let sign = one
        .first()
        .and_then(|s| s.first())
        .map_or(1, |r| crate::geom::area2_int(r).signum());
    let to_outline = |p: IntPoint<i32>| {
        let (qx, qy) = (f64::from(p.x), f64::from(p.y));
        let mut best = f64::MAX;
        for r in one.iter().flatten() {
            for (j, s) in r.iter().enumerate() {
                let Some(e) = r.get((j + 1) % r.len()) else {
                    continue;
                };
                let (sx, sy) = (f64::from(s.x), f64::from(s.y));
                let (wx, wy) = (f64::from(e.x) - sx, f64::from(e.y) - sy);
                let l2 = wx * wx + wy * wy;
                let t = if l2 > 0.0 {
                    (((qx - sx) * wx + (qy - sy) * wy) / l2).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                best = best.min((qx - sx - t * wx).m_hypot(qy - sy - t * wy));
            }
        }
        best
    };
    let mut strips: Shapes = Vec::new();
    for ring in wide.iter().flatten() {
        let n = ring.len();
        for (i, v) in ring.iter().enumerate() {
            let (Some(a), Some(b)) = (ring.get((i + n - 1) % n), ring.get((i + 1) % n)) else {
                continue;
            };
            let (ix, iy) = (f64::from(v.x - a.x), f64::from(v.y - a.y));
            let (ox, oy) = (f64::from(b.x - v.x), f64::from(b.y - v.y));
            let (li, lo) = (ix.m_hypot(iy), ox.m_hypot(oy));
            if li == 0.0 || lo == 0.0 {
                continue;
            }
            let (ix, iy, ox, oy) = (ix / li, iy / li, ox / lo, oy / lo);
            // A tip: a corner of the area that turns past 120 degrees, which the grow bevels.
            let (dot, cross) = (ix * ox + iy * oy, iy * (-ox) - (-ix) * oy);
            if cross <= 0.0 || dot >= -0.5 {
                continue;
            }
            let (dx, dy) = (ix - ox, iy - oy);
            let dl = dx.m_hypot(dy);
            let (dx, dy) = (dx / dl, dy / dl);
            let (vx, vy) = (f64::from(v.x), f64::from(v.y));
            let end = round_pt(vx + dx * run, vy + dy * run);
            if winding(one, end) == 0 || to_outline(end) > 2.0 * c {
                continue;
            }
            let (nx, ny) = (-dy * 2.0 * c, dx * 2.0 * c);
            let (bx, by) = (vx - dx * c, vy - dy * c);
            let (fx, fy) = (vx + dx * run, vy + dy * run);
            let mut strip = vec![
                round_pt(bx + nx, by + ny),
                round_pt(bx - nx, by - ny),
                round_pt(fx - nx, fy - ny),
                round_pt(fx + nx, fy + ny),
            ];
            if crate::geom::area2_int(&strip).signum() != sign {
                strip.reverse();
            }
            strips.push(vec![strip]);
        }
    }
    if strips.is_empty() {
        return Vec::new();
    }
    intersection(
        &intersection(step, &grow_open(wide, cut + CLASSIC_TOP_TAIL)),
        &union_all(&[&strips]),
    )
}

// a false result guarantees that the context-free classic walls are unchanged.
pub(crate) fn classic_top_candidate(
    cfg: &crate::config::PrintConfig,
    region: &Shapes,
    w: i32,
    top: &TopCtx,
) -> bool {
    let (ext, inner) = if cfg.has_feature_widths() {
        (
            crate::geom::mm(cfg.outer_wall_width()),
            crate::geom::mm(cfg.inner_wall_width()),
        )
    } else {
        (w, w)
    };
    let clear = classic_top_clear(top.upper, classic_top_threshold(cfg, ext, inner));
    region.iter().any(|shape| {
        // no band where no piece of the step from this outline in to the layer above clears the threshold.
        !classic_top_room(&vec![shape.clone()], &clear, ext).is_empty()
    })
}

/// Whether fixed-width walls lay the first inner wall the mean of the two widths in from the outer wall, as
/// `precise_outer_wall` does with the inner walls printed first, rather than the mean of the two spacings. The
/// walls and the surface edge read this one switch, so the two never disagree.
pub(crate) fn precise_inner_walls(cfg: &crate::config::PrintConfig) -> bool {
    crate::tower::flag_or(cfg, "precise_outer_wall", true)
        && cfg.wall_sequence == crate::config::WallSequence::InnerOuter
}

/// How classic walls of line width `w` are laid, internal units: the outer and inner walls' widths, the inner wall's
/// loop pitch (its spacing, width less the rounded corners) and the first inner wall's pitch from the outer one (the
/// mean of the two widths under [`precise_inner_walls`], else the mean of the two spacings).
#[derive(Debug, Clone, Copy)]
pub(crate) struct ClassicPitch {
    pub(crate) ext: i32,
    pub(crate) inner: i32,
    pub(crate) spacing: i32,
    pub(crate) spacing2: i32,
}

impl ClassicPitch {
    /// The innermost of `wall_loops` (2 or more) walls' spacing edge, in from the outline: the outer wall's
    /// centerline, the first inner wall's pitch, an inner spacing per further wall, and half an inner spacing.
    pub(crate) fn spacing_edge(self, wall_loops: u32) -> i32 {
        #[allow(clippy::cast_possible_wrap, reason = "wall counts are capped at 50")]
        let more = wall_loops.max(2) as i32 - 2;
        self.ext / 2 + self.spacing2 + self.spacing * more + self.spacing / 2
    }
}

/// [`ClassicPitch`] for `cfg`, whose walls are `w` wide without widths of their own.
pub(crate) fn classic_pitch(cfg: &crate::config::PrintConfig, w: i32) -> ClassicPitch {
    let mm = crate::geom::mm;
    let (ext, inner) = if cfg.has_feature_widths() {
        (mm(cfg.outer_wall_width()), mm(cfg.inner_wall_width()))
    } else {
        (w, w)
    };
    let pitch = |width: i32| mm(cfg.spacing_for(f64::from(width) / crate::geom::SCALE));
    let spacing2 = if precise_inner_walls(cfg) {
        i32::midpoint(ext, inner)
    } else {
        i32::midpoint(pitch(ext), pitch(inner))
    };
    ClassicPitch {
        ext,
        inner,
        spacing: pitch(inner),
        spacing2,
    }
}

/// Where the top surface and the internal solid infill over `wall_loops` classic walls start, internal units in from
/// the outline, and where the infill area the walls leave starts (the outer wall's width and an inner wall's width per
/// further wall, less the walls' `overlap`). A monotonic line top surface starts at the innermost wall's spacing edge
/// ([`ClassicPitch::spacing_edge`]), with no overlap term. The internal solid infill and the other top surfaces start
/// that edge less `share` (the walls' infill wall overlap, a share) of the mean of the inner wall's and the internal
/// solid infill's spacings. So both follow the layer height and the precise outer wall setting as the walls do, where
/// the infill area follows the walls' widths. On the stock P1S settings (0.2 mm layers, 15 percent) with precise
/// outer wall off, a monotonic line top's lines end 0.614, 1.022 and 1.429 mm in from the outer wall's centerline on
/// 2, 3 and 4 walls, and the internal solid infill's 0.725, 1.132 and 1.539. `None` with under two walls or
/// variable-width walls.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ClassicEdges {
    pub(crate) top_line: i32,
    pub(crate) solid: i32,
    pub(crate) infill: i32,
}

/// [`ClassicEdges`] of `cfg` on `wall_loops` walls of line width `w`.
pub(crate) fn classic_edges(
    cfg: &crate::config::PrintConfig,
    wall_loops: u32,
    w: i32,
    overlap: i32,
    share: f64,
) -> Option<ClassicEdges> {
    if wall_loops < 2 || cfg.arachne_walls() {
        return None;
    }
    let p = classic_pitch(cfg, w);
    let edge = p.spacing_edge(wall_loops);
    let solid = cfg.spacing_for(cfg.solid_infill_width());
    let back = share * f64::midpoint(f64::from(p.spacing) / crate::geom::SCALE, solid);
    #[allow(clippy::cast_possible_wrap, reason = "wall counts are capped at 50")]
    let infill = p.ext + p.inner * (wall_loops as i32 - 1) - overlap;
    Some(ClassicEdges {
        top_line: edge,
        solid: edge - crate::geom::mm(back),
        infill,
    })
}

/// [`walls_for`] with the neighbor layers known, so `only_one_wall_top` can give top surfaces one wall.
/// `one_wall_layer`: `only_one_wall_first_layer` or `only_one_wall_top` took the layer's walls down to one.
/// `narrow`: the layer's surfaces, where with fixed-width walls at sparse infill density 0 a narrow piece the lines
/// run across without room for one keeps its gap fill.
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
    one_wall_layer: bool,
    narrow: Option<&NarrowSurface>,
) -> (Vec<IslandWalls>, Shapes) {
    if cfg.arachne_walls() {
        crate::arachne::island_walls(
            region,
            cfg,
            wall_loops,
            overlap,
            layer_height,
            top_or_bottom,
            top,
            one_wall_layer,
        )
    } else {
        let mm = crate::geom::mm;
        let laid = classic_pitch(cfg, w);
        let ClassicPitch {
            ext, inner, spacing2, ..
        } = laid;
        let pitch = |width: i32| mm(cfg.spacing_for(f64::from(width) / crate::geom::SCALE));
        // With sparse infill and two walls or more, a strip of infill area whose free width inside the innermost wall
        // (less the overlap) is under 0.15 of an inner spacing prints walls only: the infill area is opened by at least the strip
        // width that holds. That width is the free width plus how far the infill area reaches past the free
        // width's edge on each side.
        let min_core = if cfg.sparse_infill_density > 0.0 && overlap > 0 && wall_loops > 1 {
            let spacing = pitch(inner);
            let free_edge = laid.spacing_edge(wall_loops);
            #[allow(clippy::cast_possible_wrap, reason = "wall counts are capped at 50")]
            let inset = ext + inner * (wall_loops as i32 - 1) - overlap;
            spacing * 3 / 20 + 2 * (free_edge - inset)
        } else if cfg.sparse_infill_density > 0.0
            && overlap > 0
            && wall_loops == 1
            && !crate::firmware::bambu_printer(cfg, cfg.gcode_flavor)
        {
            // One wall: the same, inside the outer wall's spacing edge. It only bites at overlaps above about a
            // quarter of a line, where the usual opening would keep a strip that prints walls only.
            let spacing = pitch(ext);
            spacing * 3 / 20 + 2 * (ext / 2 + spacing / 2 - (ext - overlap))
        } else {
            0
        };
        // With no sparse infill, a thin strip is infill area once it holds a surface line: the surface's own spacing
        // and edge on the layer's surfaces, the top surface's elsewhere. On Bambu Lab printers only the layer's
        // surfaces that spread their lines ([`NarrowSurface`], the first layer) do this.
        let surface = narrow.filter(|n| n.no_sparse);
        let thin = (thin_infill(cfg) || surface.is_some()).then(|| {
            let edge = if let Some(n) = surface {
                Some(n.edge)
            } else {
                let line = f64::from(mm(cfg.line_width).max(1));
                crate::session::surface_edge(cfg, layer_height, f64::from(overlap) / line, wall_loops).map(mm)
            };
            let spacing = surface.map_or_else(|| mm(cfg.spacing_for(cfg.top_surface_width())), |n| n.spacing);
            // A hair under the spacing: a hundredth, or on Bambu Lab printers and inside one wall a thousandth, where
            // a strip 0.3 % too narrow for a line keeps its gap fill.
            let fits = if wall_loops == 1 || crate::firmware::bambu_printer(cfg, cfg.gcode_flavor) {
                spacing * 999 / 1000
            } else {
                spacing * 99 / 100
            };
            ThinStrips {
                min_width: if surface.is_some_and(|n| n.grid) {
                    None
                } else {
                    edge.map(|e| fits - 2 * e)
                },
                narrow_gap_fill: SPARSE0_NARROW_GAP_FILL,
                surface,
            }
        });
        // The one-wall top's walls leave every thin strip to the infill area.
        let thin_all = thin.as_ref().map(|_| ThinStrips {
            min_width: None,
            narrow_gap_fill: true,
            surface: None,
        });
        let normal = |shapes: &Shapes| {
            walls_gapped(
                shapes,
                wall_loops,
                ext,
                inner,
                overlap,
                Some((pitch(inner), spacing2, layer_height)),
                thin.as_ref(),
                min_core,
            )
        };
        let Some(top) = top.filter(|_| wall_loops > 1) else {
            return normal(region);
        };
        let cut = classic_top_cut(ext, inner);
        let threshold = classic_top_threshold(cfg, ext, inner);
        let clear = classic_top_clear(top.upper, threshold);
        let mut islands = Vec::new();
        let mut cores = Vec::new();
        for shape in region {
            let one = vec![shape.clone()];
            let room = classic_top_room(&one, &clear, ext);
            if room.is_empty() {
                let (walls, core) = normal(&one);
                islands.extend(walls);
                cores.extend(core);
                continue;
            }
            let (mut outer, outer_core) = walls_gapped(
                &one,
                1,
                ext,
                inner,
                overlap,
                Some((pitch(inner), spacing2, layer_height)),
                thin_all.as_ref(),
                0,
            );
            // The band is grown from the step itself, from this layer's outline in to the layer above, whatever the
            // wall count. Grown from inside the one wall instead, the step would have to be wider by the wall's inset
            // before any band printed.
            let mut step = difference(&one, top.upper);
            // The part of the band over air, which stays out of it.
            let over = top
                .lower
                .map(|lower| difference(&difference(&outer_core, top.upper), lower))
                .filter(|over| !over.is_empty());
            if let Some(over) = &over {
                step = difference(&step, &offset(over, ext.max(inner)));
            }
            // Where the band's surface lines end ([`BandEnds`]). Each wall past the first is left out under the band
            // and moves the far end 0.6 of an inner wall spacing further in. The surface's lines end `ends` inside the
            // area they fill (0.045 of their width), so the area reaches that much further.
            let ends = mm(cfg.top_surface_width()) * 45 / 1000;
            let line_ends = band_line_ends(ext, inner, wall_loops, layer_height, overlap);
            let reach = ext / 2 + line_ends.far + ends;
            // Each piece of the step is judged on its own: only the pieces that reach into the room clear the
            // threshold, and the rest keep the usual walls.
            step.retain(|piece| !intersection(&vec![piece.clone()], &room).is_empty());
            // The band is the part of the step wider than `cut` twice over, grown back by `cut` and on by `reach`,
            // plus the tails where the step narrows along the outline ([`classic_top_tails`]), grown by `reach`.
            let wide = offset(&step, -cut);
            let mut grown = offset(&wide, cut + reach);
            let tails = classic_top_tails(&wide, &step, &one, cut);
            if !tails.is_empty() {
                grown = union_all(&[&grown, &grow_open(&tails, reach)]);
            }
            // A piece that clears a threshold under the cut's width can vanish when pulled in by the cut: it is
            // pulled in by no more than it clears instead.
            let least = (ext / 2).min(threshold / 2).min(cut);
            for piece in &step {
                let piece = vec![piece.clone()];
                if intersection(&piece, &wide).is_empty() {
                    grown = union_all(&[&grown, &offset(&offset(&piece, -least), least + reach)]);
                }
            }
            let mut exposed = intersection(&grown, &outer_core);
            // The lines start `near` in at any overlap, so where the overlap leaves the infill area further in, the
            // band's part of it grows out to there.
            let near = ext / 2 + line_ends.near - ends;
            let short = ext - overlap - near;
            if short > 0 {
                exposed = intersection(&grown, &offset(&outer_core, short));
            }
            exposed = intersection(&exposed, &offset(&one, -near));
            // Where the layer above is a flat ledge (the layer over it covers it there), the band's lines end
            // `ledge` past that layer's outer wall center line, so a larger overlap shortens them. Where the layer
            // above steps in again, the band runs its full length.
            if let Some(above) = top.above {
                #[allow(clippy::cast_possible_wrap, reason = "wall counts are capped at 50")]
                let inners = inner * (wall_loops as i32 - 1);
                let upper_band = offset(&difference(top.upper, above), reach + inners);
                // The lines end `ledge` past the layer above's outer wall center line.
                let inside = difference(&offset(top.upper, -(ext / 2 + line_ends.ledge)), &upper_band);
                if !inside.is_empty() {
                    exposed = difference(&exposed, &offset(&inside, -ends));
                }
            }
            let hide = inner * 85 / 100;
            if let Some(over) = &over {
                // No nearer the part over air than the wall line's reach alone leaves it.
                exposed = difference(&exposed, &offset(over, ext.max(inner) - hide));
            }
            if exposed.is_empty() {
                let (walls, core) = normal(&one);
                islands.extend(walls);
                cores.extend(core);
                continue;
            }
            // preserve the first inner wall's centerline distance from the outer wall.
            let remaining = difference(&offset(&one, -(ext / 2 + spacing2 - inner / 2)), &exposed);
            let (inside, core) = walls_gapped(
                &remaining,
                wall_loops - 1,
                inner,
                inner,
                overlap,
                Some((pitch(inner), pitch(inner), layer_height)),
                thin_all.as_ref(),
                0,
            );
            let mut joined = IslandWalls {
                band: true,
                band_area: exposed.clone(),
                ..IslandWalls::default()
            };
            for mut island in inside {
                for (index, _) in &mut island.loops {
                    *index += 1;
                }
                joined.loops.extend(island.loops);
                joined.gaps.extend(island.gaps);
                joined.gap_lines.extend(island.gap_lines);
            }
            for island in outer.drain(..) {
                joined.loops.extend(island.loops);
                joined.gaps.extend(island.gaps);
                joined.gap_lines.extend(island.gap_lines);
            }
            islands.push(joined);
            cores.extend(union_all(&[&exposed, &core]));
        }
        (islands, cores)
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
    walls_gapped(region, wall_loops, ext, inner, overlap, None, None, 0)
}

/// True when classic walls leave their thin strips to the infill area instead of gap fill on every layer: with no
/// sparse infill, on printers other than Bambu Lab's (there only on the first layer, through its [`NarrowSurface`]).
/// A strip between the walls too narrow for the infill area's usual opening, which a gap fill bead fills when there
/// is sparse infill, is then infill area on every layer once it holds a surface line ([`ThinStrips`]): nothing on a
/// sparse layer, internal solid infill under a top, and a top surface line, as in other slicers.
fn thin_infill(cfg: &crate::config::PrintConfig) -> bool {
    cfg.sparse_infill_density <= 0.0 && !crate::firmware::bambu_printer(cfg, cfg.gcode_flavor)
}

/// Which thin strips between classic walls with no sparse infill ([`thin_infill`]) are left to the infill area.
pub(crate) struct ThinStrips<'a> {
    /// The narrowest infill area, as the walls leave it, that holds one surface line: the surface's spacing (a hair
    /// under) less how far its lines spread past the infill area's edge on each side, internal units. A strip whose
    /// infill area is narrower keeps its gap fill bead. `None`: every strip is left to the infill area.
    pub(crate) min_width: Option<i32>,
    /// [`SPARSE0_NARROW_GAP_FILL`]: with `false` a strip narrower than `min_width` prints walls only.
    pub(crate) narrow_gap_fill: bool,
    /// The layer's surfaces, where a piece the lines run across without room for one keeps its gap fill.
    pub(crate) surface: Option<&'a NarrowSurface<'a>>,
}

/// [`walls_with`] that finds gaps the way Orca does when given the loop pitch and the pitch between
/// the outer and first inner wall. With `thin` ([`thin_infill`]) a gap strip whose infill area holds a surface line
/// is infill area, with no gap fill bead. `min_core` is the narrowest strip of infill area kept, at least the usual
/// 0.54 of a width.
#[allow(
    clippy::too_many_arguments,
    reason = "the walls' widths and pitches, and the thin strip rules"
)]
pub(crate) fn walls_gapped(
    region: &Shapes,
    wall_loops: u32,
    ext: i32,
    inner: i32,
    overlap: i32,
    gap_pitches: Option<(i32, i32, f64)>,
    thin: Option<&ThinStrips>,
    min_core: i32,
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
            // narrow crescent does not keep a sliver of a wall. The opening cuts a sharp point
            // square ([`grow_open`]).
            let min_spacing = spacing * 6 / 10;
            for k in 0..wall_loops {
                let last = if let Some(prev) = chain.last() {
                    let d = if k == 1 { spacing2 } else { spacing };
                    grow_open(&offset(prev, -(d + min_spacing / 2 - 1)), min_spacing / 2 - 1)
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
        let min = (w * 27 / 50).max(min_core);
        let mut core = if inset > 0 {
            offset(&offset(&one, -(inset + min / 2)), min / 2)
        } else {
            one.clone()
        };
        if let (true, Some((spacing, spacing2, height))) = (wall_loops > 0, gap_pitches) {
            // With no sparse infill ([`ThinStrips`]) a strip between the walls whose infill area holds a surface
            // line is left to the infill area; a narrower one keeps its gap fill bead, or with
            // `narrow_gap_fill` off prints walls only.
            let unopened = thin.filter(|_| inset > 0).map(|_| offset(&one, -inset));
            let masks = thin.zip(unopened.as_ref()).map(|(rule, all)| {
                let mut wide = match rule.min_width {
                    Some(m) if m > 0 => offset(&offset(all, -(m / 2)), m / 2),
                    _ => all.clone(),
                };
                if let Some(n) = rule.surface {
                    // On the surface, a piece the lines run across without room for one keeps its gap fill.
                    let exposed = n.exposed(&one);
                    if n.grid {
                        // Only the surface's own narrow pieces.
                        wide.retain(|p| {
                            !exposed.is_empty() && !intersection(&vec![p.clone()], &exposed).is_empty()
                        });
                    } else if !exposed.is_empty() {
                        wide.retain(|p| {
                            let piece = vec![p.clone()];
                            intersection(&piece, &exposed).is_empty() || n.lines_fit(&piece)
                        });
                    }
                }
                let flipped = !rule.narrow_gap_fill && rule.min_width.is_some();
                let drop = if flipped { all.clone() } else { Vec::new() };
                (wide, drop, flipped)
            });
            let found = crate::gapfill::find_orca(
                &one,
                &chain,
                wall_loops,
                ext,
                inner,
                spacing,
                spacing2,
                height,
                masks.as_ref().map(|(wide, drop, _)| (wide, drop)),
            );
            if let (Some(all), false) = (&unopened, found.given.is_empty()) {
                // The strips the gap finder leaves to the infill area are infill area as the walls leave it.
                core = union_all(&[&core, &intersection(all, &offset(&found.given, spacing / 2))]);
            }
            island.gap_lines = found.lines;
            if !found.covered.is_empty() {
                // Orca takes the filled strips out of the innermost wall's area before the infill's inset,
                // so the infill keeps half a loop pitch away from a gap bead.
                core = difference(&core, &offset(&found.covered, spacing / 2));
            }
            if !found.dropped.is_empty() {
                core = difference(&core, &offset(&found.dropped, spacing / 2));
            }
            if let Some((wide, _, true)) = &masks {
                // Infill area too narrow for a surface line prints nothing either.
                let narrow = difference(&core, &offset(wide, 10));
                if !narrow.is_empty() {
                    core = difference(&core, &narrow);
                }
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

    /// Tree support base areas from a slice, as `(delta, rings)`. Neither holds a disc of radius 4.3156 mm: by a grid
    /// distance check the widest is 3.46 mm across one and 2.69 mm across the other, and the narrow side of each
    /// outline's bounds (7.65 and 7.20 mm) is under twice the shrink.
    fn shrunk_past_cases() -> Vec<(i32, Shapes)> {
        fixture_cases(include_str!("../tests/fixtures/offset-shrink-past/cases.json"))
    }

    /// `(delta, rings)` pairs from a fixture file, each as one shape.
    fn fixture_cases(json: &str) -> Vec<(i32, Shapes)> {
        let cases: Vec<(i32, Vec<Vec<[i32; 2]>>)> = serde_json::from_str(json).unwrap();
        cases
            .into_iter()
            .map(|(delta, rings)| {
                let shape = rings
                    .iter()
                    .map(|r| r.iter().map(|&[x, y]| IntPoint::new(x, y)).collect())
                    .collect();
                (delta, vec![shape])
            })
            .collect()
    }

    #[test]
    fn shrinking_past_the_widest_disc_leaves_nothing() {
        // The union of the moved loops used to keep a sliver inside each of these (0.83 and 0.03 mm2).
        for (delta, shapes) in shrunk_past_cases() {
            assert!(offset(&shapes, delta).is_empty(), "shrink by {delta} left area");
            // Half the shrink fits inside both, so area remains.
            assert!(
                !offset(&shapes, delta / 2).is_empty(),
                "shrink by {} left nothing",
                delta / 2
            );
        }
    }

    /// A 10 mm square turned 45 degrees: the largest disc inside has a radius of 50,000.27 units, and its bounds are
    /// wide enough that the bounds and area check lets every shrink below 70,711 through.
    fn turned_square() -> Vec<Vec<IntPoint<i32>>> {
        vec![vec![
            IntPoint::new(0, -70_711),
            IntPoint::new(70_711, 0),
            IntPoint::new(0, 70_711),
            IntPoint::new(-70_711, 0),
        ]]
    }

    #[test]
    fn disc_fit_tells_a_fitting_disc_from_none() {
        let sq = turned_square();
        assert!(!shrinks_away(&sq, 50_001.0));
        assert_eq!(disc_fit(&sq, 49_990.0, DISC_FIT_CELLS), DiscFit::Fits);
        assert_eq!(disc_fit(&sq, 50_100.0, DISC_FIT_CELLS), DiscFit::Nowhere);
        // A hole in the middle leaves room only in the corners, each well under 25,000 units across.
        let mut holed = sq.clone();
        holed.push(vec![
            IntPoint::new(0, -40_000),
            IntPoint::new(-40_000, 0),
            IntPoint::new(0, 40_000),
            IntPoint::new(40_000, 0),
        ]);
        assert_eq!(disc_fit(&holed, 30_000.0, DISC_FIT_CELLS), DiscFit::Nowhere);
        assert_eq!(disc_fit(&holed, 5_000.0, DISC_FIT_CELLS), DiscFit::Fits);
    }

    #[test]
    fn shrinking_where_no_disc_fits_leaves_nothing() {
        // Tree support base areas whose quick miter offset fails and that pass the bounds and area check, but hold no
        // disc of the shrink's radius: by a separate grid check the largest is 3.51 mm against 4.28 mm, and 3.44 mm
        // against 4.32 mm. The union of moved loops kept 0.13 and 0.0001 mm2 in them.
        for (delta, shapes) in
            fixture_cases(include_str!("../tests/fixtures/offset-shrink-past/disc-fit.json"))
        {
            let shape = &shapes[0];
            assert!(!shrinks_away(shape, -f64::from(delta)));
            assert_eq!(
                disc_fit(shape, -f64::from(delta), DISC_FIT_CELLS),
                DiscFit::Nowhere
            );
            assert!(offset(&shapes, delta).is_empty(), "shrink by {delta} left area");
            assert!(
                !offset(&shapes, delta / 2).is_empty(),
                "shrink by {} left nothing",
                delta / 2
            );
        }
    }

    #[test]
    fn disc_fit_out_of_cells_does_the_offset_in_full() {
        // Less than a unit over the largest disc: no square near the middle can be dropped, so the cells run out
        // whatever the budget.
        let sq = turned_square();
        for cells in [1, DISC_FIT_CELLS, 4096] {
            assert_eq!(disc_fit(&sq, 50_001.0, cells), DiscFit::Undecided);
        }
        // The same square with 40 points on each side, past the point floor, so only the cells decide.
        let corners = &sq[0];
        let fine: Vec<IntPoint<i32>> = (0..4)
            .flat_map(|i| {
                let (a, b) = (corners[i], corners[(i + 1) % 4]);
                (0..40).map(move |k| IntPoint::new(a.x + (b.x - a.x) * k / 40, a.y + (b.y - a.y) * k / 40))
            })
            .collect();
        let fine = vec![fine];
        assert!(fine[0].len() >= DISC_FIT_POINTS);
        assert!(!shrinks_away(&fine, 50_001.0));
        assert_eq!(disc_fit(&fine, 50_001.0, DISC_FIT_CELLS), DiscFit::Undecided);
        assert_eq!(disc_fit(&fine, 50_001.0, 4096), DiscFit::Undecided);
        assert!(!nothing_left(&fine, 50_001.0));
        // So the offset is the full one, never an early empty.
        let full = fast_offset(&fine, -50_001).unwrap_or_else(|| clipper_offset(&fine, -50_001));
        assert_eq!(offset(&vec![fine.clone()], -50_001), full);
    }

    #[test]
    fn a_shrink_to_half_the_narrow_side_leaves_nothing() {
        // A 10 by 30 mm plate: 4.9 mm in leaves a strip, 5 mm in leaves nothing.
        let plate = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(300_000, 0),
            IntPoint::new(300_000, 100_000),
            IntPoint::new(0, 100_000),
        ]]];
        assert!(!offset(&plate, -49_000).is_empty());
        assert!(offset(&plate, -50_000).is_empty());
    }

    /// The plain union of every moved contour, as growing offsets were before closed holes were left out.
    fn grow_all(shapes: &Shapes, delta: i32) -> Shapes {
        let all: Vec<Vec<IntPoint<i32>>> = shapes.iter().flat_map(|s| s.iter().cloned()).collect();
        clipper_offset(&all, delta)
    }

    /// A hole: a ten-pointed star, clockwise, `2 r` across, so its moved contour crosses itself.
    fn star_hole(cx: i32, cy: i32, r: i32) -> Vec<IntPoint<i32>> {
        // Directions every 36 degrees, in thousandths.
        const DIRS: [(i32, i32); 10] = [
            (1_000, 0),
            (809, 588),
            (309, 951),
            (-309, 951),
            (-809, 588),
            (-1_000, 0),
            (-809, -588),
            (-309, -951),
            (309, -951),
            (809, -588),
        ];
        DIRS.iter()
            .enumerate()
            .rev()
            .map(|(i, &(x, y))| {
                let k = if i % 2 == 0 { r } else { r * 2 / 5 };
                IntPoint::new(cx + x * k / 1_000, cy + y * k / 1_000)
            })
            .collect()
    }

    #[test]
    fn growing_past_many_small_holes_gives_the_plain_union() {
        // Two plates with a few thousand holes, one to a 0.65 mm cell, between 0.02 and 0.58 mm across: most
        // close at 0.2 mm, some stay, some sit by the edge, neighbors come close, and a ring inside a large hole
        // has small holes of its own.
        let mut seed = 0x2545_f491_u32;
        let mut next = |m: u32| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            i32::try_from(seed % m).unwrap_or(0)
        };
        let big = [100_000, 100_000, 200_000, 200_000];
        let mut shapes: Shapes = Vec::new();
        for (x0, w) in [(0, 300_000), (400_000, 200_000)] {
            let mut shape = vec![rect(x0, 0, x0 + w, 300_000)];
            if x0 == 0 {
                shape.push(rect(big[0], big[1], big[2], big[3]).into_iter().rev().collect());
            }
            for cy in (3_250..300_000).step_by(6_500) {
                for cx in (x0 + 3_250..x0 + w).step_by(6_500) {
                    let r = 100 + next(2_800);
                    let (cx, cy) = (cx + next(400) - 200, cy + next(400) - 200);
                    if x0 == 0 && cx + r >= big[0] && cx - r <= big[2] && cy + r >= big[1] && cy - r <= big[3]
                    {
                        continue;
                    }
                    if next(3) == 0 {
                        shape.push(
                            rect(cx - r, cy - r / 2, cx + r, cy + r / 2)
                                .into_iter()
                                .rev()
                                .collect(),
                        );
                    } else {
                        shape.push(star_hole(cx, cy, r));
                    }
                }
            }
            shapes.push(shape);
        }
        // An island in the large hole, with small holes of its own.
        let mut island = vec![rect(120_000, 120_000, 180_000, 180_000)];
        for i in 0..40 {
            island.push(star_hole(
                125_000 + (i % 8) * 7_000,
                125_000 + (i / 8) * 11_000,
                300 + i * 40,
            ));
        }
        shapes.push(island);
        let all: Vec<Vec<IntPoint<i32>>> = shapes.iter().flat_map(|s| s.iter().cloned()).collect();
        let hole: Vec<bool> = shapes.iter().flat_map(|s| (0..s.len()).map(|i| i > 0)).collect();
        for delta in [2_000, 6_000] {
            let (raw, turned) = moved(&all, &hole, delta);
            let total: usize = raw.iter().map(Vec::len).sum();
            let gone = untouched(&raw, &turned, delta);
            let (n, holes) = (
                gone.iter().filter(|g| **g).count(),
                hole.iter().filter(|h| **h).count(),
            );
            assert!(
                n > 0 && n < holes && (delta > 2_000 || n > holes / 4),
                "delta {delta}: {n} of {holes} holes left out"
            );
            let kept: Vec<Vec<IntPoint<i32>>> = raw
                .iter()
                .zip(&gone)
                .filter(|(_, g)| !**g)
                .map(|(r, _)| r.clone())
                .collect();
            let plain = grow_all(&shapes, delta);
            assert_eq!(
                Overlay::new_custom(total, IntOverlayOptions::default(), solver_for(total))
                    .simplify_source(&kept, FillRule::Positive),
                plain,
                "delta {delta}"
            );
            assert_eq!(grow_union(&all, &hole, delta), plain, "delta {delta}");
            if delta == 2_000 {
                assert!(takes_lean_path(&raw, &turned));
            }
        }
    }

    /// The moved contours, and which are holes turned inside out.
    fn moved(all: &[Vec<IntPoint<i32>>], hole: &[bool], delta: i32) -> (Vec<Vec<IntPoint<i32>>>, Vec<bool>) {
        all.iter()
            .zip(hole)
            .filter_map(|(c, &h)| {
                let r = raw_loop(c, f64::from(delta), true)?;
                let t = h && crate::geom::area2_int(&r) > 0;
                Some((r, t))
            })
            .unzip()
    }

    /// Whether the union is large enough, with enough holes turned inside out, for holes to be left out.
    fn takes_lean_path(raw: &[Vec<IntPoint<i32>>], turned: &[bool]) -> bool {
        let total: usize = raw.iter().map(Vec::len).sum();
        let t: usize = raw
            .iter()
            .zip(turned)
            .filter(|(_, t)| **t)
            .map(|(r, _)| r.len())
            .sum();
        total >= CLOSED_HOLES_MIN && t * 2 >= total
    }

    #[test]
    fn holes_with_nothing_around_them_take_the_plain_union() {
        // Holes that close, outside the only outline: the loops kept wind zero times around them.
        let mut all = vec![rect(0, 0, 10_000, 10_000)];
        for k in 0..3_300 {
            all.push(star_hole(
                20_000 + (k % 60) * 6_500,
                20_000 + (k / 60) * 6_500,
                1_000,
            ));
        }
        let hole: Vec<bool> = (0..all.len()).map(|i| i > 0).collect();
        let (raw, turned) = moved(&all, &hole, 2_000);
        assert!(takes_lean_path(&raw, &turned));
        assert!(untouched(&raw, &turned, 2_000).iter().skip(1).all(|g| *g));
        assert_eq!(grow_union(&all, &hole, 2_000), clipper_offset(&all, 2_000));
    }

    #[test]
    fn untouched_keeps_holes_that_stay_open_or_touch_the_outline() {
        let d = 2_000;
        let mut shape = vec![rect(0, 0, 200_000, 100_000)];
        // Closes: 1 mm wide, far from everything.
        shape.push(rect(50_000, 50_000, 52_000, 51_000).into_iter().rev().collect());
        // Stays open: 3 mm across.
        shape.push(rect(100_000, 40_000, 130_000, 70_000).into_iter().rev().collect());
        // Closes, but its box meets the moved outline.
        shape.push(rect(180_000, 99_000, 182_000, 99_500).into_iter().rev().collect());
        let raw: Vec<Vec<IntPoint<i32>>> = shape
            .iter()
            .filter_map(|c| raw_loop(c, f64::from(d), true))
            .collect();
        let turned: Vec<bool> = raw
            .iter()
            .enumerate()
            .map(|(i, r)| i > 0 && crate::geom::area2_int(r) > 0)
            .collect();
        assert_eq!(turned, vec![false, true, false, true]);
        assert_eq!(untouched(&raw, &turned, d), vec![false, true, false, false]);
    }

    /// The two points of the only ring of `shapes` within 0.03 mm of its leftmost point, which on a wedge whose
    /// point faces -X are the ends of its flat.
    fn tip_flat(shapes: &Shapes) -> (IntPoint<i32>, IntPoint<i32>) {
        let ring = match shapes.as_slice() {
            [s] => s.first().unwrap(),
            _ => panic!("{} shapes", shapes.len()),
        };
        let x0 = ring.iter().map(|p| p.x).min().unwrap();
        let tip: Vec<IntPoint<i32>> = ring.iter().copied().filter(|p| p.x - x0 < 300).collect();
        assert_eq!(tip.len(), 2, "{tip:?}");
        (tip[0], tip[1])
    }

    #[test]
    fn grow_open_cuts_a_sharp_corner_square_past_the_vertex() {
        // A wedge 24 mm long that widens to 2.4 mm (5.7 degrees at the point), shrunk by a pitch and the margin
        // and grown back by the margin, 0.1131 mm, as the loop chain opens it.
        let wedge: Shapes = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(240_000, 0),
            IntPoint::new(240_000, 24_000),
        ]]];
        let r = 1_131;
        let shrunk = offset(&wedge, -(3_921 + r));
        let (a, b) = tip_flat(&grow_open(&shrunk, r));
        let flat = f64::from(a.x - b.x).m_hypot(f64::from(a.y - b.y));
        assert!((flat - 2_152.0).abs() <= 20.0, "flat {flat}");
        // The bevel through the ends of the moved edges sits r (1 - sin a) further back along the bisector.
        let (c, e) = tip_flat(&offset(&shrunk, r));
        let mid = |p: IntPoint<i32>, q: IntPoint<i32>| {
            (
                f64::midpoint(f64::from(p.x), f64::from(q.x)),
                f64::midpoint(f64::from(p.y), f64::from(q.y)),
            )
        };
        let (m0, m1) = (mid(a, b), mid(c, e));
        let nearer = (m1.0 - m0.0).m_hypot(m1.1 - m0.1);
        assert!((nearer - 1_075.0).abs() <= 30.0, "nearer {nearer}");
        assert!(m0.0 < m1.0);
        // Corners that turn by 120 degrees or less are joined as before.
        let square = vec![vec![rect(0, 0, 100_000, 100_000)]];
        let shrunk = offset(&square, -(3_921 + r));
        assert_eq!(grow_open(&shrunk, r), offset(&shrunk, r));
        let hexagon: Vec<IntPoint<i32>> = (0..6)
            .map(|k| {
                let t = f64::from(k) * std::f64::consts::FRAC_PI_3;
                round_pt(50_000.0 * t.m_cos(), 50_000.0 * t.m_sin())
            })
            .collect();
        let hexagon = vec![vec![hexagon]];
        assert_eq!(grow_open(&hexagon, r), offset(&hexagon, r));
        assert_eq!(grow_open(&wedge, -r), offset(&wedge, -r));
    }

    #[test]
    fn classic_top_keeps_covered_bridging_and_narrow_ledge_walls() {
        let cfg = crate::config::PrintConfig::from_json(br#"{"wall_generator":"classic","wall_loops":3,"outer_wall_line_width":0.42,"inner_wall_line_width":0.45,"min_width_top_surface":"300%"}"#).unwrap();
        let region = vec![vec![rect(0, 0, 300_000, 300_000)]];
        let empty = Vec::new();
        let narrow = vec![vec![rect(1_000, 0, 300_000, 300_000)]];
        let run =
            |top: Option<&TopCtx>| walls_for_top(&cfg, &region, 3, 4_200, 630, 0.2, false, top, false, None);
        let expected = format!("{:?}", run(None));
        for context in [
            TopCtx {
                upper: &region,
                lower: Some(&region),
                above: None,
            },
            TopCtx {
                upper: &empty,
                lower: Some(&empty),
                above: None,
            },
            TopCtx {
                upper: &narrow,
                lower: Some(&region),
                above: None,
            },
        ] {
            assert_eq!(format!("{:?}", run(Some(&context))), expected);
        }
    }

    #[test]
    fn classic_top_preserves_holes_and_separate_islands() {
        let cfg = crate::config::PrintConfig::from_json(br#"{"wall_generator":"classic","wall_loops":3,"outer_wall_line_width":0.42,"inner_wall_line_width":0.45}"#).unwrap();
        let mut hole = rect(100_000, 100_000, 200_000, 200_000);
        hole.reverse();
        let region = vec![
            vec![rect(0, 0, 300_000, 300_000), hole],
            vec![rect(400_000, 0, 600_000, 200_000)],
        ];
        let upper = Vec::new();
        let context = TopCtx {
            upper: &upper,
            lower: Some(&region),
            above: None,
        };
        let (old, old_core) = walls_for_top(&cfg, &region, 3, 4_200, 630, 0.2, false, None, false, None);
        let (new, core) = walls_for_top(
            &cfg,
            &region,
            3,
            4_200,
            630,
            0.2,
            false,
            Some(&context),
            false,
            None,
        );
        let outer = |walls: &[IslandWalls]| {
            walls
                .iter()
                .flat_map(|s| &s.loops)
                .filter(|(i, _)| *i == 0)
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(outer(&old), outer(&new));
        assert_eq!(new.len(), region.len());
        assert!(new.iter().flat_map(|s| &s.loops).all(|(i, _)| *i == 0));
        assert!(difference(&core, &region).is_empty());
        assert!(difference(&old_core, &core).is_empty());
        assert!(!difference(&core, &old_core).is_empty());
    }

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

    /// A point in internal units from millimeters.
    #[allow(clippy::cast_possible_truncation, reason = "test points stay on the bed")]
    fn mm(x: f64, y: f64) -> IntPoint<i32> {
        IntPoint::new(
            (x * crate::geom::SCALE).round() as i32,
            (y * crate::geom::SCALE).round() as i32,
        )
    }

    /// The area of each piece of `shapes` in mm2 (its outline less its holes), smallest first.
    #[allow(clippy::cast_precision_loss, reason = "test areas")]
    fn piece_areas(shapes: &Shapes) -> Vec<f64> {
        let mut a: Vec<f64> = shapes
            .iter()
            .map(|s| {
                s.iter().map(|r| crate::geom::area2_int(r)).sum::<i64>().abs() as f64
                    / 2.0
                    / (crate::geom::SCALE * crate::geom::SCALE)
            })
            .collect();
        a.sort_by(f64::total_cmp);
        a
    }

    /// True when `a` and `b` have as many pieces, each pair of areas within 1% plus 0.0005 mm2.
    fn same_pieces(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len()
            && a.iter()
                .zip(b)
                .all(|(x, y)| (x - y).abs() <= 0.01 * y.abs() + 0.000_5)
    }

    /// A 1 x 2 mm U open to the left at `x`, `y`: arms 0.5 mm thick, a 1 mm gap, a 0.2 mm band joining them.
    fn u_shape(x: f64, y: f64) -> Vec<IntPoint<i32>> {
        [
            (0.0, 0.5),
            (0.0, 0.0),
            (1.0, 0.0),
            (1.0, 2.0),
            (0.0, 2.0),
            (0.0, 1.5),
            (0.8, 1.5),
            (0.8, 0.5),
        ]
        .iter()
        .map(|&(px, py)| mm(x + px, y + py))
        .collect()
    }

    #[test]
    fn an_inward_offset_keeps_both_arms_of_a_u() {
        // Moved in by 0.2 mm the band goes, leaving two arms 0.6 x 0.1 mm (0.06 mm2 each).
        let u: Shapes = vec![vec![u_shape(0.0, 0.0)]];
        let out = offset(&u, -2_000);
        let areas = piece_areas(&out);
        assert!(same_pieces(&areas, &[0.06, 0.06]), "pieces {areas:?}");
        assert!(same_pieces(&areas, &piece_areas(&clipper_offset(&u[0], -2_000))));
    }

    #[test]
    fn an_inward_offset_keeps_every_arm_of_two_us() {
        let us: Shapes = vec![vec![u_shape(0.0, 0.0)], vec![u_shape(3.0, 0.5)]];
        let areas = piece_areas(&offset(&us, -2_000));
        assert!(same_pieces(&areas, &[0.06; 4]), "pieces {areas:?}");
    }

    #[test]
    fn an_inward_offset_keeps_both_posts_of_an_h() {
        // Posts 0.5 x 2 mm, 1 mm apart, joined at mid height by a 0.2 mm bar: both ends of the bar close.
        let h: Shapes = vec![vec![
            [
                (0.0, 0.0),
                (0.5, 0.0),
                (0.5, 0.9),
                (1.5, 0.9),
                (1.5, 0.0),
                (2.0, 0.0),
                (2.0, 2.0),
                (1.5, 2.0),
                (1.5, 1.1),
                (0.5, 1.1),
                (0.5, 2.0),
                (0.0, 2.0),
            ]
            .iter()
            .map(|&(x, y)| mm(x, y))
            .collect(),
        ]];
        // Each post comes out 0.1 x 1.6 mm.
        let areas = piece_areas(&offset(&h, -2_000));
        assert!(same_pieces(&areas, &[0.16, 0.16]), "pieces {areas:?}");
    }

    #[test]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::cast_sign_loss,
        reason = "small test counts and offsets"
    )]
    fn thin_shapes_keep_the_pieces_the_union_keeps() {
        // Combs: two to four arms of random thickness and length, a random gap apart, joined at one end by a band
        // of random width, turned by a random angle and moved in by a random way, so the band often closes and
        // the arms come apart.
        let mut seed = 0x9e37_79b9_u32;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            f64::from(seed % 10_000) / 10_000.0
        };
        let (mut failed, mut split) = (Vec::new(), 0);
        for case in 0..300 {
            let arms = 2 + (next() * 3.0) as usize;
            let band = 0.15 + 0.35 * next();
            // Up the band's right side, then each arm from the top: its top edge out to the left, back along its
            // bottom edge, and down the band's left side to the next arm.
            let mut y = 0.0;
            let mut spans = Vec::new();
            for _ in 0..arms {
                let t = 0.3 + 0.5 * next();
                spans.push((y, y + t, 0.8 + 2.0 * next()));
                y += t + 0.2 + 0.8 * next();
            }
            let top = spans.last().map_or(0.0, |s| s.1);
            let mut pts = vec![(band, 0.0), (band, top)];
            for (k, &(y0, y1, len)) in spans.iter().enumerate().rev() {
                pts.push((-len, y1));
                pts.push((-len, y0));
                if k > 0 {
                    pts.push((0.0, y0));
                    pts.push((0.0, spans.get(k - 1).map_or(0.0, |s| s.1)));
                }
            }
            // Any corner may come first.
            let first = (next() * pts.len() as f64) as usize;
            let last = pts.len() - 1;
            pts.rotate_left(first.min(last));
            let (s, c) = (next() * std::f64::consts::TAU).m_sin_cos();
            let ring: Vec<IntPoint<i32>> = pts
                .iter()
                .map(|&(x, y)| mm(x * c - y * s, x * s + y * c))
                .collect();
            let d = -((0.05 + 0.3 * next()) * crate::geom::SCALE) as i32;
            let shape = vec![ring];
            let fast = piece_areas(&offset(&vec![shape.clone()], d));
            let union = piece_areas(&clipper_offset(&shape, d));
            split += usize::from(union.len() > 1);
            if !same_pieces(&fast, &union) {
                failed.push((case, fast, union));
            }
        }
        // Enough of them come apart for the check to mean something.
        assert!(split > 50, "{split} split");
        assert!(
            failed.is_empty(),
            "{} of 300 differ: {:?}",
            failed.len(),
            failed.first()
        );
    }

    /// Fixed-width walls with no sparse infill, on the Ender-3 V3's numbers (0.42 mm walls, 0.2 mm layers, a 0.3771
    /// mm spacing, a quarter of a width of overlap and the surface's edge 0.0537 mm past the infill area): a strip
    /// whose infill area holds one surface line (1.740 mm wide, R = s0) is infill area with no gap fill bead whatever
    /// [`SPARSE0_NARROW_GAP_FILL`] says; a narrower one (1.721 mm, R = 0.95 s0) keeps its bead with the switch on and
    /// prints walls only with it off.
    #[test]
    fn thin_strips_with_no_sparse_infill_follow_the_gap_fill_switch() {
        let strip = |w: i32| -> Shapes {
            shapes_from_loops(&[vec![
                Point::new(0, 0),
                Point::new(300_000, 0),
                Point::new(300_000, w),
                Point::new(0, w),
            ]])
        };
        let run = |w: i32, narrow_gap_fill: bool| {
            let rule = ThinStrips {
                min_width: Some(3_771 * 99 / 100 - 2 * 537),
                narrow_gap_fill,
                surface: None,
            };
            walls_gapped(
                &strip(w),
                2,
                4_200,
                4_200,
                1_050,
                Some((3_771, 3_771, 0.2)),
                Some(&rule),
                0,
            )
        };
        for narrow_gap_fill in [true, false] {
            let (islands, core) = run(17_400, narrow_gap_fill);
            assert!(islands[0].gap_lines.is_empty(), "{narrow_gap_fill}");
            assert!(!core.is_empty(), "{narrow_gap_fill}");
            let (islands, core) = run(17_210, narrow_gap_fill);
            assert_eq!(!islands[0].gap_lines.is_empty(), narrow_gap_fill);
            assert!(core.is_empty(), "{narrow_gap_fill}");
        }
    }

    /// A straight piece of free width R along its lines holds a line once R reaches the surface's own spacing s0,
    /// whatever pitch the lines spread to across them (s0, 1.004 s0 on a long strip, 1.2 s0 capped on a short one).
    #[test]
    fn a_line_across_a_piece_fits_once_the_piece_is_one_spacing_wide_along_it() {
        let s0 = 3_771;
        let surface = NarrowSurface {
            upper: None,
            lower: None,
            spacing: s0,
            edge: 0,
            line: (1.0, 0.0),
            no_sparse: true,
            opening: 0,
            grid: false,
            room: true,
        };
        // The piece's extent across the lines, and the pitch the lines spread to over it.
        for (across, pitch) in [
            (80 * s0, 1.0),
            (78 * s0 * 1_004 / 1_000, 1.004),
            (s0 * 3 / 2, 1.2),
        ] {
            let (spread, _) = crate::session::stretch_pitch(f64::from(across), f64::from(s0));
            assert!(
                (spread / f64::from(s0) - pitch).abs() < 1e-3,
                "{across}: {spread}"
            );
            let piece = |r: i32| -> Shapes { vec![vec![rect(0, 0, r, across)]] };
            assert!(surface.lines_fit(&piece(s0 + 10)), "{pitch} s0: R = s0 + 1 um");
            assert!(!surface.lines_fit(&piece(s0 - 10)), "{pitch} s0: R = s0 - 1 um");
        }
    }
}
