// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A Bambu Studio or `OrcaSlicer` project marks each part of an object as a printed part, a negative part, a
//! modifier, a support blocker or a support enforcer (`subtype` in `Metadata/model_settings.config`). The engine's
//! 3MF loader read every part as printed, so a cut printed as solid plastic, a modifier as an extra block, and
//! blockers and enforcers as blocks of their own. These slice small generated projects and check what each part
//! type does to the G-code.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test archives and meshes are tiny"
)]

use serde_json::json;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest, SliceRun};

/// A stored ZIP of the given entries.
fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let offset = out.len() as u32;
        let crc = crc32(data);
        for (dst, sig) in [(&mut out, 0x0403_4b50u32), (&mut central, 0x0201_4b50u32)] {
            dst.extend_from_slice(&sig.to_le_bytes());
            if sig == 0x0201_4b50 {
                dst.extend_from_slice(&20u16.to_le_bytes());
            }
            dst.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            dst.extend_from_slice(&crc.to_le_bytes());
            dst.extend_from_slice(&(data.len() as u32).to_le_bytes());
            dst.extend_from_slice(&(data.len() as u32).to_le_bytes());
            dst.extend_from_slice(&(name.len() as u16).to_le_bytes());
            dst.extend_from_slice(&0u16.to_le_bytes());
            if sig == 0x0201_4b50 {
                dst.extend_from_slice(&[0; 10]);
                dst.extend_from_slice(&offset.to_le_bytes());
            }
            dst.extend_from_slice(name.as_bytes());
        }
        out.extend_from_slice(data);
    }
    let at = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&at.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 == 1 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}

/// A closed triangle mesh: vertices and counterclockwise triangles.
type Solid = (Vec<[f32; 3]>, Vec<[u32; 3]>);

fn cuboid(lo: [f32; 3], hi: [f32; 3]) -> Solid {
    let v = (0..8)
        .map(|i| {
            [
                if i & 1 == 0 { lo[0] } else { hi[0] },
                if i & 2 == 0 { lo[1] } else { hi[1] },
                if i & 4 == 0 { lo[2] } else { hi[2] },
            ]
        })
        .collect();
    let t = vec![
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
    (v, t)
}

/// An upright prism of `n` sides about (cx, cy), radius `r`, from z0 to z1.
fn cylinder(cx: f32, cy: f32, r: f32, z0: f32, z1: f32, n: u32) -> Solid {
    let mut verts = Vec::new();
    for z in [z0, z1] {
        for side in 0..n {
            let angle = std::f32::consts::TAU * side as f32 / n as f32;
            verts.push([cx + r * angle.cos(), cy + r * angle.sin(), z]);
        }
    }
    verts.push([cx, cy, z0]);
    verts.push([cx, cy, z1]);
    let (bottom, top) = (2 * n, 2 * n + 1);
    let mut tris = Vec::new();
    for side in 0..n {
        let next = (side + 1) % n;
        tris.push([bottom, next, side]);
        tris.push([top, n + side, n + next]);
        tris.push([side, next, n + next]);
        tris.push([side, n + next, n + side]);
    }
    (verts, tris)
}

/// A Bambu-layout project of one object (id 100) whose parts are `parts` in order, each `(subtype, solid,
/// extra part metadata)`, with `object_meta` as the object's own metadata.
fn project(parts: &[(&str, Solid, &str)], object_meta: &str) -> Vec<u8> {
    let mut objects = String::new();
    let mut comps = String::new();
    let mut settings = String::new();
    for (i, (subtype, (verts, tris), meta)) in parts.iter().enumerate() {
        let id = i + 1;
        let vs: String = verts
            .iter()
            .map(|p| format!(r#"<vertex x="{}" y="{}" z="{}"/>"#, p[0], p[1], p[2]))
            .collect();
        let ts: String = tris
            .iter()
            .map(|tri| format!(r#"<triangle v1="{}" v2="{}" v3="{}"/>"#, tri[0], tri[1], tri[2]))
            .collect();
        objects.push_str(&format!(
            r#"<object id="{id}" type="model"><mesh><vertices>{vs}</vertices><triangles>{ts}</triangles></mesh></object>"#
        ));
        comps.push_str(&format!(
            r#"<component p:path="/3D/Objects/object_1.model" objectid="{id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>"#
        ));
        settings.push_str(&format!(
            r#"<part id="{id}" subtype="{subtype}"><metadata key="name" value="p{id}"/>{meta}</part>"#
        ));
    }
    let sub = format!(r#"<model unit="millimeter"><resources>{objects}</resources></model>"#);
    let main = format!(
        r#"<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"><resources><object id="100" type="model"><components>{comps}</components></object></resources><build><item objectid="100"/></build></model>"#
    );
    let config = format!(r#"<config><object id="100">{object_meta}{settings}</object></config>"#);
    zip(&[
        ("3D/3dmodel.model", main.as_bytes()),
        ("3D/Objects/object_1.model", sub.as_bytes()),
        ("Metadata/model_settings.config", config.as_bytes()),
    ])
}

fn meta(key: &str, value: &str) -> String {
    format!(r#"<metadata key="{key}" value="{value}"/>"#)
}

/// Slices the project's only plate at (100, 100) (the object's printed parts start there), with `config` over the
/// tests' base settings.
fn slice(bytes: &[u8], config: serde_json::Value) -> sx_core::Result<SliceRun> {
    let mesh = Arc::new(Mesh::load(bytes, "part-types.3mf")?);
    let mut config = config;
    if let Some(c) = config.as_object_mut() {
        c.entry("brim_width").or_insert(json!(0));
        c.entry("brim_type").or_insert(json!("no_brim"));
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{ "id": "a", "mesh": "x", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1] }] },
        "config": config,
        "options": {}
    }))
    .expect("request");
    common::run_request(&req, &move |_: &str| Ok(mesh.clone()))
}

/// One extruding move: feature, layer z, start and end.
struct Move {
    feature: String,
    z: f64,
    a: [f64; 2],
    b: [f64; 2],
}

impl Move {
    fn len(&self) -> f64 {
        (self.b[0] - self.a[0]).hypot(self.b[1] - self.a[1])
    }

    fn mid(&self) -> [f64; 2] {
        [
            f64::midpoint(self.a[0], self.b[0]),
            f64::midpoint(self.a[1], self.b[1]),
        ]
    }
}

/// The extruding moves of a print, without the start and end sequences.
fn moves(run: &SliceRun) -> Vec<Move> {
    let text = String::from_utf8_lossy(&run.gcode);
    let (mut x, mut y, mut z) = (0.0f64, 0.0f64, 0.0f64);
    let mut feature = String::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(f) = line
            .strip_prefix(";TYPE:")
            .or_else(|| line.strip_prefix("; FEATURE: "))
        {
            feature = f.trim().to_owned();
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        let mut words = code.split_whitespace();
        let Some(cmd) = words.next() else { continue };
        if cmd != "G1" && cmd != "G0" {
            continue;
        }
        let (mut nx, mut ny, mut nz, mut extruded) = (x, y, z, 0.0);
        for word in words {
            let (axis, val) = word.split_at(1);
            let Ok(val) = val.parse::<f64>() else { continue };
            match axis {
                "X" => nx = val,
                "Y" => ny = val,
                "Z" => nz = val,
                "E" => extruded = val,
                _ => {}
            }
        }
        if extruded > 0.0 && feature != "Custom" && !feature.is_empty() && (nx - x).hypot(ny - y) > 0.0 {
            out.push(Move {
                feature: feature.clone(),
                z: nz,
                a: [x, y],
                b: [nx, ny],
            });
        }
        (x, y, z) = (nx, ny, nz);
    }
    out
}

fn is_support(m: &Move) -> bool {
    m.feature.starts_with("Support")
}

fn warnings(run: &SliceRun) -> Vec<String> {
    run.report.warnings.iter().map(|w| w.message.clone()).collect()
}

const CUBE: ([f32; 3], [f32; 3]) = ([0.0, 0.0, 0.0], [20.0, 20.0, 20.0]);

#[test]
fn a_negative_part_cuts_a_hole_through_the_cube_in_either_order() {
    let cube = || cuboid(CUBE.0, CUBE.1);
    let pin = || cylinder(10.0, 10.0, 4.0, -1.0, 21.0, 48);
    for (name, parts) in [
        (
            "after",
            vec![("normal_part", cube(), ""), ("negative_part", pin(), "")],
        ),
        // Listed before the part it cuts: the cut still applies.
        (
            "before",
            vec![("negative_part", pin(), ""), ("normal_part", cube(), "")],
        ),
    ] {
        let run = slice(&project(&parts, ""), json!({})).expect(name);
        let ms = moves(&run);
        assert!(!ms.is_empty(), "{name}: the cube prints");
        // The hole is centered at (110, 110) on the plate; nothing prints within 3 mm of its axis.
        let inside = ms.iter().filter(|m| {
            let p = m.mid();
            (p[0] - 110.0).hypot(p[1] - 110.0) < 3.0
        });
        assert_eq!(inside.count(), 0, "{name}: plastic inside the negative part");
        // The hole has walls of its own around 4 mm out.
        let hole_wall = ms
            .iter()
            .filter(|m| m.feature.contains("wall") && m.z > 5.0 && m.z < 15.0)
            .any(|m| ((m.mid()[0] - 110.0).hypot(m.mid()[1] - 110.0) - 4.2).abs() < 0.6);
        assert!(hole_wall, "{name}: the hole is walled");
    }
}

#[test]
fn a_modifier_changes_the_infill_only_inside_the_part() {
    let parts = [
        (
            "normal_part",
            cuboid([0.0, 0.0, 0.0], [30.0, 30.0, 20.0]),
            String::new(),
        ),
        (
            "modifier_part",
            cuboid([-1.0, -1.0, -1.0], [15.0, 31.0, 21.0]),
            meta("sparse_infill_density", "80%"),
        ),
    ];
    let parts: Vec<(&str, Solid, &str)> = parts
        .iter()
        .map(|(s, m, x)| (*s, m.clone(), x.as_str()))
        .collect();
    let run = slice(&project(&parts, ""), json!({ "sparse_infill_density": "15%" })).unwrap();
    let ms = moves(&run);
    // Sparse infill on the middle layers, left of the modifier's edge (x < 115) and right of it.
    let infill = |left: bool| -> f64 {
        ms.iter()
            .filter(|m| m.feature == "Sparse infill" && m.z > 5.0 && m.z < 15.0)
            .filter(|m| {
                if left {
                    m.mid()[0] < 113.0
                } else {
                    m.mid()[0] > 117.0
                }
            })
            .map(Move::len)
            .sum()
    };
    let (l, r) = (infill(true), infill(false));
    assert!(r > 0.0, "the right half has its 15% infill");
    assert!(
        l > 3.0 * r,
        "the modifier's half is denser: {l:.0} mm against {r:.0} mm"
    );
    // The modifier prints nothing of its own: no extrusion outside the 30 mm part.
    assert!(
        ms.iter().all(|m| m.a[0] > 99.0 && m.b[0] > 99.0),
        "nothing prints left of the part"
    );
}

#[test]
fn modifiers_and_support_volumes_outside_the_part_add_nothing() {
    let plain = slice(
        &project(&[("normal_part", cuboid(CUBE.0, CUBE.1), "")], ""),
        json!({}),
    )
    .unwrap();
    let parts = [
        ("normal_part", cuboid(CUBE.0, CUBE.1), String::new()),
        // Beside the cube, and over its top reaching 10 mm above it.
        (
            "modifier_part",
            cuboid([30.0, 0.0, 0.0], [40.0, 10.0, 10.0]),
            meta("wall_loops", "5"),
        ),
        (
            "modifier_part",
            cuboid([25.0, 25.0, 15.0], [35.0, 35.0, 30.0]),
            meta("wall_loops", "5"),
        ),
        (
            "support_blocker",
            cuboid([30.0, 20.0, 0.0], [40.0, 30.0, 10.0]),
            String::new(),
        ),
        (
            "support_enforcer",
            cuboid([-20.0, 0.0, 0.0], [-10.0, 10.0, 25.0]),
            String::new(),
        ),
    ];
    let parts: Vec<(&str, Solid, &str)> = parts
        .iter()
        .map(|(s, m, x)| (*s, m.clone(), x.as_str()))
        .collect();
    let run = slice(&project(&parts, ""), json!({})).unwrap();
    assert_eq!(
        run.report.layer_count, plain.report.layer_count,
        "a modifier above the top adds no layers"
    );
    let ms = moves(&run);
    let (lo, hi) = ms
        .iter()
        .flat_map(|m| [m.a, m.b])
        .fold(([f64::MAX; 2], [f64::MIN; 2]), |(lo, hi), p| {
            (
                [lo[0].min(p[0]), lo[1].min(p[1])],
                [hi[0].max(p[0]), hi[1].max(p[1])],
            )
        });
    assert!(
        lo[0] > 99.0 && lo[1] > 99.0 && hi[0] < 121.0 && hi[1] < 121.0,
        "prints only the cube: {lo:?} {hi:?}"
    );
    assert_eq!(moves(&plain).len(), ms.len(), "the cube prints as it does alone");
}

/// A T: a 10 x 10 x 10 mm column under a 40 x 10 x 2 mm slab, so each arm overhangs 15 mm.
fn tee() -> Vec<(&'static str, Solid, String)> {
    vec![
        (
            "normal_part",
            cuboid([15.0, 0.0, 0.0], [25.0, 10.0, 10.0]),
            String::new(),
        ),
        (
            "normal_part",
            cuboid([0.0, 0.0, 10.0], [40.0, 10.0, 12.0]),
            String::new(),
        ),
    ]
}

/// Support printed under the left arm and under the right arm (plate x below 112 and above 128).
fn support_sides(run: &SliceRun) -> (f64, f64) {
    let ms = moves(run);
    let side = |left: bool| {
        ms.iter()
            .filter(|m| is_support(m))
            .filter(|m| {
                if left {
                    m.mid()[0] < 112.0
                } else {
                    m.mid()[0] > 128.0
                }
            })
            .map(Move::len)
            .sum::<f64>()
    };
    (side(true), side(false))
}

fn with(mut parts: Vec<(&'static str, Solid, String)>, more: &[(&'static str, Solid)]) -> Vec<u8> {
    parts.extend(more.iter().map(|(s, m)| (*s, m.clone(), String::new())));
    let parts: Vec<(&str, Solid, &str)> = parts
        .iter()
        .map(|(s, m, x)| (*s, m.clone(), x.as_str()))
        .collect();
    project(&parts, "")
}

const LEFT_ARM: ([f32; 3], [f32; 3]) = ([-1.0, -1.0, -1.0], [14.0, 11.0, 13.0]);
const RIGHT_ARM: ([f32; 3], [f32; 3]) = ([26.0, -1.0, -1.0], [41.0, 11.0, 13.0]);

#[test]
fn a_blocker_keeps_support_out_and_an_enforcer_wins_over_it() {
    let auto = json!({ "enable_support": true, "support_type": "normal(auto)" });
    let (l, r) = support_sides(&slice(&with(tee(), &[]), auto.clone()).unwrap());
    assert!(
        l > 0.0 && r > 0.0,
        "both arms get support without volumes: {l} {r}"
    );
    let blocked = with(tee(), &[("support_blocker", cuboid(LEFT_ARM.0, LEFT_ARM.1))]);
    let (l, r) = support_sides(&slice(&blocked, auto.clone()).unwrap());
    assert_eq!(l, 0.0, "no support under the blocked arm");
    assert!(r > 0.0, "the other arm keeps its support");
    // Blocker and enforcer over the same arm: the enforcer wins.
    let both = with(
        tee(),
        &[
            ("support_blocker", cuboid(RIGHT_ARM.0, RIGHT_ARM.1)),
            ("support_enforcer", cuboid(RIGHT_ARM.0, RIGHT_ARM.1)),
        ],
    );
    let (_, r) = support_sides(&slice(&both, auto).unwrap());
    assert!(r > 0.0, "an enforcer over a blocker still gets support");
}

#[test]
fn manual_support_prints_only_under_enforcers() {
    let enforced = with(tee(), &[("support_enforcer", cuboid(RIGHT_ARM.0, RIGHT_ARM.1))]);
    for kind in ["normal(manual)", "tree(manual)"] {
        let run = slice(&enforced, json!({ "enable_support": true, "support_type": kind })).unwrap();
        let (l, r) = support_sides(&run);
        assert_eq!(l, 0.0, "{kind}: no support where no enforcer asks");
        assert!(r > 0.0, "{kind}: support under the enforcer");
    }
}

#[test]
fn enforcers_with_support_off_print_none_and_say_so() {
    let enforced = with(tee(), &[("support_enforcer", cuboid(RIGHT_ARM.0, RIGHT_ARM.1))]);
    let run = slice(&enforced, json!({ "enable_support": false })).unwrap();
    assert_eq!(support_sides(&run), (0.0, 0.0));
    assert!(
        warnings(&run)
            .iter()
            .any(|w| w.contains("enforcers") && w.contains("support is off")),
        "{:?}",
        warnings(&run)
    );
}

#[test]
fn unknown_types_print_and_unknown_or_bad_settings_are_named() {
    let cube = cuboid(CUBE.0, CUBE.1);
    let side = cuboid([30.0, 0.0, 0.0], [40.0, 10.0, 10.0]);
    let odd = format!(
        "{}{}",
        meta("not_a_real_key", "1"),
        meta("sparse_infill_pattern", "wobbly")
    );
    let bytes = project(
        &[
            ("normal_part", cube.clone(), ""),
            ("banana_part", side.clone(), odd.as_str()),
        ],
        "",
    );
    let run = slice(&bytes, json!({})).unwrap();
    // The unknown type prints as a part: plastic at x 130 to 140.
    assert!(
        moves(&run).iter().any(|m| m.mid()[0] > 131.0),
        "the banana part prints"
    );
    let w = warnings(&run);
    assert!(w.iter().any(|w| w.contains("banana_part")), "{w:?}");
    assert!(w.iter().any(|w| w.contains("not_a_real_key")), "{w:?}");
    // A number that is not one fails the slice and names the key.
    let bad = project(
        &[
            ("normal_part", cube, meta("wall_loops", "abc").as_str()),
            ("normal_part", side, ""),
        ],
        "",
    );
    let err = slice(&bad, json!({})).unwrap_err().to_string();
    assert!(err.contains("wall_loops"), "{err}");
}

#[test]
fn a_part_prints_with_the_objects_settings_and_its_own_over_them() {
    // Object: 2 walls. Left part: its own 4. Right part: the object's.
    let left = cuboid([0.0, 0.0, 0.0], [20.0, 20.0, 10.0]);
    let right = cuboid([30.0, 0.0, 0.0], [50.0, 20.0, 10.0]);
    let bytes = project(
        &[
            ("normal_part", left, meta("wall_loops", "4").as_str()),
            ("normal_part", right, ""),
        ],
        &meta("wall_loops", "2"),
    );
    let run = slice(&bytes, json!({ "wall_loops": 3 })).unwrap();
    let ms = moves(&run);
    // Count wall loops along a line through each part's middle on one layer: closed loops cross it twice.
    let crossings = |x0: f64, x1: f64| {
        ms.iter()
            .filter(|m| m.feature.contains("wall") && (m.z - 5.0).abs() < 0.11)
            .filter(|m| {
                let (ya, yb) = (m.a[1] - 110.0, m.b[1] - 110.0);
                ya * yb < 0.0 && m.mid()[0] > x0 && m.mid()[0] < x1
            })
            .count()
    };
    assert_eq!(crossings(100.0, 120.0), 2 * 4, "the left part's own 4 walls");
    assert_eq!(
        crossings(130.0, 150.0),
        2 * 2,
        "the object's 2 walls over the plate's 3"
    );
}
