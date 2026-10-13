// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The names of the keychain items the app keeps, per app identifier. The shipping app
//! (`app.slicerx.desktop`) keeps the names it always had, so nothing moves for people who have it.
//! Any other identifier (the agent bridge's test build, a dev identifier, another edition) adds
//! `.<identifier>` to every service name, so a test build never reads, replaces or deletes the
//! installed app's credentials. `keychainService` in packages/mcp (agents.ts) is the same rule, for
//! the MCP server that reads an agent's credential.

use std::sync::OnceLock;

/// The shipping app's identifier: its items keep their names unchanged.
pub const SHIPPING_IDENTIFIER: &str = "app.slicerx.desktop";

/// Printer access codes and the printer hub's own secrets, one account per secret.
pub const PRINTERS: &str = "slicerx-printers";
/// The key that seals phone pairings (pairdoc.rs).
pub const PAIR: &str = "slicerx-pair";

static IDENTIFIER: OnceLock<String> = OnceLock::new();

/// Called first thing in main, with the identifier the app was built with.
pub fn init(identifier: &str) {
    let _ = IDENTIFIER.set(identifier.to_owned());
}

/// The running app's identifier. Before `init` (tests), the checkout's tauri.conf.json, the shipping app's.
pub fn identifier() -> &'static str {
    IDENTIFIER.get().map_or(SHIPPING_IDENTIFIER, String::as_str)
}

/// The service name `base` is kept under in an app with `identifier`.
pub fn service_for(identifier: &str, base: &str) -> String {
    if identifier == SHIPPING_IDENTIFIER {
        base.to_owned()
    } else {
        format!("{base}.{identifier}")
    }
}

/// The service name `base` is kept under in this app.
pub fn service(base: &str) -> String {
    service_for(identifier(), base)
}

/// The service of an agent client's hub credential (account `slicerx`), `agentKeyRef` in packages/mcp.
#[cfg(feature = "pilot")]
pub fn agent_service(client: &str) -> String {
    service(&format!("slicerx-agent-{client}"))
}

/// Every service this build can keep an item under, before the identifier's suffix.
pub fn bases() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    #[cfg(feature = "connect")]
    out.extend([PRINTERS.to_owned(), PAIR.to_owned()]);
    #[cfg(feature = "pilot")]
    {
        out.extend(
            [
                sx_llm::OPENAI_KEYCHAIN_SERVICE,
                sx_llm::ANTHROPIC_KEYCHAIN_SERVICE,
                sx_llm::LOCAL_KEYCHAIN_SERVICE,
                sx_llm::chatgpt::CHATGPT_KEYCHAIN_SERVICE,
                sx_llm::MIMIR_CLOUD_KEYCHAIN_SERVICE,
            ]
            .map(str::to_owned),
        );
        out.extend(
            crate::agents::CLIENTS
                .iter()
                .map(|c| format!("slicerx-agent-{c}")),
        );
    }
    out
}

/// What a client reads back: the identifier and the service names this app keeps its items under. Names only;
/// nothing here opens the keychain.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Names {
    pub identifier: String,
    /// True for the shipping app, whose names carry no suffix.
    pub shipping: bool,
    pub services: Vec<String>,
}

pub fn names_for(identifier: &str) -> Names {
    Names {
        identifier: identifier.to_owned(),
        shipping: identifier == SHIPPING_IDENTIFIER,
        services: bases().iter().map(|b| service_for(identifier, b)).collect(),
    }
}

/// The keychain service names this app uses, for the agent setup flow and the agent bridge's health.
#[tauri::command]
pub fn keychain_names() -> Names {
    names_for(identifier())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Today's names, written out: a change here is a migration for everyone who has the app.
    fn shipping_names() -> Vec<&'static str> {
        let mut v: Vec<&'static str> = Vec::new();
        if cfg!(feature = "connect") {
            v.extend(["slicerx-printers", "slicerx-pair"]);
        }
        if cfg!(feature = "pilot") {
            v.extend([
                "slicerx-openai-api-key",
                "slicerx-anthropic-api-key",
                "slicerx-local-api-key",
                "slicerx-chatgpt",
                "slicerx-mimir-cloud-token",
                "slicerx-agent-claude-desktop",
                "slicerx-agent-claude-code",
                "slicerx-agent-cursor",
                "slicerx-agent-codex",
                "slicerx-agent-chatgpt",
            ]);
        }
        v
    }

    #[test]
    fn the_shipping_app_keeps_exactly_todays_names() {
        let n = names_for(SHIPPING_IDENTIFIER);
        assert!(n.shipping);
        assert_eq!(n.services, shipping_names());
        // The checkout's config is the shipping app's, and so is the default before init.
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], SHIPPING_IDENTIFIER);
        assert_eq!(identifier(), SHIPPING_IDENTIFIER);
        assert_eq!(service(PRINTERS), "slicerx-printers");
        #[cfg(feature = "pilot")]
        assert_eq!(agent_service("cursor"), "slicerx-agent-cursor");
    }

    #[test]
    fn a_test_build_never_resolves_to_a_shipping_name() {
        let shipping = shipping_names();
        for id in [
            "app.slicerx.desktop.agent-bridge",
            "app.slicerx.desktop.dev",
            "app.slicerx.desktop2",
            "app.layermate.desktop",
            "app.layermate.desktop.agent-bridge",
            "com.example.demo",
            "",
        ] {
            let n = names_for(id);
            assert!(!n.shipping, "{id}");
            assert_eq!(n.services.len(), shipping.len());
            for s in &n.services {
                assert!(
                    !shipping.contains(&s.as_str()),
                    "{id} resolves {s} to a shipping name"
                );
                assert!(s.ends_with(&format!(".{id}")), "{s}");
            }
        }
        assert_eq!(
            service_for("app.slicerx.desktop.agent-bridge", "slicerx-mimir-cloud-token"),
            "slicerx-mimir-cloud-token.app.slicerx.desktop.agent-bridge"
        );
    }

    #[test]
    fn two_test_builds_do_not_share_names() {
        let a = names_for("app.slicerx.desktop.agent-bridge").services;
        let b = names_for("app.layermate.desktop.agent-bridge").services;
        assert!(a.iter().all(|s| !b.contains(s)));
    }
}
