// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A project's layer heights by height, as the app sends them: the `layer_height` of its request's height ranges. The
//! engine plans the plate's layers from them, and they are the layers the app planned itself before. The requests are
//! held in one record, tests/fixtures/range-layer-heights.json, which the app's test
//! (packages/app/test/range-layer-heights.test.ts) checks from its side.

#![allow(clippy::float_cmp)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use common::organic_models::cuboid;
use sx_core::api::{Mesh, SliceRequest, SliceRun};

fn record() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/range-layer-heights.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Slices the record's case objects (20 mm square boxes `heightMm` tall, side by side) with `ranges` as the request's
/// height ranges.
fn slice(rec: &Value, case: &Value, ranges: &Value) -> SliceRun {
    let objects = case["objects"].as_array().unwrap();
    let mut meshes = std::collections::HashMap::new();
    let mut plate = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        let id = o["id"].as_str().unwrap();
        #[allow(clippy::cast_possible_truncation, reason = "a box height in mm")]
        let h = o["heightMm"].as_f64().unwrap() as f32;
        meshes.insert(
            id.to_owned(),
            Arc::new(Mesh {
                name: id.to_owned(),
                parts: vec![cuboid(id, [0.0, 0.0, 0.0], [20.0, 20.0, h])],
                ..Mesh::default()
            }),
        );
        let x = 60.0 + 40.0 * f64::from(u8::try_from(i).unwrap());
        plate.push(json!({"id": id, "mesh": id, "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, x,100,0,1]}));
    }
    let mut config = rec["config"].clone();
    config["brim_width"] = json!(0);
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": plate},
        "config": config,
        "options": {"flavor": "marlin2", "heightRanges": ranges},
    }))
    .unwrap();
    let load = move |id: &str| Ok(meshes[id].clone());
    common::run_request(&req, &load).unwrap()
}

fn near(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-4)
}

/// The app's request for each case slices with the layers the app planned before: 125 on the range box (0.2 mm to
/// 5 mm, 0.1 mm to 10 mm, 0.2 mm to 20 mm), and plain 0.2 mm layers when the objects differ, which the app sends no
/// layer heights for.
#[test]
fn the_apps_height_ranges_plan_the_layers_it_planned() {
    let rec = record();
    for case in rec["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let run = slice(&rec, case, &case["heightRanges"]);
        let z: Vec<f64> = run.report.layer_z.iter().map(|&z| f64::from(z)).collect();
        let want: Vec<f64> = match case["tops"].as_array() {
            Some(t) => t.iter().map(|v| v.as_f64().unwrap()).collect(),
            None => (1..=100).map(|i| f64::from(i) * 0.2).collect(),
        };
        assert!(near(&z, &want), "{name}: {} layers {z:?}", z.len());
        if name == "range box" {
            assert_eq!(z.len(), 125);
        }
        let said = |w: &str| run.report.warnings.iter().any(|x| x.message.contains(w));
        assert!(!said("layer_height"), "{name}: {:?}", run.report.warnings);
        assert!(
            !said(rec["note"].as_str().unwrap()),
            "{name}: {:?}",
            run.report.warnings
        );
    }
}

/// The engine's rule for objects that change layer height at different heights is the app's: sent every object's
/// layer heights, it notes the case the app marks `differ` (in the words of the app's note on opening the project), and
/// plans the others.
#[test]
fn objects_that_differ_are_noted_as_the_app_notes_them() {
    let rec = record();
    let note = rec["note"].as_str().unwrap();
    for case in rec["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let every: Vec<Value> = case["objects"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|o| {
                o["layerRanges"].as_array().unwrap().iter().map(move |r| {
                    json!({"zFromMm": r["minZ"], "zToMm": r["maxZ"], "settings": r["settings"], "objects": [o["id"]]})
                })
            })
            .collect();
        let run = slice(&rec, case, &Value::Array(every));
        let noted = run.report.warnings.iter().any(|w| w.message.contains(note));
        assert_eq!(
            noted,
            case["differ"].as_bool().unwrap(),
            "{name}: {:?}",
            run.report.warnings
        );
        if noted {
            assert_eq!(run.report.layer_z.len(), 100, "{name}");
        }
    }
}

/// A range's layer height with layer tops of the request's own is noted as not applied, and the tops stand.
#[test]
fn a_ranges_layer_height_under_the_requests_tops_is_noted() {
    let rec = record();
    let case = &rec["cases"][0];
    let tops: Vec<f64> = (1..=80).map(|i| f64::from(i) * 0.25).collect();
    let objects = case["objects"].as_array().unwrap();
    let meshes: std::collections::HashMap<String, Arc<Mesh>> = objects
        .iter()
        .map(|o| {
            let id = o["id"].as_str().unwrap().to_owned();
            let mesh = Mesh {
                name: id.clone(),
                parts: vec![cuboid(&id, [0.0, 0.0, 0.0], [20.0, 20.0, 20.0])],
                ..Mesh::default()
            };
            (id, Arc::new(mesh))
        })
        .collect();
    let mut config = rec["config"].clone();
    config["brim_width"] = json!(0);
    config["layer_height"] = json!(0.25);
    config["initial_layer_print_height"] = json!(0.25);
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "box", "mesh": "box", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": config,
        "options": {"flavor": "marlin2", "heightRanges": case["heightRanges"], "layerTopsMm": tops},
    }))
    .unwrap();
    let load = move |id: &str| Ok(meshes[id].clone());
    let run = common::run_request(&req, &load).unwrap();
    let z: Vec<f64> = run.report.layer_z.iter().map(|&z| f64::from(z)).collect();
    assert!(near(&z, &tops), "{z:?}");
    assert!(
        run.report.warnings.iter().any(|w| w
            .message
            .starts_with("layer_height in a height range is not applied")),
        "{:?}",
        run.report.warnings
    );
}
