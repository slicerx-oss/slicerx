// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The influence areas of organic trees and their state, as Orca's `SupportElement` and `SupportElementState`
//! (Support/TreeSupport3D.hpp): one element per branch and layer, with the area its center may take, links to
//! the elements it holds up on the layer above, and the point it is finally drawn at.

#![allow(
    clippy::struct_excessive_bools,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Orca's state bits, and distances to the top as layer counts"
)]

use super::geo::Pt;
use super::settings::Settings;
use super::volumes::AvoidanceType;
use crate::perimeters::Shapes;

/// How an influence area was grown to the layer below (`AreaIncreaseSettings`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AreaIncrease {
    pub(crate) t: AvoidanceType,
    pub(crate) increase_speed: i64,
    pub(crate) increase_radius: bool,
    pub(crate) no_error: bool,
    pub(crate) use_min_distance: bool,
    pub(crate) mv: bool,
}

impl Default for AreaIncrease {
    fn default() -> Self {
        Self {
            t: AvoidanceType::Fast,
            increase_speed: 0,
            increase_radius: false,
            no_error: false,
            use_min_distance: false,
            mv: false,
        }
    }
}

/// Where a tip point can still go (`LineStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineStatus {
    Invalid,
    ToModel,
    ToModelGracious,
    ToModelGraciousSafe,
    ToBp,
    ToBpSafe,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct State {
    pub(crate) to_buildplate: bool,
    pub(crate) to_model_gracious: bool,
    pub(crate) use_min_xy_dist: bool,
    pub(crate) supports_roof: bool,
    pub(crate) can_use_safe_radius: bool,
    pub(crate) skip_ovalisation: bool,
    pub(crate) lost: bool,
    pub(crate) verylost: bool,
    pub(crate) deleted: bool,
    pub(crate) marked: bool,
    pub(crate) target_height: i64,
    pub(crate) target_position: Pt,
    pub(crate) next_position: Pt,
    pub(crate) layer_idx: i64,
    pub(crate) effective_radius_height: u32,
    pub(crate) distance_to_top: u32,
    pub(crate) result_on_layer: Option<Pt>,
    pub(crate) increased_to_model_radius: i64,
    pub(crate) elephant_foot_increases: f64,
    pub(crate) dont_move_until: u32,
    pub(crate) last_area_increase: AreaIncrease,
    pub(crate) missing_roof_layers: u32,
    pub(crate) roof_recovery_dtt: u32,
}

impl State {
    pub(crate) fn set_pending_roof_recovery(&mut self, pending: u32, depth: u32) {
        self.missing_roof_layers = pending;
        self.roof_recovery_dtt = if pending > 0 { depth } else { 0 };
    }

    pub(crate) fn has_pending_roof_recovery(&self) -> bool {
        self.missing_roof_layers > 0
    }

    /// `propagate_down`: the same element one layer lower.
    pub(crate) fn propagate_down(&self) -> Self {
        let mut d = self.clone();
        d.distance_to_top += 1;
        d.layer_idx -= 1;
        if d.has_pending_roof_recovery() {
            d.missing_roof_layers -= 1;
            d.roof_recovery_dtt += 1;
        }
        d.result_on_layer = None;
        d.skip_ovalisation = false;
        d
    }
}

/// One influence area (`SupportElement`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Element {
    pub(crate) state: State,
    /// Indices of the elements on the layer above this one holds up.
    pub(crate) parents: Vec<i32>,
    pub(crate) influence_area: Shapes,
}

/// `getEffectiveDTT`.
pub(crate) fn effective_dtt(cfg: &Settings, s: &State) -> usize {
    let until = cfg.increase_radius_until_layer;
    if (s.effective_radius_height as usize) < until {
        (s.distance_to_top as usize).min(until)
    } else {
        s.effective_radius_height as usize
    }
}

/// `support_element_radius`.
pub(crate) fn radius(cfg: &Settings, s: &State) -> i64 {
    cfg.get_radius(effective_dtt(cfg, s), s.elephant_foot_increases)
}

/// `support_element_collision_radius`.
pub(crate) fn collision_radius(cfg: &Settings, s: &State) -> i64 {
    cfg.get_radius(s.effective_radius_height as usize, s.elephant_foot_increases)
}
