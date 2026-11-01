// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where the first layer's bottom surface and a monotonic top start on Bambu Lab printers, which overlap setting moves
//! them, and what narrow strips print there.
//!
//! Projects of strips 30.9 mm long along 45 degrees (`fixtures/bambu-surface-edge`: the A1, P1S and X1 Carbon 0.4
//! projects with the strips as one object, and each strip's center, direction and size), sliced with `sx slice`. The
//! surface lines run along the strips. Per strip the tests read, on the top layer and the first, the surface lines
//! (their offsets from the strip's low long side and stated widths), the gap fill and the wall centerlines' distances
//! from the nearer long side. A project's strips are found where the slice put them: the first layer's outer wall
//! against the strips' own bounds (the P1S puts the object 2 mm lower than the A1).
//!
//! The rule, with h the layer height, s(w) = w - h (1 - pi/4), c the innermost wall's centerline, sc its spacing,
//! sw the internal solid infill width and iwo `infill_wall_overlap` (`top_bottom_infill_wall_overlap` is not read):
//!
//! - A monotonic surface (the first layer's, and a top set to it) spreads its lines across each piece from
//!   ins = c + sc/2 - iwo (sc + s(sw))/2: N = floor(R/s) lines over R = W - 2 ins, at min(R/N, 1.2 s) apart, the
//!   first half that in from ins, each as wide as its spacing plus h (1 - pi/4).
//! - The precise outer wall moves c and the edge with it.
//! - At sparse infill density 0 a strip prints a line once R >= s and keeps its gap fill below that.
//! - Walls do not move.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::disallowed_methods,
    clippy::float_cmp,
    reason = "a G-code reader for the test: positions, angles and lengths in mm"
)]

mod bambu_strips;

use bambu_strips::{A1_FIRST, A1_TOP, lines_at, measure, near, walls, widths};

/// E-a. A1, 2 walls, `infill_wall_overlap` 15 %: the first layer spreads its lines from 0.9420 mm; the 2.916 mm strip
/// prints 2 lines 0.559 mm wide.
#[test]
fn e_a_bambu_first_layer_spreads_its_lines_from_the_infill_wall_overlap_edge() {
    let case = "a1--o-cl-L2-p0-iwo15";
    let (top, first) = measure(case);
    walls(case, &top, &first, &A1_TOP, &A1_FIRST);
    near(first.ins(), 0.9420, 0.0015, "ins");
    let r = first.at(2.916);
    lines_at(r, &[1.2002, 1.7157], 0.003, "W 2.916");
    widths(r, 0.559, 0.001, "W 2.916");
}

/// E-b. The first layer's edge moves with `infill_wall_overlap`: 0, 25 and 50 %.
#[test]
fn e_b_bambu_first_layer_edge_follows_infill_wall_overlap() {
    for (case, ins) in [
        ("a1--o-cl-L2-p0-iwo0", 1.0105),
        ("a1--o-cl-L2-p0-iwo25", 0.8966),
        ("a1--o-cl-L2-p0-iwo50", 0.7822),
    ] {
        let (top, first) = measure(case);
        walls(case, &top, &first, &A1_TOP, &A1_FIRST);
        near(first.ins(), ins, 0.0015, case);
    }
}

/// E-c. `top_bottom_infill_wall_overlap` set to 0 or 50 % moves neither the first layer's edge nor the top's first
/// line threshold, which stays c + sc/2 + s/2 (0.3921 mm past the inner wall) within the strips' resolution.
#[test]
fn e_c_bambu_ignores_top_bottom_infill_wall_overlap() {
    for (case, ins, top_walls) in [
        ("a1--o-cl-L2-p0-iwo15-tbo0", 0.9421, [0.2101, 0.6022]),
        ("a1--o-cl-L2-p0-iwo15-tbo50", 0.9420, A1_TOP),
    ] {
        let (top, first) = measure(case);
        walls(case, &top, &first, &top_walls, &A1_FIRST);
        near(first.ins(), ins, 0.0015, case);
        let c = top.walls()[1];
        let (lo, hi) = top.threshold();
        assert!(
            lo - c < 0.3921 && 0.3921 <= hi - c,
            "{case}: top T - c in ({:.4}, {:.4}]",
            lo - c,
            hi - c
        );
    }
}

/// E-d. 3 walls with the precise outer wall: the first inner wall sits the mean of the two widths in, and the edge
/// follows the innermost wall.
#[test]
fn e_d_bambu_precise_outer_wall_moves_the_first_layer_edge() {
    for (case, ins) in [("a1--o-cl-L3-p1-iwo0", 1.5108), ("a1--o-cl-L3-p1-iwo50", 1.2820)] {
        let (top, first) = measure(case);
        walls(
            case,
            &top,
            &first,
            &[0.21, 0.6451, 1.0522],
            &[0.3251, 0.8251, 1.2823],
        );
        near(first.ins(), ins, 0.0015, case);
    }
}

/// E-e. The P1S and the X1 Carbon: elephant foot compensation 0.15 puts the first layer's walls and edge 0.075 mm
/// further in than the A1's.
#[test]
fn e_e_bambu_p1s_and_x1_carbon_first_layer_edge() {
    for (case, ins) in [
        ("p1s--o-cl-L2-p0-iwo0", 1.0858),
        ("p1s--o-cl-L2-p0-iwo50", 0.8572),
        ("x1c--o-cl-L2-p0-iwo0", 1.0858),
        ("x1c--o-cl-L2-p0-iwo50", 0.8572),
    ] {
        let (top, first) = measure(case);
        walls(case, &top, &first, &A1_TOP, &[0.4, 0.8572]);
        near(first.ins(), ins, 0.0015, case);
    }
}

/// E-f. A top set to monotonic spreads its lines too, from the mean of the inner wall's and the internal solid
/// infill's spacings; the 2.916 mm strip prints 3 lines 0.495 mm wide.
#[test]
fn e_f_bambu_monotonic_top_spreads_its_lines() {
    for (case, ins) in [
        ("a1--o-cl-L2-p0-iwo15-tpmono", 0.7467),
        ("a1--o-cl-L2-p0-iwo50-tpmono", 0.6094),
    ] {
        let (top, first) = measure(case);
        walls(case, &top, &first, &A1_TOP, &A1_FIRST);
        near(top.ins(), ins, 0.0015, case);
        if case.contains("iwo15") {
            let r = top.at(2.916);
            lines_at(r, &[0.9725, 1.4250, 1.8776], 0.003, "W 2.916");
            widths(r, 0.495, 0.001, "W 2.916");
        }
    }
}

/// E-m. Sparse infill 0: a first-layer strip prints one line once R >= s (2.350 mm, a 0.509 mm line down its middle
/// and no gap fill) and walls only below (2.313 mm, R = 0.94 s), as the line-across room rule measured it on the
/// A1 and the P1S.
#[test]
fn e_m_bambu_narrow_first_layer_strip_prints_a_line_once_one_fits() {
    let case = "a1--n-cl-sp0-L2-p0-2w";
    let (top, first) = measure(case);
    walls(case, &top, &first, &A1_TOP, &[0.325, 0.7822]);
    let r = first.at(2.350);
    lines_at(r, &[1.175], 0.002, "W 2.350");
    widths(r, 0.509, 0.001, "W 2.350");
    assert!(r.gap_fill <= 0.05, "W 2.350 gap fill {}", r.gap_fill);
    let r = first.at(2.313);
    assert!(r.lines.is_empty() && r.gap_fill <= 0.05, "W 2.313: {r:?}");
}

/// E-n. The first line comes at 2.464 mm with the precise outer wall on the A1 and at 2.501 mm on the P1S; every
/// narrower strip prints none.
#[test]
fn e_n_bambu_narrow_first_layer_line_follows_the_moved_edge() {
    for (case, from, want_first) in [
        ("a1--n-cl-sp0-L2-p1-2w", 2.464, [0.325, 0.8251]),
        ("p1s--n-cl-sp0-L2-p0-2w", 2.501, [0.4, 0.8572]),
    ] {
        let (top, first) = measure(case);
        let top_walls = if case.starts_with("a1") {
            [0.21, 0.6451]
        } else {
            A1_TOP
        };
        walls(case, &top, &first, &top_walls, &want_first);
        for r in &first.0 {
            assert_eq!(
                r.lines.is_empty(),
                r.w < from - 0.0005,
                "{case} W {}: {:?}",
                r.w,
                r.lines
            );
        }
    }
}

/// E-p. Sparse infill 15 %: the first layer keeps the gap fill switch at 1.6 inner spacings (2.746 mm), then spreads:
/// at 15 % one line at the 1.2 s cap (2.765 mm), two from 2.803 mm; at 50 % two at once.
#[test]
fn e_p_bambu_first_layer_lines_after_the_narrow_switch() {
    let case = "a1--f-first-L2-sp15-iwo15";
    let (top, first) = measure(case);
    walls(case, &top, &first, &A1_TOP, &[0.325, 0.7822]);
    let r = first.at(2.746);
    assert!(r.lines.is_empty() && r.gap_fill > 0.05, "W 2.746: {r:?}");
    let r = first.at(2.765);
    lines_at(r, &[1.2162], 0.003, "W 2.765");
    widths(r, 0.591, 0.001, "W 2.765");
    let r = first.at(2.803);
    lines_at(r, &[1.1720, 1.6309], 0.003, "W 2.803");
    widths(r, 0.502, 0.001, "W 2.803");
    let case = "a1--f-first-L2-sp15-iwo50";
    let (top, first) = measure(case);
    walls(case, &top, &first, &A1_TOP, &[0.325, 0.7822]);
    let r = first.at(2.746);
    assert!(r.lines.is_empty() && r.gap_fill > 0.05, "W 2.746: {r:?}");
    assert_eq!(first.at(2.765).lines.len(), 2, "iwo 50 W 2.765");
}

/// G-a. Sparse infill 15 %: no top line on a strip whose free width inside the walls is under 1.584 inner spacings.
#[test]
fn g_a_bambu_narrow_top_strips_keep_their_gap_fill() {
    let s_iw = 0.45 - 0.2 * (1.0 - std::f64::consts::FRAC_PI_4);
    for (case, want_top, want_first) in [
        (
            "a1--f-top-L2-sp15-iwo15",
            vec![0.21, 0.6021],
            vec![0.3251, 0.7822],
        ),
        (
            "a1--f-top-L3-sp15-iwo15",
            vec![0.2101, 0.6021, 1.0093],
            vec![0.3251, 0.7822, 1.2393],
        ),
    ] {
        let (top, first) = measure(case);
        walls(case, &top, &first, &want_top, &want_first);
        let c = want_top[want_top.len() - 1];
        for r in &top.0 {
            let free = r.w - 2.0 * (c + s_iw / 2.0);
            if free < 1.584 * s_iw {
                assert!(r.lines.is_empty(), "{case} W {}: {:?}", r.w, r.lines);
            }
        }
    }
}

/// G-b. Sparse infill 15 %, narrow strips: the first layer's gap fill and walls-only bands stay.
#[test]
fn g_b_bambu_narrow_first_layer_codes_stay() {
    let case = "a1--n-cl-sp15-L2-p0-2w";
    let (top, first) = measure(case);
    walls(case, &top, &first, &A1_TOP, &[0.325, 0.7822]);
    assert_eq!(first.codes(), "ggggggg......ggggggggggggg");
}
