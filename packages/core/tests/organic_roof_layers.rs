// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The interface under an organic tree roof, read back from the G-code of a small part made here: a 16 mm square
//! slab on a thin post, whose flat underside gets a roof of `support_interface_top_layers` layers.
//!
//! With organic trees planned per object, the layer the tips stand on right under the roof prints interface too, so
//! the branches start on interface lines rather than on bare tips; planned for the whole plate it stays support.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use common::organic_models::{self as models};
use sx_core::api::{Mesh, SliceRequest};

const LAYER_MM: f64 = 0.2;
/// The underside of the slab, mm.
const SLAB_Z: f32 = 10.0;

/// A 2 mm square post 10 mm high under a 16 mm square slab 1 mm thick.
fn slab_on_post() -> Mesh {
    Mesh {
        name: "slab-post".into(),
        parts: vec![
            models::cuboid("post", [-1.0, -1.0, 0.0], [1.0, 1.0, SLAB_Z + 0.2]),
            models::cuboid("slab", [-8.0, -8.0, SLAB_Z], [8.0, 8.0, SLAB_Z + 1.0]),
        ],
        ..Mesh::default()
    }
}

/// The G-code of `mesh` alone in the middle of the plate, with organic tree support and the settings of `extra`.
fn slice(mesh: &Mesh, extra: &Value) -> String {
    let mut config = json!({
        "enable_support": true, "support_type": "tree(auto)", "support_style": "default",
        "tree_support_branch_diameter_organic": 2, "tree_support_tip_diameter": 0.8,
        "support_interface_top_layers": 2, "support_interface_spacing": 0.5, "support_top_z_distance": LAYER_MM,
        "brim_width": 0, "brim_type": "no_brim", "skirt_loops": 0, "enable_arc_fitting": false,
        "layer_height": LAYER_MM, "initial_layer_print_height": LAYER_MM,
    });
    if let (Some(dst), Some(src)) = (config.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "part", "name": "part", "mesh": "part",
            "transform": [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  128, 128, 0, 1]}]},
        "config": config,
    }))
    .unwrap();
    let mesh = Arc::new(mesh.clone());
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// Per support layer under the slab, from the top down: its print Z, interface length and base support length, mm.
fn under_slab(gcode: &str) -> Vec<(f64, f64, f64)> {
    let mut out: Vec<(f64, f64, f64)> = models::support_moves(gcode)
        .iter()
        .filter(|(z, _)| f64::from(*z) < f64::from(SLAB_Z) + 1e-3)
        .map(|(z, segs)| {
            let len = |want: bool| -> f64 {
                segs.iter()
                    .filter(|(iface, ..)| *iface == want)
                    .map(|(_, a, b)| f64::from(b[0] - a[0]).hypot(f64::from(b[1] - a[1])))
                    .sum()
            };
            (f64::from(*z), len(true), len(false))
        })
        .filter(|(_, i, s)| *i + *s > 0.0)
        .collect();
    out.sort_by(|a, b| b.0.total_cmp(&a.0));
    out
}

#[test]
fn the_tips_under_a_roof_stand_on_interface_when_planned_per_object() {
    let on = under_slab(&slice(&slab_on_post(), &json!({"organic_per_object": true})));
    let off = under_slab(&slice(&slab_on_post(), &json!({"organic_per_object": false})));
    let show = |v: &[(f64, f64, f64)]| v.iter().take(5).copied().collect::<Vec<_>>();
    // The top two layers are the roof (its contact and the interface layer under it) either way.
    for (name, v) in [("on", &on), ("off", &off)] {
        assert!(
            v.len() > 3 && v[0].1 > 0.0 && v[1].1 > 0.0,
            "{name}: the roof prints two interface layers: {:?}",
            show(v)
        );
        assert!(
            (v[0].0 - v[1].0 - LAYER_MM).abs() < 1e-3 && (v[1].0 - v[2].0 - LAYER_MM).abs() < 1e-3,
            "{name}: the top three support layers are consecutive: {:?}",
            show(v)
        );
    }
    // The third layer holds the tips: interface with the switch on, base support with it off.
    assert!(
        on[2].1 > 0.0,
        "on: the tip layer prints interface: {:?}",
        show(&on)
    );
    assert!(
        off[2].1 == 0.0 && off[2].2 > 0.0,
        "off: the tip layer prints support only: {:?}",
        show(&off)
    );
    // Below the tips both print support only.
    assert!(
        on[3].1 == 0.0 && off[3].1 == 0.0,
        "no interface below the tips: on {:?} off {:?}",
        show(&on),
        show(&off)
    );
}
