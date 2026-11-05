// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Solid lines and fixed-width walls under variable layer heights sit at the spacing of their own layer.
//!
//! With `smart_layer` on, the layers can be thinner or thicker than `layer_height` in the settings: a 0.28 mm
//! setting with layers capped at 0.2 mm, or a 0.12 mm setting whose straight walls get 0.18 mm layers. A line prints
//! its width at the height of the layer it is on, so neighbors touch when they are one spacing apart at that height,
//! `w - h (1 - pi / 4)`: the filament a millimeter of line takes over the flow ratio and the layer height, read back
//! from the G-code. Laid at the spacing of the set height, the lines overlap or leave gaps. The first layer is the
//! same at its own height. Fixed-width (classic) walls lay their inner loops one inner spacing apart at the layer's
//! height. 1.75 mm filament at a flow ratio of 0.98, relative E, no arcs.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::disallowed_methods,
    clippy::many_single_char_names,
    reason = "a G-code reader for the test: positions, widths and lengths in mm"
)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::f64::consts::PI;
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

const FLOW: f64 = 0.98;

fn read(path: &str) -> Value {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    serde_json::from_slice(&std::fs::read(format!("{root}/{path}")).unwrap()).unwrap()
}

/// A shipped printer (`vendor` file, `model`) with its filament and standard process over the settings defaults,
/// `layer_height` at `set` and `smart_layer` on Quality between `min` and `max` mm (off when `max` is 0), and `extra`.
fn printer(vendor: &str, model: &str, set: f64, min: f64, max: f64, extra: &Value) -> Value {
    let mut c = serde_json::Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        c.insert(k.clone(), v[1].clone());
    }
    let m = &read(&format!("packages/profiles/resolved/{vendor}.json"))["models"][model];
    let base = m["base"].as_str().unwrap();
    for part in [&m["process"][base], &m["filament"], &m["machine"]] {
        c.extend(part.as_object().unwrap().clone());
    }
    let fixed = json!({
        "layer_height": set,
        "initial_layer_print_height": 0.2,
        "brim_type": "no_brim",
        "skirt_loops": 0,
        "enable_prime_tower": false,
        "enable_arc_fitting": false,
        "use_relative_e_distances": true,
        "filament_flow_ratio": [FLOW],
        "filament_diameter": [1.75],
        "nozzle_diameter": [0.4],
    });
    c.extend(fixed.as_object().unwrap().clone());
    if max > 0.0 {
        c.extend(
            json!({"smart_layer": "quality", "smart_layer_min_height": min, "smart_layer_max_height": max})
                .as_object()
                .unwrap()
                .clone(),
        );
    } else {
        c.remove("smart_layer");
    }
    c.extend(extra.as_object().unwrap().clone());
    Value::Object(c)
}

/// A box from `lo` to `hi` (x, y, z) as triangles over its own eight corners.
fn cube(lo: [f32; 3], hi: [f32; 3]) -> MeshPart {
    let mut positions = Vec::new();
    for z in [lo[2], hi[2]] {
        for (x, y) in [(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])] {
            positions.push([x, y, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    MeshPart {
        name: "cube".into(),
        slot: 1,
        positions,
        triangles,
        ..MeshPart::default()
    }
}

fn gcode(config: &Value) -> String {
    let mesh = Arc::new(Mesh {
        name: "m".into(),
        parts: vec![cube([0.0, 0.0, 0.0], [20.0, 20.0, 6.0])],
        ..Mesh::default()
    });
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "m"}]},
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// An extruding move: its ends and filament mm.
#[derive(Debug, Clone, Copy)]
struct Move {
    a: [f64; 2],
    b: [f64; 2],
    e: f64,
}

impl Move {
    fn len(&self) -> f64 {
        (self.b[0] - self.a[0]).hypot(self.b[1] - self.a[1])
    }
}

/// Layer z in micrometers -> feature -> its extruding moves.
fn layers(g: &str) -> BTreeMap<i64, BTreeMap<String, Vec<Move>>> {
    let mut out: BTreeMap<i64, BTreeMap<String, Vec<Move>>> = BTreeMap::new();
    let (mut feature, mut z, mut at) = (String::new(), 0_i64, [0.0, 0.0]);
    for line in g.lines() {
        // Feature labels: `;TYPE:` or, on Bambu Lab printers, `; FEATURE:`.
        if let Some(f) = line
            .strip_prefix(";TYPE:")
            .or_else(|| line.strip_prefix("; FEATURE:"))
        {
            f.trim().clone_into(&mut feature);
            continue;
        }
        // The layer's z from its marker: Z moves also lift the nozzle between paths.
        if let Some(v) = line
            .strip_prefix(";Z:")
            .or_else(|| line.strip_prefix("; Z_HEIGHT:"))
            .and_then(|v| v.trim().parse::<f64>().ok())
        {
            z = (v * 1000.0).round() as i64;
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        let mut words = code.split_whitespace();
        let Some(cmd) = words.next() else { continue };
        // Arcs are off for the object; the printer's start and end code may still carry some, which only move the
        // head here.
        if !matches!(cmd, "G0" | "G1" | "G2" | "G3") {
            continue;
        }
        let (mut to, mut e) = (at, 0.0);
        for w in words {
            let (k, v) = w.split_at(1);
            let Ok(v) = v.parse::<f64>() else { continue };
            match k {
                "X" => to[0] = v,
                "Y" => to[1] = v,
                "E" => e = v,
                _ => {}
            }
        }
        if cmd == "G1" && e > 0.0 && (to[0] - at[0]).hypot(to[1] - at[1]) > 0.0 {
            out.entry(z)
                .or_default()
                .entry(feature.clone())
                .or_default()
                .push(Move { a: at, b: to, e });
        }
        at = to;
    }
    out
}

/// The spacing a bead of these moves needs on a layer `h` thick: its section (filament per mm, over the flow ratio)
/// over the height.
fn needed(moves: &[Move], h: f64) -> f64 {
    let (len, e): (f64, f64) = moves.iter().fold((0.0, 0.0), |(l, e), m| (l + m.len(), e + m.e));
    e / len * PI * 0.875 * 0.875 / FLOW / h
}

/// How far apart parallel lines lie: the moves over 1 mm along the most common direction, their offsets across it,
/// the median step between neighbors. `None` under three such lines.
fn pitch(moves: &[Move]) -> Option<f64> {
    let deg = |m: &Move| {
        (m.b[1] - m.a[1])
            .atan2(m.b[0] - m.a[0])
            .to_degrees()
            .rem_euclid(180.0)
    };
    let long: Vec<&Move> = moves.iter().filter(|m| m.len() > 1.0).collect();
    let mut bins: BTreeMap<i64, usize> = BTreeMap::new();
    for m in &long {
        *bins.entry(deg(m).round() as i64 % 180).or_default() += 1;
    }
    let (&dir, _) = bins.iter().max_by_key(|(_, n)| **n)?;
    let a = (dir as f64).to_radians();
    let (nx, ny) = (-a.sin(), a.cos());
    let mut offs: Vec<f64> = long
        .iter()
        .filter(|m| ((deg(m) - dir as f64 + 90.0).rem_euclid(180.0) - 90.0).abs() < 0.6)
        .map(|m| f64::midpoint(m.a[0], m.b[0]) * nx + f64::midpoint(m.a[1], m.b[1]) * ny)
        .collect();
    offs.sort_by(f64::total_cmp);
    offs.dedup_by(|x, y| (*x - *y).abs() < 0.005);
    let mut steps: Vec<f64> = offs
        .windows(2)
        .map(|w| w[1] - w[0])
        .filter(|d| *d > 0.05)
        .collect();
    if steps.len() < 2 {
        return None;
    }
    steps.sort_by(f64::total_cmp);
    Some(steps[steps.len() / 2])
}

/// Every layer of `config`'s cube (the first too when `first`) with lines of a solid feature: they sit within half a
/// percent of the spacing their own bead needs at the layer's height. Returns how many feature layers were read and
/// their thicknesses.
fn check_solid(config: &Value, first: bool, what: &str) -> Vec<(String, f64)> {
    let all = layers(&gcode(config));
    let zs: Vec<i64> = all.keys().copied().collect();
    let mut seen = Vec::new();
    for (i, z) in zs.iter().enumerate() {
        if i == 0 && !first {
            continue;
        }
        let h = if i == 0 {
            *z as f64 / 1000.0
        } else {
            (z - zs[i - 1]) as f64 / 1000.0
        };
        for feature in ["Internal solid infill", "Top surface", "Bottom surface"] {
            let Some(moves) = all[z].get(feature) else {
                continue;
            };
            let Some(laid) = pitch(moves) else { continue };
            let want = needed(moves, h);
            assert!(
                (laid / want - 1.0).abs() < 0.005,
                "{what}: {feature} at z {z} ({h} mm layer) is laid {laid:.4} mm apart, its bead needs {want:.4} \
                 ({:+.2} percent)",
                (laid / want - 1.0) * 100.0
            );
            seen.push((feature.to_owned(), h));
        }
    }
    seen
}

#[test]
fn solid_lines_on_layers_thinner_than_the_set_height_sit_at_their_spacing() {
    let seen = check_solid(
        &printer("prusa", "prusa-mk4", 0.28, 0.18, 0.2, &json!({})),
        false,
        "MK4, 0.28 mm set, 0.2 mm layers",
    );
    for f in ["Internal solid infill", "Top surface"] {
        assert!(
            seen.iter().any(|(s, h)| s == f && (h - 0.2).abs() < 0.002),
            "no {f} on a 0.2 mm layer: {seen:?}"
        );
    }
}

#[test]
fn solid_lines_on_layers_thicker_than_the_set_height_sit_at_their_spacing() {
    let seen = check_solid(
        &printer("prusa", "prusa-mk4", 0.12, 0.09, 0.18, &json!({})),
        false,
        "MK4, 0.12 mm set, 0.18 mm layers",
    );
    assert!(
        seen.iter()
            .any(|(s, h)| s == "Internal solid infill" && (h - 0.18).abs() < 0.002),
        "no internal solid infill on a 0.18 mm layer: {seen:?}"
    );
}

#[test]
fn first_layer_bottom_lines_sit_at_the_first_layer_spacing() {
    for set in [0.28, 0.12] {
        let seen = check_solid(
            &printer("prusa", "prusa-mk4", set, 0.0, 0.0, &json!({})),
            true,
            &format!("MK4, {set} mm set, 0.2 mm first layer"),
        );
        assert!(
            seen.iter()
                .any(|(s, h)| s == "Bottom surface" && (h - 0.2).abs() < 0.002),
            "{set}: no first layer bottom surface: {seen:?}"
        );
    }
}

#[test]
fn solid_lines_at_the_set_height_sit_at_their_spacing() {
    check_solid(
        &printer("prusa", "prusa-mk4", 0.2, 0.15, 0.2, &json!({})),
        true,
        "MK4, 0.2 mm set and layers",
    );
}

/// Where the inner wall loops of `config`'s cube run on every layer `h` thick above the first three: how far each
/// loop's moves along the cube's lowest side sit from the outer wall's there (the cube is placed on the plate where the
/// printer puts it, so the outer wall is the reference).
fn inner_loops(config: &Value, h: f64) -> Vec<(i64, Vec<f64>)> {
    let all = layers(&gcode(config));
    let zs: Vec<i64> = all.keys().copied().collect();
    // The y of a feature's moves along x, over 5 mm long.
    let along_x = |moves: &[Move]| -> Vec<f64> {
        moves
            .iter()
            .filter(|m| m.len() > 5.0 && (m.a[1] - m.b[1]).abs() < 1e-6)
            .map(|m| m.a[1])
            .collect()
    };
    let mut out = Vec::new();
    for pair in zs.windows(2).skip(3) {
        let (below, z) = (pair[0], pair[1]);
        if (((z - below) as f64 / 1000.0) - h).abs() > 0.002 || z > 5000 {
            continue;
        }
        let (Some(outer), Some(inner)) = (all[&z].get("Outer wall"), all[&z].get("Inner wall")) else {
            continue;
        };
        let Some(side) = along_x(outer).into_iter().reduce(f64::min) else {
            continue;
        };
        let mut ins: Vec<f64> = along_x(inner)
            .into_iter()
            .map(|y| y - side)
            .filter(|d| (0.0..3.0).contains(d))
            .collect();
        ins.sort_by(f64::total_cmp);
        ins.dedup_by(|x, y| (*x - *y).abs() < 0.002);
        out.push((z, ins));
    }
    out
}

/// Fixed-width walls, three loops, the precise outer wall off: the two inner loops one inner spacing apart at the
/// layer's height, the first a mean of the two spacings in from the outer wall's centerline.
fn check_classic(set: f64, min: f64, max: f64, h: f64, what: &str) {
    let (outer, inner) = (0.42, 0.45);
    let config = printer(
        "bambu-lab",
        "bambu-a1",
        set,
        min,
        max,
        &json!({"wall_generator": "classic", "wall_loops": 3, "precise_outer_wall": false}),
    );
    let sp = |w: f64| w - h * (1.0 - PI / 4.0);
    let loops = inner_loops(&config, h);
    assert!(
        loops.len() >= 5,
        "{what}: only {} layers {h} mm thick",
        loops.len()
    );
    for (z, ins) in loops {
        assert_eq!(ins.len(), 2, "{what}: inner loops at z {z}: {ins:?}");
        let first = f64::midpoint(sp(outer), sp(inner));
        let step = ins[1] - ins[0];
        assert!(
            (ins[0] - first).abs() < 0.003 && (step - sp(inner)).abs() < 0.003,
            "{what}: at z {z} the inner walls run {:.4} and {:.4} mm in from the outer wall, {first:.4} and {:.4} \
             wanted (a {:.4} mm inner spacing on a {h} mm layer)",
            ins[0],
            ins[1],
            first + sp(inner),
            sp(inner)
        );
    }
}

#[test]
fn classic_walls_on_layers_thinner_than_the_set_height_sit_at_their_spacing() {
    check_classic(0.28, 0.18, 0.2, 0.2, "A1 classic, 0.28 mm set, 0.2 mm layers");
}

#[test]
fn classic_walls_on_layers_thicker_than_the_set_height_sit_at_their_spacing() {
    check_classic(0.12, 0.09, 0.18, 0.18, "A1 classic, 0.12 mm set, 0.18 mm layers");
}

#[test]
fn classic_walls_at_the_set_height_sit_at_their_spacing() {
    check_classic(0.2, 0.15, 0.2, 0.2, "A1 classic, 0.2 mm set and layers");
}
