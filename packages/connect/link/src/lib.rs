// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-link: the printer hub. It reaches the printers for the app, the browser build, MCP and the
//! phone, and keeps working with all of them closed.
//!
//! One WebSocket on 127.0.0.1. A client must come from an allowed origin, present the pairing
//! code printed at start (or a key it was given when it asked to be remembered), and can then call
//! the methods documented in README.md. Every side effect carries an approval token that the
//! connectors check through an [`ApprovalGate`]. With a state directory, printers, fleets, the queue,
//! standing approvals and bed state survive restarts, and a watcher runs queued and scheduled starts.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

mod adjust;
mod advert;
mod agent_work;
mod broker_gate;
mod camera;
mod device;
mod feeds;
mod fleets;
mod h264;
mod hub;
mod hub_rpc;
mod identity;
mod inbox;
mod jpeg;
mod lan;
mod net;
mod own_names;
pub mod pair_session;
mod pairing;
mod push;
mod remote;
mod remote_cam;
mod remote_rpc;
mod remote_rtc;
mod roles;
mod rpc;
pub mod service;
mod watch;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sx_connect::{ApprovalGate, SecretStore};
use sx_permit::ApprovalBroker;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub use advert::MdnsConfig;
pub use broker_gate::BrokerGate;
pub use identity::{HELLO_CONTEXT, hub_fingerprint, read_hub_key};
pub use inbox::{InboxConfig, TOKEN_SECRET as INBOX_TOKEN_SECRET};
pub use lan::{DEFAULT_PAIR_PORT, MAX_FRAME as PAIR_MAX_FRAME, PairLimits};
pub use net::{is_lan_host, origin_allowed};
pub use pairing::PairingCode;
pub use push::{ACCESS_TOKEN_SECRET as PUSH_ACCESS_TOKEN_SECRET, EXPO_PUSH_URL};

/// Default port; `sx-link --port` overrides it.
pub const DEFAULT_PORT: u16 = 47615;

#[derive(Debug, Clone)]
pub struct LinkConfig {
    /// 0 picks a free port (tests).
    pub port: u16,
    /// Origins allowed in addition to the built-in list (`https://slicerx.app`, localhost).
    pub extra_origins: Vec<String>,
    /// Use this code instead of a random one (tests).
    pub fixed_code: Option<String>,
    /// The agent code (MCP and other tools); random when `None`.
    pub fixed_agent_code: Option<String>,
    /// The code for a failure detector (`sx-watch`); random when `None`.
    pub fixed_watch_code: Option<String>,
    /// After the print watch paused a print and nobody answered: bed off (nozzle held), then both
    /// heaters off. Defaults 30 minutes and 2 hours.
    pub pause_bed_off_after: Duration,
    pub pause_heaters_off_after: Duration,
    /// Optional cloud inbox (outbound requests only). Off when `None`.
    pub inbox: Option<InboxConfig>,
    /// Caps on the opt-in LAN listener for phones.
    pub pair_limits: PairLimits,
    /// mDNS advertising of the phone listener, and mDNS browsing for `discover`.
    pub mdns: MdnsConfig,
    /// Where the hub keeps its state. `None` keeps everything in memory for the life of the process.
    pub state_dir: Option<PathBuf>,
    /// How often the watcher reads every printer and runs the queue.
    pub watch_every: Duration,
    /// Where phone alerts are posted (Expo's push service). Empty turns sending off.
    pub push_url: String,
    /// Keep the app code in the secret store (the OS keychain) instead of a file, so tools that
    /// read the state directory for the agent code cannot read it there too.
    pub code_in_secrets: bool,
    /// The address direct video (WebRTC) binds and announces. `None`: the address of the default
    /// route, which is what phones away from home reach through the router.
    pub rtc_bind: Option<std::net::IpAddr>,
    /// The address the phone listener (`pair.listen`) binds. `None`: all addresses, so phones on the
    /// home network reach it. Tests use 127.0.0.1, which also keeps the OS firewall from asking.
    pub lan_bind: Option<std::net::IpAddr>,
    /// The address printer discovery (Bambu and Elegoo) listens and sends on. `None`: all addresses.
    /// Tests use 127.0.0.1, so the OS firewall has nothing to ask.
    pub discovery_bind: Option<std::net::IpAddr>,
}

/// Secret store entry for the app code when [`LinkConfig::code_in_secrets`] is set.
pub const APP_CODE_SECRET: &str = "sx-link-app-code";

impl Default for LinkConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            extra_origins: Vec::new(),
            fixed_code: None,
            fixed_agent_code: None,
            fixed_watch_code: None,
            pause_bed_off_after: Duration::from_mins(30),
            pause_heaters_off_after: Duration::from_hours(2),
            inbox: None,
            pair_limits: PairLimits::default(),
            mdns: MdnsConfig::default(),
            state_dir: None,
            watch_every: Duration::from_secs(5),
            push_url: push::EXPO_PUSH_URL.to_owned(),
            code_in_secrets: false,
            rtc_bind: None,
            lan_bind: None,
            discovery_bind: None,
        }
    }
}

/// The default state directory: `~/Library/Application Support/SlicerX/hub` on macOS,
/// `%APPDATA%\SlicerX\hub` on Windows, `$XDG_STATE_HOME/slicerx/hub` or `~/.local/state/slicerx/hub`
/// elsewhere. `None` when no home directory is known.
pub fn default_state_dir() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if cfg!(target_os = "macos") {
        return env("HOME").map(|h| h.join("Library/Application Support/SlicerX/hub"));
    }
    if cfg!(windows) {
        return env("APPDATA").map(|a| a.join("SlicerX").join("hub"));
    }
    env("XDG_STATE_HOME")
        .map(|s| s.join("slicerx/hub"))
        .or_else(|| env("HOME").map(|h| h.join(".local/state/slicerx/hub")))
}

/// Reads the pairing code a running hub wrote to its state directory (`sx-link code`).
pub fn read_pairing_code(state_dir: &std::path::Path) -> std::io::Result<String> {
    Ok(std::fs::read_to_string(state_dir.join(hub::CODE_FILE))?
        .trim()
        .to_owned())
}

/// The running hub's detector code, for `sx-watch` (file mode 0600).
pub fn read_watch_code(state_dir: &std::path::Path) -> std::io::Result<String> {
    Ok(std::fs::read_to_string(state_dir.join(hub::WATCH_CODE_FILE))?
        .trim()
        .to_owned())
}

/// The running hub's agent code, for the MCP server and other tools (file mode 0600).
pub fn read_agent_code(state_dir: &std::path::Path) -> std::io::Result<String> {
    Ok(std::fs::read_to_string(state_dir.join(hub::AGENT_CODE_FILE))?
        .trim()
        .to_owned())
}

/// A running bridge. Dropping it stops the listener.
pub struct Link {
    addr: SocketAddr,
    code: PairingCode,
    agent_code: PairingCode,
    hub_key: String,
    task: JoinHandle<()>,
    puller: Option<JoinHandle<()>>,
    watcher: JoinHandle<()>,
    state_dir: Option<PathBuf>,
    bridge: Arc<rpc::Bridge>,
}

impl Link {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// The code a client must send in its first message. Show it to the user; never log it
    /// anywhere but the terminal that started the bridge.
    /// The app code: pairing with it gives the `app` role.
    pub fn pairing_code(&self) -> &PairingCode {
        &self.code
    }

    /// The agent code, for the MCP server and other tools: pairing with it gives the `agent` role.
    pub fn agent_code(&self) -> &PairingCode {
        &self.agent_code
    }

    /// The hub's public key (Ed25519, base64). Clients check `hello` against it before pairing.
    pub fn hub_key(&self) -> &str {
        &self.hub_key
    }

    /// Where the hub keeps its state, if anywhere.
    pub fn state_dir(&self) -> Option<&std::path::Path> {
        self.state_dir.as_deref()
    }

    /// Makes an agent credential named `name` for the program that runs this hub, in process: no
    /// socket and no pairing code, so nothing can stand in for the hub. Earlier agent credentials
    /// under the same name are revoked first. Returns the client id and the key; the key is shown
    /// nowhere else, so the caller stores it and drops it.
    pub async fn create_agent_key(&self, name: &str) -> Result<AgentKey, String> {
        self.revoke_agents_named(name).await?;
        let made = hub_rpc::clients_call(
            &self.bridge,
            "clients.create",
            &serde_json::json!({ "name": name, "role": "agent" }),
        )
        .await
        .map_err(|e| e.message)?;
        let field = |k: &str| made.get(k).and_then(serde_json::Value::as_str);
        match (field("clientId"), field("clientKey")) {
            (Some(id), Some(key)) => Ok(AgentKey {
                client_id: id.to_owned(),
                key: key.to_owned(),
            }),
            _ => Err("The hub made no credential.".to_owned()),
        }
    }

    /// Revokes the agent credentials named `name`, in process. Returns how many there were.
    pub async fn revoke_agents_named(&self, name: &str) -> Result<usize, String> {
        let ids = self.agent_ids_named(name);
        for id in &ids {
            self.revoke_client(id).await?;
        }
        Ok(ids.len())
    }

    /// Revokes one client credential by id, in process.
    pub async fn revoke_client(&self, client_id: &str) -> Result<(), String> {
        hub_rpc::clients_call(
            &self.bridge,
            "clients.revoke",
            &serde_json::json!({ "clientId": client_id }),
        )
        .await
        .map(|_| ())
        .map_err(|e| e.message)
    }

    /// Stops accepting connections and frees the port. Connections already open and the
    /// in-process calls above keep working until the `Link` is dropped.
    pub fn stop_listening(&self) {
        self.task.abort();
    }

    /// The ids of the agent credentials named `name`.
    pub fn agent_ids_named(&self, name: &str) -> Vec<String> {
        hub::lock(&self.bridge.hub.clients)
            .iter()
            .filter(|c| c.role == roles::Role::Agent && c.name == name)
            .map(|c| c.id.clone())
            .collect()
    }
}

/// A credential [`Link::create_agent_key`] made. The key is a secret: keep it out of logs and
/// files, and drop it once it is in the keychain.
pub struct AgentKey {
    pub client_id: String,
    pub key: String,
}

impl std::fmt::Debug for AgentKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentKey")
            .field("client_id", &self.client_id)
            .finish_non_exhaustive()
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.task.abort();
        self.watcher.abort();
        if let Some(p) = &self.puller {
            p.abort();
        }
    }
}

/// Binds 127.0.0.1 (and nothing else) and starts serving.
pub async fn serve(
    cfg: LinkConfig,
    gate: Arc<dyn ApprovalGate>,
    secrets: Arc<dyn SecretStore>,
) -> std::io::Result<Link> {
    serve_with_approvals(cfg, gate, secrets, None).await
}

/// Like [`serve`], and also lets paired clients register, grant and deny approvals on `broker`
/// (the `approvals.*` methods). Only the app's approval card should call `grant`.
pub async fn serve_with_approvals(
    cfg: LinkConfig,
    gate: Arc<dyn ApprovalGate>,
    secrets: Arc<dyn SecretStore>,
    broker: Option<Arc<ApprovalBroker>>,
) -> std::io::Result<Link> {
    // A connection test's credential lives for one test: keep it out of the keychain, which can refuse writes.
    let secrets: Arc<dyn SecretStore> = Arc::new(sx_connect::ScratchSecrets::new(secrets));
    let listener = TcpListener::bind(("127.0.0.1", cfg.port)).await?;
    let addr = listener.local_addr()?;
    let code = match &cfg.fixed_code {
        Some(c) => PairingCode::from_string(c),
        None => PairingCode::random().map_err(|e| std::io::Error::other(e.to_string()))?,
    };
    let agent_code = match &cfg.fixed_agent_code {
        Some(c) => PairingCode::from_string(c),
        None => PairingCode::random().map_err(|e| std::io::Error::other(e.to_string()))?,
    };
    let watch_code = match &cfg.fixed_watch_code {
        Some(c) => PairingCode::from_string(c),
        None => PairingCode::random().map_err(|e| std::io::Error::other(e.to_string()))?,
    };
    let dir = match &cfg.state_dir {
        Some(p) => Some(hub::StateDir::open(p)?),
        None => None,
    };
    if let Some(d) = &dir {
        if cfg.code_in_secrets {
            secrets
                .set(APP_CODE_SECRET, &code.to_string())
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            d.remove_code();
        } else {
            d.write_code(&code.to_string())?;
        }
        d.write_agent_code(&agent_code.to_string())?;
        d.write_watch_code(&watch_code.to_string())?;
    }
    let identity = identity::HubIdentity::open(dir.as_ref().map(hub::StateDir::path))?;
    let hub_key = identity.public_b64();
    let (mut hub_state, loaded) = hub::Hub::open(dir, cfg.watch_every, &cfg.push_url);
    hub_state.pause_steps = (cfg.pause_bed_off_after, cfg.pause_heaters_off_after);
    let lan_port = *hub::lock(&hub_state.lan_port);
    let inbox = match &cfg.inbox {
        Some(c) => Some(Arc::new(inbox::Inbox::new(c).map_err(std::io::Error::other)?)),
        None => None,
    };
    let state = Arc::new(rpc::Bridge::new(
        gate,
        secrets,
        code.clone(),
        agent_code.clone(),
        watch_code.clone(),
        identity,
        cfg.extra_origins.clone(),
        addr.port(),
        broker,
        inbox.clone(),
        cfg.pair_limits,
        cfg.mdns.clone(),
        cfg.lan_bind,
        cfg.discovery_bind,
        hub_state,
        loaded,
    ));
    // The phone listener comes back on if it was on when the hub stopped.
    if let Some(port) = lan_port
        && let Err(e) = state.lan.start(port).await
    {
        eprintln!("sx-link: the phone listener did not restart: {e}");
    }
    state.remote.set_rtc_bind(cfg.rtc_bind);
    remote::resume(&state);
    let kept = state.clone();
    let watcher = tokio::spawn(hub_rpc::watch(state.clone()));
    let puller = inbox.map(|i| tokio::spawn(inbox::run(i, state.clone())));
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _peer)) = listener.accept().await else {
                continue;
            };
            let state = state.clone();
            tokio::spawn(async move { rpc::handle_connection(state, stream).await });
        }
    });
    Ok(Link {
        addr,
        code,
        agent_code,
        hub_key,
        task,
        puller,
        watcher,
        state_dir: cfg.state_dir.clone(),
        bridge: kept,
    })
}
