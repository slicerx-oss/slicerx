// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Prints for a Bambu Lab printer with Developer Mode off go through Bambu Connect, Bambu Lab's own
//! app for third-party software. The hand-off is the URL scheme on Bambu Lab's wiki
//! (https://wiki.bambulab.com/en/software/bambu-connect, "Launching Bambu Connect from Third-Party
//! Software", and https://wiki.bambulab.com/en/software/third-party-integration):
//! `bambu-connect://import-file?path=<absolute path>&name=<name>&version=1.0.0`, path and name
//! encoded as `encodeURIComponent` encodes them, version fixed at 1.0.0. The webview sends bytes and
//! a name; the shell picks the path, so the webview never names one.
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

/// What the hand-off came to: Bambu Connect opened the file, it is not installed, or Bambu Lab makes
/// none for this system (Linux, "under development" on the wiki).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Opened,
    Missing,
    Unsupported,
}

/// Files handed over before this long ago are removed: Bambu Connect has read them by then.
const KEEP: Duration = Duration::from_secs(24 * 60 * 60);

/// Writes the raw request body to the app's cache under `x-sx-name` and opens it in Bambu Connect,
/// titled `x-sx-title`. Both headers are percent-encoded by the webview.
#[tauri::command]
pub async fn bambu_connect_open(app: AppHandle, request: Request<'_>) -> Result<Outcome, String> {
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return Ok(Outcome::Unsupported);
    }
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("bambu_connect_open expects raw bytes".into());
    };
    let header = |k: &str| {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(percent_decode)
    };
    let name = safe_file_name(&header("x-sx-name").unwrap_or_default());
    let title = header("x-sx-title").unwrap_or_else(|| name.clone());
    if !installed() {
        return Ok(Outcome::Missing);
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("bambu-connect");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    prune(&dir);
    let path = dir.join(&name);
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    if open(&import_url(&path, &title))? {
        Ok(Outcome::Opened)
    } else {
        Ok(Outcome::Missing)
    }
}

/// The import link for the file at `path`, shown in Bambu Connect as `name`.
pub fn import_url(path: &Path, name: &str) -> String {
    format!(
        "bambu-connect://import-file?path={}&name={}&version=1.0.0",
        encode_uri_component(&path.to_string_lossy()),
        encode_uri_component(name)
    )
}

/// JavaScript's `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` as UTF-8 escapes.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// Undoes `encodeURIComponent`; text that is not a valid escape stays as it is.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| char::from(c).to_digit(16);
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2]))
        {
            out.push(u8::try_from(h * 16 + l).unwrap_or(b'?'));
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A plain file name: no folders, nothing a file system refuses, and a .gcode.3mf ending.
fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim().trim_start_matches('.').to_owned();
    let stem = clean
        .strip_suffix(".gcode.3mf")
        .or_else(|| clean.strip_suffix(".3mf"))
        .unwrap_or(&clean);
    let stem = if stem.is_empty() { "plate" } else { stem };
    format!("{stem}.gcode.3mf")
}

/// Removes files handed over earlier than [`KEEP`].
fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    let old: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| {
            e.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .is_some_and(|age| age > KEEP)
        })
        .map(|e| e.path())
        .collect();
    for p in old {
        let _ = std::fs::remove_file(p);
    }
}

/// Whether a Bambu Connect that takes the link is installed: on Windows the `bambu-connect` scheme is
/// registered. macOS answers when the link is opened.
#[cfg(target_os = "windows")]
fn installed() -> bool {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: no console flashes up.
    std::process::Command::new("reg")
        .args(["query", r"HKCR\bambu-connect"])
        .creation_flags(0x0800_0000)
        .output()
        .is_ok_and(|o| o.status.success())
}

#[cfg(not(target_os = "windows"))]
fn installed() -> bool {
    true
}

/// Hands the link to the system, which starts Bambu Connect with it. False when no app takes the
/// link: `open` exits with an error when Launch Services knows no app for the scheme.
#[cfg(target_os = "macos")]
fn open(url: &str) -> Result<bool, String> {
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .output()
        .map(|o| o.status.success())
        .map_err(|e| e.to_string())
}

/// Hands the link to the system, which starts Bambu Connect with it. ShellExecute, not `cmd /C
/// start`, which would split the link at its `&`.
#[cfg(not(target_os = "macos"))]
fn open(url: &str) -> Result<bool, String> {
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map(|()| true)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_link_matches_the_wiki_example() {
        // Bambu Lab's wiki: bambu-connect://import-file?path=%2Ftmp%2Fcube.gcode.3mf&name=Cube&version=1.0.0
        assert_eq!(
            import_url(Path::new("/tmp/cube.gcode.3mf"), "Cube"),
            "bambu-connect://import-file?path=%2Ftmp%2Fcube.gcode.3mf&name=Cube&version=1.0.0"
        );
    }

    #[test]
    fn path_and_name_are_encoded_as_encode_uri_component_does() {
        assert_eq!(
            encode_uri_component("C:\\Users\\Ana Lee\\a&b=c (1).gcode.3mf"),
            "C%3A%5CUsers%5CAna%20Lee%5Ca%26b%3Dc%20(1).gcode.3mf"
        );
        assert_eq!(encode_uri_component("Würfel"), "W%C3%BCrfel");
        assert_eq!(percent_decode("W%C3%BCrfel%20plate"), "Würfel plate");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn the_file_name_stays_a_plain_gcode_3mf() {
        assert_eq!(safe_file_name("../../etc/cube.gcode.3mf"), "cube.gcode.3mf");
        assert_eq!(safe_file_name("C:\\x\\Bay 1: lid?.3mf"), "Bay 1_ lid_.gcode.3mf");
        assert_eq!(safe_file_name("lid"), "lid.gcode.3mf");
        assert_eq!(safe_file_name(""), "plate.gcode.3mf");
        assert_eq!(safe_file_name(".hidden"), "hidden.gcode.3mf");
    }
}
