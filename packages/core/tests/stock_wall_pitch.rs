// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where classic inner walls sit on the shipped Bambu Lab P1S settings (0.20 mm Standard: 0.42 mm outer and 0.45 mm
//! inner walls, inner walls first, fixed layers), on a 20 mm box 4 mm tall: each inner loop's centerline, mm in from
//! the outer wall's centerline, on the straight sides of the layer nearest z 2.0.
//!
//! The P1S presets print with precise outer wall off, so the first inner wall sits the mean of the two walls' spacings
//! in (spacing = width - layer height x (1 - pi/4)) and each further one an inner wall spacing past it: 0.392, 0.799
//! and 1.206 at 0.2 mm layers. With precise outer wall on, the first inner wall sits the mean of the two widths in.
//! aegis walls sit at the same places with it off; with it on, their first inner wall moves only half as far in.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "a G-code reader for the test: positions in mm"
)]

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

fn read(path: &str) -> Value {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    serde_json::from_slice(&std::fs::read(format!("{root}/{path}")).unwrap()).unwrap()
}

/// The shipped P1S printer, PLA and 0.20 mm Standard process over the settings defaults, with classic walls (the
/// generator the Bambu Lab presets use), fixed layers, no brim and no skirt, then `extra`.
fn settings(extra: &Value) -> Value {
    let mut c = serde_json::Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        c.insert(k.clone(), v[1].clone());
    }
    let model = &read("packages/profiles/resolved/bambu-lab.json")["models"]["bambu-p1s"];
    let base = model["base"].as_str().unwrap();
    for part in [&model["process"][base], &model["filament"], &model["machine"]] {
        c.extend(part.as_object().unwrap().clone());
    }
    let fixed = json!({
        "wall_generator": "classic",
        "smart_layer": "off",
        "brim_type": "no_brim",
        "skirt_loops": 0,
    });
    c.extend(fixed.as_object().unwrap().clone());
    c.extend(extra.as_object().unwrap().clone());
    Value::Object(c)
}

/// A 20 mm square box 4 mm tall, centered on the origin.
fn box20() -> Mesh {
    let (h, t) = (10.0_f32, 4.0_f32);
    let mut positions = Vec::new();
    for z in [0.0, t] {
        positions.extend([[-h, -h, z], [h, -h, z], [h, h, z], [-h, h, z]]);
    }
    let triangles = vec![
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    Mesh {
        name: "m".into(),
        parts: vec![MeshPart {
            name: "m".into(),
            slot: 1,
            positions,
            triangles,
            ..MeshPart::default()
        }],
        ..Mesh::default()
    }
}

fn slice(config: &Value) -> String {
    let mesh = Arc::new(box20());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "m"}]},
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

fn word(code: &str, key: char) -> Option<f64> {
    code.split_whitespace()
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse::<f64>().ok()))
}

/// A feature or layer comment's value: `; FEATURE: x` or `;TYPE:x`, and so on.
fn comment<'a>(s: &'a str, keys: &[&str]) -> Option<&'a str> {
    let body = s.strip_prefix(';')?.trim_start();
    keys.iter()
        .find_map(|k| body.strip_prefix(k).and_then(|r| r.strip_prefix(':')))
        .map(str::trim)
}

/// One extruding move: its layer z in thousandths of a millimeter, feature, start and end (mm).
type Move = (i64, String, (f64, f64), (f64, f64));

/// Each extruding move.
fn moves(gcode: &str) -> Vec<Move> {
    let (mut feature, mut layer) = (String::new(), 0);
    let mut at = (0.0, 0.0);
    let mut out = Vec::new();
    for line in gcode.lines() {
        let text = line.trim();
        if let Some(f) = comment(text, &["TYPE", "FEATURE"]) {
            f.clone_into(&mut feature);
            continue;
        }
        if let Some(h) = comment(text, &["Z_HEIGHT", "Z"]).and_then(|v| v.parse::<f64>().ok()) {
            layer = (h * 1000.0).round() as i64;
            continue;
        }
        let code = text.split(';').next().unwrap_or("").trim();
        if !(code.starts_with("G0 ") || code.starts_with("G1 ")) {
            continue;
        }
        let to = (word(code, 'X').unwrap_or(at.0), word(code, 'Y').unwrap_or(at.1));
        if word(code, 'E').is_some_and(|e| e > 0.0) && to != at {
            out.push((layer, feature.clone(), at, to));
        }
        at = to;
    }
    out
}

/// The inner loops on the layer nearest z 2.0, per side of the box (left, right, bottom, top): each loop's
/// centerline, mm in from the outer wall's centerline, nearest first.
fn loops(gcode: &str) -> [Vec<f64>; 4] {
    let all = moves(gcode);
    let layer = all
        .iter()
        .filter(|m| m.1 == "Inner wall")
        .map(|m| m.0)
        .min_by_key(|z| (z - 2000).abs())
        .unwrap();
    let on = |f: &str| {
        all.iter()
            .filter(|m| m.0 == layer && m.1 == f)
            .collect::<Vec<_>>()
    };
    let outer = on("Outer wall");
    let points = || outer.iter().flat_map(|m| [m.2, m.3]);
    let x0 = points().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let x1 = points().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let y0 = points().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let y1 = points().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    let (cx, cy) = (f64::midpoint(x0, x1), f64::midpoint(y0, y1));
    let inner = on("Inner wall");
    [0, 1, 2, 3].map(|side| {
        let mut depths: Vec<f64> = inner
            .iter()
            .filter_map(|m| {
                let (a, b) = (m.2, m.3);
                // A straight run along the side, at least 5 mm long, on that side of the center.
                let along = if side < 2 {
                    (b.1 - a.1).abs()
                } else {
                    (b.0 - a.0).abs()
                };
                let across = if side < 2 {
                    (b.0 - a.0).abs()
                } else {
                    (b.1 - a.1).abs()
                };
                if along < 5.0 || across > 0.001 {
                    return None;
                }
                let d = match side {
                    0 if a.0 < cx => a.0 - x0,
                    1 if a.0 > cx => x1 - a.0,
                    2 if a.1 < cy => a.1 - y0,
                    3 if a.1 > cy => y1 - a.1,
                    _ => return None,
                };
                Some(d)
            })
            .collect();
        depths.sort_by(f64::total_cmp);
        depths.dedup_by(|a, b| (*a - *b).abs() < 0.01);
        depths
    })
}

/// The loops of every side within 0.002 mm of `target` on `config`, or what they were.
fn misses(what: &str, config: &Value, target: &[f64]) -> Option<String> {
    misses_within(what, config, target, 0.002)
}

/// The loops of every side within `tolerance` mm of `target` on `config`, or what they were.
fn misses_within(what: &str, config: &Value, target: &[f64], tolerance: f64) -> Option<String> {
    let got = loops(&slice(config));
    let ok = got.iter().all(|side| {
        side.len() == target.len() && side.iter().zip(target).all(|(g, t)| (g - t).abs() <= tolerance)
    });
    (!ok).then(|| format!("{what}: per side {got:.3?}, target {target:?}"))
}

/// On the shipped P1S settings the inner loops sit at the targets at 2, 3 and 4 walls at 0.2 mm layers and at 3 walls
/// at 0.12 and 0.28 mm. Before, the shipped settings had precise outer wall on, and every loop sat the layer's
/// k = h x (1 - pi/4) farther in: 0.435, 0.842 and 1.249 at 0.2 mm, 0.435 and 0.859 at 0.12, 0.435 and 0.825 at
/// 0.28.
#[test]
fn classic_walls_on_the_stock_p1s_sit_at_the_targets() {
    let cases: [(u32, f64, &[f64]); 5] = [
        (2, 0.2, &[0.392]),
        (3, 0.2, &[0.392, 0.799]),
        (4, 0.2, &[0.392, 0.799, 1.206]),
        (3, 0.12, &[0.409, 0.833]),
        (3, 0.28, &[0.375, 0.765]),
    ];
    let mut out = Vec::new();
    for (walls, h, target) in cases {
        let cfg = settings(&json!({"wall_loops": walls, "layer_height": h}));
        out.extend(misses(&format!("{walls} walls, {h} mm"), &cfg, target));
    }
    assert!(out.is_empty(), "{out:#?}");
}

/// Turned on, precise outer wall still puts the first inner wall the mean of the two widths in, and the next an inner
/// wall spacing past it: 0.435 and 0.842 at 0.2 mm, 0.435 and 0.825 at 0.28 mm on 3 walls.
#[test]
fn classic_walls_with_precise_outer_wall_on_sit_at_the_targets() {
    let cases: [(f64, &[f64]); 2] = [(0.2, &[0.435, 0.842]), (0.28, &[0.435, 0.825])];
    let mut out = Vec::new();
    for (h, target) in cases {
        let cfg = settings(&json!({"wall_loops": 3, "layer_height": h, "precise_outer_wall": true}));
        out.extend(misses(&format!("3 walls, {h} mm, on"), &cfg, target));
    }
    assert!(out.is_empty(), "{out:#?}");
}

/// aegis walls on the shipped P1S settings sit where classic ones do with precise outer wall off: 0.392 and 0.799 at
/// 0.2 mm on 3 walls, and 0.409, 0.833 and 1.258 at 0.12 mm on 4. With it on, the outer wall stays on the surface
/// and the first inner wall moves in by half of k = h x (1 - pi/4), the outer wall's width less its spacing, so
/// every inner loop sits 0.021 mm farther in at 0.2 mm (0.414 and 0.821) and 0.030 at 0.28 (0.405 and 0.795).
/// Before, with it on the first inner wall sat the mean of the two widths in, a whole k past the off places: 0.435
/// and 0.842 at 0.2 mm, 0.435 and 0.825 at 0.28.
#[test]
fn aegis_walls_sit_at_the_targets() {
    let cases: [(u32, f64, bool, &[f64]); 4] = [
        (3, 0.2, false, &[0.392, 0.799]),
        (3, 0.2, true, &[0.414, 0.821]),
        (3, 0.28, true, &[0.405, 0.795]),
        (4, 0.12, false, &[0.409, 0.833, 1.258]),
    ];
    let mut out = Vec::new();
    for (walls, h, precise, target) in cases {
        let cfg = settings(&json!({
            "wall_generator": "aegis",
            "wall_loops": walls,
            "layer_height": h,
            "precise_outer_wall": precise,
        }));
        let what = format!("aegis, {walls} walls, {h} mm, precise outer wall {precise}");
        out.extend(misses_within(&what, &cfg, target, 0.003));
    }
    assert!(out.is_empty(), "{out:#?}");
}
