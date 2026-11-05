// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-watch: watches every printing printer through sx-link and reports failures.
//!
//!     sx-watch --code-stdin [--url ws://127.0.0.1:47615] [--state-dir <sx-link state dir>]
//!              [--model <sx-watch-siglip2.onnx>] [--huginn <printer,printer>] [--huginn-model gpt-5.6-luna]
//!     sx-watch --collect <dir> [--every-s 60]   # save normal frames locally, report nothing
//!
//! The app, or `sx-link --detector`, starts sx-watch and writes its detector code on its stdin, one
//! line, once. The code is never in a file, the command line or the environment, where a local agent
//! could read it and answer plate checks as the camera guard. The hub's key comes from `hub-key.pub`
//! in the state directory and is pinned. The model is looked for beside this binary (or `--model`, `SX_WATCH_MODEL`); without
//! it the watch runs the stub, which reports nothing. `--huginn` (or `SX_WATCH_HUGINN`) lists
//! the printers whose suspected failures huginn confirms on the ChatGPT plan saved in the
//! keychain; it is off unless given. Without `--url`, a build with the `test-hub` feature (tests and dev runs, never the
//! app's bundled sidecar) takes the hub's loopback port from `SX_TEST_HUB_PORT` (1024 or above), as sx-link and the
//! app's test builds do.
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

/// The detector code from the first line of `input` (the stdin the app or sx-link writes it to).
fn code_from(input: &mut impl std::io::BufRead) -> Result<String, String> {
    let mut line = String::new();
    input
        .read_line(&mut line)
        .map_err(|e| format!("cannot read the detector code from stdin: {e}"))?;
    let code = line.trim().to_owned();
    if code.is_empty() {
        return Err("no detector code on stdin".into());
    }
    Ok(code)
}

/// The hub's address: `--url` when given, else the loopback port a test or dev run names in `SX_TEST_HUB_PORT` (a port
/// from 1024 up), else sx-link's default port.
fn hub_url(flag: Option<String>, setting: Option<&str>) -> String {
    flag.unwrap_or_else(|| {
        let port = setting
            .and_then(|v| v.trim().parse::<u16>().ok())
            .filter(|p| *p >= 1024)
            .unwrap_or(47615);
        format!("ws://127.0.0.1:{port}")
    })
}

/// A test or dev run's hub port setting. Only a `test-hub` build reads the variable: the release sidecar is built
/// without it, and apps/desktop/release/check-agent-bridge.mjs refuses a release binary that carries its name.
#[cfg(feature = "test-hub")]
fn test_hub_setting() -> Option<String> {
    std::env::var("SX_TEST_HUB_PORT").ok()
}

#[cfg(not(feature = "test-hub"))]
fn test_hub_setting() -> Option<String> {
    None
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
        return Err("--code is not accepted, since other programs can read command lines. The app or `sx-link --detector` starts sx-watch and hands it the code on stdin (--code-stdin).".into());
    }
    let url = hub_url(arg("--url"), test_hub_setting().as_deref());
    let dir = arg("--state-dir")
        .map(PathBuf::from)
        .or_else(default_state_dir)
        .ok_or("no state directory; pass --state-dir")?;
    // The code arrives once, on stdin, from the app or sx-link that started this detector. It is never
    // read from a file, an argument or the environment, where a local agent could find it.
    if !args.iter().any(|a| a == "--code-stdin") {
        return Err("sx-watch is started by the app or by `sx-link --detector`, which hand it its code on stdin (--code-stdin)".into());
    }
    let code = code_from(&mut std::io::stdin().lock())?;
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

#[cfg(test)]
mod tests {
    use super::{code_from, hub_url};

    #[test]
    fn the_code_comes_from_the_first_line_of_stdin_only() {
        assert_eq!(
            code_from(&mut "ABCD-EFGH\nmore\n".as_bytes()),
            Ok("ABCD-EFGH".to_owned())
        );
        assert!(code_from(&mut "".as_bytes()).is_err());
        assert!(code_from(&mut "\n".as_bytes()).is_err());
    }

    #[test]
    fn url_wins_then_the_run_port_then_the_default() {
        assert_eq!(hub_url(None, None), "ws://127.0.0.1:47615");
        assert_eq!(hub_url(None, Some("48015")), "ws://127.0.0.1:48015");
        assert_eq!(hub_url(None, Some("80")), "ws://127.0.0.1:47615");
        assert_eq!(hub_url(None, Some("x")), "ws://127.0.0.1:47615");
        assert_eq!(
            hub_url(Some("ws://127.0.0.1:47700".into()), Some("48015")),
            "ws://127.0.0.1:47700"
        );
    }
}
