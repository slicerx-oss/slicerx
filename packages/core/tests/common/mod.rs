// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Shared by the request tests: the settings they were written against.
//!
//! A config that leaves a key out gets the settings schema's default (what the app starts from). The
//! request tests check mechanisms (a wall order, a purge, a speed rule), so each one runs on top of this
//! fixed base instead, and a change of a schema default does not move them. Keys a test sets win.
#![allow(dead_code)]

use serde_json::Value;
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest, SliceRun};

/// The base: 0.42 mm lines, 2 classic walls, 5 top and 3 bottom layers, 15 percent rectilinear, a 5 mm brim,
/// no skirt, back seams, fast speeds.
pub fn base() -> Value {
    serde_json::from_str(
        r#"{
        "wall_generator": "classic",
        "seam_position": "back",
        "seam_gap": 0,
        "line_width": 0.42,
        "outer_wall_line_width": 0.42,
        "inner_wall_line_width": 0.42,
        "sparse_infill_line_width": 0.42,
        "internal_solid_infill_line_width": 0.42,
        "top_surface_line_width": 0.42,
        "support_line_width": 0.42,
        "initial_layer_line_width": 0.42,
        "top_shell_thickness": 0,
        "top_shell_layers": 5,
        "sparse_infill_density": "15%",
        "sparse_infill_pattern": "rectilinear",
        "brim_width": 5,
        "skirt_loops": 0,
        "skirt_speed": 0,
        "outer_wall_speed": 200,
        "inner_wall_speed": 300,
        "sparse_infill_speed": 270,
        "internal_solid_infill_speed": 250,
        "top_surface_speed": 200,
        "initial_layer_speed": 50,
        "initial_layer_infill_speed": 105,
        "travel_speed": 500,
        "bridge_speed": 50,
        "gap_infill_speed": 250,
        "support_speed": 150,
        "support_interface_top_layers": 2,
        "small_support_perimeter_speed": 0,
        "tree_support_auto_brim": true,
        "enable_overhang_speed": true,
        "precise_outer_wall": true,
        "flush_into_infill": true,
        "prime_tower_width": 35,
        "combine_brims": true,
        "resolution": 0.012,
        "default_acceleration": 0,
        "outer_wall_acceleration": 0,
        "inner_wall_acceleration": 0,
        "top_surface_acceleration": 0,
        "initial_layer_acceleration": 0,
        "travel_acceleration": 0,
        "default_jerk": 0,
        "outer_wall_jerk": 0,
        "inner_wall_jerk": 0,
        "infill_jerk": 0,
        "top_surface_jerk": 0,
        "initial_layer_jerk": 0,
        "travel_jerk": 0
    }"#,
    )
    .unwrap_or_default()
}

/// `config` over the base.
pub fn with_base(config: &Value) -> Value {
    let mut c = base();
    if let (Some(dst), Some(src)) = (c.as_object_mut(), config.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    c
}

/// `api::run_request` with the request's config over the base.
pub fn run_request(
    req: &SliceRequest,
    load: &dyn Fn(&str) -> sx_core::Result<Arc<Mesh>>,
) -> sx_core::Result<SliceRun> {
    let mut r = req.clone();
    r.config = with_base(&req.config);
    api::run_request(&r, load)
}
