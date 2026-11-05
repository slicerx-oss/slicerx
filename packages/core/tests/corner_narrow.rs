// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Narrow internal solid infill at a corner, on a Bambu Lab printer: a piece keeps its lines when it holds a 6 mm
//! circle, and the corner of a ring holds a wider circle than the ring's straight sides do.
//!
//! The shapes: a 30 mm square box 2 mm tall under a block to z 4 over the hole outline, so the box's top at z 2 is a
//! band W wide (the stock P1S request with classic walls and zig-zag internal solid infill; layers 1.6 and 1.8 lie
//! under that band).
//! - Strip: the block covers the box from x = W on, a straight band W wide. It keeps its lines from W 5.5 and prints
//!   beads at 5.45, the 6 mm width test.
//! - Sharp ring: a square hole with sharp corners. Its corners hold 1.17 times the band's width, so the ring keeps its
//!   lines from W 4.55, where the straight band alone would not.
//! - Ring round a hole with 1 mm round corners: the solid reaches past the hole's edge further than that, so it is
//!   the sharp ring again.
//! - Ring with round outer and hole corners (hole 4 mm, outer 4 mm plus W): a band of one width all round, with no
//!   corner, decided like the strip on every layer however finely the arcs are cut.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "a G-code reader for the test: plate coordinates and filament lengths in mm"
)]

use serde_json::{Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

const REQUEST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/surface-walls/p1s-x-mark.json"
);

/// A prism over the convex polygon `poly` (counterclockwise) from `z0` to `z1`, as positions and triangles from `base`.
fn prism(poly: &[[f64; 2]], z0: f64, z1: f64, positions: &mut Vec<[f32; 3]>, triangles: &mut Vec<[u32; 3]>) {
    let base = u32::try_from(positions.len()).unwrap();
    let n = u32::try_from(poly.len()).unwrap();
    positions.extend(poly.iter().map(|p| [p[0] as f32, p[1] as f32, z0 as f32]));
    positions.extend(poly.iter().map(|p| [p[0] as f32, p[1] as f32, z1 as f32]));
    for i in 1..n - 1 {
        triangles.push([base, base + i + 1, base + i]);
        triangles.push([base + n, base + n + i, base + n + i + 1]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        triangles.push([base + i, base + j, base + n + j]);
        triangles.push([base + i, base + n + j, base + n + i]);
    }
}

/// A rectangle from `(x0, y0)` to `(x1, y1)` with its corners rounded at `r`, each quarter cut in `segs` chords.
fn rounded(x0: f64, y0: f64, x1: f64, y1: f64, r: f64, segs: u32) -> Vec<[f64; 2]> {
    if r <= 0.0 {
        return vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    }
    let mut p = Vec::new();
    for (cx, cy, a0) in [
        (x1 - r, y0 + r, -90.0),
        (x1 - r, y1 - r, 0.0),
        (x0 + r, y1 - r, 90.0),
        (x0 + r, y0 + r, 180.0),
    ] {
        for k in 0..=segs {
            let a = (a0 + 90.0 * f64::from(k) / f64::from(segs)).to_radians();
            p.push([cx + r * a.cos(), cy + r * a.sin()]);
        }
    }
    p
}

/// The 30 mm box with corners rounded at `outer` under a block over `hole` to z 4.
fn step(outer: &[[f64; 2]], hole: &[[f64; 2]]) -> Arc<Mesh> {
    let (mut positions, mut triangles) = (Vec::new(), Vec::new());
    prism(outer, 0.0, 2.0, &mut positions, &mut triangles);
    prism(hole, 2.0, 4.0, &mut positions, &mut triangles);
    Arc::new(Mesh {
        name: "step".into(),
        parts: vec![MeshPart {
            name: "step".into(),
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

fn strip(w: f64) -> Arc<Mesh> {
    step(
        &rounded(0.0, 0.0, 30.0, 30.0, 0.0, 1),
        &[[w, 0.0], [30.0, 0.0], [30.0, 30.0], [w, 30.0]],
    )
}

/// A square ring `w` wide round a hole whose corners are rounded at `r`.
fn ring(w: f64, r: f64) -> Arc<Mesh> {
    step(
        &rounded(0.0, 0.0, 30.0, 30.0, 0.0, 1),
        &rounded(w, w, 30.0 - w, 30.0 - w, r, 18),
    )
}

/// A ring `w` wide of one width all round: hole corners rounded at `r`, outer corners at `r + w`, `segs` chords to
/// each quarter.
fn round_ring(w: f64, r: f64, segs: u32) -> Arc<Mesh> {
    step(
        &rounded(0.0, 0.0, 30.0, 30.0, r + w, segs),
        &rounded(w, w, 30.0 - w, 30.0 - w, r, segs),
    )
}

/// The G-code of the stock P1S request with classic walls, zig-zag internal solid infill and `edits`.
fn slice(mesh: Arc<Mesh>, edits: &[(&str, Value)]) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!("classic");
    req["config"]["internal_solid_infill_pattern"] = json!("zig-zag");
    for (k, v) in edits {
        req["config"][*k] = v.clone();
    }
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// Whether the internal solid of the layer at `z` prints as lines: over half its length (floating shell included)
/// runs at 45 or 135 degrees.
fn lines_at(gcode: &str, z: f64) -> bool {
    let (mut here, mut feature) = (false, String::new());
    let mut pos: Option<[f64; 2]> = None;
    let (mut lines, mut all) = (0.0, 0.0);
    for line in gcode.lines() {
        if let Some(v) = line
            .strip_prefix("; Z_HEIGHT:")
            .or_else(|| line.strip_prefix(";Z:"))
        {
            here = v.trim().parse::<f64>().is_ok_and(|v| (v - z).abs() < 1e-3);
            continue;
        }
        if let Some(t) = line
            .strip_prefix("; FEATURE:")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            feature = t.trim().to_string();
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        if !(code.starts_with("G0") || code.starts_with("G1")) {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        let next = match (word('X'), word('Y'), pos) {
            (None, None, _) => continue,
            (nx, ny, Some(at)) => [nx.unwrap_or(at[0]), ny.unwrap_or(at[1])],
            (Some(x), Some(y), None) => [x, y],
            _ => continue,
        };
        if here
            && (feature == "Internal solid infill" || feature == "Floating vertical shell")
            && word('E').is_some_and(|e| e > 0.0)
            && let Some(p) = pos
        {
            let (dx, dy) = (next[0] - p[0], next[1] - p[1]);
            let len = dx.hypot(dy);
            let a = dy.atan2(dx).to_degrees().rem_euclid(90.0);
            all += len;
            if feature == "Internal solid infill" && (a - 45.0).abs() < 2.0 {
                lines += len;
            }
        }
        pos = Some(next);
    }
    assert!(all > 0.0, "no internal solid at z {z}");
    lines > 0.5 * all
}

/// Whether both layers under the band print lines.
fn lines(mesh: Arc<Mesh>) -> bool {
    let g = slice(mesh, &[]);
    let (a, b) = (lines_at(&g, 1.6), lines_at(&g, 1.8));
    assert_eq!(a, b, "z 1.6 and 1.8 disagree");
    a
}

#[test]
fn a_sharp_ring_keeps_its_lines_where_its_corners_hold_the_circle() {
    // The straight band is narrow under W 5.5: the strip prints beads at 5.45 and lines at 5.5.
    assert!(!lines(strip(5.45)));
    assert!(lines(strip(5.5)));
    // The sharp ring's corners hold the circle from W 4.55; at 4.5 it is still narrow.
    assert!(!lines(ring(4.5, 0.0)));
    assert!(lines(ring(4.6, 0.0)));
    assert!(lines(ring(5.0, 0.0)));
}

#[test]
fn a_ring_round_a_slightly_rounded_hole_is_the_sharp_ring() {
    // The solid reaches past the hole's edge further than 1 mm, so its own corner is sharp.
    assert!(!lines(ring(4.5, 1.0)));
    assert!(lines(ring(4.8, 1.0)));
}

#[test]
fn a_ring_of_one_width_all_round_is_decided_like_the_strip() {
    // No corner widens it. However finely the arcs are cut, it prints beads under W 5.5 on every layer.
    for segs in [8, 18, 32] {
        assert!(!lines(round_ring(4.5, 4.0, segs)), "{segs} chords");
        assert!(!lines(round_ring(5.2, 4.0, segs)), "{segs} chords");
    }
    assert!(lines(round_ring(5.6, 4.0, 18)));
}
