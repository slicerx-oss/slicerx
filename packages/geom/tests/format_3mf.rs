// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the 3mf reader on the format corpus and on broken archives

#![cfg(feature = "formats")]
#![allow(clippy::float_cmp, reason = "the test meshes sit on whole millimeters")]

use std::path::PathBuf;
use sx_geom::format::{Layout, PartKind, Project, read_3mf};

fn file(rel: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn read(rel: &str) -> Project {
    read_3mf(&file(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

fn kinds(p: &Project) -> Vec<(String, PartKind)> {
    p.objects
        .iter()
        .flat_map(|o| o.parts.iter().map(|p| (p.name.clone(), p.kind)))
        .collect()
}

#[test]
fn part_types_from_bambu_orca_and_ours() {
    let want = vec![
        ("body".to_owned(), PartKind::Normal),
        ("notch".to_owned(), PartKind::Negative),
        ("modifier".to_owned(), PartKind::Modifier),
        ("blocker".to_owned(), PartKind::SupportBlocker),
        ("enforcer".to_owned(), PartKind::SupportEnforcer),
    ];
    for f in ["subtypes", "bambu-subtypes", "orca-subtypes"] {
        let p = read(&format!("tests/corpus/{f}.3mf"));
        assert_eq!(p.layout, Layout::Bambu, "{f}");
        assert_eq!(p.objects.len(), 1, "{f}");
        let mut got = kinds(&p);
        got.sort_by_key(|(_, k)| *k as u8);
        assert_eq!(got, want, "{f}");
        // the printed body alone is 20 x 20 x 10
        let o = &p.objects[0];
        let body = o.parts.iter().find(|p| p.prints()).expect("a printed part");
        let pts = body.placed(&o.transform, p.unit_scale);
        let size: Vec<f32> = (0..3)
            .map(|c| {
                let (lo, hi) = pts
                    .iter()
                    .fold((f32::MAX, f32::MIN), |(l, h), v| (l.min(v[c]), h.max(v[c])));
                hi - lo
            })
            .collect();
        assert_eq!(size, vec![20.0, 20.0, 10.0], "{f}");
    }
}

#[test]
fn prusaslicer_modifier_and_settings() {
    let p = read("../settings/fixtures/preset-files/prusaslicer-2.9.6.3mf");
    assert_eq!(p.layout, Layout::Prusa);
    let o = &p.objects[0];
    assert_eq!(o.name, "Cube with modifier");
    assert!(
        o.settings
            .iter()
            .any(|(k, v)| k == "fill_pattern" && v == "gyroid")
    );
    let parts: Vec<(&str, PartKind, usize)> = o
        .parts
        .iter()
        .map(|p| (p.name.as_str(), p.kind, p.triangles.len()))
        .collect();
    assert_eq!(
        parts,
        vec![
            ("Cube", PartKind::Normal, 12),
            ("Denser core", PartKind::Modifier, 12)
        ]
    );
    assert!(
        p.files
            .prusa_config
            .as_deref()
            .is_some_and(|c| c.contains("layer_height"))
    );
}

#[test]
fn paint_from_bambu_and_prusaslicer() {
    for f in [
        "../core/cli/tests/fixtures/painted.3mf",
        "tests/corpus/prusa-painted.3mf",
        "tests/corpus/orca-painted.3mf",
    ] {
        let p = read(f);
        let painted: usize = p
            .objects
            .iter()
            .flat_map(|o| &o.parts)
            .map(|p| p.paint.color.len())
            .sum();
        assert_eq!(painted, 4, "{f}");
    }
    let seams: usize = read("../../apps/desktop/src-tauri/src/testdata/seam-cube-xp.3mf")
        .objects
        .iter()
        .flat_map(|o| &o.parts)
        .map(|p| p.paint.seam.len())
        .sum();
    assert!(seams > 0);
}

#[test]
fn plates_and_files() {
    let p = read("../core/bench/models/x-mark-showcase.sx3mf");
    assert!(
        p.files
            .slicerx
            .iter()
            .any(|(n, _)| n == "Metadata/slicerx_history.json")
    );
    assert!(p.files.project_settings.is_some());
    assert!(p.metadata.iter().any(|(k, _)| k == "Application"));
    let p = read("../../apps/web/e2e/fixtures/eight-colors.3mf");
    assert_eq!(p.plates.len(), 1);
    assert_eq!(p.plates[0].objects.len(), p.objects.len());
    assert!(p.objects.iter().all(|o| o.plate == Some(p.plates[0].id)));
    // no _rels/.rels: the root part is found by its usual name
    assert_eq!(read("../core/cli/tests/fixtures/two-boxes.3mf").objects.len(), 2);
}

/// a stored zip of these entries
fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    zip_with(
        entries
            .iter()
            .map(|(n, b)| (*n, b.to_vec(), 0u16, b.len()))
            .collect(),
    )
}

/// entries with a method and a declared size of their own
fn zip_with(entries: Vec<(&str, Vec<u8>, u16, usize)>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut dir = Vec::new();
    let n = u16::try_from(entries.len()).expect("few entries");
    for (name, data, method, size) in entries {
        let at = u32::try_from(out.len()).expect("small");
        let len = u32::try_from(data.len()).expect("small");
        let size = u32::try_from(size).expect("small");
        let name_len = u16::try_from(name.len()).expect("short");
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&[20, 0, 0, 0]);
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&data);
        dir.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        dir.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
        dir.extend_from_slice(&method.to_le_bytes());
        dir.extend_from_slice(&[0; 8]);
        dir.extend_from_slice(&len.to_le_bytes());
        dir.extend_from_slice(&size.to_le_bytes());
        dir.extend_from_slice(&name_len.to_le_bytes());
        dir.extend_from_slice(&[0; 12]);
        dir.extend_from_slice(&at.to_le_bytes());
        dir.extend_from_slice(name.as_bytes());
    }
    let dir_at = u32::try_from(out.len()).expect("small");
    let dir_len = u32::try_from(dir.len()).expect("small");
    out.extend_from_slice(&dir);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&dir_len.to_le_bytes());
    out.extend_from_slice(&dir_at.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

const BOX: &str = r#"<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>"#;

fn model(resources: &str, build: &str) -> String {
    format!(
        r#"<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>{resources}</resources><build>{build}</build></model>"#
    )
}

fn err(bytes: &[u8]) -> String {
    match read_3mf(bytes) {
        Ok(_) => panic!("read a broken file"),
        Err(e) => e.to_string(),
    }
}

#[test]
fn refuses_what_it_cannot_read() {
    assert!(err(b"not a zip").contains("not a ZIP"));
    let bad_index = model(&BOX.replace(r#"v3="2""#, r#"v3="7""#), r#"<item objectid="1"/>"#);
    assert!(err(&zip_of(&[("3D/3dmodel.model", bad_index.as_bytes())])).contains("refused index 1"));
    let bad_vertex = model(&BOX.replace(r#"x="1""#, r#"x="nan""#), r#"<item objectid="1"/>"#);
    assert!(err(&zip_of(&[("3D/3dmodel.model", bad_vertex.as_bytes())])).contains("refused vertex 1 1"));
    let unit = model(BOX, r#"<item objectid="1"/>"#).replace("millimeter", "furlong");
    assert!(err(&zip_of(&[("3D/3dmodel.model", unit.as_bytes())])).contains("refused unit 0 0 furlong"));
    let missing = model(BOX, r#"<item objectid="9"/>"#);
    assert!(err(&zip_of(&[("3D/3dmodel.model", missing.as_bytes())])).contains("object 9 is missing"));
    // a component that contains itself
    let cycle = model(
        r#"<object id="2" type="model"><components><component objectid="2"/></components></object>"#,
        r#"<item objectid="2"/>"#,
    );
    assert!(err(&zip_of(&[("3D/3dmodel.model", cycle.as_bytes())])).contains("nest too deep"));
    // a part that inflates past the size it declares
    let big = model(BOX, r#"<item objectid="1"/>"#);
    let packed = miniz_oxide::deflate::compress_to_vec(big.as_bytes(), 6);
    let bomb = zip_with(vec![("3D/3dmodel.model", packed, 8, 16)]);
    assert!(err(&bomb).contains("inflates past its size"));
}

#[test]
fn components_place_shared_meshes_twice() {
    let resources = format!(
        r#"{BOX}<object id="2" type="model"><components><component objectid="1"/><component objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object>"#
    );
    let p = read_3mf(&zip_of(&[(
        "3D/3dmodel.model",
        model(&resources, r#"<item objectid="2"/><item objectid="1"/>"#).as_bytes(),
    )]))
    .expect("reads");
    assert_eq!(p.layout, Layout::Plain);
    assert_eq!(p.objects.len(), 2);
    assert_eq!(p.objects[0].parts.len(), 2);
    let moved = p.objects[0].parts[1].placed(&p.objects[0].transform, 1.0);
    assert_eq!(moved[1], [6.0, 0.0, 0.0]);
    // the mesh is still there for the second item after the first took copies
    assert_eq!(p.objects[1].parts[0].triangles.len(), 1);
}

#[test]
fn json_operation_gives_meshes_as_buffers() {
    let bytes = file("tests/corpus/subtypes.3mf");
    let load = |p: &str| -> sx_geom::Result<Vec<u8>> {
        assert_eq!(p, "mem:0");
        Ok(bytes.clone())
    };
    let out = sx_geom::json::call_with_files("format.read3mf", r#"{"data":{"path":"mem:0"}}"#, &load)
        .expect("reads");
    let v: serde_json::Value = serde_json::from_str(&out).expect("json");
    assert_eq!(v["layout"], "bambu");
    let parts = v["objects"][0]["parts"].as_array().expect("parts");
    let kinds: Vec<&str> = parts.iter().filter_map(|p| p["kind"].as_str()).collect();
    assert_eq!(
        kinds,
        [
            "normal",
            "negative",
            "modifier",
            "support_blocker",
            "support_enforcer"
        ]
    );
    let buffers = sx_geom::json::take_out_files();
    // positions and triangles of each of the five parts
    assert_eq!(buffers.len(), 10);
    // 8 corners and 12 triangles of a box
    assert_eq!(buffers[0].to_bytes().len(), 8 * 12);
    assert_eq!(buffers[1].to_bytes().len(), 12 * 12);
}

#[test]
fn the_cli_reads_a_project_into_stl_files() {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/subtypes.3mf");
    let dir = std::env::temp_dir().join(format!("sx-geom-read3mf-{}", std::process::id()));
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_sx-geom"))
        .args(["format.read3mf", "--out-dir"])
        .arg(&dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("runs sx-geom");
    let request = serde_json::json!({ "data": { "path": file } }).to_string();
    std::io::Write::write_all(child.stdin.as_mut().expect("stdin"), request.as_bytes()).expect("writes");
    drop(child.stdin.take());
    let out = child.wait_with_output().expect("answers");
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    let parts = v["objects"][0]["parts"].as_array().expect("parts");
    assert_eq!(parts.len(), 5);
    for p in parts {
        let path = p["stlPath"].as_str().expect("an stl file");
        let mesh = sx_geom::TriMesh::from_stl(&std::fs::read(path).expect("written"), "part").expect("reads");
        assert_eq!(mesh.triangles.len(), 12);
    }
    let _ = std::fs::remove_dir_all(dir);
}
