// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Narrow pieces of the top surface and the first layer: surface lines, gap fill or walls only.
//!
//! Plates of 30.9 mm strips (`fixtures/narrow-piece-surface`: the requests, with the stock profiles' settings, the
//! meshes and each strip's center, direction and size) across a sweep of widths W, each strip one object island, on the stock Ender-3 V3
//! (fixed-width walls, two loops), Voron 2.4 and MK4 requests (three loops) with flattened speeds. Each strip's free
//! width inside the walls is R = W - 2 ins, ins being where the surface starts (the stretched surface rule); s0 is
//! the surface's line spacing and si the inner wall's. Per strip the tests read, on the top layer and the first, the
//! extruded length of each feature whose moves' midpoints lie in the strip, and for the surface feature its lines
//! along the dominant direction: count, stated widths and the margins from the strip's sides.
//!
//! - Fixed-width walls, no sparse infill: a strip that holds a surface line (R at least s0) prints surface lines,
//!   spread across it, instead of a gap fill bead; a narrower one keeps its gap fill bead. A strip whose lines run
//!   across it prints them from the same width, and keeps its gap fill below it too.
//! - Fixed-width walls with sparse infill and the walls overlapping the surface by half a line: a strip whose free
//!   width less the overlap is under 0.15 si prints walls only, not a single line squeezed between the walls.
//! - Variable-width walls: a surface line only once the walls leave a whole inner spacing free.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::disallowed_methods,
    clippy::float_cmp,
    reason = "a G-code reader for the test: positions, angles and lengths in mm"
)]

use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/narrow-piece-surface");

/// One strip of a plate: its center, the direction it runs (degrees), its width and length, mm.
struct Strip {
    cx: f64,
    cy: f64,
    ang: f64,
    w: f64,
    l: f64,
}

/// What one strip prints on one layer.
#[derive(Debug, Default)]
struct Row {
    /// Extruded length per feature, mm.
    feat: BTreeMap<String, f64>,
    /// Surface lines at least 0.2 mm long in the dominant direction: their offsets across that direction.
    lines: usize,
    /// Whether that direction runs along the strip.
    along: bool,
    /// The surface lines' stated widths.
    widths: Vec<f64>,
    /// The margins from the outermost surface lines to the strip's sides, across the lines.
    m0: f64,
    m1: f64,
    /// The mean distance between neighboring surface lines.
    gap: Option<f64>,
}

impl Row {
    fn len(&self, feature: &str) -> f64 {
        self.feat.get(feature).copied().unwrap_or(0.0)
    }
}

/// G-code of the plate `case`.
fn slice(case: &str) -> String {
    let mut req: Value =
        serde_json::from_slice(&std::fs::read(format!("{FIXTURES}/requests/{case}.json")).unwrap()).unwrap();
    req.as_object_mut().unwrap().remove("meshes");
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let bytes = std::fs::read(format!("{FIXTURES}/{case}.stl")).unwrap();
    let mesh = Arc::new(Mesh::load(&bytes, "strips.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

fn strips(case: &str) -> Vec<(String, Strip)> {
    let v: Value =
        serde_json::from_slice(&std::fs::read(format!("{FIXTURES}/{case}.strips.json")).unwrap()).unwrap();
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let f = |k: &str| s[k].as_f64().unwrap();
            (
                s["name"].as_str().unwrap().to_owned(),
                Strip {
                    cx: f("cx"),
                    cy: f("cy"),
                    ang: f("ang"),
                    w: f("W"),
                    l: f("L"),
                },
            )
        })
        .collect()
}

fn inside(s: &Strip, x: f64, y: f64) -> bool {
    let a = s.ang.to_radians();
    let (ux, uy) = (a.cos(), a.sin());
    let (dx, dy) = (x - s.cx, y - s.cy);
    (dx * ux + dy * uy).abs() <= s.l / 2.0 + 0.05 && (-dx * uy + dy * ux).abs() <= s.w / 2.0 + 0.05
}

fn word(line: &str, key: char) -> Option<f64> {
    line.split(';')
        .next()?
        .split_whitespace()
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse().ok()))
}

/// One extruding move: feature, start, end, stated width.
type Move = (String, [f64; 2], [f64; 2], Option<f64>);

/// Per strip (by width), what it prints on the top layer and on the first.
fn measure(case: &str) -> (BTreeMap<String, Row>, BTreeMap<String, Row>) {
    let gcode = slice(case);
    let strips = strips(case);
    let (mut x, mut y): (Option<f64>, Option<f64>) = (None, None);
    let (mut feature, mut width, mut z) = (String::new(), None, None::<f64>);
    let mut moves: BTreeMap<(i64, usize), Vec<Move>> = BTreeMap::new();
    for line in gcode.lines() {
        if let Some(t) = line
            .strip_prefix(";TYPE:")
            .or_else(|| line.strip_prefix("; FEATURE:"))
        {
            t.trim().clone_into(&mut feature);
            continue;
        }
        if let Some(t) = line
            .strip_prefix(";WIDTH:")
            .or_else(|| line.strip_prefix("; LINE_WIDTH:"))
        {
            width = t.trim().parse().ok();
            continue;
        }
        if let Some(t) = line
            .strip_prefix(";Z:")
            .or_else(|| line.strip_prefix("; Z_HEIGHT:"))
        {
            z = t.trim().parse().ok();
            continue;
        }
        // The requests turn arc fitting off; a G2 or G3 would be read as its chord.
        assert!(
            !line.starts_with("G2 ") && !line.starts_with("G3 "),
            "an arc: {line}"
        );
        if !(line.starts_with("G1 ") || line.starts_with("G0 ")) {
            continue;
        }
        let (nx, ny) = (word(line, 'X').or(x), word(line, 'Y').or(y));
        let e = word(line, 'E').unwrap_or(0.0);
        if let (Some(ax), Some(ay), Some(bx), Some(by), Some(zz)) = (x, y, nx, ny, z)
            && e > 0.0
            && (ax != bx || ay != by)
        {
            let (mx, my) = (f64::midpoint(ax, bx), f64::midpoint(ay, by));
            if let Some(i) = strips.iter().position(|(_, s)| inside(s, mx, my)) {
                let key = ((zz * 1000.0).round() as i64, i);
                moves
                    .entry(key)
                    .or_default()
                    .push((feature.clone(), [ax, ay], [bx, by], width));
            }
        }
        (x, y) = (nx, ny);
    }
    let zs: Vec<i64> = moves.keys().map(|k| k.0).collect();
    let (top_z, first_z) = (*zs.iter().max().unwrap(), *zs.iter().min().unwrap());
    let rows = |z: i64, surface: &str| -> BTreeMap<String, Row> {
        strips
            .iter()
            .enumerate()
            .map(|(i, (_, s))| {
                let v = moves.get(&(z, i)).map_or(&[][..], Vec::as_slice);
                (format!("{:.3}", s.w), row(s, v, surface))
            })
            .collect()
    };
    (rows(top_z, "Top surface"), rows(first_z, "Bottom surface"))
}

fn row(s: &Strip, moves: &[Move], surface: &str) -> Row {
    let mut r = Row::default();
    let length = |a: [f64; 2], b: [f64; 2]| (b[0] - a[0]).hypot(b[1] - a[1]);
    for (f, a, b, _) in moves {
        *r.feat.entry(f.clone()).or_default() += length(*a, *b);
    }
    let lines: Vec<&Move> = moves
        .iter()
        .filter(|(f, a, b, _)| f == surface && length(*a, *b) >= 0.2)
        .collect();
    if lines.is_empty() {
        return r;
    }
    let deg = |a: [f64; 2], b: [f64; 2]| {
        (b[1] - a[1])
            .atan2(b[0] - a[0])
            .to_degrees()
            .rem_euclid(180.0)
            .round()
    };
    let mut by_dir: BTreeMap<i64, f64> = BTreeMap::new();
    for (_, a, b, _) in &lines {
        *by_dir.entry(deg(*a, *b) as i64 % 180).or_default() += length(*a, *b);
    }
    let dir = by_dir
        .iter()
        .max_by(|p, q| p.1.total_cmp(q.1))
        .map(|(d, _)| *d as f64)
        .unwrap();
    let off_dir = |d: f64| ((d - dir + 90.0).rem_euclid(180.0) - 90.0).abs();
    let (ux, uy) = (dir.to_radians().cos(), dir.to_radians().sin());
    let mut offs: Vec<f64> = lines
        .iter()
        .filter(|(_, a, b, _)| off_dir(deg(*a, *b)) < 3.0)
        .map(|(_, a, _, _)| -uy * (a[0] - s.cx) + ux * (a[1] - s.cy))
        .collect();
    offs.sort_by(f64::total_cmp);
    let mut merged: Vec<f64> = Vec::new();
    for o in offs {
        if merged.last().is_none_or(|m| o - m > 0.01) {
            merged.push(o);
        }
    }
    // The strip's extent across the lines, from its corners.
    let sa = s.ang.to_radians();
    let (su, sv) = (sa.cos(), sa.sin());
    let proj: Vec<f64> = [(-1.0, -1.0), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0)]
        .iter()
        .map(|(cu, cn)| {
            let px = su * cu * s.l / 2.0 - sv * cn * s.w / 2.0;
            let py = sv * cu * s.l / 2.0 + su * cn * s.w / 2.0;
            -uy * px + ux * py
        })
        .collect();
    let lo = proj.iter().copied().fold(f64::MAX, f64::min);
    let hi = proj.iter().copied().fold(f64::MIN, f64::max);
    r.lines = merged.len();
    r.along = ((dir - s.ang + 90.0).rem_euclid(180.0) - 90.0).abs() < 5.0;
    r.m0 = merged.first().unwrap() - lo;
    r.m1 = hi - merged.last().unwrap();
    r.gap = (merged.len() > 1)
        .then(|| (merged.last().unwrap() - merged.first().unwrap()) / (merged.len() - 1) as f64);
    let mut widths: Vec<f64> = lines.iter().filter_map(|m| m.3).collect();
    widths.sort_by(f64::total_cmp);
    widths.dedup();
    r.widths = widths;
    r
}

fn strip<'a>(rows: &'a BTreeMap<String, Row>, w: &str) -> &'a Row {
    rows.get(w).unwrap_or_else(|| panic!("no strip {w} mm wide"))
}

/// The surface lines of `r` are `n` lines along the strip, each `width` mm wide (within 0.001) and `margin` mm from
/// the strip's sides (within 0.002), with no gap fill.
fn lines_along(r: &Row, n: usize, width: f64, margin: Option<f64>, what: &str) {
    assert_eq!((r.lines, r.along), (n, true), "{what}: {r:?}");
    assert!(
        r.widths.iter().all(|w| (w - width).abs() <= 0.001),
        "{what}: {r:?}"
    );
    if let Some(m) = margin {
        assert!(
            (r.m0 - m).abs() <= 0.002 && (r.m1 - m).abs() <= 0.002,
            "{what}: {r:?}"
        );
    }
    assert!(r.len("Gap infill") < 0.5, "{what}: {r:?}");
}

/// Gap fill and no surface line.
fn gap_only(r: &Row, surface: &str, what: &str) {
    assert!(r.len("Gap infill") > 25.0, "{what}: {r:?}");
    assert!(r.len(surface) < 0.5, "{what}: {r:?}");
}

/// Walls only.
fn walls_only(r: &Row, what: &str) {
    let rest: f64 = r
        .feat
        .iter()
        .filter(|(f, _)| !matches!(f.as_str(), "Outer wall" | "Inner wall"))
        .map(|(_, l)| l)
        .sum();
    assert!(rest < 0.5, "{what}: {r:?}");
}

/// N-a and N-b. Ender-3 V3 at no sparse infill: a strip 1.740 mm wide (R = s0) prints one top line 0.42 mm wide down
/// its middle, and on the first layer one bottom line; 1.721 mm (R = 0.95 s0) keeps its gap fill bead.
#[test]
fn a_strip_one_spacing_wide_prints_one_line_and_a_narrower_one_keeps_gap_fill() {
    let (top, first) = measure("creality-ender-3-v3--n4-cl-sp0-al-flo");
    lines_along(strip(&top, "1.740"), 1, 0.420, Some(0.870), "top 1.740");
    lines_along(strip(&first, "1.740"), 1, 0.420, Some(0.870), "first 1.740");
    gap_only(strip(&top, "1.721"), "Top surface", "top 1.721");
    gap_only(strip(&first, "1.721"), "Bottom surface", "first 1.721");
}

/// N-c. A strip 1.928 mm wide (R = 1.5 s0) prints one line, spread to the 1.2 s0 cap: 0.495 mm wide, 0.908 mm
/// from the side it starts from.
#[test]
fn a_strip_one_and_a_half_spacings_wide_prints_one_capped_line() {
    let (top, first) = measure("creality-ender-3-v3--n4-cl-sp0-al");
    for (rows, what) in [(&top, "top"), (&first, "first")] {
        let r = strip(rows, "1.928");
        lines_along(r, 1, 0.495, None, what);
        assert!((r.m0 - 0.908).abs() <= 0.002, "{what}: {r:?}");
    }
}

/// N-d. Lines across the strips (along 135 degrees on strips along 45): once a line across fits (R at least s0, as
/// for lines along: W 1.759 mm), the top prints lines across at 0.3787 mm and the first layer its lines across joined
/// along both sides; the narrower strips (1.702 and 1.721 mm), where no line across fits, keep their gap fill.
#[test]
fn lines_across_a_strip_print_once_they_fit_and_it_keeps_gap_fill_before() {
    let (top, first) = measure("creality-ender-3-v3--n4-cl-sp0-ac-flo");
    for w in ["1.702", "1.721"] {
        gap_only(strip(&top, w), "Top surface", &format!("top {w}"));
        gap_only(strip(&first, w), "Bottom surface", &format!("first {w}"));
    }
    for w in ["1.759", "1.777", "1.796", "1.853", "2.041", "2.098"] {
        let r = strip(&top, w);
        assert!(!r.along && r.lines > 70, "top {w}: {r:?}");
        assert!((r.gap.unwrap() - 0.3787).abs() <= 0.0005, "top {w}: {r:?}");
        assert!(r.len("Gap infill") < 0.5, "top {w}: {r:?}");
        let r = strip(&first, w);
        assert!(
            r.along && r.lines == 2 && r.len("Bottom surface") > 30.0,
            "first {w}: {r:?}"
        );
        assert!(r.len("Gap infill") < 0.5, "first {w}: {r:?}");
    }
}

/// N-e. Voron 2.4, fixed-width walls, no sparse infill, the precise outer wall on: 2.453 mm (R just over s0 by the
/// surface's own inset, which follows the precise inner walls) prints one top line 0.403 mm wide down the middle;
/// 2.435 mm (R = 0.95 s0) keeps its gap fill.
#[test]
fn voron_strips_switch_to_one_line_at_one_spacing() {
    let (top, _) = measure("voron-2.4-300--n4-cl-sp0-al-flo");
    lines_along(strip(&top, "2.453"), 1, 0.403, Some(1.2265), "top 2.453");
    gap_only(strip(&top, "2.435"), "Top surface", "top 2.435");
}

/// N-f. MK4 first layer (its own wider lines), no sparse infill, the precise outer wall on: 2.977 mm prints one bottom
/// line 0.487 mm wide down the middle; 2.944 mm keeps its gap fill.
#[test]
fn mk4_first_layer_strips_switch_to_one_bottom_line() {
    let (_, first) = measure("prusa-mk4--n4-cl-sp0-al");
    let r = strip(&first, "2.977");
    lines_along(r, 1, 0.487, None, "first 2.977");
    assert!((r.m0 - r.m1).abs() <= 0.002, "first 2.977: {r:?}");
    gap_only(strip(&first, "2.944"), "Bottom surface", "first 2.944");
}

/// N-g. Voron 2.4, variable-width walls: 2.585 mm (the walls leave a hair under one inner spacing) prints walls only;
/// 2.603 mm prints one top line 0.471 mm wide.
#[test]
fn variable_width_walls_print_a_line_once_a_spacing_is_free() {
    let (top, _) = measure("voron-2.4-300--n4-ar-sp15-al-fmid");
    walls_only(strip(&top, "2.585"), "top 2.585");
    let r = strip(&top, "2.603");
    lines_along(r, 1, 0.471, None, "top 2.603");
    assert!((r.m0 - 1.2386).abs() <= 0.002, "top 2.603: {r:?}");
}

/// N-h. Ender-3 V3 with sparse infill and `top_bottom_infill_wall_overlap` 50 %: 1.551 and 1.589 mm (free width less
/// the overlap 0 and 0.1 si) print walls only on the top layer and the first.
#[test]
fn a_strip_the_overlap_closes_prints_walls_only() {
    let (top, first) = measure("creality-ender-3-v3--n4-cl-sp15-al-top_bott50");
    for w in ["1.551", "1.589"] {
        walls_only(strip(&top, w), &format!("top {w}"));
        walls_only(strip(&first, w), &format!("first {w}"));
    }
}

/// N-i (guard). With sparse infill: 2.136 mm prints a gap fill bead 29.35 mm long, 2.155 mm two lines 0.396 mm
/// apart, 0.439 mm wide.
#[test]
fn with_sparse_infill_narrow_strips_keep_gap_fill_until_two_lines_fit() {
    let (top, _) = measure("creality-ender-3-v3--n4-cl-sp15-al-fhi");
    let r = strip(&top, "2.136");
    gap_only(r, "Top surface", "top 2.136");
    assert!((r.len("Gap infill") - 29.35).abs() <= 0.05, "top 2.136: {r:?}");
    let r = strip(&top, "2.155");
    lines_along(r, 2, 0.439, None, "top 2.155");
    assert!((r.gap.unwrap() - 0.396).abs() <= 0.0015, "top 2.155: {r:?}");
}

/// Each strip as one letter: `.` walls only, `g` gap fill only, a digit for that many surface lines along, `X` for
/// lines across or more than 9, `o` anything else.
fn codes(rows: &BTreeMap<String, Row>, surface: &str) -> String {
    rows.values()
        .map(|r| {
            let gap = r.len("Gap infill") > 0.5;
            if r.lines > 0 {
                match (r.along, r.lines) {
                    (true, n @ 1..=9) if !gap => char::from_digit(n as u32, 10).unwrap(),
                    _ => 'X',
                }
            } else if gap {
                'g'
            } else if r
                .feat
                .iter()
                .any(|(f, l)| *l > 0.5 && !matches!(f.as_str(), "Outer wall" | "Inner wall") && f != surface)
            {
                'o'
            } else {
                '.'
            }
        })
        .collect()
}

/// N-j (guard). Sparse infill with fixed-width walls, and variable-width walls: the widths 1.551 to 2.306 mm by
/// 0.1 s0 print as before, top and first layer.
#[test]
fn with_sparse_infill_or_variable_width_walls_the_sweep_is_unchanged() {
    let (top, first) = measure("creality-ender-3-v3--n4-cl-sp15-al");
    assert_eq!(codes(&top, "Top surface"), "..gggggggggggggg22222");
    assert_eq!(codes(&first, "Bottom surface"), "..gggggggggggggg22222");
    let (top, first) = measure("creality-ender-3-v3--n4-ar-sp15-al");
    assert_eq!(codes(&top, "Top surface"), ".........111112222222");
    assert_eq!(codes(&first, "Bottom surface"), ".........111112222222");
}
