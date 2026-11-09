// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A two-color plate on the Sovol SV04 as `SlicerX` ships the printer (packages/profiles/machine.json and its G-code
//! family): two independent carriages in the firmware's auto-park mode. Every color change is a `T0`/`T1` tool
//! change that waits for the new tool's temperature, never an `M600` manual swap, and the start heats both nozzles.

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, MeshPart, SliceRequest, SliceRun};

fn cuboid(left: f32, front: f32, slot: u8) -> MeshPart {
    let (side, height) = (12.0, 3.0);
    let (right, back) = (left + side, front + side);
    let mut positions = Vec::new();
    for z in [0.0, height] {
        for (px, py) in [(left, front), (right, front), (right, back), (left, back)] {
            positions.push([px, py, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    MeshPart {
        name: format!("block {slot}"),
        slot,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint: Vec::new(),
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
        paint_texts: Vec::new(),
    }
}

/// The shipped SV04 machine settings and G-code, with `filaments` filaments printing at their own temperatures.
fn sv04_config(filaments: usize) -> Value {
    let read = |file: &str| -> Value {
        let path = format!("{}/../profiles/{file}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    };
    let (machine, gcode) = (read("machine.json"), read("gcode.json"));
    let mut c = machine["models"]["sovol-sv04"]["machine"].clone();
    let family = &gcode["families"][gcode["models"]["sovol-sv04"].as_str().unwrap()];
    for (key, part) in [
        ("machine_start_gcode", "start"),
        ("machine_end_gcode", "end"),
        ("change_filament_gcode", "changeFilament"),
        ("before_layer_change_gcode", "beforeLayerChange"),
        ("layer_change_gcode", "layerChange"),
    ] {
        c[key] = family[part].clone();
    }
    let take = |v: [Value; 2]| Value::Array(v.into_iter().take(filaments).collect());
    let m = c.as_object_mut().unwrap();
    for (k, v) in [
        ("printer_model", json!("Sovol SV04")),
        ("brim_width", json!(0)),
        ("filament_type", take([json!("PLA"), json!("PETG")])),
        ("filament_colour", take([json!("#FF0000"), json!("#0000FF")])),
        ("nozzle_temperature_initial_layer", take([json!(215), json!(240)])),
        ("nozzle_temperature", take([json!(210), json!(235)])),
    ] {
        m.insert(k.into(), v);
    }
    c
}

/// A 12 mm block per filament, 3 mm tall, side by side, sliced on the SV04.
fn plate(filaments: usize) -> SliceRun {
    let names = ["red", "blue"];
    let objects: Vec<Value> = names
        .iter()
        .take(filaments)
        .map(|n| json!({"id": n, "name": n, "mesh": n, "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]}))
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": sv04_config(filaments),
        "options": {"printerId": "sovol-sv04", "emitGcode": true},
    }))
    .unwrap();
    let load = move |name: &str| {
        let i = names.iter().position(|n| *n == name).unwrap();
        #[allow(clippy::cast_precision_loss, reason = "two blocks")]
        let x = 130.0 + i as f32 * 30.0;
        Ok(Arc::new(Mesh {
            name: name.into(),
            parts: vec![cuboid(x, 140.0, u8::try_from(i + 1).unwrap())],
            ..Mesh::default()
        }))
    };
    common::run_request(&req, &load).unwrap()
}

/// The G-code part of a line, without its comment.
fn code(line: &str) -> &str {
    line.split(';').next().unwrap_or("").trim()
}

/// The tool a bare `T<n>` line selects.
fn tool(line: &str) -> Option<u32> {
    code(line).strip_prefix('T')?.parse().ok()
}

#[test]
fn a_two_color_sv04_plate_changes_tools_and_waits_for_the_new_tools_temperature() {
    let run = plate(2);
    let text = String::from_utf8_lossy(&run.gcode);
    let lines: Vec<&str> = text.lines().collect();
    assert!(!lines.iter().any(|l| code(l).starts_with("M600")), "an M600 swap");
    assert!(!text.contains("MANUAL_TOOL_CHANGE"));

    // The start heats both nozzles to their first layer temperatures and waits for both, before the first layer.
    let first_layer = lines.iter().position(|l| l.starts_with(";LAYER_CHANGE")).unwrap();
    let start = &lines[..first_layer];
    for heat in ["M104 T0 S215", "M104 T1 S240", "M109 T0 S215", "M109 T1 S240"] {
        assert!(start.iter().any(|l| code(l) == heat), "no {heat} in the start");
    }

    // Every change in the print selects the new tool and then waits for its temperature: the first layer one on
    // the first layer, the print temperature above it.
    let mut layer = 0usize;
    let mut changes = [0usize; 2];
    let mut active = None;
    for (i, l) in lines.iter().enumerate().skip(first_layer) {
        if l.starts_with(";LAYER_CHANGE") {
            layer += 1;
        }
        let Some(t) = tool(l) else { continue };
        if active.is_some_and(|a| a != t) {
            changes[t as usize] += 1;
            let temps = if layer <= 1 { [215, 240] } else { [210, 235] };
            let wait = format!("M109 T{t} S{}", temps[t as usize]);
            assert_eq!(code(lines[i + 1]), wait, "after the change at line {}", i + 1);
        }
        active = Some(t);
    }
    assert!(
        changes[0] >= 2 && changes[1] >= 2,
        "{changes:?} changes to T0 and T1"
    );
    assert!(run.report.stats.tool_changes >= 4);
}

#[test]
fn a_one_color_sv04_plate_never_heats_or_selects_the_second_tool() {
    let run = plate(1);
    let text = String::from_utf8_lossy(&run.gcode);
    assert!(!text.lines().any(|l| code(l).starts_with("M600")));
    for l in text.lines() {
        assert_ne!(tool(l), Some(1), "T1 selected");
        let c = code(l);
        if (c.starts_with("M104") || c.starts_with("M109")) && c.contains(" T1") {
            assert!(c.ends_with(" S0"), "second nozzle heated: {l}");
        }
    }
    assert_eq!(run.report.stats.tool_changes, 0);
}
