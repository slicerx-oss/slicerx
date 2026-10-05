// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What did not carry over when a preset came in from another slicer: per setting its label, the value it had, why
//! it was left out and the value used instead, with where that value comes from. `js/report.ts` mirrors it.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::diff::format_value;
use crate::import::{import_flat, is_drop_if_percent, is_obsolete, legacy_source, legacy_target};
use crate::schema::{Mode, Section, SettingDef, SettingType, setting_def, settings};
use crate::value::{PrintConfig, Value, to_orca};

#[derive(Deserialize, Default)]
struct NearestKeys {
    orca: BTreeMap<String, String>,
    prusa: BTreeMap<String, String>,
}

#[derive(Deserialize, Default)]
struct NearestFile {
    keys: NearestKeys,
    values: BTreeMap<String, BTreeMap<String, String>>,
    labels: BTreeMap<String, String>,
}

fn nearest() -> &'static NearestFile {
    static FILE: OnceLock<NearestFile> = OnceLock::new();
    FILE.get_or_init(|| serde_json::from_str(include_str!("../import-nearest.json")).unwrap_or_default())
}

/// Which slicer's key names a preset uses: Orca and Bambu Studio share theirs, Prusa has its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyFamily {
    Orca,
    Prusa,
}

/// Why a setting did not carry over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DropReason {
    /// The schema has no such setting.
    Unsupported,
    /// The value does not fit the setting.
    Invalid,
    /// The setting is obsolete.
    Obsolete,
}

impl DropReason {
    fn order(self) -> u8 {
        match self {
            Self::Invalid => 0,
            Self::Unsupported => 1,
            Self::Obsolete => 2,
        }
    }
}

/// Where the value used instead comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValueSource {
    Preset,
    Profile,
    Printer,
    Default,
}

/// A setting that did not carry over, as the file had it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dropped {
    pub key: String,
    pub value: Json,
    pub reason: DropReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub nearest_value: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Instead {
    pub key: String,
    pub label: String,
    pub value: String,
    pub source: ValueSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    pub nearest: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportItem {
    pub key: String,
    pub label: String,
    pub old_value: String,
    pub reason: DropReason,
    pub instead: Option<Instead>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParentRef {
    pub name: String,
    pub found: bool,
    /// The parent came in with the preset (a base filament in the same bundle).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bundled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportReport {
    pub name: String,
    pub section: Section,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<ParentRef>,
    pub items: Vec<ReportItem>,
    pub defaulted: usize,
}

/// One preset in an inherits chain: its own values in the file's form, or a profile already held as a config.
#[derive(Debug, Clone, Default)]
pub struct ImportLayer {
    pub name: String,
    pub raw: Option<BTreeMap<String, Json>>,
    pub config: Option<PrintConfig>,
}

fn is_enum(def: &SettingDef) -> bool {
    matches!(def.kind, SettingType::Enum | SettingType::Enums)
}

fn enum_ok(def: &SettingDef, v: &Value) -> bool {
    if def.enum_values.is_empty() {
        return true;
    }
    let one = |x: &str| {
        def.enum_values.iter().any(|e| e == x)
            || def
                .enum_aliases
                .get(x)
                .is_some_and(|a| def.enum_values.iter().any(|e| e == a))
    };
    match v {
        Value::Str(s) => one(s),
        Value::Strs(list) => list.iter().all(|s| one(s)),
        _ => false,
    }
}

/// Read one preset's own values: `import_flat`, then enum values the schema does not have are dropped, or replaced by
/// the nearest value it has.
#[must_use]
pub fn import_values(raw: &BTreeMap<String, Json>) -> (PrintConfig, Vec<Dropped>) {
    let flat = import_flat(raw);
    let mut config = flat.config;
    let mut dropped: Vec<Dropped> = Vec::new();
    let value_of = |k: &str| raw.get(k).cloned().unwrap_or(Json::Null);
    let raw_key_of = |key: &str| -> String {
        if raw.contains_key(key) {
            key.to_owned()
        } else {
            legacy_source(key, raw).unwrap_or(key).to_owned()
        }
    };
    let drop = |key: String, reason: DropReason, target: Option<String>, nearest_value: bool| Dropped {
        value: value_of(&key),
        key,
        reason,
        target,
        nearest_value,
    };
    // A `nil` value says the old app had nothing set, so nothing is lost.
    let is_nil = |j: &Json| j.as_str() == Some("nil");
    let unset = |k: &str| match raw.get(k) {
        Some(Json::Array(a)) => !a.is_empty() && a.iter().all(is_nil),
        Some(v) => is_nil(v),
        None => false,
    };
    for k in &flat.unknown {
        if !unset(k) {
            dropped.push(drop(k.clone(), DropReason::Unsupported, None, false));
        }
    }
    for k in &flat.ignored {
        if unset(k) {
            continue;
        }
        if is_drop_if_percent(k) {
            let target = legacy_target(k).unwrap_or(k).to_owned();
            dropped.push(drop(k.clone(), DropReason::Invalid, Some(target), false));
        } else {
            let reason = if is_obsolete(k) {
                DropReason::Obsolete
            } else {
                DropReason::Unsupported
            };
            dropped.push(drop(k.clone(), reason, None, false));
        }
    }
    for k in &flat.invalid {
        dropped.push(drop(raw_key_of(k), DropReason::Invalid, Some(k.clone()), false));
    }
    let keys: Vec<String> = config.iter().map(|(k, _)| k.clone()).collect();
    for k in keys {
        let Some(def) = setting_def(&k) else { continue };
        let Some(v) = config.get(&k).cloned() else {
            continue;
        };
        if !is_enum(def) || enum_ok(def, &v) {
            continue;
        }
        let map = nearest().values.get(&k);
        let swap = |x: &str| {
            map.and_then(|m| m.get(x))
                .cloned()
                .unwrap_or_else(|| x.to_owned())
        };
        let near = match &v {
            Value::Str(s) => Value::Str(swap(s)),
            Value::Strs(list) => Value::Strs(list.iter().map(|s| swap(s)).collect()),
            other => other.clone(),
        };
        let rk = raw_key_of(&k);
        if map.is_some() && enum_ok(def, &near) {
            config.set(k.clone(), near);
            dropped.push(drop(rk, DropReason::Invalid, Some(k), true));
        } else {
            config.remove(&k);
            dropped.push(drop(rk, DropReason::Invalid, Some(k), false));
        }
    }
    dropped.sort_by(|a, b| a.key.cmp(&b.key));
    (config, dropped)
}

/// What `import_layers` gives: the merged config, the profile each inherited value comes from, and the child's drops.
#[derive(Debug, Clone, Default)]
pub struct LayersImport {
    pub config: PrintConfig,
    pub origin: BTreeMap<String, String>,
    pub dropped: Vec<Dropped>,
}

/// A list with `nil` entries takes those entries from the value below it, as Orca merges a user preset over its parent.
fn fill_nil(raw: &BTreeMap<String, Json>, below: &PrintConfig) -> BTreeMap<String, Json> {
    let is_nil = |j: &Json| j.as_str() == Some("nil");
    let mut out = raw.clone();
    for (k, v) in raw {
        let Json::Array(items) = v else { continue };
        if !items.iter().any(is_nil) {
            continue;
        }
        let key = if setting_def(k).is_some() {
            k.as_str()
        } else {
            legacy_target(k).unwrap_or(k)
        };
        let (Some(def), Some(prev)) = (setting_def(key), below.get(key)) else {
            continue;
        };
        if !prev.is_list() {
            continue;
        }
        let Json::Array(orca) = to_orca(def, prev) else {
            continue;
        };
        let next: Vec<Json> = items
            .iter()
            .enumerate()
            .map(|(i, x)| match orca.get(i) {
                Some(p) if is_nil(x) => p.clone(),
                _ => x.clone(),
            })
            .collect();
        out.insert(k.clone(), Json::Array(next));
    }
    out
}

/// A preset and the presets it inherits from, child first, into one config. Each layer is read on its own and the
/// results merge root first, so a value the child could not use leaves the parent's in place.
#[must_use]
pub fn import_layers(layers: &[ImportLayer]) -> LayersImport {
    let mut out = LayersImport::default();
    for (i, layer) in layers.iter().enumerate().rev() {
        let values = if let Some(c) = &layer.config {
            c.clone()
        } else {
            let (c, d) = import_values(&fill_nil(
                layer.raw.as_ref().unwrap_or(&BTreeMap::new()),
                &out.config,
            ));
            if i == 0 {
                out.dropped = d;
            }
            c
        };
        for (k, v) in values.iter() {
            out.config.set(k.clone(), v.clone());
            if i == 0 {
                out.origin.remove(k);
            } else {
                out.origin.insert(k.clone(), layer.name.clone());
            }
        }
    }
    out
}

fn word(w: &str) -> String {
    match w {
        "gcode" => "G-code".into(),
        "ams" => "AMS".into(),
        "xy" => "XY".into(),
        "id" => "ID".into(),
        "led" => "LED".into(),
        "ptc" => "PTC".into(),
        "ai" => "AI".into(),
        "pa" => "PA".into(),
        "x" => "X".into(),
        "y" => "Y".into(),
        "z" => "Z".into(),
        "e" => "E".into(),
        other => other.to_owned(),
    }
}

/// A readable name for a setting key: the schema's label, a label kept for keys outside it, or the key's words.
#[must_use]
pub fn setting_label(key: &str) -> String {
    if let Some(def) = setting_def(key) {
        return def.label.clone();
    }
    if let Some(l) = nearest().labels.get(key) {
        return l.clone();
    }
    let text: Vec<String> = key
        .split('_')
        .filter(|w| !w.is_empty())
        .map(|w| word(&w.to_lowercase()))
        .collect();
    let text = text.join(" ");
    let mut chars = text.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// A typed value for a person: enum labels in place of enum values, units, lists that repeat one value once.
#[must_use]
pub fn display_value(def: Option<&SettingDef>, v: Option<&Value>) -> String {
    if let (Some(d), Some(v)) = (def, v)
        && is_enum(d)
        && !d.enum_values.is_empty()
        && !d.enum_labels.is_empty()
    {
        let label = |x: &str| {
            d.enum_values
                .iter()
                .position(|e| e == x)
                .and_then(|i| d.enum_labels.get(i))
                .cloned()
                .unwrap_or_else(|| x.to_owned())
        };
        match v {
            Value::Str(s) => return label(s),
            Value::Strs(list) => {
                return match list.first() {
                    Some(f) if list.iter().all(|x| x == f) => label(f),
                    _ => list.iter().map(|s| label(s)).collect::<Vec<_>>().join(", "),
                };
            }
            _ => {}
        }
    }
    format_value(def, v)
}

fn clip(s: &str) -> String {
    let one: Vec<&str> = s
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    let one = one.join(" ");
    let one = one.trim();
    if one.is_empty() {
        "empty".into()
    } else if one.chars().count() > 60 {
        let head: String = one.chars().take(57).collect();
        format!("{head}...")
    } else {
        one.to_owned()
    }
}

fn raw_text(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Array(_) | Json::Object(_) => v.to_string(),
        other => other.to_string(),
    }
}

/// A value as the file wrote it, for a person: lists that repeat one value once, long text cut short.
#[must_use]
pub fn display_raw(v: &Json) -> String {
    match v {
        Json::Null => "not set".into(),
        Json::Array(a) => match a.first() {
            Some(f) if !f.is_object() && !f.is_array() && a.iter().all(|x| x == f) => display_raw(f),
            _ => clip(&a.iter().map(raw_text).collect::<Vec<_>>().join(", ")),
        },
        other => clip(&raw_text(other)),
    }
}

/// What `build_report` reads.
pub struct ReportInput<'a> {
    pub name: &'a str,
    pub section: Section,
    pub family: KeyFamily,
    pub dropped: &'a [Dropped],
    /// What the preset became: its own values over those of the profiles it inherits from.
    pub config: &'a PrintConfig,
    /// Inherited keys, by the name of the profile their value comes from.
    pub origin: &'a BTreeMap<String, String>,
    /// The printer profile that fills what the preset does not set: its name and config.
    pub printer: Option<(&'a str, &'a PrintConfig)>,
    pub parent: Option<ParentRef>,
    pub defaulted: usize,
}

/// The report of one imported preset. Items are sorted by reason, then label.
#[must_use]
pub fn build_report(input: &ReportInput<'_>) -> ImportReport {
    let instead_for = |key: &str, near: bool| -> Option<Instead> {
        let def = setting_def(key)?;
        let base = |value: String, source: ValueSource, from: Option<String>| Instead {
            key: key.to_owned(),
            label: def.label.clone(),
            value,
            source,
            from,
            nearest: near,
        };
        if let Some(own) = input.config.get(key) {
            let value = display_value(Some(def), Some(own));
            return Some(match input.origin.get(key) {
                Some(from) => base(value, ValueSource::Profile, Some(from.clone())),
                None => base(value, ValueSource::Preset, None),
            });
        }
        if let Some((name, cfg)) = input.printer
            && let Some(p) = cfg.get(key)
        {
            return Some(base(
                display_value(Some(def), Some(p)),
                ValueSource::Printer,
                Some(name.to_owned()),
            ));
        }
        let dv = Value::from_json(&def.default);
        Some(base(
            display_value(Some(def), dv.as_ref()),
            ValueSource::Default,
            None,
        ))
    };
    let keys = match input.family {
        KeyFamily::Orca => &nearest().keys.orca,
        KeyFamily::Prusa => &nearest().keys.prusa,
    };
    let mut items: Vec<ReportItem> = input
        .dropped
        .iter()
        .map(|d| {
            let target = d.target.clone().or_else(|| keys.get(&d.key).cloned());
            let near = if d.target.is_none() {
                target.is_some()
            } else {
                d.nearest_value
            };
            let label_key = d.target.as_deref().unwrap_or(&d.key);
            ReportItem {
                key: d.key.clone(),
                label: setting_label(label_key),
                old_value: display_raw(&d.value),
                reason: d.reason,
                instead: target.and_then(|t| instead_for(&t, near)),
            }
        })
        .collect();
    items.sort_by(|a, b| {
        a.reason
            .order()
            .cmp(&b.reason.order())
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
            .then_with(|| a.key.cmp(&b.key))
    });
    ImportReport {
        name: input.name.to_owned(),
        section: input.section,
        parent: input.parent.clone(),
        items,
        defaulted: input.defaulted,
    }
}

/// How many settings of a kind a config leaves to the printer profile (hidden settings are not counted).
#[must_use]
pub fn count_defaulted(section: Section, config: &PrintConfig) -> usize {
    settings()
        .iter()
        .filter(|d| d.section == section && d.mode != Mode::Hidden && !config.contains(&d.key))
        .count()
}
