// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-link. See README.md.
use std::path::PathBuf;
use std::sync::Arc;

use sx_connect::{FileSecrets, KeychainSecrets, SecretStore};
use sx_link::{
    APP_CODE_SECRET, BrokerGate, DEFAULT_PORT, INBOX_TOKEN_SECRET, InboxConfig, LinkConfig, MdnsConfig,
    PairLimits, default_state_dir, read_agent_code, read_pairing_code, serve_with_approvals, service,
};
use sx_permit::ApprovalBroker;

const USAGE: &str = "usage:
  sx-link [--port 47615] [--state-dir DIR | --no-state] [--headless] [--secrets keychain|file]
          [--allow-origin ORIGIN] [--inbox-url https://cloud.example] [--no-mdns] [--loopback]
          [--detector PATH-TO-SX-WATCH]
                                                 --detector starts the camera guard's detector and hands
                                                 it its code over stdin; the code is never on disk
                                                 without --port, 47615 (a test-hub build: the port a
                                                 test or dev run sets, 1024 or above)
                                                 --loopback keeps every socket on 127.0.0.1 (tests): the
                                                 phone listener, printer discovery and direct video, mDNS off
  sx-link code [--agent] [--state-dir DIR]
                                                 print the running hub's app code, with --agent the code
                                                 for the MCP server and other tools
  sx-link service print|install|uninstall [--state-dir DIR]
                                                 run the hub as a login item (macOS) or a user service (Linux)";

/// A white-label edition's name for the text sx-link prints, from the resolved edition config `SLICERX_CONFIG` names
/// (the file the MCP server and the cloud service read too). Without one it says `SlicerX`.
fn edition_name() -> Option<String> {
    let path = std::env::var_os("SLICERX_CONFIG")?;
    let config: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let name = config.pointer("/brand/name")?.as_str()?.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

#[tokio::main]
async fn main() {
    if let Some(name) = edition_name() {
        sx_link::set_app_name(&name);
    }
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("code") => {
            args.remove(0);
            return print_code(&args);
        }
        Some("service") => {
            args.remove(0);
            return service_cmd(&args);
        }
        _ => {}
    }
    run(args).await;
}

fn state_dir_arg(args: &[String]) -> Option<PathBuf> {
    args.iter()
        .position(|a| a == "--state-dir")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .or_else(default_state_dir)
}

fn print_code(args: &[String]) {
    let Some(dir) = state_dir_arg(args) else {
        fail("no state directory; pass --state-dir");
    };
    let agent = args.iter().any(|a| a == "--agent");
    if args.iter().any(|a| a == "--watch") {
        fail(
            "the detector code is never written down: start the detector with `sx-link --detector PATH`, or let the app start it",
        );
    }
    let read = if agent {
        read_agent_code(&dir)
    } else {
        // The app code is in the keychain when the hub uses it, else in the state directory.
        read_pairing_code(&dir).or_else(|e| {
            sx_connect::Secrets::get(&KeychainSecrets::new("slicerx-printers"), APP_CODE_SECRET).ok_or(e)
        })
    };
    match read {
        Ok(c) => {
            println!("{c}");
            // On stderr, so scripts that read the code from stdout keep working.
            if let Some(f) = sx_link::read_hub_key(&dir)
                .ok()
                .as_deref()
                .and_then(sx_link::hub_fingerprint)
            {
                eprintln!(
                    "Bridge fingerprint: {f}\nBefore you trust a bridge again in {}, check that the app shows this same fingerprint.",
                    sx_link::app_name()
                );
            }
        }
        Err(e) => fail(&format!(
            "no pairing code in {} ({e}). Is the hub running?",
            dir.display()
        )),
    }
}

fn service_cmd(args: &[String]) {
    let action = args.first().map_or("print", String::as_str);
    let Some(dir) = state_dir_arg(args) else {
        fail("no state directory; pass --state-dir");
    };
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("sx-link"));
    let Some((file, body)) = service::service_file(&exe, &dir) else {
        fail("login items are set up on macOS and Linux only; on Windows use the desktop app");
    };
    match action {
        "print" => {
            println!("# {}", file.display());
            print!("{body}");
        }
        "install" | "uninstall" => {
            let install = action == "install";
            if install {
                if let Some(parent) = file.parent()
                    && let Err(e) = std::fs::create_dir_all(parent)
                {
                    fail(&format!("cannot create {}: {e}", parent.display()));
                }
                if let Err(e) = std::fs::write(&file, &body) {
                    fail(&format!("cannot write {}: {e}", file.display()));
                }
            }
            let uid = std::process::Command::new("id")
                .arg("-u")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                .unwrap_or_default();
            for cmd in service::service_commands(&file, install) {
                let cmd: Vec<String> = cmd.into_iter().map(|a| a.replace("$UID", &uid)).collect();
                let Some((prog, rest)) = cmd.split_first() else {
                    continue;
                };
                match std::process::Command::new(prog).args(rest).status() {
                    Ok(s) if s.success() => {}
                    Ok(s) => eprintln!("sx-link: {} exited with {s}", cmd.join(" ")),
                    Err(e) => eprintln!("sx-link: cannot run {prog}: {e}"),
                }
            }
            if !install {
                let _ = std::fs::remove_file(&file);
            }
            println!(
                "{} {}",
                if install { "installed" } else { "removed" },
                file.display()
            );
        }
        other => fail(&format!(
            "unknown service action {other}; use print, install or uninstall"
        )),
    }
}

#[allow(clippy::too_many_lines)] // One flat argument loop and the start sequence.
async fn run(args: Vec<String>) {
    let mut port_flag: Option<u16> = None;
    let mut extra_origins = Vec::new();
    let mut inbox_url: Option<String> = None;
    let mut mdns = MdnsConfig::default();
    let mut state_dir = default_state_dir();
    let mut headless = false;
    let mut secrets_kind: Option<String> = None;
    let mut loopback = false;
    let mut detector: Option<PathBuf> = None;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--port" => match it.next().and_then(|v| v.parse().ok()) {
                Some(p) => port_flag = Some(p),
                None => fail("--port needs a number"),
            },
            "--allow-origin" => match it.next() {
                Some(o) => extra_origins.push(o),
                None => fail("--allow-origin needs an origin such as https://staging.example"),
            },
            "--inbox-url" => match it.next() {
                Some(u) => inbox_url = Some(u),
                None => fail("--inbox-url needs the address of the cloud service"),
            },
            "--state-dir" => match it.next() {
                Some(d) => state_dir = Some(PathBuf::from(d)),
                None => fail("--state-dir needs a directory"),
            },
            "--no-state" => state_dir = None,
            "--headless" => headless = true,
            "--secrets" => match it.next() {
                Some(k) if k == "keychain" || k == "file" => secrets_kind = Some(k),
                _ => fail("--secrets is keychain or file"),
            },
            "--no-mdns" => mdns.disabled = true,
            "--loopback" => loopback = true,
            "--detector" => match it.next() {
                Some(p) => detector = Some(PathBuf::from(p)),
                None => fail("--detector needs the path of sx-watch"),
            },
            "-h" | "--help" => {
                eprintln!("{USAGE}");
                return;
            }
            other => fail(&format!("unknown argument {other}")),
        }
    }
    let port = hub_port(port_flag, test_hub_setting().as_deref());
    // Headless Linux (a Pi, a NAS, Docker) has no keychain: credentials go to a private file in the
    // state directory unless --secrets keychain says otherwise.
    let use_file = match secrets_kind.as_deref() {
        Some("file") => true,
        Some(_) => false,
        None => headless && !cfg!(target_os = "macos") && !cfg!(windows),
    };
    let secrets: Arc<dyn SecretStore> = if use_file {
        let Some(dir) = &state_dir else {
            fail("--secrets file needs a state directory");
        };
        match FileSecrets::open(dir.join("secrets.json")) {
            Ok(s) => Arc::new(s),
            Err(e) => fail(&format!("cannot open the secrets file: {e}")),
        }
    } else {
        Arc::new(KeychainSecrets::new("slicerx-printers"))
    };
    let inbox = inbox_url.map(|url| {
        let Some(token) = sx_connect::Secrets::get(secrets.as_ref(), INBOX_TOKEN_SECRET) else {
            fail(&format!(
                "--inbox-url needs a token. Store it with the secrets.set method under the name {INBOX_TOKEN_SECRET}."
            ));
        };
        InboxConfig { url, token }
    });
    // Nothing on the network: what a test run needs, so the OS firewall has nothing to ask.
    let base = if loopback {
        mdns.disabled = true;
        LinkConfig::loopback()
    } else {
        LinkConfig::default()
    };
    let broker = match ApprovalBroker::new() {
        Ok(b) => Arc::new(b),
        Err(e) => fail(&format!("cannot start the approval broker: {e}")),
    };
    let link = match serve_with_approvals(
        LinkConfig {
            port,
            extra_origins,
            fixed_code: None,
            inbox,
            pair_limits: PairLimits::default(),
            mdns,
            // With the OS keychain, the app code lives there, apart from the agent code on disk.
            code_in_secrets: !use_file && state_dir.is_some(),
            state_dir,
            ..base
        },
        Arc::new(BrokerGate(broker.clone())),
        secrets,
        Some(broker),
    )
    .await
    {
        Ok(l) => l,
        Err(e) => fail(&format!("cannot start on 127.0.0.1:{port}: {e}")),
    };
    println!("sx-link listening on ws://{}", link.addr());
    // A test build says when a test hook is on, so a test that needs one can refuse a build without it.
    #[cfg(feature = "test-hooks")]
    if let Some(addrs) = sx_connect::drivers::test_neighbors_hook() {
        println!("test hook: printer scans probe {addrs} in place of the neighbor table");
    }
    match link.state_dir() {
        Some(d) => println!("state in {}", d.display()),
        None => println!("state in memory only (--no-state)"),
    }
    if let Some(f) = sx_link::hub_fingerprint(link.hub_key()) {
        println!(
            "bridge fingerprint: {f} ({} shows the same one for this bridge)",
            sx_link::app_name()
        );
    }
    if headless {
        println!("pairing code: run `sx-link code` on this machine to see it");
        println!("agent code (MCP server, scripts): run `sx-link code --agent`");
    } else {
        println!("pairing code: {}", link.pairing_code());
        println!(
            "Enter the code in {} when it asks. Press Ctrl+C to stop.",
            sx_link::app_name()
        );
        // The agent code is not printed: tools read it from the state directory.
        println!("agent code (MCP server, scripts): run `sx-link code --agent`");
    }
    // The detector gets its code over stdin, once; nothing else ever sees it.
    let mut started = detector.map(|path| start_detector(&link, &path));
    wait_for_stop().await;
    if let Some(child) = started.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Starts the camera guard's detector with a fresh code on its stdin. The caller stops it, by its own
/// handle, when the hub stops.
fn start_detector(link: &sx_link::Link, path: &std::path::Path) -> std::process::Child {
    use std::io::Write as _;
    let code = link
        .fresh_watch_code()
        .unwrap_or_else(|e| fail(&format!("no detector code: {e}")));
    let mut child = std::process::Command::new(path)
        .arg("--url")
        .arg(format!("ws://{}", link.addr()))
        .arg("--code-stdin")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| fail(&format!("cannot start the detector {}: {e}", path.display())));
    // One line, then the pipe closes.
    if let Some(mut pipe) = child.stdin.take() {
        let _ = writeln!(pipe, "{code}");
    }
    println!("detector started: {}", path.display());
    child
}

/// A test or dev run's hub port setting. Only a `test-hub` build reads the variable, so a release sx-link never
/// carries its name.
#[cfg(feature = "test-hub")]
fn test_hub_setting() -> Option<String> {
    std::env::var("SX_TEST_HUB_PORT").ok()
}

#[cfg(not(feature = "test-hub"))]
fn test_hub_setting() -> Option<String> {
    None
}

/// The port to listen on: `--port` when given (0 picks a free one), else a test or dev run's `SX_TEST_HUB_PORT`, so
/// the hub, the app and their clients on one machine follow one setting, else `DEFAULT_PORT`.
fn hub_port(flag: Option<u16>, setting: Option<&str>) -> u16 {
    flag.or_else(|| sx_link::port_setting(setting))
        .unwrap_or(DEFAULT_PORT)
}

/// Ctrl+C, or SIGTERM from launchd, systemd or Docker.
async fn wait_for_stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

fn fail(msg: &str) -> ! {
    eprintln!("sx-link: {msg}");
    eprintln!("{USAGE}");
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_PORT, hub_port};

    #[test]
    fn port_wins_then_the_run_setting_then_the_default() {
        assert_eq!(hub_port(None, None), DEFAULT_PORT);
        assert_eq!(hub_port(None, Some("48015")), 48015);
        assert_eq!(hub_port(Some(0), Some("48015")), 0);
        assert_eq!(hub_port(Some(47700), Some("48015")), 47700);
        assert_eq!(hub_port(None, Some("80")), DEFAULT_PORT);
        assert_eq!(hub_port(None, Some("nope")), DEFAULT_PORT);
    }
}
