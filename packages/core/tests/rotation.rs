// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Infill rotation templates: `sparse_infill_rotate_template` and `solid_infill_rotate_template` set the
//! direction of the lines per layer.

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
#![allow(
    clippy::disallowed_methods,
    clippy::many_single_char_names,
    clippy::needless_pass_by_value,
    reason = "test arithmetic on G-code moves"
)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{self, Mesh, SliceRequest};

fn cuboid(x: [f32; 2], y: [f32; 2], z: [f32; 2]) -> api::MeshPart {
    let mut positions = Vec::new();
    for zi in z {
        for (xi, yi) in [(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])] {
            positions.push([xi, yi, zi]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    api::MeshPart {
        name: "box".into(),
        slot: 1,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint: Vec::new(),
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
    }
}

/// G-code of a 20 mm box 4 mm tall at 0.2 mm layers.
fn slice(config: Value) -> String {
    slice_turned(config, 0.0)
}

/// [`slice`] with the box turned `deg` degrees about Z.
fn slice_turned(config: Value, deg: f64) -> String {
    let (s, c) = deg.to_radians().sin_cos();
    let cube = Arc::new(Mesh {
        name: "box".into(),
        parts: vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 4.0])],
    });
    let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "sparse_infill_density": 20, "sparse_infill_pattern": "rectilinear"});
    cfg.as_object_mut()
        .unwrap()
        .extend(config.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "c", "transform": [c,s,0,0, -s,c,0,0, 0,0,1,0, 118,118,0,1]}]},
        "config": cfg,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(cube.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

/// The direction (degrees, 0 to 180, in 5 degree bins) holding the most extruded length of `feature` on
/// 0-based layer `layer`, counting moves longer than 2 mm.
fn main_direction(g: &str, feature: &str, layer: usize) -> u32 {
    let (mut f, mut l, mut seen) = (String::new(), 0usize, false);
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let mut bins = [0.0f64; 36];
    for line in g.lines() {
        if sx_core::extras::is_layer_mark(line) {
            if seen {
                l += 1;
            }
            seen = true;
            continue;
        }
        if let Some(v) = line.strip_prefix(";TYPE:") {
            v.clone_into(&mut f);
            continue;
        }
        if !(line.starts_with("G1 ") || line.starts_with("G0 ")) {
            continue;
        }
        let word = |c: char| {
            line.split_whitespace()
                .find_map(|w| w.strip_prefix(c))
                .and_then(|v| v.parse::<f64>().ok())
        };
        let (nx, ny) = (word('X').unwrap_or(x), word('Y').unwrap_or(y));
        if f == feature && l == layer && word('E').is_some_and(|e| e > 0.0) {
            let (dx, dy) = (nx - x, ny - y);
            let len = dx.hypot(dy);
            if len > 2.0 {
                let a = dy.atan2(dx).to_degrees().rem_euclid(180.0);
                bins[((a + 2.5) / 5.0) as usize % 36] += len;
            }
        }
        (x, y) = (nx, ny);
    }
    let best = bins
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map_or(0, |(i, _)| i);
    best as u32 * 5
}

#[test]
fn a_sparse_template_sets_each_layers_direction() {
    let plain = slice(json!({}));
    let d5 = main_direction(&plain, "Sparse infill", 8);
    let d6 = main_direction(&plain, "Sparse infill", 9);
    assert!(d5 == 45 || d5 == 135, "default sparse direction {d5}");
    assert_ne!(d5, d6, "default sparse infill turns every layer");
    let g = slice(json!({"sparse_infill_rotate_template": "0,90"}));
    assert_eq!(main_direction(&g, "Sparse infill", 8), 0);
    assert_eq!(main_direction(&g, "Sparse infill", 9), 90);
    let g = slice(json!({"sparse_infill_rotate_template": "30"}));
    assert_eq!(main_direction(&g, "Sparse infill", 8), 30);
    assert_eq!(main_direction(&g, "Sparse infill", 9), 30);
    let g = slice(json!({"sparse_infill_rotate_template": "+15"}));
    assert_eq!(main_direction(&g, "Sparse infill", 8), 135);
    assert_eq!(main_direction(&g, "Sparse infill", 9), 150);
}

#[test]
fn a_solid_template_turns_every_solid_surface() {
    let plain = slice(json!({}));
    assert_eq!(main_direction(&plain, "Bottom surface", 0), 45);
    let g = slice(json!({"solid_infill_rotate_template": "0,90"}));
    assert_eq!(main_direction(&g, "Bottom surface", 0), 0);
    assert_eq!(main_direction(&g, "Internal solid infill", 1), 90);
    let g = slice(json!({"solid_infill_rotate_template": "20"}));
    assert_eq!(main_direction(&g, "Bottom surface", 0), 20);
    assert_eq!(main_direction(&g, "Internal solid infill", 2), 20);
    // The sparse infill keeps its own direction.
    assert_eq!(
        main_direction(&g, "Sparse infill", 8),
        main_direction(&plain, "Sparse infill", 8)
    );
}

#[test]
fn templates_on_other_patterns() {
    let g = slice(json!({"sparse_infill_pattern": "line", "sparse_infill_rotate_template": "10"}));
    assert_eq!(main_direction(&g, "Sparse infill", 8), 10);
    assert_eq!(main_direction(&g, "Sparse infill", 9), 10);
}

#[test]
fn aligning_to_the_model_turns_the_infill_with_it() {
    let plain = slice_turned(json!({}), 30.0);
    let aligned = slice_turned(json!({"align_infill_direction_to_model": true}), 30.0);
    for (feature, layer) in [
        ("Sparse infill", 8),
        ("Sparse infill", 9),
        ("Bottom surface", 0),
        ("Internal solid infill", 1),
    ] {
        assert_eq!(
            main_direction(&aligned, feature, layer),
            (main_direction(&plain, feature, layer) + 30) % 180,
            "{feature} {layer}"
        );
    }
    // Unturned, the option changes nothing.
    assert_eq!(
        slice(json!({"align_infill_direction_to_model": true})),
        slice(json!({}))
    );
}

/// Filament (mm of E) of `feature` over the whole print.
fn feature_e(g: &str, feature: &str) -> f64 {
    let (mut f, mut sum) = (String::new(), 0.0);
    for line in g.lines() {
        if let Some(v) = line.strip_prefix(";TYPE:") {
            v.clone_into(&mut f);
        } else if (line.starts_with("G1 X") || line.starts_with("G1 Y")) && f == feature {
            sum += line
                .split_whitespace()
                .find_map(|w| w.strip_prefix('E'))
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|e| *e > 0.0)
                .unwrap_or(0.0);
        }
    }
    sum
}

#[test]
fn optimized_gyroid_keeps_the_filament_and_changes_the_strands() {
    for density in [10, 25] {
        let base = json!({"sparse_infill_pattern": "gyroid", "sparse_infill_density": density});
        let mut opt = base.clone();
        opt["gyroid_optimized"] = json!(true);
        let (plain, tuned) = (slice(base), slice(opt));
        assert_ne!(plain, tuned, "{density}%");
        let (a, b) = (
            feature_e(&plain, "Sparse infill"),
            feature_e(&tuned, "Sparse infill"),
        );
        assert!(
            a > 1.0 && (b / a - 1.0).abs() < 0.12,
            "{density}%: sparse {b} against {a}"
        );
    }
}

/// The 0-based layers that print `feature`.
fn layers_with(g: &str, feature: &str) -> Vec<usize> {
    let (mut f, mut l, mut seen) = (String::new(), 0usize, false);
    let mut out: Vec<usize> = Vec::new();
    for line in g.lines() {
        if sx_core::extras::is_layer_mark(line) {
            if seen {
                l += 1;
            }
            seen = true;
        } else if let Some(v) = line.strip_prefix(";TYPE:") {
            v.clone_into(&mut f);
        } else if f == feature
            && (line.starts_with("G1 X") || line.starts_with("G1 Y"))
            && line.contains(" E")
            && out.last() != Some(&l)
        {
            out.push(l);
        }
    }
    out
}

#[test]
fn infill_combination_prints_sparse_infill_every_few_layers() {
    let base = json!({"layer_height": 0.1, "initial_layer_print_height": 0.2, "top_shell_layers": 6, "bottom_shell_layers": 4});
    let mut on = base.clone();
    on["infill_combination"] = json!(true);
    let (plain, combined) = (slice(base), slice(on));
    let (a, b) = (
        layers_with(&plain, "Sparse infill"),
        layers_with(&combined, "Sparse infill"),
    );
    assert!(b.len() * 3 < a.len(), "sparse on {b:?} against {a:?}");
    let (ea, eb) = (
        feature_e(&plain, "Sparse infill"),
        feature_e(&combined, "Sparse infill"),
    );
    assert!((eb / ea - 1.0).abs() < 0.2, "sparse filament {eb} against {ea}");
    // Capped at the nozzle: four 0.1 mm layers at most.
    assert!(b.windows(2).all(|w| w[1] - w[0] <= 4), "{b:?}");
}
