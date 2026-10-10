// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Bambu Lab printers in LAN mode: MQTT over TLS on 8883 for status and commands, FTPS on
//! 990 for uploads, a TLS JPEG stream on 6000 for the camera of A1 and P1 printers, and
//! SSDP announcements for discovery. See README.md for sources.
use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::{self, BoxStream, StreamExt};
use rumqttc::{AsyncClient, ConnectionError, Event, MqttOptions, Packet, QoS, TlsConfiguration, Transport};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{broadcast, oneshot, watch};

use crate::camera::{self, CameraFrame, FrameKind, FrameStream};
use crate::error::{Error, Result};
use crate::ftps::{self, FtpsTarget};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::manifest::{PluginManifest, manifest};
use crate::netif;
use crate::rtsp;
use crate::tls::{bambu_client_config, bambu_lan_config};
use crate::types::{
    Adjustment, Capabilities, Capability, DiscoveredPrinter, FanKind, Fans, FilamentSlot, Image, JobFile,
    JobKind, LiveUnit, PrinterConfig, PrinterEvent, PrinterLive, PrinterState, PrinterStatus, RemoteFile,
    Secrets, SlotSetting, StartOptions, Temp, now_iso,
};
use crate::{PrinterConnector, PrinterSession};

mod hms;

const USER: &str = "bblp";

pub struct BambuConnector {
    gate: Arc<dyn ApprovalGate>,
    /// The address discovery listens on: all addresses in the app, loopback in tests.
    discovery_bind: std::net::IpAddr,
    /// The ports announcements are heard on: 2021 and 1990 on real printers.
    ssdp_ports: Vec<u16>,
    /// Where a scan sends its search. `None`: the SSDP group and the broadcast address of every
    /// local network interface.
    search_targets: Option<Vec<SocketAddr>>,
    /// The MQTT port a probe reads the certificate from: 8883 on real printers, the mock's in tests.
    mqtt_port: Option<u16>,
}

impl BambuConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            gate,
            discovery_bind: std::net::Ipv4Addr::UNSPECIFIED.into(),
            ssdp_ports: SSDP_PORTS.to_vec(),
            search_targets: None,
            mqtt_port: None,
        }
    }

    /// Listens for printer announcements on `ip` instead of every address.
    #[must_use]
    pub fn with_discovery_bind(mut self, ip: std::net::IpAddr) -> Self {
        self.discovery_bind = ip;
        self
    }

    /// Listens for announcements on `ports` and sends the search to `targets` instead of the real
    /// SSDP ports and every interface (tests). A probe asks on the targets' ports.
    #[must_use]
    pub fn with_ssdp(mut self, ports: Vec<u16>, targets: Vec<SocketAddr>) -> Self {
        self.ssdp_ports = ports;
        self.search_targets = Some(targets);
        self
    }

    /// Reads a probed printer's certificate on `port` instead of 8883 (tests).
    #[must_use]
    pub fn with_mqtt_port(mut self, port: u16) -> Self {
        self.mqtt_port = Some(port);
        self
    }

    fn bind_v4(&self) -> Ipv4Addr {
        match self.discovery_bind {
            std::net::IpAddr::V4(ip) => ip,
            std::net::IpAddr::V6(_) => Ipv4Addr::UNSPECIFIED,
        }
    }
}

/// Bambu printers announce on UDP 2021 (newer firmware) and 1990, and answer a search on either.
pub const SSDP_PORTS: [u16; 2] = [2021, 1990];
const SSDP_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const SEARCH_TARGET: &str = "urn:bambulab-com:device:3dprinter:1";

/// The SSDP search Bambu Studio sends. Printers answer it by unicast within a fraction of a second,
/// in LAN only mode and in cloud mode alike.
fn search_message() -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: {SEARCH_TARGET}\r\n\r\n"
    )
}

/// Reads SSDP datagrams from `sock` until `end`, sending the search to `ask` at the start and again
/// after a third and two thirds of the window (Wi-Fi drops broadcasts). Errors on one datagram (an
/// ICMP reply on Windows, a datagram too large) do not end the scan.
async fn collect(
    sock: UdpSocket,
    ask: Vec<SocketAddr>,
    window: Duration,
    only_from: Option<std::net::IpAddr>,
) -> Vec<DiscoveredPrinter> {
    let msg = search_message();
    let start = tokio::time::Instant::now();
    let end = start + window;
    let step = (window / 3).max(Duration::from_millis(100));
    let mut next_send = start;
    let mut out = Vec::new();
    let mut buf = vec![0_u8; 4096];
    loop {
        let now = tokio::time::Instant::now();
        if now >= end {
            break;
        }
        if !ask.is_empty() && now >= next_send {
            for to in &ask {
                let _ = sock.send_to(msg.as_bytes(), to).await;
            }
            next_send = now + step;
        }
        let wake = if ask.is_empty() { end } else { next_send.min(end) };
        match tokio::time::timeout_at(wake, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, from))) => {
                if only_from.is_some_and(|ip| ip != from.ip()) {
                    continue;
                }
                if let Some(p) = buf
                    .get(..n)
                    .and_then(|d| std::str::from_utf8(d).ok())
                    .and_then(parse_ssdp)
                {
                    out.push(p);
                }
            }
            Ok(Err(_)) => tokio::time::sleep(Duration::from_millis(20)).await,
            Err(_) => {}
        }
    }
    out
}

/// Asks one printer the search question directly, for the name it announces (and its model and
/// serial). Each port in `ports` (2021 and 1990 on real printers) gets its own socket on an
/// ephemeral port, bound to the one address the route to the printer leaves from and connected to
/// the printer, so it hears only that printer's answer. Nothing listens on the discovery ports and
/// nothing is broadcast: this is not a network search.
pub async fn ask_one(ip: Ipv4Addr, ports: &[u16], timeout: Duration) -> Option<DiscoveredPrinter> {
    let asks = ports.iter().map(|&port| async move {
        let sock = connected_to(SocketAddr::from((ip, port))).ok()?;
        let msg = search_message();
        let end = tokio::time::Instant::now() + timeout;
        let step = (timeout / 3).max(Duration::from_millis(100));
        let mut next_send = tokio::time::Instant::now();
        let mut buf = vec![0_u8; 4096];
        loop {
            let now = tokio::time::Instant::now();
            if now >= end {
                return None;
            }
            if now >= next_send {
                let _ = sock.send(msg.as_bytes()).await;
                next_send = now + step;
            }
            match tokio::time::timeout_at(next_send.min(end), sock.recv(&mut buf)).await {
                Ok(Ok(n)) => {
                    let heard = buf
                        .get(..n)
                        .and_then(|d| std::str::from_utf8(d).ok())
                        .and_then(parse_ssdp);
                    if let Some(p) = heard.filter(|p| p.host == ip.to_string()) {
                        return Some(p);
                    }
                }
                // An ICMP port unreachable reads as an error on Windows; the next send tries again.
                Ok(Err(_)) => tokio::time::sleep(Duration::from_millis(20)).await,
                Err(_) => {}
            }
        }
    });
    futures::future::join_all(asks).await.into_iter().flatten().next()
}

/// A UDP socket connected to `to`, on an ephemeral port of the local address the route to `to`
/// leaves from (found with a socket that is connected but never sends).
fn connected_to(to: SocketAddr) -> std::io::Result<UdpSocket> {
    let route = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    route.connect(to)?;
    let local = route.local_addr()?.ip();
    drop(route);
    let s = std::net::UdpSocket::bind((local, 0))?;
    s.connect(to)?;
    s.set_nonblocking(true)?;
    UdpSocket::from_std(s)
}

fn merge_found(lists: Vec<Vec<DiscoveredPrinter>>) -> Vec<DiscoveredPrinter> {
    let mut found: BTreeMap<String, DiscoveredPrinter> = BTreeMap::new();
    for p in lists.into_iter().flatten() {
        found.insert(p.serial.clone().unwrap_or_else(|| p.host.clone()), p);
    }
    found.into_values().collect()
}

#[async_trait]
impl PrinterConnector for BambuConnector {
    fn manifest(&self) -> PluginManifest {
        manifest("bambu-lan").unwrap_or_else(|| super::prusalink::unreachable_manifest("bambu-lan"))
    }

    /// Sends one SSDP search out of every local interface and listens for the answers and for the
    /// NOTIFY announcements printers broadcast every five seconds on UDP 2021 and 1990. The search
    /// matters: a three second scan catches a five second announcement only some of the time.
    async fn discover(&self, timeout: Duration) -> Vec<DiscoveredPrinter> {
        let bind = self.bind_v4();
        let mut tasks = Vec::new();
        let interfaces = if bind.is_unspecified() {
            netif::lan_v4()
        } else {
            Vec::new()
        };
        // Announcements, on ports shared with Bambu Studio and OrcaSlicer when they run too.
        for &port in &self.ssdp_ports {
            let Ok(sock) = netif::shared_listener(bind, port) else {
                continue;
            };
            for i in &interfaces {
                let _ = sock.join_multicast_v4(SSDP_GROUP, i.ip);
            }
            tasks.push(tokio::spawn(collect(sock, Vec::new(), timeout, None)));
        }
        // The search, from one socket per interface so it leaves on each network.
        let askers: Vec<(Ipv4Addr, Vec<SocketAddr>)> = match &self.search_targets {
            Some(t) => vec![(bind, t.clone())],
            None => interfaces
                .iter()
                .map(|i| {
                    let mut to: Vec<SocketAddr> = vec![(SSDP_GROUP, 1990).into()];
                    for port in SSDP_PORTS {
                        to.push((i.broadcast, port).into());
                    }
                    to.push((Ipv4Addr::BROADCAST, 2021).into());
                    (i.ip, to)
                })
                .collect(),
        };
        for (ip, to) in askers {
            if let Ok(sock) = netif::sender(ip) {
                tasks.push(tokio::spawn(collect(sock, to, timeout, None)));
            }
        }
        let mut lists = Vec::new();
        for t in tasks {
            lists.push(t.await.unwrap_or_default());
        }
        merge_found(lists)
    }

    /// Asks one address directly, for a printer the scan did not hear (another subnet, or a network
    /// that drops broadcasts). The answer names the model and serial number.
    async fn probe(&self, host: &str, timeout: Duration) -> Option<DiscoveredPrinter> {
        let ip: std::net::IpAddr = host.parse().ok()?;
        let std::net::IpAddr::V4(v4) = ip else {
            return None;
        };
        let bind = if v4.is_loopback() {
            Ipv4Addr::LOCALHOST
        } else {
            Ipv4Addr::UNSPECIFIED
        };
        let sock = netif::sender(bind).ok()?;
        // The ports the printer answers on; a test's mock answers on the port of its search target.
        let ports: Vec<u16> = match &self.search_targets {
            Some(t) => t.iter().map(SocketAddr::port).collect(),
            None => SSDP_PORTS.to_vec(),
        };
        let to = ports.into_iter().map(|p| SocketAddr::from((v4, p))).collect();
        let mut found = collect(sock, to, timeout, Some(ip)).await;
        found.retain(|p| p.host == host);
        if let Some(p) = found.into_iter().next() {
            return Some(p);
        }
        // No SSDP answer (a network that drops it): the MQTT port's certificate names the serial number.
        let port = self.mqtt_port.unwrap_or(8883);
        let serial = serial_from_certificate(host, port, timeout).await?;
        Some(DiscoveredPrinter {
            plugin: "bambu-lan".to_owned(),
            host: host.to_owned(),
            port: Some(port),
            name: None,
            model: None,
            serial: Some(serial),
            firmware: None,
            lan_only: None,
            ..DiscoveredPrinter::default()
        })
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        // Without a serial (SSDP blocked, an address typed in), the MQTT port's certificate names it.
        let serial = match cfg.serial.clone() {
            Some(s) => s,
            None => serial_from_certificate(&cfg.host, cfg.port.unwrap_or(8883), Duration::from_secs(4))
                .await
                .ok_or_else(|| {
                    Error::Config(
                        "the printer did not name its serial number; enter it from the printer's screen"
                            .to_owned(),
                    )
                })?,
        };
        let code = cfg
            .credential_ref
            .as_deref()
            .and_then(|r| secrets.get(r))
            .ok_or_else(|| Error::Auth {
                printer: cfg.id.clone(),
            })?;
        BambuSession::open(cfg.clone(), serial, code, self.gate.clone()).await
    }
}

/// The serial number a printer's MQTT certificate names (its subject common name), when it reads as
/// one. Only an IP address can be asked.
async fn serial_from_certificate(host: &str, port: u16, timeout: Duration) -> Option<String> {
    let serial = crate::tls::peer_common_name(host, port, timeout).await?;
    (serial.chars().all(|c| c.is_ascii_alphanumeric()) && (8..=24).contains(&serial.len())).then_some(serial)
}

/// Parses one SSDP datagram from a Bambu printer: a NOTIFY announcement or the `200 OK` answer to a
/// search. Returns `None` for anything else.
pub fn parse_ssdp(text: &str) -> Option<DiscoveredPrinter> {
    let mut lines = text.lines();
    let first = lines.next()?;
    let answer = first.starts_with("HTTP/1.1 200");
    if !first.starts_with("NOTIFY") && !answer {
        return None;
    }
    let mut h: BTreeMap<String, String> = BTreeMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            h.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
        }
    }
    if !h.get(if answer { "st" } else { "nt" })?.contains("bambulab") {
        return None;
    }
    let host = h.get("location")?.clone();
    if host.parse::<std::net::IpAddr>().is_err() {
        return None;
    }
    let model = h
        .get("devmodel.bambu.com")
        .map(|c| model_name(c).unwrap_or_else(|| c.clone()));
    let text = |k: &str| h.get(k).filter(|v| !v.is_empty()).cloned();
    Some(DiscoveredPrinter {
        plugin: "bambu-lan".to_owned(),
        host,
        port: Some(8883),
        name: text("devname.bambu.com"),
        model,
        serial: text("usn"),
        firmware: text("devversion.bambu.com"),
        // `lan` while LAN Only Mode is on, `cloud` while the printer uses Bambu Cloud.
        lan_only: h
            .get("devconnect.bambu.com")
            .map(|c| c.eq_ignore_ascii_case("lan")),
        // `occupied` while bound to a Bambu account, `free` otherwise. `Devseclink`, `DevInf` and
        // `DevCap` are left out: no source says what their values mean.
        bound: h
            .get("devbind.bambu.com")
            .map(|b| b.eq_ignore_ascii_case("occupied")),
        ..DiscoveredPrinter::default()
    })
}

/// Model codes, as the `model_id` of each machine model in OrcaSlicer's BBL profiles names them (the
/// same codes the printer announces in SSDP `DevModel` and reports as `project_name`), from
/// `catalog/bambu-model-codes.json`, which the printer catalog's tests also read. Unknown codes pass
/// through.
fn model_name(code: &str) -> Option<String> {
    static CODES: std::sync::LazyLock<BTreeMap<String, String>> = std::sync::LazyLock::new(|| {
        serde_json::from_str::<Value>(include_str!("../../../catalog/bambu-model-codes.json"))
            .ok()
            .and_then(|v| serde_json::from_value(v.get("codes")?.clone()).ok())
            .unwrap_or_default()
    });
    CODES.get(code.trim()).cloned()
}

/// The model a report's `printer_type` names, when it is a code SlicerX knows. Old X1 firmware
/// sends `3DPrinter-X1` and `3DPrinter-X1-Carbon`, which Bambu Studio's `_parse_printer_type`
/// reads as BL-P002 and BL-P001.
pub(crate) fn model_from_report(p: &Value) -> Option<String> {
    let code = p.get("printer_type").and_then(Value::as_str)?.trim();
    let code = match code {
        "3DPrinter-X1" => "BL-P002",
        "3DPrinter-X1-Carbon" => "BL-P001",
        c => c,
    };
    model_name(code)
}

/// The printer's model from its `get_version` answer (`info.module`): a module's `project_name`
/// code ("N2S" on an A1, "N1" on an A1 mini), else a `product_name` such as "Bambu Lab A1 mini".
pub(crate) fn model_from_version(info: &Value) -> Option<String> {
    let modules = info.get("module").and_then(Value::as_array)?;
    let text = |m: &Value, k: &str| {
        m.get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    modules
        .iter()
        .find_map(|m| text(m, "project_name").and_then(|c| model_name(&c)))
        .or_else(|| {
            modules.iter().find_map(|m| {
                text(m, "product_name").map(|p| p.strip_prefix("Bambu Lab ").map_or(p.clone(), str::to_owned))
            })
        })
}

/// The firmware version from a `get_version` answer: the `ota` module's `sw_ver`, as Bambu Studio
/// shows it (DeviceManager `get_ota_version`).
pub(crate) fn firmware_from_version(info: &Value) -> Option<String> {
    info.get("module")
        .and_then(Value::as_array)?
        .iter()
        .find(|m| m.get("name").and_then(Value::as_str) == Some("ota"))
        .and_then(|m| m.get("sw_ver"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// A nozzle's material and whether it is a high flow one. X1, P1 and A1 printers send names
/// (`hardened_steel`); H2 printers send codes such as `HS01`, whose second letter is the flow (H and
/// E high flow) and last two digits the material (00 stainless steel, 01 hardened steel, 05 tungsten
/// carbide), as Bambu Studio's DevNozzleSystem reads them.
fn nozzle_kind(code: &str) -> (Option<&'static str>, Option<bool>) {
    let named = match code {
        "hardened_steel" => Some("hardened-steel"),
        "stainless_steel" => Some("stainless-steel"),
        "tungsten_carbide" => Some("tungsten-carbide"),
        "brass" => Some("brass"),
        _ => None,
    };
    if named.is_some() {
        return (named, None);
    }
    let (Some(flow), Some(material)) = (code.get(1..2), code.get(2..4)) else {
        return (None, None);
    };
    let material = match material {
        "00" => Some("stainless-steel"),
        "01" => Some("hardened-steel"),
        "05" => Some("tungsten-carbide"),
        _ => None,
    };
    let high = match flow {
        "H" | "E" | "U" => Some(true),
        "S" | "A" | "X" => Some(false),
        _ => None,
    };
    (material, high)
}

fn round_mm(d: f64) -> Option<f64> {
    (d > 0.0).then(|| (d * 100.0).round() / 100.0)
}

/// The nozzles in a report. H2 printers list theirs under `device.nozzle.info`, numbered as the
/// printer numbers them (0 the right nozzle, 1 the left); they come back left first, the order Bambu
/// Studio gives the two extruders. Others send one `nozzle_diameter` and `nozzle_type`.
fn extruders_from(p: &Value, nozzle: Option<&Value>) -> Vec<crate::types::ExtruderInfo> {
    let infos: Vec<&Value> = nozzle
        .or_else(|| p.get("device").and_then(|d| d.get("nozzle")))
        .and_then(|n| n.get("info"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        // Bits 4 to 7 of the id mark a nozzle parked in a rack (H2C), not one on the toolhead.
        .filter(|i| {
            i.get("id")
                .and_then(Value::as_u64)
                .is_some_and(|id| id & 0xf0 == 0)
        })
        .collect();
    if !infos.is_empty() {
        let two = infos.len() > 1;
        let mut out: Vec<(u64, crate::types::ExtruderInfo)> = infos
            .iter()
            .map(|i| {
                let id = i.get("id").and_then(Value::as_u64).unwrap_or(0) & 0xf;
                let (kind, high) = nozzle_kind(i.get("type").and_then(Value::as_str).unwrap_or(""));
                let position = two.then(|| if id == 0 { "right" } else { "left" }.to_owned());
                (
                    id,
                    crate::types::ExtruderInfo {
                        tool: 0,
                        position,
                        nozzle_diameter_mm: i.get("diameter").and_then(Value::as_f64).and_then(round_mm),
                        nozzle_type: kind.map(str::to_owned),
                        high_flow: high,
                    },
                )
            })
            .collect();
        // Left (1) first, then right (0).
        out.sort_by_key(|(id, _)| std::cmp::Reverse(*id));
        return out
            .into_iter()
            .enumerate()
            .map(|(n, (_, mut e))| {
                e.tool = u8::try_from(n).unwrap_or(u8::MAX);
                e
            })
            .collect();
    }
    let diameter = p.get("nozzle_diameter").and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
    });
    let (kind, high) = nozzle_kind(p.get("nozzle_type").and_then(Value::as_str).unwrap_or(""));
    if diameter.is_none() && kind.is_none() {
        return Vec::new();
    }
    vec![crate::types::ExtruderInfo {
        tool: 0,
        position: None,
        nozzle_diameter_mm: diameter.and_then(round_mm),
        nozzle_type: kind.map(str::to_owned),
        high_flow: high,
    }]
}

/// The filament units in a report, with their slots as `parse_slots` names them. The unit type and
/// the nozzle it feeds are bits of the hex `info` string on newer firmware (bits 0 to 3 the type: 1
/// AMS, 2 AMS lite, 3 AMS 2 Pro, 4 AMS HT; bits 8 to 11 the nozzle, as in Bambu Studio's
/// DevFilaSystem). Older firmware sends no `info`: units 128 and up are AMS HT, the rest AMS, or AMS
/// lite on the A1 and A1 mini.
fn units_from(
    p: &Value,
    model: Option<&str>,
    extruders: &[crate::types::ExtruderInfo],
) -> Vec<crate::types::FilamentUnit> {
    let lite = model.is_some_and(|m| m.starts_with("A1"));
    // The printer's nozzle number as a tool number (left first on two nozzle printers).
    let tool_of = |id: u64| -> Option<u8> {
        if extruders.len() < 2 {
            return None;
        }
        extruders
            .iter()
            .find(|e| e.position.as_deref() == Some(if id == 0 { "right" } else { "left" }))
            .map(|e| e.tool)
    };
    let slots = parse_slots(p);
    let measured = remain_measured(p);
    let mut out = Vec::new();
    for unit in p
        .get("ams")
        .and_then(|a| a.get("ams"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = unit
            .get("id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<u8>().ok())
            .unwrap_or(0);
        let letter = unit_letter(id);
        let info = unit
            .get("info")
            .and_then(Value::as_str)
            .and_then(|s| u64::from_str_radix(s, 16).ok());
        let kind = match info.map(|i| i & 0xf) {
            Some(1) => "ams",
            Some(2 | 5) => "ams-lite",
            Some(3) => "ams-2-pro",
            Some(4) => "ams-ht",
            _ if id >= 128 => "ams-ht",
            _ if lite => "ams-lite",
            _ => "ams",
        };
        let tool = info
            .map(|i| (i >> 8) & 0xf)
            .filter(|t| *t < 0xe)
            .and_then(tool_of);
        let prefix = letter.to_string();
        out.push(crate::types::FilamentUnit {
            id: prefix.clone(),
            kind: kind.to_owned(),
            tool,
            slots: slots
                .iter()
                .filter(|s| s.id.starts_with(&prefix) && s.id.len() > 1)
                .cloned()
                .collect(),
        });
    }
    // External spools: `vir_slot` on H2 printers (255 the right nozzle's, 254 the left's), else `vt_tray`.
    let virt: Vec<&Value> = p
        .get("vir_slot")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    if virt.is_empty() {
        if let Some(t) = p.get("vt_tray") {
            out.push(external_unit("external".to_owned(), t, None, measured));
        }
    } else {
        for t in virt {
            let id = t.get("id").and_then(Value::as_str).unwrap_or("");
            let tool = match id {
                "255" => tool_of(0),
                "254" => tool_of(1),
                _ => None,
            };
            out.push(external_unit(format!("external-{id}"), t, tool, measured));
        }
    }
    out
}

fn external_unit(id: String, tray: &Value, tool: Option<u8>, measured: bool) -> crate::types::FilamentUnit {
    let loaded = tray
        .get("tray_type")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    let mut slot = tray_slot("1".to_owned(), tray, measured);
    if !loaded {
        slot.material = None;
    }
    crate::types::FilamentUnit {
        id,
        kind: "external".to_owned(),
        tool,
        slots: vec![slot],
    }
}

/// What a `push_status` report (`{"print": {...}}`) says about the printer's hardware, without the
/// model and firmware, which come from `get_version`.
pub fn hardware_from_report(report: &Value) -> crate::types::PrinterHardware {
    let p = report.get("print").unwrap_or(report);
    hardware_from(p, None, None, None)
}

/// The status a `push_status` report (`{"print": {...}}`) reads as, for printer `id`.
pub fn status_from_report(id: &str, report: &Value) -> PrinterStatus {
    parse_status(id, report.get("print").unwrap_or(report))
}

/// Whether Developer Mode is on, from the report's `fun` flags (a hex text): bit 0x20000000 is set
/// while the printer wants signed commands, as ha-bambulab reads it. None when the report has no flags.
fn developer_mode(p: &Value) -> Option<bool> {
    let fun = p.get("fun").and_then(Value::as_str)?;
    let bits = u64::from_str_radix(fun.trim(), 16).ok()?;
    Some(bits & 0x2000_0000 == 0)
}

/// Bits `start` to `start + count - 1` of a flag text in hex, bit 0 its last digit's lowest, as Bambu
/// Studio reads `fun2` and `aux` (`get_flag_bits_no_border`).
fn hex_bits(text: &str, start: u32, count: u32) -> Option<u64> {
    let hex: String = text
        .trim()
        .trim_start_matches("0x")
        .chars()
        .filter(char::is_ascii_hexdigit)
        .collect();
    let digits = usize::try_from(start / 4 + count.div_ceil(4) + 1).ok()?;
    let tail = hex.get(hex.len().saturating_sub(digits)..)?;
    let v = u64::from_str_radix(if tail.is_empty() { "0" } else { tail }, 16).ok()?;
    Some((v >> start) & ((1 << count) - 1))
}

/// The SD card as a report gives it, read the way Bambu Studio's DevStorage does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SdCard {
    Missing,
    Normal,
    Abnormal,
    ReadOnly,
}

/// The SD card from a report: `aux` bits 12 and 13 on firmware that sends `aux`, else the `sdcard`
/// flag refined by `home_flag` bits 8 and 9 (0 none, 1 normal, 2 abnormal, 3 read only). `None` when
/// the report says nothing about it.
pub(crate) fn sd_card(p: &Value) -> Option<SdCard> {
    let of = |bits: u64| match bits {
        1 => SdCard::Normal,
        2 => SdCard::Abnormal,
        3 => SdCard::ReadOnly,
        _ => SdCard::Missing,
    };
    if let Some(aux) = p
        .get("aux")
        .and_then(Value::as_str)
        .filter(|a| !a.trim().is_empty())
    {
        return hex_bits(aux, 12, 2).map(of);
    }
    let home = p
        .get("home_flag")
        .and_then(Value::as_u64)
        .map(|f| of((f >> 8) & 3));
    match p.get("sdcard").and_then(Value::as_bool) {
        Some(false) => Some(SdCard::Missing),
        // A card the flags call faulty or read only is still in the slot.
        Some(true) => Some(
            home.filter(|h| matches!(h, SdCard::Abnormal | SdCard::ReadOnly))
                .unwrap_or(SdCard::Normal),
        ),
        None => home,
    }
}

/// Why a file cannot go to the printer now, from its storage: a printer in LAN mode keeps a sent
/// file on the SD card, unless it says it prints from internal storage (`fun2` bit 0). Bambu Studio
/// stops a LAN send the same way (SelectMachine, `PrintStatusLanModeNoSdcard`).
pub(crate) fn storage_problem(p: &Value) -> Option<&'static str> {
    let internal = p
        .get("fun2")
        .and_then(Value::as_str)
        .and_then(|f| hex_bits(f, 0, 1))
        == Some(1);
    match sd_card(p)? {
        SdCard::Missing if !internal => {
            Some("there is no SD card in the printer. Insert a micro SD card to print over the network")
        }
        SdCard::Abnormal => {
            Some("the printer cannot read its SD card. Check the card or format it on the printer")
        }
        SdCard::ReadOnly => Some("the printer's SD card is read only"),
        _ => None,
    }
}

/// What a report and a `get_version` answer say about the printer's hardware.
pub(crate) fn hardware_from(
    p: &Value,
    nozzle: Option<&Value>,
    model: Option<String>,
    firmware: Option<String>,
) -> crate::types::PrinterHardware {
    let extruders = extruders_from(p, nozzle);
    let filament_units = units_from(p, model.as_deref(), &extruders);
    crate::types::PrinterHardware {
        model,
        firmware,
        extruders,
        filament_units,
        developer_mode: developer_mode(p),
        sd_card: sd_card(p).map(|c| c != SdCard::Missing),
        ..crate::types::PrinterHardware::default()
    }
}

struct Shared {
    cfg: PrinterConfig,
    /// The merged `print` object from `push_status` reports.
    state: Mutex<Value>,
    connected: AtomicBool,
    events: broadcast::Sender<PrinterEvent>,
    have_state: watch::Sender<bool>,
    last: Mutex<Option<PrinterStatus>>,
    /// Prints seen ending while connected, newest first. The LAN protocol keeps no history of its
    /// own; the last job stays in the report until the next starts.
    history: Mutex<Vec<crate::types::PrintRecord>>,
    /// The printer's answers to commands (`print` objects other than `push_status`), newest last.
    replies: Mutex<std::collections::VecDeque<Value>>,
    /// The model the printer named in its `get_version` answer.
    model: Mutex<Option<String>>,
    /// The firmware version from the same answer (the `ota` module).
    firmware: Mutex<Option<String>>,
    /// The last `device.nozzle` object (H2 printers). Kept apart because later reports send `device`
    /// without it.
    nozzle: Mutex<Option<Value>>,
}

/// Command answers kept for a start to find its own.
const REPLIES_MAX: usize = 32;

/// Prints kept in a session's history.
const HISTORY_MAX: usize = 50;

/// The last job in a report as a history record, when it ended.
pub(crate) fn last_job_record(p: &Value, now_s: f64) -> Option<crate::types::PrintRecord> {
    let state = p.get("gcode_state").and_then(Value::as_str)?;
    let name = p
        .get("subtask_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            p.get("gcode_file")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })?;
    let err = p.get("print_error").and_then(Value::as_u64).unwrap_or(0);
    let (outcome, detail) = match state {
        "FINISH" => ("completed", None),
        // Bambu Studio's catalog: 0300_400C "task was canceled", 0500_400E "printing was cancelled".
        "FAILED" if err == 0x0300_400C || err == 0x0500_400E => ("canceled", None),
        "FAILED" => (
            "failed",
            (err != 0).then(|| {
                hms::describe_print_error(half(err >> 16), half(err))
                    .unwrap_or_else(|| format!("error {}", wiki_code(err >> 16, err & 0xffff)))
            }),
        ),
        _ => return None,
    };
    // `gcode_start_time` is seconds since the epoch, sent as a string.
    let started_at = p
        .get("gcode_start_time")
        .and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| v.as_f64())
        })
        .filter(|t| *t > 0.0);
    Some(crate::types::PrintRecord {
        name: name.to_owned(),
        outcome: outcome.to_owned(),
        detail,
        started_at,
        duration_s: started_at.map(|t| (now_s - t).max(0.0)),
        filament_mm: None,
    })
}

/// An MQTT client id no other connection shares. The broker closes a connection when another one signs
/// in with its id (MQTT 3.1.1, 3.1.4-2), and both keep reconnecting with the same id, so two sessions
/// with one id knock each other offline every few seconds. 23 characters, the length every broker takes.
fn client_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    format!(
        "sx-{:04x}{:012x}{:04x}",
        std::process::id() & 0xffff,
        nanos & 0xffff_ffff_ffff,
        n & 0xffff
    )
}

/// Merges a report into the state the way Bambu Studio restores one (`json_diff::diff2all`): objects
/// key by key at every depth, anything else replaced. Reports that carry only what changed leave out
/// keys inside objects too (`ipcam` with `ipcam_record` alone), and those keep their last value.
fn merge_report(into: &mut serde_json::Map<String, Value>, from: &serde_json::Map<String, Value>) {
    for (k, v) in from {
        match (into.get_mut(k), v) {
            (Some(Value::Object(old)), Value::Object(new)) => merge_report(old, new),
            _ => {
                into.insert(k.clone(), v.clone());
            }
        }
    }
}

fn now_s() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

impl Shared {
    fn snapshot(&self) -> PrinterStatus {
        if !self.connected.load(Ordering::Relaxed) {
            return PrinterStatus::offline(&self.cfg.id);
        }
        let v = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        parse_status(&self.cfg.id, &v)
    }

    /// Merges one report and broadcasts what changed.
    fn new(
        cfg: PrinterConfig,
        events: broadcast::Sender<PrinterEvent>,
        have_state: watch::Sender<bool>,
    ) -> Self {
        Shared {
            cfg,
            state: Mutex::new(json!({})),
            connected: AtomicBool::new(false),
            events,
            have_state,
            last: Mutex::new(None),
            history: Mutex::new(Vec::new()),
            replies: Mutex::new(std::collections::VecDeque::new()),
            model: Mutex::new(None),
            firmware: Mutex::new(None),
            nozzle: Mutex::new(None),
        }
    }

    fn ingest(&self, payload: &[u8]) {
        let Ok(v) = serde_json::from_slice::<Value>(payload) else {
            return;
        };
        if let Some(info) = v
            .get("info")
            .filter(|i| i.get("command").and_then(Value::as_str) == Some("get_version"))
        {
            if let Some(m) = model_from_version(info) {
                *self.model.lock().unwrap_or_else(PoisonError::into_inner) = Some(m);
            }
            if let Some(f) = firmware_from_version(info) {
                *self.firmware.lock().unwrap_or_else(PoisonError::into_inner) = Some(f);
            }
            return;
        }
        let Some(print) = v.get("print").and_then(Value::as_object) else {
            return;
        };
        if print.get("command").and_then(Value::as_str) == Some("push_status") {
            crate::trace(
                &self.cfg.id,
                format_args!(
                    "report msg {} keys {} ipcam {}",
                    print
                        .get("msg")
                        .map_or_else(|| "none".to_owned(), Value::to_string),
                    print.len(),
                    print
                        .get("ipcam")
                        .map_or_else(|| "none".to_owned(), Value::to_string),
                ),
            );
        }
        if print.get("command").and_then(Value::as_str) != Some("push_status") {
            if print.contains_key("sequence_id") {
                let mut r = self.replies.lock().unwrap_or_else(PoisonError::into_inner);
                r.push_back(Value::Object(print.clone()));
                while r.len() > REPLIES_MAX {
                    r.pop_front();
                }
            }
            return;
        }
        if let Some(n) = print
            .get("device")
            .and_then(|d| d.get("nozzle"))
            .filter(|n| n.get("info").is_some_and(Value::is_array))
        {
            *self.nozzle.lock().unwrap_or_else(PoisonError::into_inner) = Some(n.clone());
        }
        {
            let mut st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if !st.is_object() {
                *st = json!({});
            }
            if let Some(obj) = st.as_object_mut() {
                merge_report(obj, print);
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
                    ok: now.state == PrinterState::Finished,
                });
                let rec = {
                    let v = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                    last_job_record(&v, now_s())
                }
                .or_else(|| {
                    // Straight back to idle (a cancel on some firmware): the job name from before.
                    Some(crate::types::PrintRecord {
                        name: prev.job_name.clone()?,
                        outcome: "canceled".to_owned(),
                        detail: None,
                        started_at: None,
                        duration_s: None,
                        filament_mm: None,
                    })
                });
                if let Some(r) = rec {
                    let mut h = self.history.lock().unwrap_or_else(PoisonError::into_inner);
                    h.insert(0, r);
                    h.truncate(HISTORY_MAX);
                }
            }
            if strip(prev) == strip(&now) {
                return;
            }
        }
        let _ = self.events.send(PrinterEvent::Status { status: now.clone() });
        *last = Some(now);
    }
}

/// Maps the merged `print` object to the normalized status.
pub(crate) fn parse_status(id: &str, p: &Value) -> PrinterStatus {
    let state = match p.get("gcode_state").and_then(Value::as_str).unwrap_or("IDLE") {
        "RUNNING" => PrinterState::Printing,
        "PAUSE" => PrinterState::Paused,
        "FINISH" => PrinterState::Finished,
        "FAILED" => PrinterState::Error,
        "PREPARE" | "SLICING" | "INIT" => PrinterState::Preparing,
        _ => PrinterState::Idle,
    };
    let num = |k: &str| p.get(k).and_then(Value::as_f64);
    let uint = |k: &str| p.get(k).and_then(Value::as_u64);
    let active = matches!(
        state,
        PrinterState::Printing | PrinterState::Paused | PrinterState::Preparing | PrinterState::Finished
    );
    let job = p
        .get("subtask_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            p.get("gcode_file")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        });

    let nozzles = parse_nozzles(p);
    let bed = num("bed_temper").map(|c| Temp {
        current: c,
        target: num("bed_target_temper").unwrap_or(0.0),
    });
    let chamber = num("chamber_temper").map(|c| Temp {
        current: c,
        target: 0.0,
    });
    let slots = parse_slots(p);
    let slot_ids: Vec<String> = slots.iter().map(|s| s.id.clone()).collect();

    // Only a current issue is the card's message; one left over from a finished job is history. A
    // failed job also says why when the reason is not an issue (a cancel).
    let message = parse_issues(p)
        .into_iter()
        .find(|i| !i.stale)
        .map(|i| i.text)
        .or_else(|| {
            uint("print_error")
                .filter(|e| *e != 0 && state == PrinterState::Error)
                .map(|e| {
                    let (a, c) = (half(e >> 16), half(e));
                    hms::describe_print_error(a, c).unwrap_or_else(|| {
                        format!("The printer reported error {}.", wiki_code(e >> 16, e & 0xffff))
                    })
                })
        });
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: if active { job.map(str::to_owned) } else { None },
        progress: if active {
            num("mc_percent").map(|v| v / 100.0)
        } else {
            None
        },
        layer: uint("layer_num")
            .and_then(|n| u32::try_from(n).ok())
            .filter(|_| active),
        layer_count: uint("total_layer_num")
            .and_then(|n| u32::try_from(n).ok())
            .filter(|_| active),
        // Community docs list minutes here even though some references say seconds.
        time_left_s: if active {
            uint("mc_remaining_time").map(|m| m * 60)
        } else {
            None
        },
        nozzles,
        bed,
        chamber,
        slots,
        camera_available: p
            .get("ipcam")
            .and_then(|c| c.get("ipcam_dev"))
            .and_then(Value::as_str)
            == Some("1"),
        message,
        updated_at: now_iso(),
        live: parse_live(p, &slot_ids),
    }
}

/// Bambu Studio's speed levels (`spd_lvl`, DevDefs.h): silent, standard, sport and ludicrous.
const SPEED_LEVELS: [u16; 4] = [50, 100, 124, 166];

/// The printer's speed level as a percent, for `print_speed`'s level the other way round.
pub(crate) fn speed_level_percent(level: u64) -> Option<u16> {
    usize::try_from(level)
        .ok()
        .and_then(|l| l.checked_sub(1))
        .and_then(|i| SPEED_LEVELS.get(i).copied())
}

/// A slot id from an AMS id and a slot number as the printer gives them (`snow`, `tray_now`). The
/// external spools (254, 255) read as `1` when the status lists one.
fn slot_id_of(ams: u64, slot: u64, slots: &[String]) -> Option<String> {
    if ams == 254 || ams == 255 {
        return slots.iter().any(|s| s == "1").then(|| "1".to_owned());
    }
    let id = format!("{}{}", unit_letter(u8::try_from(ams).ok()?), slot + 1);
    slots.contains(&id).then_some(id)
}

/// The fans in percent: `fan_gear` packs three 0 to 255 speeds, else each fan is a gear of 0 to 15
/// sent as text, shown in steps of 10 percent (Bambu Studio's DevFan).
fn fans_of(p: &Value) -> Option<Fans> {
    let gear = |k: &str| -> Option<u8> {
        let v = p.get(k)?;
        let g = v
            .as_u64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))?;
        u8::try_from((g.min(15) * 10 / 15) * 10).ok()
    };
    if let Some(packed) = p.get("fan_gear").and_then(Value::as_u64) {
        let pct = |shift: u32| u8::try_from((((packed >> shift) & 0xff) * 100 + 127) / 255).ok();
        Some(Fans {
            part: pct(0),
            aux: pct(8),
            chamber: pct(16),
        })
    } else {
        let f = Fans {
            part: gear("cooling_fan_speed"),
            aux: gear("big_fan1_speed"),
            chamber: gear("big_fan2_speed"),
        };
        (f != Fans::default()).then_some(f)
    }
}

/// Fans, speed level, chamber light, the slot feeding now and which nozzle each unit feeds. The
/// light is `lights_report`'s `chamber_light`. The slot feeding now is the current extruder's
/// `snow` on H2 printers (state bits 4 to 7 pick the extruder), else `ams.tray_now`
/// (DevExtruderSystem).
fn parse_live(p: &Value, slots: &[String]) -> Option<Box<PrinterLive>> {
    let fans = fans_of(p);
    let light = p
        .get("lights_report")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|l| l.get("node").and_then(Value::as_str) == Some("chamber_light"))
        .and_then(|l| l.get("mode").and_then(Value::as_str))
        .map(|m| m != "off");
    let extruder = p.get("device").and_then(|d| d.get("extruder"));
    let infos: Vec<&Value> = extruder
        .and_then(|e| e.get("info"))
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let two = infos.len() > 1;
    let active_slot = if infos.is_empty() {
        p.get("ams")
            .and_then(|a| a.get("tray_now"))
            .and_then(Value::as_str)
            .and_then(|t| t.trim().parse::<u64>().ok())
            .and_then(|n| match n {
                255 => None,
                254 => slot_id_of(255, 0, slots),
                0x80..=0x87 => slot_id_of(n, 0, slots),
                _ => slot_id_of(n >> 2, n & 3, slots),
            })
    } else {
        let current = extruder
            .and_then(|e| e.get("state"))
            .and_then(Value::as_u64)
            .map_or(0, |s| (s >> 4) & 0xf);
        infos
            .iter()
            .find(|i| i.get("id").and_then(Value::as_u64) == Some(current))
            .and_then(|i| i.get("snow").and_then(Value::as_u64))
            .filter(|s| s & 0xff != 0xff)
            .and_then(|s| slot_id_of((s >> 8) & 0xff, s & 0xff, slots))
    };
    // The printer numbers its nozzles 0 right, 1 left; `nozzles` keeps that order.
    let side = |id: u64| if id == 0 { "right" } else { "left" }.to_owned();
    let nozzle_sides = two.then(|| {
        let mut ids: Vec<u64> = infos
            .iter()
            .filter_map(|i| i.get("id").and_then(Value::as_u64))
            .collect();
        ids.sort_unstable();
        ids.into_iter().map(side).collect()
    });
    let units: Vec<LiveUnit> = p
        .get("ams")
        .and_then(|a| a.get("ams"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|unit| {
            let id = unit
                .get("id")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<u8>().ok())
                .unwrap_or(0);
            let info = unit
                .get("info")
                .and_then(Value::as_str)
                .and_then(|s| u64::from_str_radix(s, 16).ok());
            let kind = match info.map(|i| i & 0xf) {
                Some(2 | 5) => "ams-lite",
                Some(3) => "ams-2-pro",
                Some(4) => "ams-ht",
                Some(1) => "ams",
                _ if id >= 128 => "ams-ht",
                _ => "ams",
            };
            let feeds = info.map(|i| (i >> 8) & 0xf).filter(|n| two && *n < 0xe).map(side);
            LiveUnit {
                id: unit_letter(id).to_string(),
                kind: kind.to_owned(),
                feeds,
            }
        })
        .collect();
    let live = PrinterLive {
        fans,
        speed_percent: p
            .get("spd_lvl")
            .and_then(Value::as_u64)
            .and_then(speed_level_percent),
        light,
        active_slot,
        nozzle_sides,
        units: (!units.is_empty()).then_some(units),
        layer_z_mm: None,
        // Status keeps coming with Developer Mode off; commands need Bambu Connect then.
        monitor_only: (developer_mode(p) == Some(false)).then_some(true),
    };
    (live != PrinterLive::default()).then(|| Box::new(live))
}

/// The low 16 bits of a reported number.
fn half(v: u64) -> u16 {
    u16::try_from(v & 0xffff).unwrap_or(0)
}

/// Bambu's wiki spells a code as `0300_0100_0001_0001`: the attribute's two halves, then the code's.
fn wiki_code(hi: u64, lo: u64) -> String {
    format!("{:04X}_{:04X}", hi & 0xffff, lo & 0xffff)
}

/// The `hms` list of a report as issues. Bambu Studio's reading (DevHMS.cpp): the attribute holds
/// module (top byte), module number, part and a reserved byte; the code's top half is the severity.
/// The text names the part and how serious it is and points at the code, since the full message
/// catalog is Bambu's and is served from their cloud.
///
/// The printer keeps an `hms` entry until it is cleared on its screen, so a finished or idle printer
/// can still list one from the last job. Bambu Studio and Orca 2.4.2 never show the `hms` list as the
/// job's error: it lives on the HMS page, and the task panel shows only `print_error`
/// (StatusPanel::update_error_message). Here an `hms` entry is current only while a job runs, is
/// paused or is being prepared, and `print_error` also while the job failed, since it says why.
/// Anything else is marked stale.
pub(crate) fn parse_issues(p: &Value) -> Vec<crate::types::PrinterIssue> {
    let job = p.get("gcode_state").and_then(Value::as_str).unwrap_or("IDLE");
    let running = matches!(job, "RUNNING" | "PAUSE" | "PREPARE" | "SLICING" | "INIT");
    let mut out: Vec<crate::types::PrinterIssue> = p
        .get("hms")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|h| {
            let attr = h.get("attr")?.as_u64()?;
            let code = h.get("code")?.as_u64()?;
            let module = match (attr >> 24) & 0xff {
                0x03 => "motion controller",
                0x05 => "main board",
                0x07 => "AMS",
                0x08 => "toolhead",
                0x0c => "camera",
                _ => "printer",
            };
            let severity = match code >> 16 {
                1 => "fatal",
                2 => "serious",
                3 => "common",
                _ => "info",
            };
            let id = format!("{}_{}", wiki_code(attr >> 16, attr), wiki_code(code >> 16, code));
            let how = match severity {
                "fatal" => "reported a fatal error",
                "serious" => "has a serious problem",
                "common" => "needs attention",
                _ => "has a notice",
            };
            let text = hms::describe_hms(half(attr >> 16), half(attr), half(code >> 16), half(code)).unwrap_or_else(|| {
                let mut t = format!("The {module} {how}. Code {id}: the printer's screen has the steps, and the Bambu Lab wiki explains this code.");
                if let Some(first) = t.get_mut(0..1) {
                    first.make_ascii_uppercase();
                }
                t
            });
            let help_url = Some(hms::wiki_url(&id));
            Some(crate::types::PrinterIssue { code: id, severity: severity.to_owned(), module: module.to_owned(), text, help_url, stale: !running })
        })
        .collect();
    if let Some(e) = p
        .get("print_error")
        .and_then(Value::as_u64)
        .filter(|e| *e != 0 && *e != 0x0300_400C && *e != 0x0500_400E)
    {
        let code = wiki_code(e >> 16, e & 0xffff);
        out.push(crate::types::PrinterIssue {
            text: hms::describe_print_error(half(e >> 16), half(e)).unwrap_or_else(|| format!("The printer reported error {code}. The printer's screen has the steps, and the Bambu Lab wiki explains this code.")),
            help_url: Some(hms::wiki_url(&code)),
            code,
            severity: "serious".to_owned(),
            module: "printer".to_owned(),
            stale: !(running || job == "FAILED"),
        });
    }
    out.sort_by_key(|i| {
        (
            i.stale,
            match i.severity.as_str() {
                "fatal" => 0,
                "serious" => 1,
                "common" => 2,
                _ => 3,
            },
        )
    });
    out
}

fn parse_nozzles(p: &Value) -> Vec<Temp> {
    // H2D reports each nozzle with the current temperature in the low 16 bits and the target
    // in the high 16.
    let infos = p
        .get("device")
        .and_then(|d| d.get("extruder"))
        .and_then(|e| e.get("info"))
        .and_then(Value::as_array);
    let mut list: Vec<(u64, Temp)> = infos
        .into_iter()
        .flatten()
        .filter_map(|i| {
            let t = i.get("temp")?.as_u64()?;
            let idx = i.get("id").and_then(Value::as_u64).unwrap_or(0);
            let half = |v: u64| u16::try_from(v & 0xffff).map_or(0.0, f64::from);
            Some((
                idx,
                Temp {
                    current: half(t),
                    target: half(t >> 16),
                },
            ))
        })
        .collect();
    list.sort_by_key(|(i, _)| *i);
    let mut nozzles: Vec<Temp> = list.into_iter().map(|(_, t)| t).collect();
    if nozzles.is_empty()
        && let Some(c) = p.get("nozzle_temper").and_then(Value::as_f64)
    {
        let target = p
            .get("nozzle_target_temper")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        nozzles.push(Temp { current: c, target });
    }
    nozzles
}

/// The letter of an AMS unit's slots. AMS HT units (id 128 and up) are numbered after the four-slot
/// units, so two of them never share a letter with each other or with a regular AMS.
fn unit_letter(unit_id: u8) -> char {
    char::from(b'A'.saturating_add(if unit_id >= 128 {
        4 + (unit_id - 128).min(20)
    } else {
        unit_id.min(25)
    }))
}

/// Whether the AMS figures in `remain` are readings. Off when the printer's remaining capacity
/// setting is off (`cfg` bit 17 on printers that send `cfg`, else `home_flag` bit 7, as Bambu
/// Studio reads them): the figures are then left over, not measured. A report with neither counts
/// as on, so a partial report keeps the last readings.
fn remain_measured(p: &Value) -> bool {
    if let Some(cfg) = p
        .get("cfg")
        .and_then(Value::as_str)
        .and_then(|s| u64::from_str_radix(s, 16).ok())
    {
        return (cfg >> 17) & 1 == 1;
    }
    match p.get("home_flag").and_then(Value::as_i64) {
        Some(f) if f != 0 => (f >> 7) & 1 == 1,
        _ => true,
    }
}

fn parse_slots(p: &Value) -> Vec<FilamentSlot> {
    let measured = remain_measured(p);
    let mut slots = Vec::new();
    let id_of = |v: &Value| {
        v.get("id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<u8>().ok())
            .unwrap_or(0)
    };
    for unit in p
        .get("ams")
        .and_then(|a| a.get("ams"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let unit_id = id_of(unit);
        let letter = unit_letter(unit_id);
        let trays: Vec<&Value> = unit
            .get("tray")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .collect();
        // The printer leaves an empty slot out of the report. Every slot of a four-slot unit is listed
        // anyway, so the position of a slot in the list stays its position in the unit (filament 3 of
        // the plate is the third slot, not the third loaded one).
        let count = if unit_id >= 128 {
            trays.iter().map(|t| u16::from(id_of(t)) + 1).max().unwrap_or(1)
        } else {
            4
        };
        for n in 0..count {
            match trays.iter().find(|t| u16::from(id_of(t)) == n) {
                Some(t) => slots.push(tray_slot(format!("{letter}{}", n + 1), t, measured)),
                None => slots.push(FilamentSlot {
                    id: format!("{letter}{}", n + 1),
                    ..FilamentSlot::default()
                }),
            }
        }
    }
    // The external spool is `vt_tray`, with or without an AMS (the A1's AMS lite sits beside it). It
    // comes after the AMS slots, so a slot's position in the list stays its position in the AMS.
    if let Some(t) = p.get("vt_tray").filter(|t| {
        t.get("tray_type")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
    }) {
        slots.push(tray_slot("1".to_owned(), t, measured));
    }
    slots
}

fn tray_slot(id: String, tray: &Value, measured: bool) -> FilamentSlot {
    // `tray_sub_brands` is the product line ("PLA Basic"), which names the filament preset better
    // than the bare type; the type stays the fallback.
    let text = |k: &str| {
        tray.get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let material = text("tray_type").map(|t| match text("tray_sub_brands") {
        Some(b) if b.to_ascii_uppercase().contains(&t.to_ascii_uppercase()) => b.to_owned(),
        _ => t.to_owned(),
    });
    let color = tray
        .get("tray_color")
        .and_then(Value::as_str)
        .and_then(|c| c.get(..6))
        .filter(|c| c.chars().all(|ch| ch.is_ascii_hexdigit()))
        .map(|c| format!("#{}", c.to_ascii_lowercase()));
    // -1 means no reading (a spool without a tag), and 0 is what the AMS reports for one too; an
    // empty slot runs out instead. `state` bits 5 to 7 are 0 once the reading is done (Bambu
    // Studio, RemainFetchStatus), else it is still being fetched.
    let fetched = tray
        .get("state")
        .and_then(Value::as_u64)
        .is_none_or(|s| s & 0xe0 == 0);
    let remain = tray
        .get("remain")
        .and_then(Value::as_f64)
        .filter(|r| measured && fetched && *r > 0.0 && *r <= 100.0);
    // A spool without a tag reports zeros.
    let uid = ["tray_uuid", "tag_uid"]
        .into_iter()
        .find_map(|k| text(k).filter(|u| u.chars().any(|c| c != '0')))
        .map(str::to_owned);
    FilamentSlot {
        id,
        color: material.as_ref().and(color),
        remaining_pct: material.as_ref().and(remain),
        spool_uid: material.as_ref().and(uid),
        material,
        spoolman_id: None,
    }
}

pub struct BambuSession {
    cfg: PrinterConfig,
    code: String,
    serial: String,
    gate: Arc<dyn ApprovalGate>,
    client: AsyncClient,
    shared: Arc<Shared>,
    seq: AtomicU64,
    // Ends the connection when the session is dropped.
    _task: AbortOnDrop,
}

impl Drop for BambuSession {
    fn drop(&mut self) {
        crate::trace(&self.cfg.id, "session closed");
    }
}

/// The connection log's line for an MQTT connection: where, the client id, and the access code as a
/// fingerprint, so a camera login can be checked against the same code.
fn trace_open(cfg: &PrinterConfig, port: u16, client: &str, code: &str) {
    crate::trace(
        &cfg.id,
        format_args!(
            "mqtt open {}:{port} as {client}, code {}",
            cfg.host,
            crate::trace::fingerprint(code)
        ),
    );
}

/// The connection's task, aborted when this is dropped.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl BambuSession {
    async fn open(
        cfg: PrinterConfig,
        serial: String,
        code: String,
        gate: Arc<dyn ApprovalGate>,
    ) -> Result<Box<dyn PrinterSession>> {
        let client = client_id();
        let port = cfg.port.unwrap_or(8883);
        trace_open(&cfg, port, &client, &code);
        let mut opts = MqttOptions::new(client, cfg.host.clone(), port);
        opts.set_credentials(USER, code.clone());
        opts.set_keep_alive(Duration::from_secs(20));
        // Connects whatever the certificate; whether Bambu Lab issued it for this serial is recorded.
        opts.set_transport(Transport::tls_with_config(TlsConfiguration::Rustls(
            bambu_client_config(&serial, &cfg.host)?,
        )));
        // Reports carry the full AMS tree, which can pass the 10 KB default.
        opts.set_max_packet_size(512 * 1024, 512 * 1024);
        let (client, mut eventloop) = AsyncClient::new(opts, 32);
        let (events, _) = broadcast::channel(64);
        let (have_state, mut have_rx) = watch::channel(false);
        let shared = Arc::new(Shared::new(cfg.clone(), events, have_state));
        let (first_tx, first_rx) = oneshot::channel::<Result<()>>();
        let report = format!("device/{serial}/report");
        let request = format!("device/{serial}/request");
        let task = {
            let (client, shared, id) = (client.clone(), shared.clone(), cfg.id.clone());
            tokio::spawn(async move {
                let mut first = Some(first_tx);
                loop {
                    match eventloop.poll().await {
                        Ok(Event::Incoming(Packet::ConnAck(_))) => {
                            crate::trace(&id, "mqtt signed in");
                            shared.connected.store(true, Ordering::Relaxed);
                            let _ = client.subscribe(report.clone(), QoS::AtMostOnce).await;
                            let all = json!({ "pushing": { "sequence_id": "0", "command": "pushall", "version": 1, "push_target": 1 } });
                            let _ = client
                                .publish(request.clone(), QoS::AtLeastOnce, false, all.to_string())
                                .await;
                            // The model and firmware: the report itself does not name the model.
                            let version = json!({ "info": { "sequence_id": "0", "command": "get_version" } });
                            let _ = client
                                .publish(request.clone(), QoS::AtLeastOnce, false, version.to_string())
                                .await;
                            if let Some(tx) = first.take() {
                                let _ = tx.send(Ok(()));
                            }
                        }
                        Ok(Event::Incoming(Packet::Publish(p))) => shared.ingest(&p.payload),
                        Ok(_) => {}
                        Err(e) => {
                            crate::trace(&id, format_args!("mqtt dropped: {e:?}"));
                            let was = shared.connected.swap(false, Ordering::Relaxed);
                            let err = match e {
                                ConnectionError::ConnectionRefused(_) => Error::Auth { printer: id.clone() },
                                // A printer that answers but whose secure connection fails is not missing.
                                ConnectionError::Tls(e) => Error::tls(&id, e),
                                ConnectionError::NetworkTimeout | ConnectionError::FlushTimeout => {
                                    Error::timeout(&id, "the connection timed out")
                                }
                                ConnectionError::Io(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                                    Error::timeout(&id, e)
                                }
                                other => Error::unreachable(&id, other),
                            };
                            if let Some(tx) = first.take() {
                                let _ = tx.send(Err(err));
                                return;
                            }
                            if was {
                                shared.publish_changes();
                            }
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        }
                    }
                }
            })
        };
        // Until the session is made, dropping this future (a caller's timeout) ends the connection
        // too, so no connection outlives the call that opened it.
        let task = AbortOnDrop(task);
        let up = tokio::time::timeout(Duration::from_secs(8), first_rx).await;
        match up {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => return Err(e),
            _ => return Err(Error::timeout(&cfg.id, "MQTT connection timed out")),
        }
        // The first full report proves the serial number and access code match this printer.
        let got = tokio::time::timeout(Duration::from_secs(8), have_rx.wait_for(|v| *v)).await;
        if !matches!(got, Ok(Ok(_))) {
            return Err(Error::protocol(
                &cfg.id,
                "no status report after connecting; check the serial number",
            ));
        }
        Ok(Box::new(BambuSession {
            cfg,
            code,
            serial,
            gate,
            client,
            shared,
            seq: AtomicU64::new(1),
            _task: task,
        }))
    }

    fn id(&self) -> &str {
        &self.cfg.id
    }

    fn require_state(&self, action: &str, ok: &[PrinterState]) -> Result<()> {
        let s = self.shared.snapshot().state;
        if s == PrinterState::Offline {
            return Err(Error::unreachable(self.id(), "MQTT connection is down"));
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

    async fn command(&self, body: Value) -> Result<()> {
        let topic = format!("device/{}/request", self.serial);
        self.client
            .publish(topic, QoS::AtLeastOnce, false, body.to_string())
            .await
            .map_err(|e| Error::unreachable(self.id(), e))
    }

    fn ftps(&self) -> FtpsTarget<'_> {
        FtpsTarget {
            printer: self.id(),
            host: &self.cfg.host,
            port: self.cfg.ftp_port.unwrap_or(990),
            user: USER,
            password: &self.code,
        }
    }

    fn print_error(&self) -> u64 {
        let v = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
        v.get("print_error").and_then(Value::as_u64).unwrap_or(0)
    }

    /// Waits for the printer's answer to a `project_file` start: its reply (`result` "success" or
    /// "fail", read the way Bambu Studio reads it in `DeviceManager.cpp`), or the job showing as
    /// prepared or printing, or a new `print_error` with the job failed. A refusal comes back as
    /// [`Error::Refused`] with the printer's reason in plain words, so the person decides what to do
    /// next; nothing is retried or changed here. With no answer at all the start stands as sent and
    /// the status shows what the printer does.
    async fn await_project_start(&self, seq: &str, error_before: u64) -> Result<()> {
        let end = tokio::time::Instant::now() + PROJECT_ANSWER_WAIT;
        loop {
            let reply = {
                let r = self.shared.replies.lock().unwrap_or_else(PoisonError::into_inner);
                r.iter()
                    .rev()
                    .find(|v| {
                        v.get("sequence_id").and_then(Value::as_str) == Some(seq)
                            && v.get("command").and_then(Value::as_str) == Some("project_file")
                    })
                    .cloned()
            };
            if let Some(v) = reply {
                return match project_refusal(&v) {
                    Some(reason) => Err(Error::Refused {
                        printer: self.id().to_owned(),
                        reason: self.with_developer_hint(reason),
                    }),
                    None => Ok(()),
                };
            }
            let (state, error) = {
                let v = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
                (
                    v.get("gcode_state")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    v.get("print_error").and_then(Value::as_u64).unwrap_or(0),
                )
            };
            if matches!(state.as_str(), "PREPARE" | "SLICING" | "RUNNING") {
                return Ok(());
            }
            if state == "FAILED" && error != 0 && error != error_before {
                return Err(Error::Refused {
                    printer: self.id().to_owned(),
                    reason: self.with_developer_hint(print_error_words(error)),
                });
            }
            if tokio::time::Instant::now() >= end {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Whether the printer reports Developer Mode off: it then sends status but refuses commands
    /// from other apps (Bambu Lab's third-party integration page, Authorization Control).
    fn monitor_only(&self) -> bool {
        let state = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
        developer_mode(&state) == Some(false)
    }

    /// Refused before anything goes out while the printer is monitor-only.
    fn require_control(&self) -> Result<()> {
        if !self.monitor_only() {
            return Ok(());
        }
        Err(Error::Refused {
            printer: self.id().to_owned(),
            reason: MONITOR_ONLY.to_owned(),
        })
    }

    /// A refusal's reason, with the likely cause added while the printer reports Developer Mode off.
    fn with_developer_hint(&self, reason: String) -> String {
        let state = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
        refusal_with_hint(reason, &state)
    }

    fn next_seq(&self) -> String {
        self.seq.fetch_add(1, Ordering::Relaxed).to_string()
    }

    /// Where the camera is, from the last report, and the report's RTSP URL when it gives one.
    fn camera_route(&self) -> (CameraRoute, Option<String>) {
        let v = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
        let url = v
            .get("ipcam")
            .and_then(|c| c.get("rtsp_url"))
            .and_then(Value::as_str)
            .filter(|u| u.starts_with("rtsp"))
            .map(str::to_owned);
        (camera_route(&v), url)
    }

    /// Connects to the port 6000 camera and sends the 80 byte authentication packet.
    async fn camera_tls(&self) -> Option<tokio_rustls::client::TlsStream<TcpStream>> {
        let port = self.cfg.camera_port.unwrap_or(6000);
        let tcp = TcpStream::connect((self.cfg.host.as_str(), port)).await.ok()?;
        let name = rustls::pki_types::ServerName::try_from(self.cfg.host.clone()).ok()?;
        let mut tls = tokio_rustls::TlsConnector::from(bambu_lan_config().ok()?)
            .connect(name, tcp)
            .await
            .ok()?;
        let mut auth = Vec::with_capacity(80);
        for w in [0x40_u32, 0x3000, 0, 0] {
            auth.extend_from_slice(&w.to_le_bytes());
        }
        for field in [USER, self.code.as_str()] {
            let mut b = [0_u8; 32];
            for (d, s) in b.iter_mut().zip(field.bytes()) {
                *d = s;
            }
            auth.extend_from_slice(&b);
        }
        tls.write_all(&auth).await.ok()?;
        Some(tls)
    }
}

/// What the HUD says when the camera turns down the access code that MQTT took.
const CAMERA_LOGIN_REFUSED: &str = "The printer refused the camera login. Check the access code.";

/// What the HUD says when an X1 or H2 printer has LAN Only Liveview off.
const LIVEVIEW_OFF: &str = "Turn on LAN Only Liveview on the printer's screen to see its camera.";

/// Where a printer serves its camera on the LAN.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CameraRoute {
    /// The report does not say (older firmware).
    Unknown,
    /// JPEG frames on port 6000 (A1, P1).
    Jpeg,
    /// H.264 over RTSPS on 322 (X1, H2).
    Rtsps,
    Rtsp,
    /// LAN Only Liveview is off.
    Off,
}

/// The camera route from a report, read as Bambu Studio reads it (DeviceManager.cpp, `liveview_local`):
/// `ipcam.liveview.local`, then `ipcam.rtsp_url`, which wins when both are there. `disable` there
/// means LAN Only Liveview is off.
pub(crate) fn camera_route(p: &Value) -> CameraRoute {
    let ipcam = p.get("ipcam");
    let local = ipcam
        .and_then(|c| c.get("liveview"))
        .and_then(|l| l.get("local"))
        .and_then(Value::as_str);
    let mut route = match local {
        Some("disabled") => CameraRoute::Off,
        Some("local") => CameraRoute::Jpeg,
        Some("rtsps") => CameraRoute::Rtsps,
        Some("rtsp") => CameraRoute::Rtsp,
        _ => CameraRoute::Unknown,
    };
    match ipcam.and_then(|c| c.get("rtsp_url")).and_then(Value::as_str) {
        None => {}
        Some("") => route = CameraRoute::Unknown,
        Some("disable") => route = CameraRoute::Off,
        Some(u) if u.starts_with("rtsps") => route = CameraRoute::Rtsps,
        Some(_) => route = CameraRoute::Rtsp,
    }
    route
}

/// One frame of the port 6000 stream: a 16 byte header with the size, then the JPEG.
async fn read_camera_frame<R: AsyncReadExt + Unpin>(tls: &mut R) -> Option<Vec<u8>> {
    let mut head = [0_u8; 16];
    tls.read_exact(&mut head).await.ok()?;
    let size = usize::try_from(u32::from_le_bytes([head[0], head[1], head[2], head[3]])).ok()?;
    if size == 0 || size > 8 * 1024 * 1024 {
        return None;
    }
    let mut jpeg = vec![0_u8; size];
    tls.read_exact(&mut jpeg).await.ok()?;
    (jpeg.starts_with(&[0xff, 0xd8]) && jpeg.ends_with(&[0xff, 0xd9])).then_some(jpeg)
}

/// Builds the `project_file` command for a `.gcode.3mf` uploaded over FTPS.
///
/// Defaults follow what Bambu Studio sends (`SelectMachine.cpp`, `set_print_config`): bed leveling
/// on, flow calibration off (Studio sends the boolean `value == "on"`, so its Auto mode is false),
/// vibration compensation off (Studio passes a literal `false`), first layer inspection on (a literal
/// `true`; printers without the hardware ignore it) and bed type `auto`. Studio turns timelapse on
/// when the printer can record one; a connector cannot know that, so it stays off until asked.
pub(crate) fn project_file_command(
    seq: &str,
    file: &RemoteFile,
    opts: &StartOptions,
    model: Option<&str>,
) -> Value {
    let plate = opts.plate.unwrap_or(1);
    let (mapping, mapping2, use_ams) = ams_mapping(opts);
    let subtask = file.name.trim_end_matches(".gcode.3mf").trim_end_matches(".3mf");
    // `bed_levelling` is spelled this way on the wire.
    let mut v = json!({ "print": {
        "sequence_id": seq,
        "command": "project_file",
        "param": format!("Metadata/plate_{plate}.gcode"),
        "project_id": "0", "profile_id": "0", "task_id": "0", "subtask_id": "0",
        "subtask_name": subtask,
        "file": "",
        "url": project_url(model, &file.path),
        "md5": "",
        "timelapse": opts.timelapse.unwrap_or(false),
        "bed_type": "auto",
        "bed_levelling": opts.bed_leveling.unwrap_or(true),
        "flow_cali": opts.flow_calibration.unwrap_or(false),
        "vibration_cali": opts.vibration_compensation.unwrap_or(false),
        "layer_inspect": opts.first_layer_inspection.unwrap_or(true),
        "ams_mapping": mapping,
        "use_ams": use_ams,
    }});
    if !mapping2.is_empty()
        && let Some(p) = v.get_mut("print").and_then(Value::as_object_mut)
    {
        p.insert("ams_mapping2".to_owned(), Value::Array(mapping2));
    }
    v
}

/// Printers that take a project from `file:///sdcard/`, as ha-bambulab lists them
/// (`LEGACY_SDCARD_PRINTERS`); every other model, and one whose model is not known yet, takes `ftp:///`.
const SDCARD_URL_MODELS: [&str; 7] = ["X1", "X1 Carbon", "X1E", "P1P", "P1S", "A1", "A1 mini"];

/// Where `project_file` tells the printer the uploaded file is.
pub(crate) fn project_url(model: Option<&str>, path: &str) -> String {
    if model.is_some_and(|m| SDCARD_URL_MODELS.contains(&m)) {
        format!("file:///sdcard/{path}")
    } else {
        format!("ftp:///{path}")
    }
}

/// How long a `project_file` start waits for the printer's answer.
const PROJECT_ANSWER_WAIT: Duration = Duration::from_secs(10);

/// How long a slot write waits for the printer's answer.
const SLOT_ANSWER_WAIT: Duration = Duration::from_secs(5);

/// Where a slot id from [`parse_slots`] sits in Bambu Studio's terms: `ams_id`, `slot_id` and
/// `tray_id` of `ams_filament_setting` (DeviceManager.cpp, `command_ams_filament_settings`). A
/// regular AMS is units 0 to 3 (A to D), an AMS HT unit 128 and up (E on); the external spool is
/// `ams_id` 255, slot 0, and Studio sends it with `tray_id` 254.
fn slot_address(id: &str) -> Option<(u16, u16, u16)> {
    if id == "1" {
        return Some((255, 0, 254));
    }
    let mut c = id.chars();
    let letter = c.next().filter(char::is_ascii_uppercase)?;
    let n: u16 = c.as_str().parse().ok().filter(|n| (1..=16).contains(n))?;
    let unit = u16::from(u8::try_from(letter).ok()? - b'A');
    let ams = if unit < 4 { unit } else { 128 + unit - 4 };
    Some((ams, n - 1, n - 1))
}

/// The `ams_filament_setting` request for a slot, laid out as Bambu Studio sends it: the preset id
/// as `tray_info_idx`, an empty `setting_id` (Studio's id for a user preset, which SlicerX does not
/// have), the color as `RRGGBBAA` and the preset's nozzle range.
fn slot_request(seq: &str, s: &SlotSetting) -> Option<Value> {
    let (ams, slot, tray) = slot_address(&s.slot)?;
    Some(json!({ "print": {
        "command": "ams_filament_setting",
        "sequence_id": seq,
        "ams_id": ams,
        "slot_id": slot,
        "tray_id": tray,
        "tray_info_idx": s.filament_id,
        "setting_id": "",
        "tray_color": format!("{}FF", s.color.trim_start_matches('#').to_ascii_uppercase()),
        "nozzle_temp_min": s.nozzle_temp_min,
        "nozzle_temp_max": s.nozzle_temp_max,
        "tray_type": s.material,
    } }))
}

/// A `print_error` in plain words: our own wording for the common codes, else the wiki code.
fn print_error_words(e: u64) -> String {
    let (a, c) = (half(e >> 16), half(e));
    hms::describe_print_error(a, c)
        .unwrap_or_else(|| format!("The printer reported error {}.", wiki_code(e >> 16, e & 0xffff)))
}

/// A refused command's reason, plus what to do when the report `p` says Developer Mode is off: the
/// printer then wants signed commands and refuses ours whatever the job.
fn refusal_with_hint(reason: String, p: &Value) -> String {
    if developer_mode(p) != Some(false) {
        return reason;
    }
    format!("{}. {MONITOR_ONLY}", reason.trim_end_matches('.'))
}

/// Why a printer with Developer Mode off takes no command from SlicerX, and the two ways to print.
const MONITOR_ONLY: &str = "Developer Mode is off on the printer, so it sends status but takes no commands from other apps. Print through Bambu Connect, or turn on Developer Mode in its LAN Only settings to print directly.";

/// The printer's reason when its reply to `project_file` is a refusal, else `None`. `result` is
/// "success" or "fail" in any case; the reason is the reply's `reason` text when that says more than
/// the result, else its `err_code` read like a `print_error`.
pub(crate) fn project_refusal(v: &Value) -> Option<String> {
    let result = v
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let code = v.get("err_code").and_then(Value::as_u64).filter(|c| *c != 0);
    if result != "fail" && result != "failed" && code.is_none() {
        return None;
    }
    let text = v
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|r| {
            !r.is_empty()
                && !["fail", "failed", "success"]
                    .iter()
                    .any(|w| r.eq_ignore_ascii_case(w))
        });
    Some(match (text, code) {
        (Some(t), _) => t.to_owned(),
        (None, Some(c)) => print_error_words(c),
        (None, None) => "the printer gave no reason".to_owned(),
    })
}

/// The external spool's id in `ams_mapping2` on single nozzle printers (the `vt_tray` id).
const EXTERNAL_TRAY: i64 = 254;
/// `ams_mapping2` marks a filament with no slot as 255, 255.
const UNMAPPED: i64 = 255;

/// `ams_mapping`, `ams_mapping2` and `use_ams` as Bambu Studio and Orca 2.4.2 build them
/// (`SelectMachineDialog::get_ams_mapping_result` and the `task_use_ams` choice before the print
/// job): one entry per filament, indexed by the 0 based filament index. In `ams_mapping` an AMS
/// tray is its global index (unit times four plus slot, 0 to 15) and anything else, the external
/// spool included, is -1. `ams_mapping2` names every filament as `{ams_id, slot_id}`: the AMS unit
/// and slot, 254 and 0 for the external spool, 255 and 255 for none. `use_ams` is true when any
/// filament comes from the AMS and false when only the external spool feeds the print.
///
/// Studio sizes the arrays to the project's filament count. The start options carry only the
/// filaments the plate uses, so here the arrays end at the highest mapped filament; every
/// filament the plate prints with is in the map, so none of them reads past the end.
fn ams_mapping(opts: &StartOptions) -> (Vec<i64>, Vec<Value>, bool) {
    let Some(m) = opts.slot_map.as_ref().filter(|m| !m.is_empty()) else {
        return (Vec::new(), Vec::new(), false);
    };
    let max = m.keys().copied().max().unwrap_or(0);
    let mut v0 = Vec::new();
    let mut v1 = Vec::new();
    let mut any_ams = false;
    for i in 0..=max {
        match m.get(&i).and_then(|s| slot_to_tray(s)) {
            Some(EXTERNAL_TRAY) => {
                v0.push(-1);
                v1.push(json!({ "ams_id": EXTERNAL_TRAY, "slot_id": 0 }));
            }
            Some(tray) => {
                any_ams = true;
                v0.push(tray);
                v1.push(json!({ "ams_id": tray / 4, "slot_id": tray % 4 }));
            }
            None => {
                v0.push(-1);
                v1.push(json!({ "ams_id": UNMAPPED, "slot_id": UNMAPPED }));
            }
        }
    }
    (v0, v1, any_ams)
}

/// Filament numbers a start's slot map may use (0 based, as `ams_mapping` counts them).
pub(crate) const MAX_MAPPED_FILAMENTS: u32 = 32;

/// Why a slot map cannot go to the printer as approved, or `None` when every entry maps.
pub(crate) fn slot_map_problem(m: &std::collections::BTreeMap<u32, String>) -> Option<String> {
    if let Some(k) = m.keys().find(|k| **k >= MAX_MAPPED_FILAMENTS) {
        return Some(format!(
            "filament {} in the slot map (at most {MAX_MAPPED_FILAMENTS})",
            u64::from(*k) + 1
        ));
    }
    m.values()
        .find(|s| slot_to_tray(s).is_none())
        .map(|s| format!("slot {s:?} in the slot map (AMS slots are A1 to D4, the external spool is 1)"))
}

/// "A1".."D4" to the global tray index (unit * 4 + slot). "1" (external spool) is 254.
pub(crate) fn slot_to_tray(slot: &str) -> Option<i64> {
    if slot == "1" {
        return Some(EXTERNAL_TRAY);
    }
    let mut chars = slot.chars();
    let first = chars.next()?;
    let unit = i64::from(u32::from(first.to_ascii_uppercase()).checked_sub(u32::from('A'))?);
    let rest = chars.as_str();
    if rest.len() != 1 {
        return None;
    }
    let n: i64 = rest.parse().ok()?;
    if !(1..=4).contains(&n) || !(0..=3).contains(&unit) {
        return None;
    }
    Some(unit * 4 + (n - 1))
}

#[async_trait]
impl PrinterSession for BambuSession {
    fn capabilities(&self) -> Capabilities {
        // Developer Mode off: status, camera and slots to read, and nothing that commands the printer.
        if self.monitor_only() {
            return vec![
                Capability::Status,
                Capability::Events,
                Capability::Camera,
                Capability::FilamentSlots,
            ];
        }
        vec![
            Capability::Status,
            Capability::Events,
            Capability::Upload,
            Capability::Start,
            Capability::Pause,
            Capability::Resume,
            Capability::Cancel,
            Capability::Camera,
            Capability::FilamentSlots,
            Capability::GcodeConsole,
            Capability::ProjectFile,
            Capability::SlotWrite,
        ]
    }

    async fn status(&self) -> Result<PrinterStatus> {
        Ok(self.shared.snapshot())
    }

    async fn hardware(&self) -> Result<Option<crate::types::PrinterHardware>> {
        // The `get_version` answer can come a moment after the first report.
        let end = tokio::time::Instant::now() + Duration::from_secs(3);
        while self.reported_model().is_none() && tokio::time::Instant::now() < end {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let nozzle = self
            .shared
            .nozzle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let firmware = self
            .shared
            .firmware
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        Ok(Some(hardware_from(
            &state,
            nozzle.as_ref(),
            self.reported_model(),
            firmware,
        )))
    }

    /// `print.printer_type` from the reports first, as Bambu Studio names the machine (it alone
    /// separates an X1 from an X1 Carbon), then the `get_version` answer.
    fn reported_model(&self) -> Option<String> {
        let from_report = {
            let v = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
            model_from_report(&v)
        };
        from_report.or_else(|| {
            self.shared
                .model
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        })
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

    async fn upload(&self, file: JobFile, token: &ApprovalToken) -> Result<RemoteFile> {
        self.gate.check(
            token,
            Action::Upload,
            self.id(),
            &params::upload(self.id(), &file.name, &file.sha256),
        )?;
        self.require_control()?;
        if file.kind == JobKind::Bgcode {
            return Err(Error::not_supported("bambu-lan", "Prusa binary G-code"));
        }
        // Said before the upload, which would otherwise time out or fail without a reason.
        let problem = {
            let v = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
            storage_problem(&v)
        };
        if let Some(why) = problem {
            return Err(Error::Refused {
                printer: self.id().to_owned(),
                reason: why.to_owned(),
            });
        }
        ftps::store(&self.ftps(), &file.name, &file.data).await?;
        Ok(RemoteFile {
            printer_id: self.id().to_owned(),
            path: file.name.clone(),
            name: file.name,
            sha256: Some(file.sha256),
        })
    }

    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()> {
        // The card showed every slot as the person approved it: a slot this printer cannot name is
        // refused, never sent as "unmapped", and a far-off filament number never sizes the mapping.
        if let Some(why) = opts.slot_map.as_ref().and_then(slot_map_problem) {
            return Err(Error::not_supported("bambu", &why));
        }
        let is_3mf = std::path::Path::new(&file.name)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("3mf"));
        // `gcode_file` has no mapping field: the printer feeds each filament from the slot its
        // G-code names. A slot map the person approved would be ignored, so the start is refused.
        if !is_3mf && opts.has_slot_map() {
            return Err(Error::not_supported(
                "bambu",
                "a filament slot map with a plain G-code file (Bambu Lab printers follow one only for a .gcode.3mf; start without one)",
            ));
        }
        self.gate.check(
            token,
            Action::Start,
            self.id(),
            &params::start(self.id(), file, &opts),
        )?;
        self.require_control()?;
        self.require_state(
            "start a job",
            &[PrinterState::Idle, PrinterState::Finished, PrinterState::Error],
        )?;
        let seq = self.next_seq();
        let body = if is_3mf {
            project_file_command(&seq, file, &opts, self.reported_model().as_deref())
        } else {
            json!({ "print": { "sequence_id": seq, "command": "gcode_file", "param": format!("/sdcard/{}", file.path) } })
        };
        let error_before = self.print_error();
        self.command(body).await?;
        if is_3mf {
            self.await_project_start(&seq, error_before).await?;
        }
        Ok(())
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Pause, self.id(), &params::printer(self.id()))?;
        self.require_control()?;
        self.require_state("pause", &[PrinterState::Printing])?;
        self.command(json!({ "print": { "sequence_id": self.next_seq(), "command": "pause", "param": "" } }))
            .await
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Resume, self.id(), &params::printer(self.id()))?;
        self.require_control()?;
        self.require_state("resume", &[PrinterState::Paused])?;
        self.command(json!({ "print": { "sequence_id": self.next_seq(), "command": "resume", "param": "" } }))
            .await
    }

    async fn cancel(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Cancel, self.id(), &params::printer(self.id()))?;
        self.require_control()?;
        self.require_state(
            "cancel",
            &[
                PrinterState::Printing,
                PrinterState::Paused,
                PrinterState::Preparing,
            ],
        )?;
        self.command(json!({ "print": { "sequence_id": self.next_seq(), "command": "stop", "param": "" } }))
            .await
    }

    /// Reads one frame from the port 6000 JPEG stream (A1, P1). X1 and H2 printers serve H.264
    /// over RTSPS instead, which has no still to take, and answer `None` here without trying 6000.
    async fn snapshot(&self) -> Result<Option<Image>> {
        if matches!(self.camera_route().0, CameraRoute::Rtsps | CameraRoute::Rtsp) {
            return Ok(None);
        }
        let fut = async {
            let mut tls = self.camera_tls().await?;
            read_camera_frame(&mut tls).await
        };
        match tokio::time::timeout(Duration::from_secs(5), fut).await {
            Ok(Some(data)) => Ok(Some(Image {
                content_type: "image/jpeg".to_owned(),
                data,
            })),
            _ => Ok(None),
        }
    }

    /// A1 and P1 stream JPEG frames on port 6000 for as long as the socket is open. X1 and H2
    /// printers refuse that port and serve H.264 over RTSPS on 322 instead, and only while LAN Only
    /// Liveview is on. The report says which (see [`camera_route`]); a printer whose report does not
    /// is tried on 6000 first and then on 322.
    async fn stream(&self) -> Result<Option<FrameStream>> {
        let (route, url) = self.camera_route();
        crate::trace(self.id(), format_args!("camera route {route:?}"));
        let first = async {
            let mut tls = self.camera_tls().await?;
            let frame = read_camera_frame(&mut tls).await?;
            Some((tls, frame))
        };
        let jpeg = if matches!(route, CameraRoute::Rtsps | CameraRoute::Rtsp) {
            None
        } else {
            let got = tokio::time::timeout(Duration::from_secs(5), first)
                .await
                .ok()
                .flatten();
            crate::trace(
                self.id(),
                if got.is_some() {
                    "camera 6000: streaming JPEG"
                } else {
                    "camera 6000: no frame"
                },
            );
            got
        };
        if let Some((mut tls, frame)) = jpeg {
            return Ok(Some(camera::spawn_stream(move |tx| async move {
                let mut next = Some(frame);
                loop {
                    let Some(data) = next.take() else { return };
                    let f = CameraFrame {
                        kind: FrameKind::Jpeg,
                        key: true,
                        data,
                    };
                    if tx.send(f).await.is_err() {
                        return;
                    }
                    next = read_camera_frame(&mut tls).await;
                }
            })));
        }
        let camera_error = |reason: &str| Error::Camera {
            printer: self.id().to_owned(),
            reason: reason.to_owned(),
        };
        match route {
            CameraRoute::Jpeg => return Ok(None),
            CameraRoute::Off => return Err(camera_error(LIVEVIEW_OFF)),
            _ => {}
        }
        // The report's URL gives the path and port; the address stays the configured one, and a
        // configured RTSP port wins (tests).
        let reported = url.and_then(|u| rtsp::parse_url(&u, None));
        let target = rtsp::Target {
            host: self.cfg.host.clone(),
            port: self
                .cfg
                .rtsp_port
                .or(reported.as_ref().map(|t| t.port))
                .unwrap_or(322),
            path: reported.map_or_else(|| "/streaming/live/1".to_owned(), |t| t.path),
            tls: route != CameraRoute::Rtsp,
            tls12_only: true,
            login: Some((USER.to_owned(), self.code.clone())),
            log_as: self.id().to_owned(),
        };
        match rtsp::open(&target).await {
            Ok(s) => Ok(Some(s)),
            Err(rtsp::Failure::LoginRefused) => Err(camera_error(CAMERA_LOGIN_REFUSED)),
            // The report said the printer streams, so the stream itself failed. Port 322 shut is
            // what LAN Only Liveview off looks like when the report has not caught up yet.
            Err(rtsp::Failure::Unreachable) if route != CameraRoute::Unknown => Err(camera_error(
                "The printer's camera did not answer. Check that LAN Only Liveview is on.",
            )),
            // A dropped connection is worth trying again (the bridge's camera feed does, for a
            // live view): live555 refuses a new session for a while after the last one ended.
            Err(rtsp::Failure::NoAnswer) if route != CameraRoute::Unknown => Err(Error::timeout(
                self.id(),
                "the camera closed the connection before the stream started",
            )),
            Err(_) if route != CameraRoute::Unknown => {
                Err(camera_error("The printer's camera stream did not start."))
            }
            Err(_) => Ok(None),
        }
    }

    async fn adjust(&self, change: &Adjustment, token: &ApprovalToken) -> Result<()> {
        // Bambu Studio's own commands (DeviceManager.cpp, DevFan.cpp): `M106 P<fan> S<0-255>` with
        // fan 1 part, 2 auxiliary, 3 chamber; `M104` and `M140` through `gcode_line`; and the
        // `print_speed` command with level 1 silent (50 %), 2 standard (100 %), 3 sport (124 %) and
        // 4 ludicrous (166 %).
        let body = match *change {
            Adjustment::Speed { percent } => {
                let Some(level) = SPEED_LEVELS.iter().position(|p| *p == percent) else {
                    return Err(Error::not_supported(
                        "bambu",
                        "speed factors other than 50, 100, 124 and 166 percent",
                    ));
                };
                json!({ "print": { "sequence_id": self.next_seq(), "command": "print_speed", "param": (level + 1).to_string() } })
            }
            Adjustment::Fan { fan, percent } => {
                let p = match fan {
                    FanKind::Part => 1,
                    FanKind::Aux => 2,
                    FanKind::Chamber => 3,
                };
                let s = (u32::from(percent.min(100)) * 255 + 50) / 100;
                json!({ "print": { "sequence_id": self.next_seq(), "command": "gcode_line", "param": format!("M106 P{p} S{s}\n") } })
            }
            Adjustment::Nozzle { celsius } => {
                json!({ "print": { "sequence_id": self.next_seq(), "command": "gcode_line", "param": format!("M104 S{celsius}\n") } })
            }
            Adjustment::Bed { celsius } => {
                json!({ "print": { "sequence_id": self.next_seq(), "command": "gcode_line", "param": format!("M140 S{celsius}\n") } })
            }
        };
        self.gate.check(
            token,
            Action::Adjust,
            self.id(),
            &params::adjust(self.id(), change),
        )?;
        self.require_control()?;
        self.command(body).await
    }

    async fn set_light(&self, on: bool, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Adjust, self.id(), &params::light(self.id(), on))?;
        self.require_control()?;
        // Bambu Studio's DevLamp::CtrlSetChamberLight: `ledctrl` for `chamber_light` and
        // `chamber_light2` (the H2 printers' second light), with the same timings.
        for node in ["chamber_light", "chamber_light2"] {
            self.command(json!({ "system": {
                "sequence_id": self.next_seq(),
                "command": "ledctrl",
                "led_node": node,
                "led_mode": if on { "on" } else { "off" },
                "led_on_time": 500,
                "led_off_time": 500,
                "loop_times": 1,
                "interval_time": 1000,
            } }))
            .await?;
        }
        Ok(())
    }

    async fn set_slot(&self, setting: &SlotSetting, token: &ApprovalToken) -> Result<()> {
        let bad = |what: &str| Error::Config(what.to_owned());
        if let Some(p) = setting.problem() {
            return Err(bad(p));
        }
        let now = self.shared.snapshot();
        if now.state == PrinterState::Offline {
            return Err(Error::unreachable(self.id(), "MQTT connection is down"));
        }
        let Some(slot) = now.slots.iter().find(|s| s.id == setting.slot) else {
            return Err(bad("the printer does not report that slot"));
        };
        // Bambu Studio opens a spool with a Bambu Lab RFID tag read only: the tag says what it is.
        if slot.spool_uid.is_some() {
            return Err(Error::Refused {
                printer: self.id().to_owned(),
                reason: format!(
                    "slot {} holds a spool with an RFID tag, which sets its filament itself",
                    setting.slot
                ),
            });
        }
        let seq = self.next_seq();
        let body = slot_request(&seq, setting).ok_or_else(|| bad("the printer does not report that slot"))?;
        self.gate.check(
            token,
            Action::Adjust,
            self.id(),
            &params::slot(self.id(), setting),
        )?;
        self.require_control()?;
        self.command(body).await?;
        // The printer answers on the report topic; a `fail` there is its refusal.
        let end = tokio::time::Instant::now() + SLOT_ANSWER_WAIT;
        while tokio::time::Instant::now() < end {
            let reply = {
                let r = self.shared.replies.lock().unwrap_or_else(PoisonError::into_inner);
                r.iter()
                    .rev()
                    .find(|v| {
                        v.get("sequence_id").and_then(Value::as_str) == Some(seq.as_str())
                            && v.get("command").and_then(Value::as_str) == Some("ams_filament_setting")
                    })
                    .cloned()
            };
            if let Some(v) = reply {
                return match v.get("result").and_then(Value::as_str) {
                    Some(r) if r.eq_ignore_ascii_case("fail") => Err(Error::Refused {
                        printer: self.id().to_owned(),
                        reason: v
                            .get("reason")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .unwrap_or("the printer refused the slot setting")
                            .to_owned(),
                    }),
                    _ => Ok(()),
                };
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok(())
    }

    async fn list_files(&self) -> Result<Vec<crate::types::StoredFile>> {
        // Files sent over the LAN land in the root; prints sent through Bambu's cloud in `cache`.
        let mut out = Vec::new();
        for dir in ["", "cache"] {
            for e in ftps::list(&self.ftps(), dir).await? {
                let printable = std::path::Path::new(&e.name)
                    .extension()
                    .is_some_and(|x| x.eq_ignore_ascii_case("3mf") || x.eq_ignore_ascii_case("gcode"));
                if e.dir || !printable {
                    continue;
                }
                let path = if dir.is_empty() {
                    e.name.clone()
                } else {
                    format!("{dir}/{}", e.name)
                };
                out.push(crate::types::StoredFile {
                    path,
                    name: e.name,
                    size: Some(e.size),
                    modified: e.modified,
                });
            }
        }
        out.sort_by(|a, b| {
            b.modified
                .partial_cmp(&a.modified)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(out)
    }

    /// Size and time from the folder listing, so a file changed on the printer after SlicerX sent it
    /// reads as unverified.
    async fn file_info(&self, path: &str) -> Result<Option<crate::types::FileInfo>> {
        let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
        let found = ftps::list(&self.ftps(), dir)
            .await?
            .into_iter()
            .find(|e| !e.dir && e.name == name);
        match found {
            Some(e) => Ok(Some(crate::types::FileInfo {
                size: e.size,
                modified: e.modified,
            })),
            None => Err(Error::NotFound {
                printer: self.id().to_owned(),
                what: format!("file {path}"),
            }),
        }
    }

    async fn history(&self) -> Result<Vec<crate::types::PrintRecord>> {
        let mut h = self
            .shared
            .history
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let last = {
            let v = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
            last_job_record(&v, now_s())
        };
        // The job the printer still shows, unless the session already recorded it ending.
        if let Some(r) = last
            && !h
                .first()
                .is_some_and(|f| f.name == r.name && f.started_at == r.started_at)
        {
            h.insert(0, r);
        }
        Ok(h)
    }

    /// `home_flag` bits 0 to 2 are X, Y and Z homed (Bambu Studio, DevAxis). The LAN reports no head
    /// position, so the hub only lets Z move up.
    async fn motion(&self) -> Result<crate::types::Motion> {
        let v = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
        let flag = v.get("home_flag").and_then(Value::as_u64).filter(|f| *f != 0);
        Ok(crate::types::Motion {
            homed: flag.map(|f| [f & 1 == 1, f & 2 == 2, f & 4 == 4]),
            ..crate::types::Motion::default()
        })
    }

    fn reports_start_late(&self) -> bool {
        true
    }

    /// `s_obj`: the ids of the objects skipped in the running print.
    async fn reported_skips(&self) -> Vec<String> {
        let v = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
        v.get("s_obj")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_u64)
            .map(|n| n.to_string())
            .collect()
    }

    async fn issues(&self) -> Result<Vec<crate::types::PrinterIssue>> {
        let v = self.shared.state.lock().unwrap_or_else(PoisonError::into_inner);
        Ok(parse_issues(&v))
    }

    async fn skip_object(&self, id: &str, token: &ApprovalToken) -> Result<()> {
        // Bambu Studio's skip dialog sends the objects' identify ids in `obj_list`.
        let Ok(n) = id.parse::<u32>() else {
            return Err(Error::protocol(self.id(), "a Bambu Lab object id is a number"));
        };
        self.gate.check(
            token,
            Action::Gcode,
            self.id(),
            &params::gcode(self.id(), &crate::skip_object_line(id)),
        )?;
        self.require_control()?;
        self.command(json!({ "print": { "sequence_id": self.next_seq(), "command": "skip_objects", "obj_list": [n] } })).await
    }

    async fn send_gcode(&self, line: &str, token: &ApprovalToken) -> Result<()> {
        // One command per call: a card showed this line whole, and nothing may ride behind it.
        crate::gate::one_gcode_line(self.id(), line)?;
        self.gate
            .check(token, Action::Gcode, self.id(), &params::gcode(self.id(), line))?;
        self.require_control()?;
        self.command(json!({ "print": { "sequence_id": self.next_seq(), "command": "gcode_line", "param": format!("{line}\n") } })).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // An H2D sends a full report (`msg` 0) for pushall and otherwise only what changed (`msg` 1),
    // objects part by part. A part must not wipe the rest of its object.
    #[test]
    fn a_partial_h2d_report_keeps_what_it_leaves_out() {
        let full: Value =
            serde_json::from_str(include_str!("../../../fixtures/bambu-h2d-pushall.json")).unwrap();
        let mut st = full["print"].as_object().unwrap().clone();
        let delta = json!({
            "command": "push_status", "msg": 1, "bed_temper": 41,
            "ipcam": { "ipcam_record": "enable" },
            "device": { "extruder": { "info": [{ "id": 0, "temp": 0x00dc_00b4 }] } },
        });
        merge_report(&mut st, delta.as_object().unwrap());
        let v = Value::Object(st);
        let s = parse_status("h2d", &v);
        assert!(s.camera_available, "ipcam_dev survives a part of ipcam");
        assert_eq!(camera_route(&v), CameraRoute::Rtsps);
        assert_eq!(s.bed.map(|b| b.current), Some(41.0));
        // Arrays are replaced whole, as Bambu Studio does; the nozzle list beside them stays.
        assert_eq!(s.nozzles.len(), 1);
        assert_eq!(s.nozzles.first().map(|n| n.target), Some(220.0));
        assert!(v["device"]["nozzle"]["info"].is_array());
        assert_eq!(v["ipcam"]["ipcam_record"], "enable");
    }

    #[test]
    fn camera_route_reads_the_report_as_bambu_studio_does() {
        let r = |ipcam: Value| camera_route(&json!({ "ipcam": ipcam }));
        assert_eq!(r(json!({ "ipcam_dev": "1" })), CameraRoute::Unknown);
        assert_eq!(
            r(json!({ "rtsp_url": "rtsps://192.0.2.52/streaming/live/1" })),
            CameraRoute::Rtsps
        );
        assert_eq!(r(json!({ "rtsp_url": "disable" })), CameraRoute::Off);
        assert_eq!(r(json!({ "rtsp_url": "" })), CameraRoute::Unknown);
        assert_eq!(r(json!({ "liveview": { "local": "local" } })), CameraRoute::Jpeg);
        assert_eq!(
            r(json!({ "liveview": { "local": "disabled" } })),
            CameraRoute::Off
        );
        // The URL wins when both are there.
        assert_eq!(
            r(json!({ "liveview": { "local": "rtsps" }, "rtsp_url": "disable" })),
            CameraRoute::Off
        );
        assert_eq!(camera_route(&json!({})), CameraRoute::Unknown);
    }

    #[test]
    fn mqtt_client_ids_differ_within_one_second() {
        let a = client_id();
        let b = client_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 23);
        assert!(a.starts_with("sx-") && a[3..].chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn ssdp_notify() {
        let msg = "NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nLocation: 192.0.2.12\r\nUSN: 01P00A000000000\r\nDevModel.bambu.com: C12\r\nDevName.bambu.com: Bay 2\r\nDevConnect.bambu.com: lan\r\n\r\n";
        let p = parse_ssdp(msg).unwrap();
        assert_eq!(p.host, "192.0.2.12");
        assert_eq!(p.model.as_deref(), Some("P1S"));
        assert_eq!(p.serial.as_deref(), Some("01P00A000000000"));
        assert!(parse_ssdp("NOTIFY * HTTP/1.1\r\nNT: other\r\nLocation: 192.0.2.1\r\n").is_none());
        assert!(parse_ssdp("M-SEARCH * HTTP/1.1\r\n").is_none());
    }

    // An H2D's answer to a search, as recorded on a home network (serial, name and address changed).
    // It answers on the port it was asked on, 2021 or 1990, by unicast.
    const H2D_ANSWER: &str = "HTTP/1.1 200 OK\r\nServer: UPnP/1.0\r\nDate: Mon, 05 Oct 2026 03:57:31 GMT\r\nLocation: 192.168.68.52\r\nST: urn:bambulab-com:device:3dprinter:1\r\nEXT: \r\nUSN: 0948AA000000001\r\nCache-Control: max-age=1800\r\nDevModel.bambu.com: O1D\r\nDevName.bambu.com: Workshop H2D\r\nDevConnect.bambu.com: lan\r\nDevBind.bambu.com: free\r\nDevseclink.bambu.com: secure\r\nDevInf.bambu.com: wlan0\r\nDevVersion.bambu.com: 01.03.00.00\r\nDevCap.bambu.com: 1\r\n\r\n";

    // The same printer's announcement, broadcast to 255.255.255.255:2021 every five seconds.
    const H2D_NOTIFY: &str = "NOTIFY * HTTP/1.1\r\nHost: 239.255.255.250:1990\r\nServer: UPnP/1.0\r\nLocation: 192.168.68.52\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nNTS: ssdp:alive\r\nUSN: 0948AA000000001\r\nCache-Control: max-age=1800\r\nDevModel.bambu.com: O1D\r\nDevName.bambu.com: Workshop H2D\r\nDevConnect.bambu.com: cloud\r\nDevBind.bambu.com: occupied\r\nDevseclink.bambu.com: secure\r\nDevInf.bambu.com: wlan0\r\nDevVersion.bambu.com: 01.03.00.00\r\nDevCap.bambu.com: 1\r\n\r\n";

    #[test]
    fn ssdp_reads_a_recorded_h2d_answer_and_announcement() {
        let a = parse_ssdp(H2D_ANSWER).unwrap();
        assert_eq!(a.host, "192.168.68.52");
        assert_eq!(a.model.as_deref(), Some("H2D"));
        assert_eq!(a.serial.as_deref(), Some("0948AA000000001"));
        assert_eq!(a.name.as_deref(), Some("Workshop H2D"));
        assert_eq!(a.firmware.as_deref(), Some("01.03.00.00"));
        assert_eq!(a.lan_only, Some(true));
        let n = parse_ssdp(H2D_NOTIFY).unwrap();
        assert_eq!(n.serial, a.serial);
        assert_eq!(n.lan_only, Some(false));
        assert_eq!((a.bound, n.bound), (Some(false), Some(true)));
        // Another device's answer to the same search is not a printer.
        assert!(parse_ssdp("HTTP/1.1 200 OK\r\nST: upnp:rootdevice\r\nLOCATION: http://192.168.68.1:1900/rootDesc.xml\r\n\r\n").is_none());
    }

    #[tokio::test]
    async fn discover_searches_and_hears_the_answer() {
        let printer = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let at = printer.local_addr().unwrap();
        let answer = H2D_ANSWER.replace("192.168.68.52", "127.0.0.1");
        tokio::spawn(async move {
            let mut buf = [0_u8; 1024];
            while let Ok((n, from)) = printer.recv_from(&mut buf).await {
                if std::str::from_utf8(&buf[..n]).unwrap().starts_with("M-SEARCH") {
                    printer.send_to(answer.as_bytes(), from).await.unwrap();
                }
            }
        });
        let c = BambuConnector::new(Arc::new(crate::MemoryGate::new()))
            .with_discovery_bind(std::net::Ipv4Addr::LOCALHOST.into())
            .with_ssdp(Vec::new(), vec![at]);
        let found = c.discover(Duration::from_millis(400)).await;
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].model.as_deref(), Some("H2D"));
        assert_eq!(found[0].serial.as_deref(), Some("0948AA000000001"));
    }

    #[tokio::test]
    async fn probe_asks_one_address() {
        let printer = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let at = printer.local_addr().unwrap();
        let answer = H2D_ANSWER.replace("192.168.68.52", "127.0.0.1");
        tokio::spawn(async move {
            let mut buf = [0_u8; 1024];
            while let Ok((_, from)) = printer.recv_from(&mut buf).await {
                printer.send_to(answer.as_bytes(), from).await.unwrap();
            }
        });
        let c = BambuConnector::new(Arc::new(crate::MemoryGate::new())).with_ssdp(Vec::new(), vec![at]);
        let p = c.probe("127.0.0.1", Duration::from_millis(300)).await.unwrap();
        assert_eq!(p.serial.as_deref(), Some("0948AA000000001"));
        assert!(c.probe("127.0.0.2", Duration::from_millis(100)).await.is_none());
    }

    #[tokio::test]
    async fn ask_one_hears_the_printer_it_asked_from_a_connected_socket() {
        let printer = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let at = printer.local_addr().unwrap();
        let answer = H2D_ANSWER.replace("192.168.68.52", "127.0.0.1");
        tokio::spawn(async move {
            let mut buf = [0_u8; 1024];
            while let Ok((n, from)) = printer.recv_from(&mut buf).await {
                assert!(from.port() != 2021 && from.port() != 1990, "asked from {from}");
                if std::str::from_utf8(&buf[..n]).unwrap().starts_with("M-SEARCH") {
                    printer.send_to(answer.as_bytes(), from).await.unwrap();
                }
            }
        });
        let p = ask_one(Ipv4Addr::LOCALHOST, &[at.port()], Duration::from_millis(600))
            .await
            .unwrap();
        assert_eq!(p.name.as_deref(), Some("Workshop H2D"));
        assert_eq!(p.serial.as_deref(), Some("0948AA000000001"));
        // Nothing answers on another port: no name, and no wait past the timeout.
        let quiet = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = quiet.local_addr().unwrap().port();
        assert!(
            ask_one(Ipv4Addr::LOCALHOST, &[port], Duration::from_millis(200))
                .await
                .is_none()
        );
    }

    #[test]
    fn hardware_from_a_h2d_report() {
        let v: Value =
            serde_json::from_str(include_str!("../../../fixtures/bambu-h2d-pushall.json")).unwrap();
        let p = &v["print"];
        let hw = hardware_from(p, None, Some("H2D".to_owned()), Some("01.03.00.00".to_owned()));
        assert_eq!(hw.model.as_deref(), Some("H2D"));
        assert_eq!(hw.firmware.as_deref(), Some("01.03.00.00"));
        let e: Vec<(u8, &str, f64, &str, bool)> = hw
            .extruders
            .iter()
            .map(|x| {
                (
                    x.tool,
                    x.position.as_deref().unwrap(),
                    x.nozzle_diameter_mm.unwrap(),
                    x.nozzle_type.as_deref().unwrap(),
                    x.high_flow.unwrap(),
                )
            })
            .collect();
        assert_eq!(
            e,
            [
                (0, "left", 0.6, "hardened-steel", true),
                (1, "right", 0.4, "hardened-steel", false)
            ]
        );
        let units: Vec<(&str, &str, Option<u8>, usize)> = hw
            .filament_units
            .iter()
            .map(|u| (u.id.as_str(), u.kind.as_str(), u.tool, u.slots.len()))
            .collect();
        assert_eq!(
            units,
            [
                ("A", "ams-2-pro", Some(1), 4),
                ("E", "ams-ht", Some(0), 1),
                ("external-255", "external", Some(1), 1),
                ("external-254", "external", Some(0), 1),
            ]
        );
        assert_eq!(hw.filament_units[0].slots[2].material.as_deref(), Some("PETG HF"));
        assert_eq!(hw.filament_units[0].slots[3].material, None);
        assert_eq!(hw.filament_units[1].slots[0].material.as_deref(), Some("PAHT-CF"));
        assert_eq!(hw.filament_units[2].slots[0].material, None);
        assert_eq!(
            hw.filament_units[3].slots[0].material.as_deref(),
            Some("TPU for AMS")
        );
    }

    #[test]
    fn developer_mode_and_the_sd_card_come_from_the_report() {
        // Values seen on printers: 3EC1AFFF9CFF wants signed commands, 3EC18FFF9CFF does not.
        let on = hardware_from(
            &json!({ "fun": "3EC18FFF9CFF", "sdcard": true }),
            None,
            None,
            None,
        );
        assert_eq!((on.developer_mode, on.sd_card), (Some(true), Some(true)));
        let off = hardware_from(
            &json!({ "fun": "3EC1AFFF9CFF", "sdcard": false }),
            None,
            None,
            None,
        );
        assert_eq!((off.developer_mode, off.sd_card), (Some(false), Some(false)));
        let none = hardware_from(&json!({}), None, None, None);
        assert_eq!((none.developer_mode, none.sd_card), (None, None));
    }

    #[test]
    fn developer_mode_off_reads_as_monitor_only() {
        let off = status_from_report(
            "p",
            &json!({ "print": { "gcode_state": "IDLE", "fun": "3EC1AFFF9CFF" } }),
        );
        assert_eq!(off.live.and_then(|l| l.monitor_only), Some(true));
        let on = status_from_report(
            "p",
            &json!({ "print": { "gcode_state": "IDLE", "fun": "3EC18FFF9CFF" } }),
        );
        assert_eq!(on.live.and_then(|l| l.monitor_only), None);
        let unsaid = status_from_report("p", &json!({ "print": { "gcode_state": "IDLE" } }));
        assert_eq!(unsaid.live.and_then(|l| l.monitor_only), None);
    }

    #[test]
    fn a_refusal_names_developer_mode_when_it_is_off() {
        use super::refusal_with_hint;
        let off = json!({ "fun": "3EC1AFFF9CFF" });
        assert_eq!(
            refusal_with_hint("verify failed".to_owned(), &off),
            "verify failed. Developer Mode is off on the printer, so it sends status but takes no commands from other apps. Print through Bambu Connect, or turn on Developer Mode in its LAN Only settings to print directly."
        );
        let on = json!({ "fun": "3EC18FFF9CFF" });
        assert_eq!(
            refusal_with_hint("MD5 verify failed".to_owned(), &on),
            "MD5 verify failed"
        );
        assert_eq!(refusal_with_hint("no flags".to_owned(), &json!({})), "no flags");
    }

    #[test]
    fn hardware_from_a_single_nozzle_report() {
        let p = json!({ "nozzle_diameter": "0.2", "nozzle_type": "stainless_steel", "ams": { "ams": [{ "id": "0", "tray": [] }] } });
        let hw = hardware_from(&p, None, Some("A1 mini".to_owned()), None);
        assert_eq!(hw.extruders.len(), 1);
        assert_eq!(hw.extruders[0].nozzle_diameter_mm, Some(0.2));
        assert_eq!(hw.extruders[0].nozzle_type.as_deref(), Some("stainless-steel"));
        assert_eq!(hw.extruders[0].position, None);
        assert_eq!(hw.filament_units[0].kind, "ams-lite");
        assert_eq!(hw.filament_units[0].slots.len(), 4);
    }

    #[test]
    fn hms_codes_read_like_the_wiki_and_sort_by_severity() {
        let p = json!({ "hms": [{ "attr": 0x0700_2000_u64, "code": 0x0003_0001_u64 }, { "attr": 0x0800_0300_u64, "code": 0x0001_0002_u64 }] });
        let issues = parse_issues(&p);
        assert_eq!(issues[0].code, "0800_0300_0001_0002");
        assert_eq!(issues[0].severity, "fatal");
        assert_eq!(issues[0].module, "toolhead");
        assert!(
            issues[0].text.starts_with("The toolhead reported a fatal error."),
            "{}",
            issues[0].text
        );
        assert_eq!(issues[1].module, "AMS");
        // No job runs, so both are left over and the card has no message.
        assert!(issues.iter().all(|i| i.stale));
        assert_eq!(parse_status("p", &p).message, None);
        let mut running = p.clone();
        running["gcode_state"] = json!("RUNNING");
        let issues = parse_issues(&running);
        assert!(issues.iter().all(|i| !i.stale));
        assert_eq!(
            parse_status("p", &running).message.as_deref(),
            Some(issues[0].text.as_str())
        );
        assert!(parse_issues(&json!({})).is_empty());
        assert_eq!(wiki_code(0x0500_400E >> 16, 0x400E), "0500_400E");
    }

    #[test]
    fn a_printing_h2d_reports_fans_speed_light_and_what_feeds_each_nozzle() {
        let report: Value =
            serde_json::from_str(include_str!("../../../fixtures/bambu-h2d-printing.json")).unwrap();
        let st = status_from_report("h2d", &report);
        assert_eq!(st.state, PrinterState::Printing);
        assert_eq!(
            st.nozzles
                .iter()
                .map(|n| (n.current, n.target))
                .collect::<Vec<_>>(),
            [(31.0, 0.0), (220.0, 220.0)]
        );
        assert!(
            st.message
                .as_deref()
                .is_some_and(|m| m.contains("front door is open"))
        );
        let live = st.live.unwrap();
        assert_eq!(
            live.fans,
            Some(Fans {
                part: Some(100),
                aux: Some(70),
                chamber: Some(30)
            })
        );
        assert_eq!((live.speed_percent, live.light), (Some(100), Some(true)));
        // The current extruder is the left one (state bits 4 to 7), which feeds from AMS A slot 1.
        assert_eq!(live.active_slot.as_deref(), Some("A1"));
        assert_eq!(
            live.nozzle_sides,
            Some(vec!["right".to_owned(), "left".to_owned()])
        );
        let units: Vec<(&str, &str, Option<&str>)> = live
            .units
            .as_ref()
            .unwrap()
            .iter()
            .map(|u| (u.id.as_str(), u.kind.as_str(), u.feeds.as_deref()))
            .collect();
        assert_eq!(
            units,
            [("A", "ams", Some("left")), ("E", "ams-ht", Some("right"))]
        );
    }

    #[test]
    fn single_nozzle_printers_name_the_slot_from_tray_now_and_fan_gear() {
        let p = json!({
            "gcode_state": "RUNNING", "spd_lvl": 4, "fan_gear": 0x00_80_ff,
            "ams": { "tray_now": "6", "ams": [
                { "id": "0", "tray": [{ "id": "0", "tray_type": "PLA", "tray_color": "FFFFFFFF" }] },
                { "id": "1", "tray": [{ "id": "2", "tray_type": "PLA", "tray_color": "000000FF" }] },
            ] },
        });
        let live = parse_status("p1s", &p).live.unwrap();
        assert_eq!(live.active_slot.as_deref(), Some("B3"));
        assert_eq!(live.speed_percent, Some(166));
        assert_eq!(
            live.fans,
            Some(Fans {
                part: Some(100),
                aux: Some(50),
                chamber: Some(0)
            })
        );
        assert_eq!((live.nozzle_sides, live.light), (None, None));
        assert!(live.units.unwrap().iter().all(|u| u.feeds.is_none()));
        // Nothing loaded and nothing reported: no live part at all.
        assert_eq!(
            parse_status(
                "a1",
                &json!({ "gcode_state": "IDLE", "ams": { "tray_now": "255" } })
            )
            .live,
            None
        );
    }

    #[test]
    fn a_finished_h2d_with_a_leftover_hms_code_is_finished_not_stopped() {
        let report: Value =
            serde_json::from_str(include_str!("../../../fixtures/bambu-h2d-finished-hms.json")).unwrap();
        let p = &report["print"];
        let st = parse_status("h2d", p);
        assert_eq!(st.state, PrinterState::Finished);
        assert_eq!((st.layer, st.layer_count), (Some(937), Some(937)));
        assert_eq!(st.job_name.as_deref(), Some("Bracket"));
        assert_eq!(
            st.message, None,
            "a code from the last job is not a stopped print"
        );
        let issues = parse_issues(p);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, "0500_0500_0001_0007");
        assert_eq!(issues[0].module, "main board");
        assert!(issues[0].stale);
        assert!(
            !issues[0].text.contains("stopped the print"),
            "{}",
            issues[0].text
        );
        // The same code while the job runs or is paused is current.
        for job in ["RUNNING", "PAUSE"] {
            let mut live = p.clone();
            live["gcode_state"] = json!(job);
            assert!(!parse_issues(&live)[0].stale);
            assert!(
                parse_status("h2d", &live)
                    .message
                    .unwrap()
                    .contains("0500_0500_0001_0007")
            );
        }
        // Idle after the job, it is still history.
        let mut idle = p.clone();
        idle["gcode_state"] = json!("IDLE");
        assert!(parse_issues(&idle)[0].stale);
        assert_eq!(parse_status("h2d", &idle).message, None);
    }

    #[test]
    fn a_print_error_is_current_while_the_job_failed_and_history_after_it_finished() {
        let failed = json!({ "gcode_state": "FAILED", "print_error": 0x0300_4006_u64 });
        assert!(!parse_issues(&failed)[0].stale);
        assert!(parse_status("p", &failed).message.unwrap().contains("clogged"));
        let finished = json!({ "gcode_state": "FINISH", "print_error": 0x0300_4006_u64 });
        assert!(parse_issues(&finished)[0].stale);
        assert_eq!(parse_status("p", &finished).message, None);
        // A cancel is no issue, and the failed job still says it was canceled.
        let canceled = json!({ "gcode_state": "FAILED", "print_error": 0x0300_400C_u64 });
        assert!(parse_issues(&canceled).is_empty());
        assert!(parse_status("p", &canceled).message.is_some());
    }

    #[test]
    fn a_slot_setting_goes_as_bambu_studio_sends_it() {
        use super::{slot_address, slot_request};
        assert_eq!(slot_address("A1"), Some((0, 0, 0)));
        assert_eq!(slot_address("B4"), Some((1, 3, 3)));
        assert_eq!(slot_address("E1"), Some((128, 0, 0)));
        assert_eq!(slot_address("1"), Some((255, 0, 254)));
        assert_eq!(slot_address("A0"), None);
        assert_eq!(slot_address("a1"), None);
        let s = SlotSetting {
            slot: "A2".into(),
            filament_id: "GFA00".into(),
            material: "PLA".into(),
            color: "#1a2b3c".into(),
            nozzle_temp_min: 190,
            nozzle_temp_max: 230,
        };
        assert_eq!(s.problem(), None);
        let v = slot_request("7", &s).unwrap();
        assert_eq!(
            v,
            json!({ "print": { "command": "ams_filament_setting", "sequence_id": "7", "ams_id": 0, "slot_id": 1, "tray_id": 1,
                "tray_info_idx": "GFA00", "setting_id": "", "tray_color": "1A2B3CFF", "nozzle_temp_min": 190, "nozzle_temp_max": 230, "tray_type": "PLA" } })
        );
        assert!(
            SlotSetting {
                color: "red".into(),
                ..s.clone()
            }
            .problem()
            .is_some()
        );
        assert!(
            SlotSetting {
                nozzle_temp_min: 240,
                ..s.clone()
            }
            .problem()
            .is_some()
        );
        assert!(
            SlotSetting {
                filament_id: String::new(),
                ..s
            }
            .problem()
            .is_some()
        );
    }

    #[test]
    fn a_tagged_spool_carries_its_tag_and_an_untagged_one_none() {
        let p = json!({ "ams": { "ams": [{ "id": "0", "tray": [
            { "id": "0", "tray_type": "PLA", "tray_color": "000000FF", "tray_uuid": "A1B2C3D4E5F60718293A4B5C6D7E8F90", "tag_uid": "1122334455667788" },
            { "id": "1", "tray_type": "PETG", "tray_color": "FFFFFFFF", "tray_uuid": "00000000000000000000000000000000", "tag_uid": "0000000000000000" } ] }] } });
        let slots = parse_slots(&p);
        assert_eq!(
            slots[0].spool_uid.as_deref(),
            Some("A1B2C3D4E5F60718293A4B5C6D7E8F90")
        );
        assert_eq!(slots[1].spool_uid, None);
        assert_eq!(slots[2].spool_uid, None);
    }

    #[test]
    fn ams_slots_keep_their_position_and_the_product_line() {
        // The printer leaves empty slots out: tray 1 and 3 are loaded, 0 and 2 are not reported.
        let p = json!({ "ams": { "ams": [
            { "id": "0", "tray": [
                { "id": "1", "tray_type": "PETG", "tray_sub_brands": "PETG HF", "tray_color": "1A2B3CFF", "remain": 40 },
                { "id": "3", "tray_type": "PLA", "tray_sub_brands": "Generic", "tray_color": "FFFFFFFF", "remain": -1 } ] },
            { "id": "128", "tray": [ { "id": "0", "tray_type": "ABS", "tray_color": "000000FF", "remain": 90 } ] } ] } });
        let slots = parse_slots(&p);
        assert_eq!(
            slots.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["A1", "A2", "A3", "A4", "E1"]
        );
        assert_eq!(slots[0].material, None);
        assert_eq!(
            slots[1].material.as_deref(),
            Some("PETG HF"),
            "the product line names the preset"
        );
        assert_eq!(slots[1].remaining_pct, Some(40.0));
        assert_eq!(
            slots[3].material.as_deref(),
            Some("PLA"),
            "a line that does not name the type is not used"
        );
        assert_eq!(slots[3].remaining_pct, None, "-1 means the printer does not know");
        assert_eq!(slots[4].color.as_deref(), Some("#000000"));
    }

    #[test]
    fn a_remaining_amount_counts_only_when_the_ams_measured_it() {
        let trays = json!([
            { "id": "0", "tray_type": "PLA", "remain": 0 },
            { "id": "1", "tray_type": "PLA", "remain": 55, "state": 32 },
            { "id": "2", "tray_type": "PLA", "remain": 70, "state": 3 } ]);
        let pct =
            |p: Value| -> Vec<Option<f64>> { parse_slots(&p).iter().map(|s| s.remaining_pct).collect() };
        let on = json!({ "home_flag": 0x80 | 7, "ams": { "ams": [ { "id": "0", "tray": trays } ] } });
        assert_eq!(
            pct(on)[..3],
            [None, None, Some(70.0)],
            "0 is a spool without a tag, and state bits 5 to 7 mean the reading is still coming"
        );
        let off = json!({ "home_flag": 7, "ams": { "ams": [ { "id": "0", "tray": trays } ] } });
        assert_eq!(
            pct(off)[..3],
            [None, None, None],
            "with remaining capacity off the figures are not readings"
        );
        let h2 = json!({ "cfg": "20000", "ams": { "ams": [ { "id": "0", "tray": trays } ] } });
        assert_eq!(pct(h2)[2], Some(70.0), "cfg bit 17 is the same setting");
        let h2_off = json!({ "cfg": "1", "ams": { "ams": [ { "id": "0", "tray": trays } ] } });
        assert_eq!(pct(h2_off)[2], None);
    }

    #[test]
    fn the_last_job_reads_as_a_history_record() {
        let done = json!({ "gcode_state": "FINISH", "subtask_name": "lid", "gcode_start_time": "1000", "print_error": 0 });
        let r = last_job_record(&done, 4600.0).unwrap();
        assert_eq!(
            (r.name.as_str(), r.outcome.as_str(), r.started_at, r.duration_s),
            ("lid", "completed", Some(1000.0), Some(3600.0))
        );
        let canceled =
            json!({ "gcode_state": "FAILED", "subtask_name": "lid", "print_error": 0x0300_400C_u64 });
        assert_eq!(last_job_record(&canceled, 0.0).unwrap().outcome, "canceled");
        let clog = json!({ "gcode_state": "FAILED", "subtask_name": "lid", "print_error": 0x0300_4006_u64 });
        let r = last_job_record(&clog, 0.0).unwrap();
        assert_eq!(r.outcome, "failed");
        assert!(r.detail.unwrap().contains("clogged"));
        assert!(last_job_record(&json!({ "gcode_state": "RUNNING", "subtask_name": "lid" }), 0.0).is_none());
    }

    #[test]
    fn a_print_error_is_an_issue_in_plain_words_and_a_cancel_is_not() {
        let i = parse_issues(&json!({ "gcode_state": "PAUSE", "print_error": 0x0300_8015_u64 }));
        assert!(!i[0].stale);
        assert_eq!(i[0].code, "0300_8015");
        assert!(i[0].text.starts_with("The external spool ran out"));
        assert!(i[0].help_url.as_deref().unwrap().ends_with("/0300_8015"));
        assert!(parse_issues(&json!({ "print_error": 0x0300_400C_u64 })).is_empty());
        let ams = parse_issues(&json!({ "hms": [{ "attr": 0x0701_2100_u64, "code": 0x0002_0001_u64 }] }));
        assert!(ams[0].text.starts_with("AMS B slot 2 ran out"), "{}", ams[0].text);
    }

    #[test]
    fn the_a1_and_a1_mini_name_themselves_in_get_version() {
        use super::{model_from_version, model_name};
        let a1 = json!({ "command": "get_version", "module": [
            { "name": "ota", "product_name": "Bambu Lab A1", "sw_ver": "01.04.00.00" },
            { "name": "ap", "project_name": "N2S", "hw_ver": "AP05" },
        ]});
        assert_eq!(model_from_version(&a1).as_deref(), Some("A1"));
        let mini = json!({ "module": [{ "name": "ap", "project_name": "N1" }] });
        assert_eq!(model_from_version(&mini).as_deref(), Some("A1 mini"));
        // No code SlicerX knows: the product name without the brand.
        let named = json!({ "module": [{ "name": "ota", "product_name": "Bambu Lab A1 mini" }, { "name": "ap", "project_name": "ZZ9" }] });
        assert_eq!(model_from_version(&named).as_deref(), Some("A1 mini"));
        assert_eq!(model_from_version(&json!({ "module": [] })), None);
        // The codes are the `model_id` values of OrcaSlicer's BBL machine models.
        for (code, name) in [
            ("N2S", "A1"),
            ("N1", "A1 mini"),
            ("C13", "X1E"),
            ("N7", "P2S"),
            ("BL-P001", "X1 Carbon"),
            ("O1D", "H2D"),
            ("O1C2", "H2C"),
            ("O1S", "H2S"),
        ] {
            assert_eq!(model_name(code).as_deref(), Some(name));
        }
        assert_eq!(model_name("ZZ9"), None);
    }

    #[test]
    fn the_external_spool_follows_the_ams_lite() {
        let p = json!({
            "ams": { "ams": [{ "id": "0", "tray": [{ "id": "0", "tray_type": "PLA", "tray_color": "FFFFFFFF" }] }] },
            "vt_tray": { "id": "254", "tray_type": "PETG", "tray_color": "000000FF" },
        });
        let ids: Vec<String> = super::parse_slots(&p).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, ["A1", "A2", "A3", "A4", "1"]);
        // An empty external spool is not offered.
        let p = json!({ "ams": { "ams": [] }, "vt_tray": { "id": "254", "tray_type": "" } });
        assert!(super::parse_slots(&p).is_empty());
    }

    #[test]
    fn a_project_start_reply_reads_as_accepted_or_refused() {
        use super::project_refusal;
        assert_eq!(
            project_refusal(&json!({ "command": "project_file", "result": "SUCCESS", "reason": "success" })),
            None
        );
        assert_eq!(
            project_refusal(&json!({ "command": "project_file", "result": "success" })),
            None
        );
        assert_eq!(
            project_refusal(
                &json!({ "command": "project_file", "result": "FAIL", "reason": "MD5 verify failed" })
            )
            .as_deref(),
            Some("MD5 verify failed")
        );
        // No reason text: the error code in plain words or as its wiki code.
        let r = project_refusal(&json!({ "command": "project_file", "result": "fail", "reason": "fail", "err_code": 0x0300_4006_u64 })).unwrap();
        assert!(r.contains("clogged"), "{r}");
        let r = project_refusal(
            &json!({ "command": "project_file", "result": "fail", "err_code": 0x0500_C011_u64 }),
        )
        .unwrap();
        assert!(r.contains("0500_C011"), "{r}");
        assert_eq!(
            project_refusal(&json!({ "result": "fail" })).as_deref(),
            Some("the printer gave no reason")
        );
    }

    #[test]
    fn tray_ids() {
        assert_eq!(slot_to_tray("A1"), Some(0));
        assert_eq!(slot_to_tray("B3"), Some(6));
        assert_eq!(slot_to_tray("1"), Some(254));
        assert_eq!(slot_to_tray("E1"), None);
        // Only "1" names the external spool, and a slot is one letter and one digit.
        assert_eq!(slot_to_tray("2"), None);
        assert_eq!(slot_to_tray("A+1"), None);
        assert_eq!(slot_to_tray("A01"), None);
    }

    fn mapped(pairs: &[(u32, &str)]) -> Value {
        let f = RemoteFile {
            printer_id: "bay-1".into(),
            path: "lantern.gcode.3mf".into(),
            name: "lantern.gcode.3mf".into(),
            sha256: None,
        };
        let opts = StartOptions {
            slot_map: Some(pairs.iter().map(|(k, v)| (*k, (*v).to_owned())).collect()),
            ..StartOptions::default()
        };
        project_file_command("7", &f, &opts, None)["print"].clone()
    }

    // Keys are 0 based filament indexes, the way Bambu Studio indexes `ams_mapping`
    // (`get_ams_mapping_result`): filament 1 is key 0 and the first entry.
    #[test]
    fn one_color_from_a1_maps_filament_one_to_tray_zero() {
        let p = mapped(&[(0, "A1")]);
        assert_eq!(p["ams_mapping"], json!([0]));
        assert_eq!(p["ams_mapping2"], json!([{ "ams_id": 0, "slot_id": 0 }]));
        assert_eq!(p["use_ams"], true);
    }

    #[test]
    fn two_colors_from_a1_and_a3() {
        let p = mapped(&[(0, "A1"), (1, "A3")]);
        assert_eq!(p["ams_mapping"], json!([0, 2]));
        assert_eq!(
            p["ams_mapping2"],
            json!([{ "ams_id": 0, "slot_id": 0 }, { "ams_id": 0, "slot_id": 2 }])
        );
        assert_eq!(p["use_ams"], true);
        // A second unit counts on: B2 is tray 5.
        assert_eq!(mapped(&[(0, "B2")])["ams_mapping"], json!([5]));
    }

    // Studio sends the external spool as -1 in `ams_mapping`, names it in `ams_mapping2`, and
    // turns `use_ams` off when nothing comes from the AMS.
    #[test]
    fn the_external_spool_goes_as_studio_sends_it() {
        let p = mapped(&[(0, "1")]);
        assert_eq!(p["ams_mapping"], json!([-1]));
        assert_eq!(p["ams_mapping2"], json!([{ "ams_id": 254, "slot_id": 0 }]));
        assert_eq!(p["use_ams"], false);
        // With an AMS filament as well, the AMS stays on.
        let p = mapped(&[(0, "1"), (1, "A2")]);
        assert_eq!(p["ams_mapping"], json!([-1, 1]));
        assert_eq!(p["use_ams"], true);
    }

    #[test]
    fn no_slot_map_sends_no_mapping() {
        let f = RemoteFile {
            printer_id: "bay-1".into(),
            path: "a.gcode.3mf".into(),
            name: "a.gcode.3mf".into(),
            sha256: None,
        };
        let p = &project_file_command("1", &f, &StartOptions::default(), None)["print"];
        assert_eq!(p["ams_mapping"], json!([]));
        assert_eq!(p["use_ams"], false);
        assert!(p.get("ams_mapping2").is_none());
    }

    #[test]
    fn a_slot_map_the_printer_cannot_follow_is_refused() {
        let map = |pairs: &[(u32, &str)]| {
            pairs
                .iter()
                .map(|(k, v)| (*k, (*v).to_owned()))
                .collect::<BTreeMap<_, _>>()
        };
        assert_eq!(slot_map_problem(&map(&[(0, "A1"), (2, "D4"), (3, "1")])), None);
        // Sent as "unmapped" before, while the card named the slot.
        assert!(slot_map_problem(&map(&[(0, "E1")])).unwrap().contains("\"E1\""));
        // Sized a mapping of four billion entries before.
        assert!(
            slot_map_problem(&map(&[(u32::MAX, "A1")]))
                .unwrap()
                .contains("4294967296")
        );
        assert!(slot_map_problem(&map(&[(MAX_MAPPED_FILAMENTS - 1, "A1")])).is_none());
    }

    #[test]
    fn ams_and_h2d_parse() {
        let v = json!({
            "gcode_state": "RUNNING", "mc_percent": 62, "mc_remaining_time": 84, "layer_num": 148, "total_layer_num": 238,
            "subtask_name": "lantern", "bed_temper": 79.8, "bed_target_temper": 80,
            "device": { "extruder": { "info": [ { "id": 1, "temp": 0x00D7_00D2_u64 }, { "id": 0, "temp": 0x00DC_00DB_u64 } ] } },
            "ams": { "ams": [ { "id": "0", "tray": [
                { "id": "0", "tray_type": "PLA", "tray_color": "F2F2F2FF", "remain": 82 },
                { "id": "1", "tray_type": "", "remain": -1 } ] } ] },
            "ipcam": { "ipcam_dev": "1" }
        });
        let s = parse_status("bay-1", &v);
        assert_eq!(s.state, PrinterState::Printing);
        assert_eq!(s.time_left_s, Some(5040));
        assert_eq!(
            s.nozzles,
            vec![
                Temp {
                    current: 219.0,
                    target: 220.0
                },
                Temp {
                    current: 210.0,
                    target: 215.0
                }
            ]
        );
        assert_eq!(s.slots[0].color.as_deref(), Some("#f2f2f2"));
        assert_eq!(s.slots[1].material, None);
        assert!(s.camera_available);
    }

    #[test]
    fn project_file_uses_wire_keys() {
        let f = RemoteFile {
            printer_id: "bay-1".into(),
            path: "lantern.gcode.3mf".into(),
            name: "lantern.gcode.3mf".into(),
            sha256: None,
        };
        let opts = StartOptions {
            slot_map: Some(BTreeMap::from([(0, "A1".to_owned()), (2, "A3".to_owned())])),
            ..StartOptions::default()
        };
        let v = project_file_command("7", &f, &opts, None);
        assert_eq!(v["print"]["ams_mapping"], json!([0, -1, 2]));
        assert_eq!(
            v["print"]["ams_mapping2"][1],
            json!({ "ams_id": 255, "slot_id": 255 })
        );
        assert_eq!(v["print"]["url"], "ftp:///lantern.gcode.3mf");
        assert_eq!(v["print"]["param"], "Metadata/plate_1.gcode");
        assert!(v["print"].get("bed_levelling").is_some());
    }

    #[test]
    fn the_sd_card_reads_as_bambu_studio_reads_it() {
        assert_eq!(sd_card(&json!({ "home_flag": 0x180 })), Some(SdCard::Normal));
        assert_eq!(sd_card(&json!({ "home_flag": 0x80 })), Some(SdCard::Missing));
        assert_eq!(
            sd_card(&json!({ "home_flag": 0x300, "sdcard": true })),
            Some(SdCard::ReadOnly)
        );
        // The recorded H2D sends `sdcard` true with no storage bits in `home_flag`.
        assert_eq!(
            sd_card(&json!({ "home_flag": 0, "sdcard": true })),
            Some(SdCard::Normal)
        );
        assert_eq!(
            sd_card(&json!({ "aux": "2000", "home_flag": 0x180 })),
            Some(SdCard::Abnormal)
        );
        assert_eq!(sd_card(&json!({})), None);
        assert!(storage_problem(&json!({ "sdcard": false })).is_some());
        assert!(storage_problem(&json!({ "sdcard": false, "fun2": "0x1" })).is_none());
        assert!(storage_problem(&json!({ "home_flag": 0x280 })).is_some());
        assert!(storage_problem(&json!({ "home_flag": 0x180 })).is_none());
        assert!(storage_problem(&json!({})).is_none());
        assert_eq!(hex_bits("3EC18FFF9CFF", 29, 1), Some(0));
        assert_eq!(hex_bits("3EC1AFFF9CFF", 29, 1), Some(1));
    }

    #[test]
    fn older_printers_take_the_project_from_the_sd_card() {
        assert_eq!(project_url(Some("A1 mini"), "a.3mf"), "file:///sdcard/a.3mf");
        assert_eq!(project_url(Some("X1 Carbon"), "a.3mf"), "file:///sdcard/a.3mf");
        assert_eq!(project_url(Some("H2D"), "a.3mf"), "ftp:///a.3mf");
        assert_eq!(project_url(Some("P2S"), "a.3mf"), "ftp:///a.3mf");
        assert_eq!(project_url(None, "a.3mf"), "ftp:///a.3mf");
    }

    #[test]
    fn printer_type_names_the_model_as_bambu_studio_reads_it() {
        assert_eq!(
            model_from_report(&json!({ "printer_type": "C12" })).as_deref(),
            Some("P1S")
        );
        assert_eq!(
            model_from_report(&json!({ "printer_type": "3DPrinter-X1" })).as_deref(),
            Some("X1")
        );
        assert_eq!(
            model_from_report(&json!({ "printer_type": "3DPrinter-X1-Carbon" })).as_deref(),
            Some("X1 Carbon")
        );
        assert_eq!(model_from_report(&json!({ "printer_type": "Z9" })), None);
        assert_eq!(model_from_report(&json!({})), None);
    }

    #[test]
    fn print_options_default_to_what_bambu_studio_sends() {
        let f = RemoteFile {
            printer_id: "bay-1".into(),
            path: "a.gcode.3mf".into(),
            name: "a.gcode.3mf".into(),
            sha256: None,
        };
        let p = &project_file_command("1", &f, &StartOptions::default(), None)["print"];
        assert_eq!(p["bed_levelling"], true);
        assert_eq!(p["flow_cali"], false);
        assert_eq!(p["vibration_cali"], false);
        assert_eq!(p["layer_inspect"], true);
        assert_eq!(p["timelapse"], false);
        assert_eq!(p["bed_type"], "auto");
    }

    #[test]
    fn print_options_reach_the_wire() {
        let f = RemoteFile {
            printer_id: "bay-1".into(),
            path: "a.gcode.3mf".into(),
            name: "a.gcode.3mf".into(),
            sha256: None,
        };
        let opts = StartOptions {
            bed_leveling: Some(false),
            flow_calibration: Some(true),
            vibration_compensation: Some(true),
            timelapse: Some(true),
            first_layer_inspection: Some(false),
            ..StartOptions::default()
        };
        let p = &project_file_command("1", &f, &opts, None)["print"];
        assert_eq!(p["bed_levelling"], false);
        assert_eq!(p["flow_cali"], true);
        assert_eq!(p["vibration_cali"], true);
        assert_eq!(p["layer_inspect"], false);
        assert_eq!(p["timelapse"], true);
    }
}
