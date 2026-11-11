// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A piece cut from a smooth hull loft and cut again stays closed, however many cuts it takes. Each cut goes through
//! the JSON as a client sends it, so every piece is stored at f32 before the next cut, as in the app.

#![cfg(feature = "cad")]

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;

fn run(op: &str, req: &Value) -> Value {
    serde_json::from_str(&sx_geom::json::call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}")))
        .unwrap()
}

/// the sections of `fixtures/hull-sections.json` under `key`
fn sections(key: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hull-sections.json");
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    fx[key].clone()
}

fn smooth_loft(key: &str) -> Value {
    run(
        "sketch.loft",
        &json!({ "profiles": sections(key), "smooth": true }),
    )["mesh"]
        .clone()
}

/// the piece of `mesh` below (`keep_below`) or above the plane at height `z`, and that piece's open edges
fn cut(mesh: &Value, z: f64, keep_below: bool) -> (Value, usize) {
    let r = run(
        "cut",
        &json!({ "mesh": mesh, "plane": { "point": [0, 0, z], "normal": [0, 0, 1] }, "options": {} }),
    );
    let piece = r[if keep_below { "below" } else { "above" }].clone();
    let open = open_edges(&piece);
    (piece, open)
}

/// the sides used by other than exactly two triangles, with corners matched by their stored place, as a client
/// reading the reply sees them
#[allow(clippy::cast_possible_truncation, reason = "indices of a reply")]
fn open_edges(m: &Value) -> usize {
    let list = |k: &str| m[k].as_array().cloned().unwrap_or_default();
    let p: Vec<u64> = list("positions")
        .iter()
        .map(|v| v.as_f64().unwrap().to_bits())
        .collect();
    let ix: Vec<usize> = list("indices")
        .iter()
        .map(|v| v.as_u64().unwrap() as usize)
        .collect();
    let at = |i: usize| [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
    let mut sides: HashMap<[[u64; 3]; 2], usize> = HashMap::new();
    for t in ix.chunks(3) {
        for j in 0..3 {
            let (a, b) = (at(t[j]), at(t[(j + 1) % 3]));
            *sides.entry(if a <= b { [a, b] } else { [b, a] }).or_default() += 1;
        }
    }
    sides.values().filter(|&&n| n != 2).count()
}

/// the lowest and highest z of a reply's mesh
fn heights(m: &Value) -> (f64, f64) {
    let z = m["positions"]
        .as_array()
        .unwrap()
        .iter()
        .skip(2)
        .step_by(3)
        .map(|v| v.as_f64().unwrap());
    z.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), z| {
        (lo.min(z), hi.max(z))
    })
}

#[test]
fn a_piece_cut_again_is_closed() {
    let loft = smooth_loft("recut");
    let (up, open) = cut(&loft, 3.0, false);
    assert_eq!(open, 0);
    let (below, open) = cut(&up, 6.7, true);
    assert_eq!(open, 0, "cut at z 3, then at z 6.7");
    // the piece takes a boolean: before, a dropped sliver of the first cap left it open and it was refused
    let pin = run(
        "build",
        &json!({ "solids": [{ "type": "cylinder", "origin": [143, 119, 4.2], "axis": [0, 1, 0], "diameterMm": 0.6, "heightMm": 1.0 }] }),
    )["mesh"]
        .clone();
    let holed = run(
        "boolean",
        &json!({ "op": "difference", "a": [{ "mesh": below }], "b": [{ "mesh": pin }] }),
    );
    assert_eq!(open_edges(&holed["mesh"]), 0);
}

#[test]
fn the_whole_hull_cut_again_is_closed() {
    let (up, open) = cut(&smooth_loft("hull"), 3.0, false);
    assert_eq!(open, 0);
    for z in [6.6, 6.7, 6.8, 7.0] {
        for keep_below in [true, false] {
            assert_eq!(cut(&up, z, keep_below).1, 0, "cut at z 3, then at z {z}");
        }
    }
}

#[test]
fn every_piece_of_a_cut_hull_stays_closed() {
    for key in ["recut", "hull"] {
        let loft = smooth_loft(key);
        for first in [2.0, 3.0, 4.5] {
            let (up, open) = cut(&loft, first, false);
            assert_eq!(open, 0, "{key}: cut at z {first}");
            for second in [6.6, 6.7, 6.8, 7.0] {
                for keep_below in [true, false] {
                    let (piece, open) = cut(&up, second, keep_below);
                    assert_eq!(open, 0, "{key}: cut at z {first}, then at z {second}");
                    // and a third and a fourth time, about a third of the piece's height in from each end (off the
                    // heights the sections have points at: a plane through a row of points is another case)
                    let (lo, hi) = heights(&piece);
                    let (piece, open) = cut(&piece, lo + (hi - lo) * 0.31, false);
                    assert_eq!(open, 0, "{key}: z {first}, z {second}, then a third up");
                    let (_, open) = cut(&piece, lo + (hi - lo) * 0.69, true);
                    assert_eq!(
                        open, 0,
                        "{key}: z {first}, z {second}, a third up, then two thirds up"
                    );
                }
            }
        }
    }
}
