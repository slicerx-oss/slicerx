// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The floating vertical shell settings (`detect_floating_vertical_shell`, `vertical_shell_speed`) are settings the
//! importer keeps, from a project file and from a profile, instead of dropping them as keys from another slicer.

use serde_json::json;
use sx_settings::{import_orca, import_project, setting_def};

#[test]
fn they_are_process_settings_with_their_defaults() {
    let detect = setting_def("detect_floating_vertical_shell").expect("in the schema");
    assert_eq!(detect.default, json!(true));
    let speed = setting_def("vertical_shell_speed").expect("in the schema");
    assert_eq!(speed.default, json!(["80%"]));
}

#[test]
fn a_project_keeps_them() {
    let p = import_project(
        &json!({ "detect_floating_vertical_shell": "0", "vertical_shell_speed": ["60%"], "layer_height": "0.2" }),
        None,
        None,
    )
    .expect("imports");
    let c = p.config.to_json();
    assert_eq!(c["detect_floating_vertical_shell"], json!(false));
    assert_eq!(c["vertical_shell_speed"], json!(["60%"]));
    for list in [&p.unknown_keys, &p.ignored_keys, &p.invalid_keys] {
        assert!(
            !list
                .iter()
                .any(|k| k == "detect_floating_vertical_shell" || k == "vertical_shell_speed"),
            "{list:?}"
        );
    }
}

#[test]
fn a_process_profile_keeps_them() {
    let profile = json!({
        "type": "process",
        "name": "Slow shells",
        "detect_floating_vertical_shell": "1",
        "vertical_shell_speed": ["150"],
    });
    let r = import_orca(&profile, &|_| None).expect("imports");
    let c = r.config.to_json();
    assert_eq!(c["detect_floating_vertical_shell"], json!(true));
    assert_eq!(c["vertical_shell_speed"], json!(["150"]));
    assert!(
        !r.ignored_keys
            .iter()
            .any(|k| k == "detect_floating_vertical_shell" || k == "vertical_shell_speed"),
        "{:?}",
        r.ignored_keys
    );
}
