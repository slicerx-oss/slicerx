// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Spoolman filament inventory over its REST API (`/api/v1/spool`).
use std::sync::Arc;

use async_trait::async_trait;
use reqwest::Client;
use serde_json::{Value, json};

use super::strip_prefix;
use crate::error::{Error, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::manifest::{PluginManifest, manifest};
use crate::{ServicePlugin, http};

pub struct SpoolmanPlugin {
    base: String,
    client: Client,
    gate: Arc<dyn ApprovalGate>,
}

impl SpoolmanPlugin {
    /// `base` is the server root, such as `http://host:7912`.
    pub fn new(base: &str, gate: Arc<dyn ApprovalGate>) -> Result<Self> {
        if !base.starts_with("http://") {
            return Err(Error::Config("service URLs must start with http://".to_owned()));
        }
        let client = http::service_client()?;
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            client,
            gate,
        })
    }

    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        let resp = http::send(
            "spoolman",
            self.client.get(format!("{}{path}", self.base)).query(query),
        )
        .await?;
        http::json("spoolman", resp).await
    }
}

/// Maps a Spoolman spool to the shape the app uses (`SpoolFixture` in the TS contract).
pub(crate) fn normalize(s: &Value) -> Value {
    let f = s.get("filament");
    json!({
        "id": s.get("id"),
        "material": f.and_then(|f| f.get("material")),
        "vendor": f.and_then(|f| f.get("vendor")).and_then(|v| v.get("name")),
        "name": f.and_then(|f| f.get("name")),
        "color": f.and_then(|f| f.get("color_hex")).and_then(Value::as_str).map(|c| format!("#{}", c.trim_start_matches('#').to_ascii_lowercase())),
        "remainingG": s.get("remaining_weight"),
        "initialG": s.get("initial_weight").filter(|v| !v.is_null()).or_else(|| f.and_then(|f| f.get("weight"))),
    })
}

#[async_trait]
impl ServicePlugin for SpoolmanPlugin {
    fn manifest(&self) -> PluginManifest {
        manifest("spoolman").unwrap_or_else(|| crate::drivers::prusalink::unreachable_manifest("spoolman"))
    }

    async fn call(&self, tool: &str, args: Value, token: Option<&ApprovalToken>) -> Result<Value> {
        match strip_prefix("spoolman", tool) {
            "list_spools" => {
                let archived = args
                    .get("includeArchived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let v = self
                    .get(
                        "/api/v1/spool",
                        &[("allow_archived", if archived { "true" } else { "false" })],
                    )
                    .await?;
                let material = args.get("material").and_then(Value::as_str);
                let out: Vec<Value> = v
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(normalize)
                    .filter(|s| material.is_none_or(|m| s.get("material").and_then(Value::as_str) == Some(m)))
                    .collect();
                Ok(Value::Array(out))
            }
            "get_spool" => {
                let id = args
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| Error::protocol("spoolman", "id is required"))?;
                Ok(normalize(&self.get(&format!("/api/v1/spool/{id}"), &[]).await?))
            }
            "record_usage" => {
                let id = args
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| Error::protocol("spoolman", "id is required"))?;
                let grams = args
                    .get("grams")
                    .and_then(Value::as_f64)
                    .filter(|g| *g >= 0.0)
                    .ok_or_else(|| Error::protocol("spoolman", "grams must be zero or more"))?;
                let token = token.ok_or_else(|| Error::ApprovalRequired {
                    action: "plugin_call".to_owned(),
                })?;
                self.gate.check(
                    token,
                    Action::PluginCall,
                    "spoolman",
                    &params::plugin("spoolman", "record_usage", &args),
                )?;
                let rb = self
                    .client
                    .put(format!("{}/api/v1/spool/{id}/use", self.base))
                    .json(&json!({ "use_weight": grams }));
                let resp = http::send("spoolman", rb).await?;
                Ok(normalize(&http::json("spoolman", resp).await?))
            }
            other => Err(Error::not_supported("spoolman", other)),
        }
    }
}
