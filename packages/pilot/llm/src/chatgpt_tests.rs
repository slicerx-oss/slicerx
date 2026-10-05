// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Sign in with ChatGPT against a mock auth server and API on 127.0.0.1. No real
//! account, browser, keychain or network.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::chatgpt::*;
use super::{KeySource, OPENAI_KEYCHAIN_ACCOUNT, OPENAI_KEYCHAIN_SERVICE};

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
    fn raw(&self) -> String {
        self.keychain(CHATGPT_KEYCHAIN_SERVICE, CHATGPT_KEYCHAIN_ACCOUNT)
            .unwrap_or_default()
    }
}

#[derive(Default)]
struct Mock {
    base: String,
    nonce: String,
    challenge: String,
    refreshes: usize,
    revoked: Vec<String>,
    auth_headers: Vec<String>,
    /// Requests to /v1/responses with an image are refused, as a plan without vision would.
    refuse_images: bool,
}

fn jwt(claims: &serde_json::Value) -> String {
    let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let p = URL_SAFE_NO_PAD.encode(claims.to_string());
    format!("{h}.{p}.c2ln")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn form(body: &str) -> HashMap<String, String> {
    form_urlencoded::parse(body.as_bytes()).into_owned().collect()
}

/// Answers one request like the auth server and API would.
fn route(m: &mut Mock, first: &str, body: &str, auth: Option<String>) -> (u16, String) {
    if let Some(a) = auth {
        m.auth_headers.push(a);
    }
    let base = m.base.clone();
    if first.starts_with("GET /.well-known/openid-configuration") {
        (200, serde_json::json!({ "issuer": base, "authorization_endpoint": format!("{base}/oauth/authorize"), "token_endpoint": format!("{base}/oauth/token"), "revocation_endpoint": format!("{base}/oauth/revoke") }).to_string())
    } else if first.starts_with("POST /oauth/token") {
        let f = form(body);
        match f.get("grant_type").map(String::as_str) {
            Some("authorization_code") => {
                let pkce = URL_SAFE_NO_PAD.encode(ring::digest::digest(
                    &ring::digest::SHA256,
                    f.get("code_verifier").unwrap().as_bytes(),
                ));
                if f.get("code").map(String::as_str) != Some("good-code")
                    || pkce != m.challenge
                    || f.get("client_id").map(String::as_str) != Some("client-123")
                {
                    (400, r#"{"error":"invalid_grant"}"#.to_owned())
                } else {
                    let id = jwt(
                        &serde_json::json!({ "iss": base, "aud": "client-123", "exp": now() + 3600, "iat": now(), "nonce": m.nonce, "sub": "user-1", "email": "maker@example.com" }),
                    );
                    (200, serde_json::json!({ "access_token": "access-1", "refresh_token": "refresh-1", "expires_in": 3600, "scope": SCOPES, "id_token": id }).to_string())
                }
            }
            Some("refresh_token") if f.get("refresh_token").map(String::as_str) == Some("refresh-1") => {
                m.refreshes += 1;
                (
                    200,
                    r#"{"access_token":"access-2","refresh_token":"refresh-2","expires_in":3600}"#.to_owned(),
                )
            }
            _ => (400, r#"{"error":"invalid_grant"}"#.to_owned()),
        }
    } else if first.starts_with("POST /oauth/revoke") {
        m.revoked
            .push(form(body).get("token").cloned().unwrap_or_default());
        (200, String::new())
    } else if first.starts_with("GET /v1/models") {
        (200, r#"{"models":[{"slug":"hidden","display_name":"Hidden","visibility":"hide"},{"slug":"gpt-test","display_name":"GPT test","visibility":"list"}]}"#.to_owned())
    } else if first.starts_with("POST /v1/responses") {
        let req: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
        if req.get("max_output_tokens").is_some() {
            (
                400,
                r#"{"detail":"Unsupported parameter: max_output_tokens"}"#.to_owned(),
            )
        } else if !req.get("input").is_some_and(serde_json::Value::is_array) {
            (400, r#"{"detail":"Input must be a list"}"#.to_owned())
        } else if body.contains("Has the print failed") {
            (200, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Looks bad: {\\\"failed\\\": true, \"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"\\\"kind\\\": \\\"spaghetti\\\", \\\"confidence\\\": 0.9}\"}\n\ndata: {\"type\":\"response.completed\"}\n\n".to_owned())
        } else if m.refuse_images && body.contains("input_image") {
            (
                400,
                r#"{"detail":"Image input is not supported on this plan."}"#.to_owned(),
            )
        } else {
            (200, "event: response.created\ndata: {\"type\":\"response.created\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\"}\n\n".to_owned())
        }
    } else {
        (404, "{}".to_owned())
    }
}

async fn serve(mock: Arc<Mutex<Mock>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    mock.lock().unwrap().base.clone_from(&base);
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mock = mock.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                // Read the head, then Content-Length bytes of body.
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
                let first = head.lines().next().unwrap_or_default().to_owned();
                let auth = head.lines().find_map(|l| {
                    l.to_ascii_lowercase()
                        .starts_with("authorization:")
                        .then(|| l[14..].trim().to_owned())
                });
                let (status, reply) = route(&mut mock.lock().unwrap(), &first, &body, auth);
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

/// A browser's GET, over plain TCP. Returns the status line.
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
    out.lines().next().unwrap_or_default().to_owned()
}

async fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Plays the browser: reads the authorize URL, records what the server would, and sends
/// the callbacks given (each as (state override, code)).
fn browser(mock: Arc<Mutex<Mock>>, forged_first: bool) -> impl Fn(&str) -> crate::Result<()> + Send + Sync {
    move |url: &str| {
        let u = reqwest::Url::parse(url).unwrap();
        let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], REGISTRATION_CLIENT_ID);
        assert_eq!(q["scope"], SCOPES);
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["agent_name_hint"], "SlicerX");
        {
            let mut m = mock.lock().unwrap();
            m.nonce.clone_from(&q["nonce"]);
            m.challenge.clone_from(&q["code_challenge"]);
        }
        let redirect = q["redirect_uri"].clone();
        let state = q["state"].clone();
        tokio::spawn(async move {
            if forged_first {
                let status = get(&format!("{redirect}?code=evil&state=wrong&client_id=client-123")).await;
                assert!(status.starts_with("HTTP/1.1 400"), "{status}");
            }
            let status = get(&format!(
                "{redirect}?code=good-code&state={state}&client_id=client-123"
            ))
            .await;
            assert!(status.starts_with("HTTP/1.1 200"), "{status}");
        });
        Ok(())
    }
}

async fn connected(
    refuse_images: bool,
    forged_first: bool,
) -> (MemStore, Endpoints, Arc<Mutex<Mock>>, Account) {
    let mock = Arc::new(Mutex::new(Mock {
        refuse_images,
        ..Mock::default()
    }));
    let base = serve(mock.clone()).await;
    let endpoints = Endpoints::custom(&base, &format!("{base}/v1")).unwrap();
    let store = MemStore::default();
    let open = browser(mock.clone(), forged_first);
    let opts = ConnectOptions {
        endpoints: endpoints.clone(),
        redirect_port: free_port().await,
        app_name: "SlicerX",
        open_url: &open,
        timeout: Duration::from_secs(10),
    };
    let account = connect(&store, &opts).await.unwrap();
    (store, endpoints, mock, account)
}

#[tokio::test]
async fn signs_in_and_keeps_tokens_only_in_the_store() {
    let (store, _, _, account) = connected(false, false).await;
    assert_eq!(account.email.as_deref(), Some("maker@example.com"));
    assert!(account.plan_usage);
    let public = serde_json::to_string(&account).unwrap();
    assert!(!public.contains("access-1") && !public.contains("refresh-1"));
    assert!(!format!("{account:?}").contains("access-1"));
    assert!(store.raw().contains("access-1"));
}

#[tokio::test]
async fn ignores_a_forged_callback_and_waits_for_the_real_one() {
    let (_, _, _, account) = connected(false, true).await;
    assert!(account.plan_usage);
}

#[tokio::test]
async fn probe_records_what_the_plan_accepts() {
    let (store, endpoints, mock, _) = connected(true, false).await;
    let caps = probe(&store, &endpoints).await.unwrap();
    assert_eq!((caps.text, caps.tools, caps.images), (true, true, false));
    assert_eq!(caps.model, "gpt-test");
    assert!(
        mock.lock()
            .unwrap()
            .auth_headers
            .iter()
            .any(|h| h == "Bearer access-1")
    );
    assert_eq!(account(&store).unwrap().capabilities, Some(caps));
}

#[tokio::test]
async fn picks_the_plan_only_for_what_it_accepts() {
    let (store, endpoints, _, _) = connected(true, false).await;
    // Before a probe, with no key, the plan is tried.
    assert_eq!(
        openai_auth(&store, Needs::default()),
        Some(OpenAiAuth::ChatGptPlan)
    );
    store
        .set(
            OPENAI_KEYCHAIN_SERVICE,
            OPENAI_KEYCHAIN_ACCOUNT,
            "sk-test-0123456789abcdefghij",
        )
        .unwrap();
    // A key and no probe yet: the plan is the default.
    assert_eq!(
        openai_auth(
            &store,
            Needs {
                tools: true,
                images: true
            }
        ),
        Some(OpenAiAuth::ChatGptPlan)
    );
    probe(&store, &endpoints).await.unwrap();
    assert_eq!(
        openai_auth(
            &store,
            Needs {
                tools: true,
                images: false
            }
        ),
        Some(OpenAiAuth::ChatGptPlan)
    );
    assert_eq!(
        openai_auth(
            &store,
            Needs {
                tools: true,
                images: true
            }
        ),
        Some(OpenAiAuth::ApiKey)
    );
    let empty = MemStore::default();
    assert_eq!(openai_auth(&empty, Needs::default()), None);
}

#[tokio::test]
async fn refreshes_an_expiring_token_and_saves_the_rotation() {
    let (store, endpoints, mock, _) = connected(false, false).await;
    let mut v: serde_json::Value = serde_json::from_str(&store.raw()).unwrap();
    v["expires_at"] = serde_json::json!(now() - 10);
    store
        .set(CHATGPT_KEYCHAIN_SERVICE, CHATGPT_KEYCHAIN_ACCOUNT, &v.to_string())
        .unwrap();
    let token = super::chatgpt::plan_token(&store, &endpoints).await.unwrap();
    assert_eq!(token.expose(), "access-2");
    assert_eq!(mock.lock().unwrap().refreshes, 1);
    assert!(store.raw().contains("refresh-2"));
    // Scope was left out of the refresh reply, so the old scopes stay.
    assert!(account(&store).unwrap().plan_usage);
}

#[tokio::test]
async fn disconnect_revokes_and_forgets() {
    let (store, endpoints, mock, _) = connected(false, false).await;
    disconnect(&store, &endpoints).await.unwrap();
    assert_eq!(store.raw(), "");
    assert_eq!(mock.lock().unwrap().revoked, vec!["refresh-1".to_owned()]);
    assert!(account(&store).is_none());
}

#[test]
fn api_keys_are_checked_before_they_are_saved() {
    let store = MemStore::default();
    assert!(set_api_key(&store, "openai", "short").is_err());
    assert!(set_api_key(&store, "openai", "sk-has space 0123456789abcdef").is_err());
    assert!(set_api_key(&store, "gemini", "sk-test-0123456789abcdefghij").is_err());
    set_api_key(&store, "openai", "  sk-test-0123456789abcdefghij \n").unwrap();
    assert_eq!(
        store
            .keychain(OPENAI_KEYCHAIN_SERVICE, OPENAI_KEYCHAIN_ACCOUNT)
            .as_deref(),
        Some("sk-test-0123456789abcdefghij")
    );
    clear_api_key(&store, "openai").unwrap();
    assert!(
        store
            .keychain(OPENAI_KEYCHAIN_SERVICE, OPENAI_KEYCHAIN_ACCOUNT)
            .is_none()
    );
}

#[test]
fn reads_what_a_request_needs() {
    assert_eq!(Needs::of_body(r#"{"input":"hi","tools":[]}"#), Needs::default());
    assert_eq!(
        Needs::of_body(r#"{"tools":[{"type":"function"}],"input":[{"type":"input_image"}]}"#),
        Needs {
            tools: true,
            images: true
        }
    );
}

#[test]
fn endpoints_refuse_plain_http_off_loopback() {
    assert!(Endpoints::custom("http://auth.example.com", "https://api.example.com").is_err());
    assert!(Endpoints::custom("http://127.0.0.1:9", "http://127.0.0.1:9/v1").is_ok());
    assert!(Endpoints::openai().is_ok());
}

#[test]
fn the_probe_image_is_a_png() {
    assert!(super::chatgpt::probe_png().starts_with(b"\x89PNG\r\n\x1a\n"));
}

#[tokio::test]
async fn verbose_trace_shows_each_call_without_tokens() {
    let (store, endpoints, _, _) = connected(true, false).await;
    let seen = Mutex::new(Vec::<CallInfo>::new());
    let trace = |c: &CallInfo| seen.lock().unwrap().push(c.clone());
    let report = probe_with(&store, &endpoints, Some(&trace)).await.unwrap();
    assert_eq!(report.text, Outcome::Accepted);
    assert_eq!(report.tools, Outcome::Accepted);
    assert_eq!(
        report.images,
        Outcome::Refused("Image input is not supported on this plan.".to_owned())
    );
    assert!(report.caps.text && report.caps.tools && !report.caps.images);
    let seen = seen.into_inner().unwrap();
    let calls: Vec<&str> = seen.iter().map(|c| c.call.as_str()).collect();
    assert!(calls.contains(&"GET /v1/models"));
    assert_eq!(seen.len(), 5);
    let image = seen.iter().find(|c| c.call.ends_with("(image)")).unwrap();
    assert_eq!(image.status, 400);
    assert!(
        image
            .preview
            .as_deref()
            .unwrap()
            .contains("Image input is not supported")
    );
    // The SSE answers are not JSON, so they show a preview; none holds a token.
    assert!(
        seen.iter()
            .all(|c| !c.preview.as_deref().unwrap_or_default().contains("access-1"))
    );
}

#[test]
fn reads_responses_streams() {
    assert!(super::chatgpt::stream_ok(
        b"data: {\"type\":\"response.output_text.delta\"}\n\ndata: {\"type\":\"response.completed\"}\n\n"
    ));
    assert!(super::chatgpt::stream_ok(
        b"data: {\"type\":\"response.incomplete\"}\n"
    ));
    assert!(!super::chatgpt::stream_ok(
        b"data: {\"type\":\"response.created\"}\ndata: {\"type\":\"error\"}\n"
    ));
    assert!(!super::chatgpt::stream_ok(
        b"data: {\"type\":\"response.created\"}\n"
    ));
    assert!(super::chatgpt::stream_ok(br#"{"status":"completed"}"#));
    assert!(!super::chatgpt::stream_ok(b"<html>"));
}

#[test]
fn picks_a_model_from_either_catalog_shape() {
    let plan = serde_json::json!({ "models": [{ "slug": "a", "visibility": "hide" }, { "slug": "b", "visibility": "list" }] });
    assert_eq!(super::chatgpt::pick_model(&plan).as_deref(), Some("b"));
    let api = serde_json::json!({ "data": [{ "id": "gpt-x" }] });
    assert_eq!(super::chatgpt::pick_model(&api).as_deref(), Some("gpt-x"));
    assert_eq!(super::chatgpt::pick_model(&serde_json::json!({})), None);
}

#[test]
fn tells_a_capability_refusal_from_a_bad_request() {
    use super::chatgpt::classify;
    assert!(matches!(
        classify(400, "Input must be a list".into()),
        Outcome::RequestError(_)
    ));
    assert!(matches!(
        classify(400, "Unsupported parameter: max_output_tokens".into()),
        Outcome::RequestError(_)
    ));
    assert!(matches!(
        classify(400, "Image input is not supported on this plan.".into()),
        Outcome::Refused(_)
    ));
    assert!(matches!(
        classify(
            400,
            "Function tools are not available with ChatGPT plan usage".into()
        ),
        Outcome::Refused(_)
    ));
    assert!(matches!(classify(403, "Forbidden".into()), Outcome::Refused(_)));
}

#[test]
fn shapes_real_requests_for_the_plan_route() {
    let out: serde_json::Value = serde_json::from_str(&plan_body(
        r#"{"model":"m","input":"hi","max_output_tokens":64,"stream":true}"#,
    ))
    .unwrap();
    assert!(out.get("max_output_tokens").is_none());
    assert_eq!(
        out["input"],
        serde_json::json!([{ "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }])
    );
    assert_eq!(out["stream"], true);
    // A list input, as the Responses adapter sends, passes through.
    let list = r#"{"input":[{"role":"user","content":"hi"}],"tools":[]}"#;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&plan_body(list)).unwrap(),
        serde_json::from_str::<serde_json::Value>(list).unwrap()
    );
}

#[tokio::test]
async fn the_probe_requests_pass_the_plan_route_shape_rules() {
    let (store, endpoints, _, _) = connected(false, false).await;
    let report = probe_with(&store, &endpoints, None).await.unwrap();
    assert_eq!(
        (report.text, report.tools, report.images, report.app_shape),
        (
            Outcome::Accepted,
            Outcome::Accepted,
            Outcome::Accepted,
            Outcome::Accepted
        )
    );
}

#[test]
fn falls_back_to_the_key_only_for_refusals() {
    assert!(fall_back(429, "You have reached your plan usage limit"));
    assert!(fall_back(401, "token expired"));
    assert!(fall_back(400, "Image input is not supported on this plan."));
    assert!(!fall_back(400, "Input must be a list"));
    assert!(!fall_back(500, "server error"));
}

#[tokio::test]
async fn a_runtime_refusal_is_remembered_for_that_need() {
    let (store, endpoints, _, _) = connected(false, false).await;
    probe(&store, &endpoints).await.unwrap();
    store
        .set(
            OPENAI_KEYCHAIN_SERVICE,
            OPENAI_KEYCHAIN_ACCOUNT,
            "sk-test-0123456789abcdefghij",
        )
        .unwrap();
    let images = Needs {
        tools: true,
        images: true,
    };
    assert_eq!(openai_auth(&store, images), Some(OpenAiAuth::ChatGptPlan));
    note_refusal(&store, images, 400, "Image input is not supported on this plan.");
    assert_eq!(openai_auth(&store, images), Some(OpenAiAuth::ApiKey));
    assert_eq!(
        openai_auth(
            &store,
            Needs {
                tools: true,
                images: false
            }
        ),
        Some(OpenAiAuth::ChatGptPlan)
    );
    // A malformed request says nothing about the plan and changes nothing.
    note_refusal(
        &store,
        Needs {
            tools: true,
            images: false,
        },
        400,
        "Input must be a list",
    );
    assert!(account(&store).unwrap().capabilities.unwrap().tools);
}

#[test]
fn lists_models_with_every_hint() {
    let v = serde_json::json!({ "models": [
        { "slug": "a", "display_name": "A", "visibility": "list", "input_modalities": ["text", "image"], "pricing": { "input": 0.4 } },
        { "slug": "b", "visibility": "hide" }
    ] });
    let m = list_models(&v);
    assert_eq!(m.len(), 2);
    assert_eq!(
        m[0].hints.get("input_modalities").map(String::as_str),
        Some("text|image")
    );
    assert_eq!(m[0].hints.get("pricing.input").map(String::as_str), Some("0.4"));
    assert!(!m[1].listed);
}

#[test]
fn picks_tiers_from_hints_only() {
    let v = serde_json::json!({ "models": [
        { "slug": "big", "pricing": { "input": 5.0 }, "input_modalities": ["text", "image"] },
        { "slug": "small-text", "pricing": { "input": 0.1 }, "input_modalities": ["text"] },
        { "slug": "small-vision", "pricing": { "input": 0.3 }, "input_modalities": ["text", "image"] }
    ] });
    let t = pick_tiers(&list_models(&v)).unwrap();
    assert_eq!((t.huginn.as_str(), t.muninn.as_str()), ("small-vision", "big"));
    // Names alone never decide.
    let names = serde_json::json!({ "models": [{ "slug": "x-mini" }, { "slug": "x-max" }] });
    assert!(pick_tiers(&list_models(&names)).is_err());
}

#[tokio::test]
async fn probes_a_chosen_model() {
    let (store, endpoints, _, _) = connected(true, false).await;
    let report = probe_model(&store, &endpoints, None, Some("gpt-5.6-luna"))
        .await
        .unwrap();
    assert_eq!(report.caps.model, "gpt-5.6-luna");
    assert!(matches!(report.images, Outcome::Refused(_)));
}

/// The desktop app awaits these from async Tauri commands, which need Send futures.
#[test]
fn the_account_calls_are_send() {
    fn send<T: Send>(_: &T) {}
    let store = MemStore::default();
    let endpoints = Endpoints::openai().unwrap();
    let open = |_: &str| -> crate::Result<()> { Ok(()) };
    let opts = ConnectOptions {
        endpoints: endpoints.clone(),
        redirect_port: 0,
        app_name: "SlicerX",
        open_url: &open,
        timeout: Duration::from_secs(1),
    };
    send(&connect(&store, &opts));
    send(&disconnect(&store, &endpoints));
    send(&probe(&store, &endpoints));
    send(&plan_models(&store, &endpoints));
}

#[tokio::test]
async fn judges_one_frame_on_the_plan() {
    let (store, endpoints, mock, _) = connected(false, false).await;
    let v = judge_frame(
        &store,
        &endpoints,
        "gpt-5.6-luna",
        "image/png",
        &super::chatgpt::probe_png(),
    )
    .await
    .unwrap();
    assert_eq!(
        v,
        FrameVerdict {
            failed: true,
            kind: "spaghetti".into(),
            confidence: 0.9
        }
    );
    assert!(
        mock.lock()
            .unwrap()
            .auth_headers
            .iter()
            .any(|h| h == "Bearer access-1")
    );
}

#[test]
fn reads_verdicts_with_text_around_them() {
    use super::chatgpt::parse_verdict;
    assert!(
        !parse_verdict(r#"{"failed": false, "kind": "none", "confidence": 0.2}"#)
            .unwrap()
            .failed
    );
    assert!(parse_verdict("no json here").is_none());
    assert!(
        (parse_verdict(r#"x {"failed": true, "confidence": 7} y"#)
            .unwrap()
            .confidence
            - 1.0)
            .abs()
            < 1e-9
    );
}

#[test]
fn pasted_keys_land_where_the_model_reads_them() {
    let store = MemStore::default();
    set_api_key(&store, "openai", "sk-test-0123456789abcdefghij").unwrap();
    assert_eq!(
        crate::keys::openai_key(&store).map(|k| k.expose().to_owned()),
        Some("sk-test-0123456789abcdefghij".to_owned())
    );
    assert!(has_api_key(&store, "openai").unwrap());
    assert!(!has_api_key(&store, "anthropic").unwrap());
}

#[test]
fn moves_a_key_from_the_old_desktop_item() {
    let store = MemStore::default();
    store
        .set(
            LEGACY_KEY_SERVICE,
            OPENAI_KEYCHAIN_SERVICE,
            "sk-old-0123456789abcdefghij",
        )
        .unwrap();
    assert!(crate::keys::openai_key(&store).is_none());
    assert_eq!(migrate_api_keys(&store), 1);
    assert_eq!(
        store
            .keychain(OPENAI_KEYCHAIN_SERVICE, OPENAI_KEYCHAIN_ACCOUNT)
            .as_deref(),
        Some("sk-old-0123456789abcdefghij")
    );
    assert!(
        store
            .keychain(LEGACY_KEY_SERVICE, OPENAI_KEYCHAIN_SERVICE)
            .is_none()
    );
    assert_eq!(migrate_api_keys(&store), 0);
}

#[test]
fn a_newer_key_wins_over_the_old_item() {
    let store = MemStore::default();
    store
        .set(
            LEGACY_KEY_SERVICE,
            OPENAI_KEYCHAIN_SERVICE,
            "sk-old-0123456789abcdefghij",
        )
        .unwrap();
    set_api_key(&store, "openai", "sk-new-0123456789abcdefghij").unwrap();
    migrate_api_keys(&store);
    assert_eq!(
        store
            .keychain(OPENAI_KEYCHAIN_SERVICE, OPENAI_KEYCHAIN_ACCOUNT)
            .as_deref(),
        Some("sk-new-0123456789abcdefghij")
    );
    assert!(
        store
            .keychain(LEGACY_KEY_SERVICE, OPENAI_KEYCHAIN_SERVICE)
            .is_none()
    );
}
