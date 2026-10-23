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
    String::from_utf8(r.gcode).unwrap()
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
