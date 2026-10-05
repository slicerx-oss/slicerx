// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Deterministic settings plan for a material, printer or nozzle switch, optionally with the user's
//! goals. No model call and no I/O: everything comes from `knowledge.json` and the schema. The order
//! follows the knowledge base guide: the target profile (or the printer baseline), filament defaults
//! and printer facts except tuned keys, calibration results, the merged goals, clamps, then a diff.
//! `js/plan.ts` does the same; `fixtures/plan-golden.json` holds cases both must reproduce.

// The comparisons mirror the TypeScript implementation, which compares plain numbers exactly.
#![allow(clippy::float_cmp)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};

use crate::config::number_of;
use crate::diff::{format_value, same_value};
use crate::intent::{IntentContext, merge_intent, short_name, snap};
use crate::knowledge::{MaterialKnowledge, PrinterKnowledge, knowledge};
use crate::schema::{Section, SettingDef, SettingType, setting_def};
use crate::smart_layer::{LAYER_STEP, is_smart_layer_on, smart_layer_limits, smart_layer_window};
use crate::thin_layers::{heat_creep_warning, layer_time_guard};
use crate::value::{PrintConfig, Scalar, Value};

/// A material, printer and nozzle: what a plan switches between.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupRef {
    pub printer: String,
    pub nozzle_diameter: f64,
    pub filament: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nozzle_material: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanGoal {
    pub id: String,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub stated: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PlanIntent {
    pub goals: Vec<PlanGoal>,
}

/// A stored calibration result for one spool, printer and nozzle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationResult {
    pub id: String,
    pub values: BTreeMap<String, f64>,
    #[serde(default)]
    pub printer: Option<String>,
    #[serde(default)]
    pub filament: Option<String>,
    #[serde(default)]
    pub nozzle_diameter: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanAdvice {
    pub text: String,
    pub kind: String,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanCaveat {
    pub text: String,
    pub sources: Vec<String>,
}

/// Options for `plan_settings`. Keys of `tuned` and `keep` are Orca keys.
#[derive(Debug, Clone, Default)]
pub struct PlanOptions {
    /// The merged Orca profile for the `to` setup.
    pub target: Option<PrintConfig>,
    /// Keys the target's printer specific profile sets itself; filament defaults do not override them.
    pub tuned: BTreeSet<String>,
    /// Plate overrides to leave alone (intent and calibration still win).
    pub keep: BTreeSet<String>,
    pub calibrations: Vec<CalibrationResult>,
    pub intent: Option<PlanIntent>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SettingChange {
    pub key: String,
    pub label: String,
    pub section: Section,
    pub unit: Option<String>,
    pub before: Option<Value>,
    pub after: Value,
    pub reason: String,
    pub sources: Vec<String>,
    pub origin: String,
    pub klass: String,
    pub approval: String,
    pub goal: Option<String>,
    pub priority: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanClamp {
    pub key: String,
    pub requested: Value,
    pub applied: Value,
    pub by: String,
    pub limit: f64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanRefusal {
    pub key: String,
    pub requested: Value,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SettingsPlan {
    pub from: SetupRef,
    pub to: SetupRef,
    pub changes: Vec<SettingChange>,
    pub unresolved: Vec<(String, String)>,
    pub warnings: Vec<String>,
    pub clamps: Vec<PlanClamp>,
    pub refused: Vec<PlanRefusal>,
    pub blockers: Vec<String>,
    pub questions: Vec<String>,
    pub caveats: Vec<PlanCaveat>,
    pub advice: Vec<PlanAdvice>,
    pub tell_user: Vec<String>,
    pub computed_ms: f64,
}

fn section_name(s: Section) -> &'static str {
    match s {
        Section::Process => "process",
        Section::Filament => "filament",
        Section::Printer => "printer",
    }
}

impl SettingChange {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert("key".into(), json!(self.key));
        m.insert("label".into(), json!(self.label));
        m.insert("section".into(), json!(section_name(self.section)));
        if let Some(u) = &self.unit {
            m.insert("unit".into(), json!(u));
        }
        m.insert(
            "before".into(),
            self.before.as_ref().map_or(Json::Null, Value::to_json),
        );
        m.insert("after".into(), self.after.to_json());
        m.insert("reason".into(), json!(self.reason));
        m.insert("sources".into(), json!(self.sources));
        m.insert("origin".into(), json!(self.origin));
        m.insert("klass".into(), json!(self.klass));
        m.insert("approval".into(), json!(self.approval));
        if let Some(g) = &self.goal {
            m.insert("goal".into(), json!(g));
        }
        if let Some(p) = &self.priority {
            m.insert("priority".into(), json!(p));
        }
        Json::Object(m)
    }
}

impl SettingsPlan {
    /// The plan as JSON, the same shape as the TypeScript `SettingsPlan`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({
            "from": self.from,
            "to": self.to,
            "changes": self.changes.iter().map(SettingChange::to_json).collect::<Vec<_>>(),
            "unresolved": self.unresolved.iter().map(|(k, r)| json!({"key": k, "reason": r})).collect::<Vec<_>>(),
            "warnings": self.warnings,
            "clamps": self.clamps.iter().map(|c| json!({"key": c.key, "requested": c.requested.to_json(), "applied": c.applied.to_json(), "by": c.by, "limit": c.limit, "reason": c.reason})).collect::<Vec<_>>(),
            "refused": self.refused.iter().map(|r| json!({"key": r.key, "requested": r.requested.to_json(), "reason": r.reason})).collect::<Vec<_>>(),
            "blockers": self.blockers,
            "questions": self.questions,
            "caveats": self.caveats,
            "advice": self.advice,
            "tellUser": self.tell_user,
            "computedMs": self.computed_ms,
        })
    }

    /// Read a plan back from JSON (for `apply_plan_json`). Changes that do not parse are skipped.
    #[must_use]
    pub fn changes_from_json(j: &Json) -> Vec<SettingChange> {
        let Some(list) = j.get("changes").and_then(Json::as_array) else {
            return Vec::new();
        };
        list.iter()
            .filter_map(|c| {
                let key = c.get("key")?.as_str()?.to_owned();
                let section = match c.get("section")?.as_str()? {
                    "filament" => Section::Filament,
                    "printer" => Section::Printer,
                    _ => Section::Process,
                };
                let s = |k: &str| c.get(k).and_then(Json::as_str).map(str::to_owned);
                Some(SettingChange {
                    label: s("label").unwrap_or_else(|| key.clone()),
                    section,
                    unit: s("unit"),
                    before: c.get("before").and_then(Value::from_json),
                    after: Value::from_json(c.get("after")?)?,
                    reason: s("reason").unwrap_or_default(),
                    sources: c
                        .get("sources")
                        .and_then(Json::as_array)
                        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
                        .unwrap_or_default(),
                    origin: s("origin").unwrap_or_else(|| "profile".to_owned()),
                    klass: s("klass").unwrap_or_else(|| "read".to_owned()),
                    approval: s("approval").unwrap_or_else(|| "none".to_owned()),
                    goal: s("goal"),
                    priority: s("priority"),
                    key,
                })
            })
            .collect()
    }
}

// ---- knowledge helpers ----------------------------------------------------------------

/// The materials the plan knows, as (id, name).
#[must_use]
pub fn list_materials() -> Vec<(String, String)> {
    knowledge()
        .materials
        .iter()
        .map(|(id, m)| (id.clone(), m.name.clone()))
        .collect()
}

/// The printers the plan knows, as (id, name).
#[must_use]
pub fn list_printers() -> Vec<(String, String)> {
    knowledge()
        .printers
        .iter()
        .map(|(id, p)| (id.clone(), p.name.clone()))
        .collect()
}

/// The goals the plan knows, as (id, label, levels).
#[must_use]
pub fn list_goals() -> Vec<(String, String, Vec<String>)> {
    knowledge()
        .goals
        .iter()
        .map(|(id, g)| (id.clone(), g.label.clone(), g.levels.keys().cloned().collect()))
        .collect()
}

#[must_use]
pub fn material_knowledge(id: &str) -> Option<&'static MaterialKnowledge> {
    knowledge().materials.get(id)
}

#[must_use]
pub fn printer_knowledge(id: &str) -> Option<&'static PrinterKnowledge> {
    knowledge().printers.get(id)
}

pub(crate) struct Derived {
    /// The exact value to write, when it is not one scalar spread over the list (an elementwise cap).
    pub(crate) shaped: Option<Value>,
    pub(crate) value: Scalar,
    because: String,
    pub(crate) src: Vec<String>,
    origin: &'static str,
}

fn plate_key(plate: &str) -> Option<&'static str> {
    Some(match plate {
        "bambu_cool_plate" => "cool_plate_temp",
        "bambu_engineering_plate" => "eng_plate_temp",
        "bambu_high_temp_plate" => "hot_plate_temp",
        "textured_pei" => "textured_plate_temp",
        "bambu_supertack_plate" => "supertack_plate_temp",
        "bambu_textured_cool_plate" => "textured_cool_plate_temp",
        _ => return None,
    })
}

fn flavor(firmware: &str) -> Option<&'static str> {
    Some(match firmware {
        "bambu" => "marlin",
        "prusa" => "marlin2",
        "klipper" | "vendor_klipper" => "klipper",
        _ => return None,
    })
}

const WIDTH_KEYS: [&str; 7] = [
    "line_width",
    "outer_wall_line_width",
    "inner_wall_line_width",
    "sparse_infill_line_width",
    "top_surface_line_width",
    "internal_solid_infill_line_width",
    "initial_layer_line_width",
];

pub(crate) fn show(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        #[allow(clippy::cast_possible_truncation)]
        return (v as i64).to_string();
    }
    v.to_string()
}

fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

fn put(out: &mut BTreeMap<String, Derived>, key: &str, value: Option<f64>, because: String, src: &[String]) {
    if let Some(v) = value {
        out.insert(
            key.to_owned(),
            Derived {
                shaped: None,
                value: Scalar::Num(v),
                because,
                src: src.to_vec(),
                origin: "filament",
            },
        );
    }
}

/// What the knowledge says the config holds for one setup: material defaults, then printer facts.
#[allow(clippy::too_many_lines)]
pub(crate) fn derive(setup: &SetupRef) -> BTreeMap<String, Derived> {
    let kb = knowledge();
    let mut out: BTreeMap<String, Derived> = BTreeMap::new();
    let m = kb.materials.get(&setup.filament);
    let p = kb.printers.get(&setup.printer);
    if let Some(p) = p {
        out.insert(
            "nozzle_diameter".into(),
            Derived {
                shaped: None,
                value: Scalar::Num(setup.nozzle_diameter),
                because: format!(
                    "the {} is set up with a {} mm nozzle",
                    p.name,
                    show(setup.nozzle_diameter)
                ),
                src: p.hotend.src.clone(),
                origin: "nozzle",
            },
        );
        if let Some(b) = &p.build
            && let (Some(x), Some(y)) = (b.x.filter(|x| *x != 0.0), b.y.filter(|y| *y != 0.0))
        {
            out.insert(
                "printable_area".into(),
                Derived {
                    shaped: None,
                    value: Scalar::Str(format!("0x0,{}x0,{}x{},0x{}", show(x), show(x), show(y), show(y))),
                    because: format!("the {} bed is {} by {} mm", p.name, show(x), show(y)),
                    src: b.src.clone(),
                    origin: "printer",
                },
            );
        }
        let z = p
            .build
            .as_ref()
            .and_then(|b| b.z_default.or(b.z))
            .filter(|z| *z != 0.0);
        if let Some(z) = z {
            out.insert(
                "printable_height".into(),
                Derived {
                    shaped: None,
                    value: Scalar::Num(z),
                    because: format!("the {} prints up to {} mm high", p.name, show(z)),
                    src: p.build.as_ref().map(|b| b.src.clone()).unwrap_or_default(),
                    origin: "printer",
                },
            );
        }
        if let Some(a) = p.motion.max_accel.filter(|a| *a != 0.0) {
            out.insert(
                "machine_max_acceleration_extruding".into(),
                Derived {
                    shaped: None,
                    value: Scalar::Num(a),
                    because: format!("the {} allows up to {} mm/s2", p.name, show(a)),
                    src: p.motion.src.clone(),
                    origin: "printer",
                },
            );
        }
        if let Some(fw) = p.firmware.as_deref()
            && let Some(f) = flavor(fw)
        {
            out.insert(
                "gcode_flavor".into(),
                Derived {
                    shaped: None,
                    value: Scalar::Str(f.to_owned()),
                    because: format!("the {} runs {} firmware", p.name, fw),
                    src: Vec::new(),
                    origin: "printer",
                },
            );
        }
    }
    let Some(m) = m else { return out };
    let mat = short_name(&m.name).to_owned();
    if let Some(t) = &m.nozzle_temp {
        let range = format!(
            "range {} to {} C",
            t.min.map_or("undefined".to_owned(), show),
            t.max.map_or("undefined".to_owned(), show)
        );
        put(
            &mut out,
            "nozzle_temperature",
            Some(t.typical),
            format!("{} runs at {} C ({})", mat, show(t.typical), range),
            &t.src,
        );
        let first = m.first_layer_temp.as_ref();
        let ft = first.map_or(t.typical, |f| f.typical);
        put(
            &mut out,
            "nozzle_temperature_initial_layer",
            Some(ft),
            format!("{} first layer runs at {} C", mat, show(ft)),
            first.map_or(&t.src, |f| &f.src),
        );
        put(
            &mut out,
            "nozzle_temperature_range_low",
            t.min,
            format!(
                "{} works from {} C",
                mat,
                t.min.map_or("undefined".to_owned(), show)
            ),
            &t.src,
        );
        put(
            &mut out,
            "nozzle_temperature_range_high",
            t.max,
            format!(
                "{} works up to {} C",
                mat,
                t.max.map_or("undefined".to_owned(), show)
            ),
            &t.src,
        );
    }
    if let Some(bt) = &m.bed_temp {
        let bed = bt.typical;
        for pl in &m.plates {
            let Some(key) = plate_key(&pl.plate) else {
                continue;
            };
            if pl.fit == "avoid" {
                continue;
            }
            let t = bed
                .max(pl.min.unwrap_or(f64::NEG_INFINITY))
                .min(pl.max.unwrap_or(f64::INFINITY));
            put(
                &mut out,
                key,
                Some(t),
                format!("{} bed temperature on this plate is {} C", mat, show(t)),
                &bt.src,
            );
            put(
                &mut out,
                &format!("{key}_initial_layer"),
                Some(t),
                format!(
                    "{} first layer bed temperature on this plate is {} C",
                    mat,
                    show(t)
                ),
                &bt.src,
            );
        }
    }
    if let Some(ch) = &m.chamber_temp {
        put(
            &mut out,
            "chamber_temperature",
            Some(ch.typical),
            format!("{} prints best with a {} C chamber", mat, show(ch.typical)),
            &ch.src,
        );
    }
    let c = &m.cooling;
    let opt = |v: Option<f64>| v.map_or("undefined".to_owned(), show);
    put(
        &mut out,
        "fan_min_speed",
        c.fan_min,
        format!("{} needs at least {}% part cooling", mat, opt(c.fan_min)),
        &c.src,
    );
    put(
        &mut out,
        "fan_max_speed",
        c.fan_max,
        format!("{} tops out at {}% part cooling", mat, opt(c.fan_max)),
        &c.src,
    );
    put(
        &mut out,
        "overhang_fan_speed",
        c.overhang_fan,
        format!("{} uses {}% fan on overhangs", mat, opt(c.overhang_fan)),
        &c.src,
    );
    let no_fan = c
        .no_fan_layers
        .or_else(|| m.first_layer.as_ref().and_then(|f| f.fan_off_layers));
    put(
        &mut out,
        "close_fan_the_first_x_layers",
        no_fan,
        format!("{} keeps the fan off for {} layers", mat, opt(no_fan)),
        match (&m.first_layer, c.no_fan_layers) {
            (Some(f), None) => &f.src,
            _ => &c.src,
        },
    );
    let first_speed = m.first_layer.as_ref().and_then(|f| f.speed);
    put(
        &mut out,
        "initial_layer_speed",
        first_speed,
        format!(
            "{} prints its first layer at about {} mm/s",
            mat,
            opt(first_speed)
        ),
        m.first_layer.as_ref().map_or(&[][..], |f| f.src.as_slice()),
    );
    put(
        &mut out,
        "slow_down_layer_time",
        c.min_layer_time,
        format!("{} needs {} s per layer to cool", mat, opt(c.min_layer_time)),
        &c.src,
    );
    if let Some(fr) = &m.flow_ratio {
        put(
            &mut out,
            "filament_flow_ratio",
            Some(fr.typical),
            format!("{} extrudes at a {} flow ratio", mat, show(fr.typical)),
            &fr.src,
        );
    }
    let hf = setup.hotend.as_deref() == Some("high_flow");
    let flow = if hf {
        m.max_flow.high_flow.or(m.max_flow.standard)
    } else {
        m.max_flow.standard
    };
    put(
        &mut out,
        "filament_max_volumetric_speed",
        flow,
        format!(
            "{} melts about {} mm3/s on a {} hotend",
            mat,
            opt(flow),
            if hf { "high flow" } else { "standard" }
        ),
        &m.max_flow.src,
    );
    let direct = p
        .and_then(|p| p.extruder.as_deref())
        .map(|e| e.contains("direct"));
    if direct != Some(false) {
        put(
            &mut out,
            "retraction_length",
            m.retraction.direct_drive,
            format!(
                "{} retracts {} mm on a direct drive extruder",
                mat,
                opt(m.retraction.direct_drive)
            ),
            &m.retraction.src,
        );
    }
    if direct != Some(false) {
        let rs = m.retraction_speed.as_ref();
        put(
            &mut out,
            "retraction_speed",
            rs.map(|r| r.typical),
            format!("{} retracts at about {} mm/s", mat, opt(rs.map(|r| r.typical))),
            rs.map_or(&[][..], |r| r.src.as_slice()),
        );
    }
    let pa = if direct == Some(false) {
        m.pressure_advance.bowden
    } else {
        m.pressure_advance.direct_drive
    };
    if !p
        .and_then(|p| p.vendor.as_deref())
        .is_some_and(|v| v.to_lowercase().contains("bambu"))
    {
        put(
            &mut out,
            "pressure_advance",
            pa,
            format!(
                "{} starts at a pressure advance of {} on {} extruder",
                mat,
                opt(pa),
                if direct == Some(false) {
                    "a bowden"
                } else {
                    "a direct drive"
                }
            ),
            &m.pressure_advance.src,
        );
    }
    put(
        &mut out,
        "filament_density",
        m.density,
        format!("{} weighs {} g/cm3", mat, opt(m.density)),
        &[],
    );
    if let Some(t) = &m.orca_type {
        out.insert(
            "filament_type".into(),
            Derived {
                shaped: None,
                value: Scalar::Str(t.clone()),
                because: format!("{mat} is type {t} in Orca"),
                src: Vec::new(),
                origin: "filament",
            },
        );
    }
    for (k, v) in &m.pilot_defaults {
        let (because, src) = match out.get(k) {
            Some(prev) => (prev.because.clone(), prev.src.clone()),
            None => (
                format!(
                    "{} default for {}",
                    mat,
                    setting_def(k).map_or(k.as_str(), |d| d.label.as_str())
                ),
                m.nozzle_temp
                    .as_ref()
                    .map(|t| t.src.iter().take(2).cloned().collect())
                    .unwrap_or_default(),
            ),
        };
        let value = match v {
            Json::Number(n) => n.as_f64().map(Scalar::Num),
            Json::Bool(b) => Some(Scalar::Bool(*b)),
            Json::String(s) => Some(Scalar::Str(s.clone())),
            _ => None,
        };
        if let Some(value) = value {
            out.insert(
                k.clone(),
                Derived {
                    shaped: None,
                    value,
                    because,
                    src,
                    origin: "filament",
                },
            );
        }
    }
    out
}

/// Problems with the new setup that are worth showing but do not stop the plan.
fn setup_warnings(setup: &SetupRef) -> Vec<String> {
    let kb = knowledge();
    let mut out = Vec::new();
    let m = kb.materials.get(&setup.filament);
    let p = kb.printers.get(&setup.printer);
    if p.is_none() {
        out.push(format!("Unknown printer \"{}\".", setup.printer));
    }
    if m.is_none() {
        out.push(format!("Unknown filament \"{}\".", setup.filament));
    }
    if let Some(p) = p {
        if let Some(sizes) = &p.hotend.nozzle_diameters
            && !sizes
                .iter()
                .any(|d| (*d - setup.nozzle_diameter).abs() < f64::EPSILON)
        {
            let list: Vec<String> = sizes.iter().map(|d| show(*d)).collect();
            out.push(format!(
                "{} has no {} mm nozzle option ({} mm).",
                p.name,
                show(setup.nozzle_diameter),
                list.join(", ")
            ));
        }
        if let Some(m) = m {
            if p.materials.not_recommended.contains(&setup.filament) {
                out.push(format!("{} is not recommended for {}.", p.name, m.name));
            } else if p.materials.unlisted.contains(&setup.filament) {
                out.push(format!(
                    "{} is not listed for the {}; treat it as untested.",
                    m.name, p.name
                ));
            }
        }
    }
    if let Some(m) = m {
        let t = m.nozzle_temp.as_ref();
        if let (Some(max), Some(min)) = (p.and_then(|p| p.hotend.max_temp), t.and_then(|t| t.min))
            && max < min
        {
            out.push(format!(
                "The {} hotend reaches {} C, below the {} C {} needs.",
                p.map_or("", |p| p.name.as_str()),
                show(max),
                show(min),
                short_name(&m.name)
            ));
        }
        if let (Some(max), Some(min)) = (
            p.and_then(|p| p.bed.max_temp),
            m.bed_temp.as_ref().and_then(|b| b.min),
        ) && max < min
        {
            out.push(format!(
                "The {} bed reaches {} C, below the {} C {} needs.",
                p.map_or("", |p| p.name.as_str()),
                show(max),
                show(min),
                short_name(&m.name)
            ));
        }
        if let Some(min) = m.nozzle.min_diameter
            && setup.nozzle_diameter < min
        {
            out.push(format!(
                "{} needs a nozzle of at least {} mm.",
                short_name(&m.name),
                show(min)
            ));
        }
        if m.enclosure.as_deref() == Some("required")
            && let Some(p) = p
            && let Some(kind) = p.enclosure.kind.as_deref()
            && kind != "enclosed"
        {
            out.push(format!(
                "{} needs an enclosure and the {} is {}.",
                short_name(&m.name),
                p.name,
                kind.replace('_', " ")
            ));
        }
        if matches!(m.drying_need.as_deref(), Some("required" | "recommended")) {
            out.push(format!(
                "Dry {} before printing ({}).",
                short_name(&m.name),
                m.drying_need.as_deref().unwrap_or("")
            ));
        }
    }
    out
}

/// An abrasive material on a soft nozzle stops the plan.
fn blockers_for(setup: &SetupRef) -> Vec<String> {
    let kb = knowledge();
    let Some(m) = kb
        .materials
        .get(&setup.filament)
        .filter(|m| m.nozzle.hardened_required)
    else {
        return Vec::new();
    };
    let p = kb.printers.get(&setup.printer);
    let fitted = setup.nozzle_material.clone().or_else(|| {
        p.and_then(|p| p.hotend.stock_nozzle.as_ref())
            .and_then(|s| s.material.clone())
    });
    let Some(fitted) = fitted else {
        return Vec::new();
    };
    if fitted == "hardened_steel" || fitted == "tungsten_carbide" {
        return Vec::new();
    }
    let options = if p
        .and_then(|p| p.hotend.nozzle_materials.as_ref())
        .is_some_and(|l| l.iter().any(|x| x == "hardened_steel"))
    {
        " A hardened steel nozzle is available for it."
    } else {
        ""
    };
    vec![format!(
        "{} is abrasive and wears a {} nozzle quickly; fit a hardened steel nozzle first.{}",
        short_name(&m.name),
        fitted.replace('_', " "),
        options
    )]
}

fn points_from(s: &str) -> Vec<[f64; 2]> {
    s.split(',')
        .map(|p| {
            let mut it = p.split('x');
            let x = it.next().and_then(|v| v.parse().ok()).unwrap_or(f64::NAN);
            let y = it.next().and_then(|v| v.parse().ok()).unwrap_or(f64::NAN);
            [x, y]
        })
        .collect()
}

fn list_len(base: Option<&Value>, def: Option<&SettingDef>) -> usize {
    let from_base = match base {
        Some(Value::Floats(a)) => a.len(),
        Some(Value::Ints(a)) => a.len(),
        Some(Value::Strs(a)) => a.len(),
        Some(Value::Bools(a)) => a.len(),
        _ => 0,
    };
    if from_base > 0 {
        return from_base;
    }
    match def.map(|d| &d.default) {
        Some(Json::Array(a)) if !a.is_empty() => a.len(),
        _ => 1,
    }
}

/// Write a plain number or string in the shape the key uses, following a base list's length.
pub(crate) fn shape_for(def: Option<&SettingDef>, v: &Scalar, base: Option<&Value>) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    let int = |n: f64| js_round(n) as i64;
    if let Some(d) = def {
        match (d.kind, v) {
            (SettingType::Floats | SettingType::Percents, Scalar::Num(n)) => {
                return Value::Floats(vec![*n; list_len(base, def)]);
            }
            (SettingType::Ints, Scalar::Num(n)) => {
                return Value::Ints(vec![int(*n); list_len(base, def)]);
            }
            (SettingType::Strings | SettingType::Enums, Scalar::Str(s)) => {
                return Value::Strs(vec![s.clone(); list_len(base, def)]);
            }
            (SettingType::Bools, Scalar::Bool(b)) => {
                return Value::Bools(vec![*b; list_len(base, def)]);
            }
            (SettingType::Int, Scalar::Num(n)) => return Value::Int(int(*n)),
            (SettingType::Points, Scalar::Str(s)) => return Value::Points(points_from(s)),
            (SettingType::Point, Scalar::Str(s)) => {
                return Value::Point(points_from(s).first().copied().unwrap_or([f64::NAN, f64::NAN]));
            }
            _ => {}
        }
    }
    match v {
        Scalar::Num(n) => Value::Float(*n),
        Scalar::Str(s) => Value::Str(s.clone()),
        Scalar::Bool(b) => Value::Bool(*b),
    }
}

fn first_scalar(v: Option<&Value>) -> Option<Scalar> {
    v.and_then(Value::first_scalar)
}

/// Numbers inside a value, when it is a number or a non-empty list of numbers.
fn numbers_of(v: &Value) -> Option<Vec<f64>> {
    match v {
        Value::Int(i) =>
        {
            #[allow(clippy::cast_precision_loss)]
            Some(vec![*i as f64])
        }
        Value::Float(f) => Some(vec![*f]),
        Value::Ints(x) if !x.is_empty() =>
        {
            #[allow(clippy::cast_precision_loss)]
            Some(x.iter().map(|i| *i as f64).collect())
        }
        Value::Floats(x) if !x.is_empty() => Some(x.clone()),
        _ => None,
    }
}

fn map_numbers(v: &Value, f: &dyn Fn(f64) -> f64) -> Value {
    match v {
        Value::Int(_) | Value::Float(_) => Value::Float(v.first_f64().map_or(f64::NAN, f)),
        Value::Ints(_) | Value::Floats(_) => {
            Value::Floats(numbers_of(v).unwrap_or_default().into_iter().map(f).collect())
        }
        other => other.clone(),
    }
}

/// Layer height and line widths keep their share of the nozzle when the nozzle changes.
fn nozzle_scaling(from: &SetupRef, to: &SetupRef, base: Option<&PrintConfig>) -> BTreeMap<String, Derived> {
    let mut out = BTreeMap::new();
    let Some(base) = base else { return out };
    if (from.nozzle_diameter - to.nozzle_diameter).abs() < f64::EPSILON || from.nozzle_diameter <= 0.0 {
        return out;
    }
    let ratio = to.nozzle_diameter / from.nozzle_diameter;
    let because = format!(
        "keeps the same share of the nozzle ({} to {} mm)",
        show(from.nozzle_diameter),
        show(to.nozzle_diameter)
    );
    if let Some(lh) = number_of(base, "layer_height", false) {
        let stepped = snap(js_round(lh * ratio / 0.02) * 0.02);
        let v = snap(
            stepped
                .max(0.2 * to.nozzle_diameter)
                .min(0.75 * to.nozzle_diameter),
        );
        out.insert(
            "layer_height".into(),
            Derived {
                shaped: None,
                value: Scalar::Num(v),
                because: format!("layer height {because}"),
                src: Vec::new(),
                origin: "nozzle",
            },
        );
        if number_of(base, "initial_layer_print_height", false).is_some() {
            out.insert(
                "initial_layer_print_height".into(),
                Derived {
                    shaped: None,
                    value: Scalar::Num(snap(v.max(0.5 * to.nozzle_diameter))),
                    because: "first layer height follows the nozzle and layer height".to_owned(),
                    src: Vec::new(),
                    origin: "nozzle",
                },
            );
        }
    }
    for k in ["smart_layer_min_height", "smart_layer_max_height"] {
        if let Some(v) = number_of(base, k, false) {
            out.insert(
                k.to_owned(),
                Derived {
                    shaped: None,
                    value: Scalar::Num(snap(js_round(v * ratio / LAYER_STEP) * LAYER_STEP)),
                    because: format!("the bound {because}"),
                    src: Vec::new(),
                    origin: "nozzle",
                },
            );
        }
    }
    for k in WIDTH_KEYS {
        let Some(Value::Str(raw)) = base.get(k) else {
            continue;
        };
        if raw.ends_with('%') {
            continue;
        }
        if let Ok(w) = raw.trim().parse::<f64>()
            && w > 0.0
            && w.is_finite()
        {
            out.insert(
                k.to_owned(),
                Derived {
                    shaped: None,
                    value: Scalar::Str(show(snap(js_round(w * ratio * 100.0) / 100.0))),
                    because: format!("line width {because}"),
                    src: Vec::new(),
                    origin: "nozzle",
                },
            );
        }
    }
    out
}

/// Keeps the sleipnir bounds inside the window the nozzle (and the material's research) allows.
fn smart_layer_fit(
    to: &SetupRef,
    m: Option<&MaterialKnowledge>,
    get: &dyn Fn(&str) -> Option<Value>,
) -> BTreeMap<String, Derived> {
    let mut out = BTreeMap::new();
    let Some(Scalar::Str(mode)) = first_scalar(get("smart_layer").as_ref()) else {
        return out;
    };
    if !is_smart_layer_on(&mode) {
        return out;
    }
    let (wmin, wmax) = smart_layer_window(to.nozzle_diameter, m, Some(mode.as_str()));
    let l = smart_layer_limits(m, Some(mode.as_str()));
    let num = |k: &str| match first_scalar(get(k).as_ref()) {
        Some(Scalar::Num(n)) => Some(n),
        _ => None,
    };
    let (min, max) = (num("smart_layer_min_height"), num("smart_layer_max_height"));
    let (mut nmin, mut nmax) = (min, max);
    if nmin.is_some_and(|v| v < wmin) {
        nmin = Some(wmin);
    }
    if nmax.is_some_and(|v| v > wmax) {
        nmax = Some(wmax);
    }
    if let (Some(lo), Some(hi)) = (nmin, nmax)
        && hi < snap(lo + LAYER_STEP)
    {
        nmax = Some(snap(lo + LAYER_STEP));
    }
    let research = m.filter(|m| m.smart_layer.is_some()).map_or(String::new(), |m| {
        format!(", from the research on {}", short_name(&m.name))
    });
    let because = format!(
        "sleipnir stays between {} and {} percent of the {} mm nozzle{}",
        show((l.min_ratio * 100.0).round()),
        show((l.max_ratio * 100.0).round()),
        show(to.nozzle_diameter),
        research
    );
    let origin = if m.is_some_and(|m| m.smart_layer.is_some()) {
        "filament"
    } else {
        "nozzle"
    };
    for (key, new, old) in [
        ("smart_layer_min_height", nmin, min),
        ("smart_layer_max_height", nmax, max),
    ] {
        if let Some(v) = new
            && Some(v) != old
        {
            out.insert(
                key.to_owned(),
                Derived {
                    shaped: None,
                    value: Scalar::Num(v),
                    because: because.clone(),
                    src: l.src.clone(),
                    origin,
                },
            );
        }
    }
    out
}

const SPEED_CAP_KEYS: [&str; 6] = [
    "outer_wall_speed",
    "inner_wall_speed",
    "sparse_infill_speed",
    "internal_solid_infill_speed",
    "top_surface_speed",
    "gap_infill_speed",
];
const FIRST_LAYER_SPEED_KEYS: [&str; 2] = ["initial_layer_speed", "initial_layer_infill_speed"];

/// The most a material lets a speed key reach, when its data sheet or the research says.
fn speed_cap(key: &str, m: Option<&MaterialKnowledge>) -> Option<f64> {
    let s = m?.speeds.as_ref()?;
    if key == "outer_wall_speed" {
        return s.outer_wall_max.or(s.print_max);
    }
    if FIRST_LAYER_SPEED_KEYS.contains(&key) {
        return s.first_layer_max;
    }
    if SPEED_CAP_KEYS.contains(&key) {
        s.print_max
    } else {
        None
    }
}

/// The thinnest and thickest layer the material's safe band allows on this nozzle, on the layer step grid.
fn layer_window(to: &SetupRef, m: Option<&MaterialKnowledge>) -> Option<(f64, f64)> {
    let band = m?.layer_band.as_ref()?;
    let (bmin, bmax) = (band.min?, band.max?);
    let n = to.nozzle_diameter;
    Some((
        snap((snap(bmin * n / LAYER_STEP) - 1e-9).ceil() * LAYER_STEP),
        snap((snap(bmax * n / LAYER_STEP) + 1e-9).floor() * LAYER_STEP),
    ))
}

/// (lowest, highest) a material allows for a key: the layer height band, or a speed ceiling.
fn material_cap(key: &str, to: &SetupRef, m: Option<&MaterialKnowledge>) -> Option<(f64, f64)> {
    if key == "layer_height" {
        return layer_window(to, m);
    }
    speed_cap(key, m).map(|cap| (f64::NEG_INFINITY, cap))
}

/// Moves layer height and speeds that break the material's band or ceilings, elementwise on per extruder lists.
fn material_limits(
    to: &SetupRef,
    m: Option<&MaterialKnowledge>,
    get: &dyn Fn(&str) -> Option<Value>,
) -> BTreeMap<String, Derived> {
    let mut out = BTreeMap::new();
    let Some(m) = m else { return out };
    let mat = short_name(&m.name).to_owned();
    for key in std::iter::once("layer_height")
        .chain(SPEED_CAP_KEYS)
        .chain(FIRST_LAYER_SPEED_KEYS)
    {
        let (Some((lo, hi)), Some(v)) = (material_cap(key, to, Some(m)), get(key)) else {
            continue;
        };
        let Some(nums) = numbers_of(&v) else { continue };
        if !nums.iter().any(|n| *n < lo - 1e-9 || *n > hi + 1e-9) {
            continue;
        }
        let shaped = map_numbers(&v, &|n| n.max(lo).min(hi));
        let band = m.layer_band.as_ref();
        let because = if key == "layer_height" && band.is_some() {
            let b = band.cloned().unwrap_or_default();
            format!(
                "{} layers stay between {} and {} percent of the {} mm nozzle",
                mat,
                show((b.min.unwrap_or(0.0) * 100.0).round()),
                show((b.max.unwrap_or(0.0) * 100.0).round()),
                show(to.nozzle_diameter)
            )
        } else {
            format!("{} should not print faster than {} mm/s here", mat, show(hi))
        };
        let src = if key == "layer_height" {
            band.map(|b| b.src.clone()).unwrap_or_default()
        } else {
            m.speeds.as_ref().map(|s| s.src.clone()).unwrap_or_default()
        };
        let first = first_scalar(Some(&shaped)).unwrap_or(Scalar::Num(f64::NAN));
        out.insert(
            key.to_owned(),
            Derived {
                shaped: Some(shaped),
                value: first,
                because,
                src,
                origin: "filament",
            },
        );
    }
    out
}

/// The printer's hardware limit for a key, when it has one.
fn printer_limit(key: &str, def: Option<&SettingDef>, p: Option<&PrinterKnowledge>) -> Option<f64> {
    let p = p?;
    if key.contains("plate_temp") {
        return p.bed.max_temp;
    }
    if matches!(
        key,
        "nozzle_temperature" | "nozzle_temperature_initial_layer" | "nozzle_temperature_range_high"
    ) {
        return p.hotend.max_temp;
    }
    if key == "filament_max_volumetric_speed" {
        return p.hotend.max_flow;
    }
    let unit = def.and_then(|d| d.unit.as_deref());
    if unit == Some("mm/s2") {
        return p.motion.max_accel;
    }
    if unit == Some("mm/s") && def.is_some_and(|d| d.section == Section::Process) {
        return p.motion.max_speed;
    }
    None
}

/// The filament's documented range for a key: (min, max).
fn filament_range(key: &str, setup: &SetupRef, m: Option<&MaterialKnowledge>) -> Option<(f64, f64)> {
    let m = m?;
    let prefix: String = if key.contains("plate_temp") {
        "bed_temp_c".into()
    } else {
        match key {
            "nozzle_temperature" => "nozzle_temp_c".into(),
            "nozzle_temperature_initial_layer" => "first_layer_nozzle_temp_c".into(),
            "fan_min_speed" => "cooling.fan_min_pct".into(),
            "fan_max_speed" => "cooling.fan_max_pct".into(),
            "slow_down_layer_time" => "cooling.min_layer_time_s".into(),
            "filament_flow_ratio" => "extrusion.flow_ratio".into(),
            "filament_max_volumetric_speed" => format!(
                "extrusion.max_volumetric_speed_mm3s.{}",
                if setup.hotend.as_deref() == Some("high_flow") {
                    "high_flow_hotend"
                } else {
                    "standard_hotend"
                }
            ),
            "retraction_length" => "extrusion.retraction_mm.direct_drive".into(),
            "pressure_advance" => "extrusion.pressure_advance.direct_drive".into(),
            _ => return None,
        }
    };
    Some((
        *m.paths.get(&format!("{prefix}.min"))?,
        *m.paths.get(&format!("{prefix}.max"))?,
    ))
}

fn normalize(v: &Json, def: Option<&SettingDef>) -> Option<Scalar> {
    let s = match v {
        Json::Number(n) => Scalar::Num(n.as_f64()?),
        Json::String(s) => Scalar::Str(s.clone()),
        Json::Bool(b) => Scalar::Bool(*b),
        _ => return None,
    };
    if let (Scalar::Str(t), Some(d)) = (&s, def)
        && matches!(d.kind, SettingType::Percent | SettingType::Percents)
        && let Ok(n) = t.replace('%', "").parse::<f64>()
    {
        return Some(Scalar::Num(n));
    }
    Some(s)
}

type SetFn<'a> = dyn FnMut(
        &mut BTreeMap<String, Pending>,
        &str,
        Value,
        &str,
        String,
        Vec<String>,
        Option<String>,
        Option<String>,
    ) + 'a;

struct Pending {
    value: Value,
    origin: String,
    reason: String,
    src: Vec<String>,
    goal: Option<String>,
    priority: Option<String>,
}

fn json_default(def: Option<&SettingDef>) -> Option<Value> {
    Value::from_json(&def?.default)
}

/// What to change in a config when the material, printer or nozzle changes, or when goals are given.
/// `base` is the config in use: where it has a value that is the "before"; otherwise the old setup's
/// knowledge value is. Pass `opts.target` (the merged Orca profile for the new setup) to start from it.
#[must_use]
#[allow(clippy::too_many_lines, clippy::cognitive_complexity)]
pub fn plan_settings(
    from: &SetupRef,
    to: &SetupRef,
    base: Option<&PrintConfig>,
    opts: &PlanOptions,
) -> SettingsPlan {
    let started = std::time::Instant::now();
    let kb = knowledge();
    let m = kb.materials.get(&to.filament);
    let p = kb.printers.get(&to.printer);
    let mut warnings = setup_warnings(to);
    let mut questions: Vec<String> = Vec::new();
    let mut advice: Vec<PlanAdvice> = Vec::new();
    let mut caveats: Vec<PlanCaveat> = Vec::new();
    let mut tell_user: Vec<String> = Vec::new();
    let mut clamps: Vec<PlanClamp> = Vec::new();
    let mut refused: Vec<PlanRefusal> = Vec::new();
    let blockers = blockers_for(to);
    let ms = |started: std::time::Instant| (started.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0;
    let empty = |warnings,
                 clamps,
                 refused,
                 blockers,
                 questions,
                 caveats,
                 advice,
                 tell_user,
                 started: std::time::Instant| SettingsPlan {
        from: from.clone(),
        to: to.clone(),
        changes: Vec::new(),
        unresolved: Vec::new(),
        warnings,
        clamps,
        refused,
        blockers,
        questions,
        caveats,
        advice,
        tell_user,
        computed_ms: ms(started),
    };
    if let Some(m) = m
        && m.drying_need.as_deref() == Some("required")
    {
        questions.push(format!(
            "Has the {} spool been dried in the last day? {} is marked drying required.",
            short_name(&m.name),
            short_name(&m.name)
        ));
    }
    if m.is_some() && to.filament.starts_with("tpu") {
        questions.push("Is the TPU fed from an external spool? It should not go through the AMS unless it is a TPU for AMS product.".to_owned());
    }
    if !blockers.is_empty() {
        if to.nozzle_material.is_none() && m.is_some_and(|m| m.nozzle.hardened_required) {
            questions.push("Is the nozzle hardened steel?".to_owned());
        }
        return empty(
            warnings, clamps, refused, blockers, questions, caveats, advice, tell_user, started,
        );
    }
    if m.is_some_and(|m| m.nozzle.hardened_required)
        && to.nozzle_material.is_none()
        && p.and_then(|p| p.hotend.stock_nozzle.as_ref())
            .and_then(|s| s.material.as_ref())
            .is_none()
    {
        questions.push(
            "Is the nozzle hardened steel? Abrasive filament wears brass and stainless nozzles quickly."
                .to_owned(),
        );
    }

    let from_d = derive(from);
    let cur = |key: &str| -> Option<Value> {
        if let Some(b) = base.and_then(|b| b.get(key)) {
            return Some(b.clone());
        }
        from_d
            .get(key)
            .map(|d| shape_for(setting_def(key), &d.value, None))
    };
    let mut pend: BTreeMap<String, Pending> = BTreeMap::new();
    let mut set = |pend: &mut BTreeMap<String, Pending>,
                   key: &str,
                   value: Value,
                   origin: &str,
                   reason: String,
                   src: Vec<String>,
                   goal: Option<String>,
                   priority: Option<String>| {
        if opts.keep.contains(key) && origin != "intent" && origin != "calibration" {
            return;
        }
        pend.insert(
            key.to_owned(),
            Pending {
                value,
                origin: origin.to_owned(),
                reason,
                src,
                goal,
                priority,
            },
        );
    };

    // 1. The Orca profile for the target, or the printer's baseline process.
    if let Some(target) = &opts.target {
        for (key, v) in target.iter() {
            let Some(def) = setting_def(key) else {
                continue;
            };
            let origin = if key == "nozzle_diameter" {
                "nozzle"
            } else if def.section == Section::Filament {
                "filament"
            } else {
                "printer"
            };
            set(
                &mut pend,
                key,
                v.clone(),
                origin,
                format!(
                    "{} comes from the {} profile.",
                    def.label,
                    p.map_or("target", |p| p.name.as_str())
                ),
                Vec::new(),
                None,
                None,
            );
        }
    } else if let Some(bl) = p.and_then(|p| p.baseline.as_ref().map(|b| (p, b)))
        && (from.printer != to.printer || base.is_none())
    {
        let (p, baseline) = bl;
        for (key, raw) in &baseline.values {
            if (from.nozzle_diameter - to.nozzle_diameter).abs() >= f64::EPSILON
                && (key == "layer_height" || key.ends_with("line_width"))
            {
                continue;
            }
            let def = setting_def(key);
            let Some(v) = normalize(raw, def) else {
                continue;
            };
            set(
                &mut pend,
                key,
                shape_for(def, &v, base.and_then(|b| b.get(key))),
                "printer",
                format!(
                    "{} comes from the {} default process ({}).",
                    def.map_or(key.as_str(), |d| d.label.as_str()),
                    p.name,
                    p.baseline_process.as_deref().unwrap_or("baseline")
                ),
                baseline.src.clone(),
                None,
                None,
            );
        }
    }

    // 2. Filament and printer facts, except where a printer specific profile set the key.
    let to_d = derive(to);
    let overlay = |pend: &mut BTreeMap<String, Pending>, map: &BTreeMap<String, Derived>, set: &mut SetFn| {
        for (key, d) in map {
            if opts.tuned.contains(key) {
                continue;
            }
            let def = setting_def(key);
            let shape_base = pend
                .get(key)
                .map(|p| p.value.clone())
                .or_else(|| base.and_then(|b| b.get(key)).cloned());
            let value = d
                .shaped
                .clone()
                .unwrap_or_else(|| shape_for(def, &d.value, shape_base.as_ref()));
            let shown = format_value(
                def,
                Some(&d.shaped.clone().unwrap_or_else(|| shape_for(def, &d.value, None))),
            );
            set(
                pend,
                key,
                value,
                d.origin,
                format!(
                    "{} becomes {}: {}.",
                    def.map_or(key.as_str(), |x| x.label.as_str()),
                    shown,
                    d.because
                ),
                d.src.clone(),
                None,
                None,
            );
        }
    };
    overlay(&mut pend, &to_d, &mut set);
    overlay(&mut pend, &nozzle_scaling(from, to, base), &mut set);
    let fit = smart_layer_fit(to, m, &|k| {
        pend.get(k)
            .map(|p| p.value.clone())
            .or_else(|| base.and_then(|b| b.get(k)).cloned())
    });
    overlay(&mut pend, &fit, &mut set);
    let limits = material_limits(to, m, &|k| {
        pend.get(k)
            .map(|p| p.value.clone())
            .or_else(|| base.and_then(|b| b.get(k)).cloned())
    });
    overlay(&mut pend, &limits, &mut set);

    // 3. Stored calibration results for this spool, printer and nozzle.
    for cal in &opts.calibrations {
        if cal.printer.as_ref().is_some_and(|x| x != &to.printer)
            || cal.filament.as_ref().is_some_and(|x| x != &to.filament)
        {
            continue;
        }
        if cal
            .nozzle_diameter
            .is_some_and(|n| (n - to.nozzle_diameter).abs() >= f64::EPSILON)
        {
            continue;
        }
        for w in kb.calibrations.get(&cal.id).into_iter().flatten() {
            let vf = w.value_from.as_ref();
            let raw: Option<Scalar> = match w.op.as_str() {
                "enable" => Some(Scalar::Bool(true)),
                "disable" => Some(Scalar::Bool(false)),
                _ => match vf.and_then(|v| v.field.as_ref()) {
                    Some(field) => cal.values.get(field).map(|n| Scalar::Num(*n)),
                    None => match &w.value {
                        Some(Json::Number(n)) => n.as_f64().map(Scalar::Num),
                        Some(Json::String(s)) => Some(Scalar::Str(s.clone())),
                        Some(Json::Bool(b)) => Some(Scalar::Bool(*b)),
                        _ => None,
                    },
                },
            };
            let Some(raw) = raw else { continue };
            let value = match raw {
                Scalar::Num(n) => Scalar::Num(snap(n * vf.and_then(|v| v.factor).unwrap_or(1.0))),
                other => other,
            };
            let def = setting_def(&w.key);
            let shape_base = pend
                .get(&w.key)
                .map(|p| p.value.clone())
                .or_else(|| base.and_then(|b| b.get(&w.key)).cloned());
            let shown = format_value(def, Some(&shape_for(def, &value, None)));
            set(
                &mut pend,
                &w.key,
                shape_for(def, &value, shape_base.as_ref()),
                "calibration",
                format!(
                    "{} Stored {} result: {}.",
                    w.why.as_deref().unwrap_or("From the calibration result."),
                    cal.id.replace('_', " "),
                    shown
                ),
                Vec::new(),
                None,
                None,
            );
        }
    }

    // 4. The merged intent goals.
    if let Some(intent) = opts.intent.as_ref().filter(|i| !i.goals.is_empty()) {
        let scalar = |key: &str| -> Option<Scalar> {
            first_scalar(pend.get(key).map(|p| &p.value).or(None))
                .or_else(|| first_scalar(cur(key).as_ref()))
                .or_else(|| first_scalar(json_default(setting_def(key)).as_ref()))
        };
        let r = merge_intent(
            intent,
            &IntentContext {
                to,
                material: m,
                scalar: &scalar,
                calibrations: &opts.calibrations,
            },
        );
        for (key, iv) in &r.values {
            let def = setting_def(key);
            let shape_base = pend
                .get(key)
                .map(|p| p.value.clone())
                .or_else(|| base.and_then(|b| b.get(key)).cloned());
            set(
                &mut pend,
                key,
                shape_for(def, &iv.value, shape_base.as_ref()),
                "intent",
                iv.reason.clone(),
                iv.src.clone(),
                Some(iv.goal.clone()),
                Some(iv.priority.clone()),
            );
        }
        tell_user.extend(r.tell_user);
        advice.extend(r.advice);
        caveats.extend(r.caveats);
        questions.extend(r.questions);
        warnings.extend(r.warnings);
    }

    // sleipnir notes for this material.
    let smart_mode = first_scalar(
        pend.get("smart_layer")
            .map(|p| &p.value)
            .or_else(|| base.and_then(|b| b.get("smart_layer"))),
    );
    if let (Some(notes), Some(Scalar::Str(mode))) =
        (m.and_then(|m| m.smart_layer_notes.as_ref()), smart_mode.clone())
        && is_smart_layer_on(&mode)
    {
        let mut add = |text: &Option<String>| {
            if let Some(t) = text.as_ref().filter(|t| !t.is_empty()) {
                advice.push(PlanAdvice {
                    text: t.clone(),
                    kind: "material".to_owned(),
                    sources: notes.src.clone(),
                });
            }
        };
        if mode == "quality" {
            add(&notes.quality);
        }
        if mode == "strength" {
            add(&notes.strength);
        }
        add(&notes.thin_layer_cooling);
    }

    let mat = m.map_or(String::new(), |m| short_name(&m.name).to_owned());
    let now = |pend: &BTreeMap<String, Pending>, key: &str| -> Option<Value> {
        pend.get(key)
            .map(|p| p.value.clone())
            .or_else(|| base.and_then(|b| b.get(key)).cloned())
    };
    let now_num = |pend: &BTreeMap<String, Pending>, key: &str| -> Option<f64> {
        match first_scalar(now(pend, key).as_ref()) {
            Some(Scalar::Num(n)) if n.is_finite() => Some(n),
            _ => None,
        }
    };
    let switched = from.filament != to.filament;
    let smart_on = matches!(&smart_mode, Some(Scalar::Str(s)) if is_smart_layer_on(s));
    let nz = |s: &Option<String>| -> Option<String> { s.clone().filter(|s| !s.is_empty()) };
    let note = |advice: &mut Vec<PlanAdvice>, text: String, kind: &str, sources: &[String]| {
        advice.push(PlanAdvice {
            text,
            kind: kind.to_owned(),
            sources: sources.to_vec(),
        });
    };

    // Thin layers: the minimum layer time guard, and the heat creep warning.
    if let (Some(g), true) = (layer_time_guard(m), smart_on) {
        if now_num(&pend, "slow_down_layer_time").is_none_or(|lt| lt < g.min_layer_time) {
            let cur_v = now(&pend, "slow_down_layer_time");
            let v = shape_for(
                setting_def("slow_down_layer_time"),
                &Scalar::Num(g.min_layer_time),
                cur_v.as_ref(),
            );
            set(
                &mut pend,
                "slow_down_layer_time",
                v,
                "filament",
                format!(
                    "sleipnir prints thin layers, and {} needs at least {} s per layer to cool them.",
                    mat,
                    show(g.min_layer_time)
                ),
                g.src.clone(),
                None,
                None,
            );
        }
        if matches!(
            first_scalar(now(&pend, "slow_down_for_layer_cooling").as_ref()),
            Some(Scalar::Bool(false))
        ) {
            let cur_v = now(&pend, "slow_down_for_layer_cooling");
            let v = shape_for(
                setting_def("slow_down_for_layer_cooling"),
                &Scalar::Bool(true),
                cur_v.as_ref(),
            );
            set(
                &mut pend,
                "slow_down_for_layer_cooling",
                v,
                "filament",
                "Thin layers need the cooling slowdown to stay at the minimum layer time.".to_owned(),
                g.src.clone(),
                None,
                None,
            );
        }
        if let Some(n) = nz(&g.note) {
            note(&mut advice, n, "material", &g.src);
        }
        note(
            &mut advice,
            "If many thin layers still fall under the minimum layer time, print more parts at once instead of slowing down further.".to_owned(),
            "workflow",
            &g.src,
        );
    }
    if !matches!(
        first_scalar(now(&pend, "slow_down_for_layer_cooling").as_ref()),
        Some(Scalar::Bool(false))
    ) {
        let min_speed = now_num(&pend, "slow_down_min_speed");
        let max_flow = now_num(&pend, "filament_max_volumetric_speed");
        let lh = now_num(&pend, "layer_height");
        let s_min = if smart_on {
            now_num(&pend, "smart_layer_min_height")
        } else {
            None
        };
        let thinnest = [lh, s_min]
            .into_iter()
            .flatten()
            .fold(None, |a: Option<f64>, h| Some(a.map_or(h, |a| a.min(h))));
        if let (Some(min_speed), Some(max_flow), Some(thinnest)) = (min_speed, max_flow, thinnest) {
            let width = match first_scalar(now(&pend, "outer_wall_line_width").as_ref()) {
                Some(Scalar::Str(s)) if s.ends_with('%') => {
                    s[..s.len() - 1].trim().parse::<f64>().unwrap_or(f64::NAN) / 100.0 * to.nozzle_diameter
                }
                Some(Scalar::Num(w)) if w > 0.0 => w,
                Some(Scalar::Str(s)) if s.trim().parse::<f64>().is_ok_and(|w| w > 0.0) => {
                    s.trim().parse::<f64>().unwrap_or(to.nozzle_diameter)
                }
                _ => to.nozzle_diameter,
            };
            if let Some(w) = heat_creep_warning(min_speed, width, thinnest, max_flow) {
                warnings.push(w);
            }
        }
    }

    // Support pairings: interface materials, the soluble partner, the Z gap and the interface layers.
    if let Some(sup) = m.and_then(|m| m.supports.as_ref())
        && matches!(
            first_scalar(now(&pend, "enable_support").as_ref()),
            Some(Scalar::Bool(true))
        )
    {
        if switched {
            let pairs = [
                (
                    "support_top_z_distance",
                    sup.top_z,
                    format!(
                        "{} supports sit {} mm above the model",
                        mat,
                        sup.top_z.map_or(String::new(), show)
                    ),
                ),
                (
                    "support_interface_top_layers",
                    sup.interface_layers,
                    format!(
                        "{} supports use {} interface layers",
                        mat,
                        sup.interface_layers.map_or(String::new(), show)
                    ),
                ),
            ];
            for (key, v, why) in pairs {
                let origin = pend.get(key).map(|p| p.origin.as_str());
                let Some(v) = v else { continue };
                if opts.tuned.contains(key) || matches!(origin, Some("intent" | "calibration")) {
                    continue;
                }
                let cur_v = now(&pend, key);
                let value = shape_for(setting_def(key), &Scalar::Num(v), cur_v.as_ref());
                set(
                    &mut pend,
                    key,
                    value,
                    "filament",
                    format!("{why}."),
                    sup.src.clone(),
                    None,
                    None,
                );
            }
        }
        let name_of = |id: &str| {
            kb.materials
                .get(id)
                .map_or_else(|| id.to_owned(), |x| short_name(&x.name).to_owned())
        };
        let names: Vec<String> = sup.interface_materials.iter().map(|id| name_of(id)).collect();
        if !names.is_empty() {
            let tail = nz(&sup.note).map_or(String::new(), |n| format!(" {n}"));
            note(
                &mut advice,
                format!(
                    "For cleaner supports under {}, use {} as the interface material.{}",
                    mat,
                    names.join(", "),
                    tail
                ),
                "material",
                &sup.src,
            );
        }
        if let Some(sol) = sup.soluble_material.as_deref().filter(|s| !s.is_empty()) {
            let dissolve =
                nz(&sup.soluble_dissolve).map_or(String::new(), |d| format!(" (dissolves in {d})"));
            note(
                &mut advice,
                format!("{} is the soluble support for {}{}.", name_of(sol), mat, dissolve),
                "material",
                &sup.src,
            );
        }
    }

    // First layer and structure hints for the new material.
    if let (Some(m), true) = (m, switched) {
        if let Some(f) = &m.first_layer {
            if let Some(t) = nz(&f.squish_note) {
                note(&mut advice, t, "material", &f.src);
            }
            if let Some(t) = nz(&f.bed_note) {
                note(&mut advice, t, "material", &f.src);
            }
        }
        if let Some(st) = &m.structure {
            if let Some(t) = nz(&st.walls_note) {
                note(&mut advice, t, "material", &st.src);
            }
            let (pattern, density) = (nz(&st.pattern_hint), nz(&st.density_note));
            if pattern.is_some() || density.is_some() {
                note(
                    &mut advice,
                    format!(
                        "{} infill: {}{}",
                        mat,
                        pattern.map_or("any pattern".to_owned(), |p| format!("{p} pattern")),
                        density.map_or(String::new(), |d| format!(". {d}"))
                    ),
                    "material",
                    &st.src,
                );
            }
        }
    }

    // 5 and 6. Diff against the current values, then clamp what remains.
    let mut changes: Vec<SettingChange> = Vec::new();
    for (key, pd) in &pend {
        let def = setting_def(key);
        let before = cur(key);
        if before
            .as_ref()
            .is_some_and(|b| same_value(Some(b), Some(&pd.value)))
        {
            continue;
        }
        if before.is_none()
            && base.is_none()
            && !from_d.contains_key(key)
            && pd.origin != "intent"
            && pd.origin != "calibration"
            && opts.target.is_none()
        {
            continue;
        }
        let klass = def.and_then(|d| d.pilot).map_or("read", |k| match k {
            crate::schema::PilotRule::Edit => "edit",
            crate::schema::PilotRule::Guarded => "guarded",
            crate::schema::PilotRule::Read => "read",
        });
        let label = def.map_or(key.clone(), |d| d.label.clone());
        let mut value = pd.value.clone();
        let mut reason = pd.reason.clone();
        let mut approval = "none";
        if klass == "read" && (pd.origin == "intent" || pd.origin == "calibration") {
            refused.push(PlanRefusal {
                key: key.clone(),
                requested: value,
                reason: format!("{label} is read only for mimir; change it in the profile."),
            });
            continue;
        }
        let nums = if klass == "read" { None } else { numbers_of(&value) };
        if let Some(nums) = nums.filter(|_| def.map(|d| d.kind) != Some(SettingType::FloatOrPercent)) {
            let (lo, hi) = (def.and_then(|d| d.min), def.and_then(|d| d.max));
            if lo.is_some_and(|l| nums.iter().any(|n| *n < l))
                || hi.is_some_and(|h| nums.iter().any(|n| *n > h))
            {
                let (l, h) = (lo.unwrap_or(f64::NEG_INFINITY), hi.unwrap_or(f64::INFINITY));
                let applied = map_numbers(&value, &|n| n.max(l).min(h));
                let limit = if lo.is_some_and(|l| nums.iter().any(|n| *n < l)) {
                    lo.unwrap_or(0.0)
                } else {
                    hi.unwrap_or(0.0)
                };
                clamps.push(PlanClamp {
                    key: key.clone(),
                    requested: value.clone(),
                    applied: applied.clone(),
                    by: "bounds".to_owned(),
                    limit,
                    reason: format!(
                        "{} is kept within {} to {}.",
                        label,
                        lo.map_or("no minimum".to_owned(), show),
                        hi.map_or("no maximum".to_owned(), show)
                    ),
                });
                value = applied;
            }
            let limit = printer_limit(key, def, p);
            let now = numbers_of(&value).unwrap_or_default();
            if let Some(limit) = limit
                && now.iter().any(|n| *n > limit)
            {
                let pname = p.map_or("printer", |p| p.name.as_str());
                if klass == "guarded" {
                    refused.push(PlanRefusal {
                        key: key.clone(),
                        requested: value.clone(),
                        reason: format!(
                            "{} is past the {} limit of {}.",
                            format_value(def, Some(&value)),
                            pname,
                            format_value(def, Some(&Value::Float(limit)))
                        ),
                    });
                    continue;
                }
                let applied = map_numbers(&value, &|n| n.min(limit));
                clamps.push(PlanClamp {
                    key: key.clone(),
                    requested: value.clone(),
                    applied: applied.clone(),
                    by: "printer".to_owned(),
                    limit,
                    reason: format!(
                        "{} is capped at the {} limit of {}.",
                        label,
                        pname,
                        format_value(def, Some(&Value::Float(limit)))
                    ),
                });
                value = applied;
            }
            let range = filament_range(key, to, m);
            let in_now = numbers_of(&value).unwrap_or_default();
            if let Some((rlo, rhi)) = range
                && in_now.iter().any(|n| *n < rlo || *n > rhi)
            {
                let mname = short_name(m.map_or("the filament", |m| m.name.as_str()));
                if klass == "guarded" {
                    approval = "ask";
                    let _ = write!(
                        reason,
                        " {} is outside {}'s range of {} to {}, so it needs approval.",
                        format_value(def, Some(&value)),
                        mname,
                        show(rlo),
                        show(rhi)
                    );
                } else {
                    let applied = map_numbers(&value, &|n| n.max(rlo).min(rhi));
                    clamps.push(PlanClamp {
                        key: key.clone(),
                        requested: value.clone(),
                        applied: applied.clone(),
                        by: "filament".to_owned(),
                        limit: if in_now.iter().any(|n| *n < rlo) { rlo } else { rhi },
                        reason: format!(
                            "{label} is kept inside {mname}'s range of {} to {}.",
                            show(rlo),
                            show(rhi)
                        ),
                    });
                    value = applied;
                }
            }
            // The material's own layer height band and speed ceilings.
            let cap = material_cap(key, to, m);
            let cap_now = numbers_of(&value).unwrap_or_default();
            if let Some((clo, chi)) = cap
                && cap_now.iter().any(|n| *n < clo - 1e-9 || *n > chi + 1e-9)
            {
                let applied = map_numbers(&value, &|n| n.max(clo).min(chi));
                let mat = short_name(m.map_or("the filament", |m| m.name.as_str()));
                let reason_text = if clo == f64::NEG_INFINITY {
                    format!(
                        "{label} is kept at or below {} for {mat}.",
                        format_value(def, Some(&Value::Float(chi)))
                    )
                } else {
                    format!(
                        "{label} is kept between {} and {} for {mat}.",
                        format_value(def, Some(&Value::Float(clo))),
                        format_value(def, Some(&Value::Float(chi)))
                    )
                };
                clamps.push(PlanClamp {
                    key: key.clone(),
                    requested: value.clone(),
                    applied: applied.clone(),
                    by: "filament".to_owned(),
                    limit: if cap_now.iter().any(|n| *n < clo) {
                        clo
                    } else {
                        chi
                    },
                    reason: reason_text,
                });
                value = applied;
            }
            if before.as_ref().is_some_and(|b| same_value(Some(b), Some(&value))) {
                continue;
            }
        }
        let dir = {
            let b = first_scalar(before.as_ref());
            let a = first_scalar(Some(&value));
            match (a, b) {
                (Some(Scalar::Num(a)), Some(Scalar::Num(b))) if a != b => {
                    def.and_then(|d| d.effect.as_ref()).and_then(|e| {
                        if a > b {
                            e.increase.clone()
                        } else {
                            e.decrease.clone()
                        }
                    })
                }
                _ => None,
            }
        };
        if let Some(d) = dir
            && pd.origin != "intent"
        {
            let _ = write!(reason, " {d}.");
        }
        changes.push(SettingChange {
            key: key.clone(),
            label,
            section: def.map_or(Section::Process, |d| d.section),
            unit: def.and_then(|d| d.unit.clone()),
            before,
            after: value,
            reason,
            sources: {
                let mut seen = BTreeSet::new();
                pd.src
                    .iter()
                    .filter(|s| seen.insert((*s).clone()))
                    .cloned()
                    .collect()
            },
            origin: pd.origin.clone(),
            klass: klass.to_owned(),
            approval: approval.to_owned(),
            goal: pd.goal.clone(),
            priority: pd.priority.clone(),
        });
    }
    changes.sort_by(|a, b| {
        section_name(a.section)
            .cmp(section_name(b.section))
            .then_with(|| a.key.cmp(&b.key))
    });
    let mut plan = empty(
        warnings, clamps, refused, blockers, questions, caveats, advice, tell_user, started,
    );
    plan.changes = changes;
    for key in from_d.keys() {
        if !to_d.contains_key(key)
            && let (Some(m), Some(p)) = (m, p)
        {
            plan.unresolved.push((
                key.clone(),
                format!(
                    "No knowledge value for {} on the {}; keep the current value.",
                    short_name(&m.name),
                    p.name
                ),
            ));
        }
    }
    plan.computed_ms = ms(started);
    plan
}

const FILAMENT_OVERRIDES: [&str; 4] = [
    "retraction_length",
    "retraction_speed",
    "deretraction_speed",
    "z_hop",
];

/// A copy of `config` with the plan's changes applied. `read` keys (machine profile values) are
/// skipped unless `include_read` is set. Where the config carries a filament override of a printer key
/// (`filament_retraction_length`), that override is set too, since it would otherwise win.
#[must_use]
pub fn apply_plan(config: &PrintConfig, changes: &[SettingChange], include_read: bool) -> PrintConfig {
    let mut next = config.clone();
    for c in changes {
        if c.klass == "read" && !include_read {
            continue;
        }
        next.set(c.key.clone(), c.after.clone());
        let over = format!("filament_{}", c.key);
        if FILAMENT_OVERRIDES.contains(&c.key.as_str()) && next.contains(&over) {
            next.set(over, c.after.clone());
        }
    }
    next
}
