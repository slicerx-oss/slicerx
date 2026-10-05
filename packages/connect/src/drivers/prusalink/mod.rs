// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! PrusaLink local API (`/api/v1`), used by the MK4S, MK3.9, MINI+, XL, Core One and other
//! Prusa printers with PrusaLink. Authentication is the `X-Api-Key` header, or HTTP digest login
//! when the config names a `username`.
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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
            (Some(user), Some(pass)) => Auth::Digest(DigestAuth::new(user, &pass)),
            (Some(_), None) => {
                return Err(Error::Auth {
                    printer: cfg.id.clone(),
                });
            }
            (None, Some(key)) => Auth::Key(key),
            (None, None) => Auth::None,
        };
        let inner = Arc::new(Inner {
            cfg: cfg.clone(),
            client: http::client(cfg)?,
            base: base_url(cfg, 80),
            auth,
            gate: self.gate.clone(),
            camera: AtomicBool::new(false),
        });
        // /api/v1/info answers without a job and proves the key works.
        inner.send(inner.get("/api/v1/info")).await?;
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

/// The hardware in an `/api/v1/info` reply. The MMU3 has five slots.
pub(crate) fn prusalink_hardware(v: &Value) -> PrinterHardware {
    let mmu = v.get("mmu").and_then(Value::as_bool) == Some(true);
    PrinterHardware {
        model: None,
        firmware: None,
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
    auth: Auth,
    gate: Arc<dyn ApprovalGate>,
    camera: AtomicBool,
}

enum Auth {
    None,
    Key(String),
    Digest(DigestAuth),
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

    fn auth(&self, rb: RequestBuilder) -> RequestBuilder {
        match &self.auth {
            Auth::Key(k) => rb.header("X-Api-Key", k),
            _ => rb,
        }
    }

    /// Sends a request. With digest login the first request gets a 401 and its challenge, which is
    /// answered once and remembered for the rest of the session.
    async fn send_raw(&self, rb: RequestBuilder) -> Result<Response> {
        let Auth::Digest(digest) = &self.auth else {
            return rb
                .send()
                .await
                .map_err(|e| Error::unreachable(self.id(), e.without_url()));
        };
        let mut req = rb
            .build()
            .map_err(|e| Error::Config(e.without_url().to_string()))?;
        let retry = req.try_clone();
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
        let resp = self
            .client
            .execute(req)
            .await
            .map_err(|e| Error::unreachable(self.id(), e.without_url()))?;
        if resp.status().as_u16() != 401 {
            return Ok(resp);
        }
        let challenge = resp
            .headers()
            .get_all(reqwest::header::WWW_AUTHENTICATE)
            .iter()
            .find_map(|v| v.to_str().ok().and_then(Challenge::parse));
        let (Some(challenge), Some(mut again)) = (challenge, retry) else {
            return Ok(resp);
        };
        digest.set_challenge(challenge);
        sign(&mut again);
        self.client
            .execute(again)
            .await
            .map_err(|e| Error::unreachable(self.id(), e.without_url()))
    }

    async fn send(&self, rb: RequestBuilder) -> Result<Response> {
        http::check(self.id(), self.send_raw(rb).await?)
    }

    fn get(&self, path: &str) -> RequestBuilder {
        self.auth(self.client.get(format!("{}{path}", self.base)))
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
        "PRINTING" => (PrinterState::Printing, None),
        "PAUSED" => (PrinterState::Paused, None),
        "ATTENTION" => (PrinterState::Paused, Some("Printer needs attention".to_owned())),
        "BUSY" => (PrinterState::Preparing, None),
        "FINISHED" => (PrinterState::Finished, None),
        "ERROR" => (PrinterState::Error, None),
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

    /// The nozzle diameter and whether an MMU is attached, from `/api/v1/info`.
    async fn hardware(&self) -> Result<Option<PrinterHardware>> {
        let resp = self.inner.send(self.inner.get("/api/v1/info")).await.ok();
        let v = match resp {
            Some(r) => http::json(self.inner.id(), r).await.ok(),
            None => None,
        };
        Ok(v.as_ref().map(prusalink_hardware))
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
        let path = format!("/api/v1/files/usb/{}", seg(&file.name));
        let rb = self
            .inner
            .auth(self.inner.client.put(format!("{}{path}", self.inner.base)))
            .header("Content-Type", "application/octet-stream")
            .header("Overwrite", "?1")
            .header("Print-After-Upload", "?0")
            .body(file.data.clone());
        self.inner.send(rb).await?;
        Ok(RemoteFile {
            printer_id: self.inner.id().to_owned(),
            path: format!("usb/{}", file.name),
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
        let rb = self.inner.auth(self.inner.client.post(format!(
            "{}/api/v1/files/{}/{}",
            self.inner.base,
            seg(storage),
            seg(rest)
        )));
        self.inner.send(rb).await?;
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
        let rb = self.inner.auth(
            self.inner
                .client
                .put(format!("{}/api/v1/job/{id}/pause", self.inner.base)),
        );
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
        let rb = self.inner.auth(
            self.inner
                .client
                .put(format!("{}/api/v1/job/{id}/resume", self.inner.base)),
        );
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
        let rb = self.inner.auth(
            self.inner
                .client
                .delete(format!("{}/api/v1/job/{id}", self.inner.base)),
        );
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
