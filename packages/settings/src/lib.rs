// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-settings. See README.md for the public API.
//!
//! The schema (`schema.json`), Easy mode (`easy-map.json`) and profile import rules
//! (`legacy.json`) are data files shared with the TypeScript package `@slicerx/settings`.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

mod api;
mod auto;
mod bundle;
mod config;
mod diff;
mod easy;
mod error;
mod filaments;
mod import;
mod intent;
mod knowledge;
mod plan;
mod printer_models;
mod profiles;
mod project;
mod report;
mod schema;
mod smart_layer;
mod thin_layers;
mod validate;
mod value;

pub use api::{
    apply_easy_json, apply_plan_json, catalog_json, export_profile_json, import_profile_json,
    import_project_json, plan_json, resolve_auto_json, validate_json,
};
pub use auto::{auto_width_ratio, resolve_auto};
pub use bundle::{
    BundleType, MAX_BUNDLE_PRESETS, MAX_PRESET_BYTES, PresetBundle, PresetFile, Skipped, preset_kind,
    read_preset_bundle,
};
pub use config::{
    disabled_keys, failed_conditions, is_enabled, is_visible, number_of, scalar_of, settings_for_tier,
    width_of,
};
pub use diff::{ChangeKind, ConfigDiffEntry, diff_configs, first_stage, format_value, same_value};
pub use easy::{
    EasyGoal, EasySettings, SmartLayer, SpeedPreset, SupportMode, apply_choice, apply_easy, choice_value,
    derive_shell_layers, easy_choices, easy_control_for, easy_control_label, easy_keys, goal_easy,
    match_goal,
};
pub use error::Error;
pub use filaments::{FamilyEntry, FilamentPreset, VendorFile};
pub use import::{ProfileImport, export_orca, import_orca, merge_layers};
pub use intent::short_name;
pub use knowledge::{GoalKnowledge, MaterialKnowledge, PrinterKnowledge, knowledge};
pub use plan::{
    CalibrationResult, PlanAdvice, PlanCaveat, PlanClamp, PlanGoal, PlanIntent, PlanOptions, PlanRefusal,
    SettingChange, SettingsPlan, SetupRef, apply_plan, list_goals, list_materials, list_printers,
    material_knowledge, plan_settings, printer_knowledge,
};
pub use printer_models::{mapped_models, models_for_printer, printer_for_model, setup_for_model};
pub use profiles::{
    BuildVolume, MachineEntry, MachineOrigin, NozzleOverride, PrinterLimits, PrinterProfile, ProcessPreset,
    filament_config, filament_sources, gcode_status, list_printer_profiles, list_process_presets,
    machine_checked_commit, machine_entry, printer_config, printer_profile, process_config,
    process_speed_source, process_speed_sources, profile_config,
};
pub use project::{
    LayerRange, ProjectImport, ProjectNames, ProjectObject, ProjectPart, ProjectPlate, import_project,
};
pub use report::{
    DropReason, Dropped, ImportLayer, ImportReport, Instead, KeyFamily, LayersImport, ParentRef, ReportInput,
    ReportItem, ValueSource, build_report, count_defaulted, display_raw, display_value, import_layers,
    import_values, setting_label,
};
pub use schema::{
    Bound, CondOp, Condition, Effect, Mode, PilotRule, Section, SettingDef, SettingType, SliceStage,
    invalidates, orca_commit, setting_def, settings,
};
pub use smart_layer::{
    LAYER_STEP, SMART_LAYER_MAX_RATIO, SMART_LAYER_MIN_RATIO, SmartLayerLimits, is_smart_layer_on,
    smart_layer_bounds, smart_layer_limits, smart_layer_window,
};
pub use thin_layers::{HEAT_CREEP_SHARE, heat_creep_warning, layer_time_guard};
pub use validate::{
    Fix, SettingIssue, Severity, check_conflicts, check_conflicts_for, check_values, missing_keys, validate,
    validate_for,
};
pub use value::{
    Coerced, PrintConfig, Scalar, Value, coerce, parse_number, parse_percent_or_number, to_orca,
};
