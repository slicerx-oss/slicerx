// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A part's tree support is the same wherever the part stands on the plate: the same part sliced alone at two
//! places, or as several copies on one plate, prints on every layer the same support, moved by the distance
//! between the places.
//!
//! The support is compared as shapes, not move by move: where a support loop starts, and where it leaves the
//! gap that ends it, may fall at another point of the same loop without changing what prints. So each loop's gap is
//! closed first, then each layer's paths are sampled every 0.05 mm; every sample of one must lie within
//! [`SHAPE_MM`] of the other's paths moved back, and the other way round, and the layer's path lengths (gaps left
//! open) must agree within [`LENGTH_MM`].
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
use sx_core::api::{Mesh, SliceRequest};

/// How far a sampled support point may be from the other slice's support, mm. G-code writes 3 decimals, so each
/// end of a move is rounded by up to 0.0005 mm per axis; two slices of the same paths moved by an uneven amount
/// round differently, which puts a sample up to about 0.0015 mm off. 0.01 mm leaves room for that, and for
/// nothing a support line (0.4 mm wide) would show.
const SHAPE_MM: f64 = 0.01;
/// The longest gap a support loop leaves where it ends, mm: about a line width or two.
const GAP_MM: f64 = 1.0;
/// How far a layer's support path lengths may differ, mm: the same rounding, summed over a few hundred moves.
const LENGTH_MM: f64 = 0.05;

/// Slices `objects` (an id and the place of its origin each, all of `mesh`) with tree support and object labels.
fn slice(mesh: &Mesh, objects: &[(&str, [f32; 2])]) -> String {
    let list: Vec<(&str, &Mesh, [f32; 2])> = objects.iter().map(|(id, at)| (*id, mesh, *at)).collect();
    slice_each(&list)
}

/// Slices `objects` (an id, a mesh and the place of its origin each) with tree support and object labels.
fn slice_each(objects: &[(&str, &Mesh, [f32; 2])]) -> String {
    let list: Vec<Value> = objects
        .iter()
        .map(|(id, _, at)| {
            json!({"id": id, "name": id, "mesh": id,
                "transform": [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  at[0], at[1], 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": list},
        "config": {
            "enable_support": true, "support_type": "tree(auto)", "support_style": "default",
            "brim_width": 0, "brim_type": "no_brim", "skirt_loops": 0, "enable_arc_fitting": false,
            "gcode_label_objects": true, "layer_height": 0.2, "initial_layer_print_height": 0.2,
        },
        "options": {"allowCollisions": true},
    }))
    .unwrap();
    let meshes: Vec<(String, Arc<Mesh>)> = objects
        .iter()
        .map(|(id, m, _)| ((*id).to_owned(), Arc::new((*m).clone())))
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

fn mm(p: [f32; 2]) -> [f64; 2] {
    [f64::from(p[0]), f64::from(p[1])]
}

fn length(layers: &[(f32, SupportSegs)]) -> f64 {
    layers.iter().map(|(_, s)| layer_length(s)).sum()
}

fn layer_length(segs: &SupportSegs) -> f64 {
    segs.iter()
        .map(|(_, a, b)| {
            let (a, b) = (mm(*a), mm(*b));
            (b[0] - a[0]).hypot(b[1] - a[1])
        })
        .sum()
}

/// Distance from `p` to the segment `a`-`b`, mm.
fn to_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let d = [b[0] - a[0], b[1] - a[1]];
    let l = d[0] * d[0] + d[1] * d[1];
    let t = if l == 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l).clamp(0.0, 1.0)
    };
    (p[0] - a[0] - t * d[0]).hypot(p[1] - a[1] - t * d[1])
}

/// The farthest a sample of `from` lies from `to` moved by `-shift`, mm, and where.
fn farthest(from: &SupportSegs, to: &SupportSegs, shift: [f64; 2]) -> (f64, [f64; 2]) {
    let back: Vec<([f64; 2], [f64; 2])> = to
        .iter()
        .map(|(_, a, b)| {
            let (a, b) = (mm(*a), mm(*b));
            (
                [a[0] - shift[0], a[1] - shift[1]],
                [b[0] - shift[0], b[1] - shift[1]],
            )
        })
        .collect();
    // The segments by the cells of a 0.5 mm grid their boxes touch, so a sample looks only at those near it.
    const CELL: f64 = 0.5;
    let cell = |v: f64| (v / CELL).floor() as i64;
    let mut grid: std::collections::HashMap<(i64, i64), Vec<usize>> = std::collections::HashMap::new();
    for (k, (u, v)) in back.iter().enumerate() {
        for x in cell(u[0].min(v[0]))..=cell(u[0].max(v[0])) {
            for y in cell(u[1].min(v[1]))..=cell(u[1].max(v[1])) {
                grid.entry((x, y)).or_default().push(k);
            }
        }
    }
    let nearest = |p: [f64; 2]| {
        let (cx, cy) = (cell(p[0]), cell(p[1]));
        let near = (cx - 1..=cx + 1)
            .flat_map(|x| (cy - 1..=cy + 1).map(move |y| (x, y)))
            .filter_map(|c| grid.get(&c))
            .flatten()
            .map(|&k| to_segment(p, back[k].0, back[k].1))
            .fold(f64::INFINITY, f64::min);
        if near <= CELL {
            near
        } else {
            back.iter()
                .map(|(u, v)| to_segment(p, *u, *v))
                .fold(f64::INFINITY, f64::min)
        }
    };
    let mut worst = (0.0, [0.0, 0.0]);
    for (_, a, b) in from {
        let (a, b) = (mm(*a), mm(*b));
        let n = ((b[0] - a[0]).hypot(b[1] - a[1]) / 0.05).ceil().max(1.0) as usize;
        for k in 0..=n {
            let t = k as f64 / n as f64;
            let p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
            let d = nearest(p);
            if d > worst.0 {
                worst = (d, p);
            }
        }
    }
    worst
}

/// The segments of a layer with each loop's gap closed: a run of joined moves that ends within [`GAP_MM`] of where
/// it starts gets the move back to its start. A loop that starts at another point of itself leaves its gap there,
/// and the closed loops are the same.
fn closed(segs: &SupportSegs) -> SupportSegs {
    let mut out = segs.clone();
    let mut start = 0;
    for k in 0..segs.len() {
        let ends_run = segs.get(k + 1).is_none_or(|next| next.1 != segs[k].2);
        if ends_run {
            let (first, last) = (mm(segs[start].1), mm(segs[k].2));
            let gap = (last[0] - first[0]).hypot(last[1] - first[1]);
            if k > start && gap > 0.0 && gap <= GAP_MM {
                out.push((segs[k].0, segs[k].2, segs[start].1));
            }
            start = k + 1;
        }
    }
    out
}

/// Every layer where `there` (support at a place `shift` from `here`'s) differs from `here` past the tolerances.
fn differences(here: &[(f32, SupportSegs)], there: &[(f32, SupportSegs)], shift: [f64; 2]) -> Vec<String> {
    let mut bad = Vec::new();
    if here.len() != there.len() {
        bad.push(format!("{} support layers against {}", here.len(), there.len()));
    }
    for ((z, a), (_, b)) in here.iter().zip(there) {
        let (la, lb) = (layer_length(a), layer_length(b));
        let (a, b) = (closed(a), closed(b));
        let (d1, p1) = farthest(&a, &b, shift);
        let (d2, p2) = farthest(&b, &a, [-shift[0], -shift[1]]);
        if (la - lb).abs() > LENGTH_MM || d1 > SHAPE_MM || d2 > SHAPE_MM {
            bad.push(format!(
                "z {z}: {la:.3} against {lb:.3} mm, {d1:.3} mm off at {p1:.2?}, {d2:.3} mm off at {p2:.2?}"
            ));
        }
    }
    bad
}

fn report(what: &str, layers: usize, bad: &[String]) {
    assert!(
        bad.is_empty(),
        "{what}: support differs on {} of {layers} layers: {}",
        bad.len(),
        bad.iter().take(5).cloned().collect::<Vec<_>>().join("; ")
    );
}

/// A round cap on a stem, the cap's underside held up by tree support: its outlines are curves, so each place
/// rounds them its own way unless the part is placed exactly.
fn part() -> Mesh {
    let mut m = models::mushroom();
    m.name = "part".into();
    m
}

fn shift(from: [f32; 2], to: [f32; 2]) -> [f64; 2] {
    let (a, b) = (mm(from), mm(to));
    [b[0] - a[0], b[1] - a[1]]
}

#[test]
fn a_parts_support_is_the_same_wherever_it_stands_on_the_plate() {
    let m = part();
    // The second place is moved by an uneven amount on both axes, so no grid lines up with both.
    let places: [[f32; 2]; 2] = [[100.0, 100.0], [131.37, 117.83]];
    let here = models::support_moves(&slice(&m, &[("part", places[0])]));
    let there = models::support_moves(&slice(&m, &[("part", places[1])]));
    assert!(length(&here) > 100.0, "the part prints support");
    let d = differences(&here, &there, shift(places[0], places[1]));
    report("one part at two places", here.len(), &d);
}

#[test]
fn copies_of_a_part_on_one_plate_all_get_the_same_support() {
    let m = part();
    // Eight copies 58 to 62 mm apart (the cap is 40 mm across), each moved by an uneven amount.
    let places: Vec<(String, [f32; 2])> = (0..8u8)
        .map(|k| {
            let (i, j) = (f32::from(k % 4), f32::from(k / 4));
            (format!("copy{k}"), [33.71 + 61.37 * i, 64.29 + 58.83 * j])
        })
        .collect();
    let objects: Vec<(&str, [f32; 2])> = places.iter().map(|(n, at)| (n.as_str(), *at)).collect();
    let g = slice(&m, &objects);
    let first = models::object_support_moves(&g, Some("copy0"));
    assert!(length(&first) > 100.0, "the first copy prints support");
    let mut bad = Vec::new();
    for (name, at) in places.iter().skip(1) {
        let other = models::object_support_moves(&g, Some(name));
        let d = differences(&first, &other, shift(places[0].1, *at));
        if let Some(one) = d.first() {
            bad.push(format!("{name} on {} layers, first {one}", d.len()));
        }
    }
    report("eight copies", first.len(), &bad);
}

/// A 10 mm column with an arm 3 mm thick reaching `reach` mm along x from it (toward -x when negative), 15 mm up.
fn arm(reach: f32) -> Mesh {
    let (lo, hi) = if reach > 0.0 {
        (5.0, 5.0 + reach)
    } else {
        (-5.0 + reach, -5.0)
    };
    Mesh {
        name: "arm".into(),
        parts: vec![
            models::cuboid("column", [-5.0, -5.0, 0.0], [5.0, 5.0, 18.0]),
            models::cuboid("arm", [lo, -5.0, 15.0], [hi, 5.0, 18.0]),
        ],
        ..Mesh::default()
    }
}

/// Two objects whose arms reach toward each other and end 1 mm apart, so their support meets under the gap: where
/// it meets, its lines run on one lattice, never two lattices across each other or side by side.
#[test]
fn where_two_objects_supports_meet_their_lines_do_not_cross() {
    let (a, b) = (arm(14.5), arm(-14.5));
    let g = slice_each(&[("left", &a, [100.13, 100.0]), ("right", &b, [140.13, 100.0])]);
    let all = models::support_moves(&g);
    let (_, first) = all.first().expect("the plate prints support");
    // The meeting place: 1 mm either side of the gap between the arms' tips (x 119.63 to 120.63).
    let near = |x: f32| (118.63..=121.63).contains(&x);
    let lines: Vec<([f64; 2], [f64; 2])> = first
        .iter()
        .filter(|(_, a, b)| near(a[0]) && near(b[0]))
        .map(|(_, a, b)| (mm(*a), mm(*b)))
        .filter(|(a, b)| (b[0] - a[0]).hypot(b[1] - a[1]) > 1.0)
        .collect();
    assert!(
        lines.len() >= 3,
        "{} support lines where the supports meet",
        lines.len()
    );
    // Any two straight lines there that run side by side are the same line or a whole line apart, and none
    // crosses another at an angle.
    for (i, (a, b)) in lines.iter().enumerate() {
        let d = [b[0] - a[0], b[1] - a[1]];
        let l = d[0].hypot(d[1]);
        let (u, n) = ([d[0] / l, d[1] / l], [-d[1] / l, d[0] / l]);
        for (c, e) in lines.iter().skip(i + 1) {
            let f = [e[0] - c[0], e[1] - c[1]];
            let cross = (u[0] * f[1] - u[1] * f[0]).abs() / f[0].hypot(f[1]);
            let along = |p: [f64; 2]| (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
            let (s0, s1) = (along(*c).min(along(*e)), along(*c).max(along(*e)));
            if s1 < 0.0 || s0 > l {
                continue;
            }
            if cross > 0.05 {
                // Lines at an angle to each other may meet at an end (a line joined to the next), never cross.
                let orient = |p: [f64; 2], q: [f64; 2], r: [f64; 2]| {
                    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
                };
                let apart = |x: f64, y: f64| x * y < -1e-6;
                assert!(
                    !(apart(orient(*a, *b, *c), orient(*a, *b, *e))
                        && apart(orient(*c, *e, *a), orient(*c, *e, *b))),
                    "support lines {a:.2?}-{b:.2?} and {c:.2?}-{e:.2?} cross where the supports meet"
                );
                continue;
            }
            let gap = ((c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1]).abs();
            assert!(
                gap < 0.02 || gap > 0.3,
                "support lines {a:.2?}-{b:.2?} and {c:.2?}-{e:.2?} run {gap:.3} mm apart where the supports meet"
            );
        }
    }
}
