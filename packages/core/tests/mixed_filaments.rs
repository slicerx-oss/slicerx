// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Mixed filaments (`mixed_filaments`): a part on a mixed filament prints each layer in one of the mix's two loaded
//! filaments, in the pattern its ratio gives, with an ordinary tool change wherever the filament changes. A plate
//! without one prints as before.

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{Mesh, MeshPart, SliceRequest, SliceRun};

/// A box from `lo` to `hi`, mm, on filament `slot`.
fn cuboid(lo: [f32; 3], hi: [f32; 3], slot: u8) -> MeshPart {
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
        name: "box".into(),
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
        ..MeshPart::default()
    }
}

/// A 12 mm box 3 mm tall on filament `slot`.
fn block(slot: u8) -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "block".into(),
        parts: vec![cuboid([0.0, 0.0, 0.0], [12.0, 12.0, 3.0], slot)],
        ..Mesh::default()
    })
}

/// The block on filament `slot` with two filaments loaded and `extra` settings, sliced.
fn slice(slot: u8, extra: &Value) -> SliceRun {
    let mut config = json!({
        "filament_colour": ["#E02020", "#2040E0"],
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "brim_width": 0,
        "skirt_loops": 0,
    });
    if let (Some(c), Some(e)) = (config.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "a", "name": "a", "mesh": "m",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]}]},
        "config": config,
    }))
    .unwrap();
    let mesh = block(slot);
    common::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap()
}

/// The tool each layer's object paths print with (`T0` for filament 1), one per layer; a layer printing the object
/// in two tools gives both, joined.
fn layer_tools(run: &SliceRun) -> Vec<String> {
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    let mut out: Vec<Vec<String>> = Vec::new();
    let (mut tool, mut feature) = (String::from("T0"), String::new());
    for l in g.lines() {
        if l.starts_with(";LAYER_CHANGE") {
            out.push(Vec::new());
        } else if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut feature);
        } else if l
            .strip_prefix('T')
            .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        {
            l.clone_into(&mut tool);
        } else if let Some(layer) = out.last_mut()
            && l.starts_with("G1 ")
            && (l.contains(" X") || l.contains(" Y"))
            && l.split_whitespace().any(|w| {
                w.strip_prefix('E')
                    .and_then(|e| e.parse::<f64>().ok())
                    .is_some_and(|e| e > 0.0)
            })
            && !matches!(feature.as_str(), "Prime tower" | "Wipe tower" | "Custom" | "")
            && layer.last() != Some(&tool)
        {
            layer.push(tool.clone());
        }
    }
    out.into_iter()
        .filter(|l| !l.is_empty())
        .map(|l| l.join("+"))
        .collect()
}

/// The tools of layers 0 to `n - 1` for a mix of filaments 1 and 2 that prints `pattern` (A for 1, B for 2), cycled.
fn expected(pattern: &str, n: usize) -> Vec<String> {
    pattern
        .chars()
        .cycle()
        .take(n)
        .map(|c| {
            if c == 'A' {
                "T0".to_owned()
            } else {
                "T1".to_owned()
            }
        })
        .collect()
}

#[test]
fn each_layer_prints_the_filament_the_ratio_gives_it() {
    for (ratio, pattern) in [("1,1", "AB"), ("2,1", "AAB"), ("3,2", "AABAB"), ("1,2", "ABB")] {
        let run = slice(3, &json!({"mixed_filaments": [format!("3:1,2:{ratio}:Mix")]}));
        let tools = layer_tools(&run);
        assert_eq!(tools.len(), 15, "{ratio}: {tools:?}");
        assert_eq!(tools, expected(pattern, tools.len()), "ratio {ratio}");
    }
}

#[test]
fn a_mix_counts_one_tool_change_per_switch_of_filament() {
    for (ratio, pattern) in [("1,1", "AB"), ("2,1", "AAB"), ("3,2", "AABAB")] {
        let run = slice(3, &json!({"mixed_filaments": [format!("3:1,2:{ratio}")]}));
        let want = expected(pattern, 15);
        let switches = want.windows(2).filter(|w| w[0] != w[1]).count();
        assert_eq!(run.report.stats.tool_changes as usize, switches, "ratio {ratio}");
        // Both filaments print, by the ratio's share of the layers.
        let mm = &run.report.stats.filament_mm;
        assert!(mm.len() >= 2 && mm[0] > 0.0 && mm[1] > 0.0, "{mm:?}");
    }
}

#[test]
fn the_same_plate_gives_the_same_bytes() {
    let mix = json!({"mixed_filaments": ["3:1,2:3,2:Mix"], "enable_prime_tower": true});
    let first = slice(3, &mix);
    assert_eq!(layer_tools(&first), expected("AABAB", 15));
    assert_eq!(first.gcode, slice(3, &mix).gcode);
}

/// The error a slice of `mesh` with `config` refuses with.
fn refusal(mesh: Arc<Mesh>, config: &Value) -> String {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "a", "name": "a", "mesh": "m"}]},
        "config": config,
    }))
    .unwrap();
    common::run_request(&req, &move |_: &str| Ok(mesh.clone()))
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default()
}

#[test]
fn a_used_mix_numbered_like_a_loaded_filament_or_of_one_not_loaded_is_refused() {
    let three = json!(["#E02020", "#2040E0", "#20E040"]);
    let two = json!(["#E02020", "#2040E0"]);
    // Mix 2 of filaments 1 and 3, with three loaded and a part on 2: the number is a loaded filament's.
    let e = refusal(
        block(2),
        &json!({"filament_colour": three, "mixed_filaments": ["2:1,3:1,1"]}),
    );
    assert!(
        e.contains("mixed filament 2 has the number of loaded filament 2"),
        "{e}"
    );
    // Mix 3 of filaments 1 and 4 with two loaded, used by a part, then by paint alone.
    let e = refusal(
        block(3),
        &json!({"filament_colour": two, "mixed_filaments": ["3:1,4:1,1"]}),
    );
    assert!(
        e.contains("mixed filament 3 uses filament 4, but only 2 are loaded"),
        "{e}"
    );
    let painted = painted_box([0.0; 3], [12.0, 12.0, 3.0], 1, Some(3));
    let e = refusal(
        painted,
        &json!({"filament_colour": two, "mixed_filaments": ["3:1,4:1,1"]}),
    );
    assert!(
        e.contains("mixed filament 3 uses filament 4, but only 2 are loaded"),
        "{e}"
    );
}

#[test]
fn a_plate_without_a_mix_prints_as_before() {
    // The setting with no entries is no mix: the paths are those of the plain plate.
    let plain = slice(1, &json!({}));
    let none = slice(1, &json!({"mixed_filaments": []}));
    assert_eq!(layer_tools(&plain), layer_tools(&none));
    let strip = |r: &SliceRun| -> String {
        String::from_utf8(r.gcode.clone())
            .unwrap()
            .lines()
            .filter(|l| !l.starts_with("; mixed_filaments"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert_eq!(strip(&plain), strip(&none));
    // A mix nothing on the plate uses changes nothing either.
    let unused = slice(1, &json!({"mixed_filaments": ["3:1,2:1,1"]}));
    let strip_all = |r: &SliceRun| -> String {
        strip(r)
            .lines()
            .filter(|l| !l.contains("mixed_filaments"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert_eq!(strip_all(&plain), strip_all(&unused));
}

// ---- the other ways a region gets its filament ------------------------------------------------------------------

/// The settings every test below slices with: two filaments loaded, object labels in the G-code, `extra` over them.
fn config(extra: &Value) -> Value {
    let mut c = json!({
        "filament_colour": ["#E02020", "#2040E0"],
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2,
        "brim_width": 0,
        "skirt_loops": 0,
        "gcode_comments": true,
        "gcode_label_objects": true,
    });
    if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
        c.extend(e.clone());
    }
    c
}

/// A plate of `objects` (request JSON) with meshes by id from `meshes`, sliced with `config(extra)`.
fn slice_plate(objects: &Value, meshes: Vec<(&'static str, Arc<Mesh>)>, extra: &Value) -> SliceRun {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": config(extra),
    }))
    .unwrap();
    common::run_request(&req, &move |id: &str| {
        Ok(meshes
            .iter()
            .find(|(m, _)| *m == id)
            .map(|(_, m)| m.clone())
            .unwrap())
    })
    .unwrap_or_else(|e| panic!("slice failed: {e}"))
}

fn at(x: f32, y: f32) -> Value {
    json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1])
}

/// Per layer, the tools each object's own paths print with (support, raft and the tower left out), by object name.
fn object_tools(run: &SliceRun) -> Vec<Vec<(String, Vec<String>)>> {
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    let mut out: Vec<Vec<(String, Vec<String>)>> = Vec::new();
    let (mut tool, mut feature, mut object) = (String::from("T0"), String::new(), String::new());
    for l in g.lines() {
        if l.starts_with(";LAYER_CHANGE") {
            out.push(Vec::new());
        } else if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut feature);
        } else if let Some(rest) = l.strip_prefix("; printing object ") {
            rest.split_whitespace()
                .next()
                .unwrap_or("")
                .clone_into(&mut object);
        } else if l.starts_with("; stop printing object") {
            object.clear();
        } else if l
            .strip_prefix('T')
            .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        {
            l.clone_into(&mut tool);
        } else if let Some(layer) = out.last_mut()
            && !object.is_empty()
            && l.starts_with("G1 ")
            && (l.contains(" X") || l.contains(" Y"))
            && l.split_whitespace().any(|w| {
                w.strip_prefix('E')
                    .and_then(|e| e.parse::<f64>().ok())
                    .is_some_and(|e| e > 0.0)
            })
            && !feature.contains("upport")
            && !feature.contains("aft")
            && !matches!(feature.as_str(), "Prime tower" | "Wipe tower" | "Custom" | "")
        {
            match layer.iter_mut().find(|(o, _)| *o == object) {
                Some((_, t)) if t.contains(&tool) => {}
                Some((_, t)) => t.push(tool.clone()),
                None => layer.push((object.clone(), vec![tool.clone()])),
            }
        }
    }
    out
}

/// The tools object `name` prints its own paths with, one entry per layer it prints on, each sorted and joined.
fn tools_of(run: &SliceRun, name: &str) -> Vec<String> {
    object_tools(run)
        .into_iter()
        .filter_map(|l| {
            l.into_iter().find(|(o, _)| o == name).map(|(_, mut t)| {
                t.sort();
                t.join("+")
            })
        })
        .collect()
}

/// A box on filament `slot` from `lo` to `hi`, with its +X face painted `state` when given.
fn painted_box(lo: [f32; 3], hi: [f32; 3], slot: u8, state: Option<u8>) -> Arc<Mesh> {
    let mut part = cuboid(lo, hi, slot);
    if let Some(s) = state {
        let text = if s >= 3 {
            format!("{:X}C", s - 3)
        } else {
            format!("{:X}", s << 2)
        };
        for (i, t) in (0u32..).zip(part.triangles.clone()) {
            let v = t.map(|k| part.positions[k as usize]);
            if v.iter().any(|p| (p[0] - hi[0]).abs() > 1e-6) {
                continue;
            }
            part.paint.push(sx_core::paint::PaintFacet { v, state: s });
            part.paint_texts.push((0, i, text.clone()));
        }
    }
    Arc::new(Mesh {
        name: "box".into(),
        parts: vec![part],
        ..Mesh::default()
    })
}

#[test]
fn paint_in_a_mix_and_paint_on_a_mixed_part_follow_the_ratio() {
    // A part on filament 1 with one side painted in mix 3 (1:1 of filaments 1 and 2): that side alternates and the
    // rest stays on the part's own filament, so a layer of the mix's second filament prints both.
    let mixed_paint = slice_plate(
        &json!([{"id": "a", "name": "a", "mesh": "p", "transform": at(100.0, 100.0)}]),
        vec![("p", painted_box([0.0; 3], [12.0, 12.0, 6.0], 1, Some(3)))],
        &json!({"mixed_filaments": ["3:1,2:1,1"]}),
    );
    let t = tools_of(&mixed_paint, "a");
    assert_eq!(t.len(), 30, "{t:?}");
    for (l, tools) in t.iter().enumerate().take(24).skip(6) {
        assert_eq!(tools, if l % 2 == 0 { "T0" } else { "T0+T1" }, "layer {l}: {t:?}");
    }
    assert!(!t.iter().any(|s| s.contains("T2")), "{t:?}");
    // A part on mix 3 with one side painted in filament 2: that side stays on filament 2, the rest alternates.
    let painted_mix = slice_plate(
        &json!([{"id": "a", "name": "a", "mesh": "p", "transform": at(100.0, 100.0)}]),
        vec![("p", painted_box([0.0; 3], [12.0, 12.0, 6.0], 3, Some(2)))],
        &json!({"mixed_filaments": ["3:1,2:1,1"]}),
    );
    let t = tools_of(&painted_mix, "a");
    for (l, tools) in t.iter().enumerate().take(24).skip(6) {
        assert_eq!(tools, if l % 2 == 0 { "T0+T1" } else { "T1" }, "layer {l}: {t:?}");
    }
}

#[test]
fn an_unused_mix_never_stops_a_slice() {
    // A mix of filaments 3 and 4 made ahead of time on a plate that loads 2: nothing uses it, so the slice goes on.
    let run = slice(1, &json!({"mixed_filaments": ["18:3,4:1,1:Later"]}));
    assert!(layer_tools(&run).iter().all(|t| t == "T0"));
}

#[test]
fn a_modifier_on_a_mixed_part_keeps_the_pattern() {
    let modifier = Arc::new(Mesh {
        name: "mod".into(),
        parts: vec![cuboid([0.0; 3], [6.0, 12.0, 3.0], 1)],
        ..Mesh::default()
    });
    let run = slice_plate(
        &json!([{"id": "a", "name": "a", "mesh": "m", "transform": at(100.0, 100.0),
                 "volumes": [{"role": "modifier", "mesh": "v", "settings": {"wall_loops": 4, "sparse_infill_density": "40%"}}]}]),
        vec![("m", block(3)), ("v", modifier)],
        &json!({"mixed_filaments": ["3:1,2:2,1"]}),
    );
    assert_eq!(tools_of(&run, "a"), expected("AAB", 15));
}

#[test]
fn a_raft_and_a_thicker_first_layer_start_the_pattern_at_the_object_s_first_layer() {
    // 2:1 over a two-layer raft: counted from the raft, the object's first layer would be the cycle's third (B).
    let run = slice_plate(
        &json!([{"id": "a", "name": "a", "mesh": "m", "transform": at(100.0, 100.0)}]),
        vec![("m", block(3))],
        &json!({"mixed_filaments": ["3:1,2:2,1"], "raft_layers": 2, "initial_layer_print_height": 0.3}),
    );
    let t = tools_of(&run, "a");
    assert!(t.len() >= 14, "{t:?}");
    assert_eq!(t, expected("AAB", t.len()));
    // The raft's own layers print on one filament.
    let all = layer_tools(&run);
    assert_eq!(all.len(), t.len() + 2, "{all:?}");
    assert_eq!(&all[..2], ["T0", "T0"]);
}

#[test]
fn support_on_a_mixed_object_prints_with_its_own_filaments() {
    // A T: a column under a slab whose arms overhang, on mix 3 (2:1), support base on filament 1 and its interface on 2.
    let tee = Arc::new(Mesh {
        name: "tee".into(),
        parts: vec![
            cuboid([10.0, 0.0, 0.0], [20.0, 10.0, 6.0], 3),
            cuboid([0.0, 0.0, 6.0], [30.0, 10.0, 8.0], 3),
        ],
        ..Mesh::default()
    });
    let run = slice_plate(
        &json!([{"id": "a", "name": "a", "mesh": "t", "transform": at(90.0, 100.0)}]),
        vec![("t", tee)],
        &json!({"mixed_filaments": ["3:1,2:2,1"], "enable_support": true, "support_type": "normal(auto)",
                "support_filament": 1, "support_interface_filament": 2}),
    );
    let t = tools_of(&run, "a");
    assert_eq!(t, expected("AAB", t.len()));
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    assert!(g.contains(";TYPE:Support"), "no support printed");
}

#[test]
fn two_objects_on_one_mix_each_follow_the_pattern_by_layer_and_by_object() {
    let objects = json!([
        {"id": "a", "name": "a", "mesh": "m", "transform": at(40.0, 100.0)},
        {"id": "b", "name": "b", "mesh": "m", "transform": at(170.0, 100.0)},
    ]);
    for sequence in ["by layer", "by object"] {
        let run = slice_plate(
            &objects,
            vec![("m", block(3))],
            &json!({"mixed_filaments": ["3:1,2:3,2"], "print_sequence": sequence}),
        );
        for o in ["a", "b"] {
            assert_eq!(tools_of(&run, o), expected("AABAB", 15), "{sequence}, object {o}");
        }
    }
    // An object with layers of its own counts its own layers: each object's pattern starts at its first layer.
    // (Printed layer by layer, such a plate needs a prime tower for its changes, and a tower needs one layer height,
    // so the plate prints by object.)
    let own = json!([
        {"id": "a", "name": "a", "mesh": "m", "transform": at(40.0, 100.0)},
        {"id": "b", "name": "b", "mesh": "m", "transform": at(170.0, 100.0), "settings": {"layer_height": 0.1}},
    ]);
    let run = slice_plate(
        &own,
        vec![("m", block(3))],
        &json!({"mixed_filaments": ["3:1,2:1,1"], "print_sequence": "by object"}),
    );
    let a = tools_of(&run, "a");
    let b = tools_of(&run, "b");
    assert_eq!(a, expected("AB", 15));
    assert_eq!(b, expected("AB", b.len()));
    assert!(b.len() > 25, "{b:?}");
}

#[test]
fn a_plate_without_mixes_keeps_paint_on_a_filament_past_its_parts() {
    // Object a on filament 1, object b on 2 with one side painted in 3, and two filaments set up: as on a plate
    // before mixes, the paint prints with tool 3, and an empty mixed_filaments changes nothing.
    let objects = json!([
        {"id": "a", "name": "a", "mesh": "a", "transform": at(60.0, 100.0)},
        {"id": "b", "name": "b", "mesh": "b", "transform": at(140.0, 100.0)},
    ]);
    let meshes = || {
        vec![
            ("a", block(1)),
            ("b", painted_box([0.0; 3], [12.0, 12.0, 3.0], 2, Some(3))),
        ]
    };
    let run = slice_plate(&objects, meshes(), &json!({}));
    let b = tools_of(&run, "b");
    assert!(b.iter().any(|t| t.contains("T2")), "{b:?}");
    assert!(
        !run.report
            .warnings
            .iter()
            .any(|w| w.message.contains("Paint in filament"))
    );
    let empty = slice_plate(&objects, meshes(), &json!({"mixed_filaments": []}));
    let strip = |r: &SliceRun| -> String {
        String::from_utf8(r.gcode.clone())
            .unwrap()
            .lines()
            .filter(|l| !l.contains("mixed_filaments"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert_eq!(strip(&run), strip(&empty));
}

#[test]
fn on_a_plate_with_mixes_a_number_no_mix_or_filament_has_falls_back_with_a_warning() {
    // Mix 32 on the plate, two filaments loaded: a part left on 31 and paint left in 29 (mixes deleted while they
    // stayed) print in filament 1 and in the part's own filament, never tool 31 or 29.
    let run = slice_plate(
        &json!([
            {"id": "a", "name": "a", "mesh": "a", "transform": at(60.0, 100.0)},
            {"id": "b", "name": "b", "mesh": "b", "transform": at(140.0, 100.0)},
        ]),
        vec![
            ("a", block(31)),
            ("b", painted_box([0.0; 3], [12.0, 12.0, 3.0], 2, Some(29))),
        ],
        &json!({"mixed_filaments": ["32:1,2:1,1"]}),
    );
    assert!(
        tools_of(&run, "a").iter().all(|t| t == "T0"),
        "{:?}",
        tools_of(&run, "a")
    );
    assert!(
        tools_of(&run, "b").iter().all(|t| t == "T1"),
        "{:?}",
        tools_of(&run, "b")
    );
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    assert!(!g.lines().any(|l| l == "T30" || l == "T28"));
    let said = |text: &str| run.report.warnings.iter().any(|w| w.message.contains(text));
    assert!(
        said("A part on filament 31 prints in filament 1"),
        "{:?}",
        run.report.warnings
    );
    assert!(
        said("Paint in filament 29 prints in the part's own filament"),
        "{:?}",
        run.report.warnings
    );
}

#[test]
fn on_a_plate_with_mixes_a_filament_below_the_mix_numbers_prints_as_before() {
    // Mix 32 on the plate, two filaments loaded: a part on 3 and paint in 28 (below the numbers mixes take) still print
    // tool 3 (T2) and tool 28 (T27), as without mixes.
    let run = slice_plate(
        &json!([
            {"id": "a", "name": "a", "mesh": "a", "transform": at(60.0, 100.0)},
            {"id": "b", "name": "b", "mesh": "b", "transform": at(140.0, 100.0)},
        ]),
        vec![
            ("a", block(3)),
            ("b", painted_box([0.0; 3], [12.0, 12.0, 3.0], 2, Some(28))),
        ],
        &json!({"mixed_filaments": ["32:1,2:1,1"]}),
    );
    assert!(
        tools_of(&run, "a").iter().all(|t| t == "T2"),
        "{:?}",
        tools_of(&run, "a")
    );
    assert!(
        tools_of(&run, "b").iter().any(|t| t.contains("T27")),
        "{:?}",
        tools_of(&run, "b")
    );
    assert!(
        !run.report
            .warnings
            .iter()
            .any(|w| w.message.contains("prints in")),
        "{:?}",
        run.report.warnings
    );
}

#[test]
fn a_plate_without_mixes_keeps_every_filament_number() {
    // No mixes and two filaments set up: a part on 3 prints tool 3; a part on 18 and paint in 17 print 18 and 17.
    let objects = json!([
        {"id": "a", "name": "a", "mesh": "a", "transform": at(40.0, 100.0)},
        {"id": "b", "name": "b", "mesh": "b", "transform": at(100.0, 100.0)},
        {"id": "c", "name": "c", "mesh": "c", "transform": at(160.0, 100.0)},
    ]);
    let meshes = || {
        vec![
            ("a", block(3)),
            ("b", block(18)),
            ("c", painted_box([0.0; 3], [12.0, 12.0, 3.0], 1, Some(17))),
        ]
    };
    let run = slice_plate(&objects, meshes(), &json!({}));
    assert!(
        tools_of(&run, "a").iter().all(|t| t == "T2"),
        "{:?}",
        tools_of(&run, "a")
    );
    assert!(
        tools_of(&run, "b").iter().all(|t| t == "T17"),
        "{:?}",
        tools_of(&run, "b")
    );
    assert!(
        tools_of(&run, "c").iter().any(|t| t.contains("T16")),
        "{:?}",
        tools_of(&run, "c")
    );
    assert!(
        !run.report
            .warnings
            .iter()
            .any(|w| w.message.contains("prints in"))
    );
}

#[test]
fn with_more_than_16_filaments_loaded_a_number_past_16_is_a_filament() {
    // Twenty filaments loaded, with a mix listed that nothing uses: a part on 17 is filament 17 (T16), and paint in 16
    // is filament 16 (T15), with no warning.
    let colors: Vec<String> = (0..20).map(|i| format!("#{:02X}4080", i * 10)).collect();
    let run = slice_plate(
        &json!([
            {"id": "a", "name": "a", "mesh": "a", "transform": at(60.0, 100.0)},
            {"id": "b", "name": "b", "mesh": "b", "transform": at(140.0, 100.0)},
        ]),
        vec![
            ("a", block(17)),
            ("b", painted_box([0.0; 3], [12.0, 12.0, 3.0], 1, Some(16))),
        ],
        &json!({"filament_colour": colors, "mixed_filaments": ["32:1,2:1,1"]}),
    );
    assert!(
        tools_of(&run, "a").iter().all(|t| t == "T16"),
        "{:?}",
        tools_of(&run, "a")
    );
    assert!(
        tools_of(&run, "b").iter().any(|t| t.contains("T15")),
        "{:?}",
        tools_of(&run, "b")
    );
    assert!(
        !run.report
            .warnings
            .iter()
            .any(|w| w.message.contains("prints in"))
    );
}

/// The tools the paths of feature `kind` (`;TYPE:` name) print with, over the whole file.
fn feature_tools(run: &SliceRun, kind: &str) -> std::collections::BTreeSet<String> {
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    let (mut tool, mut feature) = (String::from("T0"), String::new());
    let mut out = std::collections::BTreeSet::new();
    for l in g.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut feature);
        } else if l
            .strip_prefix('T')
            .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        {
            l.clone_into(&mut tool);
        } else if feature == kind
            && l.starts_with("G1 ")
            && l.contains(" E")
            && (l.contains(" X") || l.contains(" Y"))
        {
            out.insert(tool.clone());
        }
    }
    out
}

#[test]
fn a_feature_filament_wins_over_the_mix_for_its_feature() {
    // A part on mix 3 (1:1 of filaments 1 and 2) with its outer wall set to filament 2: the outer wall prints in 2
    // on every layer, and the inner walls still follow the mix.
    let run = slice(
        3,
        &json!({"mixed_filaments": ["3:1,2:1,1"], "outer_wall_filament_id": 2}),
    );
    let outer = feature_tools(&run, "Outer wall");
    assert_eq!(outer.into_iter().collect::<Vec<_>>(), ["T1"]);
    let inner = feature_tools(&run, "Inner wall");
    assert_eq!(inner.into_iter().collect::<Vec<_>>(), ["T0", "T1"]);
}

#[test]
fn a_feature_filament_set_to_a_mix_is_refused() {
    // Sparse infill set to mix 3's number: a feature prints with one loaded filament, so the slice says so.
    let e = refusal(
        block(1),
        &json!({"mixed_filaments": ["3:1,2:1,1"], "sparse_infill_filament_id": 3}),
    );
    assert!(
        e.contains("sparse_infill_filament_id") && e.contains("mixed filament 3"),
        "{e}"
    );
}
