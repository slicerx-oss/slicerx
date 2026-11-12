// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The license files the app carries: `licenses/` in its resources (tauri.conf.json, and in a build with the exact
//! kernel the kernel's files, apps/desktop/release/kernel-config.mjs). About opens the folder.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The folder under the app's resources that holds the license files.
fn licenses_dir(resources: &Path) -> Result<PathBuf, String> {
    let dir = resources.join("licenses");
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err(format!("no license files at {}", dir.display()))
    }
}

/// Shows the license files in the system file manager, through the system's own handler (launch.rs).
#[tauri::command]
pub fn licenses_open_folder(app: AppHandle) -> Result<(), String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let dir = licenses_dir(&resources)?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_folder_and_says_where_it_looked_when_it_is_missing() {
        let root = std::env::temp_dir().join(format!("sx-licenses-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let err = licenses_dir(&root).unwrap_err();
        assert!(
            err.contains(&root.join("licenses").display().to_string()),
            "{err}"
        );
        std::fs::create_dir_all(root.join("licenses")).unwrap();
        assert_eq!(licenses_dir(&root).unwrap(), root.join("licenses"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_bundle_puts_the_license_files_in_that_folder() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json is JSON");
        let resources = conf["bundle"]["resources"].as_object().expect("a resource map");
        for (from, to) in [
            ("../../../LICENSE-APACHE", "licenses/LICENSE-APACHE.txt"),
            ("../../../NOTICE", "licenses/NOTICE.txt"),
            ("../../../THIRD-PARTY.md", "licenses/THIRD-PARTY.md"),
        ] {
            assert_eq!(resources.get(from).and_then(|v| v.as_str()), Some(to), "{from}");
            let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(from);
            assert!(source.is_file(), "{} is missing", source.display());
        }
    }
}
