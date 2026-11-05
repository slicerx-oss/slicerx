// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx project-settings` and `sx slice` of a `PrusaSlicer` project read its own settings (`Metadata/Slic3r_PE.config`)
//! through the settings package's map, as the app and the MCP server open it: the shared cases in
//! packages/settings/fixtures/prusa-project-settings.json, and a slice of the T slab fixture that prints its support,
//! its 3 walls and its temperatures on the default printer, the same moves as those settings passed as `--config`.
#![allow(
    clippy::disallowed_methods,
    clippy::float_cmp,
    clippy::many_single_char_names,
    clippy::similar_names,
    reason = "a G-code reader for the test: plate positions, arcs and widths in mm"
)]

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

/// The inner wall widths above the first layer left and right of the plate's `x`, from the G-code's `;WIDTH:` lines.
fn inner_walls_by_side(gcode: &str, x: f64) -> [std::collections::BTreeSet<String>; 2] {
    let mut out = [
        std::collections::BTreeSet::new(),
        std::collections::BTreeSet::new(),
    ];
    let (mut layer, mut kind, mut width, mut at) = (0, String::new(), String::new(), 0.0_f64);
    for l in gcode.lines() {
        if l == ";LAYER_CHANGE" {
            layer += 1;
        } else if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
        } else if let Some(w) = l.strip_prefix(";WIDTH:") {
            w.clone_into(&mut width);
        } else if l.starts_with("G1 ") || l.starts_with("G0 ") {
            let to = l
                .split_whitespace()
                .find_map(|f| f.strip_prefix('X'))
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(at);
            if layer > 1 && kind == "Inner wall" && l.contains(" E") && l.contains(" X") {
                out[usize::from(f64::midpoint(at, to) >= x)].insert(width.clone());
            }
            at = to;
        }
    }
    out
}

#[test]
fn a_prusaslicer_parts_own_wall_widths_print_beside_another_part() {
    // A part's (volume's) own inner wall width prints on that part only, beside an object or a part without one: B's
    // 0.55 mm next to object A (o23), the second of two parts at 0.55 mm, and two parts at 0.35 and 0.55 mm.
    let mut wrong = Vec::new();
    for (name, x, want) in [
        ("o23.3mf", 100.0, ["0.45", "0.55"]),
        ("vol-two-mm.3mf", 122.5, ["0.45", "0.55"]),
        ("vol-two-own.3mf", 122.5, ["0.35", "0.55"]),
        // A part's 150% is of its object's layer height: the project's 0.1 mm.
        ("o6.3mf", 100.0, ["0.45", "0.15"]),
    ] {
        let got = inner_walls_by_side(&gcode(&widths(name)), x);
        for (side, (got, want)) in got.iter().zip(want).enumerate() {
            if got.len() != 1 || !got.contains(want) {
                wrong.push(format!("{name}: side {side} inner walls {got:?}, not {want}"));
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn a_prusaslicer_parts_width_percents_are_of_its_objects_layer_height() {
    // 150% on the part: of the project's 0.1 mm layers (0.15), of the object's own 0.3 mm (0.45), the same on a 0.6
    // mm nozzle (the nozzle does not enter), and the part's own 0.3 mm layer height is not the object's (0.15).
    let mut wrong = Vec::new();
    for (name, want) in [
        ("vol-pct150.3mf", "0.15"),
        ("vol-pct150-objlh03.3mf", "0.45"),
        ("vol-pct150-n06.3mf", "0.15"),
        ("vol-lh03-pct150.3mf", "0.15"),
    ] {
        let printed = widths_above_layer_1(&gcode(&widths(name)));
        let got = printed.get("Inner wall").cloned().unwrap_or_default();
        if got.len() != 1 || !got.contains(want) {
            wrong.push(format!("{name}: inner walls {got:?}, not {want}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn a_prusaslicer_objects_own_solid_infill_width_prints_on_the_first_layer_at_its_height() {
    // o22: the object sets a solid infill width of 250% and its own 0.3 mm layers, and the project sets no first layer
    // width. Above the first layer its solid infill prints 0.75 mm; the first layer's bottom prints 250% of the 0.2 mm
    // first layer height, 0.5 mm with its lines fitted to the area.
    let g = gcode(&widths("o22.3mf"));
    let mut layer = 0;
    let (mut kind, mut first) = (String::new(), std::collections::BTreeSet::new());
    for l in g.lines() {
        if l == ";LAYER_CHANGE" {
            layer += 1;
        } else if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
        } else if let Some(w) = l.strip_prefix(";WIDTH:")
            && layer == 1
            && kind == "Bottom surface"
        {
            first.insert(w.to_owned());
        }
    }
    let off: Vec<&String> = first
        .iter()
        .filter(|w| !w.parse::<f64>().is_ok_and(|w| (0.5..0.52).contains(&w)))
        .collect();
    assert!(
        !first.is_empty() && off.is_empty(),
        "first layer bottom widths {first:?}"
    );
    let printed = widths_above_layer_1(&g);
    assert!(
        printed
            .get("Internal solid infill")
            .is_some_and(|w| w.contains("0.75")),
        "{printed:?}"
    );
}

/// The first layer's extrusions on one side of the plate's `x` (right of it when `right`), skirt left out: each
/// feature and its line ends in hundredths of a mm, sorted.
fn first_layer_side(gcode: &str, x: f64, right: bool) -> Vec<String> {
    let (mut layer, mut kind) = (0, String::new());
    let (mut at_x, mut at_y) = (0.0_f64, 0.0_f64);
    let mut out = Vec::new();
    for l in gcode.lines() {
        if l == ";LAYER_CHANGE" {
            layer += 1;
            continue;
        }
        if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
            continue;
        }
        if !(l.starts_with("G1 ") || l.starts_with("G0 ")) {
            continue;
        }
        let field = |c: char| {
            l.split(';')
                .next()
                .unwrap_or("")
                .split_whitespace()
                .find_map(|f| f.strip_prefix(c))
                .and_then(|v| v.parse::<f64>().ok())
        };
        let (nx, ny) = (field('X').unwrap_or(at_x), field('Y').unwrap_or(at_y));
        if layer == 1
            && kind != "Skirt"
            && field('E').is_some_and(|e| e > 0.0)
            && (nx - at_x).abs() + (ny - at_y).abs() > 1e-6
            && (f64::midpoint(at_x, nx) > x) == right
        {
            out.push(format!("{kind} {at_x:.2},{at_y:.2} {nx:.2},{ny:.2}"));
        }
        (at_x, at_y) = (nx, ny);
    }
    out.sort();
    out
}

#[test]
fn a_prusaslicer_part_without_settings_prints_its_first_layer_as_its_own() {
    // One object with its own 0.3 mm layers and two parts; the second part sets its inner walls to 200% (0.6 mm). With
    // no first layer width the first layer prints each region's walls at their own widths, so the plain part walls
    // itself there: its first layer prints as it does beside a part without settings.
    let beside_part = first_layer_side(&gcode(&widths("vol-plain-beside-pct200.3mf")), 122.5, false);
    let beside_plain = first_layer_side(&gcode(&widths("vol-plain-beside-plain.3mf")), 122.5, false);
    assert!(!beside_plain.is_empty());
    assert_eq!(beside_part, beside_plain);
    // Two objects, the second a part at 150% (0.15 mm): the plain object's first layer is its own, and the part's
    // first layer walls print at the part's width there, 150% of the 0.2 mm first layer height.
    let g = gcode(&widths("o6.3mf"));
    assert_eq!(
        first_layer_side(&g, 102.0, false),
        first_layer_side(&gcode(&widths("o6-plain.3mf")), 102.0, false)
    );
    let inner: std::collections::BTreeSet<String> = {
        let (mut layer, mut kind, mut width) = (0, String::new(), String::new());
        let mut out = std::collections::BTreeSet::new();
        let mut at = 0.0_f64;
        for l in g.lines() {
            if l == ";LAYER_CHANGE" {
                layer += 1;
            } else if let Some(t) = l.strip_prefix(";TYPE:") {
                t.clone_into(&mut kind);
            } else if let Some(w) = l.strip_prefix(";WIDTH:") {
                w.clone_into(&mut width);
            } else if l.starts_with("G1 ") {
                let to = l
                    .split_whitespace()
                    .find_map(|f| f.strip_prefix('X'))
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(at);
                if layer == 1 && kind == "Inner wall" && l.contains(" E") && f64::midpoint(at, to) > 102.0 {
                    out.insert(width.clone());
                }
                at = to;
            }
        }
        out
    };
    assert_eq!(inner, ["0.3".to_owned()].into_iter().collect());
}

/// `PrusaSlicer` projects of an 8 x 8 mm pillar under a 16 x 16 mm slab, with normal support around the pillar: grid
/// support at XY spacings of 0.3, 0.8 and 1.5 mm, snug support at 0.8 mm, and grid support at 0.8 mm with the object's
/// own layer height of 0.3 mm on a 0.2 mm project. Every width is 0 (auto).
fn ring(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/prusa-support-gap")
        .join(name)
}

/// Per layer from `z0` to `z1`, the gap from the outline of the 8 x 8 mm pillar to the outer edge of the nearest base
/// support line (`;TYPE:Support`, half its `;WIDTH:` off the centerline), on the flat faces, a millimeter clear of the
/// corners. The pillar's center is the middle of its outer walls on those layers.
fn base_gaps(gcode: &str, z0: f64, z1: f64) -> Vec<(f64, f64)> {
    struct Move {
        from: (f64, f64),
        to: (f64, f64),
        z: f64,
        kind: String,
        width: f64,
    }
    let (mut px, mut py, mut pz, mut width) = (0.0, 0.0, 0.0, 0.0);
    let mut kind = String::new();
    let mut moves = Vec::new();
    for line in gcode.lines() {
        if let Some(t) = line.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
        } else if let Some(w) = line.strip_prefix(";WIDTH:") {
            width = w.parse().unwrap();
        }
        let code = line.split(';').next().unwrap().trim();
        if !(code.starts_with("G1 ") || code.starts_with("G0 ")) {
            continue;
        }
        let (mut nx, mut ny, mut extrude) = (px, py, 0.0);
        for word in code.split_whitespace().skip(1) {
            let (axis, v) = word.split_at(1);
            let v: f64 = v.parse().unwrap_or(0.0);
            match axis {
                "X" => nx = v,
                "Y" => ny = v,
                "Z" => pz = v,
                "E" => extrude = v,
                _ => {}
            }
        }
        if extrude > 0.0
            && ((nx - px) * (nx - px) + (ny - py) * (ny - py)).sqrt() > 0.05
            && (z0..=z1).contains(&pz)
        {
            moves.push(Move {
                from: (px, py),
                to: (nx, ny),
                z: pz,
                kind: kind.clone(),
                width,
            });
        }
        (px, py) = (nx, ny);
    }
    let walls: Vec<(f64, f64)> = moves
        .iter()
        .filter(|m| m.kind == "Outer wall")
        .map(|m| m.to)
        .collect();
    let mid = |f: fn(&(f64, f64)) -> f64| {
        let lo = walls.iter().map(f).fold(f64::INFINITY, f64::min);
        let hi = walls.iter().map(f).fold(f64::NEG_INFINITY, f64::max);
        f64::midpoint(lo, hi)
    };
    let (cx, cy) = (mid(|p| p.0), mid(|p| p.1));
    let mut gaps: Vec<(f64, f64)> = Vec::new();
    for m in moves.iter().filter(|m| m.kind == "Support") {
        let len = {
            let (dx, dy) = (m.to.0 - m.from.0, m.to.1 - m.from.1);
            (dx * dx + dy * dy).sqrt()
        };
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a short move"
        )]
        let steps = ((len / 0.05) as usize).max(1);
        for k in 0..=steps {
            #[allow(clippy::cast_precision_loss, reason = "a small count")]
            let t = k as f64 / steps as f64;
            let (px, py) = (
                m.from.0 + (m.to.0 - m.from.0) * t,
                m.from.1 + (m.to.1 - m.from.1) * t,
            );
            let (dx, dy) = ((px - cx).abs(), (py - cy).abs());
            let centerline = if dy < 3.0 {
                dx - 4.0
            } else if dx < 3.0 {
                dy - 4.0
            } else {
                continue;
            };
            if !(-0.5..3.0).contains(&centerline) {
                continue;
            }
            let gap = centerline - m.width / 2.0;
            match gaps.iter_mut().find(|(lz, _)| (*lz - m.z).abs() < 1e-6) {
                Some(slot) => slot.1 = slot.1.min(gap),
                None => gaps.push((m.z, gap)),
            }
        }
    }
    gaps
}

#[test]
fn a_prusaslicer_projects_base_support_keeps_its_xy_spacing_to_the_line_edge() {
    // The outer base support line's edge sits the project's XY spacing from the part, on grid and snug support, and on
    // an object with its own layer height. The pair of projects with the spacing as 100% of a 0.6 mm outer wall and as
    // 0.6 mm both leave 0.6.
    let mut wrong = Vec::new();
    let cases = [
        (ring("grid-n0.4-xy0.3.3mf"), 6.0, 0.3),
        (ring("grid-n0.4-xy0.8.3mf"), 6.0, 0.8),
        (ring("grid-n0.4-xy1.5.3mf"), 6.0, 1.5),
        (ring("snug-n0.4-xy0.8.3mf"), 6.0, 0.8),
        (ring("grid-n0.4-xy0.8-objlh0.3.3mf"), 6.0, 0.8),
        (widths("xy-pct100-ext06.3mf"), 1.0, 0.6),
        (widths("xy-mm06-ext06.3mf"), 1.0, 0.6),
    ];
    for (path, z0, want) in cases {
        let gaps = base_gaps(&gcode(&path), z0, z0 + 2.8);
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if gaps.len() < 5 {
            wrong.push(format!("{name}: {} layers measured", gaps.len()));
        }
        for (z, gap) in gaps {
            if (gap - want).abs() > 0.001 + 1e-9 {
                wrong.push(format!("{name}: gap {gap:.4} at z {z}, not {want}"));
                break;
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn sx_project_settings_puts_the_outer_support_line_edge_on_the_gap() {
    for name in ["grid-n0.4-xy0.8.3mf", "snug-n0.4-xy0.8.3mf"] {
        let config = project_settings(&ring(name));
        assert_eq!(config["support_object_xy_distance"], "0.8", "{name}");
        assert_eq!(config["support_base_edge_inset"], "half_width", "{name}");
    }
}

#[test]
fn a_prusaslicer_width_of_0_is_the_general_width_else_the_nozzles() {
    // A width left at 0 prints the project's 0.5 mm general width, the same bytes as every width set to 0.5 mm. Top
    // surface lines are fitted to the area, so they print within a few microns of it.
    let mut wrong = Vec::new();
    let pairs = [("t2-ew05.3mf", "t2-all05.3mf"), ("t3-auto.3mf", "t3-sup04.3mf")];
    for (zero, mm) in pairs {
        if gcode(&widths(zero)) != gcode(&widths(mm)) {
            wrong.push(format!("{zero} prints other moves than {mm}"));
        }
    }
    let printed = widths_above_layer_1(&gcode(&widths("t2-ew05.3mf")));
    for kind in ["Outer wall", "Inner wall", "Support", "Support interface"] {
        let got = printed.get(kind).cloned().unwrap_or_default();
        if got.len() != 1 || !got.contains("0.5") {
            wrong.push(format!("t2-ew05.3mf: {kind} prints {got:?}, not 0.5"));
        }
    }
    let top = printed.get("Top surface").cloned().unwrap_or_default();
    if top.is_empty()
        || !top
            .iter()
            .all(|w| w.parse::<f64>().is_ok_and(|w| (w - 0.5).abs() <= 0.01))
    {
        wrong.push(format!("t2-ew05.3mf: top surface prints {top:?}, not about 0.5"));
    }
    // With the general width 0 too, the support prints at the project's own nozzle diameter above the first layer.
    for (name, want) in [
        ("t3-auto.3mf", "0.4"),
        ("n0.25-auto-mush.3mf", "0.25"),
        ("n0.6-auto-mush.3mf", "0.6"),
        ("n0.8-auto-mush.3mf", "0.8"),
    ] {
        let printed = widths_above_layer_1(&gcode(&widths(name)));
        for kind in ["Support", "Support interface"] {
            let got = printed.get(kind).cloned().unwrap_or_default();
            if got.len() != 1 || !got.contains(want) {
                wrong.push(format!("{name}: {kind} prints {got:?}, not {want}"));
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn an_object_with_its_own_layer_height_prints_support_at_the_projects_support_width() {
    // The object's own 0.3 mm layer height prints its part with settings of its own, at the 0.45 mm line width; the
    // support around it still prints at the project's 0.4 mm support width (0 with no general width: the nozzle).
    let printed = widths_above_layer_1(&gcode(&ring("grid-n0.4-xy0.8-objlh0.3.3mf")));
    for kind in ["Support", "Support interface"] {
        let got = printed.get(kind).cloned().unwrap_or_default();
        assert!(
            got.len() == 1 && got.contains("0.4"),
            "{kind} prints {got:?}, not 0.4"
        );
    }
    let walls = printed.get("Outer wall").cloned().unwrap_or_default();
    assert!(
        walls.len() == 1 && walls.contains("0.45"),
        "outer wall prints {walls:?}, not 0.45"
    );
}

/// Projects of one object made of two 10 mm boxes 20 mm apart, 15 layers of 0.2 mm, that differ in their filament's
/// own lift settings: `mini--isl--FRL06` a retract lift of 0.6 and no ramping of its own, `mk4--isl--FRAMP0FRL06`
/// ramping off and a retract lift of 0.6, `mk4--isl--stock` ramping on up to 0.6 at 1 degree, `mk4--isl--FSL90` the
/// same ramp at 90 degrees, and `mk4--isl--FML0` a ramp of height 0.
fn lift_project(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/prusa-lift")
        .join(format!("{name}.3mf"))
}

/// One travel between two extruding moves: the layer heights it leaves and reaches, how far above the higher of them
/// it goes, its length in XY, and whether every move that raises the nozzle goes straight up.
struct Travel {
    from_z: f64,
    to_z: f64,
    lift: f64,
    xy: f64,
    straight: bool,
}

/// The travels of a G-code file, between the first extruding move and the last.
fn travels(gcode: &str) -> Vec<Travel> {
    let (mut at_x, mut at_y, mut at_z, mut at_e) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
    let mut relative = false;
    let mut out = Vec::new();
    // The layer height of the last extruding move, and the travel since it: its moves, top, length and straightness.
    let mut last: Option<f64> = None;
    let (mut moves, mut top, mut xy, mut straight) = (0_usize, f64::MIN, 0.0_f64, true);
    for line in gcode.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        let mut words = code.split_whitespace();
        let Some(cmd) = words.next() else { continue };
        match cmd {
            "M83" => relative = true,
            "M82" => relative = false,
            "G0" | "G1" => {}
            _ => continue,
        }
        let (mut nx, mut ny, mut nz, mut de) = (at_x, at_y, at_z, 0.0_f64);
        for w in words {
            let (axis, v) = w.split_at(1);
            let Ok(v) = v.parse::<f64>() else { continue };
            match axis {
                "X" => nx = v,
                "Y" => ny = v,
                "Z" => nz = v,
                "E" => {
                    de = if relative { v } else { v - at_e };
                    at_e = if relative { at_e + v } else { v };
                }
                _ => {}
            }
        }
        let (dx, dy) = (nx - at_x, ny - at_y);
        let run = (dx * dx + dy * dy).sqrt();
        if de > 0.0 && run > 0.0 {
            if let Some(from_z) = last
                && moves > 0
            {
                out.push(Travel {
                    from_z,
                    to_z: nz,
                    lift: top - from_z.max(nz),
                    xy,
                    straight,
                });
            }
            last = Some(nz);
            (moves, top, xy, straight) = (0, f64::MIN, 0.0, true);
        } else if last.is_some() {
            moves += 1;
            top = top.max(nz);
            xy += run;
            if nz > at_z + 1e-9 && run > 0.0 {
                straight = false;
            }
        }
        (at_x, at_y, at_z) = (nx, ny, nz);
    }
    out
}

#[test]
fn a_prusaslicer_projects_filament_lift_reaches_the_slice() {
    // (project, the lift, whether it goes straight up): the filament's own lift on the default printer, which lifts
    // nothing. Every travel between the two boxes on a layer retracts and lifts, and any travel that lifts lifts by the
    // filament's height. A ramp at 0 or 90 degrees goes straight up; a sloped ramp's climb (by the travel's length) is
    // checked in prusa_lift_ramp.rs.
    let mut wrong = Vec::new();
    for (name, height, straight) in [
        ("mini--isl--FRL06", 0.6, None),
        ("mk4--isl--FRAMP0FRL06", 0.6, Some(true)),
        ("mk4--isl--FSL90", 0.6, Some(true)),
    ] {
        let all = travels(&gcode(&lift_project(name)));
        let between: Vec<&Travel> = all
            .iter()
            .filter(|t| (t.from_z - t.to_z).abs() < 1e-6 && t.xy > 15.0)
            .collect();
        if between.len() != 15 {
            wrong.push(format!(
                "{name}: {} travels between the boxes, not 15",
                between.len()
            ));
        }
        for t in &between {
            if (t.lift - height).abs() > 0.005 {
                wrong.push(format!(
                    "{name}: a travel between the boxes at Z {} lifts {:.3}",
                    t.from_z, t.lift
                ));
            }
        }
        for t in all.iter().filter(|t| t.lift > 0.005) {
            if (t.lift - height).abs() > 0.005 {
                wrong.push(format!(
                    "{name}: a travel at Z {} lifts {:.3}, not {height}",
                    t.from_z, t.lift
                ));
            }
            if straight.is_some_and(|s| s != t.straight) {
                wrong.push(format!(
                    "{name}: a travel at Z {} lifts straight: {}",
                    t.from_z, t.straight
                ));
            }
        }
    }
    // A ramp of height 0 does not lift, though its travels still retract.
    if let Some(t) = travels(&gcode(&lift_project("mk4--isl--FML0")))
        .iter()
        .find(|t| t.lift > 0.005)
    {
        wrong.push(format!(
            "mk4--isl--FML0: a travel at Z {} lifts {:.3}",
            t.from_z, t.lift
        ));
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn sx_project_settings_reads_a_prusaslicer_filaments_lift() {
    // The filament's ramp height, not the printer's (1.5) and not as a slope, as a ramp at the filament's angle, and
    // the printer's lift stays the printer's.
    let config = project_settings(&lift_project("mk4--isl--stock"));
    assert_eq!(config["filament_z_hop"], "0.6");
    assert_eq!(config["filament_z_hop_types"], "Ramp Lift");
    assert_eq!(config["filament_travel_slope"], "1");
    for k in ["z_hop", "z_hop_types", "travel_slope"] {
        assert!(config.get(k).is_none(), "{k}");
    }
    let config = project_settings(&lift_project("mk4--isl--FRAMP0FRL06"));
    assert_eq!(config["filament_z_hop"], "0.6");
    assert_eq!(config["filament_z_hop_types"], "Normal Lift");
}

/// Each travel between two extruding moves on one layer: the layer's Z and the travel's moves as (XY length, Z at the
/// move's end).
fn same_layer_travels(gcode: &str) -> Vec<(f64, Vec<(f64, f64)>)> {
    let (mut at_x, mut at_y, mut at_z, mut at_e) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
    let mut relative = false;
    let mut out = Vec::new();
    let mut last: Option<f64> = None;
    let mut moves: Vec<(f64, f64)> = Vec::new();
    for line in gcode.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        let mut words = code.split_whitespace();
        let Some(cmd) = words.next() else { continue };
        match cmd {
            "M83" => relative = true,
            "M82" => relative = false,
            "G0" | "G1" => {}
            _ => continue,
        }
        let (mut nx, mut ny, mut nz, mut de) = (at_x, at_y, at_z, 0.0_f64);
        for w in words {
            let (axis, v) = w.split_at(1);
            let Ok(v) = v.parse::<f64>() else { continue };
            match axis {
                "X" => nx = v,
                "Y" => ny = v,
                "Z" => nz = v,
                "E" => {
                    de = if relative { v } else { v - at_e };
                    at_e = if relative { at_e + v } else { v };
                }
                _ => {}
            }
        }
        let (dx, dy) = (nx - at_x, ny - at_y);
        let run = (dx * dx + dy * dy).sqrt();
        if de > 0.0 && run > 0.0 {
            if let Some(z) = last
                && (z - nz).abs() < 1e-6
                && !moves.is_empty()
            {
                out.push((z, std::mem::take(&mut moves)));
            }
            moves.clear();
            last = Some(nz);
        } else if last.is_some() {
            moves.push((run, nz));
        }
        (at_x, at_y, at_z) = (nx, ny, nz);
    }
    out
}

#[test]
fn a_prusaslicer_mini_filaments_straight_lift_goes_straight_up_and_down() {
    // mini--isl--FRL06: the filament's retract lift of 0.6 with no ramping of its own, on a MINI with ramping off, so
    // the lift is straight. Every travel between the two boxes on a layer lifts straight up by 0.6 before it moves,
    // travels at that height, and drops straight down to the layer at its end point.
    let project = lift_project("mini--isl--FRL06");
    let config = project_settings(&project);
    assert_eq!(config["filament_z_hop"], "0.6");
    assert_eq!(config["filament_z_hop_types"], "Normal Lift");
    let mut wrong = Vec::new();
    let between: Vec<(f64, Vec<(f64, f64)>)> = same_layer_travels(&gcode(&project))
        .into_iter()
        .filter(|(_, m)| m.iter().map(|&(run, _)| run).sum::<f64>() > 15.0)
        .collect();
    if between.len() != 15 {
        wrong.push(format!("{} travels between the boxes, not 15", between.len()));
    }
    for (z, m) in &between {
        let top = z + 0.6;
        let mut level = *z;
        let changes: Vec<(usize, f64, f64)> = m
            .iter()
            .enumerate()
            .filter_map(|(i, &(run, to))| {
                let from = std::mem::replace(&mut level, to);
                ((to - from).abs() > 1e-6).then_some((i, run, to))
            })
            .collect();
        let ok = matches!(
            changes.as_slice(),
            [(up, rise_run, a), (down, drop_run, b)]
                if *rise_run < 1e-9
                    && *drop_run < 1e-9
                    && (a - top).abs() < 0.005
                    && (b - z).abs() < 1e-6
                    && m[up + 1..*down].iter().map(|&(run, _)| run).sum::<f64>() > 15.0
                    && m[down + 1..].iter().all(|&(run, _)| run < 1e-9)
        );
        if !ok {
            wrong.push(format!(
                "the travel at Z {z} changes Z as (move, XY length, Z) {changes:?}"
            ));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// One first layer move that prints: its feature, its `;WIDTH:`, its ends and points along it (arcs sampled through
/// their centers), and the run of unbroken printing moves of one feature it belongs to.
struct FirstMove {
    kind: String,
    width: f64,
    points: Vec<(f64, f64)>,
    run: usize,
}

/// The printing moves of the first layer, `G2` and `G3` arcs included.
fn first_layer_moves(gcode: &str) -> Vec<FirstMove> {
    let (mut layer, mut kind, mut width) = (0, String::new(), 0.0_f64);
    let (mut x, mut y) = (0.0_f64, 0.0_f64);
    let (mut run, mut printing) = (0, false);
    let mut out = Vec::new();
    for l in gcode.lines() {
        if l == ";LAYER_CHANGE" {
            layer += 1;
            printing = false;
            continue;
        }
        if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
            printing = false;
            continue;
        }
        if let Some(w) = l.strip_prefix(";WIDTH:") {
            width = w.parse().unwrap_or(0.0);
            continue;
        }
        let code = l.split(';').next().unwrap_or("").trim();
        let Some(g) = ["G0 ", "G1 ", "G2 ", "G3 "]
            .iter()
            .position(|p| code.starts_with(p))
        else {
            continue;
        };
        let field = |c: char| {
            code.split_whitespace()
                .skip(1)
                .find_map(|f| f.strip_prefix(c))
                .and_then(|v| v.parse::<f64>().ok())
        };
        let (nx, ny) = (field('X').unwrap_or(x), field('Y').unwrap_or(y));
        let moved = (nx - x).abs() + (ny - y).abs() > 1e-6 || g >= 2;
        let prints = field('E').is_some_and(|e| e > 0.0) && moved;
        if layer == 1 && prints {
            if !printing {
                run += 1;
            }
            let points = if g >= 2 {
                let (cx, cy) = (x + field('I').unwrap_or(0.0), y + field('J').unwrap_or(0.0));
                let r = (x - cx).hypot(y - cy);
                let (a0, a1) = ((y - cy).atan2(x - cx), (ny - cy).atan2(nx - cx));
                let mut d = a1 - a0;
                if g == 2 {
                    while d >= 0.0 {
                        d -= std::f64::consts::TAU;
                    }
                } else {
                    while d <= 0.0 {
                        d += std::f64::consts::TAU;
                    }
                }
                (0..=16)
                    .map(|k| {
                        let a = a0 + d * f64::from(k) / 16.0;
                        (cx + r * a.cos(), cy + r * a.sin())
                    })
                    .collect()
            } else {
                vec![(x, y), (nx, ny)]
            };
            out.push(FirstMove {
                kind: kind.clone(),
                width,
                points,
                run,
            });
        }
        printing = prints;
        (x, y) = (nx, ny);
    }
    out
}

/// The first layer of one side of the plate's `x` (right of it when `right`): each wall feature's `;WIDTH:` values,
/// and how far each wall loop starts in from the outermost one along x, mm.
fn first_layer_walls(gcode: &str, x: f64, right: bool) -> (Vec<(String, f64)>, Vec<f64>) {
    let moves = first_layer_moves(gcode);
    let side = |m: &&FirstMove| {
        let (a, b) = (m.points[0], m.points[m.points.len() - 1]);
        (f64::midpoint(a.0, b.0) > x) == right
    };
    let walls: Vec<&FirstMove> = moves
        .iter()
        .filter(side)
        .filter(|m| m.kind == "Outer wall" || m.kind == "Inner wall")
        .collect();
    let mut widths: Vec<(String, f64)> = Vec::new();
    for m in &walls {
        if !widths
            .iter()
            .any(|(k, w)| *k == m.kind && (w - m.width).abs() < 1e-9)
        {
            widths.push((m.kind.clone(), m.width));
        }
    }
    widths.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let mut starts: Vec<f64> = Vec::new();
    let mut runs: Vec<usize> = walls.iter().map(|m| m.run).collect();
    runs.dedup();
    for r in runs {
        let min = walls
            .iter()
            .filter(|m| m.run == r)
            .flat_map(|m| m.points.iter().map(|p| p.0))
            .fold(f64::INFINITY, f64::min);
        if !starts.iter().any(|s| (s - min).abs() < 1e-3) {
            starts.push(min);
        }
    }
    starts.sort_by(f64::total_cmp);
    let first = starts.first().copied().unwrap_or(0.0);
    (widths, starts.iter().map(|s| s - first).collect())
}

/// The first layer's bottom surface on one side of the plate's `x`: its widest `;WIDTH:` and the spacing of its
/// parallel lines (the median distance between neighbors), mm.
fn first_layer_bottom(gcode: &str, x: f64, right: bool) -> (f64, f64) {
    let moves = first_layer_moves(gcode);
    let lines: Vec<&FirstMove> = moves
        .iter()
        .filter(|m| m.kind == "Bottom surface" && m.points.len() == 2)
        .filter(|m| (f64::midpoint(m.points[0].0, m.points[1].0) > x) == right)
        .filter(|m| (m.points[1].0 - m.points[0].0).hypot(m.points[1].1 - m.points[0].1) > 1.0)
        .collect();
    let width = lines.iter().map(|m| m.width).fold(0.0, f64::max);
    // The lines of the most common direction, by their offsets across it.
    let angle = |m: &&FirstMove| {
        let d = (m.points[1].1 - m.points[0].1).atan2(m.points[1].0 - m.points[0].0);
        (d.to_degrees().rem_euclid(180.0)).round()
    };
    let mut by_angle: Vec<(f64, usize)> = Vec::new();
    for m in &lines {
        let a = angle(m);
        match by_angle.iter_mut().find(|(b, _)| *b == a) {
            Some((_, n)) => *n += 1,
            None => by_angle.push((a, 1)),
        }
    }
    let Some(&(a, _)) = by_angle.iter().max_by_key(|(_, n)| *n) else {
        return (width, 0.0);
    };
    let t = a.to_radians();
    let mut offsets: Vec<f64> = lines
        .iter()
        .filter(|m| angle(m) == a)
        .map(|m| {
            let (mx, my) = (
                f64::midpoint(m.points[0].0, m.points[1].0),
                f64::midpoint(m.points[0].1, m.points[1].1),
            );
            -t.sin() * mx + t.cos() * my
        })
        .collect();
    offsets.sort_by(f64::total_cmp);
    offsets.dedup_by(|a, b| (*a - *b).abs() < 1e-4);
    let mut gaps: Vec<f64> = offsets
        .windows(2)
        .map(|w| w[1] - w[0])
        .filter(|g| *g > 0.05 && *g < 3.0)
        .collect();
    gaps.sort_by(f64::total_cmp);
    (width, gaps.get(gaps.len() / 2).copied().unwrap_or(0.0))
}

/// The spacing of two neighboring beads `w` wide on a layer `h` thick, mm.
fn bead_spacing(w: f64, h: f64) -> f64 {
    w - h * (1.0 - std::f64::consts::FRAC_PI_4)
}

#[test]
fn a_prusaslicer_projects_first_layer_prints_each_features_width_at_the_first_layer_height() {
    // Projects of 0.2 mm first layers and 0.1 mm layers (flw-pct150-flh03: 0.3 and 0.15 mm), first layer width 0 unless
    // named. On the first layer every wall prints its own width with the first layer height in place of the layer
    // height, and its loops lie one bead spacing at that height apart: the auto 0.45 mm walls of a plain object, a
    // part's or an object's 150% as 0.3 mm (150% of the 0.2 mm first layer), a part's 0.55 mm as it is, and a first
    // layer width of 150% of a 0.3 mm first layer as 0.45 mm for every wall.
    let h = 0.2;
    let auto = 0.45;
    let pitch = |outer: f64, inner: f64, h: f64| {
        let (so, si) = (bead_spacing(outer, h), bead_spacing(inner, h));
        vec![0.0, f64::midpoint(so, si), f64::midpoint(so, si) + si]
    };
    let mut wrong = Vec::new();
    for (name, x, right, outer, inner, h) in [
        ("o6.3mf", 102.0, false, auto, auto, h),
        ("o6.3mf", 102.0, true, auto, 0.3, h),
        ("o2.3mf", 102.0, true, auto, 0.3, h),
        ("o23.3mf", 102.0, true, auto, 0.55, h),
        ("vol-pct150-objlh03.3mf", 0.0, true, auto, 0.3, h),
        ("flw-pct150-flh03.3mf", 0.0, true, auto, auto, 0.3),
    ] {
        let (widths, starts) = first_layer_walls(&gcode(&widths(name)), x, right);
        let want = vec![("Inner wall".to_owned(), inner), ("Outer wall".to_owned(), outer)];
        let same = widths.len() == want.len()
            && widths
                .iter()
                .zip(&want)
                .all(|(a, b)| a.0 == b.0 && (a.1 - b.1).abs() < 1e-6);
        if !same {
            wrong.push(format!(
                "{name} {right}: first layer walls {widths:?}, not {want:?}"
            ));
        }
        let at = pitch(outer, inner, h);
        if starts.len() != at.len() || starts.iter().zip(&at).any(|(a, b)| (a - b).abs() > 0.002) {
            wrong.push(format!(
                "{name} {right}: first layer wall loops at {starts:.3?}, not {at:.3?}"
            ));
        }
    }
    // The bottom's lines lie one bead spacing apart for their width at the first layer height.
    for (name, x, right) in [("o6.3mf", 102.0, false), ("o23.3mf", 102.0, true)] {
        let (w, spacing) = first_layer_bottom(&gcode(&widths(name)), x, right);
        if (spacing - bead_spacing(w, h)).abs() > 0.005 {
            wrong.push(format!(
                "{name} {right}: bottom lines {w} wide, {spacing:.4} apart, not {:.4}",
                bead_spacing(w, h)
            ));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn a_prusaslicer_projects_first_layer_skirt_and_support_print_their_own_widths() {
    // The skirt prints the perimeter width on the first layer (150% of the 0.2 mm first layer on r6-pct150), and the
    // first layer's support its own support width: 1.0 times the 0.4 mm nozzle when it is 0, 150% of the first layer
    // height when it is 150%.
    let mut wrong = Vec::new();
    for (name, skirt, support) in [("t3-auto.3mf", "0.45", "0.4"), ("r6-pct150.3mf", "0.3", "0.3")] {
        let moves = first_layer_moves(&gcode(&widths(name)));
        for (kind, want) in [("Skirt", skirt), ("Support", support)] {
            let got: std::collections::BTreeSet<String> = moves
                .iter()
                .filter(|m| m.kind == kind)
                .map(|m| format!("{}", m.width))
                .collect();
            if got.len() != 1 || !got.contains(want) {
                wrong.push(format!("{name}: first layer {kind} {got:?}, not {want}"));
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Each inner wall width printed above the first layer in each band of plate x between `cuts`, moves within 0.3 mm of
/// a cut left out (the walls a region lays along its own edge), by the move's middle; moves right of the last cut
/// count only up to `end`.
fn inner_walls_by_band(gcode: &str, cuts: &[f64], end: f64) -> Vec<std::collections::BTreeSet<String>> {
    let mut out = vec![std::collections::BTreeSet::new(); cuts.len() + 1];
    let (mut layer, mut kind, mut width) = (0, String::new(), String::new());
    let mut at = 0.0_f64;
    for l in gcode.lines() {
        if l == ";LAYER_CHANGE" {
            layer += 1;
        } else if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
        } else if let Some(w) = l.strip_prefix(";WIDTH:") {
            w.clone_into(&mut width);
        } else if ["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|p| l.starts_with(p)) {
            let to = l
                .split(';')
                .next()
                .unwrap_or("")
                .split_whitespace()
                .find_map(|f| f.strip_prefix('X'))
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(at);
            let mid = f64::midpoint(at, to);
            if layer > 1
                && kind == "Inner wall"
                && l.contains(" E")
                && mid < end
                && cuts.iter().all(|c| (mid - c).abs() > 0.3)
            {
                out[cuts.iter().filter(|c| mid > **c).count()].insert(width.clone());
            }
            at = to;
        }
    }
    out
}

/// The extrusion of each feature on the first layer, mm of filament, skirt left out.
fn first_layer_extrusion(gcode: &str) -> std::collections::BTreeMap<String, f64> {
    let mut out = std::collections::BTreeMap::<String, f64>::new();
    let (mut layer, mut kind) = (0, String::new());
    let (mut relative, mut e0) = (true, 0.0_f64);
    for l in gcode.lines() {
        if l == ";LAYER_CHANGE" {
            layer += 1;
            continue;
        }
        if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
            continue;
        }
        let code = l.split(';').next().unwrap_or("").trim();
        let e = code
            .split_whitespace()
            .skip(1)
            .find_map(|f| f.strip_prefix('E'))
            .and_then(|v| v.parse::<f64>().ok());
        if code.starts_with("M82") {
            relative = false;
        } else if code.starts_with("M83") {
            relative = true;
        } else if code.starts_with("G92") {
            if let Some(e) = e {
                e0 = e;
            }
        } else if ["G1 ", "G2 ", "G3 "].iter().any(|p| code.starts_with(p))
            && let Some(e) = e
        {
            let de = if relative { e } else { e - e0 };
            if !relative {
                e0 = e;
            }
            let moves = code.contains(" X") || code.contains(" Y");
            if layer == 1 && de > 0.0 && moves && kind != "Skirt" {
                *out.entry(kind.clone()).or_default() += de;
            }
        }
    }
    out
}

#[test]
fn a_prusa_projects_later_part_owns_where_two_parts_overlap() {
    // One object of two 20 mm boxes in file order, at x 0 to 20 and 15 to 35, overlapping on 15 to 20; one of them
    // sets 0.55 mm inner walls. The later part owns the overlap whether or not it has settings of its own: with the
    // setting on the later part 0.55 prints from x 15 on, and on the earlier part only up to x 15, the later part
    // printing the project's 0.45 mm over the overlap.
    let mut wrong = Vec::new();
    let cut = [115.0];
    for (name, want, bottom, inner) in [
        ("vol-overlap-later-own.3mf", ["0.45", "0.55"], 43.79, 10.39),
        ("vol-overlap-earlier-own.3mf", ["0.55", "0.45"], 43.94, 10.23),
    ] {
        let g = gcode(&widths(name));
        for (band, (got, want)) in inner_walls_by_band(&g, &cut, 200.0).iter().zip(want).enumerate() {
            if got.len() != 1 || !got.contains(want) {
                wrong.push(format!("{name}: band {band} inner walls {got:?}, not {want}"));
            }
        }
        // The first layer's bottom and inner walls cover the parts' areas as split.
        let e = first_layer_extrusion(&g);
        for (kind, want) in [("Bottom surface", bottom), ("Inner wall", inner)] {
            let got = e.get(kind).copied().unwrap_or(0.0);
            if (got - want).abs() > 0.05 {
                wrong.push(format!("{name}: first layer {kind} E {got:.2}, not {want}"));
            }
        }
    }
    // A later part without settings prints with its object's own (0.5 mm), not the project's (0.45 mm): alone, and
    // beside a second object.
    for name in [
        "vol-overlap-earlier-own-obj05.3mf",
        "vol-overlap-earlier-own-obj05-beside.3mf",
    ] {
        let got = inner_walls_by_band(&gcode(&widths(name)), &cut, 136.0);
        for (band, (got, want)) in got.iter().zip(["0.55", "0.5"]).enumerate() {
            if got.len() != 1 || !got.contains(want) {
                wrong.push(format!("{name}: band {band} inner walls {got:?}, not {want}"));
            }
        }
    }
    // A modifier volume still wins over both parts where it reaches: 0.6 mm over x 10 to 25.
    let got = inner_walls_by_band(
        &gcode(&widths("vol-overlap-earlier-own-mod06.3mf")),
        &[110.0, 125.0],
        200.0,
    );
    for (band, (got, want)) in got.iter().zip(["0.55", "0.6", "0.45"]).enumerate() {
        if got.len() != 1 || !got.contains(want) {
            wrong.push(format!("mod06: band {band} inner walls {got:?}, not {want}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// The inner wall moves printed at each layer height (`;Z:`), counted by the band of plate x between `cuts` their
/// middle falls in; moves within 0.3 mm of a cut are left out, and moves right of the last cut count only up to `end`.
fn inner_walls_by_z(gcode: &str, cuts: &[f64], end: f64) -> Vec<(f64, Vec<usize>)> {
    let mut out: Vec<(f64, Vec<usize>)> = Vec::new();
    let mut kind = String::new();
    let mut at = 0.0_f64;
    for l in gcode.lines() {
        if let Some(z) = l.strip_prefix(";Z:").and_then(|z| z.trim().parse::<f64>().ok()) {
            out.push((z, vec![0; cuts.len() + 1]));
        } else if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
        } else if ["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|p| l.starts_with(p)) {
            let to = l
                .split(';')
                .next()
                .unwrap_or("")
                .split_whitespace()
                .find_map(|f| f.strip_prefix('X'))
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(at);
            let mid = f64::midpoint(at, to);
            if kind == "Inner wall"
                && l.contains(" E")
                && mid < end
                && cuts.iter().all(|c| (mid - c).abs() > 0.3)
                && let Some((_, bands)) = out.last_mut()
            {
                bands[cuts.iter().filter(|c| mid > **c).count()] += 1;
            }
            at = to;
        }
    }
    out
}

#[test]
fn a_prusa_projects_later_part_without_settings_takes_a_height_range() {
    // The two boxes of `vol-overlap-earlier-own.3mf`, x 100 to 120 with 0.55 mm inner walls and then x 115 to 135
    // with no settings, and a height range of one wall loop from z 1 to 2 mm (`Metadata/layer_config_ranges.xml`).
    // The later part owns x 115 on with the object's settings and the range's over them, so inside the range it
    // prints no inner walls there; above and below it prints the project's three.
    let layers = inner_walls_by_z(
        &gcode(&widths("vol-overlap-earlier-own-range.3mf")),
        &[115.0],
        136.0,
    );
    let mut wrong = Vec::new();
    let (mut inside, mut outside) = (0, 0);
    for (z, bands) in &layers {
        let later = bands[1];
        if *z > 1.05 && *z < 1.95 {
            inside += 1;
            if later != 0 {
                wrong.push(format!(
                    "z {z}: {later} inner wall moves over the later part inside the range"
                ));
            }
        } else if (*z > 0.25 && *z < 0.95) || (*z > 2.05 && *z < 2.95) {
            outside += 1;
            if later == 0 {
                wrong.push(format!(
                    "z {z}: no inner walls over the later part outside the range"
                ));
            }
        }
    }
    assert!(
        inside > 5 && outside > 5,
        "{inside} layers inside, {outside} outside"
    );
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Each inner wall printed above the first layer in each band of plate x between `cuts`, as its tool and width; moves
/// within 0.3 mm of a cut are left out, and moves right of the last cut count only up to `end`. A width comment can
/// follow the unretract that starts a tool's first move, so only moves in X or Y count.
fn inner_wall_tools_by_band(
    gcode: &str,
    cuts: &[f64],
    end: f64,
) -> Vec<std::collections::BTreeSet<(u32, String)>> {
    let mut out = vec![std::collections::BTreeSet::new(); cuts.len() + 1];
    let (mut layer, mut kind, mut width, mut tool) = (0, String::new(), String::new(), 0_u32);
    let mut at = 0.0_f64;
    for l in gcode.lines() {
        if l == ";LAYER_CHANGE" {
            layer += 1;
        } else if let Some(t) = l
            .strip_prefix('T')
            .and_then(|t| t.split_whitespace().next())
            .and_then(|t| t.parse().ok())
        {
            tool = t;
        } else if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
        } else if let Some(w) = l.strip_prefix(";WIDTH:") {
            w.clone_into(&mut width);
        } else if ["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|p| l.starts_with(p)) {
            let to = l
                .split(';')
                .next()
                .unwrap_or("")
                .split_whitespace()
                .find_map(|f| f.strip_prefix('X'))
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(at);
            let mid = f64::midpoint(at, to);
            if layer > 1
                && kind == "Inner wall"
                && l.contains(" E")
                && (l.contains(" X") || l.contains(" Y"))
                && mid < end
                && cuts.iter().all(|c| (mid - c).abs() > 0.3)
            {
                out[cuts.iter().filter(|c| mid > **c).count()].insert((tool, width.clone()));
            }
            at = to;
        }
    }
    out
}

#[test]
fn a_prusa_projects_later_part_in_another_filament_leaves_the_overlap_as_before() {
    // A guard: it passes before the later-part rule and must keep passing. The two boxes of
    // `vol-overlap-earlier-own.3mf` in two filaments: x 100 to 120 with 0.55 mm inner walls in extruder 2 (T1), then
    // x 115 to 135 with no settings in extruder 1 (T0). The later part takes its overlap only in the earlier part's
    // filament, so here the overlap keeps the higher slot's filament and the earlier part's settings: T1 with 0.55 mm
    // up to x 120, then T0 with the project's 0.45 mm.
    let got = inner_wall_tools_by_band(
        &gcode(&widths("vol-overlap-earlier-own-two.3mf")),
        &[115.0, 120.0],
        136.0,
    );
    let want = [(1, "0.55"), (1, "0.55"), (0, "0.45")];
    let mut wrong = Vec::new();
    for (band, (got, (tool, width))) in got.iter().zip(want).enumerate() {
        if got.len() != 1 || !got.contains(&(tool, width.to_owned())) {
            wrong.push(format!(
                "band {band}: inner walls (tool, width) {got:?}, not T{tool} {width}"
            ));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn a_prusa_projects_later_part_keeps_its_overlap_out_of_another_filaments_region() {
    // A guard: it passes before the later-part rule and must keep passing. The two boxes of
    // `vol-overlap-earlier-own.3mf`, both in extruder 1 (T0): x 100 to 120 with 0.55 mm inner walls, then x 115 to 135
    // with no settings. A third box without settings in extruder 2 (T1) covers x 110 to 126, the overlap included,
    // and the higher slot wins there. The second box takes its overlap from the first only in extruder 1, so inside
    // the third box the first box keeps its settings over its whole footprint: T1 with 0.55 mm up to x 120, overlap
    // included, then T1 with the project's 0.45 mm, then T0 with 0.45 mm.
    let got = inner_wall_tools_by_band(
        &gcode(&widths("vol-overlap-third-filament.3mf")),
        &[110.0, 115.0, 120.0, 126.0],
        136.0,
    );
    let want = [(0, "0.55"), (1, "0.55"), (1, "0.55"), (1, "0.45"), (0, "0.45")];
    let mut wrong = Vec::new();
    for (band, (got, (tool, width))) in got.iter().zip(want).enumerate() {
        if got.len() != 1 || !got.contains(&(tool, width.to_owned())) {
            wrong.push(format!(
                "band {band}: inner walls (tool, width) {got:?}, not T{tool} {width}"
            ));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn a_prusa_projects_later_part_takes_its_overlap_only_from_its_own_object() {
    // A guard: it passes before the later-part rule and must keep passing. Two objects placed overlapping, sliced
    // together: object 1 is a box at x 100 to 120 with 0.55 mm inner walls. Object 2 has a box with 0.5 mm walls at x
    // 155 to 165, then a box without settings at x 115 to 135, over object 1 from x 115 to 120. The later part takes
    // area only from the parts before it in its own object, so object 1's 0.55 mm walls reach x 120, and object 2's
    // plain box prints the project's 0.45 mm beyond.
    let got = inner_walls_by_band(
        &gcode(&widths("vol-overlap-other-object.3mf")),
        &[115.0, 120.0],
        136.0,
    );
    let mut wrong = Vec::new();
    for (band, (got, want)) in got.iter().zip(["0.55", "0.55", "0.45"]).enumerate() {
        if got.len() != 1 || !got.contains(want) {
            wrong.push(format!("band {band} inner walls {got:?}, not {want}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}
