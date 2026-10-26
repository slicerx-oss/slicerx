// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Ironing extrudes `layer_height` x `ironing_flow` x `ironing_spacing` mm3 per mm, from the layer height setting,
//! on every ironed layer: a first layer printed thicker under solid ironing, and a smart layer top thinner than the
//! setting, iron the same as a layer at the setting. Both used to scale with the ironed layer's own height.

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use common::organic_models::cuboid;
use sx_core::api::{Mesh, SliceRequest};

/// An L block on a 30 x 20 mm footprint: x 0 to 15 is 6 mm tall, x 15 to 30 is 3 mm tall.
fn l_block() -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "L".into(),
        parts: vec![
            cuboid("tall", [0.0, 0.0, 0.0], [15.0, 20.0, 6.0]),
            cuboid("low", [15.0, 0.0, 0.0], [30.0, 20.0, 3.0]),
        ],
        ..Mesh::default()
    })
}

/// The G-code of the L block, ironing at 15% and 0.1 mm on 0.2 mm layers, over `extra` settings.
fn run(extra: &Value) -> String {
    let mut c = json!({
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "ironing_type": "top",
        "ironing_flow": 15,
        "ironing_spacing": 0.1,
        "ironing_speed": 40,
        "filament_diameter": [1.75],
        "filament_flow_ratio": [1],
        "print_flow_ratio": 1,
        "brim_width": 0,
        "smart_layer": "off",
    });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{
            "id": "a", "name": "a", "mesh": "a",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 110, 110, 0, 1],
        }]},
        "config": c,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let run = common::run_request(&req, &|_: &str| Ok(l_block())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

fn num(line: &str, axis: char) -> Option<f64> {
    line.split(';')
        .next()?
        .split_whitespace()
        .find_map(|w| w.strip_prefix(axis).and_then(|v| v.parse().ok()))
}

/// Per ironed layer: (z, the layer's height, mm3 per mm over the ironing lines of 2 mm or longer).
fn ironing(g: &str) -> Vec<(f64, f64, f64)> {
    let area = std::f64::consts::PI * 1.75 * 1.75 / 4.0;
    let (mut at, mut top, mut below, mut e_abs) = ([0.0, 0.0], 0.0, 0.0, 0.0);
    let (mut relative, mut ironing_on) = (false, false);
    // (z, height, E, length)
    let mut layers: Vec<(f64, f64, f64, f64)> = Vec::new();
    for line in g.lines() {
        if let Some(f) = line
            .strip_prefix(";TYPE:")
            .or_else(|| line.strip_prefix("; FEATURE:"))
        {
            ironing_on = f.trim() == "Ironing";
        } else if let Some(v) = line
            .strip_prefix(";Z:")
            .and_then(|v| v.trim().parse::<f64>().ok())
        {
            below = top;
            top = v;
        } else if line.starts_with("M83") {
            relative = true;
        } else if line.starts_with("M82") {
            relative = false;
        } else if line.starts_with("G92") {
            if let Some(v) = num(line, 'E') {
                e_abs = v;
            }
        } else if line.starts_with("G0 ") || line.starts_with("G1 ") {
            let to = [num(line, 'X').unwrap_or(at[0]), num(line, 'Y').unwrap_or(at[1])];
            let e = num(line, 'E').map_or(0.0, |v| {
                let d = if relative { v } else { v - e_abs };
                if !relative {
                    e_abs = v;
                }
                d
            });
            let (dx, dy) = (to[0] - at[0], to[1] - at[1]);
            let len = (dx * dx + dy * dy).sqrt();
            if ironing_on && e > 0.0 && len >= 2.0 {
                match layers.last_mut() {
                    Some(last) if (last.0 - top).abs() < 1e-6 => {
                        last.2 += e;
                        last.3 += len;
                    }
                    _ => layers.push((top, top - below, e, len)),
                }
            }
            at = to;
        }
    }
    layers
        .into_iter()
        .map(|(z, h, e, len)| (z, h, e / len * area))
        .collect()
}

#[test]
fn a_thick_first_layer_irons_at_the_layer_height_setting() {
    // A 0.3 mm first layer under solid ironing: 0.2 x 15% x 0.1 = 0.0030 mm3 per mm, not 0.3 x 15% x 0.1 = 0.0045.
    let layers = ironing(&run(
        &json!({"initial_layer_print_height": 0.3, "ironing_type": "solid"}),
    ));
    let first = layers.first().expect("the first layer irons");
    assert!((first.0 - 0.3).abs() < 1e-6, "{layers:?}");
    assert!((first.2 - 0.0030).abs() < 0.0030 * 0.01, "{layers:?}");
    for (z, _, v) in &layers {
        assert!((v - 0.0030).abs() < 0.0030 * 0.01, "z {z}: {v}");
    }
}

#[test]
fn a_smart_layer_top_irons_at_the_layer_height_setting() {
    let layers = ironing(&run(&json!({
        "smart_layer": "quality",
        "smart_layer_max_height": 0.2,
        "smart_layer_min_height": 0.15,
        "smart_layer_max_step_ratio": 0.25,
        "smart_layer_smoothing": 70,
    })));
    assert!(
        layers.iter().any(|(_, h, _)| (h - 0.2).abs() > 0.01),
        "no ironed layer away from 0.2 mm: {layers:?}"
    );
    for (z, h, v) in &layers {
        assert!((v - 0.0030).abs() < 0.0030 * 0.01, "z {z} ({h} mm): {v}");
    }
}
