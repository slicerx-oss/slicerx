// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The foot of an organic tree trunk that stands on the bed (`support_bed_foot`): the trunk flares out
//! over its lowest layers, by 1.2 mm of radius at the bed easing back to the trunk at the blend point, and
//! the first layer then grows by `raft_first_layer_expansion` (-1 is 2 mm) from that outline.
//!
//! Measured on a neutral part: a 6 mm square column with a small tab at 12 mm, whose tree is one trunk
//! that reaches the bed beside the column. Settings: 0.12 mm layers over a 0.2 mm first layer, 2 mm
//! branches, 0.42 mm support lines (0.5 mm on the first layer).
//!
//! The radius of a layer's support outline is read from the support toolpaths: half the outline's extent
//! across Y (the column is to the -X side, so the Y extremes are never clipped by it) plus half the line
//! width, since the outer loop runs half a line inside the outline. Each layer is compared with the trunk
//! radius r at the blend point, 48 layers up (layer 49), so the line placement offsets cancel.
//!
//! Tolerances: 0.06 mm on layers 2 to 5, which is just over the sum of the outline's polygon error (the
//! circles and the tube are cut with about 0.015 mm chord error, then simplified by up to 0.03 mm) and
//! the trunk radius changing by about 0.01 mm per layer; adjacent layers are 0.05 mm apart, so the test
//! still tells the steps apart. 0.15 mm on layer 1, which also carries the growth's mitered steps and the
//! first layer's wider line and its fill.

#![allow(
    clippy::disallowed_methods,
    reason = "test measurements of G-code; no output depends on them"
)]

mod common;

use common::organic_models::{cuboid, support_moves};
use serde_json::{Value, json};
use std::sync::Arc;
use sx_core::api::{Mesh, SliceRequest};

/// The neutral part: a 6 mm square column 20 mm tall, with a 3 x 2 mm tab off its +X side from 12 to
/// 13 mm.
fn column_with_tab() -> Mesh {
    Mesh {
        name: "column-tab".into(),
        parts: vec![
            cuboid("column", [-3.0, -3.0, 0.0], [3.0, 3.0, 20.0]),
            cuboid("tab", [3.0, -1.0, 12.0], [6.0, 1.0, 13.0]),
        ],
        ..Mesh::default()
    }
}

fn config(foot: Option<bool>) -> Value {
    let mut c = json!({
        "enable_support": true,
        "support_type": "tree(auto)",
        "support_style": "default",
        "brim_type": "no_brim",
        "brim_width": 0,
        "enable_arc_fitting": false,
        "layer_height": 0.12,
        "initial_layer_print_height": 0.2,
        "initial_layer_line_width": 0.5,
        "support_line_width": 0.42,
        "raft_layers": 0,
        "raft_first_layer_expansion": -1,
        "raft_first_layer_density": "90%",
        "support_object_first_layer_gap": 0.2,
        "support_object_xy_distance": 0.35,
        "support_top_z_distance": 0.12,
        "support_bottom_z_distance": 0.12,
        "support_threshold_angle": 20,
        "tree_support_branch_angle": 45,
        "tree_support_branch_diameter": 2,
        "tree_support_branch_diameter_organic": 2,
        "tree_support_branch_diameter_angle": 5,
        "tree_support_branch_distance": 5,
        "tree_support_wall_count": -1
    });
    if let Some(on) = foot {
        c["support_bed_foot"] = json!(on);
    }
    c
}

fn slice(config: &Value) -> Vec<u8> {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{
            "id": "a",
            "mesh": "m",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 128, 128, 0, 1]
        }] },
        "config": config,
        "options": {}
    }))
    .expect("request");
    let mesh = Arc::new(column_with_tab());
    common::run_request(&req, &move |_: &str| Ok(mesh.clone()))
        .expect("slices")
        .gcode
}

/// The support outline radius on each printed layer (1 based), from the Y extent of the support moves
/// right of the column, with half the line width added back.
fn radii(gcode: &[u8]) -> Vec<(usize, f64)> {
    let text = String::from_utf8_lossy(gcode);
    assert!(
        !text.lines().any(|l| l.starts_with("G2 ") || l.starts_with("G3 ")),
        "the measurement reads straight moves only"
    );
    let layers = support_moves(&text);
    let mut out = Vec::new();
    for (z, segs) in &layers {
        let z = f64::from(*z);
        // Layer number from print Z: 0.2 mm first layer, then 0.12 mm layers.
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "small layer numbers"
        )]
        let layer = if z < 0.25 {
            1
        } else {
            ((z - 0.2) / 0.12).round() as usize + 1
        };
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        for &(_, a, b) in segs {
            for p in [a, b] {
                // Right of the column face (x 131), where the trunk stands.
                if f64::from(p[0]) > 131.0 {
                    lo = lo.min(f64::from(p[1]));
                    hi = hi.max(f64::from(p[1]));
                }
            }
        }
        if hi > lo {
            let w = if layer == 1 { 0.5 } else { 0.42 };
            out.push((layer, (hi - lo) / 2.0 + w / 2.0));
        }
    }
    out
}

fn radius_at(r: &[(usize, f64)], layer: usize) -> f64 {
    r.iter()
        .find(|(l, _)| *l == layer)
        .map_or_else(|| panic!("no support on layer {layer}: {r:?}"), |&(_, v)| v)
}

#[test]
fn a_trunk_on_the_bed_flares_out_over_its_lowest_layers() {
    let r = radii(&slice(&config(Some(true))));
    eprintln!("radii {r:?}");
    let trunk = radius_at(&r, 49);
    for (layer, past) in [(2, 1.15), (3, 1.10), (4, 1.05), (5, 1.00)] {
        let got = radius_at(&r, layer) - trunk;
        assert!(
            (got - past).abs() <= 0.06,
            "layer {layer} sits {got:.3} mm past the trunk radius {trunk:.3}, expected about {past}"
        );
    }
}

#[test]
fn the_first_layer_grows_two_millimeters_past_the_foot() {
    let r = radii(&slice(&config(Some(true))));
    eprintln!("radii {r:?}");
    let trunk = radius_at(&r, 49);
    let got = radius_at(&r, 1) - trunk;
    assert!(
        (got - 3.2).abs() <= 0.15,
        "layer 1 sits {got:.3} mm past the trunk radius {trunk:.3}, expected about 3.2"
    );
}

#[test]
fn the_foot_stays_off_by_default() {
    let off = slice(&config(Some(false)));
    let none = slice(&config(None));
    assert_eq!(off, none, "no key and false give the same output");
}
