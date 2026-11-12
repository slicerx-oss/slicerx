// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `brep.free` through the engine's op call, as a replay frees the kernel bodies it no longer holds: the body goes,
//! and a second free of the same number answers as the kernel does, `freed: false`.
#![cfg(feature = "brep")]

use serde_json::{Value, json};

fn run(op: &str, request: &Value) -> Value {
    serde_json::from_str(&sx_geom::json::call(op, &request.to_string()).unwrap()).unwrap()
}

#[test]
fn frees_a_body_once() {
    if !sx_brep::KERNEL {
        return;
    }
    assert!(sx_geom::json::operations().contains(&"brep.free"));
    let before = run("brep.count", &json!({}))["bodies"].as_u64().unwrap();
    let body = run("brep.box", &json!({ "min": [0, 0, 0], "max": [10, 10, 10] }))["body"].clone();
    assert_eq!(
        run("brep.count", &json!({}))["bodies"].as_u64().unwrap(),
        before + 1
    );
    assert_eq!(
        run("brep.free", &json!({ "body": body })),
        json!({ "freed": true })
    );
    assert_eq!(run("brep.count", &json!({}))["bodies"].as_u64().unwrap(), before);
    assert_eq!(
        run("brep.free", &json!({ "body": body })),
        json!({ "freed": false })
    );
}
