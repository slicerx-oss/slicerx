// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The object labels a printer skips objects by (`gcode_label_objects`, M624 and `EXCLUDE_OBJECT`): every extrusion
//! carries the label of the object it is part of. Each plate is sliced and each extrusion's label is compared with
//! the object whose footprint holds it.
#![allow(
    clippy::disallowed_methods,
    clippy::needless_pass_by_value,
    clippy::many_single_char_names,
    clippy::cast_possible_truncation,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{Mesh, MeshPart, SliceRequest};

/// A box part, `[x0, y0, z0, x1, y1, z1]` mm.
fn cuboid(b: [f32; 6], slot: u8) -> MeshPart {
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
    MeshPart {
        name: format!("part {slot}"),
        slot,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint: Vec::new(),
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
        paint_texts: Vec::new(),
    }
}

/// One object made of boxes (one part each, all slot 1).
fn object(boxes: &[[f32; 6]]) -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "boxes".into(),
        parts: boxes.iter().map(|&b| cuboid(b, 1)).collect(),
    })
}

/// Slices `objects` (name, boxes, at x, y) with object labels on, and `extra` settings.
fn slice(objects: &[(&str, &[[f32; 6]], f32, f32)], extra: Value) -> String {
    let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "gcode_label_objects": true});
    if let (Some(c), Some(e)) = (cfg.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    let list: Vec<Value> = objects
        .iter()
        .map(|(name, _, x, y)| json!({"id": name, "name": name, "mesh": name, "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,0,1]}))
        .collect();
    let req: SliceRequest = serde_json::from_value(
        json!({"plate": {"objects": list}, "config": cfg, "options": {"allowCollisions": true}}),
    )
    .unwrap();
    let meshes: Vec<(String, Arc<Mesh>)> = objects
        .iter()
        .map(|(n, b, _, _)| ((*n).to_owned(), object(b)))
        .collect();
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

/// One extruding move: the active label, the feature, its middle, its length and Z.
struct Move {
    label: Option<String>,
    feature: String,
    mid: [f64; 2],
    len: f64,
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
        let code = line.split(';').next().unwrap_or("");
        if !(code.starts_with("G0")
            || code.starts_with("G1")
            || code.starts_with("G2")
            || code.starts_with("G3"))
        {
            continue;
        }
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
            && code.starts_with('G')
            && !code.starts_with("G0")
            && word('E').is_some_and(|e| e > 0.0)
        {
            out.push(Move {
                label: label.clone(),
                feature: feature.clone(),
                mid: [f64::midpoint(p[0], next[0]), f64::midpoint(p[1], next[1])],
                len: (next[0] - p[0]).hypot(next[1] - p[1]),
                z,
            });
        }
        at = Some(next);
    }
    out
}

/// Millimetres of extrusion whose label is not the one object whose footprint (`[x0, y0, x1, y1]` boxes, placed)
/// holds it; moves held by no footprint or by two are not judged.
fn mislabelled(g: &str, objects: &[(&str, &[[f32; 6]], f32, f32)]) -> f64 {
    let holds = |p: [f64; 2]| -> Vec<&str> {
        objects
            .iter()
            .filter(|(_, boxes, x, y)| {
                boxes.iter().any(|b| {
                    let m = 0.8;
                    p[0] >= f64::from(b[0] + x) - m
                        && p[0] <= f64::from(b[3] + x) + m
                        && p[1] >= f64::from(b[1] + y) - m
                        && p[1] <= f64::from(b[4] + y) + m
                })
            })
            .map(|(n, ..)| *n)
            .collect()
    };
    moves(g)
        .iter()
        .filter(|m| {
            !matches!(
                m.feature.as_str(),
                "Skirt" | "Brim" | "Prime tower" | "Custom" | "Support" | "Support interface"
            )
        })
        .filter(|m| matches!(holds(m.mid).as_slice(), [one] if m.label.as_deref() != Some(*one)))
        .map(|m| m.len)
        .sum()
}

const CUBE: &[[f32; 6]] = &[[0.0, 0.0, 0.0, 20.0, 20.0, 3.0]];

#[test]
fn common_plates_label_every_extrusion_with_its_object() {
    // Side by side, printed by layer and by object.
    let side = [("a", CUBE, 60.0, 100.0), ("b", CUBE, 120.0, 100.0)];
    assert!(mislabelled(&slice(&side, json!({})), &side) < 1e-6);
    assert!(mislabelled(&slice(&side, json!({"print_sequence": "by object"})), &side) < 1e-6);
    // A cube inside a ring, and a cube in an L's corner (their boxes overlap).
    let ring: &[[f32; 6]] = &[
        [0.0, 0.0, 0.0, 40.0, 10.0, 3.0],
        [0.0, 30.0, 0.0, 40.0, 40.0, 3.0],
        [0.0, 10.0, 0.0, 10.0, 30.0, 3.0],
        [30.0, 10.0, 0.0, 40.0, 30.0, 3.0],
    ];
    let small: &[[f32; 6]] = &[[0.0, 0.0, 0.0, 10.0, 10.0, 3.0]];
    let nested = [("ring", ring, 80.0, 100.0), ("small", small, 95.0, 115.0)];
    assert!(mislabelled(&slice(&nested, json!({})), &nested) < 1e-6);
    let l: &[[f32; 6]] = &[
        [0.0, 0.0, 0.0, 40.0, 10.0, 3.0],
        [0.0, 10.0, 0.0, 10.0, 40.0, 3.0],
    ];
    let corner: &[[f32; 6]] = &[[14.0, 14.0, 0.0, 26.0, 26.0, 3.0]];
    let l_cube = [("l", l, 80.0, 80.0), ("cube", corner, 80.0, 80.0)];
    assert!(mislabelled(&slice(&l_cube, json!({})), &l_cube) < 1e-6);
    // Two Ls, one turned and tucked into the other's corner, as true shape arrange nests them.
    let tucked: &[[f32; 6]] = &[
        [12.0, 42.0, 0.0, 52.0, 52.0, 3.0],
        [42.0, 12.0, 0.0, 52.0, 42.0, 3.0],
    ];
    let ls = [("l1", l, 80.0, 80.0), ("l2", tucked, 80.0, 80.0)];
    assert!(mislabelled(&slice(&ls, json!({})), &ls) < 1e-6);
}

#[test]
fn interlocking_objects_label_every_extrusion_with_its_object() {
    // A C open to the right, and a second object whose arm reaches into its mouth: the arm lies inside the C's
    // convex hull, and the C inside the second object's.
    let c1: &[[f32; 6]] = &[
        [0.0, 0.0, 0.0, 10.0, 30.0, 3.0],
        [10.0, 0.0, 0.0, 40.0, 10.0, 3.0],
        [10.0, 20.0, 0.0, 40.0, 30.0, 3.0],
    ];
    let c2: &[[f32; 6]] = &[
        [20.0, 12.5, 0.0, 56.0, 17.5, 3.0],
        [55.0, 0.0, 0.0, 65.0, 30.0, 3.0],
    ];
    let plate = [("c1", c1, 80.0, 100.0), ("c2", c2, 80.0, 100.0)];
    assert!(mislabelled(&slice(&plate, json!({})), &plate) < 1e-6);
}

#[test]
fn touching_objects_are_cut_at_their_seam() {
    // Two cubes side by side with no gap, printed by layer: their infill runs across the seam in one region, and
    // each piece carries its own object's label.
    let a: &[[f32; 6]] = &[[0.0, 0.0, 0.0, 20.0, 20.0, 3.0]];
    let b: &[[f32; 6]] = &[[20.0, 0.0, 0.0, 40.0, 20.0, 3.0]];
    let plate = [("a", a, 80.0, 100.0), ("b", b, 80.0, 100.0)];
    let g = slice(&plate, json!({}));
    assert!(mislabelled(&g, &plate) < 1e-6);
    // The cuts add points on the same lines: per layer, the same extrusion as one block of the two.
    let one: &[[f32; 6]] = &[[0.0, 0.0, 0.0, 40.0, 20.0, 3.0]];
    let whole = slice(&[("ab", one, 80.0, 100.0)], json!({}));
    let per_layer = |g: &str| {
        let mut v: Vec<(String, f64)> = Vec::new();
        for m in moves(g) {
            let k = format!("{:.2}", m.z);
            match v.last_mut() {
                Some((z, l)) if *z == k => *l += m.len,
                _ => v.push((k, m.len)),
            }
        }
        v
    };
    let (cut, plain) = (per_layer(&g), per_layer(&whole));
    assert_eq!(cut.len(), plain.len());
    for ((z, a), (_, b)) in cut.iter().zip(&plain) {
        assert!(
            (a - b).abs() < 1e-3 * b.max(1.0),
            "layer {z}: {a} mm against {b} mm"
        );
    }
}

#[test]
fn support_belongs_to_the_object_it_holds_up() {
    // A column with a shelf hanging 10 mm out to the right at 8 mm, and a second object standing 1 mm from the
    // support under the shelf: the support is the shelf's, not its nearer neighbor's.
    let shelf: &[[f32; 6]] = &[
        [0.0, 0.0, 0.0, 10.0, 10.0, 10.0],
        [10.0, 0.0, 8.0, 20.0, 10.0, 10.0],
    ];
    let post: &[[f32; 6]] = &[[21.0, 0.0, 0.0, 26.0, 10.0, 10.0]];
    let plate = [("shelf", shelf, 80.0, 100.0), ("post", post, 80.0, 100.0)];
    let g = slice(
        &plate,
        json!({"enable_support": true, "support_type": "normal(auto)"}),
    );
    // All of it, the first layer's border round the support area too, which runs close by the post.
    let support: Vec<Move> = moves(&g)
        .into_iter()
        .filter(|m| m.feature.starts_with("Support"))
        .collect();
    let under = |m: &&Move| (90.5..=99.5).contains(&m.mid[0]) && (100.5..=109.5).contains(&m.mid[1]);
    assert!(support.iter().filter(under).map(|m| m.len).sum::<f64>() > 100.0);
    let wrong: f64 = support
        .iter()
        .filter(|m| m.label.as_deref() != Some("shelf"))
        .map(|m| m.len)
        .sum();
    assert!(
        wrong < 1e-6,
        "{wrong} mm of the shelf's support not labelled shelf"
    );
}

#[test]
fn stacked_objects_with_one_footprint_keep_their_own_labels() {
    // The two-color x-mark: band objects A (Z 0 to 75.5) and B (Z 15.5 to 85.5) share one footprint, two build
    // items placed as the CLI and the MCP server place a 3MF plate.
    let path = format!("{}/bench/models/x-mark-2color.3mf", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).unwrap();
    let items = sx_core::api::load_3mf_plate_objects(&bytes, "x-mark-2color.3mf")
        .unwrap()
        .into_iter()
        .next()
        .unwrap()
        .1;
    assert_eq!(items.len(), 2);
    let merged = Mesh {
        name: "x".into(),
        parts: items.iter().flat_map(|m| m.parts.iter().cloned()).collect(),
    };
    let at = sx_core::plate::centered_transform(&merged, sx_core::api::Bed::default());
    let objects: Vec<Value> = items
        .iter()
        .enumerate()
        .map(|(k, m)| json!({"id": format!("o{k}"), "name": m.name, "mesh": format!("m{k}"), "transform": at.to_vec()}))
        .collect();
    let names: Vec<String> = items.iter().map(|m| m.name.clone()).collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": {"brim_width": 0, "skirt_loops": 0, "gcode_label_objects": true, "prime_tower_brim_width": 0},
        "options": {"allowCollisions": true},
    }))
    .unwrap();
    let meshes: Vec<Arc<Mesh>> = items.into_iter().map(Arc::new).collect();
    let run = common::run_request(&req, &move |id: &str| {
        Ok(meshes[id.trim_start_matches('m').parse::<usize>().unwrap()].clone())
    })
    .unwrap();
    let g = String::from_utf8(run.gcode).unwrap();
    // Each object's label only where that object is.
    let span = |name: &str| {
        if name.ends_with('A') {
            (0.0, 75.5)
        } else {
            (15.5, 85.5)
        }
    };
    let mut wrong = 0.0;
    let mut by_label = std::collections::BTreeMap::new();
    for m in moves(&g)
        .into_iter()
        .filter(|m| m.feature != "Prime tower" && m.feature != "Custom")
    {
        let Some(label) = m.label.clone() else { continue };
        assert!(names.contains(&label), "{label}");
        let name = label;
        let (lo, hi) = span(&name);
        if m.z < lo + 0.2 - 1e-6 || m.z > hi + 0.3 {
            wrong += m.len;
        }
        *by_label.entry(name).or_insert(0.0) += m.len;
    }
    assert_eq!(by_label.len(), 2, "{by_label:?}");
    assert!(
        wrong < 1e-6,
        "{wrong} mm labelled with an object that is not at that height ({by_label:?})"
    );
}
