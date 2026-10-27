// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Ironing is held to `filament_max_volumetric_speed` like every other feature. At 15% flow and 0.15 mm spacing on
//! 0.2 mm layers ironing extrudes 0.0045 mm3 per mm times the filament's flow ratio, so 300 mm/s under a 1.2 mm3/s
//! limit pushes 1.215 to 1.418 mm3/s unless the lines slow down. They used to keep the ironing speed whatever the
//! limit.

mod common;

use serde_json::json;
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

/// The G-code of the L block ironing at 300 mm/s, with the filament's flow `ratio` and volumetric limit `cap`.
fn run(ratio: f64, cap: f64) -> String {
    let c = json!({
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "ironing_type": "top",
        "ironing_flow": "15%",
        "ironing_spacing": 0.15,
        "ironing_speed": 300,
        "filament_diameter": [1.75],
        "filament_flow_ratio": [ratio],
        "filament_max_volumetric_speed": [cap],
        "print_flow_ratio": 1,
        "brim_width": 0,
        "smart_layer": "off",
    });
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

/// The ironing feed rates (mm/min) and the mm3 per mm over every ironing line of 2 mm or longer.
fn ironing(g: &str) -> (Vec<f64>, f64) {
    let area = std::f64::consts::PI * 1.75 * 1.75 / 4.0;
    let (mut at, mut feed, mut e_abs) = ([0.0, 0.0], 0.0, 0.0);
    let (mut relative, mut ironing_on) = (false, false);
    let (mut feeds, mut e_sum, mut len_sum) = (Vec::new(), 0.0, 0.0);
    for line in g.lines() {
        if let Some(f) = line.strip_prefix(";TYPE:") {
            ironing_on = f.trim() == "Ironing";
        } else if line.starts_with("M83") {
            relative = true;
        } else if line.starts_with("M82") {
            relative = false;
        } else if line.starts_with("G92") {
            if let Some(v) = num(line, 'E') {
                e_abs = v;
            }
        } else if line.starts_with("G0 ") || line.starts_with("G1 ") {
            if let Some(f) = num(line, 'F') {
                feed = f;
            }
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
                if !feeds.contains(&feed) {
                    feeds.push(feed);
                }
                e_sum += e;
                len_sum += len;
            }
            at = to;
        }
    }
    assert!(len_sum > 100.0, "{len_sum} mm of ironing");
    (feeds, e_sum / len_sum * area)
}

#[test]
fn ironing_never_pushes_more_than_the_volumetric_limit() {
    for ratio in [0.9, 0.98, 1.05] {
        let (feeds, per_mm) = ironing(&run(ratio, 1.2));
        assert!(
            (per_mm - 0.0045 * ratio).abs() < 0.0045 * 0.002,
            "{ratio}: {per_mm} mm3 per mm"
        );
        for f in feeds {
            // The rate over the limit: at most 1.000, and at the limit rather than under it.
            let r = f / 60.0 * per_mm / 1.2;
            assert!(r < 1.0005, "flow ratio {ratio}: F{f} pushes {r} of the limit");
            assert!(r > 0.995, "flow ratio {ratio}: F{f} pushes only {r} of the limit");
        }
    }
}

#[test]
fn a_limit_ironing_stays_under_keeps_the_ironing_speed() {
    let (feeds, _) = ironing(&run(1.05, 50.0));
    assert_eq!(feeds, vec![18000.0]);
}
