// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Partner phones end to end: the hub on a local sx-relay, a phone the app paired under a partner
//! app's name, reaching the hub over the relay with our phone's rights (approve off until the person
//! turns it on), registering its own push token through its pairing, and revoked from Devices.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::too_many_lines,
    clippy::indexing_slicing,
    clippy::needless_pass_by_value
)]

use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sx_connect::MemorySecrets;
use sx_link::pair_session::{self as ps, Channel, Opening, SessionFrame};
use sx_link::{BrokerGate, Link, LinkConfig, serve_with_approvals};
use sx_permit::ApprovalBroker;
use sx_relay::{RelayConfig, RelayHandle};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

#[path = "../../tests/common/mod.rs"]
mod common;
#[path = "support/pairing.rs"]
mod pairing;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const CODE: &str = "TEST-CODE";
const AGENT_CODE: &str = "AGNT-CODE";
/// The static secret behind the host identity's `dhPub`.
const HOST_DH: [u8; 32] = [2; 32];

async fn relay() -> RelayHandle {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    // The hub and the test devices share one address here.
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
            ..RelayConfig::default()
        },
    )
    .unwrap()
}

async fn hub(push_url: &str) -> Link {
    let broker = Arc::new(ApprovalBroker::new().unwrap());
    let cfg = LinkConfig {
        port: 0,
        fixed_code: Some(CODE.to_owned()),
        fixed_agent_code: Some(AGENT_CODE.to_owned()),
        push_url: push_url.to_owned(),
        watch_every: Duration::from_millis(100),
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
        "platform": "android",
        "signPub": ps::b64(&[seed; 32]),
        "dhPub": ps::b64(&ps::dh_public(&[seed.wrapping_add(1); 32])),
    })
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

/// A paired phone reaching the hub through the relay, as the partner app's copy of @slicerx/pair does.
struct Device {
    ws: Ws,
    channel: Channel,
    host_route: String,
    next: u64,
    events: Vec<Value>,
}

impl Device {
    async fn open(relay: &RelayHandle, key: &[u8; 32]) -> Option<Self> {
        let mut ws = connect_async(format!("ws://{}/v1", relay.addr)).await.unwrap().0;
        let (host_route, mine) = ps::pairing_routes(key);
        ws.send(Message::text(json!({ "op": "sub", "route": mine }).to_string()))
            .await
            .unwrap();
        let opening = Opening::new(
            &rand_bytes(),
            &rand_bytes(),
            &rand_bytes(),
            None,
            key,
            &ps::dh_public(&HOST_DH),
        );
        let init = serde_json::to_string(&opening.init).unwrap();
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
        })
    }

    /// The reply, or `{"closed": true}` when the session went quiet (it was dropped).
    async fn call(&mut self, method: &str, params: Value) -> Value {
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
        loop {
            let Some(body) = next_body(&mut self.ws).await else {
                return json!({ "closed": true });
            };
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

    /// Events named `ev` that arrive within `ms`, besides those already heard.
    async fn events_for(&mut self, ev: &str, ms: u64) -> Vec<Value> {
        let end = tokio::time::Instant::now() + Duration::from_millis(ms);
        while tokio::time::Instant::now() < end {
            let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout_at(end, self.ws.next()).await else {
                break;
            };
            let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
            let Some(body) = v["body"].as_str() else { continue };
            if let Some(SessionFrame::Data(d)) = ps::parse_frame(body)
                && let Some(plain) = self.channel.open(&d)
            {
                let v: Value = serde_json::from_slice(&plain).unwrap();
                if v["t"] == "ev" {
                    self.events.push(v);
                }
            }
        }
        let (mine, rest) = std::mem::take(&mut self.events)
            .into_iter()
            .partition(|e| e["ev"] == ev);
        self.events = rest;
        mine
    }
}

struct Setup {
    relay: RelayHandle,
    _link: Link,
    app: Ws,
    agent: Ws,
}

async fn setup(push_url: &str) -> Setup {
    let relay = relay().await;
    let link = hub(push_url).await;
    let mut app = paired(&link, CODE).await;
    let agent = paired(&link, AGENT_CODE).await;
    let url = format!("ws://{}/v1", relay.addr);
    let host = json!({
        "deviceId": ps::b64(&[1; 16]), "name": "Studio Mac", "platform": "desktop",
        "signPub": ps::b64(&[1; 32]), "dhPub": ps::b64(&ps::dh_public(&HOST_DH)),
    });
    let r = call(
        &mut app,
        2,
        "remote.configure",
        json!({ "enabled": true, "relay": url, "host": host, "hostDh": ps::b64(&HOST_DH) }),
    )
    .await;
    assert_eq!(r["result"]["enabled"], true, "{r}");
    for i in 0..100 {
        let s = call(&mut app, 900 + i, "remote.status", json!({})).await;
        if s["result"]["connected"] == true {
            return Setup {
                relay,
                _link: link,
                app,
                agent,
            };
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the hub never reached the relay");
}

/// Puts a phone pairing the app made, as `remote.pairings.put` does after the person confirmed the digits.
async fn put(
    app: &mut Ws,
    key: &[u8; 32],
    seed: u8,
    partner: Option<&str>,
    approve: bool,
) -> (String, Value) {
    let pairing_id = ps::b64(&[seed; 16]);
    let mut params = json!({ "pairingId": pairing_id, "deviceKey": ps::b64(key), "kind": "phone", "peer": identity(seed, "Pixel 8"), "rights": { "request": true, "approve": approve } });
    if let Some(p) = partner {
        params["partner"] = json!(p);
    }
    let r = call(app, 3, "remote.pairings.put", params).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    (pairing_id, r)
}

/// A fake Expo push service: answers each POST and sends its (headers, body).
async fn fake_expo() -> (String, tokio::sync::mpsc::UnboundedReceiver<(String, Value)>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/push", listener.local_addr().unwrap());
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    let Some(i) = text.find("\r\n\r\n") else { continue };
                    let head = text[..i].to_ascii_lowercase();
                    let len: usize = head
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if buf.len() < i + 4 + len {
                        continue;
                    }
                    let body: Value = serde_json::from_slice(&buf[i + 4..i + 4 + len]).unwrap_or(Value::Null);
                    let _ = tx.send((head, body));
                    let out = r#"{"data":[{"status":"ok"}]}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
                        out.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    return;
                }
            });
        }
    });
    (url, rx)
}

const PREFS: &str = r#"{"printDone":true,"printFailed":true,"attention":true,"approvals":true}"#;

#[tokio::test]
async fn a_partner_phone_pairs_under_its_name_reads_and_registers_its_own_push_until_revoked() {
    let (expo, mut posts) = fake_expo().await;
    let mut s = setup(&expo).await;
    let key: [u8; 32] = rand_bytes();
    let (pid, r) = put(&mut s.app, &key, 31, Some("  Example Phone "), false).await;
    assert_eq!(r["result"]["saved"], true, "{r}");

    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let info = phone.call("host.info", json!({})).await;
    assert_eq!(info["r"]["partner"], "Example Phone", "{info}");
    assert_eq!(info["r"]["push"], true, "{info}");
    assert_eq!(
        info["r"]["rights"],
        json!({ "request": true, "approve": false, "introduce": false }),
        "{info}"
    );
    assert_eq!(phone.call("printers.list", json!({})).await["r"], json!([]));

    // Without the approve right: no cards to answer, no decisions, and no mimir questions.
    assert_eq!(phone.call("approvals.list", json!({})).await["r"], json!([]));
    for (m, p) in [
        ("mimir.questions", json!({})),
        (
            "mimir.answer",
            json!({ "v": 1, "sessionId": "s", "askId": "a", "choiceId": null }),
        ),
        (
            "approvals.decide",
            json!({ "requestId": "x", "decision": "approve", "requestHash": "0".repeat(64), "at": 0, "sig": "x" }),
        ),
    ] {
        let r = phone.call(m, p).await;
        assert_eq!(r["e"]["code"], "forbidden", "{m}: {r}");
    }
    // Never remote, for a partner phone as for ours.
    for m in [
        "print.local",
        "upload.begin",
        "jobs.send",
        "clients.create",
        "secrets.get",
    ] {
        let r = phone.call(m, json!({})).await;
        assert_eq!(r["ok"], false, "{m}: {r}");
    }

    // Its own push token, through its pairing only. APNs needs its gateway; Expo goes to Expo.
    let bad = phone.call("push.registerPartner", json!({ "provider": "apns", "token": "ab".repeat(32), "platform": "android", "prefs": serde_json::from_str::<Value>(PREFS).unwrap() })).await;
    assert_eq!(bad["e"]["code"], "bad_request", "{bad}");
    let reg = phone
        .call("push.registerPartner", json!({ "provider": "expo", "token": "ExponentPushToken[partnerpartner01]", "platform": "android", "prefs": serde_json::from_str::<Value>(PREFS).unwrap() }))
        .await;
    assert_eq!(reg["ok"], true, "{reg}");

    // Clients read both back. The token never comes back; approvals are off for a phone that may not approve.
    let st = call(&mut s.agent, 40, "push.status", json!({})).await;
    let regs = st["result"]["registrations"].as_array().unwrap().clone();
    assert_eq!(regs.len(), 1, "{st}");
    assert_eq!(regs[0]["partner"], "Example Phone");
    assert_eq!(regs[0]["provider"], "expo");
    assert_eq!(regs[0]["mayApprove"], false);
    assert!(!st.to_string().contains("partnerpartner01"), "{st}");
    assert_eq!(st["result"]["sending"], true);
    let dev = call(&mut s.agent, 41, "partners.devices", json!({})).await;
    let d = &dev["result"]["devices"][0];
    assert_eq!(d["partner"], "Example Phone", "{dev}");
    assert_eq!(d["name"], "Pixel 8");
    assert_eq!(d["online"], true, "{dev}");
    assert_eq!(d["rights"]["approve"], false);
    assert_eq!(d["push"]["provider"], "expo");
    assert!(d["relayBytesToday"].as_u64().unwrap() > 0, "{dev}");
    assert!(
        !dev.to_string().contains(&ps::b64(&key)),
        "the device key leaked: {dev}"
    );

    // Our phone registers through the app; our access token goes with our phone's push only.
    let r = call(
        &mut s.app,
        42,
        "secrets.set",
        json!({ "name": "sx-link-expo-access-token", "value": "our-access-token" }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let r = call(&mut s.app, 43, "push.register", json!({ "token": "ExponentPushToken[ourphoneourphone]", "platform": "ios", "prefs": serde_json::from_str::<Value>(PREFS).unwrap(), "tag": "own" })).await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let r = call(&mut s.app, 44, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "bay-4", "{r}");
    mocks.set_state("moonraker", "printing").await;
    tokio::time::sleep(Duration::from_millis(800)).await;

    // The partner phone asks to pause: a card waits for a person. It may not approve, so its phone gets no
    // approval push; ours does.
    let card = phone
        .call("jobs.control", json!({ "printerId": "bay-4", "action": "pause" }))
        .await;
    assert_eq!(card["ok"], true, "{card}");
    let (head, body) = tokio::time::timeout(Duration::from_secs(10), posts.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body[0]["data"]["kind"], "approval", "{body}");
    assert_eq!(body[0]["to"], "ExponentPushToken[ourphoneourphone]", "{body}");
    assert!(head.contains("authorization: bearer our-access-token"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        posts.try_recv().is_err(),
        "the partner phone got an approval push"
    );

    // The print finishes: each phone gets its own post. The partner's carries no access token and no printer.
    mocks.set_state("moonraker", "finished").await;
    let mut got = Vec::new();
    for _ in 0..2 {
        let Ok(Some(p)) = tokio::time::timeout(Duration::from_secs(10), posts.recv()).await else {
            panic!("only {} finish pushes: {got:?}", got.len());
        };
        got.push(p);
    }
    let (head, theirs) = got
        .iter()
        .find(|(_, b)| b[0]["to"] == "ExponentPushToken[partnerpartner01]")
        .expect("the partner push")
        .clone();
    assert!(
        !head.contains("authorization"),
        "our token went with the partner's push: {head}"
    );
    assert_eq!(theirs.as_array().unwrap().len(), 1);
    assert_eq!(theirs[0]["title"], "Print finished");
    assert_eq!(theirs[0]["data"], json!({ "kind": "print_done" }), "{theirs}");
    assert!(
        !theirs.to_string().contains("Bay 4") && !theirs.to_string().contains("bay-4"),
        "{theirs}"
    );
    let (_, ours) = got
        .iter()
        .find(|(_, b)| b[0]["to"] == "ExponentPushToken[ourphoneourphone]")
        .expect("our push")
        .clone();
    assert_eq!(ours[0]["data"]["printerId"], "bay-4");

    // Revoked from Devices: the session ends, no new one opens, and its push registration is gone.
    let rm = call(
        &mut s.app,
        50,
        "remote.pairings.remove",
        json!({ "pairingId": pid }),
    )
    .await;
    assert_eq!(rm["result"]["removed"], true, "{rm}");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(phone.call("printers.list", json!({})).await["closed"], true);
    assert!(Device::open(&s.relay, &key).await.is_none());
    let st = call(&mut s.agent, 51, "push.status", json!({})).await;
    let left = st["result"]["registrations"].as_array().unwrap();
    assert!(left.iter().all(|r| r["partner"].is_null()), "{st}");
    assert_eq!(left.len(), 1, "our phone keeps its push: {st}");
    let dev = call(&mut s.agent, 52, "partners.devices", json!({})).await;
    assert_eq!(dev["result"]["devices"], json!([]), "{dev}");
}

#[tokio::test]
async fn an_approver_partner_phone_reads_mimir_and_only_partner_phones_register_partner_pushes() {
    let mut s = setup("").await;
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, 32, Some("Example Phone"), true).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let info = phone.call("host.info", json!({})).await;
    assert_eq!(info["r"]["rights"]["approve"], true, "{info}");
    let q = phone.call("mimir.questions", json!({})).await;
    assert_eq!(q["ok"], true, "{q}");

    // Our own phone has no partner push, and its host info names no partner.
    let own_key: [u8; 32] = rand_bytes();
    put(&mut s.app, &own_key, 33, None, true).await;
    let mut own = Device::open(&s.relay, &own_key).await.expect("a session");
    let info = own.call("host.info", json!({})).await;
    assert!(info["r"].get("partner").is_none(), "{info}");
    assert_eq!(info["r"]["push"], false);
    let r = own
        .call("push.registerPartner", json!({ "provider": "expo", "token": "ExponentPushToken[ownphoneownphone]", "platform": "ios", "prefs": serde_json::from_str::<Value>(PREFS).unwrap() }))
        .await;
    assert_eq!(r["e"]["code"], "forbidden", "{r}");
}

#[tokio::test]
async fn partner_names_and_counts_are_checked_and_agents_cannot_hand_pairings_over() {
    let mut s = setup("").await;
    // An agent is never a partner phone, and a name needs a letter or digit.
    let key: [u8; 32] = rand_bytes();
    let r = call(
        &mut s.app,
        4,
        "remote.pairings.put",
        json!({ "pairingId": ps::b64(&[40; 16]), "deviceKey": ps::b64(&key), "kind": "agent", "peer": identity(40, "Bot"), "partner": "Example Phone" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    let (_, r) = put(&mut s.app, &key, 41, Some("--"), false).await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    for seed in 50..58 {
        let (_, r) = put(&mut s.app, &rand_bytes(), seed, Some("Example Phone"), false).await;
        assert_eq!(r["result"]["saved"], true, "{r}");
    }
    let (_, r) = put(&mut s.app, &rand_bytes(), 58, Some("Example Phone"), false).await;
    assert_eq!(r["error"]["code"], "rate_limited", "the ninth partner phone: {r}");
    // Our own phones are not counted against partners.
    let (_, r) = put(&mut s.app, &rand_bytes(), 59, None, true).await;
    assert_eq!(r["result"]["saved"], true, "{r}");
    // The agent reads partner phones, but cannot hand a pairing to the hub or register a partner push.
    let dev = call(&mut s.agent, 5, "partners.devices", json!({})).await;
    assert_eq!(dev["result"]["devices"].as_array().unwrap().len(), 8, "{dev}");
    assert_eq!(dev["result"]["limits"]["partnerPhones"], 8);
    for (m, p) in [
        ("remote.pairings.put", json!({})),
        (
            "push.registerPartner",
            json!({ "tag": "x", "partner": "Example Phone" }),
        ),
    ] {
        let r = call(&mut s.agent, 6, m, p).await;
        assert_eq!(r["error"]["code"], "forbidden", "{m}: {r}");
    }
}

#[tokio::test]
async fn turning_approve_off_stops_cards_and_questions_on_a_live_session() {
    let mut s = setup("").await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let r = call(&mut s.app, 44, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "bay-4", "{r}");
    mocks.set_state("moonraker", "printing").await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, 34, Some("Example Phone"), true).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let card = phone
        .call("jobs.control", json!({ "printerId": "bay-4", "action": "pause" }))
        .await;
    assert_eq!(card["ok"], true, "{card}");
    assert!(
        !phone.events_for("approval.request", 1500).await.is_empty(),
        "an approver hears the card"
    );

    // The person turns approve off in Devices; the session stays open but hears no more cards.
    put(&mut s.app, &key, 34, Some("Example Phone"), false).await;
    let card = phone
        .call(
            "jobs.control",
            json!({ "printerId": "bay-4", "action": "cancel" }),
        )
        .await;
    assert_eq!(card["ok"], true, "{card}");
    assert_eq!(
        phone.events_for("approval.request", 1500).await,
        Vec::<Value>::new()
    );
    let r = phone.call("approvals.list", json!({})).await;
    assert_eq!(r["r"], json!([]), "{r}");
}

/// The partner phone's push registration as clients read it back (`push.status`).
async fn partner_push(agent: &mut Ws, id: u64) -> Value {
    let st = call(agent, id, "push.status", json!({})).await;
    st["result"]["registrations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["partner"] == "Example Phone")
        .cloned()
        .unwrap_or_else(|| panic!("no partner registration: {st}"))
}

/// A hub with a printing printer, our own phone and a partner phone that registered its push token
/// while it had `approve`.
async fn partner_push_setup(
    approve: bool,
) -> (
    Setup,
    tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
    Device,
    Device,
    [u8; 32],
    common::Mocks,
) {
    let (expo, posts) = fake_expo().await;
    let mut s = setup(&expo).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let r = call(&mut s.app, 44, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "bay-4", "{r}");
    mocks.set_state("moonraker", "printing").await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let key: [u8; 32] = rand_bytes();
    put(&mut s.app, &key, 36, Some("Example Phone"), approve).await;
    let mut phone = Device::open(&s.relay, &key).await.expect("a session");
    let reg = phone
        .call("push.registerPartner", json!({ "provider": "expo", "token": "ExponentPushToken[partnerpartner36]", "platform": "android", "prefs": serde_json::from_str::<Value>(PREFS).unwrap() }))
        .await;
    assert_eq!(reg["ok"], true, "{reg}");
    let own_key: [u8; 32] = rand_bytes();
    put(&mut s.app, &own_key, 37, None, true).await;
    let own = Device::open(&s.relay, &own_key).await.expect("a session");
    (s, posts, phone, own, key, mocks)
}

/// Our phone asks to stop the print: a card waits for a person, and phones that may approve hear of it.
async fn own_phone_asks(own: &mut Device, action: &str) {
    let card = own
        .call("jobs.control", json!({ "printerId": "bay-4", "action": action }))
        .await;
    assert_eq!(card["ok"], true, "{card}");
}

/// The approval pushes that reach the partner phone within `ms`.
async fn partner_approval_pushes(
    posts: &mut tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
    ms: u64,
) -> usize {
    let end = tokio::time::Instant::now() + Duration::from_millis(ms);
    let mut n = 0;
    while let Ok(Some((_, body))) = tokio::time::timeout_at(end, posts.recv()).await {
        if body[0]["to"] == "ExponentPushToken[partnerpartner36]" && body[0]["data"]["kind"] == "approval" {
            n += 1;
        }
    }
    n
}

#[tokio::test]
async fn turning_approve_on_for_a_partner_phone_brings_its_approval_pushes() {
    let (mut s, mut posts, _phone, mut own, key, _mocks) = partner_push_setup(false).await;
    assert_eq!(partner_push(&mut s.agent, 60).await["mayApprove"], false);
    own_phone_asks(&mut own, "pause").await;
    assert_eq!(
        partner_approval_pushes(&mut posts, 1500).await,
        0,
        "a phone that may not approve got an approval push"
    );

    // The person turns approve on in Devices; the app hands the hub the pairing again.
    put(&mut s.app, &key, 36, Some("Example Phone"), true).await;
    let reg = partner_push(&mut s.agent, 61).await;
    assert_eq!(
        reg["mayApprove"], true,
        "the push token kept the old right: {reg}"
    );
    own_phone_asks(&mut own, "cancel").await;
    assert_eq!(
        partner_approval_pushes(&mut posts, 5000).await,
        1,
        "no approval push after approve came on"
    );
}

#[tokio::test]
async fn turning_approve_off_for_a_partner_phone_clears_it_on_its_push_token() {
    let (mut s, mut posts, _phone, mut own, key, _mocks) = partner_push_setup(true).await;
    assert_eq!(partner_push(&mut s.agent, 60).await["mayApprove"], true);

    put(&mut s.app, &key, 36, Some("Example Phone"), false).await;
    let reg = partner_push(&mut s.agent, 61).await;
    assert_eq!(
        reg["mayApprove"], false,
        "the push token kept the old right: {reg}"
    );
    own_phone_asks(&mut own, "pause").await;
    assert_eq!(
        partner_approval_pushes(&mut posts, 1500).await,
        0,
        "a phone that may not approve got an approval push"
    );

    // And back on: the same token gets approval pushes again.
    put(&mut s.app, &key, 36, Some("Example Phone"), true).await;
    assert_eq!(partner_push(&mut s.agent, 62).await["mayApprove"], true);
    own_phone_asks(&mut own, "cancel").await;
    assert_eq!(partner_approval_pushes(&mut posts, 5000).await, 1);
}
