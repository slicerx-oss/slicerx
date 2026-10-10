// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Layer ranges sliced apart concatenate to the bytes of one range, and a session that already sliced other
//! ranges (in any order) gives the bytes a fresh one gives: the web pool's workers each slice ranges of the
//! plate, and a kept session must not change what a range prints.

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

/// A binary STL of a wedge: `len` x `wide` mm, `low` mm tall at x = 0 rising to `high` mm at x = `len`. Each
/// layer of the shallow slope has an internal bridge over the sparse infill of the layer below, so a layer's
/// bridges read a cluster of layers further down than its shells do.
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

fn request(objects: &[(&str, [f64; 2])], config: &Value) -> SliceRequest {
    let objects: Vec<Value> = objects
        .iter()
        .map(|&(id, [x, y])| {
            json!({"id": id, "name": id, "mesh": id, "transform": [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, 0.0, 1.0]})
        })
        .collect();
    serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": common::with_base(config),
        "options": {"flavor": "marlin2"},
    }))
    .unwrap()
}

/// Slices `req` in `shards` ranges: each on a fresh session when `sessions` is None, else on that one session
/// in the given order of ranges. Returns each range's G-code, in plate order.
fn ranges(
    req: &SliceRequest,
    meshes: &dyn Fn(&str) -> sx_core::Result<Arc<Mesh>>,
    shards: u32,
    order: &[u32],
    kept: Option<&sx_core::SliceSession>,
) -> Vec<Vec<u8>> {
    let (config, _) = api::request_config_checked(req).unwrap();
    let plate = api::build_plate(req, meshes).unwrap();
    let fresh = || api::build_session(req, &plate, &config).unwrap();
    let n = fresh().layer_count();
    let mut out = vec![Vec::new(); shards as usize];
    for &s in order {
        let own;
        let session = if let Some(k) = kept {
            k
        } else {
            own = fresh();
            &own
        };
        api::slice_shard(
            req,
            session,
            &config,
            n * s / shards..n * (s + 1) / shards,
            &sx_core::NoProgress,
            &mut out[s as usize],
        )
        .unwrap();
    }
    out
}

fn first_difference(a: &[u8], b: &[u8]) -> String {
    let (a, b) = (String::from_utf8_lossy(a), String::from_utf8_lossy(b));
    a.lines()
        .zip(b.lines())
        .enumerate()
        .find(|(_, (x, y))| x != y)
        .map_or_else(
            || format!("lengths {} and {}", a.len(), b.len()),
            |(i, (x, y))| format!("line {}: {x:?} vs {y:?}", i + 1),
        )
}

/// One range, then 4 and 8 ranges on fresh sessions, then 8 ranges on one kept session backward and forward.
fn same_bytes_every_way(req: &SliceRequest, meshes: &dyn Fn(&str) -> sx_core::Result<Arc<Mesh>>) {
    let one = ranges(req, meshes, 1, &[0], None).concat();
    for shards in [4, 8] {
        let order: Vec<u32> = (0..shards).collect();
        let joined = ranges(req, meshes, shards, &order, None).concat();
        assert!(
            joined == one,
            "{shards} ranges: {}",
            first_difference(&one, &joined)
        );
    }
    let (config, _) = api::request_config_checked(req).unwrap();
    let plate = api::build_plate(req, meshes).unwrap();
    let kept = api::build_session(req, &plate, &config).unwrap();
    let back: Vec<u32> = (0..8).rev().collect();
    let joined = ranges(req, meshes, 8, &back, Some(&kept)).concat();
    assert!(
        joined == one,
        "8 ranges backward on one session: {}",
        first_difference(&one, &joined)
    );
    let forward: Vec<u32> = (0..8).collect();
    let joined = ranges(req, meshes, 8, &forward, Some(&kept)).concat();
    assert!(
        joined == one,
        "8 ranges again on that session: {}",
        first_difference(&one, &joined)
    );
}

#[test]
fn bridge_clusters_slice_the_same_in_any_ranges() {
    let mesh = wedge(40.0, 30.0, 2.0, 4.0);
    let req = request(
        &[("w", [128.0, 128.0])],
        &json!({"layer_height": 0.12, "initial_layer_print_height": 0.12}),
    );
    same_bytes_every_way(&req, &move |_: &str| Ok(mesh.clone()));
}

#[test]
fn by_object_ranges_end_at_the_plates_top() {
    // The taller wedge prints first; the end G-code's lift reads the plate's top in every range.
    let tall = wedge(20.0, 20.0, 6.0, 6.0);
    let short = wedge(20.0, 20.0, 2.0, 2.0);
    let req = request(
        &[("tall", [80.0, 128.0]), ("short", [170.0, 128.0])],
        &json!({
            "print_sequence": "by object",
            "machine_end_gcode": "G1 Z{max_layer_z + 0.5} F900 ; lower z a little\nM104 S0\nM140 S0\nM107\nM84\n",
        }),
    );
    let one = ranges(
        &req,
        &move |id: &str| Ok(if id == "tall" { tall.clone() } else { short.clone() }),
        1,
        &[0],
        None,
    )
    .concat();
    assert!(String::from_utf8_lossy(&one).contains("G1 Z6.5 F900 ; lower z a little"));
    let tall = wedge(20.0, 20.0, 6.0, 6.0);
    let short = wedge(20.0, 20.0, 2.0, 2.0);
    same_bytes_every_way(&req, &move |id: &str| {
        Ok(if id == "tall" { tall.clone() } else { short.clone() })
    });
}
