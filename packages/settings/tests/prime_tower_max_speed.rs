// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `prime_tower_max_speed` (Bambu Lab's cap on the prime tower's speeds) is a setting the importer keeps, from a
//! project file and from a profile, instead of dropping it as a key from another slicer.

use serde_json::json;
use sx_settings::{import_orca, import_project, setting_def};

#[test]
fn it_is_a_process_setting_in_mm_per_s_at_90_by_default() {
    let def = setting_def("prime_tower_max_speed").expect("in the schema");
    assert_eq!(def.default, json!(90));
}

#[test]
fn a_project_keeps_it() {
    let p = import_project(
        &json!({ "prime_tower_max_speed": "50", "layer_height": "0.2" }),
        None,
        None,
    )
    .expect("imports");
    assert_eq!(p.config.to_json()["prime_tower_max_speed"], json!(50));
    for list in [&p.unknown_keys, &p.ignored_keys, &p.invalid_keys] {
        assert!(!list.iter().any(|k| k == "prime_tower_max_speed"), "{list:?}");
    }
}

#[test]
fn a_process_profile_keeps_it() {
    let profile = json!({ "type": "process", "name": "Fast tower", "prime_tower_max_speed": "120" });
    let r = import_orca(&profile, &|_| None).expect("imports");
    assert_eq!(r.config.to_json()["prime_tower_max_speed"], json!(120));
    assert!(
        !r.ignored_keys.iter().any(|k| k == "prime_tower_max_speed"),
        "{:?}",
        r.ignored_keys
    );
}
