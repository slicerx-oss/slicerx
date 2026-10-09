// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Each `UltiMaker` S printer slices a two-color plate from its shipped profile, and the file reads as Cura
//! writes it for the same machine: the header the printer checks, the start, and the print core switches.
//!
//! `fixtures/cura-ultimaker.json` holds what `CuraEngine` 5.13.0 wrote for the same plate (two 20 mm boxes, one
//! per extruder, generic PLA in two AA print cores, Cura's settings for the machine resolved from its
//! definitions). The settings below make the filament side match Cura's generic PLA, so the numbers can be
//! compared too; the paths themselves are each engine's own and are not compared.
use std::sync::Arc;

use serde_json::{Value, json};
use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

fn cuboid(x: [f32; 2], y: [f32; 2], z: [f32; 2], slot: u8) -> Mesh {
    let mut positions = Vec::new();
    for zi in z {
        for (xi, yi) in [(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])] {
            positions.push([xi, yi, zi]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    Mesh {
        name: "box".into(),
        parts: vec![MeshPart {
            name: "box".into(),
            slot,
            color: None,
            positions,
            triangles,
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
            paint_texts: Vec::new(),
        }],
    }
}

/// Cura's generic PLA on each machine (its material and quality profiles), and two AA cores as in the fixture.
fn as_cura(id: &str) -> Value {
    let cheetah = matches!(id, "ultimaker-s6" | "ultimaker-s8");
    let (temp, bed, idle, drop, core, prime) = if cheetah {
        (210, 55, 175, 15, "AA+ 0.4", 15)
    } else {
        (205, 60, 100, 10, "AA 0.4", 20)
    };
    let mut v = json!({
        "print_core": [core, core],
        "retract_length_toolchange": [16, 16],
        "deretract_speed_extruder_change": [prime, prime],
        "filament_type": ["PLA", "PLA"],
        "nozzle_temperature": [temp, temp],
        "nozzle_temperature_initial_layer": [temp, temp],
        "hot_plate_temp": [bed, bed],
        "hot_plate_temp_initial_layer": [bed, bed],
        "idle_temperature": [idle, idle],
        "toolchange_temperature_drop": [drop, drop],
        "chamber_temperature": [28, 28],
        // Cura plans each idle core's temperature from its own heating model (Preheat.cpp); the shipped profile
        // preheats the way Orca does instead, which keeps a core warm through a short layer. Off here, every
        // switch parks the old core at standby as Cura's plain switch does.
        "preheat_time": 0,
    });
    if cheetah {
        v["enable_pressure_advance"] = json!([1, 1]);
        v["pressure_advance"] = json!([0.75, 0.75]);
    }
    v
}

fn slice(id: &str) -> String {
    slice_with(id, 1)
}

fn slice_with(id: &str, shards: u32) -> String {
    let profile = sx_settings::printer_profile(id).expect("a printer profile");
    let sx_settings::BuildVolume::Rectangular { x, y, z } = profile.build_volume else {
        panic!("a rectangular bed")
    };
    let mut cfg = sx_settings::profile_config(id, None, Some("pla"), Some("draft"))
        .expect("a profile config")
        .to_json();
    if let (Some(dst), Value::Object(src)) = (cfg.as_object_mut(), as_cura(id)) {
        dst.extend(src);
    }
    #[allow(clippy::cast_possible_truncation, reason = "bed sizes fit f32")]
    let (cx, cy) = ((x / 2.0) as f32, (y / 2.0) as f32);
    let a = Arc::new(cuboid(
        [cx - 25.0, cx - 5.0],
        [cy - 10.0, cy + 10.0],
        [0.0, 10.0],
        1,
    ));
    let b = Arc::new(cuboid(
        [cx + 5.0, cx + 25.0],
        [cy - 10.0, cy + 10.0],
        [0.0, 10.0],
        2,
    ));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {
            "bed": {"widthMm": x, "depthMm": y, "heightMm": z},
            "objects": [
                {"id": "a", "name": "a", "mesh": "a", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]},
                {"id": "b", "name": "b", "mesh": "b", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]},
            ],
        },
        "config": cfg,
        "options": {"shards": shards},
    }))
    .expect("a request");
    let run = api::run_request(&req, &move |m: &str| {
        Ok(if m == "a" { a.clone() } else { b.clone() })
    })
    .expect("a slice");
    String::from_utf8(run.gcode).expect("text")
}

fn cura(id: &str) -> Value {
    let all: Value = serde_json::from_str(include_str!("fixtures/cura-ultimaker.json")).expect("fixture");
    all["machines"][id].clone()
}

fn lines(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|l| l.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

/// A G-code line without its comment, trimmed.
fn code(l: &str) -> &str {
    l.split(';').next().unwrap_or("").trim()
}

fn word(l: &str, key: char) -> Option<f64> {
    code(l)
        .split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse().ok()))
}

/// The parts of a print core switch both engines must agree on: the retraction (feed and length, from the
/// absolute extruder positions), where the head parks and how high it lifts before `T`, the commands around
/// `T` with their values (the old core's standby is Cura's own estimate, so only its tool is kept), the
/// firmware prime, the prime back, and the printing temperature it goes on to.
#[allow(clippy::many_single_char_names, reason = "the G-code letters")]
fn skeleton(block: &[String]) -> Vec<String> {
    let t = block
        .iter()
        .position(|l| code(l).len() == 2 && code(l).starts_with('T'))
        .expect("a T");
    let mut out = Vec::new();
    let mut e = None::<f64>;
    let mut park = None;
    let mut hop = None;
    for (i, l) in block.iter().enumerate() {
        let c = code(l);
        let is_move = c.starts_with("G0 ") || c.starts_with("G1 ");
        let has = |k: char| c.split_whitespace().any(|w| w.starts_with(k));
        if c.starts_with("G92") {
            e = Some(0.0);
        }
        if is_move && has('E') && (has('X') || has('Y')) {
            // An extrusion: only where the extruder stands.
            e = word(c, 'E');
            continue;
        }
        if is_move && has('E') && !has('X') && !has('Y') && !has('Z') {
            let v = word(c, 'E').unwrap_or(0.0);
            let d = e.map_or(v, |p| v - p);
            e = Some(v);
            out.push(format!("E{:.2} F{}", d, word(c, 'F').unwrap_or(0.0)));
            continue;
        }
        if i < t {
            if is_move && has('X') && has('Y') {
                park = Some(format!(
                    "park X{} Y{}",
                    word(c, 'X').unwrap_or(0.0),
                    word(c, 'Y').unwrap_or(0.0)
                ));
            }
            if is_move && has('Z') && !has('X') {
                hop = Some(format!("hop Z{}", word(c, 'Z').unwrap_or(0.0)));
            }
            continue;
        }
        if i == t {
            out.extend(park.take());
            out.extend(hop.take());
            out.push("G92 E0".into());
            out.push(c.to_owned());
            continue;
        }
        if c.starts_with("M104 T") {
            out.push(c.split(" S").next().unwrap_or(c).to_owned());
        } else if c.starts_with("M109")
            || c.starts_with("M104")
            || c.starts_with("M214")
            || c.starts_with("G280")
            || c == "G92 E0"
        {
            out.push(c.to_owned());
        }
    }
    out
}

/// The switch to `tool` after `from` lines into the file: from the last extrusion before `T` (included) to the first
/// `M104` without a tool after it.
fn switch_block(g: &[String], tool: u8, from: usize) -> (Vec<String>, usize) {
    let want = format!("T{tool}");
    let k = (from..g.len()).find(|&i| code(&g[i]) == want).expect("a switch");
    let mut a = k;
    while a > 0 {
        let c = code(&g[a - 1]);
        if c.starts_with("G1 ") && c.contains(" X") && c.contains(" E") {
            break;
        }
        a -= 1;
    }
    let b = (k + 1..g.len())
        .find(|&i| code(&g[i]).starts_with("M104 S"))
        .expect("the printing temperature");
    (g[a.saturating_sub(1)..=b].to_vec(), k)
}

const MACHINES: [&str; 5] = [
    "ultimaker-s3",
    "ultimaker-s5",
    "ultimaker-s7",
    "ultimaker-s6",
    "ultimaker-s8",
];

#[test]
fn the_header_names_what_cura_names() {
    for id in MACHINES {
        let ours: Vec<String> = slice(id).lines().map(str::to_owned).collect();
        let end = ours.iter().position(|l| l == ";END_OF_HEADER").expect("a header");
        let ours = &ours[..=end];
        let theirs = lines(&cura(id)["header"]);
        let key = |l: &String| l.split(':').next().unwrap_or("").to_owned();
        assert_eq!(
            ours.iter().map(key).collect::<Vec<_>>(),
            theirs.iter().map(key).collect::<Vec<_>>(),
            "{id}: the same fields in the same order"
        );
        for (a, b) in ours.iter().zip(&theirs) {
            let k = key(a);
            if k.starts_with(";GENERATOR")
                || k == ";SLICE_UUID"
                || k == ";PRINT.TIME"
                || k.ends_with("VOLUME_USED")
                || k.starts_with(";PRINT.SIZE")
            {
                // Ours: SlicerX, its own estimate and extent; all present and numeric where Cura's are.
                let v = a.split_once(':').map_or("", |x| x.1);
                assert!(!v.is_empty() && !v.contains("_SX_"), "{id}: {a}");
                if !k.starts_with(";GENERATOR") && k != ";SLICE_UUID" {
                    assert!(v.parse::<f64>().is_ok_and(|n| n >= 0.0), "{id}: {a}");
                }
                continue;
            }
            assert_eq!(a, b, "{id}");
        }
        // The extent reaches the switching position and the firmware's prime lift, as Cura's does.
        assert!(ours.contains(&";PRINT.SIZE.MAX.Z:20.001".to_owned()), "{id}");
    }
}

#[test]
fn the_start_is_curas() {
    for id in MACHINES {
        let g: Vec<String> = slice(id).lines().map(str::to_owned).collect();
        let t0 = g.iter().position(|l| l == "T0").expect("the first core selected");
        let layer = g
            .iter()
            .position(sx_core::extras::is_layer_mark)
            .expect("a layer");
        let ours: Vec<&str> = g[t0..layer]
            .iter()
            .map(String::as_str)
            .filter(|l| !code(l).is_empty())
            .collect();
        // Cura retracts at the end of its start; ours does it as the first layer begins, the same move.
        let theirs: Vec<String> = lines(&cura(id)["start"])
            .into_iter()
            .filter(|l| !code(l).is_empty() && !code(l).starts_with("G1 F2700 E-"))
            .collect();
        let first_retract = g[layer..]
            .iter()
            .find(|l| code(l).starts_with("G1 E") || code(l).starts_with("G1 F"))
            .map(|l| code(l).to_owned());
        // The first layer's own chunk opens with its extruder reset.
        let ours: Vec<&str> = ours
            .into_iter()
            .rev()
            .skip_while(|l| *l == "G92 E0")
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        assert_eq!(
            ours,
            theirs.iter().map(String::as_str).collect::<Vec<_>>(),
            "{id}"
        );
        let r = first_retract.expect("a first retraction");
        assert!(
            (word(&r, 'E').unwrap_or(0.0) + 6.5).abs() < 1e-9 && word(&r, 'F') == Some(2700.0),
            "{id}: {r}"
        );
    }
}

#[test]
fn print_core_switches_are_curas() {
    for id in MACHINES {
        let g: Vec<String> = slice(id).lines().map(str::to_owned).collect();
        let theirs = cura(id);
        let (first, k) = switch_block(&g, 1, 0);
        assert_eq!(
            skeleton(&first),
            skeleton(&lines(&theirs["firstSwitch"])),
            "{id}: the first switch to the second core\n{}",
            first.join("\n")
        );
        let (later, _) = switch_block(&g, 0, k + 1);
        assert_eq!(
            skeleton(&later),
            skeleton(&lines(&theirs["laterSwitch"])),
            "{id}: the switch back\n{}",
            later.join("\n")
        );
    }
}

#[test]
fn the_second_core_prints_shifted_by_its_offset() {
    // The firmware applies no X offset: the right core's moves are written 22 mm to the left of where it prints.
    for id in MACHINES {
        let p = sx_settings::printer_profile(id).expect("profile");
        let sx_settings::BuildVolume::Rectangular { x, y, .. } = p.build_volume else {
            panic!()
        };
        let (cx, cy) = (x / 2.0, y / 2.0);
        let (mut tool, mut kind) = (0u8, String::new());
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        for l in slice(id).lines() {
            if let Some(t) = code(l).strip_prefix('T').and_then(|v| v.parse::<u8>().ok()) {
                tool = t;
            }
            if let Some(k) = l.strip_prefix(";TYPE:") {
                kind = k.to_lowercase();
            }
            let c = code(l);
            if tool == 1
                && c.starts_with("G1 ")
                && c.contains(" E")
                && !kind.contains("tower")
                && !kind.contains("brim")
                && !kind.contains("skirt")
                && let (Some(px), Some(py)) = (word(c, 'X'), word(c, 'Y'))
                && (py - cy).abs() < 10.5
            {
                lo = lo.min(px);
                hi = hi.max(px);
            }
        }
        assert!(
            (lo - (cx + 5.0 - 22.0)).abs() < 0.6 && (hi - (cx + 25.0 - 22.0)).abs() < 0.6,
            "{id}: {lo} to {hi}"
        );
    }
}

#[test]
fn slicing_in_pieces_writes_the_same_file() {
    // Each piece knows which cores printed before it, so only a core's first switch primes it.
    for id in ["ultimaker-s5", "ultimaker-s8"] {
        let whole = slice_with(id, 1);
        assert_eq!(slice_with(id, 4), whole, "{id}");
        assert_eq!(
            whole.lines().filter(|l| l.starts_with("G280")).count(),
            2,
            "{id}: the start and the first switch"
        );
    }
}
