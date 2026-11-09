// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A Klipper tool changer's docks, from `configfile.settings`: one per `[tool <name>]` section, with
//! its `params_park_x`, `params_park_y`, `params_park_z`, `params_safe_y` and dock path
//! (`params_sc_path` on StealthChanger, `params_path` otherwise), each falling back to the
//! `[toolchanger]` section's value. Klipper lowercases section and option names there. The tool
//! number is the section's `tool_number`, else the digits at the end of its name. A value that does
//! not read as a number is left out, and the app estimates it.
use serde_json::{Map, Value};

use crate::types::{DockStep, ToolDock};

/// At most this many tools: past it a config is not a tool changer we can draw.
const MAX_TOOLS: u8 = 16;

pub(super) fn tool_docks(settings: &Map<String, Value>) -> Vec<ToolDock> {
    let defaults = settings.get("toolchanger").and_then(Value::as_object);
    let mut out: Vec<ToolDock> = Vec::new();
    for (name, sec) in settings {
        let Some(rest) = name.strip_prefix("tool ") else {
            continue;
        };
        let Some(sec) = sec.as_object() else {
            continue;
        };
        let Some(tool) = tool_number(sec, rest) else {
            continue;
        };
        if tool >= MAX_TOOLS || out.iter().any(|d| d.tool == tool) {
            continue;
        }
        let get = |k: &str| sec.get(k).or_else(|| defaults.and_then(|d| d.get(k)));
        let park = match (
            number(get("params_park_x")),
            number(get("params_park_y")),
            number(get("params_park_z")),
        ) {
            (Some(x), Some(y), Some(z)) => Some([x, y, z]),
            _ => None,
        };
        let path = get("params_sc_path")
            .or_else(|| get("params_path"))
            .map(dock_path)
            .unwrap_or_default();
        out.push(ToolDock {
            tool,
            park_mm: park,
            safe_y_mm: number(get("params_safe_y")),
            path,
        });
    }
    out.sort_by_key(|d| d.tool);
    out
}

fn tool_number(sec: &Map<String, Value>, name: &str) -> Option<u8> {
    if let Some(v) = sec.get("tool_number") {
        let n = match v {
            Value::Number(n) => n.as_u64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        };
        return n.and_then(|n| u8::try_from(n).ok());
    }
    let digits: String = name
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse().ok()
}

/// A finite number from a parsed value or from text, which may be quoted (`'-71.0'`).
fn number(v: Option<&Value>) -> Option<f64> {
    let n = match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_matches(['\'', '"']).trim().parse().ok(),
        _ => None,
    }?;
    n.is_finite().then_some(n)
}

/// The steps of a dock path: a list of `{'y': .., 'z': .., 'f': ..}` as Klipper keeps the text, or
/// already parsed. A step without a number for `y` or `z` drops the whole path, so a half-read path
/// never plays.
fn dock_path(v: &Value) -> Vec<DockStep> {
    let steps: Option<Vec<DockStep>> = match v {
        Value::Array(a) => a.iter().map(step_of_value).collect(),
        Value::String(s) => step_texts(s).map(|t| step_of_text(&t)).collect(),
        _ => None,
    };
    steps.filter(|s| s.len() >= 2).unwrap_or_default()
}

fn step_of_value(v: &Value) -> Option<DockStep> {
    let o = v.as_object()?;
    Some(DockStep {
        y: number(o.get("y"))?,
        z: number(o.get("z"))?,
        f: number(o.get("f")).filter(|f| *f > 0.0),
    })
}

/// The text inside each `{...}` of a path.
fn step_texts(s: &str) -> impl Iterator<Item = String> + '_ {
    s.split('{')
        .skip(1)
        .map(|chunk| chunk.split('}').next().unwrap_or("").to_owned())
}

fn step_of_text(text: &str) -> Option<DockStep> {
    let mut dy = None;
    let mut dz = None;
    let mut scale = None;
    for pair in text.split(',') {
        let Some((k, v)) = pair.split_once(':') else {
            continue;
        };
        let k = k.trim().trim_matches(['\'', '"']);
        let v = number(Some(&Value::String(v.to_owned())));
        match k {
            "y" => dy = Some(v?),
            "z" => dz = Some(v?),
            "f" => scale = v.filter(|f| *f > 0.0),
            _ => {}
        }
    }
    Some(DockStep {
        y: dy?,
        z: dz?,
        f: scale,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::moonraker::moonraker_hardware;
    use serde_json::json;

    /// A `printer/objects/query` reply for a StealthChanger build: the project's example values
    /// for T0 (`Toolhead_T0.cfg`), a second tool at its own X, the path as Klipper keeps the text.
    fn reply(settings: &Value) -> Value {
        json!({ "result": { "status": { "configfile": { "settings": settings } } } })
    }
    const PATH: &str = "[{'y':9.5 ,'z':4}, {'y':9.5, 'z':2}, {'y':5.5, 'z':0}, {'z':0, 'y':0, 'f':0.5}, {'z':-10, 'y':0}, {'z':-10, 'y':16}]";

    #[test]
    fn a_stealthchanger_config_gives_each_tool_its_park_point_and_path() {
        let q = reply(&json!({
            "extruder": { "nozzle_diameter": 0.4 },
            "extruder1": { "nozzle_diameter": 0.4 },
            "toolchanger": { "params_safe_y": "20.0", "params_sc_path": PATH },
            "tool t0": { "tool_number": 0, "params_park_x": "28", "params_park_y": "-71.0", "params_park_z": "381.0" },
            "tool t1": { "params_park_x": 104.0, "params_park_y": -71.0, "params_park_z": 381.0, "params_safe_y": "25" },
        }));
        let hw = moonraker_hardware(Some(&q), None);
        assert_eq!(hw.extruders.len(), 2);
        let d = &hw.tool_docks;
        assert_eq!(d.len(), 2);
        assert_eq!(
            (d[0].tool, d[0].park_mm, d[0].safe_y_mm),
            (0, Some([28.0, -71.0, 381.0]), Some(20.0))
        );
        // A tool's own value wins over the [toolchanger] default.
        assert_eq!(
            (d[1].tool, d[1].park_mm, d[1].safe_y_mm),
            (1, Some([104.0, -71.0, 381.0]), Some(25.0))
        );
        let p = &d[0].path;
        assert_eq!(p.len(), 6);
        assert_eq!(
            p[0],
            DockStep {
                y: 9.5,
                z: 4.0,
                f: None
            }
        );
        assert_eq!(
            p[3],
            DockStep {
                y: 0.0,
                z: 0.0,
                f: Some(0.5)
            }
        );
        assert_eq!(
            p[5],
            DockStep {
                y: 16.0,
                z: -10.0,
                f: None
            }
        );
        assert_eq!(d[1].path, d[0].path);
        // Serialized as the app reads it.
        let v = serde_json::to_value(&hw).unwrap();
        assert_eq!(v["toolDocks"][0]["parkMm"], json!([28.0, -71.0, 381.0]));
        assert_eq!(v["toolDocks"][0]["safeYMm"], json!(20.0));
        assert_eq!(
            v["toolDocks"][0]["path"][3],
            json!({ "y": 0.0, "z": 0.0, "f": 0.5 })
        );
    }

    #[test]
    fn a_printer_without_tool_sections_has_no_docks() {
        let q =
            reply(&json!({ "extruder": { "nozzle_diameter": 0.4 }, "printer": { "kinematics": "corexy" } }));
        let hw = moonraker_hardware(Some(&q), None);
        assert!(hw.tool_docks.is_empty());
        assert!(serde_json::to_value(&hw).unwrap().get("toolDocks").is_none());
        // A [toolchanger] section with no tools is no dock either.
        let q = reply(&json!({ "toolchanger": { "params_safe_y": 20 } }));
        assert!(moonraker_hardware(Some(&q), None).tool_docks.is_empty());
    }

    #[test]
    fn malformed_values_are_left_out_for_the_app_to_estimate() {
        let q = reply(&json!({
            "tool t0": { "params_park_x": "abc", "params_park_y": "-71", "params_park_z": "381", "params_safe_y": "nan", "params_sc_path": "[{'y':9.5,'z':4}, {'y':'x','z':2}]" },
            "tool t1": { "params_park_x": "28", "params_park_y": "-71", "params_park_z": "381", "params_sc_path": "[{'y':1,'z':2}]" },
            "tool extra": { "params_park_x": "1" },
            "tool t99": { "params_park_x": "1" },
            "tool t2": "not a section",
        }));
        let d = moonraker_hardware(Some(&q), None).tool_docks;
        assert_eq!(d.iter().map(|d| d.tool).collect::<Vec<_>>(), vec![0, 1]);
        // T0: one bad park value drops the park point; a bad safe Y and a bad path step drop those.
        assert_eq!((d[0].park_mm, d[0].safe_y_mm, d[0].path.len()), (None, None, 0));
        // T1: the park point reads; a one-step path is not a path.
        assert_eq!((d[1].park_mm, d[1].path.len()), (Some([28.0, -71.0, 381.0]), 0));
    }

    #[test]
    fn a_path_already_parsed_into_a_list_reads_too() {
        let q = reply(&json!({
            "tool t0": { "params_park_x": 28, "params_park_y": -71, "params_park_z": 381, "params_path": [{ "y": 9.5, "z": 4 }, { "y": 0, "z": 0, "f": 0.5 }] },
        }));
        let d = moonraker_hardware(Some(&q), None).tool_docks;
        assert_eq!(
            d[0].path,
            vec![
                DockStep {
                    y: 9.5,
                    z: 4.0,
                    f: None
                },
                DockStep {
                    y: 0.0,
                    z: 0.0,
                    f: Some(0.5)
                }
            ]
        );
    }
}
