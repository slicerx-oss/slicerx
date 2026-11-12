// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The hand-over between typed bodies and the table the older operations keep: a typed body lent to an older
// operation for one call, a body an older operation made taken over as a typed body, and the face keys both sides
// read and write. Also the list of operations that still go this way, which may only get shorter. Empty without the
// typed feature, so a workspace test run that names every test target passes over it.
#![cfg(feature = "typed")]
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::f64::consts::PI;
use std::sync::{Mutex, MutexGuard};
use sx_brep::handover::{self, ROUTED};
use sx_brep::{Body, Error, Surface};

// the older table and its count are the whole process's, so the tests that look at it run one at a time
static ONE: Mutex<()> = Mutex::new(());

fn alone() -> MutexGuard<'static, ()> {
    ONE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn call(op: &str, request: &Value) -> Value {
    let reply = sx_brep::call(op, &request.to_string()).unwrap_or_else(|e| panic!("{op}: {e}"));
    serde_json::from_str(&reply).expect("a JSON reply")
}

fn refused(op: &str, request: &Value) -> String {
    sx_brep::call(op, &request.to_string()).expect_err("a refusal")
}

fn refusal<T>(made: Result<T, Error>) -> String {
    match made {
        Ok(_) => panic!("a refusal"),
        Err(e) => e.to_string(),
    }
}

/// How many bodies the older table holds.
fn held() -> u64 {
    call("count", &json!({}))["bodies"].as_u64().expect("a count")
}

fn close(a: f64, b: f64) {
    assert!((a - b).abs() <= 1e-6 * b.abs().max(1.0), "{a} != {b}");
}

fn numbers(v: &Value) -> Vec<u64> {
    v.as_array()
        .expect("a list")
        .iter()
        .map(|n| n.as_u64().expect("a whole number"))
        .collect()
}

fn sorted(mut keys: Vec<u64>) -> Vec<u64> {
    keys.sort_unstable();
    keys
}

/// One key above 2^40, so both halves of a key are in use.
const KEYS: [u64; 6] = [101, 102, 103, 104, 105, (1 << 40) + 6];
const NO_SUCH: &str = "body: no body an operation made is under this number";

/// A 20 by 10 by 15 block from the origin with a key on each face.
fn block() -> Body {
    let mut body = Body::cuboid([0.0; 3], [20.0, 10.0, 15.0]).expect("a block");
    body.set_keys(&KEYS).expect("keys");
    body
}

/// Everything read of a body that an operation working on a copy must leave as it was.
#[derive(Debug, PartialEq)]
struct State {
    volume: f64,
    bounds: ([f64; 3], [f64; 3]),
    faces: usize,
    edges: usize,
    keys: Vec<u64>,
    /// The body as the text a save writes, which two saves of an unchanged body give alike.
    text: String,
}

fn state(body: &Body) -> State {
    let keys = body.keys().expect("keys");
    State {
        volume: body.volume().expect("volume"),
        bounds: body.bounds().expect("bounds"),
        faces: body.faces().expect("faces").len(),
        edges: body.edges().expect("edges").len(),
        text: body.saved(&keys).expect("the body as text"),
        keys,
    }
}

/// The key of the one flat face on the plane `normal` . p = `offset`.
fn key_on(body: &Body, normal: [f64; 3], offset: f64) -> u64 {
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let keys = body.keys().expect("keys");
    let faces = body.faces().expect("faces");
    let found: Vec<u64> = faces
        .iter()
        .zip(&keys)
        .filter_map(|(face, &key)| match face.surface() {
            Surface::Plane { frame } => {
                let on = (dot(frame.z, normal).abs() - 1.0).abs() < 1e-9
                    && (dot(frame.origin, normal) - offset).abs() < 1e-9;
                on.then_some(key)
            }
            _ => None,
        })
        .collect();
    assert_eq!(found.len(), 1, "one face on {normal:?} at {offset}");
    found[0]
}

/// The same body in the older table, read from its text: what the operation gives there is what it must give for
/// the lent body.
fn twin(body: &Body) -> Value {
    let text = body.saved(&body.keys().expect("keys")).expect("the body as text");
    call("load", &json!({ "body": { "smb": text } }))["body"].clone()
}

/// Runs `op` once on a twin in the older table and once on `body` lent to it, and returns the bodies the second
/// run made, taken over. `request` writes the request around the body's number. The lent body must be as it was,
/// each body taken over must be what the twin's run made, and the older table must be empty at the end.
fn through(body: &Body, op: &str, request: &dyn Fn(&Value) -> Value) -> Vec<Body> {
    let ask = |number: &Value| {
        let mut r = request(number);
        r["keySalt"] = json!(7);
        r["withKeys"] = json!(true);
        r
    };
    assert_eq!(held(), 0, "{op}: the older table is empty to start with");
    let before = state(body);
    let there = twin(body);
    let want = call(op, &ask(&there));
    let lent = handover::lend(body).expect("lent");
    let got = call(op, &ask(&json!(lent.number())));
    drop(lent);
    assert_eq!(state(body), before, "{op} changed the body lent to it");
    let mut made = Vec::new();
    for part in ["body", "below", "above"] {
        let (wanted, given) = (&want[part], &got[part]);
        assert_eq!(wanted.is_number(), given.is_number(), "{op}: {part}");
        let Some(number) = given.as_i64() else {
            continue;
        };
        let taken = handover::adopt(number).unwrap_or_else(|e| panic!("{op}: {part}: {e}"));
        let info = call("info", &json!({ "body": wanted }));
        let volume = info["volumeMm3"].as_f64().expect("a volume");
        let read = taken.volume().expect("volume");
        assert!(
            (read - volume).abs() <= 1e-9 * volume,
            "{op}: {part}: {read} {volume}"
        );
        let faces = taken.faces().expect("faces").len();
        assert_eq!(u64::try_from(faces).ok(), info["faces"].as_u64(), "{op}: {part}");
        // the typed reader reads what the operation wrote on this very body, face for face
        let keys = taken.keys().expect("keys");
        let field = format!("{part}Keys");
        assert_eq!(keys, numbers(&got[field.as_str()]), "{op}: {part}");
        // and they are the keys the twin's run gave
        assert_eq!(
            sorted(keys),
            sorted(numbers(&want[field.as_str()])),
            "{op}: {part}"
        );
        assert_eq!(call("free", &json!({ "body": wanted }))["freed"], json!(true));
        made.push(taken);
    }
    assert_eq!(call("free", &json!({ "body": there }))["freed"], json!(true));
    assert_eq!(held(), 0, "{op}: nothing is left in the older table");
    made
}

fn cylinder() -> Value {
    json!({ "type": "cylinder", "origin": [10, 5, -1], "axis": [0, 0, 1], "diameterMm": 4, "heightMm": 17 })
}

#[test]
fn without_the_kernel_nothing_is_taken_over() {
    if sx_brep::KERNEL {
        return;
    }
    assert_eq!(
        refusal(handover::adopt(1)),
        "this build has no B-rep kernel (packages/brep/scripts/fetch-smlib.sh, then build again)"
    );
}

// the older operations that reach a body through the hand-over. An operation leaves this list when it is made
// over typed bodies and its C++ is deleted; nothing joins it
#[test]
fn the_operations_still_handed_over_are_the_ones_the_older_code_has() {
    // answered without the hand-over: they only read a body, free one or count
    let stay = ["count", "free", "info", "save", "tessellate"];
    let source = include_str!("../cpp/sx_brep.cpp");
    let (_, after) = source
        .split_once("Value run(const std::string& op, const Value& r)")
        .expect("the operations' dispatch");
    let (dispatch, _) = after.split_once("char* reply(").expect("the end of the dispatch");
    let has: BTreeSet<&str> = dispatch
        .split("op == \"")
        .skip(1)
        .map(|rest| rest.split_once('"').expect("a closing quote").0)
        .filter(|op| !stay.contains(op))
        .collect();
    let listed: BTreeSet<&str> = ROUTED.into_iter().collect();
    assert_eq!(listed.len(), ROUTED.len(), "an operation is listed twice");
    assert_eq!(listed, has);
    // the number at the time the hand-over was written: it only goes down
    assert!(ROUTED.len() <= 12, "{} operations are handed over", ROUTED.len());
}

#[test]
fn keys_written_on_a_body_read_back_face_for_face() {
    if !sx_brep::KERNEL {
        return;
    }
    let mut body = block();
    assert_eq!(body.keys().expect("keys"), KEYS);
    // the largest key there is, a face without one, and the rest changed
    let next = [(1 << 52) - 1, 0, 7, 1 << 26, (1 << 26) - 1, 1];
    body.set_keys(&next).expect("keys");
    assert_eq!(body.keys().expect("keys"), next);
    body.set_keys(&[0; 6]).expect("keys");
    assert_eq!(body.keys().expect("keys"), [0; 6]);
    // a body just made has none
    let plain = Body::cuboid([0.0; 3], [1.0; 3]).expect("a box");
    assert_eq!(plain.keys().expect("keys"), [0; 6]);
}

#[test]
fn keys_that_do_not_fit_the_body_are_refused_and_nothing_changes() {
    if !sx_brep::KERNEL {
        return;
    }
    let mut body = block();
    assert_eq!(
        refusal(body.set_keys(&KEYS[..5])),
        "keys: must be one for each face of the body"
    );
    assert_eq!(
        refusal(body.set_keys(&[])),
        "keys: must be one for each face of the body"
    );
    assert_eq!(
        refusal(body.set_keys(&[1, 2, 3, 4, 5, 1 << 52])),
        "keys: must be below 2^52"
    );
    assert_eq!(body.keys().expect("keys"), KEYS);
}

#[test]
fn a_lent_body_is_in_the_older_table_only_while_it_is_lent() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let body = block();
    assert_eq!(held(), 0);
    let lent = handover::lend(&body).expect("lent");
    let number = json!(lent.number());
    assert_eq!(held(), 1);
    // the older operations read the body and the keys written on it
    let info = call("info", &json!({ "body": number }));
    close(info["volumeMm3"].as_f64().expect("a volume"), 3000.0);
    let mesh = call("tessellate", &json!({ "body": number }));
    let read: Vec<u64> = mesh["faces"]
        .as_array()
        .expect("faces")
        .iter()
        .map(|f| f["key"].as_u64().expect("a key"))
        .collect();
    assert_eq!(read, KEYS);
    // it stays its owner's: the older table neither frees it nor gives it away
    assert_eq!(
        refused("free", &json!({ "body": number })),
        "body: is lent; its owner frees it"
    );
    assert_eq!(refusal(handover::adopt(lent.number())), NO_SUCH);
    assert_eq!(held(), 1);
    let was = lent.number();
    drop(lent);
    assert_eq!(held(), 0);
    assert_eq!(
        refused("info", &json!({ "body": number })),
        "body: no such body (freed, or from an earlier session)"
    );
    assert_eq!(refusal(handover::adopt(was)), NO_SUCH);
    // and the body is whole
    close(body.volume().expect("volume"), 3000.0);
    assert_eq!(body.keys().expect("keys"), KEYS);
}

#[test]
fn a_body_is_taken_over_once_and_only_from_a_number_the_table_has() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    assert_eq!(refusal(handover::adopt(0)), NO_SUCH);
    assert_eq!(refusal(handover::adopt(-1)), NO_SUCH);
    assert_eq!(refusal(handover::adopt(i64::MAX)), NO_SUCH);
    let made = call("box", &json!({ "min": [0, 0, 0], "max": [2, 3, 4] }))["body"].clone();
    let number = made.as_i64().expect("a number");
    let body = handover::adopt(number).expect("taken over");
    assert_eq!(held(), 0);
    assert_eq!(refusal(handover::adopt(number)), NO_SUCH);
    close(body.volume().expect("volume"), 24.0);
    // the older table no longer knows it, so nothing there can free it under its owner
    assert_eq!(call("free", &json!({ "body": made }))["freed"], json!(false));
    close(body.volume().expect("volume"), 24.0);
}

#[test]
fn every_maker_of_the_older_code_gives_a_body_that_is_taken_over_with_its_keys() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let text = {
        let body = block();
        body.saved(&KEYS).expect("the body as text")
    };
    let frame = json!({ "origin": [0, 0, 0], "normal": [0, 0, 1], "u": [1, 0, 0] });
    let square = json!({ "points": [[0, 0], [6, 0], [6, 6], [0, 6]] });
    let makers = [
        ("box", json!({ "min": [0, 0, 0], "max": [20, 10, 15] }), 3000.0),
        (
            "cylinder",
            json!({ "origin": [0, 0, 0], "axis": [0, 0, 1], "diameterMm": 4, "heightMm": 10 }),
            PI * 4.0 * 10.0,
        ),
        (
            "primitive",
            json!({ "type": "box", "sizeMm": [4, 5, 6], "frame": frame }),
            120.0,
        ),
        (
            "extrude",
            json!({ "frame": frame, "polygons": [{ "outer": square, "holes": [] }], "fromMm": 0, "toMm": 3 }),
            108.0,
        ),
        ("load", json!({ "body": { "smb": text } }), 3000.0),
    ];
    for (op, mut request, volume) in makers {
        request["keySalt"] = json!(11);
        request["withKeys"] = json!(true);
        let reply = call(op, &request);
        let body = handover::adopt(reply["body"].as_i64().expect("a number"))
            .unwrap_or_else(|e| panic!("{op}: {e}"));
        assert_eq!(held(), 0, "{op}");
        close(body.volume().expect("volume"), volume);
        let keys = body.keys().expect("keys");
        assert_eq!(keys, numbers(&reply["bodyKeys"]), "{op}");
        assert!(keys.iter().all(|&key| key != 0), "{op}: {keys:?}");
    }
}

#[test]
fn a_cut_of_a_lent_body_keeps_its_keys_and_leaves_it_whole() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let body = block();
    let made = through(
        &body,
        "subtract",
        &|n| json!({ "body": n, "solids": [cylinder()] }),
    );
    assert_eq!(made.len(), 1);
    close(made[0].volume().expect("volume"), 3000.0 - PI * 4.0 * 15.0);
    // each of the block's keys is on exactly one face, and the wall has a key of the step's own
    let keys = made[0].keys().expect("keys");
    assert_eq!(keys.len(), 7);
    for key in KEYS {
        assert_eq!(keys.iter().filter(|&&k| k == key).count(), 1, "{key} in {keys:?}");
    }
    assert!(keys.iter().all(|&key| key != 0), "{keys:?}");
}

#[test]
fn the_three_booleans_work_on_a_lent_body() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let body = block();
    // half in the block, half out of one side
    let tool = {
        let mut tool = Body::cuboid([15.0, 2.0, 5.0], [10.0, 6.0, 5.0]).expect("a tool");
        tool.set_keys(&[201, 202, 203, 204, 205, 206]).expect("keys");
        tool.saved(&tool.keys().expect("keys")).expect("the tool as text")
    };
    for (kind, volume) in [("union", 3150.0), ("difference", 2850.0), ("intersection", 150.0)] {
        let made = through(
            &body,
            "boolean",
            &|n| json!({ "a": n, "b": { "smb": tool }, "op": kind }),
        );
        assert_eq!(made.len(), 1, "{kind}");
        close(made[0].volume().expect("volume"), volume);
    }
    // the lent body as the second one
    let made = through(
        &body,
        "boolean",
        &|n| json!({ "a": { "smb": tool }, "b": n, "op": "difference" }),
    );
    close(made[0].volume().expect("volume"), 150.0);
}

#[test]
fn a_plane_cut_of_a_lent_body_gives_two_bodies() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let body = block();
    let plane = json!({ "point": [8, 0, 0], "normal": [1, 0, 0] });
    let made = through(&body, "cut", &|n| json!({ "body": n, "plane": plane }));
    assert_eq!(made.len(), 2);
    close(made[0].volume().expect("volume"), 1200.0);
    close(made[1].volume().expect("volume"), 1800.0);
}

#[test]
fn edges_and_faces_of_a_lent_body_are_worked_by_their_keys() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let body = block();
    let top = key_on(&body, [0.0, 0.0, 1.0], 15.0);
    let side = key_on(&body, [1.0, 0.0, 0.0], 0.0);
    // the edge along y where the top meets the side at x 0
    let edge = json!({ "a": [0, 0, 15], "b": [0, 10, 15], "keys": [top, side] });
    let made = through(
        &body,
        "fillet",
        &|n| json!({ "body": n, "edges": [edge], "radiusMm": 2 }),
    );
    close(made[0].volume().expect("volume"), 3000.0 - (4.0 - PI) * 10.0);
    let made = through(
        &body,
        "chamfer",
        &|n| json!({ "body": n, "edges": [edge], "distanceMm": 2 }),
    );
    close(made[0].volume().expect("volume"), 3000.0 - 2.0 * 10.0);
    let made = through(
        &body,
        "push",
        &|n| json!({ "body": n, "faceKey": top, "at": [10, 5, 15], "normal": [0, 0, 1], "distanceMm": 3 }),
    );
    close(made[0].volume().expect("volume"), 3600.0);
}

#[test]
fn an_extrude_joins_and_cuts_a_lent_target() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let body = block();
    let frame = json!({ "origin": [0, 0, 15], "normal": [0, 0, 1], "u": [1, 0, 0] });
    let square = json!([{ "outer": { "points": [[2, 2], [8, 2], [8, 8], [2, 8]] }, "holes": [] }]);
    let made = through(
        &body,
        "extrude",
        &|n| json!({ "target": n, "operation": "join", "frame": frame, "polygons": square, "fromMm": -1, "toMm": 3 }),
    );
    close(made[0].volume().expect("volume"), 3000.0 + 36.0 * 3.0);
    let made = through(
        &body,
        "extrude",
        &|n| json!({ "target": n, "operation": "cut", "frame": frame, "polygons": square, "fromMm": -3, "toMm": 1 }),
    );
    close(made[0].volume().expect("volume"), 3000.0 - 36.0 * 3.0);
}

#[test]
fn a_hole_in_a_body_taken_over_is_made_wider_when_the_body_is_lent_again() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let body = block();
    let holed = through(
        &body,
        "subtract",
        &|n| json!({ "body": n, "solids": [cylinder()] }),
    )
    .remove(0);
    let hole = json!({ "entry": [10, 5, 15], "axis": [0, 0, 1], "diameterMm": 4 });
    let made = through(
        &holed,
        "hole",
        &|n| json!({ "body": n, "hole": hole, "spec": { "diameterMm": 6 } }),
    );
    close(made[0].volume().expect("volume"), 3000.0 - PI * 9.0 * 15.0);
}

#[test]
fn lending_and_taking_over_many_times_leaves_the_older_table_empty() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let body = block();
    let before = state(&body);
    for _ in 0..200 {
        let lent = handover::lend(&body).expect("lent");
        let reply = call(
            "subtract",
            &json!({ "body": lent.number(), "keySalt": 7, "solids": [cylinder()] }),
        );
        assert_eq!(held(), 2);
        drop(lent);
        let cut = handover::adopt(reply["body"].as_i64().expect("a number")).expect("taken over");
        assert_eq!(held(), 0);
        assert_eq!(cut.faces().expect("faces").len(), 7);
    }
    assert_eq!(state(&body), before);
}

#[test]
fn a_slot_taken_over_reads_its_round_ends_as_cylinders() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    // the kernel keeps each round end, an arc run along its axis, as an extrusion
    let frame = json!({ "origin": [0, 0, 0], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] });
    let made = call(
        "extrude",
        &json!({ "frame": frame, "polygons": [{ "outer": { "start": [-10, -5], "segments": [
            { "to": [10, -5] }, { "to": [10, 5], "center": [10, 0], "sweepDeg": 180 },
            { "to": [-10, 5] }, { "to": [-10, -5], "center": [-10, 0], "sweepDeg": 180 }
        ] } }], "fromMm": 0, "toMm": 4 }),
    );
    let slot = handover::adopt(made["body"].as_i64().expect("a number")).expect("taken over");
    let mut ends = Vec::new();
    for surface in slot.faces().expect("faces").iter().map(sx_brep::Face::surface) {
        match surface {
            Surface::Plane { .. } => {}
            Surface::Cylinder { frame, radius } => ends.push((frame, radius)),
            other => panic!("not a face of a slot: {other:?}"),
        }
    }
    assert_eq!(ends.len(), 2, "{ends:?}");
    for (frame, radius) in ends {
        close(radius, 5.0);
        close(frame.z[2].abs(), 1.0);
        close(frame.origin[0].abs(), 10.0);
        close(frame.origin[1], 0.0);
    }
}
