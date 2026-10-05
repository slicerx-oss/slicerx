// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-relay over real sockets: forwarding, queues, account routes and quotas.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::many_single_char_names)]

use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sx_relay::auth::{Verifier, sign_hs256};
use sx_relay::quota::{Limits, TierLimits};
use sx_relay::{ManualClock, RelayConfig, RelayHandle, spawn};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const NOW: u64 = 1_790_899_200_000; // 2026-10-02T00:00:00Z
const SECRET: &[u8] = b"relay test secret";
const A: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

async fn start(limits: Limits) -> (RelayHandle, Arc<ManualClock>) {
    let clock = ManualClock::new(NOW);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cfg = RelayConfig {
        limits,
        verifier: Some(Verifier::hs256(SECRET)),
        clock: clock.clone(),
        ..RelayConfig::default()
    };
    (spawn(listener, cfg).unwrap(), clock)
}

async fn dial(r: &RelayHandle) -> Ws {
    connect_async(format!("ws://{}/v1", r.addr)).await.unwrap().0
}

async fn op(ws: &mut Ws, v: Value) {
    ws.send(Message::text(v.to_string())).await.unwrap();
}

async fn next(ws: &mut Ws) -> Option<Value> {
    loop {
        match tokio::time::timeout(Duration::from_millis(400), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
            _ => return None,
        }
    }
}

fn token(account: &str, exp_ms: u64) -> String {
    sign_hs256(
        SECRET,
        &json!({ "sub": account, "aud": "sx-relay", "exp": exp_ms / 1000 }),
    )
}

#[tokio::test]
async fn forwards_between_routes_and_queues_for_late_subscribers() {
    let fast = TierLimits {
        frames_per_second: 1000,
        ..Limits::default().anonymous
    };
    let (r, clock) = start(Limits {
        anonymous: fast,
        ..Limits::default()
    })
    .await;
    let mut a = dial(&r).await;
    let mut b = dial(&r).await;
    op(&mut a, json!({ "op": "sub", "route": A })).await;
    op(&mut b, json!({ "op": "sub", "route": B })).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    op(&mut a, json!({ "op": "send", "to": B, "body": "sealed-1" })).await;
    assert_eq!(
        next(&mut b).await,
        Some(json!({ "op": "msg", "route": B, "body": "sealed-1" }))
    );

    // Queued for a route nobody holds: 64 kept, oldest dropped, 10 minutes at most.
    let c = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    for i in 0..70 {
        op(&mut a, json!({ "op": "send", "to": c, "body": format!("q{i}") })).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let mut late = dial(&r).await;
    op(&mut late, json!({ "op": "sub", "route": c })).await;
    let first = next(&mut late).await.unwrap();
    assert_eq!(first["body"], "q6");
    let mut n = 1;
    while next(&mut late).await.is_some() {
        n += 1;
    }
    assert_eq!(n, 64);
    assert_eq!(r.stats().queued_bytes, 0);

    let d = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    op(&mut a, json!({ "op": "send", "to": d, "body": "stale" })).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    clock.advance(10 * 60 * 1000);
    r.sweep();
    assert_eq!(r.stats().queued_bytes, 0);
    let mut later = dial(&r).await;
    op(&mut later, json!({ "op": "sub", "route": d })).await;
    assert_eq!(next(&mut later).await, None);
}

#[tokio::test]
async fn refuses_bad_routes_large_bodies_and_other_accounts() {
    let (r, _clock) = start(Limits::default()).await;
    let mut a = dial(&r).await;
    op(&mut a, json!({ "op": "sub", "route": "short" })).await;
    assert_eq!(next(&mut a).await.unwrap()["code"], "forbidden");
    op(
        &mut a,
        json!({ "op": "send", "to": A, "body": "x".repeat(1_500_001) }),
    )
    .await;
    assert_eq!(next(&mut a).await.unwrap()["code"], "too_large");
    op(&mut a, json!({ "op": "sub", "route": "acct:user-1:join" })).await;
    assert_eq!(next(&mut a).await.unwrap()["code"], "forbidden");

    op(
        &mut a,
        json!({ "op": "auth", "token": token("user-1", NOW - 60_000) }),
    )
    .await;
    assert_eq!(next(&mut a).await.unwrap()["code"], "forbidden");
    op(&mut a, json!({ "op": "auth", "token": sign_hs256(b"wrong", &json!({ "sub": "user-1", "aud": "sx-relay", "exp": NOW / 1000 + 600 })) })).await;
    assert_eq!(next(&mut a).await.unwrap()["code"], "forbidden");

    op(
        &mut a,
        json!({ "op": "auth", "token": token("user-1", NOW + 600_000) }),
    )
    .await;
    assert_eq!(next(&mut a).await.unwrap()["ok"], true);
    op(&mut a, json!({ "op": "sub", "route": "acct:user-1:join" })).await;
    op(&mut a, json!({ "op": "sub", "route": "acct:user-2:join" })).await;
    assert_eq!(next(&mut a).await.unwrap()["code"], "forbidden");
    op(
        &mut a,
        json!({ "op": "auth", "token": token("user-2", NOW + 600_000) }),
    )
    .await;
    assert_eq!(next(&mut a).await.unwrap()["code"], "forbidden");

    let mut b = dial(&r).await;
    op(
        &mut b,
        json!({ "op": "auth", "token": token("user-1", NOW + 600_000) }),
    )
    .await;
    assert_eq!(next(&mut b).await.unwrap()["ok"], true);
    op(
        &mut b,
        json!({ "op": "send", "to": "acct:user-1:join", "body": "join" }),
    )
    .await;
    assert_eq!(next(&mut a).await.unwrap()["body"], "join");
    let q = {
        op(&mut b, json!({ "op": "quota" })).await;
        next(&mut b).await.unwrap()
    };
    assert_eq!(q["tier"], "account");
    assert_eq!(q["cap"], 5_000_000_000_u64);
    assert_eq!(q["resetsAt"], 1_793_491_200_000_u64);
}

#[tokio::test]
async fn quotas_limit_rate_month_and_connections() {
    let tight = TierLimits {
        live_connections: 2,
        frames_per_second: 4,
        bytes_per_minute: 1_000_000,
        bytes_per_month: 3_000,
    };
    let limits = Limits {
        anonymous: tight,
        account: TierLimits {
            live_connections: 1,
            ..tight
        },
        ..Limits::default()
    };
    let (r, clock) = start(limits).await;
    let mut a = dial(&r).await;
    let mut b = dial(&r).await;
    // A third connection from the same address is turned away.
    let mut c = dial(&r).await;
    assert_eq!(next(&mut c).await.unwrap()["scope"], "connections");

    op(&mut b, json!({ "op": "sub", "route": B })).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    for _ in 0..4 {
        op(&mut a, json!({ "op": "send", "to": B, "body": "x".repeat(100) })).await;
    }
    let refused = next(&mut a).await.unwrap();
    assert_eq!(
        (refused["code"].as_str(), refused["scope"].as_str()),
        (Some("rate_limited"), Some("second"))
    );
    // Both connections share the address meter (the `sub` cost a frame too): 3 sent and 3
    // received is 600 bytes.
    clock.advance(1000);
    op(&mut a, json!({ "op": "quota" })).await;
    assert_eq!(next(&mut a).await.unwrap()["used"], 600);

    clock.advance(1000);
    op(
        &mut a,
        json!({ "op": "send", "to": B, "body": "x".repeat(2_500) }),
    )
    .await;
    let r2 = next(&mut a).await.unwrap();
    assert_eq!(r2["scope"], "month");

    // Signing in moves the connection to the account's own meter.
    op(
        &mut a,
        json!({ "op": "auth", "token": token("user-9", NOW + 600_000) }),
    )
    .await;
    assert_eq!(next(&mut a).await.unwrap()["ok"], true);
    op(
        &mut a,
        json!({ "op": "send", "to": A, "body": "x".repeat(2_500) }),
    )
    .await;
    op(&mut a, json!({ "op": "quota" })).await;
    let q = next(&mut a).await.unwrap();
    assert_eq!(
        (q["tier"].as_str(), q["used"].as_u64()),
        (Some("account"), Some(2_500))
    );
    // The account allows one connection; a second one signing in is refused and stays anonymous.
    let mut d = dial(&r).await;
    op(
        &mut d,
        json!({ "op": "auth", "token": token("user-9", NOW + 600_000) }),
    )
    .await;
    assert_eq!(next(&mut d).await.unwrap()["scope"], "connections");
}

#[tokio::test]
async fn limits_new_connections_per_address() {
    let limits = Limits {
        new_connections_per_minute: 3,
        ..Limits::default()
    };
    let (r, clock) = start(limits).await;
    let url = format!("ws://{}/v1", r.addr);
    for _ in 0..3 {
        assert!(connect_async(&url).await.is_ok());
    }
    assert!(connect_async(&url).await.is_err());
    clock.advance(20_000);
    assert!(connect_async(&url).await.is_ok());
    assert!(connect_async(format!("ws://{}/other", r.addr)).await.is_err());
}

/// True once the relay has closed the connection.
async fn closed(ws: &mut Ws) -> bool {
    loop {
        match tokio::time::timeout(Duration::from_millis(800), ws.next()).await {
            Ok(Some(Ok(Message::Close(_)) | Err(_)) | None) => return true,
            Ok(Some(Ok(_))) => {}
            Err(_) => return false,
        }
    }
}

#[tokio::test]
async fn m3_every_frame_costs_a_frame_and_a_run_of_refusals_closes_the_connection() {
    let tight = TierLimits {
        frames_per_second: 3,
        ..Limits::default().anonymous
    };
    let (r, clock) = start(Limits {
        anonymous: tight,
        refusals_before_close: 5,
        ..Limits::default()
    })
    .await;
    let mut a = dial(&r).await;
    // Fields the relay does not use are skipped, however large.
    let big = format!(r#"{{"op":"quota","x":[{}0]}}"#, "0,".repeat(100_000));
    a.send(Message::text(big)).await.unwrap();
    assert_eq!(next(&mut a).await.unwrap()["op"], "quota");
    // `quota` and `sub` cost frames like `send` does.
    op(&mut a, json!({ "op": "quota" })).await;
    op(&mut a, json!({ "op": "sub", "route": A })).await;
    assert_eq!(next(&mut a).await.unwrap()["op"], "quota");
    op(&mut a, json!({ "op": "quota" })).await;
    assert_eq!(next(&mut a).await.unwrap()["scope"], "second");
    clock.advance(1000);
    // Junk, refused auth and refused frames in a row: the connection is closed.
    for _ in 0..3 {
        a.send(Message::text("[1,2,3]")).await.unwrap();
    }
    op(&mut a, json!({ "op": "auth", "token": "x.y.z" })).await;
    op(&mut a, json!({ "op": "auth", "token": "x.y.z" })).await;
    assert!(closed(&mut a).await, "closed after a run of refusals");
    assert!(r.stats().refused >= 5);
}

#[tokio::test]
async fn m2_a_route_has_few_subscribers_and_the_sender_pays_for_every_copy() {
    let tier = TierLimits {
        frames_per_second: 1000,
        bytes_per_minute: 1000,
        ..Limits::default().anonymous
    };
    let (r, _clock) = start(Limits {
        anonymous: tier,
        subscribers_per_route: 2,
        ..Limits::default()
    })
    .await;
    let mut a = dial(&r).await;
    let mut b = dial(&r).await;
    let mut c = dial(&r).await;
    for ws in [&mut a, &mut b] {
        op(ws, json!({ "op": "sub", "route": A })).await;
    }
    op(&mut c, json!({ "op": "sub", "route": A })).await;
    let refused = next(&mut c).await.unwrap();
    assert_eq!(
        (refused["code"].as_str(), refused["message"].as_str()),
        (Some("rate_limited"), Some("too many subscribers on this route"))
    );
    // Two copies of 400 bytes cost 800 of the sender's 1000 a minute; the next send does not fit.
    let mut d = dial(&r).await;
    op(&mut d, json!({ "op": "send", "to": A, "body": "x".repeat(400) })).await;
    assert_eq!(next(&mut a).await.unwrap()["op"], "msg");
    assert_eq!(next(&mut b).await.unwrap()["op"], "msg");
    op(&mut d, json!({ "op": "send", "to": A, "body": "x".repeat(400) })).await;
    assert_eq!(next(&mut d).await.unwrap()["scope"], "minute");
}

#[tokio::test]
async fn m2_each_sender_fills_only_its_own_share_of_the_queue() {
    let fast = TierLimits {
        frames_per_second: 1000,
        ..Limits::default().anonymous
    };
    let (r, _clock) = start(Limits {
        anonymous: fast,
        queue_bytes_per_meter: 1000,
        ..Limits::default()
    })
    .await;
    let mut anon = dial(&r).await;
    for i in 0..3 {
        op(
            &mut anon,
            json!({ "op": "send", "to": format!("{}{i}", &A[..42]), "body": "x".repeat(400) }),
        )
        .await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        r.stats().queued_bytes,
        800,
        "the third body is past this sender's share"
    );
    // Another sender (here an account) still gets its frames queued.
    let mut acct = dial(&r).await;
    op(
        &mut acct,
        json!({ "op": "auth", "token": token("user-3", NOW + 600_000) }),
    )
    .await;
    assert_eq!(next(&mut acct).await.unwrap()["ok"], true);
    op(
        &mut acct,
        json!({ "op": "send", "to": B, "body": "y".repeat(400) }),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(r.stats().queued_bytes, 1200);
    let mut late = dial(&r).await;
    op(&mut late, json!({ "op": "sub", "route": B })).await;
    assert_eq!(next(&mut late).await.unwrap()["body"], "y".repeat(400));
    assert_eq!(r.stats().queued_bytes, 800);
}

#[tokio::test]
async fn m4_only_relay_tokens_sign_in_and_the_account_tier_ends_with_the_token() {
    let (r, clock) = start(Limits::default()).await;
    let mut a = dial(&r).await;
    // The account's own session (audience `authenticated`) is not a relay token.
    let session = sign_hs256(
        SECRET,
        &json!({ "sub": "user-1", "aud": "authenticated", "exp": NOW / 1000 + 600 }),
    );
    op(&mut a, json!({ "op": "auth", "token": session })).await;
    assert_eq!(next(&mut a).await.unwrap()["code"], "forbidden");
    let guest = sign_hs256(
        SECRET,
        &json!({ "sub": "user-1", "aud": "sx-relay", "exp": NOW / 1000 + 600, "is_anonymous": true }),
    );
    op(&mut a, json!({ "op": "auth", "token": guest })).await;
    assert_eq!(next(&mut a).await.unwrap()["code"], "forbidden");

    op(
        &mut a,
        json!({ "op": "auth", "token": token("user-1", NOW + 60_000) }),
    )
    .await;
    assert_eq!(next(&mut a).await.unwrap()["ok"], true);
    op(&mut a, json!({ "op": "sub", "route": "acct:user-1:join" })).await;
    op(&mut a, json!({ "op": "quota" })).await;
    assert_eq!(next(&mut a).await.unwrap()["tier"], "account");
    // Past the token's expiry the connection is anonymous again and leaves the account's routes.
    clock.advance(120_000);
    op(&mut a, json!({ "op": "quota" })).await;
    assert_eq!(next(&mut a).await.unwrap()["code"], "expired");
    assert_eq!(next(&mut a).await.unwrap()["tier"], "anonymous");
    let mut b = dial(&r).await;
    op(
        &mut b,
        json!({ "op": "auth", "token": token("user-1", NOW + 600_000) }),
    )
    .await;
    assert_eq!(next(&mut b).await.unwrap()["ok"], true);
    op(
        &mut b,
        json!({ "op": "send", "to": "acct:user-1:join", "body": "join" }),
    )
    .await;
    assert_eq!(
        next(&mut a).await,
        None,
        "an expired connection hears nothing on the account route"
    );
}
