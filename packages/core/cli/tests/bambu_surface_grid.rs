// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where the lines of a monotonic line top (the stock top) and of a monotonic line first layer lie on Bambu Lab
//! printers, and what narrow top strips print there.
//!
//! The strip projects of `bambu_surface_edge.rs` (`fixtures/bambu-surface-edge`), read the same way. The rule, with h
//! the layer height, s(w) = w - h (1 - pi/4), c the innermost wall's centerline, sc its spacing and s the surface's
//! spacing:
//!
//! - The lines lie on one grid, at (j + 1/2) s across the lines from the center of the object's box, so they move
//!   with the object.
//! - A line prints when its center is at least T = c + sc/2 + s/2 from the outline, whatever the overlap settings.
//!   With one wall on the top, c is the outer wall's centerline and sc its spacing.
//! - Gap fill covers what the lines leave, also on a narrow strip no line of the grid fits in.
//! - With no sparse infill a narrow top strip is top surface: the grid's lines that fit, and gap fill.
//! - Walls do not move.
#![allow(
    clippy::approx_constant,
    clippy::cast_precision_loss,
    reason = "positions and lengths in mm; a strip 3.142 mm wide is not pi"
)]

mod bambu_strips;

use bambu_strips::{A1_FIRST, A1_TOP, Layer, Row, lines_at, measure, walls};

/// s(w) at h 0.2.
fn spacing(w: f64) -> f64 {
    w - 0.2 * (1.0 - std::f64::consts::FRAC_PI_4)
}

/// The top surface's spacing, 0.42 lines.
fn s_top() -> f64 {
    spacing(0.42)
}

/// Every line of `row` lies at (j + 1/2) `s` from the center of the object's box, within 0.003 mm.
fn on_object_grid(row: &Row, s: f64, what: &str) {
    for l in &row.lines {
        let at = (row.base + l) / s - 0.5;
        assert!(
            (at - at.round()).abs() * s <= 0.003,
            "{what} W {}: line {l:.4} is {:.4} spacings from the object's center",
            row.w,
            at + 0.5
        );
    }
}

/// The first line threshold of `layer`, past its innermost wall, contains `want`.
fn threshold_contains(layer: &Layer, want: f64, what: &str) {
    let c = *layer.walls().last().expect("walls");
    let (lo, hi) = layer.threshold();
    assert!(
        lo - c < want && want <= hi - c,
        "{what}: T - c in ({:.4}, {:.4}], expected {want}",
        lo - c,
        hi - c
    );
}

/// No line of `row` sits closer than `t` to either long side (within 0.003 mm).
fn clear_of(row: &Row, t: f64, what: &str) {
    for l in &row.lines {
        assert!(
            *l >= t - 0.003 && row.w - l >= t - 0.003,
            "{what} W {}: line {l:.4} closer than {t:.4} to a side",
            row.w
        );
    }
}

/// E-g. A1, 2 walls, `infill_wall_overlap` 15 %: the top's lines lie on the object's grid and start 0.3921 mm past
/// the inner wall (T = c + sc/2 + s/2).
#[test]
fn e_g_bambu_top_lines_lie_on_the_objects_grid() {
    let case = "a1--o-cl-L2-p0-iwo15";
    let (top, first) = measure(case);
    walls(case, &top, &first, &A1_TOP, &A1_FIRST);
    lines_at(top.at(2.916), &[1.2773, 1.6549], 0.003, "W 2.916");
    lines_at(top.at(3.142), &[1.0208, 1.3977, 1.7746], 0.003, "W 3.142");
    lines_at(
        top.at(3.746),
        &[1.2408, 1.6184, 1.9953, 2.3722, 2.7498],
        0.003,
        "W 3.746",
    );
    for r in &top.0 {
        on_object_grid(r, s_top(), case);
    }
    threshold_contains(&top, 0.3921, case);
}

/// E-h. The object moved 0.10 and 0.25 mm in x: every strip's top lines stay where they were on the strip.
#[test]
fn e_h_bambu_top_lines_move_with_the_object() {
    let (base, _) = measure("a1--o-cl-L2-p0-iwo15");
    for case in ["a1--o-cl-L2-p0-iwo15-dx10", "a1--o-cl-L2-p0-iwo15-dx25"] {
        let (top, first) = measure(case);
        walls(case, &top, &first, &A1_TOP, &A1_FIRST);
        for r in &base.0 {
            lines_at(top.at(r.w), &r.lines, 0.003, &format!("{case} W {}", r.w));
        }
    }
}

/// E-i. The stock one wall on top: the top's lines start s(ow)/2 + s/2 past the outer wall's centerline (0.3771).
#[test]
fn e_i_bambu_one_wall_top_threshold() {
    for case in ["a1--o-cl-L2-p0-iwo0-stock", "a1--o-cl-L2-p0-iwo50-stock"] {
        let (top, first) = measure(case);
        walls(case, &top, &first, &[0.21], &A1_FIRST);
        threshold_contains(&top, 0.3771, case);
        for r in &top.0 {
            on_object_grid(r, s_top(), case);
        }
    }
}

/// E-j. A monotonic line first layer keeps the grid too: with 0.5 lines its first line threshold is 0.4571 past the
/// inner wall.
#[test]
fn e_j_bambu_monotonic_line_first_layer_threshold() {
    let case = "a1--o-cl-L2-p0-iwo15-bpline";
    let (top, first) = measure(case);
    walls(case, &top, &first, &A1_TOP, &A1_FIRST);
    threshold_contains(&first, 0.4571, case);
    for r in &first.0 {
        on_object_grid(r, spacing(0.5), case);
    }
}

/// E-o. No sparse infill, narrow top strips below the gap fill switch: the grid's line that fits prints with gap fill
/// beside it, and a strip no line fits in prints gap fill.
#[test]
fn e_o_bambu_narrow_top_strips_without_sparse_infill_print_the_grid() {
    let case = "a1--f-top-L2-sp0-iwo15";
    let (top, first) = measure(case);
    walls(case, &top, &first, &A1_TOP, &[0.325, 0.7822]);
    for (w, at) in [
        (2.124, 1.0693),
        (2.152, 1.1195),
        (2.181, 1.0865),
        (2.200, 1.1419),
        (2.218, 1.1601),
        (2.237, 1.1405),
        (2.256, 1.0836),
    ] {
        let r = top.at(w);
        lines_at(r, &[at], 0.003, &format!("W {w}"));
        assert!(r.gap_fill > 0.05, "W {w}: no gap fill");
    }
    for w in [2.134, 2.143, 2.162] {
        let r = top.at(w);
        assert!(r.lines.is_empty() && r.gap_fill > 0.05, "W {w}: {r:?}");
    }
}

/// Narrow top strips past the gap fill switch (free width F0 = W - 2 (c + sc/2) from 1.609 inner spacings) up to 3
/// spacings: none prints walls only. Each prints the grid's lines that clear T, or gap fill where none does.
#[test]
fn bambu_narrow_top_strips_past_the_switch_are_never_empty() {
    let s_iw = spacing(0.45);
    for (case, want_top, want_first, from) in [
        (
            "a1--f-top-L2-sp15-iwo15",
            vec![0.21, 0.6021],
            vec![0.3251, 0.7822],
            1.609,
        ),
        (
            "a1--f-top-L3-sp15-iwo15",
            vec![0.2101, 0.6021, 1.0093],
            vec![0.3251, 0.7822, 1.2393],
            1.609,
        ),
        (
            "a1--f-top-L2-sp0-iwo15",
            vec![0.21, 0.6021],
            vec![0.325, 0.7822],
            0.3,
        ),
    ] {
        let (top, first) = measure(case);
        walls(case, &top, &first, &want_top, &want_first);
        let c = want_top[want_top.len() - 1];
        let t = c + s_iw / 2.0 + s_top() / 2.0;
        let past: Vec<&Row> = top
            .0
            .iter()
            .filter(|r| {
                let free = r.w - 2.0 * (c + s_iw / 2.0);
                free >= from * s_iw && free <= 3.0 * s_top()
            })
            .collect();
        let empty: Vec<f64> = past
            .iter()
            .filter(|r| r.lines.is_empty() && r.gap_fill <= 0.05)
            .map(|r| r.w)
            .collect();
        assert!(empty.is_empty(), "{case}: walls only at W {empty:?}");
        for r in &past {
            clear_of(r, t, case);
            on_object_grid(r, s_top(), case);
        }
        let seen = past.len();
        assert!(seen >= 10, "{case}: {seen} strips past the switch");
    }
}

/// E-l, with `only_one_wall_top` (the key this tree reads for one wall on top): one wall, and the 2.162 mm strip
/// prints three grid lines plus gap fill.
#[test]
fn e_l_bambu_one_wall_top_narrow_strip_lines() {
    let case = "a1--n-cl-sp15-L2-p0-oow1-topmost";
    let (top, first) = measure(case);
    walls(case, &top, &first, &[0.21], &[0.325, 0.7822]);
    let r = top.at(2.162);
    lines_at(r, &[0.7149, 1.0917, 1.4686], 0.003, "W 2.162");
    assert!(r.gap_fill > 0.05, "W 2.162: no gap fill");
}
