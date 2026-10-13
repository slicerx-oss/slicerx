// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! mimir cloud against a mock proxy on 127.0.0.1. No real keychain or network.
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::chatgpt::SecretStore;
use super::cloud::{self, MimirCloud};
use super::*;

#[derive(Default)]
struct MemStore(Mutex<HashMap<(String, String), String>>);

impl KeySource for MemStore {
    fn keychain(&self, service: &str, account: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .get(&(service.into(), account.into()))
            .cloned()
    }
    fn env(&self, _: &str) -> Option<String> {
        None
    }
}

impl SecretStore for MemStore {
    fn set(&self, service: &str, account: &str, value: &str) -> crate::Result<()> {
        self.0
            .lock()
            .unwrap()
            .insert((service.into(), account.into()), value.into());
        Ok(())
    }
    fn delete(&self, service: &str, account: &str) -> crate::Result<()> {
        self.0.lock().unwrap().remove(&(service.into(), account.into()));
        Ok(())
    }
}

impl MemStore {
    fn token(&self) -> Option<String> {
        self.keychain(MIMIR_CLOUD_KEYCHAIN_SERVICE, MIMIR_CLOUD_KEYCHAIN_ACCOUNT)
    }
}

/// What the proxy saw and how it answers.
#[derive(Default)]
struct Proxy {
    /// Tokens the proxy knows.
    known: Vec<String>,
    issued: usize,
    /// Answer model calls with this cap.
    cap: Option<&'static str>,
    /// Issue tokens without remembering them.
    forgets: bool,
    /// Every request: first line, x-sx-install, the other x-sx headers, authorization, body.
    seen: Vec<Seen>,
}

#[derive(Debug, Clone, Default)]
struct Seen {
    first: String,
    install: Option<String>,
    headers: BTreeMap<String, String>,
    body: String,
}

const SSE: &str = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n";

fn fail(status: u16, kind: &str, message: &str, reason: &str) -> (u16, String) {
    (
        status,
        serde_json::json!({ "type": "error", "error": { "type": kind, "message": message, "reason": reason } })
            .to_string(),
    )
}

fn route(p: &mut Proxy, seen: &Seen) -> (u16, String) {
    let first = seen.first.as_str();
    let known = seen.install.as_ref().is_some_and(|t| p.known.contains(t));
    if first.starts_with("POST /functions/v1/mimir/register ") {
        let v: serde_json::Value = serde_json::from_str(&seen.body).unwrap_or_default();
        if v["edition"] != "slicerx" {
            return fail(400, "invalid_request_error", "Unknown edition.", "");
        }
        p.issued += 1;
        let token = format!("{:064x}", p.issued);
        if !p.forgets {
            p.known.push(token.clone());
        }
        return (
            200,
            serde_json::json!({ "install": "i", "token": token }).to_string(),
        );
    }
    if !known {
        return fail(
            401,
            "authentication_error",
            "This install is not registered with mimir.",
            "unknown_install",
        );
    }
    if first.starts_with("POST /functions/v1/mimir/v1/messages ") {
        if let Some(reason) = p.cap {
            return fail(
                429,
                "mimir_limit",
                "Today's free mimir use on this computer is used up. It resets at midnight Melbourne time.",
                reason,
            );
        }
        return (200, SSE.to_owned());
    }
    if first.starts_with("GET /functions/v1/mimir/quota ") {
        return (
            200,
            r#"{"edition":"slicerx","day":"2026-10-12","install_used":1200,"install_cap":500000,"ip_used":1200,"ip_cap":2000000,"edition_open":true}"#.to_owned(),
        );
    }
    if first.starts_with("POST /functions/v1/mimir/forget ") {
        return (200, r#"{"deleted":3}"#.to_owned());
    }
    fail(404, "not_found_error", "No such mimir route.", "")
}

async fn serve(proxy: Arc<Mutex<Proxy>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let proxy = proxy.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).into_owned();
                        let len = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        while buf.len() < i + 4 + len {
                            let n = sock.read(&mut chunk).await.unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        break (head, String::from_utf8_lossy(&buf[i + 4..]).into_owned());
                    }
                };
                let mut seen = Seen {
                    first: head.lines().next().unwrap_or_default().to_owned(),
                    body,
                    ..Seen::default()
                };
                for line in head.lines().skip(1) {
                    let Some((k, v)) = line.split_once(':') else {
                        continue;
                    };
                    let k = k.trim().to_ascii_lowercase();
                    if k == "x-sx-install" {
                        seen.install = Some(v.trim().to_owned());
                    } else if k.starts_with("x-") || k == "authorization" {
                        seen.headers.insert(k, v.trim().to_owned());
                    }
                }
                let (status, reply) = {
                    let mut p = proxy.lock().unwrap();
                    let out = route(&mut p, &seen);
                    p.seen.push(seen);
                    out
                };
                let msg = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = sock.write_all(msg.as_bytes()).await;
            });
        }
    });
    base
}

async fn setup() -> (Arc<Mutex<Proxy>>, MimirCloud) {
    let proxy = Arc::new(Mutex::new(Proxy::default()));
    let base = serve(proxy.clone()).await;
    (proxy, MimirCloud::new(&base, "slicerx").unwrap())
}

fn messages(cloud: &MimirCloud) -> LlmHttpRequest {
    LlmHttpRequest {
        provider: "mimir-cloud".into(),
        url: cloud.messages_url(),
        method: HttpMethod::Post,
        headers: BTreeMap::from([
            ("content-type".into(), "application/json".into()),
            ("x-sx-share".into(), "1".into()),
            ("x-sx-session".into(), "ses_1".into()),
        ]),
        body: r#"{"model":"claude-haiku-5-5","stream":true}"#.into(),
    }
}

async fn body_of(store: &MemStore, cloud: &MimirCloud, req: LlmHttpRequest) -> crate::Result<String> {
    let mut s = Box::pin(stream_mimir_cloud(store, cloud, req).await?);
    let mut out = Vec::new();
    while let Some(c) = s.next().await {
        out.extend_from_slice(&c?);
    }
    Ok(String::from_utf8(out).unwrap())
}

#[tokio::test]
async fn registers_on_first_use_and_sends_the_token_as_its_own_header() {
    let (proxy, cloud) = setup().await;
    let store = MemStore::default();
    assert_eq!(body_of(&store, &cloud, messages(&cloud)).await.unwrap(), SSE);
    let token = store.token().unwrap();
    assert_eq!(token.len(), 64);
    {
        let p = proxy.lock().unwrap();
        assert_eq!(p.seen.len(), 2);
        assert!(p.seen[0].first.starts_with("POST /functions/v1/mimir/register "));
        assert_eq!(p.seen[0].install, None);
        let call = &p.seen[1];
        assert!(call.first.starts_with("POST /functions/v1/mimir/v1/messages "));
        assert_eq!(call.install.as_deref(), Some(token.as_str()));
        // never a key or an authorization header, and the share headers pass through
        assert!(!call.headers.contains_key("authorization"));
        assert!(!call.headers.contains_key("x-api-key"));
        assert_eq!(call.headers["x-sx-share"], "1");
        assert_eq!(call.headers["x-sx-session"], "ses_1");
    }
    // the second call reuses the token
    body_of(&store, &cloud, messages(&cloud)).await.unwrap();
    assert_eq!(proxy.lock().unwrap().issued, 1);
}

#[tokio::test]
async fn a_forgotten_install_registers_again_and_retries_once() {
    let (proxy, cloud) = setup().await;
    let store = MemStore::default();
    let stale = format!("{:064x}", 999);
    store
        .set(MIMIR_CLOUD_KEYCHAIN_SERVICE, MIMIR_CLOUD_KEYCHAIN_ACCOUNT, &stale)
        .unwrap();
    assert_eq!(body_of(&store, &cloud, messages(&cloud)).await.unwrap(), SSE);
    let p = proxy.lock().unwrap();
    let firsts: Vec<&str> = p
        .seen
        .iter()
        .map(|s| s.first.split(' ').take(2).last().unwrap())
        .collect();
    assert_eq!(
        firsts,
        [
            "/functions/v1/mimir/v1/messages",
            "/functions/v1/mimir/register",
            "/functions/v1/mimir/v1/messages"
        ]
    );
    assert_ne!(store.token().unwrap(), stale);
}

#[tokio::test]
async fn retries_only_once_when_the_new_install_is_refused_too() {
    let (proxy, cloud) = setup().await;
    let store = MemStore::default();
    proxy.lock().unwrap().forgets = true;
    let Err(e) = body_of(&store, &cloud, messages(&cloud)).await else {
        panic!("expected a refusal")
    };
    assert!(matches!(e, Error::Http { status: 401, .. }), "{e:?}");
    let p = proxy.lock().unwrap();
    let count = |path: &str| p.seen.iter().filter(|s| s.first.contains(path)).count();
    // first use registers, the refusal registers once more, and that is all
    assert_eq!(count("/register "), 2);
    assert_eq!(count("/v1/messages "), 2);
}

#[tokio::test]
async fn a_cap_comes_back_with_the_proxy_message_and_no_retry() {
    let (proxy, cloud) = setup().await;
    let store = MemStore::default();
    proxy.lock().unwrap().cap = Some("install_daily");
    let Err(e) = body_of(&store, &cloud, messages(&cloud)).await else {
        panic!("expected the cap")
    };
    assert_eq!(
        e,
        Error::Http {
            status: 429,
            message:
                "Today's free mimir use on this computer is used up. It resets at midnight Melbourne time."
                    .into()
        }
    );
    let calls = proxy
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|s| s.first.contains("/v1/messages "))
        .count();
    assert_eq!(calls, 1);
}

#[tokio::test]
async fn the_route_and_headers_are_checked_before_any_token_is_read() {
    let (proxy, cloud) = setup().await;
    let store = MemStore::default();
    let mut other = messages(&cloud);
    other.url = other.url.replace("/v1/messages", "/register");
    assert!(matches!(
        stream_mimir_cloud(&store, &cloud, other).await.err(),
        Some(Error::UrlNotAllowed { .. })
    ));
    let mut own = messages(&cloud);
    own.headers.insert("x-sx-install".into(), "f".repeat(64));
    assert!(matches!(
        stream_mimir_cloud(&store, &cloud, own).await.err(),
        Some(Error::ForbiddenHeader { .. })
    ));
    let mut anthropic = messages(&cloud);
    anthropic.provider = "anthropic".into();
    assert!(stream_mimir_cloud(&store, &cloud, anthropic).await.is_err());
    // nothing reached the proxy and nothing registered
    assert!(proxy.lock().unwrap().seen.is_empty());
    assert_eq!(store.token(), None);
}

#[tokio::test]
async fn quota_and_forget() {
    let (proxy, cloud) = setup().await;
    let store = MemStore::default();
    // no token: nothing to forget, nothing sent
    assert_eq!(cloud::forget(&store, &cloud).await.unwrap(), 0);
    assert!(proxy.lock().unwrap().seen.is_empty());
    let q = cloud::quota(&store, &cloud).await.unwrap();
    assert_eq!(q.install_used, 1200);
    assert_eq!(q.install_cap, 500_000);
    assert!(q.edition_open);
    assert_eq!(q.day, "2026-10-12");
    assert_eq!(
        serde_json::to_value(&q).unwrap()["installCap"],
        serde_json::json!(500_000)
    );
    assert_eq!(cloud::forget(&store, &cloud).await.unwrap(), 3);
    // a token the proxy forgot has nothing to delete, and forget never registers
    proxy.lock().unwrap().known.clear();
    assert_eq!(cloud::forget(&store, &cloud).await.unwrap(), 0);
    assert_eq!(proxy.lock().unwrap().issued, 1);
}

#[tokio::test]
async fn register_replaces_the_token() {
    let (_proxy, cloud) = setup().await;
    let store = MemStore::default();
    cloud::register(&store, &cloud).await.unwrap();
    let first = store.token().unwrap();
    cloud::register(&store, &cloud).await.unwrap();
    assert_ne!(store.token().unwrap(), first);
    assert!(cloud::registered(&store));
}

#[test]
fn not_available_until_the_host_is_set() {
    // this test binary never sets the process-wide host
    assert!(mimir_cloud().is_none());
    assert!(!available_with(&MemStore::default(), "mimir-cloud"));
}
