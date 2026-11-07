// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The prime tower line width (`prime_tower_line_width`) and the first layer's infill width
//! (`initial_layer_infill_line_width`) are settings the importer keeps, from a project file and from a profile,
//! instead of dropping them as keys from another slicer. Neither has a default.

use serde_json::json;
use sx_settings::{import_orca, import_project, setting_def};

const KEYS: [&str; 2] = ["prime_tower_line_width", "initial_layer_infill_line_width"];

#[test]
fn they_are_process_settings_with_no_default() {
    for k in KEYS {
        let d = setting_def(k).expect("in the schema");
        assert!(d.default.is_null(), "{k}: {:?}", d.default);
    }
}

#[test]
fn a_project_keeps_them() {
    let p = import_project(
        &json!({ "prime_tower_line_width": "0.8", "initial_layer_infill_line_width": "0.6", "layer_height": "0.2" }),
        None,
        None,
    )
    .expect("imports");
    let c = p.config.to_json();
    assert_eq!(c["prime_tower_line_width"], json!(0.8));
    assert_eq!(c["initial_layer_infill_line_width"], json!(0.6));
    for list in [&p.unknown_keys, &p.ignored_keys, &p.invalid_keys] {
        assert!(!list.iter().any(|k| KEYS.contains(&k.as_str())), "{list:?}");
    }
}

#[test]
fn a_process_profile_keeps_them() {
    let profile = json!({
        "type": "process",
        "name": "Wide tower",
        "prime_tower_line_width": "0.6",
        "initial_layer_infill_line_width": "0.25",
    });
    let r = import_orca(&profile, &|_| None).expect("imports");
    let c = r.config.to_json();
    assert_eq!(c["prime_tower_line_width"], json!(0.6));
    assert_eq!(c["initial_layer_infill_line_width"], json!(0.25));
    assert!(
        !r.ignored_keys.iter().any(|k| KEYS.contains(&k.as_str())),
        "{:?}",
        r.ignored_keys
    );
}
