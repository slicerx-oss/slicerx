// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Every start, end, layer change and tool change template the settings package ships
//! for its 57 printers, rendered with a real print and run through the G-code linter. The
//! makers' own text (families named `maker_*`) is the person's own G-code, so it is linted as
//! trusted text; the templates written for `SlicerX` are linted as imported text (the strictest
//! setting). None may carry an error.

use serde_json::Value;
use sx_core::gcode_lint::{Limits, Section, Severity, Trust, lint};

fn section(name: &str) -> Section {
    match name {
        "start" | "fileStart" => Section::Start,
        "end" => Section::End,
        "beforeLayerChange" | "layerChange" => Section::LayerChange,
        "changeFilament" => Section::ToolChange,
        "pause" | "templateCustom" => Section::Pause,
        "timeLapse" | "wrappingDetection" => Section::Other,
        other => panic!("unknown template part {other}"),
    }
}

#[test]
fn shipped_printer_gcode_passes_the_linter() {
    let path = format!("{}/../profiles/gcode.json", env!("CARGO_MANIFEST_DIR"));
    let doc: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mesh = sx_core::Mesh::load(
        &std::fs::read(format!("{}/bench/models/x-mark.stl", env!("CARGO_MANIFEST_DIR"))).unwrap(),
        "x-mark.stl",
    )
    .unwrap();
    let config = sx_core::PrintConfig::default();
    let out = sx_core::slice(
        &sx_core::Plate::single(mesh),
        &config,
        &sx_core::SliceOptions::default(),
    )
    .unwrap();
    let (mut sections, mut errors, mut warnings) = (0, Vec::new(), Vec::new());
    for (family, parts) in doc["families"].as_object().unwrap() {
        for (name, text) in parts.as_object().unwrap() {
            let Some(text) = text.as_str().filter(|t| !t.trim().is_empty()) else {
                continue;
            };
            let rendered = match sx_core::api::render_gcode_template(&config, &out, text, 5) {
                Ok(r) => r,
                Err(e) => {
                    errors.push(format!("{family}.{name}: {e}"));
                    continue;
                }
            };
            sections += 1;
            let trust = if family.starts_with("maker_") {
                Trust::Trusted
            } else {
                Trust::Untrusted
            };
            let report = lint(&rendered, section(name), trust, &Limits::default());
            for f in report.findings {
                let line = format!("{family}.{name} line {}: {} ({})", f.line, f.message, f.code);
                if f.severity == Severity::Error {
                    errors.push(line);
                } else {
                    warnings.push(line);
                }
            }
        }
    }
    assert!(sections > 100, "only {sections} sections");
    if !warnings.is_empty() {
        eprintln!("{} warnings:\n{}", warnings.len(), warnings.join("\n"));
    }
    assert!(
        errors.is_empty(),
        "{} errors in {sections} sections:\n{}",
        errors.len(),
        errors.join("\n")
    );
}
