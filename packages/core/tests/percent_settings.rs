// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Percent settings sent as text with a `%` sign, the way projects and printer presets write them ("60%"), slice
//! the same as the plain number the app sends (60). The locked zag skin and skeleton densities used to drop the
//! text and fall back to their 25% defaults. A small perimeter speed in the list form presets use (`["80%"]`) fell
//! back to half the outer wall speed. Every other percent setting the engine reads gets the same check below: "N%",
//! `["N%"]`, N and `[N]` print the same G-code, and N prints unlike the setting left out. The scarf overhang threshold
//! is checked where it is read, in `scarf.rs`.

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use common::organic_models::cuboid;
use sx_core::api::{Mesh, MeshPart, SliceRequest};

/// A 20 mm cube, 6 mm tall.
fn block() -> Arc<Mesh> {
    let mut positions = Vec::new();
    for z in [0.0, 6.0] {
        for (x, y) in [(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)] {
            positions.push([x, y, z]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    Arc::new(Mesh {
        name: "block".into(),
        parts: vec![MeshPart {
            name: "block".into(),
            slot: 1,
            color: None,
            positions,
            triangles,
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
            paint_texts: Vec::new(),
        }],
        ..Mesh::default()
    })
}

/// The G-code of the cube in locked zag at 40% over `extra` settings.
fn locked_zag(extra: &Value) -> String {
    let mut c = json!({
        "sparse_infill_pattern": "lockedzag",
        "sparse_infill_density": "40%",
    });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    slice(&c)
}

/// The G-code of the cube over `extra` settings, with no brim.
fn slice(extra: &Value) -> String {
    let mut c = json!({ "brim_width": 0 });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{
            "id": "a", "name": "a", "mesh": "a",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 110, 110, 0, 1],
        }]},
        "config": c,
        "options": {"flavor": "marlin2"},
    }))
    .unwrap();
    let run = common::run_request(&req, &|_: &str| Ok(block())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// The sparse infill moves only: the configuration block at the end lists the settings as they were sent.
fn sparse(g: &str) -> String {
    let mut on = false;
    let mut out = String::new();
    for l in g.lines() {
        if let Some(f) = l.strip_prefix(";TYPE:").or_else(|| l.strip_prefix("; FEATURE:")) {
            on = f.trim() == "Sparse infill";
        } else if on && l.starts_with("G1 ") {
            out.push_str(l);
            out.push('\n');
        }
    }
    out
}

fn reads_as_its_number(key: &str) {
    let default = sparse(&locked_zag(&json!({})));
    let text = sparse(&locked_zag(&json!({ key: "60%" })));
    let number = sparse(&locked_zag(&json!({ key: 60 })));
    assert!(!number.is_empty(), "no sparse infill");
    assert_ne!(number, default, "{key} 60 prints like the default");
    assert_eq!(text, number, "{key} \"60%\" prints unlike 60");
    let list = sparse(&locked_zag(&json!({ key: ["60%"] })));
    assert_eq!(list, number, "{key} [\"60%\"] prints unlike 60");
}

#[test]
fn locked_zag_skin_density_reads_a_percent_sign() {
    reads_as_its_number("skin_infill_density");
}

#[test]
fn locked_zag_skeleton_density_reads_a_percent_sign() {
    reads_as_its_number("skeleton_infill_density");
}

/// The feeds the outer walls print at, mm/min, with every loop of the cube a small perimeter (up to 20 x 2 pi mm)
/// and a 170 mm/s outer wall.
fn outer_wall_feeds(speed: &Value) -> Vec<u32> {
    let g = slice(&json!({
        "outer_wall_speed": 170,
        "small_perimeter_threshold": [20],
        "small_perimeter_speed": speed,
    }));
    let mut on = false;
    let mut feeds = Vec::new();
    for l in g.lines() {
        if let Some(f) = l.strip_prefix(";TYPE:").or_else(|| l.strip_prefix("; FEATURE:")) {
            on = f.trim() == "Outer wall";
        } else if on && l.starts_with("G1 ") {
            let feed = l
                .split_whitespace()
                .find_map(|w| w.strip_prefix('F').and_then(|v| v.parse::<u32>().ok()));
            if let Some(feed) = feed
                && !feeds.contains(&feed)
            {
                feeds.push(feed);
            }
        }
    }
    feeds
}

#[test]
fn small_perimeter_speed_reads_a_percent_in_a_list() {
    // 80% of 170 mm/s is 136 mm/s, F8160, as text, in a list, or as the number.
    for speed in [json!(["80%"]), json!("80%"), json!(136), json!([136])] {
        let feeds = outer_wall_feeds(&speed);
        assert!(feeds.contains(&8160), "{speed}: {feeds:?}");
        assert!(
            !feeds.contains(&5100),
            "{speed} prints at half the outer wall speed: {feeds:?}"
        );
    }
}

/// A model, the settings that make a percent setting count on it, and whether they go over the shared test base.
struct Setup {
    mesh: Mesh,
    config: Value,
    options: Value,
    over_base: bool,
}

impl Setup {
    /// `config` over the test base on `mesh`, with no brim, Marlin 2 G-code.
    fn on(mesh: Mesh, config: &Value) -> Self {
        let mut c = json!({"brim_width": 0});
        if let (Some(c), Some(e)) = (c.as_object_mut(), config.as_object()) {
            c.extend(e.clone());
        }
        Self {
            mesh,
            config: c,
            options: json!({"flavor": "marlin2"}),
            over_base: true,
        }
    }

    /// The G-code with `key` set to `value`, or left out.
    fn slice(&self, key: &str, value: Option<Value>) -> String {
        let mut c = self.config.clone();
        if let Some(v) = value {
            c[key] = v;
        }
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {
                "bed": {"widthMm": 250, "depthMm": 210, "heightMm": 220},
                "objects": [{
                    "id": "a", "name": "a", "mesh": "a",
                    "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 60, 60, 0, 1],
                }],
            },
            "config": c,
            "options": self.options,
        }))
        .unwrap();
        let mesh = Arc::new(self.mesh.clone());
        let load = move |_: &str| Ok(mesh.clone());
        let run = if self.over_base {
            common::run_request(&req, &load)
        } else {
            sx_core::api::run_request(&req, &load)
        }
        .unwrap();
        String::from_utf8(run.gcode).unwrap()
    }
}

/// The G-code without its comments: the configuration block lists each setting as it was sent.
fn commands(g: &str) -> Vec<String> {
    g.lines()
        .map(|l| l.split(';').next().unwrap_or("").trim_end())
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The first line where two G-codes part, for the failure message.
fn first_difference(a: &[String], b: &[String]) -> String {
    let at = a
        .iter()
        .zip(b)
        .position(|(x, y)| x != y)
        .unwrap_or(a.len().min(b.len()));
    format!(
        "line {at}: {:?} against {:?} ({} and {} lines)",
        a.get(at),
        b.get(at),
        a.len(),
        b.len()
    )
}

/// `key` written as "N%", `["N%"]` and `[N]` prints what N prints, and N prints unlike the setting left out.
fn percent_reads_as_its_number(setup: &Setup, key: &str, n: u32) {
    let default = commands(&setup.slice(key, None));
    let number = commands(&setup.slice(key, Some(json!(n))));
    assert!(number.iter().any(|l| l.starts_with("G1 ")), "{key}: no moves");
    assert!(number != default, "{key} {n} prints like the default");
    for v in [json!(format!("{n}%")), json!([format!("{n}%")]), json!([n])] {
        let g = commands(&setup.slice(key, Some(v.clone())));
        assert!(
            g == number,
            "{key} {v} prints unlike {n}: {}",
            first_difference(&g, &number)
        );
    }
}

/// A 20 mm cube, 6 mm tall.
fn cube() -> Mesh {
    Mesh::clone(&block())
}

/// A prism of the convex outline `foot` (counterclockwise), `height` mm tall.
fn prism(foot: &[[f32; 2]], height: f32) -> Mesh {
    let n = u32::try_from(foot.len()).unwrap();
    let positions = [0.0f32, height]
        .iter()
        .flat_map(|&z| foot.iter().map(move |p| [p[0], p[1], z]))
        .collect();
    let mut triangles = Vec::new();
    for i in 1..n - 1 {
        triangles.push([0, i + 1, i]);
        triangles.push([n, n + i, n + i + 1]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        triangles.push([i, j, n + j]);
        triangles.push([i, n + j, n + i]);
    }
    Mesh {
        name: "prism".into(),
        parts: vec![MeshPart {
            name: "prism".into(),
            slot: 1,
            positions,
            triangles,
            ..MeshPart::default()
        }],
        ..Mesh::default()
    }
}

/// A wedge 40 mm long that widens from nothing to 4 mm, 3 mm tall: walls of every width up to two lines.
fn wedge() -> Mesh {
    prism(&[[0.0, 0.0], [40.0, 0.0], [40.0, 4.0]], 3.0)
}

/// Two 8 mm legs 24 mm apart under a 2 mm slab, 12 mm tall: a bridge, and an overhang that needs support.
fn table() -> Mesh {
    Mesh {
        name: "table".into(),
        parts: vec![
            cuboid("left", [0.0, 0.0, 0.0], [8.0, 20.0, 10.0]),
            cuboid("right", [32.0, 0.0, 0.0], [40.0, 20.0, 10.0]),
            cuboid("slab", [0.0, 0.0, 10.0], [40.0, 20.0, 12.0]),
        ],
        ..Mesh::default()
    }
}

/// Two 20 mm boxes 2 mm tall on filaments 1 and 2, so every layer changes filament on the prime tower.
fn two_boxes() -> Mesh {
    let mut second = cuboid("second", [60.0, 0.0, 0.0], [80.0, 20.0, 2.0]);
    second.slot = 2;
    Mesh {
        name: "boxes".into(),
        parts: vec![cuboid("first", [0.0, 0.0, 0.0], [20.0, 20.0, 2.0]), second],
        ..Mesh::default()
    }
}

/// The tower settings of a printer config from the core's test data, with the tower on and every wipe on it.
fn tower(file: &str, extra: &Value) -> Setup {
    let path = format!("{}/{file}", env!("CARGO_MANIFEST_DIR"));
    let data: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut c = data["config"].clone();
    for (k, v) in [
        ("enable_prime_tower", json!(true)),
        ("smart_layer", json!("off")),
        ("flush_into_infill", json!(false)),
        ("flush_into_support", json!(false)),
        ("flush_into_objects", json!(false)),
        ("filament_colour", json!(["#F4EE2A", "#00AE42"])),
    ] {
        c[k] = v;
    }
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    Setup {
        mesh: two_boxes(),
        config: c,
        options: json!({"trustedGcode": true}),
        over_base: false,
    }
}

/// The stock A1 request's settings on a rectangle tower.
fn a1_tower() -> Setup {
    tower(
        "cli/tests/fixtures/xmark-2color-a1-request.json",
        &json!({"wipe_tower_wall_type": "rectangle", "prime_tower_width": 20}),
    )
}

/// A Prusa MK4 with a multi-material unit on the type 2 tower.
fn mk4_tower() -> Setup {
    tower(
        "bench/configs/reference-0.20.json",
        &json!({
            "printer_model": "Prusa MK4", "wipe_tower_type": "type2", "single_extruder_multi_material": "1",
            "use_relative_e_distances": "1", "printable_area": ["0x0", "250x0", "250x210", "0x210"],
            "filament_diameter": ["1.75", "1.75"], "filament_flow_ratio": ["0.9", "1.05"],
            "wipe_tower_x": ["20"], "wipe_tower_y": ["140"], "prime_tower_width": "60",
            "flush_volumes_matrix": ["0", "280", "280", "0"], "flush_multiplier": ["0.3"],
        }),
    )
}

#[test]
fn sparse_infill_density_reads_a_percent_sign() {
    percent_reads_as_its_number(&Setup::on(cube(), &json!({})), "sparse_infill_density", 40);
}

#[test]
fn infill_wall_overlap_reads_a_percent_sign() {
    percent_reads_as_its_number(&Setup::on(cube(), &json!({})), "infill_wall_overlap", 40);
}

#[test]
fn top_bottom_infill_wall_overlap_reads_a_percent_sign() {
    percent_reads_as_its_number(
        &Setup::on(cube(), &json!({})),
        "top_bottom_infill_wall_overlap",
        50,
    );
}

#[test]
fn top_surface_density_reads_a_percent_sign() {
    percent_reads_as_its_number(&Setup::on(cube(), &json!({})), "top_surface_density", 60);
}

#[test]
fn bottom_surface_density_reads_a_percent_sign() {
    percent_reads_as_its_number(&Setup::on(cube(), &json!({})), "bottom_surface_density", 60);
}

#[test]
fn internal_bridge_density_reads_a_percent_sign() {
    percent_reads_as_its_number(&Setup::on(cube(), &json!({})), "internal_bridge_density", 50);
}

#[test]
fn elefant_foot_layers_density_reads_a_percent_sign() {
    let setup = Setup::on(cube(), &json!({"elefant_foot_compensation_layers": 3}));
    percent_reads_as_its_number(&setup, "elefant_foot_layers_density", 60);
}

#[test]
fn raft_first_layer_density_reads_a_percent_sign() {
    let setup = Setup::on(cube(), &json!({"raft_layers": 2}));
    percent_reads_as_its_number(&setup, "raft_first_layer_density", 60);
}

#[test]
fn fuzzy_skin_ripple_offset_reads_a_percent_sign() {
    let setup = Setup::on(
        cube(),
        &json!({"fuzzy_skin": "external", "fuzzy_skin_noise_type": "ripple", "fuzzy_skin_thickness": 0.3,
               "fuzzy_skin_point_distance": 0.8}),
    );
    percent_reads_as_its_number(&setup, "fuzzy_skin_ripple_offset", 20);
}

#[test]
fn ironing_flow_reads_a_percent_sign() {
    percent_reads_as_its_number(
        &Setup::on(cube(), &json!({"ironing_type": "top"})),
        "ironing_flow",
        20,
    );
}

#[test]
fn filament_ironing_flow_reads_a_percent_sign() {
    let setup = Setup::on(cube(), &json!({"ironing_type": "top"}));
    percent_reads_as_its_number(&setup, "filament_ironing_flow", 20);
}

/// Wipes on every retraction, and a retraction at every layer change.
fn wiping() -> Setup {
    Setup::on(
        cube(),
        &json!({"wipe": [true], "wipe_distance": [2], "retract_when_changing_layer": [true]}),
    )
}

#[test]
fn retract_before_wipe_reads_a_percent_sign() {
    percent_reads_as_its_number(&wiping(), "retract_before_wipe", 50);
}

#[test]
fn filament_retract_before_wipe_reads_a_percent_sign() {
    percent_reads_as_its_number(&wiping(), "filament_retract_before_wipe", 50);
}

#[test]
fn filament_shrink_reads_a_percent_sign() {
    percent_reads_as_its_number(&Setup::on(cube(), &json!({})), "filament_shrink", 98);
}

#[test]
fn filament_shrinkage_compensation_z_reads_a_percent_sign() {
    percent_reads_as_its_number(
        &Setup::on(cube(), &json!({})),
        "filament_shrinkage_compensation_z",
        90,
    );
}

#[test]
fn accel_to_decel_factor_reads_a_percent_sign() {
    let mut setup = Setup::on(
        cube(),
        &json!({"default_acceleration": 5000, "outer_wall_acceleration": 3000, "inner_wall_acceleration": 4000}),
    );
    setup.options = json!({"flavor": "klipper"});
    percent_reads_as_its_number(&setup, "accel_to_decel_factor", 60);
}

/// Arachne walls on the wedge.
fn arachne() -> Setup {
    Setup::on(wedge(), &json!({"wall_generator": "arachne"}))
}

#[test]
fn min_feature_size_reads_a_percent_sign() {
    percent_reads_as_its_number(&arachne(), "min_feature_size", 50);
}

#[test]
fn min_bead_width_reads_a_percent_sign() {
    percent_reads_as_its_number(&arachne(), "min_bead_width", 50);
}

#[test]
fn initial_layer_min_bead_width_reads_a_percent_sign() {
    percent_reads_as_its_number(&arachne(), "initial_layer_min_bead_width", 50);
}

#[test]
fn wall_transition_length_reads_a_percent_sign() {
    percent_reads_as_its_number(&arachne(), "wall_transition_length", 200);
}

#[test]
fn wall_transition_filter_deviation_reads_a_percent_sign() {
    // A 10 mm bar that bulges from 1.6 to 2.2 mm wide and back: two wall transitions close together, the case the
    // filter deviation decides.
    let bump = prism(
        &[[0.0, 0.0], [10.0, 0.0], [10.0, 1.6], [5.0, 2.2], [0.0, 1.6]],
        1.0,
    );
    let setup = Setup::on(bump, &json!({"wall_generator": "arachne"}));
    percent_reads_as_its_number(&setup, "wall_transition_filter_deviation", 100);
}

#[test]
fn bridge_density_reads_a_percent_sign() {
    percent_reads_as_its_number(&Setup::on(table(), &json!({})), "bridge_density", 50);
}

#[test]
fn support_ironing_flow_reads_a_percent_sign() {
    let setup = Setup::on(
        table(),
        &json!({"enable_support": true, "support_type": "normal(auto)", "independent_support_layer_height": 0,
               "support_ironing": true, "support_ironing_spacing": 0.15}),
    );
    percent_reads_as_its_number(&setup, "support_ironing_flow", 30);
}

#[test]
fn tree_support_top_rate_reads_a_percent_sign() {
    let setup = Setup::on(
        table(),
        &json!({"enable_support": true, "support_type": "tree(auto)", "support_style": "organic",
               "organic_support_engine": "v2"}),
    );
    percent_reads_as_its_number(&setup, "tree_support_top_rate", 60);
}

#[test]
fn prime_tower_infill_gap_reads_a_percent_sign() {
    percent_reads_as_its_number(&a1_tower(), "prime_tower_infill_gap", 200);
}

#[test]
fn wipe_tower_extra_flow_reads_a_percent_sign() {
    percent_reads_as_its_number(&mk4_tower(), "wipe_tower_extra_flow", 120);
}

#[test]
fn wipe_tower_extra_spacing_reads_a_percent_sign() {
    percent_reads_as_its_number(&mk4_tower(), "wipe_tower_extra_spacing", 150);
}
