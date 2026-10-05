// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Moonraker (Klipper) over its HTTP API. Also the transport for Klipper based Creality and
//! Snapmaker models, which pass their own plugin id.
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::multipart::{Form, Part};
use reqwest::{Client, RequestBuilder};
use serde_json::Value;

use crate::camera::{self, FrameStream};
use crate::error::{Error, LoginNeed, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http::{self, base_url, f64_at, str_at};
use crate::manifest::{PluginManifest, manifest};
use crate::poll::poll_events;
use crate::types::{
    Adjustment, Capabilities, Capability, DiscoveredPrinter, ExtruderInfo, Fans, FilamentSlot, FilamentUnit,
    FileInfo, Image, JobFile, PrintObject, PrintRecord, PrinterConfig, PrinterEvent, PrinterHardware,
    PrinterLive, PrinterState, PrinterStatus, RemoteFile, Secrets, StartOptions, StoredFile, Temp, now_iso,
    secs,
};
use crate::{PrinterConnector, PrinterSession};

pub struct MoonrakerConnector {
    plugin: &'static str,
    default_port: u16,
    gate: Arc<dyn ApprovalGate>,
}

impl MoonrakerConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            plugin: "moonraker",
            default_port: 7125,
            gate,
        }
    }

    /// Klipper based models that speak Moonraker but carry their own plugin id.
    pub(crate) fn for_plugin(plugin: &'static str, default_port: u16, gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            plugin,
            default_port,
            gate,
        }
    }
}

#[async_trait]
impl PrinterConnector for MoonrakerConnector {
    fn manifest(&self) -> PluginManifest {
        manifest(self.plugin).unwrap_or_else(|| PluginManifest {
            id: self.plugin.to_owned(),
            name: self.plugin.to_owned(),
            version: "0.1.0".to_owned(),
            kind: crate::PluginKind::Printer,
            protocols: vec!["http".to_owned()],
            capabilities: Vec::new(),
            tools: Vec::new(),
            network: Vec::new(),
        })
    }

    /// Moonraker announces itself over mDNS (`_moonraker._tcp`). Discovery is
    /// manual: the user enters the host.
    async fn discover(&self, _timeout: Duration) -> Vec<DiscoveredPrinter> {
        Vec::new()
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        let key = cfg.credential_ref.as_deref().and_then(|r| secrets.get(r));
        let client = http::client(cfg)?;
        let base = base_url(cfg, self.default_port);
        let inner = Arc::new(Inner {
            cfg: cfg.clone(),
            plugin: self.plugin,
            client,
            base,
            key,
            gate: self.gate.clone(),
            camera: AtomicBool::new(false),
        });
        // Reaching the server is the connection test. The camera list is best effort.
        if let Err(e) = http::send(&cfg.id, inner.get("/server/info")).await {
            return Err(match e {
                Error::Auth { .. } => inner.login_error().await,
                e => e,
            });
        }
        inner
            .camera
            .store(inner.webcam_snapshot_url().await.is_some(), Ordering::Relaxed);
        Ok(Box::new(MoonrakerSession { inner }))
    }
}

/// Why a server refused a request sent without a key, from its `/access/info` reply (None when it
/// has none: Moonraker before `login_required` was reported).
fn login_need_without_key(info: Option<&Value>) -> LoginNeed {
    let forced = info
        .and_then(|v| v.pointer("/result/login_required"))
        .and_then(Value::as_bool)
        == Some(true);
    if forced {
        LoginNeed::LoginRequired
    } else {
        LoginNeed::NotTrusted
    }
}

struct Inner {
    cfg: PrinterConfig,
    plugin: &'static str,
    client: Client,
    base: String,
    key: Option<String>,
    gate: Arc<dyn ApprovalGate>,
    camera: AtomicBool,
}

impl Inner {
    fn id(&self) -> &str {
        &self.cfg.id
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

    /// Why `/server/info` was refused. `/access/info` answers without a sign-in and says whether
    /// logins are forced; an API key passes either way, so a refused key is a wrong key.
    async fn login_error(&self) -> Error {
        let need = if self.key.is_some() {
            LoginNeed::KeyWrong
        } else {
            let url = format!("{}/access/info", self.base);
            let info = match http::send(self.id(), self.client.get(url)).await {
                Ok(r) => http::json(self.id(), r).await.ok(),
                Err(_) => None,
            };
            login_need_without_key(info.as_ref())
        };
        Error::Login {
            printer: self.id().to_owned(),
            need,
        }
    }

    fn post(&self, path: &str) -> RequestBuilder {
        self.auth(self.client.post(format!("{}{path}", self.base)))
    }

    async fn webcam_snapshot_url(&self) -> Option<String> {
        let resp = http::send(self.id(), self.get("/server/webcams/list"))
            .await
            .ok()?;
        let v = http::json(self.id(), resp).await.ok()?;
        let cams = v.get("result")?.get("webcams")?.as_array()?;
        let url = cams
            .iter()
            .find_map(|c| c.get("snapshot_url").and_then(Value::as_str))?;
        if url.starts_with("http") {
            http::same_host(url, &self.cfg.host).then(|| url.to_owned())
        } else {
            // Relative webcam URLs are served by the web frontend on the default port.
            Some(format!(
                "http://{}{}{}",
                self.cfg.host,
                if url.starts_with('/') { "" } else { "/" },
                url
            ))
        }
    }

    /// The MJPEG stream URL of the first webcam that offers one (crowsnest's ustreamer, mjpg-streamer).
    /// WebRTC and HLS webcam services are not read; those webcams fall back to their snapshot URL.
    async fn webcam_stream_url(&self) -> Option<String> {
        let resp = http::send(self.id(), self.get("/server/webcams/list"))
            .await
            .ok()?;
        let v = http::json(self.id(), resp).await.ok()?;
        let cams = v.get("result")?.get("webcams")?.as_array()?;
        let url = cams.iter().find_map(|c| {
            let service = c
                .get("service")
                .and_then(Value::as_str)
                .unwrap_or("mjpegstreamer");
            let url = c.get("stream_url").and_then(Value::as_str)?;
            service.contains("mjpeg").then_some(url)
        })?;
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

    /// The WebRTC signaling of the first webcam whose service Mainsail and Fluidd record as WebRTC.
    async fn webcam_signaling(&self) -> Option<camera::Signaling> {
        let resp = http::send(self.id(), self.get("/server/webcams/list"))
            .await
            .ok()?;
        let v = http::json(self.id(), resp).await.ok()?;
        let cams = v.get("result")?.get("webcams")?.as_array()?;
        cams.iter().find_map(|c| {
            let service = c.get("service").and_then(Value::as_str)?;
            let url = c.get("stream_url").and_then(Value::as_str)?;
            let url = if url.starts_with("http") {
                http::same_host(url, &self.cfg.host).then(|| url.to_owned())?
            } else {
                format!(
                    "http://{}{}{}",
                    self.cfg.host,
                    if url.starts_with('/') { "" } else { "/" },
                    url
                )
            };
            camera::Signaling::from_webcam(service, url)
        })
    }

    async fn fetch_status(&self) -> Result<PrinterStatus> {
        // Objects that do not exist on this printer are omitted from the reply.
        let rb = self.get("/printer/objects/query").query(&[
            ("print_stats", ""),
            ("virtual_sdcard", ""),
            ("extruder", ""),
            ("extruder1", ""),
            ("extruder2", ""),
            ("extruder3", ""),
            ("extruder4", ""),
            ("extruder5", ""),
            ("heater_bed", ""),
            ("temperature_sensor chamber", ""),
            ("heater_generic chamber", ""),
            ("fan", "speed"),
            ("gcode_move", "speed_factor,gcode_position"),
        ]);
        let resp = rb
            .send()
            .await
            .map_err(|e| Error::unreachable(self.id(), e.without_url()))?;
        if resp.status().as_u16() == 503 {
            let mut s = PrinterStatus::offline(self.id());
            s.state = PrinterState::Error;
            s.message = Some("Klipper is not ready".to_owned());
            return Ok(s);
        }
        let resp = http::check(self.id(), resp)?;
        let v = http::json(self.id(), resp).await?;
        Ok(parse_status(self.id(), &v, self.camera.load(Ordering::Relaxed)))
    }

    fn token(&self, token: &ApprovalToken, action: Action, params: &str) -> Result<()> {
        self.gate.check(token, action, self.id(), params)
    }
}

/// The hardware in a `configfile` and `mmu` query and a `printer/info` reply.
pub(crate) fn moonraker_hardware(q: Option<&Value>, info: Option<&Value>) -> PrinterHardware {
    let status = q.and_then(|v| v.get("result")).and_then(|r| r.get("status"));
    let settings = status
        .and_then(|s| s.get("configfile"))
        .and_then(|c| c.get("settings"))
        .and_then(Value::as_object);
    let mut extruders = Vec::new();
    for n in 0_u8..6 {
        let key = if n == 0 {
            "extruder".to_owned()
        } else {
            format!("extruder{n}")
        };
        let Some(sec) = settings.and_then(|s| s.get(&key)) else {
            break;
        };
        extruders.push(ExtruderInfo {
            tool: n,
            nozzle_diameter_mm: sec.get("nozzle_diameter").and_then(Value::as_f64),
            ..ExtruderInfo::default()
        });
    }
    let mut filament_units = Vec::new();
    if let Some(mmu) = status.and_then(|s| s.get("mmu")) {
        let gates = mmu.get("num_gates").and_then(Value::as_u64).unwrap_or(0);
        let text = |k: &str, g: usize| {
            mmu.get(k)
                .and_then(Value::as_array)
                .and_then(|a| a.get(g))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let slots = (0..usize::try_from(gates).unwrap_or(0))
            .map(|g| FilamentSlot {
                id: format!("{}", g + 1),
                material: text("gate_material", g),
                color: text("gate_color", g)
                    .map(|c| format!("#{}", c.trim_start_matches('#').to_ascii_lowercase())),
                remaining_pct: None,
                spoolman_id: None,
                spool_uid: None,
            })
            .collect();
        if gates > 0 {
            filament_units.push(FilamentUnit {
                id: "mmu".to_owned(),
                kind: "mmu".to_owned(),
                tool: None,
                slots,
            });
        }
    }
    let r = info.and_then(|v| v.get("result"));
    PrinterHardware {
        model: None,
        firmware: r
            .and_then(|r| r.get("software_version"))
            .and_then(Value::as_str)
            .map(|v| format!("Klipper {v}")),
        extruders,
        filament_units,
        ..PrinterHardware::default()
    }
}

/// Maps a `printer/objects/query` reply to the normalized status.
pub(crate) fn parse_status(id: &str, v: &Value, camera: bool) -> PrinterStatus {
    let st = v
        .get("result")
        .and_then(|r| r.get("status"))
        .cloned()
        .unwrap_or(Value::Null);
    let state = match str_at(&st, &["print_stats", "state"]).unwrap_or("standby") {
        "printing" => PrinterState::Printing,
        "paused" => PrinterState::Paused,
        "complete" => PrinterState::Finished,
        "error" => PrinterState::Error,
        _ => PrinterState::Idle,
    };
    let progress = f64_at(&st, &["virtual_sdcard", "progress"]);
    let duration = f64_at(&st, &["print_stats", "print_duration"]).unwrap_or(0.0);
    let active = matches!(state, PrinterState::Printing | PrinterState::Paused);
    let time_left = match progress {
        Some(p) if active && p > 0.001 => Some((duration / p - duration).max(0.0)),
        Some(p) if state == PrinterState::Finished && p >= 1.0 => Some(0.0),
        _ => None,
    };
    let filename = str_at(&st, &["print_stats", "filename"]).filter(|s| !s.is_empty());
    let temp = |obj: &str| -> Option<Temp> {
        Some(Temp {
            current: f64_at(&st, &[obj, "temperature"])?,
            target: f64_at(&st, &[obj, "target"]).unwrap_or(0.0),
        })
    };
    let chamber = temp("heater_generic chamber").or_else(|| {
        f64_at(&st, &["temperature_sensor chamber", "temperature"]).map(|c| Temp {
            current: c,
            target: 0.0,
        })
    });
    let layer = |k: &str| {
        st.get("print_stats")
            .and_then(|p| p.get("info"))
            .and_then(|i| i.get(k))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
    };
    let message = str_at(&st, &["print_stats", "message"])
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    // Klipper's `fan` is the part cooling fan (0 to 1), `gcode_move` the M220 speed factor and the
    // head's Z in G-code coordinates, which is the layer printing now while a job runs.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let pct = |f: f64| (f * 100.0).round().clamp(0.0, 1000.0) as u16;
    let live = PrinterLive {
        fans: f64_at(&st, &["fan", "speed"]).map(|f| Fans {
            part: u8::try_from(pct(f).min(100)).ok(),
            ..Fans::default()
        }),
        speed_percent: f64_at(&st, &["gcode_move", "speed_factor"]).map(pct),
        layer_z_mm: st
            .get("gcode_move")
            .and_then(|g| g.get("gcode_position"))
            .and_then(|p| p.get(2))
            .and_then(Value::as_f64)
            .filter(|_| active)
            .map(|z| (z * 100.0).round() / 100.0),
        ..PrinterLive::default()
    };
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: filename.map(str::to_owned),
        progress: if filename.is_some() { progress } else { None },
        layer: layer("current_layer"),
        layer_count: layer("total_layer"),
        time_left_s: time_left.map(secs),
        nozzles: [
            "extruder",
            "extruder1",
            "extruder2",
            "extruder3",
            "extruder4",
            "extruder5",
        ]
        .iter()
        .map_while(|o| temp(o))
        .collect(),
        bed: temp("heater_bed"),
        chamber,
        slots: Vec::new(),
        camera_available: camera,
        message,
        updated_at: now_iso(),
        live: (live != PrinterLive::default()).then(|| Box::new(live)),
    }
}

pub struct MoonrakerSession {
    inner: Arc<Inner>,
}

#[async_trait]
impl PrinterSession for MoonrakerSession {
    /// Klipper's `idle_timeout` (always loaded, 600 s unless printer.cfg changes it) runs
    /// `TURN_OFF_HEATERS` once a paused print has sat idle that long.
    fn pause_heater_timeout(&self) -> Option<std::time::Duration> {
        Some(std::time::Duration::from_secs(600))
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
            Capability::GcodeConsole,
        ];
        if self.inner.camera.load(Ordering::Relaxed) {
            c.push(Capability::Camera);
        }
        c
    }

    async fn status(&self) -> Result<PrinterStatus> {
        self.inner.fetch_status().await
    }

    /// Nozzle diameters from Klipper's own config (`configfile.settings`, one `extruder` section
    /// per tool), the Klipper version from `printer/info`, and the gates of a Happy Hare MMU.
    async fn hardware(&self) -> Result<Option<PrinterHardware>> {
        let i = &self.inner;
        let id = i.cfg.id.as_str();
        let q = http::get_json(
            id,
            i.get("/printer/objects/query")
                .query(&[("configfile", "settings"), ("mmu", "")]),
        )
        .await;
        let info = http::get_json(id, i.get("/printer/info")).await;
        Ok(Some(moonraker_hardware(q.as_ref(), info.as_ref())))
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
        self.inner.token(
            token,
            Action::Upload,
            &params::upload(self.inner.id(), &file.name, &file.sha256),
        )?;
        let form = Form::new().text("root", "gcodes").text("print", "false").part(
            "file",
            Part::bytes(file.data.clone()).file_name(file.name.clone()),
        );
        let resp = http::send(
            self.inner.id(),
            self.inner.post("/server/files/upload").multipart(form),
        )
        .await?;
        let v = http::json(self.inner.id(), resp).await?;
        let path = str_at(&v, &["item", "path"]).unwrap_or(&file.name).to_owned();
        Ok(RemoteFile {
            printer_id: self.inner.id().to_owned(),
            path,
            name: file.name,
            sha256: Some(file.sha256),
        })
    }

    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()> {
        opts.refuse_slot_map("moonraker")?;
        self.inner
            .token(token, Action::Start, &params::start(self.inner.id(), file, &opts))?;
        http::send(
            self.inner.id(),
            self.inner
                .post("/printer/print/start")
                .query(&[("filename", file.path.as_str())]),
        )
        .await?;
        Ok(())
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.inner
            .token(token, Action::Pause, &params::printer(self.inner.id()))?;
        http::send(self.inner.id(), self.inner.post("/printer/print/pause")).await?;
        Ok(())
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.inner
            .token(token, Action::Resume, &params::printer(self.inner.id()))?;
        http::send(self.inner.id(), self.inner.post("/printer/print/resume")).await?;
        Ok(())
    }

    async fn cancel(&self, token: &ApprovalToken) -> Result<()> {
        self.inner
            .token(token, Action::Cancel, &params::printer(self.inner.id()))?;
        http::send(self.inner.id(), self.inner.post("/printer/print/cancel")).await?;
        Ok(())
    }

    /// Creality K2 printers serve WebRTC on port 8000 (`/call/webrtc_local`); other Klipper cameras
    /// through the webcam service Moonraker lists. Only the signaling passes through here.
    async fn webrtc_offer(&self, offer_sdp: &str) -> Result<Option<String>> {
        let signaling = if self.inner.plugin == "creality" {
            camera::Signaling::Creality(format!(
                "http://{}:{}/call/webrtc_local",
                self.inner.cfg.host,
                self.inner.cfg.camera_port.unwrap_or(8000)
            ))
        } else if let Some(s) = self.inner.webcam_signaling().await {
            s
        } else {
            return Ok(None);
        };
        Ok(camera::webrtc_answer(&self.inner.cfg, &signaling, offer_sdp).await)
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
        // No MJPEG stream: poll the snapshot URL.
        let Some(url) = self.inner.webcam_snapshot_url().await else {
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
        let resp = http::send(
            self.inner.id(),
            self.inner
                .get("/server/files/metadata")
                .query(&[("filename", path)]),
        )
        .await?;
        let v = http::json(self.inner.id(), resp).await?;
        let r = v.get("result");
        let field = |k: &str| r.and_then(|r| r.get(k));
        Ok(field("size")
            .and_then(serde_json::Value::as_u64)
            .map(|size| FileInfo {
                size,
                modified: field("modified").and_then(serde_json::Value::as_f64),
            }))
    }

    async fn snapshot(&self) -> Result<Option<Image>> {
        if !self.inner.camera.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let Some(url) = self.inner.webcam_snapshot_url().await else {
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
        // Klipper's generic fan commands name only the part cooling fan.
        let Some(line) = change.marlin_gcode() else {
            return Err(Error::not_supported("moonraker", "this fan"));
        };
        self.inner
            .token(token, Action::Adjust, &params::adjust(self.inner.id(), change))?;
        http::send(
            self.inner.id(),
            self.inner
                .post("/printer/gcode/script")
                .query(&[("script", line.as_str())]),
        )
        .await?;
        Ok(())
    }

    async fn list_files(&self) -> Result<Vec<StoredFile>> {
        let resp = http::send(
            self.inner.id(),
            self.inner.get("/server/files/list").query(&[("root", "gcodes")]),
        )
        .await?;
        let v = http::json(self.inner.id(), resp).await?;
        Ok(parse_files(&v))
    }

    async fn history(&self) -> Result<Vec<PrintRecord>> {
        let resp = http::send(
            self.inner.id(),
            self.inner
                .get("/server/history/list")
                .query(&[("limit", "50"), ("order", "desc")]),
        )
        .await?;
        let v = http::json(self.inner.id(), resp).await?;
        Ok(parse_history(&v))
    }

    async fn objects(&self) -> Result<Vec<PrintObject>> {
        let resp = http::send(
            self.inner.id(),
            self.inner.get("/printer/objects/query?exclude_object"),
        )
        .await?;
        let v = http::json(self.inner.id(), resp).await?;
        Ok(parse_objects(&v))
    }

    async fn motion(&self) -> Result<crate::Motion> {
        let rb = self
            .inner
            .get("/printer/objects/query")
            .query(&[("toolhead", "position,homed_axes,axis_minimum,axis_maximum")]);
        let v = http::json(self.inner.id(), http::send(self.inner.id(), rb).await?).await?;
        Ok(parse_motion(&v))
    }

    async fn skip_object(&self, id: &str, token: &ApprovalToken) -> Result<()> {
        if !crate::object_id_ok(id) {
            return Err(Error::protocol(self.inner.id(), "that is not an object label"));
        }
        let line = crate::skip_object_line(id);
        self.send_gcode(&line, token).await
    }

    async fn send_gcode(&self, line: &str, token: &ApprovalToken) -> Result<()> {
        // One command per call: a card showed this line whole, and nothing may ride behind it.
        crate::gate::one_gcode_line(self.inner.id(), line)?;
        self.inner
            .token(token, Action::Gcode, &params::gcode(self.inner.id(), line))?;
        http::send(
            self.inner.id(),
            self.inner
                .post("/printer/gcode/script")
                .query(&[("script", line)]),
        )
        .await?;
        Ok(())
    }
}

impl std::fmt::Debug for MoonrakerSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MoonrakerSession")
            .field("printer", &self.inner.cfg.id)
            .field("plugin", &self.inner.plugin)
            .finish()
    }
}

/// `/server/files/list` into stored files, newest first.
pub(crate) fn parse_files(v: &Value) -> Vec<StoredFile> {
    let mut out: Vec<StoredFile> = v
        .get("result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let path = f.get("path").or_else(|| f.get("filename"))?.as_str()?.to_owned();
            let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
            Some(StoredFile {
                path,
                name,
                size: f.get("size").and_then(Value::as_u64),
                modified: f.get("modified").and_then(Value::as_f64),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.modified
            .partial_cmp(&a.modified)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// `/server/history/list` into records.
pub(crate) fn parse_history(v: &Value) -> Vec<PrintRecord> {
    v.get("result")
        .and_then(|r| r.get("jobs"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|j| {
            let name = j.get("filename")?.as_str()?.to_owned();
            let status = j.get("status").and_then(Value::as_str).unwrap_or("");
            let (outcome, detail) = match status {
                "completed" => ("completed", None),
                "cancelled" => ("canceled", None),
                "in_progress" => return None,
                other => ("failed", Some(other.replace('_', " "))),
            };
            Some(PrintRecord {
                name,
                outcome: outcome.to_owned(),
                detail,
                started_at: j.get("start_time").and_then(Value::as_f64),
                duration_s: j
                    .get("total_duration")
                    .or_else(|| j.get("print_duration"))
                    .and_then(Value::as_f64),
                filament_mm: j.get("filament_used").and_then(Value::as_f64),
            })
        })
        .collect()
}

/// `/printer/objects/query?exclude_object` into objects. Empty when the G-code defines none.
pub(crate) fn parse_objects(v: &Value) -> Vec<PrintObject> {
    let eo = v
        .get("result")
        .and_then(|r| r.get("status"))
        .and_then(|s| s.get("exclude_object"));
    let skipped: Vec<&str> = eo
        .and_then(|e| e.get("excluded_objects"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let pt = |p: &Value| -> Option<[f64; 2]> {
        let a = p.as_array()?;
        Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?])
    };
    eo.and_then(|e| e.get("objects"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|o| {
            let id = o.get("name")?.as_str()?.to_owned();
            Some(PrintObject {
                name: display_name(&id),
                skipped: skipped.contains(&id.as_str()),
                id,
                center: o.get("center").and_then(pt),
                polygon: o
                    .get("polygon")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(pt)
                    .collect(),
            })
        })
        .collect()
}

/// Klipper's `toolhead`: `position` (X, Y, Z, E), `homed_axes` ("xyz", "xy", ""), and the limits.
pub(crate) fn parse_motion(v: &Value) -> crate::Motion {
    let th = v
        .get("result")
        .and_then(|r| r.get("status"))
        .and_then(|s| s.get("toolhead"));
    let xyz = |k: &str| -> Option<[f64; 3]> {
        let a = th?.get(k)?.as_array()?;
        Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?])
    };
    let homed = th
        .and_then(|t| t.get("homed_axes"))
        .and_then(Value::as_str)
        .map(|h| {
            let h = h.to_ascii_lowercase();
            [h.contains('x'), h.contains('y'), h.contains('z')]
        });
    crate::Motion {
        homed,
        position: xyz("position"),
        min: xyz("axis_minimum"),
        max: xyz("axis_maximum"),
    }
}

/// `a_b.stl_id_0_copy_0` reads as `a_b`, and `a_b.stl_id_0_copy_1` as `a_b, copy 2`, so copies of
/// one model can be told apart.
fn display_name(label: &str) -> String {
    let (base, rest) = label.split_once("_id_").unwrap_or((label, ""));
    let name = base.strip_suffix(".stl").unwrap_or(base).replace('_', " ");
    match rest
        .rsplit_once("_copy_")
        .and_then(|(_, n)| n.parse::<u32>().ok())
    {
        Some(n) if n > 0 => format!("{name}, copy {}", n.saturating_add(1)),
        _ => name,
    }
}

#[cfg(test)]
mod device_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn files_newest_first_with_short_names() {
        let v = json!({"result": [
            {"path": "old.gcode", "size": 10, "modified": 1.0},
            {"path": "sub/new part.gcode", "size": 20, "modified": 5.0}]});
        let f = parse_files(&v);
        assert_eq!(f[0].path, "sub/new part.gcode");
        assert_eq!(f[0].name, "new part.gcode");
        assert_eq!(f[1].size, Some(10));
    }

    #[test]
    fn history_maps_outcomes_and_hides_the_running_job() {
        let v = json!({"result": {"jobs": [
            {"filename": "a.gcode", "status": "completed", "start_time": 9.0, "total_duration": 120.5, "filament_used": 3000.0},
            {"filename": "b.gcode", "status": "cancelled"},
            {"filename": "c.gcode", "status": "klippy_shutdown"},
            {"filename": "d.gcode", "status": "in_progress"}]}});
        let h = parse_history(&v);
        assert_eq!(
            h.iter().map(|r| r.outcome.as_str()).collect::<Vec<_>>(),
            ["completed", "canceled", "failed"]
        );
        assert_eq!(h[2].detail.as_deref(), Some("klippy shutdown"));
        assert_eq!(h[0].duration_s, Some(120.5));
    }

    #[test]
    fn objects_carry_skipped_state_and_a_readable_name() {
        let v = json!({"result": {"status": {"exclude_object": {
            "objects": [{"name": "lid.stl_id_0_copy_0", "center": [10.0, 20.0], "polygon": [[0.0,0.0],[20.0,0.0],[20.0,40.0]]},
                        {"name": "base.stl_id_1_copy_0"}],
            "excluded_objects": ["base.stl_id_1_copy_0"]}}}});
        let o = parse_objects(&v);
        assert_eq!(o[0].name, "lid");
        assert!(!o[0].skipped && o[1].skipped);
        assert_eq!(o[0].polygon.len(), 3);
        assert!(parse_objects(&json!({"result": {"status": {}}})).is_empty());
    }

    #[test]
    fn copies_of_one_model_keep_their_number() {
        assert_eq!(display_name("bracket.stl_id_2_copy_0"), "bracket");
        assert_eq!(display_name("bracket.stl_id_2_copy_1"), "bracket, copy 2");
        assert_eq!(display_name("bracket.stl_id_2_copy_3"), "bracket, copy 4");
    }

    #[test]
    fn motion_reads_the_toolhead() {
        let v = json!({"result": {"status": {"toolhead": {
            "position": [10.0, 20.0, 5.5, 100.0], "homed_axes": "xy",
            "axis_minimum": [0.0, -2.0, -1.0, 0.0], "axis_maximum": [235.0, 235.0, 250.0, 0.0]}}}});
        let m = parse_motion(&v);
        assert_eq!(m.homed, Some([true, true, false]));
        assert_eq!(m.position, Some([10.0, 20.0, 5.5]));
        assert_eq!(m.max, Some([235.0, 235.0, 250.0]));
        assert_eq!(parse_motion(&json!({})), crate::Motion::default());
    }

    #[test]
    fn object_labels_cannot_carry_a_command() {
        assert!(crate::object_id_ok("lid.stl_id_0_copy_0"));
        assert!(!crate::object_id_ok("a b"));
        assert!(!crate::object_id_ok("a\nM112"));
        assert!(!crate::object_id_ok(""));
        assert_eq!(crate::skip_object_line("x_1"), "EXCLUDE_OBJECT NAME=x_1");
    }
}
