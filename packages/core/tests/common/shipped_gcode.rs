// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The printer G-code `SlicerX` ships: `packages/profiles/gcode.json` with the families written by hand and the
//! models that use them (`gcode-written.json`), merged as the settings package merges them. A family or model in
//! both files is refused.

use serde_json::Value;

/// Adds `written`'s families and models to `doc`'s, or names the first one that is in both.
pub fn merge(mut doc: Value, written: &Value) -> Result<Value, String> {
    for (part, what) in [("families", "G-code family"), ("models", "printer model")] {
        let Some(extra) = written[part].as_object() else {
            continue;
        };
        let own = doc[part]
            .as_object_mut()
            .ok_or_else(|| format!("gcode.json has no {part}"))?;
        for (k, v) in extra {
            if own.contains_key(k) {
                return Err(format!(
                    "{what} {k} is in both gcode.json and gcode-written.json; keep it in one of them"
                ));
            }
            own.insert(k.clone(), v.clone());
        }
    }
    Ok(doc)
}

/// The merged document.
pub fn doc() -> Value {
    let read = |file: &str| -> Value {
        let path = format!("{}/../profiles/{file}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    };
    merge(read("gcode.json"), &read("gcode-written.json")).unwrap_or_else(|e| panic!("{e}"))
}
