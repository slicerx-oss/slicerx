// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Print by object with each object on a filament of its own: the switch to the next object's filament runs
//! the printer's change G-code (on a Bambu Lab printer the AMS block, M620 to M621), counts as a tool change,
//! and the same in any layer ranges.

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

/// A 10 mm box of `h` mm on filament `slot`.
fn block(h: f32, slot: u8) -> Arc<Mesh> {
    let mut positions = Vec::new();
    for z in [0.0, h] {
        for (x, y) in [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)] {
            positions.push([x, y, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    Arc::new(Mesh {
        name: format!("block {slot}"),
        parts: vec![MeshPart {
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
        }],
        ..Mesh::default()
    })
}

/// Three blocks in a row, the first on filament 2, then 3, then 1, printed by object with a Bambu style
/// change block.
fn request() -> SliceRequest {
    let objects: Vec<Value> = [("a", 60.0), ("b", 120.0), ("c", 180.0)]
        .iter()
        .map(|&(id, x)| {
            json!({"id": id, "name": id, "mesh": id, "transform": [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, 128.0, 0.0, 1.0]})
        })
        .collect();
    serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": common::with_base(&json!({
            "print_sequence": "by object",
            "brim_width": 0,
            "skirt_loops": 0,
            "enable_prime_tower": false,
            "change_filament_gcode": "M620 S[next_extruder]A\nT[next_extruder]\nM621 S[next_extruder]A",
        })),
        "options": {"flavor": "marlin2", "allowCollisions": true},
    }))
    .unwrap()
}

#[allow(
    clippy::unnecessary_wraps,
    reason = "the plate's mesh loader returns a Result"
)]
fn meshes(id: &str) -> sx_core::Result<Arc<Mesh>> {
    Ok(match id {
        "a" => block(4.0, 2),
        "b" => block(3.0, 3),
        _ => block(2.0, 1),
    })
}

/// The G-code in `shards` layer ranges, each on a fresh session.
fn ranges(req: &SliceRequest, shards: u32) -> Vec<u8> {
    let (config, _) = api::request_config_checked(req).unwrap();
    let plate = api::build_plate(req, &meshes).unwrap();
    let n = api::build_session(req, &plate, &config).unwrap().layer_count();
    let mut out = vec![Vec::new(); shards as usize];
    for s in 0..shards {
        let session = api::build_session(req, &plate, &config).unwrap();
        api::slice_shard(
            req,
            &session,
            &config,
            n * s / shards..n * (s + 1) / shards,
            &sx_core::NoProgress,
            &mut out[s as usize],
        )
        .unwrap();
    }
    out.concat()
}

#[test]
fn each_object_on_a_filament_of_its_own_switches_with_the_change_gcode() {
    let req = request();
    let run = common::run_request(&req, &meshes).unwrap();
    let g = String::from_utf8(run.gcode).unwrap();
    let lines: Vec<&str> = g.lines().collect();
    // Two switches between the three objects, each the profile's whole change block.
    for slot in ["S2A", "S0A"] {
        let at = lines
            .iter()
            .position(|l| *l == format!("M620 {slot}"))
            .unwrap_or_else(|| panic!("no M620 {slot}"));
        let t = format!("T{}", &slot[1..2]);
        assert_eq!(lines.get(at + 1), Some(&t.as_str()), "M620 {slot}");
        assert_eq!(lines.get(at + 2).copied(), Some(format!("M621 {slot}").as_str()));
    }
    assert_eq!(run.report.stats.tool_changes, 2);
    // The one bare tool select is the first object's first; no layer selects its filament again.
    let bare: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(i, l)| {
            l.len() >= 2
                && l.starts_with('T')
                && l[1..].bytes().all(|b| b.is_ascii_digit())
                && !lines
                    .get(i.wrapping_sub(1))
                    .is_some_and(|p| p.starts_with("M620 "))
        })
        .map(|(i, _)| i)
        .collect();
    assert_eq!(bare.len(), 1, "bare tool selects at lines {bare:?}");
}

#[test]
fn the_object_switches_are_the_same_in_any_layer_ranges() {
    let req = request();
    let one = ranges(&req, 1);
    for shards in [4, 8] {
        assert!(ranges(&req, shards) == one, "{shards} ranges");
    }
}
