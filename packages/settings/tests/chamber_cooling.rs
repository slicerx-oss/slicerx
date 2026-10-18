// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `chamber_cooling_mode`, the chamber airflow the Snapmaker U1's Top Cover start G-code reads: a printer setting from
//! 0 to 2 with no default, so the slice picks it from the filaments unless a preset, a project or a client sets it.

use serde_json::json;
use sx_settings::{
    Mode, PrintConfig, Section, SettingType, Severity, Value, check_values, diff_configs, export_orca,
    import_orca, import_project, is_visible, setting_def,
};

const KEY: &str = "chamber_cooling_mode";

fn errors(v: &serde_json::Value) -> Vec<String> {
    check_values(&PrintConfig::from_json(&json!({ KEY: v })))
        .into_iter()
        .filter(|i| i.severity == Severity::Error)
        .map(|i| i.code)
        .collect()
}

#[test]
fn is_a_hidden_printer_setting_with_no_default() {
    let d = setting_def(KEY).expect("in the schema");
    assert_eq!(d.section, Section::Printer);
    assert_eq!(d.kind, SettingType::Int);
    assert_eq!((d.min, d.max), (Some(0.0), Some(2.0)));
    assert_eq!(d.mode, Mode::Hidden);
    assert!(d.default.is_null());
    assert!(!is_visible(d, 3));
    assert!(serde_json::to_value(d).unwrap().get("default").is_none());
}

#[test]
fn survives_a_printer_preset_import() {
    for raw in [json!("0"), json!(0), json!(["0"])] {
        let preset = json!({ "type": "machine", "name": "My U1 Top Cover", "from": "User", KEY: raw });
        let p = import_orca(&preset, &|_| None).expect("imports");
        assert_eq!(p.section, Section::Printer);
        assert_eq!(p.config.get(KEY), Some(&Value::Int(0)), "{raw}");
        assert!(p.unknown_keys.is_empty() && p.invalid_keys.is_empty(), "{raw}");
        assert_eq!(
            export_orca(&p.config, "My U1 Top Cover", Section::Printer, None)[KEY],
            json!("0")
        );
    }
}

#[test]
fn is_worked_out_again_once_a_change_is_undone() {
    let before = PrintConfig::from_json(&json!({ KEY: 0 }));
    let d = diff_configs(&before, &PrintConfig::new(), None);
    assert_eq!(
        d.first().map(|e| e.reason.as_str()),
        Some("Chamber cooling mode is no longer set; it is worked out when slicing.")
    );
}

#[test]
fn is_read_from_a_project_as_a_setting() {
    let p = import_project(&json!({ KEY: "2", "layer_height": "0.2" }), None, None).expect("imports");
    assert_eq!(p.config.get(KEY), Some(&Value::Int(2)));
}

#[test]
fn refuses_values_outside_0_to_2_and_text_as_other_whole_numbers() {
    for ok in [0, 1, 2] {
        assert!(errors(&json!(ok)).is_empty(), "{ok}");
    }
    assert_eq!(errors(&json!(3)), ["out_of_range"]);
    assert_eq!(errors(&json!(-1)), ["out_of_range"]);
    assert_eq!(errors(&json!("strong")), ["wrong_type"]);
    let pwm = |v| {
        check_values(&PrintConfig::from_json(&json!({ "part_cooling_fan_min_pwm": v })))
            .into_iter()
            .map(|i| i.code)
            .collect::<Vec<_>>()
    };
    assert_eq!(pwm(json!(101)), ["out_of_range"]);
    assert_eq!(pwm(json!("x")), ["wrong_type"]);
    let text = import_orca(
        &json!({ "type": "machine", "name": "U1", KEY: "strong" }),
        &|_| None,
    )
    .expect("imports");
    assert!(text.config.get(KEY).is_none());
    assert_eq!(text.invalid_keys.iter().collect::<Vec<_>>(), [KEY]);
}
