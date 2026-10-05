// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Counterbore hole bridging (`counterbore_hole_bridging`): where a hole narrows above a wider one, the
//! floor of the counterbore hangs in the air. Walls printed around the narrow hole would hang too, so the
//! part of that floor a bridge can span is taken out of the walled region and printed as bridge infill
//! anchored on the part below. Our own implementation of the method of Orca's
//! `PerimeterGenerator::process_no_bridge` (ported there from `SuperSlicer`) in its partially bridged mode:
//! the unsupported area opened by a wall spacing, the coverage of bridges across it that rest on the layer
//! below at both ends (`BridgeDetector::coverage`), cleaned against the supported area, plus an anchor band.
//!
//! The sacrificial layer mode (a full layer over the narrow hole, drilled out after printing) is read as
//! the partially bridged one for now.

use crate::fm::Fm as _;
use crate::geom::mm;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

/// Whether the profile asks for counterbore bridging.
pub(crate) fn wanted(cfg: &crate::config::PrintConfig) -> bool {
    matches!(
        cfg.raw.get("counterbore_hole_bridging"),
        Some(serde_json::Value::String(s)) if s == "partiallybridge" || s == "sacrificiallayer"
    )
}

/// Orca's `SCALED_EPSILON` safety offset, in units (0.01 mm).
const SAFETY: i32 = 100;

fn grow(s: &Shapes, d: i32) -> Shapes {
    if s.is_empty() || d == 0 {
        s.clone()
    } else {
        perimeters::offset(s, d)
    }
}

fn opening(s: &Shapes, d: i32) -> Shapes {
    grow(&grow(s, -d), d)
}

fn sub(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() || b.is_empty() {
        a.clone()
    } else {
        perimeters::difference(a, b)
    }
}

fn meet(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() || b.is_empty() {
        Vec::new()
    } else {
        perimeters::intersection(a, b)
    }
}

fn rotate(s: &Shapes, a: f64) -> Shapes {
    let (sin, cos) = a.m_sin_cos();
    s.iter()
        .map(|sh| {
            sh.iter()
                .map(|ring| {
                    ring.iter()
                        .map(|p| {
                            let (x, y) = (f64::from(p.x), f64::from(p.y));
                            #[allow(clippy::cast_possible_truncation, reason = "a rotated plate coordinate")]
                            IntPoint::new(
                                (cos * x - sin * y).round() as i32,
                                (sin * x + cos * y).round() as i32,
                            )
                        })
                        .collect()
                })
                .collect()
        })
        .collect()
}

/// Even-odd point test over every ring of `s`.
fn inside(s: &Shapes, x: f64, y: f64) -> bool {
    let mut odd = false;
    for ring in s.iter().flat_map(|sh| sh.iter()) {
        let n = ring.len();
        for i in 0..n {
            let (Some(a), Some(b)) = (ring.get(i), ring.get((i + 1) % n)) else {
                continue;
            };
            let (ax, ay, bx, by) = (f64::from(a.x), f64::from(a.y), f64::from(b.x), f64::from(b.y));
            if (ay > y) != (by > y) && x < ax + (y - ay) / (by - ay) * (bx - ax) {
                odd = !odd;
            }
        }
    }
    odd
}

/// The part of `area` that bridges at `angle` (radians) cover with both ends on `anchors`: strands
/// `step` apart across `area` grown by half a step, kept where both their ends lie in `anchors`.
fn coverage(area: &Shapes, anchors: &Shapes, angle: f64, step: i32) -> Shapes {
    let (a, anch) = (rotate(&grow(area, step / 2), -angle), rotate(anchors, -angle));
    let Some(b) = perimeters::bounds(&a) else {
        return Vec::new();
    };
    let mut strips: Shapes = Vec::new();
    let mut y = b[1] + step / 2;
    while y < b[3] {
        // The crossings of the row with the area's outline, in x order, pair up into spans.
        let yf = f64::from(y);
        let mut xs: Vec<f64> = Vec::new();
        for ring in a.iter().flat_map(|sh| sh.iter()) {
            let n = ring.len();
            for i in 0..n {
                let (Some(p), Some(q)) = (ring.get(i), ring.get((i + 1) % n)) else {
                    continue;
                };
                let (py, qy) = (f64::from(p.y), f64::from(q.y));
                if (py > yf) != (qy > yf) {
                    xs.push(f64::from(p.x) + (yf - py) / (qy - py) * f64::from(q.x - p.x));
                }
            }
        }
        xs.sort_by(f64::total_cmp);
        for pair in xs.chunks(2) {
            let (Some(&x0), Some(&x1)) = (pair.first(), pair.get(1)) else {
                continue;
            };
            if inside(&anch, x0, yf) && inside(&anch, x1, yf) {
                #[allow(clippy::cast_possible_truncation, reason = "plate coordinates")]
                let (l, r) = (x0.round() as i32, x1.round() as i32);
                // Neighboring rows overlap a little so their strips merge.
                let (lo, hi) = (y - step / 2 - 2, y - step / 2 + step + 2);
                strips.push(vec![vec![
                    IntPoint::new(l, lo),
                    IntPoint::new(r, lo),
                    IntPoint::new(r, hi),
                    IntPoint::new(l, hi),
                ]]);
            }
        }
        y += step;
    }
    if strips.is_empty() {
        return Vec::new();
    }
    meet(
        &rotate(&perimeters::union_all(&[&strips]), angle),
        &grow(area, step / 2),
    )
}

/// The counterbore floors of `region` over `lower` (the layer below): what is taken out of the walled
/// region, and the bridged part of it, printed as bridging infill. `spacing` is the wall spacing and
/// `ext` the outer wall width, in units. Both empty when nothing qualifies.
pub(crate) fn mask(region: &Shapes, lower: &Shapes, spacing: i32, ext: i32) -> (Shapes, Shapes) {
    let anchor = mm(crate::bridging::BRIDGE_INFILL_MARGIN_MM).min(spacing).min(ext);
    let (mut cut, mut fill): (Shapes, Shapes) = (Vec::new(), Vec::new());
    for shape in region {
        // Only surfaces with holes have counterbores to bridge.
        if shape.len() < 2 {
            continue;
        }
        let last: Shapes = vec![shape.clone()];
        // As Orca's safety offset: a hair of the layer below's outline does not count as unsupported.
        let unsupported = sub(&last, &grow(lower, SAFETY));
        if unsupported.is_empty() {
            continue;
        }
        let filtered = opening(&unsupported, spacing);
        if filtered.is_empty() {
            continue;
        }
        let support = meet(&last, lower);
        if support.is_empty() {
            continue;
        }
        let mut bridgeable: Shapes = Vec::new();
        for piece in &filtered {
            let one: Shapes = vec![piece.clone()];
            let angle = crate::bridging::direction(&one, &support);
            bridgeable.extend(coverage(&one, &support, angle, (spacing / 4).max(1)));
        }
        if bridgeable.is_empty() {
            continue;
        }
        // Orca's mask: the bridgeable span grown from the supported remainder and shrunk back, stripped
        // from the remainder and cleaned, kept within the anchor overlap, plus the anchor band.
        let rest = sub(&last, &filtered);
        let mut b = opening(&perimeters::union_all(&[&bridgeable]), ext);
        b = grow(&perimeters::union_all(&[&grow(&rest, spacing), &b]), -spacing);
        b = sub(&b, &rest);
        b = grow(&opening(&b, spacing), spacing);
        b = sub(&b, &grow(&rest, -anchor));
        let anchors = meet(&rest, &grow(&filtered, anchor));
        let m = meet(&opening(&perimeters::union_all(&[&b, &anchors]), anchor), &last);
        // The unbridged rest of the floor is neither walled nor filled on this layer (Orca drops it from
        // the walled surface): the layer above closes over it.
        cut.extend(perimeters::union_all(&[&filtered, &m]));
        fill.extend(m);
    }
    (cut, fill)
}
