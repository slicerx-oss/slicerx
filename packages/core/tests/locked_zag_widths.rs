// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The locked zag skin and skeleton line widths read as every line width does: a plain number is mm and only a value
//! with a `%` sign is a percent of the nozzle. Bambu Lab A1 projects write them as "0.45", which was read as 0.45% of
//! the nozzle (0.002 mm), so the sparse infill printed no filament at all.

mod common;

use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;

use sx_core::api::{Mesh, SliceRequest};

/// A 20 mm square block, 6 mm tall, as an A1 project in locked zag (`tests/fixtures/a1-locked-zag.3mf`).
fn project() -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/a1-locked-zag.3mf")).unwrap()
}

/// The G-code of the project's block where the project places it (the middle of the plate), with its own settings over
/// `extra`.
fn slice(extra: &Value) -> String {
    let bytes = project();
    let mut config = sx_core::api::project_config(&bytes, "a1-locked-zag.3mf")
        .unwrap()
        .unwrap()
        .settings;
    if let Some(e) = extra.as_object() {
        config.extend(e.clone());
    }
    let mesh = Arc::new(sx_core::api::load_mesh(&bytes, "a1-locked-zag.3mf").unwrap());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{
            "id": "a", "name": "sq", "mesh": "a",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        }]},
        "config": config,
        // The A1's own start and end G-code, as its stock profile writes it.
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let run = common::run_request(&req, &|_: &str| -> sx_core::Result<Arc<Mesh>> {
        Ok(mesh.clone())
    })
    .unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// The widths the sparse infill's moves state (mm, rounded to 0.001 mm) and how many of its moves push filament.
fn sparse_widths(g: &str) -> (Vec<String>, usize) {
    let (mut on, mut widths, mut extruding) = (false, Vec::new(), 0);
    for l in g.lines() {
        if let Some(f) = l.strip_prefix(";TYPE:").or_else(|| l.strip_prefix("; FEATURE:")) {
            on = f.trim() == "Sparse infill";
            continue;
        }
        if !on {
            continue;
        }
        if let Some(w) = l
            .strip_prefix("; LINE_WIDTH:")
            .or_else(|| l.strip_prefix(";WIDTH:"))
        {
            let w = format!("{:.3}", w.trim().parse::<f64>().unwrap());
            if !widths.contains(&w) {
                widths.push(w);
            }
        } else if l.starts_with("G1 ")
            && l.split_whitespace().any(|w| {
                w.strip_prefix('E')
                    .and_then(|e| e.parse::<f64>().ok())
                    .is_some_and(|e| e > 0.0)
            })
        {
            extruding += 1;
        }
    }
    widths.sort();
    (widths, extruding)
}

#[test]
fn a1_locked_zag_prints_its_sparse_infill_at_the_project_widths() {
    // The project sets both widths to 0.45, as the A1's profiles write them.
    let (widths, extruding) = sparse_widths(&slice(&json!({})));
    assert!(extruding > 0, "no sparse infill prints: widths {widths:?}");
    assert_eq!(widths, ["0.450"], "sparse infill widths");
}

#[test]
fn locked_zag_widths_read_a_number_as_mm_and_a_percent_of_the_nozzle() {
    // The 0.4 mm nozzle: "100%" is 0.4 mm, a plain number (or its text) is mm, 0 is the automatic 1.125 times the nozzle.
    for (skin, skeleton, want) in [
        (json!("100%"), json!("100%"), vec!["0.400"]),
        (json!("110%"), json!("100%"), vec!["0.400", "0.440"]),
        (json!(0.42), json!("0.5"), vec!["0.420", "0.500"]),
        (json!(["0.45"]), json!(["120%"]), vec!["0.450", "0.480"]),
        (json!(0), json!("0.45"), vec!["0.450"]),
    ] {
        let g = slice(&json!({ "skin_infill_line_width": skin, "skeleton_infill_line_width": skeleton }));
        let (widths, extruding) = sparse_widths(&g);
        assert!(extruding > 0, "{skin} {skeleton}: no sparse infill prints");
        assert_eq!(widths, want, "{skin} {skeleton}");
    }
}
