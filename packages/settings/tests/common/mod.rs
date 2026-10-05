// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
#![allow(dead_code, clippy::many_single_char_names)]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde_json::Value as Json;
use sx_settings::{PrintConfig, ProfileImport, import_orca};

pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn read_json(rel: &str) -> Json {
    let text = fs::read_to_string(root().join(rel)).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// Numbers compare by value, so `2` equals `2.0`.
pub fn json_eq(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(p), Some(q)) => (p - q).abs() < 1e-9,
            _ => false,
        },
        (Json::Array(x), Json::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q)),
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

pub fn vendors() -> HashMap<String, HashMap<String, String>> {
    let idx = read_json("fixtures/profiles/index.json");
    let mut out = HashMap::new();
    for (vendor, types) in idx["vendors"].as_object().unwrap() {
        let mut by_name = HashMap::new();
        for t in types.as_object().unwrap().values() {
            for (name, rel) in t.as_object().unwrap() {
                by_name.insert(name.clone(), rel.as_str().unwrap().to_owned());
            }
        }
        out.insert(vendor.clone(), by_name);
    }
    out
}

pub fn load_profile(vendor: &str, name: &str) -> ProfileImport {
    let all = vendors();
    let by_name = all.get(vendor).unwrap();
    let load = |n: &str| {
        by_name
            .get(n)
            .map(|rel| read_json(&format!("fixtures/profiles/{rel}")))
    };
    import_orca(&load(name).unwrap(), &|n| load(n)).unwrap()
}

pub fn config_from(json: &Json) -> PrintConfig {
    PrintConfig::from_json(json)
}
