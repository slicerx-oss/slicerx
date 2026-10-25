// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! aegis walls with one wall on top surfaces: the outer wall of a one-wall top run sits where it does on the
//! layers under it and is as wide, so a top surface prints at the size of the part. A stepped part (a 12 mm
//! block 1.2 mm tall with a 6 mm block on it to 2.4 mm) has both kinds of one-wall run: the ledge on top of the
//! base, which keeps one wall where nothing covers it, and the last layer, which is all top surface.

#![allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
// Checks measure the output with the standard math functions; the engine's own rounding rule (clippy.toml) is for G-code.
#![allow(clippy::disallowed_methods)]

use serde_json::json;
use std::fmt::Write as _;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

/// Facets of a closed box over the square of half size `half` around the origin, from `z0` to `z1`.
fn block(half: f64, z0: f64, z1: f64, out: &mut String) {
    let poly = [(-half, -half), (half, -half), (half, half), (-half, half)];
    let mut facet = |a: (f64, f64, f64), b: (f64, f64, f64), d: (f64, f64, f64)| {
        let _ = writeln!(out, "facet normal 0 0 0\n outer loop");
        for v in [a, b, d] {
            let _ = writeln!(out, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(out, " endloop\nendfacet");
    };
    for i in 0..4 {
        let (a, b) = (poly[i], poly[(i + 1) % 4]);
        facet((0.0, 0.0, z0), (b.0, b.1, z0), (a.0, a.1, z0));
        facet((0.0, 0.0, z1), (a.0, a.1, z1), (b.0, b.1, z1));
        facet((a.0, a.1, z0), (b.0, b.1, z0), (b.0, b.1, z1));
        facet((a.0, a.1, z0), (b.0, b.1, z1), (a.0, a.1, z1));
    }
}

fn stepped() -> Arc<Mesh> {
    let mut stl = String::from("solid stepped\n");
    block(6.0, 0.0, 1.2, &mut stl);
    block(3.0, 1.2, 2.4, &mut stl);
    stl.push_str("endsolid stepped\n");
    Arc::new(Mesh::load(stl.as_bytes(), "stepped.stl").unwrap())
}

fn run(m: &Arc<Mesh>, precise: bool) -> String {
    let config = json!({
        "wall_generator": "aegis",
        "wall_loops": 2,
        "outer_wall_line_width": 0.42,
        "inner_wall_line_width": 0.45,
        "wall_sequence": "inner wall/outer wall",
        "precise_outer_wall": precise,
        "only_one_wall_top": true,
        "top_shell_layers": 5,
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "enable_arc_fitting": false,
        "brim_type": "no_brim",
        "brim_width": 0,
        "slow_down_for_layer_cooling": false,
    });
    let req: SliceRequest =
        serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
    let m = m.clone();
    let run = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// The outer wall's extrusion end points per layer: (layer Z, x, y, stated line width).
fn outer_points(g: &str) -> Vec<(f64, f64, f64, f64)> {
    let (mut z, mut w, mut outer) = (0.0f64, 0.0f64, false);
    let mut out = Vec::new();
    for line in g.lines() {
        if let Some(v) = line.strip_prefix(";Z:") {
            z = v.trim().parse().unwrap_or(z);
            continue;
        }
        if let Some(v) = line.strip_prefix(";TYPE:") {
            outer = v.trim() == "Outer wall";
            continue;
        }
        if let Some(v) = line.strip_prefix(";WIDTH:") {
            w = v.trim().parse().unwrap_or(w);
            continue;
        }
        let code = line.split(';').next().unwrap_or("").trim();
        if !outer || !code.starts_with("G1 ") {
            continue;
        }
        let arg = |k: char| -> Option<f64> {
            code.split_whitespace()
                .skip(1)
                .find(|t| t.starts_with(k))
                .and_then(|t| t[1..].parse().ok())
        };
        if let (Some(x), Some(y), Some(e)) = (arg('X'), arg('Y'), arg('E'))
            && e > 0.0
        {
            out.push((z, x, y, w));
        }
    }
    out
}

/// The outer wall's half size around `c` on the layers from `z0` to `z1` (median of the layers) and its width.
fn ring(pts: &[(f64, f64, f64, f64)], c: (f64, f64), z0: f64, z1: f64) -> (f64, f64) {
    let mut halves = Vec::new();
    let mut widths = Vec::new();
    let mut zs: Vec<f64> = pts
        .iter()
        .map(|p| p.0)
        .filter(|z| *z > z0 - 1e-6 && *z < z1 + 1e-6)
        .collect();
    zs.sort_by(f64::total_cmp);
    zs.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    for z in zs {
        let on: Vec<_> = pts.iter().filter(|p| (p.0 - z).abs() < 1e-6).collect();
        halves.push(
            on.iter()
                .map(|p| (p.1 - c.0).abs().max((p.2 - c.1).abs()))
                .fold(0.0, f64::max),
        );
        widths.push(on.iter().map(|p| p.3).fold(0.0, f64::max));
    }
    assert!(!halves.is_empty(), "no outer wall from z {z0} to {z1}");
    halves.sort_by(f64::total_cmp);
    widths.sort_by(f64::total_cmp);
    (halves[halves.len() / 2], widths[widths.len() / 2])
}

/// The ledge layer (z 1.2) and the last layer (z 2.4) print one wall; their outer wall is as far from the surface
/// and as wide as on the layers under them, with the precise outer wall on and off. Before, the bead of a one-wall
/// run kept the ratio of the outer spacing to the outer to first inner spacing: with the precise outer wall it sat
/// 0.014 mm further in and was 0.395 mm wide instead of 0.42, so the top layer came out 0.053 mm small per axis.
#[test]
fn aegis_one_wall_top_outer_wall_keeps_its_place_and_width() {
    let m = stepped();
    let mut wrong = Vec::new();
    for precise in [true, false] {
        let pts = outer_points(&run(&m, precise));
        let block: Vec<_> = pts.iter().filter(|p| p.0 > 1.3 && p.0 < 2.3).collect();
        let span = |f: fn(&&(f64, f64, f64, f64)) -> f64| {
            let v: Vec<f64> = block.iter().map(f).collect();
            f64::midpoint(
                v.iter().copied().fold(f64::MAX, f64::min),
                v.iter().copied().fold(f64::MIN, f64::max),
            )
        };
        let c = (span(|p| p.1), span(|p| p.2));
        for (name, normal, top) in [
            ("ledge", ring(&pts, c, 0.4, 1.0), ring(&pts, c, 1.2, 1.2)),
            ("top", ring(&pts, c, 1.4, 2.2), ring(&pts, c, 2.4, 2.4)),
        ] {
            eprintln!(
                "precise {precise}: {name} normal half {:.4} width {:.3}, one-wall half {:.4} width {:.3}",
                normal.0, normal.1, top.0, top.1
            );
            if (normal.0 - top.0).abs() > 0.0005 || (normal.1 - top.1).abs() > 1e-6 {
                wrong.push(format!(
                    "precise {precise}: {name} outer wall half size {:.4} width {:.3}, normal layers {:.4} width {:.3}",
                    top.0, top.1, normal.0, normal.1
                ));
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}
