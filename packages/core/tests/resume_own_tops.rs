// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A resume of a plate with its own layer heights, planned and sliced for real, as the app does it when it has no
//! current slice: the job's layers come from the engine (the same request with no resume), the resume planner
//! counts in them, and the resume sends them back as the job's (exact and sliced). The last layer left on the bed
//! then ends at the measured height, within half a layer, and the resumed G-code starts on the next, also where a Z
//! shrinkage stretches the plate and some layers sit at the printer's maximum layer height.

use serde_json::{Value, json};
use std::sync::Arc;

mod common;

use sx_core::api::{self, Mesh, SliceRequest, SliceRun};
use sx_geom::mesh::TriMesh;
use sx_geom::resume::{ResumeRequest, plan};

/// The corners and triangles of a 10 x 10 mm box `h` mm tall on the bed.
fn corners(h: f32) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    let mut positions = Vec::new();
    for z in [0.0, h] {
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

fn mesh(h: f32) -> Mesh {
    let (positions, triangles) = corners(h);
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

/// Tops of a 0.2 mm first layer, then `n` layers of each height in `runs`, kept to 0.1 micron.
fn tops_of(runs: &[(f64, usize)]) -> Vec<f64> {
    let mut tops = vec![0.2];
    for &(h, n) in runs {
        for _ in 0..n {
            let next: f64 = tops.last().copied().unwrap_or(0.0) + h;
            tops.push((next * 1e4).round() / 1e4);
        }
    }
    tops
}

fn slice(h: f32, config: &Value, options: &Value) -> SliceRun {
    let m = Arc::new(mesh(h));
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

/// The resume planner's layer for `measured` mm on a box `h` mm tall, counting in `tops` (even layers without).
fn plan_layer(h: f32, measured: f64, tops: Option<Vec<f64>>) -> (u32, f64) {
    let (positions, triangles) = corners(h);
    let box_mesh = TriMesh::from_f32(&positions, &triangles).unwrap();
    let p = plan(
        &box_mesh,
        &ResumeRequest {
            measured_height_mm: Some(measured),
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

/// Slices the job (the plate's own tops, exact), plans a resume at `measured` in its layers and slices the resume
/// with them, exact and sliced. Returns the job's layers, the resume layer and the resumed run.
fn resume_in_job_layers(h: f32, config: &Value, own: &[f64], measured: f64) -> (Vec<f64>, usize, SliceRun) {
    let job = layer_z(&slice(
        h,
        config,
        &json!({"flavor": "marlin2", "layerTopsMm": own, "layerTopsExact": true}),
    ));
    let (r, printed) = plan_layer(h, measured, Some(job.clone()));
    let resumed = slice(
        h,
        config,
        &json!({"flavor": "marlin2", "layerTopsMm": job, "layerTopsExact": true, "layerTopsSliced": true, "resumeFromLayer": r}),
    );
    let at = usize::try_from(r).unwrap();
    let z = layer_z(&resumed);
    assert!(
        (z[at - 1] - printed).abs() < 1e-4,
        "{config}: {} vs {printed}",
        z[at - 1]
    );
    (job, at, resumed)
}

/// Every layer is the job's; the last on the bed ends within half its thickness of `measured`; the G-code prints the
/// rest from the next.
fn assert_lands(config: &Value, job: &[f64], at: usize, resumed: &SliceRun, measured: f64) {
    let z = layer_z(resumed);
    assert_eq!(z.len(), job.len(), "{config}");
    for (i, (a, b)) in z.iter().zip(job).enumerate() {
        assert!(
            (a - b).abs() < 1e-4,
            "{config}: layer {i} at {a}, the job had {b}"
        );
    }
    let half = (z[at - 1] - z[at - 2]) / 2.0;
    assert!(
        (z[at - 1] - measured).abs() <= half + 1e-4,
        "{config}: resume from layer {at}, the bed holds {} mm, measured {measured}",
        z[at - 1]
    );
    let g = printed_zs(resumed);
    assert_eq!(g.len(), z.len() - at, "{config}");
    assert!(
        (g[0] - z[at]).abs() < 1e-3,
        "{config}: first Z {} vs {}",
        g[0],
        z[at]
    );
}

#[test]
fn a_resume_planned_in_the_job_layers_slices_from_the_measured_height() {
    // 0.1 mm layers drawn on a 0.2 mm layer height, as drawn and stretched for 99.5 percent.
    let own = tops_of(&[(0.1, 98)]);
    for config in [json!({}), json!({"filament_shrinkage_compensation_z": ["99.5%"]})] {
        let (job, at, resumed) = resume_in_job_layers(10.0, &config, &own, 5.0);
        assert_lands(&config, &job, at, &resumed, 5.0);
    }
}

#[test]
fn a_resume_lands_on_the_measured_height_where_layers_sit_at_the_maximum() {
    // 0.28 mm layers (the printer's maximum) to 20.08 mm, then 0.1 mm to the 40 mm top, 99 percent in Z. The engine
    // keeps the layers at the maximum and stretches the thin ones, so a part measured at 20.08 mm resumes from layer
    // index 72 (resumeFromLayer; layer 73 as printers count).
    let mut own = tops_of(&[(0.28, 71), (0.1, 198)]);
    own.push(40.0);
    assert!((own[71] - 20.08).abs() < 1e-6);
    let config = json!({"filament_shrinkage_compensation_z": ["99%"]});
    let (job, at, resumed) = resume_in_job_layers(40.0, &config, &own, 20.08);
    assert!(
        job.windows(2)
            .take(71)
            .all(|w| matches!(w, [a, b] if ((b - a) - 0.28).abs() < 1e-4)),
        "layers at the maximum stretched"
    );
    assert_eq!(at, 72);
    assert_lands(&config, &job, at, &resumed, 20.08);
    // Counting in the drawn tops stretched evenly by 1 / 0.99, as the app did before, picks a layer whose top in the
    // job is more than half a layer under the measured height: the restart would print inside the part.
    let (first, last) = (own[0], own[own.len() - 1]);
    let k = (last / 0.99 - first) / (last - first);
    let even: Vec<f64> = own.iter().map(|t| first + (t - first) * k).collect();
    let (r, _) = plan_layer(40.0, 20.08, Some(even));
    let wrong = job[usize::try_from(r).unwrap() - 1];
    assert!(20.08 - wrong > 0.14, "the even stretch lands at {wrong}");
}

#[test]
fn a_resume_planned_in_even_layers_lands_far_from_the_measured_height() {
    // A plan in even 0.2 mm layers picks layer 25: in the plate's own 0.1 mm tops that is 2.6 mm up.
    let own = tops_of(&[(0.1, 98)]);
    let (r, _) = plan_layer(10.0, 5.0, None);
    assert_eq!(r, 25);
    let resumed = slice(
        10.0,
        &json!({}),
        &json!({"flavor": "marlin2", "layerTopsMm": own, "layerTopsExact": true, "resumeFromLayer": r}),
    );
    let z = layer_z(&resumed);
    assert!(
        (z[usize::try_from(r).unwrap() - 1] - 5.0).abs() > 2.0,
        "{}",
        z[24]
    );
}
