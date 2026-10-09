// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Request options end to end on the reference model: sleipnir layer tops,
//! resume from a layer, height ranges and per-object settings. Each case runs
//! through `run_request`, the same path the CLI, FFI and WASM use, and its
//! G-code goes through the validator.

// Options are built with `json!` at each call, so taking them by value reads best.
#![allow(clippy::needless_pass_by_value, clippy::many_single_char_names)]
// Test inputs are small counts and exact expected floats.
#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::float_cmp
)]
// Checks measure the output with the standard math functions; the engine's own rounding rule (clippy.toml) is for G-code.
#![allow(clippy::disallowed_methods)]

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{self, Mesh, SliceRequest, SliceRun};
use sx_core::validate::validate_gcode;

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
    let mut config = bench["config"].clone();
    // The tests read exact speeds; the slowdown has its own test.
    config["slow_down_for_layer_cooling"] = json!(false);
    config
}

fn request(options: Value, object: Value) -> SliceRequest {
    let mut o = json!({"mesh": "x"});
    if let (Some(m), Some(extra)) = (o.as_object_mut(), object.as_object()) {
        m.extend(extra.clone());
    }
    serde_json::from_value(json!({
        "plate": {"objects": [o]},
        "config": base_config(),
        "options": options,
    }))
    .unwrap()
}

fn run(req: &SliceRequest) -> api::Result<SliceRun> {
    let m = mesh();
    common::run_request(req, &move |_: &str| Ok(m.clone()))
}

fn text(run: &SliceRun) -> String {
    String::from_utf8(run.gcode.clone()).unwrap()
}

/// The moves and settings without the progress lines and the statistics footer, which
/// describe the whole file and so differ between a full print and a resume.
fn without_totals(g: &str) -> String {
    let body = g.split("; filament used [mm]").next().unwrap_or(g);
    body.lines()
        .filter(|l| !l.starts_with("M73 "))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn assert_valid(run: &SliceRun) {
    let c = api::PrintConfig::from_value(&common::with_base(&base_config())).unwrap();
    let r = validate_gcode(
        &run.gcode,
        c.bed_rect(),
        c.printable_height,
        sx_core::validate::deepest_retraction(&c) + 0.001,
    );
    assert!(r.ok(), "validator: {:?}", r.errors);
}

/// Byte offset of the `;LAYER_CHANGE` that starts layer `n` (0-based).
fn layer_start(g: &str, n: usize) -> usize {
    g.match_indices(sx_core::extras::layer_mark(g))
        .nth(n)
        .map(|(i, _)| i)
        .unwrap()
}

#[test]
fn resume_writes_only_the_remaining_layers() {
    let full = run(&request(json!({}), json!({}))).unwrap();
    let n = full.report.layer_count as usize;
    let full_text = text(&full);
    for shards in [1, 4, 11] {
        let resumed = run(&request(
            json!({"resumeFromLayer": 100, "shards": shards}),
            json!({}),
        ))
        .unwrap();
        assert_valid(&resumed);
        let g = text(&resumed);
        // Same walls and infill as the full run, from layer 100 on.
        let (tail, want) = (
            without_totals(&g),
            without_totals(&full_text[layer_start(&full_text, 100)..]),
        );
        assert!(tail.ends_with(&want), "tail differs with {shards} shards");
        let head = &g[..layer_start(&g, 0)];
        assert!(head.contains("G28 X Y\n"), "{head}");
        assert!(!head.lines().any(|l| l.trim() == "G28"), "homes Z");
        assert!(head.contains("M104 S") && head.contains("M109 S") && head.contains("M190 S"));
        assert!(
            !head.contains("G1 E") && !head.contains("prime"),
            "purge in the start: {head}"
        );
        assert_eq!(g.matches(sx_core::extras::layer_mark(&g)).count(), n - 100);
        // The report still lists every layer, and the preview keeps them all.
        assert_eq!(resumed.report.layer_count as usize, n);
        assert_eq!(resumed.report.layer_z.len(), n);
        assert_eq!(resumed.report.layer_time_s.len(), n);
        assert!(resumed.report.preview_bytes > 0);
        assert!(resumed.report.stats.filament_mm[0] < full.report.stats.filament_mm[0]);
        assert!(resumed.report.stats.time_s < full.report.stats.time_s);
    }
    // Layer 0 is the whole print.
    let zero = run(&request(json!({"resumeFromLayer": 0}), json!({}))).unwrap();
    assert_eq!(zero.gcode, full.gcode);
    assert!(run(&request(json!({"resumeFromLayer": n}), json!({}))).is_err());
}

#[test]
fn resume_with_smart_layer_tops() {
    let mut tops = vec![0.2];
    while tops.last().copied().unwrap() < 100.0 {
        let last = tops.last().copied().unwrap();
        tops.push(last + if tops.len() % 2 == 0 { 0.12 } else { 0.28 });
    }
    let full = run(&request(json!({"layerTopsMm": tops}), json!({}))).unwrap();
    let resumed = run(&request(
        json!({"layerTopsMm": tops, "resumeFromLayer": 60, "shards": 3}),
        json!({}),
    ))
    .unwrap();
    assert_valid(&resumed);
    let (f, g) = (text(&full), text(&resumed));
    assert!(without_totals(&g).ends_with(&without_totals(&f[layer_start(&f, 60)..])));
}

#[test]
fn height_ranges_change_temperature_flow_speed_and_pressure_advance() {
    let opts = json!({
        "flavor": "klipper",
        "heightRanges": [
            {"zFromMm": 0.0, "zToMm": 20.0, "settings": {"nozzle_temperature": 230}},
            {"zFromMm": 20.0, "zToMm": 40.0, "settings": {"nozzle_temperature": 210, "filament_flow_ratio": 1.2}},
            {"zFromMm": 40.0, "zToMm": 60.0, "settings": {"outer_wall_speed": 77, "enable_pressure_advance": true, "pressure_advance": 0.04}},
        ],
    });
    let plain = run(&request(json!({"flavor": "klipper"}), json!({}))).unwrap();
    let r = run(&request(opts.clone(), json!({}))).unwrap();
    assert_valid(&r);
    let g = text(&r);
    // 230 from the start, 210 when the second range begins, the base value after the third.
    let base_t = api::PrintConfig::from_value(&common::with_base(&base_config()))
        .unwrap()
        .nozzle_temperature[0]
        .round();
    let temps: Vec<&str> = g.lines().filter(|l| l.starts_with("M104 S")).collect();
    assert_eq!(temps[0], "M104 S230", "{temps:?}");
    assert!(temps.contains(&"M104 S210"));
    assert!(temps.contains(&format!("M104 S{base_t}").as_str()));
    // Pressure advance is set when its range starts and cleared when it ends.
    assert!(g.contains("SET_PRESSURE_ADVANCE ADVANCE=0.04\n"));
    assert!(g.contains("SET_PRESSURE_ADVANCE ADVANCE=0\n"));
    assert!(!plain.gcode.windows(20).any(|w| w == b"SET_PRESSURE_ADVANCE"));
    // Outer walls slow to 77 mm/s in the third range only.
    assert!(g.contains("G1 F4620\n"));
    assert!(!text(&plain).contains("G1 F4620\n"));
    // Higher flow in the second range uses more filament than the plain run.
    assert!(r.report.stats.filament_mm[0] > plain.report.stats.filament_mm[0]);
    // Shards write the same bytes.
    let mut o = opts;
    o["shards"] = json!(7);
    assert_eq!(run(&request(o, json!({}))).unwrap().gcode, r.gcode);
}

#[test]
fn height_ranges_reject_geometry_keys_and_flag_unknown_ones() {
    let bad =
        json!({"heightRanges": [{"zFromMm": 0, "zToMm": 5, "settings": {"sparse_infill_density": 50}}]});
    assert!(run(&request(bad, json!({}))).is_err());
    let backwards = json!({"heightRanges": [{"zFromMm": 5, "zToMm": 5, "settings": {"wall_loops": 3}}]});
    assert!(run(&request(backwards, json!({}))).is_err());
    let unknown =
        json!({"heightRanges": [{"zFromMm": 0, "zToMm": 5, "settings": {"fuzzy_skin": "external"}}]});
    let r = run(&request(unknown, json!({}))).unwrap();
    assert!(r.report.warnings.iter().any(|w| w.message.contains("fuzzy_skin")));
}

#[test]
fn object_settings_apply_to_the_plate() {
    let plain = run(&request(json!({}), json!({}))).unwrap();
    let three = run(&request(json!({}), json!({"settings": {"wall_loops": 4}}))).unwrap();
    assert_valid(&three);
    assert_ne!(three.gcode, plain.gcode);
    let by_config = {
        let mut cfg = base_config();
        cfg["wall_loops"] = json!(4);
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "x"}]}, "config": cfg})).unwrap();
        run(&req).unwrap()
    };
    assert_eq!(three.gcode, by_config.gcode);
    let unknown = run(&request(json!({}), json!({"settings": {"spiral_mode": true}}))).unwrap();
    assert!(
        unknown
            .report
            .warnings
            .iter()
            .any(|w| w.message.contains("spiral_mode"))
    );
}

/// A square frustum, `bottom` mm wide at z = 0 and `top` mm wide at `height`.
fn frustum(bottom: f32, top: f32, height: f32) -> Mesh {
    let corner = |half: f32, z: f32, k: usize| {
        let (sx, sy) = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)][k];
        [half * sx, half * sy, z]
    };
    let mut positions = Vec::new();
    for k in 0..4 {
        positions.push(corner(bottom / 2.0, 0.0, k));
    }
    for k in 0..4 {
        positions.push(corner(top / 2.0, height, k));
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    Mesh {
        name: "frustum".into(),
        parts: vec![api::MeshPart {
            name: "frustum".into(),
            slot: 1,
            color: None,
            positions,
            triangles,
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
        }],
    }
}

fn frustum_run(top: f32, config: Value) -> SliceRun {
    let mesh = Arc::new(frustum(10.0, top, 10.0));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "f"}]},
        "config": config,
    }))
    .unwrap();
    common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap()
}

#[test]
fn overhanging_walls_are_labeled_and_slowed_by_degree() {
    let speeds = json!({"overhang_1_4_speed": 40, "overhang_2_4_speed": 30, "overhang_3_4_speed": 20, "overhang_4_4_speed": 10});
    // A flare of 0.15, 0.25 and 0.33 mm a layer hangs 36, 60 and 79 percent of the 0.42 mm line. The speed
    // is interpolated between the overlap levels as Orca does (90, 75, 50, 25 and 13 percent resting on the
    // layer below): 36, 26 and 17 mm/s.
    for (top, speed) in [(25.0, 36), (35.0, 26), (43.0, 17)] {
        let feeds: Vec<String> = (speed - 1..=speed + 1)
            .map(|v| format!("G1 F{}\n", v * 60))
            .collect();
        let plain = frustum_run(top, json!({}));
        assert_valid(&plain);
        let g = text(&plain);
        // Slowed pieces keep their wall label: only a bead hanging completely free is an overhang wall.
        assert!(!g.contains(";TYPE:Overhang wall"), "flare to {top} mm");
        let slowed = frustum_run(top, speeds.clone());
        assert_valid(&slowed);
        let sg = text(&slowed);
        assert!(
            feeds.iter().any(|f| sg.contains(f.as_str())),
            "missing about {speed} mm/s for {top}"
        );
        // The same toolpaths and filament, only slowed.
        let (a, b) = (
            plain.report.stats.filament_mm[0],
            slowed.report.stats.filament_mm[0],
        );
        assert!((a - b).abs() < 1e-3 * a, "{a} vs {b}");
        assert!(slowed.report.stats.time_s > plain.report.stats.time_s);
        // Turning the speed setting off keeps the labels and the wall speed.
        let mut off = speeds.clone();
        off["enable_overhang_speed"] = json!(false);
        let og = text(&frustum_run(top, off));
        assert!(
            !feeds.iter().any(|f| og.contains(f.as_str())),
            "slowed with the setting off at {top}"
        );
    }
}

#[test]
fn only_completely_free_walls_are_labeled_overhang() {
    // OrcaSlicer labels a wall an overhang when its bead hangs more than half a line width past
    // the layer below with nothing under it: a step of one line width (0.42 mm) a layer.
    // Measured: 0.4 mm a layer is not labeled, 0.5 mm is.
    for (top, labeled) in [(30.0, false), (50.0, false), (60.0, true), (80.0, true)] {
        let g = text(&frustum_run(top, json!({})));
        assert_eq!(g.contains(";TYPE:Overhang wall"), labeled, "flare to {top} mm");
    }
}

#[test]
fn straight_walls_have_no_overhang_pieces() {
    let mesh = Arc::new(frustum(20.0, 20.0, 10.0));
    let req: SliceRequest =
        serde_json::from_value(json!({"plate": {"objects": [{"mesh": "f"}]}, "config": {}})).unwrap();
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert!(!text(&run).contains("Overhang wall"));
}

/// The path (mm) and filament (mm) of the moves under each `;TYPE:` label of `g`.
fn by_feature(g: &str) -> std::collections::HashMap<String, (f64, f64)> {
    let mut out: std::collections::HashMap<String, (f64, f64)> = std::collections::HashMap::new();
    let (mut kind, mut relative) = (String::new(), false);
    let (mut x, mut y, mut e) = (0.0, 0.0, 0.0);
    // A chunk of a file starts where the nozzle is not known yet: its first move only places it.
    let mut placed = false;
    for l in g.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            kind = t.to_owned();
            continue;
        }
        let code = l.split(';').next().unwrap_or("");
        match code.split_whitespace().next() {
            Some("M83") => relative = true,
            Some("M82") => relative = false,
            Some("G92") => e = field(code, 'E').unwrap_or(e),
            Some("G0" | "G1") => {
                let (nx, ny) = (field(code, 'X').unwrap_or(x), field(code, 'Y').unwrap_or(y));
                if let Some(v) = field(code, 'E') {
                    let d = if relative { v } else { v - e };
                    e = if relative { e } else { v };
                    if placed && d > 0.0 && (nx != x || ny != y) {
                        let f = out.entry(kind.clone()).or_default();
                        f.0 += (nx - x).hypot(ny - y);
                        f.1 += d;
                    }
                }
                placed |= field(code, 'X').is_some() && field(code, 'Y').is_some();
                (x, y) = (nx, ny);
            }
            _ => {}
        }
    }
    out
}

#[test]
fn two_parts_meeting_on_a_layer_plane_cut_as_the_lower_one() {
    // A 20 mm box up to z 5.5 under a 30 mm box: z 5.5 is the cutting plane of layer 27. Orca's slicer counts
    // a point on the plane as above it, so that layer is the top of the lower box, and the upper box starts
    // on layer 28 with its walls over air (Orca 2.4.2: 78.3 mm of outer wall round the lower box on layer 27,
    // 233.2 mm of overhang wall on layer 28). Two parts of a 3MF meeting on a band boundary hit this.
    let mesh = Arc::new(Mesh {
        name: "stacked".into(),
        parts: vec![
            cuboid([5.0, 25.0], [5.0, 25.0], [0.0, 5.5], "lower"),
            cuboid([0.0, 30.0], [0.0, 30.0], [5.5, 10.0], "upper"),
        ],
    });
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "s", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": {"layer_height": 0.2, "initial_layer_print_height": 0.2, "brim_type": "no_brim"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&r);
    let g = text(&r);
    let layers: Vec<&str> = g.split(sx_core::extras::layer_mark(&g)).skip(1).collect();
    let span = |l: &str, label: &str| {
        let f = by_feature(l);
        f.get(label).map_or(0.0, |v| v.0)
    };
    // Layer 27: the lower box's walls, nothing over air.
    assert!(span(layers[27], "Overhang wall") < 1e-6);
    let outer = span(layers[27], "Outer wall");
    assert!((outer - 78.3).abs() < 2.0, "{outer} mm of outer wall on layer 27");
    // Layer 28: the upper box's outer and inner walls hang.
    let over = span(layers[28], "Overhang wall");
    assert!(
        (over - 233.2).abs() < 5.0,
        "{over} mm of overhang wall on layer 28"
    );
}

fn cuboid(x: [f32; 2], y: [f32; 2], z: [f32; 2], name: &str) -> api::MeshPart {
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
    api::MeshPart {
        name: name.into(),
        slot: 1,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint: Vec::new(),
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
    }
}

/// A slab resting on two pillars 24 mm apart.
fn table() -> Mesh {
    Mesh {
        name: "table".into(),
        parts: vec![
            cuboid([0.0, 8.0], [0.0, 20.0], [0.0, 10.0], "left"),
            cuboid([32.0, 40.0], [0.0, 20.0], [0.0, 10.0], "right"),
            cuboid([0.0, 40.0], [0.0, 20.0], [10.0, 12.0], "slab"),
        ],
    }
}

/// The Bridge feature of the first bridging layer of the table: the number of extruding moves and the
/// extrusion of the strands, mm of filament.
fn table_bridge(config: Value) -> (usize, f64) {
    let mesh = Arc::new(table());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": config,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&r);
    let g = text(&r);
    let layer = g.split(sx_core::extras::layer_mark(&g)).nth(51).unwrap();
    let bridge = layer
        .split(";TYPE:Bridge")
        .nth(1)
        .unwrap()
        .split(";TYPE:")
        .next()
        .unwrap();
    let moves = bridge
        .lines()
        .filter(|l| l.starts_with("G1 X") && l.contains('E'))
        .count();
    let e: f64 = bridge
        .lines()
        .filter(|l| l.starts_with("G1 X"))
        .filter_map(|l| field(l, 'E'))
        .filter(|e| *e > 0.0)
        .sum();
    (moves, e)
}

/// The filament of the `Internal bridge` feature and its extruding moves, for a 20 mm cube at 15 percent infill.
fn internal_bridge(config: Value) -> (f64, usize) {
    let cube = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 10.0]));
    let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "sparse_infill_density": 15});
    cfg.as_object_mut()
        .unwrap()
        .extend(config.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": cfg,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(cube.clone())).unwrap();
    assert_valid(&r);
    let g = text(&r);
    let (mut on, mut e, mut moves) = (false, 0.0, 0);
    for line in g.lines() {
        if let Some(t) = line.strip_prefix(";TYPE:") {
            on = t == "Internal Bridge";
        } else if on
            && line.starts_with("G1 X")
            && let Some(v) = field(line, 'E')
        {
            e += v.max(0.0);
            moves += 1;
        }
    }
    (e, moves)
}

#[test]
fn internal_bridge_flow_and_density_shape_the_bridge_over_sparse_infill() {
    let (base_e, base_moves) = internal_bridge(json!({}));
    assert!(base_moves > 10, "no internal bridge: {base_moves}");
    let (flow_e, flow_moves) = internal_bridge(json!({"internal_bridge_flow": 1.5}));
    assert_eq!(flow_moves, base_moves);
    assert!((flow_e / base_e - 1.5).abs() < 0.02, "{flow_e} {base_e}");
    let (_, sparse_moves) = internal_bridge(json!({"internal_bridge_density": 50}));
    assert!(sparse_moves * 10 < base_moves * 7, "{sparse_moves} {base_moves}");
}

#[test]
fn infill_first_prints_the_walls_after_the_infill_above_the_first_layer() {
    let order = |config: Value, layer: usize| -> Vec<String> {
        let cube = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 6.0]));
        let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "sparse_infill_density": 15});
        cfg.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let r = common::run_request(&req, &move |_: &str| Ok(cube.clone())).unwrap();
        assert_valid(&r);
        let g = text(&r);
        let l = g
            .split(sx_core::extras::layer_mark(&g))
            .nth(layer + 1)
            .unwrap()
            .to_string();
        let mut kinds: Vec<String> = l
            .lines()
            .filter_map(|x| x.strip_prefix(";TYPE:"))
            .map(String::from)
            .collect();
        kinds.dedup();
        kinds
    };
    let walls_first = order(json!({}), 3);
    assert!(
        walls_first.first().is_some_and(|k| k.contains("wall")),
        "{walls_first:?}"
    );
    let infill_first = order(json!({"is_infill_first": true}), 3);
    assert!(
        infill_first.last().is_some_and(|k| k.contains("wall")),
        "{infill_first:?}"
    );
    // The first layer keeps its walls first.
    assert!(
        order(json!({"is_infill_first": true}), 0)
            .first()
            .is_some_and(|k| k.contains("wall"))
    );
}

#[test]
fn elephant_foot_layers_density_thins_the_solid_infill_just_above_the_bottom() {
    let moves = |config: Value, layer: usize| -> usize {
        let cube = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 6.0]));
        let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "bottom_shell_layers": 4});
        cfg.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let r = common::run_request(&req, &move |_: &str| Ok(cube.clone())).unwrap();
        feature_moves_per_layer(&text(&r), "Internal solid infill")
            .get(layer)
            .copied()
            .unwrap_or(0)
    };
    let plain = moves(json!({}), 1);
    assert!(plain > 10, "{plain}");
    let thin = moves(
        json!({"elefant_foot_layers_density": "50%", "elefant_foot_compensation_layers": 3}),
        1,
    );
    assert!(thin * 10 < plain * 8, "{thin} {plain}");
    // Density rises with each layer, and the layer past the last compensated one is unchanged.
    let cfg = json!({"elefant_foot_layers_density": "50%", "elefant_foot_compensation_layers": 3});
    assert!(moves(cfg.clone(), 1) < moves(cfg.clone(), 2) && moves(cfg.clone(), 2) < moves(cfg.clone(), 3));
    assert_eq!(moves(cfg, 4), moves(json!({}), 4));
}

#[test]
fn make_overhang_printable_fills_a_cone_under_the_overhang() {
    let mesh = Arc::new(table());
    let run = |config: Value| {
        let mut cfg = json!({"brim_width": 0, "skirt_loops": 0});
        cfg.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        r
    };
    let plain = run(json!({}));
    let cone = run(json!({"make_overhang_printable": true}));
    let (a, b) = (
        plain.report.stats.filament_mm[0],
        cone.report.stats.filament_mm[0],
    );
    assert!(b > a * 1.08, "{a} {b}");
    // The gap under the slab is filled with a slope, so the slab no longer bridges it.
    assert!(text(&plain).contains(";TYPE:Bridge"));
    assert!(!text(&cone).contains(";TYPE:Bridge"));
    // 90 degrees allows any overhang, so nothing changes.
    let flat = run(json!({"make_overhang_printable": true, "make_overhang_printable_angle": 90}));
    assert!((flat.report.stats.filament_mm[0] - a).abs() < 1e-6);
}

/// A prism over the regular `sides`-gon of radius `r` around `(cx, cy)`, from `z0` to `z1`; `inward` winds it
/// as a cavity.
fn round_prism(cx: f32, cy: f32, r: f32, sides: u32, z: [f32; 2], inward: bool) -> api::MeshPart {
    let mut positions = Vec::new();
    for zi in z {
        for k in 0..sides {
            let a = std::f32::consts::TAU * k as f32 / sides as f32;
            positions.push([cx + r * a.cos(), cy + r * a.sin(), zi]);
        }
    }
    let mut triangles = Vec::new();
    for k in 1..sides - 1 {
        triangles.push([0, k + 1, k]);
        triangles.push([sides, sides + k, sides + k + 1]);
    }
    for k in 0..sides {
        let n = (k + 1) % sides;
        triangles.push([k, n, sides + n]);
        triangles.push([k, sides + n, sides + k]);
    }
    if inward {
        for t in &mut triangles {
            t.swap(1, 2);
        }
    }
    api::MeshPart {
        name: "prism".into(),
        slot: 1,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint: Vec::new(),
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
    }
}

#[test]
fn hole_to_polyhole_turns_a_round_hole_into_a_polygon_sized_for_the_nozzle() {
    let mesh = Arc::new(Mesh {
        name: "holed".into(),
        parts: vec![
            cuboid([0.0, 30.0], [0.0, 30.0], [0.0, 6.0], "block"),
            round_prism(15.0, 15.0, 3.0, 48, [-1.0, 7.0], true),
        ],
    });
    let run = |config: Value| -> (usize, Vec<(f64, f64)>) {
        let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "seam_gap": 0});
        cfg.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "h", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        let g = text(&r);
        let layer = g
            .split(sx_core::extras::layer_mark(&g))
            .nth(4)
            .unwrap()
            .to_string();
        let mut pts = Vec::new();
        let mut on = false;
        for line in layer.lines() {
            if let Some(t) = line.strip_prefix(";TYPE:") {
                on = t == "Outer wall";
            } else if on && line.starts_with("G1 X") && line.contains('E') {
                let (x, y) = (field(line, 'X').unwrap(), field(line, 'Y').unwrap());
                // Only the hole's loop: within 6 mm of its center (115, 115).
                if (x - 115.0).hypot(y - 115.0) < 6.0 {
                    pts.push((x, y));
                }
            }
        }
        (pts.len(), pts)
    };
    let (plain, _) = run(json!({}));
    let (poly, pts) = run(json!({"hole_to_polyhole": true, "hole_to_polyhole_twisted": false}));
    // A 3 mm radius at a 0.4 mm nozzle is a 12 sided polygon; the sliced hole has dozens of points.
    assert!(plain > 30, "{plain}");
    assert!((11..=13).contains(&poly), "{poly}");
    // The polygon's corners sit a little outside the circle (its edges touch it).
    let r = pts
        .iter()
        .map(|p| (p.0 - 115.0).hypot(p.1 - 115.0))
        .fold(0.0_f64, f64::max);
    assert!(r > 3.0 && r < 3.6, "{r}");
    // Twisted, the polygon turns from layer to layer.
    let (_, a) = run(json!({"hole_to_polyhole": true}));
    assert_ne!(a, pts);
}

#[test]
fn bridge_density_and_line_width_set_the_strands_of_a_bridge() {
    let (base_moves, base_e) = table_bridge(json!({}));
    // Half the density: strands twice as far apart, so about half as many.
    let (sparse_moves, sparse_e) = table_bridge(json!({"bridge_density": 50}));
    assert!(
        sparse_moves * 10 < base_moves * 7 && sparse_e < base_e * 0.7,
        "{sparse_moves} {base_moves} {sparse_e} {base_e}"
    );
    // A narrower strand sits closer. Round strands (thick bridges) carry less filament per mm, so the
    // layer takes less; flat beads keep the same filament per area.
    let (narrow_moves, _) = table_bridge(json!({"bridge_line_width": 0.3}));
    assert!(
        narrow_moves > base_moves,
        "narrower strands sit closer: {narrow_moves} {base_moves}"
    );
    let (_, thick_e) = table_bridge(json!({"thick_bridges": true}));
    let (_, thick_narrow_e) = table_bridge(json!({"thick_bridges": true, "bridge_line_width": 0.3}));
    assert!(thick_narrow_e < thick_e, "{thick_narrow_e} {thick_e}");
}

#[test]
fn the_first_layers_over_air_are_bridges() {
    let mesh = Arc::new(table());
    let run = |config: Value| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": config,
        }))
        .unwrap();
        let m = mesh.clone();
        common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
    };
    // Thick bridges: round strands of the nozzle diameter (Orca's default is flat beads, off).
    let r = run(json!({"thick_bridges": true}));
    assert_valid(&r);
    let g = text(&r);
    assert!(g.contains(";TYPE:Bridge"), "no bridge over the gap");
    // Bridge strands at 50 mm/s, along x from pillar to pillar.
    let layer = g.split(sx_core::extras::layer_mark(&g)).nth(51).unwrap();
    let bridge = layer
        .split(";TYPE:Bridge")
        .nth(1)
        .unwrap()
        .split(";TYPE:")
        .next()
        .unwrap();
    assert!(bridge.contains("G1 F3000\n"));
    let mut prev: Option<(f64, f64)> = None;
    let mut long = 0;
    for l in bridge
        .lines()
        .filter(|l| l.starts_with("G1 X") || l.starts_with("G0 X"))
    {
        let f = |k: char| {
            l.split_whitespace()
                .find_map(|w| w.strip_prefix(k))
                .and_then(|v| v.parse::<f64>().ok())
        };
        let (x, y) = (f('X').unwrap(), f('Y').unwrap());
        if l.starts_with("G0") {
            prev = Some((x, y));
            continue;
        }
        let e = f('E').unwrap();
        if let Some((px, py)) = prev
            && (x - px).abs() > 20.0
        {
            long += 1;
            assert!((y - py).abs() < 0.01, "strand is not along x: {l}");
            // A round 0.4 mm strand: pi * 0.2^2 / (pi * 0.875^2) mm of filament per mm.
            let want = (x - px).abs() * (0.2f64 / 0.875).powi(2);
            assert!((e - want).abs() / want < 0.03, "E {e} vs {want}");
        }
        prev = Some((x, y));
    }
    assert!(long > 20, "{long} long strands");
    // The bridge replaces solid infill in that area, so a second run with bridge flow 0.85 uses less filament.
    let thin = run(json!({"thick_bridges": true, "bridge_flow": 0.85, "bridge_speed": 30}));
    assert!(thin.report.stats.filament_mm[0] < r.report.stats.filament_mm[0]);
    assert!(text(&thin).contains("G1 F1800\n"));
}

#[test]
fn a_shelf_narrower_than_a_line_and_a_half_is_not_bridged() {
    // A 20 mm block with a 0.5 mm flare on each side: the overhang is too thin to hang strands across.
    let mesh = Arc::new(Mesh {
        name: "shelf".into(),
        parts: vec![
            cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 5.0], "base"),
            cuboid([-0.5, 20.5], [-0.5, 20.5], [5.0, 8.0], "cap"),
        ],
    });
    let req: SliceRequest =
        serde_json::from_value(json!({"plate": {"objects": [{"mesh": "s"}]}, "config": {}})).unwrap();
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&run);
    assert!(!text(&run).contains(";TYPE:Bridge"));
}

/// Where the first wall (the inner one) starts on each layer of a 20 mm square, from the travel that leads to it.
fn seam_starts(seam: &str) -> Vec<(f64, f64)> {
    let mesh = Arc::new(Mesh {
        name: "block".into(),
        parts: vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 4.0], "block")],
    });
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "b", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": {"seam_position": seam, "brim_width": 0},
    }))
    .unwrap();
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&run);
    let g = text(&run);
    g.split(sx_core::extras::layer_mark(&g))
        .skip(1)
        .map(|layer| {
            let before = layer.split(";TYPE:Inner wall").next().unwrap();
            let go = before.lines().rev().find(|l| l.starts_with("G0 X")).unwrap();
            let f = |k: char| {
                go.split_whitespace()
                    .find_map(|w| w.strip_prefix(k))
                    .unwrap()
                    .parse::<f64>()
                    .unwrap()
            };
            (f('X'), f('Y'))
        })
        .collect()
}

#[test]
fn seam_position_places_the_wall_start() {
    // The inner wall of the square runs from 100.63 to 119.37 on both axes.
    let near = |p: (f64, f64), x: f64, y: f64| (p.0 - x).abs() < 0.02 && (p.1 - y).abs() < 0.02;
    for p in seam_starts("back") {
        // Equal rear corners: the first of the counterclockwise ring from its lowest left vertex, the right one.
        assert!(near(p, 119.37, 119.37), "back starts at {p:?}");
    }
    for p in seam_starts("nearest") {
        assert!(near(p, 100.63, 100.63), "nearest starts at {p:?}");
    }
    // A square has only convex corners, so the choice is a corner, the same on every layer.
    let aligned = seam_starts("aligned");
    let corner = |p: &(f64, f64)| {
        [100.63, 119.37].iter().any(|x| (p.0 - x).abs() < 0.02)
            && [100.63, 119.37].iter().any(|y| (p.1 - y).abs() < 0.02)
    };
    assert!(aligned.iter().all(corner), "{aligned:?}");
    assert!(
        aligned.windows(2).all(|w| near(w[1], w[0].0, w[0].1)),
        "aligned seam moves: {aligned:?}"
    );
    for p in seam_starts("aligned_back") {
        assert!(
            near(p, 100.63, 119.37) || near(p, 119.37, 119.37),
            "aligned_back starts at {p:?}"
        );
    }
    // Random is repeatable and moves between layers.
    let random = seam_starts("random");
    assert_eq!(random, seam_starts("random"));
    assert!(
        random.windows(2).any(|w| !near(w[1], w[0].0, w[0].1)),
        "{random:?}"
    );
}

#[test]
fn resume_z_declares_the_height_only_when_asked() {
    let plain = run(&request(json!({"resumeFromLayer": 100}), json!({}))).unwrap();
    assert!(!text(&plain).contains("G92 Z"));
    let asked = run(&request(
        json!({"resumeFromLayer": 100, "resumeZ": {"mode": "declare", "zMm": 20.2}}),
        json!({}),
    ))
    .unwrap();
    assert_valid(&asked);
    let g = text(&asked);
    let head = &g[..layer_start(&g, 0)];
    let (home, declare) = (head.find("G28 X Y").unwrap(), head.find("G92 Z20.200\n").unwrap());
    // The declared height is set first, then the nozzle lifts, then X and Y are homed.
    // (A progress line may follow the lift's move.)
    let lift = head.find("G91\nG1 Z5.0 F600\n").unwrap();
    assert!(declare < lift && lift < home && head.contains("; Z is declared"));
    assert!(
        asked
            .report
            .warnings
            .iter()
            .any(|w| w.code == api::WarningCode::ManualStep)
    );
    for bad in [
        json!({"resumeFromLayer": 100, "resumeZ": {"mode": "keep", "zMm": 5}}),
        json!({"resumeZ": {"mode": "declare", "zMm": 5}}),
        json!({"resumeFromLayer": 100, "resumeZ": {"mode": "declare", "zMm": -1}}),
    ] {
        assert!(run(&request(bad, json!({}))).is_err());
    }
}

#[test]
fn every_sparse_pattern_prints_valid_gcode_at_about_the_same_density() {
    let mesh = Arc::new(Mesh {
        name: "block".into(),
        parts: vec![cuboid([0.0, 40.0], [0.0, 40.0], [0.0, 20.0], "block")],
    });
    let run = |pattern: &str, shards: u32| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "b"}]},
            "config": {"sparse_infill_pattern": pattern, "sparse_infill_density": "20%", "brim_width": 0},
            "options": {"shards": shards},
        }))
        .unwrap();
        let m = mesh.clone();
        common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
    };
    let base = run("rectilinear", 1).report.stats.filament_mm[0];
    for name in [
        "line",
        "grid",
        "triangles",
        "tri-hexagon",
        "stars",
        "cubic",
        "adaptivecubic",
        "crosshatch",
        "honeycomb",
        "3dhoneycomb",
        "gyroid",
        "concentric",
    ] {
        let r = run(name, 1);
        assert_valid(&r);
        assert!(text(&r).contains(";TYPE:Sparse infill"), "{name}");
        assert!(
            r.report
                .warnings
                .iter()
                .all(|w| w.code != api::WarningCode::UnsupportedSetting),
            "{name}"
        );
        let f = r.report.stats.filament_mm[0];
        assert!(
            (f - base).abs() / base < 0.2,
            "{name}: {f:.0} mm of filament vs {base:.0}"
        );
        assert_eq!(run(name, 5).gcode, r.gcode, "{name} differs with shards");
    }
}

/// The G-code split into `(layer z, feature, x)` for every printed X coordinate.
fn features_by_layer(g: &str) -> Vec<(f64, String, f64)> {
    let mut out = Vec::new();
    let (mut z, mut feature) = (0.0, String::new());
    for l in g.lines() {
        if let Some(v) = l.strip_prefix(";Z:") {
            z = v.parse().unwrap();
        } else if let Some(v) = l.strip_prefix(";TYPE:") {
            v.clone_into(&mut feature);
        } else if l.starts_with("G1 X")
            && l.contains(" E")
            && let Some(x) = l.split_whitespace().find_map(|w| w.strip_prefix('X'))
        {
            out.push((z, feature.clone(), x.parse().unwrap()));
        }
    }
    out
}

#[test]
fn supports_fill_the_gap_under_a_bridge_and_keep_clear_of_the_part() {
    let mesh = Arc::new(table());
    let run = |config: Value| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": config,
        }))
        .unwrap();
        let m = mesh.clone();
        common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
    };
    let off = run(json!({}));
    assert!(!text(&off).contains(";TYPE:Support"));
    // Snug supports hug the overhang; the default grid style is checked by its own test.
    let on = run(json!({"enable_support": true, "support_type": "normal(auto)", "support_style": "snug"}));
    assert_valid(&on);
    let g = text(&on);
    let moves = features_by_layer(&g);
    let support: Vec<_> = moves
        .iter()
        .filter(|m| m.1 == "Support" || m.1 == "Support interface")
        .collect();
    assert!(support.len() > 200, "{} support moves", support.len());
    // Between the pillars (108 to 132) minus the 0.35 mm gap, and never above the overhang minus the 0.2 mm gap.
    // The first layer is a pad wider than the support above it (as in OrcaSlicer).
    for (z, f, x) in support.iter().filter(|m| m.0 > 0.25) {
        assert!(*x >= 108.35 - 0.05 && *x <= 131.65 + 0.05, "{f} at x {x}");
        assert!(*z <= 9.8 + 1e-6, "{f} at z {z}");
    }
    assert!(
        moves.iter().any(|m| m.1 == "Support interface" && m.0 > 9.0),
        "no interface under the slab"
    );
    assert!(
        moves.iter().any(|m| m.1 == "Support" && m.0 < 1.0),
        "support starts on the bed"
    );
    // A wider XY gap keeps it further from the pillars.
    let wide =
        run(json!({"enable_support": true, "support_style": "snug", "support_object_xy_distance": 1.5}));
    let xs: Vec<f64> = features_by_layer(&text(&wide))
        .into_iter()
        .filter(|m| m.1.starts_with("Support") && m.0 > 0.25)
        .map(|m| m.2)
        .collect();
    assert!(xs.iter().all(|x| *x >= 109.5 - 0.05 && *x <= 130.5 + 0.05));
    assert!(on.report.stats.filament_mm[0] > off.report.stats.filament_mm[0]);
    // Support does not change with the shard count.
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "t"}]},
        "config": {"enable_support": true},
        "options": {"shards": 6},
    }))
    .unwrap();
    let sharded = common::run_request(&req, &{
        let m = mesh.clone();
        move |_: &str| Ok(m.clone())
    })
    .unwrap();
    let one = run(json!({"enable_support": true}));
    assert_valid(&sharded);
    assert!(
        sharded
            .report
            .warnings
            .iter()
            .all(|w| w.code != api::WarningCode::UnsupportedSetting)
    );
    assert!(one.report.warnings.is_empty());
}

#[test]
fn supports_rest_on_the_part_unless_told_to_reach_the_bed() {
    // A wide slab, a pillar on it and a cap that overhangs the slab from above.
    let mesh = Arc::new(Mesh {
        name: "mushroom".into(),
        parts: vec![
            cuboid([0.0, 40.0], [0.0, 20.0], [0.0, 3.0], "slab"),
            cuboid([15.0, 25.0], [0.0, 20.0], [3.0, 13.0], "pillar"),
            cuboid([0.0, 40.0], [0.0, 20.0], [13.0, 15.0], "cap"),
        ],
    });
    let run = |config: Value| {
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        features_by_layer(&text(&r))
            .into_iter()
            .filter(|m| m.1.starts_with("Support"))
            .collect::<Vec<_>>()
    };
    let free = run(json!({"enable_support": true, "support_style": "snug"}));
    assert!(
        free.iter().any(|m| m.0 > 3.0 && m.0 < 13.0),
        "support on the slab"
    );
    assert!(free.iter().all(|m| m.0 > 3.0), "support inside the slab");
    let plate_only =
        run(json!({"enable_support": true, "support_style": "snug", "support_on_build_plate_only": true}));
    assert!(
        plate_only.is_empty(),
        "{} moves under an overhang that only the slab can carry",
        plate_only.len()
    );
}

#[test]
fn fans_follow_layer_time_and_bridges() {
    let run = |config: Value| {
        let mut c = base_config();
        c.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "x"}]}, "config": c})).unwrap();
        let m = mesh();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        r
    };
    let g = text(&run(
        json!({"close_fan_the_first_x_layers": 3, "fan_min_speed": 40, "fan_max_speed": 90}),
    ));
    // orca's cooling buffer writes a layer's fan ahead of its layer change: the last one before the mark
    let parts: Vec<&str> = g.split(sx_core::extras::layer_mark(&g)).collect();
    let fans: Vec<i64> = parts[..parts.len() - 1]
        .iter()
        .map(|l| {
            l.lines()
                .filter_map(|x| x.strip_prefix("M106 S"))
                .next_back()
                .unwrap()
                .parse()
                .unwrap()
        })
        .collect();
    assert!(fans[..3].iter().all(|f| *f == 0), "closed on the first layers");
    assert!(
        fans[3..].iter().all(|f| (102..=230).contains(f)),
        "between 40 and 90 percent: {:?}",
        &fans[3..8]
    );
    assert!(
        fans[3..].iter().any(|f| *f > 102),
        "fast layers ramp above the minimum"
    );
    // Off means off with the overhang and bridge fan off too; on its own it still cools bridges, as in Orca.
    let off = text(&run(
        json!({"fan_min_speed": 0, "fan_max_speed": 0, "enable_overhang_bridge_fan": false}),
    ));
    assert!(
        off.lines()
            .filter(|l| l.starts_with("M106 S"))
            .all(|l| l == "M106 S0")
    );
}

#[test]
fn retract_lift_enforce_picks_the_surfaces_that_lift() {
    let run = |enforce: &str| {
        let mut c = base_config();
        c.as_object_mut().unwrap().extend(
            json!({"z_hop": [0.4], "z_hop_types": ["Normal Lift"], "retract_lift_enforce": [enforce], "retraction_minimum_travel": [0.5]})
                .as_object()
                .unwrap()
                .clone(),
        );
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "x"}]}, "config": c})).unwrap();
        let m = mesh();
        text(&common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap())
    };
    // The layers (by count from 1) on which the nozzle goes above the layer's height; the last one ends
    // with the end G-code, which lifts on its own.
    let lifting = |g: &str| -> Vec<usize> {
        let layers: Vec<&str> = g.split(sx_core::extras::layer_mark(g)).skip(1).collect();
        let n = layers.len();
        layers
            .into_iter()
            .take(n - 1)
            .enumerate()
            .filter(|(_, layer)| {
                let z = layer
                    .lines()
                    .find_map(|l| l.strip_prefix(";Z:"))
                    .and_then(|v| v.trim().parse::<f64>().ok())
                    .unwrap();
                layer
                    .lines()
                    .filter(|l| l.starts_with("G1 ") && !l.contains(" E"))
                    .filter_map(|l| field(l, 'Z'))
                    .any(|v| v > z + 0.2)
            })
            .map(|(i, _)| i + 1)
            .collect()
    };
    let all = lifting(&run("All Surfaces"));
    assert!(all.len() > 10, "{all:?}");
    // Bottom only: the first layer and no other.
    assert_eq!(lifting(&run("Bottom Only")), vec![1]);
    // Top only: fewer layers than all, only where top surfaces print.
    let top = lifting(&run("Top Only"));
    assert!(
        !top.is_empty() && top.len() < all.len() && !top.contains(&1),
        "{top:?}"
    );
}

#[test]
fn internal_bridges_support_interface_and_ironing_take_their_own_fan() {
    let run = |config: Value| {
        let mut c = base_config();
        c.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "x"}]}, "config": c})).unwrap();
        let m = mesh();
        text(&common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap())
    };
    // The fan each feature prints at: the last M106 before its first extrusion.
    let fan_of = |g: &str, feature: &str| -> Vec<i64> {
        let mut fan = -1;
        let mut current = String::new();
        let mut out = Vec::new();
        for l in g.lines() {
            if let Some(v) = l.strip_prefix("M106 S") {
                fan = v.parse().unwrap();
            } else if let Some(t) = l.strip_prefix(";TYPE:") {
                current = t.to_owned();
            } else if current == feature && l.starts_with("G1 X") && l.contains(" E") {
                out.push(fan);
                current.clear();
            }
        }
        out
    };
    // the fan kept on, so slow layers run at 60 percent too
    let base = json!({"fan_min_speed": 60, "fan_max_speed": 60, "reduce_fan_stop_start_freq": [true],
        "overhang_fan_speed": 100, "ironing_type": "top"});
    let mut set = base.clone();
    set.as_object_mut().unwrap().extend(
        json!({"internal_bridge_fan_speed": [40], "ironing_fan_speed": [20]})
            .as_object()
            .unwrap()
            .clone(),
    );
    let g = run(set);
    let bridges = fan_of(&g, "Internal Bridge");
    assert!(
        !bridges.is_empty() && bridges.iter().all(|f| *f == 102),
        "{bridges:?}"
    );
    let ironing = fan_of(&g, "Ironing");
    assert!(
        !ironing.is_empty() && ironing.iter().all(|f| *f == 51),
        "{ironing:?}"
    );
    // -1, the default: internal bridges follow the overhang fan, ironing the layer's fan.
    let g = run(base);
    assert!(fan_of(&g, "Internal Bridge").iter().all(|f| *f == 255));
    assert!(fan_of(&g, "Ironing").iter().all(|f| *f == 153));
}

#[test]
fn short_layers_slow_down_to_the_minimum_layer_time() {
    let run = |config: Value| {
        let mut c = base_config();
        c.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "x"}]}, "config": c})).unwrap();
        let m = mesh();
        common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
    };
    let fast = run(json!({"slow_down_for_layer_cooling": false}));
    let slow = run(
        json!({"slow_down_for_layer_cooling": true, "slow_down_layer_time": 6, "slow_down_min_speed": 20}),
    );
    assert_valid(&slow);
    // The layer times are the finished file's own, read with acceleration and the layer change moves, so the layers the
    // slowdown targets sit a little above the 6 s the engine aims for: "short" here is under 8 s.
    let short_s: f32 = 8.0;
    // No layer got much faster (a layer the slowdown does not touch can move by a few percent), and the short ones got slower.
    for (a, b) in fast.report.layer_time_s.iter().zip(&slow.report.layer_time_s) {
        assert!(*b >= *a * 0.9, "{a} vs {b}");
    }
    assert!(slow.report.stats.time_s > fast.report.stats.time_s);
    let short = fast.report.layer_time_s.iter().filter(|t| **t < short_s).count();
    let still = slow.report.layer_time_s.iter().filter(|t| **t < short_s).count();
    assert!(
        short > 50 && still * 2 < short,
        "{short} short layers, {still} left after the slowdown"
    );
    // The floor holds: a big minimum speed keeps the layers as they were.
    let floor = run(json!({"slow_down_layer_time": 6, "slow_down_min_speed": 2000}));
    assert_eq!(floor.report.layer_time_s.len(), fast.report.layer_time_s.len());
    assert!(floor.report.stats.time_s <= slow.report.stats.time_s);
}

#[test]
fn z_hop_wipe_and_restart_extra_shape_the_retraction() {
    let run = |config: Value| {
        let mut c = base_config();
        c.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "x"}]}, "config": c})).unwrap();
        let m = mesh();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    let plain = run(json!({}));
    assert!(!plain.contains("; WIPE") && !plain.contains(";WIPE_START"));
    let hop = run(json!({"z_hop": 0.4}));
    // A lift above the layer and a drop back, once per retracting travel.
    let lifts = hop.lines().filter(|l| l.starts_with("G1 Z")).count();
    assert!(lifts > plain.lines().filter(|l| l.starts_with("G1 Z")).count());
    let limited = run(json!({"z_hop": 0.4, "retract_lift_above": 30.0}));
    assert!(
        limited.lines().filter(|l| l.starts_with("G1 Z")).count()
            < hop.lines().filter(|l| l.starts_with("G1 Z")).count()
    );
    let wipe = run(json!({"wipe": true, "wipe_distance": 1.5}));
    assert!(wipe.contains(";WIPE_START") && wipe.contains(";WIPE_END"));
    // Each wipe retracts the full length: the share before it (Orca's `retract_before_wipe`, 100 percent by
    // default), what comes off along the wipe, and whatever is left after it.
    let e_of = |l: &str| -> Option<f64> {
        l.split_whitespace()
            .find_map(|w| w.strip_prefix('E'))
            .and_then(|v| v.parse::<f64>().ok())
    };
    let lines: Vec<&str> = wipe.lines().collect();
    let mut total = 0.0_f64;
    for (i, l) in lines.iter().enumerate() {
        if *l != ";WIPE_START" {
            continue;
        }
        // the progress line finalize may put after the retraction before the wipe
        let back = if lines
            .get(i.wrapping_sub(1))
            .is_some_and(|p| p.starts_with("M73 "))
        {
            2
        } else {
            1
        };
        let mut sum = -lines
            .get(i.wrapping_sub(back))
            .and_then(|p| e_of(p))
            .filter(|e| *e < 0.0)
            .unwrap_or(0.0);
        let mut j = i + 1;
        while lines.get(j).is_some_and(|m| *m != ";WIPE_END") {
            sum -= lines.get(j).and_then(|m| e_of(m)).unwrap_or(0.0);
            j += 1;
        }
        if let Some(after) = lines
            .get(j + 1)
            .filter(|m| m.starts_with("G1 E-"))
            .and_then(|m| e_of(m))
        {
            sum -= after;
        }
        assert!((sum - 0.8).abs() < 1e-4, "wipe retracted {sum}");
        total += 1.0;
    }
    assert!(total > 100.0);
    // the layer change retraction wipes along the layer below's last path (orca's change_layer retract)
    let heads: Vec<&str> = wipe
        .split(sx_core::extras::layer_mark(&wipe))
        .skip(2)
        .map(|l| &l[..l.find(";TYPE:").unwrap_or(l.len())])
        .collect();
    assert!(
        heads.len() > 50 && heads.iter().all(|h| h.contains(";WIPE_START\n")),
        "{:?}",
        heads.iter().find(|h| !h.contains(";WIPE_START"))
    );
    // and so does the closing retraction
    assert!(wipe[wipe.rfind("\n; end\n").unwrap()..].contains(";WIPE_START\n"));
    let extra = run(json!({"retract_restart_extra": 0.1, "deretraction_speed": 20}));
    assert!(extra.contains("G1 E0.9 F1200\n"));
    // First layer temperatures.
    let first = run(json!({"nozzle_temperature_initial_layer": [230], "hot_plate_temp_initial_layer": 65}));
    let head = &first[..first.find(sx_core::extras::layer_mark(&first)).unwrap()];
    assert!(head.contains("M104 S230\n") && head.contains("M140 S65\n") && head.contains("M190 S65\n"));
    let second = first.split(sx_core::extras::layer_mark(&first)).nth(2).unwrap();
    assert!(
        second.contains("M104 S220\n") && second.contains("M140 S55\n"),
        "{}",
        &second[..200]
    );
}

#[test]
fn line_widths_are_written_only_when_they_change() {
    // orca's _extrude: a width line only for a new width, carried across features and layers
    let run_ = run(&request(json!({}), json!({}))).unwrap();
    let g = String::from_utf8_lossy(&run_.gcode);
    let widths: Vec<&str> = g.lines().filter(|l| l.starts_with(";WIDTH:")).collect();
    assert!(widths.len() > 10);
    assert!(widths.windows(2).all(|w| w[0] != w[1]), "a width repeated");
}

#[test]
fn wall_order_first_layer_wall_and_shell_thickness() {
    let mesh = Arc::new(Mesh {
        name: "block".into(),
        parts: vec![cuboid([0.0, 30.0], [0.0, 30.0], [0.0, 10.0], "block")],
    });
    let run = |config: Value| {
        let mut c = json!({"wall_loops": 3, "brim_width": 0, "slow_down_for_layer_cooling": false});
        c.as_object_mut()
            .unwrap()
            .extend(config.as_object().unwrap().clone());
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "b"}]}, "config": c})).unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        (text(&r), r)
    };
    let walls = |g: &str, layer: usize| -> Vec<String> {
        g.split(sx_core::extras::layer_mark(g))
            .nth(layer + 1)
            .unwrap()
            .lines()
            .filter(|l| l.starts_with(";TYPE:") && l.contains("wall"))
            .map(|l| l[6..].to_owned())
            .collect()
    };
    let (g, _) = run(json!({}));
    // The label is written when the feature changes, so the two inner walls show as one.
    assert_eq!(walls(&g, 3), ["Inner wall", "Outer wall"]);
    let (g, _) = run(json!({"wall_sequence": "outer wall/inner wall"}));
    assert_eq!(walls(&g, 3), ["Outer wall", "Inner wall"]);
    let (g, r) = run(json!({"wall_sequence": "inner-outer-inner wall"}));
    assert_eq!(walls(&g, 3), ["Inner wall", "Outer wall", "Inner wall"]);
    assert_valid(&r);
    let (g, _) = run(json!({"only_one_wall_first_layer": true}));
    assert_eq!(walls(&g, 0), ["Outer wall"]);
    assert_eq!(walls(&g, 1), ["Inner wall", "Outer wall"]);
    // Minimum shell thickness: 1.2 mm on 0.2 mm layers is six layers, more than the default five top layers.
    let solid_layers = |g: &str| {
        g.split(sx_core::extras::layer_mark(g))
            .skip(1)
            .filter(|l| l.contains(";TYPE:Top surface") || l.contains(";TYPE:Internal solid infill"))
            .count()
    };
    let (plain, _) = run(json!({"top_shell_layers": 2, "bottom_shell_layers": 2}));
    let (thick, r) = run(
        json!({"top_shell_layers": 2, "bottom_shell_layers": 2, "top_shell_thickness": 1.2, "bottom_shell_thickness": 1.0}),
    );
    assert_valid(&r);
    assert!(
        solid_layers(&thick) >= solid_layers(&plain) + 4,
        "{} vs {}",
        solid_layers(&thick),
        solid_layers(&plain)
    );
}

#[test]
fn thin_walls_get_a_gap_fill_bead_as_wide_as_the_gap() {
    let run = |mm: f32| {
        let mesh = Arc::new(Mesh {
            name: "plate".into(),
            parts: vec![cuboid([0.0, 30.0], [0.0, mm], [0.0, 6.0], "plate")],
        });
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "p"}]},
            "config": {"brim_width": 0, "slow_down_for_layer_cooling": false},
        }))
        .unwrap();
        let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    // 1.0 mm: two 0.42 mm walls leave 0.16 mm in the middle.
    let g = run(1.0);
    let layer = g.split(sx_core::extras::layer_mark(&g)).nth(4).unwrap();
    assert!(layer.contains(";TYPE:Gap infill"), "{layer}");
    let after = layer.split(";TYPE:Gap infill\n").nth(1).unwrap();
    let width: f64 = after
        .lines()
        .next()
        .unwrap()
        .strip_prefix(";WIDTH:")
        .unwrap()
        .parse()
        .unwrap();
    // The bead fills the 0.16 mm gap; its width is written as Orca does, the gap plus the rounded corners
    // of the bead (0.2 mm layers: 0.043 mm).
    assert!((width - 0.203).abs() < 0.02, "gap bead is {width} mm wide");
    // A wide part has no gaps, and neither does one that the walls fill exactly (2 mm is four walls of 0.42 mm, 0.32 mm over).
    assert!(!run(20.0).contains("Gap infill"));
}

#[test]
fn skirt_loops_surround_the_part_on_the_first_layers() {
    let mesh = Arc::new(Mesh {
        name: "block".into(),
        parts: vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 4.0], "block")],
    });
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "b"}]},
        "config": {"brim_width": 0, "skirt_loops": 2, "skirt_distance": 3, "skirt_height": 2},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&r);
    let g = text(&r);
    let moves = features_by_layer(&g);
    let skirt: Vec<_> = moves.iter().filter(|m| m.1 == "Skirt").collect();
    assert!(
        skirt.iter().all(|m| m.0 <= 0.4 + 1e-6),
        "skirt above skirt_height"
    );
    assert!(skirt.iter().any(|m| (m.0 - 0.2).abs() < 1e-6) && skirt.iter().any(|m| (m.0 - 0.4).abs() < 1e-6));
    // The block spans 118 to 138 on the bed; the first loop is 3 mm plus half a loop pitch out (a line width
    // less the rounded corners of the bead, 0.377 mm), the second one pitch further.
    let min_x = skirt.iter().map(|m| m.2).fold(f64::MAX, f64::min);
    assert!((min_x - (118.0 - 3.0 - 1.5 * 0.377)).abs() < 0.02, "{min_x}");
    // Printed before the walls of the layer.
    let layer = g.split(sx_core::extras::layer_mark(&g)).nth(1).unwrap();
    assert!(layer.find(";TYPE:Skirt").unwrap() < layer.find(";TYPE:Outer wall").unwrap());
}

fn block_run(config: Value, options: Value) -> api::Result<SliceRun> {
    let mesh = Arc::new(Mesh {
        name: "block".into(),
        parts: vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 4.0], "block")],
    });
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "b"}]}, "config": config, "options": options,
    }))
    .unwrap();
    common::run_request(&req, &move |_: &str| Ok(mesh.clone()))
}

#[test]
fn custom_start_end_and_layer_gcode_use_the_placeholder_language() {
    let config = json!({
        "brim_width": 0,
        "nozzle_temperature_initial_layer": ["215"],
        "hot_plate_temp_initial_layer": 60,
        "filament_type": ["PLA"],
        "machine_start_gcode": "; start {if filament_type[0] == \"PLA\"}pla{else}other{endif}\nG28\nM190 S[bed_temperature_initial_layer_single]\nM109 S{first_layer_temperature[0] + 5}\n{local y = print_bed_max[1] * 0.5; y}",
        "machine_end_gcode": "; end at {max_layer_z} of {total_layer_count}\nM104 S0",
        "before_layer_change_gcode": "; before {layer_num}",
        "layer_change_gcode": "; layer [layer_num] z={layer_z} of [total_layer_count]",
    });
    let one = block_run(config.clone(), json!({})).unwrap();
    assert_valid(&one);
    let g = text(&one);
    let head = &g[..layer_start(&g, 0)];
    assert!(
        head.contains("; start pla\nG28\nM190 S60\nM109 S220\n128\n"),
        "{head}"
    );
    // The profile heats itself, so no separate heater commands come first, and the built-in start is gone.
    assert!(!head.contains("M140") && !head.contains("M104"), "{head}");
    assert!(head.contains("G90\nG21\nM83 ; use relative distances for extrusion\n"));
    // The profile's end is the last of the moves; the statistics footer follows it.
    assert!(
        g.contains("; end at 4 of 20\nM104 S0\n"),
        "{}",
        &g[g.len() - 400..]
    );
    assert!(g.contains("; total layers count = 20\n") && !g.contains(";@"));
    assert!(!g.contains("M84"), "the built-in end must be replaced");
    for n in [0usize, 7, 19] {
        let z = format!("{:.1}", (n + 1) as f64 * 0.2);
        let z = z.trim_end_matches(".0").to_owned();
        assert!(g.contains(&format!("; layer {n} z={z} of 20\n")), "layer {n}");
    }
    // Both follow the layer markers, before the move to the new Z, in that order (as OrcaSlicer writes them).
    let layer = g.split(sx_core::extras::layer_mark(&g)).nth(3).unwrap();
    assert!(layer.find(";HEIGHT").unwrap() < layer.find("; before 2").unwrap());
    assert!(layer.find("; before 2").unwrap() < layer.find("; layer 2 z=").unwrap());
    assert!(layer.find("; layer 2 z=").unwrap() < layer.find("G1 Z").unwrap());
    // Shards write the same bytes.
    let sharded = block_run(config, json!({"shards": 4})).unwrap();
    assert_eq!(sharded.gcode, one.gcode);
}

#[test]
fn zhop_is_the_current_tools_lift_as_one_number() {
    // The Prusa XL start G-code sets its tool change lift with `M217 Z{max(zhop, 2.0)}`.
    let r = block_run(
        json!({"brim_width": 0, "z_hop": ["0.4"], "machine_start_gcode": "G28\nM217 Z{max(zhop, 2.0)} ; lift {zhop}"}),
        json!({}),
    )
    .unwrap();
    let g = text(&r);
    assert!(g.contains("M217 Z2 ; lift 0.4\n"), "{}", &g[..g.len().min(600)]);
}

#[test]
fn a_start_template_without_temperatures_gets_them_first() {
    let r = block_run(
        json!({"brim_width": 0, "machine_start_gcode": "G28\nG1 X0 Y0"}),
        json!({}),
    )
    .unwrap();
    let g = text(&r);
    let head = &g[..layer_start(&g, 0)];
    assert!(head.find("M140 S").unwrap() < head.find("G28").unwrap());
    assert!(head.contains("M104 S"));
}

#[test]
fn layer_gcode_pause_color_change_and_custom() {
    let config = json!({"brim_width": 0, "machine_pause_gcode": "M0 ; pause at {layer_z}"});
    let r = block_run(
        config,
        json!({"layerGcode": [
            {"layer": 5, "kind": "pause"},
            {"layer": 9, "kind": "color_change"},
            {"layer": 12, "kind": "custom", "gcode": "M117 layer {layer_num + 1}\nM300 S440 P200"},
        ]}),
    )
    .unwrap();
    assert_valid(&r);
    let g = text(&r);
    let at = |n: usize| {
        g.split(sx_core::extras::layer_mark(&g))
            .nth(n + 1)
            .unwrap()
            .to_owned()
    };
    assert!(at(5).contains("M0 ; pause at 1.2\n"));
    assert!(at(9).contains("M600\n"));
    assert!(at(12).contains("M117 layer 13\nM300 S440 P200\n"));
    assert!(!at(6).contains("M0 ;") && !at(10).contains("M600"));
}

#[test]
fn template_errors_stop_the_slice_with_the_reason() {
    let err = block_run(json!({"layer_change_gcode": "G4 P{no_such_variable}"}), json!({})).unwrap_err();
    assert!(err.to_string().contains("no_such_variable"), "{err}");
    let err = block_run(json!({"machine_start_gcode": "{if 1}broken"}), json!({})).unwrap_err();
    assert!(err.to_string().contains("endif"), "{err}");
}

#[test]
fn tool_changes_use_the_profile_gcode() {
    let bytes = std::fs::read(format!("{}/packages/core/bench/models/x-mark-2color.3mf", root())).unwrap();
    let mesh = Arc::new(Mesh::load(&bytes, "x-mark-2color.3mf").unwrap());
    let run = |config: Value| {
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
        let m = mesh.clone();
        common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
    };
    let base = base_config();
    let mut with = base.clone();
    with["change_filament_gcode"] =
        json!("; toolchange [previous_extruder] to {next_extruder + 0}\nT{next_extruder}");
    let (plain, custom) = (run(base), run(with));
    assert_valid(&custom);
    let g = text(&custom);
    let n = g.matches("; toolchange").count();
    assert_eq!(n as u32, custom.report.stats.tool_changes);
    assert!(n >= 6, "{n} tool changes");
    assert!(g.contains("; toolchange 0 to 1\nT1\n") && g.contains("; toolchange 1 to 0\nT0\n"));
    assert_eq!(plain.report.stats.tool_changes, custom.report.stats.tool_changes);
}

#[test]
fn a_resume_uses_the_profile_start_without_homing_z_probing_or_purging() {
    let start = "G28\nG29\nM190 S60\nM109 S{first_layer_temperature[0] + 3}\nG1 Z0.3 F600\nG1 X10 Y10 E15 F1000 ; purge\nG92 E0";
    let r = block_run(
        json!({"brim_width": 0, "machine_start_gcode": start}),
        json!({"resumeFromLayer": 10}),
    )
    .unwrap();
    assert_valid(&r);
    let g = text(&r);
    let head = &g[..layer_start(&g, 0)];
    assert!(
        head.contains("G28 X Y\n") && head.contains("M190 S60\nM109 S223\n"),
        "{head}"
    );
    assert!(
        !head
            .lines()
            .any(|l| l.trim() == "G28" || l.starts_with("G29") || l.contains("purge")),
        "{head}"
    );
    assert!(!head.contains("G1 Z0.3"), "{head}");
    // A start that only calls a firmware macro cannot be filtered: the built-in sequence is used.
    let m = block_run(
        json!({"brim_width": 0, "machine_start_gcode": "PRINT_START BED=60"}),
        json!({"resumeFromLayer": 10}),
    )
    .unwrap();
    let g = text(&m);
    let head = &g[..layer_start(&g, 0)];
    assert!(
        head.contains("G28 X Y\n") && !head.contains("PRINT_START"),
        "{head}"
    );
}

#[test]
fn tree_supports_hold_the_overhang_and_keep_clear_of_the_part() {
    let mesh = Arc::new(table());
    let run = |config: Value| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": config,
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        r
    };
    let normal = run(json!({"enable_support": true}));
    for style in ["tree_slim", "tree_strong", "tree_hybrid", "tree_organic"] {
        let r = run(json!({"enable_support": true, "support_type": "tree(auto)", "support_style": style}));
        assert!(
            r.report
                .warnings
                .iter()
                .all(|w| w.code != api::WarningCode::UnsupportedSetting),
            "{style}: {:?}",
            r.report.warnings
        );
        let moves = features_by_layer(&text(&r));
        let support: Vec<_> = moves.iter().filter(|m| m.1.starts_with("Support")).collect();
        assert!(support.len() > 100, "{style}: {} support moves", support.len());
        // Above the first layer (a pad wider than the branches) no support line runs inside a pillar (x 100 to
        // 108 and 132 to 140, y 100 to 120) or comes within 0.15 mm of one; branches under the roof take in the
        // overhang and are trimmed by the part only, as Orca's are.
        let g = text(&r);
        let (mut z, mut kind) = (0.0_f64, String::new());
        for l in g.lines() {
            if let Some(v) = l.strip_prefix(";Z:") {
                z = v.parse().unwrap();
            } else if let Some(v) = l.strip_prefix(";TYPE:") {
                v.clone_into(&mut kind);
            } else if kind.starts_with("Support") && z > 0.25 && l.starts_with("G1 X") && l.contains(" E") {
                let get = |c: char| {
                    l.split_whitespace()
                        .find_map(|w| w.strip_prefix(c))
                        .and_then(|v| v.parse::<f64>().ok())
                };
                let (Some(x), Some(y)) = (get('X'), get('Y')) else {
                    continue;
                };
                let in_pillar = (99.85..=108.15).contains(&x) || (131.85..=140.15).contains(&x);
                assert!(
                    !(in_pillar && (99.85..=120.15).contains(&y)),
                    "{style}: {kind} at {x} {y} z {z}"
                );
                assert!(z <= 9.8 + 1e-6, "{style}: {kind} at z {z}");
            }
        }
        assert!(
            moves.iter().any(|m| m.1 == "Support" && m.0 < 1.0),
            "{style}: nothing on the bed"
        );
        assert!(
            moves.iter().any(|m| m.1 == "Support interface" && m.0 > 9.0),
            "{style}: no interface under the slab"
        );
        // Trees are lighter than a solid block of support.
        assert!(
            r.report.stats.filament_mm[0] < normal.report.stats.filament_mm[0] * 1.3,
            "{style}"
        );
    }
    // The wide branch settings widen branches near the bed.
    let thin =
        run(json!({"enable_support": true, "support_style": "tree_slim", "tree_support_branch_diameter": 2}));
    let thick =
        run(json!({"enable_support": true, "support_style": "tree_slim", "tree_support_branch_diameter": 8}));
    assert!(thick.report.stats.filament_mm[0] > thin.report.stats.filament_mm[0]);
}

#[test]
fn lightning_fills_tree_bases_and_hollow_leaves_them_bare() {
    let mesh = Arc::new(table());
    let run = |config: Value| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": config,
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        r.report.stats.filament_mm[0]
    };
    for style in ["tree_slim", "tree_strong", "tree_hybrid"] {
        let cfg = |pattern: &str| json!({"enable_support": true, "support_type": "tree(auto)", "support_style": style, "support_base_pattern": pattern});
        let (hollow, lightning, rect) = (run(cfg("hollow")), run(cfg("lightning")), run(cfg("rectilinear")));
        assert!(
            lightning > hollow + 1.0,
            "{style}: lightning {lightning} against hollow {hollow}"
        );
        assert!(
            (lightning - rect).abs() > 1.0,
            "{style}: lightning {lightning} against rectilinear {rect}"
        );
    }
}

#[test]
fn support_columns_stand_on_the_raft() {
    let mesh = Arc::new(table());
    let first_layer = |layers: u32, support: bool| -> (String, f64) {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": {"enable_support": support, "support_type": "normal(auto)", "raft_layers": layers, "independent_support_layer_height": false},
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        let g = text(&r);
        let layer = g
            .split(sx_core::extras::layer_mark(&g))
            .nth(1)
            .unwrap_or_default()
            .to_owned();
        let e: f64 = layer
            .lines()
            .filter(|l| l.starts_with("G1 X") || l.starts_with("G1 Y"))
            .filter_map(|l| {
                l.split_whitespace()
                    .find_map(|w| w.strip_prefix('E'))
                    .and_then(|v| v.parse::<f64>().ok())
            })
            .filter(|e| *e > 0.0)
            .sum();
        (layer, e)
    };
    // One raft layer: the columns' widened first layer prints beside the raft's contact.
    let (one, _) = first_layer(1, true);
    assert!(
        one.contains(";TYPE:Support\n"),
        "no support base on the raft layer"
    );
    // Three: the raft's first layer covers the columns too, so it outgrows the raft of the part alone.
    let (_, with) = first_layer(3, true);
    let (_, without) = first_layer(3, false);
    assert!(
        with > without * 1.1,
        "raft first layer {with} against {without} without support"
    );
}

#[test]
fn a_part_floating_in_the_air_is_named_when_support_is_off() {
    let mesh = Arc::new(Mesh {
        name: "floating".into(),
        parts: vec![
            cuboid([0.0, 10.0], [0.0, 10.0], [0.0, 5.0], "base"),
            cuboid([20.0, 25.0], [0.0, 5.0], [3.0, 6.0], "island"),
        ],
    });
    let run = |config: Value| {
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
        let m = mesh.clone();
        common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
    };
    let off = run(json!({}));
    let floating: Vec<_> = off
        .report
        .warnings
        .iter()
        .filter(|w| w.code == api::WarningCode::FloatingRegion)
        .collect();
    assert_eq!(floating.len(), 1, "{:?}", off.report.warnings);
    assert!(
        floating[0].message.contains("mid-air") && floating[0].message.contains("Turn on supports"),
        "{}",
        floating[0].message
    );
    assert!(floating[0].layer.is_some());
    let on = run(json!({"enable_support": true}));
    assert!(
        on.report
            .warnings
            .iter()
            .all(|w| w.code != api::WarningCode::FloatingRegion)
    );
}

#[test]
fn painted_fuzzy_skin_roughens_only_the_painted_side() {
    // A 20 mm block with its +X side painted (the two triangles of that face).
    let mut block = cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 10.0], "block");
    block.fuzzy_paint = block.triangles[6..8]
        .iter()
        .map(|t| sx_core::paint::PaintFacet {
            v: t.map(|i| block.positions[i as usize]),
            state: 1,
        })
        .collect();
    let mesh = Arc::new(Mesh {
        name: "block".into(),
        parts: vec![block],
    });
    // Outer wall points of layer 20 within 1 mm of the left and the right side.
    let sides = |config: Value| -> (usize, usize) {
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
        let m = mesh.clone();
        let g = text(&common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap());
        let layer = g.split(sx_core::extras::layer_mark(&g)).nth(20).unwrap();
        let wall = layer
            .split(";TYPE:Outer wall")
            .nth(1)
            .unwrap()
            .split(";TYPE:")
            .next()
            .unwrap();
        let xs: Vec<f64> = wall
            .lines()
            .filter(|l| l.starts_with("G1 X"))
            .filter_map(|l| field(l, 'X'))
            .collect();
        let (lo, hi) = xs
            .iter()
            .fold((f64::MAX, f64::MIN), |(a, b), &x| (a.min(x), b.max(x)));
        (
            xs.iter().filter(|&&x| x < lo + 1.0).count(),
            xs.iter().filter(|&&x| x > hi - 1.0).count(),
        )
    };
    // "none" is Orca's Painted only: fuzzy skin where painted and nowhere else.
    let (left, right) = sides(json!({"fuzzy_skin": "none"}));
    assert!(right > 20 && left < 6, "left {left}, right {right}");
    let (left, right) = sides(json!({"fuzzy_skin": "none", "wall_generator": "arachne"}));
    assert!(
        right > 20 && left < 6,
        "variable-width walls: left {left}, right {right}"
    );
    // Disabled, the default, keeps paint off too.
    let (left, right) = sides(json!({"fuzzy_skin": "disabled_fuzzy"}));
    assert!(right < 6 && left < 6, "left {left}, right {right}");
}

#[test]
fn a_bridge_past_the_max_bridge_length_is_named_when_support_is_off() {
    // Two posts 30 mm apart under a slab: a 30 mm bridge.
    let mesh = Arc::new(Mesh {
        name: "arch".into(),
        parts: vec![
            cuboid([0.0, 10.0], [0.0, 10.0], [0.0, 5.0], "left"),
            cuboid([40.0, 50.0], [0.0, 10.0], [0.0, 5.0], "right"),
            cuboid([0.0, 50.0], [0.0, 10.0], [5.0, 7.0], "slab"),
        ],
    });
    let run = |config: Value| {
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
        let m = mesh.clone();
        common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
    };
    let bridges = |r: &SliceRun| {
        r.report
            .warnings
            .iter()
            .filter(|w| w.code == api::WarningCode::LongBridge)
            .count()
    };
    let off = run(json!({}));
    assert_eq!(bridges(&off), 1, "{:?}", off.report.warnings);
    let w = off
        .report
        .warnings
        .iter()
        .find(|w| w.code == api::WarningCode::LongBridge)
        .unwrap();
    assert!(
        w.message.contains("spans 30.0 mm") && w.message.contains("10 mm max bridge length"),
        "{}",
        w.message
    );
    // Not an overhang as well, and fine under a longer limit or with supports on.
    assert!(
        off.report
            .warnings
            .iter()
            .all(|w| w.code != api::WarningCode::FloatingRegion),
        "{:?}",
        off.report.warnings
    );
    assert_eq!(bridges(&run(json!({"max_bridge_length": 40}))), 0);
    assert_eq!(bridges(&run(json!({"enable_support": true}))), 0);
    // 0, as the Bambu Lab presets ship it, sets no limit: no "longer than the 0 mm max bridge length", and the bridge
    // is not passed on as a region that needs support either (Orca warns about neither).
    let zero = run(json!({"max_bridge_length": 0}));
    assert!(zero.report.warnings.is_empty(), "{:?}", zero.report.warnings);
}

#[test]
fn bridges_past_the_shown_five_are_counted_as_bridges() {
    // Seven 30 mm bridges side by side: five are named, the other two are counted as bridges, not as regions.
    let mut parts = Vec::new();
    for y in [0.0_f32, 20.0, 40.0, 60.0, 80.0, 100.0, 120.0] {
        parts.push(cuboid([0.0, 10.0], [y, y + 10.0], [0.0, 5.0], "left"));
        parts.push(cuboid([40.0, 50.0], [y, y + 10.0], [0.0, 5.0], "right"));
        parts.push(cuboid([0.0, 50.0], [y, y + 10.0], [5.0, 7.0], "slab"));
    }
    let mesh = Arc::new(Mesh {
        name: "arches".into(),
        parts,
    });
    let req: SliceRequest =
        serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": {}})).unwrap();
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    let w = &run.report.warnings;
    assert!(w.iter().all(|w| w.code == api::WarningCode::LongBridge), "{w:?}");
    assert_eq!(w.len(), 6, "{w:?}");
    assert!(
        w[5].message
            .starts_with("2 more bridges are longer than the 10 mm max bridge length"),
        "{}",
        w[5].message
    );
}

#[test]
fn tree_supports_on_the_build_plate_only_skip_branches_that_end_on_the_part() {
    let mesh = Arc::new(Mesh {
        name: "mushroom".into(),
        parts: vec![
            cuboid([0.0, 40.0], [0.0, 20.0], [0.0, 3.0], "slab"),
            cuboid([15.0, 25.0], [0.0, 20.0], [3.0, 13.0], "pillar"),
            cuboid([0.0, 40.0], [0.0, 20.0], [13.0, 15.0], "cap"),
        ],
    });
    let run = |config: Value| {
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        let f = features_by_layer(&text(&r));
        let all = f.iter().filter(|m| m.1.starts_with("Support")).count();
        // Support lines between the slab and the cap, over the slab's footprint (x 108 to 148 on the plate).
        let over = f
            .iter()
            .filter(|m| m.1.starts_with("Support") && m.0 > 3.0 && m.0 < 13.0 && m.2 > 110.0 && m.2 < 146.0)
            .count();
        (all, over)
    };
    // Branches near the cap's edge lean out past the slab and reach the bed; the ones in the
    // middle can only rest on the slab, so a build-plate-only run keeps fewer of them.
    let any = run(json!({"enable_support": true, "support_style": "tree_organic"}));
    let plate = run(
        json!({"enable_support": true, "support_style": "tree_organic", "support_on_build_plate_only": true}),
    );
    assert!(any.0 > 50);
    assert!(plate.0 > 0 && plate.1 < any.1 * 9 / 10, "{plate:?} of {any:?}");
}

fn one_box(x: [f32; 2], y: [f32; 2], z: [f32; 2]) -> Mesh {
    Mesh {
        name: "box".into(),
        parts: vec![cuboid(x, y, z, "box")],
    }
}

/// Slices `model` at (100, 100) with `volume` attached under `role`, or bare when `volume` is none.
fn volume_run(model: Mesh, volume: Option<(Mesh, &str)>, config: Value) -> SliceRun {
    let (m, v) = (Arc::new(model), volume.as_ref().map(|(v, _)| Arc::new(v.clone())));
    let mut object = json!({"mesh": "model", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]});
    if let Some((_, role)) = &volume {
        object["volumes"] = json!([{"role": role, "mesh": "volume"}]);
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [object]},
        "config": config,
    }))
    .unwrap();
    let r = common::run_request(&req, &move |id: &str| {
        Ok(match (id, &v) {
            ("volume", Some(v)) => v.clone(),
            _ => m.clone(),
        })
    })
    .unwrap();
    assert_valid(&r);
    r
}

fn extrusion_moves(r: &SliceRun) -> usize {
    text(r)
        .lines()
        .filter(|l| l.starts_with("G1 ") && l.contains(" E") && l.contains(" X"))
        .count()
}

#[test]
fn a_negative_volume_is_cut_out_of_the_part() {
    let block = || one_box([0.0, 30.0], [0.0, 30.0], [0.0, 6.0]);
    let cfg = || json!({"brim_width": 0});
    let plain = volume_run(block(), None, cfg());
    let hole = volume_run(
        block(),
        Some((one_box([10.0, 20.0], [10.0, 20.0], [-1.0, 7.0]), "negative")),
        cfg(),
    );
    let (a, b) = (
        plain.report.stats.filament_mm[0],
        hole.report.stats.filament_mm[0],
    );
    // OrcaSlicer on the same block: the hole saves about 3.4 percent of the filament (1040 against 1005 mm of
    // extrusion, `probe_volumes.py --role negative --hole`), and the top surface shrinks by 16 percent.
    assert!(b < a * 0.97, "the hole saves material: {b} vs {a}");
    // The hole is a through hole: no material inside it on any layer, so its
    // walls are printed (more extrusion moves per layer than infill alone would need).
    assert!(extrusion_moves(&hole) > 0);
}

#[test]
fn support_blockers_and_enforcers_shape_the_support() {
    let cfg = || json!({"enable_support": true, "brim_width": 0});
    let xs = |r: &SliceRun| -> Vec<f64> {
        features_by_layer(&text(r))
            .into_iter()
            .filter(|m| m.1.starts_with("Support") && m.0 > 0.25)
            .map(|m| m.2)
            .collect()
    };
    // The slab is 40 mm wide at x 100 to 140; a blocker covers its right half.
    let free = volume_run(table(), None, cfg());
    let blocked = volume_run(
        table(),
        Some((
            // Deeper than the slab: grid support reaches past the part's front and back.
            one_box([21.0, 33.0], [-4.0, 24.0], [-1.0, 13.0]),
            "support_blocker",
        )),
        cfg(),
    );
    let (all, some) = (xs(&free), xs(&blocked));
    assert!(
        all.iter().any(|x| *x > 125.0),
        "support reaches the right half without a blocker"
    );
    assert!(!some.is_empty());
    // Blockers only cut the overhang (as in Orca): the grid cell the support fills may reach back into the
    // blocker, by at most one cell (2.877 mm) and half a line spacing.
    assert!(
        some.iter().all(|x| *x < 121.0 + 2.877 + 0.2),
        "nothing past the cell next to the blocker, but reached x {}",
        some.iter().copied().fold(0.0, f64::max)
    );
    // A slope inside the threshold gets no support, unless an enforcer covers it.
    let slope = || frustum(10.0, 30.0, 10.0);
    let steep = || json!({"enable_support": true, "brim_width": 0, "support_threshold_angle": 20});
    let none = volume_run(slope(), None, steep());
    assert!(!text(&none).contains(";TYPE:Support"));
    let forced = volume_run(
        slope(),
        Some((
            one_box([-40.0, 40.0], [-40.0, 40.0], [0.0, 10.0]),
            "support_enforcer",
        )),
        steep(),
    );
    assert!(
        text(&forced).contains(";TYPE:Support"),
        "an enforcer forces support under the slope"
    );
    // Manual supports come only from enforcers.
    let manual = || json!({"enable_support": true, "support_type": "normal(manual)", "brim_width": 0});
    let m_none = volume_run(table(), None, manual());
    assert!(!text(&m_none).contains(";TYPE:Support"));
    let m_forced = volume_run(
        table(),
        Some((
            one_box([-1.0, 41.0], [-1.0, 21.0], [9.0, 11.0]),
            "support_enforcer",
        )),
        manual(),
    );
    assert!(text(&m_forced).contains(";TYPE:Support"));
}

/// Two boxes on the plate: 20 mm and 6 mm tall, `gap` mm apart in x.
fn two_boxes(gap: f32, config: Value) -> SliceRun {
    let tall = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 20.0]));
    let short = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 6.0]));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "a", "name": "tall", "mesh": "tall", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 60,100,0,1]},
            {"id": "b", "name": "short", "mesh": "short", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 80.0 + gap,100,0,1]},
        ]},
        "config": config,
    }))
    .unwrap();
    let r = common::run_request(&req, &move |id: &str| {
        Ok(if id == "tall" { tall.clone() } else { short.clone() })
    })
    .unwrap();
    assert_valid(&r);
    r
}

fn layer_zs(g: &str) -> Vec<f64> {
    g.lines()
        .filter_map(|l| l.strip_prefix(";Z:"))
        .map(|v| v.parse().unwrap())
        .collect()
}

/// The X of every skirt move on the first layer, and the length of its longest extruding move.
fn skirt_xs(g: &str) -> (Vec<f64>, f64) {
    let first = g.split(sx_core::extras::layer_mark(g)).nth(1).unwrap_or("");
    let mut on = false;
    let (mut xs, mut longest, mut at) = (Vec::new(), 0.0_f64, (0.0, 0.0));
    for line in first.lines() {
        if let Some(t) = line.strip_prefix(";TYPE:") {
            on = t == "Skirt";
        } else if line.starts_with("G1 X") || line.starts_with("G0 X") {
            let p = (field(line, 'X').unwrap(), field(line, 'Y').unwrap_or(at.1));
            if on && line.starts_with("G1") && line.contains('E') {
                xs.push(p.0);
                longest = longest.max((p.0 - at.0).hypot(p.1 - at.1));
            }
            at = p;
        }
    }
    (xs, longest)
}

#[test]
fn a_skirt_per_object_goes_round_each_group_of_objects_that_do_not_touch() {
    let cfg = |t: &str| json!({"brim_width": 0, "skirt_loops": 1, "skirt_distance": 3, "skirt_type": t});
    let (_, combined) = skirt_xs(&text(&two_boxes(60.0, cfg("combined"))));
    let (per_xs, per) = skirt_xs(&text(&two_boxes(60.0, cfg("perobject"))));
    // The boxes sit at x 60 to 80 and 140 to 160: one loop around both has a side over 80 mm long, two
    // loops have none over 30.
    assert!(combined > 80.0 && per < 30.0, "{combined} {per}");
    assert!(per_xs.iter().any(|x| *x < 60.0) && per_xs.iter().any(|x| *x > 160.0));
    // Boxes 4 mm apart share a skirt, as in Orca: a group merges when the grown hulls touch.
    let (_, near) = skirt_xs(&text(&two_boxes(4.0, cfg("perobject"))));
    assert!(near > 40.0, "{near}");
}

/// The skirt of layer `n` (0-based): the point its first loop starts at and the length of all its loops, mm.
fn skirt_of_layer(g: &str, n: usize) -> ((f64, f64), f64) {
    let layer = g.split(sx_core::extras::layer_mark(g)).nth(n + 1).unwrap_or("");
    let (mut on, mut at, mut start, mut total) = (false, (0.0, 0.0), None, 0.0_f64);
    for line in layer.lines() {
        if let Some(t) = line.strip_prefix(";TYPE:") {
            on = t == "Skirt";
        } else if line.starts_with("G1 X") || line.starts_with("G0 X") {
            let p = (field(line, 'X').unwrap(), field(line, 'Y').unwrap_or(at.1));
            if on && line.starts_with("G1") && line.contains('E') {
                start.get_or_insert(at);
                total += (p.0 - at.0).hypot(p.1 - at.1);
            }
            at = p;
        }
    }
    (start.unwrap_or((0.0, 0.0)), total)
}

#[test]
fn skirt_start_angle_min_length_and_single_loop_shape_the_skirt() {
    let cfg = |extra: Value| {
        let mut c =
            json!({"brim_width": 0, "skirt_loops": 2, "skirt_distance": 3, "skirt_height": 3, "seam_gap": 0});
        c.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        block_gcode(c)
    };
    // The block spans 100 to 140 (it sits at 100, 100 and is 40 mm wide, from 0 to 40).
    let left_low = skirt_of_layer(&cfg(json!({"skirt_start_angle": -135})), 0).0;
    let right = skirt_of_layer(&cfg(json!({"skirt_start_angle": 0})), 0).0;
    assert!(left_low.0 < 100.0 && left_low.1 < 100.0, "{left_low:?}");
    assert!(right.0 > 140.0 && (right.1 - 120.0).abs() < 8.0, "{right:?}");
    // A minimum length adds loops until the filament used reaches it.
    let (_, two) = skirt_of_layer(&cfg(json!({})), 0);
    let (_, more) = skirt_of_layer(&cfg(json!({"min_skirt_length": 60})), 0);
    assert!(more > two * 1.4, "{two} {more}");
    // One loop above the first layer.
    let (_, first) = skirt_of_layer(&cfg(json!({"single_loop_draft_shield": true})), 0);
    let (_, second) = skirt_of_layer(&cfg(json!({"single_loop_draft_shield": true})), 1);
    assert!(second < first * 0.6 && second > first * 0.3, "{first} {second}");
}

#[test]
fn slicing_mode_decides_what_nested_loops_mean() {
    // A 30 mm block with a 12 mm box inside it, wound as a cavity (inward) or as a second solid (outward).
    let run = |inward: bool, mode: &str| -> usize {
        let mut inner = cuboid([9.0, 21.0], [9.0, 21.0], [-1.0, 5.0], "inner");
        if inward {
            for t in &mut inner.triangles {
                t.swap(1, 2);
            }
        }
        let mesh = Arc::new(Mesh {
            name: "nest".into(),
            parts: vec![cuboid([0.0, 30.0], [0.0, 30.0], [0.0, 4.0], "outer"), inner],
        });
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "n", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": {"brim_width": 0, "skirt_loops": 0, "slicing_mode": mode, "sparse_infill_density": 0},
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        feature_moves_per_layer(&text(&r), "Outer wall")
            .get(2)
            .copied()
            .unwrap_or(0)
    };
    // A cavity has walls of its own, unless every loop is turned outward.
    let (cavity, closed) = (run(true, "regular"), run(true, "close_holes"));
    assert!(cavity > closed + 3, "{cavity} {closed}");
    // Even-odd mode turns the doubly covered area into a hole where the regular rule keeps it solid.
    let (solid, odd) = (run(false, "regular"), run(false, "even_odd"));
    assert!(odd > solid + 3, "{solid} {odd}");
}

#[test]
fn print_order_as_object_list_prints_the_objects_in_list_order_on_each_layer() {
    let cube = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 3.0]));
    let first_outer_x = |order: &str| -> f64 {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [
                {"id": "far", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 170,100,0,1]},
                {"id": "near", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 40,100,0,1]},
            ]},
            "config": {"brim_width": 0, "skirt_loops": 0, "print_order": order},
        }))
        .unwrap();
        let c = cube.clone();
        let g = text(&common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap());
        let layer = g.split(sx_core::extras::layer_mark(&g)).nth(2).unwrap();
        let wall = layer.split(";TYPE:Outer wall").nth(1).unwrap();
        wall.lines()
            .find(|l| l.starts_with("G1 X"))
            .map(|l| field(l, 'X').unwrap())
            .unwrap()
    };
    // Nearest first starts at the object the nozzle is closest to; the list starts with the far one.
    assert!(first_outer_x("default") < 100.0, "{}", first_outer_x("default"));
    assert!(
        first_outer_x("as_obj_list") > 150.0,
        "{}",
        first_outer_x("as_obj_list")
    );
}

#[test]
fn print_by_object_finishes_each_object_before_the_next() {
    let by_layer = two_boxes(60.0, json!({"brim_width": 0}));
    let by_object = two_boxes(60.0, json!({"brim_width": 0, "print_sequence": "by object"}));
    let g = text(&by_object);
    let zs = layer_zs(&g);
    // 100 layers of the tall object, then 30 of the short one, starting over from the first layer.
    assert_eq!(zs.len(), 130, "{}", zs.len());
    assert!((zs[99] - 20.0).abs() < 1e-6 && (zs[100] - 0.2).abs() < 1e-6);
    assert_eq!(layer_zs(&text(&by_layer)).len(), 100);
    // Same material either way, within the skirt and travel differences.
    let (a, b) = (
        by_layer.report.stats.filament_mm[0],
        by_object.report.stats.filament_mm[0],
    );
    assert!((a - b).abs() < a * 0.05, "{a} vs {b}");
    // Moving to the second object: lift above the first object's top, travel, come down.
    let at = g.match_indices(";Z:0.2").nth(1).map(|m| m.0).unwrap();
    let start = &g[at..];
    let lines: Vec<&str> = start.lines().take(30).collect();
    let lift = lines
        .iter()
        .position(|l| l.starts_with("G1 Z2"))
        .expect("lift above the tall object");
    let down = lines
        .iter()
        .position(|l| l.starts_with("G1 Z0.2"))
        .expect("down to the first layer");
    assert!(lift < down);
    assert!(
        lines[lift..down].iter().any(|l| l.starts_with("G0 X")),
        "the travel happens at height"
    );
    // Objects far apart and only the last one tall: the second is short, so only the first is over the rod.
    assert!(
        !by_object
            .report
            .warnings
            .iter()
            .any(|w| w.message.contains("gantry"))
    );
}

/// Two 20 mm boxes, left one with the plate's settings and the right one with `right` on top.
fn boxes_with_settings(right: Value, config: Value) -> SliceRun {
    let cube = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 6.0]));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "l", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 60,100,0,1]},
            {"id": "r", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 140,100,0,1], "settings": right},
        ]},
        "config": config,
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(cube.clone())).unwrap();
    assert_valid(&r);
    r
}

#[test]
fn objects_can_carry_their_own_settings() {
    let cfg = || json!({"brim_width": 0, "wall_loops": 2, "sparse_infill_density": 10});
    let same = boxes_with_settings(json!({}), cfg());
    let mixed = boxes_with_settings(json!({"wall_loops": 5, "sparse_infill_density": 60}), cfg());
    let count = |r: &SliceRun, right: bool, feature: &str| {
        features_by_layer(&text(r))
            .into_iter()
            .filter(|m| m.1 == feature && (m.2 > 120.0) == right)
            .count()
    };
    // The left box keeps the plate's settings, the right one gets thicker walls and more infill.
    assert_eq!(
        count(&mixed, false, "Inner wall"),
        count(&same, false, "Inner wall")
    );
    assert!(count(&mixed, true, "Inner wall") > count(&same, true, "Inner wall") * 2);
    assert!(count(&mixed, true, "Sparse infill") > count(&same, true, "Sparse infill") * 2);
    // Still one print: layers hold both objects.
    assert_eq!(layer_zs(&text(&mixed)).len(), layer_zs(&text(&same)).len());
    // By object works the same way, and layer heights may differ there but not layer by layer.
    let seq = boxes_with_settings(
        json!({"wall_loops": 5}),
        json!({"brim_width": 0, "wall_loops": 2, "print_sequence": "by object"}),
    );
    assert!(count(&seq, true, "Inner wall") > count(&seq, false, "Inner wall") * 2);
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 60,100,0,1]},
            {"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 140,100,0,1], "settings": {"layer_height": 0.1}},
        ]},
        "config": cfg(),
    }))
    .unwrap();
    let cube = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 6.0]));
    assert!(common::run_request(&req, &move |_: &str| Ok(cube.clone())).is_err());
}

#[test]
fn sleipnir_keeps_fixed_layers_where_colors_change() {
    // A 12 mm box on filament 1 beside a 6 mm box on filament 2, asked for 0.1 mm layers all the way
    // up. Up to 6 mm every layer prints both filaments, so those layers stay at the fixed 0.2 mm and
    // the thin layers start above them: no tool changes are added.
    let tall = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 12.0]));
    let short = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 6.0]));
    let mut tops = vec![0.2];
    while tops.last().copied().unwrap_or(0.0) < 12.0 {
        tops.push(tops.last().copied().unwrap_or(0.0) + 0.1);
    }
    let req = |options: Value| -> SliceRequest {
        serde_json::from_value(json!({
            "plate": {"objects": [
                {"id": "a", "mesh": "tall", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 60,100,0,1]},
                {"id": "b", "mesh": "short", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 140,100,0,1], "slotOverrides": {"box": 2}},
            ]},
            "config": {"brim_width": 0, "layer_height": 0.2, "initial_layer_print_height": 0.2},
            "options": options,
        }))
        .unwrap()
    };
    let load = move |id: &str| Ok(if id == "tall" { tall.clone() } else { short.clone() });
    let fixed = common::run_request(&req(json!({"flavor": "marlin2"})), &load).unwrap();
    let varied = common::run_request(&req(json!({"flavor": "marlin2", "layerTopsMm": tops})), &load).unwrap();
    assert_valid(&varied);
    let changes = |r: &SliceRun| {
        text(r)
            .lines()
            .filter(|l| l.len() == 2 && l.starts_with('T'))
            .count()
    };
    assert_eq!(changes(&varied), changes(&fixed));
    let cost = varied
        .report
        .vary_layer_cost
        .expect("a cost on a two-color plate");
    assert_eq!(cost.extra_tool_changes, 0);
    assert!(cost.extra_purge_g.abs() < 1e-9, "{}", cost.extra_purge_g);
    let z: Vec<f64> = varied.report.layer_z.iter().map(|&v| f64::from(v)).collect();
    let steps: Vec<(f64, f64)> = z.windows(2).map(|w| (w[1], w[1] - w[0])).collect();
    assert!(
        steps
            .iter()
            .filter(|(top, _)| *top <= 6.0 + 1e-4)
            .all(|(_, h)| (h - 0.2).abs() < 1e-4),
        "{z:?}"
    );
    assert!(
        steps
            .iter()
            .filter(|(top, _)| *top > 6.3)
            .all(|(_, h)| (h - 0.1).abs() < 1e-4),
        "{z:?}"
    );
    assert!(z.len() >= 85, "{} layers", z.len());
}

/// Two 20 mm boxes, the right one on filament slot 2, with `config` on top of a small brim-less base.
fn two_colors(config: Value) -> SliceRun {
    let cube = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 6.0]));
    // The tower where the settings put it; `prime_tower_auto_position` (on by default) has its own test.
    let mut cfg = json!({"brim_width": 0, "wipe_tower_y": 20, "prime_tower_auto_position": false});
    if let (Some(base), Some(extra)) = (cfg.as_object_mut(), config.as_object()) {
        base.extend(extra.clone());
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "l", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 60,100,0,1]},
            {"id": "r", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 140,100,0,1], "slotOverrides": {"box": 2}},
        ]},
        "config": cfg,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(cube.clone())).unwrap();
    assert_valid(&r);
    r
}

fn tower_mm(g: &str) -> f64 {
    // Extruded filament (relative E) on the Prime tower feature.
    let mut on = false;
    let mut total = 0.0;
    for l in g.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            on = t == "Prime tower";
        } else if on
            && l.starts_with("G1 X")
            && let Some(e) = l.split(" E").nth(1)
        {
            total += e
                .split_whitespace()
                .next()
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.0)
                .max(0.0);
        }
    }
    total
}

#[test]
fn a_prime_tower_purges_after_every_tool_change() {
    let off = two_colors(json!({}));
    let on = two_colors(json!({"enable_prime_tower": true, "prime_volume": 45}));
    assert!(!text(&off).contains(";TYPE:Prime tower"));
    let g = text(&on);
    assert!(g.contains(";TYPE:Prime tower"));
    // One tool change per layer after the first two, and a purge right after each.
    let changes = on.report.stats.tool_changes;
    assert!(changes >= 29, "{changes}");
    let purged = tower_mm(&g);
    let area = std::f64::consts::PI * 0.875f64.powi(2);
    let per_change = purged / f64::from(changes) * area;
    assert!((40.0..60.0).contains(&per_change), "{per_change} mm3 per change");
    // A bigger prime volume purges more.
    let more = two_colors(json!({"enable_prime_tower": true, "prime_volume": 90}));
    assert!(tower_mm(&text(&more)) > purged * 1.7);
    // The matrix sets the volume per pair: 20 and 180 mm3 against 20 and 20.
    let flat = two_colors(json!({"enable_prime_tower": true, "flush_volumes_matrix": [0, 20, 20, 0]}));
    let lopsided = two_colors(json!({"enable_prime_tower": true, "flush_volumes_matrix": [0, 20, 180, 0]}));
    assert!(tower_mm(&text(&lopsided)) > tower_mm(&text(&flat)) * 3.0);
    // The tower stands at its own spot, clear of both boxes, with Orca's default 3 mm brim around
    // its first layer.
    let xs: Vec<f64> = features_by_layer(&g)
        .into_iter()
        .filter(|m| m.1 == "Prime tower")
        .map(|m| m.2)
        .collect();
    assert!(xs.iter().all(|x| *x > 11.5 && *x < 53.5), "{xs:?}");
    // With the tool changes gone (one filament) there is no tower.
    let single = run(&request(json!({}), json!({}))).unwrap();
    assert!(!text(&single).contains(";TYPE:Prime tower"));
}

#[test]
fn filaments_map_to_the_slot_the_part_is_put_in() {
    // Slot mapping is the part's slot: a part on slot 3 prints with T2 and heats extruder 3,
    // and slot 2, which nothing uses, is never selected.
    let cube = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 4.0]));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "a", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 60,100,0,1]},
            {"id": "b", "mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 140,100,0,1], "slotOverrides": {"box": 3}},
        ]},
        "config": {"brim_width": 0, "nozzle_temperature": [200, 210, 230]},
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(cube.clone())).unwrap();
    assert_valid(&r);
    let g = text(&r);
    let tools: Vec<&str> = g.lines().filter(|l| l.len() == 2 && l.starts_with('T')).collect();
    assert!(tools.contains(&"T2") && !tools.contains(&"T1"), "{tools:?}");
    assert_eq!(r.report.stats.filament_mm.len(), 3);
    assert!(
        r.report.stats.filament_mm[0] > 0.0
            && r.report.stats.filament_mm[1] == 0.0
            && r.report.stats.filament_mm[2] > 0.0
    );
}

/// A 20 x 20 x 10 mm box at (100, 100) with its right face (x = 110) painted with filament 2.
fn painted_box(face_top: bool) -> Mesh {
    let mut part = cuboid([-10.0, 10.0], [-10.0, 10.0], [0.0, 10.0], "box");
    let facets = |tri: [[f32; 3]; 3]| sx_core::paint::PaintFacet { v: tri, state: 2 };
    part.paint = if face_top {
        vec![
            facets([[-10.0, -10.0, 10.0], [10.0, -10.0, 10.0], [10.0, 10.0, 10.0]]),
            facets([[-10.0, -10.0, 10.0], [10.0, 10.0, 10.0], [-10.0, 10.0, 10.0]]),
        ]
    } else {
        vec![
            facets([[10.0, -10.0, 0.0], [10.0, 10.0, 0.0], [10.0, 10.0, 10.0]]),
            facets([[10.0, -10.0, 0.0], [10.0, 10.0, 10.0], [10.0, -10.0, 10.0]]),
        ]
    };
    Mesh {
        name: "painted".into(),
        parts: vec![part],
    }
}

fn painted_run(mesh: Mesh) -> SliceRun {
    let mesh = Arc::new(mesh);
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "p", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": {"brim_width": 0},
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&r);
    r
}

/// A spiral vase lays one outline per layer in one filament. With a painted side each filament's region printed
/// its own outline, the wall between them included, with a tool change on every layer. Orca refuses such an
/// object (`Print::validate`), and so does the engine.
#[test]
fn spiral_vase_refuses_a_painted_object() {
    let mesh = Arc::new(painted_box(false));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "p", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": {"brim_width": 0, "spiral_mode": true, "wall_loops": 1, "top_shell_layers": 0, "sparse_infill_density": 0},
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let err = common::run_request(&req, &move |_: &str| Ok(mesh.clone()))
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default();
    assert!(err.contains("spiral_mode") && err.contains("filament"), "{err}");
}

/// Extrusion points of one tool on one layer (1-based), by x.
fn tool_xs(g: &str, layer: usize, tool: u8) -> Vec<f64> {
    let mut out = Vec::new();
    let (mut l, mut t) = (0usize, 0u8);
    for line in g.lines() {
        if sx_core::extras::is_layer_mark(line) {
            l += 1;
        } else if line.len() == 2 && line.starts_with('T') {
            t = line[1..].parse::<u8>().unwrap_or(0);
        } else if l == layer
            && t == tool
            && line.starts_with("G1 X")
            && line.contains(" E")
            && let Some(x) = line.split_whitespace().find_map(|w| w.strip_prefix('X'))
        {
            out.push(x.parse().unwrap());
        }
    }
    out
}

#[test]
fn a_painted_wall_colors_the_wedge_behind_it_and_only_the_skin_near_the_top_and_bottom() {
    let r = painted_run(painted_box(false));
    let g = text(&r);
    assert_eq!(r.report.stats.filament_mm.len(), 2);
    assert!(r.report.stats.filament_mm[1] > 0.0);
    // Mid-height: the second filament runs from the painted face back to the middle.
    let mid = tool_xs(&g, 25, 1);
    assert!(!mid.is_empty());
    let (lo, hi) = mid
        .iter()
        .fold((f64::MAX, f64::MIN), |(l, h), x| (l.min(*x), h.max(*x)));
    assert!(lo < 100.6 && lo > 99.0, "reaches back to the middle, from {lo}");
    assert!(hi > 109.5 && hi < 110.0, "{hi}");
    // The first layer and the last show no paint from the walls; the layers next to them show a thin skin.
    assert!(tool_xs(&g, 1, 1).is_empty() && tool_xs(&g, 50, 1).is_empty());
    let skin = tool_xs(&g, 3, 1);
    assert!(!skin.is_empty() && skin.iter().all(|x| *x > 107.0), "{skin:?}");
    // The slot is 2 and T1 is used.
    assert!(g.lines().any(|l| l == "T1"));
    // Layers 2 to 49 have both colors and one change each, starting from the tool the layer below
    // ended on (Orca: 49 tool commands, the first one included).
    let tools = g.lines().filter(|l| l.len() == 2 && l.starts_with('T')).count();
    assert_eq!(tools, 49);
}

#[test]
fn a_painted_top_face_colors_the_top_layers_in_a_shrinking_square() {
    let r = painted_run(painted_box(true));
    let g = text(&r);
    let top = tool_xs(&g, 50, 1);
    let below = tool_xs(&g, 47, 1);
    assert!(!top.is_empty() && !below.is_empty());
    let span = |v: &[f64]| v.iter().fold(0.0f64, |m, x| m.max((x - 100.0).abs()));
    // Layer 50 covers the face; each layer below draws in by 0.8 mm; below the top shell it is gone.
    assert!(span(&top) > 9.4, "{}", span(&top));
    assert!(
        span(&below) < span(&top) - 1.5 && span(&below) > 6.0,
        "{}",
        span(&below)
    );
    assert!(tool_xs(&g, 44, 1).is_empty());
}

#[test]
fn preview_extras_point_at_the_gcode_line_of_every_segment() {
    let run = run(&request(json!({"shards": 3}), json!({}))).unwrap();
    let g = text(&run);
    let lines: Vec<&str> = g.lines().collect();
    let b = &run.preview;
    let u32at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) as usize;
    let f32at = |o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let flags = u16::from_le_bytes([b[6], b[7]]);
    assert_eq!(flags & 2, 2, "the extras flag is set");
    let (segs, layers, travels) = (u32at(8), u32at(12), u32at(16));
    let segments_at = 32 + (layers + 1) * 4 + layers * 4 + layers * 4 + (layers + 1) * 4;
    let extras_at = segments_at + segs * 32 + travels * 16;
    assert_eq!(b.len() % 4, 0);
    let (mut checked, mut wrong, mut fans, mut temps, mut seams, mut retracts) = (0, 0, 0, 0, 0, 0);
    for s in 0..segs {
        let seg = segments_at + s * 32;
        let e = extras_at + s * 8;
        let (fan, fl, temp, line) = (
            b[e],
            b[e + 1],
            u16::from_le_bytes([b[e + 2], b[e + 3]]),
            u32at(e + 4),
        );
        fans += usize::from(fan > 0);
        temps += usize::from(temp >= 200);
        seams += usize::from(fl & 4 != 0);
        retracts += usize::from(fl & 1 != 0);
        if line == 0 {
            continue;
        }
        checked += 1;
        // The line is a move that ends where the segment ends.
        let l = lines[line - 1];
        let coord = |axis: char| {
            l.split_whitespace()
                .find_map(|w| w.strip_prefix(axis))
                .and_then(|v| v.parse::<f32>().ok())
        };
        let (x, y) = (f32at(seg + 8), f32at(seg + 12));
        let hit = coord('X')
            .zip(coord('Y'))
            .is_some_and(|(cx, cy)| (cx - x).abs() < 0.002 && (cy - y).abs() < 0.002);
        if !hit && l.starts_with("G1") {
            // A move can cover several collinear-free segments only when an extrusion step rounds to 0.
            wrong += 1;
        }
    }
    assert!(checked > segs * 99 / 100, "{checked} of {segs}");
    assert!(
        wrong * 100 <= checked,
        "{wrong} of {checked} lines do not end where their segment ends"
    );
    assert!(
        fans > 0 && temps == segs && seams > 0 && retracts > 0,
        "{fans} {temps} {seams} {retracts}"
    );
    // A run without the G-code has no extras.
    let bare = run_bare();
    assert_eq!(u16::from_le_bytes([bare[6], bare[7]]) & 2, 0);
}

fn run_bare() -> Vec<u8> {
    let r = run(&request(json!({"emitGcode": false}), json!({}))).unwrap();
    r.preview
}

#[test]
fn the_engine_places_the_prime_tower_itself_by_default() {
    // Two boxes at y 100 to 120: the tower goes beside them, clear by the brim, and the report says so.
    let r = two_colors(json!({"enable_prime_tower": true, "prime_tower_auto_position": true}));
    let Some(t) = r.report.prime_tower else {
        panic!("no tower in the report")
    };
    assert_eq!(serde_json::to_value(t.reason).unwrap(), json!("auto"));
    let (x1, y1) = (t.x + t.width, t.y + t.depth);
    let clear =
        |(bx0, by0, bx1, by1): (f64, f64, f64, f64)| x1 <= bx0 || t.x >= bx1 || y1 <= by0 || t.y >= by1;
    assert!(
        clear((59.0, 99.0, 81.0, 121.0)) && clear((139.0, 99.0, 161.0, 121.0)),
        "{t:?}"
    );
    // Next to the boxes, not across the bed.
    let c = (t.x + t.width / 2.0, t.y + t.depth / 2.0);
    assert!((c.0 - 110.0).hypot(c.1 - 110.0) < 40.0, "{t:?}");
}

#[test]
fn a_prime_tower_moves_clear_of_the_objects_and_blocks_when_it_cannot() {
    // Asked for on top of the left box (x 60 to 80, y 100 to 120), it moves away.
    let r = two_colors(json!({"enable_prime_tower": true, "wipe_tower_x": 62, "wipe_tower_y": 102}));
    let g = text(&r);
    let mut on = false;
    let mut pts = Vec::new();
    for l in g.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            on = t == "Prime tower";
        } else if on && l.starts_with("G1 X") {
            let c = |a: char| {
                l.split_whitespace()
                    .find_map(|w| w.strip_prefix(a))
                    .and_then(|v| v.parse::<f64>().ok())
            };
            pts.push((c('X').unwrap(), c('Y').unwrap_or(0.0)));
        }
    }
    assert!(!pts.is_empty());
    assert!(
        pts.iter()
            .all(|(x, y)| !((59.0..81.0).contains(x) && (99.5..121.0).contains(y))),
        "{:?}",
        &pts[..3]
    );
    // A tower wider than the bed fits nowhere.
    let cube = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 6.0]));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 60,100,0,1]},
            {"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 140,100,0,1], "slotOverrides": {"box": 2}},
        ]},
        "config": {"enable_prime_tower": true, "prime_tower_width": 300},
    }))
    .unwrap();
    let e = common::run_request(&req, &move |_: &str| Ok(cube.clone()))
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default();
    assert!(e.contains("prime tower"), "{e}");
}

#[test]
fn tool_change_gcode_sees_temperatures_feed_rates_and_flush_lengths() {
    let gcode = "{if old_filament_temp > 142 && next_extruder < 255}\nM104 S[old_filament_temp]\n{endif}\n\
                 ;FLUSH [flush_length_1] old [old_filament_e_feedrate] new [new_filament_e_feedrate] z {max_layer_z}\nT[next_extruder]";
    let r = two_colors(json!({
        "change_filament_gcode": gcode,
        "nozzle_temperature": [200, 230],
        "filament_max_volumetric_speed": [12, 15],
        "flush_volumes_matrix": [0, 100, 100, 0],
    }));
    let g = text(&r);
    let flush = g.lines().find(|l| l.starts_with(";FLUSH")).unwrap();
    let area = std::f64::consts::PI * 0.875f64.powi(2);
    // 100 mm3 as a length of filament in one flush step (Orca: steps of about 135 mm3); 12 mm3/s and
    // 15 mm3/s as feed rates.
    let len: f64 = flush.split_whitespace().nth(1).unwrap().parse().unwrap();
    assert!((len - 100.0 / area).abs() < 0.2, "{flush}");
    assert!(
        flush.contains(&format!(" old {} ", (12.0 / area * 60.0).round()))
            || flush.contains(&format!(" old {} ", (15.0 / area * 60.0).round())),
        "{flush}"
    );
    assert!(g.contains("M104 S200") && g.contains("M104 S230"));
    // The layer height the nozzle is at, not the top of the plate.
    let z: f64 = flush.rsplit(' ').next().unwrap().parse().unwrap();
    assert!(z < 6.1);
}

#[test]
fn flush_into_infill_takes_the_purge_from_the_tower() {
    let plain = two_colors(json!({
        "enable_prime_tower": true, "prime_tower_always": true, "prime_volume": 45,
        "flush_into_infill": false, "flush_into_support": false,
    }));
    let flushed = two_colors(json!({
        "enable_prime_tower": true, "prime_tower_always": true, "prime_volume": 45, "flush_into_infill": true,
    }));
    // The depth the purge no longer takes is filled with the sparse grid (Orca's finish block), so the
    // tower loses less than the purge itself.
    let (a, b) = (tower_mm(&text(&plain)), tower_mm(&text(&flushed)));
    assert!(b < a * 0.95, "{b} against {a}");
    // The same material is printed either way: what the tower loses, the infill already printed.
    let total = |r: &SliceRun| r.report.stats.filament_mm.iter().sum::<f64>();
    assert!((total(&plain) - total(&flushed)).abs() < total(&plain) * 0.25);
    // The new filament's infill comes first after the change.
    let g = text(&flushed);
    let first_infill_before_wall = g.split(sx_core::extras::layer_mark(&g)).nth(10).map(|l| {
        // After the tool change, before anything of the new filament's walls.
        let after = l.find("\nT").map_or("", |i| l.get(i..).unwrap_or(""));
        let s = after.find(";TYPE:Sparse infill");
        let w = after.find(";TYPE:Outer wall");
        s.is_some() && (w.is_none() || s < w)
    });
    assert_eq!(first_infill_before_wall, Some(true));
}

#[test]
fn flush_into_objects_takes_up_more_of_the_purge_than_infill_alone() {
    let cfg = |extra: Value| {
        let mut c = json!({
            "enable_prime_tower": true, "prime_tower_always": true, "prime_volume": 45,
            "flush_into_infill": false, "flush_into_support": false,
        });
        c.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        c
    };
    let plain = tower_mm(&text(&two_colors(cfg(json!({})))));
    let infill = tower_mm(&text(&two_colors(cfg(json!({"flush_into_infill": true})))));
    let objects = tower_mm(&text(&two_colors(cfg(json!({"flush_into_objects": true})))));
    assert!(objects < infill && infill < plain, "{plain} {infill} {objects}");
}

#[test]
fn a_modifier_volume_changes_the_settings_inside_it() {
    let cfg = json!({"brim_width": 0, "wall_loops": 2, "sparse_infill_density": 10});
    let run_with = |settings: Value| {
        let cube = Arc::new(one_box([-20.0, 20.0], [-10.0, 10.0], [0.0, 6.0]));
        let modifier = Arc::new(one_box([0.0, 30.0], [-20.0, 20.0], [-1.0, 7.0]));
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{
                "mesh": "c",
                "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1],
                "volumes": [{"role": "modifier", "mesh": "m", "settings": settings}],
            }]},
            "config": cfg.clone(),
        }))
        .unwrap();
        let r = common::run_request(&req, &move |id: &str| {
            Ok(if id == "m" { modifier.clone() } else { cube.clone() })
        })
        .unwrap();
        assert_valid(&r);
        r
    };
    let same = run_with(json!({}));
    let mixed = run_with(json!({"wall_loops": 5, "sparse_infill_density": 60}));
    // The box is 40 mm wide; the modifier covers its right half (x > 100).
    let count = |r: &SliceRun, right: bool, feature: &str| {
        features_by_layer(&text(r))
            .into_iter()
            .filter(|m| m.1 == feature && (m.2 > 100.5) == right)
            .count()
    };
    // Five walls and 60 percent infill on the right half use clearly more material.
    let mm = |r: &SliceRun| r.report.stats.filament_mm[0];
    assert!(
        mm(&mixed) > mm(&same) * 1.25,
        "{} against {}",
        mm(&mixed),
        mm(&same)
    );
    assert!(count(&mixed, true, "Sparse infill") > count(&same, true, "Sparse infill") * 2);
    assert!(count(&mixed, true, "Inner wall") > count(&same, true, "Inner wall"));
    // The left half keeps its settings.
    let (a, b) = (
        count(&mixed, false, "Sparse infill"),
        count(&same, false, "Sparse infill"),
    );
    // Moves are counted, and the lines of a shared region run on across the modifier boundary.
    assert!(a.abs_diff(b) * 3 <= b.max(1), "{a} against {b}");
}

#[test]
fn ensure_vertical_shell_thickness_adds_solid_infill_beside_slopes_only() {
    let solid = |r: &SliceRun| {
        let g = text(r);
        g.split(sx_core::extras::layer_mark(&g))
            .map(|l| {
                let mut on = false;
                let mut n = 0usize;
                for line in l.lines() {
                    if let Some(t) = line.strip_prefix(";TYPE:") {
                        on = t == "Internal solid infill";
                    } else if on && line.starts_with("G1 X") && line.contains(" E") {
                        n += 1;
                    }
                }
                n
            })
            .sum::<usize>()
    };
    let cfg = |mode: &str| json!({"brim_width": 0, "ensure_vertical_shell_thickness": mode});
    // A flare: every layer hangs over the one below, so the shell beside the slope needs more solid.
    let none = solid(&frustum_run(43.0, cfg("none")));
    let all = solid(&frustum_run(43.0, cfg("ensure_all")));
    assert!(all > none + none / 10, "{all} against {none}");
    // The moderate mode carries a slope's shell on past layers that find no internal area to turn solid,
    // which the critical-only mode stops at.
    let moderate = solid(&frustum_run(43.0, cfg("ensure_moderate")));
    let critical = solid(&frustum_run(43.0, cfg("ensure_critical_only")));
    assert!(moderate > critical, "{moderate} against {critical}");
    // A straight box has no slope: the same solid layers either way.
    let boxy = |mode: &str| {
        let mesh = Arc::new(one_box([0.0, 30.0], [0.0, 30.0], [0.0, 10.0]));
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "b"}]},
            "config": cfg(mode),
        }))
        .unwrap();
        let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
        assert_valid(&r);
        solid(&r)
    };
    assert_eq!(boxy("none"), boxy("ensure_all"));
}

#[test]
fn grid_style_supports_stretch_to_a_grid_and_snug_ones_do_not() {
    let run_style = |style: &str| {
        let mesh = Arc::new(table());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": {"enable_support": true, "support_style": style, "brim_width": 0},
        }))
        .unwrap();
        let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    // The table is 20 mm deep (y 100 to 120 on the bed): snug support stays inside it, grid support
    // reaches past it by up to a cell.
    let y_range = |g: &str| {
        let mut on = false;
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        let mut z = 0.0;
        for l in g.lines() {
            if let Some(v) = l.strip_prefix(";Z:") {
                z = v.parse::<f64>().unwrap();
            } else if let Some(t) = l.strip_prefix(";TYPE:") {
                on = t.starts_with("Support");
            } else if on
                && z > 2.0
                && z < 8.0
                && l.starts_with("G1 X")
                && l.contains(" E")
                && let Some(y) = l
                    .split_whitespace()
                    .find_map(|w| w.strip_prefix('Y'))
                    .and_then(|v| v.parse::<f64>().ok())
            {
                lo = lo.min(y);
                hi = hi.max(y);
            }
        }
        (lo, hi)
    };
    let (snug_lo, snug_hi) = y_range(&run_style("snug"));
    let (grid_lo, grid_hi) = y_range(&run_style("grid"));
    assert!(snug_lo > 100.0 && snug_hi < 120.0, "{snug_lo} {snug_hi}");
    assert!(grid_lo < 99.0 && grid_hi > 121.0, "{grid_lo} {grid_hi}");
}

#[test]
fn lightning_infill_uses_far_less_material_than_a_pattern_over_the_whole_area() {
    let run_pattern = |pattern: &str| {
        let mesh = Arc::new(one_box([-20.0, 20.0], [-20.0, 20.0], [0.0, 20.0]));
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "b"}]},
            "config": {"sparse_infill_pattern": pattern, "sparse_infill_density": 15, "brim_width": 0},
        }))
        .unwrap();
        let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
        assert_valid(&r);
        assert!(
            r.report
                .warnings
                .iter()
                .all(|w| !w.message.contains("not available")),
            "{:?}",
            r.report.warnings
        );
        r
    };
    let sparse_moves = |r: &SliceRun| {
        features_by_layer(&text(r))
            .into_iter()
            .filter(|m| m.1 == "Sparse infill")
            .count()
    };
    let (light, rect) = (run_pattern("lightning"), run_pattern("rectilinear"));
    assert!(sparse_moves(&light) > 0);
    assert!(light.report.stats.filament_mm[0] < rect.report.stats.filament_mm[0] * 0.85);
    // Trees hold up the top shell: sparse infill reaches the layers just under it.
    let layers = layer_zs(&text(&light));
    let last_infill_z = features_by_layer(&text(&light))
        .into_iter()
        .filter(|m| m.1 == "Sparse infill")
        .map(|m| m.0)
        .fold(0.0, f64::max);
    assert!(last_infill_z > layers[layers.len() - 1] - 1.3, "{last_infill_z}");
}

#[test]
fn adaptive_cubic_infill_is_denser_near_the_surface_than_in_the_middle() {
    let mesh = Arc::new(one_box([-30.0, 30.0], [-30.0, 30.0], [0.0, 30.0]));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "b", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": {"sparse_infill_pattern": "adaptivecubic", "sparse_infill_density": 15, "brim_width": 0},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&r);
    assert!(
        r.report
            .warnings
            .iter()
            .all(|w| !w.message.contains("not available")),
        "{:?}",
        r.report.warnings
    );
    let g = text(&r);
    // Extruded length of sparse infill by distance from the nearest side of the box.
    let (mut near, mut middle) = (0.0f64, 0.0f64);
    let (mut on, mut last): (bool, Option<(f64, f64)>) = (false, None);
    for l in g.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            on = t == "Sparse infill";
            last = None;
        } else if l.starts_with("G0 X") || l.starts_with("G1 X") {
            let c = |a: char| {
                l.split_whitespace()
                    .find_map(|w| w.strip_prefix(a))
                    .and_then(|v| v.parse::<f64>().ok())
            };
            if let (Some(x), Some(y)) = (c('X'), c('Y')) {
                if on
                    && l.starts_with("G1")
                    && l.contains(" E")
                    && let Some((px, py)) = last
                {
                    let len = (x - px).hypot(y - py);
                    let d = (x - 100.0).abs().max((y - 100.0).abs());
                    if d > 18.0 {
                        near += len;
                    } else if d < 10.0 {
                        middle += len;
                    }
                }
                last = Some((x, y));
            }
        }
    }
    // The near band is 12 mm wide all round (1584 mm2 of the 3600), the middle is 20 x 20 (400 mm2).
    let (near_density, middle_density) = (near / 1584.0, middle / 400.0);
    assert!(
        near_density > middle_density * 1.3,
        "{near_density} against {middle_density}"
    );
}

/// A branch angle of 0 is in the setting's range; the slow angle was clamped to a range that ends below 0
/// (`f64::clamp` panics on that), so the slice crashed.
#[test]
fn organic_trees_take_a_branch_angle_of_zero() {
    let mesh = Arc::new(table());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": {"enable_support": true, "support_type": "tree(auto)", "support_style": "organic",
            "tree_support_branch_angle_organic": 0},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone()));
    assert!(r.is_ok(), "{:?}", r.err());
}

#[test]
fn painted_supports_ask_for_support_and_keep_it_out() {
    // The table's slab underside, painted over the middle of the gap (x 10 to 30, y 2 to 18 in object space).
    let painted = |state: u8| {
        let mut t = table();
        let tri = |a: [f32; 3], b: [f32; 3], c: [f32; 3]| sx_core::paint::PaintFacet { v: [a, b, c], state };
        if let Some(slab) = t.parts.iter_mut().find(|p| p.name == "slab") {
            // Seen from below the underside is wound clockwise from above: facing down.
            slab.support_paint = vec![
                tri([10.0, 2.0, 10.0], [10.0, 18.0, 10.0], [30.0, 18.0, 10.0]),
                tri([10.0, 2.0, 10.0], [30.0, 18.0, 10.0], [30.0, 2.0, 10.0]),
            ];
        }
        t
    };
    let run_with = |mesh: Mesh, config: Value| {
        let mesh = Arc::new(mesh);
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": config,
        }))
        .unwrap();
        let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    let support = |g: &str| g.contains(";TYPE:Support");
    // Manual supports come only from the paint.
    let manual = json!({"enable_support": true, "support_type": "normal(manual)", "support_style": "snug", "brim_width": 0});
    assert!(!support(&run_with(table(), manual.clone())));
    let g = run_with(painted(1), manual);
    assert!(support(&g));
    let xs: Vec<f64> = features_by_layer(&g)
        .into_iter()
        .filter(|m| m.1.starts_with("Support") && m.0 > 0.25)
        .map(|m| m.2)
        .collect();
    assert!(
        xs.iter().all(|x| *x > 109.5 && *x < 130.5),
        "painted middle only: {xs:?}"
    );
    // Automatic supports keep out of a blocked area.
    let auto = json!({"enable_support": true, "support_style": "snug", "brim_width": 0});
    let blocked = run_with(painted(2), auto.clone());
    let free = run_with(table(), auto);
    // Length of support extrusion in the painted band (y 103 to 117 on the bed).
    let inside = |g: &str| {
        let (mut on, mut z, mut len) = (false, 0.0f64, 0.0f64);
        let mut last: Option<(f64, f64)> = None;
        for l in g.lines() {
            if let Some(v) = l.strip_prefix(";Z:") {
                z = v.parse().unwrap();
            } else if let Some(t) = l.strip_prefix(";TYPE:") {
                on = t.starts_with("Support");
            } else if l.starts_with("G0 X") || l.starts_with("G1 X") {
                let c = |a: char| {
                    l.split_whitespace()
                        .find_map(|w| w.strip_prefix(a))
                        .and_then(|v| v.parse::<f64>().ok())
                };
                if let (Some(x), Some(y)) = (c('X'), c('Y')) {
                    if on
                        && z > 0.25
                        && l.starts_with("G1")
                        && l.contains(" E")
                        && let Some((px, py)) = last
                        && (103.0..117.0).contains(&y)
                        && (103.0..117.0).contains(&py)
                    {
                        len += (x - px).hypot(y - py);
                    }
                    last = Some((x, y));
                }
            }
        }
        len
    };
    assert!(inside(&free) > 200.0, "{}", inside(&free));
    assert!(
        inside(&blocked) * 2.0 < inside(&free),
        "{} against {}",
        inside(&blocked),
        inside(&free)
    );
}

#[test]
fn bottom_interface_layers_turn_the_support_that_rests_on_the_part_into_interface() {
    let mesh = Arc::new(Mesh {
        name: "mushroom".into(),
        parts: vec![
            cuboid([0.0, 40.0], [0.0, 20.0], [0.0, 3.0], "slab"),
            cuboid([15.0, 25.0], [0.0, 20.0], [3.0, 13.0], "pillar"),
            cuboid([0.0, 40.0], [0.0, 20.0], [13.0, 15.0], "cap"),
        ],
    });
    let interface_at = |bottom: u32| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "m"}]},
            "config": {"enable_support": true, "support_style": "snug", "support_interface_bottom_layers": bottom, "brim_width": 0},
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        features_by_layer(&text(&r))
            .into_iter()
            .filter(|m| m.1 == "Support interface" && m.0 < 4.5)
            .count()
    };
    // The support standing on the slab (from z = 3.4) prints as interface for the contact layer and the layers set.
    assert_eq!(interface_at(0), 0);
    let (one, three) = (interface_at(1), interface_at(3));
    assert!(one > 0 && three > one * 3 / 2, "{one} and {three}");
}

#[test]
fn a_tower_is_skipped_when_tools_only_change_between_layers() {
    // A lower and an upper block in two filaments: the one change happens between layers.
    let mesh = Arc::new(Mesh {
        name: "stack".into(),
        parts: vec![
            cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 3.0], "lo"),
            cuboid([0.0, 20.0], [0.0, 20.0], [3.0, 6.0], "hi"),
        ],
    });
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0, "enable_prime_tower": true, "prime_volume": 5, "wipe_tower_y": 20, "prime_tower_auto_position": false});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "s", "slotOverrides": {"hi": 2}}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        r
    };
    let always = run(json!({"prime_tower_always": true}));
    let lean = run(json!({}));
    assert!(tower_mm(&text(&always)) > 0.0);
    assert_eq!(tower_mm(&text(&lean)), 0.0);
    assert_eq!(lean.report.stats.tool_changes, 1);
    assert_eq!(always.report.stats.tool_changes, 1);
}

#[test]
fn a_change_between_layers_keeps_the_tower_when_the_infill_cannot_take_the_flush() {
    let mesh = Arc::new(Mesh {
        name: "stack".into(),
        parts: vec![
            cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 3.0], "lo"),
            cuboid([0.0, 20.0], [0.0, 20.0], [3.0, 6.0], "hi"),
        ],
    });
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0, "enable_prime_tower": true, "prime_volume": 5, "wipe_tower_y": 20, "prime_tower_auto_position": false});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "s", "slotOverrides": {"hi": 2}}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        r
    };
    // With infill to take the flush the tower is skipped; with none, or a flush far bigger than the
    // infill holds, the tower stays so the purge is never short.
    assert_eq!(tower_mm(&text(&run(json!({})))), 0.0);
    let hollow = tower_mm(&text(&run(json!({"sparse_infill_density": 0}))));
    let big = tower_mm(&text(&run(json!({"prime_volume": 400}))));
    assert!(hollow > 0.0, "{hollow}");
    // Right at the boundary: the infill of a 20 mm layer holds about 10 mm3, and the room must beat the
    // flush (with the purge rows' tenth extra) by a quarter. 6 mm3 clears it, 9 mm3 does not.
    assert_eq!(tower_mm(&text(&run(json!({"prime_volume": 6})))), 0.0);
    assert!(tower_mm(&text(&run(json!({"prime_volume": 9})))) > 0.0);
    assert!(big > 0.0, "{big}");
}

/// Y of where each outer wall loop starts (the point before its first extrusion).
fn outer_wall_start_ys(g: &str) -> Vec<f64> {
    let (mut at, mut on, mut pending) = (f64::NAN, false, true);
    let mut out = Vec::new();
    for l in g.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            on = t.starts_with("Outer wall");
            pending = true;
        } else if l.starts_with("G0 ") || l.starts_with("G1 ") {
            let y = l
                .split_whitespace()
                .find_map(|w| w.strip_prefix('Y'))
                .and_then(|v| v.parse::<f64>().ok());
            if on && pending && l.contains(" E") && l.starts_with("G1 X") {
                out.push(at);
                pending = false;
            }
            if let Some(y) = y {
                at = y;
            }
        }
    }
    out
}

/// X extent of the outer wall in one layer of the G-code, mm.
fn outer_wall_width(g: &str, layer: usize) -> f64 {
    let (mut on, mut lo, mut hi) = (false, f64::MAX, f64::MIN);
    for l in g
        .split(sx_core::extras::layer_mark(g))
        .nth(layer + 1)
        .unwrap_or("")
        .lines()
    {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            on = t == "Outer wall";
        } else if on
            && l.starts_with("G1 X")
            && let Some(x) = l
                .split_whitespace()
                .find_map(|w| w.strip_prefix('X'))
                .and_then(|v| v.parse::<f64>().ok())
        {
            lo = lo.min(x);
            hi = hi.max(x);
        }
    }
    hi - lo
}

#[test]
fn the_filament_volumetric_limit_caps_the_speeds() {
    let cube = Arc::new(one_box([0.0, 30.0], [0.0, 30.0], [0.0, 2.0]));
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0, "wall_loops": 2, "outer_wall_speed": 200, "inner_wall_speed": 300,
                             "slow_down_for_layer_cooling": false});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let c = cube.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    let feeds = |g: &str, feature: &str| -> std::collections::BTreeSet<i64> {
        let layer = g.split(sx_core::extras::layer_mark(g)).nth(2).unwrap_or("");
        let mut on = false;
        let mut out = std::collections::BTreeSet::new();
        for l in layer.lines() {
            if let Some(t) = l.strip_prefix(";TYPE:") {
                on = t == feature;
            } else if on
                && l.starts_with("G1 F")
                && let Some(f) = l
                    .split_whitespace()
                    .find_map(|w| w.strip_prefix('F'))
                    .and_then(|v| v.parse::<f64>().ok())
            {
                #[allow(clippy::cast_possible_truncation, reason = "feed rates are small")]
                out.insert(f.round() as i64);
            }
        }
        out
    };
    let free = run(json!({}));
    assert_eq!(feeds(&free, "Outer wall"), [12000].into());
    // 5 mm3/s through a 0.42 mm bead on a 0.2 mm layer (0.2 x (0.42 - 0.043) = 0.0754 mm2) is 66.3 mm/s.
    let capped = run(json!({"filament_max_volumetric_speed": [5]}));
    let outer = feeds(&capped, "Outer wall");
    assert!(outer.iter().all(|f| (f - 3979).abs() <= 3), "{outer:?}");
    // The inner wall, asked for 300 mm/s, is held the same way.
    let inner = feeds(&capped, "Inner wall");
    assert!(inner.iter().all(|f| *f <= 4000), "{inner:?}");
    // A limit above what the speeds ask for changes nothing.
    assert_eq!(
        feeds(
            &run(json!({"filament_max_volumetric_speed": [100]})),
            "Outer wall"
        ),
        [12000].into()
    );
}

/// Twice the signed area the outer wall's moves sweep in a layer: positive when the loop runs counterclockwise.
fn outer_wall_turn(g: &str, layer: usize) -> f64 {
    let mut on = false;
    let mut at = (0.0_f64, 0.0_f64);
    let mut sum = 0.0;
    for l in g
        .split(sx_core::extras::layer_mark(g))
        .nth(layer + 1)
        .unwrap_or("")
        .lines()
    {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            on = t == "Outer wall" || t == "Overhang wall";
            continue;
        }
        if !(l.starts_with("G1 X") || l.starts_with("G0 X")) {
            continue;
        }
        let num = |k: char| {
            l.split_whitespace()
                .find_map(|w| w.strip_prefix(k))
                .and_then(|v| v.parse::<f64>().ok())
        };
        let (Some(x), Some(y)) = (num('X'), num('Y')) else {
            continue;
        };
        if on && l.contains(" E") {
            sum += at.0 * y - x * at.1;
        }
        at = (x, y);
    }
    sum
}

#[test]
fn overhang_reverse_turns_the_walls_of_an_odd_layer_that_overhangs() {
    // A slab whose rear half overhangs the block under it, starting on an odd layer (11).
    let mesh = Arc::new(Mesh {
        name: "ledge".into(),
        parts: vec![
            cuboid([-10.0, 10.0], [-10.0, 10.0], [0.0, 2.2], "base"),
            cuboid([-10.0, 10.0], [-10.0, 20.0], [2.2, 4.0], "slab"),
        ],
    });
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0, "wall_loops": 2});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "l", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    let plain = run(json!({}));
    let reversed = run(json!({"overhang_reverse": true}));
    let internal = run(json!({"overhang_reverse": true, "overhang_reverse_internal_only": true}));
    // Layer 11 overhangs: its outer wall runs clockwise. The layers around it keep counterclockwise.
    assert!(outer_wall_turn(&plain, 11) > 0.0);
    assert!(
        outer_wall_turn(&reversed, 11) < 0.0,
        "{}",
        outer_wall_turn(&reversed, 11)
    );
    for l in [9, 12, 13] {
        assert!(outer_wall_turn(&reversed, l) > 0.0, "layer {l}");
    }
    // With internal walls only the outer wall keeps its moves (the inner walls still turn).
    let outer_moves = |g: &str| -> String {
        let mut on = false;
        let mut out = String::new();
        for l in g
            .split(sx_core::extras::layer_mark(g))
            .nth(12)
            .unwrap_or("")
            .lines()
        {
            if let Some(t) = l.strip_prefix(";TYPE:") {
                on = t == "Outer wall";
            } else if on && l.starts_with("G1 X") {
                out.push_str(l);
                out.push('\n');
            }
        }
        out
    };
    assert_eq!(outer_moves(&internal), outer_moves(&plain));
    assert_ne!(outer_moves(&reversed), outer_moves(&plain));
    assert_ne!(
        internal.split(sx_core::extras::layer_mark(&internal)).nth(12),
        plain.split(sx_core::extras::layer_mark(&plain)).nth(12)
    );
}

#[test]
fn slow_down_layers_ramps_the_first_layers_and_skirt_speed_overrides_the_skirt() {
    let cube = Arc::new(one_box([0.0, 30.0], [0.0, 30.0], [0.0, 3.0]));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": {"brim_width": 0, "wall_loops": 1, "outer_wall_speed": 120, "initial_layer_speed": 30,
                   "slow_down_layers": 5, "slow_down_for_layer_cooling": false,
                   "skirt_loops": 1, "skirt_height": 2, "skirt_speed": 25},
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let c = cube.clone();
    let r = common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap();
    assert_valid(&r);
    let g = text(&r);
    // The feed rate in force at the first extrusion of the feature: the last F on any move before it
    // (a travel may already have set the path's feed rate, and then the path writes none).
    let feed = |layer: usize, feature: &str| -> Option<f64> {
        let l = g.split(sx_core::extras::layer_mark(&g)).nth(layer + 1)?;
        let (before, after) = l.split_once(&format!(";TYPE:{feature}\n"))?;
        let mut now = None;
        for (in_feature, x) in before
            .lines()
            .map(|x| (false, x))
            .chain(after.lines().map(|x| (true, x)))
        {
            if (x.starts_with("G0 ") || x.starts_with("G1 "))
                && let Some(v) = x.split_whitespace().find_map(|w| w.strip_prefix('F'))
            {
                now = v.parse::<f64>().ok();
            }
            if in_feature && x.starts_with("G1 X") && x.contains(" E") {
                return now;
            }
        }
        None
    };
    // Layer 0 prints at the initial layer speed; layer 1 at 30 + (120 - 30) / 5 = 48 mm/s, layer 2 at 66.
    assert_eq!(feed(0, "Outer wall"), Some(1800.0));
    assert_eq!(feed(1, "Outer wall"), Some(2880.0));
    assert_eq!(feed(2, "Outer wall"), Some(3960.0));
    // The skirt runs at its own speed on every layer it is on.
    assert_eq!(feed(0, "Skirt"), Some(1500.0));
    assert_eq!(feed(1, "Skirt"), Some(1500.0));
}

#[test]
fn small_perimeters_print_at_the_small_perimeter_speed() {
    // A 6 mm square: its loops are about 20 mm, under a 5 mm threshold times 2 pi (31 mm); a 40 mm one is not.
    let mesh = |side: f32| Arc::new(one_box([0.0, side], [0.0, side], [0.0, 2.0]));
    let run = |side: f32, extra: Value| {
        let mut cfg = json!({"brim_width": 0, "wall_loops": 2, "outer_wall_speed": 120, "inner_wall_speed": 200, "slow_down_for_layer_cooling": false});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let m = mesh(side);
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    // The wall feed rates (mm/min) written on layer 1.
    let feeds = |g: &str| -> std::collections::BTreeSet<i64> {
        let layer = g.split(sx_core::extras::layer_mark(g)).nth(2).unwrap_or("");
        let mut on = false;
        let mut out = std::collections::BTreeSet::new();
        for l in layer.lines() {
            if let Some(t) = l.strip_prefix(";TYPE:") {
                on = t == "Outer wall" || t == "Inner wall";
            } else if on
                && l.starts_with("G1 ")
                && !l.contains(" E")
                && let Some(f) = l
                    .split_whitespace()
                    .find_map(|w| w.strip_prefix('F'))
                    .and_then(|v| v.parse::<f64>().ok())
            {
                #[allow(clippy::cast_possible_truncation, reason = "feed rates are small")]
                out.insert(f.round() as i64);
            }
        }
        out
    };
    let on = json!({"small_perimeter_threshold": 5, "small_perimeter_speed": "50%"});
    // 50 percent of the 120 mm/s outer wall speed is 60 mm/s (3600 mm/min), for the inner loop as well.
    assert_eq!(feeds(&run(6.0, on.clone())), [3600].into());
    // A large part and a profile without the threshold keep the wall speeds (120 and 200 mm/s).
    assert_eq!(feeds(&run(40.0, on)), [7200, 12000].into());
    assert_eq!(feeds(&run(6.0, json!({}))), [7200, 12000].into());
}

#[test]
fn fuzzy_skin_roughens_the_chosen_walls_the_same_way_every_time() {
    let cube = Arc::new(one_box([-10.0, 10.0], [-10.0, 10.0], [0.0, 3.0]));
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0, "wall_loops": 2});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let c = cube.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    let moves = |g: &str, layer: usize, feature: &str| {
        feature_moves_per_layer(g, feature)
            .get(layer)
            .copied()
            .unwrap_or(0)
    };
    let plain = run(json!({}));
    let fuzzy =
        run(json!({"fuzzy_skin": "external", "fuzzy_skin_thickness": 0.3, "fuzzy_skin_point_distance": 0.8}));
    // An 80 mm loop at 0.8 mm: about a hundred points, against four corners.
    assert!(moves(&fuzzy, 1, "Outer wall") > 60 && moves(&plain, 1, "Outer wall") < 10);
    // Inner walls and the first layer stay smooth, and the same slice comes out twice.
    assert_eq!(moves(&fuzzy, 1, "Inner wall"), moves(&plain, 1, "Inner wall"));
    assert_eq!(moves(&fuzzy, 0, "Outer wall"), moves(&plain, 0, "Outer wall"));
    assert_eq!(
        fuzzy,
        run(json!({"fuzzy_skin": "external", "fuzzy_skin_thickness": 0.3, "fuzzy_skin_point_distance": 0.8}))
    );
    // `allwalls` roughens the inner wall too.
    let walls = run(json!({"fuzzy_skin": "allwalls"}));
    assert!(moves(&walls, 1, "Inner wall") > 60);
}

#[test]
fn object_fuzzy_skin_settings_apply_to_that_object_without_a_warning() {
    let cube = Arc::new(one_box([-10.0, 10.0], [-10.0, 10.0], [0.0, 3.0]));
    let run = |settings: Value| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "settings": settings, "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": {"brim_width": 0, "wall_loops": 2},
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let c = cube.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap();
        assert_valid(&r);
        r
    };
    let outer = |r: &SliceRun| {
        feature_moves_per_layer(&text(r), "Outer wall")
            .get(1)
            .copied()
            .unwrap_or(0)
    };
    let plain = run(json!({"wall_loops": 2}));
    let fuzzy =
        run(json!({"fuzzy_skin": "external", "fuzzy_skin_thickness": 0.3, "fuzzy_skin_point_distance": 0.8}));
    // The object's own fuzzy skin roughens its outer wall, and no setting is called unsupported.
    assert!(outer(&fuzzy) > 60 && outer(&plain) < 10);
    assert!(
        !fuzzy
            .report
            .warnings
            .iter()
            .any(|w| w.message.contains("not applied"))
    );
    // The other fuzzy skin keys reach the object too: a wider point distance makes fewer points.
    let coarse = run(json!({"fuzzy_skin": "external", "fuzzy_skin_point_distance": 2.0}));
    assert!(outer(&coarse) > 10 && outer(&coarse) < outer(&fuzzy));
    assert!(
        !coarse
            .report
            .warnings
            .iter()
            .any(|w| w.message.contains("not applied"))
    );
}

#[test]
fn every_fuzzy_noise_type_and_mode_slices_and_the_modes_change_what_the_noise_moves() {
    let cube = Arc::new(one_box([-10.0, 10.0], [-10.0, 10.0], [0.0, 3.0]));
    let run = |extra: Value| {
        let mut cfg = json!({
            "brim_width": 0, "wall_loops": 2, "fuzzy_skin": "external", "fuzzy_skin_thickness": 0.3,
            "fuzzy_skin_point_distance": 0.8,
        });
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let c = cube.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    let outer_moves = |g: &str| {
        feature_moves_per_layer(g, "Outer wall")
            .get(1)
            .copied()
            .unwrap_or(0)
    };
    let widths = |g: &str| -> std::collections::BTreeSet<String> {
        let l = g.split(sx_core::extras::layer_mark(g)).nth(2).unwrap_or("");
        let mut on = false;
        let mut out = std::collections::BTreeSet::new();
        for line in l.lines() {
            if let Some(t) = line.strip_prefix(";TYPE:") {
                on = t == "Outer wall";
            } else if on && let Some(w) = line.strip_prefix(";WIDTH:") {
                out.insert(w.to_string());
            }
        }
        out
    };
    for generator in ["classic", "arachne"] {
        for noise in ["classic", "perlin", "billow", "ridgedmulti", "voronoi", "ripple"] {
            let g = run(json!({"wall_generator": generator, "fuzzy_skin_noise_type": noise}));
            assert!(outer_moves(&g) > 60, "{generator} {noise}: {}", outer_moves(&g));
            assert_eq!(
                g,
                run(json!({"wall_generator": generator, "fuzzy_skin_noise_type": noise}))
            );
        }
    }
    let base = json!({"wall_generator": "arachne", "fuzzy_skin_noise_type": "perlin"});
    let with_mode = |m: &str| {
        let mut c = base.clone();
        c["fuzzy_skin_mode"] = json!(m);
        run(c)
    };
    let (disp, ext, comb) = (
        with_mode("displacement"),
        with_mode("extrusion"),
        with_mode("combined"),
    );
    assert!(widths(&disp).len() <= 2, "{:?}", widths(&disp));
    assert!(widths(&ext).len() > 5, "{:?}", widths(&ext));
    assert!(widths(&comb).len() > 5);
    assert!(disp != ext && ext != comb);
}

#[test]
fn filament_shrink_scales_the_part_up_about_its_center() {
    let cube = Arc::new(one_box([-10.0, 10.0], [-10.0, 10.0], [0.0, 4.0]));
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0, "wall_loops": 2});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let c = cube.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap();
        assert_valid(&r);
        (text(&r), r)
    };
    let (plain, _) = run(json!({}));
    let (shrunk, r) = run(json!({"filament_shrink": ["98%"]}));
    // 98 percent shrinkage scales the 20 mm cube by 100/98, to 20.408 mm; the outer wall is 0.42 less.
    let (a, b) = (outer_wall_width(&plain, 1), outer_wall_width(&shrunk, 1));
    assert!(
        (a - 19.58).abs() < 0.03 && (b - (20.0 * 100.0 / 98.0 - 0.42)).abs() < 0.03,
        "{a} and {b}"
    );
    assert!(r.report.stats.filament_mm[0] > 0.0);
    // The part keeps its center.
    assert!(shrunk.contains("X100.") || shrunk.contains("X99.") || shrunk.contains("X101."));
}

#[test]
fn wall_direction_cw_turns_the_walls_round() {
    let cube = Arc::new(one_box([-10.0, 10.0], [-10.0, 10.0], [0.0, 2.0]));
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0, "wall_loops": 2});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let c = cube.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    // Signed area (twice) of the first outer wall loop of layer 1: positive counterclockwise.
    let turn = |g: &str| -> f64 {
        let mut pts: Vec<(f64, f64)> = Vec::new();
        let (mut on, mut at) = (false, (0.0_f64, 0.0_f64));
        for l in g
            .split(sx_core::extras::layer_mark(g))
            .nth(2)
            .unwrap_or("")
            .lines()
        {
            if let Some(t) = l.strip_prefix(";TYPE:") {
                on = t == "Outer wall";
                continue;
            }
            if !(l.starts_with("G1 X") || l.starts_with("G0 X")) {
                continue;
            }
            let num = |k: char| {
                l.split_whitespace()
                    .find_map(|w| w.strip_prefix(k))
                    .and_then(|v| v.parse::<f64>().ok())
            };
            let (Some(x), Some(y)) = (num('X'), num('Y')) else {
                continue;
            };
            if on && l.contains(" E") {
                if pts.is_empty() {
                    pts.push(at);
                }
                pts.push((x, y));
            }
            at = (x, y);
        }
        pts.iter()
            .zip(pts.iter().cycle().skip(1))
            .map(|(a, b)| a.0 * b.1 - b.0 * a.1)
            .sum()
    };
    assert!(turn(&run(json!({}))) > 0.0);
    assert!(turn(&run(json!({"wall_direction": "ccw"}))) > 0.0);
    assert!(turn(&run(json!({"wall_direction": "cw"}))) < 0.0);
}

#[test]
fn xy_and_elephant_foot_compensation_change_the_slice_outline() {
    let cube = Arc::new(one_box([-10.0, 10.0], [-10.0, 10.0], [0.0, 4.0]));
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0, "wall_loops": 2});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let c = cube.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    let plain = run(json!({}));
    let foot = run(json!({"elefant_foot_compensation": 0.2}));
    let grown = run(json!({"xy_contour_compensation": 0.1}));
    let shrunk = run(json!({"xy_contour_compensation": -0.1}));
    let w = |g: &str, layer: usize| outer_wall_width(g, layer);
    // The outer wall sits half a line inside the slice: 20 mm less 0.42.
    assert!((w(&plain, 0) - 19.58).abs() < 0.03 && (w(&plain, 3) - 19.58).abs() < 0.03);
    // The foot pulls the first layer in by 0.2 mm a side and leaves the others.
    assert!((w(&foot, 0) - (19.58 - 0.4)).abs() < 0.03, "{}", w(&foot, 0));
    assert!((w(&foot, 3) - 19.58).abs() < 0.03);
    // XY compensation moves every layer.
    assert!((w(&grown, 2) - 19.78).abs() < 0.03, "{}", w(&grown, 2));
    assert!((w(&shrunk, 2) - 19.38).abs() < 0.03, "{}", w(&shrunk, 2));
}

#[test]
fn an_unpainted_seam_keeps_off_a_stretch_that_hangs_over_air() {
    // A slab whose rear half overhangs the block under it: on its first layer the rear corners hang
    // free, so the seam moves to the front. Higher up the rear corners are supported again, but equal
    // corners go to the first one of the ring (Orca's order: the front left) and an aligned string stays
    // on its corner, so the seam stays at the front.
    let mesh = Arc::new(Mesh {
        name: "ledge".into(),
        parts: vec![
            cuboid([-10.0, 10.0], [-10.0, 10.0], [0.0, 2.0], "base"),
            cuboid([-10.0, 10.0], [-10.0, 20.0], [2.0, 4.0], "slab"),
        ],
    });
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "l", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": {"brim_width": 0, "seam_position": "aligned", "wall_loops": 2},
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&r);
    let g = text(&r);
    let starts_in_layer = |layer: usize| -> Vec<f64> {
        outer_wall_start_ys(
            g.split(sx_core::extras::layer_mark(&g))
                .nth(layer + 1)
                .unwrap_or(""),
        )
    };
    // Layer 10 (z 2.2) is the slab's first: its rear corners (y 120 on the plate) hang.
    let hanging = starts_in_layer(10);
    let supported = starts_in_layer(12);
    // (The loop is written in pieces where it hangs; the first one holds the seam.)
    assert!(hanging.first().is_some_and(|y| *y < 100.0), "{hanging:?}");
    assert!(supported.first().is_some_and(|y| *y < 100.0), "{supported:?}");
}

#[test]
fn a_painted_seam_enforcer_pulls_the_seam_and_a_blocker_pushes_it_away() {
    let run = |state: Option<u8>| {
        let mut mesh = one_box([-10.0, 10.0], [-10.0, 10.0], [0.0, 6.0]);
        if let Some(state) = state {
            let tri = |v: [[f32; 3]; 3]| sx_core::paint::PaintFacet { v, state };
            mesh.parts[0].seam_paint = vec![
                tri([[-10.0, -10.0, 0.0], [10.0, -10.0, 0.0], [10.0, -10.0, 6.0]]),
                tri([[-10.0, -10.0, 0.0], [10.0, -10.0, 6.0], [-10.0, -10.0, 6.0]]),
            ];
        }
        let m = Arc::new(mesh);
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "m", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": {"brim_width": 0, "seam_position": "back"},
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        outer_wall_start_ys(&text(&r))
    };
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let plain = run(None);
    let enforced = run(Some(1));
    // The bare box puts the seam at the back (y near 110); an enforcer on the front face (y 90) pulls it there.
    assert!(mean(&plain) > 108.0, "{}", mean(&plain));
    assert!(mean(&enforced) < 92.0, "{}", mean(&enforced));
    // A blocker on the back face keeps the seam off it: the plain seam sits on the rear edge.
    let mut blocked = one_box([-10.0, 10.0], [-10.0, 10.0], [0.0, 6.0]);
    let tri = |v: [[f32; 3]; 3]| sx_core::paint::PaintFacet { v, state: 2 };
    blocked.parts[0].seam_paint = vec![
        tri([[-10.0, 10.0, 0.0], [10.0, 10.0, 0.0], [10.0, 10.0, 6.0]]),
        tri([[-10.0, 10.0, 0.0], [10.0, 10.0, 6.0], [-10.0, 10.0, 6.0]]),
    ];
    let m = Arc::new(blocked);
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "m", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": {"brim_width": 0, "seam_position": "back"},
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    assert!(mean(&outer_wall_start_ys(&text(&r))) < 108.0);
}

/// Runs a 40 x 20 x 12 box whose right half (x > 100) is a modifier with `settings`.
fn half_modifier(settings: Value, config: Value) -> String {
    let cube = Arc::new(one_box([-20.0, 20.0], [-10.0, 10.0], [0.0, 12.0]));
    let modifier = Arc::new(one_box([0.0, 30.0], [-20.0, 20.0], [-1.0, 13.0]));
    let mut cfg = json!({"brim_width": 0, "wall_loops": 2, "sparse_infill_density": 15});
    cfg.as_object_mut()
        .unwrap()
        .extend(config.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{
            "mesh": "c",
            "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1],
            "volumes": [{"role": "modifier", "mesh": "m", "settings": settings}],
        }]},
        "config": cfg,
    }))
    .unwrap();
    let r = common::run_request(&req, &move |id: &str| {
        Ok(if id == "m" { modifier.clone() } else { cube.clone() })
    })
    .unwrap();
    assert_valid(&r);
    text(&r)
}

/// Extrusion moves of a feature on the right half (x > 101), with the bead width comment in force.
fn right_half_moves(g: &str, feature: &str) -> Vec<f64> {
    let (mut kind, mut width) = (String::new(), 0.0);
    let mut out = Vec::new();
    for l in g.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut kind);
        } else if let Some(v) = l.strip_prefix(";WIDTH:") {
            width = v.parse().unwrap_or(0.0);
        } else if kind == feature
            && l.starts_with("G1 X")
            && l.contains(" E")
            && l.split_whitespace()
                .find_map(|w| w.strip_prefix('X'))
                .and_then(|x| x.parse::<f64>().ok())
                .is_some_and(|x| x > 101.0)
        {
            out.push(width);
        }
    }
    out
}

#[test]
fn a_modifier_changes_shell_layers_line_width_and_infill_pattern() {
    let base = half_modifier(
        json!({}),
        json!({"top_shell_layers": 2, "bottom_shell_layers": 2}),
    );
    // More shell layers inside the modifier: a thick solid stack in the middle of its infill.
    let shells = half_modifier(
        json!({"top_shell_layers": 7, "bottom_shell_layers": 7}),
        json!({"top_shell_layers": 2, "bottom_shell_layers": 2}),
    );
    let solid = |g: &str| right_half_moves(g, "Internal solid infill").len();
    assert!(
        solid(&shells) > solid(&base) * 2 + 20,
        "{} against {}",
        solid(&shells),
        solid(&base)
    );
    // The left half keeps its two shell layers.
    let left_solid = |g: &str| {
        features_by_layer(g)
            .iter()
            .filter(|m| m.1 == "Internal solid infill" && m.2 < 100.0)
            .count()
    };
    assert!(left_solid(&shells).abs_diff(left_solid(&base)) * 5 <= left_solid(&base).max(1));
    // A wider line inside the modifier.
    let wide = half_modifier(json!({"line_width": 0.6}), json!({}));
    let widths = right_half_moves(&wide, "Inner wall");
    assert!(
        !widths.is_empty() && widths.iter().all(|w| (w - 0.6).abs() < 0.02),
        "{widths:?}"
    );
    let left: Vec<f64> = right_half_moves(&base, "Inner wall");
    assert!(left.iter().all(|w| (w - 0.42).abs() < 0.03), "{left:?}");
    // A curved infill pattern inside the modifier: many short moves where rectilinear has long lines.
    let gyroid = half_modifier(json!({"sparse_infill_pattern": "gyroid"}), json!({}));
    let plain = half_modifier(json!({}), json!({}));
    let moves = |g: &str| right_half_moves(g, "Sparse infill").len();
    assert!(
        moves(&gyroid) > moves(&plain) * 2,
        "{} against {}",
        moves(&gyroid),
        moves(&plain)
    );
}

/// A 40 mm long wedge plate 6 mm tall whose thickness grows from 0.3 to 3 mm.
fn wedge() -> Mesh {
    let mut part = cuboid([0.0, 40.0], [0.0, 3.0], [0.0, 6.0], "wedge");
    // The back corners of the quad (x = 0) move so the plate is thin at that end.
    for p in &mut part.positions {
        if p[0] == 0.0 && p[1] == 3.0 {
            p[1] = 0.3;
        }
    }
    Mesh {
        name: "wedge".into(),
        parts: vec![part],
    }
}

/// The distinct bead widths (mm, to 0.01) on the ";WIDTH:" lines of the walls.
fn wall_widths(g: &str) -> std::collections::BTreeSet<i64> {
    let (mut on, mut out) = (false, std::collections::BTreeSet::new());
    for l in g.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            on = t == "Outer wall" || t == "Inner wall";
        } else if on && let Some(v) = l.strip_prefix(";WIDTH:") {
            #[allow(clippy::cast_possible_truncation, reason = "a width in hundredths")]
            out.insert((v.parse::<f64>().unwrap_or(0.0) * 100.0).round() as i64);
        }
    }
    out
}

#[test]
fn arachne_walls_change_width_along_a_thin_wedge_and_stay_shard_invariant() {
    let mesh = Arc::new(wedge());
    let run = |generator: &str| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "w"}]},
            "config": {"wall_generator": generator, "wall_loops": 3, "brim_width": 0},
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        r
    };
    let arachne = run("arachne");
    let classic = run("classic");
    // Fixed-width walls print one width; the wedge's walls widen and narrow with the part.
    let (wa, wc) = (wall_widths(&text(&arachne)), wall_widths(&text(&classic)));
    assert!(wa.len() >= 4, "{wa:?}");
    assert!(wc.len() <= 2, "{wc:?}");
    // Thin end and thick end both get walls: the extrusion at the thin end is not dropped.
    assert!(arachne.report.stats.filament_mm[0] > 0.0);
}

/// Number of ";TYPE:" blocks of `feature` per layer, in layer order.
fn blocks_per_layer(g: &str, feature: &str) -> Vec<usize> {
    g.split(sx_core::extras::layer_mark(g))
        .skip(1)
        .map(|l| {
            l.lines()
                .filter(|x| x.strip_prefix(";TYPE:") == Some(feature))
                .count()
        })
        .collect()
}

/// Extruded length of `feature` per layer, in layer order (relative E, so only its presence matters here).
fn feature_moves_per_layer(g: &str, feature: &str) -> Vec<usize> {
    g.split(sx_core::extras::layer_mark(g))
        .skip(1)
        .map(|l| {
            let mut on = false;
            let mut n = 0;
            for line in l.lines() {
                if let Some(t) = line.strip_prefix(";TYPE:") {
                    on = t == feature;
                } else if on && line.starts_with("G1 X") && line.contains(" E") {
                    n += 1;
                }
            }
            n
        })
        .collect()
}

#[test]
fn an_alternate_extra_wall_and_one_wall_on_top_change_the_wall_count() {
    let cube = Arc::new(one_box([-10.0, 10.0], [-10.0, 10.0], [0.0, 4.0]));
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0, "wall_loops": 2, "sparse_infill_density": 15});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let c = cube.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    let plain = feature_moves_per_layer(&run(json!({})), "Inner wall");
    let alternating = feature_moves_per_layer(&run(json!({"alternate_extra_wall": true})), "Inner wall");
    // Layers 1 and 3 (the second and fourth) get a third wall.
    assert!(alternating.get(1) > plain.get(1) && alternating.get(3) > plain.get(3));
    assert_eq!(alternating.first(), plain.first());
    assert_eq!(alternating.get(2), plain.get(2));
    let top = feature_moves_per_layer(
        &run(json!({"only_one_wall_top": true, "wall_loops": 3})),
        "Inner wall",
    );
    let last = top.len() - 1;
    // The topmost layer has no inner wall, the one below it does.
    assert_eq!(top.get(last), Some(&0));
    assert!(top.get(last - 1).copied().unwrap_or(0) > 0);
    assert_eq!(blocks_per_layer(&run(json!({})), "Outer wall").len(), plain.len());
}

#[test]
fn only_one_wall_top_with_arachne_thins_the_walls_under_an_exposed_top_surface() {
    // A 30 mm square 2 mm tall with a 10 mm block on it: the ring around the block is a top surface.
    let mesh = Arc::new(Mesh {
        name: "step".into(),
        parts: vec![
            cuboid([-15.0, 15.0], [-15.0, 15.0], [0.0, 2.0], "base"),
            cuboid([-5.0, 5.0], [-5.0, 5.0], [2.0, 4.0], "block"),
        ],
    });
    let run = |one_wall: bool| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "s", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": {"wall_generator": "arachne", "wall_loops": 3, "brim_width": 0,
                       "only_one_wall_top": one_wall, "sparse_infill_density": 15},
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    let (off, on) = (run(false), run(true));
    // Printed length of the inner walls in one layer.
    let length = |g: &str, layer: usize| -> f64 {
        let (mut on, mut at, mut total) = (false, None::<(f64, f64)>, 0.0);
        for l in g
            .split(sx_core::extras::layer_mark(g))
            .nth(layer + 1)
            .unwrap_or("")
            .lines()
        {
            if let Some(t) = l.strip_prefix(";TYPE:") {
                on = t == "Inner wall";
            }
            if l.starts_with("G1 X") || l.starts_with("G0 X") {
                let num = |k: char| {
                    l.split_whitespace()
                        .find_map(|w| w.strip_prefix(k))
                        .and_then(|v| v.parse::<f64>().ok())
                };
                if let (Some(x), Some(y)) = (num('X'), num('Y')) {
                    if let Some((px, py)) = at
                        && on
                        && l.contains(" E")
                    {
                        total += (x - px).hypot(y - py);
                    }
                    at = Some((x, y));
                }
            }
        }
        total
    };
    // Layer 9 is the last of the base: its exposed ring keeps one wall, so the inner walls shrink to
    // the block's footprint. Layers away from the top surface are untouched.
    let (a9, b9) = (length(&off, 9), length(&on, 9));
    assert!(b9 < a9 * 0.6, "{b9} against {a9}");
    assert!((length(&off, 4) - length(&on, 4)).abs() < 1e-6);
}

#[test]
fn feature_line_widths_and_the_first_layer_width_reach_the_beads() {
    let cube = Arc::new(one_box([-10.0, 10.0], [-10.0, 10.0], [0.0, 3.0]));
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": {
            "brim_width": 0, "wall_loops": 2, "line_width": 0.42,
            "outer_wall_line_width": 0.42, "inner_wall_line_width": 0.45,
            "sparse_infill_line_width": 0.48, "internal_solid_infill_line_width": 0.44,
            "top_surface_line_width": 0.40, "initial_layer_line_width": 0.5,
        },
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(cube.clone())).unwrap();
    assert_valid(&r);
    let g = text(&r);
    let widths = |feature: &str, layer: usize| -> std::collections::BTreeSet<i64> {
        let mut out = std::collections::BTreeSet::new();
        let (mut on, mut w) = (false, 0.0);
        for l in g
            .split(sx_core::extras::layer_mark(&g))
            .nth(layer + 1)
            .unwrap_or("")
            .lines()
        {
            if let Some(t) = l.strip_prefix(";TYPE:") {
                on = t == feature;
            } else if let Some(v) = l.strip_prefix(";WIDTH:") {
                w = v.parse::<f64>().unwrap_or(0.0);
                if on {
                    #[allow(clippy::cast_possible_truncation, reason = "hundredths")]
                    out.insert((w * 100.0).round() as i64);
                }
            } else if on && l.starts_with("G1 X") && l.contains(" E") {
                #[allow(clippy::cast_possible_truncation, reason = "hundredths")]
                out.insert((w * 100.0).round() as i64);
            }
        }
        out
    };
    // The first layer prints everything at 0.5; later layers use each feature's own width.
    assert_eq!(widths("Outer wall", 0), [50].into());
    assert_eq!(widths("Inner wall", 0), [50].into());
    assert_eq!(widths("Outer wall", 5), [42].into());
    assert_eq!(widths("Inner wall", 5), [45].into());
}

/// Extruded filament (relative E) of one feature over the whole file.
fn feature_extrusion(g: &str, feature: &str) -> f64 {
    let (mut on, mut total) = (false, 0.0);
    for l in g.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            on = t == feature;
        } else if on
            && l.starts_with("G1 X")
            && let Some(e) = l.split_whitespace().find_map(|w| w.strip_prefix('E'))
        {
            total += e.parse::<f64>().unwrap_or(0.0).max(0.0);
        }
    }
    total
}

#[test]
fn flow_ratios_scale_the_extrusion_of_their_role() {
    let cube = Arc::new(one_box([-10.0, 10.0], [-10.0, 10.0], [0.0, 3.0]));
    let run = |extra: Value| {
        let mut cfg = json!({"brim_width": 0});
        cfg.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": cfg,
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let c = cube.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(c.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    let plain = run(json!({}));
    let top = run(json!({"top_solid_infill_flow_ratio": 0.9}));
    let ratio = feature_extrusion(&top, "Top surface") / feature_extrusion(&plain, "Top surface");
    assert!((ratio - 0.9).abs() < 0.01, "{ratio}");
    assert!((feature_extrusion(&top, "Outer wall") - feature_extrusion(&plain, "Outer wall")).abs() < 1e-6);
    // The per-role ratios wait for `set_other_flow_ratios`, and the first layer ratio goes with them.
    let off = run(json!({"outer_wall_flow_ratio": 0.8}));
    assert!((feature_extrusion(&off, "Outer wall") - feature_extrusion(&plain, "Outer wall")).abs() < 1e-6);
    let on = run(
        json!({"set_other_flow_ratios": true, "outer_wall_flow_ratio": 0.8, "first_layer_flow_ratio": 0.5}),
    );
    assert!(feature_extrusion(&on, "Outer wall") < 0.8 * feature_extrusion(&plain, "Outer wall"));
    assert!(
        feature_extrusion(&on, "Outer wall") > 0.75 * 0.8 * feature_extrusion(&plain, "Outer wall") * 0.9
    );
    let print = run(json!({"print_flow_ratio": 0.95}));
    let r = feature_extrusion(&print, "Inner wall") / feature_extrusion(&plain, "Inner wall");
    assert!((r - 0.95).abs() < 0.005, "{r}");
}

#[test]
fn a_part_with_settings_of_its_own_prints_its_area_with_them() {
    let mesh = Arc::new(Mesh {
        name: "pair".into(),
        parts: vec![
            cuboid([-30.0, -10.0], [-10.0, 10.0], [0.0, 4.0], "left"),
            cuboid([10.0, 30.0], [-10.0, 10.0], [0.0, 4.0], "right"),
        ],
    });
    let run = |part_settings: Value| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{
                "mesh": "p",
                "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1],
                "partSettings": part_settings,
            }]},
            "config": {"brim_width": 0, "wall_loops": 2},
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let m = mesh.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        text(&r)
    };
    let inner = |g: &str, right: bool| {
        features_by_layer(g)
            .into_iter()
            .filter(|m| m.1 == "Inner wall" && (m.2 > 100.0) == right)
            .count()
    };
    let (plain, mixed) = (run(json!({})), run(json!({"right": {"wall_loops": 5}})));
    // Five walls on the right part means four inner ones instead of one.
    assert!(
        inner(&mixed, true) > inner(&plain, true) * 2,
        "{} {}",
        inner(&mixed, true),
        inner(&plain, true)
    );
    // The left part keeps its two walls.
    let (a, b) = (inner(&mixed, false), inner(&plain, false));
    assert!(a.abs_diff(b) * 4 <= b, "{a} against {b}");
}

fn vase_run(config: Value) -> String {
    let mesh = Arc::new(Mesh {
        name: "block".into(),
        parts: vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 4.0], "block")],
    });
    let mut cfg = json!({
        "spiral_mode": true, "brim_width": 0, "skirt_loops": 0, "bottom_shell_layers": 2,
        "layer_height": 0.2, "initial_layer_print_height": 0.2, "use_relative_e_distances": true,
        "wall_loops": 3, "sparse_infill_density": 20, "top_shell_layers": 4,
    });
    cfg.as_object_mut()
        .unwrap()
        .extend(config.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "b", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": cfg,
    }))
    .unwrap();
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&run);
    text(&run)
}

fn field(l: &str, k: char) -> Option<f64> {
    l.split_whitespace()
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

#[test]
fn spiral_mode_climbs_along_one_wall_above_a_solid_base() {
    let g = vase_run(json!({}));
    let layers: Vec<&str> = g.split(sx_core::extras::layer_mark(&g)).skip(1).collect();
    assert_eq!(layers.len(), 20);
    // The base: two solid layers, the second a top surface.
    for (i, l) in layers.iter().take(2).enumerate() {
        assert!(
            l.contains(";TYPE:Bottom surface") || l.contains(";TYPE:Top surface") || l.contains("solid"),
            "layer {i}"
        );
        assert!(!l.contains("Sparse infill"), "layer {i}");
    }
    assert!(layers[1].contains(";TYPE:Top surface"));
    for (i, l) in layers.iter().enumerate().skip(2) {
        let types: Vec<&str> = l.lines().filter_map(|x| x.strip_prefix(";TYPE:")).collect();
        assert_eq!(types, ["Outer wall"], "layer {i}");
        let z_top = field(
            l.lines()
                .find(|x| x.starts_with(";Z:"))
                .map(|x| x.replace(";Z:", "Z"))
                .unwrap()
                .as_str(),
            'Z',
        )
        .unwrap();
        let moves: Vec<&str> = l.lines().filter(|x| x.starts_with("G1 X")).collect();
        assert!(moves.iter().all(|m| m.contains(" Z")), "layer {i}");
        let zs: Vec<f64> = moves.iter().filter_map(|m| field(m, 'Z')).collect();
        assert!(zs.windows(2).all(|w| w[1] >= w[0] - 1e-9), "layer {i} z falls");
        assert!(
            zs[0] >= z_top - 0.2 - 1e-9 && (zs.last().unwrap() - z_top).abs() < 0.0011,
            "layer {i}: {zs:?}"
        );
        if i > 2 && i < 19 {
            // No travel and no retraction: the loop goes on from where the layer below ended.
            assert!(!l.contains("G0 "), "layer {i} travels");
            assert!(!l.contains("E-"), "layer {i} retracts");
        }
    }
    // The first spiral layer ramps the flow up from nothing; the last loop is repeated at constant Z
    // with the flow ramping down to nothing.
    let first = layers[2].lines().find(|x| x.starts_with("G1 X")).unwrap();
    // The first side of the square (a quarter of the loop) carries a quarter of the full bead, 0.61 mm of
    // filament for the whole loop.
    assert!(field(first, 'E').unwrap() < 0.2, "{first}");
    let last: Vec<&str> = layers[19].lines().filter(|x| x.starts_with("G1 X")).collect();
    let flat: Vec<&str> = last
        .iter()
        .copied()
        .filter(|m| field(m, 'Z') == Some(4.0))
        .collect();
    assert!(flat.len() > last.len() / 3, "no repeated loop");
    assert!(field(flat.last().unwrap(), 'E').unwrap() < 0.01);
}

#[test]
fn spiral_mode_keeps_the_base_layers_and_ignores_walls_and_infill_settings() {
    let a = vase_run(json!({"wall_loops": 1, "sparse_infill_density": 0, "top_shell_layers": 0}));
    let b = vase_run(json!({"wall_loops": 4, "sparse_infill_density": 50, "top_shell_layers": 6}));
    assert_eq!(
        without_totals(&a)
            .lines()
            .filter(|l| !l.starts_with("; "))
            .count(),
        without_totals(&b)
            .lines()
            .filter(|l| !l.starts_with("; "))
            .count()
    );
    let c = vase_run(json!({"bottom_shell_layers": 4}));
    let layers: Vec<&str> = c.split(sx_core::extras::layer_mark(&c)).skip(1).collect();
    assert!(layers[3].contains(";TYPE:Top surface"));
    assert!(layers[4].contains('Z') && !layers[4].contains(";TYPE:Top surface"));
}

#[test]
fn smooth_spiral_blends_xy_with_the_loop_below() {
    let cfg = |smooth: bool| {
        json!({
            "spiral_mode": true, "spiral_mode_smooth": smooth, "brim_width": 0, "skirt_loops": 0,
            "bottom_shell_layers": 2, "layer_height": 0.2, "initial_layer_print_height": 0.2,
            "use_relative_e_distances": true,
        })
    };
    let moves = |g: &str| -> Vec<(f64, f64)> {
        g.lines()
            .filter(|l| l.starts_with("G1 X") && l.contains(" Z"))
            .map(|l| (field(l, 'X').unwrap(), field(l, 'Y').unwrap()))
            .collect()
    };
    let plain = text(&frustum_run(16.0, cfg(false)));
    let smooth = text(&frustum_run(16.0, cfg(true)));
    let (a, b) = (moves(&plain), moves(&smooth));
    assert!(!a.is_empty() && !b.is_empty());
    assert_ne!(a, b, "smoothing changed nothing");
    // A straight wall has nothing to blend.
    let straight = |s: bool| text(&frustum_run(10.0, cfg(s)));
    assert_eq!(moves(&straight(false)), moves(&straight(true)));
    // The blend stays within the footprint the plain loops cover.
    let span = |v: &[(f64, f64)], f: fn(&(f64, f64)) -> f64| {
        v.iter()
            .map(f)
            .fold((f64::MAX, f64::MIN), |(lo, hi), x| (lo.min(x), hi.max(x)))
    };
    for f in [(|p: &(f64, f64)| p.0) as fn(&(f64, f64)) -> f64, |p| p.1] {
        let (plain_lo, plain_hi) = span(&a, f);
        let (lo, hi) = span(&b, f);
        assert!(
            lo >= plain_lo - 0.01 && hi <= plain_hi + 0.01,
            "{lo} {hi} outside {plain_lo} {plain_hi}"
        );
    }
}

/// Where the brim of the first layer is, as the bounding boxes of its loops, for a 20 mm block at 100, 100.
fn brim_boxes(config: Value, extra: Value) -> Vec<[f64; 4]> {
    let mesh = Arc::new(Mesh {
        name: "block".into(),
        parts: vec![cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 4.0], "block")],
    });
    brim_boxes_of(mesh, config, extra)
}

/// [`brim_boxes`] for any mesh.
fn brim_boxes_of(mesh: Arc<Mesh>, config: Value, extra: Value) -> Vec<[f64; 4]> {
    let mut object = json!({"mesh": "b", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]});
    object
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let mut cfg = json!({"skirt_loops": 0, "layer_height": 0.2, "initial_layer_print_height": 0.2});
    cfg.as_object_mut()
        .unwrap()
        .extend(config.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [object]},
        "config": cfg,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&run);
    let g = text(&run);
    let first = g.split(sx_core::extras::layer_mark(&g)).nth(1).unwrap_or("");
    let (mut out, mut cur): (Vec<[f64; 4]>, Option<[f64; 4]>) = (Vec::new(), None);
    let mut in_brim = false;
    let mut pos = (0.0, 0.0);
    for l in first.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            in_brim = t == "Brim";
            if let Some(b) = cur.take() {
                out.push(b);
            }
        } else if (l.starts_with("G1 ") || l.starts_with("G0 ")) && (l.contains(" X") || l.contains(" Y")) {
            let (x, y) = (field(l, 'X').unwrap_or(pos.0), field(l, 'Y').unwrap_or(pos.1));
            if in_brim && l.contains(" E") && !l.contains(" E-") {
                let b = cur.get_or_insert([pos.0, pos.1, pos.0, pos.1]);
                for (px, py) in [pos, (x, y)] {
                    b[0] = b[0].min(px);
                    b[1] = b[1].min(py);
                    b[2] = b[2].max(px);
                    b[3] = b[3].max(py);
                }
            } else if let Some(b) = cur.take() {
                out.push(b);
            }
            pos = (x, y);
        }
    }
    if let Some(b) = cur {
        out.push(b);
    }
    out
}

#[test]
fn mouse_ears_sit_at_the_corners_only() {
    let boxes = brim_boxes(json!({"brim_type": "brim_ears", "brim_width": 5}), json!({}));
    assert!(!boxes.is_empty());
    // Every loop lies at one of the four corners of the block (100..120).
    for b in &boxes {
        let (cx, cy) = (f64::midpoint(b[0], b[2]), f64::midpoint(b[1], b[3]));
        assert!(
            ([100.0, 120.0].iter().any(|v| (cx - v).abs() < 4.5))
                && ([100.0, 120.0].iter().any(|v| (cy - v).abs() < 4.5)),
            "{b:?}"
        );
        assert!(b[2] - b[0] < 9.0 && b[3] - b[1] < 9.0, "{b:?}");
    }
    let corners = [(100.0, 100.0), (120.0, 100.0), (100.0, 120.0), (120.0, 120.0)];
    for (x, y) in corners {
        assert!(
            boxes.iter().any(|b| (f64::midpoint(b[0], b[2]) - x).abs() < 4.5
                && (f64::midpoint(b[1], b[3]) - y).abs() < 4.5),
            "no ear at {x} {y}"
        );
    }
    // No brim beside the middle of an edge.
    assert!(boxes.iter().all(|b| !(b[0] < 108.0 && b[2] > 112.0)), "{boxes:?}");
}

#[test]
fn painted_ears_print_only_where_the_model_carries_them() {
    // One ear at the front left corner and one in the air (z 5), which Orca skips.
    let boxes = brim_boxes(
        json!({"brim_type": "painted", "brim_width": 5}),
        json!({"brimPoints": [[0.0, 0.0, 0.0, 6.0], [20.0, 20.0, 5.0, 6.0]]}),
    );
    assert!(!boxes.is_empty());
    for b in &boxes {
        assert!(b[2] < 108.0 && b[3] < 108.0, "{b:?}");
        assert!(b[0] > 94.0 && b[1] > 94.0, "{b:?}");
    }
}

#[test]
fn brim_object_gap_keeps_the_outer_brim_off_the_part() {
    let near = brim_boxes(json!({"brim_type": "outer_only", "brim_width": 3}), json!({}));
    let gap = brim_boxes(
        json!({"brim_type": "outer_only", "brim_width": 3, "brim_object_gap": 1.0}),
        json!({}),
    );
    let reach = |b: &[[f64; 4]]| b.iter().map(|x| 100.0 - x[0]).fold(0.0, f64::max);
    let inner = |b: &[[f64; 4]]| b.iter().map(|x| 100.0 - x[0]).fold(f64::MAX, f64::min);
    assert!(
        reach(&gap) > reach(&near) + 0.5,
        "{} {}",
        reach(&gap),
        reach(&near)
    );
    assert!(inner(&near) < 1.5);
}

/// Two 20 mm blocks of different filaments touching along x = 120, 10 mm tall.
fn two_filaments(config: Value) -> String {
    let mut a = cuboid([0.0, 20.0], [0.0, 20.0], [0.0, 10.0], "a");
    let mut b = cuboid([20.0, 40.0], [0.0, 20.0], [0.0, 10.0], "b");
    a.slot = 1;
    b.slot = 2;
    let mesh = Arc::new(Mesh {
        name: "pair".into(),
        parts: vec![a, b],
    });
    let mut cfg = json!({
        "skirt_loops": 0, "brim_width": 0, "wall_loops": 2, "sparse_infill_density": 0,
        "top_shell_layers": 3, "bottom_shell_layers": 3, "enable_prime_tower": false,
    });
    cfg.as_object_mut()
        .unwrap()
        .extend(config.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "p", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": cfg,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&run);
    text(&run)
}

#[test]
fn interlocking_beams_cut_the_joint_between_filaments_into_teeth() {
    let plain = two_filaments(json!({}));
    let beams = two_filaments(json!({"interlocking_beam": true}));
    if let Ok(dir) = std::env::var("SX_DUMP") {
        std::fs::write(format!("{dir}/il.gcode"), &beams).unwrap();
    }
    // Beams add wall length along the joint on the layers inside the part.
    let wall_len = |g: &str| -> f64 {
        let mut total = 0.0;
        let (mut x, mut y) = (0.0, 0.0);
        let mut wall = false;
        for l in g.lines() {
            if let Some(t) = l.strip_prefix(";TYPE:") {
                wall = t.ends_with("wall");
            }
            if l.starts_with("G1 X") || l.starts_with("G0 X") {
                let (nx, ny) = (field(l, 'X').unwrap_or(x), field(l, 'Y').unwrap_or(y));
                if wall && l.contains(" E") {
                    total += (nx - x).hypot(ny - y);
                }
                (x, y) = (nx, ny);
            }
        }
        total
    };
    assert!(
        wall_len(&beams) > wall_len(&plain) * 1.15,
        "{} {}",
        wall_len(&beams),
        wall_len(&plain)
    );
}

#[test]
fn brick_layers_lift_the_inner_walls_half_a_layer() {
    let g = vase_run(json!({
        "spiral_mode": false, "brick_layers": true, "wall_loops": 3, "sparse_infill_density": 20,
        "top_shell_layers": 4, "bottom_shell_layers": 2,
    }));
    let layers: Vec<&str> = g.split(sx_core::extras::layer_mark(&g)).skip(1).collect();
    assert_eq!(layers.len(), 20);
    // Z moves written before the inner wall of a layer and back after it.
    let lifts = |l: &str| -> Vec<f64> {
        let mut out = Vec::new();
        let mut inner = false;
        for line in l.lines() {
            if let Some(t) = line.strip_prefix(";TYPE:") {
                inner = t == "Inner wall";
            } else if inner && line.starts_with("G1 Z") {
                out.push(field(line, 'Z').unwrap());
            }
        }
        out
    };
    let z_of = |i: usize| 0.2 * (i + 1) as f64;
    assert!(lifts(layers[0]).is_empty());
    for (i, layer) in layers.iter().enumerate().take(13).skip(2) {
        let l = lifts(layer);
        // Up before each inner wall and back down after it (two inner walls).
        assert_eq!(l.len(), 4, "layer {i}: {l:?}");
        assert!(
            l.iter().step_by(2).all(|z| (z - (z_of(i) + 0.1)).abs() < 0.0011),
            "layer {i}: {l:?}"
        );
        assert!(
            l.iter().skip(1).step_by(2).all(|z| (z - z_of(i)).abs() < 0.0011),
            "layer {i}: {l:?}"
        );
    }
    // The top shell layers print their walls level.
    assert!(lifts(layers[19]).is_empty());
    // Extra flow on the first shifted layer: a longer extrusion per mm than the next one.
    let e_per_mm = |l: &str| -> f64 {
        let (mut x, mut y, mut e, mut d, mut inner) = (0.0, 0.0, 0.0, 0.0, false);
        for line in l.lines() {
            if let Some(t) = line.strip_prefix(";TYPE:") {
                inner = t == "Inner wall";
            }
            if line.starts_with("G1 X") {
                let (nx, ny) = (field(line, 'X').unwrap_or(x), field(line, 'Y').unwrap_or(y));
                if inner && let Some(v) = field(line, 'E') {
                    e += v;
                    d += (nx - x).hypot(ny - y);
                }
                (x, y) = (nx, ny);
            }
        }
        e / d
    };
    let ratio = e_per_mm(layers[1]) / e_per_mm(layers[4]);
    assert!((ratio - 1.5).abs() < 0.05, "{ratio}");
}

fn block_gcode(config: Value) -> String {
    let mesh = Arc::new(Mesh {
        name: "block".into(),
        parts: vec![cuboid([0.0, 40.0], [0.0, 40.0], [0.0, 4.0], "block")],
    });
    let mut cfg = json!({
        "brim_width": 0, "skirt_loops": 0, "layer_height": 0.2, "initial_layer_print_height": 0.2,
        "wall_loops": 2, "seam_position": "back", "sparse_infill_density": 0,
    });
    cfg.as_object_mut()
        .unwrap()
        .extend(config.as_object().unwrap().clone());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "b", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
        "config": cfg,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let run = common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    assert_valid(&run);
    text(&run)
}

/// The moves of the outer wall of layer `n` (0-based): `(x, y, z, e)`, with `z` the last Z written.
fn outer_wall_moves(g: &str, n: usize) -> Vec<(f64, f64, f64, f64)> {
    let l = g.split(sx_core::extras::layer_mark(g)).nth(n + 1).unwrap_or("");
    let layer_z: f64 = l
        .lines()
        .find_map(|x| x.strip_prefix(";Z:"))
        .unwrap()
        .parse()
        .unwrap();
    let (mut z, mut out, mut in_outer) = (layer_z, Vec::new(), false);
    let mut travel = (0.0, 0.0);
    for line in l.lines() {
        if let Some(t) = line.strip_prefix(";TYPE:") {
            in_outer = t == "Outer wall";
        }
        if line.starts_with("G0 X") {
            travel = (field(line, 'X').unwrap(), field(line, 'Y').unwrap());
        }
        if line.starts_with("G1 Z") {
            z = field(line, 'Z').unwrap();
        } else if line.starts_with("G1 X") {
            if let Some(nz) = field(line, 'Z') {
                z = nz;
            }
            if in_outer && let Some(e) = field(line, 'E') {
                if out.is_empty() {
                    // Where the wall starts: the travel's end, at the Z the wall starts at.
                    out.push((travel.0, travel.1, z, 0.0));
                }
                out.push((field(line, 'X').unwrap(), field(line, 'Y').unwrap(), z, e));
            }
        }
    }
    out
}

/// Where each wall loop of layer `n` starts, in print order (inner walls first): the travel's end.
fn wall_starts(g: &str, n: usize) -> Vec<(f64, f64)> {
    let l = g.split(sx_core::extras::layer_mark(g)).nth(n + 1).unwrap_or("");
    l.lines()
        .filter(|line| line.starts_with("G0 X"))
        .map(|line| (field(line, 'X').unwrap_or(0.0), field(line, 'Y').unwrap_or(0.0)))
        .collect()
}

#[test]
fn staggered_inner_seams_walk_the_inner_seam_back_along_the_wall() {
    let cfg = |stagger: bool| json!({"wall_loops": 3, "seam_gap": 0, "staggered_inner_seams": stagger});
    let plain = wall_starts(&block_gcode(cfg(false)), 3);
    let zig = wall_starts(&block_gcode(cfg(true)), 3);
    assert_eq!(plain.len(), 3, "{plain:?}");
    assert_eq!(zig.len(), 3);
    let d = |a: (f64, f64), b: (f64, f64)| (a.0 - b.0).hypot(a.1 - b.1);
    // Each inner seam moves along its wall, the deeper one (printed first) further, and the outer wall stays.
    assert!(d(plain[1], zig[1]) > 0.3, "{plain:?} {zig:?}");
    assert!(
        d(plain[0], zig[0]) > d(plain[1], zig[1]) + 0.1,
        "{plain:?} {zig:?}"
    );
    assert!(d(plain[2], zig[2]) < 1e-9);
}

#[test]
fn the_seam_gap_ends_a_wall_short_of_its_start() {
    let none = outer_wall_moves(&block_gcode(json!({"seam_gap": 0})), 3);
    let gap = outer_wall_moves(&block_gcode(json!({"seam_gap": "100%"})), 3);
    let end = |m: &[(f64, f64, f64, f64)]| *m.last().unwrap();
    let start = |m: &[(f64, f64, f64, f64)]| (m[0].0, m[0].1);
    let (a, b) = (end(&none), end(&gap));
    // 100 percent of a 0.4 mm nozzle: the last point is 0.4 mm before the loop's start.
    assert!(((a.0 - start(&none).0).hypot(a.1 - start(&none).1)) < 0.05);
    assert!(
        ((b.0 - start(&none).0).hypot(b.1 - start(&none).1) - 0.4).abs() < 0.05,
        "{b:?}"
    );
}

#[test]
fn a_scarf_seam_rises_from_the_layer_below_and_retraces_its_start() {
    let g = block_gcode(json!({
        "seam_gap": 0.0, "seam_slope_type": "external", "seam_slope_min_length": 10, "seam_slope_steps": 10,
    }));
    // The first layer has none; later layers start low and climb to the layer's Z.
    assert!(outer_wall_moves(&g, 0).iter().all(|m| (m.2 - 0.2).abs() < 1e-6));
    let m = outer_wall_moves(&g, 3);
    let layer_z = 0.8;
    assert!(m[0].2 < layer_z - 0.15, "starts at {}", m[0].2);
    let rise_end = m.iter().position(|p| (p.2 - layer_z).abs() < 1e-6).unwrap();
    assert!(m[..rise_end].windows(2).all(|w| w[1].2 >= w[0].2 - 1e-9));
    // The rise is about 10 mm long and its flow grows from nothing.
    let rise_len: f64 = m[..=rise_end]
        .windows(2)
        .map(|w| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1))
        .sum();
    assert!((rise_len - 10.0).abs() < 0.6, "{rise_len}");
    assert!(m[1].3 < m[rise_end].3, "{} {}", m[1].3, m[rise_end].3);
    // The loop ends by retracing the start: its last moves lie on the first ones, flow falling.
    let n = m.len();
    assert!(m[n - 1].3 < m[n - 5].3);
    let far = |p: &(f64, f64, f64, f64), q: &(f64, f64, f64, f64)| (p.0 - q.0).hypot(p.1 - q.1);
    assert!(far(&m[n - 1], &m[rise_end]) < 1.5);
    // Stays at the layer's Z along the retrace, so the wall is as high as the others there.
    assert!(m[n - 4..].iter().all(|p| (p.2 - layer_z).abs() < 1e-6));
}

#[test]
fn an_arachne_wall_gets_the_scarf_seam_and_the_seam_gap_too() {
    let arachne = json!({"wall_generator": "arachne"});
    let mut c = json!({
        "seam_gap": 0.0, "seam_slope_type": "external", "seam_slope_conditional": false,
        "seam_slope_min_length": 10, "seam_slope_steps": 10,
    });
    c["wall_generator"] = arachne["wall_generator"].clone();
    let m = outer_wall_moves(&block_gcode(c), 3);
    assert!(m[0].2 < 0.8 - 0.15, "starts at {}", m[0].2);
    assert!(m.iter().any(|p| (p.2 - 0.8).abs() < 1e-6));
    assert!(m[1].3 < m[m.len() / 2].3);
    let gap = outer_wall_moves(
        &block_gcode(json!({"seam_gap": "100%", "wall_generator": "arachne"})),
        3,
    );
    let none = outer_wall_moves(
        &block_gcode(json!({"seam_gap": 0, "wall_generator": "arachne"})),
        3,
    );
    let d = |p: &(f64, f64, f64, f64), q: &(f64, f64, f64, f64)| (p.0 - q.0).hypot(p.1 - q.1);
    assert!(d(none.last().unwrap(), &none[0]) < 0.05);
    assert!((d(gap.last().unwrap(), &none[0]) - 0.4).abs() < 0.05);
}

#[test]
fn tall_print_speed_slows_the_walls_with_height() {
    let run = |tall: bool| {
        let mut c = json!({
            "seam_gap": 0, "outer_wall_speed": 60, "inner_wall_speed": 60, "slow_down_for_layer_cooling": false,
        });
        if tall {
            c["tall_print_speed_start"] = json!(1.0);
            c["tall_print_speed_end"] = json!(3.0);
            c["tall_print_speed_percent"] = json!(50);
        }
        block_gcode(c)
    };
    let (off, on) = (run(false), run(true));
    let outer_feed = |g: &str, n: usize| -> f64 {
        let l = g.split(sx_core::extras::layer_mark(g)).nth(n + 1).unwrap();
        // The feed in force when the outer wall starts: the last `G1 F` before its first move.
        let (mut feed, mut in_outer) = (0.0, false);
        for line in l.lines() {
            if let Some(t) = line.strip_prefix(";TYPE:") {
                in_outer = t == "Outer wall";
            } else if line.starts_with("G1 F") {
                feed = field(line, 'F').unwrap();
            } else if in_outer && line.starts_with("G1 X") {
                return feed;
            }
        }
        panic!("no outer wall in layer {n}");
    };
    let ratio = |n: usize| outer_feed(&on, n) / outer_feed(&off, n);
    assert!(
        (ratio(2) - 1.0).abs() < 1e-3,
        "below the start height: {}",
        ratio(2)
    );
    assert!((ratio(12) - 0.6).abs() < 0.01, "{}", ratio(12));
    assert!((ratio(19) - 0.5).abs() < 0.01, "{}", ratio(19));
}

#[test]
fn bambus_slow_down_by_height_caps_the_speed_with_height() {
    let g = block_gcode(json!({
        "seam_gap": 0, "outer_wall_speed": 200, "inner_wall_speed": 200, "slow_down_for_layer_cooling": false,
        "enable_height_slowdown": true, "slowdown_start_height": 1.0, "slowdown_end_height": 3.0,
        "slowdown_start_speed": 150, "slowdown_end_speed": 50,
    }));
    let feed = |n: usize| -> f64 {
        let l = g.split(sx_core::extras::layer_mark(&g)).nth(n + 1).unwrap();
        let (mut feed, mut in_outer) = (0.0, false);
        for line in l.lines() {
            if let Some(t) = line.strip_prefix(";TYPE:") {
                in_outer = t == "Outer wall";
            } else if line.starts_with("G1 F") {
                feed = field(line, 'F').unwrap();
            } else if in_outer && line.starts_with("G1 X") {
                return feed;
            }
        }
        panic!("no outer wall in layer {n}");
    };
    // Layer 2 (0.6 mm) is under the start height, layer 9 (2.0 mm) is halfway, layer 19 (4.0 mm) is above.
    assert!(feed(2) > 5000.0, "{}", feed(2));
    assert!((feed(9) - 100.0 * 60.0).abs() < 1.0, "{}", feed(9));
    assert!((feed(19) - 50.0 * 60.0).abs() < 1.0, "{}", feed(19));
}

#[test]
fn wave_overhangs_print_rings_growing_from_the_supported_edge() {
    let mesh = Arc::new(table());
    let run = |config: Value| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": config,
        }))
        .unwrap();
        let m = mesh.clone();
        common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap()
    };
    let r = run(json!({"wave_overhangs": true, "wave_overhang_print_speed": 3.0}));
    assert_valid(&r);
    let g = text(&r);
    let layer = g.split(sx_core::extras::layer_mark(&g)).nth(51).unwrap();
    let bridge = layer
        .split(";TYPE:Bridge")
        .nth(1)
        .unwrap()
        .split(";TYPE:")
        .next()
        .unwrap();
    // 3 mm/s, many rings along the gap, each short of the full bridge span.
    assert!(
        bridge.contains("G1 F180\n"),
        "{}",
        &bridge[..bridge.len().min(300)]
    );
    let strokes = bridge.lines().filter(|l| l.starts_with("G0 X")).count();
    assert!(strokes > 20, "{strokes} rings");
    // Fewer, slower: total extruded length under the gap is about the same as the bridge's.
    let plain = text(&run(json!({})));
    assert_ne!(g.len(), plain.len());
}

#[test]
fn athena_walls_keep_one_width_and_take_the_overlap_setting() {
    let walls = |config: Value| -> (Vec<String>, f64) {
        let g = block_gcode(
            json!({"wall_generator": "athena", "wall_loops": 3, "seam_gap": 0})
                .as_object()
                .map(|m| {
                    let mut m = m.clone();
                    m.extend(config.as_object().unwrap().clone());
                    Value::Object(m)
                })
                .unwrap(),
        );
        let l = g.split(sx_core::extras::layer_mark(&g)).nth(4).unwrap();
        let widths: Vec<String> = l
            .lines()
            .filter(|x| x.starts_with(";WIDTH:"))
            .map(str::to_owned)
            .collect();
        let mut inner_len = 0.0;
        let (mut x, mut y, mut inner) = (0.0, 0.0, false);
        for line in l.lines() {
            if let Some(t) = line.strip_prefix(";TYPE:") {
                inner = t == "Inner wall";
            }
            if line.starts_with("G1 X") || line.starts_with("G0 X") {
                let (nx, ny) = (field(line, 'X').unwrap_or(x), field(line, 'Y').unwrap_or(y));
                if inner && line.starts_with("G1") && line.contains(" E") {
                    inner_len += (nx - x).hypot(ny - y);
                }
                (x, y) = (nx, ny);
            }
        }
        (widths, inner_len)
    };
    let (w, base) = walls(json!({}));
    assert!(w.iter().all(|x| x == &w[0]), "variable widths: {w:?}");
    // A negative overlap pulls the inner walls apart, so the second wall sits farther in and is shorter.
    let (_, apart) =
        walls(json!({"perimeter_perimeter_overlap": -50, "ext_perimeter_perimeter_overlap": -50}));
    assert!(apart < base - 5.0, "{apart} {base}");
}

#[test]
fn support_keys_shape_the_support() {
    let mesh = Arc::new(table());
    let run = |extra: Value| {
        let mut config = json!({"enable_support": true, "support_type": "normal(auto)", "independent_support_layer_height": 0});
        for (k, v) in extra.as_object().unwrap() {
            config[k] = v.clone();
        }
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": config,
        }))
        .unwrap();
        let m = mesh.clone();
        let out = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&out);
        out
    };
    let count = |r: &SliceRun, f: &str| features_by_layer(&text(r)).iter().filter(|m| m.1 == f).count();
    let base = run(json!({}));
    // Support ironing irons the top contact under the slab, and only there.
    let ironed = run(json!({"support_ironing": true, "support_ironing_spacing": 0.15}));
    let irons: Vec<f64> = features_by_layer(&text(&ironed))
        .into_iter()
        .filter(|m| m.1 == "Ironing")
        .map(|m| m.0)
        .collect();
    assert!(!irons.is_empty(), "no support ironing");
    assert!(irons.iter().all(|z| *z < 10.0 && *z > 9.0), "{irons:?}");
    assert_eq!(count(&base, "Ironing"), 0);
    // The interface patterns all print, and each one differently.
    let mut seen = vec![text(&base)];
    for p in ["rectilinear", "concentric", "rectilinear_interlaced", "grid"] {
        let r = run(json!({"support_interface_pattern": p, "support_style": "snug"}));
        assert!(count(&r, "Support interface") > 0, "{p}");
        let g = text(&r);
        assert!(!seen.contains(&g), "{p} prints like another pattern");
        seen.push(g);
    }
    // Contact loops add interface lines along the edge of the contact.
    let loops = run(json!({"support_interface_loop_pattern": true}));
    assert!(count(&loops, "Support interface") > count(&base, "Support interface"));
    // No support under bridges: the slab spans the pillars, so almost all of it goes.
    let bridged = run(json!({"bridge_no_support": true}));
    let mm = |r: &SliceRun| r.report.stats.filament_mm[0];
    assert!(
        mm(&base) - mm(&bridged) > 0.5 * (mm(&base) - mm(&run(json!({"enable_support": false})))),
        "{} {}",
        mm(&base),
        mm(&bridged)
    );
    // Small support paths print at the small support perimeter speed.
    let slow = run(json!({"small_support_perimeter_threshold": 50, "small_support_perimeter_speed": 7}));
    let support_feeds: Vec<String> = text(&slow)
        .lines()
        .scan(String::new(), |kind, l| {
            if let Some(v) = l.strip_prefix(";TYPE:") {
                v.clone_into(kind);
            }
            Some((kind.clone(), l.to_string()))
        })
        .filter(|(k, l)| k == "Support" && l.starts_with("G1") && l.contains(" F"))
        .map(|(_, l)| l)
        .collect();
    assert!(
        support_feeds.iter().any(|l| l.contains("F420")),
        "{:?}",
        support_feeds.first()
    );
}

#[test]
fn objects_with_own_settings_pair_their_layers_by_height() {
    // A table with support on layers of its own beside a block without support, printed layer by layer.
    let table = Arc::new(table());
    let block = Arc::new(one_box([0.0, 10.0], [0.0, 10.0], [0.0, 12.0]));
    let run = |shards: u32| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [
                {"mesh": "t", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 60,100,0,1], "settings": {"enable_support": true}},
                {"mesh": "b", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 160,100,0,1], "settings": {"wall_loops": 3}},
            ]},
            "config": {},
            "options": {"shards": shards},
        }))
        .unwrap();
        let (t, b) = (table.clone(), block.clone());
        let r = common::run_request(&req, &move |id: &str| {
            Ok(if id == "t" { t.clone() } else { b.clone() })
        })
        .unwrap();
        assert_valid(&r);
        r
    };
    let one = run(1);
    // 60 object layers plus the table's support layers between them.
    assert!(one.report.layer_count > 60, "{}", one.report.layer_count);
    let zs: Vec<f64> = text(&one)
        .lines()
        .filter_map(|l| l.strip_prefix(";Z:"))
        .map(|z| z.parse().unwrap())
        .collect();
    assert_eq!(zs.len(), one.report.layer_count as usize);
    assert!(zs.windows(2).all(|w| w[1] > w[0]), "layer heights rise");
    assert_eq!(text(&run(4)), text(&one), "shards concatenate to the same G-code");
}

#[test]
fn features_print_with_their_own_filaments() {
    // Outer walls on filament 2, top surfaces on 3, the rest on the part's 1.
    let cube = Arc::new(one_box([0.0, 20.0], [0.0, 20.0], [0.0, 6.0]));
    let run = |shards: u32| {
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"mesh": "c", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,100,0,1]}]},
            "config": {"outer_wall_filament_id": 2, "top_surface_filament_id": 3, "enable_prime_tower": true, "brim_width": 0},
            "options": {"shards": shards, "flavor": "marlin2"},
        }))
        .unwrap();
        let m = cube.clone();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        assert_valid(&r);
        r
    };
    let one = run(1);
    let g = text(&one);
    let mut tool = String::new();
    let mut seen: Vec<(String, String)> = Vec::new();
    let mut feature = String::new();
    for l in g.lines() {
        if l.len() == 2 && l.starts_with('T') {
            l.clone_into(&mut tool);
        } else if let Some(f) = l.strip_prefix(";TYPE:") {
            f.clone_into(&mut feature);
        } else if l.starts_with("G1 X")
            && l.contains(" E")
            && !seen.contains(&(feature.clone(), tool.clone()))
        {
            seen.push((feature.clone(), tool.clone()));
        }
    }
    let on = |f: &str| -> Vec<&str> {
        seen.iter()
            .filter(|(a, _)| a == f)
            .map(|(_, t)| t.as_str())
            .collect()
    };
    assert_eq!(on("Outer wall"), ["T1"], "{seen:?}");
    assert_eq!(on("Top surface"), ["T2"], "{seen:?}");
    assert_eq!(on("Inner wall"), ["T0"], "{seen:?}");
    assert_eq!(text(&run(4)), g, "shards concatenate to the same G-code");
}

#[test]
fn the_tower_is_as_deep_as_its_thinnest_layer_needs() {
    // Thin layers take more rows for the same purge: the tower is sized for them, not the first layer,
    // and every purge stays inside it.
    let tower_y = |g: &str| -> (f64, f64) {
        let mut on = false;
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        for l in g.lines() {
            if let Some(f) = l.strip_prefix(";TYPE:") {
                on = f == "Prime tower";
            } else if on
                && l.starts_with("G1 ")
                && l.contains(" E")
                && let Some(y) = l.split_whitespace().find_map(|w| w.strip_prefix('Y'))
            {
                let y: f64 = y.parse().unwrap();
                lo = lo.min(y);
                hi = hi.max(y);
            }
        }
        (lo, hi)
    };
    let cfg = |h: f64| {
        json!({"enable_prime_tower": true, "prime_tower_always": true, "prime_tower_brim_width": 0,
                                "layer_height": h, "flush_volumes_matrix": [0, 140, 140, 0]})
    };
    let thick = tower_y(&text(&two_colors(cfg(0.2))));
    let thin = tower_y(&text(&two_colors(cfg(0.08))));
    assert!(thin.1 - thin.0 > (thick.1 - thick.0) * 2.0, "{thick:?} {thin:?}");
}

/// The extruding moves of the `Brim` feature.
fn brim_moves(run: &SliceRun) -> usize {
    let mut on = false;
    let mut n = 0;
    for line in text(run).lines() {
        if let Some(t) = line.strip_prefix(";TYPE:") {
            on = t == "Brim";
        } else if on && line.starts_with("G1 X") && field(line, 'E').is_some_and(|e| e > 0.0) {
            n += 1;
        }
    }
    n
}

#[test]
fn the_automatic_brim_is_sized_per_object_not_for_the_whole_plate() {
    // Squat bars that get no automatic brim on their own, spread across the bed. Each is a little different so
    // they slice as one plate rather than as copies of one object.
    let bars = [
        (20.0, 20.0, 0.0),
        (170.0, 20.0, 0.5),
        (20.0, 200.0, 1.0),
        (170.0, 200.0, 1.5),
    ];
    let run_with = |n: usize| -> SliceRun {
        let meshes: Vec<Arc<Mesh>> = bars
            .iter()
            .map(|&(x, y, k): &(f32, f32, f32)| {
                Arc::new(Mesh {
                    name: "bar".into(),
                    parts: vec![cuboid([x, x + 60.0 + k], [y, y + 10.0], [0.0, 30.0], "bar")],
                })
            })
            .collect();
        let objects: Vec<Value> = (0..n)
            .map(|i| json!({"id": format!("bar-{i}"), "mesh": i.to_string(), "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]}))
            .collect();
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": objects},
            "config": {"brim_type": "auto_brim", "skirt_loops": 0, "enable_prime_tower": false},
            "options": {"flavor": "marlin2"},
        }))
        .unwrap();
        let r = common::run_request(&req, &move |m: &str| {
            Ok(meshes[m.parse::<usize>().unwrap()].clone())
        })
        .unwrap();
        assert_valid(&r);
        r
    };
    assert_eq!(brim_moves(&run_with(1)), 0, "one bar alone gets no brim");
    // Sized from the four bars together the plate is about 250 mm across, which asks for a 9 mm brim.
    assert_eq!(
        brim_moves(&run_with(4)),
        0,
        "four bars get the brim each gets alone"
    );
}

/// One print time: the layer times the preview plays, and the start before the first layer, add up to the time
/// the estimate and the file's footer state (the layer times read the whole file, not the shards).
#[test]
fn the_preview_plays_the_time_the_estimate_states() {
    for shards in [1, 4] {
        let r = run(&request(json!({"shards": shards}), json!({}))).unwrap();
        let stats = &r.report.stats;
        assert!(stats.time_s > 0.0 && stats.prepare_s >= 0.0 && stats.prepare_s < stats.time_s);
        let layers: f64 = r.report.layer_time_s.iter().map(|&t| f64::from(t)).sum();
        assert!(
            (layers + stats.prepare_s - stats.time_s).abs() < 1.0 + 1e-3 * stats.time_s,
            "{shards} shards: layers {layers} + start {} against {}",
            stats.prepare_s,
            stats.time_s
        );
        // The preview carries the same table.
        let info = sx_core::preview::read_info(&r.preview).unwrap();
        let table: Vec<f32> = (0..info.layers)
            .map(|k| {
                f32::from_le_bytes(
                    r.preview[info.layer_time + k * 4..info.layer_time + k * 4 + 4]
                        .try_into()
                        .unwrap(),
                )
            })
            .collect();
        assert_eq!(table, r.report.layer_time_s, "{shards} shards");
    }
}

#[test]
fn a_tool_change_retracts_and_spirals_up_first() {
    // Orca's set_extruder: the tool change retraction, then a spiral lift made at once, whatever the lift type.
    let r = two_colors(json!({
        "z_hop": [0.4, 0.4],
        "z_hop_types": ["Normal Lift", "Normal Lift"],
        "retract_lift_above": [0, 0],
        "retract_length_toolchange": [2, 2],
        "enable_arc_fitting": false,
    }));
    let g = text(&r);
    let lines: Vec<&str> = g.lines().collect();
    let body = lines.iter().position(sx_core::extras::is_layer_mark).unwrap();
    // the first tool command selects the first filament; the rest change it
    let tools: Vec<usize> = (body..lines.len())
        .filter(|&i| lines[i].len() == 2 && lines[i].starts_with('T'))
        .skip(1)
        .collect();
    let mut changes = 0;
    for &i in &tools {
        let before = &lines[i.saturating_sub(12)..i];
        let pull = before
            .iter()
            .position(|l| l.starts_with("G1 E-2 ") || l.starts_with("G1 E-1.2 "));
        let turns = before
            .iter()
            .filter(|l| l.starts_with("G1 X") && l.contains(" Z") && !l.contains(" E"))
            .count();
        if pull.is_some() && turns >= 7 {
            changes += 1;
        }
    }
    let total = tools.len();
    assert!(total > 10, "{total} tool changes");
    assert_eq!(
        changes, total,
        "{changes} of {total} tool changes retract and spiral"
    );
}
