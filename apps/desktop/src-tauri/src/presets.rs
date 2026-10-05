// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! First run: the user presets of an installed OrcaSlicer, Bambu Studio or PrusaSlicer. Read only. The
//! webview names a slicer, never a path; a file is read only when it lies under one of the three folders.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const MAX_FILE: u64 = 5 * 1024 * 1024;
const MAX_PRESETS: usize = 2000;

#[derive(Serialize)]
pub struct InstalledPreset {
    app: String,
    kind: String,
    name: String,
    path: String,
}

/// The folder a slicer keeps its settings in, under the system's per-user config folder
/// (`Application Support` on macOS, `%APPDATA%` on Windows, `~/.config` on Linux).
fn root(app: &AppHandle, slicer: &str) -> Option<PathBuf> {
    let base = app.path().config_dir().ok()?;
    match slicer {
        "orcaslicer" => Some(base.join("OrcaSlicer").join("user")),
        "bambu-studio" => Some(base.join("BambuStudio").join("user")),
        "prusaslicer" => Some(base.join("PrusaSlicer")),
        _ => None,
    }
}

fn files(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case(ext))
        })
        .collect();
    out.sort();
    out
}

fn name_of(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json"))
        && let Some(n) = std::fs::read_to_string(path)
            .ok()
            .filter(|t| t.len() as u64 <= MAX_FILE)
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_owned))
    {
        return n;
    }
    stem
}

/// Every user preset of a slicer found under `root`. Orca and Bambu keep them at `user/<account>/{machine,filament,process}`
/// (Bambu's own filament bases in `filament/base`);
/// PrusaSlicer at `{printer,filament,print}` right under its folder.
pub fn scan_root(slicer: &str, root: &Path) -> Vec<InstalledPreset> {
    let mut out = Vec::new();
    let mut add = |dir: PathBuf, kind: &str, ext: &str| {
        for p in files(&dir, ext) {
            if out.len() < MAX_PRESETS {
                out.push(InstalledPreset {
                    app: slicer.to_owned(),
                    kind: kind.to_owned(),
                    name: name_of(&p),
                    path: p.to_string_lossy().into_owned(),
                });
            }
        }
    };
    if slicer == "prusaslicer" {
        for (sub, kind) in [
            ("printer", "printer"),
            ("filament", "filament"),
            ("print", "process"),
        ] {
            add(root.join(sub), kind, "ini");
        }
    } else if let Ok(rd) = std::fs::read_dir(root) {
        let mut accounts: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        accounts.sort();
        for acct in accounts {
            for (sub, kind) in [
                ("machine", "printer"),
                ("filament", "filament"),
                ("process", "process"),
            ] {
                add(acct.join(sub), kind, "json");
            }
            // Bambu Studio keeps filaments made with Create filament, which others inherit from, one folder down.
            add(acct.join("filament").join("base"), "filament", "json");
        }
    }
    out
}

/// The user presets of an installed slicer. Empty when it is not installed or has none.
#[tauri::command]
pub fn presets_scan(app: AppHandle, slicer: String) -> Vec<InstalledPreset> {
    root(&app, &slicer)
        .map(|r| scan_root(&slicer, &r))
        .unwrap_or_default()
}

/// The text of one preset file found by `presets_scan`.
#[tauri::command]
pub fn presets_read(app: AppHandle, path: String) -> Result<String, String> {
    let target = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
    let inside = ["orcaslicer", "bambu-studio", "prusaslicer"]
        .iter()
        .filter_map(|s| root(&app, s))
        .filter_map(|r| r.canonicalize().ok())
        .any(|r| target.starts_with(r));
    let ext_ok = target
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json") || e.eq_ignore_ascii_case("ini"));
    if !inside || !ext_ok {
        return Err("That file is not a preset of an installed slicer.".to_owned());
    }
    if std::fs::metadata(&target).map(|m| m.len()).unwrap_or(u64::MAX) > MAX_FILE {
        return Err("That preset file is too large.".to_owned());
    }
    std::fs::read_to_string(&target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sx-presets-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn orca_user_folders_list_each_kind_with_the_name_inside_the_file() {
        let root = tmp("orca");
        for (sub, file, body) in [
            ("filament", "a.json", r#"{"name":"My PETG"}"#),
            ("machine", "b.json", "{}"),
            ("process", "c.json", r#"{"name":"0.16 fine"}"#),
        ] {
            let d = root.join("1234").join(sub);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join(file), body).unwrap();
        }
        let found = scan_root("orcaslicer", &root);
        let names: Vec<(String, String)> = found.iter().map(|p| (p.kind.clone(), p.name.clone())).collect();
        assert!(names.contains(&("filament".into(), "My PETG".into())));
        assert!(names.contains(&("printer".into(), "b".into())));
        assert!(names.contains(&("process".into(), "0.16 fine".into())));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bambu_base_filaments_are_listed_with_the_others() {
        let root = tmp("bambu");
        let d = root.join("42").join("filament");
        std::fs::create_dir_all(d.join("base")).unwrap();
        std::fs::write(
            d.join("tuned.json"),
            r#"{"name":"Matte Tuned","inherits":"Matte @A1M"}"#,
        )
        .unwrap();
        std::fs::write(
            d.join("base").join("matte.json"),
            r#"{"name":"Matte @A1M","inherits":""}"#,
        )
        .unwrap();
        let names: Vec<String> = scan_root("bambu-studio", &root)
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["Matte Tuned".to_owned(), "Matte @A1M".to_owned()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prusaslicer_ini_files_map_print_to_process() {
        let root = tmp("prusa");
        std::fs::create_dir_all(root.join("print")).unwrap();
        std::fs::write(root.join("print").join("fast.ini"), "layer_height = 0.3").unwrap();
        std::fs::write(root.join("print").join("note.txt"), "x").unwrap();
        let found = scan_root("prusaslicer", &root);
        assert_eq!(found.len(), 1);
        assert_eq!(
            (found[0].kind.as_str(), found[0].name.as_str()),
            ("process", "fast")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_slicer_has_no_presets() {
        assert!(scan_root("orcaslicer", Path::new("/definitely/not/here")).is_empty());
    }
}
