// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A single extruder multi-material printer that rams on its type 2 tower lays each wipe's rows in a cycle of four
//! turns: two diagonal ones that turn out to the wall's inner edge, so the next row is 1.5 wall beads longer at that
//! end, then two straight ones. A lead row heading right also runs on to the inner edge. The wipe lays the fewest rows
//! whose own lengths reach its volume, so it takes one row fewer than plain rows would near a row boundary.
//!
//! 15 mm boxes on an MK4 with the MMU and a tower at (20, 140): A 8 mm tall on filament 1 and B 3 mm on filament 2,
//! so every layer up to 3 mm changes filament once.

#![allow(clippy::disallowed_methods, reason = "test geometry, not engine output")]

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

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

/// An MK4 with the MMU, `filaments` filaments and a 60 mm rectangle type 2 tower placed at (20, 140) that takes the whole flush
/// (280 x 0.3), at flow ratio 1, every filament ramming with the stock ramming; `extra` over it.
fn mmu(filaments: usize, extra: &[(&str, Value)]) -> Value {
    let ram = STOCK;
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
        ("wipe_tower_wall_type", json!("rectangle")),
        ("enable_prime_tower", json!(true)),
        ("prime_tower_auto_position", json!(false)),
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

/// One tower layer from 0.4 to 3.0 mm: its wipe rows in print order (the 0.4 to 0.6 mm wide lines along X shorter
/// than the tower, as Y, start X and end X), the steps between them in mm3, and its wall sides' Y.
#[derive(Debug, Clone)]
struct Layer {
    rows: Vec<(f64, f64, f64)>,
    rows_mm3: f64,
    steps_mm3: f64,
    walls: [f64; 2],
}

impl Layer {
    fn lengths(&self) -> Vec<f64> {
        self.rows.iter().map(|r| (r.2 - r.1).abs()).collect()
    }
}

/// The tower layers of a plate whose tower is `width` wide, from 0.4 to 3.0 mm.
fn tower_layers(gcode: &str, width: f64) -> Vec<Layer> {
    let fa = std::f64::consts::PI * 0.875 * 0.875;
    let mut layers: Vec<(f64, Layer)> = Vec::new();
    let (mut z, mut at, mut tower, mut brim) = (0.0, [f64::NAN; 2], false, false);
    for line in gcode.lines() {
        let text = line.trim();
        if let Some(name) = text
            .strip_prefix(";TYPE:")
            .or_else(|| text.strip_prefix("; FEATURE:"))
        {
            tower = matches!(name.trim(), "Prime tower" | "Wipe tower");
            continue;
        }
        if text.starts_with("; WIPE_TOWER_BRIM_START") {
            brim = true;
        } else if text.starts_with("; WIPE_TOWER_BRIM_END") {
            brim = false;
        }
        let body = text.split(';').next().unwrap_or("").trim();
        if !(body.starts_with("G1 ") || body.starts_with("G0 ")) {
            continue;
        }
        let (mut to, mut extruded) = (at, 0.0);
        for word in body.split_whitespace().skip(1) {
            let value: f64 = word
                .get(1..)
                .and_then(|digits| digits.parse().ok())
                .unwrap_or(f64::NAN);
            match word.as_bytes().first() {
                Some(b'X') => to[0] = value,
                Some(b'Y') => to[1] = value,
                Some(b'Z') => z = value,
                Some(b'E') => extruded = value,
                _ => {}
            }
        }
        let len = (to[0] - at[0]).hypot(to[1] - at[1]);
        if tower && !brim && extruded > 0.0 && len > 1e-9 {
            if layers.last().is_none_or(|last| (last.0 - z).abs() > 1e-6) {
                let layer = Layer {
                    rows: Vec::new(),
                    rows_mm3: 0.0,
                    steps_mm3: 0.0,
                    walls: [f64::MAX, f64::MIN],
                };
                layers.push((z, layer));
            }
            if let Some((_, layer)) = layers.last_mut() {
                let volume = extruded * fa;
                let bead = volume / len / 0.2 + 0.2 * (1.0 - std::f64::consts::PI / 4.0);
                let flat = (to[1] - at[1]).abs() < 1e-3;
                if flat && len >= width - 0.1 {
                    layer.walls = [layer.walls[0].min(to[1]), layer.walls[1].max(to[1])];
                } else if (0.4..0.6).contains(&bead) {
                    if flat && len > 1.0 {
                        layer.rows.push((to[1], at[0], to[0]));
                        layer.rows_mm3 += volume;
                    } else if !flat && len < 1.2 && !layer.rows.is_empty() {
                        layer.steps_mm3 += volume;
                    }
                }
            }
        }
        at = to;
    }
    let out: Vec<Layer> = layers
        .into_iter()
        .filter(|(lz, _)| (0.39..=3.01).contains(lz))
        .map(|(_, l)| l)
        .collect();
    assert!(out.len() >= 10, "{} tower layers from 0.4 to 3.0", out.len());
    out
}

/// The tower layers of a `width` mm tower at flush multiplier `mult`.
fn tower_of(width: f64, mult: &str) -> Vec<Layer> {
    let cfg = mmu(
        2,
        &[
            ("prime_tower_width", json!(width.to_string())),
            ("flush_multiplier", json!([mult])),
        ],
    );
    tower_layers(&slice(cfg, TWO), width)
}

/// Asserts `v` lies within `lo` to `hi`.
fn within(v: f64, lo: f64, hi: f64, what: &str) {
    assert!((lo..=hi).contains(&v), "{what}: {v:.4}, not {lo} to {hi}");
}

#[test]
fn a_wipe_lays_the_fewest_rows_that_reach_its_volume() {
    // Rows including the leading row, at 60 mm: one fewer than plain rows near a boundary.
    for (mult, rows) in [("0.96", 48), ("0.98", 49), ("1", 50), ("1.02", 51)] {
        for l in tower_of(60.0, mult) {
            assert_eq!(l.rows.len(), rows, "60 mm x {mult}: {:?}", l.lengths());
        }
    }
    // The 280 x 1.0 tower is half a row shallower.
    for l in tower_of(60.0, "1") {
        within(l.walls[1] - l.walls[0], 29.9, 30.1, "60 mm x 1 depth");
    }
}

#[test]
fn rows_either_side_of_a_boundary_follow_their_own_lengths() {
    // The wipe's rows after its lead, a little past and a little short of a row boundary at four widths.
    for (width, mult, after) in [
        (40.0, "0.5497", 40),
        (40.0, "0.5568", 41),
        (50.0, "0.6575", 38),
        (50.0, "0.6647", 39),
        (70.0, "0.8829", 36),
        (70.0, "0.89", 37),
        (60.0, "0.908", 45),
    ] {
        for l in tower_of(width, mult) {
            assert_eq!(l.rows.len() - 1, after, "{width} mm x {mult}: {:?}", l.lengths());
        }
    }
}

#[test]
fn rows_turn_out_to_the_walls_inner_edge_on_half_the_turns() {
    for l in tower_of(60.0, "1") {
        let lengths = l.lengths();
        let (mut plain, mut long) = (0usize, 0usize);
        for len in &lengths[1..] {
            if (len - 58.0).abs() < 1e-3 {
                plain += 1;
            } else if (len - 58.75).abs() < 1e-3 {
                long += 1;
            } else {
                panic!("row {len} in {lengths:?}");
            }
        }
        assert!(plain.abs_diff(long) <= 2, "{plain} plain and {long} long");
        // The rows after the leading row start at the inner edge in pairs from the first.
        for (k, r) in l.rows.iter().enumerate().skip(1) {
            let out = (k - 1) % 4 < 2;
            let start = if r.2 > r.1 { 20.25 } else { 79.75 };
            assert_eq!((r.1 - start).abs() < 1e-3, out, "row {k} starts at {}", r.1);
            assert!(
                (r.2 - 21.0).abs() < 1e-3 || (r.2 - 79.0).abs() < 1e-3,
                "row {k} ends at {}",
                r.2
            );
        }
        within(l.rows_mm3 + l.steps_mm3, 266.0, 268.5, "rows and steps, mm3");
    }
}

#[test]
fn a_lead_row_heading_right_runs_to_the_inner_edge() {
    // An odd count of ramming lines leaves the leading row heading right, and it ends at the inner edge.
    for (width, mult, lead) in [(80.0, "1", 28.889), (50.0, "0.6647", 35.889)] {
        for l in tower_of(width, mult) {
            let r = l.rows[0];
            assert!(
                (r.2 - (20.0 + width - 0.25)).abs() < 1e-3,
                "{width} mm lead ends at {}",
                r.2
            );
            within(r.2 - r.1, lead - 0.01, lead + 0.01, &format!("{width} mm lead"));
        }
    }
}

#[test]
fn counts_away_from_a_boundary_stay() {
    for (width, mult, rows) in [
        (60.0, "0.90", 45),
        (60.0, "0.93", 47),
        (60.0, "0.3", 14),
        (80.0, "0.3", 11),
        (80.0, "0.5", 18),
        (80.0, "0.93", 35),
        (80.0, "0.96", 36),
        (80.0, "1", 38),
        (80.0, "1.03", 39),
    ] {
        for l in tower_of(width, mult) {
            assert_eq!(l.rows.len(), rows, "{width} mm x {mult}: {:?}", l.lengths());
        }
    }
}
