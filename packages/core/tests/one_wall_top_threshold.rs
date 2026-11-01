// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! One wall on top surfaces with classic walls: which pieces of a step get the one-wall top band. The step is the
//! part of a layer the layer above leaves uncovered. A piece of it gets a band only where some point lies more than
//! half the outer wall's width inside the layer's outline and more than half of T from the layer above, where T is
//! `top_area_threshold` (200 percent by default) of the larger of the inner wall's width and the outer wall's
//! spacing. A piece that fails keeps the usual walls, and its top surface fills inside them.
//!
//! On the stock P1S request (0.42 mm outer and 0.45 mm inner walls, 0.2 mm layers) T is 0.90 mm, so a slot cut from
//! an edge gets a band once it is over 0.90 mm wide and over 0.66 mm long. A straight ledge along an edge keeps its
//! 0.66 mm threshold.
//!
//! Fixtures: a 2 mm block under a 1 mm block, with slots cut into the upper block from one edge (and in one fixture a
//! notch in the lower block under each slot). The inner wall's depth below that edge on a slot's center line at
//! z 2.0, against z 1.8, tells a band (0.2 mm deeper or more) from none. The targets are measured values.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use serde_json::{Value, json};
use std::fmt::Write as _;
use std::sync::{Arc, OnceLock};
use sx_core::api::{self, Mesh, SliceRequest};

const REQUEST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/surface-walls/p1s-x-mark.json"
);
/// The edge the slots are cut from, world y in mm. The blocks lie below it.
const EDGE: f64 = 140.0;
/// How far apart the slots' center lines are.
const PITCH: f64 = 6.0;

/// A notch cut from the edge: `top` wide at the edge, `bottom` wide at its far end, `depth` deep. A slot has
/// `top == bottom`.
#[derive(Clone, Copy, Debug)]
struct Notch {
    top: f64,
    bottom: f64,
    depth: f64,
}

const fn slot(w: f64, l: f64) -> Notch {
    Notch {
        top: w,
        bottom: w,
        depth: l,
    }
}

/// One feature: a notch in the upper block, and optionally one in the lower block under it.
#[derive(Clone, Copy, Debug)]
struct Feature {
    upper: Notch,
    lower: Option<Notch>,
}

const fn upper(n: Notch) -> Feature {
    Feature {
        upper: n,
        lower: None,
    }
}

fn cx(i: usize) -> f64 {
    #[allow(clippy::cast_precision_loss, reason = "a few features")]
    let i = i as f64;
    PITCH.mul_add(i, 80.0)
}

/// The outline of a block from `x0` to `x1` and 8 mm below the edge, with `notches` cut from the edge at the
/// features' center lines, counterclockwise.
fn outline(x0: f64, x1: f64, notches: &[(f64, Notch)]) -> Vec<(f64, f64)> {
    let mut pts = vec![(x0, EDGE - 8.0), (x1, EDGE - 8.0), (x1, EDGE)];
    for &(c, n) in notches.iter().rev() {
        pts.push((c + n.top / 2.0, EDGE));
        pts.push((c + n.bottom / 2.0, EDGE - n.depth));
        pts.push((c - n.bottom / 2.0, EDGE - n.depth));
        pts.push((c - n.top / 2.0, EDGE));
    }
    pts.push((x0, EDGE));
    pts
}

/// Triangles covering the counterclockwise simple polygon `pts`, by ear clipping.
fn triangulate(pts: &[(f64, f64)]) -> Vec<[usize; 3]> {
    let cross = |o: (f64, f64), a: (f64, f64), b: (f64, f64)| {
        (a.0 - o.0).mul_add(b.1 - o.1, -((a.1 - o.1) * (b.0 - o.0)))
    };
    let mut idx: Vec<usize> = (0..pts.len()).collect();
    let mut out = Vec::new();
    while idx.len() > 3 {
        let n = idx.len();
        let ear = (0..n).find(|&i| {
            let (a, b, c) = (idx[(i + n - 1) % n], idx[i], idx[(i + 1) % n]);
            if cross(pts[a], pts[b], pts[c]) <= 1e-12 {
                return false;
            }
            idx.iter().all(|&p| {
                p == a
                    || p == b
                    || p == c
                    || !(cross(pts[a], pts[b], pts[p]) >= 0.0
                        && cross(pts[b], pts[c], pts[p]) >= 0.0
                        && cross(pts[c], pts[a], pts[p]) >= 0.0)
            })
        });
        let i = ear.expect("a simple polygon has an ear");
        out.push([idx[(i + n - 1) % n], idx[i], idx[(i + 1) % n]]);
        idx.remove(i);
    }
    out.push([idx[0], idx[1], idx[2]]);
    out
}

/// The facets of `pts` extruded from `z0` to `z1`.
fn prism(stl: &mut String, pts: &[(f64, f64)], z0: f64, z1: f64) {
    let mut facet = |p: [(f64, f64, f64); 3]| {
        let _ = writeln!(stl, "facet normal 0 0 0\n outer loop");
        for v in p {
            let _ = writeln!(stl, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(stl, " endloop\nendfacet");
    };
    for [a, b, c] in triangulate(pts) {
        let (a, b, c) = (pts[a], pts[b], pts[c]);
        facet([(a.0, a.1, z0), (c.0, c.1, z0), (b.0, b.1, z0)]);
        facet([(a.0, a.1, z1), (b.0, b.1, z1), (c.0, c.1, z1)]);
    }
    for i in 0..pts.len() {
        let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
        facet([(a.0, a.1, z0), (b.0, b.1, z0), (b.0, b.1, z1)]);
        facet([(a.0, a.1, z0), (b.0, b.1, z1), (a.0, a.1, z1)]);
    }
}

/// A 2 mm block under a 1 mm block, the features' notches cut from the edge on center lines [`PITCH`] apart.
fn fixture(features: &[Feature]) -> Arc<Mesh> {
    let (x0, x1) = (cx(0) - PITCH / 2.0, cx(features.len() - 1) + PITCH / 2.0);
    let lower: Vec<(f64, Notch)> = features
        .iter()
        .enumerate()
        .filter_map(|(i, f)| f.lower.map(|n| (cx(i), n)))
        .collect();
    let upper: Vec<(f64, Notch)> = features
        .iter()
        .enumerate()
        .map(|(i, f)| (cx(i), f.upper))
        .collect();
    let mut stl = String::from("solid steps\n");
    prism(&mut stl, &outline(x0, x1, &lower), 0.0, 2.0);
    prism(&mut stl, &outline(x0, x1, &upper), 2.0, 3.0);
    stl.push_str("endsolid steps\n");
    Arc::new(Mesh::load(stl.as_bytes(), "steps.stl").unwrap())
}

/// The G-code of the stock P1S request (classic walls) with `edits` to its config, its one object printing `mesh`
/// where the mesh lies.
fn slice_with(mesh: Arc<Mesh>, edits: &[(&str, Value)]) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!("classic");
    req["plate"]["objects"][0]["transform"] = json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    for (k, v) in edits {
        req["config"][*k] = v.clone();
    }
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// A number after `key` in a G-code move.
fn word(code: &str, key: char) -> Option<f64> {
    code.split_whitespace()
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse::<f64>().ok()))
}

/// A feature or layer comment's value: `; FEATURE: x` or `;TYPE:x`, and so on.
fn comment<'a>(s: &'a str, keys: &[&str]) -> Option<&'a str> {
    let body = s.strip_prefix(';')?.trim_start();
    keys.iter()
        .find_map(|k| body.strip_prefix(k).and_then(|r| r.strip_prefix(':')))
        .map(str::trim)
}

/// One extruding move: its layer z (thousandths of a millimeter), feature, the feature printed before this run of
/// it on the layer, and ends.
struct Move {
    z: i64,
    feature: String,
    before: String,
    from: (f64, f64),
    to: (f64, f64),
}

impl Move {
    fn len(&self) -> f64 {
        (self.to.0 - self.from.0).hypot(self.to.1 - self.from.1)
    }
}

fn moves(gcode: &str) -> Vec<Move> {
    let (mut x, mut y, mut layer_z) = (0.0, 0.0, 0);
    let (mut feature, mut before) = (String::new(), String::new());
    let mut out = Vec::new();
    for line in gcode.lines() {
        let s = line.trim();
        if let Some(f) = comment(s, &["TYPE", "FEATURE"]) {
            if f != feature {
                before = std::mem::replace(&mut feature, f.to_owned());
            }
            continue;
        }
        if let Some(h) = comment(s, &["Z_HEIGHT", "Z"]).and_then(|v| v.parse::<f64>().ok()) {
            layer_z = (h * 1000.0).round() as i64;
            before.clear();
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|c| code.starts_with(c)) {
            continue;
        }
        let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
        if word(code, 'E').is_some_and(|e| e > 0.0) && (nx != x || ny != y) {
            out.push(Move {
                z: layer_z,
                feature: feature.clone(),
                before: before.clone(),
                from: (x, y),
                to: (nx, ny),
            });
        }
        (x, y) = (nx, ny);
    }
    out
}

/// The highest y at which an inner wall crosses the line x = `cx` on layer `z`, between `lo` and `hi` (mm).
fn crossing(ms: &[Move], z: f64, cx: f64, lo: f64, hi: f64) -> Option<f64> {
    let z = (z * 1000.0).round() as i64;
    ms.iter()
        .filter(|m| m.z == z && m.feature == "Inner wall" && m.from.0 != m.to.0)
        .filter(|m| (m.from.0 - cx) * (m.to.0 - cx) <= 0.0)
        .map(|m| (cx - m.from.0).mul_add((m.to.1 - m.from.1) / (m.to.0 - m.from.0), m.from.1))
        .filter(|y| lo < *y && *y < hi)
        .reduce(f64::max)
}

/// How far below the edge the nearest inner wall crossing the line x = `cx` lies on layer `z` (mm).
fn depth(ms: &[Move], z: f64, cx: f64) -> Option<f64> {
    crossing(ms, z, cx, EDGE - 8.0, EDGE + 0.5).map(|y| EDGE - y)
}

/// Each feature's (band, inner wall depth at z 2.0) on the fixture of `features` sliced with `edits`.
fn bands(features: &[Feature], edits: &[(&str, Value)]) -> Vec<(bool, f64)> {
    let ms = moves(&slice_with(fixture(features), edits));
    (0..features.len())
        .map(|i| {
            let top = depth(&ms, 2.0, cx(i)).expect("an inner wall on the slot's center line at z 2.0");
            let under = depth(&ms, 1.8, cx(i)).expect("an inner wall on the slot's center line at z 1.8");
            (top - under >= 0.2, top)
        })
        .collect()
}

/// Checks each feature against `want` (band or not) and lists every miss.
fn check(name: &str, rows: &[(Feature, bool)], edits: &[(&str, Value)]) {
    let features: Vec<Feature> = rows.iter().map(|r| r.0).collect();
    let got = bands(&features, edits);
    let misses: Vec<String> = rows
        .iter()
        .zip(&got)
        .filter(|((_, want), (band, _))| band != want)
        .map(|((f, want), (_, d))| {
            format!(
                "{:?} under {:?}: want {}, got {} (inner wall {d:.2} mm below the edge)",
                f.upper,
                f.lower,
                if *want { "a band" } else { "no band" },
                if *want { "none" } else { "a band" },
            )
        })
        .collect();
    assert!(misses.is_empty(), "{name}:\n  {}", misses.join("\n  "));
}

/// The stock rows: slots of each width at lengths 1.0 and 3.0, and slots 1.5 and 3.0 wide at lengths either side of
/// the length threshold.
fn stock() -> &'static [(Feature, bool)] {
    static ROWS: OnceLock<Vec<(Feature, bool)>> = OnceLock::new();
    ROWS.get_or_init(|| {
        let mut rows = Vec::new();
        for l in [1.0, 3.0] {
            for w in [0.7, 0.8, 0.86, 0.9, 0.92, 0.96, 1.0, 1.2, 3.0] {
                rows.push((upper(slot(w, l)), w > 0.91));
            }
        }
        for w in [1.5, 3.0] {
            rows.push((upper(slot(w, 0.65)), false));
            rows.push((upper(slot(w, 0.70)), true));
        }
        rows
    })
}

#[test]
fn stock_slots_up_to_0_90_mm_wide_get_no_band() {
    let rows: Vec<(Feature, bool)> = stock().iter().copied().filter(|r| !r.1).collect();
    check("stock, slots up to 0.90 mm wide or 0.65 mm long", &rows, &[]);
}

#[test]
fn stock_slots_from_0_92_mm_wide_and_0_70_mm_long_keep_their_band() {
    let rows: Vec<(Feature, bool)> = stock().iter().copied().filter(|r| r.1).collect();
    check("stock, slots from 0.92 mm wide and 0.70 mm long", &rows, &[]);
}

#[test]
fn the_threshold_follows_the_inner_wall_width() {
    // T is twice the inner wall's width: 1.20 mm at 0.60, and 0.80 at 0.40.
    let rows = [
        (upper(slot(1.20, 3.0)), false),
        (upper(slot(1.25, 3.0)), true),
        (upper(slot(3.0, 0.80)), false),
        (upper(slot(3.0, 0.85)), true),
    ];
    check(
        "inner wall 0.60",
        &rows,
        &[("inner_wall_line_width", json!("0.60"))],
    );
    let rows = [(upper(slot(0.80, 3.0)), false), (upper(slot(0.90, 3.0)), true)];
    check(
        "inner wall 0.40",
        &rows,
        &[("inner_wall_line_width", json!("0.40"))],
    );
}

#[test]
fn the_threshold_follows_the_outer_wall_spacing() {
    // A 0.60 mm outer wall's spacing on 0.2 mm layers is 0.557 mm, over the inner wall's 0.45: T is 1.114 mm, and
    // the length threshold half the outer wall plus half T, 0.857.
    let rows = [
        (upper(slot(1.10, 3.0)), false),
        (upper(slot(1.15, 3.0)), true),
        (upper(slot(3.0, 0.85)), false),
        (upper(slot(3.0, 0.90)), true),
    ];
    check(
        "outer wall 0.60",
        &rows,
        &[("outer_wall_line_width", json!("0.60"))],
    );
}

#[test]
fn top_area_threshold_sets_the_threshold() {
    // 400 percent: T is 1.80 mm, the length threshold 1.11.
    let rows = [
        (upper(slot(1.0, 2.0)), false),
        (upper(slot(1.5, 3.0)), false),
        (upper(slot(2.0, 3.0)), true),
        (upper(slot(3.0, 1.10)), false),
        (upper(slot(3.0, 1.15)), true),
    ];
    check(
        "top_area_threshold 400%",
        &rows,
        &[("top_area_threshold", json!("400%"))],
    );
    // The same as a width in mm.
    check(
        "top_area_threshold 1.8 mm",
        &rows,
        &[("top_area_threshold", json!(1.8))],
    );
    // 0 percent: every step deeper than half the outer wall.
    let rows = [
        (upper(slot(0.5, 0.5)), true),
        (upper(slot(0.6, 1.0)), true),
        (upper(slot(3.0, 0.5)), true),
    ];
    check(
        "top_area_threshold 0%",
        &rows,
        &[("top_area_threshold", json!("0%"))],
    );
}

#[test]
fn a_narrow_slot_over_a_notch_gets_no_band() {
    // A notch 1.6 mm wide at the edge and 0.85 at its far end, 0.9 mm deep, under a slot 1.7 mm wide at the edge
    // narrowing to `bottom`, `hs` deep.
    let xm = |bottom: f64, hs: f64| Feature {
        upper: Notch {
            top: 1.7,
            bottom,
            depth: hs,
        },
        lower: Some(Notch {
            top: 1.6,
            bottom: 0.85,
            depth: 0.9,
        }),
    };
    let rows = [
        (xm(0.60, 1.2), false),
        (xm(0.45, 1.6), false),
        (xm(0.60, 1.6), false),
        (xm(0.75, 1.6), true),
        (xm(0.30, 2.2), true),
        (xm(0.90, 2.2), true),
    ];
    check("x-mark-like notch", &rows, &[]);
}

/// The x-mark on the stock P1S request with classic walls.
fn x_mark_moves() -> &'static [Move] {
    static MOVES: OnceLock<Vec<Move>> = OnceLock::new();
    MOVES.get_or_init(|| {
        let stl = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/bench/models/x-mark.stl")).unwrap();
        let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
        req["config"]["wall_generator"] = json!("classic");
        let req: SliceRequest = serde_json::from_value(req).unwrap();
        let mesh = Arc::new(Mesh::load(&stl, "x-mark.stl").unwrap());
        let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
        moves(&String::from_utf8(run.gcode).unwrap())
    })
}

/// Gap fill after the top surface on layer `z` (mm of path), inside `x0..x1` by `y0..y1` when given.
fn top_gap_fill(ms: &[Move], z: f64, area: Option<(f64, f64, f64, f64)>) -> f64 {
    let z = (z * 1000.0).round() as i64;
    let inside = |p: (f64, f64)| {
        area.is_none_or(|(x0, x1, y0, y1)| (x0..=x1).contains(&p.0) && (y0..=y1).contains(&p.1))
    };
    ms.iter()
        .filter(|m| m.z == z && m.feature == "Gap infill" && m.before == "Top surface")
        .filter(|m| inside(m.from) && inside(m.to))
        .map(Move::len)
        .sum()
}

#[test]
fn x_mark_notch_at_z_59_keeps_its_inner_wall() {
    let ms = x_mark_moves();
    // The narrow piece the layer above leaves under the notch gets no band, so no strip of gap fill is left between
    // a band's inner wall and the notch's outer wall.
    let strip = top_gap_fill(ms, 59.0, Some((127.0, 129.3, 131.6, 132.7)));
    assert!(
        strip < 0.05,
        "gap fill under the notch at z 59.0: {strip:.2} mm, want none"
    );
    // The inner wall follows the notch one spacing inside its outer wall.
    // The notch's far end is at y 132.37; its inner wall, the nearest below that on its center line.
    let y = crossing(ms, 59.0, 128.2, 130.5, 132.37).expect("an inner wall under the notch");
    assert!(
        (y - 131.8).abs() <= 0.1,
        "inner wall under the notch at y {y:.2}, want 131.8"
    );
}

#[test]
fn x_mark_top_gap_fill_away_from_the_notch_at_z_59_stays() {
    // The two pieces of top surface gap fill away from the notch keep their gap fill: one at the bottom flank
    // (measured 1.76 mm) and one beside the layer above's slot (0.84 mm). The gap fill a band's inner wall used to
    // leave along the notch's flank goes with the band.
    let ms = x_mark_moves();
    for (area, want) in [
        ((126.5, 127.5, 119.8, 122.4), 1.70),
        ((128.9, 129.7, 129.9, 130.6), 0.80),
    ] {
        let got = top_gap_fill(ms, 59.0, Some(area));
        assert!(
            got >= want,
            "top surface gap fill at z 59.0 in {area:?}: {got:.2} mm, want at least {want}"
        );
    }
}
