// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! atlas places the prime tower clear of everything the objects lay down on the bed, not only their outlines: the
//! support's first layer, the brim and the skirt. The features plate (a cube and a table with support) put it on
//! the table's support and across the skirt before.

use serde_json::Value;
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};
use sx_core::collide::Kind;

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

/// The first layer's extruding moves of each feature, as segments.
fn first_layer(gcode: &str) -> Vec<(String, [f64; 2], [f64; 2])> {
    let (mut feature, mut at, mut layer) = (String::new(), None::<[f64; 2]>, 0);
    let mut out = Vec::new();
    for line in gcode.lines() {
        if line.starts_with(";LAYER_CHANGE") {
            layer += 1;
            if layer > 1 {
                break;
            }
        }
        if let Some(f) = line
            .strip_prefix("; FEATURE: ")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            f.trim().clone_into(&mut feature);
        }
        if !(line.starts_with("G1 ") || line.starts_with("G0 ")) {
            continue;
        }
        let word = |c: char| {
            line.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        let next = match (word('X'), word('Y'), at) {
            (Some(x), Some(y), _) => [x, y],
            (Some(x), None, Some(p)) => [x, p[1]],
            (None, Some(y), Some(p)) => [p[0], y],
            _ => continue,
        };
        if let (Some(p), Some(e)) = (at, word('E'))
            && e > 0.0
            && line.starts_with("G1 ")
        {
            out.push((feature.clone(), p, next));
        }
        at = Some(next);
    }
    out
}

/// True when the segment `a`-`b` touches the box `[x0, y0, x1, y1]` (Liang-Barsky clipping).
fn hits_box(a: [f64; 2], b: [f64; 2], r: [f64; 4]) -> bool {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [
        (-dx, a[0] - r[0]),
        (dx, r[2] - a[0]),
        (-dy, a[1] - r[1]),
        (dy, r[3] - a[1]),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return false;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
        }
    }
    t0 <= t1
}

#[test]
fn the_tower_stands_clear_of_support_and_skirt_on_the_features_plate() {
    let dir = format!("{}/packages/core/cli/tests/fixtures", root());
    let mut req: Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{dir}/features-request.json")).unwrap())
            .unwrap();
    // the engine picks the spot, as it did when the tower landed on the table's support
    req["config"]["prime_tower_auto_position"] = Value::Bool(true);
    let meshes = req["meshes"].clone();
    req.as_object_mut().unwrap().remove("meshes");
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let load = move |m: &str| {
        let file = meshes[m].as_str().unwrap_or(m).to_owned();
        let bytes = std::fs::read(format!("{dir}/{file}")).unwrap();
        Ok(Arc::new(Mesh::load(&bytes, &file).unwrap()))
    };
    let run = api::run_request(&req, &load).unwrap();
    let crossings: Vec<_> = run
        .report
        .collisions
        .iter()
        .filter(|c| c.kind == Kind::PathConflict)
        .collect();
    assert!(crossings.is_empty(), "{crossings:?}");
    let moves = first_layer(&String::from_utf8_lossy(&run.gcode));
    let tower: Vec<_> = moves.iter().filter(|m| m.0 == "Prime tower").collect();
    assert!(!tower.is_empty(), "the plate prints a tower");
    let b = tower
        .iter()
        .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, m| {
            [
                b[0].min(m.1[0]).min(m.2[0]),
                b[1].min(m.1[1]).min(m.2[1]),
                b[2].max(m.1[0]).max(m.2[0]),
                b[3].max(m.1[1]).max(m.2[1]),
            ]
        });
    for (feature, a, c) in &moves {
        if matches!(
            feature.as_str(),
            "Support" | "Support interface" | "Skirt" | "Brim"
        ) {
            assert!(
                !hits_box(*a, *c, b),
                "{feature} {a:?} to {c:?} runs through the tower at {b:?}"
            );
        }
    }
}
