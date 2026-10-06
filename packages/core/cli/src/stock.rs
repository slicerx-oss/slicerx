// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A project's custom G-code that is the printer maker's stock text, unchanged, runs as trusted: the check
//! `isStockGcode` in packages/settings/js/gcode-review.ts makes against the same table. The printer is the one the
//! settings name (`printer_settings_id`, `inherits` or `printer_model`, as a Bambu or Orca project saves them); its
//! printer G-code must match a version Bambu Studio or `OrcaSlicer` shipped for it, and its filament G-code one of
//! its vendor's filament presets or Orca's filament library. Anything else, and every line no one can approve, is
//! linted as before. Unlike the app, `sx` does not know the text the `SlicerX` printer profiles ship (they are
//! AGPL data the engine stays clear of), so a request with that text sets `trustedGcode` after a person's yes.

use crate::fingerprint;
use serde_json::{Map, Value};

/// Written by build.rs.
const TABLE: &str = include_str!(concat!(env!("OUT_DIR"), "/stock-gcode.json"));
const FILAMENT_KEYS: [&str; 3] = [
    "filament_start_gcode",
    "filament_end_gcode",
    "filament_change_extrusion_role_gcode",
];

/// The table, read once per request.
fn table() -> Value {
    serde_json::from_str(TABLE).unwrap_or(Value::Null)
}

fn first_str(v: Option<&Value>) -> Option<&str> {
    match v? {
        Value::String(s) => Some(s),
        Value::Array(a) => a.first()?.as_str(),
        _ => None,
    }
}

/// The printer models the settings name, by profile (`Bambu Lab P1S 0.4 nozzle`) or model name (`Bambu Lab P1S`).
/// A name can cover several models, such as the sizes of a Voron.
pub fn models_of<'t>(t: &'t Value, config: &Map<String, Value>) -> Vec<&'t str> {
    let names = &t["names"];
    ["printer_settings_id", "inherits", "printer_model"]
        .iter()
        .filter_map(|k| first_str(config.get(*k)))
        .find_map(|n| {
            let n = n.trim();
            names[n]
                .as_array()
                .or_else(|| names[without_nozzle(n)].as_array())
        })
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// `Bambu Lab X1 Carbon 0.6 nozzle` without its nozzle: `Bambu Lab X1 Carbon`.
fn without_nozzle(profile: &str) -> &str {
    profile
        .strip_suffix(" nozzle")
        .and_then(|s| s.rsplit_once(' '))
        .filter(|(_, d)| d.parse::<f64>().is_ok())
        .map_or(profile, |(name, _)| name)
}

/// The fingerprint lists `key` is checked against for `model`.
fn lists<'a>(t: &'a Value, model: &str, key: &str) -> Vec<&'a Value> {
    if FILAMENT_KEYS.contains(&key) {
        t["vendorOf"][model]
            .as_str()
            .map(|v| &t["vendors"][v][key])
            .into_iter()
            .chain([&t["vendors"]["OrcaFilamentLibrary"][key]])
            .collect()
    } else {
        vec![&t["models"][model][key]]
    }
}

/// Whether every non-empty text of `key` (one, or one per filament) is a stock text for one of `models`.
fn is_stock(t: &Value, models: &[&str], key: &str, value: &Value) -> bool {
    let lists: Vec<&Value> = models.iter().flat_map(|m| lists(t, m, key)).collect();
    let known = |fp: &str| {
        lists.iter().any(|l| {
            l.as_array()
                .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(fp)))
        })
    };
    let texts: Vec<&str> = match value {
        Value::String(s) => vec![s],
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => return false,
    };
    let texts: Vec<&str> = texts
        .into_iter()
        .filter(|t| !fingerprint::normalize(t).is_empty())
        .collect();
    !texts.is_empty() && texts.iter().all(|t| known(&fingerprint::fingerprint(t)))
}

/// The custom G-code keys of `config` whose text is stock for the printer the settings name.
pub fn stock_keys(config: &Map<String, Value>) -> Vec<String> {
    let t = table();
    let models = models_of(&t, config);
    if models.is_empty() {
        return Vec::new();
    }
    config
        .iter()
        .filter(|(k, v)| k.ends_with("_gcode") && is_stock(&t, &models, k, v))
        .map(|(k, _)| k.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// normalizeGcode and gcodeFingerprint of the JS (packages/settings/js/gcode-review.ts) on the same inputs.
    const JS: [(&str, &str, &str); 6] = [
        ("", "", "e3b0c44298fc1c149afbf4c8996fb924"),
        ("G28", "G28", "f3bfcb90d1ca0282a1cb6d92840f62cf"),
        (
            "G28\r\nM104 S200  \r\n\r\n\tG1 X1\t \n",
            "G28\nM104 S200\n\tG1 X1",
            "3e43937951c5a1b09ab0214a13a44b9d",
        ),
        (
            "line one\rline two\n\n\n",
            "line one\nline two",
            "b6858b03a6cae635deeaeab09a74e598",
        ),
        (
            " \t \n  ; comment  \nM500 ; save cali data\t\n",
            "  ; comment\nM500 ; save cali data",
            "f3e2ff0f2fbfca52cbf2e1caca795e32",
        ),
        (
            "T\u{e9}st \u{2713}\nG1 X1 ; \u{b0}C\n",
            "T\u{e9}st \u{2713}\nG1 X1 ; \u{b0}C",
            "845aa7a292e4642d66d4c46f61cb47ab",
        ),
    ];

    #[test]
    fn normalizes_and_fingerprints_as_the_js_does() {
        for (text, norm, fp) in JS {
            assert_eq!(fingerprint::normalize(text), norm, "{text:?}");
            assert_eq!(fingerprint::fingerprint(text), fp, "{text:?}");
        }
    }

    /// The makers' text as `SlicerX` ships it for the printer (test data only: `sx` does not embed it).
    fn shipped(model: &str, field: &str) -> String {
        let doc: Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../profiles/gcode.json"))
                .unwrap(),
        )
        .unwrap();
        let family = doc["models"][model].as_str().unwrap();
        doc["families"][family][field].as_str().unwrap().to_owned()
    }

    fn config(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            other => panic!("not an object: {other}"),
        }
    }

    #[test]
    fn the_printer_is_found_by_profile_or_model_name() {
        assert_eq!(
            models_of(&table(), &config(json!({ "printer_model": "Bambu Lab P1S" }))),
            ["bambu-p1s"]
        );
        assert_eq!(
            models_of(
                &table(),
                &config(json!({ "printer_settings_id": "Bambu Lab X1 Carbon 0.4 nozzle" }))
            ),
            ["bambu-x1-carbon"]
        );
        assert_eq!(
            models_of(
                &table(),
                &config(json!({ "inherits": ["Bambu Lab P1S 0.6 nozzle"] }))
            ),
            ["bambu-p1s"]
        );
        assert_eq!(
            models_of(&table(), &config(json!({ "printer_model": "Voron 2.4" }))).len(),
            3
        );
        assert!(models_of(&table(), &config(json!({ "printer_model": "Someone's Printer" }))).is_empty());
        assert!(models_of(&table(), &config(json!({}))).is_empty());
    }

    #[test]
    fn stock_text_counts_for_its_printer_and_only_unchanged() {
        let p1s = shipped("bambu-p1s", "start");
        let keys = stock_keys(&config(json!({
            "printer_model": "Bambu Lab P1S",
            "machine_start_gcode": p1s.replace('\n', "\r\n"),
            "machine_end_gcode": "M500\n",
            "layer_height": 0.2,
        })));
        assert_eq!(keys, ["machine_start_gcode"]);
        assert!(
            stock_keys(&config(
                json!({ "printer_model": "Bambu Lab A1", "machine_start_gcode": p1s })
            ))
            .is_empty()
        );
        assert!(
            stock_keys(&config(
                json!({ "machine_start_gcode": shipped("bambu-p1s", "start") })
            ))
            .is_empty()
        );
        let edited = format!("{}\nM500\n", shipped("bambu-p1s", "start"));
        assert!(
            stock_keys(&config(
                json!({ "printer_model": "Bambu Lab P1S", "machine_start_gcode": edited })
            ))
            .is_empty()
        );
    }

    #[test]
    fn filament_gcode_counts_when_every_filament_is_stock() {
        let t = &table();
        let fp_of = |key: &str| t["vendors"]["BBL"][key].as_array().map_or(0, Vec::len);
        assert!(
            fp_of("filament_start_gcode") > 0,
            "the Bambu vendor has filament presets"
        );
        // Filament G-code a person wrote is not stock, and one such filament is enough.
        let keys = stock_keys(&config(json!({
            "printer_model": "Bambu Lab P1S",
            "filament_start_gcode": ["; my own\nM106 S255\n", "; my own\nM106 S255\n"],
        })));
        assert!(keys.is_empty());
    }
}
