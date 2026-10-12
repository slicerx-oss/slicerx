// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Paint from a 3MF texture through the JSON operations a client calls: `paint.select` with the image target on the
//! textured cube of the format corpus, then `paint.regions` to read the paint back.

#![cfg(feature = "textures")]

use serde_json::{Value, json};
use std::path::PathBuf;

fn cube() -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/textured-cube.3mf");
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// The cube's own mesh, as a client would send it.
fn mesh(bytes: &[u8]) -> Value {
    let p = sx_geom::format::read_3mf(bytes).expect("reads");
    let part = &p.objects[0].parts[0];
    let positions: Vec<f32> = part.positions.iter().flatten().copied().collect();
    let indices: Vec<u32> = part.triangles.iter().flatten().copied().collect();
    json!({ "positions": positions, "indices": indices })
}

fn call(op: &str, req: &Value, bytes: &[u8]) -> Value {
    let load = |_: &str| -> sx_geom::Result<Vec<u8>> { Ok(bytes.to_vec()) };
    let out =
        sx_geom::json::call_with_files(op, &req.to_string(), &load).unwrap_or_else(|e| panic!("{op}: {e}"));
    serde_json::from_str(&out).expect("json")
}

fn area(v: &Value, slot: &str) -> f64 {
    v[slot].as_f64().unwrap_or(0.0)
}

#[test]
fn the_textured_cube_paints_from_its_texture_and_reads_back_by_filament() {
    let bytes = cube();
    let mesh = mesh(&bytes);
    let target = json!({ "kind": "image", "from": { "path": "mem:0" }, "colors": ["#ffdc00", "#0046c8"] });
    let out = call(
        "paint.select",
        &json!({ "mesh": mesh, "target": target, "state": 0 }),
        &bytes,
    );
    assert_eq!(out["texturedTriangles"], 12);
    assert_eq!(out["splitTriangles"], 2);
    assert_eq!(out["changedTriangles"], 12);
    assert!((area(&out["slotAreaMm2"], "1") - 200.0).abs() < 4.0, "{out}");
    assert!((area(&out["slotAreaMm2"], "2") - 2200.0).abs() < 4.0, "{out}");
    assert_eq!(out["unmatchedAreaMm2"], 0.0);
    // Read back: the bottom face half yellow, the rest blue.
    let back = call(
        "paint.regions",
        &json!({ "mesh": mesh, "paint": out["changed"] }),
        &bytes,
    );
    let states: Vec<(u64, f64)> = back["states"]
        .as_array()
        .expect("states")
        .iter()
        .map(|s| {
            (
                s["state"].as_u64().unwrap_or(0),
                s["areaMm2"].as_f64().unwrap_or(0.0),
            )
        })
        .collect();
    assert_eq!(states.iter().map(|s| s.0).collect::<Vec<_>>(), [1, 2], "{back}");
    assert!((states[0].1 - 200.0).abs() < 4.0, "{back}");
    assert!((states[1].1 - 2200.0).abs() < 4.0, "{back}");
    assert_eq!(back["badPaint"], 0);
}

#[test]
fn a_texture_no_filament_matches_paints_nothing_and_says_what_it_saw() {
    let bytes = cube();
    let target =
        json!({ "kind": "image", "from": { "path": "mem:0" }, "colors": ["#ff0000"], "maxDeltaE": 0.01 });
    let out = call(
        "paint.select",
        &json!({ "mesh": mesh(&bytes), "target": target, "state": 0 }),
        &bytes,
    );
    assert_eq!(out["changedTriangles"], 0);
    assert!(
        (out["unmatchedAreaMm2"].as_f64().unwrap_or(0.0) - 2400.0).abs() < 1e-6,
        "{out}"
    );
    assert_eq!(out["unmatchedColors"][0]["color"], "#0848c8");
    // The nearest filament anyway, when asked.
    let nearest = json!({ "kind": "image", "from": { "path": "mem:0" }, "colors": ["#ff0000"], "maxDeltaE": 0.01, "unmatched": "nearest" });
    let out = call(
        "paint.select",
        &json!({ "mesh": mesh(&bytes), "target": nearest, "state": 0 }),
        &bytes,
    );
    assert_eq!(out["changedTriangles"], 12);
}

#[test]
fn the_image_target_needs_the_same_part_as_the_mesh() {
    let bytes = cube();
    let one = json!({ "positions": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], "indices": [0, 1, 2] });
    let target = json!({ "kind": "image", "from": { "path": "mem:0" }, "colors": ["#ffdc00"] });
    let load = |_: &str| -> sx_geom::Result<Vec<u8>> { Ok(bytes.clone()) };
    let e = sx_geom::json::call_with_files(
        "paint.select",
        &json!({ "mesh": one, "target": target, "state": 0 }).to_string(),
        &load,
    )
    .expect_err("refused");
    assert!(e.to_string().contains("12 triangles and the mesh 1"), "{e}");
}
