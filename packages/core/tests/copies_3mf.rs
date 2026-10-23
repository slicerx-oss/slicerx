// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Build items of one object in a 3MF project, placed as a request and the MCP server place a project's plate (one
//! object per item, the plate centered as a whole), print as copies: the object is sliced once and each
//! item prints its paths moved to its place, as a plate of one mesh placed several times does.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

/// A ring 16 mm across with a 6 mm hole, 3 mm tall, as a 3MF mesh object: walls, solid and sparse infill.
fn ring_object(id: u32) -> String {
    const N: u32 = 32;
    let (outer, inner, h) = (8.0_f32, 3.0_f32, 3.0_f32);
    let mut vs = String::new();
    // per step i: outer bottom, inner bottom, outer top, inner top
    for i in 0..N {
        let a = i as f32 / N as f32 * std::f32::consts::TAU;
        let (s, c) = a.sin_cos();
        for (r, z) in [(outer, 0.0), (inner, 0.0), (outer, h), (inner, h)] {
            let _ = write!(vs, r#"<vertex x="{}" y="{}" z="{}"/>"#, r * c, r * s, z);
        }
    }
    let mut ts = String::new();
    let mut tri = |a: u32, b: u32, c: u32| {
        let _ = write!(ts, r#"<triangle v1="{a}" v2="{b}" v3="{c}"/>"#);
    };
    for i in 0..N {
        let j = (i + 1) % N;
        let (ob, ib, ot, it) = (4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3);
        let (ob2, ib2, ot2, it2) = (4 * j, 4 * j + 1, 4 * j + 2, 4 * j + 3);
        tri(ot, ot2, it2);
        tri(ot, it2, it);
        tri(ob, ib2, ob2);
        tri(ob, ib, ib2);
        tri(ob, ob2, ot2);
        tri(ob, ot2, ot);
        tri(ib, it2, ib2);
        tri(ib, it, it2);
    }
    format!(
        r#"<object id="{id}" name="ring" type="model"><mesh><vertices>{vs}</vertices><triangles>{ts}</triangles></mesh></object>"#
    )
}

/// A plain 3MF of the ring placed by each of `items` (3MF transforms).
fn project(items: &[&str]) -> Vec<u8> {
    let build = items.iter().fold(String::new(), |mut acc, t| {
        let _ = write!(acc, r#"<item objectid="1" transform="{t}"/>"#);
        acc
    });
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>{}</resources><build>{build}</build></model>"#,
        ring_object(1)
    );
    let rels = r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>"#;
    common::organic_models::stored_zip(&[
        ("_rels/.rels", rels.as_bytes()),
        ("3D/3dmodel.model", model.as_bytes()),
    ])
}

/// The G-code of the project's plate, one object per build item as a request places them.
fn slice(bytes: &[u8]) -> String {
    let (_, items) = sx_core::api::load_3mf_items(bytes, "rings.3mf", None)
        .unwrap()
        .unwrap();
    let at = sx_core::plate::items_transform(&items, sx_core::api::Bed::default(), None);
    let objects: Vec<Value> = (0..items.len())
        .map(|k| json!({"id": format!("o{k}"), "name": "ring", "mesh": format!("m{k}"), "transform": at.to_vec()}))
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": {"skirt_loops": 0, "brim_width": 0, "gcode_label_objects": true, "sparse_infill_density": "15%"},
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let meshes: Vec<Arc<Mesh>> = items.into_iter().map(Arc::new).collect();
    let run = common::run_request(&req, &move |id: &str| {
        Ok(meshes[id.trim_start_matches('m').parse::<usize>().unwrap()].clone())
    })
    .unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// One extrusion: its feature, from and to (mm) and the filament it pushes (mm).
type Extrusion = (String, [f64; 4], f64);

/// Each labeled object's extrusions in print order, by its label id.
fn by_object(g: &str) -> BTreeMap<u32, Vec<Extrusion>> {
    let mut out: BTreeMap<u32, Vec<Extrusion>> = BTreeMap::new();
    let (mut object, mut feature, mut at) = (None::<u32>, String::new(), [0.0_f64; 2]);
    for line in g.lines() {
        if let Some(rest) = line.strip_prefix("; printing object ") {
            object = rest
                .split(" id:")
                .nth(1)
                .and_then(|r| r.split_whitespace().next())
                .and_then(|n| n.parse().ok());
        } else if line.starts_with("; stop printing object ") {
            object = None;
        } else if let Some(t) = line.strip_prefix(";TYPE:") {
            t.clone_into(&mut feature);
        }
        let code = line.split(';').next().unwrap_or("");
        if !(code.starts_with("G0 ")
            || code.starts_with("G1 ")
            || code.starts_with("G2 ")
            || code.starts_with("G3 "))
        {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .skip(1)
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        let next = [word('X').unwrap_or(at[0]), word('Y').unwrap_or(at[1])];
        if let (Some(k), Some(e)) = (object, word('E'))
            && e > 0.0
            && next.iter().zip(at).any(|(p, q)| (p - q).abs() > 1e-9)
        {
            out.entry(k)
                .or_default()
                .push((feature.clone(), [at[0], at[1], next[0], next[1]], e));
        }
        at = next;
    }
    out
}

#[test]
fn build_items_of_one_object_print_its_paths_moved() {
    // Four rings on moves that fall between the infill lines, so a slice of the whole plate lays each one's
    // infill differently.
    let moves = [(0.0, 0.0), (23.7, 0.0), (0.0, 31.3), (47.9, 17.1)];
    let items: Vec<String> = moves
        .iter()
        .map(|(dx, dy)| format!("1 0 0 0 1 0 0 0 1 {} {} 0", 100.0 + dx, 100.0 + dy))
        .collect();
    let refs: Vec<&str> = items.iter().map(String::as_str).collect();
    let g = slice(&project(&refs));
    let objects = by_object(&g);
    assert_eq!(objects.len(), moves.len(), "every item prints as its own object");
    let first = objects.values().next().unwrap();
    assert!(
        first.iter().any(|x| x.0 == "Sparse infill"),
        "the ring has sparse infill"
    );
    for ((id, paths), (dx, dy)) in objects.iter().zip(moves).skip(1) {
        assert_eq!(
            paths.len(),
            first.len(),
            "object {id}: {} extrusions, the first has {}",
            paths.len(),
            first.len()
        );
        // Coordinates are written to a thousandth of a millimeter, so each moved one may round the other way.
        let worst = paths
            .iter()
            .zip(first)
            .map(|(p, q)| {
                assert_eq!(p.0, q.0, "object {id}: the features follow the first object's");
                assert!((p.2 - q.2).abs() < 1e-5, "object {id}: E {} against {}", p.2, q.2);
                let d = [dx, dy, dx, dy];
                (0..4).map(|c| (p.1[c] - q.1[c] - d[c]).abs()).fold(0.0, f64::max)
            })
            .fold(0.0, f64::max);
        assert!(
            worst < 0.0015,
            "object {id}: its paths are the first's moved, off by up to {worst} mm"
        );
    }
}

#[test]
fn a_turned_build_item_is_sliced_on_its_own() {
    // The second item turns the ring a quarter turn: not a copy, so its paths are its own (the ring is round,
    // but its facets and seam turn with it).
    let g = slice(&project(&[
        "1 0 0 0 1 0 0 0 1 100 100 0",
        "0 1 0 -1 0 0 0 0 1 130.3 100 0",
    ]));
    let objects = by_object(&g);
    assert_eq!(objects.len(), 2);
    let mut paths = objects.values();
    let (a, b) = (paths.next().unwrap(), paths.next().unwrap());
    let moved = a.len() == b.len()
        && a.iter().zip(b).all(|(p, q)| {
            p.0 == q.0 && (0..4).all(|c| (q.1[c] - p.1[c] - [30.3, 0.0, 30.3, 0.0][c]).abs() < 0.0015)
        });
    assert!(!moved, "a turned item prints the first item's paths moved");
}
