// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The walls a Bambu Lab project slices with. A stock project inherits classic walls from its presets (its
//! `different_settings_to_system` does not list `wall_generator`) and slices with them; a project that lists the
//! generator as changed slices with the one it names, aegis included.
//!
//! tests/fixtures/bambu-walls/a1-wedge.3mf is a Bambu Studio 2.8 project for the A1 (0.20mm Standard, 0.4 nozzle, as
//! the app saved it) of our own test model: an arch and a thin wedge, 24 mm long, 2.4 mm wide at its base and 4 mm
//! tall, so 20 layers of 0.2 mm. Classic walls leave a tapering strip between the wedge's inner walls on every layer,
//! which gap fill covers; aegis walls widen across it, so no gap fill prints. a1-wedge-aegis.3mf is the same project
//! with aegis walls listed as the person's change.

use std::path::{Path, PathBuf};
use std::process::Command;

fn sx() -> Command {
    Command::new(env!("CARGO_BIN_EXE_sx"))
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/bambu-walls/{name}.3mf"))
}

/// The G-code and stderr of `sx slice` of the fixture `name`.
fn slice(name: &str) -> (String, String) {
    let dir = std::env::temp_dir().join(format!("sx-bambu-walls-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let gcode = dir.join(format!("{name}.gcode"));
    let out = sx()
        .arg("slice")
        .arg(fixture(name))
        .arg("-o")
        .arg(&gcode)
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&out.stderr).into_owned();
    let g = std::fs::read_to_string(&gcode).unwrap_or_default();
    std::fs::remove_dir_all(&dir).ok();
    assert!(out.status.success(), "{err}");
    (g, err)
}

/// The G-code's `wall_generator` line and the gap fill blocks (feature headings) that extrude.
fn walls_and_gap_fill(g: &str) -> (String, usize) {
    let line = g
        .lines()
        .find(|l| l.starts_with("; wall_generator = "))
        .unwrap_or_default()
        .to_owned();
    let mut blocks = 0;
    let mut in_gap = false;
    let mut counted = false;
    for l in g.lines() {
        if let Some(feature) = l.strip_prefix("; FEATURE: ") {
            in_gap = feature == "Gap infill";
            counted = false;
        } else if in_gap
            && !counted
            && l.starts_with("G1 ")
            && l.split_whitespace()
                .any(|w| w.starts_with('E') && !w.starts_with("E-"))
        {
            blocks += 1;
            counted = true;
        }
    }
    (line, blocks)
}

#[test]
fn a_stock_a1_project_slices_with_its_classic_walls_and_fills_the_wedge() {
    let (g, err) = slice("a1-wedge");
    let (line, gap) = walls_and_gap_fill(&g);
    // One block of gap fill on each of the wedge's 20 layers.
    assert!(gap >= 20, "{gap} gap fill blocks, {line}");
    assert_eq!(line, "; wall_generator = classic");
    assert!(
        err.contains("sx: walls: classic walls, as the project has them"),
        "{err}"
    );
    assert!(!err.contains("Kept SlicerX's aegis walls"), "{err}");
}

#[test]
fn a_bambu_project_that_chose_aegis_walls_keeps_them() {
    let (g, err) = slice("a1-wedge-aegis");
    let (line, gap) = walls_and_gap_fill(&g);
    assert_eq!(line, "; wall_generator = aegis");
    assert!(
        err.contains("sx: walls: aegis walls, the project's own choice"),
        "{err}"
    );
    // Aegis walls widen across the wedge's strip, so it gets no gap fill.
    assert_eq!(gap, 0);
}

/// Whether two G-code files are the same, without printing either when they are not.
fn same(a: &str, b: &str) -> bool {
    a == b
}

/// `sx slice <model> --config <config>` of `tests/fixtures/<model>` and its G-code and stderr.
fn slice_with(model: &str, config: &serde_json::Value, name: &str) -> (String, String) {
    let dir = std::env::temp_dir().join(format!("sx-bambu-walls-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let cfg = dir.join("config.json");
    std::fs::write(&cfg, config.to_string()).unwrap();
    let gcode = dir.join("out.gcode");
    let out = sx()
        .arg("slice")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/{model}")))
        .arg("--config")
        .arg(&cfg)
        .arg("-o")
        .arg(&gcode)
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&out.stderr).into_owned();
    let g = std::fs::read_to_string(&gcode).unwrap_or_default();
    std::fs::remove_dir_all(&dir).ok();
    assert!(out.status.success(), "{err}");
    (g, err)
}

/// The G-code of a slice request for `tests/fixtures/wedge.stl` with `config`.
fn request_with(config: &serde_json::Value, name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("sx-bambu-walls-req-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let wedge = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/wedge.stl");
    let request = serde_json::json!({
        "schemaVersion": 1,
        "meshes": { "w": wedge },
        "plate": {
            "bed": { "widthMm": 256, "depthMm": 256, "heightMm": 256 },
            "objects": [{ "id": "o1", "name": "Wedge", "mesh": "w" }]
        },
        "config": config,
        "options": { "emitGcode": true }
    });
    let req = dir.join("request.json");
    std::fs::write(&req, request.to_string()).unwrap();
    let out = sx()
        .args(["slice", "--request"])
        .arg(&req)
        .arg("--out-dir")
        .arg(&dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let g = std::fs::read_to_string(dir.join("slice.gcode")).unwrap();
    std::fs::remove_dir_all(&dir).ok();
    g
}

#[test]
fn an_stl_on_a_bambu_lab_printer_slices_with_classic_walls() {
    let a1 = serde_json::json!({ "printer_model": "Bambu Lab A1" });
    let classic = serde_json::json!({ "printer_model": "Bambu Lab A1", "wall_generator": "classic" });
    let aegis = serde_json::json!({ "printer_model": "Bambu Lab A1", "wall_generator": "aegis" });
    // A model file with settings that name no wall generator: the A1's presets' classic walls.
    let (g, err) = slice_with("wedge.stl", &a1, "a1");
    assert!(
        err.contains("sx: walls: classic walls, the engine's default (the settings names no wall_generator)"),
        "{err}"
    );
    assert!(
        same(&g, &slice_with("wedge.stl", &classic, "a1-classic").0),
        "not the classic walls"
    );
    assert!(!same(&g, &slice_with("wedge.stl", &aegis, "a1-aegis").0));
    // A request the same way.
    assert!(
        same(&request_with(&a1, "a1"), &request_with(&classic, "a1-classic")),
        "request: not the classic walls"
    );
}

#[test]
fn aegis_set_for_a_bambu_lab_printer_stays_aegis() {
    let aegis = serde_json::json!({ "printer_model": "Bambu Lab A1", "wall_generator": "aegis" });
    let classic = serde_json::json!({ "printer_model": "Bambu Lab A1", "wall_generator": "classic" });
    let (g, err) = slice_with("wedge.stl", &aegis, "set-aegis");
    assert!(err.contains("sx: walls: aegis walls, set by --config"), "{err}");
    assert!(!same(&g, &slice_with("wedge.stl", &classic, "set-classic").0));
    assert!(!same(
        &request_with(&aegis, "set-aegis"),
        &request_with(&classic, "set-classic")
    ));
}

#[test]
fn an_stl_on_another_printer_keeps_the_aegis_default() {
    let mk4 = serde_json::json!({ "printer_model": "Original Prusa MK4" });
    let aegis = serde_json::json!({ "printer_model": "Original Prusa MK4", "wall_generator": "aegis" });
    let (g, err) = slice_with("wedge.stl", &mk4, "mk4");
    assert!(
        err.contains("sx: walls: aegis walls, the engine's default (the settings names no wall_generator)"),
        "{err}"
    );
    assert!(same(&g, &slice_with("wedge.stl", &aegis, "mk4-aegis").0));
}
