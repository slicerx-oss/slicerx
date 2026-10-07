// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The connection to sx-link with the `watch` role. The hub proves its key first (`hello`, an
//! Ed25519 signature over both nonces and the port); then both run the code exchange (`CPace`,
//! `sx_cpace::pair`) bound to that hello, so the watch code never crosses the socket and nothing
//! sent can be tested offline. After pairing: the bed masks, a frame
//! subscription, `watch.report` for each finding, `watch.grab` for a second look at a possible
//! hand, `watch.plateResult` for each plate check and `watch.lookResult` for each look again. Protocol: packages/connect/link-client.
use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use crate::confirm::Confirmation;
use crate::detector::Detector;
use crate::mask::Mask;
use crate::protocol::{Kind, Report};
use crate::session::{Out, Session};

const HELLO_CONTEXT: &[u8] = b"sx-link hello v2\n";
/// How often the bed masks are read again, in case the person redrew one.
const MASK_REFRESH: Duration = Duration::from_secs(300);
/// One frame per printer this often.
pub const FRAME_EVERY_MS: u64 = 10_000;
/// The confidence an unconfirmed report is held under. sx-link auto-pauses at 0.8; until it
/// also requires `confirmed`, keeping unconfirmed reports below that is what makes sure a
/// local false alarm never pauses a print by itself.
pub const UNCONFIRMED_CAP: f64 = 0.79;
/// How long huginn gets to answer before the report goes out unconfirmed.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);

/// Why the connection ended or never started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    /// Could not connect, or the connection dropped.
    Connection(String),
    /// The program on the port did not prove it is the hub (or not the pinned one). Nothing was sent.
    HubIdentity(String),
    /// The hub refused a call.
    Refused {
        method: String,
        code: String,
        message: String,
    },
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Connection(m) => write!(f, "connection: {m}"),
            ClientError::HubIdentity(m) => write!(f, "hub identity: {m}"),
            ClientError::Refused {
                method,
                code,
                message,
            } => write!(f, "{method} refused ({code}): {message}"),
        }
    }
}

/// How to reach the hub.
#[derive(Debug, Clone)]
pub struct Options {
    /// `ws://127.0.0.1:47615` by default.
    pub url: String,
    /// The hub's watch code (`sx-link code --watch`).
    pub code: String,
    /// The hub's public key (`hub-key.pub`), base64. When set, any other key is refused.
    pub hub_key: Option<String>,
}

/// Checks the hub's signature over the hello transcript.
pub fn hello_ok(hub_key: &[u8], client_nonce: &[u8], hub_nonce: &[u8], port: u16, sig: &[u8]) -> bool {
    let msg = [HELLO_CONTEXT, client_nonce, hub_nonce, &port.to_be_bytes()].concat();
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, hub_key)
        .verify(&msg, sig)
        .is_ok()
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Conn {
    ws: Socket,
    next_id: u64,
    /// Events that arrived while waiting for a reply.
    backlog: Vec<Value>,
}

impl Conn {
    async fn send(&mut self, method: &str, params: Value) -> Result<u64, ClientError> {
        self.next_id += 1;
        let id = self.next_id;
        let text = json!({ "id": id, "method": method, "params": params }).to_string();
        self.ws
            .send(Message::text(text))
            .await
            .map_err(|e| ClientError::Connection(e.to_string()))?;
        Ok(id)
    }

    async fn recv(&mut self) -> Result<Value, ClientError> {
        loop {
            match self.ws.next().await {
                Some(Ok(Message::Text(t))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        return Ok(v);
                    }
                }
                Some(Ok(Message::Close(_))) | None => {
                    return Err(ClientError::Connection("the hub closed the connection".into()));
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(ClientError::Connection(e.to_string())),
            }
        }
    }

    /// Sends a call and waits for its reply; events in between are kept for later.
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, ClientError> {
        let id = self.send(method, params).await?;
        loop {
            let msg = self.recv().await?;
            if msg.get("id").and_then(Value::as_u64) != Some(id) {
                if msg.get("event").is_some() {
                    self.backlog.push(msg);
                }
                continue;
            }
            if let Some(e) = msg.get("error") {
                return Err(ClientError::Refused {
                    method: method.to_owned(),
                    code: e
                        .get("code")
                        .and_then(Value::as_str)
                        .unwrap_or("error")
                        .to_owned(),
                    message: e
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                });
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

fn port_of(url: &str) -> u16 {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split('/').next().unwrap_or(rest);
    host.rsplit_once(':')
        .and_then(|(_, p)| p.parse().ok())
        .unwrap_or(if url.starts_with("wss:") { 443 } else { 80 })
}

/// Connects, proves both sides, pairs as `watch`. Nothing secret leaves before the hub's key
/// checks out.
async fn open(opts: &Options) -> Result<Conn, ClientError> {
    let (ws, _) = tokio_tungstenite::connect_async(opts.url.as_str())
        .await
        .map_err(|e| ClientError::Connection(e.to_string()))?;
    let mut conn = Conn {
        ws,
        next_id: 0,
        backlog: Vec::new(),
    };
    let mut client_nonce = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut client_nonce)
        .map_err(|_| ClientError::Connection("no random source".into()))?;
    let hello = conn
        .call("hello", json!({ "nonce": B64.encode(client_nonce) }))
        .await
        .map_err(|e| {
            ClientError::HubIdentity(format!(
                "the program on this port did not prove it is your hub ({e})"
            ))
        })?;
    let field = |k: &str| {
        hello
            .get(k)
            .and_then(Value::as_str)
            .and_then(|s| B64.decode(s).ok())
    };
    let (Some(key), Some(hub_nonce), Some(sig)) = (field("hubKey"), field("hubNonce"), field("sig")) else {
        return Err(ClientError::HubIdentity("the hub's hello is incomplete".into()));
    };
    let key_b64 = B64.encode(&key);
    if opts.hub_key.as_deref().is_some_and(|pinned| pinned != key_b64) {
        return Err(ClientError::HubIdentity(
            "this is not the SlicerX hub you paired with".into(),
        ));
    }
    let port = hello
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok());
    if port != Some(port_of(&opts.url)) || !hello_ok(&key, &client_nonce, &hub_nonce, port.unwrap_or(0), &sig)
    {
        return Err(ClientError::HubIdentity(
            "the hub's signature did not verify for this connection".into(),
        ));
    }
    let ctx = sx_cpace::pair::Context {
        hub_key: &key,
        port: port.unwrap_or(0),
        client_nonce: &client_nonce,
        hub_nonce: &hub_nonce,
    };
    let mut y = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut y)
        .map_err(|_| ClientError::Connection("no random source".into()))?;
    let mut start = sx_cpace::pair::Start::new(&opts.code, &ctx, y);
    let answer = conn.call("pair", json!({ "pake": B64.encode(start.ya) })).await?;
    let messages: Vec<(&str, Vec<u8>)> = sx_cpace::pair::ROLES
        .iter()
        .filter_map(|role| Some((*role, B64.decode(answer.get("pake")?.get(*role)?.as_str()?).ok()?)))
        .collect();
    let tags: serde_json::Map<String, Value> = start
        .respond(&messages)
        .ok_or_else(|| {
            ClientError::HubIdentity("the hub's code exchange is incomplete; update sx-link".into())
        })?
        .into_iter()
        .map(|(role, t)| (role.to_owned(), json!(B64.encode(t))))
        .collect();
    let paired = conn
        .call("pair", json!({ "confirm": tags, "role": "watch" }))
        .await?;
    // The hub proves it holds the same code; something else on the port cannot.
    let confirmed = paired
        .get("confirm")
        .and_then(Value::as_str)
        .and_then(|t| B64.decode(t).ok())
        .is_some_and(|t| start.hub_confirmed(&t));
    if !confirmed {
        return Err(ClientError::HubIdentity(
            "the hub did not prove it holds the watch code".into(),
        ));
    }
    Ok(conn)
}

fn masks_from(v: &Value) -> HashMap<String, Mask> {
    serde_json::from_value::<HashMap<String, Vec<[f64; 2]>>>(v.clone())
        .map(|m| m.into_iter().map(|(k, pts)| (k, Mask::new(pts))).collect())
        .unwrap_or_default()
}

/// Asks for confirmation when the printer has it on, then holds an unconfirmed report under
/// the hub's pause level. A hand goes out as it is: the hub pauses on it without confirmation.
async fn finish<D: Detector>(session: &Session<D>, confirm: Option<&Confirmation>, mut r: Report) -> Report {
    if r.kind == Kind::Hand {
        return r;
    }
    if let Some(c) = confirm.filter(|c| c.printers.contains(&r.printer_id))
        && let Some((content_type, bytes)) = session.latest_frame(&r.printer_id)
    {
        let name = c.by.name();
        let answer = tokio::time::timeout(CONFIRM_TIMEOUT, c.by.confirm(content_type, bytes)).await;
        let note = match answer {
            Ok(Ok(true)) => format!("{name} agreed"),
            Ok(Ok(false)) => format!("not confirmed by {name}"),
            Ok(Err(_)) | Err(_) => format!("{name} could not be asked"),
        };
        r.confirmed = answer.ok().and_then(Result::ok);
        r.note = format!("{}, {note}", r.note);
    }
    if r.confirmed != Some(true) {
        r.confidence = r.confidence.min(UNCONFIRMED_CAP);
    }
    r
}

/// Runs the watch until the connection ends, without confirmation: findings notify only.
pub async fn run<D: Detector>(opts: &Options, session: &mut Session<D>) -> Result<(), ClientError> {
    run_with(opts, session, None).await
}

/// Runs the watch until the connection ends. Reports go out as the session decides, each
/// confirmed first when its printer has confirmation on.
pub async fn run_with<D: Detector>(
    opts: &Options,
    session: &mut Session<D>,
    confirm: Option<&Confirmation>,
) -> Result<(), ClientError> {
    let mut conn = open(opts).await?;
    for (printer, mask) in masks_from(&conn.call("watch.masks", json!({})).await?) {
        session.set_mask(&printer, mask);
    }
    conn.call("watch.subscribe", json!({ "everyMs": FRAME_EVERY_MS }))
        .await?;
    let mut masks_call: Option<u64> = None;
    let mut refresh = tokio::time::interval(MASK_REFRESH);
    refresh.tick().await;
    // Second looks in flight: call id to printer.
    let mut grabs: HashMap<u64, String> = HashMap::new();
    let backlog = std::mem::take(&mut conn.backlog);
    for ev in backlog {
        let calls = session.on_event(&ev);
        dispatch(&mut conn, session, confirm, calls, &mut grabs).await?;
    }
    loop {
        tokio::select! {
            _ = refresh.tick() => {
                masks_call = Some(conn.send("watch.masks", json!({})).await?);
            }
            msg = conn.recv() => {
                let msg = msg?;
                if masks_call.is_some() && msg.get("id").and_then(Value::as_u64) == masks_call {
                    if let Some(r) = msg.get("result") {
                        for (printer, mask) in masks_from(r) {
                            session.set_mask(&printer, mask);
                        }
                    }
                    masks_call = None;
                    continue;
                }
                // A second look came back: it is a frame like any other.
                let id = msg.get("id").and_then(Value::as_u64);
                if let Some(printer) = id.and_then(|i| grabs.remove(&i)) {
                    let Some(mut data) = msg.get("result").filter(|r| r.is_object()).cloned() else {
                        continue;
                    };
                    if let Some(o) = data.as_object_mut() {
                        o.insert("printerId".into(), json!(printer));
                    }
                    let calls = session.on_event(&json!({ "event": "watch.frame", "data": data }));
                    dispatch(&mut conn, session, confirm, calls, &mut grabs).await?;
                    continue;
                }
                let calls = session.on_event(&msg);
                dispatch(&mut conn, session, confirm, calls, &mut grabs).await?;
            }
        }
    }
}

/// Makes the calls the session asked for.
async fn dispatch<D: Detector>(
    conn: &mut Conn,
    session: &Session<D>,
    confirm: Option<&Confirmation>,
    calls: Vec<Out>,
    grabs: &mut HashMap<u64, String>,
) -> Result<(), ClientError> {
    for out in calls {
        match out {
            Out::Report(r) => {
                let r = finish(session, confirm, r).await;
                conn.send("watch.report", serde_json::to_value(&r).unwrap_or_default())
                    .await?;
            }
            Out::Grab(printer) => {
                let id = conn.send("watch.grab", json!({ "printerId": printer })).await?;
                grabs.insert(id, printer);
            }
            Out::Plate(p) => {
                conn.send("watch.plateResult", serde_json::to_value(&p).unwrap_or_default())
                    .await?;
            }
            Out::Look(l) => {
                conn.send("watch.lookResult", serde_json::to_value(&l).unwrap_or_default())
                    .await?;
            }
        }
    }
    Ok(())
}

/// Saves one still per printing printer every `every_ms` into `dir/<printer>/`, with a line of
/// metadata per frame in `dir/frames.jsonl`. For building a local evaluation set of normal
/// prints; frames stay in `dir` and nothing is reported or sent anywhere.
pub async fn collect(opts: &Options, dir: &std::path::Path, every_ms: u64) -> Result<(), ClientError> {
    use std::io::Write as _;
    let mut conn = open(opts).await?;
    conn.call("watch.subscribe", json!({ "everyMs": every_ms }))
        .await?;
    let io = |e: std::io::Error| ClientError::Connection(format!("saving a frame failed: {e}"));
    std::fs::create_dir_all(dir).map_err(io)?;
    // Oldest first: events that arrived during the subscribe call, then the live stream.
    let mut pending = std::mem::take(&mut conn.backlog);
    pending.reverse();
    loop {
        let msg = match pending.pop() {
            Some(m) => m,
            None => conn.recv().await?,
        };
        if msg.get("event").and_then(Value::as_str) != Some("watch.frame") {
            continue;
        }
        let Ok(f) =
            serde_json::from_value::<crate::protocol::Frame>(msg.get("data").cloned().unwrap_or(Value::Null))
        else {
            continue;
        };
        let ext = match f.content_type.as_str() {
            "image/png" => "png",
            "image/webp" => "webp",
            _ => "jpg",
        };
        let Ok(bytes) = B64.decode(&f.data_base64) else {
            continue;
        };
        let safe = |s: &str| {
            s.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
        };
        let sub = dir.join(safe(&f.printer_id));
        std::fs::create_dir_all(&sub).map_err(io)?;
        let name = format!("{}.{ext}", safe(&f.captured_at));
        std::fs::write(sub.join(&name), &bytes).map_err(io)?;
        let line = json!({ "file": format!("{}/{name}", safe(&f.printer_id)), "printerId": f.printer_id, "capturedAt": f.captured_at, "state": f.state, "layer": f.layer, "layerCount": f.layer_count, "label": "normal" });
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("frames.jsonl"))
            .map_err(io)?;
        writeln!(log, "{line}").map_err(io)?;
    }
}
