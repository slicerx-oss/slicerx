// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The slit `only_one_wall_top` leaves, with classic walls and `ensure_vertical_shell_thickness` `ensure_all`, on the
//! stock P1S request (fixtures/surface-walls/p1s-x-mark.json: classic walls, two loops, 0.2 mm layers, 5 top and 3
//! bottom layers, 15% sparse and infill wall overlap), against measured targets. Where a layer's top area takes the
//! place of its inner walls along a step or a slope, those walls run inside the layer and leave a slit in its infill
//! area, and the vertical shell of the layers below reaches the slit's inner edge.
//!
//! - The ring: a 30 mm square box 2 mm tall under a centered 22 mm block to z 4, with 3 to 6 bottom shell layers. The
//!   ring's shell layers that have the block within their top shell count reach 1.30 mm past the block's outline, to
//!   the inner edge of the slit the ring's top layer leaves around the block. With 5 bottom shells the z 1.4 solid hangs
//!   past the z 1.2 solid over sparse infill far enough to bridge, z 1.6 over it is internal solid and z 1.8 floats
//!   (with zig-zag internal solid infill).
//!   The lowest shell layer keeps its edge 0.10 mm past the outline plus one line under the slit, and `partial`
//!   keeps every ring layer at the outline. With 3 bottom shells z 1.2 is one bridge, the line under the slit included.
//! - Stairs (a ledge topped at z 2.0, a step `d` mm wide topped at 2.2 and a block to z 4 beyond it): with 5 bottom
//!   shells the sliver between the ledge's solid and the line under the slit is a small sparse pocket, so z 1.2 is
//!   solid out to the slit, and z 1.4 bridges from d 1.26 and not up to 1.24. With 3 bottom shells it bridges from
//!   d 2.5 and not at 2.0.
//! - Tapers: the box under a frustum stepping in 0.75 mm per layer to 15 mm at z 4. On the stock settings the band
//!   under the slope widens to the slits and its lowest layer bridges; at 30% overlap the slit is too narrow to count
//!   and nothing changes; with MK4 widths (0.40 and 0.44 mm walls, 3 walls, 25%, 4 top layers) on a printer that is
//!   not a Bambu Lab one, the same solid and bridges print.
//! - The ring's shell layers over its z 1.2 bridge with 3 bottom shells (the stock request, `precise_outer_wall` off,
//!   with zig-zag internal solid infill), by infill wall overlap: up to 19% the slit counts, z 1.4 is internal solid
//!   and z 1.6 and 1.8 float, about 34.9 each on the W 4.0 ring. From 20% it does not count, the ring layers carry
//!   about 31.9 and the first of them, z 1.4, floats too: the bridge under it ends at the ring's edge, so the sparse
//!   infill past it comes within a sparse line.
//!   It stays internal solid with variable-width walls, with one wall and with three.
//! - Monotonic internal solid infill (the stock request's) over grid sparse infill: the ring's layers stacked on the
//!   ring layer below only border the sparse infill under the block, so they stay internal solid infill, and only a
//!   layer that lies over that sparse infill floats. The measured pattern grid decides which pairs of internal solid
//!   and sparse infill patterns do this.
//! - The widest ring whose z 1.6 and 1.8 float with zig-zag internal solid infill, by the slit: 4.5 mm where it counts
//!   (not 4.55); where it does not, 4.7 at 20% overlap (not 4.75) and 4.68 on 0.50 mm solid lines (not 4.7), and for
//!   narrower slits 4.95 at 30% (not 5.0) and 4.9 on 0.50 mm lines at 20% (not 5.0). With variable-width walls 4.9
//!   (not 4.95).
//! - The classic x-mark on the P1S and A1 prints gap fill only after a top surface (fixtures/classic-ring-shell: their
//!   stock settings with classic walls).
//!
//! Filament is E mm of 1.75 mm filament per feature per layer. Edges are where the solid infill stops along y 126 on
//! the ring's left side, read on a 0.05 mm grid.
#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates and filament lengths in mm"
)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

const REQUEST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/surface-walls/p1s-x-mark.json"
);
const SOLID: &str = "Internal solid infill";
const FLOATING: &str = "Floating vertical shell";
const BRIDGE: &str = "Bridge";
const GAP: &str = "Gap infill";
const SPARSE: &str = "Sparse infill";

/// The G-code of the stock P1S request with classic walls and `edits` to its config, printing `mesh` at the middle
/// of the bed.
fn slice(mesh: Arc<Mesh>, edits: &[(&str, Value)]) -> String {
    slice_from(REQUEST, mesh, edits)
}

/// The same from the request at `path`.
fn slice_from(path: &str, mesh: Arc<Mesh>, edits: &[(&str, Value)]) -> String {
    let mut req: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    req["config"]["wall_generator"] = json!("classic");
    for (k, v) in edits {
        req["config"][*k] = v.clone();
    }
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

fn stl(name: &str, tris: &[[(f64, f64, f64); 3]]) -> Arc<Mesh> {
    let mut s = format!("solid {name}\n");
    for t in tris {
        let _ = writeln!(s, "facet normal 0 0 0\n outer loop");
        for v in t {
            let _ = writeln!(s, "  vertex {} {} {}", v.0, v.1, v.2);
        }
        let _ = writeln!(s, " endloop\nendfacet");
    }
    let _ = writeln!(s, "endsolid {name}");
    Arc::new(Mesh::load(s.as_bytes(), &format!("{name}.stl")).unwrap())
}

/// The W 4.0 step: a 30 mm square box 2 mm tall under a centered 22 mm block to z 4.
fn step() -> Arc<Mesh> {
    step_w(4.0)
}

/// The W step: a 30 mm square box 2 mm tall under a centered (30 - 2W) mm block to z 4, leaving a ring W wide.
fn step_w(w: f64) -> Arc<Mesh> {
    let mut tris = Vec::new();
    for (h, z0, z1) in [(15.0, 0.0, 2.0), (15.0 - w, 2.0, 4.0)] {
        let sq: [(f64, f64); 4] = [(-h, -h), (h, -h), (h, h), (-h, h)];
        for i in 0..4 {
            let (a, b) = (sq[i], sq[(i + 1) % 4]);
            tris.push([(0.0, 0.0, z0), (b.0, b.1, z0), (a.0, a.1, z0)]);
            tris.push([(0.0, 0.0, z1), (a.0, a.1, z1), (b.0, b.1, z1)]);
            tris.push([(a.0, a.1, z0), (b.0, b.1, z0), (b.0, b.1, z1)]);
            tris.push([(a.0, a.1, z0), (b.0, b.1, z1), (a.0, a.1, z1)]);
        }
    }
    stl("step", &tris)
}

/// The taper: a 30 mm square box from z 0 to 2 under a frustum from 30 mm at z 2 to 15 mm at z 4, centered.
fn taper() -> Arc<Mesh> {
    let sq = |h: f64, z: f64| [(-h, -h, z), (h, -h, z), (h, h, z), (-h, h, z)];
    let rings = [sq(15.0, 0.0), sq(15.0, 2.0), sq(7.5, 4.0)];
    let mut tris = Vec::new();
    let (b, t) = (rings[0], rings[2]);
    tris.push([b[0], b[2], b[1]]);
    tris.push([b[0], b[3], b[2]]);
    tris.push([t[0], t[1], t[2]]);
    tris.push([t[0], t[2], t[3]]);
    for r in 0..2 {
        let (lo, hi) = (rings[r], rings[r + 1]);
        for i in 0..4 {
            let j = (i + 1) % 4;
            tris.push([lo[i], lo[j], hi[j]]);
            tris.push([lo[i], hi[j], hi[i]]);
        }
    }
    stl("taper", &tris)
}

/// One stair per `d`, 15 mm long and 20 mm apart along y, the row centered on the origin: a 10 mm ledge topped at
/// z 2.0, a step `d` wide topped at 2.2 and a 10 mm block to z 4.
fn stairs(ds: &[f64]) -> Arc<Mesh> {
    let mut tris = Vec::new();
    let start = (ds.len() as f64).mul_add(-10.0, 2.5);
    for (k, &d) in ds.iter().enumerate() {
        let y0 = 20.0f64.mul_add(k as f64, start);
        let y1 = y0 + 15.0;
        // The profile in x and z, counterclockwise, with the corners the caps' pieces share.
        let p = [
            (-10.0, 0.0),
            (0.0, 0.0),
            (d, 0.0),
            (10.0 + d, 0.0),
            (10.0 + d, 4.0),
            (d, 4.0),
            (d, 2.2),
            (0.0, 2.2),
            (0.0, 2.0),
            (-10.0, 2.0),
        ];
        let caps = [
            [0, 1, 8],
            [0, 8, 9],
            [2, 6, 7],
            [2, 7, 8],
            [2, 8, 1],
            [3, 4, 5],
            [3, 5, 6],
            [3, 6, 2],
        ];
        for c in caps {
            let v = |i: usize, y: f64| (p[i].0, y, p[i].1);
            tris.push([v(c[0], y0), v(c[1], y0), v(c[2], y0)]);
            tris.push([v(c[0], y1), v(c[2], y1), v(c[1], y1)]);
        }
        for i in 0..p.len() {
            let (a, b) = (p[i], p[(i + 1) % p.len()]);
            tris.push([(a.0, y0, a.1), (b.0, y1, b.1), (b.0, y0, b.1)]);
            tris.push([(a.0, y0, a.1), (a.0, y1, a.1), (b.0, y1, b.1)]);
        }
    }
    stl("stairs", &tris)
}

fn x_mark() -> Arc<Mesh> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/bench/models/x-mark.stl");
    Arc::new(Mesh::load(&std::fs::read(path).unwrap(), "x-mark.stl").unwrap())
}

/// An extruding move: feature, layer z in hundredths of a mm, ends, filament.
struct Move {
    feature: String,
    z: i64,
    from: (f64, f64),
    to: (f64, f64),
    e: f64,
    width: f64,
}

fn word(code: &str, key: char) -> Option<f64> {
    code.split_whitespace()
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse().ok()))
}

fn moves(gcode: &str) -> Vec<Move> {
    let (mut feature, mut z, mut at, mut width) = (String::new(), 0i64, (0.0, 0.0), 0.4);
    let mut out = Vec::new();
    for line in gcode.lines() {
        let s = line.trim();
        // Bambu Lab printers' labels, then the others'; an internal bridge counts as a bridge.
        if let Some(f) = s.strip_prefix("; FEATURE:").or_else(|| s.strip_prefix(";TYPE:")) {
            feature = match f.trim() {
                "Internal Bridge" => BRIDGE.to_owned(),
                other => other.to_owned(),
            };
            continue;
        }
        if let Some(h) = s.strip_prefix("; Z_HEIGHT:").or_else(|| s.strip_prefix(";Z:")) {
            z = (h.trim().parse::<f64>().unwrap() * 100.0).round() as i64;
            continue;
        }
        if let Some(w) = s.strip_prefix("; LINE_WIDTH:") {
            width = w.trim().parse().unwrap();
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|g| code.starts_with(g)) {
            continue;
        }
        let to = (word(code, 'X').unwrap_or(at.0), word(code, 'Y').unwrap_or(at.1));
        if let Some(e) = word(code, 'E').filter(|e| *e > 0.0)
            && to != at
        {
            out.push(Move {
                feature: feature.clone(),
                z,
                from: at,
                to,
                e,
                width,
            });
        }
        at = to;
    }
    out
}

fn z100(z: f64) -> i64 {
    (z * 100.0).round() as i64
}

/// Filament per (feature, layer).
fn per_layer(ms: &[Move]) -> BTreeMap<(String, i64), f64> {
    let mut out = BTreeMap::new();
    for m in ms {
        *out.entry((m.feature.clone(), m.z)).or_insert(0.0) += m.e;
    }
    out
}

fn at(layers: &BTreeMap<(String, i64), f64>, feature: &str, z: f64) -> f64 {
    layers.get(&(feature.to_owned(), z100(z))).copied().unwrap_or(0.0)
}

/// Where the solid infill (internal solid, floating vertical shell) of layer `z` stops along y 126, coming from the
/// ring's left wall: the right end of the run of 0.05 mm cells the moves cover, at their widths, from x 114.
fn edge(ms: &[Move], z: f64) -> f64 {
    const RES: f64 = 0.05;
    let cy = (126.0 / RES).floor().mul_add(RES, RES / 2.0);
    let segs: Vec<&Move> = ms
        .iter()
        .filter(|m| m.z == z100(z) && (m.feature == SOLID || m.feature == FLOATING))
        .collect();
    let covered = |cx: f64| {
        segs.iter().any(|m| {
            let (dx, dy) = (m.to.0 - m.from.0, m.to.1 - m.from.1);
            let l2 = dx.mul_add(dx, dy * dy);
            let t = if l2 == 0.0 {
                0.0
            } else {
                ((cx - m.from.0).mul_add(dx, (cy - m.from.1) * dy) / l2).clamp(0.0, 1.0)
            };
            let (px, py) = (t.mul_add(dx, m.from.0) - cx, t.mul_add(dy, m.from.1) - cy);
            px.mul_add(px, py * py) <= 0.25 * m.width * m.width
        })
    };
    let mut i = (114.0 / RES) as i64;
    while covered((i as f64 + 0.5) * RES) {
        i += 1;
    }
    i as f64 * RES
}

fn near(got: f64, want: f64, within: f64) -> bool {
    (got - want).abs() <= within * want
}

fn step_case(bottom: u32, edits: &[(&str, Value)]) -> Vec<Move> {
    let mut all = vec![("bottom_shell_layers", json!(bottom))];
    all.extend(edits.iter().cloned());
    moves(&slice(step(), &all))
}

/// Solid infill, internal solid plus floating vertical shell, on layer `z`.
fn solid(layers: &BTreeMap<(String, i64), f64>, z: f64) -> f64 {
    at(layers, SOLID, z) + at(layers, FLOATING, z)
}

#[test]
fn the_ring_layer_over_sparse_bridges_with_five_bottom_shells() {
    let ms = step_case(5, &[solid_pattern("zig-zag")]);
    let layers = per_layer(&ms);
    for (feature, want) in [(SOLID, 29.84), (SPARSE, 8.38)] {
        let got = at(&layers, feature, 1.2);
        assert!(near(got, want, 0.05), "z 1.2: {feature} {got:.2}, want {want}");
    }
    assert!(at(&layers, BRIDGE, 1.4) > 0.0, "z 1.4: no bridge");
    let sparse = at(&layers, SPARSE, 1.4);
    assert!(
        near(sparse, 3.35, 0.05),
        "z 1.4: sparse infill {sparse:.2}, want 3.35"
    );
    assert!(at(&layers, SOLID, 1.4) > 0.0, "z 1.4: no internal solid infill");
    assert!(
        at(&layers, FLOATING, 1.4) == 0.0,
        "z 1.4: floating vertical shell {:.2}, want none",
        at(&layers, FLOATING, 1.4)
    );
    for (z, label) in [(1.6, SOLID), (1.8, FLOATING)] {
        let got = at(&layers, label, z);
        assert!(near(got, 34.98, 0.05), "z {z}: {label} {got:.2}, want 34.98");
        let other = solid(&layers, z) - got;
        assert!(other == 0.0, "z {z}: {other:.2} of solid infill not {label}");
    }
}

#[test]
fn the_ring_layer_bridges_with_narrow_detection_off() {
    let layers = per_layer(&step_case(
        5,
        &[("detect_narrow_internal_solid_infill", json!(false))],
    ));
    assert!(at(&layers, BRIDGE, 1.4) > 0.0, "z 1.4: no bridge");
}

#[test]
fn ring_shell_layers_under_the_block_reach_past_its_outline() {
    for bottom in [3, 4, 5, 6] {
        let ms = step_case(bottom, &[]);
        let layers = per_layer(&ms);
        for z in [1.6, 1.8] {
            let e = edge(&ms, z);
            assert!(
                (e - 118.30).abs() <= 0.051,
                "{bottom} bottom shells, z {z}: solid edge {e:.2}, want 118.30"
            );
            let got = solid(&layers, z);
            assert!(
                near(got, 34.98, 0.05),
                "{bottom} bottom shells, z {z}: solid infill {got:.2}, want 34.98"
            );
        }
    }
}

#[test]
fn the_lowest_ring_shell_layer_keeps_its_edge_and_a_line_under_the_slit() {
    let ms = step_case(5, &[]);
    let e = edge(&ms, 1.2);
    assert!(
        (e - 117.10).abs() <= 0.05,
        "z 1.2: solid edge {e:.2}, want 117.10"
    );
    // One line of internal solid infill at 117.90 to 118.30, under the slit the z 2.0 inner wall leaves.
    let line = ms.iter().any(|m| {
        m.z == z100(1.2)
            && m.feature == SOLID
            && f64::midpoint(m.from.0, m.to.0) > 117.8
            && f64::midpoint(m.from.0, m.to.0) < 118.4
            && (f64::midpoint(m.from.1, m.to.1) - 126.0).abs() < 5.0
    });
    assert!(line, "z 1.2: no solid line under the slit at 117.90 to 118.30");
}

#[test]
fn partial_vertical_shells_keep_the_ring_at_the_outline() {
    let ms = step_case(5, &[("ensure_vertical_shell_thickness", json!("partial"))]);
    let layers = per_layer(&ms);
    for z in [1.4, 1.6, 1.8] {
        assert!(
            at(&layers, BRIDGE, z) == 0.0,
            "z {z}: bridge {:.2}",
            at(&layers, BRIDGE, z)
        );
        assert!(
            at(&layers, SOLID, z) == 0.0 && at(&layers, FLOATING, z) > 0.0,
            "z {z}: internal solid {:.2}, floating {:.2}, want floating only",
            at(&layers, SOLID, z),
            at(&layers, FLOATING, z)
        );
        let e = edge(&ms, z);
        assert!(
            (e - 117.10).abs() <= 0.05,
            "z {z}: solid edge {e:.2}, want 117.10"
        );
    }
}

#[test]
fn three_and_four_bottom_shells_keep_their_bridge_and_the_ring_under_it() {
    for (bottom, under) in [(3, FLOATING), (4, SOLID)] {
        let layers = per_layer(&step_case(bottom, &[]));
        let bridge = at(&layers, BRIDGE, 1.2);
        assert!(
            near(bridge, 67.63, 0.05) && at(&layers, SOLID, 1.2) == 0.0,
            "{bottom} bottom shells, z 1.2: bridge {bridge:.2}, internal solid {:.2}, want bridge 67.63 only",
            at(&layers, SOLID, 1.2)
        );
        let got = at(&layers, under, 1.0);
        assert!(got > 0.0, "{bottom} bottom shells: no {under} at z 1.0");
        let z14 = at(&layers, SOLID, 1.4);
        assert!(
            near(z14, 34.98, 0.05) && at(&layers, FLOATING, 1.4) == 0.0,
            "{bottom} bottom shells, z 1.4: internal solid {z14:.2}, floating {:.2}, want internal solid 34.98",
            at(&layers, FLOATING, 1.4)
        );
    }
}

/// For each stair of [`stairs`], the filament of each feature on layer `z` over it.
fn stair_layers(ds: &[f64], bottom: u32, z: f64) -> Vec<BTreeMap<String, f64>> {
    let ms = moves(&slice(stairs(ds), &[("bottom_shell_layers", json!(bottom))]));
    let y0 = ms
        .iter()
        .filter(|m| m.z == z100(0.2) && m.feature == "Outer wall")
        .map(|m| m.from.1.min(m.to.1))
        .fold(f64::MAX, f64::min);
    (0..ds.len())
        .map(|k| {
            let (lo, hi) = (y0 + 20.0 * k as f64, y0 + 20.0 * k as f64 + 15.5);
            let mut out = BTreeMap::new();
            for m in &ms {
                let y = f64::midpoint(m.from.1, m.to.1);
                if m.z == z100(z) && y >= lo && y <= hi {
                    *out.entry(m.feature.clone()).or_insert(0.0) += m.e;
                }
            }
            out
        })
        .collect()
}

/// For each stair of [`stairs`], whether layer `z` prints a bridge over it.
fn stair_bridges(ds: &[f64], bottom: u32, z: f64) -> Vec<bool> {
    stair_layers(ds, bottom, z)
        .iter()
        .map(|l| l.get(BRIDGE).copied().unwrap_or(0.0) > 0.0)
        .collect()
}

#[test]
fn stairs_bridge_from_a_step_of_1_26_mm_with_five_bottom_shells() {
    let ds = [0.3, 0.7, 1.1, 1.2, 1.24, 1.26, 1.3, 2.0, 3.0];
    for (d, bridged) in ds.iter().zip(stair_bridges(&ds, 5, 1.4)) {
        assert_eq!(
            bridged,
            *d >= 1.25,
            "5 bottom shells, step {d} mm: bridge {bridged} at z 1.4"
        );
    }
}

#[test]
fn stairs_under_1_26_mm_print_their_step_as_internal_solid() {
    // z 1.4 over each stair with 5 bottom shells: internal solid infill only, within 5 percent.
    let ds = [0.3, 0.7, 0.9, 1.1, 1.24];
    let want = [11.44, 12.20, 12.42, 12.64, 12.79];
    for ((d, l), w) in ds.iter().zip(stair_layers(&ds, 5, 1.4)).zip(want) {
        let solid = l.get(SOLID).copied().unwrap_or(0.0);
        let other = l.get(BRIDGE).copied().unwrap_or(0.0) + l.get(FLOATING).copied().unwrap_or(0.0);
        assert!(
            near(solid, w, 0.05) && other == 0.0,
            "step {d} mm, z 1.4: internal solid {solid:.2}, bridge or floating {other:.2}, want internal solid {w}"
        );
    }
}

#[test]
fn stairs_bridge_from_a_step_of_2_5_mm_with_three_bottom_shells() {
    let ds = [0.3, 1.3, 2.0, 2.5, 3.0];
    for (d, bridged) in ds.iter().zip(stair_bridges(&ds, 3, 1.4)) {
        assert_eq!(
            bridged,
            *d >= 2.5,
            "3 bottom shells, step {d} mm: bridge {bridged} at z 1.4"
        );
    }
}

#[test]
fn classic_x_mark_prints_gap_fill_only_after_a_top_surface() {
    // The stock P1S and A1 settings with classic walls.
    for printer in ["p1s", "a1"] {
        let path = format!(
            "{}/tests/fixtures/classic-ring-shell/{printer}-x-mark.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let req: SliceRequest = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let mesh = x_mark();
        let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
        let ms = moves(&String::from_utf8(run.gcode).unwrap());
        for w in ms.windows(2) {
            if w[1].feature == GAP && w[0].feature != GAP && w[0].z == w[1].z {
                assert!(
                    w[0].feature == "Top surface",
                    "{printer}: gap fill at z {} after {}",
                    w[1].z as f64 / 100.0,
                    w[0].feature
                );
            }
        }
    }
}

/// Filament of the floating vertical shell and internal solid infill together, and of the bridge, per layer, against
/// `want` ((z, solid, bridge) targets): each within 1 mm of filament or 10 percent.
fn check_taper(name: &str, g: &str, want: &[(f64, f64, f64)]) {
    let layers = per_layer(&moves(g));
    let mut misses = Vec::new();
    for &(z, sol, br) in want {
        for (what, got, w) in [
            ("solid", solid(&layers, z), sol),
            ("bridge", at(&layers, BRIDGE, z), br),
        ] {
            if (got - w).abs() > 1.0 && (got - w).abs() > 0.1 * w {
                misses.push(format!("z {z}: {what} {got:.2}, want {w}"));
            }
        }
    }
    assert!(misses.is_empty(), "{name}:\n{}", misses.join("\n"));
}

#[test]
fn the_band_under_a_taper_reaches_the_slits() {
    let want = [
        (1.2, 2.64, 0.0),
        (1.4, 0.23, 47.33),
        (1.6, 19.98, 0.0),
        (1.8, 25.68, 0.0),
        (2.0, 30.91, 0.0),
        (2.2, 21.67, 0.0),
        (2.4, 20.19, 0.0),
        (2.6, 18.72, 0.0),
        (2.8, 17.24, 0.0),
        (3.0, 15.76, 0.0),
        (3.2, 8.74, 23.84),
        (3.4, 21.65, 0.0),
        (3.6, 17.85, 0.0),
        (3.8, 14.42, 0.0),
    ];
    check_taper("stock taper", &slice(taper(), &[]), &want);
}

#[test]
fn a_slit_too_narrow_to_count_leaves_the_taper_as_it_was() {
    // 30% overlap: the slit is under 0.74 solid spacings wide.
    let want = [
        (1.4, 4.36, 0.0),
        (1.6, 10.43, 0.0),
        (1.8, 16.65, 0.0),
        (2.0, 22.52, 0.0),
        (2.2, 13.92, 0.0),
        (2.4, 13.03, 0.0),
        (2.6, 12.14, 0.0),
        (2.8, 11.25, 0.0),
        (3.0, 10.37, 0.0),
        (3.2, 2.86, 32.15),
        (3.4, 21.97, 0.0),
        (3.6, 18.14, 0.0),
        (3.8, 14.66, 0.0),
    ];
    check_taper(
        "taper at 30% overlap",
        &slice(taper(), &[("infill_wall_overlap", json!(30))]),
        &want,
    );
}

#[test]
fn the_slit_counts_on_other_printers_too() {
    // MK4 widths on a printer that is not a Bambu Lab one: no floating vertical shell there, so the band prints as
    // internal solid infill, the same amounts.
    let mk4 = [
        ("printer_model", json!("Prusa MK4")),
        ("gcode_flavor", json!("marlin2")),
        ("top_shell_layers", json!(4)),
        ("inner_wall_line_width", json!("0.44")),
        ("outer_wall_line_width", json!("0.40")),
        ("infill_wall_overlap", json!(25)),
        ("wall_loops", json!(3)),
    ];
    let want = [
        (1.2, 2.82, 0.0),
        (1.4, 0.0, 48.09),
        (1.6, 21.07, 0.0),
        (1.8, 26.25, 0.0),
        (2.0, 31.2, 0.0),
        (2.2, 20.31, 0.0),
        (2.4, 18.85, 0.0),
        (2.6, 17.39, 0.0),
        (2.8, 15.93, 0.0),
        (3.0, 14.48, 0.0),
        (3.2, 8.14, 19.99),
        (3.4, 18.81, 0.0),
        (3.6, 15.29, 0.0),
        (3.8, 12.13, 0.0),
    ];
    check_taper("MK4 widths, not Bambu Lab", &slice(taper(), &mk4), &want);
}

/// Floating vertical shell and internal solid infill on the ring's shell layers z 1.4, 1.6 and 1.8 of the W `w` step
/// with `edits`: `want` is the label of each (true floating) and `e` the amount each layer carries, within `within`.
fn check_ring(name: &str, w: f64, edits: &[(&str, Value)], want: [bool; 3], e: f64, within: f64) {
    let zs: Vec<(f64, bool)> = [1.4, 1.6, 1.8].into_iter().zip(want).collect();
    check_layers(name, &slice(step_w(w), edits), &zs, e, within);
}

/// The same on the layers `zs` (z, true floating) of the G-code `g`.
fn check_layers(name: &str, g: &str, zs: &[(f64, bool)], e: f64, within: f64) {
    let layers = per_layer(&moves(g));
    let mut misses = Vec::new();
    for &(z, floats) in zs {
        let (fl, is) = (at(&layers, FLOATING, z), at(&layers, SOLID, z));
        let (got, other, label) = if floats {
            (fl, is, FLOATING)
        } else {
            (is, fl, SOLID)
        };
        if other > 0.0 || !near(got, e, within) {
            misses.push(format!(
                "z {z}: floating {fl:.2}, internal solid {is:.2}, want {label} {e}"
            ));
        }
    }
    assert!(misses.is_empty(), "{name}:\n{}", misses.join("\n"));
}

#[test]
fn the_slit_counts_up_to_19_percent_overlap() {
    for (ov, e) in [(16, 34.96), (17, 34.93), (18, 34.91), (19, 34.88)] {
        check_ring(
            &format!("{ov}% overlap"),
            4.0,
            &[solid_pattern("zig-zag"), ("infill_wall_overlap", json!(ov))],
            [false, true, true],
            e,
            0.03,
        );
    }
}

#[test]
fn classic_ring_amounts_follow_the_slit() {
    for (w, want, e) in [(4.5, [false, true, true], 38.19), (5.0, [false; 3], 41.56)] {
        check_ring(&format!("W {w}"), w, &[solid_pattern("zig-zag")], want, e, 0.03);
    }
}

#[test]
fn the_first_ring_layer_over_its_bridge_floats_from_20_percent_overlap() {
    for (ov, e) in [
        (20, 31.90),
        (21, 31.87),
        (22, 31.85),
        (23, 31.82),
        (24, 31.69),
        (25, 31.66),
        (30, 31.53),
    ] {
        check_ring(
            &format!("{ov}% overlap"),
            4.0,
            &[solid_pattern("zig-zag"), ("infill_wall_overlap", json!(ov))],
            [true; 3],
            e,
            0.03,
        );
    }
}

#[test]
fn the_first_ring_layer_stays_internal_solid_with_other_walls() {
    // Variable-width walls within 1% of their amount; one wall (whose upper ring layers are not pinned here) and three
    // walls keep z 1.4 internal solid.
    check_ring(
        "variable-width walls",
        4.5,
        &[solid_pattern("zig-zag"), ("wall_generator", json!("aegis"))],
        [false, true, true],
        35.44,
        0.01,
    );
    for (loops, e) in [(1, 33.01), (3, 35.27)] {
        let layers = per_layer(&moves(&slice(step_w(4.0), &[("wall_loops", json!(loops))])));
        let (fl, is) = (at(&layers, FLOATING, 1.4), at(&layers, SOLID, 1.4));
        assert!(
            fl == 0.0 && near(is, e, 0.03),
            "{loops} walls, z 1.4: floating {fl:.2}, internal solid {is:.2}, want internal solid {e}"
        );
    }
}

/// The internal solid infill pattern edit: `zig-zag` (rectilinear) or `monotonic`, the stock request's.
fn solid_pattern(name: &str) -> (&'static str, Value) {
    ("internal_solid_infill_pattern", json!(name))
}

#[test]
fn at_monotonic_the_stock_ring_layers_stay_internal_solid() {
    // Stacked on the ring layer below, z 1.6 and 1.8 only border the sparse infill under the block.
    check_ring(
        "W 4.5",
        4.5,
        &[solid_pattern("monotonic")],
        [false; 3],
        38.19,
        0.01,
    );
}

#[test]
fn at_zig_zag_the_stock_ring_layers_over_the_first_float() {
    check_ring(
        "W 4.5",
        4.5,
        &[solid_pattern("zig-zag")],
        [false, true, true],
        38.19,
        0.01,
    );
}

#[test]
fn at_monotonic_only_the_first_ring_layer_floats_at_30_percent_overlap() {
    // z 1.4 floats over the sparse infill past its bridge; the layers stacked on it stay internal solid.
    check_ring(
        "30% overlap",
        4.0,
        &[solid_pattern("monotonic"), ("infill_wall_overlap", json!(30))],
        [true, false, false],
        31.53,
        0.03,
    );
}

#[test]
fn the_sparse_pattern_decides_whether_stacked_ring_layers_float() {
    // Monotonic internal solid over cross hatch floats z 1.6 and 1.8; zig-zag over concentric does not.
    let g = slice(
        step_w(4.5),
        &[
            solid_pattern("monotonic"),
            ("sparse_infill_pattern", json!("crosshatch")),
        ],
    );
    check_layers(
        "monotonic over cross hatch",
        &g,
        &[(1.6, true), (1.8, true)],
        38.19,
        0.01,
    );
    let g = slice(
        step_w(4.5),
        &[
            solid_pattern("zig-zag"),
            ("sparse_infill_pattern", json!("concentric")),
        ],
    );
    check_layers(
        "zig-zag over concentric",
        &g,
        &[(1.4, false), (1.6, false), (1.8, false)],
        38.19,
        0.01,
    );
}

#[test]
fn ring_layers_follow_the_measured_pattern_grid() {
    // Pairs from both sides of the table (internal solid, sparse): the floating ones on z 1.6 and 1.8, the others
    // internal solid on z 1.4, 1.6 and 1.8.
    for (solid, sparse, floats) in [
        ("concentric", "concentric", true),
        ("archimedeanchords", "octagramspiral", true),
        ("monotonic", "lightning", true),
        ("octagramspiral", "archimedeanchords", false),
        ("hilbertcurve", "alignedrectilinear", false),
    ] {
        let g = slice(
            step_w(4.5),
            &[solid_pattern(solid), ("sparse_infill_pattern", json!(sparse))],
        );
        let zs: &[(f64, bool)] = if floats {
            &[(1.6, true), (1.8, true)]
        } else {
            &[(1.4, false), (1.6, false), (1.8, false)]
        };
        check_layers(&format!("{solid} over {sparse}"), &g, zs, 38.19, 0.01);
    }
}

#[test]
fn the_a1_ring_follows_the_pattern_grid() {
    let a1 = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/classic-ring-shell/a1-x-mark.json"
    );
    let g = slice_from(
        a1,
        step_w(4.5),
        &[
            solid_pattern("octagramspiral"),
            ("sparse_infill_pattern", json!("archimedeanchords")),
        ],
    );
    check_layers(
        "A1, octagramspiral over archimedeanchords",
        &g,
        &[(1.4, false), (1.6, false), (1.8, false)],
        38.19,
        0.01,
    );
}

#[test]
fn at_monotonic_five_layer_stairs_float_less() {
    // Five bottom shells and a 5 mm2 smallest sparse area: the stair steps that only border the sparse infill below
    // stay internal solid.
    let ds = [0.3, 0.5, 0.7, 0.9, 1.1, 1.3, 1.6, 2.0, 2.5, 3.0];
    let ms = moves(&slice(
        stairs(&ds),
        &[
            solid_pattern("monotonic"),
            ("bottom_shell_layers", json!(5)),
            ("minimum_sparse_infill_area", json!(5)),
        ],
    ));
    let fl: f64 = ms.iter().filter(|m| m.feature == FLOATING).map(|m| m.e).sum();
    assert!(near(fl, 18.51, 0.05), "floating {fl:.2}, want 18.51");
}

/// The widest ring that floats with zig-zag internal solid infill and `edits`, and the next width up: the W `last`
/// ring's z 1.6 and 1.8 float with about `e` each (within 2%), and the W `first` ring's print as internal solid infill
/// with nothing floating.
fn check_ring_width(name: &str, edits: &[(&str, Value)], last: f64, first: f64, e: f64) {
    let mut all = vec![solid_pattern("zig-zag")];
    all.extend(edits.iter().cloned());
    let mut misses = Vec::new();
    for (w, floats) in [(last, true), (first, false)] {
        let layers = per_layer(&moves(&slice(step_w(w), &all)));
        for z in [1.6, 1.8] {
            let (fl, is) = (at(&layers, FLOATING, z), at(&layers, SOLID, z));
            let right = if floats {
                is == 0.0 && near(fl, e, 0.02)
            } else {
                fl == 0.0 && is > 0.0
            };
            if !right {
                let want = if floats {
                    format!("{FLOATING} {e}")
                } else {
                    SOLID.to_owned()
                };
                misses.push(format!(
                    "W {w} z {z}: floating {fl:.2}, internal solid {is:.2}, want {want}"
                ));
            }
        }
    }
    assert!(misses.is_empty(), "{name}:\n{}", misses.join("\n"));
}

#[test]
fn where_the_slit_counts_the_ring_floats_up_to_4_5_mm() {
    check_ring_width("stock", &[], 4.5, 4.55, 38.19);
}

#[test]
fn at_20_percent_overlap_the_ring_floats_up_to_4_7_mm() {
    check_ring_width(
        "20% overlap",
        &[("infill_wall_overlap", json!(20))],
        4.7,
        4.75,
        36.31,
    );
}

#[test]
fn on_0_50_mm_solid_lines_the_ring_floats_up_to_4_68_mm() {
    check_ring_width(
        "0.50 mm solid lines",
        &[("internal_solid_infill_line_width", json!(0.5))],
        4.68,
        4.7,
        36.35,
    );
}

#[test]
fn at_30_percent_overlap_the_ring_floats_up_to_4_95_mm() {
    check_ring_width(
        "30% overlap",
        &[("infill_wall_overlap", json!(30))],
        4.95,
        5.0,
        37.64,
    );
}

#[test]
fn on_0_50_mm_solid_lines_at_20_percent_overlap_the_ring_floats_up_to_4_9_mm() {
    check_ring_width(
        "0.50 mm solid lines, 20% overlap",
        &[
            ("internal_solid_infill_line_width", json!(0.5)),
            ("infill_wall_overlap", json!(20)),
        ],
        4.9,
        5.0,
        37.75,
    );
}

#[test]
fn with_variable_width_walls_the_ring_floats_up_to_4_9_mm() {
    check_ring_width(
        "variable-width walls",
        &[("wall_generator", json!("aegis"))],
        4.9,
        4.95,
        37.68,
    );
}
