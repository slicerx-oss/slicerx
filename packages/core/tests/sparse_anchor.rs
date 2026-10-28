// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Sparse infill hangs off each object's own box, on every printer.
//!
//! C is the center of an object's XY bounding box on the plate, as placed (after its turn). The patterns drawn
//! from a fixed point put that point at C: the rectilinear family's lines pass through C (`n . C + k * pitch`,
//! pitch `sp / d`, sp the width less h (1 - pi / 4)), grid's two directions likewise at `2 sp / d`, and honeycomb,
//! 3D honeycomb and crosshatch draw what they draw with the plate origin moved to C. The gyroid's lattice origin
//! is C less ten spacings (modulo its period) on most printers, and C itself on Bambu Lab printers. Every object
//! has its own C; copies of one object each have theirs. So the infill moves with its object: the same object
//! anywhere on the bed gets the same infill relative to C.
//!
//! Our own shapes (squares, an L shape) on the stock MK4, Voron 2.4 300 and A1 settings.
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
use std::fmt::Write as _;
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

/// Furthest a line may sit off its lattice, mm (the G-code has three decimals).
const TOL: f64 = 0.01;

fn read(path: &str) -> Value {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    serde_json::from_slice(&std::fs::read(format!("{root}/{path}")).unwrap()).unwrap()
}

/// A shipped printer (`vendor` file, `model` id), its filament and Standard process over the settings defaults,
/// at 0.2 mm layers with no brim, skirt, prime tower or arcs, then `extra`.
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
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
    });
    c.extend(fixed.as_object().unwrap().clone());
    c.extend(extra.as_object().unwrap().clone());
    Value::Object(c)
}

fn mk4(extra: &Value) -> Value {
    printer("prusa", "prusa-mk4", extra)
}

fn voron(extra: &Value) -> Value {
    printer("voron", "voron-2.4-300", extra)
}

fn a1(extra: &Value) -> Value {
    printer("bambu-lab", "bambu-a1", extra)
}

/// `cfg` with its bed moved so that the plate origin is the middle of the bed.
fn centered_bed(cfg: &Value) -> Value {
    let mut c = cfg.clone();
    let area = c["printable_area"].as_array().unwrap().clone();
    let xs: Vec<f64> = area.iter().map(|p| p[0].as_f64().unwrap()).collect();
    let ys: Vec<f64> = area.iter().map(|p| p[1].as_f64().unwrap()).collect();
    let (mx, my) = (
        f64::midpoint(
            xs.iter().copied().fold(f64::MAX, f64::min),
            xs.iter().copied().fold(f64::MIN, f64::max),
        ),
        f64::midpoint(
            ys.iter().copied().fold(f64::MAX, f64::min),
            ys.iter().copied().fold(f64::MIN, f64::max),
        ),
    );
    c["printable_area"] = Value::Array(xs.iter().zip(&ys).map(|(x, y)| json!([x - mx, y - my])).collect());
    c
}

/// The middle of the printer's bed.
fn bed_center(cfg: &Value) -> (f64, f64) {
    let area = cfg["printable_area"].as_array().unwrap();
    let xs: Vec<f64> = area.iter().map(|p| p[0].as_f64().unwrap()).collect();
    let ys: Vec<f64> = area.iter().map(|p| p[1].as_f64().unwrap()).collect();
    (
        f64::midpoint(
            xs.iter().copied().fold(f64::MAX, f64::min),
            xs.iter().copied().fold(f64::MIN, f64::max),
        ),
        f64::midpoint(
            ys.iter().copied().fold(f64::MAX, f64::min),
            ys.iter().copied().fold(f64::MIN, f64::max),
        ),
    )
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

/// The distance between neighboring sparse lines of one direction at full density: the sparse width less
/// h (1 - pi / 4).
fn sparse_spacing(cfg: &Value) -> f64 {
    num(cfg, "sparse_infill_line_width") - num(cfg, "layer_height") * (1.0 - PI / 4.0)
}

fn density(cfg: &Value) -> f64 {
    num(cfg, "sparse_infill_density") / 100.0
}

/// A prism `h` tall over `outline` (counterclockwise, a fan from its first point), mm.
fn prism(name: &str, outline: &[(f64, f64)], h: f64) -> MeshPart {
    let n = outline.len() as u32;
    let mut positions = Vec::new();
    for z in [0.0, h] {
        for &(x, y) in outline {
            positions.push([x as f32, y as f32, z as f32]);
        }
    }
    let mut triangles = Vec::new();
    for k in 1..n - 1 {
        triangles.push([0, k + 1, k]);
        triangles.push([n, n + k, n + k + 1]);
    }
    for k in 0..n {
        let m = (k + 1) % n;
        triangles.push([k, m, n + m]);
        triangles.push([k, n + m, n + k]);
    }
    MeshPart {
        name: name.into(),
        slot: 1,
        positions,
        triangles,
        ..MeshPart::default()
    }
}

/// A box `w` by `l`, 6 mm tall, centered on its origin.
fn block(w: f64, l: f64) -> MeshPart {
    let (a, b) = (w / 2.0, l / 2.0);
    prism("block", &[(-a, -b), (a, -b), (a, b), (-a, b)], 6.0)
}

/// An L 30 mm square with 10 mm arms, 6 mm tall, the middle of its box on its origin (its centroid lies 4 mm
/// down and left of that).
fn l_shape() -> MeshPart {
    let pts = [
        (0.0, 0.0),
        (30.0, 0.0),
        (30.0, 10.0),
        (10.0, 10.0),
        (10.0, 30.0),
        (0.0, 30.0),
    ];
    let moved: Vec<(f64, f64)> = pts.iter().map(|&(x, y)| (x - 15.0, y - 15.0)).collect();
    prism("l", &moved, 6.0)
}

/// A build item: which mesh, where its origin goes and its turn about Z, degrees.
struct Item<'a> {
    mesh: &'a str,
    at: (f64, f64),
    deg: f64,
}

fn item(mesh: &str, at: (f64, f64)) -> Item<'_> {
    Item { mesh, at, deg: 0.0 }
}

/// An extruding sparse infill move, mm.
#[derive(Debug, Clone, Copy)]
struct Seg {
    a: (f64, f64),
    b: (f64, f64),
}

impl Seg {
    fn len(&self) -> f64 {
        (self.b.0 - self.a.0).hypot(self.b.1 - self.a.1)
    }

    fn moved(&self, d: (f64, f64)) -> Self {
        Self {
            a: (self.a.0 - d.0, self.a.1 - d.1),
            b: (self.b.0 - d.0, self.b.1 - d.1),
        }
    }
}

/// The sparse infill moves of each layer, by z ("3.00").
type Sparse = BTreeMap<String, Vec<Seg>>;

fn slice(meshes: &[(&str, MeshPart)], items: &[Item<'_>], config: &Value) -> Sparse {
    let meshes: BTreeMap<String, Arc<Mesh>> = meshes
        .iter()
        .map(|(id, part)| {
            (
                (*id).to_owned(),
                Arc::new(Mesh {
                    name: (*id).to_owned(),
                    parts: vec![part.clone()],
                    ..Mesh::default()
                }),
            )
        })
        .collect();
    let objects: Vec<Value> = items
        .iter()
        .map(|it| {
            let (s, c) = it.deg.to_radians().sin_cos();
            json!({
                "mesh": it.mesh,
                "transform": [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, it.at.0, it.at.1, 0, 1],
            })
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let run = api::run_request(&req, &move |id: &str| Ok(meshes[id].clone())).unwrap();
    let g = String::from_utf8(run.gcode).unwrap();
    let mut out = Sparse::new();
    let (mut feature, mut z, mut at) = (String::new(), String::new(), (0.0, 0.0));
    for line in g.lines() {
        if let Some(f) = line
            .strip_prefix("; FEATURE: ")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            f.trim().clone_into(&mut feature);
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
        if cmd == "G1" && e > 0.0 && to != at && feature == "Sparse infill" {
            out.entry(z.clone()).or_default().push(Seg { a: at, b: to });
        }
        at = to;
    }
    out
}

/// The sparse layers the tests read: well above the bottom shell and below the top shell of a 6 mm part.
const LAYERS: [&str; 4] = ["2.00", "3.00", "3.20", "3.40"];

fn layer<'a>(s: &'a Sparse, z: &str) -> &'a [Seg] {
    s.get(z)
        .map_or_else(|| panic!("no sparse infill at z {z}"), Vec::as_slice)
}

/// How far the sparse lines along `deg` (longer than 1 mm) sit off the lattice `c + k * pitch` across them, at
/// worst, mm, and how many lines that is. Only the moves with `keep` are read.
fn off_lattice(
    segs: &[Seg],
    c: (f64, f64),
    deg: f64,
    pitch: f64,
    keep: &dyn Fn(&Seg) -> bool,
) -> (f64, usize) {
    let (s, co) = deg.to_radians().sin_cos();
    let n = (-s, co);
    let mut worst = 0.0_f64;
    let mut offsets: Vec<f64> = Vec::new();
    for g in segs.iter().filter(|g| keep(g) && g.len() > 1.0) {
        let a = (g.b.1 - g.a.1)
            .atan2(g.b.0 - g.a.0)
            .to_degrees()
            .rem_euclid(180.0);
        let d = (a - deg.rem_euclid(180.0)).abs();
        if d.min(180.0 - d) > 0.5 {
            continue;
        }
        let p = n.0 * (f64::midpoint(g.a.0, g.b.0) - c.0) + n.1 * (f64::midpoint(g.a.1, g.b.1) - c.1);
        let r = p / pitch;
        worst = worst.max((r - r.round()).abs() * pitch);
        if !offsets.iter().any(|q| (q - p).abs() < 0.05) {
            offsets.push(p);
        }
    }
    (worst, offsets.len())
}

/// Asserts the lines along each of `degs` on layer `z` lie on the lattice through `c` at `pitch`.
fn assert_through(
    what: &str,
    s: &Sparse,
    z: &str,
    c: (f64, f64),
    degs: &[f64],
    pitch: f64,
    keep: &dyn Fn(&Seg) -> bool,
) {
    for &deg in degs {
        let (worst, lines) = off_lattice(layer(s, z), c, deg, pitch, keep);
        assert!(lines >= 3, "{what}: z {z}, {deg} degrees: only {lines} lines");
        assert!(
            worst < TOL,
            "{what}: z {z}, the {deg} degree lines sit up to {worst:.3} mm off the lattice through ({:.3}, {:.3}) \
             (pitch {pitch:.4})",
            c.0,
            c.1
        );
    }
}

fn dist_to_seg(p: (f64, f64), g: &Seg) -> f64 {
    let (dx, dy) = (g.b.0 - g.a.0, g.b.1 - g.a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 == 0.0 {
        0.0
    } else {
        (((p.0 - g.a.0) * dx + (p.1 - g.a.1) * dy) / l2).clamp(0.0, 1.0)
    };
    (p.0 - g.a.0 - t * dx).hypot(p.1 - g.a.1 - t * dy)
}

/// Points every 0.2 mm along `a`'s moves within `hw` of the origin against `b`'s moves: the largest distance to
/// the nearest move, both ways, mm.
fn apart(a: &[Seg], b: &[Seg], hw: f64) -> f64 {
    let one_way = |a: &[Seg], b: &[Seg]| -> f64 {
        let mut worst = 0.0_f64;
        for g in a {
            let n = ((g.len() / 0.2) as usize).max(1);
            for i in 0..=n {
                let t = i as f64 / n as f64;
                let p = (g.a.0 + (g.b.0 - g.a.0) * t, g.a.1 + (g.b.1 - g.a.1) * t);
                if p.0.abs() > hw || p.1.abs() > hw {
                    continue;
                }
                let d = b.iter().map(|q| dist_to_seg(p, q)).fold(f64::MAX, f64::min);
                worst = worst.max(d);
            }
        }
        worst
    };
    one_way(a, b).max(one_way(b, a))
}

/// Asserts the sparse infill of `here` (C at `ch`) and `there` (C at `ct`) is the same relative to C on every
/// layer read, within `hw` of C.
fn assert_same(what: &str, here: &Sparse, ch: (f64, f64), there: &Sparse, ct: (f64, f64), hw: f64) {
    for z in LAYERS {
        let a: Vec<Seg> = layer(here, z).iter().map(|g| g.moved(ch)).collect();
        let b: Vec<Seg> = layer(there, z).iter().map(|g| g.moved(ct)).collect();
        let d = apart(&a, &b, hw);
        assert!(
            d < TOL,
            "{what}: z {z}: the sparse infill differs by up to {d:.3} mm relative to the object's center"
        );
    }
}

/// The stock MK4 prints crosshatch: at the bed center it is the drawing anchored at the object's center (the
/// same as with that center on the plate origin). It used to hang off the plate origin, 0.33 mm off.
#[test]
fn stock_crosshatch_on_the_mk4_hangs_off_the_object_center() {
    let cfg = mk4(&json!({}));
    assert_eq!(cfg["sparse_infill_pattern"], "crosshatch");
    let sq = [("sq", block(20.0, 20.0))];
    let c = bed_center(&cfg);
    let middle = slice(&sq, &[item("sq", c)], &cfg);
    let origin = slice(&sq, &[item("sq", (0.0, 0.0))], &centered_bed(&cfg));
    assert_same("MK4 crosshatch", &middle, c, &origin, (0.0, 0.0), 7.0);
}

/// The stock Voron 2.4 300 prints crosshatch too: 0.75 mm off at the bed center before.
#[test]
fn stock_crosshatch_on_the_voron_hangs_off_the_object_center() {
    let cfg = voron(&json!({}));
    assert_eq!(cfg["sparse_infill_pattern"], "crosshatch");
    let sq = [("sq", block(20.0, 20.0))];
    let c = bed_center(&cfg);
    let middle = slice(&sq, &[item("sq", c)], &cfg);
    let origin = slice(&sq, &[item("sq", (0.0, 0.0))], &centered_bed(&cfg));
    assert_same("Voron crosshatch", &middle, c, &origin, (0.0, 0.0), 7.0);
}

/// Rectilinear (Bambu Lab's zig-zag) on an object off the bed center: every line passes through the object's
/// center, 45 degrees on even layers and 135 on odd ones.
#[test]
fn rectilinear_lines_pass_through_the_center_of_an_object_off_center() {
    for (name, cfg) in [
        ("MK4", mk4(&json!({"sparse_infill_pattern": "rectilinear"}))),
        ("Voron", voron(&json!({"sparse_infill_pattern": "rectilinear"}))),
        ("A1", a1(&json!({"sparse_infill_pattern": "zig-zag"}))),
    ] {
        let b = bed_center(&cfg);
        let c = (b.0 + 0.5, b.1 + 0.7);
        let s = slice(&[("sq", block(20.0, 20.0))], &[item("sq", c)], &cfg);
        let pitch = sparse_spacing(&cfg) / density(&cfg);
        assert_through(name, &s, "3.00", c, &[45.0], pitch, &|_| true);
        assert_through(name, &s, "3.20", c, &[135.0], pitch, &|_| true);
    }
}

/// Two objects on one plate: each object's lines pass through its own center, not the center of both.
#[test]
fn two_objects_each_hang_off_their_own_center() {
    let meshes = [("a", block(12.0, 12.0)), ("b", block(13.0, 12.0))];
    for (name, cfg, degs, sets) in [
        (
            "MK4 rectilinear",
            mk4(&json!({"sparse_infill_pattern": "rectilinear"})),
            [[45.0].as_slice(), [135.0].as_slice()],
            1.0,
        ),
        (
            "A1 grid at 40 percent",
            a1(&json!({"sparse_infill_density": 40})),
            [[45.0, 135.0].as_slice(), [45.0, 135.0].as_slice()],
            2.0,
        ),
    ] {
        let b = bed_center(&cfg);
        let (ca, cb) = ((b.0 - 15.0, b.1 - 2.65), (b.0 + 15.0, b.1 + 2.65));
        let s = slice(&meshes, &[item("a", ca), item("b", cb)], &cfg);
        let pitch = sets * sparse_spacing(&cfg) / density(&cfg);
        for (z, degs) in ["3.00", "3.20"].into_iter().zip(degs) {
            assert_through(&format!("{name}, left"), &s, z, ca, degs, pitch, &|g| g.a.0 < b.0);
            assert_through(&format!("{name}, right"), &s, z, cb, degs, pitch, &|g| {
                g.a.0 > b.0
            });
        }
    }
}

/// Two copies of one object: each copy's lines pass through its own center.
#[test]
fn copies_each_hang_off_their_own_center() {
    for (name, cfg, degs, sets) in [
        (
            "MK4 rectilinear",
            mk4(&json!({"sparse_infill_pattern": "rectilinear"})),
            [[45.0].as_slice(), [135.0].as_slice()],
            1.0,
        ),
        (
            "A1 grid",
            a1(&json!({})),
            [[45.0, 135.0].as_slice(), [45.0, 135.0].as_slice()],
            2.0,
        ),
    ] {
        let b = bed_center(&cfg);
        let (ca, cb) = ((b.0 - 13.65, b.1 - 2.05), (b.0 + 13.65, b.1 + 2.05));
        let s = slice(
            &[("sq", block(20.0, 20.0))],
            &[item("sq", ca), item("sq", cb)],
            &cfg,
        );
        let pitch = sets * sparse_spacing(&cfg) / density(&cfg);
        for (z, degs) in ["3.00", "3.20"].into_iter().zip(degs) {
            assert_through(&format!("{name}, first copy"), &s, z, ca, degs, pitch, &|g| {
                g.a.0 < b.0
            });
            assert_through(&format!("{name}, second copy"), &s, z, cb, degs, pitch, &|g| {
                g.a.0 > b.0
            });
        }
    }
}

/// An L turned 30 degrees about Z by its build item: the lines pass through the center of the turned outline's
/// box in plate axes, not through the item's origin (the middle of the L's own box).
#[test]
fn an_object_turned_about_z_hangs_off_its_turned_box() {
    let cfg = mk4(&json!({"sparse_infill_pattern": "rectilinear"}));
    let b = bed_center(&cfg);
    let at = (b.0 + 0.5, b.1);
    let l = l_shape();
    let (s30, c30) = 30.0_f64.to_radians().sin_cos();
    let (mut lo, mut hi) = ((f64::MAX, f64::MAX), (f64::MIN, f64::MIN));
    for p in &l.positions {
        let (x, y) = (f64::from(p[0]), f64::from(p[1]));
        let (u, v) = (at.0 + x * c30 - y * s30, at.1 + x * s30 + y * c30);
        lo = (lo.0.min(u), lo.1.min(v));
        hi = (hi.0.max(u), hi.1.max(v));
    }
    let c = (f64::midpoint(lo.0, hi.0), f64::midpoint(lo.1, hi.1));
    let s = slice(
        &[("l", l)],
        &[Item {
            mesh: "l",
            at,
            deg: 30.0,
        }],
        &cfg,
    );
    let pitch = sparse_spacing(&cfg) / density(&cfg);
    assert_through("turned L", &s, "3.00", c, &[45.0], pitch, &|_| true);
    assert_through("turned L", &s, "3.20", c, &[135.0], pitch, &|_| true);
}

/// The gyroid on printers other than Bambu Lab's: its lattice origin is the object's center less ten spacings,
/// so the object at the bed center gets the gyroid it gets with its center on the plate origin.
#[test]
fn gyroid_hangs_off_the_object_center_less_ten_spacings() {
    let cfg = mk4(&json!({"sparse_infill_pattern": "gyroid"}));
    let sq = [("sq", block(20.0, 20.0))];
    let c = bed_center(&cfg);
    let middle = slice(&sq, &[item("sq", c)], &cfg);
    let origin = slice(&sq, &[item("sq", (0.0, 0.0))], &centered_bed(&cfg));
    assert_same("MK4 gyroid", &middle, c, &origin, (0.0, 0.0), 7.0);
}

/// The gyroid on Bambu Lab printers: its lattice origin is the object's center itself, so the object at the bed
/// center gets the gyroid it gets with its center ten spacings below and left of the plate origin.
#[test]
fn gyroid_hangs_off_the_object_center_on_bambu_printers() {
    let cfg = a1(&json!({"sparse_infill_pattern": "gyroid"}));
    let sq = [("sq", block(20.0, 20.0))];
    let c = bed_center(&cfg);
    let middle = slice(&sq, &[item("sq", c)], &cfg);
    let ten = -10.0 * sparse_spacing(&cfg);
    let origin = slice(&sq, &[item("sq", (ten, ten))], &centered_bed(&cfg));
    assert_same("A1 gyroid", &middle, c, &origin, (ten, ten), 7.0);
}

/// The other patterns drawn from a fixed point move with the object: moved by (0.5, 0.7) mm, the infill is the
/// same relative to the object's center.
#[test]
fn lattice_patterns_move_with_the_object() {
    let sq = [("sq", block(20.0, 20.0))];
    for pattern in [
        "alignedrectilinear",
        "zigzag",
        "crosszag",
        "lockedzag",
        "honeycomb",
        "3dhoneycomb",
    ] {
        let cfg = mk4(&json!({"sparse_infill_pattern": pattern}));
        let b = bed_center(&cfg);
        let moved = (b.0 + 0.5, b.1 + 0.7);
        let here = slice(&sq, &[item("sq", b)], &cfg);
        let there = slice(&sq, &[item("sq", moved)], &cfg);
        assert_same(pattern, &here, b, &there, moved, 7.0);
    }
}

fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// With the object's center on the plate origin nothing moves: there the old plate anchor and the object's
/// center are one point, and sx's lines already were the expected ones. The sparse infill of each pattern keeps
/// its exact moves (a hash of the moves at z 3.0 and 3.2; MK4 settings, so the gyroid keeps its ten spacings).
#[test]
fn patterns_on_the_plate_origin_keep_their_lines() {
    let sq = [("sq", block(20.0, 20.0))];
    let mut got = Vec::new();
    for pattern in [
        "rectilinear",
        "zigzag",
        "crosszag",
        "lockedzag",
        "honeycomb",
        "crosshatch",
        "gyroid",
    ] {
        let cfg = centered_bed(&mk4(&json!({"sparse_infill_pattern": pattern})));
        let s = slice(&sq, &[item("sq", (0.0, 0.0))], &cfg);
        let mut text = String::new();
        for z in ["3.00", "3.20"] {
            for g in layer(&s, z) {
                writeln!(text, "{:.3} {:.3} {:.3} {:.3}", g.a.0, g.a.1, g.b.0, g.b.1).unwrap();
            }
        }
        got.push(format!("{pattern} {}", fnv(&text)));
    }
    let want: Vec<String> = [
        "rectilinear d753e3ce4342e28d",
        "zigzag d753e3ce4342e28d",
        "crosszag 42450abb85286eeb",
        "lockedzag afe8ea999e1af7a9",
        "honeycomb a5939d2f1d893dfb",
        "crosshatch 7002a5f278ef77d3",
        "gyroid 09d220be44042070",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    assert_eq!(got, want);
}
