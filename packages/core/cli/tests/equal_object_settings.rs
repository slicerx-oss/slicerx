// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A project whose objects all carry the same object settings slices the same through `sx slice <file.3mf>` and
//! `sx slice --request`: both fold the shared settings into the plate's and slice the plate as one, so the tree support
//! under one object keeps its distance from the object beside it in both. Objects whose settings differ still slice
//! each with its own.

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    reason = "a test model: tiny archives"
)]

use serde_json::json;
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

/// A closed mesh of the outline `xz` (counterclockwise, x right and z up) swept 10 mm along y, as 3MF `<mesh>`.
fn swept(xz: &[(f32, f32)], fan: &[[usize; 3]]) -> String {
    let n = xz.len();
    let mut vs = String::new();
    for y in [0.0_f32, 10.0] {
        for (x, z) in xz {
            let _ = write!(vs, r#"<vertex x="{x}" y="{y}" z="{z}"/>"#);
        }
    }
    let mut ts = String::new();
    let mut tri = |a: usize, b: usize, c: usize| {
        let _ = write!(ts, r#"<triangle v1="{a}" v2="{b}" v3="{c}"/>"#);
    };
    for [a, b, c] in fan {
        // the face at y 0 looks toward -y, the one at y 10 toward +y
        tri(*a, *b, *c);
        tri(n + a, n + c, n + b);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        tri(i, n + j, j);
        tri(i, n + i, n + j);
    }
    format!("<mesh><vertices>{vs}</vertices><triangles>{ts}</triangles></mesh>")
}

/// A Bambu Studio project plate of two objects 10 mm deep: a ledge (a 10 mm column whose top 2 mm reach 10 mm out
/// over the bed, so tree support grows under it) and a 10 mm block standing `gap` mm past the ledge's tip, so the
/// support under the ledge runs up against the block. `own` is each object's own settings in
/// `Metadata/model_settings.config`.
fn ledge_and_block(gap: f32, own: [&[(&str, &str)]; 2]) -> Vec<u8> {
    let ledge = swept(
        &[
            (0.0, 0.0),
            (10.0, 0.0),
            (10.0, 8.0),
            (20.0, 8.0),
            (20.0, 10.0),
            (0.0, 10.0),
        ],
        &[[2, 3, 4], [2, 4, 5], [2, 5, 0], [2, 0, 1]],
    );
    let block = swept(
        &[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)],
        &[[0, 1, 2], [0, 2, 3]],
    );
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources><object id="1" type="model">{ledge}</object><object id="2" type="model">{block}</object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 120 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 {} 120 0"/></build></model>"#,
        120.0 + gap
    );
    let meta = |k: usize| -> String {
        own[k]
            .iter()
            .map(|(key, v)| [r#"<metadata key=""#, key, r#"" value=""#, v, r#""/>"#].concat())
            .collect()
    };
    let objects = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="ledge"/><metadata key="extruder" value="1"/>{}</object><object id="2"><metadata key="name" value="block"/><metadata key="extruder" value="1"/>{}</object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/></model_instance><model_instance><metadata key="object_id" value="2"/></model_instance></plate></config>"#,
        meta(0),
        meta(1)
    );
    zip(&[
        ("3D/3dmodel.model", model.as_bytes()),
        ("Metadata/model_settings.config", objects.as_bytes()),
    ])
}

/// The plate's settings for both paths: tree support, no brim or skirt, labeled objects.
fn config() -> serde_json::Value {
    json!({
        "gcode_flavor": "marlin", "gcode_label_objects": true, "skirt_loops": 0, "brim_type": "no_brim",
        "enable_support": true, "support_type": "tree(auto)", "support_object_xy_distance": 0.35
    })
}

/// `file` sliced by `sx slice <file> --config` and by `sx slice --request` naming it with the same config: the two
/// G-code texts.
fn both_paths(root: &Path, file: &Path) -> (String, String) {
    let config_file = root.join("config.json");
    std::fs::write(&config_file, config().to_string()).unwrap();
    let out = sx()
        .arg("slice")
        .arg(file)
        .args(["--plate", "1", "--config"])
        .arg(&config_file)
        .args(["-o", "-"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "sx slice: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let cli = String::from_utf8(out.stdout).unwrap();
    let req = json!({
        "schemaVersion": 1,
        "meshes": {"m": format!("{}#1", file.to_string_lossy())},
        "plate": {"objects": [{"id": "o", "mesh": "m"}]},
        "config": config(),
        "options": {"emitPreview": false},
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
    assert!(
        out.status.success(),
        "sx slice --request: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (cli, std::fs::read_to_string(dir.join("slice.gcode")).unwrap())
}

/// The first line where `cli` and `request` part, with its number, for a failure message.
fn first_difference(cli: &str, request: &str) -> Option<(usize, String, String)> {
    let mut left = cli.lines().map(Some).chain(std::iter::repeat(None));
    let mut right = request.lines().map(Some).chain(std::iter::repeat(None));
    (1..).find_map(|line| match (left.next().flatten(), right.next().flatten()) {
        (None, None) => Some(None),
        (ours, theirs) if ours != theirs => Some(Some((
            line,
            ours.unwrap_or("<end>").to_owned(),
            theirs.unwrap_or("<end>").to_owned(),
        ))),
        _ => None,
    })?
}

fn temp_root(name: &str) -> TempDir {
    let root = std::env::temp_dir().join(format!("sx-cli-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    TempDir(root)
}

/// The block stands 0.3 mm past the ledge's tip, so the ledge's support keeps its distance from the block only when one
/// session plans the plate. The request path once sliced each object in a session of its own (the file's object
/// settings made each object's own), and the ledge's support then ran into the block and the plate was refused.
#[test]
fn objects_with_the_same_object_settings_slice_the_same_through_a_request() {
    let root = temp_root("equal-object-settings");
    let file = root.0.join("plate.3mf");
    let own: &[(&str, &str)] = &[("brim_type", "no_brim"), ("wall_loops", "3")];
    std::fs::write(&file, ledge_and_block(0.3, [own, own])).unwrap();
    let (cli, request) = both_paths(&root.0, &file);
    assert!(cli.contains(";TYPE:Support"), "the ledge prints with support");
    if let Some((n, l, r)) = first_difference(&cli, &request) {
        panic!(
            "sx slice and sx slice --request part at G-code line {n}:\n  sx slice:           {l}\n  sx slice --request: {r}"
        );
    }
}

/// Objects whose settings differ slice each with its own on both paths, the same G-code. The block stands 5 mm off
/// here, clear of the ledge's support.
#[test]
fn objects_with_different_object_settings_still_slice_each_with_its_own() {
    let root = temp_root("differing-object-settings");
    let file = root.0.join("plate.3mf");
    let ledge: &[(&str, &str)] = &[("brim_type", "no_brim"), ("wall_loops", "3")];
    let block: &[(&str, &str)] = &[("brim_type", "no_brim"), ("wall_loops", "2")];
    std::fs::write(&file, ledge_and_block(5.0, [ledge, block])).unwrap();
    let (cli, request) = both_paths(&root.0, &file);
    assert!(cli.contains(";TYPE:Support"), "the ledge prints with support");
    if let Some((n, l, r)) = first_difference(&cli, &request) {
        panic!(
            "sx slice and sx slice --request part at G-code line {n}:\n  sx slice:           {l}\n  sx slice --request: {r}"
        );
    }
}
