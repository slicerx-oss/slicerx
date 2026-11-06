// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Nozzles of different sizes on one printer: each object prints with the nozzle its filament goes to, and that
//! object's line widths and layer heights follow the nozzle. A tool changer prints filament n on tool n; a printer
//! whose two nozzles share the filaments by a map (the Bambu Lab H2D) does so with the map set by hand. On its
//! automatic map, picked only after the objects are sliced, every object prints with the first nozzle's settings and
//! the slice warns. An object is printed with one nozzle size, and a prime tower keeps the plate at one layer height.
//!
//! The plate is two 12 mm cubes, "left" at x 70 and "right" at x 150. Which object a move belongs to is read from its
//! position; widths and heights come from the width and height lines, and the filament from E over the
//! path length (arcs measured along the arc).

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::float_cmp,
    clippy::many_single_char_names,
    clippy::too_many_lines,
    clippy::needless_pass_by_value,
    reason = "a G-code reader for the test: plate coordinates in mm, one pass over the lines"
)]

use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest, SliceRun};
mod common;

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn cuboid(name: &str, size: f32, slot: u8) -> api::MeshPart {
    let (x, y, z) = ([0.0, size], [0.0, size], [0.0, size]);
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
        name: name.into(),
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

/// A 12 mm cube on `slot`.
fn cube(slot: u8) -> Mesh {
    Mesh {
        name: "cube".into(),
        parts: vec![cuboid("cube", 12.0, slot)],
        ..Mesh::default()
    }
}

/// A 12 mm cube made of two parts side by side, the left half on `a`, the right half on `b`.
fn two_part_cube(a: u8, b: u8) -> Mesh {
    let mut left = cuboid("half a", 12.0, a);
    let mut right = cuboid("half b", 12.0, b);
    for p in &mut left.positions {
        p[0] *= 0.5;
    }
    for p in &mut right.positions {
        p[0] = 6.0 + p[0] * 0.5;
    }
    Mesh {
        name: "halves".into(),
        parts: vec![left, right],
        ..Mesh::default()
    }
}

/// A tool changer with two tools of the sizes given (filament n on tool n), automatic line widths.
fn changer(sizes: [&str; 2]) -> Value {
    json!({
        "printer_model": "Generic tool changer",
        "gcode_flavor": "klipper",
        "single_extruder_multi_material": false,
        "nozzle_diameter": sizes,
        "nozzle_temperature": [220, 220],
        "filament_diameter": [1.75, 1.75],
        "line_width": "0",
        "outer_wall_line_width": "0",
        "inner_wall_line_width": "0",
        "sparse_infill_line_width": "0",
        "internal_solid_infill_line_width": "0",
        "top_surface_line_width": "0",
        "initial_layer_line_width": "0",
        "support_line_width": "0",
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "brim_width": 0,
        "enable_prime_tower": false,
        "slow_down_for_layer_cooling": false,
    })
}

/// The shipped H2D machine with nozzles of the sizes given, filaments 1 and 2 by `map` (`None` for the automatic map).
fn h2d(sizes: [&str; 2], map: Option<[u8; 2]>) -> Value {
    let models: Value =
        serde_json::from_slice(&std::fs::read(format!("{}/packages/profiles/machine.json", root())).unwrap())
            .unwrap();
    let mut c = models["models"]["bambu-h2d"]["machine"].clone();
    for (k, v) in [
        ("printer_model", json!("Bambu Lab H2D")),
        ("gcode_flavor", json!("bambu")),
        ("single_extruder_multi_material", json!(true)),
        ("nozzle_diameter", json!(sizes)),
        ("filament_colour", json!(["#FF0000", "#00FF00"])),
        ("nozzle_temperature", json!([220, 220])),
        ("outer_wall_line_width", json!(["0.42", "0.62"])),
        ("inner_wall_line_width", json!(["0.45", "0.62"])),
        ("layer_height", json!(["0.2", "0.3"])),
        ("enable_prime_tower", json!(false)),
        ("brim_width", json!(0)),
        ("skirt_loops", json!(0)),
        ("slow_down_for_layer_cooling", json!(false)),
    ] {
        c[k] = v;
    }
    match map {
        Some(m) => {
            c["filament_map_mode"] = json!("Manual");
            c["filament_map"] = json!(m);
        }
        None => c["filament_map_mode"] = json!("Auto For Flush"),
    }
    c
}

/// Slices `objects` (mesh, x, own settings) on `config` over the request tests' base.
fn slice(config: &Value, objects: Vec<(Mesh, f64, Value)>) -> sx_core::Result<SliceRun> {
    let meshes: Vec<Arc<Mesh>> = objects.iter().map(|o| Arc::new(o.0.clone())).collect();
    let plate: Vec<Value> = objects
        .iter()
        .enumerate()
        .map(|(i, (_, x, own))| {
            let name = if i == 0 { "left" } else { "right" };
            let mut o = json!({"id": name, "name": name, "mesh": i.to_string(),
                "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, x,100,0,1]});
            if !own.is_null() {
                o["settings"] = own.clone();
            }
            o
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": plate},
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .expect("request");
    common::run_request(&req, &move |id: &str| {
        Ok(meshes[id.parse::<usize>().unwrap()].clone())
    })
}

/// What one object printed: its nozzle heights (rounded to 0.001 mm), the width lines of its outer walls above the
/// first layer, the heights stated over its moves other than bridges above the first layer, its tools, and its outer
/// wall filament per mm of path on each layer.
#[derive(Default, Debug)]
struct Printed {
    z: BTreeSet<i64>,
    outer_widths: BTreeSet<i64>,
    heights: BTreeSet<i64>,
    tools: BTreeSet<u8>,
    outer_e: BTreeMap<i64, (f64, f64)>,
}

impl Printed {
    fn zs(&self) -> Vec<f64> {
        self.z.iter().map(|&z| z as f64 / 1000.0).collect()
    }

    /// Outer wall filament per mm on the layer at `z`.
    fn e_per_mm(&self, z: f64) -> f64 {
        let (e, l) = self.outer_e[&((z * 1000.0).round() as i64)];
        e / l
    }
}

fn thou(v: f64) -> i64 {
    (v * 1000.0).round() as i64
}

/// Reads the G-code: left object below x 110, right above.
fn read(gcode: &str) -> BTreeMap<&'static str, Printed> {
    let mut out: BTreeMap<&'static str, Printed> = BTreeMap::new();
    let (mut x, mut y, mut z, mut e_abs) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut relative, mut tool, mut width, mut height) = (false, 0u8, 0.0f64, 0.0f64);
    let mut feature = String::new();
    let first_z = std::cell::Cell::new(None::<f64>);
    for raw in gcode.lines() {
        let l = raw.trim();
        if let Some(t) = l.strip_prefix(";TYPE:").or_else(|| l.strip_prefix("; FEATURE: ")) {
            t.trim().clone_into(&mut feature);
            continue;
        }
        // A Bambu Lab printer's file names them `; LINE_WIDTH: ` and `; LAYER_HEIGHT: `.
        if let Some(w) = l
            .strip_prefix(";WIDTH:")
            .or_else(|| l.strip_prefix("; LINE_WIDTH: "))
        {
            width = w.trim().parse().unwrap_or(width);
            continue;
        }
        if let Some(h) = l
            .strip_prefix(";HEIGHT:")
            .or_else(|| l.strip_prefix("; LAYER_HEIGHT: "))
        {
            height = h.trim().parse().unwrap_or(height);
            continue;
        }
        let code = l.split(';').next().unwrap_or("").trim();
        if code.starts_with("M83") {
            relative = true;
        } else if code.starts_with("M82") {
            relative = false;
        } else if let Some(rest) = code.strip_prefix("G92") {
            if let Some(v) = rest.split_whitespace().find_map(|w| w.strip_prefix('E')) {
                e_abs = v.parse().unwrap_or(0.0);
            }
        } else if let Some(t) = code.strip_prefix('T')
            && let Ok(n) = t.split_whitespace().next().unwrap_or("").parse::<u8>()
            && n < 64
        {
            tool = n;
        }
        let g = code.split_whitespace().next().unwrap_or("");
        if !matches!(g, "G0" | "G1" | "G2" | "G3") {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .skip(1)
                .find_map(|w| w.strip_prefix(c)?.parse::<f64>().ok())
        };
        let (nx, ny) = (word('X').unwrap_or(x), word('Y').unwrap_or(y));
        z = word('Z').unwrap_or(z);
        let de = match word('E') {
            Some(v) if relative => v,
            Some(v) => {
                let d = v - e_abs;
                e_abs = v;
                d
            }
            None => 0.0,
        };
        let len = match (g, word('I'), word('J')) {
            ("G2" | "G3", i, j) if i.is_some() || j.is_some() => {
                let (cx, cy) = (x + i.unwrap_or(0.0), y + j.unwrap_or(0.0));
                let r = (x - cx).hypot(y - cy);
                let a0 = (y - cy).atan2(x - cx);
                let a1 = (ny - cy).atan2(nx - cx);
                let mut da = a1 - a0;
                if g == "G2" && da >= 0.0 {
                    da -= std::f64::consts::TAU;
                }
                if g == "G3" && da <= 0.0 {
                    da += std::f64::consts::TAU;
                }
                da.abs() * r
            }
            _ => (nx - x).hypot(ny - y),
        };
        if de > 0.0 && len > 0.0 && (nx - x).abs() + (ny - y).abs() > 0.0 {
            let mid = f64::midpoint(x, nx);
            let name = if mid < 110.0 { "left" } else { "right" };
            let p = out.entry(name).or_default();
            p.z.insert(thou(z));
            p.tools.insert(tool);
            if first_z.get().is_none() {
                first_z.set(Some(z));
            }
            let above_first = first_z.get().is_some_and(|f| z > f + 1e-6);
            // Bridge strands state their own round bead's height.
            if above_first && !feature.to_ascii_lowercase().contains("bridge") {
                p.heights.insert(thou(height));
            }
            if feature.eq_ignore_ascii_case("Outer wall") {
                if above_first {
                    p.outer_widths.insert(thou(width));
                }
                let entry = p.outer_e.entry(thou(z)).or_insert((0.0, 0.0));
                entry.0 += de;
                entry.1 += len;
            }
        }
        x = nx;
        y = ny;
    }
    out
}

fn gcode(run: &SliceRun) -> String {
    String::from_utf8(run.gcode.clone()).unwrap()
}

fn expect_refusal(r: sx_core::Result<SliceRun>, key: &str, words: &[&str]) -> String {
    let e = match r {
        Ok(_) => panic!("expected a refusal naming {key}, the plate sliced"),
        Err(e) => e.to_string(),
    };
    assert!(e.contains(&format!("config key {key}")), "{e}");
    for w in words {
        assert!(e.contains(w), "{e} should say {w:?}");
    }
    e
}

/// Heights from `first`, then `step` apart, up to `top` (inclusive within half a step).
fn tops(first: f64, step: f64, top: f64) -> Vec<f64> {
    let mut v = vec![first];
    let mut z = first;
    while z + step < top + step / 2.0 {
        z += step;
        v.push((z * 1000.0).round() / 1000.0);
    }
    v
}

#[test]
fn a_tool_changer_prints_each_object_with_its_tools_nozzle() {
    let mut c = changer(["0.4", "0.6"]);
    c["layer_height"] = json!([0.2, 0.3]);
    let run = slice(
        &c,
        vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
    )
    .unwrap();
    let p = read(&gcode(&run));
    let (left, right) = (&p["left"], &p["right"]);
    assert_eq!(left.tools, BTreeSet::from([0]));
    assert_eq!(right.tools, BTreeSet::from([1]));
    // Automatic widths: 1.125 times the nozzle.
    assert_eq!(left.outer_widths, BTreeSet::from([450]), "left walls");
    assert_eq!(right.outer_widths, BTreeSet::from([675]), "right walls");
    // Each nozzle's layer height over the plate's shared first layer.
    assert_eq!(left.zs(), tops(0.2, 0.2, 12.0));
    assert_eq!(right.zs(), tops(0.2, 0.3, 12.0));
    // The right object's walls take the filament of a 0.675 mm bead 0.3 mm tall.
    let bead = |w: f64, h: f64| (w - h) * h + std::f64::consts::PI * (h / 2.0) * (h / 2.0);
    let ratio = right.e_per_mm(2.0) / left.e_per_mm(2.0);
    let want = bead(0.675, 0.3) / bead(0.45, 0.2);
    assert!(
        (ratio - want).abs() / want < 0.03,
        "filament ratio {ratio}, want {want}"
    );
}

#[test]
fn the_object_on_the_first_nozzle_prints_as_on_a_plate_of_one_size() {
    let mixed = changer(["0.4", "0.6"]);
    let same = changer(["0.4", "0.4"]);
    let a = read(&gcode(
        &slice(
            &mixed,
            vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
        )
        .unwrap(),
    ));
    let b = read(&gcode(
        &slice(
            &same,
            vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
        )
        .unwrap(),
    ));
    assert_eq!(a["left"].z, b["left"].z);
    assert_eq!(a["left"].outer_widths, b["left"].outer_widths);
    for z in [1.0, 6.0, 11.0] {
        let (x, y) = (a["left"].e_per_mm(z), b["left"].e_per_mm(z));
        assert!((x - y).abs() / y < 0.001, "z {z}: {x} against {y}");
    }
    // On the plate of one size both objects print alike.
    assert_eq!(b["right"].outer_widths, b["left"].outer_widths);
}

#[test]
fn a_two_nozzle_printer_with_a_map_set_by_hand_prints_each_object_with_its_nozzle() {
    let c = h2d(["0.4", "0.6"], Some([1, 2]));
    let run = slice(
        &c,
        vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
    )
    .unwrap();
    let p = read(&gcode(&run));
    assert_eq!(p["left"].outer_widths, BTreeSet::from([420]), "left walls");
    assert_eq!(p["right"].outer_widths, BTreeSet::from([620]), "right walls");
    assert_eq!(p["left"].zs(), tops(0.2, 0.2, 12.0));
    assert_eq!(p["right"].zs(), tops(0.2, 0.3, 12.0));
}

#[test]
fn the_slice_report_names_each_objects_nozzle_when_the_sizes_differ() {
    let c = h2d(["0.4", "0.6"], Some([1, 2]));
    let run = slice(
        &c,
        vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
    )
    .unwrap();
    let report = serde_json::to_value(&run.report).unwrap();
    let by: BTreeMap<String, Value> = report["featureFilaments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| (o["object"].as_str().unwrap().to_owned(), o["nozzleMm"].clone()))
        .collect();
    assert_eq!(by["left"], json!(0.4));
    assert_eq!(by["right"], json!(0.6));
    // Nozzles of one size: no nozzle in the report, as before.
    let same = h2d(["0.4", "0.4"], Some([1, 2]));
    let run = slice(
        &same,
        vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
    )
    .unwrap();
    let report = serde_json::to_value(&run.report).unwrap();
    assert!(
        report["featureFilaments"]
            .as_array()
            .unwrap()
            .iter()
            .all(|o| o.get("nozzleMm").is_none()),
        "{}",
        report["featureFilaments"]
    );
}

#[test]
fn an_automatic_map_with_nozzles_of_different_sizes_is_refused() {
    // The automatic map is picked after the objects are sliced, but each object's nozzle must be known before: the
    // plate is refused, naming both sizes and how to set the map.
    let c = h2d(["0.4", "0.6"], None);
    expect_refusal(
        slice(
            &c,
            vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
        ),
        "filament_map",
        &[
            "left 0.4 mm, right 0.6 mm",
            "pick a nozzle for each object",
            "filament map by hand",
        ],
    );
    // Nozzles of one size keep the automatic map, with no warning.
    let same = h2d(["0.4", "0.4"], None);
    let run = slice(
        &same,
        vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
    )
    .unwrap();
    assert!(
        !run.report
            .warnings
            .iter()
            .any(|w| w.message.contains("filament map")),
        "{:?}",
        run.report.warnings
    );
}

#[test]
fn an_object_on_nozzles_of_two_sizes_is_refused() {
    let c = changer(["0.4", "0.6"]);
    // Parts on both nozzles.
    expect_refusal(
        slice(&c, vec![(two_part_cube(1, 2), 70.0, Value::Null)]),
        "plate.objects.settings",
        &["left", "0.4 mm", "0.6 mm"],
    );
    // A feature moved to the other nozzle.
    expect_refusal(
        slice(
            &c,
            vec![
                (cube(1), 70.0, json!({"outer_wall_filament_id": 2})),
                (cube(2), 150.0, Value::Null),
            ],
        ),
        "plate.objects.settings",
        &["left", "0.4 mm", "0.6 mm"],
    );
    // Supports on the other nozzle.
    let mut s = c.clone();
    s["enable_support"] = json!(true);
    s["support_filament"] = json!(2);
    expect_refusal(
        slice(&s, vec![(cube(1), 70.0, Value::Null)]),
        "plate.objects.settings",
        &["left", "0.4 mm", "0.6 mm"],
    );
    // Two tools of one size are one nozzle size.
    let same = changer(["0.4", "0.4"]);
    slice(&same, vec![(two_part_cube(1, 2), 70.0, Value::Null)]).unwrap();
}

#[test]
fn layer_height_limits_follow_each_objects_nozzle() {
    let c = changer(["0.4", "0.6"]);
    let ok = slice(
        &c,
        vec![
            (cube(1), 70.0, Value::Null),
            (cube(2), 150.0, json!({"layer_height": 0.5})),
        ],
    )
    .unwrap();
    assert_eq!(read(&gcode(&ok))["right"].zs(), tops(0.2, 0.5, 12.0));
    expect_refusal(
        slice(
            &c,
            vec![
                (cube(1), 70.0, json!({"layer_height": 0.5})),
                (cube(2), 150.0, Value::Null),
            ],
        ),
        "layer_height",
        &["0.4 mm nozzle"],
    );
}

#[test]
fn a_first_layer_taller_than_a_nozzle_in_use_is_refused() {
    let mut c = changer(["0.4", "0.25"]);
    c["initial_layer_print_height"] = json!(0.3);
    expect_refusal(
        slice(
            &c,
            vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
        ),
        "initial_layer_print_height",
        &["right", "0.25 mm"],
    );
    // With the small nozzle unused the plate slices.
    slice(&c, vec![(cube(1), 70.0, Value::Null)]).unwrap();
}

#[test]
fn a_prime_tower_keeps_one_layer_height_and_each_nozzles_widths() {
    let mut c = changer(["0.4", "0.6"]);
    c["enable_prime_tower"] = json!(true);
    c["wipe_tower_x"] = json!([20]);
    c["wipe_tower_y"] = json!([200]);
    let run = slice(
        &c,
        vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
    )
    .unwrap();
    let p = read(&gcode(&run));
    assert_eq!(p["left"].outer_widths, BTreeSet::from([450]));
    assert_eq!(p["right"].outer_widths, BTreeSet::from([675]));
    assert_eq!(p["right"].zs(), p["left"].zs());
    c["layer_height"] = json!([0.2, 0.3]);
    let e = expect_refusal(
        slice(
            &c,
            vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
        ),
        "enable_prime_tower",
        &["one layer height", "right"],
    );
    let reason = e.trim_start_matches("config key enable_prime_tower: ");
    assert!(
        reason.starts_with("With a prime tower the plate prints at one layer height"),
        "{reason}"
    );
    assert!(
        reason.contains("Each nozzle keeps its own line widths; only the layer height is shared"),
        "{reason}"
    );
}

#[test]
fn a_shared_plate_layer_states_each_objects_own_height() {
    let c = changer(["0.4", "0.4"]);
    let run = slice(
        &c,
        vec![
            (cube(1), 70.0, Value::Null),
            (cube(1), 150.0, json!({"layer_height": 0.3})),
        ],
    )
    .unwrap();
    let p = read(&gcode(&run));
    // 0.8, 1.4 and the like are on both objects' layers.
    assert!(p["left"].z.contains(&800) && p["right"].z.contains(&800));
    assert_eq!(p["left"].heights, BTreeSet::from([200]), "left heights");
    assert_eq!(p["right"].heights, BTreeSet::from([300]), "right heights");
}

#[test]
fn a_set_width_far_from_its_nozzle_slices_with_a_warning() {
    let mut c = changer(["0.4", "0.8"]);
    c["outer_wall_line_width"] = json!(0.42);
    let run = slice(
        &c,
        vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
    )
    .unwrap();
    let p = read(&gcode(&run));
    // The width set applies as given on both nozzles.
    assert_eq!(p["right"].outer_widths, BTreeSet::from([420]));
    let warned: Vec<&str> = run
        .report
        .warnings
        .iter()
        .map(|w| w.message.as_str())
        .filter(|m| m.contains("right") && m.contains("0.8 mm nozzle"))
        .collect();
    assert_eq!(warned.len(), 1, "{:?}", run.report.warnings);
    assert!(warned[0].contains("outer_wall_line_width"), "{}", warned[0]);
    // Within its nozzle's range there is no warning.
    let near = changer(["0.4", "0.6"]);
    let run = slice(
        &near,
        vec![(cube(1), 70.0, Value::Null), (cube(2), 150.0, Value::Null)],
    )
    .unwrap();
    assert!(
        !run.report
            .warnings
            .iter()
            .any(|w| w.message.contains("nozzle") && w.message.contains("width")),
        "{:?}",
        run.report.warnings
    );
}
