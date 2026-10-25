// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! aegis walls on thin parts: fins 0.25 to 1 mm thick and a 1 mm round peg, with the stock 0.42 and 0.45 mm walls
//! at 0.2 mm layers, the precise outer wall on and off. Every fin and the peg print on every layer, and the 0.8
//! and 1 mm fins and the peg get about the plastic their cross section holds: the material put down on a layer
//! against the cross section times the layer height. Beads have round sides, so a part filled edge to edge
//! measures 1 - (1 - pi/4) h / t on a fin t mm thick (0.95 on a 0.8 mm fin) and less on a small peg, whose
//! outline the wall generator also simplifies; more than 1.05 is overfilled.

#![allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
// Checks measure the output with the standard math functions; the engine's own rounding rule (clippy.toml) is for G-code.
#![allow(clippy::disallowed_methods)]

use serde_json::json;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

const HEIGHT: f64 = 4.0;

/// One feature of the plate: its name, its box in plan (x0, x1, y0, y1) and its cross section, mm2.
struct Feature {
    name: String,
    bbox: [f64; 4],
    area: f64,
}

/// Facets of a closed prism over the counterclockwise polygon `poly`, `HEIGHT` tall.
fn prism(poly: &[(f64, f64)], out: &mut String) {
    let n = poly.len();
    let c = (
        poly.iter().map(|p| p.0).sum::<f64>() / n as f64,
        poly.iter().map(|p| p.1).sum::<f64>() / n as f64,
    );
    let mut facet = |a: (f64, f64, f64), b: (f64, f64, f64), d: (f64, f64, f64)| {
        let _ = writeln!(out, "facet normal 0 0 0\n outer loop");
        for v in [a, b, d] {
            let _ = writeln!(out, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(out, " endloop\nendfacet");
    };
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        facet((c.0, c.1, 0.0), (b.0, b.1, 0.0), (a.0, a.1, 0.0));
        facet((c.0, c.1, HEIGHT), (a.0, a.1, HEIGHT), (b.0, b.1, HEIGHT));
        facet((a.0, a.1, 0.0), (b.0, b.1, 0.0), (b.0, b.1, HEIGHT));
        facet((a.0, a.1, 0.0), (b.0, b.1, HEIGHT), (a.0, a.1, HEIGHT));
    }
}

/// Our own thin plate: a 2 mm block that anchors the measurement, fins 10 mm long and 0.25 to 1 mm thick 4 mm
/// apart, and a round 1 mm peg (a 96-sided prism), all 4 mm tall, as one STL with separate solids.
fn plate() -> (Arc<Mesh>, Vec<Feature>) {
    let mut stl = String::from("solid thin\n");
    let mut features = Vec::new();
    let rect = |x0: f64, x1: f64, y0: f64, y1: f64| vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
    prism(&rect(-6.0, -4.0, 0.0, 10.0), &mut stl);
    let mut x = 0.0;
    for t in [0.25, 0.35, 0.45, 0.6, 0.8, 1.0] {
        prism(&rect(x, x + t, 0.0, 10.0), &mut stl);
        features.push(Feature {
            name: format!("fin {t}"),
            bbox: [x, x + t, 0.0, 10.0],
            area: t * 10.0,
        });
        x += t + 4.0;
    }
    let (cx, cy, r) = (x + 0.5, 5.0, 0.5);
    let ring: Vec<(f64, f64)> = (0..96)
        .map(|i| {
            let a = std::f64::consts::TAU * f64::from(i) / 96.0;
            (cx + r * a.cos(), cy + r * a.sin())
        })
        .collect();
    prism(&ring, &mut stl);
    // The polygon's own area, a hair under the circle's.
    let area = 48.0 * r * r * (std::f64::consts::TAU / 96.0).sin();
    features.push(Feature {
        name: "peg 1".into(),
        bbox: [cx - r, cx + r, cy - r, cy + r],
        area,
    });
    stl.push_str("endsolid thin\n");
    (
        Arc::new(Mesh::load(stl.as_bytes(), "thin.stl").unwrap()),
        features,
    )
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
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
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

/// Extrusions of the G-code: (layer Z, x0, y0, x1, y1, filament mm), for relative or absolute E.
fn extrusions(g: &str) -> Vec<(f64, f64, f64, f64, f64, f64)> {
    let (mut px, mut py, mut pz, mut pe) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut relative = false;
    let mut out = Vec::new();
    for line in g.lines() {
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
        match cmd {
            "M83" => relative = true,
            "M82" => relative = false,
            "G92" => {
                if let Some(v) = arg('E') {
                    pe = v;
                }
            }
            "G0" | "G1" => {
                let (nx, ny) = (arg('X').unwrap_or(px), arg('Y').unwrap_or(py));
                pz = arg('Z').unwrap_or(pz);
                if let Some(v) = arg('E') {
                    let de = if relative { v } else { v - pe };
                    pe = if relative { pe + v } else { v };
                    if de > 0.0 && (nx, ny) != (px, py) {
                        out.push((pz, px, py, nx, ny, de));
                    }
                }
                px = nx;
                py = ny;
            }
            _ => {}
        }
    }
    out
}

/// Per feature: (fill ratio per measured layer, layers with nothing printed). Layers from 1 to 2.6 mm, clear of
/// the bottom and top shells; the plate's place on the bed comes from the anchor block's outer wall, whose
/// center is half the outer wall width in from its left and front faces.
fn fill(g: &str, features: &[Feature]) -> BTreeMap<String, (Vec<f64>, usize)> {
    let ex = extrusions(g);
    let mid: Vec<_> = ex.iter().filter(|s| s.0 > 0.9 && s.0 < 2.7).collect();
    let mut zs: Vec<f64> = mid.iter().map(|s| s.0).collect();
    zs.sort_by(f64::total_cmp);
    zs.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    let x0 = mid.iter().map(|s| s.1.min(s.3)).fold(f64::MAX, f64::min) - 0.21 + 6.0;
    let y0 = mid.iter().map(|s| s.2.min(s.4)).fold(f64::MAX, f64::min) - 0.21;
    let filament = std::f64::consts::PI * 1.75 * 1.75 / 4.0;
    let mut out = BTreeMap::new();
    for f in features {
        let mut ratios = Vec::new();
        let mut empty = 0;
        for (i, &z) in zs.iter().enumerate().skip(1) {
            let h = z - zs[i - 1];
            let vol: f64 = mid
                .iter()
                .filter(|s| (s.0 - z).abs() < 1e-6)
                .filter(|s| {
                    let (mx, my) = (f64::midpoint(s.1, s.3) - x0, f64::midpoint(s.2, s.4) - y0);
                    mx >= f.bbox[0] - 0.3
                        && mx <= f.bbox[1] + 0.3
                        && my >= f.bbox[2] - 0.3
                        && my <= f.bbox[3] + 0.3
                })
                .map(|s| s.5 * filament)
                .sum();
            if vol == 0.0 {
                empty += 1;
            }
            ratios.push(vol / (f.area * h));
        }
        out.insert(f.name.clone(), (ratios, empty));
    }
    out
}

/// Two beads in a thin part fill it, under the precise outer wall too: before, two beads in a 0.8 mm fin kept the
/// ratio of the outer spacing to the outer to first inner spacing (13 percent narrower with the precise outer
/// wall), and in a 1 mm fin or peg kept their width, so the plastic missing lay along the faces and down the
/// middle. Every fin from 0.25 mm up still prints on every layer.
#[test]
fn aegis_fills_thin_fins_and_a_small_peg() {
    let (m, features) = plate();
    let mut wrong = Vec::new();
    for precise in [true, false] {
        let g = run(&m, precise);
        let fills = fill(&g, &features);
        for (name, (ratios, empty)) in &fills {
            let (lo, hi) = (
                ratios.iter().copied().fold(f64::MAX, f64::min),
                ratios.iter().copied().fold(f64::MIN, f64::max),
            );
            eprintln!("precise {precise}: {name} fill {lo:.3}..{hi:.3}, {empty} empty layers");
            if *empty > 0 || ratios.len() < 7 {
                wrong.push(format!(
                    "precise {precise}: {name} printed nothing on {empty} of {} layers",
                    ratios.len()
                ));
            }
            let band = match name.as_str() {
                "fin 0.8" | "fin 1" => Some((0.93, 1.05)),
                "peg 1" => Some((0.82, 1.05)),
                _ => None,
            };
            if let Some((want_lo, want_hi)) = band
                && (lo < want_lo || hi > want_hi)
            {
                wrong.push(format!(
                    "precise {precise}: {name} fill {lo:.3}..{hi:.3}, want {want_lo}..{want_hi}"
                ));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
