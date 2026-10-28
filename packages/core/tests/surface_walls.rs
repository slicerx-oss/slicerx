// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Surface labels that follow what the walls leave, whatever the wall generator.
//!
//! - The x-mark on the stock P1S request, smart layer off: a narrow piece prints as floating vertical shell or as
//!   internal solid infill alike with classic and aegis walls. Measured: 10.5 mm more floating shell with variable
//!   width walls than with classic ones.
//! - Strips 30.9 mm long along 45 degrees, 2.2 mm tall, on the stock Voron 2.4 (arachne walls, 3 loops) and Ender 3
//!   V3 (classic walls, 2 loops) requests, smart layer off. Per strip, the measured features inside the walls on
//!   the top layer (z 2.2), the layer below (z 2.0) and a sparse layer (z 1.2), with the top layer's lines longer
//!   than 5 mm, their widths and their distances from the strip's side (fixtures/surface-walls/f4-targets.json).
//!   Under arachne walls a strip whose innermost walls leave 0.31 mm between them gets nothing inside them. Under
//!   classic walls with no sparse infill the middle of a narrow strip is infill area, not a gap fill bead, once it
//!   holds a surface line; a narrower strip keeps its gap fill bead on every layer, where the targets have nothing
//!   on the top and sparse layers and internal solid infill below (a slot inside the walls is worse than the bead).

use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/surface-walls");
const FEATURES: [&str; 3] = ["Top surface", "Internal solid infill", "Gap infill"];

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURES}/{name}")).unwrap()
}

/// The G-code of the request fixture `request` with `edits` to its config, its one object printing `mesh`.
fn slice(request: &str, mesh: &[u8], edits: &[(&str, Value)]) -> String {
    let mut req: Value = serde_json::from_slice(&fixture(request)).unwrap();
    for (k, v) in edits {
        req["config"][*k] = v.clone();
    }
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let mesh = Arc::new(Mesh::load(mesh, "m.stl").unwrap());
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

/// Filament (mm, relative extrusion) per feature over the whole print.
fn totals(g: &str) -> BTreeMap<String, f64> {
    let mut out: BTreeMap<String, f64> = BTreeMap::new();
    let mut feature = String::new();
    for line in g.lines() {
        let s = line.trim();
        if let Some(f) = comment(s, &["TYPE", "FEATURE"]) {
            f.clone_into(&mut feature);
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !(code.starts_with("G1 ") || code.starts_with("G2 ") || code.starts_with("G3 ")) {
            continue;
        }
        if let Some(e) = word(code, 'E').filter(|e| *e > 0.0)
            && (word(code, 'X').is_some() || word(code, 'Y').is_some())
        {
            *out.entry(feature.clone()).or_default() += e;
        }
    }
    out
}

#[test]
fn the_x_mark_floats_the_same_pieces_with_classic_and_aegis_walls() {
    let mesh = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/bench/models/x-mark.stl")).unwrap();
    let floating = |walls: &str| {
        let g = slice("p1s-x-mark.json", &mesh, &[("wall_generator", json!(walls))]);
        totals(&g).get("Floating vertical shell").copied().unwrap_or(0.0)
    };
    let (classic, aegis) = (floating("classic"), floating("aegis"));
    assert!(classic > 400.0, "classic walls: floating {classic:.1}");
    assert!(
        (aegis - classic).abs() <= 15.0,
        "floating vertical shell: aegis walls {aegis:.1}, classic walls {classic:.1}"
    );
}

/// One extruding move: its layer z, feature, stated width and ends.
struct Seg {
    z: i64,
    feature: String,
    width: f64,
    from: [f64; 2],
    to: [f64; 2],
}

/// A height or width in thousandths of a millimeter.
#[allow(
    clippy::cast_possible_truncation,
    reason = "plate sizes in thousandths of a millimeter"
)]
fn milli(v: f64) -> i64 {
    (v * 1000.0).round() as i64
}

fn segments(gcode: &str) -> Vec<Seg> {
    let (mut x, mut y, mut z, mut width) = (0.0, 0.0, 0, 0.0);
    let mut feature = String::new();
    let mut out = Vec::new();
    for line in gcode.lines() {
        let text = line.trim();
        if let Some(f) = comment(text, &["TYPE", "FEATURE"]) {
            f.clone_into(&mut feature);
            continue;
        }
        if let Some(w) = comment(text, &["WIDTH", "LINE_WIDTH"]).and_then(|v| v.parse::<f64>().ok()) {
            width = w;
            continue;
        }
        if let Some(h) = comment(text, &["Z_HEIGHT", "Z"]).and_then(|v| v.parse::<f64>().ok()) {
            z = milli(h);
            continue;
        }
        let code = text.split(';').next().unwrap_or("").trim();
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|g| code.starts_with(g)) {
            continue;
        }
        let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
        if word(code, 'E').is_some_and(|e| e > 0.0) && (nx, ny) != (x, y) {
            out.push(Seg {
                z,
                feature: feature.clone(),
                width,
                from: [x, y],
                to: [nx, ny],
            });
        }
        (x, y) = (nx, ny);
    }
    out
}

/// What one feature prints inside a strip on one layer: lines longer than 5 mm, their distinct stated widths and
/// distances from the strip's side (thousandths of a millimeter), and the shorter pieces.
#[derive(Debug, Default, PartialEq)]
struct Fill {
    lines: usize,
    widths: BTreeSet<i64>,
    from_side: BTreeSet<i64>,
    short: usize,
}

/// Per strip, narrowest first, the top layer, the layer below and the middle layer: what each feature prints inside
/// the strip. The strips are found from the outer wall on the top layer, along the strip normal.
fn strips(g: &str) -> Vec<[BTreeMap<String, Fill>; 3]> {
    let segs = segments(g);
    let half = std::f64::consts::FRAC_1_SQRT_2;
    let across = |p: [f64; 2]| -p[0] * half + p[1] * half;
    let zs: Vec<i64> = segs
        .iter()
        .map(|s| s.z)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let (top, below, middle) = (zs[zs.len() - 1], zs[zs.len() - 2], zs[zs.len() / 2]);
    let mut walls: Vec<f64> = segs
        .iter()
        .filter(|s| s.z == top && s.feature == "Outer wall")
        .map(|s| across(s.from))
        .collect();
    walls.sort_by(f64::total_cmp);
    let mut runs: Vec<[f64; 2]> = vec![[walls[0], walls[0]]];
    for v in walls.into_iter().skip(1) {
        let last = runs.len() - 1;
        if v - runs[last][1] > 3.0 {
            runs.push([v, v]);
        } else {
            runs[last][1] = v;
        }
    }
    runs.into_iter()
        .map(|[lo, hi]| {
            let side = lo - 0.21;
            [top, below, middle].map(|z| {
                let mut fills: BTreeMap<String, Fill> = BTreeMap::new();
                for s in segs
                    .iter()
                    .filter(|s| s.z == z && FEATURES.contains(&s.feature.as_str()))
                {
                    let mid = across([
                        f64::midpoint(s.from[0], s.to[0]),
                        f64::midpoint(s.from[1], s.to[1]),
                    ]);
                    if !(lo - 0.5..=hi + 0.5).contains(&mid) {
                        continue;
                    }
                    let fill = fills.entry(s.feature.clone()).or_default();
                    let (dx, dy) = (s.to[0] - s.from[0], s.to[1] - s.from[1]);
                    if (dx * dx + dy * dy).sqrt() > 5.0 {
                        fill.lines += 1;
                        fill.widths.insert(milli(s.width));
                        fill.from_side.insert(milli(mid - side));
                    } else {
                        fill.short += 1;
                    }
                }
                fills
            })
        })
        .collect()
}

/// The measured fills of one layer of one strip in the targets file.
fn target(layer: &Value) -> BTreeMap<String, Fill> {
    let set = |v: &Value| -> BTreeSet<i64> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| milli(x.as_f64().unwrap()))
            .collect()
    };
    layer
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| *k != "z")
        .map(|(k, v)| {
            (
                k.clone(),
                Fill {
                    lines: usize::try_from(v["lines"].as_u64().unwrap()).unwrap(),
                    widths: set(&v["widths"]),
                    from_side: set(&v["from_side"]),
                    short: usize::try_from(v["short"].as_u64().unwrap()).unwrap(),
                },
            )
        })
        .collect()
}

/// True when two sets of thousandths hold as many values and each pair, in order, is within 0.01 mm.
fn close(a: &BTreeSet<i64>, b: &BTreeSet<i64>) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() <= 10)
}

/// The strips of `case` in the targets file against the slice of `request` with `edits`: on the top layer the same
/// features with the same line counts, widths and positions within 0.01 mm; on the layer below and the sparse layer
/// the same features.
/// Strips narrower than one surface line that keep a gap fill bead with fixed-width walls and no sparse infill: the
/// strip's width and the bead's width, mm. The bead runs down the strip's middle on every layer.
const GAP_FILL_BELOW_ONE_LINE: [(f64, f64); 2] = [(1.7, 0.192), (1.72, 0.212)];

/// The fill a strip `width` mm wide keeps in place of the targets' with `keep_gap` ([`GAP_FILL_BELOW_ONE_LINE`]).
fn bead(keep_gap: &[(f64, f64)], width: f64) -> Option<BTreeMap<String, Fill>> {
    let &(_, bead) = keep_gap.iter().find(|(w, _)| (w - width).abs() < 1e-9)?;
    let fill = Fill {
        lines: 1,
        widths: BTreeSet::from([milli(bead)]),
        from_side: BTreeSet::from([milli(width / 2.0)]),
        short: 0,
    };
    Some(BTreeMap::from([("Gap infill".to_owned(), fill)]))
}

fn check(case: &str, request: &str, mesh: &str, edits: &[(&str, Value)], keep_gap: &[(f64, f64)]) {
    let targets: Value = serde_json::from_slice(&fixture("f4-targets.json")).unwrap();
    let want = targets[case].as_array().unwrap();
    let got = strips(&slice(request, &fixture(mesh), edits));
    assert_eq!(got.len(), want.len(), "{case}: strips found");
    let mut wrong = Vec::new();
    for (t, layers) in want.iter().zip(&got) {
        let width = t["width_mm"].as_f64().unwrap();
        for (k, (tag, have)) in ["top", "below", "sparse_layer"].iter().zip(layers).enumerate() {
            let need = bead(keep_gap, width).unwrap_or_else(|| target(&t[*tag]));
            let names = |m: &BTreeMap<String, Fill>| m.keys().cloned().collect::<BTreeSet<_>>();
            let same = names(&need) == names(have)
                && (k > 0
                    || need.iter().all(|(f, n)| {
                        let h = &have[f];
                        n.lines == h.lines && close(&n.widths, &h.widths) && close(&n.from_side, &h.from_side)
                    }));
            if !same {
                wrong.push(format!("strip {width} {tag}: want {need:?}, got {have:?}"));
            }
        }
    }
    assert!(wrong.is_empty(), "{case}:\n{}", wrong.join("\n"));
}

#[test]
fn arachne_strips_too_narrow_for_a_line_get_nothing_inside_the_walls() {
    for density in [15, 100] {
        check(
            &format!("voron--f4strips--s{density}"),
            "voron-f4strips.json",
            "f4-vor.stl",
            &[("sparse_infill_density", json!(density))],
            &[],
        );
    }
}

#[test]
fn classic_strips_with_no_sparse_infill_print_infill_area_not_gap_fill() {
    check(
        "ender--f4strips--s0",
        "ender-f4strips.json",
        "f4-end.stl",
        &[("sparse_infill_density", json!(0))],
        &GAP_FILL_BELOW_ONE_LINE,
    );
}

#[test]
fn classic_strips_with_sparse_infill_keep_their_gap_fill_bead() {
    check(
        "ender--f4strips--s15",
        "ender-f4strips.json",
        "f4-end.stl",
        &[],
        &[],
    );
}
