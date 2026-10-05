// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Solid surface options: top and bottom density, extra solid layers, the top and bottom infill to wall
//! overlap, and small area flow compensation.

#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]

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
    let cube = Arc::new(Mesh {
        name: "box".into(),
        parts: vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 4.0])],
    });
    let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "sparse_infill_density": 15});
    cfg.as_object_mut()
        .unwrap()
        .extend(config.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 118,118,0,1]}]},
        "config": cfg,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(cube.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

/// Filament (mm of E) of the extruding moves per feature label on 0-based layer `layer`, or on every layer
/// when `None`. Retractions and the moves back are left out.
fn feature_e(g: &str, feature: &str, layer: Option<usize>) -> f64 {
    let (mut f, mut l, mut sum) = (String::new(), 0usize, 0.0);
    let mut seen = false;
    for line in g.lines() {
        if sx_core::extras::is_layer_mark(line) {
            if seen {
                l += 1;
            }
            seen = true;
        } else if let Some(v) = line.strip_prefix(";TYPE:") {
            v.clone_into(&mut f);
        } else if (line.starts_with("G1 X") || line.starts_with("G1 Y"))
            && f == feature
            && layer.is_none_or(|k| k == l)
            && let Some(e) = line
                .split_whitespace()
                .find_map(|w| w.strip_prefix('E'))
                .and_then(|v| v.parse::<f64>().ok())
            && e > 0.0
        {
            sum += e;
        }
    }
    sum
}

#[test]
fn top_and_bottom_density_spread_the_lines() {
    let full = slice(json!({}));
    let half = slice(json!({"top_surface_density": 50, "bottom_surface_density": 50}));
    let none = slice(json!({"top_surface_density": 0}));
    let (t1, t2) = (
        feature_e(&full, "Top surface", None),
        feature_e(&half, "Top surface", None),
    );
    assert!(t1 > 0.0 && t2 < t1 * 0.62 && t2 > t1 * 0.38, "{t1} {t2}");
    let (b1, b2) = (
        feature_e(&full, "Bottom surface", Some(0)),
        feature_e(&half, "Bottom surface", Some(0)),
    );
    assert!(b2 < b1 * 0.62 && b2 > b1 * 0.38, "{b1} {b2}");
    assert!(feature_e(&none, "Top surface", None) < 1e-9);
}

#[test]
fn extra_solid_infills_turn_the_named_layers_solid() {
    let plain = slice(json!({}));
    // Layer 10 (0-based 9) is sparse in the plain print and solid with the pattern "10".
    let solid = slice(json!({"extra_solid_infills": "10"}));
    assert!(feature_e(&plain, "Sparse infill", Some(9)) > 0.0);
    assert!(feature_e(&solid, "Sparse infill", Some(9)) < 1e-9);
    assert!(feature_e(&solid, "Internal solid infill", Some(9)) > 0.0);
    assert!(
        (feature_e(&plain, "Sparse infill", Some(10)) - feature_e(&solid, "Sparse infill", Some(10))).abs()
            < 1e-6
    );
}

#[test]
fn the_first_and_last_layers_use_their_own_infill_overlap() {
    let a = slice(json!({"top_bottom_infill_wall_overlap": 0}));
    let b = slice(json!({"top_bottom_infill_wall_overlap": 50}));
    // More overlap on the first layer reaches further under the walls; a middle layer does not change.
    assert!(feature_e(&b, "Bottom surface", Some(0)) > feature_e(&a, "Bottom surface", Some(0)));
    assert!((feature_e(&a, "Sparse infill", Some(9)) - feature_e(&b, "Sparse infill", Some(9))).abs() < 1e-6);
}

#[test]
fn small_area_flow_compensation_thins_short_solid_lines() {
    // Every line of the 20 mm box is shorter than 40 mm, so all its solid lines are thinned.
    let model = json!(["0,0.5", "40,1"]);
    let off = slice(json!({"small_area_infill_flow_compensation_model": model}));
    let on = slice(
        json!({"small_area_infill_flow_compensation": true, "small_area_infill_flow_compensation_model": model}),
    );
    let (a, b) = (
        feature_e(&off, "Top surface", None),
        feature_e(&on, "Top surface", None),
    );
    assert!(b < a, "{a} {b}");
    // Sparse infill is never compensated.
    assert!((feature_e(&off, "Sparse infill", None) - feature_e(&on, "Sparse infill", None)).abs() < 1e-6);
    assert_eq!(off, slice(json!({})), "off changes nothing");
}

/// Filament per tool (T0, T1, ...) of the extruding moves, over the whole file.
fn e_per_tool(g: &str) -> Vec<f64> {
    let (mut t, mut out) = (0usize, vec![0.0; 4]);
    for line in g.lines() {
        if let Some(n) = line
            .strip_prefix('T')
            .and_then(|v| v.trim().parse::<usize>().ok())
        {
            t = n.min(3);
        } else if (line.starts_with("G1 X") || line.starts_with("G1 Y"))
            && let Some(e) = line
                .split_whitespace()
                .find_map(|w| w.strip_prefix('E'))
                .and_then(|v| v.parse::<f64>().ok())
            && e > 0.0
            && let Some(slot) = out.get_mut(t)
        {
            *slot += e;
        }
    }
    out
}

#[test]
fn a_segmented_region_width_keeps_paint_near_the_outline() {
    let path = format!("{}/cli/tests/fixtures/painted.3mf", env!("CARGO_MANIFEST_DIR"));
    let mesh = Arc::new(Mesh::load(&std::fs::read(path).unwrap(), "painted.3mf").unwrap());
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "enable_prime_tower": false});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(
            json!({"plate": {"objects": [{"mesh": "p"}]}, "config": cfg, "options": {"flavor": "marlin2"}}),
        )
        .unwrap();
        let m = mesh.clone();
        String::from_utf8(
            common::run_request(&req, &move |_: &str| Ok(m.clone()))
                .unwrap()
                .gcode,
        )
        .unwrap()
    };
    let (full, band) = (
        e_per_tool(&run(json!({}))),
        e_per_tool(&run(json!({"mmu_segmented_region_max_width": 1.0}))),
    );
    let total = |v: &[f64]| v.iter().sum::<f64>();
    // Less of the painted filaments and more of the part's own. The total drops a little: fewer color borders
    // inside the part means fewer walls along them.
    let painted = |v: &[f64]| v.iter().skip(1).sum::<f64>();
    assert!(painted(&band) < painted(&full) * 0.95, "{full:?} {band:?}");
    assert!(band[0] > full[0], "{full:?} {band:?}");
    assert!(
        total(&band) > total(&full) * 0.85 && total(&band) <= total(&full),
        "{full:?} {band:?}"
    );
}

#[test]
fn interface_shells_put_solid_layers_where_filaments_meet() {
    // A 20 mm column, filament 1 up to 4 mm and filament 2 above it.
    let mut lower = cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 4.0]);
    let mut upper = cuboid([0.0, 20.0], [0.0, 20.0], [4.0, 8.0]);
    lower.name = "lower".into();
    upper.name = "upper".into();
    upper.slot = 2;
    let mesh = Arc::new(Mesh {
        name: "column".into(),
        parts: vec![lower, upper],
    });
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "enable_prime_tower": false, "sparse_infill_density": 15});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 118,118,0,1]}]},
            "config": cfg, "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let m = mesh.clone();
        String::from_utf8(
            common::run_request(&req, &move |_: &str| Ok(m.clone()))
                .unwrap()
                .gcode,
        )
        .unwrap()
    };
    let (plain, shells) = (run(json!({})), run(json!({"interface_shells": true})));
    // Layer 20 (0-based 19, top at 4 mm) is the last of filament 1: sparse without, a top surface with.
    assert!(feature_e(&plain, "Top surface", Some(19)) < 1e-9);
    assert!(feature_e(&shells, "Top surface", Some(19)) > 0.0);
    // Layer 21, the first of filament 2, rests on filament 1: solid with the option (no bridge), sparse without.
    assert!(
        feature_e(&shells, "Internal solid infill", Some(20))
            > feature_e(&plain, "Internal solid infill", Some(20))
    );
    assert!(feature_e(&shells, "Bridge", Some(20)) < 1e-9);
}
