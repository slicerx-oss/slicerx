// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Linux: the window toolkit starts before anything else can run, and a launch that cannot reach a display used to
//! end in a panic there (and a crash report). This runs first: when the toolkit cannot start, a launch with a SlicerX
//! already running hands its files and links to it over the session bus, as the single-instance plugin would have, and
//! any other launch says why it cannot start, on stderr and in a log line, and exits.
use std::io::Write;
use std::path::PathBuf;

/// Exit code of a launch that found no display and no SlicerX to hand over to.
pub const NO_DISPLAY_EXIT: i32 = 2;

/// The session bus name and object path the single-instance plugin serves for `identifier`.
pub fn bus_name_and_path(identifier: &str) -> (String, String) {
    let name = format!("{identifier}.SingleInstance");
    let mut path = name.replace('.', "/").replace('-', "_");
    if !path.starts_with('/') {
        path = format!("/{path}");
    }
    (name, path)
}

/// What a launch without a display says, naming what it found in the environment.
pub fn message(app: &str, display: Option<&str>, wayland: Option<&str>) -> String {
    let found = match (
        display.filter(|d| !d.is_empty()),
        wayland.filter(|w| !w.is_empty()),
    ) {
        (None, None) => "Neither DISPLAY nor WAYLAND_DISPLAY is set".to_owned(),
        (d, w) => format!(
            "The display could not be opened (DISPLAY={}, WAYLAND_DISPLAY={})",
            d.unwrap_or("unset"),
            w.unwrap_or("unset")
        ),
    };
    format!(
        "{app} cannot start: no display is available. {found}. Start {app} from your desktop session, or with DISPLAY or WAYLAND_DISPLAY set for it."
    )
}

/// Hands this launch's arguments to a running SlicerX. True when one took them.
fn hand_over(identifier: &str) -> bool {
    let (name, path) = bus_name_and_path(identifier);
    let Ok(conn) = zbus::blocking::Connection::session() else {
        return false;
    };
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    conn.call_method(
        Some(name.as_str()),
        path.as_str(),
        Some("org.SingleInstance.DBus"),
        "ExecuteCallback",
        &(args, cwd.to_str().unwrap_or_default()),
    )
    .is_ok()
}

/// The startup log: `$XDG_STATE_HOME/<identifier>/startup.log`, else under `~/.local/state`.
fn log_path(identifier: &str) -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("state")))?;
    Some(base.join(identifier).join("startup.log"))
}

fn log_line(identifier: &str, line: &str) {
    let Some(path) = log_path(identifier) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let _ = writeln!(f, "{secs} {line}");
    }
}

/// Starts the toolkit, or hands over to a running SlicerX, or exits with a message. Returns only when the toolkit is up.
pub fn preflight(identifier: &str, app: &str) {
    if gtk::init().is_ok() {
        return;
    }
    if hand_over(identifier) {
        let line = format!("{app} is already running; this launch passed its files and links to it.");
        eprintln!("{line}");
        log_line(identifier, &line);
        std::process::exit(0);
    }
    let display = std::env::var("DISPLAY").ok();
    let wayland = std::env::var("WAYLAND_DISPLAY").ok();
    let line = message(app, display.as_deref(), wayland.as_deref());
    eprintln!("{line}");
    log_line(identifier, &line);
    std::process::exit(NO_DISPLAY_EXIT);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bus_name_matches_the_single_instance_plugin() {
        assert_eq!(
            bus_name_and_path("app.slicerx.desktop"),
            (
                "app.slicerx.desktop.SingleInstance".to_owned(),
                "/app/slicerx/desktop/SingleInstance".to_owned()
            )
        );
        assert_eq!(
            bus_name_and_path("app.slicerx.desktop.agent-bridge").1,
            "/app/slicerx/desktop/agent_bridge/SingleInstance"
        );
    }

    #[test]
    fn message_names_what_the_environment_has() {
        assert!(message("SlicerX", None, None).contains("Neither DISPLAY nor WAYLAND_DISPLAY is set"));
        assert!(message("SlicerX", Some(""), None).contains("Neither DISPLAY"));
        let m = message("SlicerX", Some(":0"), None);
        assert!(m.contains("DISPLAY=:0, WAYLAND_DISPLAY=unset"), "{m}");
        assert!(m.starts_with("SlicerX cannot start: no display is available."));
    }

    #[test]
    fn log_goes_under_the_state_folder() {
        let p = log_path("app.slicerx.desktop");
        assert!(p.is_some_and(|p| p.ends_with("app.slicerx.desktop/startup.log")));
    }
}
