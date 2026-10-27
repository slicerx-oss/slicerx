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

/// Projects with one model and full `PrusaSlicer` settings, in pairs that differ only in how some widths are given:
/// as a percent in one, and in mm in the other.
fn widths(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/prusa-widths")
        .join(name)
}

fn gcode(path: &Path) -> String {
    let out = ok(sx().arg("slice").arg(path).args(["-o", "-"]).output().unwrap());
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn sx_project_settings_reads_prusaslicer_width_percents_in_mm() {
    // The T slab: a 200% first layer width of its 0.2 first layer, and a 50% support XY spacing of the auto outer wall
    // width on its 0.4 nozzle (1.125 x 0.4).
    let config = project_settings(&fixtures().join("preset-files/prusaslicer-2.9.6-tslab.3mf"));
    assert_eq!(config["initial_layer_line_width"], "0.4");
    assert_eq!(config["support_object_xy_distance"], "0.225");
    // 100% of an outer wall width that is itself 150% of the 0.2 layer height.
    let config = project_settings(&widths("xy-pct100-ext150pct.3mf"));
    assert_eq!(config["outer_wall_line_width"], "0.3");
    assert_eq!(config["support_object_xy_distance"], "0.3");
    // Every width of 150% on 0.2 layers is 0.3.
    let config = project_settings(&widths("r6-pct150.3mf"));
    for k in [
        "outer_wall_line_width",
        "inner_wall_line_width",
        "sparse_infill_line_width",
        "internal_solid_infill_line_width",
        "top_surface_line_width",
        "support_line_width",
    ] {
        assert_eq!(config[k], "0.3", "{k}");
    }
    assert_eq!(config["support_object_xy_distance"], "0.15");
}

#[test]
fn a_prusaslicer_project_prints_its_width_percents_as_their_mm() {
    // Each percent project slices to the same bytes as its twin with the same widths in mm, and its first layer's skirt
    // prints at the first layer width (200% of a 0.2 first layer, 150% of a 0.3 one). The support XY spacing of 100% of
    // a 0.6 outer wall leaves the same gap as 0.6 mm, and widths of 150% on 0.2 layers print as 0.3 mm.
    let mut wrong = Vec::new();
    for (percent, mm, skirt) in [
        ("flw-pct200-flh02.3mf", "flw-mm04-flh02.3mf", Some("0.4")),
        ("flw-pct150-flh03.3mf", "flw-mm045-flh03.3mf", Some("0.45")),
        ("xy-pct100-ext06.3mf", "xy-mm06-ext06.3mf", None),
        ("r6-pct150.3mf", "r6-mm03.3mf", None),
    ] {
        let g = gcode(&widths(percent));
        if g != gcode(&widths(mm)) {
            wrong.push(format!("{percent} prints other moves than {mm}"));
        }
        if let Some(want) = skirt {
            let width = g
                .lines()
                .skip_while(|l| *l != ";TYPE:Skirt")
                .find_map(|l| l.strip_prefix(";WIDTH:"));
            if width != Some(want) {
                wrong.push(format!("{percent}: skirt width {width:?}, not {want}"));
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// The widths each feature type prints above the first layer, from the G-code's `;WIDTH:` lines.
fn widths_above_layer_1(
    gcode: &str,
) -> std::collections::BTreeMap<String, std::collections::BTreeSet<String>> {
    let mut out = std::collections::BTreeMap::<String, std::collections::BTreeSet<String>>::new();
    let (mut layer, mut kind, mut width) = (0, String::new(), String::new());
    for l in gcode.lines() {
        if l == ";LAYER_CHANGE" {
            layer += 1;
        } else if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
        } else if let Some(w) = l.strip_prefix(";WIDTH:") {
            w.clone_into(&mut width);
        } else if layer > 1 && l.starts_with("G1 ") && l.contains(" X") && l.contains(" E") {
            out.entry(kind.clone()).or_default().insert(width.clone());
        }
    }
    out
}

/// Each object's own settings as the engine reads them from a project, in the order of its objects.
fn object_settings(name: &str) -> Vec<Value> {
    let bytes = std::fs::read(widths(name)).unwrap();
    let plates = sx_core::api::load_3mf_plate_objects(&bytes, name).unwrap();
    plates
        .iter()
        .flat_map(|(_, meshes)| meshes.iter())
        .map(|m| m.settings.clone())
        .collect()
}

#[test]
fn a_prusaslicer_objects_width_percents_are_of_its_own_layer_height() {
    // One object with its own 0.3 mm layers under 0.1 mm project layers: the project's 150% and 250% inner walls print
    // 0.45 and 0.75, and on the mushroom the 150% outer wall and support 0.45, with a 100% support XY spacing of 0.45.
    let mut wrong = Vec::new();
    for (name, kind, want) in [
        ("o16.3mf", "Inner wall", "0.45"),
        ("o24.3mf", "Inner wall", "0.75"),
        ("o13.3mf", "Outer wall", "0.45"),
        ("o13.3mf", "Support", "0.45"),
    ] {
        let out = sx()
            .arg("slice")
            .arg(widths(name))
            .args(["-o", "-"])
            .output()
            .unwrap();
        if !out.status.success() {
            wrong.push(format!("{name}: {}", String::from_utf8_lossy(&out.stderr).trim()));
            continue;
        }
        let printed = widths_above_layer_1(&String::from_utf8(out.stdout).unwrap());
        let got = printed.get(kind).cloned().unwrap_or_default();
        if got.len() != 1 || !got.contains(want) {
            wrong.push(format!("{name}: {kind} prints {got:?}, not {want}"));
        }
    }
    // A 250% inner wall on the object's 0.3 mm layers slices as 0.75 mm does.
    if gcode(&widths("t1-pct.3mf")) != gcode(&widths("t1-mm.3mf")) {
        wrong.push("t1-pct.3mf prints other moves than t1-mm.3mf".to_owned());
    }
    // The object's own percents: an inner wall of 150% of the project's 0.1 mm layers, and a support XY spacing of
    // 150% of the project's 0.6 mm outer wall.
    let setting = |name: &str, key: &str| -> Vec<Option<String>> {
        object_settings(name)
            .iter()
            .map(|s| s.get(key).and_then(Value::as_str).map(str::to_owned))
            .collect()
    };
    for (name, key, want) in [
        ("o13.3mf", "support_object_xy_distance", "0.45"),
        ("o15.3mf", "support_object_xy_distance", "0.9"),
        ("o2.3mf", "inner_wall_line_width", "0.15"),
    ] {
        let got = setting(name, key);
        if !got.iter().any(|v| v.as_deref() == Some(want)) {
            wrong.push(format!("{name}: object {key} {got:?}, not {want}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}
