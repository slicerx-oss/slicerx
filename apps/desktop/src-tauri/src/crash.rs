// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Crash reports from the shell (docs/bug-intake.md). A panic hook writes a report file before the
//! process goes down, and on macOS so does the web view's content process stopping. The page takes
//! the files at its next start (`crash_take`), queues them as bug reports and acknowledges them
//! (`crash_ack`), which deletes them. `crash_take` also counts page loads, so the page can tell
//! that it reloaded within one run of the shell. On Windows the web view's own reload keys are off.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Once, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

static DIR: OnceLock<PathBuf> = OnceLock::new();
static PAGE_LOADS: AtomicU32 = AtomicU32::new(0);
static SEQ: AtomicU32 = AtomicU32::new(0);
static HOOK: Once = Once::new();

const PREFIX: &str = "crash-";
/// Keeps a runaway panic loop from filling the disk.
const MAX_FILES: usize = 20;

/// One report file, as the page receives it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCrash {
    #[serde(default)]
    pub file: String,
    /// `panic` or `webview`.
    pub source: String,
    pub title: String,
    pub stack: String,
    /// ms since the epoch.
    pub at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Taken {
    reports: Vec<NativeCrash>,
    page_loads: u32,
    os: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Where panics before `set_dir` land, and where the next launch also looks.
fn fallback_dir() -> PathBuf {
    std::env::temp_dir().join("slicerx-crash-reports")
}

fn dir() -> PathBuf {
    DIR.get().cloned().unwrap_or_else(fallback_dir)
}

/// The reports folder in the app data folder. Called from setup, once the identifier is known.
pub fn set_dir(app: &AppHandle) {
    if let Ok(base) = app.path().app_data_dir() {
        let d = base.join("crash-reports");
        if std::fs::create_dir_all(&d).is_ok() {
            let _ = DIR.set(d);
        }
    }
}

/// Writes one report file. Never panics: it runs inside the panic hook.
pub fn write_report(dir: &Path, source: &str, title: &str, stack: &str) -> Option<PathBuf> {
    std::fs::create_dir_all(dir).ok()?;
    let count = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| is_report_name(&e.file_name().to_string_lossy()))
        .count();
    if count >= MAX_FILES {
        return None;
    }
    let at = now_ms();
    let report = NativeCrash {
        file: String::new(),
        source: source.into(),
        title: title.chars().take(200).collect(),
        stack: stack.chars().take(50_000).collect(),
        at,
    };
    let path = dir.join(format!(
        "{PREFIX}{at}-{}-{}.json",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&path, serde_json::to_vec(&report).ok()?).ok()?;
    Some(path)
}

/// What a panic report says: the message as the title, then where, which thread and the backtrace.
pub fn panic_report(message: &str, location: &str, thread: &str, backtrace: &str) -> (String, String) {
    let first = message.lines().next().unwrap_or("");
    let title = format!("Rust panic: {first}");
    let stack = format!("panicked at {location} on thread '{thread}':\n{message}\n\n{backtrace}");
    (title, stack)
}

/// Installs the panic hook, which writes a report and then runs the default hook. Call first in main.
pub fn install_hook() {
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let payload = info.payload();
            let message = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic with a non-text payload".into());
            let location = info.location().map_or_else(
                || "an unknown place".into(),
                |l| format!("{}:{}:{}", l.file(), l.line(), l.column()),
            );
            let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
            let backtrace = std::backtrace::Backtrace::force_capture().to_string();
            let (title, stack) = panic_report(&message, &location, &thread, &backtrace);
            let _ = write_report(&dir(), "panic", &title, &stack);
            previous(info);
        }));
    });
}

/// The web view's content process stopped (macOS): record it and load the page again.
#[cfg(target_os = "macos")]
pub fn webview_terminated<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    let _ = write_report(&dir(), "webview", "The window's web content process stopped", "");
    let _ = webview.reload();
}

/// WebView2 acts on browser keys the page leaves alone: F5 and Ctrl+R reload the window, which also ends the
/// session the reload report is about. Release builds turn them off; debug builds keep them for development.
#[cfg(all(windows, not(debug_assertions)))]
pub fn disable_browser_keys<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(|w| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows::core::Interface;
        // SAFETY: the controller is live for the duration of the callback, which runs on the main thread.
        unsafe {
            if let Ok(settings) = w.controller().CoreWebView2().and_then(|c| c.Settings()) {
                if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                    let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                }
            }
        }
    });
}

fn is_report_name(name: &str) -> bool {
    name.starts_with(PREFIX) && name.ends_with(".json") && !name.contains(['/', '\\']) && !name.contains("..")
}

/// Every report file in `dirs`, oldest first. Unreadable files are skipped and left for `ack`.
pub fn read_reports(dirs: &[PathBuf]) -> Vec<NativeCrash> {
    let mut out = Vec::new();
    for d in dirs {
        let Ok(entries) = std::fs::read_dir(d) else {
            continue;
        };
        for e in entries.filter_map(Result::ok) {
            let name = e.file_name().to_string_lossy().into_owned();
            if !is_report_name(&name) {
                continue;
            }
            match std::fs::read(e.path())
                .ok()
                .and_then(|b| serde_json::from_slice::<NativeCrash>(&b).ok())
            {
                Some(mut r) => {
                    r.file = name;
                    out.push(r);
                }
                // A half-written file from a crash inside the hook: nothing to send.
                None => {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    out.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.file.cmp(&b.file)));
    out
}

/// Deletes the named report files from `dirs`; names that are not report files are ignored.
pub fn remove_reports(dirs: &[PathBuf], files: &[String]) {
    for f in files.iter().filter(|f| is_report_name(f)) {
        for d in dirs {
            let _ = std::fs::remove_file(d.join(f));
        }
    }
}

fn dirs() -> Vec<PathBuf> {
    let mut v = vec![dir()];
    if v[0] != fallback_dir() {
        v.push(fallback_dir());
    }
    v
}

/// The operating system and version, read once.
pub fn os_description() -> String {
    static OS: OnceLock<String> = OnceLock::new();
    OS.get_or_init(|| {
        let arch = std::env::consts::ARCH;
        let name = os_name();
        format!("{name} ({arch})")
    })
    .clone()
}

#[cfg(target_os = "macos")]
fn os_name() -> String {
    let v = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if v.is_empty() {
        "macOS".into()
    } else {
        format!("macOS {v}")
    }
}

#[cfg(target_os = "linux")]
fn os_name() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| {
            s.lines().find_map(|l| {
                l.strip_prefix("PRETTY_NAME=")
                    .map(|v| v.trim_matches('"').to_string())
            })
        })
        .unwrap_or_else(|| "Linux".into())
}

#[cfg(target_os = "windows")]
fn os_name() -> String {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("cmd")
        .args(["/c", "ver"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    // "Microsoft Windows [Version 10.0.22631.4317]"
    out.split("Version ")
        .nth(1)
        .and_then(|v| v.split(']').next())
        .map_or_else(|| "Windows".into(), |v| format!("Windows {}", v.trim()))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn os_name() -> String {
    std::env::consts::OS.into()
}

/// The reports waiting, the page load count (raised when `page_load` is true) and the OS.
#[tauri::command]
pub fn crash_take(page_load: bool) -> Taken {
    let page_loads = if page_load {
        PAGE_LOADS.fetch_add(1, Ordering::SeqCst) + 1
    } else {
        PAGE_LOADS.load(Ordering::SeqCst)
    };
    Taken {
        reports: read_reports(&dirs()),
        page_loads,
        os: os_description(),
    }
}

/// Deletes reports the page has queued.
#[tauri::command]
pub fn crash_ack(files: Vec<String>) {
    remove_reports(&dirs(), &files);
}

/// Developer test: a real panic on a background thread, through the hook. The app keeps running.
#[tauri::command]
pub fn crash_test_panic() {
    let handle = std::thread::Builder::new()
        .name("sx-test-crash".into())
        .spawn(|| panic!("test panic from the developer command"));
    if let Ok(h) = handle {
        let _ = h.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sx-crash-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn writes_reads_and_acknowledges_reports() {
        let d = temp("roundtrip");
        let first = write_report(&d, "panic", "Rust panic: boom", "panicked at src/x.rs:1:1").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        write_report(&d, "webview", "The window's web content process stopped", "").unwrap();
        std::fs::write(d.join("notes.txt"), "not a report").unwrap();
        let got = read_reports(std::slice::from_ref(&d));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].file, first.file_name().unwrap().to_string_lossy());
        assert_eq!(
            (got[0].source.as_str(), got[0].title.as_str()),
            ("panic", "Rust panic: boom")
        );
        assert!(got[0].at > 0 && got[0].at <= got[1].at);
        remove_reports(
            std::slice::from_ref(&d),
            &[got[0].file.clone(), "../notes.txt".into(), "notes.txt".into()],
        );
        let left = read_reports(std::slice::from_ref(&d));
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].source, "webview");
        assert!(d.join("notes.txt").exists(), "ack only deletes report files");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn drops_half_written_files_and_caps_the_folder() {
        let d = temp("cap");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("crash-1-1-1.json"), "{\"source\":").unwrap();
        assert!(read_reports(std::slice::from_ref(&d)).is_empty());
        assert!(!d.join("crash-1-1-1.json").exists());
        for _ in 0..MAX_FILES {
            write_report(&d, "panic", "t", "s").unwrap();
        }
        assert!(write_report(&d, "panic", "t", "s").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rejects_names_outside_the_folder() {
        assert!(is_report_name("crash-1-2-3.json"));
        for bad in [
            "../crash-1.json",
            "crash-1.txt",
            "crash-..json",
            "x/crash-1.json",
            "crash-1\\a.json",
            "other.json",
        ] {
            assert!(!is_report_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_panic_report_names_the_place_the_thread_and_the_frames() {
        let (title, stack) = panic_report(
            "index out of bounds\nmore",
            "src/slicing.rs:12:5",
            "main",
            "   0: sx_core::slice::run",
        );
        assert_eq!(title, "Rust panic: index out of bounds");
        assert!(
            stack.starts_with(
                "panicked at src/slicing.rs:12:5 on thread 'main':\nindex out of bounds\nmore\n\n"
            )
        );
        assert!(stack.ends_with("sx_core::slice::run"));
    }

    #[test]
    fn the_hook_writes_a_report_and_the_app_goes_on() {
        let d = temp("hook");
        let _ = DIR.set(d.clone());
        install_hook();
        let r = std::thread::Builder::new()
            .name("sx-hook-test".into())
            .spawn(|| panic!("hook test {}", 42))
            .unwrap()
            .join();
        assert!(r.is_err());
        let got = read_reports(&[dir()]);
        let ours = got
            .iter()
            .find(|c| c.title == "Rust panic: hook test 42")
            .expect("a report for the panic");
        assert_eq!(ours.source, "panic");
        assert!(ours.stack.contains("on thread 'sx-hook-test'"), "{}", ours.stack);
        assert!(ours.stack.contains("crash.rs"), "{}", ours.stack);
        remove_reports(&[dir()], &[ours.file.clone()]);
    }

    #[test]
    fn counts_page_loads_only_when_asked() {
        let before = crash_take(false).page_loads;
        let after = crash_take(true).page_loads;
        assert_eq!(after, before + 1);
        assert_eq!(crash_take(false).page_loads, after);
    }

    #[test]
    fn names_the_operating_system() {
        let os = os_description();
        assert!(os.ends_with(&format!("({})", std::env::consts::ARCH)), "{os}");
        assert!(os.len() > std::env::consts::ARCH.len() + 3, "{os}");
    }
}
