// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
#![cfg(sx_brep_kernel)]
use serde_json::{Value, json};

fn call(op: &str, req: &Value) -> Value {
    serde_json::from_str(&sx_brep::call(op, &req.to_string()).expect("kernel call")).unwrap()
}

#[test]
fn request_size_is_bounded_before_parsing() {
    let request = format!("{{}}{}", " ".repeat(32 * 1024 * 1024 - 2));
    assert!(sx_brep::call("count", &request).is_ok());
    let error = sx_brep::call("count", &(request + " ")).unwrap_err();
    assert_eq!(error, "request: exceeds 32 MiB");
}

#[test]
fn nesting_limit_counts_containers_not_string_contents() {
    let allowed = format!("{{\"x\":{}0{}}}", "[".repeat(63), "]".repeat(63));
    assert!(sx_brep::call("count", &allowed).is_ok());
    let deep = format!("{{\"x\":{}0{}}}", "[".repeat(64), "]".repeat(64));
    assert_eq!(
        sx_brep::call("count", &deep).unwrap_err(),
        "request: JSON nesting exceeds 64 containers"
    );
    assert!(sx_brep::call("count", &json!({"x": "[".repeat(128)}).to_string()).is_ok());
}

#[test]
fn saved_body_limit_precedes_the_kernel_reader_and_valid_bodies_round_trip() {
    let error = sx_brep::call(
        "load",
        &json!({"body": {"smb": "x".repeat(8 * 1024 * 1024 + 1)}}).to_string(),
    )
    .unwrap_err();
    assert!(error.contains("saved body exceeds 8 MiB"), "{error}");
    let body = call("box", &json!({"min": [0,0,0], "max": [20,20,20]}))["body"]
        .as_u64()
        .unwrap();
    let saved = call("save", &json!({"body":body}))["smb"]
        .as_str()
        .unwrap()
        .to_owned();
    let loaded = call("load", &json!({"body":{"smb":saved}}))["body"]
        .as_u64()
        .unwrap();
    assert_eq!(
        call("info", &json!({"body":loaded}))["volumeMm3"],
        call("info", &json!({"body":body}))["volumeMm3"]
    );
    for id in [body, loaded] {
        call("free", &json!({"body":id}));
    }
}

#[test]
fn small_json_values_cannot_expand_without_a_bound() {
    let request = format!("{{\"x\":[{}0]}}", "0,".repeat(999_997));
    assert!(sx_brep::call("count", &request).is_ok());
    let over = request.replacen("]}", ",0]}", 1);
    assert_eq!(
        sx_brep::call("count", &over).unwrap_err(),
        "request: JSON exceeds 1000000 values"
    );
}

#[test]
fn operation_names_are_bounded_in_bytes() {
    assert_eq!(
        sx_brep::call(&"x".repeat(129), "{}").unwrap_err(),
        "op: exceeds 128 bytes"
    );
    assert_eq!(
        sx_brep::call(&"\u{00e9}".repeat(65), "{}").unwrap_err(),
        "op: exceeds 128 bytes"
    );
}
