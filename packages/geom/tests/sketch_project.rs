// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! edges, a face's outline and a body's outline projected into a sketch come back as lines, arcs and circles

use serde_json::{Value, json};
use std::f64::consts::PI;
use sx_geom::fm::Fm;
use sx_geom::json::call;

/// the engine's fit tolerance, mm
const TOL: f64 = 0.005;

fn run(op: &str, req: &Value) -> Value {
    serde_json::from_str(&call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}"))).unwrap()
}

fn err(op: &str, req: &Value) -> String {
    call(op, &req.to_string()).unwrap_err().to_string()
}

fn plane_at(z: f64) -> Value {
    json!({ "origin": [0, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] })
}

/// a 40 mm square plate 10 mm thick with a 10 mm hole through its middle, faces keyed
fn plate() -> Value {
    let loops = json!([
        { "start": [0, 0], "segments": [
            { "type": "line", "to": [40, 0] }, { "type": "line", "to": [40, 40] },
            { "type": "line", "to": [0, 40] }, { "type": "line", "to": [0, 0] } ] },
        { "type": "circle", "center": [20, 20], "diameterMm": 10 }
    ]);
    let out = run(
        "shape.extrude",
        &json!({ "shape": { "type": "sketch", "loops": loops }, "spec": { "distanceMm": 10 }, "withFaces": true, "keySalt": 3 }),
    );
    out["mesh"].clone()
}

/// the key of the flat face facing `normal` at height `offset` along it
fn key_of(mesh: &Value, normal: [f64; 3], offset: f64) -> u64 {
    let f = &mesh["faces"];
    let table = f["table"].as_array().unwrap();
    let i = table
        .iter()
        .position(|s| {
            let n: Vec<f64> = s["normal"]
                .as_array()
                .map(|a| a.iter().map(|x| x.as_f64().unwrap()).collect())
                .unwrap_or_default();
            s["kind"] == "plane"
                && n.len() == 3
                && (0..3).all(|k| (n[k] - normal[k]).abs() < 1e-6)
                && (s["offset"].as_f64().unwrap() - offset).abs() < 1e-6
        })
        .unwrap_or_else(|| panic!("no plane facing {normal:?} at {offset}"));
    f["keys"][i].as_u64().unwrap()
}

fn kinds(l: &Value) -> Vec<String> {
    l["segments"]
        .as_array()
        .map(|s| s.iter().map(|x| x["type"].as_str().unwrap().to_owned()).collect())
        .unwrap_or_default()
}

fn area(loops: &Value) -> f64 {
    let c = run("sketch.check", &json!({ "loops": loops }));
    assert_eq!(c["ok"], true, "{c}");
    c["areaMm2"].as_f64().unwrap()
}

#[test]
fn a_face_outline_keeps_its_hole_as_a_circle() {
    let mesh = plate();
    let key = key_of(&mesh, [0.0, 0.0, 1.0], 10.0);
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(30.0),
                 "source": { "kind": "face", "face": { "at": [2, 2, 10], "normal": [0, 0, 1], "key": key } } }),
    );
    let loops = out["loops"].as_array().unwrap();
    assert_eq!(loops.len(), 2, "{out}");
    let square = loops.iter().find(|l| l["type"] != "circle").unwrap();
    assert_eq!(kinds(square), ["line", "line", "line", "line"]);
    let hole = loops.iter().find(|l| l["type"] == "circle").unwrap();
    assert!(
        (hole["diameterMm"].as_f64().unwrap() - 10.0).abs() < 0.01,
        "{hole}"
    );
    assert!((hole["center"][0].as_f64().unwrap() - 20.0).abs() < 0.01);
    let a = area(&out["loops"]);
    assert!((a - (1600.0 - 25.0 * PI)).abs() < 0.5, "{a}");
}

#[test]
fn a_face_on_a_mesh_without_keys_is_found_by_its_point() {
    let mesh = plate();
    let bare = json!({ "positions": mesh["positions"], "indices": mesh["indices"] });
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": bare }], "frame": plane_at(0.0),
                 "source": { "kind": "face", "face": { "at": [2, 2, 10], "normal": [0, 0, 1] } } }),
    );
    assert_eq!(out["loops"].as_array().unwrap().len(), 2, "{out}");
}

#[test]
fn a_face_whose_key_is_gone_says_so() {
    let mesh = plate();
    let e = err(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(30.0),
                 "source": { "kind": "face", "face": { "at": [2, 2, 10], "normal": [0, 0, 1], "key": 987_654_321u64 } } }),
    );
    assert!(e.contains("is gone"), "{e}");
}

#[test]
fn a_face_seen_edge_on_is_refused() {
    let mesh = plate();
    let key = key_of(&mesh, [1.0, 0.0, 0.0], 40.0);
    let e = err(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(30.0),
                 "source": { "kind": "face", "face": { "at": [40, 2, 2], "normal": [1, 0, 0], "key": key } } }),
    );
    assert!(e.contains("edge on"), "{e}");
}

#[test]
fn the_edges_round_a_face_chain_into_one_closed_loop() {
    let mesh = plate();
    let top = key_of(&mesh, [0.0, 0.0, 1.0], 10.0);
    let ids = mesh["faces"]["ids"].as_array().unwrap();
    let keys = mesh["faces"]["keys"].as_array().unwrap();
    let t = ids
        .iter()
        .position(|id| keys[usize::try_from(id.as_u64().unwrap()).unwrap()].as_u64() == Some(top))
        .unwrap();
    let pick = run(
        "edge.pick",
        &json!({ "mesh": mesh, "triangle": t, "at": [20, 0.1, 10] }),
    );
    let ring: Vec<Value> = pick["loop"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["edge"].clone())
        .collect();
    let straight: Vec<Value> = ring.iter().filter(|e| e["center"].is_null()).cloned().collect();
    assert_eq!(straight.len(), 4, "{pick}");
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(50.0), "source": { "kind": "edges", "edges": straight } }),
    );
    let loops = out["loops"].as_array().unwrap();
    assert_eq!(loops.len(), 1, "{out}");
    assert_eq!(kinds(&loops[0]), ["line", "line", "line", "line"]);
    assert!((area(&out["loops"]) - 1600.0).abs() < 1e-6);
}

#[test]
fn one_edge_projects_as_one_line_and_an_upright_one_as_nothing() {
    let mesh = plate();
    let top = key_of(&mesh, [0.0, 0.0, 1.0], 10.0);
    let front = key_of(&mesh, [0.0, -1.0, 0.0], 0.0);
    let side = key_of(&mesh, [1.0, 0.0, 0.0], 40.0);
    let edge = json!({ "a": [0, 0, 10], "b": [40, 0, 10], "face": [0, 0, 1], "keys": [top, front] });
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(0.0), "source": { "kind": "edges", "edges": [edge] } }),
    );
    let l = &out["loops"][0];
    assert_eq!(kinds(l), ["line"]);
    assert_eq!(l["segments"][0]["to"], json!([40.0, 0.0]));
    let upright = json!({ "a": [40, 0, 0], "b": [40, 0, 10], "face": [0, -1, 0], "keys": [front, side] });
    let e = err(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(0.0), "source": { "kind": "edges", "edges": [upright] } }),
    );
    assert!(e.contains("end on"), "{e}");
}

#[test]
fn a_hole_rim_comes_back_as_its_circle() {
    let mesh = plate();
    let top = key_of(&mesh, [0.0, 0.0, 1.0], 10.0);
    let table = mesh["faces"]["table"].as_array().unwrap();
    let wall = table.iter().position(|s| s["kind"] == "cylinder").unwrap();
    let wall = mesh["faces"]["keys"][wall].as_u64().unwrap();
    let rim = json!({ "a": [25, 20, 10], "b": [25, 20, 10], "face": [0, 0, 1], "center": [20, 20, 10], "keys": [top, wall] });
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(5.0), "source": { "kind": "edges", "edges": [rim] } }),
    );
    let l = &out["loops"][0];
    assert_eq!(l["type"], "circle", "{out}");
    assert!((l["diameterMm"].as_f64().unwrap() - 10.0).abs() < 0.01);
}

#[test]
fn a_body_outline_from_above_keeps_the_hole_through_it() {
    let mesh = plate();
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(0.0), "source": { "kind": "silhouette" } }),
    );
    let loops = out["loops"].as_array().unwrap();
    assert_eq!(loops.len(), 2, "{out}");
    assert!(loops.iter().any(|l| l["type"] == "circle"));
    let a = area(&out["loops"]);
    assert!((a - (1600.0 - 25.0 * PI)).abs() < 0.5, "{a}");
}

#[test]
fn a_body_outline_from_the_side_is_its_profile() {
    let mesh = plate();
    let side = json!({ "origin": [100, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] });
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": side, "source": { "kind": "silhouette" } }),
    );
    let loops = out["loops"].as_array().unwrap();
    assert_eq!(loops.len(), 1, "{out}");
    assert_eq!(kinds(&loops[0]), ["line", "line", "line", "line"]);
    assert!((area(&out["loops"]) - 400.0).abs() < 1e-6);
}

#[test]
fn a_moved_body_projects_where_it_stands() {
    let mesh = plate();
    let moved = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 100.0, 50.0, 0.0, 1.0,
    ];
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh, "transform": moved }], "frame": plane_at(0.0), "source": { "kind": "silhouette" } }),
    );
    let hole = out["loops"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["type"] == "circle")
        .cloned()
        .unwrap();
    assert!(
        (hole["center"][0].as_f64().unwrap() - 120.0).abs() < 0.01,
        "{hole}"
    );
    assert!(
        (hole["center"][1].as_f64().unwrap() - 70.0).abs() < 0.01,
        "{hole}"
    );
}

/// the plate with its -x side keyed as its +x side, so the top meets that key in two places
fn plate_with_twin_sides() -> (Value, u64, u64) {
    let mut mesh = plate();
    let top = key_of(&mesh, [0.0, 0.0, 1.0], 10.0);
    let right = key_of(&mesh, [1.0, 0.0, 0.0], 40.0);
    let table = mesh["faces"]["table"].as_array().unwrap().clone();
    let left = table
        .iter()
        .position(|s| s["kind"] == "plane" && s["normal"] == json!([-1.0, 0.0, 0.0]))
        .unwrap();
    mesh["faces"]["keys"][left] = json!(right);
    (mesh, top, right)
}

fn first_point(l: &Value) -> (f64, f64) {
    (l["start"][0].as_f64().unwrap(), l["start"][1].as_f64().unwrap())
}

#[test]
fn a_face_picked_before_its_body_moved_projects_where_it_stands_now() {
    let mesh = plate();
    let top = key_of(&mesh, [0.0, 0.0, 1.0], 10.0);
    let now = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, -30.0, 10.0, 0.0, 1.0,
    ];
    // the point and normal arrive in the part's own frame; the part stands at `now`
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh, "transform": now }], "frame": plane_at(0.0),
                 "source": { "kind": "face", "face": { "at": [20, 2, 10], "normal": [0, 0, 1], "key": top } } }),
    );
    let loops = out["loops"].as_array().unwrap();
    let hole = loops.iter().find(|l| l["type"] == "circle").unwrap();
    assert!(
        (hole["center"][0].as_f64().unwrap() + 10.0).abs() < 0.01,
        "{hole}"
    );
    assert!(
        (hole["center"][1].as_f64().unwrap() - 30.0).abs() < 0.01,
        "{hole}"
    );
    let outer = loops.iter().find(|l| l["type"] != "circle").unwrap();
    let xs: Vec<f64> = std::iter::once(first_point(outer).0)
        .chain(
            outer["segments"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["to"][0].as_f64().unwrap()),
        )
        .collect();
    let lo = xs.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    assert!((lo + 30.0).abs() < 1e-6 && (hi - 10.0).abs() < 1e-6, "{outer}");
    // without the key the point still finds it, in the part's frame
    let plain = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh, "transform": now }], "frame": plane_at(0.0),
                 "source": { "kind": "face", "face": { "at": [20, 2, 10], "normal": [0, 0, 1] } } }),
    );
    assert_eq!(plain["loops"], out["loops"]);
}

#[test]
fn an_edge_picked_before_its_body_moved_projects_where_it_stands_now() {
    let mesh = plate();
    let top = key_of(&mesh, [0.0, 0.0, 1.0], 10.0);
    let front = key_of(&mesh, [0.0, -1.0, 0.0], 0.0);
    let now = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, -30.0, 10.0, 0.0, 1.0,
    ];
    let edge = json!({ "a": [0, 0, 10], "b": [40, 0, 10], "face": [0, 0, 1], "keys": [top, front] });
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh, "transform": now }], "frame": plane_at(0.0), "source": { "kind": "edges", "edges": [edge] } }),
    );
    let l = &out["loops"][0];
    assert_eq!(kinds(l), ["line"]);
    let (x0, y0) = first_point(l);
    let to = &l["segments"][0]["to"];
    let mut xs = [x0, to[0].as_f64().unwrap()];
    xs.sort_by(f64::total_cmp);
    assert!((xs[0] + 30.0).abs() < 1e-9 && (xs[1] - 10.0).abs() < 1e-9, "{l}");
    assert!(
        (y0 - 10.0).abs() < 1e-9 && (to[1].as_f64().unwrap() - 10.0).abs() < 1e-9,
        "{l}"
    );
}

#[test]
fn a_round_edge_without_keys_is_its_circle() {
    let mesh = plate();
    let rim = json!({ "a": [25, 20, 10], "b": [25, 20, 10], "face": [0, 0, 1], "center": [20, 20, 10] });
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(0.0), "source": { "kind": "edges", "edges": [rim] } }),
    );
    let l = &out["loops"][0];
    assert_eq!(l["type"], "circle", "{out}");
    assert!((l["diameterMm"].as_f64().unwrap() - 10.0).abs() < 0.01, "{l}");
}

#[test]
fn an_edge_without_keys_whose_end_left_the_mesh_is_gone() {
    let mesh = plate();
    let edge = json!({ "a": [0, 0, 10], "b": [55, 0, 10], "face": [0, 0, 1] });
    let e = err(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(0.0), "source": { "kind": "edges", "edges": [edge] } }),
    );
    assert!(e.contains("edge this projected is gone"), "{e}");
    let off = json!({ "a": [70, 0, 10], "b": [40, 0, 10], "face": [0, 0, 1] });
    let e = err(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(0.0), "source": { "kind": "edges", "edges": [off] } }),
    );
    assert!(e.contains("edge this projected is gone"), "{e}");
}

#[test]
fn keys_that_no_longer_meet_say_the_edge_is_gone() {
    let mesh = plate();
    let top = key_of(&mesh, [0.0, 0.0, 1.0], 10.0);
    let bottom = key_of(&mesh, [0.0, 0.0, -1.0], 0.0);
    let edge = json!({ "a": [0, 0, 10], "b": [40, 0, 10], "face": [0, 0, 1], "keys": [top, bottom] });
    let e = err(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(0.0), "source": { "kind": "edges", "edges": [edge] } }),
    );
    assert!(e.contains("edge this projected is gone"), "{e}");
}

#[test]
fn faces_that_meet_twice_take_the_run_the_edge_sat_on() {
    let (mesh, top, side) = plate_with_twin_sides();
    // the edge along x = 40, the second of the two places the faces meet
    let edge = json!({ "a": [40, 0, 10], "b": [40, 40, 10], "face": [0, 0, 1], "keys": [top, side] });
    let out = run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(0.0), "source": { "kind": "edges", "edges": [edge] } }),
    );
    let loops = out["loops"].as_array().unwrap();
    assert_eq!(loops.len(), 1, "{out}");
    let (x0, _) = first_point(&loops[0]);
    assert!((x0 - 40.0).abs() < 1e-9, "{out}");
    assert!(
        (loops[0]["segments"][0]["to"][0].as_f64().unwrap() - 40.0).abs() < 1e-9,
        "{out}"
    );
    // saved in neither place: it was split
    let between = json!({ "a": [20, 10, 10], "b": [20, 30, 10], "face": [0, 0, 1], "keys": [top, side] });
    let e = err(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(0.0), "source": { "kind": "edges", "edges": [between] } }),
    );
    assert!(e.contains("was split"), "{e}");
}

#[test]
fn a_face_key_found_on_two_faces_was_split() {
    let (mesh, _, side) = plate_with_twin_sides();
    let e = err(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": plane_at(100.0),
                 "source": { "kind": "face", "face": { "at": [40, 20, 5], "normal": [1, 0, 0], "key": side } } }),
    );
    assert!(e.contains("face this projected was split"), "{e}");
}

/// the plate's hole rim projected onto a plane tipped `deg` degrees about x
fn rim_at_tilt(deg: f64) -> Value {
    let mesh = plate();
    let top = key_of(&mesh, [0.0, 0.0, 1.0], 10.0);
    let table = mesh["faces"]["table"].as_array().unwrap();
    let wall = table.iter().position(|s| s["kind"] == "cylinder").unwrap();
    let wall = mesh["faces"]["keys"][wall].as_u64().unwrap();
    let rim = json!({ "a": [25, 20, 10], "b": [25, 20, 10], "face": [0, 0, 1], "center": [20, 20, 10], "keys": [top, wall] });
    let (s, c) = deg.to_radians().m_sin_cos();
    let tilted = json!({ "origin": [0, 0, 0], "normal": [0, -s, c], "u": [1, 0, 0], "v": [0, c, s] });
    run(
        "sketch.project",
        &json!({ "parts": [{ "mesh": mesh }], "frame": tilted, "source": { "kind": "edges", "edges": [rim] } }),
    )
}

#[test]
fn where_a_tilted_rim_turns_from_a_circle_to_one_spline() {
    let shape = |deg: f64| {
        let out = rim_at_tilt(deg);
        assert_eq!(out["loops"].as_array().unwrap().len(), 1, "{out}");
        let l = &out["loops"][0];
        if l["type"] == "circle" {
            vec!["circle".to_owned()]
        } else {
            kinds(l)
        }
    };
    // within the tolerance of its circle up to 2 degrees; then two arcs, each within the tolerance
    assert_eq!(shape(2.0), ["circle"]);
    assert_eq!(shape(3.0), ["arc", "arc"]);
    // one closed spline from 5 degrees to 75
    for deg in [5.0, 30.0, 45.0, 60.0, 75.0] {
        assert_eq!(shape(deg), ["spline"], "{deg}");
    }
    // nearly edge on, the ends turn too sharply for one smooth run, and how the loop splits there follows the
    // facets; what holds is that it closes on the ellipse, with no circle and the ellipse's area
    for deg in [80.0, 85.0] {
        let out = rim_at_tilt(deg);
        let loops = out["loops"].as_array().unwrap();
        assert_eq!(loops.len(), 1, "{deg}: {out}");
        let l = &loops[0];
        assert_ne!(l["type"], "circle", "{deg}: {l}");
        let segs = l["segments"].as_array().unwrap();
        assert!(!segs.is_empty(), "{deg}: {l}");
        assert_eq!(segs[segs.len() - 1]["to"], l["start"], "{deg}: {l}");
        assert!(segs.iter().all(|x| x["type"] != "circle"), "{deg}: {l}");
        // every point the loop goes through, within the tolerance of the 10 mm circle seen at the tilt
        let (s, c) = f64::to_radians(deg).m_sin_cos();
        let (o, a, b) = ([20.0, 20.0 * c + 10.0 * s], 5.0, 5.0 * c);
        let mut pts = vec![&l["start"]];
        for x in segs {
            pts.extend(x["points"].as_array().into_iter().flatten());
            pts.extend(x.get("through"));
            pts.push(&x["to"]);
        }
        for p in pts {
            let (x, y) = (p[0].as_f64().unwrap() - o[0], p[1].as_f64().unwrap() - o[1]);
            let h = (x / a).m_hypot(y / b);
            let off = (h - 1.0).abs() * h / (x / (a * a)).m_hypot(y / (b * b));
            assert!(off < TOL, "{deg}: {p} is {off} mm off");
        }
        let (got, want) = (area(&out["loops"]), PI * a * b);
        assert!((got - want).abs() < want * 0.01, "{deg}: {got} vs {want}");
    }
}

#[test]
fn a_hole_rim_seen_at_a_tilt_is_a_smooth_ellipse() {
    // tipped 60 degrees about x: the 10 mm circle is seen as an ellipse 10 by 5
    let out = rim_at_tilt(60.0);
    let loops = out["loops"].as_array().unwrap();
    assert_eq!(loops.len(), 1, "{out}");
    let l = &loops[0];
    assert_eq!(kinds(l), ["spline"], "{out}");
    // one closed spline: it ends where it starts
    let seg = &l["segments"][0];
    assert_eq!(seg["to"], l["start"]);
    // every point on the ellipse around the rim's center, half axes 5 along u and 2.5 along v
    // the rim's center seen on the tipped plane
    let o = [20.0, 20.0 * 0.5 + 10.0 * 3f64.sqrt() / 2.0];
    let mut pts = vec![&l["start"]];
    pts.extend(seg["points"].as_array().unwrap());
    assert!(pts.len() > 16, "{l}");
    for p in pts {
        let (x, y) = (
            (p[0].as_f64().unwrap() - o[0]) / 5.0,
            (p[1].as_f64().unwrap() - o[1]) / 2.5,
        );
        let off = (x.m_hypot(y) - 1.0).abs() * 5.0;
        assert!(off < TOL, "{p} is {off} mm off");
    }
    let got = area(&out["loops"]);
    let want = PI * 5.0 * 2.5;
    assert!((got - want).abs() < want * 0.01, "{got} vs {want}");
}
