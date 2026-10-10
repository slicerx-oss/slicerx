// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The WebSocket protocol: pairing, then JSON requests mirroring `PrinterHost`.
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sx_connect::services::{HomeAssistantPlugin, SpoolmanPlugin};
use sx_connect::{
    ApprovalGate, ApprovalToken, Error as ConnectError, JobFile, JobKind, PrinterConfig, PrinterConnector,
    PrinterSession, PrinterStatus, SecretStore, ServicePlugin,
};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::advert::MdnsConfig;
use crate::camera;
use crate::fleets::{FleetError, Fleets};
use crate::hub::{Hub, Loaded};
use crate::hub_rpc;
use crate::inbox::{ClaimError, Inbox};
use crate::lan::{DEFAULT_PAIR_PORT, Lan, MAX_FRAME, PairLimits};
use crate::net::{is_lan_host, origin_allowed};
use crate::pairing::PairingCode;
use crate::roles::{self, Role};

const MAX_MESSAGE: usize = 256 * 1024 * 1024;
const MAX_PAIR_ATTEMPTS: u32 = 5;
const GLOBAL_FAILURES: u32 = 10;
const LOCKOUT: Duration = Duration::from_secs(60);

pub(crate) struct Bridge {
    gate: Arc<dyn ApprovalGate>,
    secrets: Arc<dyn SecretStore>,
    code: PairingCode,
    agent_code: PairingCode,
    watch_code: PairingCode,
    identity: crate::identity::HubIdentity,
    extra_origins: Vec<String>,
    port: u16,
    connectors: Vec<Box<dyn PrinterConnector>>,
    pub(crate) printers: Mutex<HashMap<String, Registered>>,
    sessions: Mutex<HashMap<String, Arc<dyn PrinterSession>>>,
    /// Per printer: held while a session is being opened.
    connecting: Mutex<HashMap<String, Opening>>,
    /// One camera connection per printer, shared by every reader (`feeds.rs`).
    pub(crate) feeds: Arc<crate::feeds::Feeds>,
    pub(crate) services: Mutex<HashMap<String, ServiceConfig>>,
    pub(crate) fleets: Mutex<Fleets>,
    pub(crate) broker: Option<Arc<sx_permit::ApprovalBroker>>,
    pub(crate) inbox: Option<Arc<Inbox>>,
    pub(crate) lan: Arc<Lan>,
    mdns: MdnsConfig,
    failures: StdMutex<(u32, Option<Instant>)>,
    pub(crate) hub: Hub,
    /// Numbers connections, so a card can be traced to the connection that registered it.
    next_conn: AtomicU64,
    /// Request id to the connection that registered it, for cards agents raise.
    pub(crate) card_owners: StdMutex<HashMap<String, u64>>,
    /// Request id to the partner app that raised it, by the name its key was made with. The hub
    /// adds it to the card as `partner`, so the app can say who asked without reading the
    /// partner's own lines.
    pub(crate) card_partners: StdMutex<HashMap<String, String>>,
    /// Agent work waiting for a person's answer.
    pub(crate) agent_work: crate::agent_work::Waiting,
    /// Live connections of remembered clients, so revoking a key closes them at once.
    pub(crate) live_clients: StdMutex<Vec<(String, mpsc::UnboundedSender<Message>)>>,
    /// Pairings the hub answers over the relay, and the relay connection.
    pub(crate) remote: crate::remote::Remote,
    /// Names Bambu Lab printers announce for themselves (SSDP `DevName`), by serial.
    own_names: StdMutex<crate::own_names::OwnNames>,
    /// When the hub last listened for those announcements.
    names_heard: StdMutex<Option<Instant>>,
}

pub(crate) struct Registered {
    pub(crate) config: PrinterConfig,
    pub(crate) info: Value,
}

pub(crate) struct ServiceConfig {
    pub(crate) base_url: String,
    pub(crate) secret_ref: Option<String>,
}

impl Bridge {
    #[allow(clippy::too_many_arguments)] // Each argument is a separate dependency of the bridge.
    pub(crate) fn new(
        gate: Arc<dyn ApprovalGate>,
        secrets: Arc<dyn SecretStore>,
        code: PairingCode,
        agent_code: PairingCode,
        watch_code: PairingCode,
        identity: crate::identity::HubIdentity,
        extra_origins: Vec<String>,
        port: u16,
        broker: Option<Arc<sx_permit::ApprovalBroker>>,
        inbox: Option<Arc<Inbox>>,
        pair_limits: PairLimits,
        mdns: MdnsConfig,
        lan_bind: Option<std::net::IpAddr>,
        discovery_bind: Option<std::net::IpAddr>,
        hub: Hub,
        loaded: Loaded,
    ) -> Self {
        let connectors = sx_connect::registry_with(
            gate.clone(),
            discovery_bind.unwrap_or(std::net::Ipv4Addr::UNSPECIFIED.into()),
        );
        let lan = Arc::new(Lan::new(
            pair_limits,
            extra_origins.clone(),
            mdns.clone(),
            lan_bind,
        ));
        let printers = loaded
            .printers
            .into_iter()
            .map(|p| {
                (
                    p.config.id.clone(),
                    Registered {
                        config: p.config,
                        info: p.info,
                    },
                )
            })
            .collect();
        let services = loaded
            .services
            .into_iter()
            .map(|(k, v)| {
                (
                    k,
                    ServiceConfig {
                        base_url: v.base_url,
                        secret_ref: v.secret_ref,
                    },
                )
            })
            .collect();
        let remote = crate::remote::Remote::load(hub.dir.as_ref(), secrets.as_ref());
        Self {
            gate,
            secrets,
            code,
            agent_code,
            watch_code,
            identity,
            extra_origins,
            port,
            connectors,
            printers: Mutex::new(printers),
            sessions: Mutex::new(HashMap::new()),
            connecting: Mutex::new(HashMap::new()),
            feeds: Arc::default(),
            services: Mutex::new(services),
            fleets: Mutex::new(loaded.fleets),
            broker,
            inbox,
            lan,
            mdns,
            failures: StdMutex::new((0, None)),
            hub,
            next_conn: AtomicU64::new(1),
            card_owners: StdMutex::new(HashMap::new()),
            card_partners: StdMutex::new(HashMap::new()),
            agent_work: crate::agent_work::Waiting::default(),
            live_clients: StdMutex::new(Vec::new()),
            remote,
            own_names: StdMutex::new(crate::own_names::OwnNames::default()),
            names_heard: StdMutex::new(None),
        }
    }

    /// Keeps the names Bambu Lab printers announced for themselves, by serial.
    pub(crate) fn remember_names(&self, found: &[sx_connect::DiscoveredPrinter]) {
        self.own_names
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remember(found);
    }

    fn own_name(&self, serial: &str) -> Option<String> {
        self.own_names
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(serial)
            .map(str::to_owned)
    }

    /// The hub's own public key (`hub-key.pub`), for clients to pin.
    pub(crate) fn hub_key(&self) -> String {
        self.identity.public_b64()
    }

    pub(crate) fn secrets(&self) -> &dyn SecretStore {
        self.secrets.as_ref()
    }

    pub(crate) fn secrets_ref(&self) -> &dyn sx_connect::Secrets {
        self.secrets.as_ref()
    }

    pub(crate) fn secrets_ref_store(&self) -> &dyn SecretStore {
        self.secrets.as_ref()
    }

    /// Registered printer ids with their `PrinterInfo` JSON.
    pub(crate) async fn printer_infos(&self) -> Vec<(String, Value)> {
        let mut v: Vec<(String, Value)> = self
            .printers
            .lock()
            .await
            .iter()
            .map(|(id, r)| (id.clone(), r.info.clone()))
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }

    pub(crate) async fn has_printer(&self, id: &str) -> bool {
        self.printers.lock().await.contains_key(id)
    }

    fn locked(&self) -> bool {
        let mut f = self
            .failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match f.1 {
            Some(until) if until > Instant::now() => true,
            Some(_) => {
                *f = (0, None);
                false
            }
            None => false,
        }
    }

    fn record_failure(&self) {
        let mut f = self
            .failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        f.0 += 1;
        if f.0 >= GLOBAL_FAILURES {
            f.1 = Some(Instant::now() + LOCKOUT);
        }
    }

    fn host_ok(&self, host: &str) -> bool {
        let p = self.port;
        host == format!("127.0.0.1:{p}") || host == format!("localhost:{p}")
    }
}

/// Error body sent to the client: `{ code, message }`, codes from `PrinterErrorCode` plus
/// `bad_request`, `locked` and `unauthorized`.
#[derive(Debug, Clone)]
pub(crate) struct RpcError {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl RpcError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl From<FleetError> for RpcError {
    fn from(e: FleetError) -> Self {
        match e {
            FleetError::NotFound(m) => RpcError::new("not_found", m),
            FleetError::Invalid(m) => RpcError::new("protocol", m),
        }
    }
}

impl From<ConnectError> for RpcError {
    fn from(e: ConnectError) -> Self {
        let code = serde_json::to_value(e.code())
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "protocol".to_owned());
        Self {
            code,
            message: e.to_string(),
        }
    }
}

pub(crate) type Rpc<T> = Result<T, RpcError>;

#[allow(clippy::too_many_lines)] // One loop: handshake, pairing, dispatch and cleanup.
pub(crate) async fn handle_connection(bridge: Arc<Bridge>, stream: TcpStream) {
    let check = {
        let bridge = bridge.clone();
        #[allow(clippy::result_large_err)] // Same callback trait.
        move |req: &Request, resp: Response| handshake_check(&bridge, req, resp)
    };
    let mut cfg = WebSocketConfig::default();
    cfg.max_message_size = Some(MAX_MESSAGE);
    cfg.max_frame_size = Some(MAX_MESSAGE);
    let Ok(ws) = tokio_tungstenite::accept_hdr_async_with_config(stream, check, Some(cfg)).await else {
        return;
    };
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let queued = Arc::new(AtomicUsize::new(0));
    let written = queued.clone();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            let size = if let Message::Binary(b) = &m { b.len() } else { 0 };
            let sent = sink.send(m).await;
            if size > 0 {
                // Camera frames are counted when queued and released here, so the stream task can see a backlog.
                written.fetch_sub(size, Ordering::Relaxed);
            }
            if sent.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let mut conn = Conn {
        hello: None,
        pake: None,
        id: bridge.next_conn.fetch_add(1, Ordering::Relaxed),
        role: Role::Agent,
        paired: false,
        attempts: 0,
        subs: HashMap::new(),
        next_sub: 1,
        streams: HashMap::new(),
        next_stream: 1,
        queued,
        client: None,
        partner: None,
    };
    while let Some(Ok(msg)) = source.next().await {
        let Message::Text(text) = msg else {
            if matches!(msg, Message::Close(_)) {
                break;
            }
            continue;
        };
        let (id, method, params) = match parse_request(text.as_str()) {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(reply(&Value::Null, Err(e)));
                continue;
            }
        };
        // The hub proves who it is before a client sends any code (identity.rs).
        if method == "hello" {
            let out = bridge.identity.hello(&params, bridge.port).map(|(r, h)| {
                conn.hello = Some(h);
                r
            });
            let _ = tx.send(reply(&id, out));
            continue;
        }
        if !conn.paired {
            if method != "pair" {
                let _ = tx.send(reply(&id, Err(RpcError::new("unauthorized", "pair first"))));
                continue;
            }
            // A remembered key is 32 random bytes, so it cannot be guessed and is accepted even while
            // code pairing is locked: wrong codes from someone else never lock out a known client.
            let by_key = params
                .get("clientKey")
                .and_then(Value::as_str)
                .and_then(|k| bridge.hub.client_for_key(k));
            // A code sent in clear has already crossed the socket to whatever answered, and a
            // version 1 proof (an HMAC of the code) lets whatever answered test codes offline. Every
            // current client runs the code exchange instead, so both are refused without being
            // compared: the refusal says nothing about the code.
            if by_key.is_none() && (params.get("code").is_some() || params.get("proof").is_some()) {
                conn.attempts += 1;
                let _ = tx.send(reply(
                    &id,
                    Err(RpcError::new(
                        "unauthorized",
                        "this hub no longer takes a pairing code or a version 1 proof; update the app or tool you are connecting with",
                    )),
                ));
                if conn.attempts >= MAX_PAIR_ATTEMPTS {
                    break;
                }
                continue;
            }
            let mut by_code: Option<(Role, [u8; 32])> = None;
            if by_key.is_none() {
                if bridge.locked() {
                    let _ = tx.send(reply(
                        &id,
                        Err(RpcError::new(
                            "locked",
                            "too many wrong codes, try again in a minute",
                        )),
                    ));
                    break;
                }
                // First step of the code exchange (CPace, sx-cpace): answer the client's message
                // once per code. A run gives the client one guess, checked at its confirm.
                if let Some(ya) = params.get("pake") {
                    let out = pake_answer(&bridge, conn.hello.as_ref(), ya).map(|(answer, r)| {
                        conn.pake = Some(answer);
                        r
                    });
                    let _ = tx.send(reply(&id, out));
                    continue;
                }
                let tags: Vec<(&str, Vec<u8>)> = params
                    .get("confirm")
                    .and_then(Value::as_object)
                    .map(|o| {
                        o.iter()
                            .filter_map(|(k, v)| Some((k.as_str(), B64.decode(v.as_str()?).ok()?)))
                            .collect()
                    })
                    .unwrap_or_default();
                by_code = conn
                    .pake
                    .take()
                    .and_then(|a| a.check(&tags))
                    .and_then(|(role, confirm)| {
                        let role = match role {
                            "app" => Role::App,
                            "agent" => Role::Agent,
                            "watch" => Role::Watch,
                            _ => return None,
                        };
                        Some((role, confirm))
                    });
            }
            let role = by_key.as_ref().map(|(_, r, _)| *r).or(by_code.map(|(r, _)| r));
            if let Some(role) = role {
                let partner = by_key.as_ref().and_then(|(_, _, p)| p.clone());
                // A client may ask for the narrower role, never a wider one. A partner app stays an
                // agent: the detector's reports could pause a print with no card.
                let role = if partner.is_some() {
                    Role::Agent
                } else {
                    roles::narrowed(role, params.get("role").and_then(Value::as_str))
                };
                conn.paired = true;
                conn.role = role;
                if let Some((client_id, _, _)) = &by_key {
                    conn.client = Some(client_id.clone());
                    let mut live = crate::hub::lock(&bridge.live_clients);
                    live.retain(|(_, t)| !t.is_closed());
                    live.push((client_id.clone(), tx.clone()));
                }
                let mut out = serde_json::Map::new();
                out.insert("paired".into(), json!(true));
                out.insert("role".into(), json!(role.as_str()));
                if partner.is_some() {
                    out.insert("partner".into(), json!(true));
                }
                conn.partner = partner;
                // The hub's half of the key confirmation: proof that it holds the same code.
                if let Some((_, confirm)) = &by_code {
                    out.insert("confirm".into(), json!(B64.encode(confirm)));
                }
                // A client that pairs with a code can ask to be remembered, so it can come back
                // after the hub restarts without the code. The key is shown once.
                if by_code.is_some() && params.get("remember").and_then(Value::as_bool) == Some(true) {
                    let name = params.get("name").and_then(Value::as_str).unwrap_or("client");
                    let (key, client_id) = bridge.hub.remember_client(name, role);
                    out.insert("clientKey".into(), json!(key));
                    out.insert("clientId".into(), json!(client_id));
                    hub_rpc::save(&bridge).await;
                }
                let _ = tx.send(reply(&id, Ok(Value::Object(out))));
                // After the reply, so a client sees phone frames that waited for it as events.
                forward_events(&bridge, &mut conn, &tx);
            } else {
                if params.get("clientKey").is_none() {
                    bridge.record_failure();
                }
                conn.attempts += 1;
                let _ = tx.send(reply(
                    &id,
                    Err(RpcError::new("unauthorized", "wrong pairing code")),
                ));
                if conn.attempts >= MAX_PAIR_ATTEMPTS {
                    break;
                }
            }
            continue;
        }
        // A revoked key gets nothing more, even before its close frame goes out.
        if let Some(c) = &conn.client
            && !crate::hub::lock(&bridge.hub.clients).iter().any(|r| &r.id == c)
        {
            let _ = tx.send(Message::Close(None));
            break;
        }
        let out = dispatch(&bridge, &mut conn, &tx, &method, params).await;
        let _ = tx.send(reply(&id, out));
    }
    for (_, h) in conn.subs.drain() {
        h.abort();
    }
    for (id, (h, _, printer)) in conn.streams.drain() {
        sx_connect::trace(
            &printer,
            format_args!("live view {id} closed (the app's connection to the bridge closed)"),
        );
        h.abort();
    }
    drop(tx);
    let _ = writer.await;
}

/// Refuses the upgrade unless the Host header names this listener (DNS rebinding) and any
/// Origin is on the allow-list.
#[allow(clippy::result_large_err)] // The error type is fixed by tungstenite's callback trait.
fn handshake_check(bridge: &Bridge, req: &Request, resp: Response) -> Result<Response, ErrorResponse> {
    let reject = |why: &str| -> ErrorResponse {
        let mut r = ErrorResponse::new(Some(why.to_owned()));
        *r.status_mut() = StatusCode::FORBIDDEN;
        r
    };
    let host = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !bridge.host_ok(host) {
        return Err(reject("bad host"));
    }
    if let Some(origin) = req.headers().get("origin")
        && !origin_allowed(origin.to_str().unwrap_or(""), &bridge.extra_origins)
    {
        return Err(reject("origin not allowed"));
    }
    Ok(resp)
}

/// Starts the tasks that forward inbox and phone events to a client that just paired.
fn forward_events(bridge: &Arc<Bridge>, conn: &mut Conn, tx: &mpsc::UnboundedSender<Message>) {
    let me = conn.id;
    // Agents and detectors get only events addressed to them (and a detector the "this is fine"
    // answers); the app's cards, queue, beds and deliveries are not theirs.
    let role = conn.role;
    let agent = role != Role::App;
    let forward = |mut rx: broadcast::Receiver<Value>, wrap: bool| {
        let tx = tx.clone();
        tokio::spawn(async move {
            while let Ok(mut data) = rx.recv().await {
                // Events for one connection carry `to`; the others never see them.
                match data.get("to").and_then(Value::as_u64) {
                    Some(to) if to != me => continue,
                    Some(_) => {
                        if let Some(o) = data.as_object_mut() {
                            o.remove("to");
                        }
                    }
                    None if !roles::sees_broadcast(
                        role,
                        data.get("event").and_then(Value::as_str).unwrap_or(""),
                    ) =>
                    {
                        continue;
                    }
                    None => {}
                }
                let body = if wrap {
                    json!({ "event": "inbox", "data": data })
                } else {
                    data
                };
                if tx.send(Message::text(body.to_string())).is_err() {
                    break;
                }
            }
        })
    };
    // Phones talk to the app only. Subscribe first, then hand over what phones sent while no
    // client was attached.
    if conn.role == Role::App {
        let phones = bridge.lan.events.subscribe();
        for e in bridge.lan.take_backlog() {
            let _ = tx.send(Message::text(e.to_string()));
        }
        conn.subs.insert(u64::MAX, forward(phones, false));
    }
    conn.subs
        .insert(u64::MAX - 1, forward(bridge.hub.events.subscribe(), false));
    if let Some(inbox) = &bridge.inbox
        && !agent
    {
        conn.subs.insert(0, forward(inbox.events.subscribe(), true));
    }
}

/// `pair {pake}`: the hub's messages for one code exchange over this connection's hello.
fn pake_answer(
    bridge: &Bridge,
    hello: Option<&crate::identity::Hello>,
    ya: &Value,
) -> Rpc<(sx_cpace::pair::Answer, Value)> {
    let h = hello.ok_or_else(|| RpcError::new("unauthorized", "say hello first"))?;
    let ya = ya
        .as_str()
        .and_then(|t| B64.decode(t).ok())
        .ok_or_else(|| RpcError::new("bad_request", "pake is base64"))?;
    let ctx = sx_cpace::pair::Context {
        hub_key: bridge.identity.public_bytes(),
        port: bridge.port,
        client_nonce: &h.client,
        hub_nonce: &h.hub,
    };
    let codes = [
        ("app", bridge.code.raw()),
        ("agent", bridge.agent_code.raw()),
        ("watch", bridge.watch_code.raw()),
    ];
    let mut failed = false;
    let answer = sx_cpace::pair::Answer::new(&codes, &ctx, &ya, || {
        let mut b = [0u8; 32];
        failed |= getrandom::fill(&mut b).is_err();
        b
    })
    .ok_or_else(|| RpcError::new("bad_request", "pake is not a valid message"))?;
    if failed {
        return Err(RpcError::new("protocol", "no randomness"));
    }
    let messages: serde_json::Map<String, Value> = answer
        .messages
        .iter()
        .map(|(role, yb)| ((*role).to_owned(), json!(B64.encode(yb))))
        .collect();
    Ok((answer, json!({ "pake": messages })))
}

struct Conn {
    /// The nonces of this connection's `hello`, which the code exchange is bound to.
    hello: Option<crate::identity::Hello>,
    /// The hub's side of a code exchange waiting for the client's confirm.
    pake: Option<sx_cpace::pair::Answer>,
    /// Unique for the life of the bridge.
    id: u64,
    /// Set at pairing; `Agent` until then.
    role: Role,
    paired: bool,
    attempts: u32,
    subs: HashMap<u64, JoinHandle<()>>,
    next_sub: u64,
    /// Open camera streams: the task, what steers it, and the printer.
    streams: HashMap<u32, (JoinHandle<()>, Arc<camera::Control>, String)>,
    next_stream: u32,
    /// Camera bytes queued for this connection's writer and not yet written.
    queued: Arc<AtomicUsize>,
    /// The remembered client this connection paired as, so a revoked key stops at its next call.
    client: Option<String>,
    /// The partner app's name, when it paired with a partner key (roles.rs).
    partner: Option<String>,
}

fn parse_request(text: &str) -> Rpc<(Value, String, Value)> {
    let v: Value = serde_json::from_str(text).map_err(|_| RpcError::new("bad_request", "not JSON"))?;
    let id = v.get("id").cloned().unwrap_or(Value::Null);
    let method = v
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new("bad_request", "missing method"))?
        .to_owned();
    Ok((id, method, v.get("params").cloned().unwrap_or_else(|| json!({}))))
}

fn reply(id: &Value, r: Rpc<Value>) -> Message {
    let body = match r {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(e) => json!({ "id": id, "error": { "code": e.code, "message": e.message } }),
    };
    Message::text(body.to_string())
}

pub(crate) fn arg<T: for<'de> Deserialize<'de>>(params: &Value, key: &str) -> Rpc<T> {
    let v = params
        .get(key)
        .ok_or_else(|| RpcError::new("bad_request", format!("{key} is required")))?;
    serde_json::from_value(v.clone()).map_err(|_| RpcError::new("bad_request", format!("{key} is malformed")))
}

pub(crate) fn str_arg(params: &Value, key: &str) -> Rpc<String> {
    arg(params, key)
}

#[allow(clippy::too_many_lines)] // One flat table from method name to handler.
async fn dispatch(
    b: &Arc<Bridge>,
    conn: &mut Conn,
    tx: &mpsc::UnboundedSender<Message>,
    method: &str,
    p: Value,
) -> Rpc<Value> {
    if conn.role == Role::Agent
        && method == "callTool"
        && roles::tool_needs_person(
            p.get("pluginId").and_then(Value::as_str).unwrap_or(""),
            p.get("tool").and_then(Value::as_str).unwrap_or(""),
        )
    {
        return Err(RpcError::new(
            "forbidden",
            "Home Assistant service calls switch power; a person makes them in the SlicerX app",
        ));
    }
    // Agents queue nothing and receive no deliveries, so these lists hold nothing of theirs.
    if conn.role == Role::Agent && matches!(method, "queue.list" | "inbox.list") {
        return Ok(Value::Array(Vec::new()));
    }
    if !roles::allowed(conn.role, method) {
        return Err(RpcError::new(
            "forbidden",
            format!("{method} is for the SlicerX app; this connection paired with the agent code"),
        ));
    }
    if conn.partner.is_some() && !roles::partner_allowed(method) {
        return Err(RpcError::new(
            "forbidden",
            format!("{method} is not open to partner apps; a person does it in the SlicerX app"),
        ));
    }
    match method {
        "plugins" => Ok(hub_rpc::plugins(b, &p)),
        "printers.add" => {
            let out = add_printer(b, &p).await?;
            hub_rpc::save(b).await;
            Ok(out)
        }
        "printers.remove" => {
            let id = str_arg(&p, "printerId")?;
            b.printers.lock().await.remove(&id);
            b.sessions.lock().await.remove(&id);
            b.fleets.lock().await.forget_printer(&id);
            crate::hub::lock(&b.hub.beds).remove(&id);
            hub_rpc::save(b).await;
            Ok(json!({ "removed": true }))
        }
        "print.local" => hub_rpc::print_local(b, &p).await,
        m if m.starts_with("bed.") => hub_rpc::bed_call(b, m, &p).await,
        m if m.starts_with("queue.") => hub_rpc::queue_call(b, m, &p).await,
        m if m.starts_with("settings.") => hub_rpc::settings_call(b, m, &p).await,
        m if m.starts_with("clients.") => hub_rpc::clients_call(b, m, &p).await,
        m if m.starts_with("push.") => crate::push::call(b, m, &p).await,
        m if m.starts_with("remote.") => {
            crate::remote::call(b, m, &p, crate::remote::owner_of(conn.client.as_deref(), &p))
        }
        "inbox.list" => match &b.inbox {
            Some(i) => Ok(Value::Array(i.list().await)),
            None => Err(RpcError::new("not_supported", "this bridge has no inbox")),
        },
        "inbox.decline" => {
            let i = b
                .inbox
                .as_ref()
                .ok_or_else(|| RpcError::new("not_supported", "this bridge has no inbox"))?;
            if i.end(b, &str_arg(&p, "deliveryId")?, "declined", None).await {
                Ok(json!({ "declined": true }))
            } else {
                Err(RpcError::new("not_found", "no such delivery"))
            }
        }
        "pair.listen" => {
            let enabled: bool = arg(&p, "enabled")?;
            if enabled {
                let port = p
                    .get("port")
                    .and_then(Value::as_u64)
                    .map_or(Ok(DEFAULT_PAIR_PORT), u16::try_from)
                    .map_err(|_| RpcError::new("bad_request", "port is out of range"))?;
                let (port, advertised) = b
                    .lan
                    .start(port)
                    .await
                    .map_err(|m| RpcError::new("unreachable", m))?;
                *crate::hub::lock(&b.hub.lan_port) = Some(port);
                hub_rpc::save(b).await;
                Ok(json!({
                    "listening": true,
                    "port": port,
                    "addresses": crate::lan::lan_addresses(),
                    "advertised": advertised,
                }))
            } else {
                b.lan.stop().await;
                *crate::hub::lock(&b.hub.lan_port) = None;
                hub_rpc::save(b).await;
                Ok(json!({ "listening": false }))
            }
        }
        "pair.send" => {
            let frame = str_arg(&p, "frame")?;
            if frame.len() > MAX_FRAME {
                return Err(RpcError::new("bad_request", "frame is too large"));
            }
            if b.lan.send(&str_arg(&p, "conn")?, &frame) {
                Ok(json!({ "sent": true }))
            } else {
                Err(RpcError::new("not_found", "no such phone connection"))
            }
        }
        "pair.close" => {
            if b.lan.close(&str_arg(&p, "conn")?) {
                Ok(json!({ "closed": true }))
            } else {
                Err(RpcError::new("not_found", "no such phone connection"))
            }
        }
        m if m.starts_with("approvals.") => approval_call(b, conn, m, &p).await,
        m if m.starts_with("fleets.") => {
            let out = fleet_call(b, m, &p).await?;
            if m != "fleets.list" {
                hub_rpc::save(b).await;
            }
            Ok(out)
        }
        "printers.authorize" => authorize_printer(b, &p).await,
        "discover" => discover(b, &p).await,
        "probe" => probe(b, &p).await,
        "camera.open" => camera_open(b, conn, tx, &p).await,
        "camera.quality" => {
            let id: u32 = arg(&p, "stream")?;
            let q = camera::parse_quality(&str_arg(&p, "quality")?)
                .ok_or_else(|| RpcError::new("bad_request", "quality is low, medium, high or auto"))?;
            let (_, ctl, _) = conn
                .streams
                .get(&id)
                .ok_or_else(|| RpcError::new("not_found", "no such stream"))?;
            ctl.quality.store(q, Ordering::Relaxed);
            ctl.ceiling.store(q, Ordering::Relaxed);
            Ok(json!({ "quality": camera::quality_name(q) }))
        }
        "camera.close" => {
            let id: u32 = arg(&p, "stream")?;
            if let Some((h, _, printer)) = conn.streams.remove(&id) {
                let reason = camera::close_reason(&p);
                sx_connect::trace(&printer, format_args!("live view {id} closed ({reason})"));
                h.abort();
            }
            Ok(json!({ "closed": true }))
        }
        "camera.probe" => camera_probe(b, &p).await,
        "camera.grab" => crate::watch::grab_call(b, &p).await,
        "watch.subscribe" => {
            let (every, only) = crate::watch::subscribe_args(&p)?;
            let id = conn.next_sub;
            conn.next_sub += 1;
            conn.subs.insert(
                id,
                tokio::spawn(crate::watch::feed(b.clone(), id, every, only, tx.clone())),
            );
            Ok(json!({ "subscription": id }))
        }
        "watch.unsubscribe" => {
            let id: u64 = arg(&p, "subscription")?;
            if let Some(h) = conn.subs.remove(&id) {
                h.abort();
            }
            Ok(json!({ "unsubscribed": true }))
        }
        "watch.report" => crate::watch::report(b, &p).await,
        "watch.autoPause" => crate::watch::auto_pause_call(b, &p).await,
        "watch.mask" => crate::watch::mask_call(b, &p).await,
        "watch.masks" => Ok(crate::watch::masks_call(b)),
        "watch.huginn" => crate::watch::huginn_call(b, &p).await,
        "watch.huginnPrinters" => Ok(crate::watch::huginn_printers(b)),
        "watch.dismiss" => crate::watch::dismiss_call(b, &p),
        "watch.grab" => crate::guard::grab_call(b, &p).await,
        "watch.plateResult" | "watch.lookResult" => crate::guard::plate_result_call(b, &p),
        "watch.handCheck" => crate::guard::hand_check_call(b, &p).await,
        "watch.resume" => crate::guard::resume_call(b, &p).await,
        "watch.plateClear" => crate::guard::plate_clear_call(b, &p).await,
        "watch.plateCheck" => crate::guard::plate_check_call(b, &p).await,
        "watch.plateIgnore" => crate::guard::plate_ignore_call(b, &p).await,
        "watch.guard" => crate::guard::guard_call(b, &p).await,
        "watch.guardState" => Ok(crate::guard::guard_state_call(b)),
        "watch.evidence" => crate::guard::evidence_call(b, &p).await,
        m if m.starts_with("adjust") => crate::adjust::call(b, m, &p).await,
        method @ ("files.list" | "history.list" | "issues.list" | "objects.list" | "objects.skip" | "jog"
        | "files.start") => crate::device::call(b, method, &p).await,
        "cameras.discover" => discover_cameras(b, &p).await,
        "camera.webrtc" => {
            let id = str_arg(&p, "printerId")?;
            let sdp = str_arg(&p, "sdp")?;
            if !sx_connect::camera::valid_sdp(&sdp) {
                return Err(RpcError::new("bad_request", "sdp is not a session description"));
            }
            match session(b, &id).await?.webrtc_offer(&sdp).await? {
                Some(answer) => Ok(json!({ "sdp": answer })),
                None => Err(RpcError::new(
                    "not_supported",
                    "this printer's camera has no WebRTC service",
                )),
            }
        }
        "printers.test" => test_printer(b, &p).await,
        "list" => Ok(Value::Array(
            b.printers.lock().await.values().map(|r| r.info.clone()).collect(),
        )),
        "status" => printer_status(b, &str_arg(&p, "printerId")?).await,
        "subscribe" => {
            let id = str_arg(&p, "printerId")?;
            let s = session(b, &id).await?;
            let sub = conn.next_sub;
            conn.next_sub += 1;
            let tx = tx.clone();
            let mut events = s.events();
            let keeps_heat = s.pause_heater_timeout().is_none();
            let printer = id.clone();
            let bridge = b.clone();
            let sess = s.clone();
            let serial = announced_serial(b, &id).await;
            let h = tokio::spawn(async move {
                while let Some(e) = events.next().await {
                    let mut data = to_value(&e);
                    // Status events carry the print watch state too, so the app's watch dot is live.
                    if let Some(st) = data.get_mut("status").and_then(Value::as_object_mut) {
                        note_model(sess.as_ref(), st);
                        note_own_name(&bridge, serial.as_deref(), st);
                        st.insert(
                            "watch".into(),
                            json!(bridge.hub.watch_state(&printer, crate::hub::now_ms())),
                        );
                        crate::watch::note_paused_heat(&bridge, &printer, keeps_heat, st);
                    }
                    let body = json!({ "event": "printer", "subscription": sub, "printerId": printer, "data": data });
                    if tx.send(Message::text(body.to_string())).is_err() {
                        break;
                    }
                }
            });
            conn.subs.insert(sub, h);
            Ok(json!({ "subscription": sub }))
        }
        "unsubscribe" => {
            let sub: u64 = arg(&p, "subscription")?;
            if let Some(h) = conn.subs.remove(&sub) {
                h.abort();
            }
            Ok(json!({ "ok": true }))
        }
        "prepareUpload" => prepare_upload_call(b, &p).await,
        "upload" => upload_call(b, &p).await,
        "start" => hub_rpc::start_with_token(b, &p).await,
        "pause" | "resume" | "cancel" => {
            let id = str_arg(&p, "printerId")?;
            let token: ApprovalToken = arg(&p, "token")?;
            let s = session(b, &id).await?;
            match method {
                "pause" => s.pause(&token).await?,
                "resume" => s.resume(&token).await?,
                _ => s.cancel(&token).await?,
            }
            Ok(json!({ "ok": true }))
        }
        "gcode" => {
            let id = str_arg(&p, "printerId")?;
            let line = str_arg(&p, "line")?;
            // One command per call, the same rule agent work follows (N1).
            if let Some(why) = sx_connect::gcode_line_problem(&line) {
                return Err(RpcError::new("bad_request", format!("line: {why}")));
            }
            let token: ApprovalToken = arg(&p, "token")?;
            session(b, &id).await?.send_gcode(&line, &token).await?;
            Ok(json!({ "ok": true }))
        }
        "snapshot" => crate::watch::snapshot_call(b, &p).await,
        "services.configure" => {
            let plugin = str_arg(&p, "pluginId")?;
            let base_url = str_arg(&p, "baseUrl")?;
            if !matches!(plugin.as_str(), "spoolman" | "home-assistant" | "bambuddy") {
                return Err(RpcError::new("not_found", format!("no service plugin {plugin}")));
            }
            let host = url_host(&base_url).unwrap_or_default();
            if !(base_url.starts_with("http://") || base_url.starts_with("https://")) || !is_lan_host(&host) {
                return Err(RpcError::new(
                    "bad_request",
                    "service URLs must be http(s) on the local network",
                ));
            }
            if sx_connect::is_experimental(&plugin) && !b.hub.experimental() {
                return Err(hub_rpc::experimental_refusal(&plugin));
            }
            b.services.lock().await.insert(
                plugin,
                ServiceConfig {
                    base_url,
                    secret_ref: p.get("secretRef").and_then(Value::as_str).map(str::to_owned),
                },
            );
            hub_rpc::save(b).await;
            Ok(json!({ "ok": true }))
        }
        // The configured services, by plugin id. Addresses only: a secret stays a keychain name.
        "services.list" => {
            let svc = b.services.lock().await;
            let list: Vec<Value> = svc
                .iter()
                .map(|(id, c)| json!({ "pluginId": id, "baseUrl": c.base_url, "hasSecret": c.secret_ref.is_some() }))
                .collect();
            Ok(Value::Array(list))
        }
        // Whether a connected app answers at its address with its key. BamBuddy only: Spoolman is
        // checked through its tools.
        "services.check" => {
            let plugin = str_arg(&p, "pluginId")?;
            if plugin != "bambuddy" {
                return Err(RpcError::new("not_supported", format!("{plugin} has no check")));
            }
            let probe: PrinterConfig = serde_json::from_value(json!({
                "id": "bambuddy", "name": "BamBuddy", "plugin": "bambuddy", "host": ""
            }))
            .map_err(|e| RpcError::new("internal", e.to_string()))?;
            let cfg = through_app(b, probe).await?;
            let printers = sx_connect::drivers::bambuddy::server_printers(&cfg, b.secrets.as_ref()).await?;
            Ok(json!({ "ok": true, "printers": printers }))
        }
        "services.remove" => {
            let plugin = str_arg(&p, "pluginId")?;
            let removed = b.services.lock().await.remove(&plugin).is_some();
            if removed {
                hub_rpc::save(b).await;
            }
            Ok(json!({ "removed": removed }))
        }
        "callTool" => call_tool(b, &p).await,
        "secrets.set" => {
            let name = str_arg(&p, "name")?;
            let value = str_arg(&p, "value")?;
            // A keychain that refuses the write does not stop the caller: the bridge keeps the value for
            // the session and says so (`kept`), for the app to tell the person.
            let kept = match b.secrets.set_kept(&name, &value)? {
                sx_connect::Kept::Stored => "stored",
                sx_connect::Kept::Session => "session",
            };
            Ok(json!({ "ok": true, "kept": kept }))
        }
        "secrets.has" => Ok(json!({ "has": b.secrets.has(&str_arg(&p, "name")?) })),
        "secrets.delete" => {
            b.secrets.delete(&str_arg(&p, "name")?)?;
            Ok(json!({ "ok": true }))
        }
        m if m.starts_with("llm.") || m.starts_with("approvals.") => Err(RpcError::new(
            "not_supported",
            "available once sx-llm and sx-permit are wired into sx-link",
        )),
        other => Err(RpcError::new("bad_request", format!("unknown method {other}"))),
    }
}

/// Rewrites a file the way `upload` will, and returns those bytes with their sha256.
/// No token: nothing is sent. The caller approves this sha256, then uploads this file.
async fn prepare_upload_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let id = str_arg(p, "printerId")?;
    let file = hub_rpc::decode_file(p)?;
    let plugin = b
        .printers
        .lock()
        .await
        .get(&id)
        .map(|r| r.config.plugin.clone())
        .ok_or_else(|| RpcError::new("not_found", format!("no printer {id}")))?;
    // Only a plugin that rewrites files connects here; every other file comes back as it is.
    let prepared = if sx_connect::rewrites_upload(&plugin) {
        session(b, &id).await?.prepare_upload(file).await?
    } else {
        file
    };
    Ok(json!({
        "name": prepared.name,
        "kind": prepared.kind,
        "sha256": prepared.sha256,
        "dataBase64": B64.encode(&prepared.data),
    }))
}

async fn upload_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    if let Some(delivery) = p.get("deliveryId").and_then(Value::as_str) {
        return upload_delivery(b, p, delivery).await;
    }
    let id = str_arg(p, "printerId")?;
    let token: ApprovalToken = arg(p, "token")?;
    let file = hub_rpc::decode_file(p)?;
    // Held for the whole upload: a start waits for it, and it waits for a start, so a file never
    // lands between a start's hash check and the start.
    let held = b.hub.printer_lock(&id);
    let _held = held.lock().await;
    let size = u64::try_from(file.data.len()).unwrap_or(u64::MAX);
    let s = session(b, &id).await?;
    let rf = s.upload(file, &token).await?;
    hub_rpc::record_upload(b, &rf, size).await;
    to_json(&rf)
}

/// Uploads a file the inbox delivered. The approval token binds the same parameters as any upload
/// (`{printerId, name, sha256}`), taken from the delivery the bridge verified.
async fn upload_delivery(b: &Arc<Bridge>, p: &Value, delivery: &str) -> Rpc<Value> {
    let inbox = b
        .inbox
        .as_ref()
        .ok_or_else(|| RpcError::new("not_supported", "this bridge has no inbox"))?;
    let id = str_arg(p, "printerId")?;
    let token: ApprovalToken = arg(p, "token")?;
    let (name, sha256, data) = inbox.claim(delivery, &id).await.map_err(|e| match e {
        ClaimError::Unknown => RpcError::new("not_found", "no such delivery, or it was already uploaded"),
        ClaimError::WrongPrinter => RpcError::new("bad_request", "the delivery is for another printer"),
    })?;
    let lower = name.to_ascii_lowercase();
    let kind = if lower.ends_with(".gcode.3mf") {
        JobKind::Gcode3mf
    } else if lower.ends_with(".bgcode") {
        JobKind::Bgcode
    } else {
        JobKind::Gcode
    };
    let held = b.hub.printer_lock(&id);
    let _held = held.lock().await;
    let s = session(b, &id).await?;
    match s
        .upload(
            JobFile {
                name,
                kind,
                data: data.as_ref().clone(),
                sha256,
            },
            &token,
        )
        .await
    {
        Ok(rf) => {
            hub_rpc::record_upload(b, &rf, u64::try_from(data.len()).unwrap_or(u64::MAX)).await;
            inbox.uploaded(b, delivery).await;
            to_json(&rf)
        }
        Err(e) => {
            // A refused approval can be retried; anything else ends the delivery.
            if !matches!(
                e.code(),
                sx_connect::ErrorCode::ApprovalRequired | sx_connect::ErrorCode::ApprovalInvalid
            ) {
                inbox
                    .end(
                        b,
                        delivery,
                        "failed",
                        Some("the printer did not accept the upload"),
                    )
                    .await;
            }
            Err(e.into())
        }
    }
}

/// A printer reached through a connected app (`BamBuddy`) takes that app's address, port and key from
/// Settings, Connected apps each time: the printer itself only names its id in the app. Any other
/// printer's config is returned unchanged.
pub(crate) async fn through_app(b: &Bridge, mut config: PrinterConfig) -> Rpc<PrinterConfig> {
    let Some(app) = sx_connect::connected_app(&config.plugin) else {
        return Ok(config);
    };
    let name = sx_connect::manifest(app).map_or_else(|| app.to_owned(), |m| m.name);
    let services = b.services.lock().await;
    let service = services.get(app).ok_or_else(|| {
        RpcError::new(
            "not_configured",
            format!("add {name} in Settings, Connected apps first"),
        )
    })?;
    let bad = || {
        RpcError::new(
            "bad_request",
            format!("the {name} address in Connected apps is malformed"),
        )
    };
    let (scheme, rest) = service.base_url.split_once("://").ok_or_else(bad)?;
    let host = url_host(&service.base_url).ok_or_else(bad)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let port = authority
        .rsplit_once(':')
        .and_then(|(_, p)| p.parse::<u16>().ok());
    config.host = host;
    config.port = port;
    config.tls = Some(scheme.eq_ignore_ascii_case("https"));
    config.credential_ref = service.secret_ref.clone();
    Ok(config)
}

/// The host part of an http(s) URL, without userinfo or port. `None` when userinfo is present.
fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') {
        return None;
    }
    if let Some(v6) = authority.strip_prefix('[') {
        return v6.split_once(']').map(|(h, _)| h.to_owned());
    }
    match authority.rsplit_once(':') {
        Some((h, port)) if port.bytes().all(|c| c.is_ascii_digit()) => Some(h.to_owned()),
        _ => Some(authority.to_owned()),
    }
}

fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

pub(crate) fn to_json<T: serde::Serialize>(v: &T) -> Rpc<Value> {
    serde_json::to_value(v).map_err(|_| RpcError::new("protocol", "could not encode reply"))
}

fn offline(id: &str, e: &ConnectError) -> PrinterStatus {
    let mut s = PrinterStatus::offline(id);
    s.message = Some(e.to_string());
    s
}

/// Pairs with a printer that asks for confirmation on its own screen (Snapmaker 2.0) and keeps
/// the credential it returns in the keychain under the printer's `credentialRef`. The credential
/// itself is never sent back to the client.
/// `approvals.register`. An agent's card gets origin `mcp`; a person-only one must carry its work.
/// One printer's status with its print watch state. A printer that is off reads as offline.
pub(crate) async fn printer_status(b: &Arc<Bridge>, id: &str) -> Rpc<Value> {
    match session(b, id).await {
        Ok(s) => match s.status().await {
            Ok(st) => {
                hub_rpc::record(b, id, &st);
                let serial = announced_serial(b, id).await;
                learn_own_names(b, serial.as_deref());
                let mut v = to_json(&st)?;
                if let Some(o) = v.as_object_mut() {
                    note_model(s.as_ref(), o);
                    note_own_name(b, serial.as_deref(), o);
                    o.insert("watch".into(), json!(b.hub.watch_state(id, crate::hub::now_ms())));
                    crate::watch::note_paused_heat(b, id, s.pause_heater_timeout().is_none(), o);
                }
                Ok(v)
            }
            Err(e) => to_json(&offline(id, &e)),
        },
        // A printer that is off is a normal state for the printers list, not an error.
        Err(e) if matches!(e.code.as_str(), "unreachable" | "tls" | "timeout") => {
            to_json(&PrinterStatus::offline(id))
        }
        // Not stored here: the printers list shows it offline and asks for the code (`needsCode`).
        Err(e) if e.code == "credential_missing" => {
            let code_ref = b
                .printers
                .lock()
                .await
                .get(id)
                .and_then(|r| r.config.credential_ref.clone());
            let mut v = to_json(&PrinterStatus::offline(id))?;
            if let Some(o) = v.as_object_mut() {
                o.insert("needsCode".into(), json!(true));
                // Where the app stores the code it asks for: a name, never a secret.
                o.insert("codeRef".into(), json!(code_ref));
            }
            Ok(v)
        }
        Err(e) => Err(e),
    }
}

/// Adds `model` to a status object when the printer names its own model (Bambu Lab `get_version`).
fn note_model(s: &dyn PrinterSession, st: &mut serde_json::Map<String, Value>) {
    if let Some(m) = s.reported_model() {
        st.insert("model".into(), json!(m));
    }
}

/// How long the hub listens for printer announcements when it needs a name, and how long it waits
/// before listening again. Bambu Lab printers announce themselves every few seconds.
const NAME_LISTEN: Duration = Duration::from_secs(6);
const NAME_RETRY: Duration = Duration::from_secs(60);

/// The serial of a registered Bambu Lab printer, the key its announced name is kept under.
async fn announced_serial(b: &Bridge, id: &str) -> Option<String> {
    let printers = b.printers.lock().await;
    let c = &printers.get(id)?.config;
    if c.plugin == "bambu-lan" {
        c.serial.clone()
    } else {
        None
    }
}

/// Adds `ownName` to a status object: the name the printer announces for itself (Bambu Lab SSDP
/// `DevName`, "Tawain #1"), which the app shows when the printer was added under its model alone.
fn note_own_name(b: &Bridge, serial: Option<&str>, st: &mut serde_json::Map<String, Value>) {
    if let Some(n) = serial.and_then(|s| b.own_name(s)) {
        st.insert("ownName".into(), json!(n));
    }
}

/// Listens for printer announcements in the background when a Bambu Lab printer's own name is not
/// known yet, at most once a minute. Passive: nothing is sent to the printer.
fn learn_own_names(b: &Arc<Bridge>, serial: Option<&str>) {
    let Some(serial) = serial else { return };
    if b.own_name(serial).is_some() {
        return;
    }
    {
        let mut last = b
            .names_heard
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if last.is_some_and(|t| t.elapsed() < NAME_RETRY) {
            return;
        }
        *last = Some(Instant::now());
    }
    let b = b.clone();
    tokio::spawn(async move {
        let Some(c) = b.connectors.iter().find(|c| c.manifest().id == "bambu-lan") else {
            return;
        };
        let found = c.discover(NAME_LISTEN).await;
        b.remember_names(&found);
    });
}

/// Events of one printer, with the print watch state on status events.
pub(crate) async fn printer_events(
    b: &Arc<Bridge>,
    id: &str,
) -> Rpc<impl futures::Stream<Item = Value> + Send + 'static + use<>> {
    let s = session(b, id).await?;
    let bridge = b.clone();
    let printer = id.to_owned();
    let keeps_heat = s.pause_heater_timeout().is_none();
    let sess = s.clone();
    let serial = announced_serial(b, id).await;
    Ok(s.events().map(move |e| {
        let mut data = to_value(&e);
        if let Some(st) = data.get_mut("status").and_then(Value::as_object_mut) {
            note_model(sess.as_ref(), st);
            note_own_name(&bridge, serial.as_deref(), st);
            st.insert(
                "watch".into(),
                json!(bridge.hub.watch_state(&printer, crate::hub::now_ms())),
            );
            crate::watch::note_paused_heat(&bridge, &printer, keeps_heat, st);
        }
        data
    }))
}

fn register_card(b: &Arc<Bridge>, broker: &sx_permit::ApprovalBroker, conn: &Conn, p: &Value) -> Rpc<Value> {
    let bad = |e: sx_permit::Error| RpcError::new("bad_request", e.to_string());
    let mut req: sx_permit::ApprovalRequest = arg(p, "request")?;
    if conn.role == Role::Agent {
        // Whatever the agent claims, its cards are agent cards, and they wait minutes, not days,
        // so an agent cannot hold the waiting slots with far-off expiry (N2).
        req.origin = Some(sx_permit::StartOrigin::Mcp);
        broker.cap_expiry(&mut req, crate::agent_work::AGENT_CARD_TTL);
    }
    if let Some(name) = &conn.partner {
        if !roles::partner_may_ask(req.actions.iter().map(|a| a.action.as_str())) {
            return Err(RpcError::new(
                "forbidden",
                "a partner app may ask only to print, pause or cancel",
            ));
        }
        // The card says who asked, in the hub's words, above the partner's own lines.
        req.lines.insert(0, format!("Asked by {name}, a partner app"));
    }
    let id = req.id.clone();
    let printer = req.printer_id.clone();
    // A partner answers only its pause and cancel cards; anything else it raises waits for a person.
    let person = (conn.partner.is_some()
        && !roles::partner_may_grant(req.actions.iter().map(|a| a.action.as_str())))
        || roles::person_only(req.actions.iter().map(|a| (a.action.as_str(), a.target.as_str())));
    let mut card = serde_json::to_value(&req).unwrap_or(Value::Null);
    // An agent's person-only card carries its work; the hub runs it once a person approves.
    let work = crate::agent_work::work_arg(p)?;
    if let (Some(w), Some(o)) = (&work, card.as_object_mut()) {
        o.insert("work".into(), w.summary());
    }
    if let (Some(name), Some(o)) = (&conn.partner, card.as_object_mut()) {
        o.insert("partner".into(), json!(name));
    }
    match (conn.role, person, work) {
        (Role::Agent, true, Some(w)) => b
            .agent_work
            .hold(&req, conn.id, w, None, |id| broker.is_open(id))?,
        (Role::Agent, true, None) => {
            return Err(RpcError::new(
                "bad_request",
                if conn.partner.is_some() {
                    "a partner app's card needs its work, which the hub runs once a person approves"
                } else {
                    "a card that starts a print, resumes or sends G-code needs its work, which the hub runs once a person approves"
                },
            ));
        }
        (_, _, Some(_)) => {
            return Err(RpcError::new(
                "bad_request",
                "work rides only with an agent's card that a person has to approve",
            ));
        }
        _ => {}
    }
    if let Err(e) = broker.register(req) {
        let _ = b.agent_work.take(&id);
        return Err(bad(e));
    }
    if let Some(name) = &conn.partner {
        crate::hub::lock(&b.card_partners).insert(id.clone(), name.clone());
    }
    if conn.role == Role::Agent {
        crate::hub::lock(&b.card_owners).insert(id.clone(), conn.id);
        if person {
            b.hub.emit("approval", card);
            b.hub.emit(
                    "alert",
                    json!({ "printerId": printer, "kind": "approval_waiting", "requestId": id, "at": crate::hub::iso(crate::hub::now_ms()) }),
                );
            crate::push::alert(b, "approval_waiting", printer.as_deref(), Some(&id));
        }
    }
    Ok(
        json!({ "registered": true, "answeredIn": if conn.role == Role::Agent && person { "app" } else { "here" } }),
    )
}

/// `approvals.register`, `approvals.grant`, `approvals.deny` and `approvals.pending` on the broker,
/// with the role rules in `roles.rs`. A card an agent registers gets origin `mcp`, is shown to the
/// app (an `approval` event and an `approval_waiting` alert), and when a person answers it the token
/// goes to the agent alone as an `approval.granted` event (or `approval.denied`).
async fn approval_call(b: &Arc<Bridge>, conn: &Conn, method: &str, p: &Value) -> Rpc<Value> {
    let broker = b
        .broker
        .as_ref()
        .ok_or_else(|| RpcError::new("not_supported", "this bridge has no approval broker"))?;
    let bad = |e: sx_permit::Error| RpcError::new("bad_request", e.to_string());
    let owner = |id: &str| crate::hub::lock(&b.card_owners).get(id).copied();
    let needs_person = |id: &str| {
        broker.request(id).is_some_and(|r| {
            roles::person_only(r.actions.iter().map(|a| (a.action.as_str(), a.target.as_str())))
        })
    };
    match method {
        "approvals.register" => register_card(b, broker, conn, p),
        "approvals.grant" => {
            let id = str_arg(p, "requestId")?;
            let own = owner(&id) == Some(conn.id);
            // A partner answers only its own pause or cancel card.
            let partner_stop = || {
                broker
                    .request(&id)
                    .is_some_and(|r| roles::partner_may_grant(r.actions.iter().map(|a| a.action.as_str())))
            };
            if (conn.partner.is_some() && !partner_stop())
                || !roles::may_answer(conn.role, own, needs_person(&id))
            {
                return Err(RpcError::new(
                    "forbidden",
                    "a person answers this card in the SlicerX app or on a paired phone",
                ));
            }
            let out = hub_rpc::grant(b, broker, p).await?;
            // Agent work runs here, under the person's token; the agent never gets the token.
            if let Some((owner, work)) = b.agent_work.take(&id) {
                let token: ApprovalToken = serde_json::from_value(out.clone())
                    .map_err(|_| RpcError::new("protocol", "the broker gave no token"))?;
                crate::agent_work::run(b, id.clone(), work, token, owner);
                return Ok(json!({ "granted": true, "runBy": "hub" }));
            }
            Ok(out)
        }
        "approvals.deny" => {
            let id = str_arg(p, "requestId")?;
            let own = owner(&id) == Some(conn.id);
            if !roles::may_answer(conn.role, own, false) {
                return Err(RpcError::new(
                    "forbidden",
                    "an agent can withdraw only its own cards",
                ));
            }
            hub_rpc::declined(b, &id);
            broker.deny(&id).map_err(bad)?;
            let _ = b.agent_work.take(&id);
            if let Some(to) = owner(&id).filter(|o| *o != conn.id) {
                b.hub.emit_to("approval.denied", json!({ "requestId": id }), to);
            }
            Ok(json!({ "denied": true }))
        }
        "approvals.pending" => Ok(Value::Array(
            broker
                .pending()
                .iter()
                .filter(|id| conn.role == Role::App || owner(id) == Some(conn.id))
                .filter_map(|id| broker.request(id))
                .map(|r| {
                    let mut v = serde_json::to_value(&r).unwrap_or(Value::Null);
                    if let (Some(w), Some(o)) = (b.agent_work.summary(&r.id), v.as_object_mut()) {
                        o.insert("work".into(), w);
                    }
                    if let (Some(name), Some(o)) = (
                        crate::hub::lock(&b.card_partners).get(&r.id).cloned(),
                        v.as_object_mut(),
                    ) {
                        o.insert("partner".into(), json!(name));
                    }
                    v
                })
                .collect(),
        )),
        other => Err(RpcError::new("bad_request", format!("unknown method {other}"))),
    }
}

async fn fleet_call(b: &Arc<Bridge>, method: &str, p: &Value) -> Rpc<Value> {
    let known: std::collections::HashSet<String> = b.printers.lock().await.keys().cloned().collect();
    let is_known = |id: &str| known.contains(id);
    let mut fleets = b.fleets.lock().await;
    let opt = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_owned);
    let fleet_id = || str_arg(p, "fleetId");
    match method {
        "fleets.list" => to_json(&fleets.all()),
        "fleets.create" => {
            let ids: Vec<String> = p
                .get("printerIds")
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()
                .map_err(|_| RpcError::new("bad_request", "printerIds is malformed"))?
                .unwrap_or_default();
            to_json(&fleets.create(&str_arg(p, "name")?, opt("color"), opt("icon"), ids, &is_known)?)
        }
        "fleets.rename" => to_json(&fleets.rename(&fleet_id()?, &str_arg(p, "name")?)?),
        "fleets.update" => to_json(&fleets.update(&fleet_id()?, p)?),
        "fleets.delete" => {
            fleets.delete(&fleet_id()?)?;
            Ok(json!({ "deleted": true }))
        }
        "fleets.add" => to_json(&fleets.add(&fleet_id()?, &str_arg(p, "printerId")?, &is_known)?),
        "fleets.remove" => to_json(&fleets.remove(&fleet_id()?, &str_arg(p, "printerId")?)?),
        other => Err(RpcError::new("bad_request", format!("unknown method {other}"))),
    }
}

async fn authorize_printer(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let id = str_arg(p, "printerId")?;
    let secs: u64 = p
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(60)
        .min(120);
    let config = b
        .printers
        .lock()
        .await
        .get(&id)
        .map(|r| r.config.clone())
        .ok_or_else(|| RpcError::new("not_found", format!("no printer {id}")))?;
    let reference = config.credential_ref.clone().ok_or_else(|| {
        RpcError::new(
            "bad_request",
            "the printer needs a credentialRef to store its pairing token",
        )
    })?;
    let connector = b
        .connectors
        .iter()
        .find(|c| c.manifest().id == config.plugin)
        .ok_or_else(|| RpcError::new("not_found", "no plugin"))?;
    match connector
        .authorize(&config, std::time::Duration::from_secs(secs))
        .await?
    {
        Some(token) => {
            b.secrets.set(&reference, &token)?;
            b.sessions.lock().await.remove(&id);
            Ok(json!({ "authorized": true, "stored": true }))
        }
        None => Ok(json!({ "authorized": true, "stored": false })),
    }
}

async fn add_printer(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let config: PrinterConfig = arg(p, "config")?;
    let config = through_app(b, config).await?;
    if !is_lan_host(&config.host) {
        return Err(RpcError::new(
            "bad_request",
            "printers must be on the local network",
        ));
    }
    if !b.connectors.iter().any(|c| c.manifest().id == config.plugin) {
        return Err(RpcError::new("not_found", format!("no plugin {}", config.plugin)));
    }
    if sx_connect::is_experimental(&config.plugin) && !b.hub.experimental() {
        return Err(hub_rpc::experimental_refusal(&config.plugin));
    }
    if let Some(url) = &config.camera_url {
        let host = url
            .split_once("://")
            .filter(|(scheme, _)| matches!(*scheme, "rtsp" | "rtsps" | "http" | "onvif"))
            .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())
            .filter(|a| !a.contains('@'))
            .map(|a| match a.rsplit_once(':') {
                Some((h, port)) if port.bytes().all(|c| c.is_ascii_digit()) => h,
                _ => a,
            })
            .map(|h| h.trim_matches(['[', ']']));
        if !host.is_some_and(is_lan_host) {
            return Err(RpcError::new(
                "bad_request",
                "the camera must be on the local network, at an rtsp, rtsps, onvif or http address with no user name in it",
            ));
        }
    }
    let manifest = sx_connect::manifest(&config.plugin);
    let info_in = p.get("info").cloned().unwrap_or_else(|| json!({}));
    let info = json!({
        "id": config.id,
        "name": config.name,
        "vendor": info_in.get("vendor").cloned().unwrap_or_else(|| json!(manifest.as_ref().map_or("", |m| m.name.as_str()))),
        "model": info_in.get("model").cloned().unwrap_or_else(|| json!("")),
        "plugin": config.plugin,
        "host": config.host,
        "nozzleCount": info_in.get("nozzleCount").cloned().unwrap_or_else(|| json!(1)),
        "filamentSystem": info_in.get("filamentSystem"),
    });
    let id = config.id.clone();
    b.sessions.lock().await.remove(&id);
    b.printers.lock().await.insert(
        id,
        Registered {
            config,
            info: strip_nulls(info.clone()),
        },
    );
    Ok(strip_nulls(info))
}

fn strip_nulls(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.into_iter().filter(|(_, v)| !v.is_null()).collect()),
        other => other,
    }
}

/// The last failed attempt to open a printer's session and when it ended, behind the lock its openers share.
type Opening = Arc<Mutex<Option<(Instant, RpcError)>>>;

/// The printer's session, opened on first use. One connection per printer: a caller that arrives while
/// one is being opened waits for it and shares its outcome. Two connections at once would double the
/// load on the printer, and two MQTT sessions with one client id knock each other offline.
pub(crate) async fn session(b: &Arc<Bridge>, id: &str) -> Rpc<Arc<dyn PrinterSession>> {
    if let Some(s) = b.sessions.lock().await.get(id) {
        return Ok(s.clone());
    }
    let asked = Instant::now();
    let slot = b
        .connecting
        .lock()
        .await
        .entry(id.to_owned())
        .or_default()
        .clone();
    let mut last = slot.lock().await;
    if let Some(s) = b.sessions.lock().await.get(id) {
        return Ok(s.clone());
    }
    if let Some((at, e)) = last.as_ref()
        && *at >= asked
    {
        return Err(e.clone());
    }
    let config = b
        .printers
        .lock()
        .await
        .get(id)
        .map(|r| r.config.clone())
        .ok_or_else(|| RpcError::new("not_found", format!("no printer {id}")))?;
    let config = through_app(b, config).await?;
    let connector = b
        .connectors
        .iter()
        .find(|c| c.manifest().id == config.plugin)
        .ok_or_else(|| RpcError::new("not_found", "no plugin"))?;
    // The printer names a typed credential the store does not have: one the keychain kept only for an
    // earlier session, or one removed by hand. Nothing was refused, so the printer is not asked. (A
    // pairing printer has none until it pairs; that stays an auth error for the pairing flow.)
    if !connector.pairs()
        && let Some(r) = config.credential_ref.as_deref()
        && sx_connect::Secrets::get(b.secrets.as_ref(), r).is_none()
    {
        return Err(RpcError::new(
            "credential_missing",
            format!("no access code is stored for printer {id} on this computer; enter it again"),
        ));
    }
    match connector.connect(&config, b.secrets.as_ref()).await {
        Ok(s) => {
            let s: Arc<dyn PrinterSession> = Arc::from(s);
            b.sessions.lock().await.insert(id.to_owned(), s.clone());
            *last = None;
            Ok(s)
        }
        Err(e) => {
            let e = RpcError::from(e);
            *last = Some((Instant::now(), e.clone()));
            Err(e)
        }
    }
}

async fn call_tool(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let plugin = str_arg(p, "pluginId")?;
    let tool = str_arg(p, "tool")?;
    let input = p.get("input").cloned().unwrap_or_else(|| json!({}));
    let token: Option<ApprovalToken> = p
        .get("token")
        .filter(|t| !t.is_null())
        .map(|t| serde_json::from_value(t.clone()))
        .transpose()
        .map_err(|_| RpcError::new("bad_request", "token is malformed"))?;
    match plugin.as_str() {
        "spoolman" | "home-assistant" => {
            let (base, secret_ref) = {
                let svc = b.services.lock().await;
                let c = svc.get(&plugin).ok_or_else(|| {
                    RpcError::new(
                        "not_found",
                        format!("{plugin} is not configured; call services.configure"),
                    )
                })?;
                (c.base_url.clone(), c.secret_ref.clone())
            };
            let out = if plugin == "spoolman" {
                SpoolmanPlugin::new(&base, b.gate.clone())?
                    .call(&tool, input, token.as_ref())
                    .await
            } else {
                let secret = secret_ref
                    .as_deref()
                    .and_then(|r| sx_connect::Secrets::get(b.secrets.as_ref(), r))
                    .ok_or_else(|| RpcError::new("auth", "Home Assistant token is not set"))?;
                HomeAssistantPlugin::new(&base, secret, b.gate.clone())?
                    .call(&tool, input, token.as_ref())
                    .await
            };
            Ok(out?)
        }
        _ => {
            let name = tool.strip_prefix(&format!("{plugin}.")).unwrap_or(&tool);
            if name == "status" {
                let id = input
                    .get("printerId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| RpcError::new("bad_request", "printerId is required"))?;
                return to_json(&session(b, id).await?.status().await?);
            }
            Err(RpcError::new(
                "not_supported",
                format!("{plugin}.{name} goes through the printer methods"),
            ))
        }
    }
}

/// Finds printers on the network: every connector's own discovery (Bambu Lab SSDP announcements,
/// Elegoo's SDCP broadcast) plus an mDNS browse for the network printers that announce themselves. It
/// runs only when a paired client asks, which is the user pressing scan. Results on addresses that
/// are not on the local network are dropped.
async fn discover(b: &Bridge, p: &Value) -> Rpc<Value> {
    let ms = p
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(3000)
        .clamp(300, 10_000);
    let window = Duration::from_millis(ms);
    let by_connector = futures::future::join_all(b.connectors.iter().map(|c| c.discover(window)));
    let by_mdns = async {
        if b.mdns.disabled {
            return Vec::new();
        }
        let target = b
            .mdns
            .browse_target
            .unwrap_or_else(|| (sx_connect::mdns::MDNS_GROUP_V4, sx_connect::mdns::MDNS_PORT).into());
        sx_connect::mdns::browse_printers(target, window).await
    };
    let (lists, mdns) = tokio::join!(by_connector, by_mdns);
    let mut found: Vec<sx_connect::DiscoveredPrinter> = Vec::new();
    let experimental = b.hub.experimental();
    for d in lists.into_iter().flatten().chain(mdns) {
        if !is_lan_host(&d.host) || (!experimental && sx_connect::is_experimental(&d.plugin)) {
            continue;
        }
        // The same printer can be heard twice; a serial or an identical plugin, host and port is one printer.
        let dup = found.iter().any(|f| {
            f.plugin == d.plugin
                && f.host == d.host
                && (f.port == d.port || f.port.is_none() || d.port.is_none())
        });
        if !dup {
            found.push(d);
        }
    }
    found.sort_by(|a, c| (&a.plugin, &a.host).cmp(&(&c.plugin, &c.host)));
    b.remember_names(&found);
    Ok(json!({ "printers": found }))
}

/// Asks one address whether a printer is there, for "Enter IP instead" when a scan heard nothing.
/// Every connector that can ask a single address does (a Bambu Lab printer answers an SSDP search
/// sent to it with its model and serial number; an Elegoo SDCP printer answers `M99999` with its name,
/// model and firmware). Nothing signs in. The reply is `{"printers": [...]}`,
/// empty when nothing answered.
async fn probe(b: &Bridge, p: &Value) -> Rpc<Value> {
    let host = str_arg(p, "host")?;
    if host.parse::<std::net::IpAddr>().is_err() || !is_lan_host(&host) {
        return Err(RpcError::new(
            "bad_request",
            "enter an IP address on the local network",
        ));
    }
    let ms = p
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(1500)
        .clamp(200, 5000);
    let window = Duration::from_millis(ms);
    let experimental = b.hub.experimental();
    let found: Vec<sx_connect::DiscoveredPrinter> =
        futures::future::join_all(b.connectors.iter().map(|c| c.probe(&host, window)))
            .await
            .into_iter()
            .flatten()
            .filter(|d| experimental || !sx_connect::is_experimental(&d.plugin))
            .collect();
    Ok(json!({ "printers": found }))
}

/// Tries a printer without registering it: reach it, sign in, read its state, read its temperatures.
/// Nothing on the printer changes. The reply always succeeds as an RPC; `ok` and `cause` say what
/// happened, and `steps` show how far it got (`ok: null` means not reached). Causes are
/// `unreachable`, `auth`, `timeout`, `protocol`, `not_supported` and `bad_request`. A failure also
/// carries a stable `kind` for the words to show (`tls`, `auth`, `timeout` or `other`) and the raw
/// error in `details`, which is for copying into a report, not for the screen. A Bambu Lab printer's
/// reply adds `certificate`, whether Bambu Lab's CA issued its certificate for that serial; it is
/// recorded only and never refuses the printer. A refused sign-in whose printer said why adds
/// `authNeed` (`not_trusted`, `key_wrong` or `login_required`).
/// The four steps a printer test reports, each passed, failed or not reached (None).
fn test_steps(reach: Option<bool>, sign_in: Option<bool>, state: Option<bool>, temps: Option<bool>) -> Value {
    json!([
        { "id": "reach", "ok": reach },
        { "id": "sign_in", "ok": sign_in },
        { "id": "read_state", "ok": state },
        { "id": "read_temperatures", "ok": temps },
    ])
}

/// A printer test that reached the connector and failed: the steps that passed, the cause in the words older apps
/// know, the finer kind, and the printer's certificate when one was seen.
fn failed_test(rpc: &RpcError, certificate: Option<Value>) -> Value {
    let st = match rpc.code.as_str() {
        // A TLS failure means the printer answered but the secure connection did not come up.
        "unreachable" | "tls" | "timeout" => test_steps(Some(false), None, None, None),
        "auth" => test_steps(Some(true), Some(false), None, None),
        _ => test_steps(Some(true), Some(true), Some(false), None),
    };
    let cause = match rpc.code.as_str() {
        "unreachable" | "auth" | "not_supported" | "timeout" => rpc.code.clone(),
        "tls" => "unreachable".to_owned(),
        _ => "protocol".to_owned(),
    };
    let kind = match rpc.code.as_str() {
        "tls" | "auth" | "timeout" => rpc.code.clone(),
        _ => "other".to_owned(),
    };
    let mut out = json!({ "ok": false, "cause": cause, "kind": kind, "message": rpc.message, "details": rpc.message, "steps": st });
    if let (Some(c), Some(o)) = (certificate, out.as_object_mut()) {
        o.insert("certificate".into(), c);
    }
    out
}

async fn test_printer(b: &Bridge, p: &Value) -> Rpc<Value> {
    let config: PrinterConfig = arg(p, "config")?;
    let config = match through_app(b, config).await {
        Ok(c) => c,
        Err(e) => {
            return Ok(
                json!({ "ok": false, "cause": e.code, "kind": "other", "message": e.message, "details": e.message, "steps": test_steps(None, None, None, None) }),
            );
        }
    };
    let fail = |cause: &str, message: String, st: Value| {
        let kind = match cause {
            "auth" => "auth",
            "timeout" => "timeout",
            _ => "other",
        };
        Ok(
            json!({ "ok": false, "cause": cause, "kind": kind, "message": message, "details": message, "steps": st }),
        )
    };
    let certificate = || sx_connect::certificate_check(&config.host).map(|c| json!(c));
    if !is_lan_host(&config.host) {
        return fail(
            "bad_request",
            "printers must be on the local network".to_owned(),
            test_steps(None, None, None, None),
        );
    }
    let Some(connector) = b.connectors.iter().find(|c| c.manifest().id == config.plugin) else {
        return fail(
            "not_supported",
            format!("no plugin {}", config.plugin),
            test_steps(None, None, None, None),
        );
    };
    if sx_connect::is_experimental(&config.plugin) && !b.hub.experimental() {
        return fail(
            "not_supported",
            hub_rpc::experimental_refusal(&config.plugin).message,
            test_steps(None, None, None, None),
        );
    }
    let run = async {
        let session = connector.connect(&config, b.secrets.as_ref()).await?;
        let status = session.status().await?;
        // What the printer says about itself, so setup fills the form from it. Not reading it is
        // not a failed test.
        let hardware = session.hardware().await.ok().flatten();
        Ok::<_, ConnectError>((status, hardware))
    };
    match tokio::time::timeout(Duration::from_secs(15), run).await {
        Err(_) => fail(
            "timeout",
            "the printer did not answer in 15 seconds".to_owned(),
            test_steps(None, None, None, None),
        ),
        Ok(Err(e)) => {
            let need = e.login_need();
            let mut out = failed_test(&RpcError::from(e), certificate());
            if let (Some(n), Some(o)) = (need, out.as_object_mut()) {
                o.insert("authNeed".into(), json!(n));
            }
            Ok(out)
        }
        Ok(Ok((status, hardware))) => {
            let has_temps = !status.nozzles.is_empty() || status.bed.is_some();
            let mut out = serde_json::Map::new();
            out.insert("ok".into(), json!(true));
            out.insert("state".into(), json!(status.state));
            out.insert(
                "steps".into(),
                test_steps(Some(true), Some(true), Some(true), Some(has_temps)),
            );
            if let Some(n) = status.nozzles.first() {
                out.insert("nozzleC".into(), json!(n.current.round()));
            }
            if let Some(bed) = &status.bed {
                out.insert("bedC".into(), json!(bed.current.round()));
            }
            if let Some(h) = hardware.and_then(|h| serde_json::to_value(h).ok()) {
                out.insert("hardware".into(), h);
            }
            if let Some(c) = certificate() {
                out.insert("certificate".into(), c);
            }
            Ok(Value::Object(out))
        }
    }
}

/// A reader of the printer's camera: its own `cameraUrl` when the config has one, else the
/// connector's. Every reader of one printer shares one connection (`feeds.rs`): a running feed is
/// joined, else one is opened, one opener at a time. A still while the camera rests after its last
/// session gets that session's last key frame. A viewer whose camera dropped the connection gets a
/// feed that keeps trying; anything else that fails to open is the error. `purpose` says in the
/// connection log who asked (a probe, a live view, a still).
pub(crate) async fn camera_source(
    b: &Arc<Bridge>,
    id: &str,
    purpose: &str,
) -> Rpc<sx_connect::camera::FrameStream> {
    use futures::StreamExt;
    let shared = |s| {
        sx_connect::trace(
            id,
            format_args!("camera source for {purpose}: joined the open feed"),
        );
        Ok(s)
    };
    // A still lets go at its first key frame and keeps no feed open after it; anything else does.
    let viewer = purpose != "still";
    if let Some(s) = b.feeds.subscribe(id, viewer) {
        return shared(s);
    }
    let opener = b.feeds.opener(id);
    let _one_at_a_time = opener.lock().await;
    if let Some(s) = b.feeds.subscribe(id, viewer) {
        return shared(s);
    }
    if !viewer && let Some(rest) = b.feeds.resting(id) {
        match rest {
            crate::feeds::Rest::Frame(f) => {
                sx_connect::trace(
                    id,
                    "camera source for still: the camera rests after its last session; its last key frame",
                );
                return Ok(futures::stream::iter([f]).boxed());
            }
            // No frame to reuse: wait the rest out rather than start a PLAY the camera drops.
            crate::feeds::Rest::Wait(left) => {
                sx_connect::trace(
                    id,
                    format_args!(
                        "camera source for still: the camera rests after its last session; waiting {} ms",
                        left.as_millis()
                    ),
                );
                tokio::time::sleep(left).await;
            }
        }
    }
    if !viewer {
        if let Some((f, ago)) = b.feeds.paced_still(id) {
            sx_connect::trace(
                id,
                format_args!(
                    "camera source for still: a still opened a session {} s ago; the last key frame",
                    ago.as_secs()
                ),
            );
            return Ok(futures::stream::iter([f]).boxed());
        }
        b.feeds.still_opening(id);
    }
    let got = open_camera_source(b, id).await;
    match &got {
        Ok(_) => sx_connect::trace(id, format_args!("camera source for {purpose}: open")),
        Err(e) => sx_connect::trace(
            id,
            format_args!("camera source for {purpose}: {} ({})", e.message, e.code),
        ),
    }
    if let Err(e) = &got
        && !(viewer && crate::feeds::retryable(e))
    {
        return Err(e.clone());
    }
    let reopen: crate::feeds::Opener = {
        let (b, id) = (b.clone(), id.to_owned());
        Arc::new(move || {
            let (b, id) = (b.clone(), id.clone());
            Box::pin(async move { open_camera_source(&b, &id).await })
        })
    };
    Ok(b.feeds.start(id, got, viewer, reopen))
}

async fn open_camera_source(b: &Arc<Bridge>, id: &str) -> Rpc<sx_connect::camera::FrameStream> {
    let config = b
        .printers
        .lock()
        .await
        .get(id)
        .map(|r| r.config.clone())
        .ok_or_else(|| RpcError::new("not_found", format!("no printer {id}")))?;
    let open = async {
        if config.camera_url.is_some() {
            Ok(sx_connect::camera::open_url(&config, b.secrets_ref()).await)
        } else {
            session(b, id).await?.stream().await.map_err(RpcError::from)
        }
    };
    let got = match tokio::time::timeout(Duration::from_secs(10), open).await {
        Ok(Ok(Some(s))) => Ok(s),
        Ok(Ok(None)) => Err(RpcError::new(
            "not_supported",
            "This printer has no camera stream.",
        )),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(RpcError::new(
            "unreachable",
            "The camera did not answer in 10 seconds.",
        )),
    };
    // A camera that dropped the new session (the H2D does now and then) counts as refused.
    let refused = got.as_ref().is_err_and(|e| e.code == "timeout");
    if got.is_ok() || refused {
        let tally = b.feeds.count_open(id, refused);
        sx_connect::trace(
            id,
            format_args!(
                "camera session {}: {tally}",
                if refused { "refused" } else { "opened" }
            ),
        );
    }
    got
}

/// Starts a live camera stream. Frames arrive as binary messages (see `camera.rs`), stats and the end
/// of the stream as `camera.stats` and `camera.ended` events. `quality` is `low`, `medium`, `high` or
/// `auto` (start high and step down when the client falls behind).
async fn camera_open(
    b: &Arc<Bridge>,
    conn: &mut Conn,
    tx: &mpsc::UnboundedSender<Message>,
    p: &Value,
) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    let quality = match p.get("quality").and_then(Value::as_str) {
        None => camera::HIGH,
        Some(q) => camera::parse_quality(q)
            .ok_or_else(|| RpcError::new("bad_request", "quality is low, medium, high or auto"))?,
    };
    if conn.streams.len() >= camera::MAX_STREAMS {
        return Err(RpcError::new("bad_request", "too many camera streams open"));
    }
    let src = camera_source(b, &printer, "live view").await?;
    let id = conn.next_stream;
    conn.next_stream += 1;
    let ctl = Arc::new(camera::Control {
        quality: AtomicU8::new(quality),
        ceiling: AtomicU8::new(quality),
        // `jpegOnly`: the client (a phone, through the app) cannot decode H.264.
        jpeg_only: p.get("jpegOnly").and_then(Value::as_bool) == Some(true),
        codecs: crate::h264::codec_dir(b.hub.dir.as_ref().map(crate::hub::StateDir::path)),
    });
    sx_connect::trace(
        &printer,
        format_args!("live view {id} opened ({})", camera::quality_name(quality)),
    );
    let status = b.feeds.status(&printer);
    let task = tokio::spawn(camera::run(
        id,
        printer.clone(),
        status,
        src,
        tx.clone(),
        conn.queued.clone(),
        ctl.clone(),
    ));
    conn.streams.insert(id, (task, ctl, printer));
    Ok(json!({ "stream": id, "quality": camera::quality_name(quality), "route": "lan" }))
}

/// Looks at the camera before a stream starts: how fast the first frame comes and how many frames a
/// second the printer gives. `recommended` is a starting quality for the player.
async fn camera_probe(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    use sx_connect::camera::FrameKind;
    let printer = str_arg(p, "printerId")?;
    let window = Duration::from_millis(
        p.get("windowMs")
            .and_then(Value::as_u64)
            .unwrap_or(2000)
            .clamp(500, 5000),
    );
    let started = Instant::now();
    let mut src = camera_source(b, &printer, "probe").await?;
    let (mut frames, mut bytes, mut first_ms, mut kind) = (0_u32, 0_usize, None, None);
    let (mut first_at, mut last_at) = (None::<Instant>, None::<Instant>);
    let end = tokio::time::Instant::now() + window;
    while let Ok(Some(f)) = tokio::time::timeout_at(end, src.next()).await {
        first_ms.get_or_insert_with(|| u64::try_from(started.elapsed().as_millis()).unwrap_or(0));
        kind = Some(f.kind);
        first_at.get_or_insert_with(Instant::now);
        last_at = Some(Instant::now());
        frames += 1;
        bytes += f.data.len();
        if frames >= 60 {
            break;
        }
    }
    // The rate is measured from the first frame to the last, so connecting does not count against it.
    let secs = match (first_at, last_at) {
        (Some(a), Some(z)) => z.duration_since(a).as_secs_f64().max(0.001),
        _ => 0.001,
    };
    let measured = if frames > 1 {
        f64::from(frames - 1) / secs
    } else {
        0.0
    };
    // A probe that joined a running feed got its replay first; the feed's own rate and whether a
    // frame came lately say whether it is alive. The cached key frame alone is not a live feed.
    let health = b.feeds.health(&printer);
    let fps = health.map_or(measured, |(rate, _)| rate);
    let ok = frames > 0 && health.is_none_or(|(_, fresh)| fresh);
    let recommended = if frames == 0 {
        "low"
    } else if fps >= 8.0 && first_ms.unwrap_or(u64::MAX) < 1500 {
        "high"
    } else if fps >= 2.0 {
        "medium"
    } else {
        "low"
    };
    sx_connect::trace(
        &printer,
        format_args!(
            "camera probe: {frames} frames, {fps:.1} fps{}, first after {first_ms:?} ms{}",
            if health.is_some() {
                " (the open feed's rate)"
            } else {
                ""
            },
            if ok { "" } else { ", not healthy" }
        ),
    );
    Ok(json!({
        "ok": ok,
        "kind": kind.map(|k| if k == FrameKind::Jpeg { "jpeg" } else { "h264" }),
        "firstFrameMs": first_ms,
        "fps": (fps * 10.0).round() / 10.0,
        "kbps": (f64::from(u32::try_from(bytes).unwrap_or(u32::MAX)) * 8.0 / 1000.0 / secs).round(),
        "recommended": recommended,
    }))
}

/// Finds ONVIF cameras with a WS-Discovery probe. A user started action, like `discover`. Cameras off
/// the local network are dropped. `cameraUrl` is what to put in a printer's config to use the camera.
async fn discover_cameras(b: &Bridge, p: &Value) -> Rpc<Value> {
    let ms = p
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(3000)
        .clamp(300, 10_000);
    let cams = if b.mdns.disabled {
        Vec::new()
    } else {
        let target = b.mdns.onvif_target.unwrap_or_else(|| {
            (
                sx_connect::onvif::DISCOVERY_GROUP,
                sx_connect::onvif::DISCOVERY_PORT,
            )
                .into()
        });
        sx_connect::onvif::discover(target, Duration::from_millis(ms)).await
    };
    let list: Vec<Value> = cams
        .into_iter()
        .filter(|c| is_lan_host(&c.host))
        .map(|c| {
            let host = if c.host.contains(':') {
                format!("[{}]", c.host)
            } else {
                c.host.clone()
            };
            json!({
                "host": c.host, "port": c.port, "name": c.name, "hardware": c.hardware,
                "cameraUrl": format!("onvif://{host}:{}", c.port),
            })
        })
        .map(strip_nulls)
        .collect();
    Ok(json!({ "cameras": list }))
}
