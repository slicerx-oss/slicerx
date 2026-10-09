// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The engine's exact weld of each binary STL in `fixtures/weld-parity.json`, held to the counts and digest recorded
//! there. The app's own weld of the same files (packages/app/src/export/stl-scan.ts, which shows a model before the
//! engine's import answers) is held to the same record by packages/app/test/stl-weld-parity.test.ts, so the two agree
//! position for position and triangle for triangle, and a change to either fails one of the tests.
//! `SX_WELD_RECORD=1 cargo test -p sx-geom --test weld_parity` writes the record again.
//!
//! The app then sends that read mesh to the engine's import in place of the file (`import.auto` with `stlMesh`); the
//! import of it is the import of the file, answer for answer. `SX_WELD_MORE=<dir>` adds the binary STLs in a folder to
//! that check, for models that are not in the repository.

use std::fmt::Write as _;
use std::path::Path;
use sx_geom::TriMesh;

/// FNV-1a over the welded mesh: its positions as little-endian f32, then its triangles as little-endian u32.
fn digest(m: &TriMesh) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    let mut eat = |bytes: [u8; 4]| {
        for b in bytes {
            h = (h ^ u32::from(b)).wrapping_mul(0x0100_0193);
        }
    };
    for p in &m.positions {
        for &c in p {
            #[allow(clippy::cast_possible_truncation, reason = "an STL's corners are f32")]
            eat((c as f32).to_le_bytes());
        }
    }
    for t in &m.triangles {
        for &i in t {
            eat(i.to_le_bytes());
        }
    }
    h
}

#[test]
fn the_exact_weld_of_each_fixture_matches_the_record() {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let record_path = here.join("tests/fixtures/weld-parity.json");
    let record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&record_path).unwrap()).unwrap();
    let files = record["files"].as_array().unwrap();
    let mut out = String::new();
    for f in files {
        let rel = f["path"].as_str().unwrap();
        let bytes = std::fs::read(here.join("../..").join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));
        let m = TriMesh::from_stl(&bytes, rel).unwrap();
        let got = (
            m.positions.len(),
            m.triangles.len(),
            format!("{:08x}", digest(&m)),
        );
        writeln!(
            out,
            "    {{ \"path\": \"{rel}\", \"vertices\": {}, \"triangles\": {}, \"digest\": \"{}\" }},",
            got.0, got.1, got.2
        )
        .unwrap();
        if std::env::var_os("SX_WELD_RECORD").is_none() {
            let want = (
                usize::try_from(f["vertices"].as_u64().unwrap()).unwrap(),
                usize::try_from(f["triangles"].as_u64().unwrap()).unwrap(),
                f["digest"].as_str().unwrap().to_string(),
            );
            assert_eq!(got, want, "{rel}: (vertices, triangles, digest)");
        }
    }
    if std::env::var_os("SX_WELD_RECORD").is_some() {
        let note = record["note"].as_str().unwrap();
        let body = out.trim_end().trim_end_matches(',');
        std::fs::write(
            &record_path,
            format!(
                "{{\n  \"note\": {},\n  \"files\": [\n{body}\n  ]\n}}\n",
                serde_json::to_string(note).unwrap()
            ),
        )
        .unwrap();
    }
}

/// The mesh in the raw form the app's geometry worker writes (`TriMesh::from_raw`).
fn raw(m: &TriMesh) -> Vec<u8> {
    let mut b = Vec::with_capacity(8 + m.positions.len() * 12 + m.triangles.len() * 12);
    for n in [m.positions.len(), m.triangles.len()] {
        b.extend_from_slice(&u32::try_from(n).unwrap().to_le_bytes());
    }
    for p in &m.positions {
        for &c in p {
            #[allow(clippy::cast_possible_truncation, reason = "an STL's corners are f32")]
            b.extend_from_slice(&(c as f32).to_le_bytes());
        }
    }
    for t in &m.triangles {
        for &i in t {
            b.extend_from_slice(&i.to_le_bytes());
        }
    }
    b
}

#[test]
fn the_import_of_the_read_mesh_is_the_import_of_the_file() {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(here.join("tests/fixtures/weld-parity.json")).unwrap())
            .unwrap();
    let mut paths: Vec<std::path::PathBuf> = record["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| here.join("../..").join(f["path"].as_str().unwrap()))
        .collect();
    if let Some(dir) = std::env::var_os("SX_WELD_MORE") {
        let mut more: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        more.sort();
        paths.extend(
            more.into_iter()
                .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("stl"))),
        );
    }
    for path in paths {
        let bytes = std::fs::read(&path).unwrap();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let Ok(read) = TriMesh::from_stl(&bytes, &name) else {
            continue;
        };
        let mesh = raw(&read);
        let files = |p: &str| -> sx_geom::Result<Vec<u8>> {
            Ok(match p {
                "file" => bytes.clone(),
                "mem:0" => mesh.clone(),
                other => panic!("{other}"),
            })
        };
        let auto = serde_json::json!({});
        let of_file =
            serde_json::json!({ "data": { "path": "file" }, "name": name, "format": "stl", "auto": auto });
        let of_mesh = serde_json::json!({ "stlMesh": { "rawPath": "mem:0" }, "name": name, "format": "stl", "auto": auto });
        let a = sx_geom::json::call_with_files("import.auto", &of_file.to_string(), &files).unwrap();
        let b = sx_geom::json::call_with_files("import.auto", &of_mesh.to_string(), &files).unwrap();
        assert!(
            a == b,
            "{name}: the import of the read mesh differs from the import of the file"
        );
        println!("{name}: same import ({} bytes of answer)", a.len());
    }
}
