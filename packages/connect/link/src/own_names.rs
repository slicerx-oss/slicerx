// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The names Bambu Lab printers announce for themselves (SSDP `DevName`, "Tawain #1"), by serial.
//! A printer added under its model alone ("H2D") is shown under this name; the hub adds it to the
//! printer's status as `ownName`.
use std::collections::HashMap;

use sx_connect::DiscoveredPrinter;

#[derive(Default)]
pub(crate) struct OwnNames(HashMap<String, String>);

impl OwnNames {
    /// Keeps the name each Bambu Lab printer announced, under its serial.
    pub(crate) fn remember(&mut self, found: &[DiscoveredPrinter]) {
        for d in found.iter().filter(|d| d.plugin == "bambu-lan") {
            if let (Some(serial), Some(name)) = (&d.serial, d.name.as_deref().map(str::trim))
                && !name.is_empty()
            {
                self.0.insert(serial.clone(), name.to_owned());
            }
        }
    }

    pub(crate) fn get(&self, serial: &str) -> Option<&str> {
        self.0.get(serial).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heard(text: &str) -> DiscoveredPrinter {
        sx_connect::drivers::bambu::parse_ssdp(text).unwrap()
    }

    #[test]
    fn an_announced_name_is_kept_by_serial() {
        let h2d = heard(
            "NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nLocation: 192.0.2.40\r\nUSN: 0948AD000000001\r\nDevModel.bambu.com: O1D\r\nDevName.bambu.com: Tawain #1\r\n\r\n",
        );
        assert_eq!(h2d.model.as_deref(), Some("H2D"));
        let mut names = OwnNames::default();
        names.remember(&[h2d]);
        assert_eq!(names.get("0948AD000000001"), Some("Tawain #1"));
        assert_eq!(names.get("other"), None);
        // An empty name or another family's announcement is not kept.
        let blank = heard(
            "NOTIFY * HTTP/1.1\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nLocation: 192.0.2.41\r\nUSN: 01P00A000000002\r\nDevName.bambu.com:  \r\n\r\n",
        );
        let other = DiscoveredPrinter {
            plugin: "moonraker".into(),
            host: "192.0.2.42".into(),
            port: None,
            name: Some("Voron".into()),
            model: None,
            serial: Some("v1".into()),
            firmware: None,
            lan_only: None,
            ..DiscoveredPrinter::default()
        };
        names.remember(&[blank, other]);
        assert_eq!((names.get("01P00A000000002"), names.get("v1")), (None, None));
    }
}
