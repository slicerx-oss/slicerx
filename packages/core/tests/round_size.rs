// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Round pegs and holes print at their size with aegis and arachne walls: 2 and 5 mm pegs, and 2 and 5 mm round
//! holes through a block, with the stock 0.42 and 0.45 mm walls, resolution 0.012 and wall deviation 0.025, arc
//! fitting on and off. The printed edge of the outer wall (its centerline plus half its width on a peg, minus half
//! on a hole, averaged along the loop) sits within 0.009 mm of the nominal radius, so the diameter is within
//! 0.018 mm. Before, the wall outline was simplified to the wall deviation (0.025 mm), which cut chords up to that
//! deep into every circle, and these pegs and holes printed 0.02 to 0.03 mm small.

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::many_single_char_names
)]
// Checks measure the output with the standard math functions; the engine's own rounding rule (clippy.toml) is for G-code.
#![allow(clippy::disallowed_methods)]

use serde_json::json;
use std::fmt::Write as _;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

const HEIGHT: f64 = 4.0;
/// Sides of the round meshes, vertices on the circle (the mesh itself is about 0.001 mm small at 5 mm).
const SIDES: u32 = 128;
/// Largest diameter error allowed, mm.
const BOUND: f64 = 0.018;

/// One round feature: name, center in plate coordinates, radius, peg or hole.
struct Round {
    name: String,
    c: (f64, f64),
    r: f64,
    peg: bool,
}

/// Facets of a closed prism between the counterclockwise `outer` ring and the clockwise `hole` rings (none for a
/// solid), `HEIGHT` tall. Caps are fans over the ring pairs: each hole ring has as many points as the outer one.
fn prism(outer: &[(f64, f64)], hole: Option<&[(f64, f64)]>, out: &mut String) {
    let mut facet = |a: (f64, f64, f64), b: (f64, f64, f64), d: (f64, f64, f64)| {
        let _ = writeln!(out, "facet normal 0 0 0\n outer loop");
        for v in [a, b, d] {
            let _ = writeln!(out, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(out, " endloop\nendfacet");
    };
    let mut side = |ring: &[(f64, f64)]| {
        let n = ring.len();
        for i in 0..n {
            let (a, b) = (ring[i], ring[(i + 1) % n]);
            facet((a.0, a.1, 0.0), (b.0, b.1, 0.0), (b.0, b.1, HEIGHT));
            facet((a.0, a.1, 0.0), (b.0, b.1, HEIGHT), (a.0, a.1, HEIGHT));
        }
    };
    side(outer);
    if let Some(h) = hole {
        side(h);
    }
    let n = outer.len();
    match hole {
        None => {
            let c = (
                outer.iter().map(|p| p.0).sum::<f64>() / n as f64,
                outer.iter().map(|p| p.1).sum::<f64>() / n as f64,
            );
            for i in 0..n {
                let (a, b) = (outer[i], outer[(i + 1) % n]);
                facet((c.0, c.1, 0.0), (b.0, b.1, 0.0), (a.0, a.1, 0.0));
                facet((c.0, c.1, HEIGHT), (a.0, a.1, HEIGHT), (b.0, b.1, HEIGHT));
            }
        }
        Some(h) => {
            // The hole ring runs clockwise; walk it backwards beside the outer ring.
            for i in 0..n {
                let (a, b) = (outer[i], outer[(i + 1) % n]);
                let (p, q) = (h[(n - i) % n], h[(2 * n - i - 1) % n]);
                for z in [0.0, HEIGHT] {
                    let up = z > 0.0;
                    let t1 = [(a.0, a.1, z), (b.0, b.1, z), (q.0, q.1, z)];
                    let t2 = [(a.0, a.1, z), (q.0, q.1, z), (p.0, p.1, z)];
                    for t in [t1, t2] {
                        if up {
                            facet(t[0], t[1], t[2]);
                        } else {
                            facet(t[0], t[2], t[1]);
                        }
                    }
                }
            }
        }
    }
}

fn circle(c: (f64, f64), r: f64, n: u32, ccw: bool) -> Vec<(f64, f64)> {
    (0..n)
        .map(|i| {
            let k = if ccw { f64::from(i) } else { -f64::from(i) };
            let a = std::f64::consts::TAU * k / f64::from(n);
            (c.0 + r * a.cos(), c.1 + r * a.sin())
        })
        .collect()
}

/// The plate: a 2 x 12 mm anchor block whose outer wall places the plate, pegs of 2 and 5 mm, and blocks with a
/// 2 and a 5 mm hole through them, all 4 mm tall, as one STL with separate solids. A holed block's outer ring
/// is a circle of as many points as the hole, 3 mm out from it.
fn plate() -> (Arc<Mesh>, Vec<Round>) {
    let mut stl = String::from("solid round\n");
    let mut features = Vec::new();
    prism(
        &[(-6.0, 0.0), (-4.0, 0.0), (-4.0, 12.0), (-6.0, 12.0)],
        None,
        &mut stl,
    );
    let mut x = 0.0;
    for d in [2.0f64, 5.0] {
        let r = d / 2.0;
        let c = (x + r, 6.0);
        prism(&circle(c, r, SIDES, true), None, &mut stl);
        features.push(Round {
            name: format!("peg {d}"),
            c,
            r,
            peg: true,
        });
        x += d + 4.0;
    }
    for d in [2.0f64, 5.0] {
        let r = d / 2.0;
        let c = (x + r + 3.0, 6.0);
        prism(
            &circle(c, r + 3.0, SIDES, true),
            Some(&circle(c, r, SIDES, false)),
            &mut stl,
        );
        features.push(Round {
            name: format!("hole {d}"),
            c,
            r,
            peg: false,
        });
        x += d + 6.0 + 4.0;
    }
    stl.push_str("endsolid round\n");
    (
        Arc::new(Mesh::load(stl.as_bytes(), "round.stl").unwrap()),
        features,
    )
}

/// The stock A1 0.4 walls with the wall generator `wall_generator` and arc fitting on or off.
fn run(m: &Arc<Mesh>, wall_generator: &str, arcs: bool) -> String {
    run_with(m, wall_generator, arcs, &json!({}))
}

/// [`run`] with the keys of `extra` over its settings.
fn run_with(m: &Arc<Mesh>, wall_generator: &str, arcs: bool, extra: &serde_json::Value) -> String {
    let mut config = json!({
        "wall_generator": wall_generator,
        "wall_loops": 2,
        "outer_wall_line_width": 0.42,
        "inner_wall_line_width": 0.45,
        "wall_sequence": "inner wall/outer wall",
        "precise_outer_wall": true,
        "resolution": 0.012,
        "wall_maximum_resolution": 0.5,
        "wall_maximum_deviation": 0.025,
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "enable_arc_fitting": arcs,
        "brim_type": "no_brim",
        "brim_width": 0,
        "slow_down_for_layer_cooling": false,
    });
    if let (Some(dst), Some(src)) = (config.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    let req: SliceRequest =
        serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
    let m = m.clone();
    let run = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// Outer wall extrusions between z 0.9 and 2.7 mm as points every 0.005 mm along lines and arcs:
/// (layer z, x, y, length, line width).
fn outer_wall_points(g: &str) -> Vec<(f64, f64, f64, f64, f64)> {
    let (mut x, mut y, mut z, mut w) = (0.0f64, 0.0f64, 0.0f64, 0.42f64);
    let mut outer = false;
    let mut out = Vec::new();
    for line in g.lines() {
        if let Some(f) = line.strip_prefix(";TYPE:") {
            outer = f.trim() == "Outer wall";
            continue;
        }
        if let Some(v) = line.strip_prefix(";WIDTH:") {
            w = v.trim().parse().unwrap_or(w);
            continue;
        }
        let code = line.split(';').next().unwrap_or("").trim();
        let mut words = code.split_whitespace();
        let Some(cmd) = words.next() else {
            continue;
        };
        if !matches!(cmd, "G0" | "G1" | "G2" | "G3") {
            continue;
        }
        let arg = |k: char| -> Option<f64> {
            code.split_whitespace()
                .skip(1)
                .find(|s| s.starts_with(k))
                .and_then(|s| s[1..].parse().ok())
        };
        let (nx, ny) = (arg('X').unwrap_or(x), arg('Y').unwrap_or(y));
        z = arg('Z').unwrap_or(z);
        let extruding = arg('E').is_some_and(|e| e > 0.0) && (nx, ny) != (x, y);
        if outer && extruding && z > 0.9 && z < 2.7 {
            if cmd == "G0" || cmd == "G1" {
                let len = (nx - x).hypot(ny - y);
                let k = ((len / 0.005) as usize).max(1);
                for i in 0..k {
                    let t = (i as f64 + 0.5) / k as f64;
                    out.push((z, x + (nx - x) * t, y + (ny - y) * t, len / k as f64, w));
                }
            } else {
                let (cx, cy) = (x + arg('I').unwrap_or(0.0), y + arg('J').unwrap_or(0.0));
                let r = (x - cx).hypot(y - cy);
                let a0 = (y - cy).atan2(x - cx);
                let mut da = (ny - cy).atan2(nx - cx) - a0;
                if cmd == "G3" {
                    while da <= 0.0 {
                        da += std::f64::consts::TAU;
                    }
                } else {
                    while da >= 0.0 {
                        da -= std::f64::consts::TAU;
                    }
                }
                let len = da.abs() * r;
                let k = ((len / 0.005) as usize).max(1);
                for i in 0..k {
                    let a = a0 + da * (i as f64 + 0.5) / k as f64;
                    out.push((z, cx + r * a.cos(), cy + r * a.sin(), len / k as f64, w));
                }
            }
        }
        x = nx;
        y = ny;
    }
    out
}

/// Per feature, the printed diameter minus the nominal one: twice the length-weighted mean edge radius on each
/// layer, the median over layers. The plate's place on the bed comes from the anchor block's outer wall, whose
/// center is half the outer wall width in from its left and front faces.
fn errors(g: &str, features: &[Round]) -> Vec<(String, f64)> {
    let pts = outer_wall_points(g);
    let x0 = pts.iter().map(|p| p.1).fold(f64::MAX, f64::min) - 0.21 + 6.0;
    let y0 = pts.iter().map(|p| p.2).fold(f64::MAX, f64::min) - 0.21;
    let mut zs: Vec<f64> = pts.iter().map(|p| p.0).collect();
    zs.sort_by(f64::total_cmp);
    zs.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    features
        .iter()
        .map(|f| {
            let mut per_layer: Vec<f64> = zs
                .iter()
                .filter_map(|&z| {
                    let (mut sum, mut len) = (0.0, 0.0);
                    for p in pts.iter().filter(|p| (p.0 - z).abs() < 1e-6) {
                        let rho = (p.1 - x0 - f.c.0).hypot(p.2 - y0 - f.c.1);
                        if (rho - f.r).abs() > 0.6 {
                            continue;
                        }
                        let edge = if f.peg { rho + p.4 / 2.0 } else { rho - p.4 / 2.0 };
                        sum += edge * p.3;
                        len += p.3;
                    }
                    (len > 0.0).then(|| 2.0 * sum / len - 2.0 * f.r)
                })
                .collect();
            per_layer.sort_by(f64::total_cmp);
            let err = per_layer.get(per_layer.len() / 2).copied().unwrap_or(f64::NAN);
            (f.name.clone(), err)
        })
        .collect()
}

/// The outer wall of a round peg or hole keeps the circle's size: the wall outline is simplified no further
/// than the resolution, so its chords cut at most 0.012 mm into the circle instead of 0.025 mm.
#[test]
fn round_pegs_and_holes_print_at_size() {
    let (m, features) = plate();
    let mut wrong = Vec::new();
    for generator in ["aegis", "arachne"] {
        for arcs in [true, false] {
            let g = run(&m, generator, arcs);
            for (name, err) in errors(&g, &features) {
                eprintln!("{generator} arcs {arcs}: {name} diameter error {err:+.4} mm");
                if err.is_nan() || err.abs() > BOUND {
                    wrong.push(format!(
                        "{generator} arcs {arcs}: {name} diameter error {err:+.4} mm, want within {BOUND}"
                    ));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// A profile with a 0.001 mm slice resolution (some stock processes set it) simplifies its walls at 0.01 mm, not
/// 0.001 mm: the G-code is the same as with the wall deviation set to 0.01 mm, and smaller than with it at 0.001 mm,
/// where every wall would keep all its points. Round sizes still hold there.
#[test]
fn a_fine_resolution_simplifies_walls_at_the_floor() {
    let (m, features) = plate();
    for generator in ["aegis", "arachne"] {
        let fine = |deviation: f64| {
            run_with(
                &m,
                generator,
                false,
                &json!({"resolution": 0.001, "wall_maximum_deviation": deviation}),
            )
        };
        let (stock, floor, finest) = (fine(0.025), fine(0.01), fine(0.001));
        assert!(
            stock == floor,
            "{generator}: resolution 0.001 with deviation 0.025 differs from deviation 0.01"
        );
        eprintln!(
            "{generator}: {} bytes at the floor, {} with a 0.001 mm deviation",
            floor.len(),
            finest.len()
        );
        assert!(
            floor.len() < finest.len(),
            "{generator}: {} bytes at the floor, {} at 0.001",
            floor.len(),
            finest.len()
        );
        for (name, err) in errors(&stock, &features) {
            assert!(
                err.abs() <= BOUND,
                "{generator}: {name} diameter error {err:+.4} mm at resolution 0.001"
            );
        }
    }
}
