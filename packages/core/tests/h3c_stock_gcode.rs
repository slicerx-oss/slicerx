// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The Bambu Lab H3C with the maker's own start, end, layer change and filament change G-code as `SlicerX` ships it
//! (the `maker_bambu_h3c` family of packages/profiles/gcode-written.json): the stock text of the maker's 02.09.01.70
//! presets, rendered on a four-filament plate whose tools are set by hand (hotends 0, 2, 6 and 7, the TPU on the
//! TPU hotend). Each filament change selects the filament (`T`) inside the maker's change block, the hotend ids stay -1
//! as the printer's stock output writes them while the slice keeps each filament on its hand-set hotend, each tool is
//! given its temperature before it extrudes, a tool's heater is turned off once the print no longer needs it, and no
//! move the print works out leaves the bed.

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::float_cmp,
    clippy::many_single_char_names,
    reason = "a few blocks on a plate, and G-code numbers, filament and line indexes that are small"
)]

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};
mod common;

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// The hotend each filament is on by hand, as in the four-filament H3C test project: slot 4 is the TPU, on the TPU
/// hotend (7, tool 8 in the presets).
const HOTENDS: [i64; 4] = [0, 2, 6, 7];
/// Each filament's print and first layer temperature, all different so a temperature names its filament.
const TEMPS: [i64; 4] = [215, 220, 225, 240];
const FIRST_TEMPS: [i64; 4] = [218, 223, 228, 243];

/// The bed (`printable_area`, 330 x 320 mm) and height (`printable_height`, 325 mm) of the stock H3C.
fn limits() -> ([f64; 2], [f64; 2], f64) {
    let m = &read("packages/profiles/machine.json")["models"]["bambu-h3c"]["machine"];
    let pts: Vec<(f64, f64)> = m["printable_area"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let (x, y) = p.as_str().unwrap().split_once('x').unwrap();
            (x.parse().unwrap(), y.parse().unwrap())
        })
        .collect();
    let xs = pts.iter().map(|p| p.0);
    let ys = pts.iter().map(|p| p.1);
    (
        [xs.clone().fold(f64::MAX, f64::min), xs.fold(f64::MIN, f64::max)],
        [ys.clone().fold(f64::MAX, f64::min), ys.fold(f64::MIN, f64::max)],
        m["printable_height"]
            .as_f64()
            .or_else(|| m["printable_height"].as_str()?.parse().ok())
            .unwrap(),
    )
}

/// The shipped H3C family.
fn family() -> Value {
    let doc = common::shipped_gcode::doc();
    let name = doc["models"]["bambu-h3c"]
        .as_str()
        .expect("the H3C has a G-code family")
        .to_owned();
    doc["families"][name].clone()
}

/// The app's config for the stock H3C with three PLA filaments and the maker's 2.85 mm TPU in slot 4, on the hotends
/// set by hand, with the shipped family's G-code.
fn h3c() -> Map<String, Value> {
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
    let f = family();
    for (key, part) in [
        ("machine_start_gcode", "start"),
        ("machine_end_gcode", "end"),
        ("before_layer_change_gcode", "beforeLayerChange"),
        ("layer_change_gcode", "layerChange"),
        ("change_filament_gcode", "changeFilament"),
        ("machine_pause_gcode", "pause"),
        ("time_lapse_gcode", "timeLapse"),
    ] {
        out.insert(key.into(), f[part].clone());
    }
    for (k, v) in [
        ("nozzle_temperature", json!(TEMPS)),
        ("nozzle_temperature_initial_layer", json!(FIRST_TEMPS)),
        ("filament_type", json!(["PLA", "PLA", "PLA", "TPU"])),
        ("filament_diameter", json!([1.75, 1.75, 1.75, 2.85])),
        ("filament_max_volumetric_speed", json!([21, 21, 21, 3.6])),
        (
            "filament_extruder_variant",
            json!([
                "Direct Drive Standard",
                "Direct Drive Standard",
                "Direct Drive Standard",
                "Direct Drive TPU285"
            ]),
        ),
        (
            "filament_colour",
            json!(["#FFFFFF", "#0A2CA5", "#F72323", "#000000"]),
        ),
        ("filament_map_mode", json!("Manual")),
        ("filament_nozzle_map", json!(HOTENDS)),
    ] {
        out.insert(k.into(), v);
    }
    out
}

/// Four 20 mm blocks, one per filament slot, in a row across the middle of the bed: 0.2 (the first layer only), 4, 6
/// and 8 mm tall, so the filaments finish printing at different layers, the first before the second layer's
/// temperatures are set.
fn slice() -> api::SliceRun {
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    let m = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
    let (lo, hi) = m.bounds().unwrap();
    let objects: Vec<Value> = (1..=4u8)
        .map(|slot| {
            let x = 165.0 + 40.0 * (f64::from(slot) - 2.5) - f64::from(lo[0] + hi[0]) / 2.0;
            let y = 160.0 - f64::from(lo[1] + hi[1]) / 2.0;
            let zs = if slot == 1 { 0.01 } else { 0.1 * f64::from(slot) };
            json!({
                "id": format!("o{slot}"),
                "name": format!("block{slot}"),
                "mesh": "c",
                "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, zs, 0, x, y, -zs * f64::from(lo[2]), 1],
                "slotOverrides": {"cube.stl": slot},
            })
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": Value::Object(h3c()),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
}

/// The command of a line, comment and indent off.
fn code(l: &str) -> &str {
    l.split(';').next().unwrap_or("").trim()
}

/// The number after `letter` in a command's words.
fn word(c: &str, letter: char) -> Option<f64> {
    c.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(letter)?.parse().ok())
}

/// The filament of the maker's select block `M620 S<filament>A`.
fn ams_slot(c: &str) -> Option<usize> {
    c.split_whitespace()
        .nth(1)?
        .strip_prefix('S')?
        .strip_suffix('A')?
        .parse()
        .ok()
}

/// The command's first word, `G1`, `M620.6`.
fn op(c: &str) -> &str {
    c.split_whitespace().next().unwrap_or("")
}

#[test]
fn the_shipped_family_is_the_makers_stock_text() {
    // Each script byte for byte as the maker's 02.09.01.70 presets give it: the exact fingerprints the stock script
    // table records for the H3C.
    let f = family();
    let table = read("packages/core/data/canonical-stock.json");
    for (part, key) in [
        ("start", "machine_start_gcode"),
        ("end", "machine_end_gcode"),
        ("layerChange", "layer_change_gcode"),
        ("changeFilament", "change_filament_gcode"),
        ("pause", "machine_pause_gcode"),
        ("timeLapse", "time_lapse_gcode"),
    ] {
        let text = f[part].as_str().unwrap();
        let hash = Sha256::digest(text.as_bytes())
            .iter()
            .fold(String::new(), |mut h, b| {
                use std::fmt::Write as _;
                let _ = write!(h, "{b:02x}");
                h
            });
        let stock = table["scripts"].as_array().unwrap().iter().any(|s| {
            s["identity"]["model"] == "bambu-h3c"
                && s["key"] == key
                && s["version"] == "2.9.1"
                && s["exactFingerprint"] == hash.as_str()
        });
        assert!(stock, "{part} is not the maker's stock {key}");
    }
    for part in [
        "beforeLayerChange",
        "templateCustom",
        "wrappingDetection",
        "fileStart",
    ] {
        assert_eq!(f[part], "", "{part}: the maker's presets leave it empty");
    }
}

#[test]
fn each_filament_change_selects_its_hand_set_hotend_inside_the_makers_change_block() {
    let run = slice();
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    let lines: Vec<&str> = g.lines().map(code).filter(|c| !c.is_empty()).collect();
    // Filament selects: T0 to T3 for the four filaments, and T65535 once, at the end, to pull the filament back.
    let ts: Vec<i64> = lines
        .iter()
        .filter_map(|c| c.strip_prefix('T')?.parse().ok())
        .collect();
    assert_eq!(ts.iter().filter(|&&t| t == 65535).count(), 1, "{ts:?}");
    assert_eq!(ts.last(), Some(&65535));
    let used: std::collections::BTreeSet<i64> = ts.iter().copied().filter(|&t| t < 65535).collect();
    assert_eq!(
        used,
        (0..4).collect(),
        "every filament and nothing else is selected"
    );
    let changes = ts.windows(2).filter(|w| w[0] != w[1] && w[1] < 65535).count();
    assert!(changes >= 20, "{changes} changes");
    // Each select is wrapped as the maker's G-code wraps it: M620 S<f>A before, M621 S<f>A after, and its air printing
    // detect names the filament with hotend -1, as the stock output does (M620.6 I<f> H-1).
    let mut open: Option<i64> = None;
    let mut wrapped = 0;
    let mut detect = 0;
    for c in &lines {
        match op(c) {
            "M620" if c.ends_with('A') => open = ams_slot(c).map(|s| s as i64),
            "M621" if c.ends_with('A') => open = None,
            "M620.6" => {
                let f = word(c, 'I').unwrap();
                assert!((0.0..4.0).contains(&f), "{c}");
                assert_eq!(word(c, 'H'), Some(-1.0), "{c}");
                detect += 1;
            }
            t if t.starts_with('T') => {
                let t: i64 = t[1..].parse().unwrap();
                if t < 65535 {
                    assert_eq!(open, Some(t), "T{t} outside its M620 S{t}A block");
                    wrapped += 1;
                }
            }
            _ => {}
        }
    }
    assert_eq!(wrapped, ts.len() - 1);
    // One air printing detect for the start's filament, then one per change.
    assert_eq!(detect, changes + 1);
    // The slice keeps each filament on the hotend set by hand.
    let map = run.report.filament_map.as_ref().expect("a filament map");
    assert_eq!(map.nozzles, HOTENDS.map(|h| h as u8).to_vec());
}

/// Line numbers with a filament index.
type Marks = Vec<(usize, usize)>;

/// The filament selects (`T<n>`, n under 4) and heater-off lines (`M104 I<n> S0`) in order, with their line numbers.
fn selects_and_offs(g: &str) -> (Marks, Marks) {
    let (mut ts, mut offs) = (Vec::new(), Vec::new());
    for (n, c) in g.lines().map(code).enumerate() {
        if let Some(t) = c
            .strip_prefix('T')
            .and_then(|t| t.parse::<usize>().ok())
            .filter(|&t| t < 4)
        {
            ts.push((n, t));
        } else if op(c) == "M104"
            && word(c, 'S') == Some(0.0)
            && let Some(i) = word(c, 'I')
        {
            offs.push((n, i as usize));
        }
    }
    (ts, offs)
}

#[test]
fn a_tools_heater_goes_off_once_the_print_no_longer_needs_it() {
    let g = String::from_utf8(slice().gcode).unwrap();
    let (ts, offs) = selects_and_offs(&g);
    // The filament selected last prints to the end; the end G-code turns the heaters off. Every other filament gets
    // one heater-off line, after its last select.
    let last_tool = ts.last().unwrap().1;
    for f in 0..4 {
        let mine: Vec<usize> = offs.iter().filter(|o| o.1 == f).map(|o| o.0).collect();
        if f == last_tool {
            assert!(mine.is_empty(), "filament {f} prints to the end: {mine:?}");
            continue;
        }
        assert_eq!(mine.len(), 1, "filament {f}: {mine:?}");
        let last_select = ts.iter().rev().find(|t| t.1 == f).unwrap().0;
        // Never before a later use: no select of the filament after its heater goes off.
        assert!(
            mine[0] > last_select,
            "filament {f} off at line {} before its last select at {last_select}",
            mine[0]
        );
    }
    // Nothing heats a filament's hotend again once it is off, and no line in the print names a hotend by T (the stock
    // G-code addresses a filament's hotend with I).
    let lines: Vec<&str> = g.lines().map(code).collect();
    for &(n, f) in &offs {
        for (k, c) in lines.iter().enumerate().skip(n + 1) {
            let heats = matches!(op(c), "M104" | "M109") && word(c, 'S').is_some_and(|t| t > 0.0);
            assert!(
                !(heats && word(c, 'I') == Some(f as f64)),
                "line {k} `{c}` heats filament {f} after it is off"
            );
        }
    }
    let body_end = g.rfind(";===== H3C endgcode").unwrap_or(g.len());
    let body_start = g
        .find("; CHANGE_LAYER")
        .or_else(|| g.find(";LAYER_CHANGE"))
        .unwrap();
    for c in g[body_start..body_end].lines().map(code) {
        assert!(
            !(matches!(op(c), "M104" | "M109") && word(c, 'T').is_some()),
            "`{c}` names a hotend by T"
        );
    }
    // The tool in use is never the one turned off: the most recent select before each heater-off line is another
    // filament.
    for &(n, f) in &offs {
        let active = ts.iter().rev().find(|t| t.0 < n).unwrap().1;
        assert_ne!(active, f, "line {n} turns off the active filament {f}");
    }
}

#[test]
fn the_heater_off_line_numbers_the_tool_as_its_select_does() {
    // On the hand-set map filament 1 is on hotend 2 and filament 2 on hotend 6: the heater-off line names the filament
    // (I1 after the last T1, I2 after the last T2), as the select and the stock start G-code do, never the hotend.
    let g = String::from_utf8(slice().gcode).unwrap();
    let (ts, offs) = selects_and_offs(&g);
    for f in [1usize, 2] {
        let last_select = ts.iter().rev().find(|t| t.1 == f).unwrap().0;
        let off = offs
            .iter()
            .find(|o| o.1 == f)
            .unwrap_or_else(|| panic!("no heater-off for filament {f}"));
        assert!(off.0 > last_select);
    }
    // No heater-off line names a hotend number (6 or 7) in place of its filament.
    assert!(
        offs.iter().all(|o| o.1 < 4),
        "a heater-off line names a hotend: {offs:?}"
    );
    assert!(
        HOTENDS.iter().zip(0..).any(|(&h, f)| h as usize != f),
        "the map tells the numberings apart"
    );
}

#[test]
fn each_tool_is_given_its_temperature_before_it_extrudes() {
    let g = String::from_utf8(slice().gcode).unwrap();
    // Per filament: the temperatures set for it since it was last selected. The maker's change G-code hands the new
    // filament's temperature to the printer in M620.10 A1 (P) and M620.15 (C); the start heats with M104 and M109.
    let mut current: Option<usize> = None;
    let mut pending: Option<usize> = None;
    let mut heated: Vec<Vec<i64>> = vec![Vec::new(); 4];
    let mut extruded = [false; 4];
    let mut absolute_e = false;
    for c in g.lines().map(code).filter(|c| !c.is_empty()) {
        match op(c) {
            "M620" if c.ends_with('A') => pending = ams_slot(c).filter(|&s| s < 4),
            "M620.10" if c.contains(" A1 ") => {
                if let (Some(f), Some(p)) = (pending, word(c, 'P')) {
                    heated[f].push(p as i64);
                }
            }
            "M620.15" => {
                if let (Some(f), Some(p)) = (pending, word(c, 'C')) {
                    heated[f].push(p as i64);
                }
            }
            "M104" | "M109" => {
                // A line with I names its filament; one without is for the filament in use, or before the first select
                // the one the start loads.
                if let Some(s) = word(c, 'S').filter(|&s| s > 0.0) {
                    let target = word(c, 'I').map(|i| i as usize).or(current).or(pending);
                    if let Some(f) = target.filter(|&f| f < 4) {
                        heated[f].push(s as i64);
                    }
                }
            }
            "M82" => absolute_e = true,
            "M83" => absolute_e = false,
            t if t.starts_with('T') => current = t[1..].parse().ok().filter(|&t: &usize| t < 4),
            "G1" | "G2" | "G3" => {
                if let (Some(f), Some(e)) = (current, word(c, 'E'))
                    && e > 0.0
                    && !absolute_e
                    && !extruded[f]
                {
                    extruded[f] = true;
                    assert!(
                        heated[f].contains(&TEMPS[f]) || heated[f].contains(&FIRST_TEMPS[f]),
                        "filament {f} extrudes at `{c}` with only {:?} set for it",
                        heated[f]
                    );
                }
            }
            _ => {}
        }
    }
    assert_eq!(extruded, [true; 4], "every filament prints");
}

#[test]
fn a_filament_with_no_fin_temperature_slices_with_that_check_off() {
    // The test filaments carry no fins_extrude_safe_temp and no preset ids, as a filament made from scratch: the slice
    // goes through, the stock G-code's fin check is off (under 30 C) and the filament id it announces is empty.
    let g = String::from_utf8(slice().gcode).unwrap();
    let lines: Vec<&str> = g.lines().map(code).collect();
    assert!(lines.contains(&"M650.11 E0"));
    assert!(!lines.iter().any(|c| c.starts_with("M650.11 E1")));
    assert!(lines.contains(&"M1002 set_next_filament_id:"));
}

#[test]
fn no_move_leaves_the_bed_but_the_makers_own_fixed_points() {
    let ([x0, x1], [y0, y1], top) = limits();
    let g = String::from_utf8(slice().gcode).unwrap();
    // The maker's fixed points off the printable area, all literal values of its scripts, none worked out from the
    // print: the front load line at Y -0.5 (start), the parking spot at Y 336.89 behind the bed and the last lift to
    // Z 327 (end). Moves the printer runs itself (homing, probing, G150 wipes, G387) leave the position unknown.
    let fixed_y = [-0.5, 336.89];
    let fixed_z = [327.0];
    let mut pos: [Option<f64>; 3] = [None; 3];
    let mut relative = false;
    let mut start = true;
    let mut outside = Vec::new();
    for raw in g.lines() {
        if raw.starts_with(";LAYER_CHANGE") || raw.starts_with("; CHANGE_LAYER") {
            start = false;
        }
        let c = code(raw);
        match op(c) {
            "G90" => relative = false,
            "G91" => relative = true,
            "G0" | "G1" | "G2" | "G3" => {
                for (i, axis) in ['X', 'Y', 'Z'].into_iter().enumerate() {
                    if let Some(v) = word(c, axis) {
                        pos[i] = if relative { pos[i].map(|p| p + v) } else { Some(v) };
                    }
                }
                let [x, y, z] = pos;
                let off_x = x.is_some_and(|x| x < x0 - 1e-6 || x > x1 + 1e-6);
                let off_y = y.is_some_and(|y| (y < y0 - 1e-6 || y > y1 + 1e-6) && !fixed_y.contains(&y));
                let off_z = z.is_some_and(|z| (z < 0.0 || z > top + 1e-6) && !fixed_z.contains(&z));
                if off_x || off_y || off_z {
                    outside.push(format!("{}{raw}", if start { "start: " } else { "" }));
                }
            }
            o if o.starts_with("G28")
                || o.starts_with("G150")
                || o.starts_with("G387")
                || o.starts_with("G380")
                || o.starts_with("G29")
                || o.starts_with("G37") =>
            {
                pos = [None; 3];
            }
            _ => {}
        }
    }
    assert!(outside.is_empty(), "moves off the bed:\n{}", outside.join("\n"));
    // The start's own moves at a known position are all on the bed, but for the front load line.
    let s = family()["start"].as_str().unwrap().to_owned();
    for l in s.lines().map(code).filter(|c| matches!(op(c), "G0" | "G1")) {
        if let (Some(x), Some(y)) = (word(l, 'X'), word(l, 'Y')) {
            assert!(
                (x0..=x1).contains(&x) && ((y0..=y1).contains(&y) || y == -0.5),
                "{l}"
            );
        }
    }
}
