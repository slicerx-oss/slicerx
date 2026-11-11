// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A rib joined into a shelled hull, then arrayed, held to the record in `fixtures/ship-hull-join.json`. The browser
//! build is held to the same record by packages/app/test/geom-join-parity.test.ts, so the desktop and browser engines
//! give the same mesh, bit for bit, and a change to either fails one of the two.

#![cfg(feature = "cad")]

use serde_json::{Value, json};
use std::path::Path;

fn run(op: &str, req: &Value) -> Value {
    serde_json::from_str(&sx_geom::json::call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}")))
        .unwrap()
}

/// counts and an FNV-1a digest of a reply's mesh: positions as f32, indices, then face ids, little-endian
#[allow(
    clippy::cast_possible_truncation,
    reason = "the reply's positions are f32 and its indices u32"
)]
fn summary(reply: &Value) -> Value {
    let mut h: u32 = 0x811c_9dc5;
    let mut eat = |bytes: [u8; 4]| {
        for b in bytes {
            h = (h ^ u32::from(b)).wrapping_mul(0x0100_0193);
        }
    };
    let m = &reply["mesh"];
    let list = |k: &Value| k.as_array().cloned().unwrap_or_default();
    let positions = list(&m["positions"]);
    let indices = list(&m["indices"]);
    for p in &positions {
        eat((p.as_f64().unwrap() as f32).to_le_bytes());
    }
    for i in indices.iter().chain(&list(&m["faces"]["ids"])) {
        eat((i.as_u64().unwrap() as u32).to_le_bytes());
    }
    json!({ "vertices": positions.len() / 3, "triangles": indices.len() / 3, "digest": format!("{h:08x}") })
}

#[test]
fn the_join_and_the_array_after_it_match_the_record() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ship-hull-join.json");
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let joined = run("shape.extrude", &fx["join"]);
    assert_eq!(summary(&joined), fx["record"]["join"]);
    let mut req = fx["array"].clone();
    req["mesh"] = json!({ "mesh": joined["mesh"], "transform": fx["join"]["target"]["transform"] });
    let arrayed = run("array", &req);
    assert_eq!(summary(&arrayed), fx["record"]["array"]);
}
