// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! In-app updates through tauri-plugin-updater. The page asks for the mode, checks, downloads in the background and,
//! after the person clicks Restart to update, installs and restarts; nothing here restarts on its own. Every download
//! is checked against the edition's update key, and its signature must name the version the feed announced.
//! A build whose edition has no update feed (dev builds, forks without one) never registers the plugin: mode "off".
//! A .deb or .rpm install is left to the package manager: mode "download" shows the release instead.
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State, ipc::Channel, utils::config::BundleType};
use tauri_plugin_updater::{Update, UpdaterExt};

/// How this install takes updates.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Mode {
    /// No update feed in this build.
    Off,
    /// Downloads, installs and restarts itself (the macOS app, the Windows installers, the AppImage).
    Install,
    /// Says a new version is out and links to it (Linux packages).
    Download,
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Install => "install",
            Self::Download => "download",
        }
    }
}

/// The mode for a build with or without a feed, on `os`, installed from `bundle`. An AppImage can only replace
/// itself when it runs as one (the APPIMAGE variable names its file).
pub fn mode_for(configured: bool, os: &str, bundle: Option<BundleType>, appimage: bool) -> Mode {
    if !configured {
        return Mode::Off;
    }
    match os {
        "linux" if bundle == Some(BundleType::AppImage) && appimage => Mode::Install,
        "linux" => Mode::Download,
        _ => Mode::Install,
    }
}

/// Whether this build's config has an update feed (the edition's `release.updates`, apps/desktop/package.json build:app).
pub fn configured(config: &tauri::Config) -> bool {
    config.plugins.0.contains_key("updater")
}

pub struct Updates {
    mode: Mode,
    found: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
}

impl Updates {
    pub fn new(configured: bool) -> Self {
        let mode = mode_for(
            configured,
            std::env::consts::OS,
            tauri::utils::platform::bundle_type(),
            std::env::var_os("APPIMAGE").is_some(),
        );
        Self {
            mode,
            found: Mutex::new(None),
            bytes: Mutex::new(None),
        }
    }
}

/// A newer version on the feed. `notes` is the manifest's text, one highlight per line.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    version: String,
    notes: String,
    date: Option<String>,
    release_url: Option<String>,
    download_url: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct Progress {
    got: u64,
    total: Option<u64>,
}

/// The release page and the .deb link publish.sh adds to latest.json, when they are https links.
fn link(raw: &serde_json::Value, key: &str) -> Option<String> {
    raw.get(key)
        .and_then(|v| v.as_str())
        .filter(|u| u.starts_with("https://"))
        .map(str::to_owned)
}

fn found(update: &Update) -> Found {
    Found {
        version: update.version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        date: update.date.map(|d| d.to_string()),
        release_url: link(&update.raw_json, "release_url"),
        download_url: link(&update.raw_json, "deb_url").or_else(|| link(&update.raw_json, "release_url")),
    }
}

/// Why a step failed, for the page to say which one and what to try: check, download, verify or install.
#[derive(Serialize, Debug)]
pub struct Failed {
    step: &'static str,
    message: String,
}

impl Failed {
    fn at(step: &'static str, e: impl std::fmt::Display) -> Self {
        Self {
            step,
            message: e.to_string(),
        }
    }
}

/// A check that got no usable feed says only that (the page's advice covers it); anything odder keeps its reason.
fn check_failure(e: &tauri_plugin_updater::Error) -> Failed {
    match e {
        tauri_plugin_updater::Error::ReleaseNotFound => Failed::at("check", ""),
        _ => Failed::at("check", e),
    }
}

/// A download that arrived but whose signature does not check out (wrong key, changed bytes, another version) is
/// verify; anything else on the way is download.
fn download_step(e: &tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => "verify",
        _ => "download",
    }
}

#[tauri::command]
pub fn update_mode(state: State<'_, Updates>) -> &'static str {
    state.mode.name()
}

/// Asks the feed for a newer version. None when this is the newest.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, Updates>) -> Result<Option<Found>, Failed> {
    if state.mode == Mode::Off {
        return Ok(None);
    }
    let update = app
        .updater()
        .map_err(|e| Failed::at("check", e))?
        .check()
        .await
        .map_err(|e| check_failure(&e))?;
    let out = update.as_ref().map(found);
    let mut held = state.found.lock().map_err(|e| Failed::at("check", e))?;
    // a different version than the one downloaded drops the old download
    if held.as_ref().map(|u| &u.version) != update.as_ref().map(|u| &u.version) {
        *state.bytes.lock().map_err(|e| Failed::at("check", e))? = None;
    }
    *held = update;
    Ok(out)
}

/// Downloads the version the last check found and checks its signature; the bytes wait for Restart to update.
#[tauri::command]
pub async fn update_download(
    state: State<'_, Updates>,
    on_progress: Channel<Progress>,
) -> Result<(), Failed> {
    if state.mode != Mode::Install {
        return Err(Failed::at(
            "download",
            "This install updates through its package manager.",
        ));
    }
    let update = state
        .found
        .lock()
        .map_err(|e| Failed::at("download", e))?
        .clone()
        .ok_or_else(|| Failed::at("download", "No update to download."))?;
    let (mut got, mut sent) = (0u64, 0u64);
    let bytes = update
        .download(
            |chunk, total| {
                got += chunk as u64;
                // a message per 256 KB, not per chunk
                if got - sent >= 256 * 1024 || total == Some(got) {
                    sent = got;
                    let _ = on_progress.send(Progress { got, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| Failed::at(download_step(&e), e))?;
    *state.bytes.lock().map_err(|e| Failed::at("download", e))? = Some(bytes);
    Ok(())
}

/// Installs the downloaded update and restarts into it. Only after the person clicked Restart to update; the page
/// holds the button while a print is being sent.
#[tauri::command]
pub fn update_restart(app: AppHandle, state: State<'_, Updates>) -> Result<(), Failed> {
    let update = state
        .found
        .lock()
        .map_err(|e| Failed::at("install", e))?
        .clone()
        .ok_or_else(|| Failed::at("install", "No update to install."))?;
    let bytes = state
        .bytes
        .lock()
        .map_err(|e| Failed::at("install", e))?
        .take()
        .ok_or_else(|| Failed::at("install", "The update has not finished downloading."))?;
    // Windows runs the installer and exits here; it starts the new version when it is done.
    update.install(&bytes).map_err(|e| Failed::at("install", e))?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signature_that_does_not_check_out_is_verify_and_a_lost_connection_is_download() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(download_step(&E::MissingSignedVersion), "verify");
        assert_eq!(download_step(&E::SignatureUtf8("x".into())), "verify");
        assert_eq!(download_step(&E::Network("connection reset".into())), "download");
        assert_eq!(check_failure(&E::ReleaseNotFound).message, "");
        assert_eq!(
            check_failure(&E::Network("timed out".into())).message,
            "`timed out`"
        );
        let f = Failed::at("check", "");
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            serde_json::json!({ "step": "check", "message": "" })
        );
    }

    #[test]
    fn a_build_without_a_feed_never_updates() {
        for os in ["macos", "windows", "linux"] {
            assert_eq!(mode_for(false, os, Some(BundleType::AppImage), true), Mode::Off);
        }
    }

    #[test]
    fn the_mac_app_and_the_windows_installers_update_themselves() {
        assert_eq!(
            mode_for(true, "macos", Some(BundleType::App), false),
            Mode::Install
        );
        assert_eq!(
            mode_for(true, "windows", Some(BundleType::Nsis), false),
            Mode::Install
        );
        assert_eq!(
            mode_for(true, "windows", Some(BundleType::Msi), false),
            Mode::Install
        );
    }

    #[test]
    fn an_appimage_updates_itself_and_a_linux_package_links_to_the_download() {
        assert_eq!(
            mode_for(true, "linux", Some(BundleType::AppImage), true),
            Mode::Install
        );
        assert_eq!(
            mode_for(true, "linux", Some(BundleType::AppImage), false),
            Mode::Download
        );
        assert_eq!(
            mode_for(true, "linux", Some(BundleType::Deb), false),
            Mode::Download
        );
        assert_eq!(
            mode_for(true, "linux", Some(BundleType::Rpm), false),
            Mode::Download
        );
        assert_eq!(mode_for(true, "linux", None, false), Mode::Download);
    }

    #[test]
    fn only_https_links_from_the_feed_reach_the_page() {
        let raw = serde_json::json!({ "release_url": "https://github.com/o/r/releases/tag/desktop-v0.2.0", "deb_url": "javascript:alert(1)" });
        assert_eq!(
            link(&raw, "release_url").as_deref(),
            Some("https://github.com/o/r/releases/tag/desktop-v0.2.0")
        );
        assert_eq!(link(&raw, "deb_url"), None);
        assert_eq!(link(&raw, "missing"), None);
    }
}
