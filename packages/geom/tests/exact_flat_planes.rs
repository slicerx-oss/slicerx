// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A flat face a join moves onto an exact plane keeps a plane cut to the face, so a tessellation with a longest edge
// works over the face and not over a plane with no end. Each case runs in its own process, stopped if it runs on,
// so a tessellation that never answers fails its test and not the whole run.
#![cfg(feature = "brep")]
use serde_json::{Value, json};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use sx_brep::{Body, Tessellation};
use sx_geom::exact as table;
use sx_geom::fm::Fm;

const CASE: &str = "SX_FLAT_PLANES_CASE";
/// how long a case's process may run before it is stopped
const STOP_AFTER: Duration = Duration::from_secs(30);
/// a 1 mm longest edge on a part this size answers well within this, in a release build
const ANSWER_MS: f64 = 1000.0;

fn call(op: &str, req: &Value) -> Value {
    let reply = sx_geom::json::call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}"));
    serde_json::from_str(&reply).expect("reply is JSON")
}

fn handle(v: &Value) -> u32 {
    u32::try_from(v.as_u64().expect("a body")).expect("a handle")
}

fn rect(hw: f64, hh: f64) -> Value {
    json!({ "points": [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] })
}

/// an exact loft from a 24 by 16 mm top at z 20 down to a base `deg` wider each way at z 0
fn taper(deg: f64) -> u32 {
    let grow = 20.0 * deg.to_radians().m_tan();
    let level = |z: f64, l: Value| json!({ "frame": { "origin": [0, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] }, "loops": [l] });
    handle(
        &call(
            "sketch.loft",
            &json!({ "profiles": [level(0.0, rect(12.0 + grow, 8.0 + grow)), level(20.0, rect(12.0, 8.0))],
                "operation": "new", "exact": true, "keySalt": 7 }),
        )["body"],
    )
}

fn pushed(body: u32, mm: f64) -> u32 {
    handle(
        &call(
            "brep.push",
            &json!({ "body": body, "at": [0, 0, 20], "normal": [0, 0, 1], "distanceMm": mm }),
        )["body"],
    )
}

fn body(case: &str) -> u32 {
    let w: Vec<&str> = case.split(' ').collect();
    match w[0] {
        "loft" => pushed(taper(w[1].parse().expect("degrees")), w[2].parse().expect("mm")),
        "extrude" => handle(
            &call(
                "brep.extrude",
                &json!({ "frame": { "origin": [0, 0, 0], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] },
                    "polygons": [{ "outer": rect(12.0, 8.0) }], "fromMm": 0, "toMm": 10, "taperDeg": 10 }),
            )["body"],
        ),
        // a hole made narrower fills it with a rod first, and the join puts the loft's sides on planes
        "hole" => {
            let cylinder = json!({ "type": "cylinder", "origin": [0, 0, -1], "axis": [0, 0, 1], "diameterMm": 4, "heightMm": 22 });
            let bored = call(
                "brep.subtract",
                &json!({ "body": taper(11.3), "solids": [cylinder] }),
            )["body"]
                .clone();
            let hole = json!({ "entry": [0, 0, 20], "axis": [0, 0, 1], "diameterMm": 4 });
            handle(
                &call(
                    "brep.hole",
                    &json!({ "body": bored, "hole": hole, "spec": { "diameterMm": 2 } }),
                )["body"],
            )
        }
        "box" => pushed(
            handle(&call("brep.box", &json!({ "min": [-12, -8, 0], "max": [12, 8, 20] }))["body"]),
            5.0,
        ),
        "cone" => pushed(
            table::hold(
                Body::cone([0.0; 3], 16.0, 12.0, 20.0).expect("a cone"),
                Vec::new(),
            )
            .expect("held"),
            5.0,
        ),
        _ => panic!("no case {case}"),
    }
}

/// Run by the process a case starts: the body, then its tessellation at a 0.05 mm chord and a 1 mm longest edge,
/// timed, with the mesh's volume beside the body's.
#[test]
fn one_case() {
    let Ok(case) = std::env::var(CASE) else { return };
    let held = body(&case);
    table::with(held, |kept| {
        let start = Instant::now();
        let mesh = kept
            .body
            .tessellate(&Tessellation {
                chord_mm: 0.05,
                max_edge_mm: 1.0,
                ..Tessellation::default()
            })
            .expect("a mesh");
        let ms = start.elapsed().as_secs_f64() * 1e3;
        let at = |i: u32| mesh.positions[i as usize];
        let volume: f64 = mesh
            .triangles
            .iter()
            .map(|tri| {
                let [p0, p1, p2] = tri.map(at);
                (p0[0] * (p1[1] * p2[2] - p1[2] * p2[1]) - p0[1] * (p1[0] * p2[2] - p1[2] * p2[0])
                    + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0]))
                    / 6.0
            })
            .sum();
        println!(
            "FLAT_PLANES {ms:.1} {} {volume:.4} {:.4}",
            mesh.positions.len(),
            kept.body.volume().expect("a volume")
        );
    })
    .expect("held");
}

/// Starts `case` in its own process and returns its time in ms, its point count, and the mesh's and the body's
/// volumes. A process still running after `STOP_AFTER` is stopped and fails the test.
fn measured(case: &str) -> (f64, usize, f64, f64) {
    let mut child = Command::new(std::env::current_exe().expect("this test"))
        .args(["--exact", "one_case", "--nocapture", "--test-threads=1"])
        .env(CASE, case)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("a process");
    let start = Instant::now();
    while child.try_wait().expect("its state").is_none() {
        if start.elapsed() > STOP_AFTER {
            let _ = child.kill();
            let _ = child.wait();
            panic!("{case}: no mesh after {} s", STOP_AFTER.as_secs());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = child.wait_with_output().expect("its output");
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text
        .lines()
        .find_map(|l| l.split_once("FLAT_PLANES ").map(|(_, rest)| rest))
        .unwrap_or_else(|| {
            panic!(
                "{case}: no answer\n{text}\n{}",
                String::from_utf8_lossy(&out.stderr)
            )
        });
    let w: Vec<&str> = line.split(' ').collect();
    let n = |i: usize| -> f64 { w[i].parse().expect("a number") };
    let points: usize = w[1].parse().expect("a count");
    println!("{case}: {:.1} ms, {points} points", n(0));
    (n(0), points, n(2), n(3))
}

fn answers(case: &str) {
    if !sx_brep::KERNEL {
        return;
    }
    let (ms, points, mesh, body) = measured(case);
    // a 1 mm longest edge over every face of a part this size is thousands of points, not the 12 corners
    assert!(points > 1000, "{case}: {points} points");
    assert!(
        (mesh - body).abs() < 1e-2 * body,
        "{case}: the mesh holds {mesh} mm3 of the body's {body} mm3"
    );
    if !cfg!(debug_assertions) {
        assert!(ms < ANSWER_MS, "{case}: {ms:.0} ms");
    }
}

#[test]
fn a_pushed_taper_loft_tessellates_with_a_longest_edge() {
    for case in ["loft 11.3 5", "loft 11.3 -5", "loft 30 5", "loft 30 -5"] {
        answers(case);
    }
}

#[test]
fn a_tapered_extrude_tessellates_with_a_longest_edge() {
    answers("extrude");
}

#[test]
fn a_narrower_hole_in_a_taper_loft_tessellates_with_a_longest_edge() {
    answers("hole");
}

#[test]
fn a_pushed_box_and_cone_still_tessellate_with_a_longest_edge() {
    for case in ["box", "cone"] {
        answers(case);
    }
}
