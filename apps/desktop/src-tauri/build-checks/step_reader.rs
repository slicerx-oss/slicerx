// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The STEP reader the app must carry (used by build.rs, tested in tests/step_reader_resource.rs). The window's STEP
//! import fetches the wasm from Resources/mcp/step-reader (src/host/step-wasm.ts), and its page leaves its own copy
//! out (step-wasm-plugin.ts), so an app built without the folder opens no STEP file at all. `tauri build` fills it
//! through beforeBuildCommand (scripts/pack-mcp.mjs); a build that skips that step stops here instead of shipping.
use std::path::Path;

/// The reader's folder, relative to src-tauri: `bundle.resources` maps `resources/mcp/` to the app's `mcp/`.
pub const DIR: &str = "resources/mcp/step-reader";

/// The files the app needs from it: the wasm (the window and the MCP server) and its glue (the MCP server).
pub const FILES: [&str; 2] = ["occt-import-js.wasm", "occt-import-js.mjs"];

/// The command that fills the folder, from the repository root.
pub const FILL: &str = "node apps/desktop/scripts/pack-mcp.mjs";

/// Ok when every file is in `dir` and not empty; otherwise the message the build stops with.
pub fn check(dir: &Path) -> Result<(), String> {
    let missing: Vec<String> = FILES
        .iter()
        .map(|f| dir.join(f))
        .filter(|p| p.metadata().map(|m| m.len() == 0).unwrap_or(true))
        .map(|p| p.display().to_string())
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "The STEP reader is missing from the app's resources: {}.\n\
         An app built without it cannot open STEP files. Fill the folder with `{FILL}` (run from the repository \
         root) and build again. `tauri build` runs it itself as its beforeBuildCommand, so a build that replaces \
         that command must run it first.",
        missing.join(", ")
    ))
}
