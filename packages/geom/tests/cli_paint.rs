// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx-geom paint.select` and `paint.regions` the way a client runs them: JSON in, JSON out.

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{Value, json};

fn geom(op: &str, req: &Value) -> (bool, Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_sx-geom"))
        .arg(op)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(req.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (out.status.success(), serde_json::from_slice(&out.stdout).unwrap())
}

/// A 20 mm cube: triangles 0 and 1 the bottom, 2 and 3 the top, then the sides.
fn cube() -> Value {
    json!({
        "positions": [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]],
        "triangles": [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
    })
}

fn area_of(regions: &Value, state: u64) -> f64 {
    regions["states"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["state"] == state)
        .map_or(0.0, |s| s["areaMm2"].as_f64().unwrap())
}

#[test]
fn paint_the_bottom_read_it_back_and_draw_it() {
    let (ok, sel) = geom(
        "paint.select",
        &json!({ "mesh": cube(), "state": 2, "target": { "kind": "direction", "direction": "bottom" } }),
    );
    assert!(ok, "{sel}");
    assert_eq!(sel["changed"], json!({ "0": "8", "1": "8" }));
    assert_eq!(sel["selectedAreaMm2"], 400.0);
    assert_eq!(sel["regionCount"], 1);
    // Read back: what was written, as regions with areas.
    let (ok, back) = geom(
        "paint.regions",
        &json!({ "mesh": cube(), "paint": sel["changed"] }),
    );
    assert!(ok, "{back}");
    assert!((area_of(&back, 2) - 400.0).abs() < 1e-9);
    assert_eq!(back["states"][0]["regionCount"], 1);
    assert_eq!(back["badPaint"], 0);
    // The picture counts the same paint, seen from below with fit.
    let (ok, pic) = geom(
        "render",
        &json!({ "mesh": cube(), "paint": sel["changed"], "view": "fit" }),
    );
    assert!(ok, "{pic}");
    assert_eq!(pic["paintedAreaMm2"]["2"], 400.0);
}

#[test]
fn a_band_a_seed_and_a_swap_build_on_each_other() {
    // Below 5 mm in slot 2.
    let (ok, band) = geom(
        "paint.select",
        &json!({ "mesh": cube(), "state": 2, "target": { "kind": "height", "below": 5.0 } }),
    );
    assert!(ok, "{band}");
    let painted = band["changed"].clone();
    let (_, back) = geom("paint.regions", &json!({ "mesh": cube(), "paint": painted }));
    assert!(
        (area_of(&back, 2) - band["selectedAreaMm2"].as_f64().unwrap()).abs() < 0.02,
        "{back} {band}"
    );
    // A smart fill from the top in slot 3, over what is there.
    let (ok, top) = geom(
        "paint.select",
        &json!({ "mesh": cube(), "paint": painted, "state": 3, "target": { "kind": "seed", "point": [10, 10, 21] } }),
    );
    assert!(ok, "{top}");
    assert_eq!(top["changedTriangles"], 2);
    let mut both = painted.as_object().unwrap().clone();
    both.extend(top["changed"].as_object().unwrap().clone());
    // Slot 3 for slot 2, then everything cleared.
    let (ok, swap) = geom(
        "paint.select",
        &json!({ "mesh": cube(), "paint": both, "state": 3, "target": { "kind": "replace", "from": 2 } }),
    );
    assert!(ok, "{swap}");
    let mut after = both.clone();
    after.extend(swap["changed"].as_object().unwrap().clone());
    let (_, back) = geom("paint.regions", &json!({ "mesh": cube(), "paint": after }));
    assert!(area_of(&back, 2).abs() < 1e-9);
    assert!(area_of(&back, 3) > 400.0);
    let (ok, clear) = geom(
        "paint.select",
        &json!({ "mesh": cube(), "paint": after, "state": 0, "target": { "kind": "part" } }),
    );
    assert!(ok, "{clear}");
    assert!(clear["changed"].as_object().unwrap().values().all(|v| v == ""));
}

#[test]
fn bad_targets_are_refused_in_words() {
    for (target, says) in [
        (
            json!({ "kind": "glitter" }),
            "not part, direction, height, seed or replace",
        ),
        (
            json!({ "kind": "direction", "direction": "up" }),
            "not bottom, top",
        ),
        (json!({ "kind": "height" }), "give below, above"),
        (
            json!({ "kind": "seed", "point": [0, 0, 0], "mode": "spray" }),
            "not smart or bucket",
        ),
    ] {
        let (ok, out) = geom(
            "paint.select",
            &json!({ "mesh": cube(), "state": 2, "target": target }),
        );
        assert!(!ok, "{out}");
        assert!(out.to_string().contains(says), "{out}");
    }
}
