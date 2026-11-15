// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The base of a tree support on the bed, behind `support_bed_foot` (off by default).
//!
//! - The foot: an organic trunk that starts on the bed flares out over its lowest layers. At the bed its
//!   radius is the smallest of 3.75 mm, the trunk radius r plus 1.2 mm, and r plus the trunk height times
//!   tan 12 degrees, where r is the trunk's radius at the blend point. The blend point is as many layers up
//!   as a 12 degree flare needs to cover the extra radius (48 layers at 0.12 mm for the full 1.2 mm), never
//!   past the end of the trunk. Between the bed and the blend point the radius eases back to the trunk's
//!   on a quadratic ease-out, so it falls fastest near the bed and meets the trunk tangentially. Each layer
//!   gets one circle around that layer's trunk center, which is united with the trunk's own slice and
//!   clipped the same way. Branch radii for planning and collisions are left as they are: the foot only
//!   adds to the printed layers.
//! - The first layer's growth: the first support layer grows by `raft_first_layer_expansion` (a negative
//!   value is 2 mm, 0 is none) in equal steps of at most one first-layer line width, at least 5 of them,
//!   and after every step the part's first layer grown by `support_object_first_layer_gap` is cut away
//!   again, so the growth never leaks through a thin wall or wraps around the part.

use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

/// The largest foot radius at the bed, mm.
const CAP_RADIUS: f64 = 3.75;
/// The most a foot adds to the trunk radius at the bed, mm.
const EXTRA: f64 = 1.2;
/// The mean slope of the flare from vertical, degrees.
const SLOPE_DEG: f64 = 12.0;
/// The growth a negative `raft_first_layer_expansion` stands for, mm.
pub(crate) const AUTO_FIRST_LAYER_EXPANSION: f64 = 2.0;

/// True when `support_bed_foot` turns the foot and the first-layer growth of this module on.
pub(crate) fn enabled(cfg: &PrintConfig) -> bool {
    crate::firmware::truthy(cfg, "support_bed_foot")
}

/// `raft_first_layer_expansion` as a growth distance: a negative value is 2 mm, 0 or a positive value is
/// itself, mm.
pub(crate) fn first_layer_expansion(value: f64) -> f64 {
    if value < 0.0 {
        AUTO_FIRST_LAYER_EXPANSION
    } else {
        value
    }
}

/// A circle on one layer, in mm.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Circle {
    pub(crate) center: [f64; 2],
    pub(crate) radius: f64,
}

/// The foot of a trunk standing on the bed. `trunk` holds the trunk's center and radius on each layer from
/// the bed layer up, one entry per layer, as far as the trunk goes without a fork; `layer_height` is the
/// layer height above the first layer, mm. The result has one circle per layer from the bed layer to the
/// blend point (the last one is the trunk itself there), or nothing when the trunk needs no foot.
pub(crate) fn foot(trunk: &[Circle], layer_height: f64) -> Vec<Circle> {
    let Some(root) = trunk.first() else {
        return Vec::new();
    };
    if layer_height <= 0.0 || root.radius >= CAP_RADIUS {
        return Vec::new();
    }
    let per_layer = SLOPE_DEG.to_radians().m_tan() * layer_height;
    let flare = EXTRA.min(CAP_RADIUS - root.radius);
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a layer count of a few dozen"
    )]
    let wanted = (flare / per_layer - 1e-9).ceil().max(0.0) as usize;
    let layers = wanted.min(trunk.len() - 1);
    if layers == 0 {
        return Vec::new();
    }
    let Some(blend) = trunk.get(layers).map(|c| c.radius) else {
        return Vec::new();
    };
    #[allow(clippy::cast_precision_loss, reason = "a layer count of a few dozen")]
    let height = layers as f64;
    let plate = CAP_RADIUS.min(blend + EXTRA).min(blend + height * per_layer);
    if plate <= root.radius || plate <= blend {
        return Vec::new();
    }
    trunk
        .iter()
        .take(layers + 1)
        .enumerate()
        .map(|(k, c)| {
            #[allow(clippy::cast_precision_loss, reason = "a layer count of a few dozen")]
            let t = k as f64 / height;
            let eased = 1.0 - (1.0 - t) * (1.0 - t);
            Circle {
                center: c.center,
                radius: plate + eased * (blend - plate),
            }
        })
        .collect()
}

/// A circle as a ring in plate units, its corners on the circle with at most `tolerance` mm between the
/// circle and an edge, a multiple of 4 of them so the X and Y extremes are corners.
pub(crate) fn ring(c: &Circle, tolerance: f64) -> Vec<IntPoint<i32>> {
    let r = c.radius.max(1e-6);
    let step = 2.0 * (1.0 - (tolerance / r).min(1.0)).m_acos();
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a few hundred corners at most"
    )]
    let n = ((std::f64::consts::TAU / step.max(1e-3) / 4.0).ceil() as usize).clamp(2, 1024) * 4;
    (0..n)
        .map(|i| {
            #[allow(clippy::cast_precision_loss, reason = "a few hundred corners")]
            let a = std::f64::consts::TAU * i as f64 / n as f64;
            let (s, co) = a.m_sin_cos();
            IntPoint::new(
                crate::geom::mm(c.center[0] + r * co),
                crate::geom::mm(c.center[1] + r * s),
            )
        })
        .collect()
}

/// The first support layer grown by `distance` mm, in equal steps no wider than `line_width` and at least 5 of
/// them, with `keep_out` cut away after each step. Without growth the area is only cut by `keep_out`.
pub(crate) fn grow_first_layer(area: &Shapes, keep_out: &Shapes, distance: f64, line_width: f64) -> Shapes {
    if area.is_empty() {
        return Vec::new();
    }
    if distance <= 1e-4 {
        return perimeters::difference(area, keep_out);
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a handful of steps"
    )]
    let steps = ((distance / line_width.max(0.05)).ceil() as u32).max(5);
    let step = crate::geom::mm(distance / f64::from(steps));
    let mut out = area.clone();
    for _ in 0..steps {
        out = perimeters::difference(&perimeters::offset(&out, step), keep_out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same(a: [f64; 2], b: [f64; 2]) -> bool {
        (a[0] - b[0]).abs() < 1e-12 && (a[1] - b[1]).abs() < 1e-12
    }

    fn trunk(radius: f64, layers: usize) -> Vec<Circle> {
        (0..layers)
            .map(|_| Circle {
                center: [10.0, 20.0],
                radius,
            })
            .collect()
    }

    #[test]
    fn a_tall_trunk_gets_the_full_flare_eased_out_over_48_layers() {
        let f = foot(&trunk(1.5, 200), 0.12);
        assert_eq!(f.len(), 49, "bed layer to the blend point, 48 layers up");
        assert!((f[0].radius - 2.7).abs() < 1e-9);
        for (k, past) in [(1, 1.15), (2, 1.10), (3, 1.05), (4, 1.00)] {
            assert!(
                (f[k].radius - 1.5 - past).abs() < 0.01,
                "layer {k}: {}",
                f[k].radius
            );
        }
        assert!(
            (f[48].radius - 1.5).abs() < 1e-9,
            "meets the trunk at the blend point"
        );
        assert!(f.windows(2).all(|w| w[1].radius <= w[0].radius));
        assert!(f.iter().all(|c| same(c.center, [10.0, 20.0])));
    }

    #[test]
    fn the_foot_never_passes_3_75_mm() {
        let f = foot(&trunk(3.0, 200), 0.12);
        assert!((f[0].radius - 3.75).abs() < 1e-9);
        // 0.75 mm of flare at 0.0255 mm per layer: 30 layers.
        assert_eq!(f.len(), 31);
        assert!(foot(&trunk(3.75, 200), 0.12).is_empty());
        assert!(foot(&trunk(4.0, 200), 0.12).is_empty());
    }

    #[test]
    fn a_short_trunk_gets_a_smaller_flare_not_a_steeper_one() {
        // 10 layers above the bed: 10 x 0.12 x tan 12 degrees.
        let f = foot(&trunk(1.0, 11), 0.12);
        assert_eq!(f.len(), 11);
        let want = 1.0 + 10.0 * 0.12 * 12f64.to_radians().m_tan();
        assert!((f[0].radius - want).abs() < 1e-9, "{}", f[0].radius);
        assert!(foot(&trunk(1.0, 1), 0.12).is_empty(), "no layer above the bed");
    }

    #[test]
    fn a_foot_follows_a_leaning_trunk() {
        let t: Vec<Circle> = (0..60)
            .map(|k| Circle {
                center: [f64::from(k) * 0.05, 0.0],
                radius: 1.2,
            })
            .collect();
        let f = foot(&t, 0.12);
        assert!(f.iter().zip(&t).all(|(a, b)| same(a.center, b.center)));
    }

    #[test]
    fn negative_expansion_is_two_millimeters() {
        assert!((first_layer_expansion(-1.0) - 2.0).abs() < 1e-12);
        assert!((first_layer_expansion(-0.3) - 2.0).abs() < 1e-12);
        assert!(first_layer_expansion(0.0).abs() < 1e-12);
        assert!((first_layer_expansion(1.5) - 1.5).abs() < 1e-12);
    }

    #[test]
    fn a_ring_keeps_its_extremes_on_the_circle() {
        let r = ring(
            &Circle {
                center: [5.0, 5.0],
                radius: 2.0,
            },
            0.005,
        );
        assert_eq!(r.len() % 4, 0);
        let ys: Vec<i32> = r.iter().map(|p| p.y).collect();
        assert_eq!(ys.iter().max().copied(), Some(crate::geom::mm(7.0)));
        assert_eq!(ys.iter().min().copied(), Some(crate::geom::mm(3.0)));
    }

    #[test]
    fn the_first_layer_grows_in_steps_around_a_keep_out() {
        let sq = |x0: f64, y0: f64, x1: f64, y1: f64| -> Shapes {
            vec![vec![vec![
                IntPoint::new(crate::geom::mm(x0), crate::geom::mm(y0)),
                IntPoint::new(crate::geom::mm(x1), crate::geom::mm(y0)),
                IntPoint::new(crate::geom::mm(x1), crate::geom::mm(y1)),
                IntPoint::new(crate::geom::mm(x0), crate::geom::mm(y1)),
            ]]]
        };
        let area = sq(0.0, 0.0, 2.0, 2.0);
        // A thin wall to the right, 0.2 mm from the area: the growth must not reach past it.
        let wall = sq(2.2, -10.0, 2.6, 10.0);
        let out = grow_first_layer(&area, &wall, 2.0, 0.5);
        let b = perimeters::bounds(&out).expect("an area");
        assert!(f64::from(b[2]) <= f64::from(crate::geom::mm(2.2)) + 1.0, "{b:?}");
        assert!(
            (f64::from(b[0]) - f64::from(crate::geom::mm(-2.0))).abs() < 20.0,
            "{b:?}"
        );
        assert_eq!(
            grow_first_layer(&area, &Vec::new(), 0.0, 0.5),
            perimeters::difference(&area, &Vec::new())
        );
    }
}
