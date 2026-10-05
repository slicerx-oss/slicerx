// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Round trips for `packages/contracts/fixtures/pilot-*.json`. The TypeScript side parses
//! the same files, so the Rust types and `canonicalJson` cannot drift from
//! `packages/contracts/src/pilot.ts` unnoticed. Run with `UPDATE_FIXTURES=1` to rewrite them
//! after an intentional change.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::path::PathBuf;

use serde_json::{Value, json};
use sx_permit::{ApprovalAction, ApprovalRequest, PermissionClass, canonical_json, hash_params};

fn path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/fixtures")
        .join(name)
}

/// Compares `json` with the fixture, or writes it first when `UPDATE_FIXTURES` is set.
fn check(name: &str, json: &Value) -> Value {
    let p = path(name);
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(&p, serde_json::to_string_pretty(json).unwrap() + "\n").unwrap();
    }
    let text =
        std::fs::read_to_string(&p).unwrap_or_else(|_| panic!("{name} missing; run with UPDATE_FIXTURES=1"));
    let on_disk: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        &on_disk, json,
        "{name} is out of date; run with UPDATE_FIXTURES=1"
    );
    on_disk
}

fn sample_request() -> ApprovalRequest {
    let upload = json!({"printerId": "bay-2", "name": "Tidewell harbor lantern.gcode.3mf", "sha256": "9f2c4e1ab7d05c3e8f61a2b4c9d7e0f13a5b6c8d9e0f1a2b3c4d5e6f7a8b9c0d"});
    let start = json!({"printerId": "bay-2", "name": "Tidewell harbor lantern.gcode.3mf", "opts": {}});
    let input = json!({"printerId": "bay-2", "plate": 1, "start": true});
    ApprovalRequest {
        id: "apr-7f3a".into(),
        session_id: "ses-2026-09-30-001".into(),
        tool: "printer.send".into(),
        permission: PermissionClass::Start,
        title: "Send plate 1 to Bay 2 and start printing?".into(),
        lines: vec![
            "Bay 2 (P1S with AMS), PETG, 0.4 mm nozzle".into(),
            "Estimated 2 h 14 m, 38 g".into(),
        ],
        printer_id: Some("bay-2".into()),
        params_hash: hash_params(&input),
        actions: vec![
            ApprovalAction {
                action: "printer.upload".into(),
                target: "bay-2".into(),
                params_hash: hash_params(&upload),
            },
            ApprovalAction {
                action: "printer.start".into(),
                target: "bay-2".into(),
                params_hash: hash_params(&start),
            },
        ],
        expires_at: "2026-09-30T08:05:00.000Z".into(),
        origin: None,
    }
}

#[test]
fn approval_request_fixture() {
    let req = sample_request();
    let json = serde_json::to_value(&req).unwrap();
    let on_disk = check("pilot-approval-request.json", &json);
    assert!(on_disk.get("sessionId").is_some() && on_disk.get("printerId").is_some());
    let back: ApprovalRequest = serde_json::from_value(on_disk).unwrap();
    assert_eq!(back, req);
}

/// Inputs as JSON text, so the fixture records exactly what both languages parse.
const INPUTS: &[&str] = &[
    "null",
    r#"{"printerId":"bay-1"}"#,
    r#"{"printerId":"bay-2","name":"Tidewell harbor lantern.gcode.3mf","opts":{}}"#,
    r#"{"profileId":"petg-basic","changes":{"nozzle_temperature":[245,240],"fan_min_speed":35,"filament_retraction_length":0.8}}"#,
    r#"{"z":[1.0,0.1,-0.0,1e21,1.5e-7,250.4,0.30000000000000004,12345678901234567890],"a":{"y":true,"x":null}}"#,
    r#"{"printerId":"bay-4","line":"M117 \"hi\"\n\tG28 \u0001 \u001f café   back\\slash"}"#,
    r#"{"～":1,"𝄞":2,"B":3,"a":4,"":5}"#,
    r#"[[],{},"",0,-1,false]"#,
];

#[test]
fn canonical_json_vectors() {
    let vectors: Vec<Value> = INPUTS
        .iter()
        .map(|text| {
            let input: Value = serde_json::from_str(text).unwrap();
            json!({
                "input": input,
                "canonical": canonical_json(&input),
                "sha256": hash_params(&input),
            })
        })
        .collect();
    let body = json!({
        "comment": "Written by packages/pilot/permit/tests/contract_json.rs. canonicalJson and hashParams in packages/contracts/src/pilot.ts must produce `canonical` and `sha256` for each `input`.",
        "vectors": vectors,
    });
    let on_disk = check("pilot-canonical-json.json", &body);
    // The file itself, read back, must still give the recorded output.
    for v in on_disk["vectors"].as_array().unwrap() {
        assert_eq!(canonical_json(&v["input"]), v["canonical"].as_str().unwrap());
        assert_eq!(hash_params(&v["input"]), v["sha256"].as_str().unwrap());
    }
}
