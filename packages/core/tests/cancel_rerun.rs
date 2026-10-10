// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A slice canceled part way leaves its session as a fresh one: the plans and memos it keeps (support, shells,
//! bridges, regions, first layer) hold nothing worked out from the canceled pass, so the same range sliced again on
//! that session gives the bytes of a fresh session. Every point the engine checks the cancel flag is tried.

mod common;

use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use sx_core::api::{self, Mesh, SliceRequest};
use sx_core::{Error, Progress, SliceSession, Stage};

/// Cancels from its `at`-th look at the flag on; counts the looks.
struct CancelAt {
    at: usize,
    looks: AtomicUsize,
}

impl Progress for CancelAt {
    fn report(&self, _: Stage, _: f32) {}
    fn cancelled(&self) -> bool {
        self.looks.fetch_add(1, Ordering::Relaxed) >= self.at
    }
}

/// A binary STL of a wedge: `len` x `wide` mm, `low` mm tall at x = 0 rising to `high` mm at x = `len`.
fn wedge(len: f32, wide: f32, low: f32, high: f32) -> Arc<Mesh> {
    let profile = [(0.0, 0.0), (len, 0.0), (len, high), (0.0, low)];
    let front: Vec<[f32; 3]> = profile.iter().map(|&(x, z)| [x, 0.0, z]).collect();
    let back: Vec<[f32; 3]> = profile.iter().map(|&(x, z)| [x, wide, z]).collect();
    let mut tris: Vec<[[f32; 3]; 3]> = Vec::new();
    let mut quad = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3]| {
        tris.push([a, b, c]);
        tris.push([a, c, d]);
    };
    quad(front[0], front[1], front[2], front[3]);
    quad(back[3], back[2], back[1], back[0]);
    for i in 0..4 {
        let j = (i + 1) % 4;
        quad(front[j], front[i], back[i], back[j]);
    }
    let mut bytes = vec![0u8; 80];
    bytes.extend_from_slice(&u32::try_from(tris.len()).unwrap().to_le_bytes());
    for t in &tris {
        bytes.extend_from_slice(&[0u8; 12]);
        for p in t {
            for v in p {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
        }
        bytes.extend_from_slice(&[0, 0]);
    }
    Arc::new(Mesh::load(&bytes, "wedge.stl").unwrap())
}

fn request(objects: &[&str], config: &Value) -> SliceRequest {
    let objects: Vec<Value> = objects
        .iter()
        .enumerate()
        .map(|(k, id)| {
            #[allow(clippy::cast_precision_loss, reason = "a few objects")]
            let x = 70.0 + 90.0 * k as f64;
            json!({"id": id, "name": id, "mesh": id, "transform": [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, 110.0, 0.0, 1.0]})
        })
        .collect();
    serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": common::with_base(config),
        "options": {"flavor": "marlin2"},
    }))
    .unwrap()
}

/// For one range and for 4 ranges: cancels the first range's slice at every look the engine takes at the flag (up to
/// `samples` of them, spread over the run), then slices every range on that same session and compares with fresh
/// sessions.
fn cancel_then_rerun_is_fresh(
    req: &SliceRequest,
    meshes: &dyn Fn(&str) -> sx_core::Result<Arc<Mesh>>,
    samples: usize,
) {
    let (config, _) = api::request_config_checked(req).unwrap();
    let plate = api::build_plate(req, meshes).unwrap();
    let fresh = || api::build_session(req, &plate, &config).unwrap();
    let n = fresh().layer_count();
    let slice = |session: &SliceSession, range: std::ops::Range<u32>, progress: &dyn Progress| {
        let mut g = Vec::new();
        api::slice_shard(req, session, &config, range, progress, &mut g).map(|_| g)
    };
    for shards in [1u32, 4] {
        let range = |s: u32| n * s / shards..n * (s + 1) / shards;
        let want: Vec<Vec<u8>> = (0..shards)
            .map(|s| slice(&fresh(), range(s), &sx_core::NoProgress).unwrap())
            .collect();
        // How many times a whole first range looks at the flag.
        let count = CancelAt {
            at: usize::MAX,
            looks: AtomicUsize::new(0),
        };
        slice(&fresh(), range(0), &count).unwrap();
        let looks = count.looks.load(Ordering::Relaxed);
        assert!(looks > 2, "{looks} looks at the cancel flag");
        let step = (looks / samples).max(1);
        let mut canceled = 0;
        for at in (0..looks).step_by(step).chain([1, 2, looks - 1]) {
            let session = fresh();
            let cancel = CancelAt {
                at,
                looks: AtomicUsize::new(0),
            };
            match slice(&session, range(0), &cancel) {
                Err(Error::Cancelled) => canceled += 1,
                Ok(_) => {}
                Err(e) => panic!("cancel at look {at}: {e}"),
            }
            for (s, w) in want.iter().enumerate() {
                let again = slice(&session, range(u32::try_from(s).unwrap()), &sx_core::NoProgress).unwrap();
                assert!(
                    &again == w,
                    "{shards} ranges, canceled at look {at} of {looks}: range {s} sliced again differs from a fresh session"
                );
            }
        }
        assert!(canceled > 0, "{shards} ranges: no slice was canceled");
    }
}

#[test]
fn a_canceled_bridge_cluster_leaves_no_trace() {
    let mesh = wedge(40.0, 30.0, 2.0, 4.0);
    let req = request(
        &["w"],
        &json!({"layer_height": 0.12, "initial_layer_print_height": 0.12}),
    );
    cancel_then_rerun_is_fresh(&req, &move |_: &str| Ok(mesh.clone()), 10);
}

#[test]
fn a_canceled_painted_slice_leaves_no_trace() {
    let mesh = Arc::new(common::painted_tile());
    let req = request(
        &["t"],
        &json!({"filament_colour": ["#FFFFFF", "#000000", "#FF0000"], "enable_prime_tower": false, "layer_height": 0.1}),
    );
    cancel_then_rerun_is_fresh(&req, &move |_: &str| Ok(mesh.clone()), 10);
}

#[test]
fn a_canceled_support_plan_leaves_no_trace() {
    // An overhang: the support plan is worked out beside the first range's regions, and kept by the session.
    let mesh = wedge(30.0, 20.0, 1.0, 12.0);
    let mut r = request(
        &["s"],
        &json!({"enable_support": true, "support_type": "tree(auto)", "support_threshold_angle": 45}),
    );
    // Turned over, so the tall end hangs.
    if let Some(o) = r.plate.objects.first_mut() {
        o.transform = Some(vec![
            1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 128.0, 128.0, 12.0, 1.0,
        ]);
    }
    let m = mesh.clone();
    let one = common::run_request(&r, &move |_: &str| Ok(m.clone())).unwrap();
    assert!(
        String::from_utf8_lossy(&one.gcode).contains("upport"),
        "the overhang prints support"
    );
    cancel_then_rerun_is_fresh(&r, &move |_: &str| Ok(mesh.clone()), 10);
}

#[test]
fn a_canceled_by_object_plate_leaves_no_trace() {
    let tall = wedge(20.0, 20.0, 6.0, 6.0);
    let short = wedge(20.0, 20.0, 2.0, 2.0);
    let req = request(&["tall", "short"], &json!({"print_sequence": "by object"}));
    cancel_then_rerun_is_fresh(
        &req,
        &move |id: &str| Ok(if id == "tall" { tall.clone() } else { short.clone() }),
        10,
    );
}
