// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
#![cfg(sx_brep_kernel)]
use serde_json::{Value, json};
use std::collections::HashMap;

fn call(op: &str, request: &Value) -> Value {
    let reply = sx_brep::call(op, &request.to_string()).expect("kernel call");
    serde_json::from_str(&reply).expect("JSON reply")
}

struct Bodies(Vec<u64>);
impl Drop for Bodies {
    fn drop(&mut self) {
        for body in self.0.iter().rev() {
            let _ = sx_brep::call("free", &json!({"body": body}).to_string());
        }
    }
}

fn request(v: &Value, key: &str, scale: f64, offset: &[f64; 3], bodies: &HashMap<String, u64>) -> Value {
    match v {
        Value::String(s) if s.starts_with('$') => json!(bodies[&s[1..]]),
        Value::Number(n) => json!(n.as_f64().unwrap() * scale),
        Value::Array(a) if matches!(key, "axis" | "face") => Value::Array(a.clone()),
        Value::Array(a) if matches!(key, "min" | "max" | "origin" | "a" | "b") => {
            json!(
                a.iter()
                    .enumerate()
                    .map(|(i, n)| n.as_f64().unwrap() * scale + offset[i])
                    .collect::<Vec<_>>()
            )
        }
        Value::Array(a) => Value::Array(a.iter().map(|n| request(n, "", scale, offset, bodies)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, n)| (k.clone(), request(n, k, scale, offset, bodies)))
                .collect(),
        ),
        _ => v.clone(),
    }
}

fn near(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        actual.is_finite() && (actual - expected).abs() <= tolerance,
        "{actual} expected {expected} within {tolerance}"
    );
}

fn mesh_check(mesh: &Value, offset: &[f64; 3], expected: f64) {
    let p: Vec<f64> = mesh["positions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let ix: Vec<usize> = mesh["indices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| usize::try_from(v.as_u64().unwrap()).unwrap())
        .collect();
    assert!(!p.is_empty() && p.len().is_multiple_of(3) && p.iter().all(|n| n.is_finite()));
    assert!(!ix.is_empty() && ix.len().is_multiple_of(3));
    assert_eq!(mesh["faceIds"].as_array().unwrap().len() * 3, ix.len());
    let mut edges = HashMap::<(usize, usize), (usize, i32)>::new();
    let mut volume = 0.0;
    for ids in ix.chunks_exact(3) {
        assert!(ids[0] != ids[1] && ids[1] != ids[2] && ids[2] != ids[0]);
        for j in 0..3 {
            let (a, b) = (ids[j], ids[(j + 1) % 3]);
            assert!(a < p.len() / 3);
            let edge = edges.entry((a.min(b), a.max(b))).or_default();
            edge.0 += 1;
            edge.1 += if a < b { 1 } else { -1 };
        }
        let vertex = |id: usize| {
            [
                p[id * 3] - offset[0],
                p[id * 3 + 1] - offset[1],
                p[id * 3 + 2] - offset[2],
            ]
        };
        let (a, b, c) = (vertex(ids[0]), vertex(ids[1]), vertex(ids[2]));
        volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]))
            / 6.0;
    }
    assert!(
        edges.values().all(|&e| e == (2, 0)),
        "closed consistently oriented mesh"
    );
    near(volume, expected, expected * 0.005);
}

fn verify(body: u64, fixture: &Value, scale: f64, offset: &[f64; 3]) {
    let expected = (fixture["volume"][0].as_f64().unwrap()
        + std::f64::consts::PI * fixture["volume"][1].as_f64().unwrap())
        * scale.powi(3);
    let tolerance = expected * fixture["tolerance"].as_f64().unwrap_or(1e-6);
    let info = call("info", &json!({"body": body}));
    assert_eq!(info["manifold"], true);
    near(info["volumeMm3"].as_f64().unwrap(), expected, tolerance);
    for (i, &origin) in offset.iter().enumerate() {
        near(
            info["bounds"]["min"][i].as_f64().unwrap(),
            origin,
            1e-6 * scale.max(1.0),
        );
        near(
            info["bounds"]["max"][i].as_f64().unwrap(),
            origin + fixture["bounds"][i].as_f64().unwrap() * scale,
            1e-6 * scale.max(1.0),
        );
    }
    mesh_check(
        &call(
            "tessellate",
            &json!({"body": body, "chordMm": 0.01 * scale, "angleDeg": 15}),
        ),
        offset,
        expected,
    );
}

#[test]
fn procedural_solids_preserve_volume_and_closed_meshes_across_scale_and_location() {
    let fixtures: Value = serde_json::from_str(include_str!("solid-cases.json")).unwrap();
    for fixture in fixtures.as_array().unwrap() {
        for scale in [0.1, 1.0, 10.0] {
            for offset in [[0.0, 0.0, 0.0], [1000.0, -700.0, 350.0]] {
                println!("{} scale {scale} offset {offset:?}", fixture["name"]);
                let baseline = call("count", &json!({}))["bodies"].clone();
                let mut held = Bodies(Vec::new());
                let mut bodies = HashMap::new();
                for step in fixture["steps"].as_array().unwrap() {
                    let input = request(&step[2], "", scale, &offset, &bodies);
                    let body = call(step[1].as_str().unwrap(), &input)["body"].as_u64().unwrap();
                    held.0.push(body);
                    bodies.insert(step[0].as_str().unwrap().to_owned(), body);
                }
                let body = bodies["result"];
                verify(body, fixture, scale, &offset);
                let saved = call("save", &json!({"body": body}))["smb"].clone();
                let loaded = call("load", &json!({"body": {"smb": saved}}))["body"]
                    .as_u64()
                    .unwrap();
                held.0.push(loaded);
                verify(loaded, fixture, scale, &offset);
                drop(held);
                assert_eq!(call("count", &json!({}))["bodies"], baseline);
            }
        }
    }
}
