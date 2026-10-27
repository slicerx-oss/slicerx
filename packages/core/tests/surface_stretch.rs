// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Top surfaces and the first layer's bottom surface spread their lines evenly across each connected piece on
//! printers other than Bambu Lab's, at full surface density.
//!
//! The piece starts `ins` in from the part's outside. With variable-width walls that is the outer wall's width
//! plus an inner wall spacing for each further loop, less `top_bottom_infill_wall_overlap` of the inner wall's
//! spacing. With fixed-width walls it is the outer wall's centerline, the mean of the outer and inner spacings, an
//! inner spacing for each loop past the second and half an inner spacing, less the same overlap (a spacing is the
//! width less h (1 - pi / 4)). The first layer reads the first layer's widths. Across the lines the piece is R
//! wide. It holds N = floor(R / s0) cells, s0 being the surface's own spacing, and the lines sit s = R / N apart,
//! at most 1.2 s0, from half a spacing in, so both margins are equal unless the cap leaves the rest to the high
//! side. Each line prints s + h (1 - pi / 4) wide. Below full density the lines keep s0 over the density.
//!
//! Our own shapes: strips W by 30 mm along the lines of the top layer, on the stock Ender-3 V3 (fixed-width walls),
//! MK4 and Voron 2.4 settings (variable-width walls) at nozzles 0.4 and 0.6, with lines at 0, 45 and 135 degrees.
//! Each strip's W puts R / s0 half way between two whole numbers.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::disallowed_methods,
    clippy::many_single_char_names,
    clippy::approx_constant,
    reason = "a G-code reader for the test: positions, angles and lengths in mm; 0.3926 mm is a spacing, not pi / 8"
)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::f64::consts::PI;
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

const K: f64 = 1.0 - PI / 4.0;

fn read(path: &str) -> Value {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    serde_json::from_slice(&std::fs::read(format!("{root}/{path}")).unwrap()).unwrap()
}

/// A shipped printer (`vendor` file, `model` id), its filament and Standard process over the settings defaults,
/// with fixed layers and no brim, skirt or prime tower, then `extra`.
fn printer(vendor: &str, model: &str, extra: &Value) -> Value {
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
        "smart_layer": "off",
        "brim_type": "no_brim",
        "skirt_loops": 0,
        "enable_prime_tower": false,
        "enable_arc_fitting": false,
        "slow_down_for_layer_cooling": [false],
    });
    c.extend(fixed.as_object().unwrap().clone());
    c.extend(extra.as_object().unwrap().clone());
    Value::Object(c)
}

#[derive(Clone, Copy, Debug)]
enum Printer {
    Ender,
    Mk4,
    Voron,
}

/// The printer's stock settings at `nozzle` (0.4 or 0.6; 0.6 at 0.3 mm layers), then `extra`.
fn config(p: Printer, nozzle: f64, extra: &Value) -> Value {
    let big = nozzle > 0.5;
    let h = if big { 0.3 } else { 0.2 };
    let mut c = match p {
        // The Ender-3 V3: 0.42 mm lines (0.63 at the 0.6 nozzle), two fixed-width walls.
        Printer::Ender => {
            let w = if big { 0.63 } else { 0.42 };
            printer(
                "creality",
                "creality-ender-3-v3-ke",
                &json!({
                    "wall_generator": "classic",
                    "precise_outer_wall": false,
                    "line_width": w,
                    "outer_wall_line_width": w,
                    "inner_wall_line_width": w,
                    "internal_solid_infill_line_width": w,
                    "sparse_infill_line_width": w,
                    "top_surface_line_width": w,
                    "initial_layer_line_width": 0,
                    "support_line_width": 0,
                    "infill_wall_overlap": 15,
                    "elefant_foot_compensation": 0,
                    "detect_thin_wall": false,
                    "top_shell_layers": 5,
                    "bottom_shell_layers": 3,
                }),
            )
        }
        Printer::Mk4 => printer("prusa", "prusa-mk4", &json!({})),
        Printer::Voron if big => printer(
            "voron",
            "voron-2.4-300",
            &json!({
                "line_width": 0.6,
                "outer_wall_line_width": 0.6,
                "inner_wall_line_width": 0.6,
                "internal_solid_infill_line_width": 0.6,
                "sparse_infill_line_width": 0.6,
                "top_surface_line_width": 0.6,
                "initial_layer_line_width": 0.75,
            }),
        ),
        Printer::Voron => printer("voron", "voron-2.4-300", &json!({})),
    };
    let o = c.as_object_mut().unwrap();
    o.extend(
        json!({
            "nozzle_diameter": [nozzle],
            "layer_height": h,
            "initial_layer_print_height": h,
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    o.extend(extra.as_object().unwrap().clone());
    c
}

/// A box `w` across and `l` along, `z` tall, centered on (`cx`, `cy`) and turned `deg` degrees.
fn strip(c: (f64, f64), w: f64, l: f64, z: f64, deg: f64, name: &str) -> MeshPart {
    let (s, co) = deg.to_radians().sin_cos();
    let corners = [
        (-l / 2.0, -w / 2.0),
        (l / 2.0, -w / 2.0),
        (l / 2.0, w / 2.0),
        (-l / 2.0, w / 2.0),
    ];
    let mut positions = Vec::new();
    for zi in [0.0, z] {
        for (a, b) in corners {
            positions.push([
                (c.0 + a * co - b * s) as f32,
                (c.1 + a * s + b * co) as f32,
                zi as f32,
            ]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    MeshPart {
        name: name.into(),
        slot: 1,
        positions,
        triangles,
        ..MeshPart::default()
    }
}

/// One extruding move: from, to, filament mm, the feed (mm/min) and the stated line width.
#[derive(Debug, Clone, Copy)]
struct Seg {
    a: (f64, f64),
    b: (f64, f64),
    e: f64,
    feed: f64,
    width: f64,
}

impl Seg {
    fn len(&self) -> f64 {
        (self.b.0 - self.a.0).hypot(self.b.1 - self.a.1)
    }
}

/// The extruding moves of each feature, by layer z.
type Moves = BTreeMap<String, BTreeMap<String, Vec<Seg>>>;

fn slice(parts: Vec<MeshPart>, config: &Value) -> Moves {
    let mesh = Arc::new(Mesh {
        name: "m".into(),
        parts,
        ..Mesh::default()
    });
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "m", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}]},
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    let g = String::from_utf8(run.gcode).unwrap();
    let mut out = Moves::new();
    let (mut feature, mut width, mut z, mut at, mut feed) =
        (String::new(), 0.0, String::new(), (0.0, 0.0), 0.0);
    for line in g.lines() {
        if let Some(f) = line
            .strip_prefix("; FEATURE: ")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            f.trim().clone_into(&mut feature);
            continue;
        }
        if let Some(w) = line
            .strip_prefix("; LINE_WIDTH: ")
            .or_else(|| line.strip_prefix(";WIDTH:"))
        {
            width = w.trim().parse().unwrap();
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        let mut words = code.split_whitespace();
        let Some(cmd) = words.next() else { continue };
        if cmd != "G0" && cmd != "G1" {
            continue;
        }
        let (mut to, mut e) = (at, 0.0);
        for w in words {
            let (k, v) = w.split_at(1);
            let Ok(v) = v.parse::<f64>() else { continue };
            match k {
                "X" => to.0 = v,
                "Y" => to.1 = v,
                "Z" => z = format!("{v:.2}"),
                "E" => e = v,
                "F" => feed = v,
                _ => {}
            }
        }
        if cmd == "G1" && e > 0.0 && to != at {
            out.entry(z.clone())
                .or_default()
                .entry(feature.clone())
                .or_default()
                .push(Seg {
                    a: at,
                    b: to,
                    e,
                    feed,
                    width,
                });
        }
        at = to;
    }
    out
}

/// A setting as a number: a plain value, the first of a list, or a percent of the nozzle.
fn num(cfg: &Value, k: &str) -> f64 {
    let v = &cfg[k];
    let v = v.as_array().map_or(v, |a| &a[0]);
    if let Some(s) = v.as_str() {
        return match s.trim().strip_suffix('%') {
            Some(p) => p.parse::<f64>().unwrap() * num(cfg, "nozzle_diameter") / 100.0,
            None => s.trim().parse().unwrap(),
        };
    }
    v.as_f64().unwrap_or_else(|| panic!("{k}: {v}"))
}

/// What the rule reads for one layer: where the surface starts in from the outline and the nominal spacing.
#[derive(Debug, Clone, Copy)]
struct Rule {
    ins: f64,
    s0: f64,
    h: f64,
}

impl Rule {
    /// The top surface's rule, or with `first` the first layer bottom's.
    fn of(cfg: &Value, first: bool) -> Self {
        let line = num(cfg, "line_width");
        let initial = num(cfg, "initial_layer_line_width");
        let width = |k: &str| {
            if first && initial > 0.0 {
                return initial;
            }
            let w = num(cfg, k);
            if w > 0.0 { w } else { line }
        };
        let h = if first {
            num(cfg, "initial_layer_print_height")
        } else {
            num(cfg, "layer_height")
        };
        let sp = |w: f64| w - h * K;
        let (outer, inner) = (width("outer_wall_line_width"), width("inner_wall_line_width"));
        let loops = num(cfg, "wall_loops");
        let ov = num(cfg, "top_bottom_infill_wall_overlap") / 100.0;
        let ins = if cfg["wall_generator"].as_str() == Some("classic") {
            outer / 2.0 + f64::midpoint(sp(outer), sp(inner)) + (loops - 2.0) * sp(inner) + sp(inner) / 2.0
                - ov * sp(inner)
        } else {
            outer + (loops - 1.0) * sp(inner) - ov * sp(inner)
        };
        let surface = if first {
            width("internal_solid_infill_line_width")
        } else {
            width("top_surface_line_width")
        };
        Self {
            ins,
            s0: sp(surface),
            h,
        }
    }

    /// The strip width that puts R / s0 at `cells` and a half.
    fn strip_for(&self, cells: f64) -> f64 {
        2.0 * self.ins + (cells + 0.5) * self.s0
    }
}

/// What one strip printed on one layer: the line positions across (from the strip's low side) and their widths.
#[derive(Debug)]
struct Lines {
    at: Vec<f64>,
    widths: Vec<f64>,
}

impl Lines {
    fn mean_step(&self) -> f64 {
        (self.at[self.at.len() - 1] - self.at[0]) / (self.at.len() - 1) as f64
    }
}

/// The lines of `feature` on layer `z` along `deg` degrees inside the strip centered on `c`, `w` across.
fn lines(moves: &Moves, z: &str, feature: &str, c: (f64, f64), w: f64, deg: f64) -> Lines {
    let segs = moves
        .get(z)
        .and_then(|f| f.get(feature))
        .unwrap_or_else(|| panic!("no {feature} at z {z}: {:?}", moves.keys().collect::<Vec<_>>()));
    let (s, co) = deg.to_radians().sin_cos();
    let across = |g: &Seg| {
        let (mx, my) = (
            f64::midpoint(g.a.0, g.b.0) - c.0,
            f64::midpoint(g.a.1, g.b.1) - c.1,
        );
        -mx * s + my * co + w / 2.0
    };
    let mine: Vec<&Seg> = segs.iter().filter(|g| (0.0..=w).contains(&across(g))).collect();
    let mut at: Vec<f64> = mine
        .iter()
        .filter(|g| {
            let along = ((g.b.0 - g.a.0) * co + (g.b.1 - g.a.1) * s).abs();
            g.len() > 0.05 && (along - g.len()).abs() < 1e-3
        })
        .map(|g| across(g))
        .collect();
    at.sort_by(f64::total_cmp);
    at.dedup_by(|a, b| (*a - *b).abs() < 0.01);
    let mut widths: Vec<f64> = mine.iter().filter(|g| g.len() > 1.0).map(|g| g.width).collect();
    widths.sort_by(f64::total_cmp);
    widths.dedup();
    Lines { at, widths }
}

/// Checks a strip `w` across against the rule.
fn check(name: &str, got: &Lines, rule: &Rule, w: f64) {
    let r = w - 2.0 * rule.ins;
    let n = (r / rule.s0 + 1e-9).floor().max(1.0);
    let s = (r / n).min(1.2 * rule.s0);
    assert_eq!(
        got.at.len(),
        n as usize,
        "{name}: R {r:.4}, s0 {:.4}, lines {:?}",
        rule.s0,
        got.at
    );
    if n > 1.0 {
        // Positions come from 3-decimal coordinates; a few lines leave a noisier mean.
        let tol = if n < 6.0 { 0.0015 } else { 0.0005 };
        assert!(
            (got.mean_step() - s).abs() < tol,
            "{name}: spacing {:.5}, the rule gives {s:.5} (nominal {:.5})",
            got.mean_step(),
            rule.s0
        );
    }
    let m0 = rule.ins + s / 2.0;
    let m1 = w - m0 - (n - 1.0) * s;
    let (g0, g1) = (got.at[0], w - got.at[got.at.len() - 1]);
    assert!(
        (g0 - m0).abs() < 0.002 && (g1 - m1).abs() < 0.002,
        "{name}: margins {g0:.4} and {g1:.4}, the rule gives {m0:.4} and {m1:.4}"
    );
    let width = s + rule.h * K;
    assert!(
        got.widths.len() == 1 && (got.widths[0] - width).abs() < 0.0006,
        "{name}: widths {:?}, the rule gives {width:.5}",
        got.widths
    );
}

const C: (f64, f64) = (110.0, 100.0);

/// The z of a part's top layer, `layers` layers `h` thick.
fn top_z(layers: u32, h: f64) -> String {
    format!("{:.2}", f64::from(layers) * h)
}

/// One strip per printer and nozzle, with the top layer's lines at `angle` degrees (45 or 135 from the layer's own
/// direction, 0 from a rotation template), checked on the top layer and, where the first layer's lines run the same
/// way, on the first layer.
fn run_angle(angle: u32) {
    let deg = f64::from(angle);
    for p in [Printer::Ender, Printer::Mk4, Printer::Voron] {
        for nozzle in [0.4, 0.6] {
            let extra = if angle == 0 {
                json!({"solid_infill_rotate_template": "0"})
            } else {
                json!({})
            };
            let cfg = config(p, nozzle, &extra);
            let h = num(&cfg, "layer_height");
            // An odd layer count puts the top layer on the first layer's direction (45 degrees), an even one across it.
            let layers = if angle == 135 { 14 } else { 13 } + u32::from(nozzle < 0.5) * 2;
            let (top, first) = (Rule::of(&cfg, false), Rule::of(&cfg, true));
            // These counts keep the first layer's R / s0 at least 0.2 from a whole number too.
            let w = top.strip_for(if nozzle < 0.5 { 21.0 } else { 13.0 });
            let moves = slice(vec![strip(C, w, 30.0, f64::from(layers) * h, deg, "strip")], &cfg);
            let name = format!("{p:?} {nozzle} at {deg}");
            check(
                &format!("{name}, top"),
                &lines(&moves, &top_z(layers, h), "Top surface", C, w, deg),
                &top,
                w,
            );
            if angle != 135 {
                check(
                    &format!("{name}, first layer"),
                    &lines(&moves, &top_z(1, h), "Bottom surface", C, w, deg),
                    &first,
                    w,
                );
            }
        }
    }
}

#[test]
fn lines_along_45_degrees_spread_evenly_across_each_strip() {
    run_angle(45);
}

#[test]
fn lines_along_135_degrees_spread_evenly_across_each_strip() {
    run_angle(135);
}

#[test]
fn lines_along_0_degrees_spread_evenly_across_each_strip() {
    run_angle(0);
}

#[test]
fn a_narrow_strip_caps_the_spacing_and_leaves_the_rest_on_the_high_side() {
    // R / s0 is 2.60 on the Ender's 2.342 mm strip: 2 lines 1.2 s0 apart, the first half a spacing in.
    let cfg = config(Printer::Ender, 0.4, &json!({}));
    let rule = Rule::of(&cfg, false);
    let moves = slice(vec![strip(C, 2.342, 30.0, 3.0, 45.0, "strip")], &cfg);
    let got = lines(&moves, "3.00", "Top surface", C, 2.342, 45.0);
    check("Ender 2.342 mm strip", &got, &rule, 2.342);
    assert!((got.at[1] - got.at[0] - 0.4525).abs() < 0.0015, "{got:?}");
    assert!((got.at[0] - 0.9076).abs() < 0.002, "{got:?}");
    assert!((got.widths[0] - 0.4954).abs() < 0.0006, "{got:?}");
}

#[test]
fn two_strips_on_one_layer_each_get_their_own_spacing() {
    // The 7.3 and 12.6 mm strips 4 mm apart in one object: 15 lines at 0.39588 and 29 at 0.38749.
    let cfg = config(Printer::Ender, 0.4, &json!({}));
    let rule = Rule::of(&cfg, false);
    let (s, co) = 45f64.to_radians().sin_cos();
    let off = |d: f64| (C.0 - d * s, C.1 + d * co);
    let (a, b) = (off(-f64::midpoint(4.0, 12.6)), off(f64::midpoint(4.0, 7.3)));
    let moves = slice(
        vec![
            strip(a, 7.3, 30.0, 3.0, 45.0, "narrow"),
            strip(b, 12.6, 30.0, 3.0, 45.0, "wide"),
        ],
        &cfg,
    );
    for (c, w, n, step) in [(a, 7.3, 15, 0.39588), (b, 12.6, 29, 0.38749)] {
        let got = lines(&moves, "3.00", "Top surface", c, w, 45.0);
        check(&format!("{w} mm strip"), &got, &rule, w);
        assert_eq!(got.at.len(), n, "{w} mm strip");
        assert!((got.mean_step() - step).abs() < 0.0005, "{w} mm strip: {got:?}");
    }
}

#[test]
fn a_box_turned_against_the_lines_leaves_its_corner_cells_empty() {
    // 20 by 16 mm, lines at 45 degrees: 62 cells across, 60 lines 0.37950 apart, 0.42242 wide, on the top and the
    // first layer.
    for (z, feature, step) in [
        ("3.00", "Top surface", 0.3795),
        ("0.20", "Bottom surface", 0.37949),
    ] {
        let cfg = config(Printer::Ender, 0.4, &json!({}));
        let moves = slice(vec![strip(C, 16.0, 20.0, 3.0, 0.0, "box")], &cfg);
        let got = lines(&moves, z, feature, C, 40.0, 45.0);
        assert_eq!(got.at.len(), 60, "{feature}: {:?}", got.at);
        assert!((got.mean_step() - step).abs() < 0.0005, "{feature}: {got:?}");
        assert!((got.widths[0] - 0.42242).abs() < 0.0006, "{feature}: {got:?}");
    }
}

#[test]
fn below_full_density_the_lines_keep_the_spacing_over_the_density() {
    // 80 % top and bottom density: no stretch, the nominal width, lines s0 / 0.8 apart.
    for p in [Printer::Ender, Printer::Mk4, Printer::Voron] {
        let cfg = config(
            p,
            0.4,
            &json!({"top_surface_density": 80, "bottom_surface_density": 80}),
        );
        let rule = Rule::of(&cfg, false);
        let w = rule.strip_for(20.0);
        let moves = slice(vec![strip(C, w, 30.0, 3.0, 45.0, "strip")], &cfg);
        let got = lines(&moves, "3.00", "Top surface", C, w, 45.0);
        let want = rule.s0 / 0.8;
        assert!(
            (got.mean_step() - want).abs() < 0.0005,
            "{p:?}: spacing {:.5}, want {want:.5}",
            got.mean_step()
        );
        assert!(
            got.widths.len() == 1 && (got.widths[0] - (rule.s0 + rule.h * K)).abs() < 0.0006,
            "{p:?}: widths {:?}",
            got.widths
        );
    }
}

/// The first layer's lines of a box `w` across in Y and 15 mm along X centered on `c`, along X, and their E per mm.
fn first_layer_x(moves: &Moves, c: (f64, f64), w: f64) -> (Lines, f64) {
    let segs: Vec<&Seg> = moves["0.20"]["Bottom surface"]
        .iter()
        .filter(|g| (f64::midpoint(g.a.0, g.b.0) - c.0).abs() < 7.5 && (g.a.1 - c.1).abs() < w / 2.0)
        .collect();
    let along: Vec<&&Seg> = segs
        .iter()
        .filter(|g| (g.a.1 - g.b.1).abs() < 1e-3 && g.len() > 1.0)
        .collect();
    let mut at: Vec<f64> = along.iter().map(|g| g.a.1 - c.1 + w / 2.0).collect();
    at.sort_by(f64::total_cmp);
    at.dedup_by(|a, b| (*a - *b).abs() < 0.01);
    let mut widths: Vec<f64> = along.iter().map(|g| g.width).collect();
    widths.sort_by(f64::total_cmp);
    widths.dedup();
    let e = along.iter().map(|g| g.e).sum::<f64>() / along.iter().map(|g| g.len()).sum::<f64>();
    (Lines { at, widths }, e)
}

/// Filament mm per mm of a flat bead `w` wide at height `h`.
fn bead_e(cfg: &Value, w: f64, h: f64) -> f64 {
    let area = PI * num(cfg, "filament_diameter").powi(2) / 4.0;
    h * (w - h * K) * num(cfg, "filament_flow_ratio") / area
}

#[test]
fn first_layer_slabs_spread_their_lines_evenly() {
    // Slabs 15 mm along X and W across, 0.6 mm tall, lines along X: (printer, first layer width, W, lines, spacing,
    // stated width).
    type Slabs<'a> = &'a [(f64, usize, f64, f64)];
    let cases: [(Printer, Option<f64>, Slabs<'_>); 4] = [
        (
            Printer::Mk4,
            None,
            &[
                (10.0, 17, 0.4418, 0.4847),
                (10.4, 18, 0.4394, 0.4824),
                (10.8, 19, 0.4373, 0.4803),
            ],
        ),
        (
            Printer::Mk4,
            Some(0.6),
            &[(10.0, 12, 0.5709, 0.6138), (10.4, 13, 0.5577, 0.6006)],
        ),
        (
            Printer::Ender,
            None,
            &[(10.0, 22, 0.3926, 0.4355), (10.1, 23, 0.38, 0.4228)],
        ),
        (
            Printer::Voron,
            None,
            &[(10.0, 16, 0.4625, 0.5054), (10.4, 17, 0.4589, 0.5018)],
        ),
    ];
    for (p, initial, slabs) in cases {
        let mut extra = json!({"solid_infill_rotate_template": "0"});
        if let Some(w) = initial {
            extra["initial_layer_line_width"] = json!(w);
        }
        let cfg = config(p, 0.4, &extra);
        let at = |k: usize| (60.0 + 18.0 * k as f64, 100.0);
        let parts = slabs
            .iter()
            .enumerate()
            .map(|(k, &(w, ..))| strip(at(k), w, 15.0, 0.6, 0.0, "slab"))
            .collect();
        let moves = slice(parts, &cfg);
        for (k, &(w, n, step, width)) in slabs.iter().enumerate() {
            let name = format!("{p:?} {initial:?} slab {w}");
            let (got, e) = first_layer_x(&moves, at(k), w);
            assert_eq!(got.at.len(), n, "{name}: {:?}", got.at);
            assert!(
                (got.mean_step() - step).abs() < 0.001,
                "{name}: spacing {:.5}",
                got.mean_step()
            );
            assert!(
                got.widths.len() == 1 && (got.widths[0] - width).abs() < 0.001,
                "{name}: widths {:?}",
                got.widths
            );
            let want = bead_e(&cfg, width, 0.2);
            assert!(
                (e - want).abs() < 0.003 * want,
                "{name}: E per mm {e:.6}, the bead gives {want:.6}"
            );
        }
    }
}

/// An arch: a 38 by 14 mm beam 2 mm thick on two 8 mm legs 8 mm tall, and a wedge 24 mm long, 2.4 mm to 0 wide and
/// 4 mm tall beside it.
fn arch() -> Vec<MeshPart> {
    let mut wedge = strip((0.0, 0.0), 1.0, 1.0, 4.0, 0.0, "wedge");
    wedge.positions = [(113.0, 113.0), (137.0, 113.0), (137.0, 115.4)]
        .iter()
        .flat_map(|&(x, y)| [[x as f32, y as f32, 0.0], [x as f32, y as f32, 4.0]])
        .collect();
    wedge.triangles = vec![
        [0, 4, 2],
        [1, 3, 5],
        [0, 2, 3],
        [0, 3, 1],
        [2, 4, 5],
        [2, 5, 3],
        [4, 0, 1],
        [4, 1, 5],
    ];
    vec![
        strip((116.0, 102.0), 14.0, 8.0, 8.0, 0.0, "left"),
        strip((134.0, 102.0), 14.0, 8.0, 8.0, 0.0, "right"),
        strip((125.0, 102.0), 14.0, 38.0, 2.0, 0.0, "beam"),
        wedge,
    ]
    .into_iter()
    .enumerate()
    .map(|(k, mut p)| {
        if k == 2 {
            p.positions.iter_mut().for_each(|q| q[2] += 8.0);
        }
        p
    })
    .collect()
}

#[test]
fn the_first_layer_bottom_feeds_more_filament_per_mm_as_its_lines_spread() {
    // The arch's legs and wedge at a flow ratio of 0.9: E per mm of the first layer's bottom surface, lines at 45
    // degrees (on main 0.032711, 0.028219 and 0.034208).
    for (p, want) in [
        (Printer::Mk4, 0.033_356),
        (Printer::Ender, 0.028_333),
        (Printer::Voron, 0.035_559),
    ] {
        let cfg = config(
            p,
            0.4,
            &json!({"filament_flow_ratio": [0.9], "filament_max_volumetric_speed": [50]}),
        );
        let moves = slice(arch(), &cfg);
        let segs = &moves["0.20"]["Bottom surface"];
        let e = segs.iter().map(|g| g.e).sum::<f64>() / segs.iter().map(Seg::len).sum::<f64>();
        assert!(
            (e - want).abs() < 0.003 * want,
            "{p:?}: E per mm {e:.6}, want {want:.6}"
        );
    }
}

#[test]
fn the_first_layer_bottom_keeps_its_feed_where_no_cap_binds() {
    for p in [Printer::Mk4, Printer::Ender, Printer::Voron] {
        let cfg = config(p, 0.4, &json!({"filament_max_volumetric_speed": [50]}));
        let moves = slice(vec![strip(C, 10.0, 15.0, 0.6, 0.0, "slab")], &cfg);
        let feed = num(&cfg, "initial_layer_infill_speed") * 60.0;
        for g in &moves["0.20"]["Bottom surface"] {
            assert!((g.feed - feed).abs() < 0.5, "{p:?}: feed {} for {feed}", g.feed);
        }
    }
}

#[test]
fn over_a_raft_the_parts_first_layer_keeps_one_grid() {
    // The bottom over the raft is not the first layer: it keeps the nominal width.
    let cfg = config(Printer::Mk4, 0.4, &json!({"raft_layers": 2}));
    let moves = slice(vec![strip(C, 10.0, 15.0, 0.6, 0.0, "slab")], &cfg);
    let (z, feats) = moves
        .iter()
        .find(|(_, f)| f.contains_key("Bottom surface"))
        .expect("a bottom surface over the raft");
    let mut widths: Vec<f64> = feats["Bottom surface"].iter().map(|g| g.width).collect();
    widths.dedup();
    assert_eq!(widths, vec![0.48], "bottom at z {z}");
}
