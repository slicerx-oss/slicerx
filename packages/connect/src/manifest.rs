// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
use serde::{Deserialize, Serialize};

use crate::types::Capability;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Printer,
    Inventory,
    Home,
}

/// Permission class of a tool. Mirrors `PermissionClass` in `packages/contracts/src/pilot.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionClass {
    Read,
    Slice,
    Queue,
    Start,
    Profile,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub permission: PermissionClass,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: PluginKind,
    pub protocols: Vec<String>,
    pub capabilities: Vec<Capability>,
    pub tools: Vec<ToolSpec>,
    /// Hosts and ports the plugin may reach, such as `lan:8883`.
    pub network: Vec<String>,
}

const MANIFESTS: &str = include_str!("../manifests.json");

/// All first-party manifests. `manifests.json` is the single source: `@slicerx/fleet-sim`
/// serves the same file.
pub fn all_manifests() -> Vec<PluginManifest> {
    // The file is embedded at build time and checked by `manifests_parse` below.
    serde_json::from_str(MANIFESTS).unwrap_or_default()
}

pub fn manifest(id: &str) -> Option<PluginManifest> {
    all_manifests().into_iter().find(|m| m.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifests_parse() {
        let all: Vec<PluginManifest> = serde_json::from_str(MANIFESTS).unwrap();
        assert_eq!(all.len(), 11);
        for m in &all {
            for t in &m.tools {
                assert!(t.name.starts_with(&format!("{}.", m.id)), "{} prefix", t.name);
            }
        }
    }
}
