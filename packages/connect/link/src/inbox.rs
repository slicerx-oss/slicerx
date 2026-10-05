// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The optional inbox: files a cloud service wants to deliver to a printer. The bridge only makes
//! outbound HTTPS requests. It downloads each offered file, checks it, holds it in memory and tells
//! paired clients about it. Nothing reaches a printer until a client calls `upload` and `start`
//! with an approval token, exactly as for a local file. The cloud never sees or supplies tokens.
//!
//! Protocol (bearer token, scope `cloud_slice`): `POST /v1/devices`, `PUT /v1/devices/{id}/printers`,
//! `GET /v1/devices/{id}/deliveries?wait=25`, `GET /v1/devices/{id}/deliveries/{delivery}/gcode`, and
//! `POST /v1/devices/{id}/deliveries/{delivery}/state`.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use reqwest::Client;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, broadcast};

use crate::rpc::Bridge;

/// Keychain names used by the bridge.
pub const TOKEN_SECRET: &str = "sx-link-inbox-token";
const DEVICE_SECRET: &str = "sx-link-inbox-device";
/// Largest file the bridge will download.
const MAX_BYTES: u64 = 256 * 1024 * 1024;
/// How long an unapproved delivery stays in memory.
const KEEP: Duration = Duration::from_mins(30);
const EXTENSIONS: [&str; 3] = [".gcode", ".gcode.3mf", ".bgcode"];

#[derive(Debug, Clone)]
pub struct InboxConfig {
    /// Base URL of the cloud service. `https` only, except for loopback (tests).
    pub url: String,
    /// The `sxk_` bearer token. `sx-link` reads it from the keychain entry [`TOKEN_SECRET`].
    pub token: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    AwaitingApproval,
    Uploaded,
}

struct Delivery {
    job_id: String,
    printer_id: String,
    file_name: String,
    sha256: String,
    bytes: u64,
    stats: Value,
    data: Arc<Vec<u8>>,
    at: Instant,
    stage: Stage,
}

pub(crate) struct Inbox {
    client: Client,
    base: String,
    token: String,
    device: Mutex<Option<String>>,
    deliveries: Mutex<HashMap<String, Delivery>>,
    /// `{"deliveryId", "state", ...}` objects, forwarded to paired clients as `inbox` events.
    pub(crate) events: broadcast::Sender<Value>,
}

/// Why a claim on a delivery failed.
pub(crate) enum ClaimError {
    Unknown,
    WrongPrinter,
}

impl Inbox {
    pub(crate) fn new(cfg: &InboxConfig) -> Result<Self, String> {
        let url = cfg.url.trim_end_matches('/');
        let rest = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))
            .ok_or("the inbox URL must start with https://")?;
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        if authority.is_empty() || authority.contains('@') || rest.contains(['?', '#']) {
            return Err("the inbox URL must be a plain address".to_owned());
        }
        let host = authority.rsplit_once(':').map_or(authority, |(h, p)| {
            if p.bytes().all(|c| c.is_ascii_digit()) {
                h
            } else {
                authority
            }
        });
        let loopback = matches!(host.trim_matches(['[', ']']), "127.0.0.1" | "localhost" | "::1");
        if url.starts_with("http://") && !loopback {
            return Err("the inbox URL must use https (http is only allowed for loopback)".to_owned());
        }
        if cfg.token.is_empty() {
            return Err("the inbox token is empty".to_owned());
        }
        // The TLS provider is process wide; installing it twice is harmless.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| e.without_url().to_string())?;
        let (events, _) = broadcast::channel(64);
        Ok(Self {
            client,
            base: url.to_owned(),
            token: cfg.token.clone(),
            device: Mutex::new(None),
            deliveries: Mutex::new(HashMap::new()),
            events,
        })
    }

    fn emit(&self, data: Value) {
        let _ = self.events.send(data);
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        timeout: Duration,
    ) -> Result<reqwest::Response, String> {
        let mut rb = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .timeout(timeout);
        if let Some(b) = body {
            rb = rb.json(&b);
        }
        let resp = rb.send().await.map_err(|e| e.without_url().to_string())?;
        let status = resp.status();
        if matches!(status.as_u16(), 401 | 403) {
            Err("the inbox refused the token".to_owned())
        } else if status.is_success() {
            Ok(resp)
        } else {
            Err(format!("the inbox answered HTTP {}", status.as_u16()))
        }
    }

    async fn device_id(&self, bridge: &Bridge) -> Result<String, String> {
        if let Some(id) = self.device.lock().await.clone() {
            return Ok(id);
        }
        let stored = sx_connect::Secrets::get(bridge.secrets_ref(), DEVICE_SECRET);
        let id = if let Some(id) = stored {
            id
        } else {
            let resp = self
                .request(
                    reqwest::Method::POST,
                    "/v1/devices",
                    Some(json!({ "name": "sx-link", "kind": "link" })),
                    Duration::from_secs(15),
                )
                .await?;
            let v: Value = resp.json().await.map_err(|e| e.without_url().to_string())?;
            let id = v
                .get("id")
                .and_then(Value::as_str)
                .ok_or("the inbox did not return a device id")?
                .to_owned();
            bridge
                .secrets_ref_store()
                .set(DEVICE_SECRET, &id)
                .map_err(|e| e.to_string())?;
            id
        };
        *self.device.lock().await = Some(id.clone());
        Ok(id)
    }

    async fn report(&self, device: &str, delivery: &str, state: &str, message: Option<&str>) {
        let mut body = json!({ "state": state });
        if let (Some(m), Some(o)) = (message, body.as_object_mut()) {
            o.insert("message".to_owned(), Value::String(m.chars().take(500).collect()));
        }
        // A 409 means the cloud already moved past this state; the outcome is the same.
        let _ = self
            .request(
                reqwest::Method::POST,
                &format!("/v1/devices/{device}/deliveries/{delivery}/state"),
                Some(body),
                Duration::from_secs(15),
            )
            .await;
    }

    /// The pending deliveries, without their data.
    pub(crate) async fn list(&self) -> Vec<Value> {
        let map = self.deliveries.lock().await;
        let mut v: Vec<(Instant, Value)> = map
            .iter()
            .map(|(id, d)| (d.at, describe(id, d, "awaiting_approval")))
            .collect();
        v.sort_by_key(|(t, _)| *t);
        v.into_iter().map(|(_, j)| j).collect()
    }

    /// The verified file for `upload`. Does not remove it: a refused approval can be retried.
    pub(crate) async fn claim(
        &self,
        id: &str,
        printer: &str,
    ) -> Result<(String, String, Arc<Vec<u8>>), ClaimError> {
        let map = self.deliveries.lock().await;
        let d = map
            .get(id)
            .filter(|d| d.stage == Stage::AwaitingApproval)
            .ok_or(ClaimError::Unknown)?;
        if d.printer_id != printer {
            return Err(ClaimError::WrongPrinter);
        }
        Ok((d.file_name.clone(), d.sha256.clone(), d.data.clone()))
    }

    /// After a successful upload: the cloud sees `approved` then `uploaded`, and the file's bytes
    /// are dropped from memory.
    pub(crate) async fn uploaded(&self, bridge: &Bridge, id: &str) {
        let Ok(device) = self.device_id(bridge).await else {
            return;
        };
        let info = {
            let mut map = self.deliveries.lock().await;
            map.get_mut(id).map(|d| {
                d.stage = Stage::Uploaded;
                d.data = Arc::new(Vec::new());
                describe(id, d, "uploaded")
            })
        };
        self.report(&device, id, "approved", None).await;
        self.report(&device, id, "uploaded", None).await;
        if let Some(i) = info {
            self.emit(i);
        }
    }

    /// After a successful start of a file that came from the inbox.
    pub(crate) async fn started(&self, bridge: &Bridge, printer: &str, name: &str) {
        let hit = {
            let mut map = self.deliveries.lock().await;
            let key = map
                .iter()
                .find(|(_, d)| d.stage == Stage::Uploaded && d.printer_id == printer && d.file_name == name)
                .map(|(k, _)| k.clone());
            key.and_then(|k| map.remove(&k).map(|d| describe(&k, &d, "printing")))
        };
        if let (Some(info), Ok(device)) = (hit, self.device_id(bridge).await) {
            if let Some(id) = info.get("deliveryId").and_then(Value::as_str) {
                self.report(&device, id, "printing", None).await;
            }
            self.emit(info);
        }
    }

    /// Drops a delivery and tells the cloud why (`declined` or `failed`).
    pub(crate) async fn end(&self, bridge: &Bridge, id: &str, state: &str, message: Option<&str>) -> bool {
        let gone = self.deliveries.lock().await.remove(id);
        let Some(d) = gone else { return false };
        if let Ok(device) = self.device_id(bridge).await {
            self.report(&device, id, state, message).await;
        }
        let mut info = describe(id, &d, state);
        if let (Some(m), Some(o)) = (message, info.as_object_mut()) {
            o.insert("message".to_owned(), json!(m));
        }
        self.emit(info);
        true
    }

    async fn sweep(&self, bridge: &Bridge) {
        let old: Vec<String> = self
            .deliveries
            .lock()
            .await
            .iter()
            .filter(|(_, d)| d.stage == Stage::AwaitingApproval && d.at.elapsed() > KEEP)
            .map(|(k, _)| k.clone())
            .collect();
        for id in old {
            self.end(bridge, &id, "failed", Some("expired before it was approved"))
                .await;
        }
    }

    /// Keeps the inbox's copy of the printer list current.
    async fn sync_printers(&self, bridge: &Bridge, device: &str, last: &mut String) -> Result<(), String> {
        let printers: Vec<Value> = bridge
            .printer_infos()
            .await
            .into_iter()
            .filter(|(id, _)| valid_id(id))
            .map(|(id, info)| {
                let field = |k: &str| info.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
                let mut p = serde_json::Map::new();
                p.insert("name".to_owned(), json!(field("name").unwrap_or(&id)));
                p.insert("localId".to_owned(), json!(id));
                if let Some(d) = field("plugin") {
                    p.insert("driver".to_owned(), json!(d));
                }
                if let Some(m) = field("model") {
                    p.insert("model".to_owned(), json!(m));
                }
                Value::Object(p)
            })
            .collect();
        let key = serde_json::to_string(&printers).unwrap_or_default();
        if key != *last {
            self.request(
                reqwest::Method::PUT,
                &format!("/v1/devices/{device}/printers"),
                Some(Value::Array(printers)),
                Duration::from_secs(15),
            )
            .await?;
            *last = key;
        }
        Ok(())
    }

    async fn offered(&self, device: &str) -> Result<Vec<Value>, String> {
        let resp = self
            .request(
                reqwest::Method::GET,
                &format!("/v1/devices/{device}/deliveries?wait=25"),
                None,
                Duration::from_secs(45),
            )
            .await?;
        let v: Value = resp.json().await.map_err(|e| e.without_url().to_string())?;
        Ok(v.as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|d| d.get("state").and_then(Value::as_str) == Some("offered"))
            .collect())
    }

    /// Validates and downloads one offered delivery. Every field is untrusted.
    async fn accept(&self, bridge: &Bridge, device: &str, d: &Value) {
        let s = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or("");
        let id = s("id");
        if !valid_id(id) {
            return;
        }
        if self.deliveries.lock().await.contains_key(id) {
            return;
        }
        let fail = |why: &'static str| async move {
            // The file name and the reason are safe to print; nothing here is a secret.
            eprintln!("sx-link inbox: refused delivery {id}: {why}");
            self.report(device, id, "failed", Some(why)).await;
        };
        let name = s("fileName");
        if !valid_file_name(name) {
            return fail("unsupported file name").await;
        }
        let sha = s("sha256").to_ascii_lowercase();
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return fail("bad checksum").await;
        }
        let bytes = d.get("bytes").and_then(Value::as_u64).unwrap_or(0);
        if bytes == 0 || bytes > MAX_BYTES {
            return fail("the file is empty or too large").await;
        }
        let printer = s("printerLocalId");
        if !bridge.has_printer(printer).await {
            return fail("that printer is not connected to this bridge").await;
        }
        // The service downloads a delivery through the bridge's own device and delivery ids. Any
        // other path is refused, so an offer cannot point the bridge at a different resource.
        let path = s("gcodePath");
        if path != format!("/v1/devices/{device}/deliveries/{id}/gcode") {
            return fail("bad download path").await;
        }
        let Ok(data) = self.download(path, bytes).await else {
            return fail("download failed").await;
        };
        let actual = hex(&Sha256::digest(&data));
        if actual != sha {
            return fail("checksum mismatch").await;
        }
        let delivery = Delivery {
            job_id: s("jobId").chars().take(120).collect(),
            printer_id: printer.to_owned(),
            file_name: name.to_owned(),
            sha256: sha,
            bytes,
            stats: d.get("stats").cloned().unwrap_or(Value::Null),
            data: Arc::new(data),
            at: Instant::now(),
            stage: Stage::AwaitingApproval,
        };
        let info = describe(id, &delivery, "awaiting_approval");
        self.deliveries.lock().await.insert(id.to_owned(), delivery);
        self.report(device, id, "downloaded", None).await;
        self.report(device, id, "awaiting_approval", None).await;
        self.emit(info);
    }

    async fn download(&self, path: &str, expected: u64) -> Result<Vec<u8>, String> {
        let resp = self
            .request(reqwest::Method::GET, path, None, Duration::from_secs(600))
            .await?;
        if resp.content_length().is_some_and(|n| n != expected) {
            return Err("size differs".to_owned());
        }
        let mut stream = resp.bytes_stream();
        let mut out = Vec::with_capacity(usize::try_from(expected.min(64 * 1024 * 1024)).unwrap_or(0));
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.without_url().to_string())?;
            if u64::try_from(out.len() + chunk.len()).unwrap_or(u64::MAX) > expected {
                return Err("more data than announced".to_owned());
            }
            out.extend_from_slice(&chunk);
        }
        if u64::try_from(out.len()).unwrap_or(0) != expected {
            return Err("fewer bytes than announced".to_owned());
        }
        Ok(out)
    }
}

fn describe(id: &str, d: &Delivery, state: &str) -> Value {
    json!({ "deliveryId": id, "jobId": d.job_id, "printerId": d.printer_id, "fileName": d.file_name, "sha256": d.sha256, "bytes": d.bytes, "stats": d.stats, "state": state })
}

/// Ids the bridge accepts from the inbox: 1 to 120 of `[A-Za-z0-9-_.:]`.
pub(crate) fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 120
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

/// File names the bridge accepts: at most 100 characters of `[A-Za-z0-9._-]`, no leading dot, and
/// one of the G-code extensions. Anything else is refused rather than rewritten, because the name
/// is part of what the user approved.
pub(crate) fn valid_file_name(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    !s.is_empty()
        && s.len() <= 100
        && !s.starts_with('.')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && EXTENSIONS
            .iter()
            .any(|e| lower.ends_with(e) && lower.len() > e.len())
}

/// Polls the inbox until the process ends, with a growing pause after failures.
pub(crate) async fn run(inbox: Arc<Inbox>, bridge: Arc<Bridge>) {
    let (mut backoff, mut last_printers) = (Duration::from_secs(2), String::new());
    let mut seen_error = HashSet::new();
    loop {
        inbox.sweep(&bridge).await;
        let step = async {
            let device = inbox.device_id(&bridge).await?;
            inbox.sync_printers(&bridge, &device, &mut last_printers).await?;
            let offered = inbox.offered(&device).await?;
            for d in &offered {
                inbox.accept(&bridge, &device, d).await;
            }
            Ok::<(), String>(())
        };
        match step.await {
            Ok(()) => backoff = Duration::from_secs(2),
            Err(e) => {
                // One line per distinct problem, never the token or a URL.
                if seen_error.insert(e.clone()) {
                    eprintln!("sx-link inbox: {e}");
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(60));
            }
        }
        // An empty long poll returns after wait seconds; a fast answer needs a short pause.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_ids() {
        for ok in [
            "cube.gcode",
            "Lantern_v2-final.gcode.3mf",
            "a.bgcode",
            "CUBE.GCODE",
        ] {
            assert!(valid_file_name(ok), "{ok}");
        }
        for bad in [
            "",
            ".gcode",
            "a b.gcode",
            "../a.gcode",
            "a/b.gcode",
            "a.txt",
            "a.gcode.exe",
            ".hidden.gcode",
            &format!("{}.gcode", "x".repeat(100)),
            "a\n.gcode",
            "über.gcode",
        ] {
            assert!(!valid_file_name(bad), "{bad}");
        }
        assert!(valid_id("d-1:x_y.z") && !valid_id("") && !valid_id("a b") && !valid_id(&"x".repeat(121)));
    }

    #[test]
    fn url_rules() {
        let cfg = |u: &str| InboxConfig {
            url: u.to_owned(),
            token: "sxk_test".to_owned(),
        };
        assert!(Inbox::new(&cfg("https://cloud.example")).is_ok());
        assert!(Inbox::new(&cfg("http://127.0.0.1:8080")).is_ok());
        assert!(Inbox::new(&cfg("http://cloud.example")).is_err());
        assert!(Inbox::new(&cfg("https://user@cloud.example")).is_err());
        assert!(Inbox::new(&cfg("https://cloud.example/?x=1")).is_err());
        assert!(Inbox::new(&cfg("ftp://cloud.example")).is_err());
        assert!(
            Inbox::new(&InboxConfig {
                url: "https://cloud.example".into(),
                token: String::new()
            })
            .is_err()
        );
    }
}
