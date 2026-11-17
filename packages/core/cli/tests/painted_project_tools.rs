// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx slice <project.3mf>` of a painted project with no prime tower: every band of a painted column prints with the
//! filament painted on it, and an unpainted band above a painted one prints with the part's own filament again. A
//! band's paint has to reach the outline on every face: a strip of the part's own filament left along one prints
//! nothing, but the layer is planned as ending on that filament, so without a tower the next layer (the first unpainted
//! one) starts as if it were loaded and prints on the painted one.

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::many_single_char_names,
    reason = "a test model and G-code reader: tiny archives, plate coordinates in mm"
)]

use std::collections::BTreeMap;
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

/// Band height and count of the column, mm.
const BAND: f64 = 10.0;
const BANDS: usize = 4;

/// A Bambu Studio style project for the A1: a 20 by 20 by 40 mm column on filament 2 of four PLA filaments, in four
/// 10 mm bands. `paint` gives the paint text of each painted band's side triangles (band 1 is the lowest); one
/// triangle of band 1 is always split, its half painted filament 1. The settings name no prime tower.
fn banded(paint: &[(usize, &str)]) -> Vec<u8> {
    let (side, height) = (20.0_f64, BAND * BANDS as f64);
    let mut vs = String::new();
    for k in 0..=BANDS {
        let z = height * k as f64 / BANDS as f64;
        for (x, y) in [(0.0, 0.0), (side, 0.0), (side, side), (0.0, side)] {
            let _ = write!(vs, r#"<vertex x="{x}" y="{y}" z="{z}"/>"#);
        }
    }
    let mut ts = String::new();
    let mut tri = |a: usize, b: usize, c: usize, p: Option<&str>| {
        let p = p.map_or_else(String::new, |p| format!(r#" paint_color="{p}""#));
        let _ = write!(ts, r#"<triangle v1="{a}" v2="{b}" v3="{c}"{p}/>"#);
    };
    for k in 0..BANDS {
        let p = paint.iter().find(|(b, _)| *b == k + 1).map(|(_, t)| *t);
        let (lo, hi) = (4 * k, 4 * (k + 1));
        for i in 0..4 {
            let (a, b) = (lo + i, lo + (i + 1) % 4);
            let (c, d) = (hi + (i + 1) % 4, hi + i);
            tri(a, b, c, p);
            tri(a, c, d, if k == 0 && i == 0 { Some("40003") } else { p });
        }
    }
    let t = 4 * BANDS;
    tri(0, 2, 1, None);
    tri(0, 3, 2, None);
    tri(t, t + 1, t + 2, None);
    tri(t, t + 2, t + 3, None);
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.07.01.57</metadata><resources><object id="1" type="model"><mesh><vertices>{vs}</vertices><triangles>{ts}</triangles></mesh></object><object id="2" type="model"><components><component objectid="1"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 118 118 0"/></build></model>"#
    );
    let config = r#"<?xml version="1.0" encoding="UTF-8"?><config><object id="2"><metadata key="name" value="column"/><metadata key="extruder" value="2"/><part id="1" subtype="normal_part"><metadata key="name" value="column"/><metadata key="extruder" value="2"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance></plate></config>"#;
    let settings = serde_json::json!({
        "printer_settings_id": "Bambu Lab A1 0.4 nozzle",
        "printer_model": "Bambu Lab A1",
        "nozzle_diameter": ["0.4"],
        "filament_colour": ["#FFFFFF", "#000000", "#FF0000", "#C100C1"],
        "filament_type": ["PLA", "PLA", "PLA", "PLA"],
        "filament_settings_id": vec!["Bambu PLA Basic @BBL A1"; 4],
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

/// What prints a band: its outer wall moves by tool, and every extrusion by tool on the layers more than `inset` mm
/// inside it (away from the layers where the band below hands over).
#[derive(Default, Debug)]
struct BandTools {
    outer: BTreeMap<u32, usize>,
    inner: BTreeMap<u32, usize>,
}

/// `sx slice <project.3mf>` of `project`, read band by band (a layer belongs to the band its top is in, a top on a
/// band's upper edge to the band above).
fn slice_bands(name: &str, project: &[u8], inset: f64) -> Vec<BandTools> {
    let dir = TempDir(std::env::temp_dir().join(format!("sx-painted-tools-{name}-{}", std::process::id())));
    let _ = std::fs::remove_dir_all(&dir.0);
    std::fs::create_dir_all(&dir.0).unwrap();
    let (model, gcode) = (dir.0.join("column.3mf"), dir.0.join("column.gcode"));
    std::fs::write(&model, project).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(&model)
        .arg("-o")
        .arg(&gcode)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{name}: sx slice failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = std::fs::read_to_string(&gcode).unwrap();
    let mut bands: Vec<BandTools> = (0..BANDS).map(|_| BandTools::default()).collect();
    let (mut z, mut tool, mut feature) = (0.0_f64, None::<u32>, String::new());
    for line in text.lines() {
        if let Some(v) = line
            .strip_prefix("; Z_HEIGHT:")
            .or_else(|| line.strip_prefix(";Z:"))
        {
            z = v.trim().parse().unwrap_or(z);
            continue;
        }
        if let Some(f) = line
            .strip_prefix("; FEATURE:")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            f.trim().clone_into(&mut feature);
            continue;
        }
        let code = line.split(';').next().unwrap_or("").trim();
        if let Some(t) = code.strip_prefix('T').and_then(|t| t.parse::<u32>().ok()) {
            if t < 255 {
                tool = Some(t);
            }
            continue;
        }
        let extrudes = code.starts_with("G1 ")
            && code
                .split_whitespace()
                .any(|w| w.starts_with('X') || w.starts_with('Y'))
            && code.split_whitespace().any(|w| {
                w.strip_prefix('E')
                    .and_then(|e| e.parse::<f64>().ok())
                    .is_some_and(|e| e > 0.0)
            });
        let Some(t) = tool.filter(|_| extrudes && feature != "Prime tower") else {
            continue;
        };
        let band = ((z / BAND) as usize).min(BANDS - 1);
        let b = &mut bands[band];
        if feature == "Outer wall" {
            *b.outer.entry(t).or_default() += 1;
        }
        let lo = band as f64 * BAND;
        if z > lo + inset && z < lo + BAND - 1e-6 {
            *b.inner.entry(t).or_default() += 1;
        }
    }
    bands
}

/// Band `band` (1-based) prints its outer wall with tool `want` (at least 95 of every 100 moves; on band 1, whose
/// split triangle prints in its own color, most of them) and, when `only`, every extrusion of its layers away from the
/// band below with that tool alone.
fn assert_band(name: &str, bands: &[BandTools], band: usize, want: u32, only: bool) {
    let b = &bands[band - 1];
    let total: usize = b.outer.values().sum();
    let mine = b.outer.get(&want).copied().unwrap_or(0);
    let share = if band == 1 { 60 } else { 95 };
    assert!(
        total > 0 && mine * 100 >= total * share,
        "{name}: band {band} prints its outer wall with T{want}: outer wall moves by tool {:?}, every band {bands:?}",
        b.outer
    );
    if only {
        assert!(
            b.inner.keys().all(|t| *t == want) && !b.inner.is_empty(),
            "{name}: band {band} prints only with T{want}: moves by tool {:?}",
            b.inner
        );
    }
}

/// Bands painted filaments 1, 2 and 3 (the last in the extended form, `0C`) under an unpainted band on filament 2:
/// each prints with its own filament, the unpainted one with filament 2 (T1) and nothing else.
#[test]
fn each_band_of_a_painted_project_prints_with_its_own_filament() {
    let name = "bands";
    let bands = slice_bands(name, &banded(&[(1, "4"), (2, "8"), (3, "0C")]), 0.5);
    assert_band(name, &bands, 1, 0, false);
    assert_band(name, &bands, 2, 1, false);
    assert_band(name, &bands, 3, 2, false);
    assert_band(name, &bands, 4, 1, true);
}

/// One band painted filament 3, under and over unpainted ones: the bands above it go back to filament 2.
#[test]
fn unpainted_bands_over_a_painted_one_print_with_the_parts_filament() {
    for (paint, painted) in [((3, "0C"), 3), ((2, "0C"), 2)] {
        let name = format!("band{painted}");
        let bands = slice_bands(&name, &banded(&[paint]), 0.5);
        for band in 1..=BANDS {
            if band == painted {
                assert_band(&name, &bands, band, 2, false);
            } else {
                // Band 1's split triangle is painted filament 1 on its own face.
                assert_band(&name, &bands, band, 1, band > painted);
            }
        }
    }
}
