// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Outward smoothing of polygons: concave corners sharper than 135 degrees are cut, and notches narrower
//! than a clip distance are filled, so the area only grows. Our implementation of the algorithm of Orca's
//! MutablePolygon.cpp `smooth_outward` and `clip_narrow_corner` (after Cura's `smooth_outward`), used for the
//! snug support areas.

#![allow(
    clippy::indexing_slicing,
    reason = "indexes are links of the ring's own lists, always in range"
)]

use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

/// Orca's `SCALED_EPSILON` (0.0001 mm) in our units.
const EPS: i64 = 1;

/// A closed ring as a doubly linked list over a vector, so points can be removed and inserted while walking it.
struct Ring {
    p: Vec<[i64; 2]>,
    next: Vec<usize>,
    prev: Vec<usize>,
    size: usize,
    head: usize,
}

impl Ring {
    fn new(pts: &[IntPoint<i32>]) -> Self {
        let n = pts.len();
        Self {
            p: pts.iter().map(|q| [i64::from(q.x), i64::from(q.y)]).collect(),
            next: (0..n).map(|i| (i + 1) % n.max(1)).collect(),
            prev: (0..n).map(|i| (i + n - 1) % n.max(1)).collect(),
            size: n,
            head: 0,
        }
    }

    /// Removes `i` and returns the point after it.
    fn remove(&mut self, i: usize) -> usize {
        let (a, b) = (self.prev[i], self.next[i]);
        self.next[a] = b;
        self.prev[b] = a;
        self.size -= 1;
        if self.head == i {
            self.head = b;
        }
        b
    }

    /// Inserts `q` before `i` and returns it.
    fn insert(&mut self, i: usize, q: [i64; 2]) -> usize {
        let a = self.prev[i];
        let n = self.p.len();
        self.p.push(q);
        self.next.push(i);
        self.prev.push(a);
        self.next[a] = n;
        self.prev[i] = n;
        self.size += 1;
        n
    }

    fn points(&self) -> Vec<IntPoint<i32>> {
        let mut out = Vec::with_capacity(self.size);
        let mut i = self.head;
        for _ in 0..self.size {
            #[allow(clippy::cast_possible_truncation, reason = "points stay on the plate")]
            out.push(IntPoint::new(self.p[i][0] as i32, self.p[i][1] as i32));
            i = self.next[i];
        }
        out
    }
}

/// The points not processed yet, from `b` to `e` inclusive.
struct Range {
    b: usize,
    e: usize,
    empty: bool,
}

impl Range {
    fn next(&mut self, r: &Ring) -> usize {
        let out = self.b;
        self.advance(r);
        out
    }
    fn advance(&mut self, r: &Ring) {
        if self.b == self.e {
            self.empty = true;
        } else {
            self.b = r.next[self.b];
        }
    }
    fn retract(&mut self, r: &Ring) {
        if self.b == self.e {
            self.empty = true;
        } else {
            self.e = r.prev[self.e];
        }
    }
    fn remove_front(&mut self, r: &mut Ring, i: usize) -> usize {
        if !self.empty && self.b == i {
            self.advance(r);
        }
        r.remove(i)
    }
    fn remove_back(&mut self, r: &mut Ring, i: usize) -> usize {
        if !self.empty && self.e == i {
            self.retract(r);
        }
        r.remove(i)
    }
}

fn sub(a: [i64; 2], b: [i64; 2]) -> [i64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}
fn cross(a: [i64; 2], b: [i64; 2]) -> i128 {
    i128::from(a[0]) * i128::from(b[1]) - i128::from(a[1]) * i128::from(b[0])
}
fn dot(a: [i64; 2], b: [i64; 2]) -> i64 {
    a[0] * b[0] + a[1] * b[1]
}
fn norm2(a: [i64; 2]) -> i64 {
    dot(a, a)
}
#[allow(clippy::cast_precision_loss, reason = "coordinates are far below 2^52")]
fn f(a: [i64; 2]) -> [f64; 2] {
    [a[0] as f64, a[1] as f64]
}
#[allow(clippy::cast_possible_truncation, reason = "offsets on the plate")]
fn add_scaled(p: [i64; 2], v: [f64; 2], t: f64) -> [i64; 2] {
    [p[0] + (v[0] * t) as i64, p[1] + (v[1] * t) as i64]
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Free,
    Blocked,
    Far,
}

/// Fills the narrow notch whose tip was at `p1` by walking both sides while they stay closer than `len`.
/// Returns true when the ring is used up (cleared or left as one triangle).
#[allow(
    clippy::too_many_lines,
    clippy::cast_precision_loss,
    reason = "one algorithm, coordinates far below 2^52"
)]
fn clip_narrow_corner(
    r: &mut Ring,
    p1: [i64; 2],
    it0: &mut usize,
    it2: &mut usize,
    range: &mut Range,
    mut d2_cur: i64,
    len: i64,
) -> bool {
    let len2 = len * len;
    let (mut fwd, mut back) = (Side::Free, Side::Free);
    let (mut p0, mut p2) = (r.p[*it0], r.p[*it2]);
    let (mut p02, mut p22) = ([0i64; 2], [0i64; 2]);
    let mut d2_next = 0i64;
    while r.size >= 3 {
        if fwd == Side::Far && back == Side::Far {
            p02 = r.p[r.prev[*it0]];
            p22 = r.p[r.next[*it2]];
            let d2 = norm2(sub(p22, p02));
            if d2 <= len2 {
                // Still narrow: trim both sides.
                let at = range.remove_back(r, *it0);
                *it0 = r.prev[at];
                *it2 = range.remove_front(r, *it2);
                if r.size <= 2 {
                    return true;
                }
                (fwd, back, d2_cur, p0, p2) = (Side::Free, Side::Free, d2, p02, p22);
            } else {
                d2_next = d2;
                break;
            }
        } else if fwd != Side::Free && back != Side::Free {
            break;
        }
        if fwd == Side::Free && (back != Side::Free || norm2(sub(p2, p1)) < norm2(sub(p0, p1))) {
            p22 = r.p[r.next[*it2]];
            if cross(sub(p2, p0), sub(p22, p0)) > 0 {
                fwd = Side::Blocked;
            } else {
                let d2 = norm2(sub(p22, p0));
                if d2 > len2 {
                    fwd = Side::Far;
                    d2_next = d2;
                } else {
                    fwd = Side::Free;
                    *it2 = range.remove_front(r, *it2);
                    p2 = p22;
                    d2_cur = d2;
                }
            }
        } else {
            p02 = r.p[r.prev[*it0]];
            if cross(sub(p02, p2), sub(p0, p2)) > 0 {
                back = Side::Blocked;
            } else {
                let d2 = norm2(sub(p2, p02));
                if d2 > len2 {
                    back = Side::Far;
                    d2_next = d2;
                } else {
                    back = Side::Free;
                    let at = range.remove_back(r, *it0);
                    *it0 = r.prev[at];
                    p0 = p02;
                    d2_cur = d2;
                }
            }
        }
    }
    if r.size <= 3 {
        if r.size < 3 || (fwd == Side::Far && back == Side::Far) {
            r.size = 0;
        }
        return true;
    }
    let short2 = (len - EPS) * (len - EPS);
    if (fwd == Side::Blocked && back == Side::Blocked) || d2_cur > short2 {
        // The notch is filled; the last clipping edge stays.
    } else if d2_next < short2 {
        // No tiny edges.
        if fwd == Side::Far {
            let at = range.remove_back(r, *it0);
            *it0 = r.prev[at];
        }
        if back == Side::Far {
            *it2 = range.remove_front(r, *it2);
        }
        if r.size <= 2 {
            return true;
        }
    } else if fwd == Side::Blocked || back == Side::Blocked {
        // One side far, the other blocked: clip the far edge where it is `len` from the other side.
        if fwd == Side::Far {
            std::mem::swap(&mut p0, &mut p2);
            std::mem::swap(&mut p02, &mut p22);
        }
        let v = f(sub(p02, p0));
        let d = f(sub(p0, p2));
        let a = v[0] * v[0] + v[1] * v[1];
        let b = 2.0 * (d[0] * v[0] + d[1] * v[1]);
        let u = (b * b - 4.0 * a * (d[0] * d[0] + d[1] * d[1] - len2 as f64))
            .max(0.0)
            .sqrt();
        let t = (-b + u) / (2.0 * a);
        let at = if back == Side::Far { *it2 } else { *it0 };
        r.p[at] = add_scaled(r.p[at], v, t);
    } else {
        // Both far: the notch widens past `len`; trim the trapezoid where it is `len` wide.
        let cur = (d2_cur as f64).sqrt();
        let t = (len as f64 - cur) / ((d2_next as f64).sqrt() - cur);
        r.p[*it0] = add_scaled(p0, f(sub(p02, p0)), t);
        r.p[*it2] = add_scaled(p2, f(sub(p22, p2)), t);
    }
    false
}

/// Smooths one ring outward with clip distance `clip` (our units). Empty when it is used up.
#[allow(clippy::cast_precision_loss, reason = "coordinates far below 2^52")]
fn smooth_ring(pts: &[IntPoint<i32>], clip: i64) -> Vec<IntPoint<i32>> {
    // Orca removes points closer than 0.01 mm to the one before first.
    let near = |a: &IntPoint<i32>, b: &IntPoint<i32>| {
        let (dx, dy) = (i64::from(a.x - b.x), i64::from(a.y - b.y));
        dx * dx + dy * dy < 100 * 100
    };
    let mut src: Vec<IntPoint<i32>> = Vec::with_capacity(pts.len());
    for q in pts {
        if src.last().is_none_or(|l| !near(l, q)) {
            src.push(*q);
        }
    }
    while src.len() > 1 && src.first().zip(src.last()).is_some_and(|(a, b)| near(a, b)) {
        src.pop();
    }
    if src.len() < 3 {
        return Vec::new();
    }
    let mut r = Ring::new(&src);
    let clip2 = clip * clip;
    let clip2eps = (clip + EPS) * (clip + EPS);
    let foot_min2 = (EPS * EPS) as f64;
    let mut range = Range {
        b: r.head,
        e: r.prev[r.head],
        empty: false,
    };
    while !range.empty && r.size > 2 {
        let it1 = range.next(&r);
        let (it0, it2) = (r.prev[it1], r.next[it1]);
        let (p0, p1, p2) = (r.p[it0], r.p[it1], r.p[it2]);
        let (v1, v2) = (sub(p0, p1), sub(p2, p1));
        if cross(v1, v2) <= 0 {
            continue;
        }
        // A concave corner.
        let d = dot(v1, v2);
        let (l2v1, l2v2) = (norm2(v1) as f64, norm2(v2) as f64);
        if !(d > 0 || (d as f64) * (d as f64) * 2.0 < l2v1 * l2v2) {
            continue;
        }
        // Sharper than 135 degrees.
        let v02 = sub(p2, p0);
        let l2v02 = norm2(v02);
        r.remove(it1);
        let (mut a, mut c) = (it0, it2);
        if l2v02 < clip2 {
            if clip_narrow_corner(&mut r, p1, &mut a, &mut c, &mut range, l2v02, clip) {
                // Used up, or one triangle that stays.
                return if r.size >= 3 { r.points() } else { Vec::new() };
            }
        } else if l2v02 > clip2eps {
            let (mut v1d, mut v2d, mut l1, mut l2) = (f(v1), f(v2), l2v1, l2v2);
            let swap = l1 > l2;
            if swap {
                std::mem::swap(&mut v1d, &mut v2d);
                std::mem::swap(&mut l1, &mut l2);
            }
            let (lv1, lv2) = (l1.sqrt(), l2.sqrt());
            let bis = [v1d[0] / lv1 + v2d[0] / lv2, v1d[1] / lv1 + v2d[1] / lv2];
            let lb2 = bis[0] * bis[0] + bis[1] * bis[1];
            let vb = v1d[0] * bis[0] + v1d[1] * bis[1];
            let d2 = l1 - vb * vb / lb2;
            if d2 < foot_min2 {
                // A flat triangle: p1 just goes.
            } else if d2 < 0.25 * clip2 as f64 + EPS as f64 {
                // The shorter side is close to the bisector: cut along a circle of `clip` around its end.
                let b = -2.0 * (v1d[0] * v2d[0] + v1d[1] * v2d[1]);
                let u = (b * b - 4.0 * l2 * (l1 - clip2 as f64)).max(0.0);
                let t = (-b + u.sqrt()) / (2.0 * l2);
                r.insert(c, add_scaled(p1, v2d, t));
            } else {
                // Cut the corner square to the bisector.
                let t = (0.25 * clip2 as f64 / d2).sqrt();
                let t2 = t * lv1 / lv2;
                let mut q0 = add_scaled(p1, v1d, t);
                let mut q2 = add_scaled(p1, v2d, t2);
                if swap {
                    std::mem::swap(&mut q0, &mut q2);
                }
                let at = r.insert(c, q2);
                r.insert(at, q0);
            }
        }
    }
    if r.size == 3 {
        // A clockwise triangle (a hole) lower than `clip` closes.
        let i1 = r.head;
        let (p0, p1, p2) = (r.p[r.prev[i1]], r.p[i1], r.p[r.next[i1]]);
        let (mut v1, mut v2) = (sub(p0, p1), sub(p2, p1));
        if cross(v1, v2) > 0 {
            let v3 = sub(p2, p0);
            let (mut l12, l22, l32) = (norm2(v1), norm2(v2), norm2(v3));
            if l22 > l12 && l22 > l32 {
                std::mem::swap(&mut v1, &mut v2);
                l12 = l22;
            } else if l32 > l12 && l32 > l22 {
                v1 = v3;
                l12 = l32;
            }
            let dd = dot(v1, v2) as f64;
            let h2 = norm2(v2) as f64 - dd * dd / l12 as f64;
            if h2 < clip2 as f64 {
                return Vec::new();
            }
        }
    } else if r.size < 3 {
        return Vec::new();
    }
    r.points()
}

/// `area` grown only where its outline turns inward: concave corners cut and notches narrower than `clip`
/// (our units) filled, holes included. The result is cleaned up by a union.
pub(crate) fn smooth_outward(area: &Shapes, clip: i32) -> Shapes {
    let clip = i64::from(clip.max(1));
    let rings: Shapes = area
        .iter()
        .filter_map(|sh| {
            let mut out = sh
                .iter()
                .map(|ring| smooth_ring(ring, clip))
                .filter(|r| r.len() >= 3);
            let outer = out.next()?;
            Some(std::iter::once(outer).chain(out).collect::<Vec<_>>())
        })
        .collect();
    perimeters::union_all(&[&rings])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::mm;

    fn p(x: f64, y: f64) -> IntPoint<i32> {
        IntPoint::new(mm(x), mm(y))
    }

    /// Area in mm2 (holes count negative: they wind clockwise).
    #[allow(clippy::cast_precision_loss, reason = "test sizes")]
    fn area(sh: &Shapes) -> f64 {
        sh.iter()
            .flatten()
            .map(|r| crate::geom::area2_int(r) as f64 / 2.0 / 1e8)
            .sum()
    }

    #[test]
    fn a_narrow_notch_fills_and_a_wide_one_stays() {
        // A 20 mm square with a V notch 0.3 mm wide at the edge and 5 mm deep: narrower than a line, it fills.
        let notch = vec![vec![vec![
            p(0.0, 0.0),
            p(20.0, 0.0),
            p(20.0, 20.0),
            p(10.15, 20.0),
            p(10.0, 15.0),
            p(9.85, 20.0),
            p(0.0, 20.0),
        ]]];
        let a = area(&smooth_outward(&notch, mm(0.42)));
        assert!((a - 400.0).abs() < 0.01, "{a}");
        // A 3 mm wide slot stays a slot: its two inner corners are cut a little, nothing more.
        let slot = vec![vec![vec![
            p(0.0, 0.0),
            p(20.0, 0.0),
            p(20.0, 20.0),
            p(11.5, 20.0),
            p(11.5, 15.0),
            p(8.5, 15.0),
            p(8.5, 20.0),
            p(0.0, 20.0),
        ]]];
        let a = area(&smooth_outward(&slot, mm(0.42)));
        assert!((385.0 - 1e-6..385.2).contains(&a), "{a}");
        // A convex square is left as it is.
        let sq = vec![vec![vec![p(0.0, 0.0), p(5.0, 0.0), p(5.0, 5.0), p(0.0, 5.0)]]];
        assert!((area(&smooth_outward(&sq, mm(0.42))) - 25.0).abs() < 1e-6);
    }
}
