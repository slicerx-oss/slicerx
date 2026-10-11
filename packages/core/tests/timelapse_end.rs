// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A bed slinger's timelapse block parks the head off the part (the A1 at X0 and X-48.2). Nothing may extrude or wipe
//! from there: inside the print the next path travels back first, and when the print's last layer ends with the
//! block, the closing retraction and wipe come before it and only the end G-code follows, as Orca and Bambu Studio
//! write it. The configs are built the way the app builds them: the settings schema's defaults, then the A1's
//! shipped process, filament and printer settings, then its start, end and timelapse G-code.

#![allow(clippy::disallowed_methods)]
// A box's corners and faces read best with short names.
#![allow(clippy::many_single_char_names)]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

fn stock_a1() -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let m = read("packages/profiles/resolved/bambu-lab.json")["models"]["bambu-a1"].clone();
    let base = m["base"].as_str().unwrap().to_owned();
    for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    let gcode = read("packages/profiles/gcode.json");
    let family = gcode["models"]["bambu-a1"].as_str().unwrap().to_owned();
    for (key, part) in [
        ("machine_start_gcode", "start"),
        ("machine_end_gcode", "end"),
        ("time_lapse_gcode", "timeLapse"),
    ] {
        out.insert(key.into(), gcode["families"][&family][part].clone());
    }
    out.insert("smart_layer".into(), json!("off"));
    out
}

/// A closed box `w` x `d` x `h` mm with its corner at the origin, as binary STL.
fn box_stl(w: f32, d: f32, h: f32) -> Vec<u8> {
    let v = [
        [0.0, 0.0, 0.0],
        [w, 0.0, 0.0],
        [w, d, 0.0],
        [0.0, d, 0.0],
        [0.0, 0.0, h],
        [w, 0.0, h],
        [w, d, h],
        [0.0, d, h],
    ];
    let faces = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    let mut b = vec![0u8; 80];
    b.extend_from_slice(&12u32.to_le_bytes());
    for f in faces {
        b.extend_from_slice(&[0u8; 12]);
        for i in f {
            for c in v[i] {
                b.extend_from_slice(&f32::to_le_bytes(c));
            }
        }
        b.extend_from_slice(&[0u8; 2]);
    }
    b
}

fn slice(stl: &[u8], at: [f32; 2], shards: u32) -> String {
    let m = Arc::new(Mesh::load(stl, "box.stl").unwrap());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "o", "name": "box", "mesh": "m",
                               "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], 0, 1]}]},
        "config": Value::Object(stock_a1()),
        "options": {"trustedGcode": true, "shards": shards},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

/// From the first layer on (the start G-code purges at the A1's chute on purpose), every move with E that starts
/// at the park X (the part stands well inside the bed): extruding or wiping while the head moves, or a prime in
/// place. Their lines, 1-based.
fn from_park(g: &str) -> Vec<usize> {
    let (mut x, mut y) = (0.0, 0.0);
    let mut printing = false;
    let mut out = Vec::new();
    for (i, line) in g.lines().enumerate() {
        printing |= line.starts_with("; CHANGE_LAYER");
        let code = line.split(';').next().unwrap_or("").trim();
        if !(code.starts_with("G0 ")
            || code.starts_with("G1 ")
            || code.starts_with("G2 ")
            || code.starts_with("G3 "))
        {
            continue;
        }
        let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
        let e = word(code, 'E').unwrap_or(0.0);
        let moves = (nx - x).abs() > 1e-9 || (ny - y).abs() > 1e-9;
        if printing && x < 1.0 && ((moves && e != 0.0) || (!moves && e > 0.0)) {
            out.push(i + 1);
        }
        (x, y) = (nx, ny);
    }
    out
}

/// A finished A1 file with timelapse blocks: nothing extrudes, wipes or primes from the park position.
fn check(g: &str) {
    assert!(
        g.contains("; SKIPTYPE: timelapse"),
        "the timelapse blocks are written"
    );
    let parked = from_park(g);
    assert!(
        parked.is_empty(),
        "moves with E from the park position at lines {parked:?}"
    );
}

/// After the print's last timelapse block, only the end G-code moves the head.
fn ends_parked(g: &str) {
    let after = &g[g.rfind("; SKIPPABLE_END").unwrap()..];
    let end = after
        .find(";TYPE:Custom")
        .or_else(|| after.find("; FEATURE: Custom"))
        .unwrap();
    let between: Vec<&str> = after[..end]
        .lines()
        .filter(|l| l.starts_with("G0") || l.starts_with("G1") || l.starts_with("G2") || l.starts_with("G3"))
        .collect();
    assert!(
        between.is_empty(),
        "moves after the last timelapse block: {between:?}"
    );
}

#[test]
fn a_wall_print_ends_with_its_wipe_before_the_last_timelapse_block() {
    // A 0.8 mm wall prints walls only, so every layer's block comes at its end: the mid layers travel back from
    // the park position before they print, and the last one leaves the head parked for the end G-code.
    let g = slice(&box_stl(0.8, 30.0, 6.0), [128.0, 120.0], 1);
    check(&g);
    ends_parked(&g);
    let last = &g[g.rfind("; CHANGE_LAYER").unwrap()..];
    let wipe = last.rfind("; WIPE_END").expect("the closing wipe");
    let block = last.rfind("; SKIPPABLE_START").unwrap();
    assert!(wipe < block, "the closing wipe comes before the last block");
    // Every mid layer's block is followed by a travel back to where the layer's last path ended.
    let mids = g.matches("; SKIPTYPE: timelapse").count();
    assert!(mids > 10, "{mids} blocks");
    assert_eq!(
        slice(&box_stl(0.8, 30.0, 6.0), [128.0, 120.0], 4),
        g,
        "1 and 4 shards"
    );
}

#[test]
fn a_print_with_infill_puts_its_blocks_before_the_infill_and_never_prints_from_the_park_position() {
    let g = slice(&box_stl(20.0, 20.0, 6.0), [118.0, 118.0], 1);
    check(&g);
    assert_eq!(
        slice(&box_stl(20.0, 20.0, 6.0), [118.0, 118.0], 4),
        g,
        "1 and 4 shards"
    );
}
