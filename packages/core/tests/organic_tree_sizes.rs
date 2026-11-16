// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! How organic tree branches join and widen on the way down, read back from the G-code of small parts made here.
//!
//! - Join: two tabs on a wall, 12 mm apart, each hold up one branch. The two branches lean toward each other and
//!   meet as one trunk before the bed. They meet no higher than where branches leaning at the branch angle would and
//!   no lower than where branches leaning at the slow branch angle would.
//! - Growth: one tab holds up one trunk. Between its tip and the bed foot, the trunk widens by
//!   `2 * tan(tree_support_branch_diameter_angle) * layer height` per layer, and no more.
//!
//! A support island is a group of support moves that come within [`ISLAND_GAP_MM`] of each other on one layer.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use common::organic_models::{self as models, SupportSegs};
use sx_core::api::{Mesh, MeshPart, SliceRequest};

/// Support moves closer than this on one layer belong to one island, mm: two support lines (0.4 mm wide) side by
/// side, so the two walls of one branch never count as two islands, and two branches with a visible gap do.
const ISLAND_GAP_MM: f64 = 0.8;
const LAYER_MM: f64 = 0.2;
/// The underside of the tabs, mm.
const TAB_Z: f32 = 19.0;
const BRANCH_ANGLE: f64 = 45.0;
const SLOW_ANGLE: f64 = 25.0;
const DIAMETER_ANGLE: f64 = 5.0;

/// A 30 mm wide, 2 mm thick wall 20 mm high, with a 3 x 5 mm tab 1 mm thick at its top for every x in `tabs`.
fn wall_with_tabs(tabs: &[f32]) -> Mesh {
    let mut parts: Vec<MeshPart> = vec![models::cuboid("wall", [-15.0, -1.0, 0.0], [15.0, 1.0, 20.0])];
    for (i, x) in tabs.iter().enumerate() {
        parts.push(models::cuboid(
            &format!("tab{i}"),
            [x - 1.5, 1.0, TAB_Z],
            [x + 1.5, 6.0, TAB_Z + 1.0],
        ));
    }
    Mesh {
        name: "wall-tabs".into(),
        parts,
        ..Mesh::default()
    }
}

/// The G-code of `mesh` alone in the middle of the plate, with organic tree support and the settings of `extra`.
fn slice(mesh: &Mesh, extra: &Value) -> String {
    let mut config = json!({
        "enable_support": true, "support_type": "tree(auto)", "support_style": "default",
        "organic_per_object": true,
        "tree_support_branch_angle_organic": BRANCH_ANGLE, "tree_support_angle_slow": SLOW_ANGLE,
        "tree_support_branch_diameter_organic": 2, "tree_support_branch_diameter_angle": DIAMETER_ANGLE,
        "tree_support_tip_diameter": 0.8,
        "brim_width": 0, "brim_type": "no_brim", "skirt_loops": 0, "enable_arc_fitting": false,
        "layer_height": LAYER_MM, "initial_layer_print_height": LAYER_MM,
    });
    if let (Some(dst), Some(src)) = (config.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "part", "name": "part", "mesh": "part",
            "transform": [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  128, 128, 0, 1]}]},
        "config": config,
    }))
    .unwrap();
    let mesh = Arc::new(mesh.clone());
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// The root of `a` in the union-find forest `p`, halving the path on the way.
fn find(p: &mut [usize], mut a: usize) -> usize {
    while p[a] != a {
        p[a] = p[p[a]];
        a = p[a];
    }
    a
}

/// The support islands of one layer's base support moves (interface left out), as boxes `[x0, y0, x1, y1]`, mm.
fn islands(segs: &SupportSegs) -> Vec<[f64; 4]> {
    let segs: Vec<([f64; 2], [f64; 2])> = segs
        .iter()
        .filter(|(iface, ..)| !iface)
        .map(|(_, a, b)| {
            (
                [f64::from(a[0]), f64::from(a[1])],
                [f64::from(b[0]), f64::from(b[1])],
            )
        })
        .collect();
    // Points every 0.2 mm along each move, then moves joined by union-find wherever two points come close.
    let pts: Vec<Vec<[f64; 2]>> = segs
        .iter()
        .map(|(a, b)| {
            let n = ((b[0] - a[0]).hypot(b[1] - a[1]) / 0.2).ceil().max(1.0) as usize;
            (0..=n)
                .map(|k| {
                    let t = k as f64 / n as f64;
                    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
                })
                .collect()
        })
        .collect();
    let mut parent: Vec<usize> = (0..segs.len()).collect();
    let mut grid: std::collections::HashMap<(i64, i64), Vec<usize>> = std::collections::HashMap::new();
    let cell = |p: [f64; 2]| {
        (
            (p[0] / ISLAND_GAP_MM).floor() as i64,
            (p[1] / ISLAND_GAP_MM).floor() as i64,
        )
    };
    for (i, ps) in pts.iter().enumerate() {
        for p in ps {
            let (cx, cy) = cell(*p);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for &j in grid.get(&(cx + dx, cy + dy)).map_or(&[][..], Vec::as_slice) {
                        let close = pts[j]
                            .iter()
                            .any(|q| (q[0] - p[0]).hypot(q[1] - p[1]) <= ISLAND_GAP_MM);
                        if close {
                            let (ra, rb) = (find(&mut parent, i), find(&mut parent, j));
                            parent[ra] = rb;
                        }
                    }
                }
            }
            grid.entry((cx, cy)).or_default().push(i);
        }
    }
    let mut boxes: std::collections::BTreeMap<usize, [f64; 4]> = std::collections::BTreeMap::new();
    for (i, ps) in pts.iter().enumerate() {
        let r = find(&mut parent, i);
        let b = boxes.entry(r).or_insert([f64::MAX, f64::MAX, f64::MIN, f64::MIN]);
        for p in ps {
            *b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
        }
    }
    boxes.into_values().collect()
}

/// Per layer of base support, its print Z and islands, from the bed up.
fn layers(gcode: &str) -> Vec<(f64, Vec<[f64; 4]>)> {
    models::support_moves(gcode)
        .iter()
        .map(|(z, segs)| (f64::from(*z), islands(segs)))
        .filter(|(_, isl)| !isl.is_empty())
        .collect()
}

#[test]
fn two_branches_side_by_side_join_between_the_heights_their_lean_allows() {
    let half = 6.0f32;
    let g = slice(&wall_with_tabs(&[-half, half]), &json!({}));
    let layers = layers(&g);
    let at_bed = layers.first().map(|(_, isl)| isl.len());
    assert_eq!(at_bed, Some(1), "one trunk reaches the bed: {:?}", layers.first());
    // The join: the highest layer up to which, from the bed, every layer holds one island.
    let joined = layers
        .iter()
        .take_while(|(_, isl)| isl.len() == 1)
        .last()
        .map(|(z, _)| *z)
        .unwrap();
    // The branches start under the tabs and lean toward each other; they can meet once each has moved half the gap
    // between them. At the branch angle that takes half / tan(45) mm of height, at the slow angle half / tan(25).
    let top = f64::from(TAB_Z);
    let reach = |deg: f64| f64::from(half) / deg.to_radians().tan();
    let (highest, lowest) = (top - reach(BRANCH_ANGLE), top - reach(SLOW_ANGLE));
    // One layer either way for where the last layer of two islands falls.
    assert!(
        joined <= highest + LAYER_MM && joined >= lowest - LAYER_MM,
        "joined at z {joined:.2}, expected between {lowest:.2} and {highest:.2}; layers: {:?}",
        layers.iter().map(|(z, i)| (*z, i.len())).collect::<Vec<_>>()
    );
    // Above the join there are two branches until the tips.
    let two = layers
        .iter()
        .filter(|(z, _)| *z > joined + LAYER_MM && *z < top - 1.0)
        .all(|(_, isl)| isl.len() == 2);
    assert!(
        two,
        "two branches above the join: {:?}",
        layers.iter().map(|(z, i)| (*z, i.len())).collect::<Vec<_>>()
    );
}

#[test]
fn a_trunk_widens_by_the_diameter_angle_per_layer_and_no_more() {
    let g = slice(&wall_with_tabs(&[0.0]), &json!({}));
    let layers = layers(&g);
    // The trunk's width at `z`: the narrower side of its island's box (a leaning tube's cut is longer one way).
    let width = |z: f64| {
        let (_, isl) = layers
            .iter()
            .find(|(lz, _)| (lz - z).abs() < LAYER_MM / 2.0)
            .unwrap_or_else(|| panic!("no support at z {z}"));
        assert_eq!(isl.len(), 1, "one trunk at z {z}: {isl:?}");
        let b = isl[0];
        (b[2] - b[0]).min(b[3] - b[1])
    };
    // From above the bed widening (7.5 mm at most, at 0.7 radians a layer, so under 4 mm here) to below the tip
    // (the tip widens over its first mm).
    let per_layer = 2.0 * DIAMETER_ANGLE.to_radians().tan() * LAYER_MM;
    let (lo, hi) = (6.0, 16.0);
    let span = ((hi - lo) / LAYER_MM).round();
    let grown = width(lo) - width(hi);
    let want = per_layer * span;
    // A tube's cut is a polygon of chords a few hundredths of a mm inside the circle, and paths are written to
    // 0.001 mm: 0.15 mm over the span covers both and is under a fifth of the growth checked.
    assert!(
        (grown - want).abs() <= 0.15,
        "the trunk grew {grown:.3} mm in width from z {hi} to z {lo}, expected {want:.3}"
    );
    // And no step of 1 mm grows more than its share.
    let mut z = lo;
    while z < hi - 1e-9 {
        let step = width(z) - width(z + 1.0);
        let share = per_layer * (1.0 / LAYER_MM);
        assert!(
            step <= share + 0.1,
            "the trunk grew {step:.3} mm from z {} to z {z}, more than {share:.3}",
            z + 1.0
        );
        z += 1.0;
    }
}
