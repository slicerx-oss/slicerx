// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Organic tree support planned object by object (`organic_per_object`): a part's tree support is the same wherever
//! the part stands on the plate and whatever stands beside it.
//!
//! - Copies: the same part as eight copies on one plate prints on every layer the same support, moved by the
//!   distance between the copies.
//! - Neighbors: two different parts close together each print the support they print alone, so no branch of one
//!   joins a branch of the other.
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
#![allow(clippy::many_single_char_names, reason = "vector math on points and segments")]
#![allow(
    clippy::float_cmp,
    reason = "a move that starts where the last one ended parses to the same values"
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

/// Slices `objects` (an id, a mesh and the place of its origin each) with tree support planned per object and
/// object labels.
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
            "organic_per_object": true,
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

/// The cell size of the grid [`farthest`] sorts segments by, mm: a sample looks only at the segments whose boxes
/// touch the cells near it.
const CELL: f64 = 0.5;

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

/// A 10 mm column with a 10 mm wide arm reaching `reach` mm along X (negative: toward -X) from its middle, its
/// underside at `under` mm and 3 mm thick.
fn shelf(name: &str, reach: f32, under: f32, height: f32) -> Mesh {
    let (x0, x1) = if reach > 0.0 { (-5.0, reach) } else { (reach, 5.0) };
    Mesh {
        name: name.into(),
        parts: vec![
            models::cuboid("column", [-5.0, -5.0, 0.0], [5.0, 5.0, height]),
            models::cuboid("arm", [x0, -5.0, under], [x1, 5.0, under + 3.0]),
        ],
        ..Mesh::default()
    }
}

/// Every layer's support of several slices put together, by print Z (the slices share their layer heights).
fn joined(parts: &[Vec<(f32, SupportSegs)>]) -> Vec<(f32, SupportSegs)> {
    let mut out: Vec<(f32, SupportSegs)> = Vec::new();
    for layers in parts {
        for (z, segs) in layers {
            match out.iter_mut().find(|(oz, _)| (oz - z).abs() < 1e-4) {
                Some((_, o)) => o.extend(segs.iter().copied()),
                None => out.push((*z, segs.clone())),
            }
        }
    }
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    out
}

#[test]
fn branches_of_two_parts_side_by_side_never_join() {
    // Two different shelves whose arms point at each other, their tips 3 mm apart: well within the reach of a
    // merge on a plate planned as one, so their branches would grow into shared trunks.
    let left = shelf("left", 18.0, 20.0, 30.0);
    let right = shelf("right", -18.0, 17.0, 25.0);
    let (at_left, at_right) = ([100.0, 100.0], [139.0, 100.0]);
    let plate = slice_each(&[("left", &left, at_left), ("right", &right, at_right)]);
    let alone = [
        models::support_moves(&slice_each(&[("left", &left, at_left)])),
        models::support_moves(&slice_each(&[("right", &right, at_right)])),
    ];
    for (name, layers) in ["left", "right"].iter().zip(&alone) {
        assert!(length(layers) > 100.0, "the {name} shelf prints support alone");
    }
    let apart = joined(&alone);
    let together = models::support_moves(&plate);
    report(
        "two shelves side by side against each alone",
        apart.len(),
        &differences(&apart, &together, [0.0, 0.0]),
    );
}
