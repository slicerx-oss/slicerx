// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Normal support on layers of its own height under round bridge strands (`thick_bridges`) on printers other than
//! Bambu Lab ones.
//!
//! A round strand `d` across (the bridge line width times the root of `bridge_flow`) hangs `d` minus the layer height
//! below its layer, so the top contact under it sits the top gap below the strand: at `T - d - gap`, where `T` is the
//! top of the first layer over the overhang, instead of `T - h - gap`. The layers under the contact step evenly up to
//! it, as before. A support layer resting on a top surface of the part is `bw f` thick (the bridge line width times
//! `bridge_flow`), from the surface plus the bottom gap up, and prints a round bead of that diameter over the part.
//!
//! The model is a bridge span: a 2 mm slab over two posts `p` mm tall, with wings past the posts and a box beside
//! it, and optionally a 2 mm pad under the left wing.
#![allow(
    clippy::cast_possible_truncation,
    clippy::disallowed_methods,
    clippy::many_single_char_names,
    reason = "a G-code reader for the test: positions and lengths in mm"
)]

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

fn read(path: &str) -> Value {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    serde_json::from_slice(&std::fs::read(format!("{root}/{path}")).unwrap()).unwrap()
}

fn cuboid(lo: [f64; 3], hi: [f64; 3], name: &str) -> MeshPart {
    // Placed on the bed around (110, 110).
    let positions = (0..8)
        .map(|i| {
            [
                (110.0 + if i & 1 == 0 { lo[0] } else { hi[0] }) as f32,
                (110.0 + if i & 2 == 0 { lo[1] } else { hi[1] }) as f32,
                (if i & 4 == 0 { lo[2] } else { hi[2] }) as f32,
            ]
        })
        .collect();
    MeshPart {
        name: name.into(),
        slot: 1,
        positions,
        triangles: vec![
            [0, 2, 1],
            [1, 2, 3],
            [4, 5, 6],
            [5, 7, 6],
            [0, 1, 4],
            [1, 5, 4],
            [2, 6, 3],
            [3, 6, 7],
            [0, 4, 2],
            [2, 4, 6],
            [1, 3, 5],
            [3, 7, 5],
        ],
        ..MeshPart::default()
    }
}

/// The span: posts at x -27 to -19 and -7 to 1, `p` mm tall, the slab from `p` to `p + 2` reaching `wl` and `wr`
/// past them, a box at x 13 to 33 as tall as the slab's top, all 16 mm deep. `l` cuts the left wing's back half to
/// half its width; `pad` adds a 4 x 16 x 2 mm pad under the left wing.
#[derive(Clone, Copy)]
struct Span {
    p: f64,
    wl: f64,
    wr: f64,
    l: bool,
    pad: bool,
}

const SPAN: Span = Span {
    p: 6.0,
    wl: 6.0,
    wr: 6.0,
    l: false,
    pad: false,
};

fn span(s: Span) -> Vec<MeshPart> {
    let (p, top) = (s.p, s.p + 2.0);
    let left = -27.0 - s.wl;
    let mut parts = vec![
        cuboid([-27.0, -8.0, 0.0], [-19.0, 8.0, p], "post"),
        cuboid([-7.0, -8.0, 0.0], [1.0, 8.0, p], "post"),
        cuboid([13.0, -8.0, 0.0], [33.0, 8.0, top], "box"),
    ];
    if s.l {
        parts.push(cuboid([left, -8.0, p], [1.0 + s.wr, 0.0, top], "slab"));
        parts.push(cuboid(
            [-27.0 - s.wl / 2.0, 0.0, p],
            [1.0 + s.wr, 8.0, top],
            "slab",
        ));
    } else {
        parts.push(cuboid([left, -8.0, p], [1.0 + s.wr, 8.0, top], "slab"));
    }
    if s.pad {
        parts.push(cuboid([-32.0, -8.0, 0.0], [-28.0, 8.0, 2.0], "pad"));
    }
    parts
}

/// The settings defaults with one of three printers' process, filament and machine values that decide support:
/// `e` a 0.4 mm Klipper bedslinger (3 top interface layers, no bottom interface, layers up to 0.35 mm, support on
/// the bed only), `m` a Marlin printer (2 and 2 interface layers, up to 0.3 mm) and `v` another Klipper printer
/// (`bridge_flow` 0.95, up to 0.32 mm), then `extra`.
fn config(printer: char, extra: &Value) -> Value {
    let mut c = serde_json::Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        c.insert(k.clone(), v[1].clone());
    }
    let common = json!({
        "smart_layer": "off",
        "enable_support": true,
        "support_type": "normal(auto)",
        "independent_support_layer_height": true,
        "bridge_no_support": true,
        "brim_type": "no_brim",
        "skirt_loops": 1,
        "enable_prime_tower": false,
        "enable_arc_fitting": false,
        "use_relative_e_distances": true,
        "filament_flow_ratio": [1.0],
        "filament_diameter": [1.75],
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "support_top_z_distance": 0.2,
        "support_bottom_z_distance": 0.2,
    });
    let own = match printer {
        'e' => json!({
            "printer_model": "Creality Ender-3 V3",
            "gcode_flavor": "klipper",
            "line_width": "0.42",
            "inner_wall_line_width": "0.42",
            "outer_wall_line_width": "0.42",
            "internal_solid_infill_line_width": "0.42",
            "sparse_infill_line_width": "0.42",
            "top_surface_line_width": "0.42",
            "support_line_width": "0",
            "wall_generator": "classic",
            "support_on_build_plate_only": true,
            "support_threshold_angle": 25,
            "support_interface_top_layers": 3,
            "support_interface_bottom_layers": 0,
            "max_layer_height": [0.35],
            "min_layer_height": [0.1],
        }),
        'm' => json!({
            "printer_model": "Prusa MK4",
            "gcode_flavor": "marlin2",
            "initial_layer_line_width": "120%",
            "line_width": "110%",
            "inner_wall_line_width": "110%",
            "outer_wall_line_width": "100%",
            "internal_solid_infill_line_width": "120%",
            "sparse_infill_line_width": "110%",
            "top_surface_line_width": "93.75%",
            "support_line_width": "96%",
            "wall_generator": "arachne",
            "wall_loops": 3,
            "support_on_build_plate_only": false,
            "support_threshold_angle": 30,
            "support_interface_top_layers": 2,
            "support_interface_bottom_layers": 2,
            "max_layer_height": [0.3],
            "min_layer_height": [0.08],
        }),
        _ => json!({
            "printer_model": "Voron 2.4 300",
            "gcode_flavor": "klipper",
            "bridge_flow": 0.95,
            "initial_layer_line_width": "0.5",
            "line_width": "0.4",
            "inner_wall_line_width": "0.4",
            "outer_wall_line_width": "0.4",
            "internal_solid_infill_line_width": "0.4",
            "sparse_infill_line_width": "0.45",
            "top_surface_line_width": "0.4",
            "support_line_width": "0.4",
            "support_base_pattern": "rectilinear",
            "wall_generator": "arachne",
            "wall_loops": 3,
            "support_on_build_plate_only": false,
            "support_threshold_angle": 30,
            "support_interface_top_layers": 2,
            "support_interface_bottom_layers": 2,
            "max_layer_height": [0.32],
            "min_layer_height": [0.1],
        }),
    };
    for part in [&common, &own, extra] {
        c.extend(part.as_object().unwrap().clone());
    }
    Value::Object(c)
}

/// A 0.6 mm nozzle with every line width scaled to it.
fn nozzle6(printer: char) -> Value {
    match printer {
        'e' => json!({
            "nozzle_diameter": [0.6],
            "line_width": 0.63,
            "inner_wall_line_width": 0.63,
            "outer_wall_line_width": 0.63,
            "internal_solid_infill_line_width": 0.63,
            "sparse_infill_line_width": 0.63,
            "top_surface_line_width": 0.63,
        }),
        'm' => json!({"nozzle_diameter": [0.6]}),
        _ => json!({
            "nozzle_diameter": [0.6],
            "initial_layer_line_width": 0.75,
            "line_width": 0.6,
            "inner_wall_line_width": 0.6,
            "outer_wall_line_width": 0.6,
            "internal_solid_infill_line_width": 0.6,
            "sparse_infill_line_width": 0.675,
            "support_line_width": 0.6,
            "top_surface_line_width": 0.6,
        }),
    }
}

fn merged(a: &Value, b: &Value) -> Value {
    let mut c = a.as_object().unwrap().clone();
    c.extend(b.as_object().unwrap().clone());
    Value::Object(c)
}

fn slice(parts: Vec<MeshPart>, config: &Value) -> String {
    let mesh = Arc::new(Mesh {
        name: "m".into(),
        parts,
        ..Mesh::default()
    });
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "m"}]},
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// An extruding move: its feature, the layer's z, the segment's ends and its filament.
struct Move {
    feature: String,
    z: f64,
    from: (f64, f64),
    to: (f64, f64),
    e: f64,
}

fn moves(g: &str) -> Vec<Move> {
    let mut out = Vec::new();
    let (mut feature, mut z, mut at) = (String::new(), 0.0, (0.0, 0.0));
    for line in g.lines() {
        if let Some(f) = line
            .strip_prefix(";TYPE:")
            .or_else(|| line.strip_prefix("; FEATURE:"))
        {
            f.trim().clone_into(&mut feature);
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        if !(code.starts_with("G1 ") || code.starts_with("G0 ")) {
            continue;
        }
        let (mut x, mut y, mut e) = (at.0, at.1, 0.0);
        for w in code.split_whitespace().skip(1) {
            let v = || w[1..].parse::<f64>().unwrap();
            match w.as_bytes()[0] {
                b'X' => x = v(),
                b'Y' => y = v(),
                b'Z' => z = (v() * 1000.0).round() / 1000.0,
                b'E' => e = v(),
                _ => {}
            }
        }
        if e > 0.0 && (x, y) != at {
            out.push(Move {
                feature: feature.clone(),
                z,
                from: at,
                to: (x, y),
                e,
            });
        }
        at = (x, y);
    }
    out
}

fn support_moves(g: &str) -> Vec<Move> {
    moves(g)
        .into_iter()
        .filter(|m| m.feature.starts_with("Support"))
        .collect()
}

/// Where the part sits on the bed: its smallest x and its middle in y, from the part's own paths.
fn part_at(g: &str) -> (f64, f64) {
    let ms = moves(g);
    let part = ms
        .iter()
        .filter(|m| !m.feature.starts_with("Support") && !m.feature.starts_with("Skirt"))
        .flat_map(|m| [m.from, m.to]);
    let (mut x0, mut y0, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for (x, y) in part {
        (x0, y0, y1) = (x0.min(x), y0.min(y), y1.max(y));
    }
    (x0, f64::midpoint(y0, y1))
}

fn len(m: &Move) -> f64 {
    (m.to.0 - m.from.0).hypot(m.to.1 - m.from.1)
}

/// The heights support prints at, at or above `from` mm, counting layers with at least 2 mm of support.
fn support_zs(g: &str, from: f64) -> Vec<f64> {
    let mut zs: Vec<(f64, f64)> = Vec::new();
    for m in support_moves(g).iter().filter(|m| m.z >= from) {
        match zs.iter_mut().find(|(z, _)| (*z - m.z).abs() < 1e-6) {
            Some(slot) => slot.1 += len(m),
            None => zs.push((m.z, len(m))),
        }
    }
    let mut zs: Vec<f64> = zs
        .into_iter()
        .filter(|(_, l)| *l >= 2.0)
        .map(|(z, _)| z)
        .collect();
    zs.sort_by(f64::total_cmp);
    zs
}

fn assert_zs(name: &str, got: &[f64], want: &[f64]) {
    assert!(
        got.len() == want.len() && got.iter().zip(want).all(|(g, w)| (g - w).abs() < 0.0015),
        "{name}: support at {got:?}, want {want:?}"
    );
}

#[test]
#[allow(clippy::too_many_lines, reason = "one table of cases")]
fn the_top_contact_keeps_its_gap_under_a_round_strand() {
    // (case, printer, model, extra settings, the support heights from 4.5 mm up to the contact).
    let tb = json!({"thick_bridges": true});
    let with = |v: Value| merged(&tb, &v);
    let cases: Vec<(&str, char, Span, Value, Vec<f64>)> = vec![
        ("e-tb1", 'e', SPAN, tb.clone(), vec![4.588, 4.925, 5.263, 5.6]),
        (
            "e-tb1h28",
            'e',
            SPAN,
            with(json!({"layer_height": 0.28})),
            vec![4.718, 5.065, 5.413, 5.76],
        ),
        ("e-tb1n6", 'e', SPAN, with(nozzle6('e')), vec![4.707, 5.053, 5.4]),
        (
            "e-tb1g3",
            'e',
            SPAN,
            with(json!({"support_top_z_distance": 0.3})),
            vec![4.506, 4.838, 5.169, 5.5],
        ),
        (
            "e-tb1bf08",
            'e',
            SPAN,
            with(json!({"bridge_flow": 0.8})),
            vec![4.622, 4.962, 5.302, 5.642],
        ),
        ("e-tb1p51", 'e', Span { p: 5.1, ..SPAN }, tb.clone(), vec![4.8]),
        (
            "e-tb1p73",
            'e',
            Span { p: 7.3, ..SPAN },
            tb.clone(),
            vec![4.62, 4.96, 5.3, 5.64, 5.98, 6.32, 6.66, 7.0],
        ),
        (
            "e-tb1x15",
            'e',
            SPAN,
            with(json!({"support_expansion": 1.5})),
            vec![4.588, 4.925, 5.263, 5.6],
        ),
        (
            "e-tb1w3",
            'e',
            Span {
                wl: 3.0,
                wr: 3.0,
                ..SPAN
            },
            tb.clone(),
            vec![4.588, 4.925, 5.263, 5.6],
        ),
        (
            "e-tb1wl14",
            'e',
            Span { wl: 14.0, ..SPAN },
            tb.clone(),
            vec![4.588, 4.925, 5.263, 5.6],
        ),
        (
            "e-tb1L",
            'e',
            Span { l: true, ..SPAN },
            tb.clone(),
            vec![4.588, 4.925, 5.263, 5.6],
        ),
        (
            "e-tb1i1",
            'e',
            SPAN,
            with(json!({"support_interface_top_layers": 1})),
            vec![4.588, 4.925, 5.263, 5.6],
        ),
        ("m-tb1", 'm', SPAN, tb.clone(), vec![4.7, 5.0, 5.3, 5.6]),
        (
            "m-tb1h28",
            'm',
            SPAN,
            with(json!({"layer_height": 0.28})),
            vec![4.589, 4.882, 5.175, 5.467, 5.76],
        ),
        (
            "m-tb1n6",
            'm',
            SPAN,
            with(nozzle6('m')),
            vec![4.533, 4.822, 5.111, 5.4],
        ),
        (
            "m-tb1g3",
            'm',
            SPAN,
            with(json!({"support_top_z_distance": 0.3})),
            vec![4.617, 4.911, 5.206, 5.5],
        ),
        ("v-tb1", 'v', SPAN, tb.clone(), vec![4.655, 4.974, 5.292, 5.61]),
        (
            "v-tb1h28",
            'v',
            SPAN,
            with(json!({"layer_height": 0.28})),
            vec![4.532, 4.842, 5.151, 5.461, 5.77],
        ),
        (
            "v-tb1n6",
            'v',
            SPAN,
            with(nozzle6('v')),
            vec![4.802, 5.108, 5.415],
        ),
    ];
    std::thread::scope(|s| {
        for (name, printer, model, extra, want) in &cases {
            s.spawn(move || {
                let g = slice(span(*model), &config(*printer, extra));
                assert_zs(name, &support_zs(&g, 4.5), want);
            });
        }
    });
}

#[test]
fn without_round_strands_or_a_top_gap_the_contact_stays() {
    // Flat strands, a zero top gap, and a Bambu Lab printer keep the contact one layer and the gap under the slab.
    let cases: Vec<(&str, char, Value, Vec<f64>)> = vec![
        ("e-tb0", 'e', json!({}), vec![4.75, 5.1, 5.45, 5.8]),
        (
            "m-tb1-bambu",
            'm',
            json!({"thick_bridges": true, "printer_model": "Bambu Lab X1 Carbon", "gcode_flavor": "marlin"}),
            vec![4.621, 4.916, 5.211, 5.505, 5.8],
        ),
    ];
    std::thread::scope(|s| {
        for (name, printer, extra, want) in &cases {
            s.spawn(move || {
                let g = slice(span(SPAN), &config(*printer, extra));
                assert_zs(name, &support_zs(&g, 4.5), want);
            });
        }
    });
    // A zero top gap: the contact takes the place of the layer under the slab, round strands or not.
    let flat = slice(span(SPAN), &config('e', &json!({"support_top_z_distance": 0})));
    let round = slice(
        span(SPAN),
        &config('e', &json!({"support_top_z_distance": 0, "thick_bridges": true})),
    );
    assert_eq!(support_zs(&flat, 4.5), support_zs(&round, 4.5));
}

#[test]
fn support_resting_on_the_part_prints_a_round_bead() {
    // (case, printer, extra settings, top of the layer resting on the pad, its filament per mm over the pad).
    // The bead is `bw f` across: pi (bw f)^2 / 4 mm2 of plastic, over the 1.75 mm filament's 2.4053 mm2.
    let tb = json!({"thick_bridges": true, "support_on_build_plate_only": false});
    let with = |v: Value| merged(&tb, &v);
    let cases: Vec<(&str, char, Value, f64, f64)> = vec![
        ("e-tb1pad", 'e', tb.clone(), 2.6, 0.05224),
        (
            "e-tb1padb3",
            'e',
            with(json!({"support_bottom_z_distance": 0.3})),
            2.7,
            0.05224,
        ),
        (
            "e-tb1padh28",
            'e',
            with(json!({"layer_height": 0.28})),
            2.48,
            0.05224,
        ),
        ("e-tb1padn6", 'e', with(nozzle6('e')), 2.8, 0.11756),
        ("m-tb1pad", 'm', tb.clone(), 2.6, 0.0522),
        (
            "m-tb1padn6b3",
            'm',
            with(merged(&nozzle6('m'), &json!({"support_bottom_z_distance": 0.3}))),
            2.9,
            0.1176,
        ),
        ("v-tb1pad", 'v', tb.clone(), 2.58, 0.04715),
        ("v-tb1padn6", 'v', with(nozzle6('v')), 2.77, 0.1061),
    ];
    std::thread::scope(|s| {
        for (name, printer, extra, top, per_mm) in &cases {
            s.spawn(move || {
                let model = span(Span { pad: true, ..SPAN });
                let g = slice(model, &config(*printer, extra));
                // The pad, 1 to 5 mm in from the left wing's edge, and the line width around it that rests on it.
                let (x0, y) = part_at(&g);
                let over_pad = |p: (f64, f64)| {
                    (x0 + 0.5..=x0 + 5.5).contains(&p.0) && (y - 8.5..=y + 8.5).contains(&p.1)
                };
                let zs = support_zs(&g, 2.05);
                let lowest = zs.first().copied().unwrap_or(0.0);
                // The lowest support over the pad's top (2 mm) is the layer resting on it.
                let on_pad: Vec<Move> = support_moves(&g)
                    .into_iter()
                    .filter(|m| over_pad(m.from) && over_pad(m.to) && len(m) >= 1.0)
                    .collect();
                let first = on_pad
                    .iter()
                    .map(|m| m.z)
                    .filter(|z| *z > 2.0)
                    .fold(f64::INFINITY, f64::min);
                assert!(
                    (first - top).abs() < 0.0015,
                    "{name}: support over the pad starts at {first}, want {top} (lowest support {lowest})"
                );
                let (l, e) = on_pad
                    .iter()
                    .filter(|m| (m.z - first).abs() < 1e-6)
                    .fold((0.0, 0.0), |(l, e), m| (l + len(m), e + m.e));
                assert!(
                    l > 2.0 && ((e / l) / per_mm - 1.0).abs() < 0.01,
                    "{name}: {:.5} mm of filament per mm over {l:.1} mm at {first}, want {per_mm}",
                    e / l
                );
            });
        }
    });
}
