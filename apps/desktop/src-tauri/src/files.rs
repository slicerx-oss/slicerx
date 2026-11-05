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

impl FileRef {
    /// The path the system handed over, to tell two handovers of one file apart from two files.
    pub fn path(&self) -> &str {
        &self.path
    }
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

/// Bytes of a file the user picked in `open_files`. Read off the main thread: a large file must not hold up the
/// window (closing it, quitting) while it loads.
#[tauri::command]
pub async fn read_file(id: u32, state: State<'_, OpenFiles>) -> Result<Response, String> {
    let path = state
        .paths
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&id)
        .cloned()
        .ok_or("that file was not opened through the dialog")?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path)
            .map(Response::new)
            .map_err(|e| format!("{}: {e}", path.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The largest file read beside an opened one.
const MAX_BESIDE: u64 = 256 * 1024 * 1024;

/// A file an OBJ or its MTL names, in the OBJ's own folder: a plain relative name (subfolders are fine), no parent
/// steps, no absolute path or drive, and only a material or an image. No part of the name may be only dots and
/// spaces, or end in a dot or a space: Windows drops those from the end of a name, so ".. " would read as "..".
fn beside(opened: &std::path::Path, name: &str) -> Option<PathBuf> {
    if !opened.extension().is_some_and(|e| e.eq_ignore_ascii_case("obj")) {
        return None;
    }
    let name = name.trim().replace('\\', "/");
    let plain = !name.is_empty()
        && !name.starts_with('/')
        && !name.contains([':', '\0'])
        && name
            .split('/')
            .all(|s| !s.is_empty() && !s.chars().all(|c| c == '.' || c == ' ') && !s.ends_with(['.', ' ']));
    let kind = std::path::Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ["mtl", "png", "jpg", "jpeg"].contains(&e.to_ascii_lowercase().as_str()));
    if !plain || !kind {
        return None;
    }
    let mut path = opened.parent()?.to_path_buf();
    for part in name.split('/') {
        path.push(part);
    }
    Some(path)
}

/// Whether `m` (read without following links) is a link: a symbolic link, or on Windows any reparse point, which
/// covers junctions.
fn is_link(m: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    m.file_type().is_symlink()
}

/// Opens `path` without following a link at its end: on Windows the link itself opens (and `is_link` then refuses
/// it); elsewhere the file opened must be the one `before` describes, so a swap after the check is caught.
fn open_plain(path: &std::path::Path, before: &std::fs::Metadata) -> Option<std::fs::File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        let _ = before;
        let f = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .ok()?;
        let m = f.metadata().ok()?;
        (m.is_file() && !is_link(&m)).then_some(f)
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::MetadataExt as _;
        let f = std::fs::File::open(path).ok()?;
        let m = f.metadata().ok()?;
        (m.is_file() && m.dev() == before.dev() && m.ino() == before.ino()).then_some(f)
    }
}

/// The bytes of a file an opened OBJ names (see `beside`), at most `max` of them. None when there is no such file,
/// when it is larger than `max`, or when it is not a plain file inside the OBJ's own folder: every step from the
/// folder down is checked without following links, a link or junction anywhere on the way counts as outside, and the
/// file's real path must still start with the folder's. The read stops at `max`, so a file that grows after the
/// check cannot pass the cap.
fn read_beside_file(opened: &std::path::Path, name: &str, max: u64) -> Option<Vec<u8>> {
    use std::io::Read as _;
    let path = beside(opened, name)?;
    let dir = opened.parent()?;
    let base = std::fs::canonicalize(dir).ok()?;
    let mut at = dir.to_path_buf();
    let rest = path.strip_prefix(dir).ok()?;
    let mut last = None;
    for part in rest.components() {
        at.push(part);
        let m = std::fs::symlink_metadata(&at).ok()?;
        if is_link(&m) {
            return None;
        }
        last = Some(m);
    }
    let meta = last?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    if !std::fs::canonicalize(&path).ok()?.starts_with(&base) {
        return None;
    }
    let file = open_plain(&path, &meta)?;
    let mut out = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    file.take(max.saturating_add(1)).read_to_end(&mut out).ok()?;
    (out.len() as u64 <= max).then_some(out)
}

/// Bytes of a material or image file an opened OBJ names, read from the OBJ's folder (see `read_beside_file`), at
/// most `max` bytes (and never past 256 MB), or no bytes when there is no such file or it may not be read. Only for
/// an OBJ the shell knows by id.
#[tauri::command]
pub async fn read_beside(
    id: u32,
    name: String,
    max: Option<u64>,
    state: State<'_, OpenFiles>,
) -> Result<Response, String> {
    let opened = state
        .paths
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&id)
        .cloned()
        .ok_or("that file was not opened through the dialog")?;
    let max = max.unwrap_or(MAX_BESIDE).min(MAX_BESIDE);
    tauri::async_runtime::spawn_blocking(move || {
        Response::new(read_beside_file(&opened, &name, max).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())
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
    let name = crate::header::text(&request, "x-sx-name").unwrap_or_else(|| "plate.gcode".to_owned());
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
    replace_file(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
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

/// Where [`replace_file`] writes the new bytes before they take the file's place: beside it, so the
/// rename stays on one volume.
fn staging(path: &std::path::Path) -> std::path::PathBuf {
    let mut name = std::ffi::OsString::from(".");
    name.push(path.file_name().unwrap_or_default());
    name.push(".saving");
    path.with_file_name(name)
}

/// Writes `bytes` over `path` so the old file stays whole until the new one is: written beside it, then
/// renamed over it. A save that fails partway (a full disk, a drive pulled out) loses nothing.
fn replace_file(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = staging(path);
    let written = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
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
    fn only_materials_and_images_beside_an_obj_are_read() {
        let obj = std::path::Path::new("/models/cube.obj");
        assert_eq!(
            beside(obj, "cube.mtl"),
            Some(PathBuf::from("/models").join("cube.mtl"))
        );
        assert_eq!(
            beside(obj, "tex\\a.PNG"),
            Some(PathBuf::from("/models").join("tex").join("a.PNG"))
        );
        for bad in [
            "../secret.png",
            "/etc/a.png",
            "C:/a.png",
            "a.exe",
            "tex/../a.png",
            "",
            "./a.png",
        ] {
            assert_eq!(beside(obj, bad), None, "{bad}");
        }
        assert_eq!(beside(std::path::Path::new("/models/cube.3mf"), "a.png"), None);
    }

    /// A fresh folder for one test: `<tmp>/sx-beside-<name>/models` holds the OBJ, and a secret sits one up.
    fn folder(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("sx-beside-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let models = root.join("models");
        std::fs::create_dir_all(models.join("tex")).unwrap();
        std::fs::create_dir_all(root.join("outside")).unwrap();
        std::fs::write(models.join("cube.obj"), "mtllib cube.mtl\n").unwrap();
        std::fs::write(models.join("cube.mtl"), "newmtl a\nmap_Kd tex/a.png\n").unwrap();
        std::fs::write(models.join("tex").join("a.png"), "png").unwrap();
        std::fs::write(root.join("secret.png"), "secret").unwrap();
        std::fs::write(root.join("outside").join("a.png"), "secret").unwrap();
        (root, models)
    }

    #[cfg(windows)]
    fn link_file(target: &std::path::Path, at: &std::path::Path) {
        std::os::windows::fs::symlink_file(target, at).unwrap();
    }
    #[cfg(not(windows))]
    fn link_file(target: &std::path::Path, at: &std::path::Path) {
        std::os::unix::fs::symlink(target, at).unwrap();
    }

    #[test]
    fn a_plain_file_beside_the_obj_is_read_within_its_cap() {
        let (root, models) = folder("plain");
        let obj = models.join("cube.obj");
        assert_eq!(
            read_beside_file(&obj, "tex/a.png", 100).as_deref(),
            Some(&b"png"[..])
        );
        assert_eq!(
            read_beside_file(&obj, "tex\\a.png", 3).as_deref(),
            Some(&b"png"[..])
        );
        assert_eq!(read_beside_file(&obj, "tex/a.png", 2), None);
        assert_eq!(read_beside_file(&obj, "tex/none.png", 100), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_symbolic_link_out_of_the_folder_is_not_followed() {
        let (root, models) = folder("symlink");
        let obj = models.join("cube.obj");
        link_file(&root.join("secret.png"), &models.join("tex.png"));
        link_file(&root.join("secret.png"), &models.join("tex").join("b.png"));
        assert_eq!(read_beside_file(&obj, "tex.png", 100), None);
        assert_eq!(read_beside_file(&obj, "tex/b.png", 100), None);
        // a link that stays inside is refused too: no link is followed at all
        link_file(&models.join("tex").join("a.png"), &models.join("inside.png"));
        assert_eq!(read_beside_file(&obj, "inside.png", 100), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_the_folder_is_not_followed() {
        let (root, models) = folder("junction");
        let obj = models.join("cube.obj");
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(models.join("maps"))
            .arg(root.join("outside"))
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "mklink /J");
        assert!(models.join("maps").join("a.png").exists());
        assert_eq!(read_beside_file(&obj, "maps/a.png", 100), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn names_of_only_dots_and_spaces_never_climb_out() {
        let (root, models) = folder("dots");
        let obj = models.join("cube.obj");
        for bad in [
            ".. /secret.png",
            "... /secret.png",
            " ../secret.png",
            "tex/.. /../secret.png",
            "tex. /a.png",
            "a.png.",
            "tex /a.png",
        ] {
            assert_eq!(read_beside_file(&obj, bad, 100), None, "{bad:?}");
            assert_eq!(beside(&obj, bad), None, "{bad:?}");
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn only_a_project_is_written_in_place() {
        assert!(writable_in_place(std::path::Path::new("/tmp/a.sx3mf")));
        assert!(writable_in_place(std::path::Path::new("C:/x/B.SX3MF")));
        assert!(!writable_in_place(std::path::Path::new("/tmp/a.3mf")));
        assert!(!writable_in_place(std::path::Path::new("/tmp/a.stl")));
    }

    #[test]
    fn a_failed_save_leaves_the_project_as_it_was() {
        let d = std::env::temp_dir().join(format!("sx-replace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("lid.sx3mf");
        std::fs::write(&p, b"first").unwrap();
        replace_file(&p, b"second").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"second");
        // The new bytes cannot be written (a folder stands where they go): the saved project stays whole.
        std::fs::create_dir_all(staging(&p)).unwrap();
        assert!(replace_file(&p, b"third").is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"second");
        let _ = std::fs::remove_dir_all(&d);
    }
}
