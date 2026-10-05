// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Validation (types, ranges, enums) and conflict detection across keys. `js/validate.ts`
//! mirrors it; `fixtures/validate-cases.json` holds the shared cases.

use serde::Serialize;

use crate::config::{number_of, scalar_of, width_of};
use crate::knowledge::knowledge;
use crate::schema::{SettingDef, SettingType, setting_def, settings};
use crate::smart_layer::{is_smart_layer_on, smart_layer_limits, smart_layer_window};
use crate::thin_layers::{heat_creep_warning, layer_time_guard};
use crate::value::{PrintConfig, Scalar, Value, parse_percent_or_number};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Fix {
    pub key: String,
    pub value: Value,
}

/// A validation problem or a conflict between keys. `fix` is a suggested edit, never applied silently.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SettingIssue {
    pub code: String,
    pub severity: Severity,
    pub keys: Vec<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<Fix>,
}

fn issue(code: &str, severity: Severity, keys: &[&str], message: String) -> SettingIssue {
    SettingIssue {
        code: code.to_owned(),
        severity,
        keys: keys.iter().map(|k| (*k).to_owned()).collect(),
        message,
        fix: None,
    }
}

fn with_fix(mut i: SettingIssue, key: &str, value: Value) -> SettingIssue {
    i.fix = Some(Fix {
        key: key.to_owned(),
        value,
    });
    i
}

/// A number as JavaScript prints it: whole numbers without a fraction.
fn show(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        #[allow(clippy::cast_possible_truncation)]
        return (v as i64).to_string();
    }
    v.to_string()
}

fn numbers_in(v: &Value) -> Option<Vec<f64>> {
    match v {
        Value::Int(_) | Value::Float(_) | Value::Ints(_) | Value::Floats(_) => match v {
            #[allow(clippy::cast_precision_loss)]
            Value::Int(i) => Some(vec![*i as f64]),
            Value::Float(f) => Some(vec![*f]),
            #[allow(clippy::cast_precision_loss)]
            Value::Ints(xs) => Some(xs.iter().map(|x| *x as f64).collect()),
            Value::Floats(xs) => Some(xs.clone()),
            _ => None,
        },
        Value::Str(s) => parse_percent_or_number(s).map(|n| vec![n]),
        Value::Strs(xs) => xs.iter().map(|s| parse_percent_or_number(s)).collect(),
        _ => None,
    }
}

fn type_matches(def: &SettingDef, v: &Value) -> bool {
    match def.kind {
        SettingType::Float | SettingType::Int | SettingType::Percent => {
            matches!(v, Value::Int(_) | Value::Float(_))
        }
        SettingType::Bool => matches!(v, Value::Bool(_)),
        SettingType::FloatOrPercent | SettingType::Enum | SettingType::String | SettingType::Gcode => {
            matches!(v, Value::Str(_))
        }
        // A JSON pair reads back as a list of two numbers; both are a point.
        SettingType::Point => match v {
            Value::Point(_) => true,
            Value::Floats(x) => x.len() == 2,
            Value::Ints(x) => x.len() == 2,
            _ => false,
        },
        _ => v.is_list(),
    }
}

fn is_enum_kind(k: SettingType) -> bool {
    matches!(k, SettingType::Enum | SettingType::Enums)
}

/// Schema level checks for every key present: type, range, enum membership.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn check_values(config: &PrintConfig) -> Vec<SettingIssue> {
    let mut issues = Vec::new();
    for (key, v) in config.iter() {
        let Some(def) = setting_def(key) else {
            issues.push(issue(
                "unknown_key",
                Severity::Info,
                &[key],
                format!("{key} is not a known setting."),
            ));
            continue;
        };
        if !type_matches(def, v) {
            issues.push(issue(
                "wrong_type",
                Severity::Error,
                &[key],
                format!(
                    "{} has the wrong type for {}.",
                    def.label,
                    serde_json::to_value(def.kind)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default()
                ),
            ));
            continue;
        }
        if is_enum_kind(def.kind) && !def.enum_values.is_empty() {
            let known = |s: &String| def.enum_values.contains(s) || def.enum_aliases.contains_key(s);
            let bad = match v {
                Value::Str(s) if !known(s) => Some(s.clone()),
                Value::Strs(xs) => xs.iter().find(|s| !known(s)).cloned(),
                _ => None,
            };
            if let Some(b) = bad {
                issues.push(issue(
                    "bad_enum",
                    Severity::Error,
                    &[key],
                    format!(
                        "{}: \"{}\" is not one of {}.",
                        def.label,
                        b,
                        def.enum_values.join(", ")
                    ),
                ));
                continue;
            }
            let missing = match v {
                Value::Str(s) if def.unavailable_values.contains(s) => Some(s.clone()),
                Value::Strs(xs) => xs.iter().find(|s| def.unavailable_values.contains(s)).cloned(),
                _ => None,
            };
            if let Some(m) = missing {
                issues.push(issue(
                    "enum_value_unavailable",
                    Severity::Warning,
                    &[key],
                    format!(
                        "{}: \"{}\" is not supported by the SlicerX engine yet, so it prints with the default.",
                        def.label, m
                    ),
                ));
            }
        }
        let hard_lo = def.orca_min.resolve(def.min);
        let hard_hi = def.orca_max.resolve(def.max);
        let has_limits = def.min.is_some() || def.max.is_some() || hard_lo.is_some() || hard_hi.is_some();
        if !has_limits || def.kind.is_vector() != v.is_list() {
            continue;
        }
        if def.kind == SettingType::FloatOrPercent && matches!(v, Value::Str(s) if s.ends_with('%')) {
            continue;
        }
        let Some(nums) = numbers_in(v) else { continue };
        if def.auto && nums.iter().all(|n| *n == 0.0) {
            continue;
        }
        let unit = def.unit.as_ref().map_or(String::new(), |u| format!(" {u}"));
        let inf = |b: Option<f64>, neg: bool| {
            b.map_or_else(
                || {
                    if neg { "-inf".to_owned() } else { "inf".to_owned() }
                },
                show,
            )
        };
        if let Some(bad) = nums
            .iter()
            .copied()
            .find(|n| hard_lo.is_some_and(|lo| *n < lo) || hard_hi.is_some_and(|hi| *n > hi))
        {
            let fixed = match (hard_lo, hard_hi) {
                (Some(lo), _) if bad < lo => lo,
                (_, Some(hi)) => hi,
                _ => bad,
            };
            let mut i = issue(
                "out_of_range",
                Severity::Error,
                &[key],
                format!(
                    "{} is {}, outside {} to {}{}.",
                    def.label,
                    show(bad),
                    inf(hard_lo, true),
                    inf(hard_hi, false),
                    unit
                ),
            );
            if matches!(v, Value::Int(_) | Value::Float(_)) {
                i = with_fix(i, key, Value::Float(fixed));
            }
            issues.push(i);
            continue;
        }
        if let Some(soft) = nums
            .iter()
            .copied()
            .find(|n| def.min.is_some_and(|lo| *n < lo) || def.max.is_some_and(|hi| *n > hi))
        {
            issues.push(issue(
                "outside_recommended_range",
                Severity::Warning,
                &[key],
                format!(
                    "{} is {}, outside the usual {} to {}{}.",
                    def.label,
                    show(soft),
                    inf(def.min, true),
                    inf(def.max, false),
                    unit
                ),
            ));
        }
    }
    issues
}

const SPEED_WIDTH: [(&str, &str); 5] = [
    ("outer_wall_speed", "outer_wall_line_width"),
    ("inner_wall_speed", "inner_wall_line_width"),
    ("sparse_infill_speed", "sparse_infill_line_width"),
    ("internal_solid_infill_speed", "internal_solid_infill_line_width"),
    ("top_surface_speed", "top_surface_line_width"),
];

fn r2(n: f64) -> f64 {
    (n * 100.0 + 0.5).floor() / 100.0
}

/// Conflicts between keys that Orca would silently override or that print badly. Only keys the
/// config sets are judged; a partial config is not held to defaults it never chose.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn check_conflicts(config: &PrintConfig) -> Vec<SettingIssue> {
    check_conflicts_for(config, None)
}

/// `check_conflicts` with the filament's knowledge id, so material research (such as the sleipnir window)
/// is used.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn check_conflicts_for(config: &PrintConfig, filament: Option<&str>) -> Vec<SettingIssue> {
    let num = |k: &str| number_of(config, k, false);
    let flag = |k: &str| matches!(scalar_of(config, k, false), Some(Scalar::Bool(true)));
    let mut out = Vec::new();
    let nozzle = num("nozzle_diameter").unwrap_or(0.4);
    let lh = num("layer_height");
    let first = num("initial_layer_print_height");
    if let Some(lh) = lh {
        if lh > nozzle {
            out.push(with_fix(
                issue(
                    "layer_above_nozzle",
                    Severity::Error,
                    &["layer_height", "nozzle_diameter"],
                    format!(
                        "Layer height {} mm is larger than the {} mm nozzle.",
                        show(lh),
                        show(nozzle)
                    ),
                ),
                "layer_height",
                Value::Float(r2(nozzle * 0.75)),
            ));
        } else if lh > nozzle * 0.75 + 1e-9 {
            out.push(issue(
                "layer_over_75pct",
                Severity::Warning,
                &["layer_height", "nozzle_diameter"],
                format!(
                    "Layer height {} mm is above 75 percent of the {} mm nozzle; layers bond poorly.",
                    show(lh),
                    show(nozzle)
                ),
            ));
        }
        if let Some(lo) = num("min_layer_height").filter(|lo| *lo > lh) {
            out.push(issue(
                "layer_below_min",
                Severity::Warning,
                &["layer_height", "min_layer_height"],
                format!(
                    "Layer height {} mm is below the printer minimum {} mm.",
                    show(lh),
                    show(lo)
                ),
            ));
        }
        if let Some(hi) = num("max_layer_height").filter(|hi| *hi > 0.0 && lh > *hi) {
            out.push(issue(
                "layer_above_max",
                Severity::Warning,
                &["layer_height", "max_layer_height"],
                format!(
                    "Layer height {} mm is above the printer maximum {} mm.",
                    show(lh),
                    show(hi)
                ),
            ));
        }
    }
    if let Some(f) = first.filter(|f| *f > nozzle) {
        out.push(with_fix(
            issue(
                "first_layer_above_nozzle",
                Severity::Error,
                &["initial_layer_print_height", "nozzle_diameter"],
                format!(
                    "First layer height {} mm is larger than the {} mm nozzle.",
                    show(f),
                    show(nozzle)
                ),
            ),
            "initial_layer_print_height",
            Value::Float(r2(nozzle * 0.75)),
        ));
    }
    for wk in [
        "line_width",
        "outer_wall_line_width",
        "inner_wall_line_width",
        "sparse_infill_line_width",
        "top_surface_line_width",
    ] {
        if !config.contains(wk) {
            continue;
        }
        let w = width_of(config, wk, nozzle, false);
        if w < nozzle * 0.5 - 1e-9 || w > nozzle * 2.0 + 1e-9 {
            out.push(issue(
                "line_width_range",
                Severity::Warning,
                &[wk, "nozzle_diameter"],
                format!(
                    "{wk} of {} mm is far from the {} mm nozzle (0.5x to 2x is usable).",
                    show(r2(w)),
                    show(nozzle)
                ),
            ));
        }
    }
    if flag("spiral_mode") {
        if flag("enable_support") {
            out.push(with_fix(
                issue(
                    "spiral_with_support",
                    Severity::Warning,
                    &["spiral_mode", "enable_support"],
                    "Spiral vase mode prints one continuous wall and cannot use supports.".into(),
                ),
                "enable_support",
                Value::Bool(false),
            ));
        }
        if num("wall_loops").is_some_and(|w| w > 1.0) {
            out.push(issue(
                "spiral_walls",
                Severity::Info,
                &["spiral_mode", "wall_loops"],
                "Spiral vase mode prints a single wall; extra wall loops are ignored.".into(),
            ));
        }
        if num("sparse_infill_density").is_some_and(|d| d > 0.0) {
            out.push(issue(
                "spiral_infill",
                Severity::Info,
                &["spiral_mode", "sparse_infill_density"],
                "Spiral vase mode has no infill; the infill density is ignored.".into(),
            ));
        }
    }
    if let (Some(max_flow), Some(lh)) = (num("filament_max_volumetric_speed").filter(|m| *m > 0.0), lh) {
        for (sk, wk) in SPEED_WIDTH {
            let Some(s) = num(sk) else { continue };
            let w = width_of(config, wk, nozzle, false);
            let flow = s * w * lh;
            if flow > max_flow * 1.05 {
                out.push(with_fix(
                    issue(
                        "flow_limit",
                        Severity::Warning,
                        &[sk, "filament_max_volumetric_speed"],
                        format!("{sk} of {} mm/s needs {} mm3/s, above the filament limit of {} mm3/s; the printer will slow down or under-extrude.", show(s), show(r2(flow)), show(max_flow)),
                    ),
                    sk,
                    Value::Float((max_flow / (w * lh)).floor()),
                ));
            }
        }
    }
    if let (Some(t), Some(lo), Some(hi)) = (
        num("nozzle_temperature"),
        num("nozzle_temperature_range_low"),
        num("nozzle_temperature_range_high"),
    ) && hi > 0.0
        && (t < lo || t > hi)
    {
        out.push(issue(
            "temp_outside_range",
            Severity::Warning,
            &[
                "nozzle_temperature",
                "nozzle_temperature_range_low",
                "nozzle_temperature_range_high",
            ],
            format!(
                "Nozzle temperature {} C is outside the filament range {} to {} C.",
                show(t),
                show(lo),
                show(hi)
            ),
        ));
    }
    if let (Some(acc), Some(cap)) = (
        num("default_acceleration"),
        num("machine_max_acceleration_extruding"),
    ) && cap > 0.0
        && acc > cap
    {
        out.push(with_fix(
            issue(
                "accel_over_machine",
                Severity::Warning,
                &["default_acceleration", "machine_max_acceleration_extruding"],
                format!(
                    "Acceleration {} mm/s2 is above the machine limit {} mm/s2.",
                    show(acc),
                    show(cap)
                ),
            ),
            "default_acceleration",
            Value::Float(cap),
        ));
    }
    if flag("enable_arc_fitting") && num("max_volumetric_extrusion_rate_slope").is_some_and(|s| s > 0.0) {
        out.push(with_fix(
            issue(
                "arc_fitting_with_slope",
                Severity::Warning,
                &["enable_arc_fitting", "max_volumetric_extrusion_rate_slope"],
                "Arc fitting is turned off while extrusion rate smoothing is on.".into(),
            ),
            "enable_arc_fitting",
            Value::Bool(false),
        ));
    }
    if flag("use_firmware_retraction") && num("retraction_length").is_some_and(|l| l > 0.0) {
        out.push(issue(
            "firmware_retraction",
            Severity::Info,
            &["use_firmware_retraction", "retraction_length"],
            "Firmware retraction is on; the slicer retraction length is not used.".into(),
        ));
    }
    if let Some(Scalar::Str(mode)) = scalar_of(config, "smart_layer", false)
        && mode != "off"
    {
        let (s_min, s_max) = (num("smart_layer_min_height"), num("smart_layer_max_height"));
        let material = filament.and_then(|f| knowledge().materials.get(f));
        let limits = smart_layer_limits(material, Some(mode.as_str()));
        let (wmin, wmax) = smart_layer_window(nozzle, material, Some(mode.as_str()));
        let research = limits.note.as_ref().map_or(String::new(), |n| format!(" ({n})"));
        if let (Some(lo), Some(hi)) = (s_min, s_max)
            && lo >= hi
        {
            out.push(issue(
                "smart_layer_bounds_order",
                Severity::Error,
                &["smart_layer_min_height", "smart_layer_max_height"],
                format!(
                    "sleipnir thinnest layer {} mm is not below the thickest {} mm.",
                    show(lo),
                    show(hi)
                ),
            ));
        }
        if let Some(lo) = s_min.filter(|lo| *lo < limits.min_ratio * nozzle - 1e-9) {
            out.push(with_fix(
                issue(
                    "smart_layer_min_low",
                    Severity::Warning,
                    &["smart_layer_min_height", "nozzle_diameter"],
                    format!("sleipnir thinnest layer {} mm is below {} percent of the {} mm nozzle{}; layers that thin print poorly.", show(lo), show((limits.min_ratio * 100.0).round()), show(nozzle), research),
                ),
                "smart_layer_min_height",
                Value::Float(wmin),
            ));
        }
        if let Some(hi) = s_max.filter(|hi| *hi > limits.max_ratio * nozzle + 1e-9) {
            out.push(with_fix(
                issue(
                    "smart_layer_max_high",
                    Severity::Warning,
                    &["smart_layer_max_height", "nozzle_diameter"],
                    format!("sleipnir thickest layer {} mm is above {} percent of the {} mm nozzle{}; layers that thick bond poorly.", show(hi), show((limits.max_ratio * 100.0).round()), show(nozzle), research),
                ),
                "smart_layer_max_height",
                Value::Float(wmax),
            ));
        }
        if flag("spiral_mode") {
            out.push(with_fix(
                issue(
                    "smart_layer_spiral",
                    Severity::Warning,
                    &["smart_layer", "spiral_mode"],
                    "Vase mode prints at one layer height, so sleipnir has no effect.".into(),
                ),
                "smart_layer",
                Value::Str("off".to_owned()),
            ));
        }
        if let (Some(lh), Some(lo), Some(hi)) = (lh, s_min, s_max)
            && (lh < lo - 1e-9 || lh > hi + 1e-9)
        {
            out.push(issue(
                "smart_layer_outside_layer_height",
                Severity::Info,
                &["layer_height", "smart_layer_min_height", "smart_layer_max_height"],
                format!(
                    "Layer height {} mm is outside the sleipnir range {} to {} mm.",
                    show(lh),
                    show(lo),
                    show(hi)
                ),
            ));
        }
    }
    // Thin layers and the cooling slowdown.
    let max_flow = num("filament_max_volumetric_speed");
    let material = filament.and_then(|f| knowledge().materials.get(f));
    let smart_on =
        matches!(scalar_of(config, "smart_layer", false), Some(Scalar::Str(m)) if is_smart_layer_on(&m));
    if smart_on
        && let (Some(m), Some(g), Some(lt)) =
            (material, layer_time_guard(material), num("slow_down_layer_time"))
        && lt < g.min_layer_time - 1e-9
    {
        out.push(with_fix(
            issue(
                "smart_layer_min_layer_time",
                Severity::Warning,
                &["slow_down_layer_time", "smart_layer"],
                format!(
                    "sleipnir prints thin layers, and {} needs at least {} s per layer to cool them; the minimum layer time is {} s.",
                    m.name.split(" (").next().unwrap_or(&m.name),
                    show(g.min_layer_time),
                    show(lt)
                ),
            ),
            "slow_down_layer_time",
            Value::Float(g.min_layer_time),
        ));
    }
    if !matches!(
        scalar_of(config, "slow_down_for_layer_cooling", false),
        Some(Scalar::Bool(false))
    ) && let (Some(min_speed), Some(max_flow)) = (num("slow_down_min_speed"), max_flow)
    {
        let smart_min = if smart_on {
            num("smart_layer_min_height")
        } else {
            None
        };
        let thinnest = [lh, smart_min]
            .into_iter()
            .flatten()
            .fold(None, |a: Option<f64>, h| Some(a.map_or(h, |a| a.min(h))));
        if let Some(thinnest) = thinnest
            && let Some(msg) = heat_creep_warning(
                min_speed,
                width_of(config, "outer_wall_line_width", nozzle, false),
                thinnest,
                max_flow,
            )
        {
            out.push(issue(
                "heat_creep_thin_layers",
                Severity::Warning,
                &[
                    "slow_down_min_speed",
                    "layer_height",
                    "filament_max_volumetric_speed",
                ],
                msg,
            ));
        }
    }
    let zero = |k: &str| num(k) == Some(0.0);
    if zero("wall_loops")
        && zero("sparse_infill_density")
        && zero("top_shell_layers")
        && zero("bottom_shell_layers")
    {
        out.push(issue(
            "nothing_to_print",
            Severity::Error,
            &[
                "wall_loops",
                "sparse_infill_density",
                "top_shell_layers",
                "bottom_shell_layers",
            ],
            "No walls, infill or shells: nothing would print.".into(),
        ));
    }
    out
}

/// Value checks plus conflicts, errors first.
#[must_use]
pub fn validate(config: &PrintConfig) -> Vec<SettingIssue> {
    validate_for(config, None)
}

/// `validate` with the filament's knowledge id, so material research is used.
#[must_use]
pub fn validate_for(config: &PrintConfig, filament: Option<&str>) -> Vec<SettingIssue> {
    let rank = |s: Severity| match s {
        Severity::Error => 0,
        Severity::Warning => 1,
        Severity::Info => 2,
    };
    let mut all = check_values(config);
    all.extend(check_conflicts_for(config, filament));
    all.sort_by(|a, b| {
        rank(a.severity)
            .cmp(&rank(b.severity))
            .then_with(|| a.code.cmp(&b.code))
            .then_with(|| a.keys.first().cmp(&b.keys.first()))
    });
    all
}

/// Every schema key missing from `config`, for a completeness report.
#[must_use]
pub fn missing_keys(config: &PrintConfig) -> Vec<&'static str> {
    settings()
        .iter()
        .filter(|d| !config.contains(&d.key))
        .map(|d| d.key.as_str())
        .collect()
}
