// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The settings `PrusaSlicer` writes in a project, in Orca's keys: the project's own (`Metadata/Slic3r_PE.config`,
//! [`project_settings`]) and each object's and volume's (`Metadata/Slic3r_PE_model.config`, [`overrides`]). Renamed
//! through the settings package's map (`packages/settings/prusa-map.json`, copied to `data/` for the published crate),
//! percentages of another speed or height made absolute, and the settings it splits differently (supports, first layer
//! speed, ironing, and the table's `composites`). The same steps as `mapPrusaValues` and `prusaProjectConfig` in
//! `packages/settings/js/prusa.ts`; `packages/settings/fixtures/prusa-project-settings.json` holds the cases both run.

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
    /// Width keys a project gives as a percent of a height (`widthPercentOf`), by the key the percent is of.
    width_percent_of: HashMap<String, String>,
    ignored_prefixes: Vec<String>,
    ignored_keys: Vec<String>,
    /// Keys that carry over only through a `values` row; any other value is left out.
    only_mapped_values: Vec<String>,
    /// Keys whose value 0 means not set, read as absent.
    zero_is_unset: Vec<String>,
    /// Keys that carry over in mm only; a percent is left out.
    no_percent: Vec<String>,
    /// One key's value set on each of several keys.
    fan_out: Vec<(String, Vec<String>)>,
    /// Keys whose value picks another key's value.
    value_to_key: Vec<ValueToKey>,
    /// What a project's settings may set.
    takes: Takes,
    /// Keys that describe a profile file, not settings (`meta` in legacy.json).
    meta: Vec<String>,
    /// Older names of our settings (`rename` in legacy.json).
    legacy: HashMap<String, String>,
}

/// A key whose value picks another key's (`valueToKey` in prusa-map.json): the target value for each listed value, and
/// `otherwise` for any other.
struct ValueToKey {
    key: String,
    to: String,
    values: Vec<(String, String)>,
    otherwise: String,
}

/// `projectTakes` in prusa-map.json: what a project file's settings may set.
#[derive(Default)]
struct Takes {
    sections: Vec<String>,
    types: Vec<String>,
    /// Text settings with a grammar: the characters each may hold, as a regular expression class.
    text: Vec<(String, String)>,
    text_section: String,
    text_max_length: usize,
    unread: Vec<String>,
    unset_values: Vec<String>,
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
        let list = |k: &str| -> Vec<String> {
            v.get(k)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default()
        };
        // `^(a|b|c)`: a list of plain prefixes
        let pattern = v.get("ignoredPattern").and_then(Value::as_str).unwrap_or("");
        let composites = v.get("composites").cloned().unwrap_or_default();
        let takes = v.get("projectTakes").cloned().unwrap_or_default();
        let list_of = |v: &Value, k: &str| -> Vec<String> {
            v.get(k)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default()
        };
        let legacy: Value =
            serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/legacy.json"))).unwrap_or_default();
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
            width_percent_of: strings("widthPercentOf"),
            ignored_prefixes: pattern
                .trim_start_matches("^(")
                .trim_end_matches(')')
                .split('|')
                .filter(|p| !p.is_empty())
                .map(str::to_owned)
                .collect(),
            ignored_keys: list("ignoredKeys"),
            only_mapped_values: list("onlyMappedValues"),
            zero_is_unset: list("zeroIsUnset"),
            no_percent: list("noPercent"),
            fan_out: composites
                .get("fanOut")
                .and_then(Value::as_object)
                .map(|o| {
                    o.iter()
                        .map(|(k, to)| {
                            let to = to
                                .as_array()
                                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                                .unwrap_or_default();
                            (k.clone(), to)
                        })
                        .collect()
                })
                .unwrap_or_default(),
            value_to_key: composites
                .get("valueToKey")
                .and_then(Value::as_object)
                .map(|o| {
                    o.iter()
                        .map(|(k, row)| {
                            let values = row
                                .get("values")
                                .and_then(Value::as_object)
                                .map(|m| {
                                    m.iter()
                                        .filter_map(|(a, b)| b.as_str().map(|b| (a.clone(), b.to_owned())))
                                        .collect()
                                })
                                .unwrap_or_default();
                            ValueToKey {
                                key: k.clone(),
                                to: text(row, "to"),
                                values,
                                otherwise: text(row, "else"),
                            }
                        })
                        .collect()
                })
                .unwrap_or_default(),
            takes: Takes {
                sections: list_of(&takes, "sections"),
                types: list_of(&takes, "types"),
                text: takes
                    .get("text")
                    .and_then(Value::as_object)
                    .map(|o| {
                        o.iter()
                            .filter_map(|(k, c)| c.as_str().map(|c| (k.clone(), c.to_owned())))
                            .collect()
                    })
                    .unwrap_or_default(),
                text_section: text(&takes, "textSection"),
                text_max_length: takes
                    .get("textMaxLength")
                    .and_then(Value::as_u64)
                    .and_then(|n| usize::try_from(n).ok())
                    .unwrap_or(0),
                unread: list_of(&takes, "unread"),
                unset_values: list_of(&takes, "unsetValues"),
            },
            meta: list_of(&legacy, "meta"),
            legacy: legacy
                .get("rename")
                .and_then(Value::as_object)
                .map(|o| {
                    o.iter()
                        .filter_map(|(a, b)| b.as_str().map(|b| (a.clone(), b.to_owned())))
                        .collect()
                })
                .unwrap_or_default(),
        }
    })
}

/// Each setting's section and type (`packages/settings/schema.json`, through build.rs), by key.
fn setting(key: &str) -> Option<(&'static str, &'static str)> {
    static TYPES: OnceLock<HashMap<&'static str, (&'static str, &'static str)>> = OnceLock::new();
    TYPES
        .once(|| {
            include_str!(concat!(env!("OUT_DIR"), "/setting_types.txt"))
                .lines()
                .filter_map(|l| {
                    let mut it = l.split('\t');
                    Some((it.next()?, (it.next()?, it.next()?)))
                })
                .collect()
        })
        .get(key)
        .copied()
}

/// A plain decimal number as `PrusaSlicer` writes one (`12`, `-0.5`, `.5`, `5.`), white space around it allowed.
fn number(v: &str) -> Option<f64> {
    let t = v.trim();
    let digits = t.strip_prefix(['-', '+']).unwrap_or(t);
    let (whole, frac) = digits.split_once('.').unwrap_or((digits, ""));
    let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !all_digits(whole) || !all_digits(frac) || (whole.is_empty() && frac.is_empty()) {
        return None;
    }
    t.parse::<f64>().ok().filter(|n| n.is_finite())
}

fn percent(v: &str) -> Option<f64> {
    number(v.trim().strip_suffix('%')?)
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

/// The mm a width percent in a project's own settings stands for (`widthPercentOf`): a percent of the first layer
/// height for the first layer width, of the layer height for the other widths, and of the outer wall's width for the
/// support's XY gap. Heights are the project's own, as the project sets them, else the defaults.
fn width_mm(key: &str, p: f64, raw: &HashMap<&str, &str>) -> Option<f64> {
    let base = match map().width_percent_of.get(key)?.as_str() {
        "external_perimeter_width" => outer_width(raw)?,
        height => absolute(height, raw, 0)?,
    };
    // Kept to a nanometer, so float noise does not show: 150% of 0.15 is 0.225.
    Some((base * p / 100.0 * 1e9).round() / 1e9)
}

/// The outer wall's width at the layer height in a project's own settings: its own width when set (a percent of the
/// layer height), else the general width, else 1.125 times the project's own nozzle diameter (0.4 when it has none).
fn outer_width(raw: &HashMap<&str, &str>) -> Option<f64> {
    let lh = absolute("layer_height", raw, 0)?;
    for key in ["external_perimeter_extrusion_width", "extrusion_width"] {
        let Some(v) = raw.get(key) else { continue };
        let w = percent(v).map_or_else(|| number(v), |p| Some(p / 100.0 * lh));
        if let Some(w) = w.filter(|w| *w != 0.0) {
            return Some(w);
        }
    }
    let nozzle = match raw.get("nozzle_diameter") {
        Some(v) => number(v.split(',').next().unwrap_or(v))?,
        None => *map().percent_base_defaults.get("nozzle_diameter")?,
    };
    Some(1.125 * nozzle)
}

/// A project's own settings with each width percent of `widthPercentOf` in mm, all read from the settings as given.
fn project_widths(list: &[(String, String)]) -> Vec<(String, String)> {
    let raw: HashMap<&str, &str> = list.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let mm: Vec<Option<String>> = list
        .iter()
        .map(|(k, v)| percent(v).and_then(|p| width_mm(k, p, &raw)).map(plain))
        .collect();
    list.iter()
        .zip(mm)
        .map(|((k, v), mm)| (k.clone(), mm.unwrap_or_else(|| v.clone())))
        .collect()
}

/// A number as Orca writes it: no trailing zeros.
fn plain(n: f64) -> String {
    let s = format!("{n}");
    s.strip_suffix(".0").map_or(s.clone(), str::to_owned)
}

/// One object's or volume's `PrusaSlicer` settings as Orca keys and values (strings, as a project carries them).
/// Keys with no Orca name keep their own, so the caller can say they are not applied.
pub(crate) fn overrides(list: &[(String, String)]) -> Map<String, Value> {
    map_values(list, false).0
}

/// One object's `PrusaSlicer` settings as [`overrides`] gives them, plus each width percent that the object's own layer
/// height decides, in mm: one the object sets, and the project's own when the object has its own `layer_height`. Both
/// are of the object's layer height (the project's when it sets none), and the support XY spacing of the object's outer
/// wall width. The first layer width stays the project's. `project` is the text of `Metadata/Slic3r_PE.config`.
pub(crate) fn object_overrides(list: &[(String, String)], project: Option<&str>) -> Map<String, Value> {
    let mut out = overrides(list);
    let m = map();
    let global = project.map(config_lines).unwrap_or_default();
    let own: HashMap<&str, &str> = list.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let mut raw: HashMap<&str, &str> = global.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    raw.extend(own.iter().map(|(k, v)| (*k, *v)));
    let own_height = own.contains_key("layer_height");
    let mut keys: Vec<&String> = m.width_percent_of.keys().collect();
    keys.sort();
    for key in keys {
        if key == "first_layer_extrusion_width" || !(own_height || own.contains_key(key.as_str())) {
            continue;
        }
        let Some(mm) = raw
            .get(key.as_str())
            .and_then(|v| percent(v))
            .and_then(|p| width_mm(key, p, &raw))
        else {
            continue;
        };
        let target = m.rename.get(key).map_or(key.as_str(), String::as_str);
        out.insert(target.to_owned(), Value::String(plain(mm)));
    }
    out
}

/// A project's own `PrusaSlicer` settings (the text of `Metadata/Slic3r_PE.config`) as what a project may set
/// (`projectTakes` in prusa-map.json), in the Orca-format values `project_settings.config` has: the print and filament
/// values, with the printer's own settings, G-code and other text left to the current printer. Also the keys that have
/// no setting of ours, sorted. The same as `prusaProjectConfig` in the settings package, which the app and the MCP
/// server use.
pub(crate) fn project_settings(text: &str) -> (Map<String, Value>, Vec<String>) {
    let (mapped, unmapped) = map_values(&project_widths(&config_lines(text)), true);
    let settings = mapped.into_iter().filter(|(k, v)| takes(k, v)).collect();
    (settings, unmapped)
}

/// The `key = value` lines of a `PrusaSlicer` config, each written after `; ` in a project, in the file's order; a key
/// given twice keeps its first place and its last value.
fn config_lines(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for line in text.lines() {
        let body = line.strip_prefix("; ").unwrap_or(line).trim();
        if body.is_empty() || body.starts_with(['#', ';', '[']) {
            continue;
        }
        let Some((key, value)) = body.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let value = value.trim().to_owned();
        if let Some(slot) = at.get(key).and_then(|&i| out.get_mut(i)) {
            slot.1 = value;
        } else {
            at.insert(key.to_owned(), out.len());
            out.push((key.to_owned(), value));
        }
    }
    out
}

/// Whether a project's settings may set `key` to `value` (`projectTakes`, `takesProjectValue` in the settings package):
/// a plain number, percent, switch or choice of the print or filament settings, or a text setting with a grammar the
/// value fits; nothing the project leaves unread and no value that means unset.
fn takes(key: &str, value: &Value) -> bool {
    let t = &map().takes;
    let text = value.as_str();
    if t.unread.iter().any(|k| k == key) || text.is_some_and(|v| t.unset_values.iter().any(|u| u == v)) {
        return false;
    }
    let Some((section, kind)) = setting(key) else {
        return false;
    };
    if !t.sections.iter().any(|s| s == section) {
        return false;
    }
    if t.types.iter().any(|k| k == kind) {
        return true;
    }
    let Some((_, class)) = t.text.iter().find(|(k, _)| k == key) else {
        return false;
    };
    kind == "string"
        && section == t.text_section
        && text.is_some_and(|v| {
            !v.contains(['\r', '\n'])
                && v.chars().count() <= t.text_max_length
                && v.chars().all(|c| in_class(class, c))
        })
}

/// Whether `c` is one of a regular expression character class's characters (its body, without the brackets): single
/// characters, `a-z` ranges, `\s` for white space, and `\` before a character that stands for itself.
fn in_class(class: &str, c: char) -> bool {
    // One character of the class, an escape read: `None` for `\s`.
    fn one(rest: &mut std::str::Chars<'_>, ch: char) -> Option<char> {
        if ch != '\\' {
            return Some(ch);
        }
        match rest.next() {
            Some('s') => None,
            Some(e) => Some(e),
            None => Some(ch),
        }
    }
    let mut it = class.chars();
    while let Some(ch) = it.next() {
        let Some(lo) = one(&mut it, ch) else {
            if c.is_whitespace() {
                return true;
            }
            continue;
        };
        let mut ahead = it.clone();
        if ahead.next() == Some('-')
            && let Some(h) = ahead.next()
        {
            it = ahead;
            let hi = one(&mut it, h).unwrap_or(lo);
            if (lo..=hi).contains(&c) {
                return true;
            }
        } else if lo == c {
            return true;
        }
    }
    false
}

/// `PrusaSlicer`'s escaping for a string value: `\n`, `\r` and `\\`; any other escaped character stands for itself.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        let escaped = if c == '\\' { it.next() } else { None };
        out.push(match escaped {
            Some('n') => '\n',
            Some('r') => '\r',
            Some(e) => e,
            None => c,
        });
    }
    out
}

/// A list of strings: items separated by `;`, each optionally in double quotes (which may hold `;`).
fn split_strings(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut it = s.chars();
    while let Some(c) = it.next() {
        match c {
            '"' => quoted = !quoted,
            '\\' => {
                cur.push(c);
                if let Some(e) = it.next() {
                    cur.push(e);
                }
            }
            ';' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out.iter().map(|s| unescape(s)).collect()
}

/// `PrusaSlicer` settings as Orca keys and values: the composites, renames, percentages and value rows of prusa-map.json.
/// For an object or a volume (`project` false) a key with no Orca name keeps its own and every value is a string. For a
/// project's own settings (`project` true) the table's `composites` apply too; a key is ours under its rename, its own
/// name or an older name (legacy.json), any other is returned as not mapped; profile meta keys are left out; and a list
/// or text setting takes its value's form (a list of strings, text unescaped), as `mapPrusaValues` does.
fn map_values(list: &[(String, String)], project: bool) -> (Map<String, Value>, Vec<String>) {
    let m = map();
    // A 0 that means "not set" is read as if the key were absent.
    let unset = |k: &str, v: &str| m.zero_is_unset.iter().any(|z| z == k) && number(v) == Some(0.0);
    let list: Vec<&(String, String)> = list.iter().filter(|(k, v)| !unset(k, v)).collect();
    let raw: HashMap<&str, &str> = list.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let mut out = Map::new();
    let mut unmapped = Vec::new();
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
    if project {
        for (key, to) in &m.fan_out {
            if let Some(v) = raw.get(key.as_str()) {
                for k in to {
                    put(&mut out, k, (*v).to_owned());
                }
                done.push(key);
            }
        }
        for row in &m.value_to_key {
            if let Some(v) = raw.get(row.key.as_str()) {
                let pick = row
                    .values
                    .iter()
                    .find(|(from, _)| from == v)
                    .map_or(&row.otherwise, |(_, t)| t);
                put(&mut out, &row.to, pick.clone());
                done.push(&row.key);
            }
        }
    }
    for (key, value) in list {
        let key = key.as_str();
        if done.contains(&key)
            || m.ignored_keys.iter().any(|k| k == key)
            || m.ignored_prefixes.iter().any(|p| key.starts_with(p.as_str()))
            || (project && m.meta.iter().any(|k| k == key))
        {
            continue;
        }
        let target = match m.rename.get(key) {
            Some(t) => t.as_str(),
            None if !project || setting(key).is_some() => key,
            None => {
                if let Some(t) = m.legacy.get(key) {
                    t.as_str()
                } else {
                    unmapped.push(key.to_owned());
                    continue;
                }
            }
        };
        let mut v = value.clone();
        if (m.percent_of.contains_key(key) || key == "first_layer_height")
            && percent(&v).is_some()
            && let Some(a) = absolute(key, &raw, 0)
        {
            v = plain(a);
        }
        // A percent of a key that carries over in mm only is left out.
        if m.no_percent.iter().any(|k| k == key) && percent(&v).is_some() {
            continue;
        }
        if let Some((_, _, to)) = m.values.iter().find(|(k, from, _)| k == key && *from == v) {
            v.clone_from(to);
        } else if m.only_mapped_values.iter().any(|k| k == key) {
            continue;
        }
        if !project {
            put(&mut out, target, v);
            continue;
        }
        let shaped = match setting(target).map(|(_, kind)| kind) {
            _ if v == "nil" => Value::String(v),
            Some("strings") => Value::Array(split_strings(&v).into_iter().map(Value::String).collect()),
            Some("gcode" | "string") => Value::String(unescape(&v)),
            _ => Value::String(v),
        };
        out.entry(target.to_owned()).or_insert(shaped);
    }
    unmapped.sort();
    (out, unmapped)
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

    #[test]
    fn no_shrinkage_and_an_unset_first_layer_infill_speed() {
        // 0% is no shrinkage, 100% in our settings; any other value is left out.
        let o = of(&[
            ("filament_shrinkage_compensation_xy", "0%"),
            ("filament_shrinkage_compensation_z", "0.5%"),
            ("first_layer_infill_speed", "0"),
            ("first_layer_speed", "50%"),
            ("infill_speed", "200"),
        ]);
        assert_eq!(o["filament_shrink"], "100%");
        assert!(!o.contains_key("filament_shrinkage_compensation_z"));
        assert!(!o.contains_key("filament_shrinkage_compensation_xy"));
        assert_eq!(o["initial_layer_infill_speed"], "100");
        let o = of(&[("first_layer_infill_speed", "30"), ("first_layer_speed", "50%")]);
        assert_eq!(o["initial_layer_infill_speed"], "30");
    }
}
