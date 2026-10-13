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
fn bodies_travel_as_text() {
    if !sx_brep::KERNEL {
        return;
    }
    let block = cube();
    let holed = call(
        "subtract",
        &json!({ "body": block, "solids": [{ "type": "cylinder", "origin": [10, 10, 0], "axis": [0, 0, 1], "diameterMm": 8, "heightMm": 20.5 }], "save": true }),
    );
    let text = holed["bodySmb"]
        .as_str()
        .expect("saved with the reply")
        .to_owned();
    assert_eq!(call("save", &json!({ "body": holed["body"] }))["smb"], text);
    // a body carried in the request, as a new process would send it, comes back exact
    let carried = json!({ "smb": text });
    let read = call("info", &json!({ "body": carried }));
    assert_eq!(read["manifold"], true);
    assert_eq!(read["faces"], 7);
    close(read["volumeMm3"].as_f64().unwrap(), 8000.0 - PI * 16.0 * 20.0);
    // and on through more ops: cut in two, both halves saved
    let halves = call(
        "cut",
        &json!({ "body": carried, "plane": { "point": [0, 0, 8], "normal": [0, 0, 1] }, "save": true }),
    );
    let below = json!({ "smb": halves["belowSmb"].as_str().expect("below saved") });
    close(
        volume(body("load", &json!({ "body": below }))),
        (400.0 - PI * 16.0) * 8.0,
    );
    assert_eq!(mesh_check(body("load", &json!({ "body": below }))).0, 0);
    // anything else is refused before the kernel reads it, a changed save too
    let changed = text.replacen("20.5000000000000000", "20.6000000000000000", 1);
    for bad in ["not a body", changed.as_str()] {
        let err = sx_brep::call("info", &json!({ "body": { "smb": bad } }).to_string()).unwrap_err();
        assert!(err.starts_with("body:"), "{err}");
    }
}

// the same file the web build's test reads (packages/app/test/brep-module.test.ts); SX_BREP_FIXTURE=<file>
// writes it afresh
#[test]
fn reads_the_saved_fixture() {
    if !sx_brep::KERNEL {
        return;
    }
    let block = cube();
    let holed = call(
        "subtract",
        &json!({ "body": block, "solids": [{ "type": "cylinder", "origin": [10, 10, 0], "axis": [0, 0, 1], "diameterMm": 8, "heightMm": 20.5 }], "save": true }),
    );
    if let Ok(path) = std::env::var("SX_BREP_FIXTURE") {
        std::fs::write(path, holed["bodySmb"].as_str().unwrap()).expect("write the fixture");
    }
    let saved = include_str!("fixtures/holed-cube.smb");
    close(
        volume(body("load", &json!({ "body": { "smb": saved } }))),
        8000.0 - PI * 16.0 * 20.0,
    );
}

/// Each face's key and surface, in face order.
fn faces(b: &Value) -> Vec<(u64, Value)> {
    let m = call("tessellate", &json!({ "body": b }));
    m["faces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["key"].as_u64().expect("a key"), f["surface"].clone()))
        .collect()
}

#[test]
fn faces_keep_their_keys() {
    if !sx_brep::KERNEL {
        return;
    }
    // no keySalt, no keys
    assert!(faces(&json!(cube())).iter().all(|f| f.0 == 0));
    let keyed = || {
        body(
            "box",
            &json!({ "min": [0, 0, 0], "max": [20, 20, 20], "keySalt": 7 }),
        )
    };
    let a = faces(&json!(keyed()));
    let keys: Vec<u64> = a.iter().map(|f| f.0).collect();
    assert_eq!(keys.len(), 6);
    assert!(keys.iter().all(|&k| k > 0 && k < 1 << 52), "{keys:?}");
    assert_eq!(keys.iter().collect::<std::collections::HashSet<_>>().len(), 6);
    // the same step again makes the same keys
    assert_eq!(
        faces(&json!(keyed())).iter().map(|f| f.0).collect::<Vec<_>>(),
        keys
    );
    // planes face out of the solid
    let facing = |z: f64| {
        a.iter()
            .find(|f| f.1["kind"] == "plane" && f.1["normal"][2].as_f64() == Some(z))
            .expect("a plane facing that way")
    };
    let top = facing(1.0);
    close(top.1["offset"].as_f64().unwrap(), 20.0);
    close(facing(-1.0).1["offset"].as_f64().unwrap(), 0.0);
    // a hole keeps the box's keys and adds one for its wall, from the step that cut it
    let holed = call(
        "subtract",
        &json!({ "body": keyed(), "solids": [{ "type": "cylinder", "origin": [10, 10, 0], "axis": [0, 0, 1], "diameterMm": 8, "heightMm": 20 }], "keySalt": 9, "save": true }),
    );
    let h = faces(&holed["body"]);
    assert_eq!(h.len(), 7);
    let wall: Vec<_> = h.iter().filter(|f| !keys.contains(&f.0)).collect();
    assert_eq!(wall.len(), 1, "{h:?}");
    assert!(wall[0].0 > 0);
    assert_eq!(wall[0].1["kind"], "cylinder", "{h:?}");
    close(wall[0].1["radius"].as_f64().unwrap(), 4.0);
    close(wall[0].1["axis"][2].as_f64().unwrap().abs(), 1.0);
    let o = &wall[0].1["origin"];
    close(o[0].as_f64().unwrap(), 10.0);
    close(o[1].as_f64().unwrap(), 10.0);
    // and the keys travel with the saved text
    let carried = json!({ "smb": holed["bodySmb"] });
    assert_eq!(
        faces(&carried).iter().map(|f| f.0).collect::<Vec<_>>(),
        h.iter().map(|f| f.0).collect::<Vec<_>>()
    );
    let reloaded = json!(body("load", &json!({ "body": carried })));
    assert_eq!(faces(&reloaded), h);
}

#[test]
fn fillet_rounds_the_named_edges() {
    if !sx_brep::KERNEL {
        return;
    }
    // the fillet's surface may be a spline, so its volume is near the exact one rather than equal
    let near = |a: f64, b: f64| assert!((a - b).abs() <= 1e-4 * b, "{a} != {b}");
    let notch = (1.0 - PI / 4.0) * 9.0 * 20.0;
    let one = body(
        "fillet",
        &json!({ "body": cube(), "edges": [{ "a": [20, 20, 0], "b": [20, 20, 20], "face": [1, 0, 0] }], "radiusMm": 3 }),
    );
    near(volume(one), 8000.0 - notch);
    assert_eq!(mesh_check(one).0, 0);
    // the four upright edges, ends either way round
    let ups = [[0, 0], [20, 0], [20, 20], [0, 20]].map(
        |[x, y]| json!({ "a": [x, y, 20], "b": [x, y, 0], "face": [if x == 0 { -1 } else { 1 }, 0, 0] }),
    );
    let four = body("fillet", &json!({ "body": cube(), "edges": ups, "radiusMm": 3 }));
    near(volume(four), 8000.0 - 4.0 * notch);
    // by the faces' keys: the old faces keep theirs and the round gets one of the step's
    let keyed = call(
        "box",
        &json!({ "min": [0, 0, 0], "max": [20, 20, 20], "keySalt": 7, "save": true }),
    );
    let before = faces(&keyed["body"]);
    let key = |x: f64, y: f64| {
        before
            .iter()
            .find(|f| f.1["normal"][0].as_f64() == Some(x) && f.1["normal"][1].as_f64() == Some(y))
            .unwrap()
            .0
    };
    let rounded = call(
        "fillet",
        &json!({ "body": keyed["body"], "edges": [{ "a": [20, 20, 0], "b": [20, 20, 20], "face": [1, 0, 0], "keys": [key(1.0, 0.0), key(0.0, 1.0)] }], "radiusMm": 3, "keySalt": 9, "withKeys": true }),
    );
    let after = faces(&rounded["body"]);
    assert_eq!(after.len(), 7);
    // withKeys gives the same keys in face order without a tessellate
    assert_eq!(
        rounded["bodyKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_u64().unwrap())
            .collect::<Vec<_>>(),
        after.iter().map(|f| f.0).collect::<Vec<_>>()
    );
    let old: Vec<u64> = before.iter().map(|f| f.0).collect();
    assert!(
        after.iter().filter(|f| old.contains(&f.0)).count() == 6,
        "{after:?}"
    );
    assert!(after.iter().all(|f| f.0 > 0));
    // an edge the body doesn't have
    let e = sx_brep::call(
        "fillet",
        &json!({ "body": cube(), "edges": [{ "a": [5, 5, 0], "b": [5, 5, 20], "face": [1, 0, 0] }], "radiusMm": 3 }).to_string(),
    )
    .unwrap_err();
    assert!(e.contains("edges"), "{e}");
}

#[test]
fn chamfer_sets_both_faces_back() {
    if !sx_brep::KERNEL {
        return;
    }
    let edge = json!([{ "a": [20, 20, 0], "b": [20, 20, 20], "face": [1, 0, 0] }]);
    let one = body(
        "chamfer",
        &json!({ "body": cube(), "edges": edge, "distanceMm": 2 }),
    );
    close(volume(one), 8000.0 - 2.0 * 20.0);
    assert_eq!(mesh_check(one).0, 0);
    // an inside edge (the corner of an L) gets material, so it goes through the fillet solver, not a wedge cut
    let l = body(
        "extrude",
        &json!({ "frame": { "origin": [0, 0, 0], "u": [1, 0, 0], "normal": [0, 0, 1] }, "polygons": [{ "outer": { "points": [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]] }, "holes": [] }], "fromMm": 0, "toMm": 5 }),
    );
    let inner = body(
        "chamfer",
        &json!({ "body": l, "edges": [{ "a": [10, 10, 0], "b": [10, 10, 5], "face": [1, 0, 0] }], "distanceMm": 2 }),
    );
    close(volume(inner), 1500.0 + 2.0 * 5.0);
    let two = sx_brep::call(
        "chamfer",
        &json!({ "body": cube(), "edges": edge, "distanceMm": 2, "distance2Mm": 3 }).to_string(),
    )
    .unwrap_err();
    assert!(two.contains("distance2Mm"), "{two}");
}

#[test]
fn subtract_in_the_body_frame() {
    if !sx_brep::KERNEL {
        return;
    }
    // the body's frame is turned a quarter about z and moved, so its (10, 10) is (90, 10) in world
    let frame = json!({ "origin": [100, 0, 0], "u": [0, 1, 0], "normal": [0, 0, 1] });
    let solids = json!([{ "type": "cylinder", "origin": [90, 10, 0], "axis": [0, 0, 1], "diameterMm": 8, "heightMm": 20 }]);
    let h = body(
        "subtract",
        &json!({ "body": cube(), "solids": solids, "frame": frame }),
    );
    close(volume(h), 8000.0 - PI * 16.0 * 20.0);
    let wall = faces(&json!(h))
        .into_iter()
        .find(|f| f.1["kind"] == "cylinder")
        .expect("the hole's wall");
    close(wall.1["origin"][0].as_f64().unwrap(), 10.0);
    close(wall.1["origin"][1].as_f64().unwrap(), 10.0);
}

#[test]
fn primitives_stand_on_their_frame() {
    if !sx_brep::KERNEL {
        return;
    }
    let p = |q: Value| body("primitive", &q);
    // a box on its side: u along y, standing along -x from x = 5
    let frame = json!({ "origin": [5, 0, 0], "u": [0, 1, 0], "normal": [-1, 0, 0] });
    let b = p(json!({ "type": "box", "sizeMm": [20, 10, 4], "frame": frame }));
    close(volume(b), 800.0);
    let bb = &info(b)["bounds"];
    for (k, lo, hi) in [(0, 1.0, 5.0), (1, -10.0, 10.0), (2, -5.0, 5.0)] {
        assert!(
            (bb["min"][k].as_f64().unwrap() - lo).abs() < 1e-6
                && (bb["max"][k].as_f64().unwrap() - hi).abs() < 1e-6,
            "{bb}"
        );
    }
    let c = p(json!({ "type": "cylinder", "diameterMm": 10, "heightMm": 20 }));
    close(volume(c), PI * 25.0 * 20.0);
    assert_eq!(info(c)["faceTypes"]["plane"], 2);
    for (top, want) in [
        (0.0, PI * 25.0 * 10.0 / 3.0),
        (4.0, PI * 10.0 / 3.0 * (25.0 + 10.0 + 4.0)),
    ] {
        let k = p(json!({ "type": "cone", "diameterMm": 10, "topDiameterMm": top, "heightMm": 10 }));
        close(volume(k), want);
        assert_eq!(mesh_check(k).0, 0);
    }
    let s = p(json!({ "type": "sphere", "diameterMm": 10 }));
    close(volume(s), 4.0 / 3.0 * PI * 125.0);
    let bb = &info(s)["bounds"];
    assert!(
        (bb["min"][2].as_f64().unwrap()).abs() < 1e-6 && (bb["max"][2].as_f64().unwrap() - 10.0).abs() < 1e-6,
        "{bb}"
    );
}

#[test]
fn boolean_with_nothing_left() {
    if !sx_brep::KERNEL {
        return;
    }
    let apart = body("box", &json!({ "min": [40, 0, 0], "max": [50, 10, 10] }));
    let r = call(
        "boolean",
        &json!({ "op": "intersection", "a": cube(), "b": apart }),
    );
    assert!(r["body"].is_null(), "{r}");
    let all = call(
        "boolean",
        &json!({ "op": "difference", "a": cube(), "b": body("box", &json!({ "min": [-1, -1, -1], "max": [21, 21, 21] })) }),
    );
    assert!(all["body"].is_null(), "{all}");
}

#[test]
fn extrude_lines_and_arcs() {
    if !sx_brep::KERNEL {
        return;
    }
    let frame = json!({ "origin": [0, 0, 0], "u": [1, 0, 0], "normal": [0, 0, 1] });
    // a 30 x 10 slot: two lines and two half circles, counterclockwise
    let slot = json!({ "start": [-10, -5], "segments": [
        { "to": [10, -5] },
        { "to": [10, 5], "center": [10, 0], "sweepDeg": 180 },
        { "to": [-10, 5] },
        { "to": [-10, -5], "center": [-10, 0], "sweepDeg": 180 }
    ] });
    let s = body(
        "extrude",
        &json!({ "frame": frame, "polygons": [{ "outer": slot }], "fromMm": 0, "toMm": 4 }),
    );
    close(volume(s), (200.0 + PI * 25.0) * 4.0);
    assert_eq!(info(s)["faces"], 6);
    assert_eq!(mesh_check(s).0, 0);
    // a square with a half round bite out of its top: the bite's arc runs clockwise
    let bitten = json!({ "start": [0, 0], "segments": [
        { "to": [20, 0] },
        { "to": [20, 20] },
        { "to": [15, 20] },
        { "to": [5, 20], "center": [10, 20], "sweepDeg": -180 },
        { "to": [0, 20] },
        { "to": [0, 0] }
    ] });
    let b = body(
        "extrude",
        &json!({ "frame": frame, "polygons": [{ "outer": bitten, "holes": [{ "center": [10, 8], "diameterMm": 4 }] }], "fromMm": 0, "toMm": 3 }),
    );
    close(volume(b), (400.0 - PI * 12.5 - PI * 4.0) * 3.0);
    assert_eq!(mesh_check(b).0, 0);
}

#[test]
fn extrude_joins_and_cuts() {
    if !sx_brep::KERNEL {
        return;
    }
    let top = |op: &str, d: f64, x: f64| {
        let (a, b) = if d > 0.0 { (0.0, d) } else { (d, 0.0) };
        call(
            "extrude",
            &json!({
                "frame": { "origin": [10, 10, 20], "u": [1, 0, 0], "normal": [0, 0, 1] },
                "polygons": [{ "outer": { "center": [x, 0], "diameterMm": 8 } }],
                "fromMm": a, "toMm": b, "target": cube(), "operation": op
            }),
        )
    };
    let boss = top("join", 5.0, 0.0);
    assert_eq!(boss["touches"], true);
    close(volume(boss["body"].as_u64().unwrap()), 8000.0 + PI * 16.0 * 5.0);
    // a cut flush through the bottom leaves a closed solid with one round wall
    let hole = top("cut", -20.0, 0.0);
    let h = hole["body"].as_u64().unwrap();
    close(volume(h), 8000.0 - PI * 16.0 * 20.0);
    assert_eq!(mesh_check(h).0, 0);
    // a cut off the side, a join that stands apart, a cut away from the face and a join inside the body change
    // nothing and make no body
    for miss in [
        top("cut", -5.0, 40.0),
        top("join", 5.0, 40.0),
        top("cut", 5.0, 0.0),
        top("join", -5.0, 0.0),
    ] {
        assert_eq!(miss["touches"], false, "{miss}");
        assert!(miss["body"].is_null(), "{miss}");
    }
    // a slab off the whole top and a hidden cavity both change the body
    let slab = call(
        "extrude",
        &json!({ "frame": { "origin": [10, 10, 20], "u": [1, 0, 0], "normal": [0, 0, 1] }, "polygons": [{ "outer": { "points": [[-15, -15], [15, -15], [15, 15], [-15, 15]] } }], "fromMm": -2, "toMm": 0, "target": cube(), "operation": "cut" }),
    );
    close(volume(slab["body"].as_u64().unwrap()), 8000.0 - 800.0);
    let cavity = call(
        "extrude",
        &json!({ "frame": { "origin": [10, 10, 20], "u": [1, 0, 0], "normal": [0, 0, 1] }, "polygons": [{ "outer": { "center": [0, 0], "diameterMm": 8 } }], "fromMm": -15, "toMm": -5, "target": cube(), "operation": "cut" }),
    );
    close(
        volume(cavity["body"].as_u64().unwrap()),
        8000.0 - PI * 16.0 * 10.0,
    );
    let all = json!({ "frame": { "origin": [10, 10, 20], "u": [1, 0, 0], "normal": [0, 0, 1] }, "polygons": [{ "outer": { "points": [[-20, -20], [20, -20], [20, 20], [-20, 20]] } }], "fromMm": -30, "toMm": 0, "target": cube(), "operation": "cut" });
    let e = sx_brep::call("extrude", &all.to_string()).unwrap_err();
    assert!(e.contains("removes the whole body"), "{e}");
}

#[test]
fn no_kernel_says_so() {
    if sx_brep::KERNEL {
        return;
    }
    let e = sx_brep::call("box", "{}").unwrap_err();
    assert!(e.contains("no B-rep kernel"), "{e}");
}
