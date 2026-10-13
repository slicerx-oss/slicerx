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

#[test]
fn circle_polygon_and_rounded_extrudes() {
    if !sx_brep::KERNEL {
        return;
    }
    let frame = json!({ "origin": [0, 0, 0], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] });
    let top = json!({ "origin": [10, 10, 20], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1] });
    let body = cube();
    // each loop as the exact replay sends it (exact.ts loops): a hexagon on its 10 mm circle, a flat side down, and a
    // rounded rectangle as lines and quarter arcs
    let y = 2.5 * 3f64.sqrt();
    let hexagon = json!({ "points": [[-2.5, -y], [2.5, -y], [5, 0], [2.5, y], [-2.5, y], [-5, 0]] });
    let rounded = json!({ "start": [6, -2], "segments": [
        { "to": [6, 2] }, { "to": [4, 4], "center": [4, 2], "sweepDeg": 90 },
        { "to": [-4, 4] }, { "to": [-6, 2], "center": [-4, 2], "sweepDeg": 90 },
        { "to": [-6, -2] }, { "to": [-4, -4], "center": [-4, -2], "sweepDeg": 90 },
        { "to": [4, -4] }, { "to": [6, -2], "center": [4, -2], "sweepDeg": 90 }
    ] });
    for (name, outer, shape, area, half, tol) in [
        (
            "circle",
            json!({ "center": [0, 0], "diameterMm": 8 }),
            json!({ "type": "circle", "diameterMm": 8 }),
            PI * 16.0,
            [4.0, 4.0],
            ARC_TOL,
        ),
        (
            "hexagon",
            hexagon,
            json!({ "type": "polygon", "sides": 6, "diameterMm": 10 }),
            1.5 * 3f64.sqrt() * 25.0,
            [5.0, y],
            0.0,
        ),
        (
            "rounded rectangle",
            rounded,
            json!({ "type": "rectangle", "widthMm": 12, "heightMm": 8, "cornerRadiusMm": 2 }),
            80.0 + 4.0 * PI,
            [6.0, 4.0],
            ARC_TOL,
        ),
    ] {
        let polygons = json!([{ "outer": outer }]);
        // a new body 5 tall on the origin, then a boss and a pocket of the same on the cube's top
        for (op, from, to, want, min, max) in [
            (
                "new",
                0,
                5,
                area * 5.0,
                [-half[0], -half[1], 0.0],
                [half[0], half[1], 5.0],
            ),
            ("join", 0, 5, 8000.0 + area * 5.0, [0.0; 3], [20.0, 20.0, 25.0]),
            ("cut", -5, 0, 8000.0 - area * 5.0, [0.0; 3], [20.0; 3]),
        ] {
            let (brep, on_mesh) = if op == "new" {
                (
                    made(
                        "extrude",
                        json!({ "frame": frame, "polygons": polygons, "fromMm": from, "toMm": to }),
                    ),
                    call(
                        "shape.extrude",
                        &json!({ "frame": frame, "shape": shape, "placement": {}, "spec": { "distanceMm": 5 } }),
                    ),
                )
            } else {
                (
                    made(
                        "extrude",
                        json!({ "frame": top, "polygons": polygons, "fromMm": from, "toMm": to, "target": body, "operation": op }),
                    ),
                    call(
                        "shape.extrude",
                        &json!({ "frame": top, "shape": shape, "placement": {}, "spec": { "distanceMm": 5, "operation": op }, "target": mesh(&body) }),
                    ),
                )
            };
            check(
                &format!("{name} {op}"),
                &brep_solid(&brep),
                0.0,
                &mesh_solid(&on_mesh["mesh"]),
                tol,
                want,
                min,
                max,
            );
        }
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
