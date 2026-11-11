// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! heimdall on the Bambu Lab H2C, printed by object: a change to a hotend that waits on the rack at the right of the
//! bed takes the head there, and an object printed before that stands by the rack is struck. The trip goes by the
//! hotends the filament map puts the two filaments on, not by the filament numbers: two filaments on one hotend swap
//! at the chute without visiting the rack, and two filaments on two rack hotends swap at the rack.
//!
//! The printer is the H2C's machine settings from machine.json over the stock H2D's resolved process and filament,
//! with a change G-code of one comment line, which does not lift over the objects printed before.

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, MeshPart, SliceRequest, SliceRun};
use sx_core::collide::Kind;

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// The H2C with a PLA filament for each entry of `map`, printed by object, the filament map set by hand to `map`
/// (1-based extruders).
fn h2c(map: &[u8]) -> Map<String, Value> {
    let n = map.len();
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let m = read("packages/profiles/resolved/bambu-lab.json")["models"]["bambu-h2d"].clone();
    let base = m["base"].as_str().unwrap().to_owned();
    for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    for (k, v) in read("packages/profiles/machine.json")["models"]["bambu-h2c"]["machine"]
        .as_object()
        .unwrap()
    {
        out.insert(k.clone(), v.clone());
    }
    for (k, v) in [
        ("printer_model", json!("Bambu Lab H2C")),
        ("machine_start_gcode", json!("; start\n")),
        ("machine_end_gcode", json!("")),
        (
            "change_filament_gcode",
            json!("; change e[current_extruder]>[next_extruder]\n"),
        ),
        ("print_sequence", json!("by object")),
        ("brim_width", json!(0)),
        ("skirt_loops", json!(0)),
        ("enable_prime_tower", json!(false)),
        ("filament_map_mode", json!("Manual")),
        ("filament_map", json!(map)),
        ("nozzle_temperature", json!(vec![220; n])),
        ("nozzle_temperature_initial_layer", json!(vec![220; n])),
        ("filament_type", json!(vec!["PLA"; n])),
        ("filament_diameter", json!(vec![1.75; n])),
        ("filament_max_volumetric_speed", json!(vec![20; n])),
        ("filament_colour", json!(vec!["#808080"; n])),
    ] {
        out.insert(k.into(), v);
    }
    out
}

fn cuboid(x: [f32; 2], y: [f32; 2], h: f32, slot: u8) -> MeshPart {
    let mut positions = Vec::new();
    for z in [0.0, h] {
        for (xi, yi) in [(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])] {
            positions.push([xi, yi, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    MeshPart {
        name: format!("part {slot}"),
        slot,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint: Vec::new(),
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
        paint_texts: Vec::new(),
    }
}

fn mesh(name: &str, parts: Vec<MeshPart>) -> Arc<Mesh> {
    Arc::new(Mesh {
        name: name.into(),
        parts,
        ..Mesh::default()
    })
}

/// A 30 by 50 by 30 mm box by the rack at the right of the bed on filament 1, printed first, then a 28 by 14 by 3 mm
/// two color print at the front left, filament `slots[0]` on its left half and `slots[1]` on its right.
fn plate(config: Map<String, Value>, slots: [u8; 2]) -> SliceRun {
    let objects = [
        (
            "box",
            mesh("box", vec![cuboid([0.0, 30.0], [0.0, 50.0], 30.0, 1)]),
            290.0,
            180.0,
        ),
        (
            "print",
            mesh(
                "print",
                vec![
                    cuboid([0.0, 14.0], [0.0, 14.0], 3.0, slots[0]),
                    cuboid([14.0, 28.0], [0.0, 14.0], 3.0, slots[1]),
                ],
            ),
            30.0,
            30.0,
        ),
    ];
    let list: Vec<Value> = objects
        .iter()
        .map(|(name, _, x, y)| {
            json!({"id": name, "name": name, "mesh": name, "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": list},
        "config": Value::Object(config),
        "options": {"printerId": "bambu-h2c", "trustedGcode": true},
    }))
    .unwrap();
    let meshes: Vec<(String, Arc<Mesh>)> = objects
        .iter()
        .map(|(n, m, _, _)| ((*n).to_owned(), m.clone()))
        .collect();
    api::run_request(&req, &move |id: &str| {
        Ok(meshes
            .iter()
            .find(|(n, _)| n == id)
            .map(|(_, m)| m.clone())
            .unwrap())
    })
    .unwrap()
}

/// The collisions of a tool change trip: to and from the chute and the rack, and at the rack.
fn trips(r: &SliceRun) -> Vec<(String, String, Kind)> {
    r.report
        .collisions
        .iter()
        .filter(|c| matches!(c.kind, Kind::ToolChange | Kind::Dock))
        .map(|c| (c.object_id.clone(), c.hit_id.clone(), c.kind))
        .collect()
}

/// The nozzle of each filament the slice reports, and its count of tool changes.
fn nozzles(r: &SliceRun) -> (Vec<u8>, u32) {
    let map = r.report.filament_map.as_ref().expect("a filament map");
    (map.nozzles.clone(), r.report.stats.tool_changes)
}

#[test]
fn two_filaments_on_two_rack_hotends_swap_at_the_rack_and_strike_the_box_beside_it() {
    let r = plate(h2c(&[2, 2]), [1, 2]);
    let (map, changes) = nozzles(&r);
    assert_eq!(map, [1, 2]);
    assert!(changes > 0);
    assert!(
        trips(&r).iter().any(|(o, h, _)| o == "print" && h == "box"),
        "{:?}",
        r.report.collisions
    );
}

#[test]
fn two_filaments_on_the_left_nozzle_swap_at_the_chute_and_never_visit_the_rack() {
    // Filaments 2 and 3, whose numbers alone would send the head to two rack hotends.
    let r = plate(h2c(&[1, 1, 1]), [2, 3]);
    let (map, changes) = nozzles(&r);
    assert_eq!(map, [0, 0, 0]);
    assert!(changes > 0);
    assert!(trips(&r).is_empty(), "{:?}", r.report.collisions);
}

#[test]
fn a_switch_from_the_left_nozzle_to_the_hotend_in_the_head_stays_at_the_chute() {
    let r = plate(h2c(&[1, 2]), [1, 2]);
    let (map, changes) = nozzles(&r);
    assert_eq!(map, [0, 1]);
    assert!(changes > 0);
    assert!(trips(&r).is_empty(), "{:?}", r.report.collisions);
}
