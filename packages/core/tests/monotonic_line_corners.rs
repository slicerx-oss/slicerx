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
