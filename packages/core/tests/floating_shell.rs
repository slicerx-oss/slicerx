// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Floating vertical shell on Bambu Lab printers: the narrow internal solid band a sloped wall leaves under its top
//! shells, where it rests on the sparse infill below, prints as `Floating vertical shell` at `vertical_shell_speed`
//! with the internal solid infill's filament; its spans over the sparse infill slow to the bridge speed.
//!
//! Our own shapes on P1S-like settings (0.20 mm layers, 0.42 mm solid lines, 15% sparse): a cone that leans in
//! (r 15 to 5 mm, 20 mm tall), the same cone painted with filament 2 on its x > 0 half, a cone that leans out, a 6
//! and a 10 mm wide wall, a 30 mm box under a smaller one that leaves a ring 4 to 6 mm wide on top of it, and a five
//! step pyramid with 6 mm steps.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates and filament lengths in mm"
)]

use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, MeshPart, SliceRequest, SliceRun};

const FLOATING: &str = "Floating vertical shell";
const SOLID: &str = "Internal solid infill";

/// A solid of revolution, 96 sides, from (radius, z) pairs bottom to top, capped at both ends, centered on the
/// plate.
fn revolve(profile: &[(f32, f32)]) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    const SIDES: u32 = 96;
    let mut positions = Vec::new();
    for &(r, z) in profile {
        for i in 0..SIDES {
            let a = std::f32::consts::TAU * i as f32 / SIDES as f32;
            positions.push([128.0 + r * a.cos(), 128.0 + r * a.sin(), z]);
        }
    }
    let ring = |k: usize, i: u32| k as u32 * SIDES + i % SIDES;
    let mut triangles = Vec::new();
    for k in 0..profile.len() - 1 {
        for i in 0..SIDES {
            let (a, b, c, d) = (ring(k, i), ring(k, i + 1), ring(k + 1, i + 1), ring(k + 1, i));
            triangles.push([a, b, c]);
            triangles.push([a, c, d]);
        }
    }
    for (k, up) in [(0, false), (profile.len() - 1, true)] {
        let c = positions.len() as u32;
        positions.push([128.0, 128.0, profile[k].1]);
        for i in 0..SIDES {
            triangles.push(if up {
                [c, ring(k, i), ring(k, i + 1)]
            } else {
                [c, ring(k, i + 1), ring(k, i)]
            });
        }
    }
    (positions, triangles)
}

/// A box `w` by 30 mm, 14 mm tall, centered on the plate.
fn wall(w: f32) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    let (x0, x1, y0, y1) = (128.0 - w / 2.0, 128.0 + w / 2.0, 113.0, 143.0);
    let mut positions = Vec::new();
    for z in [0.0, 14.0] {
        for (x, y) in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)] {
            positions.push([x, y, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    (positions, triangles)
}

/// Square boxes centered on the plate, one closed box per (side, bottom, top) in mm.
fn boxes(tiers: &[(f32, f32, f32)]) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    let mut positions = Vec::new();
    let mut triangles = Vec::new();
    for &(side, z0, z1) in tiers {
        let first = positions.len() as u32;
        let (lo, hi) = (128.0 - side / 2.0, 128.0 + side / 2.0);
        for z in [z0, z1] {
            for (x, y) in [(lo, lo), (hi, lo), (hi, hi), (lo, hi)] {
                positions.push([x, y, z]);
            }
        }
        let mut faces = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
        for k in 0..4u32 {
            let n = (k + 1) % 4;
            faces.push([k, n, 4 + n]);
            faces.push([k, 4 + n, 4 + k]);
        }
        triangles.extend(faces.into_iter().map(|f: [u32; 3]| f.map(|i| first + i)));
    }
    (positions, triangles)
}

/// A 30 x 30 x 2 mm box under a centered square box from z 2 to 4 that leaves a ring `ring` mm wide on top of the
/// lower box. With 5 top layers the ring's internal bridge prints at z 1.2 and its solid at z 1.4, 1.6 and 1.8 (layers
/// 6, 7 and 8 counted from 0).
fn step(ring: f32) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    boxes(&[(30.0, 0.0, 2.0), (30.0 - 2.0 * ring, 2.0, 4.0)])
}

/// Five 2 mm tiers, 70 mm wide at the bottom and 12 mm narrower each step: rings 6 mm wide.
fn pyramid() -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    boxes(&[
        (70.0, 0.0, 2.0),
        (58.0, 2.0, 4.0),
        (46.0, 4.0, 6.0),
        (34.0, 6.0, 8.0),
        (22.0, 8.0, 10.0),
    ])
}

/// The mesh, with the triangles whose middle has x > 0 (plate x > 128) painted filament 2 when `paint`.
fn mesh(shape: (Vec<[f32; 3]>, Vec<[u32; 3]>), paint: bool) -> Arc<Mesh> {
    let (positions, triangles) = shape;
    let mut facets = Vec::new();
    let mut texts = Vec::new();
    if paint {
        for (index, t) in (0u32..).zip(&triangles) {
            let v = t.map(|i| positions[i as usize]);
            if (v[0][0] + v[1][0] + v[2][0]) / 3.0 > 128.0 {
                facets.extend(sx_core::paint::decode("8", v));
                texts.push((0, index, "8".to_owned()));
            }
        }
    }
    Arc::new(Mesh {
        name: "m".into(),
        parts: vec![MeshPart {
            name: "m".into(),
            slot: 1,
            positions,
            triangles,
            paint: facets,
            paint_texts: texts,
            ..MeshPart::default()
        }],
        ..Mesh::default()
    })
}

fn cone() -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    revolve(&[(15.0, 0.0), (5.0, 20.0)])
}

/// P1S 0.20 mm Standard-like settings over the test base: internal solid infill 250 mm/s, bridges 50 mm/s.
fn settings(extra: &Value) -> Value {
    let mut c = json!({
        "printer_model": "Bambu Lab P1S",
        "brim_width": 0,
        "top_shell_thickness": 1,
        "inner_wall_line_width": 0.45,
        "sparse_infill_line_width": 0.45,
        "sparse_infill_pattern": "crosshatch",
        "seam_position": "aligned",
        "filament_max_volumetric_speed": [21, 21, 21, 21],
        "filament_diameter": [1.75, 1.75, 1.75, 1.75],
        "nozzle_temperature": [220, 220, 220, 220],
        "filament_type": ["PLA", "PLA", "PLA", "PLA"],
    });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    c
}

fn slice(shape: (Vec<[f32; 3]>, Vec<[u32; 3]>), paint: bool, extra: &Value) -> (String, SliceRun) {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "m"}]},
        "config": settings(extra),
    }))
    .unwrap();
    let m = mesh(shape, paint);
    let run = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    (String::from_utf8(run.gcode.clone()).unwrap(), run)
}

/// What the G-code prints, read move by move.
#[derive(Default)]
struct Read {
    /// Filament (mm) per feature and filament (1-based).
    e: BTreeMap<(String, u32), f64>,
    /// The layers (0-based) that print each feature.
    layers: BTreeMap<String, BTreeSet<u32>>,
    /// Filament (mm) per feature and layer.
    per_layer: BTreeMap<(String, u32), f64>,
    /// `; FEATURE: Floating vertical shell` blocks per layer.
    blocks: BTreeMap<u32, u32>,
    /// Feed rates of the floating vertical shell's moves, and of those inside slowed spans.
    feeds: BTreeSet<i64>,
    slow_feeds: BTreeSet<i64>,
    /// Filament (mm) of the floating vertical shell inside slowed spans, and the spans.
    slow_e: f64,
    spans: u32,
    /// The extrusion moves of every feature but the floating vertical shell's name, as text: the paths.
    moves: Vec<String>,
}

fn read(g: &str) -> Read {
    let mut r = Read::default();
    let (mut layer, mut started) = (0u32, false);
    let (mut feature, mut tool, mut feed, mut slow) = (String::new(), 1u32, 0i64, false);
    for line in g.lines() {
        let s = line.trim();
        if s.starts_with(";LAYER_CHANGE") || s.starts_with("; CHANGE_LAYER") {
            if started {
                layer += 1;
            }
            started = true;
        }
        if let Some(t) = s.strip_prefix(";TYPE:").or_else(|| s.strip_prefix("; FEATURE: ")) {
            t.clone_into(&mut feature);
            if feature == FLOATING {
                *r.blocks.entry(layer).or_default() += 1;
            }
            continue;
        }
        if s == "; Slow Down Start" {
            slow = true;
            r.spans += 1;
        } else if s == "; Slow Down End" {
            slow = false;
        }
        if let Some(n) = s.strip_prefix('T').and_then(|t| t.parse::<u32>().ok()) {
            tool = n + 1;
        }
        let code = s.split(';').next().unwrap_or("");
        if !(code.starts_with("G1 ") || code.starts_with("G0 ")) {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        if let Some(f) = word('F') {
            feed = f.round() as i64;
        }
        let Some(e) = word('E').filter(|e| *e > 0.0) else {
            continue;
        };
        if word('X').is_none() && word('Y').is_none() {
            continue;
        }
        *r.e.entry((feature.clone(), tool)).or_default() += e;
        r.layers.entry(feature.clone()).or_default().insert(layer);
        *r.per_layer.entry((feature.clone(), layer)).or_default() += e;
        if feature == FLOATING {
            r.feeds.insert(feed);
            if slow {
                r.slow_e += e;
                r.slow_feeds.insert(feed);
            }
        }
        let xy: String = code
            .split_whitespace()
            .filter(|w| w.starts_with('X') || w.starts_with('Y') || w.starts_with('E'))
            .collect::<Vec<_>>()
            .join(" ");
        r.moves.push(xy);
    }
    r
}

impl Read {
    fn total(&self, feature: &str) -> f64 {
        self.e
            .iter()
            .filter(|((f, _), _)| f == feature)
            .map(|(_, v)| v)
            .sum()
    }

    fn of(&self, feature: &str, filament: u32) -> f64 {
        self.e
            .get(&(feature.to_owned(), filament))
            .copied()
            .unwrap_or(0.0)
    }

    fn on(&self, feature: &str) -> BTreeSet<u32> {
        self.layers.get(feature).cloned().unwrap_or_default()
    }

    /// Filament (mm) of `feature` on `layer`.
    fn at(&self, feature: &str, layer: u32) -> f64 {
        self.per_layer
            .get(&(feature.to_owned(), layer))
            .copied()
            .unwrap_or(0.0)
    }

    /// Which of the floating vertical shell and the internal solid infill `layer` prints: "floating", "solid", both
    /// or neither ("-").
    fn label(&self, layer: u32) -> &'static str {
        match (self.at(FLOATING, layer) >= 0.05, self.at(SOLID, layer) >= 0.05) {
            (true, true) => "both",
            (true, false) => "floating",
            (false, true) => "solid",
            (false, false) => "-",
        }
    }
}

/// The ring's three solid layers (z 1.4, 1.6 and 1.8) of `step(ring)` with `walls`, as labels, and the filament of
/// the first and the second.
fn ring_layers(ring: f32, walls: &str, extra: &Value) -> ([&'static str; 3], f64, f64) {
    let mut set = json!({"wall_generator": walls, "sparse_infill_pattern": "grid"});
    if let (Some(c), Some(e)) = (set.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    let (g, _) = slice(step(ring), false, &set);
    let r = read(&g);
    let e = |l: u32| r.at(FLOATING, l) + r.at(SOLID, l);
    ([r.label(6), r.label(7), r.label(8)], e(6), e(7))
}

fn near(value: f64, target: f64) -> bool {
    (value / target - 1.0).abs() <= 0.1
}

#[test]
fn a_cone_prints_its_shell_band_as_a_floating_vertical_shell() {
    let (g, _) = slice(cone(), false, &json!({}));
    let r = read(&g);
    let floating = r.total(FLOATING);
    let solid = r.total(SOLID);
    let layers = r.on(FLOATING);
    // The printer maker's slicer: layers 5 to 95 counted from 1 (4 to 94 here), 176.1 mm floating and 119.7 mm
    // internal solid.
    let (first, last) = (layers.first().copied(), layers.last().copied());
    assert!(
        first == Some(4) && last == Some(94) && layers.len() == 91,
        "floating layers {layers:?}"
    );
    let sum = floating + solid;
    assert!(
        (sum / 295.8 - 1.0).abs() < 0.05,
        "floating {floating:.1} + internal solid {solid:.1}"
    );
    let share = floating / sum;
    assert!((0.5..=0.7).contains(&share), "floating share {share:.2}");
    // On the cone every slowed span is shorter than 2 mm: none is left.
    assert_eq!(r.spans, 0);
    // With narrow detection off: no floating shell, and plain internal solid infill (324.2 mm there).
    let (g, _) = slice(
        cone(),
        false,
        &json!({"detect_narrow_internal_solid_infill": false}),
    );
    let r = read(&g);
    assert_eq!(r.total(FLOATING), 0.0);
    let solid = r.total(SOLID);
    assert!((solid / 324.2 - 1.0).abs() < 0.03, "internal solid {solid:.1}");
}

#[test]
fn with_detection_of_floating_shells_off_the_paths_stay_and_nothing_slows() {
    let (on, _) = slice(cone(), false, &json!({}));
    let (off, _) = slice(cone(), false, &json!({"detect_floating_vertical_shell": false}));
    let (a, b) = (read(&on), read(&off));
    assert!(b.total(FLOATING) > 100.0);
    assert_eq!(a.moves, b.moves, "the same paths");
    assert!(!off.contains("; Slow Down Start"));
    // A wall whose narrow piece hangs over sparse infill: slowed with detection on, not with it off.
    let (on, _) = slice(wall(6.0), false, &json!({}));
    let (off, _) = slice(
        wall(6.0),
        false,
        &json!({"detect_floating_vertical_shell": false}),
    );
    assert!(on.contains("; Slow Down Start"));
    assert!(!off.contains("; Slow Down Start"));
    assert!((read(&on).total(FLOATING) - read(&off).total(FLOATING)).abs() < 0.01);
}

#[test]
fn the_floating_shell_prints_at_its_own_speed_with_the_solid_infill_filament() {
    // Filament 3 prints the internal solid infill; tool changes keep the layers long, so nothing cools slower.
    let three = json!({"internal_solid_filament_id": 3, "enable_prime_tower": true});
    let (g, run) = slice(cone(), false, &three);
    let r = read(&g);
    assert!(r.of(FLOATING, 3) > 150.0, "{:?}", r.e);
    assert_eq!(
        r.total(FLOATING),
        r.of(FLOATING, 3),
        "every floating move on filament 3"
    );
    // 80% of 250 mm/s.
    assert_eq!(r.feeds, BTreeSet::from([12000]));
    // The reports count it as internal solid infill.
    let features = &run.report.feature_filaments[0].features;
    assert_eq!(features.get("internalSolid"), Some(&vec![3]), "{features:?}");
    assert!(features.keys().all(|k| k != "floatingShell"));
    let mut set = three.clone();
    set["vertical_shell_speed"] = json!(["150"]);
    let (g, _) = slice(cone(), false, &set);
    assert_eq!(read(&g).feeds, BTreeSet::from([9000]));
    set["vertical_shell_speed"] = json!(["60%"]);
    let (g, _) = slice(cone(), false, &set);
    assert_eq!(read(&g).feeds, BTreeSet::from([9000]));
}

#[test]
fn a_painted_cone_prints_a_floating_piece_in_each_color() {
    let (g, _) = slice(cone(), true, &json!({"enable_prime_tower": true}));
    let r = read(&g);
    for f in [1, 2] {
        let e = r.of(FLOATING, f);
        assert!((e / 82.0 - 1.0).abs() < 0.1, "filament {f}: {e:.1} {:?}", r.e);
    }
    // One piece a color on each layer.
    let two = r.blocks.values().filter(|n| **n == 2).count();
    assert!(two * 10 >= r.blocks.len() * 9, "{:?}", r.blocks);
}

#[test]
fn a_narrow_piece_over_a_bridge_stays_internal_solid_infill() {
    for w in [6.0, 10.0] {
        let (g, _) = slice(wall(w), false, &json!({}));
        let r = read(&g);
        // The printer maker's slicer: one small floating piece on one layer (1.9 and 2.1 mm), fully slowed.
        let floating = r.total(FLOATING);
        assert!(
            r.blocks.len() <= 1 && r.blocks.values().all(|n| *n == 1),
            "{w} mm: {:?}",
            r.blocks
        );
        assert!(floating < 4.0, "{w} mm: floating {floating:.1}");
        assert!(
            r.total(SOLID) > 10.0 * floating,
            "{w} mm: the rest stays internal solid infill"
        );
        assert!(
            (r.slow_e - floating).abs() < 0.05,
            "{w} mm: slowed {:.2} of {floating:.2}",
            r.slow_e
        );
        assert_eq!(
            r.slow_feeds,
            BTreeSet::from([3000]),
            "{w} mm: at the bridge speed"
        );
        assert_eq!(r.spans, 1, "{w} mm: one slowed span");
    }
}

#[test]
fn a_filament_that_overrides_overhang_speeds_slows_the_spans_to_its_bridge_speed() {
    let (g, _) = slice(
        wall(6.0),
        false,
        &json!({"override_process_overhang_speed": [1, 0, 0, 0], "filament_bridge_speed": [25, 25, 25, 25]}),
    );
    let r = read(&g);
    assert!(r.slow_e > 0.0);
    assert_eq!(r.slow_feeds, BTreeSet::from([1500]));
}

#[test]
fn the_time_report_counts_the_floating_shell_as_internal_solid_infill() {
    let (g, _) = slice(cone(), false, &json!({}));
    assert!(g.contains(FLOATING));
    let cfg = sx_core::api::PrintConfig::from_value(&common::with_base(&settings(&json!({})))).unwrap();
    let est = sx_core::printtime::estimate(g.as_bytes(), &cfg, false);
    assert!(
        est.features.iter().any(|(n, t)| n == SOLID && *t > 0.0),
        "{:?}",
        est.features
    );
    assert!(
        est.features.iter().all(|(n, _)| n != FLOATING),
        "{:?}",
        est.features
    );
}

#[test]
fn the_solid_over_a_ring_bridge_rests_on_it_and_the_narrow_layers_above_float() {
    // The printer maker's slicer on the stock P1S profile, filament of the first and the second solid layer.
    for (ring, walls, first, second) in [
        (4.0, "classic", 34.98, 34.98),
        (4.0, "aegis", 32.27, 32.27),
        (4.5, "classic", 38.19, 38.19),
        (4.5, "aegis", 35.44, 35.44),
    ] {
        let (labels, a, b) = ring_layers(ring, walls, &json!({}));
        assert_eq!(
            labels,
            ["solid", "floating", "floating"],
            "{ring} mm ring, {walls} walls"
        );
        assert!(
            near(a, first) && near(b, second),
            "{ring} mm ring, {walls} walls: {a:.2} and {b:.2}"
        );
    }
}

#[test]
fn a_ring_of_4_75_mm_floats_with_variable_width_walls_only() {
    let (labels, a, _) = ring_layers(4.75, "classic", &json!({}));
    assert_eq!(labels, ["solid", "solid", "solid"], "classic walls");
    assert!(near(a, 40.11), "classic walls: {a:.2}");
    let (labels, a, b) = ring_layers(4.75, "aegis", &json!({}));
    assert_eq!(labels, ["solid", "floating", "floating"], "aegis walls");
    assert!(near(a, 37.11) && near(b, 37.11), "aegis walls: {a:.2} and {b:.2}");
}

#[test]
fn rings_of_5_mm_and_more_stay_internal_solid_infill() {
    for (ring, walls, solid) in [
        (5.0, "classic", 41.56),
        (5.0, "aegis", 39.1),
        (6.0, "classic", 46.89),
        (6.0, "aegis", 44.72),
    ] {
        let (labels, a, b) = ring_layers(ring, walls, &json!({}));
        assert_eq!(
            labels,
            ["solid", "solid", "solid"],
            "{ring} mm ring, {walls} walls"
        );
        assert!(
            near(a, solid) && near(b, solid),
            "{ring} mm ring, {walls} walls: {a:.2} and {b:.2}"
        );
    }
}

#[test]
fn a_ring_floats_only_with_the_vertical_shell_rule_and_narrow_detection_on() {
    // Without the vertical shell rule the ring's solid does not reach past the solid under it; with narrow detection
    // off nothing floats.
    for extra in [
        json!({"ensure_vertical_shell_thickness": "disabled"}),
        json!({"detect_narrow_internal_solid_infill": false}),
    ] {
        let (labels, _, _) = ring_layers(4.0, "classic", &extra);
        assert_eq!(labels, ["solid", "solid", "solid"], "{extra}");
    }
}

#[test]
fn the_pyramid_floats_only_the_loop_under_each_step_bridge() {
    // The printer maker's slicer on the stock P1S profile: floating 25.5 mm under the bridges at z 1, 3, 5, 7 and 9
    // (layers 4 to 44), internal solid infill 1994.6 mm. Its classic walls also float a loop on the two layers over
    // each step, which this does not cover.
    for (walls, solid) in [("classic", 1994.56), ("aegis", 1932.06)] {
        let (g, _) = slice(
            pyramid(),
            false,
            &json!({"wall_generator": walls, "sparse_infill_pattern": "grid"}),
        );
        let r = read(&g);
        assert_eq!(
            r.on(FLOATING),
            BTreeSet::from([4, 14, 24, 34, 44]),
            "{walls} walls"
        );
        let (floating, internal) = (r.total(FLOATING), r.total(SOLID));
        assert!(near(floating, 25.47), "{walls} walls: floating {floating:.1}");
        assert!(
            near(internal, solid),
            "{walls} walls: internal solid {internal:.1}"
        );
    }
    let (g, _) = slice(
        pyramid(),
        false,
        &json!({"sparse_infill_pattern": "grid", "detect_narrow_internal_solid_infill": false}),
    );
    assert_eq!(read(&g).total(FLOATING), 0.0);
}
