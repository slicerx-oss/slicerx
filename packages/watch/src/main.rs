// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-watch: watches every printing printer through sx-link and reports failures.
//!
//!     sx-watch [--url ws://127.0.0.1:47615] [--state-dir <sx-link state dir>]
//!              [--model <sx-watch-siglip2.onnx>] [--huginn <printer,printer>] [--huginn-model gpt-5.6-luna]
//!     sx-watch --collect <dir> [--every-s 60]   # save normal frames locally, report nothing
//!
//! The watch code comes from `SX_WATCH_CODE` or the hub's `watch-code` file (mode 0600), never
//! from the command line. The hub's key comes from `hub-key.pub` in the same directory and is
//! pinned. The model is looked for beside this binary (or `--model`, `SX_WATCH_MODEL`); without
//! it the watch runs the stub, which reports nothing. `--huginn` (or `SX_WATCH_HUGINN`) lists
//! the printers whose suspected failures huginn confirms on the ChatGPT plan saved in the
//! keychain; it is off unless given.
use std::path::PathBuf;
use std::time::Duration;

use std::collections::BTreeSet;

use sx_watch::client::{ClientError, Options, collect, run_with};
use sx_watch::confirm::Confirmation;
use sx_watch::detector::{Detector, Stub};
use sx_watch::policy::Config;
use sx_watch::session::Session;

/// sx-link's state directory, as `default_state_dir` in packages/connect/link/src/lib.rs.
fn default_state_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        return home.map(|h| h.join("Library/Application Support/SlicerX/hub"));
    }
    if cfg!(windows) {
        return std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("SlicerX").join("hub"));
    }
    if let Some(x) = std::env::var_os("XDG_STATE_HOME") {
        return Some(PathBuf::from(x).join("slicerx/hub"));
    }
    home.map(|h| h.join(".local/state/slicerx/hub"))
}

fn read_secret(path: &std::path::Path) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err(format!(
                "{} is readable by other users; sx-link writes it with mode 0600",
                path.display()
            ));
        }
    }
    std::fs::read_to_string(path)
        .map(|s| s.trim().to_owned())
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn options() -> Result<Options, String> {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    if args.iter().any(|a| a == "--code") {
        return Err("--code is not accepted, since other users can read command lines. Set SX_WATCH_CODE or keep the hub's watch-code file.".into());
    }
    let url = arg("--url").unwrap_or_else(|| "ws://127.0.0.1:47615".into());
    let dir = arg("--state-dir")
        .map(PathBuf::from)
        .or_else(default_state_dir)
        .ok_or("no state directory; pass --state-dir")?;
    let code = match std::env::var("SX_WATCH_CODE") {
        Ok(c) if !c.trim().is_empty() => c,
        _ => read_secret(&dir.join("watch-code"))?,
    };
    let hub_key = std::fs::read_to_string(dir.join("hub-key.pub"))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    Ok(Options { url, code, hub_key })
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let opts = match options() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("sx-watch: {e}");
            std::process::exit(2);
        }
    };
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    if let Some(dir) = arg("--collect") {
        let every = arg("--every-s")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(60)
            .clamp(2, 120)
            * 1000;
        if let Err(e) = collect(&opts, std::path::Path::new(&dir), every).await {
            eprintln!("sx-watch: {e}");
            std::process::exit(1);
        }
        return;
    }
    let printers: BTreeSet<String> = arg("--huginn")
        .or_else(|| std::env::var("SX_WATCH_HUGINN").ok())
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    let confirmation = confirmation(printers, arg("--huginn-model"));
    let detector = detector(arg("--model").map(PathBuf::from));
    eprintln!("sx-watch: detector {}", detector.name());
    watch(
        &opts,
        Session::new(detector, Config::default()),
        confirmation.as_ref(),
    )
    .await;
}

/// The local model, or the stub when its file is missing or does not load.
fn detector(path: Option<PathBuf>) -> Box<dyn Detector> {
    #[cfg(feature = "siglip")]
    {
        if let Some(path) = path.or_else(sx_watch::siglip::default_path) {
            match sx_watch::siglip::Siglip2::load(&path, 1) {
                Ok(m) => return Box::new(m),
                Err(e) => eprintln!("sx-watch: no model ({e}); watching without one, so nothing is reported"),
            }
        }
    }
    #[cfg(not(feature = "siglip"))]
    {
        let _ = path;
        eprintln!("sx-watch: built without the model; nothing is reported");
    }
    Box::new(Stub)
}

fn confirmation(printers: BTreeSet<String>, model: Option<String>) -> Option<Confirmation> {
    if printers.is_empty() {
        return None;
    }
    let model = model.unwrap_or_else(|| "gpt-5.6-luna".to_owned());
    #[cfg(feature = "huginn")]
    {
        eprintln!(
            "sx-watch: {}",
            sx_watch::confirm::plain_statement(&model, &printers)
        );
        Some(Confirmation {
            printers,
            by: Box::new(sx_watch::confirm::Huginn { model }),
        })
    }
    #[cfg(not(feature = "huginn"))]
    {
        let _ = (model, printers);
        eprintln!("sx-watch: built without huginn; findings notify only");
        None
    }
}

async fn watch<D: Detector>(opts: &Options, mut session: Session<D>, confirm: Option<&Confirmation>) {
    let mut wait = Duration::from_secs(2);
    loop {
        match run_with(opts, &mut session, confirm).await {
            Err(ClientError::HubIdentity(m)) => {
                // Never retry against a program that is not the hub.
                eprintln!("sx-watch: {m}. Stopped.");
                std::process::exit(1);
            }
            Err(e) => eprintln!("sx-watch: {e}; trying again in {} s", wait.as_secs()),
            Ok(()) => {}
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(60));
    }
}
