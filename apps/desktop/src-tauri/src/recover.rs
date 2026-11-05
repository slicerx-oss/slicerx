// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A window whose web view stopped: the page's process crashed or was killed (WebView2 on Windows, WebKitGTK on
//! Linux, WKWebView on macOS). The first stop loads the page again at the address it started from, where the page
//! restores the work autosave kept and says what came back (`crash_recovery_take`). A second stop within a minute of
//! the last one does not reload by itself, so a page that keeps crashing cannot loop: a dialog offers Reload or Quit.
//! Every stop writes a crash report (crash.rs).
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use crate::{closing, crash};

/// A second stop this soon after the last one asks instead of reloading.
pub const REPEAT_WINDOW: Duration = Duration::from_secs(60);

const RELOAD: &str = "Reload";
const QUIT: &str = "Quit";
const RESTART: &str = "Restart";

/// What to do about one stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Load the page again, with no question.
    Reload,
    /// Ask: Reload or Quit.
    Ask,
}

/// When the web view last stopped, to tell a first stop from a repeat.
#[derive(Debug, Default)]
pub struct Policy {
    last: Option<Instant>,
}

impl Policy {
    /// The step for a stop at `now`. A stop within `REPEAT_WINDOW` of the one before asks; one later than that counts as
    /// a first stop again.
    pub fn on_stop(&mut self, now: Instant) -> Step {
        let repeat = self
            .last
            .is_some_and(|t| now.saturating_duration_since(t) < REPEAT_WINDOW);
        self.last = Some(now);
        if repeat { Step::Ask } else { Step::Reload }
    }
}

/// What the page loaded after a stop is told (`crash_recovery_take`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    /// The project had unsaved changes when the view stopped, as the page last said (closing.rs).
    pub unsaved: bool,
    /// When it stopped, in ms since the epoch.
    pub at: u64,
}

/// Merges a new stop into one the page has not taken yet: work unsaved at either stop is still unsaved.
pub fn merge(pending: Option<Recovery>, next: Recovery) -> Recovery {
    Recovery {
        unsaved: next.unsaved || pending.is_some_and(|p| p.unsaved),
        at: next.at,
    }
}

/// Why a web view stopped, as each platform reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    /// The page's process crashed or was killed; the web view itself is fine and can load the page again.
    PageProcess(&'static str),
    /// The whole web view runtime is gone (WebView2's browser process); only a new app process brings it back.
    #[cfg_attr(not(windows), allow(dead_code, reason = "only WebView2 reports this"))]
    Runtime,
    /// Nothing to recover from: a helper process the web view restarts itself, a frame, or a deliberate stop.
    Ignore,
}

/// WebView2's `COREWEBVIEW2_PROCESS_FAILED_KIND`. A page that stopped responding is left alone: it may be busy, and a
/// reload would throw away what it is doing.
#[cfg_attr(not(windows), allow(dead_code, reason = "read on Windows, tested everywhere"))]
pub fn windows_cause(kind: i32) -> Cause {
    match kind {
        0 => Cause::Runtime,
        1 => Cause::PageProcess("The web view's page process exited"),
        _ => Cause::Ignore,
    }
}

/// WebKitGTK's `WebKitWebProcessTerminationReason`: 0 crashed, 1 ran out of memory, 2 ended by the app itself.
#[cfg_attr(
    not(target_os = "linux"),
    allow(dead_code, reason = "read on Linux, tested everywhere")
)]
pub fn linux_cause(reason: i32) -> Cause {
    match reason {
        0 => Cause::PageProcess("The web view's page process crashed"),
        1 => Cause::PageProcess("The web view's page process ran out of memory"),
        _ => Cause::Ignore,
    }
}

#[derive(Default)]
struct State {
    policy: Policy,
    pending: Option<Recovery>,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(Mutex::default)
}

/// The address the main window first loaded, which a stopped view is sent back to.
static START: OnceLock<Url> = OnceLock::new();

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Remembers the main window's start address and watches its web view. Call from setup, once the window exists.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(url) = w.url() {
        let _ = START.set(url);
    }
    #[cfg(windows)]
    watch_windows(&w);
    #[cfg(target_os = "linux")]
    watch_linux(&w);
}

/// macOS: tauri reports a stopped content process for each web view (main.rs).
#[cfg(target_os = "macos")]
pub fn webview_terminated<R: Runtime>(webview: &tauri::Webview<R>) {
    stopped(
        webview.app_handle(),
        webview.label(),
        Cause::PageProcess("The window's web content process stopped"),
    );
}

#[cfg(windows)]
fn watch_windows<R: Runtime>(w: &tauri::WebviewWindow<R>) {
    let app = w.app_handle().clone();
    let label = w.label().to_string();
    let _ = w.with_webview(move |pw| {
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND;
        use webview2_com::ProcessFailedEventHandler;
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            if let Some(a) = args {
                // SAFETY: the arguments are live for the duration of the event, which runs on the main thread.
                unsafe { a.ProcessFailedKind(&mut kind)? };
            }
            stopped(&app, &label, windows_cause(kind.0));
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: the controller is live for the duration of the callback, which runs on the main thread.
        unsafe {
            if let Ok(core) = pw.controller().CoreWebView2() {
                let _ = core.add_ProcessFailed(&handler, &mut token);
            }
        }
    });
}

#[cfg(target_os = "linux")]
fn watch_linux<R: Runtime>(w: &tauri::WebviewWindow<R>) {
    let app = w.app_handle().clone();
    let label = w.label().to_string();
    let _ = w.with_webview(move |pw| {
        use webkit2gtk::{WebProcessTerminationReason as Why, WebViewExt};
        pw.inner().connect_web_process_terminated(move |_, reason| {
            let code = match reason {
                Why::Crashed => 0,
                Why::ExceededMemoryLimit => 1,
                _ => 2,
            };
            stopped(&app, &label, linux_cause(code));
        });
    });
}

/// One stop: report it, then reload, ask, or (the runtime gone) offer a restart.
fn stopped<R: Runtime>(app: &AppHandle<R>, label: &str, cause: Cause) {
    let (title, runtime) = match cause {
        Cause::Ignore => return,
        Cause::PageProcess(t) => (t, false),
        Cause::Runtime => ("The web view's browser process exited", true),
    };
    // The page that said "unsaved" is gone; the reloaded one says so again once it has restored the work.
    let unsaved = app.state::<closing::Unsaved>().take();
    let step = {
        let mut s = state().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        s.pending = Some(merge(
            s.pending,
            Recovery {
                unsaved,
                at: now_ms(),
            },
        ));
        if runtime {
            Step::Ask
        } else {
            s.policy.on_stop(Instant::now())
        }
    };
    let what = match (runtime, step) {
        (true, _) => "asked to restart",
        (false, Step::Reload) => "reloaded",
        (false, Step::Ask) => "stopped again within a minute, asked to reload or quit",
    };
    crash::report_webview(title, &format!("{title}; {what}. Unsaved changes: {unsaved}."));
    if runtime {
        ask(app, label, true);
    } else if step == Step::Reload {
        reload(app, label);
    } else {
        ask(app, label, false);
    }
}

fn reload<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(w) = app.get_webview_window(label) else {
        return;
    };
    match START.get() {
        Some(url) => {
            let _ = w.navigate(url.clone());
        }
        None => {
            let _ = w.reload();
        }
    }
}

/// The native dialog after a repeat stop (Reload or Quit) or a lost runtime (Restart or Quit). Closing it quits:
/// the window behind it has nothing to show.
fn ask<R: Runtime>(app: &AppHandle<R>, label: &str, runtime: bool) {
    let name = crate::brand::get().name.clone();
    let (text, ok) = if runtime {
        (
            format!(
                "The view stopped and {name} has to restart to show it again. Work autosaved before it stopped is offered back when {name} opens."
            ),
            RESTART,
        )
    } else {
        (
            format!(
                "The view stopped again shortly after it was reloaded. Reload it, or quit? Work autosaved before it stopped is offered back when {name} opens again."
            ),
            RELOAD,
        )
    };
    let app2 = app.clone();
    let label = label.to_string();
    app.dialog()
        .message(text)
        .title("The view stopped")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), QUIT.into()))
        .show_with_result(move |r| match answer(&r, ok) {
            Answer::Again if runtime => app2.restart(),
            Answer::Again => reload(&app2, &label),
            Answer::Quit => app2.exit(0),
        });
}

#[derive(Debug, PartialEq, Eq)]
enum Answer {
    Again,
    Quit,
}

fn answer(r: &MessageDialogResult, ok: &str) -> Answer {
    match r {
        MessageDialogResult::Ok | MessageDialogResult::Yes => Answer::Again,
        MessageDialogResult::Custom(s) if s == ok => Answer::Again,
        _ => Answer::Quit,
    }
}

/// What the page should say after a stop, once: taking it clears it.
#[tauri::command]
pub fn crash_recovery_take() -> Option<Recovery> {
    state()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .pending
        .take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_stop_reloads() {
        let mut p = Policy::default();
        assert_eq!(p.on_stop(Instant::now()), Step::Reload);
    }

    #[test]
    fn a_second_stop_within_the_window_asks() {
        let mut p = Policy::default();
        let t = Instant::now();
        assert_eq!(p.on_stop(t), Step::Reload);
        assert_eq!(p.on_stop(t + Duration::from_secs(5)), Step::Ask);
        // It keeps asking while stops come close together.
        assert_eq!(p.on_stop(t + Duration::from_secs(50)), Step::Ask);
    }

    #[test]
    fn the_count_starts_over_after_the_window() {
        let mut p = Policy::default();
        let t = Instant::now();
        assert_eq!(p.on_stop(t), Step::Reload);
        assert_eq!(p.on_stop(t + REPEAT_WINDOW), Step::Reload);
        assert_eq!(p.on_stop(t + REPEAT_WINDOW + Duration::from_secs(59)), Step::Ask);
        assert_eq!(
            p.on_stop(t + REPEAT_WINDOW * 3),
            Step::Reload,
            "a stop long after the last one is a first stop"
        );
    }

    #[test]
    fn unsaved_work_from_an_earlier_stop_is_kept_until_the_page_takes_it() {
        let first = Recovery { unsaved: true, at: 1 };
        let second = merge(
            Some(first),
            Recovery {
                unsaved: false,
                at: 2,
            },
        );
        assert_eq!(second, Recovery { unsaved: true, at: 2 });
        assert_eq!(
            merge(
                None,
                Recovery {
                    unsaved: false,
                    at: 3
                }
            ),
            Recovery {
                unsaved: false,
                at: 3
            }
        );
    }

    #[test]
    fn only_a_page_process_that_ended_is_recovered_by_a_reload() {
        assert_eq!(windows_cause(0), Cause::Runtime);
        assert!(matches!(windows_cause(1), Cause::PageProcess(_)));
        // Unresponsive, a frame, a helper process, the GPU process (which WebView2 restarts itself).
        for k in [2, 3, 4, 5, 6, 7, 8, 9] {
            assert_eq!(windows_cause(k), Cause::Ignore, "{k}");
        }
        assert!(matches!(linux_cause(0), Cause::PageProcess(_)));
        assert!(matches!(linux_cause(1), Cause::PageProcess(_)));
        assert_eq!(linux_cause(2), Cause::Ignore, "a stop the app asked for");
    }

    #[test]
    fn the_dialog_quits_unless_the_first_button_was_pressed() {
        assert_eq!(
            answer(&MessageDialogResult::Custom(RELOAD.into()), RELOAD),
            Answer::Again
        );
        assert_eq!(answer(&MessageDialogResult::Ok, RELOAD), Answer::Again);
        assert_eq!(
            answer(&MessageDialogResult::Custom(QUIT.into()), RELOAD),
            Answer::Quit
        );
        assert_eq!(answer(&MessageDialogResult::Cancel, RESTART), Answer::Quit);
    }

    #[test]
    fn the_page_takes_a_recovery_once() {
        state().lock().unwrap().pending = Some(Recovery { unsaved: true, at: 7 });
        assert_eq!(crash_recovery_take(), Some(Recovery { unsaved: true, at: 7 }));
        assert_eq!(crash_recovery_take(), None);
    }
}
