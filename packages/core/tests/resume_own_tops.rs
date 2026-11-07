// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A resume of a plate with its own layer heights, planned and sliced for real: the resume planner counts layers in
//! the tops the slice prints (the plate's own, stretched by a Z shrinkage as the slice stretches them), so the last
//! layer left on the bed ends at the measured height, within half a layer, and the resumed G-code starts on the next.

use serde_json::{Value, json};
use std::sync::Arc;

mod common;

use sx_core::api::{self, Mesh, SliceRequest, SliceRun};
use sx_geom::mesh::TriMesh;
use sx_geom::resume::{ResumeRequest, plan};

const MEASURED: f64 = 5.0;

/// The corners and triangles of a 10 mm box on the bed.
fn corners() -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    let mut positions = Vec::new();
    for z in [0.0, 10.0] {
        for (x, y) in [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)] {
            positions.push([x, y, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    (positions, triangles)
}

fn mesh() -> Mesh {
    let (positions, triangles) = corners();
    Mesh {
        name: "box".into(),
        parts: vec![api::MeshPart {
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
        }],
        ..Mesh::default()
    }
}

/// The plate's own tops: a 0.2 mm first layer, then 0.1 mm layers to the 10 mm top, on a `layer_height` of 0.2.
fn own_tops() -> Vec<f64> {
    let mut tops = vec![0.2];
    while tops.last().copied().unwrap_or(0.0) < 10.0 - 1e-9 {
        let next: f64 = tops.last().copied().unwrap_or(0.0) + 0.1;
        tops.push((next * 1e4).round() / 1e4);
    }
    tops
}

/// The tops stretched to a Z scale of `fz` as the app plans them: the first layer kept, the last on last x fz.
fn stretched(tops: &[f64], fz: f64) -> Vec<f64> {
    let (first, last) = (tops[0], tops[tops.len() - 1]);
    let k = (last * fz - first) / (last - first);
    tops.iter().map(|t| first + (t - first) * k).collect()
}

fn slice(config: &Value, options: &Value) -> SliceRun {
    let m = Arc::new(mesh());
    let mut cfg = json!({"brim_width": 0, "layer_height": 0.2, "initial_layer_print_height": 0.2, "min_layer_height": [0.08], "max_layer_height": [0.28]});
    if let (Some(base), Some(extra)) = (cfg.as_object_mut(), config.as_object()) {
        base.extend(extra.clone());
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "a", "mesh": "box", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": cfg,
        "options": options.clone(),
    }))
    .unwrap();
    common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
}

fn layer_z(run: &SliceRun) -> Vec<f64> {
    run.report.layer_z.iter().map(|&v| f64::from(v)).collect()
}

/// The Z of every layer the G-code prints.
fn printed_zs(run: &SliceRun) -> Vec<f64> {
    String::from_utf8(run.gcode.clone())
        .unwrap()
        .lines()
        .filter_map(|l| l.strip_prefix(";Z:"))
        .map(|v| v.parse().unwrap())
        .collect()
}

fn plan_layer(tops: Option<Vec<f64>>) -> (u32, f64) {
    let (positions, triangles) = corners();
    let box_mesh = TriMesh::from_f32(&positions, &triangles).unwrap();
    let p = plan(
        &box_mesh,
        &ResumeRequest {
            measured_height_mm: Some(MEASURED),
            layer_height_mm: 0.2,
            first_layer_height_mm: 0.2,
            layer_tops_mm: tops,
            include_remaining_mesh: false,
            ..ResumeRequest::default()
        },
    )
    .unwrap();
    (p.resume_layer, p.printed_height_mm)
}

#[test]
fn a_resume_planned_in_the_plate_own_tops_slices_from_the_measured_height() {
    // As planned and sliced with no current slice: the plan counts in the own tops (stretched for 99.5 percent), the
    // slice sends the drawn tops, exact and unmarked, from that layer.
    for (config, fz) in [
        (json!({}), 1.0),
        (
            json!({"filament_shrinkage_compensation_z": ["99.5%"]}),
            100.0 / 99.5,
        ),
    ] {
        let tops = own_tops();
        let (r, printed) = plan_layer(Some(stretched(&tops, fz)));
        let at = usize::try_from(r).unwrap();
        let resumed = slice(
            &config,
            &json!({"flavor": "marlin2", "layerTopsMm": tops, "layerTopsExact": true, "resumeFromLayer": r}),
        );
        let z = layer_z(&resumed);
        assert_eq!(z.len(), tops.len(), "{config}");
        // The last layer left on the bed ends at the measured height, within half a 0.1 mm layer, where the plan said.
        assert!(
            (z[at - 1] - MEASURED).abs() <= 0.05 + 1e-4,
            "{config}: resume from layer {r}, the bed holds {} mm",
            z[at - 1]
        );
        assert!(
            (z[at - 1] - printed).abs() < 1e-4,
            "{config}: {} vs {printed}",
            z[at - 1]
        );
        // The G-code starts on the next layer and prints the rest.
        let g = printed_zs(&resumed);
        assert_eq!(g.len(), z.len() - at, "{config}");
        assert!(
            (g[0] - z[at]).abs() < 1e-3,
            "{config}: first Z {} vs {}",
            g[0],
            z[at]
        );
        assert!(
            g[0] > MEASURED && g[0] - MEASURED <= 0.1 + 0.05,
            "{config}: first Z {}",
            g[0]
        );
    }
}

#[test]
fn a_resume_planned_in_even_layers_lands_far_from_the_measured_height() {
    // The plan before the fix, in even 0.2 mm layers, picks layer 25: in the plate's own tops that is 2.6 mm up.
    let tops = own_tops();
    let (r, _) = plan_layer(None);
    assert_eq!(r, 25);
    let resumed = slice(
        &json!({}),
        &json!({"flavor": "marlin2", "layerTopsMm": tops, "layerTopsExact": true, "resumeFromLayer": r}),
    );
    let z = layer_z(&resumed);
    assert!(
        (z[usize::try_from(r).unwrap() - 1] - MEASURED).abs() > 2.0,
        "{}",
        z[24]
    );
}
