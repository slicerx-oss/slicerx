// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A plate refused because its toolpaths leave the bed says which object to move and that arranging the plate
//! fixes it: the command line and the MCP server pass this text on as it is.

use serde_json::{Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn cube() -> Arc<Mesh> {
    let path = format!("{}/cli/tests/fixtures/cube.stl", env!("CARGO_MANIFEST_DIR"));
    Arc::new(Mesh::load(&std::fs::read(path).unwrap(), "cube.stl").unwrap())
}

/// The cube's half size in Y, mm.
fn half_depth() -> f64 {
    let (lo, hi) = cube().bounds().unwrap();
    f64::from(hi[1] - lo[1]) / 2.0
}

/// The refusal for a 250 x 210 mm bed (the MK4's) with a skirt 2 mm out, for cubes named and centered as given.
fn refusal(objects: &[(&str, f64, f64)]) -> String {
    let objects: Vec<Value> = objects
        .iter()
        .enumerate()
        .map(|(i, (name, x, y))| {
            json!({"id": format!("o{i}"), "name": name, "mesh": "c",
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": {
            "printable_area": ["0x0", "250x0", "250x210", "0x210"],
            "skirt_loops": 1, "skirt_distance": 2, "skirt_height": 1, "brim_width": 0,
        },
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let m = cube();
    match api::run_request(&req, &move |_: &str| Ok(m.clone())) {
        Err(api::Error::Blocked(msg)) => msg,
        Err(e) => panic!("expected a refusal, got {e}"),
        Ok(_) => panic!("expected a refusal, the file was written"),
    }
}

#[test]
fn a_skirt_off_the_bed_names_the_object_it_runs_around_and_suggests_arranging() {
    // The cube's back edge is 1 mm inside the bed, so only the skirt 2 mm out leaves it.
    let y = 209.0 - half_depth();
    let msg = refusal(&[("left cube", 60.0, 100.0), ("back cube", 150.0, y)]);
    assert!(msg.contains("outside the printable area"), "{msg}");
    assert!(msg.contains("skirt nearest \"back cube\""), "{msg}");
    assert!(
        msg.contains("move \"back cube\" onto the bed or arrange the plate"),
        "{msg}"
    );
    assert!(!msg.contains("left cube"), "{msg}");
}

#[test]
fn objects_whose_own_walls_leave_the_bed_are_all_named() {
    // Both cubes cross the back edge; the one at the left also leaves the bed on its left side.
    let y = 210.0 - half_depth() + 3.0;
    let msg = refusal(&[("first", 4.0, y), ("second", 150.0, y), ("inside", 100.0, 60.0)]);
    assert!(
        msg.contains("move \"first\" and \"second\" onto the bed or arrange the plate"),
        "{msg}"
    );
    assert!(!msg.contains("\"inside\""), "{msg}");
}

#[test]
fn a_cube_wholly_off_the_bed_suggests_arranging_too() {
    let msg = refusal(&[("lost", 400.0, 100.0)]);
    assert!(msg.contains("wholly outside the printable area"), "{msg}");
    assert!(msg.contains("arrange the plate"), "{msg}");
}
