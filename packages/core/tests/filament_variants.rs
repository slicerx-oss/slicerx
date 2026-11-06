// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
use serde_json::{Value, json};
use sx_core::api::PrintConfig;

fn project() -> Value {
    json!({
        "filament_settings_id": ["one", "two"],
        "filament_self_index": ["2", "1", "2", "1"],
        "filament_extruder_variant": ["Direct Drive High Flow", "Direct Drive Standard", "Direct Drive Standard", "Direct Drive High Flow"],
        "extruder_type": ["Direct Drive", "Direct Drive"],
        "nozzle_volume_type": ["Standard", "High Flow"],
        "nozzle_diameter": [0.4, 0.6],
        "filament_map": [2, 1],
        "filament_max_volumetric_speed": [42, 11, 22, 31],
        "nozzle_temperature": [242, 211, 222, 231],
        "filament_retraction_length": [0.9, 0.8, 0.4, "nil"],
        "retraction_length": 0.7,
        "print_extruder_id": ["2", "1", "2", "1"],
        "print_extruder_variant": ["Direct Drive High Flow", "Direct Drive Standard", "Direct Drive Standard", "Direct Drive High Flow"],
        "outer_wall_speed": [210, 100, 110, 200],
        "future_values": [1, 2, 3, 4]
    })
}

#[test]
fn identities_select_typed_raw_and_inherited_values() {
    let c = PrintConfig::from_value(&project()).unwrap();
    assert_eq!(c.nozzle_temperature, [231.0, 222.0]);
    assert_eq!(c.raw.get("filament_max_volumetric_speed"), Some(&json!([31, 22])));
    assert_eq!(c.raw.get("outer_wall_speed"), Some(&json!([100, 210])));
    assert!((c.outer_wall_speed - 100.0).abs() < f64::EPSILON);
    assert!((c.filament_retraction_length(1) - 0.7).abs() < f64::EPSILON);
    assert!((c.filament_retraction_length(2) - 0.4).abs() < f64::EPSILON);
    assert_eq!(c.raw.get("nozzle_diameter"), Some(&json!([0.4, 0.6])));
    assert_eq!(c.raw.get("future_values"), Some(&json!([1, 2, 3, 4])));
    assert_eq!(
        c.raw.get("filament_self_index"),
        project().get("filament_self_index")
    );
}

#[test]
fn later_selection_keeps_sources_and_explicit_overrides() {
    let mut c = PrintConfig::from_value(&project()).unwrap();
    c.apply_value(&json!({"filament_map": [1, 2]})).unwrap();
    assert_eq!(c.nozzle_temperature, [211.0, 242.0]);
    c.apply_value(&json!({"filament_max_volumetric_speed": [9, 8]}))
        .unwrap();
    c.apply_value(&json!({"nozzle_volume_type": ["Standard", "Standard"]}))
        .unwrap();
    assert_eq!(c.nozzle_temperature, [211.0, 222.0]);
    assert_eq!(c.raw.get("filament_max_volumetric_speed"), Some(&json!([9, 8])));
    assert_eq!(c.raw.get("outer_wall_speed"), Some(&json!([100, 110])));
}

#[test]
fn ambiguous_variants_are_not_dropped_by_lenient_import() {
    let mut raw = project();
    raw["filament_extruder_variant"] = json!(vec!["Direct Drive Standard"; 4]);
    let mut c = PrintConfig::default();
    assert!(c.apply_value_lenient(&raw).is_err());
    assert_eq!(c, PrintConfig::default());
}

#[test]
fn invalid_mapping_is_atomic() {
    for map in [json!([0, 1]), json!([3, 1]), json!([1]), json!(["01", 1])] {
        let mut c = PrintConfig::from_value(&project()).unwrap();
        let before = c.clone();
        assert!(c.apply_value_lenient(&json!({"filament_map": map})).is_err());
        assert_eq!(c, before);
    }
}

#[test]
fn unequal_groups_use_explicit_owners() {
    let mut raw = project();
    raw["filament_self_index"] = json!([2, 1, 2]);
    raw["filament_extruder_variant"] = json!([
        "Direct Drive High Flow",
        "Direct Drive High Flow",
        "Direct Drive Standard"
    ]);
    raw["nozzle_temperature"] = json!([242, 231, 222]);
    let c = PrintConfig::from_value(&raw).unwrap();
    assert_eq!(c.nozzle_temperature, [231.0, 222.0]);
    raw.as_object_mut().unwrap().remove("filament_self_index");
    assert!(PrintConfig::from_value(&raw).is_err());
}

#[test]
fn legacy_groups_require_unique_matching_labels() {
    let mut raw = project();
    raw.as_object_mut().unwrap().remove("filament_self_index");
    raw["filament_extruder_variant"] = json!([
        "Direct Drive Standard",
        "Direct Drive High Flow",
        "Direct Drive Standard",
        "Direct Drive High Flow"
    ]);
    raw["nozzle_temperature"] = json!([211, 231, 222, 242]);
    let c = PrintConfig::from_value(&raw).unwrap();
    assert_eq!(c.nozzle_temperature, [231.0, 222.0]);
    raw["filament_extruder_variant"][3] = json!("Direct Drive Standard");
    assert!(PrintConfig::from_value(&raw).is_err());
}

#[test]
fn metadata_can_arrive_after_expanded_values() {
    let mut raw = project();
    let temperatures = raw.as_object_mut().unwrap().remove("nozzle_temperature").unwrap();
    let mut c = PrintConfig::from_value(&json!({"nozzle_temperature": temperatures})).unwrap();
    c.apply_value(&raw).unwrap();
    assert_eq!(c.nozzle_temperature, [231.0, 222.0]);
    let before = c.clone();
    c.apply_value(&json!({})).unwrap();
    assert_eq!(c, before);
}

#[test]
fn missing_process_identity_is_rejected() {
    let mut raw = project();
    raw["print_extruder_id"] = json!([3, 1, 3, 1]);
    assert!(PrintConfig::from_value(&raw).is_err());
}

/// A Bambu Lab H3C project as Bambu Studio 2.9.1 saves it: one extruder holding nine hotends, the PLA filaments listed
/// with a Standard and a High Flow variant, the 2.85 mm TPU with its TPU285 variant only, each filament on a hotend by
/// hand (`filament_nozzle_map`, from 0; hotend 7 is the TPU285 one).
fn h3c() -> Value {
    json!({
        "filament_settings_id": ["pla", "pla", "pla", "tpu"],
        "filament_diameter": [1.75, 1.75, 1.75, 2.85],
        "nozzle_diameter": [0.4],
        "extruder_type": ["Direct Drive"],
        "nozzle_volume_type": ["Standard"],
        "default_nozzle_volume_type": ["Standard", "Standard", "Standard", "Standard", "Standard", "Standard", "Standard", "TPU285", "Standard"],
        "extruder_max_nozzle_count": [9],
        "filament_map": [1, 1, 1, 1],
        "filament_nozzle_map": [0, 2, 6, 7],
        "filament_self_index": ["1", "1", "2", "2", "3", "3", "4"],
        "filament_extruder_variant": ["Direct Drive Standard", "Direct Drive High Flow", "Direct Drive Standard", "Direct Drive High Flow", "Direct Drive Standard", "Direct Drive High Flow", "Direct Drive TPU285"],
        "filament_max_volumetric_speed": [21, 41, 22, 42, 23, 43, 9],
        "print_extruder_id": ["1", "1", "1"],
        "print_extruder_variant": ["Direct Drive Standard", "Direct Drive High Flow", "Direct Drive TPU285"],
        "outer_wall_speed": [200, 500, 150]
    })
}

#[test]
fn hotend_tools_pick_each_filament_variant_from_its_hotend() {
    let c = PrintConfig::from_value(&h3c()).unwrap();
    assert_eq!(
        c.raw.get("filament_max_volumetric_speed"),
        Some(&json!([21, 22, 23, 9]))
    );
    assert_eq!(c.raw.get("outer_wall_speed"), Some(&json!([200])));
}

/// The same project after the printer's hotends are read in: the printer names each hotend's type
/// (`extruder_nozzle_volume_type`) and calls the extruder Hybrid, a type no variant lists.
#[test]
fn hotend_tools_read_the_types_a_synced_project_gives() {
    let mut raw = h3c();
    let o = raw.as_object_mut().unwrap();
    o.remove("default_nozzle_volume_type");
    o.insert("nozzle_volume_type".into(), json!(["Hybrid"]));
    o.insert(
        "extruder_nozzle_volume_type".into(),
        json!([
            "Standard", "Standard", "Standard", "Standard", "Standard", "Standard", "Standard", "TPU285",
            "Standard"
        ]),
    );
    o.insert("extruder_nozzle_stats_new".into(), json!(["Standard#8|TPU285#1"]));
    let c = PrintConfig::from_value(&raw).unwrap();
    assert_eq!(
        c.raw.get("filament_max_volumetric_speed"),
        Some(&json!([21, 22, 23, 9]))
    );
    assert_eq!(c.raw.get("outer_wall_speed"), Some(&json!([200])));
}
