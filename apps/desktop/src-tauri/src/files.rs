// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Files through native dialogs. The webview never passes a path: Rust shows
//! the dialog, keeps what the user picked, and hands back ids and bytes.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct OpenFiles {
    paths: Mutex<HashMap<u32, PathBuf>>,
    next: AtomicU32,
}

#[derive(Clone, serde::Serialize)]
pub struct FileRef {
    id: String,
    name: String,
    size: u64,
    path: String,
}

impl OpenFiles {
    /// Registers a path the system handed to the app, so the webview can read it by id.
    pub fn add(&self, path: PathBuf) -> FileRef {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let out = FileRef {
            id: id.to_string(),
            name,
            size,
            path: path.to_string_lossy().into_owned(),
        };
        self.paths
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id, path);
        out
    }
}

/// Shows the open dialog. `accept` holds extensions such as ".stl".
#[tauri::command]
pub async fn open_files(
    app: AppHandle,
    accept: Vec<String>,
    multiple: bool,
    state: State<'_, OpenFiles>,
) -> Result<Vec<FileRef>, String> {
    let exts: Vec<String> = accept
        .iter()
        .map(|a| a.trim_start_matches('.').to_owned())
        .collect();
    let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
    let dialog = app.dialog().file().add_filter("Models", &ext_refs);
    let picked = if multiple {
        dialog.blocking_pick_files().unwrap_or_default()
    } else {
        dialog.blocking_pick_file().into_iter().collect()
    };
    let mut out = Vec::new();
    for fp in picked {
        let path = fp.into_path().map_err(|e| e.to_string())?;
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push(FileRef {
            id: id.to_string(),
            name,
            size,
            path: path.to_string_lossy().into_owned(),
        });
        state
            .paths
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id, path);
    }
    Ok(out)
}

/// Bytes of a file the user picked in `open_files`.
#[tauri::command]
pub fn read_file(id: u32, state: State<'_, OpenFiles>) -> Result<Response, String> {
    let path = state
        .paths
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&id)
        .cloned()
        .ok_or("that file was not opened through the dialog")?;
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Shows the save dialog and writes the raw request body to the chosen path.
/// Returns the saved file, registered so a later save can write it again by id, or null when the user cancels.
#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    request: Request<'_>,
    state: State<'_, OpenFiles>,
) -> Result<Option<FileRef>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_file expects raw bytes".into());
    };
    let name = request
        .headers()
        .get("x-sx-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("plate.gcode")
        .to_owned();
    let Some(fp) = app.dialog().file().set_file_name(&name).blocking_save_file() else {
        return Ok(None);
    };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Some(state.add(path)))
}

/// Writes the raw request body over a project file the shell already knows by id (`x-sx-id`): one the
/// user opened or saved before. Only .sx3mf projects are written this way; anything else goes through the dialog.
#[tauri::command]
pub fn save_file_to(request: Request<'_>, state: State<'_, OpenFiles>) -> Result<Option<FileRef>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_file_to expects raw bytes".into());
    };
    let id: u32 = request
        .headers()
        .get("x-sx-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("save_file_to needs a file id")?;
    let path = state
        .paths
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&id)
        .cloned()
        .ok_or("that file was not opened or saved through the app")?;
    if !writable_in_place(&path) {
        return Err(format!(
            "only a {} project is saved over in place",
            crate::brand::get().name
        ));
    }
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Some(FileRef {
        id: id.to_string(),
        name,
        size,
        path: path.to_string_lossy().into_owned(),
    }))
}

/// Save without a dialog only writes over SlicerX projects.
pub fn writable_in_place(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("sx3mf"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_project_is_written_in_place() {
        assert!(writable_in_place(std::path::Path::new("/tmp/a.sx3mf")));
        assert!(writable_in_place(std::path::Path::new("C:/x/B.SX3MF")));
        assert!(!writable_in_place(std::path::Path::new("/tmp/a.3mf")));
        assert!(!writable_in_place(std::path::Path::new("/tmp/a.stl")));
    }
}
