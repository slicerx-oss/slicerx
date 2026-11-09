// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The plate type (`curr_bed_type`) picks the bed temperatures: on a stock Bambu Lab A1 with its own start G-code,
//! each plate heats to its own keys on the first layer and the rest, and a plate the filament has no temperature for
//! keeps the printer's and warns. The config is built the way the app builds it: the settings schema's defaults, then
//! the A1's shipped process, filament and printer settings, then its start G-code.

#![allow(clippy::disallowed_methods)]

use serde_json::{Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// Schema defaults, then the A1's resolved process, filament and printer, then its start G-code.
fn stock_a1() -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let model = read("packages/profiles/resolved/bambu-lab.json")["models"]["bambu-a1"].clone();
    let base = model["base"].as_str().unwrap().to_owned();
    for part in [&model["process"][&base], &model["filament"], &model["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    let gcode = read("packages/profiles/gcode.json");
    let family = gcode["models"]["bambu-a1"].as_str().unwrap().to_owned();
    out.insert(
        "machine_start_gcode".into(),
        gcode["families"][&family]["start"].clone(),
    );
    out
}

fn slice(config: serde_json::Map<String, Value>) -> api::SliceRun {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "a", "mesh": "c", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 128, 128, 0, 1]}]},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    let mesh = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
    api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap()
}

/// Every bed temperature the file sets, in order, as (command, degrees).
fn bed_temps(gcode: &[u8]) -> Vec<(String, f64)> {
    String::from_utf8_lossy(gcode)
        .lines()
        .filter_map(|l| {
            let code = l.split(';').next().unwrap_or("").trim();
            let mut words = code.split_whitespace();
            let cmd = words.next()?;
            if cmd != "M140" && cmd != "M190" {
                return None;
            }
            let s = words.find_map(|w| w.strip_prefix('S'))?.parse().ok()?;
            Some((cmd.to_owned(), s))
        })
        .collect()
}

/// Temperatures are whole degrees; this keeps clippy's float rules happy.
fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

fn first(cfg: &serde_json::Map<String, Value>, key: &str) -> f64 {
    cfg[key][0].as_f64().unwrap()
}

#[test]
fn each_plate_type_heats_the_bed_to_its_own_temperatures() {
    let stock = stock_a1();
    for (plate, key) in [
        ("Cool Plate", "cool_plate_temp"),
        ("Textured PEI Plate", "textured_plate_temp"),
        ("High Temp Plate", "hot_plate_temp"),
    ] {
        let mut cfg = stock.clone();
        cfg.insert("curr_bed_type".into(), json!(plate));
        // a different first layer, so the test tells the two keys apart
        cfg.insert(format!("{key}_initial_layer"), json!([first(&stock, key) + 3.0]));
        let want_first = first(&stock, key) + 3.0;
        let want_rest = first(&stock, key);
        let temps = bed_temps(&slice(cfg).gcode);
        let start: Vec<_> = temps.iter().take(2).cloned().collect();
        assert_eq!(
            start,
            vec![("M140".into(), want_first), ("M190".into(), want_first)],
            "{plate}: {temps:?}"
        );
        // after the first layer the bed drops to the plate's other-layer temperature
        assert!(
            temps
                .iter()
                .skip(2)
                .any(|(c, t)| c == "M140" && near(*t, want_rest)),
            "{plate}: {temps:?}"
        );
        assert!(
            temps
                .iter()
                .skip(2)
                .all(|(_, t)| near(*t, want_rest) || near(*t, 0.0)),
            "{plate}: {temps:?}"
        );
    }
}

#[test]
fn a_plate_the_filament_has_no_temperature_for_keeps_the_printers_and_warns() {
    // the A1's stock PLA lists 0 for the engineering plate: Orca's "not supported on this plate"
    let mut cfg = stock_a1();
    assert!(near(first(&cfg, "eng_plate_temp"), 0.0));
    cfg.insert("curr_bed_type".into(), json!("Engineering Plate"));
    let hot = first(&cfg, "hot_plate_temp_initial_layer");
    let run = slice(cfg);
    let temps = bed_temps(&run.gcode);
    assert_eq!(temps.first(), Some(&("M140".into(), hot)), "{temps:?}");
    assert!(
        run.report
            .warnings
            .iter()
            .any(|w| w.message.contains("Engineering Plate")),
        "{:?}",
        run.report.warnings
    );
}

#[test]
fn without_a_plate_type_the_bed_follows_the_high_temp_plate() {
    // what every slice from the app did before the plate type reached the engine
    let cfg = stock_a1();
    assert!(!cfg.contains_key("curr_bed_type"));
    let hot = first(&cfg, "hot_plate_temp_initial_layer");
    assert_eq!(bed_temps(&slice(cfg).gcode).first(), Some(&("M140".into(), hot)));
}

#[test]
fn writes_the_cool_plate_files_for_a_diff_when_asked() {
    // SX_PLATE_GCODE_OUT=<dir> writes the A1 cube's G-code with no plate type (what the app sent before) and with
    // the cool plate, for a before and after diff.
    let Ok(dir) = std::env::var("SX_PLATE_GCODE_OUT") else {
        return;
    };
    let before = stock_a1();
    let mut after = before.clone();
    after.insert("curr_bed_type".into(), json!("Cool Plate"));
    std::fs::write(format!("{dir}/a1-no-plate-type.gcode"), slice(before).gcode).unwrap();
    std::fs::write(format!("{dir}/a1-cool-plate.gcode"), slice(after).gcode).unwrap();
}

/// The settings schema's default for `key` (`packages/settings/defaults.json`), as a number: what the app shows for a
/// key the print's settings leave out.
fn schema_default(key: &str) -> f64 {
    let v = &read("packages/settings/defaults.json")[key][1];
    v.get(0).unwrap_or(v).as_f64().unwrap()
}

/// The A1 as a host that sends only the settings it changed gives it (the MCP server leaves out every value equal to
/// the schema's default): no plate temperatures but the one its PETG sets, the textured plate's 70 C, and no plate
/// type.
fn sparse_a1_petg() -> serde_json::Map<String, Value> {
    let mut cfg = stock_a1();
    cfg.retain(|k, _| !k.contains("plate_temp") && k != "curr_bed_type" && k != "default_bed_type");
    cfg.insert("textured_plate_temp".into(), json!(["70"]));
    cfg
}

/// Bed temperature lines as (command, degrees).
type BedLines = Vec<(String, f64)>;

/// The first two bed lines (the start G-code's M140 and M190), every bed temperature set after them, and the header's
/// `first_layer_bed_temperature`.
fn bed_lines(cfg: serde_json::Map<String, Value>) -> (BedLines, BedLines, f64) {
    let gcode = slice(cfg).gcode;
    let temps = bed_temps(&gcode);
    let header = String::from_utf8_lossy(&gcode)
        .lines()
        .find_map(|l| {
            l.strip_prefix("; first_layer_bed_temperature = ")?
                .trim()
                .parse()
                .ok()
        })
        .unwrap();
    (
        temps.iter().take(2).cloned().collect(),
        temps.iter().skip(2).cloned().collect(),
        header,
    )
}

/// The bed heats to `first_layer` for the first layer (the start G-code's M140 and M190, and the header says the
/// same), then to `other`, and is off only at the end.
fn heats(cfg: serde_json::Map<String, Value>, first_layer: f64, other: f64, what: &str) {
    let (start, rest, header) = bed_lines(cfg);
    assert_eq!(
        start,
        [("M140".to_owned(), first_layer), ("M190".to_owned(), first_layer)],
        "{what}: {start:?} {rest:?}"
    );
    assert!(
        near(header, first_layer),
        "{what}: header {header}, start {start:?}"
    );
    if !near(first_layer, other) {
        assert!(
            rest.iter().any(|(c, t)| c == "M140" && near(*t, other)),
            "{what}: {rest:?}"
        );
    }
    assert!(
        rest.iter().all(|(_, t)| near(*t, other) || near(*t, 0.0)),
        "{what}: {rest:?}"
    );
}

#[test]
fn a_plate_without_its_first_layer_temperature_heats_the_first_layer_like_the_rest() {
    let mut cfg = sparse_a1_petg();
    cfg.insert("curr_bed_type".into(), json!("Textured PEI Plate"));
    heats(cfg.clone(), 70.0, 70.0, "textured PEI, no first layer key");
    // 0 for the first layer means the same
    cfg.insert("textured_plate_temp_initial_layer".into(), json!(["0"]));
    heats(cfg, 70.0, 70.0, "textured PEI, first layer 0");
}

#[test]
fn the_printers_default_plate_type_picks_the_bed_temperatures_when_the_print_names_none() {
    // A PETG cube on an A1 whose printer says Textured PEI Plate and whose settings name no plate type: the bed was
    // set to 0 for the whole print.
    let mut cfg = sparse_a1_petg();
    cfg.insert("default_bed_type".into(), json!("Textured PEI Plate"));
    heats(cfg, 70.0, 70.0, "default_bed_type Textured PEI Plate");
}

#[test]
fn a_plate_with_neither_temperature_heats_to_the_settings_defaults() {
    let mut cfg = sparse_a1_petg();
    cfg.remove("textured_plate_temp");
    cfg.insert("curr_bed_type".into(), json!("Textured PEI Plate"));
    heats(
        cfg,
        schema_default("textured_plate_temp_initial_layer"),
        schema_default("textured_plate_temp"),
        "textured PEI, no keys",
    );
}

#[test]
fn with_no_plate_type_and_no_first_layer_temperature_the_bed_still_heats() {
    let mut cfg = sparse_a1_petg();
    cfg.insert("hot_plate_temp".into(), json!(["60"]));
    heats(cfg, 60.0, 60.0, "no plate type");
}

#[test]
fn every_plate_type_from_the_print_or_the_printer_heats_to_its_own_two_temperatures() {
    let plates = [
        ("Cool Plate", "cool_plate_temp", Some(1)),
        ("Engineering Plate", "eng_plate_temp", Some(2)),
        ("High Temp Plate", "hot_plate_temp", Some(3)),
        ("Textured PEI Plate", "textured_plate_temp", Some(4)),
        ("Supertack Plate", "supertack_plate_temp", None),
        ("Textured Cool Plate", "textured_cool_plate_temp", None),
    ];
    let mut base = stock_a1();
    base.remove("default_bed_type");
    // every plate its own pair, the first layer one degree over the rest, so a wrong key shows
    let pairs: Vec<f64> = (0..plates.len())
        .map(|i| 50.0 + 2.0 * f64::from(u8::try_from(i).unwrap()))
        .collect();
    for ((_, key, _), other) in plates.iter().zip(&pairs) {
        base.insert((*key).into(), json!([other.to_string()]));
        base.insert(format!("{key}_initial_layer"), json!([(other + 1.0).to_string()]));
    }
    for ((plate, _, number), &other) in plates.iter().zip(&pairs) {
        let mut sources = vec![
            ("curr_bed_type", json!(plate)),
            ("curr_bed_type", json!(plate.to_lowercase())),
            ("default_bed_type", json!(plate)),
        ];
        if let Some(n) = number {
            sources.push(("default_bed_type", json!(n.to_string())));
        }
        for (key, value) in sources {
            let mut cfg = base.clone();
            cfg.insert(key.into(), value.clone());
            heats(cfg, other + 1.0, other, &format!("{key} {value}"));
        }
    }
}
