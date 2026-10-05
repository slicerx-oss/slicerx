// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Material knowledge wired into the plan: thin layer guards, support pairings, first layer,
//! retraction speed and structure hints. Mirrors `js/thin-layers.test.ts`.
mod common;

use common::{config_from, load_profile};
use serde_json::json;
use sx_settings::{
    PlanOptions, PrintConfig, SettingsPlan, SetupRef, heat_creep_warning, plan_settings, validate_for,
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

fn merged() -> PrintConfig {
    PrintConfig::merged(&[
        &load_profile("demo", "Demo Printer 0.4 nozzle").config,
        &load_profile("demo", "Demo PLA").config,
        &load_profile("demo", "0.20mm Standard @Demo").config,
    ])
}

fn with(base: &PrintConfig, extra: &serde_json::Value) -> PrintConfig {
    PrintConfig::merged(&[base, &config_from(extra)])
}

fn thin() -> PrintConfig {
    with(
        &merged(),
        &json!({"smart_layer": "quality", "smart_layer_min_height": 0.08, "smart_layer_max_height": 0.2, "slow_down_layer_time": [2], "slow_down_min_speed": [10], "enable_support": true}),
    )
}

fn plan(from: &str, to: &str, base: &PrintConfig) -> SettingsPlan {
    plan_settings(&setup(from), &setup(to), Some(base), &PlanOptions::default())
}

fn after(p: &SettingsPlan, key: &str) -> Option<serde_json::Value> {
    p.changes.iter().find(|c| c.key == key).map(|c| c.after.to_json())
}

fn has_advice(p: &SettingsPlan, needle: &str) -> bool {
    p.advice.iter().any(|a| a.text.contains(needle))
}

#[test]
fn the_layer_time_guard_raises_the_layer_time_when_smart_layer_is_on() {
    let p = plan("pla", "hips", &thin());
    assert_eq!(after(&p, "slow_down_layer_time"), Some(json!([7])));
    assert!(has_advice(&p, "print more parts at once"));
    let off = plan("pla", "hips", &with(&thin(), &json!({"smart_layer": "off"})));
    assert_eq!(after(&off, "slow_down_layer_time"), Some(json!([6])));
}

#[test]
fn validate_checks_the_layer_time_against_the_guard() {
    let cfg = config_from(&json!({"smart_layer": "quality", "slow_down_layer_time": [2]}));
    let codes = |c: &PrintConfig, f: Option<&str>| -> Vec<String> {
        validate_for(c, f).into_iter().map(|i| i.code).collect()
    };
    assert!(codes(&cfg, Some("abs")).contains(&"smart_layer_min_layer_time".to_owned()));
    assert!(!codes(&cfg, None).contains(&"smart_layer_min_layer_time".to_owned()));
    let ok = config_from(&json!({"smart_layer": "quality", "slow_down_layer_time": [12]}));
    assert!(!codes(&ok, Some("abs")).contains(&"smart_layer_min_layer_time".to_owned()));
}

#[test]
fn heat_creep_fires_for_a_slowed_sliver_of_flow() {
    assert!(
        heat_creep_warning(10.0, 0.4, 0.08, 21.0)
            .is_some_and(|w| w.contains("0.32 mm3/s, 1.5 percent of the 21 mm3/s"))
    );
    assert!(heat_creep_warning(10.0, 0.42, 0.2, 21.0).is_none());
    assert!(heat_creep_warning(10.0, 0.4, 0.08, 0.0).is_none());
    let creepy = |p: &SettingsPlan| p.warnings.iter().any(|w| w.contains("heat creep"));
    assert!(creepy(&plan("pla", "pla", &thin())));
    let fixed = with(
        &merged(),
        &json!({"layer_height": 0.08, "slow_down_min_speed": [10]}),
    );
    assert!(creepy(&plan("pla", "pla", &fixed)));
    assert!(!creepy(&plan("pla", "pla", &merged())));
}

#[test]
fn supports_pair_with_the_material_on_a_switch() {
    let p = plan("pla", "hips", &thin());
    assert_eq!(after(&p, "support_top_z_distance"), Some(json!(0.1)));
    assert_eq!(after(&p, "support_interface_top_layers"), Some(json!(3)));
    assert!(has_advice(&p, "is the soluble support for HIPS") && has_advice(&p, "limonene"));
    let off = plan("pla", "hips", &with(&thin(), &json!({"enable_support": false})));
    assert_eq!(after(&off, "support_top_z_distance"), None);
    assert_eq!(
        after(&plan("pla", "pla", &thin()), "support_top_z_distance"),
        None
    );
}

#[test]
fn first_layer_and_retraction_speed_and_hints_follow_the_material() {
    let base = with(&merged(), &json!({"retraction_speed": [45]}));
    let p = plan("pla", "petg", &base);
    assert_eq!(after(&p, "retraction_speed"), Some(json!([30])));
    assert_eq!(after(&p, "initial_layer_speed"), Some(json!([30, 30])));
    assert!(has_advice(&p, "Do not squish PETG"));
    assert!(
        p.advice
            .iter()
            .any(|a| a.text.starts_with("PETG infill: gyroid pattern"))
    );
    assert!(!has_advice(
        &plan("petg", "petg", &merged()),
        "Do not squish PETG"
    ));
}
