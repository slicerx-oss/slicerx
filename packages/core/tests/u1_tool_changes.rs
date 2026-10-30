// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A four-color plate on the Snapmaker U1 as `SlicerX` ships the printer (packages/profiles/machine.json and its
//! G-code): four heads, one filament each, no filament map. Every change parks one head in the dock and picks up
//! another, which the estimate counts at the printer's tool change time, and with ooze prevention every parked head
//! gets its standby cooldown and is preheated only once it is parked.

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

/// The shipped U1 machine settings and G-code, with the standard process's ooze prevention (standby 150 C below
/// the print temperature, 30 s preheat) and a prime tower, over `extra`.
fn u1_config(extra: &Value) -> Value {
    let read = |file: &str| -> Value {
        let path = format!("{}/../profiles/{file}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    };
    let (machine, gcode) = (read("machine.json"), read("gcode.json"));
    let mut c = machine["models"]["snapmaker-u1"]["machine"].clone();
    let family = &gcode["families"][gcode["models"]["snapmaker-u1"].as_str().unwrap()];
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
        ("printer_model", json!("Snapmaker U1")),
        ("ooze_prevention", json!(1)),
        ("standby_temperature_delta", json!(-150)),
        ("preheat_time", json!(30)),
        ("enable_prime_tower", json!(1)),
        ("brim_width", json!(0)),
        ("filament_type", json!(["PLA", "PLA", "PLA", "PLA"])),
        (
            "filament_colour",
            json!(["#FF0000", "#00FF00", "#0000FF", "#FFFF00"]),
        ),
        ("nozzle_temperature", json!([220, 220, 220, 220])),
        ("nozzle_temperature_initial_layer", json!([220, 220, 220, 220])),
    ] {
        m.insert(k.into(), v);
    }
    for (k, v) in extra.as_object().into_iter().flatten() {
        m.insert(k.clone(), v.clone());
    }
    c
}

/// Four 12 mm blocks, 3 mm tall, one per filament, sliced on the U1 with `extra` settings.
fn four_colors(extra: &Value) -> SliceRun {
    four_colors_with(extra, true)
}

/// [`four_colors`], with the G-code written or only the estimate (`gcode`).
fn four_colors_with(extra: &Value, gcode: bool) -> SliceRun {
    let names = ["red", "green", "blue", "yellow"];
    let objects: Vec<Value> = names
        .iter()
        .map(|n| json!({"id": n, "name": n, "mesh": n, "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]}))
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": u1_config(extra),
        "options": {"printerId": "snapmaker-u1", "emitGcode": gcode},
    }))
    .unwrap();
    let load = move |name: &str| {
        let i = names.iter().position(|n| *n == name).unwrap();
        #[allow(clippy::cast_precision_loss, reason = "four blocks")]
        let (x, y) = (110.0 + (i % 2) as f32 * 30.0, 110.0 + (i / 2) as f32 * 30.0);
        Ok(Arc::new(Mesh {
            name: name.into(),
            parts: vec![cuboid(x, y, u8::try_from(i + 1).unwrap())],
            ..Mesh::default()
        }))
    };
    common::run_request(&req, &load).unwrap()
}

#[test]
fn each_change_of_a_four_color_u1_plate_takes_the_tool_change_time() {
    // One nozzle listed per head, and one for all four as the app's settings give it; with the G-code written
    // (the time of the finished file) and for the estimate alone (the layers' own times).
    for (nozzles, gcode) in [
        (json!([0.4, 0.4, 0.4, 0.4]), true),
        (json!([0.4]), true),
        (json!([0.4, 0.4, 0.4, 0.4]), false),
        (json!([0.4]), false),
    ] {
        let stock = four_colors_with(&json!({"nozzle_diameter": nozzles}), gcode);
        let none = four_colors_with(
            &json!({"nozzle_diameter": nozzles, "machine_tool_change_time": 0}),
            gcode,
        );
        let changes = stock.report.stats.tool_changes;
        assert!(changes >= 20, "{changes} changes");
        assert_eq!(none.report.stats.tool_changes, changes);
        // The shipped 5 s for each change, on the same moves.
        let added = stock.report.stats.time_s - none.report.stats.time_s;
        assert!(
            (added - 5.0 * f64::from(changes)).abs() < 1.0,
            "{nozzles}, G-code {gcode}: {added} s added for {changes} changes"
        );
    }
}

#[test]
fn every_parked_u1_head_gets_its_standby_cooldown_and_no_preheat_while_it_prints() {
    for nozzles in [json!([0.4, 0.4, 0.4, 0.4]), json!([0.4])] {
        let run = four_colors(&json!({"nozzle_diameter": nozzles}));
        check_standby(&String::from_utf8_lossy(&run.gcode));
    }
}

/// Every change away from a head is preceded by that head's standby cooldown, none is dropped, and no head is
/// preheated while it prints.
fn check_standby(text: &str) {
    let mut active: Option<u32> = None;
    let (mut parks, mut cooled) = (0usize, 0usize);
    let mut cooled_now: Vec<u32> = Vec::new();
    for line in text.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        if let Some(n) = code.strip_prefix('T').and_then(|d| d.parse::<u32>().ok()) {
            if let Some(a) = active.filter(|&a| a != n) {
                parks += 1;
                if cooled_now.contains(&a) {
                    cooled += 1;
                }
            }
            active = Some(n);
            cooled_now.clear();
        } else if code.starts_with("M104") && line.contains("cooldown") {
            if let Some(t) = code
                .split_ascii_whitespace()
                .find_map(|w| w.strip_prefix('T')?.parse::<u32>().ok())
            {
                cooled_now.push(t);
            }
        } else if let Some(rest) = line.split("preheat T").nth(1) {
            let n: u32 = rest
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .unwrap();
            assert_ne!(Some(n), active, "preheat for the printing head: {line}");
        }
    }
    assert!(parks >= 20, "{parks} parks");
    assert_eq!(cooled, parks, "{cooled} of {parks} parked heads cooled");
    assert_eq!(text.matches("; removed M104").count(), 0);
}
