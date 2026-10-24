// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The printer's keep-out zones, `bed_exclude_area` and the nozzle wrap check corner (`head_wrap_detect_zone`),
//! are kept clear by the same rules: the brim is cut to the bed less both, and a skirt that runs into either is
//! refused.

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

/// The A1's or the P1S's settings from the request fixtures, with no tower, brim or skirt, and `extra` on top.
fn config(printer: &str, extra: &Value) -> Value {
    let file = match printer {
        "a1" => "xmark-2color-a1-request.json",
        _ => "xmark-p1s-request.json",
    };
    let req: Value = serde_json::from_str(&std::fs::read_to_string(fixture(file)).unwrap()).unwrap();
    let mut c = req["config"].clone();
    for (k, v) in [
        ("enable_prime_tower", json!(false)),
        ("brim_type", json!("no_brim")),
        ("brim_width", json!(0)),
        ("skirt_loops", json!(0)),
    ] {
        c[k] = v;
    }
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    c
}

/// Slices 20 x 20 x 10 mm cubes with their front left corners at `at` on `config`, and gives the run and the G-code.
fn slice(name: &str, config: &Value, at: &[[f64; 2]], args: &[&str]) -> (Output, String) {
    let objects: Vec<Value> = at
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let name = if i == 0 { "Near" } else { "Far" };
            json!({
                "id": format!("o{i}"),
                "name": name,
                "mesh": "c",
                "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], 0, 1],
            })
        })
        .collect();
    let req = json!({
        "schemaVersion": 1,
        "meshes": {"c": fixture("cube.stl")},
        "plate": {"bed": {"widthMm": 256, "depthMm": 256, "heightMm": 250}, "objects": objects},
        "config": config,
        "options": {"emitGcode": true, "emitPreview": false, "trustedGcode": true},
    });
    let dir = TempDir(std::env::temp_dir().join(format!("sx-keep-out-{name}-{}", std::process::id())));
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

/// The extruding moves of `feature` in the G-code, X and Y.
fn moves(gcode: &str, feature: &str) -> Vec<[f64; 2]> {
    let mut on = false;
    let mut out = Vec::new();
    for line in gcode.lines() {
        if let Some(f) = line.strip_prefix("; FEATURE: ") {
            on = f.trim() == feature;
            continue;
        }
        if !on || !line.starts_with("G1 ") {
            continue;
        }
        let word = |c: char| {
            line.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        if let (Some(x), Some(y), Some(e)) = (word('X'), word('Y'), word('E'))
            && e > 0.0
        {
            out.push([x, y]);
        }
    }
    out
}

/// The A1's nozzle wrap check corner: x 226 to 256, y 224 to 256.
fn in_a1_corner(p: [f64; 2]) -> bool {
    p[0] > 226.05 && p[1] > 224.05
}

const SKIRT: &str = r#"{"skirt_loops": 2, "skirt_distance": 3, "skirt_height": 1}"#;

#[test]
fn a_skirt_in_the_a1_wrap_check_corner_is_refused() {
    // The cube 0.1 mm into the corner: its walls stay inside their outline, its skirt runs 3.7 mm into the corner.
    let c = config("a1", &serde_json::from_str(SKIRT).unwrap());
    for args in [&[][..], &["--allow-collisions"][..]] {
        let (out, _) = slice("skirt", &c, &[[206.1, 230.0]], args);
        let err = stderr(&out);
        assert_eq!(out.status.code(), Some(1), "{err}");
        assert!(
            err.contains(
                "toolpaths enter an excluded bed area (the nozzle wrap check corner) from layer 1 (X226.1 Y226.4, skirt nearest \"Near\"), 28 moves in layer 1; move \"Near\" out of it or arrange the plate"
            ),
            "{err}"
        );
    }
    // 5 mm clear, the skirt's 3.6 mm reach fits.
    let (out, gcode) = slice("skirt-clear", &c, &[[201.0, 230.0]], &[]);
    assert!(out.status.success(), "{}", stderr(&out));
    let skirt = moves(&gcode, "Skirt");
    assert!(!skirt.is_empty() && !skirt.iter().any(|p| in_a1_corner(*p)));
}

#[test]
fn a_plate_skirt_round_two_parts_beside_the_a1_corner_is_refused() {
    // One cube 10 mm left of the corner, one 10 mm in front of it: the skirt round both cuts across the corner. Moving
    // either cube alone toward the open bed does not help, so the refusal says what does.
    let at = [[196.0, 230.0], [230.0, 194.0]];
    let c = config("a1", &serde_json::from_str(SKIRT).unwrap());
    let (out, _) = slice("flank", &c, &at, &[]);
    let err = stderr(&out);
    assert_eq!(out.status.code(), Some(1), "{err}");
    assert!(
        err.contains("toolpaths enter an excluded bed area (the nozzle wrap check corner) from layer 1"),
        "{err}"
    );
    assert!(
        err.contains(
            "; the skirt round the whole plate runs into it between \"Near\" and \"Far\": move them apart or give each part a skirt of its own"
        ) || err.contains(
            "; the skirt round the whole plate runs into it between \"Far\" and \"Near\": move them apart or give each part a skirt of its own"
        ),
        "{err}"
    );
    // A skirt of each part's own stays clear of it.
    let mut own = c;
    own["skirt_type"] = json!("perobject");
    let (out, gcode) = slice("flank-own", &own, &at, &[]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert!(!moves(&gcode, "Skirt").iter().any(|p| in_a1_corner(*p)));
}

#[test]
fn a_plate_skirt_round_two_parts_beside_the_p1s_corner_names_both() {
    // The same on the P1S's excluded corner: cubes 12 mm right of it and 12 mm behind it.
    let c = config("p1s", &serde_json::from_str(SKIRT).unwrap());
    let (out, _) = slice("flank-p1s", &c, &[[30.0, 4.0], [4.0, 40.0]], &[]);
    let err = stderr(&out);
    assert_eq!(out.status.code(), Some(1), "{err}");
    assert!(
        err.contains("toolpaths enter an excluded bed area from layer 1"),
        "{err}"
    );
    assert!(
        err.contains("the skirt round the whole plate runs into it between")
            && err.contains("move them apart"),
        "{err}"
    );
}

#[test]
fn a_plate_skirt_at_one_parts_own_reach_names_that_part() {
    // A cube in the A1 corner and one in the middle: the skirt round both enters the corner round the near cube, so
    // moving that cube clears it.
    let c = config("a1", &serde_json::from_str(SKIRT).unwrap());
    let (out, _) = slice("near-mid", &c, &[[206.1, 230.0], [118.0, 118.0]], &[]);
    let err = stderr(&out);
    assert_eq!(out.status.code(), Some(1), "{err}");
    assert!(
        err.contains("skirt nearest \"Near\")")
            && err.contains("; move \"Near\" out of it or arrange the plate"),
        "{err}"
    );
    assert!(!err.contains("skirt round the whole plate"), "{err}");
}

#[test]
fn a_brim_at_the_a1_wrap_check_corner_is_cut_to_it() {
    // The cube right at the corner with a 5 mm brim: the brim is cut where the corner starts, as at an excluded area.
    let c = config("a1", &json!({"brim_type": "outer_only", "brim_width": 5}));
    for (name, at) in [("brim-x", [206.0, 230.0]), ("brim-y", [230.0, 204.0])] {
        let (out, gcode) = slice(name, &c, &[at], &[]);
        assert!(out.status.success(), "{}", stderr(&out));
        let brim = moves(&gcode, "Brim");
        assert!(!brim.is_empty(), "{name}: a brim");
        assert!(
            !brim.iter().any(|p| in_a1_corner(*p)),
            "{name}: brim in the corner"
        );
        // the brim was cut: it reaches up to the corner's edge, half a line short of it
        let near = brim
            .iter()
            .map(|p| if at[0] < 220.0 { 226.0 - p[0] } else { 224.0 - p[1] })
            .filter(|d| *d >= 0.0)
            .fold(f64::MAX, f64::min);
        assert!(near < 0.5, "{name}: brim {near} mm from the corner");
    }
}

#[test]
fn a_p1s_plate_at_its_excluded_corner_prints_as_before() {
    // The P1S's excluded corner was already kept clear this way: a cube right beside it, its brim cut to the corner,
    // prints the same bytes. A change that alters them updates the hash and says why. Changed when bridge strands on
    // Bambu Lab printers spread evenly: the cube's first solid layer over sparse infill is a bridge.
    let c = config("p1s", &json!({"brim_type": "outer_only", "brim_width": 5}));
    let (out, gcode) = slice("p1s", &c, &[[18.0, 6.0], [140.0, 140.0]], &[]);
    assert!(out.status.success(), "{}", stderr(&out));
    let version = env!("CARGO_PKG_VERSION");
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for line in gcode.lines().filter(|l| !l.contains(version)) {
        for b in line.bytes().chain(std::iter::once(b'\n')) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    assert_eq!(
        format!("{h:016x}"),
        "c517221aadd15b2c",
        "the P1S plate's G-code changed"
    );
}
