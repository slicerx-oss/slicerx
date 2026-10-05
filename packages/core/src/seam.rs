// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Painted seams (`paint_seam`): where the user painted the model, a wall ring starts its seam
//! on the painted stretch (enforcer) or stays off it (blocker).
//!
//! A ring point is enforced when a painted enforcer triangle lies within one line width of it in
//! 3D, blocked when a blocker does (a blocker wins). Edges near an enforcer get a point every
//! 0.2 mm, so the seam can land inside the stretch. With enforcers on a ring, only enforced points
//! can hold the seam; the aligned modes pick the middle of the longest stretch, or its sharpest
//! corner when it has one. With only blockers, the seam stays on the unblocked points.

use crate::config::SeamPosition;
use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use i_overlay::i_float::int::point::IntPoint;

/// One painted triangle in plate coordinates, mm.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SeamFace {
    pub(crate) tri: [[f64; 3]; 3],
    pub(crate) enforcer: bool,
}

/// Step between the extra points along an edge near an enforcer, mm.
pub(crate) const OVERSAMPLE_MM: f64 = 0.2;
/// A corner this sharp takes the seam from the middle of an enforced stretch.
pub(crate) const SHARP_TURN: f64 = 55.0 * std::f64::consts::PI / 180.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Blocked,
    Neutral,
    Enforced,
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Squared distance from `p` to the closest point of triangle `t`.
fn dist2_to_triangle(p: [f64; 3], t: &[[f64; 3]; 3]) -> f64 {
    let [a, b, c] = *t;
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    let at = |q: [f64; 3]| {
        let d = sub(p, q);
        dot(d, d)
    };
    if d1 <= 0.0 && d2 <= 0.0 {
        return at(a);
    }
    let bp = sub(p, b);
    let (d3, d4) = (dot(ab, bp), dot(ac, bp));
    if d3 >= 0.0 && d4 <= d3 {
        return at(b);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return at([a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]);
    }
    let cp = sub(p, c);
    let (d5, d6) = (dot(ab, cp), dot(ac, cp));
    if d6 >= 0.0 && d5 <= d6 {
        return at(c);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return at([a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]);
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return at([
            b[0] + (c[0] - b[0]) * w,
            b[1] + (c[1] - b[1]) * w,
            b[2] + (c[2] - b[2]) * w,
        ]);
    }
    let denom = 1.0 / (va + vb + vc);
    let (v, w) = (vb * denom, vc * denom);
    at([
        a[0] + ab[0] * v + ac[0] * w,
        a[1] + ab[1] * v + ac[1] * w,
        a[2] + ab[2] * v + ac[2] * w,
    ])
}

/// Whether a painted triangle of the given kind lies within `radius` of `p`.
pub(crate) fn near(p: [f64; 3], faces: &[SeamFace], enforcer: bool, radius: f64) -> bool {
    faces
        .iter()
        .filter(|f| f.enforcer == enforcer)
        .any(|f| dist2_to_triangle(p, &f.tri) <= radius * radius)
}

fn mm(p: IntPoint<i32>) -> (f64, f64) {
    (f64::from(p.x) / SCALE, f64::from(p.y) / SCALE)
}

#[allow(clippy::cast_possible_truncation, reason = "a point on the ring grid")]
fn unmm(x: f64, y: f64) -> IntPoint<i32> {
    IntPoint::new((x * SCALE).round() as i32, (y * SCALE).round() as i32)
}

/// The ring rotated to start at its painted seam, or `None` when nothing painted touches it (the
/// caller then uses the seam setting alone).
pub(crate) fn painted(
    c: &[IntPoint<i32>],
    faces: &[SeamFace],
    z: f64,
    mode: SeamPosition,
    cursor: Point,
    key: u64,
    radius: f64,
) -> Option<Vec<IntPoint<i32>>> {
    if faces.is_empty() || c.len() < 3 {
        return None;
    }
    let classify = |x: f64, y: f64| {
        if near([x, y, z], faces, false, radius) {
            Kind::Blocked
        } else if near([x, y, z], faces, true, radius) {
            Kind::Enforced
        } else {
            Kind::Neutral
        }
    };
    let n = c.len();
    let mut ring: Vec<IntPoint<i32>> = Vec::with_capacity(n);
    let mut kinds: Vec<Kind> = Vec::with_capacity(n);
    // Turns are read on the original vertices only; the extra points count as straight.
    let mut turns: Vec<f64> = Vec::with_capacity(n);
    for i in 0..n {
        let (a, b) = (*c.get(i)?, *c.get((i + 1) % n)?);
        let (ax, ay) = mm(a);
        let (bx, by) = mm(b);
        ring.push(a);
        kinds.push(classify(ax, ay));
        turns.push(crate::paths::turn_at(c, i).unwrap_or(0.0));
        let len = (bx - ax).m_hypot(by - ay);
        if len > OVERSAMPLE_MM && near([ax, ay, z], faces, true, len) {
            let mut step = OVERSAMPLE_MM;
            while step < len {
                let (x, y) = (ax + (bx - ax) * step / len, ay + (by - ay) * step / len);
                ring.push(unmm(x, y));
                kinds.push(classify(x, y));
                turns.push(0.0);
                step += OVERSAMPLE_MM;
            }
        }
    }
    if kinds.iter().all(|k| *k == Kind::Neutral) {
        return None;
    }
    let m = ring.len();
    let enforced = kinds.contains(&Kind::Enforced);
    let aligned = matches!(mode, SeamPosition::Aligned | SeamPosition::AlignedBack);
    let center = if enforced && aligned {
        central_enforced(&kinds, &turns)
    } else {
        None
    };
    let at = center.or_else(|| {
        let want = if enforced { Kind::Enforced } else { Kind::Neutral };
        let allowed: Vec<bool> = kinds
            .iter()
            .map(|k| if enforced { *k == want } else { *k != Kind::Blocked })
            .collect();
        let any = allowed.iter().any(|a| *a);
        crate::paths::seam_index(&ring, mode, cursor, key, any.then_some(allowed.as_slice()))
    })?;
    Some((0..m).filter_map(|i| ring.get((at + i) % m).copied()).collect())
}

/// The middle of the longest enforced stretch, or its sharpest-turn middle when it has sharp
/// corners. `None` when the whole ring is enforced.
fn central_enforced(kinds: &[Kind], turns: &[f64]) -> Option<usize> {
    let m = kinds.len();
    let is = |i: usize| kinds.get(i % m).copied() == Some(Kind::Enforced);
    // A stretch starts at an enforced point that follows a non-enforced one.
    let start = (0..m).find(|i| !is(*i))?;
    let mut best: Vec<usize> = Vec::new();
    let mut run: Vec<usize> = Vec::new();
    for k in 1..=m {
        let i = (start + k) % m;
        if is(i) {
            run.push(i);
        } else {
            if run.len() > best.len() {
                best = std::mem::take(&mut run);
            }
            run.clear();
        }
    }
    let sharp: Vec<usize> = best
        .iter()
        .copied()
        .filter(|i| turns.get(*i).is_some_and(|t| t.abs() > SHARP_TURN))
        .collect();
    if sharp.is_empty() {
        best.get(best.len() / 2).copied()
    } else {
        sharp.get(sharp.len() / 2).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance_to_a_triangle_covers_face_edge_and_corner() {
        let t = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [0.0, 10.0, 0.0]];
        assert!((dist2_to_triangle([2.0, 2.0, 3.0], &t) - 9.0).abs() < 1e-9);
        assert!((dist2_to_triangle([5.0, 5.0, 0.0], &t)).abs() < 1e-9);
        assert!((dist2_to_triangle([-3.0, -4.0, 0.0], &t) - 25.0).abs() < 1e-9);
        assert!((dist2_to_triangle([12.0, -1.0, 0.0], &t) - 5.0).abs() < 1e-9);
    }
}
