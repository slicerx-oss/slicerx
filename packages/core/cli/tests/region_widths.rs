// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A region with settings of its own (a modifier volume, or a part with its own settings) prints its own feature
//! widths, and walls itself when its wall widths differ from the region around it, an outer wall along the boundary.
//! The projects are one 20 x 20 x 3 mm box at x 100 to 120 on 0.2 mm layers with classic walls, 3 loops and 0.45 mm
//! lines (0.5 mm on the first layer); the modifier covers x 110 to 125.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

fn project(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/region-widths")
        .join(name)
}

fn gcode(name: &str) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(project(name))
        .args(["-o", "-"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{name}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

/// On the layer at `z`: each feature's widths, and the x of each wall line that runs along y (longer than 5 mm), by
/// feature and width.
#[derive(Default)]
struct Layer {
    widths: BTreeMap<String, BTreeSet<String>>,
    walls_at: BTreeMap<(String, String), BTreeSet<i64>>,
}

fn layer_at(gcode: &str, z: f64) -> Layer {
    let mut out = Layer::default();
    let (mut kind, mut width) = (String::new(), String::new());
    let (mut x, mut y, mut at_z) = (0.0_f64, 0.0_f64, 0.0_f64);
    for l in gcode.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
            continue;
        }
        if let Some(w) = l.strip_prefix(";WIDTH:") {
            w.clone_into(&mut width);
            continue;
        }
        if !(l.starts_with("G1 ") || l.starts_with("G0 ")) {
            continue;
        }
        let field = |c: char| {
            l.split(';')
                .next()
                .unwrap_or("")
                .split_whitespace()
                .find_map(|f| f.strip_prefix(c))
                .and_then(|v| v.parse::<f64>().ok())
        };
        let (nx, ny) = (field('X').unwrap_or(x), field('Y').unwrap_or(y));
        at_z = field('Z').unwrap_or(at_z);
        if (at_z - z).abs() < 1e-3
            && field('E').is_some_and(|e| e > 0.0)
            && (nx - x).abs() + (ny - y).abs() > 1e-6
        {
            out.widths.entry(kind.clone()).or_default().insert(width.clone());
            if kind.ends_with("wall") && (nx - x).abs() < 0.01 && (ny - y).abs() > 5.0 {
                #[allow(clippy::cast_possible_truncation, reason = "plate x in tenths of a mm")]
                let tenths = (nx * 10.0).round() as i64;
                out.walls_at
                    .entry((kind.clone(), width.clone()))
                    .or_default()
                    .insert(tenths);
            }
        }
        (x, y) = (nx, ny);
    }
    out
}

fn set(v: &[&str]) -> BTreeSet<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn a_modifier_with_its_own_wall_width_walls_itself() {
    // A modifier that sets only the inner wall width to 0.55: its region gets walls of its own, an outer wall on each
    // side of the boundary at x 110, and 0.55 mm inner walls inside it.
    let l = layer_at(&gcode("modifier-inner.3mf"), 1.6);
    assert_eq!(l.widths["Inner wall"], set(&["0.45", "0.55"]));
    let outer = &l.walls_at[&("Outer wall".to_owned(), "0.45".to_owned())];
    assert!(
        outer.iter().any(|x| (1096..=1099).contains(x)),
        "outer walls at {outer:?}"
    );
    assert!(
        outer.iter().any(|x| (1101..=1104).contains(x)),
        "outer walls at {outer:?}"
    );
    // The outer wall width: 0.6 mm inside the modifier, its own walls along the boundary.
    let l = layer_at(&gcode("modifier-outer.3mf"), 1.6);
    assert_eq!(l.widths["Outer wall"], set(&["0.45", "0.6"]));
}

#[test]
fn a_modifier_that_only_changes_the_infill_shares_the_walls_around_it() {
    // Infill density only: no walls along its boundary (only the box's own at x 100 and 120).
    let l = layer_at(&gcode("modifier-infill-only.3mf"), 1.6);
    let outer: BTreeSet<i64> = l
        .walls_at
        .iter()
        .filter(|((k, _), _)| k == "Outer wall")
        .flat_map(|(_, x)| x)
        .copied()
        .collect();
    assert!(
        outer.iter().all(|x| *x < 1010 || *x > 1190),
        "outer walls at {outer:?}"
    );
    // The same with feature widths of their own: inside the modifier the sparse infill keeps its 0.55 mm, the walls
    // their 0.42 and 0.5 mm.
    let l = layer_at(&gcode("modifier-feature-widths.3mf"), 1.6);
    assert_eq!(l.widths["Sparse infill"], set(&["0.55"]));
    assert_eq!(l.widths["Outer wall"], set(&["0.42"]));
    assert_eq!(l.widths["Inner wall"], set(&["0.5"]));
}

#[test]
fn a_parts_own_inner_wall_width_prints_alone_and_beside_another_object() {
    let l = layer_at(&gcode("part-inner.3mf"), 1.6);
    assert_eq!(l.widths["Inner wall"], set(&["0.55"]));
    assert_eq!(l.widths["Outer wall"], set(&["0.45"]));
    // Beside an object without settings: 0.45 on that one, 0.55 on the part's.
    let l = layer_at(&gcode("two-objects-part-inner.3mf"), 1.6);
    assert_eq!(l.widths["Inner wall"], set(&["0.45", "0.55"]));
    let inner = &l.walls_at[&("Inner wall".to_owned(), "0.55".to_owned())];
    assert!(
        inner.iter().all(|x| *x > 1000),
        "0.55 mm inner walls at {inner:?}"
    );
}

#[test]
fn on_the_first_layer_a_modifier_shares_the_walls_when_its_line_width_matches() {
    // The first layer prints every wall at a region's line width. A modifier that sets only line_width to the first
    // layer's 0.5 mm shares the walls around it there (none along its boundary at x 110), whatever its stored wall
    // widths, and walls itself above, where its line width differs.
    let g = gcode("modifier-line-width.3mf");
    let along = |z: f64| -> BTreeSet<i64> {
        layer_at(&g, z)
            .walls_at
            .iter()
            .filter(|((k, _), _)| k == "Outer wall")
            .flat_map(|(_, x)| x)
            .copied()
            .collect()
    };
    let first = along(0.2);
    assert!(
        first.iter().all(|x| *x < 1010 || *x > 1190),
        "first layer outer walls at {first:?}"
    );
    let above = along(1.6);
    assert!(
        above.iter().any(|x| (1090..=1110).contains(x)),
        "outer walls at {above:?}"
    );
}
