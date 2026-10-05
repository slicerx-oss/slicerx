// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Printer drivers. Each file cites its protocol documentation in the module comment and in
//! README.md.
use std::sync::Arc;

use crate::PrinterConnector;
use crate::gate::ApprovalGate;

pub mod bambu;
pub mod creality;
pub mod duet;
pub mod elegoo;
pub mod moonraker;
pub mod octoprint;
pub mod prusalink;
pub mod snapmaker;

pub use bambu::BambuConnector;
pub use creality::CrealityConnector;
pub use duet::DuetConnector;
pub use elegoo::ElegooConnector;
pub use moonraker::MoonrakerConnector;
pub use octoprint::OctoPrintConnector;
pub use prusalink::PrusaLinkConnector;
pub use snapmaker::SnapmakerConnector;

pub(crate) fn all(
    gate: Arc<dyn ApprovalGate>,
    discovery_bind: std::net::IpAddr,
) -> Vec<Box<dyn PrinterConnector>> {
    vec![
        Box::new(BambuConnector::new(gate.clone()).with_discovery_bind(discovery_bind)),
        Box::new(MoonrakerConnector::new(gate.clone())),
        Box::new(PrusaLinkConnector::new(gate.clone())),
        Box::new(OctoPrintConnector::new(gate.clone())),
        Box::new(DuetConnector::new(gate.clone())),
        Box::new(CrealityConnector::new(gate.clone())),
        Box::new(ElegooConnector::new(gate.clone()).with_discovery_bind(discovery_bind)),
        Box::new(SnapmakerConnector::new(gate)),
    ]
}
