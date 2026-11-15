// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where the tree supports of two objects meet, their lines stay on one lattice: each object's support is laid from
//! its own place, and lines from two places that met at an angle would cross where they join.
#![allow(
    clippy::disallowed_methods,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]
#![allow(
    clippy::many_single_char_names,
    reason = "the points and directions of plane geometry"
)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use common::organic_models as models;
use sx_core::api::{Mesh, SliceRequest};

/// Tree support as a project with `support_type` `tree(auto)` and the default style prints it, with object labels.
fn tree_config() -> Value {
    json!({
        "enable_support": true, "support_type": "tree(auto)", "support_style": "default",
        "brim_width": 0, "brim_type": "no_brim", "skirt_loops": 0, "enable_arc_fitting": false,
        "gcode_label_objects": true, "layer_height": 0.2, "initial_layer_print_height": 0.2,
    })
}

/// Slices `objects` (an id, a mesh and the place of its origin each) with tree support and object labels.
fn slice_each(objects: &[(&str, &Mesh, [f32; 2])]) -> String {
    let list: Vec<Value> = objects
        .iter()
        .map(|(id, _, at)| {
            json!({"id": id, "name": id, "mesh": id,
                "transform": [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  at[0], at[1], 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": list},
        "config": tree_config(),
        "options": {"allowCollisions": true},
    }))
    .unwrap();
    let meshes: Vec<(String, Arc<Mesh>)> = objects
        .iter()
        .map(|(id, m, _)| ((*id).to_owned(), Arc::new((*m).clone())))
        .collect();
    let run = common::run_request(&req, &move |id: &str| {
        Ok(meshes
            .iter()
            .find(|(n, _)| n == id)
            .map(|(_, m)| m.clone())
            .unwrap())
    })
    .unwrap();
    String::from_utf8(run.gcode).unwrap()
}

fn mm(p: [f32; 2]) -> [f64; 2] {
    [f64::from(p[0]), f64::from(p[1])]
}

/// A 10 mm column with an arm 3 mm thick reaching `reach` mm along x from it (toward -x when negative), 15 mm up.
fn arm(reach: f32) -> Mesh {
    let (lo, hi) = if reach > 0.0 {
        (5.0, 5.0 + reach)
    } else {
        (-5.0 + reach, -5.0)
    };
    Mesh {
        name: "arm".into(),
        parts: vec![
            models::cuboid("column", [-5.0, -5.0, 0.0], [5.0, 5.0, 18.0]),
            models::cuboid("arm", [lo, -5.0, 15.0], [hi, 5.0, 18.0]),
        ],
        ..Mesh::default()
    }
}

/// Two objects whose arms reach toward each other and end 1 mm apart, so their support meets under the gap: where
/// it meets, its lines run on one lattice, never two lattices across each other or side by side.
#[test]
fn where_two_objects_supports_meet_their_lines_do_not_cross() {
    let (a, b) = (arm(14.5), arm(-14.5));
    let g = slice_each(&[("left", &a, [100.13, 100.0]), ("right", &b, [140.13, 100.0])]);
    let all = models::support_moves(&g);
    let (_, first) = all.first().expect("the plate prints support");
    // The meeting place: 1 mm either side of the gap between the arms' tips (x 119.63 to 120.63).
    let near = |x: f32| (118.63..=121.63).contains(&x);
    let lines: Vec<([f64; 2], [f64; 2])> = first
        .iter()
        .filter(|(_, a, b)| near(a[0]) && near(b[0]))
        .map(|(_, a, b)| (mm(*a), mm(*b)))
        .filter(|(a, b)| (b[0] - a[0]).hypot(b[1] - a[1]) > 1.0)
        .collect();
    assert!(
        lines.len() >= 3,
        "{} support lines where the supports meet",
        lines.len()
    );
    // Any two straight lines there that run side by side are the same line or a whole line apart, and none
    // crosses another at an angle.
    for (i, (a, b)) in lines.iter().enumerate() {
        let d = [b[0] - a[0], b[1] - a[1]];
        let l = d[0].hypot(d[1]);
        let (u, n) = ([d[0] / l, d[1] / l], [-d[1] / l, d[0] / l]);
        for (c, e) in lines.iter().skip(i + 1) {
            let f = [e[0] - c[0], e[1] - c[1]];
            let cross = (u[0] * f[1] - u[1] * f[0]).abs() / f[0].hypot(f[1]);
            let along = |p: [f64; 2]| (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
            let (s0, s1) = (along(*c).min(along(*e)), along(*c).max(along(*e)));
            if s1 < 0.0 || s0 > l {
                continue;
            }
            if cross > 0.05 {
                // Lines at an angle to each other may meet at an end (a line joined to the next), never cross.
                let orient = |p: [f64; 2], q: [f64; 2], r: [f64; 2]| {
                    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
                };
                let apart = |x: f64, y: f64| x * y < -1e-6;
                assert!(
                    !(apart(orient(*a, *b, *c), orient(*a, *b, *e))
                        && apart(orient(*c, *e, *a), orient(*c, *e, *b))),
                    "support lines {a:.2?}-{b:.2?} and {c:.2?}-{e:.2?} cross where the supports meet"
                );
                continue;
            }
            let gap = ((c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1]).abs();
            assert!(
                gap < 0.02 || gap > 0.3,
                "support lines {a:.2?}-{b:.2?} and {c:.2?}-{e:.2?} run {gap:.3} mm apart where the supports meet"
            );
        }
    }
}
