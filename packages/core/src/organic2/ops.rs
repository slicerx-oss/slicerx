// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Polygon helpers organic trees use on top of the crate's booleans and offsets, in millimeters at the
//! call sites and internal units inside.

use super::params::u;
use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

pub(crate) type P = IntPoint<i32>;

/// Grows (or with a negative `d`, shrinks) with mitered corners.
pub(crate) fn grow(s: &Shapes, d: f64) -> Shapes {
    if s.is_empty() {
        return Vec::new();
    }
    let du = u(d);
    if du == 0 {
        return s.clone();
    }
    perimeters::offset(s, du)
}

/// Grows (or shrinks) with round corners.
pub(crate) fn grow_round(s: &Shapes, d: f64) -> Shapes {
    if s.is_empty() {
        return Vec::new();
    }
    let du = u(d);
    match du.cmp(&0) {
        std::cmp::Ordering::Greater => perimeters::offset_round(s, du),
        std::cmp::Ordering::Less => perimeters::shrink_round(s, -du),
        std::cmp::Ordering::Equal => s.clone(),
    }
}

/// Grows with square corners.
pub(crate) fn grow_square(s: &Shapes, d: f64) -> Shapes {
    if s.is_empty() {
        return Vec::new();
    }
    perimeters::offset_square(s, u(d))
}

pub(crate) fn union(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() {
        return b.clone();
    }
    if b.is_empty() {
        return a.clone();
    }
    perimeters::union_all(&[a, b])
}

pub(crate) fn union_many(sets: &[&Shapes]) -> Shapes {
    let non_empty: Vec<&Shapes> = sets.iter().copied().filter(|s| !s.is_empty()).collect();
    match non_empty.as_slice() {
        [] => Vec::new(),
        [one] => (*one).clone(),
        _ => perimeters::union_all(&non_empty),
    }
}

pub(crate) fn diff(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() {
        return Vec::new();
    }
    perimeters::difference(a, b)
}

/// True when `a` and `b` share some area.
pub(crate) fn overlap(a: &Shapes, b: &Shapes) -> bool {
    !a.is_empty() && !b.is_empty() && perimeters::overlap(a, b)
}

pub(crate) fn inter(a: &Shapes, b: &Shapes) -> Shapes {
    perimeters::intersection(a, b)
}

/// Rings simplified to `tol` millimeters. A ring that would fall under three points (one smaller than the
/// tolerance, such as a tip's tiny circle) keeps its points.
pub(crate) fn simplify(s: &Shapes, tol: f64) -> Shapes {
    let t = i64::from(u(tol).max(1));
    s.iter()
        .filter_map(|sh| {
            let mut rings = sh
                .iter()
                .map(|r| {
                    let q = perimeters::simplify_ring(r, t);
                    if q.len() >= 3 { q } else { r.clone() }
                })
                .filter(|r| r.len() >= 3);
            let outer = rings.next()?;
            Some(std::iter::once(outer).chain(rings).collect::<Vec<_>>())
        })
        .collect()
}

/// Area in square millimeters (holes subtract).
#[allow(clippy::cast_precision_loss, reason = "areas on a print bed")]
pub(crate) fn area(s: &Shapes) -> f64 {
    let twice: i64 = s.iter().flatten().map(|r| crate::geom::area2_int(r)).sum();
    twice as f64 / 2.0 / (SCALE * SCALE)
}

/// Area of one shape (outline less holes) in square millimeters.
#[allow(clippy::cast_precision_loss, reason = "areas on a print bed")]
pub(crate) fn shape_area(sh: &[Vec<P>]) -> f64 {
    let twice: i64 = sh.iter().map(|r| crate::geom::area2_int(r)).sum();
    twice as f64 / 2.0 / (SCALE * SCALE)
}

/// True when the area is under `eps` squared (`eps` in millimeters).
pub(crate) fn tiny(s: &Shapes, eps: f64) -> bool {
    s.is_empty() || area(s) < eps * eps
}

/// Perimeter length of all rings, millimeters.
pub(crate) fn perimeter(s: &Shapes) -> f64 {
    s.iter().flatten().map(|r| ring_length(r, true)).sum()
}

pub(crate) fn ring_length(r: &[P], closed: bool) -> f64 {
    let mut len: f64 = r
        .windows(2)
        .map(|w| match w {
            [a, b] => dist(*a, *b),
            _ => 0.0,
        })
        .sum();
    if closed && let (Some(a), Some(b)) = (r.last(), r.first()) {
        len += dist(*a, *b);
    }
    len
}

/// Distance in millimeters.
pub(crate) fn dist(a: P, b: P) -> f64 {
    f64::from(b.x - a.x).m_hypot(f64::from(b.y - a.y)) / SCALE
}

/// True when `p` lies inside the shapes (inside an outline and outside its holes).
pub(crate) fn contains(s: &Shapes, p: P) -> bool {
    s.iter().any(|sh| {
        let mut rings = sh.iter();
        rings.next().is_some_and(|outer| perimeters::point_in(outer, p))
            && !rings.any(|hole| perimeters::point_in(hole, p))
    })
}

/// The nearest point to `p` on segment `a`-`b`.
pub(crate) fn project(a: P, b: P, p: P) -> P {
    let (ax, ay) = (f64::from(a.x), f64::from(a.y));
    let (dx, dy) = (f64::from(b.x) - ax, f64::from(b.y) - ay);
    let len2 = dx * dx + dy * dy;
    if len2 <= 0.0 {
        return a;
    }
    let t = (((f64::from(p.x) - ax) * dx + (f64::from(p.y) - ay) * dy) / len2).clamp(0.0, 1.0);
    to_p(ax + dx * t, ay + dy * t)
}

#[allow(clippy::cast_possible_truncation, reason = "a point on the plate")]
pub(crate) fn to_p(x: f64, y: f64) -> P {
    P::new(x.round() as i32, y.round() as i32)
}

/// The nearest point on any ring of `s` to `p`, with its distance in millimeters.
pub(crate) fn nearest_on_boundary(s: &Shapes, p: P) -> Option<(P, f64)> {
    let mut best: Option<(P, f64)> = None;
    for r in s.iter().flatten() {
        let n = r.len();
        for i in 0..n {
            let (Some(&a), Some(&b)) = (r.get(i), r.get((i + 1) % n)) else {
                continue;
            };
            let q = project(a, b, p);
            let d = dist(p, q);
            if best.is_none_or(|(_, bd)| d < bd) {
                best = Some((q, d));
            }
        }
    }
    best
}

/// `p` if it lies inside `s`, else the nearest point of the boundary.
pub(crate) fn move_inside(s: &Shapes, p: P) -> P {
    if s.is_empty() || contains(s, p) {
        return p;
    }
    nearest_on_boundary(s, p).map_or(p, |(q, _)| q)
}

/// A circle of radius `r` mm around `c` with `n` sides, counterclockwise.
pub(crate) fn circle(c: P, r: f64, n: u32) -> Shapes {
    let ru = r * SCALE;
    let ring: Vec<P> = (0..n)
        .map(|i| {
            let a = std::f64::consts::TAU * f64::from(i) / f64::from(n);
            let (sn, cs) = a.m_sin_cos();
            to_p(f64::from(c.x) + ru * cs, f64::from(c.y) + ru * sn)
        })
        .collect();
    vec![vec![ring]]
}

/// A circle with sides short enough for a chord error of 0.015 mm (at least 8).
pub(crate) fn round_circle(c: P, r: f64) -> Shapes {
    circle(c, r, circle_sides(r))
}

/// Sides of a circle of radius `r` for a chord error of 0.015 mm.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a few hundred sides"
)]
pub(crate) fn circle_sides(r: f64) -> u32 {
    if r <= 0.015 {
        return 8;
    }
    let step = 2.0 * (1.0 - 0.015 / r).clamp(-1.0, 1.0).m_acos();
    if step <= 0.0 {
        return 8;
    }
    ((std::f64::consts::TAU / step).ceil() as u32).clamp(8, 720)
}

/// Polylines as areas `half` mm to each side.
pub(crate) fn stroke(lines: &[Vec<Point>], half: f64) -> Shapes {
    crate::support::stroke(lines, half)
}

/// The outline rings of `s` as closed polylines.
pub(crate) fn outlines(s: &Shapes) -> Vec<Vec<Point>> {
    s.iter()
        .flatten()
        .map(|r| {
            let mut l: Vec<Point> = r.iter().map(|p| Point::new(p.x, p.y)).collect();
            if let Some(&f) = l.first() {
                l.push(f);
            }
            l
        })
        .collect()
}

/// Grows `area` by `dist` in steps of at most `step`, taking `obstacle` out after each step, so the area
/// cannot jump across a thin obstacle. Up to `free` mm of the distance may go in one last step.
/// Every tenth step the result is simplified to 0.015 mm.
pub(crate) fn safe_grow(area: &Shapes, dist: f64, obstacle: &Shapes, step: f64, free: f64) -> Shapes {
    if area.is_empty() || dist <= 0.0 {
        return area.clone();
    }
    let step = step.max(0.01);
    let mut left = dist;
    let mut cur = area.clone();
    let mut n = 0u32;
    while left > 1e-9 {
        let d = if left <= free.max(step) { left } else { step };
        cur = diff(&grow_round(&cur, d), obstacle);
        left -= d;
        n += 1;
        if n.is_multiple_of(10) {
            cur = simplify(&cur, 0.015);
        }
        if cur.is_empty() {
            break;
        }
    }
    // Round grows add points at every corner, so an area grown layer after layer gains points without
    // end; the result is simplified to the same 0.015 mm whatever the step count.
    if !n.is_multiple_of(10) {
        cur = simplify(&cur, 0.015);
    }
    cur
}

/// A union that never turns non-empty inputs into an empty result: when the union collapses, the inputs'
/// outlines are grown by 0.002 mm and united instead.
pub(crate) fn safe_union(sets: &[&Shapes]) -> Shapes {
    let out = union_many(sets);
    if !out.is_empty() || sets.iter().all(|s| s.is_empty()) {
        return out;
    }
    let grown: Vec<Shapes> = sets.iter().map(|s| stroke(&outlines(s), 0.002)).collect();
    let refs: Vec<&Shapes> = sets.iter().copied().chain(grown.iter()).collect();
    union_many(&refs)
}

/// Bounding box `[x0, y0, x1, y1]` in internal units.
pub(crate) fn bbox(s: &Shapes) -> Option<[i32; 4]> {
    perimeters::bounds(s)
}

/// True when two boxes overlap after growing `a` by `grow_u` units.
pub(crate) fn boxes_touch(a: Option<[i32; 4]>, b: Option<[i32; 4]>, grow_u: i32) -> bool {
    match (a, b) {
        (Some([ax0, ay0, ax1, ay1]), Some([bx0, by0, bx1, by1])) => {
            ax0 - grow_u <= bx1 && bx0 <= ax1 + grow_u && ay0 - grow_u <= by1 && by0 <= ay1 + grow_u
        }
        _ => false,
    }
}

/// A rectangle `[x0, y0, x1, y1]` in millimeters as shapes.
pub(crate) fn rect(r: [f64; 4]) -> Shapes {
    let [x0, y0, x1, y1] = r;
    vec![vec![vec![
        P::new(u(x0), u(y0)),
        P::new(u(x1), u(y0)),
        P::new(u(x1), u(y1)),
        P::new(u(x0), u(y1)),
    ]]]
}

/// Each island of `s` on its own.
pub(crate) fn islands(s: &Shapes) -> Vec<Shapes> {
    s.iter().map(|sh| vec![sh.clone()]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x0: f64, y0: f64, side: f64) -> Shapes {
        rect([x0, y0, x0 + side, y0 + side])
    }

    #[test]
    fn area_and_contains() {
        let s = square(0.0, 0.0, 10.0);
        assert!((area(&s) - 100.0).abs() < 1e-6);
        assert!(contains(&s, P::new(u(5.0), u(5.0))));
        assert!(!contains(&s, P::new(u(15.0), u(5.0))));
        let q = move_inside(&s, P::new(u(15.0), u(5.0)));
        assert_eq!(q, P::new(u(10.0), u(5.0)));
    }

    #[test]
    fn safe_grow_does_not_cross_a_wall() {
        // A 0.2 mm wall 1 mm right of the square: one big grow jumps it, growth in steps thinner than the
        // wall does not.
        let s = square(0.0, 0.0, 2.0);
        let wall = rect([3.0, -5.0, 3.2, 7.0]);
        let g = safe_grow(&s, 3.0, &wall, 0.1, 0.0);
        assert!(!contains(&g, P::new(u(4.0), u(1.0))));
        assert!(contains(&g, P::new(u(2.8), u(1.0))));
        let jump = diff(&grow_round(&s, 3.0), &wall);
        assert!(contains(&jump, P::new(u(4.0), u(1.0))));
    }

    #[test]
    fn simplify_keeps_tiny_rings() {
        let tip = circle(P::new(0, 0), 0.01, 25);
        assert_eq!(simplify(&tip, 0.0125).len(), 1);
    }

    #[test]
    fn sides_for_chord_error() {
        assert!(circle_sides(1.0) >= 18);
        assert_eq!(circle_sides(0.01), 8);
        let c = round_circle(P::new(0, 0), 2.0);
        // 26 sides: the polygon is about 1 percent under the circle.
        assert!((area(&c) - std::f64::consts::PI * 4.0).abs() < 0.2);
    }
}
