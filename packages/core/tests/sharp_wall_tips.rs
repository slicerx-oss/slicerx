// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Classic walls at a sharp point: where a wall line keeps the point and where it is cut flat. A wall line keeps the
//! point (a miter) while the point reaches at most 3 times the line's distance from the outline past the outline's
//! vertex, so while the point's half angle a is at least asin(1/3), 19.47 degrees. The point then reaches distance /
//! sin(a) past the vertex. A sharper point is cut flat near the vertex. The switch does not move with line width,
//! notch depth, wall count, layer height, or outer against inner wall.
//!
//! Fixtures: blocks with V notches cut from one edge, and a block with wedges (spikes) standing on that edge, through
//! the full height. The depth below the notch's edge (or below the wedge's tip) of the nearest inner and outer wall
//! line on the feature's center line at z 1.0 tells a kept point from a cut one. The targets are measured values on
//! the stock P1S request (0.42 mm outer and 0.45 mm inner walls, 2 walls, 0.2 mm layers).
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use serde_json::{Value, json};
use std::fmt::Write as _;
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

const REQUEST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/surface-walls/p1s-x-mark.json"
);
/// How far apart the notches' center lines are.
const PITCH: f64 = 6.0;
/// How far apart the wedges' center lines are.
const WEDGE_PITCH: f64 = 9.0;
/// How tall a wedge stands on its block.
const WEDGE: f64 = 4.0;
/// A block's depth below its edge.
const BLOCK: f64 = 12.0;

/// A V notch: its half angle in degrees and its depth below the edge in mm.
#[derive(Clone, Copy, Debug)]
struct Notch {
    half: f64,
    depth: f64,
}

/// A block whose top edge lies at `edge`, from `x0`, with V notches cut from that edge (or, for `wedges`, wedges of
/// those half angles standing on it, `WEDGE` tall).
struct Block {
    x0: f64,
    edge: f64,
    notches: Vec<Notch>,
    wedges: bool,
}

impl Block {
    fn pitch(&self) -> f64 {
        if self.wedges { WEDGE_PITCH } else { PITCH }
    }

    /// The center line of feature `i`.
    fn cx(&self, i: usize) -> f64 {
        #[allow(clippy::cast_precision_loss, reason = "a few features")]
        let i = i as f64;
        self.pitch().mul_add(i + 0.5, self.x0)
    }

    /// Where the depth of feature `i` is measured from: the notch's edge, or the wedge's tip.
    fn top(&self) -> f64 {
        if self.wedges { self.edge + WEDGE } else { self.edge }
    }

    /// The block's outline, counterclockwise.
    fn outline(&self) -> Vec<(f64, f64)> {
        #[allow(clippy::cast_precision_loss, reason = "a few features")]
        let x1 = self.pitch().mul_add(self.notches.len() as f64, self.x0);
        let y0 = self.edge - BLOCK;
        let mut pts = vec![(self.x0, y0), (x1, y0), (x1, self.edge)];
        for (i, n) in self.notches.iter().enumerate().rev() {
            let c = self.cx(i);
            if self.wedges {
                let w = WEDGE * n.half.to_radians().tan();
                pts.push((c + w, self.edge));
                pts.push((c, self.edge + WEDGE));
                pts.push((c - w, self.edge));
            } else {
                let w = n.depth * n.half.to_radians().tan();
                pts.push((c + w, self.edge));
                pts.push((c, self.edge - n.depth));
                pts.push((c - w, self.edge));
            }
        }
        pts.push((self.x0, self.edge));
        pts
    }
}

const fn v(half: f64, depth: f64) -> Notch {
    Notch { half, depth }
}

/// Notches 2 mm deep from 16 to 40 degrees.
fn coarse(x0: f64, depth: f64) -> Block {
    Block {
        x0,
        edge: 40.0,
        notches: [16.0, 18.0, 20.0, 22.0, 24.0, 26.0, 28.0, 30.0, 34.0, 40.0]
            .map(|a| v(a, depth))
            .to_vec(),
        wedges: false,
    }
}

/// Notches 2 mm deep across the switch.
fn fine() -> Block {
    Block {
        x0: 40.0,
        edge: 70.0,
        notches: [18.5, 19.0, 19.3, 19.5, 19.7, 20.0, 20.5, 21.0]
            .map(|a| v(a, 2.0))
            .to_vec(),
        wedges: false,
    }
}

/// Notches 0.5 to 4 mm deep at one half angle.
fn depths(x0: f64, half: f64) -> Block {
    Block {
        x0,
        edge: 70.0,
        notches: [0.5, 1.0, 2.0, 3.0, 4.0].map(|d| v(half, d)).to_vec(),
        wedges: false,
    }
}

/// Wedges from 10 to 40 degrees.
fn wedges() -> Block {
    Block {
        x0: 40.0,
        edge: 100.0,
        notches: [10.0, 14.0, 16.0, 18.0, 19.0, 20.0, 22.0, 26.0, 30.0, 34.0, 40.0]
            .map(|a| v(a, WEDGE))
            .to_vec(),
        wedges: true,
    }
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

/// The facets of `pts` extruded from z 0 to z 3.
fn prism(stl: &mut String, pts: &[(f64, f64)]) {
    prism_between(stl, pts, 0.0, 3.0);
}

/// The facets of `pts` extruded from `z0` to `z1`.
fn prism_between(stl: &mut String, pts: &[(f64, f64)], z0: f64, z1: f64) {
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

/// The G-code of the stock P1S request with `edits` to its config, its one object printing `blocks` where they lie.
fn slice(blocks: &[&Block], edits: &[(&str, Value)]) -> String {
    let mut stl = String::from("solid tips\n");
    for b in blocks {
        prism(&mut stl, &b.outline());
    }
    stl.push_str("endsolid tips\n");
    let mesh = Arc::new(Mesh::load(stl.as_bytes(), "tips.stl").unwrap());
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!("classic");
    req["config"]["precise_outer_wall"] = json!(false);
    // The P1S's second nozzle offset would move every G-code y by 2 mm.
    req["config"]["extruder_offset"] = json!([[0, 0]]);
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

/// One extruding move, an arc's chord or a line: its layer z (mm), feature and ends.
struct Move {
    z: f64,
    feature: String,
    from: (f64, f64),
    to: (f64, f64),
}

/// The arc from `from` to `to` around `center` (counterclockwise when `ccw`), in chords of about 0.05 mm.
fn chords(from: (f64, f64), to: (f64, f64), center: (f64, f64), ccw: bool) -> Vec<((f64, f64), (f64, f64))> {
    let radius = (from.0 - center.0).hypot(from.1 - center.1);
    let start = (from.1 - center.1).atan2(from.0 - center.0);
    let mut end = (to.1 - center.1).atan2(to.0 - center.0);
    while ccw && end <= start {
        end += std::f64::consts::TAU;
    }
    while !ccw && end >= start {
        end -= std::f64::consts::TAU;
    }
    let steps = ((end - start).abs() * radius / 0.05).ceil().max(1.0) as u32;
    let mut out = Vec::new();
    let mut last = from;
    for i in 1..=steps {
        let next = if i == steps {
            to
        } else {
            let t = (end - start).mul_add(f64::from(i) / f64::from(steps), start);
            (
                radius.mul_add(t.cos(), center.0),
                radius.mul_add(t.sin(), center.1),
            )
        };
        out.push((last, next));
        last = next;
    }
    out
}

fn moves(gcode: &str) -> Vec<Move> {
    let (mut x, mut y, mut layer_z) = (0.0, 0.0, 0.0);
    let mut feature = String::new();
    let mut out = Vec::new();
    for line in gcode.lines() {
        let s = line.trim();
        if let Some(f) = comment(s, &["TYPE", "FEATURE"]) {
            f.clone_into(&mut feature);
            continue;
        }
        if let Some(h) = comment(s, &["Z_HEIGHT", "Z"]).and_then(|v| v.parse::<f64>().ok()) {
            layer_z = h;
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|c| code.starts_with(c)) {
            continue;
        }
        let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
        if word(code, 'E').is_some_and(|e| e > 0.0) && (nx != x || ny != y) {
            let center = (word(code, 'I'), word(code, 'J'));
            let arc = code.starts_with("G2 ") || code.starts_with("G3 ");
            let pieces = if arc && (center.0.is_some() || center.1.is_some()) {
                let c = (x + center.0.unwrap_or(0.0), y + center.1.unwrap_or(0.0));
                chords((x, y), (nx, ny), c, code.starts_with("G3 "))
            } else {
                vec![((x, y), (nx, ny))]
            };
            for (from, to) in pieces {
                out.push(Move {
                    z: layer_z,
                    feature: feature.clone(),
                    from,
                    to,
                });
            }
        }
        (x, y) = (nx, ny);
    }
    out
}

/// The sliced layers of one fixture.
struct Sliced(Vec<Move>);

impl Sliced {
    /// The first layer at or above `z`.
    fn layer(&self, z: f64) -> f64 {
        self.0
            .iter()
            .map(|m| m.z)
            .filter(|&l| l >= z - 1e-6)
            .reduce(f64::min)
            .expect("a layer at or above z")
    }

    /// How far below `top` the walls of `feature` cross the line x = `cx` on the first layer at or above `z`, nearest
    /// first, within 8 mm below `top`.
    fn depths(&self, z: f64, feature: &str, cx: f64, top: f64) -> Vec<f64> {
        let z = self.layer(z);
        let mut d: Vec<f64> = self
            .0
            .iter()
            .filter(|m| m.z == z && m.feature == feature && m.from.0 != m.to.0)
            .filter(|m| (m.from.0 - cx) * (m.to.0 - cx) <= 0.0)
            .map(|m| top - (cx - m.from.0).mul_add((m.to.1 - m.from.1) / (m.to.0 - m.from.0), m.from.1))
            .filter(|d| (-0.5..8.0).contains(d))
            .collect();
        d.sort_by(f64::total_cmp);
        // Both lines that meet at a point on the center line cross it there.
        d.dedup_by(|a, b| (*a - *b).abs() < 0.005);
        d
    }
}

/// One expectation: feature `i` of a block, which wall (`k` counts inner walls from the outside), the target depth,
/// and whether the point is kept (checked within 0.02 mm) or cut (within 0.04).
struct Row {
    block: usize,
    i: usize,
    wall: &'static str,
    k: usize,
    want: f64,
    kept: bool,
}

/// Rows for one block: `targets` holds (inner, outer) per feature. A point of 19.47 degrees or more is kept.
fn rows(block: usize, b: &Block, targets: &[(f64, f64)]) -> Vec<Row> {
    let mut out = Vec::new();
    for (i, (&(inner, outer), n)) in targets.iter().zip(&b.notches).enumerate() {
        let kept = n.half >= 19.47;
        out.push(Row {
            block,
            i,
            wall: "Inner wall",
            k: 0,
            want: inner,
            kept,
        });
        out.push(Row {
            block,
            i,
            wall: "Outer wall",
            k: 0,
            want: outer,
            kept,
        });
    }
    out
}

/// Slices `blocks` with `edits`, measures every row at layer `z` and lists the misses.
fn check(name: &str, blocks: &[&Block], rows: &[Row], z: f64, edits: &[(&str, Value)]) {
    check_within(name, blocks, rows, z, edits, 0.0);
}

/// [`check`], with every row's tolerance widened by `extra` mm.
fn check_within(name: &str, blocks: &[&Block], rows: &[Row], z: f64, edits: &[(&str, Value)], extra: f64) {
    let sliced = Sliced(moves(&slice(blocks, edits)));
    let misses: Vec<String> = rows
        .iter()
        .filter_map(|r| {
            let block = blocks[r.block];
            let notch = block.notches[r.i];
            let got = sliced
                .depths(z, r.wall, block.cx(r.i), block.top())
                .get(r.k)
                .copied();
            let tol = if r.kept { 0.02 } else { 0.04 } + extra;
            match got {
                Some(g) if (g - r.want).abs() <= tol + 1e-9 => None,
                _ => Some(format!(
                    "{} {} of a {:.1} degree {} {:.1} mm: want {:.2} ({}), got {}",
                    r.wall,
                    r.k + 1,
                    notch.half,
                    if block.wedges { "wedge" } else { "notch" },
                    notch.depth,
                    r.want,
                    if r.kept { "kept" } else { "cut" },
                    got.map_or_else(|| "none".to_owned(), |g| format!("{g:.3}")),
                )),
            }
        })
        .collect();
    assert!(misses.is_empty(), "{name}:\n  {}", misses.join("\n  "));
}

#[test]
fn notch_points_from_16_to_40_degrees() {
    // Cut at 16 and 18 degrees, kept from 20, at both depths: the inner wall reaches 0.60 / sin a past the notch's
    // tip and the outer wall 0.21 / sin a.
    let (two, one) = (coarse(40.0, 2.0), coarse(110.0, 1.0));
    let t2 = [
        (2.47, 2.08),
        (2.49, 2.10),
        (3.76, 2.61),
        (3.61, 2.56),
        (3.48, 2.52),
        (3.37, 2.48),
        (3.28, 2.45),
        (3.20, 2.42),
        (3.08, 2.38),
        (2.94, 2.33),
    ];
    let t1: Vec<(f64, f64)> = t2.iter().map(|&(i, o)| (i - 1.0, o - 1.0)).collect();
    let mut all = rows(0, &two, &t2);
    all.extend(rows(1, &one, &t1));
    check("stock notches", &[&two, &one], &all, 1.0, &[]);
}

#[test]
fn notch_points_switch_between_19_3_and_19_5_degrees() {
    let (f, d21, d19) = (fine(), depths(100.0, 21.0), depths(140.0, 19.0));
    let tf = [
        (2.50, 2.10),
        (2.50, 2.11),
        (2.50, 2.11),
        (3.80, 2.63),
        (3.79, 2.62),
        (3.76, 2.61),
        (3.72, 2.60),
        (3.68, 2.59),
    ];
    // Every depth: the kept point reaches 1.68 past the notch's tip at 21 degrees, the cut one 0.50 at 19.
    let t21 = [0.5, 1.0, 2.0, 3.0, 4.0].map(|d| (d + 1.68, d + 0.59));
    let t19 = [0.5, 1.0, 2.0, 3.0, 4.0].map(|d| (d + 0.50, d + 0.11));
    let mut all = rows(0, &f, &tf);
    all.extend(rows(1, &d21, &t21));
    all.extend(rows(2, &d19, &t19));
    check("stock fine and depth sweeps", &[&f, &d21, &d19], &all, 1.0, &[]);
}

/// The fine sweep with `edits`: 18.5, 19.0 and 19.3 degrees cut, 19.5 to 21 kept.
fn fine_variant(name: &str, edits: &[(&str, Value)], z: f64, targets: &[(f64, f64); 8]) {
    let f = fine();
    check(name, &[&f], &rows(0, &f, targets), z, edits);
}

#[test]
fn the_switch_does_not_move_with_the_inner_wall_width() {
    fine_variant(
        "inner wall 0.40",
        &[("inner_wall_line_width", json!("0.40"))],
        1.0,
        &[
            (2.47, 2.10),
            (2.48, 2.11),
            (2.48, 2.11),
            (3.73, 2.63),
            (3.71, 2.62),
            (3.69, 2.61),
            (3.65, 2.60),
            (3.61, 2.59),
        ],
    );
    fine_variant(
        "inner wall 0.60",
        &[("inner_wall_line_width", json!("0.60"))],
        1.0,
        &[
            (2.57, 2.10),
            (2.58, 2.11),
            (2.58, 2.11),
            (4.03, 2.63),
            (4.01, 2.62),
            (3.98, 2.61),
            (3.93, 2.60),
            (3.89, 2.59),
        ],
    );
}

#[test]
fn the_switch_does_not_move_with_the_outer_wall_width() {
    fine_variant(
        "outer wall 0.35",
        &[("outer_wall_line_width", json!("0.35"))],
        1.0,
        &[
            (2.43, 2.07),
            (2.43, 2.07),
            (2.43, 2.08),
            (3.59, 2.52),
            (3.58, 2.52),
            (3.56, 2.51),
            (3.52, 2.50),
            (3.48, 2.49),
        ],
    );
    fine_variant(
        "outer wall 0.60",
        &[("outer_wall_line_width", json!("0.60"))],
        1.0,
        &[
            (2.68, 2.20),
            (2.68, 2.20),
            (2.68, 2.20),
            (4.34, 2.90),
            (4.32, 2.89),
            (4.29, 2.88),
            (4.23, 2.86),
            (4.18, 2.84),
        ],
    );
}

#[test]
fn the_switch_does_not_move_with_the_layer_height() {
    fine_variant(
        "layer height 0.1",
        &[("layer_height", json!(0.1))],
        1.0,
        &[
            (2.52, 2.10),
            (2.52, 2.11),
            (2.52, 2.11),
            (3.87, 2.63),
            (3.85, 2.62),
            (3.82, 2.61),
            (3.78, 2.60),
            (3.74, 2.59),
        ],
    );
    fine_variant(
        "layer height 0.3",
        &[("layer_height", json!(0.3))],
        1.1,
        &[
            (2.48, 2.10),
            (2.48, 2.11),
            (2.48, 2.11),
            (3.74, 2.63),
            (3.72, 2.62),
            (3.70, 2.61),
            (3.66, 2.60),
            (3.62, 2.59),
        ],
    );
}

#[test]
fn aegis_walls_switch_at_the_same_angle() {
    // Aegis caps the kept point: the inner wall reaches 0.62 to 0.64 past the notch's tip at every kept angle and the
    // outer wall 0.22 to 0.24, so these rows are checked 0.01 wider.
    let (two, f) = (coarse(40.0, 2.0), fine());
    let mut all = rows(
        0,
        &two,
        &[
            (2.47, 2.07),
            (2.48, 2.09),
            (2.63, 2.23),
            (2.62, 2.23),
            (2.62, 2.23),
            (2.62, 2.22),
            (2.62, 2.22),
            (2.61, 2.22),
            (2.61, 2.22),
            (2.61, 2.22),
        ],
    );
    all.extend(rows(
        1,
        &f,
        &[
            (2.48, 2.09),
            (2.49, 2.10),
            (2.49, 2.10),
            (2.63, 2.23),
            (2.63, 2.24),
            (2.63, 2.23),
            (2.63, 2.23),
            (2.64, 2.23),
        ],
    ));
    check_within(
        "aegis notches",
        &[&two, &f],
        &all,
        1.0,
        &[("wall_generator", json!("aegis"))],
        0.01,
    );
}

#[test]
fn the_switch_holds_for_the_second_inner_wall() {
    let f = fine();
    let mut all = rows(
        0,
        &f,
        &[
            (2.50, 2.10),
            (2.50, 2.11),
            (2.50, 2.11),
            (3.80, 2.63),
            (3.79, 2.62),
            (3.76, 2.61),
            (3.72, 2.60),
            (3.68, 2.59),
        ],
    );
    // The second inner wall reaches 1.01 / sin a past the notch's tip when kept.
    for (i, want, kept) in [(2, 2.90, false), (3, 5.02, true), (5, 4.95, true)] {
        all.push(Row {
            block: 0,
            i,
            wall: "Inner wall",
            k: 1,
            want,
            kept,
        });
    }
    check("3 walls", &[&f], &all, 1.0, &[("wall_loops", json!(3))]);
}

#[test]
fn wedge_inner_walls_keep_their_point_down_to_19_5_degrees() {
    // The inner wall's point, grown back as the loop chain opens it, follows the same switch: kept at 20 degrees and
    // over, cut at 19 and under. The outer wall reaches 0.21 / sin a below the tip at every angle.
    let w = wedges();
    let stock = [
        (4.05, 1.21),
        (2.87, 0.87),
        (2.51, 0.76),
        (2.22, 0.68),
        (2.10, 0.65),
        (1.76, 0.61),
        (1.61, 0.56),
        (1.37, 0.48),
        (1.20, 0.42),
        (1.08, 0.38),
        (0.94, 0.33),
    ];
    check("stock wedges", &[&w], &rows(0, &w, &stock), 1.0, &[]);
}

#[test]
fn wedge_points_follow_the_wall_widths_and_layer_height() {
    let w = wedges();
    let iw60 = [
        (4.68, 1.21),
        (3.32, 0.87),
        (2.90, 0.76),
        (2.56, 0.68),
        (2.43, 0.65),
        (1.98, 0.61),
        (1.81, 0.56),
        (1.55, 0.48),
        (1.35, 0.42),
        (1.21, 0.38),
        (1.05, 0.33),
    ];
    check(
        "wedges, inner wall 0.60",
        &[&w],
        &rows(0, &w, &iw60),
        1.0,
        &[("inner_wall_line_width", json!("0.60"))],
    );
    let ow60 = [
        (4.78, 1.73),
        (3.62, 1.24),
        (3.16, 1.09),
        (2.80, 0.97),
        (2.66, 0.92),
        (2.29, 0.88),
        (2.09, 0.80),
        (1.78, 0.68),
        (1.56, 0.60),
        (1.40, 0.54),
        (1.22, 0.47),
    ];
    check(
        "wedges, outer wall 0.60",
        &[&w],
        &rows(0, &w, &ow60),
        1.0,
        &[("outer_wall_line_width", json!("0.60"))],
    );
    let lh30 = [
        (3.89, 1.21),
        (2.76, 0.87),
        (2.41, 0.76),
        (2.14, 0.68),
        (2.02, 0.65),
        (1.70, 0.61),
        (1.55, 0.56),
        (1.32, 0.48),
        (1.16, 0.42),
        (1.04, 0.38),
        (0.90, 0.33),
    ];
    check(
        "wedges, layer height 0.3",
        &[&w],
        &rows(0, &w, &lh30),
        1.1,
        &[("layer_height", json!(0.3))],
    );
}

#[test]
fn aegis_wedges_keep_their_points() {
    let w = wedges();
    let aegis = [
        (3.47, 1.21),
        (2.49, 0.87),
        (2.18, 0.76),
        (1.95, 0.68),
        (1.85, 0.65),
        (1.76, 0.61),
        (1.61, 0.56),
        (1.37, 0.48),
        (1.20, 0.42),
        (1.08, 0.38),
        (0.94, 0.33),
    ];
    check(
        "aegis wedges",
        &[&w],
        &rows(0, &w, &aegis),
        1.0,
        &[("wall_generator", json!("aegis"))],
    );
}

/// FNV-1a 64 of `text`.
fn fnv(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The G-code move lines of the support and support interface, sorted, each with its feature.
fn support_moves(gcode: &str) -> String {
    let mut feature = String::new();
    let mut lines: Vec<String> = Vec::new();
    for line in gcode.lines() {
        let s = line.trim();
        if let Some(f) = comment(s, &["TYPE", "FEATURE"]) {
            f.clone_into(&mut feature);
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        let moves = ["G1 ", "G2 ", "G3 "].iter().any(|c| code.starts_with(c));
        if moves && feature.starts_with("Support") {
            lines.push(format!("{feature}|{code}"));
        }
    }
    lines.sort();
    lines.join("\n")
}

#[test]
fn support_under_a_sharp_slab_keeps_its_beveled_corners() {
    // A triangular slab with two 40 degree points (turns of 140 degrees) on a square post, held by normal support:
    // the support area's offsets bevel those corners as before, so its paths are the same. The hash is the support
    // sliced with every offset beveled from 120 degrees.
    let mut stl = String::from("solid slab\n");
    prism_between(
        &mut stl,
        &[(98.0, 98.0), (102.0, 98.0), (102.0, 102.0), (98.0, 102.0)],
        0.0,
        6.0,
    );
    let half = 20.0f64.to_radians();
    let (base, tall) = (16.0, 16.0 / (2.0 * half.tan()));
    let slab = [
        (100.0 - base / 2.0, 100.0 - tall / 2.0),
        (100.0 + base / 2.0, 100.0 - tall / 2.0),
        (100.0, 100.0 + tall / 2.0),
    ];
    prism_between(&mut stl, &slab, 6.0, 7.0);
    stl.push_str("endsolid slab\n");
    let mesh = Arc::new(Mesh::load(stl.as_bytes(), "slab.stl").unwrap());
    let mut req: Value = serde_json::from_slice(&std::fs::read(REQUEST).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!("classic");
    req["config"]["extruder_offset"] = json!([[0, 0]]);
    req["config"]["enable_support"] = json!(true);
    req["config"]["support_type"] = json!("normal(auto)");
    req["plate"]["objects"][0]["transform"] = json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    let moves = support_moves(&String::from_utf8(run.gcode).unwrap());
    assert!(
        moves.lines().count() > 200,
        "{} support moves",
        moves.lines().count()
    );
    assert_eq!(fnv(&moves), "46274c4b25dc944c", "support moves changed");
}
