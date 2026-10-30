// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The check build.rs runs on a `tauri build` (build-checks/step_reader.rs): it fails without the STEP reader in the
//! app's resources, naming each missing file and the command that fills the folder, and passes once they are there.
#[path = "../build-checks/step_reader.rs"]
mod step_reader;

use std::fs;
use std::path::PathBuf;

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sx-step-reader-resource-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

#[test]
fn a_build_without_the_reader_folder_fails_and_says_how_to_fill_it() {
    let dir = folder("none");
    let message = step_reader::check(&dir).expect_err("no folder, no build");
    for f in step_reader::FILES {
        assert!(
            message.contains(&dir.join(f).display().to_string()),
            "names {f}: {message}"
        );
    }
    assert!(
        message.contains("node apps/desktop/scripts/pack-mcp.mjs"),
        "{message}"
    );
}

#[test]
fn an_empty_or_partial_reader_fails_naming_only_what_is_missing() {
    let dir = folder("partial");
    fs::create_dir_all(&dir).expect("a folder");
    fs::write(dir.join("occt-import-js.mjs"), b"export default 1").expect("the glue");
    fs::write(dir.join("occt-import-js.wasm"), b"").expect("an empty wasm");
    let message = step_reader::check(&dir).expect_err("an empty wasm is not a reader");
    assert!(message.contains("occt-import-js.wasm"), "{message}");
    assert!(
        !message.contains("occt-import-js.mjs"),
        "the glue is there: {message}"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_build_with_the_reader_passes() {
    let dir = folder("full");
    fs::create_dir_all(&dir).expect("a folder");
    for f in step_reader::FILES {
        fs::write(dir.join(f), b"\0asm").expect("a file");
    }
    assert_eq!(step_reader::check(&dir), Ok(()));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_folder_is_the_one_the_bundle_and_the_asset_scope_name() {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json is JSON");
    assert_eq!(conf["bundle"]["resources"]["resources/mcp/"], "mcp/");
    assert_eq!(
        conf["app"]["security"]["assetProtocol"]["scope"]["allow"][0],
        format!(
            "$RESOURCE/mcp/{}/{}",
            step_reader::DIR.trim_start_matches("resources/mcp/"),
            step_reader::FILES[0]
        )
    );
    assert_eq!(
        conf["build"]["beforeBuildCommand"],
        "node scripts/pack-mcp.mjs && pnpm build"
    );
}
