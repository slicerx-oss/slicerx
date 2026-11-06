// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A project's plate type per plate: a 3MF project keeps a plate's own plate type as `bed_type` in its
//! `<plate>` entry of `Metadata/model_settings.config`, over the project's `curr_bed_type`. `sx slice <project.3mf>
//! --plate N` prints plate N at its own plate type's bed temperatures, as the app opens the project's plates, unless
//! `--config` names a plate type.

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    reason = "a test model and G-code reader: tiny archives"
)]

use serde_json::json;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::process::Command;

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

/// A P1S project on the Textured PEI plate (65 C) with one 20 mm box per plate; `own[i]` is the `<plate>` metadata
/// plate i + 1 adds, such as `bed_type` Cool Plate (35 C) or Textured Cool Plate (45 C).
fn project(own: &[&str]) -> Vec<u8> {
    let (mut res, mut build, mut objects, mut plates) =
        (String::new(), String::new(), String::new(), String::new());
    for (i, extra) in own.iter().enumerate() {
        let o = i + 1;
        let _ = write!(res, r#"<object id="{o}" type="model"><mesh><vertices>"#);
        for (x, y, z) in [
            (-10, -10, 0),
            (10, -10, 0),
            (10, 10, 0),
            (-10, 10, 0),
            (-10, -10, 2),
            (10, -10, 2),
            (10, 10, 2),
            (-10, 10, 2),
        ] {
            let _ = write!(res, r#"<vertex x="{x}" y="{y}" z="{z}"/>"#);
        }
        res.push_str("</vertices><triangles>");
        for [a, b, c] in [
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ] {
            let _ = write!(res, r#"<triangle v1="{a}" v2="{b}" v3="{c}"/>"#);
        }
        res.push_str("</triangles></mesh></object>");
        // later plates on the project's grid beside the first, as project files lay them out
        let cols = (own.len() as f64).sqrt().ceil() as usize;
        let (col, row) = ((i % cols) as f64, (i / cols) as f64);
        let (x, y) = (col * 256.0 * 1.2 + 128.0, -row * 256.0 * 1.2 + 128.0);
        let _ = write!(
            build,
            r#"<item objectid="{o}" transform="1 0 0 0 1 0 0 0 1 {x} {y} 0"/>"#
        );
        let _ = write!(
            objects,
            r#"<object id="{o}"><metadata key="name" value="box{o}"/><metadata key="extruder" value="1"/></object>"#
        );
        let _ = write!(
            plates,
            r#"<plate><metadata key="plater_id" value="{o}"/>{extra}<model_instance><metadata key="object_id" value="{o}"/></model_instance></plate>"#
        );
    }
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>{res}</resources><build>{build}</build></model>"#
    );
    let config = format!(r#"<?xml version="1.0" encoding="UTF-8"?><config>{objects}{plates}</config>"#);
    let settings = json!({
        "printer_model": "Bambu Lab P1S",
        "printable_area": ["0x0", "256x0", "256x256", "0x256"],
        "curr_bed_type": "Textured PEI Plate",
        "textured_plate_temp": ["65"],
        "textured_plate_temp_initial_layer": ["65"],
        "cool_plate_temp": ["35"],
        "cool_plate_temp_initial_layer": ["35"],
        "textured_cool_plate_temp": ["45"],
        "textured_cool_plate_temp_initial_layer": ["45"],
        "layer_height": "0.2",
        "initial_layer_print_height": "0.2",
    })
    .to_string();
    zip(&[
        ("3D/3dmodel.model", model.as_bytes()),
        ("Metadata/model_settings.config", config.as_bytes()),
        ("Metadata/project_settings.config", settings.as_bytes()),
    ])
}

/// The first layer bed temperature `sx slice` prints plate `plate` of `bytes` at, with `extra` arguments.
fn bed_temperature(bytes: &[u8], plate: u32, extra: &[&str]) -> f64 {
    let dir = std::env::temp_dir().join(format!(
        "sx-plate-bed-type-{plate}-{}-{}",
        extra.len(),
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let dir = TempDir(dir);
    let model = dir.0.join("p.3mf");
    std::fs::write(&model, bytes).unwrap();
    let out = dir.0.join("p.gcode");
    let run = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(&model)
        .args(["--plate", &plate.to_string()])
        .args(extra)
        .arg("-o")
        .arg(&out)
        .output()
        .unwrap();
    assert!(run.status.success(), "{}", String::from_utf8_lossy(&run.stderr));
    let gcode = std::fs::read_to_string(&out).unwrap();
    gcode
        .lines()
        .find_map(|l| l.strip_prefix("; first_layer_bed_temperature = "))
        .and_then(|v| v.trim().parse().ok())
        .expect("first layer bed temperature in the header")
}

#[test]
fn each_plate_prints_at_its_own_plate_types_bed_temperature() {
    let p = project(&[
        r#"<metadata key="bed_type" value="Cool Plate"/>"#,
        r#"<metadata key="curr_bed_type" value="Textured Cool Plate"/>"#,
        "",
        r#"<metadata key="bed_type" value="Default Plate"/>"#,
    ]);
    assert!((bed_temperature(&p, 1, &[]) - 35.0).abs() < 1e-9);
    assert!((bed_temperature(&p, 2, &[]) - 45.0).abs() < 1e-9);
    // no plate type of its own, or Default Plate: the project's
    assert!((bed_temperature(&p, 3, &[]) - 65.0).abs() < 1e-9);
    assert!((bed_temperature(&p, 4, &[]) - 65.0).abs() < 1e-9);
}

#[test]
fn a_plate_type_in_config_wins_over_the_plates_own() {
    let p = project(&[r#"<metadata key="bed_type" value="Cool Plate"/>"#]);
    let dir = std::env::temp_dir().join(format!("sx-plate-bed-type-config-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir = TempDir(dir);
    let config = dir.0.join("c.json");
    std::fs::write(
        &config,
        json!({ "curr_bed_type": "Textured Cool Plate" }).to_string(),
    )
    .unwrap();
    let config = config.to_string_lossy().into_owned();
    assert!((bed_temperature(&p, 1, &["--config", &config]) - 45.0).abs() < 1e-9);
}
