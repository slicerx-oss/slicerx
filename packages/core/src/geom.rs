// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Integer 2D geometry. One unit is 0.1 micrometer.

/// Internal units per millimeter.
pub const SCALE: f64 = 10_000.0;

/// A 2D point in internal units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PartialOrd, Ord)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

impl Point {
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }

    /// Converts millimeters to internal units, rounding to the nearest unit.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "plate coordinates are far inside i32 range"
    )]
    pub fn from_mm(x: f64, y: f64) -> Self {
        Self {
            x: (x * SCALE).round() as i32,
            y: (y * SCALE).round() as i32,
        }
    }

    pub fn x_mm(self) -> f64 {
        f64::from(self.x) / SCALE
    }

    pub fn y_mm(self) -> f64 {
        f64::from(self.y) / SCALE
    }

    /// Squared distance in internal units.
    pub fn dist2(self, o: Self) -> i64 {
        let dx = i64::from(self.x) - i64::from(o.x);
        let dy = i64::from(self.y) - i64::from(o.y);
        dx * dx + dy * dy
    }

    /// Distance in millimeters.
    #[allow(clippy::cast_precision_loss, reason = "squared distances stay below 2^52")]
    pub fn dist_mm(self, o: Self) -> f64 {
        (self.dist2(o) as f64).sqrt() / SCALE
    }
}

/// Converts a length in millimeters to internal units.
#[allow(
    clippy::cast_possible_truncation,
    reason = "lengths on a print bed fit in i32"
)]
pub fn mm(v: f64) -> i32 {
    (v * SCALE).round() as i32
}

/// A closed polygon; the last point connects back to the first.
pub type Polygon = Vec<Point>;

/// Twice the signed area (positive for counterclockwise).
pub fn area2(poly: &[Point]) -> i64 {
    let n = poly.len();
    let mut acc = 0i64;
    for i in 0..n {
        let (Some(a), Some(b)) = (poly.get(i), poly.get((i + 1) % n)) else {
            continue;
        };
        acc += i64::from(a.x) * i64::from(b.y) - i64::from(b.x) * i64::from(a.y);
    }
    acc
}

/// Twice the signed area of an `i_overlay` contour.
pub(crate) fn area2_int(poly: &[i_overlay::i_float::int::point::IntPoint<i32>]) -> i64 {
    let n = poly.len();
    let mut acc = 0i64;
    for i in 0..n {
        let (Some(a), Some(b)) = (poly.get(i), poly.get((i + 1) % n)) else {
            continue;
        };
        acc += i64::from(a.x) * i64::from(b.y) - i64::from(b.x) * i64::from(a.y);
    }
    acc
}
