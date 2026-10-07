// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Sign in with ChatGPT: the user's ChatGPT plan pays for OpenAI requests instead of an
//! API key. Written from OpenAI's published protocol (OpenID Connect with PKCE against
//! auth.openai.com, a one-time client registered at first sign-in, a callback on
//! 127.0.0.1), not from OpenAI's SDK, whose license does not allow use in SlicerX.
//!
//! Tokens live in one keychain item ([`CHATGPT_KEYCHAIN_SERVICE`]) and nowhere else. No
//! function returns, logs or prints a token; [`Account`] is the public view.
#![allow(clippy::module_name_repetitions)]

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::Url;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::error::{Error, Result};
use crate::keys::{
    ANTHROPIC_KEYCHAIN_ACCOUNT, ANTHROPIC_KEYCHAIN_SERVICE, KeySource, LOCAL_KEYCHAIN_ACCOUNT,
    LOCAL_KEYCHAIN_SERVICE, OPENAI_KEYCHAIN_ACCOUNT, OPENAI_KEYCHAIN_SERVICE, SystemKeySource,
};

/// Keychain service of the stored ChatGPT connection (tokens and the probe result).
pub const CHATGPT_KEYCHAIN_SERVICE: &str = "slicerx-chatgpt";
/// Keychain account of the stored ChatGPT connection.
pub const CHATGPT_KEYCHAIN_ACCOUNT: &str = "slicerx";
/// Scopes: identity, a refresh token, and permission to spend the user's plan.
pub const SCOPES: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// The scope that lets requests run on the user's plan.
pub const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
/// Client id sent before OpenAI has issued one; the callback carries the issued id.
pub const REGISTRATION_CLIENT_ID: &str = "dynamic_agent_client";
/// Path of the loopback callback.
pub const CALLBACK_PATH: &str = "/auth/callback";
/// Loopback port for the callback. Fixed, because the registered client is bound to its
/// redirect URI. Next to sx-link's 47615.
pub const DEFAULT_REDIRECT_PORT: u16 = 47616;
/// Tokens are refreshed this long before they expire.
const REFRESH_MARGIN_S: u64 = 120;
/// Largest response read from the auth server or the model catalog.
const MAX_AUTH_BODY: usize = 16 * 1024 * 1024;
/// Each probe request gives up after this long; the three run at once.
const PROBE_TIMEOUT: Duration = Duration::from_secs(40);

/// Where the auth server and the API are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    /// OpenID issuer; discovery is `<issuer>/.well-known/openid-configuration`.
    pub issuer: Url,
    /// API base, also the OAuth `resource`: `https://api.openai.com/v1`.
    pub api_base: Url,
}

impl Endpoints {
    /// OpenAI's servers.
    pub fn openai() -> Result<Self> {
        Self::custom("https://auth.openai.com", "https://api.openai.com/v1")
    }

    /// Other servers. https only, except plain http on a loopback address for tests.
    pub fn custom(issuer: &str, api_base: &str) -> Result<Self> {
        let parse = |raw: &str| -> Result<Url> {
            let url = Url::parse(raw).map_err(|_| auth_err("bad endpoint URL"))?;
            let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
            if url.scheme() == "https" || (url.scheme() == "http" && loopback) {
                Ok(url)
            } else {
                Err(auth_err("endpoints must use https"))
            }
        };
        Ok(Self {
            issuer: parse(issuer)?,
            api_base: parse(api_base)?,
        })
    }

    fn api(&self, path: &str) -> String {
        format!("{}/{}", self.api_base.as_str().trim_end_matches('/'), path)
    }

    fn resource(&self) -> &str {
        self.api_base.as_str().trim_end_matches('/')
    }
}

/// A store that can also write: the OS keychain in the app, memory in tests.
pub trait SecretStore: KeySource {
    /// Creates or replaces the item.
    fn set(&self, service: &str, account: &str, value: &str) -> Result<()>;
    /// Removes the item; removing a missing item is not an error.
    fn delete(&self, service: &str, account: &str) -> Result<()>;
}

impl SecretStore for SystemKeySource {
    fn set(&self, service: &str, account: &str, value: &str) -> Result<()> {
        crate::keys::forget_refusal(service, account);
        keyring::Entry::new(service, account)
            .and_then(|e| e.set_password(value))
            .map_err(|_| Error::Transport("could not write to the keychain".to_owned()))
    }

    fn delete(&self, service: &str, account: &str) -> Result<()> {
        crate::keys::forget_refusal(service, account);
        match keyring::Entry::new(service, account).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(Error::Transport("could not remove the keychain item".to_owned())),
        }
    }
}

/// What a plan was seen to accept, from [`probe`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    /// A plain text request.
    pub text: bool,
    /// A request with a function tool.
    pub tools: bool,
    /// A request with an `input_image` part.
    pub images: bool,
    /// Model slug the probe used.
    pub model: String,
    /// Unix seconds.
    pub checked_at: u64,
}

/// Everything kept for one connection. Only ever serialized into the keychain item.
#[derive(Clone, Serialize, Deserialize)]
struct Stored {
    client_id: String,
    access_token: String,
    refresh_token: String,
    /// Unix seconds.
    expires_at: u64,
    scopes: Vec<String>,
    subject: String,
    email: Option<String>,
    name: Option<String>,
    connected_at: u64,
    capabilities: Option<Capabilities>,
}

impl std::fmt::Debug for Stored {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stored")
            .field("subject", &self.subject)
            .finish_non_exhaustive()
    }
}

/// The public view of a connection. Holds no token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Email from the ID token, when shared.
    pub email: Option<String>,
    /// Name from the ID token, when shared.
    pub name: Option<String>,
    /// True when the user granted plan usage, not just sign-in.
    pub plan_usage: bool,
    /// Unix seconds.
    pub connected_at: u64,
    /// Set after [`probe`].
    pub capabilities: Option<Capabilities>,
}

impl Stored {
    fn account(&self) -> Account {
        Account {
            email: self.email.clone(),
            name: self.name.clone(),
            plan_usage: self.scopes.iter().any(|s| s == PLAN_SCOPE),
            connected_at: self.connected_at,
            capabilities: self.capabilities.clone(),
        }
    }
}

fn auth_err(message: &str) -> Error {
    Error::Http {
        status: 0,
        message: format!("ChatGPT sign-in: {message}"),
    }
}

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn load(store: &dyn SecretStore) -> Option<Stored> {
    let raw = store.keychain(CHATGPT_KEYCHAIN_SERVICE, CHATGPT_KEYCHAIN_ACCOUNT)?;
    serde_json::from_str(&raw).ok()
}

fn save(store: &dyn SecretStore, s: &Stored) -> Result<()> {
    let raw = serde_json::to_string(s).map_err(|_| auth_err("could not save the connection"))?;
    store.set(CHATGPT_KEYCHAIN_SERVICE, CHATGPT_KEYCHAIN_ACCOUNT, &raw)
}

/// The connected account, if any.
pub fn account(store: &dyn SecretStore) -> Option<Account> {
    load(store).map(|s| s.account())
}

// API keys -------------------------------------------------------------------------

/// Saves a pasted API key in the keychain, the fallback when the plan route is not
/// available. `provider` is `openai`, `anthropic` or `local` (the optional key of a model
/// server, which can be short).
pub fn set_api_key(store: &dyn SecretStore, provider: &str, key: &str) -> Result<()> {
    let key = key.trim();
    let (service, account) = key_item(provider)?;
    let shortest = if provider == "local" { 1 } else { 20 };
    if key.len() < shortest || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(Error::InvalidKey {
            provider: provider.to_owned(),
        });
    }
    store.set(service, account, key)
}

/// Removes a saved API key.
pub fn clear_api_key(store: &dyn SecretStore, provider: &str) -> Result<()> {
    let (service, account) = key_item(provider)?;
    store.delete(service, account)
}

/// True when a pasted key is saved for `provider` (`openai`, `anthropic` or `local`).
pub fn has_api_key(store: &dyn SecretStore, provider: &str) -> Result<bool> {
    let (service, account) = key_item(provider)?;
    Ok(store
        .keychain(service, account)
        .is_some_and(|k| !k.trim().is_empty()))
}

/// Keychain service where builds before 2026-10 kept a key pasted in the desktop app: the
/// printer hub's store, with the key's own service name as the account. The model never
/// read it there.
pub const LEGACY_KEY_SERVICE: &str = "slicerx-printers";

/// Moves keys pasted into [`LEGACY_KEY_SERVICE`] to the item the model reads. A key
/// already saved in the right place wins and the old copy is dropped. Returns how many
/// old items were cleared. Errors leave the old item in place for the next try.
pub fn migrate_api_keys(store: &dyn SecretStore) -> usize {
    let mut cleared = 0;
    for provider in ["openai", "anthropic"] {
        let Ok((service, account)) = key_item(provider) else {
            continue;
        };
        let Some(old) = store.keychain(LEGACY_KEY_SERVICE, service) else {
            continue;
        };
        let has_new = store
            .keychain(service, account)
            .is_some_and(|k| !k.trim().is_empty());
        if !has_new && (old.trim().is_empty() || store.set(service, account, old.trim()).is_err()) {
            continue;
        }
        if store.delete(LEGACY_KEY_SERVICE, service).is_ok() {
            cleared += 1;
        }
    }
    cleared
}

fn key_item(provider: &str) -> Result<(&'static str, &'static str)> {
    match provider {
        "openai" => Ok((OPENAI_KEYCHAIN_SERVICE, OPENAI_KEYCHAIN_ACCOUNT)),
        "anthropic" => Ok((ANTHROPIC_KEYCHAIN_SERVICE, ANTHROPIC_KEYCHAIN_ACCOUNT)),
        "local" => Ok((LOCAL_KEYCHAIN_SERVICE, LOCAL_KEYCHAIN_ACCOUNT)),
        other => Err(Error::UnknownProvider {
            provider: other.to_owned(),
        }),
    }
}

// The one interface -------------------------------------------------------------------

/// What a request needs from the account it runs on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Needs {
    /// The request lists function tools.
    pub tools: bool,
    /// The request carries an image.
    pub images: bool,
}

impl Needs {
    /// Reads a Responses API body.
    pub fn of_body(body: &str) -> Self {
        let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
        let tools = v
            .get("tools")
            .and_then(|t| t.as_array())
            .is_some_and(|t| !t.is_empty());
        Self {
            tools,
            images: body.contains("\"input_image\""),
        }
    }
}

/// Which credential an `openai` request uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAiAuth {
    /// The user's ChatGPT plan, through the stored connection.
    ChatGptPlan,
    /// The API key in the keychain or the environment.
    ApiKey,
}

/// Picks the credential. A connected plan is the default: a probe on 2026-10-01
/// showed it takes text, tool calls, images and SlicerX's request shape. The API key is used
/// only when a probe or an earlier refusal recorded that the plan refuses something this
/// request needs, or when there is no plan. None when neither exists. At runtime, a plan
/// request that is refused falls back to the key once ([`fall_back`]).
pub fn openai_auth(store: &dyn SecretStore, needs: Needs) -> Option<OpenAiAuth> {
    let plan = load(store).filter(|s| s.scopes.iter().any(|x| x == PLAN_SCOPE));
    let key = crate::keys::openai_key(store).is_some();
    match (plan, key) {
        (Some(s), true) => {
            let refused = s
                .capabilities
                .as_ref()
                .is_some_and(|c| !c.text || (needs.tools && !c.tools) || (needs.images && !c.images));
            Some(if refused {
                OpenAiAuth::ApiKey
            } else {
                OpenAiAuth::ChatGptPlan
            })
        }
        (Some(_), false) => Some(OpenAiAuth::ChatGptPlan),
        (None, true) => Some(OpenAiAuth::ApiKey),
        (None, false) => None,
    }
}

/// True when a plan request's error should be retried once with the API key: the plan
/// refused what the request needs, the sign-in no longer works (401, 403), or the plan's
/// usage limit is reached (429). A malformed request is not retried.
pub fn fall_back(status: u16, message: &str) -> bool {
    matches!(status, 401 | 403 | 429)
        || ((400..500).contains(&status)
            && matches!(classify(status, message.to_owned()), Outcome::Refused(_)))
}

/// Records a runtime refusal, so later requests that need the same thing go to the key first.
pub fn note_refusal(store: &dyn SecretStore, needs: Needs, status: u16, message: &str) {
    if !matches!(classify(status, message.to_owned()), Outcome::Refused(_)) {
        return;
    }
    let Some(mut s) = load(store) else { return };
    let Some(c) = s.capabilities.as_mut() else { return };
    let m = message.to_ascii_lowercase();
    if needs.images && (m.contains("image") || m.contains("vision")) {
        c.images = false;
    } else if needs.tools && (m.contains("tool") || m.contains("function")) {
        c.tools = false;
    } else {
        return;
    }
    let _ = save(store, &s);
}

/// A valid access token for the plan, refreshed and saved first when it is about to expire.
/// Crate-internal: the token goes straight into a request header.
pub(crate) async fn plan_token(
    store: &dyn SecretStore,
    endpoints: &Endpoints,
) -> Result<crate::keys::ApiKey> {
    let mut s = load(store).ok_or_else(|| Error::MissingKey {
        provider: "openai".to_owned(),
    })?;
    if s.expires_at <= now_s() + REFRESH_MARGIN_S {
        s = refresh(store, endpoints, s).await?;
    }
    Ok(crate::keys::ApiKey::new(s.access_token))
}

// OAuth --------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    revocation_endpoint: Option<String>,
}

async fn discovery(endpoints: &Endpoints) -> Result<Discovery> {
    let issuer = endpoints.issuer.as_str().trim_end_matches('/');
    let body = get_json(&format!("{issuer}/.well-known/openid-configuration"), None).await?;
    let d: Discovery = serde_json::from_value(body).map_err(|_| auth_err("discovery could not be read"))?;
    // Every endpoint must be on the issuer's own origin.
    let origin = endpoints.issuer.origin();
    let same = |raw: &str| Url::parse(raw).is_ok_and(|u| u.origin() == origin);
    if d.issuer.trim_end_matches('/') != issuer
        || !same(&d.authorization_endpoint)
        || !same(&d.token_endpoint)
        || d.revocation_endpoint.as_deref().is_some_and(|r| !same(r))
    {
        return Err(auth_err("discovery did not match the issuer"));
    }
    Ok(d)
}

async fn get_json(url: &str, bearer: Option<&str>) -> Result<serde_json::Value> {
    get_json_traced(url, bearer, None).await
}

async fn get_json_traced(url: &str, bearer: Option<&str>, trace: Trace<'_>) -> Result<serde_json::Value> {
    let mut req = crate::client()?.get(url).header(ACCEPT, "application/json");
    if let Some(t) = bearer {
        let mut v = HeaderValue::from_str(&format!("Bearer {t}")).map_err(|_| auth_err("bad token"))?;
        v.set_sensitive(true);
        req = req.header(AUTHORIZATION, v);
    }
    let res = req.send().await.map_err(Error::transport)?;
    let call = format!(
        "GET {}",
        Url::parse(url).map(|u| u.path().to_owned()).unwrap_or_default()
    );
    read_body(res, trace, &call).await?.json()
}

async fn post_form(url: &str, fields: &[(&str, &str)]) -> Result<serde_json::Value> {
    // Built before any await: the serializer is not Send, and connect and disconnect must be.
    let body = {
        let mut form = form_urlencoded::Serializer::new(String::new());
        for (k, v) in fields {
            form.append_pair(k, v);
        }
        form.finish()
    };
    let res = crate::client()?
        .post(url)
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(ACCEPT, "application/json")
        .body(body)
        .send()
        .await
        .map_err(Error::transport)?;
    read_json(res).await
}

async fn read_json(res: reqwest::Response) -> Result<serde_json::Value> {
    read_body(res, None, "").await?.json()
}

/// One HTTP exchange, as `--verbose` shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallInfo {
    /// `GET /v1/models`, `POST /v1/responses (image)`.
    pub call: String,
    /// HTTP status; 0 when no answer came.
    pub status: u16,
    /// The `content-type` header, empty when missing.
    pub content_type: String,
    /// The first 200 characters of a body that is not JSON or not a success, with anything
    /// shaped like a token redacted. None otherwise.
    pub preview: Option<String>,
}

/// Receives a [`CallInfo`] for each request [`probe_with`] makes.
pub type Trace<'a> = Option<&'a (dyn Fn(&CallInfo) + Send + Sync)>;

struct Body {
    content_type: String,
    bytes: Vec<u8>,
}

impl Body {
    fn json(&self) -> Result<serde_json::Value> {
        serde_json::from_slice(&self.bytes).map_err(|_| {
            auth_err(&format!(
                "the server sent {} bytes of {}, not JSON",
                self.bytes.len(),
                if self.content_type.is_empty() {
                    "unknown type"
                } else {
                    &self.content_type
                }
            ))
        })
    }
}

/// Reads the body (up to [`MAX_AUTH_BODY`]), reports it to `trace`, and turns a non-2xx
/// status into [`Error::Http`].
async fn read_body(mut res: reqwest::Response, trace: Trace<'_>, call: &str) -> Result<Body> {
    let status = res.status();
    let content_type = res
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let mut bytes = Vec::new();
    let mut full = false;
    while let Ok(Some(c)) = res.chunk().await {
        bytes.extend_from_slice(&c);
        if bytes.len() > MAX_AUTH_BODY {
            full = true;
            break;
        }
    }
    if let Some(t) = trace {
        let json = serde_json::from_slice::<serde_json::Value>(&bytes).is_ok();
        let preview = (!json || !status.is_success()).then(|| {
            let text = String::from_utf8_lossy(bytes.get(..800).unwrap_or(&bytes)).into_owned();
            crate::redact::redact(&text, None).chars().take(200).collect()
        });
        t(&CallInfo {
            call: call.to_owned(),
            status: status.as_u16(),
            content_type: content_type.clone(),
            preview,
        });
    }
    if full {
        return Err(auth_err("the response was too large"));
    }
    if !status.is_success() {
        return Err(Error::Http {
            status: status.as_u16(),
            // Auth errors carry no tokens, but the redactor runs anyway.
            message: server_detail(&bytes),
        });
    }
    Ok(Body { content_type, bytes })
}

fn random_b64() -> Result<String> {
    use ring::rand::SecureRandom as _;
    let mut b = [0u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut b)
        .map_err(|_| auth_err("no random source"))?;
    Ok(URL_SAFE_NO_PAD.encode(b))
}

fn s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()))
}

/// Opens a URL in the user's browser. The desktop app passes its own opener.
pub type OpenUrl<'a> = &'a (dyn Fn(&str) -> Result<()> + Send + Sync);

/// How to run [`connect`].
pub struct ConnectOptions<'a> {
    /// Auth server and API.
    pub endpoints: Endpoints,
    /// Callback port on 127.0.0.1.
    pub redirect_port: u16,
    /// Shown by OpenAI when the app is registered: "SlicerX".
    pub app_name: &'a str,
    /// Opens the sign-in page.
    pub open_url: OpenUrl<'a>,
    /// How long to wait for the user to finish in the browser.
    pub timeout: Duration,
}

struct Callback {
    code: String,
    client_id: String,
}

/// Signs in through the browser and saves the connection in the keychain. Asks for plan
/// usage; the user can still decline it on OpenAI's page, which [`Account::plan_usage`]
/// then shows.
pub async fn connect(store: &dyn SecretStore, opts: &ConnectOptions<'_>) -> Result<Account> {
    let previous = load(store);
    let state = random_b64()?;
    let nonce = random_b64()?;
    let verifier = random_b64()?;
    let d = discovery(&opts.endpoints).await?;
    let listener = TcpListener::bind(("127.0.0.1", opts.redirect_port))
        .await
        .map_err(|_| auth_err("the sign-in port is in use; close the other copy of SlicerX and try again"))?;
    let port = listener
        .local_addr()
        .map_err(|_| auth_err("no callback port"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");

    let mut auth =
        Url::parse(&d.authorization_endpoint).map_err(|_| auth_err("bad authorization endpoint"))?;
    {
        let mut q = auth.query_pairs_mut();
        q.append_pair(
            "client_id",
            previous
                .as_ref()
                .map_or(REGISTRATION_CLIENT_ID, |p| p.client_id.as_str()),
        )
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", SCOPES)
        .append_pair("resource", opts.endpoints.resource())
        .append_pair("state", &state)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge_method", "S256")
        .append_pair("code_challenge", &s256(&verifier));
        if previous.is_none() {
            q.append_pair("agent_name_hint", opts.app_name);
        }
    }
    (opts.open_url)(auth.as_str())?;
    let cb = tokio::time::timeout(opts.timeout, wait_for_callback(&listener, port, &state))
        .await
        .map_err(|_| auth_err("sign-in timed out"))??;
    drop(listener);

    let data = post_form(
        &d.token_endpoint,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", &cb.client_id),
            ("code", &cb.code),
            ("code_verifier", &verifier),
            ("redirect_uri", &redirect_uri),
            ("resource", opts.endpoints.resource()),
        ],
    )
    .await?;
    let tokens = Tokens::read(&data, None)?;
    let id = id_claims(&data, &opts.endpoints, &cb.client_id, Some(&nonce))?;
    if previous.as_ref().is_some_and(|p| p.subject != id.subject) {
        // A different account: replace, but never mix two accounts' tokens.
        store.delete(CHATGPT_KEYCHAIN_SERVICE, CHATGPT_KEYCHAIN_ACCOUNT)?;
    }
    let s = Stored {
        client_id: cb.client_id,
        access_token: tokens.access,
        refresh_token: tokens.refresh,
        expires_at: tokens.expires_at,
        scopes: tokens.scopes,
        subject: id.subject,
        email: id.email,
        name: id.name,
        connected_at: now_s(),
        capabilities: None,
    };
    save(store, &s)?;
    Ok(s.account())
}

/// Reads one GET request at a time until the real callback arrives. Anything else
/// (favicon, a wrong state) gets an error page and the wait goes on.
async fn wait_for_callback(listener: &TcpListener, port: u16, state: &str) -> Result<Callback> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|_| auth_err("callback failed"))?;
        let mut buf = vec![0u8; 8192];
        let mut n = 0;
        while n < buf.len() {
            let read = sock.read(buf.get_mut(n..).unwrap_or_default()).await.unwrap_or(0);
            if read == 0 {
                break;
            }
            n += read;
            if buf
                .get(..n)
                .is_some_and(|b| b.windows(4).any(|w| w == b"\r\n\r\n"))
            {
                break;
            }
        }
        let head = String::from_utf8_lossy(buf.get(..n).unwrap_or_default()).into_owned();
        let outcome = parse_callback(&head, port, state);
        let (status, text) = match &outcome {
            Ok(_) => (
                "200 OK",
                "Signed in. You can close this tab and go back to SlicerX.",
            ),
            Err(_) => (
                "400 Bad Request",
                "This sign-in link is not valid. Go back to SlicerX and try again.",
            ),
        };
        let page = format!(
            "<!doctype html><meta charset=utf-8><title>SlicerX</title><body style=\"font:16px system-ui;padding:48px\">{text}</body>"
        );
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
            page.len()
        );
        let _ = sock.write_all(reply.as_bytes()).await;
        let _ = sock.shutdown().await;
        if let Ok(cb) = outcome {
            return Ok(cb);
        }
    }
}

fn parse_callback(head: &str, port: u16, state: &str) -> Result<Callback> {
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let mut parts = first.split(' ');
    let (method, target) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
    let host_ok = lines.any(|l| {
        l.split_once(':')
            .is_some_and(|(k, v)| k.eq_ignore_ascii_case("host") && v.trim() == format!("127.0.0.1:{port}"))
    });
    if method != "GET" || !host_ok {
        return Err(auth_err("not the callback"));
    }
    let url =
        Url::parse(&format!("http://127.0.0.1:{port}{target}")).map_err(|_| auth_err("bad callback"))?;
    if url.path() != CALLBACK_PATH {
        return Err(auth_err("not the callback"));
    }
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let one = |k: &str| -> Option<String> {
        let mut it = pairs.iter().filter(|(n, _)| n == k);
        let v = it.next()?.1.clone();
        it.next().is_none().then_some(v)
    };
    let got_state = one("state").unwrap_or_default();
    if !same_secret(got_state.as_bytes(), state.as_bytes()) {
        return Err(auth_err("state did not match"));
    }
    if one("error").is_some() {
        return Err(auth_err("sign-in was canceled or refused"));
    }
    let code = one("code")
        .filter(|c| !c.is_empty())
        .ok_or_else(|| auth_err("no code"))?;
    let client_id = one("client_id")
        .filter(|c| !c.is_empty())
        .ok_or_else(|| auth_err("OpenAI did not finish registering the app; try again"))?;
    Ok(Callback { code, client_id })
}

/// Compares without stopping at the first difference.
fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

struct Tokens {
    access: String,
    refresh: String,
    expires_at: u64,
    scopes: Vec<String>,
}

impl Tokens {
    fn read(data: &serde_json::Value, previous: Option<&Stored>) -> Result<Self> {
        let s = |k: &str| {
            data.get(k)
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        let access = s("access_token").ok_or_else(|| auth_err("no access token"))?;
        let refresh = s("refresh_token")
            .or_else(|| previous.map(|p| p.refresh_token.clone()))
            .ok_or_else(|| auth_err("no refresh token"))?;
        let expires_in = data
            .get("expires_in")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(3600);
        // OAuth may leave scope out on refresh when it did not change.
        let scopes = s("scope").map_or_else(
            || previous.map(|p| p.scopes.clone()).unwrap_or_default(),
            |v| v.split_whitespace().map(str::to_owned).collect(),
        );
        Ok(Self {
            access,
            refresh,
            expires_at: now_s() + expires_in,
            scopes,
        })
    }
}

struct Identity {
    subject: String,
    email: Option<String>,
    name: Option<String>,
}

/// Claims of the ID token. Its signature is not checked: it came straight from the token
/// endpoint over TLS, which OpenID Connect Core 3.1.3.7 accepts in place of the signature.
/// The issuer, audience, expiry and nonce are checked.
fn id_claims(
    data: &serde_json::Value,
    endpoints: &Endpoints,
    client_id: &str,
    nonce: Option<&str>,
) -> Result<Identity> {
    let raw = data
        .get("id_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| auth_err("no ID token"))?;
    let payload = raw.split('.').nth(1).ok_or_else(|| auth_err("bad ID token"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| auth_err("bad ID token"))?;
    let c: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| auth_err("bad ID token"))?;
    let s = |k: &str| c.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    let aud_ok = match c.get("aud") {
        Some(serde_json::Value::String(a)) => a == client_id,
        Some(serde_json::Value::Array(a)) => a.iter().any(|x| x.as_str() == Some(client_id)),
        _ => false,
    };
    let exp = c.get("exp").and_then(serde_json::Value::as_u64).unwrap_or(0);
    let issuer = endpoints.issuer.as_str().trim_end_matches('/');
    if s("iss").as_deref().map(|i| i.trim_end_matches('/')) != Some(issuer)
        || !aud_ok
        || exp + 300 < now_s()
        || nonce.is_some_and(|n| s("nonce").as_deref() != Some(n))
    {
        return Err(auth_err("the identity could not be verified"));
    }
    let subject = s("sub")
        .filter(|x| !x.is_empty())
        .ok_or_else(|| auth_err("no account id"))?;
    Ok(Identity {
        subject,
        email: s("email"),
        name: s("name"),
    })
}

async fn refresh(store: &dyn SecretStore, endpoints: &Endpoints, s: Stored) -> Result<Stored> {
    let d = discovery(endpoints).await?;
    let data = post_form(
        &d.token_endpoint,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", &s.client_id),
            ("refresh_token", &s.refresh_token),
            ("resource", endpoints.resource()),
        ],
    )
    .await?;
    let tokens = Tokens::read(&data, Some(&s))?;
    if data.get("id_token").is_some() {
        let id = id_claims(&data, endpoints, &s.client_id, None)?;
        if id.subject != s.subject {
            return Err(auth_err(
                "the refreshed sign-in is a different account; sign in again",
            ));
        }
    }
    let next = Stored {
        access_token: tokens.access,
        refresh_token: tokens.refresh,
        expires_at: tokens.expires_at,
        scopes: tokens.scopes,
        ..s
    };
    save(store, &next)?;
    Ok(next)
}

/// Signs out: revokes the refresh token when the server allows it, and always removes the
/// keychain item. An error means the local item is gone but OpenAI could not confirm the
/// revocation; the user can disconnect the app in ChatGPT's settings.
pub async fn disconnect(store: &dyn SecretStore, endpoints: &Endpoints) -> Result<()> {
    let Some(s) = load(store) else { return Ok(()) };
    store.delete(CHATGPT_KEYCHAIN_SERVICE, CHATGPT_KEYCHAIN_ACCOUNT)?;
    let d = discovery(endpoints).await?;
    let Some(url) = d.revocation_endpoint else {
        return Err(auth_err(
            "revocation is not offered; disconnect SlicerX in ChatGPT settings",
        ));
    };
    post_form(
        &url,
        &[
            ("token", &s.refresh_token),
            ("token_type_hint", "refresh_token"),
            ("client_id", &s.client_id),
        ],
    )
    .await
    .map(|_| ())
    .or_else(|e| match e {
        // Revocation answers 200 with an empty body, which is not JSON.
        Error::Http { status: 0, .. } => Ok(()),
        other => Err(other),
    })
}

// Probe ----------------------------------------------------------------------------------

/// An 8 by 8 red PNG.
const PROBE_PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

/// Sends three small requests on the plan (text, a function tool, an image) and saves
/// which ones it accepted. Each asks for at most 16 output tokens; they run at once.
pub async fn probe(store: &dyn SecretStore, endpoints: &Endpoints) -> Result<Capabilities> {
    probe_with(store, endpoints, None).await.map(|r| r.caps)
}

/// How one probe request went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The plan answered it.
    Accepted,
    /// The plan refused what the request tried (images, tools), with the server's words.
    Refused(String),
    /// The request itself was malformed for this route (a parameter or shape), with the
    /// server's words. Says nothing about what the plan can do.
    RequestError(String),
    /// No answer within the time limit, or no connection.
    NoAnswer,
}

/// [`probe_with`]'s result: the saved [`Capabilities`] and how each request went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeReport {
    /// What was saved: true only for [`Outcome::Accepted`].
    pub caps: Capabilities,
    /// The text request.
    pub text: Outcome,
    /// The function tool request.
    pub tools: Outcome,
    /// The image request.
    pub images: Outcome,
    /// A request shaped exactly as SlicerX's adapter sends one (developer message, tools,
    /// `tool_choice`, `parallel_tool_calls`, `reasoning`, `include`).
    pub app_shape: Outcome,
    /// Every model the plan lists, with the hints the listing gives.
    pub models: Vec<ModelInfo>,
    /// The models mimir would use for each tier, when the hints allow a choice.
    pub tiers: Result<Tiers, String>,
}

/// Name of the quick-look tier: the small, fast vision model for check-ins and frame reads.
pub const HUGINN: &str = "huginn";
/// Name of the deep-think tier: the large model for diagnosis, tuning and planning.
pub const MUNINN: &str = "muninn";

/// One model from the plan's listing. `hints` holds every other field as text, flattened
/// one level (`input_modalities = text|image`, `pricing.input = 0.4`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// The id requests use.
    pub slug: String,
    /// The name the listing shows, when it gives one.
    pub display_name: Option<String>,
    /// Shown in pickers (`visibility` is `list` or missing).
    pub listed: bool,
    /// Every other field, as text.
    pub hints: std::collections::BTreeMap<String, String>,
}

/// The models for mimir's two tiers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Tiers {
    /// Quick looks: check-ins and frame reads.
    pub huginn: String,
    /// Deep thinking: diagnosis, tune-from-failure, planning.
    pub muninn: String,
    /// Which hint decided.
    pub by: String,
}

fn hint_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Array(a) => Some(a.iter().filter_map(hint_text).collect::<Vec<_>>().join("|")),
        _ => None,
    }
}

/// Hints longer than this (the listing carries whole instruction texts) are dropped.
const MAX_HINT: usize = 200;

/// The listing as [`ModelInfo`], from `{models: [...]}` or a plain `{data: [...]}`.
pub fn list_models(v: &serde_json::Value) -> Vec<ModelInfo> {
    let (items, id_key) = match (
        v.get("models").and_then(|m| m.as_array()),
        v.get("data").and_then(|m| m.as_array()),
    ) {
        (Some(m), _) => (m, "slug"),
        (None, Some(d)) => (d, "id"),
        (None, None) => return Vec::new(),
    };
    items
        .iter()
        .filter_map(|m| {
            let o = m.as_object()?;
            let slug = o.get(id_key)?.as_str()?.to_owned();
            let mut hints = std::collections::BTreeMap::new();
            for (k, val) in o {
                if k == id_key || k == "display_name" {
                    continue;
                }
                if let serde_json::Value::Object(inner) = val {
                    for (k2, v2) in inner {
                        if let Some(t) = hint_text(v2).filter(|t| t.len() <= MAX_HINT) {
                            hints.insert(format!("{k}.{k2}"), t);
                        }
                    }
                } else if let Some(t) = hint_text(val).filter(|t| t.len() <= MAX_HINT) {
                    hints.insert(k.clone(), t);
                }
            }
            Some(ModelInfo {
                listed: o
                    .get("visibility")
                    .and_then(|v| v.as_str())
                    .is_none_or(|v| v == "list"),
                display_name: o.get("display_name").and_then(|v| v.as_str()).map(str::to_owned),
                slug,
                hints,
            })
        })
        .collect()
}

/// The models the connected plan offers, for the Model setting.
pub async fn plan_models(store: &dyn SecretStore, endpoints: &Endpoints) -> Result<Vec<ModelInfo>> {
    let token = plan_token(store, endpoints).await?;
    let listing = tokio::time::timeout(
        PROBE_TIMEOUT,
        get_json(&endpoints.api("models"), Some(token.expose())),
    )
    .await
    .map_err(|_| auth_err("the model list did not come back in time"))??;
    Ok(list_models(&listing))
}

/// Picks huginn and muninn from the listing's own hints, never from model names: the
/// cheapest and the dearest by a price hint, else the smallest and largest by a size or
/// parameter hint, else the fastest and slowest by a speed or latency hint. huginn must
/// take images when the listing says what each model takes. An error says what is missing.
pub fn pick_tiers(models: &[ModelInfo]) -> Result<Tiers, String> {
    let listed: Vec<&ModelInfo> = models.iter().filter(|m| m.listed).collect();
    if listed.is_empty() {
        return Err("the plan lists no models".to_owned());
    }
    let vision_known = listed.iter().any(|m| {
        m.hints
            .iter()
            .any(|(k, _)| k.contains("modalit") || k.contains("input_types"))
    });
    let takes_images = |m: &&ModelInfo| {
        !vision_known
            || m.hints
                .iter()
                .any(|(k, v)| (k.contains("modalit") || k.contains("input_types")) && v.contains("image"))
    };
    let number = |m: &ModelInfo, keys: &[&str]| -> Option<(String, f64)> {
        m.hints.iter().find_map(|(k, v)| {
            let lk = k.to_ascii_lowercase();
            if keys.iter().any(|w| lk.contains(w)) {
                v.parse::<f64>().ok().map(|n| (k.clone(), n))
            } else {
                None
            }
        })
    };
    // Lower is quicker and cheaper for price and size; for speed a higher number is quicker
    // unless the hint is a latency.
    for (keys, quick_is_low) in [
        (&["pric", "cost", "credit"][..], true),
        (&["param", "size"][..], true),
        (&["latency"][..], true),
        (&["speed", "tokens_per_second"][..], false),
    ] {
        let scored: Vec<(&ModelInfo, String, f64)> = listed
            .iter()
            .filter_map(|m| number(m, keys).map(|(k, n)| (*m, k, n)))
            .collect();
        if scored.len() < listed.len() || scored.len() < 2 {
            continue;
        }
        let order = |a: &(&ModelInfo, String, f64), b: &(&ModelInfo, String, f64)| a.2.total_cmp(&b.2);
        let quick = scored
            .iter()
            .filter(|(m, ..)| takes_images(m))
            .min_by(|a, b| if quick_is_low { order(a, b) } else { order(b, a) });
        let deep = scored
            .iter()
            .max_by(|a, b| if quick_is_low { order(a, b) } else { order(b, a) });
        if let (Some(q), Some(d)) = (quick, deep) {
            return Ok(Tiers {
                huginn: q.0.slug.clone(),
                muninn: d.0.slug.clone(),
                by: q.1.clone(),
            });
        }
    }
    Err("the listing has no price, size or speed hint for every model, so a person has to choose".to_owned())
}

/// The server's message from an error body: `detail`, `error.message`, `error` or `message`.
fn server_detail(bytes: &[u8]) -> String {
    let v: serde_json::Value = serde_json::from_slice(bytes).unwrap_or_default();
    let found = v
        .get("detail")
        .and_then(|d| d.as_str())
        .or_else(|| v.pointer("/error/message").and_then(|d| d.as_str()))
        .or_else(|| v.get("error").and_then(|d| d.as_str()))
        .or_else(|| v.get("message").and_then(|d| d.as_str()))
        .map_or_else(|| String::from_utf8_lossy(bytes).into_owned(), str::to_owned);
    crate::redact::redact(&found, None).chars().take(300).collect()
}

/// A refusal of the capability (images, tools) as opposed to a malformed request.
pub(crate) fn classify(status: u16, detail: String) -> Outcome {
    let d = detail.to_ascii_lowercase();
    let about_capability = ["image", "vision", "tool", "function"]
        .iter()
        .any(|w| d.contains(w));
    let refused = [
        "not supported",
        "not available",
        "not allowed",
        "unsupported",
        "disabled",
        "not enabled",
    ]
    .iter()
    .any(|w| d.contains(w));
    if status == 403 || (about_capability && refused && !d.contains("parameter")) {
        Outcome::Refused(detail)
    } else {
        Outcome::RequestError(detail)
    }
}

/// Makes a Responses body the plan route takes: `input` as a list of message items, and no
/// `max_output_tokens`. Used by the transport for every request it sends on the plan.
pub fn plan_body(body: &str) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(body) else {
        return body.to_owned();
    };
    if let Some(o) = v.as_object_mut() {
        o.remove("max_output_tokens");
        if let Some(text) = o.get("input").and_then(|i| i.as_str()).map(str::to_owned) {
            o.insert(
                "input".into(),
                serde_json::json!([{ "role": "user", "content": [{ "type": "input_text", "text": text }] }]),
            );
        }
    }
    v.to_string()
}

/// [`probe`], reporting every HTTP exchange to `trace`.
pub async fn probe_with(
    store: &dyn SecretStore,
    endpoints: &Endpoints,
    trace: Trace<'_>,
) -> Result<ProbeReport> {
    probe_model(store, endpoints, trace, None).await
}

/// [`probe_with`] on a chosen model instead of the one the hints pick.
pub async fn probe_model(
    store: &dyn SecretStore,
    endpoints: &Endpoints,
    trace: Trace<'_>,
    chosen: Option<&str>,
) -> Result<ProbeReport> {
    let token = plan_token(store, endpoints).await?;
    let listing = tokio::time::timeout(
        PROBE_TIMEOUT,
        get_json_traced(&endpoints.api("models"), Some(token.expose()), trace),
    )
    .await
    .map_err(|_| auth_err("the model list did not come back in time"))??;
    let models = list_models(&listing);
    let tiers = pick_tiers(&models);
    // The checks run on huginn when the hints name one, since most requests would use it.
    let model = match (chosen, &tiers) {
        (Some(m), _) => m.to_owned(),
        (None, Ok(t)) => t.huginn.clone(),
        (None, Err(_)) => pick_model(&listing).ok_or_else(|| auth_err("the plan lists no models"))?,
    };
    // Streaming, as OpenAI's own client always calls the plan route.
    // The plan route takes `input` only as a list of message items and refuses
    // `max_output_tokens` (seen 2026-10-01), so the probe asks for one-word answers instead.
    let say = |text: &str| serde_json::json!([{ "role": "user", "content": [{ "type": "input_text", "text": text }] }]);
    let base = |input: serde_json::Value| serde_json::json!({ "model": model, "input": input, "store": false, "stream": true });
    let text = base(say("Reply with the word ok."));
    let mut tools = base(say("Call the ping tool."));
    if let Some(o) = tools.as_object_mut() {
        o.insert(
            "tools".into(),
            serde_json::json!([{ "type": "function", "name": "ping", "description": "Answers pong.", "parameters": { "type": "object", "properties": {} } }]),
        );
    }
    let image = base(serde_json::json!([{ "role": "user", "content": [
        { "type": "input_text", "text": "What color is this square? One word." },
        { "type": "input_image", "image_url": format!("data:image/png;base64,{PROBE_PNG}") }
    ] }]));
    // The body SlicerX's own adapter sends (packages/pilot/src/provider/openai.ts), after
    // plan_body, so a pass here means the app's requests pass too.
    let app: serde_json::Value = serde_json::from_str(&plan_body(
        &serde_json::json!({
            "model": model,
            "input": [
                { "role": "developer", "content": "Answer in one word." },
                { "role": "user", "content": "Call the ping tool." }
            ],
            "stream": true,
            "store": false,
            "tools": [{ "type": "function", "name": "ping", "description": "Answers pong.", "parameters": { "type": "object", "properties": {} }, "strict": false }],
            "tool_choice": "auto",
            "parallel_tool_calls": true,
            "reasoning": { "effort": "low", "summary": "auto" },
            "include": ["reasoning.encrypted_content"]
        })
        .to_string(),
    ))
    .unwrap_or_default();
    let url = endpoints.api("responses");
    let t = token.expose();
    let (text, tools, images, app) = futures::join!(
        accepted(&url, t, &text, trace, "POST /v1/responses (text)"),
        accepted(&url, t, &tools, trace, "POST /v1/responses (tool call)"),
        accepted(&url, t, &image, trace, "POST /v1/responses (image)"),
        accepted(&url, t, &app, trace, "POST /v1/responses (SlicerX request shape)"),
    );
    let caps = Capabilities {
        text: text == Outcome::Accepted,
        tools: tools == Outcome::Accepted,
        images: images == Outcome::Accepted,
        model,
        checked_at: now_s(),
    };
    if let Some(mut s) = load(store) {
        s.capabilities = Some(caps.clone());
        save(store, &s)?;
    }
    Ok(ProbeReport {
        caps,
        text,
        tools,
        images,
        app_shape: app,
        models,
        tiers,
    })
}

/// The first model the plan lists. The plan route answers `{models: [{slug, visibility}]}`;
/// a plain API `{data: [{id}]}` list is read too.
pub(crate) fn pick_model(v: &serde_json::Value) -> Option<String> {
    let listed = v.get("models").and_then(|m| m.as_array()).and_then(|m| {
        m.iter()
            .filter(|x| {
                x.get("visibility")
                    .and_then(|v| v.as_str())
                    .is_none_or(|v| v == "list")
            })
            .find_map(|x| x.get("slug").and_then(|v| v.as_str()))
    });
    let plain = || {
        v.get("data")
            .and_then(|m| m.as_array())
            .and_then(|m| m.iter().find_map(|x| x.get("id").and_then(|v| v.as_str())))
    };
    listed.or_else(plain).map(str::to_owned)
}

/// How the API answered: accepted when a 2xx stream completed (or stopped at the token
/// limit) with no error event.
async fn accepted(url: &str, token: &str, body: &serde_json::Value, trace: Trace<'_>, call: &str) -> Outcome {
    let send = async {
        let mut v = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| auth_err("bad token"))?;
        v.set_sensitive(true);
        crate::client()?
            .post(url)
            .header(AUTHORIZATION, v)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "text/event-stream")
            .body(body.to_string())
            .send()
            .await
            .map_err(Error::transport)
    };
    let res = match tokio::time::timeout(PROBE_TIMEOUT, send).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => return Outcome::NoAnswer,
        Err(_) => {
            if let Some(t) = trace {
                t(&CallInfo {
                    call: call.to_owned(),
                    status: 0,
                    content_type: String::new(),
                    preview: Some(format!("no answer within {} s", PROBE_TIMEOUT.as_secs())),
                });
            }
            return Outcome::NoAnswer;
        }
    };
    let status = res.status().as_u16();
    match tokio::time::timeout(PROBE_TIMEOUT, read_body(res, trace, call)).await {
        Ok(Ok(b)) => match stream_error(&b.bytes) {
            Some(detail) => classify(status, detail),
            None if stream_ok(&b.bytes) => Outcome::Accepted,
            None => Outcome::RequestError("the answer never completed".to_owned()),
        },
        Ok(Err(Error::Http { status, message })) => classify(status, message),
        Ok(Err(_)) | Err(_) => Outcome::NoAnswer,
    }
}

/// The message of an `error` or `response.failed` event in a stream, if there is one.
fn stream_error(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes).lines().find_map(|line| {
        let ev: serde_json::Value = serde_json::from_str(line.strip_prefix("data:")?.trim()).ok()?;
        match ev.get("type").and_then(|t| t.as_str()) {
            Some("error" | "response.failed") => {
                Some(server_detail(line.strip_prefix("data:")?.trim().as_bytes())).map(|d| {
                    if d.is_empty() {
                        "the stream reported an error".to_owned()
                    } else {
                        d
                    }
                })
            }
            _ => None,
        }
    })
}

/// Reads a Responses SSE stream (or a plain JSON response): accepted when it reached
/// `response.completed` or `response.incomplete` and carried no error.
pub(crate) fn stream_ok(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let mut done = false;
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(ev) = serde_json::from_str::<serde_json::Value>(data.trim()) else {
            continue;
        };
        match ev.get("type").and_then(|t| t.as_str()) {
            Some("error" | "response.failed") => return false,
            Some("response.completed" | "response.incomplete") => done = true,
            _ => {}
        }
    }
    if done {
        return true;
    }
    serde_json::from_slice::<serde_json::Value>(bytes).is_ok_and(|v| {
        matches!(
            v.get("status").and_then(|s| s.as_str()),
            Some("completed" | "incomplete")
        )
    })
}

/// Decodes the probe image, so a test can check it is a real PNG.
#[cfg(test)]
pub(crate) fn probe_png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(PROBE_PNG)
        .unwrap_or_default()
}

// Frame judging ---------------------------------------------------------------------------

/// What huginn said about one frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FrameVerdict {
    /// The print has failed or is failing.
    pub failed: bool,
    /// `spaghetti`, `nozzle_blob`, `detached`, `other` or `none`.
    pub kind: String,
    /// 0 to 1, the model's own estimate.
    pub confidence: f64,
}

/// The question asked about a frame. Fixed, so answers are comparable across frames.
pub const JUDGE_PROMPT: &str = "This is a camera frame of a 3D printer. Has the print failed or is it failing? Count only clear failures: loose tangled filament (spaghetti), a part knocked loose or fallen over, or a large blob of plastic on the nozzle. Stringing, small blobs, zits and rough surfaces are not failures. Answer only with JSON: {\"failed\": true or false, \"kind\": \"spaghetti\" | \"nozzle_blob\" | \"detached\" | \"other\" | \"none\", \"confidence\": 0 to 1}.";

/// The text of a Responses stream: every `response.output_text.delta`, joined.
pub(crate) fn stream_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter_map(|line| {
            let ev: serde_json::Value = serde_json::from_str(line.strip_prefix("data:")?.trim()).ok()?;
            (ev.get("type").and_then(|t| t.as_str()) == Some("response.output_text.delta")).then(|| {
                ev.get("delta")
                    .and_then(|d| d.as_str())
                    .unwrap_or_default()
                    .to_owned()
            })
        })
        .collect()
}

/// Reads the verdict from the model's answer, tolerating text around the JSON.
pub(crate) fn parse_verdict(text: &str) -> Option<FrameVerdict> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    let v: serde_json::Value = serde_json::from_str(text.get(start..=end)?).ok()?;
    Some(FrameVerdict {
        failed: v.get("failed")?.as_bool()?,
        kind: v
            .get("kind")
            .and_then(|k| k.as_str())
            .unwrap_or("other")
            .to_owned(),
        confidence: v
            .get("confidence")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.5)
            .clamp(0.0, 1.0),
    })
}

/// Asks `model` on the connected plan whether the print in one frame has failed. One request,
/// one frame; the caller decides when (only on a local suspicion, never continuously).
pub async fn judge_frame(
    store: &dyn SecretStore,
    endpoints: &Endpoints,
    model: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<FrameVerdict> {
    let token = plan_token(store, endpoints).await?;
    let image = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    let body = serde_json::json!({
        "model": model,
        "input": [{ "role": "user", "content": [
            { "type": "input_text", "text": JUDGE_PROMPT },
            { "type": "input_image", "image_url": image }
        ] }],
        "store": false,
        "stream": true
    });
    let mut v =
        HeaderValue::from_str(&format!("Bearer {}", token.expose())).map_err(|_| auth_err("bad token"))?;
    v.set_sensitive(true);
    let send = async {
        let res = crate::client()?
            .post(endpoints.api("responses"))
            .header(AUTHORIZATION, v)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "text/event-stream")
            .body(body.to_string())
            .send()
            .await
            .map_err(Error::transport)?;
        read_body(res, None, "POST /v1/responses (judge)").await
    };
    let b = tokio::time::timeout(PROBE_TIMEOUT, send)
        .await
        .map_err(|_| auth_err("no answer in time"))??;
    if let Some(detail) = stream_error(&b.bytes) {
        return Err(Error::Http {
            status: 0,
            message: detail,
        });
    }
    let text = stream_text(&b.bytes);
    parse_verdict(&text).ok_or_else(|| auth_err("the answer was not the expected JSON"))
}
