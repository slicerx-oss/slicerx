// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `smooth_outward`, as Orca's MutablePolygon.cpp has it (adapted there from Cura's
//! `ConstPolygonRef::smooth_outward`): concave corners sharper than 135 degrees are cut, narrow cracks are
//! closed up to the clip distance, and small clockwise triangles (tiny holes) are filled. Convex corners stay.

#![allow(
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a linked ring indexed by slot, with plate units in i64"
)]

use super::geo::{self, Ring};
use crate::fm::Fm;
use crate::perimeters::Shapes;
use i_overlay::core::fill_rule::FillRule;
use i_overlay::i_float::int::point::IntPoint;

type P = (i64, i64);

const NONE: i32 = -1;

#[derive(Clone, Copy)]
struct Node {
    p: P,
    prev: i32,
    next: i32,
}

/// A ring as a doubly linked list (`MutablePolygon`).
struct Poly {
    d: Vec<Node>,
    size: i32,
    head: i32,
    free: i32,
}

impl Poly {
    fn new(pts: &[P]) -> Self {
        let n = pts.len() as i32;
        let d = pts
            .iter()
            .enumerate()
            .map(|(i, &p)| Node {
                p,
                prev: i as i32 - 1,
                next: i as i32 + 1,
            })
            .collect::<Vec<_>>();
        let mut s = Self {
            d,
            size: n,
            head: if n > 0 { 0 } else { NONE },
            free: NONE,
        };
        if n > 0 {
            s.d[0].prev = n - 1;
            let last = (n - 1) as usize;
            s.d[last].next = 0;
        }
        s
    }
    fn next(&self, i: i32) -> i32 {
        self.d[i as usize].next
    }
    fn prev(&self, i: i32) -> i32 {
        self.d[i as usize].prev
    }
    fn p(&self, i: i32) -> P {
        self.d[i as usize].p
    }
    fn set(&mut self, i: i32, p: P) {
        self.d[i as usize].p = p;
    }
    fn end(&self) -> i32 {
        if self.size == 0 {
            NONE
        } else {
            self.prev(self.head)
        }
    }
    /// Removes `i`, returning the element after it (or none when the ring is empty).
    fn remove(&mut self, i: i32) -> i32 {
        let (prev, next) = (self.prev(i), self.next(i));
        self.d[i as usize].next = self.free;
        self.free = i;
        self.size -= 1;
        if self.size == 0 {
            self.head = NONE;
            return NONE;
        }
        if self.head == i {
            self.head = next;
        }
        self.d[prev as usize].next = next;
        self.d[next as usize].prev = prev;
        next
    }
    /// Inserts `p` before `i`, returning the new element.
    fn insert(&mut self, i: i32, p: P) -> i32 {
        let j = self.prev(i);
        let n = if self.free == NONE {
            self.d.push(Node { p, prev: j, next: i });
            (self.d.len() - 1) as i32
        } else {
            let n = self.free;
            self.free = self.d[n as usize].next;
            self.d[n as usize] = Node { p, prev: j, next: i };
            n
        };
        self.d[j as usize].next = n;
        self.d[i as usize].prev = n;
        self.size += 1;
        n
    }
    fn clear(&mut self) {
        self.d.clear();
        self.size = 0;
        self.head = NONE;
        self.free = NONE;
    }
    fn points(&self) -> Vec<P> {
        let mut out = Vec::new();
        if self.size >= 3 {
            let mut it = self.head;
            loop {
                out.push(self.p(it));
                it = self.next(it);
                if it == self.head {
                    break;
                }
            }
        }
        out
    }
}

/// The unprocessed elements, from `begin` to `end` inclusive (`MutablePolygon::range`).
struct Range {
    begin: i32,
    end: i32,
}

impl Range {
    fn empty(&self) -> bool {
        self.begin == NONE
    }
    fn make_empty(&mut self) {
        self.begin = NONE;
        self.end = NONE;
    }
    fn advance_front(&mut self, poly: &Poly) {
        if self.begin == self.end {
            self.make_empty();
        } else {
            self.begin = poly.next(self.begin);
        }
    }
    fn retract_back(&mut self, poly: &Poly) {
        if self.begin == self.end {
            self.make_empty();
        } else {
            self.end = poly.prev(self.end);
        }
    }
    fn process_next(&mut self, poly: &Poly) -> i32 {
        let out = self.begin;
        self.advance_front(poly);
        out
    }
    fn remove_front(&mut self, poly: &mut Poly, it: i32) -> i32 {
        if !self.empty() && self.begin == it {
            self.advance_front(poly);
        }
        poly.remove(it)
    }
    fn remove_back(&mut self, poly: &mut Poly, it: i32) -> i32 {
        if !self.empty() && self.end == it {
            self.retract_back(poly);
        }
        poly.remove(it)
    }
}

fn sub(a: P, b: P) -> P {
    (a.0 - b.0, a.1 - b.1)
}
fn cross2(a: P, b: P) -> i128 {
    i128::from(a.0) * i128::from(b.1) - i128::from(a.1) * i128::from(b.0)
}
fn dot(a: P, b: P) -> i128 {
    i128::from(a.0) * i128::from(b.0) + i128::from(a.1) * i128::from(b.1)
}
fn n2(a: P) -> i128 {
    dot(a, a)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Free,
    Blocked,
    Far,
}

/// `clip_narrow_corner`: closes a concave crack left of `it0` and right of `it2`. True when the ring was
/// reduced to nothing or one counterclockwise triangle.
fn clip_narrow_corner(
    poly: &mut Poly,
    p1: P,
    it0: &mut i32,
    it2: &mut i32,
    range: &mut Range,
    mut dist2_current: i128,
    shortcut: i64,
) -> bool {
    let shortcut2 = i128::from(shortcut) * i128::from(shortcut);
    let (mut forward, mut backward) = (Status::Free, Status::Free);
    let mut p0 = poly.p(*it0);
    let mut p2 = poly.p(*it2);
    let mut p02: P = (0, 0);
    let mut p22: P = (0, 0);
    let mut dist2_next: i128 = 0;
    while poly.size >= 3 {
        if forward == Status::Far && backward == Status::Far {
            p02 = poly.p(poly.prev(*it0));
            p22 = poly.p(poly.next(*it2));
            let d2 = n2(sub(p22, p02));
            if d2 <= shortcut2 {
                let r = range.remove_back(poly, *it0);
                *it0 = poly.prev(r);
                *it2 = range.remove_front(poly, *it2);
                if poly.size <= 2 {
                    return true;
                }
                forward = Status::Free;
                backward = Status::Free;
                dist2_current = d2;
                p0 = p02;
                p2 = p22;
            } else {
                dist2_next = d2;
                break;
            }
        } else if forward != Status::Free && backward != Status::Free {
            break;
        }
        if forward == Status::Free && (backward != Status::Free || n2(sub(p2, p1)) < n2(sub(p0, p1))) {
            p22 = poly.p(poly.next(*it2));
            if cross2(sub(p2, p0), sub(p22, p0)) > 0 {
                forward = Status::Blocked;
            } else {
                let d2 = n2(sub(p22, p0));
                if d2 > shortcut2 {
                    forward = Status::Far;
                    dist2_next = d2;
                } else {
                    forward = Status::Free;
                    *it2 = range.remove_front(poly, *it2);
                    p2 = p22;
                    dist2_current = d2;
                }
            }
        } else {
            p02 = poly.p(poly.prev(*it0));
            if cross2(sub(p02, p2), sub(p0, p2)) > 0 {
                backward = Status::Blocked;
            } else {
                let d2 = n2(sub(p2, p02));
                if d2 > shortcut2 {
                    backward = Status::Far;
                    dist2_next = d2;
                } else {
                    backward = Status::Free;
                    let r = range.remove_back(poly, *it0);
                    *it0 = poly.prev(r);
                    p0 = p02;
                    dist2_current = d2;
                }
            }
        }
    }
    if poly.size <= 3 {
        if poly.size < 3 || (forward == Status::Far && backward == Status::Far) {
            poly.clear();
        }
        return true;
    }
    let eps = 1i128;
    let lim = (i128::from(shortcut) - eps) * (i128::from(shortcut) - eps);
    if (forward == Status::Blocked && backward == Status::Blocked) || dist2_current > lim {
        // The crack is filled.
    } else if dist2_next < lim {
        if forward == Status::Far {
            let r = range.remove_back(poly, *it0);
            *it0 = poly.prev(r);
        }
        if backward == Status::Far {
            *it2 = range.remove_front(poly, *it2);
        }
        if poly.size <= 2 {
            return true;
        }
    } else if forward == Status::Blocked || backward == Status::Blocked {
        if forward == Status::Far {
            std::mem::swap(&mut p0, &mut p2);
            std::mem::swap(&mut p02, &mut p22);
        }
        let v = ((p02.0 - p0.0) as f64, (p02.1 - p0.1) as f64);
        let d = ((p0.0 - p2.0) as f64, (p0.1 - p2.1) as f64);
        let a = v.0 * v.0 + v.1 * v.1;
        let b = 2.0 * (d.0 * v.0 + d.1 * v.1);
        let u = (b * b - 4.0 * a * (d.0 * d.0 + d.1 * d.1 - shortcut2 as f64))
            .max(0.0)
            .sqrt();
        let t = (-b + u) / (2.0 * a);
        let target = if backward == Status::Far { *it2 } else { *it0 };
        let q = poly.p(target);
        poly.set(target, (q.0 + (v.0 * t) as i64, q.1 + (v.1 * t) as i64));
    } else {
        let dcur = (dist2_current as f64).sqrt();
        let t = (shortcut as f64 - dcur) / ((dist2_next as f64).sqrt() - dcur);
        let a = poly.p(*it0);
        poly.set(
            *it0,
            (
                a.0 + ((p02.0 - p0.0) as f64 * t) as i64,
                a.1 + ((p02.1 - p0.1) as f64 * t) as i64,
            ),
        );
        let b = poly.p(*it2);
        poly.set(
            *it2,
            (
                b.0 + ((p22.0 - p2.0) as f64 * t) as i64,
                b.1 + ((p22.1 - p2.1) as f64 * t) as i64,
            ),
        );
    }
    false
}

/// `remove_duplicates(polygon, eps)`.
fn remove_duplicates(poly: &mut Poly, eps: f64) {
    if poly.size == 0 {
        return;
    }
    let eps2 = eps * eps;
    let begin = poly.head;
    let mut it = poly.next(begin);
    while it != begin && poly.size > 0 {
        let prev = poly.prev(it);
        let d = sub(poly.p(it), poly.p(prev));
        if (n2(d) as f64) < eps2 {
            it = poly.remove(it);
            if it == NONE {
                break;
            }
        } else {
            it = poly.next(it);
        }
    }
}

/// `smooth_outward` on one ring.
fn smooth_ring(pts: &[P], clip: i64) -> Vec<P> {
    let mut poly = Poly::new(pts);
    remove_duplicates(&mut poly, geo::sc(0.01) as f64);
    let clip2 = i128::from(clip) * i128::from(clip);
    let clip2eps = i128::from(clip + 1) * i128::from(clip + 1);
    let foot_min2 = 1.0;
    let mut range = Range {
        begin: poly.head,
        end: poly.end(),
    };
    while !range.empty() && poly.size > 2 {
        let mut it1 = range.process_next(&poly);
        let mut it0 = poly.prev(it1);
        let mut it2 = poly.next(it1);
        let (p0, p1, p2) = (poly.p(it0), poly.p(it1), poly.p(it2));
        let v1 = sub(p0, p1);
        let v2 = sub(p2, p1);
        if cross2(v1, v2) > 0 {
            let dt = dot(v1, v2);
            let (mut l2v1, mut l2v2) = (n2(v1) as f64, n2(v2) as f64);
            if dt > 0 || (dt as f64) * (dt as f64) * 2.0 < l2v1 * l2v2 {
                let v02 = sub(p2, p0);
                let l2v02 = n2(v02);
                poly.remove(it1);
                if l2v02 < clip2 {
                    if clip_narrow_corner(&mut poly, p1, &mut it0, &mut it2, &mut range, l2v02, clip) {
                        return poly.points_or_triangle();
                    }
                } else if l2v02 > clip2eps {
                    let (mut v1d, mut v2d) = ((v1.0 as f64, v1.1 as f64), (v2.0 as f64, v2.1 as f64));
                    let swap = l2v1 > l2v2;
                    if swap {
                        std::mem::swap(&mut v1d, &mut v2d);
                        std::mem::swap(&mut l2v1, &mut l2v2);
                    }
                    let lv1 = l2v1.sqrt();
                    let lv2 = l2v2.sqrt();
                    let bis = (v1d.0 / lv1 + v2d.0 / lv2, v1d.1 / lv1 + v2d.1 / lv2);
                    let l2b = bis.0 * bis.0 + bis.1 * bis.1;
                    let dd = l2v1 - (v1d.0 * bis.0 + v1d.1 * bis.1).m_powi(2) / l2b;
                    if dd < foot_min2 {
                        // Tiny triangle: p1 is just removed.
                    } else if dd < 0.25 * clip2 as f64 + 1.0 {
                        let b = -2.0 * (v1d.0 * v2d.0 + v1d.1 * v2d.1);
                        let u = b * b - 4.0 * l2v2 * (l2v1 - clip2 as f64);
                        let t = (-b + u.max(0.0).sqrt()) / (2.0 * l2v2);
                        let np = (p1.0 + (t * v2d.0) as i64, p1.1 + (t * v2d.1) as i64);
                        poly.insert(it2, np);
                    } else {
                        let t = (0.25 * clip2 as f64 / dd).sqrt();
                        let t2 = t * lv1 / lv2;
                        let mut q0 = (p1.0 + (v1d.0 * t) as i64, p1.1 + (v1d.1 * t) as i64);
                        let mut q2 = (p1.0 + (v2d.0 * t2) as i64, p1.1 + (v2d.1 * t2) as i64);
                        if swap {
                            std::mem::swap(&mut q0, &mut q2);
                        }
                        let n = poly.insert(it2, q2);
                        poly.insert(n, q0);
                    }
                }
                it1 = it2;
                let _ = it1;
            }
        }
    }
    if poly.size == 3 {
        let p0 = poly.p(poly.prev(poly.head));
        let p1 = poly.p(poly.head);
        let p2 = poly.p(poly.next(poly.head));
        let mut v1 = sub(p0, p1);
        let mut v2 = sub(p2, p1);
        if cross2(v1, v2) > 0 {
            let v3 = sub(p2, p0);
            let (mut l12, mut l22, l32) = (n2(v1), n2(v2), n2(v3));
            if l22 > l12 && l22 > l32 {
                std::mem::swap(&mut v1, &mut v2);
                std::mem::swap(&mut l12, &mut l22);
            } else if l32 > l12 && l32 > l22 {
                v1 = v3;
                l12 = l32;
            }
            let h2 = l22 as f64 - (dot(v1, v2) as f64).m_powi(2) / l12 as f64;
            if h2 < clip2 as f64 {
                poly.clear();
            }
        }
    } else if poly.size < 3 {
        poly.clear();
    }
    poly.points()
}

impl Poly {
    fn points_or_triangle(&self) -> Vec<P> {
        self.points()
    }
}

/// `smooth_outward(Polygons, clip)`: every ring of `s` smoothed, then united again.
pub(crate) fn smooth_outward(s: &Shapes, clip: i64) -> Shapes {
    let mut out: Vec<Ring> = Vec::new();
    for r in geo::rings(s) {
        let pts: Vec<P> = r.iter().map(|p| geo::pt(*p)).collect();
        let sm = smooth_ring(&pts, clip);
        if sm.len() >= 3 {
            out.push(
                sm.into_iter()
                    .map(|(x, y)| IntPoint::new(x as i32, y as i32))
                    .collect(),
            );
        }
    }
    geo::merge_rings(&out, FillRule::NonZero)
}
