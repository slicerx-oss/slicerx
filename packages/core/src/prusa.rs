// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The object and volume settings `PrusaSlicer` writes (`Metadata/Slic3r_PE_model.config`) in Orca's keys, the
//! ones a project's part settings carry: renamed through the settings package's map
//! (`packages/settings/prusa-map.json`, copied to `data/` for the published crate), percentages of another speed or
//! height made absolute, and the few settings it splits differently (supports, first layer speed, ironing). The same
//! steps as `mapPrusaValues` in `packages/settings/js/prusa.ts`, for the keys a part can carry.

use crate::par::Init;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

struct PrusaMap {
    rename: HashMap<String, String>,
    /// (key, Prusa value, Orca value)
    values: Vec<(String, String, String)>,
    percent_of: HashMap<String, String>,
    percent_base_defaults: HashMap<String, f64>,
    ignored_prefixes: Vec<String>,
    ignored_keys: Vec<String>,
}

fn map() -> &'static PrusaMap {
    static MAP: OnceLock<PrusaMap> = OnceLock::new();
    MAP.once(|| {
        let v: Value = serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/prusa-map.json")))
            .unwrap_or_default();
        let strings = |k: &str| -> HashMap<String, String> {
            v.get(k)
                .and_then(Value::as_object)
                .map(|o| {
                    o.iter()
                        .filter_map(|(a, b)| b.as_str().map(|b| (a.clone(), b.to_owned())))
                        .collect()
                })
                .unwrap_or_default()
        };
        let text = |e: &Value, k: &str| e.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        // `^(a|b|c)`: a list of plain prefixes
        let pattern = v.get("ignoredPattern").and_then(Value::as_str).unwrap_or("");
        PrusaMap {
            rename: strings("rename"),
            values: v
                .get("values")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|e| (text(e, "key"), text(e, "from"), text(e, "to")))
                        .collect()
                })
                .unwrap_or_default(),
            percent_of: strings("percentOf"),
            percent_base_defaults: v
                .get("percentBaseDefaults")
                .and_then(Value::as_object)
                .map(|o| {
                    o.iter()
                        .filter_map(|(a, b)| b.as_f64().map(|b| (a.clone(), b)))
                        .collect()
                })
                .unwrap_or_default(),
            ignored_prefixes: pattern
                .trim_start_matches("^(")
                .trim_end_matches(')')
                .split('|')
                .filter(|p| !p.is_empty())
                .map(str::to_owned)
                .collect(),
            ignored_keys: v
                .get("ignoredKeys")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default(),
        }
    })
}

fn percent(v: &str) -> Option<f64> {
    v.trim().strip_suffix('%')?.trim().parse().ok()
}

fn number(v: &str) -> Option<f64> {
    v.trim().parse::<f64>().ok().filter(|n| n.is_finite())
}

/// A value that may be a percent of another key, in that key's unit: the base from the same settings, else Prusa's default.
fn absolute(key: &str, raw: &HashMap<&str, &str>, depth: u32) -> Option<f64> {
    let m = map();
    let Some(v) = raw.get(key) else {
        return m.percent_base_defaults.get(key).copied();
    };
    let Some(p) = percent(v) else { return number(v) };
    let base = m.percent_of.get(key)?;
    if depth > 8 {
        return None;
    }
    let b = absolute(base, raw, depth + 1)?;
    Some((b * p).round() / 100.0)
}

/// A number as Orca writes it: no trailing zeros.
fn plain(n: f64) -> String {
    let s = format!("{n}");
    s.strip_suffix(".0").map_or(s.clone(), str::to_owned)
}

/// One object's or volume's `PrusaSlicer` settings as Orca keys and values (strings, as a project carries them).
/// Keys with no Orca name keep their own, so the caller can say they are not applied.
pub(crate) fn overrides(list: &[(String, String)]) -> Map<String, Value> {
    let m = map();
    let raw: HashMap<&str, &str> = list.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let mut out = Map::new();
    let put = |out: &mut Map<String, Value>, k: &str, v: String| {
        out.entry(k.to_owned()).or_insert(Value::String(v));
    };
    let mut done: Vec<&str> = Vec::new();
    if let Some(sm) = raw.get("support_material") {
        let enabled = matches!(*sm, "1" | "everywhere" | "enforcers_only");
        put(
            &mut out,
            "enable_support",
            if enabled { "1" } else { "0" }.to_owned(),
        );
        let auto = raw.get("support_material_auto") != Some(&"0") && *sm != "enforcers_only";
        let tree = raw.get("support_material_style") == Some(&"organic");
        let kind = format!(
            "{}({})",
            if tree { "tree" } else { "normal" },
            if auto { "auto" } else { "manual" }
        );
        put(&mut out, "support_type", kind);
        done.extend(["support_material", "support_material_auto"]);
    } else if raw.contains_key("support_material_auto") {
        done.push("support_material_auto");
    }
    if let Some(v) = raw.get("first_layer_speed") {
        let infill_own = raw.contains_key("first_layer_infill_speed");
        match percent(v) {
            None => {
                if let Some(n) = number(v) {
                    put(&mut out, "initial_layer_speed", plain(n));
                    if !infill_own {
                        put(&mut out, "initial_layer_infill_speed", plain(n));
                    }
                }
            }
            Some(p) => {
                if let Some(wall) = absolute("perimeter_speed", &raw, 0) {
                    put(&mut out, "initial_layer_speed", plain((wall * p).round() / 100.0));
                }
                if let Some(infill) = absolute("infill_speed", &raw, 0)
                    && !infill_own
                {
                    put(
                        &mut out,
                        "initial_layer_infill_speed",
                        plain((infill * p).round() / 100.0),
                    );
                }
            }
        }
        done.push("first_layer_speed");
    }
    if let Some(v) = raw.get("ironing") {
        if *v == "0" {
            put(&mut out, "ironing_type", "no ironing".to_owned());
            done.push("ironing_type");
        } else if !raw.contains_key("ironing_type") {
            put(&mut out, "ironing_type", "top".to_owned());
        }
        done.push("ironing");
    }
    for (key, value) in list {
        let key = key.as_str();
        if done.contains(&key)
            || m.ignored_keys.iter().any(|k| k == key)
            || m.ignored_prefixes.iter().any(|p| key.starts_with(p.as_str()))
        {
            continue;
        }
        let target = m.rename.get(key).map_or(key, String::as_str);
        let mut v = value.clone();
        if (m.percent_of.contains_key(key) || key == "first_layer_height")
            && percent(&v).is_some()
            && let Some(a) = absolute(key, &raw, 0)
        {
            v = plain(a);
        }
        if let Some((_, _, to)) = m.values.iter().find(|(k, from, _)| k == key && *from == v) {
            v.clone_from(to);
        }
        put(&mut out, target, v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::overrides;

    fn of(pairs: &[(&str, &str)]) -> serde_json::Map<String, serde_json::Value> {
        overrides(
            &pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn renames_converts_and_drops() {
        let o = of(&[
            ("fill_density", "40%"),
            ("perimeters", "4"),
            ("bottom_solid_layers", "5"),
            ("fill_pattern", "monotonous"),
            ("support_material", "1"),
            ("support_material_auto", "0"),
            ("solid_infill_speed", "50%"),
            ("infill_speed", "120"),
            ("sla_print_settings_id", "x"),
        ]);
        assert_eq!(o["bottom_shell_layers"], "5");
        assert_eq!(o["wall_loops"], "4");
        assert_eq!(o["sparse_infill_density"], "40%");
        assert_eq!(o["sparse_infill_pattern"], "monotonic");
        assert_eq!(o["enable_support"], "1");
        assert_eq!(o["support_type"], "normal(manual)");
        // 50 percent of the infill speed given beside it
        assert_eq!(o["internal_solid_infill_speed"], "60");
        assert!(!o.contains_key("sla_print_settings_id"));
        assert!(!o.contains_key("support_material"));
    }
}
