// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Bridge strands on a Bambu Lab printer spread evenly across each bridge.
//!
//! The bridge region starts c in from the part's outside: the inner wall's centerline (where the walls of the
//! layer below put it), plus half the inner wall's spacing, less `infill_wall_overlap` of the mean of the inner
//! wall's and the internal solid infill's spacings (a spacing is the width less h (1 - pi / 4)). Across the
//! strands the region is R wide. It holds N = floor(R / s0) equal cells, and a strand runs down the middle of
//! each, so the spacing is R / N. Round strands (the first solid layer over sparse infill, and bridges over air
//! with `thick_bridges`) start from s0 = nozzle + 0.05 and print 0.05 less than their spacing across. Flat strands
//! (bridges over air) start from the internal solid infill's spacing and print h (1 - pi / 4) wider than their
//! spacing, at the layer height. On a fill turned against the region's sides the two corner cells hold no
//! strand.
//!
//! Our own shapes on the shipped A1 settings (0.20 mm Standard, fixed layers, no brim): boxes W by 30 by 6 mm,
//! whose first top layer bridges the 15 % sparse infill, and blocks D deep (two 3 mm pillars 4 mm tall, 8 mm
//! apart, under a slab from 4 to 5.6 mm), whose first layer bridges the gap. Each size puts R / s0 0.15 below or
//! above a whole number. The shipped A1 settings print with precise outer wall off, so the inner walls sit
//! k = h (1 - pi / 4) nearer the outside than with it on, and the sizes are 2k (blocks) and 4k (boxes, whose region
//! is measured at 45 degrees) smaller than they were with it on.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::disallowed_methods,
    clippy::many_single_char_names,
    reason = "a G-code reader for the test: positions, angles and lengths in mm"
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

/// The shipped A1 printer, PLA and 0.20 mm Standard process over the settings defaults, with fixed layers and no
/// brim, skirt or prime tower, then `extra`.
fn a1(extra: &Value) -> Value {
    let mut c = serde_json::Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        c.insert(k.clone(), v[1].clone());
    }
    let model = &read("packages/profiles/resolved/bambu-lab.json")["models"]["bambu-a1"];
    let base = model["base"].as_str().unwrap();
    for part in [&model["process"][base], &model["filament"], &model["machine"]] {
        c.extend(part.as_object().unwrap().clone());
    }
    let fixed = json!({
        "smart_layer": "off",
        "brim_type": "no_brim",
        "skirt_loops": 0,
        "enable_prime_tower": false,
    });
    c.extend(fixed.as_object().unwrap().clone());
    c.extend(extra.as_object().unwrap().clone());
    Value::Object(c)
}

fn cuboid(x: [f32; 2], y: [f32; 2], z: [f32; 2], name: &str) -> MeshPart {
    let mut positions = Vec::new();
    for zi in z {
        for (xi, yi) in [(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])] {
            positions.push([xi, yi, zi]);
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

/// A closed box `w` by 30 mm, 6 mm tall.
fn bx(w: f32) -> Vec<MeshPart> {
    vec![cuboid([0.0, w], [0.0, 30.0], [0.0, 6.0], "box")]
}

/// Two 3 mm pillars 4 mm tall and 8 mm apart under a slab 1.6 mm thick, all `d` mm deep.
fn block(d: f32) -> Vec<MeshPart> {
    vec![
        cuboid([0.0, 3.0], [0.0, d], [0.0, 4.0], "left"),
        cuboid([11.0, 14.0], [0.0, d], [0.0, 4.0], "right"),
        cuboid([0.0, 14.0], [0.0, d], [4.0, 5.6], "slab"),
    ]
}

/// One extruding move: from, to, filament mm, the stated line width.
#[derive(Debug, Clone, Copy)]
struct Seg {
    a: (f64, f64),
    b: (f64, f64),
    e: f64,
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
        "plate": {"objects": [{"mesh": "m"}]},
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    let g = String::from_utf8(run.gcode).unwrap();
    let mut out = Moves::new();
    let (mut feature, mut width, mut z, mut at) = (String::new(), 0.0, String::new(), (0.0, 0.0));
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
                    width,
                });
        }
        at = to;
    }
    out
}

/// The settings the rule reads, from the config.
struct Rule {
    nozzle: f64,
    h: f64,
    /// How far the bridge region starts inside the inner wall's centerline, mm.
    past_inner: f64,
    inner_width: f64,
    solid_spacing: f64,
    /// Filament mm per mm3 of bead.
    per_mm3: f64,
}

impl Rule {
    fn of(cfg: &Value) -> Self {
        let num = |k: &str| -> f64 {
            let v = &cfg[k];
            let v = v.as_array().map_or(v, |a| &a[0]);
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.trim_end_matches('%').parse().ok()))
                .unwrap_or_else(|| panic!("{k}: {v}"))
        };
        let (nozzle, h) = (num("nozzle_diameter"), num("layer_height"));
        let sp = |w: f64| w - h * K;
        let (inner, solid) = (
            num("inner_wall_line_width"),
            num("internal_solid_infill_line_width"),
        );
        let overlap = num("infill_wall_overlap") / 100.0;
        let area = PI * num("filament_diameter").powi(2) / 4.0;
        Self {
            nozzle,
            h,
            past_inner: sp(inner) / 2.0 - overlap * f64::midpoint(sp(inner), sp(solid)),
            inner_width: inner,
            solid_spacing: sp(solid),
            per_mm3: num("filament_flow_ratio") / area,
        }
    }

    /// Where the bridge region starts inside a part `size` mm across along x (or y), from the inner wall of
    /// layer `z`.
    fn edge(&self, moves: &Moves, z: &str, size: f64, along_y: bool) -> f64 {
        let walls = &moves[z]["Inner wall"];
        let at = |p: (f64, f64)| if along_y { p.1 } else { p.0 };
        let lo = walls
            .iter()
            .flat_map(|s| [at(s.a), at(s.b)])
            .fold(f64::MAX, f64::min);
        let hi = walls
            .iter()
            .flat_map(|s| [at(s.a), at(s.b)])
            .fold(f64::MIN, f64::max);
        (size - (hi - lo)) / 2.0 + self.past_inner
    }
}

/// What a bridge layer printed: the strand angle (degrees, 0 to 180), the strand positions across, their widths
/// and filament per mm.
#[derive(Debug)]
struct Strands {
    angle: f64,
    at: Vec<f64>,
    widths: Vec<f64>,
    e_per_mm: f64,
}

impl Strands {
    fn steps(&self) -> Vec<f64> {
        self.at.windows(2).map(|p| p[1] - p[0]).collect()
    }
}

/// The strands of the one layer with bridge strands, with `s0` the nominal spacing.
fn strands(moves: &Moves, s0: f64) -> (String, Strands) {
    let layers: Vec<(&String, &Vec<Seg>)> = moves
        .iter()
        .filter_map(|(z, f)| f.get("Bridge").map(|s| (z, s)))
        .collect();
    assert_eq!(
        layers.len(),
        1,
        "bridge layers: {:?}",
        layers.iter().map(|l| l.0).collect::<Vec<_>>()
    );
    let (z, segs) = layers[0];
    // The strand direction: the longest share of the moves.
    let mut by_angle: BTreeMap<i64, f64> = BTreeMap::new();
    for s in segs {
        let a = (s.b.1 - s.a.1)
            .atan2(s.b.0 - s.a.0)
            .to_degrees()
            .rem_euclid(180.0)
            .round() as i64
            % 180;
        *by_angle.entry(a).or_default() += s.len();
    }
    let angle = *by_angle.iter().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
    let t = (angle as f64).to_radians();
    let (ux, uy) = (t.cos(), t.sin());
    let along: Vec<&Seg> = segs
        .iter()
        .filter(|s| {
            s.len() > 0.2 && (((s.b.0 - s.a.0) * ux + (s.b.1 - s.a.1) * uy).abs() - s.len()).abs() < 1e-3
        })
        .collect();
    // One strand per cluster of positions across, at its longest piece (links along the edge sit next to it).
    let mut pieces: Vec<(f64, f64)> = along
        .iter()
        .map(|s| {
            (
                f64::midpoint(s.a.0, s.b.0) * -uy + f64::midpoint(s.a.1, s.b.1) * ux,
                s.len(),
            )
        })
        .collect();
    pieces.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut at: Vec<(f64, f64)> = Vec::new();
    for (p, l) in pieces {
        match at.last_mut() {
            Some(last) if p - last.0 < 0.4 * s0 => {
                if l > last.1 {
                    *last = (p, l);
                }
            }
            _ => at.push((p, l)),
        }
    }
    let long: Vec<&&Seg> = along.iter().filter(|s| s.len() > 1.0).collect();
    let mut widths: Vec<f64> = long.iter().map(|s| s.width).collect();
    widths.sort_by(f64::total_cmp);
    widths.dedup();
    let e_per_mm = long.iter().map(|s| s.e).sum::<f64>() / long.iter().map(|s| s.len()).sum::<f64>();
    (
        z.clone(),
        Strands {
            angle: angle as f64,
            at: at.into_iter().map(|p| p.0).collect(),
            widths,
            e_per_mm,
        },
    )
}

/// Checks one bridge of a part `size` (x, y) mm against the rule, with round or flat strands.
/// `c` is where the bridge region starts inside the part.
fn check(name: &str, got: &Strands, rule: &Rule, size: (f64, f64), c: f64, round: bool, cells: usize) {
    let t = got.angle.to_radians();
    let r = (size.0 - 2.0 * c) * t.sin().abs() + (size.1 - 2.0 * c) * t.cos().abs();
    let s0 = if round {
        rule.nozzle + 0.05
    } else {
        rule.solid_spacing
    };
    let n = (r / s0 + 1e-9).floor();
    assert_eq!(
        n as usize, cells,
        "{name}: the sizes are picked for {cells} cells, R {r:.4}"
    );
    let s = r / n;
    let w = if round { s - 0.05 } else { s + rule.h * K };
    // A fill turned against the sides leaves the two corner cells empty.
    let diagonal = (2.0 * t).sin().abs() > 0.5;
    let printed = if diagonal { cells - 2 } else { cells };
    assert_eq!(
        got.at.len(),
        printed,
        "{name}: strands at angle {}: {got:?}",
        got.angle
    );
    for step in got.steps() {
        assert!(
            (step - s).abs() < 0.0015,
            "{name}: spacing {step:.4}, the rule gives {s:.4}"
        );
    }
    assert!(
        got.widths.len() == 1 && (got.widths[0] - w).abs() < 0.0006,
        "{name}: widths {:?}, the rule gives {w:.4}",
        got.widths
    );
    let bead = if round {
        PI * w * w / 4.0
    } else {
        rule.h * (w - rule.h) + PI * rule.h * rule.h / 4.0
    };
    let e = bead * rule.per_mm3;
    assert!(
        (got.e_per_mm - e).abs() < 0.003 * e,
        "{name}: E per mm {:.5}, the rule gives {e:.5}",
        got.e_per_mm
    );
}

/// The overhang wall of the slab's first layer keeps its own bead: round and the nozzle wide with thick bridges,
/// else flat at the layer height and `width` wide (the inner wall's).
fn check_overhang_wall(name: &str, moves: &Moves, z: &str, rule: &Rule, round: bool, width: f64) {
    let segs = &moves[z]["Overhang wall"];
    let mut widths: Vec<f64> = segs.iter().map(|s| s.width).collect();
    widths.dedup();
    let d = if round { rule.nozzle } else { width };
    assert_eq!(widths, vec![d], "{name}: overhang wall widths");
    let long: Vec<&Seg> = segs.iter().filter(|s| s.len() > 1.0).collect();
    let e = long.iter().map(|s| s.e).sum::<f64>() / long.iter().map(|s| s.len()).sum::<f64>();
    let bead = if round {
        PI * d * d / 4.0
    } else {
        rule.h * (d - rule.h) + PI * rule.h * rule.h / 4.0
    };
    let want = bead * rule.per_mm3;
    assert!(
        (e - want).abs() < 0.003 * want,
        "{name}: overhang wall E per mm {e:.5}, its bead gives {want:.5}"
    );
}

#[test]
fn round_strands_over_sparse_infill_spread_evenly() {
    let cfg = a1(&json!({}));
    let rule = Rule::of(&cfg);
    // R / 0.45 is 55.85 and 56.15 on a fill at 45 degrees.
    for (w, cells) in [(8.530_f32, 55), (8.721, 56)] {
        let moves = slice(bx(w), &cfg);
        let (z, got) = strands(&moves, 0.45);
        assert_eq!(z, "5.20", "box {w}");
        let c = rule.edge(&moves, "5.00", f64::from(w), false);
        assert!(
            (c - rule.edge(&moves, "5.00", 30.0, true)).abs() < 0.002,
            "box {w}: walls"
        );
        check(
            &format!("box {w}"),
            &got,
            &rule,
            (f64::from(w), 30.0),
            c,
            true,
            cells,
        );
    }
}

#[test]
fn flat_strands_over_air_spread_evenly() {
    let cfg = a1(&json!({}));
    let rule = Rule::of(&cfg);
    // R over the internal solid infill spacing is 9.85 and 10.15.
    for (d, cells) in [(5.208_f32, 9), (5.321, 10)] {
        let moves = slice(block(d), &cfg);
        let (z, got) = strands(&moves, rule.solid_spacing);
        assert_eq!(z, "4.20", "block {d}");
        let c = rule.edge(&moves, "4.00", f64::from(d), true);
        check(
            &format!("block {d}"),
            &got,
            &rule,
            (14.0, f64::from(d)),
            c,
            false,
            cells,
        );
        check_overhang_wall(&format!("block {d}"), &moves, &z, &rule, false, rule.inner_width);
    }
}

#[test]
fn thick_bridges_turn_the_strands_over_air_round() {
    let cfg = a1(&json!({"thick_bridges": true}));
    let rule = Rule::of(&cfg);
    // R / 0.45 is 7.85 and 8.15.
    for (d, cells) in [(5.026_f32, 7), (5.161, 8)] {
        let moves = slice(block(d), &cfg);
        let (z, got) = strands(&moves, 0.45);
        assert_eq!(z, "4.20", "block {d}");
        let c = rule.edge(&moves, "4.00", f64::from(d), true);
        check(
            &format!("thick block {d}"),
            &got,
            &rule,
            (14.0, f64::from(d)),
            c,
            true,
            cells,
        );
        check_overhang_wall(
            &format!("thick block {d}"),
            &moves,
            &z,
            &rule,
            true,
            rule.inner_width,
        );
    }
}

#[test]
fn other_printers_keep_the_strand_grid() {
    // The same block on a printer that is not a Bambu Lab one: flat strands of the bridge line width (the nozzle),
    // on the grid at its spacing.
    let cfg = a1(&json!({"printer_model": "Generic", "gcode_flavor": "marlin"}));
    let rule = Rule::of(&cfg);
    let moves = slice(block(5.294), &cfg);
    let (_, got) = strands(&moves, rule.solid_spacing);
    let s = rule.nozzle - rule.h * K;
    for step in got.steps() {
        assert!(
            (step - s).abs() < 0.0015,
            "spacing {step:.4}, the grid's is {s:.4}"
        );
    }
    assert_eq!(got.widths, vec![rule.nozzle]);
}

/// Flat strands over air with variable-width walls: the bridge region follows the inner wall wherever the wall
/// generator and `precise_outer_wall` put it.
fn flat_strands_follow_the_inner_wall(generator: &str, precise: bool, sizes: [(f32, usize); 2]) {
    flat_strands_follow_the_inner_wall_at(generator, precise, 0.2, sizes);
}

/// [`flat_strands_follow_the_inner_wall`] at `h` mm layers: the region starts from the inner wall of the layer
/// under the slab's first layer.
fn flat_strands_follow_the_inner_wall_at(generator: &str, precise: bool, h: f64, sizes: [(f32, usize); 2]) {
    let cfg = a1(&json!({"wall_generator": generator, "precise_outer_wall": precise, "layer_height": h}));
    for (d, cells) in sizes {
        let name = format!("{generator} precise {precise} h {h} block {d}");
        let moves = slice(block(d), &cfg);
        let (z, got) = strands(&moves, Rule::of(&cfg).solid_spacing);
        // The rule reads the bridge layer's own height, which runs short of a full layer where the slab starts,
        // and its own inner wall.
        let below = moves
            .keys()
            .map(|k| k.parse::<f64>().unwrap())
            .filter(|k| *k < z.parse::<f64>().unwrap())
            .fold(0.0, f64::max);
        let mut layer = cfg.clone();
        layer["layer_height"] = json!(z.parse::<f64>().unwrap() - below);
        let rule = Rule::of(&layer);
        let c = rule.edge(&moves, &z, f64::from(d), true);
        check(&name, &got, &rule, (14.0, f64::from(d)), c, false, cells);
    }
}

#[test]
fn aegis_strands_follow_the_inner_wall_with_precise_outer_wall() {
    // The first inner wall's centerline sits 0.645 mm in, so the region starts 0.790 mm in.
    flat_strands_follow_the_inner_wall("aegis", true, [(5.294, 9), (5.407, 10)]);
}

#[test]
fn aegis_strands_follow_the_inner_wall_without_precise_outer_wall() {
    // The first inner wall's centerline sits 0.602 mm in, so the region starts 0.747 mm in.
    flat_strands_follow_the_inner_wall("aegis", false, [(5.208, 9), (5.321, 10)]);
}

#[test]
fn arachne_strands_follow_the_inner_wall() {
    flat_strands_follow_the_inner_wall("arachne", true, [(5.294, 9), (5.407, 10)]);
}

#[test]
fn classic_strands_follow_the_inner_wall_without_precise_outer_wall() {
    // The first inner wall's centerline sits 0.602 mm in at 0.2 mm layers, so the region starts 0.747 mm in. At
    // 0.3 mm layers the bridge layer is 0.28 mm thick (the slab starts between two layers): 0.585 and 0.723.
    flat_strands_follow_the_inner_wall_at("classic", false, 0.2, [(5.208, 9), (5.321, 10)]);
    flat_strands_follow_the_inner_wall_at("classic", false, 0.3, [(4.991, 9), (5.099, 10)]);
}

#[test]
fn classic_strands_follow_the_inner_wall_with_precise_outer_wall() {
    // The first inner wall's centerline sits 0.645 mm in at both heights, so the region starts 0.790 mm in at 0.2 mm
    // layers and 0.784 mm in on the 0.28 mm bridge layer at 0.3.
    flat_strands_follow_the_inner_wall_at("classic", true, 0.2, [(5.294, 9), (5.407, 10)]);
    flat_strands_follow_the_inner_wall_at("classic", true, 0.3, [(5.112, 9), (5.220, 10)]);
}
