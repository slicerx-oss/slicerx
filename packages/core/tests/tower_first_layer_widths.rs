// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Two line widths of the stock H3C presets: `prime_tower_line_width`, the width of a Bambu Lab prime tower's purge
//! rows (which `prime_tower_infill_gap` spaces), and `initial_layer_infill_line_width`, the width of the first
//! layer's infill. Left out, the rows keep the wall's bead (1.25 times the nozzle) and the first layer's infill
//! keeps `initial_layer_line_width`.
//!
//! The printer is the stock H3C from resolved/bambu-lab.json with a start and change G-code of one comment line, and
//! each test sets or removes the key it reads, so the stock values do not decide it.

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::disallowed_methods,
    reason = "a few cubes on a plate, and G-code numbers read back, not engine output"
)]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// The app's config for the stock H3C with `filaments` PLA filaments: schema defaults, the resolved process, filament
/// and printer, the prime tower on, and a one-line start and change G-code.
fn h3c(filaments: usize) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let m = read("packages/profiles/resolved/bambu-lab.json")["models"]["bambu-h3c"].clone();
    let base = m["base"].as_str().unwrap().to_owned();
    for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    let colors = ["#FF0000", "#00FF00", "#0000FF"];
    for (k, v) in [
        ("machine_start_gcode", json!("; start\n")),
        ("machine_end_gcode", json!("")),
        ("change_filament_gcode", json!("; change\n")),
        ("enable_prime_tower", json!(true)),
        ("nozzle_temperature", json!(vec![220; filaments])),
        ("nozzle_temperature_initial_layer", json!(vec![220; filaments])),
        ("filament_type", json!(vec!["PLA"; filaments])),
        ("filament_diameter", json!(vec![1.75; filaments])),
        ("filament_max_volumetric_speed", json!(vec![40; filaments])),
        ("filament_prime_volume", json!(vec![30; filaments])),
        ("filament_colour", json!(colors[..filaments].to_vec())),
    ] {
        out.insert(k.into(), v);
    }
    out
}

/// The 20 mm cube, one object per filament slot given, 50 mm apart about the bed's middle.
fn gcode(config: Map<String, Value>, slots: &[u8]) -> String {
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    let m = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
    let (lo, hi) = m.bounds().unwrap();
    let step = 50.0;
    let first = -step * (slots.len() as f64 - 1.0) / 2.0;
    let objects: Vec<Value> = slots
        .iter()
        .enumerate()
        .map(|(i, slot)| {
            let x = 165.0 + first + step * i as f64 - f64::from(lo[0] + hi[0]) / 2.0;
            let y = 160.0 - f64::from(lo[1] + hi[1]) / 2.0;
            json!({
                "id": format!("o{i}"),
                "name": format!("cube{i}"),
                "mesh": "c",
                "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, -f64::from(lo[2]), 1],
                "slotOverrides": {"cube.stl": slot},
            })
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// One straight extrusion: the layer (1-based), the feature, whether it is part of a tool change's wipe on the tower,
/// its start and end, and its bead width as its E gives it at the layer's height on 1.75 mm filament.
#[derive(Debug, Clone)]
struct Line {
    layer: usize,
    feature: String,
    wipe: bool,
    from: (f64, f64),
    to: (f64, f64),
    width: f64,
}

fn lines(g: &str) -> Vec<Line> {
    let area = std::f64::consts::PI * 0.875 * 0.875;
    let (mut layer, mut h, mut feature, mut wipe) = (0usize, 0.2, String::new(), false);
    let (mut x, mut y) = (0.0, 0.0);
    let mut out = Vec::new();
    for l in g.lines() {
        if l.starts_with("; CHANGE_LAYER") {
            layer += 1;
        } else if let Some(v) = l.strip_prefix("; LAYER_HEIGHT: ") {
            h = v.trim().parse().unwrap();
        } else if let Some(f) = l.strip_prefix("; FEATURE: ") {
            f.trim().clone_into(&mut feature);
        } else if l.starts_with("; CP TOOLCHANGE WIPE") {
            wipe = true;
        } else if l.starts_with("; WIPE_TOWER_END") {
            wipe = false;
        } else if l.starts_with("G1 ") || l.starts_with("G0 ") {
            let word = |c: char| {
                l.split(';')
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
            };
            let (nx, ny) = (word('X').unwrap_or(x), word('Y').unwrap_or(y));
            let len = (nx - x).hypot(ny - y);
            if let Some(e) = word('E').filter(|e| *e > 0.0 && len > 0.5) {
                let bead = e * area / len;
                out.push(Line {
                    layer,
                    feature: feature.clone(),
                    wipe,
                    from: (x, y),
                    to: (nx, ny),
                    width: bead / h + h * (1.0 - std::f64::consts::FRAC_PI_4),
                });
            }
            (x, y) = (nx, ny);
        }
    }
    out
}

/// The tower's purge rows above the first layer: the straight runs across the tower in each change's wipe, their
/// median bead width and the most common step between neighboring rows of one wipe, mm.
fn tower_rows(g: &str) -> (f64, f64, usize) {
    let all = lines(g);
    let rows: Vec<&Line> = all
        .iter()
        .filter(|l| l.layer > 1 && l.wipe && l.feature == "Prime tower")
        .filter(|l| (l.to.1 - l.from.1).abs() < 1e-6 && (l.to.0 - l.from.0).abs() > 10.0)
        .collect();
    let mut widths: Vec<f64> = rows.iter().map(|l| l.width).collect();
    widths.sort_by(f64::total_cmp);
    let median = widths[widths.len() / 2];
    let mut steps: Vec<i64> = rows
        .windows(2)
        .filter(|w| w[0].layer == w[1].layer)
        .map(|w| ((w[1].from.1 - w[0].from.1).abs() * 1000.0).round() as i64)
        .filter(|s| *s > 0)
        .collect();
    steps.sort_unstable();
    let mut best = (0i64, 0usize);
    for s in &steps {
        let n = steps.iter().filter(|t| *t == s).count();
        if n > best.1 {
            best = (*s, n);
        }
    }
    (median, best.0 as f64 / 1000.0, rows.len())
}

#[test]
fn a_bambu_tower_lays_its_purge_rows_at_the_prime_tower_line_width() {
    let mut c = h3c(2);
    c.insert("prime_tower_line_width".into(), json!(0.8));
    c.insert("prime_tower_infill_gap".into(), json!("150%"));
    let (width, pitch, rows) = tower_rows(&gcode(c, &[1, 2]));
    assert!(rows >= 20, "{rows} rows");
    // 0.8 mm beads, 150% of the width apart.
    assert!((width - 0.8).abs() < 0.02, "row width {width:.3}");
    assert!((pitch - 1.2).abs() < 1e-3, "row pitch {pitch:.3}");
}

#[test]
fn a_tower_without_a_line_width_keeps_the_wall_bead() {
    // Left out, or 0: the rows are the wall's bead, 1.25 times the 0.4 mm nozzle, 150% of it apart.
    for set in [None, Some(json!(0)), Some(json!("0"))] {
        let mut c = h3c(2);
        c.remove("prime_tower_line_width");
        if let Some(v) = set.clone() {
            c.insert("prime_tower_line_width".into(), v);
        }
        c.insert("prime_tower_infill_gap".into(), json!("150%"));
        let (width, pitch, _) = tower_rows(&gcode(c, &[1, 2]));
        assert!((width - 0.5).abs() < 0.02, "{set:?}: row width {width:.3}");
        assert!((pitch - 0.75).abs() < 1e-3, "{set:?}: row pitch {pitch:.3}");
    }
}

/// The median bead width of the first layer's lines of `feature`, mm.
fn first_layer_width(g: &str, feature: &str) -> f64 {
    let mut w: Vec<f64> = lines(g)
        .iter()
        .filter(|l| l.layer == 1 && l.feature == feature && !l.wipe)
        .map(|l| l.width)
        .collect();
    assert!(!w.is_empty(), "no {feature} on the first layer");
    w.sort_by(f64::total_cmp);
    w[w.len() / 2]
}

#[test]
fn the_first_layer_infill_prints_at_initial_layer_infill_line_width() {
    let mut c = h3c(1);
    c.insert("initial_layer_line_width".into(), json!(0.5));
    c.insert("initial_layer_infill_line_width".into(), json!(0.6));
    let g = gcode(c, &[1]);
    let bottom = first_layer_width(&g, "Bottom surface");
    assert!((bottom - 0.6).abs() < 0.02, "bottom surface {bottom:.3}");
    // The walls keep the first layer's line width.
    let wall = first_layer_width(&g, "Outer wall");
    assert!((wall - 0.5).abs() < 0.02, "outer wall {wall:.3}");
    // The infill above the first layer keeps its own width.
    let mut c = h3c(1);
    c.insert("initial_layer_infill_line_width".into(), json!(0.6));
    let above: Vec<f64> = lines(&gcode(c, &[1]))
        .iter()
        .filter(|l| l.layer == 2 && l.feature == "Internal solid infill")
        .map(|l| l.width)
        .collect();
    assert!(!above.is_empty());
    assert!(above.iter().all(|w| (w - 0.42).abs() < 0.03), "{above:?}");
}

#[test]
fn without_initial_layer_infill_line_width_the_first_layer_infill_keeps_its_width() {
    for set in [None, Some(json!(0))] {
        let mut c = h3c(1);
        c.insert("initial_layer_line_width".into(), json!(0.5));
        c.remove("initial_layer_infill_line_width");
        if let Some(v) = set.clone() {
            c.insert("initial_layer_infill_line_width".into(), v);
        }
        let bottom = first_layer_width(&gcode(c, &[1]), "Bottom surface");
        assert!((bottom - 0.5).abs() < 0.02, "{set:?}: bottom surface {bottom:.3}");
    }
}
