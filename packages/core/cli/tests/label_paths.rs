// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx slice` and `sx slice --request` of a model given by an absolute path: the object labels in the G-code (the
//! label comments, `M486` and `EXCLUDE_OBJECT` names) carry the file's name, or a 3MF object's place in the build when
//! it has no name, and nothing of the folder it was read from. People share G-code, and a folder name can say who
//! they are.

#![allow(clippy::cast_possible_truncation, reason = "test archives are tiny")]

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

/// The 8 corners and 12 triangles of a 10 mm box.
fn cube() -> ([[f32; 3]; 8], [[usize; 3]; 12]) {
    let mut v = [[0.0; 3]; 8];
    for (k, c) in v.iter_mut().enumerate() {
        let (x, y) = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)][k % 4];
        *c = [x, y, if k < 4 { 0.0 } else { 10.0 }];
    }
    let t = [
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
    ];
    (v, t)
}

/// A plain 3MF of `items` 10 mm boxes, 30 mm apart, whose objects have no names.
fn unnamed_boxes(items: usize) -> Vec<u8> {
    let (v, t) = cube();
    let mut mesh = String::from("<mesh><vertices>");
    for p in v {
        let _ = write!(mesh, r#"<vertex x="{}" y="{}" z="{}"/>"#, p[0], p[1], p[2]);
    }
    mesh.push_str("</vertices><triangles>");
    for [a, b, c] in t {
        let _ = write!(mesh, r#"<triangle v1="{a}" v2="{b}" v3="{c}"/>"#);
    }
    mesh.push_str("</triangles></mesh>");
    let mut objects = String::new();
    let mut build = String::new();
    for k in 1..=items {
        let _ = write!(objects, r#"<object id="{k}" type="model">{mesh}</object>"#);
        let _ = write!(
            build,
            r#"<item objectid="{k}" transform="1 0 0 0 1 0 0 0 1 {} 100 0"/>"#,
            30 * k
        );
    }
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>{objects}</resources><build>{build}</build></model>"#
    );
    zip(&[("3D/3dmodel.model", model.as_bytes())])
}

/// A 10 mm box as ASCII STL.
fn cube_stl() -> Vec<u8> {
    let (v, t) = cube();
    let mut s = String::from("solid cube\n");
    for tri in t {
        s.push_str("facet normal 0 0 0\nouter loop\n");
        for i in tri {
            let p = v[i];
            let _ = writeln!(s, "vertex {} {} {}", p[0], p[1], p[2]);
        }
        s.push_str("endloop\nendfacet\n");
    }
    s.push_str("endsolid cube\n");
    s.into_bytes()
}

/// The models in a folder whose name must not reach the G-code, by absolute path, and the dir to remove.
struct Models {
    _dir: TempDir,
    folder: String,
    root: PathBuf,
    files: PathBuf,
}

fn models(tag: &str) -> Models {
    let root = std::env::temp_dir().join(format!("sx-label-paths-{tag}-{}", std::process::id()));
    let folder = format!("private-folder-{}", std::process::id());
    let files = root.join(&folder);
    std::fs::create_dir_all(&files).unwrap();
    std::fs::write(files.join("one.3mf"), unnamed_boxes(1)).unwrap();
    std::fs::write(files.join("two.3mf"), unnamed_boxes(2)).unwrap();
    std::fs::write(files.join("cube.stl"), cube_stl()).unwrap();
    let files = std::fs::canonicalize(&files).unwrap();
    assert!(files.is_absolute());
    Models {
        _dir: TempDir(root.clone()),
        folder,
        root,
        files,
    }
}

/// Label settings for `flavor`, as a config file in `root`.
fn label_config(root: &Path, flavor: &str) -> PathBuf {
    let path = root.join(format!("labels-{flavor}.json"));
    let cfg = json!({"gcode_label_objects": true, "exclude_object": true, "gcode_flavor": flavor, "brim_width": 0, "skirt_loops": 0});
    std::fs::write(&path, cfg.to_string()).unwrap();
    path
}

/// The object names in the label lines: the comment form's name, and the firmware form's name before `_id_`.
fn label_names(g: &str) -> Vec<String> {
    let mut out = Vec::new();
    for l in g.lines() {
        let name = if let Some(r) = l
            .strip_prefix("; printing object ")
            .or_else(|| l.strip_prefix("; stop printing object "))
        {
            r.split(" id:").next()
        } else if let Some(r) = l.strip_prefix("M486 A") {
            r.split("_id_").next()
        } else if let Some(r) = l.strip_prefix("EXCLUDE_OBJECT_DEFINE NAME=") {
            r.split("_id_").next()
        } else {
            None
        };
        if let Some(n) = name
            && !out.iter().any(|o| o == n)
        {
            out.push(n.to_owned());
        }
    }
    out
}

/// No part of the models' folder anywhere in the G-code, and no path separator in a label line.
fn assert_no_folder(g: &str, m: &Models, what: &str) {
    assert!(!g.contains(&m.folder), "{what}: the folder name is in the G-code");
    let parent = m
        .files
        .parent()
        .and_then(Path::file_name)
        .unwrap()
        .to_string_lossy();
    assert!(
        !g.contains(parent.as_ref()),
        "{what}: the parent folder is in the G-code"
    );
    let labels: Vec<&str> = g
        .lines()
        .filter(|l| {
            l.starts_with("; printing object")
                || l.starts_with("; stop printing object")
                || l.starts_with("M486 A")
                || l.starts_with("EXCLUDE_OBJECT")
        })
        .collect();
    assert!(!labels.is_empty(), "{what}: no labels");
    for l in labels {
        assert!(!l.contains('/') && !l.contains('\\'), "{what}: {l}");
    }
}

/// `sx slice <file> --config <labels>` to stdout.
fn plain(file: &Path, config: &Path) -> String {
    let out = sx()
        .arg("slice")
        .arg(file)
        .arg("--config")
        .arg(config)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

/// `sx slice --request` of the files (absolute paths) as objects without names, or with `names`.
fn request(m: &Models, files: &[&str], names: Option<&[&str]>, flavor: &str) -> String {
    let meshes: serde_json::Map<String, serde_json::Value> = files
        .iter()
        .enumerate()
        .map(|(k, f)| (format!("m{k}"), json!(m.files.join(f).to_string_lossy())))
        .collect();
    let objects: Vec<serde_json::Value> = files
        .iter()
        .enumerate()
        .map(|(k, _)| {
            let mut o = json!({"id": format!("o{k}"), "mesh": format!("m{k}")});
            if let Some(n) = names {
                o["name"] = json!(n[k]);
            }
            o
        })
        .collect();
    let req = json!({
        "schemaVersion": 1,
        "meshes": meshes,
        "plate": {"objects": objects},
        "config": {"gcode_label_objects": true, "exclude_object": true, "gcode_flavor": flavor, "brim_width": 0, "skirt_loops": 0},
        "options": {"allowCollisions": true},
    });
    let path = m.root.join(format!("request-{flavor}.json"));
    std::fs::write(&path, req.to_string()).unwrap();
    let dir = m.root.join(format!("out-{flavor}"));
    let out = sx()
        .args(["slice", "--request"])
        .arg(&path)
        .arg("--out-dir")
        .arg(&dir)
        .arg("--allow-collisions")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    std::fs::read_to_string(dir.join("slice.gcode")).unwrap()
}

#[test]
fn a_plain_slice_labels_a_model_by_its_file_name() {
    let m = models("plain");
    for flavor in ["marlin", "klipper"] {
        let cfg = label_config(&m.root, flavor);
        let g = plain(&m.files.join("cube.stl"), &cfg);
        assert_no_folder(&g, &m, &format!("cube.stl {flavor}"));
        assert_eq!(label_names(&g), ["cube.stl"], "{flavor}");
        // A plate sliced as one object takes the file's name; sliced as its build items, each item's place.
        for (file, item_names) in [
            ("one.3mf", &["Object_1"][..]),
            ("two.3mf", &["Object_1", "Object_2"][..]),
        ] {
            let g = plain(&m.files.join(file), &cfg);
            let what = format!("{file} {flavor}");
            assert_no_folder(&g, &m, &what);
            let names = label_names(&g);
            assert!(names == [file] || names == item_names, "{what}: {names:?}");
        }
    }
}

#[test]
fn a_request_labels_a_model_by_its_file_name_or_its_place() {
    let m = models("request");
    for flavor in ["marlin", "klipper"] {
        let what = format!("request {flavor}");
        let g = request(&m, &["cube.stl", "two.3mf"], None, flavor);
        assert_no_folder(&g, &m, &what);
        assert_eq!(label_names(&g), ["cube.stl", "Object_1", "Object_2"], "{what}");
        let g = request(&m, &["one.3mf"], None, flavor);
        assert_no_folder(&g, &m, &what);
        let names = label_names(&g);
        assert!(names == ["one.3mf"] || names == ["Object_1"], "{what}: {names:?}");
        // A client that names each object by its file's name, as the MCP server's slice tool does: a 3MF's items
        // still take their own names.
        let g = request(
            &m,
            &["cube.stl", "two.3mf"],
            Some(&["cube.stl", "two.3mf"]),
            flavor,
        );
        assert_no_folder(&g, &m, &what);
        assert_eq!(label_names(&g), ["cube.stl", "Object_1", "Object_2"], "{what}");
    }
}
