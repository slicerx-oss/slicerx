// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The skirt and brim of a plate of several objects printed layer by layer. The plate prints one skirt round all of
//! its objects, also when some have settings or layer heights of their own: it keeps `skirt_distance` from each
//! object's own brim, and prints whole on the plate's first `skirt_height` layers (every layer under a draft shield).
//! Brims of objects close together share the room between them: the gap is filled once and no bead prints over
//! another, so those plates slice without crossing paths.
//!
//! The projects in tests/fixtures/skirt-brim are 10 x 10 x 3 mm boxes in a row along X, objects 1, 2, 3 from the
//! left, on a 0.2 mm first layer: `far` plates stand them 0.34 bed widths apart, `close` ones 3 mm apart. Skirt
//! S1 is one loop 2 mm out on 3 layers; brim B3 is 3 mm wide with a 0.5 mm gap.
//!
//! | case | layout | objects | plate |
//! |---|---|---|---|
//! | c1 | far | 0.2 mm x 3 | S1, B3 |
//! | c2 | close | 0.2 mm x 3 | S1, B3 |
//! | c5co | close | 0.2 mm x 3 | S1, skirt per object |
//! | c6 | far | object 2 at 40% infill, object 3 with a 6 mm brim | S1, B3 |
//! | c16 | close | object 2 at 40% infill | S1, B3 |
//! | c7 | far | 0.1 / 0.2 / 0.3 mm layers | S1, B3 |
//! | c8 | far | 0.15 / 0.25 mm layers (two objects) | S1 |
//! | c15 | far | 0.1 / 0.2 / 0.3 mm layers | S1 on 5 layers |
//! | c14 | close | 0.1 / 0.2 / 0.3 mm layers | S1, B3 |
//! | c11 | far | 0.1 / 0.2 / 0.3 mm layers | one loop on 1 layer, draft shield on |
//!
//! Paths are read from the G-code's geometry and feature comments: a path is a run of extruding moves of one feature
//! that start where the one before ended (within 0.1 mm), and a move belongs to the box it lies in.

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Half the side of each box, mm.
const HALF: f64 = 5.0;

fn sx() -> Command {
    Command::new(env!("CARGO_BIN_EXE_sx"))
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/skirt-brim/{name}.3mf"))
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run(name: &str) -> (Output, Option<String>) {
    // Tests run at once and slice the same projects: each run has a folder of its own.
    static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = TempDir(std::env::temp_dir().join(format!("sx-skirt-brim-{name}-{}-{n}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let out = dir.0.join("out.gcode");
    let o = sx()
        .arg("slice")
        .arg(fixture(name))
        .args(["--plate", "1", "-o"])
        .arg(&out)
        .output()
        .unwrap();
    let gcode = std::fs::read_to_string(&out).ok();
    (o, gcode)
}

/// The project's G-code; the slice must succeed without `--allow-collisions`.
fn slice(name: &str) -> String {
    let (o, gcode) = run(name);
    assert!(
        o.status.success(),
        "{name}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    gcode.unwrap()
}

/// Where the project puts the boxes: their X centers, left to right, and their Y center, mm.
fn placed(name: &str) -> (Vec<f64>, f64) {
    let (printer, case) = name.split_once("--").unwrap();
    let close = matches!(case, "c2" | "c5co" | "c14" | "c16");
    match (printer, close, case) {
        ("a1" | "p1s", false, "c8") => (vec![84.48, 171.52], 128.0),
        ("a1" | "p1s", false, _) => (vec![40.96, 128.0, 215.04], 128.0),
        ("a1" | "p1s", true, _) => (vec![115.0, 128.0, 141.0], 128.0),
        ("mk4p", false, _) => (vec![40.0, 125.0, 210.0], 105.0),
        ("mk4p", true, _) => (vec![112.0, 125.0, 138.0], 105.0),
        other => panic!("no centers for {other:?}"),
    }
}

/// The X centers of the boxes, left to right, and their Y center, mm: the middle of each box's first layer outer
/// wall in the G-code, near where the project puts it (a printer may print the plate shifted on its bed).
fn centers_in(name: &str, ps: &[PathRun]) -> (Vec<f64>, f64) {
    let (xs, y0) = placed(name);
    let z0 = layer_cents(ps).first().copied().unwrap();
    let mut ys = Vec::new();
    let xs = xs
        .iter()
        .map(|&x| {
            let pts: Vec<[f64; 2]> = ps
                .iter()
                .filter(|p| cents(p.z) == z0 && p.feature == "Outer wall")
                .flat_map(|p| p.points.iter().copied())
                .filter(|q| (q[0] - x).abs() < 7.0 && (q[1] - y0).abs() < 7.0)
                .collect();
            assert!(!pts.is_empty(), "{name}: no outer wall near x {x}");
            let lo = pts
                .iter()
                .fold([f64::MAX; 2], |a, q| [a[0].min(q[0]), a[1].min(q[1])]);
            let hi = pts
                .iter()
                .fold([f64::MIN; 2], |a, q| [a[0].max(q[0]), a[1].max(q[1])]);
            ys.push(f64::midpoint(lo[1], hi[1]));
            f64::midpoint(lo[0], hi[0])
        })
        .collect();
    (xs, ys.iter().sum::<f64>() / ys.len() as f64)
}

/// One path: its feature, its height and its points, mm.
#[derive(Debug, Clone)]
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

    /// Whether the path, as a closed ring, goes round `p`.
    fn encloses(&self, p: [f64; 2]) -> bool {
        let n = self.points.len();
        let mut inside = false;
        for i in 0..n {
            let a = self.points[i];
            let b = self.points[(i + 1) % n];
            if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
                inside = !inside;
            }
        }
        inside
    }
}

/// The extruding paths from the first layer change on.
fn paths(gcode: &str) -> Vec<PathRun> {
    let (mut x, mut y, mut z) = (0.0f64, 0.0f64, 0.0f64);
    let mut relative = true;
    let mut e_abs = 0.0f64;
    let mut started = false;
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
        let word = code.split_whitespace().next().unwrap_or("");
        match word {
            "M83" => relative = true,
            "M82" => relative = false,
            "G92" => {
                if let Some(v) = code.split_whitespace().find_map(|w| w.strip_prefix('E')) {
                    e_abs = v.parse().unwrap();
                }
            }
            "G0" | "G1" | "G2" | "G3" => {
                let get = |c: char| {
                    code.split_whitespace()
                        .skip(1)
                        .find_map(|w| w.strip_prefix(c))
                        .and_then(|v| v.parse::<f64>().ok())
                };
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

/// Heights in mm as hundredths, so lists compare exactly.
fn cents(z: f64) -> i64 {
    (z * 100.0).round() as i64
}

/// The heights of the plate's layers that print any path, rising.
fn layer_cents(ps: &[PathRun]) -> Vec<i64> {
    let mut v: Vec<i64> = ps.iter().map(|p| cents(p.z)).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// Distance from `p` to box `k`'s edge (0-based), mm; negative inside.
fn box_dist(p: [f64; 2], xs: &[f64], y0: f64, k: usize) -> f64 {
    let (dx, dy) = ((p[0] - xs[k]).abs() - HALF, (p[1] - y0).abs() - HALF);
    if dx <= 0.0 && dy <= 0.0 {
        dx.max(dy)
    } else {
        dx.max(0.0).hypot(dy.max(0.0))
    }
}

/// The box (1 from the left) whose edge `p` is nearest to.
fn nearest_box(p: [f64; 2], xs: &[f64], y0: f64) -> usize {
    (0..xs.len())
        .min_by(|&a, &b| box_dist(p, xs, y0, a).total_cmp(&box_dist(p, xs, y0, b)))
        .unwrap()
        + 1
}

/// The box (1 from the left) that `p` lies in, within 0.3 mm.
fn in_box(p: [f64; 2], xs: &[f64], y0: f64) -> Option<usize> {
    (0..xs.len())
        .find(|&k| box_dist(p, xs, y0, k) <= 0.3)
        .map(|k| k + 1)
}

/// The skirt paths, by layer height in hundredths of a mm.
fn skirts(ps: &[PathRun]) -> Vec<(i64, Vec<&PathRun>)> {
    let mut out: Vec<(i64, Vec<&PathRun>)> = Vec::new();
    for p in ps.iter().filter(|p| p.feature == "Skirt") {
        match out.last_mut() {
            Some((z, v)) if *z == cents(p.z) => v.push(p),
            _ => out.push((cents(p.z), vec![p])),
        }
    }
    out
}

/// The single skirt loop of every skirt layer: one closed path round every box, its length within `tol` of `length`.
/// Returns the layers' heights.
fn one_loop_round_all(name: &str, ps: &[PathRun], length: f64, tol: f64) -> Vec<i64> {
    let (xs, y0) = centers_in(name, ps);
    let layers = skirts(ps);
    assert!(!layers.is_empty(), "{name}: no skirt");
    for (z, loops) in &layers {
        assert_eq!(loops.len(), 1, "{name} at {z}: {} skirt paths", loops.len());
        let l = loops[0];
        for x in &xs {
            assert!(
                l.encloses([*x, y0]),
                "{name} at {z}: the skirt misses the box at x {x}"
            );
        }
        assert!(
            (l.length() - length).abs() <= tol,
            "{name} at {z}: skirt {:.1} mm, not {length} +- {tol}",
            l.length()
        );
    }
    layers.iter().map(|(z, _)| *z).collect()
}

/// The skirt's nearest distance to box `k` (1 from the left) on the first layer, mm.
fn skirt_offset(name: &str, ps: &[PathRun], k: usize) -> f64 {
    let (xs, y0) = centers_in(name, ps);
    let first = skirts(ps).into_iter().next().unwrap().1;
    first
        .iter()
        .flat_map(|p| p.points.iter())
        .map(|&q| box_dist(q, &xs, y0, k - 1))
        .fold(f64::MAX, f64::min)
}

/// The first layer's paths.
fn first_layer(ps: &[PathRun]) -> Vec<&PathRun> {
    let z0 = layer_cents(ps).first().copied().unwrap();
    ps.iter().filter(|p| cents(p.z) == z0).collect()
}

/// Points along a path every `step` mm, each with the length it stands for.
fn samples(p: &PathRun, step: f64) -> Vec<([f64; 2], f64)> {
    let mut out = Vec::new();
    for w in p.points.windows(2) {
        let (from, to) = (w[0], w[1]);
        let len = (to[0] - from[0]).hypot(to[1] - from[1]);
        let count = (len / step).ceil().max(1.0) as usize;
        for i in 0..count {
            let t = (i as f64 + 0.5) / count as f64;
            out.push((
                [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t],
                len / count as f64,
            ));
        }
    }
    out
}

fn segment_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (vx, vy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = vx * vx + vy * vy;
    let t = if l2 == 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2).clamp(0.0, 1.0)
    };
    (p[0] - a[0] - t * vx).hypot(p[1] - a[1] - t * vy)
}

/// The nearest distance from `p` to any of `paths`, mm.
fn dist_to(p: [f64; 2], paths: &[&PathRun]) -> f64 {
    paths
        .iter()
        .flat_map(|q| q.points.windows(2))
        .map(|w| segment_dist(p, w[0], w[1]))
        .fold(f64::MAX, f64::min)
}

/// How much of the first layer's skirt and brim runs within 0.3 mm of another skirt or brim path (less than a
/// line width: one bead printed over another), mm.
fn overlap(ps: &[PathRun]) -> f64 {
    let first = first_layer(ps);
    let ours: Vec<&PathRun> = first
        .iter()
        .copied()
        .filter(|p| p.feature == "Skirt" || p.feature == "Brim")
        .collect();
    let mut total = 0.0;
    for (i, p) in ours.iter().enumerate() {
        let others: Vec<&PathRun> = ours
            .iter()
            .enumerate()
            .filter(|(j, _)| *j != i)
            .map(|(_, q)| *q)
            .collect();
        for (s, w) in samples(p, 0.2) {
            if dist_to(s, &others) < 0.3 {
                total += w;
            }
        }
    }
    total
}

/// The nearest a first layer skirt or brim path comes to a wall of a box, mm.
fn nearest_wall(ps: &[PathRun]) -> f64 {
    let first = first_layer(ps);
    let walls: Vec<&PathRun> = first
        .iter()
        .copied()
        .filter(|p| p.feature == "Outer wall" || p.feature == "Inner wall")
        .collect();
    first
        .iter()
        .filter(|p| p.feature == "Skirt" || p.feature == "Brim")
        .flat_map(|p| samples(p, 0.2))
        .map(|(s, _)| dist_to(s, &walls))
        .fold(f64::MAX, f64::min)
}

/// The number of brim loops round each box (1 from the left) on the first layer.
fn brim_loops(name: &str, ps: &[PathRun]) -> Vec<usize> {
    let (xs, y0) = centers_in(name, ps);
    let mut n = vec![0; xs.len()];
    for p in first_layer(ps).iter().filter(|p| p.feature == "Brim") {
        n[nearest_box(p.points[0], &xs, y0) - 1] += 1;
    }
    n
}

/// What the first layer prints, in order: `S` for the skirt, `B<k>` for a brim path nearest box `k`, `<k>` for box
/// `k`'s own paths; repeats of one in a row are one.
fn first_layer_order(name: &str, ps: &[PathRun]) -> Vec<String> {
    let (xs, y0) = centers_in(name, ps);
    let mut out: Vec<String> = Vec::new();
    for p in first_layer(ps) {
        let t = match p.feature.as_str() {
            "Skirt" => "S".to_owned(),
            "Brim" => format!("B{}", nearest_box(p.points[0], &xs, y0)),
            _ => match in_box(p.points[0], &xs, y0) {
                Some(k) => k.to_string(),
                None => continue,
            },
        };
        if out.last() != Some(&t) {
            out.push(t);
        }
    }
    out
}

/// The skirt first, then each box's brim right before that box, each once.
fn assert_brim_before_its_object(name: &str, order: &[String]) {
    assert_eq!(order.first().map(String::as_str), Some("S"), "{name}: {order:?}");
    assert_eq!(order.iter().filter(|t| *t == "S").count(), 1, "{name}: {order:?}");
    let objects: Vec<&String> = order.iter().filter(|t| t.parse::<usize>().is_ok()).collect();
    let mut sorted = objects.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(
        sorted.len(),
        objects.len(),
        "{name}: an object prints twice: {order:?}"
    );
    for (i, t) in order.iter().enumerate() {
        if let Some(k) = t.strip_prefix('B') {
            assert_eq!(order.get(i + 1).map(String::as_str), Some(k), "{name}: {order:?}");
        }
    }
}

#[test]
fn objects_with_settings_of_their_own_get_one_skirt_round_all_at_each_brims_width() {
    // T-a: object 3's 6 mm brim keeps the skirt further out there; objects 1 and 2 keep 3 mm brims.
    let name = "a1--c6";
    let ps = paths(&slice(name));
    assert_eq!(one_loop_round_all(name, &ps, 431.0, 2.0), [20, 40, 60]);
    let near1 = skirt_offset(name, &ps, 1);
    let near3 = skirt_offset(name, &ps, 3);
    assert!((near1 - 5.45).abs() <= 0.05, "{name}: {near1:.2} from object 1");
    assert!((near3 - 8.2).abs() <= 0.05, "{name}: {near3:.2} from object 3");
    assert!(
        skirt_offset(name, &ps, 2) >= 5.4,
        "{name}: the skirt comes too near object 2"
    );
    assert_eq!(brim_loops(name, &ps), [6, 6, 12]);
    // T-b: the same plate on the MK4 project.
    let name = "mk4p--c6";
    let ps = paths(&slice(name));
    assert_eq!(one_loop_round_all(name, &ps, 425.0, 3.0), [20, 40, 60]);
}

#[test]
fn close_objects_with_settings_of_their_own_share_their_brims_and_one_skirt() {
    // T-c
    for name in ["a1--c16", "p1s--c16", "mk4p--c16"] {
        let ps = paths(&slice(name));
        assert_eq!(one_loop_round_all(name, &ps, 126.2, 2.0), [20, 40, 60], "{name}");
        let near = (1..=3)
            .map(|k| skirt_offset(name, &ps, k))
            .fold(f64::MAX, f64::min);
        assert!(
            (near - 5.46).abs() <= 0.05,
            "{name}: skirt {near:.2} from the boxes"
        );
        assert_eq!(overlap(&ps), 0.0, "{name}");
        let wall = nearest_wall(&ps);
        assert!(wall >= 0.3, "{name}: skirt or brim {wall:.2} mm from a wall");
    }
}

/// Whether every 0.5 mm cell between two neighboring boxes, in the band of their Y extent less 0.5 mm, has a first
/// layer bead over it (a path within half a cell and half a bead of its middle).
fn gaps_covered(name: &str, ps: &[PathRun]) -> Result<(), String> {
    let (xs, y0) = centers_in(name, ps);
    let first = first_layer(ps);
    for w in xs.windows(2) {
        let (x0, x1) = (w[0] + HALF, w[1] - HALF);
        let cols = ((x1 - x0) / 0.5).round() as usize;
        let rows = ((2.0 * HALF - 1.0) / 0.5).round() as usize;
        for i in 0..cols {
            for j in 0..rows {
                let c = [x0 + 0.25 + 0.5 * i as f64, y0 - HALF + 0.75 + 0.5 * j as f64];
                if dist_to(c, &first) > 0.5 {
                    return Err(format!("{name}: nothing printed at {c:?}"));
                }
            }
        }
    }
    Ok(())
}

#[test]
fn close_brims_fill_the_gap_once_and_slice_without_crossing() {
    // T-d. These plates slice as one session, whose skirt keeps its own offset: on the MK4 project it sits a little
    // nearer (123.1 mm), as on a plate of objects far apart.
    for (name, shortest) in [("a1--c2", 124.0), ("mk4p--c2", 123.0)] {
        let ps = paths(&slice(name));
        assert_eq!(overlap(&ps), 0.0, "{name}");
        let first = skirts(&ps).into_iter().next().unwrap().1;
        assert_eq!(first.len(), 1, "{name}");
        let len = first[0].length();
        assert!((shortest..=127.0).contains(&len), "{name}: skirt {len:.1} mm");
        gaps_covered(name, &ps).unwrap();
    }
}

#[test]
fn the_skirt_prints_whole_on_the_plates_first_layers_at_mixed_heights() {
    // T-e
    let name = "a1--c7";
    let ps = paths(&slice(name));
    assert_eq!(one_loop_round_all(name, &ps, 422.0, 2.0), [20, 30, 40]);
    let brim: Vec<PathRun> = ps.iter().filter(|p| p.feature == "Brim").cloned().collect();
    assert_eq!(layer_cents(&brim), [20]);
    // T-f: two objects, no brim.
    let name = "a1--c8";
    let ps = paths(&slice(name));
    assert_eq!(one_loop_round_all(name, &ps, 227.8, 2.0), [20, 35, 45]);
    let near = (1..=2)
        .map(|k| skirt_offset(name, &ps, k))
        .fold(f64::MAX, f64::min);
    assert!(
        (near - 2.23).abs() <= 0.05,
        "{name}: skirt {near:.2} from the boxes"
    );
    // T-g: five skirt layers.
    let name = "a1--c15";
    let ps = paths(&slice(name));
    assert_eq!(one_loop_round_all(name, &ps, 402.0, 2.0), [20, 30, 40, 50, 60]);
}

#[test]
fn a_draft_shield_prints_on_every_plate_layer_at_mixed_heights() {
    // T-h
    for (name, length) in [("a1--c11", 402.0), ("mk4p--c11", 394.0)] {
        let ps = paths(&slice(name));
        let all = layer_cents(&ps);
        assert_eq!(all.len(), 29, "{name}");
        assert_eq!(one_loop_round_all(name, &ps, length, 2.0), all, "{name}");
    }
}

#[test]
fn close_objects_at_mixed_heights_share_their_brims_and_one_skirt() {
    // T-i
    for name in ["a1--c14", "mk4p--c14"] {
        let ps = paths(&slice(name));
        assert_eq!(one_loop_round_all(name, &ps, 126.2, 2.0), [20, 30, 40], "{name}");
        assert_eq!(overlap(&ps), 0.0, "{name}");
    }
}

#[test]
fn close_objects_with_a_skirt_each_share_one() {
    // T-j: already one loop round all three before.
    let name = "a1--c5co";
    let ps = paths(&slice(name));
    assert_eq!(one_loop_round_all(name, &ps, 105.3, 1.0), [20, 40, 60]);
}

#[test]
fn the_first_layer_prints_the_skirt_then_each_brim_before_its_object() {
    // T-k
    let name = "a1--c6";
    let ps = paths(&slice(name));
    assert_brim_before_its_object(name, &first_layer_order(name, &ps));
}
