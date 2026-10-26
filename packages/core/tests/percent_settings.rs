// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Percent settings sent as text with a `%` sign, the way projects and printer presets write them ("60%"), slice
//! the same as the plain number the app sends (60). The locked zag skin and skeleton densities used to drop the
//! text and fall back to their 25% defaults.

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{Mesh, MeshPart, SliceRequest};

/// A 20 mm cube, 6 mm tall.
fn block() -> Arc<Mesh> {
    let mut positions = Vec::new();
    for z in [0.0, 6.0] {
        for (x, y) in [(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)] {
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
        name: "block".into(),
        parts: vec![MeshPart {
            name: "block".into(),
            slot: 1,
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

/// The G-code of the cube in locked zag at 40% over `extra` settings.
fn locked_zag(extra: &Value) -> String {
    let mut c = json!({
        "sparse_infill_pattern": "lockedzag",
        "sparse_infill_density": "40%",
        "brim_width": 0,
    });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{
            "id": "a", "name": "a", "mesh": "a",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 110, 110, 0, 1],
        }]},
        "config": c,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let run = common::run_request(&req, &|_: &str| Ok(block())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// The sparse infill moves only: the configuration block at the end lists the settings as they were sent.
fn sparse(g: &str) -> String {
    let mut on = false;
    let mut out = String::new();
    for l in g.lines() {
        if let Some(f) = l.strip_prefix(";TYPE:").or_else(|| l.strip_prefix("; FEATURE:")) {
            on = f.trim() == "Sparse infill";
        } else if on && l.starts_with("G1 ") {
            out.push_str(l);
            out.push('\n');
        }
    }
    out
}

fn reads_as_its_number(key: &str) {
    let default = sparse(&locked_zag(&json!({})));
    let text = sparse(&locked_zag(&json!({ key: "60%" })));
    let number = sparse(&locked_zag(&json!({ key: 60 })));
    assert!(!number.is_empty(), "no sparse infill");
    assert_ne!(number, default, "{key} 60 prints like the default");
    assert_eq!(text, number, "{key} \"60%\" prints unlike 60");
    let list = sparse(&locked_zag(&json!({ key: ["60%"] })));
    assert_eq!(list, number, "{key} [\"60%\"] prints unlike 60");
}

#[test]
fn locked_zag_skin_density_reads_a_percent_sign() {
    reads_as_its_number("skin_infill_density");
}

#[test]
fn locked_zag_skeleton_density_reads_a_percent_sign() {
    reads_as_its_number("skeleton_infill_density");
}
