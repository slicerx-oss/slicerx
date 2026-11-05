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
fn on_the_first_layer_a_modifier_prints_the_first_layer_line_width() {
    // initial_layer_line_width is 0.5 mm: a modifier's own wall, infill or line widths print from the second layer on.
    // Every line of the first layer is 0.5 mm, the bottom surface's spread a little wider to fill its area.
    for name in [
        "modifier-inner.3mf",
        "modifier-outer.3mf",
        "modifier-line-width.3mf",
        "modifier-feature-widths.3mf",
    ] {
        let l = layer_at(&gcode(name), 0.2);
        for kind in ["Outer wall", "Inner wall"] {
            assert_eq!(l.widths[kind], set(&["0.5"]), "{name}: {kind}");
        }
        // The printer's start G-code (its purge line) prints at the first layer's height too.
        for (kind, widths) in l.widths.iter().filter(|(k, _)| *k != "Custom") {
            for w in widths {
                let w: f64 = w.parse().unwrap_or_else(|_| panic!("{name}: {kind} width {w:?}"));
                assert!((0.5..0.52).contains(&w), "{name}: {kind} at {w} mm");
            }
        }
    }
}

#[test]
fn on_the_first_layer_a_modifier_prints_its_own_first_layer_wall_width() {
    // A modifier that sets initial_layer_inner_wall_line_width to 0.7 mm prints its first layer inner walls at 0.7, as
    // they are laid out, and the rest of the first layer at the plate's 0.5 mm.
    let l = layer_at(&gcode("modifier-first-layer-inner.3mf"), 0.2);
    assert_eq!(l.widths["Inner wall"], set(&["0.5", "0.7"]));
    assert_eq!(l.widths["Outer wall"], set(&["0.5"]));
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

/// The x of each outer wall line along y on the layer at `z`, in tenths of a mm.
fn outer_walls_at(gcode: &str, z: f64) -> BTreeSet<i64> {
    layer_at(gcode, z)
        .walls_at
        .iter()
        .filter(|((k, _), _)| k == "Outer wall")
        .flat_map(|(_, x)| x)
        .copied()
        .collect()
}

#[test]
fn on_the_first_layer_regions_share_walls_by_the_widths_they_print() {
    // Every first layer line is 0.5 mm. A modifier that changes only the infill, or only a wall width above the first
    // layer, prints the same 0.5 mm walls there and shares the walls around it: no walls along its boundary at x 110,
    // one seam for each loop of the box.
    for name in ["modifier-infill-only.3mf", "modifier-inner.3mf"] {
        let first = outer_walls_at(&gcode(name), 0.2);
        assert!(
            first.iter().all(|x| *x < 1010 || *x > 1190),
            "{name}: first layer outer walls at {first:?}"
        );
    }
    // A modifier with the plate's 0.5 mm line width and a first layer width of its own, 0.7 mm, walls itself there
    // at 0.7 mm, an outer wall on each side of the boundary.
    let g = gcode("modifier-first-layer-line.3mf");
    let l = layer_at(&g, 0.2);
    assert_eq!(l.widths["Outer wall"], set(&["0.5", "0.7"]));
    assert_eq!(l.widths["Inner wall"], set(&["0.5", "0.7"]));
    let first = outer_walls_at(&g, 0.2);
    assert!(
        first.iter().any(|x| (1095..=1099).contains(x)) && first.iter().any(|x| (1101..=1105).contains(x)),
        "first layer outer walls at {first:?}"
    );
}

#[test]
fn on_the_first_layer_a_modifier_without_a_first_layer_width_prints_its_own_widths() {
    // The plate sets initial_layer_line_width 0.5; a modifier sets it to 0 and its outer wall to 0.6 mm. Its first
    // layer walls print at its own widths, as they are laid out: 0.6 mm outer walls, 0.45 mm inner ones.
    let l = layer_at(&gcode("modifier-first-layer-unset.3mf"), 0.2);
    assert_eq!(l.widths["Outer wall"], set(&["0.5", "0.6"]));
    assert_eq!(l.widths["Inner wall"], set(&["0.45", "0.5"]));
}

#[test]
fn on_the_first_layer_the_skirt_and_brim_keep_the_first_layer_width() {
    // The whole box is a modifier with a 0.7 mm first layer width of its own. Its walls print at 0.7 mm; the skirt and
    // the brim, laid out at the plate's 0.5 mm, print at 0.5.
    let l = layer_at(&gcode("whole-modifier-first-layer-line.3mf"), 0.2);
    assert_eq!(l.widths["Outer wall"], set(&["0.7"]));
    assert_eq!(l.widths["Skirt"], set(&["0.5"]));
    assert_eq!(l.widths["Brim"], set(&["0.5"]));
}

#[test]
fn on_the_first_layer_a_modifier_prints_its_own_first_layer_width_on_any_plate() {
    // The plate leaves its first layer width unset (0), so its first layer prints its own 0.45 mm. A modifier with
    // initial_layer_inner_wall_line_width 0.7 prints its first layer as those settings would on the plate: with no
    // first layer line width of its own the 0.7 mm inner wall width is it, so its walls print at 0.7 mm.
    let l = layer_at(&gcode("plate-unset-modifier-first-layer-inner.3mf"), 0.2);
    assert_eq!(l.widths["Inner wall"], set(&["0.45", "0.7"]));
    assert_eq!(l.widths["Outer wall"], set(&["0.45", "0.7"]));
}

/// On the layer at `layer_z`, the filament laid in the box x0..x1, y0..y1 as a share of the box filled `depth` mm
/// deep (relative E, 1.75 mm filament; each straight move counts for its part inside the box), and the ends of the
/// bottom surface lines inside it. Arcs would need their own sweep, so the layer must have none.
fn band(gcode: &str, layer_z: f64, depth: f64, (x0, x1, y0, y1): (f64, f64, f64, f64)) -> (f64, usize) {
    let (mut kind, mut x, mut y, mut at_z) = (String::new(), 0.0_f64, 0.0_f64, 0.0_f64);
    let (mut volume, mut ends) = (0.0_f64, 0_usize);
    let area = std::f64::consts::PI * 0.875 * 0.875;
    let inside = |px: f64, py: f64| px > x0 && px < x1 && py > y0 && py < y1;
    for line in gcode.lines() {
        if let Some(t) = line.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        let field = |c: char| {
            code.split_whitespace()
                .skip(1)
                .find_map(|f| f.strip_prefix(c))
                .and_then(|v| v.parse::<f64>().ok())
        };
        let arc = code.starts_with("G2 ") || code.starts_with("G3 ");
        if !(code.starts_with("G1 ") || code.starts_with("G0 ") || arc) {
            continue;
        }
        let (nx, ny) = (field('X').unwrap_or(x), field('Y').unwrap_or(y));
        at_z = field('Z').unwrap_or(at_z);
        let fed = field('E').unwrap_or(0.0);
        if (at_z - layer_z).abs() < 1e-3 && fed > 0.0 {
            assert!(!arc, "an arc on the layer at {layer_z}: {line}");
            // The part of the move inside the box (Liang-Barsky).
            let (dx, dy) = (nx - x, ny - y);
            let (mut t0, mut t1) = (0.0_f64, 1.0_f64);
            let mut keep = true;
            for (step, room) in [(-dx, x - x0), (dx, x1 - x), (-dy, y - y0), (dy, y1 - y)] {
                if step.abs() < 1e-12 {
                    keep &= room >= 0.0;
                } else if step < 0.0 {
                    t0 = t0.max(room / step);
                } else {
                    t1 = t1.min(room / step);
                }
            }
            if keep && t1 > t0 {
                volume += fed * area * (t1 - t0);
            }
            if kind == "Bottom surface" {
                ends += usize::from(inside(x, y)) + usize::from(inside(nx, ny));
            }
        }
        (x, y) = (nx, ny);
    }
    (volume / ((x1 - x0) * (y1 - y0) * depth), ends)
}

#[test]
fn on_the_first_layer_regions_that_share_walls_print_one_bottom_surface() {
    // A modifier that only changes the infill shares the box's walls on the first layer. Its bottom surface and the
    // box's are one: the lines run across the boundary at x 110 with no ends near it, and the 1 mm band along it takes
    // as much filament as the rest of the layer, not the overlap of two surfaces that each stop short of it.
    // The same where the plate leaves its first layer width unset and the modifier sets only its sparse infill width,
    // which the bottom surface covers on the first layer.
    for name in [
        "modifier-infill-only.3mf",
        "modifier-inner.3mf",
        "plate-unset-modifier-sparse-width.3mf",
    ] {
        let g = gcode(name);
        let (at, ends) = band(&g, 0.2, 0.2, (109.5, 110.5, 97.0, 103.0));
        let (away, _) = band(&g, 0.2, 0.2, (106.0, 108.0, 97.0, 103.0));
        assert_eq!(
            ends, 0,
            "{name}: bottom surface line ends within 0.5 mm of the boundary"
        );
        assert!(
            (at / away - 1.0).abs() < 0.03,
            "{name}: filament at the boundary {at:.3} of the band, {away:.3} away from it"
        );
    }
}

#[test]
fn on_the_first_layer_each_object_prints_its_own_bottom_surface() {
    // Two boxes, at x 70 to 90 and 105 to 125; the second is a part with its own inner wall width. On the first layer
    // both print 0.5 mm walls and share a wall group, yet each box's bottom surface prints under its own object label,
    // so cancelling one object leaves the other whole.
    let g = gcode("two-objects-part-inner.3mf");
    let (mut kind, mut object, mut at_z, mut x) = (String::new(), String::new(), 0.0_f64, 0.0_f64);
    let mut checked = 0;
    for line in g.lines() {
        if let Some(t) = line.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
            continue;
        }
        if let Some(o) = line.strip_prefix("M486 S") {
            o.split_whitespace().next().unwrap_or("").clone_into(&mut object);
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        if !(code.starts_with("G1 ") || code.starts_with("G0 ")) {
            continue;
        }
        let field = |c: char| {
            code.split_whitespace()
                .skip(1)
                .find_map(|f| f.strip_prefix(c))
                .and_then(|v| v.parse::<f64>().ok())
        };
        at_z = field('Z').unwrap_or(at_z);
        let moves = field('X').is_some() || field('Y').is_some();
        x = field('X').unwrap_or(x);
        if (at_z - 0.2).abs() < 1e-3
            && moves
            && kind == "Bottom surface"
            && field('E').is_some_and(|e| e > 0.0)
        {
            let want = if x < 100.0 { "0" } else { "1" };
            assert_eq!(object, want, "bottom surface at x {x} under object {object}");
            checked += 1;
        }
    }
    assert!(checked > 0);
}

#[test]
fn outside_a_prusa_format_project_a_part_with_settings_keeps_its_overlap() {
    // Two boxes, x 100 to 120 and 115 to 135, the first part with 0.55 mm inner walls, in a Bambu Lab format project:
    // the first part's region keeps its whole footprint, so its 0.55 mm inner walls reach x 120 over the overlap and the
    // second part's 0.45 mm walls start there.
    let l = layer_at(&gcode("two-parts-overlap-inner.3mf"), 1.6);
    assert_eq!(l.widths["Inner wall"], set(&["0.45", "0.55"]));
    let wide = &l.walls_at[&("Inner wall".to_owned(), "0.55".to_owned())];
    assert!(
        wide.iter().all(|x| *x < 1200) && wide.iter().any(|x| *x > 1170),
        "0.55 mm inner walls at {wide:?}"
    );
    let plain = &l.walls_at[&("Inner wall".to_owned(), "0.45".to_owned())];
    assert!(
        plain.iter().all(|x| *x > 1200),
        "0.45 mm inner walls at {plain:?}"
    );
}
