// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Ironing every solid surface (`ironing_type` solid): an object layer with no sparse infill is solid through, so its
//! whole outline is ironed, over the walls, half a nozzle (or `ironing_inset`) inside the edge. A layer with sparse
//! infill irons only its solid fill, inside the walls. Each object decides for itself.

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use common::organic_models::cuboid;
use sx_core::api::{Mesh, MeshPart, SliceRequest};

fn mesh(name: &str, parts: Vec<MeshPart>) -> Arc<Mesh> {
    Arc::new(Mesh {
        name: name.into(),
        parts,
        ..Mesh::default()
    })
}

/// A plate of `objects` (id, mesh), each placed as its mesh lies, ironing every solid surface at 0.1 mm with 3 walls,
/// 15% sparse infill, 4 top and 3 bottom shells, over `extra` settings. Returns the G-code.
fn run(objects: &[(&str, Arc<Mesh>)], extra: &Value) -> String {
    let mut c = json!({
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "ironing_type": "solid",
        "ironing_flow": 15,
        "ironing_spacing": 0.1,
        "ironing_inset": 0,
        "wall_loops": 3,
        "sparse_infill_density": 15,
        "top_shell_layers": 4,
        "bottom_shell_layers": 3,
        "brim_width": 0,
        "skirt_loops": 0,
    });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    let list: Vec<Value> = objects
        .iter()
        .map(|(id, _)| {
            json!({
                "id": id, "name": id, "mesh": id,
                "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            })
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": list},
        "config": c,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let meshes: Vec<(String, Arc<Mesh>)> = objects
        .iter()
        .map(|(id, m)| ((*id).to_string(), m.clone()))
        .collect();
    let load = move |name: &str| {
        Ok(meshes
            .iter()
            .find(|(id, _)| id == name)
            .map(|(_, m)| m.clone())
            .unwrap())
    };
    let run = common::run_request(&req, &load).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

fn num(line: &str, axis: char) -> Option<f64> {
    line.split(';')
        .next()?
        .split_whitespace()
        .find_map(|w| w.strip_prefix(axis).and_then(|v| v.parse().ok()))
}

/// The extruding ironing segments of the layer at `z`, as `[x0, y0, x1, y1]`.
fn ironing_at(g: &str, z: f64) -> Vec<[f64; 4]> {
    let (mut at, mut top, mut on) = ([0.0, 0.0], 0.0, false);
    let mut out = Vec::new();
    for line in g.lines() {
        if let Some(f) = line.strip_prefix(";TYPE:") {
            on = f.trim() == "Ironing";
        } else if let Some(v) = line
            .strip_prefix(";Z:")
            .and_then(|v| v.trim().parse::<f64>().ok())
        {
            top = v;
        } else if line.starts_with("G0 ") || line.starts_with("G1 ") {
            let to = [num(line, 'X').unwrap_or(at[0]), num(line, 'Y').unwrap_or(at[1])];
            if on && (top - z).abs() < 1e-6 && num(line, 'E').is_some_and(|e| e > 0.0) {
                out.push([at[0], at[1], to[0], to[1]]);
            }
            at = to;
        }
    }
    out
}

/// The extents `[x0, y0, x1, y1]` of the segments of `segs` whose middle lies in x `lo..hi`.
fn extents(segs: &[[f64; 4]], lo: f64, hi: f64) -> [f64; 4] {
    segs.iter()
        .filter(|s| (lo..hi).contains(&f64::midpoint(s[0], s[2])))
        .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |e, s| {
            [
                e[0].min(s[0]).min(s[2]),
                e[1].min(s[1]).min(s[3]),
                e[2].max(s[0]).max(s[2]),
                e[3].max(s[1]).max(s[3]),
            ]
        })
}

/// How far `e` stays inside the box `b` on its nearest side.
fn margin(e: [f64; 4], b: [f64; 4]) -> f64 {
    (e[0] - b[0]).min(e[1] - b[1]).min(b[2] - e[2]).min(b[3] - e[3])
}

/// A 12 x 20 box `h` mm tall at x `x0`, y 100.
fn boxed(name: &str, x0: f32, h: f32) -> Arc<Mesh> {
    mesh(name, vec![cuboid(name, [x0, 100.0, 0.0], [x0 + 12.0, 120.0, h])])
}

#[test]
fn a_layer_with_no_sparse_infill_irons_out_to_its_outline() {
    let g = run(&[("a", boxed("a", 110.0, 3.0))], &json!({}));
    let outline = [110.0, 100.0, 122.0, 120.0];
    // A bottom shell layer and a top shell layer under the top surface: all solid, ironed over the walls.
    for z in [0.4, 2.6] {
        let m = margin(extents(&ironing_at(&g, z), 0.0, 300.0), outline);
        assert!((0.15..0.3).contains(&m), "z {z}: {m}");
    }
    // An inset keeps its edge.
    let g = run(&[("a", boxed("a", 110.0, 3.0))], &json!({"ironing_inset": 0.6}));
    let m = margin(extents(&ironing_at(&g, 0.4), 0.0, 300.0), outline);
    assert!((0.55..0.7).contains(&m), "{m}");
}

#[test]
fn each_object_decides_for_itself_and_one_object_for_all_its_islands() {
    let low = [110.0, 100.0, 122.0, 120.0];
    // Separate objects: at z 2.6 the low one is all solid (its top shells) and irons out to its outline while the
    // tall one prints sparse infill.
    let g = run(
        &[
            ("low", boxed("low", 110.0, 3.0)),
            ("tall", boxed("tall", 128.0, 6.0)),
        ],
        &json!({}),
    );
    let segs = ironing_at(&g, 2.6);
    let m = margin(extents(&segs, 0.0, 125.0), low);
    assert!((0.15..0.3).contains(&m), "{m}");
    assert!(segs.iter().all(|s| s[0] < 125.0 && s[2] < 125.0));
    // The same boxes as one object: its layer has sparse infill, so the low island irons only its fill, inside the
    // walls.
    let one = mesh(
        "one",
        vec![
            cuboid("low", [110.0, 100.0, 0.0], [122.0, 120.0, 3.0]),
            cuboid("tall", [128.0, 100.0, 0.0], [140.0, 120.0, 6.0]),
        ],
    );
    let g = run(&[("one", one)], &json!({}));
    let m = margin(extents(&ironing_at(&g, 2.6), 0.0, 125.0), low);
    assert!(m > 0.6, "{m}");
}

/// Ironing length of the segments `segs`, and the part of it at x below `x`.
fn length_left_of(segs: &[[f64; 4]], x: f64) -> (f64, f64) {
    segs.iter().fold((0.0, 0.0), |(all, left), s| {
        let (dx, dy) = (s[2] - s[0], s[3] - s[1]);
        let l = (dx * dx + dy * dy).sqrt();
        let (lo, hi) = (s[0].min(s[2]), s[0].max(s[2]));
        let part = if hi <= x {
            l
        } else if lo >= x {
            0.0
        } else {
            l * (x - lo) / (hi - lo)
        };
        (all + l, left + part)
    })
}

/// An L block 30 x 20 mm at x 110, y 100: 6 mm tall left of x 125, 3 mm tall right of it.
fn l_block() -> Arc<Mesh> {
    mesh(
        "l",
        vec![
            cuboid("tall", [110.0, 100.0, 0.0], [125.0, 120.0, 6.0]),
            cuboid("low", [124.0, 100.0, 0.0], [140.0, 120.0, 3.0]),
        ],
    )
}

#[test]
fn solid_ironing_at_a_step_irons_the_top_surface_as_top_ironing_does() {
    // z 3.0 is the low half's top surface; the tall half rises off it at x 125 and its walls stand on that surface.
    // Lines and links that end on the step face itself land a few thousandths of a millimeter short of x 125, so a
    // strip under the walls is anything left of x 124.9.
    for walls in [3, 5] {
        for generator in ["classic", "aegis"] {
            let extra =
                |kind: &str| json!({"ironing_type": kind, "wall_loops": walls, "wall_generator": generator});
            let top = length_left_of(&ironing_at(&run(&[("l", l_block())], &extra("top")), 3.0), 124.9);
            let solid = length_left_of(
                &ironing_at(&run(&[("l", l_block())], &extra("solid")), 3.0),
                124.9,
            );
            let case = format!("{walls} walls, {generator}: solid {solid:?}, top {top:?}");
            assert!(top.0 > 0.0 && top.1 < 1e-6, "{case}");
            assert!((solid.0 - top.0).abs() <= top.0 * 0.005, "{case}");
            assert!(solid.1 < 1e-6, "{case}");
        }
    }
}
