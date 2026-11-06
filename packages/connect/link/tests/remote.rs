// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Remote access end to end: the hub on a local sx-relay, a device that opens a pair session to
//! it over the relay, and the remote method subset.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::too_many_lines,
    clippy::indexing_slicing,
    clippy::many_single_char_names,
    clippy::format_collect,
    clippy::needless_pass_by_value,
    clippy::cast_possible_truncation
)]

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sx_connect::MemorySecrets;
use sx_link::pair_session::{self as ps, Channel, Opening, SessionFrame};
use sx_link::{BrokerGate, Link, LinkConfig, serve_with_approvals};
use sx_permit::ApprovalBroker;
use sx_relay::{RelayConfig, RelayHandle};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const CODE: &str = "TEST-CODE";
const AGENT_CODE: &str = "AGNT-CODE";
const WATCH_CODE: &str = "WTCH-CODE";

const RELAY_SECRET: &[u8] = b"remote test relay secret";

async fn relay() -> RelayHandle {
    relay_with(sx_relay::quota::PartnerLimits::default()).await
}

async fn relay_with(partner: sx_relay::quota::PartnerLimits) -> RelayHandle {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    // The hub and the test devices share one address here; the mock printer polls every 50 ms.
    let roomy = sx_relay::quota::TierLimits {
        frames_per_second: 1000,
        bytes_per_minute: 1 << 30,
        ..sx_relay::quota::Limits::default().anonymous
    };
    let limits = sx_relay::quota::Limits {
        anonymous: roomy,
        partner,
        ..sx_relay::quota::Limits::default()
    };
    sx_relay::spawn(
        listener,
        RelayConfig {
            limits,
            verifier: Some(sx_relay::auth::Verifier::hs256(RELAY_SECRET)),
            ..RelayConfig::default()
        },
    )
    .unwrap()
}

async fn hub_in(state_dir: Option<std::path::PathBuf>) -> Link {
    let broker = Arc::new(ApprovalBroker::new().unwrap());
    let cfg = LinkConfig {
        port: 0,
        fixed_code: Some(CODE.to_owned()),
        fixed_agent_code: Some(AGENT_CODE.to_owned()),
        fixed_watch_code: Some(WATCH_CODE.to_owned()),
        state_dir,
        // Direct video on loopback: the test machine's firewall may hold back UDP to unsigned test
        // binaries.
        ..LinkConfig::loopback()
    };
    serve_with_approvals(
        cfg,
        Arc::new(BrokerGate(broker.clone())),
        Arc::new(MemorySecrets::new()),
        Some(broker),
    )
    .await
    .unwrap()
}

async fn call(ws: &mut Ws, id: u64, method: &str, params: Value) -> Value {
    ws.send(Message::text(
        json!({ "id": id, "method": method, "params": params }).to_string(),
    ))
    .await
    .unwrap();
    loop {
        let m = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("reply in time");
        let Some(Ok(m)) = m else {
            return json!({ "closed": true });
        };
        if let Message::Text(t) = m {
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if v["id"] == id {
                return v;
            }
        }
    }
}

async fn paired(link: &Link, code: &str) -> Ws {
    let mut ws = connect_async(format!("ws://127.0.0.1:{}/", link.addr().port()))
        .await
        .unwrap()
        .0;
    let pp = pairing::proof_params(&mut ws, code, json!({})).await;
    let r = call(&mut ws, 1, "pair", pp).await;
    assert_eq!(r["result"]["paired"], true, "{r}");
    ws
}

fn identity(seed: u8, name: &str) -> Value {
    json!({
        "deviceId": ps::b64(&[seed; 16]),
        "name": name,
        "platform": "ios",
        "signPub": ps::b64(&[seed; 32]),
        "dhPub": ps::b64(&ps::dh_public(&[seed.wrapping_add(1); 32])),
    })
}

/// The static secret behind `identity(1, ..)`, the host's.
const HOST_DH: [u8; 32] = [2; 32];

/// A paired device reaching the hub through the relay, as a phone does.
struct Device {
    ws: Ws,
    channel: Channel,
    host_route: String,
    next: u64,
    events: Vec<Value>,
    /// The init frame this session opened with, for replay tests.
    init: String,
}

impl Device {
    async fn open(relay: &RelayHandle, key: &[u8; 32]) -> Option<Self> {
        let mut ws = connect_async(format!("ws://{}/v1", relay.addr)).await.unwrap().0;
        let (host_route, mine) = ps::pairing_routes(key);
        ws.send(Message::text(json!({ "op": "sub", "route": mine }).to_string()))
            .await
            .unwrap();
        let sid: [u8; 16] = rand_bytes();
        let opening = Opening::new(
            &rand_bytes(),
            &sid,
            &rand_bytes(),
            None,
            key,
            &ps::dh_public(&HOST_DH),
        );
        let init = serde_json::to_string(&opening.init).unwrap();
        let init_copy = init.clone();
        ws.send(Message::text(
            json!({ "op": "send", "to": host_route, "body": init }).to_string(),
        ))
        .await
        .unwrap();
        let accept = loop {
            let body = next_body(&mut ws).await?;
            if let Some(SessionFrame::Accept(a)) = ps::parse_frame(&body) {
                break a;
            }
        };
        let channel = opening.finish(&accept).ok()?;
        Some(Self {
            ws,
            channel,
            host_route,
            next: 1,
            events: Vec::new(),
            init: init_copy,
        })
    }

    /// Sends a request without waiting for its reply.
    async fn fire(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next;
        self.next += 1;
        let f = self
            .channel
            .seal_text(&json!({ "t": "req", "id": id, "m": method, "p": params }).to_string())
            .unwrap();
        self.ws
            .send(Message::text(
                json!({ "op": "send", "to": self.host_route, "body": f }).to_string(),
            ))
            .await
            .unwrap();
        id
    }

    /// Replies to `ids`, in any order.
    async fn replies(&mut self, ids: &[u64]) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::new();
        while out.len() < ids.len() {
            let body = next_body(&mut self.ws).await.expect("a reply");
            if let Some(SessionFrame::Data(d)) = ps::parse_frame(&body)
                && let Some(plain) = self.channel.open(&d)
            {
                let v: Value = serde_json::from_slice(&plain).unwrap();
                if v["t"] == "res" && v["id"].as_u64().is_some_and(|i| ids.contains(&i)) {
                    out.push(v);
                } else if v["t"] == "ev" {
                    self.events.push(v);
                }
            }
        }
        out
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.fire(method, params).await;
        loop {
            let body = next_body(&mut self.ws).await.expect("a reply");
            if let Some(SessionFrame::Data(d)) = ps::parse_frame(&body)
                && let Some(plain) = self.channel.open(&d)
            {
                let v: Value = serde_json::from_slice(&plain).unwrap();
                if v["t"] == "res" && v["id"] == id {
                    return v;
                }
                if v["t"] == "ev" {
                    self.events.push(v);
                }
            }
        }
    }

    /// Waits for an event named `ev` whose data passes `pred`, and takes it.
    async fn event(&mut self, ev: &str, pred: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..200 {
            if let Some(i) = self.events.iter().position(|e| e["ev"] == ev && pred(&e["d"])) {
                return self.events.remove(i)["d"].clone();
            }
            let Some(body) = next_body(&mut self.ws).await else {
                break;
            };
            if let Some(SessionFrame::Data(d)) = ps::parse_frame(&body)
                && let Some(plain) = self.channel.open(&d)
            {
                let v: Value = serde_json::from_slice(&plain).unwrap();
                if v["t"] == "ev" {
                    self.events.push(v);
                }
            }
        }
        panic!("no {ev} event; saw {:?}", self.events);
    }
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).unwrap();
    b
}

async fn next_body(ws: &mut Ws) -> Option<String> {
    loop {
        match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: Value = serde_json::from_str(t.as_str()).ok()?;
                if v["op"] == "msg" {
                    return v["body"].as_str().map(str::to_owned);
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return None,
        }
    }
}

async fn app_event(ws: &mut Ws, name: &str, pred: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..200 {
        let Ok(Some(Ok(Message::Text(t)))) =
            tokio::time::timeout(Duration::from_millis(100), ws.next()).await
        else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["event"] == name && pred(&v["data"]) {
            return v["data"].clone();
        }
    }
    panic!("no matching {name} event");
}

async fn wait_connected(app: &mut Ws) -> Value {
    for i in 0..100 {
        let s = call(app, 900 + i, "remote.status", json!({})).await;
        if s["result"]["connected"] == true {
            return s["result"].clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the hub never reached the relay");
}

struct Setup {
    relay: RelayHandle,
    link: Link,
    app: Ws,
    agent: Ws,
    host: Value,
}

async fn setup() -> Setup {
    setup_in(None).await
}

async fn setup_in(state_dir: Option<std::path::PathBuf>) -> Setup {
    setup_on(relay().await, state_dir).await
}

async fn setup_on(relay: RelayHandle, state_dir: Option<std::path::PathBuf>) -> Setup {
    let link = hub_in(state_dir).await;
    let mut app = paired(&link, CODE).await;
    let agent = paired(&link, AGENT_CODE).await;
    let host = identity(1, "Studio Mac");
    let url = format!("ws://{}/v1", relay.addr);
    let r = call(
        &mut app,
        2,
        "remote.configure",
        json!({ "enabled": true, "relay": url, "host": host, "hostDh": ps::b64(&HOST_DH) }),
    )
    .await;
    assert_eq!(r["result"]["enabled"], true, "{r}");
    wait_connected(&mut app).await;
    Setup {
        relay,
        link,
        app,
        agent,
        host,
    }
}

async fn put(app: &mut Ws, key: &[u8; 32], kind: &str, seed: u8) -> String {
    put_peer(app, key, kind, seed, identity(seed, "Pocket")).await
}

async fn put_peer(app: &mut Ws, key: &[u8; 32], kind: &str, seed: u8, peer: Value) -> String {
    let pairing_id = ps::b64(&[seed; 16]);
    let r = call(
        app,
        3,
        "remote.pairings.put",
        json!({ "pairingId": pairing_id, "deviceKey": ps::b64(key), "kind": kind, "peer": peer, "rights": { "request": true, "approve": true } }),
    )
    .await;
    assert_eq!(r["result"]["saved"], true, "{r}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    pairing_id
}

#[tokio::test]
async fn a_paired_phone_reaches_the_hub_through_the_relay() {
    let mut s = setup().await;
    let key: [u8; 32] = rand_bytes();
    let pairing_id = put(&mut s.app, &key, "phone", 7).await;

    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    // Settings reads the relay's numbers from the hub.
    let st = call(&mut s.app, 30, "remote.status", json!({})).await;
    assert_eq!(st["result"]["quota"]["tier"], "anonymous", "{st}");
    assert_eq!(st["result"]["quota"]["cap"], 1_000_000_000_u64, "{st}");
    let info = phone.call("host.info", json!({})).await;
    assert_eq!(info["ok"], true, "{info}");
    assert_eq!(info["r"]["identity"], s.host);
    assert_eq!(info["r"]["rights"]["approve"], true);
    let other = phone.call("print.local", json!({})).await;
    assert_eq!(other["e"]["code"], "not_supported", "{other}");

    // A wrong key gets no session.
    assert!(Device::open(&s.relay, &rand_bytes()).await.is_none());

    // Removing the pairing ends it: no answer to a new init.
    let r = call(
        &mut s.app,
        4,
        "remote.pairings.remove",
        json!({ "pairingId": pairing_id }),
    )
    .await;
    assert_eq!(r["result"]["removed"], true, "{r}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(Device::open(&s.relay, &key).await.is_none());
}

#[tokio::test]
async fn agents_never_get_the_approve_right_or_the_remote_settings() {
    let mut s = setup().await;
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, "agent", 9).await;
    let mut agent = Device::open(&s.relay, &key).await.expect("a session");
    let info = agent.call("host.info", json!({})).await;
    assert_eq!(info["r"]["rights"]["approve"], false, "{info}");
    let r = call(&mut s.agent, 5, "remote.configure", json!({ "enabled": false })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let r = call(&mut s.agent, 6, "remote.pairings.list", json!({})).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let r = call(
        &mut s.app,
        7,
        "remote.configure",
        json!({ "enabled": true, "relay": "ws://relay.example/v1" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
}

#[tokio::test]
async fn l2_an_old_phone_hears_update_and_the_host_key_must_match() {
    let mut s = setup().await;
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, "phone", 3).await;
    let mut ws = connect_async(format!("ws://{}/v1", s.relay.addr))
        .await
        .unwrap()
        .0;
    let (host_route, mine) = ps::pairing_routes(&key);
    ws.send(Message::text(json!({ "op": "sub", "route": mine }).to_string()))
        .await
        .unwrap();
    let opening = Opening::new(
        &rand_bytes(),
        &rand_bytes(),
        &rand_bytes(),
        None,
        &key,
        &ps::dh_public(&HOST_DH),
    );
    let mut old = opening.init.clone();
    old.v = None;
    let body = serde_json::to_string(&old).unwrap();
    ws.send(Message::text(
        json!({ "op": "send", "to": host_route, "body": body }).to_string(),
    ))
    .await
    .unwrap();
    let reply = next_body(&mut ws).await.expect("an answer");
    assert!(
        matches!(ps::parse_frame(&reply), Some(SessionFrame::Refuse { reason, .. }) if reason == "update"),
        "{reply}"
    );
    // A static secret that is not the one behind the pinned dhPub is refused.
    let r = call(
        &mut s.app,
        8,
        "remote.configure",
        json!({ "enabled": true, "hostDh": ps::b64(&[9u8; 32]) }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
}

#[path = "../../tests/common/mod.rs"]
mod common;
#[path = "support/pairing.rs"]
mod pairing;

/// A phone identity whose signing key the test holds, so it can sign decisions.
fn signing_phone(seed: u8) -> (ring::signature::Ed25519KeyPair, Value) {
    use ring::signature::KeyPair as _;
    let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap();
    let mut id = identity(seed, "Pocket");
    id["signPub"] = json!(ps::b64(pair.public_key().as_ref()));
    (pair, id)
}

fn signed_decision(pair: &ring::signature::Ed25519KeyPair, request: &Value, decision: &str) -> Value {
    signed_decision_bed(pair, request, decision, false)
}

/// A decision with the card's bed answer (`bedClear: true`) signed into it when `bed` is set.
fn signed_decision_bed(
    pair: &ring::signature::Ed25519KeyPair,
    request: &Value,
    decision: &str,
    bed: bool,
) -> Value {
    let hash = sx_permit::hash_params(request);
    let mut body = json!({ "requestId": request["id"], "decision": decision, "requestHash": hash, "at": 1_790_899_200_000_u64 });
    if bed {
        body["bedClear"] = json!(true);
    }
    let bytes = sx_permit::canonical_json(&body);
    let msg = ps::frame(&[ps::PROTOCOL.as_bytes(), b"approval", bytes.as_bytes()]);
    let mut out = body;
    out["sig"] = json!(ps::b64(pair.sign(&msg).as_ref()));
    out
}

async fn mock_log(mocks: &common::Mocks) -> Vec<String> {
    mocks.state().await["moonraker"]["log"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn phones_read_printers_and_pause_with_a_signed_decision() {
    let mocks = common::Mocks::start("moonraker", &["--camera"]).await;
    let mut s = setup().await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let r = call(&mut s.app, 10, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "bay-4", "{r}");
    mocks.set_state("moonraker", "printing").await;

    let key: [u8; 32] = rand_bytes();
    let (signer, peer) = signing_phone(21);
    put_peer(&mut s.app, &key, "phone", 21, peer).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");

    let list = phone.call("printers.list", json!({})).await;
    assert_eq!(list["r"][0]["id"], "bay-4", "{list}");
    // The saved port, as the computer's own list carries it: the phone builds the printer's web page link from it.
    assert_eq!(list["r"][0]["port"], mocks.port("moonraker"), "{list}");
    let st = phone
        .call("printers.status", json!({ "printerId": "bay-4" }))
        .await;
    assert_eq!(st["ok"], true, "{st}");
    let missing = phone
        .call("printers.status", json!({ "printerId": "nope" }))
        .await;
    assert_eq!(missing["e"]["code"], "not_found", "{missing}");
    let w = phone
        .call("printers.watch", json!({ "printerId": "bay-4" }))
        .await;
    let watch_id = w["r"]["watchId"].as_str().unwrap().to_owned();
    phone.event("printer", |d| d["watchId"] == watch_id).await;
    let still = phone.call("camera.grab", json!({ "printerId": "bay-4" })).await;
    assert_eq!(still["r"]["contentType"], "image/jpeg", "{still}");
    assert!(still["r"]["capturedAt"].is_u64(), "{still}");

    // Live camera without a direct path: sealed JPEG frames, one a second, 640 px at most.
    let cam = phone.call("camera.open", json!({ "printerId": "bay-4" })).await;
    assert_eq!(cam["r"]["quality"], "low", "{cam}");
    let stream = cam["r"]["stream"].as_u64().unwrap();
    let busy = phone.call("camera.open", json!({ "printerId": "bay-4" })).await;
    assert_eq!(busy["e"]["code"], "busy", "{busy}");
    let f1 = phone.event("camera.frame", |d| d["stream"] == stream).await;
    let jpeg = base64::engine::general_purpose::STANDARD
        .decode(f1["dataB64"].as_str().unwrap())
        .unwrap();
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "a JPEG");
    let f2 = phone.event("camera.frame", |d| d["stream"] == stream).await;
    assert!(
        f2["capturedAt"].as_u64().unwrap() >= f1["capturedAt"].as_u64().unwrap() + 900,
        "one a second: {} {}",
        f1["capturedAt"],
        f2["capturedAt"]
    );
    let closed = phone.call("camera.close", json!({ "stream": stream })).await;
    assert_eq!(closed["ok"], true, "{closed}");

    let resume = phone
        .call(
            "jobs.control",
            json!({ "printerId": "bay-4", "action": "resume" }),
        )
        .await;
    assert_eq!(resume["e"]["code"], "not_supported", "{resume}");
    for m in [
        "print.local",
        "bed.confirmClear",
        "secrets.list",
        "printers.add",
        "clients.create",
        "settings.set",
        "upload.begin",
    ] {
        let r = phone.call(m, json!({})).await;
        assert_eq!(r["ok"], false, "{m}: {r}");
    }

    let job = phone
        .call("jobs.control", json!({ "printerId": "bay-4", "action": "pause" }))
        .await;
    let request_id = job["r"]["requestId"].as_str().unwrap().to_owned();
    let job_id = job["r"]["jobId"].as_str().unwrap().to_owned();
    phone
        .event("job", |d| {
            d["jobId"] == job_id.as_str() && d["state"] == "awaiting_approval"
        })
        .await;
    assert!(
        !mock_log(&mocks).await.iter().any(|l| l.contains("pause")),
        "nothing runs before an answer"
    );

    let cards = phone.call("approvals.list", json!({})).await;
    let card = cards["r"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["request"]["id"] == request_id.as_str())
        .unwrap()["request"]
        .clone();
    // A decision signed by another key, or for a changed request, is refused.
    let (other, _) = signing_phone(22);
    let forged = phone
        .call("approvals.decide", signed_decision(&other, &card, "approve"))
        .await;
    assert_eq!(forged["e"]["code"], "forbidden", "{forged}");
    let mut changed = card.clone();
    changed["title"] = json!("Something else");
    let moved = phone
        .call("approvals.decide", signed_decision(&signer, &changed, "approve"))
        .await;
    assert_eq!(moved["e"]["code"], "forbidden", "{moved}");

    let ok = phone
        .call("approvals.decide", signed_decision(&signer, &card, "approve"))
        .await;
    assert_eq!(ok["ok"], true, "{ok}");
    phone
        .event("job", |d| d["jobId"] == job_id.as_str() && d["state"] == "done")
        .await;
    assert!(
        mock_log(&mocks).await.iter().any(|l| l.contains("pause")),
        "{:?}",
        mock_log(&mocks).await
    );
    let again = phone
        .call("approvals.decide", signed_decision(&signer, &card, "approve"))
        .await;
    assert_eq!(again["e"]["code"], "not_found", "{again}");
    drop(s.link);
}

#[tokio::test]
async fn an_agent_raises_a_cancel_card_that_a_person_answers() {
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut s = setup().await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    call(&mut s.app, 10, "printers.add", json!({ "config": cfg })).await;
    mocks.set_state("moonraker", "printing").await;
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, "agent", 31).await;
    let mut agent = Device::open(&s.relay, &key).await.expect("a session");

    let job = agent
        .call(
            "jobs.control",
            json!({ "printerId": "bay-4", "action": "cancel" }),
        )
        .await;
    let request_id = job["r"]["requestId"].as_str().unwrap().to_owned();
    let job_id = job["r"]["jobId"].as_str().unwrap().to_owned();
    let cards = agent.call("approvals.list", json!({})).await;
    assert_eq!(cards["r"], json!([]), "agents see no cards to answer");
    let cam = agent.call("camera.open", json!({ "printerId": "bay-4" })).await;
    assert_eq!(cam["e"]["code"], "forbidden", "agents get stills only: {cam}");
    let forged = agent.call("approvals.decide", json!({ "requestId": request_id, "decision": "approve", "requestHash": "00", "at": 1, "sig": "AA" })).await;
    assert_eq!(forged["e"]["code"], "forbidden", "{forged}");

    // The app's card answers it; the hub runs the cancel.
    let pending = call(&mut s.app, 11, "approvals.pending", json!({})).await;
    let card = pending["result"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == request_id.as_str())
        .unwrap()
        .clone();
    assert_eq!(card["origin"], "mcp", "{card}");
    let g = call(
        &mut s.app,
        12,
        "approvals.grant",
        json!({ "requestId": request_id }),
    )
    .await;
    assert_eq!(g["result"]["runBy"], "hub", "{g}");
    agent
        .event("job", |d| d["jobId"] == job_id.as_str() && d["state"] == "done")
        .await;
    assert!(
        mock_log(&mocks).await.iter().any(|l| l.contains("cancel")),
        "{:?}",
        mock_log(&mocks).await
    );
}

#[tokio::test]
async fn an_agent_key_from_clients_create_works_over_the_relay_until_revoked() {
    let mut s = setup().await;
    let r = call(
        &mut s.app,
        20,
        "clients.create",
        json!({ "name": "Remote helper", "role": "agent", "remote": true }),
    )
    .await;
    let remote = r["result"]["remote"].clone();
    assert_eq!(remote["host"], s.host, "{r}");
    assert!(remote["hubKey"].is_string(), "{r}");
    let key: [u8; 32] = ps::unb64(remote["deviceKey"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut agent = Device::open(&s.relay, &key).await.expect("a session");
    let info = agent.call("host.info", json!({})).await;
    assert_eq!(
        info["r"]["rights"],
        json!({ "request": true, "approve": false, "introduce": false }),
        "{info}"
    );
    let watch = call(
        &mut s.app,
        21,
        "clients.create",
        json!({ "name": "Detector", "role": "watch", "remote": true }),
    )
    .await;
    assert_eq!(watch["error"]["code"], "bad_request", "{watch}");

    // L4: a remote agent gets its relay pairing only, no key for the control socket.
    assert!(r["result"]["clientKey"].is_null(), "{r}");
    // L3: its identity carries no keys, so nothing can ever verify against it.
    let list = call(&mut s.app, 23, "remote.pairings.list", json!({})).await;
    let me = list["result"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["pairingId"] == remote["pairingId"])
        .unwrap()
        .clone();
    assert!(
        me["peer"]["signPub"].is_null() && me["peer"]["dhPub"].is_null(),
        "{me}"
    );
    let id = r["result"]["clientId"].clone();
    let rv = call(&mut s.app, 22, "clients.revoke", json!({ "clientId": id })).await;
    assert_eq!(rv["result"]["revoked"], true, "{rv}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(Device::open(&s.relay, &key).await.is_none());
}

#[tokio::test]
async fn a_partner_key_over_the_relay_asks_only_to_pause_or_cancel_and_approves_nothing() {
    let mut s = setup().await;
    let r = call(
        &mut s.app,
        20,
        "clients.create",
        json!({ "name": "LayerMate", "role": "agent", "partner": true, "remote": true }),
    )
    .await;
    assert_eq!(r["result"]["partner"], true, "{r}");
    assert!(
        r["result"]["clientKey"].is_null(),
        "no key for the control socket: {r}"
    );
    let remote = r["result"]["remote"].clone();
    let key: [u8; 32] = ps::unb64(remote["deviceKey"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut p = Device::open(&s.relay, &key).await.expect("a session");
    let info = p.call("host.info", json!({})).await;
    assert_eq!(info["r"]["rights"]["approve"], false, "{info}");
    let resume = p
        .call(
            "jobs.control",
            json!({ "printerId": "bay-4", "action": "resume" }),
        )
        .await;
    assert_eq!(resume["ok"], false, "{resume}");
    for m in [
        "print.local",
        "upload.begin",
        "clients.create",
        "approvals.grant",
        "gcode",
    ] {
        let r = p.call(m, json!({})).await;
        assert_eq!(r["ok"], false, "{m}: {r}");
    }
    let id = r["result"]["clientId"].clone();
    let rv = call(&mut s.app, 22, "clients.revoke", json!({ "clientId": id })).await;
    assert_eq!(rv["result"]["revoked"], true, "{rv}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(Device::open(&s.relay, &key).await.is_none());
}

/// A phone's WebRTC end, played by str0m: a complete offer (receive video, one data channel), then
/// a run loop until the first picture arrives over the data channel.
async fn phone_rtc_until_picture(phone: &mut Device, printer: &str) -> Vec<u8> {
    use std::time::Instant;
    use str0m::change::SdpAnswer;
    use str0m::media::{Direction, MediaKind};
    use str0m::net::{Protocol, Receive};
    use str0m::{Candidate, Event, Input, Output, Rtc};

    let socket = tokio::net::UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
    let local = socket.local_addr().unwrap();
    let mut rtc = Rtc::builder().build(Instant::now());
    rtc.add_local_candidate(Candidate::host(local, "udp").unwrap());
    let mut change = rtc.sdp_api();
    change.add_media(MediaKind::Video, Direction::RecvOnly, None, None, None);
    change.add_channel("pictures".to_owned());
    let (offer, pending) = change.apply().unwrap();
    let r = phone
        .call(
            "camera.rtc",
            json!({ "printerId": printer, "sdp": offer.to_sdp_string() }),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let answer = SdpAnswer::from_sdp_string(r["r"]["sdp"].as_str().unwrap()).unwrap();
    rtc.sdp_api().accept_answer(pending, answer).unwrap();

    let mut buf = vec![0u8; 2000];
    let end = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut seen: Vec<String> = Vec::new();
    loop {
        let deadline = loop {
            match rtc.poll_output().unwrap() {
                Output::Timeout(t) => break t,
                Output::Transmit(t) => {
                    let _ = socket.try_send_to(&t.contents, t.destination);
                }
                Output::Event(Event::ChannelData(d)) => return d.data,
                Output::Event(e) => seen.push(format!("{e:?}").chars().take(60).collect()),
            }
        };
        let wait = deadline.saturating_duration_since(Instant::now());
        tokio::select! {
            () = tokio::time::sleep_until(end) => panic!("no picture over the direct path; saw {seen:?}; session events {:?}", phone.events),
            r = socket.recv_from(&mut buf) => {
                let (n, source) = r.unwrap();
                let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: local, contents: buf[..n].try_into().unwrap() });
                rtc.handle_input(input).unwrap();
            }
            () = tokio::time::sleep(wait) => rtc.handle_input(Input::Timeout(Instant::now())).unwrap(),
        }
    }
}

#[tokio::test]
async fn a_phone_gets_direct_video_over_webrtc_with_signaling_in_the_session() {
    let mocks = common::Mocks::start("moonraker", &["--camera"]).await;
    let mut s = setup().await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 500 });
    call(&mut s.app, 10, "printers.add", json!({ "config": cfg })).await;
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, "phone", 41).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let bad = phone
        .call("camera.rtc", json!({ "printerId": "bay-4", "sdp": "v=0" }))
        .await;
    assert_eq!(bad["e"]["code"], "bad_request", "{bad}");
    let picture = phone_rtc_until_picture(&mut phone, "bay-4").await;
    assert_eq!(&picture[..2], &[0xFF, 0xD8], "a JPEG over the data channel");
    // The relay carried only the session: no picture went through it.
    assert!(s.relay.stats().bytes < 64 * 1024, "{:?}", s.relay.stats());

    let agent_key: [u8; 32] = rand_bytes();
    put(&mut s.app, &agent_key, "agent", 42).await;
    let mut agent = Device::open(&s.relay, &agent_key).await.expect("a session");
    let r = agent
        .call("camera.rtc", json!({ "printerId": "bay-4", "sdp": "v=0" }))
        .await;
    assert_eq!(r["e"]["code"], "forbidden", "{r}");
}

fn session_token(account: &str, secret: &[u8]) -> String {
    let exp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 600;
    sx_relay::auth::sign_hs256(secret, &json!({ "sub": account, "aud": "sx-relay", "exp": exp }))
}

async fn wait_tier(app: &mut Ws, tier: &str) -> Value {
    for i in 0..100 {
        let s = call(app, 500 + i, "remote.status", json!({})).await;
        if s["result"]["quota"]["tier"] == tier && s["result"]["connected"] == true {
            return s["result"].clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never reached the {tier} tier");
}

#[tokio::test]
async fn a_signed_in_hub_uses_the_account_tier_and_falls_back_without_it() {
    let mut s = setup().await;
    wait_tier(&mut s.app, "anonymous").await;
    let token = session_token("8d0f6f7e-1c2a-4b7e-9a51-3f0e2b1d4c55", RELAY_SECRET);
    let r = call(&mut s.app, 40, "remote.token", json!({ "token": token })).await;
    assert!(!r.to_string().contains(&token), "the token never comes back: {r}");
    let st = wait_tier(&mut s.app, "account").await;
    assert_eq!(st["signedIn"], true, "{st}");
    assert_eq!(st["quota"]["cap"], 5_000_000_000_u64, "{st}");
    // A refreshed session for the same account keeps the connection.
    let again = session_token("8d0f6f7e-1c2a-4b7e-9a51-3f0e2b1d4c55", RELAY_SECRET);
    call(&mut s.app, 41, "remote.token", json!({ "token": again })).await;
    assert_eq!(wait_tier(&mut s.app, "account").await["signedIn"], true);

    // Signing out reconnects on the anonymous tier.
    call(&mut s.app, 42, "remote.token", json!({ "token": null })).await;
    let st = wait_tier(&mut s.app, "anonymous").await;
    assert_eq!(st["signedIn"], false, "{st}");

    // Signing out reads as signed out at once, before the relay answers.
    call(&mut s.app, 46, "remote.token", json!({ "token": again })).await;
    wait_tier(&mut s.app, "account").await;
    let out = call(&mut s.app, 47, "remote.token", json!({ "token": null })).await;
    assert_eq!(out["result"]["signedIn"], false, "{out}");

    // M4: the account's own session never goes to the relay; the hub refuses to hold it.
    let exp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 600;
    let session = sx_relay::auth::sign_hs256(
        RELAY_SECRET,
        &json!({ "sub": "8d0f6f7e-1c2a-4b7e-9a51-3f0e2b1d4c55", "aud": "authenticated", "exp": exp }),
    );
    let r = call(&mut s.app, 48, "remote.token", json!({ "token": session })).await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    wait_tier(&mut s.app, "anonymous").await;

    // A session the relay refuses leaves the hub working on the anonymous tier.
    let forged = session_token("someone-else", b"not the relay's secret");
    call(&mut s.app, 43, "remote.token", json!({ "token": forged })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let st = wait_tier(&mut s.app, "anonymous").await;
    assert_eq!(st["signedIn"], false, "{st}");
    assert!(st["lastError"].as_str().unwrap_or("").contains("refused"), "{st}");
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, "phone", 51).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("still reachable");
    assert_eq!(phone.call("host.info", json!({})).await["ok"], true);

    // Only the app hands over a session, and only one shaped like a token.
    let r = call(&mut s.agent, 44, "remote.token", json!({ "token": token })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let r = call(&mut s.app, 45, "remote.token", json!({ "token": "not a token" })).await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn agent_card(id: &str, tool: &str, actions: Value) -> Value {
    json!({
        "id": id, "sessionId": "s", "tool": tool, "permission": "start", "title": "Something harmless", "lines": ["Trust me"],
        "printerId": "bay-4", "paramsHash": sx_permit::hash_params(&json!({})), "actions": actions,
        "expiresAt": "2099-01-01T00:00:00.000Z",
    })
}

async fn printing_bay4(s: &mut Setup) -> common::Mocks {
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let r = call(&mut s.app, 10, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "bay-4", "{r}");
    mocks.set_state("moonraker", "printing").await;
    mocks
}

#[tokio::test]
async fn h1_h2_away_from_home_a_phone_approves_only_pause_and_cancel_and_sees_the_checked_work() {
    let mut s = setup().await;
    let mocks = printing_bay4(&mut s).await;
    let key: [u8; 32] = rand_bytes();
    let (signer, peer) = signing_phone(61);
    put_peer(&mut s.app, &key, "phone", 61, peer).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let h = sx_permit::hash_params;

    // A local agent raises cards that heat, move or start the printer, each with its work.
    let data = b"G28\nG1 X10 Y10\n".to_vec();
    let sha = hex(ring::digest::digest(&ring::digest::SHA256, &data).as_ref());
    let file = json!({ "name": "cube.gcode", "kind": "gcode", "sha256": sha, "dataBase64": base64::engine::general_purpose::STANDARD.encode(&data) });
    let change = json!({ "kind": "fan", "fan": "part", "percent": 40 });
    let line = "M140 S110";
    let cards = [
        (
            "w-print",
            "printer.queue",
            json!([
                { "action": "printer.upload", "target": "bay-4", "paramsHash": h(&json!({ "printerId": "bay-4", "name": "cube.gcode", "sha256": sha })) },
                { "action": "printer.start", "target": "bay-4", "paramsHash": h(&json!({ "printerId": "bay-4", "name": "cube.gcode", "opts": {}, "sha256": sha })) },
            ]),
            json!({ "kind": "print", "printerId": "bay-4", "file": file }),
        ),
        (
            "w-resume",
            "printer.resume",
            json!([{ "action": "printer.resume", "target": "bay-4", "paramsHash": h(&json!({ "printerId": "bay-4" })) }]),
            json!({ "kind": "resume", "printerId": "bay-4" }),
        ),
        (
            "w-gcode",
            "printer.gcode",
            json!([{ "action": "printer.gcode", "target": "bay-4", "paramsHash": h(&json!({ "printerId": "bay-4", "line": line })) }]),
            json!({ "kind": "gcode", "printerId": "bay-4", "line": line }),
        ),
        (
            "w-adjust",
            "printer.adjust",
            json!([{ "action": "printer.adjust", "target": "bay-4", "paramsHash": h(&json!({ "printerId": "bay-4", "change": change })) }]),
            json!({ "kind": "adjust", "printerId": "bay-4", "change": change }),
        ),
    ];
    for (i, (id, tool, actions, work)) in cards.iter().enumerate() {
        let r = call(
            &mut s.agent,
            60 + i as u64,
            "approvals.register",
            json!({ "request": agent_card(id, tool, actions.clone()), "work": work }),
        )
        .await;
        assert_eq!(r["result"]["registered"], true, "{r}");
        // H2: the card arrives with the hub's checked work next to the request, not inside it.
        let view = phone
            .event("approval.request", |d| d["request"]["id"] == *id)
            .await;
        assert!(view["request"].get("work").is_none(), "{view}");
        assert_eq!(view["work"]["kind"], work["kind"], "{view}");
        // H1: no approval from afar, whatever the bed answer says.
        for bed in [false, true] {
            let r = phone
                .call(
                    "approvals.decide",
                    signed_decision_bed(&signer, &view["request"], "approve", bed),
                )
                .await;
            assert_eq!(r["e"]["code"], "not_supported", "{id}: {r}");
        }
    }
    // H2: the phone can check the summary against the action hashes it signs over.
    let list = phone.call("approvals.list", json!({})).await;
    let g = list["r"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["request"]["id"] == "w-gcode")
        .unwrap()
        .clone();
    assert_eq!(g["work"]["line"], line, "{g}");
    assert_eq!(
        g["request"]["actions"][0]["paramsHash"],
        h(&json!({ "printerId": g["work"]["printerId"], "line": g["work"]["line"] }))
    );
    let pr = list["r"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["request"]["id"] == "w-print")
        .unwrap()
        .clone();
    assert_eq!(pr["work"]["file"]["sha256"], sha.as_str(), "{pr}");
    assert_eq!(pr["work"]["file"]["sizeBytes"], data.len(), "{pr}");

    // A queued plate is approved at home too, bed answer or not.
    let (qd, qsha) = (
        b"G28\n".to_vec(),
        hex(ring::digest::digest(&ring::digest::SHA256, b"G28\n").as_ref()),
    );
    let qf = json!({ "name": "plate.gcode", "kind": "gcode", "sha256": qsha, "dataBase64": base64::engine::general_purpose::STANDARD.encode(&qd) });
    let q = call(&mut s.app, 70, "queue.add", json!({ "printerId": "bay-4", "file": qf, "title": "Plate", "startAfterMs": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 3_600_000 })).await;
    let qreq = q["result"]["request"].clone();
    assert!(qreq["id"].is_string(), "{q}");
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &qreq, "approve", true),
        )
        .await;
    assert_eq!(r["e"]["code"], "not_supported", "{r}");

    tokio::time::sleep(Duration::from_millis(300)).await;
    let log = mock_log(&mocks).await;
    assert!(
        !log.iter().any(|l| l.starts_with("upload")
            || l.starts_with("start ")
            || l == "resume"
            || l.starts_with("gcode")),
        "nothing ran: {log:?}"
    );

    // Denying from afar still works: the person can stop what they did not ask for.
    let r = phone
        .call(
            "approvals.decide",
            signed_decision(&signer, &g["request"], "deny"),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    // The app's card for it closes: the hub tells the app the phone answered.
    let done = app_event(&mut s.app, "approval.resolved", |d| d["requestId"] == "w-gcode").await;
    assert_eq!(
        done,
        json!({ "requestId": "w-gcode", "decision": "denied", "via": "phone" })
    );
    let pending = call(&mut s.app, 71, "approvals.pending", json!({})).await;
    assert!(
        !pending["result"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == "w-gcode"),
        "{pending}"
    );

    // M6: a device has two remote cards waiting at most; the slots of local agents stay free.
    for _ in 0..2 {
        let j = phone
            .call("jobs.control", json!({ "printerId": "bay-4", "action": "pause" }))
            .await;
        assert_eq!(j["ok"], true, "{j}");
    }
    let third = phone
        .call(
            "jobs.control",
            json!({ "printerId": "bay-4", "action": "cancel" }),
        )
        .await;
    assert_eq!(third["e"]["code"], "busy", "{third}");
}

#[tokio::test]
async fn a_card_answered_in_the_app_or_withdrawn_by_its_agent_closes_on_the_phone() {
    let mut s = setup().await;
    let _mocks = printing_bay4(&mut s).await;
    let key: [u8; 32] = rand_bytes();
    let (_, peer) = signing_phone(62);
    put_peer(&mut s.app, &key, "phone", 62, peer).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let h = sx_permit::hash_params;
    let line = "M117 Hello";
    let cards = [
        (
            "r-app",
            "printer.resume",
            json!([{ "action": "printer.resume", "target": "bay-4", "paramsHash": h(&json!({ "printerId": "bay-4" })) }]),
            json!({ "kind": "resume", "printerId": "bay-4" }),
        ),
        (
            "r-agent",
            "printer.gcode",
            json!([{ "action": "printer.gcode", "target": "bay-4", "paramsHash": h(&json!({ "printerId": "bay-4", "line": line })) }]),
            json!({ "kind": "gcode", "printerId": "bay-4", "line": line }),
        ),
    ];

    // A local agent raises two cards with their work; both reach the phone.
    for (i, (id, tool, actions, work)) in cards.into_iter().enumerate() {
        let r = call(
            &mut s.agent,
            80 + i as u64,
            "approvals.register",
            json!({ "request": agent_card(id, tool, actions), "work": work }),
        )
        .await;
        assert_eq!(r["result"]["registered"], true, "{r}");
        phone
            .event("approval.request", |d| d["request"]["id"] == id)
            .await;
    }

    // The person approves one in the app: the phone hears it, as its own protocol words it.
    let r = call(&mut s.app, 82, "approvals.grant", json!({ "requestId": "r-app" })).await;
    assert!(r["result"].is_object(), "{r}");
    let done = phone
        .event("approval.resolved", |d| d["requestId"] == "r-app")
        .await;
    assert_eq!(
        done,
        json!({ "requestId": "r-app", "decision": "approve", "by": "app", "via": "app" })
    );

    // The agent withdraws the other.
    let r = call(
        &mut s.agent,
        83,
        "approvals.deny",
        json!({ "requestId": "r-agent" }),
    )
    .await;
    assert_eq!(r["result"]["denied"], true, "{r}");
    let done = phone
        .event("approval.resolved", |d| d["requestId"] == "r-agent")
        .await;
    assert_eq!(
        done,
        json!({ "requestId": "r-agent", "decision": "deny", "by": "agent", "via": "agent" })
    );

    // Neither is listed any more, so the phone's re-read drops them too.
    let list = phone.call("approvals.list", json!({})).await;
    assert!(
        !list["r"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["request"]["id"] == "r-app" || v["request"]["id"] == "r-agent"),
        "{list}"
    );
}

#[tokio::test]
async fn m5_remote_stills_are_shared_and_requests_per_session_are_bounded() {
    let mocks = common::Mocks::start("moonraker", &["--camera"]).await;
    let mut s = setup().await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 500 });
    call(&mut s.app, 10, "printers.add", json!({ "config": cfg })).await;
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, "agent", 62).await;
    let mut agent = Device::open(&s.relay, &key).await.expect("a session");
    let mut ids = Vec::new();
    for _ in 0..12 {
        ids.push(agent.fire("camera.grab", json!({ "printerId": "bay-4" })).await);
    }
    let replies = agent.replies(&ids).await;
    let busy = replies.iter().filter(|r| r["e"]["code"] == "busy").count();
    let stills: Vec<u64> = replies
        .iter()
        .filter_map(|r| r["r"]["capturedAt"].as_u64())
        .collect();
    assert!(busy >= 1, "past four at once the hub says busy: {replies:?}");
    assert!(!stills.is_empty(), "{replies:?}");
    // Requests in flight together share one fetch.
    assert!(stills.iter().all(|t| *t == stills[0]), "{stills:?}");
}

/// The camera's PLAY and TEARDOWN lines from the Bambu fake's log.
fn rtsp_lines(state: &Value) -> Vec<String> {
    state["log"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l.as_str())
        .filter(|l| l.starts_with("rtsp PLAY") || l.starts_with("rtsp TEARDOWN"))
        .map(str::to_owned)
        .collect()
}

// A phone that closes its live view while the hub is still opening the camera (PLAY sent, not
// answered yet) ends the stream task mid open. The camera session still ends with TEARDOWN, so the
// H2D does not hold it and turn the next view away as busy.
#[tokio::test]
async fn a_phone_view_closed_while_the_camera_opens_still_ends_the_session() {
    let mocks = common::Mocks::start("bambu", &[]).await;
    mocks
        .control("/bambu", json!({ "model": "O1D", "playDelayMs": 1500 }))
        .await;
    let mut s = setup().await;
    let r = call(
        &mut s.app,
        10,
        "secrets.set",
        json!({ "name": "bambu-code", "value": mocks.str("accessCode") }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let cfg = json!({
        "id": "h2d", "name": "H2D", "plugin": "bambu-lan", "host": "127.0.0.1", "port": mocks.port("bambu"),
        "serial": mocks.str("serial"), "credentialRef": "bambu-code", "rtspPort": mocks.port("bambu-rtsps"),
    });
    let r = call(&mut s.app, 11, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "h2d", "{r}");
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, "phone", 64).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let cam = phone.call("camera.open", json!({ "printerId": "h2d" })).await;
    let stream = cam["r"]["stream"].as_u64().unwrap_or_else(|| panic!("{cam}"));
    let mut asked = false;
    for _ in 0..100 {
        if rtsp_lines(&mocks.state().await) == ["rtsp PLAY ok"] {
            asked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(asked, "the hub got as far as PLAY");
    let closed = phone.call("camera.close", json!({ "stream": stream })).await;
    assert_eq!(closed["ok"], true, "{closed}");
    let mut lines = Vec::new();
    for _ in 0..30 {
        lines = rtsp_lines(&mocks.state().await);
        if lines.len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(lines, ["rtsp PLAY ok", "rtsp TEARDOWN ok"]);
}

#[tokio::test]
async fn l1_a_replayed_init_never_drops_a_live_session() {
    let mut s = setup().await;
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, "phone", 63).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let mut second = Device::open(&s.relay, &key).await.expect("a second session");
    assert_eq!(second.call("host.info", json!({})).await["ok"], true);
    // The relay replays both inits, again and again: no answer, and nobody is pushed out.
    let mut relay_op = connect_async(format!("ws://{}/v1", s.relay.addr))
        .await
        .unwrap()
        .0;
    for _ in 0..3 {
        for init in [&phone.init, &second.init] {
            relay_op
                .send(Message::text(
                    json!({ "op": "send", "to": phone.host_route, "body": init }).to_string(),
                ))
                .await
                .unwrap();
        }
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(phone.call("host.info", json!({})).await["ok"], true);
    assert_eq!(second.call("host.info", json!({})).await["ok"], true);
}

#[tokio::test]
async fn n1_n2_an_agent_cannot_hide_a_command_in_a_gcode_card_or_hold_a_card_for_days() {
    let mut s = setup().await;
    let h = sx_permit::hash_params;
    let line = format!("M117 Checking the nozzle {}\nM104 S290", "x".repeat(120));
    let actions = json!([{ "action": "printer.gcode", "target": "bay-4", "paramsHash": h(&json!({ "printerId": "bay-4", "line": line })) }]);
    let r = call(&mut s.agent, 90, "approvals.register", json!({ "request": agent_card("n1", "printer.gcode", actions), "work": { "kind": "gcode", "printerId": "bay-4", "line": line } })).await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    // A single short line is fine, and its card closes within half an hour whatever the agent asked.
    let ok = "M117 Checking the nozzle";
    let actions = json!([{ "action": "printer.gcode", "target": "bay-4", "paramsHash": h(&json!({ "printerId": "bay-4", "line": ok })) }]);
    let r = call(&mut s.agent, 91, "approvals.register", json!({ "request": agent_card("n2", "printer.gcode", actions), "work": { "kind": "gcode", "printerId": "bay-4", "line": ok } })).await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let pending = call(&mut s.app, 92, "approvals.pending", json!({})).await;
    let cards = pending["result"].as_array().cloned().unwrap_or_default();
    assert!(
        !cards.iter().any(|c| c["id"] == "n1"),
        "the refused card was never raised: {pending}"
    );
    let card = cards.iter().find(|c| c["id"] == "n2").expect("the card waits");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let expires = card["expiresAt"].as_str().unwrap();
    assert!(expires < "2099" && expires.starts_with("20"), "{card}");
    let ms = chrono_ms(expires);
    assert!(ms > now && ms <= now + 30 * 60_000 + 5_000, "{card}");
}

/// Milliseconds since the epoch of `YYYY-MM-DDTHH:MM:SS.mmmZ`.
fn chrono_ms(t: &str) -> i64 {
    let n = |a: usize, b: usize| t[a..b].parse::<i64>().unwrap();
    let (y, m, d) = (n(0, 4), n(5, 7), n(8, 10));
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    ((days * 24 + n(11, 13)) * 60 + n(14, 16)) * 60_000 + n(17, 19) * 1000 + n(20, 23)
}

#[tokio::test]
async fn m1_the_app_reconciles_phone_pairings_and_hears_when_a_phone_removes_itself() {
    let mut s = setup().await;
    let (ka, kb, kc): ([u8; 32], [u8; 32], [u8; 32]) = (rand_bytes(), rand_bytes(), rand_bytes());
    let a = put(&mut s.app, &ka, "phone", 64).await;
    let b = put(&mut s.app, &kb, "phone", 65).await;
    put(&mut s.app, &kc, "agent", 66).await;
    // N3: an empty list (a pair store that did not open, another app) removes nothing on its own.
    let r = call(
        &mut s.app,
        79,
        "remote.pairings.sync",
        json!({ "pairingIds": [] }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    assert!(
        Device::open(&s.relay, &kb).await.is_some(),
        "the phones stay paired"
    );
    // The app removed phone b while the hub was out of reach; its next sync lists only a.
    let r = call(
        &mut s.app,
        80,
        "remote.pairings.sync",
        json!({ "pairingIds": [a] }),
    )
    .await;
    assert_eq!(r["result"]["removed"], json!([b]), "{r}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        Device::open(&s.relay, &kb).await.is_none(),
        "a removed phone gets no session"
    );
    assert!(
        Device::open(&s.relay, &kc).await.is_some(),
        "agent pairings belong to the hub"
    );
    let mut phone = Device::open(&s.relay, &ka).await.expect("a session");
    // A phone that unpairs itself: the app hears it, so its next sync does not hand it back.
    let r = phone.call("pairing.revoke", json!({})).await;
    assert_eq!(r["ok"], true, "{r}");
    let mut seen = false;
    for _ in 0..40 {
        if let Ok(Some(Ok(Message::Text(t)))) =
            tokio::time::timeout(Duration::from_millis(100), s.app.next()).await
        {
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if v["event"] == "remote.pairing.revoked" && v["data"]["pairingId"] == a.as_str() {
                seen = true;
                break;
            }
        }
    }
    assert!(seen, "the app hears that the phone removed itself");
    // Removing every phone takes the explicit flag.
    let kd: [u8; 32] = rand_bytes();
    let d = put(&mut s.app, &kd, "phone", 67).await;
    let r = call(
        &mut s.app,
        81,
        "remote.pairings.sync",
        json!({ "pairingIds": [], "removeAll": true }),
    )
    .await;
    assert_eq!(r["result"]["removed"], json!([d]), "{r}");
    assert!(Device::open(&s.relay, &kd).await.is_none(), "removed on purpose");
    // With no phones left, an empty list is a no-op either way.
    let r = call(
        &mut s.app,
        82,
        "remote.pairings.sync",
        json!({ "pairingIds": [] }),
    )
    .await;
    assert_eq!(r["result"]["removed"], json!([]), "{r}");
}

/// A phone pairing put by the app that says it is `app_id`.
async fn put_as(app: &mut Ws, key: &[u8; 32], seed: u8, app_id: &str) -> String {
    let pairing_id = ps::b64(&[seed; 16]);
    let r = call(
        app,
        3,
        "remote.pairings.put",
        json!({ "pairingId": pairing_id, "deviceKey": ps::b64(key), "kind": "phone", "peer": identity(seed, "Pocket"), "rights": { "request": true }, "appId": app_id }),
    )
    .await;
    assert_eq!(r["result"]["saved"], true, "{r}");
    pairing_id
}

#[tokio::test]
async fn n3_two_apps_on_one_hub_never_remove_each_others_phones() {
    let mut s = setup().await;
    let (ka, kb, kc): ([u8; 32], [u8; 32], [u8; 32]) = (rand_bytes(), rand_bytes(), rand_bytes());
    let a = put_as(&mut s.app, &ka, 90, "desk-a").await;
    let b = put_as(&mut s.app, &kb, 91, "desk-b").await;
    // A phone from before pairings were tagged.
    let c = put(&mut s.app, &kc, "phone", 92).await;
    let ids = |r: &Value| r["result"]["removed"].clone();

    // App B knows only its own phone: its sync removes nothing of app A's, and leaves the old one.
    let r = call(
        &mut s.app,
        93,
        "remote.pairings.sync",
        json!({ "pairingIds": [b], "appId": "desk-b" }),
    )
    .await;
    assert_eq!(ids(&r), json!([]), "{r}");
    // An empty list is refused while this app has phones, whatever the other app holds.
    let r = call(
        &mut s.app,
        94,
        "remote.pairings.sync",
        json!({ "pairingIds": [], "appId": "desk-a" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    // App A lists its phone and the old one, which it claims.
    let r = call(
        &mut s.app,
        95,
        "remote.pairings.sync",
        json!({ "pairingIds": [a, c], "appId": "desk-a" }),
    )
    .await;
    assert_eq!(ids(&r), json!([]), "{r}");
    let list = call(&mut s.app, 96, "remote.pairings.list", json!({})).await;
    let owner = |id: &str| {
        list["result"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["pairingId"] == id)
            .unwrap()["owner"]
            .clone()
    };
    assert_eq!(owner(&c), "app:desk-a", "{list}");
    assert_eq!(owner(&b), "app:desk-b", "{list}");
    // App A unpairs everything of its own: app B's phone stays paired and reachable.
    let r = call(
        &mut s.app,
        97,
        "remote.pairings.sync",
        json!({ "pairingIds": [], "removeAll": true, "appId": "desk-a" }),
    )
    .await;
    let mut gone: Vec<String> = serde_json::from_value(ids(&r)).unwrap();
    gone.sort();
    let mut want = vec![a.clone(), c.clone()];
    want.sort();
    assert_eq!(gone, want, "{r}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        Device::open(&s.relay, &kb).await.is_some(),
        "app B's phone is still paired"
    );
    assert!(Device::open(&s.relay, &ka).await.is_none());
    // A malformed app id tags nothing.
    let r = call(
        &mut s.app,
        98,
        "remote.pairings.sync",
        json!({ "pairingIds": [], "appId": "x y" }),
    )
    .await;
    assert_eq!(
        ids(&r),
        json!([]),
        "no untagged phones are left, and app B's are not this caller's: {r}"
    );
}

/// An app connection from the desktop window's origin, paired with the app code, so it may host
/// the app link.
async fn desktop_window(link: &Link) -> Ws {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    let mut req = format!("ws://127.0.0.1:{}/", link.addr().port())
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("origin", "tauri://localhost".parse().unwrap());
    let mut ws = connect_async(req).await.unwrap().0;
    let pp = pairing::proof_params(&mut ws, CODE, json!({})).await;
    let r = call(&mut ws, 1, "pair", pp).await;
    assert_eq!(r["result"]["paired"], true, "{r}");
    let r = call(&mut ws, 2, "appLink.host", json!({})).await;
    assert!(r["result"].is_object(), "{r}");
    ws
}

fn question(ask: &str) -> Value {
    json!({ "v": 1, "sessionId": "s_1", "askId": ask, "title": "Confirm the part", "question": "Is this the one?", "choices": [{ "id": "same", "label": "Yes" }, { "id": "other", "label": "No" }], "at": 1 })
}

#[tokio::test]
async fn an_approver_phone_answers_mimirs_question_through_the_app_and_nobody_else_can() {
    let mut s = setup().await;
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, "phone", 71).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let info = phone.call("host.info", json!({})).await;
    assert_eq!(info["r"]["mimir"], true, "{info}");

    // The app is closed: nothing is live, and an answer cannot be taken.
    let st = phone.call("mimir.questions", json!({})).await;
    assert_eq!(st["r"], json!({ "live": false, "waiting": null }), "{st}");
    let closed = phone
        .call(
            "mimir.answer",
            json!({ "v": 1, "sessionId": "s_1", "askId": "a1", "choiceId": "same" }),
        )
        .await;
    assert_eq!(closed["e"]["code"], "unavailable", "{closed}");

    // The app opens and mimir asks: the phone hears it and reads it back.
    let mut win = desktop_window(&s.link).await;
    let r = call(
        &mut win,
        10,
        "appLink.mimirState",
        json!({ "waiting": question("a1") }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let ev = phone
        .event("mimir.question", |d| d["waiting"]["askId"] == "a1")
        .await;
    assert_eq!(ev["live"], true);
    let st = phone.call("mimir.questions", json!({})).await;
    assert_eq!(st["r"]["waiting"], question("a1"), "{st}");

    // Only the app that hosts the link says what mimir waits on.
    let r = call(&mut s.app, 11, "appLink.mimirState", json!({ "waiting": null })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let r = call(&mut s.agent, 12, "appLink.mimirState", json!({ "waiting": null })).await;
    assert!(r["error"].is_object(), "{r}");

    // A wrong version never reaches the app.
    let v2 = phone
        .call(
            "mimir.answer",
            json!({ "v": 2, "sessionId": "s_1", "askId": "a1", "choiceId": "same" }),
        )
        .await;
    assert_eq!(v2["e"]["code"], "bad_request", "{v2}");

    // The phone picks: the app gets the answer with the phone's name, takes it, and the phone hears it end.
    let id = phone
        .fire(
            "mimir.answer",
            json!({ "v": 1, "sessionId": "s_1", "askId": "a1", "choiceId": "other" }),
        )
        .await;
    let asked = app_event(&mut win, "appLink.phoneAnswer", |_| true).await;
    assert_eq!(
        asked["answer"],
        json!({ "sessionId": "s_1", "askId": "a1", "choiceId": "other" })
    );
    assert_eq!(asked["phone"]["name"], "Pocket");
    let r = call(
        &mut win,
        13,
        "appLink.reply",
        json!({ "callId": asked["callId"], "ok": true, "value": {} }),
    )
    .await;
    assert_eq!(r["result"]["delivered"], true, "{r}");
    let replies = phone.replies(&[id]).await;
    assert_eq!(replies[0]["r"], json!({ "answered": true }), "{replies:?}");
    call(&mut win, 14, "appLink.mimirState", json!({ "waiting": null, "ended": { "askId": "a1", "choiceId": "other", "by": "phone", "name": "Pocket" } })).await;
    let ev = phone
        .event("mimir.question", |d| d["ended"]["askId"] == "a1")
        .await;
    assert_eq!(ev["waiting"], Value::Null);
    assert_eq!(ev["ended"]["by"], "phone");

    // Cancel goes as a null choice; a late answer the app refuses comes back not_found.
    call(
        &mut win,
        15,
        "appLink.mimirState",
        json!({ "waiting": question("a2") }),
    )
    .await;
    let id = phone
        .fire(
            "mimir.answer",
            json!({ "v": 1, "sessionId": "s_1", "askId": "a2", "choiceId": null }),
        )
        .await;
    let asked = app_event(&mut win, "appLink.phoneAnswer", |_| true).await;
    assert_eq!(asked["answer"]["choiceId"], Value::Null);
    call(
        &mut win,
        16,
        "appLink.reply",
        json!({ "callId": asked["callId"], "ok": false, "code": "not_found", "message": "gone" }),
    )
    .await;
    let replies = phone.replies(&[id]).await;
    assert_eq!(replies[0]["e"]["code"], "not_found", "{replies:?}");

    // A phone without the approve right, and an agent over the relay, read and answer nothing.
    let key2: [u8; 32] = rand_bytes();
    let pid = ps::b64(&[72; 16]);
    let r = call(
        &mut s.app,
        17,
        "remote.pairings.put",
        json!({ "pairingId": pid, "deviceKey": ps::b64(&key2), "kind": "phone", "peer": identity(72, "Kid"), "rights": { "request": true, "approve": false } }),
    )
    .await;
    assert_eq!(r["result"]["saved"], true, "{r}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut kid = Device::open(&s.relay, &key2).await.expect("a session");
    let q = kid.call("mimir.questions", json!({})).await;
    assert_eq!(q["e"]["code"], "forbidden", "{q}");
    let a = kid
        .call(
            "mimir.answer",
            json!({ "v": 1, "sessionId": "s_1", "askId": "a2", "choiceId": "same" }),
        )
        .await;
    assert_eq!(a["e"]["code"], "forbidden", "{a}");
    let key3: [u8; 32] = rand_bytes();
    put(&mut s.app, &key3, "agent", 73).await;
    let mut agent = Device::open(&s.relay, &key3).await.expect("a session");
    let a = agent
        .call(
            "mimir.answer",
            json!({ "v": 1, "sessionId": "s_1", "askId": "a2", "choiceId": "same" }),
        )
        .await;
    assert_eq!(a["e"]["code"], "forbidden", "{a}");
    // And no local agent reaches it through the app link.
    let r = call(
        &mut s.agent,
        18,
        "app.call",
        json!({ "method": "mimir.answer", "args": {} }),
    )
    .await;
    assert!(r["error"].is_object(), "{r}");

    // The app closes: the phone hears mimir is no longer live.
    drop(win);
    let ev = phone.event("mimir.question", |d| d["live"] == false).await;
    assert_eq!(ev["waiting"], Value::Null);
    let st = phone.call("mimir.questions", json!({})).await;
    assert_eq!(st["r"], json!({ "live": false, "waiting": null }), "{st}");
}

/// True when `dev` gets no `ev` event for `ms`; events it does get are kept for later.
async fn quiet_for(dev: &mut Device, ev: &str, ms: u64) -> bool {
    let until = tokio::time::Instant::now() + Duration::from_millis(ms);
    while tokio::time::Instant::now() < until {
        if dev.events.iter().any(|e| e["ev"] == ev) {
            return false;
        }
        let left = until - tokio::time::Instant::now();
        let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(left, dev.ws.next()).await else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["op"] != "msg" {
            continue;
        }
        if let Some(body) = v["body"].as_str()
            && let Some(SessionFrame::Data(d)) = ps::parse_frame(body)
            && let Some(plain) = dev.channel.open(&d)
        {
            let v: Value = serde_json::from_slice(&plain).unwrap();
            if v["t"] == "ev" {
                dev.events.push(v);
            }
        }
    }
    !dev.events.iter().any(|e| e["ev"] == ev)
}

/// True when the window gets no `name` event for `ms`.
async fn window_quiet(ws: &mut Ws, name: &str, ms: u64) -> bool {
    let until = tokio::time::Instant::now() + Duration::from_millis(ms);
    while tokio::time::Instant::now() < until {
        let left = until - tokio::time::Instant::now();
        let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(left, ws.next()).await else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["event"] == name {
            return false;
        }
    }
    true
}

/// The reply to `id`, waiting up to `secs` (longer than `replies`, which gives up after 3 s of silence).
async fn reply_within(dev: &mut Device, id: u64, secs: u64) -> Value {
    let until = tokio::time::Instant::now() + Duration::from_secs(secs);
    while tokio::time::Instant::now() < until {
        let left = until - tokio::time::Instant::now();
        let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(left, dev.ws.next()).await else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["op"] != "msg" {
            continue;
        }
        if let Some(body) = v["body"].as_str()
            && let Some(SessionFrame::Data(d)) = ps::parse_frame(body)
            && let Some(plain) = dev.channel.open(&d)
        {
            let v: Value = serde_json::from_slice(&plain).unwrap();
            if v["t"] == "res" && v["id"] == id {
                return v;
            }
            if v["t"] == "ev" {
                dev.events.push(v);
            }
        }
    }
    panic!("no reply to {id} in {secs} s");
}

fn audit_lines(dir: &std::path::Path, action: &str) -> Vec<Value> {
    std::fs::read_to_string(dir.join("audit.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["action"] == action)
        .collect()
}

fn answer(ask: &str, choice: Value) -> Value {
    json!({ "v": 1, "sessionId": "s_1", "askId": ask, "choiceId": choice })
}

#[tokio::test]
async fn mimir_answers_over_the_relay_are_audited_checked_and_kept_from_other_devices() {
    let dir = std::env::temp_dir().join(format!("sx-remote-mimir-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = setup_in(Some(dir.clone())).await;

    // An approver phone, a phone without the approve right and a remote agent, all connected
    // before mimir asks.
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, "phone", 81).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let key2: [u8; 32] = rand_bytes();
    let r = call(
        &mut s.app,
        20,
        "remote.pairings.put",
        json!({ "pairingId": ps::b64(&[82; 16]), "deviceKey": ps::b64(&key2), "kind": "phone", "peer": identity(82, "Kid"), "rights": { "request": true, "approve": false } }),
    )
    .await;
    assert_eq!(r["result"]["saved"], true, "{r}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut kid = Device::open(&s.relay, &key2).await.expect("a session");
    let key3: [u8; 32] = rand_bytes();
    put(&mut s.app, &key3, "agent", 83).await;
    let mut agent = Device::open(&s.relay, &key3).await.expect("a session");

    let mut win = desktop_window(&s.link).await;
    call(
        &mut win,
        21,
        "appLink.mimirState",
        json!({ "waiting": question("a1") }),
    )
    .await;
    phone
        .event("mimir.question", |d| d["waiting"]["askId"] == "a1")
        .await;
    call(
        &mut win,
        22,
        "appLink.mimirState",
        json!({ "waiting": question("a1"), "ended": { "askId": "a0", "choiceId": null, "by": "app" } }),
    )
    .await;
    assert!(
        quiet_for(&mut kid, "mimir.question", 1500).await,
        "a phone without the approve right heard the question"
    );
    assert!(
        quiet_for(&mut agent, "mimir.question", 500).await,
        "a remote agent heard the question"
    );

    // Malformed answers are refused before the app sees them.
    for bad in [
        json!({ "v": 1, "sessionId": "s".repeat(129), "askId": "a1", "choiceId": "same" }),
        json!({ "v": 1, "sessionId": "s_1", "askId": "a".repeat(201), "choiceId": "same" }),
        answer("a1", json!("")),
        answer("a1", json!(5)),
        json!({ "v": 1, "sessionId": "s_1", "askId": "a1" }),
    ] {
        let r = phone.call("mimir.answer", bad.clone()).await;
        assert_eq!(r["e"]["code"], "bad_request", "{bad} -> {r}");
    }
    let r = phone
        .call(
            "mimir.answer",
            json!({ "v": 2, "sessionId": "s_1", "askId": "a1", "choiceId": "same" }),
        )
        .await;
    assert_eq!(r["e"]["code"], "bad_request", "{r}");
    assert!(
        window_quiet(&mut win, "appLink.phoneAnswer", 300).await,
        "the app saw a malformed answer"
    );

    // The app refuses a choice it does not offer: bad_request on the phone.
    let id = phone.fire("mimir.answer", answer("a1", json!("nope"))).await;
    let asked = app_event(&mut win, "appLink.phoneAnswer", |_| true).await;
    call(&mut win, 23, "appLink.reply", json!({ "callId": asked["callId"], "ok": false, "code": "invalid_input", "message": "That is not one of the answers." })).await;
    assert_eq!(phone.replies(&[id]).await[0]["e"]["code"], "bad_request");

    // No agent or other connection can answer a phone's call for the app.
    let id = phone.fire("mimir.answer", answer("a1", json!("same"))).await;
    let asked = app_event(&mut win, "appLink.phoneAnswer", |_| true).await;
    let forged = call(
        &mut s.agent,
        24,
        "appLink.reply",
        json!({ "callId": asked["callId"], "ok": true, "value": {} }),
    )
    .await;
    assert_eq!(forged["error"]["code"], "forbidden", "{forged}");
    let other_app = call(
        &mut s.app,
        25,
        "appLink.reply",
        json!({ "callId": asked["callId"], "ok": true, "value": {} }),
    )
    .await;
    assert_eq!(other_app["error"]["code"], "not_found", "{other_app}");
    let forged = call(&mut s.agent, 26, "appLink.mimirState", json!({ "waiting": null })).await;
    assert_eq!(forged["error"]["code"], "forbidden", "{forged}");
    // The app takes it: one audit line with the device, the question and the choice.
    call(
        &mut win,
        27,
        "appLink.reply",
        json!({ "callId": asked["callId"], "ok": true, "value": {} }),
    )
    .await;
    assert_eq!(phone.replies(&[id]).await[0]["r"], json!({ "answered": true }));

    // A question the app no longer has: not_found, and no audit line.
    let id = phone.fire("mimir.answer", answer("a1", Value::Null)).await;
    let asked = app_event(&mut win, "appLink.phoneAnswer", |_| true).await;
    call(
        &mut win,
        28,
        "appLink.reply",
        json!({ "callId": asked["callId"], "ok": false, "code": "not_found", "message": "gone" }),
    )
    .await;
    assert_eq!(phone.replies(&[id]).await[0]["e"]["code"], "not_found");

    let lines = audit_lines(&dir, "mimir.answer");
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["origin"], "phone");
    assert_eq!(lines[0]["via"], "relay");
    assert_eq!(lines[0]["deviceId"], ps::b64(&[81; 16]));
    assert_eq!(lines[0]["deviceName"], "Pocket");
    assert_eq!(lines[0]["askId"], "a1");
    assert_eq!(lines[0]["sessionId"], "s_1");
    assert_eq!(lines[0]["choiceId"], "same");
    assert!(lines[0]["at"].is_string());

    // The app's limits: a question past 16 KB and an ended that is not an object leave the state as it was.
    let mut big = question("a1");
    big["question"] = json!("x".repeat(17 * 1024));
    let r = call(&mut win, 29, "appLink.mimirState", json!({ "waiting": big })).await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    let r = call(
        &mut win,
        30,
        "appLink.mimirState",
        json!({ "waiting": question("a9"), "ended": "a1" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    let r = call(
        &mut win,
        31,
        "appLink.mimirState",
        json!({ "waiting": null, "live": "yes" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    let st = phone.call("mimir.questions", json!({})).await;
    assert_eq!(st["r"]["waiting"]["askId"], "a1", "{st}");

    // A chat that goes away reads as closed, not as an answer.
    call(
        &mut win,
        32,
        "appLink.mimirState",
        json!({ "waiting": null, "live": false }),
    )
    .await;
    let ev = phone.event("mimir.question", |d| d["live"] == false).await;
    assert_eq!(ev["waiting"], Value::Null);
    assert_eq!(
        phone.call("mimir.questions", json!({})).await["r"],
        json!({ "live": false, "waiting": null })
    );
    call(
        &mut win,
        33,
        "appLink.mimirState",
        json!({ "waiting": question("a1") }),
    )
    .await;
    assert_eq!(phone.call("mimir.questions", json!({})).await["r"]["live"], true);

    // An app that never answers: timeout after 10 s.
    let id = phone.fire("mimir.answer", answer("a1", json!("same"))).await;
    app_event(&mut win, "appLink.phoneAnswer", |_| true).await;
    let r = reply_within(&mut phone, id, 20).await;
    assert_eq!(r["e"]["code"], "timeout", "{r}");

    // The window closes while an answer waits: unavailable, and phones hear nothing is live.
    let id = phone.fire("mimir.answer", answer("a1", json!("same"))).await;
    app_event(&mut win, "appLink.phoneAnswer", |_| true).await;
    drop(win);
    let r = phone.replies(&[id]).await;
    assert_eq!(r[0]["e"]["code"], "unavailable", "{r:?}");
    phone.event("mimir.question", |d| d["live"] == false).await;

    assert_eq!(
        audit_lines(&dir, "mimir.answer").len(),
        1,
        "only the answer the app took is audited"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// Partner routes: a partner desktop and its own phone trade sealed bytes through the hub.

const ACCOUNT: &str = "5b1c9a2e-7d3f-4e61-8a0b-2c4d6e8f0a1b";

/// A partner app's desktop on the hub's control socket, with its partner key.
async fn partner_desktop(s: &mut Setup, name: &str) -> Ws {
    let r = call(
        &mut s.app,
        60,
        "clients.create",
        json!({ "name": name, "role": "agent", "partner": true }),
    )
    .await;
    let key = r["result"]["clientKey"]
        .as_str()
        .unwrap_or_else(|| panic!("a key: {r}"))
        .to_owned();
    let mut ws = connect_async(format!("ws://127.0.0.1:{}/", s.link.addr().port()))
        .await
        .unwrap()
        .0;
    let p = call(&mut ws, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(p["result"]["partner"], true, "{p}");
    link_latest(s, name).await;
    ws
}

/// The person links each `app` partner phone to the newest `app` partner key in Devices (by key id).
async fn link_latest(s: &mut Setup, app: &str) {
    let clients = call(&mut s.app, 62, "clients.list", json!({})).await;
    let Some(key) = clients["result"]
        .as_array()
        .and_then(|c| c.iter().rev().find(|c| c["partner"] == true && c["name"] == app))
        .map(|c| c["id"].clone())
    else {
        return;
    };
    let list = call(&mut s.app, 63, "remote.pairings.list", json!({})).await;
    for p in list["result"].as_array().unwrap() {
        if p["partner"] == app {
            let r = call(
                &mut s.app,
                64,
                "remote.pairings.link",
                json!({ "pairingId": p["pairingId"], "clientId": key }),
            )
            .await;
            assert_eq!(r["result"]["linked"], true, "{r}");
        }
    }
}

/// Saves a partner phone for `app` and opens its session over the relay.
async fn partner_phone(s: &mut Setup, app: &str, seed: u8) -> (Device, String) {
    let key: [u8; 32] = rand_bytes();
    let pairing_id = ps::b64(&[seed; 16]);
    let r = call(
        &mut s.app,
        61,
        "remote.pairings.put",
        json!({ "pairingId": pairing_id, "deviceKey": ps::b64(&key), "kind": "partner_phone", "partner": app, "peer": identity(seed, "Chris's phone"), "rights": { "request": true, "approve": true } }),
    )
    .await;
    assert_eq!(r["result"]["saved"], true, "{r}");
    link_latest(s, app).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    // The first request proves the session, so the hub seals for it.
    let list = phone.call("partnerRoute.list", json!({})).await;
    assert_eq!(list["r"], json!([]), "{list}");
    (phone, pairing_id)
}

async fn sign_in(s: &mut Setup) {
    let token = session_token(ACCOUNT, RELAY_SECRET);
    call(&mut s.app, 62, "remote.token", json!({ "token": token })).await;
    wait_tier(&mut s.app, "account").await;
}

/// The next frame on a relay route, as the relay delivers it.
async fn on_route(ws: &mut Ws, route: &str) -> Option<Value> {
    loop {
        match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: Value = serde_json::from_str(t.as_str()).ok()?;
                if v["route"] == route {
                    return Some(v);
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return None,
        }
    }
}

/// A route the partner desktop opened, as the phone learned it.
struct Opened {
    id: String,
    id_bytes: Vec<u8>,
    up: String,
    down: String,
    /// The phone's byte channel for the route.
    chan: Channel,
}

async fn open_route(desktop: &mut Ws, phone: &mut Device, app: &str) -> Opened {
    let r = call(desktop, 70, "relay.partnerRoute.open", json!({ "app": app })).await;
    assert_eq!(r["result"]["state"], "open", "{r}");
    let id = r["result"]["routeId"].as_str().unwrap().to_owned();
    let ev = phone
        .event("partnerRoute.opened", |d| d["routeId"] == id.as_str())
        .await;
    assert_eq!(ev["app"], app);
    let (up, down) = (
        ev["up"].as_str().unwrap().to_owned(),
        ev["down"].as_str().unwrap().to_owned(),
    );
    assert!(up.starts_with("pr:") && down.starts_with("pr:"), "{ev}");
    phone
        .ws
        .send(Message::text(json!({ "op": "sub", "route": down }).to_string()))
        .await
        .unwrap();
    let id_bytes = ps::unb64(&id).unwrap();
    let chan = phone.channel.route(&id_bytes);
    Opened {
        id,
        id_bytes,
        up,
        down,
        chan,
    }
}

async fn phone_sends(phone: &mut Device, chan: &mut Channel, up: &str, bytes: &[u8]) {
    let f = serde_json::to_string(&chan.seal(bytes).unwrap()).unwrap();
    phone
        .ws
        .send(Message::text(
            json!({ "op": "send", "to": up, "body": f }).to_string(),
        ))
        .await
        .unwrap();
}

/// True when no reply to any request reaches the phone's session for `ms`.
async fn no_reply(dev: &mut Device, ms: u64) -> bool {
    let until = tokio::time::Instant::now() + Duration::from_millis(ms);
    while tokio::time::Instant::now() < until {
        let left = until - tokio::time::Instant::now();
        let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(left, dev.ws.next()).await else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if let Some(body) = v["body"].as_str()
            && let Some(SessionFrame::Data(d)) = ps::parse_frame(body)
            && let Some(plain) = dev.channel.open(&d)
            && serde_json::from_slice::<Value>(&plain).is_ok_and(|m| m["t"] == "res")
        {
            return false;
        }
    }
    true
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[tokio::test]
async fn a_partner_desktop_and_its_own_phone_trade_sealed_bytes_and_the_owner_closes_the_route() {
    let mut s = setup().await;
    sign_in(&mut s).await;
    let mut desktop = partner_desktop(&mut s, "LayerMate").await;
    let (mut phone, pairing_id) = partner_phone(&mut s, "LayerMate", 81).await;
    let mut o = open_route(&mut desktop, &mut phone, "LayerMate").await;

    // Phone to desktop: the bytes arrive as they were sent.
    let from_phone = b"\x00\x01binary from the phone\xff";
    phone_sends(&mut phone, &mut o.chan, &o.up, from_phone).await;
    let d = app_event(&mut desktop, "partnerRoute.data", |d| {
        d["routeId"] == o.id.as_str()
    })
    .await;
    assert_eq!(d["data"], b64(from_phone));

    // Desktop to phone, on the route's own relay route and byte channel.
    let from_desktop = b"reply from the desktop app";
    let r = call(
        &mut desktop,
        71,
        "relay.partnerRoute.send",
        json!({ "routeId": o.id, "data": b64(from_desktop) }),
    )
    .await;
    assert_eq!(r["result"]["sent"], from_desktop.len(), "{r}");
    let m = on_route(&mut phone.ws, &o.down).await.expect("a chunk on down");
    let Some(SessionFrame::Data(f)) = ps::parse_frame(m["body"].as_str().unwrap()) else {
        panic!("a data frame: {m}");
    };
    assert!(
        phone.channel.open(&f).is_none(),
        "the session's channel does not open a chunk"
    );
    assert_eq!(o.chan.open(&f).as_deref(), Some(&from_desktop[..]));

    // The owner and agents see sizes and times, never the relay routes or the bytes.
    let list = call(&mut s.app, 72, "relay.partnerRoute.list", json!({})).await;
    let row = &list["result"]["routes"][0];
    assert_eq!(row["routeId"], o.id.as_str(), "{list}");
    assert_eq!(row["app"], "LayerMate");
    assert_eq!(row["pairingId"], pairing_id.as_str());
    assert_eq!(row["phone"], "Chris's phone");
    assert_eq!(row["bytesIn"], from_phone.len());
    assert_eq!(row["bytesOut"], from_desktop.len());
    assert_eq!(list["result"]["caps"]["maxRoutes"], 4, "{list}");
    let text = list.to_string();
    assert!(!text.contains("pr:") && !text.contains("binary"), "{text}");
    let seen = call(&mut s.agent, 73, "relay.partnerRoute.list", json!({})).await;
    assert_eq!(seen["result"]["routes"][0]["routeId"], o.id.as_str(), "{seen}");
    // The relay's partner caps come along once the hub has asked for its quota.
    call(&mut s.app, 74, "remote.quota", json!({})).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let list = call(&mut s.app, 75, "relay.partnerRoute.list", json!({})).await;
    assert_eq!(list["result"]["caps"]["relay"]["maxRoutes"], 4, "{list}");
    assert_eq!(list["result"]["caps"]["relay"]["routes"], 1, "{list}");

    // The person who owns the hub closes it: the desktop, the phone and the relay all hear it.
    let r = call(
        &mut s.app,
        76,
        "relay.partnerRoute.close",
        json!({ "routeId": o.id }),
    )
    .await;
    assert_eq!(r["result"]["closed"], true, "{r}");
    let c = app_event(&mut desktop, "partnerRoute.closed", |d| {
        d["routeId"] == o.id.as_str()
    })
    .await;
    assert_eq!(c["reason"], "closed_by_owner");
    let m = on_route(&mut phone.ws, &o.down)
        .await
        .expect("the relay closes down");
    assert_eq!(m["op"], "partner.closed", "{m}");
    let ev = phone
        .event("partnerRoute.closed", |d| d["routeId"] == o.id.as_str())
        .await;
    assert_eq!(ev["reason"], "closed_by_owner");
    let r = call(
        &mut desktop,
        77,
        "relay.partnerRoute.send",
        json!({ "routeId": o.id, "data": b64(b"late") }),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
    let list = call(&mut s.app, 78, "relay.partnerRoute.list", json!({})).await;
    assert_eq!(list["result"]["routes"], json!([]), "{list}");
    let _ = o.id_bytes;
}

#[tokio::test]
async fn hub_methods_sent_on_a_partner_route_are_refused_and_never_reach_a_printer() {
    let mut s = setup().await;
    sign_in(&mut s).await;
    let mut desktop = partner_desktop(&mut s, "LayerMate").await;
    let (mut phone, _) = partner_phone(&mut s, "LayerMate", 82).await;
    let mut o = open_route(&mut desktop, &mut phone, "LayerMate").await;

    // A request sealed for the session and sent on the route is refused: no reply, no bytes on.
    let req = phone
        .channel
        .seal_text(&json!({ "t": "req", "id": 99, "m": "printers.list", "p": {} }).to_string())
        .unwrap();
    phone
        .ws
        .send(Message::text(
            json!({ "op": "send", "to": o.up, "body": req }).to_string(),
        ))
        .await
        .unwrap();
    // A chunk that looks like a request is only bytes: it goes to the desktop and is never run.
    let looks_like =
        json!({ "t": "req", "id": 98, "m": "print.local", "p": { "printerId": "bay-4" } }).to_string();
    phone_sends(&mut phone, &mut o.chan, &o.up, looks_like.as_bytes()).await;
    let d = app_event(&mut desktop, "partnerRoute.data", |_| true).await;
    assert_eq!(
        d["data"],
        b64(looks_like.as_bytes()),
        "only the chunk reaches the desktop"
    );
    assert!(
        no_reply(&mut phone, 500).await,
        "nothing on the route is answered as a hub method"
    );
    let list = call(&mut s.app, 80, "relay.partnerRoute.list", json!({})).await;
    assert_eq!(list["result"]["routes"][0]["refused"], 1, "{list}");
    assert_eq!(list["result"]["routes"][0]["bytesIn"], looks_like.len(), "{list}");

    // The route's methods are the partner desktop's alone, and only for itself.
    let r = call(
        &mut desktop,
        81,
        "relay.partnerRoute.open",
        json!({ "app": "OtherMate" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let r = call(
        &mut s.agent,
        82,
        "relay.partnerRoute.open",
        json!({ "app": "LayerMate" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let r = call(
        &mut s.agent,
        83,
        "relay.partnerRoute.close",
        json!({ "routeId": o.id }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    // The partner key still reaches nothing that moves a printer.
    for m in ["print.local", "start", "gcode", "remote.status", "clients.create"] {
        let r = call(&mut desktop, 84, m, json!({})).await;
        assert_eq!(r["error"]["code"], "forbidden", "{m}: {r}");
    }
    // Over the session, the phone has no way to open or feed a route.
    for m in [
        "relay.partnerRoute.open",
        "relay.partnerRoute.send",
        "partnerRoute.send",
    ] {
        let r = phone.call(m, json!({ "app": "LayerMate" })).await;
        assert_eq!(r["ok"], false, "{m}: {r}");
    }
    // An ordinary phone has no partner routes at all.
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, "phone", 83).await;
    let mut ours = Device::open(&s.relay, &key).await.expect("a session");
    let r = ours.call("partnerRoute.list", json!({})).await;
    assert_eq!(r["e"]["code"], "not_supported", "{r}");
    let _ = (o.id_bytes, o.down);
}

#[tokio::test]
async fn partner_routes_need_a_signed_in_hub_and_close_at_the_relay_cap_and_with_their_desktop() {
    let small = sx_relay::quota::PartnerLimits {
        bytes_per_route_per_day: 64,
        ..sx_relay::quota::PartnerLimits::default()
    };
    let mut s = setup_on(relay_with(small).await, None).await;
    let mut desktop = partner_desktop(&mut s, "LayerMate").await;
    let (mut phone, _) = partner_phone(&mut s, "LayerMate", 84).await;

    // An anonymous hub opens nothing: partner routes belong to an account.
    let r = call(
        &mut desktop,
        90,
        "relay.partnerRoute.open",
        json!({ "app": "LayerMate" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    assert!(
        r["error"]["message"].as_str().unwrap_or("").contains("signed-in"),
        "{r}"
    );
    let list = call(&mut s.app, 91, "relay.partnerRoute.list", json!({})).await;
    assert_eq!(list["result"]["routes"], json!([]), "{list}");

    // Past the relay's bytes for the route, it closes and the desktop hears why.
    sign_in(&mut s).await;
    let o = open_route(&mut desktop, &mut phone, "LayerMate").await;
    let r = call(
        &mut desktop,
        92,
        "relay.partnerRoute.send",
        json!({ "routeId": o.id, "data": b64(&[7u8; 100]) }),
    )
    .await;
    assert_eq!(r["result"]["sent"], 100, "the hub hands it on: {r}");
    let c = app_event(&mut desktop, "partnerRoute.closed", |d| {
        d["routeId"] == o.id.as_str()
    })
    .await;
    assert_eq!(c["reason"], "route_cap", "{c}");
    let ev = phone
        .event("partnerRoute.closed", |d| d["routeId"] == o.id.as_str())
        .await;
    assert_eq!(ev["reason"], "route_cap");

    // A route goes with the desktop connection that opened it.
    let o = open_route(&mut desktop, &mut phone, "LayerMate").await;
    drop(desktop);
    let ev = phone
        .event("partnerRoute.closed", |d| d["routeId"] == o.id.as_str())
        .await;
    assert_eq!(ev["reason"], "desktop_gone");
    let list = call(&mut s.app, 93, "relay.partnerRoute.list", json!({})).await;
    assert_eq!(list["result"]["routes"], json!([]), "{list}");

    // Unpairing the phone closes its routes too.
    let mut desktop = partner_desktop(&mut s, "LayerMate").await;
    let o = open_route(&mut desktop, &mut phone, "LayerMate").await;
    let r = call(
        &mut s.app,
        94,
        "remote.pairings.remove",
        json!({ "pairingId": ps::b64(&[84; 16]) }),
    )
    .await;
    assert_eq!(r["result"]["removed"], true, "{r}");
    let c = app_event(&mut desktop, "partnerRoute.closed", |d| {
        d["routeId"] == o.id.as_str()
    })
    .await;
    assert_eq!(c["reason"], "unpaired", "{c}");
}

// ---- remote start with a plate pass, a queued plate's start, and skipping one object from afar ----

/// What a detector answers to the plate check numbered `n` (from 1): `clear`, `compared` and maybe `box`.
type Answer = Arc<dyn Fn(usize) -> Value + Send + Sync>;

/// A detector that pairs with `code` asking for the watch role and answers every plate check it is
/// sent with `answer`. Returns how many it answered.
async fn detector_as(link: &Link, code: &str, answer: Answer) -> Arc<std::sync::atomic::AtomicUsize> {
    let mut det = connect_async(format!("ws://127.0.0.1:{}/", link.addr().port()))
        .await
        .unwrap()
        .0;
    let pp = pairing::proof_params(&mut det, code, json!({ "role": "watch" })).await;
    let r = call(&mut det, 1, "pair", pp).await;
    assert_eq!(r["result"]["role"], "watch", "{r}");
    let r = call(&mut det, 2, "watch.subscribe", json!({ "everyMs": 120_000 })).await;
    assert!(r["result"]["subscription"].is_number(), "{r}");
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = count.clone();
    tokio::spawn(async move {
        let mut id = 100;
        while let Some(Ok(m)) = det.next().await {
            let Message::Text(t) = m else { continue };
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if v["event"] != "watch.plate" {
                continue;
            }
            let d = &v["data"];
            let n = seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let mut res = answer(n);
            res["checkId"] = d["checkId"].clone();
            res["printerId"] = d["printerId"].clone();
            res["note"] = json!("test");
            id += 1;
            det.send(Message::text(
                json!({ "id": id, "method": "watch.plateResult", "params": res }).to_string(),
            ))
            .await
            .unwrap();
        }
    });
    count
}

/// The camera guard's own detector (the watch code): clear while `clear` is set, a spot otherwise,
/// each a comparison with the empty-plate picture.
async fn plate_detector(link: &Link, clear: Arc<std::sync::atomic::AtomicBool>) {
    detector_as(
        link,
        WATCH_CODE,
        Arc::new(move |_| {
            if clear.load(std::sync::atomic::Ordering::SeqCst) {
                json!({ "clear": true, "compared": true })
            } else {
                json!({ "clear": false, "compared": true, "box": [0.4, 0.6, 0.45, 0.66] })
            }
        }),
    )
    .await;
}

/// Bay 4 idle on a mock Moonraker, with its empty-plate picture taken.
async fn idle_bay4_with_plate(s: &mut Setup) -> common::Mocks {
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let r = call(&mut s.app, 10, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "bay-4", "{r}");
    for _ in 0..100 {
        let st = call(&mut s.app, 11, "status", json!({ "printerId": "bay-4" })).await;
        if st["result"]["state"] == "idle" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // A camera whose frames differ, as a real sensor's do.
    live_camera(&mocks).await;
    let r = call(
        &mut s.app,
        12,
        "watch.plateClear",
        json!({ "printerId": "bay-4" }),
    )
    .await;
    assert!(r["result"]["plateFrom"].is_string(), "{r}");
    mocks
}

async fn live_camera(mocks: &common::Mocks) {
    mocks
        .control("/camera", json!({ "mock": "moonraker", "frame": "live" }))
        .await;
}

/// A phone with the approve right, opened over the relay, and its signing key.
async fn approver(s: &mut Setup, seed: u8) -> (Device, ring::signature::Ed25519KeyPair) {
    let key: [u8; 32] = rand_bytes();
    let (signer, peer) = signing_phone(seed);
    put_peer(&mut s.app, &key, "phone", seed, peer).await;
    (Device::open(&s.relay, &key).await.expect("a session"), signer)
}

fn gcode_file(name: &str, text: &str) -> (Value, String) {
    let data = text.as_bytes();
    let sha = hex(ring::digest::digest(&ring::digest::SHA256, data).as_ref());
    (
        json!({ "name": name, "kind": "gcode", "sha256": sha, "dataBase64": base64::engine::general_purpose::STANDARD.encode(data) }),
        sha,
    )
}

/// An agent's print card for `file` on bay 4, with its work.
fn print_card(id: &str, file: &Value, sha: &str) -> Value {
    let h = sx_permit::hash_params;
    let name = file["name"].as_str().unwrap();
    json!({
        "request": agent_card(id, "printer.queue", json!([
            { "action": "printer.upload", "target": "bay-4", "paramsHash": h(&json!({ "printerId": "bay-4", "name": name, "sha256": sha })) },
            { "action": "printer.start", "target": "bay-4", "paramsHash": h(&json!({ "printerId": "bay-4", "name": name, "opts": {}, "sha256": sha })) },
        ])),
        "work": { "kind": "print", "printerId": "bay-4", "file": file },
    })
}

#[tokio::test]
async fn b4_a_phone_starts_a_print_from_afar_only_on_an_opted_in_printer_after_a_plate_pass() {
    let mut s = setup().await;
    let mocks = idle_bay4_with_plate(&mut s).await;
    let clear = Arc::new(std::sync::atomic::AtomicBool::new(true));
    plate_detector(&s.link, clear.clone()).await;
    let key: [u8; 32] = rand_bytes();
    let (signer, peer) = signing_phone(81);
    put_peer(&mut s.app, &key, "phone", 81, peer).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let info = phone.call("host.info", json!({})).await;
    assert_eq!(info["r"]["remoteStart"], true, "{info}");

    let (f, sha) = gcode_file("cube.gcode", "M140 S60\nM104 S210\nG28\nG1 X10 Y10\n");
    let r = call(
        &mut s.agent,
        20,
        "approvals.register",
        print_card("rs-1", &f, &sha),
    )
    .await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let view = phone
        .event("approval.request", |d| d["request"]["id"] == "rs-1")
        .await;
    // Off by default: the card says so, and neither the plate check nor the approval goes through.
    assert_eq!(view["remoteStart"]["enabled"], false, "{view}");
    assert_eq!(view["remoteStart"]["reason"], "off", "{view}");
    let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["e"]["code"], "forbidden", "{r}");
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &view["request"], "approve", true),
        )
        .await;
    assert_eq!(
        r["e"]["code"], "not_supported",
        "an opted-out printer refuses: {r}"
    );

    // The setting is the person's: an agent reads it and cannot change it.
    let r = call(
        &mut s.agent,
        21,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let r = call(
        &mut s.app,
        22,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true, "maxNozzleC": 400 }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    let r = call(
        &mut s.app,
        23,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    assert_eq!(r["result"]["enabled"], true, "{r}");
    assert_eq!(r["result"]["maxNozzleC"], 240, "{r}");
    let r = call(&mut s.agent, 24, "remoteStart.get", json!({})).await;
    assert_eq!(r["result"]["printers"][0]["enabled"], true, "{r}");
    assert_eq!(r["result"]["plateWindowSeconds"], 60, "{r}");

    // On, but no plate check yet: refused.
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &view["request"], "approve", true),
        )
        .await;
    assert_eq!(r["e"]["code"], "forbidden", "a missing plate check refuses: {r}");

    // Something on the plate: the check fails and so does the start.
    clear.store(false, std::sync::atomic::Ordering::SeqCst);
    let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["r"]["passes"], false, "{r}");
    assert_eq!(r["r"]["reason"], "plate_failed", "{r}");
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &view["request"], "approve", true),
        )
        .await;
    assert_eq!(r["e"]["code"], "forbidden", "a failed plate check refuses: {r}");

    // A clear plate: the card shows the still beside the empty-plate picture.
    clear.store(true, std::sync::atomic::Ordering::SeqCst);
    let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["r"]["passes"], true, "{r}");
    assert_eq!(r["r"]["compared"], true, "{r}");
    assert!(r["r"]["still"]["dataB64"].is_string(), "{r}");
    assert!(r["r"]["reference"]["dataB64"].is_string(), "{r}");
    assert!(
        r["r"]["passUntil"].as_u64().unwrap() > r["r"]["checkedAt"].as_u64().unwrap(),
        "{r}"
    );
    // The person still says the plate is clear, signed with the decision.
    let r = phone
        .call(
            "approvals.decide",
            signed_decision(&signer, &view["request"], "approve"),
        )
        .await;
    assert_eq!(r["e"]["code"], "forbidden", "{r}");
    assert!(
        !mock_log(&mocks)
            .await
            .iter()
            .any(|l| l.starts_with("upload") || l.starts_with("start ")),
        "nothing ran yet"
    );

    // A file that heats past the limit, or a chamber, waits for someone at the printer.
    let (hot, hot_sha) = gcode_file("hot.gcode", "M104 S260\nM140 S60\n");
    call(
        &mut s.agent,
        25,
        "approvals.register",
        print_card("rs-hot", &hot, &hot_sha),
    )
    .await;
    let hv = phone
        .event("approval.request", |d| d["request"]["id"] == "rs-hot")
        .await;
    assert_eq!(hv["remoteStart"]["reason"], "too_hot", "{hv}");
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &hv["request"], "approve", true),
        )
        .await;
    assert_eq!(r["e"]["code"], "not_supported", "{r}");

    // Everything holds: the hub uploads and starts it.
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &view["request"], "approve", true),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let mut ran = false;
    for _ in 0..60 {
        let log = mock_log(&mocks).await;
        if log.iter().any(|l| l.starts_with("start ")) {
            ran = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(ran, "{:?}", mock_log(&mocks).await);
}

#[tokio::test]
async fn b5_a_queued_plate_asked_for_by_an_agent_starts_from_afar_under_the_same_rule() {
    let mut s = setup().await;
    let mocks = idle_bay4_with_plate(&mut s).await;
    let clear = Arc::new(std::sync::atomic::AtomicBool::new(true));
    plate_detector(&s.link, clear.clone()).await;
    let key: [u8; 32] = rand_bytes();
    let (signer, peer) = signing_phone(82);
    put_peer(&mut s.app, &key, "phone", 82, peer).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");

    let (f, _) = gcode_file("plate.gcode", "M140 S55\nM104 S215\nG28\n");
    let q = call(
        &mut s.app,
        30,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f, "title": "Plate 2" }),
    )
    .await;
    let item = q["result"]["item"]["id"].as_str().unwrap().to_owned();
    // An agent reads the queue and asks for the plate's card; it never answers it.
    let list = call(&mut s.agent, 31, "queue.list", json!({})).await;
    assert_eq!(list["result"][0]["id"], item.as_str(), "{list}");
    let r = call(&mut s.agent, 32, "queue.start", json!({ "itemId": item })).await;
    let request = r["result"]["request"].clone();
    assert_eq!(request["actions"][0]["action"], "printer.start", "{r}");
    let r2 = call(&mut s.agent, 33, "queue.start", json!({ "itemId": item })).await;
    assert_eq!(
        r2["result"]["request"]["id"], request["id"],
        "the waiting card comes back: {r2}"
    );
    let g = call(
        &mut s.agent,
        34,
        "approvals.grant",
        json!({ "requestId": request["id"], "bedClear": true }),
    )
    .await;
    assert_eq!(g["error"]["code"], "forbidden", "{g}");
    let r = call(&mut s.agent, 35, "queue.start", json!({ "itemId": "q-nope" })).await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");

    // Off by default; then on, with a passing plate check, the phone starts it.
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &request, "approve", true),
        )
        .await;
    assert_eq!(r["e"]["code"], "not_supported", "{r}");
    call(
        &mut s.app,
        36,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["r"]["passes"], true, "{r}");
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &request, "approve", true),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let mut started = false;
    for _ in 0..60 {
        let l = call(&mut s.app, 37, "queue.list", json!({})).await;
        if l["result"][0]["state"] == "started" {
            started = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(started, "{:?}", mock_log(&mocks).await);
    assert!(mock_log(&mocks).await.iter().any(|l| l.starts_with("start ")));
}

#[tokio::test]
async fn b7_a_phone_approves_skipping_one_object_from_afar() {
    let mut s = setup().await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    call(&mut s.app, 10, "printers.add", json!({ "config": cfg })).await;
    let (f, _) = gcode_file("plate.gcode", "M104 S210\nG28\n");
    let r = call(
        &mut s.app,
        11,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["started"], true, "{r}");
    let key: [u8; 32] = rand_bytes();
    let (signer, peer) = signing_phone(83);
    put_peer(&mut s.app, &key, "phone", 83, peer).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");

    let id = "lid.stl_id_0_copy_0";
    // The skip names the print running now by its bed epoch, read from the hub, and hashes it.
    let epoch = call(&mut s.agent, 14, "bed.state", json!({ "printerId": "bay-4" })).await["result"]["epoch"]
        .as_u64()
        .unwrap();
    let skip_card = |card: &str, e: Value| {
        let actions = json!([{ "action": "printer.skip", "target": "bay-4", "paramsHash": sx_permit::hash_params(&json!({ "printerId": "bay-4", "id": id, "epoch": e })) }]);
        json!({ "request": agent_card(card, "print.adjust", actions), "work": { "kind": "skip", "printerId": "bay-4", "id": id, "epoch": e } })
    };
    let missing = call(
        &mut s.agent,
        15,
        "approvals.register",
        json!({ "request": agent_card("sk-0", "print.adjust", json!([{ "action": "printer.skip", "target": "bay-4", "paramsHash": sx_permit::hash_params(&json!({ "printerId": "bay-4", "id": id })) }])), "work": { "kind": "skip", "printerId": "bay-4", "id": id } }),
    )
    .await;
    assert_eq!(
        missing["error"]["code"], "bad_request",
        "a skip without its print: {missing}"
    );
    let earlier = call(
        &mut s.agent,
        16,
        "approvals.register",
        skip_card("sk-old", json!(epoch + 1)),
    )
    .await;
    assert_eq!(earlier["error"]["code"], "job_changed", "{earlier}");
    let r = call(
        &mut s.agent,
        12,
        "approvals.register",
        skip_card("sk-1", json!(epoch)),
    )
    .await;
    assert_eq!(r["result"]["answeredIn"], "app", "{r}");
    // The agent that asked cannot answer it.
    let g = call(
        &mut s.agent,
        13,
        "approvals.grant",
        json!({ "requestId": "sk-1" }),
    )
    .await;
    assert_eq!(g["error"]["code"], "forbidden", "{g}");
    let view = phone
        .event("approval.request", |d| d["request"]["id"] == "sk-1")
        .await;
    // Under its own key, so a phone that predates it lists the card without an Approve.
    assert!(view.get("work").is_none(), "{view}");
    assert_eq!(view["objectWork"]["kind"], "skip", "{view}");
    assert_eq!(view["objectWork"]["id"], id, "{view}");
    assert!(
        view["objectWork"]["epoch"].is_u64(),
        "the hub pinned the job: {view}"
    );
    // It only stops extrusion for one object, so no plate check or remote start setting is needed.
    let r = phone
        .call(
            "approvals.decide",
            signed_decision(&signer, &view["request"], "approve"),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let want = format!("gcode EXCLUDE_OBJECT NAME={id}");
    let mut skipped = false;
    for _ in 0..60 {
        if mock_log(&mocks).await.contains(&want) {
            skipped = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(skipped, "{:?}", mock_log(&mocks).await);
}

#[tokio::test]
async fn r1_an_agent_paired_as_a_detector_cannot_pass_a_plate_check() {
    let mut s = setup().await;
    let _mocks = idle_bay4_with_plate(&mut s).await;
    call(
        &mut s.app,
        20,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    // The agent code, narrowed to the watch role, says every plate is clear and compared.
    let answered = detector_as(
        &s.link,
        AGENT_CODE,
        Arc::new(|_| json!({ "clear": true, "compared": true })),
    )
    .await;
    let (mut phone, _) = approver(&mut s, 84).await;
    let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["r"]["passes"], false, "an agent's answer passes nothing: {r}");
    assert_eq!(
        answered.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "an agent never gets the plate pictures"
    );
}

#[tokio::test]
async fn r1_a_detector_that_did_not_compare_never_passes() {
    let mut s = setup().await;
    let _mocks = idle_bay4_with_plate(&mut s).await;
    call(
        &mut s.app,
        20,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    // A clear verdict that does not say it compared with the empty-plate picture.
    detector_as(&s.link, WATCH_CODE, Arc::new(|_| json!({ "clear": true }))).await;
    let (mut phone, _) = approver(&mut s, 85).await;
    let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["r"]["passes"], false, "{r}");
    assert_eq!(r["r"]["reason"], "plate_not_compared", "{r}");
}

#[tokio::test]
async fn r3_a_remote_start_checks_the_plate_again_right_before_it_starts() {
    let mut s = setup().await;
    let mocks = idle_bay4_with_plate(&mut s).await;
    call(
        &mut s.app,
        20,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    // Clear for the person's look and the check at approval; the check right before the start
    // cannot tell.
    detector_as(
        &s.link,
        WATCH_CODE,
        Arc::new(|n| {
            if n <= 2 {
                json!({ "clear": true, "compared": true })
            } else {
                json!({ "clear": null, "compared": true })
            }
        }),
    )
    .await;
    let (mut phone, signer) = approver(&mut s, 86).await;
    let (f, sha) = gcode_file("cube.gcode", "M140 S60\nM104 S210\nG28\n");
    let r = call(
        &mut s.agent,
        21,
        "approvals.register",
        print_card("r3-1", &f, &sha),
    )
    .await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let view = phone
        .event("approval.request", |d| d["request"]["id"] == "r3-1")
        .await;
    let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["r"]["passes"], true, "{r}");
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &view["request"], "approve", true),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let done = app_event(&mut s.app, "approval.done", |d| d["requestId"] == "r3-1").await;
    assert_eq!(done["ok"], false, "{done}");
    assert!(
        !mock_log(&mocks).await.iter().any(|l| l.starts_with("start ")),
        "nothing started: {:?}",
        mock_log(&mocks).await
    );
}

#[tokio::test]
async fn r4_a_frozen_camera_never_passes_a_plate_check() {
    let mut s = setup().await;
    let mocks = idle_bay4_with_plate(&mut s).await;
    call(
        &mut s.app,
        20,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    let clear = Arc::new(std::sync::atomic::AtomicBool::new(true));
    plate_detector(&s.link, clear).await;
    // The feed freezes on one frame: every still is the same bytes.
    mocks
        .control("/camera", json!({ "mock": "moonraker", "frame": "placeholder" }))
        .await;
    let (mut phone, _) = approver(&mut s, 87).await;
    let first = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    let again = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(again["r"]["passes"], false, "{first} {again}");
    assert_eq!(again["r"]["reason"], "plate_frozen", "{again}");
}

#[tokio::test]
async fn r6_removing_a_printer_forgets_its_remote_start_and_empty_plate() {
    let mut s = setup().await;
    let mocks = idle_bay4_with_plate(&mut s).await;
    call(
        &mut s.app,
        20,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    let r = call(&mut s.app, 21, "printers.remove", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"]["removed"], true, "{r}");
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    call(&mut s.app, 22, "printers.add", json!({ "config": cfg })).await;
    let r = call(&mut s.app, 23, "remoteStart.get", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"]["printers"][0]["enabled"], false, "{r}");
    let g = call(&mut s.app, 24, "watch.guardState", json!({})).await;
    assert!(g["result"]["plates"].get("bay-4").is_none(), "{g}");
}

#[tokio::test]
async fn r7_r8_an_agent_reads_the_queue_redacted_and_a_declined_card_keeps_the_plate() {
    let mut s = setup().await;
    let mocks = idle_bay4_with_plate(&mut s).await;
    let (f, _) = gcode_file("plate.gcode", "M140 S55\nM104 S215\nG28\n");
    let q = call(
        &mut s.app,
        30,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f, "title": "Plate 2" }),
    )
    .await;
    let item = q["result"]["item"]["id"].as_str().unwrap().to_owned();
    // R8: no file hash, options, card or approval for an agent.
    let list = call(&mut s.agent, 31, "queue.list", json!({})).await;
    let row = list["result"][0].clone();
    assert_eq!(row["id"], item.as_str(), "{list}");
    assert_eq!(row["name"], "Plate 2", "{row}");
    for k in ["sha256", "opts", "requestId", "approval", "bytes"] {
        assert!(row.get(k).is_none(), "{k}: {row}");
    }
    // A partner app sees only plates it queued, and none were.
    let made = call(
        &mut s.app,
        32,
        "clients.create",
        json!({ "name": "LayerMate", "role": "agent", "partner": true }),
    )
    .await;
    let key = made["result"]["clientKey"].as_str().unwrap().to_owned();
    let mut partner = connect_async(format!("ws://127.0.0.1:{}/", s.link.addr().port()))
        .await
        .unwrap()
        .0;
    let r = call(&mut partner, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(r["result"]["partner"], true, "{r}");
    assert_eq!(
        call(&mut partner, 2, "queue.list", json!({})).await["result"],
        json!([])
    );
    let r = call(&mut partner, 3, "queue.start", json!({ "itemId": item })).await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
    // R7: the agent's card says it asked; declining that card leaves the plate in the queue.
    let r = call(&mut s.agent, 33, "queue.start", json!({ "itemId": item })).await;
    let request = r["result"]["request"].clone();
    assert!(
        request["lines"].as_array().unwrap().iter().any(|l| l
            .as_str()
            .is_some_and(|l| l.starts_with("Asked by") && l.contains("agent"))),
        "{request}"
    );
    let (mut phone, signer) = approver(&mut s, 88).await;
    let r = phone
        .call("approvals.decide", signed_decision(&signer, &request, "deny"))
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let l = call(&mut s.app, 34, "queue.list", json!({})).await;
    let st = l["result"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == item.as_str())
        .unwrap()["state"]
        .clone();
    assert_ne!(st, "canceled", "{l}");
    drop(mocks);
}

#[tokio::test]
async fn r10_a_remote_approval_audits_both_plate_checks() {
    let dir = std::env::temp_dir().join(format!("sx-r10-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = setup_in(Some(dir.clone())).await;
    let mocks = idle_bay4_with_plate(&mut s).await;
    call(
        &mut s.app,
        20,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    plate_detector(&s.link, Arc::new(std::sync::atomic::AtomicBool::new(true))).await;
    let (mut phone, signer) = approver(&mut s, 89).await;
    let (f, sha) = gcode_file("cube.gcode", "M140 S60\nM104 S210\nG28\n");
    call(
        &mut s.agent,
        21,
        "approvals.register",
        print_card("r10-1", &f, &sha),
    )
    .await;
    let view = phone
        .event("approval.request", |d| d["request"]["id"] == "r10-1")
        .await;
    phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &view["request"], "approve", true),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let lines = audit_lines(&dir, "approvals.decide");
    let checks = &lines.last().unwrap()["plateChecks"];
    for which in ["seen", "atApproval"] {
        let c = &checks[which];
        assert_eq!(c["sha256"].as_str().map(str::len), Some(64), "{which}: {checks}");
        assert_eq!(
            (c["clear"].clone(), c["compared"].clone()),
            (json!(true), json!(true)),
            "{which}: {checks}"
        );
        assert!(c["takenAt"].is_string(), "{which}: {checks}");
    }
    drop(mocks);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn r11_remote_start_limits_stay_within_the_printer_catalog() {
    let mut s = setup().await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let cfg = json!({ "id": "mini", "name": "Mini", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let r = call(
        &mut s.app,
        10,
        "printers.add",
        json!({ "config": cfg, "info": { "vendor": "Bambu Lab", "model": "A1 mini" } }),
    )
    .await;
    assert_eq!(r["result"]["id"], "mini", "{r}");
    let r = call(
        &mut s.app,
        11,
        "remoteStart.set",
        json!({ "printerId": "mini", "enabled": true, "maxBedC": 100 }),
    )
    .await;
    assert_eq!(
        r["error"]["code"], "bad_request",
        "the A1 mini's bed tops out at 80 °C: {r}"
    );
    let r = call(
        &mut s.app,
        12,
        "remoteStart.set",
        json!({ "printerId": "mini", "enabled": true }),
    )
    .await;
    assert_eq!(r["result"]["catalogMaxBedC"], 80, "{r}");
    assert_eq!(r["result"]["catalogMaxNozzleC"], 300, "{r}");
    assert_eq!(r["result"]["maxBedC"], 80, "{r}");
}

#[tokio::test]
async fn s1_the_detector_code_is_never_written_where_an_agent_can_read_it() {
    let dir = std::env::temp_dir().join(format!("sx-s1-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // A file left by an older hub goes too.
    std::fs::write(dir.join("watch-code"), "OLDC-ODE1\n").unwrap();
    let _s = setup_in(Some(dir.clone())).await;
    assert!(!dir.join("watch-code").exists(), "no watch-code file");
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            let text = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned();
            assert!(
                !text.contains(WATCH_CODE),
                "{} holds the detector code",
                path.display()
            );
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn s2_a_queued_plate_from_afar_is_checked_after_its_upload_right_before_the_start() {
    let mut s = setup().await;
    let mocks = idle_bay4_with_plate(&mut s).await;
    call(
        &mut s.app,
        20,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    // Clear for the person's look and the check at approval; every later check cannot tell.
    detector_as(
        &s.link,
        WATCH_CODE,
        Arc::new(|n| {
            if n <= 2 {
                json!({ "clear": true, "compared": true })
            } else {
                json!({ "clear": null, "compared": true })
            }
        }),
    )
    .await;
    let (mut phone, signer) = approver(&mut s, 90).await;
    let (f, _) = gcode_file("plate.gcode", "M140 S55\nM104 S215\nG28\n");
    let q = call(
        &mut s.app,
        30,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f, "title": "Plate 2" }),
    )
    .await;
    let item = q["result"]["item"]["id"].as_str().unwrap().to_owned();
    let r = call(&mut s.agent, 31, "queue.start", json!({ "itemId": item })).await;
    let request = r["result"]["request"].clone();
    let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["r"]["passes"], true, "{r}");
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &request, "approve", true),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let mut failed = false;
    for _ in 0..60 {
        let l = call(&mut s.app, 32, "queue.list", json!({})).await;
        if l["result"][0]["state"] == "failed" {
            failed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let log = mock_log(&mocks).await;
    assert!(failed, "{log:?}");
    assert!(
        log.iter().any(|l| l.starts_with("upload")),
        "the check comes after the upload: {log:?}"
    );
    assert!(!log.iter().any(|l| l.starts_with("start ")), "{log:?}");
}

#[tokio::test]
async fn s4_an_unknown_model_keeps_the_default_limits_as_its_cap() {
    let mut s = setup().await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let cfg = json!({ "id": "odd", "name": "Odd", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    call(
        &mut s.app,
        10,
        "printers.add",
        json!({ "config": cfg, "info": { "vendor": "Nobody", "model": "Mystery 9" } }),
    )
    .await;
    let r = call(
        &mut s.app,
        11,
        "remoteStart.set",
        json!({ "printerId": "odd", "enabled": true, "maxNozzleC": 260 }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    // A model name alone never matches another vendor's catalog entry.
    let cfg = json!({ "id": "fake", "name": "Fake", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    call(
        &mut s.app,
        12,
        "printers.add",
        json!({ "config": cfg, "info": { "vendor": "", "model": "X1 Carbon" } }),
    )
    .await;
    let r = call(
        &mut s.app,
        13,
        "remoteStart.set",
        json!({ "printerId": "fake", "enabled": true }),
    )
    .await;
    assert_eq!(r["result"]["catalogMaxNozzleC"], Value::Null, "{r}");
}

#[tokio::test]
async fn t1_the_app_code_narrowed_to_watch_is_not_the_cameras_detector() {
    let mut s = setup().await;
    let _mocks = idle_bay4_with_plate(&mut s).await;
    call(
        &mut s.app,
        20,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    // A headless hub may keep the app code in a file; pairing with it as a detector earns no trust.
    let answered = detector_as(
        &s.link,
        CODE,
        Arc::new(|_| json!({ "clear": true, "compared": true })),
    )
    .await;
    let (mut phone, _) = approver(&mut s, 92).await;
    let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["r"]["passes"], false, "{r}");
    assert_eq!(
        answered.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "no plate pictures for it"
    );
    // A detector key the person made in the app is trusted.
    let made = call(
        &mut s.app,
        21,
        "clients.create",
        json!({ "name": "Detector", "role": "watch" }),
    )
    .await;
    let key = made["result"]["clientKey"].as_str().unwrap().to_owned();
    let mut det = connect_async(format!("ws://127.0.0.1:{}/", s.link.addr().port()))
        .await
        .unwrap()
        .0;
    let r = call(&mut det, 1, "pair", json!({ "clientKey": key, "role": "watch" })).await;
    assert_eq!(r["result"]["role"], "watch", "{r}");
    let r = call(
        &mut det,
        2,
        "watch.plateResult",
        json!({ "checkId": "none", "printerId": "bay-4", "clear": true }),
    )
    .await;
    assert_eq!(r["result"]["recorded"], true, "{r}");
}

#[tokio::test]
async fn h1_a_numbered_line_heating_past_the_limit_refuses_a_start_from_afar() {
    let mut s = setup().await;
    let _mocks = idle_bay4_with_plate(&mut s).await;
    call(
        &mut s.app,
        20,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    let (mut phone, signer) = approver(&mut s, 93).await;
    // Line numbers with a space after N, as some hosts send them: the 300 °C line still counts.
    let (f, sha) = gcode_file("cube.gcode", "M140 S60\nM104 S215\nN 10 M104 S300\nG28\n");
    let r = call(
        &mut s.agent,
        21,
        "approvals.register",
        print_card("h1-1", &f, &sha),
    )
    .await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let view = phone
        .event("approval.request", |d| d["request"]["id"] == "h1-1")
        .await;
    assert_eq!(view["remoteStart"]["enabled"], false, "{view}");
    assert_eq!(view["remoteStart"]["reason"], "too_hot", "{view}");
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &view["request"], "approve", true),
        )
        .await;
    assert_eq!(r["e"]["code"], "not_supported", "{r}");
}

#[tokio::test]
async fn a_partner_key_opens_routes_only_to_the_phone_the_person_linked_never_by_name() {
    let mut s = setup().await;
    sign_in(&mut s).await;
    // A phone that paired under the same name, but nobody linked it to this key.
    let key: [u8; 32] = rand_bytes();
    let pairing_id = ps::b64(&[86; 16]);
    let r = call(
        &mut s.app,
        95,
        "remote.pairings.put",
        json!({ "pairingId": pairing_id, "deviceKey": ps::b64(&key), "kind": "phone", "partner": "Example Phone", "peer": identity(86, "Pixel 8"), "rights": { "request": true, "approve": false } }),
    )
    .await;
    assert_eq!(r["result"]["saved"], true, "{r}");
    let created = call(
        &mut s.app,
        96,
        "clients.create",
        json!({ "name": "Example Phone", "role": "agent", "partner": true }),
    )
    .await;
    let key_id = created["result"]["clientId"].clone();
    let client_key = created["result"]["clientKey"].as_str().unwrap().to_owned();
    let mut desktop = connect_async(format!("ws://127.0.0.1:{}/", s.link.addr().port()))
        .await
        .unwrap()
        .0;
    let p = call(&mut desktop, 1, "pair", json!({ "clientKey": client_key })).await;
    assert_eq!(p["result"]["partner"], true, "{p}");
    let r = call(
        &mut desktop,
        97,
        "relay.partnerRoute.open",
        json!({ "app": "Example Phone" }),
    )
    .await;
    assert_eq!(
        r["error"]["code"], "not_found",
        "a matching name is not a link: {r}"
    );

    // Linked by the person in Devices: now it opens.
    let r = call(
        &mut s.app,
        98,
        "remote.pairings.link",
        json!({ "pairingId": pairing_id, "clientId": key_id }),
    )
    .await;
    assert_eq!(r["result"]["linked"], true, "{r}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let list = phone.call("partnerRoute.list", json!({})).await;
    assert_eq!(list["r"], json!([]), "{list}");
    let o = open_route(&mut desktop, &mut phone, "Example Phone").await;

    // Unlinked: its routes close, and it cannot open again. Only partner keys can be linked.
    let bad = call(
        &mut s.app,
        99,
        "remote.pairings.link",
        json!({ "pairingId": pairing_id, "clientId": "client-nope" }),
    )
    .await;
    assert_eq!(bad["error"]["code"], "not_found", "{bad}");
    let r = call(
        &mut s.app,
        100,
        "remote.pairings.link",
        json!({ "pairingId": pairing_id, "clientId": null }),
    )
    .await;
    assert_eq!(r["result"]["linked"], true, "{r}");
    let c = app_event(&mut desktop, "partnerRoute.closed", |d| {
        d["routeId"] == o.id.as_str()
    })
    .await;
    assert_eq!(c["reason"], "unpaired", "{c}");
    let r = call(
        &mut desktop,
        101,
        "relay.partnerRoute.open",
        json!({ "app": "Example Phone" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");

    // A key whose name is not the phone's needs the person's explicit yes in Devices.
    let other = call(
        &mut s.app,
        104,
        "clients.create",
        json!({ "name": "OtherApp", "role": "agent", "partner": true }),
    )
    .await;
    let other_id = other["result"]["clientId"].clone();
    let r = call(
        &mut s.app,
        105,
        "remote.pairings.link",
        json!({ "pairingId": pairing_id, "clientId": other_id }),
    )
    .await;
    assert_eq!(r["error"]["code"], "mismatch", "{r}");
    let r = call(
        &mut s.app,
        106,
        "remote.pairings.link",
        json!({ "pairingId": pairing_id, "clientId": other_id, "mismatchOk": true }),
    )
    .await;
    assert_eq!(r["result"]["linked"], true, "{r}");
    let r = call(
        &mut s.app,
        107,
        "remote.pairings.link",
        json!({ "pairingId": pairing_id, "clientId": null }),
    )
    .await;
    assert_eq!(r["result"]["linked"], true, "{r}");

    // A look-alike key name is refused; the same name again is fine.
    let r = call(
        &mut s.app,
        102,
        "clients.create",
        json!({ "name": "example phone", "role": "agent", "partner": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "conflict", "{r}");
    let r = call(
        &mut s.app,
        103,
        "clients.create",
        json!({ "name": "Example Phone", "role": "agent", "partner": true }),
    )
    .await;
    assert!(r["result"]["clientKey"].is_string(), "{r}");
}

// ---- partner phones: our phone's rights from afar, never on their own app's cards ----

/// A partner phone named `partner` with the approve right, opened over the relay, its signing key and
/// its pairing id.
async fn partner_approver(
    s: &mut Setup,
    seed: u8,
    partner: &str,
) -> (Device, ring::signature::Ed25519KeyPair, String) {
    let key: [u8; 32] = rand_bytes();
    let (signer, peer) = signing_phone(seed);
    let pairing_id = ps::b64(&[seed; 16]);
    let r = call(
        &mut s.app,
        3,
        "remote.pairings.put",
        json!({ "pairingId": pairing_id, "deviceKey": ps::b64(&key), "kind": "phone", "peer": peer, "partner": partner, "rights": { "request": true, "approve": true } }),
    )
    .await;
    assert_eq!(r["result"]["saved"], true, "{r}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    (
        Device::open(&s.relay, &key).await.expect("a session"),
        signer,
        pairing_id,
    )
}

/// A partner app key named `name`, connected to the hub, and its client id.
async fn partner_key(s: &mut Setup, name: &str) -> (Ws, Value) {
    let made = call(
        &mut s.app,
        90,
        "clients.create",
        json!({ "name": name, "role": "agent", "partner": true }),
    )
    .await;
    let key = made["result"]["clientKey"].as_str().unwrap().to_owned();
    let mut ws = connect_async(format!("ws://127.0.0.1:{}/", s.link.addr().port()))
        .await
        .unwrap()
        .0;
    let r = call(&mut ws, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(r["result"]["partner"], true, "{r}");
    (ws, made["result"]["clientId"].clone())
}

#[tokio::test]
async fn a_partner_phone_approves_a_skip_from_afar_but_never_one_a_partner_app_asked_for() {
    let mut s = setup().await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    call(&mut s.app, 10, "printers.add", json!({ "config": cfg })).await;
    let (f, _) = gcode_file("plate.gcode", "M104 S210\nG28\n");
    let r = call(
        &mut s.app,
        11,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["started"], true, "{r}");
    let (mut phone, signer, _) = partner_approver(&mut s, 87, "Example Phone").await;
    // Partner keys: one under the phone's own name, and one of another app the phone was never linked to.
    let (mut same_name, _) = partner_key(&mut s, "Example Phone").await;
    let (mut other_app, _) = partner_key(&mut s, "Other App").await;

    let epoch =
        call(&mut s.agent, 14, "bed.state", json!({ "printerId": "bay-4" })).await["result"]["epoch"].clone();
    let skip = |card: &str, id: &str| {
        let actions = json!([{ "action": "printer.skip", "target": "bay-4", "paramsHash": sx_permit::hash_params(&json!({ "printerId": "bay-4", "id": id, "epoch": epoch })) }]);
        json!({ "request": agent_card(card, "print.adjust", actions), "work": { "kind": "skip", "printerId": "bay-4", "id": id, "epoch": epoch } })
    };

    // (c) Any partner app asked, whatever its name: refused.
    for (ws, card, obj) in [
        (&mut same_name, "pk-same", "a.stl_id_1_copy_0"),
        (&mut other_app, "pk-other", "b.stl_id_2_copy_0"),
    ] {
        let r = call(ws, 12, "approvals.register", skip(card, obj)).await;
        assert!(r.get("result").is_some(), "{card}: {r}");
        let view = phone
            .event("approval.request", |d| d["request"]["id"] == card)
            .await;
        let r = phone
            .call(
                "approvals.decide",
                signed_decision(&signer, &view["request"], "approve"),
            )
            .await;
        assert_eq!(
            r["e"]["code"], "forbidden",
            "{card}: a partner app's skip was approved: {r}"
        );
        // It may still deny it.
        let r = phone
            .call(
                "approvals.decide",
                signed_decision(&signer, &view["request"], "deny"),
            )
            .await;
        assert_eq!(r["ok"], true, "{card}: {r}");
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !mock_log(&mocks)
            .await
            .iter()
            .any(|l| l.contains("EXCLUDE_OBJECT")),
        "a skip a partner app asked for ran"
    );

    // (a) A skip the person's own client asked for: approved from afar, as on our phone.
    let id = "lid.stl_id_0_copy_0";
    let r = call(&mut s.agent, 13, "approvals.register", skip("pk-ours", id)).await;
    assert_eq!(r["result"]["answeredIn"], "app", "{r}");
    let view = phone
        .event("approval.request", |d| d["request"]["id"] == "pk-ours")
        .await;
    let r = phone
        .call(
            "approvals.decide",
            signed_decision(&signer, &view["request"], "approve"),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let want = format!("gcode EXCLUDE_OBJECT NAME={id}");
    let mut skipped = false;
    for _ in 0..60 {
        if mock_log(&mocks).await.contains(&want) {
            skipped = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(skipped, "{:?}", mock_log(&mocks).await);
}

#[tokio::test]
async fn a_partner_phone_starts_from_afar_after_a_plate_pass_but_never_a_partner_apps_print() {
    let mut s = setup().await;
    let mocks = idle_bay4_with_plate(&mut s).await;
    let clear = Arc::new(std::sync::atomic::AtomicBool::new(true));
    plate_detector(&s.link, clear.clone()).await;
    let r = call(
        &mut s.app,
        23,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    assert_eq!(r["result"]["enabled"], true, "{r}");
    let (mut phone, signer, _) = partner_approver(&mut s, 88, "Example Phone").await;
    let info = phone.call("host.info", json!({})).await;
    assert_eq!(
        info["r"]["remoteStart"], true,
        "an approver partner phone starts from afar: {info}"
    );
    // Without the approve right, a partner phone reads no remote start.
    let key: [u8; 32] = rand_bytes();
    let (_, peer) = signing_phone(89);
    let r = call(
        &mut s.app,
        3,
        "remote.pairings.put",
        json!({ "pairingId": ps::b64(&[89; 16]), "deviceKey": ps::b64(&key), "kind": "phone", "peer": peer, "partner": "Example Phone", "rights": { "request": true, "approve": false } }),
    )
    .await;
    assert_eq!(r["result"]["saved"], true, "{r}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut watcher = Device::open(&s.relay, &key).await.expect("a session");
    let info = watcher.call("host.info", json!({})).await;
    assert_eq!(info["r"]["remoteStart"], false, "{info}");
    // A partner app the phone has nothing to do with, under another name.
    let (mut other_app, _) = partner_key(&mut s, "Other App").await;

    let (ours, ours_sha) = gcode_file("cube.gcode", "M140 S60\nM104 S210\nG28\nG1 X10 Y10\n");
    let r = call(
        &mut s.agent,
        20,
        "approvals.register",
        print_card("ps-ours", &ours, &ours_sha),
    )
    .await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let view = phone
        .event("approval.request", |d| d["request"]["id"] == "ps-ours")
        .await;
    // (d) No plate check yet: refused, as for our phone.
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &view["request"], "approve", true),
        )
        .await;
    assert_eq!(r["e"]["code"], "forbidden", "a start with no plate pass: {r}");

    let (theirs, theirs_sha) = gcode_file("theirs.gcode", "M140 S60\nM104 S210\nG28\nG1 X20 Y20\n");
    let r = call(
        &mut other_app,
        21,
        "approvals.register",
        print_card("ps-own", &theirs, &theirs_sha),
    )
    .await;
    assert!(r.get("result").is_some(), "{r}");
    let own = phone
        .event("approval.request", |d| d["request"]["id"] == "ps-own")
        .await;

    // A fresh plate pass.
    let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["r"]["passes"], true, "{r}");
    // (c) A partner app's print stays refused, even with the plate pass.
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &own["request"], "approve", true),
        )
        .await;
    assert_eq!(
        r["e"]["code"], "forbidden",
        "a partner app's print was approved: {r}"
    );
    // (b) The person's own client's print starts, as from our phone.
    let r = phone
        .call(
            "approvals.decide",
            signed_decision_bed(&signer, &view["request"], "approve", true),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let mut ran = false;
    for _ in 0..60 {
        let log = mock_log(&mocks).await;
        if log.iter().any(|l| l.starts_with("start ")) {
            ran = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(ran, "{:?}", mock_log(&mocks).await);
    assert!(
        !mock_log(&mocks).await.iter().any(|l| l.contains("theirs")),
        "a partner app's file went to the printer: {:?}",
        mock_log(&mocks).await
    );
}

#[tokio::test]
async fn a_partner_phone_approves_our_phones_pause_but_never_one_a_partner_app_asked_for() {
    let mut s = setup().await;
    let mocks = printing_bay4(&mut s).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let (mut phone, signer, _) = partner_approver(&mut s, 90, "Example Phone").await;
    // Another partner app's phone, which may ask but not approve.
    let other_key: [u8; 32] = rand_bytes();
    let (_, other_peer) = signing_phone(91);
    let r = call(
        &mut s.app,
        3,
        "remote.pairings.put",
        json!({ "pairingId": ps::b64(&[91; 16]), "deviceKey": ps::b64(&other_key), "kind": "phone", "peer": other_peer, "partner": "Other App", "rights": { "request": true, "approve": false } }),
    )
    .await;
    assert_eq!(r["result"]["saved"], true, "{r}");
    // Our own phone, which asks without the approve right here.
    let our_key: [u8; 32] = rand_bytes();
    let (_, our_peer) = signing_phone(92);
    let r = call(
        &mut s.app,
        3,
        "remote.pairings.put",
        json!({ "pairingId": ps::b64(&[92; 16]), "deviceKey": ps::b64(&our_key), "kind": "phone", "peer": our_peer, "rights": { "request": true, "approve": false } }),
    )
    .await;
    assert_eq!(r["result"]["saved"], true, "{r}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut other = Device::open(&s.relay, &other_key).await.expect("a session");
    let mut ours = Device::open(&s.relay, &our_key).await.expect("a session");

    // A pause or a stop a partner app asked for, its own included: refused, and it may deny it.
    for (own, action) in [(false, "pause"), (true, "cancel")] {
        let ask = json!({ "printerId": "bay-4", "action": action });
        let r = if own {
            phone.call("jobs.control", ask).await
        } else {
            other.call("jobs.control", ask).await
        };
        assert_eq!(r["ok"], true, "{action}: {r}");
        let id = r["r"]["requestId"].as_str().unwrap().to_owned();
        let view = phone
            .event("approval.request", |d| d["request"]["id"] == id.as_str())
            .await;
        let r = phone
            .call(
                "approvals.decide",
                signed_decision(&signer, &view["request"], "approve"),
            )
            .await;
        assert_eq!(
            r["e"]["code"], "forbidden",
            "{action}: a partner app's request was approved: {r}"
        );
        let r = phone
            .call(
                "approvals.decide",
                signed_decision(&signer, &view["request"], "deny"),
            )
            .await;
        assert_eq!(r["ok"], true, "{action}: {r}");
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let log = mock_log(&mocks).await;
    assert!(
        !log.iter().any(|l| l.contains("pause") || l.contains("cancel")),
        "{log:?}"
    );

    // Our phone's pause: the partner phone approves it, as our phone would.
    let r = ours
        .call("jobs.control", json!({ "printerId": "bay-4", "action": "pause" }))
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let id = r["r"]["requestId"].as_str().unwrap().to_owned();
    let view = phone
        .event("approval.request", |d| d["request"]["id"] == id.as_str())
        .await;
    let r = phone
        .call(
            "approvals.decide",
            signed_decision(&signer, &view["request"], "approve"),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
}

/// A plate the person queued in the app, on bay 4: `scheduled` raises its card at once for a start an hour
/// from now; otherwise the app asks for its card with `queue.start`. Returns the card.
async fn person_queued_card(s: &mut Setup, title: &str, scheduled: bool) -> Value {
    let (f, _) = gcode_file("plate.gcode", "M140 S55\nM104 S215\nG28\n");
    let mut add = json!({ "printerId": "bay-4", "file": f, "title": title });
    if scheduled {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        add["startAfterMs"] = json!(now + 3_600_000);
    }
    let q = call(&mut s.app, 60, "queue.add", add).await;
    if scheduled {
        assert!(q["result"]["request"]["id"].is_string(), "{q}");
        return q["result"]["request"].clone();
    }
    let item = q["result"]["item"]["id"].as_str().unwrap().to_owned();
    let r = call(&mut s.app, 61, "queue.start", json!({ "itemId": item })).await;
    assert_eq!(
        r["result"]["request"]["actions"][0]["action"], "printer.start",
        "{r}"
    );
    r["result"]["request"].clone()
}

#[tokio::test]
async fn a_plate_the_person_queued_gets_the_same_answer_from_afar_on_our_phone_and_a_partner_phone() {
    let mut s = setup().await;
    let _mocks = idle_bay4_with_plate(&mut s).await;
    let clear = Arc::new(std::sync::atomic::AtomicBool::new(true));
    plate_detector(&s.link, clear.clone()).await;
    let r = call(
        &mut s.app,
        23,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    assert_eq!(r["result"]["enabled"], true, "{r}");
    let (mut partner, partner_signer, _) = partner_approver(&mut s, 93, "Example Phone").await;
    let (mut ours, our_signer) = approver(&mut s, 94).await;

    // Scheduled plates: the hub raises each card itself, for the person. Away from home a scheduled
    // start is the person's at the computer, and both phones hear the same answer.
    let first = person_queued_card(&mut s, "Plate 1", true).await;
    let second = person_queued_card(&mut s, "Plate 2", true).await;
    for (who, phone, signer, card) in [
        ("partner phone", &mut partner, &partner_signer, &first),
        ("our phone", &mut ours, &our_signer, &second),
    ] {
        let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
        assert_eq!(r["r"]["passes"], true, "{who}: {r}");
        let r = phone
            .call(
                "approvals.decide",
                signed_decision_bed(signer, card, "approve", true),
            )
            .await;
        assert_eq!(
            r["e"]["code"], "not_supported",
            "{who}: a scheduled plate the person queued: {r}"
        );
    }

    // A plate the person asks to start now, from the app.
    let now = person_queued_card(&mut s, "Plate 3", false).await;
    let r = partner.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["r"]["passes"], true, "{r}");
    let r = partner
        .call(
            "approvals.decide",
            signed_decision_bed(&partner_signer, &now, "approve", true),
        )
        .await;
    assert_eq!(r["ok"], true, "a plate the person asked to start: {r}");
}

#[tokio::test]
async fn a_partner_phone_never_approves_a_pause_a_partner_key_asked_for_over_the_relay() {
    let mut s = setup().await;
    let mocks = printing_bay4(&mut s).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let (mut phone, signer, _) = partner_approver(&mut s, 95, "Example Phone").await;
    // A partner app key that reaches the hub over the relay (`remote`), under another name.
    let r = call(
        &mut s.app,
        20,
        "clients.create",
        json!({ "name": "Other App", "role": "agent", "partner": true, "remote": true }),
    )
    .await;
    assert_eq!(r["result"]["partner"], true, "{r}");
    let key: [u8; 32] = ps::unb64(r["result"]["remote"]["deviceKey"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut other = Device::open(&s.relay, &key).await.expect("a session");
    let r = other
        .call("jobs.control", json!({ "printerId": "bay-4", "action": "pause" }))
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let id = r["r"]["requestId"].as_str().unwrap().to_owned();
    let view = phone
        .event("approval.request", |d| d["request"]["id"] == id.as_str())
        .await;
    let r = phone
        .call(
            "approvals.decide",
            signed_decision(&signer, &view["request"], "approve"),
        )
        .await;
    assert_eq!(
        r["e"]["code"], "forbidden",
        "a partner key's relay pause was approved: {r}"
    );
    let r = phone
        .call(
            "approvals.decide",
            signed_decision(&signer, &view["request"], "deny"),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let log = mock_log(&mocks).await;
    assert!(!log.iter().any(|l| l.contains("pause")), "{log:?}");
}

/// The camera guard's detector that answers the first plate check at once and holds each later one until the
/// test lets it go: `asked` hears when a held check arrives, `go` answers it (clear).
async fn held_plate_detector(
    link: &Link,
) -> (
    tokio::sync::mpsc::UnboundedReceiver<()>,
    tokio::sync::mpsc::UnboundedSender<()>,
) {
    let mut det = connect_async(format!("ws://127.0.0.1:{}/", link.addr().port()))
        .await
        .unwrap()
        .0;
    let pp = pairing::proof_params(&mut det, WATCH_CODE, json!({ "role": "watch" })).await;
    let r = call(&mut det, 1, "pair", pp).await;
    assert_eq!(r["result"]["role"], "watch", "{r}");
    let r = call(&mut det, 2, "watch.subscribe", json!({ "everyMs": 120_000 })).await;
    assert!(r["result"]["subscription"].is_number(), "{r}");
    let (asked_tx, asked_rx) = tokio::sync::mpsc::unbounded_channel();
    let (go_tx, mut go_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    tokio::spawn(async move {
        let (mut id, mut n) = (100, 0);
        while let Some(Ok(m)) = det.next().await {
            let Message::Text(t) = m else { continue };
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if v["event"] != "watch.plate" {
                continue;
            }
            n += 1;
            if n > 1 {
                let _ = asked_tx.send(());
                if go_rx.recv().await.is_none() {
                    return;
                }
            }
            let d = &v["data"];
            let res = json!({ "clear": true, "compared": true, "checkId": d["checkId"], "printerId": d["printerId"], "note": "test" });
            id += 1;
            det.send(Message::text(
                json!({ "id": id, "method": "watch.plateResult", "params": res }).to_string(),
            ))
            .await
            .unwrap();
        }
    });
    (asked_rx, go_tx)
}

#[tokio::test]
async fn a_start_approved_from_afar_is_refused_when_the_phone_is_revoked_during_its_plate_check() {
    let mut s = setup().await;
    let mocks = idle_bay4_with_plate(&mut s).await;
    let (mut asked, go) = held_plate_detector(&s.link).await;
    let r = call(
        &mut s.app,
        23,
        "remoteStart.set",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    assert_eq!(r["result"]["enabled"], true, "{r}");
    let (mut phone, signer, pairing_id) = partner_approver(&mut s, 96, "Example Phone").await;
    let (f, sha) = gcode_file("cube.gcode", "M140 S60\nM104 S210\nG28\nG1 X10 Y10\n");
    let r = call(
        &mut s.agent,
        20,
        "approvals.register",
        print_card("held-1", &f, &sha),
    )
    .await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let view = phone
        .event("approval.request", |d| d["request"]["id"] == "held-1")
        .await;
    let r = phone.call("plate.check", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["r"]["passes"], true, "{r}");
    // The approval waits on its own plate check; the person revokes the phone meanwhile.
    phone
        .fire(
            "approvals.decide",
            signed_decision_bed(&signer, &view["request"], "approve", true),
        )
        .await;
    tokio::time::timeout(Duration::from_secs(10), asked.recv())
        .await
        .expect("the approval's plate check in time")
        .expect("the approval's plate check");
    let r = call(
        &mut s.app,
        30,
        "remote.pairings.remove",
        json!({ "pairingId": pairing_id }),
    )
    .await;
    assert_eq!(r["result"]["removed"], true, "{r}");
    // Let this check and any later one answer.
    for _ in 0..4 {
        let _ = go.send(());
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let pending = call(&mut s.app, 31, "approvals.pending", json!({})).await;
    assert!(
        pending["result"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == "held-1"),
        "a revoked phone's approval went through: {pending}"
    );
    let log = mock_log(&mocks).await;
    assert!(!log.iter().any(|l| l.starts_with("start ")), "{log:?}");
}
