// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Which way the strands of the first internal bridge of a stack run, on the stock P1S request with classic walls
//! (fixtures/surface-walls/p1s-x-mark.json: two loops, 15% grid sparse infill at 45 degrees, 5 top layers, 0.2 mm).
//!
//! The shapes are a 30 mm square box under a frustum that steps in `s` mm per side on every 0.2 mm layer (the taper,
//! s 1.2 unless named), the same turned 30 degrees, a round one (the cone), and the x-mark.
//!
//! The rule: the strands take the direction most of the bridge outline votes for, across the sparse lines nearest to
//! it. Where that vote is a near tie between the two line families of the sparse grid (within 10 percent of their sum)
//! on the first bridge of a stack, and no strand would land on solid infill below at both ends, the strands cross the
//! grid along the family nearest the x axis, 135 degrees on a 45 degree grid. A square frame over a 45 degree grid
//! votes almost evenly, and before this rule the pick depended on where each outline ring started.
//!
//! An angle is the length-weighted direction of the bridge moves of 1 mm or more on a layer, in whole degrees from 0
//! to 179.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    reason = "a G-code reader for the test"
)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

const REQUEST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/surface-walls/p1s-x-mark.json"
);

/// The G-code of the stock P1S request with classic walls and `edits` to its config, printing `mesh`.
fn slice(mesh: Arc<Mesh>, edits: &[(&str, Value)]) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!("classic");
    for (k, v) in edits {
        req["config"][*k] = v.clone();
    }
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// A mesh from triangles.
fn mesh(tris: &[[(f64, f64, f64); 3]]) -> Arc<Mesh> {
    let mut text = String::from("solid shape\n");
    for tri in tris {
        let _ = writeln!(text, "facet normal 0 0 0\n outer loop");
        for v in tri {
            let _ = writeln!(text, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(text, " endloop\nendfacet");
    }
    let _ = writeln!(text, "endsolid shape");
    Arc::new(Mesh::load(text.as_bytes(), "shape.stl").unwrap())
}

/// A prism of `ring` (counterclockwise points around the origin at half width 15 mm) from z 0 to `base`, under a
/// frustum to the ring scaled to half width `top` at `base + 2`.
fn frustum(ring: &[(f64, f64)], base: f64, top: f64) -> Arc<Mesh> {
    let at = |k: f64, z: f64| ring.iter().map(|&(x, y)| (x * k, y * k, z)).collect::<Vec<_>>();
    let rings = [at(1.0, 0.0), at(1.0, base), at(top / 15.0, base + 2.0)];
    let n = ring.len();
    let (b, t) = (&rings[0], &rings[2]);
    let mut tris = Vec::new();
    for i in 1..n - 1 {
        tris.push([b[0], b[i + 1], b[i]]);
        tris.push([t[0], t[i], t[i + 1]]);
    }
    for r in 0..2 {
        let (lo, hi) = (&rings[r], &rings[r + 1]);
        for i in 0..n {
            let j = (i + 1) % n;
            tris.push([lo[i], lo[j], hi[j]]);
            tris.push([lo[i], hi[j], hi[i]]);
        }
    }
    mesh(&tris)
}

/// The taper: a 30 mm square box from z 0 to 2 under a frustum stepping in `s` mm per side per 0.2 mm layer for
/// 2 mm, turned `turn` degrees about its center.
fn taper(s: f64, turn: f64) -> Arc<Mesh> {
    let (c, si) = (turn.to_radians().cos(), turn.to_radians().sin());
    let sq = [(-15.0, -15.0), (15.0, -15.0), (15.0, 15.0), (-15.0, 15.0)]
        .map(|(x, y)| (x * c - y * si, x * si + y * c));
    frustum(&sq, 2.0, 10.0f64.mul_add(-s, 15.0))
}

/// The cone: a 96-gon of radius 15 mm to z 2 under a frustum to radius 3 mm at z 4.
fn cone() -> Arc<Mesh> {
    let ring: Vec<(f64, f64)> = (0..96)
        .map(|i| {
            let a = f64::from(i) * std::f64::consts::TAU / 96.0;
            (15.0 * a.cos(), 15.0 * a.sin())
        })
        .collect();
    frustum(&ring, 2.0, 3.0)
}

fn x_mark() -> Arc<Mesh> {
    let stl = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/bench/models/x-mark.stl")).unwrap();
    Arc::new(Mesh::load(&stl, "x-mark.stl").unwrap())
}

fn word(code: &str, key: char) -> Option<f64> {
    code.split_whitespace()
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse().ok()))
}

/// One layer's bridges: the strand direction (whole degrees, 0 to 179) and the filament, mm.
#[derive(Debug, Clone, Copy)]
struct Layer {
    angle: i64,
    e: f64,
}

/// The bridges by layer, internal bridges included (z in hundredths of a mm).
fn bridges(gcode: &str) -> BTreeMap<i64, Layer> {
    let (mut feature, mut z, mut at) = (String::new(), 0i64, (0.0, 0.0));
    let mut dirs: BTreeMap<i64, BTreeMap<i64, f64>> = BTreeMap::new();
    let mut fil: BTreeMap<i64, f64> = BTreeMap::new();
    for line in gcode.lines() {
        let s = line.trim();
        if let Some(f) = s.strip_prefix("; FEATURE:").or_else(|| s.strip_prefix(";TYPE:")) {
            f.trim().clone_into(&mut feature);
            continue;
        }
        if let Some(h) = s.strip_prefix("; Z_HEIGHT:").or_else(|| s.strip_prefix(";Z:")) {
            z = (h.trim().parse::<f64>().unwrap() * 100.0).round() as i64;
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|g| code.starts_with(g)) {
            continue;
        }
        let to = (word(code, 'X').unwrap_or(at.0), word(code, 'Y').unwrap_or(at.1));
        if let Some(e) = word(code, 'E').filter(|e| *e > 0.0)
            && to != at
            && (feature == "Bridge" || feature == "Internal Bridge")
        {
            *fil.entry(z).or_insert(0.0) += e;
            let (dx, dy) = (to.0 - at.0, to.1 - at.1);
            let len = dx.hypot(dy);
            if len >= 1.0 {
                let a = (dy.atan2(dx).to_degrees().round() as i64).rem_euclid(180);
                *dirs.entry(z).or_default().entry(a).or_insert(0.0) += len;
            }
        }
        at = to;
    }
    fil.into_iter()
        .map(|(z, e)| {
            let angle = dirs
                .get(&z)
                .and_then(|d| d.iter().max_by(|a, b| a.1.total_cmp(b.1)).map(|(a, _)| *a))
                .unwrap_or(-1);
            (z, Layer { angle, e })
        })
        .collect()
}

/// How far apart two strand directions are, degrees.
fn apart(a: i64, b: i64) -> i64 {
    let d = (a - b).rem_euclid(180);
    d.min(180 - d)
}

/// Each `(z, angle)` within 2 degrees, every miss listed.
fn check(name: &str, layers: &BTreeMap<i64, Layer>, want: &[(f64, i64)]) {
    let mut misses = Vec::new();
    for &(z, a) in want {
        match layers.get(&((z * 100.0).round() as i64)) {
            Some(l) if apart(l.angle, a) <= 2 => {}
            Some(l) => misses.push(format!("z {z:.1}: strands at {}, want {a}", l.angle)),
            None => misses.push(format!("z {z:.1}: no bridge, want one at {a}")),
        }
    }
    assert!(
        misses.is_empty(),
        "{name}:\n{}\nall: {layers:?}",
        misses.join("\n")
    );
}

/// Each `(z, filament)` within 0.15 mm, every miss listed.
fn check_e(name: &str, layers: &BTreeMap<i64, Layer>, want: &[(f64, f64)]) {
    let misses: Vec<String> = want
        .iter()
        .filter_map(|&(z, e)| {
            let got = layers.get(&((z * 100.0).round() as i64)).map_or(0.0, |l| l.e);
            ((got - e).abs() > 0.15).then(|| format!("z {z:.1}: bridge {got:.2}, want {e}"))
        })
        .collect();
    assert!(
        misses.is_empty(),
        "{name}:\n{}\nall: {layers:?}",
        misses.join("\n")
    );
}

#[test]
fn the_first_bridge_of_a_lone_stack_over_a_45_degree_grid_runs_at_135() {
    let taper_layers = bridges(&slice(taper(1.2, 0.0), &[]));
    check("taper", &taper_layers, &[(1.4, 135)]);
    // The direction leaves the bridged amount alone: the same filament as along the other family.
    check_e("taper", &taper_layers, &[(1.4, 54.62)]);
    check(
        "turned taper",
        &bridges(&slice(taper(1.2, 30.0), &[])),
        &[(1.4, 135)],
    );
    check("cone", &bridges(&slice(cone(), &[])), &[(1.4, 135)]);
    for (s, z) in [(1.4, 1.2), (1.0, 1.4), (0.9, 1.4)] {
        check(
            &format!("taper s {s}"),
            &bridges(&slice(taper(s, 0.0), &[])),
            &[(z, 135)],
        );
    }
}

#[test]
fn other_grids_cross_the_family_nearest_the_x_axis() {
    for (dir, want) in [(0, 0), (30, 30), (60, 150)] {
        let layers = bridges(&slice(taper(1.2, 0.0), &[("infill_direction", json!(dir))]));
        check(&format!("{dir} degree grid"), &layers, &[(1.4, want)]);
    }
}

#[test]
fn later_bridges_and_first_bridges_over_solid_keep_the_vote() {
    // The later bridges of the taper stack follow the vote over the frame the first one leaves.
    let taper_layers = bridges(&slice(taper(1.2, 0.0), &[]));
    check("taper", &taper_layers, &[(1.8, 0), (2.2, 0), (2.6, 0)]);
    check_e(
        "taper",
        &taper_layers,
        &[(1.8, 49.97), (2.2, 38.57), (2.6, 25.16)],
    );
    // The x-mark with classic walls: its first bridge at z 5.0 lands on the solid ring below and keeps the vote (45),
    // and z 5.2 above it keeps the vote too. With aegis walls z 5.2 starts the stack over solid and keeps the vote.
    let classic = bridges(&slice(x_mark(), &[]));
    check("x-mark classic", &classic, &[(5.0, 45), (5.2, 135)]);
    let aegis = bridges(&slice(x_mark(), &[("wall_generator", json!("aegis"))]));
    check("x-mark aegis", &aegis, &[(5.2, 135)]);
    // The lone small bridge high up votes almost evenly with both walls and now crosses the grid at 135 with both.
    check("x-mark classic high", &classic, &[(58.4, 135)]);
    check("x-mark aegis high", &aegis, &[(58.4, 135)]);
}
