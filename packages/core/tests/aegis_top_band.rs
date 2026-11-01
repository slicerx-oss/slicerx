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
//! - Past a step of 1.4 mm, on a 50 mm box, the band keeps widening on 2, 3 and 4 walls. The one-wall run takes over a
//!   layer at a time, from the smallest island at the top, once a layer's ledge is a large enough part of it. Before,
//!   it took over on every sloped layer at once, at 1.53 mm on 2 walls and 1.94 on 3, and the top surface lost about a
//!   quarter; on 4 walls it never did, and the top surface ran up to 6 percent over the target at 2.2 mm.
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
    taper_of(15.0, r)
}

/// [`taper`] on a square box `half` mm from its center to each side.
fn taper_of(half: f64, r: f64) -> Vec<u8> {
    let (b, t) = (half, half - 10.0 * r);
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
    slice_mesh(&taper(r), walls)
}

/// The G-code of the taper on a 50 mm box with step `r` on `walls` aegis walls.
fn slice_wide(r: f64, walls: u32) -> String {
    slice_mesh(&taper_of(25.0, r), walls)
}

/// The G-code of the ASCII STL `stl` on `walls` aegis walls.
fn slice_mesh(stl: &[u8], walls: u32) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!("aegis");
    req["config"]["wall_loops"] = json!(walls);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let mesh = Arc::new(Mesh::load(stl, "taper.stl").unwrap());
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

/// On a 50 mm box the top surface over the sloped layers has no drop where the usual walls start to leave a top surface
/// of their own: within 3 percent between steps of 1.52 and 1.53 mm on 2 walls and between 1.93 and 1.94 on 3. Before,
/// it fell by 26 and 22 percent there, to the narrow band of the one-wall run on every sloped layer.
#[test]
fn the_aegis_top_band_has_no_drop_past_a_step_of_1_5_mm() {
    let mut misses = Vec::new();
    for (walls, a, b) in [(2, 1.52, 1.53), (3, 1.93, 1.94)] {
        let (x, y) = (
            sloped(&slice_wide(a, walls), "Top surface"),
            sloped(&slice_wide(b, walls), "Top surface"),
        );
        if x < 150.0 || (x - y).abs() > 0.03 * x {
            misses.push(format!("{walls} walls: top surface {x:.2} at {a}, {y:.2} at {b}"));
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}

/// On a 50 mm box the top surface over the sloped layers is within 3 percent of the target from a step of 1.6 to
/// 2.2 mm. Before, it was 15 to 21 percent short on 2 walls from 1.8 mm and on 3 walls from 2.0 mm, and on 4 walls
/// 3.9 and 6.0 percent over at 2.0 and 2.2 mm, as no layer took the one-wall run.
#[test]
fn the_aegis_top_band_follows_the_targets_past_a_step_of_1_4_mm() {
    let targets = [
        (2, 1.8, 206.38),
        (2, 2.0, 203.02),
        (2, 2.2, 198.61),
        (3, 1.6, 210.70),
        (3, 2.0, 208.92),
        (3, 2.2, 202.94),
        (4, 1.8, 220.29),
        (4, 2.0, 214.18),
        (4, 2.2, 206.85),
    ];
    let mut misses = Vec::new();
    for (walls, r, target) in targets {
        let t = sloped(&slice_wide(r, walls), "Top surface");
        if (t - target).abs() > 0.03 * target {
            misses.push(format!(
                "{walls} walls at {r}: top surface {t:.2} (target {target})"
            ));
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}

/// On 3 walls the one-wall run takes over a layer at a time from the top: each sloped layer's top surface is within
/// 0.55 of the target at steps of 1.93 mm (the two layers under the flat top have it) and 2.2 mm (the five under it
/// have it). Before, at 1.93 every layer kept its walls, 2.4 over on z 3.6, and at 2.2 every layer had the one-wall
/// run, up to 8.5 short on z 2.2.
#[test]
fn the_aegis_top_band_takes_one_wall_a_layer_at_a_time() {
    let targets = [
        (
            1.93,
            [37.25, 33.90, 30.53, 27.19, 23.86, 20.51, 17.14, 11.56, 9.12],
        ),
        (
            2.2,
            [40.49, 36.30, 32.11, 27.90, 19.57, 16.41, 13.24, 10.07, 6.87],
        ),
    ];
    let mut misses = Vec::new();
    for (r, want) in targets {
        let layers = per_layer(&slice_wide(r, 3), "Top surface");
        for (z, w) in SLOPED.iter().zip(want) {
            let got = layers.get(z).copied().unwrap_or(0.0);
            if (got - w).abs() > 0.55 {
                misses.push(format!("step {r}, z {z}: top surface {got:.2} (target {w})"));
            }
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}

/// On a 50 mm box the band starts between steps of 1.13 and 1.14 mm on 3 walls and between 1.54 and 1.55 on 4. These
/// moved from 1.16 to 1.18 and 1.58 to 1.59 when the stock P1S request took precise outer wall off: the inner walls sit
/// 0.043 mm nearer the outer wall, so the infill area under the ledge is that much wider.
#[test]
fn the_aegis_top_band_starts_on_the_wide_box_where_it_did() {
    let top = |r: f64, walls: u32| sloped(&slice_wide(r, walls), "Top surface");
    for (walls, none, band) in [(3, 1.13, 1.14), (4, 1.54, 1.55)] {
        let (a, b) = (top(none, walls), top(band, walls));
        assert!(
            a < 0.05 && b > 150.0,
            "{walls} walls: top surface {a:.2} at {none}, {b:.2} at {band}"
        );
    }
}

/// The G-code of the taper on a box `half` mm from its center to each side with step `r`, on `walls` aegis walls and
/// an infill wall overlap of `overlap` percent.
fn slice_overlap(half: f64, r: f64, walls: u32, overlap: f64) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!("aegis");
    req["config"]["wall_loops"] = json!(walls);
    req["config"]["infill_wall_overlap"] = json!(overlap);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let mesh = Arc::new(Mesh::load(&taper_of(half, r), "taper.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// The top surface band on `layer` on each side of the part (left, right, bottom, top), on the 12 mm straight stretch
/// about the middle of the side: its near edge (the line ends nearest the outer wall) and its far edge, mm in from
/// the side's outer wall centerline.
fn band_edges(gcode: &str, layer: i64) -> [(f64, f64); 4] {
    let outer: Vec<(f64, f64)> = moves(gcode, "Outer wall")
        .into_iter()
        .filter(|m| m.layer == layer)
        .flat_map(|m| [m.from, m.to])
        .collect();
    let lo = |f: fn(&(f64, f64)) -> f64| outer.iter().map(f).fold(f64::INFINITY, f64::min);
    let hi = |f: fn(&(f64, f64)) -> f64| outer.iter().map(f).fold(f64::NEG_INFINITY, f64::max);
    let (x0, x1, y0, y1) = (lo(|p| p.0), hi(|p| p.0), lo(|p| p.1), hi(|p| p.1));
    let (cx, cy) = (f64::midpoint(x0, x1), f64::midpoint(y0, y1));
    // Per side (left, right, bottom, top): how far in from the outer wall a point is, and how far along the side from
    // its middle.
    let place = |side: usize, p: (f64, f64)| match side {
        0 => (p.0 - x0, p.1 - cy),
        1 => (x1 - p.0, p.1 - cy),
        2 => (p.1 - y0, p.0 - cx),
        _ => (y1 - p.1, p.0 - cx),
    };
    let top: Vec<Move> = moves(gcode, "Top surface")
        .into_iter()
        .filter(|m| m.layer == layer)
        .collect();
    [0, 1, 2, 3].map(|side| {
        let depth = |p| place(side, p).0;
        let ends: Vec<f64> = top
            .iter()
            .filter(|m| {
                let mid = (f64::midpoint(m.from.0, m.to.0), f64::midpoint(m.from.1, m.to.1));
                place(side, mid).1.abs() <= 6.0 && depth(m.from).min(depth(m.to)) < 6.0
            })
            .flat_map(|m| [depth(m.from), depth(m.to)])
            .collect();
        (
            ends.iter().copied().fold(f64::INFINITY, f64::min),
            ends.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        )
    })
}

/// The top surface band's lines start at the innermost wall's spacing edge, without the infill wall overlap, and end
/// where they did: on z 3.0, at 15 percent overlap, the near edge on every side is within 0.005 mm of the target on
/// a 50 mm box at a step of 1.52 mm on 2 and 3 walls and on a 30 mm box at 1.0 mm on 2 walls, and the far edge too.
/// Before, the near edge was 0.063 mm (the overlap, 15 percent of the 0.42 mm line) nearer the outer wall: 0.552,
/// 0.987 and 0.552. The 3-wall target moved from 1.050 to 1.007 when the stock P1S request took precise outer wall
/// off: its second inner wall sits 0.043 mm nearer the outer wall.
#[test]
fn the_aegis_top_band_starts_at_the_innermost_walls_edge() {
    let cases = [
        (25.0, 1.52, 2, 0.615, 2.697),
        (25.0, 1.52, 3, 1.007, 3.273),
        (15.0, 1.0, 2, 0.615, 2.177),
    ];
    let mut misses = Vec::new();
    for (half, r, walls, near, far) in cases {
        let got = band_edges(&slice_overlap(half, r, walls, 15.0), 3000);
        if got
            .iter()
            .any(|(n, f)| (n - near).abs() > 0.005 || (f - far).abs() > 0.005)
        {
            misses.push(format!(
                "{} mm box, step {r}, {walls} walls: (near, far) per side {got:.3?}, targets {near} and {far}",
                2.0 * half
            ));
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}

/// The near edge does not move with the overlap: on the 50 mm box at a step of 1.52 mm on 2 walls, z 3.0, it is
/// within 0.005 mm of the target at 0, 10, 15 and 30 percent. Before, it moved 0.0042 mm nearer the outer wall per
/// percent: 0.615, 0.573, 0.552 and 0.489.
#[test]
fn the_aegis_top_band_near_edge_ignores_the_overlap() {
    let mut misses = Vec::new();
    for overlap in [0.0, 10.0, 15.0, 30.0] {
        let got = band_edges(&slice_overlap(25.0, 1.52, 2, overlap), 3000);
        if got.iter().any(|(n, _)| (n - 0.615).abs() > 0.005) {
            misses.push(format!(
                "{overlap} percent: (near, far) per side {got:.3?}, target near 0.615"
            ));
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}

/// A ledge whose only uncovered part inside the walls is their overlap still gets its top surface band: on the 50 mm
/// box at a step of 1.52 mm on 2 walls the layer above leaves z 2.0 uncovered out to 0.55 mm from the outer wall's
/// centerline, short of the innermost wall's spacing edge, and the top surface there is within 7 percent of the
/// target (the band now starts 0.063 mm farther from the wall), with no internal solid infill in its place. Taking the
/// overlap out of the infill area itself would print that band as internal solid infill instead.
#[test]
fn the_aegis_top_band_forms_where_only_the_overlap_is_uncovered() {
    let g = slice_overlap(25.0, 1.52, 2, 15.0);
    let top = per_layer(&g, "Top surface").get(&2000).copied().unwrap_or(0.0);
    let solid = per_layer(&g, "Internal solid infill")
        .get(&2000)
        .copied()
        .unwrap_or(0.0);
    assert!(
        (top - 21.24).abs() <= 0.07 * 21.24 && solid < 0.05,
        "z 2.0: top surface {top:.2} (target 21.24), internal solid infill {solid:.2}"
    );
}

/// A square box `half` mm from its center to each side and `height` mm tall, as ASCII STL.
fn box_of(half: f64, height: f64) -> Vec<u8> {
    let square = |h: f64, z: f64| [(-h, -h, z), (h, -h, z), (h, h, z), (-h, h, z)];
    let (b0, t) = (square(half, 0.0), square(half, height));
    let mut out = String::from("solid box\n");
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
        quad(b0[i], b0[j], t[j], t[i]);
    }
    quad(t[0], t[1], t[2], t[3]);
    out.push_str("endsolid box\n");
    out.into_bytes()
}

/// The G-code of the ASCII STL `stl` on 2 aegis walls without one wall on top, at an infill wall overlap of
/// `overlap` percent.
fn slice_ordinary(stl: &[u8], overlap: f64) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!("aegis");
    req["config"]["wall_loops"] = json!(2);
    req["config"]["only_one_wall_top"] = json!(false);
    req["config"]["infill_wall_overlap"] = json!(overlap);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let mesh = Arc::new(Mesh::load(stl, "part.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// Without one wall on top the top surface starts at the inner wall's spacing edge too, whatever the overlap: on 2
/// walls, at 0, 15 and 30 percent, the near edge on every side is within 0.005 mm of the target on the flat top of a
/// 20 mm box 4 mm tall (z 4.0) and on the 50 mm taper at a step of 1.52 mm, sloped (z 3.0) and flat (z 4.0). The inner
/// wall sits 0.392 mm from the outer wall's centerline here. Before, with precise outer wall on and the inner wall at
/// 0.435, the near edge was 0.657, 0.594 and 0.531. The target moved from 0.657 to 0.614 when the stock P1S request took
/// precise outer wall off.
#[test]
fn ordinary_aegis_tops_start_at_the_inner_walls_edge() {
    let parts = [
        ("20 mm box", box_of(10.0, 4.0), vec![4000]),
        ("50 mm taper", taper_of(25.0, 1.52), vec![3000, 4000]),
    ];
    let mut misses = Vec::new();
    for (name, stl, layers) in &parts {
        for overlap in [0.0, 15.0, 30.0] {
            let g = slice_ordinary(stl, overlap);
            for &layer in layers {
                let got = band_edges(&g, layer);
                if got.iter().any(|(n, _)| (n - 0.614).abs() > 0.005) {
                    misses.push(format!(
                        "{name}, z {layer}, {overlap} percent: (near, far) per side {got:.3?}, target near 0.614"
                    ));
                }
            }
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}

/// The stock Prusa MK4 request (0.4 mm nozzle; outer wall 100, inner wall 110 and top surface 93.75 percent of it).
const MK4: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/precise-wall-surface/requests/prusa-mk4--n4-ar-p1-L3.json"
);

/// The G-code of the ASCII STL `stl` from `request` on 2 aegis walls without one wall on top, with `pattern` on top
/// and both wall overlaps (`infill_wall_overlap` and `top_bottom_infill_wall_overlap`) at `overlap` percent.
fn slice_pattern(request: &str, stl: &[u8], pattern: &str, overlap: f64) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(request).unwrap()).unwrap();
    let cfg = &mut req["config"];
    cfg["wall_generator"] = json!("aegis");
    cfg["wall_loops"] = json!(2);
    cfg["only_one_wall_top"] = json!(false);
    cfg["top_surface_pattern"] = json!(pattern);
    cfg["infill_wall_overlap"] = json!(overlap);
    cfg["top_bottom_infill_wall_overlap"] = json!(overlap);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let mesh = Arc::new(Mesh::load(stl, "part.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// The near edge on every side of `layer` within 0.005 mm of `target`, or what it was.
fn near_misses(what: &str, gcode: &str, layer: i64, target: f64) -> Option<String> {
    let got = band_edges(gcode, layer);
    got.iter()
        .any(|(n, _)| (n - target).abs() > 0.005)
        .then(|| format!("{what}, z {layer}: (near, far) per side {got:.3?}, target near {target}"))
}

/// A monotonic line top surface starts at the inner wall's spacing edge at any overlap on printers of every kind: on
/// the MK4 the near edge is within 0.005 mm of the target at 0 and 30 percent, on the flat top of the 20 mm box (z 4.0)
/// and on the 50 mm taper at a step of 1.52 mm (z 3.0). Before, it was 0.516 at 30 percent: the stretched surface's
/// edge took `top_bottom_infill_wall_overlap` into the wall.
#[test]
fn monotonic_line_aegis_tops_ignore_the_overlap_on_the_mk4() {
    let parts = [
        ("20 mm box", box_of(10.0, 4.0), 4000),
        ("50 mm taper", taper_of(25.0, 1.52), 3000),
    ];
    let mut misses = Vec::new();
    for (name, stl, layer) in &parts {
        for overlap in [0.0, 30.0] {
            let g = slice_pattern(MK4, stl, "monotonicline", overlap);
            misses.extend(near_misses(
                &format!("MK4 {name}, {overlap} percent"),
                &g,
                *layer,
                0.635,
            ));
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}

/// Monotonic and rectilinear top surfaces keep their overlap with the walls: on the flat top of the 20 mm box (z 4.0)
/// the near edge moves toward the wall with the overlap, to within 0.005 mm of the targets at 0 and 30 percent, on the
/// P1S (monotonic and rectilinear) and the MK4 (monotonic). The P1S targets moved 0.041 to 0.043 mm nearer the outer wall (from
/// 0.824 and 0.701 monotonic, 0.827 and 0.701 rectilinear) when the stock P1S request took precise outer wall off.
#[test]
fn monotonic_aegis_tops_keep_the_overlap() {
    let cases = [
        (REQUEST, "P1S", "monotonic", 0.782, 0.660),
        (REQUEST, "P1S", "rectilinear", 0.784, 0.658),
        (MK4, "MK4", "monotonic", 0.780, 0.661),
    ];
    let stl = box_of(10.0, 4.0);
    let mut misses = Vec::new();
    for (request, printer, pattern, at_0, at_30) in cases {
        for (overlap, target) in [(0.0, at_0), (30.0, at_30)] {
            let g = slice_pattern(request, &stl, pattern, overlap);
            misses.extend(near_misses(
                &format!("{printer} {pattern}, {overlap} percent"),
                &g,
                4000,
                target,
            ));
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}
