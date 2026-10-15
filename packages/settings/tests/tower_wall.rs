// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The prime tower wall types the settings call unsupported for a printer are exactly the ones the engine prints as
//! the default wall on that printer: sliced with each wall type on a printer with a type 1 tower (Bambu Lab A1) and on
//! one whose maker preset sets a type 2 tower (Prusa CORE One).
use std::sync::Arc;

use serde_json::{Value, json};
use sx_core::api::{self, Mesh, MeshPart, SliceRequest};
use sx_settings::{PrintConfig, setting_def, type_one_tower, unavailable_in};

fn cuboid(x: [f32; 2], slot: u8) -> Mesh {
    let (y, z) = ([100.0f32, 120.0], [0.0f32, 4.0]);
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
            paint_texts: Vec::new(),
        }],
        ..Mesh::default()
    }
}

/// The printer's config as the app builds it (the shipped profile, then the maker's resolved machine preset over
/// it), with two filaments and the tower on.
fn config(vendor: &str, id: &str) -> Value {
    let mut cfg = sx_settings::profile_config(id, None, Some("pla"), Some("standard"))
        .expect("a profile config")
        .to_json();
    let path = format!(
        "{}/../profiles/resolved/{vendor}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let resolved: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("the resolved presets")).expect("json");
    let machine = resolved["models"][id]["machine"]
        .as_object()
        .expect("a machine preset")
        .clone();
    cfg.as_object_mut().expect("an object").extend(machine);
    cfg.as_object_mut().expect("an object").extend(
        json!({
            "smart_layer": "off",
            "filament_type": ["PLA", "PLA"],
            "filament_colour": ["#FF6A13", "#0A2989"],
            "enable_prime_tower": true,
            "prime_tower_auto_position": false,
            "wipe_tower_x": [30],
            "wipe_tower_y": [30],
            "enable_support": false,
            "brim_width": 0,
        })
        .as_object()
        .expect("an object")
        .clone(),
    );
    cfg
}

/// The tower's extruding and travel moves for the printer's config with `wall`.
fn tower(cfg: &Value, wall: &str) -> Vec<String> {
    let mut cfg = cfg.clone();
    cfg["wipe_tower_wall_type"] = json!(wall);
    let a = Arc::new(cuboid([100.0, 120.0], 1));
    let b = Arc::new(cuboid([130.0, 150.0], 2));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {
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
    let g = String::from_utf8(run.gcode).expect("text");
    let mut on = false;
    let mut moves = Vec::new();
    for l in g.lines() {
        if let Some(f) = l.strip_prefix("; FEATURE: ").or_else(|| l.strip_prefix(";TYPE:")) {
            on = f == "Prime tower";
        } else if on && l.starts_with("G1 ") {
            moves.push(l.to_owned());
        }
    }
    assert!(!moves.is_empty(), "{wall}: no tower");
    moves
}

fn check(vendor: &str, id: &str, type_one: bool) {
    let cfg = config(vendor, id);
    let pc = PrintConfig::from_json(&cfg);
    assert_eq!(type_one_tower(&pc), type_one, "{id}");
    let def = setting_def("wipe_tower_wall_type").expect("the setting");
    let default = def.default.as_str().expect("a default").to_owned();
    let base = tower(&cfg, &default);
    let mut falls_back: Vec<String> = def
        .enum_values
        .iter()
        .filter(|v| **v != default && tower(&cfg, v) == base)
        .cloned()
        .collect();
    let mut marked = unavailable_in(def, &pc);
    falls_back.sort();
    marked.sort();
    assert_eq!(falls_back, marked, "{id}");
}

#[test]
fn on_a_type_1_tower_only_cone_prints_as_the_plain_wall() {
    check("bambu-lab", "bambu-a1", true);
}

#[test]
fn on_a_type_2_tower_rib_and_cone_print_as_the_plain_wall() {
    check("prusa", "prusa-core-one", false);
}
