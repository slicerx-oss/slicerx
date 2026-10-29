// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Tool changes a project sets at a height (`Metadata/custom_gcode_per_layer.xml`, type 2). From the first layer
//! whose top reaches the height, the plate prints in the change's filament: one tool change per mark, inside the
//! printer's change G-code (on a Bambu Lab printer `M620 S<n>A` to `M621 S<n>A`), with the prime tower up to the last
//! change when the tower is on. A change applies to a plate that prints one filament, by layer, saved in the
//! one-filament slider mode; otherwise the slice is the same as without it and a note says it was skipped. A change to
//! the filament already printing changes nothing.
//!
//! The projects in tests/fixtures/layer-tool-change are the 20 x 20 x 10 mm box of tests/fixtures/layer-tools (50
//! layers of 0.2 mm, stock A1 and P1S settings, 5 filaments) with tool changes. `cc` is one box on filament 2 with a
//! change at 5.0 mm to filament 4 (`off`: prime tower off), `cc51` the change at 5.1 mm, `cc2` changes at 3.0 mm to
//! filament 4 and at 7.0 mm to filament 1, `ccsame` a change at 5.0 mm to filament 2, `ccmulti` the `cc` change saved
//! in the several-filament mode, `s4x2cc` two boxes on filament 4 with a change at 5.0 mm to filament 2, `twocc` boxes
//! on filaments 2 and 4 with a change at 5.0 mm to filament 4, and `s4byobjcc` two boxes on filament 4 printed by
//! object with a change at 5.0 mm to filament 2.

use std::path::{Path, PathBuf};
use std::process::Command;

fn fixtures(dir: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(dir)
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(case: &str) -> TempDir {
    static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = TempDir(std::env::temp_dir().join(format!("sx-layer-tc-{case}-{}-{n}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    dir
}

/// The G-code of a project's first plate (`dir/case.3mf`) and what `sx slice` wrote to stderr.
fn slice_in(dir: &str, case: &str) -> (String, String) {
    let tmp = temp_dir(case);
    let out = tmp.0.join("out.gcode");
    let o = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(fixtures(dir).join(format!("{case}.3mf")))
        .args(["--plate", "1", "-o"])
        .arg(&out)
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&o.stderr).into_owned();
    assert!(o.status.success(), "{case}: {err}");
    (std::fs::read_to_string(&out).unwrap(), err)
}

fn slice(case: &str) -> String {
    slice_in("layer-tool-change", case).0
}

/// One tool command (`T<n>`, n under 255) between the first layer change and the machine end G-code: its layer
/// (1-based), the `M620 S<n>A` block around it if any, and whether the layer had printed anything yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Select {
    layer: u32,
    tool: u32,
    wrap: Option<u32>,
    first: bool,
}

/// What a G-code prints: the tool commands of the layers, the start's, the object's extrusion (mm of filament) per
/// layer and tool, the layers the prime tower prints on, and the number of `M600` commands.
#[derive(Debug, Default)]
struct Print {
    body: Vec<Select>,
    start: Vec<(u32, Option<u32>)>,
    /// Per layer (index 0 is layer 1), extrusion by tool.
    object: Vec<std::collections::BTreeMap<u32, f64>>,
    tower: Vec<u32>,
    m600: usize,
}

/// The `n` of a line that is `<prefix><n>` and an optional `A` (comments and spaces left out).
fn number_after(line: &str, prefix: &str) -> Option<u32> {
    let code = line.split(';').next().unwrap_or("").trim();
    let rest = code.strip_prefix(prefix)?;
    rest.strip_suffix('A').unwrap_or(rest).parse().ok()
}

fn read(gcode: &str) -> Print {
    let mut p = Print::default();
    let (mut layer, mut end, mut printed) = (0u32, false, false);
    let (mut wrap, mut tool, mut tower) = (None::<u32>, 0u32, false);
    for line in gcode.lines() {
        // A Bambu Lab printer's layer change, or the plain one of a request without a printer profile.
        if line.starts_with("; CHANGE_LAYER") || line.starts_with(";LAYER_CHANGE") {
            layer += 1;
            printed = false;
            tower = false;
            p.object.push(std::collections::BTreeMap::new());
            continue;
        }
        if line.starts_with("; MACHINE_END_GCODE_START") {
            end = true;
        }
        if let Some(f) = line.strip_prefix("; FEATURE: ") {
            tower = f.trim() == "Prime tower";
            continue;
        }
        if let Some(n) = number_after(line, "M620 S") {
            wrap = Some(n);
            continue;
        }
        if number_after(line, "M621 S").is_some() {
            wrap = None;
            continue;
        }
        let code = line.split(';').next().unwrap_or("").trim();
        if code == "M600" {
            p.m600 += 1;
        }
        if let Some(t) = code
            .strip_prefix('T')
            .and_then(|n| n.parse::<u32>().ok())
            .filter(|&t| t < 255)
        {
            if layer == 0 {
                p.start.push((t, wrap));
            } else if !end {
                p.body.push(Select {
                    layer,
                    tool: t,
                    wrap,
                    first: !printed,
                });
            }
            tool = t;
            continue;
        }
        if layer == 0
            || end
            || !(code.starts_with("G1 ") || code.starts_with("G2 ") || code.starts_with("G3 "))
        {
            continue;
        }
        let words: Vec<&str> = code.split_whitespace().collect();
        let e: f64 = words
            .iter()
            .find_map(|w| w.strip_prefix('E').and_then(|v| v.parse().ok()))
            .unwrap_or(0.0);
        if e <= 0.0 {
            continue;
        }
        printed = true;
        if tower {
            if p.tower.last() != Some(&layer) {
                p.tower.push(layer);
            }
        } else if let Some(m) = p.object.last_mut() {
            *m.entry(tool).or_default() += e;
        }
    }
    p
}

/// The layers (1-based) the object prints each tool on, as runs `(first, last)`.
fn runs(p: &Print) -> Vec<(u32, u32, u32)> {
    let mut out: Vec<(u32, u32, u32)> = Vec::new();
    for (i, m) in p.object.iter().enumerate() {
        let l = u32::try_from(i).unwrap() + 1;
        for (&t, &e) in m {
            if e <= 0.01 {
                continue;
            }
            match out.iter_mut().find(|r| r.0 == t && r.2 + 1 == l) {
                Some(r) => r.2 = l,
                None => out.push((t, l, l)),
            }
        }
    }
    out.sort_by_key(|r| (r.1, r.0));
    out
}

/// The object's extrusion per tool, mm, to 0.1 mm.
fn per_tool(p: &Print) -> Vec<(u32, String)> {
    let mut all: std::collections::BTreeMap<u32, f64> = std::collections::BTreeMap::new();
    for m in &p.object {
        for (&t, &e) in m {
            *all.entry(t).or_default() += e;
        }
    }
    all.into_iter().map(|(t, e)| (t, format!("{e:.1}"))).collect()
}

/// Layers `a` to `b` as a list.
fn layers(a: u32, b: u32) -> Vec<u32> {
    (a..=b).collect()
}

/// The tool commands of the layers as (layer, tool, M620 block).
fn changes(p: &Print) -> Vec<(u32, u32, Option<u32>)> {
    p.body.iter().map(|s| (s.layer, s.tool, s.wrap)).collect()
}

#[test]
fn a_change_with_the_tower_happens_once_on_its_layer_inside_the_change_gcode() {
    for case in ["a1-cc", "p1s-cc"] {
        let p = read(&slice(case));
        assert_eq!(p.start, vec![(1, Some(1))], "{case}: start");
        assert_eq!(changes(&p), vec![(25, 3, Some(3))], "{case}");
        assert_eq!(runs(&p), vec![(1, 1, 24), (3, 25, 50)], "{case}: object by tool");
        assert_eq!(p.tower, layers(1, 25), "{case}: tower layers");
        assert_eq!(p.m600, 0, "{case}");
    }
}

#[test]
fn a_change_without_the_tower_starts_its_layer_and_prints_the_same_object() {
    for (case, on) in [("a1-ccoff", "a1-cc"), ("p1s-ccoff", "p1s-cc")] {
        let p = read(&slice(case));
        assert_eq!(p.start, vec![(1, Some(1))], "{case}: start");
        assert_eq!(changes(&p), vec![(25, 3, Some(3))], "{case}");
        assert!(
            p.body[0].first,
            "{case}: the change comes before the layer prints"
        );
        assert_eq!(runs(&p), vec![(1, 1, 24), (3, 25, 50)], "{case}: object by tool");
        assert!(p.tower.is_empty(), "{case}: tower layers {:?}", p.tower);
        assert_eq!(
            per_tool(&p),
            per_tool(&read(&slice(on))),
            "{case}: object extrusion by tool"
        );
    }
}

#[test]
fn a_change_between_layer_tops_happens_on_the_layer_above_it() {
    let p = read(&slice("a1-cc51"));
    assert_eq!(changes(&p), vec![(26, 3, Some(3))]);
    assert_eq!(runs(&p), vec![(1, 1, 25), (3, 26, 50)]);
    assert_eq!(p.tower, layers(1, 26));
}

#[test]
fn two_changes_happen_in_height_order() {
    let p = read(&slice("a1-cc2"));
    assert_eq!(changes(&p), vec![(15, 3, Some(3)), (35, 0, Some(0))]);
    assert_eq!(runs(&p), vec![(1, 1, 14), (3, 15, 34), (0, 35, 50)]);
    assert_eq!(p.tower, layers(1, 35));
}

#[test]
fn every_object_of_the_plate_changes_together() {
    let p = read(&slice("a1-s4x2cc"));
    assert_eq!(p.start, vec![(3, Some(3))]);
    assert_eq!(changes(&p), vec![(25, 1, Some(1))]);
    assert_eq!(runs(&p), vec![(3, 1, 24), (1, 25, 50)]);
    assert_eq!(p.tower, layers(1, 25));
}

#[test]
fn a_change_to_the_filament_already_printing_changes_nothing() {
    let (with, err) = slice_in("layer-tool-change", "a1-ccsame");
    assert!(
        with == slice_in("layer-tools", "a1-s2").0,
        "the G-code differs from the plate without it"
    );
    assert!(!err.contains("Tool change"), "{err}");
}

/// A change that does not apply leaves the G-code as without it and says why, once, on stderr.
fn skipped(case: &str, without: &str, why: &str) {
    let (with, err) = slice_in("layer-tool-change", case);
    assert!(
        with == slice_in("layer-tools", without).0,
        "{case}: the G-code differs from {without}"
    );
    let notes: Vec<&str> = err.lines().filter(|l| l.contains("Tool change")).collect();
    assert_eq!(notes, vec![format!("warning: {why}").as_str()], "{case}");
}

#[test]
fn a_change_on_a_plate_of_two_filaments_is_skipped_with_a_note() {
    skipped(
        "a1-twocc",
        "a1-two",
        "Tool change at 5 mm to filament 4 skipped: the plate already prints 2 filaments.",
    );
}

#[test]
fn a_change_saved_in_the_several_filament_mode_is_skipped_with_a_note() {
    skipped(
        "a1-ccmulti",
        "a1-s2",
        "Tool change at 5 mm to filament 4 skipped: the project saved it for a plate that prints several filaments.",
    );
}

#[test]
fn a_change_on_a_plate_printed_by_object_is_skipped_with_a_note() {
    skipped(
        "a1-s4byobjcc",
        "a1-s4byobj",
        "Tool change at 5 mm to filament 2 skipped: the plate prints object by object.",
    );
}

/// `sx slice --request` with `json` as the request: the result and the G-code.
fn request(name: &str, json: &serde_json::Value) -> (serde_json::Value, String) {
    let dir = temp_dir(name);
    let file = dir.0.join("request.json");
    std::fs::write(&file, json.to_string()).unwrap();
    let out = dir.0.join("out");
    let o = Command::new(env!("CARGO_BIN_EXE_sx"))
        .args(["slice", "--request"])
        .arg(&file)
        .arg("--out-dir")
        .arg(&out)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "{name}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    (result, std::fs::read_to_string(out.join("slice.gcode")).unwrap())
}

/// The result's warnings with their codes.
fn warnings(result: &serde_json::Value) -> Vec<(String, String)> {
    result["warnings"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| {
            (
                w["code"].as_str().unwrap_or_default().to_owned(),
                w["message"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .filter(|(c, _)| c == "tool_change_skipped")
        .collect()
}

#[test]
fn a_request_takes_a_project_plates_tool_changes_and_notes() {
    let project = |case: &str| {
        serde_json::json!({
            "schemaVersion": 1,
            "meshes": {"m": format!("{}#1", fixtures("layer-tool-change").join(format!("{case}.3mf")).display())},
            "plate": {"objects": [{"id": "m", "mesh": "m"}]},
            "options": {"emitGcode": true},
        })
    };
    // Without the printer's start G-code the first layer selects the plate's filament itself.
    let (result, gcode) = request("project", &project("a1-cc"));
    assert_eq!(changes(&read(&gcode)), vec![(1, 1, None), (25, 3, None)]);
    assert_eq!(result["stats"]["toolChanges"], 1);
    assert!(warnings(&result).is_empty());
    let (result, gcode) = request("project-two", &project("a1-twocc"));
    let (_, without) = request("project-two-without", &{
        let mut r = project("a1-twocc");
        r["meshes"]["m"] = format!("{}#1", fixtures("layer-tools").join("a1-two.3mf").display()).into();
        r
    });
    assert_eq!(changes(&read(&gcode)), changes(&read(&without)));
    assert_eq!(
        warnings(&result),
        vec![(
            "tool_change_skipped".to_owned(),
            "Tool change at 5 mm to filament 4 skipped: the plate already prints 2 filaments.".to_owned()
        )]
    );
}

#[test]
fn a_request_changes_tools_by_height_or_layer() {
    let req = |changes: serde_json::Value| {
        serde_json::json!({
            "schemaVersion": 1,
            "meshes": {"m": format!("{}#1", fixtures("layer-tools").join("p1s-s4.3mf").display())},
            "plate": {"objects": [{"id": "m", "mesh": "m", "settings": {"extruder": 4}}]},
            "config": {
                "printer_model": "Bambu Lab P1S",
                "filament_colour": ["#FFFFFF", "#FF0000", "#00A0FF", "#202020", "#F0C000"],
                "enable_prime_tower": "0",
                "layer_height": "0.2",
                "initial_layer_print_height": "0.2",
            },
            "options": {"emitGcode": true, "toolChanges": changes},
        })
    };
    // At 2.1 mm (layer 11 has its top at 2.2 mm), then on layer 31 (0-based 30) back, and a change above the print.
    let (result, gcode) = request(
        "request",
        &req(serde_json::json!([
            {"zMm": 2.1, "filament": 2},
            {"layer": 30, "filament": 4},
            {"zMm": 40, "filament": 1},
        ])),
    );
    let p = read(&gcode);
    assert_eq!(runs(&p), vec![(3, 1, 10), (1, 11, 30), (3, 31, 50)]);
    assert_eq!(
        p.body
            .iter()
            .filter(|s| s.layer > 1)
            .map(|s| (s.layer, s.tool))
            .collect::<Vec<_>>(),
        vec![(11, 1), (31, 3)]
    );
    assert_eq!(
        warnings(&result),
        vec![(
            "tool_change_skipped".to_owned(),
            "Tool change at 40 mm to filament 1 skipped: it is above the top of the print.".to_owned()
        )]
    );
    // A change that names no filament there is refused.
    let dir = temp_dir("bad");
    let file = dir.0.join("request.json");
    std::fs::write(
        &file,
        req(serde_json::json!([{"zMm": 2.0, "filament": 0}])).to_string(),
    )
    .unwrap();
    let o = Command::new(env!("CARGO_BIN_EXE_sx"))
        .args(["slice", "--request"])
        .arg(&file)
        .output()
        .unwrap();
    assert!(!o.status.success());
    assert!(
        String::from_utf8_lossy(&o.stderr).contains("needs a filament from 1 to 64"),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
}
