// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! OctoPrint REST API. Authentication is the `X-Api-Key` header. Status is polled; the
//! push channel (SockJS) is not used.
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::multipart::{Form, Part};
use reqwest::{Client, RequestBuilder};
use serde_json::{Value, json};

use crate::camera::{self, FrameStream};
use crate::error::{Error, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http::{self, base_url, f64_at, seg, str_at};
use crate::manifest::{PluginManifest, manifest};
use crate::poll::poll_events_every;
use crate::tunnel::Tunnel;
use crate::types::{
    Adjustment, Capabilities, Capability, DiscoveredPrinter, ExtruderInfo, FileInfo, Image, JobFile,
    PrinterConfig, PrinterEvent, PrinterHardware, PrinterState, PrinterStatus, RemoteFile, Secrets,
    StartOptions, Temp, now_iso, secs,
};
use crate::{PrinterConnector, PrinterSession};

pub struct OctoPrintConnector {
    gate: Arc<dyn ApprovalGate>,
}

impl OctoPrintConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self { gate }
    }
}

#[async_trait]
impl PrinterConnector for OctoPrintConnector {
    fn manifest(&self) -> PluginManifest {
        manifest("octoprint").unwrap_or_else(|| super::prusalink::unreachable_manifest("octoprint"))
    }

    /// OctoPrint announces `_octoprint._tcp` over mDNS. The user enters the host.
    async fn discover(&self, _timeout: Duration) -> Vec<DiscoveredPrinter> {
        Vec::new()
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        // Through a tunnel, `credential_ref` is the tunnel's credential, sent by the tunnel's client.
        let tunnel = match cfg.tunnel {
            Some(_) => Some(Arc::new(Tunnel::open(cfg, secrets).await?)),
            None => None,
        };
        let (client, base, key) = match &tunnel {
            Some(t) => (t.client(), t.base().to_owned(), None),
            None => (
                http::client(cfg)?,
                base_url(cfg, 5000),
                cfg.credential_ref.as_deref().and_then(|r| secrets.get(r)),
            ),
        };
        let inner = Arc::new(Inner {
            cfg: cfg.clone(),
            client,
            base,
            key,
            gate: self.gate.clone(),
            camera: AtomicBool::new(false),
            tunnel,
        });
        // /api/version needs a valid key, so it doubles as the auth check.
        http::send(&cfg.id, inner.get("/api/version")).await?;
        // The printer's camera URLs point at the local network; through a tunnel there is none yet.
        let cam = inner.tunnel.is_none() && inner.snapshot_url().await.is_some();
        inner.camera.store(cam, Ordering::Relaxed);
        Ok(Box::new(OctoPrintSession { inner }))
    }
}

/// The hardware in an `/api/printerprofiles` reply, from the profile marked current (else the default).
pub(crate) fn octoprint_hardware(v: &Value) -> PrinterHardware {
    let profiles: Vec<&Value> = v
        .get("profiles")
        .and_then(Value::as_object)
        .map(|o| o.values().collect())
        .unwrap_or_default();
    let flag = |p: &&Value, k: &str| p.get(k).and_then(Value::as_bool) == Some(true);
    let Some(p) = profiles
        .iter()
        .find(|p| flag(p, "current"))
        .or_else(|| profiles.iter().find(|p| flag(p, "default")))
    else {
        return PrinterHardware::default();
    };
    let count = p
        .get("extruder")
        .and_then(|e| e.get("count"))
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, 8);
    // `sharedNozzle`: several filaments through one nozzle (a Prusa MMU on OctoPrint).
    let shared = p
        .get("extruder")
        .and_then(|e| e.get("sharedNozzle"))
        .and_then(Value::as_bool)
        == Some(true);
    let diameter = p
        .get("extruder")
        .and_then(|e| e.get("nozzleDiameter"))
        .and_then(Value::as_f64);
    let nozzles = if shared { 1 } else { count };
    PrinterHardware {
        model: p
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        firmware: None,
        extruders: (0..nozzles)
            .map(|n| ExtruderInfo {
                tool: u8::try_from(n).unwrap_or(0),
                nozzle_diameter_mm: diameter,
                ..ExtruderInfo::default()
            })
            .collect(),
        filament_units: Vec::new(),
        ..PrinterHardware::default()
    }
}

struct Inner {
    cfg: PrinterConfig,
    client: Client,
    base: String,
    key: Option<String>,
    gate: Arc<dyn ApprovalGate>,
    camera: AtomicBool,
    /// The remote tunnel the printer is reached through, if any.
    tunnel: Option<Arc<Tunnel>>,
}

impl Inner {
    fn id(&self) -> &str {
        &self.cfg.id
    }

    /// Status from the printer, or through a tunnel at most once per its polling interval.
    async fn status(&self) -> Result<PrinterStatus> {
        match &self.tunnel {
            Some(t) => t.status(|| self.fetch_status()).await,
            None => self.fetch_status().await,
        }
    }

    /// After a print action, the next status reading goes to the printer even through a tunnel.
    async fn forget_status(&self) {
        if let Some(t) = &self.tunnel {
            t.forget_status().await;
        }
    }

    fn auth(&self, rb: RequestBuilder) -> RequestBuilder {
        match &self.key {
            Some(k) => rb.header("X-Api-Key", k),
            None => rb,
        }
    }

    fn get(&self, path: &str) -> RequestBuilder {
        self.auth(self.client.get(format!("{}{path}", self.base)))
    }

    fn post(&self, path: &str) -> RequestBuilder {
        self.auth(self.client.post(format!("{}{path}", self.base)))
    }

    async fn snapshot_url(&self) -> Option<String> {
        let resp = http::send(self.id(), self.get("/api/settings")).await.ok()?;
        let v = http::json(self.id(), resp).await.ok()?;
        let cam = v.get("webcam")?;
        if !cam.get("webcamEnabled").and_then(Value::as_bool).unwrap_or(true) {
            return None;
        }
        let url = cam
            .get("snapshotUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())?;
        if url.starts_with("http") {
            http::same_host(url, &self.cfg.host).then(|| url.to_owned())
        } else {
            Some(format!(
                "http://{}{}{}",
                self.cfg.host,
                if url.starts_with('/') { "" } else { "/" },
                url
            ))
        }
    }

    async fn webcam_stream_url(&self) -> Option<String> {
        let resp = http::send(self.id(), self.get("/api/settings")).await.ok()?;
        let v = http::json(self.id(), resp).await.ok()?;
        let cam = v.get("webcam")?;
        if !cam.get("webcamEnabled").and_then(Value::as_bool).unwrap_or(true) {
            return None;
        }
        let url = cam
            .get("streamUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())?;
        if url.starts_with("http") {
            http::same_host(url, &self.cfg.host).then(|| url.to_owned())
        } else {
            Some(format!(
                "http://{}{}{}",
                self.cfg.host,
                if url.starts_with('/') { "" } else { "/" },
                url
            ))
        }
    }

    async fn fetch_status(&self) -> Result<PrinterStatus> {
        let printer = self
            .get("/api/printer")
            .send()
            .await
            .map_err(|e| Error::unreachable(self.id(), e.without_url()))?;
        if let Some(e) = crate::tunnel::refusal(self.id(), &printer) {
            return Err(e);
        }
        let job_resp = http::send(self.id(), self.get("/api/job")).await?;
        let job = http::json(self.id(), job_resp).await?;
        let camera = self.camera.load(Ordering::Relaxed);
        // 409 means OctoPrint is up but its serial connection to the printer is closed.
        if printer.status().as_u16() == 409 {
            let mut s = PrinterStatus::offline(self.id());
            s.message = Some("OctoPrint is not connected to the printer".to_owned());
            return Ok(s);
        }
        let printer = http::check(self.id(), printer)?;
        let printer = http::json(self.id(), printer).await?;
        Ok(parse_status(self.id(), &printer, &job, camera))
    }
}

pub(crate) fn parse_status(id: &str, printer: &Value, job: &Value, camera: bool) -> PrinterStatus {
    let flag = |k: &str| {
        printer
            .get("state")
            .and_then(|s| s.get("flags"))
            .and_then(|f| f.get(k))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let completion = f64_at(job, &["progress", "completion"]);
    let file = str_at(job, &["job", "file", "name"]);
    let state = if flag("error") || flag("closedOrError") {
        PrinterState::Error
    } else if flag("paused") || flag("pausing") {
        PrinterState::Paused
    } else if flag("printing") || flag("cancelling") {
        PrinterState::Printing
    } else if file.is_some() && completion.is_some_and(|c| c >= 100.0) {
        PrinterState::Finished
    } else {
        PrinterState::Idle
    };
    let temps = printer.get("temperature").cloned().unwrap_or(Value::Null);
    let temp = |k: &str| -> Option<Temp> {
        Some(Temp {
            current: f64_at(&temps, &[k, "actual"])?,
            target: f64_at(&temps, &[k, "target"]).unwrap_or(0.0),
        })
    };
    let mut nozzles = Vec::new();
    for i in 0..8 {
        match temp(&format!("tool{i}")) {
            Some(t) => nozzles.push(t),
            None => break,
        }
    }
    let message = str_at(printer, &["state", "error"])
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: file.map(str::to_owned),
        progress: completion.map(|c| c / 100.0),
        layer: None,
        layer_count: None,
        time_left_s: f64_at(job, &["progress", "printTimeLeft"]).map(secs),
        nozzles,
        bed: temp("bed"),
        chamber: temp("chamber"),
        slots: Vec::new(),
        camera_available: camera,
        message,
        updated_at: now_iso(),
        live: None,
    }
}

pub struct OctoPrintSession {
    inner: Arc<Inner>,
}

#[async_trait]
impl PrinterSession for OctoPrintSession {
    fn capabilities(&self) -> Capabilities {
        let mut c = vec![
            Capability::Status,
            Capability::Events,
            Capability::Upload,
            Capability::Start,
            Capability::Pause,
            Capability::Resume,
            Capability::Cancel,
            Capability::GcodeConsole,
        ];
        if self.inner.camera.load(Ordering::Relaxed) {
            c.push(Capability::Camera);
        }
        c
    }

    async fn status(&self) -> Result<PrinterStatus> {
        self.inner.status().await
    }

    /// The current printer profile: its model name, extruder count and nozzle diameter.
    async fn hardware(&self) -> Result<Option<PrinterHardware>> {
        let v = http::get_json(&self.inner.cfg.id, self.inner.get("/api/printerprofiles")).await;
        Ok(v.as_ref().map(octoprint_hardware))
    }

    fn events(&self) -> BoxStream<'static, PrinterEvent> {
        let inner = self.inner.clone();
        let id = inner.cfg.id.clone();
        let every = Tunnel::every(inner.tunnel.as_ref(), inner.cfg.poll_interval());
        poll_events_every(
            id,
            every,
            Arc::new(move || {
                let inner = inner.clone();
                async move { inner.status().await }
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
        if let Some(t) = &self.inner.tunnel {
            t.check_upload(file.data.len()).await?;
        }
        let form = Form::new().text("select", "false").text("print", "false").part(
            "file",
            Part::bytes(file.data.clone()).file_name(file.name.clone()),
        );
        http::send(
            self.inner.id(),
            self.inner.post("/api/files/local").multipart(form),
        )
        .await?;
        Ok(RemoteFile {
            printer_id: self.inner.id().to_owned(),
            path: file.name.clone(),
            name: file.name,
            sha256: Some(file.sha256),
        })
    }

    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()> {
        opts.refuse_slot_map("octoprint")?;
        self.inner.gate.check(
            token,
            Action::Start,
            self.inner.id(),
            &params::start(self.inner.id(), file, &opts),
        )?;
        let rb = self
            .inner
            .post(&format!("/api/files/local/{}", seg(&file.path)))
            .json(&json!({ "command": "select", "print": true }));
        http::send(self.inner.id(), rb).await?;
        self.inner.forget_status().await;
        Ok(())
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Pause,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        http::send(
            self.inner.id(),
            self.inner
                .post("/api/job")
                .json(&json!({ "command": "pause", "action": "pause" })),
        )
        .await?;
        self.inner.forget_status().await;
        Ok(())
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Resume,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        http::send(
            self.inner.id(),
            self.inner
                .post("/api/job")
                .json(&json!({ "command": "pause", "action": "resume" })),
        )
        .await?;
        self.inner.forget_status().await;
        Ok(())
    }

    async fn cancel(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Cancel,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        http::send(
            self.inner.id(),
            self.inner.post("/api/job").json(&json!({ "command": "cancel" })),
        )
        .await?;
        self.inner.forget_status().await;
        Ok(())
    }

    async fn stream(&self) -> Result<Option<FrameStream>> {
        if !self.inner.camera.load(Ordering::Relaxed) {
            return Ok(None);
        }
        if let Some(url) = self.inner.webcam_stream_url().await
            && let Some(s) = camera::mjpeg_stream(&self.inner.client, &url).await
        {
            return Ok(Some(s));
        }
        let Some(url) = self.inner.snapshot_url().await else {
            return Ok(None);
        };
        let client = self.inner.client.clone();
        Ok(Some(camera::poll_snapshots(
            Duration::from_millis(250),
            move || {
                let (client, url) = (client.clone(), url.clone());
                async move {
                    let r = client.get(url).send().await.ok()?;
                    r.status().is_success().then_some(())?;
                    r.bytes().await.ok().map(|b| b.to_vec())
                }
            },
        )))
    }

    async fn file_info(&self, path: &str) -> Result<Option<FileInfo>> {
        // OctoPrint's file API: `size` in bytes and `date` in seconds since the epoch.
        let resp = http::send(
            self.inner.id(),
            self.inner.get(&format!("/api/files/local/{}", http::seg(path))),
        )
        .await?;
        let v = http::json(self.inner.id(), resp).await?;
        Ok(v.get("size")
            .and_then(serde_json::Value::as_u64)
            .map(|size| FileInfo {
                size,
                modified: v.get("date").and_then(serde_json::Value::as_f64),
            }))
    }

    async fn snapshot(&self) -> Result<Option<Image>> {
        if !self.inner.camera.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let Some(url) = self.inner.snapshot_url().await else {
            return Ok(None);
        };
        let resp = http::send(self.inner.id(), self.inner.client.get(url)).await?;
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/jpeg")
            .to_owned();
        let data = resp
            .bytes()
            .await
            .map_err(|e| Error::protocol(self.inner.id(), e.without_url()))?
            .to_vec();
        Ok(Some(Image { content_type, data }))
    }

    async fn adjust(&self, change: &Adjustment, token: &ApprovalToken) -> Result<()> {
        let Some(line) = change.marlin_gcode() else {
            return Err(Error::not_supported("octoprint", "this fan"));
        };
        self.inner.gate.check(
            token,
            Action::Adjust,
            self.inner.id(),
            &params::adjust(self.inner.id(), change),
        )?;
        http::send(
            self.inner.id(),
            self.inner
                .post("/api/printer/command")
                .json(&json!({ "command": line })),
        )
        .await?;
        Ok(())
    }

    async fn send_gcode(&self, line: &str, token: &ApprovalToken) -> Result<()> {
        // One command per call: a card showed this line whole, and nothing may ride behind it.
        crate::gate::one_gcode_line(self.inner.id(), line)?;
        self.inner.gate.check(
            token,
            Action::Gcode,
            self.inner.id(),
            &params::gcode(self.inner.id(), line),
        )?;
        http::send(
            self.inner.id(),
            self.inner
                .post("/api/printer/command")
                .json(&json!({ "command": line })),
        )
        .await?;
        Ok(())
    }
}
