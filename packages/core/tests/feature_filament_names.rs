// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Bambu Studio's names for the per-feature filaments (`sparse_infill_filament`, `wall_filament`,
//! `solid_infill_filament`) and the older `OrcaSlicer` and `PrusaSlicer` ones print the features on the filament they
//! name. The engine's defaults always hold our own names (`sparse_infill_filament_id` and the like), and the older
//! name was read only when ours was missing, so it never was: a Bambu Studio project with its infill on filament 2
//! printed in one color.
//!
//! The counts are Bambu Studio 2.8's for the same 20 mm cube on a two filament printer: 92 changes with the sparse
//! infill on filament 2 (one per layer that has sparse infill), 100 with the walls on 2 (one per layer), 10 with
//! the solid infill on 2 (the shell layers at the bottom and the top).

// Configs are built with `json!` at each call, so taking them by value reads best.
#![allow(clippy::needless_pass_by_value)]

use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, MeshPart, SliceRequest, SliceRun};

fn cuboid(lo: [f32; 3], hi: [f32; 3], name: &str) -> MeshPart {
    let positions = (0..8)
        .map(|i| {
            [
                if i & 1 == 0 { lo[0] } else { hi[0] },
                if i & 2 == 0 { lo[1] } else { hi[1] },
                if i & 4 == 0 { lo[2] } else { hi[2] },
            ]
        })
        .collect();
    MeshPart {
        name: name.into(),
        slot: 1,
        positions,
        triangles: vec![
            [0, 2, 1],
            [1, 2, 3],
            [4, 5, 6],
            [5, 7, 6],
            [0, 1, 4],
            [1, 5, 4],
            [2, 6, 3],
            [3, 6, 7],
            [0, 4, 2],
            [2, 4, 6],
            [1, 3, 5],
            [3, 7, 5],
        ],
        ..MeshPart::default()
    }
}

#[allow(
    clippy::needless_update,
    reason = "a mesh is gaining fields; the default keeps this test building either way"
)]
fn mesh(parts: Vec<MeshPart>) -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "m".into(),
        parts,
        ..Mesh::default()
    })
}

/// A 20 mm cube.
fn cube() -> Arc<Mesh> {
    mesh(vec![cuboid([0.0; 3], [20.0; 3], "cube")])
}

/// A T: a 10 x 10 x 8 mm column under a 30 x 10 x 2 mm slab, so each arm overhangs 10 mm.
fn tee() -> Arc<Mesh> {
    mesh(vec![
        cuboid([10.0, 0.0, 0.0], [20.0, 10.0, 8.0], "column"),
        cuboid([0.0, 0.0, 8.0], [30.0, 10.0, 10.0], "slab"),
    ])
}

/// Two filaments on a Bambu Lab printer, with a prime tower, as the Bambu Studio projects the counts come from.
fn two_filaments(extra: Value) -> Value {
    let mut c = json!({
        "printer_model": "Bambu Lab X2D",
        "filament_colour": ["#ff0000", "#00ff00"],
        "nozzle_temperature": [220, 225],
        "enable_prime_tower": true,
        "brim_width": 0,
        // Bambu Studio's 0.20 mm Standard shells and infill, so the layers with each feature are Studio's.
        "top_shell_layers": 5,
        "top_shell_thickness": 1.0,
        "bottom_shell_layers": 3,
        "sparse_infill_density": "15%",
        "sparse_infill_pattern": "grid",
    });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            c.insert(k.clone(), v.clone());
        }
    }
    c
}

/// One object of `m` on filament `slot`, with its own `settings`.
fn slice_on(m: Arc<Mesh>, config: Value, slot: u8, settings: Value) -> SliceRun {
    let names: BTreeMap<String, u8> = m.parts.iter().map(|p| (p.name.clone(), slot)).collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "a", "name": "a", "mesh": "m", "settings": settings, "slotOverrides": names,
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]}]},
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
}

fn slice(config: Value) -> SliceRun {
    slice_on(cube(), config, 1, json!({}))
}

/// The filament changes of the G-code (`T<n>` lines that change the tool) and the filaments (1-based) each feature
/// printed its extrusions with.
fn tools(run: &SliceRun) -> (usize, BTreeMap<String, BTreeSet<u8>>) {
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    let mut features = BTreeMap::<String, BTreeSet<u8>>::new();
    let (mut tool, mut feature, mut changes) = (None::<u8>, String::new(), 0);
    for l in g.lines() {
        if let Some(n) = l
            .strip_prefix('T')
            .and_then(|t| t.split_whitespace().next())
            .and_then(|n| n.parse::<u8>().ok())
        {
            if tool.is_some_and(|t| t != n) {
                changes += 1;
            }
            tool = Some(n);
        } else if let Some(f) = l.strip_prefix("; FEATURE: ").or_else(|| l.strip_prefix(";TYPE:")) {
            f.trim().clone_into(&mut feature);
        } else if (l.starts_with("G1 ") || l.starts_with("G2 ") || l.starts_with("G3 "))
            && (l.contains(" X") || l.contains(" Y"))
            && l.split_whitespace()
                .find_map(|w| w.strip_prefix('E'))
                .and_then(|e| e.parse::<f64>().ok())
                .is_some_and(|e| e > 0.0)
            && let Some(t) = tool
            && !matches!(feature.as_str(), "Custom" | "Prime tower" | "Wipe tower" | "")
        {
            features.entry(feature.clone()).or_default().insert(t + 1);
        }
    }
    (changes, features)
}

fn on(features: &BTreeMap<String, BTreeSet<u8>>, feature: &str) -> Vec<u8> {
    features
        .get(feature)
        .unwrap_or_else(|| panic!("no {feature}: {features:?}"))
        .iter()
        .copied()
        .collect()
}

#[test]
fn bambu_studios_sparse_infill_filament_moves_the_infill_as_a_string_or_a_number() {
    for v in [json!("2"), json!(2)] {
        let (changes, f) = tools(&slice(two_filaments(json!({"sparse_infill_filament": v}))));
        assert_eq!(changes, 92, "sparse_infill_filament {v}: {f:?}");
        assert_eq!(on(&f, "Sparse infill"), [2], "{v}");
        for other in [
            "Outer wall",
            "Inner wall",
            "Internal solid infill",
            "Top surface",
            "Bottom surface",
        ] {
            assert_eq!(on(&f, other), [1], "{other} with sparse_infill_filament {v}");
        }
    }
}

#[test]
fn an_objects_own_bambu_name_counts_too() {
    let run = slice_on(
        cube(),
        two_filaments(json!({})),
        1,
        json!({"sparse_infill_filament": "2"}),
    );
    let (changes, f) = tools(&run);
    assert_eq!(changes, 92, "{f:?}");
    assert_eq!(on(&f, "Sparse infill"), [2]);
}

#[test]
fn bambu_studios_wall_filament_is_both_walls() {
    let (changes, f) = tools(&slice(two_filaments(json!({"wall_filament": "2"}))));
    assert_eq!(changes, 100, "{f:?}");
    assert_eq!(on(&f, "Outer wall"), [2]);
    assert_eq!(on(&f, "Inner wall"), [2]);
    assert_eq!(on(&f, "Sparse infill"), [1]);
}

#[test]
fn bambu_studios_solid_infill_filament_takes_the_surfaces_along() {
    let (changes, f) = tools(&slice(two_filaments(json!({"solid_infill_filament": "2"}))));
    assert_eq!(changes, 10, "{f:?}");
    for feature in ["Internal solid infill", "Top surface", "Bottom surface"] {
        assert_eq!(on(&f, feature), [2], "{feature}");
    }
    assert_eq!(on(&f, "Sparse infill"), [1]);
    assert_eq!(on(&f, "Outer wall"), [1]);
}

#[test]
fn a_bambu_studio_one_is_filament_one_even_on_an_object_on_two() {
    let run = slice_on(
        cube(),
        two_filaments(json!({"sparse_infill_filament": "1"})),
        2,
        json!({}),
    );
    let (changes, f) = tools(&run);
    assert_eq!(changes, 92, "{f:?}");
    assert_eq!(on(&f, "Sparse infill"), [1]);
    assert_eq!(on(&f, "Outer wall"), [2]);
    // 0 is the object's own filament
    let run = slice_on(
        cube(),
        two_filaments(json!({"sparse_infill_filament": "0"})),
        2,
        json!({}),
    );
    assert_eq!(tools(&run).0, 0);
}

#[test]
fn prusaslicers_extruder_keys_are_read_with_one_as_the_objects_own() {
    let (changes, f) = tools(&slice(two_filaments(json!({"infill_extruder": 2}))));
    assert!(changes > 0, "{f:?}");
    assert_eq!(on(&f, "Sparse infill"), [2]);
    let run = slice_on(cube(), two_filaments(json!({"infill_extruder": 1})), 2, json!({}));
    assert_eq!(tools(&run).0, 0, "infill_extruder 1 is the object's own filament");
}

#[test]
fn an_unset_support_interface_prints_with_the_objects_filament() {
    // Bambu Studio 2.8: support on filament 2 and no interface filament puts the interface on the object's.
    let cfg = |extra: Value| {
        let mut c = two_filaments(json!({"enable_support": true, "support_type": "normal(auto)",
            "independent_support_layer_height": false}));
        if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
            c.extend(e.clone());
        }
        c
    };
    let (_, f) = tools(&slice_on(
        tee(),
        cfg(json!({"support_filament": "2"})),
        1,
        json!({}),
    ));
    assert_eq!(on(&f, "Support"), [2], "{f:?}");
    assert_eq!(on(&f, "Support interface"), [1], "{f:?}");
    let (_, f) = tools(&slice_on(
        tee(),
        cfg(json!({"support_filament": "1"})),
        2,
        json!({}),
    ));
    assert_eq!(on(&f, "Support"), [1], "{f:?}");
    assert_eq!(on(&f, "Support interface"), [2], "{f:?}");
    // An interface filament of its own still wins.
    let (_, f) = tools(&slice_on(
        tee(),
        cfg(json!({"support_interface_filament": 2})),
        1,
        json!({}),
    ));
    assert_eq!(on(&f, "Support"), [1], "{f:?}");
    assert_eq!(on(&f, "Support interface"), [2], "{f:?}");
}

#[test]
fn the_older_names_are_not_reported_as_unused() {
    let m = cube();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "a", "mesh": "m", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]}]},
        "config": two_filaments(json!({"sparse_infill_filament": "2", "wall_filament": "0", "infill_extruder": 1})),
        "options": {"trustedGcode": true, "configReport": true},
    }))
    .unwrap();
    let run = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    let report = run.report.config_report.as_ref().expect("a report");
    for key in ["sparse_infill_filament", "wall_filament", "infill_extruder"] {
        assert!(
            !report.not_applied.iter().any(|k| k == key),
            "{key}: {:?}",
            report.not_applied
        );
    }
}
