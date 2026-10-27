// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A single extruder multi-material printer that rams on its type 2 tower prints the tower's wall on its box: the
//! wall's centerline runs along the box's edges, the first band starts at the wall's inner edge, and the ramming band
//! is its lines' exact pitch, so the last row lies a bead from the back wall. A tower that does not ram keeps its
//! wall half a bead inside the box.
//!
//! 15 mm boxes on an MK4 with the MMU and a tower at (20, 140): A 8 mm tall on filament 1 and B 3 mm on filament 2,
//! so every layer up to 3 mm changes filament once; with four filaments, two more boxes on filaments 3 (8 mm) and 4
//! (3 mm).

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

/// An MK4 with the MMU, `filaments` filaments and a 60 mm type 2 tower placed at (20, 140) that takes the whole flush
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
const FOUR: &[(f64, f64, f64, u8)] = &[
    (8.0, 102.5, 102.5, 1),
    (3.0, 132.5, 102.5, 2),
    (8.0, 102.5, 132.5, 3),
    (3.0, 132.5, 132.5, 4),
];

/// A tower layer from 0.4 to 3.0 mm: the X extent of its extruding moves, its wall sides' Y (the lowest and highest
/// lines that run the whole width) and the Y of its first and last line between them (ramming lines and rows).
#[derive(Debug, Clone, Copy)]
struct Layer {
    x: [f64; 2],
    walls: [f64; 2],
    first: f64,
    last: f64,
}

impl Layer {
    /// Wall to wall, mm.
    fn span(&self) -> f64 {
        self.walls[1] - self.walls[0]
    }
}

/// The tower's layers from 0.4 to 3.0 mm, and the X extent of everything it prints on the first layer.
fn tower_layers(gcode: &str) -> (Vec<Layer>, [f64; 2]) {
    // Per layer: the X extent and each horizontal line's Y with its X extent.
    type Lines = Vec<(f64, f64, f64)>;
    let mut layers: Vec<(f64, [f64; 2], Lines)> = Vec::new();
    let (mut z, mut at, mut tower) = (0.0, [f64::NAN; 2], false);
    for line in gcode.lines() {
        let s = line.trim();
        if let Some(name) = s.strip_prefix(";TYPE:").or_else(|| s.strip_prefix("; FEATURE:")) {
            tower = matches!(name.trim(), "Prime tower" | "Wipe tower");
            continue;
        }
        let body = s.split(';').next().unwrap_or("").trim();
        if !(body.starts_with("G1 ") || body.starts_with("G0 ")) {
            continue;
        }
        let (mut to, mut e) = (at, 0.0);
        for word in body.split_whitespace().skip(1) {
            let value: f64 = word.get(1..).and_then(|v| v.parse().ok()).unwrap_or(f64::NAN);
            match word.as_bytes().first() {
                Some(b'X') => to[0] = value,
                Some(b'Y') => to[1] = value,
                Some(b'Z') => z = value,
                Some(b'E') => e = value,
                _ => {}
            }
        }
        let len = (to[0] - at[0]).hypot(to[1] - at[1]);
        if tower && e > 0.0 && len > 1e-9 {
            if layers.last().is_none_or(|l| (l.0 - z).abs() > 1e-6) {
                layers.push((z, [f64::MAX, f64::MIN], Vec::new()));
            }
            if let Some(l) = layers.last_mut() {
                l.1 = [l.1[0].min(at[0].min(to[0])), l.1[1].max(at[0].max(to[0]))];
                if (to[1] - at[1]).abs() < 1e-3 {
                    let (lo, hi) = (at[0].min(to[0]), at[0].max(to[0]));
                    match l.2.iter_mut().find(|r| (r.0 - to[1]).abs() < 1e-3) {
                        Some(r) => *r = (r.0, r.1.min(lo), r.2.max(hi)),
                        None => l.2.push((to[1], lo, hi)),
                    }
                }
            }
        }
        at = to;
    }
    let first = layers.first().map_or([f64::NAN; 2], |l| l.1);
    let mut out = Vec::new();
    for (lz, x, mut rows) in layers {
        if !(0.39..=3.01).contains(&lz) {
            continue;
        }
        rows.sort_by(|a, b| a.0.total_cmp(&b.0));
        let full = |r: &(f64, f64, f64)| r.2 - r.1 > x[1] - x[0] - 0.05;
        let (Some(lo), Some(hi)) = (rows.first().copied(), rows.last().copied()) else {
            continue;
        };
        assert!(full(&lo) && full(&hi), "z {lz}: no wall sides in {rows:?}");
        let inner: Vec<f64> = rows[1..rows.len() - 1].iter().map(|r| r.0).collect();
        out.push(Layer {
            x,
            walls: [lo.0, hi.0],
            first: inner.first().copied().unwrap_or(f64::NAN),
            last: inner.last().copied().unwrap_or(f64::NAN),
        });
    }
    assert!(out.len() >= 10, "{} tower layers from 0.4 to 3.0", out.len());
    (out, first)
}

/// The tower of `cfg` on `boxes`.
fn tower_of(cfg: Value, boxes: &[(f64, f64, f64, u8)]) -> (Vec<Layer>, [f64; 2]) {
    tower_layers(&slice(cfg, boxes))
}

/// Asserts `v` lies within `lo` to `hi`.
fn within(v: f64, lo: f64, hi: f64, what: &str) {
    assert!((lo..=hi).contains(&v), "{what}: {v:.4}, not {lo} to {hi}");
}

#[test]
fn a_ramming_towers_wall_runs_on_its_box() {
    // Stock: the box from (20, 140), 60 wide and 12 deep.
    let (layers, first) = tower_of(mmu(2, &[]), TWO);
    for l in &layers {
        within(l.x[0], 19.95, 20.05, "left wall");
        within(l.x[1], 79.95, 80.05, "right wall");
        within(l.walls[0], 139.95, 140.05, "front wall");
        within(l.walls[1], 151.95, 152.05, "back wall");
        // The first ramming line is centered half a pitch past the wall's inner edge, and the last row lies a
        // bead from the back wall, so the two beads touch.
        within(l.first, 140.825, 140.925, "first ramming line");
        within(l.last, 151.45, 151.55, "last row");
        within(l.walls[1] - l.last, 0.4, 0.6, "back gap");
    }
    // The first layer's brim loops go round the wall: its outer loop 3.2 mm out.
    within(first[0], 16.75, 16.85, "brim left");
    within(first[1], 83.15, 83.25, "brim right");
}

#[test]
fn an_odd_count_of_ramming_lines_takes_its_exact_pitch() {
    // Three 1.25 mm ramming lines at width 80 take 3.75 mm, not eight rows.
    let (layers, _) = tower_of(mmu(2, &[("prime_tower_width", json!("80"))]), TWO);
    for l in &layers {
        within(l.span(), 9.1, 9.4, "80 mm tower");
    }
}

#[test]
fn extra_spacing_moves_the_lead_row_onto_the_last_ramming_line() {
    for (spacing, front, back) in [
        ("150%", (1.1, 1.25), (0.75, 0.9)),
        ("200%", (1.4, 1.6), (1.05, 1.2)),
    ] {
        let (layers, _) = tower_of(mmu(2, &[("wipe_tower_extra_spacing", json!(spacing))]), TWO);
        for l in &layers {
            within(
                l.first - l.walls[0],
                front.0,
                front.1,
                &format!("{spacing} front"),
            );
            within(l.walls[1] - l.last, back.0, back.1, &format!("{spacing} back"));
        }
    }
}

#[test]
fn the_towers_span_stays_with_the_wall_on_the_box() {
    for (cfg, boxes, span, what) in [
        (
            mmu(2, &[("prime_tower_width", json!("40"))]),
            TWO,
            18.5,
            "40 mm tower",
        ),
        (mmu(4, &[]), FOUR, 37.5, "four filaments"),
        (
            mmu(2, &[("flush_multiplier", json!(["1"]))]),
            TWO,
            30.0,
            "flush x 1.0",
        ),
    ] {
        let (layers, _) = tower_of(cfg, boxes);
        for l in &layers {
            within(l.span(), span - 0.05, span + 0.05, what);
        }
    }
}

#[test]
fn a_tower_that_does_not_ram_keeps_its_wall_inside_the_box() {
    for extra in [
        ("enable_filament_ramming", json!("0")),
        ("filament_ramming_parameters", json!(["250 100", "250 100"])),
    ] {
        let (layers, first) = tower_of(mmu(2, std::slice::from_ref(&extra)), TWO);
        for l in &layers {
            within(l.x[0], 20.2, 20.3, &format!("{extra:?} left wall"));
            within(l.walls[0], 140.2, 140.3, &format!("{extra:?} front wall"));
            within(l.first - l.walls[0], 0.7, 0.8, &format!("{extra:?} first row"));
        }
        within(first[0], 17.0, 17.1, &format!("{extra:?} brim left"));
    }
}
