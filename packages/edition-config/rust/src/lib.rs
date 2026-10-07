// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The edition configuration for Rust services (the cloud service, `sx-link`).
//!
//! TypeScript (`@slicerx/edition-config`) owns the schema and the defaults. Deployments run
//! `edition-config resolve <file> > slicerx.config.json`, and Rust reads that resolved JSON with
//! every field present, applies the same `SLICERX_*` environment overrides and checks the same
//! rules. Unknown fields are rejected, so a schema change without a matching change here fails
//! the shared fixture tests instead of being ignored.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cannot read edition config {path}: {source}")]
    Read { path: String, source: std::io::Error },
    #[error("edition config is not valid JSON for schema version {SCHEMA_VERSION}: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("invalid edition config:\n{}", .0.iter().map(|i| format!("  {i}")).collect::<Vec<_>>().join("\n"))]
    Invalid(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditionConfig {
    pub schema_version: u32,
    pub id: String,
    pub brand: Brand,
    pub apps: Apps,
    pub backend: Backend,
    pub features: Features,
    pub auth: Auth,
    pub ai: Ai,
    pub legal: Legal,
    pub funding: Funding,
    pub downloads: Downloads,
    pub library: LibraryConfig,
    pub routes: Routes,
    pub first_run: FirstRun,
    /// Older resolved files have no release section; they read as a stable build.
    #[serde(default)]
    pub release: Release,
    /// Older resolved files have no bugs section; upstream crash reports are off.
    #[serde(default)]
    pub bugs: Bugs,
    /// Older resolved files have no links; the `SlicerX` pages stand in.
    #[serde(default)]
    pub links: Links,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Brand {
    pub name: String,
    pub short_name: Option<String>,
    pub tagline: Option<String>,
    pub description: Option<String>,
    pub logo: Logo,
    pub theme: Theme,
    pub support_email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Logo {
    pub mark: String,
    pub wordmark: Option<String>,
    pub app_icon: Option<String>,
}

/// A theme id, or token overrides on a base theme. Services only pass it through.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Theme {
    Id(String),
    Custom { base: String, tokens: serde_json::Value },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Apps {
    pub web: WebApp,
    pub desktop: DesktopApp,
    pub ios: Option<IosApp>,
    pub android: Option<AndroidApp>,
    pub deep_link_scheme: String,
    pub universal_link_domains: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebApp {
    pub origin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopApp {
    pub identifier: String,
    pub product_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IosApp {
    pub bundle_id: String,
    pub team_id: Option<String>,
    pub app_store_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AndroidApp {
    pub application_id: String,
    pub sha256_cert_fingerprints: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Backend {
    pub supabase: Option<Supabase>,
    pub cloud_api: Option<String>,
    pub relay: Option<String>,
    pub link_port: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Supabase {
    pub url: String,
    /// Public by design. The service role key never goes in this file.
    pub anon_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(clippy::struct_excessive_bools)] // one switch per feature is the point of this struct
pub struct Features {
    pub store: bool,
    pub feed: bool,
    pub creators: bool,
    pub cloud_slicing: bool,
    pub phone_pairing: bool,
    pub pilot: bool,
    /// Set up local AI. Configs resolved before it existed have it on.
    #[serde(default = "on")]
    pub local_ai: bool,
    /// The modeling tools (packages/edition-config/src/schema.ts, `features.cad`). Configs resolved before it
    /// existed have it on.
    #[serde(default = "on")]
    pub cad: bool,
    pub demo_data: bool,
    /// Printer family (`bambu`, `moonraker`, ...) to enabled.
    pub printers: BTreeMap<String, bool>,
}

impl Features {
    /// A family missing from the map counts as enabled, as in the TypeScript defaults.
    pub fn printer(&self, family: &str) -> bool {
        self.printers.get(family).copied().unwrap_or(true)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Auth {
    pub providers: Vec<AuthProvider>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthProvider {
    pub kind: String,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ai {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub key_source: String,
    /// Local model ids Set up local AI may offer; none means all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_local_models: Option<Vec<String>>,
}

fn on() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Legal {
    pub terms: Option<String>,
    pub privacy: Option<String>,
    pub imprint: Option<String>,
    pub source_url: Option<String>,
    pub trademark_notice: Option<String>,
    pub attribution: Option<Attribution>,
    pub license: Option<String>,
    pub publisher: Option<String>,
    pub copyright: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attribution {
    pub text: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Funding {
    pub pay_what_you_want: Option<String>,
    pub buy_me_a_coffee: Option<String>,
    pub github_sponsors: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Downloads {
    pub manifest_url: Option<String>,
    pub app_store_url: Option<String>,
    pub google_play_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryConfig {
    pub moderation: Moderation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Moderation {
    /// `owner-approves-all`, `moderators`, `trusted-creators` or `auto-after-scan`.
    pub mode: String,
    pub max_file_mb: u32,
    /// Subset of `3mf`, `sx3mf`, `stl`.
    pub allowed_formats: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Routes {
    pub landing: String,
    pub studio: String,
    pub login: String,
    pub creators: String,
    pub creator: String,
    pub dashboard: String,
    pub moderation: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FirstRun {
    /// `slicerx`, `bambu-studio`, `prusaslicer` or `orcaslicer`.
    pub default_look: String,
    /// Motion until the person picks: `system`, `full` or `reduced`. Configs resolved before it
    /// existed have `full`, the TypeScript default.
    #[serde(default = "full_motion")]
    pub default_motion: String,
}

fn full_motion() -> String {
    "full".to_owned()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    /// `pre-alpha`, `alpha`, `beta` or `stable`.
    pub stage: String,
    pub bug_reports_url: Option<String>,
    /// In-app desktop updates (packages/edition-config/src/schema.ts, `release.updates`). Unset, the desktop app
    /// never looks for updates.
    pub updates: Option<Updates>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Updates {
    /// Where the update manifest is served, tried in order.
    pub endpoints: Vec<String>,
    /// The public half of the edition's update signing key.
    pub pubkey: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bugs {
    /// Also send crash reports to the `SlicerX` project, with the edition id in the title.
    pub upstream: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Links {
    pub docs: Option<String>,
    pub support: Option<String>,
    pub download: Option<String>,
}

impl Default for Release {
    fn default() -> Self {
        Self {
            stage: "stable".into(),
            bug_reports_url: None,
            updates: None,
        }
    }
}

/// Edition features `SLICERX_FEATURES` may name, in the TypeScript order.
pub const FEATURES: [&str; 6] = [
    "store",
    "feed",
    "creators",
    "cloudSlicing",
    "phonePairing",
    "pilot",
];

/// Sign-in providers `SLICERX_AUTH_PROVIDERS` may name.
pub const AUTH_KINDS: [&str; 5] = ["email", "github", "google", "apple", "discord"];

impl EditionConfig {
    /// Parses resolved JSON and checks the rules.
    pub fn from_json(json: &str) -> Result<Self, Error> {
        let config: Self = serde_json::from_str(json)?;
        config.validate()?;
        Ok(config)
    }

    /// Reads `SLICERX_CONFIG` (default `slicerx.config.json`), applies `SLICERX_*` overrides from
    /// `env`, and checks the rules.
    pub fn load(env: &dyn Fn(&str) -> Option<String>) -> Result<Self, Error> {
        let path = env("SLICERX_CONFIG").unwrap_or_else(|| "slicerx.config.json".to_owned());
        let text =
            std::fs::read_to_string(Path::new(&path)).map_err(|source| Error::Read { path, source })?;
        let mut config: Self = serde_json::from_str(&text)?;
        config.apply_env(env)?;
        config.validate()?;
        Ok(config)
    }

    /// The same overrides as `envLayer()` in TypeScript.
    pub fn apply_env(&mut self, env: &dyn Fn(&str) -> Option<String>) -> Result<(), Error> {
        let url = env("SLICERX_SUPABASE_URL");
        let key = env("SLICERX_SUPABASE_ANON_KEY");
        if url.is_some() || key.is_some() {
            let current = self.backend.supabase.take();
            self.backend.supabase = Some(Supabase {
                url: url
                    .or_else(|| current.as_ref().map(|s| s.url.clone()))
                    .unwrap_or_default(),
                anon_key: key.or_else(|| current.map(|s| s.anon_key)).unwrap_or_default(),
            });
        }
        if let Some(v) = env("SLICERX_CLOUD_API_URL") {
            self.backend.cloud_api = Some(v);
        }
        if let Some(v) = env("SLICERX_RELAY_URL") {
            self.backend.relay = Some(v);
        }
        if let Some(v) = env("SLICERX_LINK_PORT") {
            self.backend.link_port = v
                .parse()
                .map_err(|_| Error::Invalid(vec![format!("SLICERX_LINK_PORT: not a port: {v}")]))?;
        }
        if let Some(list) = env("SLICERX_FEATURES") {
            let on: Vec<&str> = list.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
            let unknown: Vec<&str> = on.iter().copied().filter(|f| !FEATURES.contains(f)).collect();
            if !unknown.is_empty() {
                return Err(Error::Invalid(vec![format!(
                    "SLICERX_FEATURES has unknown feature(s): {}",
                    unknown.join(", ")
                )]));
            }
            let has = |f: &str| on.contains(&f);
            let f = &mut self.features;
            f.store = has("store");
            f.feed = has("feed");
            f.creators = has("creators");
            f.cloud_slicing = has("cloudSlicing");
            f.phone_pairing = has("phonePairing");
            f.pilot = has("pilot");
        }
        self.apply_auth_env(env)?;
        if let Some(team) = env("SLICERX_APPLE_TEAM_ID") {
            match &mut self.apps.ios {
                Some(ios) => ios.team_id = Some(team),
                None => {
                    return Err(Error::Invalid(vec![
                        "SLICERX_APPLE_TEAM_ID: the config has no apps.ios".to_owned(),
                    ]));
                }
            }
        }
        if let Some(v) = env("SLICERX_AI_PROVIDER") {
            self.ai.provider = v;
        }
        if let Some(v) = env("SLICERX_AI_MODEL") {
            self.ai.model = v;
        }
        if let Some(v) = env("SLICERX_AI_BASE_URL") {
            self.ai.base_url = Some(v);
        }
        Ok(())
    }

    /// `SLICERX_AUTH_PROVIDERS` and `SLICERX_AUTH_<KIND>_CLIENT_ID`, as in `envLayer()`.
    fn apply_auth_env(&mut self, env: &dyn Fn(&str) -> Option<String>) -> Result<(), Error> {
        let client_id = |kind: &str| env(&format!("SLICERX_AUTH_{}_CLIENT_ID", kind.to_ascii_uppercase()));
        let listed = env("SLICERX_AUTH_PROVIDERS");
        let any_client_id = AUTH_KINDS.iter().any(|k| *k != "email" && client_id(k).is_some());
        if listed.is_none() && !any_client_id {
            return Ok(());
        }
        let kinds: Vec<String> = match &listed {
            Some(list) => list
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            None => self.auth.providers.iter().map(|p| p.kind.clone()).collect(),
        };
        let unknown: Vec<&str> = kinds
            .iter()
            .map(String::as_str)
            .filter(|k| !AUTH_KINDS.contains(k))
            .collect();
        if !unknown.is_empty() {
            return Err(Error::Invalid(vec![format!(
                "SLICERX_AUTH_PROVIDERS has unknown provider(s): {}",
                unknown.join(", ")
            )]));
        }
        let mut providers = Vec::with_capacity(kinds.len());
        for kind in kinds {
            if kind == "email" {
                providers.push(AuthProvider {
                    kind,
                    client_id: None,
                });
                continue;
            }
            let id = client_id(&kind).or_else(|| {
                self.auth
                    .providers
                    .iter()
                    .find(|p| p.kind == kind)
                    .and_then(|p| p.client_id.clone())
            });
            let Some(id) = id else {
                return Err(Error::Invalid(vec![format!(
                    "sign-in provider {kind} needs SLICERX_AUTH_{}_CLIENT_ID",
                    kind.to_ascii_uppercase()
                )]));
            };
            providers.push(AuthProvider {
                kind,
                client_id: Some(id),
            });
        }
        self.auth.providers = providers;
        Ok(())
    }

    /// The dependency and secret rules from the TypeScript schema. Format checks (URLs, ids)
    /// happen once, in `edition-config resolve`.
    pub fn validate(&self) -> Result<(), Error> {
        let mut issues = Vec::new();
        let f = &self.features;
        let mut need = |on: bool, ok: bool, msg: &str| {
            if on && !ok {
                issues.push(msg.to_owned());
            }
        };
        need(
            self.schema_version != SCHEMA_VERSION,
            false,
            "schemaVersion: unsupported version",
        );
        need(f.feed, f.store, "features.feed: feed needs store");
        need(
            f.creators,
            f.store,
            "features.creators: creators needs store (uploads come from the library)",
        );
        need(
            f.store && !f.demo_data,
            self.backend.supabase.is_some(),
            "backend.supabase: store needs backend.supabase (or features.demoData for the bundled demo catalog)",
        );
        need(
            f.cloud_slicing,
            self.backend.cloud_api.is_some(),
            "backend.cloudApi: cloudSlicing needs backend.cloudApi",
        );
        need(
            f.phone_pairing,
            self.backend.relay.is_some(),
            "backend.relay: phonePairing needs backend.relay",
        );
        need(
            f.pilot && self.ai.key_source == "cloud",
            self.backend.cloud_api.is_some(),
            "ai.keySource: keySource 'cloud' needs backend.cloudApi",
        );
        need(
            f.pilot,
            self.ai.provider != "none",
            "ai.provider: pilot needs an AI provider other than 'none'",
        );
        // Every build ships the AGPL-3.0 stock profiles; only SlicerX and the reference build link SlicerX's source.
        let fork = self.id != "slicerx" && self.id != "reference";
        let edition = fork || f.store || f.feed || f.creators || f.cloud_slicing || f.phone_pairing;
        need(
            edition,
            self.legal.source_url.is_some(),
            "legal.sourceUrl: edition builds ship the AGPL-3.0 stock profiles: set legal.sourceUrl so users can get the source (section 13)",
        );
        if let Some(s) = &self.backend.supabase {
            if s.url.is_empty() || s.anon_key.len() < 20 {
                issues.push("backend.supabase: url and anonKey are both required".to_owned());
            }
            if s.anon_key.starts_with("sb_secret_") {
                issues.push(
                    "backend.supabase.anonKey: this is a Supabase secret key (sb_secret_); use the publishable or anon key"
                        .to_owned(),
                );
            }
            if jwt_role(&s.anon_key).as_deref() == Some("service_role") {
                issues.push(
                    "backend.supabase.anonKey: this is a service role key; use the anon key".to_owned(),
                );
            }
        }
        if issues.is_empty() {
            Ok(())
        } else {
            Err(Error::Invalid(issues))
        }
    }
}

/// The `role` claim of a JWT, without verifying it (only to refuse service role keys).
fn jwt_role(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64url_decode(payload)?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("role")?.as_str().map(str::to_owned)
}

fn base64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.bytes().take_while(|&c| c != b'=') {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        };
        buf = (buf << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buf >> bits) & 0xff).ok()?);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{}/../fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    #[test]
    fn reads_the_resolved_fixtures() {
        let neutral = EditionConfig::from_json(&fixture("neutral.resolved.json")).unwrap();
        assert_eq!(neutral.id, "reference");
        assert!(!neutral.features.store);
        let harbor = EditionConfig::from_json(&fixture("fork-harbor.resolved.json")).unwrap();
        assert_eq!(harbor.apps.desktop.identifier, "com.harborprint.slice");
        assert!(!harbor.features.printer("duet"));
        assert!(harbor.features.printer("bambu"));
    }

    // The Motion setting added firstRun.defaultMotion to the TypeScript schema; sx-cloud refused
    // every resolved config with it ("unknown field `defaultMotion`") and did not start.
    /// The neutral fixture as a JSON value, `edit` applied.
    fn neutral_with(edit: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut v: serde_json::Value = serde_json::from_str(&fixture("neutral.resolved.json")).unwrap();
        edit(&mut v);
        v.to_string()
    }

    #[test]
    fn bugs_upstream_is_off_in_older_configs_and_read_when_present() {
        let older = neutral_with(|v| {
            v.as_object_mut().unwrap().remove("bugs");
        });
        assert!(!EditionConfig::from_json(&older).unwrap().bugs.upstream);
        let with = neutral_with(|v| v["bugs"] = serde_json::json!({ "upstream": true }));
        assert!(EditionConfig::from_json(&with).unwrap().bugs.upstream);
    }

    #[test]
    fn first_run_reads_default_motion_and_older_configs_without_it() {
        let with = neutral_with(|v| v["firstRun"]["defaultMotion"] = serde_json::json!("reduced"));
        assert_eq!(
            EditionConfig::from_json(&with).unwrap().first_run.default_motion,
            "reduced"
        );
        let older = neutral_with(|v| {
            v["firstRun"].as_object_mut().unwrap().remove("defaultMotion");
        });
        assert_eq!(
            EditionConfig::from_json(&older).unwrap().first_run.default_motion,
            "full"
        );
    }

    // features.cad reached the TypeScript schema first and sx-cloud refused every resolved config with it.
    #[test]
    fn the_modeling_tools_switch_is_read_and_on_in_older_configs() {
        let off = neutral_with(|v| v["features"]["cad"] = serde_json::json!(false));
        assert!(!EditionConfig::from_json(&off).unwrap().features.cad);
        let older = neutral_with(|v| {
            v["features"].as_object_mut().unwrap().remove("cad");
        });
        assert!(EditionConfig::from_json(&older).unwrap().features.cad);
        assert!(
            EditionConfig::from_json(&fixture("neutral.resolved.json"))
                .unwrap()
                .features
                .cad
        );
    }

    // release.updates reached the TypeScript schema first and sx-cloud refused the SlicerX edition's config with it.
    #[test]
    fn an_update_feed_is_read_and_absent_in_older_configs() {
        let with = neutral_with(|v| {
            v["release"]["updates"] =
                serde_json::json!({ "endpoints": ["https://example.com/latest.json"], "pubkey": "a2V5" });
        });
        let updates = EditionConfig::from_json(&with).unwrap().release.updates.unwrap();
        assert_eq!(updates.endpoints, ["https://example.com/latest.json"]);
        assert_eq!(updates.pubkey, "a2V5");
        assert_eq!(
            EditionConfig::from_json(&fixture("neutral.resolved.json"))
                .unwrap()
                .release
                .updates,
            None
        );
    }

    #[test]
    fn local_ai_is_on_when_an_older_config_leaves_it_out() {
        let mut v: serde_json::Value = serde_json::from_str(&fixture("neutral.resolved.json")).unwrap();
        v["features"].as_object_mut().unwrap().remove("localAi");
        let c = EditionConfig::from_json(&v.to_string()).unwrap();
        assert!(c.features.local_ai);
        assert_eq!(c.ai.allowed_local_models, None);
        v["features"]["localAi"] = serde_json::json!(false);
        v["ai"]["allowedLocalModels"] = serde_json::json!(["qwen-2.5-7b"]);
        let c = EditionConfig::from_json(&v.to_string()).unwrap();
        assert!(!c.features.local_ai);
        assert_eq!(c.ai.allowed_local_models, Some(vec!["qwen-2.5-7b".to_owned()]));
    }

    #[test]
    fn rejects_unknown_fields() {
        let mut v: serde_json::Value = serde_json::from_str(&fixture("neutral.resolved.json")).unwrap();
        v["surprise"] = serde_json::json!(true);
        assert!(matches!(
            EditionConfig::from_json(&v.to_string()),
            Err(Error::Parse(_))
        ));
    }

    #[test]
    fn applies_env_and_checks_rules() {
        let mut c = EditionConfig::from_json(&fixture("neutral.resolved.json")).unwrap();
        let env = |k: &str| match k {
            "SLICERX_FEATURES" => Some("feed,pilot".to_owned()),
            "SLICERX_AI_MODEL" => Some("gpt-6-luna".to_owned()),
            _ => None,
        };
        c.apply_env(&env).unwrap();
        assert_eq!(c.ai.model, "gpt-6-luna");
        let Err(Error::Invalid(issues)) = c.validate() else {
            panic!("expected issues")
        };
        assert!(issues.iter().any(|i| i.contains("feed needs store")));
        let bad = |k: &str| (k == "SLICERX_FEATURES").then(|| "shop".to_owned());
        assert!(c.apply_env(&bad).is_err());
    }

    #[test]
    fn reads_auth_from_env() {
        let mut c = EditionConfig::from_json(&fixture("fork-harbor.resolved.json")).unwrap();
        let env = |k: &str| match k {
            "SLICERX_AUTH_PROVIDERS" => Some("email,github".to_owned()),
            "SLICERX_AUTH_GITHUB_CLIENT_ID" => Some("gh-123".to_owned()),
            "SLICERX_APPLE_TEAM_ID" => Some("ZYXWV98765".to_owned()),
            _ => None,
        };
        c.apply_env(&env).unwrap();
        assert_eq!(c.auth.providers.len(), 2);
        assert_eq!(c.auth.providers[1].client_id.as_deref(), Some("gh-123"));
        assert_eq!(
            c.apps.ios.as_ref().unwrap().team_id.as_deref(),
            Some("ZYXWV98765")
        );
        let missing = |k: &str| (k == "SLICERX_AUTH_PROVIDERS").then(|| "email,apple".to_owned());
        assert!(c.apply_env(&missing).is_err());
    }

    #[test]
    fn refuses_service_role_keys() {
        let mut c = EditionConfig::from_json(&fixture("fork-harbor.resolved.json")).unwrap();
        // {"role":"service_role"} in base64url
        c.backend.supabase = Some(Supabase {
            url: "https://x.supabase.co".into(),
            anon_key: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig".into(),
        });
        let Err(Error::Invalid(issues)) = c.validate() else {
            panic!("expected issues")
        };
        assert!(issues.iter().any(|i| i.contains("service role")));
    }

    #[test]
    fn refuses_supabase_secret_keys() {
        let mut c = EditionConfig::from_json(&fixture("fork-harbor.resolved.json")).unwrap();
        c.backend.supabase = Some(Supabase {
            url: "https://x.supabase.co".into(),
            anon_key: "sb_secret_0123456789abcdefghijklmnop".into(),
        });
        let Err(Error::Invalid(issues)) = c.validate() else {
            panic!("expected issues")
        };
        assert!(issues.iter().any(|i| i.contains("sb_secret_")));
    }
}
