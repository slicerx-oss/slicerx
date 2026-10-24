// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The shell's copy of the app's prefs (settings, setup progress): `<app data>/prefs.json`. The page keeps its prefs in
//! the web view's storage, which reaches disk a moment after a change; an app quit right after a change (25 to 100 ms
//! on Windows) lost it. Each save also comes here and is on disk before the call returns, and the next launch hands
//! the file's copy to the page before any of its scripts run (`window.__sxPrefs`); the page takes the newer copy.
//!
//! The page's background (the applied theme's) is kept beside it, `<app data>/window-background`, so the next launch
//! opens the window in it and the page's first paint has it too, before the theme is applied: no black or default fill
//! shows before the app.

use std::path::PathBuf;
use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

/// Prefs are a few KB; anything far bigger is not ours and is neither read nor written.
const MAX_BYTES: usize = 2 * 1024 * 1024;
const FILE: &str = "prefs.json";
const BACKGROUND: &str = "window-background";

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
    let text =
        saved.filter(|t| t.len() <= MAX_BYTES && serde_json::from_str::<serde_json::Value>(t).is_ok())?;
    // a JSON string literal of the text: safe to put in a script whatever the text holds
    Some(format!(
        "window.__sxPrefs = {};",
        serde_json::to_string(&text).ok()?
    ))
}

/// `#rrggbb`, the one form a background is saved and used in.
fn parse_hex(text: &str) -> Option<(u8, u8, u8)> {
    let hex = text.trim().strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let n = u32::from_str_radix(hex, 16).ok()?;
    Some(((n >> 16) as u8, (n >> 8) as u8, n as u8))
}

/// The page's background the last run saved, if there is a usable one.
pub fn saved_background(identifier: &str) -> Option<(u8, u8, u8)> {
    dir(identifier)
        .and_then(|d| std::fs::read_to_string(d.join(BACKGROUND)).ok())
        .and_then(|t| parse_hex(&t))
}

/// The script that gives the page's first paint the saved background: the page's ground token on the root element,
/// until the app applies its theme over it.
fn background_script(color: Option<(u8, u8, u8)>) -> Option<String> {
    let (r, g, b) = color?;
    Some(format!(
        "(function(c){{function s(e){{e.style.setProperty('--ink-0',c);e.style.backgroundColor='var(--ink-0)'}}var e=document.documentElement;if(e){{s(e);return}}\
new MutationObserver(function(_,o){{var e=document.documentElement;if(e){{s(e);o.disconnect()}}}}).observe(document,{{childList:true}})}})('#{r:02x}{g:02x}{b:02x}');"
    ))
}

/// The plugin that runs the launch scripts in the page, before the app's own scripts.
pub fn plugin<R: Runtime>(identifier: &str) -> TauriPlugin<R> {
    let saved = dir(identifier).and_then(|d| std::fs::read_to_string(d.join(FILE)).ok());
    let builder = Builder::new("sx-prefs");
    let scripts: Vec<String> = [
        background_script(saved_background(identifier)),
        launch_script(saved),
    ]
    .into_iter()
    .flatten()
    .collect();
    if scripts.is_empty() {
        builder.build()
    } else {
        builder.js_init_script(scripts.join("\n")).build()
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

/// Saves the page's background for the next launch and paints the window with it now (a theme switch, or the
/// window grown before the page fills the new space).
#[tauri::command]
pub fn window_background_save(window: tauri::WebviewWindow, color: String) -> Result<(), String> {
    use tauri::Manager;
    let (r, g, b) = parse_hex(&color).ok_or("not a color")?;
    let _ = window.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
    let dir = dir(&window.app_handle().config().identifier).ok_or("no data folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(BACKGROUND), format!("#{r:02x}{g:02x}{b:02x}")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{FILE, background_script, launch_script, parse_hex, write};

    #[test]
    fn takes_only_a_six_digit_hex_background() {
        assert_eq!(parse_hex("#282a36\n"), Some((0x28, 0x2a, 0x36)));
        assert_eq!(parse_hex("#FAFAFA"), Some((0xfa, 0xfa, 0xfa)));
        for bad in ["", "282a36", "#282a3", "#282a36ff", "#28 a36", "#gg2a36", "red"] {
            assert_eq!(parse_hex(bad), None, "{bad}");
        }
    }

    #[test]
    fn gives_the_first_paint_the_saved_background() {
        assert!(background_script(None).is_none());
        let s = background_script(Some((0xfa, 0xf8, 0xf5))).unwrap();
        assert!(s.contains("setProperty('--ink-0',c)"));
        assert!(s.ends_with("('#faf8f5');"));
    }

    #[test]
    fn hands_the_saved_prefs_to_the_page_as_a_string() {
        let s = launch_script(Some(r#"{"savedAt":5,"x":"</script>'\""}"#.into())).unwrap();
        assert!(s.starts_with("window.__sxPrefs = \""));
        let lit = s.trim_start_matches("window.__sxPrefs = ").trim_end_matches(';');
        assert_eq!(
            serde_json::from_str::<String>(lit).unwrap(),
            r#"{"savedAt":5,"x":"</script>'\""}"#
        );
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
