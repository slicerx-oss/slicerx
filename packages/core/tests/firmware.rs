// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What firmware reads from the G-code: object labels on a two object plate.

// Options and configs are built with `json!` at each call, so taking them by value reads best.
#![allow(clippy::needless_pass_by_value, clippy::many_single_char_names)]
// G-code readers compare parsed coordinates exactly and round feeds to whole numbers.
#![allow(
    clippy::float_cmp,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss
)]
// Checks measure the output with the standard math functions; the engine's own rounding rule (clippy.toml) is for G-code.
#![allow(clippy::disallowed_methods)]

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

/// Two copies of the reference part, centered on (70, 128) and (186, 128).
fn two_objects(config: Value, options: Value) -> SliceRun {
    two_objects_result(config, options).unwrap()
}

/// [`two_objects`], or the error the request gives.
fn two_objects_result(config: Value, options: Value) -> api::Result<SliceRun> {
    let m = mesh();
    let (lo, hi) = m.bounds().unwrap();
    let at = |cx: f64, cy: f64| {
        let mut t = [0.0f64; 16];
        t[0] = 1.0;
        t[5] = 1.0;
        t[10] = 1.0;
        t[15] = 1.0;
        t[12] = cx - f64::from(lo[0] + hi[0]) / 2.0;
        t[13] = cy - f64::from(lo[1] + hi[1]) / 2.0;
        t[14] = -f64::from(lo[2]);
        t
    };
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [
            {"id": "a", "name": "left part.stl", "mesh": "x", "transform": at(70.0, 128.0)},
            {"id": "b", "name": "right.stl", "mesh": "x", "transform": at(186.0, 128.0)},
        ]},
        "config": config,
        "options": options,
    }))
    .unwrap();
    common::run_request(&req, &move |_: &str| Ok(m.clone()))
}

fn text(r: &SliceRun) -> String {
    String::from_utf8(r.gcode.clone()).unwrap()
}

/// Labeled extrusion: every `G1 ... E` line must sit between a matching start and end.
fn assert_labeled(g: &str, start: &str, end: &str) {
    let mut open: Option<String> = None;
    let (mut labeled, mut outside) = (0, 0);
    for l in g.lines() {
        if let Some(n) = l.strip_prefix(start) {
            assert!(open.is_none(), "start inside start: {l}");
            open = Some(n.to_owned());
        } else if let Some(n) = l.strip_prefix(end) {
            assert_eq!(open.as_deref(), Some(n), "end without matching start: {l}");
            open = None;
        } else if l.starts_with("G1 X") && l.contains(" E") {
            if open.is_some() {
                labeled += 1;
            } else {
                outside += 1;
            }
        }
    }
    assert!(open.is_none(), "label left open");
    assert!(labeled > 1000, "labeled {labeled}");
    // Brim is not part of an object.
    assert!(outside > 0 && outside < labeled / 4, "outside {outside}");
}

#[test]
fn klipper_gets_exclude_object_around_each_objects_paths() {
    let mut c = base_config();
    c["gcode_flavor"] = json!("klipper");
    c["exclude_object"] = json!(true);
    let g = text(&two_objects(c, json!({})));
    let defines: Vec<&str> = g
        .lines()
        .filter(|l| l.starts_with("EXCLUDE_OBJECT_DEFINE"))
        .collect();
    assert_eq!(defines.len(), 2, "{defines:?}");
    assert!(defines[0].contains("NAME=left_part.stl_id_0_copy_0") && defines[0].contains("POLYGON=[["));
    assert!(defines[1].contains("NAME=right.stl_id_1_copy_0"));
    assert_labeled(&g, "EXCLUDE_OBJECT_START NAME=", "EXCLUDE_OBJECT_END NAME=");
    // Both objects appear on every printed layer.
    assert!(
        g.matches("EXCLUDE_OBJECT_START NAME=right.stl_id_1_copy_0")
            .count()
            > 20
    );
}

#[test]
fn marlin_gets_m486_and_octoprint_comments() {
    let mut c = base_config();
    c["gcode_flavor"] = json!("marlin2");
    c["exclude_object"] = json!(true);
    c["gcode_label_objects"] = json!(true);
    let g = text(&two_objects(c, json!({})));
    assert!(
        g.contains("M486 S0\nM486 Aleft_part.stl_id_0_copy_0\nM486 S-1\n"),
        "header"
    );
    let starts = g.lines().filter(|l| *l == "M486 S0" || *l == "M486 S1").count();
    let ends = g.lines().filter(|l| *l == "M486 S-1").count();
    assert!(starts > 20 && ends == starts, "{starts} {ends}");
    assert!(g.contains("; printing object left part.stl id:0 copy 0\n"));
    assert!(g.contains("; stop printing object right.stl id:1 copy 0\n"));
}

#[test]
fn bambu_printers_get_m624_labels_the_skip_dialog_can_read() {
    let mut c = base_config();
    c["gcode_flavor"] = json!("marlin");
    c["printer_model"] = json!("Bambu Lab X1 Carbon");
    let g = text(&two_objects(c, json!({})));
    assert!(g.contains("; model label id: 1,2\n"), "header");
    assert_labeled(
        &g,
        "; start printing object, unique label id: ",
        "; stop printing object, unique label id: ",
    );
    // Each start line is followed by the mask with the object's bit, each stop line by M625.
    let lines: Vec<&str> = g.lines().collect();
    let mut x_range = [[f64::MAX, f64::MIN]; 2];
    let mut open: Option<usize> = None;
    for (k, l) in lines.iter().enumerate() {
        if let Some(id) = l.strip_prefix("; start printing object, unique label id: ") {
            let mask = match id {
                "1" => "M624 AQAAAAAAAAA=",
                "2" => "M624 AgAAAAAAAAA=",
                _ => panic!("label id {id}"),
            };
            assert_eq!(lines[k + 1], mask);
            open = Some(id.parse::<usize>().unwrap() - 1);
        } else if l.starts_with("; stop printing object, unique label id: ") {
            assert_eq!(lines[k + 1], "M625");
            open = None;
        } else if let (Some(o), true) = (open, l.starts_with("G1 X") && l.contains(" E")) {
            let x: f64 = l[4..].split(' ').next().unwrap().parse().unwrap();
            x_range[o] = [x_range[o][0].min(x), x_range[o][1].max(x)];
        }
    }
    // Label 1 is the left part (centered on x 70), label 2 the right one (x 186).
    assert!(x_range[0][1] < 128.0 && x_range[1][0] > 128.0, "{x_range:?}");
    assert!(!g.contains("M486"));
}

#[test]
fn bambu_files_carry_orcas_blocks_and_progress_after_every_move() {
    // Orca's Bambu Lab layout (GCode::_do_export): the header block with the estimated time, the full
    // configuration block, then the executable block that opens with M73 P0 and closes after M73 P100.
    let mut c = base_config();
    c["gcode_flavor"] = json!("marlin");
    c["printer_model"] = json!("Bambu Lab A1");
    c["filament_settings_id"] = json!(["Bambu PLA Basic @BBL A1"]);
    c["change_filament_gcode"] = json!("M620 S[next_extruder]A\nT[next_extruder]");
    c["sparse_infill_density"] = json!(15);
    c["retract_before_wipe"] = json!([70, 0]);
    c["outer_wall_line_width"] = json!("0.42");
    let g = text(&two_objects(c, json!({})));
    let at = |s: &str| g.find(s).unwrap_or_else(|| panic!("no {s:?}"));
    assert_eq!(at("; HEADER_BLOCK_START\n"), 0);
    // Percent settings carry their sign, as Orca serializes coPercent and coPercents; others do not.
    assert!(g.contains("\n; sparse_infill_density = 15%\n"));
    assert!(g.contains("\n; retract_before_wipe = 70%,0%\n"));
    assert!(g.contains("\n; outer_wall_line_width = 0.42\n"));
    let estimate = g
        .lines()
        .find(|l| l.starts_with("; model printing time: "))
        .unwrap();
    assert!(estimate.contains("; total estimated time: "), "{estimate}");
    assert!(at("; estimated first layer printing time (normal mode) = ") < at("; total layer number: "));
    assert!(at("; HEADER_BLOCK_END\n") < at("; CONFIG_BLOCK_START\n"));
    // the line widths sit between the config and executable blocks
    assert!(g.contains("; CONFIG_BLOCK_END\n\n; external perimeters extrusion width = 0.42mm\n; perimeters extrusion width = "));
    assert!(
        g.contains("; top infill extrusion width = ") && !g.contains("; support material extrusion width")
    );
    assert!(at("; top infill extrusion width = ") < at("; EXECUTABLE_BLOCK_START\n"));
    assert!(g.contains("\n; filament_settings_id = \"Bambu PLA Basic @BBL A1\"\n"));
    assert!(g.contains("\n; change_filament_gcode = M620 S[next_extruder]A\\nT[next_extruder]\n"));
    assert!(at("; CONFIG_BLOCK_END\n") < at("; EXECUTABLE_BLOCK_START\nM73 P0 R"));
    assert!(at("M73 P100 R0\n; EXECUTABLE_BLOCK_END\n") > at("; EXECUTABLE_BLOCK_START\n"));
    assert!(!g.contains(";@P") && !g.contains("_GP_"));
    // Progress follows a move whenever its percent or minutes change, and never goes back.
    let lines: Vec<&str> = g.lines().collect();
    let mut last = (0u32, u32::MAX);
    let mut count = 0;
    for (k, l) in lines.iter().enumerate().skip(1) {
        let Some(rest) = l.strip_prefix("M73 P") else {
            continue;
        };
        let (p, r) = rest.split_once(" R").unwrap();
        let (p, r): (u32, u32) = (p.parse().unwrap(), r.parse().unwrap());
        if p < 100 {
            assert!(
                lines[k - 1].starts_with("G1 ")
                    || lines[k - 1].starts_with("G0 ")
                    || lines[k - 1].starts_with("G2 ")
                    || lines[k - 1].starts_with("G3 ")
                    || lines[k - 1] == "; EXECUTABLE_BLOCK_START",
                "line {k}: {}",
                lines[k - 1]
            );
        }
        assert!(p >= last.0 && r <= last.1, "{p} {r} after {last:?}");
        last = (p, r);
        count += 1;
    }
    assert!(count > 50, "{count} progress lines");
}

#[test]
fn bambu_files_use_orcas_bambu_tags() {
    // orca's processor writes its bambu tags for these printers (Reserved_Tags), which bambu studio reads
    let mut c = base_config();
    c["gcode_flavor"] = json!("marlin");
    c["printer_model"] = json!("Bambu Lab A1 mini");
    c["wipe"] = json!(true);
    c["machine_start_gcode"] = json!("G28");
    c["machine_end_gcode"] = json!("M104 S0\nM140 S0");
    let g = text(&two_objects(c, json!({})));
    let ls = layers(&g);
    assert!(ls.len() > 100);
    for l in &ls {
        assert!(
            l.starts_with("\n; Z_HEIGHT: ") && l.contains("\n; LAYER_HEIGHT: "),
            "{}",
            &l[..l.len().min(200)]
        );
    }
    assert!(g.contains("\n; FEATURE: Outer wall\n") && g.contains("\n; LINE_WIDTH: "));
    assert!(g.contains("\n; WIPE_START\n") && g.contains("\n; WIPE_END\n"));
    for old in [
        "\n;LAYER_CHANGE",
        "\n;Z:",
        "\n;HEIGHT:",
        "\n;TYPE:",
        "\n;WIDTH:",
        "\n;WIPE_",
    ] {
        assert!(!g.contains(old), "{old:?}");
    }
    // the custom role around the start and end g-code, and m981 s0 that tells the printer the print is done
    assert!(g.contains("\n; FEATURE: Custom\nG28\n"));
    assert!(g.contains("\nM981 S0 P20000 ; close spaghetti detector\n; FEATURE: Custom\n"));
    // the finished file's layer lines follow the bambu marker
    assert_eq!(sx_core::extras::layer_lines(&g).len(), ls.len());
}

/// The text of each layer, from its `;LAYER_CHANGE` (`; CHANGE_LAYER` on a Bambu Lab printer) to the next.
fn layers(g: &str) -> Vec<&str> {
    g.split(sx_core::extras::layer_mark(g)).skip(1).collect()
}

#[test]
fn bambu_timelapse_sits_in_the_layers_object_mask() {
    let mut c = base_config();
    c["gcode_flavor"] = json!("marlin");
    c["printer_model"] = json!("Bambu Lab X1 Carbon");
    c["time_lapse_gcode"] = json!("; lapse {layer_num}\nM971 S11 C10 O0");
    c["enable_wrapping_detection"] = json!(true);
    c["wrapping_detection_gcode"] = json!("; wrap {layer_num}");
    let g = text(&two_objects(c, json!({})));
    let ls = layers(&g);
    assert!(ls.len() > 100);
    for (i, l) in ls.iter().enumerate() {
        let n = i + 1;
        let block = format!(
            "; object ids of layer {n} start: 1,2\nM624 AwAAAAAAAAA=\n; lapse {i}\nM971 S11 C10 O0\n; object ids of this layer{n} end: 1,2\nM625\n; wrap {i}\n"
        );
        let at = l
            .find(&block)
            .unwrap_or_else(|| panic!("layer {i}: {}", &l[..l.len().min(600)]));
        // At the start of the layer, before any extrusion or object label.
        let before = &l[..at];
        assert!(
            !before.contains("unique label id")
                && !before.lines().any(|x| x.starts_with("G1 X") && x.contains(" E")),
            "layer {i}"
        );
    }
    assert_labeled(
        &g,
        "; start printing object, unique label id: ",
        "; stop printing object, unique label id: ",
    );
}

#[test]
fn a_bed_slinger_shoots_after_the_walls_and_returns_to_the_layer() {
    let mut c = base_config();
    c["gcode_flavor"] = json!("marlin");
    c["printer_model"] = json!("Bambu Lab A1");
    c["printer_structure"] = json!("i3");
    c["time_lapse_gcode"] = json!("; shot\nG1 Z{max_layer_z + 0.4}\nG1 X0 Y128 F18000");
    c["wipe"] = json!(true);
    let g = text(&two_objects(c, json!({})));
    // orca's process_layer shoots inside the open label of the object whose walls are done, so each
    // object's label opens once per layer
    let mut open = false;
    for l in g.lines() {
        if l.starts_with("; start printing object, unique label id: ") {
            open = true;
        } else if l.starts_with("; stop printing object, unique label id: ") {
            open = false;
        } else if l == "; shot" {
            assert!(open, "shot outside the object label");
        }
    }
    let ls = layers(&g);
    for (i, l) in ls.iter().enumerate() {
        assert_eq!(
            l.matches("; start printing object, unique label id: ").count(),
            2,
            "layer {i}"
        );
    }
    let mut mid = 0;
    for (i, l) in ls.iter().enumerate() {
        // Progress lines follow moves wherever the share or the minutes change; they are left out here.
        let lines: Vec<&str> = l.lines().filter(|x| !x.starts_with("M73 P")).collect();
        let z = lines.iter().find_map(|x| x.strip_prefix("; Z_HEIGHT: ")).unwrap();
        let k = lines
            .iter()
            .position(|x| *x == "; shot")
            .unwrap_or_else(|| panic!("layer {i} has no shot"));
        assert!(
            lines[k - 2].starts_with("; object ids of layer "),
            "layer {i}: {:?}",
            &lines[k - 3..k]
        );
        // retracted with a wipe before; the mask closes, then the nozzle goes back to the layer's height
        assert!(
            lines[..k].iter().rev().take(8).any(|x| *x == "; WIPE_END"),
            "layer {i}: {:?}",
            &lines[k - 8..k]
        );
        assert!(
            lines[k + 3].starts_with("; object ids of this layer"),
            "layer {i}: {:?}",
            &lines[k..k + 6]
        );
        assert_eq!(lines[k + 4], "M625");
        assert!(
            lines[k + 5].starts_with(&format!("G1 Z{z} F")),
            "layer {i}: {:?}",
            &lines[k..k + 6]
        );
        if lines[k + 5..].iter().any(|x| x.starts_with("; FEATURE: ")) {
            mid += 1;
        }
    }
    // Most layers shoot before the infill, inside the layer.
    assert!(mid * 10 > ls.len() * 8, "{mid} of {}", ls.len());
    assert_labeled(
        &g,
        "; start printing object, unique label id: ",
        "; stop printing object, unique label id: ",
    );
}

#[test]
fn other_printers_get_timelapse_at_the_layer_change_and_file_start_at_the_top() {
    let mut c = base_config();
    c["gcode_flavor"] = json!("klipper");
    c["time_lapse_gcode"] = json!("TIMELAPSE_TAKE_FRAME ; {layer_num}");
    c["layer_change_gcode"] = json!("; after");
    c["file_start_gcode"] = json!("; made for {printer_model}");
    c["printer_model"] = json!("Test printer");
    let g = text(&two_objects(c, json!({})));
    assert!(
        g.starts_with("; made for Test printer\n; generated by"),
        "{}",
        &g[..80]
    );
    let ls = layers(&g);
    for (i, l) in ls.iter().enumerate() {
        assert!(
            l.contains(&format!("TIMELAPSE_TAKE_FRAME ; {i}\n; after\n")),
            "layer {i}"
        );
    }
    assert!(!g.contains("M624"));
}

#[test]
fn printing_by_object_gcode_runs_before_each_later_object() {
    let mut c = base_config();
    c["print_sequence"] = json!("by object");
    // A small head on a tall gantry, so the two parts fit side by side.
    c["extruder_clearance_radius"] = json!(10);
    c["extruder_clearance_height_to_rod"] = json!(200);
    c["extruder_clearance_height_to_lid"] = json!(200);
    c["printing_by_object_gcode"] = json!("; next object {current_object_idx}");
    let g = text(&two_objects(c, json!({})));
    assert_eq!(g.matches("; next object ").count(), 1, "one later object");
    let at = g.find("; next object ").unwrap();
    // Over the object, before the nozzle comes down to its first layer.
    let after: Vec<&str> = g[at..].lines().take(2).collect();
    assert!(after[1].starts_with("G1 Z"), "{after:?}");
}

#[test]
fn by_object_templates_see_the_sequence_and_the_finished_tops() {
    let mut c = base_config();
    c["print_sequence"] = json!("by object");
    c["extruder_clearance_radius"] = json!(10);
    c["extruder_clearance_height_to_rod"] = json!(200);
    c["extruder_clearance_height_to_lid"] = json!(200);
    c["gcode_flavor"] = json!("marlin");
    c["printer_model"] = json!("Bambu Lab A1");
    c["printer_structure"] = json!("i3");
    // the a1's timelapse skips its trip to the bed edge by object; that trip at layer height would
    // run through the finished object
    c["time_lapse_gcode"] = json!(
        "{if print_sequence != \"by object\"}\nG1 X0 Y128 F18000 ; to the edge\n{endif}\n; top {max_layer_z}"
    );
    let g = text(&two_objects(c, json!({})));
    assert!(!g.lines().any(|l| l.ends_with("; to the edge")));
    let tops: Vec<f64> = g
        .lines()
        .filter_map(|l| l.strip_prefix("; top ")?.parse().ok())
        .collect();
    assert!(tops.len() > 2, "{tops:?}");
    assert!(tops.windows(2).all(|w| w[1] >= w[0]), "{tops:?}");
}

#[test]
fn no_labels_unless_asked() {
    let g = text(&two_objects(base_config(), json!({})));
    assert!(!g.contains("EXCLUDE_OBJECT") && !g.contains("M486") && !g.contains("printing object"));
}

fn decode_block(g: &str, tag: &str) -> Vec<u8> {
    let begin = format!("; {tag} begin ");
    let start = g.find(&begin).unwrap_or_else(|| panic!("no {tag} block"));
    let body: String = g[start..]
        .lines()
        .skip(1)
        .take_while(|l| !l.contains(" end"))
        .map(|l| l.trim_start_matches("; "))
        .collect();
    sx_core::thumbnail::base64_decode(&body).unwrap()
}

#[test]
fn thumbnails_are_drawn_from_the_toolpaths_in_the_requested_formats() {
    let mut c = base_config();
    c["thumbnails"] = json!(["48x48/PNG", "64x64/QOI", "32x32/BTT_TFT"]);
    let r = two_objects(c, json!({"shards": 3}));
    let g = text(&r);
    assert!(
        g.contains("; THUMBNAIL_BLOCK_START\n\n;\n; thumbnail begin 48x48 ")
            && g.contains("; thumbnail_QOI begin 64x64 ")
            && g.contains(";00200020\r\n")
            && g.contains("; bigtree thumbnail end\r\n")
    );
    assert!(g.find("; THUMBNAIL_BLOCK_START").unwrap() < g.find("G28").unwrap_or(usize::MAX));
    let png = decode_block(&g, "thumbnail");
    assert_eq!(&png[1..4], b"PNG");
    // SX_DUMP=<dir> keeps the picture for a look.
    if let Ok(dir) = std::env::var("SX_DUMP") {
        std::fs::write(format!("{dir}/thumb-48.png"), &png).unwrap();
    }
    assert_eq!(&decode_block(&g, "thumbnail_QOI")[..4], b"qoif");
    assert!(!g.contains(";@"));
    assert!(
        !r.report
            .warnings
            .iter()
            .any(|w| w.message.contains("32x32/BTT_TFT"))
    );
    // Same bytes whatever the shard count.
    let mut c2 = base_config();
    c2["thumbnails"] = json!(["48x48/PNG", "64x64/QOI", "32x32/BTT_TFT"]);
    assert_eq!(two_objects(c2, json!({"shards": 1})).gcode, r.gcode);
}

#[test]
fn a_host_image_replaces_the_drawn_one_and_a_bad_one_is_an_error() {
    let mut c = base_config();
    c["thumbnails"] = json!(["16x16/PNG"]);
    let rgba: Vec<u8> = std::iter::repeat_n([9u8, 8, 7, 255], 16 * 16).flatten().collect();
    let img = json!({"width": 16, "height": 16, "rgba": sx_core::thumbnail::base64_encode(&rgba)});
    let g = text(&two_objects(c.clone(), json!({"thumbnail": img})));
    let png = decode_block(&g, "thumbnail");
    let idat = png.windows(4).position(|w| w == b"IDAT").unwrap();
    let len = u32::from_be_bytes(png[idat - 4..idat].try_into().unwrap()) as usize;
    let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&png[idat + 4..idat + 4 + len]).unwrap();
    assert_eq!(&raw[..5], &[0, 9, 8, 7, 255]);
    let m = mesh();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"mesh": "x"}]}, "config": c,
        "options": {"thumbnail": {"width": 16, "height": 16, "rgba": "AAAA"}},
    }))
    .unwrap();
    assert!(common::run_request(&req, &move |_: &str| Ok(m.clone())).is_err());
}

#[test]
fn no_thumbnail_block_unless_the_profile_asks() {
    assert!(!text(&two_objects(base_config(), json!({}))).contains("thumbnail"));
}

#[test]
fn accelerations_are_written_per_feature_and_change_the_estimate() {
    let mut c = base_config();
    c["gcode_flavor"] = json!("marlin2");
    c["default_acceleration"] = json!(5000);
    c["outer_wall_acceleration"] = json!(3000);
    c["inner_wall_acceleration"] = json!(4000);
    c["initial_layer_acceleration"] = json!(1000);
    c["outer_wall_jerk"] = json!(7);
    c["default_jerk"] = json!(10);
    let r = two_objects(c.clone(), json!({}));
    let g = text(&r);
    let head: &str = &g[g.find(sx_core::extras::layer_mark(&g)).unwrap()..g.find(";Z:0.4").unwrap()];
    assert!(
        head.contains("M204 P1000\n"),
        "first layer uses initial_layer_acceleration"
    );
    let second = &g[g.find(";Z:0.4").unwrap()..];
    let second = &second[..second.find(";Z:0.6").unwrap()];
    let order: Vec<&str> = second
        .lines()
        .filter(|l| l.starts_with("M204 P") || l.starts_with("M205 X") || l.starts_with(";TYPE:"))
        .collect();
    let at = |s: &str| {
        order
            .iter()
            .position(|l| *l == s)
            .unwrap_or_else(|| panic!("{s} in {order:?}"))
    };
    // An overhanging wall is a bridge to Orca (`is_bridge`), so it prints at the bridge acceleration, half the
    // outer wall's by default (`bridge_acceleration`, 50 percent of `outer_wall_acceleration`).
    assert!(at("M204 P4000") < at(";TYPE:Inner wall") + 1 && at(";TYPE:Inner wall") < at("M204 P1500") + 2);
    assert!(order.contains(&"M205 X7 Y7"));
    c["gcode_flavor"] = json!("klipper");
    assert!(text(&two_objects(c, json!({}))).contains("SET_VELOCITY_LIMIT ACCEL=3000 ACCEL_TO_DECEL=1500"));
}

#[test]
fn arc_fitting_writes_g2_and_g3_with_the_same_filament() {
    let plain = two_objects(base_config(), json!({}));
    let mut c = base_config();
    c["enable_arc_fitting"] = json!(true);
    let arcs = two_objects(c, json!({}));
    let g = text(&arcs);
    let count = |s: &str| {
        s.lines()
            .filter(|l| l.starts_with("G2 ") || l.starts_with("G3 "))
            .count()
    };
    assert!(count(&g) > 100, "{} arcs", count(&g));
    assert_eq!(count(&text(&plain)), 0);
    // Orca simplifies walls more finely when arcs are on, so compare moves, not bytes.
    let moves = |s: &str| {
        s.lines()
            .filter(|l| l.starts_with("G1 X") || l.starts_with("G2 ") || l.starts_with("G3 "))
            .count()
    };
    assert!(
        moves(&g) < moves(&text(&plain)),
        "fewer moves: {} against {}",
        moves(&g),
        moves(&text(&plain))
    );
    let (a, b) = (
        arcs.report.stats.filament_mm[0],
        plain.report.stats.filament_mm[0],
    );
    assert!((a - b).abs() / b < 0.01, "filament {a} against {b}");
    let cfg = sx_core::PrintConfig::from_value(&common::with_base(&base_config())).unwrap();
    let report = sx_core::validate::validate_gcode(
        &arcs.gcode,
        cfg.bed_rect(),
        cfg.printable_height,
        cfg.retraction_length + 0.001,
    );
    assert!(report.ok(), "{:?}", report.errors);
}

fn validated(r: &SliceRun) {
    let cfg = sx_core::PrintConfig::from_value(&common::with_base(&base_config())).unwrap();
    let report = sx_core::validate::validate_gcode(
        &r.gcode,
        cfg.bed_rect(),
        cfg.printable_height,
        cfg.retraction_length + 0.001,
    );
    if !report.ok() {
        let g = String::from_utf8_lossy(&r.gcode);
        let n: usize = report.errors[0]
            .split(|c: char| !c.is_ascii_digit())
            .find_map(|t| t.parse().ok())
            .unwrap_or(1);
        let ctx: Vec<&str> = g.lines().skip(n.saturating_sub(8)).take(12).collect();
        panic!("{:?}\n{}", report.errors, ctx.join("\n"));
    }
}

#[test]
fn absolute_extruder_distances_count_from_a_reset_each_layer() {
    let mut c = base_config();
    c["use_relative_e_distances"] = json!(false);
    let r = two_objects(c, json!({"shards": 3}));
    let g = text(&r);
    // Orca's preamble: G90, G21 and the extruder mode, with the extruder reset when it counts absolutely.
    assert!(
        g.contains("\nG90\nG21\nM82 ; use absolute distances for extrusion\nG92 E0\n") && !g.contains("M83")
    );
    validated(&r);
    let first_layer: &str = &g[g.find(sx_core::extras::layer_mark(&g)).unwrap()..g.find(";Z:0.4").unwrap()];
    assert!(first_layer.contains("G92 E0\n"));
    // Within a layer the extruder position only falls at retractions.
    let mut pos = 0.0f64;
    let mut extruded = 0.0;
    for l in first_layer.lines() {
        if l == "G92 E0" {
            pos = 0.0;
        } else if (l.starts_with("G1 ") || l.starts_with("G0 "))
            && let Some(i) = l.find(" E")
        {
            let v: f64 = l[i + 2..].split_whitespace().next().unwrap().parse().unwrap();
            if v > pos && l.contains(" X") {
                extruded += v - pos;
            }
            pos = v;
        }
    }
    assert!(extruded > 100.0, "{extruded}");
    // The same file whatever the shard count.
    let mut c2 = base_config();
    c2["use_relative_e_distances"] = json!(false);
    assert_eq!(two_objects(c2, json!({"shards": 1})).gcode, r.gcode);
}

#[test]
fn layer_change_retraction_can_be_turned_off_and_comments_turned_on() {
    let on = text(&two_objects(base_config(), json!({})));
    let mut c = base_config();
    c["retract_when_changing_layer"] = json!(false);
    c["gcode_comments"] = json!(true);
    let off = text(&two_objects(c, json!({})));
    let retracts = |g: &str| g.lines().filter(|l| l.starts_with("G1 E-")).count();
    // Without it, the first travel of a layer retracts after the Z move, and only when it is longer than the
    // retraction minimum (the nozzle starts the layer where the layer below ended).
    assert!(
        retracts(&off) <= retracts(&on),
        "{} {}",
        retracts(&off),
        retracts(&on)
    );
    let layer = &off[off.find(";Z:0.4").unwrap()..off.find(";Z:0.6").unwrap()];
    assert!(
        layer.find("G1 E-").unwrap() > layer.find("G1 Z0.4").unwrap(),
        "retract after the layer's Z move"
    );
    let layer_on = &on[on.find(";Z:0.4").unwrap()..on.find(";Z:0.6").unwrap()];
    assert!(layer_on.find("G1 E-").unwrap() < layer_on.find("G1 Z0.4").unwrap());
    assert!(
        off.contains(" ; retract\n")
            && off.contains(" ; unretract\n")
            && off.contains(" ; move to first perimeter point\n")
            && off.contains(" ; perimeter\n")
            && off.contains(" ; infill\n")
    );
    assert!(!on.contains(" ; retract"));
}

#[test]
fn a_slope_lift_rises_along_the_travel() {
    let mut c = base_config();
    c["z_hop"] = json!(0.4);
    c["retract_lift_above"] = json!(0);
    c["z_hop_types"] = json!("Slope Lift");
    c["travel_slope"] = json!(3);
    c["travel_speed_z"] = json!(12);
    let g = text(&two_objects(c, json!({})));
    let ramps = g
        .lines()
        .filter(|l| l.starts_with("G1 X") && l.contains(" Z") && !l.contains(" E"))
        .count();
    assert!(ramps > 5, "{ramps} ramps");
    // The ramp is part of the travel and runs at the travel speed (Orca's `travel_to_xyz`), not the Z speed
    // (12 mm/s here); a travel too short for the slope climbs on the travel move itself.
    assert!(
        g.lines()
            .filter(|l| l.starts_with("G1 X") && l.contains(" Z") && !l.contains(" E"))
            .all(|l| l.contains(" F") && !l.ends_with(" F720")),
        "a ramp at the Z speed"
    );
    assert!(
        g.lines().any(|l| l.starts_with("G0 X") && l.contains(" Z")),
        "short travels climb on the move"
    );
    // Orca's default type is Slope Lift (PrintConfig.cpp, `z_hop_types`), so a normal lift is asked for.
    let mut c2 = base_config();
    c2["z_hop"] = json!(0.4);
    c2["retract_lift_above"] = json!(0);
    c2["z_hop_types"] = json!("Normal Lift");
    let plain = text(&two_objects(c2, json!({})));
    assert_eq!(
        plain
            .lines()
            .filter(|l| l.starts_with("G1 X") && l.contains(" Z") && !l.contains(" E"))
            .count(),
        0
    );
}

#[test]
fn travel_planning_keeps_to_infill_and_combs_around_walls() {
    let count = |g: &str, p: &str| g.lines().filter(|l| l.starts_with(p)).count();
    let plain = two_objects(base_config(), json!({}));
    let mut c = base_config();
    c["reduce_infill_retraction"] = json!(true);
    let quiet = two_objects(c, json!({}));
    assert!(
        count(&text(&quiet), "G1 E-") < count(&text(&plain), "G1 E-"),
        "fewer retractions"
    );
    validated(&quiet);
    let mut c = base_config();
    c["reduce_crossing_wall"] = json!(true);
    c["max_travel_detour_distance"] = json!(0);
    let combed = two_objects(c, json!({}));
    assert!(
        count(&text(&combed), "G0 ") > count(&text(&plain), "G0 "),
        "combing adds waypoints"
    );
    validated(&combed);
    // Same bytes whatever the shard count.
    let mut c2 = base_config();
    c2["reduce_infill_retraction"] = json!(true);
    assert_eq!(two_objects(c2, json!({"shards": 4})).gcode, quiet.gcode);
}

#[test]
fn wipe_on_loops_moves_into_the_part_after_each_closed_outer_wall() {
    let mut c = base_config();
    c["wipe_on_loops"] = json!(true);
    c["gcode_comments"] = json!(true);
    let r = two_objects(c, json!({}));
    let g = text(&r);
    let wipes = g.matches(" ; move inwards before travel\n").count();
    let outer = g.matches(";TYPE:Outer wall").count();
    assert!(
        wipes > 0 && wipes <= outer * 3,
        "{wipes} wipes for {outer} outer wall runs"
    );
    validated(&r);
}

#[test]
fn a_spiral_lift_climbs_in_one_turn_before_the_travel() {
    // Orca's spiral lift (GCodeWriter::_spiral_travel_to_z): without arc fitting, short moves round one turn
    // (7 at the default 0.012 mm resolution), the last back over the start at the lifted height.
    let mut c = base_config();
    c["z_hop"] = json!(0.4);
    c["retract_lift_above"] = json!(0);
    c["z_hop_types"] = json!("Spiral Lift");
    c["enable_arc_fitting"] = json!(false);
    let r = two_objects(c.clone(), json!({}));
    let g = text(&r);
    let lines: Vec<&str> = g.lines().collect();
    let z_of = |l: &str| -> f64 {
        l.split(" Z")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse()
            .unwrap()
    };
    let mut turns = 0;
    for (i, w) in lines.windows(8).enumerate() {
        if !w[0].starts_with("G1 F")
            || !w[1..]
                .iter()
                .all(|l| l.starts_with("G1 X") && l.contains(" Z") && !l.contains(" E"))
        {
            continue;
        }
        let zs: Vec<f64> = w[1..].iter().map(|l| z_of(l)).collect();
        assert!(zs.windows(2).all(|p| p[1] > p[0]), "line {i}: {zs:?}");
        turns += 1;
    }
    assert!(turns > 5, "{turns} turns");
    validated(&r);

    // With arc fitting, one full turn as a G3 arc with P1, after G17.
    c["enable_arc_fitting"] = json!(true);
    let r = two_objects(c, json!({}));
    let g = text(&r);
    let arcs: Vec<&str> = g
        .lines()
        .filter(|l| l.starts_with("G3 Z") && l.contains(" P1 "))
        .collect();
    assert!(arcs.len() > 5, "{} spiral arcs", arcs.len());
    assert_eq!(g.matches("G17\nG3 Z").count(), arcs.len());
    validated(&r);
}

#[test]
fn every_layer_change_lifts_like_orca() {
    // Auto Lift spirals at the layer change (Orca GCode::change_layer): the layer's first travel climbs a
    // turn to the new layer's height plus the lift, travels, and comes down.
    let mut c = base_config();
    c["z_hop"] = json!(0.4);
    c["retract_lift_above"] = json!(0);
    c["z_hop_types"] = json!("Auto Lift");
    c["enable_arc_fitting"] = json!(true);
    let m = mesh();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "a", "name": "part.stl", "mesh": "x"}]},
        "config": c,
        "options": {},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    let g = text(&r);
    let mut lifted = 0;
    for layer in g.split(&format!("{}\n", sx_core::extras::layer_mark(&g))).skip(2) {
        let z: f64 = layer
            .lines()
            .find_map(|l| l.strip_prefix(";Z:"))
            .unwrap()
            .parse()
            .unwrap();
        let Some(arc) = layer
            .lines()
            .find(|l| l.starts_with("G3 Z") && l.contains(" P1 "))
        else {
            continue;
        };
        let top: f64 = arc[4..].split_whitespace().next().unwrap().parse().unwrap();
        assert!((top - (z + 0.4)).abs() < 0.002, "{arc} on layer {z}");
        lifted += 1;
    }
    assert!(lifted > 100, "{lifted} layers lift");
    validated(&r);
}

#[test]
fn layer_changes_lift_like_orca_on_a_plate_of_objects() {
    // The layers of objects printed together know where the layer below ended, so the layer change
    // spirals up from there as on one object, at every shard count.
    let mut c = base_config();
    c["z_hop"] = json!(0.4);
    c["retract_lift_above"] = json!(0);
    c["z_hop_types"] = json!("Spiral Lift");
    c["retract_when_changing_layer"] = json!(true);
    c["enable_arc_fitting"] = json!(true);
    let r = two_objects(c.clone(), json!({}));
    let g = text(&r);
    let mut lifted = 0;
    for layer in g.split(&format!("{}\n", sx_core::extras::layer_mark(&g))).skip(2) {
        let z: f64 = layer
            .lines()
            .find_map(|l| l.strip_prefix(";Z:"))
            .unwrap()
            .parse()
            .unwrap();
        let first = layer
            .lines()
            .find(|l| l.starts_with("G1 Z") || l.starts_with("G3 Z"))
            .unwrap();
        if let Some(rest) = first.strip_prefix("G3 Z") {
            let top: f64 = rest.split_whitespace().next().unwrap().parse().unwrap();
            assert!((top - (z + 0.4)).abs() < 0.002, "{first} on layer {z}");
            lifted += 1;
        }
    }
    assert!(lifted > 400, "{lifted} layers spiral up");
    validated(&r);
    assert_eq!(two_objects(c, json!({"shards": 4})).gcode, r.gcode);
}

#[test]
fn auto_lift_spirals_on_travels_over_overhangs() {
    // Orca's needs_retraction: with Auto Lift a travel whose start crosses an overhang of this layer or the
    // layers up to 0.4 mm below spirals up; other travels slope. The layer change spiral comes first.
    let mut c = base_config();
    c["z_hop"] = json!(0.4);
    c["retract_lift_above"] = json!(0);
    c["z_hop_types"] = json!("Auto Lift");
    c["enable_arc_fitting"] = json!(true);
    let r = two_objects(c, json!({}));
    let g = text(&r);
    let mut over = 0;
    let mut sloped = 0;
    for layer in g.split(&format!("{}\n", sx_core::extras::layer_mark(&g))).skip(2) {
        let spirals = layer
            .lines()
            .filter(|l| l.starts_with("G3 Z") && l.contains(" P1 "))
            .count();
        over += spirals.saturating_sub(1);
        sloped += layer
            .lines()
            .filter(|l| l.starts_with("G1 X") && l.contains(" Z") && !l.contains(" E"))
            .count();
    }
    assert!(over > 20, "{over} travels spiral over overhangs");
    assert!(sloped > over, "{sloped} sloped travels");
    validated(&r);
}

#[test]
fn substitutions_edit_the_finished_file_and_are_linted() {
    let mut c = base_config();
    c["gcode_substitutions"] = json!([
        "M106 S0",
        "M106 S0 ; fan off",
        "",
        "",
        r"^;TYPE:(.*)$",
        ";ROLE $1",
        "r",
        "note"
    ]);
    let g = text(&two_objects(c, json!({})));
    assert!(
        g.contains("M106 S0 ; fan off\n")
            && g.contains("\n;ROLE Outer wall\n")
            && !g.contains("\n;TYPE:Outer wall")
    );
    let mut c = base_config();
    c["gcode_substitutions"] = json!(["G28", "M500", "", ""]);
    let m = mesh();
    let req: SliceRequest =
        serde_json::from_value(json!({"plate": {"objects": [{"mesh": "x"}]}, "config": c})).unwrap();
    match common::run_request(&req, &move |_: &str| Ok(m.clone())) {
        Err(api::Error::Blocked(msg)) => assert!(msg.contains("M500"), "{msg}"),
        other => panic!("expected a block, got {:?}", other.map(|r| r.gcode.len())),
    }
}

#[test]
fn wipe_before_external_loop_lands_short_of_the_start_then_moves_onto_it() {
    let mut c = base_config();
    c["wall_sequence"] = json!("outer wall/inner wall");
    c["wipe_before_external_loop"] = json!(true);
    let r = two_objects(c, json!({}));
    let g = text(&r);
    let n = g
        .lines()
        .filter(|l| l.starts_with("G1 X") && !l.contains(" E") && !l.contains(" F") && !l.contains(" Z"))
        .count();
    assert!(n > 10, "{n} landing moves");
    let mut plain = base_config();
    plain["wall_sequence"] = json!("outer wall/inner wall");
    let q = text(&two_objects(plain, json!({})));
    assert_eq!(
        q.lines()
            .filter(|l| l.starts_with("G1 X") && !l.contains(" E") && !l.contains(" F") && !l.contains(" Z"))
            .count(),
        0
    );
    validated(&r);
}

#[test]
fn ironing_passes_follow_the_mode_and_carry_a_little_filament() {
    let count = |g: &str| g.matches(";TYPE:Ironing").count();
    let mut top = base_config();
    top["ironing_type"] = json!("top");
    top["ironing_spacing"] = json!(0.15);
    top["ironing_flow"] = json!(15);
    let r = two_objects(top.clone(), json!({}));
    let g = text(&r);
    assert!(count(&g) >= 1, "ironing on the top surfaces");
    let mut topmost = top.clone();
    topmost["ironing_type"] = json!("topmost");
    let t = text(&two_objects(topmost, json!({})));
    // Only the last layer: the two copies each iron their own top after their other paths.
    let ironed = t
        .split(sx_core::extras::layer_mark(&t))
        .filter(|l| count(l) > 0)
        .count();
    assert_eq!(ironed, 1, "only the last layer");
    assert_eq!(count(&t), 2, "once per copy");
    assert_eq!(count(&text(&two_objects(base_config(), json!({})))), 0);
    // The passes are slow and thin.
    let speeds: Vec<f64> = g
        .split(";TYPE:Ironing")
        .skip(1)
        .filter_map(|s| s.lines().find(|l| l.starts_with("G1 F")))
        .filter_map(|l| l[4..].parse::<f64>().ok())
        .collect();
    assert!(
        !speeds.is_empty() && speeds.iter().all(|&f| (f - 20.0 * 60.0).abs() < 1.0),
        "{speeds:?}"
    );
    validated(&r);
    // Same bytes whatever the shard count.
    assert_eq!(two_objects(top, json!({"shards": 4})).gcode, r.gcode);
}

#[test]
fn top_and_bottom_surface_patterns_draw_curves_inside_the_surface() {
    for pattern in [
        "hilbertcurve",
        "archimedeanchords",
        "octagramspiral",
        "concentric",
    ] {
        let mut c = base_config();
        c["top_surface_pattern"] = json!(pattern);
        c["bottom_surface_pattern"] = json!(pattern);
        let r = two_objects(c, json!({}));
        let g = text(&r);
        assert!(
            g.contains(";TYPE:Top surface") && g.contains(";TYPE:Bottom surface"),
            "{pattern}"
        );
        validated(&r);
        let plain = two_objects(base_config(), json!({}));
        let (a, b) = (r.report.stats.filament_mm[0], plain.report.stats.filament_mm[0]);
        assert!((a - b).abs() / b < 0.15, "{pattern}: filament {a} against {b}");
    }
}

#[test]
fn layer_gcode_that_reads_the_weight_used_is_rendered_when_the_shards_are_joined() {
    let mut c = base_config();
    c["before_layer_change_gcode"] = json!(
        "M74 W[extruded_weight_total]\nM201 X{interpolate_table(extruded_weight_total, (0,4000), (1400,2500), (10000,2500))}"
    );
    let r = two_objects(c.clone(), json!({"shards": 3}));
    let g = text(&r);
    assert!(!g.contains(";@D"), "markers are gone");
    let weights: Vec<f64> = g
        .lines()
        .filter_map(|l| l.strip_prefix("M74 W"))
        .map(|w| w.parse().unwrap())
        .collect();
    assert!(weights.len() > 50, "{} layers", weights.len());
    assert!(weights[0].abs() < 1e-9);
    assert!(weights.windows(2).all(|w| w[1] >= w[0]), "the weight only grows");
    // The last layer has seen nearly all of the filament of the footer.
    let total: f64 = g
        .lines()
        .find_map(|l| l.strip_prefix("; total filament used [g] = "))
        .unwrap()
        .parse()
        .unwrap();
    let last = *weights.last().unwrap();
    assert!(last > total * 0.9 && last <= total + 0.01, "{last} of {total}");
    // The same bytes at every shard count.
    assert_eq!(two_objects(c, json!({"shards": 1})).gcode, r.gcode);
}

#[test]
fn the_bambu_filament_list_reads_the_layers_of_every_shard() {
    let mut c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab A1",
        "change_filament_gcode": "M620 S[next_extruder]A\nT[next_extruder]",
        "sparse_infill_filament_id": 2,
        "internal_solid_filament_id": 1,
        "top_surface_filament_id": 1,
        "bottom_surface_filament_id": 1,
        "enable_prime_tower": false,
    });
    let whole = cube(c.clone(), 1);
    assert!(
        whole.contains("\n; filament: 1,2\n"),
        "{}",
        &whole[..whole.len().min(600)]
    );
    // The first of 40 shards holds the first layer, which has no sparse infill: the list is still the
    // plate's, and the file is the same.
    let sharded = cube(c.clone(), 40);
    let first = whole.lines().zip(sharded.lines()).find(|(a, b)| a != b);
    assert!(first.is_none() && sharded.len() == whole.len(), "{first:?}");
    c["sparse_infill_filament_id"] = json!(1);
    assert!(cube(c, 40).contains("\n; filament: 1\n"));
}

/// A 20 mm cube from the CLI fixtures, sliced with `config` in `shards` layer ranges.
fn cube(config: Value, shards: u32) -> String {
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    let m = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "a", "name": "cube", "mesh": "c"}]},
        "config": config,
        "options": {"shards": shards},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

/// Final extruder position of an absolute file whose resets are all `G92 E0`.
fn last_e(g: &str) -> f64 {
    let mut e = 0.0;
    for l in g.lines() {
        if l.starts_with("G92 E0") {
            e = 0.0;
        } else if (l.starts_with("G1 ") || l.starts_with("G0 "))
            && let Some(i) = l.find(" E")
        {
            e = l[i + 2..].split_whitespace().next().unwrap().parse().unwrap();
        }
    }
    e
}

/// Filament a Marlin printer pushes for a file, and the largest single push: `M82` and `M83`, `G90` and `G91`
/// (which makes E relative too) and `G92 E` as the firmware reads them, indented lines included.
fn fed_by_firmware(g: &str) -> (f64, f64) {
    let (mut e_rel, mut all_rel, mut pos, mut fed, mut most) = (false, false, 0.0f64, 0.0, 0.0f64);
    for l in g.lines() {
        let l = l.split(';').next().unwrap().trim();
        let mut w = l.split_whitespace();
        match w.next() {
            Some("M82") => e_rel = false,
            Some("M83") => e_rel = true,
            Some("G90") => all_rel = false,
            Some("G91") => all_rel = true,
            Some("G92") => {
                if let Some(v) = w.find_map(|t| t.strip_prefix('E')) {
                    pos = v.parse().unwrap();
                }
            }
            Some("G0" | "G1" | "G2" | "G3") => {
                if let Some(v) = w.find_map(|t| t.strip_prefix('E')) {
                    let v: f64 = v.parse().unwrap();
                    let d = if e_rel || all_rel { v } else { v - pos };
                    pos += d;
                    if d > 0.0 {
                        fed += d;
                        most = most.max(d);
                    }
                }
            }
            _ => {}
        }
    }
    (fed, most)
}

/// A maker's layer change G-code written for relative extrusion (Bambu Lab's A1 timelapse block switches to `M83`
/// and zeroes the extruder, indented inside its `M622` condition) leaves an absolute-extrusion file feeding what
/// the relative file feeds, with no long push.
#[test]
fn absolute_extrusion_survives_custom_gcode_that_switches_to_relative() {
    let block = "M622 J1\n    G92 E0\n    G90\n    M83\n    G1 E-0.5 F1800\n    G91\n    G1 Z0.4 E0.2\n    G90\n    G1 E0.3 F1800\nM623\n";
    let mut c = base_config();
    c["layer_change_gcode"] = json!(block);
    c["use_relative_e_distances"] = json!(true);
    let (relative, _) = fed_by_firmware(&cube(c.clone(), 1));
    c["use_relative_e_distances"] = json!(false);
    let (absolute, most) = fed_by_firmware(&cube(c, 1));
    assert!(
        (absolute - relative).abs() < 0.01 * relative,
        "absolute {absolute} mm, relative {relative} mm"
    );
    assert!(most < 5.0, "one move pushes {most} mm");
}

/// Spiral vase prints one outline per layer, the largest, so a second object printed layer by layer lost every wall
/// above its base. Orca refuses that plate (`Print::validate`) and asks for print by object; so does the engine.
#[test]
fn spiral_vase_with_two_objects_needs_print_by_object() {
    let mut c = base_config();
    for (k, v) in [
        ("spiral_mode", json!(true)),
        ("wall_loops", json!(1)),
        ("top_shell_layers", json!(0)),
        ("sparse_infill_density", json!(0)),
    ] {
        c[k] = v;
    }
    let err = two_objects_result(c, json!({}))
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default();
    assert!(err.contains("spiral_mode") && err.contains("by object"), "{err}");
}

/// Every `gcode_flavor` Orca 2.4.2 offers writes its own dialect (`GCodeWriter`: preamble, temperatures, fan,
/// retraction, progress, postamble) and joins shards to the same bytes.
#[test]
fn every_flavor_writes_its_own_dialect() {
    let flavors = [
        "marlin",
        "marlinlegacy",
        "marlin2",
        "klipper",
        "reprapfirmware",
        "reprap",
        "repetier",
        "teacup",
        "makerware",
        "sailfish",
        "mach3",
        "machinekit",
        "smoothie",
        "no-extrusion",
    ];
    for f in flavors {
        let mut c = base_config();
        c["gcode_flavor"] = json!(f);
        let g = cube(c.clone(), 3);
        assert_eq!(g, cube(c, 1), "{f}: shards");
        assert!(
            g.lines()
                .all(|l| l.is_empty() || l.starts_with([';', 'G', 'M', 'T', 'S'])),
            "{f}: a line that is no command"
        );
        let mw = matches!(f, "makerware" | "sailfish");
        assert_eq!(g.contains("\nG90\nG21\n"), f != "makerware", "{f}: preamble");
        assert_eq!(
            g.contains("M83 ; use relative"),
            !matches!(
                f,
                "makerware" | "sailfish" | "mach3" | "machinekit" | "no-extrusion"
            ),
            "{f}: extruder mode"
        );
        assert_eq!(g.contains("M126\n"), mw, "{f}: fan on");
        assert_eq!(
            g.contains("M106 P"),
            matches!(f, "mach3" | "machinekit"),
            "{f}: fan"
        );
        assert_eq!(
            g.contains("\nM109 "),
            !mw && !matches!(f, "teacup" | "reprapfirmware"),
            "{f}: wait"
        );
        assert_eq!(
            g.contains("M116 ; wait"),
            matches!(f, "teacup" | "reprapfirmware"),
            "{f}: M116"
        );
        assert_eq!(
            g.contains("\nG10 S220"),
            f == "reprapfirmware",
            "{f}: RRF temperature"
        );
        assert_eq!(
            g.contains("\nM73 P1\n") || g.contains("\nM73 P2\n"),
            mw,
            "{f}: layer progress"
        );
        assert_eq!(g.contains("\nM73 P100\n"), mw, "{f}: final progress");
        assert!(g.contains("\nM73 P100 R0\n"), "{f}: processor progress");
        assert_eq!(
            g.contains("M2 ; end of program\n"),
            f == "machinekit",
            "{f}: postamble"
        );
        assert_eq!(
            g.contains("M103 ; extruder off"),
            f == "makerware",
            "{f}: extruder off"
        );
    }
}

#[test]
fn firmware_retraction_and_absolute_distances_per_flavor() {
    let mut c = base_config();
    c["use_firmware_retraction"] = json!(true);
    c["use_relative_e_distances"] = json!(false);
    let g = cube(c.clone(), 3);
    assert!(g.contains("G10 ; retract\n") && g.contains("G11 ; unretract\nG92 E0\n"));
    c["gcode_flavor"] = json!("machinekit");
    let g = cube(c, 3);
    assert!(g.contains("G22 ; retract\n") && g.contains("G23 ; unretract\nG92 E0\n") && !g.contains("G10 ;"));
    // MakerWare never resets the extruder: the position runs on through the whole print.
    let mut c = base_config();
    c["use_relative_e_distances"] = json!(false);
    let marlin_layer_end = last_e(&cube(c.clone(), 1));
    c["gcode_flavor"] = json!("makerware");
    let g = cube(c.clone(), 3);
    assert_eq!(g, cube(c, 1));
    assert!(!g.contains("G92 E0") && !g.contains(";@"));
    let total = last_e(&g);
    assert!(
        total > 20.0 * marlin_layer_end.abs().max(1.0),
        "{total} {marlin_layer_end}"
    );
}

/// Every extruding move runs at its path's speed: the feed rate in force on its line (the last `F` written on
/// any move, as G0 and G1 share it) is the speed the preview gives its segment. Travels, retractions, wipes
/// and lifts set other feed rates, so the path after them must set its own.
#[test]
fn every_extrusion_runs_at_its_paths_feed_rate() {
    for (wipe, hop, kind) in [
        (false, 0.0, "Normal Lift"),
        (true, 0.4, "Slope Lift"),
        (true, 0.4, "Spiral Lift"),
    ] {
        let mut c = base_config();
        c["wipe"] = json!(wipe);
        c["z_hop"] = json!(hop);
        c["z_hop_types"] = json!(kind);
        let r = two_objects(c, json!({"shards": 3, "emitPreview": true}));
        let g = text(&r);
        // The feed rate in force after each line (1-based).
        let mut feed_at = vec![0.0f64; 1];
        let mut now = 0.0;
        for l in g.lines() {
            if ["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|m| l.starts_with(m))
                && let Some(f) = l
                    .split(';')
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .find_map(|w| w.strip_prefix('F'))
            {
                now = f.parse().unwrap();
            }
            feed_at.push(now);
        }
        let lines: Vec<&str> = g.lines().collect();
        let b = &r.preview;
        let u32at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) as usize;
        let (segs, layers, travels) = (u32at(8), u32at(12), u32at(16));
        assert_eq!(u16::from_le_bytes([b[6], b[7]]) & 2, 2, "extras");
        let segments_at = 32 + (layers + 1) * 4 + layers * 4 + layers * 4 + (layers + 1) * 4;
        let extras_at = segments_at + segs * 32 + travels * 16;
        let (mut checked, mut wrong) = (0, Vec::new());
        for s in 0..segs {
            let line = u32at(extras_at + s * 8 + 4);
            if line == 0 || !lines[line - 1].starts_with("G1 X") || !lines[line - 1].contains(" E") {
                continue;
            }
            let speed = f64::from(u16::from_le_bytes([
                b[segments_at + s * 32 + 26],
                b[segments_at + s * 32 + 27],
            ])) * 6.0;
            checked += 1;
            if (feed_at[line] - speed).abs() > 4.0 {
                wrong.push((line, feed_at[line], speed));
            }
        }
        assert!(checked > 1000, "{checked}");
        assert!(
            wrong.is_empty(),
            "{kind}: {} of {checked} moves at another feed rate, first {:?}",
            wrong.len(),
            &wrong[..wrong.len().min(5)]
        );
    }
}

/// Orca's cooling slowdown (`CoolingBuffer::calculate_layer_slowdown`): a layer under `slow_down_layer_time`
/// caps its fastest paths at one common speed, so slower paths keep theirs, and the layer then takes the
/// minimum time in the cooling buffer's model (each move at its feed rate, no acceleration).
#[test]
fn a_fast_layer_caps_its_fastest_paths_to_reach_the_minimum_layer_time() {
    let mut c = base_config();
    for (k, v) in [
        ("outer_wall_speed", 40.0),
        ("inner_wall_speed", 250.0),
        ("sparse_infill_speed", 300.0),
        ("internal_solid_infill_speed", 300.0),
        ("top_surface_speed", 300.0),
        ("slow_down_layer_time", 8.0),
        ("slow_down_min_speed", 10.0),
    ] {
        c[k] = json!(v);
    }
    c["slow_down_for_layer_cooling"] = json!(true);
    let g = cube(c, 3);
    let layer = g.split(sx_core::extras::layer_mark(&g)).nth(40).unwrap();
    // The cooling buffer's time from the first extrusion, and the feed rates of the extrusions.
    let (mut x, mut y, mut f, mut t, mut started) = (f64::NAN, f64::NAN, 0.0f64, 0.0, false);
    let mut feeds = std::collections::BTreeSet::new();
    for l in layer.lines() {
        if !(l.starts_with("G0 ") || l.starts_with("G1 ")) {
            continue;
        }
        let word = |k: char| {
            l.split(';')
                .next()
                .unwrap()
                .split_whitespace()
                .find_map(|w| w.strip_prefix(k))
                .map(|v| v.parse::<f64>().unwrap())
        };
        if let Some(v) = word('F') {
            f = v / 60.0;
        }
        let (nx, ny) = (word('X').unwrap_or(x), word('Y').unwrap_or(y));
        let e = word('E').unwrap_or(0.0);
        let extruding = e > 0.0 && (nx != x || ny != y);
        started |= extruding;
        let len = if nx.is_nan() || x.is_nan() {
            0.0
        } else {
            (nx - x).hypot(ny - y)
        };
        let len = if len > 0.0 {
            len
        } else {
            e.abs() + word('Z').map_or(0.0, |_| 0.0)
        };
        if started && f > 0.0 {
            t += len / f;
        }
        if extruding {
            feeds.insert((f * 60.0).round() as i64);
        }
        (x, y) = (nx, ny);
    }
    let cap = *feeds.iter().max().unwrap();
    assert!(feeds.contains(&2400), "the outer wall keeps 40 mm/s: {feeds:?}");
    assert!(
        cap > 2400 && cap < 15000,
        "one common cap below the inner wall speed: {feeds:?}"
    );
    assert!((t - 8.0).abs() < 0.4, "layer time {t} s in the cooling model");
}

/// Filament (mm, relative extrusion) under each `;TYPE:` label.
fn feature_mm(g: &str, label: &str) -> f64 {
    let mut on = false;
    let mut sum = 0.0;
    for l in g.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            on = t == label;
        } else if on
            && l.starts_with("G1 X")
            && let Some(i) = l.find(" E")
        {
            let v: f64 = l[i + 2..].split_whitespace().next().unwrap().parse().unwrap();
            if v > 0.0 {
                sum += v;
            }
        }
    }
    sum
}

#[test]
fn extrusion_rate_smoothing_ramps_speed_changes_and_keeps_the_filament() {
    let mut c = base_config();
    c["enable_arc_fitting"] = json!(true);
    let plain = two_objects(c.clone(), json!({"shards": 3}));
    c["max_volumetric_extrusion_rate_slope"] = json!(8);
    let r = two_objects(c.clone(), json!({"shards": 3}));
    validated(&r);
    let (g, p) = (text(&r), text(&plain));
    // Lines are cut into ramps, arcs are off, and the filament is the same to rounding.
    assert!(g.lines().count() > p.lines().count() + 1000);
    assert!(!g.contains("\nG2 ") && !g.contains("\nG3 "));
    let total = |g: &str| {
        [
            "Outer wall",
            "Inner wall",
            "Sparse infill",
            "Internal solid infill",
            "Top surface",
            "Bottom surface",
        ]
        .iter()
        .map(|f| feature_mm(g, f))
        .sum::<f64>()
    };
    let unarced = two_objects(
        {
            let mut c = base_config();
            c["enable_arc_fitting"] = json!(false);
            c
        },
        json!({"shards": 3}),
    );
    let (a, b) = (total(&g), total(&text(&unarced)));
    assert!((a - b).abs() < b * 1e-4, "{a} {b}");
    // Shards still join to the same bytes.
    assert_eq!(two_objects(c, json!({"shards": 1})).gcode, r.gcode);
}

#[test]
fn an_extra_bridge_layer_doubles_the_bridges() {
    let table = || {
        let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/table.stl", root())).unwrap();
        Arc::new(Mesh::load(&bytes, "table.stl").unwrap())
    };
    let run = |extra: &str| {
        let m = table();
        let mut c = base_config();
        c["enable_extra_bridge_layer"] = json!(extra);
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"id": "t", "name": "table", "mesh": "t"}]},
            "config": c,
            "options": {"shards": 3},
        }))
        .unwrap();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        validated(&r);
        text(&r)
    };
    let off = run("disabled");
    let ext = run("external_bridge_only");
    let (b0, b1) = (feature_mm(&off, "Bridge"), feature_mm(&ext, "Bridge"));
    assert!(b1 > b0 * 1.5, "external bridge {b0} then {b1}");
    let int = run("internal_bridge_only");
    let (i0, i1) = (
        feature_mm(&off, "Internal Bridge"),
        feature_mm(&int, "Internal Bridge"),
    );
    assert!(i1 > i0 * 1.3, "internal bridge {i0} then {i1}");
    assert!((feature_mm(&int, "Bridge") - b0).abs() < 1e-6);
}

/// A round boss 24 mm wide and 10 mm tall with a 12 mm bore 4 mm deep from the bottom and a 6 mm hole above
/// it (bench/compare/models.py `counterbore`), as a binary STL around (128, 128).
fn counterbore_stl() -> Vec<u8> {
    let n = 96usize;
    let ring = |r: f32, z: f32| -> Vec<[f32; 3]> {
        (0..n)
            .map(|i| {
                let a = std::f32::consts::TAU * i as f32 / n as f32;
                [128.0 + r * a.cos(), 128.0 + r * a.sin(), z]
            })
            .collect()
    };
    let mut tris: Vec<[[f32; 3]; 3]> = Vec::new();
    let mut strip = |a: Vec<[f32; 3]>, b: Vec<[f32; 3]>, flip: bool| {
        for i in 0..n {
            let j = (i + 1) % n;
            for t in [[a[i], a[j], b[j]], [a[i], b[j], b[i]]] {
                tris.push(if flip { [t[2], t[1], t[0]] } else { t });
            }
        }
    };
    strip(ring(12.0, 0.0), ring(12.0, 10.0), false);
    strip(ring(6.0, 0.0), ring(12.0, 0.0), false);
    strip(ring(6.0, 0.0), ring(6.0, 4.0), true);
    strip(ring(3.0, 4.0), ring(6.0, 4.0), false);
    strip(ring(3.0, 4.0), ring(3.0, 10.0), true);
    strip(ring(3.0, 10.0), ring(12.0, 10.0), true);
    let mut out = vec![0u8; 80];
    out.extend_from_slice(&u32::try_from(tris.len()).unwrap().to_le_bytes());
    for t in tris {
        out.extend_from_slice(&[0u8; 12]);
        for p in t {
            for v in p {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out.extend_from_slice(&[0, 0]);
    }
    out
}

#[test]
fn a_counterbore_floor_is_bridged_instead_of_walled() {
    let run = |mode: &str| {
        let m = Arc::new(Mesh::load(&counterbore_stl(), "counterbore.stl").unwrap());
        let mut c = base_config();
        c["counterbore_hole_bridging"] = json!(mode);
        c["brim_type"] = json!("no_brim");
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"id": "c", "name": "counterbore", "mesh": "c"}]},
            "config": c,
            "options": {"shards": 3},
        }))
        .unwrap();
        let r = api::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        validated(&r);
        let g = text(&r);
        assert_eq!(g, {
            let m = Arc::new(Mesh::load(&counterbore_stl(), "counterbore.stl").unwrap());
            let mut req1 = req.clone();
            req1.options.shards = Some(1);
            text(&api::run_request(&req1, &move |_: &str| Ok(m.clone())).unwrap())
        });
        // The floor layer (z 4.2).
        g.split(sx_core::extras::layer_mark(&g))
            .nth(21)
            .unwrap()
            .to_owned()
    };
    let none = run("none");
    let bridged = run("partiallybridge");
    // Without it the walls round the narrow hole hang over the bore; with it they are gone and part of the
    // floor is a bridge anchored on the boss.
    assert!(
        feature_mm(&none, "Overhang wall") > 0.5,
        "{}",
        feature_mm(&none, "Overhang wall")
    );
    assert!(feature_mm(&bridged, "Overhang wall") < 1e-6);
    assert!(feature_mm(&bridged, "Bridge") > 2.0);
}

#[test]
fn the_layer_change_retracts_between_the_two_layer_change_g_codes() {
    // Orca's order (GCode::process_layer, change_layer): before_layer_change_gcode, the retraction, layer_change_gcode.
    let r = two_objects(
        json!({"before_layer_change_gcode": "; BEFORE", "layer_change_gcode": "; AFTER", "retraction_length": 0.8, "retract_when_changing_layer": true}),
        json!({"flavor": "marlin2"}),
    );
    let g = text(&r);
    let layer = g.split(sx_core::extras::layer_mark(&g)).nth(3).unwrap();
    let before = layer.find("; BEFORE").unwrap();
    let after = layer.find("; AFTER").unwrap();
    let retract = layer
        .lines()
        .position(|l| l.starts_with("G1 E-"))
        .map(|i| layer.lines().take(i).map(|l| l.len() + 1).sum::<usize>())
        .unwrap();
    assert!(before < retract && retract < after, "{}", &layer[..after + 8]);
}

/// The 20 mm cube on filament `slot`, with two filaments loaded.
fn cube_on(config: Value, slot: u8) -> String {
    let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
    let m = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": [{"id": "a", "name": "cube", "mesh": "c", "slotOverrides": {"cube.stl": slot}}]},
        "config": config,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
    String::from_utf8(r.gcode).unwrap()
}

#[test]
fn the_start_loads_the_filament_the_plate_prints_with() {
    // an a1 plate printed with the second filament: orca's start loads it from the ams and heats for it
    // (`initial_extruder_id`, `initial_non_support_extruder_id`)
    let c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab A1",
        "single_extruder_multi_material": true,
        "nozzle_temperature_initial_layer": [215, 235],
        "nozzle_temperature": [210, 230],
        "machine_start_gcode": "M620 S[initial_no_support_extruder]A\nT[initial_no_support_extruder]\nM109 S[nozzle_temperature_initial_layer]\nM104 S{nozzle_temperature_initial_layer[initial_extruder]}",
        "filament_start_gcode": ["; start one", "; start two"],
        "filament_end_gcode": ["; end one", "; end two"],
        "machine_end_gcode": "M104 S0 ; [current_extruder]",
    });
    let g = cube_on(c, 2);
    assert!(
        g.contains("\nM620 S1A\nT1\nM109 S235\nM104 S235\n"),
        "{}",
        &g[g.find("M620 S").unwrap_or(0)..][..200]
    );
    // the second filament's start, the bambu filament mark, and the spaghetti detector before the first layer
    let start = g.find("; start two\n;VT1\n").unwrap();
    assert!(!g.contains("\n; start one\n"));
    let spaghetti = g.find("M981 S1 P20000 ;open spaghetti detector\n").unwrap();
    let layer = g.find("; CHANGE_LAYER\n").unwrap();
    assert!(start < spaghetti && spaghetti < layer);
    // a shared nozzle ends with the filament in it
    assert!(g.contains("; end two\nM104 S0 ; 1\n") && !g.contains("\n; end one\n"));
}

#[test]
fn the_bed_mesh_follows_orcas_first_layer_hull() {
    // orca's first layer hull is the skirt's (`Print::_make_skirt`): the 20 mm cube's outline before the elephant
    // foot compensation grown by skirt_distance and the loops, so a 118 to 138 cube probes from 116 with no loops
    let start = "G29 A1 X{first_layer_print_min[0]} Y{first_layer_print_min[1]} I{first_layer_print_size[0]} J{first_layer_print_size[1]}\nM400 ; {adaptive_bed_mesh_min[0]} {adaptive_bed_mesh_max[1]} {bed_mesh_probe_count[0]}x{bed_mesh_probe_count[1]} {bed_mesh_algo}";
    let mut c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab A1",
        "machine_start_gcode": start,
        "elefant_foot_compensation": 0.075,
        "brim_type": "no_brim",
        "skirt_loops": 0,
        "skirt_distance": 2,
        "skirt_height": 1,
        "initial_layer_line_width": 0.5,
        "initial_layer_print_height": 0.2,
        "adaptive_bed_mesh_margin": 5,
        "bed_mesh_min": [-99999, 120],
        "bed_mesh_probe_distance": [10, 50],
    });
    let line = |g: &str, s: &str| g.lines().find(|l| l.starts_with(s)).unwrap().to_owned();
    let g = cube_on(c.clone(), 1);
    assert_eq!(line(&g, "G29 A1"), "G29 A1 X116 Y116 I24 J24");
    // the margin within the mesh limits, 10 mm apart across, at least 3 a side; more than 6 points is bicubic
    assert_eq!(line(&g, "M400 ; "), "M400 ; 111 145 5x3 bicubic");
    // two loops 0.45708 mm apart (0.5 mm wide at 0.2 mm) put the hull 2.91416 mm out
    c["skirt_loops"] = json!(2);
    let g = cube_on(c, 1);
    assert_eq!(line(&g, "G29 A1"), "G29 A1 X115.086 Y115.086 I25.8283 J25.8283");
}

#[test]
fn the_a1_bed_mesh_takes_the_brim_and_skirt_as_orca_does() {
    // Measured with Orca 2.4.2 on the same 20 mm cube (bench/compare/printer_gcode_parity.py, plates center and
    // skirt): a 5 mm outer brim of 0.42 mm lines puts the hull 6.525 mm out, two skirt loops 3 mm away 8.279 mm.
    let start = "G29 A1 X{first_layer_print_min[0]} Y{first_layer_print_min[1]} I{first_layer_print_size[0]} J{first_layer_print_size[1]}";
    let mut c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab A1",
        "machine_start_gcode": start,
        "brim_type": "outer_only",
        "brim_width": 5,
        "line_width": 0.42,
        "initial_layer_line_width": 0.42,
        "initial_layer_print_height": 0.2,
        "skirt_loops": 0,
    });
    let line = |g: &str| g.lines().find(|l| l.starts_with("G29 A1")).unwrap().to_owned();
    assert_eq!(
        line(&cube_on(c.clone(), 1)),
        "G29 A1 X111.475 Y111.475 I33.0499 J33.0499"
    );
    c["skirt_loops"] = json!(2);
    c["skirt_distance"] = json!(3);
    c["skirt_height"] = json!(1);
    assert_eq!(line(&cube_on(c, 1)), "G29 A1 X109.721 Y109.721 I36.5582 J36.5582");
}

#[test]
fn an_extruder_that_prints_nothing_has_no_first_filament() {
    // The H2D numbers its extruders through physical_extruder_map. Orca 2.4.2 writes -1 for an extruder that prints
    // no filament: one filament, on the right extruder where the map puts it, gives `0, -1`, and the start's
    // `M620.17 T1 ... L-1` (was L0). Mapped by hand to the other extruder, it moves over.
    let start = "; ff {first_filaments[0]} {first_filaments[1]} fns {first_non_support_filaments[0]} {first_non_support_filaments[1]}";
    let mut c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab H2D",
        "nozzle_diameter": [0.4, 0.4],
        "physical_extruder_map": [1, 0],
        "master_extruder_id": 2,
        "single_extruder_multi_material": true,
        "machine_start_gcode": start,
    });
    let line = |g: &str| g.lines().find(|l| l.starts_with("; ff ")).unwrap().to_owned();
    assert_eq!(line(&cube_on(c.clone(), 1)), "; ff 0 -1 fns 0 -1");
    c["filament_map_mode"] = json!("Manual");
    c["filament_map"] = json!([1]);
    assert_eq!(line(&cube_on(c, 1)), "; ff -1 0 fns -1 0");
}

#[test]
fn a_filament_only_a_feature_prints_with_gets_an_extruder() {
    // An H2D cube with its sparse infill on filament 2: the map takes filament 2 too, and as Bambu Studio maps two
    // filaments that cost the same, filament 1 goes to the right (master) extruder and 2 to the left
    // (`filament_map = 2,1`).
    let c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab H2D",
        "nozzle_diameter": [0.4, 0.4],
        "physical_extruder_map": [1, 0],
        "master_extruder_id": 2,
        "single_extruder_multi_material": true,
        "sparse_infill_filament_id": 2,
        "nozzle_temperature": [220, 225],
        "filament_diameter": [1.75, 1.75],
        "machine_start_gcode": "; map {filament_map[0]} {filament_map[1]}",
    });
    let g = cube_on(c, 1);
    assert_eq!(g.lines().find(|l| l.starts_with("; map ")), Some("; map 2 1"));
}

#[test]
fn the_in_printer_flush_counts_in_the_filament_used() {
    // Bambu Studio's used weight takes in the flush the H2D's change template writes as `;VG1` lines: the nozzle's
    // volume of it (130 mm3) is the filament the nozzle held, the rest the new filament. Filament 1 to 2 flushes
    // 347 mm3 (130 to 1, 217 to 2), 2 to 1 flushes 120 mm3 (all of it to 2, as it is under 130).
    let mut c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab H2D",
        "nozzle_diameter": [0.4, 0.4],
        "physical_extruder_map": [1, 0],
        "master_extruder_id": 2,
        "single_extruder_multi_material": true,
        "filament_map_mode": "Manual",
        "filament_map": [1, 1],
        "outer_wall_filament_id": 2,
        "filament_diameter": [1.75, 1.75],
        "nozzle_volume": [130, 145],
        "flush_volumes_matrix": [0, 347, 120, 0, 0, 347, 120, 0],
        "flush_multiplier": [1, 1],
        "change_filament_gcode": "; change {current_filament_id} {next_filament_id}\n; VFLUSH_START\n;VG1 E{flush_length}\n; VFLUSH_END",
    });
    let run = |config: Value| -> (String, Vec<f64>) {
        let bytes = std::fs::read(format!("{}/packages/core/cli/tests/fixtures/cube.stl", root())).unwrap();
        let m = Arc::new(Mesh::load(&bytes, "cube.stl").unwrap());
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": [{"id": "a", "name": "cube", "mesh": "c", "slotOverrides": {"cube.stl": 1}}]},
            "config": config,
            "options": {"trustedGcode": true},
        }))
        .unwrap();
        let r = common::run_request(&req, &move |_: &str| Ok(m.clone())).unwrap();
        (String::from_utf8(r.gcode).unwrap(), r.report.stats.filament_mm)
    };
    let (g, with) = run(c.clone());
    let count = |from: &str| {
        g.lines()
            .filter(|l| l.starts_with(&format!("; change {from} ")))
            .count() as f64
    };
    let (n12, n21) = (count("0"), count("1"));
    assert!(n12 > 2.0 && n21 > 2.0);
    c["change_filament_gcode"] = json!("; change {current_filament_id} {next_filament_id}");
    let (_, plain) = run(c);
    let area = std::f64::consts::PI * 0.875 * 0.875;
    // The first change into filament 2 finds its nozzle holding filament 1 too: every 1 to 2 change flushes.
    let one = (n12 * 130.0) / area;
    let two = (n12 * 217.0 + n21 * 120.0) / area;
    assert!(
        (with[0] - plain[0] - one).abs() < 0.05,
        "{} vs {}",
        with[0] - plain[0],
        one
    );
    assert!(
        (with[1] - plain[1] - two).abs() < 0.05,
        "{} vs {}",
        with[1] - plain[1],
        two
    );
}

#[test]
fn a_tower_change_reads_the_new_filaments_volumetric_speed() {
    // orca's change at the tower takes outer_wall_volumetric_speed of the new filament (`append_tcr`)
    let mut c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab A1",
        "change_filament_gcode": "M620 S[next_extruder]A\nT[next_extruder]\nM9833 F{outer_wall_volumetric_speed/2.4} A0.3",
        "sparse_infill_filament_id": 2,
        "filament_max_volumetric_speed": [20, 2],
        "enable_prime_tower": true,
    });
    let speeds = |g: &str| -> Vec<String> {
        g.lines()
            .filter(|l| l.starts_with("M9833 F"))
            .map(str::to_owned)
            .collect()
    };
    let g = cube(c.clone(), 1);
    let at_tower = speeds(&g);
    assert!(
        at_tower.iter().any(|l| l == "M9833 F0.833333 A0.3"),
        "{at_tower:?}"
    );
    // without the tower every change reads the start's filament
    c["enable_prime_tower"] = json!(false);
    let g = cube(c, 1);
    let plain = speeds(&g);
    assert!(
        !plain.is_empty() && plain.iter().all(|l| l != "M9833 F0.833333 A0.3"),
        "{plain:?}"
    );
}

#[test]
fn the_first_bed_temperature_is_the_plate_types_for_the_first_filament() {
    // orca's `bed_temperature_initial_layer_single`: the textured plate's first layer temperature of the
    // filament the plate starts with, or the hottest used one with `by_highest_temp`
    let mut c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab A1 mini",
        "curr_bed_type": "Textured PEI Plate",
        "hot_plate_temp_initial_layer": [70, 70],
        "textured_plate_temp_initial_layer": [65, 55],
        "textured_plate_temp": [65, 55],
        "machine_start_gcode": "M140 S[bed_temperature_initial_layer_single]\nM190 S{bed_temperature_initial_layer[initial_extruder]}",
    });
    assert!(cube_on(c.clone(), 2).contains("\nM140 S55\nM190 S55\n"));
    assert!(cube_on(c.clone(), 1).contains("\nM140 S65\nM190 S65\n"));
    c["bed_temperature_formula"] = json!("by_highest_temp");
    c["textured_plate_temp_initial_layer"] = json!([50, 60]);
    assert!(cube_on(c, 2).contains("\nM140 S60\nM190 S60\n"));
}

#[test]
fn an_auxiliary_fan_is_off_before_the_start() {
    // orca's `_do_export` writes both fans off ahead of the start g-code when the first layers run without a fan
    let mut c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab P1S",
        "auxiliary_fan": true,
        "close_fan_the_first_x_layers": [1],
        "machine_start_gcode": "; the start",
    });
    let g = cube_on(c.clone(), 1);
    let start = g.find("\n; the start\n").unwrap();
    assert!(
        g[..start].contains("\nM106 S0\nM106 P2 S0\n"),
        "{}",
        &g[start.saturating_sub(120)..start]
    );
    c["auxiliary_fan"] = json!(false);
    let g = cube_on(c, 1);
    let start = g.find("\n; the start\n").unwrap();
    assert!(!g[..start].contains("M106 P2 S0"));
}

#[test]
fn the_auxiliary_fan_runs_as_orcas_cooling_buffer_drives_it() {
    // off for the first layers, then `additional_cooling_fan_speed`, written when it changes, and off before the end
    let c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab P1S",
        "auxiliary_fan": true,
        "close_fan_the_first_x_layers": [1],
        "additional_cooling_fan_speed": [70],
        "machine_end_gcode": "M104 S0\nM140 S0",
    });
    let g = cube(c, 1);
    let aux: Vec<&str> = g.lines().filter(|l| l.starts_with("M106 P2")).collect();
    assert_eq!(aux, ["M106 P2 S0", "M106 P2 S0", "M106 P2 S178", "M106 P2 S0"]);
    assert!(g.contains("M106 P2 S0\nM981 S0 P20000"));
}

#[test]
fn the_ams_travel_path_is_written_at_the_second_change() {
    // `toolchange_count` counts the print's changes; `travel_point_*` is the strip past the objects to the
    // cutter (`get_path_of_change_filament`): the 118 to 138 cube leaves x 54 free
    let mut c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab X1 Carbon",
        "change_filament_gcode": "M620 S[next_extruder]A\nT[next_extruder]\n; change [toolchange_count]\n{if toolchange_count == 2}M620.1 X[travel_point_1_x] Y[travel_point_1_y] P0\nM620.1 X[travel_point_3_x] Y[travel_point_3_y] P2\n{endif}",
        "sparse_infill_filament_id": 2,
        "start_end_points": ["30x-3", "54x245"],
        "bed_exclude_area": ["0x0", "18x0", "18x28", "0x28"],
        "enable_prime_tower": false,
    });
    let g = cube(c.clone(), 1);
    let counts: Vec<u32> = g
        .lines()
        .filter_map(|l| l.strip_prefix("; change "))
        .map(|n| n.parse().unwrap())
        .collect();
    assert!(
        counts.len() > 3 && counts.iter().enumerate().all(|(i, &n)| n as usize == i + 1),
        "{counts:?}"
    );
    let travel: Vec<&str> = g.lines().filter(|l| l.starts_with("M620.1 X")).collect();
    assert_eq!(travel, ["M620.1 X54 Y0 P0", "M620.1 X54 Y245 P2"]);
    // every shard counts from the start of the print
    assert_eq!(cube(c.clone(), 40), g);
    // an end point behind the cube takes the nearest free strip edge, x 116 here
    c["start_end_points"] = json!(["30x-3", "125x245"]);
    let g = cube(c, 1);
    assert!(g.contains("\nM620.1 X116 Y0 P0\nM620.1 X116 Y245 P2\n"));
}

#[test]
fn a_bambu_change_selects_the_filament_with_m1020() {
    // orca's tool command on a bambu lab printer is `M1020 S` (`GCodeWriter::toolchange_prefix`), written after
    // the change g-code when it selects nothing with it
    let c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab A1",
        "change_filament_gcode": "M620 S[next_extruder]A\nT[next_extruder]\nM621 S[next_extruder]A",
        "sparse_infill_filament_id": 2,
        "enable_prime_tower": false,
    });
    let g = cube(c, 1);
    assert!(g.contains("\nT1\nM621 S1A\n"));
    assert!(
        g.contains("\nM621 S1A\nM106 S"),
        "the fans come back after the change"
    );
    assert!(g.contains("\nM1020 S1\n"));
}

#[test]
fn a_bambu_tower_change_is_framed_as_orcas_tower_writes_it() {
    // `WipeTower::tool_change_new` and `append_tcr`: the change header, the old filament's end, the change,
    // the tool command, the new filament's start, then the wipe on the tower, closed by the change footer
    let c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab A1",
        "change_filament_gcode": "; the change",
        "filament_type": ["PLA", "PETG"],
        "filament_start_gcode": ["; start one", "; start two"],
        "filament_end_gcode": ["; end one", "; end two"],
        "sparse_infill_filament_id": 2,
        "enable_prime_tower": true,
    });
    let g = cube(c, 1);
    let first = g.find("; CP TOOLCHANGE START\n").unwrap();
    let block = &g[first..first + g[first..].find("; CP TOOLCHANGE END\n").unwrap()];
    assert!(block.starts_with("; CP TOOLCHANGE START\n; toolchange #1\n; material : PLA -> PETG\n;--------------------\nM220 S100\n; WIPE_TOWER_START\n"), "{block}");
    let at = |s: &str| block.find(s).unwrap_or_else(|| panic!("no {s:?} in {block}"));
    // the object's label closes after the lift, just ahead of the old filament's end
    assert!(block.contains("\nM625\n; end one\n"), "{block}");
    assert!(at("\n; end one\n") < at("\n; the change\n"));
    assert!(at("\n; the change\n") < at("\nM1020 S1\n"));
    assert!(at("\nM1020 S1\n") < at("\n; start two\n"));
    assert!(at("\n; start two\n") < at("\nG4 S0\n; CP TOOLCHANGE WIPE\n"));
    assert!(
        block.ends_with("; WIPE_TOWER_END\nG1 F30000\nG4 S0\nG92 E0\n")
            || block.contains("; WIPE_TOWER_END\nG1 F"),
        "{block}"
    );
    // a tower block with no change in it is framed too
    assert!(g.matches("; WIPE_TOWER_START\n").count() >= g.matches("; CP TOOLCHANGE START\n").count());
    assert_eq!(
        g.matches("; WIPE_TOWER_START\n").count(),
        g.matches("; WIPE_TOWER_END\n").count()
    );
}

#[test]
fn travel_runs_at_the_profiles_speed_above_the_axis_limit() {
    // orca writes travel_speed as the profile sets it (the a1's 700 mm/s on 500 mm/s axes); the firmware caps it
    let c = json!({
        "travel_speed": 700,
        "machine_max_speed_x": [500, 200],
        "machine_max_speed_y": [500, 200],
    });
    let g = cube(c, 1);
    assert!(g.contains(" F42000\n") && !g.contains(" F30000\n"));
}

#[test]
fn the_layer_fan_comes_ahead_of_the_layer_change() {
    // orca's cooling buffer writes a layer's fan at the head of its g-code, before the layer change, and
    // `change_layer` marks the fan's place after the layer change g-code
    let c = json!({"gcode_flavor": "marlin", "printer_model": "Bambu Lab A1"});
    let g = cube(c, 1);
    let lines: Vec<&str> = g.lines().collect();
    let marks: Vec<usize> = (1..lines.len())
        .filter(|&i| lines[i] == "; CHANGE_LAYER")
        .collect();
    assert!(marks.len() > 10);
    assert!(
        marks.iter().all(|&i| lines[i - 1].starts_with("M106 S")),
        "{:?}",
        &lines[marks[1] - 3..=marks[1]]
    );
    assert_eq!(g.matches(";_SET_FAN_SPEED_CHANGING_LAYER\n").count(), marks.len());
}

#[test]
fn a_bambu_tower_has_orcas_rib_wall_and_brim_chamfer() {
    // orca's rib wall (`generate_rib_polygon`, filleted) reaches about 2 mm past the tower's box at every corner,
    // the tower moves by that much (`m_rib_offset`), and the brim narrows a loop a layer up to 3 mm
    // (`finish_layer_new`); orca's a1 tower at 15, 220 reaches x 14.96 from layer 8 up
    let c = json!({
        "gcode_flavor": "marlin",
        "printer_model": "Bambu Lab A1",
        "change_filament_gcode": "M620 S[next_extruder]A\nT[next_extruder]",
        "sparse_infill_filament_id": 2,
        "enable_prime_tower": true,
        "prime_tower_auto_position": false,
        "wipe_tower_x": [15],
        "wipe_tower_y": [220],
        "prime_tower_brim_width": 3,
        "wipe_tower_wall_type": "rib",
    });
    let g = cube(c, 1);
    let mut min_x: Vec<f64> = Vec::new();
    let (mut tower, mut layer) = (false, 0usize);
    for l in g.lines() {
        if l == "; CHANGE_LAYER" {
            layer += 1;
            min_x.push(f64::MAX);
        } else if let Some(f) = l.strip_prefix("; FEATURE: ") {
            tower = f == "Prime tower";
        } else if tower && l.starts_with("G1 X") && l.contains(" E") && !l.contains(" E-") {
            let x: f64 = l[4..].split(' ').next().unwrap().parse().unwrap();
            if let Some(m) = min_x.get_mut(layer - 1) {
                *m = m.min(x);
            }
        }
    }
    assert!(min_x[9] > 14.9 && min_x[9] < 15.1, "{:?}", &min_x[..10]);
    assert!(min_x[1] < min_x[9] - 1.5, "{:?}", &min_x[..10]);
    assert!(min_x[0] < min_x[1], "{:?}", &min_x[..10]);
}

#[test]
fn a_spiral_lift_is_commented_as_orca_comments_it() {
    // Orca's GCodeWriter::_spiral_travel_to_z: ";spiral lift Z" before the segments, which carry no comment of
    // their own, and with arc fitting "G17 ; XY plane for arc" and the comment on the G3.
    let mut c = base_config();
    c["gcode_comments"] = json!(true);
    c["z_hop"] = json!(0.4);
    c["retract_lift_above"] = json!(0);
    c["z_hop_types"] = json!("Spiral Lift");
    let g = text(&two_objects(c.clone(), json!({})));
    let at = g.find(";spiral lift Z\nG1 F").expect("a commented spiral");
    let segment = g[at..].lines().nth(2).unwrap();
    assert!(
        segment.starts_with("G1 X") && segment.contains(" Z") && !segment.contains(';'),
        "{segment}"
    );
    assert!(!g.contains("Z0.25 ; move inwards before travel"));
    c["enable_arc_fitting"] = json!(true);
    let arcs = text(&two_objects(c, json!({})));
    assert!(arcs.contains("G17 ; XY plane for arc\nG3 Z"), "an arc spiral");
    assert!(
        arcs.lines()
            .any(|l| l.starts_with("G3 Z") && l.ends_with(" ; spiral lift Z"))
    );
}

#[test]
fn no_jerk_line_is_written_for_a_travel_that_does_not_move() {
    // A zig-zag solid fill joins its lines end to start. SlicerX wrote the travel jerk and then the print jerk
    // between every two of them, with no move between; Orca's GCode::_extrude calls travel_to only when the
    // nozzle is not already at the path's first point.
    let mut c = base_config();
    for (k, v) in [
        ("default_acceleration", 5000),
        ("travel_acceleration", 8000),
        ("initial_layer_acceleration", 1000),
        ("default_jerk", 10),
        ("initial_layer_jerk", 5),
        ("outer_wall_jerk", 7),
        ("inner_wall_jerk", 8),
        ("top_surface_jerk", 6),
        ("infill_jerk", 9),
    ] {
        c[k] = json!(v);
    }
    c["gcode_flavor"] = json!("marlin2");
    let g = text(&two_objects(c, json!({})));
    let lines: Vec<&str> = g
        .lines()
        .filter(|l| !l.starts_with(';') && !l.is_empty())
        .collect();
    let back_to_back = lines
        .windows(2)
        .filter(|w| w[0].starts_with("M205 ") && w[1].starts_with("M205 "))
        .count();
    assert_eq!(back_to_back, 0, "a jerk line replaced at once by another");
    assert!(
        lines.iter().any(|l| l.starts_with("M205 X10")),
        "travel jerk still written"
    );
}

#[test]
fn a_one_or_two_layer_raft_prints_its_contact_lines_at_orcas_angle() {
    // One raft layer is only the contact layer: Orca (SupportParameters: raft_angle_interface 90 degrees, and
    // raft_interface_angle(0) a further 45) lays its lines at 135 degrees, where SlicerX laid them at 90. With
    // two, the contact layer rests on the first one and takes its interface id plus one (SupportCommon.cpp
    // generate_support_layers), so 180 less 45: 135 again, where SlicerX laid 45.
    for layers in [1, 2] {
        let mut c = base_config();
        c["raft_layers"] = json!(layers);
        assert_eq!(
            contact_angle(&text(&two_objects(c, json!({})))),
            Some(135),
            "{layers} raft layers"
        );
    }
}

/// The most common direction, whole degrees in 0..180, of the support interface lines longer than 2 mm.
fn contact_angle(g: &str) -> Option<i64> {
    let mut feature = String::new();
    let mut at: Option<(f64, f64)> = None;
    let mut hist = std::collections::BTreeMap::<i64, usize>::new();
    for l in g.lines() {
        if let Some(t) = l.strip_prefix(";TYPE:") {
            t.clone_into(&mut feature);
            continue;
        }
        let coord = |k: char| {
            l.split_whitespace()
                .find_map(|w| w.strip_prefix(k))
                .and_then(|v| v.parse::<f64>().ok())
        };
        if !(l.starts_with("G0 ") || l.starts_with("G1 ")) {
            continue;
        }
        let (Some(x), Some(y)) = (coord('X'), coord('Y')) else {
            continue;
        };
        if let Some((px, py)) = at
            && feature == "Support interface"
            && l.contains(" E")
            && (x - px).hypot(y - py) > 2.0
        {
            #[allow(clippy::cast_possible_truncation, reason = "a whole degree")]
            let a = ((y - py).atan2(x - px).to_degrees().rem_euclid(180.0)).round() as i64;
            *hist.entry(a).or_default() += 1;
        }
        at = Some((x, y));
    }
    hist.iter().max_by_key(|(_, n)| **n).map(|(a, _)| *a)
}
