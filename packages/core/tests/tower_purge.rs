// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! How much a single extruder multi-material printer purges on its type 2 tower at each tool change: the flush
//! matrix entry times `flush_multiplier`, never less than the new filament's `filament_minimal_purge_on_wipe_tower`,
//! and with flush into infill, objects or support, what the objects take comes on top of that floor.
//!
//! Two 15 mm boxes 30 mm apart, A 8 mm tall on filament 1 and B 3 mm on filament 2, so every layer up to 3 mm
//! changes filament once.

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

/// The 1.75 mm filament's cross-section, mm2.
const FIL: f64 = std::f64::consts::PI * 0.875 * 0.875;

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

/// A two-filament MK4 with the MMU and a 60 mm type 2 tower that takes the whole flush, at flow ratio 1; `extra`
/// over it.
fn mmu(extra: &[(&str, Value)]) -> Value {
    let bench: Value = serde_json::from_slice(
        &std::fs::read(format!(
            "{}/bench/configs/reference-0.20.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    let mut cfg = bench["config"].clone();
    for (k, v) in [
        ("printer_model", json!("Prusa MK4")),
        ("wipe_tower_type", json!("type2")),
        ("single_extruder_multi_material", json!("1")),
        ("use_relative_e_distances", json!("1")),
        ("printable_area", json!(["0x0", "250x0", "250x210", "0x210"])),
        ("filament_diameter", json!(["1.75", "1.75"])),
        ("filament_flow_ratio", json!(["1", "1"])),
        ("filament_colour", json!(["#F4EE2A", "#00AE42"])),
        ("wipe_tower_x", json!(["20"])),
        ("wipe_tower_y", json!(["140"])),
        ("prime_tower_width", json!("60")),
        ("enable_prime_tower", json!(true)),
        ("smart_layer", json!("off")),
        ("flush_volumes_matrix", json!(["0", "280", "280", "0"])),
        ("flush_multiplier", json!(["0.3"])),
        ("flush_into_infill", json!(false)),
        ("flush_into_support", json!(false)),
        ("flush_into_objects", json!(false)),
    ] {
        cfg[k] = v;
    }
    for (k, v) in extra {
        cfg[*k] = v.clone();
    }
    cfg
}

/// The G-code of the two boxes with `cfg`, centered on a `bed` mm bed.
#[allow(clippy::needless_pass_by_value, reason = "the callers hand over fresh values")]
fn slice(cfg: Value, bed: [f64; 2]) -> String {
    let (cx, cy) = (bed[0] / 2.0, bed[1] / 2.0);
    let objects: Vec<Value> = [(8.0, cx - 15.0, 1), (3.0, cx + 15.0, 2)]
        .iter()
        .enumerate()
        .map(|(k, &(h, x, slot))| {
            json!({"id": format!("o{k}"), "name": format!("box {k}"), "mesh": format!("15 15 {h}"),
                   "slotOverrides": {"box": slot, "box.stl": slot, "": slot},
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x - 7.5, cy - 7.5, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": bed[0], "depthMm": bed[1], "heightMm": 220}, "objects": objects},
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

const MMU_BED: [f64; 2] = [250.0, 210.0];

/// One tool change: the layer (1 for the first) and the purge rows the new filament wiped after it, mm3.
#[derive(Debug, Clone, Copy)]
struct Change {
    layer: usize,
    rows: f64,
}

/// Each tool change's purge rows: the tower filament after the change, up to the next feature, less the wall's (the
/// moves along an edge of the tower's box on that layer).
fn changes(gcode: &str) -> Vec<Change> {
    struct Move {
        layer: usize,
        change: Option<usize>,
        from: [f64; 2],
        to: [f64; 2],
        mm3: f64,
    }
    let (mut moves, mut out) = (Vec::new(), Vec::<Change>::new());
    let (mut layer, mut at, mut tower, mut open) = (0usize, [f64::NAN; 2], false, None);
    for line in gcode.lines() {
        let s = line.trim();
        if s.starts_with(";LAYER_CHANGE") {
            layer += 1;
            open = None;
            continue;
        }
        if let Some(name) = s.strip_prefix(";TYPE:").or_else(|| s.strip_prefix("; FEATURE:")) {
            tower = matches!(name.trim(), "Prime tower" | "Wipe tower");
            if !tower {
                open = None;
            }
            continue;
        }
        let body = s.split(';').next().unwrap_or("").trim();
        if body.starts_with('T') && body[1..].parse::<u8>().is_ok() {
            if layer > 0 {
                out.push(Change { layer, rows: 0.0 });
                open = Some(out.len() - 1);
            }
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
                _ => {}
            }
        }
        if e > 0.0 && tower && ((to[0] - at[0]).abs() > 1e-9 || (to[1] - at[1]).abs() > 1e-9) {
            moves.push(Move {
                layer,
                change: open,
                from: at,
                to,
                mm3: e * FIL,
            });
        }
        at = to;
    }
    // The tower's box on each layer: x from, x to, y from, y to.
    let mut boxes: std::collections::HashMap<usize, [f64; 4]> = std::collections::HashMap::new();
    for m in &moves {
        let b = boxes
            .entry(m.layer)
            .or_insert([f64::MAX, f64::MIN, f64::MAX, f64::MIN]);
        for p in [m.from, m.to] {
            *b = [b[0].min(p[0]), b[1].max(p[0]), b[2].min(p[1]), b[3].max(p[1])];
        }
    }
    for m in &moves {
        let b = boxes[&m.layer];
        let on =
            |axis: usize, edge: f64| (m.from[axis] - edge).abs() < 1e-3 && (m.to[axis] - edge).abs() < 1e-3;
        let wall = on(0, b[0]) || on(0, b[1]) || on(1, b[2]) || on(1, b[3]);
        if let Some(c) = m.change
            && !wall
        {
            out[c].rows += m.mm3;
        }
    }
    out
}

/// The purge rows of each change above the first layer, mm3.
fn later_rows(cfg: Value) -> Vec<f64> {
    let rows: Vec<f64> = changes(&slice(cfg, MMU_BED))
        .iter()
        .filter(|c| c.layer > 1)
        .map(|c| c.rows)
        .collect();
    assert!(rows.len() >= 10, "{} changes above the first layer", rows.len());
    rows
}

/// Every value of `rows` lies in `lo..hi`.
fn all_in(rows: &[f64], lo: f64, hi: f64, what: &str) {
    for (k, r) in rows.iter().enumerate() {
        assert!(
            (lo..hi).contains(r),
            "{what}: change {k} wipes {r:.2} mm3, not {lo} to {hi}: {rows:.2?}"
        );
    }
}

#[test]
fn a_zero_flush_matrix_purges_the_floor_whatever_the_prime_volume() {
    for pv in ["5", "90"] {
        let rows = later_rows(mmu(&[
            ("flush_volumes_matrix", json!(["0", "0", "0", "0"])),
            ("filament_minimal_purge_on_wipe_tower", json!(["40", "40"])),
            ("prime_volume", json!(pv)),
        ]));
        all_in(&rows, 40.0, 46.0, &format!("zero matrix, prime volume {pv}"));
    }
    let rows = later_rows(mmu(&[
        ("flush_volumes_matrix", json!(["0", "0", "0", "0"])),
        ("prime_volume", json!("90")),
    ]));
    all_in(&rows, 15.0, 21.0, "zero matrix, default floor");
}

#[test]
fn flush_into_infill_leaves_at_least_the_floor_on_the_tower() {
    let infill = |extra: &[(&str, Value)]| {
        let mut pairs = vec![
            ("flush_into_infill", json!(true)),
            ("sparse_infill_density", json!(50)),
        ];
        pairs.extend(extra.iter().cloned());
        mmu(&pairs)
    };
    // 50 x 0.3 under a floor of 40.
    let low = later_rows(infill(&[
        ("flush_volumes_matrix", json!(["0", "50", "50", "0"])),
        ("filament_minimal_purge_on_wipe_tower", json!(["40", "40"])),
    ]));
    all_in(&low, 40.0, 46.0, "matrix 50, floor 40");
    // The stock flush at a floor of 80: the infill takes its share down to the floor and no further.
    let high = later_rows(infill(&[(
        "filament_minimal_purge_on_wipe_tower",
        json!(["80", "80"]),
    )]));
    all_in(&high, 80.0, 100.0, "matrix 280, floor 80");
    // At the default floor of 15 the infill's share stays off the tower.
    let stock = later_rows(infill(&[]));
    let plain = later_rows(mmu(&[("sparse_infill_density", json!(50))]));
    assert!(
        stock.iter().any(|r| *r < plain[0] - 5.0) && plain.iter().all(|r| (r - plain[0]).abs() < 0.1),
        "{stock:.2?} against {plain:.2?}"
    );
}

#[test]
fn a_change_purges_the_flush_times_the_multiplier_in_whole_rows() {
    // 280 x 0.3 is 84 mm3, laid as the least whole rows that reach it.
    let rows = later_rows(mmu(&[]));
    all_in(&rows, 84.0, 91.0, "matrix 280 x 0.3");
    let full = later_rows(mmu(&[("flush_multiplier", json!(["1"]))]));
    all_in(&full, 280.0, 287.0, "matrix 280 x 1.0");
}
