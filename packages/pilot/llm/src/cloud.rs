// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! mimir cloud: the edition's model proxy (`supabase/functions/mimir`). Nobody signs in. The
//! install registers once for a token, kept in its own keychain item and sent as
//! `x-sx-install`, never as `authorization`. The desktop sets the one host at startup
//! ([`set_mimir_cloud`]); with nothing set the provider is not available. Requests go only
//! to `{host}/functions/v1/mimir/v1/messages`.
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};

use crate::chatgpt::SecretStore;
use crate::error::{Error, Result};
use crate::keys::{ApiKey, KeySource};
use crate::{client, read_capped, redact};

/// Keychain service name of the install token.
pub const MIMIR_CLOUD_KEYCHAIN_SERVICE: &str = "slicerx-mimir-cloud-token";
/// Keychain account name of the install token.
pub const MIMIR_CLOUD_KEYCHAIN_ACCOUNT: &str = "slicerx";
/// The one path a model request may take.
pub const MIMIR_CLOUD_MESSAGES_PATH: &str = "/functions/v1/mimir/v1/messages";

const ROUTE: &str = "/functions/v1/mimir";
const PROVIDER: &str = "mimir-cloud";
/// How long register, quota and forget wait.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// Where the proxy lives, the edition it registers for and the edition's registration key.
#[derive(Clone, PartialEq, Eq)]
pub struct MimirCloud {
    origin: Url,
    edition: String,
    register_key: String,
}

impl std::fmt::Debug for MimirCloud {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MimirCloud")
            .field("origin", &self.origin.as_str())
            .field("edition", &self.edition)
            .finish_non_exhaustive()
    }
}

impl MimirCloud {
    /// The proxy on `base_url` (the edition's `backend.supabase.url`; only its origin is used)
    /// for `edition`, registering with the edition's build `register_key` (16 to 128 letters,
    /// digits, `-` or `_`; the proxy keeps only its hash). https only; debug builds also take
    /// `http://127.0.0.1` for a local stack.
    pub fn new(base_url: &str, edition: &str, register_key: &str) -> Result<Self> {
        let bad = || Error::InvalidUrl {
            provider: PROVIDER.to_owned(),
        };
        let url = Url::parse(base_url).map_err(|_| bad())?;
        let host = url.host_str().unwrap_or_default();
        let scheme_ok = url.scheme() == "https"
            || (cfg!(debug_assertions) && url.scheme() == "http" && host == "127.0.0.1");
        if !scheme_ok || host.is_empty() || !url.username().is_empty() || url.password().is_some() {
            return Err(Error::UrlNotAllowed {
                provider: PROVIDER.to_owned(),
                host: host.to_owned(),
            });
        }
        if !edition_ok(edition) || !register_key_ok(register_key) {
            return Err(bad());
        }
        let origin = Url::parse(&url.origin().ascii_serialization()).map_err(|_| bad())?;
        Ok(Self {
            origin,
            edition: edition.to_owned(),
            register_key: register_key.to_owned(),
        })
    }

    /// The edition id sent on register.
    pub fn edition(&self) -> &str {
        &self.edition
    }

    /// The proxy's model endpoint.
    pub fn messages_url(&self) -> String {
        format!(
            "{}{MIMIR_CLOUD_MESSAGES_PATH}",
            self.origin.as_str().trim_end_matches('/')
        )
    }

    fn route(&self, tail: &str) -> Result<Url> {
        let raw = format!("{}{ROUTE}{tail}", self.origin.as_str().trim_end_matches('/'));
        Url::parse(&raw).map_err(|_| Error::InvalidUrl {
            provider: PROVIDER.to_owned(),
        })
    }

    /// True for exactly the model endpoint on this host: same scheme, host and port, no user
    /// info, no query or fragment.
    pub(crate) fn allows(&self, url: &Url) -> bool {
        url.scheme() == self.origin.scheme()
            && url.host_str() == self.origin.host_str()
            && url.port_or_known_default() == self.origin.port_or_known_default()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == MIMIR_CLOUD_MESSAGES_PATH
            && url.query().is_none()
            && url.fragment().is_none()
    }
}

fn edition_ok(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 40
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn register_key_ok(key: &str) -> bool {
    (16..=128).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

static CLOUD: OnceLock<MimirCloud> = OnceLock::new();

/// Sets the proxy for this process, once, at startup. Setting the same again is fine; a
/// different one is refused, so nothing later can move the token to another host.
pub fn set_mimir_cloud(base_url: &str, edition: &str, register_key: &str) -> Result<()> {
    let cloud = MimirCloud::new(base_url, edition, register_key)?;
    let set = CLOUD.get_or_init(|| cloud.clone());
    if *set == cloud {
        Ok(())
    } else {
        Err(Error::Transport(
            "mimir cloud is already set to another host".to_owned(),
        ))
    }
}

/// The proxy set at startup, if any.
pub fn mimir_cloud() -> Option<&'static MimirCloud> {
    CLOUD.get()
}

/// The stored install token, when it has the token's shape (64 hex characters).
pub(crate) fn token(src: &(impl KeySource + ?Sized)) -> Option<ApiKey> {
    src.keychain(MIMIR_CLOUD_KEYCHAIN_SERVICE, MIMIR_CLOUD_KEYCHAIN_ACCOUNT)
        .map(|t| t.trim().to_owned())
        .filter(|t| is_token(t))
        .map(ApiKey::new)
}

fn is_token(t: &str) -> bool {
    t.len() == 64
        && t.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// True when the install has a token (it registers on first use otherwise).
pub fn registered(src: &(impl KeySource + ?Sized)) -> bool {
    token(src).is_some()
}

/// One registration at a time, so parallel first requests make one install.
fn register_lock() -> &'static futures::lock::Mutex<()> {
    static LOCK: OnceLock<futures::lock::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| futures::lock::Mutex::new(()))
}

#[derive(Deserialize)]
struct Registered {
    token: String,
}

/// Registers this install for the edition and keeps the token in the keychain, replacing any
/// old one. The proxy limits new installs per network.
pub async fn register(store: &dyn SecretStore, cloud: &MimirCloud) -> Result<()> {
    let _one = register_lock().lock().await;
    register_now(store, cloud).await.map(drop)
}

async fn register_now(store: &dyn SecretStore, cloud: &MimirCloud) -> Result<ApiKey> {
    let body = serde_json::json!({ "edition": cloud.edition, "key": cloud.register_key }).to_string();
    let send = client()?
        .post(cloud.route("/register")?)
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .send();
    let response = tokio::time::timeout(CALL_TIMEOUT, send)
        .await
        .map_err(|_| Error::Transport("timed out".to_owned()))?
        .map_err(Error::transport)?;
    let status = response.status();
    let text = read_capped(response).await;
    if !status.is_success() {
        return Err(http_error(status, &text, None));
    }
    let got: Registered = serde_json::from_slice(&text)
        .map_err(|_| Error::Transport("mimir cloud sent an odd registration".to_owned()))?;
    if !is_token(&got.token) {
        return Err(Error::Transport(
            "mimir cloud sent an odd registration".to_owned(),
        ));
    }
    store.set(
        MIMIR_CLOUD_KEYCHAIN_SERVICE,
        MIMIR_CLOUD_KEYCHAIN_ACCOUNT,
        &got.token,
    )?;
    Ok(ApiKey::new(got.token))
}

/// The stored token, registering first when there is none.
async fn ensure_token(store: &dyn SecretStore, cloud: &MimirCloud) -> Result<ApiKey> {
    if let Some(t) = token(store) {
        return Ok(t);
    }
    let _one = register_lock().lock().await;
    match token(store) {
        Some(t) => Ok(t),
        None => register_now(store, cloud).await,
    }
}

/// A new token after the proxy forgot `stale`; another request may have renewed it already.
async fn renew(store: &dyn SecretStore, cloud: &MimirCloud, stale: &ApiKey) -> Result<ApiKey> {
    let _one = register_lock().lock().await;
    match token(store) {
        Some(t) if t.expose() != stale.expose() => Ok(t),
        _ => register_now(store, cloud).await,
    }
}

/// The proxy's refusal as [`Error::Http`]: its own message, which the app shows as is.
fn http_error(status: StatusCode, body: &[u8], token: Option<&ApiKey>) -> Error {
    let mut message = redact::provider_message(body, token.map(ApiKey::expose));
    if message.is_empty() {
        status
            .canonical_reason()
            .unwrap_or_default()
            .clone_into(&mut message);
    }
    Error::Http {
        status: status.as_u16(),
        message,
    }
}

/// The proxy's reason code (`unknown_install`, `install_daily`, ...), if the body has one.
fn reason(body: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    v.pointer("/error/reason")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn install_header(token: &ApiKey) -> Result<HeaderValue> {
    let mut value = HeaderValue::from_str(token.expose()).map_err(|_| Error::InvalidKey {
        provider: PROVIDER.to_owned(),
    })?;
    value.set_sensitive(true);
    Ok(value)
}

/// One call to the proxy.
struct Call {
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Option<String>,
    /// Read timeout for calls that are not streams.
    timeout: Option<Duration>,
    /// Register again when the proxy forgot the install.
    renew: bool,
}

async fn send_once(call: &Call, token: &ApiKey) -> Result<reqwest::Response> {
    let mut headers = call.headers.clone();
    headers.insert(HeaderName::from_static("x-sx-install"), install_header(token)?);
    let mut request = client()?
        .request(call.method.clone(), call.url.clone())
        .headers(headers);
    if let Some(body) = &call.body {
        request = request.body(body.clone());
    }
    if let Some(t) = call.timeout {
        request = request.timeout(t);
    }
    request.send().await.map_err(Error::transport)
}

/// Sends with the install token. When the proxy no longer knows the install (401
/// `unknown_install`), registers once more and retries once. Any other refusal (the daily
/// caps, a pause) comes back as [`Error::Http`] with the proxy's message.
async fn send(store: &dyn SecretStore, cloud: &MimirCloud, call: &Call) -> Result<reqwest::Response> {
    let mut token = ensure_token(store, cloud).await?;
    let mut renewed = false;
    loop {
        let response = send_once(call, &token).await?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let body = read_capped(response).await;
        if status == StatusCode::UNAUTHORIZED
            && call.renew
            && !renewed
            && reason(&body).as_deref() == Some("unknown_install")
        {
            token = renew(store, cloud, &token).await?;
            renewed = true;
            continue;
        }
        return Err(http_error(status, &body, Some(&token)));
    }
}

/// Sends a checked model request to the proxy and returns the streaming response.
pub(crate) async fn send_messages(
    store: &dyn SecretStore,
    cloud: &MimirCloud,
    url: Url,
    headers: HeaderMap,
    body: String,
) -> Result<reqwest::Response> {
    let call = Call {
        method: Method::POST,
        url,
        headers,
        body: Some(body),
        timeout: None,
        renew: true,
    };
    send(store, cloud, &call).await
}

/// Today's use of mimir cloud for this install, in micro-dollars, per Melbourne day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    /// The edition the install registered for.
    pub edition: String,
    /// The Melbourne day, `YYYY-MM-DD`.
    pub day: String,
    /// Spent today by this install.
    pub install_used: u64,
    /// This install's daily cap.
    pub install_cap: u64,
    /// Spent today from this network.
    pub ip_used: u64,
    /// The network's daily cap.
    pub ip_cap: u64,
    /// False when mimir cloud is paused or the edition's budget for today is used up.
    pub edition_open: bool,
}

// a missing limits row reads as nulls
#[derive(Deserialize)]
struct QuotaRow {
    edition: Option<String>,
    day: Option<String>,
    install_used: Option<u64>,
    install_cap: Option<u64>,
    ip_used: Option<u64>,
    ip_cap: Option<u64>,
    edition_open: Option<bool>,
}

async fn call_json(
    store: &dyn SecretStore,
    cloud: &MimirCloud,
    method: Method,
    tail: &str,
    renew: bool,
) -> Result<Vec<u8>> {
    let mut headers = HeaderMap::new();
    if method == Method::POST {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    let call = Call {
        body: (method == Method::POST).then(|| "{}".to_owned()),
        method,
        url: cloud.route(tail)?,
        headers,
        timeout: Some(CALL_TIMEOUT),
        renew,
    };
    let response = send(store, cloud, &call).await?;
    Ok(read_capped(response).await)
}

/// Reads today's quota (registers first when the install has no token).
pub async fn quota(store: &dyn SecretStore, cloud: &MimirCloud) -> Result<Quota> {
    let body = call_json(store, cloud, Method::GET, "/quota", true).await?;
    let row: QuotaRow = serde_json::from_slice(&body)
        .map_err(|_| Error::Transport("mimir cloud sent an odd quota".to_owned()))?;
    Ok(Quota {
        edition: row.edition.unwrap_or_default(),
        day: row.day.unwrap_or_default(),
        install_used: row.install_used.unwrap_or(0),
        install_cap: row.install_cap.unwrap_or(0),
        ip_used: row.ip_used.unwrap_or(0),
        ip_cap: row.ip_cap.unwrap_or(0),
        edition_open: row.edition_open.unwrap_or(false),
    })
}

#[derive(Deserialize)]
struct Forgotten {
    deleted: u64,
}

/// Deletes every session this install shared. Returns how many went. With no token, or one
/// the proxy no longer knows, there is nothing to delete.
pub async fn forget(store: &dyn SecretStore, cloud: &MimirCloud) -> Result<u64> {
    if token(store).is_none() {
        return Ok(0);
    }
    let body = match call_json(store, cloud, Method::POST, "/forget", false).await {
        Err(Error::Http { status: 401, .. }) => return Ok(0),
        other => other?,
    };
    let got: Forgotten = serde_json::from_slice(&body)
        .map_err(|_| Error::Transport("mimir cloud sent an odd answer".to_owned()))?;
    Ok(got.deleted)
}
