// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
mod common;

use common::config_from;
use serde_json::json;
use sx_settings::{PrintConfig, Severity, Value, resolve_auto, settings, validate};

fn get(c: &PrintConfig, k: &str) -> serde_json::Value {
    c.to_json()[k].clone()
}

#[test]
fn turns_every_automatic_width_in_the_defaults_into_a_concrete_one() {
    let mut cfg = PrintConfig::new();
    for d in settings() {
        if let Some(v) = Value::from_json(&d.default) {
            cfg.set(d.key.clone(), v);
        }
    }
    let out = resolve_auto(&cfg, Some(0.4));
    assert_eq!(get(&out, "line_width"), json!("0.42"));
    assert_eq!(get(&out, "outer_wall_line_width"), json!("0.42"));
    assert_eq!(get(&out, "inner_wall_line_width"), json!("0.42"));
    assert_eq!(get(&out, "top_surface_line_width"), json!("0.42"));
    assert_eq!(get(&out, "initial_layer_line_width"), json!("0.48"));
    assert_eq!(get(&out, "sparse_infill_line_width"), json!("0.45"));
    assert_eq!(get(&out, "internal_solid_infill_line_width"), json!("0.45"));
    for d in settings().iter().filter(|d| d.auto) {
        assert_ne!(get(&out, &d.key), json!("0"), "{}", d.key);
    }
    assert!(validate(&out).iter().all(|i| i.severity != Severity::Error));
}

#[test]
fn scales_with_the_nozzle_and_reads_it_from_the_config() {
    let a = resolve_auto(
        &config_from(&json!({"line_width": "0", "outer_wall_line_width": "0"})),
        Some(0.6),
    );
    assert_eq!(get(&a, "outer_wall_line_width"), json!("0.63"));
    let b = resolve_auto(
        &config_from(
            &json!({"nozzle_diameter": [0.6], "inner_wall_line_width": "0", "sparse_infill_line_width": "0"}),
        ),
        None,
    );
    assert_eq!(get(&b, "sparse_infill_line_width"), json!("0.675"));
    assert_eq!(
        get(
            &resolve_auto(&config_from(&json!({"top_surface_line_width": "0"})), None),
            "top_surface_line_width"
        ),
        json!("0.42")
    );
}

#[test]
fn a_set_default_width_stands_in_for_the_automatic_ones() {
    let out = resolve_auto(
        &config_from(
            &json!({"line_width": "0.5", "outer_wall_line_width": "0", "initial_layer_line_width": "0"}),
        ),
        Some(0.4),
    );
    assert_eq!(get(&out, "outer_wall_line_width"), json!("0.5"));
    assert_eq!(get(&out, "initial_layer_line_width"), json!("0.5"));
    let pct = resolve_auto(
        &config_from(&json!({"line_width": "110%", "inner_wall_line_width": "0"})),
        Some(0.4),
    );
    assert_eq!(get(&pct, "inner_wall_line_width"), json!("0.44"));
}

#[test]
fn leaves_set_widths_other_keys_and_missing_keys_alone() {
    let input = config_from(
        &json!({"line_width": "0", "outer_wall_line_width": "0.6", "inner_wall_line_width": "105%", "layer_height": 0.2}),
    );
    let copy = input.clone();
    let out = resolve_auto(&input, Some(0.4));
    assert_eq!(input, copy);
    assert_eq!(get(&out, "outer_wall_line_width"), json!("0.6"));
    assert_eq!(get(&out, "inner_wall_line_width"), json!("105%"));
    assert_eq!(get(&out, "layer_height"), json!(0.2));
    assert!(!out.contains("sparse_infill_line_width"));
}

#[test]
fn filament_ironing_speed_follows_the_process_value() {
    let out = resolve_auto(
        &config_from(&json!({"filament_ironing_speed": 0, "ironing_speed": 30})),
        None,
    );
    assert_eq!(get(&out, "filament_ironing_speed"), json!(30));
    let list = resolve_auto(&config_from(&json!({"filament_ironing_speed": [0, 0]})), None);
    assert_eq!(get(&list, "filament_ironing_speed"), json!([20, 20]));
}
