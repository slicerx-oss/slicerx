// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Creality printers. Two protocols, chosen by probing:
//!
//! - Moonraker, for Klipper models (K2 series, rooted or community-firmware K1) through the
//!   Moonraker driver.
//! - The native interface stock firmware exposes to Creality Print (`native.rs`): K1, K1 Max,
//!   K1C, K2 Plus, Ender-3 V3 and Hi.
mod native;

pub(crate) use native::query_boxes;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::net::TcpStream;

use super::moonraker::MoonrakerConnector;
use crate::error::{Error, Result};
use crate::gate::ApprovalGate;
use crate::http;
use crate::manifest::PluginManifest;
use crate::types::{DiscoveredPrinter, PrinterConfig, Secrets};
use crate::{PrinterConnector, PrinterSession};

pub struct CrealityConnector {
    moonraker: MoonrakerConnector,
    gate: Arc<dyn ApprovalGate>,
    /// The ports a probe asks: `/info` on the web port (80) and the WebSocket (9999).
    probe_ports: (u16, u16),
}

impl CrealityConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            moonraker: MoonrakerConnector::for_plugin("creality", 7125, gate.clone()),
            gate,
            probe_ports: (80, 9999),
        }
    }

    /// Probes `/info` on `http` and the WebSocket on `ws` instead of 80 and 9999 (tests).
    #[must_use]
    pub fn with_probe_ports(mut self, http: u16, ws: u16) -> Self {
        self.probe_ports = (http, ws);
        self
    }

    /// Moonraker answering on the configured port (7125 and 4408 when none is set).
    async fn moonraker_port(cfg: &PrinterConfig) -> Option<u16> {
        let ports: Vec<u16> = cfg.port.map_or_else(|| vec![7125, 4408], |p| vec![p]);
        for p in ports {
            if http::is_moonraker(cfg, p).await {
                return Some(p);
            }
        }
        None
    }

    async fn native_reachable(cfg: &PrinterConfig) -> bool {
        port_open(&cfg.host, cfg.ws_port.unwrap_or(9999), Duration::from_secs(2)).await
    }
}

async fn port_open(host: &str, port: u16, timeout: Duration) -> bool {
    matches!(
        tokio::time::timeout(timeout, TcpStream::connect((host, port))).await,
        Ok(Ok(_))
    )
}

#[async_trait]
impl PrinterConnector for CrealityConnector {
    fn manifest(&self) -> PluginManifest {
        self.moonraker.manifest()
    }

    /// Nothing to listen for here: stock Creality printers announce a service type of their own,
    /// which the scan browses for every family at once (`mdns::browse_printers`).
    async fn discover(&self, _timeout: Duration) -> Vec<DiscoveredPrinter> {
        Vec::new()
    }

    /// A stock Creality printer at a typed address: `GET /info` names the model (a board code such
    /// as F008 for a K2 Plus) and the MAC, as OrcaSlicer's CrealityHostDiscovery reads it; a printer
    /// that does not answer it but has its WebSocket open on 9999 is still a Creality printer.
    async fn probe(&self, host: &str, timeout: Duration) -> Option<DiscoveredPrinter> {
        let (http_port, ws_port) = self.probe_ports;
        let cfg = PrinterConfig {
            http_port: Some(http_port),
            ..probe_config(host)
        };
        let found = |info: Option<&serde_json::Value>| {
            let text = |k: &str| {
                info.and_then(|v| v.get(k))
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            };
            DiscoveredPrinter {
                plugin: "creality".to_owned(),
                host: host.to_owned(),
                name: text("hostname"),
                model: text("model").and_then(|m| native::model_name(&m, "")),
                uid: text("mac").map(|m| m.to_ascii_uppercase()),
                ..DiscoveredPrinter::default()
            }
        };
        if let Ok(Some(info)) = tokio::time::timeout(timeout, native::fetch_info(&cfg, None)).await
            && info.get("model").is_some()
        {
            return Some(found(Some(&info)));
        }
        port_open(host, ws_port, timeout).await.then(|| found(None))
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        // OrcaSlicer's Creality host sends a key as `Authorization: Bearer` to the native interface.
        let key = cfg.credential_ref.as_deref().and_then(|r| secrets.get(r));
        match cfg.protocol.as_deref() {
            Some("moonraker") => return self.moonraker.connect(cfg, secrets).await,
            Some("native") => return native::NativeSession::open(cfg, key, self.gate.clone()).await,
            Some(other) => return Err(Error::Config(format!("unknown Creality protocol {other}"))),
            None => {}
        }
        // Moonraker first: it is the richer interface and rooted machines answer both. Only a JSON
        // Moonraker answer counts, so a K2's Fluidd page on 4408 is never taken for the API.
        if let Some(port) = Self::moonraker_port(cfg).await {
            let mut with_port = cfg.clone();
            with_port.port = Some(port);
            return self.moonraker.connect(&with_port, secrets).await;
        }
        if Self::native_reachable(cfg).await {
            return native::NativeSession::open(cfg, key, self.gate.clone()).await;
        }
        Err(Error::unreachable(
            &cfg.id,
            "neither Moonraker nor the Creality interface answered",
        ))
    }
}

/// A config that names only the host, for a probe.
fn probe_config(host: &str) -> PrinterConfig {
    PrinterConfig {
        id: format!("probe-{host}"),
        name: host.to_owned(),
        plugin: "creality".to_owned(),
        host: host.to_owned(),
        port: None,
        credential_ref: None,
        serial: None,
        tls: None,
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
