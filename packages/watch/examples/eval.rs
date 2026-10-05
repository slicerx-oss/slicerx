// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Scores every image in some directories with the watch model and prints, per directory and
//! threshold, the share of images at or above it, plus the time per frame.
//!
//!     cargo run --release -p sx-watch --example eval -- <model.onnx> <threads> <dir> [<dir>...]
#![allow(clippy::cast_precision_loss, reason = "image counts are small")]
use std::time::Instant;

use sx_watch::decode::decode_sniffed;
use sx_watch::siglip::Siglip2;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [model, threads, dirs @ ..] = args.as_slice() else {
        eprintln!("usage: eval <model.onnx> <threads> <dir>...");
        std::process::exit(2);
    };
    let model =
        Siglip2::load(std::path::Path::new(model), threads.parse().unwrap_or(1)).unwrap_or_else(|e| {
            eprintln!("{e}");
            std::process::exit(1);
        });
    let mut times = Vec::new();
    for dir in dirs {
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension()
                    .is_some_and(|x| x == "jpg" || x == "jpeg" || x == "png")
            })
            .collect();
        files.sort();
        let mut scores = Vec::new();
        for f in &files {
            let Ok(rgb) = std::fs::read(f)
                .map_err(|_| ())
                .and_then(|b| decode_sniffed(&b).map_err(|_| ()))
            else {
                continue;
            };
            let start = Instant::now();
            if let Ok(p) = model.probs(&rgb) {
                times.push(start.elapsed().as_secs_f64() * 1000.0);
                scores.push(f64::from(p[0].max(p[1])));
            }
        }
        let n = scores.len().max(1) as f64;
        let at = |th: f64| scores.iter().filter(|&&s| s >= th).count() as f64 / n * 100.0;
        println!(
            "{dir}: {} images; at 0.5 {:.0} %, 0.7 {:.0} %, 0.9 {:.0} %, 0.95 {:.0} %",
            scores.len(),
            at(0.5),
            at(0.7),
            at(0.9),
            at(0.95)
        );
    }
    times.sort_by(f64::total_cmp);
    if let Some(m) = times.get(times.len() / 2) {
        println!("median {m:.0} ms per frame (model only), {} frames", times.len());
    }
}
