// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The older solid operations on bodies the engine holds: each takes a held body wherever a request names one, and
// every body one of them makes is held by the engine too, so it tessellates with the kernel's normals, surfaces and
// edges like any other and the older operations' own table is empty between calls. Skipped in a build without the
// kernel, and empty without the brep feature.
#![cfg(feature = "brep")]
use serde_json::{Value, json};
use std::f64::consts::PI;
use std::sync::{Mutex, MutexGuard};
use sx_geom::exact;

// the tests switch text bodies on and off for the process, so they run one at a time
static ONE: Mutex<()> = Mutex::new(());

fn alone() -> MutexGuard<'static, ()> {
    ONE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn text(op: &str, req: &Value) -> Result<String, String> {
    sx_geom::json::call(op, &req.to_string()).map_err(|e| e.to_string())
}

fn run(op: &str, req: &Value) -> Value {
    let reply = text(op, req).unwrap_or_else(|e| panic!("{op}: {e}"));
    serde_json::from_str(&reply).expect("reply is JSON")
}

fn refused(op: &str, req: &Value) -> String {
    text(op, req).expect_err("the op is refused")
}

/// How many bodies the older operations' own table holds.
fn older() -> u64 {
    let reply = sx_brep::call("count", "{}").expect("a count");
    let reply: Value = serde_json::from_str(&reply).expect("reply is JSON");
    reply["bodies"].as_u64().expect("a count")
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

fn handle(v: &Value) -> u32 {
    u32::try_from(v.as_u64().expect("a body number")).expect("a body number")
}

fn volume(body: &Value) -> f64 {
    run("brep.info", &json!({ "body": body }))["volumeMm3"]
        .as_f64()
        .expect("a volume")
}

/// The body's mesh as `brep.tessellate` gives it, held to what only the engine's own bodies have: a normal at
/// every triangle corner, the kernel's surface of every face, and the edges. Returns the face keys.
fn kernel_mesh(name: &str, body: &Value) -> Vec<u64> {
    let mesh = run("brep.tessellate", &json!({ "body": body }));
    let count = |field: &str| {
        mesh[field]
            .as_array()
            .unwrap_or_else(|| panic!("{name}: {field}"))
            .len()
    };
    let triangles = count("faceIds");
    assert!(triangles > 0, "{name}");
    assert_eq!(count("indices"), 3 * triangles, "{name}");
    assert_eq!(count("normals"), 6 * triangles, "{name}: packed corner normals");
    assert_eq!(count("surfaces"), count("faces"), "{name}");
    assert!(count("edges") > 0, "{name}");
    mesh["faces"]
        .as_array()
        .expect("faces")
        .iter()
        .map(|f| f["key"].as_u64().expect("a key"))
        .collect()
}

/// A 20 by 10 by 15 block lofted between two rectangles, exact and keyed: the engine holds it.
fn block() -> (Value, Vec<u64>) {
    let at = |z: f64| {
        json!({
            "frame": { "origin": [0, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] },
            "loops": [{ "points": [[0, 0], [20, 0], [20, 10], [0, 10]] }],
        })
    };
    let made = run(
        "sketch.loft",
        &json!({ "profiles": [at(0.0), at(15.0)], "operation": "new", "exact": true, "keySalt": 5, "withFaces": true }),
    );
    assert!(made["body"].is_u64(), "the block is exact: {}", made["exact"]);
    let keys = numbers(&made["bodyKeys"]);
    assert_eq!(keys.len(), 6);
    assert!(keys.iter().all(|&key| key != 0), "{keys:?}");
    (made["body"].clone(), keys)
}

fn cylinder() -> Value {
    json!({ "type": "cylinder", "origin": [10, 5, -1], "axis": [0, 0, 1], "diameterMm": 4, "heightMm": 17 })
}

/// The key of the one flat face of `body` that faces along `normal` at `offset` from the origin.
fn key_on(body: &Value, normal: [f64; 3], offset: f64) -> u64 {
    let mesh = run("brep.tessellate", &json!({ "body": body }));
    let found: Vec<u64> = mesh["faces"]
        .as_array()
        .expect("faces")
        .iter()
        .filter(|f| {
            let n = &f["surface"]["normal"];
            f["surface"]["kind"] == "plane"
                && (0..3).all(|k| (n[k].as_f64().unwrap_or(9.0) - normal[k]).abs() < 1e-9)
                && (f["surface"]["offset"].as_f64().unwrap_or(9e9) - offset).abs() < 1e-9
        })
        .map(|f| f["key"].as_u64().expect("a key"))
        .collect();
    assert_eq!(found.len(), 1, "one face on {normal:?} at {offset}");
    found[0]
}

/// Everything read of a held body that an operation must leave as it was.
fn state(body: &Value) -> (Value, String, Vec<u64>) {
    let saved = run("brep.save", &json!({ "body": body }));
    let keys = exact::with(handle(body), |held| held.keys.clone()).expect("held");
    (
        run("brep.info", &json!({ "body": body })),
        saved["smb"].as_str().expect("text").to_owned(),
        keys,
    )
}

/// Runs an older operation that names the held `body`, and returns its reply. The body must be as it was, each
/// body made must be held by the engine with the kernel's mesh, and the older table must be empty.
fn through(name: &str, body: &Value, op: &str, mut req: Value) -> Value {
    let before = state(body);
    let held = exact::count();
    req["keySalt"] = json!(7);
    req["withKeys"] = json!(true);
    let reply = run(op, &req);
    assert_eq!(state(body), before, "{name} changed the body it was given");
    let mut made = 0;
    for part in ["body", "below", "above"] {
        if reply[part].is_null() {
            continue;
        }
        made += 1;
        let keys = kernel_mesh(name, &reply[part]);
        assert_eq!(
            keys,
            numbers(&reply[format!("{part}Keys").as_str()]),
            "{name}: {part}"
        );
        assert!(
            exact::with(handle(&reply[part]), |_| ()).is_some(),
            "{name}: {part} is held"
        );
    }
    assert!(made > 0, "{name} made a body");
    assert_eq!(exact::count(), held + made, "{name}");
    assert_eq!(older(), 0, "{name}: the older table is empty");
    reply
}

fn free(reply: &Value) {
    for part in ["body", "below", "above"] {
        if !reply[part].is_null() {
            assert_eq!(
                run("brep.free", &json!({ "body": reply[part] })),
                json!({ "freed": true })
            );
        }
    }
}

#[test]
fn every_older_operation_takes_a_held_body_and_leaves_it_whole() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let start = exact::count();
    let (body, keys) = block();
    let top = key_on(&body, [0.0, 0.0, 1.0], 15.0);

    let cut = through(
        "subtract",
        &body,
        "brep.subtract",
        json!({ "body": body, "solids": [cylinder()] }),
    );
    close(volume(&cut["body"]), 3000.0 - PI * 4.0 * 15.0);
    // each of the block's keys is on exactly one face of the result, and the wall has the step's own
    let after = numbers(&cut["bodyKeys"]);
    assert_eq!(after.len(), 7);
    for key in &keys {
        assert_eq!(
            after.iter().filter(|k| *k == key).count(),
            1,
            "{key} in {after:?}"
        );
    }
    assert!(after.iter().all(|&key| key != 0), "{after:?}");

    // a body an older operation made is held like any other, and is taken again in either place
    let tool = run(
        "brep.box",
        &json!({ "min": [15, 2, 5], "max": [25, 8, 10], "keySalt": 9 }),
    )["body"]
        .clone();
    assert!(exact::with(handle(&tool), |_| ()).is_some());
    kernel_mesh("box", &tool);
    for (kind, size) in [("union", 3150.0), ("difference", 2850.0), ("intersection", 150.0)] {
        let made = through(
            kind,
            &body,
            "brep.boolean",
            json!({ "a": body, "b": tool, "op": kind }),
        );
        close(volume(&made["body"]), size);
        free(&made);
    }
    let made = through(
        "difference of the tool",
        &body,
        "brep.boolean",
        json!({ "a": tool, "b": body, "op": "difference" }),
    );
    close(volume(&made["body"]), 150.0);
    free(&made);

    let halves = through(
        "cut",
        &body,
        "brep.cut",
        json!({ "body": body, "plane": { "point": [8, 0, 0], "normal": [1, 0, 0] } }),
    );
    close(volume(&halves["below"]), 1200.0);
    close(volume(&halves["above"]), 1800.0);
    free(&halves);

    let pushed = through(
        "push",
        &body,
        "brep.push",
        json!({ "body": body, "faceKey": top, "at": [10, 5, 15], "normal": [0, 0, 1], "distanceMm": 3 }),
    );
    close(volume(&pushed["body"]), 3600.0);
    free(&pushed);

    let frame = json!({ "origin": [0, 0, 15], "normal": [0, 0, 1], "u": [1, 0, 0] });
    let square = json!([{ "outer": { "points": [[2, 2], [8, 2], [8, 8], [2, 8]] }, "holes": [] }]);
    let joined = through(
        "extrude join",
        &body,
        "brep.extrude",
        json!({ "target": body, "operation": "join", "frame": frame, "polygons": square, "fromMm": -1, "toMm": 3 }),
    );
    close(volume(&joined["body"]), 3000.0 + 36.0 * 3.0);
    free(&joined);

    free(&cut);
    for held in [&tool, &body] {
        assert_eq!(
            run("brep.free", &json!({ "body": held })),
            json!({ "freed": true })
        );
    }
    assert_eq!(exact::count(), start);
    assert_eq!(older(), 0);
}

// a box an older operation made, with flat sides: the result of one older operation goes into the next, a hole
// through it, the hole made wider, then a rounded and a cut corner
#[test]
fn what_one_older_operation_makes_goes_into_the_next() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let start = exact::count();
    let plain = run(
        "brep.box",
        &json!({ "min": [0, 0, 0], "max": [20, 10, 15], "keySalt": 3 }),
    )["body"]
        .clone();
    let (lid, side) = (
        key_on(&plain, [0.0, 0.0, 1.0], 15.0),
        key_on(&plain, [-1.0, 0.0, 0.0], 0.0),
    );
    let bored = through(
        "subtract of a box",
        &plain,
        "brep.subtract",
        json!({ "body": plain, "solids": [cylinder()] }),
    );
    let hole = json!({ "entry": [10, 5, 15], "axis": [0, 0, 1], "diameterMm": 4 });
    let wider = through(
        "hole",
        &bored["body"],
        "brep.hole",
        json!({ "body": bored["body"], "hole": hole, "spec": { "diameterMm": 6 } }),
    );
    close(volume(&wider["body"]), 3000.0 - PI * 9.0 * 15.0);
    let edge = json!({ "a": [0, 0, 15], "b": [0, 10, 15], "keys": [lid, side] });
    let round = through(
        "fillet",
        &wider["body"],
        "brep.fillet",
        json!({ "body": wider["body"], "edges": [edge], "radiusMm": 2 }),
    );
    close(
        volume(&round["body"]),
        3000.0 - PI * 9.0 * 15.0 - (4.0 - PI) * 10.0,
    );
    let flat = through(
        "chamfer",
        &wider["body"],
        "brep.chamfer",
        json!({ "body": wider["body"], "edges": [edge], "distanceMm": 2 }),
    );
    close(volume(&flat["body"]), 3000.0 - PI * 9.0 * 15.0 - 20.0);

    for made in [&bored, &wider, &round, &flat] {
        free(made);
    }
    assert_eq!(
        run("brep.free", &json!({ "body": plain })),
        json!({ "freed": true })
    );
    assert_eq!(exact::count(), start);
    assert_eq!(older(), 0);
}

#[test]
fn every_body_an_older_operation_makes_is_held_with_the_kernel_s_mesh() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let start = exact::count();
    let frame = json!({ "origin": [0, 0, 0], "normal": [0, 0, 1], "u": [1, 0, 0] });
    let square = json!({ "points": [[0, 0], [6, 0], [6, 6], [0, 6]] });
    let makers = [
        (
            "brep.box",
            json!({ "min": [0, 0, 0], "max": [20, 10, 15] }),
            3000.0,
        ),
        (
            "brep.cylinder",
            json!({ "origin": [0, 0, 0], "axis": [0, 0, 1], "diameterMm": 4, "heightMm": 10 }),
            PI * 4.0 * 10.0,
        ),
        (
            "brep.primitive",
            json!({ "type": "box", "sizeMm": [4, 5, 6], "frame": frame }),
            120.0,
        ),
        (
            "brep.extrude",
            json!({ "frame": frame, "polygons": [{ "outer": square, "holes": [] }], "fromMm": 0, "toMm": 3 }),
            108.0,
        ),
    ];
    for (op, mut req, size) in makers {
        req["keySalt"] = json!(11);
        req["withKeys"] = json!(true);
        let made = run(op, &req);
        assert_eq!(exact::count(), start + 1, "{op}");
        assert_eq!(older(), 0, "{op}");
        assert_eq!(
            run("brep.count", &json!({}))["bodies"].as_u64(),
            u64::try_from(start + 1).ok(),
            "{op}"
        );
        close(volume(&made["body"]), size);
        let keys = kernel_mesh(op, &made["body"]);
        assert_eq!(keys, numbers(&made["bodyKeys"]), "{op}");
        assert!(keys.iter().all(|&key| key != 0), "{op}: {keys:?}");
        // saved and loaded, it is a second held body with the same keys
        let saved = run("brep.save", &json!({ "body": made["body"] }));
        sx_geom::json::allow_brep_text(true);
        let loaded = run("brep.load", &json!({ "body": saved, "withKeys": true }));
        sx_geom::json::allow_brep_text(false);
        assert_eq!(exact::count(), start + 2, "{op}");
        assert_eq!(numbers(&loaded["bodyKeys"]), keys, "{op}");
        assert_eq!(kernel_mesh(op, &loaded["body"]), keys, "{op}");
        close(volume(&loaded["body"]), size);
        free(&loaded);
        free(&made);
    }
    assert_eq!(exact::count(), start);
    assert_eq!(older(), 0);
}

#[test]
fn a_number_no_body_is_held_under_is_refused_wherever_it_is_named() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let (body, _) = block();
    let gone = |field: &str| format!("brep: {field}: no such body (freed, or from an earlier session)");
    // small numbers, as the older table gave out, and large ones, as this one used to
    for never in [
        json!(0),
        json!(987_654),
        json!(2_147_483_648_u32),
        json!(4_294_967_296_u64),
        json!(1.5),
    ] {
        let union = |a: &Value, b: &Value| refused("brep.boolean", &json!({ "op": "union", "a": a, "b": b }));
        assert_eq!(union(&never, &body), gone("a"), "{never}");
        assert_eq!(union(&body, &never), gone("b"), "{never}");
        assert_eq!(
            refused("brep.subtract", &json!({ "body": never, "solids": [cylinder()] })),
            gone("body")
        );
        assert_eq!(
            refused("brep.extrude", &json!({ "target": never, "operation": "join" })),
            gone("target")
        );
        assert_eq!(refused("brep.info", &json!({ "body": never })), gone("body"));
        assert_eq!(
            refused("brep.tessellate", &json!({ "body": never })),
            gone("body")
        );
        assert_eq!(refused("brep.save", &json!({ "body": never })), gone("body"));
        assert_eq!(
            run("brep.free", &json!({ "body": never })),
            json!({ "freed": false })
        );
    }
    assert_eq!(older(), 0);
    assert_eq!(
        run("brep.free", &json!({ "body": body })),
        json!({ "freed": true })
    );
}

// the same cut two ways: on the body the engine holds, and on the same body sent as its saved text
#[test]
fn a_cut_of_a_held_body_is_the_cut_of_its_saved_text() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    // the surface kinds of each result, after the volume, face count, bounds and keys are held equal
    let both = |body: &Value| {
        let cut = |of: &Value| {
            run(
                "brep.subtract",
                &json!({ "body": of, "keySalt": 7, "withKeys": true, "solids": [cylinder()] }),
            )
        };
        let held = cut(body);
        let saved = run("brep.save", &json!({ "body": body }));
        sx_geom::json::allow_brep_text(true);
        let loaded = cut(&saved);
        sx_geom::json::allow_brep_text(false);
        let (a, b) = (
            run("brep.info", &json!({ "body": held["body"] })),
            run("brep.info", &json!({ "body": loaded["body"] })),
        );
        let (va, vb) = (
            a["volumeMm3"].as_f64().expect("a volume"),
            b["volumeMm3"].as_f64().expect("a volume"),
        );
        assert!((va - vb).abs() <= 1e-9 * vb, "{va} {vb}");
        assert_eq!(a["faces"], b["faces"]);
        assert_eq!(a["bounds"], b["bounds"]);
        let (ka, kb) = (numbers(&held["bodyKeys"]), numbers(&loaded["bodyKeys"]));
        assert_eq!(sorted(ka.clone()), sorted(kb));
        for made in [&held, &loaded] {
            free(made);
        }
        (ka, a["faceTypes"].clone(), b["faceTypes"].clone())
    };

    let (body, keys) = block();
    let (after, held, loaded) = both(&body);
    for key in &keys {
        assert_eq!(
            after.iter().filter(|k| *k == key).count(),
            1,
            "{key} in {after:?}"
        );
    }
    // a lofted block's four sides are flat spline surfaces. The held body keeps them as they were made and reading
    // saved text brings them back as planes; sorted into kinds, a flat face is a plane on both routes
    assert_eq!(held, loaded);
    assert_eq!(held, json!({ "cone": 1, "plane": 6 }));
    assert_eq!(
        run("brep.free", &json!({ "body": body })),
        json!({ "freed": true })
    );

    // a box an older operation made has the same kinds of surface either way
    let made = run(
        "brep.box",
        &json!({ "min": [0, 0, 0], "max": [20, 10, 15], "keySalt": 9 }),
    );
    let (_, held, loaded) = both(&made["body"]);
    assert_eq!(held, loaded);
    assert_eq!(held, json!({ "cone": 1, "plane": 6 }));
    free(&made);
    assert_eq!(older(), 0);
}

/// The stations of a ship's hull across x: six points each, keel to deck, in y and z.
const HULL: [(f64, [[f64; 2]; 6]); 8] = [
    (
        0.5,
        [
            [-0.25, 6.0],
            [0.25, 6.0],
            [0.5, 8.0],
            [0.5, 10.0],
            [-0.5, 10.0],
            [-0.5, 8.0],
        ],
    ),
    (
        12.0,
        [
            [-2.0, 1.5],
            [2.0, 1.5],
            [6.5, 7.3],
            [6.5, 13.2],
            [-6.5, 13.2],
            [-6.5, 7.3],
        ],
    ),
    (
        45.0,
        [
            [-7.0, 0.0],
            [7.0, 0.0],
            [10.5, 6.3],
            [10.5, 12.6],
            [-10.5, 12.6],
            [-10.5, 6.3],
        ],
    ),
    (
        90.0,
        [
            [-9.0, 0.0],
            [9.0, 0.0],
            [11.5, 6.0],
            [11.5, 12.0],
            [-11.5, 12.0],
            [-11.5, 6.0],
        ],
    ),
    (
        130.0,
        [
            [-9.0, 0.0],
            [9.0, 0.0],
            [11.5, 6.0],
            [11.5, 12.0],
            [-11.5, 12.0],
            [-11.5, 6.0],
        ],
    ),
    (
        175.0,
        [
            [-7.0, 0.0],
            [7.0, 0.0],
            [10.5, 6.1],
            [10.5, 12.2],
            [-10.5, 12.2],
            [-10.5, 6.1],
        ],
    ),
    (
        205.0,
        [
            [-3.0, 1.5],
            [3.0, 1.5],
            [8.0, 7.2],
            [8.0, 12.8],
            [-8.0, 12.8],
            [-8.0, 7.2],
        ],
    ),
    (
        217.5,
        [
            [-0.899_999_999_999_999_9, 4.0],
            [0.899_999_999_999_999_9, 4.0],
            [3.0, 6.968_421_052_631_578],
            [3.0, 10.0],
            [-3.0, 10.0],
            [-3.0, 6.968_421_052_631_578],
        ],
    ),
];

/// The most text a project keeps for one solid (`packages/cad-history`): past it a part is a mesh on the route
/// that carries bodies as text.
const TEXT_CAP: usize = 8_388_608;

// a hull with five rows of 55 portholes through it stays exact where the engine holds the body: no step goes by
// way of text, which this body is too long for
#[test]
fn a_hull_with_more_holes_than_text_can_carry_stays_exact() {
    if !sx_brep::KERNEL {
        return;
    }
    let _one = alone();
    let start = exact::count();
    let stations: Vec<Value> = HULL
        .iter()
        .map(|(x, points)| {
            json!({
                "frame": { "origin": [x, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] },
                "loops": [{ "points": points }],
            })
        })
        .collect();
    let made = run(
        "sketch.loft",
        &json!({ "profiles": stations, "smooth": true, "operation": "new", "exact": true, "keySalt": 1000, "withFaces": true }),
    );
    assert!(made["body"].is_u64(), "the hull is exact: {}", made["exact"]);
    let keys = numbers(&made["bodyKeys"]);
    let mut hull = made["body"].clone();
    let whole = volume(&hull);
    // a row is one sketch of 55 circles on a plane beside the hull, cut through both sides
    let frame = json!({ "origin": [0, -15, 0], "normal": [0, 1, 0], "u": [1, 0, 0] });
    for (row, z) in [5.0, 6.4, 7.8, 9.2, 10.6].into_iter().enumerate() {
        let circles: Vec<Value> = (0..55)
            .map(|i| json!({ "outer": { "center": [24.0 + 3.0 * f64::from(i), -z], "diameterMm": 1.0 }, "holes": [] }))
            .collect();
        let cut = run(
            "brep.extrude",
            &json!({ "target": hull, "operation": "cut", "frame": frame, "polygons": circles, "fromMm": 0, "toMm": 30, "keySalt": 2000 + row }),
        );
        assert_eq!(cut["touches"], json!(true), "row {row}");
        assert_eq!(
            run("brep.free", &json!({ "body": hull })),
            json!({ "freed": true })
        );
        hull = cut["body"].clone();
        assert_eq!(older(), 0, "row {row}");
    }
    let info = run("brep.info", &json!({ "body": hull }));
    assert_eq!(info["manifold"], json!(true));
    let walls =
        info["faceTypes"]["cone"].as_u64().unwrap_or(0) + info["faceTypes"]["cylinder"].as_u64().unwrap_or(0);
    assert!(walls > 220, "{walls} hole walls: {}", info["faceTypes"]);
    let after = info["volumeMm3"].as_f64().expect("a volume");
    assert!(after < whole && after > 0.85 * whole, "{after} of {whole}");
    // the hull's own faces keep their keys, each on at least one face (a side with holes through it stays one face)
    let mesh_keys = kernel_mesh("hull", &hull);
    for key in &keys {
        assert!(mesh_keys.contains(key), "{key}");
    }
    let saved = run("brep.save", &json!({ "body": hull }));
    let chars = saved["smb"].as_str().expect("text").len();
    assert!(chars > TEXT_CAP, "the body's text is {chars} characters");
    // as text the older operations refuse it, so a route that carries bodies as text stops here
    sx_geom::json::allow_brep_text(true);
    let as_text = refused("brep.load", &json!({ "body": saved }));
    sx_geom::json::allow_brep_text(false);
    assert_eq!(as_text, "brep: body: saved body exceeds 8 MiB");
    // held by number it goes on: a deck house joined to it is one exact body
    let house = json!({ "type": "box", "sizeMm": [150, 19, 3.1], "frame": { "origin": [113, 0, 11.9], "u": [1, 0, 0], "normal": [0, 0, 1] } });
    let house = run("brep.primitive", &house)["body"].clone();
    let joined = run(
        "brep.boolean",
        &json!({ "op": "union", "a": hull, "b": house, "keySalt": 3000 }),
    );
    let with_house = run("brep.info", &json!({ "body": joined["body"] }));
    assert_eq!(with_house["manifold"], json!(true));
    assert!(with_house["volumeMm3"].as_f64().expect("a volume") > after);
    kernel_mesh("hull and house", &joined["body"]);
    for made in [&house, &joined["body"]] {
        assert_eq!(
            run("brep.free", &json!({ "body": made })),
            json!({ "freed": true })
        );
    }
    assert_eq!(
        run("brep.free", &json!({ "body": hull })),
        json!({ "freed": true })
    );
    assert_eq!(exact::count(), start);
    assert_eq!(older(), 0);
}
