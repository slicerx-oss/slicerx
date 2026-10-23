// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Object labels go into G-code people share, so they name an object by its file's name, or by its place in the
//! build for a 3MF object without a name of its own, and never by the folders the file was opened from. These load
//! models the way the app's engine does (`api::load_mesh` and the 3MF plate readers, with the name the host gives),
//! from a Unix and a Windows folder, and slice them with the request pipeline.

#![allow(clippy::cast_possible_truncation, reason = "test archives are tiny")]

use serde_json::{Value, json};
use std::fmt::Write as _;
use std::sync::Arc;
mod common;

use sx_core::api::{self, Mesh, SliceRequest};

/// The folder a model is kept in, as a host may pass it: no part of it may reach the G-code.
const FOLDERS: [&str; 2] = [
    "/home/user/models/private-folder/",
    r"C:\Users\someone\private-folder\",
];

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

/// The 8 corners and 12 triangles of a 10 mm box.
fn cube() -> ([[f32; 3]; 8], [[usize; 3]; 12]) {
    let mut v = [[0.0; 3]; 8];
    for (k, c) in v.iter_mut().enumerate() {
        let (x, y) = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)][k % 4];
        *c = [x, y, if k < 4 { 0.0 } else { 10.0 }];
    }
    let t = [
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
    (v, t)
}

/// A plain 3MF of `items` 10 mm boxes, 30 mm apart, whose objects have no names.
fn unnamed_boxes(items: usize) -> Vec<u8> {
    let (v, t) = cube();
    let mut mesh = String::from("<mesh><vertices>");
    for p in v {
        let _ = write!(mesh, r#"<vertex x="{}" y="{}" z="{}"/>"#, p[0], p[1], p[2]);
    }
    mesh.push_str("</vertices><triangles>");
    for [a, b, c] in t {
        let _ = write!(mesh, r#"<triangle v1="{a}" v2="{b}" v3="{c}"/>"#);
    }
    mesh.push_str("</triangles></mesh>");
    let mut objects = String::new();
    let mut build = String::new();
    for k in 1..=items {
        let _ = write!(objects, r#"<object id="{k}" type="model">{mesh}</object>"#);
        let _ = write!(
            build,
            r#"<item objectid="{k}" transform="1 0 0 0 1 0 0 0 1 {} 100 0"/>"#,
            30 * k
        );
    }
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>{objects}</resources><build>{build}</build></model>"#
    );
    zip(&[("3D/3dmodel.model", model.as_bytes())])
}

/// A 10 mm box as ASCII STL.
fn cube_stl() -> Vec<u8> {
    let (v, t) = cube();
    let mut s = String::from("solid cube\n");
    for tri in t {
        s.push_str("facet normal 0 0 0\nouter loop\n");
        for i in tri {
            let p = v[i];
            let _ = writeln!(s, "vertex {} {} {}", p[0], p[1], p[2]);
        }
        s.push_str("endloop\nendfacet\n");
    }
    s.push_str("endsolid cube\n");
    s.into_bytes()
}

/// The label lines of a G-code file: comments, `M486`, `EXCLUDE_OBJECT` and Bambu Lab's start and stop lines.
fn label_lines(g: &str) -> Vec<&str> {
    g.lines()
        .filter(|l| {
            l.starts_with("; printing object")
                || l.starts_with("; stop printing object")
                || l.starts_with("; start printing object")
                || l.starts_with("M486")
                || l.starts_with("EXCLUDE_OBJECT")
        })
        .collect()
}

/// Slices `objects` (mesh, x; no names given, so each takes its mesh's) with labels on in `flavor`.
fn slice(objects: Vec<(Arc<Mesh>, f32)>, flavor: &str) -> String {
    let list: Vec<Value> = objects
        .iter()
        .enumerate()
        .map(|(k, (_, x))| json!({"id": format!("o{k}"), "mesh": format!("m{k}"), "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, x,100,0,1]}))
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": list},
        "config": {"brim_width": 0, "skirt_loops": 0, "gcode_label_objects": true, "exclude_object": true, "gcode_flavor": flavor},
        "options": {"allowCollisions": true}
    }))
    .unwrap();
    let run = common::run_request(&req, &move |id: &str| {
        let k: usize = id.trim_start_matches('m').parse().unwrap_or(0);
        Ok(objects[k].0.clone())
    })
    .unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// No part of the folder in the G-code, and no path separator in a label line.
fn assert_no_folder(g: &str, what: &str) {
    for word in ["private-folder", "/home/", "someone", "Users"] {
        assert!(!g.contains(word), "{what}: {word} is in the G-code");
    }
    let labels = label_lines(g);
    assert!(!labels.is_empty(), "{what}: no labels");
    for l in labels {
        assert!(!l.contains('/') && !l.contains('\\'), "{what}: {l}");
    }
}

#[test]
fn a_model_loaded_from_a_folder_is_named_by_its_file_alone() {
    for dir in FOLDERS {
        let stl = api::load_mesh(&cube_stl(), &format!("{dir}cube.stl")).unwrap();
        assert_eq!(stl.name, "cube.stl");
        assert!(
            stl.parts.iter().all(|p| p.name == "cube.stl"),
            "{:?}",
            stl.parts[0].name
        );
        let one = api::load_mesh(&unnamed_boxes(1), &format!("{dir}one.3mf")).unwrap();
        assert_eq!(one.name, "one.3mf");
        let plates = api::load_3mf_plates(&unnamed_boxes(2), &format!("{dir}two.3mf")).unwrap();
        assert_eq!(plates[0].1.name, "two.3mf");
    }
}

#[test]
fn a_3mf_object_without_a_name_goes_by_its_place_in_the_build() {
    for dir in FOLDERS {
        let path = format!("{dir}two.3mf");
        for plates in [
            api::load_3mf_plate_objects(&unnamed_boxes(2), &path).unwrap(),
            api::load_3mf_plate_objects_legacy(&unnamed_boxes(2), &path).unwrap(),
        ] {
            let names: Vec<&str> = plates[0].1.iter().map(|m| m.name.as_str()).collect();
            assert_eq!(names, ["Object_1", "Object_2"]);
        }
    }
}

#[test]
fn labels_of_a_model_from_a_folder_carry_no_path() {
    for dir in FOLDERS {
        let stl = Arc::new(api::load_mesh(&cube_stl(), &format!("{dir}cube.stl")).unwrap());
        let one = Arc::new(api::load_mesh(&unnamed_boxes(1), &format!("{dir}one.3mf")).unwrap());
        let items = api::load_3mf_plate_objects(&unnamed_boxes(2), &format!("{dir}two.3mf")).unwrap();
        let items: Vec<Arc<Mesh>> = items
            .into_iter()
            .next()
            .unwrap()
            .1
            .into_iter()
            .map(Arc::new)
            .collect();
        for flavor in ["marlin", "klipper", "reprapfirmware"] {
            let what = format!("{dir} {flavor}");
            let g = slice(vec![(stl.clone(), 60.0), (one.clone(), 120.0)], flavor);
            assert_no_folder(&g, &what);
            assert!(g.contains("; printing object cube.stl id:0 copy 0\n"), "{what}");
            assert!(
                g.contains("; stop printing object one.3mf id:1 copy 0\n"),
                "{what}"
            );
            // the names firmware skips objects by are the same names, made safe for the command
            let fw = match flavor {
                "marlin" => ["M486 Acube.stl_id_0_copy_0", "M486 Aone.3mf_id_1_copy_0"],
                "klipper" => [
                    "EXCLUDE_OBJECT_DEFINE NAME=cube.stl_id_0_copy_0",
                    "EXCLUDE_OBJECT_DEFINE NAME=one.3mf_id_1_copy_0",
                ],
                _ => [
                    "M486 S0 A\"cube.stl_id_0_copy_0\"",
                    "M486 S1 A\"one.3mf_id_1_copy_0\"",
                ],
            };
            for f in fw {
                assert!(g.contains(f), "{what}: {f}");
            }
            let g = slice(vec![(items[0].clone(), 60.0), (items[1].clone(), 120.0)], flavor);
            assert_no_folder(&g, &what);
            assert!(g.contains("; printing object Object_1 id:0 copy 0\n"), "{what}");
            assert!(g.contains("; printing object Object_2 id:1 copy 0\n"), "{what}");
        }
    }
}
