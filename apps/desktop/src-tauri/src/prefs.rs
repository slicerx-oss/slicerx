// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The shell's copy of the app's prefs (settings, setup progress): `<app data>/prefs.json`. The page keeps its prefs in
//! the web view's storage, which reaches disk a moment after a change; an app quit right after a change (25 to 100 ms
//! on Windows) lost it. Each save also comes here and is on disk before the call returns, and the next launch hands
//! the file's copy to the page before any of its scripts run (`window.__sxPrefs`); the page takes the newer copy.

use std::path::PathBuf;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Prefs are a few KB; anything far bigger is not ours and is neither read nor written.
const MAX_BYTES: usize = 2 * 1024 * 1024;
const FILE: &str = "prefs.json";

/// The app's data folder, as Tauri's `app_data_dir` gives it, worked out before the app exists (the launch script
/// needs it first). Read and write both use this one, so they always meet.
fn dir(identifier: &str) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")));
    base.map(|b| b.join(identifier))
}

/// The script that hands the saved prefs to the page, or nothing when there is no usable file.
fn launch_script(saved: Option<String>) -> Option<String> {
    let text = saved.filter(|t| t.len() <= MAX_BYTES && serde_json::from_str::<serde_json::Value>(t).is_ok())?;
    // a JSON string literal of the text: safe to put in a script whatever the text holds
    Some(format!("window.__sxPrefs = {};", serde_json::to_string(&text).ok()?))
}

/// The plugin that runs the launch script in the page, before the app's own scripts.
pub fn plugin<R: Runtime>(identifier: &str) -> TauriPlugin<R> {
    let saved = dir(identifier).and_then(|d| std::fs::read_to_string(d.join(FILE)).ok());
    let builder = Builder::new("sx-prefs");
    match launch_script(saved) {
        Some(script) => builder.js_init_script(script).build(),
        None => builder.build(),
    }
}

/// Writes `json` beside the old file and moves it over, so a quit mid-write leaves the old copy whole.
fn write(dir: &std::path::Path, json: &str) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(json.as_bytes())?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, dir.join(FILE))
}

/// Saves the page's prefs. Done before it returns.
#[tauri::command]
pub fn prefs_save(app: tauri::AppHandle, json: String) -> Result<(), String> {
    if json.len() > MAX_BYTES || serde_json::from_str::<serde_json::Value>(&json).is_err() {
        return Err("not prefs".into());
    }
    let dir = dir(&app.config().identifier).ok_or("no data folder")?;
    write(&dir, &json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{launch_script, write, FILE};

    #[test]
    fn hands_the_saved_prefs_to_the_page_as_a_string() {
        let s = launch_script(Some(r#"{"savedAt":5,"x":"</script>'\""}"#.into())).unwrap();
        assert!(s.starts_with("window.__sxPrefs = \""));
        let lit = s.trim_start_matches("window.__sxPrefs = ").trim_end_matches(';');
        assert_eq!(serde_json::from_str::<String>(lit).unwrap(), r#"{"savedAt":5,"x":"</script>'\""}"#);
    }

    #[test]
    fn hands_nothing_for_a_missing_broken_or_huge_file() {
        assert!(launch_script(None).is_none());
        assert!(launch_script(Some("{not json".into())).is_none());
        assert!(launch_script(Some(format!("\"{}\"", "a".repeat(3 * 1024 * 1024)))).is_none());
    }

    #[test]
    fn a_save_replaces_the_file_whole() {
        let dir = std::env::temp_dir().join(format!("sx-prefs-test-{}", std::process::id()));
        write(&dir, r#"{"a":1}"#).unwrap();
        write(&dir, r#"{"a":2}"#).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(FILE)).unwrap(), r#"{"a":2}"#);
        assert!(!dir.join(format!("{FILE}.tmp")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
