// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! SXPV v2 (`preview_v2`): a slice asked for v2 expands into the v1 bytes of the same slice, byte for byte, and a
//! damaged v2 buffer is refused without a panic.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::many_single_char_names,
    reason = "test offsets and random bytes"
)]

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};
use sx_core::{preview, preview_v2};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

/// Two x-marks (so the preview has an object block) with G-code (so it has extras), with `extra` options.
fn slice(extra: &Value, config: &[(&str, Value)]) -> api::SliceRun {
    slice_of(2, 1.0, extra, config)
}

/// `objects` x-marks at `scale` of their size.
fn slice_of(objects: usize, scale: f32, extra: &Value, config: &[(&str, Value)]) -> api::SliceRun {
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
    let mut cfg = bench["config"].clone();
    for (k, v) in config {
        cfg[*k] = v.clone();
    }
    let s = scale;
    let at = |x: f32| {
        [
            s, 0.0, 0.0, 0.0, 0.0, s, 0.0, 0.0, 0.0, 0.0, s, 0.0, x, 128.0, 0.0, 1.0,
        ]
    };
    let mut options = json!({"emitGcode": true, "emitPreview": true});
    if let (Some(o), Some(e)) = (options.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    let all = [
        json!({"id": "a", "name": "a", "mesh": "x", "transform": at(70.0)}),
        json!({"id": "b", "name": "b", "mesh": "x", "transform": at(186.0)}),
    ];
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": all[..objects]},
        "config": cfg,
        "options": options,
    }))
    .unwrap();
    api::run_request(&req, &|_| Ok(mesh.clone())).unwrap()
}

#[test]
fn v2_expands_into_the_v1_bytes() {
    let v1 = slice(&json!({}), &[]);
    let v2 = slice(&json!({"previewFormat": "v2"}), &[]);
    assert_eq!(v1.gcode, v2.gcode, "the format changes only the preview");
    assert_eq!(preview_v2::version(&v1.preview), Some(1), "v1 stays the default");
    assert_eq!(preview_v2::version(&v2.preview), Some(2));
    let info = preview::read_info(&v1.preview).unwrap();
    assert!(
        info.extras_at.is_some() && info.objects_at.is_some(),
        "every v1 block is covered"
    );
    assert_eq!(preview_v2::decode(&v2.preview).unwrap(), v1.preview);
    assert_eq!(preview::expand(&v2.preview).unwrap().as_ref(), &v1.preview[..]);
    assert_eq!(preview::expand(&v1.preview).unwrap().as_ref(), &v1.preview[..]);
    assert!(
        v2.preview.len() * 3 < v1.preview.len(),
        "{} against {}",
        v2.preview.len(),
        v1.preview.len()
    );
    assert_eq!(v2.report.preview_bytes, v2.preview.len() as u64);
    // Encoding is a pure function of the v1 bytes, and a v2 buffer encodes to itself.
    assert_eq!(preview_v2::encode(&v1.preview).unwrap(), v2.preview);
    assert_eq!(preview_v2::encode(&v2.preview).unwrap(), v2.preview);
    // Readers of the v1 tables refuse v2 instead of misreading it.
    assert!(preview::read_info(&v2.preview).is_err());
}

#[test]
fn a_vase_climbs_inside_runs_and_still_round_trips() {
    // A spiral layer's segments each sit at their own z.
    let v1 = slice_of(1, 1.0, &json!({}), &[("spiral_mode", json!("1"))]);
    let v2 = preview_v2::encode(&v1.preview).unwrap();
    assert_eq!(preview_v2::decode(&v2).unwrap(), v1.preview);
}

/// A v1 buffer with off-grid positions in a segment pair and a travel, which v2 keeps raw.
fn off_grid(v1: &[u8]) -> Vec<u8> {
    let mut b = v1.to_vec();
    let i = preview::read_info(&b).unwrap();
    let odd = 123.456_78_f32.to_le_bytes();
    // the end of segment 10 and the start of segment 11, so the run still joins up
    b[i.segments_at + 10 * 32 + 8..i.segments_at + 10 * 32 + 12].copy_from_slice(&odd);
    b[i.segments_at + 11 * 32..i.segments_at + 11 * 32 + 4].copy_from_slice(&odd);
    b[i.travels_at + 3 * 16 + 4..i.travels_at + 3 * 16 + 8].copy_from_slice(&odd);
    b
}

#[test]
fn off_grid_positions_come_back_exactly() {
    let v1 = off_grid(&slice(&json!({}), &[]).preview);
    let v2 = preview_v2::encode(&v1).unwrap();
    assert_eq!(preview_v2::decode(&v2).unwrap(), v1);
}

/// A small deterministic generator, so the damage below is the same on every run.
struct Xs(u64);
impl Xs {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// Where the first layer block starts, from the header's counts.
fn blocks_at(v2: &[u8]) -> usize {
    let n = u32::from_le_bytes(v2[12..16].try_into().unwrap()) as usize;
    32 + (n + 1) * 4 + n * 8 + (n + 1) * 4 + (n + 1) * 4
}

#[test]
fn damaged_v2_is_refused_without_a_panic() {
    // A small plate keeps the thousands of decodes below quick in a debug build.
    let v1 = slice_of(2, 0.3, &json!({}), &[]).preview;
    let v2 = preview_v2::encode(&v1).unwrap();
    let n = u32::from_le_bytes(v2[12..16].try_into().unwrap()) as usize;
    let index_at = blocks_at(&v2) - (n + 1) * 4;

    // Truncated anywhere.
    for len in (0..v2.len()).step_by(37).chain(v2.len() - 8..v2.len()) {
        assert!(preview_v2::decode(&v2[..len]).is_err(), "truncated at {len}");
    }
    // Not v2, or flags it does not know.
    assert!(preview_v2::decode(&v1).is_err());
    let mut f = v2.clone();
    f[7] |= 0x80;
    assert!(preview_v2::decode(&f).is_err());
    // A varint that never ends, as the first stream length of the first layer.
    let mut bad = v2.clone();
    let at = blocks_at(&bad);
    bad[at..at + 11].fill(0xFF);
    assert!(preview_v2::decode(&bad).is_err());
    // A wrong layer index: out of order, or not ending at the end of the blocks.
    let mut idx = v2.clone();
    idx.copy_within(index_at + 8..index_at + 12, index_at + 4);
    assert!(preview_v2::decode(&idx).is_err());
    let mut idx = v2.clone();
    idx[index_at + n * 4] ^= 1;
    assert!(preview_v2::decode(&idx).is_err());
    let mut idx = v2.clone();
    idx.swap(index_at + 4, index_at + 8);
    assert!(preview_v2::decode(&idx).is_err() || preview_v2::decode(&idx).unwrap() != v1);
    // A layer table that no longer adds up.
    let mut t = v2.clone();
    t[32 + 4] ^= 0x40;
    assert!(preview_v2::decode(&t).is_err());
    // Random bytes changed: refused, or a valid v1 buffer of the right size, never a panic.
    let mut x = Xs(0x5158_5056_3200_0001);
    for _ in 0..2000 {
        let mut d = v2.clone();
        for _ in 0..=(x.next() % 4) {
            let at = (x.next() % d.len() as u64) as usize;
            d[at] = x.next() as u8;
        }
        if let Ok(out) = preview_v2::decode(&d) {
            assert!(preview::read_info(&out).is_ok());
        }
    }
}
