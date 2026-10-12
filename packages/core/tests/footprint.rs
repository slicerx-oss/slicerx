// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The first layer footprint of the X plate: the elephant foot pulls the first layer in alike on every side, and the
//! first layer sits where the plate's own outline at that height puts it. The plate's rounded bottom edge is a little
//! off center (its cut at z 0.1 lies about 0.074 mm right of and 0.023 mm above its cut at z 0.3), so layer 2 reaches
//! further past layer 1 on the left and bottom than on the right and top; Orca 2.4.2 gives the same outlines on every
//! side to 0.002 mm when it slices the plate where the file puts it (`bench/compare/footprint_parity.py`).

#![allow(clippy::float_cmp, reason = "layer 2 must come out exactly as it was")]

mod common;

use serde_json::json;
use std::sync::Arc;
use sx_core::Mesh;
use sx_core::api::SliceRequest;

fn plate() -> Arc<Mesh> {
    let path = format!("{}/bench/models/x-mark.stl", env!("CARGO_MANIFEST_DIR"));
    Arc::new(Mesh::load(&std::fs::read(path).unwrap(), "x-mark.stl").unwrap())
}

fn slice(m: &Arc<Mesh>, foot: f64) -> String {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "m"}]},
        "config": {"elefant_foot_compensation": foot, "layer_height": 0.2, "initial_layer_print_height": 0.2,
                   "brim_type": "no_brim", "brim_width": 0},
    }))
    .unwrap();
    let m = m.clone();
    let run = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// The box (min x, min y, max x, max y) of the outer wall loops (overhang walls included) of each of the first
/// two layers.
fn wall_boxes(g: &str) -> [[f64; 4]; 2] {
    let mut boxes = [[f64::MAX, f64::MAX, f64::MIN, f64::MIN]; 2];
    let (mut layer, mut wall, mut x, mut y) = (0usize, false, 0.0f64, 0.0f64);
    for line in g.lines() {
        if line.starts_with(";LAYER_CHANGE") {
            layer += 1;
        } else if let Some(t) = line.strip_prefix(";TYPE:") {
            wall = matches!(t.trim(), "Outer wall" | "Overhang wall");
        }
        let code = line.split(';').next().unwrap_or("");
        if !(code.starts_with("G0 ") || code.starts_with("G1 ")) {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .find_map(|w| w.strip_prefix(c))
                .and_then(|v| v.parse::<f64>().ok())
        };
        let (nx, ny) = (word('X').unwrap_or(x), word('Y').unwrap_or(y));
        if wall && (1..=2).contains(&layer) && word('E').is_some_and(|e| e > 0.0) {
            let b = &mut boxes[layer - 1];
            for (px, py) in [(x, y), (nx, ny)] {
                b[0] = b[0].min(px);
                b[1] = b[1].min(py);
                b[2] = b[2].max(px);
                b[3] = b[3].max(py);
            }
        }
        (x, y) = (nx, ny);
    }
    boxes
}

fn center(b: &[f64; 4]) -> (f64, f64) {
    (f64::midpoint(b[0], b[2]), f64::midpoint(b[1], b[3]))
}

#[test]
fn the_x_plate_first_layer_follows_its_own_outline_and_the_foot_comes_in_on_every_side() {
    let m = plate();
    let [plain1, plain2] = wall_boxes(&slice(&m, 0.0));
    let [foot1, foot2] = wall_boxes(&slice(&m, 0.2));
    // The foot pulls the first layer in by 0.2 mm on each side and leaves layer 2 as it was.
    let pulled = [
        foot1[0] - plain1[0],
        foot1[1] - plain1[1],
        plain1[2] - foot1[2],
        plain1[3] - foot1[3],
    ];
    for (side, d) in ["left", "bottom", "right", "top"].iter().zip(pulled) {
        assert!(
            (d - 0.2).abs() < 0.005,
            "{side}: the foot pulled the first layer in by {d:.4} mm"
        );
    }
    assert_eq!(plain2, foot2);
    // The first layer is the plate's own outline at its height: right of and above layer 2's middle, as the mesh
    // is, not mirrored.
    for (l1, l2) in [(plain1, plain2), (foot1, foot2)] {
        let ((x1, y1), (x2, y2)) = (center(&l1), center(&l2));
        let (dx, dy) = (x1 - x2, y1 - y2);
        assert!(
            (dx - 0.074).abs() < 0.01 && (dy - 0.023).abs() < 0.01,
            "layer 1 sits {dx:+.4}, {dy:+.4} mm from layer 2"
        );
    }
}
