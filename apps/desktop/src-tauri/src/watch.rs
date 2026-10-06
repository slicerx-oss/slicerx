// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The print watch: `sx-watch` runs beside the app as a sidecar and reads camera frames from the hub on this
//! computer. The release build puts the program next to the app's executable and the local model
//! (`sx-watch-siglip2.onnx`) in the resources folder. Without the program or the model nothing starts, and
//! nothing starts on Intel Macs, where ONNX Runtime has no build and the bundled watch is arm64 only.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Watch(Mutex<Option<Child>>);

fn exe_name() -> &'static str {
    if cfg!(windows) { "sx-watch.exe" } else { "sx-watch" }
}

/// The sidecar and the model, when this build has them.
pub fn locate(exe_dir: Option<PathBuf>, resources: Option<PathBuf>) -> Option<(PathBuf, PathBuf)> {
    if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        return None;
    }
    let program = exe_dir.map(|d| d.join(exe_name())).filter(|p| p.is_file())?;
    let model = resources
        .iter()
        .map(|r| r.join("sx-watch-siglip2.onnx"))
        .chain(program.parent().map(|d| d.join("sx-watch-siglip2.onnx")))
        .find(|p| p.is_file())?;
    Some((program, model))
}

/// Starts the watch once, pointed at the hub this app runs. A watch that cannot start leaves the app as it was.
pub fn start(app: &AppHandle, hub_url: &str) {
    let state = app.state::<Watch>();
    let mut slot = state.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(child) = slot.as_mut()
        && matches!(child.try_wait(), Ok(None))
    {
        return;
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from));
    let Some((program, model)) = locate(exe_dir, app.path().resource_dir().ok()) else {
        return;
    };
    let mut watch = Command::new(program);
    let child = crate::launch::no_window(&mut watch)
        .arg("--url")
        .arg(hub_url)
        .arg("--model")
        .arg(model)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    *slot = child.ok();
}

/// Stops the watch this app started, by its own handle.
pub fn stop(app: &AppHandle) {
    if let Some(mut child) = app
        .state::<Watch>()
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    fn nothing_starts_without_both_the_program_and_the_model() {
        let d = std::env::temp_dir().join(format!("sx-watch-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert!(locate(Some(d.clone()), Some(d.clone())).is_none());
        std::fs::write(d.join(exe_name()), "x").unwrap();
        assert!(locate(Some(d.clone()), Some(d.clone())).is_none());
        std::fs::write(d.join("sx-watch-siglip2.onnx"), "m").unwrap();
        assert!(locate(Some(d.clone()), Some(d.clone())).is_some());
        let _ = std::fs::remove_dir_all(&d);
    }
}
