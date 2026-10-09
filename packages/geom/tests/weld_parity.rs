// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The engine's exact weld of each binary STL in `fixtures/weld-parity.json`, held to the counts and digest recorded
//! there. The app's own weld of the same files (packages/app/src/export/stl-scan.ts, which shows a model before the
//! engine's import answers) is held to the same record by packages/app/test/stl-weld-parity.test.ts, so the two agree
//! position for position and triangle for triangle, and a change to either fails one of the tests.
//! `SX_WELD_RECORD=1 cargo test -p sx-geom --test weld_parity` writes the record again.

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
    let record: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&record_path).unwrap()).unwrap();
    let files = record["files"].as_array().unwrap();
    let mut out = String::new();
    for f in files {
        let rel = f["path"].as_str().unwrap();
        let bytes = std::fs::read(here.join("../..").join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));
        let m = TriMesh::from_stl(&bytes, rel).unwrap();
        let got = (m.positions.len(), m.triangles.len(), format!("{:08x}", digest(&m)));
        writeln!(out, "    {{ \"path\": \"{rel}\", \"vertices\": {}, \"triangles\": {}, \"digest\": \"{}\" }},", got.0, got.1, got.2).unwrap();
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
        std::fs::write(&record_path, format!("{{\n  \"note\": {},\n  \"files\": [\n{body}\n  ]\n}}\n", serde_json::to_string(note).unwrap())).unwrap();
    }
}
