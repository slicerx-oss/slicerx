// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `wipe_tower_no_sparse_layers`: the prime tower leaves out the layers without a tool change, and the next change
//! prints on top of the tower as it stands, one layer above its last printed layer, not at the object layer's
//! height in the air above it. The nozzle drops to the tower over the tower and comes back up over it, and the
//! objects keep printing at their own layer heights. With the setting off the tower prints at every layer's height.
//!
//! The plate: object A is a 5 mm body in filament 1 with a 1 mm cap in filament 2 on it, object B a 3 mm box in
//! filament 2. Filament changes up to 3.2 mm (B's top), none from 3.4 to 5.0 and again from 5.2 to 6.0 (the cap), on
//! the stock A1, P1S and X1 Carbon set up as the app sets them up.

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

/// A shipped Bambu Lab printer as the app sets it up: schema defaults, then the model's process, filament and
/// machine settings, then its G-code; two PLA filaments and the prime tower on.
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
    out.insert("layer_height".into(), json!(0.2));
    out.insert("initial_layer_print_height".into(), json!(0.2));
    out.insert("enable_prime_tower".into(), json!(true));
    out.insert("nozzle_temperature".into(), json!([220, 220]));
    out.insert("filament_diameter".into(), json!([1.75, 1.75]));
    out.insert("filament_type".into(), json!(["PLA", "PLA"]));
    out.insert("filament_colour".into(), json!(["#FFFFFF", "#000000"]));
    out
}

/// A box from `lo` to `hi` in filament `slot`.
fn block(lo: [f32; 3], hi: [f32; 3], slot: u8) -> api::MeshPart {
    let positions = (0..8)
        .map(|i| {
            [
                if i & 1 == 0 { lo[0] } else { hi[0] },
                if i & 2 == 0 { lo[1] } else { hi[1] },
                if i & 4 == 0 { lo[2] } else { hi[2] },
            ]
        })
        .collect();
    api::MeshPart {
        name: format!("block {slot}"),
        slot,
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
        ..api::MeshPart::default()
    }
}

fn slice(config: &Map<String, Value>) -> String {
    slice_own(config, &Value::Null)
}

/// [`slice`] with object A carrying `own` settings of its own (none when null): the plate then prints its objects
/// layer by layer from sessions of their own.
fn slice_own(config: &Map<String, Value>, own: &Value) -> String {
    let a = Arc::new(Mesh {
        name: "a".into(),
        parts: vec![
            block([0.0; 3], [15.0, 15.0, 5.0], 1),
            block([0.0, 0.0, 5.0], [15.0, 15.0, 6.0], 2),
        ],
        ..Mesh::default()
    });
    let b = Arc::new(Mesh {
        name: "b".into(),
        parts: vec![block([0.0; 3], [15.0, 15.0, 3.0], 2)],
        ..Mesh::default()
    });
    let mut a_object = json!({"id": "a", "name": "a", "mesh": "a",
        "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 105, 120, 0, 1]});
    if !own.is_null() {
        a_object["settings"] = own.clone();
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {
            "bed": {"widthMm": 256, "depthMm": 256, "heightMm": 250},
            "objects": [
                a_object,
                {"id": "b", "name": "b", "mesh": "b", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 135, 120, 0, 1]},
            ],
        },
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let run = api::run_request(&req, &move |name: &str| {
        Ok(if name == "a" { a.clone() } else { b.clone() })
    })
    .unwrap();
    String::from_utf8_lossy(&run.gcode).into_owned()
}

/// One print layer of the G-code: its height, the Z of every tower and every other extrusion, and every Z move
/// below the layer's height with where the nozzle was.
#[derive(Debug, Default)]
struct Layer {
    z: f64,
    tower: Vec<f64>,
    other: Vec<f64>,
    /// `(z, x, y)` for each move made below `z` once the nozzle has come up to it, XY moves and Z moves alike.
    low: Vec<(f64, f64, f64)>,
    reached: bool,
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

fn layers(gcode: &str) -> Vec<Layer> {
    let mut out: Vec<Layer> = Vec::new();
    let (mut x, mut y, mut z) = (0.0, 0.0, 0.0);
    let mut relative = false;
    let mut feature = String::new();
    for line in gcode.lines() {
        if let Some(v) = line.strip_prefix("; Z_HEIGHT:") {
            out.push(Layer {
                z: v.trim().parse().unwrap(),
                ..Layer::default()
            });
            continue;
        }
        if let Some(f) = line.strip_prefix("; FEATURE:") {
            f.trim().clone_into(&mut feature);
        }
        let code = line.split(';').next().unwrap_or("").trim();
        match code.split_whitespace().next() {
            Some("G90") => relative = false,
            Some("G91") => relative = true,
            Some("G0" | "G1" | "G2" | "G3") => {}
            _ => continue,
        }
        if !code.starts_with('G') || code.starts_with("G9") {
            continue;
        }
        let step = |now: f64, k: char| word(code, k).map_or(now, |v| if relative { now + v } else { v });
        (x, y, z) = (step(x, 'X'), step(y, 'Y'), step(z, 'Z'));
        let Some(l) = out.last_mut() else { continue };
        let moved = word(code, 'X').is_some() || word(code, 'Y').is_some();
        if moved && word(code, 'E').is_some_and(|e| e > 0.0) {
            if feature == "Prime tower" {
                l.tower.push(z);
            } else {
                l.other.push(z);
            }
        }
        if z < l.z - 1e-3 {
            if l.reached {
                l.low.push((z, x, y));
            }
        } else {
            l.reached = true;
        }
    }
    out
}

/// The tower's footprint over the whole print, from its extrusions, mm.
fn tower_box(gcode: &str) -> [f64; 4] {
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let mut tower = false;
    for line in gcode.lines() {
        if let Some(f) = line.strip_prefix("; FEATURE:") {
            tower = f.trim() == "Prime tower";
        }
        if tower
            && line.starts_with("G1 ")
            && word(line, 'E').is_some_and(|e| e > 0.0)
            && let (Some(x), Some(y)) = (word(line, 'X'), word(line, 'Y'))
        {
            b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
        }
    }
    b
}

const MODELS: [&str; 3] = ["bambu-a1", "bambu-p1s", "bambu-x1-carbon"];

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-3
}

#[test]
fn a_change_after_skipped_layers_prints_on_the_tower_top() {
    for model in MODELS {
        let mut c = stock(model);
        c.insert("wipe_tower_no_sparse_layers".into(), json!(true));
        on_the_tower_top(model, &slice(&c));
    }
}

#[test]
fn objects_with_settings_of_their_own_print_on_the_tower_top_too() {
    let mut c = stock("bambu-a1");
    c.insert("wipe_tower_no_sparse_layers".into(), json!(true));
    on_the_tower_top("bambu-a1 own settings", &slice_own(&c, &json!({"wall_loops": 3})));
}

/// Every tower layer of `g` prints one layer above the tower's last layer, and at least one change follows
/// skipped tower layers.
fn on_the_tower_top(model: &str, g: &str) {
    let ls = layers(g);
    // Where the tower stands after each layer: one layer above its last printed layer.
    let mut top: Option<f64> = None;
    let mut skipped = 0;
    let mut after_skip = 0;
    for l in &ls {
        let Some(&first) = l.tower.first() else {
            if top.is_some() && l.z < 6.0 - 1e-3 {
                skipped += 1;
            }
            continue;
        };
        let h = 0.2;
        let want = top.map_or(l.z, |t| t + h);
        assert!(
            l.tower.iter().all(|&z| near(z, want)),
            "{model}: the tower at layer {} prints at Z{first}, its top is {top:?}",
            l.z
        );
        if skipped > 0 {
            after_skip += 1;
            assert!(want < l.z - 1.0, "{model}: layer {} sank only to {first}", l.z);
        }
        skipped = 0;
        top = Some(want);
    }
    assert!(after_skip > 0, "{model}: no change after skipped tower layers");
}

#[test]
fn the_nozzle_goes_down_and_back_up_over_the_tower() {
    for model in MODELS {
        let mut c = stock(model);
        c.insert("wipe_tower_no_sparse_layers".into(), json!(true));
        let g = slice(&c);
        let b = tower_box(&g);
        let ls = layers(&g);
        let mut sank = false;
        for l in &ls {
            for &(z, x, y) in &l.low {
                sank = true;
                assert!(
                    x >= b[0] - 1.0 && x <= b[2] + 1.0 && y >= b[1] - 1.0 && y <= b[3] + 1.0,
                    "{model}: at layer {} the nozzle is at Z{z} outside the tower ({x}, {y}), tower {b:?}",
                    l.z
                );
            }
        }
        assert!(sank, "{model}: the nozzle never went down to the tower");
    }
}

#[test]
fn the_objects_keep_their_layer_heights() {
    for model in MODELS {
        for on in [false, true] {
            let mut c = stock(model);
            c.insert("wipe_tower_no_sparse_layers".into(), json!(on));
            let g = slice(&c);
            for l in layers(&g) {
                assert!(
                    l.other.iter().all(|&z| near(z, l.z)),
                    "{model} no sparse {on}: layer {} prints the objects at {:?}",
                    l.z,
                    l.other
                );
                if !on {
                    assert!(
                        l.tower.iter().all(|&z| near(z, l.z)),
                        "{model}: with sparse layers the tower at {} prints at {:?}",
                        l.z,
                        l.tower
                    );
                }
            }
        }
    }
}
