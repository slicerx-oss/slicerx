// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx slice --request` with a `PrusaSlicer` project's own printer G-code, as the app sends it after a person chooses
//! the project's G-code: the MK4's start, end, layer change and filament G-code read the project's abrasive filament
//! and high flow nozzle flags (its M862.1 line) and its spiral vase setting under `PrusaSlicer`'s names.

use serde_json::Value;
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

fn project() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/prusa-lift/mk4--isl--stock.3mf")
}

/// Every entry of the zip `bytes`, inflated, found through the central directory.
fn unzip(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let u16_at = |at: usize| usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
    let end = (0..bytes.len() - 21)
        .rev()
        .find(|&at| u32_at(at) == 0x0605_4b50)
        .unwrap();
    let mut at = u32_at(end + 16);
    let mut out = Vec::new();
    for _ in 0..u16_at(end + 10) {
        let (method, size, name_len) = (u16_at(at + 10), u32_at(at + 20), u16_at(at + 28));
        let local = u32_at(at + 42);
        let name = String::from_utf8(bytes[at + 46..at + 46 + name_len].to_vec()).unwrap();
        let data = local + 30 + u16_at(local + 26) + u16_at(local + 28);
        let raw = &bytes[data..data + size];
        out.push((
            name,
            if method == 0 {
                raw.to_vec()
            } else {
                miniz_oxide::inflate::decompress_to_vec(raw).unwrap()
            },
        ));
        at += 46 + name_len + u16_at(at + 30) + u16_at(at + 32);
    }
    out
}

/// A stored ZIP of the given entries.
fn zip(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
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
    let len = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let offset = len(out.len());
        let crc = crc32(data);
        for (dst, sig) in [(&mut out, 0x0403_4b50u32), (&mut central, 0x0201_4b50u32)] {
            dst.extend_from_slice(&sig.to_le_bytes());
            if sig == 0x0201_4b50 {
                dst.extend_from_slice(&20u16.to_le_bytes());
            }
            dst.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            dst.extend_from_slice(&crc.to_le_bytes());
            dst.extend_from_slice(&len(data.len()).to_le_bytes());
            dst.extend_from_slice(&len(data.len()).to_le_bytes());
            dst.extend_from_slice(&u16::try_from(name.len()).unwrap_or(0).to_le_bytes());
            dst.extend_from_slice(&0u16.to_le_bytes());
            if sig == 0x0201_4b50 {
                dst.extend_from_slice(&[0; 10]);
                dst.extend_from_slice(&offset.to_le_bytes());
            }
            dst.extend_from_slice(name.as_bytes());
        }
        out.extend_from_slice(data);
    }
    let at = len(out.len());
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    let n = u16::try_from(entries.len()).unwrap_or(0).to_le_bytes();
    out.extend_from_slice(&n);
    out.extend_from_slice(&n);
    out.extend_from_slice(&len(central.len()).to_le_bytes());
    out.extend_from_slice(&at.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

/// The text of a `PrusaSlicer` config value, with its escapes undone.
fn unescape(v: &str) -> String {
    let mut out = String::new();
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// The value of `key` in a `PrusaSlicer` config (`; key = value` lines), as it is written.
fn value<'a>(config: &'a str, key: &str) -> &'a str {
    config
        .lines()
        .find_map(|l| l.strip_prefix(&format!("; {key} = ")))
        .unwrap()
}

/// The project's printer G-code under our keys, as the app applies it: the start, end and layer change text, and its
/// filament's start and end text (one quoted entry each).
fn project_gcode(config: &str) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for (prusa, ours) in [
        ("start_gcode", "machine_start_gcode"),
        ("end_gcode", "machine_end_gcode"),
        ("before_layer_gcode", "before_layer_change_gcode"),
        ("layer_gcode", "layer_change_gcode"),
    ] {
        out.insert(ours.into(), unescape(value(config, prusa)).into());
    }
    for (prusa, ours) in [
        ("start_filament_gcode", "filament_start_gcode"),
        ("end_filament_gcode", "filament_end_gcode"),
    ] {
        let quoted = value(config, prusa);
        let one = quoted
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .unwrap();
        out.insert(ours.into(), Value::Array(vec![unescape(one).into()]));
    }
    out
}

/// Slices the MK4 request fixture with `config` over its own and returns the G-code.
fn slice(dir: &Path, config: serde_json::Map<String, Value>) -> String {
    let fixtures =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/narrow-piece-surface/requests");
    let mut req: Value = serde_json::from_str(
        &std::fs::read_to_string(fixtures.join("prusa-mk4--n4-cl-sp0-al.json")).unwrap(),
    )
    .unwrap();
    req["meshes"]["m0"] = fixtures
        .join("../prusa-mk4--n4-cl-sp0-al.stl")
        .display()
        .to_string()
        .into();
    req["config"].as_object_mut().unwrap().extend(config);
    let path = dir.join("request.json");
    std::fs::write(&path, serde_json::to_vec(&req).unwrap()).unwrap();
    let out = sx()
        .args(["slice", "--request"])
        .arg(&path)
        .arg("--out-dir")
        .arg(dir.join("out"))
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    std::fs::read_to_string(dir.join("out/slice.gcode")).unwrap()
}

/// `sx project-settings` of the project `bytes`: its print and filament values, as the app opens it.
fn project_settings(dir: &Path, bytes: &[u8]) -> serde_json::Map<String, Value> {
    let path = dir.join("project.3mf");
    std::fs::write(&path, bytes).unwrap();
    let out = sx().arg("project-settings").arg(&path).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    match serde_json::from_slice(&out.stdout).unwrap() {
        Value::Object(m) => m,
        other => panic!("{other}"),
    }
}

/// The lines of `gcode` that start with `code`.
fn lines<'a>(gcode: &'a str, code: &str) -> Vec<&'a str> {
    gcode.lines().filter(|l| l.starts_with(code)).collect()
}

#[test]
fn a_request_with_a_prusaslicer_projects_gcode_slices_with_its_values() {
    let dir = TempDir(std::env::temp_dir().join(format!("sx-cli-prusa-gcode-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let entries = unzip(&std::fs::read(project()).unwrap());
    let config_of = |entries: &[(String, Vec<u8>)]| {
        let (_, text) = entries
            .iter()
            .find(|(n, _)| n == "Metadata/Slic3r_PE.config")
            .unwrap();
        String::from_utf8(text.clone()).unwrap()
    };
    let config = config_of(&entries);
    assert!(value(&config, "start_gcode").contains(
        "M862.1 P[nozzle_diameter] A{(filament_abrasive[0] ? 1 : 0)} F{(nozzle_high_flow[0] ? 1 : 0)}"
    ));
    assert!(value(&config, "layer_gcode").contains("{if ! spiral_vase}M74 W[extruded_weight_total]{endif}"));

    // The project as saved: its filament is not abrasive and its nozzle is not high flow.
    let settings = project_settings(&dir.0, &zip(&entries));
    assert_eq!(settings["filament_abrasive"], "0");
    let mut request = settings;
    request.extend(project_gcode(&config));
    let gcode = slice(&dir.0, request);
    assert_eq!(lines(&gcode, "M862.1"), ["M862.1 P0.4 A0 F0 ; nozzle check"]);
    assert!(
        lines(&gcode, "M74 W").len() > 10,
        "the layer change's weight line on each layer"
    );

    // A project whose filament is abrasive passes that on; the high flow nozzle is the printer's own setting.
    let abrasive: Vec<(String, Vec<u8>)> = entries
        .iter()
        .map(|(name, data)| {
            let data = if name == "Metadata/Slic3r_PE.config" {
                config
                    .replace("; filament_abrasive = 0\n", "; filament_abrasive = 1\n")
                    .into_bytes()
            } else {
                data.clone()
            };
            (name.clone(), data)
        })
        .collect();
    let settings = project_settings(&dir.0, &zip(&abrasive));
    assert_eq!(settings["filament_abrasive"], "1");
    assert!(
        !settings.contains_key("nozzle_high_flow"),
        "a printer setting stays the printer's"
    );
    let mut request = settings;
    request.extend(project_gcode(&config_of(&abrasive)));
    request.insert("nozzle_high_flow".into(), serde_json::json!([true]));
    let gcode = slice(&dir.0, request);
    assert_eq!(lines(&gcode, "M862.1"), ["M862.1 P0.4 A1 F1 ; nozzle check"]);
}
