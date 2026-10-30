// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Spiral vase mode next to a printer's keep-out zones: when the largest outline moves to another part of the object,
//! the travel from the ring below to the new ring goes round the zones as any other travel does. The part is two
//! posts whose outlines take turns at being the largest, set 1.5 mm from a corner zone with the zone in the notch
//! between them, where the straight link from one post to the other cuts the zone's corner. The config is built the
//! way the app builds it: the settings schema's defaults, then the printer's shipped process, filament and printer
//! settings, then its start, end and timelapse G-code.

#![allow(clippy::disallowed_methods)]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// The app's config for the stock `model`.
fn stock(model: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let m = read("packages/profiles/resolved/bambu-lab.json")["models"][model].clone();
    let base = m["base"].as_str().unwrap().to_owned();
    for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    let gcode = read("packages/profiles/gcode.json");
    let family = gcode["models"][model].as_str().unwrap().to_owned();
    for (key, part) in [
        ("machine_start_gcode", "start"),
        ("machine_end_gcode", "end"),
        ("time_lapse_gcode", "timeLapse"),
    ] {
        out.insert(key.into(), gcode["families"][&family][part].clone());
    }
    out
}

/// A 16 mm square post and an 8 by 32 mm bar beside it, laid out as an L round a notch, 40 mm tall, as binary STL.
/// Their sides swell and shrink by 1.5 mm in turn every 8 mm, so the largest outline goes from one to the other.
fn posts_stl() -> Vec<u8> {
    // center x, center y, half width, half depth, phase
    let posts = [
        (-12.0f32, 14.0f32, 8.0f32, 8.0f32, 1.0f32),
        (12.0, -23.0, 4.0, 16.0, -1.0),
    ];
    let (dz, period, swing, steps) = (0.5f32, 8.0f32, 1.5f32, 80u16);
    let mut tris: Vec<[[f32; 3]; 3]> = Vec::new();
    for (cx, cy, hx0, hy0, phase) in posts {
        let ring = |k: u16| {
            let z = f32::from(k) * dz;
            let d = phase * swing * (std::f32::consts::TAU * z / period).sin();
            let (hx, hy) = (hx0 + d, hy0 + d);
            [
                [cx - hx, cy - hy, z],
                [cx + hx, cy - hy, z],
                [cx + hx, cy + hy, z],
                [cx - hx, cy + hy, z],
            ]
        };
        for k in 0..steps {
            let (lo, hi) = (ring(k), ring(k + 1));
            for i in 0..4 {
                let j = (i + 1) % 4;
                tris.push([lo[i], lo[j], hi[j]]);
                tris.push([lo[i], hi[j], hi[i]]);
            }
        }
        let (b, t) = (ring(0), ring(steps));
        tris.push([b[0], b[3], b[2]]);
        tris.push([b[0], b[2], b[1]]);
        tris.push([t[0], t[1], t[2]]);
        tris.push([t[0], t[2], t[3]]);
    }
    let mut out = vec![0u8; 80];
    out.extend_from_slice(&u32::try_from(tris.len()).unwrap().to_le_bytes());
    for t in tris {
        out.extend_from_slice(&[0u8; 12]);
        for v in t {
            for c in v {
                out.extend_from_slice(&f32::to_le_bytes(c));
            }
        }
        out.extend_from_slice(&[0u8; 2]);
    }
    out
}

/// The posts sliced as a spiral vase on `model`, turned by `turn` degrees and centered at `at`: the G-code, and the
/// extruder offset its moves are written less (a P1S writes Y 2 mm short of the plate).
fn slice(model: &str, turn: f64, at: [f64; 2]) -> (String, [f64; 2]) {
    let m = Arc::new(Mesh::load(&posts_stl(), "posts.stl").unwrap());
    let mut config = stock(model);
    let offset = config
        .get("extruder_offset")
        .and_then(|v| v.get(0))
        .map_or([0.0, 0.0], |o| [o[0].as_f64().unwrap(), o[1].as_f64().unwrap()]);
    config.insert("spiral_mode".into(), json!(true));
    let (s, c) = turn.to_radians().sin_cos();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "o", "name": "posts", "mesh": "m",
                               "transform": [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, at[0], at[1], 0, 1]}]},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    (String::from_utf8(r.gcode).unwrap(), offset)
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

/// Every travel of the print's layers outside the printer's own G-code (`; FEATURE: Custom`) that runs more than
/// 0.01 mm into the box `zone` (`[x0, y0, x1, y1]`, on the plate, where a move goes `offset` past what it writes): its
/// line (1-based) and the deepest it goes.
fn into(gcode: &str, offset: [f64; 2], zone: [f64; 4]) -> Vec<(usize, f64)> {
    let (mut x, mut y) = (f64::NAN, f64::NAN);
    let (mut layers, mut custom) = (false, false);
    let mut found = Vec::new();
    for (i, line) in gcode.lines().enumerate() {
        if line.starts_with(";LAYER_CHANGE") || line.starts_with("; CHANGE_LAYER") {
            layers = true;
        }
        if let Some(f) = line.strip_prefix("; FEATURE:") {
            custom = f.trim() == "Custom";
        }
        let code = line.split(';').next().unwrap_or("").trim();
        if !(code.starts_with("G0") || code.starts_with("G1")) {
            continue;
        }
        let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
        let travel = word(code, 'E').is_none_or(|e| e <= 0.0);
        if layers && !custom && travel && x.is_finite() && y.is_finite() {
            let len = (nx - x).hypot(ny - y);
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a sample count"
            )]
            let steps = ((len / 0.05).ceil() as usize).max(1);
            let mut deepest: f64 = 0.0;
            for k in 0..=steps {
                #[allow(clippy::cast_precision_loss, reason = "a small sample index")]
                let frac = k as f64 / steps as f64;
                let (px, py) = (x + frac * (nx - x) + offset[0], y + frac * (ny - y) + offset[1]);
                let d = (px - zone[0])
                    .min(zone[2] - px)
                    .min(py - zone[1])
                    .min(zone[3] - py);
                deepest = deepest.max(d);
            }
            if deepest > 0.01 {
                found.push((i + 1, deepest));
            }
        }
        (x, y) = (nx, ny);
    }
    found
}

/// The travels written as `G0`: the spiral's links from one post to the other among them.
fn travels(g: &str) -> usize {
    g.lines().filter(|l| l.starts_with("G0 ")).count()
}

#[test]
fn a_spiral_travel_to_the_other_post_goes_round_the_p1s_excluded_corner() {
    // The excluded area is 0 to 18 by 0 to 28; the posts stand 1.5 mm from it, round its corner.
    let (g, offset) = slice("bambu-p1s", 180.0, [18.0, 26.0]);
    assert!(travels(&g) >= 5, "the spiral should change posts");
    let hits = into(&g, offset, [0.0, 0.0, 18.0, 28.0]);
    assert!(hits.is_empty(), "travels into the excluded area: {hits:?}");
}

#[test]
fn a_spiral_travel_to_the_other_post_goes_round_the_a1_wrap_check_corner() {
    // The nozzle wrap check runs in 226 to 256 by 224 to 256.
    let (g, offset) = slice("bambu-a1", 0.0, [221.0, 228.0]);
    assert!(travels(&g) >= 5, "the spiral should change posts");
    let hits = into(&g, offset, [226.0, 224.0, 256.0, 256.0]);
    assert!(hits.is_empty(), "travels into the wrap check corner: {hits:?}");
}
