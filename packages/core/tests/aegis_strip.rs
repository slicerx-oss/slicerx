// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! aegis walls in a narrow strip: the stock A1 and P1S with aegis walls, on a wedge 24 mm long that widens from
//! nothing to 2.4 mm beside an arch. Where the wedge is 0.85 to 2.3 mm across, two walls each side meet in the
//! middle; classic walls print the walls at their widths and fill the strip between them with gap fill. aegis
//! walls widen instead, and the strip should get the same material: crowded beads that overlap more than their
//! neighbors, and solid infill squeezed into what the capped walls leave, put about 15 percent more there.
//! The same settings on x-mark keep their totals on the top surface layers, which have no such strip.

#![allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
#![allow(clippy::many_single_char_names, clippy::float_cmp, clippy::cast_sign_loss)]
// Checks measure the output with the standard math functions; the engine's own rounding rule (clippy.toml) is for G-code.
#![allow(clippy::disallowed_methods)]

use serde_json::{Map, Value, json};
use std::fmt::Write as _;
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// A shipped Bambu Lab printer as the app sets it up, with uniform layers.
fn printer(model: &str) -> Map<String, Value> {
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
    out.insert("smart_layer".into(), json!("off"));
    out
}

/// Sets `key` to `value`, as a list of one when the settings keep that key as a list.
fn set(cfg: &mut Map<String, Value>, key: &str, value: Value) {
    let v = if cfg.get(key).is_some_and(Value::is_array) {
        json!([value])
    } else {
        value
    };
    cfg.insert(key.to_owned(), v);
}

/// The cases: name, the filament's volumetric cap (mm3/s), its flow ratio, and for the two with cooling slowdown,
/// the slowest speed (mm/s) layers slow to for 60 s layers.
const CASES: [(&str, f64, f64, Option<f64>); 12] = [
    ("c1.2r0.9", 1.2, 0.9, None),
    ("c1.2r0.98", 1.2, 0.98, None),
    ("c1.2r1.05", 1.2, 1.05, None),
    ("c3r0.9", 3.0, 0.9, None),
    ("c3r0.98", 3.0, 0.98, None),
    ("c3r1.05", 3.0, 1.05, None),
    ("c8r0.9", 8.0, 0.9, None),
    ("c8r0.98", 8.0, 0.98, None),
    ("c8r1.05", 8.0, 1.05, None),
    ("c50r0.9", 50.0, 0.9, None),
    ("cl1", 1.2, 0.9, Some(30.0)),
    ("cl2", 3.0, 0.9, Some(5.0)),
];

/// The stock `model` as a project sets it up for these plates (fast, even speeds, a short brim and a skirt,
/// ironed tops, aegis walls), with the case's filament and cooling values.
fn settings(model: &str, cap: f64, ratio: f64, cooling: Option<f64>) -> Map<String, Value> {
    let mut cfg = printer(model);
    for (k, v) in [
        ("wall_generator", json!("aegis")),
        ("precise_outer_wall", json!(false)),
        ("brim_type", json!("outer_only")),
        ("brim_width", json!(3)),
        ("raft_first_layer_expansion", json!(0)),
        ("skirt_loops", json!(1)),
        ("skirt_speed", json!(300)),
        ("accel_to_decel_enable", json!(false)),
        ("bridge_no_support", json!(true)),
        ("enable_overhang_speed", json!(false)),
        ("ironing_type", json!("top")),
        ("ironing_flow", json!("15%")),
        ("ironing_pattern", json!("zig-zag")),
        ("ironing_speed", json!(300)),
        ("seam_gap", json!("15%")),
        ("seam_slope_conditional", json!(true)),
        ("seam_slope_inner_walls", json!(true)),
        ("ensure_vertical_shell_thickness", json!("enabled")),
        ("internal_solid_infill_pattern", json!("zig-zag")),
        ("enable_support", json!(true)),
        ("support_type", json!("normal(auto)")),
        ("support_ironing_pattern", json!("zig-zag")),
        ("support_ironing_spacing", json!(0.15)),
        ("close_additional_fan_first_x_layers", json!(1)),
        ("filament_flow_ratio", json!(ratio)),
        ("filament_max_volumetric_speed", json!(cap)),
        ("slow_down_for_layer_cooling", json!(cooling.is_some())),
        (
            "slow_down_layer_time",
            json!(if cooling.is_some() { 60 } else { 6 }),
        ),
        ("slow_down_min_speed", json!(cooling.unwrap_or(20.0))),
    ] {
        set(&mut cfg, k, v);
    }
    for k in [
        "bridge_speed",
        "gap_infill_speed",
        "internal_bridge_speed",
        "internal_solid_infill_speed",
        "outer_wall_speed",
        "sparse_infill_speed",
        "support_interface_speed",
        "support_speed",
        "top_surface_speed",
    ] {
        set(&mut cfg, k, json!(300));
    }
    cfg
}

/// An ASCII STL of the closed prism over the counterclockwise polygon `poly` (x, y) from `z0` to `z1`.
fn prism(name: &str, poly: &[(f64, f64)], z0: f64, z1: f64) -> Vec<u8> {
    let mut out = format!("solid {name}\n");
    let mut facet = |a: (f64, f64, f64), b: (f64, f64, f64), c: (f64, f64, f64)| {
        let _ = writeln!(out, "facet normal 0 0 0\n outer loop");
        for v in [a, b, c] {
            let _ = writeln!(out, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(out, " endloop\nendfacet");
    };
    let n = poly.len();
    // Caps as fans from the first vertex: the polygons here are convex.
    for i in 1..n - 1 {
        let (a, b, c) = (poly[0], poly[i], poly[i + 1]);
        facet((a.0, a.1, z0), (c.0, c.1, z0), (b.0, b.1, z0));
        facet((a.0, a.1, z1), (b.0, b.1, z1), (c.0, c.1, z1));
    }
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        facet((a.0, a.1, z0), (b.0, b.1, z0), (b.0, b.1, z1));
        facet((a.0, a.1, z0), (b.0, b.1, z1), (a.0, a.1, z1));
    }
    let _ = writeln!(out, "endsolid {name}");
    out.into_bytes()
}

/// An ASCII STL of the arch: two legs 8 mm square in plan and 8 mm tall, 10 mm apart, under a beam 38 mm long
/// and 2 mm thick, all 14 mm deep, from y = `y0`. Built as three boxes that share faces.
fn arch(y0: f64) -> Vec<u8> {
    let mut stl = Vec::new();
    let rect = |x0: f64, x1: f64| vec![(x0, y0), (x1, y0), (x1, y0 + 14.0), (x0, y0 + 14.0)];
    let mut solids = vec![
        prism("leg1", &rect(115.0, 123.0), 0.0, 8.0),
        prism("leg2", &rect(133.0, 141.0), 0.0, 8.0),
        prism("beam", &rect(109.0, 147.0), 8.0, 10.0),
    ];
    for s in &mut solids {
        stl.append(s);
    }
    stl
}

/// The wedge: a right triangle in plan from (116, `y0`) to (140, `y0`) and (140, `y0` + 2.4), 4 mm tall.
fn wedge(y0: f64) -> Vec<u8> {
    prism("wedge", &[(116.0, y0), (140.0, y0), (140.0, y0 + 2.4)], 0.0, 4.0)
}

/// G-code of the meshes, each placed where its vertices lie.
fn slice(meshes: &[(Vec<u8>, [f64; 3])], config: &Map<String, Value>) -> String {
    let loaded: Vec<Arc<Mesh>> = meshes
        .iter()
        .map(|(m, _)| Arc::new(Mesh::load(m, "m.stl").unwrap()))
        .collect();
    let objects: Vec<Value> = meshes
        .iter()
        .enumerate()
        .map(|(i, (_, t))| {
            json!({"id": format!("o{i}"), "name": format!("part{i}"), "mesh": i.to_string(),
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": 256, "depthMm": 256, "heightMm": 256}, "objects": objects},
        "config": Value::Object(config.clone()),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |id: &str| {
        Ok(loaded[id.parse::<usize>().unwrap()].clone())
    })
    .unwrap();
    String::from_utf8(r.gcode).unwrap()
}

/// The volcap plate: the arch and the wedge.
fn volcap(config: &Map<String, Value>) -> String {
    slice(&[(arch(118.0), [0.0; 3]), (wedge(136.0), [0.0; 3])], config)
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find(|w| w.starts_with(k))
        .and_then(|w| w[1..].parse().ok())
}

/// The fraction of segment a-b inside the box [x0, x1] x [y0, y1].
fn clip(a: (f64, f64), b: (f64, f64), bx: [f64; 4]) -> f64 {
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    for (p, q) in [
        (-dx, a.0 - bx[0]),
        (dx, bx[1] - a.0),
        (-dy, a.1 - bx[2]),
        (dy, bx[3] - a.1),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return 0.0;
            }
        } else if p < 0.0 {
            t0 = t0.max(q / p);
        } else {
            t1 = t1.min(q / p);
        }
    }
    (t1 - t0).max(0.0)
}

/// Filament (mm of 1.75 mm filament) extruded inside the box [x0, x1] x [y0, y1] on layers with Z in
/// [`z0`, `z1`], every feature but ironing, skirt and brim: each extruding move counts with the share of its
/// length inside the box, arcs as short chords.
fn strip_material(g: &str, bx: [f64; 4], z0: f64, z1: f64) -> f64 {
    let (mut x, mut y, mut z) = (0.0f64, 0.0f64, 0.0f64);
    let (mut relative, mut e_abs, mut counted) = (true, 0.0f64, true);
    let mut total = 0.0;
    for line in g.lines() {
        let s = line.trim();
        if let Some(c) = s.strip_prefix(';') {
            if let Some(f) = c.trim_start().strip_prefix("FEATURE:") {
                let f = f.trim().to_lowercase();
                counted = !(f.contains("ironing") || f.contains("skirt") || f.contains("brim"));
            }
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        let head = code.split_whitespace().next().unwrap_or("");
        match head {
            "M83" => relative = true,
            "M82" => relative = false,
            "G92" => {
                if let Some(v) = word(code, 'E') {
                    e_abs = v;
                }
            }
            "G0" | "G1" | "G2" | "G3" => {
                let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
                z = word(code, 'Z').unwrap_or(z);
                let e = match word(code, 'E') {
                    Some(v) if relative => v,
                    Some(v) => {
                        let d = v - e_abs;
                        e_abs = v;
                        d
                    }
                    None => 0.0,
                };
                if counted && e > 0.0 && (nx != x || ny != y) && (z0..=z1).contains(&z) {
                    let mut pts = vec![(x, y)];
                    let (i, j) = (word(code, 'I'), word(code, 'J'));
                    if head != "G0" && head != "G1" && (i.is_some() || j.is_some()) {
                        let (cx, cy) = (x + i.unwrap_or(0.0), y + j.unwrap_or(0.0));
                        let r = (x - cx).hypot(y - cy);
                        let a0 = (y - cy).atan2(x - cx);
                        let mut sweep = (ny - cy).atan2(nx - cx) - a0;
                        if head == "G2" && sweep >= 0.0 {
                            sweep -= std::f64::consts::TAU;
                        }
                        if head == "G3" && sweep <= 0.0 {
                            sweep += std::f64::consts::TAU;
                        }
                        let n = ((sweep.abs() * r / 0.2) as usize).max(1);
                        for k in 1..=n {
                            let a = a0 + sweep * k as f64 / n as f64;
                            pts.push((cx + r * a.cos(), cy + r * a.sin()));
                        }
                    } else {
                        pts.push((nx, ny));
                    }
                    let lens: Vec<f64> = pts
                        .windows(2)
                        .map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1))
                        .collect();
                    let all: f64 = lens.iter().sum();
                    let inside: f64 = pts
                        .windows(2)
                        .zip(&lens)
                        .map(|(w, l)| l * clip(w[0], w[1], bx))
                        .sum();
                    if all > 0.0 {
                        total += e * inside / all;
                    }
                }
                x = nx;
                y = ny;
            }
            _ => {}
        }
    }
    total
}

/// Filament in the wedge's strip, z 0.1 to 4.05. The P1S prints the plate 2 mm lower in Y.
fn strip(model: &str, g: &str) -> f64 {
    let dy = if model == "bambu-p1s" { -2.0 } else { 0.0 };
    strip_material(g, [124.5, 139.2, 136.3 + dy, 137.25 + dy], 0.1, 4.05)
}

/// What classic walls with gap fill put in the strip at the flow ratio, mm of filament.
fn target(model: &str, ratio: f64) -> f64 {
    let (a1, p1s) = match ratio {
        r if (r - 0.9).abs() < 1e-9 => (17.479, 17.420),
        r if (r - 0.98).abs() < 1e-9 => (19.033, 18.968),
        _ => (20.393, 20.323),
    };
    if model == "bambu-p1s" { p1s } else { a1 }
}

/// aegis puts within 3 percent of what classic walls and gap fill put in the strip, on both printers, at every
/// volumetric cap, flow ratio and cooling slowdown of the cases. It put 14.6 to 14.8 percent more.
#[test]
fn aegis_fills_a_narrow_strip_like_classic_walls_and_gap_fill() {
    let mut wrong = Vec::new();
    for model in ["bambu-a1", "bambu-p1s"] {
        for (name, cap, ratio, cooling) in CASES {
            let g = volcap(&settings(model, cap, ratio, cooling));
            let (got, want) = (strip(model, &g), target(model, ratio));
            let off = got / want - 1.0;
            eprintln!(
                "{model} {name}: {got:.3} mm of filament, {want:.3} wanted ({:+.1} percent)",
                off * 100.0
            );
            if off.abs() > 0.03 {
                wrong.push(format!(
                    "{model} {name}: the strip got {got:.3} mm of filament, {want:.3} wanted ({:+.1} percent)",
                    off * 100.0
                ));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// x-mark on its stock project settings with aegis walls keeps its totals on whole layers at its top
/// surfaces, z 5.75 to 6.25 and 58.95 to 59.25, within 3 percent of what classic walls with gap fill put there.
#[test]
fn x_mark_keeps_its_top_surface_layers() {
    let m = std::fs::read(format!("{}/packages/core/bench/models/x-mark.stl", root())).unwrap();
    let mut wrong = Vec::new();
    for model in ["bambu-a1", "bambu-p1s"] {
        let mut cfg = settings(model, 21.0, 0.98, None);
        for (k, v) in [
            ("ironing_type", json!("no ironing")),
            ("ironing_flow", json!(10)),
            ("ironing_speed", json!(30)),
            ("brim_type", json!("auto_brim")),
            ("brim_width", json!(5)),
            ("skirt_loops", json!(0)),
            ("skirt_speed", json!(50)),
            ("raft_first_layer_expansion", json!(-1)),
            ("enable_support", json!(false)),
            ("support_type", json!("tree(auto)")),
            ("tree_support_wall_count", json!(-1)),
            ("bridge_no_support", json!(false)),
            ("enable_overhang_speed", json!(true)),
            ("slow_down_for_layer_cooling", json!(true)),
            ("outer_wall_speed", json!(200)),
            ("top_surface_speed", json!(200)),
            ("sparse_infill_speed", json!(270)),
            ("internal_solid_infill_speed", json!(250)),
            ("gap_infill_speed", json!(250)),
            ("bridge_speed", json!(50)),
            ("internal_bridge_speed", json!("100%")),
            ("support_speed", json!(150)),
            ("support_interface_speed", json!(80)),
        ] {
            set(&mut cfg, k, v);
        }
        let g = slice(&[(m.clone(), [128.0, 128.0, 0.0])], &cfg);
        for (z0, z1, want) in [(5.75, 6.25, 259.391), (58.95, 59.25, 33.836)] {
            let got = strip_material(&g, [0.0, 256.0, 0.0, 256.0], z0, z1);
            let off = got / want - 1.0;
            eprintln!(
                "{model} x-mark z {z0} to {z1}: {got:.3} mm, {want:.3} wanted ({:+.1} percent)",
                off * 100.0
            );
            if off.abs() > 0.03 {
                wrong.push(format!(
                    "{model} x-mark z {z0} to {z1}: {got:.3} mm of filament, {want:.3} wanted ({:+.1} percent)",
                    off * 100.0
                ));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
