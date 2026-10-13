// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The slice report's `featureFilaments`: for each plate object, the filaments each feature printed with. It is
//! read from the sliced paths, so it agrees with the G-code, follows an object's own settings, and doesn't change
//! with the number of shards.

// Configs are built with `json!` at each call, so taking them by value reads best.
#![allow(clippy::needless_pass_by_value)]

use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest, SliceRun};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

/// Two filaments on a plain Marlin printer, the sparse infill on the second.
fn two_filaments() -> Value {
    json!({
        "gcode_flavor": "marlin",
        "sparse_infill_filament_id": 2,
        "nozzle_temperature": [220, 225],
        "filament_diameter": [1.75, 1.75],
        "filament_colour": ["#ff0000", "#00ff00"],
    })
}

/// Cubes at the given x positions, each with its own settings, sliced in `shards` ranges.
fn slice(config: Value, objects: &[(&str, f64, Value)], shards: u32) -> SliceRun {
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    let m = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
    let objects: Vec<Value> = objects
        .iter()
        .map(|(id, x, settings)| {
            json!({"id": id, "name": format!("cube {id}"), "mesh": "c", "settings": settings,
                "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 100, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": config,
        "options": {"trustedGcode": true, "shards": shards},
    }))
    .unwrap();
    common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
}

fn slots(run: &SliceRun, object: &str) -> BTreeMap<String, Vec<u8>> {
    run.report
        .feature_filaments
        .iter()
        .find(|f| f.object == object)
        .unwrap_or_else(|| panic!("no entry for {object}: {:?}", run.report.feature_filaments))
        .features
        .clone()
}

/// The filament slots (1-based) each feature label of the G-code (`;TYPE:` or `; FEATURE: `) printed with, from its
/// `T<n>` lines.
fn gcode_slots(run: &SliceRun) -> BTreeMap<String, BTreeSet<u8>> {
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    let mut out = BTreeMap::<String, BTreeSet<u8>>::new();
    let mut slot = 1u8;
    for l in g.lines() {
        if let Some(n) = l.strip_prefix('T').and_then(|n| n.parse::<u8>().ok()) {
            slot = n + 1;
        } else if let Some(f) = l.strip_prefix("; FEATURE: ").or_else(|| l.strip_prefix(";TYPE:")) {
            out.entry(f.to_owned()).or_default().insert(slot);
        }
    }
    out
}

#[test]
fn each_feature_reports_the_filament_it_printed_with() {
    let run = slice(two_filaments(), &[("a", 128.0, json!({}))], 1);
    let f = slots(&run, "a");
    assert_eq!(f.get("outerWall"), Some(&vec![1]), "{f:?}");
    assert_eq!(f.get("innerWall"), Some(&vec![1]), "{f:?}");
    assert_eq!(f.get("sparseInfill"), Some(&vec![2]), "{f:?}");
    // Off a Bambu Lab printer, solid infill and the surfaces follow the sparse infill's filament.
    for k in ["internalSolid", "topSurface", "bottomSurface"] {
        assert_eq!(f.get(k), Some(&vec![2]), "{k}: {f:?}");
    }
    let entry = &run.report.feature_filaments[0];
    assert_eq!(entry.name, "cube a");

    // The report and the G-code agree, feature by feature.
    let g = gcode_slots(&run);
    for (key, label) in [
        ("outerWall", "Outer wall"),
        ("innerWall", "Inner wall"),
        ("sparseInfill", "Sparse infill"),
        ("internalSolid", "Internal solid infill"),
        ("topSurface", "Top surface"),
        ("bottomSurface", "Bottom surface"),
    ] {
        let reported: BTreeSet<u8> = f.get(key).into_iter().flatten().copied().collect();
        assert_eq!(g.get(label), Some(&reported), "{key}: report {f:?}, G-code {g:?}");
    }
}

#[test]
fn on_a_bambu_printer_solid_infill_stays_on_the_objects_filament() {
    let mut c = two_filaments();
    c["printer_model"] = json!("Bambu Lab P1S");
    let f = slots(&slice(c, &[("a", 128.0, json!({}))], 1), "a");
    assert_eq!(f.get("sparseInfill"), Some(&vec![2]), "{f:?}");
    for k in ["internalSolid", "topSurface", "bottomSurface", "outerWall"] {
        assert_eq!(f.get(k), Some(&vec![1]), "{k}: {f:?}");
    }
}

#[test]
fn an_objects_own_settings_move_only_its_features() {
    let objects = [
        ("a", 80.0, json!({})),
        (
            "b",
            170.0,
            json!({"outer_wall_filament_id": 2, "sparse_infill_filament_id": 1}),
        ),
    ];
    let run = slice(two_filaments(), &objects, 1);
    assert_eq!(
        run.report
            .feature_filaments
            .iter()
            .map(|f| f.object.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    let a = slots(&run, "a");
    let b = slots(&run, "b");
    assert_eq!(a.get("outerWall"), Some(&vec![1]), "{a:?}");
    assert_eq!(a.get("sparseInfill"), Some(&vec![2]), "{a:?}");
    assert_eq!(b.get("outerWall"), Some(&vec![2]), "{b:?}");
    assert_eq!(b.get("sparseInfill"), Some(&vec![1]), "{b:?}");

    // Sliced in three ranges, the report is the same.
    assert_eq!(
        slice(two_filaments(), &objects, 3).report.feature_filaments,
        run.report.feature_filaments
    );
}

#[test]
fn one_filament_reports_slot_one_for_every_feature() {
    let run = slice(json!({"gcode_flavor": "marlin"}), &[("a", 128.0, json!({}))], 1);
    let f = slots(&run, "a");
    assert!(
        f.contains_key("outerWall") && f.contains_key("sparseInfill"),
        "{f:?}"
    );
    assert!(f.values().all(|s| s == &vec![1]), "{f:?}");
    // Paths of no object (the brim around several, a skirt, a prime tower) never make an entry of their own.
    assert_eq!(run.report.feature_filaments.len(), 1);
}
