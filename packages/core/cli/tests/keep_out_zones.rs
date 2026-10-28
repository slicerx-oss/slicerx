// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The printer's keep-out zones, `bed_exclude_area` and the nozzle wrap check corner (`head_wrap_detect_zone`),
//! are kept clear by the same rules: the brim and the skirt are cut to the bed less both, and a cut skirt is noted.

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

/// The slice report's warnings.
fn warnings(out: &Output) -> Vec<String> {
    let report: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    report["warnings"]
        .as_array()
        .map(|w| {
            w.iter()
                .filter_map(|w| w["message"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The note for a skirt cut beside one of `names`.
fn skirt_noted(out: &Output, names: &[&str]) -> bool {
    warnings(out).iter().any(|w| {
        names
            .iter()
            .any(|n| *w == format!("The skirt near \"{n}\" was cut to fit on the bed"))
    })
}

#[test]
fn a_skirt_at_the_a1_wrap_check_corner_is_cut_out_of_it() {
    // The cube 0.1 mm into the corner: its walls stay inside their outline, its skirt would run 3.7 mm into the
    // corner. It is cut where the corner starts, and the slice says so.
    let c = config("a1", &serde_json::from_str(SKIRT).unwrap());
    for args in [&[][..], &["--allow-collisions"][..]] {
        let (out, gcode) = slice("skirt", &c, &[[206.1, 230.0]], args);
        assert!(out.status.success(), "{}", stderr(&out));
        let skirt = moves(&gcode, "Skirt");
        assert!(!skirt.is_empty(), "a skirt");
        assert!(!skirt.iter().any(|p| in_a1_corner(*p)), "skirt in the corner");
        assert!(skirt_noted(&out, &["Near"]), "{:?}", warnings(&out));
    }
    // 5 mm clear, the skirt's 3.6 mm reach fits: whole, and no note.
    let (out, gcode) = slice("skirt-clear", &c, &[[201.0, 230.0]], &[]);
    assert!(out.status.success(), "{}", stderr(&out));
    let skirt = moves(&gcode, "Skirt");
    assert!(!skirt.is_empty() && !skirt.iter().any(|p| in_a1_corner(*p)));
    assert!(
        !warnings(&out).iter().any(|w| w.contains("skirt")),
        "{:?}",
        warnings(&out)
    );
}

#[test]
fn a_plate_skirt_round_two_parts_beside_the_a1_corner_is_cut_out_of_it() {
    // One cube 10 mm left of the corner, one 10 mm in front of it: the skirt round both would cut across the corner.
    let at = [[196.0, 230.0], [230.0, 194.0]];
    let c = config("a1", &serde_json::from_str(SKIRT).unwrap());
    let (out, gcode) = slice("flank", &c, &at, &[]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert!(!moves(&gcode, "Skirt").iter().any(|p| in_a1_corner(*p)));
    assert!(skirt_noted(&out, &["Near", "Far"]), "{:?}", warnings(&out));
    // A skirt of each part's own stays clear of it.
    let mut own = c;
    own["skirt_type"] = json!("perobject");
    let (out, gcode) = slice("flank-own", &own, &at, &[]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert!(!moves(&gcode, "Skirt").iter().any(|p| in_a1_corner(*p)));
    assert!(
        !warnings(&out).iter().any(|w| w.contains("skirt")),
        "{:?}",
        warnings(&out)
    );
}

#[test]
fn a_plate_skirt_round_two_parts_beside_the_p1s_corner_is_cut_out_of_it() {
    // The same on the P1S's excluded corner: cubes 12 mm right of it and 12 mm behind it. The P1S writes its G-code
    // 2 mm in front of the plate (`extruder_offset`).
    let c = config("p1s", &serde_json::from_str(SKIRT).unwrap());
    let (out, gcode) = slice("flank-p1s", &c, &[[30.0, 4.0], [4.0, 40.0]], &[]);
    assert!(out.status.success(), "{}", stderr(&out));
    let skirt = moves(&gcode, "Skirt");
    assert!(!skirt.is_empty(), "a skirt");
    assert!(
        !skirt.iter().any(|p| p[0] < 17.95 && p[1] + 2.0 < 27.95),
        "skirt in the excluded corner"
    );
    assert!(skirt_noted(&out, &["Near", "Far"]), "{:?}", warnings(&out));
}

#[test]
fn a_plate_skirt_cut_at_one_parts_own_reach_names_that_part() {
    // A cube in the A1 corner and one in the middle: the skirt round both is cut at the corner round the near cube.
    let c = config("a1", &serde_json::from_str(SKIRT).unwrap());
    let (out, gcode) = slice("near-mid", &c, &[[206.1, 230.0], [118.0, 118.0]], &[]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert!(!moves(&gcode, "Skirt").iter().any(|p| in_a1_corner(*p)));
    assert!(skirt_noted(&out, &["Near"]), "{:?}", warnings(&out));
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
    // Bambu Lab printers spread evenly: the cube's first solid layer over sparse infill is a bridge. Changed again when
    // every wipe ran at the layer's acceleration: the travel line after a wipe goes when it equals the wipe's. Changed
    // again when the floating vertical shell's beads started at the inner wall's spacing edge: only those beads, the
    // travels into them, the progress lines and the filament total moved.
    // Changed again when the objects of each layer printed in one order set by position: the far cube now prints first on
    // every layer, so only the travels, wipes, progress lines and time moved, and no extruding move did.
    // Changed again when each object's brim printed right before the object: the near cube's brim now prints after
    // the far cube, so its loops start nearest where the far cube ends. Only brim lines moved, with the same loops
    // and lengths (689.75 against 689.77 mm), and the travels, wipes, progress lines and time.
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
        "5e713edbe514e184",
        "the P1S plate's G-code changed"
    );
}
