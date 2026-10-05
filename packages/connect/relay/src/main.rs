// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-relay. See README.md.
use std::sync::Arc;
use std::time::Duration;

use sx_relay::auth::Verifier;
use sx_relay::{PATH, RelayConfig, SystemClock, spawn};

const USAGE: &str = "usage:
  sx-relay [--listen 127.0.0.1:8787] [--jwks FILE] [--issuer URL] [--trust-proxy]

  --listen ADDR   address to serve plain WebSocket on; put a TLS proxy in front of it
  --jwks FILE     public keys (ES256 or RS256) of the service that mints relay tokens
  --issuer URL    required iss of relay tokens
  --trust-proxy   take the client address from X-Forwarded-For on loopback connections

  SX_RELAY_JWT_SECRET  an HS256 secret for relay tokens, instead of or besides --jwks. A secret
                       used only for relay tokens, never the Supabase project's JWT secret.
  Relay tokens have audience sx-relay; an account's own session is refused.
  Without keys or a secret, accounts are off and every connection gets the anonymous quotas.";

fn fail(msg: &str) -> ! {
    eprintln!("sx-relay: {msg}");
    std::process::exit(2);
}

fn value(args: &[String], flag: &str) -> Option<String> {
    let i = args.iter().position(|a| a == flag)?;
    Some(
        args.get(i + 1)
            .cloned()
            .unwrap_or_else(|| fail(&format!("{flag} needs a value"))),
    )
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{USAGE}");
        return;
    }
    let listen = value(&args, "--listen").unwrap_or_else(|| "127.0.0.1:8787".to_owned());
    let secret = std::env::var("SX_RELAY_JWT_SECRET")
        .ok()
        .filter(|s| !s.is_empty());
    let mut verifier = match (value(&args, "--jwks"), secret) {
        (Some(path), _) => {
            let json = std::fs::read_to_string(&path).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
            let mut v = Verifier::from_jwks(&json).unwrap_or_else(|e| fail(&e));
            if let Ok(s) = std::env::var("SX_RELAY_JWT_SECRET")
                && !s.is_empty()
            {
                v = v.with_hs256(s.as_bytes());
            }
            Some(v)
        }
        (None, Some(s)) => Some(Verifier::hs256(s.as_bytes())),
        (None, None) => None,
    };
    if let (Some(v), Some(iss)) = (verifier.as_mut(), value(&args, "--issuer")) {
        v.issuer = Some(iss);
    }
    let accounts = verifier.is_some();
    let cfg = RelayConfig {
        verifier,
        trust_proxy: args.iter().any(|a| a == "--trust-proxy"),
        clock: Arc::new(SystemClock),
        log_every: Some(Duration::from_secs(600)),
        ..RelayConfig::default()
    };
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .unwrap_or_else(|e| fail(&format!("cannot listen on {listen}: {e}")));
    let relay = spawn(listener, cfg).unwrap_or_else(|e| fail(&e.to_string()));
    println!(
        "sx-relay listening on ws://{}{PATH} (accounts {})",
        relay.addr,
        if accounts { "on" } else { "off" }
    );
    wait_for_stop().await;
    relay.stop();
}

async fn wait_for_stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let Ok(mut term) = signal(SignalKind::terminate()) else {
            let _ = tokio::signal::ctrl_c().await;
            return;
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
