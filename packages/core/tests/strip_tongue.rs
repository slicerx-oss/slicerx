// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The strip of sparse area that capped walls leave between them on a part that widens gets infill up to its start.
//! A rib 60 mm long that widens from 0.2 to 4 mm, with aegis walls, 15 percent grid and 0.45 mm sparse lines: at the
//! width where the wall count is capped a strip about one inner line wide opens down the middle, and the sparse
//! lines reach its narrow start only by a hook along its edge from the nearest crossing. Stopped at the anchor
//! length, the hook left 2 mm of the strip empty on every layer with 0.40 mm inner walls (a void up to 0.43 mm
//! wide), and 2.2 mm with three walls of the stock widths. What may stay is the spot where the strip is still
//! narrower than a sparse line, about 0.3 mm of rib.

#![allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
// Checks measure the output with the standard math functions; the engine's own rounding rule (clippy.toml) is for G-code.
#![allow(clippy::disallowed_methods)]

use serde_json::json;
use std::fmt::Write as _;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

/// Part widths at the two ends, and the length.
const W0: f64 = 0.2;
const W1: f64 = 4.0;
const LENGTH: f64 = 60.0;
const HEIGHT: f64 = 2.2;
const LAYER: f64 = 0.2;

/// The rib along +Y, `W0` wide at y = 0 and `W1` at y = `LENGTH`, centered on x = 0.
fn rib() -> Arc<Mesh> {
    let (w0, w1) = (W0, W1);
    let poly = [
        (-w0 / 2.0, 0.0),
        (w0 / 2.0, 0.0),
        (w1 / 2.0, LENGTH),
        (-w1 / 2.0, LENGTH),
    ];
    let mut stl = String::from("solid rib\n");
    let mut facet = |a: (f64, f64, f64), b: (f64, f64, f64), c: (f64, f64, f64)| {
        let _ = writeln!(stl, "facet normal 0 0 0\n outer loop");
        for v in [a, b, c] {
            let _ = writeln!(stl, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(stl, " endloop\nendfacet");
    };
    let at = |i: usize, z: f64| (poly[i % 4].0, poly[i % 4].1, z);
    for (a, b, c) in [(0, 2, 1), (0, 3, 2)] {
        facet(at(a, 0.0), at(b, 0.0), at(c, 0.0));
        facet(at(a, HEIGHT), at(c, HEIGHT), at(b, HEIGHT));
    }
    for i in 0..4 {
        facet(at(i, 0.0), at(i + 1, 0.0), at(i + 1, HEIGHT));
        facet(at(i, 0.0), at(i + 1, HEIGHT), at(i, HEIGHT));
    }
    stl.push_str("endsolid rib\n");
    Arc::new(Mesh::load(stl.as_bytes(), "rib.stl").unwrap())
}

fn run(m: &Arc<Mesh>, walls: u32, inner: f64) -> String {
    let config = json!({
        "wall_generator": "aegis",
        "wall_loops": walls,
        "outer_wall_line_width": 0.42,
        "inner_wall_line_width": inner,
        "sparse_infill_line_width": 0.45,
        "sparse_infill_pattern": "grid",
        "sparse_infill_density": "15%",
        "wall_sequence": "inner wall/outer wall",
        "precise_outer_wall": false,
        "layer_height": LAYER,
        "initial_layer_print_height": LAYER,
        "bottom_shell_layers": 3,
        "top_shell_layers": 3,
        "filament_diameter": [1.75],
        "filament_flow_ratio": [1.0],
        "print_flow_ratio": 1.0,
        "enable_arc_fitting": false,
        "brim_type": "no_brim",
        "brim_width": 0,
        "use_relative_e_distances": true,
        "slow_down_for_layer_cooling": false,
    });
    let req: SliceRequest =
        serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
    let m = m.clone();
    let run = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// One extrusion: its layer Z, its two ends, its filament mm, and whether it is sparse infill or the outer wall.
struct Bead {
    z: f64,
    a: (f64, f64),
    b: (f64, f64),
    e: f64,
    sparse: bool,
    outer: bool,
}

fn beads(g: &str) -> Vec<Bead> {
    let (mut px, mut py, mut pz) = (0.0f64, 0.0f64, 0.0f64);
    let mut feature = String::new();
    let mut out = Vec::new();
    for line in g.lines() {
        if let Some(f) = line
            .strip_prefix("; FEATURE:")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            f.trim().clone_into(&mut feature);
            continue;
        }
        let code = line.split(';').next().unwrap_or("").trim();
        let Some(cmd) = code.split_whitespace().next() else {
            continue;
        };
        let arg = |k: char| -> Option<f64> {
            code.split_whitespace()
                .skip(1)
                .find(|w| w.starts_with(k))
                .and_then(|w| w[1..].parse().ok())
        };
        if cmd == "G0" || cmd == "G1" {
            let (nx, ny) = (arg('X').unwrap_or(px), arg('Y').unwrap_or(py));
            pz = arg('Z').unwrap_or(pz);
            if let Some(e) = arg('E')
                && e > 0.0
                && (nx, ny) != (px, py)
            {
                out.push(Bead {
                    z: pz,
                    a: (px, py),
                    b: (nx, ny),
                    e,
                    sparse: feature.starts_with("Sparse"),
                    outer: feature.eq_ignore_ascii_case("Outer wall"),
                });
            }
            px = nx;
            py = ny;
        }
    }
    out
}

/// Per body layer: its Z, the longest stretch of rib (mm) where a cut across it has no sparse line and an
/// uncovered gap over 0.1 mm, and the widest such gap, between part widths `lo` and `hi`. Bead widths come from
/// the filament over the length (rounded-rectangle beads).
fn voids(g: &str, lo: f64, hi: f64) -> Vec<(f64, f64, f64)> {
    let all = beads(g);
    let filament = std::f64::consts::PI * 1.75 * 1.75 / 4.0;
    // The rib's place: the outer wall's center lies half its width in from the narrow end, and the middle of its
    // x range is the rib's center line.
    let outer: Vec<&Bead> = all.iter().filter(|b| b.outer && b.z > 0.5).collect();
    assert!(
        !outer.is_empty(),
        "no outer wall above the first layers in {} lines of G-code",
        g.lines().count()
    );
    let y0 = outer.iter().map(|b| b.a.1.min(b.b.1)).fold(f64::MAX, f64::min) - 0.21;
    let (xa, xb) = outer.iter().fold((f64::MAX, f64::MIN), |(l, h), b| {
        (l.min(b.a.0.min(b.b.0)), h.max(b.a.0.max(b.b.0)))
    });
    let cx = f64::midpoint(xa, xb);
    let width = |y: f64| W0 + (W1 - W0) * (y - y0) / LENGTH;
    let mut zs: Vec<f64> = all.iter().map(|b| b.z).collect();
    zs.sort_by(f64::total_cmp);
    zs.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    let mut out = Vec::new();
    // Body layers: clear of the 3 bottom and 3 top layers.
    for &z in zs
        .iter()
        .filter(|z| **z > 4.0 * LAYER - 1e-6 && **z < HEIGHT - 3.0 * LAYER - 1e-6)
    {
        let layer: Vec<&Bead> = all.iter().filter(|b| (b.z - z).abs() < 1e-6).collect();
        let (mut run, mut longest, mut widest) = (0.0f64, 0.0f64, 0.0f64);
        let step = 0.02;
        let mut y = y0 + (lo - W0) / (W1 - W0) * LENGTH;
        while width(y) < hi {
            let w = width(y);
            let mut spans: Vec<(f64, f64)> = Vec::new();
            let mut sparse = false;
            for b in &layer {
                let ((x1, y1), (x2, y2)) = (b.a, b.b);
                if !(y1.min(y2) <= y && y < y1.max(y2)) {
                    continue;
                }
                let len = (x2 - x1).hypot(y2 - y1);
                let xc = x1 + (y - y1) / (y2 - y1) * (x2 - x1) - cx;
                let bead = b.e * filament / len / LAYER + LAYER * (1.0 - std::f64::consts::FRAC_PI_4);
                let across = bead / ((y2 - y1).abs() / len).max(1e-3);
                spans.push((xc - across / 2.0, xc + across / 2.0));
                sparse |= b.sparse;
            }
            spans.sort_by(|p, q| p.0.total_cmp(&q.0));
            let mut gap = 0.0f64;
            let mut reach = -w / 2.0;
            for (s, e) in spans {
                gap = gap.max(s.min(w / 2.0) - reach);
                reach = reach.max(e);
            }
            gap = gap.max(w / 2.0 - reach);
            if !sparse && gap > 0.1 {
                run += step;
                longest = longest.max(run);
                widest = widest.max(gap);
            } else {
                run = 0.0;
            }
            y += step;
        }
        out.push((z, longest, widest));
    }
    out
}

/// No body layer keeps more than 0.6 mm of the strip empty, with 0.40 mm inner walls (part widths 1.7 to 2.3 mm)
/// or with three walls of the stock widths (2.6 to 3.2 mm).
#[test]
fn the_strip_between_capped_walls_gets_infill_up_to_its_start() {
    let m = rib();
    let mut wrong = Vec::new();
    for (walls, inner, lo, hi) in [(2, 0.40, 1.7, 2.3), (3, 0.45, 2.6, 3.2)] {
        let g = run(&m, walls, inner);
        let layers = voids(&g, lo, hi);
        assert!(layers.len() >= 4, "{walls} walls: {} body layers", layers.len());
        for (z, longest, widest) in layers {
            eprintln!(
                "{walls} walls, inner {inner}, z {z:.2}: empty for {longest:.2} mm, gap up to {widest:.3} mm"
            );
            if longest > 0.6 {
                wrong.push(format!(
                    "{walls} walls, inner {inner}, z {z:.2}: the strip is empty for {longest:.2} mm of rib (gap up to {widest:.3} mm)"
                ));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
