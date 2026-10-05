// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-watch against a scripted hub that signs its hello with a real Ed25519 key, checks the
//! pairing proof, serves a bed mask and frames, and records the reports. The hub closes the
//! socket after a quiet second and every test runs under a deadline, so a client that stops
//! talking fails the test instead of hanging it.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sx_watch::client::{ClientError, Options, UNCONFIRMED_CAP, collect, run, run_with};
use sx_watch::confirm::{Answer, Confirm, Confirmation};
use sx_watch::decode::Rgb;
use sx_watch::detector::{Detection, Detector};
use sx_watch::policy::Config;
use sx_watch::protocol::Kind;
use sx_watch::session::Session;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

const CODE: &str = "WTCH-2468";
/// How long the scripted hub waits for the next message before it hangs up.
const HUB_QUIET: Duration = Duration::from_secs(1);
/// No test here needs more than a few seconds.
const DEADLINE: Duration = Duration::from_secs(20);

async fn within<F: std::future::Future>(f: F) -> F::Output {
    tokio::time::timeout(DEADLINE, f)
        .await
        .expect("the test passed its deadline")
}

/// Answers every confirmation the same way.
struct Says(bool);
impl Confirm for Says {
    fn name(&self) -> &'static str {
        "test"
    }
    fn confirm<'a>(&'a self, _: &'a str, bytes: &'a [u8]) -> Answer<'a> {
        let yes = self.0 && !bytes.is_empty();
        Box::pin(async move { Ok(yes) })
    }
}

/// Sees spaghetti in the middle of every frame.
struct Always;
impl Detector for Always {
    fn name(&self) -> &'static str {
        "always"
    }
    fn detect(&self, _: &Rgb) -> Vec<Detection> {
        vec![Detection {
            kind: Kind::Spaghetti,
            score: 0.95,
            bbox: [0.4, 0.6, 0.6, 0.8],
        }]
    }
}

fn png_b64() -> String {
    let (w, h) = (64u32, 48u32);
    let mut raw = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let v = if (x / 8 + y / 8) % 2 == 0 { 60 } else { 200 };
            raw.extend_from_slice(&[v, v, v]);
        }
    }
    let mut out = Vec::new();
    {
        let mut e = png::Encoder::new(&mut out, w, h);
        e.set_color(png::ColorType::Rgb);
        e.set_depth(png::BitDepth::Eight);
        e.write_header().unwrap().write_image_data(&raw).unwrap();
    }
    B64.encode(out)
}

#[derive(Default)]
struct Seen {
    methods: Vec<String>,
    reports: Vec<Value>,
    pair_params: Option<Value>,
}

/// A hub on a free port. Returns its URL and public key.
#[allow(clippy::too_many_lines)] // one scripted hub, kept in one place
async fn hub(seen: Arc<Mutex<Seen>>, mask: Value) -> (String, String) {
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
    let pair = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
    let public = ring::signature::KeyPair::public_key(&pair).as_ref().to_vec();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let pub_b64 = B64.encode(&public);
    tokio::spawn(async move {
        let (tcp, _) = l.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let hub_nonce = [7u8; 32];
        let mut client_nonce = Vec::new();
        let mut pake: Option<sx_cpace::pair::Answer> = None;
        while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(HUB_QUIET, ws.next()).await {
            let msg: Value = serde_json::from_str(&t).unwrap();
            let (id, method) = (
                msg["id"].clone(),
                msg["method"].as_str().unwrap_or_default().to_owned(),
            );
            seen.lock().unwrap().methods.push(method.clone());
            let reply = match method.as_str() {
                "hello" => {
                    client_nonce = B64.decode(msg["params"]["nonce"].as_str().unwrap()).unwrap();
                    let signed = [
                        b"sx-link hello v2\n".as_slice(),
                        &client_nonce,
                        &hub_nonce,
                        &port.to_be_bytes(),
                    ]
                    .concat();
                    json!({ "hubKey": B64.encode(&public), "hubNonce": B64.encode(hub_nonce), "port": port, "sig": B64.encode(pair.sign(&signed).as_ref()) })
                }
                "pair" if msg["params"]["pake"].is_string() => {
                    let ya = B64.decode(msg["params"]["pake"].as_str().unwrap()).unwrap();
                    let ctx = sx_cpace::pair::Context {
                        hub_key: &public,
                        port,
                        client_nonce: &client_nonce,
                        hub_nonce: &hub_nonce,
                    };
                    let mut n = 0u8;
                    let codes = [("app", "APPS-CODE"), ("agent", "AGNT-CODE"), ("watch", CODE)];
                    let a = sx_cpace::pair::Answer::new(&codes, &ctx, &ya, || {
                        n += 1;
                        [n; 32]
                    })
                    .unwrap();
                    let msgs: serde_json::Map<String, Value> = a
                        .messages
                        .iter()
                        .map(|(r, m)| ((*r).to_owned(), json!(B64.encode(m))))
                        .collect();
                    pake = Some(a);
                    json!({ "pake": msgs })
                }
                "pair" => {
                    seen.lock().unwrap().pair_params = Some(msg["params"].clone());
                    let tags: Vec<(&str, Vec<u8>)> = msg["params"]["confirm"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(k, v)| (k.as_str(), B64.decode(v.as_str().unwrap()).unwrap()))
                        .collect();
                    let (role, confirm) = pake.take().unwrap().check(&tags).expect("the watch code");
                    assert_eq!(role, "watch");
                    json!({ "paired": true, "role": "watch", "confirm": B64.encode(confirm) })
                }
                "watch.masks" => mask.clone(),
                "watch.subscribe" => {
                    ws.send(Message::text(
                        json!({ "id": id, "result": { "subscription": 1 } }).to_string(),
                    ))
                    .await
                    .unwrap();
                    for i in 0..8u64 {
                        let frame = json!({ "event": "watch.frame", "data": {
                            "subscription": 1, "printerId": "bay-1", "contentType": "image/png", "dataBase64": png_b64(),
                            "capturedAt": format!("2026-10-01T20:00:{:02}.000Z", i * 7), "source": "snapshot",
                            "state": "printing", "layer": 20, "layerCount": 200 } });
                        ws.send(Message::text(frame.to_string())).await.unwrap();
                    }
                    continue;
                }
                "watch.report" => {
                    seen.lock().unwrap().reports.push(msg["params"].clone());
                    ws.send(Message::text(
                        json!({ "id": id, "result": { "recorded": true, "paused": false } }).to_string(),
                    ))
                    .await
                    .unwrap();
                    let _ = ws.close(None).await;
                    return;
                }
                _ => json!({}),
            };
            ws.send(Message::text(json!({ "id": id, "result": reply }).to_string()))
                .await
                .unwrap();
        }
        let _ = ws.close(None).await;
    });
    (format!("ws://127.0.0.1:{port}"), pub_b64)
}

#[tokio::test]
async fn pairs_as_watch_and_reports_after_agreement() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let mask = json!({ "bay-1": [[0.0, 0.5], [1.0, 0.5], [1.0, 1.0], [0.0, 1.0]] });
    let (url, key) = hub(seen.clone(), mask).await;
    let mut session = Session::new(
        Always,
        Config {
            gap_ms: 35_000,
            quiet_after_resume_ms: 14_000,
            ..Config::default()
        },
    );
    let end = within(run(
        &Options {
            url,
            code: CODE.into(),
            hub_key: Some(key),
        },
        &mut session,
    ))
    .await;
    assert!(matches!(end, Err(ClientError::Connection(_))));
    let s = seen.lock().unwrap();
    assert_eq!(&s.methods[..4], ["hello", "pair", "pair", "watch.masks"]);
    // The code never went on the wire; only the code exchange did.
    assert!(!s.pair_params.as_ref().unwrap().to_string().contains("WTCH"));
    assert_eq!(s.pair_params.as_ref().unwrap()["role"], "watch");
    assert_eq!(s.reports.len(), 1);
    assert_eq!(s.reports[0]["kind"], "spaghetti");
    assert_eq!(s.reports[0]["printerId"], "bay-1");
}

#[tokio::test]
async fn sends_nothing_to_a_hub_with_another_key() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let (url, _) = hub(seen.clone(), json!({})).await;
    let pinned = B64.encode([9u8; 32]);
    let mut session = Session::new(Always, Config::default());
    let end = within(run(
        &Options {
            url,
            code: CODE.into(),
            hub_key: Some(pinned),
        },
        &mut session,
    ))
    .await;
    assert!(matches!(end, Err(ClientError::HubIdentity(_))));
    assert_eq!(seen.lock().unwrap().methods, ["hello"]);
}

#[tokio::test]
async fn collects_frames_locally_and_reports_nothing() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let (url, key) = hub(seen.clone(), json!({})).await;
    let dir = std::env::temp_dir().join(format!("sx-watch-collect-{}", std::process::id()));
    let end = within(collect(
        &Options {
            url,
            code: CODE.into(),
            hub_key: Some(key),
        },
        &dir,
        60_000,
    ))
    .await;
    assert!(matches!(end, Err(ClientError::Connection(_))));
    let log = std::fs::read_to_string(dir.join("frames.jsonl")).unwrap();
    assert_eq!(log.lines().count(), 8);
    assert_eq!(dir.join("bay-1").read_dir().unwrap().count(), 8);
    assert!(seen.lock().unwrap().reports.is_empty());
    assert!(!seen.lock().unwrap().methods.contains(&"watch.report".to_owned()));
    std::fs::remove_dir_all(&dir).unwrap();
}

async fn one_report(confirm: Option<&Confirmation>) -> Value {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let (url, key) = hub(seen.clone(), json!({})).await;
    let mut session = Session::new(
        Always,
        Config {
            gap_ms: 35_000,
            quiet_after_resume_ms: 14_000,
            ..Config::default()
        },
    );
    let opts = Options {
        url,
        code: CODE.into(),
        hub_key: Some(key),
    };
    let _ = within(run_with(&opts, &mut session, confirm)).await;
    let s = seen.lock().unwrap();
    assert_eq!(s.reports.len(), 1);
    s.reports[0].clone()
}

#[tokio::test]
async fn only_a_confirmed_report_can_reach_the_pause_level() {
    let unconfirmed = one_report(None).await;
    assert!(unconfirmed.get("confirmed").is_none());
    assert!(unconfirmed["confidence"].as_f64().unwrap() <= UNCONFIRMED_CAP);

    let other = Confirmation {
        printers: ["bay-2".to_owned()].into(),
        by: Box::new(Says(true)),
    };
    assert!(one_report(Some(&other)).await.get("confirmed").is_none());

    let yes = Confirmation {
        printers: ["bay-1".to_owned()].into(),
        by: Box::new(Says(true)),
    };
    let r = one_report(Some(&yes)).await;
    assert_eq!(r["confirmed"], true);
    assert!((r["confidence"].as_f64().unwrap() - 0.95).abs() < 1e-9);
    assert!(r["note"].as_str().unwrap().ends_with("test agreed"));

    let no = Confirmation {
        printers: ["bay-1".to_owned()].into(),
        by: Box::new(Says(false)),
    };
    let r = one_report(Some(&no)).await;
    assert_eq!(r["confirmed"], false);
    assert!(r["confidence"].as_f64().unwrap() <= UNCONFIRMED_CAP);
}
