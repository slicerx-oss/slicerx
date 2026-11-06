// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `plate.placement` `arrange`: the distinct objects of a plate are packed on the printer's bed before the slice,
//! clear of its keep-out zones (`bed_exclude_area`, the nozzle wrap check corner), the extruder clearance apart when
//! the plate prints by object, and the normal spacing by layer. `sx arrange --request` gives the layout without
//! slicing, and names the objects with no room instead of overlapping them.
#![allow(clippy::too_many_lines, reason = "test plates spelled out in full")]
#![allow(clippy::disallowed_methods, reason = "test geometry, not engine output")]

use serde_json::{Value, json};
use std::fmt::Write as _;
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

#[test]
fn turned_parts_land_on_a_round_bed_centered_on_its_origin() {
    // A delta's round bed, 150 mm across its radius and centered on 0, 0: the printable area does not start at 0, 0, so
    // the nest's plate coordinates start at its front left corner, -150, -150. Bars turned 30 degrees as imported; the
    // nest turns them again, and each new transform must put the bar where the nest put its outline.
    let area: Vec<[f64; 2]> = (0..64)
        .map(|k| {
            let a = f64::from(k) * std::f64::consts::TAU / 64.0;
            [150.0 * a.cos(), 150.0 * a.sin()]
        })
        .collect();
    let config = a1(&json!({
        "printable_area": area,
        "printer_model": "FLSun V400",
        "head_wrap_detect_zone": [],
        "bed_exclude_area": [],
    }));
    let (s, c) = 30.0_f64.to_radians().sin_cos();
    let bars: Vec<Value> = (0..8)
        .map(|k| {
            let (sx, sy) = (2.0, 0.5);
            let at = [-30.0 + 4.0 * f64::from(k), -20.0 + 3.0 * f64::from(k)];
            json!({
                "id": format!("bar{k}"),
                "name": format!("Bar {k}"),
                "mesh": "c",
                "transform": [c * sx, s * sx, 0, 0, -s * sy, c * sy, 0, 0, 0, 0, 0.25, 0, at[0], at[1], 0, 1],
            })
        })
        .collect();
    let mut req = request(&config, &bars, None);
    req["plate"]["bed"] = json!({"widthMm": 300, "depthMm": 300, "heightMm": 410, "round": true});
    let (out, _) = run("round-bed", "arrange", &req);
    assert!(out.status.success(), "{}", stderr(&out));
    let report = stdout_json(&out);
    let objects = report["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 8, "{report}");
    assert!(
        objects.iter().any(|o| o["turnDeg"].as_f64().unwrap() > 0.5),
        "the nest turned some bar: {report}"
    );
    for o in objects {
        let t: Vec<f64> = o["transform"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        let corners: Vec<[f64; 2]> = [(0.0, 0.0), (20.0, 0.0), (0.0, 20.0), (20.0, 20.0)]
            .iter()
            .map(|&(x, y)| [t[0] * x + t[4] * y + t[12], t[1] * x + t[5] * y + t[13]])
            .collect();
        for p in &corners {
            assert!(
                p[0].hypot(p[1]) <= 150.0,
                "{} reaches {p:?}, off the round bed: {report}",
                o["id"]
            );
        }
        // and its middle is where the report says
        let mid = [
            corners.iter().map(|p| p[0]).sum::<f64>() / 4.0,
            corners.iter().map(|p| p[1]).sum::<f64>() / 4.0,
        ];
        let center = [
            o["centerMm"][0].as_f64().unwrap(),
            o["centerMm"][1].as_f64().unwrap(),
        ];
        assert!(
            (mid[0] - center[0]).hypot(mid[1] - center[1]) < 0.01,
            "{}: {mid:?} against {center:?}",
            o["id"]
        );
    }
}

/// An ASCII STL of `boxes` (x0, y0, z0, x1, y1, z1, mm, each wound with its normals out), at `path`.
fn boxes_stl(path: &std::path::Path, boxes: &[[f64; 6]]) {
    let mut s = String::from("solid boxes\n");
    for b in boxes {
        let c = |i: usize| {
            [
                b[if i & 1 == 0 { 0 } else { 3 }],
                b[if i & 2 == 0 { 1 } else { 4 }],
                b[if i & 4 == 0 { 2 } else { 5 }],
            ]
        };
        // Each face as two triangles, corners counter-clockwise seen from outside.
        for q in [
            [0, 2, 3, 1],
            [4, 5, 7, 6],
            [0, 1, 5, 4],
            [2, 6, 7, 3],
            [0, 4, 6, 2],
            [1, 3, 7, 5],
        ] {
            for t in [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] {
                s.push_str("  facet normal 0 0 0\n    outer loop\n");
                for i in t {
                    let p = c(i);
                    writeln!(s, "      vertex {} {} {}", p[0], p[1], p[2]).unwrap();
                }
                s.push_str("    endloop\n  endfacet\n");
            }
        }
    }
    s.push_str("endsolid boxes\n");
    std::fs::write(path, s).unwrap();
}

/// With support on, printing by layer, a part that gets none (no underside to hold up) keeps no room for a support
/// pad, so a plate of them packs as tight as with support off and slices with no support; a part with an overhang
/// keeps its pad.
#[test]
fn support_room_is_kept_only_for_parts_that_get_support() {
    let config = a1(&json!({
        "skirt_loops": 0,
        "brim_type": "no_brim",
        "enable_support": true,
        "support_type": "tree(auto)",
        "support_threshold_angle": 25,
    }));
    // 20 cubes of 40 mm: 6 mm apart they fit the A1's bed round its wrap check corner, but not with a tree support
    // pad (about 8 mm) round each.
    let cubes: Vec<Value> = (0..20)
        .map(|k| part(&format!("c{k}"), [40.0, 40.0, 4.0], [100.0, 100.0]))
        .collect();
    let req = request(&config, &cubes, Some("arrange"));
    let (out, _) = run("support-cubes", "arrange", &req);
    assert!(out.status.success(), "{}", stderr(&out));
    let report = stdout_json(&out);
    let boxes = placed(&report);
    assert_eq!(boxes.len(), 20, "{report}");
    for (i, (ia, a)) in boxes.iter().enumerate() {
        for (ib, b) in &boxes[i + 1..] {
            assert!(
                box_gap(*a, *b) >= 5.99,
                "{ia} and {ib} closer than the spacing: {report}"
            );
        }
    }
    let (sliced, gcode) = run("support-cubes-slice", "slice", &req);
    assert!(sliced.status.success(), "{}", stderr(&sliced));
    assert!(!gcode.contains(";TYPE:Support"), "the cubes printed support");

    // Two tables (a 10 mm post under a 20 mm slab), and two boxes on a plinth hanging 8 mm past its edge, do get
    // support, so each keeps the pad round it.
    let dir =
        TempDir(std::env::temp_dir().join(format!("sx-plate-arrange-support-meshes-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    for (name, boxes) in [
        (
            "table",
            [
                [5.0, 5.0, 0.0, 15.0, 15.0, 10.0],
                [0.0, 0.0, 10.0, 20.0, 20.0, 13.0],
            ],
        ),
        (
            "hanging",
            [
                [0.0, 0.0, 0.0, 12.0, 20.0, 4.0],
                [6.0, 5.0, 4.0, 20.0, 15.0, 16.0],
            ],
        ),
    ] {
        let stl = dir.0.join(format!("{name}.stl"));
        boxes_stl(&stl, &boxes);
        let objects: Vec<Value> = (0..2)
            .map(|k| {
                let mut o = part(&format!("{name}{k}"), [20.0, 20.0, 20.0], [100.0, 100.0]);
                o["mesh"] = json!("t");
                o
            })
            .collect();
        let mut req = request(&config, &objects, Some("arrange"));
        req["meshes"]["t"] = json!(stl.to_str().unwrap());
        let (out, _) = run(&format!("support-{name}"), "arrange", &req);
        assert!(out.status.success(), "{}", stderr(&out));
        let report = stdout_json(&out);
        let boxes = placed(&report);
        assert_eq!(boxes.len(), 2, "{report}");
        // The tree pad: 2 mm of first layer expansion, a 3 mm tree brim, half a 5 mm branch and a line, each side.
        assert!(
            box_gap(boxes[0].1, boxes[1].1) >= 15.8,
            "the {name} parts lost their support pad: {report}"
        );
    }
}

/// A part standing on a plinth (a tower whose underside rests wholly on the plinth's top) gets no support, so with
/// support on a round bed of them packs as with support off, and the plate slices with no support and no collision.
#[test]
fn parts_resting_on_a_plinth_keep_no_support_room() {
    let area: Vec<[f64; 2]> = (0..64)
        .map(|k| {
            let a = f64::from(k) * std::f64::consts::TAU / 64.0;
            [150.0 * a.cos(), 150.0 * a.sin()]
        })
        .collect();
    let config = a1(&json!({
        "printable_area": area,
        "printer_model": "FLSun V400",
        "head_wrap_detect_zone": [],
        "bed_exclude_area": [],
        "brim_type": "auto_brim",
        "brim_width": 5,
        "enable_support": true,
        "support_type": "tree(auto)",
        "support_threshold_angle": 25,
    }));
    let dir =
        TempDir(std::env::temp_dir().join(format!("sx-plate-arrange-plinth-mesh-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let stl = dir.0.join("plinth.stl");
    boxes_stl(
        &stl,
        &[
            [0.0, 0.0, 0.0, 64.0, 22.0, 4.0],
            [22.0, 6.0, 4.0, 42.0, 16.0, 30.0],
        ],
    );
    let objects: Vec<Value> = (0..20)
        .map(|k| {
            let mut o = part(&format!("x{k}"), [20.0, 20.0, 20.0], [-32.0, -11.0]);
            o["mesh"] = json!("p");
            o
        })
        .collect();
    let mut req = request(&config, &objects, Some("arrange"));
    req["meshes"]["p"] = json!(stl.to_str().unwrap());
    req["plate"]["bed"] = json!({"widthMm": 300, "depthMm": 300, "heightMm": 410, "round": true});
    let (out, _) = run("plinth", "arrange", &req);
    assert!(out.status.success(), "{}", stderr(&out));
    let report = stdout_json(&out);
    assert_eq!(report["objects"].as_array().unwrap().len(), 20, "{report}");
    let (sliced, gcode) = run("plinth-slice", "slice", &req);
    assert!(sliced.status.success(), "{}", stderr(&sliced));
    assert!(
        !gcode.contains(";TYPE:Support"),
        "the plinth parts printed support"
    );
}

/// With `plate.arrange.newPlates`, one `sx arrange` lays out the parts with no room on as many empty beds as they take,
/// each as an arrange of just those parts lays it out, and `notFit` keeps naming what is not on this plate.
#[test]
fn new_plates_take_the_parts_with_no_room_in_one_call() {
    let config = a1(&json!({"skirt_loops": 0, "brim_type": "no_brim", "enable_support": false}));
    let objects: Vec<Value> = (0..40)
        .map(|k| part(&format!("block{k}"), [40.0, 40.0, 4.0], [100.0, 100.0]))
        .collect();
    let mut req = request(&config, &objects, Some("arrange"));
    req["plate"]["arrange"] = json!({"newPlates": true});
    let (out, _) = run("plates", "arrange", &req);
    assert_eq!(out.status.code(), Some(3), "{}", stderr(&out));
    let report = stdout_json(&out);
    let here = placed(&report);
    let left: Vec<String> = report["notFit"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(here.len() + left.len(), 40, "{report}");
    let plates = report["plates"]
        .as_array()
        .unwrap_or_else(|| panic!("no plates in {report}"));
    assert!(!plates.is_empty(), "{report}");
    // Every part with no room lands on exactly one new plate, none overlapping there.
    let mut on_plates: Vec<String> = Vec::new();
    let mut rest = left.clone();
    for (k, p) in plates.iter().enumerate() {
        let boxes = placed(p);
        assert!(!boxes.is_empty(), "plate {k} is empty: {report}");
        for (i, (ia, a)) in boxes.iter().enumerate() {
            for (ib, b) in &boxes[i + 1..] {
                assert!(
                    box_gap(*a, *b) >= 5.99,
                    "{ia} and {ib} closer than the spacing on plate {k}"
                );
            }
        }
        // As an arrange of the parts still left would lay that plate out.
        let mut alone = request(
            &config,
            &objects
                .iter()
                .filter(|o| rest.iter().any(|id| id == o["id"].as_str().unwrap()))
                .cloned()
                .collect::<Vec<_>>(),
            Some("arrange"),
        );
        alone["plate"]["arrange"] = json!({});
        let (one, _) = run(&format!("plates-{k}"), "arrange", &alone);
        let one = stdout_json(&one);
        assert_eq!(
            one["objects"], p["objects"],
            "plate {k} differs from an arrange of the parts left"
        );
        let ids: Vec<String> = boxes.iter().map(|(id, _)| id.clone()).collect();
        rest.retain(|id| !ids.contains(id));
        on_plates.extend(ids);
    }
    on_plates.sort();
    let mut want = left.clone();
    want.sort();
    assert_eq!(on_plates, want, "{report}");
}
