// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The same request gives the same G-code bytes at every thread count, and when several slices share one
//! pool. The cases cover the paths with per-thread memos and the most parallel work: Arachne walls (the
//! Voronoi diagrams and wall results kept per thread) and organic tree supports (branch growth and
//! smoothing run as parallel maps). Each slice runs on its own pool of 1, 3 and 8 threads; the larger pools
//! also run three slices at once, as tests share the global pool. `SX_DETERMINISM_ROUNDS` repeats the
//! shared rounds for longer runs by hand.

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

fn mesh(file: &str) -> Arc<Mesh> {
    let path = format!("{}/cli/tests/fixtures/{file}", env!("CARGO_MANIFEST_DIR"));
    Arc::new(Mesh::load(&std::fs::read(path).unwrap(), file).unwrap())
}

/// G-code of `objects`, each mesh moved by its offset in mm as in the CLI fixtures, with `config` over the
/// test base.
fn slice(objects: &[(Arc<Mesh>, [f64; 2])], config: &Value) -> Vec<u8> {
    let plate: Vec<Value> = objects
        .iter()
        .enumerate()
        .map(|(i, (_, at))| json!({"mesh": i.to_string(), "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, at[0],at[1],0,1]}))
        .collect();
    let req: SliceRequest = serde_json::from_value(
        json!({"plate": {"objects": plate}, "config": config, "options": {"flavor": "klipper"}}),
    )
    .unwrap();
    let meshes: Vec<Arc<Mesh>> = objects.iter().map(|(m, _)| m.clone()).collect();
    let run = common::run_request(&req, &move |id: &str| {
        Ok(meshes[id.parse::<usize>().expect("mesh index")].clone())
    })
    .unwrap();
    run.gcode
}

/// The first line where `b` differs from `a`, for the failure message.
fn first_difference(a: &[u8], b: &[u8]) -> String {
    let (a, b) = (String::from_utf8_lossy(a), String::from_utf8_lossy(b));
    for (n, (x, y)) in a.lines().zip(b.lines()).enumerate() {
        if x != y {
            return format!("line {}: {x:?} against {y:?}", n + 1);
        }
    }
    format!("{} lines against {}", a.lines().count(), b.lines().count())
}

/// Slices on pools of 1, 3 and 8 threads and checks every result against the single-threaded one; returns it.
fn same_at_every_thread_count(objects: &[(Arc<Mesh>, [f64; 2])], config: &Value) -> String {
    let rounds = std::env::var("SX_DETERMINISM_ROUNDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    let one = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
    let reference = one.install(|| slice(objects, config));
    assert!(String::from_utf8_lossy(&reference).contains("G1 "), "no moves");
    for threads in [3, 8] {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .unwrap();
        let alone = pool.install(|| slice(objects, config));
        assert!(
            alone == reference,
            "{threads} threads: {}",
            first_difference(&reference, &alone)
        );
        for _ in 0..rounds {
            std::thread::scope(|s| {
                let runs: Vec<_> = (0..3)
                    .map(|_| s.spawn(|| pool.install(|| slice(objects, config))))
                    .collect();
                for run in runs {
                    let g = run.join().unwrap();
                    assert!(
                        g == reference,
                        "{threads} threads, shared: {}",
                        first_difference(&reference, &g)
                    );
                }
            });
        }
    }
    String::from_utf8(reference).unwrap()
}

#[test]
fn arachne_walls_are_the_same_at_every_thread_count() {
    let g = same_at_every_thread_count(
        &[(mesh("bars.stl"), [0.0, 0.0]), (mesh("wedge.stl"), [0.0, 40.0])],
        &json!({"wall_generator": "arachne", "wall_loops": 3, "brim_width": 0}),
    );
    assert!(g.contains(";TYPE:Inner wall"), "no inner walls");
}

#[test]
fn organic_tree_supports_are_the_same_at_every_thread_count() {
    let g = same_at_every_thread_count(
        &[(mesh("table.stl"), [128.0, 128.0])],
        &json!({
            "enable_support": true, "support_type": "tree(auto)", "support_style": "organic",
            "support_on_build_plate_only": false, "brim_width": 0,
        }),
    );
    assert!(g.contains(";TYPE:Support"), "no supports");
}
