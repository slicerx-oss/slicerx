// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Older and other slicers' names for the per-feature filament settings, read under our own names.
//!
//! Bambu Studio writes `sparse_infill_filament`, `wall_filament` and `solid_infill_filament`; `OrcaSlicer`'s older
//! profiles and `PrusaSlicer` use `infill_extruder`, `perimeter_extruder` and the like. The settings package lists
//! them in `packages/settings/legacy.json` (`rename`, `rename_also` and `value_map`), which `build.rs` copies in. A
//! config or object settings object that sets one of them gets our name set to the same filament, unless the same
//! object sets our name too: ours wins. The engine's defaults always hold our names, so reading the older name only
//! when ours is missing never saw it.
//!
//! A plate's own settings (a project's `project_settings.config`, a request's config) are the exception for Bambu
//! Studio's three names: Studio prints a project's values for them on nothing, so the plate's are left unread
//! ([`plate_value`]). An object's, a part's, a modifier's or a height range's still count.
//!
//! Only the filament keys are renamed here. The other renames of that file are read by the importers.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::par::Init as _;

/// The per-feature filament settings, by our names.
const FILAMENT_KEYS: [&str; 9] = [
    "outer_wall_filament_id",
    "inner_wall_filament_id",
    "sparse_infill_filament_id",
    "internal_solid_filament_id",
    "top_surface_filament_id",
    "bottom_surface_filament_id",
    "support_filament",
    "support_interface_filament",
    "wipe_tower_filament",
];

struct Rules {
    /// Older name to our names (most have one; `wall_filament` is both walls).
    targets: HashMap<String, Vec<String>>,
    /// Older name to its value rewrites (`"1"` to `"0"` where 1 meant the part's own filament).
    values: HashMap<String, Vec<(String, String)>>,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.once(|| {
        let file: Value =
            serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/legacy.json"))).unwrap_or_default();
        let mut targets: HashMap<String, Vec<String>> = HashMap::new();
        if let Some(rename) = file.get("rename").and_then(Value::as_object) {
            for (from, to) in rename {
                if let Some(to) = to.as_str().filter(|t| FILAMENT_KEYS.contains(t)) {
                    targets.entry(from.clone()).or_default().push(to.to_owned());
                }
            }
        }
        if let Some(also) = file.get("rename_also").and_then(Value::as_object) {
            for (from, to) in also {
                for t in to.as_array().into_iter().flatten().filter_map(Value::as_str) {
                    if FILAMENT_KEYS.contains(&t) && targets.contains_key(from) {
                        targets.entry(from.clone()).or_default().push(t.to_owned());
                    }
                }
            }
        }
        let mut values: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for r in file
            .get("value_map")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(key), Some(from), Some(to)) = (
                r.get("key").and_then(Value::as_str),
                r.get("from").and_then(Value::as_str),
                r.get("to").and_then(Value::as_str),
            ) else {
                continue;
            };
            if targets.contains_key(key) {
                values
                    .entry(key.to_owned())
                    .or_default()
                    .push((from.to_owned(), to.to_owned()));
            }
        }
        Rules { targets, values }
    })
}

/// Our names for an older filament key, empty for any other key.
pub(crate) fn targets(key: &str) -> &'static [String] {
    rules().targets.get(key).map_or(&[], Vec::as_slice)
}

/// The value an older key's value means under our name: its value rewrite applied (to a number or a string, or the
/// first entry of a list), and a number or numeric string read as the number.
fn renamed_value(key: &str, v: &Value) -> Value {
    let one = match v {
        Value::Array(a) => a.first().cloned().unwrap_or(Value::Null),
        other => other.clone(),
    };
    let text = match &one {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        _ => return one,
    };
    let text = rules()
        .values
        .get(key)
        .and_then(|m| m.iter().find(|(from, _)| *from == text))
        .map_or(text, |(_, to)| to.clone());
    text.parse::<u64>().map_or(one, Value::from)
}

/// Bambu Studio's per-feature filament names that a plate's own settings leave unread: a project's
/// `wall_filament`, `sparse_infill_filament` and `solid_infill_filament` print like no value at all in Studio, whatever
/// the value ("1", the stock one, included), on painted and unpainted objects alike.
pub(crate) const PLATE_UNREAD: [&str; 3] =
    ["wall_filament", "sparse_infill_filament", "solid_infill_filament"];

/// A plate's own settings without the names it leaves unread ([`PLATE_UNREAD`]).
pub(crate) fn plate_value(v: &Value) -> std::borrow::Cow<'_, Value> {
    match v.as_object() {
        Some(m) if PLATE_UNREAD.iter().any(|k| m.contains_key(*k)) => {
            let mut m = m.clone();
            for k in PLATE_UNREAD {
                m.remove(k);
            }
            std::borrow::Cow::Owned(Value::Object(m))
        }
        _ => std::borrow::Cow::Borrowed(v),
    }
}

/// `map` with our names set from the older filament keys it holds, or `None` when it holds none to rename.
pub(crate) fn with_current_names(map: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut out: Option<Map<String, Value>> = None;
    // Sorted, so two older names for one setting resolve the same way every time (the first by name wins).
    let mut keys: Vec<&String> = map.keys().filter(|k| !targets(k).is_empty()).collect();
    keys.sort();
    for key in keys {
        for target in targets(key) {
            // set by the object itself, or by an older name earlier in the order
            if out.as_ref().unwrap_or(map).contains_key(target) {
                continue;
            }
            let value = renamed_value(key, &map[key.as_str()]);
            out.get_or_insert_with(|| map.clone())
                .insert(target.clone(), value);
        }
    }
    out
}

/// A settings value (an object, or `Null`) with our names set from the older filament keys it holds.
pub(crate) fn value_with_current_names(v: &Value) -> Option<Value> {
    v.as_object().and_then(with_current_names).map(Value::Object)
}

/// `plate` with our names set in every object's, part's and volume's own settings, or `None` when none of them holds
/// an older filament key.
pub(crate) fn plate_with_current_names(plate: &crate::plate::Plate) -> Option<crate::plate::Plate> {
    let needs = |v: &Value| {
        v.as_object()
            .is_some_and(|m| m.keys().any(|k| !targets(k).is_empty()))
    };
    let any = plate.objects.iter().any(|o| {
        needs(&o.settings)
            || o.part_settings.iter().any(|(_, s)| needs(s))
            || o.volumes.iter().any(|v| needs(&v.settings))
    });
    if !any {
        return None;
    }
    let fix = |v: &mut Value| {
        if let Some(n) = value_with_current_names(v) {
            *v = n;
        }
    };
    let mut plate = plate.clone();
    for o in &mut plate.objects {
        fix(&mut o.settings);
        for (_, s) in &mut o.part_settings {
            fix(s);
        }
        for v in &mut o.volumes {
            fix(&mut v.settings);
        }
    }
    Some(plate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn renamed(v: Value) -> Value {
        value_with_current_names(&v).unwrap_or(v)
    }

    #[test]
    fn bambu_studio_names_keep_their_numbers() {
        let r =
            renamed(json!({"sparse_infill_filament": "1", "solid_infill_filament": "2", "wall_filament": 3}));
        assert_eq!(r["sparse_infill_filament_id"], json!(1));
        assert_eq!(r["internal_solid_filament_id"], json!(2));
        assert_eq!(r["outer_wall_filament_id"], json!(3));
        assert_eq!(r["inner_wall_filament_id"], json!(3));
        // the older keys stay, for anything that reads them by that name
        assert_eq!(r["sparse_infill_filament"], json!("1"));
    }

    #[test]
    fn orca_and_prusaslicer_names_read_one_as_the_parts_own() {
        let r = renamed(
            json!({"infill_extruder": "1", "perimeter_extruder": 2, "support_material_extruder": ["3"]}),
        );
        assert_eq!(r["sparse_infill_filament_id"], json!(0));
        assert_eq!(r["outer_wall_filament_id"], json!(2));
        assert_eq!(r["support_filament"], json!(3));
    }

    #[test]
    fn a_plates_own_settings_leave_bambu_studios_names_unread() {
        let plate = json!({"wall_filament": "2", "sparse_infill_filament": "3", "solid_infill_filament": "1",
            "infill_extruder": "3"});
        let r = renamed(plate_value(&plate).into_owned());
        for k in [
            "wall_filament",
            "sparse_infill_filament",
            "solid_infill_filament",
            "outer_wall_filament_id",
            "inner_wall_filament_id",
            "internal_solid_filament_id",
        ] {
            assert!(r.get(k).is_none(), "{k}");
        }
        // The older names of other slicers still count at the plate level.
        assert_eq!(r["sparse_infill_filament_id"], json!(3));
        let none = json!({"layer_height": 0.2});
        assert!(matches!(plate_value(&none), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn our_name_wins_in_the_same_object() {
        let r = renamed(json!({"wall_filament": "2", "inner_wall_filament_id": 0}));
        assert_eq!(r["outer_wall_filament_id"], json!(2));
        assert_eq!(r["inner_wall_filament_id"], json!(0));
        assert!(value_with_current_names(&json!({"layer_height": 0.2})).is_none());
    }
}
