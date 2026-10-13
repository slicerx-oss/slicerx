// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Printer drivers. Each file cites its protocol documentation in the module comment and in
//! README.md.
use std::sync::Arc;

use crate::PrinterConnector;
use crate::gate::ApprovalGate;

pub mod anycubic;
pub mod bambu;
pub mod bambuddy;
pub mod creality;
pub mod duet;
pub mod elegoo;
pub mod moonraker;
pub mod octoprint;
pub mod prusalink;
pub mod snapmaker;
pub mod ultimaker;

pub use anycubic::AnycubicConnector;
pub use bambu::BambuConnector;
pub use bambuddy::BambuddyConnector;
pub use creality::CrealityConnector;
pub use duet::DuetConnector;
pub use elegoo::ElegooConnector;
pub use moonraker::MoonrakerConnector;
pub use octoprint::OctoPrintConnector;
pub use prusalink::PrusaLinkConnector;
pub use snapmaker::SnapmakerConnector;
pub use ultimaker::UltiMakerConnector;

/// The PrusaLink connector. In a test build (`test-hooks`) its scan takes the addresses in `SX_TEST_NEIGHBORS`
/// instead of the neighbour table, so a test can point the hub's scan at a fake printer.
fn prusalink(gate: Arc<dyn ApprovalGate>) -> PrusaLinkConnector {
    let c = PrusaLinkConnector::new(gate);
    #[cfg(feature = "test-hooks")]
    if let Some((ips, port)) = test_neighbors(std::env::var("SX_TEST_NEIGHBORS").ok().as_deref()) {
        return c.with_neighbors(ips).with_probe_port(port);
    }
    c
}

/// `SX_TEST_NEIGHBORS` as `<ipv4>:<port>[,<ipv4>:<port>...]`: the addresses a scan probes, all on the first entry's
/// port. Anything else is no hook.
#[cfg(feature = "test-hooks")]
pub(crate) fn test_neighbors(value: Option<&str>) -> Option<(Vec<std::net::Ipv4Addr>, u16)> {
    let mut port = None;
    let mut ips = Vec::new();
    for entry in value?.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let addr: std::net::SocketAddrV4 = entry.parse().ok()?;
        port.get_or_insert(addr.port());
        ips.push(*addr.ip());
    }
    Some((ips, port?))
}

/// The addresses a test build's PrusaLink scan probes (`SX_TEST_NEIGHBORS`, as set), or `None` when the hook is off
/// because the variable is unset or malformed. sx-link prints it at startup, so a test can tell it has a build with
/// the hook before it relies on one.
#[cfg(feature = "test-hooks")]
pub fn test_neighbors_hook() -> Option<String> {
    let value = std::env::var("SX_TEST_NEIGHBORS").ok()?;
    test_neighbors(Some(&value)).map(|_| value)
}

pub(crate) fn all(
    gate: Arc<dyn ApprovalGate>,
    discovery_bind: std::net::IpAddr,
) -> Vec<Box<dyn PrinterConnector>> {
    vec![
        Box::new(BambuConnector::new(gate.clone()).with_discovery_bind(discovery_bind)),
        Box::new(MoonrakerConnector::new(gate.clone())),
        Box::new(prusalink(gate.clone())),
        Box::new(OctoPrintConnector::new(gate.clone())),
        Box::new(DuetConnector::new(gate.clone())),
        Box::new(CrealityConnector::new(gate.clone())),
        Box::new(ElegooConnector::new(gate.clone()).with_discovery_bind(discovery_bind)),
        Box::new(SnapmakerConnector::new(gate.clone()).with_discovery_bind(discovery_bind)),
        Box::new(UltiMakerConnector::new(gate.clone()).with_discovery_bind(discovery_bind)),
        Box::new(AnycubicConnector::new(gate.clone())),
        Box::new(BambuddyConnector::new(gate)),
    ]
}

#[cfg(all(test, feature = "test-hooks"))]
mod tests {
    use super::test_neighbors;

    #[test]
    fn the_test_hook_reads_addresses_with_their_port_and_nothing_else() {
        let (ips, port) = test_neighbors(Some("127.0.0.1:5001, 127.0.0.2:5001")).unwrap();
        assert_eq!((ips.len(), port), (2, 5001));
        for bad in [
            None,
            Some(""),
            Some("127.0.0.1"),
            Some("printer:80"),
            Some("[::1]:80"),
        ] {
            assert!(test_neighbors(bad).is_none(), "{bad:?}");
        }
    }
}
