// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Read helpers over a `PrintConfig` and the `enabledWhen` dependency check.

use crate::schema::{CondOp, Condition, Mode, Section, SettingDef, setting_def, settings};
use crate::value::{PrintConfig, Scalar, Value, parse_percent_or_number};

/// The scalar value of `key`: first entry of a per-extruder list. With `use_default` the schema
/// default stands in for a key the config does not set.
#[must_use]
pub fn scalar_of(config: &PrintConfig, key: &str, use_default: bool) -> Option<Scalar> {
    if let Some(v) = config.get(key) {
        return v.first_scalar();
    }
    if !use_default {
        return None;
    }
    let def = setting_def(key)?;
    Value::from_json(&def.default)?.first_scalar()
}

#[must_use]
pub fn number_of(config: &PrintConfig, key: &str, use_default: bool) -> Option<f64> {
    match scalar_of(config, key, use_default)? {
        Scalar::Num(n) => Some(n).filter(|v| v.is_finite()),
        Scalar::Str(s) => parse_percent_or_number(&s),
        Scalar::Bool(_) => None,
    }
}

/// A line width that may be `0` (auto), `0.42`, or a percent of the nozzle.
#[must_use]
pub fn width_of(config: &PrintConfig, key: &str, nozzle: f64, use_default: bool) -> f64 {
    if let Some(Scalar::Str(s)) = scalar_of(config, key, use_default)
        && let Some(p) = s.strip_suffix('%')
        && let Some(n) = parse_percent_or_number(p)
    {
        return n / 100.0 * nozzle;
    }
    number_of(config, key, use_default)
        .filter(|n| *n > 0.0)
        .unwrap_or(nozzle)
}

fn json_scalar(j: &serde_json::Value) -> Option<Scalar> {
    match j {
        serde_json::Value::Bool(b) => Some(Scalar::Bool(*b)),
        serde_json::Value::Number(n) => n.as_f64().map(Scalar::Num),
        serde_json::Value::String(s) => Some(Scalar::Str(s.clone())),
        _ => None,
    }
}

fn holds(c: &Condition, config: &PrintConfig) -> bool {
    let v = scalar_of(config, &c.key, true);
    match c.op {
        CondOp::Eq => v.is_some() && v == json_scalar(&c.value),
        CondOp::Ne => v != json_scalar(&c.value),
        CondOp::In | CondOp::Notin => {
            let listed = c
                .value
                .as_array()
                .is_some_and(|a| a.iter().any(|x| v.is_some() && json_scalar(x) == v));
            if c.op == CondOp::In {
                listed
            } else {
                c.value.is_array() && !listed
            }
        }
        CondOp::Gt | CondOp::Ge | CondOp::Lt | CondOp::Le => {
            let (Some(Scalar::Num(a)), Some(b)) = (v, c.value.as_f64()) else {
                return false;
            };
            match c.op {
                CondOp::Gt => a > b,
                CondOp::Ge => a >= b,
                CondOp::Lt => a < b,
                _ => a <= b,
            }
        }
    }
}

/// True when every `enabledWhen` condition of `def` holds in `config`.
#[must_use]
pub fn is_enabled(def: &SettingDef, config: &PrintConfig) -> bool {
    def.enabled_when.iter().all(|c| holds(c, config))
}

/// The conditions of `def` that do not hold, for "why is this grayed out" text.
#[must_use]
pub fn failed_conditions<'a>(def: &'a SettingDef, config: &PrintConfig) -> Vec<&'a Condition> {
    def.enabled_when.iter().filter(|c| !holds(c, config)).collect()
}

/// Keys of `config` that the current values switch off, as Orca's own UI would gray them.
#[must_use]
pub fn disabled_keys(config: &PrintConfig) -> Vec<String> {
    settings()
        .iter()
        .filter(|d| config.contains(&d.key) && !is_enabled(d, config))
        .map(|d| d.key.clone())
        .collect()
}

/// True when a UI should list `def`: never for hidden and develop keys, and multicolor keys only with two or more filaments.
#[must_use]
pub fn is_visible(def: &SettingDef, filament_count: usize) -> bool {
    if matches!(def.mode, Mode::Hidden | Mode::Develop) {
        return false;
    }
    def.show_when.as_deref() != Some("multicolor") || filament_count >= 2
}

/// The keys a tier shows (`simple`, `advanced` or `expert`); tiers are cumulative.
#[must_use]
pub fn settings_for_tier(section: Section, tier: Mode, filament_count: usize) -> Vec<&'static SettingDef> {
    let rank = |m: Mode| match m {
        Mode::Simple => 0,
        Mode::Advanced => 1,
        Mode::Expert => 2,
        Mode::Develop | Mode::Hidden => 99,
    };
    settings()
        .iter()
        .filter(|d| d.section == section && is_visible(d, filament_count) && rank(d.mode) <= rank(tier))
        .collect()
}
