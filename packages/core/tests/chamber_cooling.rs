// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `chamber_cooling_mode`: a start G-code that reads it slices, with the mode the settings set or the one the
//! plate's filaments call for, the result reports which and why, and every range of layers reads the same mode.

// Configs are built with `json!` at each call, so taking them by value reads best.
#![allow(clippy::needless_pass_by_value)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest, SliceRun};
use sx_core::chamber::ChamberSource;

const START: &str = "{if chamber_cooling_mode==0}\n; chamber: keep warm\n{elsif chamber_cooling_mode==2}\n; chamber: strong cooling\n{else}\n; chamber: weak cooling\n{endif}\n";
const END: &str = "; end chamber {chamber_cooling_mode}\nM104 S0\nM140 S0\n";

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

/// Two filaments on a Klipper printer whose start and end G-code read the chamber mode, the sparse infill on the
/// second filament when `two` is set.
fn config(types: &[&str], two: bool, extra: Value) -> Value {
    let mut c = json!({
        "gcode_flavor": "klipper",
        "machine_start_gcode": START,
        "machine_end_gcode": END,
        "filament_type": types,
        "nozzle_temperature": [220, 225],
        "filament_diameter": [1.75, 1.75],
        "filament_colour": ["#ff0000", "#00ff00"],
    });
    if two {
        c["sparse_infill_filament_id"] = json!(2);
    }
    if let (Some(m), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        m.extend(e.clone());
    }
    c
}

fn slice(config: Value, shards: u32) -> SliceRun {
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    let m = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "a", "name": "cube", "mesh": "c",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 128, 100, 0, 1]}]},
        "config": config,
        "options": {"trustedGcode": true, "shards": shards},
    }))
    .unwrap();
    common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
}

/// The branch the start G-code took and the mode the end G-code printed.
fn rendered(run: &SliceRun) -> (String, String) {
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    let start = g
        .lines()
        .find_map(|l| l.strip_prefix("; chamber: "))
        .unwrap_or_else(|| panic!("no chamber branch in the G-code"))
        .to_owned();
    let end = g
        .lines()
        .find_map(|l| l.strip_prefix("; end chamber "))
        .unwrap_or_else(|| panic!("no end line in the G-code"))
        .to_owned();
    (start, end)
}

fn warnings(run: &SliceRun) -> Vec<String> {
    run.report
        .warnings
        .iter()
        .filter(|w| w.message.contains("chamber airflow"))
        .map(|w| w.message.clone())
        .collect()
}

#[test]
fn all_pla_uses_strong_cooling() {
    let run = slice(config(&["PLA", "PLA"], true, json!({})), 1);
    assert_eq!(rendered(&run), ("strong cooling".to_owned(), "2".to_owned()));
    let c = run.report.chamber_cooling.as_ref().unwrap();
    assert_eq!((c.mode, c.source), (2, ChamberSource::Derived));
    assert_eq!(c.filaments, ["PLA", "PLA"]);
    assert!(warnings(&run).is_empty(), "{:?}", run.report.warnings);
    // The result JSON carries it for clients.
    let v = serde_json::to_value(&run.report).unwrap();
    assert_eq!(v["chamberCooling"]["mode"], 2);
    assert_eq!(v["chamberCooling"]["source"], "derived");
}

#[test]
fn all_abs_keeps_the_chamber_warm() {
    let run = slice(config(&["ABS", "ABS"], true, json!({})), 1);
    assert_eq!(rendered(&run).0, "keep warm");
    assert_eq!(run.report.chamber_cooling.as_ref().unwrap().mode, 0);
}

#[test]
fn petg_with_pla_uses_strong_cooling() {
    let run = slice(config(&["PETG", "PLA"], true, json!({})), 1);
    assert_eq!(rendered(&run).0, "strong cooling");
    assert!(warnings(&run).is_empty(), "{:?}", run.report.warnings);
}

#[test]
fn abs_with_pla_falls_back_to_weak_cooling_with_a_warning() {
    let run = slice(config(&["ABS", "PLA"], true, json!({})), 1);
    assert_eq!(rendered(&run), ("weak cooling".to_owned(), "1".to_owned()));
    assert_eq!(
        warnings(&run),
        ["ABS and PLA need different chamber airflow; using weak cooling"]
    );
}

#[test]
fn an_unknown_type_falls_back_to_weak_cooling_with_a_warning() {
    let run = slice(config(&["FLEX", "FLEX"], false, json!({})), 1);
    assert_eq!(rendered(&run).0, "weak cooling");
    assert_eq!(
        warnings(&run),
        ["The chamber airflow for FLEX is not known; using weak cooling"]
    );
}

#[test]
fn a_filament_loaded_but_not_printed_does_not_count() {
    // ABS sits in slot 2, but nothing prints with it.
    let run = slice(config(&["PLA", "ABS"], false, json!({})), 1);
    assert_eq!(rendered(&run).0, "strong cooling");
    assert_eq!(run.report.chamber_cooling.as_ref().unwrap().filaments, ["PLA"]);
}

#[test]
fn the_settings_value_wins_over_the_filaments() {
    let run = slice(
        config(&["PLA", "PLA"], true, json!({"chamber_cooling_mode": 0})),
        1,
    );
    assert_eq!(rendered(&run), ("keep warm".to_owned(), "0".to_owned()));
    let c = run.report.chamber_cooling.as_ref().unwrap();
    assert_eq!((c.mode, c.source), (0, ChamberSource::Config));
    assert!(c.filaments.is_empty());
}

#[test]
fn every_range_of_layers_reads_the_plates_mode() {
    // Each range reads the mode of the whole plate, so the start and the end agree with a single range.
    let one = slice(config(&["PLA", "ABS"], true, json!({})), 1);
    let three = slice(config(&["PLA", "ABS"], true, json!({})), 3);
    assert_eq!(rendered(&one), rendered(&three));
    assert_eq!(rendered(&three).0, "weak cooling");
    assert_eq!(warnings(&one), warnings(&three));
    assert_eq!(one.report.chamber_cooling, three.report.chamber_cooling);
}

#[test]
fn a_print_whose_gcode_does_not_read_it_reports_nothing() {
    let mut c = config(&["ABS", "PLA"], true, json!({}));
    c["machine_start_gcode"] = json!("; start\n");
    c["machine_end_gcode"] = json!("M104 S0\nM140 S0\n");
    let run = slice(c, 1);
    assert!(run.report.chamber_cooling.is_none());
    assert!(warnings(&run).is_empty(), "{:?}", run.report.warnings);
}
