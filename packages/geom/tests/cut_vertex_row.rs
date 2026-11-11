// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A smooth hull loft cut at the height of a row of its section points, or a hair from it, gives two pieces that are
//! closed as the reply stores them: welded at their f32 corners, no triangle collapses to a line and every side has
//! two triangles running it opposite ways. The cut's report and the mesh info read the piece the same way.

#![cfg(feature = "cad")]

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;

fn run(op: &str, req: &Value) -> Value {
    serde_json::from_str(&sx_geom::json::call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}")))
        .unwrap()
}

/// the sections of `fixtures/hull-rows.json` under `key`
fn sections(key: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hull-rows.json");
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    fx[key].clone()
}

/// every height a section point sits at, and a few round heights and heights a hair off the 3.6 mm row
fn heights(profiles: &Value) -> Vec<f64> {
    let mut out = vec![2.0, 3.0, 3.59, 3.5999, 3.6, 3.6001, 3.61, 4.0, 5.0, 6.0, 7.0];
    for p in profiles.as_array().unwrap() {
        let z0 = p["frame"]["origin"][2].as_f64().unwrap();
        for l in p["loops"].as_array().unwrap() {
            for q in l["points"].as_array().unwrap() {
                out.push(z0 + q[1].as_f64().unwrap());
            }
        }
    }
    out.retain(|&z| z > 0.05 && z < 8.2);
    out.sort_by(f64::total_cmp);
    out.dedup();
    out
}

/// what a client reading the piece back sees, its corners welded at their stored f32 places: the triangles that
/// collapse to a line there, then the open, flipped and non-manifold sides of the rest
#[allow(
    clippy::cast_possible_truncation,
    reason = "the reply's positions are f32 and its indices u32"
)]
fn stored(m: &Value) -> [usize; 4] {
    let list = |k: &str| m[k].as_array().cloned().unwrap_or_default();
    let bits: Vec<u32> = list("positions")
        .iter()
        .map(|v| (v.as_f64().unwrap() as f32).to_bits())
        .collect();
    let at = |i: u64| {
        let i = i as usize * 3;
        [bits[i], bits[i + 1], bits[i + 2]]
    };
    let ix: Vec<u64> = list("indices").iter().map(|v| v.as_u64().unwrap()).collect();
    let mut collapsed = 0;
    let mut sides: HashMap<([u32; 3], [u32; 3]), (usize, usize)> = HashMap::new();
    for t in ix.chunks(3) {
        let corners = [at(t[0]), at(t[1]), at(t[2])];
        if corners[0] == corners[1] || corners[1] == corners[2] || corners[0] == corners[2] {
            collapsed += 1;
            continue;
        }
        for j in 0..3 {
            let (a, b) = (corners[j], corners[(j + 1) % 3]);
            let count = sides.entry((a.min(b), a.max(b))).or_insert((0, 0));
            if a < b {
                count.0 += 1;
            } else {
                count.1 += 1;
            }
        }
    }
    let mut out = [collapsed, 0, 0, 0];
    for &(f, b) in sides.values() {
        match f + b {
            1 => out[1] += 1,
            2 if f != 1 => out[2] += 1,
            2 => {}
            _ => out[3] += 1,
        }
    }
    out
}

fn counts(e: &Value) -> [usize; 4] {
    let n = |k: &str| usize::try_from(e[k].as_u64().unwrap_or(0)).unwrap();
    [
        n("collapsedTriangles"),
        n("boundaryEdges"),
        n("flippedEdges"),
        n("nonManifoldEdges"),
    ]
}

#[test]
fn a_cut_at_a_row_of_section_points_stores_closed() {
    let mut bad = Vec::new();
    let mut cuts = 0;
    for key in ["three", "fifteen"] {
        let profiles = sections(key);
        let loft = run("sketch.loft", &json!({ "profiles": profiles, "smooth": true }))["mesh"].clone();
        for z in heights(&profiles) {
            let r = run(
                "cut",
                &json!({ "mesh": loft, "plane": { "point": [0, 0, z], "normal": [0, 0, 1] }, "options": {} }),
            );
            cuts += 1;
            for side in ["below", "above"] {
                let s = stored(&r[side]);
                if s != [0; 4] {
                    bad.push(format!(
                        "{key} z {z} {side}: collapsed, open, flipped, non-manifold {s:?}"
                    ));
                }
            }
        }
    }
    assert!(cuts > 40, "{cuts} cuts");
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn the_cut_report_and_mesh_info_read_the_piece_as_stored() {
    let profiles = sections("three");
    let loft = run("sketch.loft", &json!({ "profiles": profiles, "smooth": true }))["mesh"].clone();
    for z in [3.0, 3.6, 3.6001, 5.6] {
        let r = run(
            "cut",
            &json!({ "mesh": loft, "plane": { "point": [0, 0, z], "normal": [0, 0, 1] }, "options": {} }),
        );
        for side in ["below", "above"] {
            let s = stored(&r[side]);
            let report = counts(&r["report"][format!("{side}Edges")]);
            let info = run("info", &json!({ "mesh": r[side] }));
            assert_eq!(report, s, "z {z} {side}: the cut report against the stored piece");
            assert_eq!(
                counts(&info["edges"]),
                s,
                "z {z} {side}: info against the stored piece"
            );
            assert_eq!(
                info["watertight"].as_bool(),
                Some(s[1..] == [0, 0, 0]),
                "z {z} {side}"
            );
        }
    }
}
