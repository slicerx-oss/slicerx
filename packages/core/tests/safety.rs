// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The safety preflight through `run_request`, the path every entry point
//! uses: toolpaths off the bed or inside an excluded area block, and unsafe
//! settings are lowered and reported.

// Options and configs are built with `json!` at each call, so taking them by value reads best.
#![allow(clippy::needless_pass_by_value)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{self, Mesh, SliceRequest, SliceRun};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn mesh() -> Arc<Mesh> {
    let bytes = std::fs::read(format!("{}/packages/core/bench/models/x-mark.stl", root())).unwrap();
    Arc::new(Mesh::load(&bytes, "x-mark.stl").unwrap())
}

fn base_config() -> Value {
    let bench: Value = serde_json::from_slice(
        &std::fs::read(format!(
            "{}/packages/core/bench/configs/reference-0.20.json",
            root()
        ))
        .unwrap(),
    )
    .unwrap();
    bench["config"].clone()
}

fn request(config: Value, options: Value, offset: [f64; 3]) -> SliceRequest {
    let t = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, offset[0], offset[1], offset[2], 1.0,
    ];
    let mut o = json!({"mesh": "x"});
    if offset.iter().any(|v| v.abs() > 0.0) {
        o["transform"] = json!(t);
    }
    serde_json::from_value(json!({ "plate": {"objects": [o]}, "config": config, "options": options }))
        .unwrap()
}

fn run(req: &SliceRequest) -> api::Result<SliceRun> {
    let m = mesh();
    common::run_request(req, &move |_: &str| Ok(m.clone()))
}

fn blocked(r: api::Result<SliceRun>) -> String {
    match r {
        Err(api::Error::Blocked(m)) => m,
        Err(e) => panic!("expected a block, got {e}"),
        Ok(_) => panic!("expected a block, the file was written"),
    }
}

#[test]
fn a_part_off_the_bed_blocks_the_file() {
    let msg = blocked(run(&request(base_config(), json!({}), [400.0, 0.0, 0.0])));
    assert!(msg.contains("outside the printable area"), "{msg}");
}

#[test]
fn a_part_on_the_bed_passes() {
    assert!(run(&request(base_config(), json!({}), [0.0; 3])).is_ok());
}

#[test]
fn the_generic_bed_takes_a_part_near_its_middle_and_refuses_one_past_its_edge() {
    // The no-printer bed is 256 mm square. The mark reaches X200.8 here, which a 200 mm area would refuse.
    let mut c = base_config();
    c["printable_area"] = json!(["0x0", "256x0", "256x256", "0x256"]);
    assert!(run(&request(c.clone(), json!({}), [158.5, 142.9, 0.0])).is_ok());
    let msg = blocked(run(&request(c, json!({}), [230.0, 142.9, 0.0])));
    assert!(msg.contains("outside the printable area"), "{msg}");
}

#[test]
fn a_bed_that_does_not_start_at_zero_takes_a_part_at_its_middle() {
    // Snapmaker U1: 270 mm square from 0.5, 1.
    let mut c = base_config();
    c["printable_area"] = json!(["0.5x1", "270.5x1", "270.5x271", "0.5x271"]);
    assert!(run(&request(c, json!({}), [135.5, 136.0, 0.0])).is_ok());
    // FLSUN V400: a 300 mm round bed centered on 0, 0. The middle of a plate counted from its corner is off it.
    let mut c = base_config();
    #[allow(clippy::disallowed_methods)] // a test outline, so platform rounding does not matter
    let circle: Vec<String> = (0..72)
        .map(|i| {
            let a = f64::from(i) * std::f64::consts::TAU / 72.0;
            format!("{:.4}x{:.4}", 150.0 * a.cos(), 150.0 * a.sin())
        })
        .collect();
    c["printable_area"] = json!(circle);
    // A zero offset would leave the placement to the engine; a hair off places it at the machine's middle.
    assert!(run(&request(c.clone(), json!({}), [0.001, 0.001, 0.0])).is_ok());
    let msg = blocked(run(&request(c, json!({}), [150.0, 150.0, 0.0])));
    assert!(msg.contains("outside the printable area"), "{msg}");
}

#[test]
fn a_part_inside_an_excluded_area_blocks_the_file() {
    let mut c = base_config();
    // The whole bed is excluded except nothing: a zone bigger than the part, over its center.
    c["bed_exclude_area"] = json!(["0x0", "1000x0", "1000x1000", "0x1000"]);
    let msg = blocked(run(&request(c, json!({}), [0.0; 3])));
    assert!(msg.contains("excluded bed area"), "{msg}");
}

#[test]
fn a_part_above_the_printable_height_blocks_the_file() {
    let mut c = base_config();
    c["printable_height"] = json!(3.0);
    let msg = blocked(run(&request(c, json!({}), [0.0; 3])));
    assert!(msg.contains("printable height"), "{msg}");
}

#[test]
fn temperatures_above_the_limits_are_lowered_and_reported() {
    let mut c = base_config();
    c["nozzle_temperature"] = json!([480]);
    c["hot_plate_temp"] = json!(200);
    let r = run(&request(
        c,
        json!({"machineLimits": {"nozzleMaxC": 300, "bedMaxC": 110}}),
        [0.0; 3],
    ))
    .unwrap();
    let g = String::from_utf8(r.gcode.clone()).unwrap();
    assert!(g.contains("M104 S300"), "nozzle clamped");
    assert!(!g.contains("S480") && !g.contains("S200"));
    let codes: Vec<_> = r
        .report
        .warnings
        .iter()
        .map(|w| format!("{:?}", w.code))
        .collect();
    assert!(
        codes.iter().filter(|c| *c == "SafetyLimit").count() >= 2,
        "{codes:?}"
    );
}

#[test]
fn the_plate_type_bed_temperature_is_held_to_the_bed_limit() {
    let mut c = base_config();
    c["curr_bed_type"] = json!("Textured PEI Plate");
    c["textured_plate_temp"] = json!([200]);
    c["textured_plate_temp_initial_layer"] = json!([200]);
    let r = run(&request(
        c,
        json!({"machineLimits": {"nozzleMaxC": 300, "bedMaxC": 110}}),
        [0.0; 3],
    ))
    .unwrap();
    let g = String::from_utf8(r.gcode.clone()).unwrap();
    assert!(!g.contains("S200"), "bed above its limit");
    assert!(g.contains("M140 S110") || g.contains("M190 S110"), "bed clamped");
}

#[test]
fn the_per_filament_bed_temperature_is_held_to_the_bed_limit() {
    let mut c = base_config();
    c["bed_temperature_formula"] = json!("by_highest_temp");
    c["hot_plate_temp"] = json!([200]);
    c["hot_plate_temp_initial_layer"] = json!([200]);
    let r = run(&request(
        c,
        json!({"machineLimits": {"nozzleMaxC": 300, "bedMaxC": 110}}),
        [0.0; 3],
    ))
    .unwrap();
    let g = String::from_utf8(r.gcode.clone()).unwrap();
    assert!(!g.contains("S200"), "bed above its limit");
}

#[test]
fn a_height_range_nozzle_temperature_is_held_to_the_hotend_limit() {
    let opts = json!({
        "machineLimits": {"nozzleMaxC": 300, "bedMaxC": 110},
        "heightRanges": [{"zFromMm": 1.0, "zToMm": 3.0, "settings": {"nozzle_temperature": [480]}}],
    });
    let r = run(&request(base_config(), opts, [0.0; 3])).unwrap();
    let g = String::from_utf8(r.gcode.clone()).unwrap();
    assert!(!g.contains("S480"), "nozzle above its limit");
    assert!(g.contains("M104 S300"), "range temperature clamped");
    assert!(
        r.report
            .warnings
            .iter()
            .any(|w| format!("{:?}", w.code) == "SafetyLimit"),
        "the clamp is reported"
    );
}

#[test]
fn a_resumed_print_lifts_before_it_homes_and_bounds_the_declared_z() {
    let opts = json!({"resumeFromLayer": 50, "resumeZ": {"mode": "declare", "zMm": 10.2}});
    let r = run(&request(base_config(), opts, [0.0; 3])).unwrap();
    let g = String::from_utf8(r.gcode.clone()).unwrap();
    let head = &g[..g.find(sx_core::extras::layer_mark(&g)).unwrap_or(g.len())];
    let (declare, lift, home) = (
        head.find("G92 Z10.200").unwrap(),
        head.find("G91\nG1 Z5.0").unwrap(),
        head.find("G28 X Y").unwrap(),
    );
    assert!(declare < lift && lift < home, "{head}");
    // Without a declared Z the lift still comes before homing.
    let plain = run(&request(base_config(), json!({"resumeFromLayer": 50}), [0.0; 3])).unwrap();
    let g = String::from_utf8(plain.gcode.clone()).unwrap();
    assert!(g.find("G91\nG1 Z5.0").unwrap() < g.find("G28 X Y").unwrap());
    // A Z above the sliced part would send the nozzle into it.
    let high = json!({"resumeFromLayer": 50, "resumeZ": {"mode": "declare", "zMm": 240.0}});
    assert!(blocked(run(&request(base_config(), high, [0.0; 3]))).contains("declared Z"));
}

#[test]
fn a_project_cannot_carry_post_process_or_host_credentials() {
    let mut c = base_config();
    c["post_process"] = json!(["/bin/sh -c 'echo hi'"]);
    c["printhost_apikey"] = json!("sentinel-secret-key");
    let r = run(&request(c, json!({}), [0.0; 3])).unwrap();
    let g = String::from_utf8(r.gcode.clone()).unwrap();
    assert!(!g.contains("sentinel-secret-key") && !g.contains("/bin/sh"));
    let json = serde_json::to_string(&r.report).unwrap();
    assert!(!json.contains("sentinel-secret-key"));
}

/// Feed rates of the extruding moves the engine sets with a bare `G1 F` line, mm/s.
fn print_speeds(g: &str) -> Vec<f64> {
    g.lines()
        .filter_map(|l| l.strip_prefix("G1 F"))
        .filter_map(|f| f.parse::<f64>().ok())
        .map(|f| f / 60.0)
        .collect()
}

#[test]
fn the_volumetric_limit_and_axis_limits_cap_speeds_and_the_estimate() {
    let free = run(&request(base_config(), json!({}), [0.0; 3])).unwrap();
    let fastest = print_speeds(&String::from_utf8(free.gcode.clone()).unwrap())
        .into_iter()
        .fold(0.0, f64::max);
    assert!(fastest > 100.0, "the reference profile prints fast: {fastest}");
    let mut c = base_config();
    // 6 mm3/s through a 0.42 by 0.2 bead is about 71 mm/s. Thin bands of solid infill print as narrower
    // beads, which the limit lets run faster, so every move is held to the limit of its own width.
    c["filament_max_volumetric_speed"] = json!(["6"]);
    let capped = run(&request(c, json!({}), [0.0; 3])).unwrap();
    let text = String::from_utf8(capped.gcode.clone()).unwrap();
    let (mut width, mut height, mut moves, mut narrow) = (0.42, 0.2, 0, 0);
    for l in text.lines() {
        if let Some(v) = l.strip_prefix(";WIDTH:") {
            width = v.parse().unwrap_or(width);
        } else if let Some(v) = l.strip_prefix(";HEIGHT:") {
            height = v.parse().unwrap_or(height);
        } else if let Some(f) = l.strip_prefix("G1 F").and_then(|f| f.parse::<f64>().ok()) {
            let flow = f / 60.0 * sx_core::gcode::bead_area(width, height);
            assert!(
                flow <= 6.0 * 1.05,
                "{l} after width {width} height {height}: {flow} mm3/s"
            );
            moves += 1;
            narrow += usize::from(width < 0.40);
        }
    }
    assert!(moves > 1000, "{moves} speed changes");
    assert!(
        narrow > 0,
        "no variable-width bead in the slice, the check does not reach Arachne beads"
    );
    assert!(
        capped.report.stats.time_s > free.report.stats.time_s * 1.05,
        "the estimate follows the cap"
    );
    let mut c = base_config();
    c["machine_max_speed_x"] = json!(["60", "50"]);
    c["machine_max_speed_y"] = json!(["60", "50"]);
    let slow = run(&request(c, json!({}), [0.0; 3])).unwrap();
    let top = print_speeds(&String::from_utf8(slow.gcode.clone()).unwrap())
        .into_iter()
        .fold(0.0, f64::max);
    assert!(top <= 60.5, "{top}");
}

/// A binary STL of a 20 mm cube, its far top corner moved to `corner`.
fn cube_stl(corner: [f32; 3]) -> Vec<u8> {
    let mut v = [
        [0.0, 0.0, 0.0],
        [20.0, 0.0, 0.0],
        [20.0, 20.0, 0.0],
        [0.0, 20.0, 0.0],
        [0.0, 0.0, 20.0],
        [20.0, 0.0, 20.0],
        [20.0, 20.0, 20.0],
        [0.0, 20.0, 20.0],
    ];
    v[6] = corner;
    let faces = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    let mut b = vec![0u8; 80];
    b.extend_from_slice(&12u32.to_le_bytes());
    for f in faces {
        b.extend_from_slice(&[0u8; 12]);
        for i in f {
            for c in v[i] {
                b.extend_from_slice(&c.to_le_bytes());
            }
        }
        b.extend_from_slice(&[0, 0]);
    }
    b
}

#[test]
fn geometry_past_the_engines_range_is_refused_not_sliced() {
    // A part placed 300 m out overflowed the scaled outlines and crashed the slice.
    let far = blocked_or_error(run(&request(base_config(), json!({}), [3.0e5, 100.0, 0.0])));
    assert!(far.contains("units"), "{far}");
    // A vertex that is not a number sliced into toolpaths in the wrong place.
    for corner in [
        [f32::NAN, 20.0, 20.0],
        [f32::INFINITY, 20.0, 20.0],
        [1.0e30, 20.0, 20.0],
    ] {
        let m = Arc::new(Mesh::load(&cube_stl(corner), "cube.stl").unwrap());
        let req = request(base_config(), json!({}), [100.0, 100.0, 0.0]);
        let e = blocked_or_error(common::run_request(&req, &move |_: &str| Ok(m.clone())));
        assert!(e.contains("cube.stl"), "{corner:?}: {e}");
    }
}

fn blocked_or_error(r: api::Result<SliceRun>) -> String {
    match r {
        Err(e) => e.to_string(),
        Ok(_) => panic!("expected an error, the file was written"),
    }
}

#[test]
fn a_model_too_thin_for_one_layer_is_an_empty_plate() {
    // 20 um tall: no layer's cutting plane meets it. It wrote a file that only heated and homed the printer.
    let m = Arc::new(Mesh::load(&cube_stl([20.0, 20.0, 20.0]), "cube.stl").unwrap());
    let mut req = request(base_config(), json!({}), [0.0; 3]);
    req.plate.objects[0].transform = Some(vec![
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.001, 0.0, 100.0, 100.0, 0.0, 1.0,
    ]);
    let e = blocked_or_error(common::run_request(&req, &move |_: &str| Ok(m.clone())));
    assert!(e.contains("no printable geometry"), "{e}");
}
