// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `overhang_totally_speed` (the speed of a wall piece that hangs fully clear of the layer below) is a setting the
//! importer keeps, from a project file and from a profile, instead of dropping it as an obsolete key. It is a speed in
//! mm/s per extruder; 0, the default, leaves those pieces at the bridge speed, as the engine reads it.

use serde_json::json;
use sx_settings::{import_orca, import_project, process_config, setting_def};

fn not_dropped(lists: [&Vec<String>; 3]) {
    for list in lists {
        assert!(!list.iter().any(|k| k == "overhang_totally_speed"), "{list:?}");
    }
}

#[test]
fn it_is_a_process_speed_at_0_by_default() {
    let def = setting_def("overhang_totally_speed").expect("in the schema");
    assert_eq!(def.default, json!([0]));
}

#[test]
fn a_project_keeps_it() {
    let p = import_project(
        &json!({ "overhang_totally_speed": "12", "layer_height": "0.2" }),
        None,
        None,
    )
    .expect("imports");
    assert_eq!(p.config.to_json()["overhang_totally_speed"], json!([12]));
    not_dropped([&p.unknown_keys, &p.ignored_keys, &p.invalid_keys]);
}

#[test]
fn a_project_keeps_one_value_per_extruder() {
    let p = import_project(&json!({ "overhang_totally_speed": ["10", "15"] }), None, None).expect("imports");
    assert_eq!(p.config.to_json()["overhang_totally_speed"], json!([10, 15]));
}

#[test]
fn a_process_profile_keeps_it() {
    let profile = json!({ "type": "process", "name": "Slow overhangs", "overhang_totally_speed": ["8"] });
    let r = import_orca(&profile, &|_| None).expect("imports");
    assert_eq!(r.config.to_json()["overhang_totally_speed"], json!([8]));
    not_dropped([&r.unknown_keys, &r.ignored_keys, &r.invalid_keys]);
}

#[test]
fn the_fine_tier_of_the_p2s_family_keeps_its_10_mm_s() {
    let c = process_config("fine", 0.4, Some("bambu-p2s")).expect("a preset");
    let v = c.to_json()["overhang_totally_speed"].clone();
    let speeds = v.as_array().expect("a list");
    assert!(
        !speeds.is_empty() && speeds.iter().all(|s| s == &json!(10)),
        "{v}"
    );
}
