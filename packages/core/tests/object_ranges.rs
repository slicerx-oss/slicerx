// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Settings that belong to one object of a plate: its own flow and its own height ranges, printed
//! layer by layer beside other objects or one object after another.

// Requests are built with `json!` at each call, so taking them by value reads best.
#![allow(clippy::needless_pass_by_value, clippy::many_single_char_names)]
#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::float_cmp
)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{self, Mesh, SliceRequest, SliceRun};

fn cuboid(x: [f32; 2], y: [f32; 2], z: [f32; 2]) -> api::MeshPart {
    let mut positions = Vec::new();
    for zi in z {
        for (xi, yi) in [(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])] {
            positions.push([xi, yi, zi]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    api::MeshPart {
        name: "box".into(),
        slot: 1,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint: Vec::new(),
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
    }
}

/// Two 20 mm boxes 6 mm tall, "l" at x 60 and "r" at x 140, `right` the settings of the right one.
fn two_boxes(right: Value, config: Value, options: Value) -> api::Result<SliceRun> {
    let cube = Arc::new(Mesh {
        name: "box".into(),
        parts: vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 6.0])],
    });
    let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "extruder_clearance_radius": 20});
    cfg.as_object_mut()
        .unwrap()
        .extend(config.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "l", "name": "left", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 60,100,0,1]},
            {"id": "r", "name": "right", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 140,100,0,1], "settings": right},
        ]},
        "config": cfg,
        "options": options,
    }))
    .unwrap();
    common::run_request(&req, &move |_: &str| Ok(cube.clone()))
}

fn text(r: &SliceRun) -> String {
    String::from_utf8(r.gcode.clone()).unwrap()
}

fn field(l: &str, k: char) -> Option<f64> {
    l.split_whitespace()
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

/// Filament pushed on the left (x below 120) and right boxes above their first layers, mm.
fn extrusion_by_side(g: &str) -> (f64, f64) {
    let (mut relative, mut e, mut z) = (false, 0.0, 0.0);
    let (mut left, mut right) = (0.0, 0.0);
    for l in g.lines() {
        if let Some(v) = l.strip_prefix(";Z:") {
            z = v.parse().unwrap();
        } else if l.starts_with("M83") {
            relative = true;
        } else if l.starts_with("M82") {
            relative = false;
        } else if l.starts_with("G92") {
            if let Some(v) = field(l, 'E') {
                e = v;
            }
        } else if l.starts_with("G1 ") || l.starts_with("G0 ") {
            let Some(v) = field(l, 'E') else { continue };
            let d = if relative { v } else { v - e };
            if !relative {
                e = v;
            }
            if d > 0.0
                && z > 0.3
                && let Some(x) = field(l, 'X')
            {
                if x < 120.0 {
                    left += d;
                } else {
                    right += d;
                }
            }
        }
    }
    (left, right)
}

#[test]
fn an_objects_own_flow_ratio_reaches_its_g_code() {
    for sequence in ["by layer", "by object"] {
        let plain = two_boxes(json!({}), json!({"print_sequence": sequence}), json!({})).unwrap();
        let more = two_boxes(
            json!({"filament_flow_ratio": 1.2}),
            json!({"print_sequence": sequence}),
            json!({}),
        )
        .unwrap();
        let (pl, pr) = extrusion_by_side(&text(&plain));
        let (ml, mr) = extrusion_by_side(&text(&more));
        assert!((pl - pr).abs() < pl * 0.01, "{sequence}: {pl} {pr}");
        assert!((ml - pl).abs() < pl * 0.01, "{sequence}: left moved {pl} to {ml}");
        assert!((mr / pr - 1.2).abs() < 0.02, "{sequence}: right {pr} to {mr}");
    }
}

/// Every extrusion as (right side, layer top, nozzle temperature set when it printed), above the first layer.
fn temps_by_side(g: &str) -> Vec<(bool, f64, i64)> {
    let (mut z, mut t, mut out) = (0.0, 0i64, Vec::new());
    for l in g.lines() {
        if let Some(v) = l.strip_prefix(";Z:") {
            z = v.parse().unwrap();
        } else if l.starts_with("M104") || l.starts_with("M109") {
            if let Some(v) = field(l, 'S') {
                t = v.round() as i64;
            }
        } else if l.starts_with("G1 X")
            && l.contains(" E")
            && z > 0.3
            && let Some(x) = field(l, 'X')
        {
            out.push((x > 120.0, z, t));
        }
    }
    out
}

fn temps_where(v: &[(bool, f64, i64)], right: bool, zs: std::ops::Range<f64>) -> Vec<i64> {
    let mut t: Vec<i64> = v
        .iter()
        .filter(|e| e.0 == right && zs.contains(&e.1))
        .map(|e| e.2)
        .collect();
    t.dedup();
    t
}

const TEMPS: &str = r#"{"nozzle_temperature": [215], "nozzle_temperature_initial_layer": [215]}"#;

#[test]
fn printed_by_object_each_object_keeps_its_own_height_ranges() {
    let mut cfg: Value = serde_json::from_str(TEMPS).unwrap();
    cfg["print_sequence"] = json!("by object");
    let opts = json!({"flavor": "marlin2", "heightRanges": [
        {"zFromMm": 0, "zToMm": 3, "settings": {"nozzle_temperature": 240}, "objects": ["r"]},
        {"zFromMm": 3, "zToMm": 7, "settings": {"nozzle_temperature": 200}, "objects": ["l"]},
    ]});
    let r = two_boxes(json!({}), cfg.clone(), opts.clone()).unwrap();
    let v = temps_by_side(&text(&r));
    // The left box ends inside its range at 200; the right one starts at its own 240 and drops to the plate's.
    assert_eq!(temps_where(&v, false, 0.3..3.01), vec![215]);
    assert_eq!(temps_where(&v, false, 3.19..7.0), vec![200]);
    assert_eq!(temps_where(&v, true, 0.3..3.01), vec![240]);
    assert_eq!(temps_where(&v, true, 3.19..7.0), vec![215]);
    let mut o = opts;
    o["shards"] = json!(5);
    assert_eq!(two_boxes(json!({}), cfg, o).unwrap().gcode, r.gcode);
}

#[test]
fn printed_layer_by_layer_an_objects_range_keeps_its_flow_and_sets_the_layer_temperature() {
    let cfg: Value = serde_json::from_str(TEMPS).unwrap();
    let ranges = |extra: Value| {
        let mut v = vec![
            json!({"zFromMm": 0, "zToMm": 3, "settings": {"nozzle_temperature": 240, "filament_flow_ratio": 1.2}, "objects": ["r"]}),
        ];
        if !extra.is_null() {
            v.push(extra);
        }
        json!({"flavor": "marlin2", "heightRanges": v})
    };
    // The right box needs settings of its own to print beside the left one, so give it a harmless one.
    let plain = two_boxes(json!({}), cfg.clone(), json!({"flavor": "marlin2"})).unwrap();
    let r = two_boxes(json!({}), cfg.clone(), ranges(Value::Null)).unwrap();
    let v = temps_by_side(&text(&r));
    // One nozzle: both boxes print at 240 up to 3 mm, then at the plate's 215.
    assert_eq!(temps_where(&v, false, 0.3..3.01), vec![240]);
    assert_eq!(temps_where(&v, true, 0.3..3.01), vec![240]);
    assert_eq!(temps_where(&v, true, 3.19..7.0), vec![215]);
    // The flow is the right box's alone: layers 2 to 15 (0.4 to 3 mm).
    let flows = |g: &str| {
        let lines: Vec<&str> = g.lines().collect();
        let cut = lines.iter().position(|l| *l == ";Z:3.2").unwrap();
        extrusion_by_side(&lines[..cut].join("\n"))
    };
    let ((pl, pr), (ml, mr)) = (flows(&text(&plain)), flows(&text(&r)));
    assert!((ml - pl).abs() < pl * 0.01, "{pl} {ml}");
    assert!((mr / pr - 1.2).abs() < 0.02, "{pr} {mr}");
    // A range of the left box asking another temperature over the same heights is named.
    let both = two_boxes(
        json!({}),
        cfg,
        ranges(json!({"zFromMm": 2, "zToMm": 4, "settings": {"nozzle_temperature": 230}, "objects": ["l"]})),
    )
    .unwrap();
    assert!(
        both.report
            .warnings
            .iter()
            .any(|w| w.message.contains("nozzle_temperature of r and l")),
        "{:?}",
        both.report.warnings
    );
}

#[test]
fn a_range_naming_an_object_not_on_the_plate_is_refused() {
    let opts = json!({"heightRanges": [{"zFromMm": 0, "zToMm": 3, "settings": {"wall_loops": 3}, "objects": ["nope"]}]});
    let e = two_boxes(json!({}), json!({}), opts).err().unwrap().to_string();
    assert!(e.contains("nope"), "{e}");
}

/// Per segment of a preview: its object index and the X of its start.
fn preview_objects(sxpv: &[u8]) -> Vec<(u16, f32)> {
    let info = sx_core::preview::read_info(sxpv).unwrap();
    let Some(at) = info.objects_at else {
        return Vec::new();
    };
    (0..info.segments)
        .map(|i| {
            let o = at + i * sx_core::preview::OBJECT_BYTES;
            let s = info.segments_at + i * sx_core::preview::SEGMENT_BYTES;
            (
                u16::from_le_bytes([sxpv[o], sxpv[o + 1]]),
                f32::from_le_bytes([sxpv[s], sxpv[s + 1], sxpv[s + 2], sxpv[s + 3]]),
            )
        })
        .collect()
}

#[test]
fn the_preview_names_the_object_of_every_segment() {
    for (sequence, right) in [
        ("by layer", json!({})),
        ("by layer", json!({"wall_loops": 4})),
        ("by object", json!({})),
    ] {
        let cfg = json!({"print_sequence": sequence, "skirt_loops": 1, "skirt_distance": 3});
        let r = two_boxes(right.clone(), cfg.clone(), json!({})).unwrap();
        let info = sx_core::preview::read_info(&r.preview).unwrap();
        assert!(info.extras_at.is_some(), "the extras are still there");
        let segs = preview_objects(&r.preview);
        assert_eq!(segs.len(), info.segments);
        let (mut left, mut rightn, mut none) = (0, 0, 0);
        for (o, x) in &segs {
            match o {
                0 => {
                    left += 1;
                    assert!(*x < 100.0, "{sequence}: object 0 at x {x}");
                }
                1 => {
                    rightn += 1;
                    assert!(*x > 100.0, "{sequence}: object 1 at x {x}");
                }
                _ => none += 1,
            }
        }
        assert!(
            left > 100 && rightn > 100 && none > 0,
            "{sequence}: {left} {rightn} {none}"
        );
        // Shards stitch to the same bytes.
        let five = two_boxes(right, cfg, json!({"shards": 5})).unwrap();
        assert_eq!(five.preview, r.preview, "{sequence}");
    }
    // One object: no object block.
    let cube = Arc::new(Mesh {
        name: "box".into(),
        parts: vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 6.0])],
    });
    let req: SliceRequest =
        serde_json::from_value(json!({"plate": {"objects": [{"mesh": "c"}]}, "config": {}})).unwrap();
    let one = common::run_request(&req, &move |_: &str| Ok(cube.clone())).unwrap();
    assert!(
        sx_core::preview::read_info(&one.preview)
            .unwrap()
            .objects_at
            .is_none()
    );
}

#[test]
fn layer_g_code_by_height_lands_on_the_engines_own_layers() {
    // Layers of 0.3 mm after a 0.2 mm first one: 2.05 mm is first reached by the layer whose top is 2.3 mm.
    let mut tops = vec![0.2];
    while tops.last().copied().unwrap_or(0.0) < 6.0 {
        tops.push(((tops.last().copied().unwrap_or(0.0) + 0.3) * 1000.0_f64).round() / 1000.0);
    }
    let opts = json!({"flavor": "marlin2", "layerTopsMm": tops, "layerGcode": [
        {"zMm": 2.05, "kind": "custom", "gcode": "M117 first"},
        {"zMm": 2.25, "kind": "custom", "gcode": "M117 second"},
        {"zMm": 4.4, "kind": "pause"},
        {"layer": 1, "kind": "custom", "gcode": "M117 by index"},
    ]});
    let r = two_boxes(json!({}), json!({}), opts).unwrap();
    let g = text(&r);
    let layer_of = |needle: &str| -> Option<String> {
        let at = g.find(needle)?;
        g[..at]
            .rfind(";Z:")
            .map(|z| g[z + 3..].lines().next().unwrap_or("").to_owned())
    };
    // Both 2.05 and 2.25 land on the 2.3 mm layer; the later one stays.
    assert_eq!(layer_of("M117 second").as_deref(), Some("2.3"));
    assert!(layer_of("M117 first").is_none());
    assert_eq!(layer_of("M601").as_deref(), Some("4.4"));
    assert_eq!(layer_of("M117 by index").as_deref(), Some("0.5"));
    let both = json!({"layerGcode": [{"layer": 2, "zMm": 1.0, "kind": "pause"}]});
    assert!(
        two_boxes(json!({}), json!({}), both)
            .err()
            .unwrap()
            .to_string()
            .contains("one of layer and zMm")
    );
}
