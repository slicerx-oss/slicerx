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
    refusal_in_shards(objects, 1)
}

/// [`refusal`], with the plate sliced in `shards` ranges of layers.
fn refusal_in_shards(objects: &[(&str, f64, f64)], shards: u32) -> String {
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
        "options": {"flavor": "marlin2", "shards": shards},
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

/// The message up to the count (the first point and its object), and the count with the layers it covers.
fn split(msg: &str) -> (&str, u64, u32, u32) {
    let (head, tail) = msg.split_once("), ").unwrap();
    let mut words = tail.split_whitespace();
    let n = words.next().unwrap().parse().unwrap();
    let rest: Vec<&str> = words.collect();
    let (lo, hi) = match rest.as_slice() {
        ["points" | "point", "in", "layers", lo, "to", hi, ..] => {
            (lo.parse().unwrap(), hi.trim_end_matches(';').parse().unwrap())
        }
        ["points" | "point", "in", "layer", one, ..] => {
            let one = one.trim_end_matches(';').parse().unwrap();
            (one, one)
        }
        _ => panic!("no layer range in {msg}"),
    };
    (head, n, lo, hi)
}

#[test]
fn the_count_names_the_layers_it_covers_whatever_the_shards() {
    // A cube whose back wall crosses the edge on every layer: a sliced plate is refused at the first shard of
    // layers that fails, so the count depends on the shards. The first point and its object do not.
    let y = 210.0 - half_depth() + 3.0;
    let plate = [("over", 120.0, y)];
    let one = refusal_in_shards(&plate, 1);
    let four = refusal_in_shards(&plate, 4);
    let (head1, n1, lo1, hi1) = split(&one);
    let (head4, n4, lo4, hi4) = split(&four);
    assert_eq!(head1, head4, "{one}\n{four}");
    assert!(
        head1.contains("from layer 1 (") && head1.contains("\"over\""),
        "{one}"
    );
    assert_eq!((lo1, lo4), (1, 1));
    assert!(hi4 < hi1, "{one}\n{four}");
    assert!(n4 < n1, "{one}\n{four}");
    assert!(
        one.ends_with("move \"over\" onto the bed or arrange the plate"),
        "{one}"
    );
    assert!(
        four.ends_with("move \"over\" onto the bed or arrange the plate"),
        "{four}"
    );
}
