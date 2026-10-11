// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What a request's config sets that the slice does not use. A value the engine cannot read leaves only that
//! setting at its default (it used to refuse the whole config); `options.configReport` lists the keys the engine
//! never reads; `options.strict` refuses the slice over either.

// Requests are built inline and handed over whole.
#![allow(clippy::needless_pass_by_value)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, MeshPart, SliceRequest, SliceRun};

fn cube() -> Arc<Mesh> {
    let (lo, hi) = ([0.0f32, 0.0, 0.0], [20.0f32, 20.0, 10.0]);
    let positions = (0..8)
        .map(|i| {
            [
                if i & 1 == 0 { lo[0] } else { hi[0] },
                if i & 2 == 0 { lo[1] } else { hi[1] },
                if i & 4 == 0 { lo[2] } else { hi[2] },
            ]
        })
        .collect();
    let part = MeshPart {
        name: "cube".into(),
        slot: 1,
        positions,
        triangles: vec![
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
        ],
        ..MeshPart::default()
    };
    Arc::new(Mesh {
        name: "cube".into(),
        parts: vec![part],
        ..Mesh::default()
    })
}

fn run(config: Value, options: Value) -> sx_core::Result<SliceRun> {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{ "id": "a", "mesh": "c", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1] }] },
        "config": config,
        "options": options
    }))
    .expect("request");
    let mesh = cube();
    common::run_request(&req, &move |_: &str| Ok(mesh.clone()))
}

fn warnings(run: &SliceRun) -> Vec<String> {
    run.report.warnings.iter().map(|w| w.message.clone()).collect()
}

#[test]
fn a_bad_value_loses_only_its_own_setting() {
    // Two values the engine cannot use, next to good ones that sort before and after them.
    let run = run(
        json!({
            "brim_width": 0,
            "layer_height": 0.25,
            "wall_loops": "abc",
            "sparse_infill_density": "250%",
            "top_shell_layers": 3,
            "z_hop": 0.4
        }),
        json!({ "configReport": true }),
    )
    .expect("slices with the good values");
    // 10 mm at 0.25 mm layers (0.2 mm first): the layer height after the bad keys applied.
    assert!(run.report.layer_count < 45, "{}", run.report.layer_count);
    let report = run.report.config_report.as_ref().expect("a report");
    let bad: Vec<&str> = report.invalid.iter().map(|i| i.key.as_str()).collect();
    assert_eq!(bad, ["wall_loops", "sparse_infill_density"]);
    assert_eq!(report.invalid[0].value, json!("abc"));
    assert!(
        report.not_applied.is_empty(),
        "off unless asked: {:?}",
        report.not_applied
    );
    let w = warnings(&run);
    assert!(
        w.iter()
            .any(|w| w.starts_with("2 settings had a value this engine cannot use")
                && w.contains("wall_loops")),
        "{w:?}"
    );
}

#[test]
fn without_the_report_a_bad_value_refuses_the_config_naming_its_key() {
    // The app drops the refused key and slices again with its profile's value.
    let err = run(json!({ "brim_width": 0, "wall_loops": "abc" }), json!({}))
        .unwrap_err()
        .to_string();
    assert!(err.contains("config key wall_loops"), "{err}");
}

#[test]
fn walls_say_which_generator_runs_and_why() {
    let set = run(
        json!({ "brim_width": 0, "wall_generator": "arachne" }),
        json!({ "configReport": true }),
    )
    .unwrap();
    let walls = set
        .report
        .config_report
        .and_then(|r| r.walls)
        .expect("a walls note");
    assert_eq!(
        (walls.generator.as_str(), walls.source.as_str()),
        ("arachne", "request")
    );
    assert_eq!(walls.text, "arachne walls, set by the request");
    // Without the tests' base settings (which name classic walls), a config that names none gets the engine's own.
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{ "id": "a", "mesh": "c", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1] }] },
        "config": { "brim_width": 0 },
        "options": { "configReport": true }
    }))
    .unwrap();
    let mesh = cube();
    let unset = sx_core::api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    let walls = unset
        .report
        .config_report
        .and_then(|r| r.walls)
        .expect("a walls note");
    assert_eq!(walls.source, "default");
    assert!(
        walls.text.starts_with("classic walls, the engine's default"),
        "{}",
        walls.text
    );
}

#[test]
fn the_report_lists_keys_the_engine_never_reads() {
    let config = json!({
        "brim_width": 0,
        // never read
        "zz_made_up_key": 1,
        "zz_another_made_up_key": "x",
        // what describes the preset, not the print
        "print_settings_id": "0.20mm Standard @BBL X1C",
        "inherits": "fdm_process_common",
        // read through a built name, a mixed-case name, and a placeholder in custom G-code
        "filament_retraction_speed": [30],
        "cool_plate_temp_initial_layer": [35],
        "required_nozzle_HRC": [3],
        "zz_placeholder_key": 7,
        "machine_end_gcode": "M104 S0 ; [zz_placeholder_key]"
    });
    let run = run(config.clone(), json!({ "configReport": true })).unwrap();
    let report = run.report.config_report.clone().expect("a report");
    assert_eq!(report.not_applied, ["zz_another_made_up_key", "zz_made_up_key"]);
    let w = warnings(&run);
    assert!(
        w.iter()
            .any(|w| w == "2 settings are not used by this engine: zz_another_made_up_key, zz_made_up_key"),
        "{w:?}"
    );
    // Off by default: hosts that send a whole profile see no list.
    let quiet = self::run(config, json!({})).unwrap();
    assert!(quiet.report.config_report.is_none());
}

#[test]
fn a_long_list_names_ten_and_counts_the_rest() {
    let mut config = serde_json::Map::new();
    for i in 0..25 {
        config.insert(format!("zz_unused_{i:02}"), json!(1));
    }
    config.insert("brim_width".into(), json!(0));
    let run = run(Value::Object(config), json!({ "configReport": true })).unwrap();
    let report = run.report.config_report.clone().expect("a report");
    assert_eq!(report.not_applied.len(), 25, "the report keeps every key");
    let w = warnings(&run);
    let line = w
        .iter()
        .find(|w| w.starts_with("25 settings"))
        .expect("one line for all");
    assert!(line.ends_with("zz_unused_09 and 15 more"), "{line}");
    assert_eq!(w.iter().filter(|w| w.contains("zz_unused")).count(), 1);
}

#[test]
fn strict_refuses_with_the_list() {
    let err = run(
        json!({ "brim_width": 0, "zz_made_up_key": 1 }),
        json!({ "strict": true }),
    )
    .unwrap_err()
    .to_string();
    assert!(
        err.contains("options.strict") && err.contains("zz_made_up_key"),
        "{err}"
    );
    let err = run(
        json!({ "brim_width": 0, "wall_loops": "abc" }),
        json!({ "strict": true }),
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("wall_loops"), "{err}");
    // A config the engine uses whole slices under strict too.
    assert!(
        run(
            json!({ "brim_width": 0, "wall_loops": 3 }),
            json!({ "strict": true })
        )
        .is_ok()
    );
}
