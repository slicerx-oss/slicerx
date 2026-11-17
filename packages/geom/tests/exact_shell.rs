// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A held exact body shelled through the engine's own call (brep.shell): the faces it keeps carry their keys and the
// faces it makes get keys of the step, each of their own; the open faces are found by key or by place, and refused in
// the mesh shell's words; a box, a cylinder and a cone shelled closed keep a wall within 0.01 mm of the one asked; a
// curved lofted body open at its end is refused before the kernel is asked, since the kernel leaves such a wall open or
// fails outright, so a replay runs it on the mesh. A smooth loft and a ruled taper shelled closed stay exact, the
// taper with its closed-form volume. A closed shell whose wall strays from the one asked, or cannot be read, is refused
// too. A cube and a cylinder shelled closed, alone and joined to a box through the wall into the cavity, mesh as the
// body. A straight-lofted taper, pushed or not, and a pushed cone shelled closed answer within the step's time limit,
// held exact or refused. Tapers and cones with an end open hold their wall everywhere, their rim included, or run on
// the mesh.
// Empty without the brep feature, so a workspace test run that names every test target passes over it.
#![cfg(feature = "brep")]
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use sx_brep::{Body, Mesh, Tessellation};
use sx_geom::exact as table;
use sx_geom::fm::Fm;

/// How far a wall may come out from the thickness asked, in mm.
const WALL_MM: f64 = 0.01;

fn op(name: &str, request: &Value) -> Value {
    let reply = sx_geom::json::call(name, &request.to_string()).unwrap_or_else(|e| panic!("{name}: {e}"));
    serde_json::from_str(&reply).expect("a JSON reply")
}

fn refusal(name: &str, request: &Value) -> String {
    sx_geom::json::call(name, &request.to_string())
        .expect_err("a refusal")
        .to_string()
}

fn level(z: f64, lp: &Value) -> Value {
    json!({ "frame": { "origin": [0, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] }, "loops": [lp] })
}

fn circle(d: f64) -> Value {
    json!({ "type": "circle", "center": [0, 0], "diameterMm": d })
}

fn ellipse(w: f64, h: f64) -> Value {
    json!({ "type": "ellipse", "center": [0, 0], "widthMm": w, "heightMm": h, "angleDeg": 0 })
}

fn number(v: &Value) -> u32 {
    u32::try_from(v.as_u64().expect("a body number")).expect("a body number")
}

fn keys(v: &Value) -> Vec<u64> {
    v.as_array()
        .expect("keys")
        .iter()
        .map(|k| k.as_u64().expect("a key"))
        .collect()
}

fn fine() -> Tessellation {
    Tessellation {
        chord_mm: 0.002,
        max_edge_mm: 0.8,
        ..Tessellation::default()
    }
}

/// Each face's mesh points off its edges.
fn inside_points(m: &Mesh) -> Vec<Vec<[f64; 3]>> {
    let on_edge: HashSet<u32> = m.edges.iter().flat_map(|e| e.points.iter().copied()).collect();
    let mut out = vec![Vec::new(); m.surfaces.len()];
    let mut seen = HashSet::new();
    for (t, &f) in m.triangles.iter().zip(&m.faces) {
        for &v in t {
            if !on_edge.contains(&v) && seen.insert(v) {
                out[f as usize].push(m.positions[v as usize]);
            }
        }
    }
    out
}

/// The farthest a point of the inner side of `shelled`, below `below`, is from `wall` off `from`, and how many points
/// were read.
fn wall_off(from: &Body, shelled: &Body, wall: f64, below: f64) -> (f64, usize) {
    let (mut worst, mut n) = (0.0f64, 0);
    for points in inside_points(&shelled.tessellate(&fine()).expect("a mesh")) {
        let d: Vec<f64> = points
            .iter()
            .filter(|p| p[2] < below)
            .map(|&p| from.distance_to(p).expect("a distance"))
            .collect();
        if d.first().is_none_or(|&first| first < wall / 2.0) {
            continue;
        }
        n += d.len();
        worst = d.iter().fold(worst, |w, x| w.max((x - wall).abs()));
    }
    (worst, n)
}

/// `body` shelled closed to `wall` through the engine: held, and its inner side within [`WALL_MM`] of the wall asked.
fn closed_and_held(body: u32, wall: f64) -> u32 {
    let shelled = op(
        "brep.shell",
        &json!({ "body": body, "wallMm": wall, "keySalt": 8 }),
    );
    let hollow = number(&shelled["body"]);
    let (off, n) = table::with(body, |from| {
        table::with(hollow, |to| wall_off(&from.body, &to.body, wall, f64::INFINITY))
    })
    .flatten()
    .expect("both held");
    assert!(
        n > 100 && off <= WALL_MM,
        "a {wall} mm wall: {off} mm over {n} points"
    );
    hollow
}

#[test]
fn a_shell_keeps_the_keys_of_the_faces_it_keeps_and_keys_the_faces_it_makes() {
    if !sx_brep::KERNEL {
        return;
    }
    let made = op(
        "brep.box",
        &json!({ "min": [0, 0, 0], "max": [40, 30, 20], "keySalt": 3, "withKeys": true }),
    );
    let before = keys(&made["bodyKeys"]);
    let top = json!({ "at": [20, 15, 20], "normal": [0, 0, 1] });
    let shelled = op(
        "brep.shell",
        &json!({ "body": made["body"], "open": [top], "wallMm": 2, "keySalt": 4, "withKeys": true }),
    );
    let after = keys(&shelled["bodyKeys"]);
    assert_eq!(after.len(), 11);
    let kept: Vec<u64> = after.iter().copied().filter(|k| before.contains(k)).collect();
    let fresh: Vec<u64> = after.iter().copied().filter(|k| !before.contains(k)).collect();
    // the five faces left on the box keep theirs and the rim left of the top its key; the five inner faces are the
    // step's, each its own
    assert_eq!(kept.len(), 6, "{after:?}");
    assert_eq!(kept.iter().collect::<HashSet<_>>().len(), 6, "{after:?}");
    assert_eq!(fresh.len(), 5, "{after:?}");
    assert!(fresh.iter().all(|&k| k != 0));
    assert_eq!(fresh.iter().collect::<HashSet<_>>().len(), 5);
    // the open face is found as the top, whose key the rim keeps
    let open = keys(&shelled["openKeys"]);
    assert_eq!(open.len(), 1);
    assert!(before.contains(&open[0]) && after.contains(&open[0]));
    // found again by its key from anywhere, as a replay saves it
    let by_key = op(
        "brep.shell",
        &json!({ "body": made["body"], "open": [{ "at": [0, 0, 0], "normal": [1, 0, 0], "key": open[0] }], "wallMm": 2, "keySalt": 4, "withKeys": true }),
    );
    assert_eq!(keys(&by_key["bodyKeys"]), after);
    let info = op("brep.info", &json!({ "body": shelled["body"] }));
    assert!(
        (info["volumeMm3"].as_f64().unwrap() - (24000.0 - 36.0 * 26.0 * 18.0)).abs() < 1e-6,
        "{info}"
    );
    for n in [&made["body"], &shelled["body"], &by_key["body"]] {
        table::free(number(n));
    }
}

#[test]
fn open_faces_are_refused_in_the_mesh_shell_s_words() {
    if !sx_brep::KERNEL {
        return;
    }
    let made = op(
        "brep.box",
        &json!({ "min": [0, 0, 0], "max": [10, 10, 10], "keySalt": 3, "withKeys": true }),
    );
    let shell = |open: Value, wall: f64| {
        refusal(
            "brep.shell",
            &json!({ "body": made["body"], "open": open, "wallMm": wall }),
        )
    };
    assert_eq!(shell(json!([]), 0.0), "wallMm: must be above 0 (at most 1000 mm)");
    assert_eq!(
        shell(json!([{ "at": [5, 5, 12], "normal": [0, 0, 1] }]), 1.0),
        "open: a face to open is not on a face of the body; pick it again"
    );
    assert_eq!(
        shell(json!([{ "at": [5, 5, 10], "normal": [0, 0, 1], "key": 99 }]), 1.0),
        "brep: faceReference: the face reference is missing; repair the reference before editing"
    );
    let every: Vec<Value> = [
        ([5, 5, 10], [0, 0, 1]),
        ([5, 5, 0], [0, 0, -1]),
        ([5, 0, 5], [0, -1, 0]),
        ([5, 10, 5], [0, 1, 0]),
        ([0, 5, 5], [-1, 0, 0]),
        ([10, 5, 5], [1, 0, 0]),
    ]
    .iter()
    .map(|(at, n)| json!({ "at": at, "normal": n }))
    .collect();
    assert_eq!(
        shell(Value::Array(every), 1.0),
        "open: opening every face leaves no body; leave at least one face closed"
    );
    table::free(number(&made["body"]));
}

/// A smooth loft through a circle, an ellipse and a smaller circle, 20 mm tall.
fn vase() -> Value {
    json!([
        level(0.0, &circle(20.0)),
        level(10.0, &ellipse(26.0, 18.0)),
        level(20.0, &circle(16.0))
    ])
}

#[test]
fn a_box_a_cylinder_and_a_cone_shelled_closed_keep_their_wall_within_a_hundredth() {
    if !sx_brep::KERNEL {
        return;
    }
    let made = [
        op("brep.box", &json!({ "min": [0, 0, 0], "max": [30, 20, 15] })),
        op(
            "brep.primitive",
            &json!({ "type": "cylinder", "diameterMm": 20, "heightMm": 20 }),
        ),
        op(
            "brep.primitive",
            &json!({ "type": "cone", "diameterMm": 20, "topDiameterMm": 12, "heightMm": 20 }),
        ),
    ];
    for body in made.iter().map(|m| number(&m["body"])) {
        for wall in [1.0, 2.0, 3.0] {
            let shelled = op(
                "brep.shell",
                &json!({ "body": body, "wallMm": wall, "keySalt": 8, "withKeys": true }),
            );
            let hollow = number(&shelled["body"]);
            let (off, n) = table::with(body, |from| {
                table::with(hollow, |to| wall_off(&from.body, &to.body, wall, f64::INFINITY))
            })
            .flatten()
            .expect("both held");
            assert!(
                n > 100 && off <= WALL_MM,
                "a {wall} mm wall: {off} mm over {n} points"
            );
            table::free(hollow);
        }
        table::free(body);
    }
}

/// A smooth loft through a circle, an ellipse and a smaller circle: shelled closed, it stays exact with its wall within
/// a hundredth of the one asked. Open at its end, it is refused in the step's own words and nothing is held, so a
/// replay shells it on the mesh.
#[test]
fn a_curved_lofted_body_shelled_closed_stays_exact_and_open_at_its_end_is_refused() {
    if !sx_brep::KERNEL {
        return;
    }
    let body = lofted(&vase(), true);
    for wall in [1.0, 2.0, 3.0] {
        closed_and_held(body, wall);
        let held = table::count();
        // open at its top: refused before the kernel is asked, which leaves this wall open along the rim
        let open = refusal(
            "brep.shell",
            &json!({ "body": body, "open": [{ "at": [0, 0, 20], "normal": [0, 0, 1] }], "wallMm": wall, "keySalt": 8 }),
        );
        assert!(
            open.starts_with(&format!(
                "shell: a {wall} mm wall could not be made exact on this body"
            )),
            "{open}"
        );
        assert_eq!(table::count(), held);
    }
    table::free(body);
}

/// A loft through the same three loops without smoothing, on which the kernel's shell with a face open fails outright
/// and ends the process.
#[test]
fn a_lofted_body_open_at_an_end_is_refused_before_the_kernel_is_asked() {
    if !sx_brep::KERNEL {
        return;
    }
    let lofted = op(
        "sketch.loft",
        &json!({ "profiles": vase(), "smooth": false, "operation": "new", "exact": true, "keySalt": 7 }),
    );
    let body = number(&lofted["body"]);
    let held = table::count();
    for (at, normal) in [([0, 0, 20], [0, 0, 1]), ([0, 0, 0], [0, 0, -1])] {
        // reaching the next line at all shows the kernel was not asked: asked, it ends this process
        let open = refusal(
            "brep.shell",
            &json!({ "body": body, "open": [{ "at": at, "normal": normal }], "wallMm": 2, "keySalt": 8 }),
        );
        assert_eq!(
            open,
            "shell: a 2 mm wall could not be made exact on this body (with a face open, only a body of flat faces, \
             cylinders and cones is shelled exact)"
        );
        assert_eq!(table::count(), held);
    }
    table::free(body);
}

fn offset_circle(d: f64, c: [f64; 2]) -> Value {
    json!({ "type": "circle", "center": c, "diameterMm": d })
}

fn offset_ellipse(w: f64, h: f64, c: [f64; 2]) -> Value {
    json!({ "type": "ellipse", "center": c, "widthMm": w, "heightMm": h, "angleDeg": 0 })
}

fn lofted(profiles: &Value, smooth: bool) -> u32 {
    let made = op(
        "sketch.loft",
        &json!({ "profiles": profiles, "smooth": smooth, "operation": "new", "exact": true, "keySalt": 7 }),
    );
    number(&made["body"])
}

/// A closed shell whose inner wall strays from the wall asked, though its triangles stay on its own surface, is
/// refused in the step's own words and not held, so a replay shells it on the mesh.
#[test]
fn a_closed_shell_whose_wall_strays_from_the_one_asked_is_refused() {
    if !sx_brep::KERNEL {
        return;
    }
    // a smooth loft through five loops set off to one side as it rises
    let body = lofted(
        &json!([
            level(0.0, &offset_circle(20.0, [0.0, 0.0])),
            level(6.0, &offset_ellipse(26.0, 18.0, [0.0, 0.0])),
            level(12.0, &offset_circle(18.0, [1.0, 0.0])),
            level(18.0, &offset_ellipse(20.0, 14.0, [2.0, 1.0])),
            level(24.0, &offset_circle(12.0, [3.0, 0.0]))
        ]),
        true,
    );
    let held = table::count();
    let why = refusal("brep.shell", &json!({ "body": body, "wallMm": 2, "keySalt": 8 }));
    assert_eq!(why, "shell: a 2 mm wall could not be made exact on this body");
    assert_eq!(table::count(), held);
    table::free(body);
}

/// A ruled loft that narrows and widens again: the kernel makes its closed shell without a word, and it is refused
/// in the step's own words, whether its wall strays or cannot be read at all.
#[test]
fn a_closed_shell_of_a_waisted_ruled_loft_is_refused() {
    if !sx_brep::KERNEL {
        return;
    }
    let body = lofted(
        &json!([
            level(0.0, &circle(20.0)),
            level(8.0, &circle(14.0)),
            level(16.0, &circle(20.0)),
            level(24.0, &circle(12.0))
        ]),
        false,
    );
    let held = table::count();
    for wall in [1.0, 2.0, 3.0] {
        let why = refusal(
            "brep.shell",
            &json!({ "body": body, "wallMm": wall, "keySalt": 8 }),
        );
        assert_eq!(
            why,
            format!("shell: a {wall} mm wall could not be made exact on this body")
        );
        assert_eq!(table::count(), held);
    }
    table::free(body);
}

/// A ruled loft through three rectangles, smaller as it rises: shelled closed, it stays exact with its wall within a
/// hundredth of the one asked, and its volume is the closed form's.
#[test]
fn a_closed_shell_of_a_ruled_taper_stays_exact() {
    if !sx_brep::KERNEL {
        return;
    }
    let rect = |w: f64, h: f64| {
        let (x, y) = (w / 2.0, h / 2.0);
        json!({ "points": [[-x, -y], [x, -y], [x, y], [-x, y]] })
    };
    let body = lofted(
        &json!([
            level(0.0, &rect(30.0, 20.0)),
            level(10.0, &rect(24.0, 16.0)),
            level(20.0, &rect(18.0, 12.0))
        ]),
        false,
    );
    for wall in [1.0f64, 2.0, 3.0] {
        let hollow = closed_and_held(body, wall);
        // the taper with each side plane moved in by the wall, and its top and bottom: a quadratic in height, so
        // Simpson's rule is exact
        let (x, y) = ((1.09f64).sqrt() * wall, (1.04f64).sqrt() * wall);
        let area = |z: f64| 4.0 * (15.0 - 0.3 * z - x) * (10.0 - 0.2 * z - y);
        let (low, high) = (wall, 20.0 - wall);
        let inner = (high - low) / 6.0 * (area(low) + 4.0 * area(f64::midpoint(low, high)) + area(high));
        let volume = table::with(hollow, |h| h.body.volume().expect("a volume")).expect("held");
        assert!(
            (volume - (7840.0 - inner)).abs() <= 1e-6 * 7840.0,
            "a {wall} mm wall: {volume} mm3 against {}",
            7840.0 - inner
        );
        table::free(hollow);
    }
    table::free(body);
}

/// How long a host lets a modeling call run before it stops it, in seconds: the model class's limit
/// (`GEOM_CALL_LIMIT_MS.model` in packages/contracts/src/geom-limits.ts).
const MODEL_LIMIT_S: u64 = 180;

/// The angles a taper's sides lean by in the test below, in degrees.
const ANGLES: [f64; 7] = [0.0, 5.0, 11.3, 15.0, 20.0, 30.0, 45.0];

/// A body 20 mm tall: a taper (a straight loft from a 24 by 16 mm top down to a base grown by `angle` on each side, its
/// sides flat) or a cone (a 12 mm top radius, its side leaning out by `angle`), with its top pushed 5 mm up when
/// `pushed`, as a person's push and pull does. Held.
fn timed_body(shape: &str, angle: f64, pushed: bool) -> u32 {
    let grow = 20.0 * angle.to_radians().m_tan();
    let body = if shape == "taper" {
        let rect = |hw: f64, hh: f64| json!({ "points": [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] });
        let lofted = op(
            "sketch.loft",
            &json!({
                "profiles": [level(0.0, &rect(12.0 + grow, 8.0 + grow)), level(20.0, &rect(12.0, 8.0))],
                "operation": "new", "exact": true, "keySalt": 7
            }),
        );
        number(&lofted["body"])
    } else {
        // at no angle the cone is a cylinder
        let round = if angle.abs() < 1e-9 {
            Body::cylinder([0.0; 3], 12.0, 20.0)
        } else {
            Body::cone([0.0; 3], 12.0 + grow, 12.0, 20.0)
        };
        table::hold(round.expect("a cone"), Vec::new()).expect("held")
    };
    if !pushed {
        return body;
    }
    let up = op(
        "brep.push",
        &json!({ "body": body, "at": [0, 0, 20], "normal": [0, 0, 1], "distanceMm": 5 }),
    );
    table::free(body);
    number(&up["body"])
}

/// One body of the test below shelled closed, named by `SX_TIMED_SHELL` ("shape angle wall pushed|plain"): run by that
/// test in a process of its own, it prints how the shell answered and how long it took.
#[test]
fn timed_shell_case() {
    let Ok(case) = std::env::var("SX_TIMED_SHELL") else {
        return;
    };
    let [shape, angle, wall, how] = case.split(' ').collect::<Vec<_>>()[..] else {
        panic!("a case: {case}");
    };
    let (angle, wall): (f64, f64) = (angle.parse().expect("an angle"), wall.parse().expect("a wall"));
    let body = timed_body(shape, angle, how == "pushed");
    let start = std::time::Instant::now();
    let reply = sx_geom::json::call(
        "brep.shell",
        &json!({ "body": body, "wallMm": wall, "keySalt": 8 }).to_string(),
    );
    let ms = start.elapsed().as_secs_f64() * 1e3;
    match reply {
        Ok(text) => {
            let made: Value = serde_json::from_str(&text).expect("a JSON reply");
            println!("CASE held {ms:.0} ms");
            table::free(number(&made["body"]));
        }
        Err(e) => println!("CASE refused {ms:.0} ms: {e}"),
    }
    table::free(body);
}

/// A straight-lofted taper at each angle of the table and each wall, a taper at 11.3 and 30 degrees with its top
/// pushed, and a pushed cone, each shelled closed in a process of its own: each answers within the model class's time
/// limit, held exact (the engine's own read-back passed) or refused in the step's words, and never runs on unanswered.
/// The kernel's tessellator never finished a pushed taper's mesh when asked for a largest edge, so a shell's read-back
/// asks for none.
#[test]
fn closed_shells_of_tapers_and_pushed_bodies_answer_within_the_time_limit() {
    if !sx_brep::KERNEL {
        return;
    }
    let mut cases: Vec<String> = ["taper 11.3 2 pushed", "taper 30 2 pushed", "cone 11.3 2 pushed"]
        .map(str::to_owned)
        .to_vec();
    for angle in ANGLES {
        for wall in [1, 2, 3] {
            cases.push(format!("taper {angle} {wall} plain"));
        }
    }
    let mut wrong = Vec::new();
    for run in in_their_own_processes("timed_shell_case", "SX_TIMED_SHELL", &cases) {
        let wall = run.case.split(' ').nth(2).unwrap_or("");
        let words = format!("shell: a {wall} mm wall could not be made exact on this body");
        let answered = !run.stopped
            && run.ok
            && (run.line.starts_with("CASE held")
                || run.line.starts_with("CASE refused") && run.line.contains(&words));
        if !answered {
            let why = if run.stopped {
                "no answer within the limit".to_owned()
            } else {
                run.line
            };
            wrong.push(format!("{}: {why}", run.case));
        }
    }
    assert!(
        wrong.is_empty(),
        "closed shells that did not answer held or refused:\n{}",
        wrong.join("\n")
    );
}

/// How one case run by [`in_their_own_processes`] ended: stopped at the limit, or ended with or without success, and
/// the line it printed that starts with `CASE`.
struct CaseRun {
    case: String,
    stopped: bool,
    ok: bool,
    line: String,
}

/// Each of `cases` run by this test binary's test `test` in a process of its own, named by the variable `var`, four at
/// a time, each stopped at the model class's time limit, so a kernel call that never answers or ends its process
/// fails only its case. Each case's line and time go to the log as they end.
fn in_their_own_processes(test: &str, var: &str, cases: &[String]) -> Vec<CaseRun> {
    let me = std::env::current_exe().expect("this test binary");
    let next = std::sync::atomic::AtomicUsize::new(0);
    let runs = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..4 {
            s.spawn(|| {
                while let Some(case) = cases.get(next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)) {
                    let mut child = std::process::Command::new(&me)
                        .args([test, "--exact", "--nocapture", "--test-threads=1"])
                        .env(var, case)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                        .expect("the case runs");
                    let start = std::time::Instant::now();
                    while child.try_wait().expect("the case").is_none()
                        && start.elapsed().as_secs() < MODEL_LIMIT_S
                    {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    let stopped = child.try_wait().expect("the case").is_none();
                    if stopped {
                        child.kill().ok();
                    }
                    let run = child.wait_with_output().expect("the case ends");
                    let out = String::from_utf8_lossy(&run.stdout);
                    // the harness's own words may come first on the case's line
                    let line = out
                        .lines()
                        .find_map(|l| l.split_once("CASE ").map(|(_, rest)| format!("CASE {rest}")))
                        .unwrap_or_default();
                    eprintln!("{case}: {line} ({:.1} s)", start.elapsed().as_secs_f64());
                    runs.lock().expect("the list").push(CaseRun {
                        case: case.clone(),
                        stopped,
                        ok: run.status.success(),
                        line,
                    });
                }
            });
        }
    });
    runs.into_inner().expect("the list")
}

/// The farthest any point of `shelled`'s faces is from where it belongs, read apart from the engine's own read-back
/// with every vertex of a fine mesh, its edges included so a narrow face at the rim is read too, at most 1500 of them a
/// face: on `from`'s surface for the rim the opening leaves (a face mostly on the open face through `open`) and for a
/// face mostly within half the wall of the faces kept, and `wall` from the faces kept for every other face.
fn worst_off(from: &Body, open: [f64; 3], shelled: &Body, wall: f64) -> f64 {
    let faces = from.faces().expect("faces");
    let (opened, kept): (Vec<_>, Vec<_>) = faces
        .iter()
        .partition(|f| f.distance_to(open).expect("a distance") <= 1e-6);
    let nearest = |of: &[&sx_brep::Face<'_>], p: [f64; 3]| {
        of.iter()
            .map(|f| f.distance_to(p).expect("a distance"))
            .fold(f64::INFINITY, f64::min)
    };
    let m = shelled
        .tessellate(&Tessellation {
            chord_mm: 0.002,
            ..Tessellation::default()
        })
        .expect("a mesh");
    // and the middle of each triangle on the face itself, so a face meshed only along its edges is read inside too
    let made = shelled.faces().expect("faces");
    let mut per: Vec<Vec<[f64; 3]>> = vec![Vec::new(); m.surfaces.len()];
    let mut seen = HashSet::new();
    for ((t, &f), uv) in m.triangles.iter().zip(&m.faces).zip(&m.uvs) {
        for &v in t {
            if seen.insert((f, v)) {
                per[f as usize].push(m.positions[v as usize]);
            }
        }
        if let Some([a, b, c]) = uv {
            let middle = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0];
            per[f as usize].push(made[f as usize].point_at(middle).expect("a point"));
        }
    }
    let mut worst = 0.0f64;
    for points in per {
        let points: Vec<[f64; 3]> = points
            .iter()
            .step_by(points.len().div_ceil(1500).max(1))
            .copied()
            .collect();
        let to_kept: Vec<f64> = points.iter().map(|&p| nearest(&kept, p)).collect();
        let on_open = points.iter().filter(|&&p| nearest(&opened, p) < WALL_MM).count();
        let near = to_kept.iter().filter(|&&d| d < wall / 2.0).count();
        if 2 * on_open > points.len() || 2 * near > points.len() {
            worst = points
                .iter()
                .fold(worst, |w, &p| w.max(from.distance_to(p).expect("a distance")));
        } else {
            worst = to_kept.iter().fold(worst, |w, &d| w.max((d - wall).abs()));
        }
    }
    worst
}

/// One case of the open-face table below, named by `SX_SHELL_CASE` ("shape angle wall end"): run by that test in a
/// process of its own, it prints one line, the exact shell's outcome and time, the farthest its wall strays read apart
/// from the engine, its volume, and the mesh shell's time on the same body.
#[test]
fn open_shell_case() {
    let Ok(case) = std::env::var("SX_SHELL_CASE") else {
        return;
    };
    let [shape, angle, wall, end] = case.split(' ').collect::<Vec<_>>()[..] else {
        panic!("a case: {case}");
    };
    let (angle, wall): (f64, f64) = (angle.parse().expect("an angle"), wall.parse().expect("a wall"));
    let body = timed_body(shape, angle, false);
    let (at, normal) = if end == "top" {
        ([0.0, 0.0, 20.0], [0, 0, 1])
    } else {
        ([0.0, 0.0, 0.0], [0, 0, -1])
    };
    let open = json!([{ "at": at, "normal": normal }]);
    let start = std::time::Instant::now();
    let reply = sx_geom::json::call(
        "brep.shell",
        &json!({ "body": body, "open": open, "wallMm": wall, "keySalt": 8 }).to_string(),
    );
    let ms = start.elapsed().as_secs_f64() * 1e3;
    let tess = op("brep.tessellate", &json!({ "body": body }));
    let mesh = json!({ "positions": tess["positions"], "indices": tess["indices"] });
    let start = std::time::Instant::now();
    let on_mesh = sx_geom::json::call(
        "shell",
        &json!({ "mesh": mesh, "open": open, "wallMm": wall }).to_string(),
    );
    let mesh_ms = start.elapsed().as_secs_f64() * 1e3;
    let mesh_ms = if on_mesh.is_ok() {
        format!("{mesh_ms:.0}")
    } else {
        "refused".to_owned()
    };
    match reply {
        Ok(text) => {
            let made: Value = serde_json::from_str(&text).expect("a JSON reply");
            let hollow = number(&made["body"]);
            let (off, volume) = table::with(body, |from| {
                table::with(hollow, |to| {
                    (
                        worst_off(&from.body, at, &to.body, wall),
                        to.body.volume().expect("a volume"),
                    )
                })
            })
            .flatten()
            .expect("both held");
            println!("CASE exact ms {ms:.0} mesh {mesh_ms} off {off:.3e} volume {volume:.3}");
            table::free(hollow);
        }
        Err(e) => println!("CASE refused ms {ms:.0} mesh {mesh_ms} | {e}"),
    }
    table::free(body);
}

/// The cases of the open-face table the exact shell does not make, which run on the mesh: shape, angle, wall, end.
const ON_THE_MESH: &[(&str, f64, f64, &str)] = &[];

/// Tapers and cones at each angle of the table, each wall and either end open, each in a process of its own: each is
/// exact with its wall within 0.01 mm everywhere, its rim included, read apart from the engine, or it is refused in the
/// step's words, so a replay runs it on the mesh, and only the cases listed are refused.
#[test]
fn open_shells_on_tapers_and_cones_hold_their_wall_or_run_on_the_mesh() {
    if !sx_brep::KERNEL {
        return;
    }
    let mut cases = Vec::new();
    for shape in ["taper", "cone"] {
        for angle in ANGLES {
            for wall in [1, 2, 3] {
                for end in ["top", "bottom"] {
                    cases.push(format!("{shape} {angle} {wall} {end}"));
                }
            }
        }
    }
    let mut wrong = Vec::new();
    for run in in_their_own_processes("open_shell_case", "SX_SHELL_CASE", &cases) {
        let [shape, angle, wall, end] = run.case.split(' ').collect::<Vec<_>>()[..] else {
            panic!("a case: {}", run.case);
        };
        let (angle, wall): (f64, f64) = (angle.parse().expect("an angle"), wall.parse().expect("a wall"));
        let listed = ON_THE_MESH.iter().any(|&(s, a, w, e)| {
            s == shape && (a - angle).abs() < 1e-9 && (w - wall).abs() < 1e-9 && e == end
        });
        let words = format!("shell: a {wall} mm wall could not be made exact on this body");
        let fine = !run.stopped
            && run.ok
            && if listed {
                run.line.starts_with("CASE refused") && run.line.contains(&words)
            } else {
                run.line.starts_with("CASE exact")
                    && run
                        .line
                        .split(" off ")
                        .nth(1)
                        .and_then(|r| r.split(' ').next())
                        .and_then(|v| v.parse::<f64>().ok())
                        .is_some_and(|off| off <= WALL_MM)
            };
        if !fine {
            wrong.push(format!(
                "{}: {}",
                run.case,
                if run.stopped {
                    "no answer within the limit"
                } else {
                    &run.line
                }
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "open shells not held to their wall or refused:\n{}",
        wrong.join("\n")
    );
}

/// How far the engine's mesh of a body may hold another volume than the body, as a share of it: the default chord's
/// own error.
const MESH_SHARE: f64 = 1e-3;

/// The engine's mesh of `held` (`brep.tessellate`): its volume, how many shared edges both triangles run the same
/// way, and how many edges only one triangle has.
fn mesh_of(held: u32) -> (f64, usize, usize) {
    let reply = op("brep.tessellate", &json!({ "body": held }));
    let list = |key: &str| reply[key].as_array().expect("a list").clone();
    let positions: Vec<f64> = list("positions")
        .iter()
        .map(|x| x.as_f64().expect("a number"))
        .collect();
    let corners: Vec<usize> = list("indices")
        .iter()
        .map(|x| usize::try_from(x.as_u64().expect("an index")).expect("an index"))
        .collect();
    let point = |corner: usize| {
        let at = corner * 3;
        [positions[at], positions[at + 1], positions[at + 2]]
    };
    let (mut volume, mut runs) = (0.0, HashMap::<(usize, usize), Vec<bool>>::new());
    for triangle in corners.chunks(3) {
        let [a, b, c] = [point(triangle[0]), point(triangle[1]), point(triangle[2])];
        let across = [
            b[1] * c[2] - b[2] * c[1],
            b[2] * c[0] - b[0] * c[2],
            b[0] * c[1] - b[1] * c[0],
        ];
        volume += (a[0] * across[0] + a[1] * across[1] + a[2] * across[2]) / 6.0;
        for side in 0..3 {
            let (from, to) = (triangle[side], triangle[(side + 1) % 3]);
            runs.entry((from.min(to), from.max(to)))
                .or_default()
                .push(from < to);
        }
    }
    let same = runs
        .values()
        .filter(|uses| uses.len() == 2 && uses[0] == uses[1])
        .count();
    let open = runs.values().filter(|uses| uses.len() == 1).count();
    (volume, same, open)
}

/// The engine's mesh of `held` runs every shared edge both ways, has no open edge and holds the body's own volume.
fn meshes_as_the_body(held: u32, what: &str) {
    let (mesh, same, open) = mesh_of(held);
    let body = table::with(held, |h| h.body.volume().expect("a volume")).expect("held");
    assert!(
        same == 0 && open == 0 && (mesh - body).abs() <= MESH_SHARE * body,
        "{what}: mesh {mesh} mm3 against the body's {body}, {same} edges run the same way, {open} open"
    );
}

/// A 20 mm cube and a cylinder 20 mm across and 20 mm tall, shelled closed at 1 and 3 mm, then joined to a box through
/// both walls and the cavity: the cavity's faces look into a closed void, and the mesh the engine answers of each runs
/// every shared edge both ways and holds the body's volume.
#[test]
fn closed_shells_alone_and_joined_to_a_box_through_the_wall_mesh_as_the_body() {
    if !sx_brep::KERNEL {
        return;
    }
    let made = |name: &str, request: Value| number(&op(name, &request)["body"]);
    let cube = made("brep.box", json!({ "min": [0, 0, 0], "max": [20, 20, 20] }));
    let cylinder = made(
        "brep.cylinder",
        json!({ "origin": [0, 0, 0], "axis": [0, 0, 1], "diameterMm": 20, "heightMm": 20 }),
    );
    for (name, of, low, high) in [
        ("a cube", cube, [-5.0, 9.0, 5.0], [25.0, 11.0, 15.0]),
        ("a cylinder", cylinder, [-15.0, -1.0, 5.0], [15.0, 1.0, 15.0]),
    ] {
        for wall in [1.0, 3.0] {
            let hollow = closed_and_held(of, wall);
            meshes_as_the_body(hollow, &format!("{name} shelled to {wall} mm"));
            let bar = made("brep.box", json!({ "min": low, "max": high }));
            let through = made("brep.boolean", json!({ "a": hollow, "b": bar, "op": "union" }));
            meshes_as_the_body(
                through,
                &format!("{name} shelled to {wall} mm with a box through its wall"),
            );
            for n in [hollow, bar, through] {
                table::free(n);
            }
        }
        table::free(of);
    }
}
