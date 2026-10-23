// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! atlas places the prime tower clear of everything the objects lay down on the bed, not only their outlines: the
//! support's first layer, the brim and the skirt. The features plate (a cube and a table with support) put it on
//! the table's support and across the skirt before.

use serde_json::Value;
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};
use sx_core::collide::Kind;

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

/// The first layer's extruding moves of each feature, as segments.
fn first_layer(gcode: &str) -> Vec<(String, [f64; 2], [f64; 2])> {
    let (mut feature, mut at, mut layer) = (String::new(), None::<[f64; 2]>, 0);
    let mut out = Vec::new();
    for line in gcode.lines() {
        if line.starts_with(";LAYER_CHANGE") {
            layer += 1;
            if layer > 1 {
                break;
            }
        }
        if let Some(f) = line
            .strip_prefix("; FEATURE: ")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            f.trim().clone_into(&mut feature);
        }
        if !(line.starts_with("G1 ") || line.starts_with("G0 ")) {
            continue;
        }
        let word = |c: char| {
            line.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        let next = match (word('X'), word('Y'), at) {
            (Some(x), Some(y), _) => [x, y],
            (Some(x), None, Some(p)) => [x, p[1]],
            (None, Some(y), Some(p)) => [p[0], y],
            _ => continue,
        };
        if let (Some(p), Some(e)) = (at, word('E'))
            && e > 0.0
            && line.starts_with("G1 ")
        {
            out.push((feature.clone(), p, next));
        }
        at = Some(next);
    }
    out
}

/// True when the segment `a`-`b` touches the box `[x0, y0, x1, y1]` (Liang-Barsky clipping).
fn hits_box(a: [f64; 2], b: [f64; 2], r: [f64; 4]) -> bool {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [
        (-dx, a[0] - r[0]),
        (dx, r[2] - a[0]),
        (-dy, a[1] - r[1]),
        (dy, r[3] - a[1]),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return false;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
        }
    }
    t0 <= t1
}

#[test]
fn the_tower_stands_clear_of_support_and_skirt_on_the_features_plate() {
    let dir = format!("{}/packages/core/cli/tests/fixtures", root());
    let mut req: Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{dir}/features-request.json")).unwrap())
            .unwrap();
    // the engine picks the spot, as it did when the tower landed on the table's support
    req["config"]["prime_tower_auto_position"] = Value::Bool(true);
    let meshes = req["meshes"].clone();
    req.as_object_mut().unwrap().remove("meshes");
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let load = move |m: &str| {
        let file = meshes[m].as_str().unwrap_or(m).to_owned();
        let bytes = std::fs::read(format!("{dir}/{file}")).unwrap();
        Ok(Arc::new(Mesh::load(&bytes, &file).unwrap()))
    };
    let run = api::run_request(&req, &load).unwrap();
    let crossings: Vec<_> = run
        .report
        .collisions
        .iter()
        .filter(|c| c.kind == Kind::PathConflict)
        .collect();
    assert!(crossings.is_empty(), "{crossings:?}");
    let moves = first_layer(&String::from_utf8_lossy(&run.gcode));
    let tower: Vec<_> = moves.iter().filter(|m| m.0 == "Prime tower").collect();
    assert!(!tower.is_empty(), "the plate prints a tower");
    let b = tower
        .iter()
        .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, m| {
            [
                b[0].min(m.1[0]).min(m.2[0]),
                b[1].min(m.1[1]).min(m.2[1]),
                b[2].max(m.1[0]).max(m.2[0]),
                b[3].max(m.1[1]).max(m.2[1]),
            ]
        });
    for (feature, a, c) in &moves {
        if matches!(
            feature.as_str(),
            "Support" | "Support interface" | "Skirt" | "Brim"
        ) {
            assert!(
                !hits_box(*a, *c, b),
                "{feature} {a:?} to {c:?} runs through the tower at {b:?}"
            );
        }
    }
}

/// A box from `lo` to `hi` in filament `slot`.
fn block(lo: [f32; 3], hi: [f32; 3], slot: u8) -> api::MeshPart {
    let positions = (0..8)
        .map(|i| {
            [
                if i & 1 == 0 { lo[0] } else { hi[0] },
                if i & 2 == 0 { lo[1] } else { hi[1] },
                if i & 4 == 0 { lo[2] } else { hi[2] },
            ]
        })
        .collect();
    api::MeshPart {
        name: format!("block {slot}"),
        slot,
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
        ..api::MeshPart::default()
    }
}

/// Slices `parts` as one object with its front left corner at `at` on a `bed` mm plate.
fn slice_parts(parts: Vec<api::MeshPart>, at: [f64; 2], bed: [f64; 2], config: &Value) -> api::SliceRun {
    let mesh = Arc::new(Mesh {
        name: "parts".into(),
        parts,
        ..Mesh::default()
    });
    let req: SliceRequest = serde_json::from_value(serde_json::json!({
        "plate": {
            "bed": {"widthMm": bed[0], "depthMm": bed[1], "heightMm": 250},
            "objects": [{"id": "o0", "name": "parts", "mesh": "m0",
                "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], 0, 1]}],
        },
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    api::run_request(&req, &move |_| Ok(mesh.clone())).unwrap()
}

/// Every prime tower extrusion that moves, by layer (0 is the first), as segments.
fn tower_moves(gcode: &str) -> Vec<(usize, [f64; 2], [f64; 2])> {
    let (mut feature, mut at, mut layer) = (String::new(), None::<[f64; 2]>, None::<usize>);
    let mut out = Vec::new();
    for line in gcode.lines() {
        if line.starts_with(";LAYER_CHANGE") || line.starts_with("; CHANGE_LAYER") {
            layer = Some(layer.map_or(0, |l| l + 1));
        }
        if let Some(f) = line
            .strip_prefix("; FEATURE: ")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            f.trim().clone_into(&mut feature);
        }
        if !(line.starts_with("G1 ") || line.starts_with("G0 ")) {
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        let word = |c: char| {
            code.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        let next = match (word('X'), word('Y'), at) {
            (Some(x), Some(y), _) => [x, y],
            (Some(x), None, Some(p)) => [x, p[1]],
            (None, Some(y), Some(p)) => [p[0], y],
            _ => continue,
        };
        if let (Some(p), Some(e), Some(l)) = (at, word('E'), layer)
            && e > 0.0
            && line.starts_with("G1 ")
            && feature == "Prime tower"
            && (p[0] - next[0]).abs() + (p[1] - next[1]).abs() > 1e-9
        {
            out.push((l, p, next));
        }
        at = Some(next);
    }
    out
}

/// Checks that the box the report gives for the tower (`footprint`) holds every tower extrusion the G-code makes
/// on every layer, and that the first layer reaches it on every side: the box is what prints, not more. `offset`
/// is the printer's `extruder_offset`, which the G-code takes off the plate coordinates.
fn assert_report_holds_the_tower(run: &api::SliceRun, offset: [f64; 2], what: &str) {
    let t = run
        .report
        .prime_tower
        .as_ref()
        .unwrap_or_else(|| panic!("{what}: no tower in the report"));
    let f = t.footprint;
    let moves = tower_moves(&String::from_utf8_lossy(&run.gcode));
    assert!(!moves.is_empty(), "{what}: no tower printed");
    // Points are bead centers: the tower's beads are half a 0.5 mm bead wide either side of them.
    let half = 0.25;
    let mut first = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for (layer, a, b) in &moves {
        for g in [a, b] {
            let p = [g[0] + offset[0], g[1] + offset[1]];
            // 0.05 mm covers the G-code's rounding.
            assert!(
                p[0] - half >= f[0] - 0.05
                    && p[1] - half >= f[1] - 0.05
                    && p[0] + half <= f[2] + 0.05
                    && p[1] + half <= f[3] + 0.05,
                "{what}: layer {} prints the tower at {p:?}, outside the reported {f:?}",
                layer + 1
            );
            if *layer == 0 {
                first = [
                    first[0].min(p[0] - half),
                    first[1].min(p[1] - half),
                    first[2].max(p[0] + half),
                    first[3].max(p[1] + half),
                ];
            }
        }
    }
    let slack = (0..4).map(|k| (f[k] - first[k]).abs()).fold(0.0, f64::max);
    assert!(
        slack < 0.1,
        "{what}: the first layer prints {first:?}, the report gives {f:?}"
    );
}

#[test]
fn an_auto_placed_tower_keeps_clear_of_the_grid_supports_first_layer() {
    // A part with a 30 mm cap on a 10 mm stem, support in filament 2. Grid support stretches the cap's islands to
    // whole cells of its grid, so the first layer pad reached about 4.3 mm past the cap where the tower's spot
    // allowed for 2.45: the tower stood 3.45 mm from the cap and its brim crossed the pad.
    let parts = vec![
        block([10.0, 10.0, 0.0], [20.0, 20.0, 10.0], 1),
        block([0.0, 0.0, 10.0], [30.0, 30.0, 13.0], 1),
    ];
    let config = serde_json::json!({
        "enable_prime_tower": true,
        "prime_tower_auto_position": true,
        "enable_support": true,
        "support_filament": 2,
        "filament_type": ["PLA", "PLA"],
        "filament_colour": ["#f8f8f2", "#2255ff"],
        "printable_area": [[0, 0], [256, 0], [256, 256], [0, 256]],
        "bed_exclude_area": [[0, 0], [100, 0], [100, 100], [0, 100]],
    });
    let run = slice_parts(parts, [150.0, 150.0], [256.0, 256.0], &config);
    let crossings: Vec<_> = run
        .report
        .collisions
        .iter()
        .filter(|c| c.kind == Kind::PathConflict)
        .collect();
    assert!(crossings.is_empty(), "{crossings:?}");
    assert_report_holds_the_tower(&run, [0.0, 0.0], "capped part");
}

/// A shipped printer's machine settings (`model` in the profiles) with the maker's 0.20 mm Standard process for
/// `preset`.
fn printer(model: &str, name: &str, preset: &str) -> Value {
    let read = |path: &str| -> Value {
        serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
    };
    let mut c = read("packages/profiles/machine.json")["models"][model]["machine"].clone();
    let process = read("packages/profiles/process-speeds.json")["presets"]
        [format!("Bambu Studio/BBL/0.20mm Standard @BBL {preset}")]
    .clone();
    for (k, v) in process.as_object().unwrap() {
        c[k] = v.clone();
    }
    c["printer_model"] = Value::from(name);
    c
}

#[test]
fn the_reported_tower_holds_every_tower_extrusion_on_every_layer() {
    // Four 8 mm blocks side by side, one per filament (with two filaments, alternating), so every layer changes
    // filament; the tower where the profile puts it and where the engine picks, on one and two nozzle printers,
    // with a plain wall and with a rib wall.
    let printers = [
        ("bambu-p1s", "Bambu Lab P1S", "X1C", "rectangle"),
        ("bambu-p1s", "Bambu Lab P1S", "X1C", "rib"),
        ("bambu-a1", "Bambu Lab A1", "A1", "rectangle"),
        ("bambu-x1-carbon", "Bambu Lab X1 Carbon", "X1C", "rectangle"),
        ("bambu-h2d", "Bambu Lab H2D", "H2D", "rectangle"),
    ];
    let colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"];
    for (model, name, preset, wall) in printers {
        for tools in [2u8, 4] {
            for auto in [false, true] {
                let mut c = printer(model, name, preset);
                c["enable_prime_tower"] = Value::Bool(true);
                c["prime_tower_auto_position"] = Value::Bool(auto);
                c["wipe_tower_x"] = serde_json::json!([60]);
                c["wipe_tower_y"] = serde_json::json!([200]);
                c["skirt_loops"] = Value::from(0);
                c["brim_width"] = Value::from(0);
                c["wipe_tower_wall_type"] = Value::from(wall);
                let n = usize::from(tools);
                c["filament_colour"] = serde_json::json!(colors[..n]);
                c["filament_type"] = serde_json::json!(vec!["PLA"; n]);
                if model == "bambu-h2d" {
                    // The first half of the filaments on the left nozzle, the rest on the right.
                    let map: Vec<usize> = (0..n).map(|k| 1 + 2 * k / n).collect();
                    c["filament_map_mode"] = Value::from("Manual");
                    c["filament_map"] = serde_json::json!(map);
                }
                let parts = (0..4u8)
                    .map(|k| {
                        let x = f32::from(k) * 8.0;
                        block([x, 0.0, 0.0], [x + 8.0, 8.0, 6.0], 1 + k % tools)
                    })
                    .collect();
                // The G-code's coordinates are the plate's less the first extruder's offset.
                let offset = c["extruder_offset"]
                    .get(0)
                    .and_then(Value::as_str)
                    .and_then(|o| o.split_once('x'))
                    .map_or([0.0, 0.0], |(x, y)| {
                        [x.parse().unwrap_or(0.0), y.parse().unwrap_or(0.0)]
                    });
                let bed = if model == "bambu-h2d" {
                    [350.0, 320.0]
                } else {
                    [256.0, 256.0]
                };
                let run = slice_parts(parts, [120.0, 100.0], bed, &c);
                assert_report_holds_the_tower(
                    &run,
                    offset,
                    &format!("{name}, {wall} tower, {tools} filaments, auto {auto}"),
                );
            }
        }
    }
}
