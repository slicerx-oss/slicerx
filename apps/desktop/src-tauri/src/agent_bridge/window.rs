// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A bridge build's main window, opened by the shell when its config leaves it to us (`create: false`, set by
//! apps/desktop/scripts/bridge-build.mjs). On macOS it gets a web data store of its own, named from the identifier:
//! WebKit keeps an unbundled binary's web data under the executable's name, so every bridge and dev binary called
//! slicerx would share one localStorage. Older macOS (before 14) falls back to the shared store.

use tauri::{App, Manager, WebviewWindowBuilder};

/// Opens the main window from its config when the config did not. Does nothing when it is already open.
pub fn open_main_window(app: &App) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    let Some(conf) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
    else {
        return Ok(());
    };
    let builder = WebviewWindowBuilder::from_config(app.handle(), &conf)?;
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(store_id(&app.config().identifier));
    builder.build()?;
    Ok(())
}

/// The store's 16 bytes: the same identifier gives the same store on every build, so a run finds the last one's data.
pub fn store_id(identifier: &str) -> [u8; 16] {
    // FNV-1a, twice with different bases: stable across Rust versions, unlike the standard hasher
    let fnv = |basis: u64| {
        identifier
            .bytes()
            .fold(basis, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3))
    };
    let mut out = [0u8; 16];
    out[..8].copy_from_slice(&fnv(0xcbf2_9ce4_8422_2325).to_be_bytes());
    out[8..].copy_from_slice(&fnv(0x6c62_272e_07bb_0142).to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::store_id;

    #[test]
    fn the_same_identifier_names_the_same_store_and_others_differ() {
        assert_eq!(
            store_id("app.slicerx.desktop.agent-bridge"),
            store_id("app.slicerx.desktop.agent-bridge")
        );
        assert_ne!(
            store_id("app.slicerx.desktop.agent-bridge"),
            store_id("app.layermate.desktop.agent-bridge")
        );
        assert_ne!(
            store_id("app.slicerx.desktop.agent-bridge")[..8],
            store_id("app.slicerx.desktop.agent-bridge")[8..]
        );
    }
}
