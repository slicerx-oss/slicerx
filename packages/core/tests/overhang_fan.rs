// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Part fan on Bambu Lab printers: the overhang fan on leaning walls, and the layer fan around tool changes and
//! auxiliary fan lines.
//!
//! The configs are built the way the app builds them: the settings schema's defaults, then the printer's shipped
//! process, filament and printer settings, then its G-code. The parts are our own procedural shapes.

#![allow(clippy::disallowed_methods, clippy::many_single_char_names)]

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

/// A shipped Bambu Lab printer as the app sets it up, with uniform layers.
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
        ("before_layer_change_gcode", "beforeLayerChange"),
        ("layer_change_gcode", "layerChange"),
        ("change_filament_gcode", "changeFilament"),
        ("time_lapse_gcode", "timeLapse"),
    ] {
        if let Some(v) = gcode["families"][&family].get(part) {
            out.insert(key.into(), v.clone());
        }
    }
    out.insert("smart_layer".into(), json!("off"));
    out
}

/// The triangles of a closed solid between a bottom and a top polygon (counterclockwise, same vertex count).
fn loft(bottom: &[[f32; 3]], top: &[[f32; 3]]) -> Vec<[[f32; 3]; 3]> {
    let n = bottom.len();
    let mut tris: Vec<[[f32; 3]; 3]> = Vec::new();
    for i in 1..n - 1 {
        tris.push([bottom[0], bottom[i + 1], bottom[i]]);
        tris.push([top[0], top[i], top[i + 1]]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        tris.push([bottom[i], bottom[j], top[j]]);
        tris.push([bottom[i], top[j], top[i]]);
    }
    tris
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

fn rect(x1: f32, y1: f32, z: f32) -> Vec<[f32; 3]> {
    vec![[0.0, 0.0, z], [x1, 0.0, z], [x1, y1, z], [0.0, y1, z]]
}

/// A 20 mm wall 30 mm deep, 4 mm tall, then 10 mm more leaning out on the +X side `angle` degrees from vertical.
fn wedge(angle: f32) -> Vec<u8> {
    let reach = 20.0 + 10.0 * angle.to_radians().tan();
    let mut tris = loft(&rect(20.0, 30.0, 0.0), &rect(20.0, 30.0, 4.0));
    tris.extend(loft(&rect(20.0, 30.0, 4.0), &rect(reach, 30.0, 14.0)));
    stl(&tris)
}

fn slice(model: &[u8], config: &Map<String, Value>) -> String {
    slice_with_preview(model, config).0
}

/// The G-code and the SXPV preview of one slice.
fn slice_with_preview(model: &[u8], config: &Map<String, Value>) -> (String, Vec<u8>) {
    let mesh = Arc::new(Mesh::load(model, "m.stl").unwrap());
    let (lo, hi) = mesh.bounds().unwrap();
    let (cx, cy) = (128.0 - lo[0].midpoint(hi[0]), 128.0 - lo[1].midpoint(hi[1]));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "o", "name": "part", "mesh": "m",
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx, cy, -lo[2], 1]}]},
        "config": Value::Object(config.clone()),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    (String::from_utf8(r.gcode).unwrap(), r.preview)
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

/// What one layer's walls print under the overhang fan (part fan 255).
#[derive(Debug, Default)]
struct Cooled {
    /// Fan-on length per feature label, mm.
    mm: BTreeMap<String, f64>,
    /// The fastest fan-on outer wall move, mm/s.
    outer_speed: f64,
}

/// Per layer from 1: the extruding moves that run with the part fan at 255, by feature.
fn cooled(gcode: &str) -> BTreeMap<usize, Cooled> {
    let mut out: BTreeMap<usize, Cooled> = BTreeMap::new();
    let (mut layer, mut feature, mut fan, mut f) = (0usize, String::new(), 0.0f64, 0.0f64);
    let (mut x, mut y) = (0.0f64, 0.0f64);
    for line in gcode.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        if line.starts_with("; CHANGE_LAYER") {
            layer += 1;
        } else if let Some(name) = line.strip_prefix("; FEATURE: ") {
            name.trim().clone_into(&mut feature);
        } else if code.starts_with("M107") {
            fan = 0.0;
        } else if code.starts_with("M106") && !code.contains(" P2") && !code.contains(" P3") {
            fan = word(code, 'S').unwrap_or(0.0);
        } else if code.starts_with("G1") || code.starts_with("G0") {
            if let Some(v) = word(code, 'F') {
                f = v;
            }
            let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
            let d = (nx - x).hypot(ny - y);
            if fan >= 255.0 && d > 0.0 && word(code, 'E').is_some_and(|e| e > 0.0) && feature.contains("wall")
            {
                let c = out.entry(layer).or_default();
                *c.mm.entry(feature.clone()).or_default() += d;
                if feature == "Outer wall" {
                    c.outer_speed = c.outer_speed.max(f / 60.0);
                }
            }
            (x, y) = (nx, ny);
        }
    }
    out
}

/// Item: leaning walls. The overhang fan runs on a wall move where at least `overhang_fan_threshold` (50% on the
/// stock A1) of the bead hangs past the layer below. At 0.2 mm layers and a 0.42 mm outer wall a 45 degree wall
/// hangs 48% and gets none; 50 degrees hangs 57% and gets it on every layer, and the wall slows to its overhang
/// speed. Walls resting on the wall below never get it.
#[test]
fn walls_leaning_past_half_a_bead_get_the_overhang_fan() {
    let mut cfg = stock("bambu-a1");
    // No fan lead: each raise sits at its wall.
    cfg.insert("pre_start_fan_time".into(), json!([0]));
    for angle in [30.0, 45.0, 50.0, 60.0] {
        let g = slice(&wedge(angle), &cfg);
        let layers = cooled(&g);
        // Layers 22 to 60: the leaning part below its top shells. Layers 2 to 20: the upright wall.
        for l in 2..=20 {
            assert!(
                !layers.contains_key(&l),
                "{angle} degrees, layer {l}: {:?}",
                layers.get(&l)
            );
        }
        for l in 22..=60 {
            let c = layers.get(&l);
            if angle < 50.0 {
                assert!(c.is_none(), "{angle} degrees, layer {l}: {c:?}");
                continue;
            }
            let c = c.unwrap_or_else(|| panic!("{angle} degrees, layer {l}: no overhang fan"));
            // The 29.6 mm leaning side, give or take a piece end at each corner.
            let outer = c.mm.get("Outer wall").copied().unwrap_or(0.0);
            assert!(
                (27.6..=31.6).contains(&outer),
                "{angle} degrees, layer {l}: {c:?}"
            );
            assert_eq!(c.mm.len(), 1, "{angle} degrees, layer {l}: {c:?}");
            // At or under overhang_2_4_speed (50 mm/s).
            assert!(c.outer_speed <= 50.0, "{angle} degrees, layer {l}: {c:?}");
        }
    }
}

/// The part fan values the file sets from its first layer change to its last, in order (`M106` with no fan index
/// or `P1`, and `M107`); auxiliary and chamber fan lines are left out.
fn part_fan_lines(gcode: &str) -> Vec<f64> {
    let lines: Vec<&str> = gcode.lines().collect();
    let changes: Vec<usize> = (0..lines.len())
        .filter(|&i| lines[i].starts_with("; CHANGE_LAYER"))
        .collect();
    let (Some(&first), Some(&last)) = (changes.first(), changes.last()) else {
        return Vec::new();
    };
    lines[first..last]
        .iter()
        .filter_map(|l| {
            let code = l.split(';').next().unwrap_or("").trim();
            if code.starts_with("M107") && !code.contains(" P") {
                return Some(0.0);
            }
            (code.starts_with("M106") && (!code.contains(" P") || code.contains(" P1 ")))
                .then(|| word(code, 'S').unwrap_or(0.0))
        })
        .collect()
}

/// Item: a printer with an auxiliary fan (P1S). Its `M106 P2` line after the layer fan does not make the next
/// layer's repeat of the same part fan value look new, so no part fan line repeats the value already in force.
#[test]
fn an_auxiliary_fan_line_does_not_repeat_the_part_fan() {
    let cfg = stock("bambu-p1s");
    let cube = stl(&loft(&rect(20.0, 20.0, 0.0), &rect(20.0, 20.0, 3.0)));
    let g = slice(&cube, &cfg);
    assert!(
        g.lines().any(|l| l.starts_with("M106 P2 ")),
        "no auxiliary fan line"
    );
    let fans = part_fan_lines(&g);
    assert!(!fans.is_empty(), "no part fan line");
    for w in fans.windows(2) {
        assert!(
            (w[0] - w[1]).abs() > f64::EPSILON,
            "a part fan line repeats {}: {fans:?}",
            w[1]
        );
    }
}

/// Per layer from 1: the time on the cooling model (each move's length over its feed rate, travels and the tool
/// change block included, a purge with no X or Y move by its filament length), whether a tool change comes before
/// the layer's first part extrusion, and the part fan in force at that extrusion.
fn layer_fans(gcode: &str) -> Vec<(usize, f64, bool, f64)> {
    let mut out: Vec<(usize, f64, bool, f64)> = Vec::new();
    let (mut layer, mut feed, mut fan) = (0usize, 0.0f64, 0.0f64);
    let (mut x, mut y, mut z) = (0.0f64, 0.0f64, 0.0f64);
    let (mut t, mut change_first, mut first_fan) = (0.0f64, false, None::<f64>);
    for line in gcode.lines() {
        if line.starts_with("; CHANGE_LAYER") {
            if layer > 0 {
                out.push((layer, t, change_first, first_fan.unwrap_or(-1.0)));
            }
            (layer, t, change_first, first_fan) = (layer + 1, 0.0, false, None);
            continue;
        }
        if let Some(name) = line.strip_prefix("; FEATURE: ")
            && layer > 0
            && first_fan.is_none()
            && !matches!(name.trim(), "Custom" | "Prime tower")
        {
            first_fan = Some(fan);
        }
        let code = line.split(';').next().unwrap_or("").trim();
        if code.starts_with("M620 S") && !code.starts_with("M620 S255") && first_fan.is_none() {
            change_first = true;
        }
        if code.starts_with("M106") && (!code.contains(" P") || code.contains(" P1 ")) {
            fan = word(code, 'S').unwrap_or(0.0);
        }
        if ["G0", "G1", "G2", "G3"]
            .iter()
            .any(|g| code.split_whitespace().next() == Some(g))
        {
            if let Some(f) = word(code, 'F') {
                feed = f / 60.0;
            }
            let (nx, ny, nz) = (
                word(code, 'X').unwrap_or(x),
                word(code, 'Y').unwrap_or(y),
                word(code, 'Z').unwrap_or(z),
            );
            let mut d = (nx - x).hypot(ny - y).hypot(nz - z);
            if d == 0.0 {
                d = word(code, 'E').unwrap_or(0.0).abs();
            }
            if layer > 0 && feed > 0.0 {
                t += d / feed;
            }
            (x, y, z) = (nx, ny, nz);
        }
    }
    out
}

/// Item: a tool change at a layer's start. A layer that prints only filament 1 after a layer that ended on filament
/// 2 opens with the change back. Its fan reads the layer's time with that change block in it, as it does for a
/// change inside the layer: on the stock A1, floor(80 - 20 * (t - 6) / 74) percent between 6 and 80 s.
#[test]
fn a_tool_change_at_the_layer_start_counts_in_the_layer_fan() {
    let mut cfg = stock("bambu-a1");
    for (k, v) in [
        ("pre_start_fan_time", json!([0, 0])),
        ("sparse_infill_filament_id", json!(2)),
        ("enable_prime_tower", json!(true)),
        ("nozzle_temperature", json!([220, 220])),
        ("filament_diameter", json!([1.75, 1.75])),
        ("filament_type", json!(["PLA", "PLA"])),
        ("filament_colour", json!(["#FFFFFF", "#000000"])),
    ] {
        cfg.insert(k.into(), v);
    }
    let mut checked = 0;
    // Two heights, so the top shells start once after a layer that ended on each filament.
    for h in [6.0f32, 6.2] {
        let part = stl(&loft(&rect(20.0, 20.0, 0.0), &rect(20.0, 20.0, h)));
        let layers = layer_fans(&slice(&part, &cfg));
        let last = layers.len();
        for &(l, t, change_first, fan) in &layers {
            if !change_first || l == last || !(6.5..79.0).contains(&t) {
                continue;
            }
            let want = (80.0 - 20.0 * (t - 6.0) / 74.0).floor();
            let got = (fan / 2.55).round();
            assert!(
                (got - want).abs() <= 1.0,
                "{h} mm, layer {l}: {t:.2} s wants {want}%, fan {fan} ({got}%)"
            );
            checked += 1;
        }
    }
    assert!(checked > 0, "no layer opened with a tool change");
}

/// Item: internal bridges on a stock Bambu Lab preset. Its process presets set `internal_bridge_speed` to 100 percent
/// (the maker's app has no such key and prints internal bridges at `bridge_speed`), so a box's first solid layer over
/// sparse infill prints at `bridge_speed`, 50 mm/s on the A1, whichever label the printer's G-code gives it.
#[test]
fn a_stock_bambu_lab_preset_prints_internal_bridges_at_the_bridge_speed() {
    let mut cfg = stock("bambu-a1");
    cfg.insert("pre_start_fan_time".into(), json!([0]));
    let g = slice(&stl(&loft(&rect(20.0, 20.0, 0.0), &rect(20.0, 20.0, 8.0))), &cfg);
    let (mut feature, mut f, mut feeds) = (String::new(), 0.0f64, Vec::new());
    for line in g.lines() {
        if let Some(name) = line.strip_prefix("; FEATURE: ") {
            name.trim().clone_into(&mut feature);
        }
        let code = line.split(';').next().unwrap_or("").trim();
        if code.starts_with("G1") {
            if let Some(v) = word(code, 'F') {
                f = v;
            }
            if feature.ends_with("Bridge")
                && word(code, 'X').is_some()
                && word(code, 'E').is_some_and(|e| e > 0.0)
            {
                feeds.push(f);
            }
        }
    }
    assert!(!feeds.is_empty(), "no internal bridge");
    assert!(feeds.iter().all(|f| *f <= 3000.0 + 0.5), "{feeds:?}");
}

/// Per layer from 1: the speeds (mm/s) of the outer wall moves longer than 20 mm on the leaning (+X) side.
fn leaning_side_speeds(gcode: &str) -> BTreeMap<usize, Vec<f64>> {
    let mut moves: BTreeMap<usize, Vec<(f64, f64)>> = BTreeMap::new();
    let (mut layer, mut feature, mut f) = (0usize, String::new(), 0.0f64);
    let (mut x, mut y) = (0.0f64, 0.0f64);
    for line in gcode.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        if line.starts_with("; CHANGE_LAYER") {
            layer += 1;
        } else if let Some(name) = line.strip_prefix("; FEATURE: ") {
            name.trim().clone_into(&mut feature);
        } else if code.starts_with("G1") || code.starts_with("G0") {
            if let Some(v) = word(code, 'F') {
                f = v;
            }
            let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
            let long = (nx - x).hypot(ny - y) > 20.0 && (nx - x).abs() < 0.5;
            if long && feature == "Outer wall" && word(code, 'E').is_some_and(|e| e > 0.0) {
                moves.entry(layer).or_default().push((nx, f / 60.0));
            }
            (x, y) = (nx, ny);
        }
    }
    moves
        .into_iter()
        .map(|(l, m)| {
            let right = m.iter().map(|p| p.0).fold(f64::MIN, f64::max);
            let speeds = m.iter().filter(|p| p.0 > right - 1.0).map(|p| p.1).collect();
            (l, speeds)
        })
        .collect()
}

/// Item: leaning wall speeds. A wall leaning past the layer below slows by how far its bead's outer edge hangs
/// out, as a share of half of (wall width + 0.4 mm), mapped onto the four overhang speed levels with straight
/// lines between them. On the stock A1 (outer wall 200 mm/s, levels 0, 50, 30, 10, 0.42 mm wall at 0.2 mm
/// layers) a wall leaning 40 degrees prints at 44 mm/s, 45 degrees at 36, 50 degrees at 28, 60 degrees at 10.
#[test]
fn a_leaning_outer_wall_prints_at_the_speed_its_lean_maps_to() {
    let cfg = stock("bambu-a1");
    for (angle, want) in [(40.0, 44.0), (45.0, 36.0), (50.0, 28.0), (60.0, 10.0)] {
        let sides = leaning_side_speeds(&slice(&wedge(angle), &cfg));
        // Layers 22 to 60: the leaning part below its top shells.
        for l in 22..=60 {
            let s = sides
                .get(&l)
                .unwrap_or_else(|| panic!("{angle} degrees, layer {l}: no leaning side"));
            assert!(
                !s.is_empty() && s.iter().all(|v| (v - want).abs() < 0.6),
                "{angle} degrees, layer {l}: {s:?}, want {want}"
            );
        }
    }
}

/// Per layer from 1: the speeds (mm/s) of the overhang wall moves longer than 20 mm on the leaning (+X) side.
fn clear_piece_speeds(gcode: &str) -> BTreeMap<usize, Vec<f64>> {
    let mut out: BTreeMap<usize, Vec<f64>> = BTreeMap::new();
    let (mut layer, mut feature, mut f) = (0usize, String::new(), 0.0f64);
    let (mut x, mut y) = (0.0f64, 0.0f64);
    for line in gcode.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        if line.starts_with("; CHANGE_LAYER") {
            layer += 1;
        } else if let Some(name) = line.strip_prefix("; FEATURE: ") {
            name.trim().clone_into(&mut feature);
        } else if code.starts_with("G1") || code.starts_with("G0") {
            if let Some(v) = word(code, 'F') {
                f = v;
            }
            let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
            let long = (nx - x).hypot(ny - y) > 20.0 && (nx - x).abs() < 0.5;
            if long && feature == "Overhang wall" && word(code, 'E').is_some_and(|e| e > 0.0) {
                out.entry(layer).or_default().push(f / 60.0);
            }
            (x, y) = (nx, ny);
        }
    }
    out
}

/// Item: fully clear wall pieces. A wall piece whose bead hangs fully clear of the layer below prints as an
/// overhang wall at `overhang_totally_speed` (the filament's `filament_overhang_totally_speed` when its
/// `override_process_overhang_speed` is on). With the overhang speeds switched off, or no clear speed set (unset
/// or 0), it prints at `bridge_speed`, which the settings check keeps at 1 mm/s or more, so never at 0.
#[test]
fn a_wall_piece_hanging_fully_clear_prints_at_the_totally_clear_speed() {
    let stock_cfg = stock("bambu-a1");
    let model = wedge(75.0);
    let check = |label: &str, edits: &[(&str, Value)], want: f64| {
        let mut cfg = stock_cfg.clone();
        for (k, v) in edits {
            cfg.insert((*k).to_owned(), v.clone());
        }
        let pieces = clear_piece_speeds(&slice(&model, &cfg));
        // Layers 22 to 60: the leaning part below its top shells, where the outer wall hangs clear.
        for l in 22..=60 {
            let s = pieces
                .get(&l)
                .unwrap_or_else(|| panic!("{label}, layer {l}: no clear piece"));
            assert!(
                s.iter().all(|v| (v - want).abs() < 0.6),
                "{label}, layer {l}: {s:?}, want {want}"
            );
        }
    };
    check("totally 17", &[("overhang_totally_speed", json!(["17"]))], 17.0);
    // Faster than the bridge speed: not held to it.
    check("totally 70", &[("overhang_totally_speed", json!(["70"]))], 70.0);
    check("unset", &[], 50.0);
    check("totally 0", &[("overhang_totally_speed", json!(["0"]))], 50.0);
    check(
        "switch off",
        &[
            ("overhang_totally_speed", json!(["17"])),
            ("enable_overhang_speed", json!(["0"])),
        ],
        50.0,
    );
    check(
        "filament override",
        &[
            ("overhang_totally_speed", json!(["17"])),
            ("override_process_overhang_speed", json!(["1"])),
            ("filament_overhang_totally_speed", json!(["13"])),
        ],
        13.0,
    );
    check(
        "filament override at 0",
        &[
            ("overhang_totally_speed", json!(["17"])),
            ("override_process_overhang_speed", json!(["1"])),
            ("filament_overhang_totally_speed", json!(["0"])),
        ],
        50.0,
    );
    check(
        "filament override off",
        &[
            ("overhang_totally_speed", json!(["17"])),
            ("override_process_overhang_speed", json!(["0"])),
            ("filament_overhang_totally_speed", json!(["13"])),
        ],
        17.0,
    );
}

/// Two 6 mm pillars 20 mm apart under a 2 mm deck: the deck's first layer bridges the gap.
fn table() -> Vec<u8> {
    let block = |x0: f32, x1: f32, z0: f32, z1: f32| {
        let r = |z: f32| vec![[x0, 0.0, z], [x1, 0.0, z], [x1, 30.0, z], [x0, 30.0, z]];
        loft(&r(z0), &r(z1))
    };
    let mut tris = block(0.0, 5.0, 0.0, 6.0);
    tris.extend(block(25.0, 30.0, 0.0, 6.0));
    tris.extend(block(0.0, 30.0, 6.0, 8.0));
    stl(&tris)
}

/// Per extruding move longer than 2 mm of `feature`: the width its `; LINE_WIDTH:` comment states and its
/// filament per mm of path. Bambu Lab G-code extrudes in relative mode.
fn beads(gcode: &str, feature: &str) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let (mut current, mut width) = (String::new(), 0.0f64);
    let (mut x, mut y) = (0.0f64, 0.0f64);
    for line in gcode.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        if let Some(name) = line.strip_prefix("; FEATURE: ") {
            name.trim().clone_into(&mut current);
        } else if let Some(w) = line.strip_prefix("; LINE_WIDTH: ") {
            width = w.trim().parse().unwrap_or(0.0);
        } else if code.starts_with("G1") || code.starts_with("G0") {
            let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
            let len = (nx - x).hypot(ny - y);
            if current == feature
                && len > 2.0
                && let Some(e) = word(code, 'E').filter(|e| *e > 0.0)
            {
                out.push((width, e / len));
            }
            (x, y) = (nx, ny);
        }
    }
    out
}

fn first_number(v: &Value) -> f64 {
    match v {
        Value::Array(a) => first_number(&a[0]),
        Value::String(s) => s.trim().parse().unwrap(),
        other => other.as_f64().unwrap(),
    }
}

/// Item: overhang wall width. On a Bambu Lab printer whose `bridge_line_width` is left at the schema default (as
/// the maker's app, which has no such key, leaves it), a wall piece hanging fully clear prints at
/// `inner_wall_line_width`, whichever loop it belongs to: not the nozzle, not the outer wall's width. The bead is
/// a plain flat one of that width at the layer height, so filament per mm is
/// (h (w - h) + pi h^2 / 4) x `filament_flow_ratio` / filament area. A `bridge_line_width` set by hand keeps the
/// bridge strand. Bridge strands keep their own width and flow either way.
#[test]
fn a_fully_clear_wall_piece_prints_at_the_inner_wall_width() {
    let stock_cfg = stock("bambu-a1");
    let model = wedge(75.0);
    let ratio = first_number(&stock_cfg["filament_flow_ratio"]);
    let filament = std::f64::consts::PI * 1.75 * 1.75 / 4.0;
    let per_mm = |w: f64, h: f64| (h * (w - h) + std::f64::consts::PI * h * h / 4.0) * ratio / filament;
    let with = |edits: &[(&str, Value)]| {
        let mut cfg = stock_cfg.clone();
        for (k, v) in edits {
            cfg.insert((*k).to_owned(), v.clone());
        }
        cfg
    };
    let check = |label: &str, edits: &[(&str, Value)], w: f64, h: f64| {
        let got = beads(&slice(&model, &with(edits)), "Overhang wall");
        assert!(got.len() > 20, "{label}: {} overhang wall moves", got.len());
        let want = per_mm(w, h);
        for (width, e) in &got {
            assert!((width - w).abs() < 5e-4, "{label}: width {width}, want {w}");
            assert!(
                (e / want - 1.0).abs() < 0.005,
                "{label}: {e:.5} filament per mm at width {width}, want {want:.5}"
            );
        }
    };
    // Only the bead changes: against the old strand (a 0.4 mm bridge line set by hand), every wall move keeps its
    // place, and only the overhang walls' E differs. Feeds are left out: the hand-set width also changes the bridges,
    // and with them a layer's time, which the cooling slowdown reads.
    let xmark = std::fs::read(format!("{}/packages/core/bench/models/x-mark.stl", root())).unwrap();
    for (name, part) in [("wedge", &model), ("x-mark", &xmark)] {
        // The walls' moves only: a bridge line width set by hand also sets the bridge strands' width, and with it how
        // many strands a bridge holds and the travels around them.
        let moves = |g: &str| -> Vec<String> {
            let mut wall = false;
            g.lines()
                .filter(|l| {
                    if let Some(f) = l.strip_prefix("; FEATURE: ") {
                        wall = f.trim().ends_with("wall");
                    }
                    wall && ["G1 ", "G2 ", "G3 "].iter().any(|c| l.starts_with(c))
                })
                .map(|l| {
                    l.split_whitespace()
                        .filter(|w| !w.starts_with('E') && !w.starts_with('F'))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .filter(|l| l != "G1")
                .collect()
        };
        let (new, old) = (
            slice(part, &stock_cfg),
            slice(part, &with(&[("bridge_line_width", json!("0.4"))])),
        );
        let (a, b) = (moves(&new), moves(&old));
        assert_eq!(a.len(), b.len(), "{name}: move count");
        if let Some((i, (x, y))) = a.iter().zip(&b).enumerate().find(|(_, (x, y))| x != y) {
            panic!("{name}: move {i} is {x}, was {y}");
        }
        assert!(
            beads(&new, "Overhang wall")
                .iter()
                .all(|(w, _)| (w - 0.45).abs() < 5e-4)
                && beads(&old, "Overhang wall")
                    .iter()
                    .all(|(w, _)| (w - 0.4).abs() < 5e-4),
            "{name}: overhang wall widths"
        );
    }

    // Bridge strands keep their own bead, whatever the inner wall: at least the nozzle wide (wider where a bridge
    // spreads its strands), a flat bead of their width over air (`thick_bridges` off on this preset) or a round
    // thread of it over sparse infill (`thick_internal_bridges` on).
    let bridge = |label: &str, edits: &[(&str, Value)]| {
        let got = beads(&slice(&table(), &with(edits)), "Bridge");
        assert!(got.len() > 10, "{label}: {} bridge moves", got.len());
        for (width, e) in &got {
            let (flat, round) = (
                per_mm(*width, 0.2),
                std::f64::consts::PI * width * width / 4.0 * ratio / filament,
            );
            assert!(*width > 0.4 - 5e-4, "{label} bridge: width {width}");
            assert!(
                (e / flat - 1.0).abs() < 0.005 || (e / round - 1.0).abs() < 0.005,
                "{label} bridge: {e:.5} filament per mm at width {width}, want {flat:.5} or {round:.5}"
            );
        }
    };
    bridge("stock", &[]);
    bridge("inner 0.6", &[("inner_wall_line_width", json!("0.6"))]);

    // Stock A1: outer 0.42, inner 0.45, 0.4 mm nozzle, 0.2 mm layers.
    check("stock", &[], 0.45, 0.2);
    // An inner wall wider than both the outer wall and the nozzle.
    check("inner 0.6", &[("inner_wall_line_width", json!("0.6"))], 0.6, 0.2);
    // A wider outer wall leaves the width at the inner wall's.
    check("outer 0.6", &[("outer_wall_line_width", json!("0.6"))], 0.45, 0.2);
    // An inner wall between the two, on thinner layers.
    check(
        "inner 0.5, 0.12 mm layers",
        &[
            ("inner_wall_line_width", json!("0.5")),
            ("layer_height", json!("0.12")),
        ],
        0.5,
        0.12,
    );
    // A bridge line width set by hand keeps the bridge strand: flat at `bridge_flow` 1.
    check(
        "bridge line 0.35",
        &[("bridge_line_width", json!("0.35"))],
        0.35,
        0.2,
    );
}

/// One extruding overhang wall move longer than 2 mm that runs along Y (the wedge's leaning side): the layer, its
/// X, the width and height its `; LINE_WIDTH:` and `; LAYER_HEIGHT:` comments state, its filament per mm, and the
/// height stated for the next feature after it on the same layer, if any.
#[derive(Debug, Clone, Copy)]
struct ClearMove {
    layer: usize,
    x: f64,
    width: f64,
    height: f64,
    per_mm: f64,
}

fn clear_moves(gcode: &str) -> (Vec<ClearMove>, Vec<f64>) {
    let mut out = Vec::new();
    // The height in force when the first feature after an overhang wall starts.
    let mut after = Vec::new();
    let (mut layer, mut feature, mut width, mut height) = (0usize, String::new(), 0.0f64, 0.0f64);
    let (mut x, mut y) = (0.0f64, 0.0f64);
    for line in gcode.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        if line.starts_with("; CHANGE_LAYER") {
            layer += 1;
        } else if let Some(name) = line.strip_prefix("; FEATURE: ") {
            if feature == "Overhang wall" && name.trim() != "Overhang wall" {
                after.push(f64::NAN);
            }
            name.trim().clone_into(&mut feature);
        } else if let Some(w) = line.strip_prefix("; LINE_WIDTH: ") {
            width = w.trim().parse().unwrap_or(0.0);
        } else if let Some(h) = line.strip_prefix("; LAYER_HEIGHT: ") {
            height = h.trim().parse().unwrap_or(0.0);
        } else if code.starts_with("G1") || code.starts_with("G0") {
            let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
            let len = (nx - x).hypot(ny - y);
            let e = word(code, 'E').filter(|e| *e > 0.0);
            if let Some(last) = after.last_mut()
                && last.is_nan()
                && e.is_some()
            {
                *last = height;
            }
            if feature == "Overhang wall"
                && len > 2.0
                && (nx - x).abs() < 0.5
                && let Some(e) = e
            {
                out.push(ClearMove {
                    layer,
                    x: nx,
                    width,
                    height,
                    per_mm: e / len,
                });
            }
            (x, y) = (nx, ny);
        }
    }
    after.retain(|h| !h.is_nan());
    (out, after)
}

/// Item: overhang wall width with variable-width (arachne) walls. A fully clear piece of the outer loop prints at
/// `outer_wall_line_width`, a piece of an inner loop at `inner_wall_line_width`; each a flat bead of its width at
/// the layer height. Fixed-width walls and aegis keep the inner wall's width on every loop, and a
/// `bridge_line_width` set by hand still wins on every loop.
#[test]
fn arachne_overhang_walls_take_the_width_of_their_loop() {
    let stock_cfg = stock("bambu-a1");
    // At 80 degrees the inner loop hangs fully clear too.
    let model = wedge(80.0);
    let ratio = first_number(&stock_cfg["filament_flow_ratio"]);
    let filament = std::f64::consts::PI * 1.75 * 1.75 / 4.0;
    let per_mm = |w: f64, h: f64| (h * (w - h) + std::f64::consts::PI * h * h / 4.0) * ratio / filament;
    let run = |edits: &[(&str, Value)]| {
        let mut cfg = stock_cfg.clone();
        for (k, v) in edits {
            cfg.insert((*k).to_owned(), v.clone());
        }
        clear_moves(&slice(&model, &cfg)).0
    };
    // Per layer, the moves furthest out in X are the outer loop's; the rest sit a loop or more inside it.
    let split = |moves: &[ClearMove]| -> (Vec<ClearMove>, Vec<ClearMove>) {
        let mut outer_x: BTreeMap<usize, f64> = BTreeMap::new();
        for m in moves {
            let e = outer_x.entry(m.layer).or_insert(f64::MIN);
            *e = e.max(m.x);
        }
        moves.iter().copied().partition(|m| outer_x[&m.layer] - m.x < 0.2)
    };
    let check = |label: &str, moves: &[ClearMove], w: f64| {
        assert!(!moves.is_empty(), "{label}: no moves");
        let want = per_mm(w, 0.2);
        for m in moves {
            assert!(
                (m.width - w).abs() < 5e-4 && (m.height - 0.2).abs() < 5e-4,
                "{label}, layer {}: width {} height {}, want {w} 0.2",
                m.layer,
                m.width,
                m.height
            );
            assert!(
                (m.per_mm / want - 1.0).abs() < 0.005,
                "{label}, layer {}: {:.5} filament per mm, want {want:.5}",
                m.layer,
                m.per_mm
            );
        }
    };

    // Stock A1 (outer 0.42, inner 0.45) with arachne walls.
    let arachne = run(&[("wall_generator", json!("arachne"))]);
    let (outer, inner) = split(&arachne);
    assert!(outer.len() > 20, "{} outer loop moves", outer.len());
    check("arachne, outer loop", &outer, 0.42);
    check("arachne, inner loops", &inner, 0.45);
    // A wider outer wall: the outer loop follows it.
    let wide = run(&[
        ("wall_generator", json!("arachne")),
        ("outer_wall_line_width", json!("0.5")),
    ]);
    check("arachne, outer 0.5, outer loop", &split(&wide).0, 0.5);

    // Fixed-width walls and aegis: the inner wall's width whichever loop.
    check("classic", &run(&[]), 0.45);
    check("aegis", &run(&[("wall_generator", json!("aegis"))]), 0.45);

    // A bridge line width set by hand is kept on every loop, arachne or not.
    for generator in ["arachne", "classic"] {
        check(
            &format!("{generator}, bridge line 0.35"),
            &run(&[
                ("wall_generator", json!(generator)),
                ("bridge_line_width", json!("0.35")),
            ]),
            0.35,
        );
    }
}

/// Item: overhang wall labels at `bridge_flow` above 1. A fully clear piece's bead area is `bridge_flow` x a flat
/// bead of the wall width at the layer height (h). Above 1 the bead is drawn taller, h x `bridge_flow`, and as wide
/// as a flat bead of that area at that height; its `; LINE_WIDTH:` and `; LAYER_HEIGHT:` comments say so, and the
/// next feature's height is back at the layer's. Below 1 the height stays and the width narrows. The filament per mm
/// is `bridge_flow` x the flat bead's either way.
#[test]
fn overhang_wall_comments_state_the_raised_bead_above_a_bridge_flow_of_one() {
    let stock_cfg = stock("bambu-a1");
    let model = wedge(75.0);
    let ratio = first_number(&stock_cfg["filament_flow_ratio"]);
    let filament = std::f64::consts::PI * 1.75 * 1.75 / 4.0;
    let area = |w: f64, h: f64| h * (w - h) + std::f64::consts::PI * h * h / 4.0;
    let check = |f: f64, w: f64, h: f64| {
        let mut cfg = stock_cfg.clone();
        cfg.insert("bridge_flow".into(), json!(f.to_string()));
        let (moves, after) = clear_moves(&slice(&model, &cfg));
        assert!(moves.len() > 20, "bridge flow {f}: {} moves", moves.len());
        let want = f * area(0.45, 0.2) * ratio / filament;
        for m in &moves {
            assert!(
                (m.width - w).abs() < 5e-4 && (m.height - h).abs() < 5e-4,
                "bridge flow {f}, layer {}: width {} height {}, want {w} {h}",
                m.layer,
                m.width,
                m.height
            );
            assert!(
                (m.per_mm / want - 1.0).abs() < 0.005,
                "bridge flow {f}, layer {}: {:.5} filament per mm, want {want:.5}",
                m.layer,
                m.per_mm
            );
        }
        assert!(!after.is_empty(), "bridge flow {f}: nothing after the pieces");
        assert!(
            after.iter().all(|a| (a - 0.2).abs() < 5e-4),
            "bridge flow {f}: heights after the pieces {after:?}"
        );
    };
    // 1.2: 0.24 mm tall, 0.458584 mm wide.
    let (f, h) = (1.2, 0.2);
    let raised = f * h;
    let wide = f * area(0.45, h) / raised + raised * (1.0 - std::f64::consts::FRAC_PI_4);
    assert!((wide - 0.458_584).abs() < 1e-6, "{wide}");
    check(1.2, wide, raised);
    // 0.8: the layer height, 0.368584 mm wide.
    check(0.8, 0.368_584, 0.2);
    check(1.0, 0.45, 0.2);
}

/// One preview segment: feature id, start and end X and Y, width and height in micrometers.
#[derive(Debug, Clone, Copy)]
struct PreviewSeg {
    feature: u8,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    width_um: u16,
    height_um: u16,
}

fn preview_segments(sxpv: &[u8]) -> Vec<PreviewSeg> {
    let info = sx_core::preview::read_info(sxpv).unwrap();
    let f32_at = |at: usize| f32::from_le_bytes(sxpv[at..at + 4].try_into().unwrap());
    let u16_at = |at: usize| u16::from_le_bytes([sxpv[at], sxpv[at + 1]]);
    (0..info.segments)
        .map(|i| {
            let s = info.segments_at + i * sx_core::preview::SEGMENT_BYTES;
            PreviewSeg {
                feature: sxpv[s + 24],
                x0: f32_at(s),
                y0: f32_at(s + 4),
                x1: f32_at(s + 8),
                y1: f32_at(s + 12),
                width_um: u16_at(s + 20),
                height_um: u16_at(s + 22),
            }
        })
        .collect()
}

/// Item: the preview draws an overhang wall bead as the G-code comments state it. Above a `bridge_flow` of 1 a
/// fully clear piece is drawn h x `bridge_flow` tall and as wide as a flat bead of the same area at that height
/// (0.24 mm and 0.459 mm for a 0.45 mm wall, 0.2 mm layers and a flow of 1.2), so the preview segment's width and
/// height match the piece's `; LINE_WIDTH:` and `; LAYER_HEIGHT:`. At a flow of 1 or below the preview keeps the
/// bead's own width and the layer height, and no other feature changes height.
#[test]
fn the_preview_draws_overhang_walls_as_tall_as_the_gcode_states() {
    const OVERHANG_WALL: u8 = 2;
    const CUSTOM: u8 = 14;
    let stock_cfg = stock("bambu-a1");
    let model = wedge(75.0);
    for (f, want) in [(1.2, (459, 240)), (1.0, (450, 200)), (0.8, (369, 200))] {
        let mut cfg = stock_cfg.clone();
        cfg.insert("bridge_flow".into(), json!(f.to_string()));
        let (gcode, sxpv) = slice_with_preview(&model, &cfg);
        let segs = preview_segments(&sxpv);
        // The fully clear pieces: overhang wall segments longer than 2 mm along Y, the wedge's leaning side.
        let clear: Vec<&PreviewSeg> = segs
            .iter()
            .filter(|s| {
                s.feature == OVERHANG_WALL
                    && (s.x1 - s.x0).abs() < 0.5
                    && (s.x1 - s.x0).hypot(s.y1 - s.y0) > 2.0
            })
            .collect();
        assert!(
            clear.len() > 20,
            "bridge flow {f}: {} clear segments",
            clear.len()
        );
        for s in &clear {
            assert_eq!(
                (s.width_um, s.height_um),
                want,
                "bridge flow {f}: clear overhang wall segment {s:?}"
            );
        }
        // The same width and height as the G-code comments of those pieces.
        #[allow(clippy::cast_possible_truncation, reason = "micrometers")]
        let stated: std::collections::BTreeSet<(i64, i64)> = clear_moves(&gcode)
            .0
            .iter()
            .map(|m| {
                (
                    (m.width * 1000.0).round() as i64,
                    (m.height * 1000.0).round() as i64,
                )
            })
            .collect();
        assert_eq!(
            stated,
            std::iter::once((i64::from(want.0), i64::from(want.1))).collect(),
            "bridge flow {f}: G-code comments"
        );
        // Only overhang walls are drawn taller than the layer (the start G-code's purge line draws its own bead).
        let tall: Vec<&PreviewSeg> = segs
            .iter()
            .filter(|s| ![OVERHANG_WALL, CUSTOM].contains(&s.feature) && s.height_um > 200)
            .collect();
        assert!(
            tall.is_empty(),
            "bridge flow {f}: {} other segments taller than the layer: {:?}",
            tall.len(),
            tall.first()
        );
    }
}

/// Item: overhang wall labels with `thick_bridges`. A fully clear piece prints as a round thread the nozzle wide, so
/// its `; LINE_WIDTH:` and its `; LAYER_HEIGHT:` both state the nozzle diameter, whatever the wall widths and the
/// layer height, and the next feature's height is back at the layer's. Its filament per mm is a round thread of the
/// nozzle. A `bridge_line_width` set by hand keeps the layer height in the comments.
#[test]
fn overhang_wall_comments_state_a_round_bead_with_thick_bridges() {
    let stock_cfg = stock("bambu-a1");
    let model = wedge(75.0);
    let ratio = first_number(&stock_cfg["filament_flow_ratio"]);
    let filament = std::f64::consts::PI * 1.75 * 1.75 / 4.0;
    let check = |label: &str, edits: &[(&str, Value)], d: f64, h: f64, stated: f64| {
        let mut cfg = stock_cfg.clone();
        cfg.insert("thick_bridges".into(), json!("1"));
        for (k, v) in edits {
            cfg.insert((*k).to_owned(), v.clone());
        }
        let (moves, after) = clear_moves(&slice(&model, &cfg));
        assert!(moves.len() > 20, "{label}: {} moves", moves.len());
        let want = std::f64::consts::PI * d * d / 4.0 * ratio / filament;
        for m in &moves {
            assert!(
                (m.width - d).abs() < 5e-4 && (m.height - stated).abs() < 5e-4,
                "{label}, layer {}: width {} height {}, want {d} {stated}",
                m.layer,
                m.width,
                m.height
            );
            assert!(
                (m.per_mm / want - 1.0).abs() < 0.005,
                "{label}, layer {}: {:.5} filament per mm, want {want:.5}",
                m.layer,
                m.per_mm
            );
        }
        assert!(!after.is_empty(), "{label}: nothing after the pieces");
        assert!(
            after.iter().all(|a| (a - h).abs() < 5e-4),
            "{label}: heights after the pieces {after:?}"
        );
    };
    // Stock A1: 0.4 mm nozzle, inner walls 0.45, 0.2 mm layers.
    check("stock", &[], 0.4, 0.2, 0.4);
    // The inner wall's width does not enter.
    check(
        "inner 0.6",
        &[("inner_wall_line_width", json!("0.6"))],
        0.4,
        0.2,
        0.4,
    );
    // Nor does the layer height.
    check(
        "0.12 mm layers",
        &[("layer_height", json!("0.12"))],
        0.4,
        0.12,
        0.4,
    );
    // A bridge line width set by hand keeps its strand and the layer height in the comments.
    check(
        "bridge line 0.35",
        &[("bridge_line_width", json!("0.35"))],
        0.35,
        0.2,
        0.2,
    );
}

/// Item: the preview draws a fully clear overhang wall piece with `thick_bridges` as the round thread its G-code
/// comments state: the nozzle wide and the nozzle tall (0.4 mm and 0.4 mm at 0.2 mm layers), and no other feature
/// changes height.
#[test]
fn the_preview_draws_overhang_walls_round_with_thick_bridges() {
    const OVERHANG_WALL: u8 = 2;
    const CUSTOM: u8 = 14;
    let mut cfg = stock("bambu-a1");
    cfg.insert("thick_bridges".into(), json!("1"));
    let (gcode, sxpv) = slice_with_preview(&wedge(75.0), &cfg);
    let segs = preview_segments(&sxpv);
    let clear: Vec<&PreviewSeg> = segs
        .iter()
        .filter(|s| {
            s.feature == OVERHANG_WALL && (s.x1 - s.x0).abs() < 0.5 && (s.x1 - s.x0).hypot(s.y1 - s.y0) > 2.0
        })
        .collect();
    assert!(clear.len() > 20, "{} clear segments", clear.len());
    for s in &clear {
        assert_eq!(
            (s.width_um, s.height_um),
            (400, 400),
            "clear overhang wall segment {s:?}"
        );
    }
    #[allow(clippy::cast_possible_truncation, reason = "micrometers")]
    let stated: std::collections::BTreeSet<(i64, i64)> = clear_moves(&gcode)
        .0
        .iter()
        .map(|m| {
            (
                (m.width * 1000.0).round() as i64,
                (m.height * 1000.0).round() as i64,
            )
        })
        .collect();
    assert_eq!(stated, std::iter::once((400, 400)).collect(), "G-code comments");
    let tall: Vec<&PreviewSeg> = segs
        .iter()
        .filter(|s| ![OVERHANG_WALL, CUSTOM].contains(&s.feature) && s.height_um > 200)
        .collect();
    assert!(
        tall.is_empty(),
        "{} other segments taller than the layer: {:?}",
        tall.len(),
        tall.first()
    );
}
