// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Lifts start where the nozzle really is and climb at the set angle: after a wipe, across a layer change, after
//! a wipe on loops and between objects, read back from the G-code as a printer would move.

// Configs are built with `json!` at each call, so taking them by value reads best.
#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::float_cmp, clippy::cast_precision_loss)]
// Checks measure the output with the standard math functions; the engine's own rounding rule (clippy.toml) is for G-code.
#![allow(clippy::disallowed_methods)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn base_config() -> Value {
    let bench: Value = serde_json::from_slice(
        &std::fs::read(format!(
            "{}/packages/core/bench/configs/reference-0.20.json",
            root()
        ))
        .unwrap(),
    )
    .unwrap();
    bench["config"].clone()
}

/// The G-code of two copies of the reference part, centered on (70, 128) and (186, 128).
fn two_objects(config: Value) -> String {
    let bytes = std::fs::read(format!("{}/packages/core/bench/models/x-mark.stl", root())).unwrap();
    let m = Arc::new(Mesh::load(&bytes, "x-mark.stl").unwrap());
    let (lo, hi) = m.bounds().unwrap();
    let at = |cx: f64, cy: f64| {
        let mut t = [0.0f64; 16];
        t[0] = 1.0;
        t[5] = 1.0;
        t[10] = 1.0;
        t[15] = 1.0;
        t[12] = cx - f64::from(lo[0] + hi[0]) / 2.0;
        t[13] = cy - f64::from(lo[1] + hi[1]) / 2.0;
        t[14] = -f64::from(lo[2]);
        t
    };
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "a", "name": "left.stl", "mesh": "x", "transform": at(70.0, 128.0)},
            {"id": "b", "name": "right.stl", "mesh": "x", "transform": at(186.0, 128.0)},
        ]},
        "config": config,
        "options": {},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

/// The lift settings every check here starts from, with `extra` on top.
fn lifting(extra: Value) -> Value {
    let mut c = base_config();
    c["z_hop"] = json!(0.4);
    c["retract_lift_above"] = json!(0);
    c["retract_lift_below"] = json!(0);
    c["travel_slope"] = json!(5);
    c["retract_when_changing_layer"] = json!(true);
    c["wipe"] = json!(true);
    c["wipe_distance"] = json!(2);
    if let Value::Object(m) = extra {
        for (k, v) in m {
            c[k] = v;
        }
    }
    c
}

/// One G-code line with where the nozzle was before it and after it.
struct Step<'a> {
    line: &'a str,
    before: [f64; 3],
    after: [f64; 3],
}

fn word(line: &str, k: char) -> Option<f64> {
    line.split(';')
        .next()?
        .split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

/// Every line with the nozzle's position before and after it (absolute moves; a full-turn arc ends where it
/// started).
fn walk(g: &str) -> Vec<Step<'_>> {
    let mut at = [0.0f64; 3];
    g.lines()
        .map(|line| {
            let before = at;
            let cmd = line.split_whitespace().next().unwrap_or("");
            if matches!(cmd, "G0" | "G1" | "G2" | "G3") {
                for (i, k) in ['X', 'Y', 'Z'].into_iter().enumerate() {
                    if let Some(v) = word(line, k) {
                        at[i] = v;
                    }
                }
            }
            Step {
                line,
                before,
                after: at,
            }
        })
        .collect()
}

fn is_lift_move(line: &str) -> bool {
    line.starts_with("G1 X") && line.contains(" Z") && !line.contains(" E")
}

#[test]
fn spiral_lifts_climb_at_the_set_angle_over_the_rise_they_make() {
    // One helical turn per lift: the rise from where the nozzle is over the turn's circumference is the tangent of
    // `travel_slope`, also at a layer change, where the rise is the lift plus the step up from the layer below.
    let g = two_objects(lifting(json!({
        "z_hop_types": "Spiral Lift",
        "enable_arc_fitting": true,
    })));
    let (mut lifts, mut layer_changes) = (0, 0);
    for s in walk(&g)
        .iter()
        .filter(|s| s.line.starts_with("G3 Z") && s.line.contains(" P1 "))
    {
        let rise = s.after[2] - s.before[2];
        let r = word(s.line, 'I').unwrap().hypot(word(s.line, 'J').unwrap());
        let angle = (rise / (std::f64::consts::TAU * r)).atan().to_degrees();
        assert!(
            (angle - 5.0).abs() < 0.1,
            "{angle:.3} degrees over {rise:.3} mm: {}",
            s.line
        );
        assert!(s.after[..2] == s.before[..2], "a full turn ends where it started");
        lifts += 1;
        if rise > 0.5 {
            layer_changes += 1;
        }
    }
    assert!(lifts > 200, "{lifts} spiral lifts");
    assert!(layer_changes > 100, "{layer_changes} lifts at a layer change");
}

#[test]
fn spiral_turns_come_back_to_where_the_nozzle_was() {
    // Without arcs a turn is short moves that end over its start: where the nozzle stopped, after the wipe of the
    // retraction, the wipe of the layer change, or a wipe on loops that left the layer below.
    for extra in [
        json!({}),
        json!({"wipe": false, "wipe_on_loops": true}),
        json!({"wipe_on_loops": true}),
    ] {
        let mut extra = extra;
        extra["z_hop_types"] = json!("Spiral Lift");
        extra["enable_arc_fitting"] = json!(false);
        extra["printer_model"] = json!("Prusa MK4S");
        let g = two_objects(lifting(extra.clone()));
        let steps = walk(&g);
        let mut turns = 0;
        for (i, s) in steps.iter().enumerate() {
            if !s.line.starts_with("G1 F") {
                continue;
            }
            // The turn's moves, with any progress line the writer puts between them.
            let moves: Vec<&Step<'_>> = steps
                .get(i + 1..)
                .unwrap_or(&[])
                .iter()
                .filter(|t| t.line.starts_with('G'))
                .take_while(|t| is_lift_move(t.line))
                .collect();
            if moves.len() < 4 {
                continue;
            }
            let last = moves[moves.len() - 1];
            let (dx, dy) = (last.after[0] - s.after[0], last.after[1] - s.after[1]);
            assert!(
                dx.hypot(dy) < 0.002,
                "{extra}: a turn from X{} Y{} ends at X{} Y{} (line {})",
                s.after[0],
                s.after[1],
                last.after[0],
                last.after[1],
                i + 1
            );
            turns += 1;
        }
        assert!(turns > 200, "{extra}: {turns} turns");
    }
}

#[test]
fn slope_lifts_ramp_at_the_set_angle_from_where_the_nozzle_is() {
    // A slope ramp climbs from the nozzle's place (after the wipe, or the layer below's height at a layer change)
    // at `travel_slope` degrees.
    for extra in [json!({}), json!({"wipe": false, "wipe_on_loops": true})] {
        let mut extra = extra;
        extra["z_hop_types"] = json!("Slope Lift");
        let g = two_objects(lifting(extra.clone()));
        let (mut ramps, mut layer_changes) = (0, 0);
        for s in walk(&g).iter().filter(|s| is_lift_move(s.line)) {
            let run = (s.after[0] - s.before[0]).hypot(s.after[1] - s.before[1]);
            let rise = s.after[2] - s.before[2];
            let angle = rise.atan2(run).to_degrees();
            assert!(
                (angle - 5.0).abs() < 0.1,
                "{extra}: {angle:.3} degrees, {rise:.3} over {run:.3}: {}",
                s.line
            );
            ramps += 1;
            if rise > 0.5 {
                layer_changes += 1;
            }
        }
        assert!(ramps > 200, "{extra}: {ramps} ramps");
        assert!(
            layer_changes > 100,
            "{extra}: {layer_changes} ramps at a layer change"
        );
    }
}

#[test]
fn a_zero_upper_lift_limit_lifts_at_every_height() {
    // `retract_lift_below` 0 means no upper limit: the top layers lift as the low ones do. A positive limit stops
    // the lifts above it.
    let lifts_above = |g: &str, z: f64| {
        walk(g)
            .iter()
            .filter(|s| s.line.starts_with("G3 Z") && s.before[2] > z)
            .count()
    };
    let open = two_objects(lifting(
        json!({"z_hop_types": "Spiral Lift", "enable_arc_fitting": true}),
    ));
    assert!(lifts_above(&open, 10.0) > 20, "lifts high up");
    let capped = two_objects(lifting(json!({
        "z_hop_types": "Spiral Lift",
        "enable_arc_fitting": true,
        "retract_lift_below": 5,
    })));
    assert_eq!(lifts_above(&capped, 5.0), 0);
    assert!(lifts_above(&capped, 1.0) > 0);
}
