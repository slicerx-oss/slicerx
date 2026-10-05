// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
mod common;

use common::{config_from, load_profile};
use serde_json::json;
use sx_settings::{
    ChangeKind, EasyGoal, PrintConfig, SliceStage, Value, apply_easy, diff_configs, first_stage,
    format_value, goal_easy, setting_def,
};

#[test]
fn equal_configs_have_no_diff() {
    let a = config_from(&json!({"layer_height": 0.2, "a": [1, 2]}));
    assert!(diff_configs(&a, &a.clone(), None).is_empty());
    let b = config_from(&json!({"layer_height": 0.2, "a": [1, 2]}));
    assert!(diff_configs(&a, &b, None).is_empty());
}

#[test]
fn explains_a_numeric_change_with_its_effect() {
    let d = diff_configs(
        &config_from(&json!({"layer_height": 0.2})),
        &config_from(&json!({"layer_height": 0.12})),
        None,
    );
    assert_eq!(d.len(), 1);
    assert_eq!(
        (d[0].key.as_str(), d[0].kind, d[0].stage),
        ("layer_height", ChangeKind::Changed, SliceStage::Layers)
    );
    assert!(d[0].reason.contains("0.2 mm to 0.12 mm"), "{}", d[0].reason);
    assert!(d[0].reason.contains("Thinner layers"));
}

#[test]
fn says_when_a_dependency_switches_the_key_off() {
    let d = diff_configs(
        &config_from(&json!({"sparse_infill_density": 0, "sparse_infill_pattern": "grid"})),
        &config_from(&json!({"sparse_infill_density": 0, "sparse_infill_pattern": "gyroid"})),
        None,
    );
    assert!(
        d[0].reason.contains("no effect while Infill density is 0%"),
        "{}",
        d[0].reason
    );
}

#[test]
fn added_removed_and_ordering() {
    let d = diff_configs(
        &config_from(&json!({"wall_loops": 2})),
        &config_from(&json!({"enable_support": true})),
        None,
    );
    let mut kinds: Vec<(String, ChangeKind)> = d.iter().map(|x| (x.key.clone(), x.kind)).collect();
    kinds.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        kinds,
        [
            ("enable_support".to_owned(), ChangeKind::Added),
            ("wall_loops".to_owned(), ChangeKind::Removed)
        ]
    );
    let d = diff_configs(
        &config_from(&json!({"outer_wall_speed": [100], "wall_loops": 2, "layer_height": 0.2})),
        &config_from(&json!({"outer_wall_speed": [200], "wall_loops": 3, "layer_height": 0.16})),
        None,
    );
    let stages: Vec<SliceStage> = d.iter().map(|x| x.stage).collect();
    assert_eq!(
        stages,
        [SliceStage::Layers, SliceStage::Perimeters, SliceStage::Gcode]
    );
    assert_eq!(first_stage(&d), Some(SliceStage::Layers));
    assert_eq!(first_stage(&[]), None);
}

#[test]
fn easy_driven_keys_are_attributed_to_their_control() {
    let base = PrintConfig::merged(&[
        &load_profile("demo", "Demo Printer 0.4 nozzle").config,
        &load_profile("demo", "Demo PLA").config,
        &load_profile("demo", "0.20mm Standard @Demo").config,
    ]);
    let mut easy = goal_easy(EasyGoal::Fine);
    easy.speed = sx_settings::SpeedPreset::Fast;
    let d = diff_configs(&base, &apply_easy(&easy, &base), Some(&easy));
    let reason = |k: &str| d.iter().find(|x| x.key == k).map(|x| x.reason.clone()).unwrap();
    assert_eq!(
        reason("layer_height"),
        "Layer height follows the Detail control (80)."
    );
    assert!(reason("wall_loops").contains("Strength"));
    assert!(reason("outer_wall_speed").contains("Speed"));
}

#[test]
fn compares_real_profiles() {
    let a = load_profile("demo", "0.20mm Standard @Demo").config;
    let b = load_profile("demo", "0.12mm Fine @Demo").config;
    let d = diff_configs(&a, &b, None);
    let lh = d.iter().find(|x| x.key == "layer_height").unwrap();
    assert_eq!(
        (lh.before.clone(), lh.after.clone()),
        (Some(Value::Float(0.2)), Some(Value::Float(0.12)))
    );
    assert!(d.iter().all(|x| !x.reason.is_empty()));
}

#[test]
fn formats_values() {
    assert_eq!(
        format_value(setting_def("layer_height"), Some(&Value::Float(0.2))),
        "0.2 mm"
    );
    assert_eq!(
        format_value(setting_def("enable_support"), Some(&Value::Bool(true))),
        "on"
    );
    assert_eq!(
        format_value(
            setting_def("nozzle_temperature"),
            Some(&Value::Ints(vec![220, 220]))
        ),
        "220 C"
    );
    assert_eq!(
        format_value(
            setting_def("outer_wall_speed"),
            Some(&Value::Floats(vec![200.0, 350.0]))
        ),
        "200, 350"
    );
    assert_eq!(format_value(None, None), "not set");
}

#[test]
fn enum_values_read_as_their_labels() {
    let text = |key: &str, v: Value| format_value(setting_def(key), Some(&v));
    assert_eq!(
        text("brim_type", Value::Str("outer_only".into())),
        "Outer brim only"
    );
    assert_eq!(text("gcode_flavor", Value::Str("marlin2".into())), "Marlin 2");
    assert_eq!(text("wall_generator", Value::Str("athena".into())), "aegis");
    assert_eq!(
        text("z_hop_types", Value::Strs(vec!["Spiral Lift".into(); 2])),
        "Spiral"
    );
    assert_eq!(
        text(
            "z_hop_types",
            Value::Strs(vec!["Auto Lift".into(), "Slope Lift".into()])
        ),
        "Auto, Slope"
    );
    // a value the schema does not list stays as it is
    assert_eq!(text("brim_type", Value::Str("odd".into())), "odd");
}
