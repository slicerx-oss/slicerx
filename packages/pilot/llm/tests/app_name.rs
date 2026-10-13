// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A white-label edition (Acme Slicer) names itself on the ChatGPT sign-in pages and in the sign-in errors, as a
//! browser and the app see them. Its own test binary, so the name set here reaches no other test.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sx_llm::chatgpt::{
    CHATGPT_KEYCHAIN_ACCOUNT, CHATGPT_KEYCHAIN_SERVICE, ConnectOptions, Endpoints, SecretStore, connect,
    disconnect,
};
use sx_llm::{KeySource, app_name, set_app_name};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

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
    fn set(&self, service: &str, account: &str, value: &str) -> sx_llm::Result<()> {
        self.0
            .lock()
            .unwrap()
            .insert((service.into(), account.into()), value.into());
        Ok(())
    }
    fn delete(&self, service: &str, account: &str) -> sx_llm::Result<()> {
        self.0.lock().unwrap().remove(&(service.into(), account.into()));
        Ok(())
    }
}

/// An auth server that answers discovery only, without a revocation endpoint.
async fn issuer() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let doc = serde_json::json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/oauth/authorize"),
        "token_endpoint": format!("{base}/oauth/token"),
    })
    .to_string();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let doc = doc.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{doc}",
                    doc.len()
                );
                let _ = sock.write_all(reply.as_bytes()).await;
            });
        }
    });
    base
}

/// A browser's GET, over plain TCP. Returns the whole response.
async fn get(url: &str) -> String {
    let u = reqwest::Url::parse(url).unwrap();
    let host = format!("{}:{}", u.host_str().unwrap(), u.port().unwrap());
    let mut sock = tokio::net::TcpStream::connect(&host).await.unwrap();
    let target = format!("{}?{}", u.path(), u.query().unwrap_or_default());
    sock.write_all(format!("GET {target} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut out = String::new();
    let _ = sock.read_to_string(&mut out).await;
    out
}

#[tokio::test]
async fn the_sign_in_pages_and_errors_name_the_edition() {
    assert_eq!(app_name(), "SlicerX");
    set_app_name("Acme Slicer");
    assert_eq!(app_name(), "Acme Slicer");
    let base = issuer().await;
    let endpoints = Endpoints::custom(&base, &format!("{base}/v1")).unwrap();

    // The browser comes back with a link that is not this sign-in's: the page says to go back to the app.
    let page: Arc<Mutex<String>> = Arc::default();
    let seen = page.clone();
    let open = move |url: &str| -> sx_llm::Result<()> {
        let u = reqwest::Url::parse(url).unwrap();
        let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
        assert_eq!(q["agent_name_hint"], "Acme Slicer");
        let redirect = q["redirect_uri"].clone();
        let seen = seen.clone();
        tokio::spawn(async move {
            let reply = get(&format!("{redirect}?code=x&state=wrong&client_id=c")).await;
            *seen.lock().unwrap() = reply;
        });
        Ok(())
    };
    let free = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = free.local_addr().unwrap().port();
    drop(free);
    let opts = ConnectOptions {
        endpoints: endpoints.clone(),
        redirect_port: port,
        app_name: "Acme Slicer",
        open_url: &open,
        timeout: Duration::from_millis(1500),
    };
    let err = connect(&MemStore::default(), &opts)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("timed out"), "{err}");
    let page = page.lock().unwrap().clone();
    assert!(page.starts_with("HTTP/1.1 400"), "{page}");
    assert!(page.contains("<title>Acme Slicer</title>"), "{page}");
    assert!(page.contains("Go back to Acme Slicer and try again."), "{page}");
    assert!(!page.contains("SlicerX"), "{page}");

    // The callback port is taken by another copy of the app.
    let busy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let opts = ConnectOptions {
        redirect_port: busy.local_addr().unwrap().port(),
        ..opts
    };
    let err = connect(&MemStore::default(), &opts)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("close the other copy of Acme Slicer"), "{err}");

    // Signing out where the server offers no revocation.
    let store = MemStore::default();
    let stored = serde_json::json!({
        "client_id": "c", "access_token": "a", "refresh_token": "r", "expires_at": 0, "scopes": [],
        "subject": "s", "email": null, "name": null, "connected_at": 0, "capabilities": null,
    });
    store
        .set(
            CHATGPT_KEYCHAIN_SERVICE,
            CHATGPT_KEYCHAIN_ACCOUNT,
            &stored.to_string(),
        )
        .unwrap();
    let err = disconnect(&store, &endpoints).await.unwrap_err().to_string();
    assert!(
        err.contains("disconnect Acme Slicer in ChatGPT settings"),
        "{err}"
    );
    assert!(!err.contains("SlicerX"), "{err}");
}
