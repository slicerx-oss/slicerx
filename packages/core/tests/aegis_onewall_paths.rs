// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! aegis walls on parts that print one wall for a reason other than a top surface: a part with `wall_loops` 1,
//! and the first layer under `only_one_wall_first_layer`. Their outer wall sits where it does with two walls
//! and is as wide, so these layers print at the size of the part, with the precise outer wall on and off.

#![allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
// Checks measure the output with the standard math functions; the engine's own rounding rule (clippy.toml) is for G-code.
#![allow(clippy::disallowed_methods)]

use serde_json::{Value, json};
use std::fmt::Write as _;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

/// A closed 10 mm box, 2 mm tall.
fn cube() -> Arc<Mesh> {
    let (half, z0, z1) = (5.0, 0.0, 2.0);
    let poly = [(-half, -half), (half, -half), (half, half), (-half, half)];
    let mut out = String::from("solid box\n");
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
    out.push_str("endsolid box\n");
    Arc::new(Mesh::load(out.as_bytes(), "box.stl").unwrap())
}

fn run(m: &Arc<Mesh>, precise: bool, extra: &Value) -> String {
    let mut config = json!({
        "wall_generator": "aegis",
        "wall_loops": 2,
        "outer_wall_line_width": 0.42,
        "inner_wall_line_width": 0.45,
        "initial_layer_line_width": 0.5,
        "wall_sequence": "inner wall/outer wall",
        "precise_outer_wall": precise,
        "only_one_wall_top": false,
        "only_one_wall_first_layer": false,
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "enable_arc_fitting": false,
        "brim_type": "no_brim",
        "brim_width": 0,
        "slow_down_for_layer_cooling": false,
    });
    for (k, v) in extra.as_object().unwrap() {
        config[k] = v.clone();
    }
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

/// The middle of the outer wall's points on the layers from z 0.6 to 1.4 (the box's center on the plate).
fn center(pts: &[(f64, f64, f64, f64)]) -> (f64, f64) {
    let mid: Vec<_> = pts.iter().filter(|p| p.0 > 0.5 && p.0 < 1.5).collect();
    let span = |f: fn(&&(f64, f64, f64, f64)) -> f64| {
        let v: Vec<f64> = mid.iter().map(f).collect();
        f64::midpoint(
            v.iter().copied().fold(f64::MAX, f64::min),
            v.iter().copied().fold(f64::MIN, f64::max),
        )
    };
    (span(|p| p.1), span(|p| p.2))
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

/// One printed layer's outer wall against the same layer of the two-wall reference.
fn compare(wrong: &mut Vec<String>, what: &str, reference: (f64, f64), one: (f64, f64)) {
    eprintln!(
        "{what}: two walls half {:.4} width {:.3}, one wall half {:.4} width {:.3}",
        reference.0, reference.1, one.0, one.1
    );
    if (reference.0 - one.0).abs() > 0.0005 || (reference.1 - one.1).abs() > 1e-6 {
        wrong.push(format!(
            "{what}: one-wall outer wall half size {:.4} width {:.3}, two walls {:.4} width {:.3}",
            one.0, one.1, reference.0, reference.1
        ));
    }
}

/// A part with one wall: the outer wall on every layer (first, middle and last) is where and as wide as with
/// two walls. Before, the single wall's bead kept the ratio of the outer spacing to the outer to first inner
/// spacing: with the precise outer wall it sat 0.0145 mm further in and was 0.395 mm wide instead of 0.42
/// (0.004 mm and 0.413 without it).
#[test]
fn aegis_one_wall_part_outer_wall_keeps_its_place_and_width() {
    let m = cube();
    let mut wrong = Vec::new();
    for precise in [true, false] {
        let two = outer_points(&run(&m, precise, &json!({"wall_loops": 2})));
        let one = outer_points(&run(&m, precise, &json!({"wall_loops": 1})));
        let c = center(&two);
        for (name, z0, z1) in [
            ("first layer", 0.2, 0.2),
            ("middle", 0.4, 1.8),
            ("last layer", 2.0, 2.0),
        ] {
            compare(
                &mut wrong,
                &format!("precise {precise}: {name}"),
                ring(&two, c, z0, z1),
                ring(&one, c, z0, z1),
            );
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// `only_one_wall_first_layer`: the first layer's outer wall is where and as wide as when the first layer prints
/// every wall. Before, with the precise outer wall it sat 0.011 mm further in and was 0.48 mm wide instead of 0.5.
#[test]
fn aegis_one_wall_first_layer_outer_wall_keeps_its_place_and_width() {
    let m = cube();
    let mut wrong = Vec::new();
    for precise in [true, false] {
        let all = outer_points(&run(&m, precise, &json!({"only_one_wall_first_layer": false})));
        let one = outer_points(&run(&m, precise, &json!({"only_one_wall_first_layer": true})));
        let c = center(&all);
        compare(
            &mut wrong,
            &format!("precise {precise}: first layer"),
            ring(&all, c, 0.2, 0.2),
            ring(&one, c, 0.2, 0.2),
        );
        // The layers above print every wall either way.
        compare(
            &mut wrong,
            &format!("precise {precise}: layers above"),
            ring(&all, c, 0.4, 2.0),
            ring(&one, c, 0.4, 2.0),
        );
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}
