// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A held exact body shelled through the engine's own call (brep.shell): the faces it keeps carry their keys and the
// faces it makes get keys of the step, each of their own; the open faces are found by key or by place, and refused in
// the mesh shell's words; a box, a cylinder and a cone shelled closed keep a wall within 0.01 mm of the one asked; a
// curved lofted body open at its end is refused before the kernel is asked, since the kernel leaves such a wall open or
// fails outright, so a replay runs it on the mesh. A closed shell whose wall strays from the one asked, cannot be read,
// or whose mesh holds another volume than the body, is refused too.
// Empty without the brep feature, so a workspace test run that names every test target passes over it.
#![cfg(feature = "brep")]
use serde_json::{Value, json};
use std::collections::HashSet;
use sx_brep::{Body, Mesh, Tessellation};
use sx_geom::exact as table;

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

/// A smooth loft through a circle, an ellipse and a smaller circle: its closed shell's wall is the one asked, but its
/// mesh winds part of the cavity the wrong way, so it holds another volume than the body (1497.4 mm3 against 1670.7 at
/// a 1 mm wall). Closed or open at its end, it is refused in the step's own words and nothing is held, so a replay
/// shells it on the mesh.
#[test]
fn a_curved_lofted_body_shelled_closed_or_open_at_its_end_is_refused() {
    if !sx_brep::KERNEL {
        return;
    }
    let body = lofted(vase(), true);
    for wall in [1.0, 2.0, 3.0] {
        let held = table::count();
        let closed = refusal(
            "brep.shell",
            &json!({ "body": body, "wallMm": wall, "keySalt": 8 }),
        );
        assert_eq!(
            closed,
            format!("shell: a {wall} mm wall could not be made exact on this body")
        );
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

fn lofted(profiles: Value, smooth: bool) -> u32 {
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
        json!([
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
        json!([
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

/// A ruled loft through three rectangles, smaller as it rises: its closed shell's wall is the one asked, but its mesh
/// winds part of the cavity the wrong way and holds another volume than the body (11295.9 mm3 against 2217.2 at a 1 mm
/// wall), so it is refused in the step's own words and nothing is held.
#[test]
fn a_closed_shell_whose_mesh_holds_another_volume_than_the_body_is_refused() {
    if !sx_brep::KERNEL {
        return;
    }
    let rect = |w: f64, h: f64| {
        let (x, y) = (w / 2.0, h / 2.0);
        json!({ "points": [[-x, -y], [x, -y], [x, y], [-x, y]] })
    };
    let body = lofted(
        json!([
            level(0.0, &rect(30.0, 20.0)),
            level(10.0, &rect(24.0, 16.0)),
            level(20.0, &rect(18.0, 12.0))
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
