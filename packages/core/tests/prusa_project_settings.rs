// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A `PrusaSlicer` project's own settings (`Metadata/Slic3r_PE.config`) as the engine reads them, against the shared
//! cases in packages/settings/fixtures/prusa-project-settings.json. The settings package (`prusaProjectConfig`), the
//! MCP server and the app's project open run the same cases, so `sx slice <project.3mf>` slices a project with the
//! values the app opens it with.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
mod common;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../settings/fixtures")
}

fn cases() -> Vec<Value> {
    let path = fixtures().join("prusa-project-settings.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    doc["cases"].as_array().unwrap().clone()
}

/// A `PrusaSlicer` project of one box with `config` as its `Metadata/Slic3r_PE.config`.
fn project(config: &str) -> Vec<u8> {
    let model = r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">PrusaSlicer-2.9.6</metadata><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#;
    common::organic_models::stored_zip(&[
        ("3D/3dmodel.model", model.as_bytes()),
        ("Metadata/Slic3r_PE.config", config.as_bytes()),
    ])
}

/// Each project a case stands for: its files, or one built from its lines as a project writes them.
fn projects(case: &Value) -> Vec<(String, Vec<u8>)> {
    if let Some(lines) = case["lines"].as_array() {
        let text: Vec<String> = lines
            .iter()
            .map(|l| format!("; {}", l.as_str().unwrap()))
            .collect();
        return vec![("p.3mf".to_owned(), project(&text.join("\n")))];
    }
    case["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let f = f.as_str().unwrap();
            (f.to_owned(), std::fs::read(fixtures().join(f)).unwrap())
        })
        .collect()
}

#[test]
fn a_prusaslicer_project_config_matches_the_shared_cases() {
    for case in cases() {
        let name = case["name"].as_str().unwrap();
        for (file, bytes) in projects(&case) {
            let config = sx_core::api::project_config(&bytes, &file)
                .unwrap()
                .unwrap_or_else(|| panic!("{name}: {file} has no project settings"));
            assert_eq!(Value::Object(config.settings), case["config"], "{name}: {file}");
            assert!(config.kept.is_empty(), "{name}: {file}");
            assert!(config.skipped.is_none(), "{name}: {file}");
        }
    }
}

#[test]
fn a_prusaslicer_project_gets_no_engine_choices_or_defaults() {
    // The app opens a PrusaSlicer project's values on the current printer and adds none of engine-choices.json, so a
    // project without support gaps keeps the printer's, as one without precise outer walls does.
    let path = fixtures().join("../engine-choices.json");
    let table: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let ours: Vec<&String> = ["keeps", "defaults"]
        .iter()
        .filter_map(|k| table[*k].as_object())
        .flat_map(Map::keys)
        .collect();
    assert!(!ours.is_empty());
    let bytes = project("; support_material = 1\n; layer_height = 0.12");
    let config = sx_core::api::project_config(&bytes, "p.3mf").unwrap().unwrap();
    for k in ours {
        assert!(!config.settings.contains_key(k), "{k}");
    }
    for k in ["support_top_z_distance", "support_bottom_z_distance"] {
        assert!(!config.settings.contains_key(k), "{k}");
    }
}

#[test]
fn the_project_metadata_names_its_settings_source() {
    let bytes = std::fs::read(fixtures().join("preset-files/prusaslicer-2.9.6-tslab.3mf")).unwrap();
    let meta = sx_core::api::project_metadata(&bytes, "t.3mf").unwrap();
    assert_eq!(meta.settings_from.as_deref(), Some("prusaslicer"));
    let settings = meta.project_settings.unwrap();
    assert_eq!(settings["enable_support"], "1");
    assert_eq!(settings["wall_loops"], "3");
    // A project with its own project_settings.config is read from that, as before.
    let both = common::organic_models::stored_zip(&[
        ("3D/3dmodel.model", b"<model/>".as_slice()),
        (
            "Metadata/project_settings.config",
            br#"{"layer_height":"0.3"}"#.as_slice(),
        ),
        ("Metadata/Slic3r_PE.config", b"; layer_height = 0.1".as_slice()),
    ]);
    let meta = sx_core::api::project_metadata(&both, "b.3mf").unwrap();
    assert_eq!(meta.settings_from, None);
    assert_eq!(meta.project_settings.unwrap()["layer_height"], "0.3");
}

#[test]
fn a_prusaslicer_project_without_settings_lines_has_an_empty_config() {
    let bytes = project("; generated by PrusaSlicer 2.9.6\n");
    let config = sx_core::api::project_config(&bytes, "p.3mf").unwrap().unwrap();
    assert!(config.settings.is_empty());
}
