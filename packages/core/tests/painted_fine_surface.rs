// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A part with a finely meshed painted top slices in bounded memory. The union of a painted top's triangles keeps
//! every vertex of the mesh, so a curved edge meshed about once a micrometer stays rough at that scale. Grown by a
//! grid cell in one pass, such an outline crossed itself so many times that a painted ship of a few hundred thousand
//! triangles a layer ran the computer out of memory. Before the fix this block peaked at 4.0 GB. The memory ceiling
//! is read on Linux, where the process's peak resident memory can be started over and read back.

mod common;

use serde_json::json;
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};
use sx_core::paint::PaintFacet;

/// The peak resident memory of this process in bytes since the last [`reset_peak`], from Linux's `VmHWM`.
#[cfg(target_os = "linux")]
fn peak_rss() -> usize {
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let kb: usize = status
        .lines()
        .find_map(|l| l.strip_prefix("VmHWM:"))
        .and_then(|v| v.trim().trim_end_matches("kB").trim().parse().ok())
        .unwrap();
    kb << 10
}

/// Starts the peak over from the memory in use now (Linux 4.0 and later). Where that is refused the peak counts
/// from the start of this test binary, which holds only a few MB before the slice, so the ceiling still holds.
#[cfg(target_os = "linux")]
fn reset_peak() {
    std::fs::write("/proc/self/clear_refs", "5").ok();
}

/// Side of the block in mm.
const W: f64 = 40.0;
/// Height of the block in mm.
const H: f64 = 2.0;
/// Points on the rim of the painted disc: about one per micrometer.
const RIM: u32 = 120_000;
/// The cosine and sine of one rim step, a full turn over [`RIM`] points, as literals.
const STEP_COS: f64 = 0.999_999_998_629_221_6;
const STEP_SIN: f64 = 5.235_987_753_590_529e-5;

/// A fixed jitter for rim point `k`, under half a micrometer either way, the roughness a curved edge meshed that
/// finely keeps.
#[allow(clippy::cast_precision_loss, reason = "a small hash to a fraction")]
fn jitter(k: u32) -> f64 {
    let mut x = k.wrapping_mul(0x9e37_79b9);
    x ^= x >> 15;
    x = x.wrapping_mul(0x85eb_ca6b);
    x ^= x >> 13;
    (f64::from(x % 1000) / 1000.0 - 0.5) * 0.000_8
}

/// The painted top of the block, filament 2: a disc 38 mm across meshed as a fan from its center, its rim sampled
/// about once a micrometer, as a fine mesh of a curved solid's face is. The rim turns one step at a time, so no angle
/// is computed.
#[allow(clippy::cast_possible_truncation, reason = "points on a 40 mm block")]
fn top_paint() -> Vec<PaintFacet> {
    let (c, r) = (W / 2.0, W / 2.0 - 1.0);
    let mut dir = (1.0f64, 0.0f64);
    let rim: Vec<[f32; 3]> = (0..RIM)
        .map(|k| {
            let rr = r + jitter(k);
            let p = [(c + rr * dir.0) as f32, (c + rr * dir.1) as f32, H as f32];
            dir = (dir.0 * STEP_COS - dir.1 * STEP_SIN, dir.0 * STEP_SIN + dir.1 * STEP_COS);
            p
        })
        .collect();
    let center = [c as f32, c as f32, H as f32];
    (0..rim.len())
        .map(|k| PaintFacet {
            v: [center, rim[k], rim[(k + 1) % rim.len()]],
            state: 2,
        })
        .collect()
}

/// A 40 x 40 x 2 mm block on filament 1 with the painted top of [`top_paint`].
#[allow(clippy::cast_possible_truncation, reason = "a 40 mm block")]
fn block() -> Mesh {
    let (w, h) = (W as f32, H as f32);
    let positions: Vec<[f32; 3]> = (0..8)
        .map(|i| {
            [
                if i & 1 == 0 { 0.0 } else { w },
                if i & 2 == 0 { 0.0 } else { w },
                if i & 4 == 0 { 0.0 } else { h },
            ]
        })
        .collect();
    let triangles: Vec<[u32; 3]> = vec![
        [0, 2, 1],
        [1, 2, 3],
        [4, 5, 6],
        [5, 7, 6],
        [0, 1, 4],
        [1, 5, 4],
        [2, 6, 3],
        [3, 6, 7],
        [0, 4, 2],
        [2, 4, 6],
        [1, 3, 5],
        [3, 7, 5],
    ];
    Mesh {
        name: "block".into(),
        parts: vec![MeshPart {
            name: "block".into(),
            slot: 1,
            positions,
            triangles,
            paint: top_paint(),
            ..MeshPart::default()
        }],
        ..Mesh::default()
    }
}

fn request() -> SliceRequest {
    serde_json::from_value(json!({
        "plate": {"objects": [{"id": "b", "name": "b", "mesh": "b", "transform": [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 100.0, 100.0, 0.0, 1.0]}]},
        "config": common::with_base(&json!({
            "filament_colour": ["#FFFFFF", "#000000"],
            "enable_prime_tower": false,
            "layer_height": 0.2,
            "initial_layer_print_height": 0.2,
        })),
        "options": {"flavor": "marlin2"},
    }))
    .unwrap()
}

#[test]
fn a_finely_meshed_painted_top_slices_in_bounded_memory() {
    let mesh = Arc::new(block());
    let req = request();
    let meshes = move |_: &str| Ok(mesh.clone());
    #[cfg(target_os = "linux")]
    reset_peak();
    let prepared = api::prepare(&req, &meshes).unwrap();
    let layers = prepared.session().layer_count();
    assert_eq!(layers, 10);
    // The paint is a few MB, and the layers' painted regions add little to it. Elsewhere the block still slices
    // and the layers are checked; only Linux reads the peak back.
    #[cfg(target_os = "linux")]
    {
        let peak = peak_rss();
        eprintln!("{layers} layers, peak {} MB", peak >> 20);
        assert!(peak < 1 << 30, "the slice peaked at {} MB of memory", peak >> 20);
    }
    drop(prepared);
}
