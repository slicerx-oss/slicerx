// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! heimdall on the Bambu Lab H3C, printed by object: a change between hotends takes the head to the `PrintTool` rack
//! across the front of the chamber and back by the purge chute at the back right, and an object printed before that
//! stands in the way is struck. The trip goes to the docks of the hotends the filament map puts the two filaments on,
//! not to the docks numbered like the filaments, and two filaments on one hotend swap at the chute without a rack
//! visit.
//!
//! The printer is the stock H3C from resolved/bambu-lab.json with a change G-code of one comment line, which does not
//! lift over the objects printed before, so every trip is checked. With the maker's own change G-code, which lifts to
//! 3 mm over everything printed before the head leaves for the rack, the same trips clear.

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, MeshPart, SliceRequest, SliceRun};
use sx_core::collide::{Kind, Severity};
mod common;

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// The app's config for the stock H3C with `filaments` PLA filaments, printed by object: schema defaults, the resolved
/// process, filament and printer, then a start and change G-code of one comment line each.
fn h3c(filaments: usize) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let m = read("packages/profiles/resolved/bambu-lab.json")["models"]["bambu-h3c"].clone();
    let base = m["base"].as_str().unwrap().to_owned();
    for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    for (k, v) in [
        ("machine_start_gcode", json!("; start\n")),
        ("machine_end_gcode", json!("")),
        (
            "change_filament_gcode",
            json!("; change h[current_nozzle_id]>[next_nozzle_id]\n"),
        ),
        ("print_sequence", json!("by object")),
        ("brim_width", json!(0)),
        ("skirt_loops", json!(0)),
        ("enable_prime_tower", json!(false)),
        ("nozzle_temperature", json!(vec![220; filaments])),
        ("nozzle_temperature_initial_layer", json!(vec![220; filaments])),
        ("filament_type", json!(vec!["PLA"; filaments])),
        ("filament_diameter", json!(vec![1.75; filaments])),
        ("filament_max_volumetric_speed", json!(vec![40; filaments])),
        ("filament_colour", json!(vec!["#808080"; filaments])),
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

/// Slices `objects` (name, mesh, x, y of its front left corner) by object, in that order, on `config`.
fn run(objects: &[(&str, Arc<Mesh>, f32, f32)], config: Map<String, Value>) -> SliceRun {
    let list: Vec<Value> = objects
        .iter()
        .map(|(name, _, x, y)| {
            json!({"id": name, "name": name, "mesh": name, "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": list},
        "config": Value::Object(config),
        "options": {"printerId": "bambu-h3c", "trustedGcode": true},
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

/// A 28 by 14 by 3 mm two color print: filament 1 on the left half, filament `other` on the right.
fn two_color(other: u8) -> Arc<Mesh> {
    mesh(
        "print",
        vec![
            cuboid([0.0, 14.0], [0.0, 14.0], 3.0, 1),
            cuboid([14.0, 28.0], [0.0, 14.0], 3.0, other),
        ],
    )
}

fn block(name: &str, w: f32, d: f32, h: f32) -> Arc<Mesh> {
    mesh(name, vec![cuboid([0.0, w], [0.0, d], h, 1)])
}

/// The collisions of a tool change trip: to and from the rack and the chute, and at the docks.
fn trips(r: &SliceRun) -> Vec<(String, String, Kind)> {
    r.report
        .collisions
        .iter()
        .filter(|c| matches!(c.kind, Kind::ToolChange | Kind::Dock))
        .map(|c| (c.object_id.clone(), c.hit_id.clone(), c.kind))
        .collect()
}

/// The hotend pairs of the change lines, `from>to`: the nozzle ids, which on the H3C are the hotends the two filaments
/// print on (its hotend ids are -1, as the printer's stock output writes them).
fn hotend_changes(r: &SliceRun) -> Vec<String> {
    let g = String::from_utf8(r.gcode.clone()).unwrap();
    let mut out: Vec<String> = g
        .lines()
        .filter_map(|l| l.strip_prefix("; change h"))
        .map(str::to_owned)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// A box of `h` mm in the middle of the bed, printed first, and the two color print behind it at the back middle: the
/// trip from the print to the rack at the front crosses the box.
fn box_before_print(h: f32, config: Map<String, Value>) -> SliceRun {
    run(
        &[
            ("box", block("box", 20.0, 20.0, h), 80.0, 105.0),
            ("print", two_color(2), 151.0, 243.0),
        ],
        config,
    )
}

#[test]
fn the_trip_to_the_front_rack_strikes_a_tall_object_printed_before_and_clears_a_short_one() {
    let tall = box_before_print(30.0, h3c(2));
    assert_eq!(hotend_changes(&tall), ["0>1", "1>0"]);
    let hits = trips(&tall);
    assert!(
        hits.iter().any(|(o, h, _)| o == "print" && h == "box"),
        "{:?}",
        tall.report.collisions
    );
    let c = tall
        .report
        .collisions
        .iter()
        .find(|c| matches!(c.kind, Kind::ToolChange | Kind::Dock))
        .unwrap();
    assert_eq!(c.severity, Severity::Hit);
    assert!(c.change.is_some(), "{c:?}");
    assert!(c.hit_height_mm > 29.0, "{c:?}");
    // The trip passes 3 mm over the layer it leaves, far above a 1 mm box.
    let short = box_before_print(1.0, h3c(2));
    assert!(trips(&short).is_empty(), "{:?}", short.report.collisions);
}

#[test]
fn two_filaments_on_one_hotend_swap_at_the_chute_and_never_cross_to_the_rack() {
    let mut c = h3c(2);
    c.insert("filament_map_mode".into(), json!("Manual"));
    c.insert("filament_nozzle_map".into(), json!([0, 0]));
    let r = box_before_print(30.0, c);
    assert_eq!(hotend_changes(&r), ["0>0"]);
    // The chute is at the back right, away from the box in front of the print.
    assert!(trips(&r).is_empty(), "{:?}", r.report.collisions);
}

/// A box of 25 mm at the front edge, under the head where it runs along the docks of hotends 3 to 5, printed first,
/// and the two color print on filaments 1 and 5 at the back left.
fn front_box_plate(config: Map<String, Value>) -> SliceRun {
    run(
        &[
            ("front", block("front", 30.0, 10.0, 25.0), 120.0, 1.0),
            ("print", two_color(5), 26.0, 243.0),
        ],
        config,
    )
}

#[test]
fn a_change_goes_to_the_docks_of_the_hotends_the_filament_map_gives() {
    // On their own, filaments 1 and 5 print on hotends 0 and 1: the docks at the left end of the rack, clear of the box.
    let auto = front_box_plate(h3c(5));
    assert_eq!(hotend_changes(&auto), ["0>1", "1>0"]);
    assert!(trips(&auto).is_empty(), "{:?}", auto.report.collisions);
    // Mapped by hand to hotend 4, filament 5's PrintTool sits in the middle dock, and the run along the rack to it
    // passes over the box.
    let mut c = h3c(5);
    c.insert("filament_map_mode".into(), json!("Manual"));
    c.insert("filament_nozzle_map".into(), json!([0, 0, 0, 0, 4]));
    let manual = front_box_plate(c);
    assert_eq!(hotend_changes(&manual), ["0>4", "4>0"]);
    let hits = trips(&manual);
    assert!(
        hits.iter().any(|(o, h, _)| o == "print" && h == "front"),
        "{:?}",
        manual.report.collisions
    );
}

/// The Z each filament select (`T`) in a change block runs at: the last Z the G-code moved to before it.
fn z_at_changes(r: &SliceRun) -> Vec<f64> {
    let g = String::from_utf8(r.gcode.clone()).unwrap();
    let mut z = 0.0;
    let mut out = Vec::new();
    let mut in_change = false;
    for l in g.lines() {
        let c = l.split(';').next().unwrap_or("").trim();
        if c.starts_with("M620 S") {
            in_change = true;
        } else if c.starts_with("M621 S") {
            in_change = false;
        } else if in_change && c.starts_with('T') {
            out.push(z);
        } else if (c.starts_with("G1") || c.starts_with("G0"))
            && let Some(v) = c
                .split_whitespace()
                .find_map(|w| w.strip_prefix('Z')?.parse::<f64>().ok())
        {
            z = v;
        }
    }
    out
}

#[test]
fn the_makers_change_gcode_lifts_over_everything_printed_before_so_the_trips_clear() {
    let mut c = h3c(2);
    let doc = common::shipped_gcode::doc();
    let family = doc["models"]["bambu-h3c"]
        .as_str()
        .expect("the H3C has a G-code family");
    let change = doc["families"][family]["changeFilament"].clone();
    assert!(change.as_str().unwrap().contains("G1 Z{max_layer_z + 3.0}"));
    c.insert("change_filament_gcode".into(), change);
    let r = box_before_print(30.0, c);
    // Every swap runs 3 mm over the 30 mm box, the tallest object printed before the print's changes.
    let zs = z_at_changes(&r);
    assert!(!zs.is_empty());
    assert!(zs.iter().all(|&z| z >= 33.0 - 1e-6), "{zs:?}");
    assert!(trips(&r).is_empty(), "{:?}", r.report.collisions);
}
