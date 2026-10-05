// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The SigLIP2 watch on stored public frames. Neither the model nor the frames are in git: the
//! model is built by `model/export_siglip2.py`, and the frames are the 60-image evaluation set
//! from CC BY 4.0 Roboflow Universe datasets (`spaghetti_*`, `minor_*`, `normal_*`, with
//! `provenance.jsonl` and the Python scores in `siglip2-reference.json`). Point `SX_WATCH_MODEL`
//! and `SX_WATCH_FRAMES` at them to run these; without both they pass without checking anything.
//! The frames stay out of the repository because their datasets cannot say where most images
//! were first taken.
#![cfg(feature = "siglip")]
use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use sx_watch::decode::decode_sniffed;
use sx_watch::policy::Config;
use sx_watch::protocol::Kind;
use sx_watch::session::Session;
use sx_watch::siglip::Siglip2;

fn inputs() -> Option<(Siglip2, PathBuf)> {
    let model = std::env::var_os("SX_WATCH_MODEL")?;
    let frames = PathBuf::from(std::env::var_os("SX_WATCH_FRAMES")?);
    Some((Siglip2::load(std::path::Path::new(&model), 2).unwrap(), frames))
}

fn frame(sec: u64, bytes: &[u8]) -> Value {
    let (m, s) = (sec / 60, sec % 60);
    json!({ "event": "watch.frame", "data": {
        "subscription": 1, "printerId": "bay-1", "contentType": "image/jpeg", "dataBase64": B64.encode(bytes),
        "capturedAt": format!("2026-10-01T20:{m:02}:{s:02}.000Z"), "source": "snapshot",
        "state": "printing", "layer": 20, "layerCount": 200
    } })
}

#[test]
fn scores_match_the_reference_pipeline() {
    let Some((model, frames)) = inputs() else {
        eprintln!("SX_WATCH_MODEL or SX_WATCH_FRAMES not set; skipped");
        return;
    };
    let reference: Value =
        serde_json::from_str(&std::fs::read_to_string(frames.join("siglip2-reference.json")).unwrap())
            .unwrap();
    let mut worst = 0f64;
    for (name, want) in reference.as_object().unwrap() {
        let rgb = decode_sniffed(&std::fs::read(frames.join(name)).unwrap()).unwrap();
        let got = model.probs(&rgb).unwrap();
        for (g, w) in got.iter().zip(want.as_array().unwrap()) {
            worst = worst.max((f64::from(*g) - w.as_f64().unwrap()).abs());
        }
    }
    // Different JPEG decoders and resize rounding: small, never enough to flip a frame.
    eprintln!("largest difference from the reference: {worst:.4}");
    assert!(worst < 0.05, "largest difference from the reference {worst}");
}

/// A print that looks normal for minutes reports nothing; spaghetti in the same place then
/// reports once, after three suspicious frames.
#[test]
fn a_normal_print_stays_quiet_until_spaghetti_appears() {
    let Some((model, frames)) = inputs() else {
        eprintln!("SX_WATCH_MODEL or SX_WATCH_FRAMES not set; skipped");
        return;
    };
    let normal = std::fs::read(frames.join("normal_01.jpg")).unwrap();
    let failed = std::fs::read(frames.join("spaghetti_01.jpg")).unwrap();
    let mut s = Session::new(model, Config::default());
    let mut reports = Vec::new();
    let mut t = 0;
    for _ in 0..20 {
        reports.extend(s.on_event(&frame(t, &normal)));
        t += 10;
    }
    assert!(reports.is_empty(), "{reports:?}");
    for _ in 0..5 {
        reports.extend(s.on_event(&frame(t, &failed)));
        t += 10;
    }
    assert_eq!(reports.len(), 1, "{reports:?}");
    assert_eq!(reports[0].kind, Kind::Spaghetti);
    assert_eq!(reports[0].confirmed, None);
    assert!(
        s.latest_frame("bay-1")
            .is_some_and(|(t, b)| t == "image/jpeg" && b == failed.as_slice())
    );
}
