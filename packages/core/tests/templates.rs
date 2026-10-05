// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Every start, end, layer change and tool change template the settings
//! package ships for its printers must parse.

use serde_json::Value;
use sx_core::template;

#[test]
fn every_shipped_template_parses() {
    let path = format!("{}/../profiles/gcode.json", env!("CARGO_MANIFEST_DIR"));
    let doc: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut seen = 0;
    let mut bad = Vec::new();
    for (family, parts) in doc["families"].as_object().unwrap() {
        for (name, text) in parts.as_object().unwrap() {
            let Some(text) = text.as_str() else { continue };
            seen += 1;
            if let Err(e) = template::check(text) {
                bad.push(format!("{family}.{name}: {e}"));
            }
        }
    }
    assert!(seen > 100, "only {seen} templates found");
    assert!(
        bad.is_empty(),
        "{} of {seen} templates do not parse:\n{}",
        bad.len(),
        bad.join("\n")
    );
}

/// Renders every template with the variables a real print provides. Variables only a
/// wipe tower or a toolchanger printer knows are listed here; anything else missing is
/// a gap in `customgcode::context`.
#[test]
fn shipped_templates_render_with_a_real_print() {
    let path = format!("{}/../profiles/gcode.json", env!("CARGO_MANIFEST_DIR"));
    let doc: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mesh = std::sync::Arc::new(
        sx_core::Mesh::load(
            &std::fs::read(format!("{}/bench/models/x-mark.stl", env!("CARGO_MANIFEST_DIR"))).unwrap(),
            "x-mark.stl",
        )
        .unwrap(),
    );
    let config = sx_core::PrintConfig::default();
    let out = sx_core::slice(
        &sx_core::Plate::single((*mesh).clone()),
        &config,
        &sx_core::SliceOptions::default(),
    )
    .unwrap();
    let mut missing: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let mut ok = 0;
    for (family, parts) in doc["families"].as_object().unwrap() {
        for (name, text) in parts.as_object().unwrap() {
            let Some(text) = text.as_str() else { continue };
            match sx_core::api::render_gcode_template(&config, &out, text, 5) {
                Ok(_) => ok += 1,
                Err(e) => {
                    let var = e.split_whitespace().nth(1).unwrap_or("?").to_owned();
                    *missing
                        .entry(format!("{var} ({family}.{name}: {e})"))
                        .or_default() += 1;
                }
            }
        }
    }
    assert!(
        missing.is_empty(),
        "{ok} render, {} do not:\n{}",
        missing.len(),
        missing.keys().cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn plate_variables_follow_orca() {
    let mesh = sx_core::Mesh::load(
        &std::fs::read(format!("{}/bench/models/x-mark.stl", env!("CARGO_MANIFEST_DIR"))).unwrap(),
        "x-mark.stl",
    )
    .unwrap();
    let config = sx_core::PrintConfig::default();
    let out = sx_core::slice(
        &sx_core::Plate::single(mesh),
        &config,
        &sx_core::SliceOptions::default(),
    )
    .unwrap();
    let render = |t: &str| sx_core::api::render_gcode_template(&config, &out, t, 5).unwrap();
    // Orca's own defaults for settings the profile does not carry.
    assert_eq!(
        render("{full_fan_speed_layer}|{long_retractions_when_cut}"),
        "0|false"
    );
    assert_eq!(
        render("{retraction_distance_when_cut}|{retraction_distances_when_ec}"),
        "18|10"
    );
    // Legacy vector indexing: `[name_1]` is entry 1 of the list.
    let y = render("[first_layer_print_min_1]").parse::<f64>().unwrap();
    assert!((y - render("{first_layer_print_min[1]}").parse::<f64>().unwrap()).abs() < 1e-9);
    assert_eq!(
        render("{filament_map[0]}{has_tpu_in_first_layer}{is_all_bbl_filament}"),
        "1falsefalse"
    );
    // Marks the finished file fills in.
    assert!(render("{print_time_sec}").starts_with("_GP_"));
    assert_eq!(render("{year}").len(), 4);
}

#[test]
fn the_date_variables_follow_the_hosts_clock_when_it_sends_one() {
    let mesh = sx_core::Mesh::load(
        &std::fs::read(format!("{}/bench/models/x-mark.stl", env!("CARGO_MANIFEST_DIR"))).unwrap(),
        "x-mark.stl",
    )
    .unwrap();
    let mut config = sx_core::PrintConfig::default();
    let out = sx_core::slice(
        &sx_core::Plate::single(mesh),
        &config,
        &sx_core::SliceOptions::default(),
    )
    .unwrap();
    // 2026-10-01 18:05:09 UTC is 1790877909; two hours east of it reads 20:05:09.
    config.now = Some((1_790_877_909, 120));
    let text = "{year}-{month}-{day} {hour}:{minute}:{second}";
    assert_eq!(
        sx_core::api::render_gcode_template(&config, &out, text, 5).unwrap(),
        "2026-10-1 20:5:9"
    );
}

#[test]
fn the_head_wrap_zone_is_tested_against_the_first_layer_outline() {
    let mesh = sx_core::Mesh::load(
        &std::fs::read(format!("{}/bench/models/x-mark.stl", env!("CARGO_MANIFEST_DIR"))).unwrap(),
        "x-mark.stl",
    )
    .unwrap();
    let render = |zone: serde_json::Value| {
        let mut config = sx_core::PrintConfig::default();
        config.raw.insert("head_wrap_detect_zone".into(), zone);
        let out = sx_core::slice(
            &sx_core::Plate::single(mesh.clone()),
            &config,
            &sx_core::SliceOptions::default(),
        )
        .unwrap();
        sx_core::api::render_gcode_template(&config, &out, "{in_head_wrap_detect_zone}", 5).unwrap()
    };
    assert_eq!(
        render(serde_json::json!([
            [100, 100],
            [160, 100],
            [160, 160],
            [100, 160]
        ])),
        "true"
    );
    assert_eq!(
        render(serde_json::json!([[0, 0], [10, 0], [10, 10], [0, 10]])),
        "false"
    );
}
