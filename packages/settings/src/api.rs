// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! JSON in, JSON out entry points for callers that do not link the typed API: a CLI, a C ABI, an MCP
//! server or a script. Every function takes one JSON text and returns one JSON text, in the same
//! shapes as the TypeScript package (`SettingsPlan`, `SettingIssue`, `PrintConfig`).

use std::collections::BTreeSet;

use serde::de::DeserializeOwned;
use serde_json::{Value as Json, json};

use crate::auto::resolve_auto;
use crate::easy::{EasySettings, apply_easy};
use crate::error::Error;
use crate::import::{export_orca, import_orca};
use crate::plan::{
    CalibrationResult, PlanIntent, PlanOptions, SettingsPlan, SetupRef, apply_plan, plan_settings,
};
use crate::project::import_project;
use crate::schema::Section;
use crate::validate::{validate, validate_for};
use crate::value::PrintConfig;

fn parse(text: &str) -> Result<Json, Error> {
    serde_json::from_str(text).map_err(|e| Error::Request(e.to_string()))
}

fn field<T: DeserializeOwned>(j: &Json, name: &str) -> Result<T, Error> {
    let v = j
        .get(name)
        .ok_or_else(|| Error::Request(format!("missing \"{name}\"")))?;
    serde_json::from_value(v.clone()).map_err(|e| Error::Request(format!("\"{name}\": {e}")))
}

fn optional<T: DeserializeOwned>(j: &Json, name: &str) -> Result<Option<T>, Error> {
    match j.get(name) {
        None | Some(Json::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| Error::Request(format!("\"{name}\": {e}"))),
    }
}

fn config_of(j: &Json, name: &str) -> Result<PrintConfig, Error> {
    match j.get(name) {
        Some(v @ Json::Object(_)) => Ok(PrintConfig::from_json(v)),
        Some(_) => Err(Error::Request(format!("\"{name}\" must be an object"))),
        None => Err(Error::Request(format!("missing \"{name}\""))),
    }
}

fn out(j: &Json) -> String {
    j.to_string()
}

/// Plan a switch. Request: `{ "from": SetupRef, "to": SetupRef, "base"?: PrintConfig, "options"?: { "target"?,
/// "tuned"?: [key], "keep"?: [key], "calibrations"?: [CalibrationResult], "intent"?: { "goals": [...] } } }`.
/// Returns the `SettingsPlan` as JSON.
pub fn plan_json(request: &str) -> Result<String, Error> {
    let j = parse(request)?;
    let from: SetupRef = field(&j, "from")?;
    let to: SetupRef = field(&j, "to")?;
    let base = match j.get("base") {
        None | Some(Json::Null) => None,
        Some(_) => Some(config_of(&j, "base")?),
    };
    let mut opts = PlanOptions::default();
    if let Some(o) = j.get("options").filter(|o| o.is_object()) {
        if o.get("target").is_some_and(Json::is_object) {
            opts.target = Some(config_of(o, "target")?);
        }
        opts.tuned = optional::<Vec<String>>(o, "tuned")?
            .unwrap_or_default()
            .into_iter()
            .collect::<BTreeSet<_>>();
        opts.keep = optional::<Vec<String>>(o, "keep")?
            .unwrap_or_default()
            .into_iter()
            .collect::<BTreeSet<_>>();
        opts.calibrations = optional::<Vec<CalibrationResult>>(o, "calibrations")?.unwrap_or_default();
        opts.intent = optional::<PlanIntent>(o, "intent")?;
    }
    Ok(out(&plan_settings(&from, &to, base.as_ref(), &opts).to_json()))
}

/// Apply a plan to a config. Request: `{ "config": PrintConfig, "plan": SettingsPlan, "includeRead"?: bool }`.
/// Returns the new `PrintConfig` as JSON.
pub fn apply_plan_json(request: &str) -> Result<String, Error> {
    let j = parse(request)?;
    let config = config_of(&j, "config")?;
    let plan = j
        .get("plan")
        .ok_or_else(|| Error::Request("missing \"plan\"".to_owned()))?;
    let include_read = j.get("includeRead").and_then(Json::as_bool).unwrap_or(false);
    let changes = SettingsPlan::changes_from_json(plan);
    Ok(out(&apply_plan(&config, &changes, include_read).to_json()))
}

/// Validate a config. Request: a `PrintConfig` object, or `{ "config": PrintConfig, "filament"?: id }` to
/// use a material's research. Returns the list of `SettingIssue`, errors first.
pub fn validate_json(config: &str) -> Result<String, Error> {
    let j = parse(config)?;
    if !j.is_object() {
        return Err(Error::Request("config must be an object".to_owned()));
    }
    let issues = match j.get("config").filter(|c| c.is_object()) {
        Some(c) => validate_for(
            &PrintConfig::from_json(c),
            j.get("filament").and_then(Json::as_str),
        ),
        None => validate(&PrintConfig::from_json(&j)),
    };
    serde_json::to_string(&issues).map_err(|e| Error::Request(e.to_string()))
}

/// Apply Easy mode. Request: `{ "easy": EasySettings, "base": PrintConfig }`. Returns the new config.
pub fn apply_easy_json(request: &str) -> Result<String, Error> {
    let j = parse(request)?;
    let easy: EasySettings = field(&j, "easy")?;
    let base = config_of(&j, "base")?;
    Ok(out(&apply_easy(&easy, &base).to_json()))
}

/// Resolve automatic values. Request: `{ "config": PrintConfig, "nozzleDiameter"?: number }`.
pub fn resolve_auto_json(request: &str) -> Result<String, Error> {
    let j = parse(request)?;
    let config = config_of(&j, "config")?;
    let nozzle = j.get("nozzleDiameter").and_then(Json::as_f64);
    Ok(out(&resolve_auto(&config, nozzle).to_json()))
}

/// Import a user supplied Orca or Bambu profile with its `inherits` chain resolved. Request:
/// `{ "profile": <profile JSON>, "parents": [<profile JSON>, ...] }`; parents are found by their `name`.
/// Returns the `ProfileImport` (config, chain, unknownKeys, ignoredKeys, nilKeys, invalidKeys).
pub fn import_profile_json(request: &str) -> Result<String, Error> {
    let j = parse(request)?;
    let profile = j
        .get("profile")
        .ok_or_else(|| Error::Request("missing \"profile\"".to_owned()))?;
    let parents: std::collections::HashMap<String, Json> = j
        .get("parents")
        .and_then(Json::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| Some((p.get("name")?.as_str()?.to_owned(), p.clone())))
                .collect()
        })
        .unwrap_or_default();
    let imported = import_orca(profile, &|name| parents.get(name).cloned())?;
    serde_json::to_string(&imported).map_err(|e| Error::Request(e.to_string()))
}

/// Read the settings of a Bambu Studio or Orca project. Request: `{ "projectSettings": <Metadata/project_settings.config
/// JSON>, "modelSettings"?: <text of Metadata/model_settings.config>, "layerRanges"?: <text of Metadata/layer_config_ranges.xml> }`.
/// Unzipping the .3mf is the caller's job. Returns the `ProjectImport`.
pub fn import_project_json(request: &str) -> Result<String, Error> {
    let j = parse(request)?;
    let settings = j
        .get("projectSettings")
        .ok_or_else(|| Error::Request("missing \"projectSettings\"".to_owned()))?;
    let imported = import_project(
        settings,
        j.get("modelSettings").and_then(Json::as_str),
        j.get("layerRanges").and_then(Json::as_str),
    )?;
    serde_json::to_string(&imported).map_err(|e| Error::Request(e.to_string()))
}

/// Write a config as an Orca profile. Request: `{ "config": PrintConfig, "meta": { "name", "section", "inherits"? } }`.
pub fn export_profile_json(request: &str) -> Result<String, Error> {
    let j = parse(request)?;
    let config = config_of(&j, "config")?;
    let meta = j
        .get("meta")
        .ok_or_else(|| Error::Request("missing \"meta\"".to_owned()))?;
    let name: String = field(meta, "name")?;
    let section: Section = field(meta, "section")?;
    let inherits: Option<String> = optional(meta, "inherits")?;
    Ok(out(&export_orca(&config, &name, section, inherits.as_deref())))
}

/// The knowledge ids a request can use: `{ "materials": [{id, name}], "printers": [...], "goals": [{id, label, levels}] }`.
#[must_use]
pub fn catalog_json() -> String {
    use crate::plan::{list_goals, list_materials, list_printers};
    out(&json!({
        "materials": list_materials().into_iter().map(|(id, name)| json!({"id": id, "name": name})).collect::<Vec<_>>(),
        "printers": list_printers().into_iter().map(|(id, name)| json!({"id": id, "name": name})).collect::<Vec<_>>(),
        "goals": list_goals().into_iter().map(|(id, label, levels)| json!({"id": id, "label": label, "levels": levels})).collect::<Vec<_>>(),
    }))
}
