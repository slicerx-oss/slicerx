// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx slice <file.3mf>` and `sx slice --request` of a 3MF whose build items place one object several times: each
//! item is an object with a label of its own, and every later item prints the first one's paths moved to its place,
//! because the object is sliced once and printed as copies.

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "a test model and G-code reader: tiny archives, plate coordinates in mm"
)]

use serde_json::json;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;
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

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 == 1 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}

/// A stored ZIP of the given entries.
fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let offset = out.len() as u32;
        let crc = crc32(data);
        for (dst, sig) in [(&mut out, 0x0403_4b50u32), (&mut central, 0x0201_4b50u32)] {
            dst.extend_from_slice(&sig.to_le_bytes());
            if sig == 0x0201_4b50 {
                dst.extend_from_slice(&20u16.to_le_bytes());
            }
            dst.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            dst.extend_from_slice(&crc.to_le_bytes());
            dst.extend_from_slice(&(data.len() as u32).to_le_bytes());
            dst.extend_from_slice(&(data.len() as u32).to_le_bytes());
            dst.extend_from_slice(&(name.len() as u16).to_le_bytes());
            dst.extend_from_slice(&0u16.to_le_bytes());
            if sig == 0x0201_4b50 {
                dst.extend_from_slice(&[0; 10]);
                dst.extend_from_slice(&offset.to_le_bytes());
            }
            dst.extend_from_slice(name.as_bytes());
        }
        out.extend_from_slice(data);
    }
    let at = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&at.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

/// A plain 3MF of one ring, 16 mm across with a 6 mm hole and 3 mm tall (walls, solid and sparse infill), placed by
/// each of `items` (3MF transforms).
fn rings(items: &[String]) -> Vec<u8> {
    const N: u32 = 32;
    let (outer, inner, h) = (8.0_f32, 3.0_f32, 3.0_f32);
    let mut vs = String::new();
    // per step i: outer bottom, inner bottom, outer top, inner top
    for i in 0..N {
        let a = i as f32 / N as f32 * std::f32::consts::TAU;
        let (s, c) = a.sin_cos();
        for (r, z) in [(outer, 0.0), (inner, 0.0), (outer, h), (inner, h)] {
            let _ = write!(vs, r#"<vertex x="{}" y="{}" z="{}"/>"#, r * c, r * s, z);
        }
    }
    let mut ts = String::new();
    for i in 0..N {
        let j = (i + 1) % N;
        let (ob, ib, ot, it) = (4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3);
        let (ob2, ib2, ot2, it2) = (4 * j, 4 * j + 1, 4 * j + 2, 4 * j + 3);
        for [a, b, c] in [
            [ot, ot2, it2],
            [ot, it2, it],
            [ob, ib2, ob2],
            [ob, ib, ib2],
            [ob, ob2, ot2],
            [ob, ot2, ot],
            [ib, it2, ib2],
            [ib, it, it2],
        ] {
            let _ = write!(ts, r#"<triangle v1="{a}" v2="{b}" v3="{c}"/>"#);
        }
    }
    let build = items.iter().fold(String::new(), |mut acc, t| {
        let _ = write!(acc, r#"<item objectid="1" transform="{t}"/>"#);
        acc
    });
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="ring" type="model"><mesh><vertices>{vs}</vertices><triangles>{ts}</triangles></mesh></object></resources><build>{build}</build></model>"#
    );
    zip(&[("3D/3dmodel.model", model.as_bytes())])
}

/// One extrusion: its feature, from and to (mm) and the filament it pushes (mm).
type Extrusion = (String, [f64; 4], f64);

/// Each labeled object's extrusions in print order, by its label id.
fn by_object(g: &str) -> BTreeMap<u32, Vec<Extrusion>> {
    let mut out: BTreeMap<u32, Vec<Extrusion>> = BTreeMap::new();
    let (mut object, mut feature, mut at) = (None::<u32>, String::new(), [0.0_f64; 2]);
    for line in g.lines() {
        if let Some(rest) = line.strip_prefix("; printing object ") {
            object = rest
                .split(" id:")
                .nth(1)
                .and_then(|r| r.split_whitespace().next())
                .and_then(|n| n.parse().ok());
        } else if line.starts_with("; stop printing object ") {
            object = None;
        } else if let Some(t) = line.strip_prefix(";TYPE:") {
            t.clone_into(&mut feature);
        }
        let code = line.split(';').next().unwrap_or("");
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|g| code.starts_with(g)) {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .skip(1)
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        let next = [word('X').unwrap_or(at[0]), word('Y').unwrap_or(at[1])];
        if let (Some(k), Some(e)) = (object, word('E'))
            && e > 0.0
            && next.iter().zip(at).any(|(p, q)| (p - q).abs() > 1e-9)
        {
            out.entry(k)
                .or_default()
                .push((feature.clone(), [at[0], at[1], next[0], next[1]], e));
        }
        at = next;
    }
    out
}

/// Every object after the first prints the first one's extrusions moved by `moves` (each item's place against the
/// first's), with the same filament.
fn assert_copies(g: &str, moves: &[(f64, f64)], what: &str) {
    let objects = by_object(g);
    assert_eq!(
        objects.len(),
        moves.len(),
        "{what}: every item prints as its own object"
    );
    let first = objects.values().next().unwrap();
    assert!(
        first.iter().any(|x| x.0 == "Sparse infill"),
        "{what}: the ring has sparse infill"
    );
    for ((id, paths), (dx, dy)) in objects.iter().zip(moves).skip(1) {
        assert_eq!(
            paths.len(),
            first.len(),
            "{what}: object {id} has {} extrusions, the first has {}",
            paths.len(),
            first.len()
        );
        // Coordinates are written to a thousandth of a millimeter, so each moved one may round the other way.
        let d = [*dx, *dy, *dx, *dy];
        let worst = paths
            .iter()
            .zip(first)
            .map(|(p, q)| {
                assert_eq!(p.0, q.0, "{what}: object {id} follows the first one's features");
                assert!(
                    (p.2 - q.2).abs() < 1e-5,
                    "{what}: object {id}: E {} against {}",
                    p.2,
                    q.2
                );
                (0..4).map(|c| (p.1[c] - q.1[c] - d[c]).abs()).fold(0.0, f64::max)
            })
            .fold(0.0, f64::max);
        assert!(
            worst < 0.0015,
            "{what}: object {id} is not the first one moved, off by up to {worst} mm"
        );
    }
}

#[test]
fn a_3mf_of_one_object_placed_four_times_prints_copies() {
    let root = std::env::temp_dir().join(format!("sx-cli-copies-3mf-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let _dir = TempDir(root.clone());
    // Moves that fall between the infill lines, so a slice of the whole plate lays each ring's infill differently.
    let moves = [(0.0, 0.0), (23.7, 0.0), (0.0, 31.3), (47.9, 17.1)];
    let items: Vec<String> = moves
        .iter()
        .map(|(dx, dy)| format!("1 0 0 0 1 0 0 0 1 {} {} 0", 80.0 + dx, 80.0 + dy))
        .collect();
    let file = root.join("rings.3mf");
    std::fs::write(&file, rings(&items)).unwrap();
    let config = json!({
        "gcode_label_objects": true, "gcode_flavor": "marlin", "brim_width": 0, "skirt_loops": 0,
        "sparse_infill_density": "15%"
    });
    let config_file = root.join("config.json");
    std::fs::write(&config_file, config.to_string()).unwrap();

    let out = sx()
        .arg("slice")
        .arg(&file)
        .arg("--config")
        .arg(&config_file)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_copies(&String::from_utf8(out.stdout).unwrap(), &moves, "sx slice");

    let req = json!({
        "schemaVersion": 1,
        "meshes": {"m": file.to_string_lossy()},
        "plate": {"objects": [{"id": "o", "mesh": "m"}]},
        "config": config,
    });
    let req_file = root.join("request.json");
    std::fs::write(&req_file, req.to_string()).unwrap();
    let dir = root.join("out");
    let out = sx()
        .args(["slice", "--request"])
        .arg(&req_file)
        .arg("--out-dir")
        .arg(&dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_copies(
        &std::fs::read_to_string(dir.join("slice.gcode")).unwrap(),
        &moves,
        "sx slice --request",
    );
}
