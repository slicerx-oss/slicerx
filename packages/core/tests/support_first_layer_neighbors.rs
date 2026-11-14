// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The first layer of tree support on a plate of several objects stays with the object it holds up. On the first
//! layer the support base grows past the branches (`raft_first_layer_expansion`); next to another object it must
//! not grow under that object, which only starts to widen above the first layer, and must not print under that
//! object's label. The same plate turned a quarter turn gives the same result, so nothing here depends on a
//! direction on the bed.
#![allow(
    clippy::disallowed_methods,
    clippy::needless_pass_by_value,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::many_single_char_names,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, MeshPart, SliceRequest};
use sx_core::paint::PaintFacet;

/// `support_object_xy_distance` of the plates here, mm.
const XY: f64 = 0.35;

/// A box part, `[x0, y0, z0, x1, y1, z1]` mm, with its bottom face painted as a support enforcer when `painted`.
fn cuboid(b: [f32; 6], painted: bool) -> MeshPart {
    let [x0, y0, z0, x1, y1, z1] = b;
    let mut positions = Vec::new();
    for z in [z0, z1] {
        for (x, y) in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)] {
            positions.push([x, y, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    let support_paint = if painted {
        vec![
            PaintFacet {
                v: [positions[0], positions[2], positions[1]],
                state: 1,
            },
            PaintFacet {
                v: [positions[0], positions[3], positions[2]],
                state: 1,
            },
        ]
    } else {
        Vec::new()
    };
    MeshPart {
        name: "box".into(),
        slot: 1,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint,
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
        paint_texts: Vec::new(),
    }
}

/// A 10 mm post 14 mm tall with a roof 4 mm thick reaching 8 mm out over the bed on one side, its underside
/// painted as a support enforcer. In the post's own frame the roof reaches toward -y.
fn hood() -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "hood".into(),
        parts: vec![
            cuboid([0.0, 0.0, 0.0, 10.0, 10.0, 14.0], false),
            cuboid([0.0, -8.0, 10.0, 10.0, 0.0, 14.0], true),
        ],
        ..Mesh::default()
    })
}

/// A 10 mm block 14 mm tall that is 2 mm wider on one side (+y in its own frame) from 0.6 mm up: its footprint
/// is larger than its first layer, as on a part that flares out just above the bed.
fn flared() -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "flared".into(),
        parts: vec![
            cuboid([0.0, 0.0, 0.0, 10.0, 10.0, 14.0], false),
            cuboid([0.0, 10.0, 0.6, 10.0, 12.0, 14.0], false),
        ],
        ..Mesh::default()
    })
}

/// A plate object: name, mesh, and where its frame's origin stands, turned `quarter` quarter turns about z.
struct Placed {
    name: &'static str,
    mesh: Arc<Mesh>,
    at: [f64; 2],
}

/// The plate turned `quarter` quarter turns about (128, 128), each object turned with it.
fn turned(objects: &[Placed], quarter: u8) -> Vec<(String, Arc<Mesh>, [f64; 6])> {
    objects
        .iter()
        .map(|o| {
            let (dx, dy) = (o.at[0] - 128.0, o.at[1] - 128.0);
            // [a, b, c, d]: x' = a x + b y, y' = c x + d y.
            let (a, b, c, d) = match quarter % 4 {
                0 => (1.0, 0.0, 0.0, 1.0),
                1 => (0.0, -1.0, 1.0, 0.0),
                2 => (-1.0, 0.0, 0.0, -1.0),
                _ => (0.0, 1.0, -1.0, 0.0),
            };
            let at = [128.0 + a * dx + b * dy, 128.0 + c * dx + d * dy];
            (o.name.to_owned(), o.mesh.clone(), [a, b, c, d, at[0], at[1]])
        })
        .collect()
}

/// Slices the plate with painted (manual) tree support and object labels on.
fn slice(objects: &[(String, Arc<Mesh>, [f64; 6])], extra: Value) -> String {
    let mut cfg = json!({
        "brim_width": 0, "skirt_loops": 0, "gcode_label_objects": true,
        "enable_support": true, "support_type": "tree(manual)",
        "support_object_xy_distance": XY, "enable_arc_fitting": false,
    });
    if let (Some(c), Some(e)) = (cfg.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    // A column-major 4 by 4 transform: the turn in the first two columns, the place in the last.
    let list: Vec<Value> = objects
        .iter()
        .map(|(name, _, t)| {
            let [a, b, c, d, x, y] = *t;
            json!({"id": name, "name": name, "mesh": name,
                   "transform": [a, c, 0, 0,  b, d, 0, 0,  0, 0, 1, 0,  x, y, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(
        json!({"plate": {"objects": list}, "config": cfg, "options": {"allowCollisions": true}}),
    )
    .unwrap();
    let meshes: Vec<(String, Arc<Mesh>)> = objects.iter().map(|(n, m, _)| (n.clone(), m.clone())).collect();
    let run = common::run_request(&req, &move |id: &str| {
        Ok(meshes
            .iter()
            .find(|(n, _)| n == id)
            .map(|(_, m)| m.clone())
            .unwrap())
    })
    .unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// One extruding move: the active label, the feature, its ends and Z.
struct Move {
    label: Option<String>,
    feature: String,
    a: [f64; 2],
    b: [f64; 2],
    z: f64,
}

fn moves(g: &str) -> Vec<Move> {
    let (mut label, mut feature, mut at, mut z) = (None::<String>, String::new(), None::<[f64; 2]>, 0.0);
    let mut out = Vec::new();
    for line in g.lines() {
        if let Some(rest) = line.strip_prefix("; printing object ") {
            label = rest.split(" id:").next().map(str::to_owned);
        } else if line.starts_with("; stop printing object ") {
            label = None;
        } else if let Some(t) = line.strip_prefix(";TYPE:") {
            t.clone_into(&mut feature);
        } else if let Some(v) = line.strip_prefix(";Z:") {
            z = v.trim().parse().unwrap_or(z);
        }
        let code = line.split(';').next().unwrap_or("").trim();
        let Some(g) = ["G0", "G1", "G2", "G3"]
            .into_iter()
            .find(|g| code.split_whitespace().next() == Some(*g))
        else {
            continue;
        };
        let word = |c: char| {
            code.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        let next = match (word('X'), word('Y'), at) {
            (None, None, _) => continue,
            (x, y, Some(p)) => [x.unwrap_or(p[0]), y.unwrap_or(p[1])],
            (Some(x), Some(y), None) => [x, y],
            _ => continue,
        };
        if let Some(p) = at
            && g != "G0"
            && word('E').is_some_and(|e| e > 0.0)
        {
            // An arc is followed in steps of about 0.1 mm round its center.
            let pts = if g == "G1" {
                vec![p, next]
            } else {
                let c = [p[0] + word('I').unwrap_or(0.0), p[1] + word('J').unwrap_or(0.0)];
                let r = (p[0] - c[0]).hypot(p[1] - c[1]);
                let a0 = (p[1] - c[1]).atan2(p[0] - c[0]);
                let a1 = (next[1] - c[1]).atan2(next[0] - c[0]);
                let tau = std::f64::consts::TAU;
                let sweep = if g == "G3" {
                    (a1 - a0).rem_euclid(tau)
                } else {
                    -(a0 - a1).rem_euclid(tau)
                };
                let n = ((sweep.abs() * r) / 0.1).ceil().max(1.0) as usize;
                (0..=n)
                    .map(|k| {
                        let a = a0 + sweep * k as f64 / n as f64;
                        if k == n {
                            next
                        } else {
                            [c[0] + r * a.cos(), c[1] + r * a.sin()]
                        }
                    })
                    .collect()
            };
            for w in pts.windows(2) {
                out.push(Move {
                    label: label.clone(),
                    feature: feature.clone(),
                    a: w[0],
                    b: w[1],
                    z,
                });
            }
        }
        at = Some(next);
    }
    out
}

/// The first layer's support extrusions.
fn first_layer_support(all: &[Move]) -> Vec<&Move> {
    let z0 = all.iter().map(|m| m.z).fold(f64::INFINITY, f64::min);
    all.iter()
        .filter(|m| (m.z - z0).abs() < 1e-6 && m.feature.starts_with("Support"))
        .collect()
}

/// Distance from `p` to the box `[x0, y0, x1, y1]`, 0 inside it.
fn box_dist(p: [f64; 2], b: [f64; 4]) -> f64 {
    let dx = (b[0] - p[0]).max(p[0] - b[2]).max(0.0);
    let dy = (b[1] - p[1]).max(p[1] - b[3]).max(0.0);
    dx.hypot(dy)
}

/// The nearest a move comes to the box, sampled every 0.1 mm.
fn move_box_dist(m: &Move, b: [f64; 4]) -> f64 {
    let len = (m.b[0] - m.a[0]).hypot(m.b[1] - m.a[1]);
    let n = (len / 0.1).ceil().max(1.0) as usize;
    (0..=n)
        .map(|k| {
            let t = k as f64 / n as f64;
            box_dist(
                [m.a[0] + t * (m.b[0] - m.a[0]), m.a[1] + t * (m.b[1] - m.a[1])],
                b,
            )
        })
        .fold(f64::INFINITY, f64::min)
}

/// The footprint box of a 10 by `depth` mm block whose frame starts at `y0`, on the turned plate.
fn footprint(objects: &[(String, Arc<Mesh>, [f64; 6])], name: &str, y: [f64; 2]) -> [f64; 4] {
    let (_, _, t) = objects.iter().find(|(n, _, _)| n == name).unwrap();
    let [a, b, c, d, x0, y0] = *t;
    let corners = [[0.0, y[0]], [10.0, y[0]], [10.0, y[1]], [0.0, y[1]]];
    let pts: Vec<[f64; 2]> = corners
        .iter()
        .map(|p| [x0 + a * p[0] + b * p[1], y0 + c * p[0] + d * p[1]])
        .collect();
    [
        pts.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min),
        pts.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min),
        pts.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max),
        pts.iter().map(|p| p[1]).fold(f64::NEG_INFINITY, f64::max),
    ]
}

/// A hood whose roof reaches over the flared side of a block: the roof's tip stands 1.5 mm past the flare, so its
/// support comes down beside the block, where the block's first layer leaves room that its flare above does not.
fn hood_over_flare() -> Vec<Placed> {
    vec![
        Placed {
            name: "block",
            mesh: flared(),
            at: [123.0, 100.0],
        },
        Placed {
            name: "hood",
            mesh: hood(),
            at: [123.0, 121.5],
        },
    ]
}

fn check_hood_over_flare(quarter: u8) {
    let plate = turned(&hood_over_flare(), quarter);
    let g = slice(&plate, json!({}));
    let all = moves(&g);
    let first = first_layer_support(&all);
    let total: f64 = first
        .iter()
        .map(|m| (m.b[0] - m.a[0]).hypot(m.b[1] - m.a[1]))
        .sum();
    assert!(total > 20.0, "{total} mm of first layer support under the hood");
    // The block asks for no support: nothing on the first layer prints as its support.
    let block: f64 = first
        .iter()
        .filter(|m| m.label.as_deref() == Some("block"))
        .map(|m| (m.b[0] - m.a[0]).hypot(m.b[1] - m.a[1]))
        .sum();
    assert!(
        block < 1e-6,
        "turn {quarter}: {block} mm of first layer support printed as the block's"
    );
    // The hood's support stays the support's XY distance clear of the block's footprint, flare included (less
    // half a support line, since the paths are line middles).
    let flare = footprint(&plate, "block", [0.0, 12.0]);
    let nearest = first
        .iter()
        .map(|m| move_box_dist(m, flare))
        .fold(f64::INFINITY, f64::min);
    assert!(
        nearest >= XY,
        "turn {quarter}: first layer support comes {nearest:.2} mm from the block's footprint"
    );
}

#[test]
fn first_layer_support_stays_clear_of_a_neighbor_that_flares_above_it() {
    check_hood_over_flare(0);
}

#[test]
fn first_layer_support_stays_clear_of_a_neighbor_on_a_turned_plate() {
    check_hood_over_flare(1);
}
