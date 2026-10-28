// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `ensure_vertical_shell_thickness` `partial` and `disabled` on the ring a 30 mm box leaves around a smaller box on
//! top of it (fixtures/vertical-shell-partial: the stock P1S request, 0.20 mm layers, 5 top layers, and the step
//! meshes with rings 4.0 to 6.0 mm wide). The ring's internal bridge prints at z 1.2, its solid at z 1.4 to 1.8 and
//! its top at z 2.0; the loop under the bridge floats at z 1.0 in every mode.
//!
//! - `partial`: the first solid layer over the bridge is internal solid infill and the two above it float, as with
//!   the full rule, up to a 5.5 mm ring with classic and aegis walls alike. From 6.0 mm the ring stays internal solid
//!   infill. No floating band above the top.
//! - `disabled`: the ring stays internal solid infill.

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/vertical-shell-partial"
);

/// The ring's labels, short as in the measurements: bridge, internal solid infill, floating vertical shell, top.
const LABELS: [(&str, &str); 4] = [
    ("Bridge", "BR"),
    ("Internal solid infill", "IS"),
    ("Floating vertical shell", "FV"),
    ("Top surface", "TOP"),
];

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURES}/{name}")).unwrap()
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

/// A height in thousandths of a millimeter.
#[allow(
    clippy::cast_possible_truncation,
    reason = "layer heights in thousandths of a millimeter"
)]
fn milli(v: f64) -> i64 {
    (v * 1000.0).round() as i64
}

/// Filament (mm, relative extrusion) per layer z (thousandths of a millimeter) and feature, of the stock P1S step
/// request with the ring `ring` mm wide, `walls` and `mode` for `ensure_vertical_shell_thickness`.
fn slice(ring: &str, walls: &str, mode: &str) -> BTreeMap<i64, BTreeMap<String, f64>> {
    let mut req: Value = serde_json::from_slice(&fixture("p1s-step.json")).unwrap();
    req["config"]["wall_generator"] = json!(walls);
    req["config"]["ensure_vertical_shell_thickness"] = json!(mode);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let mesh = Arc::new(Mesh::load(&fixture(&format!("step{ring}.stl")), "m.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    let g = String::from_utf8(run.gcode).unwrap();
    let mut out: BTreeMap<i64, BTreeMap<String, f64>> = BTreeMap::new();
    let (mut z, mut feature) = (0, String::new());
    for line in g.lines() {
        let s = line.trim();
        if let Some(f) = comment(s, &["TYPE", "FEATURE"]) {
            f.clone_into(&mut feature);
            continue;
        }
        if let Some(h) = comment(s, &["Z_HEIGHT", "Z"]).and_then(|v| v.parse::<f64>().ok()) {
            z = milli(h);
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !(code.starts_with("G1 ") || code.starts_with("G2 ") || code.starts_with("G3 ")) {
            continue;
        }
        if let Some(e) = word(code, 'E').filter(|e| *e > 0.0)
            && (word(code, 'X').is_some() || word(code, 'Y').is_some())
        {
            *out.entry(z).or_default().entry(feature.clone()).or_default() += e;
        }
    }
    out
}

/// The ring's label on layer `z` (mm): the one of [`LABELS`] that prints the most filament there, from 0.05 mm, or
/// "-".
fn label(layers: &BTreeMap<i64, BTreeMap<String, f64>>, z: f64) -> &'static str {
    let at = layers.get(&milli(z));
    let e = |f: &str| at.and_then(|l| l.get(f)).copied().unwrap_or(0.0);
    LABELS
        .iter()
        .filter(|(f, _)| e(f) >= 0.05)
        .max_by(|a, b| e(a.0).total_cmp(&e(b.0)))
        .map_or("-", |(_, short)| *short)
}

/// Filament (mm) of `feature` on layer `z` (mm).
fn at(layers: &BTreeMap<i64, BTreeMap<String, f64>>, z: f64, feature: &str) -> f64 {
    layers
        .get(&milli(z))
        .and_then(|l| l.get(feature))
        .copied()
        .unwrap_or(0.0)
}

const ZS: [f64; 6] = [1.4, 1.6, 1.8, 2.0, 2.2, 2.4];

/// The labels of z 1.4 to 2.4 for the case, after checking the loop under the bridge floats at z 1.0.
fn ring(ring: &str, walls: &str, mode: &str) -> [&'static str; 6] {
    let layers = slice(ring, walls, mode);
    let case = format!("{ring} mm ring, {walls} walls, {mode}");
    let lb = at(&layers, 1.0, "Floating vertical shell");
    assert!(
        lb > 1.0,
        "{case}: the loop under the bridge floats at z 1.0 ({lb:.2})"
    );
    ZS.map(|z| label(&layers, z))
}

#[test]
fn partial_floats_the_narrow_ring_on_the_layers_above_the_first_over_its_bridge() {
    let mut wrong = Vec::new();
    for walls in ["classic", "aegis"] {
        for w in ["4.0", "4.5", "4.75", "5.0", "5.5"] {
            let labels = ring(w, walls, "partial");
            if labels != ["IS", "FV", "FV", "TOP", "-", "-"] {
                wrong.push(format!("{w} mm ring, {walls} walls: {labels:?}"));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "z 1.4 to 2.4 not IS FV FV TOP - -:\n{}",
        wrong.join("\n")
    );
}

#[test]
fn partial_keeps_a_6_mm_ring_internal_solid_infill() {
    for walls in ["classic", "aegis"] {
        assert_eq!(
            ring("6.0", walls, "partial"),
            ["IS", "IS", "IS", "TOP", "-", "-"],
            "{walls} walls"
        );
    }
}

#[test]
fn disabled_keeps_the_ring_internal_solid_infill() {
    for walls in ["classic", "aegis"] {
        assert_eq!(
            ring("4.0", walls, "disabled"),
            ["IS", "IS", "IS", "TOP", "-", "-"],
            "{walls} walls"
        );
    }
}
