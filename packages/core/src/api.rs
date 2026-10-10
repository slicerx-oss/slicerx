// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The embedding API: the only part of `sx-core` covered by semver
//! (`packages/core/CHANGELOG.md`). Everything else is internal.
//!
//! Two ways in:
//!
//! - Typed: [`load_mesh`], then [`slice`] or [`slice_range`] on a [`Plate`],
//!   then [`emit_gcode`] and [`preview_buffers`].
//! - JSON: a [`SliceRequest`] (the `SliceRequest` shape from
//!   `packages/contracts/src/slice.ts`) through [`run_request`], which returns
//!   a [`SliceReport`] (the contract's `SliceResult` plus `schemaVersion`) and
//!   the G-code and SXPV bytes. The `sx` CLI, `sx-ffi` and `sx-wasm` all use
//!   this path.
//!
//! ```no_run
//! # fn main() -> sx_core::api::Result<()> {
//! use sx_core::api;
//! let mesh = std::sync::Arc::new(api::load_mesh(&std::fs::read("part.stl")?, "part.stl")?);
//! let req: api::SliceRequest = serde_json::from_str(
//!     r#"{"plate":{"objects":[{"mesh":"part"}]},"config":{"layer_height":0.2}}"#,
//! ).map_err(|e| api::Error::Config { key: "(request)", reason: e.to_string() })?;
//! let run = api::run_request(&req, &|_id: &str| Ok(mesh.clone()))?;
//! println!("{} layers, {} bytes of G-code", run.report.layer_count, run.gcode.len());
//! # Ok(()) }
//! ```

use crate::platform::Timer;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ops::Range;
use std::sync::Arc;

pub use crate::config::{GcodeFlavor, InfillPattern, PrintConfig};
pub use crate::error::{Error, Result};
pub use crate::gcode::{EmitOptions, GcodeStats, emit_gcode, emit_gcode_with};
pub use crate::mesh::{Mesh, MeshPart};
pub use crate::output::{
    Feature, LayerPaths, PathInfo, SliceOutput, SliceWarning, Stage, StageMicros, WarningCode,
};
pub use crate::plate::{Bed, Plate, PlateObject};
pub use crate::preview::{preview_buffers, stitch as stitch_preview};
pub use crate::session::{HeightRange, SliceSession};
pub use crate::threemf::{ProjectMetadata, metadata as project_metadata};
pub use crate::validate::{GcodeReport, validate_gcode};
pub use crate::{Cancellable, NoProgress, Progress, SliceEngine, SliceOptions, SxEngine, slice, slice_range};

/// Version of the request and result JSON. Readers reject versions they do not know.
pub const SCHEMA_VERSION: u32 = 1;

/// Loads a model (STL, the benchmark JSON, or the raw parts format), picking
/// the format from the file name and the bytes.
pub fn load_mesh(bytes: &[u8], file_name: &str) -> Result<Mesh> {
    Mesh::load(bytes, file_name)
}

/// Each plate of a 3MF project as its own mesh, `(plate number, mesh)`.
/// Bambu and Orca projects list plates in their metadata; a plain 3MF is one
/// plate. [`load_mesh`] returns the first plate.
pub fn load_3mf_plates(bytes: &[u8], file_name: &str) -> Result<Vec<(u32, Mesh)>> {
    crate::threemf::load_plates(bytes, file_name)
}

/// Every plate of a 3MF project with each build item as a mesh of its own, named after its object.
pub fn load_3mf_plate_objects(bytes: &[u8], file_name: &str) -> Result<Vec<(u32, Vec<Mesh>)>> {
    crate::threemf::load_plate_objects(bytes, file_name)
}

/// A slice request, mirroring `SliceRequest` in `packages/contracts/src/slice.ts`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceRequest {
    /// Optional; when present it must be [`SCHEMA_VERSION`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u32>,
    pub plate: PlateSpec,
    /// A `PrintConfig` object with Orca keys. Missing keys use the defaults.
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub options: RequestOptions,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateSpec {
    /// Defaults to a 256 x 256 x 250 mm bed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bed: Option<BedSpec>,
    pub objects: Vec<ObjectSpec>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BedSpec {
    pub width_mm: f32,
    pub depth_mm: f32,
    pub height_mm: f32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSpec {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Mesh reference (a string or a number), resolved by the caller.
    pub mesh: serde_json::Value,
    /// 4x4 column-major transform in mm. When absent the mesh is centered on
    /// the bed and set down on z = 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<Vec<f32>>,
    /// Part name to filament slot.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub slot_overrides: BTreeMap<String, u8>,
    /// Setting overrides for single parts of the mesh, by part name: a part with settings prints its own
    /// area with them, as a modifier shaped like the part would.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub part_settings: BTreeMap<String, BTreeMap<String, serde_json::Value>>,
    /// Negative parts and support blockers and enforcers, as meshes in the same space
    /// as `mesh`. They take the object's transform unless they carry their own.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub volumes: Vec<VolumeSpec>,
    /// Setting overrides for this object, Orca keys. The engine slices the
    /// plate with one config, so every object must carry the same overrides
    /// (or the plate has one object); differing ones are an error.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub settings: BTreeMap<String, serde_json::Value>,
    /// Painted brim ears for `brim_type` = `painted`: x, y, z in the space of `mesh` (z at or under the
    /// bed after the transform), and the radius of the ear head, mm each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub brim_points: Vec<[f32; 4]>,
}

/// A volume of an object that is not printed: a cut, or a support region.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeSpec {
    #[serde(default)]
    pub name: String,
    /// `negative`, `support_blocker`, `support_enforcer` or `modifier`.
    pub role: String,
    pub mesh: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<Vec<f32>>,
    /// For a modifier: Orca key overrides that apply to the object inside the volume
    /// (walls, infill density and pattern, speeds and flow).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub settings: BTreeMap<String, serde_json::Value>,
}

/// G-code written at the start of a layer.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerGcodeSpec {
    /// 0-based layer. Give this or `zMm`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<u32>,
    /// A height in mm: the G-code goes at the start of the first layer whose top reaches it, on the layers the
    /// engine plans (so a plate whose layer plan the host cannot predict needs no second slice). Give this or `layer`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z_mm: Option<f64>,
    /// `pause`, `color_change` or `custom`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcode: Option<String>,
}

/// `{ "mode": "declare", "zMm": 12.4 }`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeZ {
    pub mode: String,
    pub z_mm: f64,
}

/// Settings that apply between two heights (`RangeOverride` in the geometry
/// package's calibration output).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeightRangeSpec {
    pub z_from_mm: f64,
    pub z_to_mm: f64,
    pub settings: serde_json::Value,
    /// Ids of the plate objects the range applies to; absent or empty for every object.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<String>,
}

impl ObjectSpec {
    /// The mesh reference as a string (`12` and `"12"` are the same mesh).
    pub fn mesh_ref(&self) -> String {
        match &self.mesh {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    }
}

/// An image for the thumbnails: `width` by `height` pixels of RGBA, base64 encoded.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailInput {
    pub width: u32,
    pub height: u32,
    pub rgba: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOptions {
    /// `sx` (default) or `orca`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// Overrides the config's `gcode_flavor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flavor: Option<String>,
    /// Layer ranges to slice separately and join; the output is identical for any value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shards: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emit_gcode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emit_preview: Option<bool>,
    /// sleipnir: the top of every layer in mm, first entry is the first
    /// layer's top. Entries strictly ascend, each layer is 0.04 to 0.8 mm
    /// thick, and the last reaches the top of the plate. Replaces
    /// `layer_height` and `initial_layer_print_height`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_tops_mm: Option<Vec<f64>>,
    /// Resume a print at this layer (0-based). The plate is sliced whole and
    /// G-code is written only from this layer, after a start sequence that
    /// heats, homes X and Y but not Z, and draws no purge line. The preview
    /// still holds every layer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_from_layer: Option<u32>,
    /// With `resumeFromLayer`: declare the nozzle's Z instead of leaving it
    /// as the printer has it. Writes `G92 Z<zMm>` after homing X and Y, and the
    /// result carries a `manual_step` warning: the nozzle must be at that height
    /// by hand first. Off unless set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_z: Option<ResumeZ>,
    /// G-code at the start of layers: a pause, a color change or the person's own
    /// commands. `kind` is `pause`, `color_change` or `custom` (then `gcode`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_gcode: Option<Vec<LayerGcodeSpec>>,
    /// The moment of slicing as Unix seconds, for the date variables (`year`, `month`, `day`, `hour`, `minute`,
    /// `second`) of custom G-code; with `nowOffsetMinutes`, local time's offset from UTC. Without it native
    /// builds read the clock (UTC) and WASM builds read 1970, so the host should send it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub now_unix: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub now_offset_minutes: Option<i32>,
    /// Limits of the target printer (hotend, bed and chamber temperatures, C).
    /// Settings above them are lowered and reported; unknown limits use wide fallbacks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_limits: Option<crate::gcode_lint::Limits>,
    /// The image for the G-code thumbnails, raw RGBA as base64. Without one the
    /// native build draws the toolpaths itself; a host that renders its own passes it here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<ThumbnailInput>,
    /// The custom G-code in `config` is the person's own, not from an imported
    /// file or a tool call. Off by default: imported text gets the strict linter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_gcode: Option<bool>,
    /// Custom G-code keys of `config` whose text the native caller found to be the printer maker's stock text
    /// (`sx` checks them against the stock fingerprints): linted as trusted even when the rest is not. Never read
    /// from the request JSON, so a request cannot claim it.
    #[serde(skip)]
    pub stock_gcode_keys: Vec<String>,
    /// Setting overrides by height. Only wall count, temperature, flow,
    /// pressure advance, speeds and retraction can change by height.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_ranges: Option<Vec<HeightRangeSpec>>,
    /// The plate's name, number (from 1) and the project's name, for `filename_format`
    /// (`{plate_name}`, `{plate_number}`, `{model_name}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plate_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plate_number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    /// The printer profile id the plate is sliced for (`bambu-h2d`): heimdall's collision check takes the head,
    /// gantry and tool changer of that printer, else of the settings' `printer_model`, else a generic head.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub printer_id: Option<String>,
}

/// What `filename_format` reads from a request besides the settings.
pub fn name_info(req: &SliceRequest) -> crate::outname::NameInfo {
    crate::outname::NameInfo {
        objects: req.plate.objects.iter().map(|o| o.name.clone()).collect(),
        plate_name: req.options.plate_name.clone().unwrap_or_default(),
        plate_number: req.options.plate_number.unwrap_or(1),
        model_name: req.options.model_name.clone().unwrap_or_default(),
    }
}

/// Totals, mirroring `SliceStats` in the contract.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportStats {
    pub time_s: f64,
    /// Seconds of `time_s` before the first layer: heating, homing, leveling and the purge line. The layers' own
    /// times (`layerTimeS`) add up to the rest. Zero when the file's simulation was not run.
    #[serde(default)]
    pub prepare_s: f64,
    pub filament_mm: Vec<f64>,
    pub filament_g: Vec<f64>,
    pub cost: f64,
    pub tool_changes: u32,
}

/// The result JSON: the contract's `SliceResult` minus the host's id, plus
/// `schemaVersion` and output sizes and hashes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceReport {
    pub schema_version: u32,
    pub engine: String,
    pub layer_count: u32,
    pub layer_z: Vec<f32>,
    pub layer_time_s: Vec<f32>,
    pub stats: ReportStats,
    pub stage_micros: StageMicros,
    pub wall_ms: f64,
    pub warnings: Vec<SliceWarning>,
    pub gcode_bytes: u64,
    /// Lowercase hex SHA-256 of the G-code, or empty when G-code was not emitted.
    pub gcode_sha256: String,
    /// `bgcode` when the profile asks for binary G-code (`binary_gcode`); absent for plain text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcode_format: Option<String>,
    /// The file name `filename_format` gives the G-code; absent when G-code was not emitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    pub preview_bytes: u64,
    /// Where the prime tower stands, its size and why, when the plate has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prime_tower: Option<crate::output::TowerPlacement>,
    /// What variable layer heights cost in tool changes and purge against fixed layers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vary_layer_cost: Option<crate::output::VaryLayerCost>,
    /// The filament map the print uses, on a printer with two extruders fed by their own AMS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filament_map: Option<FilamentMapReport>,
    /// By object: every place the head, gantry or tool changer would meet a printed object, in print order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub collisions: Vec<crate::collide::Collision>,
    /// Fixes for the collisions, with what they cost.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub collision_fixes: Vec<crate::collide::CollisionFix>,
}

/// Which extruder and nozzle print each filament (Bambu Studio's `filament_maps`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilamentMapReport {
    /// The extruder of each filament, 1 the left and 2 the right, as Bambu Studio writes `filament_maps`.
    pub extruders: Vec<u8>,
    /// The nozzle of each filament (0 the left extruder's; the right extruder's from 1, one per rack
    /// hotend on the H2C).
    pub nozzles: Vec<u8>,
    /// True when the engine picked the map, false when the settings gave it (`filament_map_mode`).
    pub auto: bool,
}

impl From<&crate::nozzles::Map> for FilamentMapReport {
    fn from(m: &crate::nozzles::Map) -> Self {
        Self {
            extruders: m.extruder.iter().map(|&e| e + 1).collect(),
            nozzles: m.nozzle.clone(),
            auto: m.auto,
        }
    }
}

/// A finished request: the report and the output bytes.
#[derive(Debug, Clone, Default)]
pub struct SliceRun {
    pub report: SliceReport,
    pub gcode: Vec<u8>,
    pub preview: Vec<u8>,
}

/// Builds the plate for a request, asking `meshes` for each object's mesh.
pub fn build_plate(req: &SliceRequest, meshes: &dyn Fn(&str) -> Result<Arc<Mesh>>) -> Result<Plate> {
    let bed = req.plate.bed.map_or_else(Bed::default, |b| Bed {
        width_mm: b.width_mm,
        depth_mm: b.depth_mm,
        height_mm: b.height_mm,
    });
    let differing = settings_differ(req);
    let mut objects = Vec::with_capacity(req.plate.objects.len());
    for (i, o) in req.plate.objects.iter().enumerate() {
        let mesh = meshes(&o.mesh_ref())?;
        let transform = match &o.transform {
            Some(t) => t.as_slice().try_into().map_err(|_| Error::Config {
                key: "plate.objects.transform",
                reason: format!("expected 16 numbers, got {}", t.len()),
            })?,
            None => crate::plate::centered_transform(&mesh, bed),
        };
        let id = if o.id.is_empty() {
            format!("object-{}", i + 1)
        } else {
            o.id.clone()
        };
        let name = if o.name.is_empty() {
            mesh.name.clone()
        } else {
            o.name.clone()
        };
        let slot_overrides = o.slot_overrides.iter().map(|(k, v)| (k.clone(), *v)).collect();
        let part_settings = o
            .part_settings
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    serde_json::Value::Object(v.iter().map(|(a, b)| (a.clone(), b.clone())).collect()),
                )
            })
            .collect();
        let mut volumes = Vec::with_capacity(o.volumes.len());
        for v in &o.volumes {
            let role = match v.role.as_str() {
                "negative" => crate::plate::VolumeRole::Negative,
                "support_blocker" => crate::plate::VolumeRole::SupportBlocker,
                "support_enforcer" => crate::plate::VolumeRole::SupportEnforcer,
                "modifier" => crate::plate::VolumeRole::Modifier,
                other => {
                    return Err(Error::Config {
                        key: "plate.objects.volumes.role",
                        reason: format!(
                            "unknown role {other}; use negative, support_blocker, support_enforcer or modifier"
                        ),
                    });
                }
            };
            let vt = match &v.transform {
                Some(t) => Some(t.as_slice().try_into().map_err(|_| Error::Config {
                    key: "plate.objects.volumes.transform",
                    reason: format!("expected 16 numbers, got {}", t.len()),
                })?),
                None => None,
            };
            let vm = meshes(&match &v.mesh {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            })?;
            volumes.push(crate::plate::PlateVolume {
                name: v.name.clone(),
                role,
                mesh: vm,
                transform: vt,
                settings: serde_json::Value::Object(
                    v.settings.iter().map(|(k, x)| (k.clone(), x.clone())).collect(),
                ),
            });
        }
        objects.push(PlateObject {
            id,
            name,
            mesh,
            transform,
            slot_overrides,
            part_settings,
            volumes,
            brim_points: o.brim_points.clone(),
            settings: if differing {
                serde_json::Value::Object(o.settings.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            } else {
                serde_json::Value::Null
            },
        });
    }
    if objects.is_empty() {
        return Err(Error::EmptyPlate);
    }
    Ok(Plate { bed, objects })
}

/// True when the objects carry different setting overrides; each then slices with its own.
fn settings_differ(req: &SliceRequest) -> bool {
    let mut it = req.plate.objects.iter().map(|o| &o.settings);
    it.next().is_some_and(|first| it.any(|s| s != first))
}

/// The overrides every object carries, when they all carry the same and there are any.
fn object_settings(req: &SliceRequest) -> Option<serde_json::Value> {
    if settings_differ(req) {
        return None;
    }
    req.plate
        .objects
        .first()
        .map(|o| &o.settings)
        .filter(|m| !m.is_empty())
        .map(|m| serde_json::Value::Object(m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()))
}

/// Parses the request's config and applies the flavor override. Settings
/// outside the nozzle and machine limits are lowered (see
/// [`request_config_checked`] for what changed); values no printer can use are an error.
pub fn request_config(req: &SliceRequest) -> Result<PrintConfig> {
    request_config_checked(req).map(|(c, _)| c)
}

/// [`request_config`] plus the preflight's findings (clamps, as warnings).
pub fn request_config_checked(req: &SliceRequest) -> Result<(PrintConfig, Vec<crate::preflight::Issue>)> {
    if let Some(v) = req.schema_version
        && v != SCHEMA_VERSION
    {
        return Err(Error::Config {
            key: "schemaVersion",
            reason: format!("unsupported version {v}"),
        });
    }
    let mut config = if req.config.is_null() {
        PrintConfig::default()
    } else {
        PrintConfig::from_value(&req.config)?
    };
    if let Some(over) = object_settings(req) {
        config.apply_value(&over)?;
        config.check()?;
    }
    if let Some(f) = &req.options.flavor {
        config.gcode_flavor = GcodeFlavor::parse(f).ok_or_else(|| Error::Config {
            key: "options.flavor",
            reason: format!("unknown flavor {f}"),
        })?;
    }
    config.now = req
        .options
        .now_unix
        .map(|t| (t, req.options.now_offset_minutes.unwrap_or(0)));
    config.limits = req.options.machine_limits.unwrap_or_default();
    config.untrusted_gcode = !req.options.trusted_gcode.unwrap_or(false);
    config
        .trusted_gcode_keys
        .clone_from(&req.options.stock_gcode_keys);
    let limits = config.limits;
    let issues = crate::preflight::clamp_config(&mut config, &limits);
    if crate::preflight::blocks(&issues) {
        return Err(Error::Blocked(crate::preflight::blocking_text(&issues)));
    }
    match req.options.engine.as_deref() {
        None | Some("sx") => Ok((config, issues)),
        Some("orca") => Err(Error::Unsupported("the orca engine")),
        Some(other) => Err(Error::Config {
            key: "options.engine",
            reason: format!("unknown engine {other}"),
        }),
    }
}

/// Prepares the session for a request: welds the plate and plans layers,
/// honoring `options.layerTopsMm`.
pub fn build_session(req: &SliceRequest, plate: &Plate, config: &PrintConfig) -> Result<SliceSession> {
    let ranges: Vec<HeightRange> = req
        .options
        .height_ranges
        .iter()
        .flatten()
        .map(|r| HeightRange {
            z_from_mm: r.z_from_mm,
            z_to_mm: r.z_to_mm,
            settings: r.settings.clone(),
            objects: r.objects.clone(),
        })
        .collect();
    #[cfg(feature = "sleipnir")]
    let planned = match (
        &req.options.layer_tops_mm,
        crate::sleipnir::requested(&req.config),
    ) {
        (None, Some(mode)) => crate::sleipnir::plan(plate, config, mode),
        _ => None,
    };
    #[cfg(not(feature = "sleipnir"))]
    let planned: Option<Vec<f64>> = None;
    let tops = req.options.layer_tops_mm.as_deref().or(planned.as_deref());
    let mut session = SliceSession::with_options(plate, config, tops, &ranges)?;
    let zones = crate::collide::plate::zones(config);
    let kinds: Vec<u8> = zones.iter().map(|z| z.0).collect();
    if let Some(m) = collide_model(req, plate, config, &session, kinds.clone()) {
        session.set_collide(Arc::new(m));
    } else if plate.objects.len() > 1 || !kinds.is_empty() {
        // no model (by layer, or one object): paths may still cross, and print paths may enter a keep-out zone
        #[allow(clippy::cast_possible_truncation, reason = "plate positions in mm")]
        let objects = session
            .footprints()
            .iter()
            .map(|f| crate::collide::MetaObject {
                id: f.id.clone(),
                height: 0.0,
                center: [f.center[0] as f32, f.center[1] as f32],
            })
            .collect();
        session.set_collide_meta(crate::collide::Meta {
            objects,
            zones: kinds,
            ..crate::collide::Meta::default()
        });
    }
    for k in req.plate.objects.iter().flat_map(|o| o.settings.keys()) {
        if !crate::config::READ_KEYS.contains(&k.as_str()) && !crate::config::FUZZY_KEYS.contains(&k.as_str())
        {
            session.push_warning(SliceWarning {
                code: WarningCode::UnsupportedSetting,
                message: format!("{k} is not applied by this engine (object setting)"),
                layer: None,
            });
        }
    }
    // Features too thin for the walls are named, with the setting that would keep them.
    for w in session.thin_warnings(config) {
        session.push_warning(w);
    }
    // With support off, regions that cannot print without it are named.
    if !config.enable_support {
        for w in session.floating_warnings(config) {
            session.push_warning(w);
        }
    }
    if let Some(z) = &req.options.resume_z {
        if z.mode != "declare"
            || !z.z_mm.is_finite()
            || z.z_mm < 0.0
            || req.options.resume_from_layer.is_none_or(|r| r == 0)
        {
            return Err(Error::Config {
                key: "options.resumeZ",
                reason: "needs mode \"declare\", a zMm of 0 or more, and resumeFromLayer above 0".to_owned(),
            });
        }
        session.push_warning(SliceWarning {
            code: WarningCode::ManualStep,
            message: format!(
                "The G-code declares the nozzle at Z{:.3} (G92 Z). Move the nozzle to that height by hand before starting.",
                z.z_mm
            ),
            layer: None,
        });
    }
    if let Some(r) = req.options.resume_from_layer
        && r >= session.layer_count()
    {
        return Err(Error::Config {
            key: "options.resumeFromLayer",
            reason: format!(
                "layer {r} is past the last layer ({})",
                session.layer_count().saturating_sub(1)
            ),
        });
    }
    Ok(session)
}

/// heimdall's model of a by-object plate with two objects or more: the plate's objects (before any shrinkage
/// compensation, a fraction of a percent the head's 2 mm margin covers), the request's printer and the session's
/// filament map.
fn collide_model(
    req: &SliceRequest,
    plate: &Plate,
    config: &PrintConfig,
    session: &SliceSession,
    zones: Vec<u8>,
) -> Option<crate::collide::Model> {
    if !config.print_by_object() {
        return None;
    }
    let printable: Vec<&PlateObject> = plate
        .objects
        .iter()
        .filter(|o| o.mesh.parts.iter().any(|p| !p.triangles.is_empty()))
        .collect();
    if printable.len() < 2 {
        return None;
    }
    let map = session
        .filament_map()
        .map(|m| m.extruder.iter().map(|&e| usize::from(e)).collect());
    Some(crate::collide::Model::new(
        &printable,
        config,
        req.options.printer_id.as_deref(),
        map,
        session.could_print_by_layer(config),
        zones,
    ))
}

/// The collision report of a sliced request: `hits` from its layer ranges, the layers' seconds and the start before
/// them as the finished file reads them. Empty on a plate without a collision model.
pub fn collision_report(
    meta: Option<&crate::collide::Meta>,
    hits: &crate::collide::Hits,
    layer_s: &[f32],
    prepare_s: f64,
) -> crate::collide::report::Report {
    let Some(meta) = meta else {
        return crate::collide::report::Report::default();
    };
    let layer_s: Vec<f64> = layer_s.iter().map(|&t| f64::from(t)).collect();
    crate::collide::report(meta, &hits.0, &layer_s, prepare_s)
}

/// Slices one layer range of a prepared request and writes its G-code to
/// `w`: the range's part of the whole file (the start sequence with the
/// first range, the end with the last), honoring `options.resumeFromLayer`.
/// Ranges of a full split concatenate to the same bytes as one range.
pub fn slice_shard(
    req: &SliceRequest,
    session: &SliceSession,
    config: &PrintConfig,
    layers: Range<u32>,
    progress: &dyn Progress,
    w: &mut impl std::io::Write,
) -> Result<(SliceOutput, GcodeStats)> {
    let out = slice_shard_paths(req, session, config, layers, progress)?;
    let stats = emit_shard(req, session, config, &out, progress, w)?;
    Ok((out, stats))
}

/// The paths of a layer range, with the resume height checked against them ([`slice_shard`] without the G-code).
fn slice_shard_paths(
    req: &SliceRequest,
    session: &SliceSession,
    config: &PrintConfig,
    layers: Range<u32>,
    progress: &dyn Progress,
) -> Result<SliceOutput> {
    let mut out = session.slice_range_with(config, layers, progress)?;
    if progress.cancelled() {
        return Err(Error::Cancelled);
    }
    // A join of a solid surface never crosses another path of its layer: it stays a travel there.
    if !config.print_by_object() {
        crate::collide::plate::drop_crossing_joins(&mut out);
    }
    if session.collide_meta().is_some() {
        let zones = crate::collide::plate::zones(config);
        let found = crate::collide::plate::check(
            &out,
            &zones,
            !config.print_by_object(),
            config.nozzle_diameter,
            crate::zoneroute::Router::of(config).as_ref(),
        );
        out.collisions.merge(found);
    }
    if let Some(z) = req.options.resume_z.as_ref().map(|z| z.z_mm)
        && req.options.resume_from_layer.is_some_and(|r| r > 0)
    {
        // An overstated Z sends the nozzle down into the part: the declared height
        // cannot exceed what the printer can reach or what was sliced.
        let cap = config.printable_height.min(f64::from(out.plate_top_z));
        if !z.is_finite() || z < 0.0 || z > cap + 1e-6 {
            return Err(Error::Blocked(format!(
                "the declared Z of {z} mm is outside 0 to {cap:.2} mm (the part and printer height)"
            )));
        }
    }
    Ok(out)
}

/// The G-code of the paths [`slice_shard_paths`] made ([`slice_shard`] after the paths).
fn emit_shard(
    req: &SliceRequest,
    session: &SliceSession,
    config: &PrintConfig,
    out: &SliceOutput,
    progress: &dyn Progress,
    w: &mut impl std::io::Write,
) -> Result<GcodeStats> {
    let opts = EmitOptions {
        resume_from_layer: req.options.resume_from_layer.filter(|&r| r > 0),
        resume_z_mm: req.options.resume_z.as_ref().map(|z| z.z_mm),
        layer_gcode: layer_gcode(req.options.layer_gcode.as_deref().unwrap_or(&[]), session)?,
    };
    progress.report(Stage::Gcode, 0.0);
    let stats = emit_gcode_with(out, config, config.gcode_flavor, &opts, w)?;
    progress.report(Stage::Gcode, 1.0);
    Ok(stats)
}

/// The request's layer G-code on the session's layers. An entry by height goes on the first layer whose top
/// reaches it (the last layer when none does), and of several by height on one layer the last one stays, as a
/// layer holds one mark; entries by layer index are kept as given and come first.
fn layer_gcode(specs: &[LayerGcodeSpec], session: &SliceSession) -> Result<Vec<crate::gcode::LayerGcode>> {
    let bad = |i: usize, reason: &str| Error::Config {
        key: "options.layerGcode",
        reason: format!("entry {i} {reason}"),
    };
    let tops = if specs.iter().any(|g| g.z_mm.is_some()) {
        session.layer_tops()
    } else {
        Vec::new()
    };
    let mut out = Vec::with_capacity(specs.len());
    let mut by_height: BTreeMap<u32, crate::gcode::LayerGcode> = BTreeMap::new();
    for (i, g) in specs.iter().enumerate() {
        let make = |layer: u32| crate::gcode::LayerGcode {
            layer,
            kind: g.kind.clone(),
            gcode: g.gcode.clone(),
        };
        match (g.layer, g.z_mm) {
            (Some(l), None) => out.push(make(l)),
            (None, Some(z)) if z.is_finite() && z >= 0.0 => {
                #[allow(clippy::cast_possible_truncation, reason = "layer tops are f32")]
                let at = tops
                    .iter()
                    .position(|&t| t >= (z - 1e-4) as f32)
                    .unwrap_or(tops.len().saturating_sub(1));
                by_height.insert(
                    u32::try_from(at).unwrap_or(u32::MAX),
                    make(u32::try_from(at).unwrap_or(u32::MAX)),
                );
            }
            (None, Some(_)) => return Err(bad(i, "needs a zMm of 0 or more")),
            _ => return Err(bad(i, "needs one of layer and zMm")),
        }
    }
    out.extend(by_height.into_values());
    Ok(out)
}

/// Renders a custom G-code template (the placeholder language of start, end,
/// layer change and tool change G-code) with the variables of a sliced plate,
/// at layer `layer` of `out`. For previews of a profile's G-code and for tests.
pub fn render_gcode_template(
    config: &PrintConfig,
    out: &SliceOutput,
    template: &str,
    layer: u32,
) -> std::result::Result<String, String> {
    let mut ctx = crate::customgcode::context(config, out);
    ctx.set_num("layer_num", f64::from(layer));
    let z = out
        .layers
        .iter()
        .find(|l| l.index == layer)
        .map_or(0.0, |l| f64::from(l.z));
    ctx.set_num("layer_z", z);
    crate::template::render(template, &ctx)
}

/// Runs a whole request: plate, slice (in `options.shards` ranges), G-code,
/// preview and the report.
pub fn run_request(req: &SliceRequest, meshes: &dyn Fn(&str) -> Result<Arc<Mesh>>) -> Result<SliceRun> {
    run_request_with(req, meshes, &NoProgress)
}

/// [`run_request`] with progress: stage reports from slicing, then
/// [`Stage::Gcode`] and [`Stage::Preview`] as each layer range is written.
/// Fractions are per stage and per range, from 0 to 1.
pub fn run_request_with(
    req: &SliceRequest,
    meshes: &dyn Fn(&str) -> Result<Arc<Mesh>>,
    progress: &dyn Progress,
) -> Result<SliceRun> {
    let timer = Timer::start();
    let (config, config_issues) = request_config_checked(req)?;
    let plate = build_plate(req, meshes)?;
    let session = build_session(req, &plate, &config)?;
    let n = session.layer_count();
    let shards = req.options.shards.unwrap_or(1).clamp(1, n.max(1));
    let want_gcode = req.options.emit_gcode.unwrap_or(true);
    let want_preview = req.options.emit_preview.unwrap_or(true);
    let mut run = SliceRun::default();
    let mut chunks = Vec::new();
    let mut report = SliceReport {
        schema_version: SCHEMA_VERSION,
        engine: "sx".to_owned(),
        layer_count: n,
        filament_map: session.filament_map().map(FilamentMapReport::from),
        ..SliceReport::default()
    };
    let mut tools = 1usize;
    let (thumb_specs, thumb_skipped) = crate::thumbnail::specs(&config);
    let given = match &req.options.thumbnail {
        Some(t) => Some(
            crate::thumbnail::base64_decode(&t.rgba)
                .and_then(|b| crate::thumbnail::Thumb::new(t.width, t.height, b))
                .ok_or_else(|| Error::Config {
                    key: "options.thumbnail",
                    reason: "expected width, height and RGBA bytes as base64".to_owned(),
                })?,
        ),
        None => None,
    };
    let mut renderer: Option<crate::thumbnail::Renderer> = None;
    let resume_at = req.options.resume_from_layer.filter(|&r| r > 0).unwrap_or(0);
    let mut extras: Vec<(u32, crate::extras::LayerExtras)> = Vec::new();
    let mut hits = crate::collide::Hits::default();
    let draw = want_gcode && given.is_none() && !thumb_specs.is_empty();
    for s in 0..shards {
        if progress.cancelled() {
            return Err(Error::Cancelled);
        }
        let lo = n * s / shards;
        let hi = n * (s + 1) / shards;
        let mut sink = Vec::new();
        let target: &mut Vec<u8> = if want_gcode { &mut run.gcode } else { &mut sink };
        let before = target.len();
        let mut out = slice_shard_paths(req, &session, &config, lo..hi, progress)?;
        hits.merge(std::mem::take(&mut out.collisions));
        let drawing = if draw {
            let side = thumb_specs
                .iter()
                .map(|t| t.width.max(t.height))
                .max()
                .unwrap_or(64);
            Some(renderer.get_or_insert_with(|| {
                crate::thumbnail::Renderer::new(
                    out.plate_bounds,
                    out.plate_top_z,
                    side,
                    crate::thumbnail::filament_color(&config),
                )
            }))
        } else {
            None
        };
        // The G-code, the preview and the thumbnail are written from the same paths at the same time.
        let (stats, preview) = crate::par::join(
            || emit_shard(req, &session, &config, &out, progress, &mut *target),
            || {
                crate::par::join(
                    || want_preview.then(|| preview_buffers(&out)),
                    || {
                        if let Some(r) = drawing {
                            r.add(&out);
                        }
                    },
                )
                .0
            },
        );
        let stats = stats?;
        if want_gcode && want_preview {
            let text = String::from_utf8_lossy(target.get(before..).unwrap_or(&[]));
            let parsed = crate::extras::parse(&out, &config, resume_at, &text);
            extras.extend(out.layers.iter().map(|l| l.index).zip(parsed));
        }
        if let Some(p) = preview {
            progress.report(Stage::Preview, 0.0);
            chunks.push(p);
            progress.report(Stage::Preview, 1.0);
        }
        tools = tools.max(stats.filament_mm.len());
        report.stats.filament_mm.resize(tools, 0.0);
        report.stats.filament_g.resize(tools, 0.0);
        for (acc, v) in report.stats.filament_mm.iter_mut().zip(&stats.filament_mm) {
            *acc += v;
        }
        for (acc, v) in report.stats.filament_g.iter_mut().zip(&stats.filament_g) {
            *acc += v;
        }
        report.stats.time_s += stats.time_s;
        report.stats.cost += stats.cost;
        report.stats.tool_changes += stats.tool_changes;
        report.layer_z.extend(out.layers.iter().map(|l| l.z));
        report.layer_time_s.extend(out.layers.iter().map(|l| l.time_s));
        if report.prime_tower.is_none() {
            report.prime_tower = out.prime_tower;
        }
        if report.vary_layer_cost.is_none() {
            report.vary_layer_cost = out.vary_layer_cost;
        }
        let m = out.stage_micros;
        let acc = &mut report.stage_micros;
        acc.layers = m.layers;
        acc.contours += m.contours;
        acc.perimeters += m.perimeters;
        acc.surfaces += m.surfaces;
        acc.infill += m.infill;
        acc.paths += m.paths;
        if s == 0 {
            report.warnings = out.warnings;
        } else {
            for w in out.warnings {
                if !report.warnings.contains(&w) {
                    report.warnings.push(w);
                }
            }
        }
    }
    let hardness = crate::preflight::nozzle_hardness(&config, &report.stats.filament_mm);
    for i in config_issues.iter().chain(&hardness) {
        report.warnings.push(SliceWarning {
            code: WarningCode::SafetyLimit,
            message: i.message.clone(),
            layer: None,
        });
    }
    if want_preview {
        let refs: Vec<&[u8]> = chunks.iter().map(Vec::as_slice).collect();
        run.preview = if refs.len() == 1 {
            chunks.pop().unwrap_or_default()
        } else {
            stitch_preview(&refs)?
        };
    }
    let mut gcode_sha = String::new();
    if want_gcode {
        let image = given.or_else(|| renderer.map(crate::thumbnail::Renderer::finish));
        let (finished, timing) = crate::firmware::finalize_timed(&run.gcode, image.as_ref(), Some(&config));
        run.gcode = finished;
        // The whole file's time, as the footer states it (the shards' own sums leave out the joins).
        if let Some(t) = crate::firmware::footer_time(&run.gcode) {
            report.stats.time_s = t;
        }
        // The layers' times as the whole file's simulation reads them, and the start before the first layer, so
        // the preview plays the time the estimate states and not the shards' own per-layer sums.
        if timing.layer_s.len() == report.layer_time_s.len() && !timing.layer_s.is_empty() {
            #[allow(clippy::cast_possible_truncation, reason = "seconds of a layer")]
            let layer_s: Vec<f32> = timing.layer_s.iter().map(|&t| t as f32).collect();
            report.stats.prepare_s = timing.prepare_s;
            if want_preview && crate::preview::set_layer_times(&mut run.preview, &layer_s) {
                report.layer_time_s = layer_s;
            }
        }
        let binary = crate::firmware::truthy(&config, "binary_gcode");
        match crate::outname::file_name(&config, &name_info(req), &run.gcode, binary) {
            Ok(name) => report.file_name = Some(name),
            Err(e) => report.warnings.push(SliceWarning {
                code: WarningCode::UnsupportedSetting,
                message: e,
                layer: None,
            }),
        }
        let (text, failed) = crate::firmware::substitute(std::mem::take(&mut run.gcode), &config)?;
        run.gcode = text;
        for f in failed {
            report.warnings.push(SliceWarning {
                code: WarningCode::UnsupportedSetting,
                message: format!("G-code substitution {f} was skipped"),
                layer: None,
            });
        }
        // The preview's line numbers come from the text before line numbers or binary encoding, so they
        // are read while the file is finished and hashed.
        let numbered = crate::firmware::truthy(&config, "gcode_add_line_number") && !binary;
        let text = std::mem::take(&mut run.gcode);
        let (lines, (last, sha)) = crate::par::join(
            || {
                (want_preview && !binary)
                    .then(|| crate::extras::finish(&extras, resume_at, &String::from_utf8_lossy(&text)))
            },
            || {
                let last = if numbered {
                    Some(crate::firmware::number_lines(&text))
                } else if binary {
                    Some(crate::bgcode::encode(&String::from_utf8_lossy(&text), &config))
                } else {
                    None
                };
                let sha = crate::sha256::hex(last.as_deref().unwrap_or(&text));
                (last, sha)
            },
        );
        if let Some((segs, travels)) = lines {
            run.preview = crate::preview::with_extras(std::mem::take(&mut run.preview), &segs, &travels);
        }
        run.gcode = last.unwrap_or(text);
        if binary {
            report.gcode_format = Some("bgcode".to_owned());
        }
        gcode_sha = sha;
    }
    let collisions = collision_report(
        session.collide_meta(),
        &hits,
        &report.layer_time_s,
        report.stats.prepare_s,
    );
    report.collisions = collisions.collisions;
    report.collision_fixes = collisions.fixes;
    for skipped in &thumb_skipped {
        report.warnings.push(SliceWarning {
            code: WarningCode::UnsupportedSetting,
            message: format!("Thumbnail {skipped} is not available yet (PNG and QOI are)"),
            layer: None,
        });
    }
    report.gcode_bytes = run.gcode.len() as u64;
    report.gcode_sha256 = gcode_sha;
    report.preview_bytes = run.preview.len() as u64;
    #[allow(
        clippy::cast_precision_loss,
        reason = "wall time in microseconds is far below 2^52"
    )]
    {
        report.wall_ms = timer.micros() as f64 / 1000.0;
    }
    run.report = report;
    Ok(run)
}

/// JSON Schema (draft 2020-12) of [`SliceRequest`].
pub const REQUEST_SCHEMA: &str = r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://slicerx.app/schema/slice-request-1.json",
  "title": "SliceRequest",
  "type": "object",
  "required": ["plate"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "plate": {
      "type": "object",
      "required": ["objects"],
      "properties": {
        "bed": {
          "type": "object",
          "required": ["widthMm", "depthMm", "heightMm"],
          "properties": {
            "widthMm": { "type": "number", "exclusiveMinimum": 0 },
            "depthMm": { "type": "number", "exclusiveMinimum": 0 },
            "heightMm": { "type": "number", "exclusiveMinimum": 0 }
          }
        },
        "objects": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "required": ["mesh"],
            "properties": {
              "id": { "type": "string" },
              "name": { "type": "string" },
              "mesh": { "type": ["string", "integer"], "description": "Mesh reference; for the sx CLI a file path or a key of meshes" },
              "transform": { "type": "array", "items": { "type": "number" }, "minItems": 16, "maxItems": 16 },
              "slotOverrides": { "type": "object", "additionalProperties": { "type": "integer", "minimum": 1, "maximum": 255 } },
              "partSettings": { "type": "object", "additionalProperties": { "type": "object" } },
              "volumes": { "type": "array", "items": { "type": "object", "required": ["role", "mesh"], "properties": { "name": { "type": "string" }, "role": { "enum": ["negative", "support_blocker", "support_enforcer"] }, "mesh": { "type": ["string", "integer"] }, "transform": { "type": "array", "items": { "type": "number" }, "minItems": 16, "maxItems": 16 } } }, "description": "Cuts and support regions of this object, in the mesh's space" },
              "settings": { "type": "object", "description": "Orca key overrides for this object. Objects with different ones slice with their own (walls, infill, shells, supports and speeds; temperatures, fans and retraction come from the plate)" }
            }
          }
        }
      }
    },
    "config": { "type": "object", "description": "PrintConfig with Orca key names; missing keys use the defaults" },
    "options": {
      "type": "object",
      "properties": {
        "engine": { "enum": ["sx", "orca"] },
        "flavor": { "enum": ["marlin2", "klipper", "reprapfirmware", "bambu", "marlin", "reprap", "repetier", "teacup", "makerware", "sailfish", "mach3", "machinekit", "smoothie", "no-extrusion", "griffin", "cheetah"] },
        "shards": { "type": "integer", "minimum": 1 },
        "emitGcode": { "type": "boolean" },
        "emitPreview": { "type": "boolean" },
        "layerGcode": { "type": "array", "items": { "type": "object", "required": ["kind"], "oneOf": [{ "required": ["layer"] }, { "required": ["zMm"] }], "properties": { "layer": { "type": "integer", "minimum": 0 }, "zMm": { "type": "number", "minimum": 0, "description": "Placed on the first layer whose top reaches this height" }, "kind": { "enum": ["pause", "color_change", "custom"] }, "gcode": { "type": "string" } } }, "description": "G-code at the start of layers; pause and color_change use the profile's pause and color change G-code" },
        "resumeZ": { "type": "object", "required": ["mode", "zMm"], "properties": { "mode": { "const": "declare" }, "zMm": { "type": "number", "minimum": 0 } }, "description": "With resumeFromLayer: write G92 Z after homing X and Y; the nozzle must be at zMm by hand" },
        "resumeFromLayer": { "type": "integer", "minimum": 0, "description": "Write G-code only from this layer (0-based), after a resume start: heat, home X and Y not Z, no purge" },
        "heightRanges": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["zFromMm", "zToMm", "settings"],
            "properties": {
              "zFromMm": { "type": "number" },
              "zToMm": { "type": "number" },
              "settings": { "type": "object", "description": "Orca keys; wall_loops, nozzle_temperature, filament_flow_ratio, enable_pressure_advance, pressure_advance, speeds and retraction only" },
              "objects": { "type": "array", "items": { "type": "string" }, "description": "Ids of the plate objects the range applies to; absent for every object. Objects printed layer by layer share the nozzle temperature, pressure advance and retraction of a layer" }
            }
          }
        },
        "layerTopsMm": { "type": "array", "items": { "type": "number", "exclusiveMinimum": 0 }, "minItems": 1, "description": "sleipnir: top of every layer in mm, ascending, first entry is the first layer's top" },
        "plateName": { "type": "string", "description": "For filename_format: {plate_name}" },
        "plateNumber": { "type": "integer", "minimum": 1, "description": "For filename_format: {plate_number}, from 1" },
        "modelName": { "type": "string", "description": "For filename_format: {model_name}, the project's name" },
        "printerId": { "type": "string", "description": "Printer profile id (bambu-h2d): the head, gantry and tool changer the collision check uses" }
      }
    },
    "meshes": { "type": "object", "additionalProperties": { "type": "string" }, "description": "sx CLI only: mesh reference to file path" }
  }
}
"#;

/// JSON Schema (draft 2020-12) of [`SliceReport`].
pub const RESULT_SCHEMA: &str = r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://slicerx.app/schema/slice-result-1.json",
  "title": "SliceReport",
  "type": "object",
  "required": ["schemaVersion", "engine", "layerCount", "layerZ", "layerTimeS", "stats", "stageMicros", "wallMs", "warnings", "gcodeBytes", "gcodeSha256", "previewBytes"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "engine": { "enum": ["sx", "orca"] },
    "layerCount": { "type": "integer", "minimum": 0 },
    "layerZ": { "type": "array", "items": { "type": "number" } },
    "layerTimeS": { "type": "array", "items": { "type": "number" } },
    "stats": {
      "type": "object",
      "required": ["timeS", "filamentMm", "filamentG", "cost", "toolChanges"],
      "properties": {
        "timeS": { "type": "number" },
        "prepareS": { "type": "number", "description": "Seconds of timeS before the first layer (heating, homing, the purge line); layerTimeS adds up to the rest" },
        "filamentMm": { "type": "array", "items": { "type": "number" } },
        "filamentG": { "type": "array", "items": { "type": "number" } },
        "cost": { "type": "number" },
        "toolChanges": { "type": "integer" }
      }
    },
    "stageMicros": { "type": "object", "additionalProperties": { "type": "integer" } },
    "wallMs": { "type": "number" },
    "warnings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["code", "message"],
        "properties": {
          "code": { "enum": ["open_edges", "thin_wall", "floating_region", "long_bridge", "outside_bed", "unsupported_setting", "manual_step", "safety_limit"] },
          "message": { "type": "string" },
          "layer": { "type": "integer" }
        }
      }
    },
    "gcodeBytes": { "type": "integer" },
    "gcodeSha256": { "type": "string" },
    "fileName": { "type": "string", "description": "The G-code's file name from filename_format" },
    "previewBytes": { "type": "integer" },
    "filamentMap": {
      "type": "object",
      "description": "The extruder and nozzle of each filament on a printer with two extruders fed by their own AMS",
      "required": ["extruders", "nozzles", "auto"],
      "properties": {
        "extruders": { "type": "array", "items": { "type": "integer", "minimum": 1 } },
        "nozzles": { "type": "array", "items": { "type": "integer", "minimum": 0 } },
        "auto": { "type": "boolean" }
      }
    }
  }
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn cube() -> Arc<Mesh> {
        let positions = vec![
            [0.0, 0.0, 0.0],
            [10.0, 0.0, 0.0],
            [10.0, 10.0, 0.0],
            [0.0, 10.0, 0.0],
            [0.0, 0.0, 10.0],
            [10.0, 0.0, 10.0],
            [10.0, 10.0, 10.0],
            [0.0, 10.0, 10.0],
        ];
        let triangles = vec![
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];
        let part = MeshPart {
            name: "cube".into(),
            slot: 1,
            color: None,
            positions,
            triangles,
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
            paint_texts: Vec::new(),
        };
        Arc::new(Mesh {
            name: "cube".into(),
            parts: vec![part],
        })
    }

    #[test]
    fn json_request_round_trip() {
        let req: SliceRequest = serde_json::from_str(
            r#"{"schemaVersion":1,"plate":{"objects":[{"mesh":7}]},"config":{"layer_height":0.2},"options":{"shards":3}}"#,
        )
        .unwrap();
        let mesh = cube();
        let run = run_request(&req, &|id: &str| {
            assert_eq!(id, "7");
            Ok(mesh.clone())
        })
        .unwrap();
        assert_eq!(run.report.layer_count, 50);
        assert_eq!(run.report.layer_z.len(), 50);
        assert_eq!(run.report.gcode_sha256.len(), 64);
        let one: SliceRequest = serde_json::from_str(r#"{"plate":{"objects":[{"mesh":7}]}}"#).unwrap();
        let single = run_request(&one, &|_: &str| Ok(mesh.clone())).unwrap();
        assert_eq!(single.gcode, run.gcode);
        assert_eq!(single.preview, run.preview);
        let json = serde_json::to_string(&run.report).unwrap();
        let back: SliceReport = serde_json::from_str(&json).unwrap();
        assert_eq!(back.layer_count, run.report.layer_count);
        assert_eq!(back.gcode_sha256, run.report.gcode_sha256);
        assert_eq!(back.layer_z, run.report.layer_z);
    }

    #[test]
    fn filament_mass_and_cost() {
        let mesh = cube();
        let run = |config: &str| {
            let body = format!(r#"{{"plate":{{"objects":[{{"mesh":1}}]}},"config":{config}}}"#);
            let req: SliceRequest = serde_json::from_str(&body).unwrap();
            run_request(&req, &|_: &str| Ok(mesh.clone()))
                .unwrap()
                .report
                .stats
        };
        let area = std::f64::consts::PI * 0.875 * 0.875;
        let s = run(
            r#"{"filament_diameter":[1.75],"filament_density":[1.0],"filament_cost":[20],"line_width":0}"#,
        );
        let mm = s.filament_mm[0];
        assert!(mm > 100.0);
        assert!((s.filament_g[0] - mm * area / 1000.0).abs() < 1e-9);
        assert!((s.cost - s.filament_g[0] / 1000.0 * 20.0).abs() < 1e-9);
        // The settings defaults leave density and cost at 0 until a filament is chosen.
        let d = run(r#"{"filament_density":[0.0],"filament_cost":[0.0],"line_width":"0"}"#);
        assert!((d.filament_g[0] - d.filament_mm[0] * area / 1000.0 * 1.24).abs() < 1e-9);
        assert!(d.cost.abs() < 1e-12);
    }

    #[test]
    fn progress_reaches_every_stage() {
        struct Log(std::sync::Mutex<Vec<(Stage, f32)>>);
        impl Progress for Log {
            fn report(&self, stage: Stage, fraction: f32) {
                if let Ok(mut v) = self.0.lock() {
                    v.push((stage, fraction));
                }
            }
        }
        let mesh = cube();
        let req: SliceRequest =
            serde_json::from_str(r#"{"plate":{"objects":[{"mesh":1}]},"options":{"shards":2}}"#).unwrap();
        let log = Log(std::sync::Mutex::new(Vec::new()));
        run_request_with(&req, &|_: &str| Ok(mesh.clone()), &log).unwrap();
        let seen = log.0.into_inner().unwrap();
        for stage in [Stage::Contours, Stage::Paths, Stage::Gcode, Stage::Preview] {
            assert_eq!(
                seen.iter()
                    .filter(|(s, f)| *s == stage && (*f - 1.0).abs() < f32::EPSILON)
                    .count(),
                2,
                "{stage:?}"
            );
        }
    }

    /// A 20 mm box, 10 mm tall, under a roof rising 2 mm to its middle: walls sleipnir prints at full height and a
    /// shallow roof it thins.
    fn house() -> Arc<Mesh> {
        let part = MeshPart {
            name: "house".into(),
            slot: 1,
            color: None,
            positions: vec![
                [0.0, 0.0, 0.0],
                [20.0, 0.0, 0.0],
                [20.0, 20.0, 0.0],
                [0.0, 20.0, 0.0],
                [0.0, 0.0, 10.0],
                [20.0, 0.0, 10.0],
                [20.0, 20.0, 10.0],
                [0.0, 20.0, 10.0],
                [10.0, 10.0, 12.0],
            ],
            triangles: vec![
                [0, 2, 1],
                [0, 3, 2],
                [0, 1, 5],
                [0, 5, 4],
                [1, 2, 6],
                [1, 6, 5],
                [2, 3, 7],
                [2, 7, 6],
                [3, 0, 4],
                [3, 4, 7],
                [4, 5, 8],
                [5, 6, 8],
                [6, 7, 8],
                [7, 4, 8],
            ],
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
            paint_texts: Vec::new(),
        };
        Arc::new(Mesh {
            name: "house".into(),
            parts: vec![part],
        })
    }

    fn house_layers(config: &str, options: &str) -> Vec<f32> {
        let mesh = house();
        let body =
            format!(r#"{{"plate":{{"objects":[{{"mesh":1}}]}},"config":{config},"options":{options}}}"#);
        let req: SliceRequest = serde_json::from_str(&body).unwrap();
        run_request(&req, &|_: &str| Ok(mesh.clone()))
            .unwrap()
            .report
            .layer_z
    }

    fn uniform(z: &[f32]) -> bool {
        z.windows(2).all(|w| ((w[1] - w[0]) - 0.2).abs() < 1e-4)
    }

    #[cfg(feature = "sleipnir")]
    #[test]
    fn smart_layer_without_tops_plans_layers() {
        let z = house_layers(r#"{"layer_height":0.2,"smart_layer":"quality"}"#, "{}");
        // Full 0.2 mm layers up the walls, thinner ones on the shallow roof.
        assert!((z[10] - 2.2).abs() < 1e-4, "{z:?}");
        assert!(z.windows(2).any(|w| w[1] - w[0] < 0.19), "{z:?}");
        assert!(z.windows(2).all(|w| w[1] > w[0]), "tops ascend");
        assert!((z.last().unwrap() - 12.0).abs() < 1e-3, "reaches the roof, {z:?}");
    }

    #[test]
    fn layer_tops_win_over_smart_layer() {
        // 0.5 mm tops up to the roof, where sleipnir would plan 0.2 mm and thinner.
        let tops: Vec<String> = (1..=24).map(|i| format!("{:.1}", f64::from(i) * 0.5)).collect();
        let z = house_layers(
            r#"{"layer_height":0.2,"smart_layer":"quality"}"#,
            &format!(r#"{{"layerTopsMm":[{}]}}"#, tops.join(",")),
        );
        assert_eq!(z.len(), 24);
        assert!((z[3] - 2.0).abs() < 1e-4);
    }

    #[test]
    fn no_smart_layer_keeps_layer_height() {
        for config in [
            r#"{"layer_height":0.2}"#,
            r#"{"layer_height":0.2,"smart_layer":"off"}"#,
        ] {
            let z = house_layers(config, "{}");
            assert_eq!(z.len(), 60, "{config}");
            assert!(uniform(&z), "{config}: {z:?}");
        }
    }

    #[test]
    fn layer_tops_option_sets_layers() {
        let mesh = cube();
        let body = r#"{"plate":{"objects":[{"mesh":1}]},"options":{"layerTopsMm":[0.2,0.4,0.7,1.2,1.9,2.6,3.3,4.0,4.7,5.4,6.1,6.8,7.5,8.2,8.9,9.6,10.3]}}"#;
        let req: SliceRequest = serde_json::from_str(body).unwrap();
        let run = run_request(&req, &|_: &str| Ok(mesh.clone())).unwrap();
        assert_eq!(run.report.layer_count, 17);
        assert!((run.report.layer_z[2] - 0.7).abs() < 1e-6);
        let g = String::from_utf8_lossy(&run.gcode);
        assert!(g.contains("Z0.7"));
        let bad = body.replace("9.6,10.3", "9.6,9.6");
        let req: SliceRequest = serde_json::from_str(&bad).unwrap();
        assert!(run_request(&req, &|_: &str| Ok(mesh.clone())).is_err());
    }

    #[test]
    fn cancel_flag_stops_the_run() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct StopAfterContours<'a>(&'a AtomicBool);
        impl Progress for StopAfterContours<'_> {
            fn report(&self, stage: Stage, _fraction: f32) {
                if stage == Stage::Contours {
                    self.0.store(true, Ordering::Relaxed);
                }
            }
        }
        let mesh = cube();
        let req: SliceRequest =
            serde_json::from_str(r#"{"plate":{"objects":[{"mesh":1}]},"options":{"shards":4}}"#).unwrap();
        let flag = AtomicBool::new(false);
        let go = Cancellable {
            progress: &NoProgress,
            flag: &flag,
        };
        assert!(run_request_with(&req, &|_: &str| Ok(mesh.clone()), &go).is_ok());
        // Cancel from the progress callback, as a UI thread would from outside.
        let inner = StopAfterContours(&flag);
        let stop = Cancellable {
            progress: &inner,
            flag: &flag,
        };
        let err = run_request_with(&req, &|_: &str| Ok(mesh.clone()), &stop).unwrap_err();
        assert!(matches!(err, Error::Cancelled), "{err}");
        // Already set before the run starts.
        assert!(matches!(
            run_request_with(&req, &|_: &str| Ok(mesh.clone()), &stop),
            Err(Error::Cancelled)
        ));
    }

    #[test]
    fn rejects_unknown_version_and_engine() {
        let mesh = cube();
        for body in [
            r#"{"schemaVersion":2,"plate":{"objects":[{"mesh":1}]}}"#,
            r#"{"plate":{"objects":[{"mesh":1}]},"options":{"engine":"cura"}}"#,
        ] {
            let req: SliceRequest = serde_json::from_str(body).unwrap();
            assert!(run_request(&req, &|_: &str| Ok(mesh.clone())).is_err());
        }
    }
}
