// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where the top surface and the internal solid infill start over classic walls on the shipped Bambu Lab P1S settings
//! (0.20 mm Standard: 0.42 mm outer and 0.45 mm inner walls, 0.42 mm top surface and internal solid infill, 15 percent
//! infill wall overlap, inner walls first, fixed layers, `only_one_wall_top` off), on a 20 mm box 4 mm tall: the line
//! ends nearest each side's outer wall, mm in from that wall's centerline, on the middle 12 mm of each side.
//!
//! With spacing(w) = w - h x (1 - pi/4) and c the innermost wall's centerline, a monotonic line top surface's lines end
//! at c + spacing(inner)/2 + spacing(top)/20, with no overlap term, and the internal solid infill's at
//! c + spacing(inner)/2 + spacing(solid)/2 - overlap x (spacing(inner) + spacing(solid))/2. Both follow the layer height
//! and the precise outer wall setting as the walls do.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "a G-code reader for the test: positions in mm"
)]

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

fn read(path: &str) -> Value {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    serde_json::from_slice(&std::fs::read(format!("{root}/{path}")).unwrap()).unwrap()
}

/// The shipped P1S printer, PLA and 0.20 mm Standard process over the settings defaults, with classic walls (the
/// generator the Bambu Lab presets use), fixed layers, no brim and no skirt, then `extra`.
fn settings(extra: &Value) -> Value {
    let mut c = serde_json::Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        c.insert(k.clone(), v[1].clone());
    }
    let model = &read("packages/profiles/resolved/bambu-lab.json")["models"]["bambu-p1s"];
    let base = model["base"].as_str().unwrap();
    for part in [&model["process"][base], &model["filament"], &model["machine"]] {
        c.extend(part.as_object().unwrap().clone());
    }
    let fixed = json!({
        "wall_generator": "classic",
        "smart_layer": "off",
        "brim_type": "no_brim",
        "skirt_loops": 0,
    });
    c.extend(fixed.as_object().unwrap().clone());
    c.extend(extra.as_object().unwrap().clone());
    Value::Object(c)
}

/// A 20 mm square box 4 mm tall, centered on the origin.
fn box20() -> Mesh {
    let (h, t) = (10.0_f32, 4.0_f32);
    let mut positions = Vec::new();
    for z in [0.0, t] {
        positions.extend([[-h, -h, z], [h, -h, z], [h, h, z], [-h, h, z]]);
    }
    let triangles = vec![
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    Mesh {
        name: "m".into(),
        parts: vec![MeshPart {
            name: "m".into(),
            slot: 1,
            positions,
            triangles,
            ..MeshPart::default()
        }],
        ..Mesh::default()
    }
}

fn slice(config: &Value) -> String {
    let mesh = Arc::new(box20());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "m"}]},
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
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

/// One extruding move: its layer z in thousandths of a millimeter, feature, start and end (mm).
type Move = (i64, String, (f64, f64), (f64, f64));

/// Each extruding move.
fn moves(gcode: &str) -> Vec<Move> {
    let (mut feature, mut layer) = (String::new(), 0);
    let mut at = (0.0, 0.0);
    let mut out = Vec::new();
    for line in gcode.lines() {
        let text = line.trim();
        if let Some(f) = comment(text, &["TYPE", "FEATURE"]) {
            f.clone_into(&mut feature);
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
        if word(code, 'E').is_some_and(|e| e > 0.0) && to != at {
            out.push((layer, feature.clone(), at, to));
        }
        at = to;
    }
    out
}

/// The line ends nearest the outer wall per side of the box (left, right, bottom, top), mm in from the outer wall's
/// centerline, of `feature` on the highest layer that prints it, or below `under` (z in thousandths) when given.
fn near_edges(gcode: &str, feature: &str, under: Option<i64>) -> ([f64; 4], i64) {
    let all = moves(gcode);
    let layer = all
        .iter()
        .filter(|m| m.1 == feature && under.is_none_or(|u| m.0 < u))
        .map(|m| m.0)
        .max()
        .unwrap_or_else(|| panic!("no {feature}"));
    let on = |f: &str| {
        all.iter()
            .filter(|m| m.0 == layer && m.1 == f)
            .collect::<Vec<_>>()
    };
    let outer = on("Outer wall");
    let points = || outer.iter().flat_map(|m| [m.2, m.3]);
    let x0 = points().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let x1 = points().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let y0 = points().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let y1 = points().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    let (cx, cy) = (f64::midpoint(x0, x1), f64::midpoint(y0, y1));
    let ends: Vec<(f64, f64)> = on(feature).iter().flat_map(|m| [m.2, m.3]).collect();
    let edges = [0, 1, 2, 3].map(|side| {
        ends.iter()
            .filter_map(|&(x, y)| match side {
                0 if (y - cy).abs() < 6.0 && x < cx => Some(x - x0),
                1 if (y - cy).abs() < 6.0 && x > cx => Some(x1 - x),
                2 if (x - cx).abs() < 6.0 && y < cy => Some(y - y0),
                3 if (x - cx).abs() < 6.0 && y > cy => Some(y1 - y),
                _ => None,
            })
            .fold(f64::INFINITY, f64::min)
    });
    (edges, layer)
}

/// The top surface's and the internal solid infill's near edges on `config`: the top surface on its top layer, the
/// internal solid infill on the highest layer under it.
fn surface_edges(config: &Value) -> ([f64; 4], [f64; 4]) {
    let gcode = slice(config);
    let (top, z) = near_edges(&gcode, "Top surface", None);
    let (solid, _) = near_edges(&gcode, "Internal solid infill", Some(z));
    (top, solid)
}

/// Every side within `tol` of `target`, or what they were.
fn off(what: &str, got: [f64; 4], target: f64, tol: f64) -> Option<String> {
    got.iter()
        .any(|g| (g - target).abs() > tol)
        .then(|| format!("{what}: per side {got:.4?}, target {target}"))
}

/// The P1S settings with classic walls, `only_one_wall_top` off and a monotonic line top surface, then `extra`.
fn stock(extra: &Value) -> Value {
    let mut c = settings(&json!({
        "only_one_wall_top": false,
        "top_surface_pattern": "monotonicline",
        "precise_outer_wall": false,
    }));
    c.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    c
}

/// Widths of 0.62 mm everywhere at 0.3 mm layers, as on a 0.6 mm nozzle.
fn wide(extra: &Value) -> Value {
    let mut c = stock(&json!({
        "layer_height": 0.3,
        "line_width": 0.62,
        "outer_wall_line_width": 0.62,
        "inner_wall_line_width": 0.62,
        "top_surface_line_width": 0.62,
        "internal_solid_infill_line_width": 0.62,
        "sparse_infill_line_width": 0.62,
        "initial_layer_line_width": 0.62,
    }));
    c.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    c
}

/// The monotonic line top surface and the internal solid infill start at the targets, on 2, 3 and 4 walls at 0.2 mm,
/// on 3 walls at 0.12 and 0.28 mm, with precise outer wall on, and with 0.62 mm widths at 0.3 mm. Before, they started
/// where the walls' widths end (the outer wall's width and an inner wall's per further wall, less the overlap of the
/// line width), whatever the layer height or the setting: the top surface at 0.616, 1.066 and 1.516 at 0.2 mm, and
/// the internal solid infill at 0.785, 1.235 and 1.685.
#[test]
fn classic_surfaces_start_from_the_innermost_walls_spacing_edge() {
    let cases: [(&str, Value, f64, f64); 9] = [
        ("2 walls, 0.2 mm", stock(&json!({"wall_loops": 2})), 0.614, 0.725),
        ("3 walls, 0.2 mm", stock(&json!({"wall_loops": 3})), 1.022, 1.132),
        ("4 walls, 0.2 mm", stock(&json!({"wall_loops": 4})), 1.429, 1.539),
        (
            "3 walls, 0.12 mm",
            stock(&json!({"wall_loops": 3, "layer_height": 0.12})),
            1.065,
            1.181,
        ),
        (
            "3 walls, 0.28 mm",
            stock(&json!({"wall_loops": 3, "layer_height": 0.28})),
            0.978,
            1.083,
        ),
        (
            "3 walls, 0.2 mm, precise outer wall",
            stock(&json!({"wall_loops": 3, "precise_outer_wall": true})),
            1.064,
            1.175,
        ),
        (
            "3 walls, 0.28 mm, precise outer wall",
            stock(&json!({"wall_loops": 3, "layer_height": 0.28, "precise_outer_wall": true})),
            1.038,
            1.144,
        ),
        (
            "0.62 mm widths, 3 walls",
            wide(&json!({"wall_loops": 3})),
            1.417,
            1.583,
        ),
        (
            "0.62 mm widths, 3 walls, precise outer wall",
            wide(&json!({"wall_loops": 3, "precise_outer_wall": true})),
            1.481,
            1.648,
        ),
    ];
    let mut out = Vec::new();
    for (what, cfg, top, solid) in cases {
        let (t, s) = surface_edges(&cfg);
        out.extend(off(&format!("{what}, top surface"), t, top, 0.003));
        out.extend(off(&format!("{what}, internal solid infill"), s, solid, 0.003));
    }
    assert!(out.is_empty(), "{out:#?}");
}

/// The overlap moves the other surfaces and leaves the monotonic line top where it is, at 0 and 30 percent on 2 and 3
/// walls: the monotonic line top at 0.614 and 1.022 at both; a rectilinear top with the internal solid infill, which
/// moves 0.392 mm (the mean of the inner wall's and the internal solid infill's spacings) per 100 percent: 0.784 and
/// 1.191 at 0, 0.667 and 1.074 at 30 (before 0.849 and 1.299, 0.723 and 1.173, from the walls' widths); a monotonic
/// top, whose lines spread across the piece from that edge as before, 0.782 and 1.189 at 0, 0.664 and 1.071 at 30.
#[test]
fn the_overlap_moves_every_classic_surface_but_a_monotonic_line_top() {
    let mut out = Vec::new();
    for (overlap, walls, line, rectilinear, monotonic) in [
        (0, 2, 0.614, 0.784, 0.782),
        (0, 3, 1.022, 1.191, 1.189),
        (30, 2, 0.614, 0.667, 0.664),
        (30, 3, 1.022, 1.074, 1.071),
    ] {
        for (pattern, top) in [
            ("monotonicline", line),
            ("rectilinear", rectilinear),
            ("monotonic", monotonic),
        ] {
            let cfg = stock(&json!({
                "wall_loops": walls,
                "infill_wall_overlap": overlap,
                "top_surface_pattern": pattern,
            }));
            let (t, s) = surface_edges(&cfg);
            let what = format!("{walls} walls, {overlap} percent, {pattern}");
            out.extend(off(&format!("{what}, top surface"), t, top, 0.003));
            out.extend(off(
                &format!("{what}, internal solid infill"),
                s,
                rectilinear,
                0.003,
            ));
        }
    }
    assert!(out.is_empty(), "{out:#?}");
}
