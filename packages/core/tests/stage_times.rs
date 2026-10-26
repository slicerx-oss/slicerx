// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The timing report (`stageMicros`) times the internal bridges with the facts of the layers around them, and the
//! seam plan, as stages of their own, so less of a slice is left out of it.

use serde_json::json;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

/// A 20 mm box 6 mm tall with sparse infill and top layers: every layer above the first reads the facts of
/// the layers around it for its internal bridges.
fn report_on_one_thread() -> sx_core::api::SliceReport {
    let mesh = Arc::new(Mesh {
        name: "box".into(),
        parts: vec![common::organic_models::cuboid(
            "box",
            [0.0, 0.0, 0.0],
            [20.0, 20.0, 6.0],
        )],
        ..Mesh::default()
    });
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "box", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": {"sparse_infill_density": 15, "top_shell_layers": 5, "seam_position": "aligned"},
        "options": {"flavor": "marlin2"},
    }))
    .expect("request");
    // One thread: the stages then run one after another, each timed on its own.
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .build()
        .expect("pool");
    pool.install(|| common::run_request(&req, &|_| Ok(mesh.clone())))
        .expect("slice")
        .report
}

#[test]
fn bridges_and_seams_are_timed() {
    let r = report_on_one_thread();
    let m = r.stage_micros;
    assert!(m.bridges > 0, "no bridges time: {m:?}");
    assert!(m.seams > 0, "no seam plan time: {m:?}");
    let before = m.layers + m.contours + m.perimeters + m.surfaces + m.infill + m.paths;
    let now = before + m.bridges + m.seams;
    #[allow(clippy::cast_precision_loss, reason = "microseconds of a short slice")]
    let (before, now, wall) = (before as f64, now as f64, r.wall_ms * 1000.0);
    // No time is counted twice: on one thread the stages together stay within the slice's wall time, and the
    // share of it no stage accounts for drops.
    assert!(now <= wall, "stages {now} us over the wall time {wall} us: {m:?}");
    let (left_before, left_now) = (1.0 - before / wall, 1.0 - now / wall);
    assert!(
        left_now < left_before,
        "unattributed {left_now} not below {left_before}"
    );
}

/// A report written before the two stages existed still reads, with them at zero.
#[test]
fn reports_without_the_new_stages_read() {
    let m: sx_core::StageMicros = serde_json::from_value(json!({
        "layers": 1, "contours": 2, "perimeters": 3, "surfaces": 4, "infill": 5, "paths": 6, "gcode": 7, "preview": 8,
    }))
    .expect("old report");
    assert_eq!((m.paths, m.bridges, m.seams), (6, 0, 0));
    let v = serde_json::to_value(sx_core::StageMicros {
        bridges: 9,
        seams: 10,
        ..m
    })
    .expect("json");
    assert_eq!((v["bridges"].as_u64(), v["seams"].as_u64()), (Some(9), Some(10)));
}
