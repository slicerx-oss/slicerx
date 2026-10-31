// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! One wall on top surfaces with classic walls, on stepped slopes: a layer whose outline the layer above steps in
//! from prints a band of top surface along that edge, without the walls past the outer one, once the step on that
//! side is wider than half the outer wall plus the inner wall (0.66 mm with 0.42 and 0.45 mm walls), whatever the wall
//! count. The band's lines start half the outer wall in from its center line and end the step plus the outer wall
//! plus 0.6 of the inner wall, less 0.05 mm, in from it, further in for each wall past the second. Under a flat
//! ledge they end where the ledge's infill area starts.
//!
//! All on the stock P1S request (fixtures/surface-walls/p1s-x-mark.json: classic walls, two loops, one wall on top,
//! smart layer off), and on it with settings set by hand: the MK4's process values (0.40 mm outer and 0.44 mm inner
//! walls, 25% overlap, 4 top layers), a 0.50 mm inner wall, 30% overlap, and 0.6 mm nozzle values (0.62 mm lines,
//! 3 top layers, 0.3 mm layers). Filament is E mm of 1.75 mm filament per feature.
//!
//! - A 30 mm square box under a ten-layer frustum whose sides step in by R mm per layer: the top surface on the nine
//!   sloped layers. On P1S nothing at R 0.66 and under and a band from R 0.67, on 2, 3 and 4 walls; with the MK4
//!   values nothing at 0.64 and a band from 0.65. The band per layer at three steps on each family, 2 and 3 walls
//!   (and 4 on P1S).
//! - Ledge rings of 4, 5 and 6 mm under a block, and the rings of a five-tier pyramid, at 15% and 30% overlap.
//! - The x-mark (bench/models/x-mark.stl), whose sloped sides step in 0.6 to 0.8 mm per layer from z 5.8 to 6.2:
//!   the top surface per layer, the floating vertical shell left at z 6.2, and at z 5.8 the band per side, where
//!   only the left (0.78 mm) and bottom (0.72 mm) sides step in far enough.
//! - Box tops, the topmost layer: their lines end half the outer wall in at 15% and 30% overlap, and a line along
//!   the wall still prints from 0.377 mm of its center line.
//! - Box tapers whose top's lines run along two sides: on a band layer the nearest line along the wall prints from
//!   0.377 mm of its center line at 15% and 30% overlap.
//! - Aegis walls are not touched: their x-mark top surface stays as it is.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates and filament lengths in mm"
)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::{Arc, OnceLock};
use sx_core::api::{self, Mesh, SliceRequest};

const REQUEST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/surface-walls/p1s-x-mark.json"
);
const TOP: &str = "Top surface";
const FLOATING: &str = "Floating vertical shell";

/// The G-code of the stock P1S request with wall generator `walls`, its one object printing `mesh` at the middle of
/// the bed.
fn slice(mesh: Arc<Mesh>, walls: &str) -> String {
    slice_with(mesh, walls, &[])
}

/// [`slice`] with `edits` to the request's config.
fn slice_with(mesh: Arc<Mesh>, walls: &str, edits: &[(&str, Value)]) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!(walls);
    for (k, v) in edits {
        req["config"][*k] = v.clone();
    }
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

fn x_mark() -> Arc<Mesh> {
    let stl = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/bench/models/x-mark.stl")).unwrap();
    Arc::new(Mesh::load(&stl, "x-mark.stl").unwrap())
}

/// The x-mark's extruding moves with classic walls, sliced once for the tests that read them.
fn classic_x_mark() -> &'static [Move] {
    static MOVES: OnceLock<Vec<Move>> = OnceLock::new();
    MOVES.get_or_init(|| moves(&slice(x_mark(), "classic")))
}

/// The 30 mm box 2 mm tall whose top steps in by `r` mm per 0.2 mm layer for ten layers, centered on the origin.
fn taper(step: f64) -> Arc<Mesh> {
    taper_on(step, 2.0, 0.2)
}

/// A 30 mm box `base` mm tall whose top steps in by `step` mm per `layer` mm layer for ten layers.
fn taper_on(step: f64, base: f64, layer: f64) -> Arc<Mesh> {
    let top = layer.mul_add(10.0, base);
    let square = |h: f64| [(-h, -h), (h, -h), (h, h), (-h, h)];
    let (low, high) = (square(15.0), square(10.0f64.mul_add(-step, 15.0)));
    let mut stl = String::from("solid taper\n");
    let mut facet = |p: [(f64, f64, f64); 3]| {
        let _ = writeln!(stl, "facet normal 0 0 0\n outer loop");
        for v in p {
            let _ = writeln!(stl, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(stl, " endloop\nendfacet");
    };
    for i in 0..4 {
        let next = (i + 1) % 4;
        let (lo0, lo1) = (low[i], low[next]);
        let (hi0, hi1) = (high[i], high[next]);
        facet([(0.0, 0.0, 0.0), (lo1.0, lo1.1, 0.0), (lo0.0, lo0.1, 0.0)]);
        facet([(lo0.0, lo0.1, 0.0), (lo1.0, lo1.1, 0.0), (lo1.0, lo1.1, base)]);
        facet([(lo0.0, lo0.1, 0.0), (lo1.0, lo1.1, base), (lo0.0, lo0.1, base)]);
        facet([(lo0.0, lo0.1, base), (lo1.0, lo1.1, base), (hi1.0, hi1.1, top)]);
        facet([(lo0.0, lo0.1, base), (hi1.0, hi1.1, top), (hi0.0, hi0.1, top)]);
        facet([(0.0, 0.0, top), (hi0.0, hi0.1, top), (hi1.0, hi1.1, top)]);
    }
    stl.push_str("endsolid taper\n");
    Arc::new(Mesh::load(stl.as_bytes(), "taper.stl").unwrap())
}

/// Square blocks centered on the origin, each `(half size, bottom, top)`: a ledge where a block sits on a wider one.
fn blocks(list: &[(f64, f64, f64)]) -> Arc<Mesh> {
    let mut stl = String::from(
        "solid blocks
",
    );
    let mut facet = |p: [(f64, f64, f64); 3]| {
        let _ = writeln!(
            stl,
            "facet normal 0 0 0
 outer loop"
        );
        for v in p {
            let _ = writeln!(stl, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(
            stl,
            " endloop
endfacet"
        );
    };
    for &(h, z0, z1) in list {
        let sq = [(-h, -h), (h, -h), (h, h), (-h, h)];
        for i in 0..4 {
            let (a, b) = (sq[i], sq[(i + 1) % 4]);
            facet([(0.0, 0.0, z0), (b.0, b.1, z0), (a.0, a.1, z0)]);
            facet([(0.0, 0.0, z1), (a.0, a.1, z1), (b.0, b.1, z1)]);
            facet([(a.0, a.1, z0), (b.0, b.1, z0), (b.0, b.1, z1)]);
            facet([(a.0, a.1, z0), (b.0, b.1, z1), (a.0, a.1, z1)]);
        }
    }
    stl.push_str(
        "endsolid blocks
",
    );
    Arc::new(Mesh::load(stl.as_bytes(), "blocks.stl").unwrap())
}

/// A box tapered in by `step` mm per 0.2 mm layer from z 2 to 4 on a 2 mm base, `half` mm from its middle to each side.
fn box_taper(half: f64, step: f64) -> Arc<Mesh> {
    let square = |h: f64| [(-h, -h), (h, -h), (h, h), (-h, h)];
    let (low, high) = (square(half), square(10.0f64.mul_add(-step, half)));
    let mut stl = String::from("solid box\n");
    let mut facet = |p: [(f64, f64, f64); 3]| {
        let _ = writeln!(stl, "facet normal 0 0 0\n outer loop");
        for v in p {
            let _ = writeln!(stl, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(stl, " endloop\nendfacet");
    };
    for i in 0..4 {
        let next = (i + 1) % 4;
        let (lo0, lo1, hi0, hi1) = (low[i], low[next], high[i], high[next]);
        facet([(0.0, 0.0, 0.0), (lo1.0, lo1.1, 0.0), (lo0.0, lo0.1, 0.0)]);
        facet([(lo0.0, lo0.1, 0.0), (lo1.0, lo1.1, 0.0), (lo1.0, lo1.1, 2.0)]);
        facet([(lo0.0, lo0.1, 0.0), (lo1.0, lo1.1, 2.0), (lo0.0, lo0.1, 2.0)]);
        facet([(lo0.0, lo0.1, 2.0), (lo1.0, lo1.1, 2.0), (hi1.0, hi1.1, 4.0)]);
        facet([(lo0.0, lo0.1, 2.0), (hi1.0, hi1.1, 4.0), (hi0.0, hi0.1, 4.0)]);
        facet([(0.0, 0.0, 4.0), (hi0.0, hi0.1, 4.0), (hi1.0, hi1.1, 4.0)]);
    }
    stl.push_str("endsolid box\n");
    Arc::new(Mesh::load(stl.as_bytes(), "box.stl").unwrap())
}

/// A point's coordinates across a side of a box and along it.
type Frame = fn((f64, f64)) -> (f64, f64);

/// How far the nearest top surface line that runs along the bottom or the left side of the outer wall lies from that
/// side's center line on layer `z` (thousandths of a millimeter), over lines along it that cover half of it or more.
fn nearest_along_side(ms: &[Move], z: i64) -> Option<f64> {
    let layer: Vec<&Move> = ms.iter().filter(|m| m.z == z).collect();
    // (coordinate across the side, coordinate along it) of a point, for the bottom side and the left side.
    let frames: [Frame; 2] = [|p| (p.1, p.0), |p| (p.0, p.1)];
    frames
        .iter()
        .filter_map(|f| {
            let side = layer
                .iter()
                .filter(|m| m.feature == "Outer wall" && (f(m.to).0 - f(m.from).0).abs() < 1e-3)
                .min_by(|a, b| f(a.from).0.total_cmp(&f(b.from).0))?;
            let (wall, len) = (f(side.from).0, (f(side.to).1 - f(side.from).1).abs());
            layer
                .iter()
                .filter(|m| m.feature == TOP && (f(m.to).0 - f(m.from).0).abs() < 1e-3)
                .filter(|m| (f(m.to).1 - f(m.from).1).abs() > 0.5 * len)
                .map(|m| f(m.from).0 - wall)
                .filter(|d| *d > 0.0)
                .reduce(f64::min)
        })
        .reduce(f64::min)
}

/// The stock P1S request with its sparse and solid infill lines at 0 degrees, so the top's lines run along two of a
/// box's sides, and `infill_wall_overlap` at `overlap` percent.
fn along_edits(overlap: u32) -> [(&'static str, Value); 3] {
    [
        ("infill_direction", json!(0)),
        ("solid_infill_direction", json!(0)),
        ("infill_wall_overlap", json!(overlap)),
    ]
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

/// One extruding move: its layer z (thousandths of a millimeter), feature, ends and filament.
struct Move {
    z: i64,
    feature: String,
    from: (f64, f64),
    to: (f64, f64),
    e: f64,
}

fn moves(gcode: &str) -> Vec<Move> {
    let (mut x, mut y, mut layer_z) = (0.0, 0.0, 0);
    let mut feature = String::new();
    let mut out = Vec::new();
    for line in gcode.lines() {
        let s = line.trim();
        if let Some(f) = comment(s, &["TYPE", "FEATURE"]) {
            f.clone_into(&mut feature);
            continue;
        }
        if let Some(h) = comment(s, &["Z_HEIGHT", "Z"]).and_then(|v| v.parse::<f64>().ok()) {
            layer_z = (h * 1000.0).round() as i64;
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|c| code.starts_with(c)) {
            continue;
        }
        let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
        if let Some(e) = word(code, 'E').filter(|e| *e > 0.0)
            && (word(code, 'X').is_some() || word(code, 'Y').is_some())
        {
            out.push(Move {
                z: layer_z,
                feature: feature.clone(),
                from: (x, y),
                to: (nx, ny),
                e,
            });
        }
        (x, y) = (nx, ny);
    }
    out
}

/// Filament per feature and layer z (thousandths of a millimeter).
fn per_layer(ms: &[Move]) -> BTreeMap<(String, i64), f64> {
    let mut out = BTreeMap::new();
    for m in ms {
        *out.entry((m.feature.clone(), m.z)).or_default() += m.e;
    }
    out
}

fn at(layers: &BTreeMap<(String, i64), f64>, feature: &str, z: f64) -> f64 {
    let z = (z * 1000.0).round() as i64;
    layers.get(&(feature.to_owned(), z)).copied().unwrap_or(0.0)
}

fn total(ms: &[Move], feature: &str) -> f64 {
    ms.iter().filter(|m| m.feature == feature).map(|m| m.e).sum()
}

/// The settings a band test runs on, over the stock P1S request.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Family {
    P1s,
    /// The MK4's process values: 0.40 mm outer and 0.44 mm inner walls, 25% overlap, 4 top layers.
    Mk4,
    /// A 0.50 mm inner wall.
    Inner50,
    /// 30% `infill_wall_overlap`.
    Overlap30,
    /// The 0.6 mm nozzle values: 0.62 mm lines, 3 top layers, 0.3 mm layers (on a box 2.1 mm tall).
    Nozzle06,
}

impl Family {
    const fn name(self) -> &'static str {
        match self {
            Self::P1s => "P1S",
            Self::Mk4 => "MK4 values",
            Self::Inner50 => "inner wall 0.50",
            Self::Overlap30 => "overlap 30%",
            Self::Nozzle06 => "0.6 nozzle values",
        }
    }
}

/// The taper's top surface on each of its nine taper layers with classic walls, `walls` of them, on `family`.
fn taper_layers(r: f64, walls: u32, family: Family) -> Vec<f64> {
    let edits = family_edits(walls, family);
    let (base, layer) = if matches!(family, Family::Nozzle06) {
        (2.1, 0.3)
    } else {
        (2.0, 0.2)
    };
    let layers = per_layer(&moves(&slice_with(taper_on(r, base, layer), "classic", &edits)));
    (1..10)
        .map(|i| at(&layers, TOP, layer.mul_add(f64::from(i), base)))
        .collect()
}

/// `walls` classic walls on `family`.
fn family_edits(walls: u32, family: Family) -> Vec<(&'static str, Value)> {
    let mut edits = vec![("wall_loops", json!(walls))];
    match family {
        Family::P1s => {}
        Family::Mk4 => edits.extend([
            ("outer_wall_line_width", json!("0.40")),
            ("inner_wall_line_width", json!("0.44")),
            ("infill_wall_overlap", json!(25)),
            ("top_shell_layers", json!(4)),
        ]),
        Family::Inner50 => edits.push(("inner_wall_line_width", json!("0.50"))),
        Family::Overlap30 => edits.push(("infill_wall_overlap", json!(30))),
        Family::Nozzle06 => {
            for k in [
                "outer_wall_line_width",
                "inner_wall_line_width",
                "line_width",
                "internal_solid_infill_line_width",
                "sparse_infill_line_width",
                "top_surface_line_width",
            ] {
                edits.push((k, json!("0.62")));
            }
            edits.extend([
                ("top_shell_layers", json!(3)),
                ("layer_height", json!(0.3)),
                ("initial_layer_print_height", json!(0.3)),
                ("nozzle_diameter", json!([0.6])),
            ]);
        }
    }
    edits
}

/// The taper's top surface over its nine taper layers, and on its flat cap at z 4.0.
fn taper_top(r: f64) -> (f64, f64) {
    let layers = per_layer(&moves(&slice(taper(r), "classic")));
    let band = (0..9)
        .map(|i| at(&layers, TOP, 0.2f64.mul_add(f64::from(i), 2.2)))
        .sum();
    (band, at(&layers, TOP, 4.0))
}

fn near(got: f64, want: f64, within: f64) -> bool {
    (got - want).abs() <= within * want
}

#[test]
fn classic_taper_steps_from_0_68_mm_print_a_band() {
    // (R, band over z 2.2 to 3.8, cap at z 4.0)
    for (r, band, cap) in [
        (0.68, 71.82, 21.5),
        (0.70, 72.44, 20.5),
        (0.72, 73.07, 19.52),
        (0.74, 73.61, 18.59),
        (0.75, 73.9, 18.11),
        (0.80, 75.3, 15.89),
    ] {
        let (got, got_cap) = taper_top(r);
        assert!(
            near(got, band, 0.06),
            "R {r}: top surface {got:.2} on the taper, want {band}"
        );
        assert!(near(got_cap, cap, 0.02), "R {r}: cap {got_cap:.2}, want {cap}");
    }
}

#[test]
fn classic_taper_steps_under_0_67_mm_print_no_band() {
    for r in [0.4, 0.5, 0.6, 0.65, 0.66] {
        let (got, _) = taper_top(r);
        assert!(got == 0.0, "R {r}: top surface {got:.2} on the taper, want none");
    }
}

#[test]
fn classic_taper_wide_steps_keep_their_band() {
    for (r, band) in [
        (0.825, 75.77),
        (0.85, 76.33),
        (0.875, 76.84),
        (0.9, 77.32),
        (1.0, 78.89),
    ] {
        let (got, _) = taper_top(r);
        assert!(
            near(got, band, 0.06),
            "R {r}: top surface {got:.2} on the taper, want {band}"
        );
    }
}

#[test]
fn classic_cut_off_follows_the_widths_not_the_wall_count() {
    // (MK4 values, walls, the widest step with no band, the narrowest with one)
    for (mk4, walls, none, band) in [
        (false, 2, 0.66, 0.67),
        (false, 3, 0.66, 0.67),
        (false, 4, 0.66, 0.67),
        (true, 2, 0.64, 0.65),
        (true, 3, 0.64, 0.65),
    ] {
        let fam = if mk4 { Family::Mk4 } else { Family::P1s };
        let off: f64 = taper_layers(none, walls, fam).iter().sum();
        let on: f64 = taper_layers(band, walls, fam).iter().sum();
        assert!(
            off == 0.0,
            "MK4 values {mk4}, {walls} walls, R {none}: top surface {off:.2}, want none"
        );
        assert!(
            on > 50.0,
            "MK4 values {mk4}, {walls} walls, R {band}: top surface {on:.2}, want a band"
        );
    }
}

/// Top surface per sloped taper layer: (settings, walls, R, targets).
const BAND_TARGETS: [(Family, u32, f64, [f64; 9]); 33] = [
    (
        Family::P1s,
        2,
        0.69,
        [10.05, 9.54, 9.04, 8.53, 8.00, 7.51, 7.00, 6.50, 5.99],
    ),
    (
        Family::P1s,
        2,
        0.75,
        [10.54, 9.96, 9.37, 8.79, 8.20, 7.64, 7.05, 6.47, 5.88],
    ),
    (
        Family::P1s,
        2,
        1.0,
        [12.51, 11.57, 10.65, 9.71, 8.77, 7.82, 6.90, 5.96, 5.02],
    ),
    (
        Family::P1s,
        3,
        0.69,
        [12.12, 11.49, 10.89, 10.27, 9.63, 9.03, 8.40, 7.80, 7.18],
    ),
    (
        Family::P1s,
        3,
        0.75,
        [12.59, 11.89, 11.19, 10.48, 9.77, 9.09, 8.39, 7.69, 6.98],
    ),
    (
        Family::P1s,
        3,
        1.0,
        [14.51, 13.40, 12.33, 11.23, 10.13, 9.01, 7.94, 6.84, 5.74],
    ),
    (
        Family::P1s,
        4,
        0.69,
        [14.15, 13.41, 12.70, 11.96, 11.22, 10.51, 9.77, 9.06, 8.33],
    ),
    (
        Family::P1s,
        4,
        0.75,
        [14.61, 13.79, 12.97, 12.14, 11.31, 10.51, 9.69, 8.87, 8.05],
    ),
    (
        Family::P1s,
        4,
        1.0,
        [16.46, 15.19, 13.96, 12.70, 11.44, 10.17, 8.94, 7.68, 6.42],
    ),
    (
        Family::Mk4,
        2,
        0.69,
        [9.93, 9.42, 8.93, 8.43, 7.90, 7.43, 6.91, 6.43, 5.92],
    ),
    (
        Family::Mk4,
        2,
        0.75,
        [10.42, 9.84, 9.27, 8.69, 8.10, 7.55, 6.98, 6.40, 5.83],
    ),
    (
        Family::Mk4,
        2,
        1.0,
        [12.40, 11.49, 10.56, 9.63, 8.69, 7.78, 6.85, 5.92, 4.98],
    ),
    (
        Family::Mk4,
        3,
        0.69,
        [11.95, 11.33, 10.74, 10.12, 9.50, 8.92, 8.29, 7.70, 7.08],
    ),
    (
        Family::Mk4,
        3,
        0.75,
        [12.43, 11.74, 11.04, 10.35, 9.65, 8.98, 8.29, 7.60, 6.90],
    ),
    (
        Family::Mk4,
        3,
        1.0,
        [14.35, 13.28, 12.20, 11.11, 10.02, 8.95, 7.87, 6.78, 5.69],
    ),
    (
        Family::Inner50,
        2,
        0.75,
        [10.80, 10.20, 9.60, 9.00, 8.39, 7.82, 7.22, 6.62, 6.02],
    ),
    (
        Family::Inner50,
        2,
        1.0,
        [12.76, 11.80, 10.86, 9.90, 8.93, 7.97, 7.03, 6.07, 5.11],
    ),
    (
        Family::Inner50,
        2,
        1.2,
        [14.29, 12.97, 11.68, 10.36, 9.07, 7.76, 6.46, 5.15, 3.85],
    ),
    (
        Family::Inner50,
        3,
        0.75,
        [13.09, 12.36, 11.63, 10.89, 10.16, 9.45, 8.71, 7.98, 7.24],
    ),
    (
        Family::Inner50,
        3,
        1.0,
        [14.99, 13.85, 12.73, 11.59, 10.45, 9.30, 8.19, 7.05, 5.91],
    ),
    (
        Family::Inner50,
        3,
        1.2,
        [16.47, 14.94, 13.43, 11.90, 10.39, 8.86, 7.35, 5.82, 4.32],
    ),
    (
        Family::Overlap30,
        2,
        0.69,
        [10.05, 9.54, 9.04, 8.53, 8.00, 7.51, 7.00, 6.50, 5.99],
    ),
    (
        Family::Overlap30,
        2,
        0.75,
        [10.54, 9.96, 9.37, 8.79, 8.20, 7.64, 7.05, 6.47, 5.88],
    ),
    (
        Family::Overlap30,
        2,
        1.0,
        [12.51, 11.57, 10.65, 9.71, 8.77, 7.82, 6.90, 5.96, 5.02],
    ),
    (
        Family::Overlap30,
        3,
        0.69,
        [12.12, 11.49, 10.89, 10.27, 9.63, 9.03, 8.40, 7.80, 7.18],
    ),
    (
        Family::Overlap30,
        3,
        0.75,
        [12.59, 11.89, 11.19, 10.48, 9.77, 9.09, 8.39, 7.69, 6.98],
    ),
    (
        Family::Overlap30,
        3,
        1.0,
        [14.51, 13.40, 12.33, 11.23, 10.13, 9.01, 7.94, 6.84, 5.74],
    ),
    (
        Family::Nozzle06,
        2,
        0.95,
        [20.15, 18.62, 17.22, 15.77, 14.28, 12.86, 11.34, 9.94, 8.40],
    ),
    (
        Family::Nozzle06,
        2,
        1.0,
        [20.70, 19.09, 17.54, 15.93, 14.37, 12.78, 11.12, 9.61, 7.97],
    ),
    (
        Family::Nozzle06,
        2,
        1.2,
        [22.84, 20.71, 18.58, 16.45, 14.32, 12.19, 10.06, 7.93, 5.80],
    ),
    (
        Family::Nozzle06,
        3,
        0.95,
        [24.12, 22.28, 20.56, 18.82, 17.00, 15.29, 13.45, 11.73, 9.89],
    ),
    (
        Family::Nozzle06,
        3,
        1.0,
        [24.66, 22.70, 20.84, 18.89, 17.01, 15.09, 13.11, 11.28, 9.30],
    ),
    (
        Family::Nozzle06,
        3,
        1.2,
        [26.68, 24.17, 21.65, 19.13, 16.61, 14.08, 11.56, 9.04, 6.51],
    ),
];

#[test]
fn classic_band_widens_with_each_wall_past_the_second() {
    // Each layer within 0.5 mm of filament of its target.
    for (family, walls, r, want) in BAND_TARGETS {
        let got = taper_layers(r, walls, family);
        for (i, (g, w)) in (1u32..).zip(got.iter().zip(want)) {
            assert!(
                (g - w).abs() <= 0.5,
                "{}, {walls} walls, R {r}, sloped layer {i}: top surface {g:.2}, want {w}",
                family.name()
            );
        }
    }
}

#[test]
fn classic_ledge_rings_end_where_the_layer_above_infill_starts() {
    // Ledge rings under a block, top surface on the ring layer within 0.5 mm of filament, at 15% and 30% overlap:
    // (ring width, z, at 15%, at 30%). A 30 mm block 2 mm tall under a block that leaves a ring of 4, 5 or 6 mm, and
    // a five-tier pyramid of 70 mm with 6 mm rings.
    for (ring, z, at15, at30) in [
        (4.0, 2.0, 35.44, 35.05),
        (5.0, 2.0, 41.76, 41.41),
        (6.0, 2.0, 47.43, 47.11),
    ] {
        let mesh = blocks(&[(15.0, 0.0, 2.0), (15.0 - ring, 2.0, 4.0)]);
        for (overlap, want) in [(15, at15), (30, at30)] {
            let g = slice_with(
                mesh.clone(),
                "classic",
                &[("infill_wall_overlap", json!(overlap))],
            );
            let got = at(&per_layer(&moves(&g)), TOP, z);
            assert!(
                (got - want).abs() <= 0.5,
                "{ring} mm ring, {overlap}% overlap: top surface {got:.2}, want {want}"
            );
        }
    }
    let tiers: Vec<(f64, f64, f64)> = (0..5u32)
        .map(|i| {
            (
                6.0f64.mul_add(-f64::from(i), 35.0),
                2.0 * f64::from(i),
                2.0 * f64::from(i + 1),
            )
        })
        .collect();
    let pyramid = blocks(&tiers);
    for (overlap, want) in [
        (15, [130.74, 105.76, 80.75, 55.77]),
        (30, [129.65, 104.91, 80.13, 55.38]),
    ] {
        let g = slice_with(
            pyramid.clone(),
            "classic",
            &[("infill_wall_overlap", json!(overlap))],
        );
        let layers = per_layer(&moves(&g));
        for (k, w) in (1u32..).zip(want) {
            let z = 2.0 * f64::from(k);
            let got = at(&layers, TOP, z);
            assert!(
                (got - w).abs() <= 0.5,
                "pyramid, {overlap}% overlap, z {z}: top surface {got:.2}, want {w}"
            );
        }
    }
}

#[test]
fn classic_x_mark_slopes_print_their_band() {
    let ms = classic_x_mark();
    let layers = per_layer(ms);
    for (z, want, within) in [(5.8, 9.99, 0.15), (6.0, 80.17, 0.05), (6.2, 12.91, 0.10)] {
        let got = at(&layers, TOP, z);
        assert!(
            near(got, want, within),
            "z {z}: top surface {got:.2}, want {want}"
        );
    }
    for z in [5.6, 6.4, 6.6, 6.8] {
        let got = at(&layers, TOP, z);
        assert!(got == 0.0, "z {z}: top surface {got:.2}, want none");
    }
    let floating = at(&layers, FLOATING, 6.2);
    assert!(
        floating <= 3.0,
        "z 6.2: floating vertical shell {floating:.2}, want 3.0 at most"
    );
    let plate = total(ms, TOP);
    assert!(
        near(plate, 140.1, 0.05),
        "top surface on the plate {plate:.2}, want 140.1"
    );
}

#[test]
fn classic_x_mark_band_follows_each_sides_step() {
    // z 5.8 is one slab: its sides step in 0.78 (left), 0.72 (bottom), 0.66 (top) and 0.59 mm (right).
    let layer: Vec<&Move> = classic_x_mark().iter().filter(|m| m.z == 5800).collect();
    let outer = layer.iter().filter(|m| m.feature == "Outer wall");
    let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for m in outer {
        for (x, y) in [m.from, m.to] {
            (x0, x1, y0, y1) = (x0.min(x), x1.max(x), y0.min(y), y1.max(y));
        }
    }
    // Each top surface move goes to the side of the outer wall's box its middle is nearest.
    let mut side: BTreeMap<&str, f64> = BTreeMap::new();
    for m in layer.iter().filter(|m| m.feature == TOP) {
        let (x, y) = (f64::midpoint(m.from.0, m.to.0), f64::midpoint(m.from.1, m.to.1));
        let near = [
            ("left", x - x0),
            ("right", x1 - x),
            ("bottom", y - y0),
            ("top", y1 - y),
        ]
        .into_iter()
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map_or("left", |s| s.0);
        *side.entry(near).or_default() += m.e;
    }
    let e = |s: &str| side.get(s).copied().unwrap_or(0.0);
    assert!(
        e("bottom") > 5.0,
        "bottom side: top surface {:.2}, want more than 5",
        e("bottom")
    );
    assert!(
        e("left") > 1.5,
        "left side: top surface {:.2}, want more than 1.5",
        e("left")
    );
    for s in ["top", "right"] {
        assert!(e(s) < 0.5, "{s} side: top surface {:.2}, want under 0.5", e(s));
    }
}

/// The x-mark's aegis top surface is not moved by the classic band rule. The targets have the aegis monotonic line
/// top surfaces starting at the inner wall's spacing edge, without the infill wall overlap.
#[test]
fn aegis_x_mark_top_surface_is_unchanged() {
    let ms = moves(&slice(x_mark(), "aegis"));
    let layers = per_layer(&ms);
    for (z, want) in [(5.8, 2.51), (6.0, 74.92), (6.2, 8.80)] {
        let got = at(&layers, TOP, z);
        assert!(
            (got - want).abs() < 0.01,
            "z {z}: top surface {got:.3}, want {want}"
        );
    }
    let plate = total(&ms, TOP);
    assert!(
        (plate - 122.52).abs() < 0.01,
        "top surface on the plate {plate:.3}, want 122.52"
    );
}

#[test]
fn classic_box_tops_start_half_the_outer_wall_in_at_any_overlap() {
    // The topmost layer of a box under a classic one-wall top: its lines end half the outer wall's width in from the
    // wall's center line at 15% and at 30% overlap, so the box top is the same at both, within 0.05 mm of filament of
    // its target: boxes whose tops are 22, 20 and 18 mm across on a 30 mm block, and the 70 mm pyramid's top tier.
    for (half, want) in [(11.0, 36.49), (10.0, 29.91), (9.0, 24.01)] {
        let mesh = blocks(&[(15.0, 0.0, 2.0), (half, 2.0, 4.0)]);
        for overlap in [15, 30] {
            let g = slice_with(
                mesh.clone(),
                "classic",
                &[("infill_wall_overlap", json!(overlap))],
            );
            let got = at(&per_layer(&moves(&g)), TOP, 4.0);
            assert!(
                (got - want).abs() <= 0.05,
                "{} mm box top, {overlap}% overlap: top surface {got:.3}, want {want}",
                2.0 * half
            );
        }
    }
    let tiers: Vec<(f64, f64, f64)> = (0..5u32)
        .map(|i| {
            (
                6.0f64.mul_add(-f64::from(i), 35.0),
                2.0 * f64::from(i),
                2.0 * f64::from(i + 1),
            )
        })
        .collect();
    let pyramid = blocks(&tiers);
    for overlap in [15, 30] {
        let g = slice_with(
            pyramid.clone(),
            "classic",
            &[("infill_wall_overlap", json!(overlap))],
        );
        let got = at(&per_layer(&moves(&g)), TOP, 10.0);
        assert!(
            (got - 36.49).abs() <= 0.05,
            "pyramid top, {overlap}% overlap: top surface {got:.3}, want 36.49"
        );
    }
}

#[test]
fn classic_box_top_lines_along_the_wall_keep_their_distance() {
    // A box 30.35 mm across tapered 0.8 mm per layer, its top's lines along two sides: the nearest one on the
    // topmost layer (z 4.0) lies 0.389 mm from the outer wall's center line at 15% and 30% overlap, as with the
    // surface ending where the overlap leaves it. A line prints once it is 0.377 mm from that line.
    for overlap in [15, 30] {
        let g = slice_with(box_taper(15.175, 0.8), "classic", &along_edits(overlap));
        let got = nearest_along_side(&moves(&g), 4000);
        assert!(
            got.is_some_and(|d| (d - 0.389).abs() < 0.005),
            "{overlap}% overlap: nearest line along the wall {got:?}, want 0.389"
        );
    }
}

#[test]
fn classic_band_lines_along_the_wall_print_from_the_same_distance_at_any_overlap() {
    // Box tapers 0.8 mm per layer whose top's lines run along two sides: on the band layer at z 3.0 a line along the
    // wall prints once its center line is 0.377 mm from the outer wall's, at 15% and at 30% overlap. (box size, overlap,
    // nearest line): the 30.7 mm box puts a grid line 0.416 mm from the wall, the 30 mm one 0.443 mm.
    for (half, overlap, want) in [(15.35, 15, 0.416), (15.0, 30, 0.443), (15.0, 15, 0.443)] {
        let g = slice_with(box_taper(half, 0.8), "classic", &along_edits(overlap));
        let got = nearest_along_side(&moves(&g), 3000);
        assert!(
            got.is_some_and(|d| (d - want).abs() < 0.005),
            "{} mm box, {overlap}% overlap: nearest line along the wall {got:?}, want {want}",
            2.0 * half
        );
    }
}
