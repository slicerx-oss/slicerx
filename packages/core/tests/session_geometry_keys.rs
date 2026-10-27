// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Settings that shape walls, infill, bridges, brims or the prime tower, or that a session reads when it is built,
//! are part of the session key ([`api::session_key`]): a host prepares a new session when one changes, and slicing
//! the edited request gives what a cold slice of it gives.

#![allow(clippy::disallowed_methods, reason = "test geometry, not engine output")]

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

/// A binary STL of `tris`.
fn stl(tris: &[[[f32; 3]; 3]]) -> Vec<u8> {
    let mut bytes = vec![0u8; 80];
    bytes.extend_from_slice(&u32::try_from(tris.len()).unwrap().to_le_bytes());
    for t in tris {
        bytes.extend_from_slice(&[0u8; 12]);
        for p in t {
            for v in p {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
        }
        bytes.extend_from_slice(&[0, 0]);
    }
    bytes
}

/// A round peg `r` mm in radius and `h` mm tall with a round hole of radius `hole` through it, in `n` facets
/// around: walls that the wall deviation and resolution simplify.
fn ring(r: f32, hole: f32, h: f32, n: usize) -> Arc<Mesh> {
    #[allow(clippy::cast_precision_loss, reason = "a few hundred facets")]
    let at = |rad: f32, k: usize, z: f32| -> [f32; 3] {
        let a = std::f32::consts::TAU * (k % n) as f32 / n as f32;
        [rad * a.cos(), rad * a.sin(), z]
    };
    let mut tris = Vec::new();
    for k in 0..n {
        let (o0, o1, o0t, o1t) = (at(r, k, 0.0), at(r, k + 1, 0.0), at(r, k, h), at(r, k + 1, h));
        let (i0, i1, i0t, i1t) = (
            at(hole, k, 0.0),
            at(hole, k + 1, 0.0),
            at(hole, k, h),
            at(hole, k + 1, h),
        );
        tris.extend([
            [o0, o1, o1t],
            [o0, o1t, o0t],
            [i1, i0, i0t],
            [i1, i0t, i1t],
            [o0t, o1t, i1t],
            [o0t, i1t, i0t],
            [o1, o0, i0],
            [o1, i0, i1],
        ]);
    }
    Arc::new(Mesh::load(&stl(&tris), "ring.stl").unwrap())
}

/// A box `w` x `d` x `h` mm with its corner at the origin.
fn block(w: f32, d: f32, h: f32) -> Arc<Mesh> {
    let p = |x: f32, y: f32, z: f32| [x * w, y * d, z * h];
    let quad = |a: [f32; 3], b: [f32; 3], c: [f32; 3], e: [f32; 3]| [[a, b, c], [a, c, e]];
    let mut tris = Vec::new();
    for q in [
        quad(
            p(0.0, 0.0, 0.0),
            p(0.0, 1.0, 0.0),
            p(1.0, 1.0, 0.0),
            p(1.0, 0.0, 0.0),
        ),
        quad(
            p(0.0, 0.0, 1.0),
            p(1.0, 0.0, 1.0),
            p(1.0, 1.0, 1.0),
            p(0.0, 1.0, 1.0),
        ),
        quad(
            p(0.0, 0.0, 0.0),
            p(1.0, 0.0, 0.0),
            p(1.0, 0.0, 1.0),
            p(0.0, 0.0, 1.0),
        ),
        quad(
            p(1.0, 0.0, 0.0),
            p(1.0, 1.0, 0.0),
            p(1.0, 1.0, 1.0),
            p(1.0, 0.0, 1.0),
        ),
        quad(
            p(1.0, 1.0, 0.0),
            p(0.0, 1.0, 0.0),
            p(0.0, 1.0, 1.0),
            p(1.0, 1.0, 1.0),
        ),
        quad(
            p(0.0, 1.0, 0.0),
            p(0.0, 0.0, 0.0),
            p(0.0, 0.0, 1.0),
            p(0.0, 1.0, 1.0),
        ),
    ] {
        tris.extend(q);
    }
    Arc::new(Mesh::load(&stl(&tris), "block.stl").unwrap())
}

/// A plate to edit: its request and its one mesh, which every object of it uses.
struct Plate {
    req: SliceRequest,
    mesh: Arc<Mesh>,
}

impl Plate {
    /// `objects` (x, y, turn about Z in degrees) of `mesh` with `config` over the request test base.
    fn new(mesh: Arc<Mesh>, objects: &[(f32, f32, f32)], config: &Value) -> Self {
        let specs: Vec<Value> = objects
            .iter()
            .enumerate()
            .map(|(k, &(x, y, deg))| {
                let (s, c) = deg.to_radians().sin_cos();
                json!({"id": format!("o{k}"), "name": format!("o{k}"), "mesh": "m", "transform": [
                    c, s, 0.0, 0.0, -s, c, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, 0.0, 1.0
                ]})
            })
            .collect();
        let req = serde_json::from_value(json!({
            "plate": {"objects": specs},
            "config": common::with_base(config),
            "options": {"flavor": "marlin2", "nowUnix": 1_790_000_000, "nowOffsetMinutes": 0},
        }))
        .unwrap();
        Self { req, mesh }
    }

    /// The ring with aegis walls (the default generator; the test base uses classic).
    fn round() -> Self {
        Self::new(
            ring(12.0, 4.0, 1.6, 180),
            &[(128.0, 128.0, 0.0)],
            &json!({"wall_generator": "aegis", "layer_height": 0.2, "wall_loops": 3}),
        )
    }

    /// Two blocks turned apart about Z, printed layer by layer.
    fn turned() -> Self {
        Self::new(
            block(20.0, 20.0, 3.0),
            &[(70.0, 110.0, 0.0), (150.0, 110.0, 30.0)],
            &json!({"sparse_infill_density": "25%"}),
        )
    }

    fn key(&self, req: &SliceRequest) -> Option<u64> {
        api::session_key(req, &|_| Some(self.mesh.content_hash()))
    }
}

/// The settings the session key leaves out no more: each shapes a path or is read when a session is built.
const KEYED: &[&str] = &[
    // Walls and gap fill.
    "wall_maximum_deviation",
    "wall_maximum_resolution",
    "min_length_factor",
    "initial_layer_min_bead_width",
    "min_width_top_surface",
    "line_width",
    "gap_fill_target",
    "filter_out_gap_fill",
    // Infill.
    "top_bottom_infill_wall_overlap",
    "elefant_foot_layers_density",
    "gyroid_optimized",
    "align_infill_direction_to_model",
    // Bridges.
    "bridge_flow",
    "thick_internal_bridges",
    "dont_filter_internal_bridges",
    "relative_bridge_angle",
    "enable_extra_bridge_layer",
    "counterbore_hole_bridging",
    // Brims, the skirt, the prime tower, seams, wall direction and the collision model.
    "combine_brims",
    "filament_diameter",
    "single_extruder_multi_material_priming",
    "filament_minimal_purge_on_wipe_tower",
    "filament_change_length",
    "filament_change_length_nc",
    "filament_multitool_ramming",
    "filament_multitool_ramming_volume",
    "enable_filament_ramming",
    "wall_direction",
    "scarf_angle_threshold",
    "scarf_overhang_threshold",
    "extruder_clearance_max_radius",
    "extruder_clearance_dist_to_rod",
    "extruder_clearance_height_to_lid",
    "extruder_clearance_height_to_rod",
    "nozzle_height",
    // The filament map and extruder variants a session is built with.
    "extruder_max_nozzle_count",
    "master_extruder_id",
    "print_extruder_id",
    "printer_extruder_id",
    "extruder_type",
];

/// A setting, the plate that shows an edit of it and the edited value.
type Edit = (&'static str, fn() -> Plate, Value);

/// Each setting a kept session must not outlive, the plate that shows it and a value other than the plate's.
fn edits() -> Vec<Edit> {
    vec![
        ("wall_maximum_deviation", Plate::round, json!(0.005)),
        ("wall_maximum_resolution", Plate::round, json!(0.05)),
        ("align_infill_direction_to_model", Plate::turned, json!(true)),
    ]
}

/// A host keeps the session of the plate (prepared and sliced once) while the session key stays the same, and
/// prepares a new one when it changes. Either way, the edited request slices to a cold slice's G-code, and the edit
/// changes the G-code on its plate (or it would test nothing).
#[test]
fn an_edit_on_a_kept_session_slices_as_a_cold_slice() {
    let mut stale = Vec::new();
    for (key, plate, value) in edits() {
        let p = plate();
        let load = |_: &str| Ok(p.mesh.clone());
        let prepared = api::prepare(&p.req, &load).unwrap();
        let before = api::run_prepared(&p.req, &prepared, &sx_core::NoProgress).unwrap();
        let mut edited = p.req.clone();
        edited.config[key] = value;
        let cold = api::run_request(&edited, &load).unwrap();
        assert!(
            cold.gcode != before.gcode,
            "{key}: the edit changes nothing on its plate"
        );
        let host = if p.key(&edited) == p.key(&p.req) {
            api::run_prepared(&edited, &prepared, &sx_core::NoProgress).unwrap()
        } else {
            let fresh = api::prepare(&edited, &load).unwrap();
            api::run_prepared(&edited, &fresh, &sx_core::NoProgress).unwrap()
        };
        if host.gcode != cold.gcode {
            stale.push(key);
        }
    }
    assert!(
        stale.is_empty(),
        "a kept session slices these edits stale: {stale:?}"
    );
}

/// The settings that change what a session builds or the paths it slices are no session free settings, and the
/// session key changes with each.
#[test]
fn the_session_key_holds_each_geometry_setting() {
    let p = Plate::round();
    let mut left_out: Vec<&str> = KEYED
        .iter()
        .copied()
        .filter(|k| api::SESSION_FREE_KEYS.contains(k))
        .collect();
    for &key in KEYED {
        let mut edited = p.req.clone();
        edited.config[key] = json!(12_345);
        if p.key(&edited) == p.key(&p.req) && !left_out.contains(&key) {
            left_out.push(key);
        }
    }
    assert!(left_out.is_empty(), "left out of the session key: {left_out:?}");
}
