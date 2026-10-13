// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The exact solid ops (brep.*) against the values the math gives: a closed solid, its volume and its bounds. The mesh
// path runs the same case on the tessellated inputs; where its answer is exact too, the two must agree. Every brep
// call goes through JSON with its bodies carried as text, the way the CLI runs them, one process per call. Skipped
// in a build without the kernel, and empty without the brep feature, so a plain `cargo test` passes over it.
#![cfg(feature = "brep")]
use serde_json::{Value, json};
use std::f64::consts::PI;
use std::io::Write;
use std::process::{Command, Stdio};

fn call(op: &str, req: &Value) -> Value {
    // bodies travel as text here, which sx-geom takes only from a developer
    sx_geom::json::allow_brep_text(true);
    let r = sx_geom::json::call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}"));
    serde_json::from_str(&r).expect("reply is JSON")
}

/// A body made by a brep op, as the text that carries it to the next call.
fn made(op: &str, mut req: Value) -> Value {
    req["save"] = json!(true);
    let r = call(&format!("brep.{op}"), &req);
    json!({ "smb": r["bodySmb"].as_str().expect("bodySmb") })
}

struct Solid {
    volume: f64,
    min: [f64; 3],
    max: [f64; 3],
}

fn triple(v: &Value) -> [f64; 3] {
    [0, 1, 2].map(|k| v[k].as_f64().expect("a number"))
}

fn brep_solid(body: &Value) -> Solid {
    let i = call("brep.info", &json!({ "body": body }));
    assert_eq!(i["manifold"], true, "not a closed solid: {i}");
    Solid {
        volume: i["volumeMm3"].as_f64().expect("volume"),
        min: triple(&i["bounds"]["min"]),
        max: triple(&i["bounds"]["max"]),
    }
}

/// The body as the welded mesh the mesh ops take.
fn mesh(body: &Value) -> Value {
    let t = call("brep.tessellate", &json!({ "body": body }));
    json!({ "positions": t["positions"], "indices": t["indices"] })
}

fn mesh_solid(m: &Value) -> Solid {
    let i = call("info", &json!({ "mesh": m }));
    assert_eq!(i["watertight"], true, "mesh is not closed: {i}");
    Solid {
        volume: i["volumeMm3"].as_f64().expect("volume"),
        min: triple(&i["bounds"]["min"]),
        max: triple(&i["bounds"]["max"]),
    }
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-6 * a.abs().max(b.abs()).max(1.0)
}

fn exact(s: &Solid, volume: f64, min: [f64; 3], max: [f64; 3]) -> bool {
    near(s.volume, volume) && (0..3).all(|k| near(s.min[k], min[k]) && near(s.max[k], max[k]))
}

/// The brep answer must be exact; the mesh one, when it is exact too, must match it.
fn check(name: &str, brep: &Solid, mesh: Option<&Solid>, volume: f64, min: [f64; 3], max: [f64; 3]) {
    assert!(
        exact(brep, volume, min, max),
        "{name}: brep gave {} in {:?}..{:?}, exact {volume} in {min:?}..{max:?}",
        brep.volume,
        brep.min,
        brep.max
    );
    if let Some(m) = mesh
        && exact(m, volume, min, max)
    {
        assert!(
            near(m.volume, brep.volume),
            "{name}: mesh {} and brep {} differ",
            m.volume,
            brep.volume
        );
    }
}

fn cube() -> Value {
    made("box", json!({ "min": [0, 0, 0], "max": [20, 20, 20] }))
}

#[test]
fn box_and_its_mesh() {
    if !sx_brep::KERNEL {
        return;
    }
    let c = made("box", json!({ "min": [1, 2, 3], "max": [11, 22, 33] }));
    let m = mesh_solid(&mesh(&c));
    check(
        "box",
        &brep_solid(&c),
        Some(&m),
        6000.0,
        [1.0, 2.0, 3.0],
        [11.0, 22.0, 33.0],
    );
    // flat faces tessellate exactly, so here the mesh path is right too
    assert!(exact(&m, 6000.0, [1.0, 2.0, 3.0], [11.0, 22.0, 33.0]), "box mesh");
}

#[test]
fn subtract_a_box_and_a_hole() {
    if !sx_brep::KERNEL {
        return;
    }
    let c = cube();
    let slot = json!([{ "type": "box", "min": [5, -1, 15], "max": [15, 21, 21] }]);
    let b = made("subtract", json!({ "body": c, "solids": slot }));
    let m = call("subtract", &json!({ "mesh": mesh(&c), "solids": slot }));
    let want = 8000.0 - 10.0 * 20.0 * 5.0;
    check(
        "slot",
        &brep_solid(&b),
        Some(&mesh_solid(&m["mesh"])),
        want,
        [0.0; 3],
        [20.0; 3],
    );
    // a through hole, flush with both faces: exact only on the brep side, as the mesh's circle is a polygon
    let hole = json!([{ "type": "cylinder", "origin": [10, 10, 0], "axis": [0, 0, 1], "diameterMm": 8, "heightMm": 20 }]);
    let h = made("subtract", json!({ "body": c, "solids": hole }));
    check(
        "hole",
        &brep_solid(&h),
        None,
        8000.0 - PI * 16.0 * 20.0,
        [0.0; 3],
        [20.0; 3],
    );
}

#[test]
fn union_and_intersection_of_boxes() {
    if !sx_brep::KERNEL {
        return;
    }
    let a = cube();
    let b = made("box", json!({ "min": [10, 10, 10], "max": [30, 30, 30] }));
    for (op, volume, min, max) in [
        ("union", 2.0 * 8000.0 - 1000.0, [0.0; 3], [30.0; 3]),
        ("intersection", 1000.0, [10.0; 3], [20.0; 3]),
        ("difference", 7000.0, [0.0; 3], [20.0; 3]),
    ] {
        let r = made("boolean", json!({ "op": op, "a": a, "b": b }));
        let m = call("boolean", &json!({ "op": op, "a": [mesh(&a)], "b": [mesh(&b)] }));
        check(
            op,
            &brep_solid(&r),
            Some(&mesh_solid(&m["mesh"])),
            volume,
            min,
            max,
        );
    }
}

#[test]
fn cut_in_two() {
    if !sx_brep::KERNEL {
        return;
    }
    let c = cube();
    let plane = json!({ "point": [0, 0, 7], "normal": [0, 0, 1] });
    let mut req = json!({ "body": c, "plane": plane, "save": true });
    let r = call("brep.cut", &req);
    let m = call("cut", &json!({ "mesh": mesh(&c), "plane": plane }));
    for (side, h, lo, hi) in [("below", 7.0, 0.0, 7.0), ("above", 13.0, 7.0, 20.0)] {
        let body = json!({ "smb": r[format!("{side}Smb")].as_str().expect("smb") });
        check(
            side,
            &brep_solid(&body),
            Some(&mesh_solid(&m[side])),
            400.0 * h,
            [0.0, 0.0, lo],
            [20.0, 20.0, hi],
        );
    }
    // a plane that misses leaves one side empty
    req["plane"] = json!({ "point": [0, 0, 25], "normal": [0, 0, 1] });
    let r = call("brep.cut", &req);
    assert!(r["above"].is_null(), "nothing above: {r}");
}

#[test]
fn extrude_with_a_hole() {
    if !sx_brep::KERNEL {
        return;
    }
    let b = made(
        "extrude",
        json!({
            "frame": { "origin": [0, 0, 0], "u": [1, 0, 0], "normal": [0, 0, 1] },
            "polygons": [{ "outer": { "points": [[0, 0], [30, 0], [30, 20], [0, 20]] }, "holes": [{ "center": [15, 10], "diameterMm": 6 }] }],
            "fromMm": 0, "toMm": 4
        }),
    );
    check(
        "extrude",
        &brep_solid(&b),
        None,
        (600.0 - 9.0 * PI) * 4.0,
        [0.0; 3],
        [30.0, 20.0, 4.0],
    );
}

#[test]
fn the_cli_runs_each_call_in_its_own_process() {
    if !sx_brep::KERNEL {
        return;
    }
    let cli = |op: &str, req: &Value, dev: bool| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_sx-geom"));
        if dev {
            cmd.env("SX_BREP_DEV", "1");
        } else {
            cmd.env_remove("SX_BREP_DEV");
        }
        let mut child = cmd
            .arg(op)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("sx-geom runs");
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(req.to_string().as_bytes())
            .expect("request written");
        child.wait_with_output().expect("sx-geom exits")
    };
    let run = |op: &str, req: &Value| -> Value {
        let out = cli(op, req, true);
        assert!(
            out.status.success(),
            "{op}: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        serde_json::from_slice(&out.stdout).expect("reply is JSON")
    };
    let b = run(
        "brep.box",
        &json!({ "min": [0, 0, 0], "max": [2, 3, 4], "save": true }),
    );
    let smb = b["bodySmb"].as_str().expect("bodySmb");
    let i = run("brep.info", &json!({ "body": { "smb": smb } }));
    assert!(near(i["volumeMm3"].as_f64().expect("volume"), 24.0), "{i}");
    // without the developer flag a body as text is refused before the kernel reads it
    let out = cli("brep.info", &json!({ "body": { "smb": smb } }), false);
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("SX_BREP_DEV"),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
}
