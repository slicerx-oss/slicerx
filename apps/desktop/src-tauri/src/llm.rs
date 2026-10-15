// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The assistant's model transport. The webview's provider adapter builds a request without any
//! credential; `llm_stream` hands it to sx-llm, which picks the ChatGPT plan or the API key
//! (plan first, the key once on a refusal), adds the token itself and streams the response body
//! back over a channel. Only response bytes and error messages cross into the webview, never a
//! token or a key.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use futures::StreamExt;
use serde::Serialize;
use sx_llm::chatgpt::{self, Needs, OpenAiAuth};
use sx_llm::{LlmHttpRequest, SystemKeySource};
use tauri::ipc::Channel;

/// One message on a stream's channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LlmChunk {
    /// Response bytes, base64.
    Data { b64: String },
    /// The request failed. `status` is the HTTP status, 0 when there was none; `code` is mimir
    /// cloud's refusal code.
    Error {
        status: u16,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// The body ended.
    End,
}

/// Running streams by the webview's id, so a cancel can stop one.
fn streams() -> &'static Mutex<HashMap<u32, tauri::async_runtime::JoinHandle<()>>> {
    static STREAMS: OnceLock<Mutex<HashMap<u32, tauri::async_runtime::JoinHandle<()>>>> = OnceLock::new();
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn error_chunk(e: &sx_llm::Error) -> LlmChunk {
    match e {
        sx_llm::Error::Http {
            status,
            message,
            code,
        } => LlmChunk::Error {
            status: *status,
            message: message.clone(),
            code: code.clone(),
        },
        // Every error's text is free of keys and tokens (sx-llm redacts).
        other => LlmChunk::Error {
            status: 0,
            message: other.to_string(),
            code: None,
        },
    }
}

/// Sends `request` and forwards the body to `on_chunk` until it ends, fails or is canceled.
pub async fn pump(request: LlmHttpRequest, on_chunk: impl Fn(LlmChunk) -> bool + Send) {
    let mut body = match sx_llm::stream(request).await {
        Ok(b) => b,
        Err(e) => {
            on_chunk(error_chunk(&e));
            return;
        }
    };
    while let Some(next) = body.next().await {
        let chunk = match next {
            Ok(bytes) => LlmChunk::Data {
                b64: B64.encode(&bytes),
            },
            Err(e) => {
                on_chunk(error_chunk(&e));
                return;
            }
        };
        if !on_chunk(chunk) {
            return;
        }
    }
    on_chunk(LlmChunk::End);
}

/// True when the provider can be reached: a ChatGPT plan connection or a key for `openai`.
#[tauri::command]
pub async fn llm_available(provider: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || sx_llm::available(&provider))
        .await
        .unwrap_or(false)
}

/// Lists the models of an `openai-compatible` server the person typed in, on this computer or the
/// home network, sending the optional local key from the keychain. Returns the raw listing; the
/// webview never sees the key and its CSP stays closed to the network.
#[tauri::command]
pub async fn llm_local_models(base_url: String) -> Result<String, String> {
    sx_llm::local_models(&base_url).await.map_err(|e| match e {
        sx_llm::Error::Http { status, message, .. } => format!("{status}: {message}"),
        other => other.to_string(),
    })
}

/// Lists the models of `openai` or `anthropic` for the connect test, with `key` when the person
/// typed one that is not saved yet, else the saved key from the keychain. The request goes only
/// to the provider's allowlisted host (sx-llm checks it before any key is read), so the webview
/// needs no network access and its CSP stays closed. The key is never logged or written here;
/// saving it stays with `chatgpt_set_api_key` once the test passes. HTTP failures come back as
/// `<status>: <message>`, with the key redacted.
#[tauri::command]
pub async fn llm_provider_models(
    provider: String,
    base_url: String,
    key: Option<String>,
) -> Result<String, String> {
    sx_llm::provider_models(&provider, &base_url, key)
        .await
        .map_err(|e| match e {
            sx_llm::Error::Http { status, message, .. } => format!("{status}: {message}"),
            other => other.to_string(),
        })
}

/// Who pays for `openai` requests now: `plan`, `key`, or none.
#[tauri::command]
pub async fn llm_billing() -> Option<&'static str> {
    tauri::async_runtime::spawn_blocking(
        || match chatgpt::openai_auth(&SystemKeySource, Needs::default()) {
            Some(OpenAiAuth::ChatGptPlan) => Some("plan"),
            Some(OpenAiAuth::ApiKey) => Some("key"),
            None => None,
        },
    )
    .await
    .unwrap_or(None)
}

/// The edition's registration key for mimir cloud, from the build's `SX_MIMIR_REGISTER_KEY`
/// (a release secret per edition; the proxy keeps only its hash). A build without one has no
/// mimir cloud.
const REGISTER_KEY: Option<&str> = option_env!("SX_MIMIR_REGISTER_KEY");

/// The edition's mimir cloud, from the `mimir-cloud` entry the edition overlay writes into the
/// Tauri config (`{url, edition}`, packages/edition-config tauriConfig). Set once at startup, so
/// the webview can never move the install token to another host. No entry or no registration
/// key: not available.
pub fn init_cloud(config: &tauri::Config) {
    let Some(c) = config.plugins.0.get("mimir-cloud") else {
        return;
    };
    // a secret piped into the build can carry a trailing newline
    let Some(key) = REGISTER_KEY.map(str::trim).filter(|k| !k.is_empty()) else {
        eprintln!("mimir cloud is off: this build has no registration key");
        return;
    };
    let url = c.get("url").and_then(|v| v.as_str()).unwrap_or_default();
    let edition = c.get("edition").and_then(|v| v.as_str()).unwrap_or_default();
    if let Err(e) = sx_llm::set_mimir_cloud(url, edition, key) {
        eprintln!("mimir cloud is off: {e}");
    }
}

fn cloud_or_err() -> Result<&'static sx_llm::MimirCloud, String> {
    sx_llm::mimir_cloud().ok_or_else(|| "mimir cloud is not part of this build.".to_owned())
}

fn text(e: sx_llm::Error) -> String {
    match e {
        sx_llm::Error::Http { message, .. } => message,
        other => other.to_string(),
    }
}

/// Registers this install with mimir cloud again; the new token replaces the old in the keychain.
#[tauri::command]
pub async fn mimir_cloud_register() -> Result<(), String> {
    sx_llm::cloud::register(&SystemKeySource, cloud_or_err()?)
        .await
        .map_err(text)
}

/// Today's mimir cloud use and caps for this install (registers it first when it has no token).
#[tauri::command]
pub async fn mimir_cloud_quota() -> Result<sx_llm::cloud::Quota, String> {
    sx_llm::cloud::quota(&SystemKeySource, cloud_or_err()?)
        .await
        .map_err(text)
}

/// Deletes the sessions this install shared with mimir cloud; returns how many.
#[tauri::command]
pub async fn mimir_cloud_forget() -> Result<u64, String> {
    sx_llm::cloud::forget(&SystemKeySource, cloud_or_err()?)
        .await
        .map_err(text)
}

/// Starts a request; its body arrives on `on_chunk`. `id` is the webview's, for `llm_cancel`.
#[tauri::command]
pub fn llm_stream(id: u32, request: LlmHttpRequest, on_chunk: Channel<LlmChunk>) {
    let handle = tauri::async_runtime::spawn(async move {
        pump(request, |c| on_chunk.send(c).is_ok()).await;
        streams()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
    });
    streams()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(id, handle);
}

/// Stops a running request.
#[tauri::command]
pub fn llm_cancel(id: u32) {
    if let Some(h) = streams()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&id)
    {
        h.abort();
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    /// A local model server: answers one request with `status` and `body`.
    async fn server(status: u16, body: &'static str) -> String {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://127.0.0.1:{}/v1/chat/completions",
            l.local_addr().unwrap().port()
        );
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let _ = s.read(&mut buf).await;
            let head = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            s.write_all(head.as_bytes()).await.unwrap();
            s.write_all(body.as_bytes()).await.unwrap();
        });
        url
    }

    fn request(url: String) -> LlmHttpRequest {
        LlmHttpRequest {
            provider: "openai-compatible".into(),
            url,
            method: sx_llm::HttpMethod::Post,
            headers: BTreeMap::from([("content-type".into(), "application/json".into())]),
            body: r#"{"model":"m","messages":[],"stream":true}"#.into(),
        }
    }

    async fn collect(req: LlmHttpRequest) -> Vec<LlmChunk> {
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        pump(req, move |c| {
            sink.lock().unwrap().push(c);
            true
        })
        .await;
        got.lock().unwrap().clone()
    }

    #[tokio::test]
    async fn streams_the_body_and_ends() {
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
        let chunks = collect(request(server(200, sse).await)).await;
        assert_eq!(chunks.last(), Some(&LlmChunk::End));
        let text: Vec<u8> = chunks
            .iter()
            .filter_map(|c| match c {
                LlmChunk::Data { b64 } => Some(B64.decode(b64).unwrap()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(String::from_utf8(text).unwrap(), sse);
    }

    #[tokio::test]
    async fn reports_the_status_and_message_of_a_failure() {
        let chunks = collect(request(server(429, r#"{"error":{"message":"slow down"}}"#).await)).await;
        assert_eq!(
            chunks,
            vec![LlmChunk::Error {
                status: 429,
                message: "slow down".into(),
                code: None,
            }]
        );
    }

    #[test]
    fn a_mimir_refusal_passes_its_code_to_the_webview() {
        let e = sx_llm::Error::Http {
            status: 429,
            message: "Today's free mimir use is used up.".into(),
            code: Some("day_used".into()),
        };
        let json = serde_json::to_value(error_chunk(&e)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "error", "status": 429, "message": "Today's free mimir use is used up.", "code": "day_used" })
        );
        let plain = sx_llm::Error::Http {
            status: 500,
            message: "boom".into(),
            code: None,
        };
        assert!(
            serde_json::to_value(error_chunk(&plain))
                .unwrap()
                .get("code")
                .is_none()
        );
    }

    #[tokio::test]
    async fn refuses_a_request_that_carries_its_own_credential() {
        let mut req = request("http://127.0.0.1:9/v1/chat/completions".into());
        req.headers.insert("authorization".into(), "Bearer sk-x".into());
        let chunks = collect(req).await;
        assert!(matches!(&chunks[..], [LlmChunk::Error { status: 0, .. }]));
    }
}
