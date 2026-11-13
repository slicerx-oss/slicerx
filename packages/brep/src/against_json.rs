// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the typed tessellation against the `tessellate` operation, on the solid cases of `tests/solid-cases.json`
//!
//! The same body read both ways must give the same triangles. The operation welds points on a 1e-6 mm grid and
//! leaves out a triangle whose welded corners coincide; the typed mesh keeps the kernel's own vertices, so it is
//! welded the same way here before the two are compared, and then they must be equal number for number. One saved
//! text is read by both, so both tessellate the same body.

use crate::{Mesh, Tessellation};
use serde_json::{Value, json};
use std::collections::HashMap;

// a failure names the case and the operation, so a run on one platform says which one failed
fn call(case: &str, op: &str, request: &Value) -> Value {
    let reply = crate::call(op, &request.to_string()).unwrap_or_else(|e| panic!("{case}: {op}: {e}"));
    serde_json::from_str(&reply).expect("JSON reply")
}

struct Bodies(Vec<u64>);
impl Drop for Bodies {
    fn drop(&mut self) {
        for body in self.0.iter().rev() {
            let _ = crate::call("free", &json!({"body": body}).to_string());
        }
    }
}

// a step's request at a scale and a place, as tests/solids.rs builds it
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

fn numbers<T>(v: &Value, read: impl Fn(&Value) -> Option<T>) -> Vec<T> {
    v.as_array()
        .expect("an array")
        .iter()
        .map(|n| read(n).expect("a number"))
        .collect()
}

/// The reply's `positions`, each number read by the standard library, which gives the nearest f64. The reply
/// prints 17 digits, enough to say exactly which f64 the kernel had; the JSON reader's own parsing may land one step
/// beside it.
fn positions_of(reply: &str) -> Vec<f64> {
    let key = "\"positions\":[";
    let start = reply.find(key).expect("positions in the reply") + key.len();
    let end = start + reply[start..].find(']').expect("the end of positions");
    reply[start..end]
        .split(',')
        .filter(|n| !n.is_empty())
        .map(|n| n.parse().expect("a number"))
        .collect()
}

/// The typed mesh welded as the operation welds: points that round alike on a 1e-6 mm grid become the first of
/// them, and a triangle with two corners on one welded point is left out. Returns flat positions, flat indices,
/// the face of each triangle kept, and how many triangles were left out.
#[allow(
    clippy::cast_possible_truncation,
    reason = "coordinates times 1e6 stay far inside i64"
)]
fn welded(mesh: &Mesh) -> (Vec<f64>, Vec<u64>, Vec<i64>, usize) {
    let mut weld: HashMap<[i64; 3], u64> = HashMap::new();
    let (mut positions, mut indices, mut faces, mut left_out) = (Vec::new(), Vec::new(), Vec::new(), 0);
    for (triangle, &face) in mesh.triangles.iter().zip(&mesh.faces) {
        let ids = triangle.map(|corner| {
            let p = mesh.positions[corner as usize];
            let next = weld.len() as u64;
            *weld
                .entry(p.map(|c| (c * 1e6).round() as i64))
                .or_insert_with(|| {
                    positions.extend(p);
                    next
                })
        });
        if ids[0] == ids[1] || ids[1] == ids[2] || ids[0] == ids[2] {
            left_out += 1;
            continue;
        }
        indices.extend(ids);
        faces.push(i64::from(face));
    }
    (positions, indices, faces, left_out)
}

#[allow(
    clippy::float_cmp,
    reason = "the two paths must give the same numbers, bit for bit"
)]
#[test]
fn the_typed_mesh_is_the_operation_s_mesh_on_every_solid_case() {
    let fixtures: Value = serde_json::from_str(include_str!("../tests/solid-cases.json")).unwrap();
    for fixture in fixtures.as_array().unwrap() {
        for scale in [0.1, 1.0, 10.0] {
            for offset in [[0.0, 0.0, 0.0], [1000.0, -700.0, 350.0]] {
                let name = format!("{} scale {scale} offset {offset:?}", fixture["name"]);
                let mut held = Bodies(Vec::new());
                let mut bodies = HashMap::new();
                for step in fixture["steps"].as_array().unwrap() {
                    let input = request(&step[2], "", scale, &offset, &bodies);
                    let body = call(&name, step[1].as_str().unwrap(), &input)["body"]
                        .as_u64()
                        .unwrap();
                    held.0.push(body);
                    bodies.insert(step[0].as_str().unwrap().to_owned(), body);
                }
                // one saved text, read by both: the operation's `load` and the typed reader
                let saved = call(&name, "save", &json!({"body": bodies["result"]}))["smb"].clone();
                let loaded = call(&name, "load", &json!({"body": {"smb": saved}}))["body"]
                    .as_u64()
                    .unwrap();
                held.0.push(loaded);
                let reply = crate::call(
                    "tessellate",
                    &json!({"body": loaded, "chordMm": 0.01 * scale, "angleDeg": 15}).to_string(),
                )
                .unwrap_or_else(|e| panic!("{name}: tessellate: {e}"));
                let old: Value = serde_json::from_str(&reply).expect("JSON reply");
                let body =
                    crate::saved::body(saved.as_str().unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"));
                let mesh = body
                    .tessellate(&Tessellation {
                        chord_mm: 0.01 * scale,
                        curve_angle_deg: 15.0,
                        surface_angle_deg: 15.0,
                        max_edge_mm: 0.0,
                        max_aspect: 0.0,
                    })
                    .unwrap_or_else(|e| panic!("{name}: {e}"));

                let (positions, indices, faces, left_out) = welded(&mesh);
                let old_positions = positions_of(&reply);
                let old_indices = numbers(&old["indices"], Value::as_u64);
                let old_faces = numbers(&old["faceIds"], Value::as_i64);
                assert_eq!(indices.len(), old_indices.len(), "{name}: triangle count");
                assert_eq!(faces, old_faces, "{name}: the face of each triangle");
                assert_eq!(indices, old_indices, "{name}: triangle corners");
                assert_eq!(positions.len(), old_positions.len(), "{name}: point count");
                if let Some(i) = (0..positions.len()).find(|&i| positions[i] != old_positions[i]) {
                    panic!(
                        "{name}: coordinate {i} is {:?} typed and {:?} from the operation",
                        positions[i], old_positions[i]
                    );
                }
                // on these cases the kernel's own vertices are already the welded ones: no two of them round alike,
                // and no triangle is left out
                assert_eq!(left_out, 0, "{name}: triangles the weld leaves out");
                assert_eq!(
                    mesh.positions.len() * 3,
                    old_positions.len(),
                    "{name}: kernel vertices"
                );
                // the same faces, in the same order
                assert_eq!(
                    mesh.surfaces.len(),
                    old["faces"].as_array().unwrap().len(),
                    "{name}: face count"
                );
            }
        }
    }
}
