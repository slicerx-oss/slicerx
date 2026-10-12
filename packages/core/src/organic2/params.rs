// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Settings of organic trees and the values derived from them: gaps, per-layer movement, the radius a
//! branch has at each depth below its tip, and the grid of radii the model volumes are cached at.

use crate::fm::Fm as _;
use crate::geom::SCALE;

/// Behaviors of the reference slicer that come from bugs (spec 1.5). Each flag off does what the
/// reference meant; on reproduces the reference's output for parity runs. Parity mode turns them all on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools, reason = "one switch per behavior")]
pub(crate) struct Quirks {
    /// Q1: push a colliding branch center by the square of the nudge distance instead of the distance.
    pub(crate) nudge_squared: bool,
    /// Q2: lay the lines roof tips are sampled from at a fixed -45 degrees instead of turning them by
    /// 45 degrees either side of the interface angle from layer to layer.
    pub(crate) roof_angle_fixed: bool,
    /// Q3: let branches plan past the bed edge (they are clipped to the bed at the end) instead of
    /// treating the bed edge as a wall.
    pub(crate) ignore_bed_edge: bool,
    /// Q4: merge branches on every layer instead of at the cadence with backoff. On by default until the
    /// cadence is shown not to make trees worse.
    pub(crate) merge_every_layer: bool,
    /// Q5: an overhang cluster keeps one part per layer, so a second part on the same layer is lost.
    pub(crate) one_part_per_cluster_layer: bool,
    /// Q6: a layer with over 100 overhang parts turns off tail growth and small-overhang removal.
    pub(crate) detection_guard: bool,
    /// Q7: the foot speed bonus is given when the recommended radius below is smaller than the next
    /// radius (as the reference writes it) instead of larger. On by default until its decision test.
    pub(crate) foot_bonus_inverted: bool,
    /// Q8: placeable areas of a full-gap query shrink by the extra XY gap twice. On by default until its
    /// decision test.
    pub(crate) placeable_double_gap: bool,
    /// Parity mode only: sharp-tail heights are summed in single precision, so a sum meant to be a
    /// whole millimeter can fall just short and skip its turn.
    pub(crate) single_precision_tails: bool,
}

impl Default for Quirks {
    fn default() -> Self {
        Self {
            nudge_squared: false,
            roof_angle_fixed: false,
            ignore_bed_edge: false,
            merge_every_layer: true,
            one_part_per_cluster_layer: false,
            detection_guard: false,
            foot_bonus_inverted: true,
            placeable_double_gap: true,
            single_precision_tails: false,
        }
    }
}

impl Quirks {
    /// Every flag on: the reference's output.
    pub(crate) const PARITY: Self = Self {
        nudge_squared: true,
        roof_angle_fixed: true,
        ignore_bed_edge: true,
        merge_every_layer: true,
        one_part_per_cluster_layer: true,
        detection_guard: true,
        foot_bonus_inverted: true,
        placeable_double_gap: true,
        single_precision_tails: true,
    };

    /// Every flag off: the intended behaviors.
    pub(crate) const NONE: Self = Self {
        nudge_squared: false,
        roof_angle_fixed: false,
        ignore_bed_edge: false,
        merge_every_layer: false,
        one_part_per_cluster_layer: false,
        detection_guard: false,
        foot_bonus_inverted: false,
        placeable_double_gap: false,
        single_precision_tails: false,
    };

    /// Reads `organic_quirks`: a comma list starting from the defaults. `parity` turns every flag on,
    /// `none` every flag off; a flag name turns it on and the name with a leading `-` turns it off.
    pub(crate) fn parse(text: &str) -> Self {
        let mut q = Self::default();
        for word in text.split(',').map(str::trim).filter(|w| !w.is_empty()) {
            let (on, name) = match word.strip_prefix('-') {
                Some(rest) => (false, rest),
                None => (true, word),
            };
            match name {
                "parity" => q = if on { Self::PARITY } else { Self::default() },
                "none" => q = Self::NONE,
                "nudge_squared" => q.nudge_squared = on,
                "roof_angle_fixed" => q.roof_angle_fixed = on,
                "ignore_bed_edge" => q.ignore_bed_edge = on,
                "merge_every_layer" => q.merge_every_layer = on,
                "one_part_per_cluster_layer" => q.one_part_per_cluster_layer = on,
                "detection_guard" => q.detection_guard = on,
                "foot_bonus_inverted" => q.foot_bonus_inverted = on,
                "placeable_double_gap" => q.placeable_double_gap = on,
                "single_precision_tails" => q.single_precision_tails = on,
                _ => {}
            }
        }
        q
    }
}

/// The settings organic trees read, in millimeters and degrees as the profile gives them.
#[derive(Debug, Clone)]
#[allow(clippy::struct_excessive_bools, reason = "one field per boolean setting")]
pub(crate) struct Settings {
    pub(crate) layer_height: f64,
    /// `line_width`: the opening of the overhang detector.
    pub(crate) line_width: f64,
    /// The support line width.
    pub(crate) support_width: f64,
    /// The widest outer wall of any region.
    pub(crate) external_perimeter_width: f64,
    pub(crate) resolution: f64,
    pub(crate) min_feature_size: f64,
    pub(crate) branch_angle: f64,
    pub(crate) angle_slow: f64,
    pub(crate) branch_diameter: f64,
    pub(crate) branch_diameter_angle: f64,
    pub(crate) tip_diameter: f64,
    /// Percent.
    pub(crate) top_rate: f64,
    pub(crate) branch_distance: f64,
    pub(crate) xy_distance: f64,
    /// The Z gaps as used (already rounded to whole layers, or 0 with a zero gap interface).
    pub(crate) top_distance: f64,
    pub(crate) bottom_distance: f64,
    pub(crate) top_layers: u32,
    pub(crate) bottom_layers: u32,
    pub(crate) on_bed_only: bool,
    pub(crate) threshold_angle: f64,
    pub(crate) support_angle: f64,
    /// Distance between interface lines (`support_interface_spacing`).
    pub(crate) interface_spacing: f64,
    /// The top contact touches the part (zero top Z gap with interface layers).
    pub(crate) zero_top_gap: bool,
    pub(crate) raft_layers: usize,
    pub(crate) raft_expansion: f64,
    pub(crate) quirks: Quirks,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            layer_height: 0.2,
            line_width: 0.42,
            support_width: 0.4,
            external_perimeter_width: 0.42,
            resolution: 0.012,
            min_feature_size: 0.1,
            branch_angle: 40.0,
            angle_slow: 25.0,
            branch_diameter: 2.0,
            branch_diameter_angle: 5.0,
            tip_diameter: 0.8,
            top_rate: 30.0,
            branch_distance: 1.0,
            xy_distance: 0.35,
            top_distance: 0.2,
            bottom_distance: 0.2,
            top_layers: 3,
            bottom_layers: 0,
            on_bed_only: false,
            threshold_angle: 30.0,
            support_angle: 0.0,
            interface_spacing: 0.5,
            zero_top_gap: false,
            raft_layers: 0,
            raft_expansion: 1.5,
            quirks: Quirks::default(),
        }
    }
}

/// A rounding allowance: one internal unit, in millimeters.
pub(crate) const HAIR: f64 = 1.0 / SCALE;
/// The trunk radius bed widening aims for.
pub(crate) const BED_RADIUS: f64 = 3.75;
/// How much a model-resting branch may widen in all to merge with one that reaches the bed.
pub(crate) const MODEL_MERGE_ALLOWANCE: f64 = 0.5;
/// The least height of a branch that rests on the model.
pub(crate) const MODEL_MIN_HEIGHT: f64 = 1.0;
/// Roof parts under this area (mm^2) are not roofs.
pub(crate) const MIN_ROOF_AREA: f64 = 1.0;
/// The cached radii grow by this factor past the first steps.
const GRID_FACTOR: f64 = 1.5;
/// The first cached radius past the tip radius.
const GRID_FIRST: f64 = 1.5;

/// The values derived from [`Settings`] (spec section 1.2), all in millimeters unless named otherwise.
#[derive(Debug, Clone)]
pub(crate) struct Params {
    pub(crate) s: Settings,
    pub(crate) h: f64,
    /// Support line width.
    pub(crate) w: f64,
    pub(crate) r_branch: f64,
    pub(crate) r_tip: f64,
    /// Z gaps in layers.
    pub(crate) z_top: usize,
    pub(crate) z_bot: usize,
    pub(crate) gap_xy: f64,
    pub(crate) gap_min: f64,
    pub(crate) delta_xy: f64,
    pub(crate) m_fast: f64,
    pub(crate) m_slow: f64,
    /// Tip layers.
    pub(crate) tip_layers: usize,
    /// Widening per layer past the tip layers.
    pub(crate) widen: f64,
    /// Bed widening per layer.
    pub(crate) widen_bed: f64,
    /// The layer under which bed widening starts.
    pub(crate) bed_layer: usize,
    pub(crate) r_until: f64,
    pub(crate) until_depth: f64,
    pub(crate) model_min_layers: usize,
    pub(crate) model_rest: bool,
    /// The cached radii, ascending, starting at 0.
    pub(crate) grid: Vec<f64>,
}

fn clamp_angle(deg: f64, hi: f64) -> f64 {
    deg.clamp(0.0, hi).to_radians()
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "layer counts of a few thousand"
)]
fn layers(v: f64) -> usize {
    v.max(0.0) as usize
}

impl Params {
    pub(crate) fn new(s: Settings) -> Self {
        let h = s.layer_height.max(0.01);
        let w = s.support_width.max(0.05);
        let r_branch = (s.branch_diameter / 2.0).max(0.05);
        let r_tip = (s.tip_diameter.clamp(0.0, s.branch_diameter) / 2.0).max(0.0);
        let a_fast = clamp_angle(s.branch_angle, 89.999);
        let a_slow = clamp_angle(s.angle_slow, s.branch_angle.clamp(0.0, 89.999)).min(a_fast);
        let a_widen = clamp_angle(s.branch_diameter_angle, 89.999);
        let z_top = layers((s.top_distance / h).round());
        let z_bot = layers((s.bottom_distance / h).round());
        let g_ovh = s.xy_distance.min(s.external_perimeter_width / 2.0);
        let mut gap_min = s.xy_distance.min(g_ovh);
        let mut gap_xy = s.xy_distance;
        if s.top_distance <= 0.0 {
            gap_min = gap_min.max(0.1);
            gap_xy = gap_xy.max(0.1);
        }
        let delta_xy = (gap_xy - gap_min).max(0.0);
        let m_fast = a_fast.m_tan() * h;
        let m_slow = a_slow.m_tan() * h;
        // Integer units, as the tip layer count is a count of whole steps.
        let tip_layers = layers(((r_branch - r_tip) * SCALE).floor() / (w / 3.0 * SCALE).floor().max(1.0))
            .max(layers((r_branch * SCALE / (h * SCALE)).floor()))
            .max(1);
        let widen = a_widen.m_tan() * h;
        let widen_bed = (0.7f64.m_tan() * h).min(0.5 * w);
        let bed_layer = if widen_bed > 0.0 {
            layers(((BED_RADIUS - r_branch) / widen_bed).floor())
        } else {
            0
        };
        let r_until = r_branch;
        #[allow(clippy::cast_precision_loss, reason = "a small layer count")]
        let until_depth = if r_until <= r_branch {
            tip_layers as f64 * (r_until / r_branch)
        } else {
            (r_until - r_branch) / widen.max(1e-9)
        };
        let model_min_layers = layers((MODEL_MIN_HEIGHT / h).ceil());
        let model_rest = !s.on_bed_only;
        let mut p = Self {
            s,
            h,
            w,
            r_branch,
            r_tip,
            z_top,
            z_bot,
            gap_xy,
            gap_min,
            delta_xy,
            m_fast,
            m_slow,
            tip_layers,
            widen,
            widen_bed,
            bed_layer,
            r_until,
            until_depth,
            model_min_layers,
            model_rest,
            grid: Vec::new(),
        };
        p.grid = p.make_grid(r_branch + 4.0 * BED_RADIUS + 10.0);
        p
    }

    /// The radius at depth `x` below the tip with `f` bed-widening steps (spec 1.3).
    #[allow(clippy::cast_precision_loss, reason = "a small layer count")]
    pub(crate) fn radius(&self, x: f64, f: f64) -> f64 {
        let t = self.tip_layers as f64;
        let base = if x <= t {
            self.r_tip + (self.r_branch - self.r_tip) * x / t
        } else {
            self.r_branch + (x - t) * self.widen
        };
        base + f * (self.widen_bed - self.widen).max(0.0)
    }

    /// The radius a node is drawn with: depth `d`, effective depth `e`, widening `f`.
    pub(crate) fn drawn_radius(&self, d: f64, e: f64, f: f64) -> f64 {
        let x = if e < self.until_depth {
            d.min(self.until_depth)
        } else {
            e
        };
        self.radius(x, f)
    }

    /// The radius a node collides with.
    pub(crate) fn collision_radius(&self, e: f64, f: f64) -> f64 {
        self.radius(e, f)
    }

    /// The radius bed widening asks for at `layer`, 0 above the widening zone.
    #[allow(clippy::cast_precision_loss, reason = "a small layer count")]
    pub(crate) fn recommended_min_radius(&self, layer: usize) -> f64 {
        if layer < self.bed_layer {
            self.r_branch + (self.bed_layer - layer) as f64 * self.widen_bed
        } else {
            0.0
        }
    }

    /// The cached radii up to `max` (spec 1.4): 0, the tip radius, even steps up to 1.5 (or one step of
    /// 0.5 when the tip is already close to it), then a factor of 1.5 at a time.
    fn make_grid(&self, max: f64) -> Vec<f64> {
        let mut g = vec![0.0];
        let r0 = self.r_tip.max(HAIR);
        g.push(r0);
        let mut r = r0;
        if GRID_FIRST - r0 > 0.5 {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a step count of one or two"
            )]
            let n = ((GRID_FIRST - r0) / GRID_FIRST).ceil().max(1.0) as u32;
            let step = (GRID_FIRST - r0) / f64::from(n);
            for _ in 0..n {
                r += step;
                g.push(r);
            }
        } else {
            r += 0.5;
            g.push(r);
        }
        while r < max {
            r *= GRID_FACTOR;
            g.push(r);
        }
        g
    }

    /// `r` rounded up to the cached grid (0 stays 0).
    pub(crate) fn quantize(&self, r: f64) -> f64 {
        if r <= 0.0 {
            return 0.0;
        }
        self.grid.iter().copied().find(|&g| g + 1e-9 >= r).unwrap_or(r)
    }

    /// The cache radius of a query of radius `r`: in full-gap mode the extra XY gap is added before
    /// rounding (radius 0 then maps to the extra gap itself).
    pub(crate) fn key_radius(&self, r: f64, min_gap: bool) -> f64 {
        if min_gap {
            self.quantize(r)
        } else if r <= 0.0 {
            self.delta_xy
        } else {
            self.quantize(r + self.delta_xy)
        }
    }

    /// The tip connect length: how far apart tips go along sampled lines (spec 4.1).
    pub(crate) fn connect_length(&self) -> f64 {
        let rate = self.s.top_rate.max(1e-3);
        self.w * 100.0 / rate + (2.0 * self.r_tip - self.w).max(0.0)
    }

    /// Minimum-gap mode is in use: the XY gap at overhang edges is smaller than the configured one.
    pub(crate) fn min_gap_active(&self) -> bool {
        self.gap_xy > self.gap_min
    }

    /// The support flow's line spacing.
    pub(crate) fn spacing(&self) -> f64 {
        (self.w - self.h * (1.0 - std::f64::consts::FRAC_PI_4)).max(self.w * 0.5)
    }
}

/// Millimeters to internal units.
pub(crate) fn u(v: f64) -> i32 {
    crate::geom::mm(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> Params {
        Params::new(Settings {
            support_width: 0.4,
            external_perimeter_width: 0.42,
            ..Settings::default()
        })
    }

    #[test]
    fn derived_values_at_defaults() {
        let p = defaults();
        assert!((p.r_branch - 1.0).abs() < 1e-9);
        assert!((p.r_tip - 0.4).abs() < 1e-9);
        assert!((p.m_fast - 0.1678).abs() < 1e-3, "{}", p.m_fast);
        assert!((p.m_slow - 0.0933).abs() < 1e-3, "{}", p.m_slow);
        assert_eq!(p.tip_layers, 5);
        assert!((p.widen - 0.0175).abs() < 1e-3);
        assert!((p.widen_bed - 0.168).abs() < 1e-3);
        assert_eq!(p.bed_layer, 16);
        assert_eq!(p.model_min_layers, 5);
        assert_eq!((p.z_top, p.z_bot), (1, 1));
        assert!((p.gap_min - 0.21).abs() < 1e-9);
        assert!((p.delta_xy - 0.14).abs() < 1e-9);
        assert!((p.connect_length() - 1.7333).abs() < 1e-3);
    }

    #[test]
    fn radius_follows_depth() {
        let p = defaults();
        assert!((p.radius(0.0, 0.0) - 0.4).abs() < 1e-9);
        assert!((p.radius(5.0, 0.0) - 1.0).abs() < 1e-9);
        assert!((p.radius(15.0, 0.0) - (1.0 + 10.0 * p.widen)).abs() < 1e-9);
        assert!(p.radius(15.0, 1.0) > p.radius(15.0, 0.0));
        assert!(p.collision_radius(2.0, 0.0) <= p.drawn_radius(4.0, 2.0, 0.0));
        assert!((p.recommended_min_radius(0) - (1.0 + 16.0 * p.widen_bed)).abs() < 1e-9);
        assert!(p.recommended_min_radius(16).abs() < 1e-12);
    }

    #[test]
    fn grid_rounds_up() {
        let p = defaults();
        assert!(p.quantize(0.0).abs() < 1e-12);
        assert!((p.quantize(0.3) - 0.4).abs() < 1e-9);
        assert!((p.quantize(0.41) - 1.5).abs() < 1e-9);
        assert!((p.quantize(1.6) - 2.25).abs() < 1e-9);
        assert!((p.quantize(2.3) - 3.375).abs() < 1e-9);
        assert!((p.key_radius(0.0, false) - 0.14).abs() < 1e-9);
        assert!((p.key_radius(0.3, false) - 1.5).abs() < 1e-9);
    }

    #[test]
    fn quirks_parse() {
        let d = Quirks::parse("");
        assert_eq!(d, Quirks::default());
        // The merge cadence, foot bonus and placeable gap default to the reference's behavior.
        assert!(d.merge_every_layer && d.foot_bonus_inverted && d.placeable_double_gap);
        assert!(!d.nudge_squared && !d.roof_angle_fixed && !d.ignore_bed_edge);
        assert!(!d.one_part_per_cluster_layer && !d.detection_guard && !d.single_precision_tails);
        assert_eq!(Quirks::parse("parity"), Quirks::PARITY);
        assert_eq!(Quirks::parse("none"), Quirks::NONE);
        let q = Quirks::parse("nudge_squared, ignore_bed_edge, -merge_every_layer");
        assert!(q.nudge_squared && q.ignore_bed_edge && !q.merge_every_layer && !q.roof_angle_fixed);
    }
}
