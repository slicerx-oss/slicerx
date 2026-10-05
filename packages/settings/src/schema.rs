// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The settings schema. `schema.json` is generated from Orca's `PrintConfig.cpp` by
//! `scripts/gen-schema.py`; the TypeScript package reads the same file.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Deserializer, Serialize};

/// Pipeline stages in order. A setting names the first stage a change to it invalidates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SliceStage {
    Layers,
    Contours,
    Perimeters,
    Surfaces,
    Infill,
    Paths,
    Gcode,
    Preview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Section {
    Process,
    Filament,
    Printer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingType {
    Float,
    Int,
    Bool,
    Percent,
    FloatOrPercent,
    Enum,
    String,
    Gcode,
    Point,
    Floats,
    Ints,
    Bools,
    Percents,
    FloatsOrPercents,
    Enums,
    Strings,
    Points,
    PointsGroups,
}

impl SettingType {
    /// True for the per-extruder list types Orca stores as arrays.
    #[must_use]
    pub fn is_vector(self) -> bool {
        matches!(
            self,
            Self::Floats
                | Self::Ints
                | Self::Bools
                | Self::Percents
                | Self::FloatsOrPercents
                | Self::Enums
                | Self::Strings
                | Self::Points
                | Self::PointsGroups
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Simple,
    Advanced,
    Expert,
    Develop,
    /// Profile and runtime keys: kept for import and export, shown in no tier.
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PilotRule {
    Edit,
    Guarded,
    Read,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CondOp {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
    In,
    Notin,
}

/// A key is enabled only while every condition holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Condition {
    pub key: String,
    pub op: CondOp,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Effect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub increase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decrease: Option<String>,
}

/// Orca's own limit on a value, when it differs from the recommended `min` or `max`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum Bound {
    /// The recommended limit is also Orca's (the field is absent from the file).
    #[default]
    Same,
    /// Orca sets no limit (`null` in the file).
    Unlimited,
    At(f64),
}

impl Bound {
    /// Orca's limit, given the recommended one.
    #[must_use]
    pub fn resolve(self, recommended: Option<f64>) -> Option<f64> {
        match self {
            Self::Same => recommended,
            Self::Unlimited => None,
            Self::At(v) => Some(v),
        }
    }

    fn is_same(&self) -> bool {
        matches!(self, Self::Same)
    }
}

impl Serialize for Bound {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::At(v) => s.serialize_f64(*v),
            _ => s.serialize_none(),
        }
    }
}

fn de_bound<'de, D: Deserializer<'de>>(d: D) -> Result<Bound, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.map_or(Bound::Unlimited, Bound::At))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingDef {
    pub key: String,
    pub section: Section,
    #[serde(rename = "type")]
    pub kind: SettingType,
    #[serde(default)]
    pub unit: Option<String>,
    pub default: serde_json::Value,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    /// Orca's own limits when they differ from `min` and `max`.
    #[serde(
        default,
        deserialize_with = "de_bound",
        skip_serializing_if = "Bound::is_same"
    )]
    pub orca_min: Bound,
    #[serde(
        default,
        deserialize_with = "de_bound",
        skip_serializing_if = "Bound::is_same"
    )]
    pub orca_max: Bound,
    /// The value 0 means automatic and is always allowed, whatever `min` says.
    #[serde(default)]
    pub auto: bool,
    #[serde(default)]
    pub enum_values: Vec<String>,
    #[serde(default)]
    pub enum_labels: Vec<String>,
    /// Other spellings of an enum value that read as the value they map to (for example `athena` is `aegis`).
    #[serde(
        default,
        rename = "enumAliases",
        skip_serializing_if = "std::collections::BTreeMap::is_empty"
    )]
    pub enum_aliases: std::collections::BTreeMap<String, String>,
    /// Enum values the schema lists but the engine cannot print yet; validation warns when one is chosen.
    #[serde(default, rename = "unavailableValues", skip_serializing_if = "Vec::is_empty")]
    pub unavailable_values: Vec<String>,
    pub label: String,
    #[serde(default)]
    pub help: Option<String>,
    /// One or two sentences on what the setting does and when to change it, from notes.json.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub group: String,
    #[serde(default)]
    pub category: Option<String>,
    pub mode: Mode,
    /// What the key is for (quality, strength, speed, supports, adhesion, multicolor, effects, output). Process keys of the user tiers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    /// `multicolor`: show the key only when two or more filaments are in use.
    #[serde(default, rename = "showWhen", skip_serializing_if = "Option::is_none")]
    pub show_when: Option<String>,
    #[serde(default)]
    pub easy: bool,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub enabled_when: Vec<Condition>,
    #[serde(default)]
    pub pilot: Option<PilotRule>,
    #[serde(default)]
    pub effect: Option<Effect>,
    pub invalidates: SliceStage,
}

#[derive(Deserialize)]
struct SchemaFile {
    orca_commit: String,
    #[serde(default)]
    project_keys: Vec<String>,
    settings: Vec<SettingDef>,
}

struct Schema {
    commit: String,
    project_keys: std::collections::HashSet<String>,
    defs: Vec<SettingDef>,
    index: HashMap<String, usize>,
}

#[derive(Deserialize, Default)]
struct NotesFile {
    #[serde(default)]
    notes: HashMap<String, String>,
}

static SCHEMA: OnceLock<Schema> = OnceLock::new();

fn schema() -> &'static Schema {
    SCHEMA.get_or_init(|| {
        let mut file: SchemaFile =
            serde_json::from_str(include_str!("../schema.json")).unwrap_or(SchemaFile {
                orca_commit: String::new(),
                project_keys: Vec::new(),
                settings: Vec::new(),
            });
        let notes: NotesFile = serde_json::from_str(include_str!("../notes.json")).unwrap_or_default();
        for d in &mut file.settings {
            if d.note.is_none() {
                d.note = notes.notes.get(&d.key).cloned();
            }
        }
        let index = file
            .settings
            .iter()
            .enumerate()
            .map(|(i, d)| (d.key.clone(), i))
            .collect();
        Schema {
            project_keys: file.project_keys.into_iter().collect(),
            commit: file.orca_commit,
            defs: file.settings,
            index,
        }
    })
}

/// Every setting, process first, then filament, then printer.
#[must_use]
pub fn settings() -> &'static [SettingDef] {
    &schema().defs
}

/// Orca commit the schema was extracted from.
#[must_use]
pub fn orca_commit() -> &'static str {
    &schema().commit
}

/// True for keys Orca defines for a project or plate (filament colors, wipe tower position, flush volumes)
/// rather than for a preset.
#[must_use]
pub fn is_project_key(key: &str) -> bool {
    schema().project_keys.contains(key)
}

#[must_use]
pub fn setting_def(key: &str) -> Option<&'static SettingDef> {
    let s = schema();
    s.index.get(key).and_then(|i| s.defs.get(*i))
}

/// First slice stage a change to `key` invalidates. Unknown keys invalidate everything.
#[must_use]
pub fn invalidates(key: &str) -> SliceStage {
    setting_def(key).map_or(SliceStage::Layers, |d| d.invalidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_loads() {
        assert!(settings().len() > 600);
        assert_eq!(orca_commit().len(), 40);
    }

    #[test]
    fn notes_load() {
        assert!(
            setting_def("wall_loops")
                .and_then(|d| d.note.as_deref())
                .is_some_and(|n| n.contains("loops"))
        );
    }

    #[test]
    fn stages_are_ordered() {
        assert!(SliceStage::Layers < SliceStage::Gcode);
        assert_eq!(invalidates("layer_height"), SliceStage::Layers);
        assert_eq!(invalidates("wall_loops"), SliceStage::Perimeters);
        assert_eq!(invalidates("sparse_infill_density"), SliceStage::Infill);
        assert_eq!(invalidates("outer_wall_speed"), SliceStage::Gcode);
        assert_eq!(invalidates("no_such_key"), SliceStage::Layers);
    }

    #[test]
    fn limits_distinguish_absent_from_null() {
        let lh = setting_def("layer_height");
        assert!(lh.is_some_and(|d| d.orca_max == Bound::Unlimited && d.orca_min == Bound::At(0.0)));
        let loops = setting_def("wall_loops");
        assert!(loops.is_some_and(|d| d.orca_min == Bound::At(0.0)));
        let density = setting_def("sparse_infill_density");
        assert!(density.is_some_and(|d| d.orca_min == Bound::Same));
    }
}
