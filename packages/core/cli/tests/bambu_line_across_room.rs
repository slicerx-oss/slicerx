// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where narrow top and first-layer strips start their surface lines on Bambu Lab printers, and how those lines lie.
//!
//! A1 and P1S 0.4 projects of strips 30.9 mm long (`fixtures/bambu-line-across-room`: the projects and each strip's
//! name, center, direction and size), sliced with `sx slice`. Strips along 135 degrees (`-ac-`) have their surface
//! lines across them, strips along 45 degrees (`-al-`) along them. `ml` projects have a monotonic line top, `mo` a
//! monotonic top; `2top` keeps both walls on the top, `stock` the one wall; `sp0` and `sp15` are the sparse infill
//! density. The first layer is monotonic in every project. With s0 the surface's spacing (0.3771 on the top, 0.4571 on
//! the first layer), h the layer height and per side of a strip:
//!
//! - edge0, the innermost wall's centerline plus half its spacing: 0.8056 on the top with two walls, 0.3985 with one,
//!   1.0106 on the A1's first layer and 1.0855 on the P1S's.
//! - eov, edge0 moved out by `infill_wall_overlap` (15 %) of the mean of the wall's and the surface's spacings:
//!   0.7467 and 0.3419 on the top, 0.9419 (A1) and 1.017 (P1S) on the first layer.
//!
//! The rules: a monotonic line top keeps one grid, lines at (k + 1/2) s0 from the center of the object's box, and with
//! no sparse infill prints a line where it lies s0/2 inside edge0, ending 0.05 s0 inside edge0; below that a strip
//! gets one gap fill bead as wide as R0 + h (1 - pi/4), R0 = W - 2 edge0. A monotonic surface spreads its lines on
//! eov and starts them at W - 2 eov >= s0, across a strip or along it, with walls only below. With sparse
//! infill a strip prints gap fill until R0 reaches about 1.6 inner wall spacings.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::disallowed_methods,
    clippy::float_cmp,
    reason = "a G-code reader for the test: positions, angles and lengths in mm"
)]

mod bambu_strips;

use bambu_strips::{Move, Strip, fixture_in, measure_in, moves, slice_in, strips_in};
use serde_json::Value;

const DIR: &str = "bambu-line-across-room";

/// The top surface's spacing, 0.42 lines at h 0.2.
const S_TOP: f64 = 0.42 - 0.2 * (1.0 - std::f64::consts::FRAC_PI_4);
/// h (1 - pi/4) at h 0.2: how much wider a line prints than its spacing.
const SQUISH: f64 = 0.2 * (1.0 - std::f64::consts::FRAC_PI_4);

/// One extrusion in a strip's frame: along the strip from its center (`u`), across it from its low long side (`v`).
#[derive(Debug, Clone, Copy)]
struct Seg {
    u: [f64; 2],
    v: [f64; 2],
    len: f64,
    width: Option<f64>,
}

impl Seg {
    /// Whether the extrusion runs across the strip (within 10 degrees).
    fn across(&self) -> bool {
        (self.u[1] - self.u[0]).abs() <= (self.v[1] - self.v[0]).abs() * 10f64.to_radians().tan()
    }

    /// Whether it runs along the strip (within 10 degrees).
    fn along(&self) -> bool {
        (self.v[1] - self.v[0]).abs() <= (self.u[1] - self.u[0]).abs() * 10f64.to_radians().tan()
    }
}

/// What one strip prints on one layer.
#[derive(Debug, Default)]
struct Cut {
    w: f64,
    surface: Vec<Seg>,
    gap: Vec<Seg>,
}

impl Cut {
    fn across(&self) -> Vec<Seg> {
        self.surface.iter().filter(|s| s.across()).copied().collect()
    }

    fn along(&self) -> Vec<Seg> {
        self.surface.iter().filter(|s| s.along()).copied().collect()
    }

    /// The offsets from the low long side of the lines along the strip (pieces at least 0.2 mm long), merged within
    /// 0.01 mm.
    fn along_at(&self) -> Vec<f64> {
        let mut at: Vec<f64> = self
            .along()
            .iter()
            .filter(|s| s.len >= 0.2)
            .map(|s| f64::midpoint(s.v[0], s.v[1]))
            .collect();
        at.sort_by(f64::total_cmp);
        let mut out: Vec<f64> = Vec::new();
        for a in at {
            if out.last().is_none_or(|l| a - l > 0.01) {
                out.push(a);
            }
        }
        out
    }

    fn surface_len(&self) -> f64 {
        self.surface.iter().map(|s| s.len).sum()
    }

    fn gap_len(&self) -> f64 {
        self.gap.iter().map(|s| s.len).sum()
    }

    /// The positions along the strip of the lines across it, merged within 0.01 mm.
    fn across_at(&self) -> Vec<f64> {
        let mut at: Vec<f64> = self
            .across()
            .iter()
            .map(|s| f64::midpoint(s.u[0], s.u[1]))
            .collect();
        at.sort_by(f64::total_cmp);
        let mut out: Vec<f64> = Vec::new();
        for a in at {
            if out.last().is_none_or(|l| a - l > 0.01) {
                out.push(a);
            }
        }
        out
    }
}

/// A sliced project: its strips by name, placed where the slice put the object, and the extruding moves.
struct Plate {
    case: String,
    names: Vec<String>,
    strips: Vec<Strip>,
    moves: Vec<Move>,
    top_z: i64,
    first_z: i64,
    /// The center of the object's box, which the strips' own bounds give.
    center: [f64; 2],
}

impl Plate {
    fn slice(case: &str) -> Self {
        let moves = moves(&slice_in(DIR, case));
        let mut strips = strips_in(DIR, case);
        let v: Value =
            serde_json::from_slice(&std::fs::read(fixture_in(DIR, &format!("{case}.strips.json"))).unwrap())
                .unwrap();
        let names = v
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap().to_owned())
            .collect();
        // Where the slice put the object: the first layer's outer wall against the strips' own bounds.
        let bounds = |pts: &mut dyn Iterator<Item = [f64; 2]>| {
            let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
            for p in pts {
                for k in 0..2 {
                    lo[k] = lo[k].min(p[k]);
                    hi[k] = hi[k].max(p[k]);
                }
            }
            [f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1])]
        };
        let first_z = moves.iter().map(|m| m.z).min().unwrap();
        let placed = bounds(
            &mut moves
                .iter()
                .filter(|m| m.z == first_z && m.feature == "Outer wall")
                .flat_map(|m| [m.a, m.b]),
        );
        let own = bounds(&mut strips.iter().flat_map(corners));
        for s in &mut strips {
            s.cx += placed[0] - own[0];
            s.cy += placed[1] - own[1];
        }
        let center = bounds(&mut strips.iter().flat_map(corners));
        let top_z = moves
            .iter()
            .filter(|m| m.feature != "Custom")
            .map(|m| m.z)
            .max()
            .unwrap();
        Self {
            case: case.to_owned(),
            names,
            strips,
            moves,
            top_z,
            first_z,
            center,
        }
    }

    /// Where the strip `name`'s low long side lies across it, mm from the center of the object's box.
    fn base(&self, name: &str) -> f64 {
        let i = self.names.iter().position(|n| n == name).unwrap();
        let s = &self.strips[i];
        let a = s.ang.to_radians();
        -(s.cx - self.center[0]) * a.sin() + (s.cy - self.center[1]) * a.cos() - s.w / 2.0
    }

    /// What the strip `name` prints on the top layer (`top`) or the first layer.
    fn cut(&self, name: &str, top: bool) -> Cut {
        let i = self
            .names
            .iter()
            .position(|n| n == name)
            .unwrap_or_else(|| panic!("{}: no strip {name}", self.case));
        let s = &self.strips[i];
        let (z, surface) = if top {
            (self.top_z, "Top surface")
        } else {
            (self.first_z, "Bottom surface")
        };
        let a = s.ang.to_radians();
        let (ux, uy) = (a.cos(), a.sin());
        let frame = |p: [f64; 2]| {
            let (dx, dy) = (p[0] - s.cx, p[1] - s.cy);
            (dx * ux + dy * uy, -dx * uy + dy * ux + s.w / 2.0)
        };
        let mut cut = Cut {
            w: s.w,
            ..Cut::default()
        };
        for m in self.moves.iter().filter(|m| m.z == z) {
            let ((u0, v0), (u1, v1)) = (frame(m.a), frame(m.b));
            let (um, vm) = (f64::midpoint(u0, u1), f64::midpoint(v0, v1));
            if um.abs() > s.l / 2.0 + 0.05 || !(-0.05..=s.w + 0.05).contains(&vm) {
                continue;
            }
            let seg = Seg {
                u: [u0, u1],
                v: [v0.min(v1), v0.max(v1)],
                len: (u1 - u0).hypot(v1 - v0),
                width: m.width,
            };
            if m.feature == surface {
                cut.surface.push(seg);
            } else if m.feature == "Gap infill" {
                cut.gap.push(seg);
            }
        }
        cut
    }
}

fn corners(s: &Strip) -> [[f64; 2]; 4] {
    let a = s.ang.to_radians();
    let (ux, uy) = (a.cos(), a.sin());
    [(-1.0, -1.0), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0)].map(|(i, j): (f64, f64)| {
        [
            s.cx + ux * i * s.l / 2.0 - uy * j * s.w / 2.0,
            s.cy + uy * i * s.l / 2.0 + ux * j * s.w / 2.0,
        ]
    })
}

fn near(got: f64, want: f64, tol: f64, what: &str) {
    assert!(
        (got - want).abs() <= tol,
        "{what}: {got:.4}, expected {want:.4} within {tol}"
    );
}

/// No surface line in `cut`, and gap fill only if `gap`.
fn no_lines(cut: &Cut, gap: bool, what: &str) {
    assert!(
        cut.surface_len() <= 0.05,
        "{what}: {:.3} mm of surface",
        cut.surface_len()
    );
    assert_eq!(
        cut.gap_len() > 0.05,
        gap,
        "{what}: {:.3} mm of gap fill",
        cut.gap_len()
    );
}

/// One gap fill bead down the middle of `cut`, of spacing `r0` (stated width r0 + h (1 - pi/4)), and no surface.
fn one_bead(cut: &Cut, r0: f64, what: &str) {
    no_lines(cut, true, what);
    for g in &cut.gap {
        if g.len < 0.5 {
            continue;
        }
        near(
            f64::midpoint(g.v[0], g.v[1]),
            cut.w / 2.0,
            0.01,
            &format!("{what} bead"),
        );
        near(
            g.width.unwrap_or(0.0),
            r0 + SQUISH,
            0.005,
            &format!("{what} bead width"),
        );
    }
}

/// The ends of the lines across `cut` keep `ends` from each long side.
fn across_ends(cut: &Cut, ends: f64, what: &str) {
    let across = cut.across();
    assert!(!across.is_empty(), "{what}: no line across");
    for s in &across {
        near(s.v[0], ends, 0.002, &format!("{what} low end"));
        near(cut.w - s.v[1], ends, 0.002, &format!("{what} high end"));
    }
}

/// The surface pieces along `cut` (a first layer's connectors, or its one path down the middle) lie `at` from each
/// long side.
fn along_at(cut: &Cut, at: f64, what: &str) {
    let along: Vec<Seg> = cut.along().into_iter().filter(|s| s.len >= 0.2).collect();
    assert!(!along.is_empty(), "{what}: no surface along the strip");
    for s in &along {
        let v = f64::midpoint(s.v[0], s.v[1]);
        let d = v.min(cut.w - v);
        near(d, at, 0.005, &format!("{what} piece along"));
    }
}

/// BR-1. A1, monotonic line top, two walls on the top, no sparse infill, lines across: a 1.984 mm strip (R0 just under
/// s0) has no top surface and one gap fill bead of spacing R0; a 1.999 mm strip prints its grid's lines across.
#[test]
fn br_1_bambu_monotonic_line_top_starts_lines_across_at_one_spacing() {
    let plate = Plate::slice("a1--ml-2top-sp0-ac-f");
    let cut = plate.cut("T1.300", true);
    one_bead(&cut, cut.w - 2.0 * 0.8056, "T1.300 (W 1.984)");
    // BR-1b: 76 lines across, pitch 0.37708, ends 0.8245 (edge0 + 0.05 s0) from each side, 0.350 long, 0.42 wide.
    let cut = plate.cut("T1.340", true);
    let at = cut.across_at();
    assert_eq!(at.len(), 76, "T1.340 lines across");
    near(
        (at[at.len() - 1] - at[0]) / (at.len() - 1) as f64,
        0.37708,
        0.0005,
        "T1.340 pitch",
    );
    across_ends(&cut, 0.8245, "T1.340");
    for s in cut.across() {
        near(s.len, 0.350, 0.003, "T1.340 line length");
        near(s.width.unwrap_or(0.0), 0.42, 0.001, "T1.340 line width");
    }
}

/// BR-2. A1, monotonic top, two walls on the top, no sparse infill: walls only at 1.859 mm (W - 2 eov just under
/// s0), one line along the middle at 1.878 mm, whether the lines run across the strips or along them.
#[test]
fn br_2_bambu_monotonic_top_starts_at_one_spacing_on_the_overlap_edge() {
    for case in ["a1--mo-2top-sp0-ac-f", "a1--mo-2top-sp0-al-f"] {
        let plate = Plate::slice(case);
        no_lines(
            &plate.cut("T0.970", true),
            false,
            &format!("{case} T0.970 (W 1.859)"),
        );
        // Across the strip only the stubs between the two pieces along it, R - s0 long, under 5 % of the path.
        let cut = plate.cut("T1.020", true);
        let across: f64 = cut.across().iter().map(|s| s.len).sum();
        assert!(
            across <= 0.05 * cut.surface_len(),
            "{case} T1.020: {across:.3} mm across"
        );
        along_at(&cut, cut.w / 2.0, &format!("{case} T1.020 (W 1.878)"));
    }
}

/// BR-3. The monotonic first layer under it, A1 and P1S: no bottom surface until W - 2 eov reaches s0, then one path
/// or connectors along the strip eov + s0/2 from each side (1.1705 on the A1, 1.2456 on the P1S).
#[test]
fn br_3_bambu_first_layer_starts_at_one_spacing_on_the_overlap_edge() {
    for (case, below, from, at) in [
        ("a1--ml-2top-sp0-ac-f", "T2.220", "T2.270", 1.1705),
        ("p1s--ml-2top-sp0-ac-f", "T2.620", "T2.670", 1.2456),
    ] {
        let plate = Plate::slice(case);
        let cut = plate.cut(below, false);
        assert!(cut.surface_len() <= 0.05, "{case} {below}: bottom surface");
        along_at(&plate.cut(from, false), at, &format!("{case} {from}"));
    }
}

/// BR-4. One wall on the top: a monotonic line top keeps its gap fill bead at 1.166 mm and prints lines across at
/// 1.184 mm, ending 0.4174 from each side; a monotonic top prints walls only at 1.052 mm and lines at 1.071 mm.
#[test]
fn br_4_bambu_one_wall_tops_start_at_one_spacing() {
    let plate = Plate::slice("a1--ml-stock-sp0-ac-f");
    let cut = plate.cut("T-0.870", true);
    one_bead(&cut, cut.w - 2.0 * 0.3985, "ml T-0.870 (W 1.166)");
    across_ends(&plate.cut("T-0.820", true), 0.4174, "ml T-0.820 (W 1.184)");
    let plate = Plate::slice("a1--mo-stock-sp0-ac-f");
    no_lines(&plate.cut("T-1.170", true), false, "mo T-1.170 (W 1.052)");
    let cut = plate.cut("T-1.120", true);
    assert!(cut.surface_len() > 1.0, "mo T-1.120 (W 1.071): no top surface");
}

/// BR-5. Sparse infill 15 %: the gap fill bead of spacing R0 holds until the strip switch, then lines print. Top on the
/// A1 (2.255 and 2.274 mm), first layer on the A1 (2.746 and 2.764 mm) and the P1S (2.893 and 2.911 mm).
#[test]
fn br_5_bambu_sparse_infill_strip_switch() {
    let plate = Plate::slice("a1--ml-2top-sp15-ac-f");
    let cut = plate.cut("T2.020", true);
    one_bead(&cut, cut.w - 2.0 * 0.8056, "top T2.020 (W 2.255)");
    assert!(
        plate.cut("T2.070", true).surface_len() > 1.0,
        "top T2.070 (W 2.274): no top surface"
    );
    for (case, below, from, edge0) in [
        ("a1--ml-2top-sp15-ac-g", "T3.320", "T3.370", 1.0106),
        ("p1s--ml-2top-sp15-ac-g", "T3.710", "T3.760", 1.0855),
    ] {
        let plate = Plate::slice(case);
        let cut = plate.cut(below, false);
        one_bead(&cut, cut.w - 2.0 * edge0, &format!("{case} first {below}"));
        assert!(
            plate.cut(from, false).surface_len() > 1.0,
            "{case} first {from}: no bottom surface"
        );
    }
}

/// BR-6. A1, monotonic line top, lines along: on every strip the lines lie at (k + 1/2) s0 from the center of the
/// object's box, and a grid line prints where it lies at least s0/2 inside edge0 (0.8056) and not where it lies 0.49 s0
/// or less inside.
#[test]
fn br_6_bambu_monotonic_line_grid_lines_print_half_a_spacing_inside_the_edge() {
    let plate = Plate::slice("a1--ml-2top-sp0-al-f");
    let edge0 = 0.8056;
    let mut checked = 0;
    for name in &plate.names {
        let cut = plate.cut(name, true);
        let (base, lines) = (plate.base(name), cut.along_at());
        for l in &lines {
            let at = (base + l) / S_TOP - 0.5;
            assert!(
                (at - at.round()).abs() * S_TOP <= 0.003,
                "W {}: line {l:.4} is {:.4} spacings from the object's center",
                cut.w,
                at + 0.5
            );
        }
        // Every grid line across the strip, by its margin inside edge0 on the nearer side.
        let first = (base / S_TOP - 0.5).floor() as i64;
        let last = ((base + cut.w) / S_TOP - 0.5).ceil() as i64;
        for k in first..=last {
            let at = (k as f64 + 0.5) * S_TOP - base;
            let margin = (at - edge0).min(cut.w - edge0 - at) / S_TOP;
            let printed = lines.iter().any(|l| (l - at).abs() <= 0.01);
            if margin >= 0.5 {
                assert!(printed, "W {}: no line at {at:.4} (margin {margin:.4} s0)", cut.w);
                checked += 1;
            } else if margin <= 0.49 {
                assert!(!printed, "W {}: a line at {at:.4} (margin {margin:.4} s0)", cut.w);
            }
        }
    }
    assert!(checked >= 20, "{checked} grid lines checked");
}

/// BR-7. A1, monotonic top, lines along: a 2.549 mm strip spreads 2 lines on eov (W - 2 eov = 2.8 s0, pitch
/// capped at 1.2 s0), at 0.973 and 1.425 from the low side, 0.4954 wide.
#[test]
fn br_7_bambu_monotonic_top_spreads_on_the_overlap_edge() {
    let (top, _) = measure_in(DIR, "a1--mo-2top-sp0-al-c");
    let r = top.at(2.549);
    bambu_strips::lines_at(r, &[0.973, 1.425], 0.002, "W 2.549");
    bambu_strips::widths(r, 1.2 * S_TOP + SQUISH, 0.001, "W 2.549");
}
