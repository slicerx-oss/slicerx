// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Printers with more than one nozzle or tool head: which nozzle prints each filament, what a change flushes,
//! and what the prime tower takes for it, against the maker's own slicer on the same kind of plate.
//!
//! The reference numbers are the prime tower's filament and print time per layer that each maker's slicer wrote
//! for two objects, one per filament, with a tool change on every layer (0.2 mm layers, layers 20 to 400 of a
//! 427 layer print, the time as the moves' length over their feed rate, as Preview counts it):
//!
//! | Printer | Reference slicer | mm3 per layer | seconds per layer |
//! | --- | --- | --- | --- |
//! | Bambu Lab H2D, H2C | Bambu Studio 2.8.2 | 49.96 | 6.64 |
//! | Snapmaker U1 | `OrcaSlicer` 2.4.2 | 26.09 | 5.19 |
//! | Prusa XL 5T | `PrusaSlicer` 2.9.6 | 39.94 | 4.36 |
//!
//! Each machine is set up here with the reference slicer's own filament and tower values where our profile
//! data differs (Bambu PLA Basic's prime volumes, Prusament PLA's ramming), so the comparison is of the
//! engines, not of the data.
use std::sync::Arc;

use serde_json::{Value, json};
use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

fn cuboid(x: [f32; 2], y: [f32; 2], z: [f32; 2], slot: u8) -> Mesh {
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
    Mesh {
        name: "box".into(),
        parts: vec![MeshPart {
            name: "box".into(),
            slot,
            color: None,
            positions,
            triangles,
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
        }],
    }
}

/// The reference slicer's values for the machine, over the shipped profile.
fn as_reference(id: &str) -> Value {
    let common = json!({
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "filament_type": ["PLA", "PLA"],
        "filament_colour": ["#FF6A13", "#0A2989"],
        "enable_prime_tower": true,
        "prime_tower_auto_position": true,
        "enable_support": false,
        "brim_width": 0,
    });
    let nc = if id == "bambu-h2d" { 60 } else { 30 };
    let own = match id {
        // Bambu Studio 2.8.2: Bambu PLA Basic @BBL H2D and H2C, 0.20mm Standard.
        "bambu-h2d" | "bambu-h2c" => json!({
            "filament_prime_volume": [30, 30],
            "filament_prime_volume_nc": [nc, nc],
            "filament_change_length": [4, 4],
            "filament_change_length_nc": [4, 4],
            "filament_max_volumetric_speed": [25, 25],
            "flush_volumes_matrix": [0, 306, 618, 0, 0, 321, 633, 0],
            "flush_multiplier": 1,
            "prime_tower_width": 60,
            "wipe_tower_wall_type": "rib",
            "prime_tower_brim_width": -1,
            "purge_in_prime_tower": false,
            "inner_wall_speed": [300, 300],
            "sparse_infill_speed": [350, 350],
            "initial_layer_speed": [50, 50],
        }),
        // OrcaSlicer 2.4.2: Snapmaker U1 (0.4 nozzle), Snapmaker PLA @U1, 0.20 Standard.
        "snapmaker-u1" => json!({
            "prime_volume": 30,
            "prime_tower_width": 35,
            "filament_minimal_purge_on_wipe_tower": [0, 0],
            "filament_multitool_ramming": [false, false],
            "flush_volumes_matrix": [0, 289, 469, 0],
            "sparse_infill_speed": [270],
            "inner_wall_speed": [300],
            "wipe_tower_max_purge_speed": 90,
        }),
        // PrusaSlicer 2.9.6: Original Prusa XL - 5T 0.4 nozzle, Prusament PLA @XL, 0.20mm QUALITY @XL 0.4.
        _ => json!({
            "prime_tower_width": 60,
            "filament_minimal_purge_on_wipe_tower": [15, 15],
            "filament_multitool_ramming": [true, true],
            "filament_multitool_ramming_volume": [10, 10],
            "filament_multitool_ramming_flow": [40, 40],
            "flush_volumes_matrix": [0, 146, 326, 0],
            "sparse_infill_speed": [200],
            "inner_wall_speed": [65],
        }),
    };
    let mut v = common;
    if let (Some(dst), Value::Object(src)) = (v.as_object_mut(), own) {
        dst.extend(src);
    }
    v
}

/// Two 20 mm boxes, one per filament, `height` mm tall, on the machine's bed with its shipped profile and
/// `extra` over the reference values.
fn slice(id: &str, height: f32, extra: &Value) -> (String, api::SliceReport) {
    let profile = sx_settings::printer_profile(id).expect("a printer profile");
    let sx_settings::BuildVolume::Rectangular { x, y, z } = profile.build_volume else {
        panic!("a rectangular bed")
    };
    let mut cfg = sx_settings::profile_config(id, None, Some("pla"), Some("standard"))
        .expect("a profile config")
        .to_json();
    for src in [as_reference(id), extra.clone()] {
        if let (Some(dst), Value::Object(src)) = (cfg.as_object_mut(), src) {
            dst.extend(src);
        }
    }
    #[allow(clippy::cast_possible_truncation, reason = "bed sizes fit f32")]
    let (cx, cy) = ((x / 2.0) as f32, (y / 2.0) as f32);
    let a = Arc::new(cuboid(
        [cx - 25.0, cx - 5.0],
        [cy - 10.0, cy + 10.0],
        [0.0, height],
        1,
    ));
    let b = Arc::new(cuboid(
        [cx + 5.0, cx + 25.0],
        [cy - 10.0, cy + 10.0],
        [0.0, height],
        2,
    ));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {
            "bed": {"widthMm": x, "depthMm": y, "heightMm": z},
            "objects": [
                {"id": "a", "name": "a", "mesh": "a", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]},
                {"id": "b", "name": "b", "mesh": "b", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]},
            ],
        },
        "config": cfg,
        "options": {"trustedGcode": true},
    }))
    .expect("a request");
    let run = api::run_request(&req, &move |m: &str| {
        Ok(if m == "a" { a.clone() } else { b.clone() })
    })
    .expect("a slice");
    (String::from_utf8(run.gcode).expect("text"), run.report)
}

/// The prime tower's filament (mm3, 1.75 mm filament) and its moves' time (s, extruding moves, length over
/// feed rate) summed over layers `from` up to `to`.
fn tower(gcode: &str, from: usize, to: usize) -> (f64, f64) {
    let area = std::f64::consts::PI * 0.875f64.powi(2);
    let (mut layer, mut on, mut rel) = (0usize, false, false);
    let (mut x, mut y, mut e_at, mut feed) = (0.0f64, 0.0f64, 0.0f64, 3000.0f64);
    let (mut volume, mut time) = (0.0, 0.0);
    for line in gcode.lines() {
        let text = line.trim();
        // bambu lab printers get orca's processor tags (`; CHANGE_LAYER`, `; FEATURE: `)
        if text.starts_with(";LAYER_CHANGE") || text.starts_with("; CHANGE_LAYER") {
            layer += 1;
            continue;
        }
        if let Some(kind) = text
            .strip_prefix(";TYPE:")
            .or_else(|| text.strip_prefix("; FEATURE: "))
        {
            on = kind.trim() == "Prime tower";
            continue;
        }
        let code = text.split(';').next().unwrap_or("").trim();
        let mut words = code.split_ascii_whitespace();
        let Some(cmd) = words.next() else { continue };
        match cmd {
            "M83" => rel = true,
            "M82" => rel = false,
            "G92" => {
                for word in words {
                    if let Some(val) = word.strip_prefix('E').and_then(|v| v.parse::<f64>().ok()) {
                        e_at = val;
                    }
                }
            }
            "G0" | "G1" | "G2" | "G3" => {
                let (mut nx, mut ny, mut de) = (x, y, 0.0);
                for word in words {
                    let (key, val) = word.split_at(1);
                    let Ok(val) = val.parse::<f64>() else { continue };
                    match key {
                        "X" => nx = val,
                        "Y" => ny = val,
                        "E" => {
                            de = if rel { val } else { val - e_at };
                            if !rel {
                                e_at = val;
                            }
                        }
                        "F" => feed = val,
                        _ => {}
                    }
                }
                let dist = (nx - x).hypot(ny - y);
                if on && (from..to).contains(&layer) && de > 0.0 && dist > 0.0 {
                    volume += de * area;
                    time += dist / (feed / 60.0);
                }
                (x, y) = (nx, ny);
            }
            _ => {}
        }
    }
    (volume, time)
}

/// The tower per layer over the middle of a 12 mm print (layers 10 to 50), against the reference's per layer
/// numbers: each within 10 percent.
fn per_layer_near(id: &str, reference: (f64, f64)) {
    let (g, report) = slice(id, 12.0, &json!({}));
    assert!(
        report.stats.tool_changes >= 55,
        "{id}: {} changes",
        report.stats.tool_changes
    );
    let (volume, time) = tower(&g, 10, 50);
    let (v, t) = (volume / 40.0, time / 40.0);
    let near = |a: f64, b: f64| (a - b).abs() <= 0.1 * b;
    assert!(
        near(v, reference.0),
        "{id}: {v:.1} mm3 a layer against {:.1}",
        reference.0
    );
    assert!(
        near(t, reference.1),
        "{id}: {t:.2} s a layer against {:.2}",
        reference.1
    );
}

#[test]
fn the_h2d_tower_is_bambu_studios() {
    per_layer_near("bambu-h2d", (49.96, 6.64));
}

#[test]
fn the_h2c_tower_is_bambu_studios() {
    per_layer_near("bambu-h2c", (49.96, 6.64));
}

#[test]
fn the_u1_tower_is_orcas() {
    per_layer_near("snapmaker-u1", (26.09, 5.19));
}

#[test]
fn the_xl_tower_is_prusaslicers() {
    per_layer_near("prusa-xl-5-toolhead", (39.94, 4.36));
}

/// The flush lengths the H2D's change G-code hands the firmware (`M620.10 A1 ... L<mm>`).
fn flushes(g: &str) -> Vec<f64> {
    g.lines()
        .filter(|l| l.starts_with("M620.10 A1"))
        .filter_map(|l| {
            l.split_ascii_whitespace()
                .find_map(|w| w.strip_prefix('L'))
                .and_then(|v| v.parse().ok())
        })
        .collect()
}

#[test]
fn the_h2d_maps_each_filament_to_a_nozzle_and_flushes_nothing_on_a_switch() {
    // Auto: Bambu Studio's "2 1" for this plate, filament 1 on the right (master) nozzle.
    let (g, report) = slice("bambu-h2d", 4.0, &json!({}));
    let map = report.filament_map.expect("a filament map");
    assert_eq!(map.extruders, vec![2, 1]);
    assert!(map.auto);
    assert!(
        g.lines().any(|l| l == "; filament_map = 2,1"),
        "the configuration block lists the map"
    );
    let f = flushes(&g);
    assert!(f.len() >= 15, "{} changes", f.len());
    assert!(
        f.iter().all(|&l| l == 0.0),
        "each nozzle keeps its filament: {f:?}"
    );
    // Manual: both on the left nozzle, an AMS swap every layer, each flushing the matrix volume.
    let (g, report) = slice(
        "bambu-h2d",
        4.0,
        &json!({"filament_map_mode": "Manual", "filament_map": [1, 1]}),
    );
    let map = report.filament_map.expect("a filament map");
    assert_eq!(map.extruders, vec![1, 1]);
    assert!(!map.auto);
    let f = flushes(&g);
    assert!(f.iter().skip(1).all(|&l| l > 100.0), "an AMS swap flushes: {f:?}");
}

#[test]
fn the_h2c_rack_swaps_hotends_without_flushing() {
    // Both filaments on the right extruder: each takes a hotend of its own from the rack.
    let (g, report) = slice(
        "bambu-h2c",
        4.0,
        &json!({"filament_map_mode": "Manual", "filament_map": [2, 2], "extruder_max_nozzle_count": [1, 6]}),
    );
    let map = report.filament_map.expect("a filament map");
    assert_eq!(map.extruders, vec![2, 2]);
    assert_eq!(map.nozzles, vec![1, 2]);
    assert!(flushes(&g).iter().all(|&l| l == 0.0));
}

#[test]
fn the_u1_and_the_xl_change_heads_with_the_tool_command() {
    for id in ["snapmaker-u1", "prusa-xl-5-toolhead"] {
        let (g, report) = slice(id, 4.0, &json!({}));
        assert!(
            report.filament_map.is_none(),
            "{id}: one head per filament, no map"
        );
        let tools: Vec<&str> = g
            .lines()
            .filter(|l| l.starts_with("T0") || l.starts_with("T1"))
            .collect();
        assert!(tools.len() >= 15, "{id}: {} tool commands", tools.len());
        // One head per filament: no flush, the prime only.
        assert!(!g.contains("M620.10"), "{id}");
    }
}
