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
//! An overhang wall piece with `thick_bridges` off and classic walls prints the external bridge bead on every loop:
//! `bridge_line_width` at `bridge_flow`, narrowed at the layer height below a flow of 1, and above 1 stated as a
//! bead `bridge_flow` times taller of the same area. With arachne walls it prints at its own loop's width (the outer
//! wall's or the inner wall's) and the layer height, at the plain wall flow at a `bridge_flow` of 1 or less. With
//! `thick_bridges` on it is a
//! round bead the nozzle wide, and its comments state the bead's diameter as both its width and its height (the
//! nozzle times the root of `bridge_flow`), extra perimeters on overhangs included; the next feature states the
//! layer height again. The preview draws those beads as tall as the comments state.
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
    moves(&run(parts, config).0)
}

/// The G-code and the SXPV preview of one slice.
fn run(parts: Vec<MeshPart>, config: &Value) -> (String, Vec<u8>) {
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
    (String::from_utf8(run.gcode).unwrap(), run.preview)
}

fn moves(g: &str) -> Moves {
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
fn an_arachne_overhang_wall_keeps_its_own_width_on_a_printer_with_its_own_profile() {
    for bridge_flow in [1.0, 0.8] {
        for (name, cfg) in [
            (
                "mk4",
                mk4(&json!({ "wall_generator": "arachne", "bridge_flow": bridge_flow })),
            ),
            (
                "ender",
                ender(&json!({ "wall_generator": "arachne", "bridge_flow": bridge_flow })),
            ),
        ] {
            let what = format!("{name} arachne bridge_flow {bridge_flow}");
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

/// A flat bead `w` wide at the layer height and `flow` times its extrusion: the width and height the comments state,
/// in thousandths (above a flow of 1 a bead `flow` times taller of the same area), and its filament per mm.
fn flat_bead(w: f64, flow: f64) -> ((i64, i64), f64) {
    let per_mm = expected(w) * flow;
    if flow <= 1.0 {
        return (((w * 1000.0).round() as i64, 200), per_mm);
    }
    let tall = H * flow;
    let area = w * H - H * H * (1.0 - PI / 4.0);
    let width = flow * area / tall + tall * (1.0 - PI / 4.0);
    (
        ((width * 1000.0).round() as i64, (tall * 1000.0).round() as i64),
        per_mm,
    )
}

/// The overhang wall pieces of the slab's first layer are stated at `want` only, each at its filament per mm.
fn assert_overhang_beads(cfg: &Value, want: &[((i64, i64), f64)], what: &str) {
    let (got, _) = stated_beads(&run(ledge(), cfg).0);
    let stated: Vec<(i64, i64)> = got.keys().copied().collect();
    let keys: Vec<(i64, i64)> = want.iter().map(|w| w.0).collect();
    assert_eq!(stated, keys, "{what}: overhang wall stated at {stated:?}");
    for (key, exp) in want {
        let per_mm = got[key].per_mm();
        assert!(
            (per_mm / exp - 1.0).abs() < 0.005,
            "{what}: overhang wall at {key:?}: {per_mm:.6} mm/mm, want {exp:.6}"
        );
    }
}

#[test]
fn an_arachne_overhang_wall_takes_the_bridge_flow_above_one() {
    // Each loop's own width (0.42 outer, 0.45 inner) at 1.2 times its extrusion, stated 0.428584 and 0.458584 wide
    // and 0.24 tall.
    let extra = json!({ "wall_generator": "arachne", "bridge_flow": 1.2 });
    for (name, cfg) in [("mk4", mk4(&extra)), ("ender", ender(&extra))] {
        let what = format!("{name} arachne bridge_flow 1.2");
        assert_overhang_beads(&cfg, &[flat_bead(0.42, 1.2), flat_bead(0.45, 1.2)], &what);
    }
}

#[test]
fn a_classic_overhang_wall_prints_the_bridge_bead_on_a_printer_with_its_own_profile() {
    // `bridge_line_width` 100% of the 0.4 nozzle on both loops: 0.4 at a flow of 1, narrowed to 0.328584 at 0.8, and
    // at 1.2 the 0.4 bead at 1.2 times its extrusion, stated 0.408584 wide and 0.24 tall.
    for (bridge_flow, w) in [(1.0_f64, 0.4), (0.8, 0.328_584), (1.2, 0.4)] {
        let extra = json!({ "bridge_flow": bridge_flow, "bridge_line_width": "100%" });
        for (name, cfg) in [("mk4", mk4(&extra)), ("ender", ender(&extra))] {
            let what = format!("{name} classic bridge_flow {bridge_flow}");
            // Below 1 the narrowed bead carries the flow in its width.
            assert_overhang_beads(&cfg, &[flat_bead(w, bridge_flow.max(1.0))], &what);
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

/// The overhang wall moves of the slab's first layer (z 5.2) by stated width and height in thousandths, and the
/// height, in thousandths, each feature that follows an overhang wall block states when it first extrudes.
fn stated_beads(g: &str) -> (BTreeMap<(i64, i64), Sum>, Vec<i64>) {
    let thousandths = |v: &str| (v.trim().parse::<f64>().unwrap() * 1000.0).round() as i64;
    let mut out: BTreeMap<(i64, i64), Sum> = BTreeMap::new();
    let mut after = Vec::new();
    let (mut feature, mut width, mut height, mut z) = (String::new(), 0_i64, 0_i64, String::new());
    let (mut at, mut pending) = ((0.0, 0.0), false);
    for line in g.lines() {
        if let Some(f) = line.strip_prefix(";TYPE:") {
            if feature == "Overhang wall" && f.trim() != "Overhang wall" {
                pending = true;
            }
            f.trim().clone_into(&mut feature);
            continue;
        }
        if let Some(w) = line.strip_prefix(";WIDTH:") {
            width = thousandths(w);
            continue;
        }
        if let Some(h) = line.strip_prefix(";HEIGHT:") {
            height = thousandths(h);
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
            if pending {
                after.push(height);
                pending = false;
            }
            if feature == "Overhang wall" && z == "5.20" {
                let s = out.entry((width, height)).or_default();
                s.len += (to.0 - at.0).hypot(to.1 - at.1);
                s.e += e;
            }
        }
        at = to;
    }
    (out, after)
}

/// Filament mm per mm of a round thread `d` across.
fn round_per_mm(d: f64) -> f64 {
    PI * d * d / 4.0 * FLOW / (PI * 0.875 * 0.875)
}

/// The ledge with extra perimeters on overhangs, on the Ender-3 V3 and the MK4 setups, then `extra`.
fn extra_cases(extra: &Value) -> Vec<(&'static str, Value)> {
    let mut on = json!({ "extra_perimeters_on_overhangs": true, "bridge_line_width": "100%" });
    on.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    vec![("ender", ender(&on)), ("mk4", mk4(&on))]
}

#[test]
fn a_round_overhang_bead_states_its_diameter_as_its_height() {
    // A round thread 0.4 * sqrt(bridge_flow) across: 0.4 at a flow of 1, 0.357771 at 0.8.
    for (flow, d) in [(1.0, 0.4_f64), (0.8, 0.357_771)] {
        for (name, cfg) in extra_cases(&json!({ "thick_bridges": true, "bridge_flow": flow })) {
            let what = format!("{name} bridge_flow {flow}");
            let (g, _) = run(ledge(), &cfg);
            let (got, after) = stated_beads(&g);
            let want = (d * 1000.0).round() as i64;
            let stated: Vec<(i64, i64)> = got.keys().copied().collect();
            assert_eq!(
                stated,
                vec![(want, want)],
                "{what}: overhang wall stated at {stated:?}"
            );
            let per_mm = got[&(want, want)].per_mm();
            assert!(
                (per_mm / round_per_mm(d) - 1.0).abs() < 0.005,
                "{what}: {per_mm:.6} mm/mm, want {:.6}",
                round_per_mm(d)
            );
            assert!(!after.is_empty(), "{what}: nothing after the overhang walls");
            assert!(
                after.iter().all(|h| *h == 200),
                "{what}: heights after the overhang walls {after:?}"
            );
        }
    }
}

#[test]
fn a_flat_overhang_bead_states_the_layer_height() {
    // thick_bridges off: extra perimeters and the classic loop pieces print the flat strand (0.4, or 0.329 at a
    // flow of 0.8, or the inner wall's 0.45 with no bridge line width), all at the layer height.
    for (extra, widths) in [
        (json!({ "bridge_flow": 1.0 }), vec![400, 420, 450]),
        (json!({ "bridge_flow": 0.8 }), vec![329, 420, 450]),
        (
            json!({ "bridge_flow": 1.0, "bridge_line_width": 0 }),
            vec![420, 450],
        ),
    ] {
        for (name, cfg) in extra_cases(&extra) {
            let what = format!("{name} {extra}");
            let (got, after) = stated_beads(&run(ledge(), &cfg).0);
            assert!(!got.is_empty(), "{what}: no overhang wall");
            for ((w, h), s) in &got {
                assert_eq!(*h, 200, "{what}: overhang wall {w} stated {h} tall");
                assert!(widths.contains(w), "{what}: overhang wall stated {w} wide");
                let exp = expected(*w as f64 / 1000.0);
                assert!(
                    (s.per_mm() / exp - 1.0).abs() < 0.005,
                    "{what}: overhang wall at {w}: {:.6} mm/mm, want {exp:.6}",
                    s.per_mm()
                );
            }
            assert!(after.iter().all(|h| *h == 200), "{what}: {after:?}");
        }
    }
}

/// One preview segment: feature id, z, width and height in micrometers.
fn preview_segments(sxpv: &[u8]) -> Vec<(u8, f32, u16, u16)> {
    let info = sx_core::preview::read_info(sxpv).unwrap();
    let u16_at = |at: usize| u16::from_le_bytes([sxpv[at], sxpv[at + 1]]);
    (0..info.segments)
        .map(|i| {
            let s = info.segments_at + i * sx_core::preview::SEGMENT_BYTES;
            let z = f32::from_le_bytes(sxpv[s + 16..s + 20].try_into().unwrap());
            (sxpv[s + 24], z, u16_at(s + 20), u16_at(s + 22))
        })
        .collect()
}

#[test]
fn the_preview_draws_a_round_overhang_bead_as_tall_as_it_is_wide() {
    const OVERHANG_WALL: u8 = 2;
    const CUSTOM: u8 = 14;
    for (thick, want) in [(true, (400, 400)), (false, (0, 200))] {
        for (name, cfg) in extra_cases(&json!({ "thick_bridges": thick })) {
            let what = format!("{name} thick_bridges {thick}");
            let segs = preview_segments(&run(ledge(), &cfg).1);
            let overhang: Vec<_> = segs
                .iter()
                .filter(|s| s.0 == OVERHANG_WALL && (s.1 - 5.2).abs() < 0.01)
                .collect();
            assert!(
                overhang.len() > 10,
                "{what}: {} overhang wall segments",
                overhang.len()
            );
            for s in &overhang {
                if thick {
                    assert_eq!((s.2, s.3), want, "{what}: overhang wall segment {s:?}");
                } else {
                    assert_eq!(s.3, want.1, "{what}: overhang wall segment {s:?}");
                }
            }
            // No other feature is drawn taller than the layer.
            let tall: Vec<_> = segs
                .iter()
                .filter(|s| ![OVERHANG_WALL, CUSTOM].contains(&s.0) && s.3 > 200)
                .collect();
            assert!(
                tall.is_empty(),
                "{what}: {} taller segments: {:?}",
                tall.len(),
                tall.first()
            );
        }
    }
}
