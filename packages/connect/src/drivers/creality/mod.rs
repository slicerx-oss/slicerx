// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Creality printers. Two protocols, chosen by probing:
//!
//! - Moonraker, for Klipper models (K2 series, rooted or community-firmware K1) through the
//!   Moonraker driver.
//! - The native interface stock firmware exposes to Creality Print (`native.rs`): K1, K1 Max,
//!   K1C, K2 Plus, Ender-3 V3 and Hi.
mod native;

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
}

impl CrealityConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            moonraker: MoonrakerConnector::for_plugin("creality", 7125, gate.clone()),
            gate,
        }
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
        let port = cfg.ws_port.unwrap_or(9999);
        matches!(
            tokio::time::timeout(
                Duration::from_secs(2),
                TcpStream::connect((cfg.host.as_str(), port))
            )
            .await,
            Ok(Ok(_))
        )
    }
}

#[async_trait]
impl PrinterConnector for CrealityConnector {
    fn manifest(&self) -> PluginManifest {
        self.moonraker.manifest()
    }

    async fn discover(&self, timeout: Duration) -> Vec<DiscoveredPrinter> {
        self.moonraker.discover(timeout).await
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        match cfg.protocol.as_deref() {
            Some("moonraker") => return self.moonraker.connect(cfg, secrets).await,
            Some("native") => return native::NativeSession::open(cfg, self.gate.clone()).await,
            Some(other) => return Err(Error::Config(format!("unknown Creality protocol {other}"))),
            None => {}
        }
        // Moonraker first: it is the richer interface and rooted machines answer both.
        if let Some(port) = Self::moonraker_port(cfg).await {
            let mut with_port = cfg.clone();
            with_port.port = Some(port);
            return self.moonraker.connect(&with_port, secrets).await;
        }
        if Self::native_reachable(cfg).await {
            return native::NativeSession::open(cfg, self.gate.clone()).await;
        }
        Err(Error::unreachable(
            &cfg.id,
            "neither Moonraker nor the Creality interface answered",
        ))
    }
}
