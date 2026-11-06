// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `plate.placement` `arrange`: the distinct objects of a plate are packed on the printer's bed before the slice,
//! clear of its keep-out zones (`bed_exclude_area`, the nozzle wrap check corner), the extruder clearance apart when
//! the plate prints by object, and the normal spacing by layer. `sx arrange --request` gives the layout without
//! slicing, and names the objects with no room instead of overlapping them.
#![allow(clippy::too_many_lines, reason = "test plates spelled out in full")]
#![allow(clippy::disallowed_methods, reason = "test geometry, not engine output")]

use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::{Command, Output};

fn fixture(name: &str) -> String {
    format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// A temp dir that is removed when it drops.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The A1's settings from the request fixtures (its 256 mm bed and the nozzle wrap check corner at x 226 to 256, y
/// 224 to 256), with no prime tower, and `extra` on top.
fn a1(extra: &Value) -> Value {
    let req: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("xmark-2color-a1-request.json")).unwrap())
            .unwrap();
    let mut c = req["config"].clone();
    c["enable_prime_tower"] = json!(false);
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    c
}

/// A box object: the 20 mm fixture cube scaled to `size` (x, y, z mm), its front left corner at `at`.
fn part(name: &str, size: [f64; 3], at: [f64; 2]) -> Value {
    let [sx, sy, sz] = size.map(|s| s / 20.0);
    json!({
        "id": name,
        "name": name,
        "mesh": "c",
        "transform": [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, at[0], at[1], 0, 1],
    })
}

/// A request for `objects` on `config`, with `placement` when given.
fn request(config: &Value, objects: &[Value], placement: Option<&str>) -> Value {
    let mut plate = json!({"bed": {"widthMm": 256, "depthMm": 256, "heightMm": 256}, "objects": objects});
    if let Some(p) = placement {
        plate["placement"] = json!(p);
    }
    json!({
        "schemaVersion": 1,
        "meshes": {"c": fixture("cube.stl")},
        "plate": plate,
        "config": config,
        "options": {"emitGcode": true, "emitPreview": false, "trustedGcode": true},
    })
}

/// Runs `sx <command> --request <req>` (with `--out-dir` for a slice) in a fresh dir, and gives the run and the
/// G-code a slice wrote.
fn run(name: &str, command: &str, req: &Value) -> (Output, String) {
    let dir = TempDir(std::env::temp_dir().join(format!("sx-plate-arrange-{name}-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let path = dir.0.join("request.json");
    std::fs::write(&path, req.to_string()).unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_sx"));
    cmd.args([command, "--request"]).arg(&path);
    if command == "slice" {
        cmd.arg("--out-dir").arg(&dir.0);
    }
    let out = cmd.output().unwrap();
    let gcode = std::fs::read_to_string(dir.0.join("slice.gcode")).unwrap_or_default();
    (out, gcode)
}

fn stdout_json(out: &Output) -> Value {
    serde_json::from_slice(&out.stdout).unwrap_or(Value::Null)
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// The footprint box `[x0, y0, x1, y1]` of a cube object as `transform` places it on the bed.
fn footprint(transform: &Value) -> [f64; 4] {
    let t: Vec<f64> = transform
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for (x, y) in [(0.0, 0.0), (20.0, 0.0), (0.0, 20.0), (20.0, 20.0)] {
        let px = t[0] * x + t[4] * y + t[12];
        let py = t[1] * x + t[5] * y + t[13];
        b = [b[0].min(px), b[1].min(py), b[2].max(px), b[3].max(py)];
    }
    b
}

/// The gap between two boxes, mm: 0 when they touch or overlap.
fn box_gap(a: [f64; 4], b: [f64; 4]) -> f64 {
    let dx = (b[0] - a[2]).max(a[0] - b[2]).max(0.0);
    let dy = (b[1] - a[3]).max(a[1] - b[3]).max(0.0);
    dx.hypot(dy)
}

/// The arranged objects of `sx arrange`'s report (or a slice result's `arrange`), by id with their footprints.
fn placed(report: &Value) -> Vec<(String, [f64; 4])> {
    report["objects"]
        .as_array()
        .unwrap_or_else(|| panic!("no objects in {report}"))
        .iter()
        .map(|o| (o["id"].as_str().unwrap().to_owned(), footprint(&o["transform"])))
        .collect()
}

/// The extruding moves of the G-code, X and Y.
fn extruding(gcode: &str) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    for line in gcode.lines().filter(|l| l.starts_with("G1 ")) {
        let word = |c: char| {
            line.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        if let (Some(x), Some(y), Some(e)) = (word('X'), word('Y'), word('E'))
            && e > 0.0
        {
            out.push([x, y]);
        }
    }
    out
}

/// In the A1's nozzle wrap check corner: x 226 to 256, y 224 to 256.
fn in_a1_corner(p: [f64; 2]) -> bool {
    p[0] > 226.05 && p[1] > 224.05
}

/// The case N3D's two part plate showed on the A1 printing by object: two parts 5 mm apart, one of them in the nozzle
/// wrap check corner. Sliced where they stand it is refused; arranged, it slices with no collision and nothing printed
/// in the corner.
#[test]
fn an_a1_by_object_plate_arranged_slices_with_no_collision() {
    let config = a1(&json!({"print_sequence": "by object"}));
    let objects = [
        part("Part_22", [20.0, 20.0, 12.0], [205.0, 200.0]),
        part("Part_27", [20.0, 20.0, 12.0], [230.0, 230.0]),
    ];
    let (as_placed, _) = run("a1-before", "slice", &request(&config, &objects, Some("keep")));
    assert_eq!(as_placed.status.code(), Some(3), "{}", stderr(&as_placed));

    let (out, gcode) = run("a1-after", "slice", &request(&config, &objects, Some("arrange")));
    assert!(out.status.success(), "{}", stderr(&out));
    let result = stdout_json(&out);
    assert!(
        result["collisions"].as_array().is_none_or(Vec::is_empty),
        "{}",
        result["collisions"]
    );
    let arranged = placed(&result["arrange"]);
    assert_eq!(arranged.len(), 2, "{}", result["arrange"]);
    assert!(result["arrange"]["notFit"].as_array().unwrap().is_empty());
    assert_eq!(result["arrange"]["byObject"], json!(true));
    let moves = extruding(&gcode);
    assert!(!moves.is_empty());
    assert!(
        !moves.iter().any(|p| in_a1_corner(*p)),
        "a move in the wrap check corner"
    );
}

/// Printing by object, arranged objects keep the extruder clearance radius apart (the A1's 73 mm), tall ones get
/// gantry lanes the slice accepts, and the same request always gives the same layout.
#[test]
fn by_object_objects_keep_the_extruder_clearance_apart() {
    let config = a1(
        &json!({"print_sequence": "by object", "skirt_loops": 0, "brim_type": "no_brim", "enable_support": false}),
    );
    let objects = [
        part("a", [20.0, 20.0, 10.0], [100.0, 100.0]),
        part("b", [20.0, 20.0, 10.0], [125.0, 100.0]),
        part("c", [20.0, 20.0, 10.0], [100.0, 125.0]),
    ];
    let req = request(&config, &objects, Some("arrange"));
    let (out, _) = run("clearance", "arrange", &req);
    assert!(out.status.success(), "{}", stderr(&out));
    let report = stdout_json(&out);
    let boxes = placed(&report);
    assert_eq!(boxes.len(), 3, "{report}");
    for (i, (ia, a)) in boxes.iter().enumerate() {
        for (ib, b) in &boxes[i + 1..] {
            let gap = box_gap(*a, *b);
            assert!(gap >= 73.0, "{ia} and {ib} are {gap} mm apart: {report}");
        }
    }
    assert_eq!(report["clearanceMm"].as_f64(), Some(73.0), "{report}");
    let (again, _) = run("clearance-again", "arrange", &req);
    assert_eq!(
        report["objects"],
        stdout_json(&again)["objects"],
        "the same plate arranged twice"
    );

    // Two parts taller than the A1's 25 mm gantry rod: the slice refuses them side by side, and takes them arranged.
    let tall = [
        part("t1", [20.0, 20.0, 30.0], [60.0, 100.0]),
        part("t2", [20.0, 20.0, 30.0], [160.0, 100.0]),
        part("low", [20.0, 20.0, 10.0], [110.0, 160.0]),
    ];
    let (side_by_side, _) = run("tall-before", "slice", &request(&config, &tall, Some("keep")));
    assert_eq!(side_by_side.status.code(), Some(3), "{}", stderr(&side_by_side));
    let (arranged, _) = run("tall-after", "slice", &request(&config, &tall, Some("arrange")));
    assert!(arranged.status.success(), "{}", stderr(&arranged));
}

/// The nozzle wrap check corner stays clear by layer too: a plate of parts that fills the bed keeps every part out
/// of it, at the normal spacing apart, and slices with no move in the corner.
#[test]
fn arranged_parts_keep_out_of_the_wrap_check_corner() {
    let config = a1(&json!({"skirt_loops": 0, "brim_type": "no_brim", "enable_support": false}));
    let objects: Vec<Value> = (0..16)
        .map(|k| part(&format!("p{k}"), [40.0, 40.0, 4.0], [100.0, 100.0]))
        .collect();
    let req = request(&config, &objects, Some("arrange"));
    let (out, _) = run("wrap", "arrange", &req);
    assert!(out.status.success(), "{}", stderr(&out));
    let report = stdout_json(&out);
    let boxes = placed(&report);
    assert_eq!(boxes.len(), 16, "{report}");
    for (id, b) in &boxes {
        assert!(
            b[0] >= -0.01 && b[1] >= -0.01 && b[2] <= 256.01 && b[3] <= 256.01,
            "{id} off the bed: {b:?}"
        );
        assert!(
            b[2] <= 226.0 || b[3] <= 224.0,
            "{id} in the wrap check corner: {b:?}"
        );
    }
    for (i, (ia, a)) in boxes.iter().enumerate() {
        for (ib, b) in &boxes[i + 1..] {
            assert!(
                box_gap(*a, *b) >= 5.99,
                "{ia} and {ib} closer than the spacing: {report}"
            );
        }
    }
    let (sliced, gcode) = run("wrap-slice", "slice", &req);
    assert!(sliced.status.success(), "{}", stderr(&sliced));
    assert!(!extruding(&gcode).iter().any(|p| in_a1_corner(*p)));
}

/// More parts than the bed holds: `sx arrange` places the ones with room, never overlapping, and names the rest; a
/// slice of the plate is refused with their names, and writes no G-code.
#[test]
fn objects_with_no_room_are_named_and_never_overlapped() {
    let config = a1(&json!({"skirt_loops": 0, "brim_type": "no_brim", "enable_support": false}));
    let objects: Vec<Value> = (0..40)
        .map(|k| part(&format!("block{k}"), [40.0, 40.0, 4.0], [100.0, 100.0]))
        .collect();
    let req = request(&config, &objects, Some("arrange"));
    let (out, _) = run("full", "arrange", &req);
    assert_eq!(out.status.code(), Some(3), "{}", stderr(&out));
    let report = stdout_json(&out);
    let boxes = placed(&report);
    let left: Vec<&str> = report["notFit"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["name"].as_str().unwrap())
        .collect();
    assert!(!left.is_empty() && !boxes.is_empty(), "{report}");
    assert_eq!(boxes.len() + left.len(), 40, "{report}");
    for (i, (ia, a)) in boxes.iter().enumerate() {
        for (ib, b) in &boxes[i + 1..] {
            assert!(box_gap(*a, *b) > 0.0, "{ia} and {ib} overlap");
        }
    }
    let (sliced, gcode) = run("full-slice", "slice", &req);
    assert_eq!(sliced.status.code(), Some(3), "{}", stderr(&sliced));
    let why = stderr(&sliced);
    assert!(why.contains("no room on the bed"), "{why}");
    assert!(why.contains(left[0]), "{why}");
    assert!(gcode.is_empty());
}
