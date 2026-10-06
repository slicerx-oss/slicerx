// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! PrusaLink local API (`/api/v1`), used by the MK4S, MK3.9, MINI+, XL, Core One and other
//! Prusa printers with PrusaLink. The spec declares HTTP Digest only, user `maker` and the password
//! the printer shows; a printer that answers 401 without a Digest challenge, or turns the Digest
//! login down, is tried once with the same secret as an `X-Api-Key` (older PrusaLink).
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::{Client, RequestBuilder, Response};
use serde_json::Value;

use crate::camera::{self, FrameStream};
use crate::digest::{Challenge, DigestAuth};
use crate::error::{Error, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http::{self, base_url, f64_at, seg, str_at};
use crate::manifest::{PluginManifest, manifest};
use crate::poll::poll_events;
use crate::types::{
    Capabilities, Capability, DiscoveredPrinter, ExtruderInfo, FilamentUnit, Image, JobFile, PrinterConfig,
    PrinterEvent, PrinterHardware, PrinterState, PrinterStatus, RemoteFile, Secrets, StartOptions, Temp,
    now_iso, secs,
};
use crate::{PrinterConnector, PrinterSession};

pub struct PrusaLinkConnector {
    gate: Arc<dyn ApprovalGate>,
    /// The port `probe` asks: 80, another in tests.
    probe_port: u16,
}

impl PrusaLinkConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self { gate, probe_port: 80 }
    }

    /// Probes `port` instead of 80.
    #[must_use]
    pub fn with_probe_port(mut self, port: u16) -> Self {
        self.probe_port = port;
        self
    }
}

#[async_trait]
impl PrinterConnector for PrusaLinkConnector {
    fn manifest(&self) -> PluginManifest {
        manifest("prusalink").unwrap_or_else(|| unreachable_manifest("prusalink"))
    }

    /// Nothing to listen for: no Prusa printer has been seen announcing itself over mDNS (the
    /// `_prusalink._tcp` names in `mdns.rs` are unconfirmed), so the user enters the address and
    /// `probe` confirms it.
    async fn discover(&self, _timeout: Duration) -> Vec<DiscoveredPrinter> {
        Vec::new()
    }

    /// Asks a typed address for `GET /api/version`. PrusaLink answers with `text` "PrusaLink" and
    /// its hostname, or, without a login, with a 401 and a Digest challenge, as 5.x firmware does.
    async fn probe(&self, host: &str, timeout: Duration) -> Option<DiscoveredPrinter> {
        let ip: std::net::IpAddr = host.parse().ok()?;
        let client = http::service_client().ok()?;
        let url = format!(
            "http://{}/api/version",
            std::net::SocketAddr::from((ip, self.probe_port))
        );
        let r = client.get(url).timeout(timeout).send().await.ok()?;
        let found = |name: Option<String>, firmware: Option<String>| DiscoveredPrinter {
            plugin: "prusalink".to_owned(),
            host: host.to_owned(),
            port: Some(self.probe_port),
            name,
            model: None,
            serial: None,
            firmware,
            lan_only: None,
            ..DiscoveredPrinter::default()
        };
        if r.status() == reqwest::StatusCode::UNAUTHORIZED {
            let digest = r
                .headers()
                .get(reqwest::header::WWW_AUTHENTICATE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| Challenge::parse(v).is_some());
            return digest.then(|| found(None, None));
        }
        if !r.status().is_success() {
            return None;
        }
        let v: Value = r.json().await.ok()?;
        if !str_at(&v, &["text"]).is_some_and(|t| t.contains("PrusaLink")) {
            return None;
        }
        Some(found(
            str_at(&v, &["hostname"]).map(str::to_owned),
            str_at(&v, &["firmware"]).map(str::to_owned),
        ))
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        let secret = cfg.credential_ref.as_deref().and_then(|r| secrets.get(r));
        let auth = match (&cfg.username, secret) {
            (Some(_), None) => {
                return Err(Error::Auth {
                    printer: cfg.id.clone(),
                });
            }
            (user, Some(secret)) => Some(Login {
                digest: DigestAuth::new(user.as_deref().unwrap_or(DEFAULT_USER), &secret),
                key: secret,
                mode: AtomicU8::new(MODE_UNKNOWN),
            }),
            (None, None) => None,
        };
        let inner = Arc::new(Inner {
            cfg: cfg.clone(),
            client: http::client(cfg)?,
            base: base_url(cfg, 80),
            auth,
            gate: self.gate.clone(),
            camera: AtomicBool::new(false),
            version: std::sync::Mutex::new(None),
        });
        // /api/v1/info answers without a job and proves the login works.
        inner.send(inner.get("/api/v1/info")).await?;
        // The version names the firmware; older firmware may not answer it with a login.
        let version = match inner.send(inner.get("/api/version")).await {
            Ok(r) => http::json(&cfg.id, r).await.ok(),
            Err(_) => None,
        };
        *inner
            .version
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = version;
        let cams = match inner.send(inner.get("/api/v1/cameras")).await {
            Ok(r) => http::json(&cfg.id, r).await.ok(),
            Err(_) => None,
        };
        inner.camera.store(
            cams.and_then(|c| c.as_array().map(|a| !a.is_empty()))
                .unwrap_or(false),
            Ordering::Relaxed,
        );
        Ok(Box::new(PrusaLinkSession { inner }))
    }
}

pub(crate) fn unreachable_manifest(id: &str) -> PluginManifest {
    PluginManifest {
        id: id.to_owned(),
        name: id.to_owned(),
        version: "0.1.0".to_owned(),
        kind: crate::PluginKind::Printer,
        protocols: Vec::new(),
        capabilities: Vec::new(),
        tools: Vec::new(),
        network: Vec::new(),
    }
}

/// The user name every PrusaLink login uses (spec, `digestAuth`; Prusa help).
const DEFAULT_USER: &str = "maker";

/// The model names a version reply may carry, longest first so MK4S is not read as MK4. The spec has
/// no model field; `original` (read by Home Assistant) and `text` are checked in case they name one.
const MODELS: [(&str, &str); 8] = [
    ("CORE ONE L", "Core One L"),
    ("CORE ONE", "Core One"),
    ("MK3.9", "MK3.9"),
    ("MK3.5", "MK3.5"),
    ("MK4S", "MK4S"),
    ("MK4", "MK4"),
    ("MINI", "MINI"),
    ("XL", "XL"),
];

/// The model named in a `/api/version` reply, when one is. Whole words only, so "MK4" in "MK4S"
/// does not count.
fn model_from_version(v: &Value) -> Option<String> {
    ["original", "text"].iter().find_map(|k| {
        let t = str_at(v, &[k])?.to_ascii_uppercase();
        let words: Vec<&str> = t
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '.'))
            .filter(|w| !w.is_empty())
            .collect();
        let line = format!(" {} ", words.join(" "));
        MODELS
            .iter()
            .find(|(token, _)| line.contains(&format!(" {token} ")))
            .map(|(_, name)| (*name).to_owned())
    })
}

/// The hardware in an `/api/v1/info` reply, with the firmware and any model from `/api/version`. The
/// MMU3 has five slots; the info reply says only whether one is attached. An XL's toolheads are not
/// reported (one `nozzle_diameter`), so they come from the catalog model.
pub(crate) fn prusalink_hardware(v: &Value, version: Option<&Value>) -> PrinterHardware {
    let mmu = v.get("mmu").and_then(Value::as_bool) == Some(true);
    let text = |v: &Value, k: &str| {
        str_at(v, &[k])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    PrinterHardware {
        model: version.and_then(model_from_version),
        firmware: version.and_then(|v| text(v, "firmware")),
        serial: text(v, "serial"),
        extruders: vec![ExtruderInfo {
            tool: 0,
            nozzle_diameter_mm: v.get("nozzle_diameter").and_then(Value::as_f64),
            ..ExtruderInfo::default()
        }],
        filament_units: if mmu {
            vec![FilamentUnit {
                id: "mmu".to_owned(),
                kind: "mmu".to_owned(),
                tool: None,
                slots: (1..=5)
                    .map(|n| crate::types::FilamentSlot {
                        id: n.to_string(),
                        material: None,
                        color: None,
                        remaining_pct: None,
                        spoolman_id: None,
                        spool_uid: None,
                    })
                    .collect(),
            }]
        } else {
            Vec::new()
        },
        ..PrinterHardware::default()
    }
}

struct Inner {
    cfg: PrinterConfig,
    client: Client,
    base: String,
    auth: Option<Login>,
    gate: Arc<dyn ApprovalGate>,
    camera: AtomicBool,
    /// The `/api/version` reply read on connect.
    version: std::sync::Mutex<Option<Value>>,
}

const MODE_UNKNOWN: u8 = 0;
const MODE_DIGEST: u8 = 1;
const MODE_KEY: u8 = 2;

/// One secret: the Digest password, or an API key on firmware that takes one. `mode` settles on the
/// first request that gets in and stays for the session.
struct Login {
    digest: DigestAuth,
    key: String,
    mode: AtomicU8,
}

/// Where uploads go, from `GET /api/v1/storage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StorageChoice {
    /// The storage path segment to use, such as `usb` or `local`.
    Use(String),
    /// The printer lists storages but none is available and writable: no USB drive.
    Nothing,
}

/// Picks the storage for uploads from a `/api/v1/storage` reply: available and not read only, USB
/// first (Buddy firmware), then local, then an SD card. `None` when the reply has no list.
pub(crate) fn pick_storage(v: &Value) -> Option<StorageChoice> {
    let list = v.get("storage_list").or(Some(v)).and_then(Value::as_array)?;
    let rank = |t: &str| match t {
        "USB" => 0,
        "LOCAL" => 1,
        "SDCARD" => 2,
        _ => 3,
    };
    let best = list
        .iter()
        .filter(|s| s.get("available").and_then(Value::as_bool) == Some(true))
        .filter(|s| s.get("read_only").and_then(Value::as_bool) != Some(true))
        .filter_map(|s| {
            let seg = str_at(s, &["path"])
                .map(|p| p.trim_matches('/').to_owned())
                .filter(|p| !p.is_empty() && !p.contains('/'))?;
            Some((rank(str_at(s, &["type"]).unwrap_or("")), seg))
        })
        .min_by_key(|(r, _)| *r);
    Some(best.map_or(StorageChoice::Nothing, |(_, seg)| StorageChoice::Use(seg)))
}

impl Inner {
    async fn snap_once(&self) -> Result<Option<Image>> {
        if !self.camera.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let resp = self.send(self.get("/api/v1/cameras")).await?;
        let v = http::json(self.id(), resp).await?;
        let Some(cam) = v
            .as_array()
            .and_then(|a| a.first())
            .and_then(|c| c.get("camera_id"))
            .and_then(|c| {
                c.as_str()
                    .map(str::to_owned)
                    .or_else(|| c.as_u64().map(|n| n.to_string()))
            })
        else {
            return Ok(None);
        };
        let resp = self
            .send(self.get(&format!("/api/v1/cameras/{}/snap", seg(&cam))))
            .await?;
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/jpeg")
            .to_owned();
        let data = resp
            .bytes()
            .await
            .map_err(|e| Error::protocol(self.id(), e.without_url()))?
            .to_vec();
        Ok(Some(Image { content_type, data }))
    }

    fn id(&self) -> &str {
        &self.cfg.id
    }

    async fn execute(&self, req: reqwest::Request) -> Result<Response> {
        self.client
            .execute(req)
            .await
            .map_err(|e| Error::unreachable(self.id(), e.without_url()))
    }

    /// Sends a request. With a login the first request gets a 401 and its Digest challenge, which is
    /// answered and remembered for the rest of the session. A 401 with no challenge it can answer,
    /// or a refused Digest answer before anything got in, is tried once with the secret as
    /// `X-Api-Key`; whichever gets in is kept.
    async fn send_raw(&self, rb: RequestBuilder) -> Result<Response> {
        let Some(Login { digest, key, mode }) = &self.auth else {
            return rb
                .send()
                .await
                .map_err(|e| Error::unreachable(self.id(), e.without_url()));
        };
        let mut req = rb
            .build()
            .map_err(|e| Error::Config(e.without_url().to_string()))?;
        let with_key = |r: &mut reqwest::Request| {
            if let Ok(v) = key.parse() {
                r.headers_mut().insert("X-Api-Key", v);
            }
        };
        if mode.load(Ordering::Relaxed) == MODE_KEY {
            with_key(&mut req);
            return self.execute(req).await;
        }
        let retry = req.try_clone();
        let key_retry = req.try_clone();
        let sign = |r: &mut reqwest::Request| {
            let uri =
                r.url().path().to_owned() + &r.url().query().map(|q| format!("?{q}")).unwrap_or_default();
            if let Some(h) = digest
                .header(r.method().as_str(), &uri)
                .and_then(|h| h.parse().ok())
            {
                r.headers_mut().insert(reqwest::header::AUTHORIZATION, h);
            }
        };
        sign(&mut req);
        let mut resp = self.execute(req).await?;
        if resp.status().as_u16() != 401 {
            mode.store(MODE_DIGEST, Ordering::Relaxed);
            return Ok(resp);
        }
        let offered: Vec<String> = resp
            .headers()
            .get_all(reqwest::header::WWW_AUTHENTICATE)
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_owned))
            .collect();
        match (offered.iter().find_map(|v| Challenge::parse(v)), retry) {
            (Some(challenge), Some(mut again)) => {
                digest.set_challenge(challenge);
                sign(&mut again);
                resp = self.execute(again).await?;
                if resp.status().as_u16() != 401 {
                    mode.store(MODE_DIGEST, Ordering::Relaxed);
                    return Ok(resp);
                }
            }
            _ => {
                // A Digest challenge with SHA-256 or another algorithm cannot be answered (MD5 only).
                for v in offered
                    .iter()
                    .filter(|v| v.trim_start().to_ascii_lowercase().starts_with("digest"))
                {
                    crate::trace(
                        self.id(),
                        format_args!("prusalink: digest challenge not answered, only MD5 is supported: {v}"),
                    );
                }
            }
        }
        // Once a login got in, a 401 is a real refusal.
        let (MODE_UNKNOWN, Some(mut k)) = (mode.load(Ordering::Relaxed), key_retry) else {
            return Ok(resp);
        };
        with_key(&mut k);
        let r = self.execute(k).await?;
        if r.status().as_u16() != 401 {
            mode.store(MODE_KEY, Ordering::Relaxed);
        }
        Ok(r)
    }

    /// Where uploads go now. The list is read for each upload, so a USB drive put in after the
    /// printer was added is used. A printer that does not answer `/api/v1/storage` gets `usb`.
    async fn storage(&self) -> Result<String> {
        let listed = match self.send(self.get("/api/v1/storage")).await {
            Ok(r) => http::json(self.id(), r).await.ok(),
            Err(e @ Error::Auth { .. }) => return Err(e),
            Err(_) => None,
        };
        match listed.as_ref().and_then(pick_storage) {
            Some(StorageChoice::Use(seg)) => Ok(seg),
            Some(StorageChoice::Nothing) => Err(Error::NotFound {
                printer: self.id().to_owned(),
                what: "a USB drive (PrusaLink stores uploads on it; insert one and try again)".to_owned(),
            }),
            None => Ok("usb".to_owned()),
        }
    }

    async fn send(&self, rb: RequestBuilder) -> Result<Response> {
        http::check(self.id(), self.send_raw(rb).await?)
    }

    fn get(&self, path: &str) -> RequestBuilder {
        self.client.get(format!("{}{path}", self.base))
    }

    async fn fetch_status(&self) -> Result<PrinterStatus> {
        let resp = self.send(self.get("/api/v1/status")).await?;
        let status = http::json(self.id(), resp).await?;
        // /api/v1/job answers 204 with no body when nothing is running.
        let job = match self.send_raw(self.get("/api/v1/job")).await {
            Ok(r) if r.status().as_u16() == 200 => r.json::<Value>().await.ok(),
            _ => None,
        };
        Ok(parse_status(
            self.id(),
            &status,
            job.as_ref(),
            self.camera.load(Ordering::Relaxed),
        ))
    }

    async fn job_id(&self) -> Result<u64> {
        let resp = self.send(self.get("/api/v1/status")).await?;
        let v = http::json(self.id(), resp).await?;
        v.get("job")
            .and_then(|j| j.get("id"))
            .and_then(Value::as_u64)
            .ok_or_else(|| Error::BadState {
                printer: self.id().to_owned(),
                state: "idle".to_owned(),
                action: "control a job".to_owned(),
            })
    }
}

pub(crate) fn parse_status(id: &str, status: &Value, job: Option<&Value>, camera: bool) -> PrinterStatus {
    let raw = str_at(status, &["printer", "state"]).unwrap_or("IDLE");
    let (state, message) = match raw {
        "STOPPED" => (PrinterState::Idle, Some("The print was stopped".to_owned())),
        "PRINTING" => (PrinterState::Printing, None),
        "PAUSED" => (PrinterState::Paused, None),
        "ATTENTION" => (PrinterState::Paused, Some("Printer needs attention".to_owned())),
        "BUSY" => (PrinterState::Preparing, None),
        "FINISHED" => (PrinterState::Finished, None),
        "ERROR" => (PrinterState::Error, None),
        // IDLE and READY (set ready to print), and any state the spec adds later.
        _ => (PrinterState::Idle, None),
    };
    let temp = |cur: &str, tgt: &str| -> Option<Temp> {
        Some(Temp {
            current: f64_at(status, &["printer", cur])?,
            target: f64_at(status, &["printer", tgt]).unwrap_or(0.0),
        })
    };
    let active = matches!(state, PrinterState::Printing | PrinterState::Paused);
    let progress = f64_at(status, &["job", "progress"]).map(|p| p / 100.0);
    let file =
        job.and_then(|j| str_at(j, &["file", "display_name"]).or_else(|| str_at(j, &["file", "name"])));
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: file.map(str::to_owned),
        progress: if active || file.is_some() { progress } else { None },
        layer: None,
        layer_count: None,
        time_left_s: f64_at(status, &["job", "time_remaining"]).map(secs),
        nozzles: temp("temp_nozzle", "target_nozzle").into_iter().collect(),
        bed: temp("temp_bed", "target_bed"),
        chamber: None,
        slots: Vec::new(),
        camera_available: camera,
        message,
        updated_at: now_iso(),
        live: None,
    }
}

/// A 409 from PrusaLink in words for the action that drew it.
fn busy(e: Error, state: &str, action: &str) -> Error {
    match e {
        Error::BadState { printer, .. } => Error::BadState {
            printer,
            state: state.to_owned(),
            action: action.to_owned(),
        },
        e => e,
    }
}

pub struct PrusaLinkSession {
    inner: Arc<Inner>,
}

#[async_trait]
impl PrinterSession for PrusaLinkSession {
    /// Prusa firmware turns the heaters off after 30 minutes without activity, paused prints
    /// included ("Heating disabled due to 30 minutes of inactivity").
    fn pause_heater_timeout(&self) -> Option<std::time::Duration> {
        Some(std::time::Duration::from_mins(30))
    }

    fn capabilities(&self) -> Capabilities {
        let mut c = vec![
            Capability::Status,
            Capability::Events,
            Capability::Upload,
            Capability::Start,
            Capability::Pause,
            Capability::Resume,
            Capability::Cancel,
        ];
        if self.inner.camera.load(Ordering::Relaxed) {
            c.push(Capability::Camera);
        }
        c
    }

    async fn status(&self) -> Result<PrinterStatus> {
        self.inner.fetch_status().await
    }

    /// The nozzle diameter, serial and whether an MMU is attached, from `/api/v1/info`, and the
    /// firmware from `/api/version`.
    async fn hardware(&self) -> Result<Option<PrinterHardware>> {
        let resp = self.inner.send(self.inner.get("/api/v1/info")).await.ok();
        let v = match resp {
            Some(r) => http::json(self.inner.id(), r).await.ok(),
            None => None,
        };
        let version = self
            .inner
            .version
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        Ok(v.as_ref().map(|v| prusalink_hardware(v, version.as_ref())))
    }

    fn events(&self) -> BoxStream<'static, PrinterEvent> {
        let inner = self.inner.clone();
        let interval = inner.cfg.poll_interval();
        let id = inner.cfg.id.clone();
        poll_events(
            id,
            interval,
            Arc::new(move || {
                let inner = inner.clone();
                async move { inner.fetch_status().await }
            }),
        )
    }

    async fn upload(&self, file: JobFile, token: &ApprovalToken) -> Result<RemoteFile> {
        self.inner.gate.check(
            token,
            Action::Upload,
            self.inner.id(),
            &params::upload(self.inner.id(), &file.name, &file.sha256),
        )?;
        let storage = self.inner.storage().await?;
        let path = format!("/api/v1/files/{}/{}", seg(&storage), seg(&file.name));
        let rb = self
            .inner
            .client
            .put(format!("{}{path}", self.inner.base))
            .header("Content-Type", "application/octet-stream")
            .header("Overwrite", "?1")
            .header("Print-After-Upload", "?0")
            .body(file.data.clone());
        self.inner.send(rb).await.map_err(|e| {
            busy(
                e,
                "busy: the file is printing, or the storage is in use or missing",
                "store the file",
            )
        })?;
        Ok(RemoteFile {
            printer_id: self.inner.id().to_owned(),
            path: format!("{storage}/{}", file.name),
            name: file.name,
            sha256: Some(file.sha256),
        })
    }

    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()> {
        opts.refuse_slot_map("prusalink")?;
        self.inner.gate.check(
            token,
            Action::Start,
            self.inner.id(),
            &params::start(self.inner.id(), file, &opts),
        )?;
        let (storage, rest) = file.path.split_once('/').unwrap_or(("usb", file.path.as_str()));
        let rb = self.inner.client.post(format!(
            "{}/api/v1/files/{}/{}",
            self.inner.base,
            seg(storage),
            seg(rest)
        ));
        self.inner.send(rb).await.map_err(|e| {
            busy(
                e,
                "busy: a print is running or the storage is in use",
                "start the print",
            )
        })?;
        Ok(())
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Pause,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        let id = self.inner.job_id().await?;
        let rb = self
            .inner
            .client
            .put(format!("{}/api/v1/job/{id}/pause", self.inner.base));
        self.inner.send(rb).await?;
        Ok(())
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Resume,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        let id = self.inner.job_id().await?;
        let rb = self
            .inner
            .client
            .put(format!("{}/api/v1/job/{id}/resume", self.inner.base));
        self.inner.send(rb).await?;
        Ok(())
    }

    async fn cancel(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Cancel,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        let id = self.inner.job_id().await?;
        let rb = self
            .inner
            .client
            .delete(format!("{}/api/v1/job/{id}", self.inner.base));
        self.inner.send(rb).await?;
        Ok(())
    }

    async fn snapshot(&self) -> Result<Option<Image>> {
        self.inner.snap_once().await
    }

    /// PrusaLink cameras answer stills only, so the stream is a poll, about three frames a second.
    async fn stream(&self) -> Result<Option<FrameStream>> {
        if !self.inner.camera.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let inner = self.inner.clone();
        Ok(Some(camera::poll_snapshots(
            Duration::from_millis(300),
            move || {
                let inner = inner.clone();
                async move { inner.snap_once().await.ok().flatten().map(|i| i.data) }
            },
        )))
    }

    /// PrusaLink has no G-code console endpoint in the v1 API.
    async fn send_gcode(&self, _line: &str, _token: &ApprovalToken) -> Result<()> {
        Err(Error::not_supported("prusalink", "the G-code console"))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn uploads_go_to_a_writable_storage_usb_first() {
        let v = json!({ "storage_list": [
            { "type": "LOCAL", "path": "/local", "available": true, "read_only": false },
            { "type": "USB", "path": "/usb", "available": true, "read_only": false },
        ]});
        assert_eq!(pick_storage(&v), Some(StorageChoice::Use("usb".into())));
        let v = json!({ "storage_list": [
            { "type": "USB", "path": "/usb", "available": false, "read_only": false },
            { "type": "LOCAL", "path": "/local", "available": true, "read_only": false },
        ]});
        assert_eq!(pick_storage(&v), Some(StorageChoice::Use("local".into())));
        let v = json!({ "storage_list": [
            { "type": "USB", "path": "/usb", "available": false, "read_only": false },
            { "type": "SDCARD", "path": "/sdcard", "available": true, "read_only": true },
        ]});
        assert_eq!(pick_storage(&v), Some(StorageChoice::Nothing));
        assert_eq!(
            pick_storage(&json!({ "storage_list": [] })),
            Some(StorageChoice::Nothing)
        );
        assert_eq!(pick_storage(&json!({ "other": 1 })), None);
    }

    #[test]
    fn stopped_and_ready_read_as_idle() {
        let st = |s: &str| json!({ "printer": { "state": s, "temp_nozzle": 25.0, "temp_bed": 24.0 } });
        let stopped = parse_status("p", &st("STOPPED"), None, false);
        assert_eq!(stopped.state, PrinterState::Idle);
        assert_eq!(stopped.message.as_deref(), Some("The print was stopped"));
        let ready = parse_status("p", &st("READY"), None, false);
        assert_eq!((ready.state, ready.message), (PrinterState::Idle, None));
    }

    #[test]
    fn hardware_reads_serial_firmware_and_a_named_model() {
        let info = json!({ "nozzle_diameter": 0.6, "mmu": true, "serial": "CZPX4720X004XC34242" });
        let version = json!({ "text": "PrusaLink", "firmware": "6.2.4+9302", "original": "PrusaLink MK4S" });
        let h = prusalink_hardware(&info, Some(&version));
        assert_eq!(h.serial.as_deref(), Some("CZPX4720X004XC34242"));
        assert_eq!(h.firmware.as_deref(), Some("6.2.4+9302"));
        assert_eq!(h.model.as_deref(), Some("MK4S"));
        assert_eq!(h.extruders[0].nozzle_diameter_mm, Some(0.6));
        assert_eq!(h.filament_units[0].slots.len(), 5);
        let core = json!({ "original": "Prusa Core One L" });
        assert_eq!(model_from_version(&core).as_deref(), Some("Core One L"));
        assert_eq!(model_from_version(&json!({ "text": "PrusaLink 0.7.0" })), None);
    }
}
