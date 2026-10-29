// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Top surfaces and the first layer's bottom surface inside one fixed-width wall: where they start, how their lines
//! spread and what narrow strips print.
//!
//! Plates of 56 strips 30.9 mm long (`fixtures/one-classic-wall`: the requests, with stock profiles' settings, hand-set
//! widths and one classic wall, the meshes and each strip's center, direction, size and t), lines running along the
//! strips at 45 degrees unless named. A strip's width is W = 2 ins + t s0, so t is R/s0 below. Per strip the tests read,
//! on the top layer and the first, the surface lines (offsets from the strip's low long side, stated widths), the gap
//! fill and the walls. The slice centers the plate's box on the bed, so the strips are found where the first layer's
//! outer wall puts them.
//!
//! The rule, with h the layer height, s(w) = w - h (1 - pi/4), ow and sw the outer wall and internal solid infill
//! widths, ov `top_bottom_infill_wall_overlap` and s0 the surface's own spacing:
//!
//! - The surface starts at ins = ow/2 + s(ow)/2 - ov (s(ow) + s(sw))/2 from the outline: the rule of two or more walls
//!   with the outer wall innermost. The precise outer wall and the inner wall's width do not move it.
//! - Each piece spreads N = floor(R/s0) lines over R = W - 2 ins, min(R/N, 1.2 s0) apart, the first half that in from
//!   ins, each as wide as its spacing plus h (1 - pi/4).
//! - With sparse infill a strip prints walls only, then gap fill, then lines once it is
//!   ow + 2 p1 + 0.6 s(iw) wide, p1 being where a first inner wall would sit.
//! - At sparse infill density 0 a strip prints a line once R >= s0; a narrower one keeps a gap fill bead.
//! - The topmost layer under `only_one_wall_top` prints as a plate of one wall.
//! - Bambu Lab printers keep their own rules.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::disallowed_methods,
    clippy::float_cmp,
    reason = "a G-code reader for the test: positions, angles and lengths in mm"
)]

mod bambu_strips;

use bambu_strips::{Layer, Move, Row, Strip, moves, near, row};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/one-classic-wall")
        .join(name)
}

/// The G-code of the plate `case`: a request sliced in the library, or a project (`.3mf`) with `sx slice` and the
/// wall generator `walls`.
fn slice(case: &str, walls: &str) -> String {
    if case.starts_with("a1--") {
        let config =
            PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("one-classic-wall-{walls}.json"));
        std::fs::write(&config, format!("{{\"wall_generator\":\"{walls}\"}}")).unwrap();
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_sx"))
            .arg("slice")
            .arg(fixture(&format!("{case}.3mf")))
            .arg("--config")
            .arg(&config)
            .args(["--plate", "1", "-o", "-"])
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        return String::from_utf8(out.stdout).unwrap();
    }
    let req: Value =
        serde_json::from_slice(&std::fs::read(fixture(&format!("requests/{case}.json"))).unwrap()).unwrap();
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let bytes = std::fs::read(fixture(&format!("{case}.stl"))).unwrap();
    let mesh = Arc::new(Mesh::load(&bytes, "strips.stl").unwrap());
    let run = api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
    String::from_utf8(run.gcode).unwrap()
}

/// A plate's strips with each one's t (R/s0 by the rule).
fn strips(case: &str) -> Vec<(f64, Strip)> {
    let v: Value =
        serde_json::from_slice(&std::fs::read(fixture(&format!("{case}.strips.json"))).unwrap()).unwrap();
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let f = |k: &str| s[k].as_f64().unwrap();
            (
                f("t"),
                Strip {
                    cx: f("cx"),
                    cy: f("cy"),
                    ang: f("ang"),
                    w: f("W"),
                    l: f("L"),
                },
            )
        })
        .collect()
}

/// One layer of a plate: each strip's row, with its t and length.
struct Rows(Vec<(f64, f64, Row)>);

impl Rows {
    fn t(&self, t: f64) -> &Row {
        self.0
            .iter()
            .find(|r| (r.0 - t).abs() < 1e-6)
            .map_or_else(|| panic!("no strip T{t}"), |r| &r.2)
    }

    fn layer(&self) -> Layer {
        let mut rows: Vec<Row> = self.0.iter().map(|r| r.2.clone()).collect();
        rows.sort_by(|a, b| a.w.total_cmp(&b.w));
        Layer(rows)
    }

    /// The strips from `lo` to `hi` (t, both included).
    fn span(&self, lo: f64, hi: f64) -> impl Iterator<Item = &(f64, f64, Row)> {
        self.0
            .iter()
            .filter(move |r| r.0 >= lo - 1e-6 && r.0 <= hi + 1e-6)
    }
}

/// Per strip, what the plate `case` prints on its top layer and its first layer (a project with the aegis walls it
/// was measured with).
fn measure(case: &str) -> (Rows, Rows) {
    measure_with(case, "aegis")
}

/// Per strip, what the plate `case` prints on its top layer and its first layer, a project with the wall generator
/// `walls`.
fn measure_with(case: &str, walls: &str) -> (Rows, Rows) {
    let moves = moves(&slice(case, walls));
    let mut strips = strips(case);
    // Where the slice put the plate: the outer wall on every layer against the strips' own bounds (a strip the
    // elephant foot compensation takes off the first layer would move that layer's box).
    let corners = |s: &Strip| {
        let a = s.ang.to_radians();
        let (ux, uy) = (a.cos(), a.sin());
        [(-1.0, -1.0), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0)].map(|(i, j): (f64, f64)| {
            [
                s.cx + ux * i * s.l / 2.0 - uy * j * s.w / 2.0,
                s.cy + uy * i * s.l / 2.0 + ux * j * s.w / 2.0,
            ]
        })
    };
    let center = |pts: &mut dyn Iterator<Item = [f64; 2]>| {
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for p in pts {
            for k in 0..2 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        [f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1])]
    };
    let placed = center(
        &mut moves
            .iter()
            .filter(|m| m.feature == "Outer wall")
            .flat_map(|m| [m.a, m.b]),
    );
    let own = center(&mut strips.iter().flat_map(|s| corners(&s.1)));
    for (_, s) in &mut strips {
        s.cx += placed[0] - own[0];
        s.cy += placed[1] - own[1];
    }
    let inside = |s: &Strip, p: [f64; 2]| {
        let a = s.ang.to_radians();
        let (ux, uy) = (a.cos(), a.sin());
        let (dx, dy) = (p[0] - s.cx, p[1] - s.cy);
        (dx * ux + dy * uy).abs() <= s.l / 2.0 + 0.05 && (-dx * uy + dy * ux).abs() <= s.w / 2.0 + 0.05
    };
    let mut by: BTreeMap<(i64, usize), Vec<&Move>> = BTreeMap::new();
    for m in &moves {
        let mid = [f64::midpoint(m.a[0], m.b[0]), f64::midpoint(m.a[1], m.b[1])];
        if let Some(i) = strips.iter().position(|s| inside(&s.1, mid)) {
            by.entry((m.z, i)).or_default().push(m);
        }
    }
    let top_z = by.keys().map(|k| k.0).max().unwrap();
    let first_z = by.keys().map(|k| k.0).min().unwrap();
    let layer = |z: i64, surface: &str| {
        Rows(
            strips
                .iter()
                .enumerate()
                .map(|(i, (t, s))| {
                    let r = row(s, by.get(&(z, i)).map_or(&[][..], Vec::as_slice), surface, placed);
                    (*t, s.l, r)
                })
                .collect(),
        )
    };
    (layer(top_z, "Top surface"), layer(first_z, "Bottom surface"))
}

/// The surface line spacing of a strip with 2 lines or more.
fn spacing_of(r: &Row) -> f64 {
    let n = r.lines.len();
    assert!(n >= 2, "W {}: {} lines", r.w, n);
    (r.lines[n - 1] - r.lines[0]) / (n - 1) as f64
}

/// A strip's lines: how many, their spacing (2 or more), stated width and the low margin.
fn lines(r: &Row, n: usize, gap: Option<f64>, width: f64, m0: f64, what: &str) {
    assert_eq!(r.lines.len(), n, "{what} W {}: lines {:?}", r.w, r.lines);
    if let Some(g) = gap {
        // Each line's offset is read from coordinates rounded to a micrometer.
        let tol = if n == 2 { 0.001 } else { 0.0005 };
        near(spacing_of(r), g, tol, &format!("{what} W {} spacing", r.w));
    }
    assert!(!r.widths.is_empty(), "{what} W {}: no surface line", r.w);
    for w in &r.widths {
        near(*w, width, 0.001, &format!("{what} W {} width", r.w));
    }
    near(r.lines[0], m0, 0.002, &format!("{what} W {} m0", r.w));
}

/// No surface line and no gap fill.
fn walls_only(r: &Row, what: &str) {
    assert!(
        r.lines.is_empty() && r.gap_fill <= 0.05,
        "{what} W {}: lines {:?}, gap fill {:.3}",
        r.w,
        r.lines,
        r.gap_fill
    );
}

/// Gap fill (one bead along the strip) and no surface line.
fn gap_only(r: &Row, what: &str) {
    assert!(
        r.lines.is_empty() && r.gap_fill > 25.0,
        "{what} W {}: lines {:?}, gap fill {:.3}",
        r.w,
        r.lines,
        r.gap_fill
    );
}

/// The layer's surface starts `ins` from the outline, and every strip whose lines are spread less than 1.19 `s0`
/// apart has its two margins within 0.01 mm.
fn spread(rows: &Rows, ins: f64, s0: f64, what: &str) {
    near(rows.layer().ins(), ins, 0.0015, &format!("{what} ins"));
    for (t, _, r) in &rows.0 {
        // Strips whose R/s0 is within a hair above a whole number keep a line out (left to the near-integer rule).
        let whole = (t - t.round()).abs() < 1e-6;
        if !whole && r.lines.len() >= 2 && spacing_of(r) < 1.19 * s0 {
            let (m0, m1) = (r.lines[0], r.w - r.lines[r.lines.len() - 1]);
            assert!(
                (m0 - m1).abs() < 0.01,
                "{what} W {}: margins {m0:.4} and {m1:.4}",
                r.w
            );
        }
    }
}

const ENDER_S0: f64 = 0.3771;

/// OW-1. Ender 3 V3, 0.4 nozzle, sparse 15 %: both layers start the surface 0.3043 mm in and spread their lines.
#[test]
fn ow_1_one_wall_spreads_top_and_first_layer_lines() {
    let (top, first) = measure("creality-ender-3-v3--n4-sp15-al");
    for (rows, layer) in [(&top, "top"), (&first, "first")] {
        spread(rows, 0.3043, ENDER_S0, layer);
        lines(rows.t(2.3), 2, Some(0.4335), 0.4767, 0.5208, layer);
        lines(rows.t(3.5), 3, Some(0.4398), 0.4827, 0.5241, layer);
        lines(rows.t(4.4), 4, Some(0.4146), 0.4578, 0.5124, layer);
    }
}

/// OW-2. Sparse 0: a strip prints a line from R = s0 on and no gap fill there; a narrower strip keeps its gap fill
/// bead where the walls leave one (the 0.872 to 0.948 mm strips) and walls only below.
#[test]
fn ow_2_one_wall_with_no_sparse_infill_prints_a_line_once_it_fits() {
    let (top, first) = measure("creality-ender-3-v3--n4-sp0-al");
    for (rows, layer) in [(&top, "top"), (&first, "first")] {
        lines(rows.t(1.3), 1, None, 0.4954, 0.5305, layer);
        lines(rows.t(1.5), 1, None, 0.4954, 0.5305, layer);
        lines(rows.t(2.7), 2, Some(0.4518), 0.4954, 0.5310, layer);
        for (t, _, r) in rows.span(1.0, 6.0) {
            assert!(r.gap_fill <= 0.05, "{layer} T{t}: gap fill {:.3}", r.gap_fill);
            assert!(!r.lines.is_empty(), "{layer} T{t}: no line");
        }
        for t in [0.5, 0.6] {
            walls_only(rows.t(t), layer);
        }
        for t in [0.7, 0.8, 0.9] {
            gap_only(rows.t(t), layer);
        }
    }
}

/// OW-3. Sparse 0, fine steps round R = s0 and R = 2 s0: one line centered from 0.986 mm, two from 1.366 mm. The
/// 1.363 mm strip (R/s0 2.002) is left out: within a few thousandths above a whole number a line may drop out.
#[test]
fn ow_3_one_wall_no_sparse_switches_at_one_and_two_spacings() {
    let (top, first) = measure("creality-ender-3-v3--n4-sp0-al-f");
    for (rows, layer) in [(&top, "top"), (&first, "first")] {
        let at = |w: f64| {
            rows.0
                .iter()
                .map(|r| &r.2)
                .find(|r| (r.w - w).abs() < 0.0006)
                .unwrap_or_else(|| panic!("no strip {w}"))
        };
        gap_only(at(0.984), layer);
        for (w, width) in [(0.986, 0.4204), (0.990, 0.4244), (0.996, 0.4304)] {
            let r = at(w);
            lines(r, 1, None, width, w / 2.0, layer);
            near(
                r.lines[0],
                r.w - r.lines[0],
                0.002,
                &format!("{layer} W {w} centered"),
            );
        }
        lines(at(1.360), 1, None, 0.4954, 0.5307, layer);
        lines(at(1.366), 2, Some(0.3787), 0.4216, 0.4937, layer);
    }
}

/// OW-4. Sparse 15 %, overlap 0 and inner wall 0.35: the first surface is one line, spread to 1.2 s0.
#[test]
fn ow_4_one_wall_first_surface_of_one_line() {
    for (case, last_gap, from, to, m0) in [
        (
            "creality-ender-3-v3--n4-sp15-al-ov0-f",
            1.400,
            1.403,
            1.450,
            0.6249,
        ),
        (
            "creality-ender-3-v3--n4-sp15-al-iw0.35-f",
            1.288,
            1.290,
            1.360,
            0.5305,
        ),
    ] {
        let (top, _) = measure(case);
        let rows: Vec<&Row> = top.0.iter().map(|r| &r.2).collect();
        let at = |w: f64| *rows.iter().find(|r| (r.w - w).abs() < 0.0006).unwrap();
        gap_only(at(last_gap), case);
        let span: Vec<&&Row> = rows
            .iter()
            .filter(|r| r.w >= from - 0.0006 && r.w <= to + 0.0006)
            .collect();
        assert!(span.len() >= 5, "{case}: {} strips", span.len());
        for r in span {
            lines(r, 1, None, 0.4954, m0, case);
        }
    }
}

/// OW-5. Voron 2.4, 0.4 nozzle: ins 0.2893 on top and 0.3643 on the first layer (0.5 mm lines there).
#[test]
fn ow_5_voron_one_wall() {
    let (top, first) = measure("voron-2.4-300--n4-sp15-al");
    near(top.layer().ins(), 0.2893, 0.0015, "top ins");
    near(first.layer().ins(), 0.3643, 0.0015, "first ins");
    lines(top.t(3.5), 3, Some(0.4165), 0.4594, 0.4975, "top");
    lines(first.t(3.5), 2, Some(0.5480), 0.5914, 0.6389, "first");
}

/// OW-6. Prusa MK4, 0.4 nozzle (outer 0.4, inner 0.44, internal solid 0.48): ins 0.2793 top, 0.3493 first.
#[test]
fn ow_6_mk4_one_wall() {
    let (top, first) = measure("prusa-mk4--n4-sp15-al");
    near(top.layer().ins(), 0.2793, 0.0015, "top ins");
    near(first.layer().ins(), 0.3493, 0.0015, "first ins");
    lines(top.t(4.4), 4, Some(0.3653), 0.4083, 0.4618, "top");
    lines(first.t(4.4), 3, Some(0.4405), 0.4834, 0.5693, "first");
}

/// OW-7. Where the surface starts across overlaps, widths and nozzles (top / first), margins even.
#[test]
fn ow_7_one_wall_insets() {
    for (case, top_ins, top_s0, first_ins, first_s0) in [
        (
            "creality-ender-3-v3--n4-sp15-al-ov0",
            0.3985,
            ENDER_S0,
            0.3985,
            ENDER_S0,
        ),
        (
            "creality-ender-3-v3--n4-sp15-al-ov50",
            0.2100,
            ENDER_S0,
            0.2100,
            ENDER_S0,
        ),
        ("voron-2.4-300--n4-sp15-al-ov15", 0.3250, 0.3571, 0.4100, 0.4571),
        ("voron-2.4-300--n4-sp15-al-ow0.5", 0.3768, 0.3571, 0.3643, 0.4571),
        (
            "creality-ender-3-v3--n4-sp15-al-ow0.35",
            0.2430,
            ENDER_S0,
            0.2430,
            ENDER_S0,
        ),
        ("prusa-mk4--n4-sp15-al-ow120", 0.3493, 0.3321, 0.3493, 0.4371),
        (
            "creality-ender-3-v3--n4-sp15-al-sw0.5-ov50",
            0.1900,
            ENDER_S0,
            0.1900,
            0.4571,
        ),
        ("prusa-mk4--n4-sp15-al-sw100-ov50", 0.2000, 0.3321, 0.2400, 0.4371),
        ("creality-ender-3-v3--n2-sp15-al", 0.1521, 0.1885, 0.1521, 0.1885),
        ("creality-ender-3-v3--n8-sp15-al", 0.6085, 0.7542, 0.6085, 0.7542),
        ("voron-2.4-300--n8-sp15-al", 0.5935, 0.7342, 0.7285, 0.9142),
        ("prusa-mk4--n6-sp15-al", 0.4189, 0.4981, 0.5239, 0.6556),
        (
            "creality-ender-3-v3--n4-sp15-al-p1",
            0.3043,
            ENDER_S0,
            0.3043,
            ENDER_S0,
        ),
    ] {
        let (top, first) = measure(case);
        spread(&top, top_ins, top_s0, &format!("{case} top"));
        spread(&first, first_ins, first_s0, &format!("{case} first"));
    }
}

/// OW-8. Lines across the strips: on the top every strip from T2.2 prints 80 lines spread along it, 0.37864 mm apart,
/// 0.4935 mm from each end; T0.7 to T2.1 print gap fill only.
#[test]
fn ow_8_one_wall_lines_across_spread_along_the_strip() {
    let (top, _) = measure("creality-ender-3-v3--n4-sp15-ac");
    for (t, l, r) in top.span(2.2, 6.0) {
        let what = format!("T{t}");
        assert_eq!(r.lines.len(), 80, "{what}");
        near(spacing_of(r), 0.37864, 0.0005, &what);
        for w in &r.widths {
            near(*w, 0.42156, 0.001, &what);
        }
        // The lines run across the strip, so their offsets run along it from its low end.
        near(r.lines[0], 0.4935, 0.002, &format!("{what} m0"));
        near(l - r.lines[79], 0.4935, 0.002, &format!("{what} m1"));
    }
    for (t, _, r) in top.span(0.7, 2.1) {
        gap_only(r, &format!("T{t}"));
    }
}

/// OW-9. Creality K1 stock (two walls, `only_one_wall_top`, gap fill everywhere): the topmost layer spreads its lines
/// as a plate of one wall, and a strip whose capped lines leave about 0.4 of a spacing beside them gets a bead there.
#[test]
fn ow_9_k1_top_prints_as_one_wall() {
    let (top, _) = measure("creality-k1--n4-sp15-al");
    near(top.layer().ins(), 0.3043, 0.0015, "top ins");
    let r = top.t(3.5);
    lines(r, 3, Some(0.4398), 0.4827, 0.5241, "T3.5");
    assert!(r.gap_fill <= 0.05, "T3.5 gap fill {:.3}", r.gap_fill);
    let r = top.t(2.9);
    lines(r, 2, Some(0.4525), 0.4954, 0.5306, "T2.9");
    assert!(
        r.gap_fill > 25.0 && r.gap_fill < 35.0,
        "T2.9 gap fill {:.3}",
        r.gap_fill
    );
    gap_only(top.t(2.1), "T2.1");
    assert_eq!(top.t(2.3).lines.len(), 2, "T2.3");
}

/// OW-10. The switches from walls only to gap fill and from gap fill to lines stay where they are; the first
/// surface just above the switch spreads.
#[test]
fn ow_10_one_wall_narrow_switches_hold() {
    // Walls only up to, gap fill from, gap fill up to, lines from; the first surface's spacing and its strip's m0.
    for (case, w_gap, lines_at, first) in [
        (
            "creality-ender-3-v3--n4-sp15-al-f",
            Some((0.844, 0.848)),
            (1.400, 1.403),
            Some((2, 0.3974, 0.4402, 0.5028)),
        ),
        (
            "creality-ender-3-v3--n4-sp15-al-p1-f",
            Some((0.888, 0.892)),
            (1.485, 1.488),
            Some((2, 0.4398, 0.4827, 0.5241)),
        ),
        (
            "creality-ender-3-v3--n4-sp15-al-iw0.35-f",
            Some((0.802, 0.806)),
            (1.288, 1.290),
            None,
        ),
        (
            "creality-ender-3-v3--n4-sp15-al-ov0-f",
            None,
            (1.400, 1.403),
            None,
        ),
    ] {
        let (top, first_layer) = measure(case);
        for (rows, layer) in [(&top, "top"), (&first_layer, "first")] {
            let what = format!("{case} {layer}");
            let rows: Vec<&Row> = rows.0.iter().map(|r| &r.2).collect();
            let at = |w: f64| {
                *rows
                    .iter()
                    .find(|r| (r.w - w).abs() < 0.0006)
                    .unwrap_or_else(|| panic!("{what}: no strip {w}"))
            };
            if let Some((a, b)) = w_gap {
                walls_only(at(a), &what);
                gap_only(at(b), &what);
            }
            gap_only(at(lines_at.0), &what);
            let r = at(lines_at.1);
            assert!(
                !r.lines.is_empty() && r.gap_fill <= 0.05,
                "{what} W {}: {:?}",
                r.w,
                r.lines
            );
            if let Some((n, gap, width, m0)) = first {
                lines(r, n, Some(gap), width, m0, &what);
            }
        }
    }
}

/// OW-11. K1 stock at sparse 0: on the topmost layer strips narrower than a spacing keep their gap fill bead where
/// the walls leave one and walls only below, lines from R = s0; the first layer (two walls) prints as before.
#[test]
fn ow_11_k1_no_sparse_top_and_first_layer() {
    let (top, first) = measure("creality-k1--n4-sp0-al");
    for t in [0.5, 0.6] {
        walls_only(top.t(t), "top");
    }
    for t in [0.7, 0.8, 0.9] {
        gap_only(top.t(t), "top");
    }
    for (t, _, r) in top.span(1.0, 6.0) {
        assert!(!r.lines.is_empty(), "top T{t}: no line");
    }
    assert_eq!(
        first.layer().codes(),
        "......gg......gggggggggggggggggg.......gggg1111111111aa2",
        "first layer"
    );
}

/// OW-12. Bambu Lab A1 (stock: two walls, one wall on top; and one wall), the aegis walls: the tops keep the objects'
/// grid, lines a nominal spacing apart and as wide as set, and the first layer keeps its lines as before.
#[test]
fn ow_12_a1_keeps_its_own_rules() {
    let s0 = 0.42 - 0.2 * (1.0 - std::f64::consts::FRAC_PI_4);
    let top_codes = ".........ggggaaaaaaaaababbbbbbbbcbcccccccdcdcddddddddeed";
    for (case, first_codes) in [
        (
            "a1--n4-sp15-al-L1",
            "...................1111111122222222222233333333333334444",
        ),
        (
            "a1--n4-sp15-al-stock",
            ".......................................................2",
        ),
    ] {
        let (top, first) = measure(case);
        for (_, _, r) in &top.0 {
            if r.lines.len() >= 2 {
                near(spacing_of(r), s0, 0.002, &format!("{case} top W {}", r.w));
            }
            for w in &r.widths {
                near(*w, 0.42, 0.0005, &format!("{case} top W {} width", r.w));
            }
        }
        assert_eq!(top.layer().codes(), top_codes, "{case} top");
        assert_eq!(first.layer().codes(), first_codes, "{case} first layer");
    }
}

/// OW-13. The same A1 projects with the classic walls they name: the tops and the first layer print as before, gap
/// fill in the narrow strips where the aegis walls print walls only.
#[test]
fn ow_13_a1_classic_keeps_its_own_rules() {
    for (case, top_codes, first_codes) in [
        (
            "a1--n4-sp15-al-L1",
            "ggggggggggggggggaaaaaababbbbbbbbcbcccccccdcdcddddddddeed",
            "........gggggggggggggggggg111111112212222222233233333333",
        ),
        (
            "a1--n4-sp15-al-stock",
            "ggggggggggggggggaaaaaababbbbbbbbcbcccccccdcdcddddddddeed",
            "........gggggggggggggggggg.......ggggggggggggggggg112222",
        ),
    ] {
        let (top, first) = measure_with(case, "classic");
        assert_eq!(top.layer().codes(), top_codes, "{case} top");
        assert_eq!(first.layer().codes(), first_codes, "{case} first layer");
    }
}

/// Surfaces on the first layer: a strip that prints gap fill along it prints no bottom surface beside it.
#[test]
fn first_layer_gap_fill_strips_print_no_surface() {
    for case in [
        "creality-ender-3-v3--n4-sp15-al",
        "creality-ender-3-v3--n8-sp15-al",
        "voron-2.4-300--n8-sp15-al",
        "prusa-mk4--n4-sp15-al-ow120",
    ] {
        let (_, first) = measure(case);
        for (t, _, r) in &first.0 {
            if r.gap_fill > 25.0 {
                assert!(r.lines.is_empty(), "{case} T{t}: {:?}", r.lines);
            }
        }
    }
}
