// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The 3D mouse reader. The web views on macOS and Linux have no WebHID, so the shell reads the device and hands
//! the page each raw input report (`sx-spacemouse-report`, the report id first) and where the device stands
//! (`sx-spacemouse-status`). The page parses the reports (packages/ui/viewport/src/spacemouse.ts) and moves the view,
//! so all three platforms share one path. It runs only while Settings > Controls > 3D mouse is on.
//!
//! The device is opened shared, never seized. When another program holds it on to itself (the maker's own driver on
//! some systems) opening fails, and the page says so instead of fighting the driver for it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};

/// Maker vendor ids: the older devices carry Logitech's, the newer ones their own.
pub const VENDORS: [u16; 2] = [0x046d, 0x256f];
/// HID usage of a six axis controller: Generic Desktop, Multi-axis Controller.
pub const USAGE_PAGE: u16 = 0x01;
pub const USAGE: u16 = 0x08;

/// How long a read waits, so a stop is noticed within this time.
const READ_MS: i32 = 100;
/// How often to look for a device while none is plugged in or it could not be opened.
const SCAN: Duration = Duration::from_millis(1500);

/// Where the device stands, as the page's status line reads it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Status {
    /// No 3D mouse plugged in.
    None,
    Connected {
        name: String,
    },
    /// It could not be opened because another program keeps it.
    Busy {
        name: String,
    },
    Error {
        message: String,
    },
}

/// A six axis controller from one of the makers.
pub fn is_space_mouse(vendor: u16, usage_page: u16, usage: u16) -> bool {
    VENDORS.contains(&vendor) && usage_page == USAGE_PAGE && usage == USAGE
}

/// What a failed open means, on this platform.
pub fn open_failure(name: &str, error: &str) -> Status {
    open_failure_on(name, error, cfg!(windows), cfg!(target_os = "linux"))
}

/// What a failed open means. A device another program holds (macOS: exclusive access; Windows: access denied or a
/// sharing violation) is busy; a Linux device the user may not read needs a udev rule; anything else is an error.
/// The raw error goes to the log, never to the page's status line.
fn open_failure_on(name: &str, error: &str, windows: bool, linux: bool) -> Status {
    let e = error.to_ascii_lowercase();
    if e.contains("exclusive")
        || e.contains("e00002c5")
        || e.contains("sharing violation")
        || e.contains("busy")
        || (windows && e.contains("access is denied"))
    {
        return Status::Busy {
            name: name.to_owned(),
        };
    }
    if linux && e.contains("permission denied") {
        return Status::Error {
            message: format!(
                "No permission to read {name}. Add a udev rule that lets your user read it, then plug it in again."
            ),
        };
    }
    eprintln!("3D mouse: can't open {name}: {error}");
    Status::Error {
        message: format!("Can't open {name}. Unplug it and plug it in again."),
    }
}

/// The reader: its stop flag while one runs, and the last status it said, so a page that loads while it runs
/// (a reload) hears where the device stands.
#[derive(Default)]
pub struct SpaceMouse(Arc<Mutex<Reader>>);

#[derive(Default)]
struct Reader {
    stop: Option<Arc<AtomicBool>>,
    last: Option<Status>,
}

/// What a start does: run a new reader with this stop flag, or tell the page the running one's last status.
enum Begin {
    Spawn(Arc<AtomicBool>),
    Running(Option<Status>),
}

impl SpaceMouse {
    fn lock(&self) -> std::sync::MutexGuard<'_, Reader> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn begin(&self) -> Begin {
        let mut r = self.lock();
        if r.stop.is_some() {
            return Begin::Running(r.last.clone());
        }
        let stop = Arc::new(AtomicBool::new(false));
        r.stop = Some(stop.clone());
        r.last = None;
        Begin::Spawn(stop)
    }

    fn end(&self) {
        let mut r = self.lock();
        if let Some(stop) = r.stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
        r.last = None;
    }

    /// Notes a status from the reader that owns `stop`; a reader already told to stop no longer speaks for the device.
    /// Answers whether it is new.
    fn note(&self, stop: &Arc<AtomicBool>, s: &Status) -> bool {
        let mut r = self.lock();
        if !r.stop.as_ref().is_some_and(|f| Arc::ptr_eq(f, stop)) || r.last.as_ref() == Some(s) {
            return false;
        }
        r.last = Some(s.clone());
        true
    }
}

/// Starts reading the 3D mouse. When a reader already runs (the page was reloaded), says its last status again.
#[tauri::command]
pub fn spacemouse_start(app: AppHandle, state: State<'_, SpaceMouse>) {
    match state.begin() {
        Begin::Running(Some(s)) => {
            let _ = app.emit("sx-spacemouse-status", &s);
        }
        Begin::Running(None) => {}
        Begin::Spawn(stop) => {
            let shared = SpaceMouse(state.0.clone());
            let spawned = std::thread::Builder::new()
                .name("spacemouse".into())
                .spawn(move || read_loop(&app, &shared, &stop));
            if spawned.is_err() {
                state.end();
            }
        }
    }
}

/// Stops reading and lets the device go. The page also calls it as it loads, so a reader a reloaded page left
/// running stops until the setting asks for it again.
#[tauri::command]
pub fn spacemouse_stop(state: State<'_, SpaceMouse>) {
    state.end();
}

fn read_loop(app: &AppHandle, shared: &SpaceMouse, stop: &Arc<AtomicBool>) {
    let say = |s: Status| {
        if shared.note(stop, &s) {
            let _ = app.emit("sx-spacemouse-status", &s);
        }
    };
    // only the makers' devices are listed (scan), never every HID device on the system
    hidapi::HidApi::disable_device_discovery();
    let mut api = match hidapi::HidApi::new() {
        Ok(api) => api,
        Err(e) => {
            eprintln!("3D mouse: can't start HID: {e}");
            return say(Status::Error {
                message: "Can't look for a 3D mouse on this computer.".to_owned(),
            });
        }
    };
    while !stop.load(Ordering::Relaxed) {
        let Some((info, name)) = scan(&mut api) else {
            say(Status::None);
            wait(stop, SCAN);
            continue;
        };
        let device = match info.open_device(&api) {
            Ok(d) => d,
            Err(e) => {
                say(open_failure(&name, &e.to_string()));
                wait(stop, SCAN);
                continue;
            }
        };
        say(Status::Connected { name });
        let mut buf = [0u8; 64];
        while !stop.load(Ordering::Relaxed) {
            match device.read_timeout(&mut buf, READ_MS) {
                Ok(0) => {}
                Ok(n) => {
                    let _ = app.emit("sx-spacemouse-report", &buf[..n]);
                }
                // unplugged: look for it again
                Err(_) => break,
            }
        }
        if !stop.load(Ordering::Relaxed) {
            say(Status::None);
        }
    }
}

/// The first plugged-in 3D mouse and its name.
fn scan(api: &mut hidapi::HidApi) -> Option<(hidapi::DeviceInfo, String)> {
    api.reset_devices().ok()?;
    for vendor in VENDORS {
        api.add_devices(vendor, 0).ok()?;
    }
    let d = api
        .device_list()
        .find(|d| is_space_mouse(d.vendor_id(), d.usage_page(), d.usage()))?;
    let name = d
        .product_string()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("3D mouse");
    Some((d.clone(), name.to_owned()))
}

/// Sleeps up to `d`, waking early on a stop.
fn wait(stop: &AtomicBool, d: Duration) {
    let end = Instant::now() + d;
    while !stop.load(Ordering::Relaxed) && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_a_six_axis_controller_from_the_makers_only() {
        assert!(is_space_mouse(0x256f, 0x01, 0x08));
        assert!(is_space_mouse(0x046d, 0x01, 0x08));
        // a Logitech keyboard or mouse collection is not one
        assert!(!is_space_mouse(0x046d, 0x01, 0x06));
        assert!(!is_space_mouse(0x046d, 0x01, 0x02));
        assert!(!is_space_mouse(0x1234, 0x01, 0x08));
    }

    #[test]
    fn a_device_held_by_another_program_is_busy() {
        let busy = Status::Busy {
            name: "SpaceMouse Compact".into(),
        };
        let mac =
            "IOHIDDeviceOpen failed: (0xE00002C5) (iokit/common) exclusive access and device already open";
        for (windows, linux) in [(false, false), (true, false), (false, true)] {
            assert_eq!(open_failure_on("SpaceMouse Compact", mac, windows, linux), busy);
            assert_eq!(
                open_failure_on("SpaceMouse Compact", "Resource busy", windows, linux),
                busy
            );
            assert_eq!(
                open_failure_on(
                    "SpaceMouse Compact",
                    "The process cannot access the file: sharing violation",
                    windows,
                    linux
                ),
                busy
            );
        }
        // Windows' access denied is a device another program holds; elsewhere it is not read that way
        assert_eq!(
            open_failure_on(
                "SpaceMouse Compact",
                "Access is denied. (0x80070005)",
                true,
                false
            ),
            busy
        );
        assert!(matches!(
            open_failure_on("SpaceMouse Compact", "Access is denied.", false, false),
            Status::Error { .. }
        ));
    }

    #[test]
    fn a_linux_device_without_read_access_asks_for_a_udev_rule() {
        let Status::Error { message } = open_failure_on(
            "SpaceMouse Compact",
            "Permission denied (os error 13)",
            false,
            true,
        ) else {
            panic!("not an error");
        };
        assert!(message.contains("udev rule"), "{message}");
        let Status::Error { message } = open_failure_on(
            "SpaceMouse Compact",
            "Permission denied (os error 13)",
            false,
            false,
        ) else {
            panic!("not an error");
        };
        assert!(!message.contains("udev"), "{message}");
    }

    #[test]
    fn other_failures_read_plainly_without_the_raw_error() {
        let Status::Error { message } =
            open_failure_on("SpaceMouse Compact", "hid_open_path: 0xdeadbeef", false, false)
        else {
            panic!("not an error");
        };
        assert_eq!(
            message,
            "Can't open SpaceMouse Compact. Unplug it and plug it in again."
        );
    }

    #[test]
    fn a_reloaded_page_hears_the_running_readers_last_status() {
        let sm = SpaceMouse::default();
        let Begin::Spawn(flag) = sm.begin() else {
            panic!("no reader ran yet")
        };
        let connected = Status::Connected {
            name: "SpaceMouse Wireless".into(),
        };
        assert!(sm.note(&flag, &connected));
        // said once: the same status again is not news
        assert!(!sm.note(&flag, &connected));
        // the reloaded page's start: no second reader, the status said again
        assert!(matches!(sm.begin(), Begin::Running(Some(s)) if s == connected));
        // its load stops the reader; a reader told to stop no longer speaks
        sm.end();
        assert!(flag.load(Ordering::Relaxed));
        assert!(!sm.note(&flag, &Status::None));
        let Begin::Spawn(again) = sm.begin() else {
            panic!("a stopped reader blocks a new one")
        };
        assert!(!Arc::ptr_eq(&flag, &again));
        assert_eq!(sm.lock().last, None);
    }

    #[test]
    fn statuses_read_as_the_page_expects() {
        assert_eq!(
            serde_json::to_string(&Status::None).unwrap(),
            r#"{"state":"none"}"#
        );
        assert_eq!(
            serde_json::to_string(&Status::Connected {
                name: "SpaceMouse Wireless".into()
            })
            .unwrap(),
            r#"{"state":"connected","name":"SpaceMouse Wireless"}"#
        );
        assert_eq!(
            serde_json::to_string(&Status::Busy { name: "X".into() }).unwrap(),
            r#"{"state":"busy","name":"X"}"#
        );
        assert_eq!(
            serde_json::to_string(&Status::Error { message: "m".into() }).unwrap(),
            r#"{"state":"error","message":"m"}"#
        );
    }
}
