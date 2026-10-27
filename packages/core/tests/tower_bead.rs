// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The prime tower prints the plain bead: E per mm is the bead's area over the filament's, with no filament flow
//! ratio, print flow ratio or role ratio on top, on Bambu Lab type towers and on type 2 towers alike. The rest of
//! the plate keeps its ratios.
//!
//! On a type 2 tower the purge rows are stated `wipe_tower_extra_flow` times the wall bead wide, laid that far
//! apart, and put down that many times the wall bead's volume per mm.
//!
//! Two 15 mm boxes 30 mm apart, A 8 mm tall on filament 1 and B 3 mm on filament 2, so every layer up to 3 mm
//! changes filament once.

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

/// The 1.75 mm filament's cross-section, mm2.
const FIL: f64 = std::f64::consts::PI * 0.875 * 0.875;

/// Cross-section of a bead `w` wide and `h` tall with rounded edges, mm2.
fn bead(w: f64, h: f64) -> f64 {
    h * (w - h * (1.0 - std::f64::consts::FRAC_PI_4))
}

/// E per mm of the plain bead `w` by `h`.
fn plain(w: f64, h: f64) -> f64 {
    bead(w, h) / FIL
}

/// An ASCII STL of a box from the origin to `size`.
fn box_stl(size: [f64; 3]) -> Vec<u8> {
    use std::fmt::Write as _;
    let corner = |index: usize| {
        std::array::from_fn::<f64, 3, _>(|axis| if index >> axis & 1 == 0 { 0.0 } else { size[axis] })
    };
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

fn fixture(name: &str) -> Value {
    let path = format!("{}/cli/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let req: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    req["config"].clone()
}

/// `cfg` with two filaments (lists by filament cut to two), the tower on and every wipe on it; `extra` over it.
fn two_filaments(mut cfg: Value, extra: &[(&str, Value)]) -> Value {
    let filaments = cfg["filament_flow_ratio"].as_array().map_or(1, Vec::len);
    for v in cfg.as_object_mut().unwrap().values_mut() {
        if let Some(a) = v.as_array_mut()
            && a.len() == filaments
            && filaments > 2
        {
            a.truncate(2);
        }
    }
    cfg["filament_colour"] = json!(["#F4EE2A", "#00AE42"]);
    cfg["enable_prime_tower"] = json!(true);
    cfg["smart_layer"] = json!("off");
    cfg["flush_into_infill"] = json!(false);
    cfg["flush_into_support"] = json!(false);
    cfg["flush_into_objects"] = json!(false);
    for (k, v) in extra {
        cfg[*k] = v.clone();
    }
    cfg
}

/// The stock A1 request's settings.
fn a1(extra: &[(&str, Value)]) -> Value {
    two_filaments(fixture("xmark-2color-a1-request.json"), extra)
}

/// The stock P1S request's settings.
fn p1s(extra: &[(&str, Value)]) -> Value {
    two_filaments(fixture("xmark-p1s-request.json"), extra)
}

/// A single extruder multi-material printer with a type 2 tower.
fn mmu(extra: &[(&str, Value)]) -> Value {
    let bench: Value = serde_json::from_slice(
        &std::fs::read(format!(
            "{}/bench/configs/reference-0.20.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    let mut cfg = bench["config"].clone();
    for (k, v) in [
        ("printer_model", json!("Prusa MK4")),
        ("wipe_tower_type", json!("type2")),
        ("single_extruder_multi_material", json!("1")),
        ("use_relative_e_distances", json!("1")),
        ("printable_area", json!(["0x0", "250x0", "250x210", "0x210"])),
        ("filament_diameter", json!(["1.75", "1.75"])),
        ("wipe_tower_x", json!(["20"])),
        ("wipe_tower_y", json!(["140"])),
        ("prime_tower_width", json!("60")),
        ("flush_volumes_matrix", json!(["0", "280", "280", "0"])),
        ("flush_multiplier", json!(["0.3"])),
    ] {
        cfg[k] = v;
    }
    two_filaments(cfg, extra)
}

/// The G-code of the two boxes with `cfg`, centered on a `bed` mm bed.
#[allow(clippy::needless_pass_by_value, reason = "the callers hand over fresh values")]
fn slice(cfg: Value, bed: [f64; 2]) -> String {
    let (cx, cy) = (bed[0] / 2.0, bed[1] / 2.0);
    let objects: Vec<Value> = [(8.0, cx - 15.0, 1), (3.0, cx + 15.0, 2)]
        .iter()
        .enumerate()
        .map(|(k, &(h, x, slot))| {
            json!({"id": format!("o{k}"), "name": format!("box {k}"), "mesh": format!("15 15 {h}"),
                   "slotOverrides": {"box": slot, "box.stl": slot, "": slot},
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x - 7.5, cy - 7.5, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": bed[0], "depthMm": bed[1], "heightMm": 220}, "objects": objects},
        "config": cfg,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let load = |id: &str| -> sx_core::Result<Arc<Mesh>> {
        let s: Vec<f64> = id.split(' ').map(|v| v.parse().unwrap()).collect();
        Ok(Arc::new(
            Mesh::load(&box_stl([s[0], s[1], s[2]]), "box.stl").unwrap(),
        ))
    };
    let run = api::run_request(&req, &load).unwrap();
    String::from_utf8_lossy(&run.gcode).into_owned()
}

const BAMBU_BED: [f64; 2] = [256.0, 256.0];
const MMU_BED: [f64; 2] = [250.0, 210.0];

/// One extruding straight move.
#[derive(Debug, Clone)]
struct Seg {
    /// 1 for the first layer.
    layer: usize,
    tool: u8,
    feature: String,
    /// The stated line width and layer height.
    w: f64,
    h: f64,
    from: [f64; 2],
    to: [f64; 2],
    len: f64,
    e: f64,
}

impl Seg {
    fn tower(&self) -> bool {
        self.feature == "Prime tower" || self.feature == "Wipe tower"
    }

    fn per_mm(&self) -> f64 {
        self.e / self.len
    }

    /// Every multiplier on top of the plain bead of the stated width and height.
    fn k(&self) -> f64 {
        self.per_mm() / plain(self.w, self.h)
    }
}

/// The extruding moves of a G-code written with relative E.
fn segs(gcode: &str) -> Vec<Seg> {
    assert!(gcode.lines().any(|l| l.starts_with("M83")), "relative E");
    let (mut out, mut layer, mut tool, mut at) = (Vec::new(), 0usize, 0u8, [f64::NAN; 2]);
    let (mut feature, mut w, mut h) = (String::new(), 0.0, 0.0);
    // A single nozzle's filament swap moves filament in and out of the cooling tube; it lays no bead.
    let mut swap = false;
    for line in gcode.lines() {
        let s = line.trim();
        if s.starts_with("; FILAMENT_SWAP_") {
            swap = s.ends_with("START");
            continue;
        }
        if s.starts_with(";LAYER_CHANGE") || s.starts_with("; CHANGE_LAYER") {
            layer += 1;
            continue;
        }
        if let Some(name) = s.strip_prefix("; FEATURE:").or_else(|| s.strip_prefix(";TYPE:")) {
            feature = name.trim().to_string();
            continue;
        }
        if let Some(v) = s
            .strip_prefix("; LINE_WIDTH:")
            .or_else(|| s.strip_prefix(";WIDTH:"))
        {
            w = v.trim().parse().unwrap_or(w);
            continue;
        }
        if let Some(v) = s
            .strip_prefix("; LAYER_HEIGHT:")
            .or_else(|| s.strip_prefix(";HEIGHT:"))
        {
            h = v.trim().parse().unwrap_or(h);
            continue;
        }
        let body = s.split(';').next().unwrap_or("").trim();
        if let Some(t) = body.strip_prefix('T')
            && let Ok(t) = t.parse::<u16>()
        {
            if t < 255 {
                tool = u8::try_from(t).unwrap();
            }
            continue;
        }
        let arc = body.starts_with("G2 ") || body.starts_with("G3 ");
        if !(body.starts_with("G1 ") || body.starts_with("G0 ") || arc) {
            continue;
        }
        let (mut to, mut e) = (at, 0.0);
        for word in body.split_whitespace().skip(1) {
            let value: f64 = word.get(1..).and_then(|v| v.parse().ok()).unwrap_or(f64::NAN);
            match word.as_bytes().first() {
                Some(b'X') => to[0] = value,
                Some(b'Y') => to[1] = value,
                Some(b'E') => e = value,
                _ => {}
            }
        }
        let (dx, dy) = (to[0] - at[0], to[1] - at[1]);
        let len = (dx * dx + dy * dy).sqrt();
        if !arc && !swap && e > 0.0 && len > 0.0 {
            out.push(Seg {
                layer,
                tool,
                feature: feature.clone(),
                w,
                h,
                from: at,
                to,
                len,
                e,
            });
        }
        at = to;
    }
    out
}

/// The tower moves of 1 mm or more.
fn tower(gcode: &str) -> Vec<Seg> {
    segs(gcode)
        .into_iter()
        .filter(|s| s.tower() && s.len >= 1.0)
        .collect()
}

/// Every move in `segs` puts down `want` E per mm within 0.3%, and there is at least one on each tool in
/// `tools`.
fn all_at(segs: &[&Seg], want: f64, tools: &[u8], what: &str) {
    for &t in tools {
        assert!(segs.iter().any(|s| s.tool == t), "{what}: no move on T{t}");
    }
    for s in segs {
        assert!(
            (s.per_mm() - want).abs() < want * 0.003,
            "{what}: T{} layer {} {} by {} puts down {:.5} E per mm, not {want:.5}",
            s.tool,
            s.layer,
            s.w,
            s.h,
            s.per_mm()
        );
    }
}

/// Later-layer tower moves stated `w` by `h`.
fn later(segs: &[Seg], w: f64, h: f64) -> Vec<&Seg> {
    segs.iter()
        .filter(|s| s.layer > 1 && (s.w - w).abs() < 1e-6 && (s.h - h).abs() < 1e-6)
        .collect()
}

#[test]
fn a_bambu_lab_tower_ignores_the_filament_flow_ratios() {
    let gcode = slice(a1(&[("filament_flow_ratio", json!([0.9, 1.05]))]), BAMBU_BED);
    let t = tower(&gcode);
    all_at(&later(&t, 0.5, 0.2), plain(0.5, 0.2), &[0, 1], "A1 mix");
}

#[test]
fn a_p1s_tower_ignores_a_flow_ratio_above_one() {
    let gcode = slice(p1s(&[("filament_flow_ratio", json!([1.05, 1.05]))]), BAMBU_BED);
    let t = tower(&gcode);
    all_at(&later(&t, 0.5, 0.2), plain(0.5, 0.2), &[0, 1], "P1S r1.05");
}

#[test]
fn a_bambu_lab_tower_ignores_the_print_flow_ratio() {
    let gcode = slice(
        a1(&[
            ("filament_flow_ratio", json!([0.9, 1.05])),
            ("print_flow_ratio", json!("0.95")),
        ]),
        BAMBU_BED,
    );
    let t = tower(&gcode);
    all_at(&later(&t, 0.5, 0.2), plain(0.5, 0.2), &[0, 1], "A1 pfmix");
}

#[test]
fn a_bambu_lab_tower_prints_the_plain_bead_at_a_taller_layer() {
    let gcode = slice(
        a1(&[
            ("filament_flow_ratio", json!([0.9, 1.05])),
            ("layer_height", json!(0.28)),
        ]),
        BAMBU_BED,
    );
    let t = tower(&gcode);
    let moves = later(&t, 0.5, 0.28);
    all_at(&moves, plain(0.5, 0.28), &[0], "A1 lh28");
    assert!((plain(0.5, 0.28) - 0.05121).abs() < 1e-4);
}

/// The tower's lines without comments: every move, feed and E of it. Progress lines (`M73`) are left out: they
/// follow the print time, which the objects' flow ratios change.
fn tower_lines(gcode: &str) -> Vec<String> {
    let mut on = false;
    let mut out = Vec::new();
    for line in gcode.lines() {
        if let Some(name) = line
            .trim()
            .strip_prefix("; FEATURE:")
            .or_else(|| line.trim().strip_prefix(";TYPE:"))
        {
            on = matches!(name.trim(), "Prime tower" | "Wipe tower");
            continue;
        }
        let body = line.split(';').next().unwrap_or("").trim();
        if on && !body.is_empty() && !body.starts_with("M73") {
            out.push(body.to_string());
        }
    }
    out
}

/// Tower filament by tool, mm3.
fn tower_volume(gcode: &str) -> [f64; 2] {
    let mut v = [0.0; 2];
    for s in segs(gcode).iter().filter(|s| s.tower()) {
        v[usize::from(s.tool.min(1))] += s.e * FIL;
    }
    v
}

#[test]
fn a_tower_puts_down_the_same_volume_and_lines_whatever_the_flow_ratios() {
    let mix = slice(a1(&[("filament_flow_ratio", json!([0.9, 1.05]))]), BAMBU_BED);
    let one = slice(a1(&[("filament_flow_ratio", json!([1.0, 1.0]))]), BAMBU_BED);
    let (a, b) = (tower_volume(&mix), tower_volume(&one));
    for t in 0..2 {
        assert!(b[t] > 50.0, "T{t} tower {:.1} mm3", b[t]);
        assert!(
            (a[t] - b[t]).abs() < 0.1,
            "T{t} tower {:.1} mm3 at flow 0.9 and 1.05, {:.1} at flow 1",
            a[t],
            b[t]
        );
    }
    let (lm, lo) = (tower_lines(&mix), tower_lines(&one));
    assert_eq!(lm.len(), lo.len());
    for (k, (m, o)) in lm.iter().zip(&lo).enumerate() {
        assert_eq!(m, o, "tower line {k}");
    }
}

#[test]
fn a_type_2_tower_wall_ignores_the_filament_flow_ratios() {
    let gcode = slice(mmu(&[("filament_flow_ratio", json!(["0.9", "1.05"]))]), MMU_BED);
    let t = tower(&gcode);
    all_at(&later(&t, 0.5, 0.2), plain(0.5, 0.2), &[0, 1], "MMU mix");
}

/// The gaps between neighboring rows: tower moves along X of 10 mm or more on one layer and tool, by Y.
fn row_gaps(rows: &[&Seg]) -> Vec<f64> {
    let mut gaps = Vec::new();
    let mut keys: Vec<(usize, u8)> = rows.iter().map(|s| (s.layer, s.tool)).collect();
    keys.sort_unstable();
    keys.dedup();
    for (layer, tool) in keys {
        let mut ys: Vec<f64> = rows
            .iter()
            .filter(|s| s.layer == layer && s.tool == tool)
            .map(|s| s.from[1])
            .collect();
        ys.sort_by(f64::total_cmp);
        ys.dedup_by(|a, b| (*a - *b).abs() < 1e-3);
        gaps.extend(ys.windows(2).map(|w| w[1] - w[0]));
    }
    gaps
}

/// Later-layer purge rows of a type 2 tower that is not turned: moves along X of 10 mm or more, inside the wall
/// (the front and back of the layer's tower are the wall's).
fn rows(t: &[Seg]) -> Vec<&Seg> {
    let edge = |layer: usize| {
        t.iter()
            .filter(|s| s.layer == layer)
            .flat_map(|s| [s.from[1], s.to[1]])
            .fold((f64::MAX, f64::MIN), |(lo, hi), y| (lo.min(y), hi.max(y)))
    };
    t.iter()
        .filter(|s| {
            let (lo, hi) = edge(s.layer);
            s.layer > 1
                && s.len >= 10.0
                && (s.from[1] - s.to[1]).abs() < 1e-3
                && (s.h - 0.2).abs() < 1e-6
                && s.from[1] > lo + 0.1
                && s.from[1] < hi - 0.1
        })
        .collect()
}

#[test]
fn type_2_purge_rows_are_the_wall_bead_laid_side_by_side() {
    let gcode = slice(mmu(&[("filament_flow_ratio", json!(["0.9", "1.05"]))]), MMU_BED);
    let t = tower(&gcode);
    let rows = rows(&t);
    assert!(rows.len() > 20, "{} rows", rows.len());
    for s in &rows {
        assert!((s.w - 0.5).abs() < 1e-6, "row stated {} wide", s.w);
    }
    all_at(&rows, plain(0.5, 0.2), &[0, 1], "MMU mix rows");
    let gaps = row_gaps(&rows);
    assert!(!gaps.is_empty());
    for g in gaps {
        assert!((g - 0.5).abs() < 0.01 || g > 0.99, "rows {g} apart");
    }
}

#[test]
fn type_2_purge_rows_with_extra_flow_put_down_that_much_more_of_the_wall_bead() {
    let gcode = slice(
        mmu(&[
            ("filament_flow_ratio", json!(["0.9", "1.05"])),
            ("wipe_tower_extra_flow", json!("120%")),
        ]),
        MMU_BED,
    );
    let t = tower(&gcode);
    let rows = rows(&t);
    assert!(rows.len() > 20, "{} rows", rows.len());
    for s in &rows {
        assert!((s.w - 0.6).abs() < 1e-6, "row stated {} wide", s.w);
    }
    all_at(&rows, 1.2 * plain(0.5, 0.2), &[0, 1], "MMU xf rows");
    assert!((1.2 * plain(0.5, 0.2) - 0.04561).abs() < 1e-4);
    let gaps = row_gaps(&rows);
    assert!(!gaps.is_empty());
    for g in gaps {
        assert!((g - 0.6).abs() < 0.01 || g > 1.19, "rows {g} apart");
    }
}

#[test]
fn the_first_layer_flow_ratio_does_not_reach_a_type_2_tower() {
    let gcode = slice(
        mmu(&[
            ("filament_flow_ratio", json!(["0.9", "1.05"])),
            ("set_other_flow_ratios", json!("1")),
            ("first_layer_flow_ratio", json!("0.9")),
            ("outer_wall_flow_ratio", json!("0.95")),
            ("inner_wall_flow_ratio", json!("1.1")),
            ("sparse_infill_flow_ratio", json!("0.8")),
        ]),
        MMU_BED,
    );
    let t = tower(&gcode);
    let first: Vec<&Seg> = t
        .iter()
        .filter(|s| s.layer == 1 && s.tool == 1 && (s.w - 0.5).abs() < 1e-6)
        .collect();
    all_at(&first, plain(0.5, 0.2), &[1], "MMU so, T1 first layer");
}

#[test]
fn the_objects_keep_their_flow_ratios_next_to_a_plain_tower() {
    let gcode = slice(a1(&[("filament_flow_ratio", json!([0.9, 1.05]))]), BAMBU_BED);
    let all = segs(&gcode);
    for feature in ["Outer wall", "Inner wall", "Sparse infill"] {
        for (tool, want) in [(0u8, 0.9), (1, 1.05)] {
            let mut ks: Vec<f64> = all
                .iter()
                .filter(|s| {
                    s.layer > 1 && s.len >= 1.0 && s.tool == tool && s.feature == feature && s.w > 0.0
                })
                .map(Seg::k)
                .collect();
            assert!(!ks.is_empty(), "no {feature} on T{tool}");
            ks.sort_by(f64::total_cmp);
            let median = ks[ks.len() / 2];
            assert!(
                (median - want).abs() < want * 0.003,
                "{feature} on T{tool} at k {median:.4}, not {want}"
            );
        }
    }
}
