// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The asset protocol serves one file: the STEP reader's wasm beside the bundled MCP server, which the window's STEP
//! worker fetches (src/host/step-wasm.ts). The scope is read from the real tauri.conf.json and checked with Tauri's
//! own scope (the one the asset protocol asks) on the mock runtime, over a stand-in resource folder laid out as the
//! app's: the wasm passes; its neighbors, the server, the folder, a path that climbs out with .., a link inside the
//! folder that points out of it, and files elsewhere are refused. `$RESOURCE` is put in by hand, since a test binary
//! has no app resource folder; in the app, Tauri puts in Resources (macOS) or the install folder (Windows, Linux).
use std::fs;
use std::path::{Path, PathBuf};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::utils::config::FsScope;

fn touch(path: &Path) {
    fs::create_dir_all(path.parent().expect("a parent")).expect("a folder");
    fs::write(path, b"x").expect("a file");
}

#[test]
fn the_asset_protocol_serves_only_the_step_reader_wasm() {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json is JSON");
    let asset = &conf["app"]["security"]["assetProtocol"];
    assert_eq!(asset["enable"], true);
    let allow = asset["scope"]["allow"].as_array().expect("an allow list");
    assert_eq!(allow.len(), 1, "one allowed path: {allow:?}");
    assert_eq!(allow[0], "$RESOURCE/mcp/step-reader/occt-import-js.wasm");

    let root = std::env::temp_dir().join(format!("sx-asset-scope-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let res = {
        fs::create_dir_all(root.join("Resources")).expect("a resource folder");
        root.join("Resources").canonicalize().expect("a real path")
    };
    let reader = res.join("mcp").join("step-reader");
    let wasm = reader.join("occt-import-js.wasm");
    let outside = root.canonicalize().expect("a real path").join("home");
    for f in [
        wasm.clone(),
        reader.join("occt-import-js.mjs"),
        reader.join("node.js"),
        reader.join("NOTICE"),
        res.join("mcp").join("slicerx-mcp.mjs"),
        res.join("sx-watch-siglip2.onnx"),
        outside.join(".ssh").join("id_ed25519"),
        outside.join("Downloads").join("occt-import-js.wasm"),
    ] {
        touch(&f);
    }
    // A link inside the folder, with the wasm's name, that points out of it.
    fs::create_dir_all(reader.join("sub")).expect("a folder");
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        outside.join(".ssh").join("id_ed25519"),
        reader.join("sub").join("occt-import-js.wasm"),
    )
    .expect("a link");

    let mut scope_conf = asset["scope"].clone();
    scope_conf["allow"] = serde_json::json!([allow[0]
        .as_str()
        .unwrap()
        .replace("$RESOURCE", &res.to_string_lossy())]);
    let fs_scope: FsScope = serde_json::from_value(scope_conf).expect("the scope parses");
    let app = mock_builder()
        .build(mock_context(noop_assets()))
        .expect("the mock app starts");
    let scope = tauri::scope::fs::Scope::new(&app, &fs_scope).expect("the scope builds");

    assert!(scope.is_allowed(&wasm), "{} is allowed", wasm.display());
    let refused: Vec<PathBuf> = vec![
        reader.join("occt-import-js.mjs"),
        reader.join("node.js"),
        reader.join("NOTICE"),
        reader.clone(),
        res.join("mcp").join("slicerx-mcp.mjs"),
        reader.join("..").join("slicerx-mcp.mjs"),
        reader.join("sub").join("occt-import-js.wasm"),
        res.join("sx-watch-siglip2.onnx"),
        outside.join(".ssh").join("id_ed25519"),
        outside.join("Downloads").join("occt-import-js.wasm"),
        PathBuf::from("/etc/passwd"),
    ];
    for p in &refused {
        assert!(!scope.is_allowed(p), "{} is refused", p.display());
    }
    let _ = fs::remove_dir_all(&root);
}
