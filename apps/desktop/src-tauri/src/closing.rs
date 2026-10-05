// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Closing the window. The webview reports whether the project has unsaved changes. A close with nothing
//! to lose is never handed to the webview, so it cannot wait on a page that is busy or already gone: the
//! window closes and the app exits. A close with unsaved changes is held, and the webview asks (save,
//! discard, cancel) and then calls `quit_app`.
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, State, Window, WindowEvent};

/// Whether the project has changes that were never saved, as the webview last said.
#[derive(Default)]
pub struct Unsaved(AtomicBool);

#[derive(Debug, PartialEq, Eq)]
pub enum OnClose {
    /// Let the window close; the app exits with its last window.
    Exit,
    /// Hold the close and ask the webview to confirm.
    Ask,
}

pub fn on_close(unsaved: bool) -> OnClose {
    if unsaved { OnClose::Ask } else { OnClose::Exit }
}

/// The webview's answer to "are there unsaved changes", sent whenever it changes.
#[tauri::command]
pub fn unsaved_set(state: State<'_, Unsaved>, unsaved: bool) {
    state.0.store(unsaved, Ordering::Relaxed);
}

/// Quits after the person confirmed leaving unsaved changes behind.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

pub fn window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event
        && window.label() == "main"
        && on_close(window.state::<Unsaved>().0.load(Ordering::Relaxed)) == OnClose::Ask
    {
        api.prevent_close();
        let _ = window.emit("sx-close-requested", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_close_with_nothing_unsaved_exits_without_asking_the_page() {
        assert_eq!(on_close(false), OnClose::Exit);
    }

    #[test]
    fn a_close_with_unsaved_changes_is_held_for_the_page_to_confirm() {
        assert_eq!(on_close(true), OnClose::Ask);
    }
}
