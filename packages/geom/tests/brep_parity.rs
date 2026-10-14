// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The exact solid ops (brep.*) against the values the math gives: a closed solid, its volume and its bounds. The mesh
// path runs the same case on the tessellated inputs and must agree, exactly where its faces are flat and within its
// arc tolerance where they are round; a case without a mesh answer fails. Every brep call goes through JSON with its
// bodies carried as text, the way the CLI runs them, one process per call. Skipped in a build without the kernel, and
// empty without the brep feature, so a plain `cargo test` passes over it.
#![cfg(feature = "brep")]
use serde_json::{Value, json};
use std::f64::consts::PI;
use std::io::Write;
use std::process::{Command, Stdio};
use sx_geom::fm::Fm;

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

/// Within `tol` of `want`, relative to the larger of the two (and of the part's size, for a bound); exact at 0.
fn within(got: f64, want: f64, tol: f64, size: f64) -> bool {
    if tol == 0.0 {
        near(got, want)
    } else {
        (got - want).abs() <= tol * want.abs().max(size)
    }
}

/// The brep answer must be exact (within `brep_tol` for a round the kernel makes as a spline), and the mesh answer
/// must be there and agree with it: exactly for flat faces (`mesh_tol` 0), within its arc tolerance for round ones.
#[allow(clippy::too_many_arguments)]
fn check(
    name: &str,
    brep: &Solid,
    brep_tol: f64,
    mesh: &Solid,
    mesh_tol: f64,
    volume: f64,
    min: [f64; 3],
    max: [f64; 3],
) {
    let size = (0..3).map(|k| max[k] - min[k]).fold(0.0, f64::max);
    let fits = |s: &Solid, tol: f64| {
        within(s.volume, volume, tol, 0.0)
            && (0..3).all(|k| within(s.min[k], min[k], tol, size) && within(s.max[k], max[k], tol, size))
    };
    assert!(
        fits(brep, brep_tol),
        "{name}: brep gave {} in {:?}..{:?}, exact {volume} in {min:?}..{max:?}",
        brep.volume,
        brep.min,
        brep.max
    );
    assert!(
        fits(mesh, mesh_tol),
        "{name}: mesh gave {} in {:?}..{:?}, brep {} in {:?}..{:?}",
        mesh.volume,
        mesh.min,
        mesh.max,
        brep.volume,
        brep.min,
        brep.max
    );
    eprintln!(
        "parity compared {name}: mesh off by {:.2e} of the volume",
        (mesh.volume - brep.volume).abs() / volume
    );
}

/// How far a mesh with round faces may be from the exact solid: its circles are polygons within the engine's arc
/// tolerance, under a thousandth of the volume at these sizes.
const ARC_TOL: f64 = 2e-3;
/// geom.build's cylinders are 32 sided, about 0.6 percent under the round one.
const BUILD_TOL: f64 = 1e-2;

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
    // flat faces tessellate exactly, so the mesh path is right too
    check(
        "box",
        &brep_solid(&c),
        0.0,
        &m,
        0.0,
        6000.0,
        [1.0, 2.0, 3.0],
        [11.0, 22.0, 33.0],
    );
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
        0.0,
        &mesh_solid(&m["mesh"]),
        0.0,
        want,
        [0.0; 3],
        [20.0; 3],
    );
    // a through hole, flush with both faces: exact on the brep side; the mesh's circle is a polygon
    let hole = json!([{ "type": "cylinder", "origin": [10, 10, 0], "axis": [0, 0, 1], "diameterMm": 8, "heightMm": 20 }]);
    let h = made("subtract", json!({ "body": c, "solids": hole }));
    let hm = call("subtract", &json!({ "mesh": mesh(&c), "solids": hole }));
    check(
        "hole",
        &brep_solid(&h),
        0.0,
        &mesh_solid(&hm["mesh"]),
        ARC_TOL,
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
            0.0,
            &mesh_solid(&m["mesh"]),
            0.0,
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
            0.0,
            &mesh_solid(&m[side]),
            0.0,
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
fn intersection_with_two_parts() {
    if !sx_brep::KERNEL {
        return;
    }
    // what all three share, as the mesh boolean folds them
    let body = cube();
    let right = made("box", json!({ "min": [10, 0, 0], "max": [30, 20, 20] }));
    let back = made("box", json!({ "min": [0, 15, 0], "max": [20, 35, 20] }));
    let first = made("boolean", json!({ "op": "intersection", "a": body, "b": right }));
    let brep = made("boolean", json!({ "op": "intersection", "a": first, "b": back }));
    let on_mesh = call(
        "boolean",
        &json!({ "op": "intersection", "a": [mesh(&body)], "b": [mesh(&right), mesh(&back)] }),
    );
    let m = mesh_solid(&on_mesh["mesh"]);
    assert!(near(m.volume, 1000.0), "mesh {}", m.volume);
    check(
        "intersection",
        &brep_solid(&brep),
        0.0,
        &m,
        0.0,
        1000.0,
        [10.0, 15.0, 0.0],
        [20.0; 3],
    );
}

#[test]
fn sketch_and_slot_extrudes() {
    if !sx_brep::KERNEL {
        return;
    }
    let frame = json!({ "origin": [0, 0, 0], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] });
    // a clockwise D with a round hole, the arc through a point; the kernel takes the engine's exact curves
    let loops = json!([
        { "start": [0, 0], "segments": [
            { "type": "line", "to": [0, 20] },
            { "type": "line", "to": [10, 20] },
            { "type": "arc", "to": [10, 0], "through": [20, 10] },
            { "type": "line", "to": [0, 0] }
        ] },
        { "type": "circle", "center": [8, 10], "diameterMm": 8 }
    ]);
    let profiles = call("sketch.curves", &json!({ "loops": loops }));
    let sketch = made(
        "extrude",
        json!({ "frame": frame, "polygons": profiles, "fromMm": 0, "toMm": 5 }),
    );
    let on_mesh = call(
        "shape.extrude",
        &json!({ "frame": frame, "shape": { "type": "sketch", "loops": loops }, "placement": {}, "spec": { "distanceMm": 5 } }),
    );
    let slot = made(
        "extrude",
        json!({ "frame": frame, "polygons": [{ "outer": { "start": [-10, -5], "segments": [
            { "to": [10, -5] }, { "to": [10, 5], "center": [10, 0], "sweepDeg": 180 },
            { "to": [-10, 5] }, { "to": [-10, -5], "center": [-10, 0], "sweepDeg": 180 }
        ] } }], "fromMm": 0, "toMm": 4 }),
    );
    let slot_mesh = call(
        "shape.extrude",
        &json!({ "frame": frame, "shape": { "type": "slot", "lengthMm": 30, "widthMm": 10 }, "placement": {}, "spec": { "distanceMm": 4 } }),
    );
    // the brep is exact; the mesh's arcs are polygons within the engine's arc tolerance
    for (name, brep, mesh, want, min, max) in [
        (
            "sketch",
            &sketch,
            &on_mesh,
            (200.0 + PI * 50.0 - PI * 16.0) * 5.0,
            [0.0; 3],
            [20.0, 20.0, 5.0],
        ),
        (
            "slot",
            &slot,
            &slot_mesh,
            (200.0 + PI * 25.0) * 4.0,
            [-15.0, -5.0, 0.0],
            [15.0, 5.0, 4.0],
        ),
    ] {
        check(
            name,
            &brep_solid(brep),
            0.0,
            &mesh_solid(&mesh["mesh"]),
            ARC_TOL,
            want,
            min,
            max,
        );
    }
}

#[test]
fn extrude_into_the_top() {
    if !sx_brep::KERNEL {
        return;
    }
    let body = cube();
    let face = json!({ "origin": [10, 10, 20], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] });
    // a 6 x 4 pocket 5 deep and a boss of the same, on the cube's top
    for (op, want, top) in [("cut", 8000.0 - 120.0, 20.0), ("join", 8000.0 + 120.0, 25.0)] {
        let (from, to) = if op == "cut" { (-5, 0) } else { (0, 5) };
        let brep = made(
            "extrude",
            json!({ "frame": face, "polygons": [{ "outer": { "points": [[-3, -2], [3, -2], [3, 2], [-3, 2]] } }], "fromMm": from, "toMm": to, "target": body, "operation": op }),
        );
        let on_mesh = call(
            "shape.extrude",
            &json!({ "frame": face, "shape": { "type": "rectangle", "widthMm": 6, "heightMm": 4 }, "placement": {}, "spec": { "distanceMm": 5, "operation": op }, "target": mesh(&body) }),
        );
        check(
            op,
            &brep_solid(&brep),
            0.0,
            &mesh_solid(&on_mesh["mesh"]),
            0.0,
            want,
            [0.0; 3],
            [20.0, 20.0, top],
        );
    }
}

/// The volume of a rectangle's taper, `w` by `h`, `d` long, each side moving in by `t` per mm (out when negative).
fn tapered_box(w: f64, h: f64, d: f64, t: f64) -> f64 {
    w * h * d - (w + h) * t * d * d + 4.0 / 3.0 * t * t * d * d * d
}

/// A cone's frustum from radius `r0` to `r1`, `d` long.
fn frustum(r0: f64, r1: f64, d: f64) -> f64 {
    PI * d / 3.0 * (r0 * r0 + r0 * r1 + r1 * r1)
}

#[test]
fn tapered_extrudes() {
    if !sx_brep::KERNEL {
        return;
    }
    let frame = json!({ "origin": [0, 0, 0], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] });
    let t = 10f64.to_radians().m_tan();
    let rect = json!([{ "outer": { "points": [[-10, -5], [10, -5], [10, 5], [-10, 5]] } }]);
    let rect_shape = json!({ "type": "rectangle", "widthMm": 20, "heightMm": 10 });
    // a square with a round hole, from a sketch; the hole widens as the square narrows
    let loops = json!([
        { "start": [-10, -10], "segments": [
            { "type": "line", "to": [10, -10] },
            { "type": "line", "to": [10, 10] },
            { "type": "line", "to": [-10, 10] },
            { "type": "line", "to": [-10, -10] }
        ] },
        { "type": "circle", "center": [0, 0], "diameterMm": 6 }
    ]);
    let profiles = call("sketch.curves", &json!({ "loops": loops }));
    let circle = json!([{ "outer": { "center": [0, 0], "diameterMm": 20 } }]);
    let circle_shape = json!({ "type": "circle", "diameterMm": 20 });
    let (r2, w2) = (10.0 - 5.0 * t, 5.0 * t);
    for (name, polygons, shape, spec, from, to, mesh_tol, want, min, max) in [
        (
            "taper in",
            &rect,
            &rect_shape,
            json!({ "distanceMm": 5, "taperDeg": 10 }),
            0,
            5,
            0.0,
            tapered_box(20.0, 10.0, 5.0, t),
            [-10.0, -5.0, 0.0],
            [10.0, 5.0, 5.0],
        ),
        (
            "taper out",
            &rect,
            &rect_shape,
            json!({ "distanceMm": 5, "taperDeg": -10 }),
            0,
            5,
            0.0,
            tapered_box(20.0, 10.0, 5.0, -t),
            [-10.0 - w2, -5.0 - w2, 0.0],
            [10.0 + w2, 5.0 + w2, 5.0],
        ),
        (
            "taper both sides",
            &circle,
            &circle_shape,
            json!({ "distanceMm": 5, "extent": "symmetric", "taperDeg": 10 }),
            -5,
            5,
            ARC_TOL,
            2.0 * frustum(10.0, r2, 5.0),
            [-10.0, -10.0, -5.0],
            [10.0, 10.0, 5.0],
        ),
        (
            "taper with a hole",
            &profiles,
            &json!({ "type": "sketch", "loops": loops }),
            json!({ "distanceMm": 5, "taperDeg": 10 }),
            0,
            5,
            ARC_TOL,
            tapered_box(20.0, 20.0, 5.0, t) - frustum(3.0, 3.0 + w2, 5.0),
            [-10.0, -10.0, 0.0],
            [10.0, 10.0, 5.0],
        ),
    ] {
        let brep = made(
            "extrude",
            json!({ "frame": frame, "polygons": polygons, "fromMm": from, "toMm": to, "taperDeg": spec["taperDeg"] }),
        );
        let on_mesh = call(
            "shape.extrude",
            &json!({ "frame": frame, "shape": shape, "placement": {}, "spec": spec }),
        );
        check(
            name,
            &brep_solid(&brep),
            0.0,
            &mesh_solid(&on_mesh["mesh"]),
            mesh_tol,
            want,
            min,
            max,
        );
    }
}

#[test]
fn tapered_pocket_and_closing() {
    if !sx_brep::KERNEL {
        return;
    }
    let frame = json!({ "origin": [0, 0, 0], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] });
    let t = 10f64.to_radians().m_tan();
    let rect = json!([{ "outer": { "points": [[-10, -5], [10, -5], [10, 5], [-10, 5]] } }]);
    let rect_shape = json!({ "type": "rectangle", "widthMm": 20, "heightMm": 10 });
    // a pocket that narrows as it goes down into the cube's top
    let body = cube();
    let face = json!({ "origin": [10, 10, 20], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] });
    let brep = made(
        "extrude",
        json!({ "frame": face, "polygons": [{ "outer": { "points": [[-3, -2], [3, -2], [3, 2], [-3, 2]] } }], "fromMm": -5, "toMm": 0, "taperDeg": 10, "target": body, "operation": "cut" }),
    );
    let on_mesh = call(
        "shape.extrude",
        &json!({ "frame": face, "shape": { "type": "rectangle", "widthMm": 6, "heightMm": 4 }, "placement": {}, "spec": { "distanceMm": 5, "operation": "cut", "taperDeg": 10 }, "target": mesh(&body) }),
    );
    check(
        "tapered pocket",
        &brep_solid(&brep),
        0.0,
        &mesh_solid(&on_mesh["mesh"]),
        0.0,
        8000.0 - tapered_box(6.0, 4.0, 5.0, t),
        [0.0; 3],
        [20.0, 20.0, 20.0],
    );
    // a taper that closes the shape before the full distance is refused on both paths, for the same field
    let closing = sx_geom::json::call(
        "brep.extrude",
        &json!({ "frame": frame, "polygons": rect, "fromMm": 0, "toMm": 100, "taperDeg": 10 }).to_string(),
    )
    .unwrap_err()
    .to_string();
    let on_mesh = sx_geom::json::call(
        "shape.extrude",
        &json!({ "frame": frame, "shape": rect_shape, "placement": {}, "spec": { "distanceMm": 100, "taperDeg": 10 } }).to_string(),
    )
    .unwrap_err()
    .to_string();
    assert!(
        closing.contains("taperDeg") && on_mesh.contains("taperDeg"),
        "{closing} / {on_mesh}"
    );
}

#[test]
fn fillet_an_edge() {
    if !sx_brep::KERNEL {
        return;
    }
    let c = cube();
    let edges = json!([{ "a": [20, 20, 0], "b": [20, 20, 20], "face": [1, 0, 0] }]);
    let b = made("fillet", json!({ "body": c, "edges": edges, "radiusMm": 3 }));
    let want = 8000.0 - (1.0 - PI / 4.0) * 9.0 * 20.0;
    // the round may be a spline, so both answers are near the exact one; the mesh's round is a polygon
    let m = call(
        "edge.fillet",
        &json!({ "mesh": mesh(&c), "edges": edges, "radiusMm": 3 }),
    );
    check(
        "fillet",
        &brep_solid(&b),
        1e-4,
        &mesh_solid(&m["mesh"]),
        1e-2,
        want,
        [0.0; 3],
        [20.0; 3],
    );
}

#[test]
fn chamfer_an_edge() {
    if !sx_brep::KERNEL {
        return;
    }
    let c = cube();
    let edges = json!([{ "a": [20, 20, 0], "b": [20, 20, 20], "face": [1, 0, 0] }]);
    let b = made("chamfer", json!({ "body": c, "edges": edges, "distanceMm": 2 }));
    let m = call(
        "edge.chamfer",
        &json!({ "mesh": mesh(&c), "edges": edges, "distanceMm": 2 }),
    );
    check(
        "chamfer",
        &brep_solid(&b),
        0.0,
        &mesh_solid(&m["mesh"]),
        0.0,
        8000.0 - 40.0,
        [0.0; 3],
        [20.0; 3],
    );
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
    let on_mesh = call(
        "shape.extrude",
        &json!({
            "frame": { "origin": [0, 0, 0], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] },
            "shape": { "type": "sketch", "loops": [
                { "start": [0, 0], "segments": [{ "type": "line", "to": [30, 0] }, { "type": "line", "to": [30, 20] }, { "type": "line", "to": [0, 20] }, { "type": "line", "to": [0, 0] }] },
                { "type": "circle", "center": [15, 10], "diameterMm": 6 }
            ] },
            "placement": {}, "spec": { "distanceMm": 4 }
        }),
    );
    check(
        "extrude",
        &brep_solid(&b),
        0.0,
        &mesh_solid(&on_mesh["mesh"]),
        ARC_TOL,
        (600.0 - 9.0 * PI) * 4.0,
        [0.0; 3],
        [30.0, 20.0, 4.0],
    );
}

/// Add shape parts against the solids geom.build meshes; the app's own meshes are checked in brep-module.test.ts.
#[test]
fn add_shapes_against_built_meshes() {
    if !sx_brep::KERNEL {
        return;
    }
    let block = made(
        "primitive",
        json!({ "type": "box", "sizeMm": [20, 10, 5], "frame": { "origin": [10, 10, 0], "u": [1, 0, 0], "normal": [0, 0, 1] } }),
    );
    let built = call(
        "build",
        &json!({ "solids": [{ "type": "box", "min": [0, 5, 0], "max": [20, 15, 5] }] }),
    );
    check(
        "add box",
        &brep_solid(&block),
        0.0,
        &mesh_solid(&built["mesh"]),
        0.0,
        1000.0,
        [0.0, 5.0, 0.0],
        [20.0, 15.0, 5.0],
    );
    let peg = made(
        "primitive",
        json!({ "type": "cylinder", "diameterMm": 8, "heightMm": 12, "frame": { "origin": [0, 0, 0], "u": [0, 1, 0], "normal": [1, 0, 0] } }),
    );
    let built = call(
        "build",
        &json!({ "solids": [{ "type": "cylinder", "origin": [0, 0, 0], "axis": [1, 0, 0], "diameterMm": 8, "heightMm": 12 }] }),
    );
    check(
        "add cylinder",
        &brep_solid(&peg),
        0.0,
        &mesh_solid(&built["mesh"]),
        BUILD_TOL,
        PI * 16.0 * 12.0,
        [0.0, -4.0, -4.0],
        [12.0, 4.0, 4.0],
    );
}

/// The round sides of a slot read as on the mesh: each is a cylinder, Measure gives its radius, and a pick for a
/// sketch face refuses it instead of taking one of its facets as a flat face.
#[test]
fn round_sides_read_as_cylinders() {
    if !sx_brep::KERNEL {
        return;
    }
    let frame = json!({ "origin": [0, 0, 0], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] });
    let slot = made(
        "extrude",
        json!({ "frame": frame, "polygons": [{ "outer": { "start": [-10, -5], "segments": [
            { "to": [10, -5] }, { "to": [10, 5], "center": [10, 0], "sweepDeg": 180 },
            { "to": [-10, 5] }, { "to": [-10, -5], "center": [-10, 0], "sweepDeg": 180 }
        ] } }], "fromMm": 0, "toMm": 4 }),
    );
    let t = call("brep.tessellate", &json!({ "body": slot }));
    let faces = t["faces"].as_array().expect("faces");
    let exact = json!({ "mesh": { "positions": t["positions"], "indices": t["indices"], "faces": {
        "ids": t["faceIds"], "table": faces.iter().map(|f| f["surface"].clone()).collect::<Vec<_>>() } } });
    let on_mesh = call(
        "shape.extrude",
        &json!({ "frame": frame, "shape": { "type": "slot", "lengthMm": 30, "widthMm": 10 }, "placement": {}, "spec": { "distanceMm": 4 } }),
    );
    let flat = json!({ "mesh": on_mesh["mesh"] });
    // the side at +x, where the round end is
    let end = |m: &Value| {
        let m = &m["mesh"];
        let (p, ix) = (
            m["positions"].as_array().unwrap(),
            m["indices"].as_array().unwrap(),
        );
        let at = |t: usize, c: usize, k: usize| {
            p[usize::try_from(ix[t * 3 + c].as_u64().unwrap()).unwrap() * 3 + k]
                .as_f64()
                .unwrap()
        };
        let t = (0..ix.len() / 3)
            .find(|&t| {
                (0..3).all(|c| at(t, c, 0) > 10.5)
                    && (at(t, 0, 2) - at(t, 1, 2)).abs() + (at(t, 0, 2) - at(t, 2, 2)).abs() > 0.5
            })
            .expect("a triangle on the round end");
        (
            t,
            (0..3)
                .map(|k| (0..3).map(|c| at(t, c, k)).sum::<f64>() / 3.0)
                .collect::<Vec<_>>(),
        )
    };
    let rounds: Vec<&Value> = faces
        .iter()
        .filter(|f| f["surface"]["kind"] == "cylinder")
        .map(|f| &f["surface"])
        .collect();
    assert_eq!(rounds.len(), 2, "{faces:?}");
    for r in rounds {
        assert!(near(r["radius"].as_f64().unwrap(), 5.0), "{r}");
        assert!(near(r["axis"][2].as_f64().unwrap().abs(), 1.0), "{r}");
        assert!(
            near(r["origin"][0].as_f64().unwrap().abs(), 10.0)
                && r["origin"][1].as_f64().unwrap().abs() < 1e-9,
            "{r}"
        );
    }
    for (name, item) in [("brep", &exact), ("mesh", &flat)] {
        let (tri, at) = end(item);
        let pick = sx_geom::json::call(
            "face.pick",
            &json!({ "mesh": item, "triangle": tri, "at": at }).to_string(),
        );
        assert!(
            pick.as_ref().is_err_and(|e| e.to_string().contains("flat face")),
            "{name}: {pick:?}"
        );
        let f = call(
            "measure.feature",
            &json!({ "mesh": item, "pick": { "triangle": tri, "at": at } }),
        );
        assert_eq!(f["feature"]["kind"], "cylinder", "{name}: {f}");
        let r = f["feature"]["radius"].as_f64().unwrap();
        assert!(
            (r - 5.0).abs() < if name == "brep" { 1e-6 } else { 0.05 },
            "{name}: radius {r}"
        );
    }
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

/// A part that leaves the exact path partway through a history (a step the kernel does not have, or one it failed)
/// goes on as a mesh with the solid's faces and keys, so later steps still find their faces and edges by key.
#[test]
fn face_keys_carry_over_to_the_mesh_path() {
    if !sx_brep::KERNEL {
        return;
    }
    let body = made(
        "box",
        json!({ "min": [0, 0, 0], "max": [20, 20, 20], "keySalt": 5 }),
    );
    let tess = call("brep.tessellate", &json!({ "body": body }));
    let faces = tess["faces"].as_array().expect("faces");
    let key_facing = |axis: usize| {
        faces
            .iter()
            .find(|f| f["surface"]["kind"] == "plane" && f["surface"]["normal"][axis].as_f64() == Some(1.0))
            .and_then(|f| f["key"].as_u64())
            .expect("a keyed face")
    };
    let (top, side) = (key_facing(2), key_facing(0));
    let part = json!({
        "positions": tess["positions"],
        "indices": tess["indices"],
        "faces": {
            "ids": tess["faceIds"],
            "table": faces.iter().map(|f| f["surface"].clone()).collect::<Vec<_>>(),
            "keys": faces.iter().map(|f| f["key"].clone()).collect::<Vec<_>>(),
        },
    });
    // the next step runs on the mesh: a blind hole from below, cut by a mesh boolean
    let pin = made(
        "cylinder",
        json!({ "origin": [10, 10, -1], "axis": [0, 0, 1], "diameterMm": 6, "heightMm": 11 }),
    );
    let pin = call("brep.tessellate", &json!({ "body": pin }));
    let pin = json!({ "positions": pin["positions"], "indices": pin["indices"] });
    let holed = call(
        "boolean",
        &json!({ "op": "difference", "a": [part], "b": [pin], "withFaces": true, "keySalt": 6 }),
    );
    let mesh = holed["mesh"].clone();
    let keys: Vec<u64> = mesh["faces"]["keys"]
        .as_array()
        .expect("keys kept")
        .iter()
        .map(|k| k.as_u64().unwrap())
        .collect();
    for f in faces {
        let k = f["key"].as_u64().unwrap();
        assert!(keys.contains(&k), "the box face {k} lost its key");
    }
    // a fillet picked on the top's edge with the +x side, given where it no longer is: found by its faces' keys
    let edge = json!([{ "a": [20, 0, 25], "b": [20, 20, 25], "face": [0, 0, 1], "keys": [top, side] }]);
    let filleted = call(
        "edge.fillet",
        &json!({ "mesh": { "mesh": mesh }, "edges": edge, "radiusMm": 2 }),
    );
    assert_eq!(filleted["watertight"], true, "{}", filleted["report"]);
    let before = holed["volumeMm3"].as_f64().expect("volume before");
    let removed = before - filleted["volumeMm3"].as_f64().expect("volume");
    // a 2 mm round along 20 mm takes (4 - pi) * 20 = 17.2 mm3
    assert!((16.0..18.5).contains(&removed), "the fillet took {removed} mm3");
    // and a sketch or push on the top face finds it by key: its triangles are there, under the same key
    let ids = mesh["faces"]["ids"].as_array().unwrap();
    let on_top = ids
        .iter()
        .filter(|&id| keys[usize::try_from(id.as_u64().unwrap()).unwrap()] == top)
        .count();
    assert!(on_top >= 2, "{on_top} triangles on the top");
}

/// A triangle of `tris` under `at`, facing `facing`, as a pick on the face would give it.
fn triangle_at(tris: &Value, at: [f64; 3], facing: [f64; 3]) -> u64 {
    let pos: Vec<f64> = tris["positions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let ix: Vec<usize> = tris["indices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| usize::try_from(v.as_u64().unwrap()).unwrap())
        .collect();
    let corner = |i: usize| [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
    let sub = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let cross = |a: [f64; 3], b: [f64; 3]| {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    (0..ix.len() / 3)
        .find(|&t| {
            let [p0, p1, p2] = [corner(ix[3 * t]), corner(ix[3 * t + 1]), corner(ix[3 * t + 2])];
            let nn = cross(sub(p1, p0), sub(p2, p0));
            let len = dot(nn, nn).sqrt();
            len > 0.0
                && dot(nn, facing) / len > 0.999_999
                && (dot(sub(at, p0), nn) / len).abs() < 1e-6
                && [(p0, p1), (p1, p2), (p2, p0)]
                    .iter()
                    .all(|&(x, y)| dot(cross(sub(y, x), sub(at, x)), nn) >= 0.0)
        })
        .map(|t| t as u64)
        .expect("a triangle under the point")
}

/// A push on the kernel and the same push on the body's mesh: the new body, the kernel's reply and the mesh's.
fn push_both(body: &Value, at: [f64; 3], facing: [f64; 3], dist: f64) -> (Value, Value, Value) {
    let reply = call(
        "brep.push",
        &json!({ "body": body, "at": at, "normal": facing, "distanceMm": dist, "save": true }),
    );
    let after = json!({ "smb": reply["bodySmb"].as_str().expect("bodySmb") });
    let tris = mesh(body);
    let tri = triangle_at(&tris, at, facing);
    let on_mesh = call(
        "face.push",
        &json!({ "mesh": { "mesh": tris }, "triangle": tri, "at": at, "distanceMm": dist }),
    );
    (after, reply, on_mesh)
}

fn faces_of(body: &Value) -> u64 {
    call("brep.info", &json!({ "body": body }))["faces"]
        .as_u64()
        .expect("faces")
}

#[test]
#[allow(clippy::too_many_lines, reason = "one row per case")]
fn push_and_pull_flat_faces() {
    if !sx_brep::KERNEL {
        return;
    }
    let box20 = cube();
    let plate = made(
        "extrude",
        json!({
            "frame": { "origin": [0, 0, 0], "u": [1, 0, 0], "normal": [0, 0, 1] },
            "polygons": [{ "outer": { "points": [[0, 0], [30, 0], [30, 20], [0, 20]] }, "holes": [{ "center": [15, 10], "diameterMm": 6 }] }],
            "fromMm": 0, "toMm": 4
        }),
    );
    let peg = made(
        "primitive",
        json!({ "type": "cylinder", "diameterMm": 20, "heightMm": 10, "frame": { "origin": [0, 0, 0], "u": [1, 0, 0], "normal": [0, 0, 1] } }),
    );
    let slot = made(
        "extrude",
        json!({ "frame": { "origin": [0, 0, 0], "u": [1, 0, 0], "normal": [0, 0, 1] }, "polygons": [{ "outer": { "start": [-10, -5], "segments": [
            { "to": [10, -5] }, { "to": [10, 5], "center": [10, 0], "sweepDeg": 180 },
            { "to": [-10, 5] }, { "to": [-10, -5], "center": [-10, 0], "sweepDeg": 180 }
        ] } }], "fromMm": 0, "toMm": 4 }),
    );
    // a 10 x 10 pocket 15 deep in the cube
    let cup = made(
        "extrude",
        json!({ "frame": { "origin": [10, 10, 20], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] }, "polygons": [{ "outer": { "points": [[-5, -5], [5, -5], [5, 5], [-5, 5]] } }], "fromMm": -15, "toMm": 0, "target": box20, "operation": "cut" }),
    );
    let up = [0.0, 0.0, 1.0];
    // name, body, at, normal, distance, exact volume, bounds, mesh tolerance, faces after (0: not counted)
    let cases = [
        (
            "pull a top",
            &box20,
            [5.0, 5.0, 20.0],
            up,
            5.0,
            10_000.0,
            [0.0; 3],
            [20.0, 20.0, 25.0],
            0.0,
            6,
        ),
        (
            "push a top",
            &box20,
            [5.0, 5.0, 20.0],
            up,
            -5.0,
            6000.0,
            [0.0; 3],
            [20.0, 20.0, 15.0],
            0.0,
            6,
        ),
        (
            "pull a side",
            &box20,
            [20.0, 5.0, 5.0],
            [1.0, 0.0, 0.0],
            5.0,
            10_000.0,
            [0.0; 3],
            [25.0, 20.0, 20.0],
            0.0,
            6,
        ),
        (
            "pull a bottom",
            &box20,
            [5.0, 5.0, 0.0],
            [0.0, 0.0, -1.0],
            3.0,
            9200.0,
            [0.0, 0.0, -3.0],
            [20.0; 3],
            0.0,
            6,
        ),
        (
            "pull a top with a hole",
            &plate,
            [2.0, 2.0, 4.0],
            up,
            6.0,
            (600.0 - 9.0 * PI) * 10.0,
            [0.0; 3],
            [30.0, 20.0, 10.0],
            ARC_TOL,
            0,
        ),
        (
            "pull a round top",
            &peg,
            [3.0, 3.0, 10.0],
            up,
            5.0,
            PI * 100.0 * 15.0,
            [-10.0, -10.0, 0.0],
            [10.0, 10.0, 15.0],
            ARC_TOL,
            3,
        ),
        (
            "push a pocket wall",
            &cup,
            [15.0, 10.0, 12.0],
            [-1.0, 0.0, 0.0],
            -2.0,
            6200.0,
            [0.0; 3],
            [20.0; 3],
            0.0,
            0,
        ),
        (
            "push a slot top",
            &slot,
            [0.0, 0.0, 4.0],
            up,
            -2.0,
            (200.0 + PI * 25.0) * 2.0,
            [-15.0, -5.0, 0.0],
            [15.0, 5.0, 2.0],
            ARC_TOL,
            0,
        ),
    ];
    for (name, body, at, facing, dist, want, min, max, tol, faces) in cases {
        let (after, reply, on_mesh) = push_both(body, at, facing, dist);
        check(
            name,
            &brep_solid(&after),
            0.0,
            &mesh_solid(&on_mesh["mesh"]),
            tol,
            want,
            min,
            max,
        );
        assert_eq!(reply["reached"], true, "{name}: {reply}");
        if faces > 0 {
            assert_eq!(faces_of(&after), faces, "{name}: faces on one plane are one face");
        }
        // the face it moved, as the mesh path reports it: the same frame
        let moved = &on_mesh["moved"]["frame"];
        for k in ["origin", "normal", "u", "v"] {
            let (a, m) = (triple(&reply["frame"][k]), triple(&moved[k]));
            assert!(
                (0..3).all(|i| (a[i] - m[i]).abs() < 1e-3),
                "{name}: frame {k} {a:?} against the mesh's {m:?}"
            );
        }
    }
}

#[test]
fn push_a_floor_through_and_by_key() {
    if !sx_brep::KERNEL {
        return;
    }
    // a 10 x 10 pocket 15 deep in the cube, its floor at z 5, pushed down through the bottom
    let face = json!({ "origin": [10, 10, 20], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] });
    let cup = made(
        "extrude",
        json!({ "frame": face, "polygons": [{ "outer": { "points": [[-5, -5], [5, -5], [5, 5], [-5, 5]] } }], "fromMm": -15, "toMm": 0, "target": cube(), "operation": "cut" }),
    );
    let (b, r, on_mesh) = push_both(&cup, [10.0, 10.0, 5.0], [0.0, 0.0, 1.0], -5.0);
    check(
        "push a floor through",
        &brep_solid(&b),
        0.0,
        &mesh_solid(&on_mesh["mesh"]),
        0.0,
        6000.0,
        [0.0; 3],
        [20.0; 3],
    );
    // no face is left where it moved to
    assert_eq!(r["reached"], false, "{r}");

    // keys: the box's faces keep theirs, the moved top gets the push's own, and the key finds the face anywhere
    let body = made(
        "box",
        json!({ "min": [0, 0, 0], "max": [20, 20, 20], "keySalt": 5 }),
    );
    let keyed = |b: &Value, axis: usize, sign: f64| {
        call("brep.tessellate", &json!({ "body": b }))["faces"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| {
                f["surface"]["kind"] == "plane" && f["surface"]["normal"][axis].as_f64() == Some(sign)
            })
            .map(|f| f["key"].as_u64().unwrap())
            .collect::<Vec<_>>()
    };
    let (top, side, bottom) = (keyed(&body, 2, 1.0), keyed(&body, 0, 1.0), keyed(&body, 2, -1.0));
    // given far from where the face is, as after an earlier step changed
    let r = call(
        "brep.push",
        &json!({ "body": body, "at": [5, 5, 40], "normal": [0, 0, 1], "faceKey": top[0], "distanceMm": 5, "keySalt": 7, "save": true }),
    );
    assert_eq!(r["faceKey"].as_u64(), Some(top[0]), "{r}");
    let b = json!({ "smb": r["bodySmb"].as_str().unwrap() });
    assert!(near(brep_solid(&b).volume, 10_000.0));
    assert_eq!(keyed(&b, 2, -1.0), bottom, "the bottom keeps its key");
    assert_eq!(
        keyed(&b, 0, 1.0),
        side,
        "the side keeps its key, one face with the piece the pull added"
    );
    let new_top = keyed(&b, 2, 1.0);
    assert!(
        new_top.len() == 1 && new_top[0] != top[0] && new_top[0] != 0,
        "the moved top is the push's own: {new_top:?}"
    );

    // what the mesh path refuses, the kernel refuses
    for (req, says) in [
        (
            json!({ "at": [5, 5, 20], "normal": [0, 0, 1], "distanceMm": 0 }),
            "distanceMm",
        ),
        (
            json!({ "at": [5, 5, 20], "normal": [0, 0, 1], "distanceMm": -20 }),
            "the cut removes the whole body",
        ),
        (
            json!({ "at": [5, 5, 21], "normal": [0, 0, 1], "distanceMm": 2 }),
            "no flat face there",
        ),
    ] {
        let mut req = req;
        req["body"] = cube();
        sx_geom::json::allow_brep_text(true);
        let e = sx_geom::json::call("brep.push", &req.to_string())
            .expect_err("refused")
            .to_string();
        assert!(e.contains(says), "{e}");
    }
    let peg = made(
        "cylinder",
        json!({ "origin": [0, 0, 0], "axis": [0, 0, 1], "diameterMm": 10, "heightMm": 10 }),
    );
    let e = sx_geom::json::call(
        "brep.push",
        &json!({ "body": peg, "at": [5, 0, 5], "normal": [1, 0, 0], "distanceMm": 2 }).to_string(),
    )
    .expect_err("a round face")
    .to_string();
    assert!(e.contains("no flat face"), "{e}");
}
