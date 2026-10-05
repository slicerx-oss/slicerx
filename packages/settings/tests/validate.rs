// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
mod common;

use common::{config_from, read_json};
use serde_json::json;
use sx_settings::{PrintConfig, Severity, Value, disabled_keys, is_enabled, setting_def, validate};

#[test]
fn every_case_in_validate_cases_json_passes() {
    let fx = read_json("fixtures/validate-cases.json");
    for c in fx["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let mut codes: Vec<String> = validate(&config_from(&c["config"]))
            .into_iter()
            .map(|i| i.code)
            .collect();
        codes.sort();
        let want: Vec<String> = c["codes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(codes, want, "{name}");
    }
}

#[test]
fn errors_come_first_and_fixes_are_suggestions() {
    let cfg = config_from(
        &json!({"nozzle_diameter": [0.4], "layer_height": 0.5, "spiral_mode": true, "enable_support": true}),
    );
    let issues = validate(&cfg);
    assert_eq!(issues[0].severity, Severity::Error);
    let fix = issues
        .iter()
        .find(|i| i.code == "layer_above_nozzle")
        .and_then(|i| i.fix.clone())
        .unwrap();
    assert_eq!(fix.key, "layer_height");
    assert_eq!(fix.value.to_json(), json!(0.3));
    assert_eq!(cfg.get("layer_height"), Some(&Value::Float(0.5)));
}

#[test]
fn dependencies() {
    let d = |k: &str| setting_def(k).unwrap();
    let cfg = config_from(&json!({"sparse_infill_density": 0, "enable_support": false, "wall_loops": 2}));
    assert!(!is_enabled(d("sparse_infill_pattern"), &cfg));
    assert!(!is_enabled(d("support_type"), &cfg));
    assert!(is_enabled(d("outer_wall_speed"), &cfg));
    let mut with = cfg.clone();
    with.set("sparse_infill_pattern", Value::Str("grid".into()));
    with.set("support_type", Value::Str("tree(auto)".into()));
    let off = disabled_keys(&with);
    assert!(off.contains(&"sparse_infill_pattern".to_owned()) && off.contains(&"support_type".to_owned()));
    let on = config_from(
        &json!({"enable_support": true, "support_type": "tree(auto)", "support_threshold_angle": 0}),
    );
    assert!(is_enabled(d("support_threshold_angle"), &on));
    assert!(is_enabled(d("support_threshold_overlap"), &on));
    let mut brim = PrintConfig::new();
    brim.set("brim_type", Value::Str("auto_brim".into()));
    assert!(!is_enabled(d("brim_width"), &brim));
    brim.set("brim_type", Value::Str("outer_only".into()));
    assert!(is_enabled(d("brim_width"), &brim));
}

#[test]
fn zero_is_allowed_where_it_means_auto() {
    let cfg =
        config_from(&json!({"line_width": "0", "outer_wall_line_width": "0", "inner_wall_line_width": "0"}));
    assert!(validate(&cfg).is_empty());
    assert!(setting_def("line_width").is_some_and(|d| d.auto));
    let small = config_from(&json!({"line_width": "0.02"}));
    assert_eq!(
        validate(&small)
            .iter()
            .map(|i| i.code.as_str())
            .collect::<Vec<_>>(),
        ["line_width_range", "outside_recommended_range"]
    );
}

#[test]
fn schema_defaults_have_no_errors() {
    let mut cfg = PrintConfig::new();
    for d in sx_settings::settings() {
        if let Some(v) = Value::from_json(&d.default) {
            cfg.set(d.key.clone(), v);
        }
    }
    let errors: Vec<String> = validate(&cfg)
        .into_iter()
        .filter(|i| i.severity == Severity::Error)
        .map(|i| i.message)
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
}
