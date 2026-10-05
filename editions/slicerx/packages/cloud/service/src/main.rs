// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-cloud binary.
//!
//! Public settings come from the edition config (`sx-edition-config`):
//! `SLICERX_CONFIG` names the resolved JSON, and the `SLICERX_*` overrides
//! apply on top (`docs/integrating.md`, "Run the services"). Slicing jobs,
//! devices and deliveries (the inbox) run only when `features.cloudSlicing`
//! is on (the `SlicerX` edition turns it on when `SLICERX_CLOUD_API_URL` is
//! set); otherwise the service runs only the library upload scan and the
//! account purge. Hosted slicing is invite only (`cloud_access`). It reads the
//! Supabase URL from `backend.supabase`, names itself after `brand.name` and
//! serves `legal.sourceUrl` at `/v1/about`.
//!
//! Secrets and deployment settings stay in the environment:
//!
//! - `SX_CLOUD_SERVICE_KEY`: the Supabase service role key.
//! - `SX_CLOUD_BACKEND`: `supabase` (default) or `memory`.
//! - `SX_CLOUD_BIND`: listen address, default `127.0.0.1:8787`.
//! - `SX_CLOUD_ROLE`: `all` (default), `api` or `worker`.
//! - `SX_CLOUD_WORKERS`: worker tasks in this process, default 1.
//! - `SX_CLOUD_WORKER_ID`: prefix for worker ids, default the host name.
//! - `SX_CLOUD_PURGE_INTERVAL_S`: how often a worker process purges accounts past their deletion grace period, default 3600; 0 turns it off.
//! - `SX_CLOUD_TRUST_FORWARDED`: `1` behind a proxy that sets `X-Forwarded-For`.
//! - `SX_CLOUD_RETENTION_DAYS`: days uploaded meshes and results are kept, default 7; 0 keeps them.
//!   Runs with the purge.
//! - `SX_CLOUD_IDLE_EXIT_S`: exit after this many seconds with no request (other than
//!   `/healthz`) and no job slicing, for hosts that start the service on demand.
//! - `SX_CLOUD_COMMIT`: the deployed commit, filled into `{commit}` in the source link.
//! - `SX_CLAMD_ADDR`: where clamd listens (`host:port`, `tcp:host:port` or `unix:/path`). Turns on the
//!   library upload scan worker; without it no library upload is scanned. The pipeline has no
//!   mode that skips the malware scan.
//! - `SX_SCAN_WORKERS`: scan worker tasks in this process, default 1.
//! - `SX_SCAN_BLOCKLIST`: path of a text file of SHA-256 hashes the library refuses.
//! - `SX_CLOUD_DEV_TOKEN`: memory backend only; an `sxk_` token with both scopes for a local test user.

use std::sync::Arc;
use std::time::Duration;

use sx_cloud::http::About;
use sx_cloud::http::status_router;
use sx_cloud::scan_worker::{self, ScanWorkerConfig};
use sx_cloud::{App, Backend, MemoryBackend, SupabaseBackend, WorkerConfig, idle, router, worker};
use sx_edition_config::EditionConfig;
use sx_upload_scan::{Clamd, ClamdAddr, HashBlocklist, Limits, Scanner};
use tokio::sync::watch;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("sx-cloud: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[allow(clippy::too_many_lines)] // Startup wiring, read top to bottom: config, backend, workers, routes.
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let edition = EditionConfig::load(&env)?;
    // With cloudSlicing off the service still scans library uploads and
    // purges deleted accounts, and serves only /healthz and /v1/about.
    let slicing = edition.features.cloud_slicing;
    if !slicing {
        eprintln!(
            "sx-cloud: cloudSlicing is off in the edition config; slicing jobs and the inbox are off, the upload scan and account purge run"
        );
    }
    let version = env!("CARGO_PKG_VERSION");
    let about = About {
        name: edition.brand.name.clone(),
        version: version.to_owned(),
        source_url: edition.legal.source_url.as_ref().map(|u| {
            u.replace(
                "{commit}",
                &env("SX_CLOUD_COMMIT").unwrap_or_else(|| "main".to_owned()),
            )
        }),
    };
    let user_agent = format!("{} cloud/{version}", edition.brand.name);

    let backend = make_backend(&edition, &user_agent)?;
    let role = env("SX_CLOUD_ROLE").unwrap_or_else(|| "all".to_owned());
    if !matches!(role.as_str(), "all" | "api" | "worker") {
        return Err(format!("unknown SX_CLOUD_ROLE {role}").into());
    }
    let (stop_tx, stop_rx) = watch::channel(false);
    let stop_tx = Arc::new(stop_tx);
    tokio::spawn({
        let stop_tx = stop_tx.clone();
        async move {
            shutdown_signal().await;
            let _ = stop_tx.send(true);
        }
    });
    if let Some(s) = env("SX_CLOUD_IDLE_EXIT_S") {
        let after = Duration::from_secs(s.parse()?);
        eprintln!("sx-cloud: exits after {} s idle", after.as_secs());
        tokio::spawn(async move { idle::exit_when_idle(after, &stop_tx).await });
    }

    let mut workers = Vec::new();
    if role != "api"
        && let Some(scanner) = make_scanner()?
    {
        let count: usize = env("SX_SCAN_WORKERS").map_or(Ok(1), |v| v.parse())?;
        let prefix = env("SX_CLOUD_WORKER_ID")
            .or_else(|| env("HOSTNAME"))
            .unwrap_or_else(|| "sx-cloud".to_owned());
        for n in 0..count {
            let cfg = ScanWorkerConfig::new(format!("{prefix}-scan-{}-{n}", std::process::id()));
            workers.push(tokio::spawn(scan_worker::run(
                backend.clone(),
                scanner.clone(),
                cfg,
                stop_rx.clone(),
            )));
        }
    }
    if role != "api" && slicing {
        let count: usize = env("SX_CLOUD_WORKERS").map_or(Ok(1), |v| v.parse())?;
        let prefix = env("SX_CLOUD_WORKER_ID")
            .or_else(|| env("HOSTNAME"))
            .unwrap_or_else(|| "sx-cloud".to_owned());
        for n in 0..count {
            let cfg = WorkerConfig {
                id: format!("{prefix}-{}-{n}", std::process::id()),
                idle_poll: Duration::from_secs(2),
                heartbeat: Duration::from_secs(20),
            };
            workers.push(tokio::spawn(worker::run(backend.clone(), cfg, stop_rx.clone())));
        }
    }

    if role != "api" {
        let every: u64 = env("SX_CLOUD_PURGE_INTERVAL_S").map_or(Ok(3600), |v| v.parse())?;
        if every > 0 {
            let retention: u32 = env("SX_CLOUD_RETENTION_DAYS").map_or(Ok(7), |v| v.parse())?;
            workers.push(tokio::spawn(worker::run_purge(
                backend.clone(),
                Duration::from_secs(every),
                if slicing { retention } else { 0 },
                stop_rx.clone(),
            )));
        }
    }

    let mut stop = stop_rx.clone();
    if role == "worker" {
        let _ = stop.wait_for(|s| *s).await;
    } else {
        let bind = env("SX_CLOUD_BIND").unwrap_or_else(|| "127.0.0.1:8787".to_owned());
        let listener = tokio::net::TcpListener::bind(&bind).await?;
        eprintln!("sx-cloud: listening on http://{}", listener.local_addr()?);
        let app = Arc::new(App {
            backend,
            poll_step: Duration::from_secs(1),
            about,
            trust_forwarded: env("SX_CLOUD_TRUST_FORWARDED").as_deref() == Some("1"),
        });
        let routes = if slicing { router(app) } else { status_router(app) };
        // Every request but the platform's health check counts as activity.
        let routes = routes.layer(axum::middleware::from_fn(
            |req: axum::extract::Request, next: axum::middleware::Next| async move {
                if req.uri().path() != "/healthz" {
                    idle::touch();
                }
                next.run(req).await
            },
        ));
        axum::serve(
            listener,
            routes.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = stop.wait_for(|s| *s).await;
        })
        .await?;
    }
    for w in workers {
        let _ = w.await;
    }
    Ok(())
}

/// The upload scanner, when a malware scanner is configured.
fn make_scanner() -> Result<Option<Scanner>, Box<dyn std::error::Error>> {
    let Some(addr) = env("SX_CLAMD_ADDR") else {
        eprintln!("sx-cloud: SX_CLAMD_ADDR is not set; library uploads are not scanned");
        return Ok(None);
    };
    let av = Clamd::new(ClamdAddr::parse(&addr).map_err(|e| format!("SX_CLAMD_ADDR: {e}"))?);
    let blocklist = match env("SX_SCAN_BLOCKLIST") {
        Some(path) => HashBlocklist::parse(&std::fs::read_to_string(&path)?)?,
        None => HashBlocklist::default(),
    };
    eprintln!("sx-cloud: upload scan on; {} blocklisted hashes", blocklist.len());
    Ok(Some(Scanner::new(
        Limits::default(),
        Arc::new(blocklist),
        Arc::new(av),
    )))
}

/// The storage and queue named by `SX_CLOUD_BACKEND`.
fn make_backend(
    edition: &EditionConfig,
    user_agent: &str,
) -> Result<Arc<dyn Backend>, Box<dyn std::error::Error>> {
    Ok(match env("SX_CLOUD_BACKEND").as_deref().unwrap_or("supabase") {
        "memory" => {
            let m = MemoryBackend::new();
            if let Some(token) = env("SX_CLOUD_DEV_TOKEN") {
                let dev_user = "00000000-0000-4000-8000-00000000d0e0";
                m.add_token(&token, dev_user, &["cloud_slice", "link"]);
                // Invited, with the hosted defaults: 20 jobs a day, 25 MB meshes.
                m.grant_access(dev_user, 20, 25 * 1024 * 1024);
            }
            eprintln!("sx-cloud: memory backend; nothing is saved");
            Arc::new(m)
        }
        "supabase" => {
            let url = edition
                .backend
                .supabase
                .as_ref()
                .map(|s| s.url.clone())
                .ok_or("backend.supabase is not set in the edition config (or SLICERX_SUPABASE_URL)")?;
            let key = env("SX_CLOUD_SERVICE_KEY").ok_or("set SX_CLOUD_SERVICE_KEY")?;
            Arc::new(SupabaseBackend::with_user_agent(&url, &key, user_agent)?)
        }
        other => return Err(format!("unknown SX_CLOUD_BACKEND {other}").into()),
    })
}

/// Ctrl+C, or SIGTERM from a container runtime.
async fn shutdown_signal() {
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
