// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The layer-time slowdown pools every feature of a layer, ironing included: a short ironed layer slows its
//! fastest features, ironing among them, to one common feed rate, and a layer that only reaches the target with
//! its ironing is left alone. The slowdown used to run before the layer's ironing was added, so it slowed the
//! rest of the layer to the full target, left ironing at its own speed, and slowed layers already long enough.

mod common;

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;

use sx_core::api::{Mesh, SliceRequest};

/// A 20 x 20 x 2 mm box with ironing on its top, walls at 50 mm/s, infill and top surface at 100 and ironing at
/// 150, over `extra` settings. The G-code.
fn ironed_box(extra: &Value) -> String {
    let mut c = json!({
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "brim_width": 0,
        "skirt_loops": 0,
        "wall_loops": 2,
        "bottom_shell_layers": 3,
        "enable_overhang_speed": false,
        "outer_wall_speed": 50,
        "inner_wall_speed": 50,
        "sparse_infill_speed": 100,
        "internal_solid_infill_speed": 100,
        "top_surface_speed": 100,
        "gap_infill_speed": 100,
        "ironing_type": "top",
        "ironing_speed": 150,
        "ironing_spacing": 0.15,
        "slow_down_for_layer_cooling": true,
        "slow_down_min_speed": 5,
        "dont_slow_down_outer_wall": false,
    });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "a", "name": "a", "mesh": "a",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]}]},
        "config": c,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let load = |_: &str| -> sx_core::Result<Arc<Mesh>> {
        Ok(Arc::new(Mesh {
            name: "box".into(),
            parts: vec![common::organic_models::cuboid(
                "box",
                [0.0, 0.0, 0.0],
                [20.0, 20.0, 2.0],
            )],
            ..Mesh::default()
        }))
    };
    String::from_utf8(common::run_request(&req, &load).unwrap().gcode).unwrap()
}

fn num(line: &str, axis: char) -> Option<f64> {
    line.split(';')
        .next()
        .unwrap_or("")
        .split_whitespace()
        .find_map(|w| w.strip_prefix(axis).and_then(|v| v.parse().ok()))
}

/// Per feature of a layer: the length printed at each feed rate (mm/s, to 0.01) and the seconds it takes.
type Feeds = BTreeMap<String, (BTreeMap<i64, f64>, f64)>;

/// The last layer's extrusions.
fn top_layer(g: &str) -> Feeds {
    let mut layers: Vec<Feeds> = vec![BTreeMap::new()];
    let (mut px, mut py, mut rate) = (0.0f64, 0.0f64, 0.0f64);
    let mut feature = String::new();
    for l in g.lines() {
        if l.starts_with(";LAYER_CHANGE") {
            layers.push(BTreeMap::new());
        } else if let Some(t) = l.strip_prefix(";TYPE:") {
            t.trim().clone_into(&mut feature);
        } else if l.starts_with("G1 ") || l.starts_with("G0 ") {
            if let Some(v) = num(l, 'F') {
                rate = v / 60.0;
            }
            let (nx, ny) = (num(l, 'X').unwrap_or(px), num(l, 'Y').unwrap_or(py));
            let (dx, dy) = (nx - px, ny - py);
            let d = (dx * dx + dy * dy).sqrt();
            if num(l, 'E').is_some_and(|e| e > 0.0)
                && d > 0.0
                && rate > 0.0
                && let Some(layer) = layers.last_mut()
            {
                let entry = layer.entry(feature.clone()).or_default();
                #[allow(clippy::cast_possible_truncation, reason = "feeds are small")]
                let key = (rate * 100.0).round() as i64;
                *entry.0.entry(key).or_default() += d;
                entry.1 += d / rate;
            }
            (px, py) = (nx, ny);
        }
    }
    layers
        .into_iter()
        .rev()
        .find(|l| !l.is_empty())
        .unwrap_or_default()
}

/// The feed rate, mm/s, that carries most of a feature's length.
fn feed(layer: &Feeds, feature: &str) -> f64 {
    let (feeds, _) = layer
        .get(feature)
        .unwrap_or_else(|| panic!("no {feature} on the top layer: {layer:?}"));
    #[allow(clippy::cast_precision_loss, reason = "feeds are small")]
    feeds
        .iter()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map_or(0.0, |(k, _)| *k as f64 / 100.0)
}

const FEATURES: [&str; 4] = ["Outer wall", "Inner wall", "Top surface", "Ironing"];

/// U1: an ironed top layer well under the target slows every feature, ironing included, to one feed.
#[test]
fn a_short_ironed_layer_slows_its_ironing_with_the_rest() {
    let g = ironed_box(&json!({"slow_down_layer_time": 120}));
    let top = top_layer(&g);
    let feeds: Vec<f64> = FEATURES.iter().map(|f| feed(&top, f)).collect();
    let (lo, hi) = feeds
        .iter()
        .fold((f64::MAX, 0.0f64), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    assert!(
        hi - lo < 0.01 * hi,
        "one feed for every feature: {FEATURES:?} at {feeds:?}"
    );
    assert!(hi < 45.0, "slowed under the walls' 50 mm/s: {feeds:?}");
    // The printed time of the layer's extrusions stays inside the target.
    let t: f64 = top.values().map(|v| v.1).sum();
    assert!(
        t < 120.0 && t > 100.0,
        "the top layer's extrusions take {t} s against 120"
    );
}

/// U2: an ironed top layer that reaches the target only with its ironing is not slowed at all.
#[test]
fn a_layer_long_enough_with_its_ironing_keeps_its_speeds() {
    let off = top_layer(&ironed_box(&json!({"slow_down_for_layer_cooling": false})));
    let ironing = off.get("Ironing").map_or(0.0, |v| v.1);
    let all: f64 = off.values().map(|v| v.1).sum();
    assert!(ironing > 10.0, "the ironing takes {ironing} s");
    // The target sits halfway into the ironing: the layer without it is shorter, with it longer.
    let target = all - ironing / 2.0;
    let top = top_layer(&ironed_box(&json!({"slow_down_layer_time": target})));
    let feeds: Vec<f64> = FEATURES.iter().map(|f| feed(&top, f)).collect();
    assert_eq!(
        feeds,
        [50.0, 50.0, 100.0, 150.0],
        "{FEATURES:?} unslowed at a {target} s target"
    );
}
