// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A plate printed layer by layer whose objects set layer heights of their own. Each object keeps its own layer tops
//! above the plate's first layer, which every object shares (an object's own first layer height is not read), and
//! the plate prints the union of those tops, rising, with only the objects that have a top there on each layer. Each
//! object extrudes for its own layer thickness, the moves between objects are those of a plate at one height, and
//! the skirt and brim count the plate's layers. A prime tower still needs one layer height, so that plate is refused.
//!
//! The projects in tests/fixtures/mixed-heights are 10 x 10 x 3 mm boxes in a row along X, objects 1, 2, 3 from the
//! left, at a plate layer height of 0.2 mm on a 0.2 mm first layer. Which object a move belongs to is read from the
//! G-code's geometry: the box it lies in.

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn sx() -> Command {
    Command::new(env!("CARGO_BIN_EXE_sx"))
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/mixed-heights/{name}.3mf"))
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
    let dir =
        TempDir(std::env::temp_dir().join(format!("sx-mixed-heights-{name}-{}-{n}", std::process::id())));
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

/// The project's G-code; the slice must succeed.
fn slice(name: &str) -> String {
    let (o, gcode) = run(name);
    assert!(
        o.status.success(),
        "{name}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    gcode.unwrap()
}

/// The X centers of the objects, left to right, and their Y center, mm.
fn centers(name: &str) -> (Vec<f64>, f64) {
    match name.split("--").next().unwrap() {
        "a1" if name.ends_with("m0") || name.ends_with("m1") || name.ends_with("m7") => {
            (vec![40.96, 128.0, 215.04], 128.0)
        }
        "a1" => (vec![84.48, 171.52], 128.0),
        "mk4p" if name.ends_with("m1") => (vec![40.0, 125.0, 210.0], 105.0),
        "mk4p" => (vec![82.5, 167.5], 105.0),
        other => panic!("no centers for {other}"),
    }
}

/// What a move is: an extrusion of object `k` (1 from the left) or of the feature named, a retraction, a travel.
#[derive(Debug, Clone, PartialEq)]
enum Kind {
    Object(usize),
    Feature(String),
    Retract,
    Travel,
}

#[derive(Debug, Clone)]
struct Move {
    kind: Kind,
    /// Nozzle height after the move, mm.
    z: f64,
    e: f64,
    length: f64,
}

/// The moves from the first layer change on, with relative or absolute extrusion and arcs read as moves to their
/// end point.
fn moves(gcode: &str, name: &str) -> Vec<Move> {
    let (xs, y0) = centers(name);
    let owner = |x: f64, y: f64| {
        xs.iter()
            .position(|cx| (x - cx).abs() <= 5.15 && (y - y0).abs() <= 5.15)
            .map(|k| k + 1)
    };
    let (mut x, mut y, mut z, mut e_abs) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut relative = true;
    let mut started = false;
    let mut feature = String::new();
    let mut out = Vec::new();
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
                // A move that only sets the feed rate is no move.
                let still = nx == x && ny == y && nz == z && de == 0.0;
                if started && !still {
                    let length = (nx - x).hypot(ny - y);
                    let kind = if de < -1e-9 {
                        Kind::Retract
                    } else if de > 1e-9 && length > 0.0 {
                        match owner(f64::midpoint(x, nx), f64::midpoint(y, ny)) {
                            Some(k) if feature != "Skirt" && feature != "Brim" => Kind::Object(k),
                            _ => Kind::Feature(feature.clone()),
                        }
                    } else {
                        Kind::Travel
                    };
                    out.push(Move {
                        kind,
                        z: nz,
                        e: de,
                        length,
                    });
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

fn cents_of(zs: &[f64]) -> Vec<i64> {
    zs.iter().map(|&z| cents(z)).collect()
}

/// Each object's extrusion heights, rising, by object.
fn object_tops(ms: &[Move]) -> BTreeMap<usize, Vec<i64>> {
    let mut out: BTreeMap<usize, Vec<i64>> = BTreeMap::new();
    for m in ms {
        if let Kind::Object(k) = m.kind {
            let v = out.entry(k).or_default();
            if !v.contains(&cents(m.z)) {
                v.push(cents(m.z));
            }
        }
    }
    for v in out.values_mut() {
        v.sort_unstable();
    }
    out
}

/// Per plate layer (extrusion height), the objects in the order they print.
fn orders(ms: &[Move]) -> BTreeMap<i64, String> {
    let mut out: BTreeMap<i64, String> = BTreeMap::new();
    for m in ms {
        if let Kind::Object(k) = m.kind {
            let s = out.entry(cents(m.z)).or_default();
            let c = char::from_digit(u32::try_from(k).unwrap(), 10).unwrap();
            if !s.ends_with(c) {
                s.push(c);
            }
        }
    }
    out
}

/// Filament per mm of path of object `k` over its whole layer at `z`.
fn e_per_mm(ms: &[Move], k: usize, z: f64) -> f64 {
    let (e, l) = ms
        .iter()
        .filter(|m| m.kind == Kind::Object(k) && cents(m.z) == cents(z))
        .fold((0.0, 0.0), |(e, l), m| (e + m.e, l + m.length));
    assert!(l > 0.0, "object {k} prints nothing at {z}");
    e / l
}

/// `first`, then `first + n * step` while the layer's middle is below `top`, mm.
fn tops(first: f64, step: f64, top: f64) -> Vec<f64> {
    let mut v = vec![first];
    let mut n = 1.0;
    while first + (n - 0.5) * step < top - 1e-9 {
        v.push(first + n * step);
        n += 1.0;
    }
    v
}

/// The order of the objects with a top at each plate layer, in plate order.
fn present(per: &BTreeMap<usize, Vec<i64>>, z: i64) -> String {
    per.iter()
        .filter(|(_, v)| v.contains(&z))
        .map(|(k, _)| char::from_digit(u32::try_from(*k).unwrap(), 10).unwrap())
        .collect()
}

/// Objects 0.1, 0.2 and 0.3 mm.
fn expect_m1(name: &str, gcode: &str) {
    let ms = moves(gcode, name);
    let per = object_tops(&ms);
    assert_eq!(per[&1], cents_of(&tops(0.2, 0.1, 3.0)), "{name} object 1");
    assert_eq!(per[&1].len(), 29);
    assert_eq!(per[&2], cents_of(&tops(0.2, 0.2, 3.0)), "{name} object 2");
    assert_eq!(per[&2].len(), 15);
    assert_eq!(
        per[&3],
        [20, 50, 80, 110, 140, 170, 200, 230, 260, 290],
        "{name} object 3"
    );
    let ord = orders(&ms);
    assert_eq!(ord.len(), 29, "{name}: plate layers {ord:?}");
    let first: Vec<(i64, &str)> = ord.iter().take(7).map(|(z, o)| (*z, o.as_str())).collect();
    assert_eq!(
        first,
        [
            (20, "123"),
            (30, "1"),
            (40, "12"),
            (50, "13"),
            (60, "12"),
            (70, "1"),
            (80, "123")
        ],
        "{name}"
    );
    // The pattern repeats every 0.6 mm: each layer prints the objects with a top there, left to right.
    for (z, o) in &ord {
        assert_eq!(*o, present(&per, *z), "{name} at {z}");
    }
}

#[test]
fn objects_keep_their_own_layer_heights_on_a_plate_printed_by_layer() {
    expect_m1("a1--m1", &slice("a1--m1"));
}

#[test]
fn objects_keep_their_own_layer_heights_on_a_project_of_another_layout() {
    let gcode = slice("mk4p--m1");
    expect_m1("mk4p--m1", &gcode);
}

#[test]
fn heights_that_meet_rarely_share_only_those_layers() {
    let name = "a1--m2";
    let ms = moves(&slice(name), name);
    let per = object_tops(&ms);
    assert_eq!(per[&1], cents_of(&tops(0.2, 0.15, 3.0)));
    assert_eq!(per[&1].last(), Some(&305), "the last top passes the model's");
    assert_eq!(per[&2], cents_of(&tops(0.2, 0.25, 3.0)));
    assert_eq!(per[&2].last(), Some(&295));
    let ord = orders(&ms);
    let plate: Vec<i64> = ord.keys().copied().collect();
    assert_eq!(
        plate,
        [
            20, 35, 45, 50, 65, 70, 80, 95, 110, 120, 125, 140, 145, 155, 170, 185, 195, 200, 215, 220, 230,
            245, 260, 270, 275, 290, 295, 305
        ]
    );
    let both: Vec<i64> = ord
        .iter()
        .filter(|(_, o)| o.len() == 2)
        .map(|(z, _)| *z)
        .collect();
    assert_eq!(both, [20, 95, 170, 245]);
    assert!(ord.values().all(|o| o == "12" || o == "1" || o == "2"), "{ord:?}");
}

#[test]
fn an_objects_own_first_layer_height_is_not_read_layer_by_layer() {
    for name in ["a1--m3", "mk4p--m3"] {
        let gcode = slice(name);
        let per = object_tops(&moves(&gcode, name));
        let all = cents_of(&tops(0.2, 0.2, 3.0));
        assert_eq!(per[&1], all, "{name}");
        assert_eq!(per[&2], all, "{name}");
        assert!(
            gcode == slice(&format!("{name}-nofirst")),
            "{name} prints as the project without the object's first layer height"
        );
    }
}

#[test]
fn an_object_with_its_own_height_and_first_layer_starts_on_the_plates() {
    let name = "a1--m3b";
    let per = object_tops(&moves(&slice(name), name));
    assert_eq!(per[&1], cents_of(&tops(0.2, 0.1, 3.0)));
    assert_eq!(per[&2], [20, 50, 80, 110, 140, 170, 200, 230, 260, 290]);
}

#[test]
fn each_object_extrudes_for_its_own_thickness_on_a_shared_layer() {
    let mixed = moves(&slice("a1--m1"), "a1--m1");
    let even = moves(&slice("a1--m0"), "a1--m0");
    let (two, alone) = (e_per_mm(&mixed, 2, 1.4), e_per_mm(&even, 2, 1.4));
    assert!(
        (two / alone - 1.0).abs() < 0.01,
        "0.2 mm object at 1.4: {two} against {alone} on one height"
    );
    let (one, below) = (e_per_mm(&mixed, 1, 1.4), e_per_mm(&mixed, 1, 1.3));
    assert!(
        (one / below - 1.0).abs() < 0.02,
        "0.1 mm object at 1.4: {one} against {below} at 1.3"
    );
    assert!(
        one < 0.6 * two,
        "the 0.1 mm object extrudes about half: {one} against {two}"
    );
    let three = e_per_mm(&mixed, 3, 1.4);
    assert!(
        three > 1.25 * two,
        "the 0.3 mm object extrudes more: {three} against {two}"
    );
    let zs: Vec<f64> = mixed
        .iter()
        .filter(|m| matches!(m.kind, Kind::Object(_) | Kind::Feature(_)))
        .map(|m| m.z)
        .collect();
    assert!(zs.windows(2).all(|w| w[1] >= w[0] - 1e-9), "Z never goes down");
}

/// Each change of object: the retractions and the lift above the higher of the two layers, mm (hundredths).
fn changes(ms: &[Move]) -> Vec<(bool, usize, i64)> {
    let mut out = Vec::new();
    let mut last: Option<(usize, f64)> = None;
    let (mut retracts, mut peak) = (0usize, f64::MIN);
    let mut was_retract = false;
    for m in ms {
        match m.kind {
            Kind::Object(k) => {
                if let Some((_, z0)) = last.filter(|l| l.0 != k) {
                    out.push(((m.z - z0).abs() < 1e-6, retracts, cents(peak.max(m.z) - m.z)));
                }
                last = Some((k, m.z));
                (retracts, peak) = (0, f64::MIN);
                was_retract = false;
            }
            Kind::Feature(_) => {
                last = None;
                was_retract = false;
            }
            Kind::Retract => {
                if last.is_some() && !was_retract {
                    retracts += 1;
                }
                was_retract = true;
                peak = peak.max(m.z);
            }
            Kind::Travel => {
                // A prime ends the retraction; a travel does not.
                if m.e > 0.0 {
                    was_retract = false;
                }
                peak = peak.max(m.z);
            }
        }
    }
    out
}

#[test]
fn moves_between_objects_are_those_of_a_plate_at_one_height() {
    let even = changes(&moves(&slice("a1--m0"), "a1--m0"));
    let mixed = changes(&moves(&slice("a1--m1"), "a1--m1"));
    assert!(!even.is_empty() && !mixed.is_empty());
    let hop = |c: &[(bool, usize, i64)], same: bool| {
        let mut v: Vec<i64> = c.iter().filter(|x| x.0 == same).map(|x| x.2).collect();
        v.dedup();
        v
    };
    assert!(
        mixed.iter().all(|c| c.1 == 1),
        "one retraction per change of object: {mixed:?}"
    );
    assert!(even.iter().all(|c| c.1 == 1), "{even:?}");
    assert_eq!(hop(&mixed, true), hop(&even, true), "on one layer");
    assert_eq!(hop(&mixed, false), hop(&even, false), "to the next layer");
    assert!(mixed.iter().any(|c| c.0) && mixed.iter().any(|c| !c.0));
}

#[test]
fn a_prime_tower_with_mixed_layer_heights_is_refused() {
    let (o, _) = run("a1--m5");
    assert!(!o.status.success());
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(err.contains("prime tower"), "{err}");
    assert!(err.contains("obj2"), "{err}");
}

#[test]
fn the_skirt_and_brim_count_the_plates_layers() {
    let name = "a1--m7";
    let ms = moves(&slice(name), name);
    let on = |f: &str| {
        let mut v: Vec<i64> = ms
            .iter()
            .filter(|m| m.kind == Kind::Feature(f.to_owned()))
            .map(|m| cents(m.z))
            .collect();
        v.dedup();
        v
    };
    assert_eq!(on("Skirt"), [20, 30, 40]);
    assert_eq!(on("Brim"), [20]);
    // The objects still print their own heights.
    let per = object_tops(&ms);
    assert_eq!(per[&3], [20, 50, 80, 110, 140, 170, 200, 230, 260, 290]);
}
