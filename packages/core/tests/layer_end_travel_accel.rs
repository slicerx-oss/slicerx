// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A bed slinger's timelapse block parks the head off the part between the layer's walls and its infill: a lift,
//! then the template's "move to safe pos" travels. Those moves are travels, so the layer's travel acceleration is
//! set once before the lift (the first layer's travel acceleration on the first layer), and only when it differs
//! from the acceleration in effect. The template's travels inherit it, and no line follows the template. The lift
//! before a tool change on the A1 follows the same rule. What follows a tool change is not asserted, since the change
//! template sets accelerations of its own. The configs are built the way the app builds them: the
//! settings schema's defaults, then the A1's shipped process, filament and printer settings, then its custom G-code.

#![allow(clippy::disallowed_methods)]
// A box's corners and faces read best with short names.
#![allow(clippy::many_single_char_names)]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

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

/// The stock A1 with `changes` on top (null removes a key).
fn a1(changes: &Value) -> Map<String, Value> {
    let mut c = stock("bambu-a1");
    for (k, v) in changes.as_object().unwrap() {
        if v.is_null() {
            c.remove(k);
        } else {
            c.insert(k.clone(), v.clone());
        }
    }
    c
}

/// A closed box `w` x `d` x `h` mm with its corner at the origin, on filament `slot`.
fn box_mesh(w: f32, d: f32, h: f32, slot: u8) -> Arc<Mesh> {
    let mut positions = Vec::new();
    for z in [0.0, h] {
        for (x, y) in [(0.0, 0.0), (w, 0.0), (w, d), (0.0, d)] {
            positions.push([x, y, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    Arc::new(Mesh {
        name: format!("box {slot}"),
        parts: vec![MeshPart {
            name: format!("box {slot}"),
            slot,
            color: None,
            positions,
            triangles,
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
            paint_texts: Vec::new(),
        }],
        ..Mesh::default()
    })
}

/// A 20 mm box 3 mm tall in the middle of the A1's bed, sliced with `config`.
fn slice(config: Map<String, Value>) -> String {
    let m = box_mesh(20.0, 20.0, 3.0, 1);
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "o", "name": "box", "mesh": "m",
                               "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 118, 118, 0, 1]}]},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

fn is_move(code: &str) -> bool {
    ["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|g| code.starts_with(g))
}

fn moves_xy(code: &str) -> bool {
    is_move(code) && (word(code, 'X').is_some() || word(code, 'Y').is_some())
}

fn extrudes(code: &str) -> bool {
    moves_xy(code) && word(code, 'E').is_some_and(|e| e > 0.0)
}

/// A lift: an arc that climbs (the A1's spiral lift) or a straight move up without extrusion.
fn lifts(code: &str) -> bool {
    is_move(code) && word(code, 'Z').is_some() && word(code, 'E').is_none()
}

/// One timelapse block and the acceleration around it.
#[derive(Debug, Default)]
struct Block {
    /// The layer it is in, from 0.
    layer: usize,
    /// The `M204 S` values written between the layer's last extrusion before the block and the block: the wipe's
    /// (inside its block) and then the travel's.
    pre: Vec<i64>,
    /// The acceleration in effect at the lift before the block.
    lift: Option<i64>,
    /// The acceleration in effect at each travel of the template's timelapse part.
    safe: Vec<i64>,
    /// The `M204 S` values the template itself writes.
    inner: Vec<i64>,
    /// The `M204 S` values written after the block, before the next travel.
    post: Vec<i64>,
    /// The acceleration in effect at that travel.
    travel: Option<i64>,
}

/// Every timelapse block of a finished A1 file.
fn blocks(g: &str) -> Vec<Block> {
    #[derive(PartialEq)]
    enum At {
        Layer,
        Block,
        After,
    }
    let mut out: Vec<Block> = Vec::new();
    let mut accel: i64 = 0;
    let mut layer: Option<usize> = None;
    let mut pre: Vec<i64> = Vec::new();
    let mut lift: Option<i64> = None;
    let mut at = At::Layer;
    let mut cur = Block::default();
    let mut in_timelapse = false;
    for line in g.lines() {
        if line.starts_with("; CHANGE_LAYER") {
            layer = Some(layer.map_or(0, |l| l + 1));
        }
        let Some(layer) = layer else { continue };
        let code = line.split(';').next().unwrap_or("").trim();
        let set = code
            .strip_prefix("M204 S")
            .and_then(|v| v.split_whitespace().next())
            .and_then(|v| v.parse::<i64>().ok());
        match at {
            At::Layer => {
                if line.starts_with("; SKIPPABLE_START") {
                    cur = Block {
                        layer,
                        pre: std::mem::take(&mut pre),
                        lift: lift.take(),
                        ..Block::default()
                    };
                    at = At::Block;
                    in_timelapse = false;
                } else if extrudes(code) {
                    pre.clear();
                    lift = None;
                } else if let Some(v) = set {
                    pre.push(v);
                } else if lifts(code) {
                    lift = Some(accel);
                }
            }
            At::Block => {
                if line.starts_with("; SKIPTYPE:") {
                    in_timelapse = line.contains("timelapse");
                } else if line.starts_with("; SKIPPABLE_END") {
                    at = At::After;
                } else if let Some(v) = set {
                    cur.inner.push(v);
                } else if in_timelapse && moves_xy(code) && word(code, 'E').is_none() {
                    cur.safe.push(accel);
                }
            }
            At::After => {
                if let Some(v) = set {
                    cur.post.push(v);
                } else if moves_xy(code) {
                    cur.travel = Some(accel);
                    out.push(std::mem::take(&mut cur));
                    at = At::Layer;
                    pre.clear();
                    lift = None;
                }
            }
        }
        if let Some(v) = set {
            accel = v;
        }
    }
    out
}

/// The acceleration a layer's travels run at: the first layer's, then the travel acceleration.
fn travel_of(layer: usize, first: i64, rest: i64) -> i64 {
    if layer == 0 { first } else { rest }
}

/// Every block: the travel acceleration is in effect at the lift, at the template's travels and (with `after`) at
/// the travel after the block. It is written once before the lift when the acceleration in effect differs, and never
/// after the block. The wipe before the lift may write its own line first (the layer's wipe acceleration), so the
/// travel's line is written when it differs from the wipe's.
fn check_blocks_with(g: &str, first: i64, rest: i64, after: bool) -> Vec<Block> {
    let all = blocks(g);
    assert!(!all.is_empty(), "no timelapse block");
    for b in &all {
        let want = travel_of(b.layer, first, rest);
        assert_eq!(b.lift, Some(want), "lift acceleration: {b:?}");
        assert_eq!(b.safe.len(), 3, "three safe position travels: {b:?}");
        assert!(b.safe.iter().all(|&a| a == want), "safe position travels: {b:?}");
        assert!(
            b.pre.len() <= 2,
            "at most the wipe's line and the travel's before the lift: {b:?}"
        );
        assert!(
            b.pre.last().is_none_or(|&a| a == want),
            "the line before the lift: {b:?}"
        );
        assert!(
            b.pre.len() < 2 || b.pre.first() != Some(&want),
            "the wipe's line, then the travel's: {b:?}"
        );
        if !after {
            continue;
        }
        // The template's own acceleration lines (the head wrap check from the third layer on) are not followed by a
        // restore: the travel after the block runs at what the template left.
        assert!(b.post.is_empty(), "nothing after the template: {b:?}");
        assert_eq!(
            b.travel,
            Some(b.inner.last().copied().unwrap_or(want)),
            "the travel after the block: {b:?}"
        );
    }
    all
}

fn check_blocks(g: &str, first: i64, rest: i64) -> Vec<Block> {
    check_blocks_with(g, first, rest, true)
}

/// First layer travel acceleration 6000, travel acceleration 10000.
#[test]
fn stock_a1_sets_the_travel_acceleration_before_the_lift() {
    let g = slice(a1(&json!({})));
    let all = check_blocks(&g, 6000, 10000);
    // The first layer prints and wipes at 500, so its block writes the travel's line alone. The later walls print at
    // 5000 and wipe at the default 6000, so each later block writes the wipe's line, then the travel's.
    for b in &all {
        let want = if b.layer == 0 {
            vec![6000]
        } else {
            vec![6000, 10000]
        };
        assert_eq!(b.pre, want, "{b:?}");
    }
    let first = all.iter().find(|b| b.layer == 0).unwrap();
    assert!(first.post.is_empty(), "{first:?}");
    let second = all.iter().find(|b| b.layer == 1).unwrap();
    assert!(second.post.is_empty(), "{second:?}");
    // The third layer's template runs the head wrap check at its own 5000, and no line follows it.
    let third = all.iter().find(|b| b.layer == 2).unwrap();
    assert_eq!(third.inner, vec![5000], "{third:?}");
    assert!(third.post.is_empty(), "{third:?}");
}

/// A first layer travel acceleration equal to the first layer's (500, what a project without the key
/// reads as) writes nothing on the first layer.
#[test]
fn first_layer_at_its_own_acceleration_writes_nothing() {
    let g = slice(a1(&json!({"initial_layer_travel_acceleration": ["500"]})));
    let all = check_blocks(&g, 500, 10000);
    let first = all.iter().find(|b| b.layer == 0).unwrap();
    assert!(first.pre.is_empty() && first.post.is_empty(), "{first:?}");
}

/// The values follow the settings.
#[test]
fn the_values_follow_the_settings() {
    let g = slice(a1(
        &json!({"initial_layer_travel_acceleration": ["3000"], "travel_acceleration": [8000]}),
    ));
    let all = check_blocks(&g, 3000, 8000);
    assert!(all.iter().any(|b| b.layer == 0 && b.pre == vec![3000]));
    assert!(all.iter().any(|b| b.layer == 1 && b.pre == vec![6000, 8000]));
}

/// Every acceleration 3000 writes no line around the blocks.
#[test]
fn equal_accelerations_write_no_line() {
    let keys = [
        "default_acceleration",
        "initial_layer_acceleration",
        "initial_layer_travel_acceleration",
        "travel_acceleration",
        "outer_wall_acceleration",
        "inner_wall_acceleration",
        "top_surface_acceleration",
        "sparse_infill_acceleration",
    ];
    let changes: Map<String, Value> = keys.iter().map(|k| ((*k).to_owned(), json!([3000]))).collect();
    let g = slice(a1(&Value::Object(changes)));
    for b in check_blocks(&g, 3000, 3000) {
        assert!(b.pre.is_empty(), "{b:?}");
    }
}

/// First layer and first layer travel acceleration both 2000: no line on the first layer.
#[test]
fn first_layer_equal_accelerations_write_no_line() {
    let g = slice(a1(
        &json!({"initial_layer_acceleration": [2000], "initial_layer_travel_acceleration": ["2000"]}),
    ));
    let all = check_blocks(&g, 2000, 10000);
    let first = all.iter().find(|b| b.layer == 0).unwrap();
    assert!(first.pre.is_empty() && first.post.is_empty(), "{first:?}");
}

/// A travel acceleration equal to the outer wall's: the wipe after the outer wall runs at the default 6000, so the
/// travel's line follows it before the lift, and none comes after the template.
#[test]
fn travel_equal_to_the_outer_wall_writes_no_line() {
    let g = slice(a1(&json!({"travel_acceleration": [5000]})));
    for b in check_blocks(&g, 6000, 5000) {
        if b.layer > 0 {
            assert_eq!(b.pre, vec![6000, 5000], "{b:?}");
        }
    }
}

/// Without a lift (`z_hop` 0) no travel line is written before the block, only the wipe's own line (6000 on the
/// later layers, after walls at 5000); the travel after it sets the travel acceleration as before.
#[test]
fn no_lift_no_line_before_the_block() {
    let g = slice(a1(&json!({"z_hop": [0]})));
    let all = blocks(&g);
    assert!(!all.is_empty());
    for b in &all {
        let wipe = if b.layer == 0 { vec![] } else { vec![6000] };
        assert_eq!(b.pre, wipe, "{b:?}");
        let want = travel_of(b.layer, 6000, 10000);
        assert_eq!(b.travel, Some(want), "{b:?}");
    }
    let first = all.iter().find(|b| b.layer == 0).unwrap();
    assert_eq!(first.safe, vec![500, 500, 500], "{first:?}");
    assert_eq!(first.post, vec![6000], "{first:?}");
}

/// With wipe off the line still goes before the lift.
#[test]
fn wipe_off_keeps_the_line_before_the_lift() {
    let g = slice(a1(&json!({"wipe": [false]})));
    check_blocks(&g, 6000, 10000);
}

/// The smooth timelapse type writes what the traditional one does (no tower layout yet).
#[test]
fn smooth_timelapse_matches_traditional() {
    // The settings block at the end of the file names the type; everything else is the same.
    let moves = |g: &str| -> Vec<String> {
        g.lines()
            .filter(|l| !l.contains("timelapse_type"))
            .map(str::to_owned)
            .collect()
    };
    let smooth = slice(a1(&json!({"timelapse_type": "1"})));
    check_blocks(&smooth, 6000, 10000);
    assert_eq!(moves(&smooth), moves(&slice(a1(&json!({})))));
}

/// Two filaments. The lift before each tool change runs at the layer's travel acceleration. Lines after the
/// change template or a timelapse block are not asserted: the change template sets accelerations of its own, and the
/// lines before a prime tower's first travel belong to the tower layout.
#[test]
fn tool_change_lift_runs_at_the_travel_acceleration() {
    let mut config = a1(&json!({}));
    let multi = read("packages/core/cli/tests/fixtures/xmark-2color-a1-request.json")["config"].clone();
    for (k, v) in multi.as_object().unwrap() {
        if matches!(v, Value::Array(a) if a.len() == 2) || k.starts_with("flush_") {
            config.insert(k.clone(), v.clone());
        }
    }
    let meshes = [box_mesh(15.0, 15.0, 2.0, 1), box_mesh(15.0, 15.0, 2.0, 2)];
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "a", "name": "a", "mesh": "a", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 110, 0, 1]},
            {"id": "b", "name": "b", "mesh": "b", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 140, 110, 0, 1]},
        ]},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |id: &str| {
        Ok(if id == "a" {
            meshes[0].clone()
        } else {
            meshes[1].clone()
        })
    })
    .unwrap();
    let g = String::from_utf8(r.gcode).unwrap();
    // A block before the tower goes straight on into the change, so only the lift and the template are checked.
    check_blocks_with(&g, 6000, 10000, false);
    // Each change in the print: the acceleration at the lift of its own before its template.
    let lines: Vec<&str> = g.lines().collect();
    let start = lines
        .iter()
        .position(|l| l.starts_with("; CHANGE_LAYER"))
        .unwrap();
    let mut layer = 0usize;
    let mut accel = 0i64;
    let mut last_lift: Option<i64> = None;
    let (mut changes, mut lifted) = (0, 0);
    let mut i = start;
    while i < lines.len() {
        let line = lines[i];
        if line.starts_with("; CHANGE_LAYER") && i > start {
            layer += 1;
        }
        let code = line.split(';').next().unwrap_or("").trim();
        // A change after a timelapse block makes no lift of its own: the block's came before the template.
        if extrudes(code) || line.starts_with("; SKIPPABLE_START") {
            last_lift = None;
        } else if (code.starts_with("G2 ") || code.starts_with("G3 ")) && word(code, 'Z').is_some() {
            last_lift = Some(accel);
        }
        if let Some(v) = code.strip_prefix("M204 S").and_then(|v| v.parse::<i64>().ok()) {
            accel = v;
        }
        if code.starts_with("M620 S") && code.ends_with('A') && !code.starts_with("M620 S255") {
            changes += 1;
            let want = travel_of(layer, 6000, 10000);
            if let Some(at_lift) = last_lift {
                lifted += 1;
                assert_eq!(at_lift, want, "the lift before the change at line {}", i + 1);
            }
        }
        i += 1;
    }
    assert!(
        changes > 0 && lifted > 0,
        "{changes} changes, {lifted} with a lift of their own"
    );
}
