// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A preview sliced in shards, the way the web workers do it (each shard with its own extras, lines
//! counted per layer; the joined G-code finalized once; the shards stitched with its layer lines), is
//! the preview of one run: same segments, same extras, same G-code lines.

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn request() -> (SliceRequest, Arc<Mesh>) {
    request_on("marlin2", None)
}

/// The two x-marks with the given G-code flavor, and the printer model when one is named.
fn request_on(flavor: &str, model: Option<&str>) -> (SliceRequest, Arc<Mesh>) {
    let bytes = std::fs::read(format!("{}/packages/core/bench/models/x-mark.stl", root())).unwrap();
    let mesh = Arc::new(Mesh::load(&bytes, "x-mark.stl").unwrap());
    let bench: Value = serde_json::from_slice(
        &std::fs::read(format!(
            "{}/packages/core/bench/configs/reference-0.20.json",
            root()
        ))
        .unwrap(),
    )
    .unwrap();
    let mut config = bench["config"].clone();
    if let Some(model) = model {
        config["printer_model"] = json!(model);
    }
    let at = |x: f32| {
        [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, 128.0, 0.0, 1.0,
        ]
    };
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "a", "name": "a", "mesh": "x", "transform": at(70.0)},
            {"id": "b", "name": "b", "mesh": "x", "transform": at(186.0)},
        ]},
        "config": config,
        "options": {"flavor": flavor},
    }))
    .unwrap();
    (req, mesh)
}

/// What the web pool does for `shards` workers.
fn sharded(req: &SliceRequest, mesh: &Arc<Mesh>, shards: u32) -> Vec<u8> {
    sharded_with_file(req, mesh, shards).0
}

/// The stitched preview and the finished file it points into.
fn sharded_with_file(req: &SliceRequest, mesh: &Arc<Mesh>, shards: u32) -> (Vec<u8>, Vec<u8>) {
    let m = mesh.clone();
    let (config, _) = api::request_config_checked(req).unwrap();
    let plate = api::build_plate(req, &move |_: &str| Ok(m.clone())).unwrap();
    let session = api::build_session(req, &plate, &config).unwrap();
    let n = session.layer_count();
    let mut gcode = Vec::new();
    let mut chunks = Vec::new();
    for s in 0..shards {
        let mut text = Vec::new();
        let (out, _) = api::slice_shard(
            req,
            &session,
            &config,
            n * s / shards..n * (s + 1) / shards,
            &sx_core::NoProgress,
            &mut text,
        )
        .unwrap();
        let parsed = sx_core::extras::parse(&out, &config, 0, &String::from_utf8_lossy(&text));
        let layers: Vec<(u32, sx_core::extras::LayerExtras)> =
            out.layers.iter().map(|l| l.index).zip(parsed).collect();
        chunks.push(sx_core::preview::with_layer_extras(
            sx_core::preview_buffers(&out),
            &layers,
        ));
        gcode.extend_from_slice(&text);
    }
    let (finished, timing) = sx_core::firmware::finalize_timed(&gcode, None, Some(&config));
    let lines = sx_core::extras::layer_lines(&String::from_utf8_lossy(&finished));
    let progress = sx_core::extras::progress_lines(&String::from_utf8_lossy(&finished));
    let refs: Vec<&[u8]> = chunks.iter().map(Vec::as_slice).collect();
    let mut stitched = sx_core::preview::stitch_lines(&refs, &lines, &progress).unwrap();
    // The layers' seconds as the finished file reads them, as the pool writes them into the stitched preview.
    #[allow(clippy::cast_possible_truncation, reason = "seconds of a layer")]
    let seconds: Vec<f32> = timing.layer_s.iter().map(|&t| t as f32).collect();
    assert!(sx_core::preview::set_layer_times(&mut stitched, &seconds));
    (stitched, finished)
}

/// The finished file's line each segment's extras point at (0 when unknown).
fn segment_lines(preview: &[u8]) -> Vec<u32> {
    let info = sx_core::preview::read_info(preview).unwrap();
    let at = info.extras_at.expect("extras");
    (0..info.segments)
        .map(|k| u32::from_le_bytes(preview[at + k * 8 + 4..at + k * 8 + 8].try_into().unwrap()))
        .collect()
}

#[test]
fn shards_keep_the_extras_and_lines_of_one_run() {
    let (req, mesh) = request();
    let m = mesh.clone();
    let one = api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    let info = sx_core::preview::read_info(&one.preview).unwrap();
    let at = info.extras_at.expect("one run has extras");
    // Most segments know their G-code line.
    let lines: Vec<u32> = (0..info.segments)
        .map(|k| u32::from_le_bytes(one.preview[at + k * 8 + 4..at + k * 8 + 8].try_into().unwrap()))
        .collect();
    assert!(lines.iter().filter(|&&l| l > 0).count() * 10 > info.segments * 9);
    for shards in [1, 3, 5] {
        let stitched = sharded(&req, &mesh, shards);
        let s = sx_core::preview::read_info(&stitched).unwrap();
        assert!(s.extras_at.is_some() && !s.layer_lines, "{shards} shards");
        assert!(stitched == one.preview, "{shards} shards differ from one run");
    }
}

/// A Bambu Lab file marks its layers `; CHANGE_LAYER` once finished. A sharded slice must still find
/// every layer in it, or the preview's G-code lines (the G-code view, norn) point at the wrong lines.
#[test]
fn bambu_shards_point_at_the_finished_files_lines() {
    let (req, mesh) = request_on("bambu", Some("Bambu Lab A1"));
    let m = mesh.clone();
    let one = api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    let text = String::from_utf8_lossy(&one.gcode).into_owned();
    assert!(text.contains("\n; CHANGE_LAYER\n") && !text.contains("\n;LAYER_CHANGE"));
    for shards in [1, 3] {
        let (stitched, finished) = sharded_with_file(&req, &mesh, shards);
        let finished = String::from_utf8_lossy(&finished).into_owned();
        let file: Vec<&str> = finished.lines().collect();
        let lines = segment_lines(&stitched);
        let known: Vec<u32> = lines
            .iter()
            .copied()
            .filter(|&l| l > 0 && l != u32::MAX)
            .collect();
        assert!(
            known.len() * 10 > lines.len() * 9,
            "{shards} shards: {} of {} lines known",
            known.len(),
            lines.len()
        );
        // each known line is a move in the finished file
        for &l in &known {
            let line = file.get(l as usize - 1).copied().unwrap_or("");
            assert!(line.starts_with('G'), "{shards} shards: line {l} is {line:?}");
        }
        assert!(stitched == one.preview, "{shards} shards differ from one run");
    }
}
