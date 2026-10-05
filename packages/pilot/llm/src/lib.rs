// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-llm. See README.md for the public API.
//!
//! Streaming HTTP transport for Pilot's provider adapters. An adapter builds an
//! [`LlmHttpRequest`] without a key; this crate checks the URL against the provider's
//! allowlist, refuses requests that carry their own `authorization` header, reads the key
//! at request time, adds `Authorization: Bearer`, and streams the raw response body back.
//! Keys never reach logs, errors, disk or the webview.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

pub mod chatgpt;
mod error;
mod guard;
mod keys;
mod redact;

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use futures::{Stream, StreamExt};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};

pub use error::{Error, Result};
pub use keys::{
    ANTHROPIC_KEY_ENV, ANTHROPIC_KEYCHAIN_ACCOUNT, ANTHROPIC_KEYCHAIN_SERVICE, KeySource, OPENAI_KEY_ENV,
    OPENAI_KEYCHAIN_ACCOUNT, OPENAI_KEYCHAIN_SERVICE, SystemKeySource,
};

use keys::{ApiKey, Provider};

/// Largest provider error body read to build [`Error::Http`].
const MAX_ERROR_BODY: usize = 64 * 1024;

/// HTTP method of an [`LlmHttpRequest`]. Provider APIs only take `POST`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum HttpMethod {
    /// `POST`.
    #[default]
    #[serde(rename = "POST")]
    Post,
}

/// HTTP request built by a provider adapter. It never carries the key; the transport adds
/// it. Mirrors `LlmHttpRequest` in `packages/contracts/src/pilot.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmHttpRequest {
    /// Provider id: `openai` or `openai-compatible`.
    pub provider: String,
    /// Full endpoint URL. Must match the provider's allowlist.
    pub url: String,
    /// Always `POST`.
    pub method: HttpMethod,
    /// Extra headers such as `content-type`. Must not include `authorization`.
    pub headers: BTreeMap<String, String>,
    /// Request body, usually JSON.
    pub body: String,
}

/// True when [`stream`] can authenticate for `provider`: for `openai`, a ChatGPT plan
/// connection or a key in the keychain or the environment; `openai-compatible` needs no key
/// and is always available.
/// Unknown providers are not available. Reads the keychain, so it can block briefly.
pub fn available(provider: &str) -> bool {
    if provider == "openai" && chatgpt::openai_auth(&SystemKeySource, chatgpt::Needs::default()).is_some() {
        return true;
    }
    available_with(&SystemKeySource, provider)
}

/// [`available`] over an explicit key source.
pub fn available_with(keys: &dyn KeySource, provider: &str) -> bool {
    match Provider::parse(provider) {
        Some(Provider::OpenAi) => keys::openai_key(keys).is_some(),
        Some(Provider::Anthropic) => keys::anthropic_key(keys).is_some(),
        Some(Provider::OpenAiCompatible) => true,
        None => false,
    }
}

/// Sends `req` and streams the raw response body (SSE bytes for streaming APIs).
///
/// Checks run before the key is read: the provider must be known, the URL must match its
/// allowlist and no `authorization` header may be present. The key is then read from the
/// keychain on a blocking thread (see [`SystemKeySource`]). A non-2xx reply becomes
/// [`Error::Http`]. Redirects are not followed and no proxy is used. Needs a tokio runtime.
pub async fn stream(req: LlmHttpRequest) -> Result<impl Stream<Item = Result<Bytes>> + Send + 'static> {
    let checked = Checked::new(&req)?;
    let key = match checked.provider {
        Provider::OpenAi => {
            let rt = tokio::runtime::Handle::try_current()
                .map_err(|_| Error::Transport("no tokio runtime".to_owned()))?;
            let needs = chatgpt::Needs::of_body(&req.body);
            let auth = rt
                .spawn_blocking(move || chatgpt::openai_auth(&SystemKeySource, needs))
                .await
                .map_err(|_| Error::Transport("key lookup failed".to_owned()))?;
            match auth {
                Some(chatgpt::OpenAiAuth::ChatGptPlan) => {
                    return Ok(body_stream(
                        send_on_plan(&SystemKeySource, &chatgpt::Endpoints::openai()?, req, needs).await?,
                    ));
                }
                Some(chatgpt::OpenAiAuth::ApiKey) => {
                    let key = rt
                        .spawn_blocking(|| keys::openai_key(&SystemKeySource))
                        .await
                        .map_err(|_| Error::Transport("key lookup failed".to_owned()))?;
                    Some(key.ok_or_else(|| missing_key(&req))?)
                }
                None => return Err(missing_key(&req)),
            }
        }
        Provider::Anthropic => {
            let rt = tokio::runtime::Handle::try_current()
                .map_err(|_| Error::Transport("no tokio runtime".to_owned()))?;
            let key = rt
                .spawn_blocking(|| keys::anthropic_key(&SystemKeySource))
                .await
                .map_err(|_| Error::Transport("key lookup failed".to_owned()))?;
            Some(key.ok_or_else(|| missing_key(&req))?)
        }
        Provider::OpenAiCompatible => None,
    };
    Ok(body_stream(send_response(checked, req, key).await?))
}

/// [`stream`] over an explicit key source, read on the calling task.
pub async fn stream_with(
    keys: &dyn KeySource,
    req: LlmHttpRequest,
) -> Result<impl Stream<Item = Result<Bytes>> + Send + 'static> {
    let checked = Checked::new(&req)?;
    let key = match checked.provider {
        Provider::OpenAi => Some(keys::openai_key(keys).ok_or_else(|| missing_key(&req))?),
        Provider::Anthropic => Some(keys::anthropic_key(keys).ok_or_else(|| missing_key(&req))?),
        Provider::OpenAiCompatible => None,
    };
    Ok(body_stream(send_response(checked, req, key).await?))
}

/// [`stream`] over an explicit store that may hold a ChatGPT connection, with explicit
/// endpoints for the token refresh. The request itself still goes to the provider's
/// allowlisted URL.
pub async fn stream_with_store(
    store: &dyn chatgpt::SecretStore,
    endpoints: &chatgpt::Endpoints,
    req: LlmHttpRequest,
) -> Result<impl Stream<Item = Result<Bytes>> + Send + 'static> {
    let checked = Checked::new(&req)?;
    let key = match checked.provider {
        Provider::OpenAi => match chatgpt::openai_auth(store, chatgpt::Needs::of_body(&req.body)) {
            Some(chatgpt::OpenAiAuth::ChatGptPlan) => {
                let needs = chatgpt::Needs::of_body(&req.body);
                return Ok(body_stream(send_on_plan(store, endpoints, req, needs).await?));
            }
            Some(chatgpt::OpenAiAuth::ApiKey) => {
                Some(keys::openai_key(store).ok_or_else(|| missing_key(&req))?)
            }
            None => return Err(missing_key(&req)),
        },
        Provider::Anthropic => Some(keys::anthropic_key(store).ok_or_else(|| missing_key(&req))?),
        Provider::OpenAiCompatible => None,
    };
    Ok(body_stream(send_response(checked, req, key).await?))
}

/// Largest listing [`local_get`] reads.
const MAX_LOCAL_BODY: usize = 1024 * 1024;

/// How long [`local_get`] waits, so a probe for a server that is not running returns at once.
const LOCAL_GET_TIMEOUT: Duration = Duration::from_secs(3);

/// GETs a local model server's listing (Ollama's `/api/tags`, LM Studio's `/v1/models`) as
/// text. Only `openai-compatible` URLs pass (`http://127.0.0.1` or `http://localhost`), no
/// key is ever read, and the body is capped at 1 MiB. Needs a tokio runtime.
pub async fn local_get(url: &str) -> Result<String> {
    let url = guard::check_url(Provider::OpenAiCompatible, "openai-compatible", url)?;
    let send = async {
        let mut response = client()?.get(url).send().await.map_err(Error::transport)?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::Http {
                status: status.as_u16(),
                message: status.canonical_reason().unwrap_or_default().to_owned(),
            });
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(Error::transport)? {
            if body.len() + chunk.len() > MAX_LOCAL_BODY {
                return Err(Error::Transport("the listing is too large".to_owned()));
            }
            body.extend_from_slice(&chunk);
        }
        String::from_utf8(body).map_err(|_| Error::Transport("the listing is not text".to_owned()))
    };
    tokio::time::timeout(LOCAL_GET_TIMEOUT, send)
        .await
        .map_err(|_| Error::Transport("timed out".to_owned()))?
}

/// Sends on the ChatGPT plan. When the plan refuses the request ([`chatgpt::fall_back`])
/// and an API key exists, sends it once more with the key, unchanged.
async fn send_on_plan(
    store: &dyn chatgpt::SecretStore,
    endpoints: &chatgpt::Endpoints,
    req: LlmHttpRequest,
    needs: chatgpt::Needs,
) -> Result<reqwest::Response> {
    let token = chatgpt::plan_token(store, endpoints).await?;
    let first = send_response(Checked::new(&req)?, plan_request(req.clone()), Some(token)).await;
    match first {
        Err(Error::Http { status, message }) if chatgpt::fall_back(status, &message) => {
            chatgpt::note_refusal(store, needs, status, &message);
            match keys::openai_key(store) {
                Some(key) => send_response(Checked::new(&req)?, req, Some(key)).await,
                None => Err(Error::Http { status, message }),
            }
        }
        other => other,
    }
}

/// The request in the shape the ChatGPT plan route takes ([`chatgpt::plan_body`]).
fn plan_request(req: LlmHttpRequest) -> LlmHttpRequest {
    LlmHttpRequest {
        body: chatgpt::plan_body(&req.body),
        ..req
    }
}

/// A request that passed every check that does not need the key.
struct Checked {
    provider: Provider,
    url: Url,
    headers: HeaderMap,
}

impl Checked {
    fn new(req: &LlmHttpRequest) -> Result<Self> {
        let provider = Provider::parse(&req.provider).ok_or_else(|| Error::UnknownProvider {
            provider: req.provider.clone(),
        })?;
        let url = guard::check_url(provider, &req.provider, &req.url)?;
        let headers = guard::check_headers(&req.headers)?;
        Ok(Self {
            provider,
            url,
            headers,
        })
    }
}

fn missing_key(req: &LlmHttpRequest) -> Error {
    Error::MissingKey {
        provider: req.provider.clone(),
    }
}

/// The response body as a stream of chunks. Every path ends here, so `stream` has one type.
fn body_stream(response: reqwest::Response) -> impl Stream<Item = Result<Bytes>> + Send + 'static {
    response
        .bytes_stream()
        .map(|chunk| chunk.map_err(Error::transport))
}

async fn send_response(
    checked: Checked,
    req: LlmHttpRequest,
    key: Option<ApiKey>,
) -> Result<reqwest::Response> {
    let Checked {
        provider,
        url,
        mut headers,
    } = checked;
    if let Some(key) = &key {
        let text = if provider == Provider::Anthropic {
            key.expose().to_owned()
        } else {
            format!("Bearer {}", key.expose())
        };
        let mut value = HeaderValue::from_str(&text).map_err(|_| Error::InvalidKey {
            provider: req.provider.clone(),
        })?;
        // Keeps the value out of reqwest's and hyper's Debug output.
        value.set_sensitive(true);
        if provider == Provider::Anthropic {
            headers.insert(HeaderName::from_static("x-api-key"), value);
            headers.insert(
                HeaderName::from_static("anthropic-version"),
                HeaderValue::from_static("2023-06-01"),
            );
        } else {
            headers.insert(AUTHORIZATION, value);
        }
    }
    let response = client()?
        .post(url)
        .headers(headers)
        .body(req.body)
        .send()
        .await
        .map_err(Error::transport)?;
    let status = response.status();
    if !status.is_success() {
        let body = read_capped(response).await;
        let mut message = redact::provider_message(&body, key.as_ref().map(ApiKey::expose));
        if message.is_empty() {
            status
                .canonical_reason()
                .unwrap_or_default()
                .clone_into(&mut message);
        }
        return Err(Error::Http {
            status: status.as_u16(),
            message,
        });
    }
    Ok(response)
}

/// Reads at most [`MAX_ERROR_BODY`] bytes; a failed read keeps what arrived.
async fn read_capped(mut response: reqwest::Response) -> Vec<u8> {
    let mut body = Vec::new();
    while body.len() < MAX_ERROR_BODY {
        match response.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk),
            Ok(None) | Err(_) => break,
        }
    }
    body.truncate(MAX_ERROR_BODY);
    body
}

/// One client for the process, so connections and the TLS setup are reused. It holds no
/// key; the key is added per request.
fn client() -> Result<Client> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let built = build_client()?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

fn build_client() -> Result<Client> {
    use rustls_platform_verifier::BuilderVerifierExt as _;
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::Transport(format!("TLS setup failed: {e}")))?
        .with_platform_verifier()
        .map_err(|e| Error::Transport(format!("TLS setup failed: {e}")))?
        .with_no_client_auth();
    Client::builder()
        .tls_backend_preconfigured(tls)
        .connect_timeout(Duration::from_secs(15))
        // Reasoning models can pause between events; this bounds a dead connection.
        .read_timeout(Duration::from_secs(300))
        // A redirect could carry the Authorization header to another host.
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(Error::transport)
}

#[cfg(test)]
mod chatgpt_tests;
#[cfg(test)]
mod tests;
