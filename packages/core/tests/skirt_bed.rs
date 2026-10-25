// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A skirt that would run off the bed, or into an excluded bed area, is cut to the bed as the brim is: the plate
//! slices, every skirt line stays on the bed, and the slice notes that the skirt was cut and beside which object.
//! The plate is refused only when less than one whole loop's length of skirt is left on the bed.
//!
//! The cases are the P1S plates measured at the bed's edges: the x-mark with a 4 mm outer brim, the engine's skirt
//! (1 loop, 2 mm out) or 2 loops 3 mm out, with or without `min_skirt_length` 60. Before the cut, a skirt up to
//! 1.89 mm past the edge sliced and printed off the bed, and one 1.9 mm or more past it was refused.

// Test inputs are small counts and exact expected values.
#![allow(clippy::cast_precision_loss, clippy::float_cmp)]
// Checks measure the output with the standard math functions; the engine's own rounding rule (clippy.toml) is for G-code.
#![allow(clippy::disallowed_methods)]

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest, SliceRun};

const BED: f64 = 256.0;
/// The P1S's extruder offset in Y: its G-code is written 2 mm in front of where it prints on the plate.
const P1S_OFFSET_Y: f64 = 2.0;

fn x_mark() -> Arc<Mesh> {
    let path = format!("{}/bench/models/x-mark.stl", env!("CARGO_MANIFEST_DIR"));
    Arc::new(Mesh::load(&std::fs::read(path).unwrap(), "x-mark.stl").unwrap())
}

/// A box `width` by `depth` by `height` mm, centered on its origin in X and Y.
fn slab(width: f32, depth: f32, height: f32) -> Arc<Mesh> {
    let (left, right, front, back) = (-width / 2.0, width / 2.0, -depth / 2.0, depth / 2.0);
    let mut positions = Vec::new();
    for top in [0.0, height] {
        for (px, py) in [(left, front), (right, front), (right, back), (left, back)] {
            positions.push([px, py, top]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    Arc::new(Mesh {
        name: "slab".into(),
        parts: vec![api::MeshPart {
            name: "slab".into(),
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

/// The P1S request fixture's settings with a 4 mm outer brim and `skirt` on top.
fn p1s(skirt: &Value) -> Value {
    let path = format!(
        "{}/cli/tests/fixtures/xmark-p1s-request.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let req: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut cfg = req["config"].clone();
    cfg["brim_type"] = json!("outer_only");
    cfg["brim_width"] = json!(4);
    for (k, v) in skirt.as_object().unwrap() {
        cfg[k] = v.clone();
    }
    cfg
}

/// The engine's skirt, and 2 loops 3 mm out.
fn engine() -> Value {
    json!({"skirt_loops": 1, "skirt_distance": 2})
}
fn two_loops() -> Value {
    json!({"skirt_loops": 2, "skirt_distance": 3})
}

/// Slices `mesh` named as given at each of `at` (mm) with `config`.
fn slice(mesh: Arc<Mesh>, name: &str, at: &[(f64, f64)], config: &Value) -> sx_core::Result<SliceRun> {
    let objects: Vec<Value> = at
        .iter()
        .enumerate()
        .map(|(i, (x, y))| {
            json!({"id": format!("o{i}"), "name": name, "mesh": "m",
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": 256, "depthMm": 256, "heightMm": 250}, "objects": objects},
        "config": config,
        "options": {"emitGcode": true, "emitPreview": false, "shards": 1, "trustedGcode": true},
    }))
    .unwrap();
    api::run_request(&req, &move |_: &str| Ok(mesh.clone()))
}

/// The first layer's skirt moves that extrude, as segments in plate space (G-code plus `offset_y`), mm.
fn first_layer_skirt(run: &SliceRun, offset_y: f64) -> Vec<[[f64; 2]; 2]> {
    let g = String::from_utf8(run.gcode.clone()).unwrap();
    let mark = sx_core::extras::layer_mark(&g);
    let first = g.split(mark).nth(1).unwrap_or("");
    let (mut skirt, mut at) = (false, None::<[f64; 2]>);
    let mut out = Vec::new();
    for line in first.lines() {
        if let Some(t) = line
            .strip_prefix(";TYPE:")
            .or_else(|| line.strip_prefix("; FEATURE: "))
        {
            skirt = t.trim() == "Skirt";
            continue;
        }
        // Arcs count by their ends, as the measurements did.
        if !["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|g| line.starts_with(g)) {
            continue;
        }
        let word = |c: char| {
            line.split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        let prev = at;
        if let (Some(x), Some(y)) = (word('X'), word('Y')) {
            at = Some([x, y + offset_y]);
        } else if let Some(x) = word('X') {
            at = prev.map(|p| [x, p[1]]);
        } else if let Some(y) = word('Y') {
            at = prev.map(|p| [p[0], y + offset_y]);
        }
        // An extruding move, not an unretract in place.
        if skirt
            && word('E').is_some_and(|e| e > 0.0)
            && (word('X').is_some() || word('Y').is_some())
            && let (Some(a), Some(b)) = (prev, at)
        {
            out.push([a, b]);
        }
    }
    out
}

/// How far the skirt reaches past the bed's edge, mm (0 when it stays on the bed).
fn overshoot(segs: &[[[f64; 2]; 2]]) -> f64 {
    segs.iter()
        .flatten()
        .map(|p| (-p[0]).max(-p[1]).max(p[0] - BED).max(p[1] - BED))
        .fold(f64::MIN, f64::max)
}

/// The skirt's length on the first layer, mm.
fn length(segs: &[[[f64; 2]; 2]]) -> f64 {
    segs.iter().map(|[a, b]| (b[0] - a[0]).hypot(b[1] - a[1])).sum()
}

/// The notes of a run that say the skirt was cut.
fn skirt_notes(run: &SliceRun) -> Vec<String> {
    run.report
        .warnings
        .iter()
        .map(|w| w.message.clone())
        .filter(|m| m.contains("skirt"))
        .collect()
}

/// The note for a skirt cut beside `name`, once, on the first layer and as an off-the-bed warning.
fn assert_noted(run: &SliceRun, name: &str) {
    let notes: Vec<_> = run
        .report
        .warnings
        .iter()
        .filter(|w| w.message.contains("skirt"))
        .collect();
    assert_eq!(notes.len(), 1, "one skirt note: {notes:?}");
    let w = notes[0];
    assert_eq!(
        w.message,
        format!("The skirt near \"{name}\" was cut to fit on the bed")
    );
    assert_eq!(w.code, sx_core::WarningCode::OutsideBed);
    assert_eq!(w.layer, Some(0));
}

/// Slices the x-mark at (`x`, `y`) on the P1S with `skirt` and checks that it slices with its skirt cut to the
/// bed, noted, and its bead on the bed. Gives the run and its first layer skirt.
fn cut_and_noted(x: f64, y: f64, skirt: &Value) -> (SliceRun, Vec<[[f64; 2]; 2]>) {
    let run = slice(x_mark(), "x-mark", &[(x, y)], &p1s(skirt))
        .unwrap_or_else(|e| panic!("{x} {y} {skirt}: the skirt is cut to the bed instead of refusing: {e}"));
    let segs = first_layer_skirt(&run, P1S_OFFSET_Y);
    assert!(!segs.is_empty(), "{x} {y} {skirt}: no skirt");
    let over = overshoot(&segs);
    // The centerline stays half a line spacing in from the edge, so the bead is on the bed.
    assert!(
        over <= -0.15,
        "{x} {y} {skirt}: the skirt reaches {over:.2} mm past the bed's edge"
    );
    assert_noted(&run, "x-mark");
    (run, segs)
}

/// The card's plate: 2 loops 3 mm out, the x-mark at Y 238. Its skirt ran 0.67 mm past the back edge and printed
/// off the bed.
#[test]
fn a_skirt_just_past_the_back_edge_is_cut_to_the_bed_and_noted() {
    let (_, segs) = cut_and_noted(128.0, 238.0, &two_loops());
    let ys = segs.iter().flatten().map(|p| p[1]);
    assert!(
        ys.fold(f64::MIN, f64::max) > BED - 0.5,
        "the skirt still reaches the back edge"
    );
}

/// The largest overshoot that sliced before: 1.89 mm past the left edge with 2 loops at X 46. And the engine's skirt
/// 1.21 mm past the back edge at Y 240.
#[test]
fn a_skirt_up_to_1_89_mm_past_the_edge_no_longer_prints_off_the_bed() {
    cut_and_noted(46.0, 128.0, &two_loops());
    cut_and_noted(128.0, 240.0, &engine());
}

/// Skirts 1.9 mm or more past the edge were refused. Now they slice, cut: on every side, and with the part's own
/// first layer reaching to within a millimeter of the edge (Y 242, X 42.5).
#[test]
fn a_skirt_1_9_mm_or_more_past_the_edge_slices_cut_instead_of_being_refused() {
    for (x, y, skirt) in [
        (128.0, 240.0, two_loops()),
        (128.0, 242.0, engine()),
        (128.0, 242.0, two_loops()),
        (128.0, 14.0, engine()),
        (44.0, 128.0, engine()),
        (42.5, 128.0, two_loops()),
        (212.0, 128.0, engine()),
        (213.5, 128.0, two_loops()),
    ] {
        cut_and_noted(x, y, &skirt);
    }
}

/// With `min_skirt_length`, the length counted is what is left on the bed, and the loops added for it are cut too.
#[test]
fn min_skirt_length_counts_the_skirt_left_on_the_bed() {
    // The filament of a mm of skirt with the first layer's lines all 0.42 mm wide and 0.2 mm high, 1.75 mm filament.
    let (w, h, d) = (0.42_f64, 0.2_f64, 1.75_f64);
    let lines = |mut v: Value| {
        v["min_skirt_length"] = json!(60);
        for k in ["line_width", "initial_layer_line_width"] {
            v[k] = json!(w);
        }
        v["initial_layer_print_height"] = json!(h);
        v["filament_diameter"] = json!([d]);
        v
    };
    let spacing = (w - h * (1.0 - std::f64::consts::FRAC_PI_4)).max(w * 0.5);
    let need = 60.0 / (spacing * h / (std::f64::consts::PI * d * d / 4.0));
    // Front Y 18 (1.88 mm past, sliced before), back Y 236 with 2 loops (0.95 mm past, sliced before), back Y 238
    // (refused before).
    for (x, y, skirt) in [
        (128.0, 18.0, lines(engine())),
        (128.0, 236.0, lines(two_loops())),
        (128.0, 238.0, lines(engine())),
        (44.0, 128.0, lines(two_loops())),
    ] {
        let (_, segs) = cut_and_noted(x, y, &skirt);
        let on_bed = length(&segs);
        assert!(
            on_bed >= need - 1.0,
            "{x} {y} {skirt}: {on_bed:.1} mm of skirt on the bed, {need:.1} mm asked"
        );
    }
}

/// A skirt that fits is not touched and gets no note.
#[test]
fn a_skirt_that_fits_is_whole_and_not_noted() {
    let run = slice(x_mark(), "x-mark", &[(128.0, 128.0)], &p1s(&two_loops())).unwrap();
    assert!(skirt_notes(&run).is_empty(), "{:?}", skirt_notes(&run));
    let segs = first_layer_skirt(&run, P1S_OFFSET_Y);
    assert!(overshoot(&segs) < -10.0);
}

/// A plain 256 mm bed with no excluded areas, on a printer whose travel ends at the bed's edge.
fn open_bed(skirt: &Value) -> Value {
    let mut cfg = json!({
        "printable_area": ["0x0", "256x0", "256x256", "0x256"],
        "gcode_flavor": "marlin2",
        "brim_type": "no_brim",
        "brim_width": 0,
        "skirt_height": 1,
    });
    for (k, v) in skirt.as_object().unwrap() {
        cfg[k] = v.clone();
    }
    cfg
}

/// A slab as wide as the bed leaves room for the skirt only in front of it and behind it. One loop cut there keeps
/// less than a loop's length on the bed, so loops are added outward, each cut, until a whole loop's length is.
#[test]
fn a_skirt_cut_on_two_sides_gets_loops_added_until_a_whole_loops_length_is_on_the_bed() {
    let run = slice(
        slab(253.0, 100.0, 1.0),
        "wide",
        &[(128.0, 128.0)],
        &open_bed(&json!({"skirt_loops": 1, "skirt_distance": 2})),
    )
    .expect("the cut skirt keeps a loop's length");
    assert_noted(&run, "wide");
    let segs = first_layer_skirt(&run, 0.0);
    assert!(overshoot(&segs) <= -0.15, "{}", overshoot(&segs));
    // One whole loop round the slab, 2.2 mm out: about 2 x (253 + 100) + 2 pi x 2.2 mm.
    let loop_mm = 2.0 * (253.0 + 100.0) + 2.0 * std::f64::consts::PI * 2.2;
    let on_bed = length(&segs);
    assert!(
        on_bed >= loop_mm - 1.0,
        "{on_bed:.1} mm of skirt on the bed, a loop is {loop_mm:.1} mm"
    );
    // Only the runs in front of and behind the slab are left: no loop is whole.
    let beside: Vec<_> = segs
        .iter()
        .filter(|s| s.iter().any(|p| p[1] > 78.0 && p[1] < 178.0))
        .collect();
    assert!(beside.is_empty(), "{beside:?}");
}

/// A slab that fills the bed leaves no room for any of its skirt: the plate is refused, and the message names the
/// object and what to do.
#[test]
fn a_skirt_with_no_room_on_the_bed_is_refused_with_a_clear_message() {
    let err = slice(
        slab(253.0, 253.0, 1.0),
        "big",
        &[(128.0, 128.0)],
        &open_bed(&json!({"skirt_loops": 1, "skirt_distance": 2})),
    )
    .expect_err("refused");
    let msg = err.to_string();
    assert_eq!(
        msg,
        "blocked by the safety preflight: the skirt round \"big\" does not fit on the bed: less than one full loop \
         of it is left inside the printable area; move \"big\" in from the edge, or lower the skirt distance"
    );
    // Without a skirt it prints.
    slice(
        slab(253.0, 253.0, 1.0),
        "big",
        &[(128.0, 128.0)],
        &open_bed(&json!({"skirt_loops": 0})),
    )
    .expect("no skirt, no refusal");
}

/// Near the P1S's excluded front left corner, the skirt is cut out of it as the brim is.
#[test]
fn a_skirt_is_cut_out_of_an_excluded_bed_area() {
    let (_, segs) = cut_and_noted(64.33, 27.0, &two_loops());
    let in_zone = |p: &[f64; 2]| p[0] < 18.0 - 0.05 && p[1] < 28.0 - 0.05;
    assert!(!segs.iter().flatten().any(in_zone), "skirt in the excluded area");
    assert!(
        segs.iter().flatten().any(|p| p[0] < 18.0 && p[1] > 28.0),
        "skirt above the area"
    );
}

/// Copies of one object print the first one's paths moved, but a skirt cut to the bed belongs to where it was cut:
/// the copy in the middle keeps its whole skirt and nothing leaves the bed.
#[test]
fn a_copy_away_from_the_edge_keeps_its_whole_skirt() {
    let mut cfg = p1s(&two_loops());
    cfg["skirt_type"] = json!("perobject");
    let run = slice(x_mark(), "x-mark", &[(128.0, 240.0), (128.0, 80.0)], &cfg)
        .expect("the skirt is cut to the bed instead of refusing the plate");
    let segs = first_layer_skirt(&run, P1S_OFFSET_Y);
    assert!(overshoot(&segs) <= -0.15, "{}", overshoot(&segs));
    assert_noted(&run, "x-mark");
    let whole = first_layer_skirt(
        &slice(x_mark(), "x-mark", &[(128.0, 80.0)], &cfg).unwrap(),
        P1S_OFFSET_Y,
    );
    let middle: Vec<[[f64; 2]; 2]> = segs.into_iter().filter(|s| s[0][1] < 160.0).collect();
    assert!(
        (length(&middle) - length(&whole)).abs() < 0.5,
        "{} against {}",
        length(&middle),
        length(&whole)
    );
}
