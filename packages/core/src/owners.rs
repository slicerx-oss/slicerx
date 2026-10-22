// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Which plate object each path of a layer belongs to ([`crate::output::PathInfo::owner`]). The object labels a
//! printer skips objects by (`firmware::Labels`), the preview's object pick and the plate check all read it.
//!
//! A plate printed by object, or by layer with a session per object (objects with settings of their own, height
//! ranges, turned objects) and copies append each object's layers as one block: the owner is stamped there
//! (`sequence.rs`, `copies.rs`). A plate printed by layer as one session merges every object's area into the
//! regions of its filaments, so a wall or infill path is made without knowing its object. There each path takes
//! the object whose own slice on the layer holds it, and a path that runs from one object into another (objects
//! that touch) is cut where it crosses, so each piece carries its own owner:
//!
//! - a point belongs to the first object in plate order whose slice holds it, so a point on the boundary two
//!   objects share, or inside two objects that overlap, always goes to the same one;
//! - a cut adds a point on the segment: the same line, the same extrusion, no travel;
//! - skirt, prime tower and custom paths belong to no object; a brim to the object it goes round, none when it
//!   goes round several; support to the object above it (the first layer up where an object comes within the
//!   support's margin of the middle of the path's box), else the nearest object on its own layer, else the nearest
//!   on any layer up, however far: every support path carries an object's label;
//! - a support path whose box reaches under two objects (tree support under two shelves, merged on the first
//!   layers) is cut like a wall where it passes from under one object to under another: a point takes the first
//!   object up whose slice holds it. A stretch under no object takes the object of the nearer stretch under one,
//!   along the path (round it, for a loop), so skipping one object never leaves half of the other's loop.

use crate::geom::{Point, SCALE};
use crate::output::{Feature, LayerPaths, PathInfo};
use crate::perimeters::Shapes;
use crate::preview::OBJECT_NONE;

/// One object's slice on a layer.
#[derive(Debug, Clone)]
pub(crate) struct ObjectSlice {
    /// The object's index on the plate.
    pub(crate) object: u16,
    pub(crate) shapes: Shapes,
    /// `[x0, y0, x1, y1]`, internal units.
    pub(crate) bounds: [i32; 4],
}

/// The objects' slices on one layer, in plate order.
pub(crate) type Slices = Vec<ObjectSlice>;

/// Support segments longer than this, mm, are sampled for a change of owner even when their ends agree.
const SUPPORT_STEP_MM: f64 = 1.0;
/// How far up the support's owner is looked for, layers.
const SUPPORT_REACH: usize = 400;
/// How far past the object above it a support path may start and still be that object's, mm.
const SUPPORT_MARGIN_MM: f64 = 2.0;
/// How far from an object a brim or support path may start and still belong to it, mm.
const NEAR_MM: f64 = 20.0;

/// The object whose slice holds `p`: the first in plate order.
pub(crate) fn holder(slices: &[ObjectSlice], p: Point) -> Option<u16> {
    slices
        .iter()
        .find(|s| {
            p.x >= s.bounds[0]
                && p.x <= s.bounds[2]
                && p.y >= s.bounds[1]
                && p.y <= s.bounds[3]
                && crate::support::point_in(&s.shapes, p.x, p.y)
        })
        .map(|s| s.object)
}

fn mm(p: Point) -> [f64; 2] {
    [f64::from(p.x) / SCALE, f64::from(p.y) / SCALE]
}

fn seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    };
    let (x, y) = (a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
    (x * x + y * y).sqrt()
}

/// The object whose slice is nearest `p` (its edge), within `reach` mm; the first in plate order on a tie.
pub(crate) fn nearest(slices: &[ObjectSlice], p: Point, reach: f64) -> Option<u16> {
    nearest_of(slices, p, reach, &|_| true)
}

/// [`nearest`] among the objects `keep` passes.
fn nearest_of(slices: &[ObjectSlice], p: Point, reach: f64, keep: &dyn Fn(u16) -> bool) -> Option<u16> {
    let kept = || slices.iter().filter(|s| keep(s.object));
    if let Some(s) = kept().find(|s| holder(std::slice::from_ref(*s), p).is_some()) {
        return Some(s.object);
    }
    let mut best: Option<(f64, u16)> = None;
    for s in kept() {
        let r = reach * SCALE;
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a reach of a few mm in internal units"
        )]
        let r = r as i32;
        if p.x < s.bounds[0] - r || p.x > s.bounds[2] + r || p.y < s.bounds[1] - r || p.y > s.bounds[3] + r {
            continue;
        }
        let d = edge_dist(s, p);
        if d <= reach && best.is_none_or(|(bd, _)| d < bd) {
            best = Some((d, s.object));
        }
    }
    best.map(|(_, o)| o)
}

/// How far `p` is from the nearest edge of `s`'s slice, mm.
fn edge_dist(s: &ObjectSlice, p: Point) -> f64 {
    let q = mm(p);
    s.shapes
        .iter()
        .flatten()
        .flat_map(|ring| {
            let n = ring.len();
            (0..n).filter_map(move |i| Some((ring.get(i)?, ring.get((i + 1) % n)?)))
        })
        .map(|(a, b)| {
            seg_dist(
                q,
                [f64::from(a.x) / SCALE, f64::from(a.y) / SCALE],
                [f64::from(b.x) / SCALE, f64::from(b.y) / SCALE],
            )
        })
        .fold(f64::INFINITY, f64::min)
}

/// How far `p` is from `s`'s box, mm: never more than [`edge_dist`].
fn box_dist(s: &ObjectSlice, p: Point) -> f64 {
    let [x0, y0, x1, y1] = s.bounds;
    let dx = f64::from(x0.saturating_sub(p.x).max(p.x.saturating_sub(x1)).max(0)) / SCALE;
    let dy = f64::from(y0.saturating_sub(p.y).max(p.y.saturating_sub(y1)).max(0)) / SCALE;
    (dx * dx + dy * dy).sqrt()
}

/// Paths that are cut where they cross from one object into another, and owned by the object holding them.
fn by_place(f: Feature) -> bool {
    !matches!(
        f,
        Feature::Skirt
            | Feature::PrimeTower
            | Feature::Custom
            | Feature::Brim
            | Feature::Support
            | Feature::SupportInterface
    )
}

/// Every path of `l` belongs to `object` (a session of one object), skirt, prime tower and custom paths aside.
pub(crate) fn stamp(l: &mut LayerPaths, object: u16) {
    for p in &mut l.paths {
        p.owner = if matches!(p.feature, Feature::Skirt | Feature::PrimeTower | Feature::Custom) {
            OBJECT_NONE
        } else {
            object
        };
    }
}

/// The paths of a session of one object, as the plate numbers that object: every owned path becomes `object`'s.
pub(crate) fn to_plate(l: &mut LayerPaths, object: u16) {
    for p in l.paths.iter_mut().filter(|p| p.owner != OBJECT_NONE) {
        p.owner = object;
    }
}

/// The owners of `l`'s paths from the objects' slices on its layer (`here`) and above it (`above(k)`: the
/// slices `k` layers up, None past the top), cutting the paths that cross from one object into another.
///
/// `min_held` (mm, the support's line spacing) is how long a support path must pass under an object in all for
/// that object to count in it ([`support_cuts`]).
pub(crate) fn assign(
    l: &mut LayerPaths,
    here: &[ObjectSlice],
    above: &dyn Fn(usize) -> Option<std::sync::Arc<Slices>>,
    min_held: f64,
) {
    let old_points = std::mem::take(&mut l.points);
    let old_zs = std::mem::take(&mut l.zs);
    let old_flows = std::mem::take(&mut l.flows);
    let per_point = !old_zs.is_empty();
    let old_paths = std::mem::take(&mut l.paths);
    let mut points: Vec<Point> = Vec::with_capacity(old_points.len());
    let mut zs: Vec<f32> = Vec::new();
    let mut flows: Vec<f32> = Vec::new();
    let mut paths: Vec<PathInfo> = Vec::with_capacity(old_paths.len());
    let owner_at = |p: Point| holder(here, p).unwrap_or(OBJECT_NONE);
    // What a support path on this layer can lie under ([`Reach`]), worked out for the first one that asks.
    let mut reach: Option<Reach> = None;
    for p in &old_paths {
        let range = p.start as usize..p.end as usize;
        let pts = old_points.get(range.clone()).unwrap_or_default();
        let z_of = |i: usize| (old_zs.get(i).copied(), old_flows.get(i).copied());
        let push_point = |points: &mut Vec<Point>,
                          zs: &mut Vec<f32>,
                          flows: &mut Vec<f32>,
                          q: Point,
                          zf: (Option<f32>, Option<f32>)| {
            points.push(q);
            if per_point {
                zs.push(zf.0.unwrap_or(l.z));
                flows.push(zf.1.unwrap_or(1.0));
            }
        };
        // A support path whose box reaches under two objects is cut where it passes from under one object to
        // under another ([`support_cuts`]).
        let mut plan = None;
        if !by_place(p.feature) {
            let owner = match p.feature {
                Feature::Brim => brim_owner(here, pts),
                Feature::Support | Feature::SupportInterface => support_owner(here, pts, above),
                _ => OBJECT_NONE,
            };
            let two = matches!(p.feature, Feature::Support | Feature::SupportInterface)
                && bbox(pts).is_some_and(|b| reach.get_or_insert_with(|| Reach::new(above)).under_two(b));
            if two {
                plan = reach
                    .as_ref()
                    .map(|r| support_cuts(pts, r, owner, f64::from(p.width_mm), min_held));
            } else {
                let start = u32::try_from(points.len()).unwrap_or(u32::MAX);
                for (k, &q) in pts.iter().enumerate() {
                    push_point(&mut points, &mut zs, &mut flows, q, z_of(range.start + k));
                }
                paths.push(PathInfo {
                    start,
                    end: u32::try_from(points.len()).unwrap_or(u32::MAX),
                    owner,
                    ..*p
                });
                continue;
            }
        }
        // Walk the path; where the owner changes along a segment, end the piece at the crossing.
        let Some(&first) = pts.first() else { continue };
        let mut start = u32::try_from(points.len()).unwrap_or(u32::MAX);
        let mut owner = plan.as_ref().map_or_else(|| owner_at(first), |(o, _)| *o);
        push_point(&mut points, &mut zs, &mut flows, first, z_of(range.start));
        for (k, w) in pts.windows(2).enumerate() {
            let [a, b] = w else { continue };
            let (za, zb) = (z_of(range.start + k), z_of(range.start + k + 1));
            let cuts = match plan.as_mut() {
                Some((_, per)) => per.get_mut(k).map(std::mem::take).unwrap_or_default(),
                None => crossings(*a, *b, &owner_at, Some(here)),
            };
            // A support cut can fall on the segment's end point: the piece ends there, with no point added.
            let mut at_b = None;
            for (q, t, next) in cuts {
                if q == *b {
                    at_b = Some(next);
                    continue;
                }
                let lerp = |x: Option<f32>, y: Option<f32>| match (x, y) {
                    #[allow(
                        clippy::cast_possible_truncation,
                        reason = "a height or flow in single precision"
                    )]
                    (Some(x), Some(y)) => Some(x + (y - x) * t as f32),
                    _ => None,
                };
                push_point(
                    &mut points,
                    &mut zs,
                    &mut flows,
                    q,
                    (lerp(za.0, zb.0), lerp(za.1, zb.1)),
                );
                let end = u32::try_from(points.len()).unwrap_or(u32::MAX);
                if end > start + 1 {
                    paths.push(PathInfo {
                        start,
                        end,
                        owner,
                        ..*p
                    });
                }
                // The next piece starts at the crossing.
                start = end - 1;
                owner = next;
            }
            push_point(&mut points, &mut zs, &mut flows, *b, zb);
            if let Some(next) = at_b {
                let end = u32::try_from(points.len()).unwrap_or(u32::MAX);
                if end > start + 1 {
                    paths.push(PathInfo {
                        start,
                        end,
                        owner,
                        ..*p
                    });
                }
                start = end - 1;
                owner = next;
            }
        }
        let end = u32::try_from(points.len()).unwrap_or(u32::MAX);
        if end > start + 1 {
            paths.push(PathInfo {
                start,
                end,
                owner,
                ..*p
            });
        }
    }
    // A piece outside every slice (it should not happen: a bead lies inside its own object) takes the nearest.
    for p in &mut paths {
        if p.owner == OBJECT_NONE
            && by_place(p.feature)
            && let Some(&q) = points.get(p.start as usize)
        {
            p.owner = nearest(here, q, NEAR_MM).unwrap_or(OBJECT_NONE);
        }
    }
    l.points = points;
    l.paths = paths;
    if per_point {
        l.zs = zs;
        l.flows = flows;
    }
}

/// Where the owner changes along `a`-`b`: each crossing point, its share of the segment and the owner after it.
/// `here`, the slices `owner_at` reads, lets a long segment no outline comes near skip the sampling ([`steady`]);
/// None samples every segment.
fn crossings(
    a: Point,
    b: Point,
    owner_at: &dyn Fn(Point) -> u16,
    here: Option<&[ObjectSlice]>,
) -> Vec<(Point, f64, u16)> {
    let at = |t: f64| {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a point between two in internal units"
        )]
        let q = Point::new(
            (f64::from(a.x) + (f64::from(b.x) - f64::from(a.x)) * t).round() as i32,
            (f64::from(a.y) + (f64::from(b.y) - f64::from(a.y)) * t).round() as i32,
        );
        q
    };
    let len = {
        let (dx, dy) = (f64::from(b.x - a.x) / SCALE, f64::from(b.y - a.y) / SCALE);
        (dx * dx + dy * dy).sqrt()
    };
    // Sampled every 0.1 mm (and at the end), then each change found to a micron.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a step count"
    )]
    let steps = (len / 0.1).ceil().clamp(1.0, 100_000.0) as u32;
    // A long segment that no outline comes near keeps one owner along every sample: it is not sampled.
    if steps > STEADY_STEPS && here.is_some_and(|h| steady(h, a, b)) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut prev = (0.0f64, owner_at(a));
    for k in 1..=steps {
        let t = f64::from(k) / f64::from(steps);
        let o = owner_at(at(t));
        if o == prev.1 {
            prev.0 = t;
            continue;
        }
        let (mut lo, mut hi) = (prev.0, t);
        while (hi - lo) * len > 0.001 {
            let mid = f64::midpoint(lo, hi);
            if owner_at(at(mid)) == prev.1 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let q = at(hi);
        if q != a && q != b {
            out.push((q, hi, o));
        }
        prev = (t, o);
    }
    out
}

/// Segments of more samples than this are first checked with [`steady`]; shorter ones cost less to sample.
const STEADY_STEPS: u32 = 4;
/// How near (internal units) an outline or an object's box may come to a segment that [`steady`] passes. A sample is
/// the segment's point rounded to whole units, at most about 0.71 units off it, so with every edge farther than this
/// no sample lies across an edge from the segment.
const STEADY_UNITS: i32 = 2;

/// True when every sample of `a`-`b` that [`crossings`] would take has the owner of `a`: no object's box edge comes
/// within [`STEADY_UNITS`] of the segment, and no ring edge of an object whose box it is in does.
fn steady(here: &[ObjectSlice], a: Point, b: Point) -> bool {
    let m = STEADY_UNITS;
    let (x0, y0) = (a.x.min(b.x).saturating_sub(m), a.y.min(b.y).saturating_sub(m));
    let (x1, y1) = (a.x.max(b.x).saturating_add(m), a.y.max(b.y).saturating_add(m));
    let near2 = f64::from(m) * f64::from(m);
    for s in here {
        let [bx0, by0, bx1, by1] = s.bounds;
        if bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1 {
            continue;
        }
        if !(bx0 <= x0 && by0 <= y0 && bx1 >= x1 && by1 >= y1) {
            return false;
        }
        for ring in s.shapes.iter().flatten() {
            let n = ring.len();
            for e in 0..n {
                let (Some(&p), Some(&q)) = (ring.get(e), ring.get((e + 1) % n)) else {
                    continue;
                };
                if p.x.max(q.x) < x0 || p.x.min(q.x) > x1 || p.y.max(q.y) < y0 || p.y.min(q.y) > y1 {
                    continue;
                }
                let xy = |x: i32, y: i32| (f64::from(x), f64::from(y));
                if seg_seg_dist2(xy(a.x, a.y), xy(b.x, b.y), xy(p.x, p.y), xy(q.x, q.y)) <= near2 {
                    return false;
                }
            }
        }
    }
    true
}

/// The squared distance between segments `a`-`b` and `p`-`q`, internal units.
fn seg_seg_dist2(a: (f64, f64), b: (f64, f64), p: (f64, f64), q: (f64, f64)) -> f64 {
    let cross =
        |o: (f64, f64), u: (f64, f64), v: (f64, f64)| (u.0 - o.0) * (v.1 - o.1) - (u.1 - o.1) * (v.0 - o.0);
    let (d1, d2, d3, d4) = (cross(p, q, a), cross(p, q, b), cross(a, b, p), cross(a, b, q));
    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0))
        && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
    {
        return 0.0;
    }
    let point_seg = |c: (f64, f64), u: (f64, f64), v: (f64, f64)| {
        let (dx, dy) = (v.0 - u.0, v.1 - u.1);
        let len2 = dx * dx + dy * dy;
        let t = if len2 == 0.0 {
            0.0
        } else {
            (((c.0 - u.0) * dx + (c.1 - u.1) * dy) / len2).clamp(0.0, 1.0)
        };
        let (ex, ey) = (u.0 + dx * t - c.0, u.1 + dy * t - c.1);
        ex * ex + ey * ey
    };
    point_seg(a, p, q)
        .min(point_seg(b, p, q))
        .min(point_seg(p, a, b))
        .min(point_seg(q, a, b))
}

/// A brim's object: the one its loop goes round, or none when it goes round several (`combine_brims`).
fn brim_owner(here: &[ObjectSlice], pts: &[Point]) -> u16 {
    let Some(&first) = pts.first() else {
        return OBJECT_NONE;
    };
    let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for q in pts {
        x0 = x0.min(q.x);
        y0 = y0.min(q.y);
        x1 = x1.max(q.x);
        y1 = y1.max(q.y);
    }
    let inside: Vec<u16> = here
        .iter()
        .filter(|s| {
            let (cx, cy) = (
                i32::midpoint(s.bounds[0], s.bounds[2]),
                i32::midpoint(s.bounds[1], s.bounds[3]),
            );
            cx > x0 && cx < x1 && cy > y0 && cy < y1
        })
        .map(|s| s.object)
        .collect();
    match inside.as_slice() {
        [o] => *o,
        [] => nearest(here, first, NEAR_MM).unwrap_or(OBJECT_NONE),
        _ => OBJECT_NONE,
    }
}

/// The box of `pts`, `[x0, y0, x1, y1]`; None when there are none.
fn bbox(pts: &[Point]) -> Option<[i32; 4]> {
    let &first = pts.first()?;
    Some(pts.iter().fold([first.x, first.y, first.x, first.y], |b, q| {
        [b[0].min(q.x), b[1].min(q.y), b[2].max(q.x), b[3].max(q.y)]
    }))
}

/// The objects' slices on the layers above a layer (up to [`SUPPORT_REACH`]), and each object's bounds over them:
/// what a support path on the layer can lie under.
struct Reach {
    layers: Vec<std::sync::Arc<Slices>>,
    bounds: Vec<(u16, [i32; 4])>,
}

impl Reach {
    fn new(above: &dyn Fn(usize) -> Option<std::sync::Arc<Slices>>) -> Self {
        let layers: Vec<_> = (1..=SUPPORT_REACH).map_while(above).collect();
        let mut bounds: Vec<(u16, [i32; 4])> = Vec::new();
        for o in layers.iter().flat_map(|s| s.iter()) {
            let b = o.bounds;
            match bounds.iter_mut().find(|(n, _)| *n == o.object) {
                Some((_, u)) => *u = [u[0].min(b[0]), u[1].min(b[1]), u[2].max(b[2]), u[3].max(b[3])],
                None => bounds.push((o.object, b)),
            }
        }
        Self { layers, bounds }
    }

    /// True when a support path's box `b` meets two objects' bounds, so its points may lie under different
    /// objects.
    fn under_two(&self, b: [i32; 4]) -> bool {
        self.bounds
            .iter()
            .filter(|(_, u)| b[0] <= u[2] && b[2] >= u[0] && b[1] <= u[3] && b[3] >= u[1])
            .nth(1)
            .is_some()
    }

    /// The object support at `q` lies under: the first one up whose slice holds `q`, else `whole` (the path's own
    /// owner). Unlike [`support_owner_at`] it takes no margin, so support that runs close round a neighbor stays
    /// with the object it holds up.
    fn under_at(&self, q: Point, whole: u16) -> u16 {
        // Only an object whose bounds hold `q` can; when that is none but `whole`, the answer is `whole`.
        if self
            .bounds
            .iter()
            .all(|(o, u)| *o == whole || q.x < u[0] || q.x > u[2] || q.y < u[1] || q.y > u[3])
        {
            return whole;
        }
        self.layers.iter().find_map(|s| holder(s, q)).unwrap_or(whole)
    }
}

/// One support path's cuts, per segment: the point, its share of the segment and the owner after it.
type Cuts = Vec<Vec<(Point, f64, u16)>>;

/// Where a stretch of a support path starts: its length along the path, its owner and, when it starts where
/// [`crossings`] found a change, that segment, point and share.
type Stretch = (f64, u16, Option<(usize, Point, f64)>);

/// How a support path whose box reaches under two objects is cut: the owner at its start, and per segment the
/// cuts on it (a cut at the segment's end point ends the piece there). A point under an object takes the first
/// one up whose slice holds it ([`Reach::under_at`]). A stretch under none takes the object of the nearer
/// stretch under one along the path, round it for a loop: one between stretches of two objects is split where
/// it is equally far from each. A path whose ends are no more than `width` (its line width, mm) apart is a loop.
/// An object the path passes under for less than `min_held` mm in all does not count, unless the path is under it
/// longest: a loop that only grazes a second object's shadow keeps one owner. A path under no object at all keeps
/// `whole`, its own owner.
fn support_cuts(pts: &[Point], r: &Reach, whole: u16, width: f64, min_held: f64) -> (u16, Cuts) {
    let under = |q: Point| r.under_at(q, OBJECT_NONE);
    let gap = |a: Point, b: Point| {
        let (dx, dy) = (f64::from(b.x - a.x) / SCALE, f64::from(b.y - a.y) / SCALE);
        (dx * dx + dy * dy).sqrt()
    };
    let Some(&first) = pts.first() else {
        return (whole, Vec::new());
    };
    // The length along the path to each point.
    let mut at = Vec::with_capacity(pts.len());
    let mut total = 0.0;
    let mut prev = first;
    for &q in pts {
        total += gap(prev, q);
        at.push(total);
        prev = q;
    }
    // The stretches by what they lie under. A short segment is sampled only when its ends differ (support's points
    // mostly stand close together); a longer one (a line of the first layer's base) always is.
    let mut parts: Vec<Stretch> = vec![(0.0, under(first), None)];
    for (k, w) in pts.windows(2).enumerate() {
        let [a, b] = w else { continue };
        let now = parts.last().map_or(OBJECT_NONE, |s| s.1);
        let end = under(*b);
        let (s0, len) = (at.get(k).copied().unwrap_or(0.0), gap(*a, *b));
        if end == now && len <= SUPPORT_STEP_MM {
            continue;
        }
        for (q, t, next) in crossings(*a, *b, &under, None) {
            parts.push((s0 + t * len, next, Some((k, q, t))));
        }
        // A change found only at the end point (crossings leaves those out) starts there.
        if parts.last().is_some_and(|s| s.1 != end) {
            parts.push((s0 + len, end, Some((k, *b, 1.0))));
        }
    }
    // How long the path passes under each object; one under for less than `min_held` that is not the longest
    // (the first along the path on a tie) is a graze, and its stretches count as under none.
    let mut held: Vec<(u16, f64)> = Vec::new();
    for (i, &(s0, o, _)) in parts.iter().enumerate() {
        if o == OBJECT_NONE {
            continue;
        }
        let len = parts.get(i + 1).map_or(total, |n| n.0) - s0;
        match held.iter_mut().find(|h| h.0 == o) {
            Some(h) => h.1 += len,
            None => held.push((o, len)),
        }
    }
    let longest = held
        .iter()
        .fold(None::<(u16, f64)>, |b, &h| match b {
            Some(x) if x.1 >= h.1 => Some(x),
            _ => Some(h),
        })
        .map(|h| h.0);
    let grazed: Vec<u16> = held
        .iter()
        .filter(|h| h.1 < min_held && Some(h.0) != longest)
        .map(|h| h.0)
        .collect();
    if !grazed.is_empty() {
        let mut kept: Vec<Stretch> = Vec::with_capacity(parts.len());
        for &(s0, o, on) in &parts {
            let o = if grazed.contains(&o) { OBJECT_NONE } else { o };
            if kept.last().is_none_or(|k| k.1 != o) {
                kept.push((s0, o, on));
            }
        }
        parts = kept;
    }
    if parts.iter().all(|s| s.1 == OBJECT_NONE) {
        return (whole, Vec::new());
    }
    let n = parts.len();
    // A loop's last point stands a little short of its first.
    let shut = pts.last().map_or(0.0, |&q| gap(q, first));
    let closed = pts.len() > 2 && shut <= width;
    let start_of = |i: usize| parts.get(i).map_or(total, |s| s.0);
    let owner_of = |i: usize| parts.get(i).map_or(OBJECT_NONE, |s| s.1);
    // A loop that starts and ends under no object has one such stretch round its start: its last part and its
    // first.
    let wraps = closed && n > 2 && owner_of(0) == OBJECT_NONE && owner_of(n - 1) == OBJECT_NONE;
    let mut out: Vec<Stretch> = Vec::with_capacity(n + 2);
    for (i, &(s0, o, on)) in parts.iter().enumerate() {
        let s1 = start_of(i + 1);
        if o != OBJECT_NONE {
            out.push((s0, o, on));
            continue;
        }
        // The owners before and after the stretch, how far into it this part starts, and its length.
        let (before, after, into, len) = if wraps && (i == 0 || i == n - 1) {
            let tail = total + shut - start_of(n - 1);
            let into = if i == 0 { tail } else { 0.0 };
            (owner_of(n - 2), owner_of(1), into, tail + start_of(1))
        } else {
            let before = match i.checked_sub(1) {
                Some(j) => owner_of(j),
                None if closed => owner_of(n - 1),
                None => OBJECT_NONE,
            };
            let after = if i + 1 < n {
                owner_of(i + 1)
            } else if closed {
                owner_of(0)
            } else {
                OBJECT_NONE
            };
            (before, after, 0.0, s1 - s0)
        };
        let (before, after) = match (before, after) {
            (OBJECT_NONE, x) | (x, OBJECT_NONE) => (x, x),
            pair => pair,
        };
        // Split at the stretch's middle: up to it the owner before, from it the owner after.
        let split = s0 + len / 2.0 - into;
        if before == after || split >= s1 {
            out.push((s0, before, on));
        } else if split <= s0 {
            out.push((s0, after, on));
        } else {
            out.push((s0, before, on));
            out.push((split, after, None));
        }
    }
    // The owner changes, each placed on its segment.
    let mut cuts: Cuts = vec![Vec::new(); pts.len().saturating_sub(1)];
    let mut start = out.first().map_or(whole, |s| s.1);
    let mut owner = start;
    for &(s, o, on) in out.iter().skip(1) {
        if o == owner {
            continue;
        }
        owner = o;
        let (k, q, t) = on.unwrap_or_else(|| place(pts, &at, s));
        // A split that rounds onto the path's first point changes the owner at its start.
        if k == 0 && q == first {
            start = o;
            continue;
        }
        if let Some(c) = cuts.get_mut(k) {
            c.push((q, t, o));
        }
    }
    (start, cuts)
}

/// The point `s` along the path through `pts` (`at`: the length along it to each point): its segment, the point
/// and its share of the segment. A point that rounds onto a segment's start is the previous segment's end.
fn place(pts: &[Point], at: &[f64], s: f64) -> (usize, Point, f64) {
    let k = at.partition_point(|&v| v < s).saturating_sub(1);
    let (Some(&a), Some(&b)) = (pts.get(k), pts.get(k + 1)) else {
        return (k, pts.last().copied().unwrap_or_default(), 1.0);
    };
    let (s0, s1) = (
        at.get(k).copied().unwrap_or(0.0),
        at.get(k + 1).copied().unwrap_or(s),
    );
    let t = if s1 > s0 {
        ((s - s0) / (s1 - s0)).clamp(0.0, 1.0)
    } else {
        1.0
    };
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a point between two in internal units"
    )]
    let q = Point::new(
        (f64::from(a.x) + (f64::from(b.x) - f64::from(a.x)) * t).round() as i32,
        (f64::from(a.y) + (f64::from(b.y) - f64::from(a.y)) * t).round() as i32,
    );
    match k.checked_sub(1) {
        Some(j) if q == a => (j, a, 1.0),
        _ => (k, q, t),
    }
}

/// Support's object: the one [`support_owner_at`] gives the middle of the path's box (a support path's ends may
/// come close to a neighbor it does not hold up).
fn support_owner(
    here: &[ObjectSlice],
    pts: &[Point],
    above: &dyn Fn(usize) -> Option<std::sync::Arc<Slices>>,
) -> u16 {
    let Some([x0, y0, x1, y1]) = bbox(pts) else {
        return OBJECT_NONE;
    };
    support_owner_at(
        here,
        Point::new(i32::midpoint(x0, x1), i32::midpoint(y0, y1)),
        above,
    )
}

/// The object support at `mid` holds up: the first one up from this layer within the support's margin of it,
/// passing over objects already beside it on its own layer while another is found; else the nearest on its own
/// layer; else [`nearest_up`].
fn support_owner_at(
    here: &[ObjectSlice],
    mid: Point,
    above: &dyn Fn(usize) -> Option<std::sync::Arc<Slices>>,
) -> u16 {
    // An object already standing beside the path on its own layer is a neighbor the support passes, not the
    // one it holds up (border support on the first layer runs close round a neighbor that rises past the
    // overhang). Look for an object above that is not beside it first, then for any.
    let beside: Vec<u16> = here
        .iter()
        .filter(|s| nearest(std::slice::from_ref(*s), mid, SUPPORT_MARGIN_MM).is_some())
        .map(|s| s.object)
        .collect();
    let apart = |o: u16| !beside.contains(&o);
    let any = |_: u16| true;
    let rules: [&dyn Fn(u16) -> bool; 2] = [&apart, &any];
    for keep in rules.iter().take(if beside.is_empty() { 1 } else { 2 }) {
        // Support reaches a little past the object it holds up (its outline grows by the support's own margin).
        for k in 1..=SUPPORT_REACH {
            let Some(s) = above(k) else { break };
            if let Some(o) = nearest_of(&s, mid, SUPPORT_MARGIN_MM, keep) {
                return o;
            }
        }
    }
    nearest(here, mid, NEAR_MM)
        .or_else(|| nearest_up(here, mid, above))
        .unwrap_or(OBJECT_NONE)
}

/// The object nearest `mid` on its own layer or any layer up to [`SUPPORT_REACH`], however far: the last resort
/// for a support path that holds up nothing within the margin and has no object near it on its own layer (tree
/// branches that lean out round an object), so that no support is left without an object's label. A printer
/// that skips an object cannot skip support of no object; it always prints. The first found wins a tie.
fn nearest_up(
    here: &[ObjectSlice],
    mid: Point,
    above: &dyn Fn(usize) -> Option<std::sync::Arc<Slices>>,
) -> Option<u16> {
    let mut best: Option<(f64, u16)> = None;
    let mut look = |slices: &[ObjectSlice]| {
        for s in slices {
            if best.is_some_and(|(d, _)| box_dist(s, mid) >= d) {
                continue;
            }
            let d = if holder(std::slice::from_ref(s), mid).is_some() {
                0.0
            } else {
                edge_dist(s, mid)
            };
            if best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, s.object));
            }
        }
    };
    look(here);
    for k in 1..=SUPPORT_REACH {
        let Some(s) = above(k) else { break };
        look(&s);
    }
    best.map(|(_, o)| o)
}

/// The slices of the objects `part_object` names, made from their parts' loops on a layer (`loops`: per part).
pub(crate) fn slices_of(part_object: &[u16], loops: &[Vec<crate::geom::Polygon>]) -> Slices {
    let mut objects: Vec<u16> = part_object.to_vec();
    objects.sort_unstable();
    objects.dedup();
    objects
        .into_iter()
        .filter_map(|o| {
            let rings: Vec<crate::geom::Polygon> = part_object
                .iter()
                .zip(loops)
                .filter(|(p, _)| **p == o)
                .flat_map(|(_, l)| l.iter().cloned())
                .collect();
            if rings.is_empty() {
                return None;
            }
            let shapes = crate::perimeters::shapes_from_loops(&rings);
            let bounds = crate::perimeters::bounds(&shapes)?;
            Some(ObjectSlice {
                object: o,
                shapes,
                bounds,
            })
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::fm::Fm as _;
    use i_overlay::i_float::int::point::IntPoint;

    fn square(object: u16, x0: f64, y0: f64, x1: f64, y1: f64) -> ObjectSlice {
        let m = |v: f64| crate::geom::mm(v);
        let ring = vec![
            IntPoint::new(m(x0), m(y0)),
            IntPoint::new(m(x1), m(y0)),
            IntPoint::new(m(x1), m(y1)),
            IntPoint::new(m(x0), m(y1)),
        ];
        ObjectSlice {
            object,
            bounds: [m(x0), m(y0), m(x1), m(y1)],
            shapes: vec![vec![ring]],
        }
    }

    fn layer(points: &[(f64, f64)], feature: Feature) -> LayerPaths {
        LayerPaths {
            points: points.iter().map(|&(x, y)| Point::from_mm(x, y)).collect(),
            paths: vec![PathInfo {
                tower_wipe: false,
                start: 0,
                end: u32::try_from(points.len()).unwrap(),
                tool: 1,
                feature,
                speed_mm_s: 50.0,
                width_mm: 0.42,
                flow: 1.0,
                dz: 0.0,
                overhang_fan: false,
                owner: OBJECT_NONE,
            }],
            ..LayerPaths::default()
        }
    }

    fn length(l: &LayerPaths) -> f64 {
        l.paths
            .iter()
            .flat_map(|p| l.path_points(p).windows(2))
            .map(|w| {
                let (a, b) = (mm(w[0]), mm(w[1]));
                (b[0] - a[0]).m_hypot(b[1] - a[1])
            })
            .sum()
    }

    #[test]
    fn a_line_across_two_touching_objects_is_cut_at_the_seam() {
        let here = vec![square(0, 0.0, 0.0, 10.0, 10.0), square(1, 10.0, 0.0, 20.0, 10.0)];
        let mut l = layer(&[(2.0, 5.0), (18.0, 5.0)], Feature::SparseInfill);
        let before = length(&l);
        assign(&mut l, &here, &|_| None, 2.5);
        assert_eq!(l.paths.iter().map(|p| p.owner).collect::<Vec<_>>(), [0, 1]);
        // The cut is on the seam (the first object takes the shared boundary), on the same line.
        let cut = l.path_points(&l.paths[0]).last().copied().unwrap();
        assert!(
            (mm(cut)[0] - 10.0).abs() < 0.01 && (mm(cut)[1] - 5.0).abs() < 1e-6,
            "{cut:?}"
        );
        assert_eq!(l.path_points(&l.paths[1]).first().copied(), Some(cut));
        assert!((length(&l) - before).abs() < 1e-6);
    }

    #[test]
    fn a_segment_within_two_units_of_an_outline_is_still_sampled() {
        let here = vec![square(0, 0.0, 0.0, 10.0, 10.0)];
        let edge = crate::geom::mm(10.0);
        let owner_at = |p: Point| holder(&here, p).unwrap_or(OBJECT_NONE);
        // Ends one unit past the right edge: not steady, so it is sampled.
        let (a, b) = (
            Point::from_mm(1.0, 5.0),
            Point::new(edge + 1, crate::geom::mm(5.0)),
        );
        assert!(!steady(&here, a, b));
        // One that crosses the edge is sampled and cut where it leaves the object.
        let (a, b) = (Point::from_mm(1.0, 5.0), Point::from_mm(15.0, 5.0));
        assert!(!steady(&here, a, b));
        assert_eq!(crossings(a, b, &owner_at, Some(&here)).len(), 1);
        // Runs along the top edge two units inside it: not steady either, though it never leaves the object.
        let top = crate::geom::mm(10.0) - 2;
        let (a, b) = (
            Point::new(crate::geom::mm(1.0), top),
            Point::new(crate::geom::mm(9.0), top),
        );
        assert!(!steady(&here, a, b));
        assert!(crossings(a, b, &owner_at, Some(&here)).is_empty());
        // Well inside: steady.
        assert!(steady(&here, Point::from_mm(1.0, 5.0), Point::from_mm(9.0, 5.0)));
    }

    #[test]
    fn a_steady_segment_keeps_its_owner_at_every_sample() {
        let here = vec![
            square(0, 0.0, 0.0, 10.0, 10.0),
            square(1, 10.0, 0.0, 20.0, 10.0),
            square(2, 3.0, 3.0, 6.0, 6.0),
        ];
        let owner_at = |p: Point| holder(&here, p).unwrap_or(OBJECT_NONE);
        let mut checked = 0;
        for i in 0..40 {
            for j in 0..40 {
                let (x0, y0) = (-1.0 + 0.55 * f64::from(i), -1.0 + 0.3 * f64::from(j));
                let (a, b) = (Point::from_mm(x0, y0), Point::from_mm(x0 + 3.7, y0 + 1.3));
                if !steady(&here, a, b) {
                    continue;
                }
                checked += 1;
                let first = owner_at(a);
                for k in 0..=200 {
                    let t = f64::from(k) / 200.0;
                    #[allow(clippy::cast_possible_truncation, reason = "a point between two")]
                    let q = Point::new(
                        (f64::from(a.x) + f64::from(b.x - a.x) * t).round() as i32,
                        (f64::from(a.y) + f64::from(b.y - a.y) * t).round() as i32,
                    );
                    assert_eq!(owner_at(q), first, "{a:?} {b:?} at {t}");
                }
            }
        }
        assert!(checked > 100, "{checked}");
    }

    #[test]
    fn overlapping_objects_give_the_first_in_plate_order() {
        let here = vec![square(0, 0.0, 0.0, 10.0, 10.0), square(1, 5.0, 0.0, 15.0, 10.0)];
        let mut l = layer(&[(6.0, 5.0), (9.0, 5.0)], Feature::InternalSolid);
        assign(&mut l, &here, &|_| None, 2.5);
        assert_eq!(l.paths.iter().map(|p| p.owner).collect::<Vec<_>>(), [0]);
    }

    #[test]
    fn support_belongs_to_the_object_above_it() {
        // On this layer object 1 stands right beside the support; object 0's overhang is two layers up.
        let here = vec![square(0, 0.0, 0.0, 5.0, 5.0), square(1, 21.0, 0.0, 26.0, 5.0)];
        let up = std::sync::Arc::new(vec![square(0, 0.0, 0.0, 22.0, 5.0)]);
        let mut l = layer(&[(20.0, 2.0), (20.0, 4.0)], Feature::Support);
        assign(
            &mut l,
            &here,
            &|k| {
                (k <= 2).then(|| {
                    if k == 2 {
                        up.clone()
                    } else {
                        std::sync::Arc::new(Vec::new())
                    }
                })
            },
            2.5,
        );
        assert_eq!(l.paths[0].owner, 0);
    }

    #[test]
    fn support_under_two_objects_is_cut_where_its_owner_changes() {
        // A support only layer under two shelves two layers up, with a 2 mm gap between them from x 9 to 11.
        let up = std::sync::Arc::new(vec![
            square(0, 0.0, 0.0, 9.0, 10.0),
            square(1, 11.0, 0.0, 20.0, 10.0),
        ]);
        let above = |k: usize| {
            (k <= 2).then(|| {
                if k == 2 {
                    up.clone()
                } else {
                    std::sync::Arc::new(Vec::new())
                }
            })
        };
        let mut l = layer(&[(2.0, 5.0), (18.0, 5.0)], Feature::Support);
        let before = length(&l);
        assign(&mut l, &[], &above, 2.5);
        assert_eq!(l.paths.iter().map(|p| p.owner).collect::<Vec<_>>(), [0, 1]);
        // The stretch under the gap goes to the nearer shelf along the path, so it is cut in the gap's middle, on
        // the same line.
        let cut = l.path_points(&l.paths[0]).last().copied().unwrap();
        assert!(
            (mm(cut)[0] - 10.0).abs() < 0.01 && (mm(cut)[1] - 5.0).abs() < 1e-6,
            "{cut:?}"
        );
        assert_eq!(l.path_points(&l.paths[1]).first().copied(), Some(cut));
        assert!((length(&l) - before).abs() < 1e-6);
        // Under one object only, the path keeps one owner and its points.
        let one = std::sync::Arc::new(vec![square(0, 0.0, 0.0, 20.0, 10.0)]);
        let mut l = layer(&[(2.0, 5.0), (18.0, 5.0)], Feature::Support);
        assign(&mut l, &[], &|k| (k <= 2).then(|| one.clone()), 2.5);
        assert_eq!(l.paths.iter().map(|p| p.owner).collect::<Vec<_>>(), [0]);
        assert_eq!(l.points.len(), 2);
    }

    #[test]
    fn a_support_loops_arc_under_no_object_goes_to_the_nearer_one_along_it() {
        // Two shelves two layers up, x 0 to 9 and 11 to 20, y 0 to 10. A support loop runs under both along y 5
        // and back along y 15, outside both: its arc past y 10 is split where it is equally far along the loop
        // from each shelf, so each shelf's half of the loop carries that shelf's label.
        let up = std::sync::Arc::new(vec![
            square(0, 0.0, 0.0, 9.0, 10.0),
            square(1, 11.0, 0.0, 20.0, 10.0),
        ]);
        let above = |k: usize| {
            (k <= 2).then(|| {
                if k == 2 {
                    up.clone()
                } else {
                    std::sync::Arc::new(Vec::new())
                }
            })
        };
        let ring = [(2.0, 5.0), (18.0, 5.0), (18.0, 15.0), (2.0, 15.0), (2.0, 5.0)];
        let mut l = layer(&ring, Feature::Support);
        let before = length(&l);
        assign(&mut l, &[], &above, 2.5);
        assert_eq!(l.paths.iter().map(|p| p.owner).collect::<Vec<_>>(), [0, 1, 0]);
        // Cut in the gap's middle on y 5, and halfway round the outer arc on y 15.
        let cuts: Vec<[f64; 2]> = l.paths[..2]
            .iter()
            .map(|p| mm(l.path_points(p).last().copied().unwrap()))
            .collect();
        for (cut, want) in cuts.iter().zip([[10.0, 5.0], [10.0, 15.0]]) {
            assert!(
                (cut[0] - want[0]).abs() < 0.01 && (cut[1] - want[1]).abs() < 1e-6,
                "{cut:?}"
            );
        }
        assert!((length(&l) - before).abs() < 1e-6);
        let of = |o: u16| {
            let mut one = l.clone();
            one.paths.retain(|p| p.owner == o);
            length(&one)
        };
        assert!(
            (of(0) - 26.0).abs() < 0.01 && (of(1) - 26.0).abs() < 0.01,
            "{} {}",
            of(0),
            of(1)
        );
    }

    #[test]
    fn a_support_loop_that_grazes_a_second_shadow_keeps_one_owner() {
        // The loop runs under shelf 0 (x 0 to 9) and out past it; at its far corner it passes under shelf 1
        // (x 11 to 20, y 0 to 6) for 1.5 mm, less than the 2.5 mm line spacing: shelf 1 does not count, and the
        // whole loop is shelf 0's.
        let up = std::sync::Arc::new(vec![
            square(0, 0.0, 0.0, 9.0, 10.0),
            square(1, 11.0, 0.0, 20.0, 6.0),
        ]);
        let above = |k: usize| (k == 1).then(|| up.clone());
        let ring = [(2.0, 5.0), (11.5, 5.0), (11.5, 15.0), (2.0, 15.0), (2.0, 5.0)];
        let mut l = layer(&ring, Feature::Support);
        let before = length(&l);
        assign(&mut l, &[], &above, 2.5);
        assert_eq!(l.paths.iter().map(|p| p.owner).collect::<Vec<_>>(), [0]);
        assert_eq!(l.points.len(), ring.len());
        assert!((length(&l) - before).abs() < 1e-6);
        // With no minimum, the graze would take part of the loop.
        let mut l = layer(&ring, Feature::Support);
        assign(&mut l, &[], &above, 0.0);
        assert!(l.paths.iter().any(|p| p.owner == 1));
    }

    #[test]
    fn skirt_and_tower_belong_to_no_object() {
        let here = vec![square(0, 0.0, 0.0, 10.0, 10.0)];
        for f in [Feature::Skirt, Feature::PrimeTower] {
            let mut l = layer(&[(2.0, 5.0), (8.0, 5.0)], f);
            assign(&mut l, &here, &|_| None, 2.5);
            assert_eq!(l.paths[0].owner, OBJECT_NONE);
        }
    }
}
