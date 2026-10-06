// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The settings of organic trees, as Orca derives them (`TreeSupportMeshGroupSettings` and `TreeSupportSettings`
//! in Support/TreeSupportCommon.hpp). Lengths are plate units (`crate::geom::SCALE` per mm), truncated from
//! millimeters the way Orca's `scaled<coord_t>()` does.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    reason = "plate units in i64 from millimeters, and layer counts"
)]

use super::geo::sc;
use crate::fm::Fm as _;

/// The finest outline detail the branch planner keeps, mm.
const MIN_RESOLUTION: f64 = 0.025;

/// What the organic planner reads from the print settings, in millimeters and degrees.
#[derive(Debug, Clone)]
pub(crate) struct Raw {
    pub(crate) layer_height: f64,
    pub(crate) resolution: f64,
    /// `min_feature_size` in millimeters (its percent of the nozzle).
    pub(crate) min_feature_size: f64,
    pub(crate) support_line_width: f64,
    pub(crate) interface_line_width: f64,
    pub(crate) external_perimeter_width: f64,
    pub(crate) top_layers: u32,
    pub(crate) bottom_layers: u32,
    pub(crate) on_bed_only: bool,
    pub(crate) xy_distance: f64,
    /// Orca's `gap_support_object` and `gap_object_support` (the top and bottom Z distances, rounded to layers).
    pub(crate) top_distance: f64,
    pub(crate) bottom_distance: f64,
    pub(crate) top_z_gap: f64,
    pub(crate) interface_spacing: f64,
    pub(crate) branch_distance: f64,
    pub(crate) branch_angle: f64,
    pub(crate) angle_slow: f64,
    pub(crate) branch_diameter: f64,
    pub(crate) branch_diameter_angle: f64,
    pub(crate) top_rate: f64,
    pub(crate) tip_diameter: f64,
}

/// `TreeSupportMeshGroupSettings` and `TreeSupportSettings` together.
#[derive(Debug, Clone)]
pub(crate) struct Settings {
    pub(crate) layer_height: i64,
    pub(crate) resolution: i64,
    pub(crate) min_feature_size: i64,
    pub(crate) support_line_width: i64,
    pub(crate) support_material_buildplate_only: bool,
    pub(crate) support_top_distance: i64,
    pub(crate) support_bottom_distance: i64,
    pub(crate) support_roof_layers: usize,
    pub(crate) support_floor_layers: usize,
    pub(crate) support_roof_line_distance: i64,
    pub(crate) support_tree_branch_distance: i64,
    pub(crate) support_tree_top_rate: f64,
    pub(crate) minimum_roof_area: f64,
    pub(crate) minimum_support_area: f64,
    pub(crate) support_offset: i64,

    pub(crate) branch_radius: i64,
    pub(crate) min_radius: i64,
    pub(crate) maximum_move_distance: i64,
    pub(crate) maximum_move_distance_slow: i64,
    pub(crate) tip_layers: usize,
    pub(crate) branch_radius_increase_per_layer: f64,
    pub(crate) max_to_model_radius_increase: i64,
    pub(crate) min_dtt_to_model: usize,
    pub(crate) increase_radius_until_radius: i64,
    pub(crate) increase_radius_until_layer: usize,
    pub(crate) support_rests_on_model: bool,
    pub(crate) xy_distance: i64,
    pub(crate) xy_min_distance: i64,
    pub(crate) layer_start_bp_radius: i64,
    pub(crate) bp_radius_increase_per_layer: f64,
    pub(crate) z_distance_top_layers: usize,
    pub(crate) z_distance_bottom_layers: usize,
}

fn round_up_divide(x: i64, y: i64) -> i64 {
    (x + y - 1) / y
}

impl Settings {
    pub(crate) fn new(r: &Raw) -> Self {
        let eps = 1e-4;
        let layer_height = sc(r.layer_height);
        let support_line_width = sc(r.support_line_width);
        let support_roof_line_width = sc(r.interface_line_width);
        let support_xy_distance = sc(r.xy_distance);
        let support_xy_distance_overhang = support_xy_distance.min(sc(0.5 * r.external_perimeter_width));
        let branch_diameter = sc(r.branch_diameter);
        let tree_angle = r
            .branch_angle
            .to_radians()
            .clamp(0.0, 0.5 * std::f64::consts::PI - eps);
        // At a branch angle of 0 the slow angle's range would end below 0, which `clamp` refuses.
        let tree_angle_slow = r.angle_slow.to_radians().clamp(0.0, (tree_angle - eps).max(0.0));
        let diameter_angle = r
            .branch_diameter_angle
            .to_radians()
            .clamp(0.0, 0.5 * std::f64::consts::PI - eps);
        let tip_diameter = sc(r.tip_diameter).clamp(0, branch_diameter);
        // Orca's fixed mesh group values.
        let bp_diameter = sc(7.5);
        let max_diameter_increase_to_model = sc(1.0);
        let min_height_to_model = sc(1.0);

        let branch_radius = branch_diameter / 2;
        let min_radius = tip_diameter / 2;
        let maximum_move_distance = (tree_angle.m_tan() * layer_height as f64) as i64;
        let maximum_move_distance_slow = (tree_angle_slow.m_tan() * layer_height as f64) as i64;
        let tip_layers = ((branch_radius - min_radius) / (support_line_width / 3))
            .max(branch_radius / layer_height)
            .max(1) as usize;
        let branch_radius_increase_per_layer = diameter_angle.m_tan() * layer_height as f64;
        let increase_radius_until_radius = branch_diameter / 2;
        let increase_radius_until_layer = if increase_radius_until_radius <= branch_radius {
            (tip_layers as i64 * (increase_radius_until_radius / branch_radius.max(1))) as usize
        } else {
            ((increase_radius_until_radius - branch_radius) as f64 / branch_radius_increase_per_layer)
                as usize
        };
        let mut xy_distance = support_xy_distance;
        let mut xy_min_distance = support_xy_distance.min(support_xy_distance_overhang);
        let bp_radius = bp_diameter / 2;
        let bp_radius_increase_per_layer =
            (0.7_f64.m_tan() * layer_height as f64).min(0.5 * support_line_width as f64);
        let top_distance = sc(r.top_distance);
        let bottom_distance = sc(r.bottom_distance);
        let z_distance_bottom_layers = (bottom_distance as f64 / layer_height as f64).round() as usize;
        let z_distance_top_layers = (top_distance as f64 / layer_height as f64).round() as usize;
        let layer_start_bp_radius =
            ((bp_radius - branch_radius) as f64 / bp_radius_increase_per_layer) as i64;
        // `TreeSupportSettings::zero_top_z_gap`, set when the top Z distance is zero.
        if r.top_z_gap < eps {
            xy_min_distance = xy_min_distance.max(sc(0.1));
            xy_distance = xy_distance.max(xy_min_distance);
        }
        Self {
            layer_height,
            // Orca hands the trees the print's resolution (0.012 mm in the stock profiles). Branch areas are
            // planned for lines 0.4 mm wide, and every boolean of the planner costs by its outline points, so
            // they are simplified to at least 0.025 mm, the default of the tree code's own settings
            // (`TreeSupportMeshGroupSettings::resolution`).
            resolution: sc(r.resolution.max(MIN_RESOLUTION)),
            // Orca's tree code reads the percent as millimeters (25 % becomes 25 mm), which turns the safe
            // movement step into 25 mm; the setting's own meaning is used here.
            min_feature_size: sc(r.min_feature_size),
            support_line_width,
            support_material_buildplate_only: r.on_bed_only,
            support_top_distance: top_distance,
            support_bottom_distance: bottom_distance,
            support_roof_layers: r.top_layers as usize,
            support_floor_layers: r.bottom_layers as usize,
            support_roof_line_distance: sc(r.interface_spacing) + support_roof_line_width,
            support_tree_branch_distance: sc(r.branch_distance),
            support_tree_top_rate: r.top_rate,
            minimum_roof_area: sc(1.0) as f64 * sc(1.0) as f64,
            minimum_support_area: 0.0,
            support_offset: 0,
            branch_radius,
            min_radius,
            maximum_move_distance,
            maximum_move_distance_slow,
            tip_layers,
            branch_radius_increase_per_layer,
            max_to_model_radius_increase: max_diameter_increase_to_model / 2,
            min_dtt_to_model: round_up_divide(min_height_to_model, layer_height).max(0) as usize,
            increase_radius_until_radius,
            increase_radius_until_layer,
            support_rests_on_model: !r.on_bed_only,
            xy_distance,
            xy_min_distance,
            layer_start_bp_radius,
            bp_radius_increase_per_layer,
            z_distance_top_layers,
            z_distance_bottom_layers,
        }
    }

    /// `getRadius`: the radius of an element `distance_to_top` layers under its tip.
    pub(crate) fn get_radius(&self, distance_to_top: usize, elephant_foot_increases: f64) -> i64 {
        let base = if distance_to_top <= self.tip_layers {
            (self.min_radius
                + (self.branch_radius - self.min_radius) * distance_to_top as i64 / self.tip_layers as i64)
                as f64
        } else {
            self.branch_radius as f64
                + (distance_to_top - self.tip_layers) as f64 * self.branch_radius_increase_per_layer
        };
        (base
            + elephant_foot_increases
                * (self.bp_radius_increase_per_layer - self.branch_radius_increase_per_layer).max(0.0))
            as i64
    }

    /// `recommendedMinRadius`: the radius an element should reach on `layer_idx` to end in the bed foot.
    pub(crate) fn recommended_min_radius(&self, layer_idx: i64) -> i64 {
        let widened = (self.layer_start_bp_radius - layer_idx) as f64;
        if widened > 0.0 {
            (self.branch_radius as f64 + widened * self.bp_radius_increase_per_layer) as i64
        } else {
            0
        }
    }
}
