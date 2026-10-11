// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A sliced plate is checked one shard of layers at a time and refused at the first shard that fails. Each
//! toolpath refusal (past an extruder's reach, into an excluded area, over the height) therefore leads with its
//! first point and object, which do not change with the shards, and gives its count only with the layers it covers.

use serde_json::{Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn cube() -> Arc<Mesh> {
    let path = format!("{}/packages/core/cli/tests/fixtures/cube.stl", root());
    Arc::new(Mesh::load(&std::fs::read(path).unwrap(), "cube.stl").unwrap())
}

/// The refusal for one cube named "cube" centered at `at`, on `config`, sliced in `shards` ranges of layers.
fn refusal(config: &Value, at: [f64; 2], shards: u32) -> String {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "o", "name": "cube", "mesh": "c",
                               "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], 0, 1]}]},
        "config": config,
        "options": {"shards": shards, "trustedGcode": true},
    }))
    .unwrap();
    let m = cube();
    match api::run_request(&req, &move |_: &str| Ok(m.clone())) {
        Err(api::Error::Blocked(msg)) => msg,
        Err(e) => panic!("expected a refusal, got {e}"),
        Ok(_) => panic!("expected a refusal, the file was written"),
    }
}

/// The message up to the count (the first point and its object), the count, and the layers it covers.
fn split(msg: &str) -> (&str, u64, u32, u32) {
    let (head, tail) = msg
        .split_once("), ")
        .unwrap_or_else(|| panic!("no count in {msg}"));
    let words: Vec<&str> = tail.split_whitespace().collect();
    let n = words.first().unwrap().parse().unwrap();
    let num = |w: &str| w.trim_end_matches(';').parse::<u32>().unwrap();
    let (lo, hi) = match words.get(1..) {
        Some([_, "in", "layers", lo, "to", hi, ..]) => (num(lo), num(hi)),
        Some([_, "in", "layer", one, ..]) => (num(one), num(one)),
        _ => panic!("no layer range in {msg}"),
    };
    (head, n, lo, hi)
}

/// The same plate at 1 and 4 shards: the same first point and object; the count with its layer range in each.
fn at_one_and_four(config: &Value, at: [f64; 2], what: &str) -> ((u64, u32, u32), (u64, u32, u32)) {
    let (one, four) = (refusal(config, at, 1), refusal(config, at, 4));
    println!("1 shard: {one}\n4 shards: {four}");
    assert!(one.contains(what), "{one}");
    let (h1, n1, lo1, hi1) = split(&one);
    let (h4, n4, lo4, hi4) = split(&four);
    assert_eq!(h1, h4, "{one}\n{four}");
    assert!(h1.contains("\"cube\""), "{one}");
    assert!(
        lo1 <= lo4 && hi4 <= hi1 && lo1 <= hi1 && lo4 <= hi4,
        "{one}\n{four}"
    );
    ((n1, lo1, hi1), (n4, lo4, hi4))
}

fn cube_size() -> [f64; 3] {
    let (lo, hi) = cube().bounds().unwrap();
    [0, 1, 2].map(|i| f64::from(hi[i] - lo[i]))
}

#[test]
fn a_path_past_its_extruders_reach_names_the_layers_it_counted() {
    // H2D: the right extruder reaches x 25 to 350. The cube's left side, on every layer, is past it.
    let machine: Value =
        serde_json::from_slice(&std::fs::read(format!("{}/packages/profiles/machine.json", root())).unwrap())
            .unwrap();
    let mut c = machine["models"]["bambu-h2d"]["machine"].clone();
    for (k, v) in [
        ("printer_model", json!("Bambu Lab H2D")),
        ("gcode_flavor", json!("bambu")),
        ("single_extruder_multi_material", json!(true)),
        ("filament_map_mode", json!("Manual")),
        ("filament_map", json!([2])),
        ("skirt_loops", json!(0)),
        ("brim_type", json!("no_brim")),
    ] {
        c[k] = v;
    }
    let ((n1, _, hi1), (n4, _, hi4)) = at_one_and_four(&c, [24.0, 150.0], "outside the reach of extruder 2");
    assert!(
        n4 < n1 && hi4 < hi1,
        "the four-shard count stops at its first shard"
    );
}

#[test]
fn moves_into_an_excluded_area_name_the_layers_they_counted() {
    // A 6 mm square excluded over the cube's corner: its walls enter it on every layer.
    let c = json!({
        "printable_area": ["0x0", "256x0", "256x256", "0x256"],
        "bed_exclude_area": ["134x134", "140x134", "140x140", "134x140"],
        "skirt_loops": 0,
        "brim_type": "no_brim",
    });
    let ((n1, lo1, hi1), (n4, lo4, hi4)) = at_one_and_four(&c, [128.0, 128.0], "excluded bed area");
    assert!(
        n4 < n1 && hi4 < hi1,
        "{n1} in {lo1} to {hi1}, {n4} in {lo4} to {hi4}"
    );
}

#[test]
fn layers_over_the_height_name_the_layers_they_counted() {
    // The cube fits under the height, but its last layers' z-hop does not: only the last shard of four has them.
    let h = cube_size()[2];
    let c = json!({
        "printable_area": ["0x0", "256x0", "256x256", "0x256"],
        "printable_height": h + 0.1,
        "z_hop": 0.4,
        "skirt_loops": 0,
        "brim_type": "no_brim",
    });
    let ((n1, lo1, hi1), (n4, lo4, hi4)) = at_one_and_four(&c, [128.0, 128.0], "above the printable height");
    assert_eq!(n1, n4, "every such layer is in the last shard");
    assert_eq!(hi1, hi4);
    assert!(lo1 == 1 && lo4 > 1, "{lo1} and {lo4}");
}
