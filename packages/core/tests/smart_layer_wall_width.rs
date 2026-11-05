// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Walls under variable layer heights print at the widths they are placed for.
//!
//! With `smart_layer` on, the layers can be thinner or thicker than `layer_height` in the settings: a 0.28 mm
//! setting with layers capped at 0.2 mm, or a 0.12 mm setting whose straight walls get 0.18 mm layers. On every
//! such layer the outer and inner walls print the filament a flat bead of their own width at that layer's height
//! takes, `w h - h^2 (1 - pi / 4)` times the flow ratio over the filament's section, and the outer wall's centerline
//! stays half its width in from the faces. A Prusa MK4 with its own profile, variable-width walls and the
//! fixed-width (aegis) walls, 1.75 mm filament at a flow ratio of 0.98, relative E, no arcs.
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
/// The MK4's outer and inner wall widths: 100 and 110 percent of the 0.4 mm nozzle.
const OUTER: f64 = 0.4;
const INNER: f64 = 0.44;
/// The cube's side, mm.
const SIDE: f64 = 20.0;

fn read(path: &str) -> Value {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    serde_json::from_slice(&std::fs::read(format!("{root}/{path}")).unwrap()).unwrap()
}

/// The shipped Prusa MK4, its filament and Standard process over the settings defaults, with `smart_layer` on
/// Quality between `min` and `max` mm, `layer_height` at `set`, and the walls of `generator`.
fn mk4(set: f64, min: f64, max: f64, generator: &str) -> Value {
    let mut c = serde_json::Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        c.insert(k.clone(), v[1].clone());
    }
    let m = &read("packages/profiles/resolved/prusa.json")["models"]["prusa-mk4"];
    let base = m["base"].as_str().unwrap();
    for part in [&m["process"][base], &m["filament"], &m["machine"]] {
        c.extend(part.as_object().unwrap().clone());
    }
    let fixed = json!({
        "smart_layer": "quality",
        "smart_layer_min_height": min,
        "smart_layer_max_height": max,
        "layer_height": set,
        "initial_layer_print_height": 0.2,
        "wall_generator": generator,
        "wall_loops": 3,
        "outer_wall_line_width": OUTER,
        "inner_wall_line_width": INNER,
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
    Value::Object(c)
}

/// A 20 mm cube 6 mm tall: straight walls, so sleipnir plans its thickest layers over most of it.
fn cube() -> MeshPart {
    let (s, t) = (SIDE as f32, 6.0_f32);
    let mut positions = Vec::new();
    for z in [0.0, t] {
        for (x, y) in [(0.0, 0.0), (s, 0.0), (s, s), (0.0, s)] {
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
        parts: vec![cube()],
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

/// One feature on one layer: path mm, filament mm and the extent of its points.
#[derive(Debug, Clone, Copy)]
struct Feat {
    len: f64,
    e: f64,
    lo: [f64; 2],
    hi: [f64; 2],
}

impl Default for Feat {
    fn default() -> Self {
        Self {
            len: 0.0,
            e: 0.0,
            lo: [f64::MAX; 2],
            hi: [f64::MIN; 2],
        }
    }
}

/// Layer z in micrometers -> feature -> its extruding moves.
fn layers(g: &str) -> BTreeMap<i64, BTreeMap<String, Feat>> {
    let mut out: BTreeMap<i64, BTreeMap<String, Feat>> = BTreeMap::new();
    let (mut feature, mut z, mut at) = (String::new(), 0_i64, [0.0, 0.0]);
    for line in g.lines() {
        if let Some(f) = line.strip_prefix(";TYPE:") {
            f.trim().clone_into(&mut feature);
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        let mut words = code.split_whitespace();
        let Some(cmd) = words.next() else { continue };
        assert!(cmd != "G2" && cmd != "G3", "arcs are off");
        if cmd != "G0" && cmd != "G1" {
            continue;
        }
        let (mut to, mut e) = (at, 0.0);
        for w in words {
            let (k, v) = w.split_at(1);
            let Ok(v) = v.parse::<f64>() else { continue };
            match k {
                "X" => to[0] = v,
                "Y" => to[1] = v,
                "Z" => z = (v * 1000.0).round() as i64,
                "E" => e = v,
                _ => {}
            }
        }
        let len = (to[0] - at[0]).hypot(to[1] - at[1]);
        if cmd == "G1" && e > 0.0 && len > 0.0 {
            let f = out.entry(z).or_default().entry(feature.clone()).or_default();
            f.len += len;
            f.e += e;
            for p in [at, to] {
                for ((lo, hi), v) in f.lo.iter_mut().zip(f.hi.iter_mut()).zip(p) {
                    *lo = lo.min(v);
                    *hi = hi.max(v);
                }
            }
        }
        at = to;
    }
    out
}

/// Filament mm per mm of a flat bead `w` wide on a layer `h` thick.
fn per_mm(w: f64, h: f64) -> f64 {
    (w * h - h * h * (1.0 - PI / 4.0)) * FLOW / (PI * 0.875 * 0.875)
}

/// Every layer of `config`'s cube that is `h` thick over the one below, above the first three layers and under the top
/// shells: its outer and inner walls print within half a percent of the filament per mm of their own widths at `h`,
/// and the outer wall's centerline runs half its width in from the cube's faces.
fn check(config: &Value, h: f64, what: &str) {
    let g = gcode(config);
    let all = layers(&g);
    let zs: Vec<i64> = all.keys().copied().collect();
    let mut seen = 0;
    for pair in zs.windows(2).skip(3) {
        let (below, z) = (pair[0], pair[1]);
        let thick = (z - below) as f64 / 1000.0;
        if (thick - h).abs() > 0.002 || z > 5000 {
            continue;
        }
        seen += 1;
        let layer = &all[&z];
        for (feature, w) in [("Outer wall", OUTER), ("Inner wall", INNER)] {
            let f = layer
                .get(feature)
                .unwrap_or_else(|| panic!("{what}: no {feature} at z {z}"));
            let (got, want) = (f.e / f.len, per_mm(w, h));
            assert!(
                (got / want - 1.0).abs() < 0.005,
                "{what}: {feature} at z {z} ({h} mm layer) prints {got:.5} mm of filament per mm, a {w} mm bead takes \
                 {want:.5} ({:+.2} percent)",
                (got / want - 1.0) * 100.0
            );
        }
        let outer = &layer["Outer wall"];
        for i in 0..2 {
            let span = outer.hi[i] - outer.lo[i];
            assert!(
                (span - (SIDE - OUTER)).abs() < 0.003,
                "{what}: the outer wall's centerline spans {span:.4} mm at z {z}, {} mm wanted",
                SIDE - OUTER
            );
        }
    }
    assert!(seen >= 5, "{what}: only {seen} layers {h} mm thick");
}

#[test]
fn walls_on_layers_thinner_than_the_set_height_print_their_width() {
    for generator in ["arachne", "aegis"] {
        check(
            &mk4(0.28, 0.18, 0.2, generator),
            0.2,
            &format!("{generator}, 0.28 mm set, 0.2 mm layers"),
        );
    }
}

#[test]
fn walls_on_layers_thicker_than_the_set_height_print_their_width() {
    for generator in ["arachne", "aegis"] {
        check(
            &mk4(0.12, 0.09, 0.18, generator),
            0.18,
            &format!("{generator}, 0.12 mm set, 0.18 mm layers"),
        );
    }
}

#[test]
fn walls_on_layers_at_the_set_height_print_their_width() {
    for generator in ["arachne", "aegis"] {
        check(
            &mk4(0.2, 0.15, 0.2, generator),
            0.2,
            &format!("{generator}, 0.2 mm set and layers"),
        );
    }
}
