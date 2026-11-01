// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Internal solid infill lines along the walls on Bambu Lab printers, on the stock P1S request
//! (fixtures/surface-walls/p1s-x-mark.json, 0.2 mm layers, 15 percent infill wall overlap) with `only_one_wall_top`
//! off and a monotonic line top, on a square box 4 mm tall turned 45 degrees, so the lines run along two of its sides.
//!
//! The lines fit between each piece's edges: the first and the last line half a solid spacing in from the edge the
//! internal solid infill starts at, the innermost wall's spacing edge less the overlap (0.725 mm from the outer wall's
//! centerline on 2 classic walls and 1.132 on 3), and the lines between them floor(W / spacing) intervals apart for W
//! between the first and the last line. Before, the lines sat on one grid across the plate and a line nearer the
//! wall than that edge was left out, so the nearest line along a wall landed up to a spacing further in, depending on
//! the part's size and position: 0.907, 0.740, 0.835, 1.077 and 0.911 mm on 2 walls for boxes 7.15 to 15.45 mm from
//! their center to each side.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::disallowed_methods,
    reason = "a G-code reader for the test: positions in mm"
)]

use serde_json::{Value, json};
use std::fmt::Write as _;
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

const REQUEST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/surface-walls/p1s-x-mark.json"
);

/// The box sizes, mm from the center to each side.
const HALVES: [f64; 5] = [7.15, 10.0, 10.85, 12.6, 15.45];

/// A square box `half` mm from its center to each side, 4 mm tall, turned 45 degrees, as ASCII STL.
fn diamond(half: f64) -> Vec<u8> {
    let r = half * std::f64::consts::SQRT_2;
    let ring = |z: f64| [(r, 0.0, z), (0.0, r, z), (-r, 0.0, z), (0.0, -r, z)];
    let (b, t) = (ring(0.0), ring(4.0));
    let mut out = String::from("solid diamond\n");
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
    out.push_str("endsolid diamond\n");
    out.into_bytes()
}

/// The G-code of the box `half` mm across on the P1S request with `extra` over it.
fn slice(half: f64, extra: &Value) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    let config = req["config"].as_object_mut().unwrap();
    config.insert("only_one_wall_top".into(), json!(false));
    config.insert("top_surface_pattern".into(), json!("monotonicline"));
    config.extend(extra.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let mesh = Arc::new(Mesh::load(&diamond(half), "part.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

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

type Segment = ((f64, f64), (f64, f64));

/// The extruding moves of `feature` on the layer at `z` (thousandths of a millimeter).
fn segments(gcode: &str, z: i64, feature: &str) -> Vec<Segment> {
    let (mut f, mut layer) = (String::new(), 0);
    let mut at = (0.0, 0.0);
    let mut out = Vec::new();
    for line in gcode.lines() {
        let text = line.trim();
        if let Some(v) = comment(text, &["TYPE", "FEATURE"]) {
            v.clone_into(&mut f);
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
        if layer == z && f == feature && word(code, 'E').is_some_and(|e| e > 0.0) && to != at {
            out.push((at, to));
        }
        at = to;
    }
    out
}

/// Per side of the outer wall that `feature`'s lines run along on the layer at `z`: the distances of those lines from
/// the side's centerline, mm, nearest first.
fn along_sides(gcode: &str, z: i64, feature: &str) -> Vec<Vec<f64>> {
    let walls = segments(gcode, z, "Outer wall");
    let lines = segments(gcode, z, feature);
    let mut out = Vec::new();
    for (a, b) in walls {
        let len = (b.0 - a.0).hypot(b.1 - a.1);
        if len < 3.0 {
            continue;
        }
        let (ux, uy) = ((b.0 - a.0) / len, (b.1 - a.1) / len);
        let mut d: Vec<f64> = lines
            .iter()
            .filter_map(|&(p, q)| {
                let l = (q.0 - p.0).hypot(q.1 - p.1);
                let parallel = l > 1.5 && (ux * (q.1 - p.1) - uy * (q.0 - p.0)).abs() / l < 0.01;
                let mid = (f64::midpoint(p.0, q.0), f64::midpoint(p.1, q.1));
                parallel.then(|| ((mid.0 - a.0) * uy - (mid.1 - a.1) * ux).abs())
            })
            .collect();
        d.sort_by(f64::total_cmp);
        d.dedup_by(|x, y| (*x - *y).abs() < 1e-3);
        if !d.is_empty() {
            out.push(d);
        }
    }
    out
}

/// Filament of `feature`'s moves on the layer at `z`.
fn layer_filament(gcode: &str, z: i64, feature: &str) -> f64 {
    let (mut f, mut layer) = (String::new(), 0);
    let mut at = (0.0, 0.0);
    let mut sum = 0.0;
    for line in gcode.lines() {
        let text = line.trim();
        if let Some(v) = comment(text, &["TYPE", "FEATURE"]) {
            v.clone_into(&mut f);
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
        if let Some(e) = word(code, 'E').filter(|e| *e > 0.0 && layer == z && f == feature && to != at) {
            sum += e;
        }
        at = to;
    }
    sum
}

/// Filament per mm of `feature`'s moves longer than 1.5 mm on the layer at `z`.
fn filament_per_mm(gcode: &str, z: i64, feature: &str) -> f64 {
    let (mut f, mut layer) = (String::new(), 0);
    let mut at = (0.0, 0.0);
    let (mut e_sum, mut len_sum) = (0.0, 0.0);
    for line in gcode.lines() {
        let text = line.trim();
        if let Some(v) = comment(text, &["TYPE", "FEATURE"]) {
            v.clone_into(&mut f);
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
        let len = (to.0 - at.0).hypot(to.1 - at.1);
        if let Some(e) = word(code, 'E').filter(|e| *e > 0.0 && layer == z && f == feature && len > 1.5) {
            e_sum += e;
            len_sum += len;
        }
        at = to;
    }
    e_sum / len_sum
}

/// The nearest internal solid line along each side of the box on the layer at `z`, and the pitches between the lines
/// along each side.
fn nearest_and_pitches(gcode: &str, z: i64) -> (Vec<f64>, Vec<f64>) {
    let sides = along_sides(gcode, z, "Internal solid infill");
    let near = sides.iter().map(|d| d[0]).collect();
    let pitches = sides
        .iter()
        .flat_map(|d| {
            d.windows(2)
                .map(|w| w[1] - w[0])
                .filter(|p| *p < 1.0)
                .collect::<Vec<_>>()
        })
        .collect();
    (near, pitches)
}

/// The nearest internal solid line along a side, on the layer under the top (z 3.8), within 0.006 mm of the targets
/// on 2 and 3 classic walls at every size, and within 0.008 on aegis walls (whose overlap term leans 0.002 nearer the
/// wall here), with the lines evenly spaced at no less than the solid spacing (0.377 mm).
#[test]
fn internal_solid_lines_along_a_wall_start_at_the_fixed_edge() {
    let cases = [
        ("classic", 2, [0.731, 0.725, 0.727, 0.728, 0.728], 0.006),
        ("classic", 3, [1.137, 1.136, 1.133, 1.135, 1.134], 0.006),
        ("aegis", 2, [0.729, 0.723, 0.725, 0.725, 0.726], 0.008),
        ("aegis", 3, [1.136, 1.134, 1.131, 1.133, 1.133], 0.008),
    ];
    let mut misses = Vec::new();
    for (walls_kind, walls, targets, tol) in cases {
        for (half, target) in HALVES.iter().zip(targets) {
            let g = slice(*half, &json!({"wall_generator": walls_kind, "wall_loops": walls}));
            let (near, pitches) = nearest_and_pitches(&g, 3800);
            let what = format!("{walls_kind}, {walls} walls, half size {half}");
            if near.is_empty() || near.iter().any(|n| (n - target).abs() > tol) {
                misses.push(format!("{what}: nearest per side {near:.3?}, target {target}"));
            }
            let (lo, hi) = pitches
                .iter()
                .fold((f64::INFINITY, 0.0_f64), |(a, b), p| (a.min(*p), b.max(*p)));
            if lo < 0.376 || hi - lo > 0.002 {
                misses.push(format!("{what}: pitches {lo:.4} to {hi:.4}"));
            }
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}

/// The same edge on the bottom shell's internal solid layers (z 0.4 at 0.2 mm, 0.48 at 0.28 mm, 0.5 with 0.62 mm
/// widths at 0.3 mm) on the 20 mm box for the other settings: 2 classic walls at 30 percent 0.666 to 0.670, at 0.28 mm
/// 0.694 to 0.697, with 0.62 mm widths 1.028 to 1.034, on 3 walls 1.132 to 1.136, each within 0.002. The first layer's
/// bottom surface keeps its edge, 0.846 to 0.850 on 2 walls.
#[test]
fn internal_solid_lines_fit_for_other_settings_and_the_first_layer_stays() {
    let wide = json!({
        "layer_height": 0.3,
        "line_width": 0.62,
        "outer_wall_line_width": 0.62,
        "inner_wall_line_width": 0.62,
        "top_surface_line_width": 0.62,
        "internal_solid_infill_line_width": 0.62,
        "sparse_infill_line_width": 0.62,
        "initial_layer_line_width": 0.62,
    });
    let cases = [
        (
            "30 percent",
            json!({"infill_wall_overlap": 30}),
            400,
            (0.666, 0.670),
        ),
        ("0.28 mm", json!({"layer_height": 0.28}), 480, (0.694, 0.697)),
        ("0.62 mm widths", wide, 500, (1.028, 1.034)),
        ("3 walls", json!({"wall_loops": 3}), 400, (1.132, 1.136)),
    ];
    let mut misses = Vec::new();
    for (what, mut extra, z, (lo, hi)) in cases {
        let extra_map = extra.as_object_mut().unwrap();
        extra_map.insert("wall_generator".into(), json!("classic"));
        extra_map.entry("wall_loops").or_insert(json!(2));
        let g = slice(10.0, &extra);
        let (near, _) = nearest_and_pitches(&g, z);
        if near.is_empty() || near.iter().any(|n| *n < lo - 0.002 || *n > hi + 0.002) {
            misses.push(format!(
                "{what}: nearest per side {near:.3?}, target {lo} to {hi}"
            ));
        }
    }
    let g = slice(10.0, &json!({"wall_generator": "classic", "wall_loops": 2}));
    let first: Vec<f64> = along_sides(&g, 200, "Bottom surface")
        .iter()
        .map(|d| d[0])
        .collect();
    if first.is_empty() || first.iter().any(|n| !(0.845..=0.851).contains(n)) {
        misses.push(format!(
            "first layer: nearest bottom surface line per side {first:.3?}, target 0.846 to 0.850"
        ));
    }
    assert!(misses.is_empty(), "{misses:#?}");
}

/// A fitted line is as much wider than the internal solid infill's width as its pitch is wider than the spacing, so
/// the filament per mm of line over its pitch is the same on every box (within 0.3 percent), from 0.3776 mm on the box
/// 10 mm across to 0.3886 on the box 7.15 mm across, on 2 classic walls on the layer under the top.
#[test]
fn fitted_internal_solid_lines_widen_with_their_pitch() {
    let mut per_pitch = Vec::new();
    for half in HALVES {
        let g = slice(half, &json!({"wall_generator": "classic", "wall_loops": 2}));
        let (_, pitches) = nearest_and_pitches(&g, 3800);
        let pitch = pitches.iter().sum::<f64>() / pitches.len() as f64;
        per_pitch.push((
            half,
            pitch,
            filament_per_mm(&g, 3800, "Internal solid infill") / pitch,
        ));
    }
    let (lo, hi) = per_pitch
        .iter()
        .fold((f64::INFINITY, 0.0_f64), |(a, b), p| (a.min(p.2), b.max(p.2)));
    assert!(
        hi / lo - 1.0 < 0.003,
        "half size, pitch, filament per mm over the pitch: {per_pitch:.5?}"
    );
}

/// The internal solid filament on the layer under the top (z 3.8) of each box, within 0.5 percent of the targets on 2
/// and 3 classic and aegis walls: the lines along the walls that now fit, each as much wider as its pitch grew. Before,
/// on 2 classic walls, 12.98, 27.86, 32.91, 44.43 and 69.57 mm against 13.37, 27.91, 33.28, 45.80 and 70.47; fitting
/// the lines without widening them left them up to 2.8 percent short.
#[test]
fn internal_solid_filament_follows_the_targets() {
    let cases = [
        ("classic", 2, [13.37, 27.91, 33.28, 45.80, 70.47]),
        ("classic", 3, [11.73, 25.52, 30.65, 42.71, 66.63]),
        ("aegis", 2, [13.38, 27.92, 33.29, 45.82, 70.50]),
        ("aegis", 3, [11.74, 25.53, 30.66, 42.73, 66.65]),
    ];
    let mut misses = Vec::new();
    for (walls_kind, walls, targets) in cases {
        for (half, target) in HALVES.iter().zip(targets) {
            let g = slice(*half, &json!({"wall_generator": walls_kind, "wall_loops": walls}));
            let got = layer_filament(&g, 3800, "Internal solid infill");
            if (got / target - 1.0).abs() > 0.005 {
                misses.push(format!(
                    "{walls_kind}, {walls} walls, half size {half}: {got:.3} mm, target {target}"
                ));
            }
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}
