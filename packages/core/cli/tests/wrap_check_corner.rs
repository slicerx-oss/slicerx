// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A plate in the A1's nozzle wrap check corner (`head_wrap_detect_zone`, x 226 to 256, y 224 to 256) slices. The
//! printer skips its check there: the stock layer template leaves its mass check block out
//! (`{if !in_head_wrap_detect_zone}`) on every layer of such a plate, and keeps it on every layer of a plate outside
//! the corner. Nozzle wrap detection on or off changes neither.

#![allow(clippy::disallowed_methods, reason = "test geometry, not engine output")]

use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::{Command, Output};

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

/// The A1's settings from the request fixtures, its stock layer template included, with no prime tower, brim or
/// variable layer heights and nozzle wrap detection on or off. The brim and the skirt at the corner keep rules of
/// their own (`keep_out_zones.rs`).
fn a1(detection: bool) -> Value {
    let req: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("xmark-2color-a1-request.json")).unwrap())
            .unwrap();
    let mut c = req["config"].clone();
    c["enable_prime_tower"] = json!(false);
    c["brim_type"] = json!("no_brim");
    c["skirt_loops"] = json!(0);
    // plain 0.2 mm layers: 50 of them on the 10 mm box
    c["smart_layer"] = json!("off");
    c["enable_wrapping_detection"] = json!(detection);
    c
}

/// The 20 x 20 x 10 mm box centered on (240, 240), in the corner.
const CORNER: [f64; 2] = [230.0, 230.0];
/// The same box centered on the bed.
const CENTER: [f64; 2] = [118.0, 118.0];

/// Slices the box with its front left corner at `at` on `config`, and gives the run and the G-code.
fn slice(name: &str, config: &Value, at: [f64; 2], args: &[&str]) -> (Output, String) {
    let req = json!({
        "schemaVersion": 1,
        "meshes": {"c": fixture("cube.stl")},
        "plate": {"bed": {"widthMm": 256, "depthMm": 256, "heightMm": 250}, "objects": [{
            "id": "o0",
            "name": "Box",
            "mesh": "c",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], 0, 1],
        }]},
        "config": config,
        "options": {"emitGcode": true, "emitPreview": false, "trustedGcode": true},
    });
    let dir = TempDir(std::env::temp_dir().join(format!("sx-wrap-corner-{name}-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let path = dir.0.join("request.json");
    std::fs::write(&path, req.to_string()).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_sx"))
        .args(["slice", "--request"])
        .arg(&path)
        .arg("--out-dir")
        .arg(&dir.0)
        .args(args)
        .output()
        .unwrap();
    let gcode = std::fs::read_to_string(dir.0.join("slice.gcode")).unwrap_or_default();
    (out, gcode)
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// What the layer template wrote: the layers, then per layer block the lines of it, comments aside.
#[derive(Debug, PartialEq)]
struct Blocks {
    layers: usize,
    /// `M1002 judge_flag g39_mass_exceed_flag`, the mass check block's own flag.
    mass_check: usize,
    /// `G39.3 S1`, the mass check itself (from the fourth layer).
    mass_probe: usize,
    /// `M1002 judge_flag g39_detection_flag`, the block round it.
    detection: usize,
    /// `M1002 judge_flag g39_3rd_layer_detect_flag`, the outer block.
    third_layer: usize,
    /// `G39 S1`, the clog check on the third layer.
    clog_probe: usize,
}

fn blocks(gcode: &str) -> Blocks {
    let count = |line: &str| {
        gcode
            .lines()
            .filter(|l| l.split(';').next().unwrap_or("").trim() == line)
            .count()
    };
    Blocks {
        layers: gcode.lines().filter(|l| l.starts_with("; CHANGE_LAYER")).count(),
        mass_check: count("M1002 judge_flag g39_mass_exceed_flag"),
        mass_probe: count("G39.3 S1"),
        detection: count("M1002 judge_flag g39_detection_flag"),
        third_layer: count("M1002 judge_flag g39_3rd_layer_detect_flag"),
        clog_probe: count("G39 S1"),
    }
}

/// The lines that move Z (the layer changes and the travel lifts) and the retractions, the template's own aside:
/// equal on two plates that differ only in where the box stands.
fn lifts_and_retractions(gcode: &str) -> (usize, usize) {
    let code = |l: &str| l.split(';').next().unwrap_or("").trim().to_owned();
    let words = |l: &str| code(l).split_whitespace().map(str::to_owned).collect::<Vec<_>>();
    let lifts = gcode
        .lines()
        .filter(|l| {
            let w = words(l);
            matches!(w.first().map(String::as_str), Some("G1" | "G2" | "G3"))
                && w.iter().any(|x| x.starts_with('Z'))
        })
        .count();
    let retracts = gcode
        .lines()
        .filter(|l| {
            let w = words(l);
            w.first().map(String::as_str) == Some("G1")
                && w.iter().any(|x| x.starts_with("E-"))
                && !w.iter().any(|x| x.starts_with('X') || x.starts_with('Y'))
        })
        .count();
    (lifts, retracts)
}

/// The engine's flag for the template, `in_head_wrap_detect_zone`, read off the G-code: true on the corner plate,
/// whose every layer leaves the mass check block out and keeps the blocks round it, false on the center plate, whose
/// every layer has it, with the mass check itself from the fourth layer. Sliced with `--allow-collisions`, as a plate
/// in the corner was once refused.
#[test]
fn the_mass_check_is_left_out_on_every_layer_of_a_plate_in_the_corner() {
    for detection in [false, true] {
        let c = a1(detection);
        let (out, gcode) = slice("flag-corner", &c, CORNER, &["--allow-collisions"]);
        assert!(out.status.success(), "{detection}: {}", stderr(&out));
        assert_eq!(
            blocks(&gcode),
            Blocks {
                layers: 50,
                mass_check: 0,
                mass_probe: 0,
                detection: 50,
                third_layer: 50,
                clog_probe: 1,
            },
            "corner, detection {detection}"
        );
        let (out, gcode) = slice("flag-center", &c, CENTER, &[]);
        assert!(out.status.success(), "{detection}: {}", stderr(&out));
        assert_eq!(
            blocks(&gcode),
            Blocks {
                layers: 50,
                mass_check: 50,
                mass_probe: 47,
                detection: 50,
                third_layer: 50,
                clog_probe: 1,
            },
            "center, detection {detection}"
        );
    }
}

/// The corner plate slices as it stands, wrap detection on or off: no refusal, no collision with the corner and no
/// words about it, and its G-code moves Z and retracts as the center plate's does, so its travels are not lifted
/// over the corner it stands in.
#[test]
fn a_plate_in_the_corner_slices_with_detection_on_and_off() {
    for detection in [false, true] {
        let c = a1(detection);
        let (out, gcode) = slice("corner", &c, CORNER, &[]);
        let err = stderr(&out);
        assert!(out.status.success(), "{detection}: {err}");
        assert!(!err.contains("wrap check corner"), "{detection}: {err}");
        let report: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(
            !report["collisions"]
                .as_array()
                .is_some_and(|c| c.iter().any(|c| c["hitId"] == "wrap-check-zone")),
            "{detection}: {}",
            report["collisions"]
        );
        let words = report.to_string();
        assert!(!words.contains("wrap check corner"), "{detection}: {words}");
        assert_eq!(blocks(&gcode).mass_check, 0, "{detection}");
        let (_, center) = slice("center", &c, CENTER, &[]);
        assert_eq!(
            lifts_and_retractions(&gcode),
            lifts_and_retractions(&center),
            "{detection}: the corner plate moves Z or retracts where the center plate does not"
        );
    }
}

/// The extruding moves of the skirt, from where each starts to where it ends (X and Y).
fn skirt_moves(gcode: &str) -> Vec<([f64; 2], [f64; 2])> {
    let (mut on, mut at) = (false, [0.0, 0.0]);
    let mut out = Vec::new();
    for line in gcode.lines() {
        if let Some(f) = line.strip_prefix("; FEATURE: ") {
            on = f.trim() == "Skirt";
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        if !(code.starts_with("G1 ") || code.starts_with("G0 ")) {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        let to = [word('X').unwrap_or(at[0]), word('Y').unwrap_or(at[1])];
        if on && word('E').is_some_and(|e| e > 0.0) && (word('X').is_some() || word('Y').is_some()) {
            out.push((at, to));
        }
        at = to;
    }
    out
}

/// A skirt round a plate wholly in the corner prints whole, inside the corner, as it would anywhere else on the bed:
/// the printer skips its check there, so the corner is not kept clear of it. One loop, as long as the center plate's.
/// A part only partly in the corner keeps its skirt cut at it (`keep_out_zones.rs`).
#[test]
fn a_skirt_round_a_plate_in_the_corner_prints_one_whole_loop() {
    let mut c = a1(false);
    c["skirt_loops"] = json!(1);
    c["skirt_height"] = json!(1);
    let length = |m: &[([f64; 2], [f64; 2])]| {
        m.iter()
            .map(|(a, b)| (b[0] - a[0]).hypot(b[1] - a[1]))
            .sum::<f64>()
    };
    let (out, center) = slice("skirt-center", &c, CENTER, &[]);
    assert!(out.status.success(), "{}", stderr(&out));
    let (out, corner) = slice("skirt-corner", &c, CORNER, &[]);
    assert!(out.status.success(), "{}", stderr(&out));
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(
        !report["warnings"].to_string().contains("skirt"),
        "{}",
        report["warnings"]
    );
    let (here, there) = (skirt_moves(&corner), skirt_moves(&center));
    assert!(!here.is_empty(), "a skirt");
    assert!(
        here.iter()
            .all(|(a, b)| [a, b].iter().all(|p| p[0] > 226.0 && p[1] > 224.0)),
        "the skirt runs in the corner, round the box: {here:?}"
    );
    assert!(
        (length(&here) - length(&there)).abs() < 0.05,
        "corner skirt {} mm, center skirt {} mm",
        length(&here),
        length(&there)
    );
}
