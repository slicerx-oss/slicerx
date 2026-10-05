// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The same profile, project and export cases the TypeScript package runs (js/import.parity.test.ts): both
// must produce the results in the golden file.
#![allow(clippy::many_single_char_names)]
mod common;

use std::fs;

use common::{json_eq, read_json, root};
use serde_json::{Value as Json, json};
use sx_settings::{export_profile_json, import_profile_json, import_project_json};

/// Every profile in fixtures/profiles, the parents a case may use.
fn folder() -> Vec<Json> {
    let mut out = Vec::new();
    for sub in ["process", "filament", "machine"] {
        let mut names: Vec<_> = fs::read_dir(root().join("fixtures/profiles").join(sub))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for n in names {
            out.push(read_json(&format!("fixtures/profiles/{sub}/{n}")));
        }
    }
    out
}

fn run(c: &Json) -> Json {
    let result = match c["kind"].as_str().unwrap() {
        "export" => export_profile_json(&json!({"config": c["config"], "meta": c["meta"]}).to_string()),
        "project" => {
            let mut req = json!({"projectSettings": c["projectSettings"]});
            for (from, to) in [("modelSettings", "modelSettings"), ("layerRanges", "layerRanges")] {
                if c.get(from).is_some() {
                    req[to] = c[from].clone();
                }
            }
            import_project_json(&req.to_string())
        }
        _ => {
            let parents: Vec<Json> = c
                .get("parentsOverride")
                .and_then(Json::as_array)
                .cloned()
                .unwrap_or_else(folder);
            let profile = match c["from"].as_str() {
                Some(name) => parents
                    .iter()
                    .find(|p| p["name"] == name)
                    .cloned()
                    .unwrap_or(Json::Null),
                None => c["profile"].clone(),
            };
            import_profile_json(&json!({"profile": profile, "parents": parents}).to_string())
        }
    };
    match result {
        Ok(text) => serde_json::from_str(&text).unwrap(),
        Err(e) => json!({"error": e.to_string()}),
    }
}

#[test]
fn every_import_case_matches_the_golden_result() {
    let cases = read_json("fixtures/import-cases.json");
    let golden = read_json("fixtures/import-golden.json");
    let mut failures = Vec::new();
    for c in cases["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let got = run(c);
        let want = &golden["results"][name];
        let same = match (
            got.get("error").and_then(Json::as_str),
            want.get("error").and_then(Json::as_str),
        ) {
            // The Rust request errors wrap the text; the message itself must be there.
            (Some(g), Some(w)) => g.contains(w),
            _ => json_eq(&got, want),
        };
        if !same {
            failures.push(format!("{name}:\n  rust   {got}\n  golden {want}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} case(s) differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn bad_requests_are_errors() {
    assert!(import_profile_json("nope").is_err());
    assert!(import_profile_json("{}").is_err());
    assert!(import_project_json("{}").is_err());
    assert!(export_profile_json(r#"{"config": {}}"#).is_err());
}
