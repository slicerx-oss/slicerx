// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Tree support infill from the command line: the trunk fixture (a 45 mm tower with a 20 x 4 mm arm at 40 mm) on the P1S
//! settings with slim trees. With `tree_support_with_infill` the wide part of the trunk gets support lines inside
//! its walls: more support and a longer print, the same interface and the same part.

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

fn fixture(name: &str) -> String {
    format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// A temp dir that is removed when it drops.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Slices the fixture request with `tree_support_with_infill` set to `on`: the report and the G-code.
fn slice(on: bool) -> (Value, String) {
    let mut req: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("tree-infill-request.json")).unwrap()).unwrap();
    req["meshes"]["m"] = json!(fixture("trunk.stl"));
    req["config"]["tree_support_with_infill"] = json!(on);
    let dir = TempDir(std::env::temp_dir().join(format!("sx-tree-infill-{on}-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let path = dir.0.join("request.json");
    std::fs::write(&path, req.to_string()).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_sx"))
        .args(["slice", "--request"])
        .arg(&path)
        .arg("--out-dir")
        .arg(&dir.0)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    let gcode = std::fs::read_to_string(dir.0.join("slice.gcode")).unwrap();
    (report, gcode)
}

/// Filament pushed by moves that go somewhere, per feature, mm (relative extrusion, as the P1S settings print).
fn extrusion(gcode: &str) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    let mut feature = String::new();
    for line in gcode.lines() {
        if let Some(f) = line.strip_prefix("; FEATURE: ") {
            feature = f.trim().to_string();
            continue;
        }
        if !(line.starts_with("G1 ") || line.starts_with("G2 ") || line.starts_with("G3 ")) {
            continue;
        }
        let words: Vec<&str> = line.split(';').next().unwrap_or("").split_whitespace().collect();
        let moves = words.iter().any(|w| w.starts_with('X') || w.starts_with('Y'));
        let e: f64 = words
            .iter()
            .find_map(|w| w.strip_prefix('E'))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0);
        if moves && e > 0.0 {
            *out.entry(feature.clone()).or_insert(0.0) += e;
        }
    }
    out
}

#[test]
fn tree_support_infill_adds_support_inside_a_wide_trunk_only() {
    let (off_report, off) = slice(false);
    let (on_report, on) = slice(true);
    assert!(off.contains("M83"), "the P1S settings print relative extrusion");
    assert_eq!(off_report["layerCount"], on_report["layerCount"]);
    let (a, b) = (extrusion(&off), extrusion(&on));
    let support = |m: &BTreeMap<String, f64>| m.get("Support").copied().unwrap_or(0.0);
    assert!(
        support(&b) > 1.1 * support(&a),
        "support {:.1} mm with the key against {:.1} without",
        support(&b),
        support(&a)
    );
    for (k, v) in &a {
        if k != "Support" {
            let w = b.get(k).copied().unwrap_or(0.0);
            assert!(
                (v - w).abs() < 1e-3,
                "{k}: {v:.4} mm without the key, {w:.4} with it"
            );
        }
    }
    let (ta, tb) = (
        off_report["stats"]["timeS"].as_f64().unwrap(),
        on_report["stats"]["timeS"].as_f64().unwrap(),
    );
    assert!(tb > ta, "print time {tb} s with the key against {ta} s without");
}
