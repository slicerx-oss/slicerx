// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Moonraker (Klipper) over its HTTP API. Also the transport for Klipper based Creality and
//! Snapmaker models, which pass their own plugin id.
mod filament;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::multipart::{Form, Part};
use reqwest::{Client, RequestBuilder, Response};
use serde_json::{Value, json};

pub(crate) use filament::hex_color;
use filament::{QIDI_SLOTS, QidiDict};

use crate::camera::{self, FrameStream};
use crate::error::{Error, LoginNeed, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http::{self, base_url, f64_at, str_at};
use crate::manifest::{PluginManifest, manifest};
use crate::poll::poll_events;
use crate::types::{
    Adjustment, Capabilities, Capability, DiscoveredPrinter, ExtruderInfo, Fans, FileInfo, Image, JobFile,
    PrintObject, PrintRecord, PrinterConfig, PrinterEvent, PrinterHardware, PrinterLive, PrinterState,
    PrinterStatus, RemoteFile, Secrets, StartOptions, StoredFile, Temp, now_iso, secs,
};
use crate::{PrinterConnector, PrinterSession};

/// Moonraker's own ports: plain and with TLS. A web frontend (Mainsail, Fluidd) on any other port
/// proxies the API too.
const API_PORTS: [u16; 2] = [7125, 7130];

pub struct MoonrakerConnector {
    plugin: &'static str,
    default_port: u16,
    gate: Arc<dyn ApprovalGate>,
    /// The ports a probe asks: Moonraker's 7125, then 80 where Mainsail or Fluidd proxy it.
    probe_ports: Vec<u16>,
}

impl MoonrakerConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self::for_plugin("moonraker", 7125, gate)
    }

    /// Klipper based models that speak Moonraker but carry their own plugin id.
    pub(crate) fn for_plugin(plugin: &'static str, default_port: u16, gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            plugin,
            default_port,
            gate,
            probe_ports: vec![7125, 80],
        }
    }

    /// Probes `ports` instead of 7125 and 80 (tests).
    #[must_use]
    pub fn with_probe_ports(mut self, ports: Vec<u16>) -> Self {
        self.probe_ports = ports;
        self
    }
}

/// What a Moonraker server on `host:port` says about itself, read without a sign-in: `None` when
/// nothing there answers like Moonraker. `objects` is empty when the server wants a login.
#[derive(Debug, Clone, Default)]
pub(crate) struct Identity {
    pub port: u16,
    pub hostname: Option<String>,
    /// `machine_name` from `/server/info`, which vendor builds set (OrcaSlicer reads it as the name).
    pub machine: Option<String>,
    pub moonraker_version: Option<String>,
    pub objects: Vec<String>,
}

impl Identity {
    /// The Snapmaker U1's own Klipper object, which u1-companion uses to tell it from other Klipper machines.
    pub fn is_u1(&self) -> bool {
        self.objects.iter().any(|o| o == "print_task_config")
            || self
                .hostname
                .as_deref()
                .is_some_and(|h| h.eq_ignore_ascii_case("u1"))
    }
}

/// Asks `host:port` for `/server/info` and, when it is Moonraker, its host name and Klipper objects.
pub(crate) async fn identify(host: &str, port: u16, timeout: Duration) -> Option<Identity> {
    let client = Client::builder()
        .timeout(timeout)
        .use_preconfigured_tls(rustls::ClientConfig::clone(&*crate::tls::no_trust_config().ok()?))
        .build()
        .ok()?;
    let base = format!("http://{host}:{port}");
    let r = client.get(format!("{base}/server/info")).send().await.ok()?;
    let status = r.status().as_u16();
    let v: Value = r.json().await.ok()?;
    if !moonraker_reply(status, &v) {
        return None;
    }
    let mut id = Identity {
        port,
        machine: str_at(&v, &["result", "machine_name"]).map(str::to_owned),
        moonraker_version: str_at(&v, &["result", "moonraker_version"]).map(str::to_owned),
        ..Identity::default()
    };
    if status == 200 {
        let get = |p: &str| client.get(format!("{base}{p}")).send();
        if let Ok(r) = get("/printer/info").await
            && let Ok(v) = r.json::<Value>().await
        {
            id.hostname = str_at(&v, &["result", "hostname"]).map(str::to_owned);
        }
        if let Ok(r) = get("/printer/objects/list").await
            && let Ok(v) = r.json::<Value>().await
        {
            id.objects = object_names(&v);
        }
    }
    Some(id)
}

/// Whether a `/server/info` reply is Moonraker's: a `result`, or its JSON refusal of an unknown client.
fn moonraker_reply(status: u16, v: &Value) -> bool {
    match status {
        200 => v.get("result").is_some(),
        401 | 403 => v.pointer("/error/code").and_then(Value::as_u64) == Some(u64::from(status)),
        _ => false,
    }
}

fn object_names(v: &Value) -> Vec<String> {
    v.pointer("/result/objects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// Whether the address serves Creality's own `/info` on port 80, which marks a Creality printer
/// whose connector reports it.
async fn creality_info(host: &str, timeout: Duration) -> bool {
    let Ok(client) = Client::builder()
        .timeout(timeout)
        .use_preconfigured_tls(rustls::ClientConfig::clone(
            &*match crate::tls::no_trust_config() {
                Ok(c) => c,
                Err(_) => return false,
            },
        ))
        .build()
    else {
        return false;
    };
    let Ok(r) = client.get(format!("http://{host}/info")).send().await else {
        return false;
    };
    r.json::<Value>()
        .await
        .is_ok_and(|v| v.get("model").and_then(Value::as_str).is_some())
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

    /// Nothing to listen for here: Moonraker announces itself over mDNS (`_moonraker._tcp`), which
    /// the scan browses for every family at once (`mdns::browse_printers`).
    async fn discover(&self, _timeout: Duration) -> Vec<DiscoveredPrinter> {
        Vec::new()
    }

    /// Asks Moonraker's port 7125, then port 80 where Mainsail or Fluidd proxy it. A Snapmaker U1 or
    /// a Creality printer is left to its own connector, which names the model.
    async fn probe(&self, host: &str, timeout: Duration) -> Option<DiscoveredPrinter> {
        if self.plugin != "moonraker" {
            return None;
        }
        let mut found = None;
        for &port in &self.probe_ports {
            if let Some(id) = identify(host, port, timeout).await {
                found = Some(id);
                break;
            }
        }
        let id = found?;
        if id.is_u1() || creality_info(host, timeout).await {
            return None;
        }
        Some(DiscoveredPrinter {
            plugin: "moonraker".to_owned(),
            host: host.to_owned(),
            port: Some(id.port),
            name: id.hostname.clone().or_else(|| id.machine.clone()),
            model: id.machine,
            firmware: id.moonraker_version.map(|v| format!("Moonraker {v}")),
            ..DiscoveredPrinter::default()
        })
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        let secret = cfg.credential_ref.as_deref().and_then(|r| secrets.get(r));
        let auth = match (cfg.username.as_deref().filter(|u| !u.is_empty()), secret) {
            (Some(user), Some(password)) => Auth::Login {
                user: user.to_owned(),
                password,
                token: Mutex::new(None),
                refresh: Mutex::new(None),
            },
            (_, Some(key)) => Auth::Key(key),
            (_, None) => Auth::None,
        };
        let client = http::client(cfg)?;
        let mut inner = Inner {
            cfg: cfg.clone(),
            plugin: self.plugin,
            client,
            base: base_url(cfg, self.default_port),
            auth,
            gate: self.gate.clone(),
            camera: AtomicBool::new(false),
            webcams: Mutex::new(None),
            objects: Mutex::new(Vec::new()),
            qidi: Mutex::new(QidiDict::default()),
        };
        inner.reach().await?;
        let inner = Arc::new(inner);
        inner.read_objects().await;
        let has_camera = !inner.webcams().await.is_empty();
        inner.camera.store(has_camera, Ordering::Relaxed);
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

/// How requests sign in: nothing (a trusted client), the API key in `X-Api-Key`, or a user login whose
/// JSON Web Token goes in `Authorization: Bearer` and is renewed with the refresh token when it expires
/// (an hour, per Moonraker's authorization docs).
enum Auth {
    None,
    Key(String),
    Login {
        user: String,
        password: String,
        token: Mutex<Option<String>>,
        refresh: Mutex<Option<String>>,
    },
}

/// One webcam of `/server/webcams/list`.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Webcam {
    pub service: String,
    pub stream_url: Option<String>,
    pub snapshot_url: Option<String>,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    pub rotation: u16,
}

/// The enabled webcams of a `/server/webcams/list` reply, in its order. Older Moonraker leaves out
/// `enabled`, which then reads as enabled.
pub(crate) fn parse_webcams(v: &Value) -> Vec<Webcam> {
    v.pointer("/result/webcams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| c.get("enabled").and_then(Value::as_bool) != Some(false))
        .map(|c| {
            let text = |k: &str| {
                c.get(k)
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned)
            };
            Webcam {
                service: text("service").unwrap_or_else(|| "mjpegstreamer".to_owned()),
                stream_url: text("stream_url"),
                snapshot_url: text("snapshot_url"),
                flip_horizontal: c.get("flip_horizontal").and_then(Value::as_bool) == Some(true),
                flip_vertical: c.get("flip_vertical").and_then(Value::as_bool) == Some(true),
                rotation: c
                    .get("rotation")
                    .and_then(Value::as_u64)
                    .and_then(|r| u16::try_from(r).ok())
                    .unwrap_or(0),
            }
        })
        .collect()
}

/// Where a relative webcam URL lives: the web frontend that serves the printer's pages. That is the
/// configured port when it is a frontend's (80, Creality's 4408 and 4409, QIDI's 10088) and the
/// default web port when the connection goes to Moonraker's own 7125 or 7130.
pub(crate) fn frontend_origin(cfg: &PrinterConfig) -> String {
    let tls = cfg.tls.unwrap_or(false);
    let scheme = if tls { "https" } else { "http" };
    match cfg.port {
        Some(p) if !API_PORTS.contains(&p) && p != if tls { 443 } else { 80 } => {
            format!("{scheme}://{}:{p}", cfg.host)
        }
        _ => format!("{scheme}://{}", cfg.host),
    }
}

/// A webcam URL as one to fetch: absolute ones only when they are on the printer itself, relative
/// ones against the frontend.
pub(crate) fn resolve_webcam_url(cfg: &PrinterConfig, url: &str) -> Option<String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        return http::same_host(url, &cfg.host).then(|| url.to_owned());
    }
    if url.contains("://") {
        return None;
    }
    let slash = if url.starts_with('/') { "" } else { "/" };
    Some(format!("{}{slash}{url}", frontend_origin(cfg)))
}

/// Why Klipper is not running, from the `webhooks` object (`shutdown`, `error` or `startup`, with
/// Klipper's own message), or `None` while it is ready.
pub(crate) fn klippy_problem(status: &Value) -> Option<String> {
    let state = str_at(status, &["webhooks", "state"])?;
    if state == "ready" {
        return None;
    }
    let msg = str_at(status, &["webhooks", "state_message"])
        .map(str::trim)
        .filter(|m| !m.is_empty());
    Some(match (state, msg) {
        ("startup", _) => "Klipper is starting".to_owned(),
        (_, Some(m)) => format!("Klipper {state}: {m}"),
        _ => format!("Klipper {state}"),
    })
}

/// The `printer/objects/query` arguments for a status: the extruders, chamber and filament units this
/// printer has, as its object list names them (extruder to extruder5 when the list is unknown).
fn status_query(objects: &[String]) -> Vec<(String, String)> {
    let mut q: Vec<(String, String)> = [
        ("print_stats", ""),
        ("virtual_sdcard", ""),
        ("webhooks", "state,state_message"),
        ("heater_bed", ""),
        ("temperature_sensor chamber", ""),
        ("heater_generic chamber", ""),
        ("fan", "speed"),
        ("gcode_move", "speed_factor,gcode_position"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    let extruders: Vec<String> = objects
        .iter()
        .filter(|o| extruder_index(o).is_some())
        .cloned()
        .collect();
    if extruders.is_empty() {
        q.push(("extruder".to_owned(), String::new()));
        q.extend((1..6).map(|n| (format!("extruder{n}"), String::new())));
    } else {
        q.extend(extruders.into_iter().map(|e| (e, String::new())));
    }
    let has = |name: &str| objects.iter().any(|o| o == name);
    if has("mmu") {
        q.push((
            "mmu".to_owned(),
            "num_gates,gate_material,gate_color,gate_status".to_owned(),
        ));
    }
    if has("save_variables") && objects.iter().any(|o| o.starts_with("box_stepper slot")) {
        q.push(("save_variables".to_owned(), "variables".to_owned()));
        q.extend((0..QIDI_SLOTS).map(|i| (format!("box_stepper slot{i}"), "runout_button".to_owned())));
    }
    if has("print_task_config") {
        q.push((
            "print_task_config".to_owned(),
            "filament_exist,filament_type,filament_sub_type,filament_color_rgba,filament_vendor".to_owned(),
        ));
    }
    q
}

/// 0 for `extruder`, N for `extruderN`; `None` for anything else (`extruder_stepper` included).
fn extruder_index(name: &str) -> Option<u8> {
    let rest = name.strip_prefix("extruder")?;
    if rest.is_empty() {
        Some(0)
    } else {
        rest.parse().ok()
    }
}

struct Inner {
    cfg: PrinterConfig,
    plugin: &'static str,
    client: Client,
    base: String,
    auth: Auth,
    gate: Arc<dyn ApprovalGate>,
    camera: AtomicBool,
    /// `/server/webcams/list`, read once per session.
    webcams: Mutex<Option<Vec<Webcam>>>,
    /// `/printer/objects/list`, read when the session opens.
    objects: Mutex<Vec<String>>,
    /// A QIDI printer's filament dictionary, read once when it has a QIDI Box.
    qidi: Mutex<QidiDict>,
}

impl Inner {
    fn id(&self) -> &str {
        &self.cfg.id
    }

    fn sign(&self, rb: RequestBuilder) -> RequestBuilder {
        match &self.auth {
            Auth::None => rb,
            Auth::Key(k) => rb.header("X-Api-Key", k),
            Auth::Login { token, .. } => {
                match token.lock().unwrap_or_else(PoisonError::into_inner).as_deref() {
                    Some(t) => rb.bearer_auth(t),
                    None => rb,
                }
            }
        }
    }

    fn get(&self, path: &str) -> RequestBuilder {
        self.sign(self.client.get(format!("{}{path}", self.base)))
    }

    fn post(&self, path: &str) -> RequestBuilder {
        self.sign(self.client.post(format!("{}{path}", self.base)))
    }

    /// Sends a request built by `build`. A user login whose token has expired is renewed and the
    /// request sent once more.
    async fn call(&self, build: impl Fn(&Self) -> RequestBuilder) -> Result<Response> {
        match http::send(self.id(), build(self)).await {
            Err(Error::Auth { .. }) if matches!(self.auth, Auth::Login { .. }) => {
                self.renew().await?;
                http::send(self.id(), build(self)).await
            }
            r => r,
        }
    }

    async fn call_json(&self, build: impl Fn(&Self) -> RequestBuilder) -> Result<Value> {
        http::json(self.id(), self.call(build).await?).await
    }

    /// Signs in with the user login (`POST /access/login`), keeping the access and refresh tokens.
    async fn login(&self) -> Result<()> {
        let Auth::Login {
            user,
            password,
            token,
            refresh,
        } = &self.auth
        else {
            return Ok(());
        };
        let body = json!({ "username": user, "password": password });
        let url = format!("{}/access/login", self.base);
        let v = match http::send(self.id(), self.client.post(url).json(&body)).await {
            Ok(r) => http::json(self.id(), r).await?,
            Err(Error::Auth { .. }) => {
                return Err(Error::Login {
                    printer: self.id().to_owned(),
                    need: LoginNeed::KeyWrong,
                });
            }
            Err(e) => return Err(e),
        };
        let field = |k: &str| str_at(&v, &["result", k]).map(str::to_owned);
        let Some(access) = field("token") else {
            return Err(Error::protocol(self.id(), "the login answer has no token"));
        };
        *token.lock().unwrap_or_else(PoisonError::into_inner) = Some(access);
        *refresh.lock().unwrap_or_else(PoisonError::into_inner) = field("refresh_token");
        Ok(())
    }

    /// A new access token from the refresh token (`POST /access/refresh_jwt`), else a new login.
    async fn renew(&self) -> Result<()> {
        let Auth::Login { token, refresh, .. } = &self.auth else {
            return Ok(());
        };
        let saved = refresh.lock().unwrap_or_else(PoisonError::into_inner).clone();
        if let Some(r) = saved {
            let url = format!("{}/access/refresh_jwt", self.base);
            let body = json!({ "refresh_token": r });
            if let Ok(resp) = http::send(self.id(), self.client.post(url).json(&body)).await
                && let Ok(v) = http::json(self.id(), resp).await
                && let Some(t) = str_at(&v, &["result", "token"])
            {
                *token.lock().unwrap_or_else(PoisonError::into_inner) = Some(t.to_owned());
                return Ok(());
            }
        }
        self.login().await
    }

    /// Reaches the server: signs in when a user login is set, then reads `/server/info`. A configured
    /// port that answers with something other than Moonraker (Fluidd's page on QIDI's 10088) is
    /// replaced by Moonraker's own 7125 when that answers.
    async fn reach(&mut self) -> Result<()> {
        self.login().await?;
        match self.server_info().await {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(Error::Auth { .. }) => return Err(self.login_error().await),
            Err(e) => return Err(e),
        }
        let port = self.cfg.port;
        if port.is_some_and(|p| !API_PORTS.contains(&p)) {
            let was = std::mem::replace(&mut self.base, {
                let mut c = self.cfg.clone();
                c.port = Some(7125);
                base_url(&c, 7125)
            });
            if matches!(self.server_info().await, Ok(true)) {
                crate::trace(self.id(), "port answered as a web page; using Moonraker on 7125");
                return Ok(());
            }
            self.base = was;
        }
        Err(Error::protocol(
            self.id(),
            format!(
                "port {} answered, but not as Moonraker; Moonraker usually listens on 7125",
                port.unwrap_or(7125)
            ),
        ))
    }

    /// `Ok(true)` when `/server/info` answers as Moonraker, `Ok(false)` when something else answers.
    async fn server_info(&self) -> Result<bool> {
        let resp = self
            .get("/server/info")
            .send()
            .await
            .map_err(|e| Error::unreachable(self.id(), e.without_url()))?;
        let status = resp.status().as_u16();
        if matches!(status, 401 | 403) {
            return Err(Error::Auth {
                printer: self.id().to_owned(),
            });
        }
        let v = http::json(self.id(), resp).await.unwrap_or(Value::Null);
        Ok(moonraker_reply(status, &v))
    }

    /// Why `/server/info` was refused. `/access/info` answers without a sign-in and says whether
    /// logins are forced; an API key passes either way, so a refused key is a wrong key.
    async fn login_error(&self) -> Error {
        let need = if matches!(self.auth, Auth::None) {
            let url = format!("{}/access/info", self.base);
            let info = match http::send(self.id(), self.client.get(url)).await {
                Ok(r) => http::json(self.id(), r).await.ok(),
                Err(_) => None,
            };
            login_need_without_key(info.as_ref())
        } else {
            LoginNeed::KeyWrong
        };
        Error::Login {
            printer: self.id().to_owned(),
            need,
        }
    }

    /// The Klipper objects, and a QIDI printer's filament dictionary when it has a QIDI Box.
    async fn read_objects(&self) {
        let list = self
            .call_json(|i| i.get("/printer/objects/list"))
            .await
            .map(|v| object_names(&v))
            .unwrap_or_default();
        let qidi = list.iter().any(|o| o.starts_with("box_stepper slot"));
        *self.objects.lock().unwrap_or_else(PoisonError::into_inner) = list;
        if qidi
            && let Ok(r) = self
                .call(|i| i.get("/server/files/config/officiall_filas_list.cfg"))
                .await
            && let Ok(text) = r.text().await
        {
            *self.qidi.lock().unwrap_or_else(PoisonError::into_inner) = filament::parse_qidi_dict(&text);
        }
    }

    fn objects(&self) -> Vec<String> {
        self.objects
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The enabled webcams, read once. A server without the webcam list (older Moonraker) has none.
    async fn webcams(&self) -> Vec<Webcam> {
        if let Some(w) = self
            .webcams
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
        {
            return w;
        }
        let list = self
            .call_json(|i| i.get("/server/webcams/list"))
            .await
            .map(|v| parse_webcams(&v))
            .unwrap_or_default();
        *self.webcams.lock().unwrap_or_else(PoisonError::into_inner) = Some(list.clone());
        list
    }

    /// A camera request: signed when it goes to Moonraker itself, so a camera behind Moonraker's
    /// login works without a one-shot token in the URL.
    fn camera_get(&self, url: &str) -> RequestBuilder {
        let rb = self.client.get(url);
        if url.starts_with(&format!("{}/", self.base)) {
            self.sign(rb)
        } else {
            rb
        }
    }

    async fn webcam_snapshot_url(&self) -> Option<String> {
        let cams = self.webcams().await;
        cams.iter()
            .find_map(|c| c.snapshot_url.as_deref())
            .and_then(|u| resolve_webcam_url(&self.cfg, u))
    }

    /// The MJPEG stream URL of the first webcam that offers one (crowsnest's ustreamer, mjpg-streamer).
    /// WebRTC and HLS webcam services are not read; those webcams fall back to their snapshot URL.
    async fn webcam_stream_url(&self) -> Option<String> {
        let cams = self.webcams().await;
        cams.iter()
            .filter(|c| c.service.contains("mjpeg"))
            .find_map(|c| c.stream_url.as_deref())
            .and_then(|u| resolve_webcam_url(&self.cfg, u))
    }

    /// The WebRTC signaling of the first webcam whose service Mainsail and Fluidd record as WebRTC.
    async fn webcam_signaling(&self) -> Option<camera::Signaling> {
        let cams = self.webcams().await;
        cams.iter().find_map(|c| {
            let url = resolve_webcam_url(&self.cfg, c.stream_url.as_deref()?)?;
            camera::Signaling::from_webcam(&c.service, url)
        })
    }

    async fn fetch_status(&self) -> Result<PrinterStatus> {
        // Objects that do not exist on this printer are omitted from the reply.
        let query = status_query(&self.objects());
        let resp = self.call(|i| i.get("/printer/objects/query").query(&query)).await;
        let resp = match resp {
            Err(Error::Protocol { detail, .. }) if detail == "HTTP 503" => {
                return Ok(self.not_ready().await);
            }
            r => r?,
        };
        let v = http::json(self.id(), resp).await?;
        let qidi = self.qidi.lock().unwrap_or_else(PoisonError::into_inner).clone();
        Ok(parse_status_with(
            self.id(),
            &v,
            self.camera.load(Ordering::Relaxed),
            &qidi,
        ))
    }

    /// The status while Klipper does not answer queries: an error carrying Klipper's own state and
    /// message from `/printer/info` (shutdown, a config error, still starting).
    async fn not_ready(&self) -> PrinterStatus {
        let mut s = PrinterStatus::offline(self.id());
        s.state = PrinterState::Error;
        let info = self.call_json(|i| i.get("/printer/info")).await.ok();
        let status = info.as_ref().and_then(|v| v.get("result")).map(
            |r| json!({ "webhooks": { "state": r.get("state"), "state_message": r.get("state_message") } }),
        );
        s.message = Some(
            status
                .as_ref()
                .and_then(klippy_problem)
                .unwrap_or_else(|| "Klipper is not ready".to_owned()),
        );
        s
    }

    fn token(&self, token: &ApprovalToken, action: Action, params: &str) -> Result<()> {
        self.gate.check(token, action, self.id(), params)
    }
}

/// How long an upload may take: five minutes as OrcaSlicer allows, and longer for a file that needs
/// it at 64 KiB a second (a slow Wi-Fi link).
fn upload_timeout(bytes: usize) -> Duration {
    let slow = u64::try_from(bytes / (64 * 1024)).unwrap_or(u64::MAX);
    Duration::from_secs(300_u64.max(slow).min(4 * 3600))
}

/// The hardware in a `configfile`, `toolhead` and filament unit query and a `printer/info` reply.
#[cfg(test)]
pub(crate) fn moonraker_hardware(q: Option<&Value>, info: Option<&Value>) -> PrinterHardware {
    moonraker_hardware_with(q, info, None, &QidiDict::default())
}

fn moonraker_hardware_with(
    q: Option<&Value>,
    info: Option<&Value>,
    server: Option<&Value>,
    qidi: &QidiDict,
) -> PrinterHardware {
    let status = q.and_then(|v| v.get("result")).and_then(|r| r.get("status"));
    let settings = status
        .and_then(|s| s.get("configfile"))
        .and_then(|c| c.get("settings"))
        .and_then(Value::as_object);
    let mut extruders = Vec::new();
    for n in 0_u8..16 {
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
            nozzle_diameter_mm: num(sec.get("nozzle_diameter")),
            ..ExtruderInfo::default()
        });
    }
    let printer = settings.and_then(|s| s.get("printer"));
    let kinematics = printer
        .and_then(|p| p.get("kinematics"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let delta = kinematics.as_deref() == Some("delta");
    let xyz = |k: &str| -> Option<[f64; 3]> {
        let a = status?.get("toolhead")?.get(k)?.as_array()?;
        Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?])
    };
    // The travel limits, from where each axis may start: a probe offset can let X or Y go below
    // zero, which is not bed.
    let build_volume = match (xyz("axis_minimum"), xyz("axis_maximum")) {
        (Some([lx, ly, _]), Some([hx, hy, hz])) if !delta => {
            Some([hx - lx.max(0.0), hy - ly.max(0.0), hz]).filter(|v| v.iter().all(|d| *d > 0.0))
        }
        (_, Some([hx, hy, hz])) if delta => Some([hx * 2.0, hy * 2.0, hz]),
        _ => None,
    };
    // Klipper's delta `print_radius` (else `delta_radius`) is the round bed's radius.
    let bed_diameter = delta
        .then(|| {
            num(printer.and_then(|p| p.get("print_radius")))
                .or_else(|| num(printer.and_then(|p| p.get("delta_radius"))))
        })
        .flatten()
        .map(|r| r * 2.0);
    let filament_units = status.map(|s| filament::units(s, qidi)).unwrap_or_default();
    let r = info.and_then(|v| v.get("result"));
    let machine = server
        .and_then(|v| str_at(v, &["result", "machine_name"]))
        .map(str::to_owned);
    let u1 = status.is_some_and(|s| s.get("print_task_config").is_some());
    PrinterHardware {
        model: machine.or_else(|| u1.then(|| "U1".to_owned())),
        firmware: r
            .and_then(|r| r.get("software_version"))
            .and_then(Value::as_str)
            .map(|v| format!("Klipper {v}")),
        extruders,
        filament_units,
        build_volume_mm: build_volume,
        bed_diameter_mm: bed_diameter,
        kinematics,
        max_velocity_mm_s: num(printer.and_then(|p| p.get("max_velocity"))),
        max_accel_mm_s2: num(printer.and_then(|p| p.get("max_accel"))),
        hostname: r
            .and_then(|r| r.get("hostname"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        ..PrinterHardware::default()
    }
}

/// A number from `configfile.settings`, which holds parsed values, or from `config`, which holds text.
fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Maps a `printer/objects/query` reply to the normalized status.
#[cfg(test)]
pub(crate) fn parse_status(id: &str, v: &Value, camera: bool) -> PrinterStatus {
    parse_status_with(id, v, camera, &QidiDict::default())
}

fn parse_status_with(id: &str, v: &Value, camera: bool, qidi: &QidiDict) -> PrinterStatus {
    let st = v
        .get("result")
        .and_then(|r| r.get("status"))
        .cloned()
        .unwrap_or(Value::Null);
    let problem = klippy_problem(&st);
    let state = match str_at(&st, &["print_stats", "state"]).unwrap_or("standby") {
        _ if problem.is_some() => PrinterState::Error,
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
    let message = problem.or_else(|| {
        str_at(&st, &["print_stats", "message"])
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    });
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
    // Every extruder the reply holds, in tool order; a gap ends the list.
    let mut nozzles = Vec::new();
    for n in 0_u8..16 {
        let name = if n == 0 {
            "extruder".to_owned()
        } else {
            format!("extruder{n}")
        };
        match temp(&name) {
            Some(t) => nozzles.push(t),
            None => break,
        }
    }
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: filename.map(str::to_owned),
        progress: if filename.is_some() { progress } else { None },
        layer: layer("current_layer"),
        layer_count: layer("total_layer"),
        time_left_s: time_left.map(secs),
        nozzles,
        bed: temp("heater_bed"),
        chamber,
        slots: filament::units(&st, qidi)
            .into_iter()
            .flat_map(|u| u.slots)
            .collect(),
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
        let objects = self.inner.objects();
        if objects
            .iter()
            .any(|o| o == "mmu" || o == "print_task_config" || o.starts_with("box_stepper slot"))
        {
            c.push(Capability::FilamentSlots);
        }
        c
    }

    async fn status(&self) -> Result<PrinterStatus> {
        self.inner.fetch_status().await
    }

    /// Nozzle diameters, kinematics and limits from Klipper's own config (`configfile.settings`), the
    /// build volume from the toolhead's travel limits, the Klipper version and host name from
    /// `printer/info`, a vendor build's `machine_name`, and the filament units (Happy Hare MMU, QIDI
    /// Box, the Snapmaker U1's toolheads).
    async fn hardware(&self) -> Result<Option<PrinterHardware>> {
        let i = &self.inner;
        let mut query: Vec<(String, String)> = vec![
            ("configfile".to_owned(), "settings".to_owned()),
            ("toolhead".to_owned(), "axis_minimum,axis_maximum".to_owned()),
        ];
        query.extend(status_query(&i.objects()).into_iter().filter(|(k, _)| {
            k == "mmu" || k == "save_variables" || k.starts_with("box_stepper") || k == "print_task_config"
        }));
        let q = i
            .call_json(|i| i.get("/printer/objects/query").query(&query))
            .await
            .ok();
        let info = i.call_json(|i| i.get("/printer/info")).await.ok();
        let server = i.call_json(|i| i.get("/server/info")).await.ok();
        let qidi = i.qidi.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let mut hw = moonraker_hardware_with(q.as_ref(), info.as_ref(), server.as_ref(), &qidi);
        // A Creality K2 reports its CFS on its own WebSocket, not through Moonraker.
        if i.plugin == "creality" {
            hw.filament_units
                .extend(crate::drivers::creality::query_boxes(&i.cfg).await);
        }
        Ok(Some(hw))
    }

    fn reported_model(&self) -> Option<String> {
        self.inner
            .objects()
            .iter()
            .any(|o| o == "print_task_config")
            .then(|| "U1".to_owned())
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

    /// Sends the file with its SHA-256 as `checksum`, which Moonraker checks before it keeps the file.
    async fn upload(&self, file: JobFile, token: &ApprovalToken) -> Result<RemoteFile> {
        self.inner.token(
            token,
            Action::Upload,
            &params::upload(self.inner.id(), &file.name, &file.sha256),
        )?;
        let timeout = upload_timeout(file.data.len());
        let v = self
            .inner
            .call_json(|i| {
                let form = Form::new()
                    .text("root", "gcodes")
                    .text("checksum", file.sha256.clone())
                    .text("print", "false")
                    .part(
                        "file",
                        Part::bytes(file.data.clone()).file_name(file.name.clone()),
                    );
                i.post("/server/files/upload").multipart(form).timeout(timeout)
            })
            .await?;
        let path = str_at(&v, &["item", "path"])
            .or_else(|| str_at(&v, &["result", "item", "path"]))
            .unwrap_or(&file.name)
            .to_owned();
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
        self.inner
            .call(|i| {
                i.post("/printer/print/start")
                    .query(&[("filename", file.path.as_str())])
            })
            .await?;
        Ok(())
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.inner
            .token(token, Action::Pause, &params::printer(self.inner.id()))?;
        self.inner.call(|i| i.post("/printer/print/pause")).await?;
        Ok(())
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.inner
            .token(token, Action::Resume, &params::printer(self.inner.id()))?;
        self.inner.call(|i| i.post("/printer/print/resume")).await?;
        Ok(())
    }

    async fn cancel(&self, token: &ApprovalToken) -> Result<()> {
        self.inner
            .token(token, Action::Cancel, &params::printer(self.inner.id()))?;
        self.inner.call(|i| i.post("/printer/print/cancel")).await?;
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
        let inner = self.inner.clone();
        Ok(Some(camera::poll_snapshots(
            Duration::from_millis(250),
            move || {
                let (inner, url) = (inner.clone(), url.clone());
                async move {
                    let r = inner.camera_get(&url).send().await.ok()?;
                    r.status().is_success().then_some(())?;
                    r.bytes().await.ok().map(|b| b.to_vec())
                }
            },
        )))
    }

    /// The file's metadata, or its entry in the file list where the metadata answers 404 (QIDI's
    /// Moonraker on the Q2 and X-Max 4 does for every file).
    async fn file_info(&self, path: &str) -> Result<Option<FileInfo>> {
        let meta = self
            .inner
            .call_json(|i| i.get("/server/files/metadata").query(&[("filename", path)]))
            .await;
        let v = match meta {
            Err(Error::NotFound { .. }) => {
                let list = self.list_files().await?;
                return Ok(list.into_iter().find(|f| f.path == path).and_then(|f| {
                    Some(FileInfo {
                        size: f.size?,
                        modified: f.modified,
                    })
                }));
            }
            r => r?,
        };
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
        let resp = http::send(self.inner.id(), self.inner.camera_get(&url)).await?;
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
        self.inner
            .call(|i| {
                i.post("/printer/gcode/script")
                    .query(&[("script", line.as_str())])
            })
            .await?;
        Ok(())
    }

    async fn list_files(&self) -> Result<Vec<StoredFile>> {
        let v = self
            .inner
            .call_json(|i| i.get("/server/files/list").query(&[("root", "gcodes")]))
            .await?;
        Ok(parse_files(&v))
    }

    async fn history(&self) -> Result<Vec<PrintRecord>> {
        let v = self
            .inner
            .call_json(|i| {
                i.get("/server/history/list")
                    .query(&[("limit", "50"), ("order", "desc")])
            })
            .await?;
        Ok(parse_history(&v))
    }

    async fn objects(&self) -> Result<Vec<PrintObject>> {
        let v = self
            .inner
            .call_json(|i| i.get("/printer/objects/query?exclude_object"))
            .await?;
        Ok(parse_objects(&v))
    }

    async fn motion(&self) -> Result<crate::Motion> {
        let v = self
            .inner
            .call_json(|i| {
                i.get("/printer/objects/query")
                    .query(&[("toolhead", "position,homed_axes,axis_minimum,axis_maximum")])
            })
            .await?;
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
        self.inner
            .call(|i| i.post("/printer/gcode/script").query(&[("script", line)]))
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

    fn cfg(port: Option<u16>, tls: bool) -> PrinterConfig {
        PrinterConfig {
            id: "p".into(),
            name: "p".into(),
            plugin: "moonraker".into(),
            host: "192.168.1.20".into(),
            port,
            credential_ref: None,
            serial: None,
            tls: Some(tls),
            poll_ms: None,
            ftp_port: None,
            camera_port: None,
            ws_port: None,
            http_port: None,
            protocol: None,
            username: None,
            camera_url: None,
            camera_credential_ref: None,
            rtsp_port: None,
        }
    }

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

    #[test]
    fn webcams_skip_disabled_ones_and_keep_orientation() {
        let v = json!({"result": {"webcams": [
            {"name": "off", "enabled": false, "service": "mjpegstreamer", "stream_url": "/off/?action=stream"},
            {"name": "cam", "service": "mjpegstreamer", "stream_url": "/webcam/?action=stream", "snapshot_url": "/webcam/?action=snapshot", "flip_horizontal": true, "rotation": 90}]}});
        let w = parse_webcams(&v);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].stream_url.as_deref(), Some("/webcam/?action=stream"));
        assert!(w[0].flip_horizontal && !w[0].flip_vertical);
        assert_eq!(w[0].rotation, 90);
        // An old Moonraker without the list has no webcams.
        assert!(parse_webcams(&json!({"error": {"code": 404}})).is_empty());
    }

    #[test]
    fn relative_webcam_urls_resolve_against_the_frontend() {
        let at = |port, tls, url| resolve_webcam_url(&cfg(port, tls), url);
        assert_eq!(
            at(Some(7125), false, "/webcam/?action=snapshot").as_deref(),
            Some("http://192.168.1.20/webcam/?action=snapshot")
        );
        assert_eq!(
            at(Some(4408), false, "webcam/").as_deref(),
            Some("http://192.168.1.20:4408/webcam/")
        );
        assert_eq!(
            at(Some(7130), true, "/webcam/").as_deref(),
            Some("https://192.168.1.20/webcam/")
        );
        assert_eq!(
            at(None, false, "/webcam/").as_deref(),
            Some("http://192.168.1.20/webcam/")
        );
        assert_eq!(at(Some(80), false, "http://evil.example/x"), None);
        assert_eq!(at(Some(80), false, "rtsp://192.168.1.20/x"), None);
    }

    #[test]
    fn a_klipper_shutdown_is_an_error_with_its_message() {
        let v = json!({"result": {"status": {
            "webhooks": {"state": "shutdown", "state_message": "MCU 'mcu' shutdown: Timer too close"},
            "print_stats": {"state": "standby"}}}});
        let s = parse_status("p", &v, false);
        assert_eq!(s.state, PrinterState::Error);
        assert_eq!(
            s.message.as_deref(),
            Some("Klipper shutdown: MCU 'mcu' shutdown: Timer too close")
        );
        let ok = json!({"result": {"status": {"webhooks": {"state": "ready", "state_message": "Printer is ready"}}}});
        assert_eq!(parse_status("p", &ok, false).state, PrinterState::Idle);
    }

    #[test]
    fn the_status_asks_for_the_objects_the_printer_has() {
        let objects: Vec<String> = [
            "extruder",
            "extruder1",
            "extruder_stepper belt",
            "heater_bed",
            "print_task_config",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let q = status_query(&objects);
        let keys: Vec<&str> = q.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"extruder1") && !keys.contains(&"extruder2"));
        assert!(!keys.contains(&"extruder_stepper belt"));
        assert!(keys.contains(&"print_task_config") && !keys.contains(&"mmu"));
        let unknown = status_query(&[]);
        assert!(unknown.iter().any(|(k, _)| k == "extruder5"));
    }

    #[test]
    fn hardware_reads_the_bed_kinematics_and_limits() {
        let q = json!({"result": {"status": {
            "configfile": {"settings": {
                "printer": {"kinematics": "corexy", "max_velocity": 500.0, "max_accel": 20000.0},
                "extruder": {"nozzle_diameter": 0.4}}},
            "toolhead": {"axis_minimum": [-5.0, 0.0, -2.0, 0.0], "axis_maximum": [350.0, 350.0, 345.0, 0.0]}}}});
        let info = json!({"result": {"hostname": "sovol-sv08", "software_version": "v0.12.0"}});
        let hw = moonraker_hardware(Some(&q), Some(&info));
        assert_eq!(hw.build_volume_mm, Some([350.0, 350.0, 345.0]));
        assert_eq!(hw.kinematics.as_deref(), Some("corexy"));
        assert_eq!(
            (hw.max_velocity_mm_s, hw.max_accel_mm_s2),
            (Some(500.0), Some(20000.0))
        );
        assert_eq!(hw.hostname.as_deref(), Some("sovol-sv08"));
        assert_eq!(hw.firmware.as_deref(), Some("Klipper v0.12.0"));
        let delta = json!({"result": {"status": {
            "configfile": {"settings": {"printer": {"kinematics": "delta", "print_radius": 155.0}}},
            "toolhead": {"axis_minimum": [-155.0, -155.0, -1.0, 0.0], "axis_maximum": [155.0, 155.0, 425.0, 0.0]}}}});
        let hw = moonraker_hardware(Some(&delta), None);
        assert_eq!(hw.bed_diameter_mm, Some(310.0));
        assert_eq!(hw.build_volume_mm, Some([310.0, 310.0, 425.0]));
    }

    #[test]
    fn moonraker_answers_are_told_from_web_pages() {
        assert!(moonraker_reply(
            200,
            &json!({"result": {"klippy_state": "ready"}})
        ));
        assert!(moonraker_reply(
            401,
            &json!({"error": {"code": 401, "message": "Unauthorized"}})
        ));
        assert!(!moonraker_reply(200, &Value::Null));
        assert!(!moonraker_reply(404, &json!({"error": {"code": 404}})));
    }

    #[test]
    fn uploads_get_time_for_large_files() {
        assert_eq!(upload_timeout(1024), Duration::from_secs(300));
        assert_eq!(upload_timeout(64 * 1024 * 600), Duration::from_secs(600));
    }
}
