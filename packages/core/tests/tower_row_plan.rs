// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The rows a Bambu Lab type prime tower wipes after each change, and which filament prints which part of a tower
//! layer.
//!
//! - Each change wipes the new filament's `filament_prime_volume` (45 mm3 when the settings list none for it) in
//!   whole rows across the tower: ceil(L / R) rows, L the volume as a length of a rounded bead and R the row length.
//!   `prime_volume` is not read there; `prime_volume_mode` Saving wipes 15 mm3.
//! - The first layer fills the same depth with rows one bead apart: floor(n x gap) of them.
//! - A change into a filament whose adhesion category comes back onto the tower is a contact change: the same
//!   dense rows, no nozzle wipe, speeding up to 20 mm/s. Each category wipes in a block of its own.
//! - The wall goes with one filament for the whole print, and each part of a layer with the filament the rules
//!   pick (before, between or after the layer's changes).
//!
//! Our own boxes on the stock A1 request fixture, fixed 0.2 mm layers.

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

/// One box of a plate: its size, front left corner and filament slot.
struct Part {
    size: [f64; 3],
    at: [f64; 2],
    slot: u8,
}

fn part(size: [f64; 3], at: [f64; 2], slot: u8) -> Part {
    Part { size, at, slot }
}

/// The stock A1 request's settings with `filaments` filaments (each list padded with its last value), the tower on,
/// fixed layers and no flush into infill or support, so every wipe is the whole prime volume; `extra` over it.
fn config(filaments: usize, extra: &[(&str, Value)]) -> Value {
    let path = format!(
        "{}/cli/tests/fixtures/xmark-2color-a1-request.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let req: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut cfg = req["config"].clone();
    for v in cfg.as_object_mut().unwrap().values_mut() {
        if let Some(a) = v.as_array_mut()
            && a.len() == 2
        {
            let last = a[1].clone();
            a.resize(filaments.max(2), last);
            a.truncate(filaments.max(1));
        }
    }
    cfg["filament_colour"] = json!(["#F4EE2A", "#00AE42", "#1E5AA8", "#C12E1F"][..filaments]);
    cfg["enable_prime_tower"] = json!(true);
    cfg["smart_layer"] = json!("off");
    cfg["flush_into_infill"] = json!(false);
    cfg["flush_into_support"] = json!(false);
    cfg["filament_adhesiveness_category"] = json!(vec![100; filaments]);
    cfg["filament_prime_volume"] = json!(vec![45; filaments]);
    for (k, v) in extra {
        if v.is_null() {
            cfg.as_object_mut().unwrap().remove(*k);
        } else {
            cfg[*k] = v.clone();
        }
    }
    cfg
}

/// Slices `parts` with settings `cfg` (and `settings` on the plate's one object): the G-code and the tower's depth.
#[allow(clippy::needless_pass_by_value, reason = "the callers hand over fresh values")]
fn slice_with(cfg: Value, parts: &[Part], settings: Option<Value>) -> (String, f64) {
    let objects: Vec<Value> = parts
        .iter()
        .enumerate()
        .map(|(k, p)| {
            let mesh = format!("{} {} {}", p.size[0], p.size[1], p.size[2]);
            let mut o = json!({"id": format!("o{k}"), "name": format!("box {k}"), "mesh": mesh,
                   "slotOverrides": {"box": p.slot, "box.stl": p.slot, "": p.slot},
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p.at[0], p.at[1], 0, 1]});
            if let Some(s) = &settings {
                o["settings"] = s.clone();
            }
            o
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": 256, "depthMm": 256, "heightMm": 256}, "objects": objects},
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
    let depth = run.report.prime_tower.as_ref().map_or(0.0, |t| t.depth);
    (String::from_utf8_lossy(&run.gcode).into_owned(), depth)
}

fn slice(filaments: usize, parts: &[Part], extra: &[(&str, Value)]) -> String {
    slice_with(config(filaments, extra), parts, None).0
}

/// Two 20 mm boxes 2 mm tall on filaments 1 and 2 on a rectangle tower whose rows are `row` mm long, so every layer
/// changes filament once.
fn two_boxes(row: f64, extra: &[(&str, Value)]) -> String {
    let mut all: Vec<(&str, Value)> = vec![
        ("wipe_tower_wall_type", json!("rectangle")),
        ("prime_tower_width", json!(row + 1.0)),
    ];
    all.extend(extra.iter().cloned());
    slice(
        2,
        &[
            part([20.0, 20.0, 2.0], [60.0, 60.0], 1),
            part([20.0, 20.0, 2.0], [120.0, 60.0], 2),
        ],
        &all,
    )
}

/// One extruding move on the tower.
#[derive(Debug, Clone)]
struct Seg {
    layer: usize,
    tool: u8,
    from: [f64; 2],
    to: [f64; 2],
    e: f64,
    /// The layer's changes before it.
    changes_before: usize,
    /// The change whose rows it belongs to.
    rows_of: Option<usize>,
}

/// One change's wipe.
#[derive(Debug, Clone, Default)]
struct Change {
    layer: usize,
    tool: u8,
    /// The rows' heights, in order.
    rows: Vec<f64>,
    /// The feeds the rows print at, each new one once.
    feeds: Vec<f64>,
    /// The nozzle wipe at the row start (its slow travel back).
    nozzle_wipe: bool,
    /// Filament the rows themselves extrude (without the steps between them), mm.
    row_e: f64,
}

/// The tower of a G-code: its extruding moves, the changes' wipes and each layer's starting filament.
struct TowerCode {
    segs: Vec<Seg>,
    changes: Vec<Change>,
    starts: Vec<u8>,
}

fn tower(gcode: &str) -> TowerCode {
    let (mut segs, mut changes, mut starts) = (Vec::new(), Vec::<Change>::new(), Vec::new());
    let (mut layer, mut tool, mut at) = (usize::MAX, 0u8, [0.0, 0.0]);
    let (mut tower_feature, mut in_rows, mut extruded, mut f) = (false, false, false, 0.0);
    let mut in_layer = 0usize;
    for line in gcode.lines() {
        let s = line.trim();
        if s.starts_with("; CHANGE_LAYER") {
            layer = layer.wrapping_add(1);
            starts.push(tool);
            in_layer = 0;
            continue;
        }
        if let Some(name) = s.strip_prefix("; FEATURE:") {
            tower_feature = name.trim() == "Prime tower";
            continue;
        }
        if s == "; CP TOOLCHANGE WIPE" {
            changes.push(Change {
                layer,
                tool,
                ..Change::default()
            });
            in_layer += 1;
            (in_rows, extruded) = (true, false);
            continue;
        }
        if s.starts_with("; CP TOOLCHANGE END") || s.starts_with("; WIPE_TOWER_END") {
            in_rows = false;
        }
        if let Some(n) = s.strip_prefix("M1020 S") {
            tool = n.trim().parse::<u8>().unwrap() + 1;
            continue;
        }
        let code = s.split(';').next().unwrap_or("").trim();
        if !(code.starts_with("G0 ")
            || code.starts_with("G1 ")
            || code.starts_with("G2 ")
            || code.starts_with("G3 "))
        {
            continue;
        }
        let word = |c: char| {
            code.split_whitespace()
                .skip(1)
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        if let Some(v) = word('F') {
            f = v;
        }
        if code.starts_with("G0 ") && extruded {
            in_rows = false;
        }
        let to = [word('X').unwrap_or(at[0]), word('Y').unwrap_or(at[1])];
        let moved = word('X').is_some() || word('Y').is_some();
        let e = word('E').unwrap_or(0.0);
        if in_rows
            && moved
            && e == 0.0
            && (f - 600.0).abs() < 1e-9
            && let Some(c) = changes.last_mut()
        {
            c.nozzle_wipe = true;
        }
        if tower_feature && moved && e > 0.0 && layer != usize::MAX && tool != 0 {
            let rows_of = in_rows.then(|| changes.len() - 1);
            if let Some(c) = rows_of.and_then(|k| changes.get_mut(k))
                && (to[1] - at[1]).abs() < 1e-6
            {
                c.row_e += e;
                if c.rows.last().is_none_or(|y| (y - to[1]).abs() > 1e-6) {
                    c.rows.push(to[1]);
                }
                if c.feeds.last() != Some(&f) {
                    c.feeds.push(f);
                }
            }
            segs.push(Seg {
                layer,
                tool,
                from: at,
                to,
                e,
                changes_before: in_layer,
                rows_of,
            });
            extruded = true;
        }
        at = to;
    }
    TowerCode {
        segs,
        changes,
        starts,
    }
}

/// The rows' x range on the tower: where every row starts and ends.
fn row_span(t: &TowerCode) -> (f64, f64) {
    let rows = t
        .segs
        .iter()
        .filter(|s| s.rows_of.is_some() && (s.to[1] - s.from[1]).abs() < 1e-6);
    rows.fold((f64::MAX, f64::MIN), |m, s| {
        (m.0.min(s.from[0].min(s.to[0])), m.1.max(s.from[0].max(s.to[0])))
    })
}

/// The tower's wall moves: not a change's rows, and off the rows' span or not along an axis (the fill's outline and
/// lines lie inside the span, along the axes).
fn walls(t: &TowerCode) -> Vec<&Seg> {
    let (x0, x1) = row_span(t);
    t.segs
        .iter()
        .filter(|s| s.rows_of.is_none())
        .filter(|s| {
            let inside = s.from[0].min(s.to[0]) > x0 + 0.1 && s.from[0].max(s.to[0]) < x1 - 0.1;
            let along = (s.to[0] - s.from[0]).abs() < 1e-6 || (s.to[1] - s.from[1]).abs() < 1e-6;
            !(inside && along)
        })
        .collect()
}

/// Filament (mm of it) a filament's tower moves extrude, by slot.
fn tower_e(t: &TowerCode, keep: &dyn Fn(&Seg) -> bool) -> Vec<f64> {
    let mut out = vec![0.0; 5];
    for s in t.segs.iter().filter(|s| keep(s)) {
        out[usize::from(s.tool)] += s.e;
    }
    out
}

/// Cross-section of a 0.5 mm bead 0.2 mm tall with rounded edges, mm2.
const BEAD: f64 = 0.2 * (0.5 - 0.2 * (1.0 - std::f64::consts::FRAC_PI_4));

/// Rows of `row` mm a wipe of `volume` mm3 takes.
fn rows_for(volume: f64, row: f64) -> usize {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let n = (volume / (BEAD * row)).ceil() as usize;
    n
}

/// Filament cross-section, mm2 (1.75 mm).
const AREA: f64 = std::f64::consts::PI * 0.875 * 0.875;

#[test]
fn each_change_wipes_the_new_filaments_prime_volume() {
    let row = 19.5;
    let t = tower(&two_boxes(row, &[("filament_prime_volume", json!([45, 20]))]));
    let later: Vec<&Change> = t.changes.iter().filter(|c| c.layer > 0).collect();
    assert!(later.len() >= 5, "{}", later.len());
    for (slot, volume) in [(1u8, 45.0), (2, 20.0)] {
        let into: Vec<&&Change> = later.iter().filter(|c| c.tool == slot).collect();
        assert!(!into.is_empty(), "changes into filament {slot}");
        for c in into {
            assert_eq!(
                c.rows.len(),
                rows_for(volume, row),
                "into {slot} on layer {}",
                c.layer
            );
            // Whole rows: at least the volume, less than a row over.
            let mm3 = c.row_e * AREA;
            assert!(
                mm3 >= volume - 0.01 && mm3 < volume + BEAD * row + 0.5,
                "{mm3} for {volume}"
            );
        }
    }
    assert_eq!(rows_for(45.0, row), 26);
}

#[test]
fn three_changes_on_a_layer_each_wipe_by_their_new_filament() {
    let row = 19.5;
    let gcode = slice(
        3,
        &[
            part([15.0, 15.0, 2.0], [60.0, 60.0], 1),
            part([15.0, 15.0, 2.0], [100.0, 60.0], 2),
            part([15.0, 15.0, 2.0], [140.0, 60.0], 3),
        ],
        &[
            ("wipe_tower_wall_type", json!("rectangle")),
            ("prime_tower_width", json!(row + 1.0)),
            ("filament_prime_volume", json!([45, 20, 30])),
        ],
    );
    let t = tower(&gcode);
    let mut places = std::collections::BTreeSet::new();
    for layer in 1..t.starts.len() {
        for (k, c) in t.changes.iter().filter(|c| c.layer == layer).enumerate() {
            let volume = [0.0, 45.0, 20.0, 30.0][usize::from(c.tool)];
            assert_eq!(c.rows.len(), rows_for(volume, row), "{c:?}");
            places.insert((k, c.tool));
        }
    }
    // The changes came both first and second on their layers.
    assert!(
        places.iter().any(|p| p.0 == 0) && places.iter().any(|p| p.0 == 1),
        "{places:?}"
    );
}

#[test]
fn a_filament_without_a_listed_prime_volume_wipes_45() {
    let row = 19.5;
    // No list at all: 45 for both, whatever `prime_volume` says.
    let absent = tower(&two_boxes(
        row,
        &[
            ("filament_prime_volume", Value::Null),
            ("prime_volume", json!(15)),
        ],
    ));
    assert!(absent.changes.len() > 5);
    for c in absent.changes.iter().filter(|c| c.layer > 0) {
        assert_eq!(c.rows.len(), 26, "{c:?}");
    }
    // A list shorter than the filaments: filament 2 has no value and gets 45, filament 1 keeps its own.
    let short = tower(&two_boxes(row, &[("filament_prime_volume", json!([20]))]));
    for c in short.changes.iter().filter(|c| c.layer > 0) {
        assert_eq!(c.rows.len(), if c.tool == 1 { 12 } else { 26 }, "{c:?}");
    }
    // A listed value wins over the 45, as the stock Bambu Lab filaments' 30 does.
    let stock = tower(&two_boxes(row, &[("filament_prime_volume", json!(["30", "30"]))]));
    for c in stock.changes.iter().filter(|c| c.layer > 0) {
        assert_eq!(c.rows.len(), rows_for(30.0, row), "{c:?}");
    }
}

#[test]
fn the_legacy_prime_volume_moves_no_row_on_a_bambu_tower() {
    let rows = |extra: &[(&str, Value)]| -> Vec<(usize, u8, usize)> {
        tower(&two_boxes(19.5, extra))
            .changes
            .iter()
            .map(|c| (c.layer, c.tool, c.rows.len()))
            .collect()
    };
    let with = rows(&[("prime_volume", json!(15))]);
    assert!(with.len() > 5);
    assert_eq!(with, rows(&[("prime_volume", json!(45))]));
}

#[test]
fn saving_mode_wipes_15_mm3_a_change() {
    let t = tower(&two_boxes(19.5, &[("prime_volume_mode", json!("Saving"))]));
    assert!(t.changes.len() > 5);
    for c in t.changes.iter().filter(|c| c.layer > 0) {
        assert_eq!(c.rows.len(), rows_for(15.0, 19.5), "{c:?}");
    }
}

#[test]
fn the_row_count_follows_the_row_length() {
    for (row, n) in [(22.0, 23), (19.5, 26)] {
        let t = tower(&two_boxes(row, &[]));
        assert!(t.changes.len() > 5);
        for c in t.changes.iter().filter(|c| c.layer > 0) {
            assert_eq!(c.rows.len(), n, "{row} mm rows: {c:?}");
        }
    }
}

#[test]
fn the_first_layer_packs_its_rows_one_bead_apart() {
    let t = tower(&two_boxes(19.5, &[]));
    let first: Vec<&Change> = t.changes.iter().filter(|c| c.layer == 0).collect();
    assert_eq!(first.len(), 1, "one change on the first layer");
    let c = first[0];
    // floor(26 x 1.5): the depth of 26 rows at 0.75 mm, one bead (0.5 mm) apart.
    assert_eq!(c.rows.len(), 39);
    for w in c.rows.windows(2) {
        assert!(((w[1] - w[0]).abs() - 0.5).abs() < 1e-3, "{:?}", c.rows);
    }
    let later = t.changes.iter().find(|c| c.layer > 0).unwrap();
    assert!(((later.rows[1] - later.rows[0]).abs() - 0.75).abs() < 1e-3);
    // With the gap at 200%: floor(26 x 2) rows.
    let wide = tower(&two_boxes(19.5, &[("prime_tower_infill_gap", json!(200))]));
    let c = wide.changes.iter().find(|c| c.layer == 0).unwrap();
    assert_eq!(c.rows.len(), 52);
}

/// A 20 x 20 x 6 mm box on filament 1 whose internal solid infill prints with filament 2, so filament 2 is on the tower
/// for the bottom shell, leaves it, and comes back under the top shell; categories `cats`.
fn contact_case(cats: Value) -> TowerCode {
    let cfg = config(
        2,
        &[
            ("filament_adhesiveness_category", cats),
            ("wipe_tower_wall_type", json!("rectangle")),
            ("prime_tower_width", json!(20.5)),
        ],
    );
    let (gcode, _) = slice_with(
        cfg,
        &[part([20.0, 20.0, 6.0], [100.0, 100.0], 1)],
        Some(json!({"solid_infill_filament": 2})),
    );
    tower(&gcode)
}

#[test]
fn a_category_back_on_the_tower_gets_a_contact_wipe() {
    let t = contact_case(json!([100, 300]));
    let into2: Vec<&Change> = t.changes.iter().filter(|c| c.tool == 2).collect();
    // The layers filament 2 comes back on: a change into it after a layer with no change (filament 1 alone).
    let back: Vec<usize> = into2
        .iter()
        .map(|c| c.layer)
        .filter(|&l| l > 0 && !t.changes.iter().any(|o| o.layer + 1 == l))
        .collect();
    assert_eq!(back.len(), 1, "filament 2 comes back once: {into2:?}");
    for c in &t.changes {
        let contact = c.tool == 2 && back.contains(&c.layer);
        assert_eq!(!c.nozzle_wipe, contact, "{c:?}");
        if contact {
            // The normal rows' depth at one bead apart: floor(26 x 1.5), feeds up to 20 mm/s.
            assert_eq!(c.rows.len(), 39, "{c:?}");
            for w in c.rows.windows(2) {
                assert!(((w[1] - w[0]).abs() - 0.5).abs() < 1e-3);
            }
            assert_eq!(c.feeds, vec![396.0, 450.0, 550.0, 1050.0, 1100.0], "{c:?}");
        } else if c.layer > 0 {
            assert_eq!(c.rows.len(), 26, "{c:?}");
        }
    }
    // The first layer never has one.
    assert!(t.changes.iter().filter(|c| c.layer == 0).all(|c| c.nozzle_wipe));
    // One category: no contact change, and the same rows as two categories elsewhere.
    let one = contact_case(json!([100, 100]));
    assert!(one.changes.iter().all(|c| c.nozzle_wipe), "{:?}", one.changes);
}

#[test]
fn each_category_wipes_in_a_block_of_its_own() {
    let parts = [
        part([15.0, 15.0, 4.0], [60.0, 60.0], 1),
        part([15.0, 15.0, 4.0], [100.0, 60.0], 2),
        part([15.0, 15.0, 2.0], [140.0, 60.0], 3),
    ];
    let (one, depth1) = slice_with(config(3, &[]), &parts, None);
    let (two, depth2) = slice_with(
        config(3, &[("filament_adhesiveness_category", json!([100, 100, 200]))]),
        &parts,
        None,
    );
    assert!(depth2 > depth1 + 5.0, "{depth1} then {depth2}");
    let t = tower(&two);
    let ys = |slot: u8| -> (f64, f64) {
        t.changes
            .iter()
            .filter(|c| c.tool == slot && c.layer > 0)
            .flat_map(|c| c.rows.iter().copied())
            .fold((f64::MAX, f64::MIN), |m, y| (m.0.min(y), m.1.max(y)))
    };
    let (a, b, c) = (ys(1), ys(2), ys(3));
    // Filament 3's rows stand behind both others', apart from them.
    assert!(c.0 > a.1.max(b.1), "{a:?} {b:?} {c:?}");
    let _ = one;
}

/// The three boxes of the tower filament cases: filaments 1, 2 and 3, `heights` mm tall.
fn three(heights: [f64; 3], extra: &[(&str, Value)]) -> TowerCode {
    let parts: Vec<Part> = heights
        .iter()
        .enumerate()
        .map(|(k, &h)| {
            part(
                [15.0, 15.0, h],
                [60.0 + 40.0 * f64::from(u8::try_from(k).unwrap()), 60.0],
                u8::try_from(k + 1).unwrap(),
            )
        })
        .collect();
    tower(&slice(3, &parts, extra))
}

/// Where a layer's wall is printed against its changes: before the first, after the change into `tool` (its rows,
/// then the wall), or after the last.
fn check_wall_place(t: &TowerCode, wall: u8) {
    assert!(t.changes.len() > 10 && !walls(t).is_empty());
    let layers = t.starts.len();
    for layer in 0..layers {
        let changes: Vec<&Change> = t.changes.iter().filter(|c| c.layer == layer).collect();
        let w: Vec<&Seg> = walls(t).into_iter().filter(|s| s.layer == layer).collect();
        if w.is_empty() {
            continue;
        }
        assert!(w.iter().all(|s| s.tool == wall), "layer {layer}: {:?}", w.first());
        if changes.is_empty() {
            continue;
        }
        let start = t.starts[layer];
        // One adhesion category: a layer without the wall filament prints the wall with the one it starts on.
        let expect = if start == wall {
            0
        } else {
            changes.iter().position(|c| c.tool == wall).map_or(0, |k| k + 1)
        };
        assert!(
            w.iter().all(|s| s.changes_before == expect),
            "layer {layer} (starts on {start}, changes {:?}): the wall after change {expect}, found {:?}",
            changes.iter().map(|c| c.tool).collect::<Vec<_>>(),
            w.iter().map(|s| s.changes_before).collect::<Vec<_>>()
        );
    }
}

#[test]
fn the_wall_goes_with_the_filament_most_on_the_tower() {
    // Filaments 1 and 2 are on every tower layer, filament 3 on half: filament 1 prints the wall.
    let t = three([4.0, 4.0, 2.0], &[]);
    check_wall_place(&t, 1);
    // Filament 3 prints only its rows.
    let rows3 = tower_e(&t, &|s| s.rows_of.is_some())[3];
    let all3 = tower_e(&t, &|_| true)[3];
    assert!(rows3 > 0.0 && (all3 - rows3).abs() < 1e-6, "{rows3} of {all3}");
    // Filament 1's share of the tower (the reference prints 58%).
    let all = tower_e(&t, &|_| true);
    let share = all[1] / all.iter().sum::<f64>();
    assert!((0.45..0.7).contains(&share), "{share} {all:?}");
    // Filament 1 leaves first: filaments 2 and 3 tie, and the lower one prints the wall.
    let t = three([2.0, 4.0, 4.0], &[]);
    check_wall_place(&t, 2);
    let rows1 = tower_e(&t, &|s| s.rows_of.is_some())[1];
    assert!((tower_e(&t, &|_| true)[1] - rows1).abs() < 1e-6);
}

#[test]
fn wipe_tower_filament_picks_the_wall_filament() {
    let t = three([4.0, 4.0, 2.0], &[("wipe_tower_filament", json!(2))]);
    check_wall_place(&t, 2);
}
