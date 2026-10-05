// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Polygon helpers for organic tree supports: offsets with Clipper's miter and round joins (Orca's
//! `offset(..., jtMiter, 1.2)` and `jtRound` calls), Douglas-Peucker simplification of every ring
//! (`polygons_simplify`), point containment with the even-odd rule (`contains`), `remove_small`, and
//! Cura's `move_inside`.
//!
//! Shapes are plate units (`crate::geom::SCALE` per mm), outer rings counterclockwise and holes clockwise.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::indexing_slicing,
    reason = "plate coordinates in i32 and i64, and ring vertices indexed modulo their count"
)]

use crate::fm::Fm as _;
use crate::perimeters::{self, Shapes};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay::{IntOverlayOptions, Overlay};
use i_overlay::core::solver::Solver;
use i_overlay::i_float::int::point::IntPoint;

pub(crate) type Pt = (i64, i64);
pub(crate) type Ring = Vec<IntPoint<i32>>;

/// How the corners of an offset are joined.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Join {
    /// Clipper's `jtMiter` with this miter limit (a multiple of the offset), squared off beyond it.
    Miter(f64),
    /// Clipper's `jtRound` with this arc tolerance in plate units.
    Round(f64),
    /// Clipper's `jtSquare`: convex corners cut square.
    Square,
}

/// Orca's `scaled<coord_t>()`: millimeters to plate units, truncated.
pub(crate) fn sc(mm: f64) -> i64 {
    (mm * crate::geom::SCALE) as i64
}

pub(crate) fn ip(p: Pt) -> IntPoint<i32> {
    IntPoint::new(p.0 as i32, p.1 as i32)
}

pub(crate) fn pt(p: IntPoint<i32>) -> Pt {
    (i64::from(p.x), i64::from(p.y))
}

fn round_ip(x: f64, y: f64) -> IntPoint<i32> {
    IntPoint::new(x.round() as i32, y.round() as i32)
}

fn solver(edges: usize) -> Solver {
    if edges < 16_000 {
        Solver::LIST
    } else {
        Solver::AUTO
    }
}

/// Rings merged with `rule`.
pub(crate) fn merge_rings(rings: &[Ring], rule: FillRule) -> Shapes {
    let capacity: usize = rings.iter().map(Vec::len).sum();
    if capacity == 0 {
        return Vec::new();
    }
    Overlay::new_custom(capacity, IntOverlayOptions::default(), solver(capacity)).simplify_source(rings, rule)
}

/// Every ring of `s`.
pub(crate) fn rings(s: &Shapes) -> impl Iterator<Item = &Ring> {
    s.iter().flat_map(|sh| sh.iter())
}

/// `union_()` of one set.
pub(crate) fn union(s: &Shapes) -> Shapes {
    let all: Vec<Ring> = rings(s).cloned().collect();
    merge_rings(&all, FillRule::NonZero)
}

pub(crate) fn union2(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() {
        return union(b);
    }
    if b.is_empty() {
        return union(a);
    }
    perimeters::union_all(&[a, b])
}

pub(crate) fn diff(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() {
        return Vec::new();
    }
    if b.is_empty() {
        return union(a);
    }
    // A branch is small and the layer's collision area large: only the part of it near the branch matters.
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(nb) = perimeters::near(b, perimeters::bounds(a)) {
        return if nb.is_empty() {
            perimeters::difference_apart(a)
        } else {
            perimeters::difference(a, &nb)
        };
    }
    perimeters::difference(a, b)
}

pub(crate) fn inter(a: &Shapes, b: &Shapes) -> Shapes {
    // Only the part of each side within the other's bounds can be in the result; nothing there means nothing.
    #[cfg(not(target_arch = "wasm32"))]
    {
        let nb = perimeters::near(b, perimeters::bounds(a));
        let b = nb.as_ref().unwrap_or(b);
        let na = perimeters::near(a, perimeters::bounds(b));
        let a = na.as_ref().unwrap_or(a);
        if a.is_empty() || b.is_empty() {
            return Vec::new();
        }
        perimeters::intersection(a, b)
    }
    #[cfg(target_arch = "wasm32")]
    perimeters::intersection(a, b)
}

/// Signed area in square plate units (holes subtract), Orca's `area(Polygons)`.
pub(crate) fn area(s: &Shapes) -> f64 {
    rings(s).map(|r| ring_area(r)).sum()
}

pub(crate) fn ring_area(r: &[IntPoint<i32>]) -> f64 {
    crate::geom::area2_int(r) as f64 / 2.0
}

/// Orca's `tiny_area_threshold()`: a square micrometer.
pub(crate) fn tiny_area() -> f64 {
    let u = crate::geom::SCALE * 0.001;
    u * u
}

/// Total outline length, Orca's `total_length(Polygons)`.
pub(crate) fn total_length(s: &Shapes) -> f64 {
    rings(s)
        .map(|r| {
            let n = r.len();
            (0..n).map(|i| dist(pt(r[i]), pt(r[(i + 1) % n]))).sum::<f64>()
        })
        .sum()
}

pub(crate) fn dist(a: Pt, b: Pt) -> f64 {
    ((a.0 - b.0) as f64).m_hypot((a.1 - b.1) as f64)
}

pub(crate) fn dist2(a: Pt, b: Pt) -> i64 {
    let (dx, dy) = (a.0 - b.0, a.1 - b.1);
    dx * dx + dy * dy
}

/// Bounding box `[min_x, min_y, max_x, max_y]`.
pub(crate) fn bbox(s: &Shapes) -> Option<[i64; 4]> {
    perimeters::bounds(s).map(|b| [i64::from(b[0]), i64::from(b[1]), i64::from(b[2]), i64::from(b[3])])
}

/// Clipper's `PointInPolygon`: 1 inside, 0 outside, -1 on the boundary.
fn point_in_ring(p: Pt, r: &[IntPoint<i32>]) -> i32 {
    let n = r.len();
    if n < 3 {
        return 0;
    }
    let mut result = 0;
    let (px, py) = p;
    let mut ip0 = pt(r[n - 1]);
    for q in r {
        let ipn = pt(*q);
        if ipn.1 == py && (ipn.0 == px || (ip0.1 == py && ((ipn.0 > px) == (ip0.0 < px)))) {
            return -1;
        }
        if (ip0.1 < py) != (ipn.1 < py) {
            if ip0.0 >= px {
                if ipn.0 > px {
                    result = 1 - result;
                } else {
                    let d =
                        (ip0.0 - px) as f64 * (ipn.1 - py) as f64 - (ipn.0 - px) as f64 * (ip0.1 - py) as f64;
                    if d == 0.0 {
                        return -1;
                    }
                    if (d > 0.0) == (ipn.1 > ip0.1) {
                        result = 1 - result;
                    }
                }
            } else if ipn.0 > px {
                let d = (ip0.0 - px) as f64 * (ipn.1 - py) as f64 - (ipn.0 - px) as f64 * (ip0.1 - py) as f64;
                if d == 0.0 {
                    return -1;
                }
                if (d > 0.0) == (ipn.1 > ip0.1) {
                    result = 1 - result;
                }
            }
        }
        ip0 = ipn;
    }
    result
}

/// Orca's `contains(Polygons, Point)`: inside an odd number of rings, or on any ring.
pub(crate) fn contains(s: &Shapes, p: Pt) -> bool {
    let mut count = 0;
    for r in rings(s) {
        match point_in_ring(p, r) {
            -1 => return true,
            v => count += v,
        }
    }
    count % 2 == 1
}

/// Orca's `remove_small`: drops every ring (outer or hole) smaller than `min_area`.
pub(crate) fn remove_small(s: &mut Shapes, min_area: f64) {
    for sh in s.iter_mut() {
        let keep_shape = sh.first().is_some_and(|o| ring_area(o).abs() >= min_area);
        if !keep_shape {
            sh.clear();
            continue;
        }
        let mut first = true;
        sh.retain(|r| {
            let k = first || ring_area(r).abs() >= min_area;
            first = false;
            k
        });
    }
    s.retain(|sh| !sh.is_empty());
}

/// Douglas-Peucker on a closed ring, the first point repeated at the end (`MultiPoint::_douglas_peucker`).
fn douglas_peucker(pts: &[Pt], tol: f64) -> Vec<Pt> {
    let mut out: Vec<Pt> = Vec::with_capacity(pts.len());
    let Some(&first) = pts.first() else { return out };
    out.push(first);
    let n = pts.len();
    if n < 2 {
        return out;
    }
    let tol2 = tol * tol;
    let mut anchor = 0usize;
    let mut floater = n - 1;
    let mut stack = vec![floater];
    loop {
        let mut max_d = 0.0;
        let mut far = anchor;
        for i in anchor + 1..floater {
            let d = seg_dist2(pts[i], pts[anchor], pts[floater]);
            if d > max_d {
                max_d = d;
                far = i;
            }
        }
        if max_d <= tol2 {
            out.push(pts[floater]);
            anchor = floater;
            stack.pop();
            match stack.last() {
                Some(&f) => floater = f,
                None => break,
            }
        } else {
            floater = far;
            stack.push(floater);
        }
    }
    out
}

/// Squared distance from `p` to the segment `a`-`b` (Orca's `Line::distance_to_squared`).
pub(crate) fn seg_dist2(p: Pt, a: Pt, b: Pt) -> f64 {
    let (vx, vy) = ((b.0 - a.0) as f64, (b.1 - a.1) as f64);
    let (wx, wy) = ((p.0 - a.0) as f64, (p.1 - a.1) as f64);
    let l2 = vx * vx + vy * vy;
    if l2 == 0.0 {
        return wx * wx + wy * wy;
    }
    let t = (wx * vx + wy * vy) / l2;
    if t <= 0.0 {
        wx * wx + wy * wy
    } else if t >= 1.0 {
        let (dx, dy) = ((p.0 - b.0) as f64, (p.1 - b.1) as f64);
        dx * dx + dy * dy
    } else {
        let (dx, dy) = (wx - t * vx, wy - t * vy);
        dx * dx + dy * dy
    }
}

/// Orca's `polygons_simplify` (not strictly simple): each ring simplified on its own, rings that fall below
/// three points dropped. The rings keep their shape grouping; a shape whose outline goes keeps none of its holes.
pub(crate) fn simplify(s: &Shapes, tol: f64) -> Shapes {
    let mut rings_out: Vec<Ring> = Vec::new();
    for r in rings(s) {
        if r.len() < 3 {
            continue;
        }
        let mut p: Vec<Pt> = r.iter().map(|q| pt(*q)).collect();
        p.push(p[0]);
        let mut d = douglas_peucker(&p, tol);
        d.pop();
        if d.len() >= 3 {
            rings_out.push(d.into_iter().map(ip).collect());
        }
    }
    merge_rings(&rings_out, FillRule::NonZero)
}

/// Clipper 6's `ClipperOffset` on every ring of `s`, then the union of the raw loops with the positive fill rule.
pub(crate) fn offset(s: &Shapes, delta: f64, join: Join) -> Shapes {
    if delta == 0.0 {
        return union(s);
    }
    let raw: Vec<Ring> = rings(s)
        .filter(|r| r.len() >= 3)
        .filter_map(|r| offset_ring(r, delta, join))
        .collect();
    if raw.is_empty() {
        return Vec::new();
    }
    merge_rings(&raw, FillRule::Positive)
}

/// Miter offset with limit 1.2, the most common call in Orca's tree code.
pub(crate) fn offset_miter(s: &Shapes, delta: f64) -> Shapes {
    offset(s, delta, Join::Miter(1.2))
}

/// The raw offset loop of one ring (`ClipperOffset::DoOffset` for a closed polygon).
fn offset_ring(r: &[IntPoint<i32>], delta: f64, join: Join) -> Option<Ring> {
    // Drop repeated points first, as Clipper does when adding a path.
    let mut src: Vec<(f64, f64)> = Vec::with_capacity(r.len());
    for p in r {
        let q = (f64::from(p.x), f64::from(p.y));
        if src.last() != Some(&q) {
            src.push(q);
        }
    }
    while src.len() > 1 && src.first() == src.last() {
        src.pop();
    }
    let n = src.len();
    if n < 3 {
        return None;
    }
    let normals: Vec<(f64, f64)> = (0..n)
        .map(|i| {
            let a = src[i];
            let b = src[(i + 1) % n];
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let len = dx.m_hypot(dy);
            if len == 0.0 {
                (0.0, 0.0)
            } else {
                (dy / len, -dx / len)
            }
        })
        .collect();
    let (miter_lim, steps_per_rad, sin_step, cos_step) = match join {
        Join::Miter(limit) => (
            if limit > 2.0 { 2.0 / (limit * limit) } else { 0.5 },
            0.0,
            0.0,
            0.0,
        ),
        Join::Square => (0.0, 0.0, 0.0, 0.0),
        Join::Round(tol) => {
            let def = 0.25;
            let y = if tol <= 0.0 {
                def
            } else if tol > delta.abs() * def {
                delta.abs() * def
            } else {
                tol
            };
            let mut steps = std::f64::consts::PI / (1.0 - y / delta.abs()).m_acos();
            if steps > delta.abs() * std::f64::consts::PI {
                steps = delta.abs() * std::f64::consts::PI;
            }
            let (mut s, c) = (std::f64::consts::TAU / steps).m_sin_cos();
            if delta < 0.0 {
                s = -s;
            }
            (0.0, steps / std::f64::consts::TAU, s, c)
        }
    };
    let mut out: Ring = Vec::with_capacity(n * 2);
    let mut k = n - 1;
    for j in 0..n {
        let (nk, nj) = (normals[k], normals[j]);
        let p = src[j];
        let mut sin_a = nk.0 * nj.1 - nj.0 * nk.1;
        let cos_a = nk.0 * nj.0 + nk.1 * nj.1;
        if (sin_a * delta).abs() < 1.0 {
            // Nearly collinear edges: one point.
            if cos_a > 0.0 {
                out.push(round_ip(p.0 + nk.0 * delta, p.1 + nk.1 * delta));
                k = j;
                continue;
            }
        } else {
            sin_a = sin_a.clamp(-1.0, 1.0);
        }
        if sin_a * delta < 0.0 {
            out.push(round_ip(p.0 + nk.0 * delta, p.1 + nk.1 * delta));
            out.push(round_ip(p.0, p.1));
            out.push(round_ip(p.0 + nj.0 * delta, p.1 + nj.1 * delta));
        } else {
            match join {
                Join::Miter(_) | Join::Square => {
                    let rr = 1.0 + cos_a;
                    if matches!(join, Join::Miter(_)) && rr >= miter_lim {
                        let q = delta / rr;
                        out.push(round_ip(p.0 + (nk.0 + nj.0) * q, p.1 + (nk.1 + nj.1) * q));
                    } else {
                        let dx = (sin_a.m_atan2(cos_a) / 4.0).m_tan();
                        out.push(round_ip(
                            p.0 + delta * (nk.0 - nk.1 * dx),
                            p.1 + delta * (nk.1 + nk.0 * dx),
                        ));
                        out.push(round_ip(
                            p.0 + delta * (nj.0 + nj.1 * dx),
                            p.1 + delta * (nj.1 - nj.0 * dx),
                        ));
                    }
                }
                Join::Round(_) => {
                    let a = sin_a.m_atan2(cos_a);
                    let steps = ((steps_per_rad * a.abs()).round() as i64).max(1);
                    let (mut x, mut y) = nk;
                    for _ in 0..steps {
                        out.push(round_ip(p.0 + x * delta, p.1 + y * delta));
                        let x2 = x;
                        x = x * cos_step - sin_step * y;
                        y = x2 * sin_step + y * cos_step;
                    }
                    out.push(round_ip(p.0 + nj.0 * delta, p.1 + nj.1 * delta));
                }
            }
        }
        k = j;
    }
    Some(out)
}

/// Orca's `offset(Polylines, delta, jtMiter, 1.2)` with butt ends: each open path grown into a band.
pub(crate) fn offset_polylines(lines: &[Vec<Pt>], delta: f64) -> Shapes {
    let mut raw: Vec<Ring> = Vec::new();
    for l in lines {
        if l.len() < 2 {
            continue;
        }
        // The path there and back as one closed loop, offset with butt caps.
        let mut there: Vec<Pt> = l.clone();
        there.dedup();
        if there.len() < 2 {
            continue;
        }
        let mut back = there.clone();
        back.reverse();
        let mut lp: Vec<(f64, f64)> = Vec::new();
        for seq in [&there, &back] {
            for w in seq.windows(2) {
                let (a, b) = (w[0], w[1]);
                let (dx, dy) = ((b.0 - a.0) as f64, (b.1 - a.1) as f64);
                let len = dx.m_hypot(dy);
                if len == 0.0 {
                    continue;
                }
                let (nx, ny) = (dy / len * delta, -dx / len * delta);
                lp.push((a.0 as f64 + nx, a.1 as f64 + ny));
                lp.push((b.0 as f64 + nx, b.1 as f64 + ny));
            }
        }
        raw.push(lp.into_iter().map(|(x, y)| round_ip(x, y)).collect());
    }
    merge_rings(&raw, FillRule::NonZero)
}

/// Each ring as a closed polyline, first point repeated (Orca's `to_polylines(Polygons)`).
pub(crate) fn to_polylines(s: &Shapes) -> Vec<Vec<Pt>> {
    rings(s)
        .filter(|r| !r.is_empty())
        .map(|r| {
            let mut v: Vec<Pt> = r.iter().map(|p| pt(*p)).collect();
            v.push(v[0]);
            v
        })
        .collect()
}

/// A ring per shape outline and hole, as separate shapes of one ring (Orca's flat `Polygons`).
pub(crate) fn from_rings(r: Vec<Ring>) -> Shapes {
    r.into_iter().filter(|r| r.len() >= 3).map(|r| vec![r]).collect()
}

/// Orca's `make_circle(radius, error)`: a regular polygon starting on the x axis.
pub(crate) fn circle(radius: f64, error: f64) -> Vec<(f64, f64)> {
    let angle = 2.0 * (1.0 - error / radius).m_acos();
    let n = (std::f64::consts::TAU / angle).ceil() as usize;
    circle_n(radius, n)
}

pub(crate) fn circle_n(radius: f64, n: usize) -> Vec<(f64, f64)> {
    let inc = std::f64::consts::TAU / n as f64;
    (0..n)
        .map(|i| {
            let a = inc * i as f64;
            ((a.m_cos() * radius).trunc(), (a.m_sin() * radius).trunc())
        })
        .collect()
}

/// Cura's `PolygonUtils::moveInside` with distance 0: the closest point on the outline of `s` to `from`.
/// Returns the moved point, or `None` when no outline is close enough (`max_dist2`).
pub(crate) fn move_inside(s: &Shapes, from: Pt, max_dist2: i64) -> Option<Pt> {
    let mut ret = from;
    let mut best = f64::MAX;
    let mut found = false;
    for poly in rings(s) {
        if poly.len() < 2 {
            continue;
        }
        let np = poly.len();
        let mut p0 = pt(poly[np - 2]);
        let mut p1 = pt(poly[np - 1]);
        let dotv = |a: Pt, b: Pt| i128::from(a.0) * i128::from(b.0) + i128::from(a.1) * i128::from(b.1);
        let sub = |a: Pt, b: Pt| (a.0 - b.0, a.1 - b.1);
        let mut beyond_prev = dotv(sub(p1, p0), sub(from, p0)) >= dotv(sub(p1, p0), sub(p1, p0));
        for q in poly {
            let p2 = pt(*q);
            let (a, b) = (p1, p2);
            let ab = sub(b, a);
            let ap = sub(from, a);
            let ab2 = dotv(ab, ab);
            if ab2 <= 0 {
                p1 = p2;
                continue;
            }
            let dp = dotv(ab, ap);
            if dp <= 0 {
                if beyond_prev {
                    beyond_prev = false;
                    let x = p1;
                    let d2 = dist2(x, from) as f64;
                    if d2 < best {
                        best = d2;
                        found = true;
                        ret = x;
                    }
                } else {
                    beyond_prev = false;
                    p0 = p1;
                    p1 = p2;
                    continue;
                }
            } else if dp >= ab2 {
                beyond_prev = true;
                p0 = p1;
                p1 = p2;
                continue;
            } else {
                beyond_prev = false;
                let t = dp as f64 / ab2 as f64;
                let x = (a.0 + (ab.0 as f64 * t) as i64, a.1 + (ab.1 as f64 * t) as i64);
                let d2 = dist2(from, x) as f64;
                if d2 < best {
                    best = d2;
                    found = true;
                    ret = x;
                }
            }
            p0 = p1;
            p1 = p2;
        }
        let _ = p0;
    }
    (found && best < max_dist2 as f64).then_some(ret)
}

/// Orca's `move_inside_if_outside`: `from` when inside `s`, else the closest outline point.
pub(crate) fn move_inside_if_outside(s: &Shapes, from: Pt) -> Pt {
    if contains(s, from) {
        return from;
    }
    move_inside(s, from, i64::MAX).unwrap_or(from)
}

/// A ring translated to `c`.
pub(crate) fn ring_at(shape: &[(f64, f64)], c: Pt) -> Ring {
    shape
        .iter()
        .map(|&(x, y)| IntPoint::new((x as i64 + c.0) as i32, (y as i64 + c.1) as i32))
        .collect()
}
