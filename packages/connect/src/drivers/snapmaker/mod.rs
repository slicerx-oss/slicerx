// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Snapmaker. Two protocols, chosen by probing:
//!
//! - Moonraker, for the Snapmaker U1 (Klipper), through the Moonraker driver.
//! - The HTTP API that Snapmaker Luban uses on the 2.0 machines (A150, A250, A350) in `luban.rs`.
//! - J1, J1S and Artisan speak SACP over TCP 8888 (`sacp.rs`).
//!
//! The 2.0 machines, the J1 and the Artisan answer a `discover` broadcast on UDP 20054
//! (`discover.rs`).
mod discover;
mod luban;
mod sacp;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use super::moonraker::MoonrakerConnector;
use crate::error::{Error, Result};
use crate::gate::ApprovalGate;
use crate::http;
use crate::manifest::PluginManifest;
use crate::types::{DiscoveredPrinter, PrinterConfig, Secrets};
use crate::{PrinterConnector, PrinterSession};

pub struct SnapmakerConnector {
    moonraker: MoonrakerConnector,
    gate: Arc<dyn ApprovalGate>,
    u1_ports: Vec<u16>,
    /// The address the discovery broadcast goes out from: all addresses in the app, loopback in tests.
    discovery_bind: std::net::IpAddr,
    /// The UDP port machines answer `discover` on: 20054, another in tests.
    discovery_port: u16,
}

impl SnapmakerConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            moonraker: MoonrakerConnector::for_plugin("snapmaker", 80, gate.clone()),
            gate,
            discovery_bind: std::net::Ipv4Addr::UNSPECIFIED.into(),
            discovery_port: discover::DISCOVERY_PORT,
            u1_ports: vec![80, 7125],
        }
    }

    /// Looks for a U1's Moonraker on `ports` instead of 80 and 7125 (tests).
    #[must_use]
    pub fn with_u1_ports(mut self, ports: Vec<u16>) -> Self {
        self.u1_ports = ports;
        self
    }

    /// The U1's Moonraker port: the configured one, else 80, where its web UI serves the API, then
    /// Moonraker's own 7125. Both answer on stock firmware.
    async fn moonraker_port(&self, cfg: &PrinterConfig) -> Option<u16> {
        let ports = cfg.port.map_or_else(|| self.u1_ports.clone(), |p| vec![p]);
        for p in ports {
            if http::is_moonraker(cfg, p).await {
                return Some(p);
            }
        }
        None
    }

    /// A U1 at a typed address: Moonraker on 80 or 7125 with the U1's own `print_task_config`
    /// object, or the host name U1.
    async fn probe_u1(&self, host: &str, timeout: Duration) -> Option<DiscoveredPrinter> {
        for &port in &self.u1_ports {
            let Some(id) = super::moonraker::identify(host, port, timeout).await else {
                continue;
            };
            if !id.is_u1() {
                return None;
            }
            return Some(DiscoveredPrinter {
                plugin: "snapmaker".to_owned(),
                host: host.to_owned(),
                port: Some(port),
                name: id.hostname,
                model: Some("U1".to_owned()),
                firmware: id.moonraker_version.map(|v| format!("Moonraker {v}")),
                ..DiscoveredPrinter::default()
            });
        }
        None
    }

    /// Sends the discovery broadcast from `ip` instead of every address.
    #[must_use]
    pub fn with_discovery_bind(mut self, ip: std::net::IpAddr) -> Self {
        self.discovery_bind = ip;
        self
    }

    /// Asks machines on `port` instead of 20054.
    #[must_use]
    pub fn with_discovery_port(mut self, port: u16) -> Self {
        self.discovery_port = port;
        self
    }
}

/// Whether a config points at a SACP machine (J1, J1S, Artisan): `protocol` says so, or, unset, the
/// port is the SACP port a scan fills in.
fn is_sacp(cfg: &PrinterConfig) -> bool {
    match cfg.protocol.as_deref() {
        Some(p) => p == "sacp",
        None => cfg.port == Some(discover::SACP_PORT),
    }
}

#[async_trait]
impl PrinterConnector for SnapmakerConnector {
    fn manifest(&self) -> PluginManifest {
        self.moonraker.manifest()
    }

    /// One `discover` broadcast on UDP 20054, sent when the user starts a scan: the 2.0 machines, the
    /// J1 and the Artisan answer it. The U1 is found as a Moonraker printer.
    async fn discover(&self, timeout: Duration) -> Vec<DiscoveredPrinter> {
        let (mut found, moon) = tokio::join!(
            discover::broadcast(self.discovery_bind, self.discovery_port, timeout),
            self.moonraker.discover(timeout)
        );
        found.extend(moon);
        found
    }

    /// A typed address: a U1 answers as Moonraker (`probe_u1`); a 2.0 machine, J1 or Artisan answers
    /// `discover` sent to it alone, naming the machine and whether it speaks SACP (port 8888) or the
    /// 2.0 HTTP API (8080). Both are asked at once.
    async fn probe(&self, host: &str, timeout: Duration) -> Option<DiscoveredPrinter> {
        let udp = async {
            let std::net::IpAddr::V4(v4) = host.parse().ok()? else {
                return None;
            };
            discover::ask_one(self.discovery_bind, v4, self.discovery_port, timeout).await
        };
        let (u1, other) = tokio::join!(self.probe_u1(host, timeout), udp);
        u1.or(other)
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        if is_sacp(cfg) {
            return sacp::open(cfg, secrets);
        }
        match cfg.protocol.as_deref() {
            Some("moonraker") => return self.moonraker.connect(cfg, secrets).await,
            Some("luban") => return luban::LubanClient::open(cfg, secrets, self.gate.clone()).await,
            Some(other) => return Err(Error::Config(format!("unknown Snapmaker protocol {other}"))),
            None => {}
        }
        if let Some(port) = self.moonraker_port(cfg).await {
            let mut with_port = cfg.clone();
            with_port.port = Some(port);
            return self.moonraker.connect(&with_port, secrets).await;
        }
        luban::LubanClient::open(cfg, secrets, self.gate.clone()).await
    }

    fn pairs(&self) -> bool {
        true
    }

    /// Pairing for 2.0 machines: waits for the user to confirm on the touchscreen and returns the
    /// token to keep in the keychain. Moonraker machines need no pairing.
    async fn authorize(&self, cfg: &PrinterConfig, timeout: Duration) -> Result<Option<String>> {
        if is_sacp(cfg) {
            return sacp::authorize(cfg, timeout);
        }
        if cfg.protocol.as_deref() == Some("moonraker")
            || (cfg.protocol.is_none() && self.moonraker_port(cfg).await.is_some())
        {
            return Ok(None);
        }
        luban::LubanClient::authorize(cfg, timeout).await
    }
}
