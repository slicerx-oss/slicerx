// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Home Assistant REST API with a long-lived access token: list entities and call services
//! on a short allow-list of domains (printer power plugs, enclosure fans and lights).
use std::sync::Arc;

use async_trait::async_trait;
use reqwest::Client;
use serde_json::{Value, json};

use super::strip_prefix;
use crate::error::{Error, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::manifest::{PluginManifest, manifest};
use crate::{ServicePlugin, http};

/// Domains `list_entities` shows and `call_service` may touch. Locks, alarms, covers and scripts are not on the list.
const ALLOWED_DOMAINS: &[&str] = &["switch", "light", "fan", "input_boolean", "button"];

pub struct HomeAssistantPlugin {
    base: String,
    token: String,
    client: Client,
    gate: Arc<dyn ApprovalGate>,
}

impl std::fmt::Debug for HomeAssistantPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HomeAssistantPlugin")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

impl HomeAssistantPlugin {
    /// `base` is the server root, such as `http://host:8123`. `token` comes from the keychain.
    pub fn new(base: &str, token: String, gate: Arc<dyn ApprovalGate>) -> Result<Self> {
        if !base.starts_with("http://") {
            return Err(Error::Config("service URLs must start with http://".to_owned()));
        }
        let client = http::service_client()?;
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            token,
            client,
            gate,
        })
    }
}

fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

#[async_trait]
impl ServicePlugin for HomeAssistantPlugin {
    fn manifest(&self) -> PluginManifest {
        manifest("home-assistant")
            .unwrap_or_else(|| crate::drivers::prusalink::unreachable_manifest("home-assistant"))
    }

    async fn call(&self, tool: &str, args: Value, token: Option<&ApprovalToken>) -> Result<Value> {
        match strip_prefix("home-assistant", tool) {
            "list_entities" => {
                let domain = args.get("domain").and_then(Value::as_str);
                if let Some(d) = domain.filter(|d| !ALLOWED_DOMAINS.contains(d)) {
                    return Err(Error::not_supported(
                        "home-assistant",
                        &format!("entities in the {d} domain"),
                    ));
                }
                let rb = self
                    .client
                    .get(format!("{}/api/states", self.base))
                    .bearer_auth(&self.token);
                let v = http::json("home-assistant", http::send("home-assistant", rb).await?).await?;
                let out: Vec<Value> = v
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|e| {
                        let id = e.get("entity_id")?.as_str()?;
                        // the domain is the part before the dot; anything off the list stays hidden
                        let d = id.split_once('.')?.0;
                        if !ALLOWED_DOMAINS.contains(&d) || domain.is_some_and(|want| want != d) {
                            return None;
                        }
                        Some(json!({
                            "entityId": id,
                            "state": e.get("state"),
                            "name": e.get("attributes").and_then(|a| a.get("friendly_name")),
                        }))
                    })
                    .collect();
                Ok(Value::Array(out))
            }
            "call_service" => {
                let field = |k: &str| {
                    args.get(k)
                        .and_then(Value::as_str)
                        .ok_or_else(|| Error::protocol("home-assistant", format!("{k} is required")))
                };
                let (domain, service, entity) = (field("domain")?, field("service")?, field("entityId")?);
                if !ALLOWED_DOMAINS.contains(&domain) {
                    return Err(Error::not_supported(
                        "home-assistant",
                        &format!("services in the {domain} domain"),
                    ));
                }
                if !valid_segment(service) || !entity.starts_with(&format!("{domain}.")) {
                    return Err(Error::protocol(
                        "home-assistant",
                        "service or entity id is malformed",
                    ));
                }
                let token = token.ok_or_else(|| Error::ApprovalRequired {
                    action: Action::PluginCall.as_str().to_owned(),
                })?;
                self.gate.check(
                    token,
                    Action::PluginCall,
                    "home-assistant",
                    &params::plugin("home-assistant", "call_service", &args),
                )?;
                let rb = self
                    .client
                    .post(format!("{}/api/services/{domain}/{service}", self.base))
                    .bearer_auth(&self.token)
                    .json(&json!({ "entity_id": entity }));
                http::send("home-assistant", rb).await?;
                Ok(json!({ "ok": true }))
            }
            other => Err(Error::not_supported("home-assistant", other)),
        }
    }
}
