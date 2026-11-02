// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where the internal bridges under a steep classic taper start, against measured targets. The taper is a 30 mm square
//! box to z 2 under a frustum that steps in `s` mm per side on every 0.2 mm layer, to (30 - 20 s) mm at z 4, on the
//! stock P1S request with classic walls (fixtures/surface-walls/p1s-x-mark.json: two loops, 0.45 mm inner walls,
//! 0.42 mm internal solid infill, 5 top and 3 bottom layers, 15% sparse and infill wall overlap, `only_one_wall_top`).
//!
//! The lowest shell layer under the slope, z 1.4, bridges from a step of about 0.68 mm. A second bridge, at z 1.8,
//! starts a chain of bridges on every other layer (z 1.8, 2.2, 2.6, 3.0) at a step that follows the slit the one-wall
//! top layers leave beside their inner walls: the inner wall's spacing less the infill wall overlap's share of the
//! inner wall's and the internal solid infill's spacings, plus 0.477 mm. So it starts at 0.77 on the stock settings,
//! 0.74 with 0.42 mm inner walls, 0.85 with 0.55 mm ones, 0.885 at 0% overlap, 0.805 at 10% and 0.80 with 0.45 mm
//! internal solid infill. With one wall or three the chain starts at 1.15 as before, and at 30% overlap, where the
//! slit is too narrow to count, z 1.8 does not bridge by s 0.9.
//!
//! Filament is E mm of 1.75 mm filament per feature per layer.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::float_cmp,
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
const BRIDGE: &str = "Bridge";

/// The G-code of the stock P1S request with classic walls and `edits` to its config, printing `mesh` at the middle
/// of the bed.
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

/// The taper stepping in `s` mm per side per 0.2 mm layer: a 30 mm square box from z 0 to 2 under a frustum from
/// 30 mm at z 2 to (30 - 20 s) mm at z 4, centered.
fn taper(s: f64) -> Arc<Mesh> {
    let sq = |h: f64, z: f64| [(-h, -h, z), (h, -h, z), (h, h, z), (-h, h, z)];
    let rings = [sq(15.0, 0.0), sq(15.0, 2.0), sq(10.0f64.mul_add(-s, 15.0), 4.0)];
    let mut tris = Vec::new();
    let (b, t) = (rings[0], rings[2]);
    tris.push([b[0], b[2], b[1]]);
    tris.push([b[0], b[3], b[2]]);
    tris.push([t[0], t[1], t[2]]);
    tris.push([t[0], t[2], t[3]]);
    for r in 0..2 {
        let (lo, hi) = (rings[r], rings[r + 1]);
        for i in 0..4 {
            let j = (i + 1) % 4;
            tris.push([lo[i], lo[j], hi[j]]);
            tris.push([lo[i], hi[j], hi[i]]);
        }
    }
    let mut text = String::from("solid taper\n");
    for tri in &tris {
        let _ = writeln!(text, "facet normal 0 0 0\n outer loop");
        for v in tri {
            let _ = writeln!(text, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(text, " endloop\nendfacet");
    }
    let _ = writeln!(text, "endsolid taper");
    Arc::new(Mesh::load(text.as_bytes(), "taper.stl").unwrap())
}

fn word(code: &str, key: char) -> Option<f64> {
    code.split_whitespace()
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse().ok()))
}

/// Bridge filament per layer (z in hundredths of a mm), internal bridges included.
fn bridges(gcode: &str) -> BTreeMap<i64, f64> {
    let (mut feature, mut z, mut at) = (String::new(), 0i64, (0.0, 0.0));
    let mut out = BTreeMap::new();
    for line in gcode.lines() {
        let s = line.trim();
        if let Some(f) = s.strip_prefix("; FEATURE:").or_else(|| s.strip_prefix(";TYPE:")) {
            feature = match f.trim() {
                "Internal Bridge" => BRIDGE.to_owned(),
                other => other.to_owned(),
            };
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
            && feature == BRIDGE
        {
            *out.entry(z).or_insert(0.0) += e;
        }
        at = to;
    }
    out
}

fn bridge_at(layers: &BTreeMap<i64, f64>, z: f64) -> f64 {
    layers.get(&((z * 100.0).round() as i64)).copied().unwrap_or(0.0)
}

/// The z 1.8 bridge of the taper stepping `s` with `edits`.
fn second_bridge(s: f64, edits: &[(&str, Value)]) -> f64 {
    bridge_at(&bridges(&slice(taper(s), edits)), 1.8)
}

/// A case of [`check_onsets`]: its name, the edits to the request, and the steps just below and at the second bridge's
/// start.
type Onset<'a> = (&'a str, Vec<(&'a str, Value)>, f64, f64);

/// For each `(name, edits, below, from)`: z 1.8 carries no bridge on the taper stepping `below` and one of at least
/// 20 mm of filament on the taper stepping `from`.
fn check_onsets(cases: &[Onset<'_>]) {
    let mut misses = Vec::new();
    for (name, edits, below, from) in cases {
        let (a, b) = (second_bridge(*below, edits), second_bridge(*from, edits));
        if a > 2.0 {
            misses.push(format!("{name}: s {below} bridges z 1.8 ({a:.2}), want none"));
        }
        if b < 20.0 {
            misses.push(format!(
                "{name}: s {from} bridges z 1.8 with {b:.2}, want 20 or more"
            ));
        }
    }
    assert!(misses.is_empty(), "{}", misses.join("\n"));
}

#[test]
fn the_slope_bridges_every_other_layer_from_z_1_8() {
    // The z 1.8 bridge against its target within 4 mm of filament, and the rest of the chain and the plateau's
    // bridge printed.
    for (s, want) in [(0.8, 46.0), (0.9, 37.9)] {
        let layers = bridges(&slice(taper(s), &[]));
        let mut misses = Vec::new();
        let got = bridge_at(&layers, 1.8);
        if (got - want).abs() > 4.0 {
            misses.push(format!("z 1.8: bridge {got:.2}, want {want} within 4"));
        }
        for z in [2.2, 2.6, 3.0, 3.2] {
            let got = bridge_at(&layers, z);
            if got < 10.0 {
                misses.push(format!("z {z:.1}: bridge {got:.2}, want 10 or more"));
            }
        }
        assert!(misses.is_empty(), "s {s}:\n{}", misses.join("\n"));
    }
}

#[test]
fn the_second_bridge_starts_where_the_slit_says_on_stock_settings() {
    check_onsets(&[("stock", vec![], 0.76, 0.77)]);
}

#[test]
fn the_second_bridge_follows_the_inner_wall_width() {
    check_onsets(&[
        (
            "0.42 mm inner walls",
            vec![("inner_wall_line_width", json!("0.42"))],
            0.735,
            0.74,
        ),
        (
            "0.55 mm inner walls",
            vec![("inner_wall_line_width", json!("0.55"))],
            0.845,
            0.85,
        ),
    ]);
}

#[test]
fn the_second_bridge_follows_the_infill_wall_overlap() {
    check_onsets(&[
        ("0% overlap", vec![("infill_wall_overlap", json!(0))], 0.88, 0.885),
        (
            "10% overlap",
            vec![("infill_wall_overlap", json!(10))],
            0.80,
            0.805,
        ),
        (
            "0.45 mm internal solid infill",
            vec![("internal_solid_infill_line_width", json!("0.45"))],
            0.795,
            0.80,
        ),
    ]);
}

#[test]
fn the_second_bridge_stays_at_the_cap_without_a_slit() {
    check_onsets(&[
        ("one wall", vec![("wall_loops", json!(1))], 1.145, 1.15),
        ("three walls", vec![("wall_loops", json!(3))], 1.145, 1.15),
    ]);
    // 30% overlap: the slit is too narrow to count, and z 1.8 does not bridge up to s 0.9.
    let e = second_bridge(0.9, &[("infill_wall_overlap", json!(30))]);
    assert!(e < 2.0, "30% overlap, s 0.9: z 1.8 bridges ({e:.2})");
}
