// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The line just above a slot's tip on a monotonic line top, on Bambu Lab printers. Checked on the A1 with plates of
//! 40 notched squares, each shifted a little against the line grid so the slot's tip samples every line phase: 8 mm
//! squares with a 0.8 mm slot cut in from the lower right, across the 45 degree lines, its square tip 3 mm across the
//! lines from the square's middle (`notch` moves island k by k * 0.0135 mm, `notchf` puts the tip at k / 80 of the
//! pitch).
//!
//! - The slot splits a line into two only where the line ends' boundary (the surface pulled in by 0.05 spacing) does.
//!   A line from about 0.42 mm above the slot's tip prints as one line across the slot; at 0.41 mm and below it is
//!   two, one on each side.
//! - So the two horns beside the slot hold only the lines below that boundary: the line above it adds none to them.

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
/// carry.
fn a1() -> Map<String, Value> {
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
    out
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

/// One extruding XY move of the top surface on the top layer.
struct Piece {
    from: P,
    to: P,
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

const TOP: &str = "Top surface";

/// The top surface's extruding moves longer than 0.05 mm on the highest layer that has any.
fn top_pieces(g: &str) -> Vec<Piece> {
    let (mut x, mut y, mut z) = (0.0_f64, 0.0_f64, 0.0_f64);
    let mut feature = String::new();
    let mut all: Vec<(f64, Piece)> = Vec::new();
    for line in g.lines() {
        let s = line.trim();
        if let Some(f) = s.strip_prefix("; FEATURE:").or_else(|| s.strip_prefix(";TYPE:")) {
            f.trim().clone_into(&mut feature);
            continue;
        }
        if let Some(v) = s.strip_prefix("; Z_HEIGHT:").or_else(|| s.strip_prefix(";Z:")) {
            z = v.trim().parse().unwrap();
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|p| code.starts_with(p)) {
            continue;
        }
        let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
        let extrudes = word(code, 'E').is_some_and(|e| e > 0.0);
        if extrudes && feature == TOP && (nx - x).hypot(ny - y) > 0.05 {
            all.push((
                z,
                Piece {
                    from: (x, y),
                    to: (nx, ny),
                },
            ));
        }
        (x, y) = (nx, ny);
    }
    let zt = all.iter().map(|p| p.0).fold(f64::MIN, f64::max);
    all.into_iter().filter(|p| p.0 == zt).map(|p| p.1).collect()
}

/// The line pitch of the stock A1 top, mm.
const PITCH: f64 = 0.37707;
const R2: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// Position along the 45 degree lines and across them.
fn along(p: P) -> f64 {
    (p.0 + p.1) * R2
}
fn across(p: P) -> f64 {
    (p.1 - p.0) * R2
}

/// Where island `k` sits on a grid of 12 mm: in rows of 8, moved along x by k * 0.0135 mm, or (`fine`) so its lower
/// left corner sits k / 80 of the pitch across the lines from a line.
fn spot(k: usize, fine: bool) -> P {
    #[allow(clippy::cast_precision_loss, reason = "small island indices")]
    let (col, row, kf) = ((k % 8) as f64, (k / 8) as f64, k as f64);
    let (x, y) = (20.0 + col * 12.0, 20.0 + row * 12.0);
    if fine {
        (x + (across((x, y)) - kf * PITCH / 80.0).rem_euclid(PITCH) / R2, y)
    } else {
        (x + kf * 0.0135, y)
    }
}

/// One notched island: its outline counterclockwise (lower left, the slot's mouth on the bottom wall, the tip's two
/// corners, the mouth on the right wall, upper right, upper left) and its top as triangles.
struct Notch {
    poly: Vec<P>,
    caps: Vec<[P; 3]>,
}

fn notches(fine: bool) -> Vec<Notch> {
    const SIDE: f64 = 8.0;
    (0..40)
        .map(|k| {
            let (x0, y0) = spot(k, fine);
            let xy = |t: f64, s: f64| (x0 + (t - s) * R2, y0 + (t + s) * R2);
            // The slot runs across the lines, 0.3 mm along them past the lower right corner, 0.8 mm wide.
            let (tc, hw, tip) = (SIDE * R2 + 0.3, 0.4, -3.0);
            let (ta, tb) = (tc - hw, tc + hw);
            let (a, b, c, d) = (
                xy(ta, -ta),
                xy(ta, tip),
                xy(tb, tip),
                xy(tb, tb - SIDE * std::f64::consts::SQRT_2),
            );
            let (p0, tr, tl) = ((x0, y0), (x0 + SIDE, y0 + SIDE), (x0, y0 + SIDE));
            Notch {
                poly: vec![p0, a, b, c, d, tr, tl],
                caps: vec![[p0, a, b], [p0, b, tl], [b, c, tl], [c, tr, tl], [c, d, tr]],
            }
        })
        .collect()
}

/// A binary STL of each island as a prism 3 mm tall.
fn prisms(islands: &[Notch]) -> Vec<u8> {
    let mut tris: Vec<[(f64, f64, f64); 3]> = Vec::new();
    for n in islands {
        for [a, b, c] in &n.caps {
            tris.push([(a.0, a.1, 0.0), (c.0, c.1, 0.0), (b.0, b.1, 0.0)]);
            tris.push([(a.0, a.1, 3.0), (b.0, b.1, 3.0), (c.0, c.1, 3.0)]);
        }
        let m = n.poly.len();
        for i in 0..m {
            let (a, b) = (n.poly[i], n.poly[(i + 1) % m]);
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

/// One printed line of an island's top: its offset across the lines from the slot's tip and its pieces as positions
/// along the lines from the slot's middle, low end first.
struct Line {
    above: f64,
    pieces: Vec<(f64, f64)>,
}

impl Line {
    /// One piece across the slot's middle.
    fn whole(&self) -> bool {
        self.pieces.iter().any(|p| p.0 < -0.03 && p.1 > 0.03)
    }
}

/// One island's top: its lines, lowest first, and its lines up to 2 mm above the tip in print order, each as its horn
/// (0 for A, 1 for B, 2 for a line across the slot) and whether it heads up the lines.
struct Island {
    lines: Vec<Line>,
    printed: Vec<(usize, bool)>,
}

impl Island {
    /// The pieces up to 2 mm above the tip wholly on the low side of the slot's middle (horn A) and on the high side
    /// (horn B), each with its offset above the tip.
    fn horns(&self) -> [Vec<f64>; 2] {
        let mut out = [Vec::new(), Vec::new()];
        for l in self.lines.iter().filter(|l| l.above < 2.0) {
            for p in &l.pieces {
                if p.1 < 0.01 {
                    out[0].push(l.above);
                } else if p.0 > -0.01 {
                    out[1].push(l.above);
                }
            }
        }
        out
    }
}

type Sliced = Arc<std::sync::OnceLock<Arc<Vec<Island>>>>;

/// Each island's top on the stock A1, sliced once per plate and test binary.
fn plate(name: &str) -> Arc<Vec<Island>> {
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
    cell.get_or_init(|| Arc::new(read_plate(name))).clone()
}

fn read_plate(name: &str) -> Vec<Island> {
    let islands = notches(name == "notchf");
    let pieces = top_pieces(&slice(&prisms(&islands), a1()));
    // The plate is centered on the bed.
    let pts = islands.iter().flat_map(|n| n.poly.iter());
    let lo = pts
        .clone()
        .fold((f64::MAX, f64::MAX), |a, p| (a.0.min(p.0), a.1.min(p.1)));
    let hi = pts.fold((f64::MIN, f64::MIN), |a, p| (a.0.max(p.0), a.1.max(p.1)));
    let shift = (
        128.0 - f64::midpoint(lo.0, hi.0),
        128.0 - f64::midpoint(lo.1, hi.1),
    );
    islands
        .iter()
        .map(|n| {
            let poly: Vec<P> = n.poly.iter().map(|p| (p.0 + shift.0, p.1 + shift.1)).collect();
            let (xa, xb) = poly
                .iter()
                .fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.0), a.1.max(p.0)));
            let (ya, yb) = poly
                .iter()
                .fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.1), a.1.max(p.1)));
            let middle = f64::midpoint(along(poly[2]), along(poly[3]));
            let tip = across(poly[2]);
            let mine: Vec<(f64, (f64, f64), bool)> = pieces
                .iter()
                .filter(|m| {
                    m.from.0 > xa - 0.1 && m.from.0 < xb + 0.1 && m.from.1 > ya - 0.1 && m.from.1 < yb + 0.1
                })
                .map(|m| {
                    let (t0, t1) = (along(m.from) - middle, along(m.to) - middle);
                    (across(m.from) - tip, (t0.min(t1), t0.max(t1)), t1 > t0)
                })
                .collect();
            // The pieces in print order, one entry per line.
            let mut printed: Vec<(f64, usize, bool)> = Vec::new();
            for &(s, p, up) in mine.iter().filter(|m| m.0 < 2.0) {
                let horn = if p.1 < 0.01 {
                    0
                } else if p.0 > -0.01 {
                    1
                } else {
                    2
                };
                if !printed
                    .last()
                    .is_some_and(|l| l.1 == horn && (s - l.0).abs() < 0.05)
                {
                    printed.push((s, horn, up));
                }
            }
            let mut mine: Vec<(f64, (f64, f64))> = mine.into_iter().map(|m| (m.0, m.1)).collect();
            mine.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut lines: Vec<Line> = Vec::new();
            for (s, p) in mine {
                match lines.last_mut() {
                    Some(l) if (s - l.above).abs() < 0.05 => l.pieces.push(p),
                    _ => lines.push(Line {
                        above: s,
                        pieces: vec![p],
                    }),
                }
            }
            Island {
                lines,
                printed: printed.into_iter().map(|p| (p.1, p.2)).collect(),
            }
        })
        .collect()
}

/// The lines from just above the tip to 0.9 mm above it that print wrong for their offset: two pieces from 0.42 mm
/// up, one piece across the slot at 0.41 mm and below. Also how many lines sit from 0.42 to 0.61 mm above, where the
/// lines pulled in by half a spacing are still cut by the slot.
fn tip_lines(name: &str) -> (Vec<String>, usize) {
    let mut bad = Vec::new();
    let mut near = 0;
    for (i, isl) in plate(name).iter().enumerate() {
        for l in isl.lines.iter().filter(|l| l.above > 0.0 && l.above <= 0.9) {
            if (0.42..0.61).contains(&l.above) {
                near += 1;
            }
            let wrong = if l.above >= 0.42 {
                !l.whole()
            } else {
                l.above <= 0.41 && l.whole()
            };
            if wrong {
                bad.push(format!(
                    "{name} island {i}: line {:.3} mm above the tip in {} pieces",
                    l.above,
                    l.pieces.len()
                ));
            }
        }
    }
    (bad, near)
}

#[test]
fn the_line_above_a_slot_tip_is_whole_from_the_line_end_boundary() {
    let mut bad = Vec::new();
    for name in ["notch", "notchf"] {
        let (wrong, near) = tip_lines(name);
        assert!(
            near >= 10,
            "{name}: only {near} lines from 0.42 to 0.61 mm above the tip"
        );
        bad.extend(wrong);
    }
    assert!(bad.is_empty(), "{} lines:\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn a_slot_tips_horns_hold_only_the_lines_below_the_boundary() {
    let mut bad = Vec::new();
    let mut counts = std::collections::BTreeMap::new();
    for name in ["notch", "notchf"] {
        for (i, isl) in plate(name).iter().enumerate() {
            let [a, b] = isl.horns();
            for (h, v) in [("A", &a), ("B", &b)] {
                let high: Vec<String> = v
                    .iter()
                    .filter(|&&s| s >= 0.42)
                    .map(|s| format!("{s:.3}"))
                    .collect();
                if !high.is_empty() {
                    bad.push(format!(
                        "{name} island {i}: horn {h} has lines at {}",
                        high.join(", ")
                    ));
                }
            }
            *counts.entry((a.len(), b.len())).or_insert(0) += 1;
        }
    }
    assert!(
        bad.is_empty(),
        "{} horn lines:\n{}\nhorn line counts (A, B) of 80 islands: {counts:?}",
        bad.len(),
        bad.join("\n")
    );
}

/// Each horn is a region of its own and the two print one after the other: horn B first when both hold an even number
/// of lines, else horn A, heading so it ends at the slot; the second horn then heads up the lines. A horn's line that
/// goes in beside the chain after it (a tip line) is not one of its region's lines, so the counts are the two runs
/// printed first.
#[test]
fn a_slot_tips_horns_print_in_order_by_their_line_counts() {
    let mut bad = Vec::new();
    for name in ["notch", "notchf"] {
        for (i, isl) in plate(name).iter().enumerate() {
            let run = |from: usize| {
                isl.printed.get(from).map_or(0, |h| {
                    isl.printed[from..].iter().take_while(|p| p.0 == h.0).count()
                })
            };
            let (r1, r2) = (run(0), run(run(0)));
            let mut n = [0, 0, 0];
            if let (Some(h1), Some(h2)) = (isl.printed.first(), isl.printed.get(r1)) {
                n[h1.0] = r1;
                n[h2.0] = r2;
            }
            let [na, nb, _] = n;
            let (first, n1) = if na % 2 == 0 && nb % 2 == 0 {
                (1, nb)
            } else {
                (0, na)
            };
            // Horn A ends at the slot heading up the lines, horn B heading down.
            let up = (n1 % 2 == 1) == (first == 0);
            let want: Vec<(usize, bool)> = (0..n1)
                .map(|j| (first, (j % 2 == 0) == up))
                .chain((0..na + nb - n1).map(|j| (1 - first, j % 2 == 0)))
                .collect();
            if na == 0 || nb == 0 || isl.printed.get(..na + nb) != Some(&want[..]) {
                bad.push(format!(
                    "{name} island {i} (A {na}, B {nb}): printed {:?}, want {want:?}",
                    isl.printed
                ));
            }
        }
    }
    assert!(bad.is_empty(), "{} islands:\n{}", bad.len(), bad.join("\n"));
}
