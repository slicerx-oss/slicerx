// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Gap fill of monotonic line surfaces on Bambu Lab printers. A top, bottom or internal solid surface filled with
//! monotonic line gets thin gap fill beads in the slivers its own lines leave, whatever `gap_fill_target` says and
//! with `filter_out_gap_fill` ignored. No other pattern gets them, and the first printed layer never does. A corner
//! the lines cut off, too short for a line down its middle, gets none. Other printers leave surface gap fill to
//! `gap_fill_target`, whatever the pattern.
//!
//! Each case is a stock printer as the app sets it up with one setting changed; the Bambu Lab ones have aegis walls,
//! which print no wall gap fill. The amounts are the measured targets on the layers where our surfaces match the
//! measured ones (the other layers are left out): the layers with gap fill must be the target's, and the amount on
//! them within 25 percent of the target or 0.3 mm.

#![allow(
    clippy::disallowed_methods,
    clippy::float_cmp,
    clippy::many_single_char_names,
    clippy::cast_precision_loss,
    reason = "a G-code reader for the test: plate coordinates and layer heights in mm"
)]

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// A shipped printer (`vendor` names the resolved profile file) as the app sets it up, with uniform layers, then
/// `edits`.
fn stock(vendor: &str, model: &str, edits: &[(&str, Value)]) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let m = read(&format!("packages/profiles/resolved/{vendor}.json"))["models"][model].clone();
    let base = m["base"].as_str().unwrap().to_owned();
    for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    out.insert("smart_layer".into(), json!("off"));
    for (k, v) in edits {
        out.insert((*k).to_owned(), v.clone());
    }
    out
}

/// A shipped Bambu Lab printer with aegis walls, then `edits`.
fn printer(model: &str, edits: &[(&str, Value)]) -> Map<String, Value> {
    let mut out = stock("bambu-lab", model, &[("wall_generator", json!("aegis"))]);
    for (k, v) in edits {
        out.insert((*k).to_owned(), v.clone());
    }
    out
}

/// A binary STL of the closed solid between a bottom and a top polygon (counterclockwise, same vertex count).
fn loft(tris: &mut Vec<[[f32; 3]; 3]>, poly: &[[f32; 2]], z0: f32, z1: f32) {
    let n = poly.len();
    let b = |i: usize| [poly[i][0], poly[i][1], z0];
    let t = |i: usize| [poly[i][0], poly[i][1], z1];
    for i in 1..n - 1 {
        tris.push([b(0), b(i + 1), b(i)]);
        tris.push([t(0), t(i), t(i + 1)]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        tris.push([b(i), b(j), t(j)]);
        tris.push([b(i), t(j), t(i)]);
    }
}

fn stl(tris: &[[[f32; 3]; 3]]) -> Vec<u8> {
    let mut b = vec![0u8; 80];
    b.extend_from_slice(&u32::try_from(tris.len()).unwrap().to_le_bytes());
    for t in tris {
        b.extend_from_slice(&[0u8; 12]);
        for v in t {
            for c in v {
                b.extend_from_slice(&c.to_le_bytes());
            }
        }
        b.extend_from_slice(&[0u8; 2]);
    }
    b
}

/// An acute right triangle 40 by 12 mm.
const TRIANGLE: [[f32; 2]; 3] = [[0.0, 0.0], [40.0, 0.0], [0.0, 12.0]];

/// The triangle as a plate 3 mm thick.
fn plate() -> Vec<u8> {
    let mut tris = Vec::new();
    loft(&mut tris, &TRIANGLE, 0.0, 3.0);
    stl(&tris)
}

/// The triangle as a shelf from z 6 to 8 on a column 6 by 4 mm.
fn shelf() -> Vec<u8> {
    let mut tris = Vec::new();
    loft(
        &mut tris,
        &[[2.0, 2.0], [8.0, 2.0], [8.0, 6.0], [2.0, 6.0]],
        0.0,
        6.0,
    );
    loft(&mut tris, &TRIANGLE, 6.0, 8.0);
    stl(&tris)
}

fn xmark() -> Vec<u8> {
    std::fs::read(format!("{}/packages/core/bench/models/x-mark.stl", root())).unwrap()
}

/// The G-code of one part on the plate where the app puts it.
fn slice(model: &[u8], config: Map<String, Value>) -> String {
    let mesh = Arc::new(Mesh::load(model, "m.stl").unwrap());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "o1", "name": "part", "mesh": "m"}]},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

/// The gap fill printed right after a surface: mm of path per layer z (in hundredths), and every stated width.
struct Gaps {
    by_z: BTreeMap<i64, f64>,
    widths: Vec<f64>,
}

impl Gaps {
    fn total(&self) -> f64 {
        self.by_z.values().sum()
    }
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

fn hundredths(z: f64) -> i64 {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a layer height in hundredths of a mm"
    )]
    {
        (z * 100.0).round() as i64
    }
}

fn gaps(g: &str) -> Gaps {
    let (mut x, mut y, mut z, mut w) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
    let (mut feature, mut before) = (String::new(), String::new());
    let mut out = Gaps {
        by_z: BTreeMap::new(),
        widths: Vec::new(),
    };
    for line in g.lines() {
        let s = line.trim();
        if let Some(f) = s.strip_prefix("; FEATURE:").or_else(|| s.strip_prefix(";TYPE:")) {
            let f = f.trim().to_owned();
            if f != feature {
                before = std::mem::replace(&mut feature, f);
            }
            continue;
        }
        if let Some(v) = s.strip_prefix("; Z_HEIGHT:").or_else(|| s.strip_prefix(";Z:")) {
            z = v.trim().parse().unwrap();
            continue;
        }
        if let Some(v) = s
            .strip_prefix("; LINE_WIDTH:")
            .or_else(|| s.strip_prefix(";WIDTH:"))
        {
            w = v.trim().parse().unwrap();
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|p| code.starts_with(p)) {
            continue;
        }
        let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
        let d = (nx - x).hypot(ny - y);
        let surface = ["Top surface", "Internal solid infill", "Bottom surface"].contains(&before.as_str());
        if feature == "Gap infill" && surface && word(code, 'E').is_some_and(|e| e > 0.0) && d > 0.0 {
            *out.by_z.entry(hundredths(z)).or_default() += d;
            out.widths.push(w);
        }
        (x, y) = (nx, ny);
    }
    out
}

/// Checks a case against its targets (layer z, mm). Layers in `skipped` (where our surface differs from the
/// measured one) are left out; on the rest, gap fill goes on exactly the target's layers, and the amount comes
/// within 25 percent of the target or 0.3 mm.
fn check(name: &str, g: &Gaps, targets: &[(f64, f64)], skipped: &[f64]) {
    let skip: Vec<i64> = skipped.iter().map(|z| hundredths(*z)).collect();
    let want: BTreeMap<i64, f64> = targets
        .iter()
        .map(|(z, mm)| (hundredths(*z), *mm))
        .filter(|(z, _)| !skip.contains(z))
        .collect();
    let ours: Vec<i64> = g.by_z.keys().copied().filter(|z| !skip.contains(z)).collect();
    assert_eq!(
        ours,
        want.keys().copied().collect::<Vec<_>>(),
        "{name}: gap fill on the wrong layers ({:?})",
        g.by_z
    );
    let target: f64 = want.values().sum();
    let amount: f64 = ours.iter().filter_map(|z| g.by_z.get(z)).sum();
    assert!(
        (amount - target).abs() <= (0.25 * target).max(0.3),
        "{name}: {amount:.2} mm of gap fill, target {target:.2}"
    );
}

/// The stock x-mark's targets, and the layers where our top surface differs from the measured one.
const XMARK: [(f64, f64); 6] = [
    (5.8, 1.77),
    (6.0, 1.96),
    (6.2, 11.12),
    (59.0, 3.71),
    (59.2, 2.05),
    (85.4, 0.2),
];
const XMARK_SKIPPED: [f64; 3] = [5.8, 6.2, 59.2];

fn a1(edits: &[(&str, Value)]) -> Map<String, Value> {
    printer("bambu-a1", edits)
}

#[test]
fn monotonic_line_top_surfaces_get_gap_fill() {
    for model in ["bambu-a1", "bambu-p1s"] {
        let g = gaps(&slice(&xmark(), printer(model, &[])));
        check(model, &g, &XMARK, &XMARK_SKIPPED);
        // Every stated width between 0.06 and 0.43 mm.
        for w in &g.widths {
            assert!((0.06..=0.43).contains(w), "{model}: a bead {w} mm wide");
        }
    }
}

#[test]
fn other_top_patterns_get_none() {
    for pattern in ["monotonic", "rectilinear", "alignedrectilinear", "concentric"] {
        let g = gaps(&slice(&xmark(), a1(&[("top_surface_pattern", json!(pattern))])));
        assert_eq!(g.total(), 0.0, "{pattern}: {:?}", g.by_z);
    }
    let g = gaps(&slice(
        &plate(),
        a1(&[("top_surface_pattern", json!("monotonic"))]),
    ));
    assert_eq!(g.total(), 0.0, "triangle: {:?}", g.by_z);
}

#[test]
fn a_corner_the_lines_cut_off_gets_none() {
    // The shelf's top lines cut off its corners and leave no strip long enough for a line down its middle.
    let g = gaps(&slice(&shelf(), a1(&[])));
    assert_eq!(g.total(), 0.0, "shelf: {:?}", g.by_z);
}

#[test]
fn the_first_layer_gets_none() {
    let bottom = [("bottom_surface_pattern", json!("monotonicline"))];
    let g = gaps(&slice(&xmark(), a1(&bottom)));
    check("x-mark", &g, &XMARK, &XMARK_SKIPPED);
    assert!(!g.by_z.contains_key(&20), "{:?}", g.by_z);
}

#[test]
fn monotonic_line_internal_solid_gets_it_from_the_second_layer() {
    let g = gaps(&slice(
        &xmark(),
        a1(&[("internal_solid_infill_pattern", json!("monotonicline"))]),
    ));
    let targets = [
        (0.4, 3.2),
        (0.6, 1.65),
        (5.4, 3.67),
        (5.6, 1.77),
        (5.8, 2.52),
        (6.0, 1.96),
        (6.2, 11.12),
        (59.0, 3.71),
        (59.2, 2.05),
        (84.8, 0.53),
        (85.0, 2.72),
        (85.2, 1.1),
        (85.4, 0.2),
    ];
    check("x-mark", &g, &targets, &[6.2, 59.2]);
}

#[test]
fn filter_out_gap_fill_does_not_apply() {
    let g = gaps(&slice(&xmark(), a1(&[("filter_out_gap_fill", json!(3))])));
    check("x-mark", &g, &XMARK, &XMARK_SKIPPED);
}

#[test]
fn ironing_and_top_shell_count_change_nothing() {
    for edits in [
        ("ironing_type", json!("top")),
        ("top_shell_layers", json!(1)),
        ("top_shell_layers", json!(3)),
    ] {
        let g = gaps(&slice(&xmark(), a1(std::slice::from_ref(&edits))));
        check(&format!("{edits:?}"), &g, &XMARK, &XMARK_SKIPPED);
    }
}

#[test]
fn the_amount_follows_the_layer_height() {
    let g = gaps(&slice(&xmark(), a1(&[("layer_height", json!(0.12))])));
    let targets = [
        (5.96, 3.07),
        (6.08, 12.91),
        (59.12, 1.73),
        (85.4, 1.7),
        (85.52, 1.68),
    ];
    check("0.12 mm layers", &g, &targets, &[6.08, 85.4]);
}

#[test]
fn other_printers_leave_it_to_gap_fill_target() {
    // Their stock presets have monotonic line top surfaces and `gap_fill_target` nowhere: no surface gap fill, with
    // internal solid at monotonic line too.
    for (vendor, model) in [
        ("creality", "creality-ender-3-v3-se"),
        ("prusa", "prusa-mk4"),
        ("voron", "voron-2.4-300"),
    ] {
        for edits in [
            vec![],
            vec![("internal_solid_infill_pattern", json!("monotonicline"))],
        ] {
            let g = gaps(&slice(&xmark(), stock(vendor, model, &edits)));
            assert_eq!(g.total(), 0.0, "{model} {edits:?}: {:?}", g.by_z);
        }
    }
}
