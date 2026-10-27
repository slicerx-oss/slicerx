// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The keys a project's settings get because the app that wrote the file reads them differently when they are missing
//! (`fromApp` in packages/settings/engine-choices.json), and our defaults for the keys any project leaves out
//! (`defaults` there), against the shared cases in packages/settings/fixtures/project-defaults.json. The settings
//! package, the MCP server and the app run the same cases.

use serde_json::{Map, Value};
use std::path::Path;
mod common;

fn cases() -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../settings/fixtures/project-defaults.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    doc["cases"].as_array().unwrap().clone()
}

/// A project of one box with `settings` as its `Metadata/project_settings.config`, written by `app`.
fn project(app: Option<&str>, settings: &Value) -> Vec<u8> {
    let meta = app.map_or_else(String::new, |a| {
        format!(r#"<metadata name="Application">{a}</metadata>"#)
    });
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">{meta}<resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#
    );
    let settings = settings.to_string();
    common::organic_models::stored_zip(&[
        ("3D/3dmodel.model", model.as_bytes()),
        ("Metadata/project_settings.config", settings.as_bytes()),
    ])
}

/// The table's rows: key and the keys that, when the project has any, leave the key out.
fn table_rows() -> Vec<(String, Vec<String>)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../settings/engine-choices.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut rows = Vec::new();
    for app in doc["fromApp"].as_object().unwrap().values() {
        for (k, row) in app.as_object().unwrap() {
            let unless = row["unlessAny"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            rows.push((k.clone(), unless));
        }
    }
    rows
}

#[test]
fn app_missing_keys_match_the_shared_cases() {
    for case in cases() {
        let name = case["name"].as_str().unwrap();
        let settings = case["settings"].as_object().unwrap();
        let added: Map<String, Value> =
            sx_core::api::app_missing_keys(settings, case["application"].as_str())
                .into_iter()
                .collect();
        assert_eq!(Value::Object(added), case["added"], "{name}");
    }
}

#[test]
fn a_project_config_has_the_keys_its_app_reads_differently() {
    let rows = table_rows();
    assert!(!rows.is_empty(), "engine-choices.json has no fromApp rows");
    for case in cases() {
        let name = case["name"].as_str().unwrap();
        let input = case["settings"].as_object().unwrap();
        let bytes = project(case["application"].as_str(), &case["settings"]);
        let config = sx_core::api::project_config(&bytes, "p.3mf").unwrap().unwrap();
        for (k, v) in case["added"].as_object().unwrap() {
            assert_eq!(config.settings.get(k), Some(v), "{name}: {k}");
        }
        for (k, unless) in &rows {
            if case["added"].get(k).is_some()
                || input.contains_key(k)
                || unless.iter().any(|u| input.contains_key(u))
            {
                continue;
            }
            assert_eq!(config.settings.get(k), None, "{name}: {k}");
        }
        // Our defaults for the keys the project leaves out, whatever app wrote it; a key it sets is its own.
        for (k, v) in case["defaults"].as_object().unwrap() {
            assert_eq!(config.settings.get(k), Some(v), "{name}: {k}");
        }
        for k in GAPS {
            if let Some(own) = input.get(k) {
                assert_eq!(config.settings.get(k), Some(own), "{name}: {k}");
            }
        }
    }
}

const GAPS: [&str; 2] = ["support_top_z_distance", "support_bottom_z_distance"];

/// The support gaps a case should print with: the project's own, else 0.2 from the defaults.
fn want_gaps(case: &Value) -> (f64, f64) {
    let gap = |k: &str| {
        let v = case["settings"].get(k).unwrap_or(&case["defaults"][k]);
        v.as_f64()
            .or_else(|| v.as_str().and_then(|t| t.parse().ok()))
            .unwrap()
    };
    (gap(GAPS[0]), gap(GAPS[1]))
}

#[test]
fn a_project_without_support_gaps_prints_them_at_0_2_at_any_layer_height() {
    for case in cases() {
        let name = case["name"].as_str().unwrap();
        let bytes = project(case["application"].as_str(), &case["settings"]);
        let settings = sx_core::api::project_config(&bytes, "p.3mf")
            .unwrap()
            .unwrap()
            .settings;
        // as `sx slice <project.3mf>` reads them: the project's settings over the schema's defaults
        let mut c = sx_core::config::PrintConfig::default();
        c.apply_value_lenient(&Value::Object(settings)).unwrap();
        assert_eq!(
            (c.support.top_z_distance, c.support.bottom_z_distance),
            want_gaps(&case),
            "{name}"
        );
    }
}

#[test]
fn a_request_with_a_layer_height_and_no_support_gaps_still_follows_the_layer() {
    // Not a project: a request's config with only a layer height keeps gaps of one layer, at most 0.2 mm.
    for (h, gap) in [(0.08, 0.08), (0.12, 0.12), (0.28, 0.2)] {
        let c = sx_core::config::PrintConfig::from_value(&serde_json::json!({ "layer_height": h })).unwrap();
        assert_eq!(
            (c.support.top_z_distance, c.support.bottom_z_distance),
            (gap, gap),
            "{h}"
        );
        assert_eq!(c.raw["support_top_z_distance"], "auto");
    }
}

#[test]
fn request_project_defaults_fill_only_the_missing_keys() {
    for case in cases() {
        let name = case["name"].as_str().unwrap();
        let bytes = project(
            case["application"].as_str(),
            &serde_json::json!({ "layer_height": "0.2" }),
        );
        let mut config = case["settings"].clone();
        let added = sx_core::api::apply_project_defaults(&mut config, &bytes);
        let mut want = case["settings"].as_object().unwrap().clone();
        for (k, v) in case["added"].as_object().unwrap() {
            want.insert(k.clone(), v.clone());
        }
        assert_eq!(config, Value::Object(want), "{name}");
        let mut keys: Vec<&str> = case["added"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(added, keys, "{name}");
    }
    // A request with no config yet gets an object of the keys.
    let bytes = project(
        Some("BambuStudio-02.08.02.61"),
        &serde_json::json!({ "layer_height": "0.2" }),
    );
    let mut config = Value::Null;
    assert_eq!(sx_core::api::apply_project_defaults(&mut config, &bytes).len(), 4);
    assert_eq!(config["wipe_tower_wall_type"], "rib");
}
