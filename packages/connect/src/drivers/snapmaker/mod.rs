// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Snapmaker. Two protocols, chosen by probing:
//!
//! - Moonraker, for the Snapmaker U1 (Klipper), through the Moonraker driver.
//! - The HTTP API that Snapmaker Luban uses on the 2.0 machines (A150, A250, A350) in `luban.rs`.
//!   J1 and Artisan speak SACP over TCP 8888, which is not implemented.
mod luban;

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
}

impl SnapmakerConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            moonraker: MoonrakerConnector::for_plugin("snapmaker", 80, gate.clone()),
            gate,
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
}

#[async_trait]
impl PrinterConnector for SnapmakerConnector {
    fn manifest(&self) -> PluginManifest {
        self.moonraker.manifest()
    }

    async fn discover(&self, timeout: Duration) -> Vec<DiscoveredPrinter> {
        self.moonraker.discover(timeout).await
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
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

    /// A U1 at a typed address: Moonraker on 80 or 7125 with the U1's own `print_task_config`
    /// object, or the host name U1.
    async fn probe(&self, host: &str, timeout: Duration) -> Option<DiscoveredPrinter> {
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

    /// Pairing for 2.0 machines: waits for the user to confirm on the touchscreen and returns the
    /// token to keep in the keychain. Moonraker machines need no pairing.
    async fn authorize(&self, cfg: &PrinterConfig, timeout: Duration) -> Result<Option<String>> {
        if cfg.protocol.as_deref() == Some("moonraker")
            || (cfg.protocol.is_none() && self.moonraker_port(cfg).await.is_some())
        {
            return Ok(None);
        }
        luban::LubanClient::authorize(cfg, timeout).await
    }
}
