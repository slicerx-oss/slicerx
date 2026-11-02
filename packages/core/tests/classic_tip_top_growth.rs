// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The tapered tips of the classic x-mark's top regions on Bambu Lab printers with classic walls
//! (fixtures/classic-ring-shell: the stock A1 and P1S settings with classic walls and `precise_outer_wall` off).
//!
//! On z 59.0, 59.2 and, with 0.12 mm layers, 59.12, the top surface beside each slot of the layer above narrows to
//! nothing at four tips. The top starts at the slot's closed end and grows into the internal solid shell beside it,
//! which wraps round this layer's slot walls and runs down a strip about 0.55 mm wide on each side. Grown in one round
//! offset it cuts across the slot walls into those strips, so the top runs too far down them and the floating shell
//! starts below a part too wide for a gap bead and too short for a line: a hole in the tip. Grown in steps, each one
//! clipped to the shell again, it follows the shell round the wall corner and stops where the floating shell meets it.
//!
//! The checks, against measured tips: each tip layer's gap fill and floating shell length, its top surface no more
//! than 0.2 mm below what it was before the change, how much of each tip box no extrusion covers (each move drawn at
//! its stated width on a 0.02 mm grid), and how far up the lower right tip of z 59.2 and z 59.12 the floating shell
//! reaches. Coordinates are the A1 plate's; the P1S puts the part 2 mm lower in y.
//!
//! Two measured tips are left out, as follow-up work: the z 59.2 gap fill total (1.54 to 2.58 mm), short a 0.61 mm
//! bead under the lowest top line's end at the lower right tip, and the z 59.0 lower right tip (at most 0.06 mm2
//! uncovered), which needs one more short top line and its bead. Both are a gap fill shape at a tip with no wedge, not
//! the growth of the top.

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::float_cmp,
    clippy::many_single_char_names,
    reason = "a G-code reader for the test: plate coordinates and lengths in mm"
)]

use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

const GAP: &str = "Gap infill";
const TOP: &str = "Top surface";
const FLOATING: &str = "Floating vertical shell";

/// One extruding move: feature, start, end and stated width.
struct Seg {
    feature: String,
    a: (f64, f64),
    b: (f64, f64),
    w: f64,
}

/// The G-code of the classic x-mark on `printer` (`a1` or `p1s`) at `layer_height`.
fn slice(printer: &str, layer_height: f64) -> String {
    let dir = env!("CARGO_MANIFEST_DIR");
    let path = format!("{dir}/tests/fixtures/classic-ring-shell/{printer}-x-mark.json");
    let mut req: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    req["config"]["layer_height"] = json!(layer_height);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let model = std::fs::read(format!("{dir}/bench/models/x-mark.stl")).unwrap();
    let mesh = Arc::new(Mesh::load(&model, "x-mark.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// The value of word `k` in a G-code line.
fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

/// Every extruding move by layer z (in thousandths of a mm), arcs as chords about 0.2 mm long.
fn layers(g: &str) -> BTreeMap<i64, Vec<Seg>> {
    let mut out: BTreeMap<i64, Vec<Seg>> = BTreeMap::new();
    let (mut x, mut y, mut z, mut w) = (0.0_f64, 0.0_f64, 0, 0.4_f64);
    let (mut rel, mut e_abs) = (true, 0.0_f64);
    let mut feature = String::new();
    for line in g.lines() {
        let s = line.trim();
        if let Some(c) = s.strip_prefix(';') {
            let c = c.trim_start();
            if let Some(f) = c.strip_prefix("TYPE:").or_else(|| c.strip_prefix("FEATURE:")) {
                f.trim().clone_into(&mut feature);
            } else if let Some(v) = c.strip_prefix("Z_HEIGHT:").or_else(|| c.strip_prefix("Z:")) {
                if let Ok(v) = v.trim().parse::<f64>() {
                    z = (v * 1000.0).round() as i64;
                }
            } else if let Some(v) = c
                .strip_prefix("LINE_WIDTH:")
                .or_else(|| c.strip_prefix("WIDTH:"))
                .and_then(|v| v.trim().parse().ok())
            {
                w = v;
            }
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        let Some(head) = code.split_whitespace().next() else {
            continue;
        };
        match head {
            "M83" => rel = true,
            "M82" => rel = false,
            "G92" => {
                if let Some(e) = word(code, 'E') {
                    e_abs = e;
                }
            }
            "G0" | "G1" | "G2" | "G3" => {
                let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
                let e = match word(code, 'E') {
                    Some(e) if rel => e,
                    Some(e) => {
                        let d = e - e_abs;
                        e_abs = e;
                        d
                    }
                    None => 0.0,
                };
                if e > 0.0 && (nx != x || ny != y) {
                    let segs = out.entry(z).or_default();
                    let (i, j) = (word(code, 'I'), word(code, 'J'));
                    if (head == "G2" || head == "G3") && (i.is_some() || j.is_some()) {
                        let (cx, cy) = (x + i.unwrap_or(0.0), y + j.unwrap_or(0.0));
                        let a0 = (y - cy).atan2(x - cx);
                        let mut a1 = (ny - cy).atan2(nx - cx);
                        let r = (x - cx).hypot(y - cy);
                        let tau = std::f64::consts::TAU;
                        if head == "G3" {
                            while a1 <= a0 {
                                a1 += tau;
                            }
                        } else {
                            while a1 >= a0 {
                                a1 -= tau;
                            }
                        }
                        let n = (((a1 - a0).abs() * r / 0.2) as usize + 1).max(2);
                        let mut p = (x, y);
                        for k in 1..=n {
                            let a = a0 + (a1 - a0) * k as f64 / n as f64;
                            let q = if k < n {
                                (cx + r * a.cos(), cy + r * a.sin())
                            } else {
                                (nx, ny)
                            };
                            segs.push(Seg {
                                feature: feature.clone(),
                                a: p,
                                b: q,
                                w,
                            });
                            p = q;
                        }
                    } else {
                        segs.push(Seg {
                            feature: feature.clone(),
                            a: (x, y),
                            b: (nx, ny),
                            w,
                        });
                    }
                }
                x = nx;
                y = ny;
            }
            _ => {}
        }
    }
    out
}

/// The moves of the layer nearest `z`, if one lies within 0.011 mm.
fn layer(all: &BTreeMap<i64, Vec<Seg>>, z: f64) -> &[Seg] {
    let want = (z * 1000.0).round() as i64;
    all.iter()
        .min_by_key(|(k, _)| (**k - want).abs())
        .filter(|(k, _)| (**k - want).abs() <= 11)
        .map_or(&[], |(_, v)| v.as_slice())
}

fn length(segs: &[Seg], feature: &str) -> f64 {
    segs.iter()
        .filter(|s| s.feature == feature)
        .map(|s| (s.b.0 - s.a.0).hypot(s.b.1 - s.a.1))
        .sum()
}

const RES: f64 = 0.02;

/// The grid cells each move covers, drawn its stated width, with the feature that drew each one last.
fn raster<'a>(segs: &[&'a Seg]) -> HashMap<(i64, i64), &'a str> {
    let mut cells = HashMap::new();
    for s in segs {
        let r = s.w / 2.0;
        let ((x0, y0), (x1, y1)) = (s.a, s.b);
        let i0 = ((x0.min(x1) - r) / RES).floor() as i64;
        let i1 = ((x0.max(x1) + r) / RES).ceil() as i64;
        let j0 = ((y0.min(y1) - r) / RES).floor() as i64;
        let j1 = ((y0.max(y1) + r) / RES).ceil() as i64;
        let (dx, dy) = (x1 - x0, y1 - y0);
        let l2 = dx * dx + dy * dy;
        for i in i0..=i1 {
            let cx = (i as f64 + 0.5) * RES;
            for j in j0..=j1 {
                let cy = (j as f64 + 0.5) * RES;
                let t = if l2 == 0.0 {
                    0.0
                } else {
                    (((cx - x0) * dx + (cy - y0) * dy) / l2).clamp(0.0, 1.0)
                };
                let (ex, ey) = (cx - x0 - t * dx, cy - y0 - t * dy);
                if ex * ex + ey * ey <= r * r {
                    cells.insert((i, j), s.feature.as_str());
                }
            }
        }
    }
    cells
}

/// The uncovered area of a tip box (mm2) and the highest y (A1 plate) a floating shell cell in it reaches.
fn tip(segs: &[Seg], bx: [f64; 4], dy: f64) -> (f64, Option<f64>) {
    let [x0, x1, y0, y1] = bx;
    let (y0, y1) = (y0 + dy, y1 + dy);
    let near: Vec<&Seg> = segs
        .iter()
        .filter(|q| {
            !(q.a.0.max(q.b.0) < x0 - 1.0
                || q.a.0.min(q.b.0) > x1 + 1.0
                || q.a.1.max(q.b.1) < y0 - 1.0
                || q.a.1.min(q.b.1) > y1 + 1.0)
        })
        .collect();
    let cells = raster(&near);
    let (mut empty, mut reach) = (0_u32, None::<f64>);
    for i in (x0 / RES).round() as i64..(x1 / RES).round() as i64 {
        for j in (y0 / RES).round() as i64..(y1 / RES).round() as i64 {
            match cells.get(&(i, j)) {
                None => empty += 1,
                Some(&f) if f == FLOATING => {
                    let y = (j as f64 + 0.5) * RES - dy;
                    reach = Some(reach.map_or(y, |r: f64| r.max(y)));
                }
                Some(_) => {}
            }
        }
    }
    (f64::from(empty) * RES * RES, reach)
}

/// A tip layer: z, the gap fill band (mm) or `None` when it is left out, the floating shell length within 0.6 mm, and
/// the top surface before this change, which may drop by at most 0.2 mm.
struct Layer {
    z: f64,
    gap: Option<(f64, f64)>,
    floating: f64,
    top_before: f64,
}

/// A tip box (A1 plate: x0, x1, y0, y1), the most of it that may stay uncovered (mm2) and, where it is checked, the
/// lowest y the floating shell must reach.
struct Tip {
    z: f64,
    name: &'static str,
    bx: [f64; 4],
    empty_max: f64,
    reach_min: Option<f64>,
}

const LOWER_LEFT: [f64; 4] = [126.3, 126.9, 121.5, 122.9];
const LOWER_RIGHT: [f64; 4] = [129.2, 129.75, 121.5, 123.4];
const UPPER_LEFT: [f64; 4] = [126.3, 126.9, 132.3, 134.2];
const UPPER_RIGHT: [f64; 4] = [129.2, 129.75, 132.3, 134.2];

// Left out as follow-up work (see the file's notes): the z 59.2 gap fill band, 1.54 to 2.58 mm, and the z 59.0 lower
// right tip, at most 0.06 mm2 uncovered.
const LAYERS_02: [Layer; 2] = [
    Layer {
        z: 59.0,
        gap: Some((2.79, 4.65)),
        floating: 86.25,
        top_before: 27.04,
    },
    Layer {
        z: 59.2,
        gap: None,
        floating: 18.65,
        top_before: 78.14,
    },
];

const TIPS_02: [Tip; 7] = [
    Tip {
        z: 59.0,
        name: "lower left",
        bx: LOWER_LEFT,
        empty_max: 0.1,
        reach_min: None,
    },
    Tip {
        z: 59.0,
        name: "upper left",
        bx: UPPER_LEFT,
        empty_max: 0.2,
        reach_min: None,
    },
    Tip {
        z: 59.0,
        name: "upper right",
        bx: UPPER_RIGHT,
        empty_max: 0.24,
        reach_min: None,
    },
    Tip {
        z: 59.2,
        name: "lower left",
        bx: LOWER_LEFT,
        empty_max: 0.03,
        reach_min: None,
    },
    Tip {
        z: 59.2,
        name: "lower right",
        bx: LOWER_RIGHT,
        empty_max: 0.2,
        reach_min: Some(122.95),
    },
    Tip {
        z: 59.2,
        name: "upper left",
        bx: UPPER_LEFT,
        empty_max: 0.07,
        reach_min: None,
    },
    Tip {
        z: 59.2,
        name: "upper right",
        bx: UPPER_RIGHT,
        empty_max: 0.055,
        reach_min: None,
    },
];

const LAYERS_012: [Layer; 1] = [Layer {
    z: 59.12,
    gap: Some((1.31, 2.17)),
    floating: 15.55,
    top_before: 84.95,
}];

const TIPS_012: [Tip; 4] = [
    Tip {
        z: 59.12,
        name: "lower left",
        bx: LOWER_LEFT,
        empty_max: 0.03,
        reach_min: None,
    },
    Tip {
        z: 59.12,
        name: "lower right",
        bx: LOWER_RIGHT,
        empty_max: 0.15,
        reach_min: Some(122.38),
    },
    Tip {
        z: 59.12,
        name: "upper left",
        bx: UPPER_LEFT,
        empty_max: 0.08,
        reach_min: None,
    },
    Tip {
        z: 59.12,
        name: "upper right",
        bx: UPPER_RIGHT,
        empty_max: 0.06,
        reach_min: None,
    },
];

/// Every check of `layers` and `tips` on the x-mark sliced for `printer` at `layer_height`, failing with all misses.
fn check(printer: &str, layer_height: f64, layers_: &[Layer], tips: &[Tip]) {
    let dy = if printer == "p1s" { -2.0 } else { 0.0 };
    let all = layers(&slice(printer, layer_height));
    let mut misses = Vec::new();
    for l in layers_ {
        let s = layer(&all, l.z);
        let (gap, top, floating) = (length(s, GAP), length(s, TOP), length(s, FLOATING));
        if let Some((lo, hi)) = l.gap
            && !(lo..=hi).contains(&gap)
        {
            misses.push(format!("z {}: gap fill {gap:.2} mm, want {lo} to {hi}", l.z));
        }
        if (floating - l.floating).abs() > 0.6 {
            misses.push(format!(
                "z {}: floating shell {floating:.2} mm, want {} within 0.6",
                l.z, l.floating
            ));
        }
        if top < l.top_before - 0.2 {
            misses.push(format!(
                "z {}: top surface {top:.2} mm, want at least {:.2}",
                l.z,
                l.top_before - 0.2
            ));
        }
    }
    for t in tips {
        let (empty, reach) = tip(layer(&all, t.z), t.bx, dy);
        if empty > t.empty_max {
            misses.push(format!(
                "z {} {} tip: {empty:.3} mm2 uncovered, want at most {}",
                t.z, t.name, t.empty_max
            ));
        }
        if let Some(min) = t.reach_min
            && reach.is_none_or(|r| r < min)
        {
            misses.push(format!(
                "z {} {} tip: floating shell reaches y {reach:?}, want at least {min}",
                t.z, t.name
            ));
        }
    }
    assert!(
        misses.is_empty(),
        "{printer} classic, {layer_height} mm layers:\n{}",
        misses.join("\n")
    );
}

#[test]
fn a1_tips_close_on_02_mm_layers() {
    check("a1", 0.2, &LAYERS_02, &TIPS_02);
}

#[test]
fn p1s_tips_close_on_02_mm_layers() {
    check("p1s", 0.2, &LAYERS_02, &TIPS_02);
}

#[test]
fn a1_tips_close_on_012_mm_layers() {
    check("a1", 0.12, &LAYERS_012, &TIPS_012);
}

#[test]
fn p1s_tips_close_on_012_mm_layers() {
    check("p1s", 0.12, &LAYERS_012, &TIPS_012);
}
