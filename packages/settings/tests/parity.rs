// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The same plan and validate cases the TypeScript package runs (js/plan.parity.test.ts): both must
// produce the plans and issues in the golden files.
#![allow(clippy::many_single_char_names)]
mod common;

use common::{json_eq, read_json};
use serde_json::{Value as Json, json};
use sx_settings::{apply_plan_json, plan_json, validate_json};

/// The first place two JSON values differ, for a readable failure.
fn first_diff(a: &Json, b: &Json, path: &str) -> Option<String> {
    match (a, b) {
        (Json::Object(x), Json::Object(y)) => {
            for k in x.keys().chain(y.keys()) {
                match (x.get(k), y.get(k)) {
                    (Some(p), Some(q)) => {
                        if let Some(d) = first_diff(p, q, &format!("{path}.{k}")) {
                            return Some(d);
                        }
                    }
                    (p, q) => return Some(format!("{path}.{k}: rust {p:?} vs golden {q:?}")),
                }
            }
            None
        }
        (Json::Array(x), Json::Array(y)) if x.len() == y.len() => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (p, q))| first_diff(p, q, &format!("{path}[{i}]"))),
        _ if json_eq(a, b) => None,
        _ => Some(format!("{path}: rust {a} vs golden {b}")),
    }
}

/// FNV-1a over the UTF-8 bytes, 8 hex digits, the same as `fnv` in js/plan.parity.test.ts.
fn fnv(text: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in text.bytes() {
        h = (h ^ u32::from(b)).wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

fn strs(v: &Json) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

fn text_of(v: &Json) -> String {
    v.as_str().map_or_else(
        || {
            if v.is_null() { String::new() } else { v.to_string() }
        },
        str::to_owned,
    )
}

fn list(v: &Json) -> Vec<Json> {
    v.as_array().cloned().unwrap_or_default()
}

fn hashed(parts: &[String]) -> String {
    fnv(&parts.join("\u{1}"))
}

/// The plan as the golden file stores it: long texts reduced to hashes. Same recipe as `plain` in the
/// TypeScript test.
fn digest(o: &Json) -> Json {
    let changes: Vec<Json> = list(&o["changes"])
        .iter()
        .map(|c| {
            let mut parts = vec![text_of(&c["label"]), text_of(&c["section"]), text_of(&c["unit"]), text_of(&c["reason"])];
            parts.extend(strs(&c["sources"]));
            let mut m = json!({"key": c["key"], "before": c["before"], "after": c["after"], "origin": c["origin"], "klass": c["klass"], "approval": c["approval"], "t": hashed(&parts)});
            for k in ["goal", "priority"] {
                if !c[k].is_null() {
                    m[k] = c[k].clone();
                }
            }
            m
        })
        .collect();
    let with_sources = |text: &Json, sources: &Json| {
        let mut parts = vec![text_of(text)];
        parts.extend(strs(sources));
        hashed(&parts)
    };
    json!({
        "from": o["from"], "to": o["to"], "changes": changes,
        "unresolved": list(&o["unresolved"]).iter().map(|u| json!({"key": u["key"], "t": fnv(&text_of(&u["reason"]))})).collect::<Vec<_>>(),
        "warnings": o["warnings"],
        "clamps": list(&o["clamps"]).iter().map(|c| json!({"key": c["key"], "requested": c["requested"], "applied": c["applied"], "by": c["by"], "limit": c["limit"], "t": fnv(&text_of(&c["reason"]))})).collect::<Vec<_>>(),
        "refused": list(&o["refused"]).iter().map(|r| json!({"key": r["key"], "requested": r["requested"], "t": fnv(&text_of(&r["reason"]))})).collect::<Vec<_>>(),
        "blockers": o["blockers"], "questions": o["questions"],
        "caveats": list(&o["caveats"]).iter().map(|c| json!({"t": with_sources(&c["text"], &c["sources"])})).collect::<Vec<_>>(),
        "advice": list(&o["advice"]).iter().map(|a| json!({"kind": a["kind"], "t": with_sources(&a["text"], &a["sources"])})).collect::<Vec<_>>(),
        "tellUser": o["tellUser"],
    })
}

fn request(c: &Json, configs: &Json) -> String {
    let mut options = c["options"].as_object().cloned().unwrap_or_default();
    if let Some(t) = options.get("target").and_then(Json::as_str) {
        options.insert("target".into(), configs[t].clone());
    }
    let mut req = json!({"from": c["from"], "to": c["to"], "options": options});
    match &c["base"] {
        Json::Bool(true) => req["base"] = configs["base"].clone(),
        Json::String(name) => req["base"] = configs[name.as_str()].clone(),
        _ => {}
    }
    req.to_string()
}

#[test]
fn every_plan_case_matches_the_golden_plan() {
    let configs = read_json("fixtures/plan-configs.json");
    let cases = read_json("fixtures/plan-cases.json");
    let golden = read_json("fixtures/plan-golden.json");
    let cases = cases["cases"].as_array().unwrap();
    assert!(cases.len() >= 30);
    let mut failures = Vec::new();
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let out: Json = serde_json::from_str(&plan_json(&request(c, &configs)).unwrap()).unwrap();
        let got = digest(&out);
        if let Some(d) = first_diff(&got, &golden["plans"][name], "") {
            // Show the rust text behind a differing hash.
            let text = d
                .split("changes[")
                .nth(1)
                .and_then(|r| r.split(']').next())
                .and_then(|i| i.parse::<usize>().ok())
                .map(|i| format!("\n    rust reason: {}", out["changes"][i]["reason"]));
            failures.push(format!("{name}: {d}{}", text.unwrap_or_default()));
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
fn every_validate_case_matches_the_golden_issues() {
    let cases = read_json("fixtures/validate-cases.json");
    let golden = read_json("fixtures/validate-golden.json");
    for c in cases["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let out: Json = serde_json::from_str(&validate_json(&c["config"].to_string()).unwrap()).unwrap();
        assert!(
            json_eq(&out, &golden["issues"][name]),
            "{name}: rust {out} vs golden {}",
            golden["issues"][name]
        );
    }
}

#[test]
fn apply_plan_json_applies_a_plan_and_skips_read_keys() {
    let configs = read_json("fixtures/plan-configs.json");
    let cases = read_json("fixtures/plan-cases.json");
    let c = cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "material switch pla to petg")
        .unwrap();
    let plan: Json = serde_json::from_str(&plan_json(&request(c, &configs)).unwrap()).unwrap();
    let applied: Json = serde_json::from_str(
        &apply_plan_json(&json!({"config": configs["base"], "plan": plan}).to_string()).unwrap(),
    )
    .unwrap();
    assert!(json_eq(&applied["nozzle_temperature"], &json!([245, 245])));
    assert!(json_eq(
        &applied["layer_height"],
        &configs["base"]["layer_height"]
    ));
    let again: Json = serde_json::from_str(
        &plan_json(&request(c, &json!({"base": applied, "petg": configs["petg"]}))).unwrap(),
    )
    .unwrap();
    let left: Vec<&str> = again["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["klass"] != "read")
        .map(|c| c["key"].as_str().unwrap())
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn bad_requests_are_errors_not_panics() {
    assert!(plan_json("not json").is_err());
    assert!(plan_json("{}").is_err());
    assert!(plan_json(r#"{"from": {"printer": "x"}, "to": {}}"#).is_err());
    assert!(validate_json("[]").is_err());
    assert!(apply_plan_json(r#"{"config": {}}"#).is_err());
}
