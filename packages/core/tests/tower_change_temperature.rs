// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A single nozzle that several filaments share heats to the new filament's temperature at each tool change: a
//! `G4 S0` and a plain `M104 S<t>` (no tool, no wait) before the change, t the new filament's temperature for the
//! layer (its first layer temperature on the first layer), written when it differs from the temperature the nozzle
//! was last set to. Filaments that share a temperature write nothing new.
//!
//! 15 mm boxes on an MK4 with the MMU and a 60 mm type 2 tower: A 8 mm tall on filament 1 and B 3 mm on filament 2,
//! so every layer up to 3 mm changes filament once.

#![allow(clippy::disallowed_methods, reason = "test geometry, not engine output")]

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

/// An ASCII STL of a box from the origin to `size`.
fn box_stl(size: [f64; 3]) -> Vec<u8> {
    use std::fmt::Write as _;
    let corner = |index: usize| {
        std::array::from_fn::<f64, 3, _>(|axis| if index >> axis & 1 == 0 { 0.0 } else { size[axis] })
    };
    let faces: [[usize; 3]; 12] = [
        [0, 2, 1],
        [1, 2, 3],
        [4, 5, 6],
        [5, 7, 6],
        [0, 1, 4],
        [1, 5, 4],
        [2, 6, 3],
        [3, 6, 7],
        [0, 4, 2],
        [2, 4, 6],
        [1, 3, 5],
        [3, 7, 5],
    ];
    let mut text = String::from("solid box\n");
    for face in faces {
        text.push_str(" facet normal 0 0 0\n  outer loop\n");
        for index in face {
            let [x, y, z] = corner(index);
            let _ = writeln!(text, "   vertex {x} {y} {z}");
        }
        text.push_str("  endloop\n endfacet\n");
    }
    text.push_str("endsolid box\n");
    text.into_bytes()
}

/// An MK4 with the MMU, two filaments and a 60 mm type 2 tower, with ramming on; `extra` over it.
fn mmu(extra: &[(&str, Value)]) -> Value {
    let bench: Value = serde_json::from_slice(
        &std::fs::read(format!(
            "{}/bench/configs/reference-0.20.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    let mut cfg = bench["config"].clone();
    let ram = "250 100 40 40 40 40 40 | 0.05 40 0.45 40 0.95 40 1.45 40 1.95 40 2.45 40 2.95 40 3.45 40";
    for (k, v) in [
        ("printer_model", json!("Prusa MK4")),
        ("wipe_tower_type", json!("type2")),
        ("single_extruder_multi_material", json!("1")),
        ("use_relative_e_distances", json!("1")),
        ("printable_area", json!(["0x0", "250x0", "250x210", "0x210"])),
        ("filament_diameter", json!(["1.75", "1.75"])),
        ("filament_colour", json!(["#F4EE2A", "#00AE42"])),
        ("wipe_tower_x", json!(["20"])),
        ("wipe_tower_y", json!(["140"])),
        ("prime_tower_width", json!("60")),
        ("enable_prime_tower", json!(true)),
        ("flush_volumes_matrix", json!(["0", "280", "280", "0"])),
        ("flush_multiplier", json!(["0.3"])),
        ("enable_filament_ramming", json!("1")),
        ("filament_ramming_parameters", json!([ram, ram])),
    ] {
        cfg[k] = v;
    }
    for (k, v) in extra {
        cfg[*k] = v.clone();
    }
    cfg
}

/// The G-code of box A (8 mm, filament 1) and box B (3 mm, filament 2) with `cfg`.
#[allow(clippy::needless_pass_by_value, reason = "the callers hand over fresh values")]
fn slice(cfg: Value) -> String {
    let objects: Vec<Value> = [(8.0, 102.5, 1), (3.0, 132.5, 2)]
        .iter()
        .enumerate()
        .map(|(k, &(h, x, slot))| {
            json!({"id": format!("o{k}"), "name": format!("box {k}"), "mesh": format!("15 15 {h}"),
                   "slotOverrides": {"box": slot, "box.stl": slot, "": slot},
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x - 7.5, 95, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": 250, "depthMm": 210, "heightMm": 220}, "objects": objects},
        "config": cfg,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let load = |id: &str| -> sx_core::Result<Arc<Mesh>> {
        let s: Vec<f64> = id.split(' ').map(|v| v.parse().unwrap()).collect();
        Ok(Arc::new(
            Mesh::load(&box_stl([s[0], s[1], s[2]]), "box.stl").unwrap(),
        ))
    };
    let run = api::run_request(&req, &load).unwrap();
    String::from_utf8_lossy(&run.gcode).into_owned()
}

/// One tool change: its layer (1 for the first), the filament it loads (1-based), the nozzle temperature lines
/// written since the last bead before it, and the nozzle temperature in effect at the `T` (the last `M104` or
/// `M109` written anywhere before it; a `T` parameter does not pick another heater on a single nozzle).
#[derive(Debug)]
struct Change {
    layer: usize,
    to: u8,
    lines: Vec<String>,
    nozzle: Option<i64>,
}

fn changes(gcode: &str) -> Vec<Change> {
    let (mut out, mut layer, mut nozzle, mut tool) = (Vec::new(), 0usize, None, None);
    let mut since: Vec<String> = Vec::new();
    for line in gcode.lines() {
        let s = line.trim();
        if s.starts_with(";LAYER_CHANGE") {
            layer += 1;
            continue;
        }
        let body = s.split(';').next().unwrap_or("").trim();
        if body.starts_with("M104 ") || body.starts_with("M109 ") || body == "G4 S0" {
            since.push(body.to_owned());
            if let Some(t) = body
                .split_whitespace()
                .find_map(|w| w.strip_prefix('S'))
                .filter(|_| !body.starts_with("G4"))
            {
                nozzle = t.parse::<i64>().ok();
            }
            continue;
        }
        // A bead (its feed set on a line of its own); the change's own filament moves carry their feed.
        if body.starts_with("G1 ")
            && body
                .split_whitespace()
                .any(|w| w.starts_with('E') && !w.starts_with("E-"))
            && !body.split_whitespace().any(|w| w.starts_with('F'))
        {
            since.clear();
            continue;
        }
        if let Some(t) = body.strip_prefix('T').and_then(|t| t.parse::<u8>().ok()) {
            if layer > 0 && tool.is_some_and(|was| was != t) {
                out.push(Change {
                    layer,
                    to: t + 1,
                    lines: std::mem::take(&mut since),
                    nozzle,
                });
            }
            tool = Some(t);
            since.clear();
        }
    }
    out
}

/// Plain `M104` lines (no tool, no wait) of a change.
fn plain_sets(c: &Change) -> Vec<&str> {
    c.lines
        .iter()
        .map(String::as_str)
        .filter(|l| l.starts_with("M104 ") && !l.contains(" T"))
        .collect()
}

#[test]
fn a_shared_nozzle_heats_to_the_new_filaments_temperature_at_each_change() {
    let temps = [
        ("nozzle_temperature", json!(["220", "228"])),
        ("nozzle_temperature_initial_layer", json!(["212", "225"])),
    ];
    for ram in ["1", "0"] {
        let mut extra = temps.to_vec();
        extra.push(("enable_filament_ramming", json!(ram)));
        let all = changes(&slice(mmu(&extra)));
        assert!(all.len() >= 10, "ramming {ram}: {} changes", all.len());
        let want = |c: &Change| match (c.layer, c.to) {
            (1, 1) => 212,
            (1, _) => 225,
            (_, 1) => 220,
            _ => 228,
        };
        // The first change of the print, on layer 1: filament 2 at its own first layer temperature.
        let first = &all[0];
        assert_eq!(first.layer, 1, "ramming {ram}: {first:?}");
        assert_eq!(plain_sets(first), ["M104 S225"], "ramming {ram}: {first:?}");
        for c in &all {
            assert_eq!(c.nozzle, Some(want(c)), "ramming {ram}: {c:?}");
            // Each new line follows a `G4 S0`, so it does not take effect while the old filament still prints.
            for (i, l) in c.lines.iter().enumerate() {
                if l.starts_with("M104 ") && !l.contains(" T") {
                    assert_eq!(
                        c.lines.get(i.wrapping_sub(1)).map(String::as_str),
                        Some("G4 S0"),
                        "{c:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn filaments_that_share_a_temperature_write_no_line_at_a_change() {
    for extra in [
        vec![("nozzle_temperature", json!(["220", "220"]))],
        vec![
            ("nozzle_temperature", json!(["220", "220"])),
            ("nozzle_temperature_initial_layer", json!(["215", "215"])),
        ],
    ] {
        let all = changes(&slice(mmu(&extra)));
        assert!(all.len() >= 10, "{} changes", all.len());
        for c in &all {
            assert!(plain_sets(c).is_empty(), "{extra:?}: {c:?}");
        }
    }
}

#[test]
fn a_tool_changer_writes_no_shared_nozzle_line() {
    let cfg = mmu(&[
        ("single_extruder_multi_material", json!("0")),
        ("nozzle_diameter", json!(["0.4", "0.4"])),
        ("nozzle_temperature", json!(["220", "228"])),
        ("nozzle_temperature_initial_layer", json!(["212", "225"])),
    ]);
    let all = changes(&slice(cfg));
    assert!(!all.is_empty());
    for c in &all {
        assert!(plain_sets(c).is_empty(), "{c:?}");
    }
}
