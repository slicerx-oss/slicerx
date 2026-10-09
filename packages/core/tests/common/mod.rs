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

/// A 12 x 12 x 1.2 mm tile painted the way image keychains are: the bottom face on a 0.6 mm grid in rings of
/// filament 2 about a millimeter wide, with the cells along each ring's edge split and partly left plain
/// (so half-size triangles meet whole ones), half of the right side in filament 2 too, a band of filament 3
/// across the top, and a plain bar of filament 2 sunk into the bottom. Every layer has several colors.
#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "a small procedural grid"
)]
pub fn painted_tile() -> Mesh {
    const N: u32 = 20;
    const CELL: f32 = 0.6;
    const H: f32 = 1.2;
    let w = CELL * N as f32;
    let at = |i: u32, j: u32, top: bool| (u32::from(top) * (N + 1) + j) * (N + 1) + i;
    let mut positions = Vec::new();
    for z in [0.0, H] {
        for j in 0..=N {
            for i in 0..=N {
                positions.push([i as f32 * CELL, j as f32 * CELL, z]);
            }
        }
    }
    let mut triangles: Vec<[u32; 3]> = Vec::new();
    for j in 0..N {
        for i in 0..N {
            let b = |di: u32, dj: u32| at(i + di, j + dj, false);
            let t = |di: u32, dj: u32| at(i + di, j + dj, true);
            triangles.push([b(0, 0), b(1, 1), b(1, 0)]);
            triangles.push([b(0, 0), b(0, 1), b(1, 1)]);
            triangles.push([t(0, 0), t(1, 0), t(1, 1)]);
            triangles.push([t(0, 0), t(1, 1), t(0, 1)]);
        }
    }
    for k in 0..N {
        triangles.push([at(k, 0, false), at(k + 1, 0, false), at(k + 1, 0, true)]);
        triangles.push([at(k, 0, false), at(k + 1, 0, true), at(k, 0, true)]);
        triangles.push([at(k, N, false), at(k + 1, N, true), at(k + 1, N, false)]);
        triangles.push([at(k, N, false), at(k, N, true), at(k + 1, N, true)]);
        triangles.push([at(0, k, false), at(0, k + 1, true), at(0, k + 1, false)]);
        triangles.push([at(0, k, false), at(0, k, true), at(0, k + 1, true)]);
        triangles.push([at(N, k, false), at(N, k + 1, false), at(N, k + 1, true)]);
        triangles.push([at(N, k, false), at(N, k + 1, true), at(N, k, true)]);
    }
    let corners = |t: &[u32; 3]| t.map(|v| positions[v as usize]);
    let mut paint = Vec::new();
    for t in &triangles {
        let v = corners(t);
        let c = [
            (v[0][0] + v[1][0] + v[2][0]) / 3.0,
            (v[0][1] + v[1][1] + v[2][1]) / 3.0,
            (v[0][2] + v[1][2] + v[2][2]) / 3.0,
        ];
        let flat = v.iter().all(|p| (p[2] - v[0][2]).abs() < 1e-6);
        let (dx, dy) = (c[0] - w / 2.0, c[1] - w / 2.0);
        let ring = (dx * dx + dy * dy).sqrt() / 1.1;
        let code = if flat && c[2] < 0.1 {
            // Bottom: even rings, the cells near a ring's edge split in four with one quarter left plain.
            if (ring / 2.0).fract() < 0.5 && ring < 5.0 {
                if (ring - ring.round()).abs() < 0.25 {
                    "88083"
                } else {
                    "8"
                }
            } else {
                "0"
            }
        } else if flat {
            if (c[1] - w / 2.0).abs() < 1.5 { "0C" } else { "0" }
        } else if c[0] > w - 0.01 && c[1] < w / 2.0 {
            "8"
        } else {
            "0"
        };
        paint.extend(sx_core::paint::decode(code, v));
    }
    let mut bar = Vec::new();
    for z in [0.0, H / 2.0] {
        for (x, y) in [(3.0, 5.0), (9.0, 5.0), (9.0, 7.0), (3.0, 7.0)] {
            bar.push([x, y, z]);
        }
    }
    let mut bar_tris = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        bar_tris.push([k, n, 4 + n]);
        bar_tris.push([k, 4 + n, 4 + k]);
    }
    Mesh {
        name: "tile".into(),
        parts: vec![
            api::MeshPart {
                name: "tile".into(),
                slot: 1,
                positions,
                triangles,
                paint,
                ..api::MeshPart::default()
            },
            api::MeshPart {
                name: "bar".into(),
                slot: 2,
                positions: bar,
                triangles: bar_tris,
                ..api::MeshPart::default()
            },
        ],
    }
}
