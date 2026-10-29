// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Surface lines that run across a narrow strip: where they start, how they spread along it and what the first layer
//! prints there.
//!
//! Plates of strips (`fixtures/line-across`: the requests, the meshes and each strip's center, direction and size,
//! where the slice puts it) on the Ender-3 V3, Voron 2.4 and MK4 requests with flattened speeds. A strip `T<t>` is
//! W = 2 ins + t s0 wide, ins being where the surface starts and s0 the surface's line spacing, so its free width is
//! R = W - 2 ins = t s0; `T<t>-K<k>` is also only 2 ins + k s0 long. The strips run along 135 degrees and the surface
//! lines along 45 (along 90 and 0 on the `d0` plate), so the lines run across them; the `al` plates turn the strips
//! along the lines. Per strip the tests read, on the top layer and the first, the extruded length of each feature
//! whose moves' midpoints lie in the strip, and of the surface feature the pieces across the strip (their positions
//! along it, margins from its ends, lengths, ends' distances from its long sides and stated widths) and the pieces
//! along it (their offsets from the low long side).
//!
//! - A strip prints lines across it once R reaches s0, where lines along it would start, whatever pitch they spread
//!   to along it (up to 1.2 s0 on a short strip). Fixed-width walls with no sparse infill keep the gap fill bead below
//!   that; variable-width walls print walls only.
//! - On the first layer the monotonic bottom joins the lines with connectors along the strip, which at R = s0 make
//!   one path down its middle.
//! - Strips whose lines run along them, sparse infill with fixed-width walls, variable-width walls at the stock
//!   overlap and the spread along short strips print as before.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::disallowed_methods,
    clippy::float_cmp,
    reason = "a G-code reader for the test: positions, angles and lengths in mm"
)]

use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/line-across");

/// Ender-3 V3 0.4: where the top surface and the first layer's bottom surface start, and their line spacing, mm.
const ENDER_INS: f64 = 0.681_35;
const ENDER_S0: f64 = 0.377_08;

/// One strip of a plate: its name, center, the direction it runs (degrees), its width and length, mm, and the
/// length in surface spacings it was built with, if set.
struct Strip {
    name: String,
    cx: f64,
    cy: f64,
    ang: f64,
    w: f64,
    l: f64,
    k: Option<f64>,
}

/// What one strip prints on one layer.
#[derive(Debug, Default)]
struct Row {
    /// The strip's width, mm.
    w: f64,
    /// Extruded length per feature, mm.
    feat: BTreeMap<String, f64>,
    /// Surface pieces within 10 degrees of across the strip: their positions along it (merged within 0.01 mm).
    across: Vec<f64>,
    /// Their mean pitch, the margins from the strip's ends to the first and last, their mean length and the mean
    /// distances from the strip's long sides to their ends.
    pitch: Option<f64>,
    mx: (f64, f64),
    len: f64,
    ends: (f64, f64),
    /// Surface pieces within 10 degrees of along the strip: their total length and offsets from its low long side
    /// (merged within 0.01 mm).
    along: f64,
    offsets: Vec<f64>,
    /// The surface's stated widths.
    widths: Vec<f64>,
}

impl Row {
    fn len_of(&self, feature: &str) -> f64 {
        self.feat.get(feature).copied().unwrap_or(0.0)
    }
}

/// One plate: per strip name, its row on the top layer and on the first, and the strips.
struct Plate {
    top: BTreeMap<String, Row>,
    first: BTreeMap<String, Row>,
    strips: Vec<Strip>,
}

impl Plate {
    /// The strips named from `lo` to `hi` (by their t, then k).
    fn names(&self, lo: &str, hi: &str) -> Vec<String> {
        let key = |n: &str| -> (f64, f64) {
            let mut it = n.trim_start_matches('T').split("-K");
            let t = it.next().unwrap().parse().unwrap();
            let k = it.next().map_or(0.0, |k| k.parse().unwrap());
            (t, k)
        };
        let (a, b) = (key(lo), key(hi));
        let names: Vec<String> = self
            .strips
            .iter()
            .map(|s| s.name.clone())
            .filter(|n| {
                let k = key(n);
                k.0 >= a.0 && k.0 <= b.0 && (a.1 == 0.0 || (k.1 >= a.1 && k.1 <= b.1))
            })
            .collect();
        assert!(names.len() >= 2, "no strips {lo} to {hi}");
        names
    }
}

fn layer<'a>(rows: &'a BTreeMap<String, Row>, name: &str) -> &'a Row {
    rows.get(name).unwrap_or_else(|| panic!("no strip {name}"))
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

fn strips(case: &str) -> Vec<Strip> {
    let v: Value =
        serde_json::from_slice(&std::fs::read(format!("{FIXTURES}/{case}.strips.json")).unwrap()).unwrap();
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let f = |k: &str| s[k].as_f64().unwrap();
            Strip {
                name: s["name"].as_str().unwrap().to_owned(),
                cx: f("cx"),
                cy: f("cy"),
                ang: f("ang"),
                w: f("W"),
                l: f("L"),
                k: s["k"].as_f64(),
            }
        })
        .collect()
}

/// A point in the strip's frame: along its axis from its center, and across it.
fn frame(s: &Strip, p: [f64; 2]) -> (f64, f64) {
    let a = s.ang.to_radians();
    let (ux, uy) = (a.cos(), a.sin());
    let (dx, dy) = (p[0] - s.cx, p[1] - s.cy);
    (dx * ux + dy * uy, -dx * uy + dy * ux)
}

fn inside(s: &Strip, p: [f64; 2]) -> bool {
    let (u, v) = frame(s, p);
    u.abs() <= s.l / 2.0 + 0.05 && v.abs() <= s.w / 2.0 + 0.05
}

fn word(line: &str, key: char) -> Option<f64> {
    line.split(';')
        .next()?
        .split_whitespace()
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse().ok()))
}

/// One extruding move: feature, start, end, stated width.
type Move = (String, [f64; 2], [f64; 2], Option<f64>);

/// Per strip, what it prints on the top layer and on the first.
fn measure(case: &str) -> Plate {
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
            let mid = [f64::midpoint(ax, bx), f64::midpoint(ay, by)];
            if let Some(i) = strips.iter().position(|s| inside(s, mid)) {
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
            .map(|(i, s)| {
                let v = moves.get(&(z, i)).map_or(&[][..], Vec::as_slice);
                (s.name.clone(), row(s, v, surface))
            })
            .collect()
    };
    Plate {
        top: rows(top_z, "Top surface"),
        first: rows(first_z, "Bottom surface"),
        strips,
    }
}

fn merged(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(f64::total_cmp);
    let mut out: Vec<f64> = Vec::new();
    for o in v {
        if out.last().is_none_or(|m| o - m > 0.01) {
            out.push(o);
        }
    }
    out
}

fn row(s: &Strip, moves: &[Move], surface: &str) -> Row {
    let mut r = Row {
        w: s.w,
        ..Row::default()
    };
    for (f, a, b, _) in moves {
        *r.feat.entry(f.clone()).or_default() += (b[0] - a[0]).hypot(b[1] - a[1]);
    }
    let mut across: Vec<(f64, f64, f64, f64)> = Vec::new();
    let mut along: Vec<f64> = Vec::new();
    let mut widths: Vec<f64> = Vec::new();
    for (f, a, b, w) in moves {
        let ((u0, v0), (u1, v1)) = (frame(s, *a), frame(s, *b));
        let len = (u1 - u0).hypot(v1 - v0);
        if f != surface || len < 0.005 {
            continue;
        }
        widths.extend(*w);
        let off = ((v1 - v0).atan2(u1 - u0).to_degrees() + 90.0).rem_euclid(180.0) - 90.0;
        if off.abs() >= 80.0 {
            across.push((f64::midpoint(u0, u1), v0.min(v1), v0.max(v1), len));
        } else if off.abs() <= 10.0 {
            r.along += len;
            along.push(f64::midpoint(v0, v1) + s.w / 2.0);
        }
    }
    widths.sort_by(f64::total_cmp);
    widths.dedup();
    r.widths = widths;
    r.offsets = merged(along);
    if !across.is_empty() {
        let n = across.len() as f64;
        r.across = merged(across.iter().map(|q| q.0).collect());
        let (first, last) = (r.across[0], *r.across.last().unwrap());
        r.pitch = (r.across.len() > 1).then(|| (last - first) / (r.across.len() - 1) as f64);
        r.mx = (first + s.l / 2.0, s.l / 2.0 - last);
        r.len = across.iter().map(|q| q.3).sum::<f64>() / n;
        r.ends = (
            across.iter().map(|q| s.w / 2.0 + q.1).sum::<f64>() / n,
            across.iter().map(|q| s.w / 2.0 - q.2).sum::<f64>() / n,
        );
    }
    r
}

fn near(got: f64, want: f64, tol: f64, what: &str) {
    assert!(
        (got - want).abs() <= tol,
        "{what}: {got} against {want} (within {tol})"
    );
}

/// Lines across the strip and no gap fill: `n` of them `pitch` apart (within 0.0005 mm), their first and last
/// `mx` from the strip's ends (within 0.002, or `mx_tol`), each `width` wide (within 0.001).
fn lines_across(r: &Row, n: usize, pitch: Option<f64>, mx: (f64, f64), mx_tol: f64, width: f64, what: &str) {
    assert_eq!(r.across.len(), n, "{what}: {r:?}");
    if let Some(p) = pitch {
        near(r.pitch.unwrap(), p, 0.0005, &format!("{what} pitch"));
    }
    near(r.mx.0, mx.0, mx_tol, &format!("{what} mx0"));
    near(r.mx.1, mx.1, mx_tol, &format!("{what} mx1"));
    assert!(
        !r.widths.is_empty() && r.widths.iter().all(|w| (w - width).abs() <= 0.001),
        "{what}: widths {:?}",
        r.widths
    );
    assert!(r.len_of("Gap infill") < 0.05, "{what}: {r:?}");
}

/// Each line across ends `e` from the strip's long sides (within 0.002 mm).
fn ends(r: &Row, e: f64, what: &str) {
    near(r.ends.0, e, 0.002, &format!("{what} e0"));
    near(r.ends.1, e, 0.002, &format!("{what} e1"));
}

/// No surface and a gap fill bead of at least `bead` mm.
fn gap_only(r: &Row, surface: &str, bead: f64, what: &str) {
    assert!(r.len_of(surface) < 0.05, "{what}: {r:?}");
    assert!(r.len_of("Gap infill") >= bead, "{what}: {r:?}");
}

/// Walls only.
fn walls_only(r: &Row, what: &str) {
    let rest: f64 = r
        .feat
        .iter()
        .filter(|(f, _)| !matches!(f.as_str(), "Outer wall" | "Inner wall"))
        .map(|(_, l)| l)
        .sum();
    assert!(rest < 0.05, "{what}: {r:?}");
}

/// The first layer at R = s0: one bottom path down the strip's middle, its pieces along the strip within `tol` of
/// `mid` from either long side and the pieces across it vanishing (under 0.03 mm), no gap fill.
fn one_path_down_the_middle(r: &Row, mid: f64, tol: f64, what: &str) {
    assert!(r.along > 0.9 * 27.0, "{what}: {r:?}");
    assert!(!r.offsets.is_empty() && r.offsets.len() <= 2, "{what}: {r:?}");
    for o in &r.offsets {
        assert!(
            (o - mid).abs() <= tol || (r.w - o - mid).abs() <= tol,
            "{what}: a piece along {o} from the low side: {r:?}"
        );
    }
    assert!(r.across.is_empty() || r.len < 0.03, "{what}: {r:?}");
    assert!(r.len_of("Gap infill") < 0.05, "{what}: {r:?}");
}

/// Connectors along both long sides, each `side` from its side (within `tol` mm), no gap fill.
fn connectors(r: &Row, side: f64, tol: f64, what: &str) {
    assert_eq!(r.offsets.len(), 2, "{what}: {r:?}");
    near(r.offsets[0], side, tol, &format!("{what} low connector"));
    near(r.w - r.offsets[1], side, tol, &format!("{what} high connector"));
    assert!(r.len_of("Gap infill") < 0.05, "{what}: {r:?}");
}

/// LA-1. Ender-3 V3 0.4, fixed-width walls, no sparse infill: T0.990 keeps its gap fill bead; every strip from
/// T1.010 prints 78 top lines across 0.37868 mm apart, 0.871 mm from the ends, 0.700 mm in from the long sides and
/// W - 1.4003 mm long. On the first layer T1.010 prints one bottom path down the middle and the wider strips
/// connectors 0.870 mm in from each side, with pieces across them about R - s0 long.
#[test]
fn la1_lines_across_start_at_one_spacing() {
    let p = measure("creality-ender-3-v3--n4-cl-sp0-ac-f");
    let r = layer(&p.top, "T0.990");
    gap_only(r, "Top surface", 29.3, "top T0.990");
    near(r.len_of("Gap infill"), 29.35, 0.05, "top T0.990 bead");
    gap_only(layer(&p.first, "T0.990"), "Bottom surface", 29.3, "first T0.990");
    for name in p.names("T1.010", "T1.300") {
        let r = layer(&p.top, &name);
        let what = format!("top {name}");
        lines_across(r, 78, Some(0.378_68), (0.871, 0.871), 0.002, 0.4216, &what);
        ends(r, 0.700, &what);
        near(r.len, r.w - 1.4003, 0.003, &format!("{what} length"));
    }
    one_path_down_the_middle(layer(&p.first, "T1.010"), 0.870, 0.005, "first T1.010");
    for name in p.names("T1.110", "T1.300") {
        let r = layer(&p.first, &name);
        let what = format!("first {name}");
        // The connectors keep half the pitch less a hair (5 um) in, as they did on the strips that printed lines
        // before: up to 0.0051 mm inside 0.870, and 0.013 mm more across piece than R - s0.
        connectors(r, 0.870, 0.006, &what);
        near(
            r.len,
            r.w - 2.0 * ENDER_INS - ENDER_S0,
            0.015,
            &format!("{what} across piece"),
        );
    }
}

/// LA-1b. The same strips along 90 degrees with the lines at 0 degrees: T1.010 to T1.110 print 78 lines across,
/// 0.37868 mm apart, 0.871 mm from the ends and 0.7005 mm in from the long sides.
#[test]
fn la1b_lines_across_start_at_one_spacing_at_zero_degrees() {
    let p = measure("creality-ender-3-v3--n4-cl-sp0-ac-d0");
    gap_only(layer(&p.top, "T0.990"), "Top surface", 29.3, "top T0.990");
    for name in p.names("T1.010", "T1.110") {
        let r = layer(&p.top, &name);
        let what = format!("top {name}");
        lines_across(r, 78, Some(0.378_68), (0.871, 0.871), 0.002, 0.4216, &what);
        ends(r, 0.7005, &what);
    }
}

/// LA-2. Strips 2.5 s0 long, where the 2 lines spread to the 1.2 s0 cap (0.45255 mm) along the strip: T0.990 keeps
/// its gap fill bead; every strip from T1.020 prints its 2 lines across on both layers, 0.9075 and 0.9449 mm from the
/// ends, 0.4954 mm wide, with today's ends (0.05 of the pitch in from each free edge).
#[test]
fn la2_short_strips_print_lines_across_from_one_spacing() {
    let p = measure("creality-ender-3-v3--n4-cl-sp0-ac-k2.5f");
    let r = layer(&p.top, "T0.990-K2.500");
    gap_only(r, "Top surface", 0.7, "top T0.990-K2.500");
    for name in p.names("T1.020-K2.500", "T1.400-K2.500") {
        let r = layer(&p.top, &name);
        let what = format!("top {name}");
        lines_across(r, 2, Some(0.452_55), (0.9075, 0.9449), 0.002, 0.4954, &what);
        near(
            r.len,
            r.w - 2.0 * ENDER_INS - 0.1 * 0.452_55,
            0.003,
            &format!("{what} length"),
        );
        let r = layer(&p.first, &name);
        let what = format!("first {name}");
        assert_eq!(r.across.len(), 2, "{what}: {r:?}");
        near(r.mx.0, 0.9075, 0.002, &format!("{what} mx0"));
        near(r.mx.1, 0.9449, 0.002, &format!("{what} mx1"));
        assert!(r.len_of("Gap infill") < 0.05, "{what}: {r:?}");
    }
}

/// LA-2b. Strips 1.5 s0 long, one line across: every strip from T1.050-K1.500 prints it, 0.907 and 1.021 mm from
/// the ends, 0.4954 mm wide.
#[test]
fn la2b_a_strip_one_and_a_half_spacings_long_prints_one_line_across() {
    let p = measure("creality-ender-3-v3--n4-cl-sp0-ac-k1.5");
    for name in p.names("T1.050-K1.500", "T2.200-K1.500") {
        let r = layer(&p.top, &name);
        lines_across(r, 1, None, (0.907, 1.021), 0.002, 0.4954, &format!("top {name}"));
    }
}

/// LA-3. Variable-width walls at `top_bottom_infill_wall_overlap` 0: T1.000 prints walls only on both layers; every
/// strip from T1.020 prints 77 top lines across 0.38115 mm apart, 0.967 mm from the ends and 0.794 mm in from the
/// long sides, and on the first layer one path down the middle at T1.020 and connectors 0.964 mm in from T1.250.
#[test]
fn la3_variable_width_walls_print_lines_across_from_one_spacing() {
    let p = measure("creality-ender-3-v3--n4-ar-sp15-ac-ov0f");
    walls_only(layer(&p.top, "T1.000"), "top T1.000");
    walls_only(layer(&p.first, "T1.000"), "first T1.000");
    for name in p.names("T1.020", "T1.250") {
        let r = layer(&p.top, &name);
        let what = format!("top {name}");
        // The infill area's far end sits up to 5 um off on the narrowest strips, as the walls leave it.
        lines_across(r, 77, Some(0.381_15), (0.967, 0.967), 0.005, 0.4241, &what);
        ends(r, 0.794, &what);
    }
    one_path_down_the_middle(layer(&p.first, "T1.020"), 0.968, 0.008, "first T1.020");
    connectors(layer(&p.first, "T1.250"), 0.964, 0.005, "first T1.250");
}

/// LA-4. Voron 2.4 with the precise outer wall: T0.990 keeps its gap fill bead; T1.010 to T1.130 print 80 lines
/// across 0.36009 mm apart, 1.2265 mm from the ends and 1.0642 mm in from the long sides, 0.4030 mm wide.
#[test]
fn la4_voron_lines_across_start_at_one_spacing() {
    let p = measure("voron-2.4-300--n4-cl-sp0-ac-f");
    gap_only(layer(&p.top, "T0.990"), "Top surface", 25.0, "top T0.990");
    for name in p.names("T1.010", "T1.130") {
        let r = layer(&p.top, &name);
        let what = format!("top {name}");
        lines_across(r, 80, Some(0.360_09), (1.2265, 1.2265), 0.002, 0.4030, &what);
        ends(r, 1.0642, &what);
    }
}

/// LA-5. Nozzles 0.8 (Ender-3 V3) and 0.2 (MK4): T1.010 prints 37 lines across 0.76148 mm apart, and T1.020 179
/// lines 0.16642 mm apart.
#[test]
fn la5_large_and_small_nozzles_print_lines_across_from_one_spacing() {
    let p = measure("creality-ender-3-v3--n8-cl-sp0-ac-f");
    let r = layer(&p.top, "T1.010");
    lines_across(
        r,
        37,
        Some(0.761_48),
        (1.744, 1.744),
        0.002,
        0.8473,
        "Ender 0.8 T1.010",
    );
    ends(r, 1.4004, "Ender 0.8 T1.010");
    let p = measure("prusa-mk4--n2-cl-sp0-ac-f");
    let r = layer(&p.top, "T1.020");
    lines_across(
        r,
        179,
        Some(0.166_42),
        (0.639, 0.639),
        0.002,
        0.1879,
        "MK4 0.2 T1.020",
    );
    ends(r, 0.564, "MK4 0.2 T1.020");
}

/// LA-6. Voron 2.4's first layer (its own wider lines): T2.808 keeps its gap fill bead; T2.833 prints one bottom
/// path 1.552 mm from each side; from T2.872 connectors 1.550 mm in, and from T2.961 lines 0.46324 mm apart,
/// 1.553 mm from the ends, 0.5062 mm wide.
#[test]
fn la6_voron_first_layer_lines_across_start_at_one_spacing() {
    let p = measure("voron-2.4-300--n4-cl-sp0-ac-ff");
    gap_only(layer(&p.first, "T2.808"), "Bottom surface", 25.0, "first T2.808");
    one_path_down_the_middle(layer(&p.first, "T2.833"), 1.552, 0.005, "first T2.833");
    for name in p.names("T2.872", "T3.140") {
        let r = layer(&p.first, &name);
        connectors(r, 1.550, 0.005, &format!("first {name}"));
    }
    for name in p.names("T2.961", "T3.140") {
        let r = layer(&p.first, &name);
        let what = format!("first {name}");
        assert_eq!(r.across.len(), 61, "{what}: {r:?}");
        near(r.pitch.unwrap(), 0.463_24, 0.0005, &format!("{what} pitch"));
        near(r.mx.0, 1.553, 0.002, &format!("{what} mx0"));
        near(r.mx.1, 1.553, 0.002, &format!("{what} mx1"));
        assert!(
            r.widths.iter().all(|w| (w - 0.5062).abs() <= 0.001),
            "{what}: {r:?}"
        );
    }
}

/// LA-7. Variable-width walls at overlap 0 with a top line wider than the inner wall: the walls would leave room for a
/// line from R = 0.68 s0, but T0.550 to T0.990 print walls only; from T1.020, 52 lines across 0.5644 mm apart.
#[test]
fn la7_a_wide_top_line_still_waits_for_one_spacing() {
    let p = measure("creality-ender-3-v3--n4-ar-sp15-ac-ov0-tw0.6");
    for name in p.names("T0.550", "T0.990") {
        walls_only(layer(&p.top, &name), &format!("top {name}"));
    }
    for name in p.names("T1.020", "T1.250") {
        let r = layer(&p.top, &name);
        let what = format!("top {name}");
        lines_across(r, 52, Some(0.5644), (1.058, 1.058), 0.002, 0.6073, &what);
        ends(r, 0.8035, &what);
    }
}

/// Each strip as one letter: `.` walls only, `g` gap fill only, a digit for that many surface lines along, `X` lines
/// across, `Z` lines across joined along the sides, `Y` and `y` the same with gap fill, `o` anything else.
fn codes(rows: &BTreeMap<String, Row>, strips: &[Strip], surface: &str) -> String {
    strips
        .iter()
        .map(|s| {
            let r = &rows[&s.name];
            let gap = r.len_of("Gap infill") > 0.05;
            let across: f64 = r.across.len() as f64 * r.len;
            if !r.across.is_empty() && across >= 0.05 && across >= 0.05 * r.along {
                match (r.along > 0.25 * across, gap) {
                    (false, false) => 'X',
                    (true, false) => 'Z',
                    (false, true) => 'Y',
                    (true, true) => 'y',
                }
            } else if r.along > 0.05 {
                let n = r.offsets.len().clamp(1, 9) as u8;
                if gap {
                    char::from(b'a' + n - 1)
                } else {
                    char::from(b'0' + n)
                }
            } else if gap {
                'g'
            } else if r
                .feat
                .iter()
                .any(|(f, l)| *l > 0.05 && !matches!(f.as_str(), "Outer wall" | "Inner wall") && f != surface)
            {
                'o'
            } else {
                '.'
            }
        })
        .collect()
}

/// The strips' codes on the top layer and on the first.
fn plate_codes(case: &str) -> (String, String) {
    let p = measure(case);
    (
        codes(&p.top, &p.strips, "Top surface"),
        codes(&p.first, &p.strips, "Bottom surface"),
    )
}

/// LA-G1 (guard). Lines along the strips start where they did: the fine sweep, the strips 2.5 s0 long, and variable
/// width walls at overlap 0 with a wide top line.
#[test]
fn la_g1_lines_along_are_unchanged() {
    let want = [
        (
            "creality-ender-3-v3--n4-cl-sp0-al-f",
            "ggggggggggggggggggg11111111111111111111111111111111",
            "ggggggggggggggggggg11111111111111111111111111111111",
        ),
        (
            "creality-ender-3-v3--n4-cl-sp0-al-k2.5f",
            "gggg111111111111111111111111111111111111111111",
            "gggg111111111111111111111111111111111111111111",
        ),
        (
            "creality-ender-3-v3--n4-ar-sp15-al-ov0-tw0.6",
            ".............................................11111111111111111111111111",
            "..............111111111111111111111111111111111111111111111111111111111",
        ),
    ];
    let got: Vec<(String, String)> = want.iter().map(|(case, _, _)| plate_codes(case)).collect();
    let want: Vec<(String, String)> = want
        .iter()
        .map(|(_, top, first)| ((*top).to_owned(), (*first).to_owned()))
        .collect();
    assert_eq!(got, want);
}

/// LA-G2 (guard). Sparse infill with fixed-width walls: strips keep their gap fill until about 2.1 s0, then print
/// lines across, as before.
#[test]
fn la_g2_sparse_infill_strips_are_unchanged() {
    let want = [
        (
            "creality-ender-3-v3--n4-cl-sp15-ac-f",
            "gggggggggggggggXXXXXXXXXXXXXXXX",
            "gggggggggggggggZZZZZZZZZZZZZZZZ",
        ),
        (
            "creality-ender-3-v3--n4-cl-sp15-ac-k3.5f",
            "ggggggggggXXXXXXXXXXXXXXXXXXXXX",
            "ggggggggggZZZZZZZZZZZZZZZZZZZZZ",
        ),
    ];
    let got: Vec<(String, String)> = want.iter().map(|(case, _, _)| plate_codes(case)).collect();
    let want: Vec<(String, String)> = want
        .iter()
        .map(|(_, top, first)| ((*top).to_owned(), (*first).to_owned()))
        .collect();
    assert_eq!(got, want);
}

/// LA-G3 (guard). Short strips wide enough for lines across: N = floor(RL/s0) lines over RL = L - 2 ins, s =
/// min(RL/N, 1.2 s0) apart, the first s/2 in; a strip a whole number n of spacings long prints n - 1 lines at RL/n
/// and leaves the last out.
#[test]
fn la_g3_the_spread_along_short_strips_is_unchanged() {
    let p = measure("creality-ender-3-v3--n4-cl-sp0-ac-ksw");
    for s in &p.strips {
        let Some(k) = s.k else { continue };
        let rl = k * ENDER_S0;
        let (n, pitch) = if (k - k.round()).abs() < 1e-9 {
            (k as usize - 1, rl / k)
        } else {
            let n = k.floor();
            (n as usize, (rl / n).min(1.2 * ENDER_S0))
        };
        let r = layer(&p.top, &s.name);
        let what = format!("top {}", s.name);
        assert_eq!(r.across.len(), n, "{what}: {r:?}");
        // Two or three lines on the G-code's 0.001 mm grid read their pitch to within 0.001 mm.
        near(r.pitch.unwrap(), pitch, 0.001, &format!("{what} pitch"));
        near(r.mx.0, ENDER_INS + pitch / 2.0, 0.002, &format!("{what} mx0"));
        assert!(r.len_of("Gap infill") < 0.05, "{what}: {r:?}");
    }
}

/// LA-G4 (guard). Variable-width walls at the stock overlap: lines across start at about 1.5 s0, as before.
#[test]
fn la_g4_variable_width_walls_at_the_stock_overlap_are_unchanged() {
    assert_eq!(
        plate_codes("creality-ender-3-v3--n4-ar-sp15-ac"),
        (
            "...........XXXXXXXXXXXXXXX".to_owned(),
            "...........ZZZZZZZZZZZZZZZ".to_owned()
        )
    );
}

/// LA-G5 (guard). Top and bottom patterns swapped: T1.130 to T3.000 print as before, the top's lines across joined
/// along the sides (monotonic) and the first layer's plain lines across 0.700 mm in from the long sides; T0.990 and
/// narrower keep their gap fill bead on both layers.
#[test]
fn la_g5_swapped_patterns_are_unchanged() {
    let p = measure("creality-ender-3-v3--n4-cl-sp0-ac-pswap");
    for s in &p.strips {
        let t: f64 = s.name.trim_start_matches('T').parse().unwrap();
        let (top, first) = (layer(&p.top, &s.name), layer(&p.first, &s.name));
        if t <= 0.990 {
            gap_only(top, "Top surface", 25.0, &format!("top {}", s.name));
            gap_only(first, "Bottom surface", 25.0, &format!("first {}", s.name));
        } else if t >= 1.130 {
            let what = &s.name;
            assert!(top.across.len() == 78 && top.along > 25.0, "top {what}: {top:?}");
            assert!(
                first.across.len() == 78 && first.along < 0.05,
                "first {what}: {first:?}"
            );
            ends(first, 0.700, &format!("first {what}"));
        }
    }
}
