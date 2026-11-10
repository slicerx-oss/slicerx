// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! curved bodies shelled open at the top, through the engine's JSON: the result stores as it is, with no collapsed
//! triangles and no faces that cross, and the next join on it goes through

#![cfg(feature = "shell")]

use serde_json::{Value, json};
use sx_geom::TriMesh;
use sx_geom::boolean::Solid;

fn run(op: &str, req: &Value) -> Value {
    serde_json::from_str(&sx_geom::json::call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}")))
        .unwrap()
}

fn mesh(m: &Value) -> TriMesh {
    let floats = |k: &str| -> Vec<f64> {
        m["mesh"][k]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_f64().unwrap())
            .collect()
    };
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "indices of a small mesh"
    )]
    let indices: Vec<u32> = floats("indices").iter().map(|&i| i as u32).collect();
    TriMesh::from_flat(&floats("positions"), &indices).unwrap()
}

fn level(z: f64) -> Value {
    json!({ "origin": [0, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] })
}

/// a 160 mm vase lofted smooth through hexagons of radius 40 turned 15 degrees every 40 mm (points to 0.001 mm),
/// standing at (128, 128) on the plate
fn twisted_vase() -> Value {
    let hexagons = [
        [
            [40.0, 0.0],
            [20.0, 34.641],
            [-20.0, 34.641],
            [-40.0, 0.0],
            [-20.0, -34.641],
            [20.0, -34.641],
        ],
        [
            [38.637, 10.353],
            [10.353, 38.637],
            [-28.284, 28.284],
            [-38.637, -10.353],
            [-10.353, -38.637],
            [28.284, -28.284],
        ],
        [
            [34.641, 20.0],
            [0.0, 40.0],
            [-34.641, 20.0],
            [-34.641, -20.0],
            [0.0, -40.0],
            [34.641, -20.0],
        ],
        [
            [28.284, 28.284],
            [-10.353, 38.637],
            [-38.637, 10.353],
            [-28.284, -28.284],
            [10.353, -38.637],
            [38.637, -10.353],
        ],
        [
            [40.0, 0.0],
            [20.0, 34.641],
            [-20.0, 34.641],
            [-40.0, 0.0],
            [-20.0, -34.641],
            [20.0, -34.641],
        ],
    ];
    let profiles: Vec<Value> = hexagons
        .iter()
        .zip([0.0, 40.0, 80.0, 120.0, 160.0])
        .map(|(points, z)| json!({ "frame": level(z), "loops": [{ "points": points }] }))
        .collect();
    let loft = run("sketch.loft", &json!({ "profiles": profiles, "smooth": true }));
    json!({ "mesh": loft["mesh"], "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 128, 128, 0, 1] })
}

/// the result of a shell as it is stored: no triangle without area and no faces that cross
fn stores_clean(mesh: &TriMesh, what: &str) {
    let flat = mesh
        .triangles
        .iter()
        .filter(|&&t| sx_geom::vec3::len(mesh.normal(t)) <= 0.0)
        .count();
    assert_eq!(flat, 0, "{what}: triangles without area");
    assert!(
        !Solid::new(mesh).unwrap().self_intersects(),
        "{what}: faces cross"
    );
}

#[test]
#[cfg_attr(debug_assertions, ignore = "a 2 million cell voxel wall; run with --release")]
fn a_twisted_vase_shells_clean_at_each_wall_and_takes_a_bottom() {
    let vase = twisted_vase();
    for wall in [1.6, 2.0, 2.4, 2.6] {
        let open = json!([{ "at": [128, 128, 160], "normal": [0, 0, 1] }]);
        let shelled = run("shell", &json!({ "mesh": vase, "open": open, "wallMm": wall }));
        assert_eq!(shelled["watertight"], true, "{wall}");
        assert_eq!(shelled["shells"], 1, "{wall}");
        stores_clean(&mesh(&shelled), &format!("{wall} mm"));
        // a 3 mm slab joined under it, as the vase's bottom
        let slab = json!({ "type": "sketch", "loops": [{ "points": [
            [37.68, 0], [18.84, 32.63], [-18.84, 32.63], [-37.68, 0], [-18.84, -32.63], [18.84, -32.63]
        ] }] });
        let target = json!({ "mesh": shelled["mesh"], "transform": vase["transform"] });
        let joined = run(
            "shape.extrude",
            &json!({ "frame": { "origin": [128, 128, 0], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] },
                     "shape": slab, "placement": {}, "target": target,
                     "spec": { "distanceMm": 3, "extent": "oneSide", "operation": "join" } }),
        );
        assert_eq!(joined["watertight"], true, "{wall}");
    }
}

#[test]
fn a_bowl_and_a_cylinder_shell_clean() {
    // a bowl lofted smooth through circles of 40, 60 and 50 mm, so its sides lean out and then back in at the top
    let circle = |d: f64| json!({ "type": "circle", "center": [0, 0], "diameterMm": d });
    let profiles = json!([
        { "frame": level(0.0), "loops": [circle(40.0)] },
        { "frame": level(15.0), "loops": [circle(60.0)] },
        { "frame": level(30.0), "loops": [circle(50.0)] },
    ]);
    let bowl = run("sketch.loft", &json!({ "profiles": profiles, "smooth": true }));
    let can = sx_geom::build::cylinder(&sx_geom::vec3::Frame::WORLD, 15.0, 0.0, 30.0, 64);
    let can = json!({ "positions": can.positions.iter().flatten().collect::<Vec<_>>(),
                      "indices": can.triangles.iter().flatten().collect::<Vec<_>>() });
    for (name, body) in [("bowl", bowl["mesh"].clone()), ("cylinder", can)] {
        for wall in [1.6, 2.0, 2.4, 2.6] {
            let open = json!([{ "at": [0, 0, 30], "normal": [0, 0, 1] }]);
            let shelled = run("shell", &json!({ "mesh": body, "open": open, "wallMm": wall }));
            assert_eq!(shelled["watertight"], true, "{name} {wall}");
            assert_eq!(shelled["shells"], 1, "{name} {wall}");
            assert_eq!(shelled["report"]["exact"], false, "{name} {wall}");
            stores_clean(&mesh(&shelled), &format!("{name} {wall} mm"));
        }
    }
}

#[test]
fn a_shell_that_would_not_store_is_refused_at_the_shell_with_its_wall() {
    // a cylinder a kilometer out along x in its own frame, where stored positions step by 0.0625 mm
    let mut can = sx_geom::build::cylinder(&sx_geom::vec3::Frame::WORLD, 15.0, 0.0, 30.0, 64);
    can.translate([1.0e6, 0.0, 0.0]);
    let body = json!({ "positions": can.positions.iter().flatten().collect::<Vec<_>>(),
                       "indices": can.triangles.iter().flatten().collect::<Vec<_>>() });
    let open = json!([{ "at": [1.0e6, 0, 30], "normal": [0, 0, 1] }]);
    let e = sx_geom::json::call(
        "shell",
        &json!({ "mesh": body, "open": open, "wallMm": 2 }).to_string(),
    )
    .unwrap_err()
    .to_string();
    assert!(
        e.starts_with("shell: a 2 mm wall does not work on this body, since "),
        "{e}"
    );
    assert!(e.ends_with("; try a wall a little thinner or thicker"), "{e}");
}
