// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The app link end to end: an agent's `app.call` reaches the app only when the person turned the
//! link on and allowed the client, only for a pinned method, and only through the connection that
//! hosts the link; a deny holds, a revoke asks again, and a closing app ends the call.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::too_many_lines)]
#[path = "support/pairing.rs"]
mod pairing;

use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sx_connect::MemorySecrets;
use sx_link::{AppLinkWaits, BrokerGate, Link, LinkConfig, serve_with_approvals};
use sx_permit::ApprovalBroker;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const CODE: &str = "TEST-CODE";
const AGENT_CODE: &str = "AGNT-CODE";

/// A hub with no pause between questions, so a test can ask again at once.
async fn hub() -> Link {
    hub_with(AppLinkWaits {
        between: Duration::ZERO,
        ..AppLinkWaits::default()
    })
    .await
}

async fn hub_with(app_link_waits: AppLinkWaits) -> Link {
    let broker = Arc::new(ApprovalBroker::new().unwrap());
    let cfg = LinkConfig {
        port: 0,
        fixed_code: Some(CODE.to_owned()),
        fixed_agent_code: Some(AGENT_CODE.to_owned()),
        app_link_waits,
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

async fn connect(link: &Link) -> Ws {
    connect_async(format!("ws://127.0.0.1:{}/", link.addr().port()))
        .await
        .unwrap()
        .0
}

/// A connection from a page with this Origin, as the desktop app's window or the browser build opens one.
async fn connect_from(link: &Link, origin: &str) -> Ws {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    let mut req = format!("ws://127.0.0.1:{}/", link.addr().port())
        .into_client_request()
        .unwrap();
    req.headers_mut().insert("origin", origin.parse().unwrap());
    connect_async(req).await.unwrap().0
}

async fn call(ws: &mut Ws, id: u64, method: &str, params: Value) -> Value {
    ws.send(Message::text(
        json!({ "id": id, "method": method, "params": params }).to_string(),
    ))
    .await
    .unwrap();
    loop {
        let m = tokio::time::timeout(Duration::from_secs(20), ws.next())
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

async fn event(ws: &mut Ws, name: &str) -> Value {
    for _ in 0..100 {
        let Ok(Some(Ok(Message::Text(t)))) =
            tokio::time::timeout(Duration::from_millis(100), ws.next()).await
        else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["event"] == name {
            return v["data"].clone();
        }
    }
    panic!("no {name} event");
}

async fn no_event(ws: &mut Ws, name: &str) {
    for _ in 0..5 {
        if let Ok(Some(Ok(Message::Text(t)))) =
            tokio::time::timeout(Duration::from_millis(100), ws.next()).await
        {
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            assert_ne!(v["event"], name, "{v}");
        }
    }
}

/// The app's connection, paired with the app code.
async fn app(link: &Link) -> Ws {
    app_from(link, "tauri://localhost").await
}

async fn app_from(link: &Link, origin: &str) -> Ws {
    let mut ws = connect_from(link, origin).await;
    let pp = pairing::proof_params(&mut ws, CODE, json!({})).await;
    let r = call(&mut ws, 1, "pair", pp).await;
    assert_eq!(r["result"]["role"], "app", "{r}");
    ws
}

/// An agent that paired with the agent code and asked to be remembered, as Connect your AI agent sets it up. Returns
/// a fresh connection made with its key, and its client id.
async fn remembered_agent(link: &Link, name: &str) -> (Ws, String, String) {
    let mut ws = connect(link).await;
    let pp = pairing::proof_params(&mut ws, AGENT_CODE, json!({ "remember": true, "name": name })).await;
    let r = call(&mut ws, 1, "pair", pp).await;
    assert_eq!(r["result"]["role"], "agent", "{r}");
    let key = r["result"]["clientKey"].as_str().unwrap().to_owned();
    let id = r["result"]["clientId"].as_str().unwrap().to_owned();
    let mut again = connect(link).await;
    let r = call(&mut again, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(r["result"]["paired"], true, "{r}");
    (again, id, key)
}

async fn reconnect(link: &Link, key: &str) -> Ws {
    let mut ws = connect(link).await;
    let r = call(&mut ws, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(r["result"]["paired"], true, "{r}");
    ws
}

fn code(r: &Value) -> &str {
    r["error"]["code"].as_str().unwrap_or("")
}

/// Runs an agent's app.call on its own task, so the app can answer meanwhile.
fn spawn_call(mut ws: Ws, method: &str, args: Value) -> tokio::task::JoinHandle<(Ws, Value)> {
    let method = method.to_owned();
    tokio::spawn(async move {
        let r = call(&mut ws, 9, "app.call", json!({ "method": method, "args": args })).await;
        (ws, r)
    })
}

#[tokio::test]
async fn the_link_is_off_until_the_person_turns_it_on() {
    let link = hub().await;
    let mut a = app(&link).await;
    let (mut agent, _, _) = remembered_agent(&link, "Claude Code").await;
    let r = call(&mut agent, 2, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "app_link_off", "{r}");
    assert!(
        r["error"]["message"].as_str().unwrap().contains("Settings"),
        "{r}"
    );
    // The setting is the app's: an agent cannot turn it on.
    let r = call(&mut agent, 3, "settings.set", json!({ "appLink": true })).await;
    assert_eq!(code(&r), "forbidden", "{r}");
    let r = call(&mut a, 2, "settings.set", json!({ "appLink": true })).await;
    assert_eq!(r["result"]["appLink"], true, "{r}");
    // On, but no app hosts it yet.
    let r = call(&mut agent, 4, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "app_closed", "{r}");
}

#[tokio::test]
async fn only_pinned_methods_from_remembered_agents_reach_the_app() {
    let link = hub().await;
    let mut a = app(&link).await;
    call(&mut a, 2, "settings.set", json!({ "appLink": true })).await;
    let r = call(&mut a, 3, "appLink.host", json!({})).await;
    assert_eq!(r["result"]["on"], true, "{r}");
    let (mut agent, _, _) = remembered_agent(&link, "Claude Code").await;
    for m in [
        "print.local",
        "queue.add",
        "appLink.answer",
        "settings.set",
        "plate.print",
        "",
    ] {
        let r = call(&mut agent, 2, "app.call", json!({ "method": m })).await;
        assert!(matches!(code(&r), "forbidden" | "bad_request"), "{m}: {r}");
    }
    let r = call(
        &mut agent,
        3,
        "app.call",
        json!({ "method": "app.info", "args": [1] }),
    )
    .await;
    assert_eq!(code(&r), "bad_request", "{r}");
    // The app's side is the app's alone.
    for m in [
        "appLink.host",
        "appLink.answer",
        "appLink.reply",
        "appLink.grants",
        "appLink.revoke",
    ] {
        let r = call(
            &mut agent,
            4,
            m,
            json!({ "askId": 1, "callId": 1, "decision": "allow", "clientId": "x" }),
        )
        .await;
        assert_eq!(code(&r), "forbidden", "{m}: {r}");
    }
    no_event(&mut a, "appLink.ask").await;
    // An agent that paired with the code but was not remembered has no grant to keep.
    let mut once = connect(&link).await;
    let pp = pairing::proof_params(&mut once, AGENT_CODE, json!({})).await;
    call(&mut once, 1, "pair", pp).await;
    let r = call(&mut once, 2, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "unauthorized", "{r}");
    // The app's own connection does not call app.call.
    let r = call(&mut a, 5, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "forbidden", "{r}");
}

#[tokio::test]
async fn the_person_allows_a_client_once_and_its_calls_go_through_the_host() {
    let link = hub().await;
    let mut a = app(&link).await;
    call(&mut a, 2, "settings.set", json!({ "appLink": true })).await;
    call(&mut a, 3, "appLink.host", json!({})).await;
    let mut other_app = app(&link).await;
    let (agent, id, key) = remembered_agent(&link, "Claude Code").await;

    let pending = spawn_call(agent, "plate.list", json!({ "withBounds": true }));
    let ask = event(&mut a, "appLink.ask").await;
    assert_eq!(ask["clientId"], id);
    assert_eq!(ask["name"], "Claude Code");
    // Only the host answers its questions.
    let r = call(
        &mut other_app,
        2,
        "appLink.answer",
        json!({ "askId": ask["askId"], "decision": "allow" }),
    )
    .await;
    assert_eq!(code(&r), "not_found", "{r}");
    let r = call(
        &mut a,
        4,
        "appLink.answer",
        json!({ "askId": ask["askId"], "decision": "read" }),
    )
    .await;
    assert_eq!(r["result"]["answered"], true, "{r}");

    let c = event(&mut a, "appLink.call").await;
    assert_eq!(c["method"], "plate.list");
    assert_eq!(c["args"]["withBounds"], true);
    assert_eq!(c["client"]["name"], "Claude Code");
    let r = call(
        &mut other_app,
        3,
        "appLink.reply",
        json!({ "callId": c["callId"], "ok": true, "value": { "spoofed": true } }),
    )
    .await;
    assert_eq!(code(&r), "not_found", "{r}");
    call(
        &mut a,
        5,
        "appLink.reply",
        json!({ "callId": c["callId"], "ok": true, "value": { "objects": [] } }),
    )
    .await;
    let (mut agent, r) = pending.await.unwrap();
    assert_eq!(r["result"], json!({ "objects": [] }), "{r}");

    // The grant is kept: the next call asks nothing, and an error from the app keeps a known code only.
    let pending = spawn_call(reconnect(&link, &key).await, "app.info", json!({}));
    let c = event(&mut a, "appLink.call").await;
    call(
        &mut a,
        6,
        "appLink.reply",
        json!({ "callId": c["callId"], "ok": false, "code": "not_ready", "message": "still opening" }),
    )
    .await;
    let (_, r) = pending.await.unwrap();
    assert_eq!(code(&r), "not_ready", "{r}");
    let pending = spawn_call(agent, "app.info", json!({}));
    let c = event(&mut a, "appLink.call").await;
    call(
        &mut a,
        7,
        "appLink.reply",
        json!({ "callId": c["callId"], "ok": false, "code": "anything_goes" }),
    )
    .await;
    let (_, r) = pending.await.unwrap();
    assert_eq!(code(&r), "app_error", "{r}");

    let grants = call(&mut a, 8, "appLink.grants", json!({})).await;
    let g = grants["result"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["clientId"] == id)
        .unwrap()
        .clone();
    assert_eq!(g["rights"], "read", "{grants}");
    agent = reconnect(&link, &key).await;
    let _ = &mut agent;
}

#[tokio::test]
async fn a_deny_holds_and_a_revoke_asks_again() {
    let link = hub().await;
    let mut a = app(&link).await;
    call(&mut a, 2, "settings.set", json!({ "appLink": true })).await;
    call(&mut a, 3, "appLink.host", json!({})).await;
    let (agent, id, key) = remembered_agent(&link, "Some tool").await;

    let pending = spawn_call(agent, "app.info", json!({}));
    let ask = event(&mut a, "appLink.ask").await;
    call(
        &mut a,
        4,
        "appLink.answer",
        json!({ "askId": ask["askId"], "decision": "deny" }),
    )
    .await;
    let (mut agent, r) = pending.await.unwrap();
    assert_eq!(code(&r), "denied", "{r}");
    // Denied: refused at once, nothing asked.
    let r = call(&mut agent, 3, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "denied", "{r}");
    no_event(&mut a, "appLink.ask").await;

    let r = call(&mut a, 5, "appLink.revoke", json!({ "clientId": id })).await;
    assert_eq!(r["result"]["revoked"], true, "{r}");
    let pending = spawn_call(reconnect(&link, &key).await, "app.info", json!({}));
    let ask = event(&mut a, "appLink.ask").await;
    assert_eq!(ask["clientId"], id);
    call(
        &mut a,
        6,
        "appLink.answer",
        json!({ "askId": ask["askId"], "decision": "allow" }),
    )
    .await;
    let c = event(&mut a, "appLink.call").await;
    call(
        &mut a,
        7,
        "appLink.reply",
        json!({ "callId": c["callId"], "ok": true, "value": "hi" }),
    )
    .await;
    let (_, r) = pending.await.unwrap();
    assert_eq!(r["result"], "hi", "{r}");

    // Revoking the client itself ends the grant with it.
    call(&mut a, 8, "clients.revoke", json!({ "clientId": id })).await;
    let grants = call(&mut a, 9, "appLink.grants", json!({})).await;
    assert!(
        grants["result"]
            .as_array()
            .unwrap()
            .iter()
            .all(|g| g["clientId"] != id),
        "{grants}"
    );
}

#[tokio::test]
async fn a_closing_app_ends_the_call_and_turning_the_link_off_stops_new_ones() {
    let link = hub().await;
    let mut a = app(&link).await;
    call(&mut a, 2, "settings.set", json!({ "appLink": true })).await;
    call(&mut a, 3, "appLink.host", json!({})).await;
    let (agent, _, key) = remembered_agent(&link, "Claude Code").await;
    let pending = spawn_call(agent, "app.info", json!({}));
    let ask = event(&mut a, "appLink.ask").await;
    call(
        &mut a,
        4,
        "appLink.answer",
        json!({ "askId": ask["askId"], "decision": "allow" }),
    )
    .await;
    let _ = event(&mut a, "appLink.call").await;
    a.close(None).await.unwrap();
    let (mut agent, r) = pending.await.unwrap();
    assert_eq!(code(&r), "app_closed", "{r}");
    let r = call(&mut agent, 3, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "app_closed", "{r}");

    let mut a = app(&link).await;
    call(&mut a, 2, "appLink.host", json!({})).await;
    call(&mut a, 3, "settings.set", json!({ "appLink": false })).await;
    let mut agent = reconnect(&link, &key).await;
    let r = call(&mut agent, 2, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "app_link_off", "{r}");
    no_event(&mut a, "appLink.call").await;
}

#[tokio::test]
async fn a_partner_app_stays_off_the_open_project() {
    let link = hub().await;
    let mut a = app(&link).await;
    call(&mut a, 2, "settings.set", json!({ "appLink": true })).await;
    call(&mut a, 3, "appLink.host", json!({})).await;
    let r = call(
        &mut a,
        4,
        "clients.create",
        json!({ "name": "LayerMate", "role": "agent", "partner": true }),
    )
    .await;
    let key = r["result"]["clientKey"].as_str().unwrap().to_owned();
    let mut partner = reconnect(&link, &key).await;
    let r = call(&mut partner, 2, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "forbidden", "{r}");
    no_event(&mut a, "appLink.ask").await;
}

#[tokio::test]
async fn only_the_desktop_window_hosts_the_link() {
    let link = hub().await;
    let mut web = app_from(&link, "https://slicerx.app").await;
    call(&mut web, 2, "settings.set", json!({ "appLink": true })).await;
    let r = call(&mut web, 3, "appLink.host", json!({})).await;
    assert_eq!(code(&r), "forbidden", "{r}");
    let mut bare = connect(&link).await;
    let pp = pairing::proof_params(&mut bare, CODE, json!({})).await;
    call(&mut bare, 1, "pair", pp).await;
    let r = call(&mut bare, 2, "appLink.host", json!({})).await;
    assert_eq!(code(&r), "forbidden", "{r}");
    let (mut agent, _, _) = remembered_agent(&link, "Claude Code").await;
    let r = call(&mut agent, 2, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "app_closed", "{r}");
    let mut desktop = app(&link).await;
    let r = call(&mut desktop, 2, "appLink.host", json!({})).await;
    assert_eq!(r["result"]["on"], true, "{r}");
}

#[tokio::test]
async fn big_args_one_question_at_a_time_and_off_while_asking() {
    let link = hub().await;
    let mut a = app(&link).await;
    call(&mut a, 2, "settings.set", json!({ "appLink": true })).await;
    call(&mut a, 3, "appLink.host", json!({})).await;
    let (mut first, _, _) = remembered_agent(&link, "First").await;
    let big = "x".repeat(70 * 1024);
    let r = call(
        &mut first,
        2,
        "app.call",
        json!({ "method": "app.info", "args": { "pad": big } }),
    )
    .await;
    assert_eq!(code(&r), "bad_request", "{r}");
    no_event(&mut a, "appLink.ask").await;

    let pending = spawn_call(first, "app.info", json!({}));
    let ask = event(&mut a, "appLink.ask").await;
    assert!(
        ask["createdAt"].as_str().is_some_and(|t| t.starts_with("20")),
        "{ask}"
    );
    // A second agent waits for the first question to end.
    let (mut second, _, _) = remembered_agent(&link, "Second").await;
    let r = call(&mut second, 2, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "pending", "{r}");
    // Off while the question is up: the call ends off, and a late Allow finds nothing.
    call(&mut a, 4, "settings.set", json!({ "appLink": false })).await;
    let (_, r) = pending.await.unwrap();
    assert_eq!(code(&r), "app_link_off", "{r}");
    let r = call(
        &mut a,
        5,
        "appLink.answer",
        json!({ "askId": ask["askId"], "decision": "allow" }),
    )
    .await;
    assert_eq!(code(&r), "not_found", "{r}");
    let grants = call(&mut a, 6, "appLink.grants", json!({})).await;
    assert!(
        grants["result"]
            .as_array()
            .unwrap()
            .iter()
            .all(|g| g["rights"].is_null()),
        "{grants}"
    );
}

#[tokio::test]
async fn the_app_hears_when_a_question_ends() {
    let link = hub().await;
    let mut a = app(&link).await;
    call(&mut a, 2, "settings.set", json!({ "appLink": true })).await;
    call(&mut a, 3, "appLink.host", json!({})).await;
    let (agent, _, _) = remembered_agent(&link, "Claude Code").await;
    let pending = spawn_call(agent, "app.info", json!({}));
    let ask = event(&mut a, "appLink.ask").await;
    call(
        &mut a,
        4,
        "appLink.answer",
        json!({ "askId": ask["askId"], "decision": "deny" }),
    )
    .await;
    let ended = event(&mut a, "appLink.askEnded").await;
    assert_eq!(ended["askId"], ask["askId"]);
    let (_, r) = pending.await.unwrap();
    assert_eq!(code(&r), "denied", "{r}");
}

#[tokio::test]
async fn an_unanswered_question_holds_that_client_off_for_the_cooldown() {
    let link = hub_with(AppLinkWaits {
        ask: Duration::from_millis(300),
        cooldown: Duration::from_millis(1500),
        between: Duration::ZERO,
    })
    .await;
    let mut a = app(&link).await;
    call(&mut a, 2, "settings.set", json!({ "appLink": true })).await;
    call(&mut a, 3, "appLink.host", json!({})).await;
    let (agent, id, key) = remembered_agent(&link, "Claude Code").await;
    let pending = spawn_call(agent, "app.info", json!({}));
    let ask = event(&mut a, "appLink.ask").await;
    // Nobody answers: the call ends unanswered and the app hears the question ended.
    let (mut agent, r) = pending.await.unwrap();
    assert_eq!(code(&r), "not_answered", "{r}");
    assert_eq!(event(&mut a, "appLink.askEnded").await["askId"], ask["askId"]);
    // Within the cooldown it asks nothing.
    let r = call(&mut agent, 3, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "not_answered", "{r}");
    no_event(&mut a, "appLink.ask").await;
    // Another client is not held off by it.
    let (other, _, _) = remembered_agent(&link, "Other").await;
    let pending = spawn_call(other, "app.info", json!({}));
    let ask2 = event(&mut a, "appLink.ask").await;
    assert_ne!(ask2["clientId"], id);
    call(
        &mut a,
        4,
        "appLink.answer",
        json!({ "askId": ask2["askId"], "decision": "deny" }),
    )
    .await;
    let _ = pending.await.unwrap();
    // After it, the client is asked again.
    tokio::time::sleep(Duration::from_millis(1600)).await;
    let pending = spawn_call(reconnect(&link, &key).await, "app.info", json!({}));
    let again = event(&mut a, "appLink.ask").await;
    assert_eq!(again["clientId"], id);
    call(
        &mut a,
        5,
        "appLink.answer",
        json!({ "askId": again["askId"], "decision": "allow" }),
    )
    .await;
    let c = event(&mut a, "appLink.call").await;
    call(
        &mut a,
        6,
        "appLink.reply",
        json!({ "callId": c["callId"], "ok": true, "value": 1 }),
    )
    .await;
    let (_, r) = pending.await.unwrap();
    assert_eq!(r["result"], 1, "{r}");
}

#[tokio::test]
async fn after_a_deny_no_agent_asks_for_a_while() {
    let link = hub_with(AppLinkWaits {
        between: Duration::from_millis(600),
        ..AppLinkWaits::default()
    })
    .await;
    let mut a = app(&link).await;
    call(&mut a, 2, "settings.set", json!({ "appLink": true })).await;
    call(&mut a, 3, "appLink.host", json!({})).await;
    let (first, _, _) = remembered_agent(&link, "First").await;
    let pending = spawn_call(first, "app.info", json!({}));
    let ask = event(&mut a, "appLink.ask").await;
    call(
        &mut a,
        4,
        "appLink.answer",
        json!({ "askId": ask["askId"], "decision": "deny" }),
    )
    .await;
    let _ = pending.await.unwrap();
    // A different agent right after: held off, nothing asked.
    let (mut second, id, _) = remembered_agent(&link, "Second").await;
    let r = call(&mut second, 2, "app.call", json!({ "method": "app.info" })).await;
    assert_eq!(code(&r), "pending", "{r}");
    no_event(&mut a, "appLink.ask").await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    let pending = spawn_call(second, "app.info", json!({}));
    assert_eq!(event(&mut a, "appLink.ask").await["clientId"], id);
    drop(pending);
}

#[tokio::test]
async fn a_client_revoked_while_asked_hears_it_was_revoked() {
    let link = hub().await;
    let mut a = app(&link).await;
    call(&mut a, 2, "settings.set", json!({ "appLink": true })).await;
    call(&mut a, 3, "appLink.host", json!({})).await;
    let (agent, id, _) = remembered_agent(&link, "Claude Code").await;
    let pending = spawn_call(agent, "app.info", json!({}));
    let _ = event(&mut a, "appLink.ask").await;
    call(&mut a, 4, "clients.revoke", json!({ "clientId": id })).await;
    let (_, r) = pending.await.unwrap();
    assert!(matches!(code(&r), "unauthorized") || r["closed"] == true, "{r}");
}

#[tokio::test]
async fn the_agent_code_remembers_only_so_many_agents() {
    let link = hub().await;
    for i in 0..32 {
        let _ = remembered_agent(&link, &format!("Agent {i}")).await;
    }
    let mut ws = connect(&link).await;
    let pp = pairing::proof_params(
        &mut ws,
        AGENT_CODE,
        json!({ "remember": true, "name": "One more" }),
    )
    .await;
    let r = call(&mut ws, 1, "pair", pp).await;
    assert_eq!(code(&r), "too_many", "{r}");
}
