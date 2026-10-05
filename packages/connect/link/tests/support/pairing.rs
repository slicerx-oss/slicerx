// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Pairing the way every first-party client does it: `hello`, then the code exchange (`CPace`,
//! sx-cpace) bound to that hello. The hub refuses a code sent in clear and a version 1 proof.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const HELLO_ID: u64 = 900_000;
const PAKE_ID: u64 = 900_001;

async fn answer(ws: &mut Ws, id: u64) -> Value {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("an answer in time")
            .expect("open")
            .expect("frame");
        let Message::Text(t) = m else { continue };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["id"] == id {
            return v;
        }
    }
}

/// Says `hello` on `ws`, runs the first step of the code exchange for `code`, and returns the
/// `pair` params that confirm it, with `extra` merged in (`role`, `remember`, `name`). The hello's
/// signature and the hub's confirm are not checked here; tests of the exchange itself do that.
pub async fn proof_params(ws: &mut Ws, code: &str, extra: Value) -> Value {
    let b64 = base64::engine::general_purpose::STANDARD;
    let nonce = [7_u8; 32];
    ws.send(Message::text(
        json!({ "id": HELLO_ID, "method": "hello", "params": { "nonce": b64.encode(nonce) } }).to_string(),
    ))
    .await
    .unwrap();
    let hello = answer(ws, HELLO_ID).await["result"].clone();
    let hub_nonce = b64.decode(hello["hubNonce"].as_str().unwrap()).unwrap();
    let hub_key = b64.decode(hello["hubKey"].as_str().unwrap()).unwrap();
    let port = u16::try_from(hello["port"].as_u64().unwrap()).unwrap();
    let ctx = sx_cpace::pair::Context {
        hub_key: &hub_key,
        port,
        client_nonce: &nonce,
        hub_nonce: &hub_nonce,
    };
    let mut start = sx_cpace::pair::Start::new(code, &ctx, [3_u8; 32]);
    ws.send(Message::text(
        json!({ "id": PAKE_ID, "method": "pair", "params": { "pake": b64.encode(start.ya) } }).to_string(),
    ))
    .await
    .unwrap();
    let r = answer(ws, PAKE_ID).await;
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
    let mut out = json!({ "confirm": tags });
    if let (Some(o), Some(e)) = (out.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            o.insert(k.clone(), v.clone());
        }
    }
    out
}
