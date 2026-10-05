// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

use super::geo::{self, Join};
use i_overlay::i_float::int::point::IntPoint;

fn square(x0: i32, y0: i32, x1: i32, y1: i32) -> crate::perimeters::Shapes {
    vec![vec![vec![
        IntPoint::new(x0, y0),
        IntPoint::new(x1, y0),
        IntPoint::new(x1, y1),
        IntPoint::new(x0, y1),
    ]]]
}

#[test]
fn offsets_grow_and_shrink_a_square() {
    let s = square(0, 0, 100_000, 100_000);
    let a0 = geo::area(&s);
    let grown = geo::offset(&s, 10_000.0, Join::Round(120.0));
    let shrunk = geo::offset(&s, -10_000.0, Join::Round(120.0));
    let mitered = geo::offset_miter(&s, 10_000.0);
    assert!(geo::area(&grown) > a0 && geo::area(&grown) < 120_000.0 * 120_000.0);
    assert!((geo::area(&shrunk) - 80_000.0 * 80_000.0).abs() < 1e6);
    // Clipper miters any corner with a limit under 2 up to 120 degrees, so right angles stay sharp.
    assert!((geo::area(&mitered) - 120_000.0 * 120_000.0).abs() < 1e6);
}

#[test]
fn contains_counts_the_border() {
    let s = square(0, 0, 100, 100);
    assert!(geo::contains(&s, (50, 50)));
    assert!(geo::contains(&s, (0, 50)));
    assert!(!geo::contains(&s, (150, 50)));
}

#[test]
fn smoothing_fills_a_notch() {
    // A square with a narrow notch cut into its top.
    let ring = vec![
        IntPoint::new(0, 0),
        IntPoint::new(100_000, 0),
        IntPoint::new(100_000, 100_000),
        IntPoint::new(51_000, 100_000),
        IntPoint::new(50_000, 60_000),
        IntPoint::new(49_000, 100_000),
        IntPoint::new(0, 100_000),
    ];
    let s = vec![vec![ring]];
    let out = super::smooth::smooth_outward(&s, 4_000);
    assert!(geo::area(&out) > geo::area(&s));
}
