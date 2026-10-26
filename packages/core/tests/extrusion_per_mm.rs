// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Filament per mm of each feature on printers with their own profiles (a Prusa MK4 and a Creality Ender-3 V3 KE),
//! 1.75 mm filament at a flow ratio of 0.98, 0.2 mm layers and a 0.4 mm nozzle.
//!
//! A bead `w` wide and `h` tall has the area `w h - h^2 (1 - pi / 4)`, so a feature prints
//! `area * 0.98 / (pi 0.875^2)` mm of filament per mm of path at its own width.
//!
//! A width of 0 means the width is not set. `initial_layer_line_width` at 0: each first-layer feature prints at its
//! own width (the outer wall at the outer wall's, the inner wall at the inner wall's), and the skirt, brim and
//! support at `line_width`. `support_line_width` at 0: support and its interface print at `line_width` on every
//! layer.
//!
//! An overhang wall piece with `thick_bridges` off prints at its own loop's width (the outer wall's or the inner
//! wall's) and the layer height, at the plain wall flow, whatever `bridge_flow` is. With `thick_bridges` on it is a
//! round bead the nozzle wide.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::disallowed_methods,
    clippy::many_single_char_names,
    reason = "a G-code reader for the test: positions, widths and lengths in mm"
)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::f64::consts::PI;
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

const FLOW: f64 = 0.98;
const H: f64 = 0.2;

fn read(path: &str) -> Value {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    serde_json::from_slice(&std::fs::read(format!("{root}/{path}")).unwrap()).unwrap()
}

/// A shipped printer (`vendor` file, `model` id), its filament and Standard process over the settings defaults,
/// with fixed 0.2 mm layers, classic walls, one skirt loop, no brim and no prime tower, then `extra`.
fn printer(vendor: &str, model: &str, extra: &Value) -> Value {
    let mut c = serde_json::Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        c.insert(k.clone(), v[1].clone());
    }
    let m = &read(&format!("packages/profiles/resolved/{vendor}.json"))["models"][model];
    let base = m["base"].as_str().unwrap();
    for part in [&m["process"][base], &m["filament"], &m["machine"]] {
        c.extend(part.as_object().unwrap().clone());
    }
    let fixed = json!({
        "smart_layer": "off",
        "layer_height": H,
        "initial_layer_print_height": H,
        "wall_generator": "classic",
        "brim_type": "no_brim",
        "skirt_loops": 1,
        "enable_prime_tower": false,
        "enable_arc_fitting": false,
        "use_relative_e_distances": true,
        "filament_flow_ratio": [FLOW],
        "filament_diameter": [1.75],
        "nozzle_diameter": [0.4],
    });
    c.extend(fixed.as_object().unwrap().clone());
    c.extend(extra.as_object().unwrap().clone());
    Value::Object(c)
}

/// The widths the measured cases set: `line_width` 0.48, the walls 0.42 and 0.45, and the first layer and the
/// supports at 0.
fn zero_widths() -> Value {
    json!({
        "line_width": 0.48,
        "outer_wall_line_width": 0.42,
        "inner_wall_line_width": 0.45,
        "internal_solid_infill_line_width": 0.42,
        "sparse_infill_line_width": 0.45,
        "top_surface_line_width": 0.42,
        "initial_layer_line_width": 0,
        "support_line_width": 0,
    })
}

fn mk4(extra: &Value) -> Value {
    let mut c = printer("prusa", "prusa-mk4", &zero_widths());
    c.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    c
}

/// An Ender-3 V3 style setup: 0.42 mm lines, a 0.45 mm inner wall, the first layer and the supports at 0.
fn ender(extra: &Value) -> Value {
    let mut c = printer("creality", "creality-ender-3-v3-ke", &zero_widths());
    c.as_object_mut().unwrap().extend(
        json!({ "line_width": 0.42, "sparse_infill_line_width": 0.42 })
            .as_object()
            .unwrap()
            .clone(),
    );
    c.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    c
}

fn cuboid(x: [f32; 2], y: [f32; 2], z: [f32; 2], name: &str) -> MeshPart {
    let mut positions = Vec::new();
    for zi in z {
        for (xi, yi) in [(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])] {
            positions.push([xi, yi, zi]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    MeshPart {
        name: name.into(),
        slot: 1,
        positions,
        triangles,
        ..MeshPart::default()
    }
}

/// A 20 mm square block 3 mm tall.
fn cube() -> Vec<MeshPart> {
    vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 3.0], "cube")]
}

/// A slab 24 by 10 mm, 2 mm thick, on an 8 mm pillar 5 mm tall at one end: 16 mm of it hangs over air.
fn ledge() -> Vec<MeshPart> {
    vec![
        cuboid([0.0, 8.0], [0.0, 10.0], [0.0, 5.0], "pillar"),
        cuboid([0.0, 24.0], [0.0, 10.0], [5.0, 7.0], "slab"),
    ]
}

/// The extruding moves of one feature at one stated width: path mm and filament mm.
#[derive(Debug, Default, Clone, Copy)]
struct Sum {
    len: f64,
    e: f64,
}

impl Sum {
    fn per_mm(&self) -> f64 {
        self.e / self.len
    }
}

/// Layer z (as written, 2 decimals) -> feature -> stated width in thousandths -> moves.
type Moves = BTreeMap<String, BTreeMap<String, BTreeMap<i64, Sum>>>;

fn slice(parts: Vec<MeshPart>, config: &Value) -> Moves {
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
    let g = String::from_utf8(run.gcode).unwrap();
    let mut out = Moves::new();
    let (mut feature, mut width, mut z, mut at) = (String::new(), 0_i64, String::new(), (0.0, 0.0));
    for line in g.lines() {
        if let Some(f) = line.strip_prefix(";TYPE:") {
            f.trim().clone_into(&mut feature);
            continue;
        }
        if let Some(w) = line.strip_prefix(";WIDTH:") {
            width = (w.trim().parse::<f64>().unwrap() * 1000.0).round() as i64;
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        let mut words = code.split_whitespace();
        let Some(cmd) = words.next() else { continue };
        if cmd != "G0" && cmd != "G1" {
            continue;
        }
        let (mut to, mut e) = (at, 0.0);
        for w in words {
            let (k, v) = w.split_at(1);
            let Ok(v) = v.parse::<f64>() else { continue };
            match k {
                "X" => to.0 = v,
                "Y" => to.1 = v,
                "Z" => z = format!("{v:.2}"),
                "E" => e = v,
                _ => {}
            }
        }
        if cmd == "G1" && e > 0.0 && to != at {
            let s = out
                .entry(z.clone())
                .or_default()
                .entry(feature.clone())
                .or_default()
                .entry(width)
                .or_default();
            s.len += (to.0 - at.0).hypot(to.1 - at.1);
            s.e += e;
        }
        at = to;
    }
    out
}

/// Filament mm per mm of a flat bead `w` wide at the layer height.
fn expected(w: f64) -> f64 {
    let area = w * H - H * H * (1.0 - PI / 4.0);
    area * FLOW / (PI * 0.875 * 0.875)
}

/// Every width a feature is stated at on layer `z`, with its filament per mm.
fn widths(m: &Moves, z: &str, feature: &str) -> BTreeMap<i64, Sum> {
    m.get(z).and_then(|l| l.get(feature)).cloned().unwrap_or_default()
}

/// The feature on layer `z` is stated at `w` only, and prints `expected(w)` per mm to 0.5 percent.
fn assert_width(m: &Moves, z: &str, feature: &str, w: f64, what: &str) {
    let got = widths(m, z, feature);
    assert!(!got.is_empty(), "{what}: no {feature} on layer {z}");
    let want = (w * 1000.0).round() as i64;
    let stated: Vec<i64> = got.keys().copied().collect();
    assert_eq!(
        stated,
        vec![want],
        "{what}: {feature} on layer {z} stated at {stated:?}, want {want}"
    );
    let per_mm = got[&want].per_mm();
    let exp = expected(w);
    assert!(
        (per_mm / exp - 1.0).abs() < 0.005,
        "{what}: {feature} on layer {z}: {per_mm:.6} mm/mm, want {exp:.6} ({w} mm)"
    );
}

/// Every layer z that prints `feature`, past the first, and whether the layer is 0.2 mm above the one below it.
fn later_layers(m: &Moves, feature: &str) -> Vec<(String, bool)> {
    let mut zs: Vec<(f64, &String)> = m.keys().map(|z| (z.parse().unwrap(), z)).collect();
    zs.sort_by(|a, b| a.0.total_cmp(&b.0));
    zs.windows(2)
        .filter(|p| m[p[1].1].contains_key(feature))
        .map(|p| (p[1].1.clone(), (p[1].0 - p[0].0 - H).abs() < 0.005))
        .collect()
}

/// Every later layer states `feature` at `w`; on the 0.2 mm layers (more than 10 of them) it prints `expected(w)`.
fn assert_later(m: &Moves, feature: &str, w: f64, what: &str) {
    let later = later_layers(m, feature);
    let want = (w * 1000.0).round() as i64;
    let mut full = 0;
    for (z, plain) in &later {
        if *plain {
            assert_width(m, z, feature, w, what);
            full += 1;
        } else {
            let stated: Vec<i64> = widths(m, z, feature).keys().copied().collect();
            assert_eq!(
                stated,
                vec![want],
                "{what}: {feature} on layer {z} stated at {stated:?}"
            );
        }
    }
    assert!(full > 10, "{what}: {feature} on {later:?}");
}

#[test]
fn a_zero_first_layer_width_prints_each_feature_at_its_own_width() {
    for (name, cfg, line) in [("ender", ender(&json!({})), 0.42), ("mk4", mk4(&json!({})), 0.48)] {
        let m = slice(cube(), &cfg);
        assert_width(&m, "0.20", "Outer wall", 0.42, name);
        assert_width(&m, "0.20", "Inner wall", 0.45, name);
        assert_width(&m, "0.20", "Skirt", line, name);
    }
}

#[test]
fn a_zero_support_width_prints_support_at_the_line_width_on_every_layer() {
    let support = json!({ "enable_support": true, "support_type": "normal(auto)",
        // Support on the part's own 0.2 mm layers.
        "independent_support_layer_height": false });
    for (name, cfg, line) in [("ender", ender(&support), 0.42), ("mk4", mk4(&support), 0.48)] {
        let m = slice(ledge(), &cfg);
        assert_width(&m, "0.20", "Outer wall", 0.42, name);
        assert_width(&m, "0.20", "Skirt", line, name);
        assert_width(&m, "0.20", "Support", line, name);
        assert_later(&m, "Support", line, name);
        let interface = later_layers(&m, "Support interface");
        assert!(
            interface.iter().any(|(_, plain)| *plain),
            "{name}: support interface on {interface:?}"
        );
        for (z, plain) in &interface {
            if *plain {
                assert_width(&m, z, "Support interface", line, name);
            }
        }
    }
}

#[test]
fn a_zero_first_layer_width_prints_first_layer_support_at_the_line_width() {
    // A support width of its own still gives way to `line_width` on the first layer.
    let cfg = mk4(&json!({ "enable_support": true, "support_type": "normal(auto)",
        // Support on the part's own 0.2 mm layers.
        "independent_support_layer_height": false, "support_line_width": 0.4 }));
    let m = slice(ledge(), &cfg);
    assert_width(&m, "0.20", "Support", 0.48, "mk4");
    assert_later(&m, "Support", 0.4, "mk4");
}

/// The overhang wall pieces of the slab's first layer (z 5.2), by stated width.
fn overhang(cfg: &Value) -> BTreeMap<i64, Sum> {
    let m = slice(ledge(), cfg);
    let got = widths(&m, "5.20", "Overhang wall");
    assert!(
        !got.is_empty(),
        "no overhang wall on the slab's first layer: {:?}",
        m.get("5.20").map(|l| l.keys().collect::<Vec<_>>())
    );
    got
}

#[test]
fn an_overhang_wall_keeps_its_own_width_on_a_printer_with_its_own_profile() {
    for generator in ["classic", "arachne"] {
        for bridge_flow in [1.0, 0.8] {
            for (name, cfg) in [
                (
                    "mk4",
                    mk4(&json!({ "wall_generator": generator, "bridge_flow": bridge_flow })),
                ),
                (
                    "ender",
                    ender(&json!({ "wall_generator": generator, "bridge_flow": bridge_flow })),
                ),
            ] {
                let what = format!("{name} {generator} bridge_flow {bridge_flow}");
                let got = overhang(&cfg);
                let stated: Vec<i64> = got.keys().copied().collect();
                assert_eq!(
                    stated,
                    vec![420, 450],
                    "{what}: overhang wall stated at {stated:?}"
                );
                for (w, s) in &got {
                    let w = *w as f64 / 1000.0;
                    let exp = expected(w);
                    assert!(
                        (s.per_mm() / exp - 1.0).abs() < 0.005,
                        "{what}: overhang wall at {w}: {:.6} mm/mm, want {exp:.6}",
                        s.per_mm()
                    );
                }
            }
        }
    }
}

#[test]
fn a_thick_overhang_wall_stays_a_round_bead_the_nozzle_wide() {
    let got = overhang(&mk4(&json!({ "thick_bridges": true })));
    let stated: Vec<i64> = got.keys().copied().collect();
    assert_eq!(stated, vec![400], "overhang wall stated at {stated:?}");
    let round = PI * 0.4 * 0.4 / 4.0 * FLOW / (PI * 0.875 * 0.875);
    let per_mm = got[&400].per_mm();
    assert!(
        (per_mm / round - 1.0).abs() < 0.005,
        "{per_mm:.6} mm/mm, want {round:.6}"
    );
}
