// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Process values per extruder: a printer whose extruder variants give a process setting one value per extruder
//! (`print_extruder_variant`) prints each filament with the values of the extruder it is mapped to. The X2D's
//! right extruder is a Bowden one, with its own wall and infill speeds and a 1000 mm/s2 acceleration; an H2D
//! with a high flow nozzle on the right has faster walls and infill there. Each path's speed (F) and acceleration
//! (M204) follow its own filament's extruder, and the left extruder keeps its values.
//!
//! The configs are the shipped machine settings and the maker's 0.20 mm Standard process with all its variant
//! values, as a project from the maker's slicer carries them. Cooling slowdown, overhang speeds, small loop
//! speeds and the volumetric limit are off, so every path prints at its setting.

#![allow(clippy::disallowed_methods)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};
use sx_core::api::{self, Mesh, SliceRequest};
mod common;

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

fn cuboid(x: [f32; 2], y: [f32; 2], z: [f32; 2], slot: u8) -> api::MeshPart {
    let mut positions = Vec::new();
    for zi in z {
        for (xi, yi) in [(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])] {
            positions.push([xi, yi, zi]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    api::MeshPart {
        name: "box".into(),
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

/// A 30 x 20 mm table, 8 mm tall: two legs and a slab, so the slab's first layer bridges between the legs.
fn table() -> Mesh {
    Mesh {
        name: "table".into(),
        parts: vec![
            cuboid([0.0, 5.0], [0.0, 20.0], [0.0, 6.0], 1),
            cuboid([25.0, 30.0], [0.0, 20.0], [0.0, 6.0], 1),
            cuboid([0.0, 30.0], [0.0, 20.0], [5.8, 8.0], 1),
        ],
        ..Mesh::default()
    }
}

/// A shipped two-extruder Bambu Lab printer (`model` in the profiles) with the maker's 0.20 mm Standard process
/// (`preset`), all its variant values kept, and the nozzle types `volumes`.
fn printer(model: &str, name: &str, preset: &str, volumes: [&str; 2]) -> Value {
    let mut c = read("packages/profiles/machine.json")["models"][model]["machine"].clone();
    let process = read("packages/profiles/process-speeds.json")["presets"]
        [format!("Bambu Studio/BBL/0.20mm Standard @BBL {preset}")]
    .clone();
    for (k, v) in process.as_object().unwrap() {
        c[k] = v.clone();
    }
    for (k, v) in [
        ("printer_model", json!(name)),
        ("gcode_flavor", json!("bambu")),
        ("single_extruder_multi_material", json!(true)),
        ("nozzle_volume_type", json!(volumes)),
        ("filament_map_mode", json!("Manual")),
        ("filament_colour", json!(["#FF0000", "#00FF00"])),
        ("filament_max_volumetric_speed", json!([100, 100])),
        ("slow_down_for_layer_cooling", json!(false)),
        ("enable_overhang_speed", json!(false)),
        ("small_perimeter_threshold", json!(0)),
        ("wipe_tower_x", json!([120])),
        ("wipe_tower_y", json!([200])),
        ("brim_width", json!(0)),
        ("skirt_loops", json!(0)),
    ] {
        c[k] = v;
    }
    c
}

fn x2d() -> Value {
    printer("bambu-x2d", "Bambu Lab X2D", "X2D", ["Standard", "Standard"])
}

fn h2d_high_flow() -> Value {
    printer("bambu-h2d", "Bambu Lab H2D", "H2D", ["Standard", "High Flow"])
}

/// Per filament slot (1-based) and feature, above the first layer: the highest F (mm/s) of its extrusions and the
/// accelerations (M204 S) they run at.
type Seen = BTreeMap<(u8, String), (f64, Vec<u32>)>;

fn seen(gcode: &str) -> Seen {
    let mut out: Seen = BTreeMap::new();
    let (mut feature, mut tool, mut accel, mut feed, mut layer) = (String::new(), 1u8, 0u32, 0.0f64, 0u32);
    for l in gcode.lines() {
        if let Some(f) = l.strip_prefix("; FEATURE: ") {
            f.trim().clone_into(&mut feature);
        } else if l.starts_with("; CHANGE_LAYER") || l.starts_with(";LAYER_CHANGE") {
            layer += 1;
        } else if let Some(t) = l.strip_prefix('T').and_then(|t| t.split_whitespace().next()) {
            if let Some(n) = t.parse::<u8>().ok().filter(|n| *n < 64) {
                tool = n + 1;
            }
        } else if let Some(s) = l.strip_prefix("M204 S") {
            accel = s
                .split_whitespace()
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
        } else if l.starts_with("G1 ") || l.starts_with("G2 ") || l.starts_with("G3 ") {
            let word = |c: char| {
                l.split_whitespace()
                    .find_map(|w| w.strip_prefix(c)?.parse::<f64>().ok())
            };
            if let Some(f) = word('F') {
                feed = f / 60.0;
            }
            let moves = word('X').is_some() || word('Y').is_some();
            if layer > 1 && moves && word('E').is_some_and(|e| e > 0.0) {
                let entry = out.entry((tool, feature.clone())).or_insert((0.0, Vec::new()));
                entry.0 = entry.0.max(feed);
                if !entry.1.contains(&accel) {
                    entry.1.push(accel);
                }
            }
        }
    }
    out
}

/// The G-code of `objects` (mesh, slot, x) on `config`, with support when `support`.
fn slice(config: &Value, objects: &[(Mesh, u8, f64)], support: bool) -> String {
    slice_with(config, objects, support, &[])
}

/// [`slice`] with each object's settings of its own (`settings`, by object; none past its end or when null).
fn slice_with(config: &Value, objects: &[(Mesh, u8, f64)], support: bool, settings: &[Value]) -> String {
    let mut cfg = config.clone();
    let map: Vec<Value> = (1..=2u8)
        .map(|s| json!(objects.iter().find(|o| o.1 == s).map_or(1, |o| o.1)))
        .collect();
    cfg["filament_map"] = Value::Array(map);
    if support {
        cfg["enable_support"] = json!(true);
        cfg["support_type"] = json!("normal(auto)");
    }
    let meshes: Vec<Arc<Mesh>> = objects
        .iter()
        .map(|(m, slot, _)| {
            let mut m = m.clone();
            for p in &mut m.parts {
                p.slot = *slot;
            }
            Arc::new(m)
        })
        .collect();
    let plate: Vec<Value> = objects
        .iter()
        .enumerate()
        .map(|(i, (_, _, x))| {
            let mut o = json!({"id": format!("o{i}"), "mesh": i.to_string(),
                   "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, x,100,0,1]});
            if let Some(own) = settings.get(i).filter(|v| !v.is_null()) {
                o["settings"] = own.clone();
            }
            o
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": plate},
        "config": cfg,
        "options": {"trustedGcode": true},
    }))
    .expect("request");
    let run = common::run_request(&req, &move |id: &str| {
        Ok(meshes[id.parse::<usize>().unwrap()].clone())
    })
    .expect("slice");
    String::from_utf8(run.gcode.clone()).unwrap()
}

/// What `printer` prints the table with, on filament slot `slot` mapped to extruder `slot`, with support.
fn on(printer: fn() -> Value, slot: u8) -> Seen {
    seen(&slice(&printer(), &[(table(), slot, 110.0)], true))
}

fn cached(cell: &'static OnceLock<Seen>, printer: fn() -> Value, slot: u8) -> &'static Seen {
    cell.get_or_init(|| on(printer, slot))
}

static X2D_LEFT: OnceLock<Seen> = OnceLock::new();
static X2D_RIGHT: OnceLock<Seen> = OnceLock::new();
static H2D_LEFT: OnceLock<Seen> = OnceLock::new();
static H2D_RIGHT: OnceLock<Seen> = OnceLock::new();

/// The feature's top speed and its accelerations on slot `slot`.
fn feature<'a>(s: &'a Seen, slot: u8, name: &str) -> &'a (f64, Vec<u32>) {
    s.get(&(slot, name.to_owned()))
        .unwrap_or_else(|| panic!("no {name} on slot {slot}: {:?}", s.keys().collect::<Vec<_>>()))
}

/// On each printer: the feature's speed and acceleration on the right extruder, then on the left one.
fn check(
    name: &str,
    x2d_right: (f64, u32),
    x2d_left: (f64, u32),
    h2d_right: (f64, u32),
    h2d_left: (f64, u32),
) {
    for (seen, slot, (speed, accel)) in [
        (cached(&X2D_RIGHT, x2d, 2), 2, x2d_right),
        (cached(&X2D_LEFT, x2d, 1), 1, x2d_left),
        (cached(&H2D_RIGHT, h2d_high_flow, 2), 2, h2d_right),
        (cached(&H2D_LEFT, h2d_high_flow, 1), 1, h2d_left),
    ] {
        let (top, accels) = feature(seen, slot, name);
        assert!(
            (top - speed).abs() < 0.5,
            "{name} on slot {slot}: {top} mm/s, want {speed}"
        );
        assert_eq!(accels, &vec![accel], "{name} on slot {slot}");
    }
}

// The values (mm/s, mm/s2) are the presets': X2D left 200 outer, 300 inner, 270 sparse, 250 solid at 10000 (outer
// 5000), right 50, 200, 200, 200 at 1000; H2D left 200, 300, 350, 250 at 8000 (outer 5000), right high flow 500,
// 600, 600, 600. Bridges accelerate at half the outer wall's; support at the default.

#[test]
fn outer_walls_print_at_their_extruders_speed() {
    check(
        "Outer wall",
        (50.0, 1000),
        (200.0, 5000),
        (500.0, 5000),
        (200.0, 5000),
    );
}

#[test]
fn inner_walls_print_at_their_extruders_speed() {
    check(
        "Inner wall",
        (200.0, 1000),
        (300.0, 10000),
        (600.0, 8000),
        (300.0, 8000),
    );
}

#[test]
fn sparse_infill_prints_at_its_extruders_speed() {
    check(
        "Sparse infill",
        (200.0, 1000),
        (270.0, 10000),
        (600.0, 8000),
        (350.0, 8000),
    );
}

#[test]
fn solid_infill_prints_at_its_extruders_speed() {
    check(
        "Internal solid infill",
        (200.0, 1000),
        (250.0, 10000),
        (600.0, 8000),
        (250.0, 8000),
    );
}

#[test]
fn bridges_accelerate_as_their_extruder_says() {
    check("Bridge", (50.0, 500), (50.0, 2500), (50.0, 2500), (50.0, 2500));
}

#[test]
fn support_accelerates_as_its_extruder_says() {
    check(
        "Support",
        (150.0, 1000),
        (150.0, 10000),
        (150.0, 8000),
        (150.0, 8000),
    );
}

#[test]
fn two_objects_on_two_extruders_each_print_with_their_own_values() {
    // Two cubes on one plate, one per extruder: wherever the layer's paths are ordered, each keeps its own.
    let cube = || Mesh {
        name: "cube".into(),
        parts: vec![cuboid([0.0, 15.0], [0.0, 15.0], [0.0, 3.0], 1)],
        ..Mesh::default()
    };
    let objects = [(cube(), 1, 90.0), (cube(), 2, 150.0)];
    // Also with settings of its own on the first cube: each cube slices on its own and the plate regroups the layer.
    for own in [Value::Null, json!({"wall_loops": 3})] {
        let s = seen(&slice_with(&x2d(), &objects, false, &[own]));
        for (slot, outer, inner, accel) in [(1, 200.0, 300.0, 5000), (2, 50.0, 200.0, 1000)] {
            let (top, accels) = feature(&s, slot, "Outer wall");
            assert!((top - outer).abs() < 0.5, "outer wall on slot {slot}: {top}");
            assert_eq!(accels, &vec![accel], "outer wall on slot {slot}");
            let (top, _) = feature(&s, slot, "Inner wall");
            assert!((top - inner).abs() < 0.5, "inner wall on slot {slot}: {top}");
        }
    }
}
