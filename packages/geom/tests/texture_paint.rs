// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `paint.texture` end to end on the fixtures of tests/fixtures/texture (made by its make.py): an OBJ through the
//! import and its repair, a 3MF moved as a project open moves it, and a JPEG texture.
#![cfg(feature = "texture")]

use serde_json::{Value, json};
use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/texture")
}

fn files(p: &str) -> sx_geom::Result<Vec<u8>> {
    std::fs::read(dir().join(p)).map_err(|e| sx_geom::Error::invalid_arg(format!("{p}: {e}")))
}

fn call(op: &str, req: &Value) -> Value {
    serde_json::from_str(&sx_geom::json::call_with_files(op, &req.to_string(), &files).unwrap()).unwrap()
}

const FILAMENTS: [&str; 4] = ["#e6141e", "#14c828", "#1428dc", "#f5f5f5"];

/// Area per slot 1 to 4 from a reply.
fn areas(out: &Value) -> [f64; 4] {
    let mut a = [0.0; 4];
    for s in out["slots"].as_array().unwrap() {
        let k = usize::try_from(s["slot"].as_u64().unwrap()).unwrap();
        a[k - 1] = s["areaMm2"].as_f64().unwrap();
    }
    a
}

fn close(a: [f64; 4], want: [f64; 4], tol: f64) {
    for (k, (x, w)) in a.iter().zip(want).enumerate() {
        assert!(
            (x - w).abs() <= w * tol,
            "slot {}: {x} mm2, want {w} ({a:?})",
            k + 1
        );
    }
}

#[test]
fn an_obj_cube_paints_from_its_png_after_the_import() {
    let imported = call("import.auto", &json!({ "data": { "path": "textured-cube.obj" } }));
    let parts: Vec<Value> = imported["objects"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|o| o["parts"].as_array().unwrap().iter().map(|p| p["mesh"].clone()))
        .collect();
    assert_eq!(parts.len(), 1, "one material, one part");
    let out = call(
        "paint.texture",
        &json!({ "source": { "obj": { "path": "textured-cube.obj" } }, "parts": parts, "filaments": FILAMENTS }),
    );
    assert_eq!(out["textured"], true);
    close(areas(&out), [900.0, 500.0, 500.0, 500.0], 0.01);
    assert_eq!(out["colors"], json!([1, 2, 3, 4]));
    // red covers the most, so the part prints red and the rest is paint
    assert_eq!(out["parts"][0]["slot"], 1);
    assert_eq!(out["images"][0]["name"], "quadrants.png");
    // read back: the painted states cover the other three
    let paint = out["parts"][0]["paint"].clone();
    let back = call("paint.regions", &json!({ "mesh": parts[0], "paint": paint }));
    let states: Vec<u64> = back["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["state"].as_u64().unwrap())
        .collect();
    assert_eq!(states, vec![2, 3, 4]);
    assert_eq!(back["badPaint"], 0);
}

#[test]
fn a_3mf_cube_reads_mirrored_and_clamped_textures_and_finds_its_moved_part() {
    let bytes = std::fs::read(dir().join("textured-cube.3mf")).unwrap();
    let project = sx_geom::format::read_3mf(&bytes).unwrap();
    let part = &project.objects[0].parts[0];
    // a project open centers the object: every position moves by one offset
    let positions: Vec<f64> = part
        .in_object(1.0)
        .iter()
        .flat_map(|p| [f64::from(p[0]) - 10.0, f64::from(p[1]) - 10.0, f64::from(p[2])])
        .collect();
    let indices: Vec<u32> = part.triangles.iter().flatten().copied().collect();
    let out = call(
        "paint.texture",
        &json!({
            "source": { "threemf": { "path": "textured-cube.3mf" } },
            "parts": [{ "positions": positions, "indices": indices }],
            "filaments": FILAMENTS,
        }),
    );
    assert_eq!(out["matched"]["same"], 12);
    close(areas(&out), [500.0, 500.0, 500.0, 900.0], 0.01);
    assert_eq!(out["parts"][0]["slot"], 4);
}

#[test]
fn a_jpeg_texture_paints_a_quarter_each() {
    let out = call(
        "paint.texture",
        &json!({
            "source": { "obj": { "path": "textured-square.obj" } },
            "parts": [{ "positions": [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0], "indices": [0, 1, 2, 0, 2, 3] }],
            "filaments": FILAMENTS,
        }),
    );
    close(areas(&out), [100.0, 100.0, 100.0, 100.0], 0.05);
}

#[test]
fn palette_mode_gives_the_four_texture_colors() {
    let out = call(
        "paint.texture",
        &json!({
            "source": { "obj": { "path": "textured-square.obj" } },
            "parts": [{ "positions": [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0], "indices": [0, 1, 2, 0, 2, 3] }],
            "filaments": ["#808080", "#808080", "#808080", "#808080"],
            "mode": "palette",
        }),
    );
    assert_eq!(out["palette"].as_array().unwrap().len(), 4);
    for s in out["slots"].as_array().unwrap() {
        assert!((s["areaMm2"].as_f64().unwrap() - 100.0).abs() < 5.0, "{s}");
    }
}

#[test]
fn a_file_name_that_leaves_the_folder_is_not_read() {
    let obj = "mtllib ../outside.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    let out = call(
        "paint.texture",
        &json!({
            "source": { "obj": { "text": obj } },
            "parts": [{ "positions": [0, 0, 0, 1, 0, 0, 0, 1, 0], "indices": [0, 1, 2] }],
            "filaments": FILAMENTS,
        }),
    );
    assert_eq!(out["textured"], false);
    assert!(out["notes"][0].as_str().unwrap().contains("outside.mtl"));
}
