// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
mod common;

use std::collections::HashSet;

use common::read_json;
use sx_settings::{Section, SettingType, Value, easy_keys, setting_def, settings};

#[test]
fn covers_orca_broadly() {
    let all = settings();
    assert!(all.len() > 600);
    let count = |s: Section| all.iter().filter(|d| d.section == s).count();
    assert!(count(Section::Process) > 300 && count(Section::Filament) > 100 && count(Section::Printer) > 100);
}

#[test]
fn entries_are_complete_and_unique() {
    let mut seen = HashSet::new();
    for d in settings() {
        assert!(seen.insert(d.key.clone()), "{}", d.key);
        assert!(!d.label.is_empty() && !d.group.is_empty(), "{}", d.key);
    }
}

#[test]
fn defaults_match_the_type_and_range() {
    for d in settings() {
        let v = &d.default;
        match d.kind {
            SettingType::Float | SettingType::Int | SettingType::Percent => {
                assert!(v.is_number(), "{}", d.key);
            }
            SettingType::Bool => {
                assert!(v.is_boolean(), "{}", d.key);
            }
            SettingType::FloatOrPercent | SettingType::String | SettingType::Gcode => {
                assert!(v.is_string(), "{}", d.key);
            }
            k if k.is_vector() => {
                assert!(v.is_array(), "{}", d.key);
            }
            _ => {}
        }
        if let (Some(lo), Some(hi)) = (d.min, d.max) {
            assert!(lo <= hi, "{}", d.key);
        }
        if d.kind == SettingType::Enum && !d.enum_values.is_empty() {
            assert!(
                d.enum_values.iter().any(|e| Some(e.as_str()) == v.as_str()),
                "{}",
                d.key
            );
        }
        assert!(Value::from_json(v).is_some(), "{}", d.key);
    }
}

#[test]
fn dependencies_and_easy_rules_name_real_keys() {
    for d in settings() {
        for c in &d.enabled_when {
            assert!(setting_def(&c.key).is_some(), "{} depends on {}", d.key, c.key);
        }
    }
    for k in easy_keys() {
        assert!(setting_def(k).is_some(), "{k}");
    }
}

#[test]
fn same_bounds_and_type_as_the_knowledge_catalog() {
    let norm = |t: &str| {
        match t {
            "floats" => "float",
            "ints" => "int",
            "bools" => "bool",
            "percents" => "percent",
            "strings" | "gcode" => "string",
            "enums" => "enum",
            "floatOrPercent" | "floatsOrPercents" | "percent_or_mm" | "percent_or_mm_s"
            | "percent_or_mm_s2" => "fop",
            other => other,
        }
        .to_owned()
    };
    // The catalog writes these fan keys as percent, a unit; Orca stores them as int or float lists.
    let known: HashSet<&str> = [
        "additional_cooling_fan_speed",
        "fan_max_speed",
        "fan_min_speed",
        "overhang_fan_speed",
    ]
    .into_iter()
    .collect();
    let fx = read_json("fixtures/knowledge-catalog.json");
    let mut matched = 0;
    let mut missing = Vec::new();
    for (key, k) in fx["settings"].as_object().unwrap() {
        let Some(d) = setting_def(key) else {
            missing.push(key.clone());
            continue;
        };
        matched += 1;
        if let Some(min) = k["min"].as_f64() {
            assert_eq!(d.min, Some(min), "{key} min");
        }
        if let Some(max) = k["max"].as_f64() {
            assert_eq!(d.max, Some(max), "{key} max");
        }
        if let (Some(t), false) = (k["type"].as_str(), known.contains(key.as_str())) {
            let ours = serde_json::to_value(d.kind).unwrap();
            assert_eq!(norm(ours.as_str().unwrap()), norm(t), "{key} type");
        }
    }
    missing.sort();
    assert!(matched > 120);
    assert_eq!(missing, ["curr_bed_type", "flush_multiplier"]);
}

#[test]
fn tiers_hide_profile_keys_and_gate_multicolor_keys() {
    use sx_settings::{Mode, is_visible, settings_for_tier};
    assert_eq!(setting_def("inherits").map(|d| d.mode), Some(Mode::Hidden));
    let tower = setting_def("enable_prime_tower").unwrap();
    assert!(!is_visible(tower, 1) && is_visible(tower, 2));
    let advanced = settings_for_tier(Section::Process, Mode::Advanced, 1);
    assert!(
        advanced
            .iter()
            .all(|d| d.key != "inherits" && d.intent.as_deref() != Some("multicolor"))
    );
    assert!(
        (60..=90).contains(
            &settings_for_tier(Section::Process, Mode::Advanced, 3)
                .iter()
                .filter(|d| d.mode == Mode::Advanced)
                .count()
        )
    );
}
