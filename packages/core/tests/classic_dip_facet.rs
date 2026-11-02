// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The classic one-wall top band along a corner facet that steps in a little less than the sides, against measured
//! targets, on the stock P1S request (fixtures/surface-walls/p1s-x-mark.json: classic walls, `only_one_wall_top`,
//! 0.42 mm outer walls and top surface, 0.45 mm inner walls, 0.2 mm layers, two loops, 15% infill wall overlap,
//! `precise_outer_wall` off).
//!
//! The part is a 30 mm square box 2 mm tall with its four corners cut by facets 5 mm long, under three 0.2 mm sloped
//! layers to z 2.6. Each side steps in 0.75 mm per layer and each facet less, under the band's cut-off, so the facet
//! gets no band of its own and only the tails of the sides' bands run onto it. Those tails stop short of the facet's
//! middle: on the band layers z 2.2 and 2.4 the top surface stays within 0.19 mm of filament per layer of its target on
//! facets at 30 degrees stepping 0.60 mm, and within 0.18 on facets at 45 degrees stepping 0.64 mm.
//!
//! Filament is E mm of 1.75 mm filament per layer.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    reason = "a G-code reader for the test: filament lengths in mm"
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
const TOP: &str = "Top surface";

/// The G-code of the stock P1S request with classic walls, printing `mesh` at the middle of the bed.
fn slice(mesh: Arc<Mesh>) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!("classic");
    req["config"]["precise_outer_wall"] = json!(false);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// The `outline` with each edge moved in by its entry in `by`: each corner is where the moved edges either side of
/// it meet.
fn inset(outline: &[(f64, f64)], by: &[f64]) -> Vec<(f64, f64)> {
    let count = outline.len();
    let line = |edge: usize| {
        let (from, to) = (outline[edge], outline[(edge + 1) % count]);
        let (ex, ey) = (to.0 - from.0, to.1 - from.1);
        let len = ex.hypot(ey);
        (
            (from.0 - ey / len * by[edge], from.1 + ex / len * by[edge]),
            (ex, ey),
        )
    };
    (0..count)
        .map(|edge| {
            let ((p1, d1), (p2, d2)) = (line((edge + count - 1) % count), line(edge));
            let along = ((p2.0 - p1.0) * d2.1 - (p2.1 - p1.1) * d2.0) / (d1.0 * d2.1 - d1.1 * d2.0);
            (d1.0.mul_add(along, p1.0), d1.1.mul_add(along, p1.1))
        })
        .collect()
}

/// A 30 mm square box from z 0 to 2, centered, with each corner cut by a facet `len` mm long at `angle` degrees to
/// the side it meets going round, under a slope to z 2.6 that steps in 0.75 mm per 0.2 mm layer on the sides and
/// `facet` mm on the facets.
fn corner(angle: f64, len: f64, facet: f64) -> Arc<Mesh> {
    let (dx, dy) = (len * angle.to_radians().sin(), len * angle.to_radians().cos());
    let base = [
        (dx - 15.0, -15.0),
        (15.0 - dy, -15.0),
        (15.0, dx - 15.0),
        (15.0, 15.0 - dy),
        (15.0 - dx, 15.0),
        (dy - 15.0, 15.0),
        (-15.0, 15.0 - dx),
        (-15.0, dy - 15.0),
    ];
    let top = inset(&base, &[3.0 * 0.75, 3.0 * facet].repeat(4));
    let at = |p: &[(f64, f64)], z: f64| p.iter().map(|&(x, y)| (x, y, z)).collect::<Vec<_>>();
    let rings = [at(&base, 0.0), at(&base, 2.0), at(&top, 2.6)];
    let n = base.len();
    let mut tris = Vec::new();
    for i in 1..n - 1 {
        tris.push([rings[0][0], rings[0][i + 1], rings[0][i]]);
        tris.push([rings[2][0], rings[2][i], rings[2][i + 1]]);
    }
    for r in 0..2 {
        let (lo, hi) = (&rings[r], &rings[r + 1]);
        for i in 0..n {
            let j = (i + 1) % n;
            tris.push([lo[i], lo[j], hi[j]]);
            tris.push([lo[i], hi[j], hi[i]]);
        }
    }
    let mut text = String::from("solid corner\n");
    for tri in &tris {
        let _ = writeln!(text, "facet normal 0 0 0\n outer loop");
        for v in tri {
            let _ = writeln!(text, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(text, " endloop\nendfacet");
    }
    let _ = writeln!(text, "endsolid corner");
    Arc::new(Mesh::load(text.as_bytes(), "corner.stl").unwrap())
}

fn word(code: &str, key: char) -> Option<f64> {
    code.split_whitespace()
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse().ok()))
}

/// Top surface filament per layer (z in hundredths of a mm).
fn tops(gcode: &str) -> BTreeMap<i64, f64> {
    let (mut feature, mut z, mut at) = (String::new(), 0i64, (0.0, 0.0));
    let mut out = BTreeMap::new();
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
            && feature == TOP
        {
            *out.entry(z).or_insert(0.0) += e;
        }
        at = to;
    }
    out
}

/// The band layers' top surface of the corner part (`angle`, `len`, `facet`) against `targets` at z 2.2 and 2.4:
/// at most `over` mm of filament per layer more, and at most 0.20 less.
fn check(angle: f64, len: f64, facet: f64, targets: [f64; 2], over: f64) {
    let layers = tops(&slice(corner(angle, len, facet)));
    let mut misses = Vec::new();
    for (z, want) in [220, 240].into_iter().zip(targets) {
        let got = layers.get(&z).copied().unwrap_or(0.0);
        let d = got - want;
        if d >= over || d < -0.20 {
            misses.push(format!(
                "z {:.1}: top surface {got:.2}, target {want} ({d:+.2}, want under +{over} and at least -0.20)",
                f64::from(z as i32) / 100.0
            ));
        }
    }
    assert!(misses.is_empty(), "{}", misses.join("\n"));
}

#[test]
fn a_30_degree_facet_stepping_under_the_sides_keeps_its_band_near_the_target() {
    check(30.0, 5.0, 0.60, [9.25, 9.20], 0.19);
}

#[test]
fn a_45_degree_facet_stepping_under_the_sides_keeps_its_band_near_the_target() {
    check(45.0, 5.0, 0.64, [8.99, 9.01], 0.18);
}
