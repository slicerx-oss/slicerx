// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Solid surfaces join each line to its neighbor along the edge however long the turn is (card ohvk, spec 1): a
//! turn's length follows from the angle the edge meets the lines at, s / sin(angle), and no cap of a few spacings
//! turns a long one into a travel. Monotonic line never joins.
#![allow(
    clippy::disallowed_methods,
    clippy::needless_pass_by_value,
    clippy::many_single_char_names,
    clippy::too_many_lines,
    clippy::type_complexity,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "a G-code reader for the test: plate coordinates in mm, angles in whole degrees"
)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, MeshPart, SliceRequest};

/// A prism `h` mm tall over the polygon `poly` (counterclockwise, convex).
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
        name: "prism".into(),
        parts: vec![MeshPart {
            name: "prism".into(),
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

/// `poly` turned by `deg` degrees about `c`.
fn turned(poly: &[[f32; 2]], deg: f32, c: [f32; 2]) -> Vec<[f32; 2]> {
    let (s, k) = deg.to_radians().sin_cos();
    poly.iter()
        .map(|p| [c[0] + p[0] * k - p[1] * s, c[1] + p[0] * s + p[1] * k])
        .collect()
}

fn slice(mesh: Arc<Mesh>, extra: Value) -> String {
    let mut config = json!({
        "brim_width": 0,
        "skirt_loops": 0,
        "bottom_surface_pattern": "monotonic",
        "internal_solid_infill_pattern": "rectilinear",
        "top_surface_pattern": "monotonicline",
        "top_shell_layers": 5,
        "bottom_shell_layers": 3,
    });
    if let (Some(c), Some(e)) = (config.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    let req: SliceRequest =
        serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// The joins of one feature's layers, as the spec counts them: within a run of extrusion, the moves between two fill
/// lines (segments over 0.3 mm within 2 degrees of the layer's main direction). Each join: its length along the path
/// and the offset between the two lines (across them). Also how many runs the feature took.
struct Joins {
    joins: Vec<(f64, f64)>,
    runs: usize,
}

fn joins(g: &str, label: &str, layers: std::ops::RangeInclusive<usize>) -> Joins {
    // (layer, segments of each run)
    let mut runs: Vec<(usize, Vec<([f64; 2], [f64; 2])>)> = Vec::new();
    let (mut layer, mut inside, mut open) = (0usize, false, false);
    let mut at: Option<[f64; 2]> = None;
    let mut started = false;
    for line in g.lines() {
        if line.starts_with(";LAYER_CHANGE") {
            if started {
                layer += 1;
            }
            started = true;
            open = false;
        }
        if let Some(t) = line.strip_prefix(";TYPE:") {
            inside = t == label;
            open = false;
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
        let (x, y, e) = (word('X'), word('Y'), word('E'));
        let next = match (x, y, at) {
            (None, None, _) => {
                if e.is_some_and(|e| e < 0.0) {
                    open = false;
                }
                continue;
            }
            (x, y, Some(p)) => [x.unwrap_or(p[0]), y.unwrap_or(p[1])],
            (Some(x), Some(y), None) => [x, y],
            _ => continue,
        };
        let extruding = code.starts_with("G1") && e.is_some_and(|e| e > 0.0);
        if inside
            && extruding
            && layers.contains(&layer)
            && let Some(p) = at
        {
            if !open {
                runs.push((layer, Vec::new()));
                open = true;
            }
            if let Some(r) = runs.last_mut() {
                r.1.push((p, next));
            }
        } else {
            open = false;
        }
        at = Some(next);
    }
    let len = |s: &([f64; 2], [f64; 2])| (s.1[0] - s.0[0]).hypot(s.1[1] - s.0[1]);
    let ang = |s: &([f64; 2], [f64; 2])| {
        (s.1[1] - s.0[1])
            .atan2(s.1[0] - s.0[0])
            .to_degrees()
            .rem_euclid(180.0)
    };
    let mut out = Vec::new();
    for l in layers.clone() {
        let segs: Vec<&([f64; 2], [f64; 2])> = runs
            .iter()
            .filter(|r| r.0 == l)
            .flat_map(|r| r.1.iter())
            .collect();
        let mut weight = [0.0_f64; 180];
        for s in &segs {
            let k = (ang(s).round() as usize) % 180;
            weight[k] += len(s);
        }
        let Some(dom) = (0..180).max_by(|&a, &b| weight[a].total_cmp(&weight[b])) else {
            continue;
        };
        let dom = dom as f64;
        let is_line = |s: &([f64; 2], [f64; 2])| {
            let d = (ang(s) - dom).abs();
            len(s) > 0.3 && d.min(180.0 - d) < 2.0
        };
        let across = [-(dom.to_radians().sin()), dom.to_radians().cos()];
        for (_, r) in runs.iter().filter(|r| r.0 == l) {
            let mut since: Option<([f64; 2], f64)> = None;
            for s in r {
                if is_line(s) {
                    if let Some((end, length)) = since
                        && length > 0.0
                    {
                        let dk = ((s.0[0] - end[0]) * across[0] + (s.0[1] - end[1]) * across[1]).abs();
                        out.push((length, dk));
                    }
                    since = Some((s.1, 0.0));
                } else if let Some((_, length)) = since.as_mut() {
                    *length += len(s);
                }
            }
        }
    }
    Joins {
        joins: out,
        runs: runs.len(),
    }
}

#[test]
fn a_turn_along_a_shallow_edge_is_extruded_however_long() {
    // A 30 by 20 mm rectangle turned 35 degrees: two of its edges run 10 degrees off the 45 and 135 degree lines, so
    // the turn between neighbors there is s / sin(10 degrees), over five spacings.
    let rect = turned(
        &[[-15.0, -10.0], [15.0, -10.0], [15.0, 10.0], [-15.0, 10.0]],
        35.0,
        [128.0, 128.0],
    );
    let g = slice(prism(&rect, 1.0), json!({}));
    for (label, layers) in [("Bottom surface", 0..=0), ("Internal solid infill", 1..=3)] {
        let j = joins(&g, label, layers);
        let next: Vec<f64> = j
            .joins
            .iter()
            .filter(|(_, dk)| *dk > 0.2)
            .map(|(l, _)| *l)
            .collect();
        let short = next.iter().copied().fold(f64::INFINITY, f64::min);
        let long = next.iter().copied().fold(0.0, f64::max);
        // The short turns cross the steep edges at 80 degrees, the long ones the shallow edges at 10.
        let want = short * 80_f64.to_radians().sin() / 10_f64.to_radians().sin();
        assert!(
            (long / want - 1.0).abs() < 0.03,
            "{label}: longest turn {long} mm, want {want}"
        );
        assert!(long > 3.0 * short, "{label}: {long} mm");
        // One run per layer: no turn became a travel.
        let layer_count = if label == "Bottom surface" { 1 } else { 3 };
        assert_eq!(j.runs, layer_count, "{label}: {} runs", j.runs);
    }
    // Monotonic line never joins.
    let top = joins(&g, "Top surface", 4..=4);
    assert!(top.joins.is_empty(), "{:?}", top.joins);
}

#[test]
fn a_thin_wedge_extrudes_a_turn_of_fourteen_spacings() {
    // An 8 degree wedge along 45 degrees: on layer 0 the lines run along it, its sides 4 degrees off them, and the turn
    // along a side is s / sin(4 degrees), over 14 spacings.
    let half = 40.0 * 4_f32.to_radians().tan();
    let wedge = turned(
        &[[-20.0, -half], [20.0, 0.0], [-20.0, half]],
        45.0,
        [128.0, 128.0],
    );
    let g = slice(prism(&wedge, 1.0), json!({}));
    let j = joins(&g, "Bottom surface", 0..=0);
    let short = j
        .joins
        .iter()
        .filter(|(_, dk)| *dk > 0.2)
        .map(|(l, _)| *l)
        .fold(f64::INFINITY, f64::min);
    let long = j.joins.iter().map(|(l, _)| *l).fold(0.0, f64::max);
    // The short turns cross the wide end square on: one spacing.
    let want = short / 4_f64.to_radians().sin();
    assert!(
        (long / want - 1.0).abs() < 0.05,
        "longest turn {long} mm, want {want}"
    );
    assert_eq!(j.runs, 1, "the bottom of the wedge in one run");
}

#[test]
fn turns_on_square_edges_are_unchanged() {
    // The control: edges at 45 degrees to the lines, every turn s / sin(45 degrees), well under any cap.
    let g = slice(
        prism(
            &[[113.0, 118.0], [143.0, 118.0], [143.0, 138.0], [113.0, 138.0]],
            1.0,
        ),
        json!({}),
    );
    let j = joins(&g, "Bottom surface", 0..=0);
    let long = j.joins.iter().map(|(l, _)| *l).fold(0.0, f64::max);
    let short = j.joins.iter().map(|(l, _)| *l).fold(f64::INFINITY, f64::min);
    assert!(long - short < 0.02, "{short} to {long} mm");
    assert_eq!(j.runs, 1);
}
