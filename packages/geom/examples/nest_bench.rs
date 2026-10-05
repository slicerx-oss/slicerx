// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the nesting benchmark (docs/core-features.md, true shape nesting)
//!
//! `nest_bench write DIR` writes every plate's parts as STL and `DIR/manifest.json` for the
//! other slicers; `nest_bench run [--gap MM] [--step DEG] [--passes N] [--plate NAME]` arranges
//! every plate with sx-geom and prints one JSON line per plate; `nest_bench nfp` times one no
//! fit polygon per part. run it with `cargo run --release -p sx-geom --example nest_bench --`.

#[path = "../tests/nest_bench/parts.rs"]
mod parts;

use serde_json::json;
use std::time::Instant;
use sx_geom::nest::{self, SilhouetteOptions, poly};

fn arg(args: &[String], key: &str) -> Option<f64> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
}

fn write(dir: &str) {
    let mut plates = Vec::new();
    for p in parts::plates() {
        let pd = std::path::Path::new(dir).join(&p.name);
        std::fs::create_dir_all(&pd).unwrap_or_else(|e| panic!("{}: {e}", pd.display()));
        let mut list = Vec::new();
        for (part, n) in p.parts.iter().zip(&p.counts) {
            if *n == 0 {
                continue;
            }
            let file = format!("{}/{}.stl", p.name, part.name);
            std::fs::write(
                std::path::Path::new(dir).join(&file),
                part.mesh.to_stl(&part.name),
            )
            .unwrap_or_else(|e| panic!("{file}: {e}"));
            list.push(json!({ "name": part.name, "file": file, "copies": n, "areaMm2": part.area }));
        }
        plates.push(json!({ "name": p.name, "parts": list }));
    }
    let manifest = json!({ "bedMm": [parts::BED_MM, parts::BED_MM], "plates": plates });
    std::fs::write(
        std::path::Path::new(dir).join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    println!("wrote {dir}/manifest.json");
}

fn run(args: &[String]) {
    let gap = arg(args, "--gap").unwrap_or(6.0);
    let step = arg(args, "--step").unwrap_or(10.0);
    #[allow(clippy::cast_possible_truncation, reason = "a small count")]
    let passes = u32::try_from(arg(args, "--passes").map_or(0, |v| v.round() as i64)).unwrap_or(0);
    let only = args
        .iter()
        .position(|a| a == "--plate")
        .and_then(|i| args.get(i + 1))
        .cloned();
    for p in parts::plates() {
        if only.as_ref().is_some_and(|o| *o != p.name) {
            continue;
        }
        let t0 = Instant::now();
        let o = parts::arrange(&p, gap, step, passes);
        let r = &o.result;
        println!(
            "{}",
            json!({
                "plate": p.name, "wanted": o.wanted, "placed": o.placed, "clear": o.clear, "utilization": o.utilization,
                "passes": r.stats.passes, "bestPass": r.stats.best_pass, "work": r.stats.work, "ms": t0.elapsed().as_millis(),
            })
        );
    }
}

fn nfp(args: &[String]) {
    // one no fit polygon per distinct part against itself
    let grow = arg(args, "--grow").unwrap_or(1.0);
    let mut seen = std::collections::BTreeSet::new();
    for p in parts::plates() {
        for part in &p.parts {
            if !seen.insert(part.name.clone()) {
                continue;
            }
            let outline = nest::silhouette(
                std::slice::from_ref(&part.mesh),
                None,
                &SilhouetteOptions::default(),
            );
            let g = poly::cover(&poly::offset(&outline.outline, grow, 0.1), 0.1);
            let t0 = Instant::now();
            let pieces = poly::convex_pieces(&g);
            let t1 = Instant::now();
            let r = poly::no_fit(&pieces, &pieces);
            let t2 = Instant::now();
            println!(
                "{:12} verts {:5} pieces {:4} nfp verts {:6} pieces {:6.1} ms nfp {:8.1} ms",
                part.name,
                poly::vertex_count(&g),
                pieces.len(),
                poly::vertex_count(&r),
                (t1 - t0).as_secs_f64() * 1e3,
                (t2 - t1).as_secs_f64() * 1e3
            );
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("write") if args.len() > 1 => write(&args[1]),
        Some("run") => run(&args),
        Some("nfp") => nfp(&args),
        Some("problems") if args.len() > 1 => {
            // the nest.arrange request of every plate, for timing the browser build
            let gap = arg(&args, "--gap").unwrap_or(2.0);
            for p in parts::plates() {
                let req = parts::problem(&p, gap, 10.0, 0);
                let file = std::path::Path::new(&args[1]).join(format!("{}.json", p.name));
                std::fs::write(&file, serde_json::to_string(&req).unwrap_or_default())
                    .unwrap_or_else(|e| panic!("{}: {e}", file.display()));
            }
        }
        _ => {
            eprintln!(
                "usage: nest_bench write DIR | run [--gap MM] [--step DEG] [--passes N] [--plate NAME] | nfp [--grow MM]"
            );
            std::process::exit(2);
        }
    }
}
