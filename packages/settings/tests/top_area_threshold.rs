// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `top_area_threshold` (how wide a step under a single-wall top must be before it gets a band of walls) is a
//! setting the importer keeps, from a project file and from a profile, instead of dropping it as an obsolete key.
//! It is a percent of the wall width or a width in mm, as the engine reads it, so the value passes through as text.

use serde_json::json;
use sx_settings::{import_orca, import_project, setting_def};

#[test]
fn it_is_a_process_setting_at_200_percent_by_default() {
    let def = setting_def("top_area_threshold").expect("in the schema");
    assert_eq!(def.default, json!("200%"));
}

#[test]
fn a_project_keeps_it() {
    let p = import_project(
        &json!({ "top_area_threshold": "100%", "layer_height": "0.2" }),
        None,
        None,
    )
    .expect("imports");
    assert_eq!(p.config.to_json()["top_area_threshold"], json!("100%"));
    for list in [&p.unknown_keys, &p.ignored_keys, &p.invalid_keys] {
        assert!(!list.iter().any(|k| k == "top_area_threshold"), "{list:?}");
    }
}

#[test]
fn a_project_keeps_a_width_in_mm() {
    let p = import_project(&json!({ "top_area_threshold": "0.9" }), None, None).expect("imports");
    assert_eq!(p.config.to_json()["top_area_threshold"], json!("0.9"));
}

#[test]
fn a_process_profile_keeps_it() {
    let profile = json!({ "type": "process", "name": "Narrow bands", "top_area_threshold": "100%" });
    let r = import_orca(&profile, &|_| None).expect("imports");
    assert_eq!(r.config.to_json()["top_area_threshold"], json!("100%"));
    for list in [&r.unknown_keys, &r.ignored_keys, &r.invalid_keys] {
        assert!(!list.iter().any(|k| k == "top_area_threshold"), "{list:?}");
    }
}
