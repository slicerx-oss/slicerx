// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where the internal solid infill and the rectilinear and monotonic top surfaces start beside aegis walls, as the
//! infill area overlaps the walls by `infill_wall_overlap` of the inner wall's spacing.
//!
//! The part is a 20 mm square box 4 mm tall on the stock P1S request (fixtures/surface-walls/p1s-x-mark.json) with
//! aegis walls, `only_one_wall_top` off and fixed layers of 0.20 or 0.28 mm. Both surfaces run at 45 degrees, so
//! their lines end against the walls; the edge is the median distance of those ends from the outer wall's
//! centerline, on the layer under the top (internal solid infill) and on the top (top surface).
//!
//! With s(w) = w - h (1 - pi/4), the inner wall 0.45 mm wide and the surfaces 0.42, the edge is the innermost wall's
//! centerline plus s(inner)/2 + s(surface)/2, less the overlap share of s(inner): 0.784, 0.723, 0.662 and 0.580 mm on
//! 2 walls at 0.20 mm and 0, 15, 30 and 50 percent. The overlap used to be of the 0.42 mm line width, which put the
//! edge 0.004 mm nearer the wall at 30 percent and 0.20 mm, and 0.009 mm at 0.28 mm.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::disallowed_methods,
    reason = "a G-code reader for the test: positions and lengths in mm"
)]

use serde_json::{Value, json};
use std::fmt::Write as _;
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

const REQUEST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/surface-walls/p1s-x-mark.json"
);

/// How near a measured edge must be to its target, mm.
const TOLERANCE: f64 = 0.003;

/// The overlaps tried, percent.
const OVERLAPS: [f64; 4] = [0.0, 15.0, 30.0, 50.0];

/// The 20 mm box around the origin (the request puts it on the plate's center), 4 mm tall, as ASCII STL.
fn box_stl() -> Vec<u8> {
    let (lo, hi, top) = (-10.0, 10.0, 4.0);
    let square = |z: f64| [(lo, lo, z), (hi, lo, z), (hi, hi, z), (lo, hi, z)];
    let (b, t) = (square(0.0), square(top));
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
    quad(b[0], b[3], b[2], b[1]);
    for i in 0..4 {
        let j = (i + 1) % 4;
        quad(b[i], b[j], t[j], t[i]);
    }
    quad(t[0], t[1], t[2], t[3]);
    out.push_str("endsolid box\n");
    out.into_bytes()
}

/// The G-code of the box on `walls` aegis walls, `height` mm layers, `overlap` percent and top surface `top`.
fn slice(walls: u32, height: f64, overlap: f64, top: &str) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    let c = &mut req["config"];
    c["wall_generator"] = json!("aegis");
    c["only_one_wall_top"] = json!(false);
    c["wall_loops"] = json!(walls);
    c["layer_height"] = json!(height);
    c["initial_layer_print_height"] = json!(height);
    c["infill_wall_overlap"] = json!(overlap);
    c["top_surface_pattern"] = json!(top);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let mesh = Arc::new(Mesh::load(&box_stl(), "box.stl").unwrap());
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

/// The ends of every extruding move of `feature` on the layer at `z` (thousandths of a millimeter).
fn ends(gcode: &str, feature: &str, z: i64) -> Vec<(f64, f64)> {
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
        if layer == z && current == feature && word(code, 'E').is_some_and(|e| e > 0.0) && to != at {
            out.extend([at, to]);
        }
        at = to;
    }
    out
}

/// The median distance of `feature`'s line ends on the layer at `z` from the outer wall's centerline, mm, over the
/// ends within 2 mm of it.
fn edge(gcode: &str, feature: &str, z: i64) -> f64 {
    let wall = ends(gcode, "Outer wall", z);
    assert!(!wall.is_empty(), "no outer wall at z {z}");
    let lo = |f: fn(&(f64, f64)) -> f64| wall.iter().map(f).fold(f64::INFINITY, f64::min);
    let hi = |f: fn(&(f64, f64)) -> f64| wall.iter().map(f).fold(f64::NEG_INFINITY, f64::max);
    let (x0, x1, y0, y1) = (lo(|p| p.0), hi(|p| p.0), lo(|p| p.1), hi(|p| p.1));
    let mut d: Vec<f64> = ends(gcode, feature, z)
        .iter()
        .map(|p| (p.0 - x0).min(x1 - p.0).min(p.1 - y0).min(y1 - p.1))
        .filter(|d| *d < 2.0)
        .collect();
    assert!(!d.is_empty(), "no {feature} at z {z}");
    d.sort_by(f64::total_cmp);
    d[d.len() / 2]
}

/// The top layer's and the layer under it's z, thousandths of a millimeter, for the 4 mm box at `height` mm layers.
fn layers(height: f64) -> (i64, i64) {
    let step = (height * 1000.0).round() as i64;
    let top = 4000 / step * step;
    (top, top - step)
}

/// The target edge, mm: the innermost of `walls` walls' centerline plus s(inner)/2 + s(surface)/2, less `overlap`
/// percent of s(inner).
fn target(walls: u32, height: f64, overlap: f64) -> f64 {
    let s = |w: f64| w - height * (1.0 - std::f64::consts::FRAC_PI_4);
    let innermost = f64::midpoint(s(0.42), s(0.45)) + f64::from(walls - 2) * s(0.45);
    innermost + s(0.45) / 2.0 + s(0.42) / 2.0 - overlap / 100.0 * s(0.45)
}

/// Every case of `top` at `height` mm: (walls, overlap, internal solid edge, top edge).
fn measure(height: f64, top: &str, walls: &[u32]) -> Vec<(u32, f64, f64, f64)> {
    let (top_z, under) = layers(height);
    let mut out = Vec::new();
    for &w in walls {
        for ov in OVERLAPS {
            let g = slice(w, height, ov, top);
            out.push((
                w,
                ov,
                edge(&g, "Internal solid infill", under),
                edge(&g, "Top surface", top_z),
            ));
        }
    }
    out
}

/// Checks `cases` against [`target`]: the internal solid infill within [`TOLERANCE`], the top surface within `top`
/// mm when given.
fn check(height: f64, cases: &[(u32, f64, f64, f64)], top: Option<f64>) {
    let mut report = String::new();
    let mut bad = 0;
    for &(w, ov, solid, surface) in cases {
        let t = target(w, height, ov);
        bad += usize::from((solid - t).abs() > TOLERANCE)
            + usize::from(top.is_some_and(|tol| (surface - t).abs() > tol));
        let _ = writeln!(
            report,
            "{w} walls, {ov}%: target {t:.4}, internal solid {solid:.4}, top {surface:.4}"
        );
    }
    assert_eq!(bad, 0, "{height} mm layers:\n{report}");
}

#[test]
fn internal_solid_and_rectilinear_tops_start_the_overlap_of_the_inner_spacing_from_the_walls_at_0_20_mm() {
    check(0.2, &measure(0.2, "rectilinear", &[2, 3, 4]), Some(TOLERANCE));
}

#[test]
fn internal_solid_and_rectilinear_tops_start_the_overlap_of_the_inner_spacing_from_the_walls_at_0_28_mm() {
    check(0.28, &measure(0.28, "rectilinear", &[2, 3, 4]), Some(TOLERANCE));
}

#[test]
fn monotonic_tops_start_the_overlap_of_the_inner_spacing_from_the_walls() {
    // Monotonic tops spread their lines evenly across the piece, which puts the first line 0.002 to 0.004 mm nearer
    // the wall than the edge at every overlap, 0 percent included.
    for height in [0.2, 0.28] {
        check(height, &measure(height, "monotonic", &[2, 3]), Some(0.005));
    }
}

#[test]
fn monotonic_line_tops_keep_no_overlap_term() {
    // The top starts at the innermost wall's spacing edge plus half a surface spacing at every overlap: 0.614 mm on
    // 2 walls and 1.022 on 3 at 0.20 mm, 0.588 and 0.978 at 0.28. The internal solid infill under it keeps the
    // overlap.
    for (height, plain) in [(0.2, [0.614, 1.022]), (0.28, [0.588, 0.978])] {
        let cases = measure(height, "monotonicline", &[2, 3]);
        check(height, &cases, None);
        for (w, ov, _, surface) in cases {
            let t = plain[w as usize - 2];
            assert!(
                (surface - t).abs() <= TOLERANCE,
                "{height} mm, {w} walls, {ov}%: top {surface:.4}, target {t:.3}"
            );
        }
    }
}
