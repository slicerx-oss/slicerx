// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Organic tree supports on the clean-room engine (`organic_support_engine: "cleanroom"`), checked on
//! the generated test models: the engine stays off by default, support is made where it should be and
//! nowhere it should not, each compatibility flag works both ways, and contact loops still print.

#![allow(clippy::needless_pass_by_value, clippy::cast_possible_truncation)]
#![allow(clippy::disallowed_methods, reason = "test measurements of G-code; no output depends on them")]

mod common;

use common::organic_models::{self as models, Model};
use serde_json::{Value, json};
use std::sync::Arc;
use sx_core::api::{Mesh, SliceRequest, SliceRun};

type Moves = Vec<(f32, Vec<(bool, [f32; 2], [f32; 2])>)>;

fn slice_mesh(mesh: Mesh, at: [f32; 2], config: Value) -> SliceRun {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": { "objects": [{
            "id": "a",
            "mesh": "m",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], 0, 1]
        }] },
        "config": config,
        "options": {}
    }))
    .expect("request");
    let mesh = Arc::new(mesh);
    common::run_request(&req, &move |_: &str| Ok(mesh.clone())).expect("slices")
}

fn model(id: u32) -> Model {
    models::all().into_iter().find(|m| m.id == id).expect("model")
}

fn run(id: u32, extra: Value, quirks: &str) -> (SliceRun, Moves) {
    let m = model(id);
    let mut cfg = m.config.clone();
    if let (Some(dst), Some(src)) = (cfg.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    let r = slice_mesh(m.mesh, m.at, models::organic_config(&cfg, quirks));
    let moves = models::support_moves(&String::from_utf8_lossy(&r.gcode));
    (r, moves)
}

/// Every support point in plate coordinates with its layer Z.
fn points(moves: &Moves) -> impl Iterator<Item = (f32, [f32; 2])> + '_ {
    moves
        .iter()
        .flat_map(|(z, segs)| segs.iter().flat_map(move |&(_, a, b)| [(*z, a), (*z, b)]))
}

fn inside_bed(moves: &Moves) -> bool {
    points(moves).all(|(_, p)| (0.0..=256.0).contains(&p[0]) && (0.0..=256.0).contains(&p[1]))
}

#[test]
fn legacy_engine_stays_the_default() {
    let m = model(1);
    let organic = json!({
        "enable_support": true,
        "support_type": "tree(auto)",
        "support_style": "organic",
        "brim_width": 0
    });
    let mut legacy = organic.clone();
    legacy["organic_support_engine"] = json!("legacy");
    let a = slice_mesh(models::t_bar(), m.at, organic);
    let b = slice_mesh(models::t_bar(), m.at, legacy);
    assert_eq!(a.gcode, b.gcode, "no key and \"legacy\" give the same output");
    let (c, moves) = run(1, json!({}), "");
    assert_ne!(a.gcode, c.gcode, "the clean-room engine is a different engine");
    assert!(!moves.is_empty());
}

#[test]
fn t_bar_is_held_up_clear_of_the_model() {
    let (_, moves) = run(1, json!({}), "");
    assert!(inside_bed(&moves));
    // Support stands under both arms, from the bed up to one gap layer under the arm (z 20).
    let under_arm = |p: [f32; 2]| (p[0] - 128.0).abs() > 6.0 && (p[1] - 128.0).abs() < 5.0;
    let top = points(&moves)
        .filter(|&(_, p)| under_arm(p))
        .map(|(z, _)| z)
        .fold(0.0f32, f32::max);
    assert!(
        (top - 19.8).abs() < 0.05,
        "highest support under the arm at {top}"
    );
    assert!(
        points(&moves).any(|(z, p)| z < 0.5 && under_arm(p)),
        "trunks reach the bed"
    );
    // Clearance: no support line runs inside the column, grown by the minimum gap less a tolerance.
    for (z, p) in points(&moves) {
        let in_column = (p[0] - 128.0).abs() < 5.0 + 0.15 && (p[1] - 128.0).abs() < 5.0 + 0.15;
        assert!(
            !(in_column && z < 40.0),
            "support at {p:?} z {z} inside the column"
        );
        let in_arm = (p[0] - 128.0).abs() < 15.0 && (p[1] - 128.0).abs() < 5.0 && (20.0..23.0).contains(&z);
        assert!(!in_arm, "support at {p:?} z {z} inside the arm");
    }
}

#[test]
fn same_input_same_output() {
    let (a, _) = run(2, json!({}), "");
    let (b, _) = run(2, json!({}), "");
    assert_eq!(a.gcode, b.gcode);
}

#[test]
fn mushroom_gets_roof_layers_under_the_cap() {
    let (_, moves) = run(2, json!({ "support_interface_top_layers": 3 }), "");
    // Interface lines on the three layers under the cap's underside (z 15) less the one gap layer.
    for z in [14.8f32, 14.6, 14.4] {
        let iface = moves
            .iter()
            .filter(|(lz, _)| (lz - z).abs() < 0.01)
            .flat_map(|(_, s)| s.iter())
            .filter(|s| s.0)
            .count();
        assert!(iface > 0, "no interface at z {z}");
    }
}

/// Model 4 with 6 mm branches (`r_u` 3): the 6 mm hole is narrower than 2 `r_u` + 2 `G_xy`, and under the shelf
/// it is the only way to the bed. Tips over it are "bed" (not safe) and go down it at their small collision
/// radius, clipped to the hole (spec E7); every support line still keeps the gap from the hole's walls.
#[test]
fn hole_that_is_the_only_bed_path_is_used_with_clearance() {
    let (_, moves) = run(
        4,
        json!({ "tree_support_branch_diameter_organic": 6.0 }),
        "parity",
    );
    let in_hole: Vec<(f32, [f32; 2])> = points(&moves)
        .filter(|&(z, p)| z < 10.0 && (p[0] - 128.0).abs() < 3.0 && (p[1] - 128.0).abs() < 3.0)
        .collect();
    assert!(
        in_hole.iter().any(|&(z, _)| z < 0.5),
        "a trunk reaches the bed through the hole"
    );
    // Bead edge at least G_min (0.21) from the hole wall at 3 mm: centers within 3 - 0.21 - 0.21.
    for (z, p) in in_hole {
        let edge = (p[0] - 128.0).abs().max((p[1] - 128.0).abs());
        assert!(
            edge <= 3.0 - 0.42 + 0.03,
            "support at {p:?} z {z} too close to the hole wall"
        );
    }
}

/// A narrow hole (2 mm, under 2 `r_u` + 2 `G_xy` = 2.7) in a small box under a high shelf that reaches well past
/// it: tips over the hole can reach the bed around the box, so no branch enters the hole.
#[test]
fn narrow_hole_with_a_way_around_is_not_entered() {
    use models::cuboid;
    let mesh = Mesh {
        name: "hole-around".into(),
        parts: vec![
            cuboid("w", [-4.0, -4.0, 0.0], [-1.0, 4.0, 10.0]),
            cuboid("e", [1.0, -4.0, 0.0], [4.0, 4.0, 10.0]),
            cuboid("s", [-1.0, -4.0, 0.0], [1.0, -1.0, 10.0]),
            cuboid("n", [-1.0, 1.0, 0.0], [1.0, 4.0, 10.0]),
            cuboid("post", [14.0, -2.0, 0.0], [18.0, 2.0, 22.0]),
            cuboid("shelf", [-6.0, -6.0, 20.0], [18.0, 6.0, 22.0]),
        ],
        ..Mesh::default()
    };
    let r = slice_mesh(mesh, [128.0, 128.0], models::organic_config(&json!({}), "parity"));
    let moves = models::support_moves(&String::from_utf8_lossy(&r.gcode));
    assert!(!moves.is_empty());
    for (z, p) in points(&moves) {
        let in_hole = (p[0] - 128.0).abs() < 1.0 && (p[1] - 128.0).abs() < 1.0;
        assert!(!(in_hole && z < 10.0), "support at {p:?} z {z} inside the hole");
    }
}

#[test]
fn branches_rest_on_the_block_unless_bed_only() {
    // Under the deck, over the block (top at z 10).
    let on_block = |p: [f32; 2]| (p[0] - 128.0).abs() < 11.0 && (p[1] - 128.0).abs() < 5.0;
    let (_, moves) = run(5, json!({}), "");
    assert!(
        points(&moves).any(|(z, p)| on_block(p) && z > 10.0 && z < 11.0),
        "support stands on the block's top"
    );
    assert!(
        moves
            .iter()
            .filter(|(z, _)| *z > 10.0 && *z < 11.0)
            .flat_map(|(_, s)| s.iter())
            .any(|s| s.0 && on_block(s.1)),
        "bottom contact (interface) on the block's top"
    );
    let (_, moves) = run(5, json!({ "support_on_build_plate_only": true }), "");
    assert!(
        !points(&moves).any(|(z, p)| on_block(p) && z > 10.0 && z < 11.0),
        "build plate only: nothing on the block"
    );
}

#[test]
fn contact_loops_print_on_the_cleanroom_path() {
    let iface_len = |moves: &Moves| -> f32 {
        moves
            .iter()
            .flat_map(|(_, s)| s.iter())
            .filter(|s| s.0)
            .map(|s| (s.2[0] - s.1[0]).hypot(s.2[1] - s.1[1]))
            .sum()
    };
    let (_, plain) = run(1, json!({ "support_interface_loop_pattern": false }), "");
    let (_, looped) = run(1, json!({ "support_interface_loop_pattern": true }), "");
    assert!(
        (iface_len(&plain) - iface_len(&looped)).abs() > 1.0,
        "contact loops change the interface: {} vs {}",
        iface_len(&plain),
        iface_len(&looped)
    );
}

/// Each compatibility flag, off and on, gives support inside the bed on the T-bar (and on the model the
/// flag is about).
#[test]
fn every_flag_works_both_ways() {
    for (flag, id) in [
        ("nudge_squared", 1),
        ("roof_angle_fixed", 2),
        ("ignore_bed_edge", 9),
        ("merge_every_layer", 1),
        ("one_part_per_cluster_layer", 10),
        ("detection_guard", 13),
        ("foot_bonus_inverted", 1),
        ("placeable_double_gap", 5),
    ] {
        let (on, moves_on) = run(id, json!({}), &format!("none,{flag}"));
        let (off, moves_off) = run(id, json!({}), "none");
        assert!(
            !moves_on.is_empty() && !moves_off.is_empty(),
            "{flag}: support made"
        );
        assert!(
            inside_bed(&moves_on) && inside_bed(&moves_off),
            "{flag}: inside the bed"
        );
        let _ = (on, off);
    }
}

#[test]
fn parity_mode_runs() {
    let (_, moves) = run(1, json!({}), "parity");
    assert!(!moves.is_empty() && inside_bed(&moves));
}

#[test]
fn raft_model_has_trees_on_the_raft() {
    let (_, moves) = run(8, json!({}), "");
    assert!(!moves.is_empty() && inside_bed(&moves));
}

/// The tall tower (slow in a debug build).
#[test]
#[ignore = "slow in a debug build; run with --ignored in release"]
fn tall_tower_is_held_up() {
    let (_, moves) = run(7, json!({}), "");
    assert!(points(&moves).any(|(z, _)| z > 135.0));
    assert!(inside_bed(&moves));
}

/// Writes the models as STL with their settings, and the painted one as a 3MF too, for the runs against the
/// reference binary. Set `ORGANIC2_MODELS_DIR`.
#[test]
#[ignore = "writes files for parity runs"]
fn write_models() {
    let Some(dir) = std::env::var_os("ORGANIC2_MODELS_DIR") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("dir");
    for m in models::all() {
        let base = format!("{:02}-{}", m.id, m.name);
        std::fs::write(dir.join(format!("{base}.stl")), models::stl(&m.mesh, m.at)).expect("stl");
        // A painted model also goes out as a 3MF, which keeps the paint.
        if m.mesh.parts.iter().any(|p| !p.paint_texts.is_empty()) {
            std::fs::write(dir.join(format!("{base}.3mf")), models::threemf(&m.mesh, m.at)).expect("3mf");
        }
        let cfg = serde_json::to_string_pretty(&m.config).expect("json");
        std::fs::write(dir.join(format!("{base}.json")), cfg).expect("json");
    }
}

/// The painted model's 3MF loads back with the same support paint the model carries: enforced on the
/// column's face, blocked under the right arm, as the reference binary will read it.
#[test]
fn painted_3mf_keeps_its_support_paint() {
    let m = models::painted();
    let back = Mesh::load(&models::threemf(&m, [0.0, 0.0]), "12-painted.3mf").expect("loads");
    let states = |mesh: &Mesh| {
        let mut s: Vec<(u8, [[i32; 3]; 3])> = mesh
            .parts
            .iter()
            .flat_map(|p| &p.support_paint)
            .map(|f| (f.state, f.v.map(|v| v.map(|x| (x * 1000.0).round() as i32))))
            .collect();
        s.sort_unstable();
        s
    };
    let (want, got) = (states(&m), states(&back));
    assert_eq!(want.iter().filter(|f| f.0 == 1).count(), 2);
    assert_eq!(want.iter().filter(|f| f.0 == 2).count(), 2);
    assert_eq!(got, want);
}
