// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Transport tests. None touch the real keychain, the process environment or the
//! internet; the HTTP tests talk to a one-shot server on 127.0.0.1.
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

const FAKE_KEY: &str = "sk-test-0123456789abcdefghijklmnop";

/// In-memory key source that counts reads.
#[derive(Default)]
struct FakeKeys {
    keychain: HashMap<(String, String), String>,
    env: HashMap<String, String>,
    reads: AtomicUsize,
}

impl FakeKeys {
    fn with_keychain(mut self, value: &str) -> Self {
        self.keychain.insert(
            (OPENAI_KEYCHAIN_SERVICE.into(), OPENAI_KEYCHAIN_ACCOUNT.into()),
            value.into(),
        );
        self
    }

    fn with_env(mut self, name: &str, value: &str) -> Self {
        self.env.insert(name.into(), value.into());
        self
    }
}

impl KeySource for FakeKeys {
    fn keychain(&self, service: &str, account: &str) -> Option<String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.keychain
            .get(&(service.to_owned(), account.to_owned()))
            .cloned()
    }

    fn env(&self, name: &str) -> Option<String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.env.get(name).cloned()
    }
}

fn request(provider: &str, url: &str) -> LlmHttpRequest {
    LlmHttpRequest {
        provider: provider.into(),
        url: url.into(),
        method: HttpMethod::Post,
        headers: BTreeMap::from([("content-type".into(), "application/json".into())]),
        body: r#"{"model":"test","stream":true}"#.into(),
    }
}

async fn stream_err(keys: &FakeKeys, req: LlmHttpRequest) -> Error {
    match stream_with(keys, req).await {
        Ok(_) => panic!("expected an error"),
        Err(e) => e,
    }
}

#[test]
fn available_follows_the_lookup_order() {
    let none = FakeKeys::default();
    assert!(!available_with(&none, "openai"));
    assert!(available_with(&none, "openai-compatible"));
    assert!(!available_with(&none, "anthropic"));

    assert!(available_with(
        &FakeKeys::default().with_env("SLICERX_OPENAI_API_KEY", FAKE_KEY),
        "openai"
    ));
    assert!(available_with(
        &FakeKeys::default().with_env("OPENAI_API_KEY", FAKE_KEY),
        "openai"
    ));
    assert!(available_with(
        &FakeKeys::default().with_keychain(FAKE_KEY),
        "openai"
    ));
    // Blank values count as missing.
    assert!(!available_with(
        &FakeKeys::default()
            .with_keychain("  ")
            .with_env("OPENAI_API_KEY", "\n"),
        "openai"
    ));
}

#[test]
fn keychain_wins_then_slicerx_env_then_openai_env() {
    let all = FakeKeys::default()
        .with_keychain("from-keychain")
        .with_env("SLICERX_OPENAI_API_KEY", "from-slicerx-env")
        .with_env("OPENAI_API_KEY", "from-openai-env");
    assert_eq!(keys::openai_key(&all).unwrap().expose(), "from-keychain");
    let env_only = FakeKeys::default()
        .with_env("SLICERX_OPENAI_API_KEY", " from-slicerx-env ")
        .with_env("OPENAI_API_KEY", "from-openai-env");
    assert_eq!(keys::openai_key(&env_only).unwrap().expose(), "from-slicerx-env");
    let last = FakeKeys::default().with_env("OPENAI_API_KEY", "from-openai-env");
    assert_eq!(keys::openai_key(&last).unwrap().expose(), "from-openai-env");
    assert_eq!(
        format!("{:?}", keys::openai_key(&last).unwrap()),
        "ApiKey([redacted])"
    );
}

#[tokio::test]
async fn hostile_requests_fail_before_the_key_is_read() {
    let keys = FakeKeys::default().with_keychain(FAKE_KEY);
    let err = stream_err(&keys, request("openai", "https://evil.example/v1/responses")).await;
    assert!(matches!(err, Error::UrlNotAllowed { .. }), "{err:?}");

    let mut req = request("openai", "https://api.openai.com/v1/responses");
    req.headers
        .insert("Authorization".into(), "Bearer attacker".into());
    let err = stream_err(&keys, req).await;
    assert_eq!(
        err,
        Error::ForbiddenHeader {
            name: "authorization".into()
        }
    );

    let err = stream_err(&keys, request("mystery", "https://api.openai.com/v1")).await;
    assert!(matches!(err, Error::UnknownProvider { .. }), "{err:?}");
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0, "key was read");
}

#[tokio::test]
async fn missing_key_is_reported_without_sending() {
    let err = stream_err(
        &FakeKeys::default(),
        request("openai", "https://api.openai.com/v1/responses"),
    )
    .await;
    assert_eq!(
        err,
        Error::MissingKey {
            provider: "openai".into()
        }
    );
}

#[test]
fn request_serializes_like_the_ts_contract() {
    let req = request("openai", "https://api.openai.com/v1/responses");
    let json = serde_json::to_value(&req).unwrap();
    assert_eq!(json["method"], "POST");
    assert_eq!(json["headers"]["content-type"], "application/json");
    let back: LlmHttpRequest = serde_json::from_value(json).unwrap();
    assert_eq!(back, req);
}

/// Serves one HTTP/1.1 response on 127.0.0.1 and returns the raw request it received.
async fn one_shot(status: &str, body: &str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://127.0.0.1:{}/v1/chat/completions",
        listener.local_addr().unwrap().port()
    );
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut seen = Vec::new();
        let mut buf = [0u8; 4096];
        // Headers, then a body of known length: read until the body has arrived.
        loop {
            let n = sock.read(&mut buf).await.unwrap();
            seen.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&seen);
            if n == 0 || text.contains("\r\n\r\n{") && text.ends_with('}') {
                break;
            }
        }
        sock.write_all(response.as_bytes()).await.unwrap();
        sock.shutdown().await.unwrap();
        String::from_utf8_lossy(&seen).into_owned()
    });
    (url, handle)
}

#[tokio::test]
async fn local_stream_returns_the_body_and_sends_no_key() {
    let (url, server) = one_shot("200 OK", "data: {\"delta\":\"hi\"}\n\n").await;
    let keys = FakeKeys::default().with_keychain(FAKE_KEY);
    let mut body = Vec::new();
    let mut s = std::pin::pin!(
        stream_with(&keys, request("openai-compatible", &url))
            .await
            .unwrap()
    );
    while let Some(chunk) = s.next().await {
        body.extend_from_slice(&chunk.unwrap());
    }
    assert_eq!(body, b"data: {\"delta\":\"hi\"}\n\n");
    let seen = server.await.unwrap().to_ascii_lowercase();
    assert!(seen.starts_with("post /v1/chat/completions"), "{seen}");
    assert!(!seen.contains("authorization"), "{seen}");
    assert_eq!(
        keys.reads.load(Ordering::SeqCst),
        0,
        "key was read for a local server"
    );
}

#[tokio::test]
async fn http_errors_carry_a_redacted_provider_message() {
    let body = format!(
        r#"{{"error":{{"message":"Incorrect API key provided: {FAKE_KEY}. Also Bearer abcdef and {}.","type":"invalid_request_error"}}}}"#,
        "x".repeat(400)
    );
    let (url, server) = one_shot("401 Unauthorized", &body).await;
    let err = stream_err(&FakeKeys::default(), request("openai-compatible", &url)).await;
    let _ = server.await.unwrap();
    let Error::Http { status, message } = &err else {
        panic!("expected Http, got {err:?}");
    };
    assert_eq!(*status, 401);
    assert!(
        message.starts_with("Incorrect API key provided: [redacted]. Also Bearer [redacted] and xxx"),
        "{message}"
    );
    assert_eq!(message.chars().count(), 300);
    let shown = format!("{err} {err:?}");
    assert!(!shown.contains("sk-test") && !shown.contains("abcdef"), "{shown}");
}

#[tokio::test]
async fn empty_error_body_falls_back_to_the_status_reason() {
    let (url, server) = one_shot("503 Service Unavailable", "").await;
    let err = stream_err(&FakeKeys::default(), request("openai-compatible", &url)).await;
    let _ = server.await;
    assert_eq!(
        err,
        Error::Http {
            status: 503,
            message: "Service Unavailable".into()
        }
    );
}

fn anthropic_keys() -> FakeKeys {
    let mut k = FakeKeys::default();
    k.keychain.insert(
        (
            ANTHROPIC_KEYCHAIN_SERVICE.into(),
            ANTHROPIC_KEYCHAIN_ACCOUNT.into(),
        ),
        "from-anthropic-keychain".into(),
    );
    k
}

#[test]
fn anthropic_key_lookup_order_and_isolation() {
    assert!(available_with(&anthropic_keys(), "anthropic"));
    assert!(available_with(
        &FakeKeys::default().with_env("SLICERX_ANTHROPIC_API_KEY", FAKE_KEY),
        "anthropic"
    ));
    assert!(available_with(
        &FakeKeys::default().with_env("ANTHROPIC_API_KEY", FAKE_KEY),
        "anthropic"
    ));
    assert_eq!(
        keys::anthropic_key(&anthropic_keys()).unwrap().expose(),
        "from-anthropic-keychain"
    );
    // The two providers never read each other's key.
    assert!(!available_with(&anthropic_keys(), "openai"));
    assert!(!available_with(
        &FakeKeys::default().with_keychain(FAKE_KEY),
        "anthropic"
    ));
    assert!(!available_with(
        &FakeKeys::default().with_env("OPENAI_API_KEY", FAKE_KEY),
        "anthropic"
    ));
    assert!(!available_with(
        &FakeKeys::default()
            .with_keychain(" ")
            .with_env("ANTHROPIC_API_KEY", "\n"),
        "anthropic"
    ));
}

#[tokio::test]
async fn anthropic_requests_are_checked_before_the_key_is_read() {
    let keys = anthropic_keys();
    let err = stream_err(&keys, request("anthropic", "https://evil.example/v1/messages")).await;
    assert!(matches!(err, Error::UrlNotAllowed { .. }), "{err:?}");
    // The OpenAI host is not an Anthropic host.
    let err = stream_err(&keys, request("anthropic", "https://api.openai.com/v1/responses")).await;
    assert!(matches!(err, Error::UrlNotAllowed { .. }), "{err:?}");
    let mut req = request("anthropic", "https://api.anthropic.com/v1/messages");
    req.headers.insert("X-Api-Key".into(), "hostile-value".into());
    let err = stream_err(&keys, req).await;
    assert_eq!(
        err,
        Error::ForbiddenHeader {
            name: "x-api-key".into()
        }
    );
    assert!(!err.to_string().contains("hostile-value"));
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0, "key was read");
}

#[tokio::test]
async fn missing_anthropic_key_is_reported_without_sending() {
    let err = stream_err(
        &FakeKeys::default(),
        request("anthropic", "https://api.anthropic.com/v1/messages"),
    )
    .await;
    assert_eq!(
        err,
        Error::MissingKey {
            provider: "anthropic".into()
        }
    );
}

/// Serves one GET with `body` and returns the raw request it received.
async fn get_once(path: &str, body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}{path}", listener.local_addr().unwrap().port());
    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut seen = Vec::new();
        let mut buf = [0u8; 4096];
        while !String::from_utf8_lossy(&seen).contains("\r\n\r\n") {
            let n = sock.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            seen.extend_from_slice(&buf[..n]);
        }
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(response.as_bytes()).await.unwrap();
        sock.shutdown().await.unwrap();
        String::from_utf8_lossy(&seen).into_owned()
    });
    (url, handle)
}

#[tokio::test]
async fn local_get_reads_a_listing_and_sends_no_key() {
    let (url, server) = get_once("/api/tags", r#"{"models":[]}"#).await;
    assert_eq!(local_get(&url).await.unwrap(), r#"{"models":[]}"#);
    let seen = server.await.unwrap().to_ascii_lowercase();
    assert!(seen.starts_with("get /api/tags"), "{seen}");
    assert!(!seen.contains("authorization"), "{seen}");
}

#[tokio::test]
async fn local_get_refuses_anything_but_loopback_http() {
    for url in [
        "https://api.openai.com/v1/models",
        "http://192.168.1.20:11434/api/tags",
        "https://localhost:1234/v1/models",
        "http://x@localhost:11434/api/tags",
    ] {
        assert!(
            matches!(local_get(url).await, Err(Error::UrlNotAllowed { .. })),
            "{url}"
        );
    }
}
