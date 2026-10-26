// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Objects on one filament with sparse infill moved to another (`sparse_infill_filament_id`), printed layer by layer
//! with ironing: every feature prints on the filament the feature filament settings give it, ironing included, and
//! ironing adds no tool change. On other brands solid infill and top surfaces follow sparse infill, so the top
//! surface filament irons; on Bambu printers they stay on the object's filament. Ironing used to print last on the
//! layer whatever the planned order when one filament ironed, so a layer could end on a filament the next layer did
//! not expect and that layer's walls printed with the wrong one. A layer with no top surface path ironed with the
//! layer's last filament.

mod common;

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;

use sx_core::api::{Mesh, MeshPart, SliceRequest};

/// A 15 mm box of `h` mm on filament 1.
fn block(h: f32) -> Arc<Mesh> {
    let mut positions = Vec::new();
    for z in [0.0, h] {
        for (x, y) in [(0.0, 0.0), (15.0, 0.0), (15.0, 15.0), (0.0, 15.0)] {
            positions.push([x, y, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    Arc::new(Mesh {
        name: "block".into(),
        parts: vec![MeshPart {
            name: "part".into(),
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
        ..Mesh::default()
    })
}

fn at(x: f64) -> Value {
    json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 120, 0, 1])
}

/// Two boxes on filament 1, `a_h` and `b_h` mm tall, sparse infill on filament 2, over `extra` settings.
fn run(a_h: f32, b_h: f32, extra: &Value) -> String {
    let mut c = json!({
        "brim_width": 0,
        "skirt_loops": 0,
        "enable_prime_tower": true,
        "prime_tower_auto_position": "0",
        "wipe_tower_x": ["20"],
        "wipe_tower_y": ["200"],
        "ironing_type": "top",
        "sparse_infill_filament_id": 2,
        "filament_diameter": [1.75, 1.75],
        "change_filament_gcode": "T[next_extruder]",
    });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "a", "name": "a", "mesh": "a", "transform": at(100.0)},
            {"id": "b", "name": "b", "mesh": "b", "transform": at(140.0)},
        ]},
        "config": c,
        "options": {"flavor": "marlin2", "allowCollisions": true},
    }))
    .unwrap();
    let load = move |id: &str| -> sx_core::Result<Arc<Mesh>> { Ok(block(if id == "a" { a_h } else { b_h })) };
    let run = common::run_request(&req, &load).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

fn num(line: &str, axis: char) -> Option<f64> {
    line.split_whitespace()
        .find_map(|w| w.strip_prefix(axis).and_then(|v| v.parse().ok()))
}

/// Every extrusion as (z, feature, active tool). The tool is the last `T<n>` select; None before the first.
fn extrusions(g: &str) -> Vec<(f64, String, Option<u32>)> {
    let (mut tool, mut z, mut feature) = (None, 0.0, String::new());
    let (mut e, mut relative) = (0.0, false);
    let mut out = Vec::new();
    for l in g.lines() {
        if let Some(t) = l.strip_prefix('T').and_then(|t| t.trim().parse::<u32>().ok()) {
            tool = Some(t);
        } else if l.starts_with("M83") {
            relative = true;
        } else if l.starts_with("M82") {
            relative = false;
        } else if let Some(f) = l.strip_prefix(";TYPE:").or_else(|| l.strip_prefix("; FEATURE:")) {
            f.trim().clone_into(&mut feature);
        } else if l.starts_with("G1 ") || l.starts_with("G2 ") || l.starts_with("G3 ") {
            if let Some(v) = num(l, 'Z') {
                z = v;
            }
            let moved = num(l, 'X').is_some() || num(l, 'Y').is_some();
            let Some(ev) = num(l, 'E') else { continue };
            let extrudes = if relative { ev > 0.0 } else { ev > e };
            if !relative {
                e = ev;
            }
            if extrudes && moved {
                out.push((z, feature.clone(), tool));
            }
        } else if l.starts_with("G92") && l.contains("E0") {
            e = 0.0;
        }
    }
    out
}

/// The tool each feature should print with: sparse infill on T1, walls on T0, and solid infill, top and bottom
/// surfaces and ironing on T1 (`follow`) or T0.
fn want(feature: &str, follow: bool) -> Option<u32> {
    match feature {
        "Sparse infill" => Some(1),
        "Inner wall" | "Outer wall" | "Gap infill" => Some(0),
        "Internal solid infill" | "Solid infill" | "Top surface" | "Bottom surface" | "Ironing" => {
            Some(u32::from(follow))
        }
        _ => None,
    }
}

/// Fails on any extrusion printed with a tool other than its feature's, and checks there is ironing.
fn assert_feature_filaments(g: &str, follow: bool, what: &str) {
    let all = extrusions(g);
    let mut bad: BTreeMap<String, usize> = BTreeMap::new();
    let mut n = 0;
    for (z, f, t) in &all {
        let Some(w) = want(f, follow) else { continue };
        n += 1;
        if t.is_some_and(|t| t != w) {
            *bad.entry(format!("z {z:.2} {f} on T{}", t.unwrap_or(0)))
                .or_default() += 1;
        }
    }
    assert!(n > 1000, "{what}: only {n} extrusions found");
    assert!(
        all.iter().any(|(_, f, _)| f == "Ironing"),
        "{what}: nothing ironed"
    );
    assert!(
        bad.is_empty(),
        "{what}: {} layers and features on the wrong filament, first {:?}",
        bad.len(),
        bad.iter().take(5).collect::<Vec<_>>()
    );
}

fn changes(g: &str) -> usize {
    g.lines()
        .filter(|l| l.starts_with('T') && l[1..].trim().parse::<u32>().is_ok())
        .count()
}

#[test]
fn another_brand_keeps_walls_on_their_filament_after_a_top_is_ironed() {
    // Ender 3 V3 style: the top surface follows sparse infill to filament 2 and irons with it. Which filament a layer
    // starts on alternates, so the shorter box's top layer is planned to end on filament 1 at one of these heights.
    for model in ["Creality Ender-3 V3", "Prusa MK4"] {
        for (a_h, b_h) in [(5.0, 20.0), (5.2, 20.0), (20.0, 20.0)] {
            let g = run(a_h, b_h, &json!({"printer_model": model}));
            assert_feature_filaments(&g, true, &format!("{model}, {a_h} and {b_h} mm"));
        }
    }
}

#[test]
fn a_layer_with_no_top_surface_path_irons_with_the_top_surface_filament() {
    // Solid ironing irons layers with no top surface path: the top surface filament irons them, not the filament the
    // layer happens to end on.
    for model in ["Prusa MK4", "Voron 2.4 300"] {
        let g = run(
            5.0,
            20.0,
            &json!({"printer_model": model, "ironing_type": "solid"}),
        );
        assert_feature_filaments(&g, true, &format!("{model}, solid ironing"));
    }
}

#[test]
fn a_bambu_printer_with_sparse_infill_on_another_filament_irons_on_the_objects_filament() {
    for (a_h, b_h, iron) in [(5.0, 20.0, "top"), (5.2, 20.0, "top"), (5.0, 20.0, "solid")] {
        let g = run(
            a_h,
            b_h,
            &json!({"printer_model": "Bambu Lab A1", "ironing_type": iron}),
        );
        assert_feature_filaments(&g, false, &format!("A1, {a_h} and {b_h} mm, {iron}"));
    }
}

#[test]
fn ironing_with_a_feature_filament_adds_no_tool_change() {
    for model in ["Creality Ender-3 V3", "Bambu Lab A1"] {
        for iron in ["top", "solid"] {
            let ironed = run(5.2, 20.0, &json!({"printer_model": model, "ironing_type": iron}));
            let plain = run(
                5.2,
                20.0,
                &json!({"printer_model": model, "ironing_type": "no ironing"}),
            );
            assert_eq!(changes(&ironed), changes(&plain), "{model}, {iron}");
        }
    }
}
