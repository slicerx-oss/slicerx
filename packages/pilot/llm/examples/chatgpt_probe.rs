// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Signs in with ChatGPT in the browser, then reports whether the plan accepts a text
//! request, a tool call and an image. Tokens go to the keychain item `slicerx-chatgpt`
//! and are never printed.
//!
//!     cargo run -q -p sx-llm --example chatgpt_probe            # sign in, probe, keep the connection
//!     cargo run -q -p sx-llm --example chatgpt_probe -- --sign-out   # also sign out afterwards
//!     cargo run -q -p sx-llm --example chatgpt_probe -- --verbose    # show each call
//!     cargo run -q -p sx-llm --example chatgpt_probe -- --model gpt-5.6-luna   # check one model
//!     cargo run -q -p sx-llm --example chatgpt_probe -- --judge <dir>   # judge each image once with gpt-5.6-luna
//!
//! With a connection already in the keychain it skips the browser and only probes.
use std::time::Duration;

use sx_llm::SystemKeySource;
use sx_llm::chatgpt::{self, ConnectOptions, DEFAULT_REDIRECT_PORT, Endpoints};

fn open_in_browser(url: &str) -> sx_llm::Result<()> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|_| sx_llm::Error::Transport("could not open the browser".to_owned()))
}

fn word(o: &chatgpt::Outcome) -> String {
    match o {
        chatgpt::Outcome::Accepted => "yes".to_owned(),
        chatgpt::Outcome::Refused(d) => format!("no ({d})"),
        chatgpt::Outcome::RequestError(d) => format!("request error, says nothing about the plan ({d})"),
        chatgpt::Outcome::NoAnswer => "no answer in time".to_owned(),
    }
}

/// The listing, trimmed to what helps choose, and the models mimir would use.
fn print_models(report: &chatgpt::ProbeReport) {
    println!("Models the plan offers:");
    for m in &report.models {
        // Only what helps choose a model: speed tiers, input modalities and the plans.
        let wanted = |k: &str| {
            ["speed", "modalit", "available_in_plans"]
                .iter()
                .any(|w| k.contains(w))
        };
        let hints: Vec<String> = m
            .hints
            .iter()
            .filter(|(k, _)| wanted(k))
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        println!(
            "  {}{}{}: {}",
            m.slug,
            m.display_name
                .as_deref()
                .map(|n| format!(" ({n})"))
                .unwrap_or_default(),
            if m.listed { "" } else { " [hidden]" },
            if hints.is_empty() {
                "no hints".to_owned()
            } else {
                hints.join(", ")
            }
        );
    }
    match &report.tiers {
        Ok(t) => {
            println!(
                "mimir would use: {} {} for quick looks, {} {} for deep thinking (by {})",
                chatgpt::HUGINN,
                t.huginn,
                chatgpt::MUNINN,
                t.muninn,
                t.by
            );
        }
        Err(why) => println!("mimir cannot pick its models: {why}"),
    }
}

/// Judges every image in `dir` once and reports per group, the group being the file name up to
/// the first underscore (`spaghetti_03.jpg`). Uses the saved connection; never signs in.
async fn judge_dir(dir: &std::path::Path, model: &str) -> sx_llm::Result<()> {
    let store = SystemKeySource;
    let endpoints = Endpoints::openai()?;
    if chatgpt::account(&store).is_none() {
        println!("No saved ChatGPT connection. Run the probe once first.");
        return Ok(());
    }
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| sx_llm::Error::Transport(e.to_string()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().is_some_and(|x| {
                ["jpg", "jpeg", "png", "webp"].contains(&x.to_string_lossy().to_lowercase().as_str())
            })
        })
        .collect();
    files.sort();
    let mut groups: std::collections::BTreeMap<String, (usize, usize, usize)> =
        std::collections::BTreeMap::new();
    for f in &files {
        let name = f
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let group = name.split('_').next().unwrap_or("other").to_owned();
        let mime = match f
            .extension()
            .map(|x| x.to_string_lossy().to_lowercase())
            .as_deref()
        {
            Some("png") => "image/png",
            Some("webp") => "image/webp",
            _ => "image/jpeg",
        };
        let bytes = std::fs::read(f).map_err(|e| sx_llm::Error::Transport(e.to_string()))?;
        let g = groups.entry(group).or_default();
        g.0 += 1;
        match chatgpt::judge_frame(&store, &endpoints, model, mime, &bytes).await {
            Ok(v) => {
                if v.failed {
                    g.1 += 1;
                }
                println!(
                    "{name}: failed={} kind={} confidence={:.2}",
                    v.failed, v.kind, v.confidence
                );
            }
            Err(e) => {
                g.2 += 1;
                println!("{name}: error {e}");
            }
        }
    }
    println!("Summary ({model}):");
    for (group, (n, failed, errors)) in &groups {
        println!(
            "  {group}: called failed on {failed} of {n}{}",
            if *errors > 0 {
                format!(", {errors} errors")
            } else {
                String::new()
            }
        );
    }
    // Files named spaghetti_* are failures; every other group is a print that has not failed.
    let (mut caught, mut fails, mut alarms, mut fine) = (0, 0, 0, 0);
    for (group, (n, failed, _)) in &groups {
        if group == "spaghetti" {
            (caught, fails) = (caught + failed, fails + n);
        } else {
            (alarms, fine) = (alarms + failed, fine + n);
        }
    }
    println!(
        "Catches: {caught} of {fails} failed prints. False alarms: {alarms} of {fine} prints that had not failed."
    );
    Ok(())
}

fn yes(b: bool) -> &'static str {
    if b { "yes" } else { "no" }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("chatgpt_probe: {e}");
        std::process::exit(1);
    }
}

async fn run() -> sx_llm::Result<()> {
    let all: Vec<String> = std::env::args().collect();
    if let Some(dir) = all
        .iter()
        .position(|a| a == "--judge")
        .and_then(|i| all.get(i + 1))
    {
        let model = all
            .iter()
            .position(|a| a == "--model")
            .and_then(|i| all.get(i + 1))
            .map_or("gpt-5.6-luna", String::as_str);
        return judge_dir(std::path::Path::new(dir), model).await;
    }
    let sign_out = std::env::args().any(|a| a == "--sign-out");
    let verbose = std::env::args().any(|a| a == "--verbose");
    let args: Vec<String> = std::env::args().collect();
    let chosen = args
        .iter()
        .position(|a| a == "--model")
        .and_then(|i| args.get(i + 1))
        .cloned();
    let store = SystemKeySource;
    let endpoints = Endpoints::openai()?;
    let account = if let Some(a) = chatgpt::account(&store) {
        println!("Using the saved ChatGPT connection.");
        a
    } else {
        println!("Opening the browser to sign in with ChatGPT. Finish there and come back.");
        let opts = ConnectOptions {
            endpoints: endpoints.clone(),
            redirect_port: DEFAULT_REDIRECT_PORT,
            app_name: "SlicerX",
            open_url: &open_in_browser,
            timeout: Duration::from_secs(300),
        };
        chatgpt::connect(&store, &opts).await?
    };
    println!(
        "Signed in as {}.",
        account.email.as_deref().unwrap_or("(no email shared)")
    );
    println!("Plan usage granted: {}", yes(account.plan_usage));
    if !account.plan_usage {
        println!("Plan usage was not granted, so nothing more can be checked.");
        return Ok(());
    }
    // Paths, statuses, content types and a redacted start of odd bodies; never a header or token.
    let show = |c: &chatgpt::CallInfo| {
        let preview = c
            .preview
            .as_deref()
            .map(|p| format!(", body: {p}"))
            .unwrap_or_default();
        println!("  {} -> {} {}{preview}", c.call, c.status, c.content_type);
    };
    let report = chatgpt::probe_model(
        &store,
        &endpoints,
        if verbose { Some(&show) } else { None },
        chosen.as_deref(),
    )
    .await?;
    println!("Model: {}", report.caps.model);
    println!("Text request: {}", word(&report.text));
    println!("Tool calls: {}", word(&report.tools));
    println!("Image input: {}", word(&report.images));
    println!("SlicerX request shape: {}", word(&report.app_shape));
    print_models(&report);
    if sign_out {
        chatgpt::disconnect(&store, &endpoints).await?;
        println!("Signed out and removed the keychain item.");
    } else {
        println!(
            "The connection is kept in the keychain item slicerx-chatgpt. Run with --sign-out to remove it."
        );
    }
    Ok(())
}
