// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Tree support infill (`tree_support_with_infill`): on every tree style, a trunk wide enough for the support
//! base pattern gets its lines inside the walls, and nothing else in the print moves. Off, the G-code is the
//! same as with no key at all; the hollow base pattern stays hollow.
#![allow(
    clippy::disallowed_methods,
    reason = "test measurements of G-code; no output depends on them"
)]

mod common;

use common::organic_models as models;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use sx_core::api::SliceRequest;

/// The tree styles, the v2 organic engine counted as its own.
const STYLES: [&str; 5] = ["tree_slim", "tree_strong", "tree_hybrid", "organic", "organic2"];

fn config(style: &str, extra: &Value) -> Value {
    let mut c = json!({
        "enable_support": true, "support_type": "tree(auto)", "support_on_build_plate_only": false,
        "brim_width": 0, "brim_type": "no_brim", "layer_height": 0.2, "initial_layer_print_height": 0.2,
    });
    if style == "organic2" {
        c["support_style"] = json!("organic");
        c["organic_support_engine"] = json!("v2");
    } else {
        c["support_style"] = json!(style);
    }
    if let (Some(dst), Some(src)) = (c.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    c
}

/// G-code of the trunk model in the middle of the plate.
fn slice(config: &Value) -> String {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{
            "id": "a", "mesh": "m",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 128, 128, 0, 1]
        }] },
        "config": config,
        "options": {}
    }))
    .expect("request");
    let mesh = Arc::new(models::trunk());
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).expect("slices");
    String::from_utf8(run.gcode).expect("utf-8")
}

fn length(segs: &[(bool, [f32; 2], [f32; 2])], interface: bool) -> f64 {
    segs.iter()
        .filter(|s| s.0 == interface)
        .map(|(_, a, b)| f64::from((b[0] - a[0]).hypot(b[1] - a[1])))
        .sum()
}

/// Filament pushed by moves that go somewhere, per feature other than support, mm (unretracts left out).
fn part_extrusion(gcode: &str) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    let mut kind = String::new();
    for line in gcode.lines() {
        if let Some(t) = line.strip_prefix(";TYPE:") {
            kind = t.trim().to_string();
            continue;
        }
        if kind.starts_with("Support")
            || !(line.starts_with("G1 ") || line.starts_with("G2 ") || line.starts_with("G3 "))
        {
            continue;
        }
        let words: Vec<&str> = line.split(';').next().unwrap_or("").split_whitespace().collect();
        let moves = words.iter().any(|w| w.starts_with('X') || w.starts_with('Y'));
        let e: f64 = words
            .iter()
            .find_map(|w| w.strip_prefix('E'))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0);
        if moves && e > 0.0 {
            *out.entry(kind.clone()).or_insert(0.0) += e;
        }
    }
    out
}

#[test]
fn every_tree_style_fills_a_wide_trunk_and_nothing_else_moves() {
    for style in STYLES {
        let off = slice(&config(style, &json!({})));
        let off_key = slice(&config(style, &json!({"tree_support_with_infill": false})));
        assert!(off == off_key, "{style}: the key off changed the G-code");
        let on = slice(&config(style, &json!({"tree_support_with_infill": true})));
        let (a, b) = (models::support_moves(&off), models::support_moves(&on));
        assert_eq!(a.len(), b.len(), "{style}: support layers");
        let (mut grew, mut filled) = (0.0, 0);
        for ((za, sa), (zb, sb)) in a.iter().zip(&b) {
            assert!((za - zb).abs() < 1e-4, "{style}: layer {za} against {zb}");
            // The interface is the same, line for line.
            let iface = |s: &[(bool, [f32; 2], [f32; 2])]| {
                let mut v: Vec<String> = s
                    .iter()
                    .filter(|q| q.0)
                    .map(|q| format!("{:?}", (q.1, q.2)))
                    .collect();
                v.sort();
                v
            };
            assert_eq!(iface(sa), iface(sb), "{style}: interface at {za}");
            let d = length(sb, false) - length(sa, false);
            assert!(d > -1e-3, "{style}: support shrank by {:.2} mm at {za}", -d);
            grew += d;
            filled += usize::from(d > 1.0);
        }
        assert!(filled >= 10, "{style}: {filled} layers got fill");
        assert!(
            grew > 0.05 * a.iter().map(|(_, s)| length(s, false)).sum::<f64>(),
            "{style}: {grew:.1} mm more"
        );
        let (pa, pb) = (part_extrusion(&off), part_extrusion(&on));
        assert_eq!(
            pa.keys().collect::<Vec<_>>(),
            pb.keys().collect::<Vec<_>>(),
            "{style}: features"
        );
        for (k, v) in &pa {
            assert!(
                (v - pb[k]).abs() < 1e-3,
                "{style}: {k} {v:.4} against {:.4}",
                pb[k]
            );
        }
    }
}

#[test]
fn the_hollow_base_pattern_ignores_tree_support_infill() {
    for style in ["tree_slim", "organic", "organic2"] {
        let hollow = json!({"support_base_pattern": "hollow"});
        let mut on = hollow.clone();
        on["tree_support_with_infill"] = json!(true);
        assert!(
            slice(&config(style, &hollow)) == slice(&config(style, &on)),
            "{style}: hollow branches got fill"
        );
    }
}
