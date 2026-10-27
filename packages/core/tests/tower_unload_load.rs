// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A single nozzle for several filaments on a type 2 tower unloads, cools, parks and loads the filament around each
//! tool change, with ramming on: the old filament's unload where its ramming stopped, the cooling moves one ramming
//! pitch on, the park, then after the change the new filament's load at the park point.
//!
//! 15 mm boxes on an MK4 with the MMU and a 60 mm type 2 tower at (20, 140): A 8 mm tall on filament 1 and B 3 mm on
//! filament 2, so every layer up to 3 mm changes filament once. Every ramming stops at X47.639 Y144.625; the wipe's
//! second row is Y145.5. Values are for the change on the second layer (filament 2 to 1) unless a test says so.

#![allow(clippy::disallowed_methods, reason = "test geometry, not engine output")]

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

/// An ASCII STL of a box from the origin to `size`.
fn box_stl(size: [f64; 3]) -> Vec<u8> {
    use std::fmt::Write as _;
    let corner = |index: usize| {
        std::array::from_fn::<f64, 3, _>(|axis| if index >> axis & 1 == 0 { 0.0 } else { size[axis] })
    };
    let faces: [[usize; 3]; 12] = [
        [0, 2, 1],
        [1, 2, 3],
        [4, 5, 6],
        [5, 7, 6],
        [0, 1, 4],
        [1, 5, 4],
        [2, 6, 3],
        [3, 6, 7],
        [0, 4, 2],
        [2, 4, 6],
        [1, 3, 5],
        [3, 7, 5],
    ];
    let mut text = String::from("solid box\n");
    for face in faces {
        text.push_str(" facet normal 0 0 0\n  outer loop\n");
        for index in face {
            let [x, y, z] = corner(index);
            let _ = writeln!(text, "   vertex {x} {y} {z}");
        }
        text.push_str("  endloop\n endfacet\n");
    }
    text.push_str("endsolid box\n");
    text.into_bytes()
}

/// The ramming of both filaments: 50 mm3 in lines 2.5 times the wall bead wide.
const RAM: &str = "250 100 40 40 40 40 40 | 0.05 40 0.45 40 0.95 40 1.45 40 1.95 40 2.45 40 2.95 40 3.45 40";

/// An MK4 with the MMU, two filaments and a 60 mm type 2 tower, with ramming on and the stock unload and load
/// settings; `extra` over it.
fn mmu(extra: &[(&str, Value)]) -> Value {
    let bench: Value = serde_json::from_slice(
        &std::fs::read(format!(
            "{}/bench/configs/reference-0.20.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    let mut cfg = bench["config"].clone();
    for (k, v) in [
        ("printer_model", json!("Prusa MK4")),
        ("gcode_flavor", json!("marlin2")),
        ("wipe_tower_type", json!("type2")),
        ("single_extruder_multi_material", json!("1")),
        ("use_relative_e_distances", json!("1")),
        ("printable_area", json!(["0x0", "250x0", "250x210", "0x210"])),
        ("filament_diameter", json!(["1.75", "1.75"])),
        ("filament_colour", json!(["#F4EE2A", "#00AE42"])),
        ("nozzle_temperature", json!(["220", "220"])),
        ("nozzle_temperature_initial_layer", json!(["220", "220"])),
        ("wipe_tower_x", json!(["20"])),
        ("wipe_tower_y", json!(["140"])),
        ("prime_tower_width", json!("60")),
        ("enable_prime_tower", json!(true)),
        ("prime_tower_auto_position", json!("0")),
        ("flush_volumes_matrix", json!(["0", "280", "280", "0"])),
        ("flush_multiplier", json!(["0.3"])),
        ("enable_filament_ramming", json!("1")),
        ("filament_ramming_parameters", json!([RAM, RAM])),
        ("cooling_tube_retraction", json!("91.5")),
        ("cooling_tube_length", json!("5")),
        ("parking_pos_retraction", json!("92")),
        ("extra_loading_move", json!("-2")),
        ("filament_cooling_moves", json!(["4", "4"])),
        ("filament_cooling_initial_speed", json!(["2.2", "2.2"])),
        ("filament_cooling_final_speed", json!(["3.4", "3.4"])),
        ("filament_loading_speed", json!(["28", "28"])),
        ("filament_loading_speed_start", json!(["3", "3"])),
        ("filament_unloading_speed", json!(["90", "90"])),
        ("filament_unloading_speed_start", json!(["100", "100"])),
        ("filament_toolchange_delay", json!(["0", "0"])),
        ("filament_stamping_distance", json!(["0", "0"])),
        ("filament_stamping_loading_speed", json!(["0", "0"])),
    ] {
        cfg[k] = v;
    }
    for (k, v) in extra {
        cfg[*k] = v.clone();
    }
    cfg
}

/// The G-code of box A (8 mm, filament 1) and box B (3 mm, filament 2) with `cfg`.
#[allow(clippy::needless_pass_by_value, reason = "the callers hand over fresh values")]
fn slice(cfg: Value) -> String {
    let objects: Vec<Value> = [(8.0, 102.5, 1), (3.0, 132.5, 2)]
        .iter()
        .enumerate()
        .map(|(k, &(h, x, slot))| {
            json!({"id": format!("o{k}"), "name": format!("box {k}"), "mesh": format!("15 15 {h}"),
                   "slotOverrides": {"box": slot, "box.stl": slot, "": slot},
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x - 7.5, 95, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": 250, "depthMm": 210, "heightMm": 220}, "objects": objects},
        "config": cfg,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let load = |id: &str| -> sx_core::Result<Arc<Mesh>> {
        let s: Vec<f64> = id.split(' ').map(|v| v.parse().unwrap()).collect();
        Ok(Arc::new(
            Mesh::load(&box_stl([s[0], s[1], s[2]]), "box.stl").unwrap(),
        ))
    };
    let run = api::run_request(&req, &load).unwrap();
    String::from_utf8_lossy(&run.gcode).into_owned()
}

/// One line of G-code: a `G0`/`G1` move with the words it sets, or any other line as written (comments dropped).
#[derive(Debug, Clone, PartialEq)]
enum Line {
    Move {
        x: Option<f64>,
        y: Option<f64>,
        z: Option<f64>,
        e: Option<f64>,
        f: Option<f64>,
    },
    Other(String),
}

impl Line {
    fn parse(text: &str) -> Option<Self> {
        let body = text.split(';').next().unwrap_or("").trim();
        if body.is_empty() || body.starts_with("M73 ") {
            return None;
        }
        let mut words = body.split_whitespace();
        let cmd = words.next()?;
        if cmd != "G0" && cmd != "G1" {
            return Some(Self::Other(body.to_owned()));
        }
        // X, Y, Z, E and F, as the line sets them.
        let mut words_set: [Option<f64>; 5] = [None; 5];
        for word in words {
            let value = word.get(1..).and_then(|v| v.parse::<f64>().ok());
            if let Some(slot) = word
                .chars()
                .next()
                .and_then(|k| "XYZEF".find(k))
                .and_then(|i| words_set.get_mut(i))
            {
                *slot = value;
            }
        }
        let [x_mm, y_mm, z_mm, e_mm, feed] = words_set;
        // A line that only sets the feed moves nothing.
        (x_mm.is_some() || y_mm.is_some() || z_mm.is_some() || e_mm.is_some()).then_some(Self::Move {
            x: x_mm,
            y: y_mm,
            z: z_mm,
            e: e_mm,
            f: feed,
        })
    }
}

/// One tool change: the layer it is on (1 for the first), the filament it loads (1-based) and the lines from the
/// previous change (or the first layer's start) to the `T`, and from the `T` to the next change.
#[derive(Debug)]
struct Change {
    layer: usize,
    to: u8,
    before: Vec<Line>,
    after: Vec<Line>,
}

fn changes(gcode: &str) -> Vec<Change> {
    let mut out: Vec<Change> = Vec::new();
    let (mut layer, mut tool) = (0usize, None::<u8>);
    let mut since: Vec<Line> = Vec::new();
    for text in gcode.lines() {
        let s = text.trim();
        if s.starts_with(";LAYER_CHANGE") || s.starts_with("; CHANGE_LAYER") {
            layer += 1;
        }
        let t = s
            .strip_prefix("; MANUAL_TOOL_CHANGE ")
            .unwrap_or(s)
            .strip_prefix('T')
            .and_then(|t| t.parse::<u8>().ok());
        if let Some(t) = t {
            if layer > 0 && tool.is_some_and(|was| was != t) {
                if let Some(last) = out.last_mut() {
                    last.after.clone_from(&since);
                }
                out.push(Change {
                    layer,
                    to: t + 1,
                    before: std::mem::take(&mut since),
                    after: Vec::new(),
                });
            }
            tool = Some(t);
            since.clear();
            continue;
        }
        if layer > 0
            && let Some(l) = Line::parse(s)
        {
            since.push(l);
        }
    }
    if let Some(last) = out.last_mut() {
        last.after = since;
    }
    out
}

/// The change on layer `layer` into filament `to`.
fn change(all: &[Change], layer: usize, to: u8) -> &Change {
    all.iter()
        .find(|c| c.layer == layer && c.to == to)
        .unwrap_or_else(|| panic!("no change into {to} on layer {layer}: {all:?}"))
}

/// A move the test expects: the words it must set (None: any).
#[derive(Debug, Clone, Copy, Default)]
struct Want {
    x: Option<f64>,
    y: Option<f64>,
    e: Option<f64>,
    f: Option<f64>,
    /// The move has no X or Y.
    in_place: bool,
}

fn e_at(e: f64, f: f64) -> Want {
    Want {
        e: Some(e),
        f: Some(f),
        in_place: true,
        ..Want::default()
    }
}

fn x_e_at(x: f64, e: f64, f: f64) -> Want {
    Want {
        x: Some(x),
        e: Some(e),
        f: Some(f),
        ..Want::default()
    }
}

fn near(a: Option<f64>, b: Option<f64>, tol: f64) -> bool {
    match (a, b) {
        (_, None) => true,
        (Some(a), Some(b)) => (a - b).abs() <= tol,
        (None, Some(_)) => false,
    }
}

fn matches(l: &Line, w: &Want) -> bool {
    match l {
        Line::Move { x, y, e, f, .. } => {
            near(*x, w.x, 1e-3)
                && near(*y, w.y, 1e-3)
                && near(*e, w.e, 1e-3)
                && near(*f, w.f, 0.0)
                && (!w.in_place || (x.is_none() && y.is_none()))
        }
        Line::Other(_) => false,
    }
}

/// The moves only (no other lines).
fn moves(lines: &[Line]) -> Vec<&Line> {
    lines.iter().filter(|l| matches!(l, Line::Move { .. })).collect()
}

/// Where `want` runs as consecutive moves in `lines` (other lines between them are skipped).
fn find_run(lines: &[Line], want: &[Want]) -> Option<usize> {
    let ms = moves(lines);
    (0..ms.len()).find(|&i| {
        want.iter()
            .enumerate()
            .all(|(k, w)| ms.get(i + k).is_some_and(|m| matches(m, w)))
    })
}

#[track_caller]
fn assert_run(lines: &[Line], want: &[Want]) -> usize {
    find_run(lines, want).unwrap_or_else(|| panic!("no run {want:?} in {lines:#?}"))
}

/// The stock unload: 94 mm in four moves.
fn stock_unload() -> Vec<Want> {
    vec![
        e_at(-15.0, 6000.0),
        e_at(-55.3, 5400.0),
        e_at(-15.8, 2700.0),
        e_at(-7.9, 1620.0),
    ]
}

/// The stock cooling, from X47.639 to X79.25 and back four times.
fn stock_cooling() -> Vec<Want> {
    [835.0, 900.0, 965.0, 1030.0, 1095.0, 1160.0, 1225.0, 1290.0]
        .iter()
        .enumerate()
        .map(|(i, &f)| {
            if i % 2 == 0 {
                x_e_at(79.25, 5.0, f)
            } else {
                x_e_at(47.639, -5.0, f)
            }
        })
        .collect()
}

#[test]
fn the_old_filament_unloads_cools_and_parks_and_the_new_one_loads() {
    let all = changes(&slice(mmu(&[])));
    assert!(all.len() >= 10, "{} changes", all.len());
    let c = change(&all, 2, 1);
    let ms = moves(&c.before);
    // Right after the last ramming piece: the unload with no XY.
    let mut want = vec![Want {
        x: Some(47.639),
        y: Some(144.625),
        ..Want::default()
    }];
    want.extend(stock_unload());
    let at = assert_run(&c.before, &want);
    // A travel one ramming pitch on, the cooling, the park and the travel to the wipe's second row.
    let mut cool = vec![Want {
        x: None,
        y: Some(145.875),
        e: None,
        f: None,
        in_place: false,
    }];
    cool.extend(stock_cooling());
    cool.push(e_at(2.0, 2000.0));
    cool.push(Want {
        y: Some(145.5),
        ..Want::default()
    });
    let cooled = assert_run(&c.before, &cool);
    assert_eq!(cooled, at + want.len(), "{ms:#?}");
    // After the change: back to the park point, primed, and the load there.
    let load = [
        e_at(18.0, 180.0),
        Want {
            x: Some(79.375),
            y: Some(145.5),
            e: Some(63.0),
            f: Some(846.0),
            in_place: false,
        },
        Want {
            x: Some(47.639),
            y: Some(145.5),
            e: Some(9.0),
            f: Some(592.0),
            in_place: false,
        },
    ];
    let loaded = assert_run(&c.after, &load);
    let after = moves(&c.after);
    let back = after
        .iter()
        .position(|m| {
            matches(
                m,
                &Want {
                    x: Some(47.639),
                    y: Some(145.5),
                    ..Want::default()
                },
            )
        })
        .unwrap();
    assert!(back < loaded, "{after:#?}");
    // The new filament's tower block follows without a retraction: its wall, then the wipe from X47.639 Y145.
    let next = after.get(loaded + 3).copied();
    assert!(
        matches!(next, Some(Line::Move { e: None, .. })),
        "a travel after the load: {after:#?}"
    );
    assert!(
        after.iter().skip(loaded + 3).take(2).all(|m| match m {
            Line::Move { e: Some(e), .. } => *e > 0.0,
            _ => true,
        }),
        "{after:#?}"
    );
    assert_run(
        &c.after,
        &[
            Want {
                x: Some(47.639),
                y: Some(145.0),
                ..Want::default()
            },
            Want {
                x: Some(21.0),
                y: Some(145.0),
                ..Want::default()
            },
        ],
    );
}

#[test]
fn the_unload_follows_cooling_tube_retraction() {
    let all = changes(&slice(mmu(&[("cooling_tube_retraction", json!("80"))])));
    let c = change(&all, 2, 1);
    assert_run(
        &c.before,
        &[
            e_at(-15.0, 6000.0),
            e_at(-47.25, 5400.0),
            e_at(-13.5, 2700.0),
            e_at(-6.75, 1620.0),
        ],
    );
    assert_run(&c.before, &[e_at(-9.5, 2000.0)]);
}

#[test]
fn the_park_and_load_follow_parking_pos_retraction() {
    let all = changes(&slice(mmu(&[("parking_pos_retraction", json!("85"))])));
    let c = change(&all, 2, 1);
    assert_run(&c.before, &[e_at(9.0, 2000.0)]);
    assert_run(
        &c.after,
        &[
            e_at(16.6, 180.0),
            x_e_at(79.375, 58.1, 918.0),
            x_e_at(47.639, 8.3, 642.0),
        ],
    );
}

/// The cooling moves' feeds of a change.
fn cooling_feeds(c: &Change) -> Vec<f64> {
    moves(&c.before)
        .iter()
        .filter_map(|m| match m {
            Line::Move {
                x: Some(_),
                e: Some(e),
                f: Some(f),
                ..
            } if (e.abs() - 5.0).abs() < 1e-6 => Some(*f),
            _ => None,
        })
        .collect()
}

#[test]
fn the_cooling_is_the_old_filaments() {
    let all = changes(&slice(mmu(&[("filament_cooling_moves", json!(["2", "6"]))])));
    assert_eq!(cooling_feeds(change(&all, 1, 2)), [835.0, 986.0, 1138.0, 1290.0]);
    assert_eq!(cooling_feeds(change(&all, 2, 1)).len(), 12);
}

#[test]
fn the_load_is_the_new_filaments() {
    let all = changes(&slice(mmu(&[
        ("filament_loading_speed", json!(["40", "28"])),
        ("filament_loading_speed_start", json!(["10", "3"])),
    ])));
    assert_run(
        &change(&all, 2, 1).after,
        &[
            e_at(18.0, 600.0),
            x_e_at(79.375, 63.0, 1209.0),
            x_e_at(47.639, 9.0, 846.0),
        ],
    );
    assert_run(
        &change(&all, 1, 2).after,
        &[
            e_at(18.0, 180.0),
            x_e_at(79.375, 63.0, 846.0),
            x_e_at(47.639, 9.0, 592.0),
        ],
    );
}

#[test]
fn the_unload_is_the_old_filaments() {
    let all = changes(&slice(mmu(&[
        ("filament_unloading_speed", json!(["50", "90"])),
        ("filament_unloading_speed_start", json!(["60", "100"])),
    ])));
    assert_run(
        &change(&all, 1, 2).before,
        &[
            e_at(-15.0, 3600.0),
            e_at(-55.3, 3000.0),
            e_at(-15.8, 1500.0),
            e_at(-7.9, 900.0),
        ],
    );
}

#[test]
fn a_cooling_move_past_50_mm_s_is_cut_short() {
    let all = changes(&slice(mmu(&[
        ("filament_cooling_initial_speed", json!(["5", "5"])),
        ("filament_cooling_final_speed", json!(["10", "10"])),
    ])));
    let c = change(&all, 2, 1);
    let ms = moves(&c.before);
    let cool: Vec<(f64, f64)> = ms
        .iter()
        .filter_map(|m| match m {
            Line::Move {
                x: Some(x),
                e: Some(e),
                f: Some(f),
                ..
            } if (e.abs() - 5.0).abs() < 1e-6 => Some((*x, *f)),
            _ => None,
        })
        .collect();
    assert_eq!(cool.len(), 8, "{ms:#?}");
    // Moves 6 to 8 run at 50 mm/s, 29.167, 26.923 and 25 mm long, each from where the one before ended.
    let mut x = cool.get(4).unwrap().0;
    for (k, len) in [(5, -29.167), (6, 26.923), (7, -25.0)] {
        let (to, f) = cool[k];
        assert!((f - 3000.0).abs() < 1e-9, "{cool:?}");
        assert!((to - (x + len)).abs() < 2e-3, "move {}: {cool:?}", k + 1);
        x = to;
    }
    // Then back to X47.639 with the park.
    assert_run(
        &c.before,
        &[
            e_at(2.0, 2000.0),
            Want {
                x: Some(47.639),
                y: Some(145.5),
                ..Want::default()
            },
        ],
    );
}

#[test]
fn a_fast_load_move_is_cut_short() {
    let all = changes(&slice(mmu(&[
        ("cooling_tube_retraction", json!("20")),
        ("parking_pos_retraction", json!("25")),
    ])));
    assert_run(
        &change(&all, 2, 1).after,
        &[
            e_at(4.6, 180.0),
            x_e_at(76.389, 16.1, 3000.0),
            x_e_at(47.639, 2.3, 2100.0),
        ],
    );
}

#[test]
fn stamping_follows_every_cooling_pair_but_the_last() {
    let all = changes(&slice(mmu(&[
        ("filament_stamping_loading_speed", json!(["20", "20"])),
        ("filament_stamping_distance", json!(["10", "10"])),
    ])));
    let c = change(&all, 2, 1);
    let stamp = [
        x_e_at(67.639, 7.5, 3200.0),
        x_e_at(47.639, 5.0, 4800.0),
        e_at(-12.5, 5400.0),
    ];
    for pair in [900.0, 1030.0, 1160.0] {
        let mut want = vec![x_e_at(47.639, -5.0, pair)];
        want.extend(stamp);
        assert_run(&c.before, &want);
    }
    let mut last = vec![x_e_at(47.639, -5.0, 1290.0)];
    last.push(e_at(2.0, 2000.0));
    assert_run(&c.before, &last);
}

#[test]
fn the_toolchange_delay_waits_before_the_park() {
    let all = changes(&slice(mmu(&[("filament_toolchange_delay", json!(["2", "2"]))])));
    let c = change(&all, 2, 1);
    let at = c
        .before
        .iter()
        .position(|l| *l == Line::Other("G4 S2.000".into()))
        .unwrap_or_else(|| panic!("{:#?}", c.before));
    assert!(matches(&c.before[at + 1], &e_at(2.0, 2000.0)), "{:#?}", c.before);
}

#[test]
fn without_ramming_lines_the_cooling_spans_the_tower() {
    let all = changes(&slice(mmu(&[("filament_ramming_parameters", json!(["", ""]))])));
    let c = change(&all, 2, 1);
    assert_run(&c.before, &stock_unload());
    let feeds = cooling_feeds(c);
    assert_eq!(feeds.first(), Some(&1544.0), "{:#?}", c.before);
    assert_eq!(feeds.last(), Some(&2387.0), "{:#?}", c.before);
    let mut want = vec![x_e_at(79.25, 5.0, 1544.0)];
    want.push(x_e_at(20.75, -5.0, 1665.0));
    assert_run(&c.before, &want);
    assert_run(&c.before, &[e_at(2.0, 2000.0)]);
    let after = moves(&c.after);
    assert!(after.iter().any(|m| matches(m, &e_at(18.0, 180.0))), "{after:#?}");
    assert!(
        find_run(
            &c.after,
            &[
                e_at(18.0, 180.0),
                Want {
                    e: Some(63.0),
                    ..Want::default()
                },
                Want {
                    x: Some(20.75),
                    e: Some(9.0),
                    ..Want::default()
                }
            ]
        )
        .is_some(),
        "{after:#?}"
    );
}

/// None of a single nozzle's change moves: no unload, park or load, and no plain temperature line at a change.
#[track_caller]
fn assert_untouched(gcode: &str) {
    let all = changes(gcode);
    assert!(!all.is_empty());
    for c in &all {
        assert!(find_run(&c.before, &[e_at(-15.0, 6000.0)]).is_none(), "{c:?}");
        assert!(find_run(&c.before, &[e_at(2.0, 2000.0)]).is_none(), "{c:?}");
        assert!(find_run(&c.after, &[e_at(18.0, 180.0)]).is_none(), "{c:?}");
        assert!(
            !c.before
                .iter()
                .any(|l| matches!(l, Line::Other(t) if t.starts_with("M104 ") && !t.contains(" T"))),
            "{c:?}"
        );
    }
}

#[test]
fn a_type_1_tower_gets_none_of_it() {
    let temps = [
        ("nozzle_temperature", json!(["220", "228"])),
        ("nozzle_temperature_initial_layer", json!(["212", "225"])),
    ];
    let mut bambu = temps.to_vec();
    bambu.push(("printer_model", json!("Bambu Lab P1S")));
    assert_untouched(&slice(mmu(&bambu)));
    let mut type1 = temps.to_vec();
    type1.push(("wipe_tower_type", json!("type1")));
    assert_untouched(&slice(mmu(&type1)));
}

#[test]
fn ramming_off_or_a_tool_changer_gets_no_moves() {
    let all = changes(&slice(mmu(&[("enable_filament_ramming", json!("0"))])));
    assert!(!all.is_empty());
    for c in &all {
        assert!(find_run(&c.before, &[e_at(-15.0, 6000.0)]).is_none(), "{c:?}");
        assert!(find_run(&c.after, &[e_at(18.0, 180.0)]).is_none(), "{c:?}");
    }
    assert_untouched(&slice(mmu(&[
        ("single_extruder_multi_material", json!("0")),
        ("nozzle_diameter", json!(["0.4", "0.4"])),
    ])));
}
