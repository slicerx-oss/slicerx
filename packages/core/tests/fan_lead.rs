// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Fan lead time (`pre_start_fan_time`, seconds, 0 to 5): a part fan raise inside a layer starts earlier by about that
//! much print time, counted as move length over the commanded feedrate. It goes between moves (a run of extruding
//! moves is one unit), and it never crosses the layer start, another part fan command or a tool change. Clamped at
//! the layer start, the layer runs at the raised value from its first move. Drops, fan off, layer start changes, the
//! first layer and the ironing raise never move, and a lead of 0 writes the G-code there was without the setting.
//!
//! Each test slices with a lead and without, then checks the fan value in force at every move: the moves are the
//! same, the fan is never lower, and each stretch of moves that now runs at a raised value is the lead's window.
//! The configs are built the way the app builds them: the settings schema's defaults, then the printer's shipped
//! process, filament and printer settings, then its G-code.

#![allow(clippy::disallowed_methods)]
#![allow(clippy::many_single_char_names)]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// A shipped Bambu Lab printer as the app sets it up: schema defaults, then the model's process, filament and
/// machine settings, then its G-code.
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
        ("before_layer_change_gcode", "beforeLayerChange"),
        ("layer_change_gcode", "layerChange"),
        ("change_filament_gcode", "changeFilament"),
        ("time_lapse_gcode", "timeLapse"),
    ] {
        if let Some(v) = gcode["families"][&family].get(part) {
            out.insert(key.into(), v.clone());
        }
    }
    out.insert("smart_layer".into(), json!("off"));
    out
}

fn a1() -> Map<String, Value> {
    stock("bambu-a1")
}

/// The triangles of a closed solid between a bottom and a top polygon (counterclockwise, same vertex count).
fn loft(bottom: &[[f32; 3]], top: &[[f32; 3]]) -> Vec<[[f32; 3]; 3]> {
    let n = bottom.len();
    let mut tris: Vec<[[f32; 3]; 3]> = Vec::new();
    for i in 1..n - 1 {
        tris.push([bottom[0], bottom[i + 1], bottom[i]]);
        tris.push([top[0], top[i], top[i + 1]]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        tris.push([bottom[i], bottom[j], top[j]]);
        tris.push([bottom[i], top[j], top[i]]);
    }
    tris
}

fn stl(tris: &[[[f32; 3]; 3]]) -> Vec<u8> {
    let mut b = vec![0u8; 80];
    b.extend_from_slice(&u32::try_from(tris.len()).unwrap().to_le_bytes());
    for t in tris {
        b.extend_from_slice(&[0u8; 12]);
        for v in t {
            for c in v {
                b.extend_from_slice(&c.to_le_bytes());
            }
        }
        b.extend_from_slice(&[0u8; 2]);
    }
    b
}

fn square(x0: f32, y0: f32, w: f32, z: f32) -> Vec<[f32; 3]> {
    vec![[x0, y0, z], [x0 + w, y0, z], [x0 + w, y0 + w, z], [x0, y0 + w, z]]
}

/// A box `w` mm square and `h` tall.
fn cube(w: f32, h: f32) -> Vec<u8> {
    stl(&loft(&square(0.0, 0.0, w, 0.0), &square(0.0, 0.0, w, h)))
}

/// An upside-down frustum: 10 mm square at the bed, 40 mm square at 8 mm, so every outer wall above the first
/// layers overhangs by more than half a line.
fn flare() -> Vec<u8> {
    stl(&loft(
        &square(15.0, 15.0, 10.0, 0.0),
        &square(0.0, 0.0, 40.0, 8.0),
    ))
}

/// A 6 mm column 10 mm tall under a 34 mm cap 4 mm thick: support under the cap.
fn mushroom() -> Vec<u8> {
    let mut tris = loft(&square(14.0, 14.0, 6.0, 0.0), &square(14.0, 14.0, 6.0, 10.0));
    tris.extend(loft(&square(0.0, 0.0, 34.0, 10.0), &square(0.0, 0.0, 34.0, 14.0)));
    stl(&tris)
}

fn mesh_bytes(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/packages/core/cli/tests/fixtures/{name}", root())).unwrap()
}

fn slice_meshes(meshes: &[(Vec<u8>, [f32; 2])], config: &Map<String, Value>) -> api::Result<String> {
    let loaded: Vec<Arc<Mesh>> = meshes
        .iter()
        .enumerate()
        .map(|(i, (b, _))| Arc::new(Mesh::load(b, &format!("m{i}.stl")).unwrap()))
        .collect();
    let objects: Vec<Value> = meshes
        .iter()
        .enumerate()
        .map(|(i, (_, at))| {
            let (lo, hi) = loaded[i].bounds().unwrap();
            let cx = at[0] - lo[0].midpoint(hi[0]);
            let cy = at[1] - lo[1].midpoint(hi[1]);
            json!({"id": format!("o{i}"), "name": format!("part {i}"), "mesh": format!("m{i}"),
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx, cy, -lo[2], 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": Value::Object(config.clone()),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |id: &str| {
        let i: usize = id.trim_start_matches('m').parse().unwrap();
        Ok(loaded[i].clone())
    })?;
    Ok(String::from_utf8(r.gcode).unwrap())
}

fn slice(model: &[u8], config: &Map<String, Value>) -> String {
    slice_meshes(&[(model.to_vec(), [128.0, 128.0])], config).unwrap()
}

fn with_lead(config: &Map<String, Value>, lead: f64) -> Map<String, Value> {
    let mut c = config.clone();
    c.insert("pre_start_fan_time".into(), json!([lead, lead]));
    c
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a finished file: the moves, the fan in force at each, and the commands between them.

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

#[derive(Debug, Clone)]
struct Move {
    text: String,
    layer: usize,
    fan: f64,
    time: f64,
    /// Extrudes while moving in XY: consecutive ones are one unit.
    run: bool,
    feature: String,
}

#[derive(Debug, Default)]
struct Parsed {
    moves: Vec<Move>,
    /// Part fan commands: the index of the move they come before and their value.
    fans: Vec<(usize, f64)>,
    /// Tool changes: the index of the move they come before.
    changes: Vec<usize>,
    /// The index of each layer's first move.
    layer_starts: Vec<usize>,
}

fn part_fan(code: &str) -> Option<f64> {
    let mut w = code.split_whitespace();
    match w.next()? {
        "M107" => Some(0.0),
        "M106" if !code.contains(" P2") && !code.contains(" P3") => Some(word(code, 'S').unwrap_or(0.0)),
        _ => None,
    }
}

/// The length in XY of an arc move `dx`, `dy` from its start, its center at `I`, `J` and `P` whole turns more.
fn arc_length(code: &str, ccw: bool, dx: f64, dy: f64) -> f64 {
    let (i, j) = (word(code, 'I').unwrap_or(0.0), word(code, 'J').unwrap_or(0.0));
    let turns = word(code, 'P').unwrap_or(0.0);
    let a0 = (-j).atan2(-i);
    let a1 = (dy - j).atan2(dx - i);
    let tau = std::f64::consts::TAU;
    let mut s = (if ccw { a1 - a0 } else { a0 - a1 }).rem_euclid(tau);
    if s <= 1e-9 && dx.abs() < 1e-9 && dy.abs() < 1e-9 {
        s = tau * turns.max(1.0);
    } else {
        s += tau * turns;
    }
    i.hypot(j) * s
}

fn parse(g: &str) -> Parsed {
    let mut p = Parsed::default();
    let (mut pos, mut feed, mut fan) = ([None::<f64>; 3], None::<f64>, 0.0);
    let mut relative_xyz = false;
    let mut layer = 0;
    let mut layer_open = false;
    let mut feature = String::new();
    for line in g.lines() {
        if line.starts_with("; CHANGE_LAYER") || line.starts_with(";LAYER_CHANGE") {
            layer += 1;
            layer_open = true;
        }
        if let Some(f) = line
            .strip_prefix("; FEATURE: ")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            f.clone_into(&mut feature);
        }
        let code = line.split(';').next().unwrap_or("").trim();
        let first = code.split_whitespace().next().unwrap_or("");
        match first {
            "G90" => relative_xyz = false,
            "G91" => relative_xyz = true,
            _ => {}
        }
        if let Some(v) = part_fan(code) {
            fan = v;
            p.fans.push((p.moves.len(), v));
            continue;
        }
        // a tool change: its start (`M620 S`), the tool command, and Bambu Lab's closing `M1020 S`
        if (first.starts_with('T') && first[1..].parse::<u32>().is_ok())
            || (first == "M620" || first == "M1020") && code.contains(" S")
        {
            p.changes.push(p.moves.len());
        }
        let arc = match first {
            "G0" | "G1" => None,
            "G2" => Some(false),
            "G3" => Some(true),
            _ => continue,
        };
        if let Some(f) = word(code, 'F') {
            feed = Some(f);
        }
        let to = |i: usize, k: char| {
            word(code, k).map(|v| {
                if relative_xyz {
                    pos[i].map_or(v, |p: f64| p + v)
                } else {
                    v
                }
            })
        };
        let t = [to(0, 'X'), to(1, 'Y'), to(2, 'Z')];
        let e = word(code, 'E');
        if t.iter().all(Option::is_none) && e.is_none() && arc.is_none() {
            continue;
        }
        let d = |i: usize| t[i].map_or(0.0, |v| v - pos[i].unwrap_or(v));
        let (dx, dy, dz) = (d(0), d(1), d(2));
        let xy = arc.map_or_else(|| dx.hypot(dy), |ccw| arc_length(code, ccw, dx, dy));
        let len = if xy > 0.0 || dz.abs() > 0.0 {
            xy.hypot(dz)
        } else {
            e.map_or(0.0, f64::abs)
        };
        let time = feed.filter(|f| *f > 0.0).map_or(0.0, |f| len / (f / 60.0));
        let moves_xy = t[0].is_some() || t[1].is_some() || arc.is_some();
        if layer_open {
            p.layer_starts.push(p.moves.len());
            layer_open = false;
        }
        p.moves.push(Move {
            text: line.to_owned(),
            layer,
            fan,
            time,
            run: moves_xy && e.is_some_and(|e| e > 0.0),
            feature: feature.clone(),
        });
        for (i, v) in t.into_iter().enumerate() {
            if v.is_some() {
                pos[i] = v;
            }
        }
    }
    p
}

/// The feature label of a prime tower pass.
const TOWER: &str = "Prime tower";

/// What the lead did, counted over the whole file.
#[derive(Debug, Default)]
struct Leads {
    /// Stretches of moves that run at a raised value they did not have without the lead.
    windows: usize,
    /// Of those, the ones that reach back to their layer's first move.
    at_layer_start: usize,
    /// The ones that stop right after another part fan command.
    after_fan: usize,
    /// The ones that stop right after a tool change.
    after_change: usize,
    /// The ones that stop right after a prime tower pass and the travel from it to the part.
    after_tower: usize,
    /// The ones that span the whole lead.
    full: usize,
    /// The feature of the move each raise was written for.
    targets: Vec<String>,
    /// The longest window, in seconds.
    longest: f64,
}

/// Compares a file sliced with a lead of `lead` seconds with the same slice without one, and checks the rule.
fn check(base: &str, with: &str, lead: f64) -> Leads {
    let (b, w) = (parse(base), parse(with));
    assert_eq!(b.moves.len(), w.moves.len(), "the same moves");
    for (x, y) in b.moves.iter().zip(&w.moves) {
        assert_eq!(x.text, y.text, "the same moves in the same order");
    }
    assert_eq!(b.layer_starts, w.layer_starts);
    // Every drop and fan off inside a layer is still there, before the same move. (A layer's own fan line may take a
    // raise's value instead: that is the clamp at the layer start.)
    let mut last = 0.0;
    for &(at, v) in &b.fans {
        if v < last && b.layer_starts.binary_search(&at).is_err() {
            assert!(
                w.fans.contains(&(at, v)),
                "the drop to {v} before move {at} stays"
            );
        }
        last = v;
    }
    let layer_start = |i: usize| b.layer_starts.binary_search(&i).is_ok();
    let mut out = Leads::default();
    let n = w.moves.len();
    let mut i = 0;
    while i < n {
        assert!(
            w.moves[i].fan >= b.moves[i].fan,
            "move {i} ({}) runs at {} without the lead and {} with it",
            w.moves[i].text,
            b.moves[i].fan,
            w.moves[i].fan
        );
        if w.moves[i].fan <= b.moves[i].fan {
            i += 1;
            continue;
        }
        let start = i;
        while i < n && w.moves[i].fan > b.moves[i].fan {
            i += 1;
        }
        // moves[start..i] run early at the raised value; the raise was written for move i.
        assert!(i < n, "a window ends at a raise");
        assert!(
            (w.moves[start].fan - b.moves[i].fan).abs() < 1e-9,
            "the window runs at the raise's value"
        );
        let layer = w.moves[i].layer;
        assert!(
            w.moves[start..i].iter().all(|m| m.layer == layer),
            "a raise never moves into the layer before (move {start} to {i})"
        );
        assert!(
            !b.changes.iter().any(|&c| c > start && c <= i),
            "a raise never moves across a tool change (move {start} to {i})"
        );
        assert!(
            !w.moves[start..i].iter().any(|m| m.feature == TOWER),
            "a raise never moves into a prime tower pass (move {start} to {i}, {})",
            w.moves[i].text
        );
        let time: f64 = w.moves[start..i].iter().map(|m| m.time).sum();
        out.windows += 1;
        out.longest = out.longest.max(time);
        out.targets.push(w.moves[i].feature.clone());
        let fans_before = w.fans.iter().filter(|&&(at, _)| at == start).count();
        let changed_before = b.changes.contains(&start);
        let tower_before = start > 0 && w.moves[start - 1].feature == TOWER;
        if layer_start(start) {
            out.at_layer_start += 1;
        } else if changed_before {
            out.after_change += 1;
        } else if tower_before {
            out.after_tower += 1;
        } else if fans_before >= 2 {
            out.after_fan += 1;
        } else {
            assert!(
                time >= lead - 1e-3,
                "the raise for move {i} ({}) leads by {time:.3} s, less than {lead} s, with nothing in its way",
                w.moves[i].text
            );
            out.full += 1;
        }
        if time >= lead {
            // It went no further than the first unit that reaches the lead: drop that unit and it falls short.
            let mut first = start + 1;
            if w.moves[start].run {
                while first < i && w.moves[first].run {
                    first += 1;
                }
            }
            let rest: f64 = w.moves[first..i].iter().map(|m| m.time).sum();
            assert!(
                rest < lead + 2e-3,
                "the raise for move {i} goes {time:.3} s back where {rest:.3} s past one unit reaches {lead} s"
            );
        }
    }
    out
}

fn no_header_line(g: &str) -> String {
    g.lines()
        .filter(|l| !l.starts_with("; pre_start_fan_time"))
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------------------------------------------
// Section 9 of the behavior spec, one test per case.

#[test]
fn a_lead_of_zero_writes_what_a_profile_without_the_key_writes() {
    // Case 1: 0 is the same as no setting at all, byte for byte apart from the config block line itself.
    for model in [cube(20.0, 20.0), flare()] {
        let mut without = a1();
        without.remove("pre_start_fan_time");
        let zero = with_lead(&a1(), 0.0);
        let (g0, gn) = (slice(&model, &zero), slice(&model, &without));
        assert!(g0.contains("; pre_start_fan_time = 0"));
        assert!(!gn.contains("; pre_start_fan_time"));
        assert_eq!(no_header_line(&g0), no_header_line(&gn));
    }
}

#[test]
fn the_cube_bridge_raise_moves_back_by_the_lead_and_clamps_at_the_layer_start() {
    // Case 2: the cube's internal bridge raise, no timelapse. A short lead lands it before a whole unit, never
    // inside a run of extrusions; a long one reaches the layer start, and the layer then runs at the raised value
    // from its first move.
    let mut c = a1();
    c.insert("time_lapse_gcode".into(), json!(""));
    let base = slice(&cube(20.0, 20.0), &with_lead(&c, 0.0));
    let mut starts = Vec::new();
    for lead in [0.1, 0.5, 0.8, 2.0, 5.0] {
        let g = slice(&cube(20.0, 20.0), &with_lead(&c, lead));
        let l = check(&base, &g, lead);
        assert!(l.windows > 0, "lead {lead}: a raise moved");
        assert!(
            l.targets.iter().any(|t| t.to_lowercase().contains("bridge")),
            "{:?}",
            l.targets
        );
        starts.push(l.at_layer_start);
    }
    // Longer leads reach the layer start at least as often, and 5 s always does here.
    assert!(starts.windows(2).all(|w| w[0] <= w[1]), "{starts:?}");
    let g5 = slice(&cube(20.0, 20.0), &with_lead(&c, 5.0));
    let l5 = check(&base, &g5, 5.0);
    assert_eq!(l5.at_layer_start + l5.after_fan, l5.windows, "{l5:?}");
}

#[test]
fn with_the_timelapse_block_the_raise_crosses_its_moves_and_not_its_dwell() {
    // Case 3: the A1's timelapse G-code is not a wall: its moves are units like any other and its dwell counts
    // nothing, so the walk goes into it and past it.
    let c = a1();
    assert!(c["time_lapse_gcode"].as_str().is_some_and(|t| !t.is_empty()));
    let base = slice(&cube(20.0, 20.0), &with_lead(&c, 0.0));
    for lead in [0.5, 1.0, 2.0, 3.0, 5.0] {
        let g = slice(&cube(20.0, 20.0), &with_lead(&c, lead));
        let l = check(&base, &g, lead);
        assert!(l.windows > 0, "lead {lead}");
        assert_eq!(l.after_change, 0);
    }
}

#[test]
fn flare_overhang_raises_reach_the_layer_start_and_the_layer_runs_raised() {
    // Case 4: an overhanging outer wall on every layer. With 2 s the walk runs back over the inner walls to the
    // layer start, the layer's own fan line takes the raised value, and the fan never dips during the layer change.
    let c = a1();
    let base = slice(&flare(), &with_lead(&c, 0.0));
    let g = slice(&flare(), &with_lead(&c, 2.0));
    let l = check(&base, &g, 2.0);
    assert!(l.windows > 10, "{l:?}");
    assert!(l.at_layer_start > 10, "{l:?}");
    assert!(l.targets.iter().any(|t| t == "Outer wall"), "{:?}", l.targets);
}

#[test]
fn table_raises_stop_right_after_the_drop_before_them() {
    // Case 5: the table's overhanging inner walls toggle the fan up and down along one loop. The first raise of a
    // layer may reach the layer start; every later one stops right after the drop before it, so the drops stay.
    let c = a1();
    let table = mesh_bytes("table.stl");
    let base = slice(&table, &with_lead(&c, 0.0));
    for lead in [0.5, 2.0, 5.0] {
        let g = slice(&table, &with_lead(&c, lead));
        let l = check(&base, &g, lead);
        assert!(l.windows > 0, "lead {lead}");
        assert!(l.after_fan > 0, "lead {lead}: {l:?}");
    }
}

#[test]
fn support_interface_raises_move_like_the_others() {
    // Case 6: support on, its interface cooled harder than the layer: those raises move by the same rule.
    let mut c = a1();
    c.insert("enable_support".into(), json!(true));
    c.insert("support_type".into(), json!("normal(auto)"));
    c.insert("support_material_interface_fan_speed".into(), json!([100]));
    let model = mushroom();
    let base = slice(&model, &with_lead(&c, 0.0));
    assert!(base.contains("Support interface") || base.contains("support interface"));
    let g = slice(&model, &with_lead(&c, 2.0));
    let l = check(&base, &g, 2.0);
    assert!(
        l.targets
            .iter()
            .any(|t| t.to_lowercase().contains("support interface")),
        "{:?}",
        l.targets
    );
}

#[test]
fn a_raise_after_a_tool_change_stops_at_the_change() {
    // Case 7: the flare with its inner walls in filament 2 and no prime tower: a layer that changes filament before
    // its outer wall has the wall's raise land right after the change, however long the lead.
    let mut c = a1();
    c.insert("inner_wall_filament_id".into(), json!(2));
    // every outer wall cools as an overhang, so each layer has a raise right after its change
    c.insert("overhang_fan_threshold".into(), json!(["0%", "0%"]));
    c.insert("enable_prime_tower".into(), json!(false));
    c.insert("nozzle_temperature".into(), json!([220, 220]));
    c.insert("filament_diameter".into(), json!([1.75, 1.75]));
    c.insert("filament_type".into(), json!(["PLA", "PLA"]));
    c.insert("filament_colour".into(), json!(["#FFFFFF", "#000000"]));
    let base = slice(&flare(), &with_lead(&c, 0.0));
    assert!(parse(&base).changes.len() > 10);
    let g = slice(&flare(), &with_lead(&c, 5.0));
    let l = check(&base, &g, 5.0);
    // Layers that start with filament 1 carry on from the layer below, so their raise walks back to the layer start;
    // every other layer's stops at its change (or at a drop after it). None gets its whole 5 s.
    assert!(l.after_change > 10, "{l:?}");
    assert_eq!(l.full, 0, "{l:?}");
}

/// The two filament flare of case 7 with its prime tower on, filament 2 printing `features`.
fn two_filaments_with_tower(features: &[&str]) -> Map<String, Value> {
    let mut c = a1();
    for f in features {
        c.insert((*f).into(), json!(2));
    }
    c.insert("overhang_fan_threshold".into(), json!(["0%", "0%"]));
    c.insert("enable_prime_tower".into(), json!(true));
    c.insert("nozzle_temperature".into(), json!([220, 220]));
    c.insert("filament_diameter".into(), json!([1.75, 1.75]));
    c.insert("filament_type".into(), json!(["PLA", "PLA"]));
    c.insert("filament_colour".into(), json!(["#FFFFFF", "#000000"]));
    c
}

/// The raises of a file without a lead whose walk back reaches a prime tower pass before the lead, split by what
/// lies between: nothing but the travel from the tower, or part moves shorter than the lead.
fn raises_after_a_tower(base: &str, lead: f64) -> (usize, usize) {
    let p = parse(base);
    let (mut right_after, mut part_between) = (0, 0);
    let mut last = 0.0;
    for &(at, v) in &p.fans {
        let raise = v > last;
        last = v;
        if !raise || p.layer_starts.binary_search(&at).is_ok() || at >= p.moves.len() {
            continue;
        }
        let (mut i, mut time, mut part) = (at, 0.0, false);
        while i > 0 && time < lead {
            i -= 1;
            let m = &p.moves[i];
            if m.feature == TOWER {
                if part {
                    part_between += 1;
                } else {
                    right_after += 1;
                }
                break;
            }
            if p.fans.iter().any(|&(f, _)| f == i + 1 && f != at)
                || p.changes.contains(&(i + 1))
                || p.layer_starts.binary_search(&(i + 1)).is_ok()
            {
                break;
            }
            time += m.time;
            part |= m.run;
        }
    }
    (right_after, part_between)
}

#[test]
fn a_raise_never_reaches_back_over_a_prime_tower_pass() {
    // The flare in two filaments with a prime tower. Inner walls in filament 2: a layer that starts in filament 2
    // changes to 1, passes the tower and travels straight to the overhanging outer wall, so that raise gets no lead.
    // Sparse infill in filament 2: after the tower come the inner walls, shorter than the lead, then the outer wall,
    // so the raise lands right after the tower's travel. Neither raise may run the tower at the part's fan.
    let mut seen = (0, 0);
    for features in [["inner_wall_filament_id"], ["sparse_infill_filament_id"]] {
        let c = two_filaments_with_tower(&features);
        let base = slice(&flare(), &with_lead(&c, 0.0));
        assert!(base.contains(&format!(";TYPE:{TOWER}")) || base.contains(&format!("; FEATURE: {TOWER}")));
        let (right_after, part_between) = raises_after_a_tower(&base, 3.0);
        seen = (seen.0 + right_after, seen.1 + part_between);
        let g = slice(&flare(), &with_lead(&c, 3.0));
        let l = check(&base, &g, 3.0);
        assert_eq!(l.after_tower, part_between, "{features:?}: {l:?}");
    }
    assert!(seen.0 > 10 && seen.1 > 10, "both kinds of layer occur: {seen:?}");
}

#[test]
fn drops_fan_off_ironing_the_first_layer_and_the_full_fan_ramp_stay_put() {
    // Case 8: ironing on with its own faster fan, and the fan ramping to full by layer 5 after 3 layers off. The
    // ironing raise and every layer start change stay where they were; only in-layer raises move (`check` also
    // holds every drop in place).
    let mut c = a1();
    c.insert("ironing_type".into(), json!("top"));
    c.insert("ironing_fan_speed".into(), json!([95]));
    c.insert("full_fan_speed_layer".into(), json!([5]));
    c.insert("close_fan_the_first_x_layers".into(), json!([3]));
    let base = slice(&cube(20.0, 20.0), &with_lead(&c, 0.0));
    let g = slice(&cube(20.0, 20.0), &with_lead(&c, 5.0));
    let l = check(&base, &g, 5.0);
    assert!(
        !l.targets.iter().any(|t| t.to_lowercase().contains("ironing")),
        "{:?}",
        l.targets
    );
    assert!(base.to_lowercase().contains("ironing"));
    let (b, w) = (parse(&base), parse(&g));
    // the first three layers run as they did
    let third = b.layer_starts[3];
    assert!(
        b.moves[..third]
            .iter()
            .zip(&w.moves[..third])
            .all(|(x, y)| (x.fan - y.fan).abs() < 1e-9)
    );
}

#[test]
fn shipped_presets_move_their_raises_by_their_own_lead() {
    // Case 9: the A1 mini behaves like the A1; an X1 Carbon at 60 to 80 percent with 3 s moves raises up to 3 s;
    // an X1 Carbon whose fan always runs full has nothing to move, and its unset lead is the same as 0.
    let mini = stock("bambu-a1-mini");
    let base = slice(&flare(), &with_lead(&mini, 0.0));
    let l = check(&base, &slice(&flare(), &with_lead(&mini, 2.0)), 2.0);
    assert!(l.windows > 10 && l.at_layer_start > 10, "{l:?}");

    let mut x1c = stock("bambu-x1-carbon");
    x1c.insert("fan_min_speed".into(), json!([60]));
    x1c.insert("fan_max_speed".into(), json!([80]));
    let base = slice(&flare(), &with_lead(&x1c, 0.0));
    let l = check(&base, &slice(&flare(), &with_lead(&x1c, 3.0)), 3.0);
    assert!(l.windows > 10 && l.longest <= 3.0 + 1.0, "{l:?}");

    let mut full = stock("bambu-x1-carbon");
    full.insert("fan_min_speed".into(), json!([100]));
    full.insert("fan_max_speed".into(), json!([100]));
    let mut unset = full.clone();
    unset.remove("pre_start_fan_time");
    let g2 = slice(&flare(), &with_lead(&full, 2.0));
    assert_eq!(no_header_line(&g2), no_header_line(&slice(&flare(), &unset)));
}

#[test]
fn a_lead_outside_0_to_5_seconds_is_refused() {
    // Case 10: Bambu Studio refuses to slice outside [0, 5]; so does the engine, naming the setting.
    for bad in [json!([5.01]), json!([-0.5]), json!(["6"]), json!([0, 10])] {
        let mut c = a1();
        c.insert("pre_start_fan_time".into(), bad.clone());
        let e = slice_meshes(&[(cube(10.0, 2.0), [128.0, 128.0])], &c)
            .unwrap_err()
            .to_string();
        assert!(
            e.contains("pre_start_fan_time") && e.contains("outside 0 to 5"),
            "{bad}: {e}"
        );
    }
    for good in [json!([0]), json!([0.001]), json!(["0.01"]), json!([5])] {
        let mut c = a1();
        c.insert("pre_start_fan_time".into(), good.clone());
        assert!(
            slice_meshes(&[(cube(10.0, 2.0), [128.0, 128.0])], &c).is_ok(),
            "{good}"
        );
    }
}
