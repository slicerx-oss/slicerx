// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Orca and Bambu Studio profile JSON to a typed `PrintConfig`, with `inherits` resolved.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::error::Error;
use crate::schema::{Section, setting_def, settings};
use crate::value::{Coerced, PrintConfig, coerce, to_orca};

#[derive(Deserialize)]
struct ValueMap {
    key: String,
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct Legacy {
    meta: Vec<String>,
    rename: HashMap<String, String>,
    #[serde(default)]
    rename_also: HashMap<String, Vec<String>>,
    value_map: Vec<ValueMap>,
    drop_if_percent: Vec<String>,
    obsolete: Vec<String>,
    foreign: Vec<String>,
}

struct Rules {
    meta: HashSet<String>,
    rename: HashMap<String, String>,
    /// More of our keys an older key sets (Bambu Studio's `wall_filament` is both walls).
    rename_also: HashMap<String, Vec<String>>,
    value_map: Vec<ValueMap>,
    drop_if_percent: HashSet<String>,
    ignored: HashSet<String>,
    obsolete: HashSet<String>,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let l: Legacy = serde_json::from_str(include_str!("../legacy.json")).unwrap_or(Legacy {
            meta: Vec::new(),
            rename: HashMap::new(),
            rename_also: HashMap::new(),
            value_map: Vec::new(),
            drop_if_percent: Vec::new(),
            obsolete: Vec::new(),
            foreign: Vec::new(),
        });
        Rules {
            meta: l.meta.into_iter().collect(),
            rename: l.rename,
            rename_also: l.rename_also,
            value_map: l.value_map,
            drop_if_percent: l.drop_if_percent.into_iter().collect(),
            ignored: l.obsolete.iter().cloned().chain(l.foreign).collect(),
            obsolete: l.obsolete.into_iter().collect(),
        }
    })
}

/// True for a key Orca dropped over time (not one only another fork defines).
pub(crate) fn is_obsolete(key: &str) -> bool {
    rules().obsolete.contains(key)
}

/// True for a key Orca drops when it holds a percent.
pub(crate) fn is_drop_if_percent(key: &str) -> bool {
    rules().drop_if_percent.contains(key)
}

/// The legacy key that `key` replaced, when `raw` uses one: the first by name of those present.
pub(crate) fn legacy_source<'a>(key: &str, raw: &'a BTreeMap<String, Json>) -> Option<&'a str> {
    raw.keys()
        .map(String::as_str)
        .find(|k| rules().rename.get(*k).is_some_and(|t| t == key))
}

/// What a legacy key is called now.
pub(crate) fn legacy_target(key: &str) -> Option<&'static str> {
    rules().rename.get(key).map(String::as_str)
}

/// Merge a profile and its parents, child first in `layers`. A child's value replaces the parent's, except a `nil`
/// entry, which keeps the parent's value for that extruder, as Orca and Bambu Studio merge user presets.
#[must_use]
pub fn merge_layers(layers: &[Json]) -> BTreeMap<String, Json> {
    let is_nil = |j: &Json| j.as_str() == Some("nil");
    let mut merged: BTreeMap<String, Json> = BTreeMap::new();
    for layer in layers.iter().rev() {
        let Some(o) = layer.as_object() else { continue };
        for (k, v) in o {
            match (merged.get(k), v) {
                (Some(_), v) if is_nil(v) => {}
                (Some(Json::Array(prev)), Json::Array(items)) if items.iter().any(is_nil) => {
                    let next: Vec<Json> = items
                        .iter()
                        .enumerate()
                        .map(|(i, x)| match prev.get(i) {
                            Some(p) if is_nil(x) => p.clone(),
                            _ => x.clone(),
                        })
                        .collect();
                    merged.insert(k.clone(), Json::Array(next));
                }
                _ => {
                    merged.insert(k.clone(), v.clone());
                }
            }
        }
    }
    merged
}

const MAX_DEPTH: usize = 32;

/// Result of importing a profile.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileImport {
    pub name: String,
    pub section: Section,
    /// Names from the profile itself up to the root of the chain.
    pub chain: Vec<String>,
    pub config: PrintConfig,
    /// Keys neither the schema nor Orca's legacy rules know. Orca would drop them too.
    pub unknown_keys: Vec<String>,
    /// Keys Orca drops on purpose: obsolete keys and keys only Bambu Studio and other forks define.
    pub ignored_keys: Vec<String>,
    /// Keys that were `nil` and left out.
    pub nil_keys: Vec<String>,
    /// Keys whose value could not be read as the schema type.
    pub invalid_keys: Vec<String>,
}

fn section_of(t: Option<&Json>) -> Option<Section> {
    match t?.as_str()? {
        "process" | "print" => Some(Section::Process),
        "filament" => Some(Section::Filament),
        "machine" | "printer" => Some(Section::Printer),
        _ => None,
    }
}

fn map_legacy_value(key: &str, raw: &Json) -> Json {
    let rules: Vec<&ValueMap> = rules().value_map.iter().filter(|r| r.key == key).collect();
    if rules.is_empty() {
        return raw.clone();
    }
    let one = |v: &Json| match v.as_str().and_then(|s| rules.iter().find(|r| r.from == s)) {
        Some(r) => Json::String(r.to.clone()),
        None => v.clone(),
    };
    match raw {
        Json::Array(a) => Json::Array(a.iter().map(one).collect()),
        other => one(other),
    }
}

fn has_percent(raw: &Json) -> bool {
    match raw {
        Json::Array(a) => a.iter().any(|x| x.as_str().is_some_and(|s| s.contains('%'))),
        Json::String(s) => s.contains('%'),
        _ => false,
    }
}

/// Bambu Studio 2.8 replaced the `reduce_infill_retraction` switch with `reduce_infill_retraction_mode`. Its tooltip:
/// "Enabled" always skips retraction for travels within the infill area, "Disabled" always retracts, and "Auto" skips it
/// for filaments with low metal stickiness (PLA) but not medium or high (PETG), where `filament_metal_stickiness` "None"
/// (untested) counts as low. The engine has one switch for the print, so Auto turns it on when every filament of the
/// file is low (or when it names no filament). `None` when the file has no mode, or one of another name, which then
/// imports as before.
pub(crate) fn infill_retraction_from_mode(merged: &BTreeMap<String, Json>) -> Option<bool> {
    let one = |v: &Json| match v {
        Json::Array(a) if a.len() == 1 => a.first().cloned().unwrap_or(Json::Null),
        other => other.clone(),
    };
    let mode = one(merged.get("reduce_infill_retraction_mode")?);
    match mode.as_str()?.trim().to_ascii_lowercase().as_str() {
        "enabled" => Some(true),
        "disabled" => Some(false),
        "auto" => {
            let low = |x: &Json| {
                x.as_str()
                    .is_some_and(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "none" | "low" | "nil"))
            };
            Some(match merged.get("filament_metal_stickiness") {
                None => true,
                Some(Json::Array(a)) => a.iter().all(low),
                Some(v) => low(v),
            })
        }
        _ => None,
    }
}

/// Bambu Studio sets one wall on top surfaces with `top_one_wall_type` and does not read `only_one_wall_top`: "all top"
/// and "topmost" give one wall, "not apply" keeps every wall. The engine has the one switch, so both one-wall values
/// turn it on ("topmost" prints like "all top" on a part with one top level; parts with more were not compared). `None`
/// when the file has no type, or one of another name, which then imports as before.
pub(crate) fn one_wall_top_from_type(merged: &BTreeMap<String, Json>) -> Option<bool> {
    let kind = match merged.get("top_one_wall_type")? {
        Json::Array(a) if a.len() == 1 => a.first()?,
        other => other,
    };
    match kind.as_str()?.trim().to_ascii_lowercase().as_str() {
        "all top" | "topmost" => Some(true),
        "not apply" => Some(false),
        _ => None,
    }
}

/// The result of reading one flat object of Orca JSON values.
pub(crate) struct Flat {
    pub config: PrintConfig,
    pub unknown: Vec<String>,
    pub ignored: Vec<String>,
    pub nil: Vec<String>,
    pub invalid: Vec<String>,
}

/// A key that is our own setting on a Bambu Lab printer and an older name for another setting elsewhere (legacy.json):
/// `initial_layer_flow_ratio` is the first layer's flow ratio in a Bambu Lab project, which the engine reads under that
/// name, and the bottom surface flow ratio in other files.
const OWN_ON_BAMBU: [&str; 1] = ["initial_layer_flow_ratio"];

/// True when the settings are for a Bambu Lab printer, as the engine tells: its flavor or its model name.
fn for_bambu(merged: &BTreeMap<String, Json>) -> bool {
    let text = |k: &str| match merged.get(k) {
        Some(Json::Array(a)) => a.first().and_then(Json::as_str).unwrap_or(""),
        Some(v) => v.as_str().unwrap_or(""),
        None => "",
    };
    text("gcode_flavor") == "bambu" || text("printer_model").starts_with("Bambu Lab")
}

/// True when `v` reads as a number the way the engine reads one: a finite number, or text that is one once spaces and a
/// trailing percent sign are dropped; a list by its first entry.
fn engine_number(v: &Json) -> bool {
    let one = match v {
        Json::Array(a) => a.first(),
        other => Some(other),
    };
    match one {
        Some(Json::Number(n)) => n.as_f64().is_some_and(f64::is_finite),
        Some(Json::String(t)) => t
            .trim()
            .trim_end_matches('%')
            .trim()
            .parse::<f64>()
            .is_ok_and(f64::is_finite),
        _ => false,
    }
}

/// Read one flat object of Orca JSON values (a merged profile, or a project's settings file).
pub(crate) fn import_flat(merged: &BTreeMap<String, Json>) -> Flat {
    let rules = rules();
    let mut config = PrintConfig::new();
    let (mut unknown, mut ignored, mut nil, mut invalid) =
        (BTreeSet::new(), BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    let from_mode = infill_retraction_from_mode(merged);
    let one_wall_top = one_wall_top_from_type(merged);
    let bambu = for_bambu(merged);
    // On other printers the older name wins over our own in the same file, as the engine reads that file: its
    // `initial_layer_flow_ratio` is the bottom surface ratio in place of `bottom_solid_infill_flow_ratio`, when it holds a
    // number.
    let shadowed: BTreeSet<&str> = OWN_ON_BAMBU
        .iter()
        .filter(|k| !bambu && merged.get(**k).is_some_and(engine_number))
        .filter_map(|k| rules.rename.get(*k).map(String::as_str))
        .collect();
    for (raw_key, raw_value) in merged {
        if rules.meta.contains(raw_key) {
            continue;
        }
        if shadowed.contains(raw_key.as_str()) {
            continue;
        }
        // The mode replaces the old switch when the file has both (see `infill_retraction_from_mode`).
        if from_mode.is_some()
            && (raw_key == "reduce_infill_retraction_mode" || raw_key == "reduce_infill_retraction")
        {
            continue;
        }
        // The type replaces the switch when the file has both (see `one_wall_top_from_type`).
        if one_wall_top.is_some() && (raw_key == "top_one_wall_type" || raw_key == "only_one_wall_top") {
            continue;
        }
        // Bambu Studio's rib wall switch reads as our wall type (legacy.json); the file's own wall type wins.
        if raw_key == "prime_tower_rib_wall" && merged.contains_key("wipe_tower_wall_type") {
            continue;
        }
        if rules.ignored.contains(raw_key) && setting_def(raw_key).is_none() {
            ignored.insert(raw_key.clone());
            continue;
        }
        if rules.drop_if_percent.contains(raw_key) && has_percent(raw_value) {
            ignored.insert(raw_key.clone());
            continue;
        }
        let older = if OWN_ON_BAMBU.contains(&raw_key.as_str()) {
            !bambu
        } else {
            setting_def(raw_key).is_none()
        };
        let renamed = older.then(|| rules.rename.get(raw_key)).flatten();
        let key = renamed.cloned().unwrap_or_else(|| raw_key.clone());
        if setting_def(&key).is_none() {
            unknown.insert(raw_key.clone());
            continue;
        }
        // Our own name in the same file wins over an older one.
        if renamed.is_some() && merged.contains_key(&key) && !shadowed.contains(key.as_str()) {
            continue;
        }
        let also = renamed
            .and_then(|_| rules.rename_also.get(raw_key))
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter(|k| !merged.contains_key(*k));
        let value = map_legacy_value(raw_key, raw_value);
        for k in std::iter::once(&key).chain(also) {
            let Some(def) = setting_def(k) else { continue };
            match coerce(def, &value) {
                Coerced::Ok(v) => config.set(k.clone(), v),
                Coerced::Nil => {
                    nil.insert(k.clone());
                }
                Coerced::Invalid => {
                    invalid.insert(k.clone());
                }
            }
        }
    }
    if let Some(on) = from_mode {
        config.set("reduce_infill_retraction", crate::value::Value::Bool(on));
    }
    if let Some(on) = one_wall_top {
        config.set("only_one_wall_top", crate::value::Value::Bool(on));
    }
    Flat {
        config,
        unknown: unknown.into_iter().collect(),
        ignored: ignored.into_iter().collect(),
        nil: nil.into_iter().collect(),
        invalid: invalid.into_iter().collect(),
    }
}

/// Import a profile. `resolve(name)` returns the parent profile JSON by name. Values merge root
/// first, so a child key replaces the parent's. Fails on a cycle, a missing parent, or an input
/// that is not a profile object.
pub fn import_orca(json: &Json, resolve: &dyn Fn(&str) -> Option<Json>) -> Result<ProfileImport, Error> {
    if !json.is_object() {
        return Err(Error::NotObject);
    }
    let mut chain: Vec<String> = Vec::new();
    let mut layers: Vec<Json> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut cur = json.clone();
    loop {
        let name = cur.get("name").and_then(Json::as_str).unwrap_or("").to_owned();
        if !name.is_empty() && !seen.insert(name.clone()) {
            return Err(Error::Cycle(name));
        }
        chain.push(name.clone());
        let parent = cur
            .get("inherits")
            .and_then(Json::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        layers.push(cur);
        if chain.len() > MAX_DEPTH {
            return Err(Error::TooDeep);
        }
        let Some(parent_name) = parent else { break };
        match resolve(&parent_name).filter(Json::is_object) {
            Some(p) => cur = p,
            None => {
                return Err(Error::MissingParent {
                    parent: parent_name,
                    child: name,
                });
            }
        }
    }
    let flat = import_flat(&merge_layers(&layers));
    let section = section_of(json.get("type"))
        .or_else(|| section_of(layers.last().and_then(|l| l.get("type"))))
        .unwrap_or(Section::Process);
    Ok(ProfileImport {
        name: chain.first().cloned().unwrap_or_default(),
        section,
        chain,
        config: flat.config,
        unknown_keys: flat.unknown,
        ignored_keys: flat.ignored,
        nil_keys: flat.nil,
        invalid_keys: flat.invalid,
    })
}

/// Back to Orca's string typed JSON, for saving a profile Orca and Bambu Studio can open.
#[must_use]
pub fn export_orca(config: &PrintConfig, name: &str, section: Section, inherits: Option<&str>) -> Json {
    let mut out = serde_json::Map::new();
    let type_name = match section {
        Section::Process => "process",
        Section::Filament => "filament",
        Section::Printer => "machine",
    };
    out.insert("type".into(), Json::String(type_name.into()));
    out.insert("name".into(), Json::String(name.into()));
    out.insert("from".into(), Json::String("User".into()));
    out.insert("instantiation".into(), Json::String("true".into()));
    if let Some(i) = inherits {
        out.insert("inherits".into(), Json::String(i.into()));
    }
    let in_section: HashSet<&str> = settings()
        .iter()
        .filter(|d| d.section == section)
        .map(|d| d.key.as_str())
        .collect();
    for (k, v) in config.iter() {
        if !in_section.contains(k.as_str()) {
            continue;
        }
        if let Some(def) = setting_def(k) {
            out.insert(k.clone(), to_orca(def, v));
        }
    }
    orca_readable(&mut out);
    Json::Object(out)
}

/// Keys of ours that `OrcaSlicer` and Bambu Studio do not read, left out of what is written for them.
const NOT_ORCA_KEYS: &[&str] = &["filament_travel_slope"];

/// Values of ours that they do not read, by key, and what is written for them instead: a ramp lift as a slope lift.
const ORCA_VALUES: &[(&str, &str, &str)] = &[
    ("z_hop_types", "Ramp Lift", "Slope Lift"),
    ("filament_z_hop_types", "Ramp Lift", "Slope Lift"),
];

/// Orca-format settings (as [`to_orca`] writes them) as `OrcaSlicer` and Bambu Studio read them, for a profile made
/// for them: our own keys left out and our own values written as theirs. The same as `orcaReadable` in the settings
/// package.
pub fn orca_readable(settings: &mut serde_json::Map<String, Json>) {
    settings.retain(|k, _| !NOT_ORCA_KEYS.contains(&k.as_str()));
    for (key, v) in settings.iter_mut() {
        let swaps: Vec<(&str, &str)> = ORCA_VALUES
            .iter()
            .filter(|(k, _, _)| k == key)
            .map(|(_, from, to)| (*from, *to))
            .collect();
        if swaps.is_empty() {
            continue;
        }
        let one = |s: &str| -> String {
            s.split(',')
                .map(|p| {
                    swaps
                        .iter()
                        .find(|(from, _)| *from == p.trim())
                        .map_or(p, |(_, to)| *to)
                })
                .collect::<Vec<_>>()
                .join(",")
        };
        match v {
            Json::String(s) => *s = one(s),
            Json::Array(a) => {
                for x in a.iter_mut() {
                    if let Json::String(s) = x {
                        *s = one(s);
                    }
                }
            }
            _ => {}
        }
    }
}
