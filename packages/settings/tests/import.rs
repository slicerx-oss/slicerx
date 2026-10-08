// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
mod common;

use common::{load_profile, read_json, vendors};
use serde_json::json;
use sx_settings::{EasySettings, Error, PrintConfig, Section, Value, apply_easy, export_orca, import_orca};

fn get_json(c: &PrintConfig, k: &str) -> serde_json::Value {
    c.to_json()[k].clone()
}

#[test]
fn process_profile_with_an_inherits_chain() {
    let r = load_profile("demo", "0.20mm Standard @Demo");
    assert_eq!(
        r.chain,
        [
            "0.20mm Standard @Demo",
            "fdm_demo_process_single_0.20",
            "fdm_demo_process_single_common",
            "fdm_demo_process_common"
        ]
    );
    assert_eq!(r.section, Section::Process);
    assert!(r.unknown_keys.is_empty(), "{:?}", r.unknown_keys);
    assert!(r.invalid_keys.is_empty(), "{:?}", r.invalid_keys);
    assert_eq!(r.ignored_keys, ["enable_height_slowdown"]);
    assert_eq!(get_json(&r.config, "layer_height"), json!(0.2));
    assert_eq!(get_json(&r.config, "wall_loops"), json!(2));
    assert_eq!(get_json(&r.config, "sparse_infill_density"), json!(15));
    assert_eq!(get_json(&r.config, "enable_support"), json!(false));
    assert_eq!(get_json(&r.config, "line_width"), json!("0.42"));
    assert_eq!(get_json(&r.config, "outer_wall_speed"), json!([200, 350]));
}

#[test]
fn child_overrides_parent() {
    let all = vendors();
    let by_name = all.get("demo").unwrap();
    let load = |n: &str| {
        by_name
            .get(n)
            .map(|rel| read_json(&format!("fixtures/profiles/{rel}")))
    };
    let parent = load("fdm_demo_process_single_0.20").unwrap();
    let alone = import_orca(&parent, &|n| load(n)).unwrap();
    assert_eq!(get_json(&alone.config, "outer_wall_speed"), json!([60, 60]));
    assert_eq!(
        get_json(
            &load_profile("demo", "0.20mm Standard @Demo").config,
            "outer_wall_speed"
        ),
        json!([200, 350])
    );
}

#[test]
fn printer_profile_geometry_lists_and_comma_strings() {
    let v = load_profile("demo", "Demo Printer 0.4 nozzle");
    assert_eq!(v.section, Section::Printer);
    assert_eq!(v.chain.len(), 3);
    assert!(v.unknown_keys.is_empty() && v.invalid_keys.is_empty());
    assert_eq!(
        get_json(&v.config, "printable_area"),
        json!([[0, 0], [256, 0], [256, 256], [0, 256]])
    );
    assert_eq!(get_json(&v.config, "printable_height"), json!(250));
    assert_eq!(get_json(&v.config, "nozzle_diameter"), json!([0.4]));
    assert_eq!(get_json(&v.config, "machine_min_travel_rate"), json!([0, 0]));
}

#[test]
fn nil_entries_are_left_out() {
    let r = load_profile("demo", "Demo PLA");
    assert!(r.nil_keys.contains(&"filament_retraction_length".to_owned()));
    assert!(!r.config.contains("filament_retraction_length"));
    assert_eq!(get_json(&r.config, "nozzle_temperature"), json!([220, 220]));
}

#[test]
fn every_fixture_profile_imports_cleanly() {
    let all = vendors();
    let mut names: Vec<&String> = all.keys().collect();
    names.sort();
    assert_eq!(names, ["demo"]);
    let mut count = 0;
    for (vendor, by_name) in &all {
        let load = |n: &str| {
            by_name
                .get(n)
                .map(|rel| read_json(&format!("fixtures/profiles/{rel}")))
        };
        for name in by_name.keys() {
            let r = import_orca(&load(name).unwrap(), &|n| load(n)).unwrap();
            assert!(r.unknown_keys.is_empty(), "{vendor}/{name}: {:?}", r.unknown_keys);
            assert!(r.invalid_keys.is_empty(), "{vendor}/{name}: {:?}", r.invalid_keys);
            count += 1;
        }
    }
    assert_eq!(count, 14);
}

#[test]
fn errors() {
    let a = json!({"name": "a", "inherits": "b"});
    let b = json!({"name": "b", "inherits": "a"});
    let cyc = import_orca(&a, &|n| Some(if n == "b" { b.clone() } else { a.clone() }));
    assert!(matches!(cyc, Err(Error::Cycle(_))));
    let missing = import_orca(&json!({"name": "x", "inherits": "nope"}), &|_| None);
    assert!(matches!(missing, Err(Error::MissingParent { ref parent, .. }) if parent == "nope"));
    assert_eq!(import_orca(&json!([]), &|_| None), Err(Error::NotObject));
    assert_eq!(import_orca(&json!("x"), &|_| None), Err(Error::NotObject));
}

#[test]
fn legacy_keys_and_values() {
    let r = import_orca(
        &json!({"name": "old", "type": "process", "enable_wipe_tower": "1", "support_type": "tree", "wall_infill_order": "outer wall/inner wall/infill"}),
        &|_| None,
    )
    .unwrap();
    assert_eq!(r.config.get("enable_prime_tower"), Some(&Value::Bool(true)));
    assert_eq!(
        r.config.get("support_type"),
        Some(&Value::Str("tree(manual)".into()))
    );
    assert_eq!(
        r.config.get("wall_sequence"),
        Some(&Value::Str("outer wall/inner wall".into()))
    );
    assert!(r.unknown_keys.is_empty());
}

#[test]
fn bambu_auto_sentinels() {
    // Bambu Studio writes -1 for auto: its raft first layer grows 2 mm, and its auto wall count is Orca's 0.
    let r = import_orca(
        &json!({"name": "bambu", "type": "process", "raft_first_layer_expansion": "-1", "tree_support_wall_count": "-1", "support_interface_bottom_layers": "-1"}),
        &|_| None,
    )
    .unwrap();
    assert_eq!(get_json(&r.config, "raft_first_layer_expansion"), json!(2.0));
    assert_eq!(get_json(&r.config, "tree_support_wall_count"), json!(0));
    assert_eq!(get_json(&r.config, "support_interface_bottom_layers"), json!(-1));
    assert!(r.invalid_keys.is_empty());
}

#[test]
fn unknown_and_bad_values_are_reported_not_guessed() {
    let r = import_orca(&json!({"name": "p", "type": "process", "made_up_key": "1", "layer_height": "thick", "wall_loops": "3"}), &|_| None).unwrap();
    assert_eq!(r.unknown_keys, ["made_up_key"]);
    assert_eq!(r.invalid_keys, ["layer_height"]);
    assert_eq!(r.config.get("wall_loops"), Some(&Value::Int(3)));
}

#[test]
fn comma_strings_percents_and_one_entry_lists() {
    let r = import_orca(&json!({"name": "p", "type": "machine", "machine_min_travel_rate": "0,0", "sparse_infill_density": "25%", "layer_height": ["0.16"]}), &|_| None).unwrap();
    assert_eq!(
        r.config.get("machine_min_travel_rate"),
        Some(&Value::Floats(vec![0.0, 0.0]))
    );
    assert_eq!(r.config.get("sparse_infill_density"), Some(&Value::Float(25.0)));
    assert_eq!(r.config.get("layer_height"), Some(&Value::Float(0.16)));
}

#[test]
fn export_round_trips() {
    let r = load_profile("demo", "0.20mm Standard @Demo");
    let json = export_orca(&r.config, "copy", Section::Process, Some(&r.chain[0]));
    assert_eq!(json["layer_height"], "0.2");
    assert_eq!(json["sparse_infill_density"], "15%");
    assert_eq!(json["enable_support"], "0");
    let all = vendors();
    let by_name = all.get("demo").unwrap();
    let again = import_orca(&json, &|n| {
        by_name
            .get(n)
            .map(|rel| read_json(&format!("fixtures/profiles/{rel}")))
    })
    .unwrap();
    assert!(again.unknown_keys.is_empty());
    for (k, v) in r.config.iter() {
        if let Some(w) = again.config.get(k) {
            assert_eq!(v.to_json(), w.to_json(), "{k}");
        }
    }
}

#[test]
fn easy_on_a_merged_real_setup_and_contract_fixture() {
    let cfg = PrintConfig::merged(&[
        &load_profile("demo", "Demo Printer 0.4 nozzle").config,
        &load_profile("demo", "Demo PLA").config,
        &load_profile("demo", "0.20mm Standard @Demo").config,
    ]);
    let out = apply_easy(&EasySettings::default(), &cfg);
    let j = out.to_json();
    assert_eq!(j["layer_height"], json!(0.2));
    assert_eq!(j["wall_loops"], json!(2));
    assert_eq!(j["sparse_infill_density"], json!(15));
    assert_eq!(j["top_shell_layers"], json!(5));
    assert_eq!(j["bottom_shell_layers"], json!(3));
    assert_eq!(j["brim_type"], json!("auto_brim"));
    // Round trip fixture for packages/contracts: a merged X1C setup and the Easy result.
    let dir = common::root().join("../contracts/fixtures");
    if dir.is_dir() {
        let body = json!({"comment": "Written by packages/settings/tests/import.rs. A merged demo setup and its Easy result for the default controls.", "base": cfg.to_json(), "easy": EasySettings::default(), "result": j});
        std::fs::write(
            dir.join("settings-config.json"),
            serde_json::to_string_pretty(&body).unwrap() + "\n",
        )
        .unwrap();
    }
}
