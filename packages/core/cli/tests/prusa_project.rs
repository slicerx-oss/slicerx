// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx project-settings` and `sx slice` of a `PrusaSlicer` project read its own settings (`Metadata/Slic3r_PE.config`)
//! through the settings package's map, as the app and the MCP server open it: the shared cases in
//! packages/settings/fixtures/prusa-project-settings.json, and a slice of the T slab fixture that prints its support,
//! its 3 walls and its temperatures on the default printer, the same moves as those settings passed as `--config`.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn sx() -> Command {
    Command::new(env!("CARGO_BIN_EXE_sx"))
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../settings/fixtures")
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn ok(out: Output) -> Output {
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    out
}

fn project_settings(path: &Path) -> Value {
    let out = ok(sx().arg("project-settings").arg(path).output().unwrap());
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn sx_project_settings_prints_a_prusaslicer_projects_settings() {
    let doc: Value = serde_json::from_str(
        &std::fs::read_to_string(fixtures().join("prusa-project-settings.json")).unwrap(),
    )
    .unwrap();
    let case = &doc["cases"][0];
    let files = case["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    for f in files {
        let config = project_settings(&fixtures().join(f.as_str().unwrap()));
        assert_eq!(config, case["config"], "{f}");
    }
}

/// The lines of a G-code file that print, without its comments.
fn moves(gcode: &str) -> Vec<&str> {
    gcode
        .lines()
        .filter(|l| !l.starts_with(';') && !l.trim().is_empty())
        .collect()
}

#[test]
fn sx_slice_prints_a_prusaslicer_project_with_its_settings() {
    let tslab = fixtures().join("preset-files/prusaslicer-2.9.6-tslab.3mf");
    let dir = TempDir(std::env::temp_dir().join(format!("sx-cli-prusa-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let config = project_settings(&tslab);
    // PETG at 240 and 235 on the first layer, an 85 and 80 bed, 3 walls, organic support.
    assert_eq!(config["wall_loops"], "3");
    assert_eq!(config["enable_support"], "1");
    assert_eq!(config["support_type"], "tree(auto)");
    assert_eq!(config["nozzle_temperature_initial_layer"], "235");
    assert_eq!(config["hot_plate_temp_initial_layer"], "80");
    assert_eq!(config["filament_shrink"], "100%");

    let slice = |extra: &[&str]| {
        let out = ok(sx()
            .arg("slice")
            .arg(&tslab)
            .args(extra)
            .args(["-o", "-"])
            .output()
            .unwrap());
        String::from_utf8(out.stdout).unwrap()
    };
    let gcode = slice(&[]);
    let support = gcode.lines().filter(|l| *l == ";TYPE:Support").count();
    assert!(support > 50, "{support} support layers");
    assert!(gcode.lines().any(|l| l == ";TYPE:Ironing"));
    let first = |prefix: &str| gcode.lines().find(|l| l.starts_with(prefix)).map(str::to_owned);
    assert_eq!(first("M104 ").as_deref(), Some("M104 S235"));
    assert_eq!(first("M140 ").as_deref(), Some("M140 S80"));
    // The same settings passed as --config, with the project's own left out, slice the same moves.
    let path = dir.0.join("project.json");
    std::fs::write(&path, config.to_string()).unwrap();
    let given = slice(&["--no-project-settings", "--config", path.to_str().unwrap()]);
    assert_eq!(moves(&gcode), moves(&given));
    // and its 3 walls are what they print with: 2 slice other moves.
    let mut two = config.clone();
    two["wall_loops"] = "2".into();
    std::fs::write(&path, two.to_string()).unwrap();
    let two = slice(&["--no-project-settings", "--config", path.to_str().unwrap()]);
    assert_ne!(moves(&gcode), moves(&two));
    // Without them the project slices as before this read: no support.
    let plain = slice(&["--no-project-settings"]);
    assert_eq!(plain.lines().filter(|l| *l == ";TYPE:Support").count(), 0);
}
