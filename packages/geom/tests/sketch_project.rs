// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! edges, a face's outline and a body's outline projected into a sketch come back as lines, arcs and circles

use serde_json::{Value, json};
use std::f64::consts::PI;
use sx_geom::json::call;

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
