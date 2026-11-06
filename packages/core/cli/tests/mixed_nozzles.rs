// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx slice --request` and `sx check --request` on a printer whose nozzles are of different sizes. The request
//! carries the sizes and a layer height per nozzle as lists, one entry per nozzle; each object prints with the nozzle
//! its filament goes to; on a two-nozzle printer's automatic filament map every object prints with the first nozzle
//! and the report warns. Which object a move belongs to is read from its position (left below x 110).

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

fn sx() -> Command {
    Command::new(env!("CARGO_BIN_EXE_sx"))
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp(name: &str) -> TempDir {
    let dir = std::env::temp_dir().join(format!("sx-mixed-nozzles-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

/// A 12 mm cube as ASCII STL.
fn write_cube(path: &Path) {
    let v = |i: usize| {
        let s = 12.0;
        [
            if i & 1 == 1 { s } else { 0.0 },
            if i & 2 == 2 { s } else { 0.0 },
            if i & 4 == 4 { s } else { 0.0 },
        ]
    };
    let faces = [
        [0, 2, 1],
        [1, 2, 3],
        [4, 5, 6],
        [5, 7, 6],
        [0, 1, 4],
        [1, 5, 4],
        [2, 6, 3],
        [3, 6, 7],
        [0, 4, 2],
        [2, 4, 6],
        [1, 3, 5],
        [3, 7, 5],
    ];
    let mut s = String::from("solid cube\n");
    for f in faces {
        s.push_str(" facet normal 0 0 0\n  outer loop\n");
        for i in f {
            let p = v(i);
            let _ = writeln!(s, "   vertex {} {} {}", p[0], p[1], p[2]);
        }
        s.push_str("  endloop\n endfacet\n");
    }
    s.push_str("endsolid cube\n");
    std::fs::write(path, s).unwrap();
}

/// The request: two cubes, the right one on filament 2, with `config`.
fn request(dir: &Path, config: &serde_json::Value) -> PathBuf {
    write_cube(&dir.join("cube.stl"));
    let req = serde_json::json!({
        "meshes": {"c": "cube.stl"},
        "plate": {"objects": [
            {"id": "left", "name": "left", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 70,100,0,1]},
            {"id": "right", "name": "right", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 150,100,0,1],
             "slotOverrides": {"cube.stl": 2}},
        ]},
        "config": config,
    });
    let path = dir.join("req.json");
    std::fs::write(&path, serde_json::to_vec(&req).unwrap()).unwrap();
    path
}

fn changer() -> serde_json::Value {
    serde_json::json!({
        "gcode_flavor": "klipper",
        "single_extruder_multi_material": false,
        "nozzle_diameter": [0.4, 0.6],
        "nozzle_temperature": [220, 220],
        "layer_height": [0.2, 0.3],
        "initial_layer_print_height": 0.2,
        "line_width": "0",
        "outer_wall_line_width": "0",
        "inner_wall_line_width": "0",
        "brim_width": 0,
        "skirt_loops": 0,
    })
}

/// Per object: its outer wall widths above the first layer (thousandths) and its nozzle heights (thousandths).
fn read(gcode: &str) -> BTreeMap<&'static str, (BTreeSet<i64>, BTreeSet<i64>)> {
    let mut out: BTreeMap<&'static str, (BTreeSet<i64>, BTreeSet<i64>)> = BTreeMap::new();
    let (mut x, mut z, mut width, mut outer) = (0.0f64, 0.0f64, 0.0f64, false);
    for l in gcode.lines() {
        // A Bambu Lab printer's file names them `; FEATURE: ` and `; LINE_WIDTH: `.
        if let Some(t) = l.strip_prefix(";TYPE:").or_else(|| l.strip_prefix("; FEATURE: ")) {
            outer = t.trim().eq_ignore_ascii_case("Outer wall");
            continue;
        }
        if let Some(w) = l
            .strip_prefix(";WIDTH:")
            .or_else(|| l.strip_prefix("; LINE_WIDTH: "))
        {
            width = w.trim().parse().unwrap_or(width);
            continue;
        }
        let code = l.split(';').next().unwrap_or("").trim();
        let g = code.split_whitespace().next().unwrap_or("");
        if !matches!(g, "G0" | "G1" | "G2" | "G3") {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .skip(1)
                .find_map(|w| w.strip_prefix(c)?.parse::<f64>().ok())
        };
        let nx = word('X').unwrap_or(x);
        z = word('Z').unwrap_or(z);
        // Extruding moves in XY, arcs included (their E counts as any other).
        if word('E').is_some_and(|e| e > 0.0) && (word('X').is_some() || word('Y').is_some()) {
            let name = if f64::midpoint(x, nx) < 110.0 {
                "left"
            } else {
                "right"
            };
            let e = out.entry(name).or_default();
            e.1.insert((z * 1000.0).round() as i64);
            if outer && z > 0.25 {
                e.0.insert((width * 1000.0).round() as i64);
            }
        }
        x = nx;
    }
    out
}

#[test]
fn slice_prints_each_object_with_its_nozzles_widths_and_layers() {
    let dir = temp("slice");
    let req = request(&dir.0, &changer());
    let out = dir.0.join("out");
    let o = sx()
        .args(["slice", "--request"])
        .arg(&req)
        .arg("--out-dir")
        .arg(&out)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let gcode = std::fs::read_to_string(out.join("slice.gcode")).unwrap();
    let p = read(&gcode);
    assert_eq!(p["left"].0, BTreeSet::from([450]));
    assert_eq!(p["right"].0, BTreeSet::from([675]));
    let steps = |s: &BTreeSet<i64>| {
        s.iter()
            .zip(s.iter().skip(1))
            .map(|(a, b)| b - a)
            .collect::<BTreeSet<i64>>()
    };
    assert_eq!(steps(&p["left"].1), BTreeSet::from([200]));
    assert_eq!(steps(&p["right"].1), BTreeSet::from([300]));
    // The report on stdout names each object's nozzle.
    let report: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    let nozzles: Vec<serde_json::Value> = report["featureFilaments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["nozzleMm"].clone())
        .collect();
    assert_eq!(nozzles, vec![serde_json::json!(0.4), serde_json::json!(0.6)]);
}

#[test]
fn an_automatic_map_on_nozzles_of_different_sizes_is_refused() {
    let dir = temp("auto");
    let mut c = changer();
    c["printer_model"] = serde_json::json!("Bambu Lab H2D");
    c["single_extruder_multi_material"] = serde_json::json!(true);
    c["filament_map_mode"] = serde_json::json!("Auto For Flush");
    let req = request(&dir.0, &c);
    for cmd in ["slice", "check"] {
        let mut run = sx();
        run.args([cmd, "--request"]).arg(&req);
        if cmd == "slice" {
            run.arg("--out-dir").arg(dir.0.join("out"));
        }
        let o = run.output().unwrap();
        assert!(!o.status.success(), "{cmd} should refuse");
        let err = String::from_utf8_lossy(&o.stderr);
        assert!(
            err.contains("filament_map")
                && err.contains("left 0.4 mm, right 0.6 mm")
                && err.contains("filament map by hand"),
            "{cmd}: {err}"
        );
    }
    // With the map set by hand it checks, and prints each object with its own nozzle.
    c["filament_map_mode"] = serde_json::json!("Manual");
    c["filament_map"] = serde_json::json!([1, 2]);
    let req = request(&dir.0, &c);
    let o = sx().args(["check", "--request"]).arg(&req).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}
