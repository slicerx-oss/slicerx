// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
mod common;

use common::{config_from, json_eq, read_json};
use sx_settings::{
    EasyGoal, EasySettings, apply_choice, apply_easy, choice_value, derive_shell_layers, easy_choices,
    easy_control_for, easy_keys, goal_easy, match_goal, setting_def,
};

#[test]
fn every_case_in_easy_cases_json_passes() {
    let fx = read_json("fixtures/easy-cases.json");
    let cases = fx["cases"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let base = config_from(&fx["bases"][c["base"].as_str().unwrap()]);
        let easy: EasySettings = serde_json::from_value(c["easy"].clone()).unwrap();
        let out = apply_easy(&easy, &base).to_json();
        for (k, want) in c["expect"].as_object().unwrap() {
            assert!(json_eq(&out[k], want), "{name}: {k}: got {} want {want}", out[k]);
        }
    }
}

#[test]
fn does_not_touch_keys_it_does_not_own() {
    let fx = read_json("fixtures/easy-cases.json");
    let base = config_from(&fx["bases"]["bare"]);
    let out = apply_easy(&EasySettings::default(), &base);
    assert_eq!(out.to_json()["sparse_infill_pattern"], "gyroid");
    assert_eq!(base.to_json().as_object().unwrap().len(), 1);
}

#[test]
fn goals_match_the_concept_table() {
    let expect = [
        (EasyGoal::Draft, 0.0, 10.0),
        (EasyGoal::Standard, 40.0, 20.0),
        (EasyGoal::Fine, 80.0, 30.0),
        (EasyGoal::Strong, 40.0, 85.0),
    ];
    for (g, d, s) in expect {
        let e = goal_easy(g);
        assert!((e.detail - d).abs() < f64::EPSILON && (e.strength - s).abs() < f64::EPSILON);
        assert_eq!(match_goal(&e), Some(g));
    }
    assert_eq!(goal_easy(EasyGoal::Standard), EasySettings::default());
    assert_eq!(
        match_goal(&EasySettings {
            detail: 55.0,
            ..EasySettings::default()
        }),
        None
    );
}

#[test]
fn easy_keys_exist_in_the_schema_and_are_flagged() {
    for k in easy_keys() {
        assert!(setting_def(k).is_some_and(|d| d.easy), "{k}");
    }
    assert_eq!(easy_control_for("layer_height"), Some("detail"));
    assert_eq!(easy_control_for("outer_wall_speed"), Some("speed"));
    assert_eq!(easy_control_for("gyroid"), None);
}

#[test]
fn old_easy_values_still_deserialize() {
    let old: EasySettings = serde_json::from_value(serde_json::json!({
        "detail": 40, "strength": 20, "speed": "ludicrous", "supports": "everywhere", "brim": true, "smartLayer": "strength"
    }))
    .unwrap();
    let new: EasySettings = serde_json::from_value(serde_json::json!({
        "detail": 40, "strength": 20, "speed": "fastest", "supports": "auto", "brim": true, "varyLayerHeight": true
    }))
    .unwrap();
    assert_eq!(old.speed, new.speed);
    assert_eq!(old.supports, new.supports);
    assert!(old.varies() && new.varies());
}

#[test]
fn choices_read_back_and_shells_derive() {
    let base = config_from(&serde_json::json!({ "layer_height": 0.2 }));
    for (choice, values) in easy_choices() {
        for v in values {
            assert_eq!(
                choice_value(&apply_choice(&base, choice, v), choice),
                Some(v),
                "{choice} {v}"
            );
        }
    }
    let c = config_from(
        &serde_json::json!({ "layer_height": 0.12, "top_shell_thickness": 1.0, "bottom_shell_thickness": 0.5 }),
    );
    let j = derive_shell_layers(&c).to_json();
    assert_eq!(j["top_shell_layers"], 9);
    assert_eq!(j["bottom_shell_layers"], 5);
}
