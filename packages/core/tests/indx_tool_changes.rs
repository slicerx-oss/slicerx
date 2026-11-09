// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A two-color plate on the Prusa Core One with INDX as `SlicerX` ships the printer (packages/profiles/machine.json and
//! its G-code family): eight tools listed, two used. Every color change is a tool change on our own change G-code (`T`
//! and a wait for the new tool's temperature), never a manual `M600` swap, and the estimate counts the profile's 12 s
//! per change.

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, MeshPart, SliceRequest, SliceRun};

fn cuboid(left: f32, front: f32, slot: u8) -> MeshPart {
    let (side, height) = (14.0, 2.0);
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

/// The shipped INDX machine settings and G-code, with two PLA filaments, over `extra`.
fn indx_config(extra: &Value) -> Value {
    let read = |file: &str| -> Value {
        let path = format!("{}/../profiles/{file}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    };
    let (machine, gcode) = (read("machine.json"), read("gcode.json"));
    let mut c = machine["models"]["prusa-core-one-indx"]["machine"].clone();
    let family = &gcode["families"][gcode["models"]["prusa-core-one-indx"].as_str().unwrap()];
    for (key, part) in [
        ("machine_start_gcode", "start"),
        ("machine_end_gcode", "end"),
        ("change_filament_gcode", "changeFilament"),
        ("before_layer_change_gcode", "beforeLayerChange"),
        ("layer_change_gcode", "layerChange"),
    ] {
        c[key] = family[part].clone();
    }
    let m = c.as_object_mut().unwrap();
    for (k, v) in [
        ("printer_model", json!("Prusa Core One INDX")),
        ("brim_width", json!(0)),
        ("filament_type", json!(["PLA", "PLA"])),
        ("filament_colour", json!(["#FF0000", "#0000FF"])),
        ("nozzle_temperature", json!([215, 220])),
        ("nozzle_temperature_initial_layer", json!([220, 225])),
    ] {
        m.insert(k.into(), v);
    }
    for (k, v) in extra.as_object().into_iter().flatten() {
        m.insert(k.clone(), v.clone());
    }
    c
}

/// Two 14 mm blocks, 2 mm tall, one per filament, sliced on the Core One INDX with `extra` settings.
fn two_colors(extra: &Value) -> SliceRun {
    let names = ["red", "blue"];
    let objects: Vec<Value> = names
        .iter()
        .map(|n| json!({"id": n, "name": n, "mesh": n, "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]}))
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": indx_config(extra),
        "options": {"printerId": "prusa-core-one-indx", "emitGcode": true},
    }))
    .unwrap();
    let load = move |name: &str| {
        let i = names.iter().position(|n| *n == name).unwrap();
        #[allow(clippy::cast_precision_loss, reason = "two blocks")]
        let x = 100.0 + i as f32 * 30.0;
        Ok(Arc::new(Mesh {
            name: name.into(),
            parts: vec![cuboid(x, 90.0, u8::try_from(i + 1).unwrap())],
            ..Mesh::default()
        }))
    };
    common::run_request(&req, &load).unwrap()
}

/// The tool commands of the G-code (`T0`, `T1`, ...), in order, with comments stripped.
fn tools(text: &str) -> Vec<u32> {
    text.lines()
        .filter_map(|l| l.split(';').next()?.trim().strip_prefix('T')?.parse().ok())
        .collect()
}

#[test]
fn a_two_color_indx_plate_changes_tools_on_our_change_gcode_with_no_manual_swap() {
    let run = two_colors(&json!({}));
    let text = String::from_utf8_lossy(&run.gcode);
    assert!(
        !text
            .lines()
            .any(|l| l.split(';').next().unwrap_or("").trim().starts_with("M600")),
        "a manual swap in the G-code"
    );
    let t = tools(&text);
    // The start picks the first tool; then the two tools alternate, one change per layer or more.
    assert_eq!(t.first(), Some(&0), "{t:?}");
    assert!(
        t.iter().all(|&n| n < 2),
        "only the two tools the plate uses: {t:?}"
    );
    let changes = t.windows(2).filter(|w| w[0] != w[1]).count();
    assert!(changes >= 8, "{changes} changes: {t:?}");
    // Each change is our change G-code: the comment, then T, then the wait for the new tool's temperature.
    let ours = text
        .matches("; Tool change: the firmware parks the tool in the head")
        .count();
    assert_eq!(ours, run.report.stats.tool_changes as usize);
    for tool in 0..2 {
        assert!(
            text.contains(&format!("\nT{tool}\nM109 T{tool} S")),
            "T{tool} without its temperature wait"
        );
    }
    // The first layer waits for the first layer temperature of the new tool, later layers for the print temperature.
    assert!(text.contains("M109 T1 S225"));
    assert!(text.contains("M109 T1 S220"));
    // Single tool settings would have made it one extruder with manual swaps.
    assert_eq!(run.report.stats.tool_changes as usize, changes);
}

#[test]
fn each_indx_change_takes_the_profile_change_time() {
    let stock = two_colors(&json!({}));
    let none = two_colors(&json!({"machine_tool_change_time": 0}));
    let changes = stock.report.stats.tool_changes;
    assert!(changes >= 8, "{changes} changes");
    assert_eq!(none.report.stats.tool_changes, changes);
    let added = stock.report.stats.time_s - none.report.stats.time_s;
    assert!(
        (added - 12.0 * f64::from(changes)).abs() < 1.0,
        "{added} s added for {changes} changes"
    );
}
