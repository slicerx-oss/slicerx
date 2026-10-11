// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `support_filament` and `support_interface_filament` name the filament support prints with, 0 for whichever is
//! active. A value past the filaments the print sets up (a project written for a printer with more slots) used to
//! go through as it was, so the G-code changed to a tool that is not there. It now prints with the active filament
//! and says so.

use serde_json::json;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, MeshPart, SliceRequest, SliceRun};

fn cuboid(lo: [f32; 3], hi: [f32; 3], name: &str) -> MeshPart {
    let positions = (0..8)
        .map(|i| {
            [
                if i & 1 == 0 { lo[0] } else { hi[0] },
                if i & 2 == 0 { lo[1] } else { hi[1] },
                if i & 4 == 0 { lo[2] } else { hi[2] },
            ]
        })
        .collect();
    MeshPart {
        name: name.into(),
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
    }
}

/// A one-color T: a 10 x 10 x 8 mm column under a 30 x 10 x 2 mm slab, so each arm overhangs 10 mm.
fn tee() -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "tee".into(),
        parts: vec![
            cuboid([10.0, 0.0, 0.0], [20.0, 10.0, 8.0], "column"),
            cuboid([0.0, 0.0, 8.0], [30.0, 10.0, 10.0], "slab"),
        ],
        ..Mesh::default()
    })
}

fn at(x: f32) -> serde_json::Value {
    json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 100, 0, 1])
}

/// Two filaments set up, support on.
fn slice(objects: serde_json::Value, extra: serde_json::Value) -> SliceRun {
    let mut config = json!({
        "filament_colour": ["#FF8000", "#FFFFFF"],
        "enable_support": true,
        "support_type": "normal(auto)",
        "enable_prime_tower": true,
        "brim_width": 0
    });
    if let (Some(c), Some(e)) = (config.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            c.insert(k.clone(), v.clone());
        }
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": objects },
        "config": config,
        "options": {}
    }))
    .expect("request");
    let mesh = tee();
    common::run_request(&req, &move |_: &str| Ok(mesh.clone())).expect("slices")
}

fn one(extra: serde_json::Value) -> SliceRun {
    slice(json!([{ "id": "a", "mesh": "t", "transform": at(100.0) }]), extra)
}

fn tool_lines(run: &SliceRun) -> Vec<String> {
    String::from_utf8_lossy(&run.gcode)
        .lines()
        .map(str::trim)
        .filter(|l| l.len() > 1 && l.starts_with('T') && l[1..].chars().all(|c| c.is_ascii_digit()))
        .filter(|l| l[1..].parse::<u32>().is_ok_and(|t| t < 1000))
        .map(str::to_owned)
        .collect()
}

fn warnings(run: &SliceRun) -> Vec<String> {
    run.report.warnings.iter().map(|w| w.message.clone()).collect()
}

#[test]
fn default_support_prints_with_the_loaded_filament() {
    let run = one(json!({ "support_filament": 0, "support_interface_filament": 0 }));
    assert_eq!(run.report.stats.tool_changes, 0, "{:?}", tool_lines(&run));
    assert!(
        !tool_lines(&run).iter().any(|t| t == "T1"),
        "no change to filament 2"
    );
}

#[test]
fn a_support_filament_of_its_own_changes_tools_on_support_layers() {
    let run = one(json!({ "support_filament": 2 }));
    assert!(
        run.report.stats.tool_changes > 0,
        "support on filament 2 changes tools"
    );
    assert!(
        tool_lines(&run).iter().any(|t| t == "T1"),
        "{:?}",
        tool_lines(&run)
    );
    assert!(
        !warnings(&run).iter().any(|w| w.contains("support_filament")),
        "{:?}",
        warnings(&run)
    );
}

#[test]
fn a_support_filament_past_the_print_falls_back_to_the_loaded_one_and_says_so() {
    let base = one(json!({ "support_filament": 0 }));
    for (key, value) in [("support_filament", 7), ("support_interface_filament", 3)] {
        let mut asked = serde_json::Map::new();
        asked.insert(key.to_owned(), json!(value));
        let run = one(serde_json::Value::Object(asked));
        // No change to a filament that is not there, and the same print as default support.
        assert!(
            tool_lines(&run).iter().all(|t| t == "T0"),
            "{key} {value}: {:?}",
            tool_lines(&run)
        );
        assert_eq!(
            run.report.stats.tool_changes, base.report.stats.tool_changes,
            "{key} {value}: changes tools as default support does"
        );
        let w = warnings(&run);
        assert!(
            w.iter()
                .any(|w| w.contains(&format!("{key} asks for filament {value}, but this print has 2"))),
            "{w:?}"
        );
    }
}

#[test]
fn without_a_filament_list_nothing_is_checked() {
    // A config that does not say how many filaments there are keeps the value as given.
    let mut config = json!({ "support_filament": 2, "enable_support": true, "support_type": "normal(auto)" });
    if let Some(c) = config.as_object_mut() {
        c.insert("brim_width".into(), json!(0));
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{ "id": "a", "mesh": "t", "transform": at(100.0) }] },
        "config": config,
        "options": {}
    }))
    .expect("request");
    let mesh = tee();
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).expect("slices");
    assert!(
        tool_lines(&run).iter().any(|t| t == "T1"),
        "{:?}",
        tool_lines(&run)
    );
    assert!(!warnings(&run).iter().any(|w| w.contains("support_filament")));
}

#[test]
fn an_objects_own_support_filament_is_checked_too() {
    // Object a asks for filament 5 of 2; object b for filament 2. Only b's support changes tools.
    let run = slice(
        json!([
            { "id": "a", "mesh": "t", "transform": at(60.0), "settings": { "support_filament": 5 } },
            { "id": "b", "mesh": "t", "transform": at(140.0), "settings": { "support_filament": 2 } }
        ]),
        json!({}),
    );
    assert!(
        tool_lines(&run).iter().any(|t| t == "T1"),
        "b's support is on filament 2"
    );
    assert!(
        warnings(&run)
            .iter()
            .any(|w| w.contains("support_filament asks for filament 5, but this print has 2")),
        "{:?}",
        warnings(&run)
    );
}
