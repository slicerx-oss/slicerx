// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A plate that prints with some of the loaded filaments heats only those. Two boxes in filaments 2 and 4, with the
//! first layer hotter than the rest: the switch to the usual temperature after the first layer, and any temperature a
//! later layer sets, name tools 1 and 3 only, on the Snapmaker U1 with its own G-code and on a plain printer with none.
//! A start G-code that asks `is_extruder_used` (the Prusa XL's) heats those two and turns every other loaded one off,
//! and on the U1 the print's end runs the filament end G-code of the two it printed with only.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(case: &str) -> TempDir {
    let dir = TempDir(std::env::temp_dir().join(format!("sx-idle-heads-{case}-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    dir
}

/// An 8 mm box, 1 mm tall, as a binary STL.
fn box_stl(path: &Path) {
    let (w, h) = (8.0_f32, 1.0_f32);
    let v: Vec<[f32; 3]> = [0.0, w]
        .iter()
        .flat_map(|&x| {
            [0.0, w]
                .into_iter()
                .flat_map(move |y| [0.0, h].into_iter().map(move |z| [x, y, z]))
        })
        .collect();
    let faces = [
        [0, 2, 6],
        [0, 6, 4],
        [1, 5, 7],
        [1, 7, 3],
        [0, 4, 5],
        [0, 5, 1],
        [2, 3, 7],
        [2, 7, 6],
        [0, 1, 3],
        [0, 3, 2],
        [4, 6, 7],
        [4, 7, 5],
    ];
    let mut b = vec![0u8; 80];
    b.extend_from_slice(&u32::try_from(faces.len()).unwrap().to_le_bytes());
    for f in faces {
        b.extend_from_slice(&[0u8; 12]);
        for i in f {
            for c in v[i] {
                b.extend_from_slice(&c.to_le_bytes());
            }
        }
        b.extend_from_slice(&[0, 0]);
    }
    std::fs::write(path, b).unwrap();
}

fn profiles() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../profiles")
}

/// A printer's machine settings with its maker's G-code, as the profiles carry them.
fn maker_config(model: &str, family: &str) -> serde_json::Map<String, Value> {
    let read = |name: &str| -> Value {
        serde_json::from_str(&std::fs::read_to_string(profiles().join(name)).unwrap()).unwrap()
    };
    let machine = read("machine.json");
    let gcode = read("gcode.json");
    let mut cfg = machine["models"][model]["machine"].as_object().unwrap().clone();
    let family = &gcode["families"][family];
    for (key, setting) in [
        ("start", "machine_start_gcode"),
        ("end", "machine_end_gcode"),
        ("beforeLayerChange", "before_layer_change_gcode"),
        ("layerChange", "layer_change_gcode"),
        ("changeFilament", "change_filament_gcode"),
        ("timeLapse", "time_lapse_gcode"),
    ] {
        if let Some(text) = family[key].as_str() {
            cfg.insert(setting.to_owned(), json!(text));
        }
    }
    let profile = machine["models"][model]["orca"]["profile"].clone();
    cfg.insert("printer_settings_id".to_owned(), profile);
    cfg
}

fn u1_config() -> serde_json::Map<String, Value> {
    let mut cfg = maker_config("snapmaker-u1", "maker_snapmaker_u1");
    cfg.insert("printer_model".to_owned(), json!("Snapmaker U1"));
    cfg
}

/// The G-code of two boxes in filaments 2 and 4 of `filaments`, first layer at 220 and the rest at 210.
fn slice(case: &str, mut cfg: serde_json::Map<String, Value>, flavor: &str, filaments: usize) -> String {
    let dir = temp_dir(case);
    box_stl(&dir.0.join("b2.stl"));
    box_stl(&dir.0.join("b4.stl"));
    let each = |v: &str| json!(vec![v; filaments]);
    cfg.insert("filament_colour".to_owned(), each("#FF0000"));
    cfg.insert("filament_type".to_owned(), each("PLA"));
    cfg.insert("nozzle_temperature_initial_layer".to_owned(), each("220"));
    cfg.insert("nozzle_temperature".to_owned(), each("210"));
    let place = |x: f64| json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 130, 0, 1]);
    let request = json!({
        "schemaVersion": 1,
        "meshes": {"b2": "b2.stl", "b4": "b4.stl"},
        "plate": {"objects": [
            {"id": "box2", "mesh": "b2", "transform": place(120.0), "slotOverrides": {"b2.stl": 2}},
            {"id": "box4", "mesh": "b4", "transform": place(140.0), "slotOverrides": {"b4.stl": 4}},
        ]},
        "config": cfg,
        "options": {"flavor": flavor},
    });
    let path = dir.0.join("request.json");
    std::fs::write(&path, serde_json::to_vec(&request).unwrap()).unwrap();
    let out = dir.0.join("out");
    let o = Command::new(env!("CARGO_BIN_EXE_sx"))
        .args(["slice", "--request"])
        .arg(&path)
        .arg("--out-dir")
        .arg(&out)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "{case}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    std::fs::read_to_string(out.join("slice.gcode")).unwrap()
}

/// The tool and temperature of each `M104`/`M109` that names a logical tool (`T<n>`, not `A0`), after the first
/// layer change.
fn body_temps(gcode: &str) -> Vec<(u32, u32)> {
    let body = &gcode[gcode.find(";LAYER_CHANGE").expect("a layer change")..];
    body.lines()
        .filter_map(|line| {
            let words: Vec<_> = line.split(';').next().unwrap().split_whitespace().collect();
            if !matches!(words.first(), Some(&("M104" | "M109"))) || words.contains(&"A0") {
                return None;
            }
            let tool = words.iter().find_map(|w| w.strip_prefix('T')?.parse().ok())?;
            let temp = words.iter().find_map(|w| w.strip_prefix('S')?.parse().ok())?;
            Some((tool, temp))
        })
        .collect()
}

fn check(case: &str, gcode: &str) {
    let temps = body_temps(gcode);
    assert!(
        temps.contains(&(1, 210)) && temps.contains(&(3, 210)),
        "{case}: each printing tool goes to 210 after the first layer: {temps:?}"
    );
    assert!(
        temps.iter().all(|(tool, _)| matches!(tool, 1 | 3)),
        "{case}: a filament the plate never prints with is heated: {temps:?}"
    );
}

#[test]
fn a_u1_plate_heats_only_the_filaments_it_prints_with() {
    // Each filament's end G-code names its filament; the print's end runs it for the two the plate prints with.
    let mut cfg = u1_config();
    cfg.insert(
        "filament_end_gcode".to_owned(),
        json!(["; end of 1", "; end of 2", "; end of 3", "; end of 4"]),
    );
    let gcode = slice("u1", cfg, "klipper", 4);
    check("u1", &gcode);
    // The start G-code's own turn off of every head stays as the maker wrote it.
    assert!(gcode.contains("M104 S0 T0 A0\nM104 S0 T1 A0\nM104 S0 T2 A0\nM104 S0 T3 A0\n"));
    let end = &gcode[gcode.rfind(";LAYER_CHANGE").unwrap()..];
    assert!(
        end.contains("; end of 2\n; end of 4\n"),
        "the two printed filaments end"
    );
    for n in [1, 3] {
        assert!(
            !gcode.contains(&format!("; end of {n}")),
            "filament {n} never printed"
        );
    }
}

#[test]
fn a_plain_multi_filament_printer_heats_only_the_filaments_it_prints_with() {
    let mut cfg = serde_json::Map::new();
    cfg.insert(
        "printable_area".to_owned(),
        json!(["0x0", "270x0", "270x270", "0x270"]),
    );
    cfg.insert("printable_height".to_owned(), json!("250"));
    cfg.insert("nozzle_diameter".to_owned(), json!(["0.4", "0.4", "0.4", "0.4"]));
    cfg.insert("extruder_offset".to_owned(), json!(["0x0", "0x0", "0x0", "0x0"]));
    for flavor in ["marlin2", "klipper"] {
        let gcode = slice(&format!("plain-{flavor}"), cfg.clone(), flavor, 4);
        check(flavor, &gcode);
    }
}

#[test]
fn a_prusa_xl_start_heats_the_tools_the_plate_prints_with_and_turns_off_the_rest() {
    let gcode = slice(
        "xl",
        maker_config("prusa-xl-5-toolhead", "maker_prusa_xl_5_toolhead"),
        "marlin2",
        5,
    );
    check("xl", &gcode);
    let start = &gcode[..gcode.find(";LAYER_CHANGE").unwrap()];
    let has = |line: &str| start.lines().any(|l| l.split(';').next().unwrap().trim() == line);
    // `num_extruders` is the five loaded filaments, so the template reaches tool 4, past the highest one printed.
    for tool in [0, 2, 4] {
        assert!(
            has(&format!("M104 T{tool} S0")),
            "tool {tool} is turned off:\n{start}"
        );
        assert!(
            !has(&format!("M104 T{tool} S220")),
            "tool {tool} is not heated:\n{start}"
        );
    }
    for tool in [1, 3] {
        assert!(has(&format!("M104 T{tool} S220")), "tool {tool} heats:\n{start}");
    }
}
