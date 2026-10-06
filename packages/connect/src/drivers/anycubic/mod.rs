// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Anycubic Kobra 3, Kobra S1 and their siblings in LAN Mode. Experimental: written from community
//! projects, untested on a printer. The printer serves `GET /info` on port 18910; a signed `POST` to
//! the `ctrlInfoUrl` it names returns AES-128-CBC encrypted MQTT credentials (and, on some firmware,
//! a client certificate); the printer's own broker on TLS port 9883 carries reports and commands.
//! Credentials change when the printer restarts, so a dropped connection runs the handshake again.
//! No user credential is involved. See README.md for sources and what is unverified.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use futures::stream::{self, BoxStream, StreamExt};
use md5::{Digest, Md5};
use rumqttc::{AsyncClient, ConnectionError, Event, MqttOptions, Packet, QoS, TlsConfiguration, Transport};
use serde_json::{Value, json};
use tokio::sync::{broadcast, oneshot, watch};

use crate::error::{Error, LoginNeed, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http::{self, f64_at, str_at};
use crate::manifest::{PluginManifest, manifest};
use crate::types::{
    Capabilities, Capability, DiscoveredPrinter, ExtruderInfo, FilamentSlot, FilamentUnit, Image, JobFile,
    PrinterConfig, PrinterEvent, PrinterHardware, PrinterState, PrinterStatus, RemoteFile, Secrets,
    StartOptions, Temp, hex, now_iso, secs,
};
use crate::{PrinterConnector, PrinterSession};

const INFO_PORT: u16 = 18910;
const PREFIX: &str = "anycubic/anycubicCloud/v1";
/// How often the full `info` report is asked for. LAN telemetry arrives about every 15 seconds, and
/// `info` alone carries the job state.
const INFO_EVERY: Duration = Duration::from_secs(15);
/// The ACE answers only when asked, so it is asked about every 30 seconds.
const ACE_EVERY: Duration = Duration::from_secs(30);

/// Model ids from the printer's `/info` (`modelId`), as kobra-connect and anycubic_ha_local list them.
const MODELS: [(&str, &str); 7] = [
    ("20024", "Kobra 3"),
    ("20025", "Kobra S1"),
    ("20026", "Kobra 3 Max"),
    ("20027", "Kobra 3 V2"),
    ("20028", "Kobra 4"),
    ("20029", "Kobra S1 Max"),
    ("20030", "Kobra X"),
];

/// The model a `modelId` names.
pub(crate) fn model_name(model_id: &str) -> Option<&'static str> {
    MODELS
        .iter()
        .find(|(id, _)| *id == model_id.trim())
        .map(|(_, name)| *name)
}

fn model_id_of(info: &Value) -> Option<String> {
    let v = info.get("modelId")?;
    v.as_str()
        .map(str::to_owned)
        .or_else(|| v.as_u64().map(|n| n.to_string()))
}

/// `sign = md5(md5(token[..16]) + ts + nonce)`, lowercase hex.
pub(crate) fn sign(token: &str, ts: u64, nonce: &str) -> String {
    let first = hex(&Md5::digest(token.get(..16).unwrap_or(token).as_bytes()));
    hex(&Md5::digest(format!("{first}{ts}{nonce}").as_bytes()))
}

/// Decrypts the `/ctrl` reply's `data.info`: base64, AES-128-CBC with the key `token[16..32]` and the
/// IV the reply's own `data.token` (cut or zero padded to 16 bytes), PKCS#7 padding, then JSON.
pub(crate) fn decrypt_ctrl(info_b64: &str, token: &str, local_token: &str) -> Option<Value> {
    use aes::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::Pkcs7};
    let key: [u8; 16] = token.as_bytes().get(16..32)?.try_into().ok()?;
    let mut iv = [0_u8; 16];
    for (d, s) in iv.iter_mut().zip(local_token.as_bytes()) {
        *d = *s;
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(info_b64.trim())
        .ok()?;
    let plain = cbc::Decryptor::<aes::Aes128>::new(&key.into(), &iv.into())
        .decrypt_padded_vec::<Pkcs7>(&data)
        .ok()?;
    serde_json::from_slice(&plain).ok()
}

/// What the handshake gives: the broker login and, on some firmware, a client certificate. Never
/// logged; `Debug` shows none of it.
#[derive(Clone)]
struct Creds {
    port: u16,
    username: String,
    password: String,
    device_id: String,
    cert: Option<(String, String)>,
}

impl std::fmt::Debug for Creds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Creds")
            .field("port", &self.port)
            .field("client_certificate", &self.cert.is_some())
            .finish_non_exhaustive()
    }
}

fn random_text(n: usize, alphabet: &[u8]) -> String {
    let mut raw = vec![0_u8; n];
    let _ = getrandom::fill(&mut raw);
    raw.iter()
        .map(|b| char::from(*alphabet.get(usize::from(*b) % alphabet.len()).unwrap_or(&b'A')))
        .collect()
}

/// `GET /info`, then the signed `POST` to `ctrlInfoUrl`, then the decrypt. Returns the `/info` reply
/// and the broker login.
async fn handshake(client: &reqwest::Client, cfg: &PrinterConfig) -> Result<(Value, Creds)> {
    let base = format!("http://{}:{}", cfg.host, cfg.port.unwrap_or(INFO_PORT));
    let info = http::json(
        &cfg.id,
        http::send(&cfg.id, client.get(format!("{base}/info"))).await?,
    )
    .await?;
    if str_at(&info, &["ctrlType"]) == Some("cloud") {
        return Err(Error::Login {
            printer: cfg.id.clone(),
            need: LoginNeed::LanModeOff,
        });
    }
    let (Some(token), Some(url), Some(_)) = (
        str_at(&info, &["token"]),
        str_at(&info, &["ctrlInfoUrl"]),
        model_id_of(&info),
    ) else {
        return Err(Error::not_supported(
            "anycubic",
            "this printer's LAN handshake (the unsigned one of the Kobra 2 generation)",
        ));
    };
    // The printer names where to ask; it must be the printer itself.
    if !http::same_host(url, &cfg.host) {
        return Err(Error::protocol(
            &cfg.id,
            "the printer named another host for its handshake",
        ));
    }
    let ts = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis()),
    )
    .unwrap_or(0);
    let nonce = random_text(
        6,
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    );
    let did = random_text(32, b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    let ts_s = ts.to_string();
    let signed = sign(token, ts, &nonce);
    let rb = client.post(url).query(&[
        ("ts", ts_s.as_str()),
        ("nonce", nonce.as_str()),
        ("sign", signed.as_str()),
        ("did", did.as_str()),
    ]);
    let ctrl = http::json(&cfg.id, http::send(&cfg.id, rb).await?).await?;
    if ctrl.get("code").and_then(Value::as_i64) != Some(200) {
        return Err(Error::protocol(&cfg.id, "the printer refused the LAN handshake"));
    }
    let data = match (
        str_at(&ctrl, &["data", "info"]),
        str_at(&ctrl, &["data", "token"]),
    ) {
        (Some(blob), Some(local)) => decrypt_ctrl(blob, token, local),
        _ => None,
    }
    .ok_or_else(|| Error::protocol(&cfg.id, "the LAN handshake reply could not be read"))?;
    let port = str_at(&data, &["broker"])
        .and_then(|b| b.rsplit(':').next())
        .and_then(|p| p.trim_end_matches('/').parse::<u16>().ok())
        .ok_or_else(|| Error::protocol(&cfg.id, "the LAN handshake named no broker port"))?;
    let text = |k: &str| str_at(&data, &[k]).map(str::to_owned);
    let (Some(username), Some(password), Some(device_id)) =
        (text("username"), text("password"), text("deviceId"))
    else {
        return Err(Error::protocol(
            &cfg.id,
            "the LAN handshake reply has no broker login",
        ));
    };
    let cert = match (text("devicecrt"), text("devicepk")) {
        (Some(c), Some(k)) if !c.is_empty() && !k.is_empty() => Some((c, k)),
        _ => None,
    };
    Ok((
        info,
        Creds {
            port,
            username,
            password,
            device_id,
            cert,
        },
    ))
}

pub struct AnycubicConnector {
    gate: Arc<dyn ApprovalGate>,
    /// The port `probe` asks: 18910, another in tests.
    probe_port: u16,
}

impl AnycubicConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            gate,
            probe_port: INFO_PORT,
        }
    }

    /// Probes `port` instead of 18910.
    #[must_use]
    pub fn with_probe_port(mut self, port: u16) -> Self {
        self.probe_port = port;
        self
    }
}

#[async_trait]
impl PrinterConnector for AnycubicConnector {
    fn manifest(&self) -> PluginManifest {
        manifest("anycubic").unwrap_or_else(|| super::prusalink::unreachable_manifest("anycubic"))
    }

    /// No documented way to find a printer in LAN Mode, so the address is typed and `probe` asks it.
    async fn discover(&self, _timeout: Duration) -> Vec<DiscoveredPrinter> {
        Vec::new()
    }

    /// `GET http://IP:18910/info`, which needs no login: the model, its serial (`cn`) and whether LAN
    /// Mode is on (`ctrlType` is `cloud` when it is off).
    async fn probe(&self, host: &str, timeout: Duration) -> Option<DiscoveredPrinter> {
        let ip: std::net::IpAddr = host.parse().ok()?;
        let client = http::service_client().ok()?;
        let url = format!(
            "http://{}/info",
            std::net::SocketAddr::from((ip, self.probe_port))
        );
        let r = client.get(url).timeout(timeout).send().await.ok()?;
        if !r.status().is_success() {
            return None;
        }
        let info: Value = r.json().await.ok()?;
        let model_id = model_id_of(&info)?;
        Some(DiscoveredPrinter {
            plugin: "anycubic".to_owned(),
            host: host.to_owned(),
            port: Some(self.probe_port),
            name: str_at(&info, &["modelName"]).map(str::to_owned),
            model: model_name(&model_id).map(str::to_owned),
            serial: str_at(&info, &["cn"]).map(str::to_owned),
            firmware: None,
            lan_only: Some(str_at(&info, &["ctrlType"]) != Some("cloud")),
            ..DiscoveredPrinter::default()
        })
    }

    async fn connect(&self, cfg: &PrinterConfig, _secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        AnycubicSession::open(cfg.clone(), self.gate.clone()).await
    }
}

struct Shared {
    cfg: PrinterConfig,
    /// The last `info` report's data, with `tempature`, `fan` and `print` progress folded in.
    info: Mutex<Value>,
    /// ACE boxes from the last `multiColorBox` report.
    boxes: Mutex<Vec<Value>>,
    /// `modelId` and `deviceId`, which name the topics.
    ids: Mutex<(String, String)>,
    /// The model and serial `/info` reported.
    identity: Mutex<(Option<String>, Option<String>)>,
    client: Mutex<Option<AsyncClient>>,
    connected: AtomicBool,
    events: broadcast::Sender<PrinterEvent>,
    have_state: watch::Sender<bool>,
    last: Mutex<Option<PrinterStatus>>,
}

impl Shared {
    fn report_topic(&self) -> String {
        let ids = self.ids.lock().unwrap_or_else(PoisonError::into_inner);
        format!("{PREFIX}/printer/public/{}/{}/#", ids.0, ids.1)
    }

    /// Where a request goes: `web` for queries and control, `slicer` for a start, which the printer
    /// takes only from the slicer sender (kobra-connect).
    fn command_topic(&self, sender: &str, msg_type: &str) -> String {
        let ids = self.ids.lock().unwrap_or_else(PoisonError::into_inner);
        format!("{PREFIX}/{sender}/printer/{}/{}/{msg_type}", ids.0, ids.1)
    }

    fn envelope(msg_type: &str, action: &str, data: &Value) -> String {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let mut id = [0_u8; 16];
        let _ = getrandom::fill(&mut id);
        json!({
            "type": msg_type,
            "action": action,
            "timestamp": u64::try_from(ts).unwrap_or(0),
            "msgid": hex(&id),
            "data": data,
        })
        .to_string()
    }

    async fn send(&self, msg_type: &str, action: &str, data: &Value) -> Result<()> {
        self.send_as("web", msg_type, action, data).await
    }

    async fn send_as(&self, sender: &str, msg_type: &str, action: &str, data: &Value) -> Result<()> {
        let client = self
            .client
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or_else(|| Error::unreachable(&self.cfg.id, "not connected to the printer"))?;
        client
            .publish(
                self.command_topic(sender, msg_type),
                QoS::AtLeastOnce,
                false,
                Self::envelope(msg_type, action, data),
            )
            .await
            .map_err(|e| Error::unreachable(&self.cfg.id, e))
    }

    /// Asks for `info`, or for the ACE (which answers `getInfo` only).
    async fn query(&self, msg_type: &str) {
        let action = if msg_type == "multiColorBox" {
            "getInfo"
        } else {
            "query"
        };
        let _ = self.send(msg_type, action, &Value::Null).await;
    }

    fn ingest(&self, topic: &str, payload: &[u8]) {
        let Ok(v) = serde_json::from_slice::<Value>(payload) else {
            return;
        };
        let msg_type = str_at(&v, &["type"])
            .map(str::to_owned)
            .or_else(|| {
                topic
                    .strip_suffix("/report")
                    .and_then(|t| t.rsplit('/').next())
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        let Some(data) = v.get("data").filter(|d| d.is_object()) else {
            return;
        };
        {
            let mut info = self.info.lock().unwrap_or_else(PoisonError::into_inner);
            match msg_type.as_str() {
                "info" => {
                    *info = data.clone();
                    let _ = self.have_state.send(true);
                }
                // The firmware's own spelling.
                "tempature" => merge(
                    info.as_object_mut().map(|o| o.entry("temp").or_insert(json!({}))),
                    data,
                ),
                "fan" => merge(Some(&mut *info), data),
                // Only the progress shape of a `print` report carries `progress`; the others are acks.
                "print" if data.get("progress").is_some() => {
                    merge(
                        info.as_object_mut()
                            .map(|o| o.entry("project").or_insert(json!({}))),
                        data,
                    );
                }
                "multiColorBox" => {
                    if let Some(list) = data.get("multi_color_box").and_then(Value::as_array) {
                        let mut boxes = self.boxes.lock().unwrap_or_else(PoisonError::into_inner);
                        for b in list {
                            let id = b.get("id");
                            match boxes.iter_mut().find(|o| o.get("id") == id) {
                                Some(o) => *o = b.clone(),
                                None => boxes.push(b.clone()),
                            }
                        }
                    }
                }
                _ => return,
            }
        }
        self.publish_changes();
    }

    fn snapshot(&self) -> PrinterStatus {
        if !self.connected.load(Ordering::Relaxed) {
            return PrinterStatus::offline(&self.cfg.id);
        }
        parse_status(
            &self.cfg.id,
            &self.info.lock().unwrap_or_else(PoisonError::into_inner),
            &self.boxes.lock().unwrap_or_else(PoisonError::into_inner),
        )
    }

    fn publish_changes(&self) {
        let now = self.snapshot();
        let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        let strip = |s: &PrinterStatus| {
            let mut c = s.clone();
            c.updated_at.clear();
            c
        };
        if let Some(prev) = last.as_ref() {
            let was_active = matches!(
                prev.state,
                PrinterState::Printing | PrinterState::Paused | PrinterState::Preparing
            );
            if was_active && matches!(now.state, PrinterState::Idle | PrinterState::Error) {
                let _ = self.events.send(PrinterEvent::JobFinished {
                    printer_id: self.cfg.id.clone(),
                    job_name: prev.job_name.clone().unwrap_or_default(),
                    ok: prev.progress.is_some_and(|p| p >= 0.98),
                });
            }
            if strip(prev) == strip(&now) {
                return;
            }
        }
        let _ = self.events.send(PrinterEvent::Status { status: now.clone() });
        *last = Some(now);
    }
}

/// Copies the fields `data` carries onto `into`, keeping the ones it leaves out.
fn merge(into: Option<&mut Value>, data: &Value) {
    let (Some(into), Some(src)) = (into, data.as_object()) else {
        return;
    };
    if !into.is_object() {
        *into = json!({});
    }
    if let Some(dst) = into.as_object_mut() {
        for (k, v) in src {
            if !v.is_null() {
                dst.insert(k.clone(), v.clone());
            }
        }
    }
}

/// `#RRGGBB` from an `[r, g, b]` color.
fn rgb_hex(c: Option<&Value>) -> Option<String> {
    let a = c?.as_array()?;
    let ch = |i: usize| {
        a.get(i)
            .and_then(Value::as_u64)
            .and_then(|n| u8::try_from(n).ok())
    };
    Some(format!("#{:02X}{:02X}{:02X}", ch(0)?, ch(1)?, ch(2)?))
}

/// The slots of the ACE boxes, `A1` to `A4` for the first, `B1` on for the second.
fn ace_units(boxes: &[Value]) -> Vec<FilamentUnit> {
    boxes
        .iter()
        .enumerate()
        .map(|(n, b)| {
            let letter = char::from(b'A' + u8::try_from(n % 26).unwrap_or(0));
            let slots = b
                .get("slots")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|s| FilamentSlot {
                    id: format!(
                        "{letter}{}",
                        s.get("index").and_then(Value::as_u64).unwrap_or(0) + 1
                    ),
                    material: str_at(s, &["type"]).filter(|t| !t.is_empty()).map(str::to_owned),
                    color: rgb_hex(s.get("color")),
                    remaining_pct: s.get("consumables_percent").and_then(Value::as_f64),
                    ..FilamentSlot::default()
                })
                .collect();
            FilamentUnit {
                id: letter.to_string(),
                kind: "ace".to_owned(),
                tool: None,
                slots,
            }
        })
        .collect()
}

/// Maps the merged `info` data and the ACE boxes to the normalized status.
///
/// `state` is `free` or `busy`. While busy, `project.state` says what runs: `preheating`,
/// `auto_leveling`, `vibrating` and `flow_calibrating` before the print, `printing`, `pausing`,
/// `paused`, `resuming`, `resumed`, `stopping`, then `stoped` (the firmware's spelling) or
/// `finished`; `project.pause` (1 paused, 2 pausing) refines it. Idle, `project` is null and
/// `last_project` keeps the job before, which is not read as current.
pub(crate) fn parse_status(id: &str, info: &Value, boxes: &[Value]) -> PrinterStatus {
    let project = info
        .get("project")
        .filter(|p| p.is_object())
        .cloned()
        .unwrap_or(Value::Null);
    let busy = str_at(info, &["state"]) == Some("busy");
    let job_state = str_at(&project, &["state"]).unwrap_or("");
    let pause = project.get("pause").and_then(Value::as_i64);
    let mut message = None;
    let state = match (busy, job_state, pause) {
        (false, _, _) => PrinterState::Idle,
        (true, "finished", _) => PrinterState::Finished,
        (true, "stoped" | "stopped", _) => {
            message = Some("The print was stopped".to_owned());
            PrinterState::Idle
        }
        (true, "pausing" | "paused", _) | (true, _, Some(1 | 2)) => PrinterState::Paused,
        (true, "printing" | "resuming" | "resumed" | "stopping", _) => PrinterState::Printing,
        (true, "preheating" | "auto_leveling" | "vibrating" | "flow_calibrating", _) => {
            PrinterState::Preparing
        }
        // Busy with something the reports do not name: not a job yet.
        (true, other, _) => {
            if !other.is_empty() {
                message = Some(format!("Busy: {other}"));
            }
            PrinterState::Preparing
        }
    };
    let active = matches!(
        state,
        PrinterState::Printing | PrinterState::Paused | PrinterState::Preparing | PrinterState::Finished
    );
    let temp = |cur: &str, tgt: &str| {
        Some(Temp {
            current: f64_at(info, &["temp", cur])?,
            target: f64_at(info, &["temp", tgt]).unwrap_or(0.0),
        })
    };
    let uint = |k: &str| {
        project
            .get(k)
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .filter(|_| active)
    };
    let units = ace_units(boxes);
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: str_at(&project, &["filename"])
            .filter(|n| active && !n.is_empty())
            .map(|n| n.rsplit('/').next().unwrap_or(n).to_owned()),
        progress: f64_at(&project, &["progress"])
            .filter(|_| active)
            .map(|p| (p / 100.0).clamp(0.0, 1.0)),
        layer: uint("curr_layer"),
        layer_count: uint("total_layers"),
        // Minutes, not seconds (kobra-lan-monitor, checked against Anycubic Slicer Next's display).
        time_left_s: f64_at(&project, &["remain_time"])
            .filter(|_| active)
            .map(|m| secs(m * 60.0)),
        nozzles: temp("curr_nozzle_temp", "target_nozzle_temp")
            .into_iter()
            .collect(),
        bed: temp("curr_hotbed_temp", "target_hotbed_temp"),
        chamber: temp("curr_chamber_temp", "target_chamber_temp"),
        slots: units.into_iter().flat_map(|u| u.slots).collect(),
        camera_available: false,
        message,
        updated_at: now_iso(),
        live: None,
    }
}

/// The task holding the connection, aborted when the session is dropped.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub struct AnycubicSession {
    gate: Arc<dyn ApprovalGate>,
    http: reqwest::Client,
    shared: Arc<Shared>,
    _task: AbortOnDrop,
}

/// One MQTT session on the credentials of one handshake, with or without the client certificate.
/// Returns when the connection drops: true when the broker took the login first. A failure before
/// that is reported to the opening call only when `last_try` says no other way is left.
async fn run_mqtt(
    shared: &Arc<Shared>,
    creds: &Creds,
    with_cert: bool,
    first: &mut Option<oneshot::Sender<Result<()>>>,
    last_try: bool,
) -> bool {
    let id = shared.cfg.id.clone();
    let mut client_id = [0_u8; 4];
    let _ = getrandom::fill(&mut client_id);
    // The broker is always the printer's own address, whatever the handshake names.
    let mut opts = MqttOptions::new(
        format!("slicerx-{}", hex(&client_id)),
        shared.cfg.host.clone(),
        creds.port,
    );
    opts.set_credentials(creds.username.clone(), creds.password.clone());
    opts.set_keep_alive(Duration::from_secs(60));
    opts.set_max_packet_size(1024 * 1024, 1024 * 1024);
    let tls = match (&creds.cert, with_cert) {
        (Some((cert, key)), true) => crate::tls::lan_client_auth_config(cert, key),
        _ => crate::tls::lan_client_config(),
    };
    let tls = match tls {
        Ok(t) => t,
        Err(e) => {
            if last_try && let Some(tx) = first.take() {
                let _ = tx.send(Err(e));
            }
            return false;
        }
    };
    let mut signed_in = false;
    opts.set_transport(Transport::tls_with_config(TlsConfiguration::Rustls(tls)));
    let (client, mut eventloop) = AsyncClient::new(opts, 32);
    *shared.client.lock().unwrap_or_else(PoisonError::into_inner) = Some(client.clone());
    let mut info_tick = tokio::time::interval(INFO_EVERY);
    let mut ace_tick = tokio::time::interval(ACE_EVERY);
    loop {
        tokio::select! {
            ev = eventloop.poll() => match ev {
                Ok(Event::Incoming(Packet::ConnAck(_))) => {
                    crate::trace(&id, format_args!("anycubic: mqtt signed in, client certificate {with_cert}"));
                    signed_in = true;
                    shared.connected.store(true, Ordering::Relaxed);
                    let _ = client.subscribe(shared.report_topic(), QoS::AtMostOnce).await;
                    shared.query("info").await;
                    shared.query("multiColorBox").await;
                    if let Some(tx) = first.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
                Ok(Event::Incoming(Packet::Publish(p))) => shared.ingest(&p.topic, &p.payload),
                Ok(_) => {}
                Err(e) => {
                    crate::trace(&id, format_args!("anycubic: mqtt dropped: {e:?}"));
                    let was = shared.connected.swap(false, Ordering::Relaxed);
                    *shared.client.lock().unwrap_or_else(PoisonError::into_inner) = None;
                    if (signed_in || last_try) && let Some(tx) = first.take() {
                        let err = match e {
                            ConnectionError::ConnectionRefused(_) => Error::Auth { printer: id.clone() },
                            ConnectionError::Tls(e) => Error::tls(&id, e),
                            other => Error::unreachable(&id, other),
                        };
                        let _ = tx.send(Err(err));
                    }
                    if was {
                        shared.publish_changes();
                    }
                    return signed_in;
                }
            },
            _ = info_tick.tick() => if shared.connected.load(Ordering::Relaxed) { shared.query("info").await },
            _ = ace_tick.tick() => if shared.connected.load(Ordering::Relaxed) { shared.query("multiColorBox").await },
        }
    }
}

impl AnycubicSession {
    async fn open(cfg: PrinterConfig, gate: Arc<dyn ApprovalGate>) -> Result<Box<dyn PrinterSession>> {
        let client = http::client(&cfg)?;
        let (info, creds) = handshake(&client, &cfg).await?;
        let model_id = model_id_of(&info).unwrap_or_default();
        let (events, _) = broadcast::channel(64);
        let (have_state, mut have_rx) = watch::channel(false);
        let shared = Arc::new(Shared {
            cfg: cfg.clone(),
            info: Mutex::new(json!({})),
            boxes: Mutex::new(Vec::new()),
            ids: Mutex::new((model_id.clone(), creds.device_id.clone())),
            identity: Mutex::new((
                model_name(&model_id)
                    .map(str::to_owned)
                    .or_else(|| str_at(&info, &["modelName"]).map(str::to_owned)),
                str_at(&info, &["cn"]).map(str::to_owned),
            )),
            client: Mutex::new(None),
            connected: AtomicBool::new(false),
            events,
            have_state,
            last: Mutex::new(None),
        });
        let (first_tx, first_rx) = oneshot::channel::<Result<()>>();
        let task = {
            let shared = shared.clone();
            tokio::spawn(async move {
                let mut first = Some(first_tx);
                let mut creds = Some(creds);
                // User and password alone first (anycubic_ha_local and anycubic-lan send no certificate);
                // the certificate only when that was refused, and from then on for this printer.
                let mut cert_first = false;
                loop {
                    let c = match creds.take() {
                        Some(c) => c,
                        // Credentials change when the printer restarts: shake hands again.
                        None => match handshake(&client, &shared.cfg).await {
                            Ok((_, c)) => c,
                            Err(e) => {
                                crate::trace(&shared.cfg.id, format_args!("anycubic: handshake failed: {e}"));
                                tokio::time::sleep(Duration::from_secs(5)).await;
                                continue;
                            }
                        },
                    };
                    let has_cert = c.cert.is_some();
                    let order: &[bool] = match (has_cert, cert_first) {
                        (false, _) => &[false],
                        (true, false) => &[false, true],
                        (true, true) => &[true, false],
                    };
                    for (n, &with_cert) in order.iter().enumerate() {
                        if run_mqtt(&shared, &c, with_cert, &mut first, n + 1 == order.len()).await {
                            cert_first = with_cert;
                            break;
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            })
        };
        let task = AbortOnDrop(task);
        match tokio::time::timeout(Duration::from_secs(10), first_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => return Err(e),
            _ => return Err(Error::timeout(&cfg.id, "the printer's broker did not answer")),
        }
        let got = tokio::time::timeout(Duration::from_secs(10), have_rx.wait_for(|v| *v)).await;
        if !matches!(got, Ok(Ok(_))) {
            return Err(Error::protocol(&cfg.id, "no status report after connecting"));
        }
        Ok(Box::new(AnycubicSession {
            gate,
            http: http::client(&cfg)?,
            shared,
            _task: task,
        }))
    }

    fn id(&self) -> &str {
        &self.shared.cfg.id
    }

    fn require(&self, action: &str, ok: &[PrinterState]) -> Result<()> {
        let s = self.shared.snapshot().state;
        if s == PrinterState::Offline {
            return Err(Error::unreachable(self.id(), "connection is down"));
        }
        if ok.contains(&s) {
            Ok(())
        } else {
            Err(Error::BadState {
                printer: self.id().to_owned(),
                state: s.to_string(),
                action: action.to_owned(),
            })
        }
    }

    /// `print` with `pause`, `resume` or `stop` and `taskid` "-1", as the app sends them.
    async fn control(&self, action: &str) -> Result<()> {
        self.shared
            .send("print", action, &json!({ "taskid": "-1" }))
            .await?;
        // The new state comes with the next info report; ask for it now.
        self.shared.query("info").await;
        Ok(())
    }
}

#[async_trait]
impl PrinterSession for AnycubicSession {
    fn capabilities(&self) -> Capabilities {
        vec![
            Capability::Status,
            Capability::Events,
            Capability::Upload,
            Capability::Start,
            Capability::Pause,
            Capability::Resume,
            Capability::Cancel,
            Capability::FilamentSlots,
        ]
    }

    async fn status(&self) -> Result<PrinterStatus> {
        Ok(self.shared.snapshot())
    }

    fn events(&self) -> BoxStream<'static, PrinterEvent> {
        let first = self.shared.snapshot();
        let rx = self.shared.events.subscribe();
        let head = stream::once(async move { PrinterEvent::Status { status: first } });
        let tail = stream::unfold(rx, |mut rx| async move {
            loop {
                match rx.recv().await {
                    Ok(e) => return Some((e, rx)),
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        });
        head.chain(tail).boxed()
    }

    /// The model from `modelId`, the firmware from the `info` report, the serial (`cn`) and the ACE
    /// units with their slots. Build volume and nozzle size are not reported.
    async fn hardware(&self) -> Result<Option<PrinterHardware>> {
        let (model, serial) = self
            .shared
            .identity
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let firmware = str_at(
            &self.shared.info.lock().unwrap_or_else(PoisonError::into_inner),
            &["version"],
        )
        .map(str::to_owned);
        let boxes = self
            .shared
            .boxes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        Ok(Some(PrinterHardware {
            model,
            firmware,
            serial,
            extruders: vec![ExtruderInfo::default()],
            filament_units: ace_units(&boxes),
            ..PrinterHardware::default()
        }))
    }

    fn reported_model(&self) -> Option<String> {
        self.shared
            .identity
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .0
            .clone()
    }

    async fn upload(&self, file: JobFile, token: &ApprovalToken) -> Result<RemoteFile> {
        self.gate.check(
            token,
            Action::Upload,
            self.id(),
            &params::upload(self.id(), &file.name, &file.sha256),
        )?;
        if file.name.contains(['/', '\\']) || file.name.is_empty() {
            return Err(Error::protocol(self.id(), "unsafe file name"));
        }
        // The upload address carries a secret (`s=`) and comes from the `info` report; it must be on
        // the printer itself, and it is never written to a log or an error.
        let url = str_at(
            &self.shared.info.lock().unwrap_or_else(PoisonError::into_inner),
            &["urls", "fileUploadurl"],
        )
        .map(str::to_owned)
        .filter(|u| http::same_host(u, &self.shared.cfg.host))
        .ok_or_else(|| {
            Error::not_supported(
                "anycubic",
                "uploads on this printer (its info report names no upload address)",
            )
        })?;
        // As kobra-lan-monitor sends it (packet capture): a `filename` field, the file under `gcode`,
        // and its length in `X-File-Length`.
        let form = reqwest::multipart::Form::new()
            .text("filename", file.name.clone())
            .part(
                "gcode",
                reqwest::multipart::Part::bytes(file.data.clone()).file_name(file.name.clone()),
            );
        let rb = self
            .http
            .post(url)
            .header("X-File-Length", file.data.len().to_string())
            .timeout(Duration::from_secs(300))
            .multipart(form);
        http::send(self.id(), rb).await?;
        Ok(RemoteFile {
            printer_id: self.id().to_owned(),
            path: file.name.clone(),
            name: file.name,
            sha256: Some(file.sha256),
        })
    }

    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()> {
        opts.refuse_slot_map("anycubic")?;
        self.gate.check(
            token,
            Action::Start,
            self.id(),
            &params::start(self.id(), file, &opts),
        )?;
        self.require("start a job", &[PrinterState::Idle, PrinterState::Finished])?;
        let data = json!({ "taskid": "-1", "filename": file.path, "filepath": "/", "filetype": 1 });
        self.shared.send_as("slicer", "print", "start", &data).await?;
        self.shared.query("info").await;
        Ok(())
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Pause, self.id(), &params::printer(self.id()))?;
        self.require("pause", &[PrinterState::Printing])?;
        self.control("pause").await
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Resume, self.id(), &params::printer(self.id()))?;
        self.require("resume", &[PrinterState::Paused])?;
        self.control("resume").await
    }

    async fn cancel(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Cancel, self.id(), &params::printer(self.id()))?;
        self.require(
            "cancel",
            &[
                PrinterState::Printing,
                PrinterState::Paused,
                PrinterState::Preparing,
            ],
        )?;
        self.control("stop").await
    }

    /// The camera is an FLV stream (port 18088) that SlicerX does not read yet.
    async fn snapshot(&self) -> Result<Option<Image>> {
        Ok(None)
    }

    /// The LAN protocol has no G-code command.
    async fn send_gcode(&self, _line: &str, _token: &ApprovalToken) -> Result<()> {
        Err(Error::not_supported("anycubic", "the G-code console"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_signature_follows_the_documented_recipe() {
        let token = "0123456789abcdefFEDCBA9876543210";
        let first = hex(&Md5::digest(b"0123456789abcdef"));
        let want = hex(&Md5::digest(format!("{first}1700000000000aB3dE9").as_bytes()));
        assert_eq!(sign(token, 1_700_000_000_000, "aB3dE9"), want);
    }

    #[test]
    fn the_credentials_decrypt() {
        use aes::cipher::{BlockModeEncrypt, KeyIvInit, block_padding::Pkcs7};
        let token = "0123456789abcdefFEDCBA9876543210";
        let local = "localtoken";
        let plain = br#"{"broker":"mqtts://192.0.2.5:9883","username":"u","password":"p","deviceId":"d"}"#;
        let mut iv = [0_u8; 16];
        iv[..local.len()].copy_from_slice(local.as_bytes());
        let key: [u8; 16] = token.as_bytes()[16..32].try_into().unwrap();
        let ct =
            cbc::Encryptor::<aes::Aes128>::new(&key.into(), &iv.into()).encrypt_padded_vec::<Pkcs7>(plain);
        let b64 = base64::engine::general_purpose::STANDARD.encode(ct);
        let v = decrypt_ctrl(&b64, token, local).unwrap();
        assert_eq!(v["deviceId"], "d");
        assert!(decrypt_ctrl(&b64, "short", local).is_none());
        assert!(decrypt_ctrl("not base64!", token, local).is_none());
    }

    #[test]
    fn states_and_ace_slots_map() {
        let info = |state: &str, job: &str, pause: i64| {
            json!({ "state": state, "temp": { "curr_nozzle_temp": 210, "target_nozzle_temp": 210, "curr_hotbed_temp": 60, "target_hotbed_temp": 60 },
                "project": { "state": job, "pause": pause, "progress": 40, "curr_layer": 12, "total_layers": 100, "remain_time": 30, "filename": "/useremain/app/gk/gcodes/cube.gcode" } })
        };
        let s = parse_status("p", &info("busy", "printing", 0), &[]);
        assert_eq!(s.state, PrinterState::Printing);
        assert_eq!(
            (s.job_name.as_deref(), s.progress, s.time_left_s),
            (Some("cube.gcode"), Some(0.4), Some(1800))
        );
        assert_eq!(
            parse_status("p", &info("busy", "printing", 1), &[]).state,
            PrinterState::Paused
        );
        let stopped = parse_status("p", &info("busy", "stoped", 0), &[]);
        assert_eq!(
            (stopped.state, stopped.message.as_deref()),
            (PrinterState::Idle, Some("The print was stopped"))
        );
        assert_eq!(
            parse_status("p", &info("free", "printing", 0), &[]).state,
            PrinterState::Idle
        );
        let boxes = vec![
            json!({ "id": 0, "slots": [{ "index": 0, "type": "PLA", "color": [255, 0, 16], "consumables_percent": 80 }, { "index": 1, "type": "" }] }),
        ];
        let s = parse_status("p", &info("free", "", 0), &boxes);
        assert_eq!(s.slots[0].id, "A1");
        assert_eq!(
            (s.slots[0].material.as_deref(), s.slots[0].color.as_deref()),
            (Some("PLA"), Some("#FF0010"))
        );
        assert_eq!(s.slots[1].material, None);
        assert_eq!(model_name("20024"), Some("Kobra 3"));
        assert_eq!(model_name("20029"), Some("Kobra S1 Max"));
    }
}
