// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The linter cases shared with the hosts' copy of the linter (packages/settings/js/gcode-lint.ts), which
//! reviews a project's G-code before it reaches the engine: both must find exactly what each case lists.

use serde_json::Value;
use sx_core::gcode_lint::{Limits, Section, Severity, Trust, lint};

#[test]
fn the_shared_cases_match() {
    let path = format!("{}/tests/gcode_lint_cases.json", env!("CARGO_MANIFEST_DIR"));
    let doc: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let cases = doc["cases"].as_array().unwrap();
    assert!(cases.len() > 30);
    for c in cases {
        let text = c["text"].as_str().unwrap();
        let section = match c["section"].as_str().unwrap() {
            "start" => Section::Start,
            "end" => Section::End,
            "layerChange" => Section::LayerChange,
            "toolChange" => Section::ToolChange,
            "pause" => Section::Pause,
            _ => Section::Other,
        };
        let trust = if c["trust"] == "trusted" {
            Trust::Trusted
        } else {
            Trust::Untrusted
        };
        let limits: Limits = serde_json::from_value(c["limits"].clone()).unwrap();
        let got: Vec<Value> = lint(text, section, trust, &limits)
            .findings
            .iter()
            .map(|f| {
                serde_json::json!([
                    f.line,
                    f.code,
                    if f.severity == Severity::Error {
                        "error"
                    } else {
                        "warning"
                    }
                ])
            })
            .collect();
        assert_eq!(
            &Value::Array(got),
            &c["expect"],
            "{text:?} as {section:?}, {trust:?}"
        );
    }
}
