// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The Bambu Lab H3C: one extruder that holds nine hotends, each with its own filament path. Each filament the
//! plate prints with takes a hotend of its own, so a change between filaments is a hotend swap: it costs the
//! printer's hotend change time (`machine_hotend_change_time`, else its switch time) and flushes nothing. The
//! hotend ids reach the change G-code in the variables the maker's G-code reads (`next_hotend`, `next_nozzle_id`,
//! `nozzle_diameter_at_nozzle_id`). A 2.85 mm TPU filament prints on the TPU hotend (tool 8 by the presets), and an
//! object on that hotend prints with the TPU hotend's process values when the settings list them per variant.
//!
//! The printer is the stock H3C from resolved/bambu-lab.json. Its family G-code is not in gcode.json yet, so these
//! tests give it a start and a change G-code of a few comment lines that print the ids.

#![allow(
    clippy::cast_precision_loss,
    clippy::float_cmp,
    reason = "a few cubes on a plate, and G-code numbers"
)]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};
use sx_core::config::PrintConfig;
use sx_core::nozzles::{Map as NozzleMap, Usage};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// The start and change G-code: one comment line each with the filament, hotend, nozzle id and size, and at a change
/// the flush length too.
const START: &str = "; H3C start f[initial_no_support_filament_id] h[initial_no_support_hotend] \
n[initial_no_support_nozzle_id] d{nozzle_diameter_at_nozzle_id[initial_no_support_nozzle_id]}\n";
const CHANGE: &str = "; H3C change f[current_filament_id]>[next_filament_id] h[current_hotend]>[next_hotend] \
n[current_nozzle_id]>[next_nozzle_id] d{nozzle_diameter_at_nozzle_id[next_nozzle_id]} flush[flush_length]\n";

/// The app's config for the stock H3C with `filaments` PLA filaments: schema defaults, the resolved process, filament
/// and printer, then the start and change G-code above.
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
    out.insert("machine_start_gcode".into(), json!(START));
    out.insert("machine_end_gcode".into(), json!(""));
    out.insert("change_filament_gcode".into(), json!(CHANGE));
    let colors = [
        "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF", "#FFFFFF", "#000000",
    ];
    for (k, v) in [
        ("nozzle_temperature", json!(vec![220; filaments])),
        ("nozzle_temperature_initial_layer", json!(vec![220; filaments])),
        ("filament_type", json!(vec!["PLA"; filaments])),
        ("filament_diameter", json!(vec![1.75; filaments])),
        ("filament_max_volumetric_speed", json!(vec![40; filaments])),
        (
            "filament_colour",
            json!(
                (0..filaments)
                    .map(|i| colors[i % colors.len()])
                    .collect::<Vec<_>>()
            ),
        ),
    ] {
        out.insert(k.into(), v);
    }
    out
}

/// Filament `slot` (1-based) of `c` as the maker's 2.85 mm TPU: its diameter, its type and its only variant.
fn tpu285(c: &mut Map<String, Value>, slot: usize) {
    let n = c["filament_type"].as_array().unwrap().len();
    let mut set = |key: &str, v: Value, other: Value| {
        let list: Vec<Value> = (1..=n)
            .map(|s| if s == slot { v.clone() } else { other.clone() })
            .collect();
        c.insert(key.into(), Value::Array(list));
    };
    set("filament_type", json!("TPU"), json!("PLA"));
    set("filament_diameter", json!(2.85), json!(1.75));
    let mut variants: Vec<Value> = c
        .get("filament_extruder_variant")
        .and_then(Value::as_array)
        .filter(|a| a.len() == n)
        .cloned()
        .unwrap_or_else(|| vec![json!("Direct Drive Standard"); n]);
    variants[slot - 1] = json!("Direct Drive TPU285");
    c.insert("filament_extruder_variant".into(), Value::Array(variants));
}

/// The 20 mm cube, one object per filament slot given, 50 mm apart about the bed's middle.
fn slice(config: Map<String, Value>, slots: &[u8]) -> sx_core::Result<api::SliceRun> {
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
    api::run_request(&req, &move |_: &str| Ok(m.clone()))
}

fn gcode(run: &api::SliceRun) -> String {
    String::from_utf8(run.gcode.clone()).unwrap()
}

/// A change line's numbers: filament from and to, hotend from and to, nozzle id from and to, the size of the new
/// nozzle and the flush length.
#[derive(Debug, PartialEq)]
struct Change {
    filament: (i64, i64),
    hotend: (i64, i64),
    nozzle: (i64, i64),
    size: f64,
    flush: f64,
}

fn changes(g: &str) -> Vec<Change> {
    let pair = |w: &str, p: &str| -> (i64, i64) {
        let (a, b) = w.strip_prefix(p).unwrap().split_once('>').unwrap();
        (a.parse().unwrap(), b.parse().unwrap())
    };
    g.lines()
        .filter_map(|l| l.strip_prefix("; H3C change "))
        .map(|l| {
            let w: Vec<&str> = l.split_whitespace().collect();
            Change {
                filament: pair(w[0], "f"),
                hotend: pair(w[1], "h"),
                nozzle: pair(w[2], "n"),
                size: w[3].strip_prefix('d').unwrap().parse().unwrap(),
                flush: w[4].strip_prefix("flush").unwrap().parse().unwrap(),
            }
        })
        .collect()
}

fn start(g: &str) -> String {
    g.lines()
        .find_map(|l| l.strip_prefix("; H3C start "))
        .unwrap()
        .to_owned()
}

#[test]
fn each_filament_prints_on_a_hotend_of_its_own_and_flushes_nothing() {
    let run = slice(h3c(3), &[1, 2, 3]).unwrap();
    let g = gcode(&run);
    assert_eq!(start(&g), "f0 h0 n0 d0.4");
    let cs = changes(&g);
    assert!(cs.len() >= 40, "{} changes", cs.len());
    for c in &cs {
        // Filament n (0-based) is hotend n, and its nozzle id is the same.
        assert_eq!(c.hotend, c.filament, "{c:?}");
        assert_eq!(c.nozzle, c.filament, "{c:?}");
        assert_eq!(c.size, 0.4, "{c:?}");
        // Each hotend keeps its own filament: no flush at any change.
        assert_eq!(c.flush, 0.0, "{c:?}");
    }
    // The report reads the map back: one extruder, a hotend per filament.
    let map = run.report.filament_map.as_ref().expect("a filament map");
    assert_eq!(map.extruders, vec![1, 1, 1]);
    assert_eq!(map.nozzles, vec![0, 1, 2]);
}

#[test]
fn a_two_point_eight_five_tpu_takes_the_tpu_hotend() {
    let mut c = h3c(3);
    tpu285(&mut c, 2);
    let g = gcode(&slice(c, &[1, 2, 3]).unwrap());
    let cs = changes(&g);
    assert!(!cs.is_empty());
    for ch in &cs {
        // Filaments 1 and 3 on the first two standard hotends, the TPU on hotend 7 (tool 8), the one the presets
        // give the TPU285 volume type.
        let hotend = |f: i64| [0, 7, 1][usize::try_from(f).unwrap()];
        assert_eq!(
            ch.hotend,
            (hotend(ch.filament.0), hotend(ch.filament.1)),
            "{ch:?}"
        );
    }
}

#[test]
fn filaments_past_the_standard_hotends_share_the_first() {
    let mut raw = h3c(10);
    raw.insert("filament_map_mode".into(), json!("Auto For Flush"));
    let cfg = PrintConfig::from_value(&Value::Object(raw)).unwrap();
    let usage = Usage {
        layers: vec![(1..=10).collect(); 20],
        boxes: Vec::new(),
    };
    let m = NozzleMap::resolve(&cfg, 10, &usage).expect("a map on the H3C");
    assert_eq!(m.extruder, vec![0; 10]);
    // Eight standard hotends in slot order, skipping the TPU hotend (7); filaments 9 and 10 share hotend 0, the one
    // the external AMS feeds.
    assert_eq!(m.nozzle, vec![0, 1, 2, 3, 4, 5, 6, 8, 0, 0]);
    assert!(m.auto);
}

#[test]
fn a_tool_picked_by_hand_is_kept() {
    let mut raw = h3c(3);
    raw.insert("filament_map_mode".into(), json!("Manual"));
    raw.insert("filament_nozzle_map".into(), json!([4, 2, 0]));
    let cfg = PrintConfig::from_value(&Value::Object(raw.clone())).unwrap();
    let usage = Usage {
        layers: vec![vec![1, 2, 3]; 20],
        boxes: Vec::new(),
    };
    let m = NozzleMap::resolve(&cfg, 3, &usage).expect("a map on the H3C");
    assert_eq!(m.nozzle, vec![4, 2, 0]);
    assert!(!m.auto);
    let g = gcode(&slice(raw, &[1, 2, 3]).unwrap());
    for ch in changes(&g) {
        let hotend = |f: i64| [4, 2, 0][usize::try_from(f).unwrap()];
        assert_eq!(
            ch.hotend,
            (hotend(ch.filament.0), hotend(ch.filament.1)),
            "{ch:?}"
        );
    }
}

#[test]
fn a_tpu_filament_without_the_tpu_hotend_is_refused() {
    // Two 2.85 mm TPU filaments, one TPU hotend.
    let mut c = h3c(3);
    tpu285(&mut c, 1);
    tpu285(&mut c, 3);
    let e = slice(c, &[1, 2, 3]).map(|_| ()).unwrap_err().to_string();
    assert!(e.contains("filament_map") && e.contains("TPU"), "{e}");
    // A 1.75 mm PLA picked by hand onto the TPU hotend.
    let mut c = h3c(2);
    c.insert("filament_map_mode".into(), json!("Manual"));
    c.insert("filament_nozzle_map".into(), json!([0, 7]));
    let e = slice(c, &[1, 2]).map(|_| ()).unwrap_err().to_string();
    assert!(e.contains("filament_map") && e.contains("tool 8"), "{e}");
}

/// The print time of two cubes on filaments 1 and 2 with `edit` applied, and the number of changes.
fn timed(edit: &[(&str, Value)]) -> (f64, usize) {
    let mut c = h3c(2);
    for (k, v) in edit {
        c.insert((*k).into(), v.clone());
    }
    let run = slice(c, &[1, 2]).unwrap();
    (run.report.stats.time_s, changes(&gcode(&run)).len())
}

#[test]
fn a_hotend_swap_costs_the_hotend_change_time_and_no_unload() {
    let (base, n) = timed(&[]);
    assert!(n >= 40, "{n} changes");
    // Each hotend keeps its filament loaded: the unload time costs nothing.
    let (no_unload, _) = timed(&[("machine_unload_filament_time", json!(0))]);
    assert!((base - no_unload).abs() < 1.0, "{base} against {no_unload}");
    // The stock H3C gives no hotend change time, so a swap takes its switch time (4 s): 10 s more each, 14 s.
    let (slow, _) = timed(&[("machine_switch_extruder_time", json!(14))]);
    let per = (slow - base) / n as f64;
    assert!((per - 10.0).abs() < 0.05, "{per} s more per change over {n}");
    // A hotend change time, where the printer gives one, wins over the switch time: 9 s, 5 s more each.
    let (hotend, _) = timed(&[("machine_hotend_change_time", json!(9))]);
    let per = (hotend - base) / n as f64;
    assert!((per - 5.0).abs() < 0.05, "{per} s more per change over {n}");
}

#[test]
fn an_object_on_the_tpu_hotend_prints_with_the_tpu_variant() {
    // The process lists one outer wall speed per variant: standard, high flow and TPU285.
    let mut c = h3c(2);
    tpu285(&mut c, 2);
    for (k, v) in [
        ("print_extruder_id", json!(["1", "1", "1"])),
        (
            "print_extruder_variant",
            json!([
                "Direct Drive Standard",
                "Direct Drive High Flow",
                "Direct Drive TPU285"
            ]),
        ),
        ("outer_wall_speed", json!([60, 70, 25])),
        ("slow_down_for_layer_cooling", json!(false)),
    ] {
        c.insert(k.into(), v);
    }
    let g = gcode(&slice(c, &[1, 2]).unwrap());
    // Outer wall feeds above the first layer, per cube (the left one below x 165).
    let (mut left, mut right) = (
        std::collections::BTreeSet::new(),
        std::collections::BTreeSet::new(),
    );
    let (mut outer, mut z, mut x, mut feed) = (false, 0.0f64, 0.0f64, 0i64);
    for l in g.lines() {
        if let Some(t) = l.strip_prefix("; FEATURE: ") {
            outer = t.trim() == "Outer wall";
            continue;
        }
        let code = l.split(';').next().unwrap_or("").trim();
        if !code.starts_with("G1") && !code.starts_with("G2") && !code.starts_with("G3") {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .skip(1)
                .find_map(|w| w.strip_prefix(c)?.parse::<f64>().ok())
        };
        z = word('Z').unwrap_or(z);
        #[allow(clippy::cast_possible_truncation, reason = "a feed rate")]
        if let Some(f) = word('F') {
            feed = f.round() as i64;
        }
        let nx = word('X').unwrap_or(x);
        let moves = word('X').is_some() || word('Y').is_some();
        if outer && z > 0.3 && moves && word('E').is_some_and(|e| e > 0.0) {
            if f64::midpoint(x, nx) < 165.0 {
                left.insert(feed);
            } else {
                right.insert(feed);
            }
        }
        x = nx;
    }
    assert_eq!(left, std::collections::BTreeSet::from([3600]), "PLA cube");
    assert_eq!(right, std::collections::BTreeSet::from([1500]), "TPU cube");
}

/// [`slice`] with the request options given, over `trustedGcode`.
fn slice_with(config: Map<String, Value>, slots: &[u8], options: &Value) -> sx_core::Result<api::SliceRun> {
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    let m = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
    let (lo, hi) = m.bounds().unwrap();
    let objects: Vec<Value> = slots
        .iter()
        .enumerate()
        .map(|(i, slot)| {
            let x = 140.0 + 50.0 * i as f64 - f64::from(lo[0] + hi[0]) / 2.0;
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
    let mut opts = json!({"trustedGcode": true});
    for (k, v) in options.as_object().unwrap() {
        opts[k] = v.clone();
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": Value::Object(config),
        "options": opts,
    }))
    .unwrap();
    api::run_request(&req, &move |_: &str| Ok(m.clone()))
}

/// The chamber target the start G-code gets (`overall_chamber_temperature`) and the slice's warnings, for a plate of
/// two filaments that ask for `chambers` C, on a printer with `limit`.
fn chamber(chambers: [i64; 2], limit: Option<f64>) -> (i64, Vec<String>) {
    let mut c = h3c(2);
    c.insert("chamber_temperature".into(), json!(chambers));
    c.insert(
        "machine_start_gcode".into(),
        json!("; H3C chamber {overall_chamber_temperature}\n"),
    );
    let options = limit.map_or_else(|| json!({}), |l| json!({"machineLimits": {"chamberMaxC": l}}));
    let run = slice_with(c, &[1, 2], &options).unwrap();
    let g = gcode(&run);
    let t = g
        .lines()
        .find_map(|l| l.strip_prefix("; H3C chamber "))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    (t, run.report.warnings.iter().map(|w| w.message.clone()).collect())
}

#[test]
fn a_chamber_target_above_the_printer_limit_is_held_to_it() {
    // The H3C heats its chamber to 65 C. A filament asking for 70 C prints at 65 C, and the slice says so.
    let (t, warnings) = chamber([70, 40], Some(65.0));
    assert_eq!(t, 65);
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("chamber") && w.contains("70") && w.contains("65 C")),
        "{warnings:?}"
    );
    // Within the limit: as asked, and nothing to say.
    let (t, warnings) = chamber([60, 40], Some(65.0));
    assert_eq!(t, 60);
    assert!(!warnings.iter().any(|w| w.contains("chamber")), "{warnings:?}");
    // No limit given: the target is the filaments' own, as before.
    let (t, _) = chamber([70, 40], None);
    assert_eq!(t, 70);
}
