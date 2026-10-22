// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `support_filament` and `support_interface_filament` name the filament support prints with, 0 for whichever is
//! active. A value past the filaments the print sets up (a project written for a printer with more slots) used to
//! go through as it was, so the G-code changed to a tool that is not there. It now prints with the active filament
//! and says so.

// Requests are built inline and handed over whole.
#![allow(clippy::needless_pass_by_value)]

use serde_json::json;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, MeshPart, SliceRequest, SliceRun};

fn cuboid(lo: [f32; 3], hi: [f32; 3], name: &str) -> MeshPart {
    let positions = (0..8)
        .map(|i| {
            [
                if i & 1 == 0 { lo[0] } else { hi[0] },
                if i & 2 == 0 { lo[1] } else { hi[1] },
                if i & 4 == 0 { lo[2] } else { hi[2] },
            ]
        })
        .collect();
    MeshPart {
        name: name.into(),
        slot: 1,
        positions,
        triangles: vec![
            [0, 2, 1],
            [1, 2, 3],
            [4, 5, 6],
            [5, 7, 6],
            [0, 1, 4],
            [1, 5, 4],
            [2, 6, 3],
            [3, 6, 7],
            [0, 4, 2],
            [2, 4, 6],
            [1, 3, 5],
            [3, 7, 5],
        ],
        ..MeshPart::default()
    }
}

/// A one-color T: a 10 x 10 x 8 mm column under a 30 x 10 x 2 mm slab, so each arm overhangs 10 mm.
#[allow(
    clippy::needless_update,
    reason = "a mesh is gaining fields (volumes from project files); the default keeps this test building either way"
)]
fn tee() -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "tee".into(),
        parts: vec![
            cuboid([10.0, 0.0, 0.0], [20.0, 10.0, 8.0], "column"),
            cuboid([0.0, 0.0, 8.0], [30.0, 10.0, 10.0], "slab"),
        ],
        ..Mesh::default()
    })
}

fn at(x: f32) -> serde_json::Value {
    json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 100, 0, 1])
}

/// Two filaments set up, support on.
fn slice(objects: serde_json::Value, extra: serde_json::Value) -> SliceRun {
    let mut config = json!({
        "filament_colour": ["#FF8000", "#FFFFFF"],
        "enable_support": true,
        "support_type": "normal(auto)",
        "enable_prime_tower": true,
        "brim_width": 0
    });
    if let (Some(c), Some(e)) = (config.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            c.insert(k.clone(), v.clone());
        }
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": objects },
        "config": config,
        "options": {}
    }))
    .expect("request");
    let mesh = tee();
    common::run_request(&req, &move |_: &str| Ok(mesh.clone())).expect("slices")
}

fn one(extra: serde_json::Value) -> SliceRun {
    slice(json!([{ "id": "a", "mesh": "t", "transform": at(100.0) }]), extra)
}

fn tool_lines(run: &SliceRun) -> Vec<String> {
    String::from_utf8_lossy(&run.gcode)
        .lines()
        .map(str::trim)
        .filter(|l| l.len() > 1 && l.starts_with('T') && l[1..].chars().all(|c| c.is_ascii_digit()))
        .filter(|l| l[1..].parse::<u32>().is_ok_and(|t| t < 1000))
        .map(str::to_owned)
        .collect()
}

fn warnings(run: &SliceRun) -> Vec<String> {
    run.report.warnings.iter().map(|w| w.message.clone()).collect()
}

#[test]
fn default_support_prints_with_the_loaded_filament() {
    let run = one(json!({ "support_filament": 0, "support_interface_filament": 0 }));
    assert_eq!(run.report.stats.tool_changes, 0, "{:?}", tool_lines(&run));
    assert!(
        !tool_lines(&run).iter().any(|t| t == "T1"),
        "no change to filament 2"
    );
}

#[test]
fn a_support_filament_of_its_own_changes_tools_on_support_layers() {
    let run = one(json!({ "support_filament": 2 }));
    assert!(
        run.report.stats.tool_changes > 0,
        "support on filament 2 changes tools"
    );
    assert!(
        tool_lines(&run).iter().any(|t| t == "T1"),
        "{:?}",
        tool_lines(&run)
    );
    assert!(
        !warnings(&run).iter().any(|w| w.contains("support_filament")),
        "{:?}",
        warnings(&run)
    );
}

#[test]
fn a_support_filament_past_the_print_falls_back_to_the_loaded_one_and_says_so() {
    let base = one(json!({ "support_filament": 0 }));
    for (key, value) in [("support_filament", 7), ("support_interface_filament", 3)] {
        let mut asked = serde_json::Map::new();
        asked.insert(key.to_owned(), json!(value));
        let run = one(serde_json::Value::Object(asked));
        // No change to a filament that is not there, and the same print as default support.
        assert!(
            tool_lines(&run).iter().all(|t| t == "T0"),
            "{key} {value}: {:?}",
            tool_lines(&run)
        );
        assert_eq!(
            run.report.stats.tool_changes, base.report.stats.tool_changes,
            "{key} {value}: changes tools as default support does"
        );
        let w = warnings(&run);
        assert!(
            w.iter()
                .any(|w| w.contains(&format!("{key} asks for filament {value}, but this print has 2"))),
            "{w:?}"
        );
    }
}

#[test]
fn without_a_filament_list_nothing_is_checked() {
    // A config that does not say how many filaments there are keeps the value as given.
    let mut config = json!({ "support_filament": 2, "enable_support": true, "support_type": "normal(auto)" });
    if let Some(c) = config.as_object_mut() {
        c.insert("brim_width".into(), json!(0));
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{ "id": "a", "mesh": "t", "transform": at(100.0) }] },
        "config": config,
        "options": {}
    }))
    .expect("request");
    let mesh = tee();
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).expect("slices");
    assert!(
        tool_lines(&run).iter().any(|t| t == "T1"),
        "{:?}",
        tool_lines(&run)
    );
    assert!(!warnings(&run).iter().any(|w| w.contains("support_filament")));
}

#[test]
fn an_objects_own_support_filament_is_checked_too() {
    // Object a asks for filament 5 of 2; object b for filament 2. Only b's support changes tools.
    let run = slice(
        json!([
            { "id": "a", "mesh": "t", "transform": at(60.0), "settings": { "support_filament": 5 } },
            { "id": "b", "mesh": "t", "transform": at(140.0), "settings": { "support_filament": 2 } }
        ]),
        json!({}),
    );
    assert!(
        tool_lines(&run).iter().any(|t| t == "T1"),
        "b's support is on filament 2"
    );
    assert!(
        warnings(&run)
            .iter()
            .any(|w| w.contains("support_filament asks for filament 5, but this print has 2")),
        "{:?}",
        warnings(&run)
    );
}

/// What `g` prints its support with: the support and support interface lines by loaded tool (`T<n>`), the
/// changes, and the tool lines that select the tool already loaded, which the G-code writes when it took a
/// layer to start on another filament than the one the layer below ended on.
#[derive(Debug, Default)]
struct SupportTools {
    lines: std::collections::BTreeMap<(String, String), usize>,
    repeated: usize,
    changes: usize,
    layers: usize,
}

fn support_tools(g: &str) -> SupportTools {
    let mut out = SupportTools::default();
    let mut tool: Option<String> = None;
    let mut feature = String::new();
    for l in g.lines().map(str::trim) {
        let first = l.split_whitespace().next().unwrap_or("");
        if first.len() > 1 && first.starts_with('T') && first[1..].parse::<u32>().is_ok_and(|t| t < 255) {
            match tool.as_deref() {
                Some(t) if t == first => out.repeated += 1,
                Some(_) => out.changes += 1,
                None => {}
            }
            tool = Some(first.to_owned());
        } else if l.starts_with(";LAYER_CHANGE") || l.starts_with("; CHANGE_LAYER") {
            out.layers += 1;
        } else if let Some(f) = l
            .strip_prefix("; FEATURE:")
            .or_else(|| l.strip_prefix(";FEATURE:"))
            .or_else(|| l.strip_prefix(";TYPE:"))
        {
            f.trim().clone_into(&mut feature);
        } else if (first == "G1" || first == "G2" || first == "G3")
            && feature.starts_with("Support")
            && l.split_whitespace()
                .any(|w| w.starts_with('X') || w.starts_with('Y'))
            && l.split_whitespace().any(|w| {
                w.strip_prefix('E')
                    .and_then(|e| e.parse::<f64>().ok())
                    .is_some_and(|e| e > 0.0)
            })
        {
            let t = tool.clone().unwrap_or_default();
            *out.lines.entry((feature.clone(), t)).or_default() += 1;
        }
    }
    out
}

/// Support and its interface asked for filament 2 on `printer`, with support on layers of its own height
/// (the default) and on the object's layers.
fn support_on_two(printer: serde_json::Value) -> [(SupportTools, SliceRun); 2] {
    [true, false].map(|independent| {
        let mut extra = json!({
            "support_filament": 2,
            "support_interface_filament": 2,
            "independent_support_layer_height": independent,
        });
        if let (Some(e), Some(p)) = (extra.as_object_mut(), printer.as_object()) {
            for (k, v) in p {
                e.insert(k.clone(), v.clone());
            }
        }
        let run = one(extra);
        (support_tools(&String::from_utf8_lossy(&run.gcode)), run)
    })
}

fn assert_support_on_two(printer: serde_json::Value) {
    let [(on, run), (off, _)] = support_on_two(printer);
    // Support on layers of its own adds print layers that hold only support.
    assert!(on.layers > off.layers, "{} vs {} layers", on.layers, off.layers);
    for (feature, tools) in [("Support", &on), ("Support interface", &on), ("Support", &off)] {
        let lines: Vec<_> = tools.lines.iter().filter(|((f, _), _)| f == feature).collect();
        assert!(!lines.is_empty(), "{feature}: {:?}", tools.lines);
        assert!(
            lines.iter().all(|((_, t), _)| t == "T1"),
            "{feature}: {:?}",
            tools.lines
        );
    }
    // Every change the G-code makes is a real one: no layer starts on a filament it does not have loaded.
    assert_eq!(on.repeated, 0, "{:?}", tool_lines(&run));
    assert_eq!(
        usize::try_from(run.report.stats.tool_changes).ok(),
        Some(on.changes),
        "{:?}",
        tool_lines(&run)
    );
}

#[test]
fn support_stays_on_its_filament_on_support_layers_of_their_own_with_an_ams() {
    // One nozzle fed by an AMS: the support-only layers between the object's layers change to filament 2
    // when the layer below ended on filament 1, instead of printing with whatever is loaded.
    assert_support_on_two(json!({ "gcode_flavor": "marlin", "printer_model": "Bambu Lab P1S" }));
}

#[test]
fn support_stays_on_its_filament_on_support_layers_of_their_own_with_two_nozzles() {
    // Two nozzles, filament 1 on the left and 2 on the right.
    assert_support_on_two(json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab H2D",
        "nozzle_diameter": [0.4, 0.4],
        "physical_extruder_map": [1, 0],
        "master_extruder_id": 2,
        "single_extruder_multi_material": true,
        "nozzle_temperature": [220, 225],
        "filament_diameter": [1.75, 1.75],
        "filament_map_mode": "Manual",
        "filament_map": [1, 2],
    }));
}
