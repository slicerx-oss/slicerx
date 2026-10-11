// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The 3MF loader through `sx-geom` gives the same meshes as the engine's own reader, field for field and bit for
//! bit (positions, triangles, decoded paint, names, slots, volumes, settings, notes), or the same error, on every
//! 3MF in the format corpus (`packages/geom/tests/corpus/corpus.json`). `SX_CORPUS_PRIVATE=<dir>` adds the 3MF files
//! in a folder outside the repository.

use std::path::{Path, PathBuf};

fn is_3mf(p: &Path) -> bool {
    p.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| x.eq_ignore_ascii_case("3mf") || x.eq_ignore_ascii_case("sx3mf"))
}

fn files() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("packages/geom/tests/corpus/corpus.json")).expect("the corpus manifest"),
    )
    .expect("the corpus manifest is JSON");
    let mut out: Vec<PathBuf> = manifest["files"]
        .as_array()
        .expect("a file list")
        .iter()
        .filter_map(|f| f["path"].as_str())
        .filter(|p| is_3mf(Path::new(p)))
        .map(|p| root.join(p))
        .collect();
    if let Ok(dir) = std::env::var("SX_CORPUS_PRIVATE") {
        let mut more: Vec<PathBuf> = std::fs::read_dir(dir)
            .expect("the private corpus folder")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| is_3mf(p))
            .collect();
        more.sort();
        out.extend(more);
    }
    out
}

#[test]
fn geom_reader_matches_the_legacy_one() {
    let mut checked = 0;
    for path in files() {
        let bytes = std::fs::read(&path).expect("a corpus file");
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("model.3mf");
        let new = sx_core::api::load_3mf_plate_objects(&bytes, name);
        let old = sx_core::api::load_3mf_plate_objects_legacy(&bytes, name);
        match (new, old) {
            (Ok(a), Ok(b)) => assert!(
                format!("{a:?}") == format!("{b:?}"),
                "{}: the meshes differ",
                path.display()
            ),
            (Err(a), Err(b)) => assert_eq!(a.to_string(), b.to_string(), "{}", path.display()),
            (a, b) => panic!(
                "{}: one reader fails: {:?} / {:?}",
                path.display(),
                a.err(),
                b.err()
            ),
        }
        checked += 1;
    }
    assert!(checked >= 20, "only {checked} corpus files");
}
