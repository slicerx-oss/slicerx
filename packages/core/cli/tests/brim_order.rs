// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The first layer order of the skirt, the brims and the objects on a plate of several objects. A Prusa project prints
//! the skirt, then every object's brim, then the objects, and brims that meet merge into one (`combine_brims`, set by
//! the project read). Other projects and plain configs keep each object's brim right before that object.
//!
//! The projects in tests/fixtures/brim-order are Prusa MK4S projects of 10 x 10 x 3 mm boxes in a row along X at
//! Y 105, on a 0.2 mm first layer, with one skirt loop and a 3 mm outer brim 0.5 mm off the part: `mk4p--o2` has boxes
//! at X 40 and 125, `mk4p--o3` at X 40, 125 and 210, and `mk4p--touch2` at X 100 and 114 (4 mm apart, so their brims
//! meet). The Bambu Lab A1 project `a1--c1` from tests/fixtures/skirt-brim has three boxes far apart with the same
//! skirt and brim.

#![allow(
    clippy::disallowed_methods,
    clippy::float_cmp,
    clippy::many_single_char_names,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use std::path::{Path, PathBuf};

/// Half the side of each box, mm.
const HALF: f64 = 5.0;

fn fixture(dir: &str, name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/{dir}/{name}.3mf"))
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The G-code of a project, sliced with its own settings and `config` (JSON) over them when given.
fn slice(dir: &str, name: &str, config: Option<&str>) -> String {
    let tag = if config.is_some() { "cfg" } else { "own" };
    let tmp =
        TempDir(std::env::temp_dir().join(format!("sx-brim-order-{name}-{tag}-{}", std::process::id())));
    std::fs::create_dir_all(&tmp.0).unwrap();
    let out = tmp.0.join("out.gcode");
    let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_sx"));
    cmd.arg("slice").arg(fixture(dir, name)).args(["--plate", "1"]);
    if let Some(c) = config {
        let path = tmp.0.join("config.json");
        std::fs::write(&path, c).unwrap();
        cmd.arg("--config").arg(path);
    }
    let o = cmd.arg("-o").arg(&out).output().unwrap();
    assert!(
        o.status.success(),
        "{name}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    std::fs::read_to_string(&out).unwrap()
}

/// One path of the first layer: a run of extruding moves of one feature with no travel between them, and its extent
/// along X, mm.
#[derive(Debug)]
struct Path1 {
    feature: String,
    x0: f64,
    x1: f64,
}

/// The extruding paths of the first layer, in print order. Arcs (G2, G3) count by their end points, which is enough
/// for these boxes.
fn first_layer_paths(gcode: &str) -> Vec<Path1> {
    let (mut x, mut y, mut z) = (0.0_f64, 0.0_f64, 0.0_f64);
    let mut relative_e = false;
    let mut e = 0.0_f64;
    let mut feature = String::new();
    let mut first_z: Option<f64> = None;
    let mut paths: Vec<Path1> = Vec::new();
    let mut open = false;
    for line in gcode.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(';') {
            let rest = rest.trim();
            if let Some(f) = rest
                .strip_prefix("TYPE:")
                .or_else(|| rest.strip_prefix("FEATURE:"))
            {
                f.trim().clone_into(&mut feature);
                open = false;
            }
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        let mut words = code.split_whitespace();
        let Some(cmd) = words.next() else { continue };
        match cmd {
            "M83" => relative_e = true,
            "M82" => relative_e = false,
            "G92" => {
                for w in words {
                    if let Some(v) = w.strip_prefix('E') {
                        e = v.parse().unwrap_or(0.0);
                    }
                }
            }
            "G0" | "G1" | "G2" | "G3" => {
                let get =
                    |c: char| -> Option<f64> { words.clone().find_map(|w| w.strip_prefix(c)?.parse().ok()) };
                let (nx, ny, nz) = (
                    get('X').unwrap_or(x),
                    get('Y').unwrap_or(y),
                    get('Z').unwrap_or(z),
                );
                let de = match get('E') {
                    Some(v) if relative_e => v,
                    Some(v) => {
                        let d = v - e;
                        e = v;
                        d
                    }
                    None => 0.0,
                };
                if nz != z {
                    z = nz;
                    open = false;
                }
                let moves = nx != x || ny != y;
                // The start G-code's purge line is not part of the plate.
                let plate = !feature.is_empty() && feature != "Custom";
                if de > 0.0 && moves && plate {
                    let fz = *first_z.get_or_insert(z);
                    if z > fz + 1e-3 {
                        break;
                    }
                    if !open {
                        paths.push(Path1 {
                            feature: feature.clone(),
                            x0: x,
                            x1: x,
                        });
                        open = true;
                    }
                    let p = paths.last_mut().unwrap();
                    p.x0 = p.x0.min(nx);
                    p.x1 = p.x1.max(nx);
                } else if moves {
                    open = false;
                }
                (x, y) = (nx, ny);
            }
            _ => {}
        }
    }
    paths
}

fn is_wall(p: &Path1) -> bool {
    p.feature.ends_with("wall")
}

/// The box (index into `xs`) a path lies nearest by the middle of its X extent.
fn box_of(p: &Path1, xs: &[f64]) -> usize {
    let mid = f64::midpoint(p.x0, p.x1);
    (0..xs.len())
        .min_by(|&a, &b| (xs[a] - mid).abs().total_cmp(&(xs[b] - mid).abs()))
        .unwrap()
}

/// What the first layer prints, in order: `S` for the skirt, `B<k>` for brim paths round box `k`, `W<k>` for box `k`'s
/// walls and fill; repeats of one in a row are one. Boxes count from 1 at the left.
fn order(name: &str, paths: &[Path1], xs: &[f64]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in paths {
        let t = match p.feature.as_str() {
            "Skirt" => "S".to_owned(),
            "Brim" => format!("B{}", box_of(p, xs) + 1),
            _ => format!("W{}", box_of(p, xs) + 1),
        };
        if out.last() != Some(&t) {
            out.push(t);
        }
    }
    assert!(!out.is_empty(), "{name}: no first layer");
    out
}

/// The skirt, then every box's brim, then every box, each box once.
fn assert_brims_first(name: &str, paths: &[Path1], xs: &[f64]) {
    let o = order(name, paths, xs);
    assert_eq!(o.first().map(String::as_str), Some("S"), "{name}: {o:?}");
    let first_wall = paths.iter().position(is_wall).expect("a wall");
    let last_brim = paths.iter().rposition(|p| p.feature == "Brim").expect("a brim");
    assert!(
        last_brim < first_wall,
        "{name}: a brim prints after a wall: {o:?}"
    );
    for k in 1..=xs.len() {
        assert!(
            o.contains(&format!("B{k}")),
            "{name}: no brim round box {k}: {o:?}"
        );
        let w = format!("W{k}");
        assert_eq!(
            o.iter().filter(|t| **t == w).count(),
            1,
            "{name}: box {k} prints in pieces: {o:?}"
        );
    }
}

/// The skirt, then each box's brim right before that box.
fn assert_brim_before_its_object(name: &str, paths: &[Path1], xs: &[f64]) {
    let o = order(name, paths, xs);
    assert_eq!(o.first().map(String::as_str), Some("S"), "{name}: {o:?}");
    assert_eq!(o.len(), 1 + 2 * xs.len(), "{name}: {o:?}");
    for pair in o[1..].chunks(2) {
        let k = pair[0]
            .strip_prefix('B')
            .unwrap_or_else(|| panic!("{name}: {o:?}"));
        assert_eq!(pair[1], format!("W{k}"), "{name}: {o:?}");
    }
}

#[test]
fn a_prusa_project_prints_every_brim_before_the_objects() {
    for (name, xs) in [
        ("mk4p--o2", &[40.0, 125.0][..]),
        ("mk4p--o3", &[40.0, 125.0, 210.0][..]),
    ] {
        let paths = first_layer_paths(&slice("brim-order", name, None));
        assert_brims_first(name, &paths, xs);
        // Far apart, each brim stays round its own box: no brim path reaches past the room between two boxes.
        for p in paths.iter().filter(|p| p.feature == "Brim") {
            let c = xs[box_of(p, xs)];
            assert!(
                p.x0 > c - HALF - 4.0 && p.x1 < c + HALF + 4.0,
                "{name}: brim {p:?} leaves box at {c}"
            );
        }
    }
}

#[test]
fn touching_brims_of_a_prusa_project_merge_into_one() {
    let name = "mk4p--touch2";
    let xs = [100.0, 114.0];
    let paths = first_layer_paths(&slice("brim-order", name, None));
    assert_brims_first(name, &paths, &xs);
    // One brim loop goes round both boxes: from 3.5 mm left of the left box to 3.5 mm right of the right one (x 91.5
    // to 122.5 to the bead's center, read as 92 to 122 within half a millimeter).
    let shared = paths
        .iter()
        .filter(|p| p.feature == "Brim")
        .any(|p| p.x0 <= 92.5 && p.x1 >= 121.5);
    assert!(shared, "{name}: no brim loop round both boxes: {paths:?}");
}

#[test]
fn other_projects_and_a_config_that_turns_combining_off_keep_each_brim_before_its_object() {
    // A Bambu Lab project, which leaves combine_brims at its default.
    let name = "a1--c1";
    let paths = first_layer_paths(&slice("skirt-brim", name, None));
    let mut xs: Vec<f64> = paths
        .iter()
        .filter(|p| is_wall(p))
        .map(|p| f64::midpoint(p.x0, p.x1).round())
        .collect();
    xs.sort_by(f64::total_cmp);
    xs.dedup_by(|a, b| (*a - *b).abs() < 2.0 * HALF);
    assert_eq!(xs.len(), 3, "{name}: {xs:?}");
    assert_brim_before_its_object(name, &paths, &xs);
    // A Prusa project with combine_brims off given over its settings.
    let name = "mk4p--o3";
    let paths = first_layer_paths(&slice("brim-order", name, Some(r#"{"combine_brims":false}"#)));
    assert_brim_before_its_object(name, &paths, &[40.0, 125.0, 210.0]);
}
