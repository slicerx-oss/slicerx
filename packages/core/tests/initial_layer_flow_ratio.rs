// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `initial_layer_flow_ratio` on a Bambu Lab printer (an A1 and a P1S): one more factor in the E of every first-layer
//! extrusion (a raft's first layer when there is a raft), brim, skirt, support and ironing included, except the top
//! surface. Layers 2 and up never take it. Paths, stated widths and feeds stay as they are, unless the volumetric
//! speed limit binds: then the limit holds on the scaled flow. `first_layer_flow_ratio` does nothing on these
//! printers.
//!
//! The prime tower: on the first layer, the part the first filament prints before the tool change keeps its E; the
//! part the next filament prints after it takes the ratio on its E and on its stated width. The purge with no XY
//! travel keeps its E, and the tower keeps ignoring the filament and print flow ratios.
//!
//! Each test compares two slices that differ in one setting: per layer (the first, or any above it), feature and
//! filament, the ratio of E per mm.
#![allow(
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    reason = "a G-code reader for the test: positions, widths and feeds in mm"
)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

/// The 1.75 mm filament's cross-section, mm2.
const FIL: f64 = std::f64::consts::PI * 0.875 * 0.875;

/// Cross-section of a bead `w` wide and `h` tall with rounded edges, mm2.
fn bead(w: f64, h: f64) -> f64 {
    h * (w - h * (1.0 - std::f64::consts::FRAC_PI_4))
}

fn fixture(name: &str) -> Value {
    let path = format!("{}/cli/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let req: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    req["config"].clone()
}

/// The printers: the stock P1S request's settings and the stock two-color A1 request's.
#[derive(Clone, Copy, Debug)]
enum Printer {
    P1s,
    A1,
}

impl Printer {
    fn config(self) -> Value {
        fixture(match self {
            Self::P1s => "xmark-p1s-request.json",
            Self::A1 => "xmark-2color-a1-request.json",
        })
    }
}

fn set(cfg: &mut Value, extra: &[(&str, Value)]) {
    for (k, v) in extra {
        cfg[*k] = v.clone();
    }
}

/// Triangles of a prism: the convex polygon `poly` (counterclockwise) from `z0` up to `z1`.
fn prism(poly: &[[f64; 2]], z0: f64, z1: f64) -> Vec<[[f64; 3]; 3]> {
    let mut t = Vec::new();
    let at = |p: [f64; 2], z: f64| [p[0], p[1], z];
    for k in 1..poly.len() - 1 {
        t.push([at(poly[0], z1), at(poly[k], z1), at(poly[k + 1], z1)]);
        t.push([at(poly[0], z0), at(poly[k + 1], z0), at(poly[k], z0)]);
    }
    for k in 0..poly.len() {
        let (a, b) = (poly[k], poly[(k + 1) % poly.len()]);
        t.push([at(a, z0), at(b, z0), at(b, z1)]);
        t.push([at(a, z0), at(b, z1), at(a, z1)]);
    }
    t
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<[f64; 2]> {
    vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

fn stl(triangles: &[[[f64; 3]; 3]]) -> Vec<u8> {
    use std::fmt::Write as _;
    let mut text = String::from("solid part\n");
    for tri in triangles {
        text.push_str(" facet normal 0 0 0\n  outer loop\n");
        for [x, y, z] in tri {
            let _ = writeln!(text, "   vertex {x} {y} {z}");
        }
        text.push_str("  endloop\n endfacet\n");
    }
    text.push_str("endsolid part\n");
    text.into_bytes()
}

/// One object of four islands around the plate center: a 20 x 20 x 5 mm box, a 30 mm wedge 0 to 2.5 mm wide and
/// 3 mm tall, a T section 16 mm long (a 4 mm stem 6 mm tall under a 16 mm cap 2 mm thick, which needs support) and a
/// 15 x 15 x 0.2 mm pad.
fn composite() -> Vec<u8> {
    let mut t = prism(&rect(106.0, 106.0, 126.0, 126.0), 0.0, 5.0);
    t.extend(prism(&[[130.0, 106.0], [160.0, 106.0], [160.0, 108.5]], 0.0, 3.0));
    t.extend(prism(&rect(114.0, 132.0, 118.0, 148.0), 0.0, 6.0));
    t.extend(prism(&rect(108.0, 132.0, 124.0, 148.0), 6.0, 8.0));
    t.extend(prism(&rect(132.0, 132.0, 147.0, 147.0), 0.0, 0.2));
    stl(&t)
}

/// The composite's settings on `printer`: 2 skirt loops, a 3 mm outer brim, normal support, ironing on top
/// surfaces, no arcs, no prime tower, 0.2 mm layers; then `extra`.
fn comp_config(printer: Printer, extra: &[(&str, Value)]) -> Value {
    let mut cfg = printer.config();
    set(
        &mut cfg,
        &[
            ("enable_prime_tower", json!(false)),
            ("skirt_loops", json!(2)),
            ("skirt_distance", json!(3)),
            ("brim_type", json!("outer_only")),
            ("brim_width", json!(3)),
            ("enable_support", json!(true)),
            ("support_type", json!("normal(auto)")),
            ("support_threshold_angle", json!(30)),
            ("ironing_type", json!("top")),
            ("enable_arc_fitting", json!(false)),
            ("use_relative_e_distances", json!(true)),
            ("wall_generator", json!("classic")),
            ("smart_layer", json!("off")),
            ("layer_height", json!(0.2)),
            ("initial_layer_print_height", json!(0.2)),
            ("bottom_shell_layers", json!(3)),
            ("top_shell_layers", json!(5)),
        ],
    );
    set(&mut cfg, extra);
    cfg
}

fn comp(printer: Printer, extra: &[(&str, Value)]) -> String {
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": 256, "depthMm": 256, "heightMm": 250},
                  "objects": [{"id": "o1", "name": "composite", "mesh": "composite",
                               "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}]},
        "config": comp_config(printer, extra),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let mesh = Arc::new(Mesh::load(&composite(), "composite.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8_lossy(&run.gcode).into_owned()
}

/// An ASCII STL of a box from the origin to `size`.
fn box_stl(size: [f64; 3]) -> Vec<u8> {
    stl(&prism(&rect(0.0, 0.0, size[0], size[1]), 0.0, size[2]))
}

/// Two 15 mm boxes 30 mm apart, A 8 mm tall on filament 1 and B 3 mm on filament 2 (filament flow ratios 0.9 and
/// 1.05), with the prime tower on and every purge on it; then `extra`.
fn two_color(printer: Printer, extra: &[(&str, Value)]) -> String {
    let mut cfg = printer.config();
    let filaments = cfg["filament_flow_ratio"].as_array().map_or(1, Vec::len);
    for v in cfg.as_object_mut().unwrap().values_mut() {
        if let Some(a) = v.as_array_mut()
            && a.len() == filaments
            && filaments > 2
        {
            a.truncate(2);
        }
    }
    set(
        &mut cfg,
        &[
            ("filament_colour", json!(["#F4EE2A", "#00AE42"])),
            ("filament_flow_ratio", json!(["0.9", "1.05"])),
            ("enable_prime_tower", json!(true)),
            ("smart_layer", json!("off")),
            ("flush_into_infill", json!(false)),
            ("flush_into_support", json!(false)),
            ("flush_into_objects", json!(false)),
            ("use_relative_e_distances", json!(true)),
            ("enable_arc_fitting", json!(false)),
        ],
    );
    set(&mut cfg, extra);
    let objects: Vec<Value> = [(8.0, 113.0, 1), (3.0, 143.0, 2)]
        .iter()
        .enumerate()
        .map(|(k, &(h, x, slot))| {
            json!({"id": format!("o{k}"), "name": format!("box {k}"), "mesh": format!("15 15 {h}"),
                   "slotOverrides": {"box": slot, "box.stl": slot, "": slot},
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x - 7.5, 120.5, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": 256, "depthMm": 256, "heightMm": 220}, "objects": objects},
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

/// One extruding move with XY travel.
#[derive(Debug, Clone)]
struct Mv {
    /// 1 for the first layer.
    layer: usize,
    tool: u8,
    feature: String,
    /// The stated width.
    w: f64,
    feed: f64,
    to: [f64; 2],
    len: f64,
    e: f64,
}

/// The extruding moves of a G-code written with relative E, and the E of moves with no XY travel by layer and
/// tool (retractions, primes and purges).
fn moves(gcode: &str) -> (Vec<Mv>, BTreeMap<(usize, u8), f64>) {
    assert!(gcode.lines().any(|l| l.starts_with("M83")), "relative E");
    let (mut out, mut still) = (Vec::new(), BTreeMap::new());
    let (mut layer, mut tool, mut at, mut feed) = (0usize, 0u8, [f64::NAN; 2], 0.0);
    let (mut feature, mut w) = (String::new(), 0.0);
    for line in gcode.lines() {
        let s = line.trim();
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
        let body = s.split(';').next().unwrap_or("").trim();
        if let Some(t) = body.strip_prefix('T')
            && let Ok(t) = t.parse::<u16>()
        {
            if t < 255 {
                tool = u8::try_from(t).unwrap();
            }
            continue;
        }
        if !(body.starts_with("G1 ") || body.starts_with("G0 ")) {
            continue;
        }
        let (mut to, mut e) = (at, 0.0);
        for word in body.split_whitespace().skip(1) {
            let value: f64 = word.get(1..).and_then(|v| v.parse().ok()).unwrap_or(f64::NAN);
            match word.as_bytes().first() {
                Some(b'X') => to[0] = value,
                Some(b'Y') => to[1] = value,
                Some(b'E') => e = value,
                Some(b'F') => feed = value,
                _ => {}
            }
        }
        let (dx, dy) = (to[0] - at[0], to[1] - at[1]);
        let len = (dx * dx + dy * dy).sqrt();
        if e > 0.0 && len > 0.0 {
            out.push(Mv {
                layer,
                tool,
                feature: feature.clone(),
                w,
                feed,
                to,
                len,
                e,
            });
        } else if e != 0.0 && (len.is_nan() || len == 0.0) {
            *still.entry((layer, tool)).or_insert(0.0) += e;
        }
        at = to;
    }
    (out, still)
}

/// Two slices of the same plate: the baseline and the case.
struct Pair {
    base: Vec<Mv>,
    case: Vec<Mv>,
    base_still: BTreeMap<(usize, u8), f64>,
    case_still: BTreeMap<(usize, u8), f64>,
}

/// A group of moves: the first layer or not, the feature, the tool.
type Group = (bool, String, u8);

impl Pair {
    /// The two slices, which must make the same moves in XY.
    fn of(base: &str, case: &str, what: &str) -> Self {
        let ((base, base_still), (case, case_still)) = (moves(base), moves(case));
        assert_eq!(base.len(), case.len(), "{what}: move count");
        for (k, (a, b)) in base.iter().zip(&case).enumerate() {
            assert!(
                a.layer == b.layer && a.feature == b.feature && a.tool == b.tool && a.to == b.to,
                "{what}: move {k} {a:?} against {b:?}"
            );
        }
        Self {
            base,
            case,
            base_still,
            case_still,
        }
    }

    /// E per mm of the case over the baseline's, by group. The start sequence (before the first layer) is left out.
    fn ratios(&self) -> BTreeMap<Group, f64> {
        let mut sums: BTreeMap<Group, [f64; 4]> = BTreeMap::new();
        for (a, b) in self.base.iter().zip(&self.case).filter(|(a, _)| a.layer > 0) {
            let s = sums
                .entry((a.layer == 1, a.feature.clone(), a.tool))
                .or_insert([0.0; 4]);
            s[0] += a.e;
            s[1] += a.len;
            s[2] += b.e;
            s[3] += b.len;
        }
        sums.into_iter()
            .map(|(g, s)| (g, (s[2] / s[3]) / (s[0] / s[1])))
            .collect()
    }

    /// Every group at the ratio `want` gives it (within 0.001, 0.002 for ironing, which has many short moves), each
    /// feature of `need` present on the first layer, and the start sequence's moves unchanged.
    fn expect(&self, what: &str, need: &[&str], want: impl Fn(&Group) -> f64) {
        for (a, b) in self.base.iter().zip(&self.case).filter(|(a, _)| a.layer == 0) {
            assert_eq!(a.e, b.e, "{what}: the start sequence {a:?} against {b:?}");
        }
        let ratios = self.ratios();
        for f in need {
            assert!(
                ratios.keys().any(|(first, g, _)| *first && g == f),
                "{what}: no {f} on the first layer in {:?}",
                ratios.keys().collect::<Vec<_>>()
            );
        }
        for (g, r) in &ratios {
            let tol = if g.1 == "Ironing" { 0.002 } else { 0.001 };
            let w = want(g);
            assert!(
                (r - w).abs() < tol,
                "{what}: {} on T{} {} at {r:.4}, not {w:.4}",
                g.1,
                g.2,
                if g.0 { "on the first layer" } else { "above it" },
            );
        }
    }

    /// The stated widths and feeds of every move are the same.
    fn same_widths_and_feeds(&self, what: &str) {
        for (a, b) in self.base.iter().zip(&self.case) {
            assert!(a.w == b.w && a.feed == b.feed, "{what}: {a:?} against {b:?}");
        }
    }

    /// The E of the moves with no XY travel is the same on every layer and tool.
    fn same_still_e(&self, what: &str) {
        assert_eq!(
            self.base_still.keys().collect::<Vec<_>>(),
            self.case_still.keys().collect::<Vec<_>>(),
            "{what}"
        );
        for (k, a) in &self.base_still {
            let b = self.case_still[k];
            assert!(
                (a - b).abs() < 1e-4,
                "{what}: layer {} T{} E {a} against {b}",
                k.0,
                k.1
            );
        }
    }
}

/// `k` on the first layer except the top surface, 1 everywhere else.
fn first_layer(k: f64) -> impl Fn(&Group) -> f64 {
    move |g: &Group| if g.0 && g.1 != "Top surface" { k } else { 1.0 }
}

const RULE_ONE: [&str; 7] = [
    "Outer wall",
    "Inner wall",
    "Bottom surface",
    "Brim",
    "Skirt",
    "Support",
    "Ironing",
];

#[test]
fn every_first_layer_feature_takes_the_ratio_on_both_printers() {
    for printer in [Printer::P1s, Printer::A1] {
        let base = comp(printer, &[]);
        let case = comp(printer, &[("initial_layer_flow_ratio", json!("0.9"))]);
        let what = format!("{printer:?} il090");
        let pair = Pair::of(&base, &case, &what);
        pair.expect(&what, &RULE_ONE, first_layer(0.9));
        pair.same_widths_and_feeds(&what);
        pair.same_still_e(&what);
    }
}

#[test]
fn the_ratio_is_linear() {
    for printer in [Printer::P1s, Printer::A1] {
        let base = comp(printer, &[]);
        for k in [0.8, 1.1, 1.2] {
            let case = comp(printer, &[("initial_layer_flow_ratio", json!(k.to_string()))]);
            let what = format!("{printer:?} il{k}");
            let pair = Pair::of(&base, &case, &what);
            pair.expect(&what, &RULE_ONE, first_layer(k));
            pair.same_widths_and_feeds(&what);
        }
    }
}

#[test]
fn it_multiplies_the_filament_flow_ratio() {
    let base = comp(Printer::P1s, &[("filament_flow_ratio", json!(["0.98"]))]);
    let case = comp(
        Printer::P1s,
        &[
            ("filament_flow_ratio", json!(["0.9"])),
            ("initial_layer_flow_ratio", json!("0.9")),
        ],
    );
    let pair = Pair::of(&base, &case, "ffr090 il090");
    let flow = 0.9 / 0.98;
    pair.expect("ffr090 il090", &RULE_ONE, |g| {
        if g.0 && g.1 != "Top surface" {
            flow * 0.9
        } else {
            flow
        }
    });
    assert!((flow * 0.9 - 0.8265).abs() < 1e-4);
}

#[test]
fn it_multiplies_the_print_flow_ratio() {
    let base = comp(Printer::P1s, &[]);
    let case = comp(
        Printer::P1s,
        &[
            ("print_flow_ratio", json!("0.9")),
            ("initial_layer_flow_ratio", json!("0.9")),
        ],
    );
    let pair = Pair::of(&base, &case, "pfr090 il090");
    pair.expect("pfr090 il090", &RULE_ONE, |g| {
        if g.0 && g.1 != "Top surface" { 0.81 } else { 0.9 }
    });
}

#[test]
fn a_first_layer_top_surface_keeps_its_own_ratio() {
    let extra = [
        ("bottom_shell_layers", json!(0)),
        ("top_solid_infill_flow_ratio", json!("0.8")),
    ];
    let base = comp(Printer::P1s, &extra);
    let mut with = extra.to_vec();
    with.push(("initial_layer_flow_ratio", json!("0.9")));
    let case = comp(Printer::P1s, &with);
    let pair = Pair::of(&base, &case, "bot0 tsr080 il090");
    pair.expect(
        "bot0 tsr080 il090",
        &[
            "Top surface",
            "Sparse infill",
            "Outer wall",
            "Inner wall",
            "Brim",
            "Skirt",
            "Support",
            "Ironing",
        ],
        first_layer(0.9),
    );
    pair.same_widths_and_feeds("bot0 tsr080 il090");
}

#[test]
fn solid_ironing_on_the_first_layer_takes_the_ratio() {
    let base = comp(Printer::P1s, &[("ironing_type", json!("solid"))]);
    let case = comp(
        Printer::P1s,
        &[
            ("ironing_type", json!("solid")),
            ("initial_layer_flow_ratio", json!("0.9")),
        ],
    );
    let pair = Pair::of(&base, &case, "ironsolid il090");
    pair.expect("ironsolid il090", &RULE_ONE, first_layer(0.9));
}

#[test]
fn on_a_raft_the_raft_first_layer_takes_the_ratio() {
    let base = comp(Printer::P1s, &[("raft_layers", json!(2))]);
    let case = comp(
        Printer::P1s,
        &[
            ("raft_layers", json!(2)),
            ("initial_layer_flow_ratio", json!("0.9")),
        ],
    );
    let pair = Pair::of(&base, &case, "raft2 il090");
    pair.expect("raft2 il090", &["Support", "Skirt"], first_layer(0.9));
    let ratios = pair.ratios();
    assert!(
        ratios
            .keys()
            .filter(|g| g.0)
            .all(|g| matches!(g.1.as_str(), "Support" | "Skirt" | "Brim")),
        "raft2: the first layer is the raft's own: {:?}",
        ratios.keys().collect::<Vec<_>>()
    );
    pair.same_widths_and_feeds("raft2 il090");
}

#[test]
fn a_taller_first_layer_takes_the_same_ratio() {
    let extra = [("initial_layer_print_height", json!(0.3))];
    let base = comp(Printer::P1s, &extra);
    let case = comp(
        Printer::P1s,
        &[extra[0].clone(), ("initial_layer_flow_ratio", json!("0.9"))],
    );
    let pair = Pair::of(&base, &case, "h03 il090");
    pair.expect("h03 il090", &RULE_ONE, first_layer(0.9));
}

#[test]
fn bridge_flow_does_not_change_the_first_layer_ratio() {
    let extra = [("bridge_flow", json!("0.8"))];
    let base = comp(Printer::P1s, &extra);
    let case = comp(
        Printer::P1s,
        &[extra[0].clone(), ("initial_layer_flow_ratio", json!("0.9"))],
    );
    let pair = Pair::of(&base, &case, "bf080 il090");
    assert!(pair.ratios().keys().any(|g| !g.0 && g.1 == "Bridge"));
    pair.expect("bf080 il090", &RULE_ONE, first_layer(0.9));
}

#[test]
fn a_capped_first_layer_feed_holds_the_limit_on_the_scaled_flow() {
    let extra = [
        ("initial_layer_speed", json!(["300"])),
        ("initial_layer_infill_speed", json!(["300"])),
        ("filament_max_volumetric_speed", json!(["21"])),
    ];
    // 21 mm3/s over the 0.5 by 0.2 mm first-layer bead, mm/min.
    let cap = 21.0 / bead(0.5, 0.2) * 60.0;
    assert!((cap - 13783.0).abs() < 1.0);
    let base = comp(Printer::P1s, &extra);
    for k in [0.8, 1.2] {
        let mut with = extra.to_vec();
        with.push(("initial_layer_flow_ratio", json!(k.to_string())));
        let case = comp(Printer::P1s, &with);
        let what = format!("fast1 il{k}");
        let pair = Pair::of(&base, &case, &what);
        pair.expect(
            &what,
            &["Outer wall", "Inner wall", "Bottom surface", "Brim"],
            first_layer(k),
        );
        let mut capped = std::collections::BTreeSet::new();
        for (a, b) in pair.base.iter().zip(&pair.case) {
            assert_eq!(a.w, b.w, "{what}: {a:?} against {b:?}");
            if a.layer > 1 {
                assert_eq!(a.feed, b.feed, "{what}: {a:?} against {b:?}");
            } else if (a.feed - cap.round()).abs() < 0.5 {
                assert!(
                    (b.feed - cap / k).abs() < 1.5,
                    "{what}: a feed at the limit {} goes to {}, not {:.0}",
                    a.feed,
                    b.feed,
                    cap / k
                );
                capped.insert(a.feature.clone());
            }
        }
        for f in ["Outer wall", "Inner wall", "Bottom surface", "Brim"] {
            assert!(capped.contains(f), "{what}: no {f} at the limit in {capped:?}");
        }
    }
}

#[test]
fn first_layer_flow_ratio_does_nothing_on_a_bambu_lab_printer() {
    let base = comp(Printer::P1s, &[]);
    let case = comp(
        Printer::P1s,
        &[
            ("first_layer_flow_ratio", json!("0.9")),
            ("set_other_flow_ratios", json!("1")),
        ],
    );
    let pair = Pair::of(&base, &case, "fl090");
    pair.expect("fl090", &RULE_ONE, |_| 1.0);
    pair.same_widths_and_feeds("fl090");
}

/// The first layer's tower moves of the filament that prints its part first, and of the others.
fn tower_parts(moves: &[Mv]) -> (u8, Vec<&Mv>) {
    let tower: Vec<&Mv> = moves
        .iter()
        .filter(|m| m.layer == 1 && m.feature == "Prime tower")
        .collect();
    let first = tower.first().expect("a first-layer tower").tool;
    (first, tower.into_iter().filter(|m| m.tool != first).collect())
}

/// Two colors on `printer` with `extra`, `initial_layer_flow_ratio` 1 against `k`: the objects of both filaments
/// take `k` on the first layer, the tower part of the first filament keeps its E, the next filament's part takes `k`
/// on E and stated width, and the purges with no XY travel keep theirs.
fn tower_case(printer: Printer, extra: &[(&str, Value)], k: f64) {
    let what = format!("{printer:?} 2c il{k} {extra:?}");
    let mut with = extra.to_vec();
    with.push(("initial_layer_flow_ratio", json!("1")));
    let base = two_color(printer, &with);
    with.pop();
    with.push(("initial_layer_flow_ratio", json!(k.to_string())));
    let case = two_color(printer, &with);
    let pair = Pair::of(&base, &case, &what);
    let (first, later) = tower_parts(&pair.case);
    assert!(later.len() > 10, "{what}: {} later tower moves", later.len());
    pair.expect(
        &what,
        &["Outer wall", "Inner wall", "Bottom surface", "Prime tower"],
        |g| {
            if !g.0 || g.1 == "Top surface" || (g.1 == "Prime tower" && g.2 == first) {
                1.0
            } else {
                k
            }
        },
    );
    for tool in [0, 1] {
        assert!(
            pair.ratios()
                .keys()
                .any(|g| g.0 && g.1 == "Outer wall" && g.2 == tool),
            "{what}: no first-layer wall on T{tool}"
        );
    }
    let plain = bead(0.5, 0.2) / FIL;
    for m in &later {
        assert!(
            (m.w - 0.5 * k).abs() < 1e-6,
            "{what}: a later tower move stated {} wide: {m:?}",
            m.w
        );
        if m.len >= 1.0 {
            assert!(
                (m.e / m.len - k * plain).abs() < 1e-4,
                "{what}: a later tower move puts down {:.5} E per mm, not {:.5}",
                m.e / m.len,
                k * plain
            );
        }
    }
    for (a, b) in pair.base.iter().zip(&pair.case) {
        let scaled_tower = b.layer == 1 && b.feature == "Prime tower" && b.tool != first;
        if !scaled_tower {
            assert_eq!(a.w, b.w, "{what}: {a:?} against {b:?}");
        }
        assert_eq!(a.feed, b.feed, "{what}: {a:?} against {b:?}");
    }
    pair.same_still_e(&what);
}

#[test]
fn the_tower_part_after_the_tool_change_takes_the_ratio() {
    for printer in [Printer::A1, Printer::P1s] {
        tower_case(printer, &[], 0.9);
    }
    assert!((0.9 * bead(0.5, 0.2) / FIL - 0.03421).abs() < 1e-5);
}

#[test]
fn the_tower_part_after_the_tool_change_is_linear() {
    for k in [0.8, 1.1, 1.2] {
        tower_case(Printer::A1, &[], k);
    }
}

#[test]
fn the_tower_ignores_the_filament_flow_ratios() {
    let base = two_color(Printer::A1, &[("initial_layer_flow_ratio", json!("1"))]);
    let case = two_color(
        Printer::A1,
        &[
            ("initial_layer_flow_ratio", json!("1")),
            ("filament_flow_ratio", json!(["1", "1"])),
        ],
    );
    let pair = Pair::of(&base, &case, "ff100");
    pair.expect("ff100", &["Outer wall", "Prime tower"], |g| {
        match (g.1.as_str(), g.2) {
            ("Prime tower", _) => 1.0,
            (_, 0) => 1.0 / 0.9,
            _ => 1.0 / 1.05,
        }
    });
}

#[test]
fn the_print_flow_ratio_leaves_the_tower_part_alone() {
    tower_case(Printer::A1, &[("print_flow_ratio", json!("0.9"))], 0.9);
}
