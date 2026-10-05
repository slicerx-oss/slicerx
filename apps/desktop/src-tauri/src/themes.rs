// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The themes folder: `<app data>/themes`. Each `*.json` file is one theme. The webview
//! validates the text; Rust only lists small files and opens the folder.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// A theme file is small. Bigger files are skipped, never read.
const MAX_BYTES: u64 = 16 * 1024;
const MAX_FILES: usize = 64;

fn themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("themes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The text of every theme file, in name order.
fn read_themes(dir: &std::path::Path) -> Vec<String> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("json")))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
        .into_iter()
        .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() <= MAX_BYTES))
        .take(MAX_FILES)
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .collect()
}

#[tauri::command]
pub fn themes_list(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(read_themes(&themes_dir(&app)?))
}

#[tauri::command]
pub fn themes_open_folder(app: AppHandle) -> Result<(), String> {
    let dir = themes_dir(&app)?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_small_json_files_in_name_order() {
        let dir = std::env::temp_dir().join(format!("sx-themes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b.json"), "{\"id\":\"b\"}").unwrap();
        std::fs::write(dir.join("a.json"), "{\"id\":\"a\"}").unwrap();
        std::fs::write(dir.join("notes.txt"), "skip").unwrap();
        std::fs::write(dir.join("big.json"), vec![b' '; (MAX_BYTES + 1) as usize]).unwrap();
        let out = read_themes(&dir);
        assert_eq!(
            out,
            vec!["{\"id\":\"a\"}".to_string(), "{\"id\":\"b\"}".to_string()]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
