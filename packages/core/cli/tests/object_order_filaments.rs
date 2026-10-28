// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The order objects print in on a layer with several filaments. A filament change splits each layer into runs of
//! one filament, and each run orders its own objects (those that print with that filament on the layer) as a layer
//! of those objects alone: the shortest links between their centers, ending at the run's object nearest the bed's
//! front left corner. An object of several filaments is in each of their runs. The object list, object settings,
//! the filament numbers and the prime tower make no difference to a run's order, and a plate with object settings
//! starts its first layer on the same filament as without them.
//!
//! The projects in tests/fixtures/object-order-filaments are 10 mm boxes, 8 layers of 0.2 mm, on A1, P1S and MK4
//! with MMU plates; objects.txt gives each object's label, center, half size and turn. Which object a move belongs
//! to is read from the G-code's geometry: the object whose footprint, 3 mm wider, holds it. Its filament is the
//! active tool. Skirt, brim and prime tower are left out, and runs shorter than 3 mm are noise. A layer reads as
//! tokens: `C1` object C in filament 1, `T2` a change to filament 2.

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/object-order-filaments")
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
    let dir = TempDir(std::env::temp_dir().join(format!(
        "sx-object-order-filaments-{case}-{}-{n}",
        std::process::id()
    )));
    std::fs::create_dir_all(&dir.0).unwrap();
    let out = dir.0.join("out.gcode");
    let o = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(fixtures().join(format!("{case}.3mf")))
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

/// Per plate layer (extrusion height in hundredths of a mm), the layer's tokens in the order they print.
fn tokens(case: &str) -> BTreeMap<i64, String> {
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
    let mut tool: Option<u32> = None;
    // Changes since the last object move: they go to the layer of the next one.
    let mut changes: Vec<String> = Vec::new();
    // Per layer: (token, length; 0 for a change).
    let mut runs: BTreeMap<i64, Vec<(String, f64)>> = BTreeMap::new();
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
        if let Some(t) = word.strip_prefix('T').and_then(|t| t.parse::<u32>().ok()) {
            if t < 255 {
                if started && tool.is_some_and(|o| o != t) {
                    changes.push(format!("T{}", t + 1));
                }
                tool = Some(t);
            }
            continue;
        }
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
                    && !feature.to_lowercase().contains("tower")
                    && let Some(o) = owner(nx, ny)
                {
                    let layer = runs.entry((nz * 100.0).round() as i64).or_default();
                    layer.extend(changes.drain(..).map(|c| (c, 0.0)));
                    let token = format!("{}{}", o.label, tool.unwrap_or(0) + 1);
                    match layer.last_mut() {
                        Some((l, len)) if *l == token => *len += length,
                        _ => layer.push((token, length)),
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
            for (token, len) in layer {
                let change = token.starts_with('T');
                if (change || len >= 3.0) && seq.last() != Some(&token) {
                    seq.push(token);
                }
            }
            (z, seq.join(" "))
        })
        .collect()
}

/// `case` has 8 layers: the first prints `first`, the later odd ones (0.6, 1.0, 1.4) `odd`, the even ones `even`.
fn layers(case: &str, first: &str, odd: &str, even: &str) {
    let t = tokens(case);
    assert_eq!(t.len(), 8, "{case}: {t:?}");
    for (z, seq) in &t {
        let want = match z {
            20 => first,
            z if (z / 20) % 2 == 1 => odd,
            _ => even,
        };
        assert_eq!(seq, want, "{case} at {z}");
    }
}

/// Each filament's run on every layer of `case`: `want` holds each filament's objects in order, by filament.
fn runs(case: &str, want: &[(u32, &str)]) {
    let t = tokens(case);
    assert_eq!(t.len(), 8, "{case}: {t:?}");
    for (z, seq) in &t {
        let mut got: BTreeMap<u32, Vec<String>> = BTreeMap::new();
        for token in seq.split(' ').filter(|t| !t.starts_with('T')) {
            let (label, tool) = token.split_at(1);
            got.entry(tool.parse().unwrap())
                .or_default()
                .push(label.to_owned());
        }
        let got: Vec<(u32, String)> = got.into_iter().map(|(k, v)| (k, v.join(" "))).collect();
        let want: Vec<(u32, String)> = want.iter().map(|(k, v)| (*k, (*v).to_owned())).collect();
        assert_eq!(got, want, "{case} at {z}: {seq}");
    }
}

const S5X_ODD: &str = "C1 E1 D1 T2 A2 B2";
const S5X_EVEN: &str = "A2 B2 T1 C1 E1 D1";

#[test]
fn each_filament_run_ends_at_its_own_object_nearest_the_corner() {
    // A and B on filament 2, C, D and E on filament 1: the layer's order is E D C A B, the filament 1 run's C E D.
    layers("a1--s5x", S5X_ODD, S5X_ODD, S5X_EVEN);
    layers("mk4mmu--s5x", S5X_ODD, S5X_ODD, S5X_EVEN);
    // The filament numbers swapped.
    let odd = "A1 B1 T2 C2 E2 D2";
    layers("a1--s5xs", odd, odd, "C2 E2 D2 T1 A1 B1");
    // Six objects.
    let odd = "C1 D1 E1 F1 T2 A2 B2";
    layers("a1--r1x", odd, odd, "A2 B2 T1 C1 D1 E1 F1");
}

#[test]
fn the_run_order_does_not_follow_the_object_list_or_the_tower() {
    // The object list E D C B A.
    layers("a1--s5xp", S5X_ODD, S5X_ODD, S5X_EVEN);
    // No prime tower.
    layers("a1--s5xnt", S5X_ODD, S5X_ODD, S5X_EVEN);
}

#[test]
fn a_plate_with_object_settings_prints_as_without_them() {
    // C has a sparse infill density of its own, so each object slices on its own; the first layer still starts on
    // filament 1, and each run keeps its own order.
    layers("a1--s5xset", S5X_ODD, S5X_ODD, S5X_EVEN);
}

#[test]
fn filament_sequence_settings_keep_each_runs_order() {
    // Filament 2 first on the first layer, and a change to filament 2 at the start of every later one.
    let later = "T2 A2 B2 T1 C1 E1 D1";
    layers("a1--s5seq", "A2 B2 T1 C1 E1 D1", later, later);
}

#[test]
fn three_filaments() {
    layers(
        "a1--s5f3",
        "A1 T2 B2 T3 C3 E3 D3",
        "B2 T1 A1 T3 C3 E3 D3",
        "C3 E3 D3 T1 A1 T2 B2",
    );
}

#[test]
fn layouts_of_seven_objects() {
    let odd = "F1 D1 G1 C1 E1 T2 A2 B2";
    layers("a1--bl1", odd, odd, "A2 B2 T1 F1 D1 G1 C1 E1");
    let odd = "D1 E1 G1 B1 F1 T2 C2 A2";
    layers("a1--bl2", odd, odd, "C2 A2 T1 D1 E1 G1 B1 F1");
    runs("mk4mmu--bl1", &[(1, "D G C F E"), (2, "A B")]);
    runs("a1--bl3", &[(1, "A B"), (2, "F C D"), (3, "G E")]);
    assert_eq!(
        tokens("a1--bl3").get(&20).map(String::as_str),
        Some("A1 B1 T2 F2 C2 D2 T3 G3 E3")
    );
    runs("p1s--bl4", &[(1, "E B"), (2, "G C"), (3, "D A F")]);
    assert_eq!(
        tokens("p1s--bl4").get(&20).map(String::as_str),
        Some("E1 B1 T2 G2 C2 T3 D3 A3 F3")
    );
}

#[test]
fn an_object_of_two_filaments_is_in_both_runs() {
    // A is two parts, filament 1 and filament 2.
    let odd = "E1 D1 C1 A1 T2 A2 B2";
    layers("a1--s5pm", odd, odd, "A2 B2 T1 E1 D1 C1 A1");
}
