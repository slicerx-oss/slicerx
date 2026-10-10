// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-link end to end: origin and host checks, pairing, lockout, and printer calls against the
//! mock printers with approval tokens.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::format_collect,
    clippy::too_many_lines
)]
#[path = "../../tests/common/mod.rs"]
mod common;
#[path = "support/pairing.rs"]
mod pairing;

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sx_connect::{Action, MemoryGate, MemorySecrets, params};
use sx_link::{Link, LinkConfig, MdnsConfig, PairLimits, serve};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const CODE: &str = "TEST-CODE";

async fn start(gate: Arc<MemoryGate>) -> Link {
    let cfg = LinkConfig {
        port: 0,
        extra_origins: Vec::new(),
        fixed_code: Some(CODE.to_owned()),
        inbox: None,
        pair_limits: PairLimits::default(),
        mdns: MdnsConfig::default(),
        ..LinkConfig::default()
    };
    serve(cfg, gate, Arc::new(MemorySecrets::new())).await.unwrap()
}

async fn open(
    link: &Link,
    origin: Option<&str>,
    host: Option<&str>,
) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
    let mut req = format!("ws://127.0.0.1:{}/", link.addr().port())
        .into_client_request()
        .unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    if let Some(h) = host {
        req.headers_mut().insert("host", h.parse().unwrap());
    }
    connect_async(req).await.map(|(ws, _)| ws)
}

async fn call(ws: &mut Ws, id: u64, method: &str, params: Value) -> Value {
    ws.send(Message::text(
        json!({ "id": id, "method": method, "params": params }).to_string(),
    ))
    .await
    .unwrap();
    loop {
        let m = tokio::time::timeout(Duration::from_secs(5), ws.next())
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
    let mut ws = open(link, Some("http://localhost:5173"), None).await.unwrap();
    let pp = pairing::proof_params(&mut ws, CODE, json!({})).await;
    let r = call(&mut ws, 1, "pair", pp).await;
    assert_eq!(r["result"]["paired"], true, "{r}");
    ws
}

fn sha_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn binds_loopback_only() {
    let link = start(Arc::new(MemoryGate::new())).await;
    assert!(link.addr().ip().is_loopback());
    assert!(link.addr().is_ipv4());
}

#[tokio::test]
async fn foreign_origin_and_host_are_refused_before_pairing() {
    let link = start(Arc::new(MemoryGate::new())).await;
    assert!(open(&link, Some("https://evil.example"), None).await.is_err());
    assert!(
        open(&link, Some("http://localhost.evil.example"), None)
            .await
            .is_err()
    );
    assert!(
        open(&link, Some("http://localhost:5173"), Some("rebind.example:1234"))
            .await
            .is_err()
    );
    assert!(open(&link, Some("https://slicerx.app"), None).await.is_ok());
    assert!(
        open(&link, None, None).await.is_ok(),
        "non-browser clients still need the code"
    );
}

#[tokio::test]
async fn nothing_works_before_pairing_and_wrong_codes_close_the_socket() {
    let link = start(Arc::new(MemoryGate::new())).await;
    let mut ws = open(&link, None, None).await.unwrap();
    let r = call(&mut ws, 1, "list", json!({})).await;
    assert_eq!(r["error"]["code"], "unauthorized");
    for i in 0..5 {
        let pp = pairing::proof_params(&mut ws, "WRONG", json!({})).await;
        let r = call(&mut ws, 10 + i, "pair", pp).await;
        assert_eq!(r["error"]["code"], "unauthorized");
    }
    // The fifth wrong code ended the connection.
    let next = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .unwrap();
    assert!(
        matches!(next, None | Some(Ok(Message::Close(_)) | Err(_))),
        "{next:?}"
    );
}

// R9: a code sent in clear is refused, the right one included, with words an old client can
// show. It is never compared, so it neither pairs nor counts toward the lockout.
#[tokio::test]
async fn r9_a_code_in_clear_is_refused_even_when_right() {
    let link = start(Arc::new(MemoryGate::new())).await;
    for _ in 0..3 {
        let mut ws = open(&link, None, None).await.unwrap();
        for i in 0..4 {
            let r = call(&mut ws, i, "pair", json!({ "code": CODE })).await;
            assert_eq!(r["error"]["code"], "unauthorized", "{r}");
            assert!(
                r["error"]["message"].as_str().unwrap().contains("update the app"),
                "{r}"
            );
        }
        let r = call(&mut ws, 9, "list", json!({})).await;
        assert_eq!(r["error"]["code"], "unauthorized", "not paired: {r}");
    }
    // Twelve plain codes later, a proof still pairs: they did not lock pairing.
    let mut ws = open(&link, None, None).await.unwrap();
    let pp = pairing::proof_params(&mut ws, CODE, json!({})).await;
    let r = call(&mut ws, 1, "pair", pp).await;
    assert_eq!(r["result"]["paired"], true, "{r}");
}

#[tokio::test]
async fn ten_wrong_codes_across_connections_lock_pairing() {
    let link = start(Arc::new(MemoryGate::new())).await;
    for _ in 0..2 {
        let mut ws = open(&link, None, None).await.unwrap();
        for i in 0..5 {
            let pp = pairing::proof_params(&mut ws, "NOPE", json!({})).await;
            let _ = call(&mut ws, i, "pair", pp).await;
        }
    }
    // Locked: even the first step of the code exchange is refused, so no run gives another guess.
    let mut ws = open(&link, None, None).await.unwrap();
    let b64 = base64::engine::general_purpose::STANDARD;
    let _ = call(&mut ws, 1, "hello", json!({ "nonce": b64.encode([5_u8; 32]) })).await;
    let r = call(&mut ws, 2, "pair", json!({ "pake": b64.encode([0_u8; 32]) })).await;
    assert_eq!(
        r["error"]["code"], "locked",
        "even the right code is refused during lockout: {r}"
    );
}

#[tokio::test]
async fn paired_client_drives_a_printer_with_approval_tokens() {
    let gate = Arc::new(MemoryGate::new());
    let link = start(gate.clone()).await;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mut ws = paired(&link).await;

    // Connectors not yet tested on real printers stay hidden unless asked for.
    let plugins = call(&mut ws, 2, "plugins", json!({})).await;
    let ids: Vec<&str> = plugins["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        [
            "bambu-lan",
            "moonraker",
            "prusalink",
            "octoprint",
            "elegoo",
            "bambuddy",
            "spoolman"
        ]
    );
    let all = call(&mut ws, 2, "plugins", json!({ "includeExperimental": true })).await;
    let all = all["result"].as_array().unwrap();
    assert_eq!(all.len(), 13);
    assert!(
        all.iter()
            .filter(|m| m["experimental"] == true)
            .map(|m| m["id"].as_str().unwrap())
            .eq([
                "duet",
                "creality",
                "snapmaker",
                "ultimaker",
                "anycubic",
                "home-assistant"
            ])
    );

    // Printers outside the local network are refused.
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "8.8.8.8" });
    let r = call(&mut ws, 3, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");

    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let info = json!({ "vendor": "Voron Design", "model": "Voron 2.4 350" });
    let r = call(&mut ws, 4, "printers.add", json!({ "config": cfg, "info": info })).await;
    assert_eq!(r["result"]["model"], "Voron 2.4 350", "{r}");
    let list = call(&mut ws, 5, "list", json!({})).await;
    assert_eq!(list["result"].as_array().unwrap().len(), 1);

    let st = call(&mut ws, 6, "status", json!({ "printerId": "bay-4" })).await;
    assert_eq!(st["result"]["state"], "idle", "{st}");

    // Subscription delivers events over the same socket.
    let sub = call(&mut ws, 7, "subscribe", json!({ "printerId": "bay-4" })).await;
    assert!(sub["result"]["subscription"].is_number());

    // Side effects: forged tokens and a hash mismatch are refused, a real token works.
    let data: Vec<u8> = (0..2048_u32).map(|i| u8::try_from(i % 200).unwrap()).collect();
    let hash = sha_hex(&data);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    let file = json!({ "name": "cube.gcode", "kind": "gcode", "sha256": hash, "dataBase64": b64 });
    let bad_token = json!({ "requestId": "r", "token": "forged", "expiresAt": "" });
    let r = call(
        &mut ws,
        8,
        "upload",
        json!({ "printerId": "bay-4", "file": file, "token": bad_token }),
    )
    .await;
    assert_eq!(r["error"]["code"], "approval_invalid", "{r}");

    let mismatched = json!({ "name": "cube.gcode", "kind": "gcode", "sha256": "00", "dataBase64": b64 });
    let t = gate.mint(
        Action::Upload,
        "bay-4",
        &params::upload("bay-4", "cube.gcode", &hash),
    );
    let r = call(
        &mut ws,
        9,
        "upload",
        json!({ "printerId": "bay-4", "file": mismatched, "token": t }),
    )
    .await;
    assert_eq!(
        r["error"]["code"], "bad_request",
        "hash mismatch is caught before the printer sees anything: {r}"
    );

    let t = gate.mint(
        Action::Upload,
        "bay-4",
        &params::upload("bay-4", "cube.gcode", &hash),
    );
    let r = call(
        &mut ws,
        10,
        "upload",
        json!({ "printerId": "bay-4", "file": file, "token": t }),
    )
    .await;
    assert_eq!(r["result"]["path"], "cube.gcode", "{r}");
    let t = gate.mint(
        Action::Start,
        "bay-4",
        &params::start(
            "bay-4",
            &sx_connect::RemoteFile {
                printer_id: "bay-4".into(),
                path: "cube.gcode".into(),
                name: "cube.gcode".into(),
                // The hub binds the start to the content it uploaded.
                sha256: Some(hash.clone()),
            },
            &sx_connect::StartOptions::default(),
        ),
    );
    // Without a broker the start call itself carries the bed answer; a remote start always needs it.
    let refused = call(&mut ws, 11, "start", json!({ "file": r["result"], "token": t })).await;
    assert_eq!(refused["error"]["code"], "bed_check", "{refused}");
    let started = call(
        &mut ws,
        11,
        "start",
        json!({ "file": r["result"], "token": t, "bedClear": true }),
    )
    .await;
    assert_eq!(started["result"]["ok"], true, "{started}");

    // The subscription reports the new state (events arrive interleaved with replies).
    let mut saw_printing = false;
    for _ in 0..40 {
        let Ok(Some(Ok(Message::Text(t)))) =
            tokio::time::timeout(Duration::from_millis(250), ws.next()).await
        else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["event"] == "printer" && v["data"]["status"]["state"] == "printing" {
            saw_printing = true;
            break;
        }
    }
    assert!(saw_printing, "no printing event on the subscription");

    let r = call(
        &mut ws,
        12,
        "pause",
        json!({ "printerId": "bay-4", "token": gate.mint(Action::Pause, "bay-4", &params::printer("bay-4")) }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let r = call(&mut ws, 13, "snapshot", json!({ "printerId": "bay-4" })).await;
    assert_eq!(r["result"]["contentType"], "image/jpeg");
}

#[tokio::test]
async fn an_off_printer_reads_as_offline_and_secrets_are_write_only() {
    let link = start(Arc::new(MemoryGate::new())).await;
    let mut ws = paired(&link).await;
    let cfg = json!({ "id": "bay-5", "name": "Bay 5", "plugin": "creality", "host": "127.0.0.1", "port": 1 });
    let r = call(&mut ws, 2, "printers.add", json!({ "config": cfg })).await;
    assert_eq!(
        r["error"]["code"], "not_supported",
        "experimental connectors are off by default: {r}"
    );
    let r = call(
        &mut ws,
        2,
        "settings.set",
        json!({ "experimentalConnectors": true }),
    )
    .await;
    assert_eq!(r["result"]["experimentalConnectors"], true, "{r}");
    let _ = call(&mut ws, 2, "printers.add", json!({ "config": cfg })).await;
    let st = call(&mut ws, 3, "status", json!({ "printerId": "bay-5" })).await;
    assert_eq!(st["result"]["state"], "offline", "{st}");

    let r = call(
        &mut ws,
        4,
        "secrets.set",
        json!({ "name": "k", "value": "hunter2" }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true);
    let r = call(&mut ws, 5, "secrets.has", json!({ "name": "k" })).await;
    assert_eq!(r["result"]["has"], true);
    let r = call(&mut ws, 6, "secrets.get", json!({ "name": "k" })).await;
    assert_eq!(r["error"]["code"], "bad_request");
    assert!(!r.to_string().contains("hunter2"));

    let r = call(&mut ws, 7, "llm.stream", json!({})).await;
    assert_eq!(r["error"]["code"], "not_supported");
}

#[tokio::test]
async fn service_tools_need_configuration_and_a_lan_url() {
    let gate = Arc::new(MemoryGate::new());
    let link = start(gate.clone()).await;
    let mocks = common::Mocks::start("spoolman", &[]).await;
    let mut ws = paired(&link).await;

    let r = call(
        &mut ws,
        2,
        "callTool",
        json!({ "pluginId": "spoolman", "tool": "spoolman.list_spools" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_found");
    let r = call(
        &mut ws,
        3,
        "services.configure",
        json!({ "pluginId": "spoolman", "baseUrl": "https://spools.example.com" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request");
    let url = format!("http://127.0.0.1:{}", mocks.port("spoolman"));
    let r = call(
        &mut ws,
        4,
        "services.configure",
        json!({ "pluginId": "spoolman", "baseUrl": url }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let r = call(
        &mut ws,
        5,
        "callTool",
        json!({ "pluginId": "spoolman", "tool": "spoolman.list_spools", "input": { "material": "PETG" } }),
    )
    .await;
    assert_eq!(r["result"].as_array().unwrap().len(), 1, "{r}");

    // Settings lists it by address, and removing it turns its tools off again.
    let r = call(&mut ws, 6, "services.list", json!({})).await;
    assert_eq!(
        r["result"],
        json!([{ "pluginId": "spoolman", "baseUrl": url, "hasSecret": false }]),
        "{r}"
    );
    let r = call(&mut ws, 7, "services.remove", json!({ "pluginId": "spoolman" })).await;
    assert_eq!(r["result"]["removed"], true, "{r}");
    let r = call(&mut ws, 8, "services.list", json!({})).await;
    assert_eq!(r["result"], json!([]), "{r}");
    let r = call(
        &mut ws,
        9,
        "callTool",
        json!({ "pluginId": "spoolman", "tool": "spoolman.list_spools", "input": {} }),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_found", "{r}");
}

#[tokio::test]
async fn pairing_a_snapmaker_stores_the_token_without_returning_it() {
    let link = start(Arc::new(MemoryGate::new())).await;
    let mocks = common::Mocks::start("snapmaker-luban", &[]).await;
    let mut ws = paired(&link).await;
    let _ = call(
        &mut ws,
        1,
        "settings.set",
        json!({ "experimentalConnectors": true }),
    )
    .await;
    let cfg = json!({ "id": "bay-2", "name": "Bay 2", "plugin": "snapmaker", "host": "127.0.0.1", "port": mocks.port("snapmaker-luban"), "protocol": "luban", "credentialRef": "printer/bay-2/token", "pollMs": 50 });
    let r = call(&mut ws, 2, "printers.add", json!({ "config": cfg })).await;
    assert!(r["result"].is_object(), "{r}");

    // Before pairing the printer cannot be connected.
    let st = call(&mut ws, 3, "snapshot", json!({ "printerId": "bay-2" })).await;
    assert_eq!(st["error"]["code"], "auth", "{st}");

    let r = call(
        &mut ws,
        4,
        "printers.authorize",
        json!({ "printerId": "bay-2", "timeoutSeconds": 30 }),
    )
    .await;
    assert_eq!(r["result"]["stored"], true, "{r}");
    assert!(
        !r.to_string().contains("token\":\""),
        "the token must not be sent back: {r}"
    );
    let has = call(
        &mut ws,
        5,
        "secrets.has",
        json!({ "name": "printer/bay-2/token" }),
    )
    .await;
    assert_eq!(has["result"]["has"], true);

    let st = call(&mut ws, 6, "status", json!({ "printerId": "bay-2" })).await;
    assert_eq!(st["result"]["state"], "idle", "{st}");
}

#[tokio::test]
async fn fleets_group_printers_without_owning_them() {
    let link = start(Arc::new(MemoryGate::new())).await;
    let mut ws = paired(&link).await;
    for (i, id) in ["bay-1", "bay-2"].into_iter().enumerate() {
        let cfg = json!({ "id": id, "name": id, "plugin": "moonraker", "host": "127.0.0.1", "port": 1 });
        let r = call(&mut ws, 10 + i as u64, "printers.add", json!({ "config": cfg })).await;
        assert!(r["result"].is_object(), "{r}");
    }
    let bench = call(
        &mut ws,
        20,
        "fleets.create",
        json!({ "name": " Bench ", "color": "cyan", "printerIds": ["bay-1"] }),
    )
    .await;
    assert_eq!(bench["result"]["name"], "Bench", "{bench}");
    let id = bench["result"]["id"].as_str().unwrap().to_owned();

    let r = call(
        &mut ws,
        21,
        "fleets.add",
        json!({ "fleetId": id, "printerId": "bay-2" }),
    )
    .await;
    assert_eq!(r["result"]["printerIds"], json!(["bay-1", "bay-2"]));
    let r = call(
        &mut ws,
        22,
        "fleets.add",
        json!({ "fleetId": id, "printerId": "nope" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_found");
    let r = call(&mut ws, 23, "fleets.create", json!({ "name": "bench" })).await;
    assert_eq!(r["error"]["code"], "protocol");
    let r = call(
        &mut ws,
        24,
        "fleets.update",
        json!({ "fleetId": id, "color": null, "icon": "printer" }),
    )
    .await;
    assert_eq!(r["result"]["icon"], "printer");
    assert!(r["result"].get("color").is_none(), "{r}");

    // Removing a printer takes it out of its fleets; deleting a fleet keeps printers.
    let _ = call(&mut ws, 25, "printers.remove", json!({ "printerId": "bay-1" })).await;
    let list = call(&mut ws, 26, "fleets.list", json!({})).await;
    assert_eq!(list["result"][0]["printerIds"], json!(["bay-2"]));
    let r = call(&mut ws, 27, "fleets.delete", json!({ "fleetId": id })).await;
    assert_eq!(r["result"]["deleted"], true);
    let printers = call(&mut ws, 28, "list", json!({})).await;
    assert_eq!(printers["result"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn the_real_broker_gates_upload_start_and_pause() {
    use sx_link::{BrokerGate, serve_with_approvals};
    use sx_permit::{ApprovalBroker, hash_params};

    let broker = Arc::new(ApprovalBroker::new().unwrap());
    let cfg = LinkConfig {
        port: 0,
        extra_origins: Vec::new(),
        fixed_code: Some(CODE.to_owned()),
        inbox: None,
        pair_limits: PairLimits::default(),
        mdns: MdnsConfig::default(),
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
    let mut ws = paired(&link).await;
    let cfg = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let _ = call(&mut ws, 2, "printers.add", json!({ "config": cfg })).await;

    let data: Vec<u8> = (0..1024_u32).map(|i| u8::try_from(i % 100).unwrap()).collect();
    let sha = sha_hex(&data);
    let file = json!({ "name": "cube.gcode", "kind": "gcode", "sha256": sha, "dataBase64": base64::engine::general_purpose::STANDARD.encode(&data) });
    let action = |a: &str, target: &str, params: Value| json!({ "action": a, "target": target, "paramsHash": hash_params(&params) });
    let request = json!({
        "id": "req-1", "sessionId": "s", "tool": "moonraker.start", "permission": "start", "title": "Print cube.gcode on Bay 4?", "lines": [],
        "printerId": "bay-4", "paramsHash": hash_params(&json!({})),
        "actions": [
            action("printer.upload", "bay-4", json!({ "printerId": "bay-4", "name": "cube.gcode", "sha256": sha })),
            action("printer.start", "bay-4", json!({ "printerId": "bay-4", "name": "cube.gcode", "opts": {}, "sha256": sha })),
            action("printer.pause", "bay-4", json!({ "printerId": "bay-4" })),
        ],
        "expiresAt": "2099-01-01T00:00:00.000Z",
    });

    // No approval yet: a forged token is refused.
    let forged = json!({ "requestId": "req-1", "token": "forged", "expiresAt": "2099-01-01T00:00:00.000Z" });
    let r = call(
        &mut ws,
        3,
        "upload",
        json!({ "printerId": "bay-4", "file": file, "token": forged }),
    )
    .await;
    assert_eq!(r["error"]["code"], "approval_invalid", "{r}");

    let r = call(&mut ws, 4, "approvals.register", json!({ "request": request })).await;
    assert_eq!(r["result"]["registered"], true, "{r}");
    // The card asked about the bed and the person said it is clear.
    let r = call(
        &mut ws,
        5,
        "approvals.grant",
        json!({ "requestId": "req-1", "bedClear": true }),
    )
    .await;
    let token = r["result"].clone();
    assert!(token["token"].is_string(), "{r}");

    let up = call(
        &mut ws,
        6,
        "upload",
        json!({ "printerId": "bay-4", "file": file, "token": token }),
    )
    .await;
    assert_eq!(up["result"]["path"], "cube.gcode", "{up}");
    // A token for these actions still fails for another printer's target.
    let r = call(
        &mut ws,
        7,
        "pause",
        json!({ "printerId": "bay-9", "token": token }),
    )
    .await;
    assert_ne!(r["error"]["code"], Value::Null, "{r}");
    let r = call(
        &mut ws,
        8,
        "start",
        json!({ "file": up["result"], "token": token }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let r = call(
        &mut ws,
        9,
        "pause",
        json!({ "printerId": "bay-4", "token": token }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    // Each action verifies once.
    let r = call(
        &mut ws,
        10,
        "pause",
        json!({ "printerId": "bay-4", "token": token }),
    )
    .await;
    assert_eq!(r["error"]["code"], "approval_invalid", "{r}");
    assert!(r["error"]["message"].as_str().unwrap().contains("used"), "{r}");

    // A denied request never yields a token.
    let mut denied = request.clone();
    denied["id"] = json!("req-2");
    let _ = call(&mut ws, 11, "approvals.register", json!({ "request": denied })).await;
    let _ = call(&mut ws, 12, "approvals.deny", json!({ "requestId": "req-2" })).await;
    let r = call(&mut ws, 13, "approvals.grant", json!({ "requestId": "req-2" })).await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
}

// ---- the cloud inbox ----

/// A bridge with the real broker and an inbox pointed at the cloud fake, a Moonraker fake as Bay 4,
/// and a paired client.
async fn inbox_rig() -> (Link, common::Mocks, Ws) {
    use sx_link::{BrokerGate, InboxConfig, serve_with_approvals};
    let mocks = common::Mocks::start("moonraker,cloud", &[]).await;
    let broker = Arc::new(sx_permit::ApprovalBroker::new().unwrap());
    let cfg = LinkConfig {
        port: 0,
        extra_origins: Vec::new(),
        fixed_code: Some(CODE.to_owned()),
        inbox: Some(InboxConfig {
            url: format!("http://127.0.0.1:{}", mocks.port("cloud")),
            token: mocks.str("cloudToken"),
        }),
        pair_limits: PairLimits::default(),
        mdns: MdnsConfig::default(),
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
    let mut ws = paired(&link).await;
    let printer = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let r = call(
        &mut ws,
        2,
        "printers.add",
        json!({ "config": printer, "info": { "model": "Voron 2.4 350" } }),
    )
    .await;
    assert!(r["result"].is_object(), "{r}");
    // The bridge tells the cloud which printers it has.
    mocks.wait_log("cloud printers bay-4").await;
    (link, mocks, ws)
}

fn offer(name: &str, data: &[u8]) -> Value {
    json!({ "printerLocalId": "bay-4", "fileName": name, "contentBase64": base64::engine::general_purpose::STANDARD.encode(data) })
}

async fn next_inbox_event(ws: &mut Ws) -> Value {
    for _ in 0..200 {
        let Ok(Some(Ok(Message::Text(t)))) =
            tokio::time::timeout(Duration::from_millis(100), ws.next()).await
        else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["event"] == "inbox" {
            return v["data"].clone();
        }
    }
    panic!("no inbox event");
}

#[tokio::test]
async fn a_delivery_is_downloaded_approved_uploaded_and_started() {
    let (_link, mocks, mut ws) = inbox_rig().await;
    let data: Vec<u8> = (0..3000_u32).map(|i| u8::try_from(i % 97).unwrap()).collect();
    let id = mocks.offer(offer("lantern.gcode", &data)).await;

    let ev = next_inbox_event(&mut ws).await;
    assert_eq!(ev["state"], "awaiting_approval", "{ev}");
    assert_eq!(ev["deliveryId"], id.as_str());
    assert_eq!(ev["fileName"], "lantern.gcode");
    assert_eq!(ev["printerId"], "bay-4");
    assert_eq!(ev["bytes"], 3000);
    assert_eq!(ev["sha256"], sha_hex(&data));
    assert!(
        !ev.to_string().contains("sxk_"),
        "the inbox token never reaches clients"
    );
    let list = call(&mut ws, 3, "inbox.list", json!({})).await;
    assert_eq!(list["result"].as_array().unwrap().len(), 1, "{list}");

    // The app raises the normal approval for exactly this upload and start.
    let hash = sha_hex(&data);
    let action = |a: &str, p: Value| json!({ "action": a, "target": "bay-4", "paramsHash": sx_permit::hash_params(&p) });
    let request = json!({
        "id": "req-1", "sessionId": "s", "tool": "cloud.deliver", "permission": "start", "title": "Print lantern.gcode on Bay 4?", "lines": [],
        "printerId": "bay-4", "paramsHash": sx_permit::hash_params(&json!({})),
        "actions": [
            action("printer.upload", json!({ "printerId": "bay-4", "name": "lantern.gcode", "sha256": hash })),
            action("printer.start", json!({ "printerId": "bay-4", "name": "lantern.gcode", "opts": {}, "sha256": hash })),
        ],
        "expiresAt": "2099-01-01T00:00:00.000Z",
    });
    let _ = call(&mut ws, 4, "approvals.register", json!({ "request": request })).await;
    let token = call(
        &mut ws,
        5,
        "approvals.grant",
        json!({ "requestId": "req-1", "bedClear": true }),
    )
    .await["result"]
        .clone();

    // A forged token leaves the delivery waiting, so the user can approve again.
    let bad = json!({ "requestId": "req-1", "token": "forged", "expiresAt": "2099-01-01T00:00:00.000Z" });
    let r = call(
        &mut ws,
        6,
        "upload",
        json!({ "printerId": "bay-4", "deliveryId": id, "token": bad }),
    )
    .await;
    assert_eq!(r["error"]["code"], "approval_invalid", "{r}");
    let r = call(
        &mut ws,
        7,
        "upload",
        json!({ "printerId": "bay-9", "deliveryId": id, "token": token }),
    )
    .await;
    assert_ne!(r["error"]["code"], Value::Null, "{r}");
    assert_eq!(
        call(&mut ws, 8, "inbox.list", json!({})).await["result"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let up = call(
        &mut ws,
        9,
        "upload",
        json!({ "printerId": "bay-4", "deliveryId": id, "token": token }),
    )
    .await;
    assert_eq!(up["result"]["name"], "lantern.gcode", "{up}");
    let started = call(
        &mut ws,
        10,
        "start",
        json!({ "file": up["result"], "token": token }),
    )
    .await;
    assert_eq!(started["result"]["ok"], true, "{started}");

    let log = mocks.wait_log("lantern.gcode printing").await;
    let states: Vec<&str> = log
        .iter()
        .filter(|l| l.starts_with("cloud state lantern.gcode "))
        .map(|l| l.rsplit(' ').next().unwrap())
        .collect();
    assert_eq!(
        states,
        [
            "downloaded",
            "awaiting_approval",
            "approved",
            "uploaded",
            "printing"
        ],
        "{log:?}"
    );

    // The printer received exactly the bytes the cloud sent, and the delivery is gone.
    let state = mocks.state().await;
    assert!(
        state["moonraker"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["sha256"] == hash.as_str()),
        "{state}"
    );
    assert_eq!(
        call(&mut ws, 11, "inbox.list", json!({})).await["result"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let again = call(
        &mut ws,
        12,
        "upload",
        json!({ "printerId": "bay-4", "deliveryId": id, "token": token }),
    )
    .await;
    assert_eq!(again["error"]["code"], "not_found", "{again}");
}

#[tokio::test]
async fn bad_offers_are_refused_and_reported_to_the_cloud() {
    let (_link, mocks, mut ws) = inbox_rig().await;
    let data = b"G28\nG1 X10\n".to_vec();
    let mut wrong_hash = offer("hash.gcode", &data);
    wrong_hash["sha256"] = json!("0".repeat(64));
    let mut too_long = offer("long.gcode", &data);
    too_long["bytes"] = json!(data.len() + 10);
    let mut too_short = offer("short.gcode", &data);
    too_short["bytes"] = json!(data.len() - 2);
    let mut bad_path = offer("path.gcode", &data);
    bad_path["gcodePath"] = json!("/v1/jobs/../../etc/passwd");
    let mut other_printer = offer("other.gcode", &data);
    other_printer["printerLocalId"] = json!("bay-9");
    for spec in [
        wrong_hash,
        too_long,
        too_short,
        bad_path,
        other_printer,
        offer("with space.gcode", &data),
        offer("script.sh", &data),
        offer("../up.gcode", &data),
        offer(".hidden.gcode", &data),
    ] {
        mocks.offer(spec).await;
    }
    let log = mocks.wait_log("cloud state .hidden.gcode failed").await;
    let failed: Vec<&String> = log
        .iter()
        .filter(|l| l.starts_with("cloud state ") && l.contains(" failed"))
        .collect();
    assert_eq!(failed.len(), 9, "every bad offer is reported failed: {log:?}");
    assert!(
        failed
            .iter()
            .any(|l| l.contains("hash.gcode failed (checksum mismatch)")),
        "{failed:?}"
    );
    assert!(
        failed
            .iter()
            .any(|l| l.contains("other.gcode failed (that printer is not connected")),
        "{failed:?}"
    );
    assert!(failed.iter().all(|l| !l.contains("sxk_")));
    // None of them was downloaded or held.
    assert!(log.iter().all(|l| !l.contains(" downloaded")), "{log:?}");
    assert_eq!(
        call(&mut ws, 3, "inbox.list", json!({})).await["result"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
async fn a_delivery_can_be_declined() {
    let (_link, mocks, mut ws) = inbox_rig().await;
    let id = mocks.offer(offer("nope.gcode", b"G28\n")).await;
    let ev = next_inbox_event(&mut ws).await;
    assert_eq!(ev["state"], "awaiting_approval");
    let r = call(&mut ws, 3, "inbox.decline", json!({ "deliveryId": id })).await;
    assert_eq!(r["result"]["declined"], true, "{r}");
    mocks.wait_log("cloud state nope.gcode declined").await;
    let ev = next_inbox_event(&mut ws).await;
    assert_eq!(ev["state"], "declined");
    let r = call(&mut ws, 4, "inbox.decline", json!({ "deliveryId": id })).await;
    assert_eq!(r["error"]["code"], "not_found");
    let token = json!({ "requestId": "r", "token": "t", "expiresAt": "2099-01-01T00:00:00.000Z" });
    let r = call(
        &mut ws,
        5,
        "upload",
        json!({ "printerId": "bay-4", "deliveryId": id, "token": token }),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_found");
}

#[tokio::test]
async fn the_inbox_needs_a_safe_address_and_a_token() {
    use sx_link::InboxConfig;
    let cfg = |url: &str, token: &str| LinkConfig {
        port: 0,
        extra_origins: Vec::new(),
        fixed_code: Some(CODE.to_owned()),
        inbox: Some(InboxConfig {
            url: url.to_owned(),
            token: token.to_owned(),
        }),
        pair_limits: PairLimits::default(),
        mdns: MdnsConfig::default(),
        ..LinkConfig::default()
    };
    for (url, token) in [
        ("http://cloud.example.com", "sxk_t"),
        ("https://user@cloud.example.com", "sxk_t"),
        ("https://cloud.example.com", ""),
    ] {
        let r = serve(
            cfg(url, token),
            Arc::new(MemoryGate::new()),
            Arc::new(MemorySecrets::new()),
        )
        .await;
        assert!(r.is_err(), "{url} with token {token:?} must be refused");
    }
    // A bridge without an inbox says so.
    let link = start(Arc::new(MemoryGate::new())).await;
    let mut ws = paired(&link).await;
    let r = call(&mut ws, 2, "inbox.list", json!({})).await;
    assert_eq!(r["error"]["code"], "not_supported");
}

// ---- the LAN listener for phones ----

async fn lan_rig(limits: PairLimits) -> (Link, Ws, u16) {
    let cfg = LinkConfig {
        port: 0,
        extra_origins: Vec::new(),
        fixed_code: Some(CODE.to_owned()),
        inbox: None,
        pair_limits: limits,
        // Loopback only and no mDNS: the phones here are local, and the OS firewall has nothing to ask.
        mdns: MdnsConfig {
            disabled: true,
            ..MdnsConfig::default()
        },
        lan_bind: Some(std::net::IpAddr::from([127, 0, 0, 1])),
        ..LinkConfig::default()
    };
    let link = serve(cfg, Arc::new(MemoryGate::new()), Arc::new(MemorySecrets::new()))
        .await
        .unwrap();
    let mut ws = paired(&link).await;
    let r = call(&mut ws, 2, "pair.listen", json!({ "enabled": true, "port": 0 })).await;
    let port = u16::try_from(r["result"]["port"].as_u64().unwrap_or_else(|| panic!("{r}"))).unwrap();
    assert_eq!(r["result"]["listening"], true);
    // The machine's addresses for the phone's QR code: never loopback, always private or link-local.
    for a in r["result"]["addresses"]
        .as_array()
        .unwrap_or_else(|| panic!("no addresses: {r}"))
    {
        let a = a.as_str().unwrap();
        assert!(!a.starts_with("127.") && a != "::1", "{a}");
        assert!(
            a.starts_with("10.")
                || a.starts_with("192.168.")
                || a.starts_with("172.")
                || a.starts_with("fe80:"),
            "{a}"
        );
    }
    (link, ws, port)
}

async fn phone(
    port: u16,
    path: &str,
    origin: Option<&str>,
) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
    let mut req = format!("ws://127.0.0.1:{port}{path}")
        .into_client_request()
        .unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    connect_async(req).await.map(|(ws, _)| ws)
}

/// The next event with this name on the localhost socket.
async fn event(ws: &mut Ws, name: &str) -> Value {
    for _ in 0..100 {
        let Ok(Some(Ok(Message::Text(t)))) =
            tokio::time::timeout(Duration::from_millis(100), ws.next()).await
        else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["event"] == name {
            return v;
        }
    }
    panic!("no {name} event");
}

/// True when the socket is closed (or closes) within a moment.
async fn ends(ws: &mut Ws) -> bool {
    loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Err(_) => return false,
            Ok(None | Some(Err(_) | Ok(Message::Close(_)))) => return true,
            Ok(Some(Ok(_))) => {}
        }
    }
}

#[tokio::test]
async fn phone_frames_pass_through_unread_in_both_directions() {
    let (_link, mut local, port) = lan_rig(PairLimits::default()).await;
    let mut p = phone(port, "/pair", None).await.unwrap();

    p.send(Message::text("hello from the phone")).await.unwrap();
    let ev = event(&mut local, "pair").await;
    assert_eq!(ev["frame"], "hello from the phone");
    let conn = ev["conn"].as_str().unwrap().to_owned();

    let r = call(
        &mut local,
        10,
        "pair.send",
        json!({ "conn": conn, "frame": "hello from the app" }),
    )
    .await;
    assert_eq!(r["result"]["sent"], true, "{r}");
    let Some(Ok(Message::Text(t))) = p.next().await else {
        panic!("no frame")
    };
    assert_eq!(t.as_str(), "hello from the app");

    // A frame that looks like a printer request is just bytes: it is forwarded, never answered.
    p.send(Message::text(r#"{"id":1,"method":"list","params":{}}"#))
        .await
        .unwrap();
    let ev = event(&mut local, "pair").await;
    assert_eq!(ev["frame"], r#"{"id":1,"method":"list","params":{}}"#);
    assert!(
        tokio::time::timeout(Duration::from_millis(300), p.next())
            .await
            .is_err(),
        "the LAN port must not answer with printer data"
    );

    // pair.close from the app ends the phone's socket, and the app is told it closed. The reply and
    // the event can arrive in either order, so read until both are in.
    local
        .send(Message::text(
            json!({ "id": 11, "method": "pair.close", "params": { "conn": conn } }).to_string(),
        ))
        .await
        .unwrap();
    let (mut replied, mut closed) = (false, false);
    for _ in 0..100 {
        if replied && closed {
            break;
        }
        let Ok(Some(Ok(Message::Text(t)))) =
            tokio::time::timeout(Duration::from_millis(100), local.next()).await
        else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["id"] == 11 {
            assert_eq!(v["result"]["closed"], true, "{v}");
            replied = true;
        }
        if v["event"] == "pair.closed" && v["conn"] == conn.as_str() {
            closed = true;
        }
    }
    assert!(replied && closed, "reply {replied}, event {closed}");
    assert!(ends(&mut p).await);
    let r = call(&mut local, 12, "pair.send", json!({ "conn": conn, "frame": "x" })).await;
    assert_eq!(r["error"]["code"], "not_found");

    // A phone that leaves is reported too.
    let mut p2 = phone(port, "/pair", None).await.unwrap();
    p2.send(Message::text("hi")).await.unwrap();
    let conn2 = event(&mut local, "pair").await["conn"]
        .as_str()
        .unwrap()
        .to_owned();
    p2.close(None).await.unwrap();
    assert_eq!(event(&mut local, "pair.closed").await["conn"], conn2.as_str());
}

#[tokio::test]
async fn the_lan_port_serves_only_pair_and_refuses_browsers() {
    let (_link, _local, port) = lan_rig(PairLimits::default()).await;
    assert!(phone(port, "/", None).await.is_err());
    assert!(phone(port, "/pair/extra", None).await.is_err());
    assert!(
        phone(port, "/pair", Some("https://evil.example")).await.is_err(),
        "a web page may not reach the phone port"
    );
    assert!(phone(port, "/pair", Some("https://slicerx.app")).await.is_ok());
}

#[tokio::test]
async fn binary_and_oversize_frames_end_the_connection() {
    let (_link, mut local, port) = lan_rig(PairLimits::default()).await;
    let mut p = phone(port, "/pair", None).await.unwrap();
    p.send(Message::binary(vec![1_u8, 2, 3])).await.unwrap();
    assert!(ends(&mut p).await, "binary frames are refused");
    assert!(event(&mut local, "pair.closed").await["conn"].is_string());

    let mut big = phone(port, "/pair", None).await.unwrap();
    let _ = big
        .send(Message::text("x".repeat(sx_link::PAIR_MAX_FRAME + 1)))
        .await;
    assert!(ends(&mut big).await, "frames over 1.5 MB are refused");
    // The app cannot send one either.
    let r = call(
        &mut local,
        20,
        "pair.send",
        json!({ "conn": "c1", "frame": "x".repeat(sx_link::PAIR_MAX_FRAME + 1) }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request", "{r}");
}

#[tokio::test]
async fn connections_and_rates_are_capped() {
    let (_link, _local, port) = lan_rig(PairLimits {
        max_connections: 3,
        per_address_per_minute: 100,
    })
    .await;
    let mut open = Vec::new();
    for _ in 0..3 {
        open.push(phone(port, "/pair", None).await.unwrap());
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        phone(port, "/pair", None).await.is_err(),
        "the fourth connection is over the cap"
    );
    drop(open);

    let (_link, _local, port) = lan_rig(PairLimits {
        max_connections: 64,
        per_address_per_minute: 4,
    })
    .await;
    for _ in 0..4 {
        let mut p = phone(port, "/pair", None).await.unwrap();
        let _ = p.close(None).await;
    }
    assert!(
        phone(port, "/pair", None).await.is_err(),
        "the fifth attempt in a minute is refused"
    );
}

#[tokio::test]
async fn the_listener_stops_when_asked_and_stays_up_when_the_app_leaves() {
    let (link, mut local, port) = lan_rig(PairLimits::default()).await;
    let mut p = phone(port, "/pair", None).await.unwrap();
    p.send(Message::text("hi")).await.unwrap();
    let _ = event(&mut local, "pair").await;
    let r = call(&mut local, 30, "pair.listen", json!({ "enabled": false })).await;
    assert_eq!(r["result"]["listening"], false);
    assert!(ends(&mut p).await, "stopping closes every phone connection");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(phone(port, "/pair", None).await.is_err());

    // Turned on again, then the app that turned it on goes away: the hub keeps the port, and what a
    // phone sends meanwhile waits for the next client that pairs.
    let r = call(
        &mut local,
        31,
        "pair.listen",
        json!({ "enabled": true, "port": 0 }),
    )
    .await;
    let port2 = u16::try_from(r["result"]["port"].as_u64().unwrap()).unwrap();
    local.close(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut p = phone(port2, "/pair", None)
        .await
        .expect("the phone port stays open with the app closed");
    p.send(Message::text("while the app was closed")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut back = paired(&link).await;
    let e = event(&mut back, "pair").await;
    assert_eq!(e["frame"], "while the app was closed", "{e}");
    // The new client can answer that phone.
    let r = call(
        &mut back,
        32,
        "pair.send",
        json!({ "conn": e["conn"], "frame": "hello again" }),
    )
    .await;
    assert_eq!(r["result"]["sent"], true, "{r}");
}

// ---- mDNS: advertising the phone listener, and discovering printers ----

fn mdns_rig(mdns: MdnsConfig) -> LinkConfig {
    LinkConfig {
        port: 0,
        extra_origins: Vec::new(),
        fixed_code: Some(CODE.to_owned()),
        inbox: None,
        pair_limits: PairLimits::default(),
        mdns,
        lan_bind: Some(std::net::IpAddr::from([127, 0, 0, 1])),
        discovery_bind: Some(std::net::IpAddr::from([127, 0, 0, 1])),
        ..LinkConfig::default()
    }
}

async fn next_packet(sock: &tokio::net::UdpSocket) -> sx_connect::mdns::Message {
    let mut buf = vec![0_u8; 9000];
    let (n, _) = tokio::time::timeout(Duration::from_secs(3), sock.recv_from(&mut buf))
        .await
        .expect("a packet in time")
        .unwrap();
    sx_connect::mdns::parse(&buf[..n]).expect("a valid mDNS packet")
}

#[tokio::test]
async fn the_phone_listener_is_advertised_while_it_is_on_and_withdrawn_when_it_stops() {
    use sx_connect::mdns::{Rdata, encode_query};
    // Where announcements go, and the port the responder listens on for queries.
    let heard = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let probe = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let responder = probe.local_addr().unwrap();
    drop(probe);
    let cfg = mdns_rig(MdnsConfig {
        disabled: false,
        browse_target: None,
        onvif_target: None,
        advert_bind: Some(responder),
        advert_to: Some(heard.local_addr().unwrap()),
    });
    let link = serve(cfg, Arc::new(MemoryGate::new()), Arc::new(MemorySecrets::new()))
        .await
        .unwrap();
    let mut ws = paired(&link).await;
    let r = call(&mut ws, 2, "pair.listen", json!({ "enabled": true, "port": 0 })).await;
    assert_eq!(r["result"]["advertised"], true, "{r}");
    let port = u16::try_from(r["result"]["port"].as_u64().unwrap()).unwrap();

    // The announcement names the service and port, and carries nothing about the user or a secret.
    let m = next_packet(&heard).await;
    assert!(m.response);
    let text = format!("{:?}", m.records);
    let hostname = std::env::var("HOSTNAME").unwrap_or_default();
    assert!(hostname.is_empty() || !text.contains(&hostname), "{text}");
    assert!(!text.contains(CODE), "{text}");
    assert!(
        m.records
            .iter()
            .any(|r| r.name == "_slicerx._tcp.local" && r.ttl > 0)
    );
    assert!(
        m.records
            .iter()
            .any(|r| matches!(&r.data, Rdata::Srv { port: p, .. } if *p == port))
    );
    assert!(
        m.records
            .iter()
            .any(|r| r.data == Rdata::Txt(vec!["v=1".to_owned()]))
    );

    // A phone that asks gets an answer by unicast; an unrelated question gets none.
    let phone = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    phone
        .send_to(&encode_query(&["_ipp._tcp.local"]), responder)
        .await
        .unwrap();
    phone
        .send_to(&encode_query(&["_slicerx._tcp.local"]), responder)
        .await
        .unwrap();
    let a = next_packet(&phone).await;
    assert!(a.records.iter().any(|r| r.name == "_slicerx._tcp.local"));

    // Turning the listener off withdraws the service.
    let r = call(&mut ws, 3, "pair.listen", json!({ "enabled": false })).await;
    assert_eq!(r["result"]["listening"], false);
    loop {
        let m = next_packet(&heard).await;
        if m.records.iter().all(|r| r.ttl == 0) {
            break;
        }
    }
}

#[tokio::test]
async fn no_mdns_means_no_advert() {
    let cfg = mdns_rig(MdnsConfig {
        disabled: true,
        ..MdnsConfig::default()
    });
    let link = serve(cfg, Arc::new(MemoryGate::new()), Arc::new(MemorySecrets::new()))
        .await
        .unwrap();
    let mut ws = paired(&link).await;
    let r = call(&mut ws, 2, "pair.listen", json!({ "enabled": true, "port": 0 })).await;
    assert_eq!(r["result"]["listening"], true);
    assert_eq!(r["result"]["advertised"], false);
}

#[tokio::test]
async fn discover_lists_printers_announced_over_mdns_and_drops_addresses_off_the_network() {
    use sx_connect::mdns::Advert;
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let mock_port = mocks.port("moonraker");
    // A network stand-in that answers any query with a Moonraker on the mock's port and a second
    // one on a public address, which the bridge must not list.
    let net = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let target = net.local_addr().unwrap();
    let mk = |instance: &str, ip: std::net::Ipv4Addr, port: u16| Advert {
        service: "_moonraker._tcp.local".to_owned(),
        instance: instance.to_owned(),
        host: format!("{instance}.local"),
        port,
        addresses: vec![std::net::IpAddr::V4(ip)],
        txt: Vec::new(),
    };
    let lan = mk("bay-4", std::net::Ipv4Addr::LOCALHOST, mock_port);
    let public = mk("elsewhere", std::net::Ipv4Addr::new(8, 8, 8, 8), 7125);
    let responder = tokio::spawn(async move {
        let mut buf = vec![0_u8; 2048];
        loop {
            let Ok((n, from)) = net.recv_from(&mut buf).await else {
                return;
            };
            for a in [&lan, &public] {
                if let Some((resp, _)) = a.answer(&buf[..n]) {
                    let _ = net.send_to(&resp, from).await;
                }
            }
        }
    });
    let cfg = mdns_rig(MdnsConfig {
        browse_target: Some(target),
        ..MdnsConfig::default()
    });
    let link = serve(cfg, Arc::new(MemoryGate::new()), Arc::new(MemorySecrets::new()))
        .await
        .unwrap();
    let mut ws = paired(&link).await;
    let r = call(&mut ws, 2, "discover", json!({ "timeoutMs": 500 })).await;
    responder.abort();
    let list = r["result"]["printers"]
        .as_array()
        .unwrap_or_else(|| panic!("{r}"));
    let moon: Vec<&Value> = list.iter().filter(|p| p["plugin"] == "moonraker").collect();
    assert_eq!(moon.len(), 1, "{list:?}");
    assert_eq!(moon[0]["host"], "127.0.0.1");
    assert_eq!(moon[0]["port"], mock_port);
    assert_eq!(moon[0]["name"], "bay-4");
    assert!(list.iter().all(|p| p["host"] != "8.8.8.8"), "{list:?}");
    // The listed address works: a printer added from the result connects to the mock.
    let r = call(
        &mut ws,
        3,
        "printers.add",
        json!({ "config": { "id": "found", "name": "Found", "plugin": "moonraker", "host": "127.0.0.1", "port": mock_port } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(&mut ws, 4, "status", json!({ "printerId": "found" })).await;
    assert_ne!(r["result"]["state"], "offline", "{r}");
}

#[tokio::test]
async fn testing_a_printer_reports_how_far_it_got_and_registers_nothing() {
    let mocks = common::Mocks::start("moonraker", &[]).await;
    let port = mocks.port("moonraker");
    let link = serve(
        mdns_rig(MdnsConfig::default()),
        Arc::new(MemoryGate::new()),
        Arc::new(MemorySecrets::new()),
    )
    .await
    .unwrap();
    let mut ws = paired(&link).await;
    let cfg = |host: &str, port: u16| json!({ "config": { "id": "t", "name": "T", "plugin": "moonraker", "host": host, "port": port } });

    let r = call(&mut ws, 2, "printers.test", cfg("127.0.0.1", port)).await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    assert_eq!(r["result"]["state"], "idle");
    let steps = r["result"]["steps"].as_array().unwrap();
    assert!(steps.iter().all(|s| s["ok"] == true), "{steps:?}");
    // The printer's own report fills setup: Klipper's nozzle diameter and version.
    assert_eq!(
        r["result"]["hardware"]["extruders"][0]["nozzleDiameterMm"], 0.4,
        "{r}"
    );
    assert_eq!(r["result"]["hardware"]["firmware"], "Klipper v0.12.0-mock");

    // A closed port: the printer cannot be reached, and nothing after that ran.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_port = closed.local_addr().unwrap().port();
    drop(closed);
    let r = call(&mut ws, 3, "printers.test", cfg("127.0.0.1", closed_port)).await;
    assert_eq!(r["result"]["ok"], false, "{r}");
    assert_eq!(r["result"]["cause"], "unreachable");
    assert_eq!(r["result"]["steps"][0]["ok"], false);
    assert!(r["result"]["steps"][1]["ok"].is_null());

    let r = call(&mut ws, 4, "printers.test", cfg("8.8.8.8", 80)).await;
    assert_eq!(r["result"]["cause"], "bad_request");
    let r = call(
        &mut ws,
        5,
        "printers.test",
        json!({ "config": { "id": "t", "name": "T", "plugin": "nope", "host": "127.0.0.1" } }),
    )
    .await;
    assert_eq!(r["result"]["cause"], "not_supported");

    // The test never registers the printer.
    let r = call(&mut ws, 6, "list", json!({})).await;
    assert_eq!(r["result"].as_array().unwrap().len(), 0);
}

// ---- live camera ----

/// The next binary message: (kind, key, stream, capture ms, payload).
async fn next_frame(ws: &mut Ws) -> (u8, bool, u32, u64, Vec<u8>) {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(8), ws.next())
            .await
            .expect("a frame in time")
            .expect("open")
            .expect("ok");
        if let Message::Binary(b) = m {
            assert_eq!(b[0], 0xC1, "camera frame magic");
            let stream = u32::from_be_bytes(b[4..8].try_into().unwrap());
            let ts = u64::from_be_bytes(b[8..16].try_into().unwrap());
            return (b[1], b[2] & 1 == 1, stream, ts, b[16..].to_vec());
        }
    }
}

async fn camera_rig(only: &str, extra: &[&str]) -> (Link, common::Mocks, Ws) {
    let mocks = common::Mocks::start(only, extra).await;
    let link = serve(
        mdns_rig(MdnsConfig::default()),
        Arc::new(MemoryGate::new()),
        Arc::new(MemorySecrets::new()),
    )
    .await
    .unwrap();
    let ws = paired(&link).await;
    (link, mocks, ws)
}

#[tokio::test]
async fn a_camera_streams_jpeg_frames_and_follows_quality_and_close() {
    let (_link, mocks, mut ws) = camera_rig("moonraker", &["--camera"]).await;
    let port = mocks.port("moonraker");
    let r = call(
        &mut ws,
        2,
        "printers.add",
        json!({ "config": { "id": "cam1", "name": "Cam", "plugin": "moonraker", "host": "127.0.0.1", "port": port } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");

    let r = call(
        &mut ws,
        3,
        "camera.open",
        json!({ "printerId": "cam1", "quality": "medium" }),
    )
    .await;
    assert_eq!(r["result"]["quality"], "medium", "{r}");
    assert_eq!(r["result"]["route"], "lan");
    let stream = u32::try_from(r["result"]["stream"].as_u64().unwrap()).unwrap();
    for _ in 0..3 {
        let (kind, key, id, ts, data) = next_frame(&mut ws).await;
        assert_eq!((kind, key, id), (1, true, stream));
        assert!(data.starts_with(&[0xff, 0xd8]) && data.ends_with(&[0xff, 0xd9]));
        assert!(now_ms().abs_diff(ts) < 5000, "capture time is the bridge clock");
    }
    let r = call(
        &mut ws,
        4,
        "camera.quality",
        json!({ "stream": stream, "quality": "low" }),
    )
    .await;
    assert_eq!(r["result"]["quality"], "low");
    let r = call(
        &mut ws,
        5,
        "camera.quality",
        json!({ "stream": stream, "quality": "ultra" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request");
    let r = call(
        &mut ws,
        6,
        "camera.quality",
        json!({ "stream": 999, "quality": "low" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_found");

    let r = call(&mut ws, 7, "camera.close", json!({ "stream": stream })).await;
    assert_eq!(r["result"]["closed"], true);
    // Frames already on the wire may still arrive; then nothing more.
    tokio::time::sleep(Duration::from_millis(400)).await;
    while let Ok(Some(Ok(_))) = tokio::time::timeout(Duration::from_millis(50), ws.next()).await {}
    let quiet = tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            if let Some(Ok(Message::Binary(_))) = ws.next().await {
                return true;
            }
        }
    })
    .await;
    assert!(quiet.is_err(), "no frames after close");
}

fn now_ms() -> u64 {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

#[tokio::test]
async fn a_printer_without_a_camera_says_so_and_the_probe_measures_one_that_has() {
    let (_link, mocks, mut ws) = camera_rig("prusalink", &[]).await;
    let r = call(
        &mut ws,
        2,
        "printers.add",
        json!({ "config": { "id": "mk4", "name": "MK4S", "plugin": "prusalink", "host": "127.0.0.1", "port": mocks.port("prusalink") } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(&mut ws, 3, "camera.open", json!({ "printerId": "mk4" })).await;
    assert_eq!(r["error"]["code"], "not_supported", "{r}");
    let r = call(&mut ws, 4, "camera.open", json!({ "printerId": "nope" })).await;
    assert_eq!(r["error"]["code"], "not_found");

    let (_link, mocks, mut ws) = camera_rig("moonraker", &["--camera"]).await;
    let r = call(
        &mut ws,
        2,
        "printers.add",
        json!({ "config": { "id": "cam1", "name": "Cam", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker") } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        3,
        "camera.probe",
        json!({ "printerId": "cam1", "windowMs": 800 }),
    )
    .await;
    let p = &r["result"];
    assert_eq!(p["ok"], true, "{r}");
    assert_eq!(p["kind"], "jpeg");
    assert!(p["fps"].as_f64().unwrap() > 3.0, "{p}");
    assert!(p["firstFrameMs"].as_u64().unwrap() < 1500, "{p}");
    assert_eq!(p["recommended"], "high");
}

// Status calls that arrive together, from two app windows or the app and the bridge's own watcher,
// share one connection to the printer instead of each opening one.
#[tokio::test]
async fn simultaneous_status_calls_open_one_printer_connection() {
    let mocks = common::Mocks::start("bambu", &[]).await;
    let link = serve(
        mdns_rig(MdnsConfig::default()),
        Arc::new(MemoryGate::new()),
        Arc::new(MemorySecrets::new()),
    )
    .await
    .unwrap();
    let mut a = paired(&link).await;
    let mut b = paired(&link).await;
    let r = call(
        &mut a,
        2,
        "secrets.set",
        json!({ "name": "bambu-code", "value": mocks.str("accessCode") }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut a,
        3,
        "printers.add",
        json!({ "config": {
            "id": "h2d", "name": "H2D", "plugin": "bambu-lan", "host": "127.0.0.1", "port": mocks.port("bambu"),
            "serial": mocks.str("serial"), "credentialRef": "bambu-code",
        } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let (ra, rb) = tokio::join!(
        call(&mut a, 4, "status", json!({ "printerId": "h2d" })),
        call(&mut b, 4, "status", json!({ "printerId": "h2d" })),
    );
    assert_eq!(ra["result"]["state"], "idle", "{ra}");
    assert_eq!(rb["result"]["state"], "idle", "{rb}");
    let connects = mocks.state().await["log"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| *l == "mqtt connect")
        .count();
    assert_eq!(connects, 1);
}

// Reading a Bambu Lab printer's status, as the app does for every printer as soon as it starts,
// never listens for printers on the network: that is a search, and only the person starts one. The
// printer's announced name is still heard by the search they start.
#[tokio::test]
async fn reading_a_status_never_listens_for_printers() {
    let mocks = common::Mocks::start("bambu", &[]).await;
    let serial = mocks.str("serial");
    let link = serve(
        mdns_rig(MdnsConfig::default()),
        Arc::new(MemoryGate::new()),
        Arc::new(MemorySecrets::new()),
    )
    .await
    .unwrap();
    let mut ws = paired(&link).await;
    let r = call(
        &mut ws,
        2,
        "secrets.set",
        json!({ "name": "bambu-code", "value": mocks.str("accessCode") }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        3,
        "printers.add",
        json!({ "config": {
            "id": "h2d", "name": "H2D", "plugin": "bambu-lan", "host": "127.0.0.1", "port": mocks.port("bambu"),
            "serial": serial, "credentialRef": "bambu-code",
        } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    // The printer announces itself on the discovery ports, as a real one does every few seconds.
    let notify = format!(
        "NOTIFY * HTTP/1.1\r\nHost: 239.255.255.250:1990\r\nLocation: 127.0.0.1\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nNTS: ssdp:alive\r\nUSN: {serial}\r\nDevModel.bambu.com: O1D\r\nDevName.bambu.com: Workshop H2D\r\n\r\n"
    );
    let announcer = tokio::spawn(async move {
        let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        loop {
            for port in [2021, 1990] {
                let _ = sock.send_to(notify.as_bytes(), ("127.0.0.1", port)).await;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    let r = call(&mut ws, 4, "status", json!({ "printerId": "h2d" })).await;
    assert_eq!(r["result"]["state"], "idle", "{r}");
    // Longer than a listen that started on its own would take to finish and keep what it heard.
    tokio::time::sleep(Duration::from_secs(7)).await;
    let r = call(&mut ws, 5, "status", json!({ "printerId": "h2d" })).await;
    assert_eq!(r["result"]["state"], "idle", "{r}");
    assert!(
        r["result"]["ownName"].is_null(),
        "the hub listened for printers without a search: {r}"
    );
    // Search my network hears the same announcement, and the status then carries the name.
    let r = call(&mut ws, 6, "discover", json!({ "timeoutMs": 800 })).await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(&mut ws, 7, "status", json!({ "printerId": "h2d" })).await;
    announcer.abort();
    assert_eq!(r["result"]["ownName"], "Workshop H2D", "{r}");
}

// A Bambu Lab printer added by address gets its own name with no search: the hub asks that one
// printer, at its own address, and the status carries the answer. Announcements on the discovery
// ports stay unheard, since the hub still listens on none of them.
#[tokio::test]
async fn a_printer_added_by_address_is_asked_its_own_name() {
    let mocks = common::Mocks::start("bambu", &[]).await;
    let serial = mocks.str("serial");
    let link = serve(
        LinkConfig {
            name_ports: vec![mocks.port("bambu-ssdp")],
            ..mdns_rig(MdnsConfig::default())
        },
        Arc::new(MemoryGate::new()),
        Arc::new(MemorySecrets::new()),
    )
    .await
    .unwrap();
    let mut ws = paired(&link).await;
    let r = call(
        &mut ws,
        2,
        "secrets.set",
        json!({ "name": "bambu-code", "value": mocks.str("accessCode") }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let notify = format!(
        "NOTIFY * HTTP/1.1\r\nHost: 239.255.255.250:1990\r\nLocation: 127.0.0.1\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nNTS: ssdp:alive\r\nUSN: {serial}\r\nDevModel.bambu.com: O1D\r\nDevName.bambu.com: Workshop H2D\r\n\r\n"
    );
    let announcer = tokio::spawn(async move {
        let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        loop {
            for port in [2021, 1990] {
                let _ = sock.send_to(notify.as_bytes(), ("127.0.0.1", port)).await;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    let r = call(
        &mut ws,
        3,
        "printers.add",
        json!({ "config": {
            "id": "h2d", "name": "H2D", "plugin": "bambu-lan", "host": "127.0.0.1", "port": mocks.port("bambu"),
            "serial": serial, "credentialRef": "bambu-code",
        } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let mut named = Value::Null;
    for id in 4..40 {
        let r = call(&mut ws, id, "status", json!({ "printerId": "h2d" })).await;
        assert_eq!(r["result"]["state"], "idle", "{r}");
        named = r["result"]["ownName"].clone();
        if !named.is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    announcer.abort();
    assert_eq!(named, "Bay 1", "the printer's own answer, not an announcement");
    let log = mocks.state().await["log"].clone();
    assert!(
        log.as_array().unwrap().iter().any(|l| l == "ssdp search"),
        "{log}"
    );
}

// The printer view open on an H2D for 10 seconds: subscribed to its events, reading its status
// twice a second and showing its camera, with the bridge's own watcher running too. All of it
// shares one MQTT connection, which stays up the whole time.
#[tokio::test]
async fn an_open_printer_view_keeps_one_printer_connection_for_ten_seconds() {
    let mocks = common::Mocks::start("bambu", &[]).await;
    mocks.control("/bambu", json!({ "model": "O1D" })).await;
    let link = serve(
        mdns_rig(MdnsConfig::default()),
        Arc::new(MemoryGate::new()),
        Arc::new(MemorySecrets::new()),
    )
    .await
    .unwrap();
    let mut ws = paired(&link).await;
    let r = call(
        &mut ws,
        2,
        "secrets.set",
        json!({ "name": "bambu-code", "value": mocks.str("accessCode") }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        3,
        "printers.add",
        json!({ "config": {
            "id": "h2d", "name": "H2D", "plugin": "bambu-lan", "host": "127.0.0.1", "port": mocks.port("bambu"),
            "serial": mocks.str("serial"), "credentialRef": "bambu-code",
            "rtspPort": mocks.port("bambu-rtsps"),
        } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(&mut ws, 4, "subscribe", json!({ "printerId": "h2d" })).await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        5,
        "camera.open",
        json!({ "printerId": "h2d", "quality": "high" }),
    )
    .await;
    assert!(r["result"]["stream"].is_u64(), "{r}");
    let end = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut id = 10;
    while tokio::time::Instant::now() < end {
        let r = call(&mut ws, id, "status", json!({ "printerId": "h2d" })).await;
        assert_eq!(r["result"]["state"], "idle", "{r}");
        assert_eq!(r["result"]["cameraAvailable"], true, "{r}");
        id += 1;
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let log: Vec<String> = mocks.state().await["log"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l.as_str().map(str::to_owned))
        .collect();
    assert_eq!(log.iter().filter(|l| *l == "mqtt connect").count(), 1, "{log:?}");
    assert!(!log.iter().any(|l| l.starts_with("mqtt takeover")), "{log:?}");
}

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

// One camera connection per printer. With the printer view open, the tile stills read its feed:
// the last key frame at once, no new RTSP session. With no view open a still opens the camera,
// takes the first key frame and lets go; the session ends with TEARDOWN once nobody reads.
#[tokio::test]
async fn stills_and_the_live_view_share_one_camera_session() {
    let mocks = common::Mocks::start("bambu", &[]).await;
    mocks.control("/bambu", json!({ "model": "O1D" })).await;
    let link = serve(
        mdns_rig(MdnsConfig::default()),
        Arc::new(MemoryGate::new()),
        Arc::new(MemorySecrets::new()),
    )
    .await
    .unwrap();
    let mut ws = paired(&link).await;
    let r = call(
        &mut ws,
        2,
        "secrets.set",
        json!({ "name": "bambu-code", "value": mocks.str("accessCode") }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        3,
        "printers.add",
        json!({ "config": {
            "id": "h2d", "name": "H2D", "plugin": "bambu-lan", "host": "127.0.0.1", "port": mocks.port("bambu"),
            "serial": mocks.str("serial"), "credentialRef": "bambu-code",
            "rtspPort": mocks.port("bambu-rtsps"),
        } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        4,
        "camera.open",
        json!({ "printerId": "h2d", "quality": "high" }),
    )
    .await;
    let stream = r["result"]["stream"].as_u64().unwrap_or_else(|| panic!("{r}"));
    tokio::time::sleep(Duration::from_millis(800)).await;
    for id in 5..8 {
        let started = std::time::Instant::now();
        // The mock's frames are placeholders no decoder takes, so the still itself fails; what
        // counts is that it came from the open feed, at once.
        call(&mut ws, id, "camera.grab", json!({ "printerId": "h2d" })).await;
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "a still from the open feed is quick"
        );
    }
    assert_eq!(rtsp_lines(&mocks.state().await), ["rtsp PLAY ok"]);
    call(&mut ws, 9, "camera.close", json!({ "stream": stream })).await;
    // The feed lingers 12 s for the next view or still, then ends with TEARDOWN.
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert_eq!(rtsp_lines(&mocks.state().await), ["rtsp PLAY ok"]);
    tokio::time::sleep(Duration::from_secs(8)).await;
    assert_eq!(
        rtsp_lines(&mocks.state().await),
        ["rtsp PLAY ok", "rtsp TEARDOWN ok"]
    );
    // While the camera rests after that (15 s), a still is the last key frame, no new session.
    call(&mut ws, 10, "camera.grab", json!({ "printerId": "h2d" })).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(
        rtsp_lines(&mocks.state().await),
        ["rtsp PLAY ok", "rtsp TEARDOWN ok"]
    );
    // After the rest a still opens its own session, ended with TEARDOWN as soon as it has its key
    // frame, without the linger a view gets.
    tokio::time::sleep(Duration::from_secs(16)).await;
    call(&mut ws, 11, "camera.grab", json!({ "printerId": "h2d" })).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(
        rtsp_lines(&mocks.state().await),
        [
            "rtsp PLAY ok",
            "rtsp TEARDOWN ok",
            "rtsp PLAY ok",
            "rtsp TEARDOWN ok"
        ]
    );
}

// rc13: the H2D dropped PLAY 5 to 10 s after a TEARDOWN and the view sat on "did not start" for
// good. Now the live view opens anyway, hears camera.status retrying, and gets frames once the
// feed's next try gets in, 2 s later.
#[tokio::test]
async fn a_live_view_whose_camera_drops_play_keeps_trying_and_says_so() {
    let mocks = common::Mocks::start("bambu", &[]).await;
    mocks
        .control("/bambu", json!({ "model": "O1D", "dropPlays": 1 }))
        .await;
    let link = serve(
        mdns_rig(MdnsConfig::default()),
        Arc::new(MemoryGate::new()),
        Arc::new(MemorySecrets::new()),
    )
    .await
    .unwrap();
    let mut ws = paired(&link).await;
    let r = call(
        &mut ws,
        2,
        "secrets.set",
        json!({ "name": "bambu-code", "value": mocks.str("accessCode") }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        3,
        "printers.add",
        json!({ "config": {
            "id": "h2d", "name": "H2D", "plugin": "bambu-lan", "host": "127.0.0.1", "port": mocks.port("bambu"),
            "serial": mocks.str("serial"), "credentialRef": "bambu-code",
            "rtspPort": mocks.port("bambu-rtsps"),
        } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(&mut ws, 4, "camera.open", json!({ "printerId": "h2d" })).await;
    let stream = r["result"]["stream"]
        .as_u64()
        .unwrap_or_else(|| panic!("the view opens while the feed tries again: {r}"));
    let (mut states, mut frames) = (Vec::new(), 0);
    let end = tokio::time::Instant::now() + Duration::from_secs(15);
    while frames < 3 && tokio::time::Instant::now() < end {
        let Ok(Some(Ok(m))) = tokio::time::timeout_at(end, ws.next()).await else {
            break;
        };
        match m {
            Message::Binary(_) => frames += 1,
            Message::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                if v["event"] == "camera.status" && v["stream"] == stream {
                    states.push((v["state"].as_str().unwrap().to_owned(), v["retryInMs"].as_u64()));
                }
            }
            _ => {}
        }
    }
    assert_eq!(frames, 3, "{states:?}");
    assert_eq!(
        states,
        [("retrying".to_owned(), Some(5000)), ("live".to_owned(), None)]
    );
    let plays: Vec<String> = rtsp_lines(&mocks.state().await)
        .into_iter()
        .filter(|l| l.starts_with("rtsp PLAY"))
        .collect();
    assert_eq!(plays, ["rtsp PLAY dropped", "rtsp PLAY ok"]);
}

// The H2D drops a PLAY that comes soon after a session ended. A still ends its session at its key
// frame; a live view opened right after is dropped, and its feed's first retry, 5 s on, is past the
// window and gets in.
#[tokio::test]
async fn a_live_view_right_after_a_still_waits_out_the_cameras_rest() {
    let mocks = common::Mocks::start("bambu", &[]).await;
    mocks
        .control("/bambu", json!({ "model": "O1D", "dropWithinMs": 4000 }))
        .await;
    let link = serve(
        mdns_rig(MdnsConfig::default()),
        Arc::new(MemoryGate::new()),
        Arc::new(MemorySecrets::new()),
    )
    .await
    .unwrap();
    let mut ws = paired(&link).await;
    let r = call(
        &mut ws,
        2,
        "secrets.set",
        json!({ "name": "bambu-code", "value": mocks.str("accessCode") }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        3,
        "printers.add",
        json!({ "config": {
            "id": "h2d", "name": "H2D", "plugin": "bambu-lan", "host": "127.0.0.1", "port": mocks.port("bambu"),
            "serial": mocks.str("serial"), "credentialRef": "bambu-code",
            "rtspPort": mocks.port("bambu-rtsps"),
        } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    call(&mut ws, 4, "camera.grab", json!({ "printerId": "h2d" })).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let r = call(&mut ws, 5, "camera.open", json!({ "printerId": "h2d" })).await;
    assert!(r["result"]["stream"].is_u64(), "{r}");
    let end = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut frames = 0;
    while frames < 2 && tokio::time::Instant::now() < end {
        if let Ok(Some(Ok(Message::Binary(_)))) = tokio::time::timeout_at(end, ws.next()).await {
            frames += 1;
        }
    }
    assert_eq!(frames, 2);
    assert_eq!(
        rtsp_lines(&mocks.state().await),
        [
            "rtsp PLAY ok",
            "rtsp TEARDOWN ok",
            "rtsp PLAY dropped",
            "rtsp PLAY ok"
        ]
    );
}

// rc14: the H2D stopped sending with the session open, and a live view sat on one frame for over
// a minute. Now the feed counts 3 s without a frame as dead: the viewer hears retrying, the session
// ends with TEARDOWN, a new one opens after the rest, and the viewer hears live and gets frames.
#[tokio::test]
async fn a_live_view_whose_camera_stops_sending_gets_a_new_session() {
    let mocks = common::Mocks::start("bambu", &[]).await;
    mocks.control("/bambu", json!({ "model": "O1D" })).await;
    let link = serve(
        mdns_rig(MdnsConfig::default()),
        Arc::new(MemoryGate::new()),
        Arc::new(MemorySecrets::new()),
    )
    .await
    .unwrap();
    let mut ws = paired(&link).await;
    let r = call(
        &mut ws,
        2,
        "secrets.set",
        json!({ "name": "bambu-code", "value": mocks.str("accessCode") }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        3,
        "printers.add",
        json!({ "config": {
            "id": "h2d", "name": "H2D", "plugin": "bambu-lan", "host": "127.0.0.1", "port": mocks.port("bambu"),
            "serial": mocks.str("serial"), "credentialRef": "bambu-code",
            "rtspPort": mocks.port("bambu-rtsps"),
        } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(&mut ws, 4, "camera.open", json!({ "printerId": "h2d" })).await;
    let stream = r["result"]["stream"].as_u64().unwrap_or_else(|| panic!("{r}"));
    // Frames first; then the camera goes quiet with the connection open.
    let mut states: Vec<String> = Vec::new();
    let mut frames_after_stall = 0;
    let mut stalled = false;
    let mut before = 0;
    let end = tokio::time::Instant::now() + Duration::from_secs(25);
    while frames_after_stall < 3 && tokio::time::Instant::now() < end {
        let Ok(Some(Ok(m))) = tokio::time::timeout_at(end, ws.next()).await else {
            break;
        };
        match m {
            Message::Binary(_) if !stalled => {
                before += 1;
                if before == 3 {
                    mocks.control("/bambu", json!({ "stallCamera": true })).await;
                    stalled = true;
                }
            }
            Message::Binary(_) if states.last().is_some_and(|s| s == "live") => frames_after_stall += 1,
            Message::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                if v["event"] == "camera.status" && v["stream"] == stream {
                    states.push(v["state"].as_str().unwrap().to_owned());
                }
            }
            _ => {}
        }
    }
    assert_eq!(frames_after_stall, 3, "{states:?}");
    assert_eq!(states, ["live", "retrying", "live"]);
    assert_eq!(
        rtsp_lines(&mocks.state().await),
        ["rtsp PLAY ok", "rtsp TEARDOWN ok", "rtsp PLAY ok"]
    );
}

#[tokio::test]
async fn bambu_x1_video_and_a_generic_rtsp_camera_arrive_as_h264() {
    let mocks = common::Mocks::start("bambu,rtsp-camera", &[]).await;
    let link = serve(
        mdns_rig(MdnsConfig::default()),
        Arc::new(MemoryGate::new()),
        Arc::new(MemorySecrets::new()),
    )
    .await
    .unwrap();
    let mut ws = paired(&link).await;
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_port = closed.local_addr().unwrap().port();
    drop(closed);
    let r = call(
        &mut ws,
        2,
        "secrets.set",
        json!({ "name": "bambu-code", "value": mocks.str("accessCode") }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        3,
        "printers.add",
        json!({ "config": {
            "id": "x1", "name": "X1", "plugin": "bambu-lan", "host": "127.0.0.1", "port": mocks.port("bambu"),
            "serial": mocks.str("serial"), "credentialRef": "bambu-code",
            "cameraPort": closed_port, "rtspPort": mocks.port("bambu-rtsps"),
        } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(
        &mut ws,
        4,
        "camera.open",
        json!({ "printerId": "x1", "quality": "high" }),
    )
    .await;
    let stream = u32::try_from(r["result"]["stream"].as_u64().unwrap_or_else(|| panic!("{r}"))).unwrap();
    let (kind, key, id, _, data) = next_frame(&mut ws).await;
    assert_eq!((kind, key, id), (2, true, stream));
    assert_eq!(&data[..5], &[0, 0, 0, 1, 0x67], "SPS first, in Annex B form");
    call(&mut ws, 5, "camera.close", json!({ "stream": stream })).await;

    // A camera that is not the printer's: rtsp URL without a login, the login in the keychain.
    let r = call(
        &mut ws,
        6,
        "secrets.set",
        json!({ "name": "cam-login", "value": "cam:cam-pass" }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let rtsp_url = format!("rtsp://127.0.0.1:{}/live", mocks.port("rtsp-camera"));
    let r = call(
        &mut ws,
        7,
        "printers.add",
        json!({ "config": {
            "id": "ipcam", "name": "IP camera", "plugin": "moonraker", "host": "127.0.0.1",
            "cameraUrl": rtsp_url, "cameraCredentialRef": "cam-login",
        } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(&mut ws, 8, "camera.open", json!({ "printerId": "ipcam" })).await;
    let stream = u32::try_from(r["result"]["stream"].as_u64().unwrap_or_else(|| panic!("{r}"))).unwrap();
    let (kind, key, id, _, _) = next_frame(&mut ws).await;
    assert_eq!((kind, key, id), (2, true, stream));

    // Camera addresses obey the same rules as printers: local network only, no login in the URL.
    for url in [
        "rtsp://8.8.8.8/live",
        "rtsp://cam:pw@127.0.0.1/live",
        "ftp://127.0.0.1/live",
        "http://example.com/x",
    ] {
        let r = call(
            &mut ws,
            9,
            "printers.add",
            json!({ "config": { "id": "bad", "name": "Bad", "plugin": "moonraker", "host": "127.0.0.1", "cameraUrl": url } }),
        )
        .await;
        assert_eq!(r["error"]["code"], "bad_request", "{url}: {r}");
    }
}

#[tokio::test]
async fn webrtc_signaling_passes_through_and_media_is_left_to_the_browser() {
    let (_link, mocks, mut ws) = camera_rig("moonraker", &["--camera"]).await;
    let port = mocks.port("moonraker");
    let r = call(
        &mut ws,
        2,
        "printers.add",
        json!({ "config": { "id": "cam1", "name": "Cam", "plugin": "moonraker", "host": "127.0.0.1", "port": port } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let offer =
        "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n";
    let r = call(
        &mut ws,
        3,
        "camera.webrtc",
        json!({ "printerId": "cam1", "sdp": offer }),
    )
    .await;
    let answer = r["result"]["sdp"].as_str().unwrap_or_else(|| panic!("{r}"));
    assert!(
        answer.starts_with("v=0") && answer.contains("sx-mock-answer:camerastreamer"),
        "{answer}"
    );
    let r = call(
        &mut ws,
        4,
        "camera.webrtc",
        json!({ "printerId": "cam1", "sdp": "not sdp" }),
    )
    .await;
    assert_eq!(r["error"]["code"], "bad_request");
    let r = call(
        &mut ws,
        5,
        "camera.webrtc",
        json!({ "printerId": "nope", "sdp": offer }),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_found");
}

#[tokio::test]
async fn onvif_cameras_are_discovered_and_stream_through_the_bridge() {
    let mocks = common::Mocks::start("rtsp-camera", &[]).await;
    let cfg = mdns_rig(MdnsConfig {
        onvif_target: Some(([127, 0, 0, 1], mocks.port("onvif-discovery")).into()),
        ..MdnsConfig::default()
    });
    let link = serve(cfg, Arc::new(MemoryGate::new()), Arc::new(MemorySecrets::new()))
        .await
        .unwrap();
    let mut ws = paired(&link).await;
    let r = call(&mut ws, 2, "cameras.discover", json!({ "timeoutMs": 500 })).await;
    let cams = r["result"]["cameras"].as_array().unwrap_or_else(|| panic!("{r}"));
    assert_eq!(cams.len(), 1, "{r}");
    assert_eq!(cams[0]["name"], "Mock Cam");
    let url = cams[0]["cameraUrl"].as_str().unwrap().to_owned();
    assert_eq!(url, format!("onvif://127.0.0.1:{}", mocks.port("onvif-open")));

    // What discovery hands back goes straight into a printer's config.
    let r = call(
        &mut ws,
        3,
        "printers.add",
        json!({ "config": { "id": "porch", "name": "Porch", "plugin": "moonraker", "host": "127.0.0.1", "cameraUrl": url } }),
    )
    .await;
    assert!(r["error"].is_null(), "{r}");
    let r = call(&mut ws, 4, "camera.open", json!({ "printerId": "porch" })).await;
    let stream = u32::try_from(r["result"]["stream"].as_u64().unwrap_or_else(|| panic!("{r}"))).unwrap();
    let (kind, key, id, _, _) = next_frame(&mut ws).await;
    assert_eq!((kind, key, id), (2, true, stream));
}

// ---- the inbox against the real cloud service (memory backend) ----

/// One HTTP/1.0 request over a bare socket, so the harness needs no TLS provider.
async fn http(method: &str, port: u16, path: &str, token: &str, body: &[u8]) -> (u16, Vec<u8>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let head = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    sock.write_all(head.as_bytes()).await.unwrap();
    sock.write_all(body).await.unwrap();
    let mut raw = Vec::new();
    sock.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let status: u16 = String::from_utf8_lossy(&raw[..split])
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, raw[split + 4..].to_vec())
}

fn cube_stl() -> Vec<u8> {
    let s = 20.0_f32;
    let v = [
        [0.0, 0.0, 0.0],
        [s, 0.0, 0.0],
        [s, s, 0.0],
        [0.0, s, 0.0],
        [0.0, 0.0, s],
        [s, 0.0, s],
        [s, s, s],
        [0.0, s, s],
    ];
    let tris = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    let mut out = vec![0_u8; 80];
    out.extend_from_slice(&12_u32.to_le_bytes());
    for t in tris {
        out.extend_from_slice(&[0_u8; 12]);
        for i in t {
            for c in v[i] {
                out.extend_from_slice(&f32::to_le_bytes(c));
            }
        }
        out.extend_from_slice(&[0, 0]);
    }
    out
}

/// Slices a cube in the real `sx-cloud` service, has it delivered to a bridge printer, and prints it
/// on a fake Moonraker after a real approval. Skipped when `target/debug/sx-cloud` is not built
/// (`cargo build -p sx-cloud`).
#[tokio::test]
async fn a_cloud_sliced_job_reaches_a_printer_through_the_real_service() {
    // It talks to a real service over sockets. A hang anywhere, even one that blocks this thread (where a tokio
    // timeout never fires), fails the run instead of holding it, and the machine's heavy lock, for hours: a
    // watchdog thread stops the service and ends the test process.
    use std::sync::atomic::{AtomicBool, Ordering};
    let done = Arc::new(AtomicBool::new(false));
    let watched = done.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(240));
        if !watched.load(Ordering::SeqCst) {
            eprintln!("the real-service test did not finish in 240 s");
            stop_cloud();
            std::process::exit(101);
        }
    });
    cloud_sliced_job_through_the_real_service().await;
    done.store(true, Ordering::SeqCst);
}

/// The sx-cloud process the real-service test started, for its watchdog to stop.
static CLOUD_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn stop_cloud() {
    let pid = CLOUD_PID.load(std::sync::atomic::Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    let pid = pid.to_string();
    let _ = if cfg!(windows) {
        std::process::Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .output()
    } else {
        std::process::Command::new("kill").args(["-9", &pid]).output()
    };
}

async fn cloud_sliced_job_through_the_real_service() {
    const TOKEN: &str = "sxk_test_dev";
    use sx_link::{BrokerGate, InboxConfig, serve_with_approvals};
    let bin = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../../target/debug/sx-cloud{}",
        std::env::consts::EXE_SUFFIX
    ));
    if !bin.exists() {
        // CI builds it before the tests, so there a missing service is a failure, not a skip.
        assert!(
            std::env::var_os("CI").is_none(),
            "{} is not built: CI runs `cargo build -p sx-cloud` before the tests",
            bin.display()
        );
        eprintln!(
            "skipped: {} is not built (cargo build -p sx-cloud)",
            bin.display()
        );
        return;
    }
    // The service reads an edition config; resolve the repository's own with the TS tool.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let resolved = std::process::Command::new("nice")
        .args([
            "-n",
            "19",
            "node",
            "packages/edition-config/src/cli.ts",
            "resolve",
            "editions/slicerx/edition.config.ts",
        ])
        .current_dir(&root)
        .output();
    let Ok(resolved) = resolved.and_then(|o| {
        if o.status.success() {
            Ok(o)
        } else {
            Err(std::io::Error::other("resolve failed"))
        }
    }) else {
        eprintln!("skipped: the edition config could not be resolved");
        return;
    };
    let config_path = std::env::temp_dir().join(format!("sx-link-test-edition-{}.json", std::process::id()));
    std::fs::write(&config_path, &resolved.stdout).unwrap();
    // At low priority where `nice` exists. On Windows it is started directly: through `nice`, dropping the test
    // stopped `nice` and left the service running, holding the test's pipes open.
    let mut command = if cfg!(unix) {
        let mut c = tokio::process::Command::new("nice");
        c.args(["-n", "19"]).arg(&bin);
        c
    } else {
        tokio::process::Command::new(&bin)
    };
    let mut cloud = command
        .env("SLICERX_CONFIG", &config_path)
        .env("SLICERX_FEATURES", "cloudSlicing")
        .env("SLICERX_CLOUD_API_URL", "http://127.0.0.1")
        .env("SX_CLOUD_BACKEND", "memory")
        .env("SX_CLOUD_DEV_TOKEN", TOKEN)
        // The service picks its own port and says which. A port picked here and handed over was
        // free when picked, but other tests bind and connect in parallel, and one took it before
        // the service did (CI at 0d3a6df4: connection refused).
        .env("SX_CLOUD_BIND", "127.0.0.1:0")
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    CLOUD_PID.store(cloud.id().unwrap_or(0), std::sync::atomic::Ordering::SeqCst);
    let port = {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(cloud.stderr.take().unwrap()).lines();
        let mut said = String::new();
        let port = tokio::time::timeout(Duration::from_secs(60), async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(addr) = line.split("listening on http://").nth(1) {
                    return addr.rsplit(':').next().and_then(|p| p.trim().parse::<u16>().ok());
                }
                said.push_str(&line);
                said.push('\n');
            }
            None
        })
        .await;
        let Ok(Some(port)) = port else {
            panic!("sx-cloud did not start listening: {:?}\n{said}", cloud.try_wait());
        };
        // Keep reading what it says, so a full pipe never blocks it.
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        port
    };

    let mocks = common::Mocks::start("moonraker", &[]).await;
    let broker = Arc::new(sx_permit::ApprovalBroker::new().unwrap());
    let cfg = LinkConfig {
        port: 0,
        extra_origins: Vec::new(),
        fixed_code: Some(CODE.to_owned()),
        inbox: Some(InboxConfig {
            url: format!("http://127.0.0.1:{port}"),
            token: TOKEN.to_owned(),
        }),
        pair_limits: PairLimits::default(),
        mdns: MdnsConfig::default(),
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
    let mut ws = paired(&link).await;
    let printer = json!({ "id": "bay-4", "name": "Bay 4", "plugin": "moonraker", "host": "127.0.0.1", "port": mocks.port("moonraker"), "pollMs": 50 });
    let _ = call(&mut ws, 2, "printers.add", json!({ "config": printer })).await;

    // The bridge is the only device the service knows; its id comes from a counter, so try the first
    // few. Sending the same printer list the bridge does changes nothing and returns the service's id
    // for Bay 4.
    let mut bay = None;
    let mut found_device = String::new();
    let mut last = (0, String::new());
    'find: for _ in 0..100 {
        for n in 1..=16 {
            let device = format!("00000000-0000-4000-8000-{n:012x}");
            let (s, body) = http(
                "PUT",
                port,
                &format!("/v1/devices/{device}/printers"),
                TOKEN,
                br#"[{"localId":"bay-4","name":"Bay 4","driver":"moonraker"}]"#,
            )
            .await;
            if s == 200 {
                let v: Value = serde_json::from_slice(&body).unwrap();
                bay = v[0]["id"].as_str().map(str::to_owned);
                found_device = device;
                break 'find;
            }
            last = (s, String::from_utf8_lossy(&body).into_owned());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let bay = bay.unwrap_or_else(|| panic!("the service does not know the bridge's printer: {last:?}"));

    let stl = cube_stl();
    let sha = sha_hex(&stl);
    let (s, _) = http("PUT", port, &format!("/v1/meshes/{sha}"), TOKEN, &stl).await;
    assert!(s == 200 || s == 201, "{s}");
    let job = json!({ "name": "Cube", "targetPrinterId": bay, "request": { "schemaVersion": 1, "plate": { "objects": [{ "id": "cube", "name": "Cube", "mesh": sha }] }, "config": { "layer_height": 0.2 } } });
    let (s, body) = http("POST", port, "/v1/jobs", TOKEN, job.to_string().as_bytes()).await;
    assert!(
        s == 200 || s == 201 || s == 202,
        "{s} {}",
        String::from_utf8_lossy(&body)
    );

    // The service slices, offers the file, and the bridge downloads and checks it.
    let mut ev = Value::Null;
    for _ in 0..600 {
        let Ok(Some(Ok(Message::Text(t)))) =
            tokio::time::timeout(Duration::from_millis(100), ws.next()).await
        else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["event"] == "inbox" && v["data"]["state"] == "awaiting_approval" {
            ev = v["data"].clone();
            break;
        }
    }
    if !ev.is_object() {
        let (_, jobs) = http("GET", port, "/v1/jobs", TOKEN, b"").await;
        let (_, open) = http(
            "GET",
            port,
            &format!("/v1/devices/{found_device}/deliveries?wait=1"),
            TOKEN,
            b"",
        )
        .await;
        let short: String = String::from_utf8_lossy(&jobs).chars().take(400).collect();
        panic!(
            "no delivery reached the bridge; jobs: {short}; open deliveries: {}",
            String::from_utf8_lossy(&open)
        );
    }
    let (id, name, hash) = (
        ev["deliveryId"].as_str().unwrap().to_owned(),
        ev["fileName"].as_str().unwrap().to_owned(),
        ev["sha256"].as_str().unwrap().to_owned(),
    );
    assert!(name.to_ascii_lowercase().ends_with(".gcode"), "{name}");
    assert_eq!(ev["printerId"], "bay-4");

    // Approve exactly this upload and start, as the app's card would.
    let action = |a: &str, p: Value| json!({ "action": a, "target": "bay-4", "paramsHash": sx_permit::hash_params(&p) });
    let request = json!({
        "id": "req-cloud", "sessionId": "s", "tool": "cloud.deliver", "permission": "start", "title": "Print the cloud job on Bay 4?", "lines": [],
        "printerId": "bay-4", "paramsHash": sx_permit::hash_params(&json!({})),
        "actions": [
            action("printer.upload", json!({ "printerId": "bay-4", "name": name, "sha256": hash })),
            action("printer.start", json!({ "printerId": "bay-4", "name": name, "opts": {}, "sha256": hash })),
        ],
        "expiresAt": "2099-01-01T00:00:00.000Z",
    });
    let _ = call(&mut ws, 4, "approvals.register", json!({ "request": request })).await;
    let token = call(
        &mut ws,
        5,
        "approvals.grant",
        json!({ "requestId": "req-cloud", "bedClear": true }),
    )
    .await["result"]
        .clone();
    let up = call(
        &mut ws,
        6,
        "upload",
        json!({ "printerId": "bay-4", "deliveryId": id, "token": token }),
    )
    .await;
    assert_eq!(up["result"]["name"], name.as_str(), "{up}");
    let started = call(
        &mut ws,
        7,
        "start",
        json!({ "file": up["result"], "token": token }),
    )
    .await;
    assert_eq!(started["result"]["ok"], true, "{started}");

    // The printer holds the real sliced G-code the service announced.
    let state = mocks.state().await;
    assert!(
        state["moonraker"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["sha256"] == hash.as_str()),
        "{state}"
    );
    let _ = cloud.kill().await;
}

/// A keychain that refuses every write, as Windows Credential Manager did for a user (error 8).
struct Refusing;
impl sx_connect::Secrets for Refusing {
    fn get(&self, _: &str) -> Option<String> {
        None
    }
}
impl sx_connect::SecretStore for Refusing {
    fn set(&self, _: &str, _: &str) -> sx_connect::Result<()> {
        Err(sx_connect::Error::Config(
            "keychain write failed: Platform failure: Windows error code 8".into(),
        ))
    }
    fn delete(&self, _: &str) -> sx_connect::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn a_keychain_that_refuses_keeps_the_credential_for_the_session() {
    let cfg = LinkConfig {
        port: 0,
        fixed_code: Some(CODE.to_owned()),
        ..LinkConfig::default()
    };
    let link = serve(cfg, Arc::new(MemoryGate::new()), Arc::new(Refusing))
        .await
        .unwrap();
    let mut ws = paired(&link).await;
    let r = call(
        &mut ws,
        1,
        "secrets.set",
        json!({ "name": "printer-p1s", "value": "12345678" }),
    )
    .await;
    assert_eq!(r["result"]["kept"], "session", "{r}");
    let r = call(&mut ws, 2, "secrets.has", json!({ "name": "printer-p1s" })).await;
    assert_eq!(r["result"]["has"], true, "{r}");
    // A connection test's credential never touches the keychain.
    let r = call(
        &mut ws,
        3,
        "secrets.set",
        json!({ "name": "printer-test-1", "value": "12345678" }),
    )
    .await;
    assert_eq!(r["result"]["kept"], "stored", "{r}");
}

#[tokio::test]
async fn a_printer_whose_code_is_gone_asks_for_it_instead_of_failing() {
    // The keychain kept the code only for the last session (it refused to store it): after a restart the
    // printer names a credential the store does not have.
    let link = start(Arc::new(MemoryGate::new())).await;
    let mut ws = paired(&link).await;
    let cfg = json!({ "id": "p1s", "name": "P1S", "plugin": "bambu-lan", "host": "127.0.0.1", "port": 1,
        "serial": "01P00A000000000", "credentialRef": "printer-p1s" });
    let r = call(&mut ws, 1, "printers.add", json!({ "config": cfg })).await;
    assert!(r.get("error").is_none(), "{r}");
    let st = call(&mut ws, 2, "status", json!({ "printerId": "p1s" })).await;
    // A status the printers list can show, not an error that fails the whole list.
    assert_eq!(st["result"]["state"], "offline", "{st}");
    assert_eq!(st["result"]["needsCode"], true, "{st}");
    // The name to store the code under (a name, never a secret).
    assert_eq!(st["result"]["codeRef"], "printer-p1s", "{st}");
    // Once the code is given again, the printer is tried as usual (nothing listens on port 1 here).
    let r = call(
        &mut ws,
        3,
        "secrets.set",
        json!({ "name": "printer-p1s", "value": "12345678" }),
    )
    .await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let st = call(&mut ws, 4, "status", json!({ "printerId": "p1s" })).await;
    assert!(st["result"].get("needsCode").is_none(), "{st}");
}
