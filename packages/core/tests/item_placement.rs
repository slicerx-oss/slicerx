// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A project file's build items load as their object's parts in the object's own space, with the item's transform kept
//! in full precision, and the plate places them exactly on the engine's grid: two items of one object are the same
//! parts moved by whole grid steps, and a file written back with each item's transform (not its vertices moved) loads
//! the same again.
#![allow(clippy::disallowed_methods, reason = "test geometry written as 3MF text")]

mod common;

use common::organic_models as models;
use std::fmt::Write as _;
use sx_core::api;
use sx_core::mesh::Mesh;
use sx_core::plate::{ItemsPlacement, Plate, PlateObject};

/// The engine's grid, steps per mm.
const SCALE: f64 = 1e4;

/// A 3MF of one object (the parts of `m`, their vertices as written) placed by each of `items` (a 3MF transform each:
/// three rows of the turn and scale, then the move).
fn threemf(m: &Mesh, items: &[[f64; 12]]) -> Vec<u8> {
    let (mut vx, mut tx, mut base) = (String::new(), String::new(), 0u32);
    for p in &m.parts {
        for q in &p.positions {
            let _ = write!(vx, r#"<vertex x="{}" y="{}" z="{}"/>"#, q[0], q[1], q[2]);
        }
        for t in &p.triangles {
            let _ = write!(
                tx,
                r#"<triangle v1="{}" v2="{}" v3="{}"/>"#,
                t[0] + base,
                t[1] + base,
                t[2] + base
            );
        }
        base += u32::try_from(p.positions.len()).unwrap();
    }
    let build: String = items
        .iter()
        .map(|t| {
            let words: Vec<String> = t.iter().map(f64::to_string).collect();
            format!(r#"<item objectid="1" transform="{}"/>"#, words.join(" "))
        })
        .collect();
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>{vx}</vertices><triangles>{tx}</triangles></mesh></object></resources><build>{build}</build></model>"#
    );
    let types = r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>"#;
    let rels = r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>"#;
    models::stored_zip(&[
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("3D/3dmodel.model", model.as_bytes()),
    ])
}

/// A quarter turn about z and a move by an uneven amount, as a 3MF writes a build item.
fn item(x: f64, y: f64) -> [f64; 12] {
    [0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0, x, y, 16.367_954]
}

fn load(bytes: &[u8]) -> Vec<Mesh> {
    api::load_3mf_items(bytes, "items.3mf", None).unwrap().unwrap().1
}

/// Every printed vertex of `o` where the plate puts it, in grid steps.
fn placed_steps(o: &PlateObject) -> Vec<[f64; 3]> {
    o.mesh
        .parts
        .iter()
        .flat_map(|p| p.positions.iter())
        .map(|&v| PlateObject::apply_with(&o.transform, v).map(|c| c * SCALE))
        .collect()
}

#[test]
fn two_items_of_one_object_are_the_same_parts_moved_by_whole_grid_steps() {
    let m = models::mushroom();
    let items = [item(52.223_41, 54.326_21), item(128.000_04, 201.673_79)];
    let plate = Plate::items_on(
        load(&threemf(&m, &items)),
        [0.0, 0.0, 256.0, 256.0],
        250.0,
        ItemsPlacement::Kept([0.0, 0.0]),
    );
    let [a, b] = [&plate.objects[0], &plate.objects[1]];
    // The parts load once, in the object's space: both items hold the same vertices.
    assert_eq!(a.mesh.parts[0].positions, b.mesh.parts[0].positions);
    let (pa, pb) = (placed_steps(a), placed_steps(b));
    // Each placed vertex is a whole number of grid steps, and every vertex of the second item stands the same whole
    // number of steps from the first item's.
    let step = [
        (pb[0][0] - pa[0][0]).round(),
        (pb[0][1] - pa[0][1]).round(),
        (pb[0][2] - pa[0][2]).round(),
    ];
    assert_eq!(step[2], 0.0, "the two items stand at one height");
    for (u, v) in pa.iter().zip(&pb) {
        for c in 0..3 {
            assert!((u[c] - u[c].round()).abs() < 1e-6, "vertex {u:?} is off the grid");
            assert_eq!((v[c] - u[c]).round(), step[c], "vertex {v:?} against {u:?}");
        }
    }
}

#[test]
fn a_project_written_back_with_its_item_transforms_loads_the_same() {
    let m = models::mushroom();
    let items = [item(52.223_41, 54.326_21), item(91.371_7, 103.812_9)];
    let first = load(&threemf(&m, &items));
    // Written back as the engine holds it: the parts in the object's space and each item's transform.
    let again_items: Vec<[f64; 12]> = first
        .iter()
        .map(|o| o.placement.as_ref().unwrap().transform)
        .collect();
    let written = Mesh {
        parts: first[0].parts.clone(),
        ..Mesh::default()
    };
    let second = load(&threemf(&written, &again_items));
    assert_eq!(first.len(), second.len());
    for (a, b) in first.iter().zip(&second) {
        assert_eq!(a.placement, b.placement, "the item's transform");
        assert_eq!(a.parts[0].positions, b.parts[0].positions, "the parts");
        assert_eq!(a.bounds(), b.bounds(), "where the item stands");
    }
    // The bounds are where the item puts the parts: a quarter turn about z, then the move.
    let (lo, hi) = first[0].bounds().unwrap();
    let (mlo, mhi) = m.bounds().unwrap();
    let close = |x: f32, y: f64| (f64::from(x) - y).abs() < 1e-3;
    assert!(close(lo[0], -f64::from(mhi[1]) + 52.223_41) && close(hi[0], -f64::from(mlo[1]) + 52.223_41));
    assert!(close(lo[1], f64::from(mlo[0]) + 54.326_21) && close(hi[1], f64::from(mhi[0]) + 54.326_21));
}
