// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A single extruder multi-material printer rams the old filament out on its type 2 tower before each tool change:
//! 0.25 s at each speed its `filament_ramming_parameters` list after the first two tokens, in lines the first token
//! percent of the tower's wall bead wide and the second token percent of that apart, each speed at its own feed over
//! the bead and past the filament's volumetric limit. The step from line to line is a travel. The ramming's band adds
//! to the tower's depth.
//!
//! 15 mm boxes on an MK4 with the MMU and a 60 mm tower: A 8 mm tall on filament 1 and B 3 mm on filament 2, so every
//! layer up to 3 mm changes filament once; with four filaments, two more boxes on filaments 3 (8 mm) and 4 (3 mm).

#![allow(clippy::disallowed_methods, reason = "test geometry, not engine output")]

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

/// The 1.75 mm filament's cross-section, mm2.
const FIL: f64 = std::f64::consts::PI * 0.875 * 0.875;

/// The stock ramming: five speeds of 40 mm3/s, lines 2.5 wall beads wide and one line apart.
const STOCK: &str =
    "250 100 40 40 40 40 40 | 0.05 40 0.45 40 0.95 40 1.45 40 1.95 40 2.45 40 2.95 40 3.45 40";

/// An ASCII STL of a box from the origin to `size`.
fn box_stl(size: [f64; 3]) -> Vec<u8> {
    use std::fmt::Write as _;
    let corner = |index: usize| {
        std::array::from_fn::<f64, 3, _>(|axis| if index >> axis & 1 == 0 { 0.0 } else { size[axis] })
    };
    let faces: [[usize; 3]; 12] = [
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
    ];
    let mut text = String::from("solid box\n");
    for face in faces {
        text.push_str(" facet normal 0 0 0\n  outer loop\n");
        for index in face {
            let [x, y, z] = corner(index);
            let _ = writeln!(text, "   vertex {x} {y} {z}");
        }
        text.push_str("  endloop\n endfacet\n");
    }
    text.push_str("endsolid box\n");
    text.into_bytes()
}

/// An MK4 with the MMU, `filaments` filaments and a 60 mm type 2 tower that takes the whole flush (280 x 0.3), at
/// flow ratio 1, every filament ramming with `ram`; `extra` over it.
fn mmu(filaments: usize, ram: &str, extra: &[(&str, Value)]) -> Value {
    let bench: Value = serde_json::from_slice(
        &std::fs::read(format!(
            "{}/bench/configs/reference-0.20.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    let mut cfg = bench["config"].clone();
    let each = |v: &str| json!(vec![v; filaments]);
    let matrix: Vec<&str> = (0..filaments * filaments)
        .map(|i| {
            if i / filaments == i % filaments {
                "0"
            } else {
                "280"
            }
        })
        .collect();
    let colors = ["#F4EE2A", "#00AE42", "#3F51B5", "#F2754E"];
    for (k, v) in [
        ("printer_model", json!("Prusa MK4")),
        ("wipe_tower_type", json!("type2")),
        ("single_extruder_multi_material", json!("1")),
        ("use_relative_e_distances", json!("1")),
        ("printable_area", json!(["0x0", "250x0", "250x210", "0x210"])),
        ("filament_diameter", each("1.75")),
        ("filament_flow_ratio", each("1")),
        ("filament_max_volumetric_speed", each("12")),
        ("filament_colour", json!(colors[..filaments])),
        ("machine_max_speed_x", json!(["300", "200"])),
        ("machine_max_speed_y", json!(["300", "200"])),
        ("wipe_tower_x", json!(["20"])),
        ("wipe_tower_y", json!(["140"])),
        ("prime_tower_width", json!("60")),
        ("enable_prime_tower", json!(true)),
        ("smart_layer", json!("off")),
        ("flush_volumes_matrix", json!(matrix)),
        ("flush_multiplier", json!(["0.3"])),
        ("flush_into_infill", json!(false)),
        ("flush_into_support", json!(false)),
        ("flush_into_objects", json!(false)),
        ("enable_filament_ramming", json!("1")),
        ("filament_ramming_parameters", each(ram)),
    ] {
        cfg[k] = v;
    }
    for (k, v) in extra {
        cfg[*k] = v.clone();
    }
    cfg
}

/// The G-code of the 15 mm boxes (height, center x, center y, filament) with `cfg` on the MK4's bed.
#[allow(clippy::needless_pass_by_value, reason = "the callers hand over fresh values")]
fn slice(cfg: Value, boxes: &[(f64, f64, f64, u8)]) -> String {
    let objects: Vec<Value> = boxes
        .iter()
        .enumerate()
        .map(|(k, &(h, x, y, slot))| {
            json!({"id": format!("o{k}"), "name": format!("box {k}"), "mesh": format!("15 15 {h}"),
                   "slotOverrides": {"box": slot, "box.stl": slot, "": slot},
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x - 7.5, y - 7.5, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": 250, "depthMm": 210, "heightMm": 220}, "objects": objects},
        "config": cfg,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let load = |id: &str| -> sx_core::Result<Arc<Mesh>> {
        let s: Vec<f64> = id.split(' ').map(|v| v.parse().unwrap()).collect();
        Ok(Arc::new(
            Mesh::load(&box_stl([s[0], s[1], s[2]]), "box.stl").unwrap(),
        ))
    };
    let run = api::run_request(&req, &load).unwrap();
    String::from_utf8_lossy(&run.gcode).into_owned()
}

const TWO: &[(f64, f64, f64, u8)] = &[(8.0, 102.5, 102.5, 1), (3.0, 132.5, 102.5, 2)];
/// The ramming before one tool change: the layer (1 for the first), the filament it changes away from, the volume
/// rammed (tower moves wider than 1 mm of bead), mm3, the beads' widths at 0.2 mm, their feeds (mm/min) and the
/// tower moves between ramming moves that step along Y with filament.
#[derive(Debug, Clone, Default)]
struct Ram {
    layer: usize,
    from: u8,
    mm3: f64,
    widths: Vec<f64>,
    feeds: Vec<f64>,
    extruding_steps: usize,
}

/// Each tool change's ramming, and the tower's depth above the first layer (the Y extent of its extruding moves).
fn rams(gcode: &str) -> (Vec<Ram>, f64) {
    let (mut out, mut cur) = (Vec::new(), Ram::default());
    let (mut layer, mut tool, mut at, mut feed, mut tower) = (0usize, 0u8, [f64::NAN; 2], 0.0, false);
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    let mut pending_step = 0usize;
    for line in gcode.lines() {
        let s = line.trim();
        if s.starts_with(";LAYER_CHANGE") {
            layer += 1;
            continue;
        }
        if let Some(name) = s.strip_prefix(";TYPE:").or_else(|| s.strip_prefix("; FEATURE:")) {
            tower = matches!(name.trim(), "Prime tower" | "Wipe tower");
            continue;
        }
        let body = s.split(';').next().unwrap_or("").trim();
        if let Some(t) = body.strip_prefix('T').and_then(|t| t.parse::<u8>().ok()) {
            if layer > 0 && cur.mm3 > 0.0 {
                cur.layer = layer;
                cur.from = tool;
                out.push(std::mem::take(&mut cur));
            }
            cur = Ram::default();
            pending_step = 0;
            tool = t;
            continue;
        }
        if !(body.starts_with("G1 ") || body.starts_with("G0 ")) {
            continue;
        }
        let (mut to, mut e) = (at, 0.0);
        for word in body.split_whitespace().skip(1) {
            let value: f64 = word.get(1..).and_then(|v| v.parse().ok()).unwrap_or(f64::NAN);
            match word.as_bytes().first() {
                Some(b'X') => to[0] = value,
                Some(b'Y') => to[1] = value,
                Some(b'E') => e = value,
                Some(b'F') => feed = value,
                _ => {}
            }
        }
        let len = (to[0] - at[0]).hypot(to[1] - at[1]);
        if tower && e > 0.0 && len > 1e-9 {
            if layer > 1 {
                lo = lo.min(at[1].min(to[1]));
                hi = hi.max(at[1].max(to[1]));
            }
            let area = e * FIL / len;
            if area > 0.15 {
                // Solve the bead area h (w - h (1 - pi/4)) at h 0.2 for the width.
                cur.widths
                    .push(area / 0.2 + 0.2 * (1.0 - std::f64::consts::FRAC_PI_4));
                cur.feeds.push(feed);
                cur.mm3 += e * FIL;
                cur.extruding_steps += pending_step;
                pending_step = 0;
            } else if cur.mm3 > 0.0 && (to[1] - at[1]).abs() > 1e-6 {
                pending_step += 1;
            }
        }
        at = to;
    }
    (out, hi - lo)
}

/// The ramming of every change, from `cfg` on `boxes`.
fn rams_of(cfg: Value, boxes: &[(f64, f64, f64, u8)]) -> (Vec<Ram>, f64) {
    let (r, depth) = rams(&slice(cfg, boxes));
    assert!(r.len() >= 10, "{} changes ram: {r:?}", r.len());
    (r, depth)
}

#[test]
fn a_shared_nozzle_rams_before_each_change_at_its_own_feeds() {
    let (stock, _) = rams_of(mmu(2, STOCK, &[]), TWO);
    for r in &stock {
        assert!(
            (r.mm3 - 50.0).abs() < 0.5,
            "layer {}: rams {:.2} mm3",
            r.layer,
            r.mm3
        );
        assert!(r.widths.iter().all(|w| (w - 1.25).abs() < 0.01), "{:?}", r.widths);
        // 40 mm3/s over the 1.25 mm bead, past the 12 mm3/s limit.
        assert!(r.feeds.iter().all(|f| (f - 9941.0).abs() < 1.5), "{:?}", r.feeds);
        assert_eq!(
            r.extruding_steps, 0,
            "layer {}: the step between lines extrudes",
            r.layer
        );
    }
    // Each speed at its own feed: 10 to 60 mm3/s, 52.5 mm3.
    let (varied, _) = rams_of(mmu(2, "250 100 10 20 30 40 50 60 | 0.05 40 0.55 40", &[]), TWO);
    for r in &varied {
        assert!((r.mm3 - 52.5).abs() < 0.5, "{:.2}", r.mm3);
        let mut feeds = r.feeds.clone();
        feeds.sort_by(f64::total_cmp);
        feeds.dedup_by(|a, b| (*a - *b).abs() < 1.0);
        assert_eq!(feeds.len(), 6, "{feeds:?}");
        assert!(
            (feeds[0] - 2485.0).abs() < 1.5 && (feeds[5] - 14912.0).abs() < 2.5,
            "{feeds:?}"
        );
    }
    // Each change rams the old filament's tokens: 25 out of filament 2, 50 out of filament 1.
    let mix = mmu(
        2,
        STOCK,
        &[(
            "filament_ramming_parameters",
            json!([STOCK, "250 100 20 20 20 20 20 | 0.05 40 0.55 40"]),
        )],
    );
    let (mixed, _) = rams_of(mix, TWO);
    for r in &mixed {
        let want = if r.from == 1 { 25.0 } else { 50.0 };
        assert!((r.mm3 - want).abs() < 0.5, "out of T{}: {:.2}", r.from, r.mm3);
    }
    // Ramming off, or no speeds listed: no ramming.
    for (key, value) in [
        ("enable_filament_ramming", json!("0")),
        ("filament_ramming_parameters", json!(["250 100", "250 100"])),
        ("filament_ramming_parameters", json!(["", ""])),
    ] {
        let (none, _) = rams(&slice(mmu(2, STOCK, &[(key, value.clone())]), TWO));
        assert!(none.is_empty(), "{key} {value}: {none:?}");
    }
}

