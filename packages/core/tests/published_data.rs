// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The published crate builds from the copies in `data/` (it has no `packages/settings` or
//! `packages/ui`). In the workspace they must match what build.rs makes from the settings schema and
//! copies from the viewport's head shapes. `SX_UPDATE_CORE_DATA=1`
//! rewrites them.

use std::path::Path;

#[test]
fn data_copies_match_the_settings_schema() {
    let data = Path::new(env!("CARGO_MANIFEST_DIR")).join("data");
    let update = std::env::var_os("SX_UPDATE_CORE_DATA").is_some();
    for (file, built) in [
        (
            "percent_keys.txt",
            include_str!(concat!(env!("OUT_DIR"), "/percent_keys.txt")),
        ),
        (
            "int_keys.txt",
            include_str!(concat!(env!("OUT_DIR"), "/int_keys.txt")),
        ),
        (
            "defaults.json",
            include_str!(concat!(env!("OUT_DIR"), "/defaults.json")),
        ),
        (
            "head-shapes.json",
            include_str!(concat!(env!("OUT_DIR"), "/head-shapes.json")),
        ),
    ] {
        let path = data.join(file);
        if update {
            std::fs::write(&path, built).unwrap();
            continue;
        }
        // a Windows checkout may turn the copies' line endings into CRLF
        let copy = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert!(
            copy == built.replace("\r\n", "\n"),
            "data/{file} is out of date: run SX_UPDATE_CORE_DATA=1 cargo test -p sx-core --test published_data"
        );
    }
}
