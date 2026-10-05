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
    /// The request failed. `status` is the HTTP status, 0 when there was none.
    Error { status: u16, message: String },
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
        sx_llm::Error::Http { status, message } => LlmChunk::Error {
            status: *status,
            message: message.clone(),
        },
        // Every error's text is free of keys and tokens (sx-llm redacts).
        other => LlmChunk::Error {
            status: 0,
            message: other.to_string(),
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
                message: "slow down".into()
            }]
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
