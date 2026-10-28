// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where the skirt of a plate sliced as one session sits. It keeps `skirt_distance` from the outer edge of the brim
//! loops the first layer prints (`brim_object_gap` plus the loops' width, out from the outline before elephant foot
//! compensation), or without a brim from that outline, plus half a first layer line spacing. Every skirt layer prints
//! the first layer's loops. The loop is the hull of the boxes grown by that offset.
//!
//! The projects in tests/fixtures/skirt-offset (and the reused ones in tests/fixtures/skirt-brim) are 10 x 10 x 3 mm
//! boxes in a row along X on a 0.2 mm first layer, three of them 0.34 bed widths apart (`far`) or 3 mm apart (`close`,
//! c2), or one box (k9). Skirt: one loop 2 mm out on 3 layers. Brim: 3 mm wide with a 0.5 mm gap.
//!
//! | case | change from c1 |
//! |---|---|
//! | c1 | |
//! | c2 | close |
//! | c3 | no brim, `skirt_distance` 4, 2 loops on 2 layers |
//! | k1 | no brim |
//! | k4 | `skirt_distance` 4 |
//! | k5 | brim 5 mm |
//! | k7 | first layer line width 0.7 |
//! | k8 | elephant foot compensation 0 |
//! | k9 | one box |
//! | pw1, pw6 | brim 1 and 6 mm, compensation 0 |
//! | pg0 | brim gap 0, compensation 0 |
//! | pe2 | brim 2 mm, compensation 0.2 |
//!
//! Printers: `a1` (first layer 0.5 mm, compensation 0.075) and `p1s` (0.15) are projects with their own settings;
//! `prusa-mk4` (first layer 0.48, no compensation) and `creality-ender-3-v3` (first layer 0.42) slice the project with
//! the printer's stock settings in the fixture's JSON. `mk4p` is a Prusa project (settings in `Slic3r_PE.config`,
//! first layer 0.5, compensation 0.2).
//!
//! Offsets are side offsets: the skirt loop's bounding box against the outer walls of the outermost boxes, each of
//! its four sides, mm (the loop's centerline on its straight sides).

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use std::path::{Path, PathBuf};

/// Half the side of each box, mm.
const HALF: f64 = 5.0;
/// How near a side offset must come, mm.
const OFFSET_TOL: f64 = 0.03;
/// How near a loop's length must come, mm.
const LENGTH_TOL: f64 = 0.6;

fn fixture(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let own = dir.join(format!("skirt-offset/{name}.3mf"));
    if own.exists() {
        own
    } else {
        dir.join(format!("skirt-brim/{name}.3mf"))
    }
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The G-code of a case. `printer--case` names a project; a printer with a stock settings JSON in the fixtures
/// slices its one project with those settings instead, `brim` setting the brim width.
fn slice(name: &str, brim: Option<f64>) -> String {
    static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir =
        TempDir(std::env::temp_dir().join(format!("sx-skirt-offset-{name}-{}-{n}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let out = dir.0.join("out.gcode");
    let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_sx"));
    cmd.arg("slice");
    let (printer, _) = name.split_once("--").unwrap();
    let stock =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/skirt-offset/{printer}.json"));
    if stock.exists() {
        let mut cfg: serde_json::Value = serde_json::from_slice(&std::fs::read(&stock).unwrap()).unwrap();
        if let Some(b) = brim {
            cfg["brim_width"] = serde_json::json!(b);
        }
        let at = dir.0.join("config.json");
        std::fs::write(&at, cfg.to_string()).unwrap();
        cmd.arg(fixture(printer))
            .arg("--config")
            .arg(at)
            .arg("--no-project-settings");
    } else {
        cmd.arg(fixture(name));
    }
    let o = cmd.args(["--plate", "1", "-o"]).arg(&out).output().unwrap();
    assert!(
        o.status.success(),
        "{name}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    std::fs::read_to_string(&out).unwrap()
}

/// One path: its feature, its height and its points, mm.
struct PathRun {
    feature: String,
    z: f64,
    points: Vec<[f64; 2]>,
}

impl PathRun {
    fn length(&self) -> f64 {
        self.points
            .windows(2)
            .map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]))
            .sum()
    }
}

/// The extruding paths from the first layer change on: runs of moves of one feature that start where the one before
/// ended (within 0.1 mm).
fn paths(gcode: &str) -> Vec<PathRun> {
    let (mut x, mut y, mut z) = (0.0f64, 0.0f64, 0.0f64);
    let (mut relative, mut e_abs, mut started) = (true, 0.0f64, false);
    let mut feature = String::new();
    let mut out: Vec<PathRun> = Vec::new();
    for line in gcode.lines() {
        if line.starts_with("; CHANGE_LAYER") || line.starts_with(";LAYER_CHANGE") {
            started = true;
        }
        if let Some(f) = line
            .strip_prefix("; FEATURE: ")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            f.trim().clone_into(&mut feature);
        }
        let code = line.split(';').next().unwrap_or("").trim();
        let get = |c: char| {
            code.split_whitespace()
                .skip(1)
                .find_map(|w| w.strip_prefix(c))
                .and_then(|v| v.parse::<f64>().ok())
        };
        match code.split_whitespace().next().unwrap_or("") {
            "M83" => relative = true,
            "M82" => relative = false,
            "G92" => e_abs = get('E').unwrap_or(e_abs),
            "G0" | "G1" | "G2" | "G3" => {
                let (nx, ny, nz) = (
                    get('X').unwrap_or(x),
                    get('Y').unwrap_or(y),
                    get('Z').unwrap_or(z),
                );
                let de = get('E').map_or(0.0, |v| {
                    if relative {
                        v
                    } else {
                        let d = v - e_abs;
                        e_abs = v;
                        d
                    }
                });
                if started && de > 1e-9 && (nx != x || ny != y) {
                    let joins = out.last().is_some_and(|p| {
                        p.feature == feature
                            && p.z == nz
                            && p.points.last().is_some_and(|q| (q[0] - x).hypot(q[1] - y) < 0.1)
                    });
                    match out.last_mut() {
                        Some(p) if joins => p.points.push([nx, ny]),
                        _ => out.push(PathRun {
                            feature: feature.clone(),
                            z: nz,
                            points: vec![[x, y], [nx, ny]],
                        }),
                    }
                }
                (x, y, z) = (nx, ny, nz);
            }
            _ => {}
        }
    }
    out
}

/// The boxes' centers, left to right: the middle of each box's first layer outer wall.
fn centers(ps: &[PathRun]) -> Vec<[f64; 2]> {
    let z0 = ps.iter().map(|p| p.z).fold(f64::MAX, f64::min);
    // Each outer wall path lies on one box: paths whose middles are within a box's half side are one box.
    let mut boxes: Vec<([f64; 2], [f64; 2])> = Vec::new();
    for p in ps.iter().filter(|p| p.z == z0 && p.feature == "Outer wall") {
        let lo = p
            .points
            .iter()
            .fold([f64::MAX; 2], |a, q| [a[0].min(q[0]), a[1].min(q[1])]);
        let hi = p
            .points
            .iter()
            .fold([f64::MIN; 2], |a, q| [a[0].max(q[0]), a[1].max(q[1])]);
        let mid = [f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1])];
        match boxes.iter_mut().find(|(a, b)| {
            (f64::midpoint(a[0], b[0]) - mid[0]).abs() < HALF
                && (f64::midpoint(a[1], b[1]) - mid[1]).abs() < HALF
        }) {
            Some((a, b)) => {
                *a = [a[0].min(lo[0]), a[1].min(lo[1])];
                *b = [b[0].max(hi[0]), b[1].max(hi[1])];
            }
            None => boxes.push((lo, hi)),
        }
    }
    let mut cs: Vec<[f64; 2]> = boxes
        .iter()
        .map(|(a, b)| [f64::midpoint(a[0], b[0]), f64::midpoint(a[1], b[1])])
        .collect();
    cs.sort_by(|a, b| a[0].total_cmp(&b[0]));
    cs
}

/// One skirt loop: its side offsets (left, bottom, right, top) and its length, mm.
struct Loop {
    sides: [f64; 4],
    length: f64,
}

/// The skirt loops of every skirt layer, innermost first, by layer height in hundredths of a mm.
fn skirt_layers(name: &str, ps: &[PathRun]) -> Vec<(i64, Vec<Loop>)> {
    let cs = centers(ps);
    let left = cs.iter().map(|c| c[0]).fold(f64::MAX, f64::min) - HALF;
    let right = cs.iter().map(|c| c[0]).fold(f64::MIN, f64::max) + HALF;
    let bottom = cs.iter().map(|c| c[1]).fold(f64::MAX, f64::min) - HALF;
    let top = cs.iter().map(|c| c[1]).fold(f64::MIN, f64::max) + HALF;
    let mut out: Vec<(i64, Vec<Loop>)> = Vec::new();
    for p in ps.iter().filter(|p| p.feature == "Skirt") {
        let lo = p
            .points
            .iter()
            .fold([f64::MAX; 2], |a, q| [a[0].min(q[0]), a[1].min(q[1])]);
        let hi = p
            .points
            .iter()
            .fold([f64::MIN; 2], |a, q| [a[0].max(q[0]), a[1].max(q[1])]);
        let l = Loop {
            sides: [left - lo[0], bottom - lo[1], hi[0] - right, hi[1] - top],
            length: p.length(),
        };
        let z = (p.z * 100.0).round() as i64;
        match out.last_mut() {
            Some((at, v)) if *at == z => v.push(l),
            _ => out.push((z, vec![l])),
        }
    }
    assert!(!out.is_empty(), "{name}: no skirt");
    for (_, v) in &mut out {
        v.sort_by(|a, b| a.sides[0].total_cmp(&b.sides[0]));
    }
    out
}

/// Every skirt layer prints loops at `offsets` (innermost first) on each side, the innermost `length` mm long when
/// one is given. Returns the layers' heights in hundredths of a mm.
fn assert_skirt(name: &str, brim: Option<f64>, offsets: &[f64], length: Option<f64>) -> Vec<i64> {
    let ps = paths(&slice(name, brim));
    let layers = skirt_layers(name, &ps);
    for (z, loops) in &layers {
        let got: Vec<[f64; 4]> = loops.iter().map(|l| l.sides).collect();
        assert_eq!(loops.len(), offsets.len(), "{name} at {z}: loops {got:.3?}");
        for (l, want) in loops.iter().zip(offsets) {
            assert!(
                l.sides.iter().all(|s| (s - want).abs() <= OFFSET_TOL),
                "{name} at {z}: skirt sides {:.3?}, not {want}",
                l.sides
            );
        }
        if let (Some(want), Some(l)) = (length, loops.first()) {
            assert!(
                (l.length - want).abs() <= LENGTH_TOL,
                "{name} at {z}: skirt {:.2} mm, not {want}",
                l.length
            );
        }
    }
    layers.iter().map(|(z, _)| *z).collect()
}

#[test]
fn the_skirt_keeps_its_distance_from_the_printed_brim_loops_on_every_layer() {
    // S-e: brim gap 0.5 + 6 loops of 0.457 + 2 + half a spacing 0.229, from the outline before compensation.
    for (name, length) in [
        ("a1--c1", 422.4),
        ("a1--c2", 126.2),
        ("a1--k9", 74.2),
        ("p1s--c1", 422.4),
    ] {
        assert_eq!(
            assert_skirt(name, None, &[5.47], Some(length)),
            [20, 40, 60],
            "{name}"
        );
    }
    // S-f: 10 loops of a 5 mm brim end at 4.84; 0.7 mm first layer lines print 4 loops.
    assert_skirt("a1--k5", None, &[7.30], Some(433.9));
    assert_skirt("a1--k7", None, &[5.46], Some(422.3));
    // Without elephant foot compensation the brim and the skirt stay where they were.
    assert_skirt("a1--k8", None, &[5.47], Some(422.4));
}

#[test]
fn the_printed_brim_sets_the_skirt_on_stock_printer_settings() {
    // First layer 0.48 mm on the MK4: 6 loops end at 2.90, 10 loops of a 5 mm brim at 4.65.
    assert_skirt("prusa-mk4--c1", None, &[5.34], Some(413.4));
    assert_skirt("prusa-mk4--k5", Some(5.0), &[7.09], Some(424.4));
    // 0.42 mm lines on the Ender: 6 loops of 0.377 end at 2.57, nearer than the nominal 3 mm; 12 loops at 4.83.
    assert_skirt("creality-ender-3-v3--c1", None, &[4.95], Some(370.2));
    assert_skirt("creality-ender-3-v3--k5", Some(5.0), &[7.21], Some(384.4));
}

#[test]
fn without_a_brim_the_skirt_measures_from_the_outline_before_compensation() {
    // S-g: 2 + half a 0.5 mm line's spacing, on every skirt layer.
    for (name, length) in [("a1--k1", 401.9), ("p1s--k1", 401.9), ("mk4p--k1", 393.8)] {
        assert_eq!(
            assert_skirt(name, None, &[2.23], Some(length)),
            [20, 40, 60],
            "{name}"
        );
    }
    // Two loops, one spacing apart, on both skirt layers.
    assert_eq!(assert_skirt("a1--c3", None, &[4.23, 4.69], None), [20, 40]);
}

/// The skirt's nearest distance to each box (left to right) on each skirt layer, mm.
fn nearest_by_layer(ps: &[PathRun]) -> Vec<(i64, Vec<f64>)> {
    let cs = centers(ps);
    let dist = |p: [f64; 2], c: [f64; 2]| {
        ((p[0] - c[0]).abs() - HALF)
            .max(0.0)
            .hypot(((p[1] - c[1]).abs() - HALF).max(0.0))
    };
    let mut out: Vec<(i64, Vec<f64>)> = Vec::new();
    for p in ps.iter().filter(|p| p.feature == "Skirt") {
        let z = (p.z * 100.0).round() as i64;
        let near: Vec<f64> = cs
            .iter()
            .map(|&c| p.points.iter().map(|&q| dist(q, c)).fold(f64::MAX, f64::min))
            .collect();
        match out.last_mut() {
            Some((at, v)) if *at == z => {
                for (a, b) in v.iter_mut().zip(near) {
                    *a = a.min(b);
                }
            }
            _ => out.push((z, near)),
        }
    }
    out
}

#[test]
fn the_plate_skirt_prints_the_first_layers_loop_on_every_skirt_layer() {
    // Objects with settings of their own: 3 mm brims on objects 1 and 2, 6 mm on object 3 (12 loops end at 6.04).
    let name = "a1--c6";
    let layers = nearest_by_layer(&paths(&slice(name, None)));
    assert_eq!(layers.iter().map(|(z, _)| *z).collect::<Vec<_>>(), [20, 40, 60]);
    for (z, near) in &layers {
        for (k, want) in [(0, 5.47), (2, 8.21)] {
            assert!(
                (near[k] - want).abs() <= OFFSET_TOL,
                "{name} at {z}: {:.3} from object {}, not {want}",
                near[k],
                k + 1
            );
        }
        // Object 2 is the middle one, which the loop passes far from.
        assert!(
            [0, 2].iter().all(|&k| (near[k] - layers[0].1[k]).abs() <= 0.01),
            "{name} at {z}: {near:.3?}, the first layer {:.3?}",
            layers[0].1
        );
    }
}

#[test]
fn a_prusa_projects_skirt_keeps_its_distance_from_the_nominal_brim_edge() {
    // S-a: the brim gap 0.5 + 3 + 2 + half a spacing 0.229, less the 0.2 compensation, on every skirt layer.
    assert_eq!(assert_skirt("mk4p--c2", None, &[5.53], None), [20, 40, 60]);
    let ps = paths(&slice("mk4p--c2", None));
    let length = skirt_layers("mk4p--c2", &ps)[0].1[0].length;
    assert!(
        (124.0..=127.0).contains(&length),
        "mk4p--c2: skirt {length:.1} mm"
    );
    // S-b
    assert_skirt("mk4p--c1", None, &[5.53], Some(414.2));
    assert_skirt("mk4p--k9", None, &[5.53], None);
    assert_skirt("mk4p--k4", None, &[7.53], None);
    // S-c: the nominal 5 mm, not the 10 loops printed (which end at 4.84).
    assert_skirt("mk4p--k5", None, &[7.53], None);
    // S-d and the sweep: one mm of offset per mm of brim width, of gap and of compensation; 0.7 mm lines add 0.1.
    for (name, offset) in [
        ("mk4p--k8", 5.73),
        ("mk4p--k7", 5.63),
        ("mk4p--pw1", 3.73),
        ("mk4p--pw6", 8.73),
        ("mk4p--pg0", 5.23),
        ("mk4p--pe2", 4.53),
    ] {
        assert_skirt(name, None, &[offset], None);
    }
}

#[test]
fn a_prusa_projects_plate_skirt_keeps_its_distance_from_each_nominal_brim_edge() {
    // S-h: objects with settings of their own, 3 mm brims on objects 1 and 2, 6 mm on object 3: the loop's left side
    // is object 1's, its right side object 3's.
    let name = "mk4p--c6";
    let layers = skirt_layers(name, &paths(&slice(name, None)));
    assert_eq!(layers.iter().map(|(z, _)| *z).collect::<Vec<_>>(), [20, 40, 60]);
    for (z, loops) in &layers {
        assert_eq!(loops.len(), 1, "{name} at {z}");
        let sides = loops[0].sides;
        for (side, want) in [(0, 5.53), (2, 8.53)] {
            assert!(
                (sides[side] - want).abs() <= OFFSET_TOL,
                "{name} at {z}: skirt sides {sides:.3?}, not {want} on side {side}"
            );
        }
    }
}
