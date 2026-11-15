// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Organic trees take their branch angle, diameter and distance from `tree_support_branch_angle_organic`,
//! `tree_support_branch_diameter_organic` and `tree_support_branch_distance_organic`. A project from an app that keeps
//! one set of branch settings for every tree style writes only `tree_support_branch_angle`,
//! `tree_support_branch_diameter` and `tree_support_branch_distance`; those values then reach the organic planner
//! too. A twin the settings set themselves still wins.

#![allow(
    clippy::needless_pass_by_value,
    reason = "configs are built inline and handed over whole"
)]

mod common;

use common::organic_models as models;
use serde_json::{Value, json};
use std::sync::Arc;
use sx_core::PrintConfig;
use sx_core::api::SliceRequest;

/// The organic branch settings a config ends up with: angle, diameter, distance.
fn organic(c: &PrintConfig) -> [f64; 3] {
    let t = &c.support.tree_settings;
    [
        t.branch_angle_organic,
        t.branch_diameter_organic,
        t.branch_distance_organic,
    ]
}

fn close(got: [f64; 3], want: [f64; 3]) -> bool {
    got.iter().zip(want).all(|(g, w)| (g - w).abs() < 1e-9)
}

/// Plain branch settings only, written as strings the way a project file holds them.
fn plain(angle: u32, diameter: u32, distance: u32) -> Value {
    json!({
        "tree_support_branch_angle": angle.to_string(),
        "tree_support_branch_diameter": diameter.to_string(),
        "tree_support_branch_distance": distance.to_string(),
    })
}

fn with(mut a: Value, b: Value) -> Value {
    if let (Some(dst), Some(src)) = (a.as_object_mut(), b.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    a
}

#[test]
fn plain_branch_settings_reach_organic_trees_when_their_twins_are_missing() {
    let c = PrintConfig::from_value(&plain(45, 3, 5)).unwrap();
    let got = organic(&c);
    assert!(
        close(got, [45.0, 3.0, 5.0]),
        "organic angle, diameter, distance {got:?}"
    );
    // The plain fields keep the same values.
    let t = &c.support.tree_settings;
    assert!(close(
        [t.branch_angle, t.branch_diameter, t.branch_distance],
        [45.0, 3.0, 5.0]
    ));

    // One plain key alone moves only its own twin; the other two keep the defaults.
    let d = organic(&PrintConfig::default());
    let c = PrintConfig::from_value(&json!({"tree_support_branch_distance": "5"})).unwrap();
    let got = organic(&c);
    assert!(
        close(got, [d[0], d[1], 5.0]),
        "organic angle, diameter, distance {got:?}"
    );
}

#[test]
fn an_organic_twin_the_settings_set_wins_over_the_plain_key() {
    let both = with(
        plain(45, 3, 5),
        json!({
            "tree_support_branch_angle_organic": 30,
            "tree_support_branch_diameter_organic": 4,
            "tree_support_branch_distance_organic": 2,
        }),
    );
    let c = PrintConfig::from_value(&both).unwrap();
    let got = organic(&c);
    assert!(
        close(got, [30.0, 4.0, 2.0]),
        "organic angle, diameter, distance {got:?}"
    );
    let t = &c.support.tree_settings;
    assert!(close(
        [t.branch_angle, t.branch_diameter, t.branch_distance],
        [45.0, 3.0, 5.0]
    ));

    // Settings that leave the plain keys out leave the organic ones as they were.
    let c = PrintConfig::from_value(&json!({"tree_support_branch_diameter_organic": 4})).unwrap();
    let mut layered = c.clone();
    layered
        .apply_value(&json!({"support_type": "tree(auto)"}))
        .unwrap();
    assert!(close(organic(&layered), organic(&c)));
}

#[test]
fn a_project_with_only_plain_branch_settings_gives_organic_trees_those_values() {
    // The project file's own settings, read the way `sx slice project.3mf` reads them.
    let settings = with(
        json!({"enable_support": "1", "support_type": "tree(auto)", "support_style": "default"}),
        plain(45, 3, 5),
    );
    let base = models::threemf(&models::t_bar(), [128.0, 128.0]);
    let file = with_project_settings(&base, &settings.to_string());
    let project = sx_core::api::project_config(&file, "tree.3mf")
        .unwrap()
        .expect("project settings");
    let mut c = PrintConfig::default();
    c.apply_value(&Value::Object(project.settings)).unwrap();
    let got = organic(&c);
    assert!(
        close(got, [45.0, 3.0, 5.0]),
        "organic angle, diameter, distance {got:?}"
    );
}

/// `file` (a stored 3MF from [`models::threemf`]) with `Metadata/project_settings.config` added.
fn with_project_settings(file: &[u8], settings: &str) -> Vec<u8> {
    let entries = stored_entries(file);
    let mut list: Vec<(&str, &[u8])> = entries.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
    list.push(("Metadata/project_settings.config", settings.as_bytes()));
    models::stored_zip(&list)
}

/// The entries of a stored (uncompressed) ZIP, from its local headers.
fn stored_entries(zip: &[u8]) -> Vec<(String, Vec<u8>)> {
    let u16_at = |i: usize| usize::from(u16::from_le_bytes([zip[i], zip[i + 1]]));
    let u32_at = |i: usize| u32::from_le_bytes([zip[i], zip[i + 1], zip[i + 2], zip[i + 3]]) as usize;
    let mut out = Vec::new();
    let mut i = 0;
    while i + 30 <= zip.len() && u32_at(i) == 0x0403_4b50 {
        let size = u32_at(i + 18);
        let name_len = u16_at(i + 26);
        let extra = u16_at(i + 28);
        let name = String::from_utf8_lossy(&zip[i + 30..i + 30 + name_len]).into_owned();
        let at = i + 30 + name_len + extra;
        out.push((name, zip[at..at + size].to_vec()));
        i = at + size;
    }
    out
}

/// The support moves of the T bar sliced with organic trees (the default engine) and `extra` over that.
fn tree_support(extra: Value) -> Vec<(f32, models::SupportSegs)> {
    let config = with(
        json!({
            "enable_support": true, "support_type": "tree(auto)", "support_style": "default",
            "brim_type": "no_brim", "brim_width": 0, "skirt_loops": 0,
            "layer_height": 0.2, "initial_layer_print_height": 0.2,
        }),
        extra,
    );
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{
            "id": "a", "mesh": "m",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 128, 128, 0, 1]
        }] },
        "config": config,
        "options": {}
    }))
    .unwrap();
    let mesh = Arc::new(models::t_bar());
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    models::support_moves(&String::from_utf8_lossy(&run.gcode))
}

#[test]
fn organic_support_follows_a_projects_plain_branch_settings() {
    let thin = tree_support(plain(30, 2, 1));
    let thick = tree_support(plain(60, 6, 5));
    assert!(
        !thin.is_empty() && !thick.is_empty(),
        "the T bar's arm gets support"
    );
    assert_ne!(
        thin, thick,
        "organic support is the same with 2 mm and 6 mm branches set by the plain keys"
    );
    // The same plain keys with the organic twins pinned print as the twins say.
    let pinned = json!({
        "tree_support_branch_angle_organic": 30,
        "tree_support_branch_diameter_organic": 2,
        "tree_support_branch_distance_organic": 1,
    });
    let pinned_thick = tree_support(with(plain(60, 6, 5), pinned));
    assert_eq!(
        thin, pinned_thick,
        "the organic twins set in the same settings decide the organic support"
    );
}
