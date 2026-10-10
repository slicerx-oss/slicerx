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
//!   goes round several; support to the object above it (the first layer up where the support's start point lies
//!   inside an object), else the nearest object on its own layer.

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
    if let Some(o) = holder(slices, p) {
        return Some(o);
    }
    let q = mm(p);
    let mut best: Option<(f64, u16)> = None;
    for s in slices {
        let r = reach * SCALE;
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a reach of a few mm in internal units"
        )]
        let r = r as i32;
        if p.x < s.bounds[0] - r || p.x > s.bounds[2] + r || p.y < s.bounds[1] - r || p.y > s.bounds[3] + r {
            continue;
        }
        let d = s
            .shapes
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
            .fold(f64::INFINITY, f64::min);
        if d <= reach && best.is_none_or(|(bd, _)| d < bd) {
            best = Some((d, s.object));
        }
    }
    best.map(|(_, o)| o)
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
pub(crate) fn assign(
    l: &mut LayerPaths,
    here: &[ObjectSlice],
    above: &dyn Fn(usize) -> Option<std::sync::Arc<Slices>>,
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
        if !by_place(p.feature) {
            let owner = match p.feature {
                Feature::Brim => brim_owner(here, pts),
                Feature::Support | Feature::SupportInterface => support_owner(here, pts, above),
                _ => OBJECT_NONE,
            };
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
        // Walk the path; where the owner changes along a segment, end the piece at the crossing.
        let Some(&first) = pts.first() else { continue };
        let mut start = u32::try_from(points.len()).unwrap_or(u32::MAX);
        let mut owner = owner_at(first);
        push_point(&mut points, &mut zs, &mut flows, first, z_of(range.start));
        for (k, w) in pts.windows(2).enumerate() {
            let [a, b] = w else { continue };
            let (za, zb) = (z_of(range.start + k), z_of(range.start + k + 1));
            for (q, t, next) in crossings(*a, *b, &owner_at) {
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
fn crossings(a: Point, b: Point, owner_at: &dyn Fn(Point) -> u16) -> Vec<(Point, f64, u16)> {
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

/// Support's object: the first one up from this layer that its start point lies inside (what it holds up), else
/// the nearest on its own layer.
fn support_owner(
    here: &[ObjectSlice],
    pts: &[Point],
    above: &dyn Fn(usize) -> Option<std::sync::Arc<Slices>>,
) -> u16 {
    // The middle of the path's box: a support path's ends may come close to a neighbor it does not hold up.
    let Some(&first) = pts.first() else {
        return OBJECT_NONE;
    };
    let (mut x0, mut y0, mut x1, mut y1) = (first.x, first.y, first.x, first.y);
    for q in pts {
        x0 = x0.min(q.x);
        y0 = y0.min(q.y);
        x1 = x1.max(q.x);
        y1 = y1.max(q.y);
    }
    let mid = Point::new(i32::midpoint(x0, x1), i32::midpoint(y0, y1));
    // Support reaches a little past the object it holds up (its outline grows by the support's own margin).
    for k in 1..=SUPPORT_REACH {
        let Some(s) = above(k) else { break };
        if let Some(o) = nearest(&s, mid, SUPPORT_MARGIN_MM) {
            return o;
        }
    }
    nearest(here, mid, NEAR_MM).unwrap_or(OBJECT_NONE)
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
        assign(&mut l, &here, &|_| None);
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
    fn overlapping_objects_give_the_first_in_plate_order() {
        let here = vec![square(0, 0.0, 0.0, 10.0, 10.0), square(1, 5.0, 0.0, 15.0, 10.0)];
        let mut l = layer(&[(6.0, 5.0), (9.0, 5.0)], Feature::InternalSolid);
        assign(&mut l, &here, &|_| None);
        assert_eq!(l.paths.iter().map(|p| p.owner).collect::<Vec<_>>(), [0]);
    }

    #[test]
    fn support_belongs_to_the_object_above_it() {
        // On this layer object 1 stands right beside the support; object 0's overhang is two layers up.
        let here = vec![square(0, 0.0, 0.0, 5.0, 5.0), square(1, 21.0, 0.0, 26.0, 5.0)];
        let up = std::sync::Arc::new(vec![square(0, 0.0, 0.0, 22.0, 5.0)]);
        let mut l = layer(&[(20.0, 2.0), (20.0, 4.0)], Feature::Support);
        assign(&mut l, &here, &|k| {
            (k <= 2).then(|| {
                if k == 2 {
                    up.clone()
                } else {
                    std::sync::Arc::new(Vec::new())
                }
            })
        });
        assert_eq!(l.paths[0].owner, 0);
    }

    #[test]
    fn skirt_and_tower_belong_to_no_object() {
        let here = vec![square(0, 0.0, 0.0, 10.0, 10.0)];
        for f in [Feature::Skirt, Feature::PrimeTower] {
            let mut l = layer(&[(2.0, 5.0), (8.0, 5.0)], f);
            assign(&mut l, &here, &|_| None);
            assert_eq!(l.paths[0].owner, OBJECT_NONE);
        }
    }
}
