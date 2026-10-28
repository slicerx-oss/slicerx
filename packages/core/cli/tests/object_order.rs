// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The order objects print in on a plate printed layer by layer. Each layer prints whole objects one after another,
//! in an order set only by where the objects stand: the shortest links between the objects' centers, ending at the
//! object nearest the bed's front left corner. The object list, the objects' own settings and whether the objects
//! are copies of one object make no difference, and the same objects print in the same order on every layer. With
//! layer heights of their own, each layer orders the objects that print on it. `print_order` as object list keeps
//! the list's order.
//!
//! The projects in tests/fixtures/object-order are boxes on an A1 plate, 8 layers of 0.2 mm unless a case says
//! otherwise; objects.txt gives each object's label, center, half size and turn. Which object a move belongs to is
//! read from the G-code's geometry: the object whose footprint, 3 mm wider, holds it. Skirt and brim are left out,
//! and runs shorter than 3 mm are noise.

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/object-order")
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// One object's footprint: label, center, half sizes, turn in degrees.
struct Object {
    label: String,
    at: [f64; 2],
    half: [f64; 2],
    turn: f64,
}

fn objects(case: &str) -> Vec<Object> {
    let table = std::fs::read_to_string(fixtures().join("objects.txt")).unwrap();
    let line = table
        .lines()
        .find_map(|l| l.strip_prefix(&format!("{case}: ")))
        .unwrap_or_else(|| panic!("no objects for {case}"));
    line.split("; ")
        .map(|o| {
            let w: Vec<&str> = o.split_whitespace().collect();
            let n = |i: usize| w[i].parse::<f64>().unwrap();
            Object {
                label: w[0].to_owned(),
                at: [n(1), n(2)],
                half: [n(3), n(4)],
                turn: n(5),
            }
        })
        .collect()
}

fn slice(case: &str) -> String {
    static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir =
        TempDir(std::env::temp_dir().join(format!("sx-object-order-{case}-{}-{n}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let out = dir.0.join("out.gcode");
    let o = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(fixtures().join(format!("a1--{case}.3mf")))
        .args(["--plate", "1", "-o"])
        .arg(&out)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "{case}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    std::fs::read_to_string(&out).unwrap()
}

/// Per plate layer (extrusion height in hundredths of a mm), the objects' labels in the order they print.
fn orders(case: &str) -> BTreeMap<i64, Vec<String>> {
    let objs = objects(case);
    let owner = |x: f64, y: f64| {
        objs.iter().find(|o| {
            let (s, c) = o.turn.to_radians().sin_cos();
            let (dx, dy) = (x - o.at[0], y - o.at[1]);
            let (u, v) = (dx * c + dy * s, -dx * s + dy * c);
            u.abs() <= o.half[0] + 3.0 && v.abs() <= o.half[1] + 3.0
        })
    };
    let gcode = slice(case);
    let (mut x, mut y, mut z, mut e_abs) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut relative, mut started) = (true, false);
    let mut feature = String::new();
    let mut runs: BTreeMap<i64, Vec<(String, f64)>> = BTreeMap::new();
    for line in gcode.lines() {
        if line.starts_with("; CHANGE_LAYER") {
            started = true;
        }
        if let Some(f) = line.strip_prefix("; FEATURE: ") {
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
                let length = (nx - x).hypot(ny - y);
                if started
                    && de > 1e-9
                    && length > 0.0
                    && !matches!(feature.as_str(), "Skirt" | "Brim" | "Custom")
                    && let Some(o) = owner(nx, ny)
                {
                    let layer = runs.entry((nz * 100.0).round() as i64).or_default();
                    match layer.last_mut() {
                        Some((l, len)) if *l == o.label => *len += length,
                        _ => layer.push((o.label.clone(), length)),
                    }
                }
                (x, y, z) = (nx, ny, nz);
            }
            _ => {}
        }
    }
    runs.into_iter()
        .map(|(z, layer)| {
            let mut seq: Vec<String> = Vec::new();
            for (label, len) in layer {
                if len >= 3.0 && seq.last() != Some(&label) {
                    seq.push(label);
                }
            }
            (z, seq)
        })
        .collect()
}

/// Every layer of `case` prints `want` (labels separated by spaces).
fn every_layer(case: &str, want: &str) -> usize {
    let ord = orders(case);
    assert!(!ord.is_empty(), "{case}: no layers");
    for (z, seq) in &ord {
        assert_eq!(seq.join(" "), want, "{case} at {z}");
    }
    ord.len()
}

#[test]
fn objects_print_in_the_order_their_places_give() {
    for case in ["scat5", "scat5p2"] {
        assert_eq!(every_layer(case, "E D C A B"), 8, "{case}");
    }
    every_layer("rnd5", "F E C G A D B");
    every_layer("rnd2", "E G B A C D F");
    every_layer("quad11", "D C A B");
    every_layer("rnd1", "E F C A D B");
    every_layer("sizes", "S3 S2 L S1");
}

#[test]
fn objects_with_settings_of_their_own_print_in_the_same_order() {
    every_layer("set5", "E D C A B");
    every_layer("set5p2", "E D C A B");
}

#[test]
fn copies_of_one_object_print_in_the_same_order() {
    every_layer("inst5", "E D C A B");
}

#[test]
fn an_object_keeps_its_place_while_its_layers_move() {
    // P leans 120 mm along X over its height: its island passes from nearer the origin than Q to farther.
    assert_eq!(every_layer("lean", "Q P"), 30);
}

#[test]
fn an_object_of_two_cubes_prints_whole() {
    let ord = orders("split");
    assert!(!ord.is_empty());
    for (z, seq) in &ord {
        let objects: Vec<char> = seq.iter().filter_map(|l| l.chars().next()).collect();
        assert_eq!(seq.len(), 4, "split at {z}: {seq:?}");
        assert_eq!(objects, ['R', 'M', 'M', 'N'], "split at {z}: {seq:?}");
    }
}

#[test]
fn each_layer_orders_the_objects_that_print_on_it() {
    // A at 0.1 mm and C at 0.3 mm, the others at 0.2 mm: the pattern repeats every 0.6 mm.
    let want = [
        (20, "E D C A B"),
        (30, "A"),
        (40, "A E D B"),
        (50, "C A"),
        (60, "A E D B"),
        (70, "A"),
    ];
    for case in ["mix5", "mix5p2"] {
        let ord = orders(case);
        for (z, seq) in &ord {
            if *z == 170 {
                assert_eq!(seq.join(" "), "C", "{case} at {z}");
                continue;
            }
            let k = (z - 20).rem_euclid(60) + 20;
            let w = want.iter().find(|w| w.0 == k).map(|w| w.1);
            assert_eq!(Some(seq.join(" ").as_str()), w, "{case} at {z}");
        }
        assert_eq!(ord.keys().next_back(), Some(&170), "{case}");
    }
}

#[test]
fn layouts_of_mixed_sizes_and_turns() {
    for (case, want) in [
        ("bl1", "A D F C B E"),
        ("bl2", "A G E C D F B"),
        ("bl3", "A C E B D"),
        ("bl4", "B E C D A"),
        ("bl5", "B D E C A"),
        ("bl6", "F D C B A E"),
        ("bl7", "B D E C A F G"),
        ("bl8", "D C E B A"),
        ("bl9", "B D C E A"),
        ("bl10", "E D B G A F C"),
    ] {
        every_layer(case, want);
    }
}

#[test]
fn print_order_as_object_list_keeps_the_list() {
    every_layer("objlist5p2", "C A E B D");
}
