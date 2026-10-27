// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Gap fill on classic walls. On the first layer it prints at `initial_layer_infill_speed`, whatever
//! `initial_layer_speed` and `gap_infill_speed` say, and the volumetric cap then applies as it does to any path.
//! Above the first layer it prints at `gap_infill_speed`.
//!
//! A gap bead fills the strip between two walls: its spacing is the strip's width, so it states that width plus the
//! rounded edge of the layer. On a strip that tapers it is cut into pieces, and each piece takes the strip's width at
//! its middle.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "a G-code reader for the test: plate coordinates and feeds in mm"
)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use common::organic_models::cuboid;
use sx_core::api::{Mesh, MeshPart, SliceRequest};

/// The cross-section of 1.75 mm filament, mm2.
const FILAMENT_AREA: f64 = std::f64::consts::PI * 0.875 * 0.875;

/// A prism `h` mm tall over the convex polygon `poly` (counterclockwise).
fn prism(name: &str, poly: &[[f32; 2]], h: f32) -> MeshPart {
    let n = u32::try_from(poly.len()).unwrap();
    let mut positions: Vec<[f32; 3]> = poly.iter().map(|p| [p[0], p[1], 0.0]).collect();
    positions.extend(poly.iter().map(|p| [p[0], p[1], h]));
    let mut triangles = Vec::new();
    for i in 1..n - 1 {
        triangles.push([0, i + 1, i]);
        triangles.push([n, n + i, n + i + 1]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        triangles.push([i, j, n + j]);
        triangles.push([i, n + j, n + i]);
    }
    MeshPart {
        name: name.into(),
        slot: 1,
        positions,
        triangles,
        ..MeshPart::default()
    }
}

/// An arch (two legs 8 mm tall under a 2 mm slab) and beside it a wedge 4 mm tall that widens from nothing to 2.4 mm
/// over 24 mm, so that its walls leave strips that taper.
fn arch_and_wedge() -> Mesh {
    Mesh {
        name: "arch".into(),
        parts: vec![
            cuboid("leg", [97.0, 100.0, 0.0], [105.0, 114.0, 8.0]),
            cuboid("leg", [115.0, 100.0, 0.0], [123.0, 114.0, 8.0]),
            cuboid("slab", [91.0, 100.0, 8.0], [129.0, 114.0, 10.0]),
            prism("wedge", &[[98.0, 118.0], [122.0, 118.0], [122.0, 120.4]], 4.0),
        ],
        ..Mesh::default()
    }
}

/// An Ender 3 V3 with a 0.4 mm nozzle and PLA: 0.42 mm lines, two classic walls, a filament flow ratio of 0.9, every
/// print speed 300 mm/s, the first layer's walls at 60 and its infill at 105, and a volumetric cap of 50 mm3/s that
/// binds nowhere. `extra` goes on top.
fn config(extra: &Value) -> Value {
    let mut c = json!({
        "printer_model": "Creality Ender-3 V3",
        "gcode_flavor": "klipper",
        "nozzle_diameter": [0.4],
        "wall_generator": "classic",
        "wall_loops": 2,
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "top_shell_layers": 5,
        "bottom_shell_layers": 3,
        "precise_outer_wall": false,
        "infill_wall_overlap": "15%",
        "top_bottom_infill_wall_overlap": "25%",
        "gap_fill_target": "nowhere",
        "resolution": 0.01,
        "seam_position": "aligned",
        "brim_type": "no_brim",
        "skirt_loops": 0,
        "enable_support": false,
        "ironing_type": "no ironing",
        "enable_overhang_speed": false,
        "slow_down_for_layer_cooling": false,
        "slow_down_layers": 0,
        "use_relative_e_distances": true,
        "filament_flow_ratio": [0.9],
        "filament_max_volumetric_speed": [50],
        "outer_wall_speed": 300,
        "inner_wall_speed": 300,
        "sparse_infill_speed": 300,
        "internal_solid_infill_speed": 300,
        "top_surface_speed": 300,
        "gap_infill_speed": 300,
        "bridge_speed": 300,
        "initial_layer_speed": 60,
        "initial_layer_infill_speed": 105,
    });
    if let (Some(m), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        m.extend(e.clone());
    }
    c
}

fn gcode(mesh: Mesh, extra: &Value) -> String {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {
            "bed": {"widthMm": 220, "depthMm": 220, "heightMm": 250},
            "objects": [{"id": "o0", "name": "part", "mesh": "m0"}],
        },
        "config": config(extra),
        "options": {},
    }))
    .unwrap();
    let m = Arc::new(mesh);
    let run = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// One extrusion move.
#[derive(Debug, Clone, PartialEq)]
struct Move {
    /// The print Z of its layer.
    z: f64,
    feature: String,
    from: [f64; 2],
    to: [f64; 2],
    /// mm/s.
    feed: f64,
    /// The width its `;WIDTH:` comment states.
    width: f64,
    e_per_mm: f64,
}

impl Move {
    fn len(&self) -> f64 {
        (self.to[0] - self.from[0]).hypot(self.to[1] - self.from[1])
    }

    /// mm3/s.
    fn rate(&self) -> f64 {
        self.feed * self.e_per_mm * FILAMENT_AREA
    }
}

/// Every extrusion move of a G-code file written with relative E.
fn moves(text: &str) -> Vec<Move> {
    let (mut z, mut feature, mut width, mut feed) = (0.0, String::new(), 0.0, 0.0);
    let mut at: Option<[f64; 2]> = None;
    let mut out = Vec::new();
    for line in text.lines() {
        if let Some(v) = line.strip_prefix(";Z:") {
            z = v.trim().parse().unwrap_or(z);
            continue;
        }
        if let Some(v) = line.strip_prefix(";TYPE:") {
            feature = v.trim().to_string();
            continue;
        }
        if let Some(v) = line.strip_prefix(";WIDTH:") {
            width = v.trim().parse().unwrap_or(width);
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        if !(code.starts_with("G0 ") || code.starts_with("G1 ")) {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        if let Some(f) = word('F') {
            feed = f / 60.0;
        }
        let (x, y) = (word('X'), word('Y'));
        if x.is_none() && y.is_none() {
            continue;
        }
        let to = [
            x.or_else(|| at.map(|p| p[0])).unwrap_or(0.0),
            y.or_else(|| at.map(|p| p[1])).unwrap_or(0.0),
        ];
        if let (Some(from), Some(e)) = (at, word('E')) {
            let m = Move {
                z,
                feature: feature.clone(),
                from,
                to,
                feed,
                width,
                e_per_mm: 0.0,
            };
            let len = m.len();
            if e > 0.0 && len > 0.0 {
                out.push(Move {
                    e_per_mm: e / len,
                    ..m
                });
            }
        }
        at = Some(to);
    }
    out
}

/// The gap fill moves of 0.3 mm or more: (on the first layer, above it).
fn gap_moves(g: &str) -> (Vec<Move>, Vec<Move>) {
    moves(g)
        .into_iter()
        .filter(|m| m.feature == "Gap infill" && m.len() >= 0.3)
        .partition(|m| m.z < 0.25)
}

/// Every feed of `ms`, which must not be empty.
fn feeds(ms: &[Move]) -> Vec<f64> {
    assert!(!ms.is_empty(), "no moves");
    ms.iter().map(|m| m.feed).collect()
}

fn all_at(ms: &[Move], speed: f64) -> bool {
    feeds(ms).iter().all(|f| (f - speed).abs() < 0.01)
}

#[test]
fn first_layer_gap_fill_prints_at_the_first_layer_infill_speed() {
    for (lis, speed) in [(105, 105.0), (150, 150.0), (70, 70.0)] {
        let (first, _) = gap_moves(&gcode(
            arch_and_wedge(),
            &json!({"initial_layer_infill_speed": lis}),
        ));
        assert!(
            all_at(&first, speed),
            "initial_layer_infill_speed {lis}: first-layer gap fill at {:?}",
            feeds(&first)
        );
    }
}

#[test]
fn first_layer_gap_fill_ignores_the_gap_infill_speed() {
    let (first, above) = gap_moves(&gcode(arch_and_wedge(), &json!({"gap_infill_speed": 50})));
    assert!(all_at(&first, 105.0), "first layer: {:?}", feeds(&first));
    assert!(all_at(&above, 50.0), "above it: {:?}", feeds(&above));
    let (first, above) = gap_moves(&gcode(
        arch_and_wedge(),
        &json!({"gap_infill_speed": 80, "initial_layer_infill_speed": 150}),
    ));
    assert!(all_at(&first, 150.0), "first layer: {:?}", feeds(&first));
    assert!(all_at(&above, 80.0), "above it: {:?}", feeds(&above));
}

#[test]
fn first_layer_gap_fill_ignores_the_first_layer_wall_speed() {
    for (ls, wall) in [(30, 30.0), (90, 90.0)] {
        let g = gcode(arch_and_wedge(), &json!({"initial_layer_speed": ls}));
        let (first, _) = gap_moves(&g);
        assert!(
            all_at(&first, 105.0),
            "initial_layer_speed {ls}: first-layer gap fill at {:?}",
            feeds(&first)
        );
        let walls: Vec<Move> = moves(&g)
            .into_iter()
            .filter(|m| m.z < 0.25 && m.len() >= 0.3 && m.feature.ends_with(" wall"))
            .collect();
        assert!(
            all_at(&walls, wall),
            "initial_layer_speed {ls}: walls at {:?}",
            feeds(&walls)
        );
    }
}

#[test]
fn the_volumetric_cap_still_binds_first_layer_gap_fill() {
    let cap = 8.0;
    let (first, _) = gap_moves(&gcode(
        arch_and_wedge(),
        &json!({"initial_layer_infill_speed": 150, "filament_max_volumetric_speed": [8]}),
    ));
    assert!(!first.is_empty());
    for m in &first {
        assert!(m.rate() <= cap * 1.005, "over the cap: {m:?}, {} mm3/s", m.rate());
        // A bead whose cap speed is above 150 mm/s runs at 150.
        if 150.0 * m.e_per_mm * FILAMENT_AREA < cap * 0.995 {
            assert!((m.feed - 150.0).abs() < 0.01, "not at 150 mm/s: {m:?}");
        }
    }
    assert!(
        first.iter().any(|m| (m.feed - 150.0).abs() < 0.01),
        "no bead runs at 150 mm/s: {:?}",
        feeds(&first)
    );
}

#[test]
fn gap_fill_above_the_first_layer_does_not_depend_on_the_first_layer_speeds() {
    let (_, base) = gap_moves(&gcode(arch_and_wedge(), &json!({})));
    assert!(all_at(&base, 300.0), "above the first layer: {:?}", feeds(&base));
    for extra in [
        json!({"initial_layer_infill_speed": 150}),
        json!({"initial_layer_infill_speed": 70}),
        json!({"initial_layer_speed": 30}),
        json!({"initial_layer_speed": 90}),
    ] {
        let (_, above) = gap_moves(&gcode(arch_and_wedge(), &extra));
        assert_eq!(above, base, "{extra}");
    }
}

/// Where the ribs of [`ribs`] start in X: one every `pitch` mm, the row centered on the bed's middle (X 110), where
/// the slice keeps it.
fn rib_starts(pitch: f32, widths: &[f32]) -> Vec<f32> {
    let span = pitch * (widths.len() - 1) as f32 + widths.last().copied().unwrap_or(0.0);
    (0..widths.len())
        .map(|i| 110.0 - span / 2.0 + pitch * i as f32)
        .collect()
}

/// Boxes 15 mm long in Y and 2 mm tall, `widths` mm wide in X (see [`rib_starts`]).
fn ribs(pitch: f32, widths: &[f32]) -> Mesh {
    Mesh {
        name: "ribs".into(),
        parts: rib_starts(pitch, widths)
            .into_iter()
            .zip(widths)
            .map(|(x, w)| cuboid("rib", [x, 102.5, 0.0], [x + w, 117.5, 2.0]))
            .collect(),
        ..Mesh::default()
    }
}

/// The rounded edge of a bead `h` mm tall: what its stated width adds to its spacing.
fn edge(h: f64) -> f64 {
    h * (1.0 - std::f64::consts::FRAC_PI_4)
}

/// The width a move's E per mm gives back as a flat bead `h` mm tall at the 0.9 filament flow ratio.
fn e_width(m: &Move, h: f64) -> f64 {
    m.e_per_mm * FILAMENT_AREA / (h * 0.9) + edge(h)
}

/// Ribs 10 mm apart.
const RIB_WIDTHS: [f32; 13] = [1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1, 2.2, 2.3, 2.4, 2.5];

/// Ribs `widths` `pitch` mm apart (see [`ribs`]) sliced with `extra`, on the layer at `z`, `h` mm tall: in each rib of `beads` the gap
/// beads of 1 mm or more state the width beside it to 0.002 mm and their E per mm gives the same width back, and
/// the ribs of `bare` have no gap fill.
fn check_ribs(
    extra: &Value,
    (pitch, widths): (f32, &[f32]),
    z: f64,
    h: f64,
    beads: &[(f32, f64)],
    bare: &[f32],
) {
    let g = gcode(ribs(pitch, widths), extra);
    let starts = rib_starts(pitch, widths);
    let gaps: Vec<Move> = moves(&g)
        .into_iter()
        .filter(|m| m.feature == "Gap infill" && (m.z - z).abs() < 1e-6 && m.len() >= 1.0)
        .collect();
    let inside = |w: f32| -> Vec<&Move> {
        let i = widths.iter().position(|r| (r - w).abs() < 1e-4).unwrap();
        let lo = f64::from(starts[i]);
        gaps.iter()
            .filter(|m| (lo..lo + f64::from(w)).contains(&f64::midpoint(m.from[0], m.to[0])))
            .collect()
    };
    for &(w, e) in beads {
        let ms = inside(w);
        assert!(!ms.is_empty(), "{extra}: rib {w} has no gap fill");
        for m in ms {
            assert!(
                (m.width - e).abs() <= 0.002,
                "{extra}: rib {w} states {}, not {e}",
                m.width
            );
            let ew = e_width(m, h);
            assert!(
                (ew - e).abs() <= 0.002,
                "{extra}: rib {w} extrudes {ew:.4}, not {e}"
            );
        }
    }
    for &w in bare {
        let ms = inside(w);
        assert!(ms.is_empty(), "{extra}: rib {w} has gap fill: {ms:?}");
    }
}

#[test]
fn a_gap_bead_fills_the_strip_between_the_walls() {
    check_ribs(
        &json!({}),
        (10.0, &RIB_WIDTHS),
        0.6,
        0.2,
        &[
            (1.3, 0.5458),
            (1.4, 0.6458),
            (1.7, 0.1918),
            (1.8, 0.2918),
            (1.9, 0.3918),
            (2.0, 0.4918),
            (2.1, 0.5918),
        ],
        &[1.5, 1.6, 2.2, 2.3, 2.4, 2.5],
    );
}

#[test]
fn a_gap_bead_fills_the_strip_between_wider_walls() {
    check_ribs(
        &json!({"inner_wall_line_width": 0.5, "outer_wall_line_width": 0.5}),
        (10.0, &RIB_WIDTHS),
        0.6,
        0.2,
        &[
            (1.3, 0.3858),
            (1.6, 0.6858),
            (2.0, 0.1717),
            (2.3, 0.4717),
            (2.5, 0.6717),
        ],
        &[1.7, 1.8, 1.9],
    );
}

#[test]
fn a_gap_bead_fills_the_strip_between_the_walls_of_taller_layers() {
    // The third layer: one of 0.2 mm, then two of 0.28.
    check_ribs(
        &json!({"layer_height": 0.28}),
        (10.0, &RIB_WIDTHS),
        0.76,
        0.28,
        &[(1.6, 0.1604), (1.8, 0.3604), (2.0, 0.5604)],
        &[],
    );
}

#[test]
fn a_strip_gets_a_bead_between_its_lower_and_upper_limits() {
    let widths = [
        1.6, 1.61, 1.62, 1.63, 1.64, 1.65, 1.66, 1.67, 1.68, 1.69, 1.7, 2.1, 2.11, 2.12, 2.13, 2.14, 2.15,
        2.16, 2.17, 2.18, 2.19, 2.2,
    ];
    // Two walls of 0.42 mm on each side leave a strip 1.5512 mm narrower than the rib; it gets a bead from 0.0589 mm
    // (rib 1.61) to 0.5989 mm (rib 2.15).
    let beads: Vec<(f32, f64)> = widths
        .iter()
        .filter(|w| (1.605..2.155).contains(*w))
        .map(|&w| (w, f64::from(w) - 1.5512 + edge(0.2)))
        .collect();
    check_ribs(
        &json!({}),
        (8.0, &widths),
        0.6,
        0.2,
        &beads,
        &[1.6, 2.16, 2.17, 2.18, 2.19, 2.2],
    );
}

#[test]
fn each_piece_of_a_tapering_gap_bead_takes_the_strip_width_at_its_middle() {
    let g = gcode(arch_and_wedge(), &json!({}));
    // The strip between the wedge's outer walls on the layer at 1 mm: its bead states 0.187 mm at X 107.466 and widens
    // by 0.094 mm per mm.
    let strip = |x: f64| 0.187 + 0.094 * (x - 107.466);
    let mut pieces: Vec<Move> = moves(&g)
        .into_iter()
        .filter(|m| {
            m.feature == "Gap infill"
                && (m.z - 1.0).abs() < 1e-6
                && m.len() >= 0.3
                && (106.0..112.5).contains(&f64::midpoint(m.from[0], m.to[0]))
        })
        .collect();
    pieces.sort_by(|a, b| (a.from[0] + a.to[0]).total_cmp(&(b.from[0] + b.to[0])));
    assert!(pieces.len() >= 8, "{pieces:?}");
    // The narrowest piece keeps a tenth of a millimeter of spacing.
    let first = &pieces[0];
    assert!(
        (first.width - (0.1 + edge(0.2))).abs() <= 0.002,
        "narrowest {first:?}"
    );
    for m in &pieces[1..] {
        let x = f64::midpoint(m.from[0], m.to[0]);
        let e = strip(x);
        assert!(
            (m.width - e).abs() <= 0.002,
            "at X {x:.3} states {}, not {e:.4}",
            m.width
        );
        let ew = e_width(m, 0.2);
        assert!(
            (ew - e).abs() <= 0.002,
            "at X {x:.3} extrudes {ew:.4}, not {e:.4}"
        );
    }
}
