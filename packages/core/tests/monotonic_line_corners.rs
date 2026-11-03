// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where a monotonic line top starts and which of its corners get a gap fill bead, on Bambu Lab printers. Checked on
//! the A1 with plates of 6 mm squares, each shifted a little against the line grid so their corners sample every
//! line phase (`sqf`, 40 squares, and `rsq0`, 12).
//!
//! - Each square's top starts on its lowest line across the lines (the line across the corner on the right looking
//!   along them) and prints it heading along the lines' direction (45 or 135 degrees).
//! - At a corner whose bisector runs along the lines, two lines end, one on each wall. From the corner of the line
//!   ends' boundary to the nearest line end on each wall are the legs, a the shorter and b the longer, and
//!   e = 0.707 w - a for line width w. When the two lines are not linked by the travel between them (a free corner)
//!   and e is 0.089 to 0.143 mm, the corner gets exactly one straight bead along the longer leg's wall, about a - 0.06
//!   mm wide. Linked corners, corners a line cuts and free corners with e up to 0.071 or from 0.146 get none.

#![allow(
    clippy::disallowed_methods,
    clippy::float_cmp,
    clippy::many_single_char_names,
    clippy::cast_precision_loss,
    reason = "a G-code reader for the test: plate coordinates and layer heights in mm"
)]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// The stock A1 as the app sets it up with uniform layers and the classic walls and plain outer wall its projects
/// carry, then `edits`.
fn a1(edits: &[(&str, Value)]) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let m = read("packages/profiles/resolved/bambu-lab.json")["models"]["bambu-a1"].clone();
    let base = m["base"].as_str().unwrap().to_owned();
    for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    out.insert("smart_layer".into(), json!("off"));
    out.insert("wall_generator".into(), json!("classic"));
    out.insert("precise_outer_wall".into(), json!(false));
    for (k, v) in edits {
        out.insert((*k).to_owned(), v.clone());
    }
    out
}

/// A plate of squares: the model and each square's outline in model coordinates, corners in the order lower left,
/// lower right, upper right, upper left.
struct Plate {
    stl: Vec<u8>,
    bounds: [f64; 4],
    squares: Vec<[(f64, f64); 4]>,
}

fn plate(name: &str) -> Plate {
    let dir = format!("{}/packages/core/tests/fixtures/gap-fill", root());
    let meta: Value =
        serde_json::from_slice(&std::fs::read(format!("{dir}/{name}.meta.json")).unwrap()).unwrap();
    let f = |v: &Value| v.as_f64().unwrap();
    let b = meta["box"].as_array().unwrap();
    Plate {
        stl: std::fs::read(format!("{dir}/{name}.stl")).unwrap(),
        bounds: [f(&b[0]), f(&b[1]), f(&b[2]), f(&b[3])],
        squares: meta["squares"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                let p = s.as_array().unwrap();
                let at = |i: usize| (f(&p[i][0]), f(&p[i][1]));
                [at(0), at(1), at(2), at(3)]
            })
            .collect(),
    }
}

/// The G-code of one part on the plate where the app puts it.
fn slice(model: &[u8], config: Map<String, Value>) -> String {
    let mesh = Arc::new(Mesh::load(model, "m.stl").unwrap());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "o1", "name": "part", "mesh": "m"}]},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

type P = (f64, f64);

/// One XY move: its feature, the feature before it, layer z, ends, whether it extrudes and its stated width.
#[derive(Clone)]
struct Move {
    feature: String,
    before: String,
    z: f64,
    from: P,
    to: P,
    extrudes: bool,
    width: f64,
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

fn moves(g: &str) -> Vec<Move> {
    let (mut x, mut y, mut z, mut w) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
    let (mut feature, mut before) = (String::new(), String::new());
    let mut out = Vec::new();
    for line in g.lines() {
        let s = line.trim();
        if let Some(f) = s.strip_prefix("; FEATURE:").or_else(|| s.strip_prefix(";TYPE:")) {
            let f = f.trim().to_owned();
            if f != feature {
                before = std::mem::replace(&mut feature, f);
            }
            continue;
        }
        if let Some(v) = s.strip_prefix("; Z_HEIGHT:").or_else(|| s.strip_prefix(";Z:")) {
            z = v.trim().parse().unwrap();
            continue;
        }
        if let Some(v) = s
            .strip_prefix("; LINE_WIDTH:")
            .or_else(|| s.strip_prefix(";WIDTH:"))
        {
            w = v.trim().parse().unwrap();
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|p| code.starts_with(p)) {
            continue;
        }
        let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
        if (nx, ny) != (x, y) {
            out.push(Move {
                feature: feature.clone(),
                before: before.clone(),
                z,
                from: (x, y),
                to: (nx, ny),
                extrudes: word(code, 'E').is_some_and(|e| e > 0.0),
                width: w,
            });
        }
        (x, y) = (nx, ny);
    }
    out
}

fn dist(a: P, b: P) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

/// The distance from `p` to the segment from `a` to `b`.
fn to_segment(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 == 0.0 {
        0.0
    } else {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0)
    };
    dist(p, (a.0 + t * dx, a.1 + t * dy))
}

/// A direction in degrees from 0 to 360.
fn heading(from: P, to: P) -> f64 {
    (to.1 - from.1)
        .atan2(to.0 - from.0)
        .to_degrees()
        .rem_euclid(360.0)
}

/// How far apart two directions are, degrees from 0 to 180.
fn apart(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(360.0);
    d.min(360.0 - d)
}

const TOP: &str = "Top surface";

/// One corner of a square's top as printed.
struct Corner {
    /// The corner's bisector runs along the lines (two lines end at it, one on each wall).
    run_in: bool,
    /// The legs along the bottom or top wall and along the left or right wall, mm.
    legs: [f64; 2],
    /// The two lines that end at it print one after the other, linked by the travel between their ends there.
    joined: bool,
    /// The corner of the line ends' boundary.
    at: P,
    /// The gap fill moves printed after the top within 0.2 mm of it.
    beads: Vec<Move>,
}

/// One square's top as printed: its first move, the lowest line's offset across the lines, and its corners.
struct Square {
    first: Move,
    lowest: f64,
    corners: Vec<Corner>,
}

/// The top layer of a plate of squares: the lines' direction (45 or 135 degrees) and each square.
struct Top {
    dir: f64,
    squares: Vec<Square>,
}

/// Offset across lines along `dir` degrees.
fn across(p: P, dir: f64) -> f64 {
    let r = dir.to_radians();
    -p.0 * r.sin() + p.1 * r.cos()
}

fn top(g: &str, plate: &Plate) -> Top {
    let all = moves(g);
    let zt = all
        .iter()
        .filter(|m| m.extrudes && m.feature == TOP)
        .map(|m| m.z)
        .fold(f64::MIN, f64::max);
    let layer: Vec<Move> = all.into_iter().filter(|m| m.z == zt).collect();
    // Where the model sits: the outer walls' middle against the model's.
    let walls: Vec<P> = layer
        .iter()
        .filter(|m| m.extrudes && m.feature == "Outer wall")
        .map(|m| m.to)
        .collect();
    let lo = walls
        .iter()
        .fold((f64::MAX, f64::MAX), |a, p| (a.0.min(p.0), a.1.min(p.1)));
    let hi = walls
        .iter()
        .fold((f64::MIN, f64::MIN), |a, p| (a.0.max(p.0), a.1.max(p.1)));
    let b = plate.bounds;
    let shift = (
        f64::midpoint(lo.0, hi.0) - f64::midpoint(b[0], b[2]),
        f64::midpoint(lo.1, hi.1) - f64::midpoint(b[1], b[3]),
    );
    // The lines' direction: the whole degree from 0 to 179 most top surface path runs along.
    let mut by = std::collections::BTreeMap::<i64, f64>::new();
    let lines: Vec<&Move> = layer
        .iter()
        .filter(|m| m.extrudes && m.feature == TOP && dist(m.from, m.to) > 0.05)
        .collect();
    for m in &lines {
        #[allow(clippy::cast_possible_truncation, reason = "a direction in whole degrees")]
        let a = heading(m.from, m.to).round() as i64 % 180;
        *by.entry(a).or_default() += dist(m.from, m.to);
    }
    #[allow(clippy::cast_precision_loss, reason = "a direction in whole degrees")]
    let dir = by.into_iter().max_by(|a, b| a.1.total_cmp(&b.1)).unwrap().0 as f64;
    let extrusions: Vec<&Move> = layer.iter().filter(|m| m.extrudes).collect();
    let squares = plate
        .squares
        .iter()
        .map(|sq| {
            let (x0, y0) = (sq[0].0 + shift.0, sq[0].1 + shift.1);
            let (x1, y1) = (sq[2].0 + shift.0, sq[2].1 + shift.1);
            let inside = |p: P| x0 - 0.05 < p.0 && p.0 < x1 + 0.05 && y0 - 0.05 < p.1 && p.1 < y1 + 0.05;
            let own: Vec<&&Move> = lines.iter().filter(|m| inside(m.from) && inside(m.to)).collect();
            let first = Move::clone(own.first().unwrap());
            let lowest = own.iter().map(|m| across(m.from, dir)).fold(f64::MAX, f64::min);
            let ends: Vec<P> = own.iter().flat_map(|m| [m.from, m.to]).collect();
            let mut insets: Vec<f64> = ends
                .iter()
                .map(|e| (e.0 - x0).min(x1 - e.0).min(e.1 - y0).min(y1 - e.1))
                .collect();
            insets.sort_by(f64::total_cmp);
            let inset = insets[insets.len() / 2];
            let (bx0, by0, bx1, by1) = (x0 + inset, y0 + inset, x1 - inset, y1 - inset);
            let corners = [(bx0, by0), (bx1, by0), (bx1, by1), (bx0, by1)]
                .iter()
                .enumerate()
                .map(|(ci, &c)| corner(ci, c, &ends, dir, &extrusions, &layer))
                .collect();
            Square {
                first,
                lowest,
                corners,
            }
        })
        .collect();
    Top { dir, squares }
}

/// Corner `ci` (lower left, lower right, upper right, upper left) of a square at `c`, the corner of its line ends'
/// boundary: `ends` are the square's top line ends, `dir` the lines' direction, `extrusions` the layer's extruding
/// moves in order and `layer` all its moves.
fn corner(ci: usize, c: P, ends: &[P], dir: f64, extrusions: &[&Move], layer: &[Move]) -> Corner {
    // The nearest line end on the bottom or top wall, and on the left or right wall.
    let along = |horizontal: bool| {
        ends.iter()
            .filter(|e| {
                if horizontal {
                    (e.1 - c.1).abs() < 0.03
                } else {
                    (e.0 - c.0).abs() < 0.03
                }
            })
            .min_by(|a, b| dist(**a, c).total_cmp(&dist(**b, c)))
            .copied()
    };
    let (eh, ev) = (along(true).unwrap(), along(false).unwrap());
    let bisector = if ci.is_multiple_of(2) { 45.0 } else { 135.0 };
    let run_in = apart(bisector, dir).min(apart(bisector + 180.0, dir)) < 10.0;
    // Strict join: a top line ends at one of the two ends and the next extrusion is the top line that
    // starts at the other, under 0.6 mm away.
    let joined = extrusions.windows(2).any(|w| {
        let (a, b) = (w[0], w[1]);
        a.feature == TOP
            && b.feature == TOP
            && dist(a.to, b.from) < 0.6
            && ((dist(a.to, eh) < 0.01 && dist(b.from, ev) < 0.01)
                || (dist(a.to, ev) < 0.01 && dist(b.from, eh) < 0.01))
    });
    let beads = layer
        .iter()
        .filter(|m| {
            m.extrudes && m.feature == "Gap infill" && m.before == TOP && to_segment(c, m.from, m.to) <= 0.2
        })
        .cloned()
        .collect();
    Corner {
        run_in,
        legs: [dist(eh, c), dist(ev, c)],
        joined,
        at: c,
        beads,
    }
}

/// The gap fill printed right after a surface, mm of path, on the whole plate.
fn surface_gap_mm(g: &str) -> f64 {
    moves(g)
        .iter()
        .filter(|m| {
            m.extrudes
                && m.feature == "Gap infill"
                && ["Top surface", "Internal solid infill", "Bottom surface"].contains(&m.before.as_str())
        })
        .map(|m| dist(m.from, m.to))
        .sum()
}

/// The stock top line width, mm.
const W: f64 = 0.42;

fn pocket(c: &Corner) -> f64 {
    std::f64::consts::FRAC_1_SQRT_2 * W - c.legs[0].min(c.legs[1])
}

/// Which corners get a bead by the rule, and what is wrong with the corners that break it.
fn rule(name: &str, t: &Top) -> (Vec<(usize, usize)>, Vec<String>) {
    let (mut beaded, mut errors) = (Vec::new(), Vec::new());
    for (k, sq) in t.squares.iter().enumerate() {
        for (ci, c) in sq.corners.iter().enumerate() {
            let e = pocket(c);
            let n = c.beads.len();
            let tag = format!(
                "{name} square {k} corner {ci} (e {e:.3}, legs {:.3} {:.3})",
                c.legs[0], c.legs[1]
            );
            if !c.run_in || c.joined || e <= 0.071 || e >= 0.146 {
                if n > 0 {
                    errors.push(format!("{tag}: {n} bead move(s), want none"));
                }
            } else if (0.089..=0.143).contains(&e) {
                if n == 1 {
                    beaded.push((k, ci));
                } else {
                    errors.push(format!("{tag}: {n} bead move(s), want one"));
                }
            } else if n > 0 {
                beaded.push((k, ci));
            }
        }
    }
    (beaded, errors)
}

#[test]
fn each_square_starts_on_its_lowest_line_heading_along_the_lines() {
    for name in ["sqf", "rsq0"] {
        let p = plate(name);
        let t = top(&slice(&p.stl, a1(&[])), &p);
        let wrong: Vec<String> = t
            .squares
            .iter()
            .enumerate()
            .filter_map(|(k, sq)| {
                let h = heading(sq.first.from, sq.first.to);
                let low = across(sq.first.from, t.dir) - sq.lowest;
                (apart(h, t.dir) > 2.0 || low > 0.05).then(|| {
                    format!(
                        "square {k}: heads {h:.1} on lines at {}, {low:.3} mm above the lowest",
                        t.dir
                    )
                })
            })
            .collect();
        assert!(
            wrong.is_empty(),
            "{name}: {} of {}: {wrong:?}",
            wrong.len(),
            t.squares.len()
        );
    }
}

#[test]
fn free_right_angle_corners_get_one_bead_by_the_pocket() {
    for name in ["sqf", "rsq0"] {
        let p = plate(name);
        let t = top(&slice(&p.stl, a1(&[])), &p);
        let (beaded, errors) = rule(name, &t);
        assert!(errors.is_empty(), "{} corner(s) off: {errors:?}", errors.len());
        assert!(!beaded.is_empty(), "{name}: no beaded corner");
    }
}

#[test]
fn a_corner_bead_runs_along_the_longer_legs_wall() {
    for name in ["sqf", "rsq0"] {
        let p = plate(name);
        let t = top(&slice(&p.stl, a1(&[])), &p);
        let (beaded, _) = rule(name, &t);
        assert!(!beaded.is_empty(), "{name}: no beaded corner");
        for (k, ci) in beaded {
            let c = &t.squares[k].corners[ci];
            let bead = &c.beads[0];
            let (a, b) = (c.legs[0].min(c.legs[1]), c.legs[0].max(c.legs[1]));
            // Along the bottom or top wall when that leg is the longer one, else along the left or right wall.
            let wall = if c.legs[0] >= c.legs[1] { 0.0 } else { 90.0 };
            let h = heading(bead.from, bead.to);
            let off = apart(h, wall).min(apart(h, wall + 180.0));
            let len = dist(bead.from, bead.to);
            let near = dist(bead.from, c.at).min(dist(bead.to, c.at));
            let tag = format!(
                "{name} square {k} corner {ci} (a {a:.3}, b {b:.3}): bead {len:.3} by {:.3} at {off:.1} degrees to its wall, {near:.3} from the corner",
                bead.width
            );
            assert!(off <= if a < 0.19 { 5.0 } else { 12.0 }, "{tag}");
            assert!((b - 0.06..=b + 0.02).contains(&len), "{tag}");
            assert!((a - 0.075..=a - 0.045).contains(&bead.width), "{tag}");
            assert!(near <= 0.05, "{tag}");
        }
    }
}

#[test]
fn the_beaded_corners_and_totals_hold() {
    // The sqf corners (square, corner) whose pocket is in the band and whose two lines the chain does not link.
    let sqf_beads = [
        (1, 0),
        (7, 0),
        (8, 0),
        (11, 0),
        (18, 0),
        (21, 0),
        (28, 0),
        (31, 0),
        (32, 0),
        (38, 0),
    ];
    let p = plate("sqf");
    let g = slice(&p.stl, a1(&[]));
    let (beaded, _) = rule("sqf", &top(&g, &p));
    assert_eq!(beaded, sqf_beads, "sqf beaded corners");
    for (name, want, tol) in [("sqf", 3.56, 0.4), ("rsq0", 0.56, 0.15)] {
        let p = plate(name);
        let got = surface_gap_mm(&slice(&p.stl, a1(&[])));
        assert!(
            (got - want).abs() <= tol,
            "{name}: {got:.2} mm of surface gap fill, want {want:.2}"
        );
    }
}

// Corners of other angles, on plates of 40 prisms 3 mm tall built here. Island k of a plate moves along x so that a
// fixed point of it steps across the bed-fixed line grid in 1/80 of the line pitch, so the corners sample every
// offset against the lines. A plate name ending in `-sqf` lays its islands as the sqf plate does instead: island k
// moves k times 0.0135 mm along x, so its corners fall into a few clusters of offsets.
//
// - At a run-in corner of 75 to 105 degrees, u is how far the shorter leg's line end sits from the corner across the
//   lines. A free corner gets exactly one bead when u is 0.107 to 0.150 mm (asserted from 0.110 to 0.147), none from
//   0.153 or up to 0.103; a linked one gets none. The bead runs along the longer leg's wall, 1.73 u - 0.10 mm wide.
// - Corners a line cuts across get no gap fill near them, nor do run-in tips at 60 and 75 degrees whose two lines
//   the chain links.
// - Nor do the base corners of a 60 degree tip (60 degrees, bisector 60 degrees off the lines), where the first line
//   runs from one wall to the other across the corner.

/// The line pitch of the stock A1 top, mm.
const PITCH: f64 = 0.37707;

/// Where island `k` of a plate on a grid of `step` mm sits: in rows of 8, moved along x so a point on its corner's
/// diagonal steps 1/80 of the pitch across the 45 degree lines per island.
fn spot(k: usize, step: f64) -> P {
    #[allow(clippy::cast_precision_loss, reason = "small island indices")]
    let (col, row, kf) = ((k % 8) as f64, (k / 8) as f64, k as f64);
    let (x, y) = (20.0 + col * step, 20.0 + row * step);
    let r = std::f64::consts::FRAC_1_SQRT_2;
    let s = (y - x) * r;
    (x + (s - kf * PITCH / 80.0).rem_euclid(PITCH) / r, y)
}

/// Where island `k` of a `-sqf` plate on a grid of `step` mm sits: in rows of 8, moved k times 0.0135 mm along x.
fn sqf_spot(k: usize, step: f64) -> P {
    #[allow(clippy::cast_precision_loss, reason = "small island indices")]
    let (col, row, kf) = ((k % 8) as f64, (k / 8) as f64, k as f64);
    (20.0 + col * step + kf * 0.0135, 20.0 + row * step)
}

/// A plate of 40 convex islands, counterclockwise: `rh<deg>` rhombi with 6 mm sides whose `deg` corners sit at both
/// ends of the diagonal along the lines (run-in corners) and whose other two are cut corners, `tip<deg>` isosceles
/// triangles with 8 mm legs and the apex bisector along the lines, `ctip<deg>` the same with the bisector across them.
fn islands(name: &str) -> Vec<Vec<P>> {
    let at = |a: f64| (a.to_radians().cos(), a.to_radians().sin());
    let (name, spot): (&str, fn(usize, f64) -> P) = match name.strip_suffix("-sqf") {
        Some(n) => (n, sqf_spot),
        None => (name, spot),
    };
    (0..40)
        .map(|k| {
            if let Some(deg) = name.strip_prefix("rh") {
                let h = deg.parse::<f64>().unwrap() / 2.0;
                let p0 = spot(k, 10.0);
                let (u1, u2) = (at(45.0 - h), at(45.0 + h));
                let p1 = (p0.0 + 6.0 * u1.0, p0.1 + 6.0 * u1.1);
                let p3 = (p0.0 + 6.0 * u2.0, p0.1 + 6.0 * u2.1);
                vec![p0, p1, (p1.0 + p3.0 - p0.0, p1.1 + p3.1 - p0.1), p3]
            } else {
                let (cut, deg) = match name.strip_prefix("ctip") {
                    Some(d) => (true, d),
                    None => (false, name.strip_prefix("tip").unwrap()),
                };
                let h = deg.parse::<f64>().unwrap() / 2.0;
                let mut a = spot(k, 14.0);
                if cut {
                    a.0 += 6.0;
                }
                let into = if cut { 135.0 } else { 45.0 };
                let (d1, d2) = (at(into - h), at(into + h));
                vec![
                    a,
                    (a.0 + 8.0 * d1.0, a.1 + 8.0 * d1.1),
                    (a.0 + 8.0 * d2.0, a.1 + 8.0 * d2.1),
                ]
            }
        })
        .collect()
}

/// A binary STL of each island as a prism 3 mm tall.
fn prisms(polys: &[Vec<P>]) -> Vec<u8> {
    let mut tris: Vec<[(f64, f64, f64); 3]> = Vec::new();
    for p in polys {
        let n = p.len();
        for i in 1..n - 1 {
            let (a, b, c) = (p[0], p[i], p[i + 1]);
            tris.push([(a.0, a.1, 0.0), (c.0, c.1, 0.0), (b.0, b.1, 0.0)]);
            tris.push([(a.0, a.1, 3.0), (b.0, b.1, 3.0), (c.0, c.1, 3.0)]);
        }
        for i in 0..n {
            let (a, b) = (p[i], p[(i + 1) % n]);
            tris.push([(a.0, a.1, 0.0), (b.0, b.1, 0.0), (b.0, b.1, 3.0)]);
            tris.push([(a.0, a.1, 0.0), (b.0, b.1, 3.0), (a.0, a.1, 3.0)]);
        }
    }
    let mut out = vec![0_u8; 80];
    out.extend(u32::try_from(tris.len()).unwrap().to_le_bytes());
    for t in &tris {
        out.extend([0_u8; 12]);
        for v in t {
            for c in [v.0, v.1, v.2] {
                #[allow(clippy::cast_possible_truncation, reason = "STL stores f32")]
                out.extend((c as f32).to_le_bytes());
            }
        }
        out.extend([0_u8; 2]);
    }
    out
}

/// A plate's G-code, once it is sliced.
type Sliced = Arc<std::sync::OnceLock<Arc<String>>>;

/// The stock A1 G-code of a plate, sliced once per test binary.
fn plate_gcode(name: &str) -> Arc<String> {
    static DONE: std::sync::Mutex<Vec<(String, Sliced)>> = std::sync::Mutex::new(Vec::new());
    let cell = {
        let mut done = DONE.lock().unwrap();
        if let Some((_, c)) = done.iter().find(|(n, _)| n == name) {
            c.clone()
        } else {
            let c = Arc::new(std::sync::OnceLock::new());
            done.push((name.to_owned(), c.clone()));
            c
        }
    };
    cell.get_or_init(|| Arc::new(slice(&prisms(&islands(name)), a1(&[]))))
        .clone()
}

/// One corner of an island's top as printed.
struct Turn {
    /// The corner's angle, degrees.
    angle: f64,
    /// The bisector runs along the lines (a run-in corner) or across them (a cut corner).
    run_in: bool,
    cut: bool,
    /// The corner of the line ends' boundary.
    at: P,
    /// The legs, shorter first, and the wall of the longer one as a unit direction from the corner.
    a: f64,
    b: f64,
    long_wall: P,
    /// How far the shorter leg's line end sits from the corner across the lines, mm.
    u: f64,
    joined: bool,
    /// The gap fill moves printed after the top within 0.2 mm of the corner.
    beads: Vec<Move>,
}

/// Every convex corner of every island of a plate on its top layer. The plate is centered on the bed.
#[allow(clippy::too_many_lines, reason = "one pass over each island's corners")]
fn turns(name: &str) -> Vec<Turn> {
    let polys = islands(name);
    let g = plate_gcode(name);
    let all = moves(&g);
    let zt = all
        .iter()
        .filter(|m| m.extrudes && m.feature == TOP)
        .map(|m| m.z)
        .fold(f64::MIN, f64::max);
    let layer: Vec<Move> = all.into_iter().filter(|m| m.z == zt).collect();
    let pts = polys.iter().flatten();
    let lo = pts
        .clone()
        .fold((f64::MAX, f64::MAX), |a, p| (a.0.min(p.0), a.1.min(p.1)));
    let hi = pts.fold((f64::MIN, f64::MIN), |a, p| (a.0.max(p.0), a.1.max(p.1)));
    let shift = (
        128.0 - f64::midpoint(lo.0, hi.0),
        128.0 - f64::midpoint(lo.1, hi.1),
    );
    let lines: Vec<&Move> = layer
        .iter()
        .filter(|m| m.extrudes && m.feature == TOP && dist(m.from, m.to) > 0.05)
        .collect();
    let dir = 45.0_f64;
    let along = (dir.to_radians().cos(), dir.to_radians().sin());
    let extrusions: Vec<&Move> = layer.iter().filter(|m| m.extrudes).collect();
    let mut out = Vec::new();
    for poly in &polys {
        let poly: Vec<P> = poly.iter().map(|p| (p.0 + shift.0, p.1 + shift.1)).collect();
        let n = poly.len();
        // Each edge: start, unit direction, inward normal.
        let edges: Vec<(P, P, P)> = (0..n)
            .map(|i| {
                let (p, q) = (poly[i], poly[(i + 1) % n]);
                let l = dist(p, q);
                let d = ((q.0 - p.0) / l, (q.1 - p.1) / l);
                (p, d, (-d.1, d.0))
            })
            .collect();
        let depth = |e: &(P, P, P), p: P| (p.0 - e.0.0) * e.2.0 + (p.1 - e.0.1) * e.2.1;
        let inside = |p: P| edges.iter().all(|e| depth(e, p) > -0.1);
        let ends: Vec<P> = lines
            .iter()
            .filter(|m| inside(m.from) && inside(m.to))
            .flat_map(|m| [m.from, m.to])
            .collect();
        let mut insets: Vec<f64> = ends
            .iter()
            .map(|p| edges.iter().map(|e| depth(e, *p)).fold(f64::MAX, f64::min))
            .collect();
        insets.sort_by(f64::total_cmp);
        let ins = insets[insets.len() / 2];
        for i in 0..n {
            let (ea, eb) = (edges[(i + n - 1) % n], edges[i]);
            let angle = (-(ea.1.0 * eb.1.0 + ea.1.1 * eb.1.1)).acos().to_degrees();
            // The two walls pulled in to the line ends, and where they meet.
            let (pa, pb) = (
                (ea.0.0 + ea.2.0 * ins, ea.0.1 + ea.2.1 * ins),
                (eb.0.0 + eb.2.0 * ins, eb.0.1 + eb.2.1 * ins),
            );
            let cross = ea.1.0 * eb.1.1 - ea.1.1 * eb.1.0;
            let t = ((pb.0 - pa.0) * eb.1.1 - (pb.1 - pa.1) * eb.1.0) / cross;
            let c = (pa.0 + t * ea.1.0, pa.1 + t * ea.1.1);
            let bis = heading((0.0, 0.0), (eb.1.0 - ea.1.0, eb.1.1 - ea.1.1));
            let rel = apart(bis, dir).min(apart(bis + 180.0, dir));
            let leg = |e: &(P, P, P)| {
                ends.iter()
                    .filter(|p| (depth(e, **p) - ins).abs() < 0.04 && dist(**p, c) < 3.0)
                    .min_by(|p, q| dist(**p, c).total_cmp(&dist(**q, c)))
                    .copied()
            };
            let (Some(xa), Some(xb)) = (leg(&ea), leg(&eb)) else {
                continue;
            };
            let (da, db) = (dist(xa, c), dist(xb, c));
            // The wall of each leg, as a direction away from the corner.
            let (wa, wb) = ((-ea.1.0, -ea.1.1), eb.1);
            let (short, a, b, long_wall) = if da <= db {
                (xa, da, db, wb)
            } else {
                (xb, db, da, wa)
            };
            let u = (-(short.0 - c.0) * along.1 + (short.1 - c.1) * along.0).abs();
            let joined = extrusions.windows(2).any(|w| {
                let (p, q) = (w[0], w[1]);
                p.feature == TOP
                    && q.feature == TOP
                    && dist(p.to, q.from) < 0.6
                    && ((dist(p.to, xa) < 0.01 && dist(q.from, xb) < 0.01)
                        || (dist(p.to, xb) < 0.01 && dist(q.from, xa) < 0.01))
            });
            let beads = layer
                .iter()
                .filter(|m| {
                    m.extrudes
                        && m.feature == "Gap infill"
                        && m.before == TOP
                        && to_segment(c, m.from, m.to) <= 0.2
                })
                .cloned()
                .collect();
            out.push(Turn {
                angle,
                run_in: rel < 5.0,
                cut: rel > 80.0,
                at: c,
                a,
                b,
                long_wall,
                u,
                joined,
                beads,
            });
        }
    }
    out
}

/// The corners that break the lateral offset rule, and the free corners in its window.
fn u_rule(name: &str, all: &[Turn]) -> (Vec<String>, usize) {
    let (mut errors, mut beaded) = (Vec::new(), 0);
    for (k, c) in all.iter().enumerate().filter(|(_, c)| c.run_in) {
        let n = c.beads.len();
        let tag = format!(
            "{name} corner {k} ({:.0} degrees, u {:.4}, a {:.3}, b {:.3}, {})",
            c.angle,
            c.u,
            c.a,
            c.b,
            if c.joined { "linked" } else { "free" }
        );
        if c.joined || c.u <= 0.103 || c.u >= 0.153 {
            if n > 0 {
                errors.push(format!("{tag}: {n} bead move(s), want none"));
            }
        } else if (0.110..=0.147).contains(&c.u) {
            if n == 1 {
                beaded += 1;
            } else {
                errors.push(format!("{tag}: {n} bead move(s), want one"));
            }
        }
    }
    (errors, beaded)
}

#[test]
fn free_corners_at_80_and_100_degrees_bead_by_the_lateral_offset() {
    for name in ["rh80", "rh100"] {
        let all = turns(name);
        let (errors, beaded) = u_rule(name, &all);
        assert!(errors.is_empty(), "{} corner(s) off: {errors:?}", errors.len());
        assert!(beaded >= 5, "{name}: {beaded} free corners in the window");
    }
}

#[test]
fn a_corner_bead_at_another_angle_is_as_wide_as_its_offset_allows() {
    for name in ["rh80", "rh100"] {
        let all = turns(name);
        let mut seen = 0;
        for (k, c) in all.iter().enumerate() {
            if !c.run_in || c.joined || !(0.110..=0.147).contains(&c.u) {
                continue;
            }
            let Some(bead) = c.beads.first() else { continue };
            seen += 1;
            let wall = heading((0.0, 0.0), c.long_wall);
            let h = heading(bead.from, bead.to);
            let off = apart(h, wall).min(apart(h, wall + 180.0));
            let len = dist(bead.from, bead.to);
            let near = dist(bead.from, c.at).min(dist(bead.to, c.at));
            let tag = format!(
                "{name} corner {k} (u {:.4}, b {:.3}): bead {len:.3} by {:.3} at {off:.1} degrees to its wall, {near:.3} from the corner",
                c.u, c.b, bead.width
            );
            assert!(off <= 15.0, "{tag}");
            assert!((c.b - 0.06..=c.b + 0.03).contains(&len), "{tag}");
            assert!((bead.width - (1.73 * c.u - 0.10)).abs() <= 0.02, "{tag}");
            assert!(near <= if c.u < 0.143 { 0.06 } else { 0.10 }, "{tag}");
        }
        assert!(seen >= 5, "{name}: {seen} beads");
    }
}

#[test]
fn corners_a_line_cuts_across_get_no_bead() {
    for name in ["rh100", "ctip60"] {
        let all = turns(name);
        let cut: Vec<&Turn> = all.iter().filter(|c| c.cut).collect();
        assert!(cut.len() >= 40, "{name}: {} cut corners", cut.len());
        let wrong: Vec<String> = cut
            .iter()
            .filter(|c| !c.beads.is_empty())
            .map(|c| {
                format!(
                    "{:.0} degrees at ({:.3}, {:.3}): {} move(s)",
                    c.angle,
                    c.at.0,
                    c.at.1,
                    c.beads.len()
                )
            })
            .collect();
        assert!(
            wrong.is_empty(),
            "{name}: {} cut corner(s) beaded: {wrong:?}",
            wrong.len()
        );
    }
}

#[test]
fn linked_run_in_tips_get_no_bead() {
    for name in ["tip75", "tip60"] {
        let all = turns(name);
        let tips: Vec<&Turn> = all.iter().filter(|c| c.run_in && c.joined).collect();
        assert!(tips.len() >= 30, "{name}: {} linked tips", tips.len());
        let wrong: Vec<String> = tips
            .iter()
            .filter(|c| !c.beads.is_empty())
            .map(|c| {
                format!(
                    "u {:.4} at ({:.3}, {:.3}): {} move(s)",
                    c.u,
                    c.at.0,
                    c.at.1,
                    c.beads.len()
                )
            })
            .collect();
        assert!(
            wrong.is_empty(),
            "{name}: {} linked tip(s) beaded: {wrong:?}",
            wrong.len()
        );
    }
}

#[test]
fn the_base_corners_of_a_60_degree_tip_get_no_gap_fill() {
    for name in ["tip60", "tip60-sqf"] {
        let all = turns(name);
        let base: Vec<&Turn> = all.iter().filter(|c| !c.run_in && !c.cut).collect();
        assert!(base.len() >= 70, "{name}: {} base corners", base.len());
        let wrong: Vec<String> = base
            .iter()
            .filter(|c| !c.beads.is_empty())
            .map(|c| {
                format!(
                    "{:.0} degrees at ({:.3}, {:.3}), a {:.3}: {} move(s) {:.3} wide",
                    c.angle,
                    c.at.0,
                    c.at.1,
                    c.a,
                    c.beads.len(),
                    c.beads[0].width
                )
            })
            .collect();
        assert!(
            wrong.is_empty(),
            "{name}: {} base corner(s) with gap fill: {wrong:?}",
            wrong.len()
        );
    }
}
