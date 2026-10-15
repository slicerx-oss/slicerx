// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A skirt round the whole plate goes round the prime tower too, so the tower keeps the skirt's distance and
//! width from the bed edge. A full A1 plate (39.7 x 23.3 x 14.5 mm parts in three filaments, each part's own
//! skirt room kept, as Arrange and Fill bed leave it) has room for the tower only in strips along the edges. The
//! tower used to stand 1 mm from the edge there, and the skirt round it left the bed, which the safety check
//! refused.

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

const BED: f64 = 256.0;
const PART: [f64; 3] = [39.7, 23.3, 14.5];

/// An ASCII STL of a box from the origin to `size`.
fn box_stl(size: [f64; 3]) -> Vec<u8> {
    use std::fmt::Write as _;
    let corner = |index: usize| {
        std::array::from_fn::<f64, 3, _>(|axis| if index >> axis & 1 == 0 { 0.0 } else { size[axis] })
    };
    // Two outward triangles per face, by corner index (bit 0 x, bit 1 y, bit 2 z).
    let faces: [[usize; 3]; 12] = [
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
    ];
    let mut text = String::from("solid box\n");
    for face in faces {
        text.push_str(" facet normal 0 0 0\n  outer loop\n");
        for index in face {
            let [x, y, z] = corner(index);
            let _ = writeln!(text, "   vertex {x} {y} {z}");
        }
        text.push_str("  endloop\n endfacet\n");
    }
    text.push_str("endsolid box\n");
    text.into_bytes()
}

/// The stock A1 configuration from the CLI fixture, in three filaments, with a skirt and the prime tower on.
fn a1_three_filaments() -> Value {
    let path = format!(
        "{}/cli/tests/fixtures/xmark-2color-a1-request.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let req: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut cfg = req["config"].clone();
    // Per-filament lists of two get a third entry like the second.
    for v in cfg.as_object_mut().unwrap().values_mut() {
        if let Some(a) = v.as_array_mut()
            && a.len() == 2
        {
            let last = a[1].clone();
            a.push(last);
        }
    }
    for (k, v) in [
        ("filament_colour", json!(["#F4EE2A", "#00AE42", "#1E5AA8"])),
        ("skirt_loops", json!(1)),
        ("skirt_distance", json!(2)),
        ("skirt_height", json!(1)),
        ("brim_type", json!("no_brim")),
        ("brim_width", json!(0)),
        ("enable_prime_tower", json!(true)),
        ("prime_tower_width", json!(35)),
        ("prime_tower_brim_width", json!(3)),
        ("layer_height", json!(0.3)),
    ] {
        cfg[k] = v;
    }
    cfg
}

/// Front left corners of a filled bed: five columns and nine rows 1.5 mm apart, from 8.5 mm off the front left
/// corner (the skirt's room plus the safety). The strips at the back and the right edge are what is left for the tower.
fn layout() -> Vec<[f64; 2]> {
    let edge = 8.5;
    (0..9)
        .flat_map(|r| {
            (0..5).map(move |c| {
                [
                    edge + f64::from(c) * (PART[0] + 1.5),
                    edge + f64::from(r) * (PART[1] + 1.5),
                ]
            })
        })
        .collect()
}

/// The first layer's extruding moves, as the feature and the end point.
fn first_layer(gcode: &str) -> Vec<(String, [f64; 2])> {
    let (mut feature, mut layer, mut out) = (String::new(), 0, Vec::new());
    let mut at = [0.0, 0.0];
    for line in gcode.lines() {
        if line.starts_with(";LAYER_CHANGE") || line.starts_with("; CHANGE_LAYER") {
            layer += 1;
            if layer > 1 {
                break;
            }
        }
        if let Some(name) = line
            .strip_prefix("; FEATURE: ")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            name.trim().clone_into(&mut feature);
        }
        if layer == 0 || !line.starts_with("G1 ") {
            continue;
        }
        let word = |axis: char| {
            line.split_whitespace().find_map(|token| {
                token
                    .strip_prefix(axis)
                    .and_then(|value| value.parse::<f64>().ok())
            })
        };
        at = [word('X').unwrap_or(at[0]), word('Y').unwrap_or(at[1])];
        if word('E').is_some_and(|extruded| extruded > 0.0) {
            out.push((feature.clone(), at));
        }
    }
    out
}

#[test]
fn a_full_a1_plate_keeps_the_skirt_round_the_tower_on_the_bed() {
    let objects: Vec<Value> = layout()
        .iter()
        .enumerate()
        .map(|(index, corner)| {
            json!({"id": format!("o{index}"), "name": format!("part {}", index + 1), "mesh": "box",
                   "slotOverrides": {"box": index % 3 + 1, "box.stl": index % 3 + 1, "": index % 3 + 1},
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, corner[0], corner[1], 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": BED, "depthMm": BED, "heightMm": BED}, "objects": objects},
        "config": a1_three_filaments(),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let m = Arc::new(Mesh::load(&box_stl(PART), "box.stl").unwrap());
    let run = match api::run_request(&req, &move |_: &str| Ok(m.clone())) {
        Ok(run) => run,
        Err(err) => panic!("the plate was refused: {err}"),
    };
    let moves = first_layer(&String::from_utf8_lossy(&run.gcode));
    let of = |name: &str| -> Vec<[f64; 2]> {
        moves
            .iter()
            .filter(|step| step.0.to_lowercase().contains(name))
            .map(|step| step.1)
            .collect()
    };
    let (skirt, tower) = (of("skirt"), of("tower"));
    let span = |pts: &[[f64; 2]]| {
        pts.iter()
            .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |acc, pt| {
                [
                    acc[0].min(pt[0]),
                    acc[1].min(pt[1]),
                    acc[2].max(pt[0]),
                    acc[3].max(pt[1]),
                ]
            })
    };
    assert!(
        !tower.is_empty(),
        "the plate prints a prime tower; features: {:?}",
        moves
            .iter()
            .map(|step| step.0.as_str())
            .collect::<std::collections::BTreeSet<_>>()
    );
    assert!(!skirt.is_empty(), "the plate prints a skirt");
    for point in &skirt {
        assert!(
            (0.0..=BED).contains(&point[0]) && (0.0..=BED).contains(&point[1]),
            "skirt point off the bed at {point:?}"
        );
    }
    // The tower stands in a strip along the right or back edge, and the skirt goes round it there.
    let (tower_box, skirt_box) = (span(&tower), span(&skirt));
    assert!(
        tower_box[0] > 205.0 || tower_box[1] > 225.0,
        "the tower stands in a strip at the edge, not at {tower_box:?}"
    );
    assert!(
        skirt_box[2] > tower_box[2] || skirt_box[3] > tower_box[3],
        "the skirt goes round the tower: skirt {skirt_box:?}, tower {tower_box:?}"
    );
}
