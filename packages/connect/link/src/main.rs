// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-link. See README.md.
use std::path::PathBuf;
use std::sync::Arc;

use sx_connect::{FileSecrets, KeychainSecrets, SecretStore};
use sx_link::{
    APP_CODE_SECRET, BrokerGate, DEFAULT_PORT, INBOX_TOKEN_SECRET, InboxConfig, LinkConfig, MdnsConfig,
    PairLimits, default_state_dir, read_agent_code, read_pairing_code, read_watch_code, serve_with_approvals,
    service,
};
use sx_permit::ApprovalBroker;

const USAGE: &str = "usage:
  sx-link [--port 47615] [--state-dir DIR | --no-state] [--headless] [--secrets keychain|file]
          [--allow-origin ORIGIN] [--inbox-url https://cloud.example] [--no-mdns]
  sx-link code [--agent|--watch] [--state-dir DIR]
                                                 print the running hub's app code, with --agent the code
                                                 for the MCP server and other tools, with --watch the
                                                 code for a failure detector (sx-watch)
  sx-link service print|install|uninstall [--state-dir DIR]
                                                 run the hub as a login item (macOS) or a user service (Linux)";

#[tokio::main]
async fn main() {
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
    let watch = args.iter().any(|a| a == "--watch");
    let read = if watch {
        read_watch_code(&dir)
    } else if agent {
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
                    "Bridge fingerprint: {f}\nBefore you trust a bridge again in SlicerX, check that the app shows this same fingerprint."
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
    let mut port = DEFAULT_PORT;
    let mut extra_origins = Vec::new();
    let mut inbox_url: Option<String> = None;
    let mut mdns = MdnsConfig::default();
    let mut state_dir = default_state_dir();
    let mut headless = false;
    let mut secrets_kind: Option<String> = None;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--port" => match it.next().and_then(|v| v.parse().ok()) {
                Some(p) => port = p,
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
            "-h" | "--help" => {
                eprintln!("{USAGE}");
                return;
            }
            other => fail(&format!("unknown argument {other}")),
        }
    }
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
            ..LinkConfig::default()
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
    match link.state_dir() {
        Some(d) => println!("state in {}", d.display()),
        None => println!("state in memory only (--no-state)"),
    }
    if let Some(f) = sx_link::hub_fingerprint(link.hub_key()) {
        println!("bridge fingerprint: {f} (SlicerX shows the same one for this bridge)");
    }
    if headless {
        println!("pairing code: run `sx-link code` on this machine to see it");
        println!("agent code (MCP server, scripts): run `sx-link code --agent`");
    } else {
        println!("pairing code: {}", link.pairing_code());
        println!("Enter the code in SlicerX when it asks. Press Ctrl+C to stop.");
        // The agent code is not printed: tools read it from the state directory.
        println!("agent code (MCP server, scripts): run `sx-link code --agent`");
    }
    wait_for_stop().await;
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
