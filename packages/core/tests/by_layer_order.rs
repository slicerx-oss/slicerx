// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Objects with settings of their own on a plate printed layer by layer: each object still prints with its own
//! settings, and every layer prints its filaments in one order across the objects, as a plate without own settings
//! does. A layer prints all the walls on the first filament, then changes once and prints all the infill on the
//! second, and the prime tower purges once per change, not once per object. A plate printed by object is left as
//! it was.

// Test inputs are small counts and exact expected floats.
#![allow(clippy::cast_precision_loss, clippy::float_cmp)]

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{Mesh, MeshPart, SliceRequest, SliceRun};

fn cuboid(x: [f32; 2], y: [f32; 2], z: [f32; 2], name: &str) -> MeshPart {
    let mut positions = Vec::new();
    for zi in z {
        for (xi, yi) in [(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])] {
            positions.push([xi, yi, zi]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    MeshPart {
        name: name.into(),
        slot: 1,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint: Vec::new(),
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
        paint_texts: Vec::new(),
    }
}

/// A 20 mm cube, 10 mm tall.
fn cube() -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "cube".into(),
        parts: vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 10.0], "cube")],
        ..Mesh::default()
    })
}

/// [`cube`] on filament `slot`.
fn cube_on(slot: u8) -> Arc<Mesh> {
    let mut part = cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 10.0], "cube");
    part.slot = slot;
    Arc::new(Mesh {
        name: "cube".into(),
        parts: vec![part],
        ..Mesh::default()
    })
}

/// A slab resting on two pillars 24 mm apart.
fn table() -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "table".into(),
        parts: vec![
            cuboid([0.0, 8.0], [0.0, 20.0], [0.0, 10.0], "left"),
            cuboid([32.0, 40.0], [0.0, 20.0], [0.0, 10.0], "right"),
            cuboid([0.0, 40.0], [0.0, 20.0], [10.0, 12.0], "slab"),
        ],
        ..Mesh::default()
    })
}

/// Two pillars under a low slab on the front half and a high slab on the back half: support under the low slab
/// reaches its interface while support under the high one is still base, on the same support layers.
fn two_shelves() -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "shelves".into(),
        parts: vec![
            cuboid([0.0, 8.0], [0.0, 20.0], [0.0, 22.0], "left"),
            cuboid([32.0, 40.0], [0.0, 20.0], [0.0, 22.0], "right"),
            cuboid([0.0, 40.0], [0.0, 10.0], [10.0, 12.0], "low"),
            cuboid([0.0, 40.0], [10.0, 20.0], [20.0, 22.0], "high"),
        ],
        ..Mesh::default()
    })
}

fn at(x: f64, y: f64) -> Value {
    json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1])
}

/// The plate's settings on a Bambu Lab A1: the sparse infill on filament 2, a prime tower in the back left corner.
fn a1(extra: &Value) -> Value {
    let mut c = json!({
        "printer_model": "Bambu Lab A1",
        "sparse_infill_filament_id": "2",
        "enable_prime_tower": "1",
        "prime_tower_auto_position": "0",
        "wipe_tower_x": ["15"],
        "wipe_tower_y": ["220"],
        "prime_tower_width": "35",
        "prime_tower_brim_width": "0",
        "brim_width": 0,
    });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    c
}

/// Two cubes side by side on the A1, the first with `own` settings of its own (none when null).
fn two_cubes(own: Value, extra: &Value, shards: u32) -> SliceRun {
    two_cubes_with(own, &a1(extra), shards)
}

/// [`two_cubes`] with the plate's settings `config`.
fn two_cubes_with(own: Value, config: &Value, shards: u32) -> SliceRun {
    let mut a = json!({"id": "a", "name": "a", "mesh": "c", "transform": at(100.0, 128.0)});
    if !own.is_null() {
        a["settings"] = own;
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [a, {"id": "b", "name": "b", "mesh": "c", "transform": at(150.0, 128.0)}]},
        "config": config,
        "options": {"shards": shards},
    }))
    .unwrap();
    let c = cube();
    common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap()
}

fn text(run: &SliceRun) -> String {
    String::from_utf8(run.gcode.clone()).unwrap()
}

/// One layer of G-code as it prints: (object label, feature, tool) each time one of them changes, and the
/// extrusion per (object label, feature, tool), mm of filament.
#[derive(Debug, Default)]
struct Layer {
    z: String,
    runs: Vec<(String, String, String)>,
    extrusion: Vec<((String, String, String), f64)>,
}

impl Layer {
    fn tools(&self) -> Vec<&str> {
        let mut v: Vec<&str> = Vec::new();
        for (_, _, t) in &self.runs {
            if v.last() != Some(&t.as_str()) {
                v.push(t);
            }
        }
        v
    }

    fn add(&mut self, key: (String, String, String), e: f64) {
        match self.extrusion.iter_mut().find(|(k, _)| *k == key) {
            Some((_, v)) => *v += e,
            None => self.extrusion.push((key, e)),
        }
    }

    fn of(&self, object: &str, feature: &str) -> f64 {
        self.extrusion
            .iter()
            .filter(|((o, f, _), _)| o == object && f == feature)
            .map(|(_, e)| e)
            .sum()
    }
}

/// The G-code's layers, from its `; CHANGE_LAYER` marks (Bambu style, relative extrusion).
fn layers(g: &str) -> Vec<Layer> {
    let mut out: Vec<Layer> = Vec::new();
    let (mut object, mut feature, mut tool) = (String::new(), String::new(), String::new());
    let mut in_change = false;
    for l in g.lines() {
        if l == "; CHANGE_LAYER" {
            out.push(Layer::default());
        } else if let Some(z) = l.strip_prefix("; Z_HEIGHT: ") {
            if let Some(last) = out.last_mut() {
                z.clone_into(&mut last.z);
            }
        } else if let Some(f) = l.strip_prefix("; FEATURE: ") {
            f.clone_into(&mut feature);
        } else if let Some(id) = l.strip_prefix("; start printing object, unique label id: ") {
            id.clone_into(&mut object);
        } else if l.starts_with("; stop printing object") {
            object.clear();
        } else if l.starts_with("M620 S") {
            in_change = true;
        } else if l.starts_with("M621 S") {
            in_change = false;
        } else if is_tool(l) {
            l.clone_into(&mut tool);
        } else if let (false, Some(layer)) = (in_change, out.last_mut())
            && l.starts_with("G1 ")
            && (l.contains(" X") || l.contains(" Y"))
            && let Some(e) = l
                .split_whitespace()
                .find_map(|w| w.strip_prefix('E'))
                .and_then(|e| e.parse::<f64>().ok())
                .filter(|e| *e > 0.0)
        {
            let key = (object.clone(), feature.clone(), tool.clone());
            if layer.runs.last() != Some(&key) {
                layer.runs.push(key.clone());
            }
            layer.add(key, e);
        }
    }
    out
}

/// A bare tool select line (`T1`).
fn is_tool(l: &str) -> bool {
    l.strip_prefix('T')
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

/// Tool changes in the G-code: its tool select lines after the first.
fn changes(g: &str) -> usize {
    g.lines().filter(|l| is_tool(l)).count().saturating_sub(1)
}

fn tower_extrusion(ls: &[Layer]) -> f64 {
    ls.iter().map(|l| l.of("", "Prime tower")).sum()
}

#[test]
fn an_object_with_its_own_settings_keeps_the_plates_filament_order() {
    let plain = two_cubes(Value::Null, &json!({}), 1);
    let own = two_cubes(json!({"wall_loops": 3}), &json!({}), 1);
    let (gp, go) = (text(&plain), text(&own));
    let (lp, lo) = (layers(&gp), layers(&go));
    assert_eq!(lp.len(), lo.len());
    // The same tool changes as the plate without own settings, and layer by layer the same order of features and
    // filaments: both objects' walls on T0, the change, both objects' infill on T1. (Within one filament the plain
    // plate takes the objects in the order its infill lines run; here they keep the plate's order.)
    assert_eq!(changes(&go), changes(&gp), "tool changes");
    let pattern = |l: &Layer| -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = l.runs.iter().map(|r| (r.1.clone(), r.2.clone())).collect();
        v.dedup();
        v
    };
    for (i, (p, o)) in lp.iter().zip(&lo).enumerate() {
        assert_eq!(pattern(o), pattern(p), "layer {i}");
    }
    let middle = &lo[lo.len() / 2];
    assert_eq!(middle.tools(), ["T0", "T1"], "{:?}", middle.runs);
    // The prime tower purges once per change of the plate, as on the plain plate.
    let (tp, to) = (tower_extrusion(&lp), tower_extrusion(&lo));
    assert!(tp > 0.0);
    assert!((to - tp).abs() < tp * 0.02, "tower {to} against {tp}");
    // The object's own settings still apply: three walls on the first cube, two on the second.
    let (pa, pb) = (middle.of("1", "Inner wall"), middle.of("2", "Inner wall"));
    let plain_middle = &lp[lp.len() / 2];
    assert!((pb - plain_middle.of("2", "Inner wall")).abs() < 1e-3, "{pb}");
    assert!(pa > pb * 1.8, "inner walls {pa} against {pb}");
    // Ranges sliced apart concatenate to the same G-code.
    assert_eq!(text(&two_cubes(json!({"wall_loops": 3}), &json!({}), 4)), go);
}

#[test]
fn a_plate_printed_by_object_prints_as_before() {
    // Each object completely before the next: its own walls and infill, with the changes they need. The bytes are
    // pinned so a change of the layer by layer order cannot reach this plate; a change that alters them updates the
    // hash and says why.
    let run = two_cubes(
        json!({"wall_loops": 3}),
        &json!({"print_sequence": "by object"}),
        1,
    );
    let g = text(&run);
    let version = env!("CARGO_PKG_VERSION");
    let body: String = g
        .lines()
        .filter(|l| !l.contains(version))
        .flat_map(|l| [l, "\n"])
        .collect();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in body.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    let ls = layers(&g);
    // The first cube's layers, then the second's: no layer holds both.
    assert!(ls.iter().all(|l| {
        let mut objects: Vec<&str> = l
            .runs
            .iter()
            .map(|r| r.0.as_str())
            .filter(|o| !o.is_empty())
            .collect();
        objects.dedup();
        objects.len() <= 1
    }));
    assert_eq!(format!("{h:016x}"), BY_OBJECT_FNV, "by-object G-code changed");
}

/// FNV-1a of the by-object plate's G-code, version lines left out.
const BY_OBJECT_FNV: &str = "79c0d1c5541329cd";

#[test]
fn layers_paired_by_height_keep_their_filament_order_inside_each_layer() {
    // A table with slim tree support on layers of its own height (trees keep them with a prime tower) beside a cube
    // with its own walls, the sparse infill on
    // filament 2: the plate's layers pair the objects' layers by height, and each of them prints its filaments in one
    // order across the objects, so no layer changes back to a filament it already printed.
    let run = |shards: u32| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [
                {"id": "t", "name": "t", "mesh": "t", "transform": at(80.0, 120.0),
                 "settings": {"enable_support": true, "support_type": "tree(auto)", "support_style": "tree_slim"}},
                {"id": "b", "name": "b", "mesh": "b", "transform": at(160.0, 120.0), "settings": {"wall_loops": 3}},
            ]},
            "config": a1(&json!({"independent_support_layer_height": true})),
            "options": {"shards": shards},
        }))
        .unwrap();
        let (t, b) = (table(), cube());
        common::run_request(&req, &move |id: &str| {
            Ok(if id == "t" { t.clone() } else { b.clone() })
        })
        .unwrap()
    };
    let one = run(1);
    let g = text(&one);
    let ls = layers(&g);
    // Support layers of their own between the shared ones.
    assert!(one.report.layer_count > 60, "{}", one.report.layer_count);
    assert_eq!(ls.len(), one.report.layer_count as usize);
    let zs: Vec<f64> = ls.iter().map(|l| l.z.parse().unwrap()).collect();
    assert!(zs.windows(2).all(|w| w[1] > w[0]), "layer heights rise");
    let mut both = 0;
    for (i, l) in ls.iter().enumerate() {
        let tools = l.tools();
        let mut distinct = tools.clone();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(
            tools.len(),
            distinct.len(),
            "layer {i} at {} changes back: {:?}",
            l.z,
            l.runs
        );
        // A support layer of its own holds the table's support only: nothing moves into it from the shared layers.
        if l.runs.iter().all(|r| r.1 == "Support" || r.1 == "Prime tower") {
            assert!(l.runs.iter().all(|r| r.0 != "2"), "layer {i}: {:?}", l.runs);
        }
        if l.runs.iter().any(|r| r.0 == "1") && l.runs.iter().any(|r| r.0 == "2") {
            both += 1;
            assert!(tools.len() <= 2, "layer {i}: {:?}", l.runs);
        }
    }
    assert!(both > 40, "{both} layers hold both objects");
    // At most one change inside each layer and one between layers.
    assert!(
        changes(&g) <= 2 * ls.len(),
        "{} changes over {} layers",
        changes(&g),
        ls.len()
    );
    assert_eq!(text(&run(4)), g, "shards concatenate to the same G-code");
}

#[test]
fn a_range_that_starts_inside_the_support_prints_what_the_whole_plate_prints() {
    // Slim tree support on layers of its own with its base on filament 1 and its interface on 2 (on the same support layers,
    // under two shelves), beside a cube with its own walls: a range that starts on a support layer starts on the
    // filament the layer below really ended on.
    let run = |shards: u32| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [
                {"id": "t", "name": "t", "mesh": "t", "transform": at(80.0, 120.0),
                 "settings": {"enable_support": true, "support_type": "tree(auto)", "support_style": "tree_slim",
                              "support_filament": "1",
                              "support_interface_filament": "2", "support_interface_top_layers": 3}},
                {"id": "b", "name": "b", "mesh": "b", "transform": at(160.0, 120.0), "settings": {"wall_loops": 3}},
            ]},
            "config": a1(&json!({"independent_support_layer_height": true})),
            "options": {"shards": shards},
        }))
        .unwrap();
        let (t, b) = (two_shelves(), cube());
        common::run_request(&req, &move |id: &str| {
            Ok(if id == "t" { t.clone() } else { b.clone() })
        })
        .unwrap()
    };
    let one = run(1);
    let whole = text(&one);
    // As many ranges as layers too: every layer starts a range once.
    for shards in (2..=8).chain([one.report.layer_count]) {
        assert!(
            text(&run(shards)) == whole,
            "{shards} ranges print another G-code than one"
        );
    }
}

/// The points of the skirt's extruding moves on the first layer, mm.
fn skirt_points(g: &str) -> Vec<(f64, f64)> {
    let (mut layer, mut on) = (0, false);
    let mut out = Vec::new();
    for l in g.lines() {
        if l == "; CHANGE_LAYER" {
            layer += 1;
        } else if let Some(f) = l.strip_prefix("; FEATURE: ") {
            on = f == "Skirt";
        } else if on && layer == 1 && l.starts_with("G1 ") && l.contains(" E") {
            let v = |c: char| {
                l.split_whitespace()
                    .find_map(|w| w.strip_prefix(c))
                    .and_then(|x| x.parse::<f64>().ok())
            };
            if let (Some(x), Some(y)) = (v('X'), v('Y')) {
                out.push((x, y));
            }
        }
    }
    out
}

#[test]
fn each_objects_skirt_stays_round_its_object() {
    // Each object with settings of its own gets a skirt of its own; none of them wraps the shared prime tower in the
    // back left corner, so no skirt runs across the bed past another object.
    let run = two_cubes(
        json!({"wall_loops": 3}),
        &json!({"skirt_loops": 1, "skirt_distance": 2}),
        1,
    );
    let points = skirt_points(&text(&run));
    assert!(!points.is_empty());
    assert!(points.iter().all(|&(x, y)| x > 90.0 && y < 160.0), "{points:?}");
}

/// The feed rate of each outer wall move on layer `n`, mm/min, sorted.
fn outer_wall_feeds(g: &str, n: usize) -> Vec<f64> {
    let (mut layer, mut on, mut feed) = (0, false, 0.0);
    let mut out = Vec::new();
    for l in g.lines() {
        if l == "; CHANGE_LAYER" {
            layer += 1;
        } else if let Some(f) = l.strip_prefix("; FEATURE: ") {
            on = f == "Outer wall";
        } else if l.starts_with("G1 ") {
            if let Some(f) = l
                .split_whitespace()
                .find_map(|w| w.strip_prefix('F'))
                .and_then(|f| f.parse::<f64>().ok())
            {
                feed = f;
            }
            if on && layer == n && l.contains(" E") && (l.contains(" X") || l.contains(" Y")) {
                out.push(feed);
            }
        }
    }
    out.sort_by(f64::total_cmp);
    out
}

#[test]
fn a_layer_of_several_objects_slows_down_for_cooling_as_one_layer() {
    // The layer cooling slowdown judges the plate's layer, not each object's part of it: with the minimum layer time
    // between one cube's time and two cubes', the plate prints at full speed whether or not an object has settings of
    // its own (here its own wall count, the same as the plate's).
    let config = |slow: f64| {
        json!({"printer_model": "Bambu Lab A1", "brim_width": 0, "slow_down_for_layer_cooling": slow > 0.0,
               "slow_down_layer_time": slow, "slow_down_min_speed": 10})
    };
    let plain_fast = two_cubes_with(Value::Null, &config(0.0), 1);
    let both = f64::from(plain_fast.report.layer_time_s[20]);
    assert!(both > 2.0, "{both}");
    let limit = both * 0.75;
    let plain = text(&two_cubes_with(Value::Null, &config(limit), 1));
    let own = text(&two_cubes_with(json!({"wall_loops": 2}), &config(limit), 1));
    let (fp, fo) = (outer_wall_feeds(&plain, 21), outer_wall_feeds(&own, 21));
    assert_eq!(fo.len(), fp.len());
    assert!(!fp.is_empty());
    // The same feed, give or take its rounding (an object's own session works the speed out on its own).
    for (o, p) in fo.iter().zip(&fp) {
        assert!((o - p).abs() <= p * 0.002, "{fo:?} against {fp:?}");
    }
}

const ON_OBJECT_LAYERS: &str = "Support prints on the model's layers because this print uses a prime tower.";

#[test]
fn with_the_plates_tower_support_prints_on_the_objects_layers() {
    // A table with normal support beside a cube on filament 2. Neither object changes filament on its own, so only
    // the plate prints a prime tower. Support on layers of its own height is asked for (the default); with the
    // plate's tower it prints on the objects' layers, as on the same plate without own settings, and the slice says
    // so. With the tower off the support keeps layers of its own.
    let run = |own: bool, tower: bool| {
        let mut config = a1(&json!({"enable_support": true, "support_type": "normal(auto)",
            "independent_support_layer_height": true, "enable_prime_tower": if tower { "1" } else { "0" }}));
        if let Some(c) = config.as_object_mut() {
            c.remove("sparse_infill_filament_id");
        }
        let mut t = json!({"id": "t", "name": "t", "mesh": "t", "transform": at(80.0, 120.0)});
        if own {
            t["settings"] = json!({"wall_loops": 3});
        }
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [t, {"id": "b", "name": "b", "mesh": "b", "transform": at(160.0, 120.0)}]},
            "config": config,
        }))
        .unwrap();
        let (t, b) = (table(), cube_on(2));
        common::run_request(&req, &move |id: &str| {
            Ok(if id == "t" { t.clone() } else { b.clone() })
        })
        .unwrap()
    };
    let warned = |r: &SliceRun| {
        r.report
            .warnings
            .iter()
            .any(|w| w.message.starts_with(ON_OBJECT_LAYERS))
    };
    let (plain, own) = (run(false, true), run(true, true));
    assert_eq!(plain.report.layer_count, 60, "{:?}", plain.report.layer_z);
    assert_eq!(
        own.report.layer_count, plain.report.layer_count,
        "{:?}",
        own.report.layer_z
    );
    assert_eq!(own.report.layer_z, plain.report.layer_z);
    assert!(warned(&plain) && warned(&own), "{:?}", own.report.warnings);
    let lo = layers(&text(&own));
    assert!(tower_extrusion(&lo) > 0.0);
    assert!(lo.iter().any(|l| l.of("1", "Support") > 0.0));
    let off = run(true, false);
    assert!(off.report.layer_count > 60, "{}", off.report.layer_count);
    assert!(!warned(&off));
}
