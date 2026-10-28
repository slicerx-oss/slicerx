// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Spiral vase mode on the H2D, a printer with two nozzles whose timelapse photo goes at the end of every layer: the
//! spiral layers change layer without a stop, the solid base goes from layer to layer and through the photo without a
//! retraction, and the spiral starts where the base ended, with its first extrusion and nothing before it at the foot
//! of the wall. The config is built the way the app builds it: the settings schema's defaults, then the H2D's shipped
//! process, filament and printer settings, then its start, end and timelapse G-code.

#![allow(clippy::disallowed_methods)]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// The app's config for the stock `model`: the settings schema's defaults, then its shipped process, filament and
/// printer settings, then its start, end and timelapse G-code.
fn stock(model: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let m = read("packages/profiles/resolved/bambu-lab.json")["models"][model].clone();
    let base = m["base"].as_str().unwrap().to_owned();
    for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    let gcode = read("packages/profiles/gcode.json");
    let family = gcode["models"][model].as_str().unwrap().to_owned();
    for (key, part) in [
        ("machine_start_gcode", "start"),
        ("machine_end_gcode", "end"),
        ("time_lapse_gcode", "timeLapse"),
    ] {
        out.insert(key.into(), gcode["families"][&family][part].clone());
    }
    out
}

/// A closed cylinder of radius `r` and height `h` mm around the origin, `n` facets round, as binary STL.
fn cylinder_stl(r: f32, h: f32, n: u16) -> Vec<u8> {
    let at = |i: u16, z: f32| {
        let a = std::f32::consts::TAU * f32::from(i % n) / f32::from(n);
        [r * a.cos(), r * a.sin(), z]
    };
    let mut tris: Vec<[[f32; 3]; 3]> = Vec::new();
    for i in 0..n {
        let (a0, a1, b0, b1) = (at(i, 0.0), at(i + 1, 0.0), at(i, h), at(i + 1, h));
        tris.push([a0, a1, b1]);
        tris.push([a0, b1, b0]);
        tris.push([[0.0, 0.0, 0.0], a1, a0]);
        tris.push([[0.0, 0.0, h], b0, b1]);
    }
    let mut b = vec![0u8; 80];
    b.extend_from_slice(&u32::try_from(tris.len()).unwrap().to_le_bytes());
    for t in tris {
        b.extend_from_slice(&[0u8; 12]);
        for v in t {
            for c in v {
                b.extend_from_slice(&f32::to_le_bytes(c));
            }
        }
        b.extend_from_slice(&[0u8; 2]);
    }
    b
}

fn slice(spiral: bool, shards: u32) -> String {
    slice_mesh(&cylinder_stl(20.0, 3.0, 360), spiral, shards)
}

/// The bench x-mark: a plate with two raised blocks whose outlines take turns at being the largest, so the spiral
/// goes from one block to the other between layers.
fn x_mark() -> Vec<u8> {
    std::fs::read(format!("{}/bench/models/x-mark.stl", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn slice_mesh(stl: &[u8], spiral: bool, shards: u32) -> String {
    slice_on("bambu-h2d", stl, spiral, shards)
}

fn slice_on(model: &str, stl: &[u8], spiral: bool, shards: u32) -> String {
    let m = Arc::new(Mesh::load(stl, "vase.stl").unwrap());
    let mut config = stock(model);
    config.insert("spiral_mode".into(), json!(spiral));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "o", "name": "vase", "mesh": "m",
                               "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 175, 160, 0, 1]}]},
        "config": Value::Object(config),
        "options": {"trustedGcode": true, "shards": shards},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

/// One motion line as written, with where the nozzle was before it and where it is after.
#[derive(Debug, Clone)]
struct Move {
    line: usize,
    code: String,
    from: [f64; 3],
    to: [f64; 3],
    e: f64,
}

impl Move {
    fn xy(&self) -> f64 {
        (self.to[0] - self.from[0]).hypot(self.to[1] - self.from[1])
    }
    fn extrudes(&self) -> bool {
        self.e > 0.0 && self.xy() > 0.0
    }
    fn retracts(&self) -> bool {
        self.e < 0.0
    }
    fn lifts(&self) -> bool {
        self.to[2] > self.from[2] + 1e-6
    }
}

/// The print's layers after the start G-code, each as its motion lines, plus the lines of its timelapse block.
struct Layer {
    moves: Vec<Move>,
    /// The line numbers (1-based) of the layer's `; SKIPPABLE_START` and `; SKIPPABLE_END`.
    photo: Option<(usize, usize)>,
}

fn layers(g: &str) -> Vec<Layer> {
    let mut out: Vec<Layer> = Vec::new();
    let mut at = [0.0f64; 3];
    let mut open: Option<usize> = None;
    for (i, line) in g.lines().enumerate() {
        let n = i + 1;
        if line.starts_with(";LAYER_CHANGE") || line.starts_with("; CHANGE_LAYER") {
            out.push(Layer {
                moves: Vec::new(),
                photo: None,
            });
            continue;
        }
        if line.starts_with("; SKIPPABLE_START") {
            open = Some(n);
        }
        if line.starts_with("; SKIPPABLE_END")
            && let (Some(s), Some(l)) = (open.take(), out.last_mut())
        {
            l.photo = Some((s, n));
        }
        let code = line.split(';').next().unwrap_or("").trim();
        let Some(cmd) = code.split_whitespace().next() else {
            continue;
        };
        if !matches!(cmd, "G0" | "G1" | "G2" | "G3") {
            continue;
        }
        let to = [
            word(code, 'X').unwrap_or(at[0]),
            word(code, 'Y').unwrap_or(at[1]),
            word(code, 'Z').unwrap_or(at[2]),
        ];
        let m = Move {
            line: n,
            code: code.to_owned(),
            from: at,
            to,
            e: word(code, 'E').unwrap_or(0.0),
        };
        at = to;
        if let Some(l) = out.last_mut() {
            l.moves.push(m);
        }
    }
    out
}

/// The layers of the part: the end G-code's moves after the last extrusion are dropped.
fn part_layers(g: &str) -> Vec<Layer> {
    let mut ls = layers(g);
    if let Some(last) = ls.last_mut()
        && let Some(k) = last.moves.iter().rposition(Move::extrudes)
    {
        last.moves.truncate(k + 1);
    }
    ls
}

const BASE: usize = 3;

#[test]
fn spiral_layers_change_layer_without_a_stop() {
    let g = slice(true, 1);
    let ls = part_layers(&g);
    assert!(ls.len() > BASE + 6, "{} layers", ls.len());
    // Every spiral layer after the first, but the last with its closing loop: nothing but the climbing wall, and at
    // most one Z line at the layer change that stays at the height the nozzle is at.
    for (k, l) in ls.iter().enumerate().take(ls.len() - 1).skip(BASE + 1) {
        let mut z_lines = 0;
        for m in &l.moves {
            assert!(
                !m.code.starts_with("G0"),
                "layer {k}: a travel at line {}: {}",
                m.line,
                m.code
            );
            assert!(
                !m.retracts(),
                "layer {k}: a retraction at line {}: {}",
                m.line,
                m.code
            );
            assert!(
                !m.code.starts_with("G2") && !m.code.starts_with("G3"),
                "layer {k}: a lift at line {}: {}",
                m.line,
                m.code
            );
            assert!(
                m.extrudes() || m.xy() == 0.0,
                "layer {k}: a move without extrusion at line {}: {}",
                m.line,
                m.code
            );
            if m.xy() == 0.0 && m.code.contains('Z') {
                z_lines += 1;
                assert!(
                    (m.to[2] - m.from[2]).abs() < 1e-6,
                    "layer {k}: a Z move at line {}: {}",
                    m.line,
                    m.code
                );
            }
        }
        assert!(z_lines <= 1, "layer {k}: {z_lines} Z lines");
        assert!(
            !g.contains("; WIPE_START") || !wipes_in(&g, l),
            "layer {k}: a wipe"
        );
    }
}

/// Whether a `; WIPE_START` falls among the layer's lines.
fn wipes_in(g: &str, l: &Layer) -> bool {
    let (Some(a), Some(b)) = (l.moves.first(), l.moves.last()) else {
        return false;
    };
    g.lines()
        .enumerate()
        .skip(a.line - 1)
        .take(b.line + 1 - a.line)
        .any(|(_, line)| line.starts_with("; WIPE_START"))
}

#[test]
fn the_spiral_starts_where_the_base_ended_with_its_first_extrusion() {
    let g = slice(true, 1);
    let ls = part_layers(&g);
    let base_top = &ls[BASE - 1];
    let spiral = &ls[BASE];
    // From the last extrusion of the base (before its photo) to the first extrusion of the spiral.
    let last = base_top.moves.iter().rposition(Move::extrudes).unwrap();
    let first = spiral.moves.iter().position(Move::extrudes).unwrap();
    let between: Vec<&Move> = base_top.moves[last + 1..]
        .iter()
        .chain(&spiral.moves[..first])
        .collect();
    for m in &between {
        assert!(
            !m.code.starts_with("G0"),
            "a travel at line {}: {}",
            m.line,
            m.code
        );
        assert!(!m.retracts(), "a retraction at line {}: {}", m.line, m.code);
        assert!(!m.lifts(), "a lift at line {}: {}", m.line, m.code);
        assert!(m.xy() == 0.0, "a move at line {}: {}", m.line, m.code);
    }
    let (a, b) = (&base_top.moves[last], &spiral.moves[first]);
    let d = (b.to[0] - a.to[0]).hypot(b.to[1] - a.to[1]);
    assert!(
        d <= 1.0,
        "the spiral's first extrusion ends {d:.3} mm from the base's last, lines {} and {}",
        a.line,
        b.line
    );
    // The first spiral move climbs from the top of the base, extruding from next to nothing.
    assert!((b.from[2] - a.to[2]).abs() < 1e-6, "{} after {}", b.code, a.code);
}

#[test]
fn the_base_goes_through_its_photo_and_into_the_next_layer_without_a_retraction() {
    let g = slice(true, 1);
    let ls = part_layers(&g);
    for (k, l) in ls.iter().enumerate().take(BASE) {
        // The photo at the end of the layer: nothing moves or retracts between the layer's last extrusion and the
        // next layer's first.
        let (s, e) = l.photo.unwrap_or_else(|| panic!("layer {k} has its photo"));
        let before = l.moves.iter().rposition(|m| m.extrudes() && m.line < s).unwrap();
        let next = &ls[k + 1];
        let after = next.moves.iter().position(Move::extrudes).unwrap();
        let around: Vec<&Move> = l.moves[before + 1..].iter().chain(&next.moves[..after]).collect();
        for m in &around {
            assert!(
                !m.retracts(),
                "layer {k}: a retraction at line {}: {}",
                m.line,
                m.code
            );
            assert!(
                !(m.lifts() && m.line > s && m.line < e),
                "layer {k}: a lift in the photo at line {}",
                m.line
            );
        }
        // The next layer's wall starts next to where this layer ended: one short travel and only the Z of the
        // layer change.
        let travel: f64 = around.iter().filter(|m| !m.extrudes()).map(|m| m.xy()).sum();
        assert!(travel <= 1.0, "layer {}: entry travel {travel:.3} mm", k + 1);
        let lifts = around
            .iter()
            .filter(|m| m.lifts() && m.xy() == 0.0 && m.line > e)
            .count();
        assert!(lifts <= 1, "layer {}: {lifts} Z moves at the layer change", k + 1);
        assert!(
            around
                .iter()
                .all(|m| !m.code.starts_with("G2") && !m.code.starts_with("G3")),
            "layer {}: a spiral lift",
            k + 1
        );
    }
}

#[test]
fn a_vase_slices_the_same_in_shards() {
    assert_eq!(slice(true, 4), slice(true, 1), "1 and 4 shards");
}

#[test]
fn the_same_cylinder_without_spiral_mode_still_retracts_at_its_layer_changes() {
    // The base rules are spiral mode only: the plain print keeps its layer change retraction.
    let g = slice(false, 1);
    let ls = part_layers(&g);
    let retracting = ls
        .iter()
        .skip(1)
        .take(4)
        .filter(|l| l.moves.iter().any(Move::retracts))
        .count();
    assert_eq!(retracting, 4, "layers 2 to 5 retract");
}

#[test]
fn each_spiral_layer_extrudes_its_first_move_for_the_distance_it_travels() {
    // A spiral layer's loop starts at its own vertex nearest the anchor, which need not be the vertex the layer below
    // ended on, and no move goes to it: the first move runs from where the nozzle is. Its E is for that move's own
    // length, at the flow of the move after it.
    let g = slice(true, 1);
    let ls = part_layers(&g);
    for (k, l) in ls.iter().enumerate().take(ls.len() - 1).skip(BASE + 1) {
        let mut ext = l.moves.iter().filter(|m| m.extrudes());
        let (Some(a), Some(b)) = (ext.next(), ext.next()) else {
            panic!("layer {k}: two extrusions");
        };
        let want = a.xy() * b.e / b.xy();
        assert!(
            (a.e - want).abs() <= 2e-5 + 0.01 * want,
            "layer {k}: line {} extrudes {} over {:.4} mm, {want:.5} at the flow of the next move",
            a.line,
            a.e,
            a.xy()
        );
    }
}

/// The distance from `p` to the closed polyline through `pts`, mm.
fn to_loop(p: [f64; 2], pts: &[[f64; 2]]) -> f64 {
    let mut best = f64::INFINITY;
    for (k, a) in pts.iter().enumerate() {
        let b = pts[(k + 1) % pts.len()];
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 {
            (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        best = best.min((p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy));
    }
    best
}

/// The x-mark vase of the sx-cli fixture `vase-request.json` (generic settings, 0.2 mm layers): there a block's side
/// steps in about a millimeter between some layers.
fn x_mark_fixture() -> String {
    let path = format!(
        "{}/cli/tests/fixtures/vase-request.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut req: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    req["options"]["shards"] = json!(1);
    req["plate"]["objects"][0]["transform"] = json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 128, 128, 0, 1]);
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let m = Arc::new(Mesh::load(&x_mark(), "x-mark.stl").unwrap());
    let r = api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

/// A spiral layer's loop: where its extrusions after the first end.
fn loop_of(l: &Layer) -> Vec<[f64; 2]> {
    l.moves
        .iter()
        .filter(|m| m.extrudes())
        .skip(1)
        .map(|m| [m.to[0], m.to[1]])
        .collect()
}

/// How a spiral layer starts: the layer, how far from its loop's start the nozzle is when it starts, its first
/// motion line with XY travel, and its loop and the loop below.
type Start = (usize, f64, Move, Vec<[f64; 2]>, Vec<[f64; 2]>);

/// Every spiral layer of `g` and how it starts.
fn spiral_starts(g: &str) -> Vec<Start> {
    let ls = part_layers(g);
    let mut out = Vec::new();
    for k in BASE + 1..ls.len() - 1 {
        let (below, here) = (loop_of(&ls[k - 1]), loop_of(&ls[k]));
        let Some(m) = ls[k].moves.iter().find(|m| m.xy() > 0.0) else {
            continue;
        };
        if below.len() < 3 || here.len() < 3 {
            continue;
        }
        let start = *here.last().unwrap();
        let d = (m.from[0] - start[0]).hypot(m.from[1] - start[1]);
        out.push((k, d, m.clone(), here, below));
    }
    out
}

/// How far the move `m` gets from both `here` and `below` at its farthest, sampled every 0.1 mm, ends included.
fn off_walls(m: &Move, here: &[[f64; 2]], below: &[[f64; 2]]) -> f64 {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a sample count"
    )]
    let n = ((m.xy() / 0.1).ceil() as usize).max(1);
    (0..=n)
        .map(|k| {
            #[allow(clippy::cast_precision_loss, reason = "a small sample index")]
            let t = k as f64 / n as f64;
            let p = [
                m.from[0] + t * (m.to[0] - m.from[0]),
                m.from[1] + t * (m.to[1] - m.from[1]),
            ];
            to_loop(p, here).min(to_loop(p, below))
        })
        .fold(0.0, f64::max)
}

/// The spiral layers of `g` whose first extrusion leaves the walls by more than a millimeter somewhere along it.
fn extruding_across(g: &str) -> Vec<(usize, f64, Move)> {
    spiral_starts(g)
        .into_iter()
        .filter(|(_, _, m, ..)| m.extrudes())
        .map(|(k, _, m, here, below)| (k, off_walls(&m, &here, &below), m))
        .filter(|(_, d, _)| *d > 1.0)
        .collect()
}

#[test]
fn a_spiral_layer_reaches_a_loop_away_from_the_last_one_without_extruding_across() {
    // On the x-mark the largest outline moves from the plate to one block, then between the blocks, so a layer's
    // loop can start tens of millimeters from where the layer below ended. Every extrusion that starts a spiral
    // layer runs along a wall the whole way: each point of it is within a millimeter of the layer's loop or the loop
    // below. A chord whose middle happens to land on the far block's wall still crosses the gap first. A loop that
    // starts away from the nozzle is reached by a travel.
    for (what, g) in [
        ("H2D", slice_mesh(&x_mark(), true, 1)),
        ("A1", slice_on("bambu-a1", &x_mark(), true, 1)),
        ("fixture", x_mark_fixture()),
    ] {
        if let Some((k, d, m)) = extruding_across(&g).first() {
            panic!(
                "{what} layer {k}: line {} extrudes {:.2} mm across the part, {d:.2} mm off the walls: {}",
                m.line,
                m.xy(),
                m.code
            );
        }
        let travels = spiral_starts(&g)
            .iter()
            .filter(|(_, _, m, ..)| m.code.starts_with("G0"))
            .count();
        assert!(travels >= 2, "{what}: {travels} layers travel to their loop");
    }
}

#[test]
fn a_spiral_layer_whose_wall_steps_in_a_millimeter_keeps_its_bead() {
    // On the fixture x-mark a block's side steps in about a millimeter between some layers: the nozzle goes on
    // down the side from where the layer below ended, extruding, with no travel and no gap in the seam.
    let starts = spiral_starts(&x_mark_fixture());
    let steps: Vec<_> = starts.iter().filter(|s| s.1 > 1.0 && s.1 < 2.0).collect();
    assert!(!steps.is_empty(), "no layer starts a millimeter off its loop");
    for (k, d, m, ..) in steps {
        assert!(
            m.extrudes(),
            "layer {k}, {d:.2} mm from its loop's start: line {} is {}",
            m.line,
            m.code
        );
    }
}

#[test]
fn the_chords_whose_middle_lands_on_a_wall_are_travels() {
    // Layers where the largest outline moves from one block to the other and the straight move to the new loop
    // ends with its middle on the far block's near wall: the first half crosses the gap, up to about 10 mm from
    // either block. These start with a travel, not an extrusion.
    for (what, g, layers) in [
        (
            "A1",
            slice_on("bambu-a1", &x_mark(), true, 1),
            [97, 100, 377].as_slice(),
        ),
        ("fixture", x_mark_fixture(), [91, 365].as_slice()),
    ] {
        let starts = spiral_starts(&g);
        for &k in layers {
            let (_, _, m, here, below) = starts
                .iter()
                .find(|s| s.0 == k)
                .unwrap_or_else(|| panic!("{what} layer {k} is a spiral layer"));
            assert!(
                !m.extrudes() && m.code.starts_with("G0"),
                "{what} layer {k}: line {} goes {:.2} mm to its loop, {:.2} mm off the walls, as {}",
                m.line,
                m.xy(),
                off_walls(m, here, below),
                m.code
            );
        }
    }
}
