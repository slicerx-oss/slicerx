// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Diff two configs with a plain reason for every change. `js/diff.ts` mirrors it.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::config::failed_conditions;
use crate::easy::{EasySettings, easy_control_for, easy_control_label, easy_control_value};
use crate::schema::{SettingDef, SettingType, SliceStage, setting_def};
use crate::value::{PrintConfig, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Removed,
    Changed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConfigDiffEntry {
    pub key: String,
    pub label: String,
    pub group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Value>,
    pub kind: ChangeKind,
    /// First slice stage the change invalidates.
    pub stage: SliceStage,
    /// Plain sentence for the Pilot diff card and the settings panel.
    pub reason: String,
}

fn unit_text(u: &str) -> &'static str {
    match u {
        "mm" => " mm",
        "mm/s" => " mm/s",
        "mm/s2" => " mm/s2",
        "mm3/s" => " mm3/s",
        "%" => "%",
        "C" | "delta-C" => " C",
        "s" => " s",
        "g/cm3" => " g/cm3",
        "deg" => " deg",
        "money/kg" => " per kg",
        "mm3" => " mm3",
        "layers" => " layers",
        "Hz" => " Hz",
        "money/h" => " per hour",
        _ => "",
    }
}

fn show(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        #[allow(clippy::cast_possible_truncation)]
        return (v as i64).to_string();
    }
    v.to_string()
}

fn clip(s: &str) -> String {
    if s.chars().count() > 60 {
        let head: String = s.chars().take(57).collect();
        format!("{head}...")
    } else {
        s.to_owned()
    }
}

/// An enum value's label (`Outer brim only` for `outer_only`); an alias reads as the value it stands for.
fn enum_text(def: Option<&SettingDef>, s: &str) -> String {
    let Some(d) = def.filter(|d| matches!(d.kind, SettingType::Enum | SettingType::Enums)) else {
        return s.to_owned();
    };
    let v = d.enum_aliases.get(s).map_or(s, String::as_str);
    d.enum_values
        .iter()
        .position(|x| x == v)
        .and_then(|i| d.enum_labels.get(i))
        .map_or_else(|| s.to_owned(), Clone::clone)
}

fn list_items(v: &Value) -> Vec<String> {
    let json = v.to_json();
    match json {
        serde_json::Value::Array(a) => a
            .iter()
            .map(|x| match x {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Human text for a value: `0.2 mm`, `on`, `220 C`, `Rectilinear`. Lists that repeat one value show it once.
#[must_use]
pub fn format_value(def: Option<&SettingDef>, v: Option<&Value>) -> String {
    let Some(v) = v else { return "not set".into() };
    let unit = def
        .filter(|d| {
            !matches!(
                d.kind,
                SettingType::FloatOrPercent | SettingType::FloatsOrPercents
            )
        })
        .and_then(|d| d.unit.as_deref())
        .map_or("", unit_text);
    match v {
        Value::Bool(b) => if *b { "on" } else { "off" }.into(),
        Value::Int(i) => format!(
            "{i}{}",
            if def.and_then(|d| d.unit.as_deref()) == Some("%") {
                "%"
            } else {
                unit
            }
        ),
        Value::Float(f) => format!(
            "{}{}",
            show(*f),
            if def.and_then(|d| d.unit.as_deref()) == Some("%") {
                "%"
            } else {
                unit
            }
        ),
        Value::Str(s) => {
            if s.is_empty() {
                "empty".into()
            } else {
                clip(&enum_text(def, s))
            }
        }
        _ => {
            let items: Vec<String> = list_items(v).iter().map(|s| enum_text(def, s)).collect();
            let repeated = items.first().is_some_and(|f| items.iter().all(|x| x == f));
            let one = match v {
                Value::Bools(b) => b.first().map(|x| Value::Bool(*x)),
                Value::Ints(i) => i.first().map(|x| Value::Int(*x)),
                Value::Floats(f) => f.first().map(|x| Value::Float(*x)),
                Value::Strs(s) => s.first().map(|x| Value::Str(x.clone())),
                _ => None,
            };
            match one {
                Some(single) if repeated => format_value(def, Some(&single)),
                _ => clip(&items.join(", ")),
            }
        }
    }
}

fn reason_for(
    def: Option<&SettingDef>,
    key: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    next: &PrintConfig,
    easy: Option<&EasySettings>,
) -> String {
    let label = def.map_or(key, |d| d.label.as_str());
    if let (Some(e), Some(control)) = (easy, easy_control_for(key)) {
        let name = easy_control_label(control).unwrap_or(control);
        return format!(
            "{label} follows the {name} control ({}).",
            easy_control_value(e, control)
        );
    }
    let mut parts: Vec<String> = Vec::new();
    match (before, after) {
        (None, Some(_)) => parts.push(format!("{label} is now set to {}.", format_value(def, after))),
        (Some(_), None) => {
            let dv = def.and_then(|d| Value::from_json(&d.default));
            parts.push(format!(
                "{label} is no longer set; the default {} applies.",
                def.map_or("value".to_owned(), |d| format_value(Some(d), dv.as_ref()))
            ));
        }
        (Some(b), Some(a)) => {
            let (bn, an) = (b.first_f64(), a.first_f64());
            if let (Some(effect), Some(an), Some(bn)) = (def.and_then(|d| d.effect.as_ref()), an, bn)
                && (an - bn).abs() > f64::EPSILON
                && let Some(t) = if an > bn {
                    &effect.increase
                } else {
                    &effect.decrease
                }
            {
                parts.push(format!(
                    "{label} goes from {} to {}. {t}.",
                    format_value(def, before),
                    format_value(def, after)
                ));
            }
            if parts.is_empty() {
                parts.push(format!(
                    "{label} changes from {} to {}.",
                    format_value(def, before),
                    format_value(def, after)
                ));
            }
        }
        (None, None) => {}
    }
    if let (Some(d), Some(_)) = (def, after)
        && let Some(failed) = failed_conditions(d, next).first()
    {
        let dep = setting_def(&failed.key);
        let dep_default = dep.and_then(|x| Value::from_json(&x.default));
        let cur = next.get(&failed.key).or(dep_default.as_ref());
        parts.push(format!(
            "It has no effect while {} is {}.",
            dep.map_or(failed.key.as_str(), |x| x.label.as_str()),
            format_value(dep, cur)
        ));
    }
    parts.join(" ")
}

/// Values equal, treating whole numbers of different integer or float type as the same.
#[must_use]
pub fn same_value(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => x.to_json() == y.to_json(),
        _ => false,
    }
}

/// Every key whose value differs between `before` and `after`, earliest slice stage first.
/// Pass the Easy controls to have Easy driven keys explained by their control.
#[must_use]
pub fn diff_configs(
    before: &PrintConfig,
    after: &PrintConfig,
    easy: Option<&EasySettings>,
) -> Vec<ConfigDiffEntry> {
    let keys: BTreeSet<&String> = before
        .iter()
        .map(|(k, _)| k)
        .chain(after.iter().map(|(k, _)| k))
        .collect();
    let mut out = Vec::new();
    for key in keys {
        let (b, a) = (before.get(key), after.get(key));
        if same_value(b, a) {
            continue;
        }
        let def = setting_def(key);
        out.push(ConfigDiffEntry {
            key: key.clone(),
            label: def.map_or_else(|| key.clone(), |d| d.label.clone()),
            group: def.map_or_else(|| "other".to_owned(), |d| d.group.clone()),
            unit: def.and_then(|d| d.unit.clone()),
            before: b.cloned(),
            after: a.cloned(),
            kind: match (b, a) {
                (None, _) => ChangeKind::Added,
                (_, None) => ChangeKind::Removed,
                _ => ChangeKind::Changed,
            },
            stage: def.map_or(SliceStage::Layers, |d| d.invalidates),
            reason: reason_for(def, key, b, a, after, easy),
        });
    }
    out.sort_by(|x, y| {
        x.stage
            .cmp(&y.stage)
            .then_with(|| x.group.cmp(&y.group))
            .then_with(|| x.key.cmp(&y.key))
    });
    out
}

/// The earliest slice stage any of the changes invalidates, or `None` when nothing changed.
#[must_use]
pub fn first_stage(changes: &[ConfigDiffEntry]) -> Option<SliceStage> {
    changes.iter().map(|c| c.stage).min()
}
