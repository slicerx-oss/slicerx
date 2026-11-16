// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Organic tree support planned object by object (`organic_per_object`): a part's tree support is the same wherever
//! the part stands on the plate and whatever stands beside it, except where its support would reach into a
//! neighbor.
//!
//! - Copies: the same part as eight copies on one plate prints on every layer the same support, moved by the
//!   distance between the copies.
//! - Neighbors: two different parts close together each print the support they print alone, so no branch of one
//!   joins a branch of the other.
//! - Reach: support that would grow into another object is cut back to `support_object_xy_distance` from that
//!   object's outline on every layer, so copies with a neighbor in reach can differ from the rest.
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
use sx_core::api::{Mesh, SliceRequest, SliceRun};
use sx_core::collide::Severity;

/// How far a sampled support point may be from the other slice's support, mm. G-code writes 3 decimals, so each
/// end of a move is rounded by up to 0.0005 mm per axis; two slices of the same paths moved by an uneven amount
/// round differently, which puts a sample up to about 0.0015 mm off. 0.01 mm leaves room for that, and for
/// nothing a support line (0.4 mm wide) would show.
const SHAPE_MM: f64 = 0.01;
/// The longest gap a support loop leaves where it ends, mm: about a line width or two.
const GAP_MM: f64 = 1.0;
/// How far a layer's support path lengths may differ, mm: the same rounding, summed over a few hundred moves.
const LENGTH_MM: f64 = 0.05;

/// Slices `objects` (an id and the place of its origin each, all of `mesh`) with tree support and object labels,
/// and the settings of `extra` over the test's own.
fn slice(mesh: &Mesh, objects: &[(&str, [f32; 2])], extra: &Value) -> String {
    let list: Vec<(&str, &Mesh, [f32; 2])> = objects.iter().map(|(id, at)| (*id, mesh, *at)).collect();
    slice_each(&list, extra)
}

/// Slices `objects` (an id, a mesh and the place of its origin each) with tree support planned per object and
/// object labels, and the settings of `extra` over the test's own.
fn slice_each(objects: &[(&str, &Mesh, [f32; 2])], extra: &Value) -> String {
    String::from_utf8(run_each(objects, extra, &json!({"allowCollisions": true})).gcode).unwrap()
}

/// [`slice_each`] with the request options `options`: the whole run, G-code and the plate check's report.
fn run_each(objects: &[(&str, &Mesh, [f32; 2])], extra: &Value, options: &Value) -> SliceRun {
    let list: Vec<Value> = objects
        .iter()
        .map(|(id, _, at)| {
            json!({"id": id, "name": id, "mesh": id,
                "transform": [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  at[0], at[1], 0, 1]})
        })
        .collect();
    let mut config = json!({
        "enable_support": true, "support_type": "tree(auto)", "support_style": "default",
        "organic_per_object": true,
        "brim_width": 0, "brim_type": "no_brim", "skirt_loops": 0, "enable_arc_fitting": false,
        "gcode_label_objects": true, "layer_height": 0.2, "initial_layer_print_height": 0.2,
    });
    if let (Some(dst), Some(src)) = (config.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": list},
        "config": config,
        "options": options,
    }))
    .unwrap();
    let meshes: Vec<(String, Arc<Mesh>)> = objects
        .iter()
        .map(|(id, m, _)| ((*id).to_owned(), Arc::new((*m).clone())))
        .collect();
    common::run_request(&req, &move |id: &str| {
        Ok(meshes
            .iter()
            .find(|(n, _)| n == id)
            .map(|(_, m)| m.clone())
            .unwrap())
    })
    .unwrap()
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
    let g = slice(&m, &objects, &json!({}));
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
    let none = json!({});
    let plate = slice_each(&[("left", &left, at_left), ("right", &right, at_right)], &none);
    let alone = [
        models::support_moves(&slice_each(&[("left", &left, at_left)], &none)),
        models::support_moves(&slice_each(&[("right", &right, at_right)], &none)),
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

/// How far past the bed's edge a support move may end, mm: G-code writes 3 decimals.
const BED_MM: f64 = 0.001;

#[test]
fn a_copy_at_the_bed_edge_keeps_its_support_on_the_bed() {
    // Two copies of the capped stem on a 256 mm bed: one in the middle, one with its 40 mm cap 1 mm from the left
    // edge. The first layer of support grows 4 mm round its trunks, past the cap's edge. The copy reuses the first
    // one's plan, made away from any edge, so moved as it is its first layer would print off the bed (and the plate
    // would be refused for it).
    let m = part();
    let bed = [0.0, 0.0, 256.0, 256.0];
    let g = slice(
        &m,
        &[("middle", [128.0, 128.0]), ("edge", [21.0, 128.0])],
        &json!({"printable_area": ["0x0", "256x0", "256x256", "0x256"], "raft_first_layer_expansion": 4}),
    );
    let edge = models::object_support_moves(&g, Some("edge"));
    assert!(length(&edge) > 100.0, "the copy at the edge prints support");
    let mut off: Vec<String> = Vec::new();
    for (z, segs) in models::support_moves(&g) {
        for (_, a, b) in segs {
            for p in [mm(a), mm(b)] {
                if p[0] < bed[0] - BED_MM
                    || p[1] < bed[1] - BED_MM
                    || p[0] > bed[2] + BED_MM
                    || p[1] > bed[3] + BED_MM
                {
                    off.push(format!("z {z} at {p:.3?}"));
                }
            }
        }
    }
    assert!(
        off.is_empty(),
        "{} support move ends lie off the bed: {}",
        off.len(),
        off.iter().take(5).cloned().collect::<Vec<_>>().join("; ")
    );
}

/// A 10 x 10 mm body 30 mm tall whose +X face leans out 12 mm over its height (68 degrees from the bed, which
/// needs no support), and a 13 mm arm at 10 mm on its -X side, held up by tree support.
fn leaning() -> Mesh {
    Mesh {
        name: "leaning".into(),
        parts: vec![
            models::prism_xz(
                "body",
                &[[-5.0, 0.0], [5.0, 0.0], [17.0, 30.0], [-5.0, 30.0]],
                -5.0,
                5.0,
            ),
            models::cuboid("arm", [-18.0, -5.0, 10.0], [-5.0, 5.0, 13.0]),
        ],
        ..Mesh::default()
    }
}

#[test]
fn support_of_close_copies_carries_each_copys_own_label() {
    // Two copies 32 mm apart along X: the second's arm points at the first's leaning face, so the first layer of
    // the second's support (grown 4 mm round its trunks) reaches under the top of the first, where nothing of the
    // second stands above it. That support is still the second's: skipping one object must leave the other's
    // support whole.
    let m = leaning();
    let places = [("first", [68.0f32, 128.0f32]), ("second", [100.0, 128.0])];
    let g = slice(&m, &places, &json!({"raft_first_layer_expansion": 4}));
    let first = models::object_support_moves(&g, Some("first"));
    let second = models::object_support_moves(&g, Some("second"));
    assert!(length(&first) > 100.0, "the first copy prints support");
    report(
        "two close copies by their labels",
        first.len(),
        &differences(&first, &second, shift(places[0].1, places[1].1)),
    );
}

/// One extruding move: the object printing it, its `;TYPE:` and its ends.
type Move = (String, String, [f64; 2], [f64; 2]);

/// The extruding moves of a G-code file labeled by object, per layer (print Z).
fn labeled_moves(gcode: &str) -> Vec<(f32, Vec<Move>)> {
    let mut layers: Vec<(f32, Vec<Move>)> = Vec::new();
    let (mut object, mut kind) = (String::new(), String::new());
    let (mut pos, mut z, mut relative_e, mut last_e) = ([0.0f64; 2], 0.0f32, false, 0.0f64);
    for line in gcode.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("; printing object ") {
            rest.split(" id:").next().unwrap_or("").clone_into(&mut object);
            continue;
        }
        if line.starts_with("; stop printing object ") {
            object.clear();
            continue;
        }
        if let Some(t) = line.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
            continue;
        }
        if let Some(v) = line.strip_prefix(";Z:") {
            if let Ok(nz) = v.trim().parse::<f32>() {
                z = nz;
            }
            continue;
        }
        if line.starts_with("M83") {
            relative_e = true;
        }
        if line.starts_with("M82") {
            relative_e = false;
        }
        let code = line.split(';').next().unwrap_or("").trim();
        if !(code.starts_with("G1 ") || code.starts_with("G0 ")) {
            continue;
        }
        let mut next = pos;
        let mut e: Option<f64> = None;
        for w in code.split_whitespace().skip(1) {
            let (k, v) = w.split_at(1);
            let Ok(v) = v.parse::<f64>() else { continue };
            match k {
                "X" => next[0] = v,
                "Y" => next[1] = v,
                "E" => e = Some(v),
                _ => {}
            }
        }
        let extrudes = match e {
            Some(v) if relative_e => v > 0.0,
            Some(v) => {
                let d = v - last_e;
                last_e = v;
                d > 0.0
            }
            None => false,
        };
        if extrudes && next != pos && !object.is_empty() {
            if layers.last().is_none_or(|(lz, _)| (lz - z).abs() > 1e-4) {
                layers.push((z, Vec::new()));
            }
            if let Some((_, moves)) = layers.last_mut() {
                moves.push((object.clone(), kind.clone(), pos, next));
            }
        }
        pos = next;
    }
    layers
}

/// Whether the segments `p`-`q` and `r`-`s` cross (touching ends do not count).
fn crosses(p: [f64; 2], q: [f64; 2], r: [f64; 2], s: [f64; 2]) -> bool {
    let side =
        |a: [f64; 2], b: [f64; 2], c: [f64; 2]| (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    side(p, q, r) * side(p, q, s) < 0.0 && side(r, s, p) * side(r, s, q) < 0.0
}

/// Whether `p` lies inside the loops `walls` draw (even-odd; each loop's gap closed by [`closed_loops`]).
fn inside(p: [f64; 2], walls: &[([f64; 2], [f64; 2])]) -> bool {
    let mut odd = false;
    for (a, b) in walls {
        if (a[1] > p[1]) != (b[1] > p[1]) {
            let x = a[0] + (p[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
            if x > p[0] {
                odd = !odd;
            }
        }
    }
    odd
}

/// `segs` with each run of joined moves that ends within [`GAP_MM`] of its start closed back to it.
fn closed_loops(segs: &[([f64; 2], [f64; 2])]) -> Vec<([f64; 2], [f64; 2])> {
    let mut out = segs.to_vec();
    let mut start = 0;
    for k in 0..segs.len() {
        if segs.get(k + 1).is_none_or(|next| next.0 != segs[k].1) {
            let (first, last) = (segs[start].0, segs[k].1);
            let gap = (last[0] - first[0]).hypot(last[1] - first[1]);
            if k > start && gap > 0.0 && gap <= GAP_MM {
                out.push((last, first));
            }
            start = k + 1;
        }
    }
    out
}

/// A tall column with an arm on one side and a low foot on the other: a 10 x 10 mm column 30 mm tall, an arm 20 mm
/// long toward -Y with its underside at 20 mm (held up by tree support), and a foot 10 mm long toward +Y, 5 mm tall.
fn arm_and_foot() -> Mesh {
    Mesh {
        name: "arm and foot".into(),
        parts: vec![
            models::cuboid("column", [-5.0, -5.0, 0.0], [5.0, 5.0, 30.0]),
            models::cuboid("arm", [-5.0, -25.0, 20.0], [5.0, -5.0, 23.0]),
            models::cuboid("foot", [-5.0, 5.0, 0.0], [5.0, 15.0, 5.0]),
        ],
        ..Mesh::default()
    }
}

/// How much closer than `support_object_xy_distance` a support line may come to another object's outline, mm:
/// G-code writes 3 decimals, so each end of both moves is up to 0.0005 mm off per axis, about 0.0015 mm in all.
/// The outline is taken as the other object's outer wall line grown by half the outer wall width.
const NEIGHBOR_MM: f64 = 0.01;

/// The first layer's support moves that cross a move of another object.
fn first_layer_crossings(layers: &[(f32, Vec<Move>)]) -> Vec<String> {
    let mut crossing = Vec::new();
    if let Some((z, moves)) = layers.first() {
        for (o, k, a, b) in moves.iter().filter(|m| m.1.starts_with("Support")) {
            for (p, kp, c, d) in moves.iter().filter(|m| m.0 != *o && !m.1.starts_with("Support")) {
                if crosses(*a, *b, *c, *d) {
                    crossing.push(format!("z {z}: {o} {k} at {a:.2?} crosses {p} {kp} at {c:.2?}"));
                }
            }
        }
    }
    crossing
}

/// On every layer, each object of `names` whose support, sampled every 0.05 mm, comes inside another object's
/// outer wall loops or within `xy` (less [`NEIGHBOR_MM`]) of its outline: that wall line grown by `wall / 2`.
fn too_close(layers: &[(f32, Vec<Move>)], names: &[&str], xy: f64, wall: f64) -> Vec<String> {
    let mut near = Vec::new();
    for (z, moves) in layers {
        for own in names {
            let support: Vec<([f64; 2], [f64; 2])> = moves
                .iter()
                .filter(|m| m.0 == *own && m.1.starts_with("Support"))
                .map(|m| (m.2, m.3))
                .collect();
            for other in names.iter().filter(|n| *n != own) {
                let walls: Vec<([f64; 2], [f64; 2])> = moves
                    .iter()
                    .filter(|m| m.0 == *other && m.1 == "Outer wall")
                    .map(|m| (m.2, m.3))
                    .collect();
                if walls.is_empty() {
                    continue;
                }
                let loops = closed_loops(&walls);
                let mut worst: Option<(f64, [f64; 2])> = None;
                for (a, b) in &support {
                    let n = ((b[0] - a[0]).hypot(b[1] - a[1]) / 0.05).ceil().max(1.0) as usize;
                    for k in 0..=n {
                        let t = k as f64 / n as f64;
                        let p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
                        let to_wall = loops
                            .iter()
                            .map(|(u, v)| to_segment(p, *u, *v))
                            .fold(f64::INFINITY, f64::min);
                        let past = if inside(p, &loops) {
                            -to_wall - wall / 2.0
                        } else {
                            to_wall - wall / 2.0
                        };
                        if past < xy - NEIGHBOR_MM && worst.is_none_or(|w| past < w.0) {
                            worst = Some((past, p));
                        }
                    }
                }
                if let Some((d, p)) = worst {
                    near.push(format!(
                        "z {z}: {own} support {d:.3} mm past the outline of {other} at {p:.2?}"
                    ));
                }
            }
        }
    }
    near
}

#[test]
fn support_of_a_copy_stays_clear_of_its_neighbors() {
    // Four copies in two rows 32 mm apart, the copies of a row 40 mm apart. A copy in the back row holds its arm
    // out over the foot of the copy in front of it, so planned on its own its trunks would grow down through that
    // foot and print across its walls from the first layer. Each copy keeps `support_object_xy_distance` from its
    // neighbors' outlines instead, on every layer.
    let m = arm_and_foot();
    let (xy, wall) = (0.35, 0.42);
    let places = [
        ("front0", [100.0f32, 80.0f32]),
        ("front1", [140.0, 80.0]),
        ("back0", [100.0, 112.0]),
        ("back1", [140.0, 112.0]),
    ];
    let list: Vec<(&str, &Mesh, [f32; 2])> = places.iter().map(|(n, at)| (*n, &m, *at)).collect();
    let run = run_each(
        &list,
        &json!({
            "support_object_xy_distance": xy, "outer_wall_line_width": wall, "initial_layer_line_width": wall,
            "support_line_width": wall,
        }),
        &json!({}),
    );
    let hits: Vec<String> = run
        .report
        .collisions
        .iter()
        .filter(|c| c.severity == Severity::Hit)
        .map(|c| {
            format!(
                "{:?} {} and {} on layer {}",
                c.kind,
                c.object_id,
                c.hit_id,
                c.layer + 1
            )
        })
        .collect();
    assert!(
        hits.is_empty(),
        "the plate check refuses the plate: {}",
        hits.join("; ")
    );
    let g = String::from_utf8(run.gcode).unwrap();
    let back = models::object_support_moves(&g, Some("back0"));
    assert!(length(&back) > 100.0, "a back copy prints support");
    let layers = labeled_moves(&g);
    // The first layer: no support move crosses a move of another object.
    let crossing = first_layer_crossings(&layers);
    assert!(
        crossing.is_empty(),
        "{} first layer crossings: {}",
        crossing.len(),
        crossing.iter().take(5).cloned().collect::<Vec<_>>().join("; ")
    );
    // Every layer: each support line stays outside every other object's outer wall loops and at least
    // `support_object_xy_distance` past their outline.
    let names: Vec<&str> = places.iter().map(|(n, _)| *n).collect();
    let near = too_close(&layers, &names, xy, wall);
    assert!(
        near.is_empty(),
        "support comes within {xy} mm of another object on {} object pairs and layers: {}",
        near.len(),
        near.iter().take(6).cloned().collect::<Vec<_>>().join("; ")
    );
    // Copies with no neighbor in reach of their support print the same support: the front row holds its arms out
    // over open bed. The two back copies each stand behind a neighbor at the same place, so each is cut the same
    // way and they match each other too.
    for (a, b) in [(0, 1), (2, 3)] {
        let (na, nb) = (places[a].0, places[b].0);
        let here = models::object_support_moves(&g, Some(na));
        let there = models::object_support_moves(&g, Some(nb));
        assert!(length(&here) > 100.0, "{na} prints support");
        report(
            &format!("{na} against {nb}"),
            here.len(),
            &differences(&here, &there, shift(places[a].1, places[b].1)),
        );
    }
}
