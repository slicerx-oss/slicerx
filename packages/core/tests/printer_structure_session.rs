// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `printer_structure` decides whether the by-object plate has a gantry beam (a delta has none), and the collision
//! model reads it when a session is built. A host keeps a session while [`api::session_key`] stays the same, so an
//! edit of the structure either changes the key or the kept session reports what a cold slice does.

#![allow(clippy::disallowed_methods, reason = "test geometry, not engine output")]

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest, SliceRun};

fn block(w: f32, d: f32, h: f32) -> Arc<Mesh> {
    let mut positions = Vec::new();
    for zi in [0.0, h] {
        for (xi, yi) in [(0.0, 0.0), (w, 0.0), (w, d), (0.0, d)] {
            positions.push([xi, yi, zi]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    Arc::new(Mesh {
        name: "box".into(),
        parts: vec![MeshPart {
            name: "part 1".into(),
            slot: 1,
            color: None,
            positions,
            triangles,
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
            paint_texts: Vec::new(),
        }],
        ..Mesh::default()
    })
}

type Plate = Vec<(&'static str, Arc<Mesh>, f32, f32)>;

/// The by-object plate's request with `structure` set, and its mesh loader.
fn request(plate: &Plate, structure: &str) -> (SliceRequest, impl Fn(&str) -> sx_core::Result<Arc<Mesh>>) {
    let cfg = json!({
        "brim_width": 0, "skirt_loops": 0, "print_sequence": "by object",
        "extruder_clearance_height_to_rod": 10, "extruder_clearance_dist_to_rod": 40,
        "printer_structure": structure,
    });
    let list: Vec<Value> = plate
        .iter()
        .map(|(name, _, x, y)| json!({"id": name, "name": name, "mesh": name, "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,0,1]}))
        .collect();
    let mut req: SliceRequest =
        serde_json::from_value(json!({"plate": {"objects": list}, "config": cfg, "options": {}})).unwrap();
    req.config = common::with_base(&req.config);
    let meshes: Vec<(String, Arc<Mesh>)> = plate
        .iter()
        .map(|(n, m, _, _)| ((*n).to_owned(), m.clone()))
        .collect();
    let load = move |id: &str| {
        Ok(meshes
            .iter()
            .find(|(n, _)| n == id)
            .map(|(_, m)| m.clone())
            .unwrap())
    };
    (req, load)
}

/// The G-code, preview and report of a run, the report without its wall time.
fn output(run: &SliceRun) -> (Vec<u8>, Vec<u8>, Value) {
    let mut report = serde_json::to_value(&run.report).unwrap();
    if let Some(m) = report.as_object_mut() {
        m.remove("wallMs");
        m.remove("stageMicros");
    }
    (run.gcode.clone(), run.preview.clone(), report)
}

/// A host that keeps the session of the plate's first request while the key stays the same, and prepares a new one
/// when it changes, reports what a cold slice of the edited request reports, for every pair of structures on a plate
/// where the gantry strikes and on a plate with a tall part.
#[test]
fn an_edited_printer_structure_reports_what_a_cold_slice_does() {
    let plates: [(&str, Plate); 2] = [
        (
            "by object",
            vec![
                ("tall", block(20.0, 20.0, 20.0), 60.0, 100.0),
                ("low", block(20.0, 20.0, 6.0), 140.0, 100.0),
            ],
        ),
        (
            "tall",
            vec![
                ("a", block(20.0, 20.0, 120.0), 60.0, 100.0),
                ("b", block(20.0, 20.0, 30.0), 140.0, 100.0),
                ("c", block(20.0, 20.0, 60.0), 100.0, 160.0),
            ],
        ),
    ];
    let structures = ["undefine", "corexy", "i3", "hbot", "delta"];
    let mut stale = Vec::new();
    let mut changed = 0;
    for (name, plate) in &plates {
        for from in structures {
            let (req, load) = request(plate, from);
            let hash = |id: &str| load(id).ok().map(|m| m.content_hash());
            let prepared = api::prepare(&req, &load).unwrap();
            api::run_prepared(&req, &prepared, &sx_core::NoProgress).unwrap();
            for to in structures {
                let (edited, _) = request(plate, to);
                let cold = output(&api::run_request(&edited, &load).unwrap());
                let host = if api::session_key(&edited, &hash) == api::session_key(&req, &hash) {
                    api::run_prepared(&edited, &prepared, &sx_core::NoProgress).unwrap()
                } else {
                    let fresh = api::prepare(&edited, &load).unwrap();
                    api::run_prepared(&edited, &fresh, &sx_core::NoProgress).unwrap()
                };
                let host = output(&host);
                if host != cold {
                    stale.push(format!(
                        "{name} {from} to {to}: collisions kept {}, cold {}",
                        host.2["collisions"].as_array().map_or(0, Vec::len),
                        cold.2["collisions"].as_array().map_or(0, Vec::len)
                    ));
                }
                if from != to
                    && api::run_request(&request(plate, from).0, &load)
                        .unwrap()
                        .report
                        .collisions
                        .len()
                        != api::run_request(&edited, &load).unwrap().report.collisions.len()
                {
                    changed += 1;
                }
            }
        }
    }
    assert!(changed > 0, "no edit changes the collisions on these plates");
    assert!(
        stale.is_empty(),
        "a kept session reports these edits stale:\n{}",
        stale.join("\n")
    );
}
