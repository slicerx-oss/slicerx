// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A project's prime tower spot per plate: Bambu Studio and Orca keep one `wipe_tower_x` and `wipe_tower_y` entry per
//! plate, and `sx slice <project.3mf> --plate N` and a request naming `project.3mf#N` print plate N's tower at plate
//! N's entry, with auto placement off as the app opens a project, unless the settings turn it on or off themselves.

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::many_single_char_names,
    reason = "a test model and G-code reader: tiny archives, plate coordinates in mm"
)]

use serde_json::{Value, json};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn sx() -> Command {
    Command::new(env!("CARGO_BIN_EXE_sx"))
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(name: &str) -> TempDir {
    let dir = std::env::temp_dir().join(format!("sx-plate-tower-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 == 1 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}

/// A stored ZIP of the given entries.
fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let offset = out.len() as u32;
        let crc = crc32(data);
        for (dst, sig) in [(&mut out, 0x0403_4b50u32), (&mut central, 0x0201_4b50u32)] {
            dst.extend_from_slice(&sig.to_le_bytes());
            if sig == 0x0201_4b50 {
                dst.extend_from_slice(&20u16.to_le_bytes());
            }
            dst.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            dst.extend_from_slice(&crc.to_le_bytes());
            dst.extend_from_slice(&(data.len() as u32).to_le_bytes());
            dst.extend_from_slice(&(data.len() as u32).to_le_bytes());
            dst.extend_from_slice(&(name.len() as u16).to_le_bytes());
            dst.extend_from_slice(&0u16.to_le_bytes());
            if sig == 0x0201_4b50 {
                dst.extend_from_slice(&[0; 10]);
                dst.extend_from_slice(&offset.to_le_bytes());
            }
            dst.extend_from_slice(name.as_bytes());
        }
        out.extend_from_slice(data);
    }
    let at = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&at.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

/// Each plate's tower spot, as the project's per-plate lists hold them.
const SPOTS: [[f64; 2]; 3] = [[30.0, 200.0], [180.0, 30.0], [200.0, 180.0]];

/// The project's settings: a 256 mm P1S bed with a 35 mm wide tower and the per-plate spots of [`SPOTS`].
fn settings() -> Value {
    json!({
        "printer_model": "Bambu Lab P1S",
        "printable_area": ["0x0", "256x0", "256x256", "0x256"],
        "filament_colour": ["#FFFFFF", "#FF0000", "#00A0FF", "#202020"],
        "nozzle_temperature": ["220", "220", "220", "220"],
        "enable_prime_tower": "1",
        "prime_tower_width": "35",
        "wipe_tower_x": SPOTS.map(|s| s[0].to_string()),
        "wipe_tower_y": SPOTS.map(|s| s[1].to_string()),
        "brim_width": "0",
        "skirt_loops": "0",
        "layer_height": "0.2",
        "initial_layer_print_height": "0.2",
    })
}

/// A Bambu Studio style project with one plate per entry of `ids` (its `plater_id`, in the file's order), each holding
/// a 30 x 30 x 3 mm box in the middle of its plate, filament 1 with its front face painted another filament, so every
/// layer changes tools and a tower is planned. Later plates sit on the project's grid beside the first.
fn project(ids: &[u32]) -> Vec<u8> {
    let (w, d) = (256.0_f64, 256.0_f64);
    let cols = (ids.len() as f64).sqrt().ceil() as usize;
    let (mut res, mut build, mut objects, mut plates) =
        (String::new(), String::new(), String::new(), String::new());
    for (i, id) in ids.iter().enumerate() {
        let o = i + 1;
        let v = [
            (-15, -15, 0),
            (15, -15, 0),
            (15, 15, 0),
            (-15, 15, 0),
            (-15, -15, 3),
            (15, -15, 3),
            (15, 15, 3),
            (-15, 15, 3),
        ];
        // the front face (y = -15) painted
        let t = [
            ([0, 2, 1], false),
            ([0, 3, 2], false),
            ([4, 5, 6], false),
            ([4, 6, 7], false),
            ([0, 1, 5], true),
            ([0, 5, 4], true),
            ([1, 2, 6], false),
            ([1, 6, 5], false),
            ([2, 3, 7], false),
            ([2, 7, 6], false),
            ([3, 0, 4], false),
            ([3, 4, 7], false),
        ];
        let _ = write!(res, r#"<object id="{o}" type="model"><mesh><vertices>"#);
        for (x, y, z) in v {
            let _ = write!(res, r#"<vertex x="{x}" y="{y}" z="{z}"/>"#);
        }
        res.push_str("</vertices><triangles>");
        for ([a, b, c], painted) in t {
            let paint = if painted { r#" paint_color="1C""# } else { "" };
            let _ = write!(res, r#"<triangle v1="{a}" v2="{b}" v3="{c}"{paint}/>"#);
        }
        res.push_str("</triangles></mesh></object>");
        let (col, row) = ((i % cols) as f64, (i / cols) as f64);
        let (x, y) = (col * w * 1.2 + 128.0, -row * d * 1.2 + 128.0);
        let _ = write!(
            build,
            r#"<item objectid="{o}" transform="1 0 0 0 1 0 0 0 1 {x} {y} 0"/>"#
        );
        let _ = write!(
            objects,
            r#"<object id="{o}"><metadata key="name" value="box{o}"/><metadata key="extruder" value="1"/></object>"#
        );
        let _ = write!(
            plates,
            r#"<plate><metadata key="plater_id" value="{id}"/><model_instance><metadata key="object_id" value="{o}"/></model_instance></plate>"#
        );
    }
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>{res}</resources><build>{build}</build></model>"#
    );
    let config = format!(r#"<?xml version="1.0" encoding="UTF-8"?><config>{objects}{plates}</config>"#);
    let settings = settings().to_string();
    zip(&[
        ("3D/3dmodel.model", model.as_bytes()),
        ("Metadata/model_settings.config", config.as_bytes()),
        ("Metadata/project_settings.config", settings.as_bytes()),
    ])
}

/// The front left corner of the prime tower in a G-code file: the 2nd percentile of the X and Y its extrusions reach
/// from the second layer up, so a stray wipe does not move it.
fn tower_corner(gcode: &str) -> Option<[f64; 2]> {
    let (mut feature, mut layer, mut at) = (String::new(), 0, [f64::NAN; 2]);
    let (mut xs, mut ys) = (Vec::new(), Vec::new());
    for line in gcode.lines() {
        if let Some(f) = line.strip_prefix("; FEATURE:") {
            f.trim().clone_into(&mut feature);
        } else if line.starts_with("; CHANGE_LAYER") {
            layer += 1;
        } else if line.starts_with("G1 ") || line.starts_with("G2 ") || line.starts_with("G3 ") {
            let word = |c: char| {
                line.split_whitespace()
                    .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
            };
            let next = [word('X').unwrap_or(at[0]), word('Y').unwrap_or(at[1])];
            if feature == "Prime tower"
                && layer >= 2
                && word('E').is_some_and(|e| e > 0.0)
                && next.iter().all(|v| v.is_finite())
            {
                xs.push(next[0]);
                ys.push(next[1]);
            }
            at = next;
        }
    }
    if xs.is_empty() {
        return None;
    }
    let low = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        v[(0.02 * (v.len() - 1) as f64) as usize]
    };
    Some([low(&mut xs), low(&mut ys)])
}

fn near(got: [f64; 2], want: [f64; 2]) -> bool {
    (got[0] - want[0]).abs() < 1.0 && (got[1] - want[1]).abs() < 1.0
}

/// `sx slice <file> --plate N` with `extra` arguments: its output and the tower's corner.
fn cli(dir: &Path, file: &Path, plate: u32, extra: &[&str]) -> (Output, Option<[f64; 2]>) {
    let out = dir.join(format!("plate{plate}-{}.gcode", extra.len()));
    let run = sx()
        .arg("slice")
        .arg(file)
        .args(["--plate", &plate.to_string(), "-o"])
        .arg(&out)
        .args(extra)
        .output()
        .unwrap();
    assert!(run.status.success(), "{}", String::from_utf8_lossy(&run.stderr));
    let corner = tower_corner(&std::fs::read_to_string(&out).unwrap());
    (run, corner)
}

/// `sx slice --request` of plate `plate` of `file` with `config`: its stderr and the result's `primeTower`.
fn request(dir: &Path, file: &Path, plate: u32, config: &Value) -> (String, Value) {
    let tag = format!(
        "req{plate}-{}",
        config.as_object().map_or(0, serde_json::Map::len)
    );
    let path = dir.join(format!("{tag}.json"));
    let req = json!({
        "schemaVersion": 1,
        "meshes": {"m": format!("{}#{plate}", file.display())},
        "plate": {"objects": [{"id": "m", "mesh": "m"}]},
        "config": config,
        "options": {"emitGcode": true},
    });
    std::fs::write(&path, req.to_string()).unwrap();
    let run = sx()
        .args(["slice", "--request"])
        .arg(&path)
        .arg("--out-dir")
        .arg(dir.join(&tag))
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&run.stderr).into_owned();
    assert!(run.status.success(), "{stderr}");
    let result: Value = serde_json::from_slice(&run.stdout).unwrap();
    (stderr, result["primeTower"].clone())
}

/// Each plate of the project prints its tower at its own spot, from `sx slice` with the project's settings as they
/// are (the project sets the spot, so auto placement goes off), and with auto placement turned off by `--config`.
#[test]
fn sx_slice_prints_each_plates_tower_at_its_own_spot() {
    let dir = temp_dir("cli");
    let file = dir.0.join("three-towers.3mf");
    std::fs::write(&file, project(&[1, 2, 3])).unwrap();
    let off = dir.0.join("auto-off.json");
    std::fs::write(&off, r#"{"prime_tower_auto_position": false}"#).unwrap();
    let off = off.display().to_string();
    for (plate, want) in (1..=3).zip(SPOTS) {
        let (_, corner) = cli(&dir.0, &file, plate, &[]);
        let corner = corner.expect("a tower");
        assert!(
            near(corner, want),
            "plate {plate}: tower at {corner:?}, want {want:?}"
        );
        let (_, corner) = cli(&dir.0, &file, plate, &["--config", &off]);
        let corner = corner.expect("a tower");
        assert!(
            near(corner, want),
            "plate {plate}, auto off: tower at {corner:?}, want {want:?}"
        );
    }
}

/// `--config` turning auto placement on wins over the project's spot.
#[test]
fn sx_slice_auto_placement_turned_on_by_config_wins() {
    let dir = temp_dir("cli-auto");
    let file = dir.0.join("three-towers.3mf");
    std::fs::write(&file, project(&[1, 2, 3])).unwrap();
    let on = dir.0.join("auto-on.json");
    std::fs::write(&on, r#"{"prime_tower_auto_position": true}"#).unwrap();
    let (_, corner) = cli(&dir.0, &file, 2, &["--config", &on.display().to_string()]);
    let corner = corner.expect("a tower");
    assert!(
        !near(corner, SPOTS[1]),
        "auto placement on, tower still at the project's spot {corner:?}"
    );
}

/// A request naming each plate of the project, with the project's settings as its config (as a client passes them),
/// keeps the plate's own spot; a config that turns auto placement on keeps that.
#[test]
fn a_request_keeps_each_plates_own_tower_spot() {
    let dir = temp_dir("request");
    let file = dir.0.join("three-towers.3mf");
    std::fs::write(&file, project(&[1, 2, 3])).unwrap();
    for (plate, want) in (1..=3).zip(SPOTS) {
        let (_, tower) = request(&dir.0, &file, plate, &settings());
        assert_eq!(tower["reason"], "kept", "plate {plate}: {tower}");
        let got = [tower["x"].as_f64().unwrap(), tower["y"].as_f64().unwrap()];
        assert!(near(got, want), "plate {plate}: tower at {got:?}, want {want:?}");
    }
    let mut auto = settings();
    auto["prime_tower_auto_position"] = json!(true);
    let (_, tower) = request(&dir.0, &file, 2, &auto);
    assert_eq!(tower["reason"], "auto", "{tower}");
}

/// A project whose plate numbers have a gap (plate 2 taken out by hand, leaving 1 and 3) or are out of order does not
/// say which list entry is which plate's: the tower is left to the engine, and stderr says why.
#[test]
fn plates_numbered_out_of_order_leave_the_tower_to_the_engine() {
    let dir = temp_dir("unsure");
    for (name, ids, plate) in [("gap", &[1, 3][..], 3), ("moved", &[2, 1, 3][..], 1)] {
        let file = dir.0.join(format!("{name}.3mf"));
        std::fs::write(&file, project(ids)).unwrap();
        let (run, _) = cli(&dir.0, &file, plate, &[]);
        let stderr = String::from_utf8_lossy(&run.stderr);
        assert!(stderr.contains("is not certain"), "{name}: {stderr}");
        let (stderr, tower) = request(&dir.0, &file, plate, &settings());
        assert!(stderr.contains("is not certain"), "{name}: {stderr}");
        assert_eq!(tower["reason"], "auto", "{name}: {tower}");
    }
}
