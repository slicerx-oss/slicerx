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

const RELAY_SECRET: &[u8] = b"remote test relay secret";

async fn relay() -> RelayHandle {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    // The hub and the test devices share one address here; the mock printer polls every 50 ms.
    let roomy = sx_relay::quota::TierLimits {
        frames_per_second: 1000,
        bytes_per_minute: 1 << 30,
        ..sx_relay::quota::Limits::default().anonymous
    };
    let limits = sx_relay::quota::Limits {
        anonymous: roomy,
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

async fn hub() -> Link {
    let broker = Arc::new(ApprovalBroker::new().unwrap());
    let cfg = LinkConfig {
        port: 0,
        fixed_code: Some(CODE.to_owned()),
        fixed_agent_code: Some(AGENT_CODE.to_owned()),
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
    let relay = relay().await;
    let link = hub().await;
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
