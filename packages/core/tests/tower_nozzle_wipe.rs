// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The short nozzle wipe at the start of each wipe after a tool change on a Bambu Lab type prime tower
//! (`prime_tower_skip_points`, on by default): 3 mm of the first row, a retraction, a travel back over the row's
//! start at 10 mm/s and forward again at 4 mm/s, the unretraction, then the rest of the row. With
//! `prime_tower_flat_ironing` a square spiral round the row start comes between. A type 2 tower never does it.

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

/// An ASCII STL of a box from the origin to `size`.
fn box_stl(size: [f64; 3]) -> Vec<u8> {
    use std::fmt::Write as _;
    let corner = |index: usize| {
        std::array::from_fn::<f64, 3, _>(|axis| if index >> axis & 1 == 0 { 0.0 } else { size[axis] })
    };
    // Two outward triangles per face, by corner index (bit 0 x, bit 1 y, bit 2 z).
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

/// Two 20 mm boxes 2 mm tall in two filaments on the stock A1 with the prime tower on, so every layer, the first
/// included, changes filament; `extra` settings over it. Gives the G-code and the filament each slot used, mm.
fn slice(extra: &[(&str, Value)]) -> (String, Vec<f64>) {
    let path = format!(
        "{}/cli/tests/fixtures/xmark-2color-a1-request.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let req: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut cfg = req["config"].clone();
    cfg["enable_prime_tower"] = json!(true);
    for (k, v) in extra {
        cfg[*k] = v.clone();
    }
    let objects: Vec<Value> = [[60.0, 60.0], [120.0, 60.0]]
        .iter()
        .enumerate()
        .map(|(index, corner)| {
            json!({"id": format!("o{index}"), "name": format!("box {}", index + 1), "mesh": "box",
                   "slotOverrides": {"box": index + 1, "box.stl": index + 1, "": index + 1},
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, corner[0], corner[1], 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": 256, "depthMm": 256, "heightMm": 256}, "objects": objects},
        "config": cfg,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let m = Arc::new(Mesh::load(&box_stl([20.0, 20.0, 2.0]), "box.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    let used: Vec<f64> = run.report.stats.filament_mm.clone();
    (String::from_utf8_lossy(&run.gcode).into_owned(), used)
}

/// One move of the G-code: where from, where to, whether it extrudes, the E-only length, and the F word.
#[derive(Debug, Clone)]
struct Move {
    from: [f64; 2],
    to: [f64; 2],
    extrudes: bool,
    e_only: Option<f64>,
    f: Option<f64>,
}

/// A post-change tower block: its layer, the moves and the other lines in order.
#[derive(Debug, Default)]
struct Block {
    layer: usize,
    lines: Vec<(String, Option<Move>)>,
}

fn blocks(gcode: &str) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    let (mut at, mut layer, mut open) = ([0.0, 0.0], 0usize, false);
    for line in gcode.lines() {
        if line.starts_with("; CHANGE_LAYER") || line.starts_with(";LAYER_CHANGE") {
            layer += 1;
        }
        if line.starts_with("; CP TOOLCHANGE WIPE") {
            open = true;
            out.push(Block {
                layer: layer.saturating_sub(1),
                ..Block::default()
            });
            continue;
        }
        if line.starts_with("; CP TOOLCHANGE END") {
            open = false;
        }
        let code = line.split(';').next().unwrap_or("").trim();
        let mv = if code.starts_with("G0 ") || code.starts_with("G1 ") {
            let word = |c: char| {
                code.split_whitespace()
                    .skip(1)
                    .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
            };
            let to = [word('X').unwrap_or(at[0]), word('Y').unwrap_or(at[1])];
            let moved = word('X').is_some() || word('Y').is_some();
            let e = word('E');
            let m = Move {
                from: at,
                to,
                extrudes: moved && e.is_some_and(|e| e > 0.0),
                e_only: (!moved).then_some(e).flatten(),
                f: word('F'),
            };
            at = to;
            Some(m)
        } else {
            None
        };
        if open && let Some(b) = out.last_mut() {
            b.lines.push((line.to_owned(), mv));
        }
    }
    out
}

fn len(m: &Move) -> f64 {
    let (dx, dy) = (m.to[0] - m.from[0], m.to[1] - m.from[1]);
    (dx * dx + dy * dy).sqrt()
}

/// The wipe of a block: the extrusion before the retraction, the travels between the retraction and the
/// unretraction, the lines between them, and the lines from the unretraction to the next extrusion.
struct Wipe {
    lead: Move,
    retract: f64,
    travels: Vec<Move>,
    unretract: f64,
    after: Vec<String>,
    between: Vec<String>,
    resume: Move,
}

fn wipes(b: &Block) -> Vec<Wipe> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.lines.len() {
        let retract = b.lines[i].1.as_ref().and_then(|m| m.e_only).filter(|e| *e < 0.0);
        // The last move before it (a progress line may come between).
        let lead = b.lines[..i]
            .iter()
            .rev()
            .find_map(|l| l.1.clone())
            .filter(|m| m.extrudes);
        if let (Some(retract), Some(lead)) = (retract, lead) {
            let mut travels = Vec::new();
            let mut between = Vec::new();
            let mut j = i + 1;
            let mut unretract = 0.0;
            while let Some((text, mv)) = b.lines.get(j) {
                match mv {
                    Some(m) if m.e_only.is_some_and(|e| e > 0.0) => {
                        unretract = m.e_only.unwrap();
                        break;
                    }
                    Some(m) => travels.push(m.clone()),
                    None => between.push(text.clone()),
                }
                j += 1;
            }
            let mut after = Vec::new();
            let mut k = j + 1;
            while let Some((text, mv)) = b.lines.get(k) {
                if mv.as_ref().is_some_and(|m| m.extrudes) {
                    break;
                }
                after.push(text.clone());
                k += 1;
            }
            let resume = b
                .lines
                .get(k)
                .and_then(|l| l.1.clone())
                .expect("the row goes on after the wipe");
            out.push(Wipe {
                lead,
                retract,
                travels,
                unretract,
                after,
                between,
                resume,
            });
            i = k;
        }
        i += 1;
    }
    out
}

const NEAR: f64 = 0.002;

#[test]
fn every_wipe_after_a_tool_change_starts_with_the_nozzle_wipe() {
    // The first layer travels at 1000 mm/s2 and prints at 500.
    let (gcode, used) = slice(&[("initial_layer_travel_acceleration", json!(1000))]);
    let all = blocks(&gcode);
    assert!(
        all.len() >= 5,
        "the plate changes filament on several layers: {}",
        all.len()
    );
    assert!(all.iter().any(|b| b.layer == 0), "and on the first layer");
    for b in &all {
        let w = wipes(b);
        assert_eq!(w.len(), 1, "one nozzle wipe in the block on layer {}", b.layer);
        let w = &w[0];
        // 3 mm of the row, then the profile's 0.8 mm retraction both ways.
        assert!((len(&w.lead) - 3.0).abs() < NEAR, "{:?}", w.lead);
        assert!((w.retract + 0.8).abs() < 1e-9 && (w.unretract - 0.8).abs() < 1e-9);
        assert_eq!(
            w.travels.len(),
            2,
            "back and forward, nothing else: {:?}",
            w.travels
        );
        let (back, forward) = (&w.travels[0], &w.travels[1]);
        assert_eq!((back.f, forward.f), (Some(600.0), Some(240.0)));
        assert!((len(back) - 4.5).abs() < NEAR && (len(forward) - 4.5).abs() < NEAR);
        // Back past the row start, forward to where the extrusion stopped, then on along the same row.
        let dir = [w.lead.to[0] - w.lead.from[0], w.lead.to[1] - w.lead.from[1]];
        let back_dir = [back.to[0] - back.from[0], back.to[1] - back.from[1]];
        assert!(
            dir[0] * back_dir[0] + dir[1] * back_dir[1] < 0.0,
            "the travel goes back over the start"
        );
        assert!((forward.to[0] - w.lead.to[0]).abs() < NEAR && (forward.to[1] - w.lead.to[1]).abs() < NEAR);
        let on = [w.resume.to[0] - w.lead.to[0], w.resume.to[1] - w.lead.to[1]];
        assert!((dir[0] * on[1] - dir[1] * on[0]).abs() < 1e-2 && dir[0] * on[0] + dir[1] * on[1] > 0.0);
        assert_eq!(
            w.resume.f,
            w.lead.f.or(w.resume.f),
            "the row resumes at its own feed"
        );
        // The reheat comes after the unretraction, on the layers above the first only.
        let reheat = w
            .after
            .iter()
            .any(|l| l.contains("Wipe tower reheat before wipe"));
        assert_eq!(reheat, b.layer > 0, "layer {}: {:?}", b.layer, w.after);
        assert!(w.between.iter().all(|l| !l.contains("reheat")));
        // First layer: the first layer's travel acceleration before the travels, its print acceleration after.
        if b.layer == 0 {
            assert_eq!(w.between, ["M204 S1000"], "{:?}", w.between);
            assert_eq!(w.after, ["M204 S500"]);
        }
    }
    // The wipe adds no extrusion.
    let (_, off) = slice(&[
        ("initial_layer_travel_acceleration", json!(1000)),
        ("prime_tower_skip_points", json!(false)),
    ]);
    for (a, b) in used.iter().zip(&off) {
        assert!((a - b).abs() <= 1e-4 * b.max(1.0), "{used:?} against {off:?}");
    }
}

#[test]
fn skip_points_off_leaves_the_wipe_out() {
    let (gcode, _) = slice(&[("prime_tower_skip_points", json!(false))]);
    assert!(!blocks(&gcode).is_empty());
    assert!(!gcode.contains(" F240\n"), "no slow forward travel");
    assert!(!gcode.contains("Wipe tower reheat"));
    for b in blocks(&gcode) {
        assert!(wipes(&b).is_empty(), "layer {}", b.layer);
    }
}

#[test]
fn flat_ironing_spirals_round_the_row_start() {
    let (gcode, _) = slice(&[("prime_tower_flat_ironing", json!(true))]);
    let all = blocks(&gcode);
    assert!(!all.is_empty());
    for b in &all {
        let w = wipes(b);
        assert_eq!(w.len(), 1, "layer {}", b.layer);
        let t = &w[0].travels;
        // Back 4.5 mm, forward 1.5 mm to the row start, eight spiral moves, back to the end of the extrusion
        // (from the spiral's last corner, a bead behind and two beads aside of the start: 4.12 mm).
        assert_eq!(t.len(), 11, "{t:?}");
        let lens: Vec<f64> = t.iter().map(len).collect();
        let want = [4.5, 1.5, 0.5, 0.5, 1.0, 1.0, 1.5, 1.5, 2.0, 2.0, 17f64.sqrt()];
        for (got, want) in lens.iter().zip(want) {
            assert!((got - want).abs() < NEAR, "{lens:?}");
        }
        let start = w[0].lead.from;
        assert!((t[1].to[0] - start[0]).abs() < NEAR && (t[1].to[1] - start[1]).abs() < NEAR);
        // +X, +Y, -X, -Y round the start.
        assert!(
            t[2].to[0] > start[0] && t[3].to[1] > start[1] && t[4].to[0] < start[0] && t[5].to[1] < start[1]
        );
        let feeds: Vec<Option<f64>> = t.iter().map(|m| m.f).collect();
        assert_eq!(&feeds[..4], [Some(600.0), Some(240.0), Some(600.0), None]);
        assert!(feeds[4..10].iter().all(Option::is_none));
        assert_eq!(feeds[10], w[0].lead.f.or(feeds[10]));
        assert!((t[10].to[0] - w[0].lead.to[0]).abs() < NEAR && (t[10].to[1] - w[0].lead.to[1]).abs() < NEAR);
    }
    // No ironing area: no spiral, the move to the row start and the way back stay.
    let (gcode, _) = slice(&[
        ("prime_tower_flat_ironing", json!(true)),
        ("filament_tower_ironing_area", json!([0, 0])),
    ]);
    for b in blocks(&gcode) {
        let t = &wipes(&b)[0].travels;
        let lens: Vec<f64> = t.iter().map(len).collect();
        assert_eq!(lens.len(), 3, "{lens:?}");
        assert!((lens[0] - 4.5).abs() < NEAR && (lens[1] - 1.5).abs() < NEAR && (lens[2] - 3.0).abs() < NEAR);
    }
}

#[test]
fn a_type_2_tower_never_wipes_its_nozzle() {
    let type2 = |skip: bool| {
        slice(&[
            ("printer_model", json!("Generic Klipper Printer")),
            ("wipe_tower_type", json!("type2")),
            ("prime_tower_skip_points", json!(skip)),
        ])
        .0
    };
    let on = type2(true);
    assert!(!on.contains(" F240\n") && !on.contains("Wipe tower reheat"));
    assert_eq!(on, type2(false), "the setting changes nothing on a type 2 tower");
}
