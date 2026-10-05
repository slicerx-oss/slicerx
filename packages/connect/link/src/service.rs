// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Running the hub without a terminal: a macOS login item (a launchd user agent) or a systemd
//! user service on Linux. `sx-link service install` writes the file and loads it;
//! `sx-link service print` shows it without changing anything.
use std::path::{Path, PathBuf};

/// launchd label and systemd unit name.
pub const SERVICE_LABEL: &str = "app.slicerx.hub";
const SYSTEMD_UNIT: &str = "sx-link.service";

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The launchd user agent: starts at login, restarts if it stops, logs to the state directory.
pub fn launch_agent_plist(exe: &Path, state_dir: &Path) -> String {
    let exe = xml_escape(&exe.display().to_string());
    let dir = xml_escape(&state_dir.display().to_string());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>--state-dir</string>
    <string>{dir}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>{dir}/sx-link.log</string>
  <key>StandardErrorPath</key>
  <string>{dir}/sx-link.log</string>
</dict>
</plist>
"#
    )
}

fn systemd_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// A systemd user unit (`systemctl --user`). The system wide unit for a Raspberry Pi or NAS is
/// `deploy/sx-link.service`.
pub fn systemd_user_unit(exe: &Path, state_dir: &Path) -> String {
    format!(
        "[Unit]\nDescription=SlicerX printer hub (sx-link)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart={} --headless --state-dir {}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
        systemd_quote(&exe.display().to_string()),
        systemd_quote(&state_dir.display().to_string()),
    )
}

/// Where the service file goes for this user, and its contents.
pub fn service_file(exe: &Path, state_dir: &Path) -> Option<(PathBuf, String)> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    if cfg!(target_os = "macos") {
        Some((
            home.join("Library/LaunchAgents")
                .join(format!("{SERVICE_LABEL}.plist")),
            launch_agent_plist(exe, state_dir),
        ))
    } else if cfg!(target_os = "linux") {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map_or_else(|| home.join(".config"), PathBuf::from);
        Some((
            config.join("systemd/user").join(SYSTEMD_UNIT),
            systemd_user_unit(exe, state_dir),
        ))
    } else {
        None
    }
}

/// The commands that load (`install`) or unload the service after the file is written.
pub fn service_commands(file: &Path, install: bool) -> Vec<Vec<String>> {
    let f = file.display().to_string();
    if cfg!(target_os = "macos") {
        // `gui/$UID` is filled in by the caller from `id -u`.
        if install {
            vec![vec!["launchctl".into(), "bootstrap".into(), "gui/$UID".into(), f]]
        } else {
            vec![vec!["launchctl".into(), "bootout".into(), "gui/$UID".into(), f]]
        }
    } else if install {
        vec![
            vec!["systemctl".into(), "--user".into(), "daemon-reload".into()],
            vec![
                "systemctl".into(),
                "--user".into(),
                "enable".into(),
                "--now".into(),
                SYSTEMD_UNIT.into(),
            ],
        ]
    } else {
        vec![vec![
            "systemctl".into(),
            "--user".into(),
            "disable".into(),
            "--now".into(),
            SYSTEMD_UNIT.into(),
        ]]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_login_item_runs_the_hub_with_its_state_dir_and_restarts_it() {
        let p = launch_agent_plist(
            Path::new("/Applications/SlicerX.app/Contents/MacOS/sx-link"),
            Path::new("/Users/a&b/Library/Application Support/SlicerX/hub"),
        );
        assert!(p.contains("<string>app.slicerx.hub</string>"));
        assert!(p.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(p.contains("<key>KeepAlive</key>\n  <true/>"));
        assert!(p.contains("/Users/a&amp;b/Library/Application Support/SlicerX/hub"));
        assert!(!p.contains("a&b"), "XML is escaped");
    }

    #[test]
    fn the_user_unit_quotes_paths_and_runs_headless() {
        let u = systemd_user_unit(
            Path::new("/opt/sx link/sx-link"),
            Path::new("/home/pi/.local/state/slicerx/hub"),
        );
        assert!(u.contains(
            "ExecStart=\"/opt/sx link/sx-link\" --headless --state-dir \"/home/pi/.local/state/slicerx/hub\""
        ));
        assert!(u.contains("Restart=on-failure"));
        assert!(u.contains("WantedBy=default.target"));
    }
}
