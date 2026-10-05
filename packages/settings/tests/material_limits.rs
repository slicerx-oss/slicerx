// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
mod common;

use common::{config_from, load_profile};
use serde_json::json;
use sx_settings::{
    PlanOptions, PrintConfig, SetupRef, material_knowledge, plan_settings, smart_layer_window, validate_for,
};

fn setup(filament: &str) -> SetupRef {
    SetupRef {
        printer: "bambu_x1c".into(),
        nozzle_diameter: 0.4,
        filament: filament.into(),
        process: None,
        hotend: None,
        nozzle_material: None,
    }
}

fn base() -> PrintConfig {
    PrintConfig::merged(&[
        &load_profile("demo", "Demo Printer 0.4 nozzle").config,
        &load_profile("demo", "Demo PLA").config,
        &load_profile("demo", "0.20mm Standard @Demo").config,
    ])
}

#[test]
fn the_silk_window_and_the_default_window_differ() {
    assert_eq!(
        smart_layer_window(0.4, material_knowledge("pla_silk"), None),
        (0.12, 0.2)
    );
    assert_eq!(
        smart_layer_window(0.4, material_knowledge("pla"), None),
        (0.08, 0.28)
    );
    assert_eq!(smart_layer_window(0.4, None, None), (0.1, 0.3));
}

#[test]
fn validate_for_uses_the_material_window() {
    let cfg = config_from(
        &json!({"nozzle_diameter": [0.4], "smart_layer": "quality", "smart_layer_min_height": 0.1, "smart_layer_max_height": 0.2}),
    );
    let codes = |f: Option<&str>| {
        let mut c: Vec<String> = validate_for(&cfg, f).into_iter().map(|i| i.code).collect();
        c.sort();
        c
    };
    assert!(codes(None).is_empty());
    assert_eq!(codes(Some("pla_silk")), ["smart_layer_min_low"]);
    assert!(codes(Some("pla")).is_empty());
    let wide = config_from(
        &json!({"nozzle_diameter": [0.4], "smart_layer": "quality", "smart_layer_min_height": 0.1, "smart_layer_max_height": 0.28}),
    );
    let wide_codes: Vec<String> = validate_for(&wide, Some("pla"))
        .into_iter()
        .map(|i| i.code)
        .collect();
    assert_eq!(wide_codes, ["smart_layer_max_high"]);
}

#[test]
fn silk_caps_speeds_and_keeps_smart_layer_bounds_in_its_window() {
    let mut cfg = base();
    for (k, v) in [
        ("smart_layer", json!("quality")),
        ("smart_layer_min_height", json!(0.1)),
        ("smart_layer_max_height", json!(0.3)),
    ] {
        cfg = PrintConfig::merged(&[&cfg, &config_from(&json!({ k: v }))]);
    }
    let plan = plan_settings(
        &setup("pla"),
        &setup("pla_silk"),
        Some(&cfg),
        &PlanOptions::default(),
    );
    let change = |k: &str| {
        plan.changes
            .iter()
            .find(|c| c.key == k)
            .map(|c| c.after.to_json())
    };
    assert_eq!(change("outer_wall_speed"), Some(json!([60, 60])));
    assert_eq!(change("smart_layer_min_height"), Some(json!(0.12)));
    assert_eq!(change("smart_layer_max_height"), Some(json!(0.2)));
    assert!(
        plan.advice
            .iter()
            .any(|a| a.text.contains("Silk shine hides layer lines"))
    );
    let unchanged = plan_settings(
        &setup("pla"),
        &setup("pla_silk"),
        Some(&base()),
        &PlanOptions::default(),
    );
    assert!(!unchanged.advice.iter().any(|a| a.text.contains("Silk shine")));
}
