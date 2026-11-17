// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Faces that look into a closed void mesh facing out of the material: a body hollowed by a boolean, then joined to a
// box or a rod through its wall into the void. The mesh the engine answers runs every shared edge both ways, holds
// the body's own volume and keeps a normal at every corner.
// Empty without the brep feature, so a workspace test run that names every test target passes over it.
#![cfg(feature = "brep")]
use serde_json::{Value, json};
use std::collections::HashMap;
use sx_brep::Tessellation;
use sx_geom::exact as table;

/// How far the mesh's volume may be from the body's, as a share of it: the default chord's own error.
const MESH_SHARE: f64 = 1e-3;

fn op(name: &str, request: &Value) -> Value {
    let reply = sx_geom::json::call(name, &request.to_string()).unwrap_or_else(|e| panic!("{name}: {e}"));
    serde_json::from_str(&reply).expect("a JSON reply")
}

fn body(v: &Value) -> u64 {
    v["body"].as_u64().expect("a body number")
}

fn made(name: &str, request: &Value) -> u64 {
    body(&op(name, request))
}

fn cuboid(min: [f64; 3], max: [f64; 3]) -> u64 {
    made("brep.box", &json!({ "min": min, "max": max }))
}

fn rod(origin: [f64; 3], d: f64, h: f64) -> u64 {
    made(
        "brep.cylinder",
        &json!({ "origin": origin, "axis": [0, 0, 1], "diameterMm": d, "heightMm": h }),
    )
}

fn boolean(a: u64, b: u64, how: &str) -> u64 {
    made("brep.boolean", &json!({ "a": a, "b": b, "op": how }))
}

/// What the engine's mesh of a held body shows: its volume, the shared edges both triangles run the same way, and the
/// edges only one triangle has.
fn mesh_of(held: u64) -> (f64, usize, usize) {
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
        let [first, second, third] = [point(triangle[0]), point(triangle[1]), point(triangle[2])];
        let across = [
            second[1] * third[2] - second[2] * third[1],
            second[2] * third[0] - second[0] * third[2],
            second[0] * third[1] - second[1] * third[0],
        ];
        volume += (first[0] * across[0] + first[1] * across[1] + first[2] * across[2]) / 6.0;
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

/// The body's own volume, from the kernel.
fn volume_of(held: u64) -> f64 {
    op("brep.info", &json!({ "body": held }))["volumeMm3"]
        .as_f64()
        .expect("a volume")
}

/// The engine's mesh of `held` runs every shared edge both ways, has no open edge, holds the body's volume, and keeps
/// a normal at every corner.
fn meshes_as_the_body(held: u64, what: &str) {
    let (mesh, same, open) = mesh_of(held);
    let kernel = volume_of(held);
    let flat = table::with(u32::try_from(held).expect("a number"), |kept| {
        let mesh = kept.body.tessellate(&Tessellation::default()).expect("a mesh");
        mesh.normals.iter().filter(|n| n.is_none()).count()
    })
    .expect("held");
    assert!(
        same == 0 && open == 0 && (mesh - kernel).abs() <= MESH_SHARE * kernel && flat == 0,
        "{what}: mesh {mesh} mm3 against the body's {kernel}, {same} edges run the same way, {open} open, {flat} \
         triangles without corner normals"
    );
}

/// A 20 mm cube with a closed 16 mm void, made by a boolean.
fn hollow_box() -> u64 {
    boolean(
        cuboid([0.0; 3], [20.0; 3]),
        cuboid([2.0; 3], [18.0; 3]),
        "difference",
    )
}

/// A 20 mm cylinder 20 mm tall with a closed void 16 mm across and 16 mm tall, made by a boolean.
fn hollow_cylinder() -> u64 {
    boolean(
        rod([0.0; 3], 20.0, 20.0),
        rod([0.0, 0.0, 2.0], 16.0, 16.0),
        "difference",
    )
}

#[test]
fn a_hollow_box_meshes_as_the_body() {
    if !sx_brep::KERNEL {
        return;
    }
    meshes_as_the_body(hollow_box(), "a hollow box");
}

#[test]
fn a_hollow_box_joined_to_a_box_through_both_walls_meshes_as_the_body() {
    if !sx_brep::KERNEL {
        return;
    }
    let joined = boolean(
        hollow_box(),
        cuboid([-5.0, 9.0, 5.0], [25.0, 11.0, 15.0]),
        "union",
    );
    meshes_as_the_body(joined, "a hollow box with a box through both walls");
}

#[test]
fn a_hollow_box_joined_to_a_box_through_one_wall_meshes_as_the_body() {
    if !sx_brep::KERNEL {
        return;
    }
    let joined = boolean(
        hollow_box(),
        cuboid([-5.0, 9.0, 5.0], [10.0, 11.0, 15.0]),
        "union",
    );
    meshes_as_the_body(joined, "a hollow box with a box through one wall");
}

#[test]
fn a_hollow_box_joined_to_a_box_from_inside_its_wall_meshes_as_the_body() {
    if !sx_brep::KERNEL {
        return;
    }
    let joined = boolean(hollow_box(), cuboid([1.0, 9.0, 5.0], [10.0, 11.0, 15.0]), "union");
    meshes_as_the_body(
        joined,
        "a hollow box with a box from inside its wall into the void",
    );
}

#[test]
fn a_hollow_box_joined_to_a_rod_through_both_walls_meshes_as_the_body() {
    if !sx_brep::KERNEL {
        return;
    }
    let joined = boolean(hollow_box(), rod([10.0, 10.0, -5.0], 4.0, 30.0), "union");
    meshes_as_the_body(joined, "a hollow box with a 4 mm rod through both walls");
}

#[test]
fn a_hollow_cylinder_joined_to_a_box_through_its_wall_meshes_as_the_body() {
    if !sx_brep::KERNEL {
        return;
    }
    for (name, lo, hi) in [
        ("both walls", [-15.0, -1.0, 5.0], [15.0, 1.0, 15.0]),
        ("one wall", [-15.0, -1.0, 5.0], [0.0, 1.0, 15.0]),
    ] {
        let joined = boolean(hollow_cylinder(), cuboid(lo, hi), "union");
        meshes_as_the_body(joined, &format!("a hollow cylinder with a box through {name}"));
    }
}

#[test]
fn a_box_with_a_round_void_joined_to_a_rod_through_it_meshes_as_the_body() {
    if !sx_brep::KERNEL {
        return;
    }
    let round_void = boolean(
        cuboid([0.0; 3], [20.0; 3]),
        rod([10.0, 10.0, 3.0], 12.0, 14.0),
        "difference",
    );
    meshes_as_the_body(round_void, "a box with a round void");
    let joined = boolean(round_void, rod([10.0, 10.0, -5.0], 3.0, 30.0), "union");
    meshes_as_the_body(joined, "a box with a round void and a 3 mm rod through it");
}
