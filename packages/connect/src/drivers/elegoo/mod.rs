// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Elegoo Centauri Carbon over SDCP V3.0.0 (WebSocket on port 3030, HTTP upload on the same
//! port). Klipper based Elegoo models (Neptune 4) speak Moonraker and use that driver.
//! See README.md for sources and what is verified.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::{self, BoxStream, StreamExt};
use md5::{Digest, Md5};
use reqwest::multipart::{Form, Part};
use serde_json::{Value, json};
use tokio::net::UdpSocket;
use tokio::sync::{broadcast, oneshot, watch};

use crate::camera;
use crate::error::{Error, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http;
use crate::manifest::{PluginManifest, manifest};
use crate::types::{
    Capabilities, Capability, DiscoveredPrinter, Image, JobFile, PrinterConfig, PrinterEvent, PrinterState,
    PrinterStatus, RemoteFile, Secrets, StartOptions, Temp, hex, now_iso,
};
use crate::wslink::{OnLink, OnText, WsLink, WsLinkSpec};
use crate::{PrinterConnector, PrinterSession};

const CHUNK: usize = 1024 * 1024;

pub struct ElegooConnector {
    gate: Arc<dyn ApprovalGate>,
    /// The address the discovery broadcast goes out from: all addresses in the app, loopback in tests.
    discovery_bind: std::net::IpAddr,
    /// The UDP port printers answer `M99999` on: 3000, another in tests.
    discovery_port: u16,
}

impl ElegooConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            gate,
            discovery_bind: std::net::Ipv4Addr::UNSPECIFIED.into(),
            discovery_port: 3000,
        }
    }

    /// Asks printers on `port` instead of 3000.
    #[must_use]
    pub fn with_discovery_port(mut self, port: u16) -> Self {
        self.discovery_port = port;
        self
    }

    /// Sends the discovery broadcast from `ip` instead of every address.
    #[must_use]
    pub fn with_discovery_bind(mut self, ip: std::net::IpAddr) -> Self {
        self.discovery_bind = ip;
        self
    }
}

#[async_trait]
impl PrinterConnector for ElegooConnector {
    fn manifest(&self) -> PluginManifest {
        manifest("elegoo").unwrap_or_else(|| super::prusalink::unreachable_manifest("elegoo"))
    }

    /// SDCP discovery is a UDP broadcast of `M99999` to port 3000. That is a probe on the whole
    /// network, so it is only sent when the user starts a scan, and only to the limited
    /// broadcast address. Replies are parsed by [`parse_discovery`].
    async fn discover(&self, timeout: Duration) -> Vec<DiscoveredPrinter> {
        // One socket per local network, so the broadcast leaves on each (see netif.rs); the
        // configured address alone in tests.
        let senders: Vec<(std::net::IpAddr, Vec<std::net::SocketAddr>)> = match self.discovery_bind {
            std::net::IpAddr::V4(ip) if ip.is_unspecified() => crate::netif::lan_v4()
                .into_iter()
                .map(|i| {
                    (
                        i.ip.into(),
                        vec![
                            (i.broadcast, 3000).into(),
                            (std::net::Ipv4Addr::BROADCAST, 3000).into(),
                        ],
                    )
                })
                .collect(),
            ip => vec![(ip, vec![(std::net::Ipv4Addr::BROADCAST, 3000).into()])],
        };
        let runs = senders.into_iter().map(|(ip, to)| async move {
            let sock = match ip {
                std::net::IpAddr::V4(v4) if !v4.is_loopback() => crate::netif::sender(v4).ok(),
                _ => UdpSocket::bind((ip, 0))
                    .await
                    .ok()
                    .filter(|s| s.set_broadcast(true).is_ok()),
            };
            let Some(sock) = sock else {
                return Vec::new();
            };
            let mut sent = false;
            for t in to {
                sent |= sock.send_to(b"M99999", t).await.is_ok();
            }
            if !sent {
                return Vec::new();
            }
            let mut out = Vec::new();
            let mut buf = vec![0_u8; 4096];
            let end = tokio::time::Instant::now() + timeout;
            while let Ok(r) = tokio::time::timeout_at(end, sock.recv_from(&mut buf)).await {
                if let Some(p) = r
                    .ok()
                    .and_then(|(n, _)| buf.get(..n))
                    .and_then(|d| std::str::from_utf8(d).ok())
                    .and_then(parse_discovery)
                {
                    out.push(p);
                }
            }
            out
        });
        let mut found: Vec<DiscoveredPrinter> = Vec::new();
        for p in futures::future::join_all(runs).await.into_iter().flatten() {
            if !found.iter().any(|f| f.host == p.host) {
                found.push(p);
            }
        }
        found
    }

    /// Sends `M99999` to one address, for a typed IP the scan did not hear. The answer confirms an
    /// SDCP printer and names it, its model and firmware, before the WebSocket is tried.
    async fn probe(&self, host: &str, timeout: Duration) -> Option<DiscoveredPrinter> {
        let std::net::IpAddr::V4(v4) = host.parse().ok()? else {
            return None;
        };
        let bind = if v4.is_loopback() {
            std::net::Ipv4Addr::LOCALHOST
        } else {
            std::net::Ipv4Addr::UNSPECIFIED
        };
        let sock = UdpSocket::bind((bind, 0)).await.ok()?;
        sock.send_to(b"M99999", (v4, self.discovery_port)).await.ok()?;
        let mut buf = vec![0_u8; 4096];
        let end = tokio::time::Instant::now() + timeout;
        while let Ok(r) = tokio::time::timeout_at(end, sock.recv_from(&mut buf)).await {
            let Ok((n, from)) = r else { continue };
            if from.ip() != std::net::IpAddr::V4(v4) {
                continue;
            }
            let text = buf.get(..n).and_then(|d| std::str::from_utf8(d).ok());
            // The printer may name another of its addresses; the one typed is the one that answered.
            if let Some(mut p) = text.and_then(parse_discovery) {
                host.clone_into(&mut p.host);
                return Some(p);
            }
        }
        None
    }

    async fn connect(&self, cfg: &PrinterConfig, _secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        ElegooSession::open(cfg.clone(), self.gate.clone()).await
    }
}

/// Parses one SDCP discovery reply.
pub fn parse_discovery(text: &str) -> Option<DiscoveredPrinter> {
    let v: Value = serde_json::from_str(text).ok()?;
    let d = v.get("Data")?;
    let host = d.get("MainboardIP")?.as_str()?.to_owned();
    host.parse::<std::net::IpAddr>().ok()?;
    Some(DiscoveredPrinter {
        plugin: "elegoo".to_owned(),
        host,
        port: Some(3030),
        name: d.get("Name").and_then(Value::as_str).map(str::to_owned),
        model: d.get("MachineName").and_then(Value::as_str).map(str::to_owned),
        serial: d.get("MainboardID").and_then(Value::as_str).map(str::to_owned),
        firmware: d
            .get("FirmwareVersion")
            .and_then(Value::as_str)
            .map(str::to_owned),
        lan_only: None,
        ..DiscoveredPrinter::default()
    })
}

struct Shared {
    cfg: PrinterConfig,
    /// Merged `Status` object from `sdcp/status` messages.
    state: Mutex<Value>,
    mainboard: Mutex<String>,
    connected: AtomicBool,
    events: broadcast::Sender<PrinterEvent>,
    have_state: watch::Sender<bool>,
    last: Mutex<Option<PrinterStatus>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl Shared {
    fn snapshot(&self) -> PrinterStatus {
        if !self.connected.load(Ordering::Relaxed) {
            return PrinterStatus::offline(&self.cfg.id);
        }
        parse_status(
            &self.cfg.id,
            &self.state.lock().unwrap_or_else(PoisonError::into_inner),
        )
    }

    fn ingest(&self, text: &str) {
        let Ok(v) = serde_json::from_str::<Value>(text) else {
            return;
        };
        if let Some(topic) = v.get("Topic").and_then(Value::as_str)
            && topic.starts_with("sdcp/response/")
        {
            {
                let rid = v
                    .get("Data")
                    .and_then(|d| d.get("RequestID"))
                    .and_then(Value::as_str);
                if let Some(tx) = rid.and_then(|r| {
                    self.pending
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .remove(r)
                }) {
                    let _ = tx.send(v);
                }
                return;
            }
        }
        let Some(status) = v.get("Status").and_then(Value::as_object) else {
            return;
        };
        if let Some(id) = v
            .get("MainboardID")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            id.clone_into(&mut self.mainboard.lock().unwrap_or_else(PoisonError::into_inner));
        }
        {
            let mut st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if !st.is_object() {
                *st = json!({});
            }
            if let Some(obj) = st.as_object_mut() {
                for (k, val) in status {
                    obj.insert(k.clone(), val.clone());
                }
            }
        }
        let _ = self.have_state.send(true);
        self.publish_changes();
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
            if was_active
                && matches!(
                    now.state,
                    PrinterState::Finished | PrinterState::Idle | PrinterState::Error
                )
            {
                let _ = self.events.send(PrinterEvent::JobFinished {
                    printer_id: self.cfg.id.clone(),
                    job_name: prev.job_name.clone().unwrap_or_default(),
                    ok: now.state == PrinterState::Finished || prev.progress.is_some_and(|p| p >= 0.98),
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

/// Maps the merged SDCP `Status` object to the normalized status.
pub(crate) fn parse_status(id: &str, s: &Value) -> PrinterStatus {
    let info = s.get("PrintInfo").cloned().unwrap_or(Value::Null);
    let state = match info.get("Status").and_then(Value::as_i64).unwrap_or(0) {
        13 | 20 => PrinterState::Printing,
        5 | 10 => PrinterState::Paused,
        8 | 9 => PrinterState::Preparing,
        _ => PrinterState::Idle,
    };
    let active = state != PrinterState::Idle;
    let num = |k: &str| s.get(k).and_then(Value::as_f64);
    let temp = |cur: &str, tgt: &str| {
        num(cur).map(|c| Temp {
            current: c,
            target: num(tgt).unwrap_or(0.0),
        })
    };
    let uint = |k: &str| info.get(k).and_then(Value::as_u64);
    let name = info
        .get("Filename")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty());
    // Ticks are seconds on the Centauri Carbon; SDCP leaves the unit open.
    let left = match (uint("TotalTicks"), uint("CurrentTicks")) {
        (Some(t), Some(c)) if t >= c => Some(t - c),
        _ => None,
    };
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: if active {
            name.map(|n| n.rsplit('/').next().unwrap_or(n).to_owned())
        } else {
            None
        },
        progress: if active {
            info.get("Progress").and_then(Value::as_f64).map(|p| p / 100.0)
        } else {
            None
        },
        layer: uint("CurrentLayer")
            .and_then(|n| u32::try_from(n).ok())
            .filter(|_| active),
        layer_count: uint("TotalLayer")
            .and_then(|n| u32::try_from(n).ok())
            .filter(|_| active),
        time_left_s: left.filter(|_| active),
        nozzles: temp("TempOfNozzle", "TempTargetNozzle").into_iter().collect(),
        bed: temp("TempOfHotbed", "TempTargetHotbed"),
        chamber: temp("TempOfBox", "TempTargetBox"),
        slots: Vec::new(),
        camera_available: true,
        message: None,
        updated_at: now_iso(),
        live: None,
    }
}

pub struct ElegooSession {
    cfg: PrinterConfig,
    gate: Arc<dyn ApprovalGate>,
    shared: Arc<Shared>,
    link: WsLink,
}

fn rand_hex(n: usize) -> String {
    let mut b = vec![0_u8; n];
    if getrandom::fill(&mut b).is_err() {
        b.iter_mut()
            .enumerate()
            .for_each(|(i, x)| *x = u8::try_from(i % 251).unwrap_or(0));
    }
    hex(&b)
}

impl ElegooSession {
    async fn open(cfg: PrinterConfig, gate: Arc<dyn ApprovalGate>) -> Result<Box<dyn PrinterSession>> {
        let url = format!("ws://{}:{}/websocket", cfg.host, cfg.port.unwrap_or(3030));
        let (events, _) = broadcast::channel(64);
        let (have_state, mut have_rx) = watch::channel(false);
        let shared = Arc::new(Shared {
            cfg: cfg.clone(),
            state: Mutex::new(json!({})),
            mainboard: Mutex::new(String::new()),
            connected: AtomicBool::new(false),
            events,
            have_state,
            last: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        });
        let spec = WsLinkSpec {
            url,
            subprotocol: None,
            greeting: {
                let shared = shared.clone();
                Arc::new(move || vec![envelope(&shared, 0, &json!({}), &rand_hex(8))])
            },
            // The printer closes idle sockets after 60 seconds.
            keepalive: Some((Duration::from_secs(20), "ping".to_owned())),
        };
        let on_text: OnText = {
            let shared = shared.clone();
            Arc::new(move |t| {
                shared.ingest(t);
                None
            })
        };
        let on_link: OnLink = {
            let shared = shared.clone();
            Arc::new(move |up| {
                shared.connected.store(up, Ordering::Relaxed);
                if !up {
                    shared.publish_changes();
                }
            })
        };
        let link = WsLink::start(&cfg.id, spec, on_text, on_link).await?;
        let got = tokio::time::timeout(Duration::from_secs(8), have_rx.wait_for(|v| *v)).await;
        if !matches!(got, Ok(Ok(_))) {
            return Err(Error::protocol(&cfg.id, "no SDCP status after connecting"));
        }
        Ok(Box::new(ElegooSession {
            cfg,
            gate,
            shared,
            link,
        }))
    }

    fn id(&self) -> &str {
        &self.cfg.id
    }

    /// Sends one SDCP command and waits for its acknowledgment.
    async fn command(&self, cmd: u32, data: Value) -> Result<Value> {
        if !self.shared.connected.load(Ordering::Relaxed) {
            return Err(Error::unreachable(self.id(), "WebSocket connection is down"));
        }
        let rid = rand_hex(8);
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(rid.clone(), tx);
        self.link
            .out
            .send(envelope(&self.shared, cmd, &data, &rid))
            .map_err(|_| Error::unreachable(self.id(), "connection closed"))?;
        let Ok(Ok(resp)) = tokio::time::timeout(Duration::from_secs(8), rx).await else {
            self.shared
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&rid);
            return Err(Error::unreachable(self.id(), "no reply to command"));
        };
        let body = resp
            .get("Data")
            .and_then(|d| d.get("Data"))
            .cloned()
            .unwrap_or(Value::Null);
        match body.get("Ack").and_then(Value::as_i64) {
            Some(0) | None => Ok(body),
            Some(2) => Err(Error::NotFound {
                printer: self.id().to_owned(),
                what: "file".to_owned(),
            }),
            Some(n) => Err(Error::protocol(
                self.id(),
                format!("command {cmd} refused with code {n}"),
            )),
        }
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
}

fn envelope(shared: &Shared, cmd: u32, data: &Value, request_id: &str) -> String {
    let mainboard = shared
        .mainboard
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    json!({
        "Id": "",
        "Data": { "Cmd": cmd, "Data": data, "RequestID": request_id, "MainboardID": mainboard, "TimeStamp": u64::try_from(ts).unwrap_or(0), "From": 1 },
        "Topic": format!("sdcp/request/{mainboard}"),
    })
    .to_string()
}

#[async_trait]
impl PrinterSession for ElegooSession {
    fn capabilities(&self) -> Capabilities {
        vec![
            Capability::Status,
            Capability::Events,
            Capability::Upload,
            Capability::Start,
            Capability::Pause,
            Capability::Resume,
            Capability::Cancel,
            Capability::Camera,
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

    /// Chunked HTTP upload of up to 1 MiB per request, as SDCP V3.0.0 describes it.
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
        let md5 = hex(&Md5::digest(&file.data));
        let uuid = rand_hex(16);
        let total = file.data.len();
        let client = http::client(&self.cfg)?;
        let url = format!(
            "http://{}:{}/uploadFile/upload",
            self.cfg.host,
            self.cfg.port.unwrap_or(3030)
        );
        let mut offset = 0_usize;
        loop {
            let end = (offset + CHUNK).min(total);
            let chunk = file.data.get(offset..end).unwrap_or_default().to_vec();
            let form = Form::new()
                .text("Check", "1")
                .text("S-File-MD5", md5.clone())
                .text("Offset", offset.to_string())
                .text("Uuid", uuid.clone())
                .text("TotalSize", total.to_string())
                .part("File", Part::bytes(chunk).file_name(file.name.clone()));
            let resp = http::send(self.id(), client.post(&url).multipart(form)).await?;
            let v = http::json(self.id(), resp).await?;
            if v.get("success").and_then(Value::as_bool) != Some(true) {
                return Err(Error::protocol(self.id(), "upload chunk refused"));
            }
            if end >= total {
                break;
            }
            offset = end;
        }
        Ok(RemoteFile {
            printer_id: self.id().to_owned(),
            path: format!("/local/{}", file.name),
            name: file.name,
            sha256: Some(file.sha256),
        })
    }

    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()> {
        opts.refuse_slot_map("elegoo")?;
        self.gate.check(
            token,
            Action::Start,
            self.id(),
            &params::start(self.id(), file, &opts),
        )?;
        self.require("start a job", &[PrinterState::Idle, PrinterState::Finished])?;
        self.command(
            128,
            json!({
                "Filename": file.path,
                "StartLayer": 0,
                "Calibration_switch": i32::from(opts.bed_leveling.unwrap_or(true)),
                "PrintPlatformType": 0,
                "Tlp_Switch": i32::from(opts.timelapse.unwrap_or(false)),
            }),
        )
        .await
        .map(|_| ())
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Pause, self.id(), &params::printer(self.id()))?;
        self.require("pause", &[PrinterState::Printing])?;
        self.command(129, json!({})).await.map(|_| ())
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Resume, self.id(), &params::printer(self.id()))?;
        self.require("resume", &[PrinterState::Paused])?;
        self.command(131, json!({})).await.map(|_| ())
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
        self.command(130, json!({})).await.map(|_| ())
    }

    /// Asks the printer to enable its MJPEG stream (Cmd 386) and streams it.
    async fn stream(&self) -> Result<Option<camera::FrameStream>> {
        let body = self.command(386, json!({ "Enable": 1 })).await?;
        let Some(url) = body.get("VideoUrl").and_then(Value::as_str).map(str::to_owned) else {
            return Ok(None);
        };
        let ok_host = url
            .strip_prefix("http://")
            .and_then(|r| r.split(['/', ':']).next())
            .is_some_and(|h| h == self.cfg.host);
        if !ok_host {
            return Ok(None);
        }
        let client = http::client(&self.cfg)?;
        Ok(camera::mjpeg_stream(&client, &url).await)
    }

    /// Asks the printer to enable its MJPEG stream (Cmd 386) and reads the first frame.
    async fn snapshot(&self) -> Result<Option<Image>> {
        let body = self.command(386, json!({ "Enable": 1 })).await?;
        let Some(url) = body.get("VideoUrl").and_then(Value::as_str).map(str::to_owned) else {
            return Ok(None);
        };
        // The printer reports its own address, which must still be the host we were given.
        let ok_host = url
            .strip_prefix("http://")
            .and_then(|r| r.split(['/', ':']).next())
            .is_some_and(|h| h == self.cfg.host);
        if !ok_host {
            return Ok(None);
        }
        let client = http::client(&self.cfg)?;
        Ok(http::mjpeg_frame(&client, &url).await)
    }

    /// SDCP has no G-code console.
    async fn send_gcode(&self, _line: &str, _token: &ApprovalToken) -> Result<()> {
        Err(Error::not_supported("elegoo", "the G-code console"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_reply() {
        let r = r#"{"Id":"x","Data":{"Name":"Bay 6","MachineName":"Centauri Carbon","BrandName":"ELEGOO","MainboardIP":"192.0.2.16","MainboardID":"000000000001d354","ProtocolVersion":"V3.0.0","FirmwareVersion":"V1.0.0"}}"#;
        let p = parse_discovery(r).unwrap();
        assert_eq!(p.host, "192.0.2.16");
        assert_eq!(p.model.as_deref(), Some("Centauri Carbon"));
        assert_eq!(p.firmware.as_deref(), Some("V1.0.0"));
        assert!(parse_discovery(r#"{"Data":{"MainboardIP":"not an ip"}}"#).is_none());
    }

    #[tokio::test]
    async fn probe_asks_one_address() {
        let printer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = printer.local_addr().unwrap().port();
        // The printer names its Wi-Fi address while the typed one is another of its own.
        let answer = r#"{"Id":"x","Data":{"Name":"Bay 6","MachineName":"Centauri Carbon","MainboardIP":"192.0.2.16","MainboardID":"000000000001d354","FirmwareVersion":"V1.1.29"}}"#;
        tokio::spawn(async move {
            let mut buf = [0_u8; 64];
            while let Ok((n, from)) = printer.recv_from(&mut buf).await {
                if &buf[..n] == b"M99999" {
                    printer.send_to(answer.as_bytes(), from).await.unwrap();
                }
            }
        });
        let c = ElegooConnector::new(Arc::new(crate::MemoryGate::new())).with_discovery_port(port);
        let p = c.probe("127.0.0.1", Duration::from_millis(500)).await.unwrap();
        assert_eq!(p.host, "127.0.0.1");
        assert_eq!(p.model.as_deref(), Some("Centauri Carbon"));
        assert_eq!(p.firmware.as_deref(), Some("V1.1.29"));
        assert!(c.probe("127.0.0.2", Duration::from_millis(100)).await.is_none());
        assert!(c.probe("not an ip", Duration::from_millis(100)).await.is_none());
    }

    #[test]
    fn status_mapping() {
        let s = json!({
            "CurrentStatus": [1], "TempOfNozzle": 219.0, "TempTargetNozzle": 220, "TempOfHotbed": 60.0, "TempTargetHotbed": 60, "TempOfBox": 35.0,
            "PrintInfo": { "Status": 13, "CurrentLayer": 40, "TotalLayer": 200, "CurrentTicks": 600, "TotalTicks": 3600, "Filename": "/local/lantern.gcode", "Progress": 20 }
        });
        let st = parse_status("bay-6", &s);
        assert_eq!(st.state, PrinterState::Printing);
        assert_eq!(st.job_name.as_deref(), Some("lantern.gcode"));
        assert_eq!(st.progress, Some(0.2));
        assert_eq!(st.time_left_s, Some(3000));
        assert_eq!(st.chamber.map(|c| c.current), Some(35.0));
        assert_eq!(
            parse_status("x", &json!({ "PrintInfo": { "Status": 10 } })).state,
            PrinterState::Paused
        );
    }
}
