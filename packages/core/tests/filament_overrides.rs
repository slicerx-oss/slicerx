// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A filament's own retraction settings (`filament_retraction_length` and the rest of Orca's
//! `filament_extruder_override_keys`) replace the printer's for that filament only, and an unset one
//! leaves the printer's value. The config is built the way the app builds it: the settings schema's
//! defaults, then the Prusa MK4S's shipped process, filament and printer settings.

#![allow(clippy::disallowed_methods)]

use serde_json::{Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// Schema defaults, then the MK4S's resolved process, filament and printer, as the app layers them.
fn stock_mk4s() -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let model = read("packages/profiles/resolved/prusa.json")["models"]["prusa-mk4s"].clone();
    let base = model["base"].as_str().unwrap().to_owned();
    for part in [&model["process"][&base], &model["filament"], &model["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

/// Every unretract after the start G-code, with the tool it was written under (0-based).
fn unretracts(gcode: &[u8]) -> Vec<(u32, f64)> {
    let text = String::from_utf8_lossy(gcode);
    let mark = sx_core::extras::layer_mark(&text);
    let body = text.split(mark).skip(1).collect::<Vec<_>>().join(mark);
    let body = body.split("\n; end\n").next().unwrap_or("");
    let mut tool = 0;
    let mut out = Vec::new();
    for line in body.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        if let Some(t) = code.strip_prefix('T').and_then(|t| t.parse().ok()) {
            tool = t;
        }
        let words: Vec<&str> = code.split_whitespace().collect();
        if words.first() == Some(&"G1")
            && words
                .iter()
                .skip(1)
                .all(|w| w.starts_with('E') || w.starts_with('F'))
            && let Some(e) = words
                .iter()
                .find_map(|w| w.strip_prefix('E'))
                .and_then(|e| e.parse::<f64>().ok())
            && e > 0.0
        {
            out.push((tool, e));
        }
    }
    out
}

fn slice(config: serde_json::Map<String, Value>, two: bool) -> Vec<(u32, f64)> {
    let mut objects = vec![
        json!({"id": "a", "mesh": "c", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]}),
    ];
    if two {
        objects.push(json!({"id": "b", "mesh": "c2", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 150, 100, 0, 1], "slotOverrides": {"cube-2.stl": 2}}));
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    let one = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
    let other = Arc::new(Mesh::load(&bytes, "cube-2.stl").unwrap());
    let run = api::run_request(&req, &move |m: &str| {
        Ok(if m == "c2" { other.clone() } else { one.clone() })
    })
    .unwrap();
    unretracts(&run.gcode)
}

#[test]
fn a_stock_filament_keeps_the_printers_retraction() {
    let cfg = stock_mk4s();
    assert_eq!(cfg["retraction_length"], json!([0.7]));
    let moves = slice(cfg, false);
    assert!(moves.len() > 10, "{moves:?}");
    assert!(moves.iter().all(|(_, e)| (e - 0.7).abs() < 1e-6), "{moves:?}");
}

#[test]
fn a_filament_override_applies_to_that_filament_only() {
    let mut cfg = stock_mk4s();
    // Two filaments: the first leaves retraction to the printer, the second asks for 1.2 mm.
    for (k, v) in cfg.clone() {
        if (k.starts_with("filament_")
            || k == "nozzle_temperature"
            || k == "nozzle_temperature_initial_layer")
            && let Value::Array(a) = &v
            && a.len() == 1
        {
            cfg.insert(k, json!([a[0], a[0]]));
        }
    }
    cfg.insert("filament_retraction_length".into(), json!(["nil", 1.2]));
    cfg.insert("enable_prime_tower".into(), json!(false));
    let moves = slice(cfg, true);
    let by_tool = |t: u32| {
        moves
            .iter()
            .filter(|(tool, _)| *tool == t)
            .map(|(_, e)| *e)
            .collect::<Vec<_>>()
    };
    let (first, second) = (by_tool(0), by_tool(1));
    assert!(!first.is_empty() && !second.is_empty(), "{moves:?}");
    assert!(
        first.iter().all(|e| (e - 0.7).abs() < 1e-6),
        "first filament: {first:?}"
    );
    assert!(
        second.iter().all(|e| (e - 1.2).abs() < 1e-6),
        "second filament: {second:?}"
    );
}

#[test]
fn unset_and_nil_overrides_leave_the_printer_value() {
    let mut c =
        api::PrintConfig::from_value(&json!({"retraction_length": [0.7], "filament_retraction_length": []}))
            .unwrap();
    assert!((c.for_filament(1).retraction_length - 0.7).abs() < 1e-9);
    c.raw
        .insert("filament_retraction_length".into(), json!(["nil", "1.5"]));
    assert!((c.for_filament(1).retraction_length - 0.7).abs() < 1e-9);
    assert!((c.for_filament(2).retraction_length - 1.5).abs() < 1e-9);
    // Booleans and enums too: wipe, the layer change retraction and the lift type.
    c.raw.insert("filament_wipe".into(), json!([true]));
    c.raw
        .insert("filament_z_hop_types".into(), json!(["Spiral Lift"]));
    c.raw
        .insert("filament_retract_when_changing_layer".into(), json!([false]));
    let f = c.for_filament(1);
    assert!(f.wipe);
    assert_eq!(f.raw["z_hop_types"], json!(["Spiral Lift"]));
    assert_eq!(f.raw["retract_when_changing_layer"], json!([false]));
    // The cut retraction only when `enable_long_retraction_when_cut` hands it to the filament.
    c.raw
        .insert("filament_retraction_distances_when_cut".into(), json!([30]));
    assert!(c.filament_override("retraction_distances_when_cut", 1).is_none());
    c.raw.insert("enable_long_retraction_when_cut".into(), json!(2));
    assert!(c.filament_override("retraction_distances_when_cut", 1).is_some());
}
