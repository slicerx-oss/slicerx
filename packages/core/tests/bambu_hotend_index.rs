// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The hotend id in the AMS commands of the Bambu Lab H2D and X2D: `B` of `M620.11`, `H` of `M620 S..A`,
//! `T..` and `M620.6`, and `M620 D`. Bambu Studio 2.8 writes -1 in every one of them on both printers, in
//! the start and in every filament change, with one filament, with two, and when the first filament is
//! not the first slot. The expected lines are Bambu Studio's, read from its G-code for the same cases
//! (a 20 mm cube; two cubes on two filaments; one cube on filament 2), reduced to the command, the
//! filament it names and the hotend id, since the other parameters follow settings these tests do not
//! pin. Other printers keep the id they had.

#![allow(clippy::cast_precision_loss, reason = "a few cubes on a plate")]

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

/// The app's config for a stock Bambu Lab printer: schema defaults, the resolved process, filament and printer,
/// then the printer family's start, end and filament change G-code.
fn stock(model: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let m = read("packages/profiles/resolved/bambu-lab.json")["models"][model].clone();
    let base = m["base"].as_str().unwrap().to_owned();
    for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    let gcode = read("packages/profiles/gcode.json");
    let family = gcode["models"][model].as_str().unwrap().to_owned();
    for (key, part) in [
        ("machine_start_gcode", "start"),
        ("machine_end_gcode", "end"),
        ("change_filament_gcode", "changeFilament"),
    ] {
        out.insert(key.into(), gcode["families"][&family][part].clone());
    }
    out
}

/// Two filaments loaded, both PLA.
fn two_filaments(c: &mut Map<String, Value>) {
    for (k, v) in [
        ("nozzle_temperature", json!([220, 225])),
        ("nozzle_temperature_initial_layer", json!([220, 225])),
        ("filament_type", json!(["PLA", "PLA"])),
        ("filament_diameter", json!([1.75, 1.75])),
        ("filament_colour", json!(["#FF0000", "#00FF00"])),
    ] {
        c.insert(k.into(), v);
    }
}

/// The 20 mm cube, one object per filament slot given, 60 mm apart about `center`.
fn slice(config: Map<String, Value>, center: [f64; 2], slots: &[u8]) -> String {
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    let m = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
    let (lo, hi) = m.bounds().unwrap();
    let step = 60.0;
    let first = -step * (slots.len() as f64 - 1.0) / 2.0;
    let objects: Vec<Value> = slots
        .iter()
        .enumerate()
        .map(|(i, slot)| {
            let x = center[0] + first + step * i as f64 - f64::from(lo[0] + hi[0]) / 2.0;
            let y = center[1] - f64::from(lo[1] + hi[1]) / 2.0;
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
    let r = api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

/// Every line that carries a hotend id, as `<command> <filament> <hotend>` (`-` where the command names no
/// filament), with how often it appears.
fn hotend_lines(g: &str) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for l in g.lines() {
        let l = l.split(';').next().unwrap_or("").trim();
        let words: Vec<&str> = l.split_whitespace().collect();
        let Some(&cmd) = words.first() else { continue };
        let param = |p: char| words.iter().skip(1).find_map(|w| w.strip_prefix(p));
        let key = match cmd {
            "M620.11" => param('B').map(|b| format!("M620.11 I{} B{b}", param('I').unwrap_or("-"))),
            "M620.6" => param('H').map(|h| format!("M620.6 I{} H{h}", param('I').unwrap_or("-"))),
            "M620" if param('D').is_some() => param('D').map(|d| format!("M620 D{d}")),
            "M620" => words
                .get(1)
                .and_then(|w| w.strip_prefix('S'))
                .and_then(|s| s.strip_suffix('A'))
                .and_then(|s| param('H').map(|h| format!("M620 S{s}A H{h}"))),
            t if t.starts_with('T') => param('H').map(|h| format!("{t} H{h}")),
            _ => None,
        };
        if let Some(k) = key {
            *out.entry(k).or_default() += 1;
        }
    }
    out
}

fn expect(lines: &[(&str, usize)]) -> BTreeMap<String, usize> {
    lines.iter().map(|(k, n)| ((*k).to_owned(), *n)).collect()
}

/// The commands with a hotend id, as the H2D's start and filament change send them in Bambu Studio 2.8. The
/// shipped H2D text predates them, so these tests give the printer just these lines.
const H2D_START: &str = "M620.11 P0 I[initial_no_support_filament_id] B[initial_no_support_hotend] E0
M620 S[initial_no_support_filament_id]A H[initial_no_support_hotend]
T[initial_no_support_filament_id] H[initial_no_support_hotend]
M620 D[initial_no_support_hotend]
M620.6 I[initial_no_support_filament_id] H[initial_no_support_hotend] W1
";
const H2D_CHANGE: &str = "M620 S[next_filament_id]A H[next_hotend]
M620.11 P0 I[current_filament_id] B[current_hotend] E0
T[next_filament_id] H[next_hotend]
M620.6 I[next_filament_id] H[next_hotend] W1
M621 S[next_filament_id]A
";

fn h2d() -> Map<String, Value> {
    let mut c = stock("bambu-h2d");
    c.insert("machine_start_gcode".into(), json!(H2D_START));
    c.insert("change_filament_gcode".into(), json!(H2D_CHANGE));
    c
}

#[test]
fn the_x2d_writes_no_hotend_with_one_filament() {
    // Bambu Studio, x2d one: M620.11 B-1 twice, M620 S0A H-1 B and T0 H-1 twice each, M620 D-1 twice, M620.6 H-1.
    let g = slice(stock("bambu-x2d"), [128.0, 128.0], &[1]);
    assert_eq!(
        hotend_lines(&g),
        expect(&[
            ("M620 D-1", 2),
            ("M620 S0A H-1", 2),
            ("M620.11 I0 B-1", 2),
            ("M620.6 I0 H-1", 1),
            ("T0 H-1", 2),
        ])
    );
}

#[test]
fn the_x2d_writes_no_hotend_when_the_first_filament_is_the_second() {
    // Bambu Studio, x2d first2: the same lines on filament 1 (0-based).
    let mut c = stock("bambu-x2d");
    two_filaments(&mut c);
    let g = slice(c, [128.0, 128.0], &[2]);
    assert_eq!(
        hotend_lines(&g),
        expect(&[
            ("M620 D-1", 2),
            ("M620 S1A H-1", 2),
            ("M620.11 I1 B-1", 2),
            ("M620.6 I1 H-1", 1),
            ("T1 H-1", 2),
        ])
    );
}

#[test]
fn the_x2d_writes_no_hotend_in_any_filament_change() {
    // Bambu Studio, x2d two (two cubes, a change each way on every layer): every change has M620 S..A B H-1,
    // two M620.11 .. B-1, T.. H-1 and M620.6 .. H-1. No line keeps a hotend 0.
    let mut c = stock("bambu-x2d");
    two_filaments(&mut c);
    let lines = hotend_lines(&slice(c, [128.0, 128.0], &[1, 2]));
    assert!(lines.keys().all(|k| k.ends_with("-1")), "{lines:?}");
    let changes = lines.get("T1 H-1").copied().unwrap_or(0);
    assert!(changes > 10, "{lines:?}");
    assert_eq!(lines.get("M620 S1A H-1"), Some(&changes), "{lines:?}");
    assert_eq!(lines.get("M620.6 I1 H-1"), Some(&changes), "{lines:?}");
    assert_eq!(lines.get("M620.11 I1 B-1"), Some(&(2 * changes)), "{lines:?}");
    assert_eq!(lines.get("M620 D-1"), Some(&2), "{lines:?}");
}

#[test]
fn the_h2d_writes_no_hotend_in_the_start_or_a_filament_change() {
    // Bambu Studio, h2d one, first2 and two: -1 in every hotend slot, as on the X2D.
    let one = hotend_lines(&slice(h2d(), [175.0, 160.0], &[1]));
    assert_eq!(
        one,
        expect(&[
            ("M620 D-1", 1),
            ("M620 S0A H-1", 1),
            ("M620.11 I0 B-1", 1),
            ("M620.6 I0 H-1", 1),
            ("T0 H-1", 1),
        ])
    );
    let mut c = h2d();
    two_filaments(&mut c);
    let first2 = hotend_lines(&slice(c.clone(), [175.0, 160.0], &[2]));
    assert_eq!(
        first2,
        expect(&[
            ("M620 D-1", 1),
            ("M620 S1A H-1", 1),
            ("M620.11 I1 B-1", 1),
            ("M620.6 I1 H-1", 1),
            ("T1 H-1", 1),
        ])
    );
    let two = hotend_lines(&slice(c, [175.0, 160.0], &[1, 2]));
    assert!(two.keys().all(|k| k.ends_with("-1")), "{two:?}");
    assert!(two.get("T1 H-1").is_some_and(|n| *n > 10), "{two:?}");
}

#[test]
fn other_printers_keep_their_hotend_ids() {
    // The H2C's rack makes it -1 already; the H2D Pro, H2S and A1 are not checked against their maker's slicer
    // yet and keep 0.
    for (model, printer_model, nozzles, want) in [
        ("bambu-h2d", "Bambu Lab H2C", json!(["1", "6"]), "-1"),
        ("bambu-h2d-pro", "Bambu Lab H2D Pro", json!(["1", "1"]), "0"),
        ("bambu-h2s", "Bambu Lab H2S", json!(["1"]), "0"),
        ("bambu-a1", "Bambu Lab A1", json!(["1"]), "0"),
    ] {
        let mut c = stock(model);
        c.insert("printer_model".into(), json!(printer_model));
        c.insert("extruder_max_nozzle_count".into(), nozzles);
        c.insert("machine_start_gcode".into(), json!(H2D_START));
        let lines = hotend_lines(&slice(c, [128.0, 128.0], &[1]));
        assert_eq!(lines.len(), 5, "{printer_model}: {lines:?}");
        assert!(
            lines.keys().all(|k| k.ends_with(&format!(" B{want}"))
                || k.ends_with(&format!(" H{want}"))
                || k.ends_with(&format!(" D{want}"))),
            "{printer_model}: {lines:?}"
        );
    }
}
