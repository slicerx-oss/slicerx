// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Every wipe runs at the acceleration of the layer it belongs to, whatever path it follows: the first layer's
//! (`initial_layer_acceleration`) on the first layer, `default_acceleration` after it. A layer change's wipe follows
//! the layer below's last path and belongs to that layer. The wipe's line goes inside the wipe block, after its feed
//! rate, and only when the value differs from the one in effect. After the wipe and its last retraction, the travel
//! acceleration is written when it differs from the wipe's, before the lift or the travel. Wipe off changes nothing.
//! The configs are built the way the app builds them: the settings schema's defaults, then the printer's shipped
//! process, filament and printer settings, then its custom G-code.

#![allow(clippy::disallowed_methods)]
// A mesh's corners and faces read best with short names.
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

/// The stock printer with `changes` on top. A number or a flag fills every entry of the key's list (a printer with
/// two extruders keeps one value per extruder); any other value replaces the key.
fn printer(model: &str, changes: &Value) -> Map<String, Value> {
    let mut c = stock(model);
    for (k, v) in changes.as_object().unwrap() {
        let value = match (c.get(k), v) {
            (Some(Value::Array(list)), Value::Number(_) | Value::Bool(_)) => {
                Value::Array(vec![v.clone(); list.len().max(1)])
            }
            (_, Value::Number(_) | Value::Bool(_)) => json!([v]),
            _ => v.clone(),
        };
        c.insert(k.clone(), value);
    }
    c
}

fn a1(changes: &Value) -> Map<String, Value> {
    printer("bambu-a1", changes)
}

/// The A1 values the spec measures with: each feature at an acceleration of its own.
fn distinct() -> Value {
    json!({
        "default_acceleration": 4000,
        "initial_layer_acceleration": 800,
        "outer_wall_acceleration": 3500,
        "inner_wall_acceleration": 2500,
        "top_surface_acceleration": 1500,
        "sparse_infill_acceleration": 3000,
        "travel_acceleration": 10000,
        "initial_layer_travel_acceleration": "6000",
    })
}

/// `distinct` with `more` on top.
fn distinct_with(more: &Value) -> Map<String, Value> {
    let mut v = distinct();
    for (k, x) in more.as_object().unwrap() {
        v[k] = x.clone();
    }
    a1(&v)
}

/// A closed mesh from its corners and triangles, on filament 1.
fn mesh(positions: Vec<[f32; 3]>, triangles: Vec<[u32; 3]>) -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "part".into(),
        parts: vec![MeshPart {
            name: "part".into(),
            slot: 1,
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

/// A closed box `w` x `d` x `h` mm with its corner at the origin.
fn box_mesh(w: f32, d: f32, h: f32) -> Arc<Mesh> {
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
    mesh(positions, triangles)
}

/// A 20 x 20 mm block, 4 mm tall on its left half and 2 mm on its right: the low half's top surface is printed in the
/// middle of the print.
fn step_mesh() -> Arc<Mesh> {
    // The profile in X and Z, counterclockwise seen from -Y, pulled along Y from 0 to 20.
    let profile = [
        (0.0, 0.0),
        (20.0, 0.0),
        (20.0, 2.0),
        (10.0, 2.0),
        (10.0, 4.0),
        (0.0, 4.0),
    ];
    let mut positions = Vec::new();
    for y in [0.0, 20.0] {
        for (x, z) in profile {
            positions.push([x, y, z]);
        }
    }
    // The front cap (y 0) faces -Y, the back cap (y 20, corners 6 to 11) faces +Y.
    let cap = [[0u32, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]];
    let mut triangles: Vec<[u32; 3]> = cap.to_vec();
    triangles.extend(cap.iter().map(|t| [t[0] + 6, t[2] + 6, t[1] + 6]));
    for k in 0..6u32 {
        let n = (k + 1) % 6;
        triangles.push([k, 6 + n, n]);
        triangles.push([k, 6 + k, 6 + n]);
    }
    mesh(positions, triangles)
}

fn table_mesh() -> Arc<Mesh> {
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/table.stl", root())).unwrap();
    Arc::new(api::load_mesh(&bytes, "table.stl").unwrap())
}

/// `parts` placed on the plate (each at its X and Y), sliced with `config`.
fn slice_parts(config: Map<String, Value>, parts: Vec<(Arc<Mesh>, f32, f32)>) -> String {
    let objects: Vec<Value> = parts
        .iter()
        .enumerate()
        .map(|(i, (_, x, y))| {
            json!({"id": format!("o{i}"), "name": format!("part {i}"), "mesh": format!("m{i}"),
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let meshes: Vec<Arc<Mesh>> = parts.into_iter().map(|p| p.0).collect();
    let r = api::run_request(&req, &move |id: &str| {
        let i: usize = id.trim_start_matches('m').parse().unwrap();
        Ok(meshes[i].clone())
    })
    .unwrap();
    String::from_utf8(r.gcode).unwrap()
}

/// Two 12 mm boxes 3 mm tall, 30 mm apart: every layer travels between them, so it wipes inside the layer.
fn two_boxes(config: Map<String, Value>) -> String {
    slice_parts(
        config,
        vec![
            (box_mesh(12.0, 12.0, 3.0), 100.0, 110.0),
            (box_mesh(12.0, 12.0, 3.0), 142.0, 110.0),
        ],
    )
}

fn table(config: Map<String, Value>) -> String {
    slice_parts(config, vec![(table_mesh(), 128.0, 128.0)])
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

fn moves_z(code: &str) -> bool {
    is_move(code) && word(code, 'Z').is_some()
}

fn marker(line: &str, name: &str) -> bool {
    line.trim_start_matches(';').trim() == name
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// The layer change's wipe along the layer below's last path.
    LayerEnd,
    InLayer,
    /// The print's closing wipe.
    Last,
}

/// One wipe and the acceleration lines around it.
#[derive(Debug, Clone)]
struct Wipe {
    /// The layer it belongs to, from 0: the layer whose path it follows.
    layer: usize,
    kind: Kind,
    /// The feature of the last extrusion before it.
    after: String,
    /// The acceleration that extrusion ran at.
    extrusion: i64,
    /// The acceleration in effect where the wipe starts (custom G-code after the extrusion may have set its own).
    effect: i64,
    /// `M204 S` values between that extrusion (or the custom G-code block after it) and the wipe's start.
    before: Vec<i64>,
    /// `M204 S` values inside the wipe block, and whether each sat right after the block's feed rate.
    inside: Vec<(i64, bool)>,
    /// The acceleration in effect at each wipe move.
    moves: Vec<i64>,
    /// `M204 S` values after the wipe's end, up to the next move that lifts or travels.
    post: Vec<i64>,
    /// The acceleration in effect at that move, and whether it lifts (an arc that climbs).
    next: Option<(i64, bool)>,
    /// The acceleration in effect at a move straight up or down before it.
    z: Option<i64>,
}

/// Every wipe of a finished file.
fn wipes(g: &str) -> Vec<Wipe> {
    let mut out: Vec<Wipe> = Vec::new();
    let mut accel: i64 = 0;
    let mut layer: Option<usize> = None;
    let mut feature = String::new();
    let mut last_feature = String::new();
    let mut extrusion: i64 = 0;
    let mut before: Vec<i64> = Vec::new();
    // Whether the layer has extruded since its change marker.
    let mut extruded_here = false;
    // The wipe being read, and whether its block is still open.
    let mut cur: Option<Wipe> = None;
    let mut open = false;
    let mut block_line = 0usize;
    for line in g.lines() {
        if line.starts_with("; CHANGE_LAYER") {
            layer = Some(layer.map_or(0, |l| l + 1));
            extruded_here = false;
        }
        if let Some(f) = line.strip_prefix("; FEATURE: ") {
            f.trim().clone_into(&mut feature);
        }
        let Some(layer) = layer else { continue };
        let code = line.split(';').next().unwrap_or("").trim();
        let set = code
            .strip_prefix("M204 S")
            .and_then(|v| v.split_whitespace().next())
            .and_then(|v| v.parse::<i64>().ok());
        if open {
            let w = cur.as_mut().unwrap();
            if marker(line, "WIPE_END") {
                open = false;
            } else if let Some(v) = set {
                // The block's first line sets its feed rate.
                w.inside.push((v, block_line == 1));
            } else if moves_xy(code) {
                w.moves.push(accel);
            }
            block_line += 1;
        } else if marker(line, "WIPE_START") {
            out.extend(cur.take());
            let kind = if extruded_here {
                Kind::InLayer
            } else {
                Kind::LayerEnd
            };
            cur = Some(Wipe {
                layer: if kind == Kind::LayerEnd {
                    layer.saturating_sub(1)
                } else {
                    layer
                },
                kind,
                after: last_feature.clone(),
                extrusion,
                effect: accel,
                before: std::mem::take(&mut before),
                inside: Vec::new(),
                moves: Vec::new(),
                post: Vec::new(),
                next: None,
                z: None,
            });
            open = true;
            block_line = 0;
        } else if let Some(w) = cur.as_mut() {
            // After the wipe: the lines up to the next lift or travel.
            if let Some(v) = set {
                w.post.push(v);
            } else if line.starts_with("; SKIPPABLE_START") {
                // A custom G-code block with no lift of ours before it: its moves are its own.
                out.extend(cur.take());
            } else if moves_z(code) && !moves_xy(code) {
                // A lift straight up, or the move to the new layer's height.
                w.z.get_or_insert(accel);
            } else if moves_xy(code) {
                w.next = Some((accel, moves_z(code)));
                out.extend(cur.take());
            }
        } else if extrudes(code) {
            before.clear();
            extruded_here = true;
            last_feature.clone_from(&feature);
            extrusion = accel;
        } else if line.starts_with("; SKIPPABLE_END") {
            // A custom G-code block's own lines and the travel line before it are not the wipe's.
            before.clear();
        } else if let Some(v) = set {
            before.push(v);
        }
        if let Some(v) = set {
            accel = v;
        }
    }
    out.extend(cur.take());
    // The print's closing wipe: no extrusion after it.
    if let Some(at) = g.rfind("WIPE_END")
        && !g[at..]
            .lines()
            .any(|l| extrudes(l.split(';').next().unwrap_or("").trim()))
        && let Some(w) = out.last_mut()
    {
        w.kind = Kind::Last;
    }
    out
}

/// Features a bed slinger's timelapse block goes before: a layer that ends with one has its block inside it.
fn infill_like(f: &str) -> bool {
    [
        "Sparse infill",
        "Internal solid infill",
        "Top surface",
        "Bottom surface",
        "Bridge",
        "Internal Bridge",
        "Ironing",
        "Floating vertical shell",
        "Prime tower",
    ]
    .contains(&f)
}

/// The acceleration every wipe of `layer` runs at.
fn rule(layer: usize, first: i64, rest: i64) -> i64 {
    if layer == 0 { first } else { rest }
}

/// Every wipe runs at the layer's value, its line (if any) sits inside the block right after its feed rate and is
/// written only when it differs from the extrusion's, and nothing is written between the extrusion and the block.
fn check_wipes(g: &str, first: i64, rest: i64) -> Vec<Wipe> {
    let all = wipes(g);
    assert!(!all.is_empty(), "no wipe");
    for w in &all {
        let want = rule(w.layer, first, rest);
        assert!(!w.moves.is_empty(), "a wipe with no move: {w:?}");
        assert!(w.moves.iter().all(|&a| a == want), "wipe moves at {want}: {w:?}");
        assert!(
            w.before.is_empty(),
            "nothing between the extrusion and the wipe: {w:?}"
        );
        // A layer change's wipe after a layer that may have ended with its timelapse block (no infill to put it before)
        // cannot know what the block left in effect, so it writes its line.
        let unsure = w.kind == Kind::LayerEnd && !infill_like(&w.after);
        if w.effect == want && !(unsure && w.inside == vec![(want, true)]) {
            assert!(w.inside.is_empty(), "no line when the value is in effect: {w:?}");
        } else if w.effect != want {
            assert_eq!(
                w.inside,
                vec![(want, true)],
                "one line after the feed rate: {w:?}"
            );
        }
    }
    all
}

/// After each wipe that is followed by a lift or a travel: at most one line, the travel's, only when it differs from
/// the wipe's, and the move runs at it. With `lifts`, a move straight up before the travel runs at it too.
fn check_after(
    all: &[Wipe],
    lifts: bool,
    (travel_first, travel): (i64, i64),
    (wipe_first, wipe): (i64, i64),
) {
    for w in all.iter().filter(|w| w.kind != Kind::Last) {
        let Some((at, _)) = w.next else { continue };
        let owed = match w.kind {
            // The lift after a layer change's wipe belongs to the new layer.
            Kind::LayerEnd => travel,
            _ => rule(w.layer, travel_first, travel),
        };
        let wiped = rule(w.layer, wipe_first, wipe);
        if owed == wiped {
            assert!(w.post.is_empty(), "no line after the wipe: {w:?}");
        } else {
            assert_eq!(w.post, vec![owed], "the travel's line after the wipe: {w:?}");
        }
        assert_eq!(at, owed, "the move after the wipe: {w:?}");
        if lifts && let Some(z) = w.z {
            assert_eq!(z, owed, "the lift after the wipe: {w:?}");
        }
    }
}

/// The features the wipes of `all` on layers 2 and up follow.
fn followed(all: &[Wipe]) -> Vec<String> {
    let mut f: Vec<String> = all
        .iter()
        .filter(|w| w.layer > 0)
        .map(|w| w.after.clone())
        .collect();
    f.sort();
    f.dedup();
    f
}

/// Spec 6.1: on layers 2 and up every wipe runs at the default acceleration, whatever feature it follows.
#[test]
fn later_layer_wipes_run_at_the_default_acceleration() {
    let g = table(a1(&distinct()));
    let all = check_wipes(&g, 800, 4000);
    let seen = followed(&all);
    for f in ["Outer wall", "Sparse infill", "Top surface"] {
        assert!(seen.iter().any(|s| s == f), "no wipe after {f}: {seen:?}");
    }
    // The ones that followed a feature at another acceleration wrote their line.
    assert!(
        all.iter()
            .any(|w| w.layer > 0 && w.extrusion == 3000 && w.inside == vec![(4000, true)])
    );
    assert!(
        all.iter()
            .any(|w| w.layer > 0 && w.extrusion == 3500 && w.inside == vec![(4000, true)])
    );
}

/// Spec 6.2 and 6.3: on the first layer, wipes inside the layer and the layer change's wipe run at the first layer's
/// acceleration.
#[test]
fn first_layer_wipes_run_at_the_first_layer_acceleration() {
    let g = two_boxes(a1(&distinct()));
    let all = check_wipes(&g, 800, 4000);
    assert!(
        all.iter().any(|w| w.layer == 0 && w.kind == Kind::InLayer),
        "{all:?}"
    );
    assert!(
        all.iter().any(|w| w.layer == 0 && w.kind == Kind::LayerEnd),
        "{all:?}"
    );
}

/// Spec 6.4: a first layer acceleration above the default still sets the first layer's wipes.
#[test]
fn first_layer_acceleration_above_the_default() {
    let g = two_boxes(distinct_with(&json!({"initial_layer_acceleration": 7000})));
    let all = check_wipes(&g, 7000, 4000);
    assert!(all.iter().any(|w| w.layer == 0 && w.kind == Kind::InLayer));
    assert!(all.iter().any(|w| w.layer > 0));
}

/// Spec 6.5: the wipe's line goes inside the block, the travel's after the wipe, and nothing before the block, with
/// or without a lift.
#[test]
fn line_order_around_a_wipe() {
    let g = two_boxes(a1(&distinct()));
    let all = check_wipes(&g, 800, 4000);
    check_after(&all, true, (6000, 10000), (800, 4000));
    // The travels between the boxes: a line inside the wipe, then the travel's line after it.
    assert!(
        all.iter()
            .any(|w| w.layer > 0 && w.kind == Kind::InLayer && w.post == vec![10000]),
        "{all:?}"
    );
    let flat = two_boxes(distinct_with(&json!({"z_hop": 0})));
    let all = check_wipes(&flat, 800, 4000);
    check_after(&all, false, (6000, 10000), (800, 4000));
    assert!(
        all.iter()
            .any(|w| w.layer > 0 && w.kind == Kind::InLayer && w.next.is_some_and(|n| !n.1))
    );
}

/// Spec 6.6: a default equal to the outer wall's writes no line in a wipe after the outer wall, and one in a wipe
/// after sparse infill.
#[test]
fn default_equal_to_the_outer_wall() {
    let g = table(distinct_with(&json!({"default_acceleration": 3500})));
    let all = check_wipes(&g, 800, 3500);
    assert!(
        all.iter()
            .any(|w| w.layer > 0 && w.after == "Outer wall" && w.inside.is_empty())
    );
    assert!(
        all.iter()
            .any(|w| w.layer > 0 && w.after == "Sparse infill" && w.inside == vec![(3500, true)])
    );
}

/// Spec 6.7: a default equal to the travel acceleration writes no line after the wipe, and the travel runs at the
/// wipe's value. The A1's head wrap check sets its own acceleration from the third layer on; the wipes after it still
/// run at the default.
#[test]
fn default_equal_to_the_travel_acceleration() {
    for more in [
        json!({"default_acceleration": 10000}),
        json!({"default_acceleration": 10000, "sparse_infill_acceleration": "100%"}),
    ] {
        let g = two_boxes(distinct_with(&more));
        let all = check_wipes(&g, 800, 10000);
        check_after(&all, true, (6000, 10000), (800, 10000));
        assert!(all.iter().any(|w| w.layer > 1 && w.post.is_empty()));
    }
}

/// Spec 6.8: with `inner_wall_acceleration` 0 the inner wall runs at the default, so a wipe after it writes no line.
#[test]
fn inner_wall_at_the_default() {
    let g = two_boxes(distinct_with(
        &json!({"inner_wall_acceleration": 0, "wall_sequence": "outer wall/inner wall", "sparse_infill_density": "0%"}),
    ));
    let all = check_wipes(&g, 800, 4000);
    // A layer change's wipe after a layer with no infill follows the timelapse block that ends that layer, which set
    // the travel acceleration (spec 3.1, inner wall last): only the wipes inside a layer follow the inner wall itself.
    let inner: Vec<&Wipe> = all
        .iter()
        .filter(|w| w.layer > 0 && w.kind == Kind::InLayer && w.after == "Inner wall")
        .collect();
    assert!(!inner.is_empty(), "{all:?}");
    for w in inner {
        assert!(w.inside.is_empty(), "{w:?}");
    }
}

/// Spec 6.9: a layer change's wipe, then the travel acceleration before the lift, and nothing after the timelapse
/// template. With the default equal to the travel acceleration, no line before the lift.
#[test]
fn layer_change_wipe_then_the_travel_line_before_the_lift() {
    let g = two_boxes(a1(&distinct()));
    let all = check_wipes(&g, 800, 4000);
    let ends: Vec<&Wipe> = all.iter().filter(|w| w.kind == Kind::LayerEnd).collect();
    assert!(ends.len() > 2);
    // The lift (an arc that climbs, or a move straight up) and the travel after it run at the travel acceleration.
    let lifted_at = |w: &Wipe| w.next.filter(|n| n.1).map(|n| n.0).or(w.z);
    for w in &ends {
        assert_eq!(w.post, vec![10000], "{w:?}");
        assert_eq!(lifted_at(w), Some(10000), "{w:?}");
        assert_eq!(w.next.map(|n| n.0), Some(10000), "{w:?}");
    }
    let g = two_boxes(distinct_with(&json!({"default_acceleration": 10000})));
    for w in check_wipes(&g, 800, 10000)
        .iter()
        .filter(|w| w.kind == Kind::LayerEnd && w.layer > 0)
    {
        assert!(w.post.is_empty(), "{w:?}");
        assert_eq!(lifted_at(w), Some(10000), "{w:?}");
    }
}

/// Spec 6.10: without a lift the wipes run at the same values.
#[test]
fn no_lift_same_wipe_values() {
    let g = table(distinct_with(&json!({"z_hop": 0})));
    let all = check_wipes(&g, 800, 4000);
    assert!(all.iter().any(|w| w.layer == 0) && all.iter().any(|w| w.layer > 0));
}

/// Spec 6.11: with wipe off there is no wipe and no default line: each default line is followed by an extrusion.
#[test]
fn wipe_off_writes_no_wipe_line() {
    for model in [
        "bambu-a1",
        "bambu-a1-mini",
        "bambu-p1s",
        "bambu-x1-carbon",
        "bambu-h2d",
        "bambu-x2d",
    ] {
        // A filament's own wipe setting overrides the printer's.
        let config = printer(
            model,
            &json!({"default_acceleration": 4000, "wipe": false, "filament_wipe": false}),
        );
        let g = two_boxes(config);
        assert!(wipes(&g).is_empty(), "{model}");
        let lines: Vec<&str> = g
            .lines()
            .map(|l| l.split(';').next().unwrap_or("").trim())
            .collect();
        for (i, l) in lines.iter().enumerate() {
            if *l == "M204 S4000" {
                let next = lines[i + 1..]
                    .iter()
                    .find(|c| moves_xy(c) || moves_z(c) || c.starts_with("M204"));
                assert!(
                    next.is_some_and(|c| extrudes(c)),
                    "{model}: line {} {next:?}",
                    i + 1
                );
            }
        }
    }
}

/// Spec 6.12: the stock printers and the 4000 and 800 variants: every wipe on the first layer at the first layer's
/// acceleration, every later one at the default.
#[test]
fn every_printer_follows_the_rule() {
    for model in [
        "bambu-a1",
        "bambu-a1-mini",
        "bambu-p1s",
        "bambu-x1-carbon",
        "bambu-h2d",
        "bambu-x2d",
    ] {
        let config = stock(model);
        let first = config["initial_layer_acceleration"][0].as_i64().unwrap();
        let rest = config["default_acceleration"][0].as_i64().unwrap();
        let all = check_wipes(&two_boxes(config), first, rest);
        assert!(all.iter().any(|w| w.layer > 0), "{model}");
        let g = two_boxes(printer(
            model,
            &json!({"default_acceleration": 4000, "initial_layer_acceleration": 800}),
        ));
        check_wipes(&g, 800, 4000);
    }
}

/// Spec 6.13 and 6.14: a top surface printed mid-print, and the print's last wipe after the top surface, run at the
/// default.
#[test]
fn top_surface_mid_print_and_the_last_wipe() {
    let g = slice_parts(a1(&distinct()), vec![(step_mesh(), 118.0, 118.0)]);
    let all = check_wipes(&g, 800, 4000);
    assert!(
        all.iter()
            .any(|w| w.layer > 0 && w.after == "Top surface" && w.inside == vec![(4000, true)])
    );
    let last = all.last().unwrap();
    assert_eq!(last.kind, Kind::Last, "{last:?}");
    assert_eq!(last.after, "Top surface", "{last:?}");
    assert_eq!(last.inside, vec![(4000, true)], "{last:?}");
}
