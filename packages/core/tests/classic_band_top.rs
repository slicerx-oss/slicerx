// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Top surfaces on the band layers of a ledge or taper over classic walls, on the stock P1S request
//! (fixtures/surface-walls/p1s-x-mark.json, 0.2 mm layers, 0.42 mm outer and 0.45 mm inner walls) with
//! `only_one_wall_top` off and a monotonic line top.
//!
//! A band layer's top strip is the part the layer above leaves uncovered. It is a top surface once the layer above's
//! outline lies inside the edge the internal solid infill starts at: the innermost wall's spacing edge less the
//! overlap of the mean of the inner wall's and the internal solid infill's spacings, from the outline 0.806, 0.747 and
//! 0.688 mm on 2 walls at 0, 15 and 30 percent and 1.213, 1.154 and 1.095 on 3. Before, the strip had to reach past
//! the walls' widths (the outer wall's width and an inner wall's per further wall, less the overlap of the line width),
//! 0.870, 0.807 and 0.744 on 2 walls and 1.320, 1.257 and 1.194 on 3, and a narrower strip printed as internal solid.
#![allow(
    clippy::cast_possible_truncation,
    clippy::disallowed_methods,
    reason = "a G-code reader for the test: filament in mm"
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

/// The band layers, thousandths of a millimeter.
const BANDS: [i64; 5] = [2200, 2400, 2600, 2800, 3000];

/// A 70 mm square part around the origin as ASCII STL, through `rings`: (z, how far in its sides are) from the bottom
/// up. Two rings at one height are a ledge.
fn part(rings: &[(f64, f64)]) -> Vec<u8> {
    let square = |(z, d): (f64, f64)| {
        let h = 35.0 - d;
        [(-h, -h, z), (h, -h, z), (h, h, z), (-h, h, z)]
    };
    let rings: Vec<_> = rings.iter().map(|&r| square(r)).collect();
    let mut out = String::from("solid part\n");
    let mut facet = |a: (f64, f64, f64), p: (f64, f64, f64), q: (f64, f64, f64)| {
        let _ = writeln!(out, "facet normal 0 0 0\n outer loop");
        for v in [a, p, q] {
            let _ = writeln!(out, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(out, " endloop\nendfacet");
    };
    let mut quad = |a, p, q, d| {
        facet(a, p, q);
        facet(a, q, d);
    };
    let (first, last) = (rings[0], rings[rings.len() - 1]);
    quad(first[0], first[3], first[2], first[1]);
    for pair in rings.windows(2) {
        let (lo, hi) = (pair[0], pair[1]);
        for i in 0..4 {
            let j = (i + 1) % 4;
            quad(lo[i], lo[j], hi[j], hi[i]);
        }
    }
    quad(last[0], last[1], last[2], last[3]);
    out.push_str("endsolid part\n");
    out.into_bytes()
}

/// A terrace: a 70 mm box to z 2.2, then five 0.2 mm layers whose sides step in by `start`, `start + 0.025` and so on
/// over the layer under each, to a flat top at z 3.2. The strip of band layer i (z 2.2 + 0.2 i) is start + 0.025 i.
fn terrace(start: f64) -> Vec<u8> {
    let mut rings = vec![(0.0, 0.0), (2.2, 0.0)];
    let mut d = 0.0;
    for i in 0..5 {
        let z = 2.2 + 0.2 * f64::from(i);
        d += start + 0.025 * f64::from(i);
        rings.push((z, d));
        rings.push((z + 0.2, d));
    }
    part(&rings)
}

/// A taper: a 70 mm box to z 2, then a frustum to z 3.2 whose sides step in by `step` mm per 0.2 mm layer.
fn taper(step: f64) -> Vec<u8> {
    part(&[(0.0, 0.0), (2.0, 0.0), (3.2, 6.0 * step)])
}

/// The G-code of the ASCII STL `stl` on `walls` classic walls at an infill wall overlap of `overlap` percent.
fn slice(stl: &[u8], walls: u32, overlap: f64) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    let config = &mut req["config"];
    config["wall_generator"] = json!("classic");
    config["only_one_wall_top"] = json!(false);
    config["top_surface_pattern"] = json!("monotonicline");
    config["wall_loops"] = json!(walls);
    config["infill_wall_overlap"] = json!(overlap);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let mesh = Arc::new(Mesh::load(stl, "part.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// A number after `key` in a G-code move.
fn word(code: &str, key: char) -> Option<f64> {
    code.split_whitespace()
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse::<f64>().ok()))
}

/// A feature or layer comment's value: `; FEATURE: x` or `;TYPE:x`, and so on.
fn comment<'a>(s: &'a str, keys: &[&str]) -> Option<&'a str> {
    let body = s.strip_prefix(';')?.trim_start();
    keys.iter()
        .find_map(|k| body.strip_prefix(k).and_then(|r| r.strip_prefix(':')))
        .map(str::trim)
}

/// Top surface filament per layer (relative extrusion) on moves that go somewhere, layers in thousandths of a millimeter.
fn top_per_layer(gcode: &str) -> BTreeMap<i64, f64> {
    let (mut feature, mut layer) = (String::new(), 0);
    let mut out = BTreeMap::new();
    for line in gcode.lines() {
        let text = line.trim();
        if let Some(f) = comment(text, &["TYPE", "FEATURE"]) {
            f.clone_into(&mut feature);
            continue;
        }
        if let Some(h) = comment(text, &["Z_HEIGHT", "Z"]).and_then(|v| v.parse::<f64>().ok()) {
            layer = (h * 1000.0).round() as i64;
            continue;
        }
        let code = text.split(';').next().unwrap_or("").trim();
        if feature != "Top surface"
            || !(code.starts_with("G1 ") || code.starts_with("G2 ") || code.starts_with("G3 "))
        {
            continue;
        }
        // Moves that go somewhere; an unretract is not part of the surface.
        let moved = word(code, 'X').is_some() || word(code, 'Y').is_some();
        if let Some(e) = word(code, 'E').filter(|e| *e > 0.0 && moved) {
            *out.entry(layer).or_default() += e;
        }
    }
    out
}

/// Top surface filament on each band layer.
fn bands(gcode: &str) -> [f64; 5] {
    let per = top_per_layer(gcode);
    BANDS.map(|z| per.get(&z).copied().unwrap_or(0.0))
}

/// The widest strip with no top surface and the narrowest with one, on 2 and 3 walls at 0, 15 and 30 percent: on
/// terraces whose strips are 0.025 mm apart, each band layer up to the edge prints none and each past it prints one.
/// Before, the edge was at the walls' widths: on 2 walls (0.850, 0.875], (0.800, 0.825] and (0.725, 0.750] where the
/// targets are (0.800, 0.825], (0.725, 0.750] and (0.675, 0.700], and on 3 walls (1.300, 1.325], (1.250, 1.275] and
/// (1.175, 1.200] where they are (1.200, 1.225], (1.150, 1.175] and (1.075, 1.100].
#[test]
fn a_classic_band_strip_is_a_top_surface_past_the_internal_solid_edge() {
    // (walls, overlap, the terrace's first strip, the last strip with no top surface)
    let cases = [
        (2, 0.0, 0.725, 0.800),
        (2, 15.0, 0.725, 0.725),
        (2, 30.0, 0.600, 0.675),
        (3, 0.0, 1.200, 1.200),
        (3, 15.0, 1.075, 1.150),
        (3, 30.0, 1.075, 1.075),
    ];
    let mut misses = Vec::new();
    for (walls, overlap, start, last_none) in cases {
        let got = bands(&slice(&terrace(start), walls, overlap));
        for (i, e) in (0_u32..).zip(&got) {
            let strip = start + 0.025 * f64::from(i);
            let want_top = strip > last_none + 0.01;
            if (*e > 0.5) != want_top {
                misses.push(format!(
                    "{walls} walls, {overlap} percent, strip {strip:.3}: top surface {e:.2}, wanted {}",
                    if want_top { "one" } else { "none" }
                ));
            }
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}

/// Top surface filament on each band layer of the 70 mm taper at 15 percent, within 0.05 mm of the targets: at a step
/// of 0.8 mm 29.39 to 26.55 on 2 walls and none on 3; at 1.2 and 1.6 on both. A step of 0.5 prints none. Before, the
/// 0.8 step printed none on 2 walls and the 1.2 step none on 3 walls; the same filament went out as internal solid.
#[test]
fn a_classic_taper_prints_its_top_band_at_the_targets() {
    let none = [0.0; 5];
    let cases: [(f64, u32, [f64; 5]); 8] = [
        (0.5, 2, none),
        (0.5, 3, none),
        (0.8, 2, [29.39, 28.68, 27.97, 27.26, 26.55]),
        (0.8, 3, none),
        (1.2, 2, [37.55, 36.18, 34.79, 33.43, 32.03]),
        (1.2, 3, [40.54, 39.02, 37.52, 35.99, 34.50]),
        (1.6, 2, [45.53, 43.27, 41.02, 38.76, 36.51]),
        (1.6, 3, [48.32, 45.89, 43.46, 41.03, 38.60]),
    ];
    let mut misses = Vec::new();
    for (step, walls, want) in cases {
        let got = bands(&slice(&taper(step), walls, 15.0));
        if got.iter().zip(&want).any(|(g, w)| (g - w).abs() > 0.05) {
            misses.push(format!("step {step}, {walls} walls: {got:.2?}, target {want:?}"));
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}
