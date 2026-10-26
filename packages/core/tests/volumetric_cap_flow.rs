// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `filament_max_volumetric_speed` holds the rate a path really extrudes. On a printer other than Bambu Lab the
//! limit divides by every flow multiplier the extrusion carries (the filament's flow ratio, the print flow ratio
//! and the role ratios), so a capped path pushes exactly the limit. On a Bambu Lab printer it divides by the print
//! flow ratio alone, so a capped path pushes the limit times the filament's flow ratio.

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn base_config() -> Value {
    let bench: Value = serde_json::from_slice(
        &std::fs::read(format!(
            "{}/packages/core/bench/configs/reference-0.20.json",
            root()
        ))
        .unwrap(),
    )
    .unwrap();
    bench["config"].clone()
}

/// The G-code of the reference X under `extra` settings, every print speed at 300 mm/s.
fn gcode(extra: &Value) -> String {
    let mut c = base_config();
    for k in [
        "outer_wall_speed",
        "inner_wall_speed",
        "sparse_infill_speed",
        "internal_solid_infill_speed",
        "top_surface_speed",
        "gap_infill_speed",
    ] {
        c[k] = json!(300);
    }
    if let (Some(m), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        m.extend(e.clone());
    }
    let req: SliceRequest =
        serde_json::from_value(json!({ "plate": {"objects": [{"mesh": "x"}]}, "config": c, "options": {} }))
            .unwrap();
    let bytes = std::fs::read(format!("{}/packages/core/bench/models/x-mark.stl", root())).unwrap();
    let m = Arc::new(Mesh::load(&bytes, "x-mark.stl").unwrap());
    let run = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// Per feature, above the first layer: the highest mm3/s any extrusion move of 1 mm or more commands (feed times
/// E per mm times the 1.75 mm filament's cross-section).
fn rates(text: &str) -> Vec<(String, f64)> {
    let area = std::f64::consts::PI * 0.875 * 0.875;
    let (mut at, mut feed, mut relative, mut last_e) = ([f64::NAN; 2], 0.0, true, 0.0);
    let (mut feature, mut layer) = (String::new(), 0usize);
    let mut top: std::collections::BTreeMap<String, f64> = std::collections::BTreeMap::new();
    for line in text.lines() {
        if let Some(name) = line
            .strip_prefix(";TYPE:")
            .or_else(|| line.strip_prefix("; FEATURE:"))
        {
            feature = name.trim().to_string();
            continue;
        }
        if line.starts_with(";LAYER_CHANGE") || line.starts_with("; CHANGE_LAYER") {
            layer += 1;
            continue;
        }
        if line.starts_with("M82") {
            relative = false;
        } else if line.starts_with("M83") {
            relative = true;
        }
        let body = line.split(';').next().unwrap_or("");
        if body.starts_with("G92") {
            last_e = 0.0;
        }
        if !(body.starts_with("G1 ") || body.starts_with("G0 ")) {
            continue;
        }
        let (mut to, mut extrude) = (at, None);
        for word in body.split_whitespace().skip(1) {
            let value: f64 = word.get(1..).and_then(|v| v.parse().ok()).unwrap_or(f64::NAN);
            match word.as_bytes().first() {
                Some(b'X') => to[0] = value,
                Some(b'Y') => to[1] = value,
                Some(b'F') => feed = value / 60.0,
                Some(b'E') => extrude = Some(value),
                _ => {}
            }
        }
        let de = match extrude {
            Some(v) if relative => v,
            Some(v) => {
                let d = v - last_e;
                last_e = v;
                d
            }
            None => 0.0,
        };
        let (dx, dy) = (to[0] - at[0], to[1] - at[1]);
        let len = (dx * dx + dy * dy).sqrt();
        if layer > 1 && de > 0.0 && len >= 1.0 && feed > 0.0 {
            let q = feed * de / len * area;
            let most = top.entry(feature.clone()).or_insert(0.0);
            *most = most.max(q);
        }
        at = to;
    }
    top.into_iter().collect()
}

fn rate(rows: &[(String, f64)], feature: &str) -> f64 {
    rows.iter()
        .find(|(f, _)| f == feature)
        .map_or_else(|| panic!("no {feature} in {rows:?}"), |r| r.1)
}

#[test]
fn a_capped_path_pushes_the_limit_on_a_printer_other_than_bambu_lab() {
    for (flow, extra) in [
        (0.9, json!({})),
        (1.05, json!({})),
        (0.98, json!({ "print_flow_ratio": "0.95" })),
    ] {
        let mut c =
            json!({ "filament_max_volumetric_speed": ["3"], "filament_flow_ratio": [flow.to_string()] });
        if let (Some(m), Some(e)) = (c.as_object_mut(), extra.as_object()) {
            m.extend(e.clone());
        }
        let rows = rates(&gcode(&c));
        for f in ["Outer wall", "Inner wall", "Sparse infill"] {
            let q = rate(&rows, f);
            assert!(
                (q - 3.0).abs() < 3.0 * 0.005,
                "flow {flow} {extra}: {f} at {q} mm3/s"
            );
        }
        for (f, q) in &rows {
            assert!(
                *q < 3.0 * 1.005,
                "flow {flow} {extra}: {f} at {q} mm3/s, over the limit"
            );
        }
    }
}

#[test]
fn a_capped_path_on_a_bambu_lab_printer_pushes_the_limit_times_the_filament_flow_ratio() {
    for extra in [json!({}), json!({ "print_flow_ratio": "0.95" })] {
        let mut c = json!({ "filament_max_volumetric_speed": ["3"], "filament_flow_ratio": ["0.98"],
            "printer_model": "Bambu Lab P1S" });
        if let (Some(m), Some(e)) = (c.as_object_mut(), extra.as_object()) {
            m.extend(e.clone());
        }
        let rows = rates(&gcode(&c));
        for f in ["Outer wall", "Inner wall", "Sparse infill"] {
            let q = rate(&rows, f);
            assert!((q - 2.94).abs() < 2.94 * 0.005, "{extra}: {f} at {q} mm3/s");
        }
    }
}
