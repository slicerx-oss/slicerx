// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Criterion benches on the reference plate: session preparation, slicing,
//! G-code and SXPV separately. `sx bench` is the gated harness for the
//! hill-climb; these are for looking at one stage at a time.

use criterion::{Criterion, criterion_group, criterion_main};
use std::hint::black_box;
use sx_core::api::{self, Plate, PrintConfig, SliceSession};

fn reference() -> (Plate, PrintConfig) {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let model = std::fs::read(format!("{root}/packages/core/bench/models/x-mark.stl")).unwrap_or_default();
    let bench =
        std::fs::read(format!("{root}/packages/core/bench/configs/reference-0.20.json")).unwrap_or_default();
    let bench: serde_json::Value = serde_json::from_slice(&bench).unwrap_or_default();
    let config = PrintConfig::from_value(&bench["config"]).unwrap_or_default();
    let mesh = api::load_mesh(&model, "x-mark.stl").unwrap_or_default();
    (Plate::single(mesh), config)
}

fn benches(c: &mut Criterion) {
    let (plate, config) = reference();
    let Ok(session) = SliceSession::new(&plate, &config) else {
        return;
    };
    let n = session.layer_count();
    let Ok(out) = session.slice_range_with(&config, 0..n, &api::NoProgress) else {
        return;
    };
    let mut g = c.benchmark_group("reference-0.20");
    g.sample_size(20);
    g.bench_function("prepare", |b| {
        b.iter(|| SliceSession::new(black_box(&plate), &config));
    });
    g.bench_function("slice", |b| {
        b.iter(|| session.slice_range_with(&config, 0..n, &api::NoProgress));
    });
    g.bench_function("gcode", |b| {
        b.iter(|| {
            let mut w = Vec::with_capacity(16 << 20);
            api::emit_gcode(black_box(&out), &config, config.gcode_flavor, &mut w)
        });
    });
    g.bench_function("preview", |b| b.iter(|| api::preview_buffers(black_box(&out))));
    g.bench_function("full", |b| {
        b.iter(|| {
            let run = api::slice(&plate, &config, &api::SliceOptions::default());
            run.map(|o| {
                let mut w = Vec::new();
                let _ = api::emit_gcode(&o, &config, config.gcode_flavor, &mut w);
                api::preview_buffers(&o).len() + w.len()
            })
        });
    });
    g.finish();
}

criterion_group!(slice, benches);
criterion_main!(slice);
