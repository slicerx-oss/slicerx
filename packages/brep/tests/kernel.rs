// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The modeling cases that break the mesh path (a hole as deep as the part, flush cuts, cut halves) on exact solids.
// Skipped in a build without the kernel.
use serde_json::{Value, json};
use std::collections::HashMap;
use std::f64::consts::PI;

fn call(op: &str, req: &Value) -> Value {
    let r = sx_brep::call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}"));
    serde_json::from_str(&r).expect("reply is JSON")
}

fn body(op: &str, req: &Value) -> u64 {
    call(op, req)["body"].as_u64().expect("a body")
}

fn info(b: u64) -> Value {
    call("info", &json!({ "body": b }))
}

fn volume(b: u64) -> f64 {
    let i = info(b);
    assert_eq!(i["manifold"], true, "not a closed solid: {i}");
    i["volumeMm3"].as_f64().expect("volume")
}

fn close(a: f64, b: f64) {
    assert!((a - b).abs() <= 1e-6 * b.abs().max(1.0), "{a} != {b}");
}

/// Open and non-manifold edges of the tessellation, and its triangle count.
fn mesh_check(b: u64) -> (usize, usize, usize) {
    let m = call("tessellate", &json!({ "body": b }));
    let idx: Vec<u64> = m["indices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap())
        .collect();
    let ids = m["faceIds"].as_array().unwrap();
    assert_eq!(ids.len() * 3, idx.len());
    assert!(
        ids.iter().all(|v| v.as_i64().unwrap() >= 0),
        "every triangle has a face"
    );
    let mut edges: HashMap<(u64, u64), usize> = HashMap::new();
    for t in idx.chunks(3) {
        for k in 0..3 {
            let (a, c) = (t[k], t[(k + 1) % 3]);
            *edges.entry((a.min(c), a.max(c))).or_default() += 1;
        }
    }
    let open = edges.values().filter(|&&n| n == 1).count();
    let nonman = edges.values().filter(|&&n| n > 2).count();
    (open, nonman, idx.len() / 3)
}

fn cube() -> u64 {
    body("box", &json!({ "min": [0, 0, 0], "max": [20, 20, 20] }))
}

#[test]
fn hole_as_deep_as_the_part() {
    if !sx_brep::KERNEL {
        return;
    }
    let c = cube();
    // the Subtract dialog's cylinder at depth 20: its bottom is flush with the part's
    let h = body(
        "subtract",
        &json!({ "body": c, "solids": [{ "type": "cylinder", "origin": [10, 10, 0], "axis": [0, 0, 1], "diameterMm": 8, "heightMm": 20.5 }] }),
    );
    close(volume(h), 8000.0 - PI * 16.0 * 20.0);
    let i = info(h);
    assert_eq!(i["faces"], 7);
    assert_eq!(i["faceTypes"]["plane"], 6);
    assert_eq!(
        i["faceTypes"]["cone"].as_u64().unwrap_or(0) + i["faceTypes"]["cylinder"].as_u64().unwrap_or(0),
        1
    );
    let (open, nonman, tris) = mesh_check(h);
    assert_eq!((open, nonman), (0, 0));
    assert!(tris > 100, "{tris} triangles");
    // the input body is unchanged
    close(volume(c), 8000.0);
}

#[test]
fn flush_and_shared_faces() {
    if !sx_brep::KERNEL {
        return;
    }
    let c = cube();
    let flush = body(
        "subtract",
        &json!({ "body": c, "solids": [{ "type": "box", "min": [5, 5, 0], "max": [15, 15, 20] }] }),
    );
    close(volume(flush), 6000.0);
    let d = body("box", &json!({ "min": [20, 0, 0], "max": [40, 20, 20] }));
    let u = body("boolean", &json!({ "op": "union", "a": c, "b": d }));
    close(volume(u), 16000.0);
    assert_eq!(info(u)["faces"], 6, "the shared face is gone");
    let half = body("box", &json!({ "min": [10, -5, -5], "max": [30, 25, 25] }));
    close(
        volume(body(
            "boolean",
            &json!({ "op": "intersection", "a": c, "b": half }),
        )),
        4000.0,
    );
    close(
        volume(body("boolean", &json!({ "op": "difference", "a": c, "b": half }))),
        4000.0,
    );
}

#[test]
fn many_holes() {
    if !sx_brep::KERNEL {
        return;
    }
    let plate = body("box", &json!({ "min": [0, 0, 0], "max": [12, 12, 1.5] }));
    let solids: Vec<Value> = (0..16)
        .map(|k| json!({ "type": "cylinder", "origin": [1.5 + 3.0 * f64::from(k % 4), 1.5 + 3.0 * f64::from(k / 4), 0], "axis": [0, 0, 1], "diameterMm": 1.5, "heightMm": 1.5 }))
        .collect();
    let p = body("subtract", &json!({ "body": plate, "solids": solids }));
    close(volume(p), 144.0 * 1.5 - 16.0 * PI * 0.5625 * 1.5);
    assert_eq!(mesh_check(p).0, 0);
}

#[test]
fn extrude_on_a_frame() {
    if !sx_brep::KERNEL {
        return;
    }
    // a 20 mm square with an 8 mm round hole, on a wall facing +X at x = 10
    let b = body(
        "extrude",
        &json!({
            "frame": { "origin": [10, 0, 0], "u": [0, 1, 0], "normal": [1, 0, 0] },
            "polygons": [{ "outer": { "points": [[0, 0], [20, 0], [20, 20], [0, 20]] }, "holes": [{ "center": [10, 10], "diameterMm": 8 }] }],
            "fromMm": 0, "toMm": 5
        }),
    );
    close(volume(b), (400.0 - PI * 16.0) * 5.0);
    let bb = &info(b)["bounds"];
    for (k, want) in [(0, 10.0), (1, 0.0), (2, 0.0)] {
        assert!((bb["min"][k].as_f64().unwrap() - want).abs() < 1e-6, "min {bb}");
    }
    for (k, want) in [(0, 15.0), (1, 20.0), (2, 20.0)] {
        assert!((bb["max"][k].as_f64().unwrap() - want).abs() < 1e-6, "max {bb}");
    }
    // two sided: from -2 to 3 along a downward normal
    let d = body(
        "extrude",
        &json!({ "frame": { "origin": [0, 0, 10], "u": [1, 0, 0], "normal": [0, 0, -1] }, "polygons": [{ "outer": { "center": [0, 0], "diameterMm": 10 } }], "fromMm": -2, "toMm": 3 }),
    );
    close(volume(d), PI * 25.0 * 5.0);
    let bb = &info(d)["bounds"];
    assert!(
        (bb["min"][2].as_f64().unwrap() - 7.0).abs() < 1e-6
            && (bb["max"][2].as_f64().unwrap() - 12.0).abs() < 1e-6,
        "{bb}"
    );
}

#[test]
fn cut_in_two() {
    if !sx_brep::KERNEL {
        return;
    }
    let block = cube();
    let holey = body(
        "subtract",
        &json!({ "body": block, "solids": [{ "type": "cylinder", "origin": [10, 10, -1], "axis": [0, 0, 1], "diameterMm": 8, "heightMm": 22 }] }),
    );
    let halves = call(
        "cut",
        &json!({ "body": holey, "plane": { "point": [0, 0, 8], "normal": [0, 0, 1] } }),
    );
    let below = halves["below"].as_u64().unwrap();
    let above = halves["above"].as_u64().unwrap();
    close(volume(below), (400.0 - PI * 16.0) * 8.0);
    close(volume(above), (400.0 - PI * 16.0) * 12.0);
    assert_eq!(mesh_check(below).0, 0);
    // tilted, through the middle: equal halves
    let tilted = call(
        "cut",
        &json!({ "body": block, "plane": { "point": [10, 10, 10], "normal": [0, 1, 1] } }),
    );
    close(volume(tilted["below"].as_u64().unwrap()), 4000.0);
    close(volume(tilted["above"].as_u64().unwrap()), 4000.0);
    // a plane that misses the body
    let missed = call(
        "cut",
        &json!({ "body": block, "plane": { "point": [0, 0, 50], "normal": [0, 0, 1] } }),
    );
    close(volume(missed["below"].as_u64().unwrap()), 8000.0);
    assert!(missed["above"].is_null());
}

#[test]
fn errors_name_the_field() {
    if !sx_brep::KERNEL {
        return;
    }
    let e = sx_brep::call("box", r#"{"min":[0,0,0],"max":[-1,2,2]}"#).unwrap_err();
    assert!(e.starts_with("max:"), "{e}");
    let e = sx_brep::call("info", r#"{"body":999999}"#).unwrap_err();
    assert!(e.starts_with("body:"), "{e}");
    let e = sx_brep::call(
        "cylinder",
        r#"{"origin":[0,0,0],"axis":[0,0,0],"diameterMm":2,"heightMm":2}"#,
    )
    .unwrap_err();
    assert!(e.starts_with("normal:") || e.starts_with("axis:"), "{e}");
    let e = sx_brep::call("nope", "{}").unwrap_err();
    assert!(e.starts_with("op:"), "{e}");
    let e = sx_brep::call("box", "{bad").unwrap_err();
    assert!(e.starts_with("request:"), "{e}");
}

#[test]
fn free_releases_bodies() {
    if !sx_brep::KERNEL {
        return;
    }
    let c = cube();
    assert_eq!(call("free", &json!({ "body": c }))["freed"], true);
    assert_eq!(call("free", &json!({ "body": c }))["freed"], false);
    assert!(sx_brep::call("info", &json!({ "body": c }).to_string()).is_err());
}

#[test]
fn no_kernel_says_so() {
    if sx_brep::KERNEL {
        return;
    }
    let e = sx_brep::call("box", "{}").unwrap_err();
    assert!(e.contains("no B-rep kernel"), "{e}");
}
