// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A project's older `ensure_vertical_shell_thickness` switch values ("0" and "1", and the true and false spellings)
//! print the same moves when the engine reads the file's config as given (`sx slice --request`) as when the app
//! opens the project first and sends its settings: a small cone, whose leaning wall makes the shell modes differ.
use std::sync::Arc;

use serde_json::{Value, json};
use sx_core::api::{self, Mesh, MeshPart, SliceRequest};
use sx_settings::import_project;

const KEY: &str = "ensure_vertical_shell_thickness";

/// A cone 20 mm across at the bed and 10 mm across at the top, 12 mm tall, centered on the plate.
fn cone() -> Mesh {
    const SIDES: u32 = 48;
    let mut positions = Vec::new();
    for (r, z) in [(10.0f32, 0.0f32), (5.0, 12.0)] {
        for i in 0..SIDES {
            #[allow(clippy::cast_precision_loss, reason = "a small count")]
            let a = std::f32::consts::TAU * i as f32 / SIDES as f32;
            positions.push([128.0 + r * a.cos(), 128.0 + r * a.sin(), z]);
        }
    }
    let (bottom, top) = (2 * SIDES, 2 * SIDES + 1);
    positions.push([128.0, 128.0, 0.0]);
    positions.push([128.0, 128.0, 12.0]);
    let mut triangles = Vec::new();
    for i in 0..SIDES {
        let j = (i + 1) % SIDES;
        triangles.push([i, j, SIDES + j]);
        triangles.push([i, SIDES + j, SIDES + i]);
        triangles.push([bottom, j, i]);
        triangles.push([top, SIDES + i, SIDES + j]);
    }
    Mesh {
        name: "cone".into(),
        parts: vec![MeshPart {
            name: "cone".into(),
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
    }
}

/// The printer's config as the app builds it, with `value` for the shell setting.
fn config(value: &Value) -> Value {
    let mut cfg = sx_settings::profile_config("bambu-a1", None, Some("pla"), Some("standard"))
        .expect("a profile config")
        .to_json();
    cfg["smart_layer"] = json!("off");
    cfg["brim_width"] = json!(0);
    cfg["enable_support"] = json!(false);
    cfg[KEY] = value.clone();
    cfg
}

/// The moves (G0 to G3) of the cone sliced with `cfg`.
fn moves(cfg: &Value) -> Vec<String> {
    let mesh = Arc::new(cone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {
            "objects": [
                {"id": "a", "name": "cone", "mesh": "a", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]},
            ],
        },
        "config": cfg,
        "options": {"trustedGcode": true},
    }))
    .expect("a request");
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).expect("a slice");
    let g = String::from_utf8(run.gcode).expect("text");
    let out: Vec<String> = g
        .lines()
        .filter(|l| ["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|p| l.starts_with(p)))
        .map(str::to_owned)
        .collect();
    assert!(!out.is_empty(), "no moves");
    out
}

/// The value the app's project import reads for `raw`.
fn imported(raw: &Value) -> Value {
    let r = import_project(&json!({ KEY: raw }), None, None).expect("an import");
    assert!(
        r.invalid_keys.is_empty() && r.unknown_keys.is_empty(),
        "{raw}: {:?}",
        r.invalid_keys
    );
    r.config.to_json()[KEY].clone()
}

#[test]
fn an_older_shell_thickness_switch_prints_the_same_raw_and_through_the_app() {
    let full = moves(&config(&json!("ensure_all")));
    for raw in [json!("0"), json!("1"), json!("true"), json!("false")] {
        let app = imported(&raw);
        let by_app = moves(&config(&app));
        assert!(
            moves(&config(&raw)) == by_app,
            "{raw}: the raw read and the app's {app} print different moves"
        );
        if raw == json!("0") {
            // The leaning wall makes the full rule print differently, so the check above can see the mode.
            assert!(by_app != full, "{raw}: {app} prints as the full rule");
        }
    }
}
