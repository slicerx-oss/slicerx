// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where internal solid infill goes on a Bambu Lab printer: the shell layer counts, the first solid layer over sparse
//! infill (a bridge), the band a leaning wall leaves under a top or over a bottom (kept from 0.79 solid line
//! spacings wide), `ensure_vertical_shell_thickness` and `minimum_sparse_infill_area`.
//!
//! Our own shapes on the shipped P1S settings (0.20 mm Standard, fixed layers, no brim): a 30 x 30 x 10 mm box,
//! frustums of r 15 mm at the bed whose radius shrinks d mm a layer for 60 layers, frustums of r 8 mm that grow,
//! a cone (r 15 to 5 mm, 20 mm tall), a hemisphere of r 15 mm and 6 mm square columns. "Mid-layer solid" is the
//! internal solid infill plus the floating vertical shell (filament mm) on layers 8 to 49, counted from 0.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    reason = "a G-code reader for the test: filament lengths in mm"
)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

type Shape = (Vec<[f32; 3]>, Vec<[u32; 3]>);

const SOLID: &str = "Internal solid infill";
const FLOATING: &str = "Floating vertical shell";

fn read(path: &str) -> Value {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    serde_json::from_slice(&std::fs::read(format!("{root}/{path}")).unwrap()).unwrap()
}

/// The shipped P1S printer, PLA and 0.20 mm Standard process over the settings defaults, with fixed layers, no
/// brim, grid sparse infill and zig-zag internal solid infill, then `extra`.
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
        "smart_layer": "off",
        "brim_type": "no_brim",
        "skirt_loops": 0,
        "enable_prime_tower": false,
        "sparse_infill_pattern": "grid",
        "sparse_infill_density": "15%",
        "internal_solid_infill_pattern": "zig-zag",
    });
    c.extend(fixed.as_object().unwrap().clone());
    c.extend(extra.as_object().unwrap().clone());
    Value::Object(c)
}

/// The "s" settings: 4 top layers with a 1 mm top shell, 3 bottom layers with 0.6 mm, 3 arachne walls, 0.6 mm outer
/// and 0.5 mm inner, sparse and internal solid lines, 12% 3D honeycomb, monotonic internal solid infill.
fn s_set(extra: &Value) -> Value {
    let mut c = json!({
        "top_shell_layers": 4, "top_shell_thickness": 1, "bottom_shell_layers": 3, "bottom_shell_thickness": 0.6,
        "wall_loops": 3, "wall_generator": "arachne", "outer_wall_line_width": 0.6, "inner_wall_line_width": 0.5,
        "sparse_infill_line_width": 0.5, "internal_solid_infill_line_width": 0.5, "top_surface_line_width": 0.4,
        "sparse_infill_pattern": "3dhoneycomb", "sparse_infill_density": "12%",
        "internal_solid_infill_pattern": "monotonic", "top_surface_pattern": "concentric",
        "infill_wall_overlap": "20%", "internal_bridge_support_thickness": 0,
    });
    c.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    c
}

fn narrow_off(extra: &Value) -> Value {
    let mut c = json!({"detect_narrow_internal_solid_infill": false});
    c.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    c
}

/// A solid of revolution centered on the plate, 96 sides, from (radius, z) pairs bottom to top; a radius of 0 is an
/// apex. Open ends are capped.
fn revolve(profile: &[(f32, f32)]) -> Shape {
    const SIDES: u32 = 96;
    let mut positions = Vec::new();
    let mut rings: Vec<Vec<u32>> = Vec::new();
    for &(r, z) in profile {
        let first = positions.len() as u32;
        if r <= 0.0 {
            positions.push([128.0, 128.0, z]);
            rings.push(vec![first]);
            continue;
        }
        for i in 0..SIDES {
            let a = std::f32::consts::TAU * i as f32 / SIDES as f32;
            positions.push([128.0 + r * a.cos(), 128.0 + r * a.sin(), z]);
        }
        rings.push((first..first + SIDES).collect());
    }
    let mut triangles = Vec::new();
    for pair in rings.windows(2) {
        let (lo, hi) = (&pair[0], &pair[1]);
        for i in 0..SIDES as usize {
            let j = (i + 1) % SIDES as usize;
            if hi.len() == 1 {
                triangles.push([lo[i], lo[j], hi[0]]);
            } else {
                triangles.push([lo[i], lo[j], hi[j]]);
                triangles.push([lo[i], hi[j], hi[i]]);
            }
        }
    }
    for (ring, up) in [(rings.first().unwrap(), false), (rings.last().unwrap(), true)] {
        if ring.len() == 1 {
            continue;
        }
        let c = positions.len() as u32;
        let z = positions[ring[0] as usize][2];
        positions.push([128.0, 128.0, z]);
        for i in 0..ring.len() {
            let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
            triangles.push(if up { [c, a, b] } else { [c, b, a] });
        }
    }
    (positions, triangles)
}

/// A box of `w` by `w` mm and `h` mm tall, centered on the plate.
fn square(w: f32, h: f32) -> Shape {
    let (lo, hi) = (128.0 - w / 2.0, 128.0 + w / 2.0);
    let mut positions = Vec::new();
    for z in [0.0, h] {
        for (x, y) in [(lo, lo), (hi, lo), (hi, hi), (lo, hi)] {
            positions.push([x, y, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    (positions, triangles)
}

fn flat() -> Shape {
    square(30.0, 10.0)
}

/// A frustum of r `r0` mm at the bed whose radius changes by `d` mm a layer (less when `d` is positive), 60 layers.
fn frustum(r0: f32, d: f32) -> Shape {
    revolve(&[(r0, 0.0), (r0 - 60.0 * d, 12.0)])
}

fn dome() -> Shape {
    let n = 60;
    let mut p: Vec<(f32, f32)> = (0..n)
        .map(|i| {
            let a = std::f32::consts::FRAC_PI_2 * i as f32 / n as f32;
            (15.0 * a.cos(), 15.0 * a.sin())
        })
        .collect();
    p.push((0.0, 15.0));
    revolve(&p)
}

/// Filament (mm) per layer (counted from 0) and feature.
struct Read {
    e: BTreeMap<u32, BTreeMap<String, f64>>,
    labels: Vec<String>,
}

impl Read {
    fn at(&self, layer: u32, feature: &str) -> f64 {
        self.e
            .get(&layer)
            .and_then(|f| f.get(feature))
            .copied()
            .unwrap_or(0.0)
    }

    fn total(&self, feature: &str) -> f64 {
        self.e.keys().map(|l| self.at(*l, feature)).sum()
    }

    /// Internal solid infill and floating vertical shell on `layer`.
    fn solid_at(&self, layer: u32) -> f64 {
        self.at(layer, SOLID) + self.at(layer, FLOATING)
    }

    fn solid(&self) -> f64 {
        self.e.keys().map(|l| self.solid_at(*l)).sum()
    }

    fn mid(&self) -> f64 {
        (8..=49).map(|l| self.solid_at(l)).sum()
    }

    /// The layers with more than `min` mm of internal solid infill and floating vertical shell.
    fn solid_layers(&self, min: f64) -> Vec<u32> {
        self.e
            .keys()
            .copied()
            .filter(|l| self.solid_at(*l) > min)
            .collect()
    }
}

fn slice(shape: Shape, config: &Value) -> (String, Read) {
    let (positions, triangles) = shape;
    let mesh = Arc::new(Mesh {
        name: "m".into(),
        parts: vec![MeshPart {
            name: "m".into(),
            slot: 1,
            positions,
            triangles,
            ..MeshPart::default()
        }],
        ..Mesh::default()
    });
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "m"}]},
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    let mut r = Read {
        e: BTreeMap::new(),
        labels: Vec::new(),
    };
    let (mut layer, mut started, mut feature) = (0u32, false, String::new());
    for line in g.lines() {
        if line.starts_with("; CHANGE_LAYER") || line.starts_with(";LAYER_CHANGE") {
            if started {
                layer += 1;
            }
            started = true;
        }
        if let Some(f) = line
            .strip_prefix("; FEATURE: ")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            f.trim().clone_into(&mut feature);
            if !r.labels.contains(&feature) {
                r.labels.push(feature.clone());
            }
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        if !(code.starts_with("G1 ") || code.starts_with("G2 ") || code.starts_with("G3 ")) {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        if word('X').is_none() && word('Y').is_none() {
            continue;
        }
        if let Some(e) = word('E').filter(|e| *e > 0.0) {
            *r.e.entry(layer).or_default().entry(feature.clone()).or_default() += e;
        }
    }
    (g, r)
}

fn within(got: f64, want: f64, share: f64) -> bool {
    (got - want).abs() <= want * share
}

/// The layers whose top or internal solid, bridge or bottom fill covers most of the 30 mm box.
fn shell_layers(r: &Read) -> Vec<u32> {
    r.e.keys()
        .copied()
        .filter(|l| {
            [SOLID, "Top surface", "Bottom surface", "Bridge"]
                .iter()
                .map(|f| r.at(*l, f))
                .sum::<f64>()
                > 40.0
        })
        .collect()
}

#[test]
fn shell_layers_are_the_larger_of_the_count_and_the_thickness() {
    // The printer maker's slicer: 2 layers and 0.65 mm make 4 top layers, 2 and 0.61 mm make 4 bottom layers, 6 and
    // 0.6 mm stay 6.
    let (_, r) = slice(
        flat(),
        &settings(&json!({"top_shell_layers": 2, "top_shell_thickness": 0.65})),
    );
    let top: Vec<u32> = shell_layers(&r).into_iter().filter(|l| *l > 10).collect();
    assert_eq!(top, vec![46, 47, 48, 49]);
    let (_, r) = slice(
        flat(),
        &settings(&json!({"bottom_shell_layers": 2, "bottom_shell_thickness": 0.61})),
    );
    let bottom: Vec<u32> = shell_layers(&r).into_iter().filter(|l| *l < 10).collect();
    assert_eq!(bottom, vec![0, 1, 2, 3]);
    let (_, r) = slice(
        flat(),
        &settings(&json!({"top_shell_layers": 6, "top_shell_thickness": 0.6})),
    );
    let top: Vec<u32> = shell_layers(&r).into_iter().filter(|l| *l > 10).collect();
    assert_eq!(top, vec![44, 45, 46, 47, 48, 49]);
}

#[test]
fn a_count_of_zero_prints_no_shell_whatever_the_thickness() {
    // No top surface, and the top 5 layers sparse; the maker's slicer prints 136.4 mm of solid, all at the bottom.
    let (_, r) = slice(
        flat(),
        &settings(&json!({"top_shell_layers": 0, "top_shell_thickness": 1})),
    );
    assert!(!r.labels.iter().any(|f| f == "Top surface"), "{:?}", r.labels);
    for l in 45..=49 {
        assert!(r.solid_at(l) + r.at(l, "Bridge") < 0.01, "layer {l} is solid");
        assert!(r.at(l, "Sparse infill") > 1.0, "layer {l} has no sparse infill");
    }
    assert_eq!(r.solid_layers(0.05), vec![1, 2]);
    assert!(within(r.solid(), 136.4, 0.05), "solid {:.1} mm", r.solid());

    // No bottom surface, and the first layer sparse.
    let (_, r) = slice(
        flat(),
        &settings(&json!({"bottom_shell_layers": 0, "bottom_shell_thickness": 1})),
    );
    assert!(!r.labels.iter().any(|f| f == "Bottom surface"), "{:?}", r.labels);
    assert!(r.at(0, "Sparse infill") > 1.0 && r.solid_at(0) < 0.01);
    assert!(
        r.solid_layers(0.05).iter().all(|l| *l >= 44),
        "{:?}",
        r.solid_layers(0.05)
    );
}

#[test]
fn the_first_solid_layer_over_sparse_infill_is_a_bridge() {
    // The maker's slicer: layer 45 `; FEATURE: Bridge` 93.2 mm, layers 46 to 48 internal solid 66.2 mm each.
    let (g, r) = slice(flat(), &settings(&json!({})));
    assert!(!g.contains("Internal Bridge"));
    assert!(
        within(r.at(45, "Bridge"), 93.2, 0.02),
        "bridge {:.1} mm",
        r.at(45, "Bridge")
    );
    for l in 46..=48 {
        assert!(
            within(r.at(l, SOLID), 66.2, 0.02),
            "layer {l}: {:.1} mm",
            r.at(l, SOLID)
        );
    }
}

/// Mid-layer solid of the r 15 mm frustum shrinking `d` mm a layer.
fn band(d: f32, config: &Value) -> f64 {
    slice(frustum(15.0, d), config).1.mid()
}

#[test]
fn a_leaning_wall_keeps_a_band_from_079_solid_line_spacings() {
    // The band under the top is (top layers - 1) x d wide. The maker's slicer keeps it from 0.79 to 0.80 solid line
    // spacings (spacing = line width - layer height x (1 - pi/4)): 0.42 mm lines from d 0.075 with 5 top layers and
    // from 0.100 with 4, 0.5 mm lines from 0.091, 0.6 mm lines from 0.115. A band that narrow prints as one line along
    // its middle: 97 mm on layers 8 to 49 at d 0.075 and 90.8 at 0.100 with 4 top layers.
    let base = |extra: Value| settings(&narrow_off(&extra));
    for (none, kept, config) in [
        (0.070, 0.075, base(json!({}))),
        (
            0.0985,
            0.100,
            base(json!({"top_shell_layers": 4, "top_shell_thickness": 0})),
        ),
        (
            0.110,
            0.115,
            base(json!({"internal_solid_infill_line_width": 0.6})),
        ),
        (0.090, 0.091, settings(&s_set(&narrow_off(&json!({}))))),
    ] {
        let (a, b) = (band(none, &config), band(kept, &config));
        assert!(a < 2.0, "d {none}: {a:.1} mm of band");
        assert!(b > 10.0, "d {kept}: {b:.1} mm of band");
    }
    let one = band(0.075, &base(json!({})));
    assert!(within(one, 97.0, 0.05), "d 0.075: {one:.1} mm");
    let four = band(
        0.100,
        &base(json!({"top_shell_layers": 4, "top_shell_thickness": 0})),
    );
    assert!(within(four, 90.8, 0.05), "d 0.100, 4 top layers: {four:.1} mm");
}

#[test]
fn the_band_threshold_ignores_the_walls() {
    // Narrow detection on (the default) keeps the band from 0.68 spacings, so none at d 0.064 and a band at 0.065,
    // also with a 0.6 mm outer wall, a 0.5 mm inner wall, 3 walls or arachne walls.
    for extra in [
        json!({}),
        json!({"outer_wall_line_width": 0.6}),
        json!({"inner_wall_line_width": 0.5}),
        json!({"wall_loops": 3}),
        json!({"wall_generator": "arachne"}),
    ] {
        let config = settings(&extra);
        let (a, b) = (band(0.064, &config), band(0.065, &config));
        assert!(a < 2.0, "{extra}: {a:.1} mm of band at d 0.064");
        assert!(b > 50.0, "{extra}: {b:.1} mm of band at d 0.065");
    }
}

#[test]
fn the_bottom_shell_band_counts_the_bottom_layers() {
    // A frustum of r 8 mm leaning out 0.15 mm a layer over 3 bottom layers: a 0.30 mm band with 0.42 mm lines,
    // none with 0.5 mm lines.
    let leaning = frustum(8.0, -0.15);
    assert!(slice(leaning.clone(), &settings(&narrow_off(&json!({})))).1.mid() > 10.0);
    assert!(slice(leaning, &settings(&s_set(&narrow_off(&json!({}))))).1.mid() < 0.01);
}

#[test]
fn a_dome_bands_from_where_its_wall_leans_enough() {
    // The maker's slicer: the first band layer is 29, and 270.1 mm of solid in all.
    let (_, r) = slice(dome(), &settings(&s_set(&narrow_off(&json!({})))));
    let first = r.solid_layers(0.05).into_iter().find(|l| *l >= 8);
    assert_eq!(first, Some(29));
    assert!(within(r.solid(), 270.1, 0.03), "{:.1} mm", r.solid());
}

#[test]
fn ensure_vertical_shell_thickness_takes_the_printer_makers_values() {
    let cone = || revolve(&[(15.0, 0.0), (5.0, 20.0)]);
    let ensure = |v: &str| settings(&json!({"ensure_vertical_shell_thickness": v}));
    // `enabled` is the full rule, as `ensure_all` is.
    let (_, r) = slice(cone(), &ensure("enabled"));
    assert!(r.mid() > 50.0);
    assert_eq!(r.e, slice(cone(), &ensure("ensure_all")).1.e);
    // `disabled` and `partial` keep the shells under and over the flat ends, without the band: 117.6 mm in all.
    for v in ["disabled", "partial"] {
        let (_, r) = slice(cone(), &ensure(v));
        assert!(r.mid() < 0.01, "{v}: {:.1} mm of band", r.mid());
        assert!(within(r.solid(), 117.6, 0.03), "{v}: {:.1} mm", r.solid());
        let (_, d) = slice(dome(), &ensure(v));
        let band: f64 = (8..=44).map(|l| d.solid_at(l)).sum();
        assert!(band < 0.01, "{v}: dome band {band:.1} mm");
    }
}

#[test]
fn a_small_sparse_pocket_is_measured_to_the_inner_walls_middle() {
    // 6 mm tall square columns, 2 walls: with 15 mm2 the 5.0 mm column is solid and the 5.5 mm one sparse; with
    // 30 mm2 the 6.5 mm column is solid and the 7.0 mm one sparse; with 0 none is solid.
    let sparse = |side: f32, area: f64| {
        let (_, r) = slice(
            square(side, 6.0),
            &settings(&json!({"minimum_sparse_infill_area": area})),
        );
        r.total("Sparse infill") > 1.0
    };
    assert!(!sparse(5.0, 15.0));
    assert!(sparse(5.5, 15.0));
    assert!(!sparse(6.5, 30.0));
    assert!(sparse(7.0, 30.0));
    assert!(sparse(5.0, 0.0));
}

#[test]
fn every_printer_takes_the_same_band_rule() {
    // On another printer too: with narrow detection on, the 0.28 mm band at d 0.070 (0.74 spacings) stays; with it
    // off, it goes.
    let other = json!({"printer_model": "Generic printer", "gcode_flavor": "marlin2"});
    assert!(band(0.070, &settings(&other)) > 10.0);
    assert!(band(0.070, &settings(&narrow_off(&other))) < 2.0);
}
