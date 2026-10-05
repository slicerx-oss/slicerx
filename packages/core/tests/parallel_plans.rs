// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The plans worked out once for the whole object (infill combination, lightning, supports) must be ready
//! before the per-layer parallel loop reads them. One planned lazily from inside a layer job can hang the
//! thread pool: the thread planning it waits for its own parallel work, picks up another layer job meanwhile,
//! and that job waits for the plan further up the same thread. Each case slices many times on small pools
//! and fails after a time limit instead of hanging the run. Debug builds also panic as soon as such a plan
//! is first worked out inside a parallel job (`par::plan`), so a missed case fails on every run.

use serde_json::{Value, json};
use std::sync::{Arc, mpsc};
use std::time::Duration;
mod common;

use sx_core::api::{self, Mesh, SliceRequest};

fn cuboid(x: [f32; 2], y: [f32; 2], z: [f32; 2], slot: u8) -> api::MeshPart {
    let mut positions = Vec::new();
    for zi in z {
        for (xi, yi) in [(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])] {
            positions.push([xi, yi, zi]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    api::MeshPart {
        name: "box".into(),
        slot,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint: Vec::new(),
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
    }
}

/// A 20 mm box 4 mm tall.
fn bx() -> Vec<api::MeshPart> {
    vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 4.0], 1)]
}

/// G-code of `parts` with `config` over thin layers; `object` adds to the plate object (a modifier volume
/// named "v" covers the right half of the box).
fn slice(parts: &[api::MeshPart], config: &Value, object: &Value) -> String {
    let mesh = Arc::new(Mesh {
        name: "m".into(),
        parts: parts.to_vec(),
    });
    let half = Arc::new(Mesh {
        name: "v".into(),
        parts: vec![cuboid([10.0, 30.0], [-5.0, 25.0], [-1.0, 5.0], 1)],
    });
    let mut cfg = json!({
        "brim_width": 0, "skirt_loops": 0, "sparse_infill_density": 20, "sparse_infill_pattern": "rectilinear",
        "layer_height": 0.1, "initial_layer_print_height": 0.2, "top_shell_layers": 6, "bottom_shell_layers": 4,
    });
    if let (Some(c), Some(extra)) = (cfg.as_object_mut(), config.as_object()) {
        c.extend(extra.clone());
    }
    let mut obj = json!({"mesh": "m", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]});
    if let (Some(o), Some(extra)) = (obj.as_object_mut(), object.as_object()) {
        o.extend(extra.clone());
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [obj]},
        "config": cfg,
        "options": {"flavor": "marlin2"},
    }))
    .expect("request");
    let r = common::run_request(&req, &move |id: &str| {
        Ok(if id == "v" { half.clone() } else { mesh.clone() })
    })
    .expect("slice");
    String::from_utf8(r.gcode).expect("utf8")
}

/// The rounds of each pool size: `SX_HANG_ROUNDS` when set, for longer runs by hand.
fn rounds(default: usize) -> usize {
    std::env::var("SX_HANG_ROUNDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Slices `rounds` times on pools of 4, 8 and 11 threads, three slices at once sharing each pool as tests
/// share the global one; fails when the work does not finish in time.
fn no_hang(parts: Vec<api::MeshPart>, config: Value, object: Value, rounds: usize) {
    let (tx, rx) = mpsc::channel();
    // A hung slice keeps this thread parked; the test fails on the time limit and the process exits.
    std::thread::spawn(move || {
        for threads in [4, 8, 11] {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .expect("pool");
            for _ in 0..rounds {
                std::thread::scope(|s| {
                    for _ in 0..3 {
                        s.spawn(|| {
                            let g = pool.install(|| slice(&parts, &config, &object));
                            assert!(g.contains("G1"), "no moves");
                        });
                    }
                });
            }
        }
        let _ = tx.send(());
    });
    match rx.recv_timeout(Duration::from_secs(120)) {
        Ok(()) => {}
        Err(mpsc::RecvTimeoutError::Timeout) => panic!("the slice did not finish: the thread pool hung"),
        Err(mpsc::RecvTimeoutError::Disconnected) => panic!("the slice failed"),
    }
}

#[test]
fn infill_combination_does_not_hang() {
    no_hang(bx(), json!({"infill_combination": true}), json!({}), rounds(20));
}

#[test]
fn lightning_infill_in_a_modifier_does_not_hang() {
    let modifier = json!({"volumes": [{"role": "modifier", "mesh": "v", "settings": {"sparse_infill_pattern": "lightning"}}]});
    no_hang(bx(), json!({}), modifier, rounds(4));
}

#[test]
fn lightning_tree_bases_do_not_hang() {
    // A table: two legs and a slab over them.
    let table = vec![
        cuboid([0.0, 6.0], [0.0, 12.0], [0.0, 3.0], 1),
        cuboid([24.0, 30.0], [0.0, 12.0], [0.0, 3.0], 1),
        cuboid([0.0, 30.0], [0.0, 12.0], [3.0, 4.0], 1),
    ];
    let cfg = json!({
        "layer_height": 0.2, "enable_support": true, "support_type": "tree(auto)", "support_style": "tree_slim",
        "support_base_pattern": "lightning",
    });
    no_hang(table, cfg, json!({}), rounds(2));
}

#[test]
fn interlocking_beams_with_a_support_filament_do_not_hang() {
    // The support filament plans the supports when the session is built, which cuts every layer.
    let pair = vec![
        cuboid([0.0, 10.0], [0.0, 10.0], [0.0, 3.0], 1),
        cuboid([10.0, 20.0], [0.0, 10.0], [0.0, 3.0], 2),
    ];
    let cfg = json!({
        "layer_height": 0.2, "interlocking_beam": true, "enable_prime_tower": false, "enable_support": true,
        "support_filament": 2,
    });
    no_hang(pair, cfg, json!({}), rounds(2));
}
