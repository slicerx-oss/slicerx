// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The edition the app was built as: its name, link scheme and publisher. They come from the Tauri
//! config, which the edition's overlay (`edition-config tauri`) sets at build time, so a white-label
//! build names itself everywhere the shell speaks: links, dialogs, the menu and AI client entries.

use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Brand {
    /// Product name, as in title bars and dialogs.
    pub name: String,
    /// The custom URL scheme of "Open in" links, such as `slicerx`.
    pub scheme: String,
    pub publisher: String,
    pub homepage: Option<String>,
}

static BRAND: OnceLock<Brand> = OnceLock::new();

impl Brand {
    pub fn from_config(config: &tauri::Config) -> Self {
        let name = config
            .product_name
            .clone()
            .unwrap_or_else(|| "SlicerX".to_owned());
        let scheme = config
            .plugins
            .0
            .get("deep-link")
            .and_then(|d| d.pointer("/desktop/schemes/0"))
            .and_then(|s| s.as_str())
            .unwrap_or("slicerx")
            .to_owned();
        let publisher = config.bundle.publisher.clone().unwrap_or_else(|| name.clone());
        Self {
            name,
            scheme,
            publisher,
            homepage: config.bundle.homepage.clone(),
        }
    }

    /// The name AI clients list the MCP server under (`mcpServerId` in packages/edition-config).
    pub fn server_id(&self) -> String {
        self.scheme
            .chars()
            .map(|c| {
                if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect()
    }
}

/// Called first thing in main, with the config the app was built with.
pub fn init(config: &tauri::Config) {
    let _ = BRAND.set(Brand::from_config(config));
}

/// The running edition. Before `init` (tests), the checkout's tauri.conf.json: SlicerX.
pub fn get() -> &'static Brand {
    BRAND.get_or_init(|| Brand::from_config(&base_config()))
}

fn base_config() -> tauri::Config {
    serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json is a Tauri config")
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// RFC 7396, the way `tauri build --config` merges the overlay.
    fn merge(target: &mut serde_json::Value, patch: &serde_json::Value) {
        match (target, patch) {
            (serde_json::Value::Object(t), serde_json::Value::Object(p)) => {
                for (k, v) in p {
                    if v.is_null() {
                        t.remove(k);
                    } else {
                        merge(t.entry(k.clone()).or_insert(serde_json::Value::Null), v);
                    }
                }
            }
            (t, p) => *t = p.clone(),
        }
    }

    /// The sample white-label edition, Acme Slicer, as its build would configure this shell.
    pub fn acme() -> Brand {
        let mut config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let overlay: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/edition-config/fixtures/acme/tauri.desktop.json"
        ))
        .unwrap();
        merge(&mut config, &overlay);
        Brand::from_config(&serde_json::from_value(config).unwrap())
    }

    #[test]
    fn the_checkout_is_slicerx() {
        let b = Brand::from_config(&base_config());
        assert_eq!(b.name, "SlicerX");
        assert_eq!(b.scheme, "slicerx");
        assert_eq!(b.server_id(), "slicerx");
    }

    #[test]
    fn a_white_label_build_names_itself() {
        let b = acme();
        assert_eq!(b.name, "Acme Slicer");
        assert_eq!(b.scheme, "acmeslicer");
        assert_eq!(b.publisher, "Acme Printers Inc.");
        assert_eq!(b.homepage.as_deref(), Some("https://slicer.acme.example"));
        assert_eq!(b.server_id(), "acmeslicer");
    }
}
