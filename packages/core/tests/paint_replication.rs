// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A mesh copied to another slicer through the raw parts format keeps its paint. The web build gives each worker
//! it starts after a mesh loads a copy made this way, and a worker slices its share of the layers with that copy, so
//! a copy without the paint printed those layers without color, seam, support or fuzzy skin paint.

#![allow(clippy::cast_possible_truncation, reason = "test archives are tiny")]

use serde_json::json;
use std::fmt::Write as _;
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, SliceRequest};

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

/// A 20 mm cube on filament 1 with every kind of paint: the top in filament 2 (a whole triangle and a split one),
/// a side asking for the seam, the bottom asking for support, another side in fuzzy skin.
fn painted_cube(top: &str) -> Vec<u8> {
    let v = [
        [0, 0, 0],
        [20, 0, 0],
        [20, 20, 0],
        [0, 20, 0],
        [0, 0, 20],
        [20, 0, 20],
        [20, 20, 20],
        [0, 20, 20],
    ];
    let t: [([u32; 3], &str); 12] = [
        ([0, 2, 1], r#"paint_supports="4""#),
        ([0, 3, 2], r#"paint_supports="4""#),
        ([4, 5, 6], "COLOR"),
        ([4, 6, 7], r#"paint_color="8""#),
        ([0, 1, 5], r#"paint_seam="4""#),
        ([0, 5, 4], r#"paint_seam="4""#),
        ([1, 2, 6], r#"paint_fuzzy_skin="4""#),
        ([1, 6, 5], r#"paint_fuzzy_skin="4""#),
        ([2, 3, 7], ""),
        ([2, 7, 6], ""),
        ([3, 0, 4], ""),
        ([3, 4, 7], ""),
    ];
    let mut model =
        String::from(r#"<model unit="millimeter"><resources><object id="1" type="model"><mesh><vertices>"#);
    for p in v {
        let _ = write!(model, r#"<vertex x="{}" y="{}" z="{}"/>"#, p[0], p[1], p[2]);
    }
    model.push_str("</vertices><triangles>");
    for (tri, attr) in t {
        let attr = attr.replace("COLOR", &format!(r#"paint_color="{top}""#));
        let _ = write!(
            model,
            r#"<triangle v1="{}" v2="{}" v3="{}" {attr}/>"#,
            tri[0], tri[1], tri[2]
        );
    }
    model.push_str(r#"</triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#);
    zip(&[("3D/3dmodel.model", model.as_bytes())])
}

const SPLIT: &str = "004044244640446400AA603";

#[test]
fn a_raw_copy_keeps_every_kind_of_paint_and_its_identity() {
    let a = Mesh::load(&painted_cube(SPLIT), "cube.3mf").unwrap();
    let p = &a.parts[0];
    assert!(
        !p.paint.is_empty()
            && !p.seam_paint.is_empty()
            && !p.support_paint.is_empty()
            && !p.fuzzy_paint.is_empty()
    );
    let b = Mesh::load(&a.to_raw(), "cube.3mf").unwrap();
    let q = &b.parts[0];
    assert_eq!(p.paint, q.paint);
    assert_eq!(p.seam_paint, q.seam_paint);
    assert_eq!(p.support_paint, q.support_paint);
    assert_eq!(p.fuzzy_paint, q.fuzzy_paint);
    assert_eq!(p.positions, q.positions);
    assert_eq!(p.triangles, q.triangles);
    assert_eq!(a.content_hash(), b.content_hash());
    assert_eq!(b.to_raw(), a.to_raw(), "a copy of a copy is the same copy");
    // Paint alone changes what the mesh is.
    let other = Mesh::load(&painted_cube("8"), "cube.3mf").unwrap();
    assert_ne!(other.content_hash(), a.content_hash());
}

#[test]
fn a_raw_copy_slices_to_the_same_gcode() {
    let a = Arc::new(Mesh::load(&painted_cube(SPLIT), "cube.3mf").unwrap());
    let b = Arc::new(Mesh::load(&a.to_raw(), "cube.3mf").unwrap());
    // The copy as the raw format made it before: the same geometry with no paint.
    let mut bare = (*a).clone();
    for p in &mut bare.parts {
        p.paint.clear();
        p.seam_paint.clear();
        p.support_paint.clear();
        p.fuzzy_paint.clear();
    }
    let bare = Arc::new(bare);
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{ "id": "a", "mesh": "x", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1] }] },
        "config": { "filament_colour": ["#FF0000", "#0000FF"], "enable_prime_tower": false, "enable_support": true, "support_type": "normal(manual)", "fuzzy_skin": "none" },
        "options": {}
    }))
    .unwrap();
    let slice = |m: &Arc<Mesh>| {
        let m = m.clone();
        common::run_request(&req, &move |_: &str| Ok(m.clone()))
            .unwrap()
            .gcode
    };
    let (ga, gb, gbare) = (slice(&a), slice(&b), slice(&bare));
    assert!(ga == gb, "the copy prints as the original");
    assert!(
        ga != gbare,
        "paint changes the print, so a copy without it would not"
    );
    let text = String::from_utf8_lossy(&ga);
    assert!(
        text.lines().any(|l| l.starts_with("T1")),
        "the painted top prints in filament 2"
    );
}

/// The web pool as it grows: the first worker loads the file, a worker that joins later gets its copy through the raw
/// parts format (`sx_mesh_parts`, then `sx_load_mesh`), and the layer ranges go to whichever worker is free. Any mix
/// of ranges from the two prints the bytes the first worker prints alone, and a copy without paint would not.
#[test]
fn a_late_worker_prints_its_ranges_as_the_first_worker_does() {
    use sx_core::api;
    let first = Arc::new(Mesh::load(&painted_cube(SPLIT), "cube.3mf").unwrap());
    let late = Arc::new(Mesh::load(&first.to_raw(), "cube.3mf").unwrap());
    let mut bare = (*first).clone();
    for p in &mut bare.parts {
        p.paint.clear();
        p.seam_paint.clear();
        p.support_paint.clear();
        p.fuzzy_paint.clear();
        p.paint_texts.clear();
    }
    let bare = Arc::new(bare);
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{ "id": "a", "mesh": "x", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1] }] },
        "config": common::with_base(&json!({ "filament_colour": ["#FF0000", "#0000FF"], "enable_prime_tower": false, "enable_support": true, "support_type": "normal(manual)", "fuzzy_skin": "none" })),
        "options": {}
    }))
    .unwrap();
    let (config, _) = api::request_config_checked(&req).unwrap();
    let session = |m: &Arc<Mesh>| {
        let m = m.clone();
        let plate = api::build_plate(&req, &move |_: &str| Ok(m.clone())).unwrap();
        api::build_session(&req, &plate, &config).unwrap()
    };
    // The sessions of the first worker, of the late worker and of a late copy without paint.
    let workers = [session(&first), session(&late), session(&bare)];
    let layers = workers[0].layer_count();
    // `shards` ranges, `pick` naming the worker that slices each.
    let print = |shards: u32, pick: &dyn Fn(u32) -> usize| {
        let mut gcode = Vec::new();
        for s in 0..shards {
            api::slice_shard(
                &req,
                &workers[pick(s)],
                &config,
                layers * s / shards..layers * (s + 1) / shards,
                &sx_core::NoProgress,
                &mut gcode,
            )
            .unwrap();
        }
        gcode
    };
    let alone = print(1, &|_| 0);
    for shards in [4, 8] {
        let mixed = print(shards, &|s| usize::from(s % 2 == 1));
        assert!(
            mixed == alone,
            "{shards} ranges, every other one on the late worker"
        );
        let late_only = print(shards, &|_| 1);
        assert!(late_only == alone, "{shards} ranges, all on the late worker");
    }
    let without = print(4, &|s| if s % 2 == 1 { 2 } else { 0 });
    assert!(
        without != alone,
        "a late copy without the paint prints other bytes"
    );
    assert_ne!(first.content_hash(), bare.content_hash());
    assert_eq!(first.content_hash(), late.content_hash());
}

/// The raw parts the web code's `encodeParts` writes (`packages/app/test/parts-paint.test.ts` checks it against this
/// file) are the bytes `Mesh::to_raw` writes for the painted cube, so a mesh the browser hands the engine has the
/// same content hash and slices to the same G-code as the file it came from. `SX_BLESS=1` writes the file again.
#[test]
fn the_raw_parts_fixture_is_the_engines_own_copy() {
    let path = format!("{}/tests/fixtures/painted-cube.sxmp", env!("CARGO_MANIFEST_DIR"));
    let direct = Arc::new(Mesh::load(&painted_cube(SPLIT), "cube.3mf").unwrap());
    if std::env::var_os("SX_BLESS").is_some() {
        std::fs::write(&path, direct.to_raw()).unwrap();
    }
    let raw = std::fs::read(&path).unwrap();
    assert!(
        raw == direct.to_raw(),
        "{path} is not the engine's raw copy of the painted cube"
    );
    let copy = Arc::new(Mesh::load(&raw, "cube.3mf").unwrap());
    assert_eq!(copy.content_hash(), direct.content_hash());
    for layer in 0..4u8 {
        assert!(
            copy.parts[0].paint_texts.iter().any(|t| t.0 == layer),
            "paint layer {layer} in the fixture"
        );
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{ "id": "a", "mesh": "x", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1] }] },
        "config": { "filament_colour": ["#FF0000", "#0000FF"], "enable_prime_tower": false, "enable_support": true, "support_type": "normal(manual)", "fuzzy_skin": "none" },
        "options": {}
    }))
    .unwrap();
    let slice = |m: &Arc<Mesh>| {
        let m = m.clone();
        common::run_request(&req, &move |_: &str| Ok(m.clone()))
            .unwrap()
            .gcode
    };
    assert!(
        slice(&copy) == slice(&direct),
        "the fixture slices as the file does"
    );
}
