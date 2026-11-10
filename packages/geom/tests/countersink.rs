// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A countersink cut into a plate, where the cut's cone runs along a surface the plate already has: the hole's wall,
//! the plate's top, or an earlier countersink on the same hole. The kernel leaves sub-micron sliver triangles there,
//! f32 storage flattened some of them, and the cut was refused as "unsafe at mesh storage precision (collapsed
//! triangles)" until it was asked again a little differently.
//!
//! `fixtures/coat-hook-countersink.json` is a wall coat hook built step by step through the engine's JSON, as the app
//! sends it: a back plate (5 mm, and 5.5 mm made 10 percent thicker), a swept hook, two screw holes with a
//! countersink each, then a loft cut for a countersink at the first hole. The unperturbed build used to refuse that
//! cut and went on with it again a little narrower; the thicker plate took the first and refused the second. The
//! first step carries the back plate as it was stored; each later step takes the previous step's answer as its body,
//! so its request carries only its own parts.

use serde_json::{Value, json};
use sx_geom::boolean::Solid;
use sx_geom::{TriMesh, build, json as engine};

/// the area under which a triangle counts as a sliver, mm^2
const SLIVER: f64 = 1e-6;

fn mesh_of(answer: &Value) -> TriMesh {
    let m = &answer["mesh"];
    let flat = |k: &str| -> Vec<f64> {
        m[k].as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_f64().unwrap())
            .collect()
    };
    let indices: Vec<u32> = m["indices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| u32::try_from(x.as_u64().unwrap()).unwrap())
        .collect();
    TriMesh::from_flat(&flat("positions"), &indices).unwrap()
}

/// the stored answer holds no sliver, closes, and does not cross itself at the precision it is stored at
fn assert_clean(what: &str, m: &TriMesh) {
    let slivers = m
        .triangles
        .iter()
        .filter(|&&t| {
            let [a, b, c] = m.corners(t);
            sx_geom::vec3::len(sx_geom::vec3::tri_normal(a, b, c)) / 2.0 < SLIVER
        })
        .count();
    assert_eq!(slivers, 0, "{what}: {slivers} triangles under {SLIVER} mm2");
    assert!(m.edge_report().is_watertight(), "{what}: not closed");
    assert!(
        !Solid::new(m).unwrap().self_intersects(),
        "{what}: crosses itself once stored"
    );
}

/// the build in `fixtures/coat-hook-countersink.json` under `key`, each step on the last one's answer; the answer of
/// each loft cut, by its call number
fn build_chain(key: &str) -> Vec<(u64, TriMesh)> {
    let all: Value = serde_json::from_str(include_str!("fixtures/coat-hook-countersink.json")).unwrap();
    let mut body: Option<Value> = None;
    let mut cuts = Vec::new();
    for step in all[key].as_array().unwrap() {
        let (call, op) = (step["call"].as_u64().unwrap(), step["op"].as_str().unwrap());
        let mut input = step["input"].clone();
        for slot in ["target", "mesh"] {
            if let (Some(part), Some(b)) = (input.get_mut(slot).and_then(Value::as_object_mut), &body) {
                part.insert("mesh".to_owned(), b.clone());
            }
        }
        let answer = engine::call_value(op, &input, &|_| unreachable!())
            .unwrap_or_else(|e| panic!("{key} call {call} ({op}) was refused: {e}"));
        if op == "sketch.loft" {
            cuts.push((call, mesh_of(&answer)));
        }
        body = Some(answer["mesh"].clone());
    }
    cuts
}

#[test]
fn the_coat_hook_countersink_cuts_on_the_first_try() {
    // call 13 is the first try at the first hole's countersink, which the unperturbed build used to refuse; call 14
    // is the same cut again 0.1 mm narrower over it, which the 5.5 mm plate used to refuse
    for (key, calls) in [("unperturbed", &[13][..]), ("back_plate_x1_1", &[13, 14][..])] {
        let cuts = build_chain(key);
        assert_eq!(cuts.iter().map(|c| c.0).collect::<Vec<_>>(), calls, "{key}");
        for (call, m) in &cuts {
            assert_clean(&format!("{key} call {call}"), m);
        }
    }
}

fn flat(m: &TriMesh) -> Value {
    json!({
        "positions": m.positions.iter().flatten().collect::<Vec<_>>(),
        "indices": m.triangles.iter().flatten().collect::<Vec<_>>(),
    })
}

#[test]
fn a_countersink_whose_cone_ends_in_the_plate_top_cuts_clean() {
    // a 5 mm plate with a 4.5 mm hole, then a 90 degree countersink whose wide end (9 mm) lies exactly in the top and
    // whose narrow end lies exactly on the hole's wall, then the same cone cut again from 0.05 mm lower (4.4 mm), as
    // a second try at it would
    let plate = build::box_mesh([0.0; 3], [40.0, 30.0, 5.0]);
    let at = |z: f64| json!({ "origin": [20, 15, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] });
    let hole = engine::call_value(
        "shape.extrude",
        &json!({
            "frame": at(5.0),
            "shape": { "type": "circle", "diameterMm": 4.5 },
            "spec": { "distanceMm": 6, "extent": "oneSide", "operation": "cut" },
            "target": { "mesh": flat(&plate) },
        }),
        &|_| unreachable!(),
    )
    .unwrap();
    let cone = |body: &Value, narrow: f64, z: f64| {
        let profiles = json!([
            { "loops": [{ "type": "circle", "center": [0, 0], "diameterMm": narrow }], "frame": at(z) },
            { "loops": [{ "type": "circle", "center": [0, 0], "diameterMm": 9 }], "frame": at(5.0) },
        ]);
        engine::call_value(
            "sketch.loft",
            &json!({ "profiles": profiles, "operation": "cut", "target": { "mesh": body } }),
            &|_| unreachable!(),
        )
        .unwrap_or_else(|e| panic!("the countersink was refused: {e}"))
    };
    let once = cone(&hole["mesh"], 4.5, 2.75);
    let before = mesh_of(&hole).volume();
    let after = mesh_of(&once);
    assert_clean("countersink", &after);
    // the cone takes off its ring above the hole: pi / 3 h (R^2 + R r + r^2) less the hole's own cylinder
    let (big, small, h) = (4.5_f64, 2.25_f64, 2.25_f64);
    let ring = std::f64::consts::PI * h * ((big * big + big * small + small * small) / 3.0 - small * small);
    assert!(
        (before - after.volume() - ring).abs() < 0.02 * ring,
        "{} of {ring}",
        before - after.volume()
    );
    let twice = mesh_of(&cone(&once["mesh"], 4.4, 2.7));
    assert_clean("the same cone again", &twice);
    assert!(twice.volume() <= after.volume() + 1e-9 * after.volume());
}
