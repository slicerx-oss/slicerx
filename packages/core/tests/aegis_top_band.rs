// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! aegis walls with one wall on top surfaces, on a sloped side: the top surface band widens smoothly with the step
//! and starts later on more walls.
//!
//! The part is a 30 mm square box 2 mm tall under a ten-layer frustum whose sides step in by `r` mm a 0.2 mm layer,
//! on the stock P1S request (fixtures/surface-walls/p1s-x-mark.json) with aegis walls, smart layer off. The figures
//! are filament (mm) per feature, summed over the nine sloped layers z 2.2 to 3.8.
//!
//! - On 2 walls the band starts at a step of 0.745 mm and keeps widening up to 1.4 mm. Before, the one-wall run took
//!   over at 1.08 mm whatever the wall count, and the band came out about 0.9 mm narrower than at 1.07 (top surface
//!   57.9 against 84.9, the second wall pushed in under the layer above).
//! - The step where the band starts grows with the wall count, as each wall takes the infill area in by its spacing:
//!   none at 1.1 mm and a band at 1.2 mm on 3 walls, none up to 1.4 mm on 4. The band on 3 walls is at least as wide
//!   as on 2.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::disallowed_methods,
    reason = "a G-code reader for the test: positions and lengths in mm"
)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

const REQUEST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/surface-walls/p1s-x-mark.json"
);

/// The sloped layers, thousandths of a millimeter.
const SLOPED: [i64; 9] = [2200, 2400, 2600, 2800, 3000, 3200, 3400, 3600, 3800];

/// The tapered part around the origin: a 30 mm square box to z 2, then a frustum to z 4 whose sides step in by `r`
/// mm per 0.2 mm, as ASCII STL.
fn taper(r: f64) -> Vec<u8> {
    let (b, t) = (15.0, 15.0 - 10.0 * r);
    let square = |h: f64, z: f64| [(-h, -h, z), (h, -h, z), (h, h, z), (-h, h, z)];
    let (b0, b2, t4) = (square(b, 0.0), square(b, 2.0), square(t, 4.0));
    let mut out = String::from("solid taper\n");
    let mut facet = |a: (f64, f64, f64), p: (f64, f64, f64), q: (f64, f64, f64)| {
        let _ = writeln!(out, "facet normal 0 0 0\n outer loop");
        for v in [a, p, q] {
            let _ = writeln!(out, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(out, " endloop\nendfacet");
    };
    let mut quad = |a, p, q, d| {
        facet(a, p, q);
        facet(a, q, d);
    };
    quad(b0[0], b0[3], b0[2], b0[1]);
    for i in 0..4 {
        let j = (i + 1) % 4;
        quad(b0[i], b0[j], b2[j], b2[i]);
        quad(b2[i], b2[j], t4[j], t4[i]);
    }
    quad(t4[0], t4[1], t4[2], t4[3]);
    out.push_str("endsolid taper\n");
    out.into_bytes()
}

/// The G-code of the taper with step `r` on `walls` aegis walls.
fn slice(r: f64, walls: u32) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!("aegis");
    req["config"]["wall_loops"] = json!(walls);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let mesh = Arc::new(Mesh::load(&taper(r), "taper.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// A number after `key` in a G-code move.
fn word(code: &str, key: char) -> Option<f64> {
    code.split_whitespace()
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse::<f64>().ok()))
}

/// A feature or layer comment's value: `; FEATURE: x` or `;TYPE:x`, and so on.
fn comment<'a>(s: &'a str, keys: &[&str]) -> Option<&'a str> {
    let body = s.strip_prefix(';')?.trim_start();
    keys.iter()
        .find_map(|k| body.strip_prefix(k).and_then(|r| r.strip_prefix(':')))
        .map(str::trim)
}

/// One extruding move: its layer z in thousandths of a millimeter, start and end (mm) and filament.
struct Move {
    layer: i64,
    from: (f64, f64),
    to: (f64, f64),
    filament: f64,
}

/// Each extruding move of `feature`.
fn moves(gcode: &str, feature: &str) -> Vec<Move> {
    let (mut current, mut layer) = (String::new(), 0);
    let mut at = (0.0, 0.0);
    let mut out = Vec::new();
    for line in gcode.lines() {
        let text = line.trim();
        if let Some(f) = comment(text, &["TYPE", "FEATURE"]) {
            f.clone_into(&mut current);
            continue;
        }
        if let Some(h) = comment(text, &["Z_HEIGHT", "Z"]).and_then(|v| v.parse::<f64>().ok()) {
            layer = (h * 1000.0).round() as i64;
            continue;
        }
        let code = text.split(';').next().unwrap_or("").trim();
        if !(code.starts_with("G0 ") || code.starts_with("G1 ")) {
            continue;
        }
        let to = (word(code, 'X').unwrap_or(at.0), word(code, 'Y').unwrap_or(at.1));
        if current == feature
            && let Some(filament) = word(code, 'E').filter(|e| *e > 0.0)
            && to != at
        {
            out.push(Move {
                layer,
                from: at,
                to,
                filament,
            });
        }
        at = to;
    }
    out
}

/// Filament of `feature` per layer.
fn per_layer(gcode: &str, feature: &str) -> BTreeMap<i64, f64> {
    let mut out = BTreeMap::new();
    for m in moves(gcode, feature) {
        *out.entry(m.layer).or_default() += m.filament;
    }
    out
}

/// Filament of `feature` over the sloped layers.
fn sloped(gcode: &str, feature: &str) -> f64 {
    let layers = per_layer(gcode, feature);
    SLOPED.iter().map(|z| layers.get(z).copied().unwrap_or(0.0)).sum()
}

/// Top surface on `layer` per side of the part (left, right, bottom, top), by where each move's middle lies from
/// the part's center, the middle of the outer wall's extent on that layer.
fn sides(gcode: &str, layer: i64) -> [f64; 4] {
    let outer: Vec<(f64, f64)> = moves(gcode, "Outer wall")
        .into_iter()
        .filter(|m| m.layer == layer)
        .flat_map(|m| [m.from, m.to])
        .collect();
    let span = |f: fn(&(f64, f64)) -> f64| {
        let lo = outer.iter().map(f).fold(f64::INFINITY, f64::min);
        let hi = outer.iter().map(f).fold(f64::NEG_INFINITY, f64::max);
        f64::midpoint(lo, hi)
    };
    let center = (span(|p| p.0), span(|p| p.1));
    let mut out = [0.0; 4];
    for m in moves(gcode, "Top surface")
        .into_iter()
        .filter(|m| m.layer == layer)
    {
        let dx = f64::midpoint(m.from.0, m.to.0) - center.0;
        let dy = f64::midpoint(m.from.1, m.to.1) - center.1;
        let side = if dx.abs() >= dy.abs() {
            usize::from(dx > 0.0)
        } else {
            2 + usize::from(dy > 0.0)
        };
        out[side] += m.filament;
    }
    out
}

/// The top surface and inner wall over the sloped layers, on 2 walls, are within 6 and 8 percent of the targets
/// at every step from 1.08 to 1.4 mm. Before the fix the top surface was 57.9 to 62.1 and the inner wall 14 to 20
/// percent low.
#[test]
fn the_aegis_top_band_keeps_its_width_past_a_step_of_1_08_mm() {
    let targets = [
        (1.08, 81.72, 22.76),
        (1.09, 81.76, 22.65),
        (1.10, 81.78, 22.55),
        (1.15, 81.72, 22.01),
        (1.20, 81.54, 21.47),
        (1.30, 80.71, 20.40),
        (1.40, 79.30, 19.32),
    ];
    let mut misses = Vec::new();
    for (r, top, inner) in targets {
        let g = slice(r, 2);
        let (t, i) = (sloped(&g, "Top surface"), sloped(&g, "Inner wall"));
        if (t - top).abs() > 0.06 * top || (i - inner).abs() > 0.08 * inner {
            misses.push(format!(
                "step {r}: top surface {t:.2} (target {top}), inner wall {i:.2} (target {inner})"
            ));
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}

/// The top surface at a step of 1.08 mm is within 3 percent of the one at 1.07 (before, 31 percent less).
#[test]
fn the_aegis_top_band_has_no_step_between_1_07_and_1_08_mm() {
    let a = sloped(&slice(1.07, 2), "Top surface");
    let b = sloped(&slice(1.08, 2), "Top surface");
    assert!(a > 50.0, "top surface at 1.07: {a:.2}");
    assert!(
        (a - b).abs() < 0.03 * a,
        "top surface: {a:.2} at 1.07, {b:.2} at 1.08"
    );
}

/// At a step of 1.2 mm, on z 3.0, no side's top surface is more than 20 percent short of the target, and the four
/// together are within 6 percent (before, 1.65 to 1.75 a side against 1.99 to 2.54). Which side a corner's lines
/// count for follows the surface's line direction, which puts more on the left and right here and more on the right
/// and top in the targets, as at a step of 1.07 mm, so a side may come out more than 20 percent over.
#[test]
fn the_aegis_top_band_is_full_width_on_every_side() {
    let got = sides(&slice(1.2, 2), 3000);
    let want = [2.07, 2.54, 1.99, 2.46];
    let (sum, target): (f64, f64) = (got.iter().sum(), want.iter().sum());
    assert!(
        got.iter().zip(want).all(|(g, w)| *g >= 0.8 * w) && (sum - target).abs() <= 0.06 * target,
        "per side (left, right, bottom, top): {got:.2?}, targets {want:?}"
    );
}

/// The step where a band starts grows with the wall count: on 3 walls none at 1.1 mm and one at 1.2 mm, at least
/// as wide as on 2 walls; on 4 walls none up to 1.4 mm. Before, 3 and 4 walls printed the narrow band from 1.08 mm.
#[test]
fn the_aegis_top_band_starts_later_on_more_walls() {
    let top = |r: f64, walls: u32| sloped(&slice(r, walls), "Top surface");
    let early = top(1.1, 3);
    assert!(early < 0.05, "3 walls at 1.1: top surface {early:.2}");
    let (two, three) = (top(1.2, 2), top(1.2, 3));
    assert!(
        three >= two,
        "at 1.2: top surface {three:.2} on 3 walls, {two:.2} on 2"
    );
    for r in [1.2, 1.3, 1.4] {
        let t = top(r, 4);
        assert!(t < 0.05, "4 walls at {r}: top surface {t:.2}");
    }
}
