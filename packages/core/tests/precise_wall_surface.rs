// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where the top surface and the first layer's bottom surface start with fixed-width walls, with the precise outer
//! wall on and off.
//!
//! Plates of five 30.9 mm strips along 45 degrees (`fixtures/precise-wall-surface`: the requests, with the stock
//! profiles' settings and hand-set widths, the meshes and each strip's center, direction and size), the surface lines
//! running along the strips. Each strip is one object island. Per strip the tests read, on the top layer and the first,
//! the surface lines (count, stated widths, margins from the strip's sides, mean spacing) and the wall centerlines'
//! distances from the nearer long side. The surface inset `ins` is where the region the lines spread across starts:
//! a margin less half the line spacing, read on strips with 3 or more lines whose two margins agree.
//!
//! The rule, with s(w) = w - h (1 - pi/4) at the layer's height h, ow, iw and sw the outer wall, inner wall and
//! internal solid infill widths and ov `top_bottom_infill_wall_overlap`:
//!
//! - The outer wall's centerline is ow/2 from the outline. The first inner wall's is (ow + iw)/2 further in with the
//!   precise outer wall and the inner walls printed first, else (s(ow) + s(iw))/2; each further inner wall s(iw) more.
//! - The surface starts at c + s(iw)/2 - ov (s(iw) + s(sw))/2, c being the innermost wall's centerline.
//! - On the first layer every width is `initial_layer_line_width` when it is set, else each feature's own.
//! - Variable-width walls keep their own edge.
//!
//! One fixed-width wall keeps its lines on one grid here; spreading them is a separate change.
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

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/precise-wall-surface");

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
    /// Surface lines at least 0.2 mm long in the dominant direction.
    lines: usize,
    /// The surface lines' stated widths.
    widths: Vec<f64>,
    /// The margins from the outermost surface lines to the strip's sides, across the lines.
    m0: f64,
    m1: f64,
    /// The mean distance between neighboring surface lines.
    gap: Option<f64>,
    /// Wall centerlines along the strip, as distances from its nearer long side, with each one's length.
    walls: Vec<(f64, f64)>,
}

/// One layer of a plate: each strip's row by its width.
type Layer = BTreeMap<String, Row>;

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

fn strips(case: &str) -> Vec<Strip> {
    let v: Value =
        serde_json::from_slice(&std::fs::read(format!("{FIXTURES}/{case}.strips.json")).unwrap()).unwrap();
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let f = |k: &str| s[k].as_f64().unwrap();
            Strip {
                cx: f("cx"),
                cy: f("cy"),
                ang: f("ang"),
                w: f("W"),
                l: f("L"),
            }
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
fn measure(case: &str) -> (Layer, Layer) {
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
            if let Some(i) = strips.iter().position(|s| inside(s, mx, my)) {
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
    let rows = |z: i64, surface: &str| -> Layer {
        strips
            .iter()
            .enumerate()
            .map(|(i, s)| {
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
    let deg = |a: [f64; 2], b: [f64; 2]| (b[1] - a[1]).atan2(b[0] - a[0]).to_degrees();
    let off = |d: f64, dir: f64| ((d - dir + 90.0).rem_euclid(180.0) - 90.0).abs();
    let (su, sv) = (s.ang.to_radians().cos(), s.ang.to_radians().sin());
    // Walls: moves at least 1 mm long within 3 degrees of the strip, their midpoints in the middle 60 % of its
    // length, merged within 0.003 mm.
    let mut walls: Vec<(f64, f64)> = moves
        .iter()
        .filter(|(f, a, b, _)| {
            f.ends_with(" wall") && length(*a, *b) >= 1.0 && off(deg(*a, *b), s.ang) <= 3.0
        })
        .filter_map(|(_, a, b, _)| {
            let (mx, my) = (f64::midpoint(a[0], b[0]) - s.cx, f64::midpoint(a[1], b[1]) - s.cy);
            ((mx * su + my * sv).abs() <= 0.3 * s.l)
                .then(|| (s.w / 2.0 - (-mx * sv + my * su).abs(), length(*a, *b)))
        })
        .collect();
    walls.sort_by(|p, q| p.0.total_cmp(&q.0));
    let mut clusters: Vec<(Vec<f64>, f64)> = Vec::new();
    for (d, l) in walls {
        match clusters.last_mut() {
            Some((ds, len)) if d - ds.last().unwrap() <= 0.003 => {
                ds.push(d);
                *len += l;
            }
            _ => clusters.push((vec![d], l)),
        }
    }
    r.walls = clusters
        .into_iter()
        .map(|(ds, l)| (ds.iter().sum::<f64>() / ds.len() as f64, l))
        .collect();
    let lines: Vec<&Move> = moves
        .iter()
        .filter(|(f, a, b, _)| f == surface && length(*a, *b) >= 0.2)
        .collect();
    if lines.is_empty() {
        return r;
    }
    let mut by_dir: BTreeMap<i64, f64> = BTreeMap::new();
    for (_, a, b, _) in &lines {
        *by_dir
            .entry(deg(*a, *b).rem_euclid(180.0).round() as i64 % 180)
            .or_default() += length(*a, *b);
    }
    let dir = by_dir
        .iter()
        .max_by(|p, q| p.1.total_cmp(q.1))
        .map(|(d, _)| *d as f64)
        .unwrap();
    let (ux, uy) = (dir.to_radians().cos(), dir.to_radians().sin());
    let mut offs: Vec<f64> = lines
        .iter()
        .filter(|(_, a, b, _)| off(deg(*a, *b), dir) < 3.0)
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

/// The surface inset of a layer: the mean of each margin less half the spacing, over the strips with 3 or more
/// lines whose two margins agree within 0.01 mm.
fn ins(layer: &Layer, what: &str) -> f64 {
    let v: Vec<f64> = layer
        .values()
        .filter(|r| r.lines >= 3 && (r.m0 - r.m1).abs() < 0.01)
        .flat_map(|r| [r.m0 - r.gap.unwrap() / 2.0, r.m1 - r.gap.unwrap() / 2.0])
        .collect();
    assert!(
        v.len() >= 2,
        "{what}: no strip with 3 or more evenly spread lines: {layer:#?}"
    );
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    let spread = v.iter().copied().fold(f64::MIN, f64::max) - v.iter().copied().fold(f64::MAX, f64::min);
    assert!(spread < 0.003, "{what}: insets spread {spread}: {v:?}");
    mean
}

/// The plate `case`'s surface insets, top and first layer, are `top` and `first` within `tol` mm.
fn insets(case: &str, top: f64, first: f64, tol: f64) -> (Layer, Layer) {
    let (t, f) = measure(case);
    let (it, i0) = (ins(&t, case), ins(&f, case));
    assert!(
        (it - top).abs() <= tol && (i0 - first).abs() <= tol,
        "{case}: insets top {it:.4} first {i0:.4}, want {top} and {first}"
    );
    (t, f)
}

/// The wall centerlines of a layer seen on 3 or more strips (strips' walls merged within 0.004 mm), from the
/// outline.
fn walls(layer: &Layer) -> Vec<f64> {
    let mut all: Vec<f64> = layer
        .values()
        .flat_map(|r| r.walls.iter().filter(|w| w.1 > 5.0).map(|w| w.0))
        .collect();
    all.sort_by(f64::total_cmp);
    let mut clusters: Vec<Vec<f64>> = Vec::new();
    for d in all {
        match clusters.last_mut() {
            Some(c) if d - c.last().unwrap() <= 0.004 => c.push(d),
            _ => clusters.push(vec![d]),
        }
    }
    clusters
        .into_iter()
        .filter(|c| c.len() >= 3)
        .map(|c| c.iter().sum::<f64>() / c.len() as f64)
        .collect()
}

fn walls_at(layer: &Layer, want: &[f64], what: &str) {
    let got = walls(layer);
    assert!(
        got.len() == want.len() && got.iter().zip(want).all(|(g, w)| (g - w).abs() <= 0.0005),
        "{what}: walls {got:?}, want {want:?}"
    );
}

/// Fixed-width walls by the rule: outer wall ow/2, first inner wall the widths' mean further in with `precise`, else
/// the spacings' mean, then s(iw) per further wall, at layer height `h`.
fn rule_walls(loops: u32, ow: f64, iw: f64, h: f64, precise: bool) -> Vec<f64> {
    let s = |w: f64| w - h * (1.0 - std::f64::consts::FRAC_PI_4);
    let mut c = vec![ow / 2.0];
    if loops > 1 {
        c.push(
            ow / 2.0
                + if precise {
                    f64::midpoint(ow, iw)
                } else {
                    f64::midpoint(s(ow), s(iw))
                },
        );
    }
    for _ in 2..loops {
        c.push(c.last().unwrap() + s(iw));
    }
    c
}

/// P-a. Voron 2.4, three fixed-width walls, precise outer wall on: the surface starts h (1 - pi/4) further in than
/// the spacings' mean puts it, following the first inner wall. The first layer's strip 4.007 mm wide prints two
/// lines at the capped spacing, the first 1.5954 mm from the side.
#[test]
fn precise_outer_wall_moves_the_surface_edge_with_the_inner_walls() {
    let (_, first) = insets("voron-2.4-300--n4-cl-p1-L3", 1.0463, 1.3213, 0.0015);
    let r = &first["4.007"];
    assert_eq!(r.lines, 2, "first 4.007: {r:?}");
    assert!((r.m0 - 1.5954).abs() <= 0.002, "first 4.007: {r:?}");
    assert!(
        r.widths.iter().all(|w| (w - 0.591).abs() <= 0.001),
        "first 4.007: {r:?}"
    );
}

/// P-b. MK4, three fixed-width walls, precise on (inner wall 0.44, internal solid 0.48).
#[test]
fn mk4_precise_outer_wall_moves_the_surface_edge() {
    insets("prusa-mk4--n4-cl-p1-L3", 1.1113, 1.2663, 0.0015);
}

/// P-c, P-d and P-e. Ender-3 V3 with precise on at nozzles 0.2, 0.6 and 0.8 (layers 0.1, 0.3 and 0.4 mm): the
/// move is h (1 - pi/4) at each layer height, top and first layer.
#[test]
fn the_precise_move_scales_with_the_layer_height() {
    insets("creality-ender-3-v3--n2-cl-p1-L3", 0.5507, 0.5507, 0.0015);
    insets("creality-ender-3-v3--n6-cl-p1-L3", 1.6520, 1.6520, 0.0015);
    insets("creality-ender-3-v3--n8-cl-p1-L2", 1.4485, 1.4485, 0.0015);
}

/// P-f. Ender-3 V3, inner walls 0.5 mm wider than the outer 0.42 mm, precise on: the first inner wall's pitch is
/// the widths' mean, and the overlap is of the mean of the inner wall's and the internal solid infill's spacings.
#[test]
fn wider_inner_walls_with_precise_on_move_the_edge_by_their_pitch() {
    insets(
        "creality-ender-3-v3--n4-cl-p1-L3-w0.42_0.5",
        1.2513,
        1.2513,
        0.0015,
    );
}

/// P-g. MK4 with precise off: only the overlap term moves the top surface's edge (inner wall 0.44 against internal
/// solid 0.48). The first layer prints every feature 0.48 mm wide and stays.
#[test]
fn the_overlap_is_of_the_mean_of_the_inner_and_solid_spacings() {
    insets("prusa-mk4--n4-cl-p0-L3", 1.0684, 1.2234, 0.0015);
}

/// P-h. Voron 2.4 at nozzle 0.8 with 1.0 mm inner walls and 0.82 mm internal solid infill, precise off and on.
#[test]
fn wide_inner_walls_at_a_large_nozzle_move_the_edge_by_both_terms() {
    insets("voron-2.4-300--n8-cl-p0-L3-w0.8_1.0", 2.3794, 2.5569, 0.002);
    insets("voron-2.4-300--n8-cl-p1-L3-w0.8_1.0", 2.4652, 2.6427, 0.002);
}

/// P-k. Voron 2.4, outer 0.4 and inner 0.5 mm, precise on: the top strip 5.321 mm wide prints 7 lines.
#[test]
fn the_moved_edge_changes_the_line_count_where_it_crosses_a_whole_line() {
    let (top, _) = insets("voron-2.4-300--n4-cl-p1-L3-w0.4_0.5", 1.2338, 1.3213, 0.0015);
    let r = &top["5.321"];
    assert_eq!(r.lines, 7, "top 5.321: {r:?}");
}

/// G-a (guard). With the outer wall first, or inner-outer-inner, the precise outer wall moves no inner wall, and the
/// surface edge stays.
#[test]
fn other_wall_orders_keep_the_edge() {
    insets("voron-2.4-300--n4-cl-p1-L3-oi", 1.0034, 1.2784, 0.0015);
    insets("voron-2.4-300--n4-cl-p1-L3-ioi", 1.0034, 1.2784, 0.0015);
}

/// G-b (guard). Ender-3 V3 stock widths, precise off: inner wall and internal solid infill equally wide, so the edge
/// stays.
#[test]
fn precise_off_with_equal_widths_keeps_the_edge() {
    insets("creality-ender-3-v3--n4-cl-p0-L3", 1.0584, 1.0584, 0.0015);
}

/// G-c (guard). Variable-width walls keep their edge, precise on or off.
#[test]
fn variable_width_walls_keep_their_edge() {
    insets("voron-2.4-300--n4-ar-p0-L3", 1.0034, 1.2784, 0.0015);
    insets("voron-2.4-300--n4-ar-p1-L3", 1.0249, 1.2999, 0.0015);
    insets("prusa-mk4--n4-ar-p1-L3", 1.0950, 1.2450, 0.0015);
}

/// A fixed-width plate's walls: the case, the wall count, the top layer's outer and inner widths and height, the
/// first layer's, and whether the precise outer wall moves the inner walls.
type WallCase = (&'static str, u32, [f64; 3], [f64; 3], bool);

/// The fixed-width plates whose walls G-d checks.
const WALL_CASES: [WallCase; 13] = [
    (
        "voron-2.4-300--n4-cl-p1-L3",
        3,
        [0.4, 0.4, 0.2],
        [0.5, 0.5, 0.2],
        true,
    ),
    (
        "prusa-mk4--n4-cl-p1-L3",
        3,
        [0.4, 0.44, 0.2],
        [0.48, 0.48, 0.2],
        true,
    ),
    (
        "creality-ender-3-v3--n2-cl-p1-L3",
        3,
        [0.21, 0.21, 0.1],
        [0.21, 0.21, 0.1],
        true,
    ),
    (
        "creality-ender-3-v3--n6-cl-p1-L3",
        3,
        [0.63, 0.63, 0.3],
        [0.63, 0.63, 0.3],
        true,
    ),
    (
        "creality-ender-3-v3--n8-cl-p1-L2",
        2,
        [0.84, 0.84, 0.4],
        [0.84, 0.84, 0.4],
        true,
    ),
    (
        "creality-ender-3-v3--n4-cl-p1-L3-w0.42_0.5",
        3,
        [0.42, 0.5, 0.2],
        [0.42, 0.5, 0.2],
        true,
    ),
    (
        "prusa-mk4--n4-cl-p0-L3",
        3,
        [0.4, 0.44, 0.2],
        [0.48, 0.48, 0.2],
        false,
    ),
    (
        "voron-2.4-300--n8-cl-p0-L3-w0.8_1.0",
        3,
        [0.8, 1.0, 0.4],
        [1.0, 1.0, 0.4],
        false,
    ),
    (
        "voron-2.4-300--n8-cl-p1-L3-w0.8_1.0",
        3,
        [0.8, 1.0, 0.4],
        [1.0, 1.0, 0.4],
        true,
    ),
    (
        "voron-2.4-300--n4-cl-p1-L3-w0.4_0.5",
        3,
        [0.4, 0.5, 0.2],
        [0.5, 0.5, 0.2],
        true,
    ),
    (
        "voron-2.4-300--n4-cl-p1-L3-oi",
        3,
        [0.4, 0.4, 0.2],
        [0.5, 0.5, 0.2],
        false,
    ),
    (
        "voron-2.4-300--n4-cl-p1-L3-ioi",
        3,
        [0.4, 0.4, 0.2],
        [0.5, 0.5, 0.2],
        false,
    ),
    (
        "creality-ender-3-v3--n4-cl-p0-L3",
        3,
        [0.42, 0.42, 0.2],
        [0.42, 0.42, 0.2],
        false,
    ),
];

/// G-d (guard). The walls stay where they were: by the rule on every fixed-width plate, top and first layer, and at
/// their measured places with variable-width walls.
#[test]
fn the_walls_do_not_move() {
    for (case, loops, [ow, iw, h], [ow0, iw0, h0], precise) in WALL_CASES {
        let (top, first) = measure(case);
        walls_at(
            &top,
            &rule_walls(loops, ow, iw, h, precise),
            &format!("{case} top"),
        );
        walls_at(
            &first,
            &rule_walls(loops, ow0, iw0, h0, precise),
            &format!("{case} first"),
        );
    }
    let (top, _) = measure("voron-2.4-300--n4-ar-p0-L3");
    walls_at(&top, &[0.2, 0.5571, 0.9142], "arachne precise off");
    let (top, _) = measure("voron-2.4-300--n4-ar-p1-L3");
    walls_at(&top, &[0.2, 0.5785, 0.9356], "arachne precise on");
}
