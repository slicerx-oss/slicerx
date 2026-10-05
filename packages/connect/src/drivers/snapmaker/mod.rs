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
}

impl SnapmakerConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            moonraker: MoonrakerConnector::for_plugin("snapmaker", 80, gate.clone()),
            gate,
        }
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
        if http::is_moonraker(cfg, cfg.port.unwrap_or(80)).await {
            return self.moonraker.connect(cfg, secrets).await;
        }
        luban::LubanClient::open(cfg, secrets, self.gate.clone()).await
    }

    /// Pairing for 2.0 machines: waits for the user to confirm on the touchscreen and returns the
    /// token to keep in the keychain. Moonraker machines need no pairing.
    async fn authorize(&self, cfg: &PrinterConfig, timeout: Duration) -> Result<Option<String>> {
        if cfg.protocol.as_deref() == Some("moonraker")
            || (cfg.protocol.is_none() && http::is_moonraker(cfg, cfg.port.unwrap_or(80)).await)
        {
            return Ok(None);
        }
        luban::LubanClient::authorize(cfg, timeout).await
    }
}
