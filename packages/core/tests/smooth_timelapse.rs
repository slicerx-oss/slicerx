// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Smooth timelapse (`timelapse_type` 1) on the Bambu Lab A1 and A1 mini. Each layer's shot parks the head at the
//! side of the bed, and the layer then starts on the prime tower so the ooze from the park lands there and not on
//! the part. The tower prints on every layer up to the top, with one filament as with several. With the prime tower
//! turned off the shots are taken as in a traditional timelapse, and the slice says so.

#![allow(clippy::cast_precision_loss, reason = "a few cubes on a plate")]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, MeshPart, SliceRequest, SliceRun};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// The app's config for a stock Bambu Lab printer: schema defaults, the resolved process, filament and printer,
/// then the printer family's G-code, the timelapse and layer change templates included.
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
        out.insert(key.into(), gcode["families"][&family][part].clone());
    }
    out
}

/// Two filaments loaded, both PLA.
fn two_filaments(c: &mut Map<String, Value>) {
    for (k, v) in [
        ("nozzle_temperature", json!([220, 220])),
        ("nozzle_temperature_initial_layer", json!([220, 220])),
        ("filament_type", json!(["PLA", "PLA"])),
        ("filament_diameter", json!([1.75, 1.75])),
        ("filament_colour", json!(["#FF0000", "#0000FF"])),
    ] {
        c.insert(k.into(), v);
    }
}

/// Cubes of the 20 mm test cube scaled to `heights` mm, one per filament slot given, 40 mm apart about `center`.
fn slice(config: Map<String, Value>, center: [f64; 2], cubes: &[(u8, f64)]) -> SliceRun {
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    let m = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
    let (lo, hi) = m.bounds().unwrap();
    let size = f64::from(hi[2] - lo[2]);
    let step = 40.0;
    let first = -step * (cubes.len() as f64 - 1.0) / 2.0;
    let objects: Vec<Value> = cubes
        .iter()
        .enumerate()
        .map(|(i, &(slot, height))| {
            let z = height / size;
            let x = center[0] + first + step * i as f64 - f64::from(lo[0] + hi[0]) / 2.0;
            let y = center[1] - f64::from(lo[1] + hi[1]) / 2.0;
            json!({
                "id": format!("o{i}"),
                "name": format!("cube{i}"),
                "mesh": "c",
                "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, z, 0, x, y, -f64::from(lo[2]) * z, 1],
                "slotOverrides": {"cube.stl": slot},
            })
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
}

/// A box part from `lo` to `hi`, mm.
fn cuboid(lo: [f32; 3], hi: [f32; 3], name: &str) -> MeshPart {
    let positions = (0..8)
        .map(|i| {
            [
                if i & 1 == 0 { lo[0] } else { hi[0] },
                if i & 2 == 0 { lo[1] } else { hi[1] },
                if i & 4 == 0 { lo[2] } else { hi[2] },
            ]
        })
        .collect();
    MeshPart {
        name: name.into(),
        slot: 1,
        positions,
        triangles: vec![
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
        ],
        ..MeshPart::default()
    }
}

/// A tee (a column under a wide slab) at the middle of the A1's bed, which needs support under the slab.
fn slice_tee(config: Map<String, Value>) -> SliceRun {
    #[allow(
        clippy::needless_update,
        reason = "a mesh may gain fields; the default keeps this test building"
    )]
    let m = Arc::new(Mesh {
        name: "tee".into(),
        parts: vec![
            cuboid([10.0, 0.0, 0.0], [20.0, 10.0, 8.0], "column"),
            cuboid([0.0, 0.0, 8.0], [30.0, 10.0, 10.0], "slab"),
        ],
        ..Mesh::default()
    });
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{
            "id": "o0", "name": "tee", "mesh": "t",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 113, 123, 0, 1],
        }]},
        "config": Value::Object(config),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
}

fn gcode(r: &SliceRun) -> String {
    String::from_utf8(r.gcode.clone()).unwrap()
}

/// Each layer's marks in print order: `TL` for the timelapse shot, `T<n>` for a filament change, and each feature
/// when it starts. Layers start at the layer change template's progress line.
fn layers(g: &str) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    for l in g.lines() {
        if l.starts_with("; layer num/total_layer_count:") {
            out.push(Vec::new());
            continue;
        }
        let Some(cur) = out.last_mut() else { continue };
        let mark = if l.contains("SKIPTYPE: timelapse") {
            "TL".to_owned()
        } else if let Some(f) = l.strip_prefix("; FEATURE: ") {
            f.trim().to_owned()
        } else if l.len() > 1 && l.starts_with('T') && l[1..].trim().chars().all(|c| c.is_ascii_digit()) {
            l.trim().to_owned()
        } else {
            continue;
        };
        if cur.last() != Some(&mark) {
            cur.push(mark);
        }
    }
    out
}

fn smooth(model: &str) -> Map<String, Value> {
    let mut c = stock(model);
    c.insert("timelapse_type".into(), json!("1"));
    c
}

#[test]
fn a1_smooth_timelapse_starts_every_layer_on_the_tower_after_the_shot() {
    // The X1 Carbon's template takes its smooth shots the same way.
    for (model, center) in [
        ("bambu-a1", [128.0, 128.0]),
        ("bambu-a1-mini", [90.0, 90.0]),
        ("bambu-x1-carbon", [128.0, 128.0]),
    ] {
        let r = slice(smooth(model), center, &[(1, 6.0)]);
        assert!(
            r.report.prime_tower.is_some(),
            "{model}: one filament gets a tower"
        );
        let ls = layers(&gcode(&r));
        assert_eq!(ls.len(), r.report.layer_count as usize, "{model}");
        for (i, l) in ls.iter().enumerate() {
            assert_eq!(
                l.iter().take(2).map(String::as_str).collect::<Vec<_>>(),
                ["TL", "Prime tower"],
                "{model} layer {i}: the shot, then the tower, then the part: {l:?}"
            );
            assert_eq!(
                l.iter().filter(|m| *m == "Prime tower").count(),
                1,
                "{model} layer {i}: the tower prints once: {l:?}"
            );
        }
    }
}

#[test]
fn a1_traditional_timelapse_keeps_one_filament_without_a_tower() {
    let mut c = stock("bambu-a1");
    c.insert("timelapse_type".into(), json!("0"));
    let r = slice(c, [128.0, 128.0], &[(1, 6.0)]);
    assert!(r.report.prime_tower.is_none());
    let g = gcode(&r);
    assert!(!g.contains("; FEATURE: Prime tower"));
    // The shot waits for the first infill on a bed slinger, after the walls.
    for (i, l) in layers(&g).iter().enumerate() {
        assert_ne!(l.first().map(String::as_str), Some("TL"), "layer {i}: {l:?}");
        assert!(l.contains(&"TL".to_owned()), "layer {i}: {l:?}");
    }
}

#[test]
fn a1_smooth_timelapse_with_the_tower_off_shoots_as_traditional_and_says_so() {
    let mut off = smooth("bambu-a1");
    off.insert("enable_prime_tower".into(), json!(false));
    let r = slice(off, [128.0, 128.0], &[(1, 6.0)]);
    assert!(r.report.prime_tower.is_none());
    let notes: Vec<&str> = r.report.warnings.iter().map(|w| w.message.as_str()).collect();
    assert!(
        notes
            .iter()
            .any(|m| m.starts_with("Smooth timelapse needs the prime tower")),
        "{notes:?}"
    );
    let mut trad = stock("bambu-a1");
    trad.insert("timelapse_type".into(), json!("0"));
    trad.insert("enable_prime_tower".into(), json!(false));
    let t = slice(trad, [128.0, 128.0], &[(1, 6.0)]);
    assert_eq!(layers(&gcode(&r)), layers(&gcode(&t)));
    // A traditional timelapse needs no note.
    assert!(
        t.report
            .warnings
            .iter()
            .all(|w| !w.message.starts_with("Smooth timelapse"))
    );
}

#[test]
fn a1_smooth_timelapse_estimate_counts_the_parks_and_the_tower() {
    let r = slice(smooth("bambu-a1"), [128.0, 128.0], &[(1, 6.0)]);
    let mut trad = stock("bambu-a1");
    trad.insert("timelapse_type".into(), json!("0"));
    let t = slice(trad.clone(), [128.0, 128.0], &[(1, 6.0)]);
    let mut none = trad;
    none.insert("time_lapse_gcode".into(), json!(""));
    let n = slice(none, [128.0, 128.0], &[(1, 6.0)]);
    let layers = f64::from(r.report.layer_count);
    // Each park travels to the side of the bed and back and waits 0.3 s for the shot.
    assert!(
        t.report.stats.time_s > n.report.stats.time_s + 0.3 * layers,
        "parks: {} against {} without",
        t.report.stats.time_s,
        n.report.stats.time_s
    );
    // The smooth timelapse adds the tower on every layer.
    assert!(
        r.report.stats.time_s > t.report.stats.time_s + 0.5 * layers,
        "smooth {} traditional {}",
        r.report.stats.time_s,
        t.report.stats.time_s
    );
    // The layer times carry them too.
    let seconds_by_layer =
        |r: &SliceRun| -> f64 { r.report.layer_time_s.iter().map(|s| f64::from(*s)).sum() };
    assert!(
        seconds_by_layer(&t) > seconds_by_layer(&n) + 0.3 * layers,
        "layer times: {} against {} without",
        seconds_by_layer(&t),
        seconds_by_layer(&n)
    );
    assert!(
        seconds_by_layer(&r) > seconds_by_layer(&t) + 0.5 * layers,
        "layer times: smooth {} traditional {}",
        seconds_by_layer(&r),
        seconds_by_layer(&t)
    );
}

#[test]
fn a1_smooth_timelapse_keeps_the_tower_up_to_the_top_with_two_filaments() {
    // A tall cube in filament 1 and a short one in filament 2: the changes stop with the short cube.
    let mut c = smooth("bambu-a1");
    two_filaments(&mut c);
    let r = slice(c.clone(), [128.0, 128.0], &[(1, 6.0), (2, 2.0)]);
    let ls = layers(&gcode(&r));
    for (i, l) in ls.iter().enumerate() {
        assert_eq!(
            l.iter().take(2).map(String::as_str).collect::<Vec<_>>(),
            ["TL", "Prime tower"],
            "layer {i}: the shot, then the tower: {l:?}"
        );
    }
    // Traditional: the tower stops with the last change.
    c.insert("timelapse_type".into(), json!("0"));
    let t = slice(c, [128.0, 128.0], &[(1, 6.0), (2, 2.0)]);
    let tl = layers(&gcode(&t));
    assert!(
        !tl.last().unwrap().contains(&"Prime tower".to_owned()),
        "{:?}",
        tl.last()
    );
}

#[test]
fn a1_smooth_timelapse_starts_support_only_layers_on_the_tower_too() {
    // Slim tree support keeps layers of its own height, so some print layers hold only support.
    let mut c = smooth("bambu-a1");
    for (k, v) in [
        ("enable_support", json!(true)),
        ("support_type", json!("tree(auto)")),
        ("support_style", json!("tree_slim")),
    ] {
        c.insert(k.into(), v);
    }
    let r = slice_tee(c);
    let ls = layers(&gcode(&r));
    let object = |m: &String| {
        !matches!(
            m.as_str(),
            "TL" | "Prime tower" | "Support" | "Support interface" | "Support transition"
        ) && !m.starts_with('T')
    };
    let support_only: Vec<usize> = ls
        .iter()
        .enumerate()
        .filter(|(_, l)| l.iter().any(|m| m.starts_with("Support")) && !l.iter().any(object))
        .map(|(i, _)| i)
        .collect();
    assert!(!support_only.is_empty(), "no support-only layer: {ls:?}");
    for (i, l) in ls.iter().enumerate() {
        assert_eq!(
            l.iter().take(2).map(String::as_str).collect::<Vec<_>>(),
            ["TL", "Prime tower"],
            "layer {i} (support only: {}): {l:?}",
            support_only.contains(&i)
        );
    }
}

#[test]
fn a1_smooth_timelapse_walls_the_tower_with_the_outline_settings_off() {
    let mut c = smooth("bambu-a1");
    c.insert("prime_tower_outline".into(), json!(false));
    c.insert("wipe_tower_no_sparse_layers".into(), json!(true));
    let r = slice(c, [128.0, 128.0], &[(1, 6.0)]);
    for (i, l) in layers(&gcode(&r)).iter().enumerate() {
        assert_eq!(
            l.iter().take(2).map(String::as_str).collect::<Vec<_>>(),
            ["TL", "Prime tower"],
            "layer {i}: {l:?}"
        );
    }
}
