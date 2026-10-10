// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Manual supports on a plate of several objects: the plate has enforcers when any object has them, so the
//! "has none" warning appears only when no object asks for support.

// Requests are built with `json!` at each call, so taking them by value reads best.
#![allow(clippy::needless_pass_by_value)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{self, Mesh, SliceRequest, SliceRun};

const NONE_WARNING: &str =
    "Manual supports print only where enforcers ask, and the plate has none, so none are printed";

/// A 20 mm box 6 mm tall, its bottom painted as a support enforcer when `enforced`.
fn cuboid(enforced: bool) -> api::MeshPart {
    let (x, y, z) = ([0.0f32, 20.0], [0.0f32, 20.0], [0.0f32, 6.0]);
    let mut positions = Vec::new();
    for zi in z {
        for (xi, yi) in [(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])] {
            positions.push([xi, yi, zi]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    let support_paint = if enforced {
        vec![sx_core::paint::PaintFacet {
            v: [positions[0], positions[2], positions[1]],
            state: 1,
        }]
    } else {
        Vec::new()
    };
    api::MeshPart {
        name: "box".into(),
        slot: 1,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint,
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
        paint_texts: Vec::new(),
    }
}

/// Two boxes with manual tree supports, "l" painted with an enforcer when `enforced`, "r" never and with
/// `right` as settings of its own.
fn two_boxes(enforced: bool, config: Value, right: Value) -> SliceRun {
    let painted = Arc::new(Mesh {
        name: "painted".into(),
        parts: vec![cuboid(enforced)],
    });
    let plain = Arc::new(Mesh {
        name: "plain".into(),
        parts: vec![cuboid(false)],
    });
    let mut cfg = json!({
        "brim_width": 0,
        "skirt_loops": 0,
        "extruder_clearance_radius": 20,
        "enable_support": "1",
        "support_type": "tree(manual)",
    });
    cfg.as_object_mut()
        .unwrap()
        .extend(config.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "l", "name": "left", "mesh": "painted", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 60,100,0,1]},
            {"id": "r", "name": "right", "mesh": "plain", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 140,100,0,1], "settings": right},
        ]},
        "config": cfg,
    }))
    .unwrap();
    common::run_request(&req, &move |name: &str| {
        Ok(if name == "painted" {
            painted.clone()
        } else {
            plain.clone()
        })
    })
    .unwrap()
}

fn warns_none(r: &SliceRun) -> bool {
    r.report.warnings.iter().any(|w| w.message == NONE_WARNING)
}

fn by_object() -> Value {
    json!({"print_sequence": "by object"})
}

fn by_layer() -> Value {
    json!({"print_sequence": "by layer"})
}

#[test]
fn an_object_with_painted_enforcers_means_the_plate_has_some() {
    // One object after another, as tangela prints: each object is a session of its own.
    assert!(!warns_none(&two_boxes(true, by_object(), json!({}))));
    // Layer by layer with settings of its own on one object, which also slices the objects apart.
    assert!(!warns_none(&two_boxes(
        true,
        by_layer(),
        json!({"wall_loops": "3"})
    )));
    // Layer by layer as one session.
    assert!(!warns_none(&two_boxes(true, by_layer(), json!({}))));
}

#[test]
fn a_plate_without_enforcers_still_warns() {
    assert!(warns_none(&two_boxes(false, by_object(), json!({}))));
    assert!(warns_none(&two_boxes(
        false,
        by_layer(),
        json!({"wall_loops": "3"})
    )));
    assert!(warns_none(&two_boxes(false, by_layer(), json!({}))));
}
