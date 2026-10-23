// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A brim that would run off the bed, or into an excluded bed area, is cut to the bed: the plate slices, every brim
//! line stays on the bed, and the rest of the brim is kept as it was.

// Test inputs are small counts and exact expected values.
#![allow(clippy::cast_precision_loss, clippy::float_cmp)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{self, Mesh, SliceRequest, SliceRun};

/// A 256 mm bed with the front left corner excluded, as on a P1S.
const BED: f64 = 256.0;
const ZONE: [f64; 4] = [0.0, 0.0, 18.0, 28.0];

fn x_mark() -> Arc<Mesh> {
    let path = format!("{}/bench/models/x-mark.stl", env!("CARGO_MANIFEST_DIR"));
    Arc::new(Mesh::load(&std::fs::read(path).unwrap(), "x-mark.stl").unwrap())
}

/// A box `width` by `depth` by `height` mm, centered on its origin in X and Y.
fn slab(width: f32, depth: f32, height: f32) -> Arc<Mesh> {
    let (left, right, front, back) = (-width / 2.0, width / 2.0, -depth / 2.0, depth / 2.0);
    let mut positions = Vec::new();
    for top in [0.0, height] {
        for (px, py) in [(left, front), (right, front), (right, back), (left, back)] {
            positions.push([px, py, top]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    Arc::new(Mesh {
        name: "slab".into(),
        parts: vec![api::MeshPart {
            name: "slab".into(),
            slot: 1,
            color: None,
            positions,
            triangles,
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
            paint_texts: Vec::new(),
        }],
        ..Mesh::default()
    })
}

/// Slices `mesh` at each of `at` (mm) on the bed above, with `config` over the test base.
fn slice(mesh: Arc<Mesh>, at: &[(f64, f64)], config: &Value) -> sx_core::Result<SliceRun> {
    let objects: Vec<Value> = at
        .iter()
        .enumerate()
        .map(|(i, (x, y))| {
            json!({"id": format!("o{i}"), "name": format!("part {i}"), "mesh": "m",
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]})
        })
        .collect();
    let mut cfg = json!({
        "printable_area": ["0x0", "256x0", "256x256", "0x256"],
        "bed_exclude_area": ["0x0", "18x0", "18x28", "0x28"],
        "skirt_loops": 0,
    });
    if let (Some(dst), Some(src)) = (cfg.as_object_mut(), config.as_object()) {
        dst.extend(src.clone());
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": cfg,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    common::run_request(&req, &move |_: &str| Ok(mesh.clone()))
}

/// The first layer's brim moves that extrude, as points (mm).
fn first_layer_brim(run: &SliceRun) -> Vec<[f64; 2]> {
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    let mark = sx_core::extras::layer_mark(&g);
    let first = g.split(mark).nth(1).unwrap_or("");
    let mut brim = false;
    let mut pts = Vec::new();
    for line in first.lines() {
        if let Some(t) = line.strip_prefix(";TYPE:") {
            brim = t.trim() == "Brim";
            continue;
        }
        if !brim || !line.starts_with("G1 ") || !line.contains(" E") {
            continue;
        }
        let word = |c: char| {
            line.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        if let (Some(x), Some(y)) = (word('X'), word('Y')) {
            pts.push([x, y]);
        }
    }
    pts
}

fn bounds(pts: &[[f64; 2]]) -> [f64; 4] {
    pts.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
        [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
    })
}

/// Every brim point lies on the bed by at least `inset` mm and outside the excluded corner.
fn assert_on_bed(pts: &[[f64; 2]], inset: f64) {
    assert!(!pts.is_empty(), "no brim on the first layer");
    for p in pts {
        assert!(
            p[0] >= inset && p[1] >= inset && p[0] <= BED - inset && p[1] <= BED - inset,
            "brim point {p:?} off the bed"
        );
        let in_zone = p[0] < ZONE[2] - 0.05 && p[1] < ZONE[3] - 0.05;
        assert!(!in_zone, "brim point {p:?} in the excluded area");
    }
}

/// The first layer brim's bounds of `mesh` alone at `at`, to compare a cut brim with the whole one.
fn whole_brim(mesh: Arc<Mesh>, at: (f64, f64), config: &Value) -> [f64; 4] {
    bounds(&first_layer_brim(&slice(mesh, &[at], config).unwrap()))
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.01
}

/// The x-mark centered at Y 238: its first layer ends about 7.8 mm from the bed's back edge, so a 10 mm brim
/// would run about 2.5 mm off the bed.
#[test]
fn a_brim_past_the_bed_edge_is_cut_to_the_bed_and_kept() {
    let cfg = json!({"brim_type": "outer_only", "brim_width": 10});
    let run = slice(x_mark(), &[(128.0, 238.0)], &cfg)
        .expect("the brim is cut to the bed instead of refusing the plate");
    let pts = first_layer_brim(&run);
    // The outermost loop runs half a line spacing inside the edge, its bead on the bed.
    assert_on_bed(&pts, 0.15);
    let b = bounds(&pts);
    assert!(b[3] > BED - 0.5, "the brim reaches the back edge: {b:?}");
    // The front and the sides are as they are in the middle of the bed.
    let w = whole_brim(x_mark(), (128.0, 128.0), &cfg);
    assert!(
        near(b[0], w[0]) && near(b[2], w[2]) && near(b[1], w[1] + 110.0),
        "{b:?} against {w:?}"
    );
    assert!(
        w[3] + 110.0 > BED + 2.0,
        "the whole brim would have run off the bed: {w:?}"
    );
}

/// A 200 by 100 by 40 mm slab gets an automatic brim of about 9 mm (its footprint's diagonal against the
/// material's thermal length). With its back 3 mm from the bed's back edge, that brim is cut at the edge.
#[test]
fn an_automatic_brim_near_the_edge_is_cut_to_the_bed() {
    let cfg = json!({"brim_type": "auto_brim"});
    let y = BED - 3.0 - 50.0;
    let run = slice(slab(200.0, 100.0, 40.0), &[(128.0, y)], &cfg)
        .expect("the automatic brim is cut to the bed instead of refusing the plate");
    let pts = first_layer_brim(&run);
    assert_on_bed(&pts, 0.15);
    let b = bounds(&pts);
    assert!(b[3] > BED - 0.5, "the brim reaches the back edge: {b:?}");
    let w = whole_brim(slab(200.0, 100.0, 40.0), (128.0, 128.0), &cfg);
    assert!(
        near(b[0], w[0]) && near(b[2], w[2]) && near(b[1], w[1] + y - 128.0),
        "{b:?} against {w:?}"
    );
    // The automatic brim is wider than the 5 mm the settings name: it would have run off the bed.
    assert!(
        w[3] + y - 128.0 > BED + 2.0,
        "the whole brim would have run off the bed: {w:?}"
    );
}

/// Near the front left corner, a 12 mm brim would run into the excluded area: it is cut out of it.
#[test]
fn a_brim_is_cut_out_of_an_excluded_bed_area() {
    let run = slice(
        x_mark(),
        &[(64.33, 27.0)],
        &json!({"brim_type": "outer_only", "brim_width": 12}),
    )
    .expect("the brim is cut out of the excluded area instead of refusing the plate");
    let pts = first_layer_brim(&run);
    assert_on_bed(&pts, 0.15);
    // The brim still runs along the area's edges: left of the part above it, and in front of the part beside it.
    assert!(
        pts.iter().any(|p| p[0] < ZONE[2] && p[1] > ZONE[3]),
        "brim above the area"
    );
    assert!(
        pts.iter().any(|p| p[0] > ZONE[2] && p[1] < ZONE[3]),
        "brim beside the area"
    );
}

/// Copies of one object print the first one's paths moved, but a brim cut to the bed belongs to where it was cut:
/// the plate is sliced whole, so the copy in the middle keeps its whole brim.
#[test]
fn a_copy_away_from_the_edge_keeps_its_whole_brim() {
    let cfg = json!({"brim_type": "outer_only", "brim_width": 10});
    let run = slice(x_mark(), &[(128.0, 238.0), (128.0, 80.0)], &cfg)
        .expect("the brim is cut to the bed instead of refusing the plate");
    let pts = first_layer_brim(&run);
    assert_on_bed(&pts, 0.15);
    let middle: Vec<[f64; 2]> = pts.iter().copied().filter(|p| p[1] < 160.0).collect();
    let b = bounds(&middle);
    let w = whole_brim(x_mark(), (128.0, 80.0), &cfg);
    assert!(
        near(b[0], w[0]) && near(b[1], w[1]) && near(b[2], w[2]) && near(b[3], w[3]),
        "{b:?} against {w:?}"
    );
    assert!(
        pts.iter().any(|p| p[1] > BED - 0.5),
        "the back copy's brim reaches the edge"
    );
}
