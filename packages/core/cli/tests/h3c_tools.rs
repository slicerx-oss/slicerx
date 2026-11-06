// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx slice --request` on the Bambu Lab H3C, one extruder that holds nine hotends: each filament prints on a hotend
//! of its own, read back from the change G-code's hotend ids and from the report's filament map, and a second
//! 2.85 mm TPU filament, with one TPU hotend to print on, is refused with a message that names the filament map.

#![allow(clippy::disallowed_methods, reason = "a test that writes its request files")]

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
    let dir = std::env::temp_dir().join(format!("sx-h3c-tools-{name}-{}", std::process::id()));
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

/// The stock H3C from the resolved profiles, with three filaments and a change G-code that prints the hotend ids.
fn h3c() -> serde_json::Value {
    let path = format!(
        "{}/../../profiles/resolved/bambu-lab.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let all: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let m = &all["models"]["bambu-h3c"];
    let base = m["base"].as_str().unwrap();
    let mut c = serde_json::Map::new();
    for part in [&m["process"][base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            c.insert(k.clone(), v.clone());
        }
    }
    for (k, v) in [
        ("machine_start_gcode", serde_json::json!("")),
        ("machine_end_gcode", serde_json::json!("")),
        (
            "change_filament_gcode",
            serde_json::json!("; tool [next_filament_id] hotend [next_hotend]\n"),
        ),
        ("filament_type", serde_json::json!(["PLA", "PLA", "PLA"])),
        ("filament_diameter", serde_json::json!([1.75, 1.75, 1.75])),
        ("nozzle_temperature", serde_json::json!([220, 220, 220])),
        (
            "filament_colour",
            serde_json::json!(["#FF0000", "#00FF00", "#0000FF"]),
        ),
    ] {
        c.insert(k.into(), v);
    }
    serde_json::Value::Object(c)
}

/// The request: three cubes on filaments 1, 2 and 3, with `config`.
fn request(dir: &Path, config: &serde_json::Value) -> PathBuf {
    write_cube(&dir.join("cube.stl"));
    let object = |i: usize| {
        serde_json::json!({
            "id": format!("c{i}"), "name": format!("c{i}"), "mesh": "c",
            "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 110 + 40 * i,150,0,1],
            "slotOverrides": {"cube.stl": i + 1},
        })
    };
    let req = serde_json::json!({
        "meshes": {"c": "cube.stl"},
        "plate": {"objects": [object(0), object(1), object(2)]},
        "config": config,
        "options": {"trustedGcode": true},
    });
    let path = dir.join("req.json");
    std::fs::write(&path, serde_json::to_vec(&req).unwrap()).unwrap();
    path
}

fn slice(dir: &Path, config: &serde_json::Value) -> std::process::Output {
    let req = request(dir, config);
    sx().args(["slice", "--request"])
        .arg(&req)
        .arg("--out-dir")
        .arg(dir.join("out"))
        .output()
        .unwrap()
}

#[test]
fn slice_puts_each_filament_on_a_hotend_of_its_own() {
    let dir = temp("slice");
    let o = slice(&dir.0, &h3c());
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let gcode = std::fs::read_to_string(dir.0.join("out").join("slice.gcode")).unwrap();
    let mut seen = std::collections::BTreeSet::new();
    for l in gcode.lines().filter_map(|l| l.strip_prefix("; tool ")) {
        let (tool, hotend) = l.split_once(" hotend ").unwrap();
        assert_eq!(tool, hotend, "filament {tool} on hotend {hotend}");
        seen.insert(tool.to_owned());
    }
    assert_eq!(seen.len(), 3, "{seen:?}");
    let report: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(report["filamentMap"]["nozzles"], serde_json::json!([0, 1, 2]));
    assert_eq!(report["filamentMap"]["extruders"], serde_json::json!([1, 1, 1]));
}

#[test]
fn slice_refuses_two_tpu_filaments_on_one_tpu_hotend() {
    let dir = temp("tpu");
    let mut c = h3c();
    c["filament_type"] = serde_json::json!(["TPU", "PLA", "TPU"]);
    c["filament_diameter"] = serde_json::json!([2.85, 1.75, 2.85]);
    let o = slice(&dir.0, &c);
    assert!(!o.status.success(), "sliced two 2.85 mm TPU filaments");
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(err.contains("filament_map") && err.contains("TPU"), "{err}");
}
