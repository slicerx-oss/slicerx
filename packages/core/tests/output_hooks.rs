// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Output options: `gcode_add_line_number`, `notes` and the extrusion role change G-code.

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{self, Mesh, SliceRequest};

fn cuboid() -> api::MeshPart {
    let (x, y, z) = ([0.0f32, 12.0], [0.0f32, 12.0], [0.0f32, 1.0]);
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
    api::MeshPart {
        name: "box".into(),
        slot: 1,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint: Vec::new(),
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
        paint_texts: Vec::new(),
    }
}

fn slice(config: &Value) -> String {
    let mesh = Arc::new(Mesh {
        name: "box".into(),
        parts: vec![cuboid()],
    });
    let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "sparse_infill_density": 15});
    cfg.as_object_mut()
        .unwrap()
        .extend(config.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 118,118,0,1]}]},
        "config": cfg,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

#[test]
fn line_numbers_count_the_commands() {
    let plain = slice(&json!({}));
    let g = slice(&json!({"gcode_add_line_number": true}));
    let mut n = 0u64;
    let mut stripped = Vec::new();
    for line in g.lines() {
        let body = line.trim_start();
        if body.is_empty() || body.starts_with(';') {
            stripped.push(line.to_owned());
            continue;
        }
        n += 1;
        let prefix = format!("N{n} ");
        assert!(line.starts_with(&prefix), "line {n} reads {line:?}");
        stripped.push(line.get(prefix.len()..).unwrap().to_owned());
    }
    assert!(n > 100);
    assert_eq!(stripped.join("\n"), plain.lines().collect::<Vec<_>>().join("\n"));
}

#[test]
fn notes_are_header_comments_only() {
    let g = slice(&json!({"notes": "first note\nsecond\rM104 S300"}));
    let head: Vec<&str> = g.lines().take(12).collect();
    assert!(head.contains(&"; notes: first note"), "{head:?}");
    assert!(head.contains(&"; notes: second M104 S300"), "{head:?}");
    assert!(!g.lines().any(|l| l.trim_start().starts_with("M104 S300")));
}

#[test]
fn role_change_gcode_comes_before_each_new_feature() {
    let g = slice(&json!({
        "process_change_extrusion_role_gcode": "; role {extrusion_role} after {last_extrusion_role} on {layer_num}",
        "change_extrusion_role_gcode": "; machine [extrusion_role]",
    }));
    let lines: Vec<&str> = g.lines().collect();
    let types: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with(";TYPE:"))
        .map(|(i, _)| i)
        .collect();
    assert!(types.len() > 5);
    for &i in &types {
        let machine = lines.get(i - 2).copied().unwrap_or_default();
        let process = lines.get(i - 1).copied().unwrap_or_default();
        assert!(
            machine.starts_with("; machine "),
            "{machine:?} before {:?}",
            lines[i]
        );
        assert!(
            process.starts_with("; role "),
            "{process:?} before {:?}",
            lines[i]
        );
    }
    assert!(
        g.contains("; role ExternalPerimeter after Perimeter on 1\n;TYPE:Outer wall"),
        "first layer walls"
    );
    assert!(g.contains("; role BottomSurface after"), "bottom surface");
}

#[test]
fn filename_format_names_the_file_in_the_report() {
    let mesh = Arc::new(Mesh {
        name: "box".into(),
        parts: vec![cuboid()],
    });
    let run = |config: Value, options: Value| {
        let mesh = mesh.clone();
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"name": "Box part.stl", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 118,118,0,1]}]},
            "config": config,
            "options": options,
        }))
        .unwrap();
        common::run_request(&req, &move |_: &str| Ok(mesh.clone()))
            .unwrap()
            .report
    };
    // Orca's default format: the part, the first filament's type and the time.
    let r = run(json!({"filament_type": ["PETG"]}), json!({}));
    let name = r.file_name.unwrap();
    assert!(
        name.starts_with("Box part_PETG_") && name.ends_with("s.gcode"),
        "{name}"
    );
    let r = run(
        json!({"filename_format": "{model_name} plate {plate_number} {plate_name} {total_weight}g"}),
        json!({"plateName": "Left", "plateNumber": 2, "modelName": "Kit"}),
    );
    let g = r.stats.filament_g.iter().sum::<f64>();
    let name = r.file_name.unwrap();
    assert!(
        name.starts_with("Kit plate 02 Left ") && name.ends_with("g.gcode"),
        "{name}"
    );
    let shown: f64 = name
        .trim_start_matches("Kit plate 02 Left ")
        .trim_end_matches("g.gcode")
        .parse()
        .unwrap();
    assert!((shown - g).abs() < 0.01, "{shown} {g}");
    // A format that does not render leaves no name and says why.
    let r = run(json!({"filename_format": "{nope"}), json!({}));
    assert!(r.file_name.is_none());
    assert!(
        r.warnings
            .iter()
            .any(|w| w.message.starts_with("filename_format"))
    );
}
