// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! With the `stock-gcode` feature, writes `$OUT_DIR/stock-gcode.json` for src/stock.rs from the settings package's
//! own data (Apache-2.0; the stock profiles in packages/profiles stay out of `sx`): the makers' stock G-code
//! fingerprints (profiles/stock-gcode.json), the printer names that identify a model (knowledge.json, with
//! printer-models.json from knowledge ids to the table's model ids), and each model's `OrcaSlicer` vendor, whose
//! filament presets the filament G-code is checked against.

use serde_json::{Map, Value, json};
use std::path::Path;

fn read(root: &Path, rel: &str) -> Value {
    let path = root.join(rel);
    println!("cargo::rerun-if-changed={}", path.display());
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The `OrcaSlicer` vendor a knowledge entry cites, from a source like `orca:BBL/machine/Bambu Lab A1 0.4 nozzle.json`.
fn orca_vendor(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => s
            .strip_prefix("orca:")
            .and_then(|s| s.split_once("/machine/"))
            .map(|(vendor, _)| vendor.to_owned()),
        Value::Array(a) => a.iter().find_map(orca_vendor),
        Value::Object(o) => o.values().find_map(orca_vendor),
        _ => None,
    }
}

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    if std::env::var_os("CARGO_FEATURE_STOCK_GCODE").is_none() {
        return;
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../settings");
    let stock = read(&root, "profiles/stock-gcode.json");
    let knowledge = read(&root, "knowledge.json");
    let models = read(&root, "printer-models.json");

    let mut names: Map<String, Value> = Map::new();
    let mut vendors: Map<String, Value> = Map::new();
    for (model, printer) in models["models"].as_object().into_iter().flatten() {
        let Some(printer) = printer.as_str() else { continue };
        let entry = &knowledge["printers"][printer];
        let Some(name) = entry["name"].as_str() else {
            continue;
        };
        let ids = names.entry(name.to_owned()).or_insert_with(|| json!([]));
        if let Some(a) = ids.as_array_mut() {
            a.push(Value::String(model.clone()));
        }
        if let Some(v) = orca_vendor(entry) {
            vendors.insert(model.clone(), Value::String(v));
        }
    }

    let table = json!({
        "models": stock["models"],
        "vendors": stock["vendors"],
        "names": names,
        "vendorOf": vendors,
    });
    let out = Path::new(&std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("stock-gcode.json");
    std::fs::write(out, table.to_string()).expect("writing the stock G-code table");
}
