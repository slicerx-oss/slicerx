// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The hub end to end, with the real approval broker and a Moonraker fake: the local Print call
//! and its bed question, card starts from every remote origin, queued and scheduled starts the hub
//! runs itself, and state that survives a restart.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::too_many_lines,
    clippy::format_collect
)]
#[path = "../../tests/common/mod.rs"]
mod common;
#[path = "support/pairing.rs"]
mod pairing;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sx_connect::MemorySecrets;
use sx_link::{BrokerGate, Link, LinkConfig, serve_with_approvals};
use sx_permit::{ApprovalBroker, hash_params};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const CODE: &str = "TEST-CODE";
const AGENT_CODE: &str = "AGNT-CODE";
const WATCH_CODE: &str = "WTCH-CODE";

async fn hub(state_dir: Option<PathBuf>) -> Link {
    hub_with_push(state_dir, "").await
}

/// A hub that posts phone alerts to `push_url` (empty: sending off, so no test reaches Expo).
async fn hub_with_push(state_dir: Option<PathBuf>, push_url: &str) -> Link {
    let broker = Arc::new(ApprovalBroker::new().unwrap());
    let cfg = LinkConfig {
        port: 0,
        fixed_code: Some(CODE.to_owned()),
        fixed_agent_code: Some(AGENT_CODE.to_owned()),
        fixed_watch_code: Some(WATCH_CODE.to_owned()),
        state_dir,
        watch_every: Duration::from_millis(100),
        push_url: push_url.to_owned(),
        ..LinkConfig::default()
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

async fn paired(link: &Link) -> Ws {
    let mut ws = connect(link).await;
    let pp = pairing::proof_params(&mut ws, CODE, json!({})).await;
    let r = call(&mut ws, 1, "pair", pp).await;
    assert_eq!(r["result"]["paired"], true, "{r}");
    assert_eq!(r["result"]["role"], "app", "{r}");
    ws
}

/// A connection that paired with the agent code, as the MCP server does.
async fn agent(link: &Link) -> Ws {
    let mut ws = connect(link).await;
    let pp = pairing::proof_params(&mut ws, AGENT_CODE, json!({})).await;
    let r = call(&mut ws, 1, "pair", pp).await;
    assert_eq!(r["result"]["role"], "agent", "{r}");
    ws
}

async fn add_bay4(ws: &mut Ws, mocks: &common::Mocks) {
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let r = call(ws, 2, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "bay-4", "{r}");
}

fn gcode(seed: u32) -> (Vec<u8>, String) {
    let data: Vec<u8> = (0..2048_u32)
        .map(|i| u8::try_from((i * 7 + seed) % 251).unwrap())
        .collect();
    let sha = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
    (data, sha)
}

fn file(name: &str, seed: u32) -> (Value, String) {
    let (data, sha) = gcode(seed);
    (
        json!({ "name": name, "kind": "gcode", "sha256": sha, "dataBase64": base64::engine::general_purpose::STANDARD.encode(&data) }),
        sha,
    )
}

fn now_ms() -> u64 {
    u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()).unwrap()
}

async fn bed(ws: &mut Ws) -> Value {
    call(ws, 90, "bed.state", json!({ "printerId": "bay-4" })).await["result"].clone()
}

/// Waits for the hub's watcher to see a state on Bay 4.
async fn wait_bed(ws: &mut Ws, state: &str) -> Value {
    for _ in 0..100 {
        let b = bed(ws).await;
        if b["state"] == state {
            return b;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("bed never became {state}: {}", bed(ws).await);
}

async fn wait_event(ws: &mut Ws, name: &str, pred: impl Fn(&Value) -> bool) -> Value {
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

async fn queue_item(ws: &mut Ws, id: &str) -> Value {
    let list = call(ws, 91, "queue.list", json!({})).await;
    list["result"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == id)
        .cloned()
        .unwrap_or(Value::Null)
}

async fn wait_item(ws: &mut Ws, id: &str, state: &str) -> Value {
    for _ in 0..100 {
        let it = queue_item(ws, id).await;
        if it["state"] == state {
            return it;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("item {id} never became {state}: {}", queue_item(ws, id).await);
}

fn starts(log: &[String]) -> usize {
    log.iter().filter(|l| l.starts_with("start ")).count()
}

async fn mock_log(mocks: &common::Mocks) -> Vec<String> {
    mocks.state().await["moonraker"]["log"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap().to_owned())
        .collect()
}

fn temp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("sx-hub-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

// ---- the local Print click ----

// The hub passes `opts.slotMap` to the driver as it came (0 based keys). Moonraker cannot make
// the printer follow a map, so a start with one is refused in words and nothing starts; the same
// click without a map prints.
#[tokio::test]
async fn r7_a_slot_map_the_printer_would_not_follow_is_refused() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    let (f, _) = file("cube.gcode", 1);
    let r = call(
        &mut ws,
        3,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true, "opts": { "slotMap": { "0": "A1" } } }),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_supported", "{r}");
    assert!(
        r["error"]["message"].as_str().unwrap().contains("slot map"),
        "{r}"
    );
    assert_eq!(starts(&mock_log(&mocks).await), 0, "nothing started");
    let r = call(
        &mut ws,
        4,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["started"], true, "{r}");
    assert_eq!(starts(&mock_log(&mocks).await), 1);
}

#[tokio::test]
async fn a_local_click_asks_about_the_bed_only_when_it_is_not_known_clear() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;

    // A printer the hub has never watched: the bed state is unknown, so the sheet asks.
    let b = bed(&mut ws).await;
    assert_eq!(
        (b["state"].as_str(), b["askOnPrint"].as_bool()),
        (Some("unknown"), Some(true)),
        "{b}"
    );
    let (f, _) = file("cube.gcode", 1);
    let r = call(
        &mut ws,
        3,
        "print.local",
        json!({ "printerId": "bay-4", "file": f }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bed_check", "{r}");
    assert_eq!(starts(&mock_log(&mocks).await), 0, "nothing reached the printer");

    // The person ticks "the bed is clear" and presses Print again: one call uploads and starts.
    let r = call(
        &mut ws,
        4,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["started"], true, "{r}");
    assert_eq!(r["result"]["file"]["name"], "cube.gcode", "{r}");
    assert_eq!(r["result"]["bed"]["state"], "busy", "{r}");
    let log = mock_log(&mocks).await;
    assert!(log.iter().any(|l| l.starts_with("upload cube.gcode")), "{log:?}");
    assert_eq!(starts(&log), 1, "{log:?}");

    // While it prints, another click is refused before anything is sent.
    let (f2, _) = file("other.gcode", 2);
    let r = call(
        &mut ws,
        5,
        "print.local",
        json!({ "printerId": "bay-4", "file": f2, "bedClear": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "busy", "{r}");
    let r = call(&mut ws, 5, "bed.confirmClear", json!({ "printerId": "bay-4" })).await;
    assert_eq!(
        r["error"]["code"], "busy",
        "the plate cannot be cleared mid-print: {r}"
    );

    // The job ends with nobody confirming the plate was removed: the next click asks again.
    mocks.set_state("moonraker", "finished").await;
    let b = wait_bed(&mut ws, "not_cleared").await;
    assert_eq!(b["askOnPrint"], true, "{b}");
    assert_eq!(b["lastJob"], "cube.gcode", "{b}");
    assert!(b["endedAt"].is_string(), "{b}");
    let r = call(
        &mut ws,
        6,
        "print.local",
        json!({ "printerId": "bay-4", "file": f2 }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bed_check", "{r}");

    // "Plate removed" on the printer card: now a click needs no question at all.
    let b = call(&mut ws, 7, "bed.confirmClear", json!({ "printerId": "bay-4" })).await["result"].clone();
    assert_eq!(
        (b["state"].as_str(), b["askOnPrint"].as_bool()),
        (Some("clear"), Some(false)),
        "{b}"
    );
    assert!(b["confirmedAt"].is_string(), "{b}");
    let r = call(
        &mut ws,
        8,
        "print.local",
        json!({ "printerId": "bay-4", "file": f2 }),
    )
    .await;
    assert_eq!(r["result"]["started"], true, "{r}");
    assert_eq!(starts(&mock_log(&mocks).await), 2);

    // A canceled job counts as ended too.
    mocks.set_state("moonraker", "idle").await;
    wait_bed(&mut ws, "not_cleared").await;
}

#[tokio::test]
async fn a_local_click_cannot_be_claimed_through_a_card() {
    let link = hub(None).await;
    let mut ws = paired(&link).await;
    let req = json!({
        "id": "fake-local", "sessionId": "s", "tool": "printer.start", "permission": "start", "title": "t", "lines": [],
        "printerId": "bay-4", "paramsHash": hash_params(&json!({})), "actions": [], "expiresAt": "2099-01-01T00:00:00.000Z",
        "origin": "local_click",
    });
    let r = call(&mut ws, 2, "approvals.register", json!({ "request": req })).await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
}

// ---- starts from approval cards ----

#[tokio::test]
async fn every_remote_origin_needs_the_card_to_ask_about_the_bed_even_when_it_is_clear() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    let (f, sha) = file("cube.gcode", 3);
    let action = |a: &str, params: Value| json!({ "action": a, "target": "bay-4", "paramsHash": hash_params(&params) });
    let card = |id: &str, origin: Option<&str>| {
        let mut r = json!({
            "id": id, "sessionId": "s", "tool": "printer.send", "permission": "start", "title": "Print cube.gcode on Bay 4?", "lines": [],
            "printerId": "bay-4", "paramsHash": hash_params(&json!({})),
            "actions": [
                action("printer.upload", json!({ "printerId": "bay-4", "name": "cube.gcode", "sha256": sha })),
                action("printer.start", json!({ "printerId": "bay-4", "name": "cube.gcode", "opts": {}, "sha256": sha })),
            ],
            "expiresAt": "2099-01-01T00:00:00.000Z",
        });
        if let Some(o) = origin {
            r["origin"] = json!(o);
        }
        r
    };
    let mut n = 10;
    for origin in [Some("pilot"), Some("mcp"), Some("phone"), Some("inbox"), None] {
        // Make the bed known clear first, so only the remote rule can ask.
        let _ = call(&mut ws, n, "bed.confirmClear", json!({ "printerId": "bay-4" })).await;
        let tag = origin.unwrap_or("none");
        let no_bed = format!("{tag}-no-bed");
        let r = call(
            &mut ws,
            n + 1,
            "approvals.register",
            json!({ "request": card(&no_bed, origin) }),
        )
        .await;
        assert_eq!(r["result"]["registered"], true, "{r}");
        let t =
            call(&mut ws, n + 2, "approvals.grant", json!({ "requestId": no_bed })).await["result"].clone();
        let up = call(
            &mut ws,
            n + 3,
            "upload",
            json!({ "printerId": "bay-4", "file": f, "token": t }),
        )
        .await;
        assert_eq!(up["result"]["name"], "cube.gcode", "{up}");
        let r = call(
            &mut ws,
            n + 4,
            "start",
            json!({ "file": up["result"], "token": t }),
        )
        .await;
        assert_eq!(r["error"]["code"], "bed_check", "{tag}: {r}");

        let with_bed = format!("{tag}-bed");
        let _ = call(
            &mut ws,
            n + 5,
            "approvals.register",
            json!({ "request": card(&with_bed, origin) }),
        )
        .await;
        let t = call(
            &mut ws,
            n + 6,
            "approvals.grant",
            json!({ "requestId": with_bed, "bedClear": true }),
        )
        .await["result"]
            .clone();
        let up = call(
            &mut ws,
            n + 7,
            "upload",
            json!({ "printerId": "bay-4", "file": f, "token": t }),
        )
        .await;
        let r = call(
            &mut ws,
            n + 8,
            "start",
            json!({ "file": up["result"], "token": t }),
        )
        .await;
        assert_eq!(r["result"]["ok"], true, "{tag}: {r}");
        mocks.set_state("moonraker", "finished").await;
        wait_bed(&mut ws, "not_cleared").await;
        n += 10;
    }
    assert_eq!(starts(&mock_log(&mocks).await), 5);

    // A token the broker never granted is refused before the printer is asked.
    let forged = json!({ "requestId": "nobody", "token": "x", "expiresAt": "2099-01-01T00:00:00.000Z" });
    let rf = json!({ "printerId": "bay-4", "path": "cube.gcode", "name": "cube.gcode" });
    let r = call(
        &mut ws,
        99,
        "start",
        json!({ "file": rf, "token": forged, "bedClear": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "approval_invalid", "{r}");
}

// ---- the queue and scheduled starts ----

#[tokio::test]
async fn a_scheduled_start_runs_at_its_time_with_nobody_connected() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    wait_bed(&mut ws, "unknown").await;
    let (f, sha) = file("night.gcode", 4);
    let at = now_ms() + 2500;
    let r = call(
        &mut ws,
        3,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f, "startAfterMs": at, "title": "Night plate" }),
    )
    .await;
    let item = r["result"]["item"].clone();
    let request = r["result"]["request"].clone();
    assert_eq!(item["state"], "awaiting_approval", "{r}");
    assert_eq!(item["sha256"], sha);
    assert_eq!(request["origin"], "schedule", "{r}");
    assert!(
        request["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l.as_str().unwrap().contains("plate is clear")),
        "the card asks about the bed: {request}"
    );

    // The card has to ask about the bed.
    let r = call(
        &mut ws,
        4,
        "approvals.grant",
        json!({ "requestId": request["id"] }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bed_check", "{r}");
    let r = call(
        &mut ws,
        5,
        "approvals.grant",
        json!({ "requestId": request["id"], "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["queued"], true, "{r}");
    assert!(
        r["result"].get("token").is_none(),
        "the hub keeps the approval: {r}"
    );
    let item_id = item["id"].as_str().unwrap().to_owned();
    let it = queue_item(&mut ws, &item_id).await;
    assert_eq!(it["state"], "approved", "{it}");
    assert_eq!(starts(&mock_log(&mocks).await), 0, "not before its time");

    // The app closes. The hub starts the plate at its time.
    ws.close(None).await.unwrap();
    drop(ws);
    tokio::time::sleep(Duration::from_millis(3500)).await;
    let log = mock_log(&mocks).await;
    assert_eq!(starts(&log), 1, "{log:?}");
    assert!(
        log.iter().any(|l| l.starts_with("upload night.gcode 2048 ")),
        "{log:?}"
    );
    let mut ws = paired(&link).await;
    let it = queue_item(&mut ws, &item_id).await;
    assert_eq!(it["state"], "started", "{it}");
}

#[tokio::test]
async fn a_scheduled_start_is_canceled_when_the_printer_runs_something_else_first() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    let (f, _) = file("night.gcode", 5);
    let r = call(
        &mut ws,
        3,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f, "startAfterMs": now_ms() + 3000 }),
    )
    .await;
    let id = r["result"]["item"]["id"].as_str().unwrap().to_owned();
    let rid = r["result"]["request"]["id"].clone();
    let _ = call(
        &mut ws,
        4,
        "approvals.grant",
        json!({ "requestId": rid, "bedClear": true }),
    )
    .await;

    // Someone prints a quick part in between, and even clears the plate afterwards.
    let (quick, _) = file("quick.gcode", 6);
    let r = call(
        &mut ws,
        5,
        "print.local",
        json!({ "printerId": "bay-4", "file": quick, "bedClear": true }),
    )
    .await;
    assert_eq!(
        r["result"]["started"], true,
        "the person at the printer says the plate is clear: {r}"
    );
    mocks.set_state("moonraker", "finished").await;
    wait_bed(&mut ws, "not_cleared").await;
    let _ = call(&mut ws, 6, "bed.confirmClear", json!({ "printerId": "bay-4" })).await;

    let it = wait_item(&mut ws, &id, "canceled").await;
    assert!(it["message"].as_str().unwrap().contains("another job"), "{it}");
    tokio::time::sleep(Duration::from_millis(3500)).await;
    assert_eq!(starts(&mock_log(&mocks).await), 1, "only the quick part ran");
}

#[tokio::test]
async fn an_unapproved_schedule_expires_and_a_declined_card_cancels() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    let (f, _) = file("a.gcode", 7);
    let r = call(
        &mut ws,
        3,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f, "startAfterMs": now_ms() + 800 }),
    )
    .await;
    let id = r["result"]["item"]["id"].as_str().unwrap().to_owned();
    let it = wait_item(&mut ws, &id, "expired").await;
    assert!(it["message"].as_str().unwrap().contains("not approved"), "{it}");

    let r = call(
        &mut ws,
        4,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f, "startAfter": "2099-01-01T00:00:00.000Z" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "more than a week ahead: {r}");
    let r = call(
        &mut ws,
        5,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f, "startAfterMs": now_ms() + 60_000 }),
    )
    .await;
    let id = r["result"]["item"]["id"].as_str().unwrap().to_owned();
    let _ = call(
        &mut ws,
        6,
        "approvals.deny",
        json!({ "requestId": r["result"]["request"]["id"] }),
    )
    .await;
    let it = queue_item(&mut ws, &id).await;
    assert_eq!(it["state"], "canceled", "{it}");
    assert_eq!(starts(&mock_log(&mocks).await), 0);
}

#[tokio::test]
async fn a_queued_plate_raises_a_card_on_its_turn_and_starts_once_approved() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    let (f, _) = file("next.gcode", 8);
    let r = call(
        &mut ws,
        3,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f }),
    )
    .await;
    let id = r["result"]["item"]["id"].as_str().unwrap().to_owned();
    assert!(
        r["result"].get("request").is_none(),
        "a queued plate is approved on its turn: {r}"
    );

    // The printer is free, so the hub raises the card at once, with an alert for the phone.
    let card = wait_event(&mut ws, "approval", |c| c["origin"] == "queue").await;
    let alert = wait_event(&mut ws, "alert", |a| a["kind"] == "approval_waiting").await;
    assert_eq!(alert["requestId"], card["id"], "{alert}");
    let pending = call(&mut ws, 4, "approvals.pending", json!({})).await;
    assert!(
        pending["result"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == card["id"]),
        "{pending}"
    );
    let r = call(
        &mut ws,
        5,
        "approvals.grant",
        json!({ "requestId": card["id"], "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["queued"], true, "{r}");
    wait_item(&mut ws, &id, "started").await;
    assert_eq!(starts(&mock_log(&mocks).await), 1);

    // When it finishes, the phone hears about it.
    mocks.set_state("moonraker", "finished").await;
    let a = wait_event(&mut ws, "alert", |a| a["kind"] == "finished").await;
    assert_eq!(a["printerId"], "bay-4", "{a}");
}

// ---- state that survives a restart ----

#[tokio::test]
async fn a_plate_queues_for_an_offline_bambu_printer_without_connecting() {
    let link = hub(None).await;
    let mut ws = paired(&link).await;
    // Nothing listens on this port: the printer is switched off.
    let off = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = off.local_addr().unwrap().port();
    drop(off);
    let r = call(
        &mut ws,
        2,
        "secrets.set",
        json!({ "name": "bay-9-code", "value": "12345678" }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let cfg = json!({
        "id": "bay-9", "name": "Bay 9", "plugin": "bambu-lan", "host": "127.0.0.1", "port": port,
        "serial": "01S00C123456789", "credentialRef": "bay-9-code", "ftpPort": port, "pollMs": 50,
    });
    let r = call(&mut ws, 3, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "bay-9", "{r}");

    // Queueing stores the plate as given. It does not connect, so an offline printer takes it.
    let (f, sha) = file("night.gcode", 9);
    let r = call(
        &mut ws,
        4,
        "queue.add",
        json!({ "printerId": "bay-9", "file": f, "title": "Night plate" }),
    )
    .await;
    assert!(
        r["error"].is_null(),
        "an offline printer takes a queued plate: {r}"
    );
    let item = r["result"]["item"].clone();
    assert_eq!(
        item["sha256"], sha,
        "the queued bytes are the plate as sent: {item}"
    );
    let id = item["id"].as_str().unwrap().to_owned();
    let it = queue_item(&mut ws, &id).await;
    assert_eq!(it["printerId"], "bay-9", "{it}");
}

/// A stand-in `BamBuddy`: answers every request with an idle printer and records the request line and
/// the API key it was sent.
async fn fake_bambuddy() -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = vec![0_u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = req.lines().next().unwrap_or_default().to_owned();
                let key = req
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .starts_with("x-api-key:")
                            .then(|| l[10..].trim().to_owned())
                    })
                    .unwrap_or_default();
                log.lock().unwrap().push(format!("{line} key={key}"));
                let body = if line.starts_with("GET /api/v1/printers ") {
                    r#"[{"id":12,"name":"Shed P1S"}]"#
                } else {
                    r#"{"connected":true,"state":"IDLE"}"#
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
    (port, seen)
}

#[tokio::test]
async fn a_bambuddy_printer_takes_its_server_from_connected_apps() {
    let link = hub(None).await;
    let mut ws = paired(&link).await;
    let cfg = json!({ "id": "bb-12", "name": "Shed P1S", "plugin": "bambuddy", "host": "10.9.9.9", "serial": "12" });

    // Until BamBuddy is added in Connected apps, a BamBuddy printer has nowhere to go.
    let r = call(&mut ws, 2, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["error"]["code"], "not_configured", "{r}");
    let r = call(&mut ws, 3, "printers.test", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["ok"], false, "{r}");
    assert_eq!(r["result"]["cause"], "not_configured", "{r}");

    // Add BamBuddy once: its address, and its API key kept as a secret.
    let (port, seen) = fake_bambuddy().await;
    let r = call(
        &mut ws,
        4,
        "secrets.set",
        json!({ "name": "app-bambuddy", "value": "bb-key-1" }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        5,
        "services.configure",
        json!({ "pluginId": "bambuddy", "baseUrl": format!("http://127.0.0.1:{port}"), "secretRef": "app-bambuddy" }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let list = call(&mut ws, 6, "services.list", json!({})).await;
    assert!(
        list["result"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["pluginId"] == "bambuddy" && s["hasSecret"] == true),
        "{list}"
    );

    // Settings, Connected apps shows whether the app answers, and how many printers it lists.
    let r = call(&mut ws, 61, "services.check", json!({ "pluginId": "bambuddy" })).await;
    assert_eq!(r["result"]["printers"], 1, "{r}");

    // The printer named another host. The connection goes to the app's server, with the app's key,
    // for the printer id the printer holds.
    let r = call(&mut ws, 7, "printers.test", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let r = call(&mut ws, 8, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "bb-12", "{r}");
    let r = call(&mut ws, 9, "status", json!({ "printerId": "bb-12" })).await;
    assert!(r["error"].is_null(), "{r}");
    let seen = seen.lock().unwrap().clone();
    assert!(!seen.is_empty(), "the app's server was asked");
    assert!(
        seen.iter()
            .all(|l| l.contains("/api/v1/printers") && l.ends_with("key=bb-key-1")),
        "{seen:?}"
    );
    assert!(
        seen.iter()
            .filter(|l| !l.starts_with("GET /api/v1/printers "))
            .all(|l| l.contains("/api/v1/printers/12")),
        "a printer's calls name its BamBuddy id: {seen:?}"
    );
}

#[tokio::test]
async fn printers_fleets_queue_approvals_and_clients_survive_a_restart() {
    let dir = temp_dir("restart");
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let (key, item_id) = {
        let link = hub(Some(dir.clone())).await;
        let code = sx_link::read_pairing_code(&dir).unwrap();
        assert_eq!(code, "TEST-CODE", "the code is written for `sx-link code`");
        let mut ws = connect(&link).await;
        let pp = pairing::proof_params(
            &mut ws,
            CODE,
            json!({ "remember": true, "name": "Studio on the iMac" }),
        )
        .await;
        let r = call(&mut ws, 1, "pair", pp).await;
        let key = r["result"]["clientKey"].as_str().unwrap().to_owned();
        add_bay4(&mut ws, &mocks).await;
        let r = call(
            &mut ws,
            3,
            "fleets.create",
            json!({ "name": "Farm", "printerIds": ["bay-4"] }),
        )
        .await;
        assert_eq!(r["result"]["name"], "Farm", "{r}");
        let _ = call(
            &mut ws,
            4,
            "settings.set",
            json!({ "experimentalConnectors": true }),
        )
        .await;
        let (f, _) = file("later.gcode", 9);
        let r = call(
            &mut ws,
            5,
            "queue.add",
            json!({ "printerId": "bay-4", "file": f, "startAfterMs": now_ms() + 60_000 }),
        )
        .await;
        let item_id = r["result"]["item"]["id"].as_str().unwrap().to_owned();
        let r = call(
            &mut ws,
            6,
            "approvals.grant",
            json!({ "requestId": r["result"]["request"]["id"], "bedClear": true }),
        )
        .await;
        assert_eq!(r["result"]["queued"], true, "{r}");
        (key, item_id)
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for f in ["hub.json", "queue.json", "pairing-code"] {
            let mode = std::fs::metadata(dir.join(f)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{f}");
        }
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    let link = hub(Some(dir.clone())).await;
    // The remembered client comes back without the code; a wrong key does not.
    let mut bad = connect(&link).await;
    let r = call(&mut bad, 1, "pair", json!({ "clientKey": "0".repeat(64) })).await;
    assert_eq!(r["error"]["code"], "unauthorized", "{r}");
    let mut ws = connect(&link).await;
    let r = call(&mut ws, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(r["result"]["paired"], true, "{r}");
    let list = call(&mut ws, 2, "list", json!({})).await;
    assert_eq!(list["result"][0]["id"], "bay-4", "{list}");
    let fleets = call(&mut ws, 3, "fleets.list", json!({})).await;
    assert_eq!(fleets["result"][0]["printerIds"][0], "bay-4", "{fleets}");
    let s = call(&mut ws, 4, "settings.get", json!({})).await;
    assert_eq!(s["result"]["experimentalConnectors"], true, "{s}");
    let it = queue_item(&mut ws, &item_id).await;
    assert_eq!(it["state"], "approved", "the standing approval survives: {it}");
    // The card's bed answer lives on the standing approval, not on the printer's record.
    let b = bed(&mut ws).await;
    assert_ne!(b["state"], "clear", "{b}");
    let clients = call(&mut ws, 5, "clients.list", json!({})).await;
    let cid = clients["result"][0]["id"].clone();
    assert_eq!(clients["result"][0]["name"], "Studio on the iMac", "{clients}");
    assert!(!clients.to_string().contains(&key), "keys are never listed");
    let r = call(&mut ws, 6, "clients.revoke", json!({ "clientId": cid })).await;
    assert_eq!(r["result"]["revoked"], true, "{r}");
    let mut again = connect(&link).await;
    let r = call(&mut again, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(
        r["error"]["code"], "unauthorized",
        "a revoked key no longer pairs: {r}"
    );
    let text = std::fs::read_to_string(dir.join("hub.json")).unwrap();
    assert!(!text.contains(&key), "only the key's hash is stored");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_hub_that_was_down_treats_a_clear_bed_as_unknown() {
    let dir = temp_dir("down");
    let mocks = common::Mocks::start("moonraker", &[]).await;
    {
        let link = hub(Some(dir.clone())).await;
        let mut ws = paired(&link).await;
        add_bay4(&mut ws, &mocks).await;
        let b = call(&mut ws, 3, "bed.confirmClear", json!({ "printerId": "bay-4" })).await;
        assert_eq!(b["result"]["state"], "clear", "{b}");
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Pretend the hub stopped an hour ago.
    let path = dir.join("hub.json");
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    v["heartbeatMs"] = json!(now_ms() - 3_600_000);
    std::fs::write(&path, v.to_string()).unwrap();
    let link = hub(Some(dir.clone())).await;
    let mut ws = paired(&link).await;
    let b = bed(&mut ws).await;
    assert_eq!(
        (b["state"].as_str(), b["askOnPrint"].as_bool()),
        (Some("unknown"), Some(true)),
        "{b}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- phone alerts ----

/// One HTTP request to a fake push service: returns its body, answers with `reply`.
async fn push_service(reply: Value) -> (String, tokio::sync::oneshot::Receiver<Value>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/push", listener.local_addr().unwrap());
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut raw = Vec::new();
        let mut buf = [0_u8; 8192];
        let body = loop {
            let n = sock.read(&mut buf).await.unwrap();
            raw.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&raw).to_string();
            if let Some(at) = text.find("\r\n\r\n") {
                let len: usize = text
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                if raw.len() >= at + 4 + len {
                    break raw[at + 4..at + 4 + len].to_vec();
                }
            }
            assert!(n > 0, "the request ended early");
        };
        let out = reply.to_string();
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
            out.len()
        );
        sock.write_all(resp.as_bytes()).await.unwrap();
        let _ = tx.send(serde_json::from_slice(&body).unwrap());
    });
    (url, rx)
}

#[tokio::test]
async fn a_finished_print_sends_a_content_free_push_and_drops_a_dead_token() {
    let token = "ExponentPushToken[abcdefghijklmnop0123]";
    let (url, got) = push_service(
        json!({ "data": [{ "status": "error", "details": { "error": "DeviceNotRegistered" } }] }),
    )
    .await;
    let link = hub_with_push(None, &url).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    let r = call(
        &mut ws,
        2,
        "push.register",
        json!({ "token": "not a token", "platform": "ios", "prefs": {} }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    let prefs = json!({ "printDone": true, "printFailed": true, "attention": false, "approvals": true });
    let r = call(
        &mut ws,
        3,
        "push.register",
        json!({ "token": token, "platform": "ios", "prefs": prefs, "tag": "pairing-1" }),
    )
    .await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let list = call(&mut ws, 4, "push.list", json!({})).await;
    assert_eq!(list["result"][0]["tokenEnd"], "op0123", "{list}");
    assert!(!list.to_string().contains(token), "tokens are never echoed");

    mocks.set_state("moonraker", "printing").await;
    wait_event(&mut ws, "bed", |d| d["state"] == "busy").await;
    let job = call(&mut ws, 5, "status", json!({ "printerId": "bay-4" })).await["result"]["jobName"].clone();
    mocks.set_state("moonraker", "finished").await;
    let sent = tokio::time::timeout(Duration::from_secs(10), got)
        .await
        .unwrap()
        .unwrap();
    let msg = &sent[0];
    assert_eq!(msg["to"], token);
    assert_eq!(msg["title"], "Print finished");
    assert_eq!(msg["data"]["kind"], "print_done");
    assert_eq!(msg["data"]["printerId"], "bay-4");
    let text = sent.to_string();
    if let Some(j) = job.as_str() {
        assert!(!text.contains(j), "the push names the job: {text}");
    }
    assert!(!text.contains("Bay 4"), "the push names the printer: {text}");

    // Expo said the phone is gone: the hub forgets it.
    for _ in 0..50 {
        let list = call(&mut ws, 6, "push.list", json!({})).await;
        if list["result"].as_array().unwrap().is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the dead token was kept");
}

#[tokio::test]
async fn push_registrations_are_removed_by_tag() {
    let link = hub(None).await;
    let mut ws = paired(&link).await;
    let prefs = json!({ "printDone": true });
    for (i, t) in ["ExpoPushToken[aaaaaaaaaaaa]", "ExpoPushToken[bbbbbbbbbbbb]"]
        .iter()
        .enumerate()
    {
        let r = call(
            &mut ws,
            10 + i as u64,
            "push.register",
            json!({ "token": t, "platform": "android", "prefs": prefs, "tag": "p1" }),
        )
        .await;
        assert_eq!(r["result"]["registered"], true, "{r}");
    }
    let r = call(&mut ws, 20, "push.unregister", json!({ "tag": "p1" })).await;
    assert_eq!(r["result"]["unregistered"], 2, "{r}");
    let r = call(&mut ws, 21, "push.unregister", json!({})).await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
}

// ---- print watch ----

#[tokio::test]
async fn a_grab_returns_one_still_from_the_printer() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    let r = call(&mut ws, 3, "camera.grab", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"]["contentType"], "image/jpeg", "{r}");
    assert_eq!(r["result"]["source"], "snapshot", "{r}");
    let data = base64::engine::general_purpose::STANDARD
        .decode(r["result"]["dataBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(&data[..2], &[0xFF, 0xD8], "a JPEG");
    assert!(r["result"]["capturedAt"].as_str().unwrap().ends_with('Z'));
    let r = call(&mut ws, 4, "camera.grab", json!({ "printerId": "nobody" })).await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
}

// ---- approval security checks ----

fn hash_of(v: &Value) -> String {
    hash_params(v)
}

/// A start card for `name` with content `sha` on bay-4, registered with `origin` (None: none sent).
fn start_card(id: &str, name: &str, sha: &str, origin: Option<&str>) -> Value {
    let mut r = json!({
        "id": id, "sessionId": "s", "tool": "printer.queue", "permission": "start", "title": format!("Print {name} on Bay 4?"), "lines": [],
        "printerId": "bay-4", "paramsHash": hash_of(&json!({})),
        "actions": [
            { "action": "printer.upload", "target": "bay-4", "paramsHash": hash_of(&json!({ "printerId": "bay-4", "name": name, "sha256": sha })) },
            { "action": "printer.start", "target": "bay-4", "paramsHash": hash_of(&json!({ "printerId": "bay-4", "name": name, "opts": {}, "sha256": sha })) },
        ],
        "expiresAt": "2099-01-01T00:00:00.000Z",
    });
    if let Some(o) = origin {
        r["origin"] = json!(o);
    }
    r
}

#[tokio::test]
async fn h2_an_agent_connection_cannot_press_print_clear_the_bed_queue_or_claim_an_origin() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    let mut ag = agent(&link).await;
    let (f, sha) = file("cube.gcode", 3);
    for (i, (method, params)) in [
        (
            "print.local",
            json!({ "printerId": "bay-4", "file": f, "bedClear": true }),
        ),
        ("bed.confirmClear", json!({ "printerId": "bay-4" })),
        ("queue.add", json!({ "printerId": "bay-4", "file": f })),
        ("secrets.set", json!({ "name": "x", "value": "y" })),
        ("clients.list", json!({})),
        ("printers.add", json!({ "config": {} })),
        ("pair.listen", json!({ "enabled": true })),
        (
            "push.register",
            json!({ "token": "ExpoPushToken[aaaaaaaaaaaa]", "platform": "ios", "prefs": {} }),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let r = call(&mut ag, 10 + i as u64, method, params).await;
        assert_eq!(r["error"]["code"], "forbidden", "{method}: {r}");
    }
    assert_eq!(starts(&mock_log(&mocks).await), 0);
    // Whatever origin the agent sends, or none, its cards are agent cards.
    for (i, origin) in [Some("local_click"), Some("pilot"), None].into_iter().enumerate() {
        let id = format!("claim-{i}");
        let mut card = start_card(&id, "cube.gcode", &sha, origin);
        if origin == Some("local_click") {
            // The broker refuses local_click from anyone; the agent's claim never reaches it.
            card["origin"] = json!("local_click");
        }
        let work = json!({ "kind": "print", "printerId": "bay-4", "file": f });
        let r = call(
            &mut ag,
            30 + i as u64,
            "approvals.register",
            json!({ "request": card, "work": work }),
        )
        .await;
        assert_eq!(r["result"]["registered"], true, "{r}");
        let pending = call(&mut app, 40 + i as u64, "approvals.pending", json!({})).await;
        let mine = pending["result"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .cloned()
            .unwrap();
        assert_eq!(mine["origin"], "mcp", "{mine}");
    }
    // The app code with role agent gives agent; a remembered agent stays agent.
    let mut down = connect(&link).await;
    let pp = pairing::proof_params(&mut down, CODE, json!({ "role": "agent", "remember": true })).await;
    let r = call(&mut down, 1, "pair", pp).await;
    assert_eq!(r["result"]["role"], "agent", "{r}");
    let key = r["result"]["clientKey"].as_str().unwrap().to_owned();
    let mut back = connect(&link).await;
    let r = call(&mut back, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(r["result"]["role"], "agent", "{r}");
    let r = call(
        &mut back,
        2,
        "print.local",
        json!({ "printerId": "bay-4", "file": f }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
}

#[tokio::test]
async fn h3_an_mcp_start_runs_only_after_a_person_approves_it_in_the_app() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    let mut ag = agent(&link).await;
    let (f, sha) = file("cube.gcode", 5);
    let work = json!({ "kind": "print", "printerId": "bay-4", "file": f });

    // A person-only card needs its work, and the work must be exactly what the card shows.
    let r = call(
        &mut ag,
        2,
        "approvals.register",
        json!({ "request": start_card("no-work", "cube.gcode", &sha, None) }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    let (_, other_sha) = file("cube.gcode", 6);
    let r = call(
        &mut ag,
        3,
        "approvals.register",
        json!({ "request": start_card("swapped", "cube.gcode", &other_sha, None), "work": work }),
    )
    .await;
    assert_eq!(
        r["error"]["code"], "bad_request",
        "a card showing other content: {r}"
    );

    let r = call(
        &mut ag,
        4,
        "approvals.register",
        json!({ "request": start_card("mcp-1", "cube.gcode", &sha, Some("mcp")), "work": work }),
    )
    .await;
    assert_eq!(r["result"]["answeredIn"], "app", "{r}");
    // The app's card shows what the hub checked, not only the agent's words (review finding N3).
    let pending = call(&mut app, 30, "approvals.pending", json!({})).await;
    let card = pending["result"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "mcp-1")
        .unwrap()
        .clone();
    assert_eq!(card["work"]["kind"], "print", "{card}");
    assert_eq!(card["work"]["file"]["sha256"], sha.as_str(), "{card}");
    assert_eq!(card["work"]["file"]["name"], "cube.gcode", "{card}");
    assert!(card["work"]["file"]["sizeBytes"].as_u64().unwrap() > 0, "{card}");
    // The model cannot answer it, with or without the bed question.
    let r = call(
        &mut ag,
        5,
        "approvals.grant",
        json!({ "requestId": "mcp-1", "bedClear": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(starts(&mock_log(&mocks).await), 0);

    // A person approves in the app (or on a phone, through the app) and says the plate is clear.
    let r = call(
        &mut app,
        6,
        "approvals.grant",
        json!({ "requestId": "mcp-1", "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["runBy"], "hub", "{r}");
    assert!(r["result"]["token"].is_null(), "no token leaves the hub: {r}");
    let done = wait_event(&mut ag, "approval.done", |d| d["requestId"] == "mcp-1").await;
    assert_eq!(done["ok"], true, "{done}");
    assert_eq!(starts(&mock_log(&mocks).await), 1);

    // A G-code card from the agent works the same way and cannot be self-approved.
    let g_line = "M106 S128";
    let card = json!({
        "id": "g-1", "sessionId": "s", "tool": "printer.gcode", "permission": "start", "title": "Send M106", "lines": [],
        "printerId": "bay-4", "paramsHash": hash_of(&json!({})),
        "actions": [{ "action": "printer.gcode", "target": "bay-4", "paramsHash": hash_of(&json!({ "printerId": "bay-4", "line": g_line })) }],
        "expiresAt": "2099-01-01T00:00:00.000Z",
    });
    let r = call(
        &mut ag,
        7,
        "approvals.register",
        json!({ "request": card, "work": { "kind": "gcode", "printerId": "bay-4", "line": g_line } }),
    )
    .await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let r = call(&mut ag, 8, "approvals.grant", json!({ "requestId": "g-1" })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
}

#[tokio::test]
async fn m1_a_replayed_or_foreign_token_never_touches_the_bed() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    let cfg = json!({ "id": "bay-5", "name": "Bay 5", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let r = call(&mut ws, 3, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "bay-5", "{r}");
    let (f, sha) = file("cube.gcode", 7);
    let _ = call(
        &mut ws,
        4,
        "approvals.register",
        json!({ "request": start_card("c-1", "cube.gcode", &sha, Some("pilot")) }),
    )
    .await;
    let t = call(
        &mut ws,
        5,
        "approvals.grant",
        json!({ "requestId": "c-1", "bedClear": true }),
    )
    .await["result"]
        .clone();
    let up = call(
        &mut ws,
        6,
        "upload",
        json!({ "printerId": "bay-4", "file": f, "token": t }),
    )
    .await["result"]
        .clone();
    let r = call(&mut ws, 7, "start", json!({ "file": up, "token": t })).await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    mocks.set_state("moonraker", "finished").await;
    wait_bed(&mut ws, "not_cleared").await;

    // The same token again: refused, and the bed still reads not cleared.
    let r = call(&mut ws, 8, "start", json!({ "file": up, "token": t })).await;
    assert_eq!(r["error"]["code"], "approval_invalid", "{r}");
    assert_eq!(bed(&mut ws).await["state"], "not_cleared");
    // Sent at another printer: refused before that printer's bed is touched.
    let mut other = up.clone();
    other["printerId"] = json!("bay-5");
    let r = call(&mut ws, 9, "start", json!({ "file": other, "token": t })).await;
    assert_eq!(r["error"]["code"], "approval_invalid", "{r}");
    let b5 = call(&mut ws, 10, "bed.state", json!({ "printerId": "bay-5" })).await;
    assert_ne!(b5["result"]["state"], "clear", "{b5}");
    assert_eq!(starts(&mock_log(&mocks).await), 1);
}

#[tokio::test]
async fn m2_a_scheduled_cards_bed_answer_does_not_clear_the_printers_record() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    mocks.set_state("moonraker", "finished").await;
    let before = wait_bed(&mut ws, "not_cleared").await;
    let (f, _) = file("later.gcode", 8);
    let r = call(
        &mut ws,
        3,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f, "startAfterMs": now_ms() + 30 * 60 * 1000 }),
    )
    .await;
    let rid = r["result"]["request"]["id"].as_str().unwrap().to_owned();
    let r = call(
        &mut ws,
        4,
        "approvals.grant",
        json!({ "requestId": rid, "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["queued"], true, "{r}");
    // The answer is kept on the standing approval (and goes stale there), not on the printer.
    assert_eq!(bed(&mut ws).await["state"], before["state"]);
}

#[tokio::test]
async fn m3_a_start_token_covers_the_content_the_card_showed_not_just_the_name() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    let (a, sha_a) = file("plate.gcode", 11);
    let (b_file, sha_b) = file("plate.gcode", 12);
    let _ = call(
        &mut ws,
        3,
        "approvals.register",
        json!({ "request": start_card("a", "plate.gcode", &sha_a, Some("pilot")) }),
    )
    .await;
    let ta = call(
        &mut ws,
        4,
        "approvals.grant",
        json!({ "requestId": "a", "bedClear": true }),
    )
    .await["result"]
        .clone();
    let up_a = call(
        &mut ws,
        5,
        "upload",
        json!({ "printerId": "bay-4", "file": a, "token": ta }),
    )
    .await["result"]
        .clone();
    assert_eq!(up_a["sha256"], json!(sha_a), "{up_a}");
    // Someone sends different content under the same name before the start.
    let _ = call(
        &mut ws,
        6,
        "approvals.register",
        json!({ "request": start_card("b", "plate.gcode", &sha_b, Some("pilot")) }),
    )
    .await;
    let tb = call(&mut ws, 7, "approvals.grant", json!({ "requestId": "b" })).await["result"].clone();
    let _ = call(
        &mut ws,
        8,
        "upload",
        json!({ "printerId": "bay-4", "file": b_file, "token": tb }),
    )
    .await;
    // The first card's token no longer covers what is at that path, whatever hash the caller claims.
    let r = call(&mut ws, 9, "start", json!({ "file": up_a, "token": ta })).await;
    assert_eq!(r["error"]["code"], "approval_invalid", "{r}");
    assert_eq!(starts(&mock_log(&mocks).await), 0);
}

#[tokio::test]
async fn l1_wrong_codes_do_not_lock_out_a_remembered_client() {
    let link = hub(None).await;
    let mut first = connect(&link).await;
    let pp = pairing::proof_params(&mut first, CODE, json!({ "remember": true, "name": "Desk" })).await;
    let r = call(&mut first, 1, "pair", pp).await;
    let key = r["result"]["clientKey"].as_str().unwrap().to_owned();
    // Two sockets of five wrong codes reach the global limit of ten.
    for i in 0..2 {
        let mut ws = connect(&link).await;
        for n in 0..5 {
            let pp = pairing::proof_params(&mut ws, "WRONG-ONE", json!({})).await;
            let _ = call(&mut ws, 10 + i * 5 + n, "pair", pp).await;
        }
    }
    // Locked: even the first step of the exchange is refused, so no run gives another guess.
    let mut locked = connect(&link).await;
    let _ = call(
        &mut locked,
        1,
        "hello",
        json!({ "nonce": base64::engine::general_purpose::STANDARD.encode([5_u8; 32]) }),
    )
    .await;
    let r = call(
        &mut locked,
        2,
        "pair",
        json!({ "pake": base64::engine::general_purpose::STANDARD.encode([0_u8; 32]) }),
    )
    .await;
    assert_eq!(r["error"]["code"], "locked", "{r}");
    let mut known = connect(&link).await;
    let r = call(&mut known, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(r["result"]["paired"], true, "{r}");
}

#[tokio::test]
async fn l2_an_expired_card_cannot_be_approved() {
    let link = hub(None).await;
    let mut ws = paired(&link).await;
    let mut card = start_card("old", "cube.gcode", &"0".repeat(64), Some("pilot"));
    card["expiresAt"] = json!("2020-01-01T00:00:00.000Z");
    let r = call(&mut ws, 2, "approvals.register", json!({ "request": card })).await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let r = call(
        &mut ws,
        3,
        "approvals.grant",
        json!({ "requestId": "old", "bedClear": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "expired", "{r}");
}

// ---- print watch: changes during a print and failure detectors ----

fn adjust_card(id: &str, change: &Value) -> Value {
    json!({
        "id": id, "sessionId": "s", "tool": "printer.adjust", "permission": "start", "title": "Change the print", "lines": [],
        "printerId": "bay-4", "paramsHash": hash_of(&json!({})),
        "actions": [{ "action": "printer.adjust", "target": "bay-4", "paramsHash": hash_of(&json!({ "printerId": "bay-4", "change": change })) }],
        "expiresAt": "2099-01-01T00:00:00.000Z",
    })
}

#[tokio::test]
async fn a_mid_print_change_runs_only_inside_the_safe_limits() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    // Not printing: nothing may change.
    let fan = json!({ "kind": "fan", "fan": "part", "percent": 40 });
    let _ = call(
        &mut app,
        3,
        "approvals.register",
        json!({ "request": adjust_card("a-0", &fan) }),
    )
    .await;
    let t = call(&mut app, 4, "approvals.grant", json!({ "requestId": "a-0" })).await["result"].clone();
    let r = call(
        &mut app,
        5,
        "adjust",
        json!({ "printerId": "bay-4", "change": fan, "token": t }),
    )
    .await;
    assert_eq!(r["error"]["code"], "out_of_range", "{r}");

    mocks.set_state("moonraker", "printing").await;
    wait_bed(&mut app, "busy").await;
    let limits = call(&mut app, 6, "adjust.limits", json!({ "printerId": "bay-4" })).await;
    assert_eq!(limits["result"]["running"], true, "{limits}");
    assert_eq!(limits["result"]["speed"]["max"], 150, "{limits}");
    let r = call(
        &mut app,
        7,
        "adjust",
        json!({ "printerId": "bay-4", "change": fan, "token": t }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    // Above the limit: refused with the range, nothing sent, even with a valid card.
    let fast = json!({ "kind": "speed", "percent": 200 });
    let _ = call(
        &mut app,
        8,
        "approvals.register",
        json!({ "request": adjust_card("a-1", &fast) }),
    )
    .await;
    let t = call(&mut app, 9, "approvals.grant", json!({ "requestId": "a-1" })).await["result"].clone();
    let r = call(
        &mut app,
        10,
        "adjust",
        json!({ "printerId": "bay-4", "change": fast, "token": t }),
    )
    .await;
    assert_eq!(r["error"]["code"], "out_of_range", "{r}");
    assert!(
        r["error"]["message"].as_str().unwrap().contains("50 to 150"),
        "{r}"
    );
    // A token for one change does not cover another.
    let other = json!({ "kind": "fan", "fan": "part", "percent": 90 });
    let r = call(
        &mut app,
        11,
        "adjust",
        json!({ "printerId": "bay-4", "change": other, "token": t }),
    )
    .await;
    assert!(r["error"].is_object(), "{r}");
    let gcode: Vec<String> = mock_log(&mocks)
        .await
        .into_iter()
        .filter(|l| l.starts_with("gcode "))
        .collect();
    assert_eq!(
        gcode,
        vec!["gcode M106 S102".to_owned()],
        "only the approved, in-range change ran"
    );

    // From an agent: the card carries the work and only a person can approve it.
    let mut ag = agent(&link).await;
    let slow = json!({ "kind": "speed", "percent": 80 });
    let r = call(&mut ag, 2, "approvals.register", json!({ "request": adjust_card("a-2", &slow), "work": { "kind": "adjust", "printerId": "bay-4", "change": slow } })).await;
    assert_eq!(r["result"]["answeredIn"], "app", "{r}");
    let r = call(&mut ag, 3, "approvals.grant", json!({ "requestId": "a-2" })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let r = call(&mut app, 12, "approvals.grant", json!({ "requestId": "a-2" })).await;
    assert_eq!(r["result"]["runBy"], "hub", "{r}");
    let done = wait_event(&mut ag, "approval.done", |d| d["requestId"] == "a-2").await;
    assert_eq!(done["ok"], true, "{done}");
    assert!(mock_log(&mocks).await.contains(&"gcode M220 S80".to_owned()));
}

#[tokio::test]
async fn a_detector_gets_frames_while_printing_and_a_finding_can_pause() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    mocks.set_state("moonraker", "printing").await;
    wait_bed(&mut app, "busy").await;

    let mut det = agent(&link).await;
    let r = call(
        &mut det,
        2,
        "watch.subscribe",
        json!({ "everyMs": 2000, "printerIds": ["bay-4"] }),
    )
    .await;
    let sub = r["result"]["subscription"].clone();
    let frame = wait_event(&mut det, "watch.frame", |d| d["printerId"] == "bay-4").await;
    assert_eq!(frame["subscription"], sub, "{frame}");
    assert_eq!(frame["contentType"], "image/jpeg", "{frame}");
    let st = call(&mut app, 20, "status", json!({ "printerId": "bay-4" })).await;
    assert_eq!(st["result"]["watch"], "watching", "{st}");

    // A finding with auto-pause off only reports.
    let r = call(
        &mut det,
        3,
        "watch.report",
        json!({ "printerId": "bay-4", "kind": "spaghetti", "confidence": 0.95 }),
    )
    .await;
    assert_eq!(r["result"]["paused"], false, "{r}");
    let st = call(&mut app, 21, "status", json!({ "printerId": "bay-4" })).await;
    assert_eq!(st["result"]["watch"], "attention", "{st}");
    // Only the app turns auto-pause on.
    let r = call(
        &mut det,
        4,
        "watch.autoPause",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let r = call(
        &mut app,
        13,
        "watch.autoPause",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    assert_eq!(r["result"]["enabled"], true, "{r}");
    let s = call(&mut app, 14, "settings.get", json!({})).await;
    assert_eq!(
        s["result"]["watchAutoPausePrinters"],
        json!(["bay-4"]),
        "per printer: {s}"
    );
    let r = call(
        &mut det,
        5,
        "watch.report",
        json!({ "printerId": "bay-4", "kind": "detached", "confidence": 0.5 }),
    )
    .await;
    assert_eq!(r["result"]["paused"], false, "low confidence never pauses: {r}");
    // Unconfirmed (huginn did not agree) only notifies, however confident.
    let r = call(
        &mut det,
        9,
        "watch.report",
        json!({ "printerId": "bay-4", "kind": "spaghetti", "confidence": 0.95 }),
    )
    .await;
    assert_eq!(
        (r["result"]["paused"].clone(), r["result"]["confirmed"].clone()),
        (json!(false), json!(false)),
        "{r}"
    );
    let r = call(
        &mut det,
        10,
        "watch.report",
        json!({ "printerId": "bay-4", "kind": "spaghetti", "confidence": 0.9, "confirmed": "yes" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    // huginn per printer: the app turns it on (audited), detectors read it, agents cannot set it.
    let r = call(
        &mut det,
        11,
        "watch.huginn",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let r = call(
        &mut app,
        15,
        "watch.huginn",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    assert_eq!(r["result"]["enabled"], true, "{r}");
    let mut watcher = connect(&link).await;
    let pp = pairing::proof_params(&mut watcher, WATCH_CODE, json!({})).await;
    let _ = call(&mut watcher, 1, "pair", pp).await;
    let r = call(&mut watcher, 2, "watch.huginnPrinters", json!({})).await;
    assert_eq!(r["result"], json!(["bay-4"]), "{r}");
    let r = call(
        &mut det,
        6,
        "watch.report",
        json!({ "printerId": "bay-4", "kind": "spaghetti", "confidence": 0.9, "note": "bottom left", "confirmed": true }),
    )
    .await;
    assert_eq!(r["result"]["paused"], true, "{r}");
    assert!(
        mock_log(&mocks).await.iter().any(|l| l.starts_with("pause")),
        "{:?}",
        mock_log(&mocks).await
    );
    let r = call(
        &mut det,
        7,
        "watch.report",
        json!({ "printerId": "bay-4", "kind": "melted", "confidence": 2 }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    // A printer no detector covers reads off.
    let other = json!({ "id": "bay-6", "name": "Bay 6", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let _ = call(&mut app, 22, "printers.add", json!({ "config": other })).await;
    let r = call(&mut det, 8, "watch.unsubscribe", json!({ "subscription": sub })).await;
    assert_eq!(r["result"]["unsubscribed"], true, "{r}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let st = call(&mut app, 23, "status", json!({ "printerId": "bay-6" })).await;
    assert_eq!(st["result"]["watch"], "off", "{st}");
}

// ---- re-review findings ----

#[tokio::test]
async fn n1_an_agent_cannot_test_a_printer_at_an_address_it_chooses() {
    let link = hub(None).await;
    let mut ag = agent(&link).await;
    let cfg = json!({ "id": "x", "name": "x", "plugin": "octoprint", "host": "127.0.0.1", "port": 9, "credentialRef": "printer/bay-2/key" });
    let r = call(&mut ag, 2, "printers.test", json!({ "config": cfg })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
}

#[tokio::test]
async fn n5_an_agent_cannot_switch_a_home_assistant_plug() {
    let link = hub(None).await;
    let mut ag = agent(&link).await;
    let r = call(&mut ag, 2, "callTool", json!({ "pluginId": "home-assistant", "tool": "call_service", "input": { "domain": "switch", "service": "turn_off", "entityId": "switch.printer" } })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let card = json!({
        "id": "ha-1", "sessionId": "s", "tool": "home-assistant.call_service", "permission": "printer_config", "title": "Switch off", "lines": [],
        "paramsHash": hash_of(&json!({})),
        "actions": [{ "action": "plugin.call", "target": "home-assistant", "paramsHash": hash_of(&json!({ "pluginId": "home-assistant", "tool": "call_service", "input": {} })) }],
        "expiresAt": "2099-01-01T00:00:00.000Z",
    });
    let r = call(&mut ag, 3, "approvals.register", json!({ "request": card })).await;
    assert_eq!(
        r["error"]["code"], "bad_request",
        "a person-only card without work: {r}"
    );
}

#[tokio::test]
async fn n6_agents_do_not_see_the_apps_events() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    let mut ag = agent(&link).await;
    let _ = call(&mut app, 3, "bed.confirmClear", json!({ "printerId": "bay-4" })).await;
    let (f, sha) = file("cube.gcode", 21);
    let _ = call(
        &mut app,
        4,
        "approvals.register",
        json!({ "request": start_card("app-card", "cube.gcode", &sha, Some("pilot")) }),
    )
    .await;
    let _ = call(
        &mut app,
        5,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f, "startAfterMs": now_ms() + 60_000 }),
    )
    .await;
    let mut seen = Vec::new();
    let end = tokio::time::Instant::now() + Duration::from_millis(800);
    while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout_at(end, ag.next()).await {
        seen.push(t.to_string());
    }
    assert!(seen.is_empty(), "the agent saw: {seen:?}");
    let p = call(&mut ag, 6, "approvals.pending", json!({})).await;
    assert_eq!(p["result"], json!([]), "{p}");
}

#[tokio::test]
async fn m3_an_agent_start_of_a_file_the_hub_did_not_upload_is_refused() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    let card = json!({
        "id": "old-1", "sessionId": "s", "tool": "printer.start", "permission": "start", "title": "Start old.gcode", "lines": [],
        "printerId": "bay-4", "paramsHash": hash_of(&json!({})), "origin": "mcp",
        "actions": [{ "action": "printer.start", "target": "bay-4", "paramsHash": hash_of(&json!({ "printerId": "bay-4", "name": "old.gcode", "opts": {} })) }],
        "expiresAt": "2099-01-01T00:00:00.000Z",
    });
    let _ = call(&mut app, 3, "approvals.register", json!({ "request": card })).await;
    let t = call(
        &mut app,
        4,
        "approvals.grant",
        json!({ "requestId": "old-1", "bedClear": true }),
    )
    .await["result"]
        .clone();
    let rf = json!({ "printerId": "bay-4", "path": "old.gcode", "name": "old.gcode" });
    let r = call(&mut app, 5, "start", json!({ "file": rf, "token": t })).await;
    assert_eq!(r["error"]["code"], "unverified_file", "{r}");
    assert_eq!(starts(&mock_log(&mocks).await), 0);
}

/// A start card for `name` that binds the name only (no content hash), as a card for a file that
/// is already on the printer does.
fn by_name_card(id: &str, name: &str, origin: Option<&str>) -> Value {
    let mut r = json!({
        "id": id, "sessionId": "s", "tool": "printer.start", "permission": "start", "title": format!("Start {name}"), "lines": [],
        "printerId": "bay-4", "paramsHash": hash_of(&json!({})),
        "actions": [{ "action": "printer.start", "target": "bay-4", "paramsHash": hash_of(&json!({ "printerId": "bay-4", "name": name, "opts": {} })) }],
        "expiresAt": "2099-01-01T00:00:00.000Z",
    });
    if let Some(o) = origin {
        r["origin"] = json!(o);
    }
    r
}

/// Registers and grants a by-name card for `old.gcode` on Bay 4, a file this hub never uploaded,
/// and starts it with the card's token.
async fn start_by_name(app: &mut Ws, card: &str, origin: Option<&str>) -> Value {
    let r = call(
        app,
        50,
        "approvals.register",
        json!({ "request": by_name_card(card, "old.gcode", origin) }),
    )
    .await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let t = call(
        app,
        51,
        "approvals.grant",
        json!({ "requestId": card, "bedClear": true }),
    )
    .await["result"]
        .clone();
    let rf = json!({ "printerId": "bay-4", "path": "old.gcode", "name": "old.gcode" });
    call(app, 52, "start", json!({ "file": rf, "token": t })).await
}

/// Every start an AI asks for, mimir (`pilot`) as well as an outside
/// agent (`mcp`), is tied to a file whose hash this hub verified. A person's own card keeps
/// binding by name.
#[tokio::test]
async fn ai_starts_need_a_file_the_hub_uploaded_and_a_persons_start_does_not() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    // old.gcode goes on the printer some other way (here another hub), so this hub has no record of it.
    let elsewhere = hub(None).await;
    let mut other = paired(&elsewhere).await;
    add_bay4(&mut other, &mocks).await;
    let (f, sha) = file("old.gcode", 60);
    let t = granted(&mut other, "other-1", "old.gcode", &sha).await;
    let r = call(
        &mut other,
        9,
        "upload",
        json!({ "printerId": "bay-4", "file": f, "token": t }),
    )
    .await;
    assert_eq!(r["result"]["name"], "old.gcode", "{r}");

    // mimir and an outside agent: refused, in words that say what to do, before the printer hears anything.
    for (card, origin) in [("mimir-1", "pilot"), ("agent-1", "mcp")] {
        let r = start_by_name(&mut app, card, Some(origin)).await;
        assert_eq!(r["error"]["code"], "unverified_file", "{origin}: {r}");
        let msg = r["error"]["message"].as_str().unwrap();
        assert!(
            msg.contains("Upload the file through SlicerX, then start it"),
            "{msg}"
        );
    }
    assert_eq!(starts(&mock_log(&mocks).await), 0);

    // mimir's card bound the hash of a file the hub uploaded, and the printer then got other
    // content behind the hub's back: the same refusal, not a bare mismatch.
    let (f, sha) = file("plate.gcode", 61);
    let t = granted(&mut app, "mimir-2", "plate.gcode", &sha).await;
    let up = call(
        &mut app,
        30,
        "upload",
        json!({ "printerId": "bay-4", "file": f, "token": t }),
    )
    .await["result"]
        .clone();
    mocks.replace_file("moonraker", "plate.gcode").await;
    let r = call(&mut app, 31, "start", json!({ "file": up, "token": t })).await;
    assert_eq!(r["error"]["code"], "unverified_file", "{r}");
    assert_eq!(starts(&mock_log(&mocks).await), 0);

    // mimir's start of a file the hub uploaded and still vouches for runs.
    let (f, sha) = file("part.gcode", 62);
    let t = granted(&mut app, "mimir-3", "part.gcode", &sha).await;
    let up = call(
        &mut app,
        32,
        "upload",
        json!({ "printerId": "bay-4", "file": f, "token": t }),
    )
    .await["result"]
        .clone();
    let r = call(&mut app, 33, "start", json!({ "file": up, "token": t })).await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    assert_eq!(starts(&mock_log(&mocks).await), 1);

    // A person's own card for the same unverified file (the app's queued start, a phone) still
    // binds by name, as before.
    mocks.set_state("moonraker", "idle").await;
    for (n, (card, origin)) in [("person-1", None), ("phone-1", Some("phone"))]
        .into_iter()
        .enumerate()
    {
        let r = start_by_name(&mut app, card, origin).await;
        assert_eq!(r["result"]["ok"], true, "{origin:?}: {r}");
        assert_eq!(starts(&mock_log(&mocks).await), n + 2);
        mocks.set_state("moonraker", "idle").await;
    }
}

/// Runs the first step of the code exchange on `ws` and returns the client and its confirm params.
async fn pake_run(
    ws: &mut Ws,
    ctx: &sx_cpace::pair::Context<'_>,
    code: &str,
    id: u64,
) -> (sx_cpace::pair::Start, Value) {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut start = sx_cpace::pair::Start::new(code, ctx, [u8::try_from(id).unwrap(); 32]);
    let r = call(ws, id, "pair", json!({ "pake": b64.encode(start.ya) })).await;
    assert!(
        !r.to_string().contains(code),
        "nothing the hub says contains a code"
    );
    let messages: Vec<(&str, Vec<u8>)> = sx_cpace::pair::ROLES
        .iter()
        .map(|role| {
            (
                *role,
                b64.decode(r["result"]["pake"][*role].as_str().unwrap()).unwrap(),
            )
        })
        .collect();
    let tags: serde_json::Map<String, Value> = start
        .respond(&messages)
        .unwrap()
        .into_iter()
        .map(|(role, t)| (role.to_owned(), json!(b64.encode(t))))
        .collect();
    (start, json!({ "confirm": tags }))
}

#[tokio::test]
async fn m5_n9_the_hub_proves_its_key_and_the_code_is_never_testable_offline() {
    use ring::signature::{ED25519, UnparsedPublicKey};
    let dir = temp_dir("hello");
    let link = hub(Some(dir.clone())).await;
    let port = link.addr().port();
    let b64 = base64::engine::general_purpose::STANDARD;
    let hello = |nonce: [u8; 32]| json!({ "nonce": b64.encode(nonce) });
    let mut ws = connect(&link).await;
    let nonce = [9_u8; 32];
    let r = call(&mut ws, 1, "hello", hello(nonce)).await["result"].clone();
    let key = r["hubKey"].as_str().unwrap().to_owned();
    assert_eq!(key, link.hub_key());
    assert_eq!(r["port"], port);
    assert_eq!(
        sx_link::read_hub_key(&dir).unwrap(),
        key,
        "the MCP server reads it from the state directory"
    );
    let hub_nonce = b64.decode(r["hubNonce"].as_str().unwrap()).unwrap();
    let mut msg = sx_link::HELLO_CONTEXT.to_vec();
    msg.extend_from_slice(&nonce);
    msg.extend_from_slice(&hub_nonce);
    msg.extend_from_slice(&port.to_be_bytes());
    let sig = b64.decode(r["sig"].as_str().unwrap()).unwrap();
    let key_bytes = b64.decode(&key).unwrap();
    UnparsedPublicKey::new(&ED25519, &key_bytes)
        .verify(&msg, &sig)
        .unwrap();
    // A hello is not a pairing.
    let r = call(&mut ws, 2, "list", json!({})).await;
    assert_eq!(r["error"]["code"], "unauthorized", "{r}");

    // A version 1 proof (an HMAC of the code) and a code in clear are refused unread.
    let r = call(&mut ws, 3, "pair", json!({ "proof": b64.encode([0_u8; 32]) })).await;
    assert!(
        r["error"]["message"].as_str().unwrap().contains("update the app"),
        "{r}"
    );
    let r = call(&mut ws, 4, "pair", json!({ "code": AGENT_CODE })).await;
    assert_eq!(r["error"]["code"], "unauthorized", "{r}");

    // The code exchange, bound to the hello: the hub answers with one message per code.
    let ctx = sx_cpace::pair::Context {
        hub_key: &key_bytes,
        port,
        client_nonce: &nonce,
        hub_nonce: &hub_nonce,
    };
    let wrong = pake_run(&mut ws, &ctx, "WRONGCOD", 5).await.1;
    // A wrong code: no pairing, and the hub sends no confirm a guesser could test.
    let r = call(&mut ws, 6, "pair", wrong.clone()).await;
    assert_eq!(r["error"]["code"], "unauthorized", "{r}");
    // A confirm is good for one run: sent again, it pairs nothing.
    let r = call(&mut ws, 7, "pair", wrong).await;
    assert_eq!(r["error"]["code"], "unauthorized", "{r}");
    let (start, right) = pake_run(&mut ws, &ctx, AGENT_CODE, 8).await;
    let r = call(&mut ws, 9, "pair", right.clone()).await;
    assert_eq!(r["result"]["role"], "agent", "{r}");
    // The hub proves it holds the same code: the client can pin its key now, not on trust.
    let confirm = b64.decode(r["result"]["confirm"].as_str().unwrap()).unwrap();
    assert!(start.hub_confirmed(&confirm));
    // A confirm from one connection's exchange does not pair another connection.
    let mut other = connect(&link).await;
    let _ = call(&mut other, 1, "hello", hello([1_u8; 32])).await;
    let r = call(&mut other, 2, "pair", right).await;
    assert_eq!(r["error"]["code"], "unauthorized", "a replayed confirm: {r}");
    // The key survives a restart, so a pinned key keeps working.
    drop(link);
    let again = hub(Some(dir)).await;
    assert_eq!(again.hub_key(), key);
}

#[tokio::test]
async fn n4_with_the_keychain_the_app_code_is_not_on_disk_beside_the_agent_code() {
    let dir = temp_dir("codes");
    let secrets = Arc::new(MemorySecrets::new());
    let broker = Arc::new(ApprovalBroker::new().unwrap());
    let cfg = LinkConfig {
        port: 0,
        fixed_code: Some(CODE.to_owned()),
        fixed_agent_code: Some(AGENT_CODE.to_owned()),
        state_dir: Some(dir.clone()),
        push_url: String::new(),
        code_in_secrets: true,
        ..LinkConfig::default()
    };
    let _link = serve_with_approvals(
        cfg,
        Arc::new(BrokerGate(broker.clone())),
        secrets.clone(),
        Some(broker),
    )
    .await
    .unwrap();
    assert!(!dir.join("pairing-code").exists());
    assert_eq!(sx_link::read_agent_code(&dir).unwrap(), "AGNT-CODE");
    assert_eq!(
        sx_connect::Secrets::get(secrets.as_ref(), sx_link::APP_CODE_SECRET).as_deref(),
        Some("TEST-CODE")
    );
}

#[tokio::test]
async fn n8_a_file_changed_behind_the_hubs_back_reads_as_unverified() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    let (f, sha) = file("plate.gcode", 31);
    let _ = call(
        &mut app,
        3,
        "approvals.register",
        json!({ "request": start_card("p-1", "plate.gcode", &sha, Some("pilot")) }),
    )
    .await;
    let t = call(
        &mut app,
        4,
        "approvals.grant",
        json!({ "requestId": "p-1", "bedClear": true }),
    )
    .await["result"]
        .clone();
    let up = call(
        &mut app,
        5,
        "upload",
        json!({ "printerId": "bay-4", "file": f, "token": t }),
    )
    .await["result"]
        .clone();
    // Someone swaps the file on the printer (USB stick, the printer's screen).
    mocks.replace_file("moonraker", "plate.gcode").await;
    let r = call(&mut app, 6, "start", json!({ "file": up, "token": t })).await;
    // mimir's card (origin `pilot`): the AI start refusal, which says to upload the file again.
    assert_eq!(r["error"]["code"], "unverified_file", "{r}");
    assert_eq!(starts(&mock_log(&mocks).await), 0);
}

/// Registers and grants a start card for `name` with content `sha` on Bay 4 and returns its token.
async fn granted(ws: &mut Ws, id: &str, name: &str, sha: &str) -> Value {
    let r = call(
        ws,
        40,
        "approvals.register",
        json!({ "request": start_card(id, name, sha, Some("pilot")) }),
    )
    .await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let t = call(
        ws,
        41,
        "approvals.grant",
        json!({ "requestId": id, "bedClear": true }),
    )
    .await;
    assert!(t["result"]["token"].is_string(), "{t}");
    t["result"].clone()
}

#[tokio::test]
async fn n7_an_upload_in_flight_holds_a_start_and_two_starts_run_once() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    let mut other = paired(&link).await;
    let r = call(&mut app, 3, "bed.confirmClear", json!({ "printerId": "bay-4" })).await;
    assert!(r["error"].is_null(), "{r}");

    // A person approved plate.gcode with content A, and the hub put it on the printer.
    let (fa, sha_a) = file("plate.gcode", 51);
    let ta = granted(&mut app, "a-1", "plate.gcode", &sha_a).await;
    let rf = call(
        &mut app,
        4,
        "upload",
        json!({ "printerId": "bay-4", "file": fa, "token": ta }),
    )
    .await["result"]
        .clone();
    assert_eq!(rf["name"], "plate.gcode", "{rf}");

    // Another caller is already uploading content B under the same name, slowly, when the start
    // begins. The start waits for that upload, then sees B and refuses: A's approval never covers B.
    let (fb, sha_b) = file("plate.gcode", 52);
    let tb = granted(&mut other, "b-1", "plate.gcode", &sha_b).await;
    mocks.set_upload_delay("moonraker", 1500).await;
    let upload = async {
        let r = call(
            &mut other,
            10,
            "upload",
            json!({ "printerId": "bay-4", "file": fb, "token": tb }),
        )
        .await;
        (r, tokio::time::Instant::now())
    };
    let start = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let r = call(&mut app, 11, "start", json!({ "file": rf, "token": ta })).await;
        (r, tokio::time::Instant::now())
    };
    let ((up, up_at), (st, st_at)) = tokio::join!(upload, start);
    assert!(up["error"].is_null(), "the upload went through: {up}");
    assert_eq!(st["error"]["code"], "approval_invalid", "{st}");
    assert!(
        st_at >= up_at,
        "the start answered before the upload it raced had landed"
    );
    assert_eq!(starts(&mock_log(&mocks).await), 0, "nothing started");

    // Two callers start the same file at the same moment, each with its own approval: one print.
    mocks.set_upload_delay("moonraker", 0).await;
    let (fa, sha_a) = file("plate.gcode", 51);
    let t1 = granted(&mut app, "c-1", "plate.gcode", &sha_a).await;
    let t2 = granted(&mut other, "c-2", "plate.gcode", &sha_a).await;
    let rf = call(
        &mut app,
        12,
        "upload",
        json!({ "printerId": "bay-4", "file": fa, "token": t1 }),
    )
    .await["result"]
        .clone();
    let (r1, r2) = tokio::join!(
        call(&mut app, 13, "start", json!({ "file": rf, "token": t1 })),
        call(&mut other, 14, "start", json!({ "file": rf, "token": t2 })),
    );
    let ok = [&r1, &r2].iter().filter(|r| r["result"]["ok"] == true).count();
    assert_eq!(ok, 1, "exactly one start went through: {r1} {r2}");
    let refused = if r1["result"]["ok"] == true { &r2 } else { &r1 };
    assert_eq!(refused["error"]["code"], "busy", "{refused}");
    assert_eq!(starts(&mock_log(&mocks).await), 1, "{:?}", mock_log(&mocks).await);
}

#[tokio::test]
async fn n6_agents_list_no_queue_items_or_deliveries() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    let (f, _) = file("later.gcode", 41);
    let _ = call(
        &mut app,
        3,
        "queue.add",
        json!({ "printerId": "bay-4", "file": f, "startAfterMs": now_ms() + 60_000 }),
    )
    .await;
    let mut ag = agent(&link).await;
    let r = call(&mut ag, 2, "queue.list", json!({})).await;
    assert_eq!(r["result"], json!([]), "{r}");
    let r = call(&mut app, 4, "queue.list", json!({})).await;
    assert_eq!(r["result"].as_array().unwrap().len(), 1, "{r}");
    let r = call(&mut ag, 3, "inbox.list", json!({})).await;
    assert_eq!(r["result"], json!([]), "{r}");
}

// ---- the detector's own role, masks, "this is fine", heaters after a pause ----

#[tokio::test]
async fn a_detector_pairs_as_watch_and_sees_only_frames_masks_and_dismissals() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    let mut det = connect(&link).await;
    let pp = pairing::proof_params(&mut det, WATCH_CODE, json!({ "role": "agent" })).await;
    let r = call(&mut det, 1, "pair", pp).await;
    assert_eq!(r["result"]["role"], "watch", "asking for agent never widens: {r}");
    for (i, m) in [
        "list",
        "status",
        "camera.grab",
        "approvals.register",
        "print.local",
        "settings.get",
        "watch.mask",
    ]
    .iter()
    .enumerate()
    {
        let r = call(&mut det, 10 + i as u64, m, json!({ "printerId": "bay-4" })).await;
        assert_eq!(r["error"]["code"], "forbidden", "{m}: {r}");
    }
    // The app draws the bed mask; the detector reads it. Bad polygons are refused.
    let r = call(
        &mut app,
        3,
        "watch.mask",
        json!({ "printerId": "bay-4", "polygon": [[0.1, 0.2], [0.9, 0.2], [0.9, 2.0]] }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    let poly = json!([[0.1, 0.2], [0.9, 0.2], [0.9, 0.95], [0.1, 0.95]]);
    let r = call(
        &mut app,
        4,
        "watch.mask",
        json!({ "printerId": "bay-4", "polygon": poly }),
    )
    .await;
    assert_eq!(r["result"]["polygon"], poly, "{r}");
    let r = call(&mut det, 20, "watch.masks", json!({})).await;
    assert_eq!(r["result"]["bay-4"], poly, "{r}");

    mocks.set_state("moonraker", "printing").await;
    wait_bed(&mut app, "busy").await;
    let r = call(&mut det, 21, "watch.subscribe", json!({ "everyMs": 2000 })).await;
    assert!(r["result"]["subscription"].is_number(), "{r}");
    let frame = wait_event(&mut det, "watch.frame", |d| d["printerId"] == "bay-4").await;
    assert_eq!(frame["state"], "printing", "{frame}");
    assert!(
        frame.get("layer").is_some() && frame.get("layerCount").is_some(),
        "{frame}"
    );
    let r = call(
        &mut det,
        22,
        "watch.report",
        json!({ "printerId": "bay-4", "kind": "nozzle_blob", "confidence": 0.7 }),
    )
    .await;
    assert_eq!(r["result"]["recorded"], true, "{r}");

    // "This is fine" from the app reaches the detector; the app's other events do not.
    let _ = call(&mut app, 5, "bed.state", json!({ "printerId": "bay-4" })).await;
    let r = call(
        &mut app,
        6,
        "watch.dismiss",
        json!({ "printerId": "bay-4", "kind": "nozzle_blob" }),
    )
    .await;
    assert_eq!(r["result"]["dismissed"], true, "{r}");
    let mut seen = Vec::new();
    let end = tokio::time::Instant::now() + Duration::from_millis(1500);
    while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout_at(end, det.next()).await {
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["event"] != "watch.frame" {
            seen.push(v["event"].as_str().unwrap_or("").to_owned());
        }
    }
    assert_eq!(seen, vec!["watch.dismissed".to_owned()], "{seen:?}");
    let st = call(&mut app, 7, "status", json!({ "printerId": "bay-4" })).await;
    assert_ne!(st["result"]["watch"], "attention", "dismissed: {st}");
}

#[tokio::test]
async fn an_unanswered_watch_pause_turns_the_bed_then_the_nozzle_off() {
    let dir = temp_dir("heaters");
    let broker = Arc::new(ApprovalBroker::new().unwrap());
    let cfg = LinkConfig {
        port: 0,
        fixed_code: Some(CODE.to_owned()),
        fixed_agent_code: Some(AGENT_CODE.to_owned()),
        fixed_watch_code: Some(WATCH_CODE.to_owned()),
        state_dir: Some(dir.clone()),
        watch_every: Duration::from_millis(100),
        push_url: String::new(),
        pause_bed_off_after: Duration::from_millis(600),
        pause_heaters_off_after: Duration::from_millis(1500),
        ..LinkConfig::default()
    };
    let link = serve_with_approvals(
        cfg,
        Arc::new(BrokerGate(broker.clone())),
        Arc::new(MemorySecrets::new()),
        Some(broker),
    )
    .await
    .unwrap();
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    mocks.set_state("moonraker", "printing").await;
    wait_bed(&mut app, "busy").await;
    let _ = call(
        &mut app,
        3,
        "watch.autoPause",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    let mut det = connect(&link).await;
    let pp = pairing::proof_params(&mut det, WATCH_CODE, json!({})).await;
    let _ = call(&mut det, 1, "pair", pp).await;
    let r = call(
        &mut det,
        2,
        "watch.report",
        json!({ "printerId": "bay-4", "kind": "spaghetti", "confidence": 0.92, "confirmed": true }),
    )
    .await;
    assert_eq!(r["result"]["paused"], true, "{r}");
    // The bed goes first, the nozzle later; nothing else is sent.
    let mut log = Vec::new();
    for _ in 0..60 {
        log = mock_log(&mocks).await;
        if log.iter().any(|l| l == "gcode M104 S0") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let gcode: Vec<&String> = log.iter().filter(|l| l.starts_with("gcode ")).collect();
    assert_eq!(gcode, vec!["gcode M140 S0", "gcode M104 S0"], "{log:?}");
    let audit = std::fs::read_to_string(dir.join("audit.jsonl")).unwrap();
    for needle in [
        "\"action\":\"printer.pause\"",
        "\"step\":\"bed_off\"",
        "\"step\":\"heaters_off\"",
    ] {
        assert!(audit.contains(needle), "{needle} missing from {audit}");
    }
    assert!(audit.lines().all(|l| l.contains("\"origin\"")), "{audit}");
}

#[tokio::test]
async fn an_answered_watch_pause_keeps_its_heaters() {
    let broker = Arc::new(ApprovalBroker::new().unwrap());
    let cfg = LinkConfig {
        port: 0,
        fixed_code: Some(CODE.to_owned()),
        fixed_watch_code: Some(WATCH_CODE.to_owned()),
        watch_every: Duration::from_millis(100),
        push_url: String::new(),
        pause_bed_off_after: Duration::from_millis(800),
        pause_heaters_off_after: Duration::from_millis(1200),
        ..LinkConfig::default()
    };
    let link = serve_with_approvals(
        cfg,
        Arc::new(BrokerGate(broker.clone())),
        Arc::new(MemorySecrets::new()),
        Some(broker),
    )
    .await
    .unwrap();
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    mocks.set_state("moonraker", "printing").await;
    wait_bed(&mut app, "busy").await;
    let _ = call(
        &mut app,
        3,
        "watch.autoPause",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    let mut det = connect(&link).await;
    let pp = pairing::proof_params(&mut det, WATCH_CODE, json!({})).await;
    let _ = call(&mut det, 1, "pair", pp).await;
    let r = call(
        &mut det,
        2,
        "watch.report",
        json!({ "printerId": "bay-4", "kind": "detached", "confidence": 0.9, "confirmed": true }),
    )
    .await;
    assert_eq!(r["result"]["paused"], true, "{r}");
    // The person resumes from the printer: the watch forgets the pause.
    mocks.set_state("moonraker", "printing").await;
    tokio::time::sleep(Duration::from_millis(2000)).await;
    let log = mock_log(&mocks).await;
    assert!(!log.iter().any(|l| l.starts_with("gcode M1")), "{log:?}");
}

#[tokio::test]
async fn the_app_creates_an_agent_key_shown_once_and_revoking_it_cuts_the_agent_off() {
    let link = hub(None).await;
    let mut app = paired(&link).await;
    let r = call(
        &mut app,
        2,
        "clients.create",
        json!({ "name": "ChatGPT", "role": "app" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "no app keys from here: {r}");
    let r = call(
        &mut app,
        3,
        "clients.create",
        json!({ "name": "ChatGPT", "role": "agent" }),
    )
    .await;
    let key = r["result"]["clientKey"].as_str().unwrap().to_owned();
    let id = r["result"]["clientId"].clone();
    assert_eq!(r["result"]["role"], "agent", "{r}");
    let list = call(&mut app, 4, "clients.list", json!({})).await;
    assert_eq!(list["result"][0]["name"], "ChatGPT", "{list}");
    assert_eq!(list["result"][0]["role"], "agent", "{list}");
    assert!(!list.to_string().contains(&key), "the key is never shown again");

    let mut ag = connect(&link).await;
    let r = call(&mut ag, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(r["result"]["role"], "agent", "{r}");
    let r = call(
        &mut ag,
        2,
        "clients.create",
        json!({ "name": "x", "role": "agent" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "an agent cannot mint keys: {r}");
    let r = call(&mut app, 5, "clients.revoke", json!({ "clientId": id })).await;
    assert_eq!(r["result"]["revoked"], true, "{r}");
    let r = call(&mut ag, 3, "list", json!({})).await;
    assert_eq!(r["closed"], true, "the live connection is closed: {r}");
    let mut again = connect(&link).await;
    let r = call(&mut again, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(r["error"]["code"], "unauthorized", "{r}");
}

// ---- partner apps ----

/// Makes a partner key from the app and pairs a connection with it.
async fn partner(link: &Link, app: &mut Ws, name: &str) -> (Ws, String, Value) {
    let r = call(
        app,
        90,
        "clients.create",
        json!({ "name": name, "role": "agent", "partner": true }),
    )
    .await;
    let key = r["result"]["clientKey"].as_str().unwrap().to_owned();
    let id = r["result"]["clientId"].clone();
    let mut ws = connect(link).await;
    let r = call(&mut ws, 1, "pair", json!({ "clientKey": key, "role": "watch" })).await;
    assert_eq!(
        r["result"]["role"], "agent",
        "a partner never narrows to a detector: {r}"
    );
    assert_eq!(r["result"]["partner"], true, "{r}");
    (ws, key, id)
}

fn card(id: &str, tool: &str, action: &str, params: &Value) -> Value {
    json!({
        "id": id, "sessionId": "s", "tool": tool, "permission": "start", "title": id, "lines": ["The partner's words"],
        "printerId": "bay-4", "paramsHash": hash_of(&json!({})),
        "actions": [{ "action": action, "target": "bay-4", "paramsHash": hash_of(params) }],
        "expiresAt": "2099-01-01T00:00:00.000Z",
    })
}

#[tokio::test]
async fn a_partner_key_is_named_shown_once_listed_and_kept_across_a_restart() {
    let dir = temp_dir("partner");
    let link = hub(Some(dir.clone())).await;
    let mut app = paired(&link).await;
    for bad in [
        json!({ "name": "LayerMate", "role": "watch", "partner": true }),
        json!({ "name": "LayerMate", "role": "app", "partner": true }),
        json!({ "name": " ", "role": "agent", "partner": true }),
    ] {
        let r = call(&mut app, 2, "clients.create", bad).await;
        assert_eq!(r["error"]["code"], "bad_request", "{r}");
    }
    let r = call(
        &mut app,
        3,
        "clients.create",
        json!({ "name": "LayerMate", "role": "agent", "partner": true }),
    )
    .await;
    let key = r["result"]["clientKey"].as_str().unwrap().to_owned();
    assert_eq!(r["result"]["role"], "agent", "{r}");
    assert_eq!(r["result"]["partner"], true, "{r}");
    assert!(
        key.starts_with("sxp_") && key.len() == 68,
        "sxp_ and 64 hex digits"
    );
    assert!(key[4..].bytes().all(|b| b.is_ascii_hexdigit()));
    // A second key for the same partner is its own entry, revoked on its own.
    let r2 = call(
        &mut app,
        4,
        "clients.create",
        json!({ "name": "LayerMate", "role": "agent", "partner": true }),
    )
    .await;
    assert_ne!(r2["result"]["clientKey"], r["result"]["clientKey"]);
    let list = call(&mut app, 5, "clients.list", json!({})).await;
    let rows = list["result"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{list}");
    assert!(
        rows.iter()
            .all(|c| c["partner"] == true && c["name"] == "LayerMate"),
        "{list}"
    );
    assert!(rows[0]["lastSeenAt"].is_null(), "not used yet: {list}");
    assert!(
        !list.to_string().contains(&key[4..]),
        "the key is never shown again"
    );

    let mut p = connect(&link).await;
    let r = call(&mut p, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(r["result"]["partner"], true, "{r}");
    let list = call(&mut app, 6, "clients.list", json!({})).await;
    assert!(list["result"][0]["lastSeenAt"].is_string(), "{list}");
    // Neither the key nor its hash is in the saved state in a form that pairs.
    drop((p, app));
    drop(link);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let saved = std::fs::read_to_string(dir.join("hub.json")).unwrap();
    assert!(!saved.contains(&key[4..]), "only the hash is saved");
    let link = hub(Some(dir.clone())).await;
    let mut p = connect(&link).await;
    let r = call(&mut p, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(
        r["result"]["partner"], true,
        "still a partner after a restart: {r}"
    );
    let r = call(&mut p, 2, "approvals.grant", json!({ "requestId": "x" })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_partner_app_pauses_and_cancels_but_never_approves_a_start_resumes_sends_gcode_or_adjusts() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    let (mut p, _, _) = partner(&link, &mut app, "LayerMate").await;
    let r = call(&mut p, 2, "list", json!({})).await;
    assert_eq!(r["result"][0]["id"], "bay-4", "{r}");
    let r = call(&mut p, 3, "status", json!({ "printerId": "bay-4" })).await;
    assert!(r["result"].is_object(), "{r}");

    let (f, sha) = file("cube.gcode", 7);
    let token = json!({ "requestId": "x", "action": "printer.start", "target": "bay-4", "paramsHash": "", "expiresAt": "2099-01-01T00:00:00.000Z", "signature": "" });
    for (i, (method, params)) in [
        ("start", json!({ "file": { "printerId": "bay-4", "path": "cube.gcode", "name": "cube.gcode" }, "token": token })),
        ("resume", json!({ "printerId": "bay-4", "token": token })),
        ("gcode", json!({ "printerId": "bay-4", "line": "G28", "token": token })),
        ("upload", json!({ "printerId": "bay-4", "file": f, "token": token })),
        ("adjust", json!({ "printerId": "bay-4", "change": {}, "token": token })),
        ("callTool", json!({ "pluginId": "spoolman", "tool": "use", "args": {}, "token": token })),
        ("approvals.grant", json!({ "requestId": "x" })),
        ("print.local", json!({ "printerId": "bay-4", "file": f, "bedClear": true })),
        ("objects.skip", json!({ "printerId": "bay-4", "ids": ["a"] })),
        ("jog", json!({ "printerId": "bay-4" })),
        ("queue.add", json!({ "printerId": "bay-4", "file": f })),
        ("fleets.create", json!({ "name": "x" })),
        ("watch.report", json!({})),
        ("discover", json!({})),
        ("clients.create", json!({ "name": "x", "role": "agent", "partner": true })),
        ("clients.list", json!({})),
        ("secrets.set", json!({ "name": "x", "value": "y" })),
    ]
    .into_iter()
    .enumerate()
    {
        let r = call(&mut p, 10 + i as u64, method, params).await;
        assert_eq!(r["error"]["code"], "forbidden", "{method}: {r}");
    }

    // Resume, G-code, adjustments and power switching are never a partner's to ask for.
    let printer = json!({ "printerId": "bay-4" });
    let asks = [
        (
            card("r-1", "printer.resume", "printer.resume", &printer),
            json!({ "kind": "resume", "printerId": "bay-4" }),
        ),
        (
            card(
                "g-1",
                "printer.gcode",
                "printer.gcode",
                &json!({ "printerId": "bay-4", "line": "G28" }),
            ),
            json!({ "kind": "gcode", "printerId": "bay-4", "line": "G28" }),
        ),
        (
            card("a-1", "printer.adjust", "printer.adjust", &printer),
            json!({ "kind": "adjust", "printerId": "bay-4", "change": {} }),
        ),
    ];
    for (i, (c, work)) in asks.into_iter().enumerate() {
        let r = call(
            &mut p,
            40 + i as u64,
            "approvals.register",
            json!({ "request": c, "work": work }),
        )
        .await;
        assert_eq!(r["error"]["code"], "forbidden", "{r}");
    }
    let mut ha = card("h-1", "plugin.call", "plugin.call", &printer);
    ha["actions"][0]["target"] = json!("home-assistant");
    let r = call(&mut p, 45, "approvals.register", json!({ "request": ha })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    // A pause or cancel card is its own to answer, so it carries no work.
    let r = call(
        &mut p,
        46,
        "approvals.register",
        json!({ "request": card("p-0", "printer.pause", "printer.pause", &printer), "work": { "kind": "pause", "printerId": "bay-4" } }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");

    // A print it asks for waits for a person, says who asked, and runs only once the app approves.
    let work = json!({ "kind": "print", "printerId": "bay-4", "file": f });
    let mut c = start_card("lm-1", "cube.gcode", &sha, Some("local_click"));
    c["origin"] = json!("local_click");
    let r = call(
        &mut p,
        50,
        "approvals.register",
        json!({ "request": c, "work": work }),
    )
    .await;
    assert_eq!(r["result"]["answeredIn"], "app", "{r}");
    let pending = call(&mut app, 51, "approvals.pending", json!({})).await;
    let shown = pending["result"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "lm-1")
        .unwrap()
        .clone();
    assert_eq!(shown["origin"], "mcp", "{shown}");
    assert_eq!(shown["lines"][0], "Asked by LayerMate, a partner app", "{shown}");
    assert_eq!(shown["work"]["kind"], "print", "{shown}");
    let r = call(
        &mut p,
        52,
        "approvals.grant",
        json!({ "requestId": "lm-1", "bedClear": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(starts(&mock_log(&mocks).await), 0);
    let r = call(
        &mut app,
        53,
        "approvals.grant",
        json!({ "requestId": "lm-1", "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["runBy"], "hub", "{r}");
    assert!(r["result"]["token"].is_null(), "no token leaves the hub: {r}");
    let done = wait_event(&mut p, "approval.done", |d| d["requestId"] == "lm-1").await;
    assert_eq!(done["ok"], true, "{done}");
    assert_eq!(starts(&mock_log(&mocks).await), 1);

    // Pause and cancel only stop a print: it answers its own card and uses the token, as an agent does.
    let r = call(
        &mut p,
        60,
        "approvals.register",
        json!({ "request": card("p-1", "printer.pause", "printer.pause", &printer) }),
    )
    .await;
    assert_eq!(r["result"]["answeredIn"], "here", "{r}");
    let token = call(&mut p, 61, "approvals.grant", json!({ "requestId": "p-1" })).await["result"].clone();
    assert!(token.is_object(), "{token}");
    let r = call(
        &mut p,
        62,
        "pause",
        json!({ "printerId": "bay-4", "token": token }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    assert!(
        mock_log(&mocks).await.iter().any(|l| l.contains("pause")),
        "{:?}",
        mock_log(&mocks).await
    );
    // A pause token never resumes.
    let r = call(
        &mut p,
        63,
        "resume",
        json!({ "printerId": "bay-4", "token": token }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let r = call(
        &mut p,
        64,
        "approvals.register",
        json!({ "request": card("c-1", "printer.cancel", "printer.cancel", &printer) }),
    )
    .await;
    assert_eq!(r["result"]["answeredIn"], "here", "{r}");
    let token = call(&mut p, 65, "approvals.grant", json!({ "requestId": "c-1" })).await["result"].clone();
    let r = call(
        &mut p,
        66,
        "cancel",
        json!({ "printerId": "bay-4", "token": token }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    assert!(mock_log(&mocks).await.iter().any(|l| l.contains("cancel")));
    // It answers only its own cards: a pause another agent raised is not its to grant.
    let mut ag = agent(&link).await;
    let r = call(
        &mut ag,
        2,
        "approvals.register",
        json!({ "request": card("a-p", "printer.pause", "printer.pause", &printer) }),
    )
    .await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let r = call(&mut p, 67, "approvals.grant", json!({ "requestId": "a-p" })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    // It can withdraw its own card.
    let r = call(
        &mut p,
        68,
        "approvals.register",
        json!({ "request": card("c-2", "printer.cancel", "printer.cancel", &printer) }),
    )
    .await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    let r = call(&mut p, 69, "approvals.deny", json!({ "requestId": "c-2" })).await;
    assert_eq!(r["result"]["denied"], true, "{r}");
}

#[tokio::test]
async fn revoking_a_partner_key_cuts_its_live_connection_and_it_cannot_pair_again() {
    let link = hub(None).await;
    let mut app = paired(&link).await;
    let (mut p, key, id) = partner(&link, &mut app, "LayerMate").await;
    let r = call(&mut p, 2, "list", json!({})).await;
    assert!(r["result"].is_array(), "{r}");
    let r = call(&mut app, 3, "clients.revoke", json!({ "clientId": id })).await;
    assert_eq!(r["result"]["revoked"], true, "{r}");
    // Closed by the hub, without the partner calling anything first.
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match p.next().await {
                None | Some(Err(_) | Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the hub closed the partner's socket");
    let mut again = connect(&link).await;
    let r = call(&mut again, 1, "pair", json!({ "clientKey": key })).await;
    assert_eq!(r["error"]["code"], "unauthorized", "{r}");
    let list = call(&mut app, 4, "clients.list", json!({})).await;
    assert_eq!(list["result"], json!([]), "{list}");
}

// ---- the device page: files, history, objects, jog ----

async fn started_print(ws: &mut Ws, name: &str) {
    let (f, _) = file(name, 3);
    let r = call(
        ws,
        3,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["started"], true, "{r}");
}

#[tokio::test]
async fn the_device_page_lists_files_and_history_and_skips_an_object_of_the_running_print() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;

    // Nothing is printing: there is nothing to skip, and the history is the printer's own.
    let r = call(&mut ws, 10, "history.list", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"][0]["name"], "earlier.gcode", "{r}");
    assert_eq!(r["result"][0]["outcome"], "completed", "{r}");
    let r = call(
        &mut ws,
        11,
        "objects.skip",
        json!({ "printerId": "bay-4", "id": "lid.stl_id_0_copy_0", "epoch": 0 }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_state", "{r}");

    started_print(&mut ws, "plate.gcode").await;
    let epoch = bed(&mut ws).await["epoch"].as_u64().unwrap();
    let r = call(&mut ws, 12, "files.list", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"][0]["name"], "plate.gcode", "{r}");
    let r = call(&mut ws, 13, "objects.list", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"][0]["name"], "lid", "{r}");
    assert_eq!(r["result"][0]["skipped"], false, "{r}");
    assert_eq!(r["result"][0]["polygon"].as_array().unwrap().len(), 4, "{r}");

    // A label the printer does not list, or one carrying a second command, never reaches it.
    for id in ["nope", "lid.stl_id_0_copy_0 M112", "a\nM112"] {
        let r = call(
            &mut ws,
            14,
            "objects.skip",
            json!({ "printerId": "bay-4", "id": id, "epoch": epoch }),
        )
        .await;
        assert!(
            matches!(r["error"]["code"].as_str(), Some("bad_request" | "not_found")),
            "{r}"
        );
    }
    assert!(
        !mock_log(&mocks)
            .await
            .iter()
            .any(|l| l.contains("EXCLUDE_OBJECT"))
    );

    // Without the epoch read with the list, or with one from an earlier print, nothing is skipped.
    let r = call(
        &mut ws,
        15,
        "objects.skip",
        json!({ "printerId": "bay-4", "id": "lid.stl_id_0_copy_0" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    let r = call(
        &mut ws,
        15,
        "objects.skip",
        json!({ "printerId": "bay-4", "id": "lid.stl_id_0_copy_0", "epoch": epoch - 1 }),
    )
    .await;
    assert_eq!(r["error"]["code"], "job_changed", "{r}");
    let r = call(
        &mut ws,
        15,
        "objects.skip",
        json!({ "printerId": "bay-4", "id": "lid.stl_id_0_copy_0", "epoch": epoch }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let r = call(
        &mut ws,
        15,
        "objects.skip",
        json!({ "printerId": "bay-4", "id": "lid.stl_id_0_copy_0", "epoch": epoch }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_state", "an object is skipped once: {r}");
    assert!(
        mock_log(&mocks)
            .await
            .contains(&"gcode EXCLUDE_OBJECT NAME=lid.stl_id_0_copy_0".to_owned())
    );
    let r = call(&mut ws, 16, "objects.list", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"][0]["skipped"], true, "{r}");
}

#[tokio::test]
async fn a_jog_is_three_small_lines_only_while_idle_and_inside_the_limits() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;

    let r = call(
        &mut ws,
        20,
        "jog",
        json!({ "printerId": "bay-4", "axis": "x", "distanceMm": 5 }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let log = mock_log(&mocks).await;
    let g: Vec<&String> = log.iter().filter(|l| l.starts_with("gcode ")).collect();
    assert_eq!(g, ["gcode G91", "gcode G1 X5.0 F3000", "gcode G90"], "{log:?}");

    for (id, p) in [
        (21, json!({ "axis": "x", "distanceMm": 50 })),
        (22, json!({ "axis": "z", "distanceMm": 5, "feedMmMin": 6000 })),
        (23, json!({ "axis": "w", "distanceMm": 5 })),
    ] {
        let mut params = p;
        params["printerId"] = json!("bay-4");
        let r = call(&mut ws, id, "jog", params).await;
        assert!(r["error"].is_object(), "{r}");
    }
    assert_eq!(
        mock_log(&mocks)
            .await
            .iter()
            .filter(|l| l.starts_with("gcode "))
            .count(),
        3,
        "refusals sent nothing"
    );

    started_print(&mut ws, "plate.gcode").await;
    let r = call(
        &mut ws,
        24,
        "jog",
        json!({ "printerId": "bay-4", "axis": "x", "distanceMm": 5 }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_state", "{r}");
    assert_eq!(
        mock_log(&mocks)
            .await
            .iter()
            .filter(|l| l.starts_with("gcode "))
            .count(),
        3,
        "nothing moved mid-print"
    );
}

#[tokio::test]
async fn a_jog_knows_where_the_head_is_and_restores_absolute_mode() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;
    add_bay4(&mut ws, &mocks).await;
    let jog = |axis: &str, d: f64| json!({ "printerId": "bay-4", "axis": axis, "distanceMm": d });
    let gcodes = |log: Vec<String>| log.into_iter().filter(|l| l.starts_with("gcode ")).count();

    // An unhomed axis does not move; the others do.
    mocks
        .set_motion("moonraker", json!({ "homed": "xy", "position": [100, 100, 5] }))
        .await;
    let r = call(&mut ws, 40, "jog", jog("z", 1.0)).await;
    assert_eq!(r["error"]["code"], "not_homed", "{r}");
    let r = call(&mut ws, 41, "jog", jog("x", 5.0)).await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    assert_eq!(
        mocks.state().await["moonraker"]["position"][0],
        105,
        "the head moved 5 mm"
    );

    // Past the axis range: refused with where the head is, nothing sent.
    mocks
        .set_motion("moonraker", json!({ "homed": "xyz", "position": [218, 100, 5] }))
        .await;
    let before = gcodes(mock_log(&mocks).await);
    for (id, p) in [(42, jog("x", 5.0)), (43, jog("z", -10.0))] {
        let r = call(&mut ws, id, "jog", p).await;
        assert_eq!(r["error"]["code"], "out_of_range", "{r}");
    }
    assert_eq!(gcodes(mock_log(&mocks).await), before);
    let r = call(&mut ws, 44, "jog", jog("z", -5.0)).await;
    assert_eq!(r["result"]["ok"], true, "down to the bed exactly: {r}");

    // A finished print may still be on the plate: Z goes down only after the plate is confirmed clear.
    started_print(&mut ws, "plate.gcode").await;
    mocks.set_state("moonraker", "finished").await;
    mocks
        .set_motion("moonraker", json!({ "position": [100, 100, 20] }))
        .await;
    let r = call(&mut ws, 45, "jog", jog("z", -1.0)).await;
    assert_eq!(r["error"]["code"], "bed_check", "{r}");
    let r = call(&mut ws, 46, "jog", jog("z", 1.0)).await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let r = call(&mut ws, 47, "bed.confirmClear", json!({ "printerId": "bay-4" })).await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(&mut ws, 48, "jog", jog("z", -1.0)).await;
    assert_eq!(r["result"]["ok"], true, "{r}");

    // A G90 the printer refuses twice leaves it marked: the next jog sends G90 first.
    mocks.set_motion("moonraker", json!({ "failG90": 2 })).await;
    let r = call(&mut ws, 49, "jog", jog("x", 1.0)).await;
    assert!(r["error"].is_object(), "{r}");
    assert_eq!(mocks.state().await["moonraker"]["relative"], true);
    let r = call(&mut ws, 50, "jog", jog("x", 1.0)).await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let log = mock_log(&mocks).await;
    let g: Vec<&String> = log
        .iter()
        .filter(|l| l.starts_with("gcode "))
        .rev()
        .take(4)
        .collect();
    assert_eq!(
        g,
        ["gcode G90", "gcode G1 X1.0 F3000", "gcode G91", "gcode G90"],
        "{log:?}"
    );
    assert_eq!(mocks.state().await["moonraker"]["relative"], false);
}

async fn add_bambu(ws: &mut Ws, mocks: &common::Mocks) {
    let r = call(
        ws,
        2,
        "secrets.set",
        json!({ "name": "bambu-code", "value": mocks.str("accessCode") }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let cfg = json!({
        "id": "bay-1", "name": "Bay 1", "plugin": "bambu-lan", "host": "127.0.0.1", "port": mocks.port("bambu"),
        "serial": mocks.str("serial"), "credentialRef": "bambu-code", "ftpPort": mocks.port("bambu-ftp"),
        "cameraPort": mocks.port("bambu-camera"),
    });
    let r = call(ws, 3, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["result"]["id"], "bay-1", "{r}");
}

async fn bambu_log(mocks: &common::Mocks) -> Vec<String> {
    mocks.state().await["log"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap().to_owned())
        .collect()
}

/// Polls `method` until `ok` holds for its result.
async fn until(ws: &mut Ws, method: &str, ok: impl Fn(&Value) -> bool) -> Value {
    for i in 0..100 {
        let r = call(ws, 200 + i, method, json!({ "printerId": "bay-1" })).await;
        if ok(&r) {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("{method} never matched");
}

fn slot_card(id: &str, setting: &Value) -> Value {
    json!({
        "id": id, "sessionId": "s", "tool": "printer.adjust", "permission": "start", "title": "Set slot A2", "lines": [],
        "printerId": "bay-1", "paramsHash": hash_of(&json!({})),
        "actions": [{ "action": "printer.adjust", "target": "bay-1", "paramsHash": hash_of(&json!({ "printerId": "bay-1", "slot": setting })) }],
        "expiresAt": "2099-01-01T00:00:00.000Z",
    })
}

#[tokio::test]
async fn an_ams_slot_is_written_only_from_the_app_with_a_card_a_person_approved() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("bambu", &[]).await;
    let mut app = paired(&link).await;
    add_bambu(&mut app, &mocks).await;
    until(&mut app, "status", |r| {
        r["result"]["slots"].as_array().is_some_and(|s| s.len() >= 2)
    })
    .await;
    let setting = json!({ "slot": "A2", "filamentId": "GFG99", "material": "PETG", "color": "#1a2b3c", "nozzleTempMin": 220, "nozzleTempMax": 260 });

    // An agent cannot call it at all, whatever it holds.
    let mut ag = agent(&link).await;
    let r = call(
        &mut ag,
        2,
        "adjust.slot",
        json!({ "printerId": "bay-1", "setting": setting, "token": {} }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");

    // A card for another color does not cover this one.
    let other = json!({ "slot": "A2", "filamentId": "GFG99", "material": "PETG", "color": "#ffffff", "nozzleTempMin": 220, "nozzleTempMax": 260 });
    let _ = call(
        &mut app,
        10,
        "approvals.register",
        json!({ "request": slot_card("s-0", &other) }),
    )
    .await;
    let t0 = call(&mut app, 11, "approvals.grant", json!({ "requestId": "s-0" })).await["result"].clone();
    let r = call(
        &mut app,
        12,
        "adjust.slot",
        json!({ "printerId": "bay-1", "setting": setting, "token": t0 }),
    )
    .await;
    assert!(r["error"].is_object(), "{r}");
    assert!(
        !bambu_log(&mocks)
            .await
            .iter()
            .any(|l| l.starts_with("ams_filament_setting"))
    );

    // The approved one goes as Bambu Studio sends it, and the answer is the slot as the printer reports it now.
    let _ = call(
        &mut app,
        13,
        "approvals.register",
        json!({ "request": slot_card("s-1", &setting) }),
    )
    .await;
    let t = call(&mut app, 14, "approvals.grant", json!({ "requestId": "s-1" })).await["result"].clone();
    let r = call(
        &mut app,
        15,
        "adjust.slot",
        json!({ "printerId": "bay-1", "setting": setting, "token": t }),
    )
    .await;
    assert_eq!(r["result"]["shown"], true, "{r}");
    assert_eq!(r["result"]["slot"]["id"], "A2", "{r}");
    assert_eq!(r["result"]["slot"]["material"], "PETG", "{r}");
    assert_eq!(r["result"]["slot"]["color"], "#1a2b3c", "{r}");
    let sent: Vec<String> = bambu_log(&mocks)
        .await
        .into_iter()
        .filter(|l| l.starts_with("ams_filament_setting"))
        .collect();
    assert_eq!(
        sent,
        [
            r#"ams_filament_setting {"ams_id":0,"slot_id":1,"tray_id":1,"tray_info_idx":"GFG99","setting_id":"","tray_color":"1A2B3CFF","nozzle_temp_min":220,"nozzle_temp_max":260,"tray_type":"PETG"}"#
        ]
    );
    // The card works once.
    let r = call(
        &mut app,
        16,
        "adjust.slot",
        json!({ "printerId": "bay-1", "setting": setting, "token": t }),
    )
    .await;
    assert!(r["error"].is_object(), "{r}");

    // A spool with an RFID tag sets itself, as in Bambu Studio.
    mocks.control("/bambu", json!({ "tagged": [1] })).await;
    until(&mut app, "status", |r| {
        r["result"]["slots"][1]["spoolUid"].is_string()
    })
    .await;
    let _ = call(
        &mut app,
        17,
        "approvals.register",
        json!({ "request": slot_card("s-2", &setting) }),
    )
    .await;
    let t2 = call(&mut app, 18, "approvals.grant", json!({ "requestId": "s-2" })).await["result"].clone();
    let r = call(
        &mut app,
        19,
        "adjust.slot",
        json!({ "printerId": "bay-1", "setting": setting, "token": t2 }),
    )
    .await;
    assert_eq!(r["error"]["code"], "refused", "{r}");
    assert!(r["error"]["message"].as_str().unwrap().contains("RFID"), "{r}");
}

#[tokio::test]
async fn the_chamber_light_switches_from_the_app_only() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("bambu", &[]).await;
    let mut app = paired(&link).await;
    add_bambu(&mut app, &mocks).await;
    until(&mut app, "status", |r| r["result"]["live"]["light"] == true).await;

    let mut ag = agent(&link).await;
    let r = call(
        &mut ag,
        2,
        "adjust.light",
        json!({ "printerId": "bay-1", "on": false }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    assert!(!bambu_log(&mocks).await.iter().any(|l| l.starts_with("ledctrl")));

    let r = call(
        &mut app,
        10,
        "adjust.light",
        json!({ "printerId": "bay-1", "on": false }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let sent: Vec<String> = bambu_log(&mocks)
        .await
        .into_iter()
        .filter(|l| l.starts_with("ledctrl"))
        .collect();
    assert_eq!(sent, ["ledctrl chamber_light off", "ledctrl chamber_light2 off"]);
    until(&mut app, "status", |r| r["result"]["live"]["light"] == false).await;
}

#[tokio::test]
async fn bambu_prints_from_slicerx_carry_their_objects_and_the_printers_files_and_history_read() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("bambu", &[]).await;
    let mut ws = paired(&link).await;
    add_bambu(&mut ws, &mocks).await;

    // No head position over the LAN: Z only moves up.
    let r = call(
        &mut ws,
        10,
        "jog",
        json!({ "printerId": "bay-1", "axis": "z", "distanceMm": -1 }),
    )
    .await;
    assert_eq!(r["error"]["code"], "position_unknown", "{r}");
    let r = call(
        &mut ws,
        11,
        "jog",
        json!({ "printerId": "bay-1", "axis": "z", "distanceMm": 1 }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");

    let (data, sha) = gcode(5);
    let f = json!({ "name": "plate.gcode.3mf", "kind": "gcode.3mf", "sha256": sha, "dataBase64": base64::engine::general_purpose::STANDARD.encode(&data) });
    let objects = json!([
        { "id": "0", "name": "bracket", "skipped": false, "polygon": [[10.0, 10.0], [30.0, 10.0], [30.0, 30.0]] },
        { "id": "1", "name": "bracket", "skipped": false, "polygon": [[50.0, 10.0], [70.0, 10.0], [70.0, 30.0]] },
    ]);
    let bad = json!([{ "id": "0; M112", "name": "x", "skipped": false }]);
    let r = call(
        &mut ws,
        12,
        "print.local",
        json!({ "printerId": "bay-1", "file": f, "bedClear": true, "objects": bad }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
    let r = call(
        &mut ws,
        12,
        "print.local",
        json!({ "printerId": "bay-1", "file": f, "bedClear": true, "objects": objects }),
    )
    .await;
    assert_eq!(r["result"]["started"], true, "{r}");

    let r = until(&mut ws, "objects.list", |r| {
        r["result"].as_array().is_some_and(|a| a.len() == 2)
    })
    .await;
    assert_eq!(
        r["result"][1]["name"], "bracket, copy 2",
        "copies read apart: {r}"
    );
    let epoch = call(&mut ws, 13, "bed.state", json!({ "printerId": "bay-1" })).await["result"]["epoch"]
        .as_u64()
        .unwrap();
    let skip = |id: &str, epoch: u64| json!({ "printerId": "bay-1", "id": id, "epoch": epoch });
    let r = call(&mut ws, 14, "objects.skip", skip("7", epoch)).await;
    assert_eq!(
        r["error"]["code"], "not_found",
        "only an object of the plate SlicerX sent: {r}"
    );
    let r = call(&mut ws, 15, "objects.skip", skip("1", epoch + 1)).await;
    assert_eq!(r["error"]["code"], "job_changed", "{r}");
    assert!(
        !bambu_log(&mocks)
            .await
            .iter()
            .any(|l| l.starts_with("skip_objects"))
    );
    let r = call(&mut ws, 16, "objects.skip", skip("1", epoch)).await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    assert!(bambu_log(&mocks).await.contains(&"skip_objects [1]".to_owned()));
    let r = call(&mut ws, 17, "objects.list", json!({ "printerId": "bay-1" })).await;
    assert_eq!(r["result"][1]["skipped"], true, "{r}");
    assert_eq!(r["result"][0]["skipped"], false, "{r}");

    // The printer's storage, read over FTPS.
    let r = call(&mut ws, 18, "files.list", json!({ "printerId": "bay-1" })).await;
    assert_eq!(r["result"][0]["path"], "plate.gcode.3mf", "{r}");
    assert_eq!(r["result"][0]["size"], 2048, "{r}");
    let r = call(&mut ws, 19, "issues.list", json!({ "printerId": "bay-1" })).await;
    assert_eq!(r["result"], json!([]), "{r}");

    // The job ends: it shows in the history.
    mocks.set_state("bambu", "finished").await;
    let r = until(&mut ws, "history.list", |r| {
        r["result"][0]["outcome"] == "completed"
    })
    .await;
    assert_eq!(r["result"][0]["name"], "plate.gcode.3mf", "{r}");

    // Started again from the printer's list (the hub's own upload, still the same size and time):
    // no unverified question, and its objects are unknown, so skip goes back to the printer's screen.
    let r = call(
        &mut ws,
        20,
        "files.start",
        json!({ "printerId": "bay-1", "path": "plate.gcode.3mf", "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["started"], true, "{r}");
    let epoch = call(&mut ws, 21, "bed.state", json!({ "printerId": "bay-1" })).await["result"]["epoch"]
        .as_u64()
        .unwrap();
    let mut r = Value::Null;
    for _ in 0..100 {
        // Until the printer reports the new job running.
        r = call(&mut ws, 22, "objects.skip", skip("1", epoch)).await;
        if r["error"]["code"] != "bad_state" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(r["error"]["code"], "not_supported", "{r}");
    let r = call(&mut ws, 23, "objects.list", json!({ "printerId": "bay-1" })).await;
    assert!(
        r["error"]["message"]
            .as_str()
            .unwrap()
            .contains("printer's screen"),
        "{r}"
    );
}

#[tokio::test]
async fn a_stored_file_starts_by_click_and_one_the_hub_did_not_upload_needs_the_explicit_confirm() {
    let first = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut a = paired(&first).await;
    add_bay4(&mut a, &mocks).await;
    started_print(&mut a, "plate.gcode").await;
    // A second hub never uploaded the file, so it cannot vouch for it.
    let second = hub(None).await;
    let mut ws = paired(&second).await;
    add_bay4(&mut ws, &mocks).await;
    mocks.set_state("moonraker", "idle").await;
    let p = json!({ "printerId": "bay-4", "path": "plate.gcode", "bedClear": true });
    let r = call(&mut ws, 32, "files.start", p.clone()).await;
    assert_eq!(r["error"]["code"], "unverified_file", "{r}");
    assert_eq!(
        starts(&mock_log(&mocks).await),
        1,
        "only the first start reached the printer"
    );
    let mut ok = p;
    ok["unverifiedOk"] = json!(true);
    let r = call(&mut ws, 33, "files.start", ok).await;
    assert_eq!(r["result"]["started"], true, "{r}");
    assert_eq!(starts(&mock_log(&mocks).await), 2);
    for bad in ["../x.gcode", "/etc/x.gcode", "a\nb.gcode"] {
        let r = call(
            &mut ws,
            34,
            "files.start",
            json!({ "printerId": "bay-4", "path": bad, "bedClear": true, "unverifiedOk": true }),
        )
        .await;
        assert_eq!(r["error"]["code"], "bad_request", "{bad}: {r}");
    }
}

#[tokio::test]
async fn agents_and_the_watch_cannot_move_skip_or_start_but_may_read() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    let mut ag = agent(&link).await;
    for (id, m) in [(2, "jog"), (3, "objects.skip"), (4, "files.start")] {
        let r = call(
            &mut ag,
            id,
            m,
            json!({ "printerId": "bay-4", "axis": "x", "distanceMm": 1, "id": "x", "path": "a.gcode" }),
        )
        .await;
        assert_eq!(r["error"]["code"], "forbidden", "{m}: {r}");
    }
    for (id, m) in [
        (5, "files.list"),
        (6, "history.list"),
        (7, "issues.list"),
        (8, "objects.list"),
    ] {
        let r = call(&mut ag, id, m, json!({ "printerId": "bay-4" })).await;
        assert!(r["error"]["code"] != "forbidden", "{m}: {r}");
    }
    let mut w = connect(&link).await;
    let pp = pairing::proof_params(&mut w, WATCH_CODE, json!({})).await;
    let r = call(&mut w, 1, "pair", pp).await;
    assert_eq!(r["result"]["role"], "watch", "{r}");
    for (id, m) in [
        (2, "jog"),
        (3, "files.list"),
        (4, "objects.skip"),
        (5, "files.start"),
    ] {
        let r = call(&mut w, id, m, json!({ "printerId": "bay-4" })).await;
        assert_eq!(r["error"]["code"], "forbidden", "{m}: {r}");
    }
}

// ---- the camera guard: a hand pauses, a dirty plate blocks a start ----

/// A detector connection, paired with the watch code.
async fn detector(link: &Link) -> Ws {
    let mut ws = connect(link).await;
    let pp = pairing::proof_params(&mut ws, WATCH_CODE, json!({})).await;
    let r = call(&mut ws, 1, "pair", pp).await;
    assert_eq!(r["result"]["role"], "watch", "{r}");
    ws
}

/// A detector that subscribes, then answers every plate check: something at `SPOT` while `dirty`
/// is set and the hub sent no spot to ignore, a clear plate otherwise. Returns the ignore lists
/// it was sent.
async fn plate_answers(
    link: &Link,
    dirty: Arc<std::sync::atomic::AtomicBool>,
) -> Arc<std::sync::Mutex<Vec<Value>>> {
    let mut det = detector(link).await;
    let r = call(&mut det, 2, "watch.subscribe", json!({ "everyMs": 120_000 })).await;
    assert!(r["result"]["subscription"].is_number(), "{r}");
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        let mut id = 100;
        while let Some(Ok(m)) = det.next().await {
            let Message::Text(t) = m else { continue };
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if v["event"] != "watch.plate" {
                continue;
            }
            let d = &v["data"];
            assert!(d["frame"]["dataBase64"].is_string(), "{d}");
            log.lock().unwrap().push(d["ignore"].clone());
            let ignored = d["ignore"].as_array().is_some_and(|a| !a.is_empty());
            let found = dirty.load(std::sync::atomic::Ordering::SeqCst) && !ignored;
            let mut res = json!({ "checkId": d["checkId"], "printerId": d["printerId"], "clear": !found, "note": "test" });
            if found {
                res["box"] = json!(SPOT);
            }
            id += 1;
            det.send(Message::text(
                json!({ "id": id, "method": "watch.plateResult", "params": res }).to_string(),
            ))
            .await
            .unwrap();
        }
    });
    seen
}

const SPOT: [f64; 4] = [0.4, 0.6, 0.45, 0.66];

async fn wait_state(ws: &mut Ws, state: &str) {
    for _ in 0..100 {
        let st = call(ws, 95, "status", json!({ "printerId": "bay-4" })).await;
        if st["result"]["state"] == state {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("bay-4 never became {state}");
}

async fn trip(ws: &mut Ws) -> Value {
    call(ws, 96, "watch.guardState", json!({})).await["result"]["trips"]["bay-4"].clone()
}

#[tokio::test]
async fn a_hand_pauses_at_once_without_confirmation_and_keeps_its_frame() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    mocks.set_state("moonraker", "printing").await;
    wait_state(&mut app, "printing").await;
    let mut det = detector(&link).await;
    // The second look a detector asks for comes back shaped like a frame.
    let g = call(&mut det, 2, "watch.grab", json!({ "printerId": "bay-4" })).await;
    assert_eq!(
        (g["result"]["contentType"].as_str(), g["result"]["state"].as_str()),
        (Some("image/jpeg"), Some("printing")),
        "{g}"
    );
    let again = call(&mut det, 3, "watch.grab", json!({ "printerId": "bay-4" })).await;
    assert_eq!(
        again["error"]["code"], "busy",
        "one second look at a time: {again}"
    );
    // No confirmation and no auto-pause permission: a hand still pauses.
    let r = call(&mut det, 4, "watch.report", json!({ "printerId": "bay-4", "kind": "hand", "confidence": 0.85, "box": [0.2, 0.3, 0.5, 0.9], "note": "2 of the last 3 frames" })).await;
    assert_eq!(r["result"]["paused"], true, "{r}");
    assert!(mock_log(&mocks).await.iter().any(|l| l.starts_with("pause")));
    let ev = wait_event(&mut app, "watch.guard", |d| d["kind"] == "hand").await;
    assert_eq!(
        (ev["state"].as_str(), ev["monitorOnly"].as_bool()),
        (Some("paused"), Some(false)),
        "{ev}"
    );
    assert_eq!(ev["box"], json!([0.2, 0.3, 0.5, 0.9]), "{ev}");
    let e = call(&mut app, 5, "watch.evidence", json!({ "printerId": "bay-4" })).await;
    assert_eq!(
        e["result"]["contentType"], "image/jpeg",
        "the frame stays on the hub for the card: {e}"
    );
    // "Dismiss, it was me" answers the card; it stays until the print is resumed.
    let _ = call(
        &mut app,
        6,
        "watch.dismiss",
        json!({ "printerId": "bay-4", "kind": "hand" }),
    )
    .await;
    assert_eq!(trip(&mut app).await["answered"], json!(true));

    // With the guard off for this printer, a hand only reports.
    mocks.set_state("moonraker", "printing").await;
    wait_state(&mut app, "printing").await;
    let r = call(
        &mut app,
        7,
        "watch.guard",
        json!({ "printerId": "bay-4", "enabled": false }),
    )
    .await;
    assert_eq!(r["result"]["enabled"], false, "{r}");
    let r = call(
        &mut det,
        8,
        "watch.report",
        json!({ "printerId": "bay-4", "kind": "hand", "confidence": 0.9 }),
    )
    .await;
    assert_eq!(r["result"]["paused"], false, "{r}");
    assert_eq!(
        call(&mut app, 9, "watch.guardState", json!({})).await["result"]["off"],
        json!(["bay-4"])
    );
    // The guard's settings are the person's, not a detector's.
    let r = call(
        &mut det,
        10,
        "watch.guard",
        json!({ "printerId": "bay-4", "enabled": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
}

#[tokio::test]
async fn a_dirty_plate_blocks_a_start_until_the_spot_is_marked_fine() {
    let dir = temp_dir("plate");
    let link = hub(Some(dir.clone())).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    wait_state(&mut app, "idle").await;
    let dirty = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let ignores = plate_answers(&link, dirty.clone()).await;
    // "This plate is clear": the picture is kept in the state directory.
    let r = call(&mut app, 3, "watch.plateClear", json!({ "printerId": "bay-4" })).await;
    assert!(r["result"]["plateFrom"].is_string(), "{r}");
    assert_eq!(std::fs::read_dir(dir.join("plates")).unwrap().count(), 1);

    let (f, _) = file("cube.gcode", 1);
    let r = call(
        &mut app,
        4,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "plate_check", "{r}");
    assert_eq!(starts(&mock_log(&mocks).await), 0, "nothing reached the printer");
    let t = trip(&mut app).await;
    assert_eq!(
        (t["kind"].as_str(), t["state"].as_str(), t["startedBy"].as_str()),
        (Some("plate"), Some("blocked"), Some("slicerx")),
        "{t}"
    );
    assert_eq!(t["box"], json!(SPOT), "{t}");
    assert!(t["plateFrom"].is_string(), "{t}");
    assert_eq!(
        call(&mut app, 5, "watch.evidence", json!({ "printerId": "bay-4" })).await["result"]["contentType"],
        "image/jpeg"
    );

    // "It's fine": the spot is remembered for this printer and sent with every later check.
    let r = call(&mut app, 6, "watch.plateIgnore", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"]["remembered"], "spot", "{r}");
    assert!(trip(&mut app).await.is_null());
    let r = call(
        &mut app,
        7,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["started"], true, "{r}");
    assert_eq!(ignores.lock().unwrap().last().unwrap(), &json!([SPOT]));
    assert_eq!(starts(&mock_log(&mocks).await), 1);
}

#[tokio::test]
async fn start_anyway_and_a_print_the_printer_started_itself() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    wait_state(&mut app, "idle").await;
    let dirty = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let _ = plate_answers(&link, dirty.clone()).await;
    // No empty-plate picture yet; the detector still answers. "Start anyway" skips the check.
    let (f, _) = file("cube.gcode", 1);
    let r = call(
        &mut app,
        3,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true, "plateOk": true }),
    )
    .await;
    assert_eq!(r["result"]["started"], true, "{r}");
    mocks.set_state("moonraker", "idle").await;
    wait_state(&mut app, "idle").await;
    let before = mock_log(&mocks)
        .await
        .iter()
        .filter(|l| l.starts_with("pause"))
        .count();

    // The printer starts a print from its own screen onto a dirty plate: the hub pauses it.
    mocks.set_state("moonraker", "printing").await;
    let ev = wait_event(&mut app, "watch.guard", |d| d["kind"] == "plate").await;
    assert_eq!(
        (ev["state"].as_str(), ev["startedBy"].as_str()),
        (Some("paused"), Some("printer")),
        "{ev}"
    );
    let after = mock_log(&mocks)
        .await
        .iter()
        .filter(|l| l.starts_with("pause"))
        .count();
    assert_eq!(after, before + 1);
    wait_state(&mut app, "paused").await;
    // The person cleans it and checks again: answered, and the card goes once the print resumes.
    dirty.store(false, std::sync::atomic::Ordering::SeqCst);
    let r = call(&mut app, 4, "watch.plateCheck", json!({ "printerId": "bay-4" })).await;
    assert_eq!(
        (r["result"]["checked"].as_bool(), r["result"]["clear"].as_bool()),
        (Some(true), Some(true)),
        "{r}"
    );
    assert_eq!(trip(&mut app).await["answered"], json!(true));
    mocks.set_state("moonraker", "printing").await;
    wait_state(&mut app, "printing").await;
    let t = trip(&mut app).await;
    assert!(t.is_null(), "{t}");
}

// ---- the camera guard: every way out of a paused card keeps Resume until a person resumes ----

/// A printing Bay 4 the guard has paused for a hand, with the app and a detector connected.
async fn paused_for_a_hand(link: &Link, mocks: &common::Mocks) -> (Ws, Ws) {
    let mut app = paired(link).await;
    add_bay4(&mut app, mocks).await;
    mocks.set_state("moonraker", "printing").await;
    wait_state(&mut app, "printing").await;
    let mut det = detector(link).await;
    let _ = call(&mut det, 2, "watch.grab", json!({ "printerId": "bay-4" })).await;
    let r = call(
        &mut det,
        3,
        "watch.report",
        json!({ "printerId": "bay-4", "kind": "hand", "confidence": 0.9 }),
    )
    .await;
    assert_eq!(r["result"]["paused"], true, "{r}");
    wait_state(&mut app, "paused").await;
    (app, det)
}

#[tokio::test]
async fn dismissing_a_hand_keeps_the_paused_card_until_someone_resumes() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let (mut app, _det) = paused_for_a_hand(&link, &mocks).await;
    // "Dismiss, it was me": the finding is answered, the print is still paused, so the card stays with Resume.
    let _ = call(
        &mut app,
        10,
        "watch.dismiss",
        json!({ "printerId": "bay-4", "kind": "hand" }),
    )
    .await;
    let t = trip(&mut app).await;
    assert_eq!(
        (t["state"].as_str(), t["answered"].as_bool()),
        (Some("paused"), Some(true)),
        "{t}"
    );
    assert_eq!(t["answeredBy"], "dismissed", "{t}");
    // Only a resume ends it.
    mocks.set_state("moonraker", "printing").await;
    wait_state(&mut app, "printing").await;
    assert!(trip(&mut app).await.is_null());
}

#[tokio::test]
async fn a_paused_plate_checked_clean_or_marked_fine_still_waits_for_resume() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    wait_state(&mut app, "idle").await;
    let dirty = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let _ = plate_answers(&link, dirty.clone()).await;
    // The printer starts a print on its own onto a dirty plate: paused.
    mocks.set_state("moonraker", "printing").await;
    let ev = wait_event(&mut app, "watch.guard", |d| d["kind"] == "plate").await;
    assert_eq!(ev["state"], "paused", "{ev}");
    wait_state(&mut app, "paused").await;
    // While a print is on the plate, the empty-plate picture cannot be taken.
    let r = call(&mut app, 3, "watch.plateClear", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["error"]["code"], "busy", "{r}");
    // Checked again and clean: answered, still paused, Resume stays.
    dirty.store(false, std::sync::atomic::Ordering::SeqCst);
    let r = call(&mut app, 4, "watch.plateCheck", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"]["clear"], true, "{r}");
    let t = trip(&mut app).await;
    assert_eq!(
        (t["state"].as_str(), t["answered"].as_bool()),
        (Some("paused"), Some(true)),
        "{t}"
    );
    // Dirty again, then "It's fine": still answered and paused.
    dirty.store(true, std::sync::atomic::Ordering::SeqCst);
    let r = call(&mut app, 5, "watch.plateCheck", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"]["clear"], false, "{r}");
    assert_eq!(trip(&mut app).await["answered"], json!(false));
    let r = call(&mut app, 6, "watch.plateIgnore", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"]["remembered"], "spot", "{r}");
    assert_eq!(trip(&mut app).await["answered"], json!(true));
    mocks.set_state("moonraker", "printing").await;
    wait_state(&mut app, "printing").await;
    assert!(trip(&mut app).await.is_null());
}

#[tokio::test]
async fn a_frame_that_tripped_the_guard_never_becomes_the_empty_plate() {
    let dir = temp_dir("plate-ref");
    let link = hub(Some(dir.clone())).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    wait_state(&mut app, "idle").await;
    let dirty = Arc::new(std::sync::atomic::AtomicBool::new(true));
    // The detector flags the plate on the model alone (no spot): no empty-plate picture yet.
    plate_answers_without_spot(&link, dirty.clone()).await;
    let (f, _) = file("cube.gcode", 1);
    let r = call(
        &mut app,
        3,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "plate_check", "{r}");
    // "It's fine" on a spotless trip remembers the answer, not the dirty frame.
    let r = call(&mut app, 4, "watch.plateIgnore", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"]["remembered"], "model", "{r}");
    assert!(!dir.join("plates").exists() || std::fs::read_dir(dir.join("plates")).unwrap().count() == 0);
    assert_eq!(
        call(&mut app, 5, "watch.guardState", json!({})).await["result"]["plates"],
        json!({})
    );
    // The model alone no longer holds this printer's starts.
    let r = call(
        &mut app,
        6,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true }),
    )
    .await;
    assert_eq!(r["result"]["started"], true, "{r}");
}

#[tokio::test]
async fn this_plate_is_clear_on_a_held_start_takes_a_new_picture() {
    let dir = temp_dir("plate-new");
    let link = hub(Some(dir.clone())).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut app = paired(&link).await;
    add_bay4(&mut app, &mocks).await;
    wait_state(&mut app, "idle").await;
    let dirty = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let _ = plate_answers(&link, dirty.clone()).await;
    let (f, _) = file("cube.gcode", 1);
    let r = call(
        &mut app,
        3,
        "print.local",
        json!({ "printerId": "bay-4", "file": f, "bedClear": true }),
    )
    .await;
    assert_eq!(r["error"]["code"], "plate_check", "{r}");
    let held = trip(&mut app).await;
    // The person clears the plate and says so: a fresh still, taken after the click, not the flagged one.
    // The two can fall in the same millisecond on a fast camera, so the check is "not earlier".
    let r = call(&mut app, 4, "watch.plateClear", json!({ "printerId": "bay-4" })).await;
    let from = r["result"]["plateFrom"].as_str().unwrap().to_owned();
    assert!(
        from.as_str() >= held["capturedAt"].as_str().unwrap(),
        "{from} after {held}"
    );
    assert!(trip(&mut app).await.is_null());
    assert_eq!(std::fs::read_dir(dir.join("plates")).unwrap().count(), 1);
}

/// Like `plate_answers`, but a dirty answer has no spot (the model alone).
async fn plate_answers_without_spot(link: &Link, dirty: Arc<std::sync::atomic::AtomicBool>) {
    let mut det = detector(link).await;
    let r = call(&mut det, 2, "watch.subscribe", json!({ "everyMs": 120_000 })).await;
    assert!(r["result"]["subscription"].is_number(), "{r}");
    tokio::spawn(async move {
        let mut id = 100;
        while let Some(Ok(m)) = det.next().await {
            let Message::Text(t) = m else { continue };
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if v["event"] != "watch.plate" {
                continue;
            }
            let d = &v["data"];
            let found = dirty.load(std::sync::atomic::Ordering::SeqCst);
            id += 1;
            let res = json!({ "checkId": d["checkId"], "printerId": d["printerId"], "clear": !found, "note": "model" });
            det.send(Message::text(
                json!({ "id": id, "method": "watch.plateResult", "params": res }).to_string(),
            ))
            .await
            .unwrap();
        }
    });
}

/// A detector that subscribes and answers every look again: a hand while `hand` is set.
async fn look_answers(link: &Link, hand: Arc<std::sync::atomic::AtomicBool>) {
    let mut det = detector(link).await;
    let r = call(&mut det, 2, "watch.subscribe", json!({ "everyMs": 120_000 })).await;
    assert!(r["result"]["subscription"].is_number(), "{r}");
    tokio::spawn(async move {
        let mut id = 100;
        while let Some(Ok(m)) = det.next().await {
            let Message::Text(t) = m else { continue };
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if v["event"] != "watch.look" {
                continue;
            }
            let d = &v["data"];
            assert!(d["frame"]["dataBase64"].is_string(), "{d}");
            let seen = hand.load(std::sync::atomic::Ordering::SeqCst);
            id += 1;
            let res = json!({ "checkId": d["checkId"], "printerId": d["printerId"], "hand": seen, "score": if seen { 0.9 } else { 0.1 } });
            det.send(Message::text(
                json!({ "id": id, "method": "watch.lookResult", "params": res }).to_string(),
            ))
            .await
            .unwrap();
        }
    });
}

#[tokio::test]
async fn check_again_on_a_hand_looks_at_a_new_frame() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let (mut app, _det) = paused_for_a_hand(&link, &mocks).await;
    let hand = Arc::new(std::sync::atomic::AtomicBool::new(true));
    look_answers(&link, hand.clone()).await;
    // Still a hand: the card stays as it was, on the new frame.
    let r = call(&mut app, 10, "watch.handCheck", json!({ "printerId": "bay-4" })).await;
    assert_eq!(
        (r["result"]["checked"].as_bool(), r["result"]["hand"].as_bool()),
        (Some(true), Some(true)),
        "{r}"
    );
    let t = trip(&mut app).await;
    assert_eq!(
        (t["state"].as_str(), t["answered"].as_bool()),
        (Some("paused"), Some(false)),
        "{t}"
    );
    // Gone: answered, still paused, waiting on Resume.
    hand.store(false, std::sync::atomic::Ordering::SeqCst);
    let r = call(&mut app, 11, "watch.handCheck", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"]["hand"], false, "{r}");
    let t = trip(&mut app).await;
    assert_eq!(
        (t["state"].as_str(), t["answered"].as_bool()),
        (Some("paused"), Some(true)),
        "{t}"
    );
    // Answered by a clean look, not a dismissal; the card says so and marks nothing.
    assert_eq!(t["answeredBy"], "clear", "{t}");
    assert!(t["box"].is_null(), "{t}");
    assert_eq!(mock_state(&mocks).await, "paused");
}

#[tokio::test]
async fn resume_on_the_guard_card_is_the_persons_approval_for_that_pause() {
    let link = hub(None).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let (mut app, mut det) = paused_for_a_hand(&link, &mocks).await;
    // Only the app, a person's click, may resume; a detector may not.
    let r = call(&mut det, 20, "watch.resume", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    let mut ag = agent(&link).await;
    let r = call(&mut ag, 21, "watch.resume", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["error"]["code"], "forbidden", "{r}");
    // No card to answer: the click covers no pause.
    let r = call(&mut app, 22, "watch.resume", json!({ "printerId": "nope" })).await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
    let r = call(&mut app, 23, "watch.resume", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"]["resumed"], true, "{r}");
    assert!(
        mock_log(&mocks).await.iter().any(|l| l.starts_with("resume")),
        "{:?}",
        mock_log(&mocks).await
    );
    wait_state(&mut app, "printing").await;
    assert!(trip(&mut app).await.is_null());
    // The card is gone, so the same click no longer resumes anything.
    let r = call(&mut app, 24, "watch.resume", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["error"]["code"], "not_paused", "{r}");
}

async fn mock_state(mocks: &common::Mocks) -> String {
    mocks.state().await["moonraker"]["state"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}
