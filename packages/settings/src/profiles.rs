// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Our own printer, filament and process profiles. Printers come from `profiles/printers.json` (one per
//! model in the printer catalog, from the makers' published specs), filaments from the cited knowledge base
//! and process presets from the Easy mode controls. Key names match Orca's for compatibility; the values are
//! ours. `js/profiles.ts` does the same.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{Map, Value as Json, json};

use crate::easy::{EasySettings, SpeedPreset, SupportMode, apply_easy};
use crate::knowledge::knowledge;
use crate::plan::{SetupRef, derive, shape_for, show};
use crate::schema::setting_def;
use crate::smart_layer::LAYER_STEP;
use crate::value::{PrintConfig, Value};

/// The makers' stock profile data (`packages/profiles`, AGPL-3.0-or-later), with the default
/// `stock-profiles` feature. Without it the texts are empty, the files below parse to nothing, and
/// profiles carry only the values written for `SlicerX`.
#[cfg(feature = "stock-profiles")]
mod stock {
    pub(super) use sx_profiles::{CURA_ULTIMAKER, GCODE, MACHINE, PROCESS_SPEEDS};
}
#[cfg(not(feature = "stock-profiles"))]
mod stock {
    pub(super) const MACHINE: &str = "";
    pub(super) const GCODE: &str = "";
    pub(super) const PROCESS_SPEEDS: &str = "";
    pub(super) const CURA_ULTIMAKER: &str = "";
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "shape", rename_all = "lowercase")]
pub enum BuildVolume {
    Rectangular { x: f64, y: f64, z: f64 },
    Circular { diameter: f64, z: f64 },
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrinterLimits {
    pub max_speed: Option<f64>,
    pub max_accel: Option<f64>,
    pub hotend_max_temp: Option<f64>,
    pub bed_max_temp: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterProfile {
    /// The printer catalog's model id, such as `bambu-x1-carbon`.
    pub id: String,
    pub brand: String,
    pub vendor: String,
    pub model: String,
    pub kinematics: String,
    pub enclosed: bool,
    pub build_volume: BuildVolume,
    pub nozzles: Vec<f64>,
    pub default_nozzle: f64,
    pub nozzle_count: u32,
    pub flavor: String,
    #[serde(default)]
    pub direct_drive: Option<bool>,
    #[serde(default)]
    pub limits: PrinterLimits,
    /// The maker's pages the profile follows.
    pub sources: Vec<String>,
}

#[derive(Deserialize)]
struct PrinterFile {
    printers: Vec<PrinterProfile>,
}

/// The machine settings a printer model carries, in Orca's value format, and the version they were checked
/// against.
#[derive(Debug, Clone, Deserialize)]
pub struct MachineEntry {
    /// The Orca profile the values were checked against; none for a printer Orca has no profile for.
    #[serde(default)]
    pub orca: Option<MachineOrigin>,
    /// The Cura definition the values were resolved from (the `UltiMaker` S series).
    #[serde(default)]
    pub cura: Option<CuraOrigin>,
    pub machine: serde_json::Map<String, Json>,
    /// Other nozzles: the keys that differ from the default nozzle's settings.
    #[serde(default)]
    pub nozzles: BTreeMap<String, NozzleOverride>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MachineOrigin {
    pub vendor: String,
    pub profile: String,
    pub checked: String,
}

/// The Cura machine definition, print cores, materials and quality a model's values were resolved with.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuraOrigin {
    pub definition: String,
    pub print_cores: Vec<String>,
}

/// `cura/ultimaker.json`: models, process presets, their tiers and G-code families, as the files above hold them.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CuraFile {
    models: BTreeMap<String, MachineEntry>,
    presets: BTreeMap<String, Map<String, Json>>,
    speeds: BTreeMap<String, BTreeMap<String, String>>,
    families: BTreeMap<String, GcodeFamily>,
    gcode_models: BTreeMap<String, String>,
}

fn cura() -> &'static CuraFile {
    static C: OnceLock<CuraFile> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(stock::CURA_ULTIMAKER).unwrap_or_default())
}

#[derive(Debug, Clone, Deserialize)]
pub struct NozzleOverride {
    pub differs: serde_json::Map<String, Json>,
}

#[derive(Deserialize)]
struct MachineFile {
    #[serde(rename = "orcaCommit")]
    orca_commit: String,
    models: BTreeMap<String, MachineEntry>,
}

fn machines() -> &'static MachineFile {
    static M: OnceLock<MachineFile> = OnceLock::new();
    M.get_or_init(|| {
        let mut m = serde_json::from_str(stock::MACHINE).unwrap_or(MachineFile {
            orca_commit: String::new(),
            models: BTreeMap::new(),
        });
        for (id, e) in &cura().models {
            m.models.entry(id.clone()).or_insert_with(|| e.clone());
        }
        m
    })
}

/// The Orca commit the machine settings were checked against.
#[must_use]
pub fn machine_checked_commit() -> &'static str {
    &machines().orca_commit
}

/// Models with machine settings from the maker's profile; the rest use the catalog values alone.
#[must_use]
pub fn machine_entry(id: &str) -> Option<&'static MachineEntry> {
    machines().models.get(id)
}

#[derive(Deserialize, Clone)]
struct GcodeFamily {
    #[serde(flatten)]
    texts: BTreeMap<String, String>,
}

/// The family field for each G-code key.
const GCODE_FIELDS: [(&str, &str); 12] = [
    ("start", "machine_start_gcode"),
    ("end", "machine_end_gcode"),
    ("beforeLayerChange", "before_layer_change_gcode"),
    ("layerChange", "layer_change_gcode"),
    ("changeFilament", "change_filament_gcode"),
    ("pause", "machine_pause_gcode"),
    ("timeLapse", "time_lapse_gcode"),
    ("templateCustom", "template_custom_gcode"),
    ("toolchange", "toolchange_gcode"),
    ("wrappingDetection", "wrapping_detection_gcode"),
    ("fileStart", "file_start_gcode"),
    ("extruderStart", "extruder_start_gcode"),
];

#[derive(Deserialize)]
struct GcodeFile {
    families: BTreeMap<String, GcodeFamily>,
    models: BTreeMap<String, String>,
    pending: Vec<String>,
}

fn gcode() -> &'static GcodeFile {
    static G: OnceLock<GcodeFile> = OnceLock::new();
    G.get_or_init(|| {
        let mut g = serde_json::from_str(stock::GCODE).unwrap_or(GcodeFile {
            families: BTreeMap::new(),
            models: BTreeMap::new(),
            pending: Vec::new(),
        });
        for (k, f) in &cura().families {
            g.families.entry(k.clone()).or_insert_with(|| f.clone());
        }
        for (k, f) in &cura().gcode_models {
            g.models.entry(k.clone()).or_insert_with(|| f.clone());
        }
        g
    })
}

/// How the start, end, layer change and filament change G-code of a model stands: `written` by us, or
/// `pending`.
#[must_use]
pub fn gcode_status(id: &str) -> Option<&'static str> {
    let g = gcode();
    if g.models.contains_key(id) {
        Some("written")
    } else if g.pending.iter().any(|p| p == id) {
        Some("pending")
    } else {
        None
    }
}

fn printers() -> &'static [PrinterProfile] {
    static P: OnceLock<Vec<PrinterProfile>> = OnceLock::new();
    P.get_or_init(|| {
        serde_json::from_str::<PrinterFile>(include_str!("../profiles/printers.json"))
            .map(|f| f.printers)
            .unwrap_or_default()
    })
}

fn snap(v: f64) -> f64 {
    (v * 1e9 + 0.5).floor() / 1e9
}

#[must_use]
pub fn list_printer_profiles() -> &'static [PrinterProfile] {
    printers()
}

#[must_use]
pub fn printer_profile(id: &str) -> Option<&'static PrinterProfile> {
    printers().iter().find(|p| p.id == id)
}

/// The printer's settings for a nozzle: bed shape and height, flavor, extruder type, machine limits, layer
/// height limits.
#[must_use]
pub fn printer_config(id: &str, nozzle: Option<f64>) -> Option<PrintConfig> {
    let p = printer_profile(id)?;
    let n = nozzle.unwrap_or(p.default_nozzle);
    let (area, z): (Json, f64) = match &p.build_volume {
        BuildVolume::Rectangular { x, y, z } => (json!([[0, 0], [x, 0], [x, y], [0, y]]), *z),
        BuildVolume::Circular { diameter, z } => {
            let r = diameter / 2.0;
            let pts: Vec<Json> = (0..24)
                .map(|i| {
                    let a = 2.0 * std::f64::consts::PI * f64::from(i) / 24.0;
                    json!([snap(r + r * a.cos()), snap(r + r * a.sin())])
                })
                .collect();
            (Json::Array(pts), *z)
        }
    };
    let first = p.vendor.split(' ').next().unwrap_or("").to_lowercase();
    let model = if p.model.to_lowercase().starts_with(&first) {
        p.model.clone()
    } else {
        format!("{} {}", p.vendor, p.model)
    };
    let mut out = serde_json::Map::new();
    out.insert("printer_model".into(), json!(model));
    out.insert("printable_area".into(), area);
    out.insert("printable_height".into(), json!(z));
    out.insert("nozzle_diameter".into(), json!([n]));
    out.insert("gcode_flavor".into(), json!(p.flavor));
    out.insert(
        "min_layer_height".into(),
        json!([snap(((snap(0.2 * n / LAYER_STEP)) - 1e-9).ceil() * LAYER_STEP)]),
    );
    out.insert(
        "max_layer_height".into(),
        json!([snap((snap(0.75 * n / LAYER_STEP) + 1e-9).floor() * LAYER_STEP)]),
    );
    if let Some(d) = p.direct_drive {
        out.insert(
            "extruder_type".into(),
            json!([if d { "Direct Drive" } else { "Bowden" }]),
        );
    }
    if let Some(s) = p.limits.max_speed {
        for k in ["machine_max_speed_x", "machine_max_speed_y"] {
            out.insert(k.into(), json!([s, s]));
        }
    }
    if let Some(a) = p.limits.max_accel {
        for k in [
            "machine_max_acceleration_extruding",
            "machine_max_acceleration_x",
            "machine_max_acceleration_y",
        ] {
            out.insert(k.into(), json!([a, a]));
        }
    }
    let mut config = PrintConfig::from_json(&Json::Object(out));
    if let Some(entry) = machine_entry(id) {
        // The maker's settings win. A nozzle with no profile of its own keeps our nozzle and layer height limits.
        let ov = entry.nozzles.get(&show(n));
        let mut raw = entry.machine.clone();
        if let Some(o) = ov {
            for (k, v) in &o.differs {
                raw.insert(k.clone(), v.clone());
            }
        } else if (n - p.default_nozzle).abs() >= f64::EPSILON {
            for k in ["nozzle_diameter", "min_layer_height", "max_layer_height"] {
                raw.remove(k);
            }
        }
        if let Ok(imported) = crate::import::import_orca(&Json::Object(raw), &|_| None) {
            config = PrintConfig::merged(&[&config, &imported.config]);
        }
    }
    if let Some(f) = gcode().models.get(id).and_then(|fam| gcode().families.get(fam)) {
        for (field, key) in GCODE_FIELDS {
            if let Some(text) = f.texts.get(field) {
                config.set(key, Value::Str(text.clone()));
            }
        }
    }
    Some(config)
}

/// A material's filament settings from the knowledge base: temperatures, cooling, flow, retraction and the rest.
#[must_use]
pub fn filament_config(id: &str, hotend: Option<&str>) -> Option<PrintConfig> {
    knowledge().materials.get(id)?;
    let mut out = PrintConfig::new();
    for (key, d) in derive(&filament_setup(id, hotend)) {
        let v = d
            .shaped
            .clone()
            .unwrap_or_else(|| shape_for(setting_def(&key), &d.value, None));
        out.set(key, v);
    }
    Some(out)
}

fn filament_setup(id: &str, hotend: Option<&str>) -> SetupRef {
    SetupRef {
        printer: String::new(),
        nozzle_diameter: 0.4,
        filament: id.to_owned(),
        process: None,
        hotend: hotend.map(str::to_owned),
        nozzle_material: None,
    }
}

/// The sources a filament profile cites, for showing where its numbers come from.
#[must_use]
pub fn filament_sources(id: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    for d in derive(&filament_setup(id, None)).values() {
        out.extend(d.src.iter().cloned());
    }
    out.into_iter().collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProcessPreset {
    pub id: &'static str,
    /// For example `0.20 mm Standard`.
    pub label: String,
    pub layer_height: f64,
}

struct Tier {
    id: &'static str,
    name: &'static str,
    easy: EasySettings,
}

fn tiers() -> [Tier; 5] {
    let e = |detail, strength, speed, vary| EasySettings {
        detail,
        strength,
        speed,
        supports: SupportMode::Auto,
        brim: true,
        smart_layer: None,
        vary_layer_height: Some(vary),
    };
    [
        Tier {
            id: "draft",
            name: "Draft",
            easy: e(0.0, 10.0, SpeedPreset::Balanced, false),
        },
        Tier {
            id: "standard",
            name: "Standard",
            easy: e(40.0, 20.0, SpeedPreset::Balanced, true),
        },
        Tier {
            id: "fine",
            name: "Fine",
            easy: e(80.0, 30.0, SpeedPreset::Balanced, true),
        },
        Tier {
            id: "extra_fine",
            name: "Extra fine",
            easy: e(100.0, 30.0, SpeedPreset::Balanced, true),
        },
        Tier {
            id: "strong",
            name: "Strong",
            easy: e(40.0, 85.0, SpeedPreset::Balanced, true),
        },
    ]
}

/// The plain process every preset starts from: line widths and speeds that suit a nozzle, before the tier
/// scales them.
fn process_base(nozzle: f64) -> PrintConfig {
    let w = show(snap((nozzle * 1.05 * 100.0 + 0.5).floor() / 100.0));
    PrintConfig::from_json(&json!({
        "nozzle_diameter": [nozzle],
        "layer_height": snap(((0.5 * nozzle / LAYER_STEP) + 0.5).floor() * LAYER_STEP),
        "line_width": w,
        "outer_wall_line_width": w,
        "inner_wall_line_width": w,
        "sparse_infill_line_width": w,
        "internal_solid_infill_line_width": w,
        "top_surface_line_width": w,
        "outer_wall_speed": [60],
        "inner_wall_speed": [100],
        "sparse_infill_speed": [120],
        "internal_solid_infill_speed": [100],
        "top_surface_speed": [60],
        "gap_infill_speed": [60],
        "initial_layer_speed": [30],
        "travel_speed": [200],
        "default_acceleration": [3000],
        "outer_wall_acceleration": [2000],
        "top_surface_acceleration": [1500],
        "initial_layer_acceleration": [500],
    }))
}

#[derive(Deserialize)]
struct SpeedFile {
    #[serde(rename = "orcaCommit")]
    orca_commit: String,
    #[serde(rename = "bambuStudioCommit")]
    bambu_studio_commit: String,
    presets: BTreeMap<String, Map<String, Json>>,
    models: BTreeMap<String, BTreeMap<String, String>>,
}

fn speeds() -> &'static SpeedFile {
    static S: OnceLock<SpeedFile> = OnceLock::new();
    S.get_or_init(|| {
        let mut s = serde_json::from_str(stock::PROCESS_SPEEDS).unwrap_or(SpeedFile {
            orca_commit: String::new(),
            bambu_studio_commit: String::new(),
            presets: BTreeMap::new(),
            models: BTreeMap::new(),
        });
        for (k, p) in &cura().presets {
            s.presets.entry(k.clone()).or_insert_with(|| p.clone());
        }
        for (k, m) in &cura().speeds {
            s.models.entry(k.clone()).or_insert_with(|| m.clone());
        }
        s
    })
}

/// The Orca and Bambu Studio commits the process speeds were checked against.
#[must_use]
pub fn process_speed_sources() -> (&'static str, &'static str) {
    (&speeds().orca_commit, &speeds().bambu_studio_commit)
}

/// The maker preset a printer's tier takes its speeds from. The Strong tier uses the Standard preset when the
/// maker has no strength preset.
#[must_use]
pub fn process_speed_source(printer: &str, tier: &str) -> Option<&'static str> {
    let m = speeds().models.get(printer)?;
    m.get(tier)
        .or_else(|| if tier == "strong" { m.get("standard") } else { None })
        .map(String::as_str)
}

/// Printers whose Fine tier carries the tuned quality values (from the shared P2S and H2C profiles).
const FINE_FAMILY: [&str; 5] = ["bambu-p2s", "bambu-h2c", "bambu-h2d", "bambu-h2s", "bambu-x2d"];

/// The quality values the Fine tier adds on the P2S and H2C family, between Bambu's High Quality preset and the
/// shared profiles: outer wall 50 on the standard hotend, moderate overhang speeds, a smoother support
/// underside. The overhang speeds and the support gaps and angle still need a test print.
fn fine_family(raw: &Map<String, Json>) -> Map<String, Json> {
    let mut out = raw.clone();
    let variants: Vec<String> = match raw.get("print_extruder_variant") {
        Some(Json::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
        _ => Vec::new(),
    };
    let wall = raw.get("outer_wall_speed").cloned();
    if let Some(Json::Array(w)) = &wall {
        let next: Vec<Json> = w
            .iter()
            .enumerate()
            .map(|(i, v)| {
                if variants.get(i).map(String::as_str) == Some("Direct Drive Standard") {
                    json!("50")
                } else {
                    v.clone()
                }
            })
            .collect();
        out.insert("outer_wall_speed".into(), Json::Array(next));
    }
    for (k, v) in [
        ("overhang_1_4_speed", "60"),
        ("overhang_2_4_speed", "40"),
        ("overhang_3_4_speed", "30"),
        ("overhang_4_4_speed", "30"),
        ("overhang_totally_speed", "10"),
    ] {
        let n = match (raw.get(k), &wall) {
            (Some(Json::Array(a)), _) | (None, Some(Json::Array(a))) => Some(a.len()),
            _ => None,
        };
        out.insert(
            k.into(),
            n.map_or_else(|| json!(v), |n| Json::Array(vec![json!(v); n])),
        );
    }
    for (k, v) in [
        ("top_shell_layers", "5"),
        ("top_shell_thickness", "0.6"),
        ("sparse_infill_density", "15%"),
        ("seam_position", "aligned"),
        ("skirt_loops", "1"),
        ("enable_arc_fitting", "1"),
        ("support_interface_top_layers", "3"),
        ("support_interface_spacing", "0"),
        ("support_top_z_distance", "0.16"),
        ("support_bottom_z_distance", "0.16"),
        ("support_object_xy_distance", "0.4"),
        ("support_threshold_angle", "25"),
    ] {
        out.insert(k.into(), json!(v));
    }
    out
}

/// A process preset for a nozzle: the tier's Easy mode controls applied to the plain process. With a printer
/// (and the 0.4 mm nozzle) the speeds, accelerations and jerk are the maker's own for that printer and tier.
#[must_use]
pub fn process_config(id: &str, nozzle: f64, printer: Option<&str>) -> Option<PrintConfig> {
    let t = tiers().into_iter().find(|t| t.id == id)?;
    let base = apply_easy(&t.easy, &process_base(nozzle));
    let src = printer
        .filter(|_| (nozzle - 0.4).abs() < f64::EPSILON)
        .and_then(|p| process_speed_source(p, id));
    let (Some(printer), Some(src)) = (printer, src) else {
        return Some(base);
    };
    let mut raw = speeds().presets.get(src).cloned().unwrap_or_default();
    if id == "fine" && FINE_FAMILY.contains(&printer) {
        raw = fine_family(&raw);
    }
    let imported = crate::import::import_orca(&Json::Object(raw), &|_| None).ok()?;
    Some(PrintConfig::merged(&[&base, &imported.config]))
}

/// The quality tiers for a nozzle. Labels carry the layer height the tier lands on.
#[must_use]
pub fn list_process_presets(nozzle: f64, printer: Option<&str>) -> Vec<ProcessPreset> {
    tiers()
        .into_iter()
        .map(|t| {
            let lh = process_config(t.id, nozzle, printer)
                .and_then(|c| crate::config::number_of(&c, "layer_height", false))
                .unwrap_or(0.0);
            ProcessPreset {
                id: t.id,
                label: format!("{lh:.2} mm {}", t.name),
                layer_height: lh,
            }
        })
        .collect()
}

/// Printer, filament and process merged into one config, later parts winning: process, then filament, then
/// printer.
#[must_use]
pub fn profile_config(
    printer: &str,
    nozzle: Option<f64>,
    filament: Option<&str>,
    process: Option<&str>,
) -> Option<PrintConfig> {
    let p = printer_profile(printer)?;
    let n = nozzle.unwrap_or(p.default_nozzle);
    let mut parts: Vec<Option<PrintConfig>> =
        vec![process_config(process.unwrap_or("standard"), n, Some(printer))];
    parts.push(filament.and_then(|f| filament_config(f, None)));
    parts.push(printer_config(printer, Some(n)));
    let refs: Vec<&PrintConfig> = parts.iter().flatten().collect();
    Some(PrintConfig::merged(&refs))
}
