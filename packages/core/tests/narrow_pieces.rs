// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Narrow internal solid infill on Bambu Lab printers (card ohvk, spec 2): each connected piece is narrow or not as a
//! whole, so a T whose body holds a 6 mm circle keeps its lines in the thin arm too, while other printers split the arm
//! off to concentric beads as Orca does.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::needless_pass_by_value,
    reason = "a G-code reader for the test: plate coordinates in mm, angles in whole degrees"
)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, MeshPart, SliceRequest};

/// A prism `h` mm tall over the simple polygon `poly` (counterclockwise), triangulated as a fan from its first point,
/// which every other point sees.
fn prism(poly: &[[f32; 2]], h: f32) -> Arc<Mesh> {
    let n = u32::try_from(poly.len()).unwrap();
    let mut positions: Vec<[f32; 3]> = poly.iter().map(|p| [p[0], p[1], 0.0]).collect();
    positions.extend(poly.iter().map(|p| [p[0], p[1], h]));
    let mut triangles = Vec::new();
    for i in 1..n - 1 {
        triangles.push([0, i + 1, i]);
        triangles.push([n, n + i, n + i + 1]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        triangles.push([i, j, n + j]);
        triangles.push([i, n + j, n + i]);
    }
    Arc::new(Mesh {
        name: "t".into(),
        parts: vec![MeshPart {
            name: "t".into(),
            slot: 1,
            color: None,
            positions,
            triangles,
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
            paint_texts: Vec::new(),
        }],
    })
}

/// Length of internal solid infill on layer `at` (0-based) by direction: (along 45 or 135 degrees, any other way).
fn solid_by_direction(g: &str, at: usize) -> (f64, f64) {
    let (mut layer, mut started, mut inside) = (0usize, false, false);
    let mut pos: Option<[f64; 2]> = None;
    let (mut lines, mut other) = (0.0, 0.0);
    for line in g.lines() {
        if line.starts_with(";LAYER_CHANGE") || line.starts_with("; CHANGE_LAYER") {
            if started {
                layer += 1;
            }
            started = true;
        }
        if let Some(t) = line
            .strip_prefix(";TYPE:")
            .or_else(|| line.strip_prefix("; FEATURE: "))
        {
            inside = t == "Internal solid infill";
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        if !(code.starts_with("G0") || code.starts_with("G1")) {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        let next = match (word('X'), word('Y'), pos) {
            (None, None, _) => continue,
            (x, y, Some(p)) => [x.unwrap_or(p[0]), y.unwrap_or(p[1])],
            (Some(x), Some(y), None) => [x, y],
            _ => continue,
        };
        if inside
            && layer == at
            && code.starts_with("G1")
            && word('E').is_some_and(|e| e > 0.0)
            && let Some(p) = pos
        {
            let (dx, dy) = (next[0] - p[0], next[1] - p[1]);
            let len = (dx * dx + dy * dy).sqrt();
            let a = dy.atan2(dx).to_degrees().rem_euclid(90.0);
            if (a - 45.0).abs() < 2.0 {
                lines += len;
            } else {
                other += len;
            }
        }
        pos = Some(next);
    }
    (lines, other)
}

fn slice(printer: Value) -> String {
    // A 30 by 12 mm body with a 4 mm wide arm 15.5 mm long off the middle of one long side (spec 2, example 3).
    let t = [
        [113.0, 120.0],
        [143.0, 120.0],
        [143.0, 132.0],
        [130.0, 132.0],
        [130.0, 147.5],
        [126.0, 147.5],
        [126.0, 132.0],
        [113.0, 132.0],
    ];
    let mut config = json!({
        "brim_width": 0,
        "skirt_loops": 0,
        "internal_solid_infill_pattern": "rectilinear",
        "top_shell_layers": 5,
        "bottom_shell_layers": 1,
        "wall_loops": 2,
    });
    if let (Some(c), Some(e)) = (config.as_object_mut(), printer.as_object()) {
        c.extend(e.clone());
    }
    let req: SliceRequest =
        serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
    let mesh = prism(&t, 1.0);
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

#[test]
fn a_bambu_lab_printer_keeps_lines_in_a_thin_arm_of_a_wide_piece() {
    // Layer 2 is internal solid. On a Bambu Lab printer the whole T keeps its lines.
    let (lines, other) = solid_by_direction(&slice(json!({"printer_model": "Bambu Lab H2D"})), 2);
    assert!(
        lines > 0.0 && other < 0.1 * (lines + other),
        "lines {lines} mm, other {other} mm"
    );
    // Other printers split the arm off to concentric beads, which run along it.
    let (lines, other) = solid_by_direction(&slice(json!({})), 2);
    assert!(
        other > 0.1 * (lines + other),
        "lines {lines} mm, other {other} mm"
    );
}
