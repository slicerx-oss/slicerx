// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Typed view of `knowledge.json`, which `scripts/gen-knowledge.mjs` compiles from `knowledge/`.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value as Json;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Ranged {
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub typical: f64,
    #[serde(default)]
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Cooling {
    pub fan_min: Option<f64>,
    pub fan_max: Option<f64>,
    pub overhang_fan: Option<f64>,
    pub no_fan_layers: Option<f64>,
    pub min_layer_time: Option<f64>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MaxFlow {
    pub standard: Option<f64>,
    pub high_flow: Option<f64>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Retraction {
    pub direct_drive: Option<f64>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PressureAdvance {
    pub direct_drive: Option<f64>,
    pub bowden: Option<f64>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NozzleNeeds {
    pub abrasive: bool,
    pub hardened_required: bool,
    pub min_diameter: Option<f64>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PlateFit {
    pub plate: String,
    pub fit: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

/// The safe layer height band as a share of the nozzle diameter.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LayerBand {
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub typical: Option<f64>,
    pub src: Vec<String>,
}

/// What sleipnir should do for a material, in plain sentences.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmartLayerNotes {
    pub quality: Option<String>,
    pub strength: Option<String>,
    pub thin_layer_cooling: Option<String>,
    pub src: Vec<String>,
}

/// Speed limits the material itself sets.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MaterialSpeeds {
    pub print_min: Option<f64>,
    pub print_max: Option<f64>,
    pub outer_wall_max: Option<f64>,
    pub first_layer_max: Option<f64>,
    pub first_layer_typical: Option<f64>,
    pub src: Vec<String>,
}

/// The window a material allows for one sleipnir mode, as a share of the nozzle.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModeWindow {
    pub min_ratio: Option<f64>,
    pub max_ratio: Option<f64>,
}

/// The per mode windows in a material's sleipnir research.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmartLayerModes {
    pub quality: Option<ModeWindow>,
    pub strength: Option<ModeWindow>,
}

/// Research on sleipnir for a material: the layer height window as a share of the nozzle.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmartLayerResearch {
    pub min_ratio: Option<f64>,
    pub max_ratio: Option<f64>,
    pub modes: Option<SmartLayerModes>,
    pub note: Option<String>,
    pub src: Vec<String>,
}

/// The minimum layer time thin layers need, from the sleipnir research for the material's family.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CoolingGuard {
    pub min_layer_time: f64,
    pub note: Option<String>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FirstLayer {
    pub fan_off_layers: Option<f64>,
    pub speed: Option<f64>,
    pub bed_note: Option<String>,
    pub squish_note: Option<String>,
    pub src: Vec<String>,
}

/// Wall and infill hints.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Structure {
    pub walls_min: Option<f64>,
    pub walls_typical: Option<f64>,
    pub walls_note: Option<String>,
    pub pattern_hint: Option<String>,
    pub density_note: Option<String>,
    pub src: Vec<String>,
}

/// How supports pair with a material: interface materials, the soluble partner, Z gap and interface layers.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupportPairing {
    pub interface_materials: Vec<String>,
    pub soluble_material: Option<String>,
    pub soluble_dissolve: Option<String>,
    pub top_z: Option<f64>,
    pub interface_layers: Option<f64>,
    pub note: Option<String>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MaterialKnowledge {
    pub name: String,
    pub category: Option<String>,
    pub orca_type: Option<String>,
    pub nozzle_temp: Option<Ranged>,
    pub first_layer_temp: Option<Ranged>,
    pub bed_temp: Option<Ranged>,
    pub chamber_temp: Option<Ranged>,
    pub enclosure: Option<String>,
    pub cooling: Cooling,
    pub flow_ratio: Option<Ranged>,
    pub max_flow: MaxFlow,
    pub retraction: Retraction,
    pub pressure_advance: PressureAdvance,
    pub density: Option<f64>,
    pub nozzle: NozzleNeeds,
    pub drying_need: Option<String>,
    pub softening_temp: Option<f64>,
    pub layer_band: Option<LayerBand>,
    pub smart_layer_notes: Option<SmartLayerNotes>,
    pub speeds: Option<MaterialSpeeds>,
    pub smart_layer: Option<SmartLayerResearch>,
    pub cooling_guard: Option<CoolingGuard>,
    pub retraction_speed: Option<Ranged>,
    pub first_layer: Option<FirstLayer>,
    pub structure: Option<Structure>,
    pub supports: Option<SupportPairing>,
    pub pilot_defaults: BTreeMap<String, Json>,
    pub plates: Vec<PlateFit>,
    pub paths: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Build {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub z: Option<f64>,
    pub z_default: Option<f64>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct StockNozzle {
    pub diameter: Option<f64>,
    pub material: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hotend {
    pub max_temp: Option<f64>,
    pub nozzle_diameters: Option<Vec<f64>>,
    pub nozzle_materials: Option<Vec<String>>,
    pub stock_nozzle: Option<StockNozzle>,
    pub high_flow: bool,
    pub max_flow: Option<f64>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Bed {
    pub max_temp: Option<f64>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Enclosure {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub chamber_heating: Option<String>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Motion {
    pub max_speed: Option<f64>,
    pub max_accel: Option<f64>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrinterMaterials {
    pub recommended: Vec<String>,
    pub possible: Vec<String>,
    pub not_recommended: Vec<String>,
    pub unlisted: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Baseline {
    pub values: BTreeMap<String, Json>,
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrinterKnowledge {
    pub name: String,
    pub vendor: Option<String>,
    pub firmware: Option<String>,
    pub extruder: Option<String>,
    pub build: Option<Build>,
    pub hotend: Hotend,
    pub bed: Bed,
    pub enclosure: Enclosure,
    pub motion: Motion,
    pub materials: PrinterMaterials,
    pub baseline_process: Option<String>,
    pub baseline: Option<Baseline>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ValueFrom {
    pub nozzle_factor: Option<f64>,
    pub round_to: Option<f64>,
    pub filament_range: Option<String>,
    pub position: Option<f64>,
    pub filament: Option<String>,
    pub calibration: Option<String>,
    pub field: Option<String>,
    pub factor: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KChange {
    pub key: String,
    pub op: String,
    pub value: Option<Json>,
    pub value_from: Option<ValueFrom>,
    pub priority: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Level {
    pub extends: Option<String>,
    #[serde(default)]
    pub changes: Vec<KChange>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoolingRule {
    pub applies_to: Vec<String>,
    pub change: KChange,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MaterialHints {
    pub prefer: Option<Vec<String>>,
    pub acceptable: Option<Vec<String>>,
    pub avoid: Option<Vec<String>>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct TextSrc {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AdviceEntry {
    #[serde(default)]
    pub text: String,
    #[serde(default = "workflow")]
    pub kind: String,
    #[serde(default)]
    pub src: Vec<String>,
}

fn workflow() -> String {
    "workflow".to_owned()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalKnowledge {
    pub label: String,
    pub default_level: Option<String>,
    #[serde(default)]
    pub implies: Vec<String>,
    #[serde(default)]
    pub levels: BTreeMap<String, Level>,
    pub cooling_rule: Option<CoolingRule>,
    #[serde(default)]
    pub material_hints: MaterialHints,
    pub material_notes: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub caveats: Vec<TextSrc>,
    #[serde(default)]
    pub always_show_caveats: bool,
    #[serde(default)]
    pub advice: Vec<AdviceEntry>,
    #[serde(default)]
    pub constraints: Vec<TextSrc>,
    #[serde(default)]
    pub checks: Vec<String>,
    #[serde(default)]
    pub src: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRule {
    pub goals: Vec<String>,
    pub resolution: Option<String>,
    pub keep: Option<BTreeMap<String, String>>,
    pub ask: Option<String>,
    pub never: Option<String>,
    pub tell_user: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationWrite {
    pub key: String,
    pub op: String,
    pub value: Option<Json>,
    pub value_from: Option<ValueFrom>,
    pub why: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Knowledge {
    #[serde(default)]
    pub materials: BTreeMap<String, MaterialKnowledge>,
    #[serde(default)]
    pub printers: BTreeMap<String, PrinterKnowledge>,
    #[serde(default)]
    pub goals: BTreeMap<String, GoalKnowledge>,
    #[serde(default)]
    pub pairs: Vec<PairRule>,
    #[serde(default)]
    pub calibrations: BTreeMap<String, Vec<CalibrationWrite>>,
}

/// The compiled knowledge table.
pub fn knowledge() -> &'static Knowledge {
    static K: OnceLock<Knowledge> = OnceLock::new();
    K.get_or_init(|| serde_json::from_str(include_str!("../knowledge.json")).unwrap_or_default())
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;

    #[test]
    fn knowledge_loads() {
        let k = knowledge();
        assert!(k.materials.len() >= 20 && k.printers.len() >= 20 && k.goals.len() >= 12);
        assert!(
            k.materials
                .get("petg")
                .is_some_and(|m| m.nozzle_temp.as_ref().is_some_and(|t| t.typical == 245.0))
        );
        assert!(
            k.goals
                .get("strength")
                .is_some_and(|g| g.levels.contains_key("max"))
        );
    }
}

#[cfg(test)]
mod parse_tests {
    #[test]
    fn knowledge_json_parses() {
        let r: Result<super::Knowledge, _> = serde_json::from_str(include_str!("../knowledge.json"));
        assert!(r.is_ok(), "{:?}", r.err());
    }
}
