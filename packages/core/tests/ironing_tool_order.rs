// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Two objects on filaments of their own, printed layer by layer with ironing: every extrusion of each object,
//! its ironing included, prints with that object's filament on every layer. Ironing a top surface used to print
//! last on the layer whatever the layer's planned order, so when the shorter object's filament came first that
//! layer ended on it while the plan said otherwise, and the taller object printed the rest of the plate on the
//! wrong filament with no tool change.

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{Mesh, MeshPart, SliceRequest};

/// A 15 mm box of `h` mm on filament `slot`.
fn block(h: f32, slot: u8) -> Arc<Mesh> {
    let mut positions = Vec::new();
    for z in [0.0, h] {
        for (x, y) in [(0.0, 0.0), (15.0, 0.0), (15.0, 15.0), (0.0, 15.0)] {
            positions.push([x, y, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    Arc::new(Mesh {
        name: format!("block {slot}"),
        parts: vec![MeshPart {
            name: format!("part {slot}"),
            slot,
            color: None,
            positions,
            triangles,
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
            paint_texts: Vec::new(),
        }],
        ..Mesh::default()
    })
}

/// Where object A (left) and B (right) stand, mm.
const A_X: f64 = 100.0;
const B_X: f64 = 140.0;

fn at(x: f64) -> Value {
    json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 120, 0, 1])
}

/// A on filament 1 and `a_h` mm tall, B on filament 2 and `b_h` mm tall, over `extra` settings.
fn run(a_h: f32, b_h: f32, extra: &Value) -> String {
    let mut c = json!({
        "brim_width": 0,
        "skirt_loops": 0,
        "enable_prime_tower": true,
        "prime_tower_auto_position": "0",
        "wipe_tower_x": ["20"],
        "wipe_tower_y": ["200"],
        "ironing_type": "top",
        "change_filament_gcode": "T[next_extruder]",
    });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "a", "name": "a", "mesh": "a", "transform": at(A_X)},
            {"id": "b", "name": "b", "mesh": "b", "transform": at(B_X)},
        ]},
        "config": c,
        "options": {"flavor": "marlin2", "allowCollisions": true},
    }))
    .unwrap();
    let load = move |id: &str| -> sx_core::Result<Arc<Mesh>> {
        Ok(if id == "a" { block(a_h, 1) } else { block(b_h, 2) })
    };
    let run = common::run_request(&req, &load).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

fn num(line: &str, axis: char) -> Option<f64> {
    line.split_whitespace()
        .find_map(|w| w.strip_prefix(axis).and_then(|v| v.parse().ok()))
}

/// Every object extrusion as (z, object, feature, active tool), the object told by where it is. The prime tower,
/// skirt, brim and support are left out. The tool is the last `T<n>` select; None before the first.
fn extrusions(g: &str) -> Vec<(f64, char, String, Option<u32>)> {
    let (mut tool, mut z, mut feature) = (None, 0.0, String::new());
    let (mut x, mut e, mut relative) = (0.0, 0.0, false);
    let mut out = Vec::new();
    for l in g.lines() {
        if let Some(t) = l.strip_prefix('T').and_then(|t| t.trim().parse::<u32>().ok()) {
            tool = Some(t);
        } else if l.starts_with("M83") {
            relative = true;
        } else if l.starts_with("M82") {
            relative = false;
        } else if let Some(f) = l.strip_prefix(";TYPE:").or_else(|| l.strip_prefix("; FEATURE:")) {
            f.trim().clone_into(&mut feature);
        } else if l.starts_with("G1 ") || l.starts_with("G2 ") || l.starts_with("G3 ") {
            if let Some(v) = num(l, 'Z') {
                z = v;
            }
            let moved = num(l, 'X');
            if let Some(v) = moved {
                x = v;
            }
            let Some(ev) = num(l, 'E') else { continue };
            let extrudes = if relative { ev > 0.0 } else { ev > e };
            if !relative {
                e = ev;
            }
            if !extrudes || moved.is_none() {
                continue;
            }
            let skip = ["tower", "Skirt", "Brim", "Support", "Custom"];
            if skip.iter().any(|s| feature.contains(s)) {
                continue;
            }
            let object = if (A_X - 2.0..A_X + 17.0).contains(&x) {
                'A'
            } else if (B_X - 2.0..B_X + 17.0).contains(&x) {
                'B'
            } else {
                continue;
            };
            out.push((z, object, feature.clone(), tool));
        } else if l.starts_with("G92") && l.contains("E0") {
            e = 0.0;
        }
    }
    out
}

/// The extrusions printed on a filament other than their object's (A on tool 0, B on tool 1), as
/// "z object feature on T<n>", and how many object extrusions there were.
fn wrong(g: &str) -> (Vec<String>, usize) {
    let all = extrusions(g);
    let mut bad: Vec<String> = all
        .iter()
        .filter(|(_, o, _, t)| t.is_some_and(|t| t != u32::from(*o != 'A')))
        .map(|(z, o, f, t)| format!("z {z:.2} {o} {f} on T{}", t.unwrap_or(0)))
        .collect();
    bad.dedup();
    (bad, all.len())
}

fn assert_own_filaments(g: &str, what: &str) {
    let (bad, n) = wrong(g);
    assert!(n > 1000, "{what}: only {n} object extrusions found");
    assert!(
        bad.is_empty(),
        "{what}: {} runs of extrusions on the wrong filament, first {:?}",
        bad.len(),
        &bad[..bad.len().min(5)]
    );
}

#[test]
fn the_taller_object_keeps_its_filament_after_the_shorter_one_is_ironed() {
    // Which filament a layer starts on alternates, so the shorter object's top layer comes first on one of these
    // heights and last on the other.
    for (a_h, b_h) in [(5.0, 20.0), (20.0, 5.0), (5.2, 20.0)] {
        let g = run(a_h, b_h, &json!({"printer_model": "Bambu Lab A1"}));
        assert_own_filaments(&g, &format!("A1, A {a_h} mm, B {b_h} mm"));
    }
}

#[test]
fn without_the_prime_tower_or_with_support_each_object_keeps_its_filament() {
    for extra in [
        json!({"printer_model": "Bambu Lab A1", "enable_prime_tower": false}),
        json!({"printer_model": "Bambu Lab A1", "enable_support": true}),
        json!({"printer_model": "Bambu Lab P1S"}),
    ] {
        let g = run(5.0, 20.0, &extra);
        assert_own_filaments(&g, &extra.to_string());
    }
}

#[test]
fn ironing_every_solid_layer_irons_each_object_with_its_own_filament() {
    let g = run(
        5.0,
        20.0,
        &json!({"printer_model": "Bambu Lab A1", "ironing_type": "solid"}),
    );
    assert_own_filaments(&g, "solid ironing");
}

#[test]
fn two_objects_topping_out_on_one_layer_are_each_ironed_with_their_own_filament() {
    let g = run(20.0, 20.0, &json!({"printer_model": "Bambu Lab A1"}));
    assert_own_filaments(&g, "same height");
    // Both tops are ironed.
    let ironed: Vec<char> = extrusions(&g)
        .into_iter()
        .filter(|(_, _, f, _)| f == "Ironing")
        .map(|(_, o, _, _)| o)
        .collect();
    assert!(
        ironed.contains(&'A') && ironed.contains(&'B'),
        "ironed: {ironed:?}"
    );
}

#[test]
fn a_multi_tool_printer_of_another_brand_keeps_each_object_on_its_filament() {
    // No printer model: the plain change G-code and a wipe tower, as on a tool changer or a multi-material unit.
    let g = run(5.0, 20.0, &json!({}));
    assert_own_filaments(&g, "no printer model");
}

#[test]
fn ironing_adds_no_tool_change_to_the_plan() {
    let changes = |g: &str| {
        g.lines()
            .filter(|l| l.starts_with('T') && l[1..].trim().parse::<u32>().is_ok())
            .count()
    };
    let ironed = run(5.0, 20.0, &json!({"printer_model": "Bambu Lab A1"}));
    let plain = run(
        5.0,
        20.0,
        &json!({"printer_model": "Bambu Lab A1", "ironing_type": "no ironing"}),
    );
    assert_eq!(changes(&ironed), changes(&plain));
}
