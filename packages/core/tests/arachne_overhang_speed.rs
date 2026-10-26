// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Overhang wall speeds with arachne walls. A leaning arachne wall slows by the share of its own bead that hangs
//! past the layer below: `x = (d - e) / (w - 2e)` with `e = h (1 - pi/4) / 2`, `d` how far the bead's outer edge
//! sits past the layer below, `w` the bead's width and `h` the layer height. `x` maps to a degree on straight lines
//! through (0, 0), (0.1, 1/4), (0.25, 2/4) and (0.75, 1), cut down to sixteenths, and the degree to a speed between
//! the wall's own speed and the four overhang speeds. A bead hanging fully clear (`x` of 1 or more) prints at the
//! totally clear speed. Inner walls follow the same rule with their own width and speed.
//!
//! The parts are our own procedural shapes: wedges (8 mm wide, 12 mm deep, the +X face vertical to z 1, then
//! leaning out to z 6) and leaning plates, on a stock Bambu Lab A1 as the app sets it up.

#![allow(clippy::disallowed_methods, clippy::many_single_char_names, clippy::float_cmp)]

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// A shipped Bambu Lab printer as the app sets it up, with uniform layers.
fn printer(model: &str) -> Map<String, Value> {
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
    out.insert("smart_layer".into(), json!("off"));
    out
}

/// Sets `key` to `value`, as a list of one when the settings keep that key as a list.
fn set(cfg: &mut Map<String, Value>, key: &str, value: &str) {
    let v = if cfg.get(key).is_some_and(Value::is_array) {
        json!([value])
    } else {
        json!(value)
    };
    cfg.insert(key.to_owned(), v);
}

/// The stock A1 with arachne walls, 0.2 mm layers, a 0.42 mm outer and a 0.45 mm inner wall, and the keys a
/// project from the maker's app writes (totally clear speed 10, ramps on, precise outer wall off), no cooling
/// slowdown, then `edits`.
fn arachne(edits: &[(&str, &str)]) -> Map<String, Value> {
    let mut cfg = printer("bambu-a1");
    for (k, v) in [
        ("wall_generator", "arachne"),
        ("outer_wall_line_width", "0.42"),
        ("inner_wall_line_width", "0.45"),
        ("overhang_totally_speed", "10"),
        ("smooth_speed_discontinuity_area", "1"),
        ("precise_outer_wall", "0"),
        // A few small parts make short layers: no cooling slowdown over the speeds under test.
        ("slow_down_for_layer_cooling", "0"),
    ] {
        set(&mut cfg, k, v);
    }
    for (k, v) in edits {
        set(&mut cfg, k, v);
    }
    cfg
}

/// Knots far apart, so that every sixteenth of a degree has its own speed; ramps off.
const KNOTS: [(&str, &str); 6] = [
    ("overhang_1_4_speed", "150"),
    ("overhang_2_4_speed", "100"),
    ("overhang_3_4_speed", "50"),
    ("overhang_4_4_speed", "10"),
    ("overhang_totally_speed", "5"),
    ("smooth_speed_discontinuity_area", "0"),
];

fn with(
    base: &[(&'static str, &'static str)],
    more: &[(&'static str, &'static str)],
) -> Vec<(&'static str, &'static str)> {
    base.iter().chain(more).copied().collect()
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

/// The rectangle from x0 to x1 and y 0 to 12 at height z.
fn rect(x0: f32, x1: f32, z: f32) -> Vec<[f32; 3]> {
    vec![[x0, 0.0, z], [x1, 0.0, z], [x1, 12.0, z], [x0, 12.0, z]]
}

/// A wedge 8 mm wide and 12 mm deep whose +X face is vertical to z 1, then leans out `lean` degrees to z 6.
fn wedge(lean: f64) -> Vec<u8> {
    #[allow(clippy::cast_possible_truncation, reason = "a few mm")]
    let reach = (5.0 * lean.to_radians().tan()) as f32;
    let mut tris = loft(&rect(0.0, 8.0, 0.0), &rect(0.0, 8.0, 1.0));
    tris.extend(loft(&rect(0.0, 8.0, 1.0), &rect(0.0, 8.0 + reach, 6.0)));
    stl(&tris)
}

/// A plate `t` mm thick across X and 12 mm deep: both faces vertical to z 1, then both leaning out `lean` degrees
/// to z 6.
fn leaning_plate(t: f32, lean: f64) -> Vec<u8> {
    #[allow(clippy::cast_possible_truncation, reason = "a few mm")]
    let reach = (5.0 * lean.to_radians().tan()) as f32;
    let mut tris = loft(&rect(0.0, t, 0.0), &rect(0.0, t, 1.0));
    tris.extend(loft(&rect(0.0, t, 1.0), &rect(reach, t + reach, 6.0)));
    stl(&tris)
}

/// Where part `i` of a plate sits: two columns of eleven, 22 mm apart in Y.
fn spot(i: usize) -> (f64, f64) {
    #[allow(clippy::cast_precision_loss, reason = "small counts")]
    let (col, row) = ((i / 11) as f64, (i % 11) as f64);
    (15.0 + 115.0 * col, 8.0 + 22.0 * row)
}

/// G-code of the parts, each at its [`spot`].
fn slice(parts: &[Vec<u8>], config: &Map<String, Value>) -> String {
    let meshes: Vec<Arc<Mesh>> = parts
        .iter()
        .map(|p| Arc::new(Mesh::load(p, "m.stl").unwrap()))
        .collect();
    let objects: Vec<Value> = (0..parts.len())
        .map(|i| {
            let (x, y) = spot(i);
            json!({"id": format!("o{i}"), "name": format!("part{i}"), "mesh": i.to_string(),
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": Value::Object(config.clone()),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |id: &str| {
        Ok(meshes[id.parse::<usize>().unwrap()].clone())
    })
    .unwrap();
    String::from_utf8(r.gcode).unwrap()
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

/// One long wall move along Y: its layer height, feature, x and speed (mm/s).
#[derive(Debug, Clone)]
struct Run {
    z: f64,
    feature: String,
    x: f64,
    speed: f64,
}

/// Per part: the extruding moves along Y longer than 6 mm on the full leaning layers (z 2 to 4.6, clear of the
/// first leaning layers and the top shells).
fn runs(gcode: &str, parts: usize) -> Vec<Vec<Run>> {
    let mut out = vec![Vec::new(); parts];
    let (mut z, mut feature, mut f) = (0.0f64, String::new(), 0.0f64);
    let (mut x, mut y) = (0.0f64, 0.0f64);
    for line in gcode.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        if let Some(v) = line.strip_prefix("; Z_HEIGHT: ") {
            z = v.trim().parse().unwrap();
        } else if let Some(name) = line.strip_prefix("; FEATURE: ") {
            name.trim().clone_into(&mut feature);
        } else if code.starts_with("G1")
            || code.starts_with("G0")
            || code.starts_with("G2")
            || code.starts_with("G3")
        {
            if let Some(v) = word(code, 'F') {
                f = v;
            }
            let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
            let along = (nx - x).abs() < 0.02 && (ny - y).abs() > 6.0;
            if code.starts_with("G1")
                && along
                && word(code, 'E').is_some_and(|e| e > 0.0)
                && (2.0..=4.6).contains(&z)
            {
                let mid = ny.midpoint(y);
                if let Some(i) = (0..parts).find(|&i| {
                    (mid - spot(i).1 - 6.0).abs() < 7.0 && nx > spot(i).0 - 1.0 && nx < spot(i).0 + 50.0
                }) {
                    out[i].push(Run {
                        z,
                        feature: feature.clone(),
                        x: nx,
                        speed: f / 60.0,
                    });
                }
            }
            (x, y) = (nx, ny);
        }
    }
    out
}

/// Per layer: the outer loop's run on the +X face (the outer or overhang wall run furthest out), as (feature, mm/s).
fn outer(runs: &[Run]) -> BTreeMap<i64, (String, f64)> {
    let mut out: BTreeMap<i64, (f64, String, f64)> = BTreeMap::new();
    for r in runs
        .iter()
        .filter(|r| r.feature == "Outer wall" || r.feature == "Overhang wall")
    {
        #[allow(clippy::cast_possible_truncation, reason = "layer heights in microns")]
        let key = (r.z * 1000.0).round() as i64;
        if out.get(&key).is_none_or(|o| r.x > o.0) {
            out.insert(key, (r.x, r.feature.clone(), r.speed));
        }
    }
    out.into_iter().map(|(k, (_, f, s))| (k, (f, s))).collect()
}

/// Per layer: the inner loops' runs on the +X face (within 2 mm of the outermost run of the layer), from the
/// outermost in, as mm/s.
fn inner(runs: &[Run]) -> BTreeMap<i64, Vec<f64>> {
    #[allow(clippy::cast_possible_truncation, reason = "layer heights in microns")]
    let key = |r: &Run| (r.z * 1000.0).round() as i64;
    let mut face: BTreeMap<i64, f64> = BTreeMap::new();
    for r in runs {
        let x = face.entry(key(r)).or_insert(f64::MIN);
        *x = x.max(r.x);
    }
    let mut out: BTreeMap<i64, Vec<(f64, f64)>> = BTreeMap::new();
    for r in runs
        .iter()
        .filter(|r| r.feature == "Inner wall" && r.x > face[&key(r)] - 2.0)
    {
        out.entry(key(r)).or_default().push((r.x, r.speed));
    }
    out.into_iter()
        .map(|(k, mut v)| {
            v.sort_by(|a, b| b.0.total_cmp(&a.0));
            (k, v.into_iter().map(|p| p.1).collect())
        })
        .collect()
}

/// Asserts the outer loop on the +X face of every part prints at its wanted speed on every full leaning layer.
fn check_outer(
    what: &str,
    leans: &[f64],
    want: &[f64],
    cfg: &Map<String, Value>,
) -> Vec<BTreeMap<i64, (String, f64)>> {
    let parts: Vec<Vec<u8>> = leans.iter().map(|&a| wedge(a)).collect();
    let all = runs(&slice(&parts, cfg), parts.len());
    let mut got = Vec::new();
    for ((lean, want), r) in leans.iter().zip(want).zip(&all) {
        let o = outer(r);
        assert!(
            o.len() >= 5,
            "{what}, lean {lean}: only {} leaning layers",
            o.len()
        );
        let speeds: Vec<f64> = o.values().map(|v| v.1).collect();
        assert!(
            speeds.iter().all(|s| (s - want).abs() < 0.3),
            "{what}, lean {lean}: outer wall {speeds:?}, want {want}"
        );
        got.push(o);
    }
    got
}

/// Asserts the inner loop number `k` (0 the outermost) on the +X face of every part prints at its wanted speed.
fn check_inner(what: &str, leans: &[f64], k: usize, want: &[f64], cfg: &Map<String, Value>) {
    let parts: Vec<Vec<u8>> = leans.iter().map(|&a| wedge(a)).collect();
    let all = runs(&slice(&parts, cfg), parts.len());
    for ((lean, want), r) in leans.iter().zip(want).zip(&all) {
        let i = inner(r);
        assert!(
            i.len() >= 5,
            "{what}, lean {lean}: only {} leaning layers",
            i.len()
        );
        let speeds: Vec<f64> = i
            .values()
            .map(|v| v.get(k).copied().unwrap_or(f64::NAN))
            .collect();
        assert!(
            speeds.iter().all(|s| (s - want).abs() < 0.3),
            "{what}, lean {lean}: inner loop {k} {speeds:?}, want {want}"
        );
    }
}

/// Case 1: Stock keys: the quarter steps between 200 and 50, then the 2/4 to 4/4 band in sixteenths.
#[test]
fn a_leaning_arachne_outer_wall_slows_in_sixteenths_on_the_stock_keys() {
    check_outer(
        "stock",
        &[22.5, 25.0, 27.5, 32.5, 40.0, 50.0, 55.0],
        &[162.5, 125.0, 87.5, 50.0, 40.0, 25.0, 15.0],
        &arachne(&[]),
    );
}

/// Case 2: Knots far apart: every band in four equal steps from 8.8 degrees on.
#[test]
fn every_band_has_four_equal_steps() {
    check_outer(
        "knots",
        &[
            8.0, 10.0, 13.0, 15.0, 19.0, 22.0, 25.0, 28.0, 33.0, 38.0, 41.0, 45.0, 49.0, 54.0, 56.0, 60.0,
        ],
        &[
            200.0, 187.5, 175.0, 162.5, 150.0, 137.5, 125.0, 112.5, 100.0, 87.5, 75.0, 62.5, 50.0, 30.0,
            20.0, 10.0,
        ],
        &arachne(&KNOTS),
    );
}

/// Case 3: A bead hanging fully clear prints at the totally clear speed while it is still labeled an outer wall. At 64
/// degrees the piece is an overhang wall (on layers where the label rule, which this rule does not change, calls it
/// one; the bead's center sits within a ten-thousandth of a millimeter of that rule's threshold) at the same speed.
#[test]
fn a_fully_clear_outer_wall_prints_at_the_totally_clear_speed_before_its_label_changes() {
    let got = check_outer("knots", &[63.5, 63.75, 64.0], &[5.0, 5.0, 5.0], &arachne(&KNOTS));
    for (lean, o) in [(63.5, &got[0]), (63.75, &got[1])] {
        assert!(o.values().all(|v| v.0 == "Outer wall"), "lean {lean}: {o:?}");
    }
    assert!(
        got[2].values().any(|v| v.0 == "Overhang wall"),
        "lean 64: {:?}",
        got[2]
    );
}

/// Case 4: Through the slicer, each of the 16 levels starts where the rule says: a lean a little below and a little
/// above each threshold (0.002 in x either way, 0.2 mm layers, 0.42 mm outer wall).
#[test]
fn each_sixteenth_starts_at_its_threshold() {
    let e = 0.2 * (1.0 - std::f64::consts::FRAC_PI_4) / 2.0;
    let speed = [
        200.0, 187.5, 175.0, 162.5, 150.0, 137.5, 125.0, 112.5, 100.0, 87.5, 75.0, 62.5, 50.0, 40.0, 30.0,
        20.0, 10.0,
    ];
    let threshold = |n: usize| -> f64 {
        #[allow(clippy::cast_precision_loss, reason = "1 to 16")]
        let n = n as f64;
        if n <= 4.0 {
            0.025 * n
        } else if n <= 8.0 {
            0.1 + 0.0375 * (n - 4.0)
        } else {
            0.25 + 0.0625 * (n - 8.0)
        }
    };
    let mut leans = Vec::new();
    let mut want = Vec::new();
    for n in 1..=16 {
        for (dx, level) in [(-0.002, n - 1), (0.002, n)] {
            let d = e + (threshold(n) + dx) * (0.42 - 2.0 * e);
            leans.push((d / 0.2).atan().to_degrees());
            want.push(speed[level]);
        }
    }
    for half in [0, 1] {
        let (l, w) = (
            &leans[16 * half..16 * half + 16],
            &want[16 * half..16 * half + 16],
        );
        check_outer("thresholds", l, w, &arachne(&KNOTS));
    }
}

/// Case 5: The bead spacing margin follows the layer height.
#[test]
fn the_margin_follows_the_layer_height() {
    check_outer(
        "0.12 mm layers",
        &[25.0, 40.0, 45.0, 50.0],
        &[150.0, 112.5, 100.0, 87.5],
        &arachne(&with(&KNOTS, &[("layer_height", "0.12")])),
    );
    check_outer(
        "0.28 mm layers",
        &[15.0, 20.0, 30.0, 40.0, 45.0],
        &[150.0, 125.0, 87.5, 40.0, 20.0],
        &arachne(&with(&KNOTS, &[("layer_height", "0.28")])),
    );
}

/// Case 6: The share is of the outer wall's own width.
#[test]
fn the_share_is_of_the_outer_walls_width() {
    let cap = [("filament_max_volumetric_speed", "60")];
    check_outer(
        "0.6 outer",
        &[20.0, 25.0, 30.0, 40.0, 45.0],
        &[162.5, 150.0, 137.5, 100.0, 87.5],
        &arachne(&with(&with(&KNOTS, &cap), &[("outer_wall_line_width", "0.6")])),
    );
    check_outer(
        "0.4 outer",
        &[20.0, 25.0, 30.0, 40.0, 55.0],
        &[137.5, 125.0, 100.0, 75.0, 20.0],
        &arachne(&with(&with(&KNOTS, &cap), &[("outer_wall_line_width", "0.4")])),
    );
    check_outer(
        "0.7 outer",
        &[22.0, 25.0, 40.0, 45.0, 50.0, 55.0],
        &[162.5, 150.0, 112.5, 100.0, 87.5, 75.0],
        &arachne(&with(&with(&KNOTS, &cap), &[("outer_wall_line_width", "0.7")])),
    );
}

/// Case 7: A variable-width bead uses its own width: leaning plates whose beads are 0.52, 0.37 and 0.6 mm wide.
#[test]
fn a_variable_width_bead_uses_its_own_width() {
    let cfg = arachne(&KNOTS);
    let cases = [(1.0f32, 25.0, 137.5), (0.7, 20.0, 137.5), (0.6, 15.0, 175.0)];
    let parts: Vec<Vec<u8>> = cases.iter().map(|&(t, a, _)| leaning_plate(t, a)).collect();
    let all = runs(&slice(&parts, &cfg), parts.len());
    for ((t, lean, want), r) in cases.iter().zip(&all) {
        let o = outer(r);
        assert!(
            o.len() >= 5,
            "plate {t}, lean {lean}: only {} leaning layers",
            o.len()
        );
        let speeds: Vec<f64> = o.values().map(|v| v.1).collect();
        assert!(
            speeds.iter().all(|s| (s - want).abs() < 0.3),
            "plate {t}, lean {lean}: outer wall {speeds:?}, want {want}"
        );
    }
}

/// Case 8: Inner walls: the same rule with their own width and speed, measured from their own outer edge.
#[test]
fn an_inner_wall_follows_the_rule_with_its_own_width_and_speed() {
    check_inner(
        "stock",
        &[67.5, 72.5, 75.0],
        0,
        &[175.0, 25.0, 10.0],
        &arachne(&[]),
    );
    check_inner(
        "knots",
        &[66.0, 68.0, 69.5, 71.0, 72.0, 74.0],
        0,
        &[150.0, 112.5, 87.5, 62.5, 50.0, 20.0],
        &arachne(&with(&KNOTS, &[("filament_max_volumetric_speed", "60")])),
    );
}

/// Case 9: Three wall loops: each inner loop is measured past the loops outside it.
#[test]
fn the_third_loop_is_measured_past_the_two_outside_it() {
    let cfg = arachne(&with(
        &KNOTS,
        &[("filament_max_volumetric_speed", "60"), ("wall_loops", "3")],
    ));
    // 69.1 degrees as measured; 71 degrees from the same rule (the second loop at level 11, the third supported).
    check_inner("second loop", &[69.1, 71.0], 0, &[100.0, 62.5], &cfg);
    check_inner("third loop", &[69.1, 71.0], 1, &[300.0, 300.0], &cfg);
}

/// Case 10: Other keys keep their meaning: the filament's own levels, a level left at 0, walls slower than a level.
#[test]
fn other_overhang_keys_keep_their_meaning_on_arachne_walls() {
    let leans = [25.0, 40.0, 45.0, 55.0];
    check_outer(
        "filament override",
        &leans,
        &[38.5, 31.0, 28.5, 18.5],
        &arachne(&[
            ("override_process_overhang_speed", "1"),
            ("filament_overhang_1_4_speed", "41"),
            ("filament_overhang_2_4_speed", "36"),
            ("filament_overhang_3_4_speed", "26"),
            ("filament_overhang_4_4_speed", "16"),
            ("filament_overhang_totally_speed", "13"),
        ]),
    );
    check_outer(
        "2/4 at 0",
        &leans,
        &[200.0, 115.0, 72.5, 15.0],
        &arachne(&[("overhang_2_4_speed", "0")]),
    );
    check_outer(
        "slow walls",
        &leans,
        &[45.0, 40.0, 35.0, 15.0],
        &arachne(&[("outer_wall_speed", "40"), ("inner_wall_speed", "45")]),
    );
}

/// The motion lines of a G-code file: moves, extrusion and fan, without the comments and the settings block.
fn motion(gcode: &str) -> Vec<&str> {
    gcode
        .lines()
        .map(|l| l.split(';').next().unwrap_or("").trim_end())
        .filter(|l| l.starts_with('G') || l.starts_with("M106") || l.starts_with("M107"))
        .collect()
}

/// Case 11: Unchanged output: arachne wedges below the first level print as with the overhang speeds off, and classic
/// walls keep the classic rule (the measured classic speeds of the same stock A1 wedges).
#[test]
fn walls_the_rule_does_not_reach_are_unchanged() {
    let leans = [0.0, 3.0, 6.0, 7.5];
    let parts: Vec<Vec<u8>> = leans.iter().map(|&a| wedge(a)).collect();
    let on = slice(&parts, &arachne(&KNOTS));
    let off = slice(&parts, &arachne(&with(&KNOTS, &[("enable_overhang_speed", "0")])));
    let (a, b) = (motion(&on), motion(&off));
    assert_eq!(
        a.len(),
        b.len(),
        "arachne wedges below 8 degrees: the motion differs in length"
    );
    if let Some(i) = (0..a.len()).find(|&i| a[i] != b[i]) {
        panic!(
            "arachne wedges below 8 degrees: line {i} {} against {}",
            a[i], b[i]
        );
    }
    let mut classic = arachne(&[]);
    set(&mut classic, "wall_generator", "classic");
    check_outer(
        "classic",
        &[20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0],
        &[200.0, 170.0, 110.0, 50.0, 44.0, 36.0, 28.0, 18.0, 10.0],
        &classic,
    );
}

/// The speeds of a wedge sweep under `cfg`, for the shapes and settings the rule was not fitted on: per lean, the
/// outer loop's speeds on the +X face over the full leaning layers. Each stays between the totally clear speed and
/// the wall speed, and the slowest of each lean is no faster than the slowest of a smaller lean.
fn sane_sweep(what: &str, leans: &[f64], cfg: &Map<String, Value>, slowest: f64, fastest: f64) {
    let parts: Vec<Vec<u8>> = leans.iter().map(|&a| wedge(a)).collect();
    let all = runs(&slice(&parts, cfg), parts.len());
    let mut last = f64::INFINITY;
    for (lean, r) in leans.iter().zip(&all) {
        let o = outer(r);
        assert!(!o.is_empty(), "{what}, lean {lean}: no leaning layers");
        let speeds: Vec<f64> = o.values().map(|v| v.1).collect();
        assert!(
            speeds.iter().all(|s| *s >= slowest - 0.3 && *s <= fastest + 0.3),
            "{what}, lean {lean}: {speeds:?} outside {slowest} to {fastest}"
        );
        let low = speeds.iter().copied().fold(f64::INFINITY, f64::min);
        assert!(
            low <= last + 0.3,
            "{what}, lean {lean}: slowest {low} above the smaller lean's {last}"
        );
        last = low;
    }
}

const SWEEP: [f64; 8] = [0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0];

/// Not fitted: one wall loop. The outer wall alone follows the rule.
#[test]
fn one_wall_loop_slows_sanely() {
    sane_sweep(
        "one wall loop",
        &SWEEP,
        &arachne(&with(&KNOTS, &[("wall_loops", "1")])),
        5.0,
        200.0,
    );
}

/// Not fitted: nozzles of 0.2, 0.6 and 0.8 mm, walls a little wider than the nozzle, layers half of it.
#[test]
fn other_nozzles_slow_sanely() {
    for (nozzle, width, layer) in [
        ("0.2", "0.22", "0.1"),
        ("0.6", "0.62", "0.3"),
        ("0.8", "0.82", "0.4"),
    ] {
        let cfg = arachne(&with(
            &KNOTS,
            &[
                ("nozzle_diameter", nozzle),
                ("line_width", width),
                ("outer_wall_line_width", width),
                ("inner_wall_line_width", width),
                ("sparse_infill_line_width", width),
                ("internal_solid_infill_line_width", width),
                ("top_surface_line_width", width),
                ("initial_layer_line_width", width),
                ("layer_height", layer),
                ("initial_layer_print_height", layer),
                ("filament_max_volumetric_speed", "60"),
            ],
        ));
        sane_sweep(&format!("{nozzle} mm nozzle"), &SWEEP, &cfg, 5.0, 200.0);
    }
}

/// Not fitted: adaptive layer heights, where the leaning layers are thinner than the 0.2 mm the rule was measured at.
#[test]
fn adaptive_layers_slow_sanely() {
    let cfg = arachne(&with(&KNOTS, &[("smart_layer", "quality")]));
    sane_sweep("adaptive layers", &SWEEP, &cfg, 5.0, 200.0);
}

/// Not fitted: `precise_outer_wall`, which moves the inner loop out against the outer one.
#[test]
fn precise_outer_wall_slows_sanely() {
    let cfg = arachne(&with(&KNOTS, &[("precise_outer_wall", "1")]));
    sane_sweep("precise outer wall", &SWEEP, &cfg, 5.0, 200.0);
    // The inner loop too, until it hangs clear and becomes an overhang wall: between the totally clear speed and
    // its own speed, slower as it leans further.
    let leans = [60.0, 66.0, 70.0, 74.0];
    let parts: Vec<Vec<u8>> = leans.iter().map(|&a| wedge(a)).collect();
    let all = runs(&slice(&parts, &cfg), parts.len());
    let mut last = f64::INFINITY;
    for (lean, r) in leans.iter().zip(&all) {
        let speeds: Vec<f64> = inner(r).values().filter_map(|v| v.first().copied()).collect();
        assert!(!speeds.is_empty(), "lean {lean}: no inner loop");
        assert!(
            speeds.iter().all(|s| *s >= 4.7 && *s <= 300.3),
            "lean {lean}: {speeds:?}"
        );
        let low = speeds.iter().copied().fold(f64::INFINITY, f64::min);
        assert!(low <= last + 0.3, "lean {lean}: inner {low} above {last}");
        last = low;
    }
}

/// A cone 10 mm across, upright to z 1, then flaring out `lean` degrees to z 6, centered on (0, 0).
fn cone(lean: f64) -> Vec<u8> {
    #[allow(clippy::cast_possible_truncation, reason = "a few mm")]
    let reach = (5.0 * lean.to_radians().tan()) as f32;
    let ring = |r: f32, z: f32| -> Vec<[f32; 3]> {
        (0..64)
            .map(|i| {
                #[allow(clippy::cast_precision_loss, reason = "64 points")]
                let t = i as f32 / 64.0 * std::f32::consts::TAU;
                [r * t.cos(), r * t.sin(), z]
            })
            .collect()
    };
    let mut tris = loft(&ring(5.0, 0.0), &ring(5.0, 1.0));
    tris.extend(loft(&ring(5.0, 1.0), &ring(5.0 + reach, 6.0)));
    stl(&tris)
}

/// Not fitted: curved walls. Cones leaning 10 to 55 degrees: every outer wall stretch of the full leaning layers
/// stays between the totally clear speed and the wall speed, and the typical speed (by length) falls as the cone
/// leans further.
#[test]
fn conical_walls_slow_sanely() {
    let leans = [10.0, 25.0, 40.0, 55.0];
    let meshes: Vec<Arc<Mesh>> = leans
        .iter()
        .map(|&a| Arc::new(Mesh::load(&cone(a), "m.stl").unwrap()))
        .collect();
    let at = |i: usize| -> (f64, f64) {
        #[allow(clippy::cast_precision_loss, reason = "four parts")]
        let x = 40.0 + 58.0 * i as f64;
        (x, 128.0)
    };
    let objects: Vec<Value> = (0..leans.len())
        .map(|i| {
            let (x, y) = at(i);
            json!({"id": format!("c{i}"), "name": format!("cone{i}"), "mesh": i.to_string(),
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": Value::Object(arachne(&KNOTS)),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |id: &str| {
        Ok(meshes[id.parse::<usize>().unwrap()].clone())
    })
    .unwrap();
    let gcode = String::from_utf8(r.gcode).unwrap();
    // Per cone: (speed, length) of each outer or overhang wall stretch on the full leaning layers.
    let mut stretches: Vec<Vec<(f64, f64)>> = vec![Vec::new(); leans.len()];
    let (mut z, mut feature, mut f) = (0.0f64, String::new(), 0.0f64);
    let (mut x, mut y) = (0.0f64, 0.0f64);
    for line in gcode.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        if let Some(v) = line.strip_prefix("; Z_HEIGHT: ") {
            z = v.trim().parse().unwrap();
        } else if let Some(name) = line.strip_prefix("; FEATURE: ") {
            name.trim().clone_into(&mut feature);
        } else if code.starts_with('G') {
            if let Some(v) = word(code, 'F') {
                f = v;
            }
            let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
            let wall = feature == "Outer wall" || feature == "Overhang wall";
            if code.starts_with("G1")
                && wall
                && word(code, 'E').is_some_and(|e| e > 0.0)
                && (2.0..=4.6).contains(&z)
            {
                let (mx, my) = (nx.midpoint(x), ny.midpoint(y));
                if let Some(i) = (0..leans.len()).find(|&i| (mx - at(i).0).hypot(my - at(i).1) < 26.0) {
                    stretches[i].push((f / 60.0, (nx - x).hypot(ny - y)));
                }
            }
            (x, y) = (nx, ny);
        }
    }
    let mut last = f64::INFINITY;
    for (lean, s) in leans.iter().zip(&stretches) {
        assert!(!s.is_empty(), "cone {lean}: no outer wall");
        assert!(
            s.iter().all(|(v, _)| *v >= 4.7 && *v <= 200.3),
            "cone {lean}: {s:?}"
        );
        let mut by: Vec<(f64, f64)> = s.clone();
        by.sort_by(|a, b| a.0.total_cmp(&b.0));
        let total: f64 = by.iter().map(|p| p.1).sum();
        let mut run = 0.0;
        let median = by.iter().find(|p| {
            run += p.1;
            run >= total / 2.0
        });
        let median = median.map_or(f64::NAN, |p| p.0);
        assert!(
            median <= last + 0.3,
            "cone {lean}: typical speed {median} above the smaller lean's {last}"
        );
        last = median;
    }
}
