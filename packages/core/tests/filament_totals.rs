// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The filament totals take in what the start and end G-code push out (purge lines and chute purges), except
//! the lines inside firmware conditionals (`M622` to `M623`, such as a calibration the printer may skip), and
//! each filament's length converts to volume, weight and cost with its own diameter. The configs are built the
//! way the app builds them: the settings schema's defaults, then the printer's shipped process, filament and
//! printer settings, then its start and end G-code.

#![allow(clippy::disallowed_methods)]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// Schema defaults, then the printer's resolved process, filament and printer (when the maker file has it), then
/// its start and end G-code.
fn stock(model: &str, maker: Option<&str>, own: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    if let Some(maker) = maker {
        let m = read(&format!("packages/profiles/resolved/{maker}.json"))["models"][model].clone();
        let base = m["base"].as_str().unwrap().to_owned();
        for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
            for (k, v) in part.as_object().unwrap() {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    for (k, v) in own.as_object().unwrap() {
        out.insert(k.clone(), v.clone());
    }
    let gcode = read("packages/profiles/gcode.json");
    let family = gcode["models"][model].as_str().unwrap().to_owned();
    for (key, part) in [("machine_start_gcode", "start"), ("machine_end_gcode", "end")] {
        out.insert(key.into(), gcode["families"][&family][part].clone());
    }
    out
}

fn cube() -> Arc<Mesh> {
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    Arc::new(Mesh::load(&bytes, "cube.stl").unwrap())
}

fn slice(config: Map<String, Value>, objects: Value) -> api::SliceRun {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let m = cube();
    api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
}

fn one_cube(config: Map<String, Value>) -> api::SliceRun {
    slice(
        config,
        json!([{"id": "a", "mesh": "c", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]}]),
    )
}

/// The numbers of a footer line such as `; filament used [mm] = 1.00, 2.00`.
fn footer(gcode: &[u8], key: &str) -> Vec<f64> {
    String::from_utf8_lossy(gcode)
        .lines()
        .find_map(|l| l.strip_prefix(key).map(str::to_owned))
        .unwrap_or_else(|| panic!("no {key}"))
        .split(',')
        .map(|v| v.trim().parse().unwrap())
        .collect()
}

/// Slices the cube on the stock printer and with its start and end G-code emptied: the difference is what the
/// totals take in from the sequences. The file's footer states the same total as the report.
fn sequence_share(model: &str, maker: Option<&str>, own: &Value) -> f64 {
    let config = stock(model, maker, own);
    let mut bare = config.clone();
    bare.insert("machine_start_gcode".into(), json!(""));
    bare.insert("machine_end_gcode".into(), json!(""));
    let (with, without) = (one_cube(config), one_cube(bare));
    for r in [&with, &without] {
        let stated = footer(&r.gcode, "; filament used [mm] = ");
        let report = &r.report.stats.filament_mm;
        assert_eq!(stated.len(), report.len(), "{model}");
        for (a, b) in stated.iter().zip(report) {
            assert!(
                (a - b).abs() < 0.006,
                "{model}: footer {stated:?} against the report's {report:?}"
            );
        }
        assert!(
            !String::from_utf8_lossy(&r.gcode).contains(";@S"),
            "the marker is gone"
        );
    }
    with.report.stats.filament_mm.iter().sum::<f64>() - without.report.stats.filament_mm.iter().sum::<f64>()
}

/// Each printer's start and end sequence share, mm, against the figure read off its start G-code by hand: every
/// push outside `M622` ... `M623` (a retraction and its prime counted once), nothing inside.
fn check(model: &str, maker: Option<&str>, own: &Value, expect: f64) {
    let got = sequence_share(model, maker, own);
    assert!(
        (got - expect).abs() < 0.05,
        "{model}: {got:.2} mm, expected {expect}"
    );
}

#[test]
fn x1_carbon_counts_its_chute_purges_and_leaves_out_the_conditional_calibration() {
    // 219.5 mm before the first layer, 80.5 of it inside conditionals (the lidar and extrusion calibration lines).
    check("bambu-x1-carbon", Some("bambu-lab"), &json!({}), 139.0);
}

#[test]
fn p1s_counts_its_whole_start() {
    // No conditional extrusion: all 137.6 mm counts.
    check("bambu-p1s", Some("bambu-lab"), &json!({}), 137.6);
}

#[test]
fn a1_leaves_out_its_conditional_flow_calibration() {
    // 144.7 mm before the first layer, 21.9 of it inside conditionals.
    check("bambu-a1", Some("bambu-lab"), &json!({}), 122.87);
}

#[test]
fn mk4_counts_its_purge_line() {
    check("prusa-mk4", Some("prusa"), &json!({}), 19.0);
}

#[test]
fn klipper_macros_push_nothing_the_file_can_see() {
    check("generic-klipper", None, &json!({"gcode_flavor": "klipper"}), 0.0);
}

#[test]
fn each_filament_converts_with_its_own_diameter() {
    let two = |d2: f64| {
        let mut c = stock("generic-klipper", None, &json!({"gcode_flavor": "klipper"}));
        c.insert("filament_diameter".into(), json!([1.75, d2]));
        c.insert("filament_density".into(), json!([1.24, 1.24]));
        c.insert("filament_cost".into(), json!([20, 20]));
        c.insert("nozzle_temperature".into(), json!([210, 210]));
        slice(
            c,
            json!([
                {"id": "a", "mesh": "c", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 60, 100, 0, 1]},
                {"id": "b", "mesh": "c", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 140, 100, 0, 1],
                 "slotOverrides": {"cube.stl": 2}},
            ]),
        )
    };
    let (same, mixed) = (two(1.75), two(2.85));
    let area = |d: f64| std::f64::consts::PI * d * d / 4.0;
    let (s, m) = (&same.report.stats, &mixed.report.stats);
    assert!(
        s.filament_mm[0] > 100.0 && s.filament_mm[1] > 100.0,
        "{:?}",
        s.filament_mm
    );
    // The first filament is untouched; the second pushes the same volume as fewer mm of the thicker filament.
    assert!((m.filament_mm[0] - s.filament_mm[0]).abs() < 1e-6);
    let ratio = m.filament_mm[1] / s.filament_mm[1];
    assert!(
        (ratio - area(1.75) / area(2.85)).abs() < 1e-3,
        "{ratio} against {}",
        area(1.75) / area(2.85)
    );
    // Weight and cost follow the volume, so they come out the same.
    for i in 0..2 {
        assert!(
            (m.filament_g[i] - s.filament_g[i]).abs() < s.filament_g[i] * 1e-3,
            "slot {} weighs {} against {}",
            i + 1,
            m.filament_g[i],
            s.filament_g[i]
        );
        assert!(
            (m.filament_g[i] - m.filament_mm[i] * area(if i == 0 { 1.75 } else { 2.85 }) / 1000.0 * 1.24)
                .abs()
                < 1e-6
        );
    }
    assert!((m.cost - s.cost).abs() < s.cost * 1e-3);
    // The file states the same: its header lists both diameters and its footer the volumes and weights.
    let g = String::from_utf8_lossy(&mixed.gcode);
    assert!(g.contains("; filament_diameter: 1.75,2.85\n"), "header");
    let (mm, cm3, grams) = (
        footer(&mixed.gcode, "; filament used [mm] = "),
        footer(&mixed.gcode, "; filament used [cm3] = "),
        footer(&mixed.gcode, "; filament used [g] = "),
    );
    for i in 0..2 {
        assert!((mm[i] - m.filament_mm[i]).abs() < 0.01);
        assert!((cm3[i] - m.filament_g[i] / 1.24).abs() < 0.01, "{cm3:?}");
        assert!((grams[i] - m.filament_g[i]).abs() < 0.01, "{grams:?}");
    }
}
