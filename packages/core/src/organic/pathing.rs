// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Growing the tips of organic trees down to the bed or the model, as Orca's `create_layer_pathing`,
//! `increase_areas_one_layer`, `merge_influence_areas` and `create_nodes_from_area` (Support/TreeSupport3D.cpp):
//!
//! - layer by layer from the top, each influence area grows by the slow branch movement, or the fast one,
//!   less what the branch may not enter; the order of attempts prefers staying slow, safe from holes and on the
//!   way to the bed; areas that can only reach the model rest on it;
//! - areas of a layer sorted into an AABB order are merged pairwise where a branch in their overlap would hold
//!   up both;
//! - from the bed up, every element gets the point it is drawn at, inside its area and as close as possible to
//!   the point below; branches too short to stand on the model are dropped.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::manual_midpoint,
    reason = "ports of Orca's long functions over layer arrays, with plate units in i64 halved by truncation as Orca does"
)]

use super::elements::{self, AreaIncrease, Element, State};
use super::geo::{self, Pt};
use super::settings::Settings;
use super::tips::{safe_offset_inc, safe_union};
use super::volumes::{AvoidanceType, Volumes};
use crate::perimeters::Shapes;

/// Threads Orca splits the first merge round between (`tbb::this_task_arena::max_concurrency()`), fixed so
/// the result does not depend on the machine.
const MERGE_THREADS: usize = 8;

fn round_up_divide(x: i64, y: i64) -> i64 {
    (x + y - 1) / y
}

#[derive(Debug, Clone, Default)]
struct Merging {
    state: State,
    parents: Vec<i32>,
    influence: Shapes,
    to_bp: Shapes,
    to_model: Shapes,
    bbox: [i64; 4],
}

impl Merging {
    fn set_bbox(&mut self, b: Option<[i64; 4]>) {
        let b = b.unwrap_or([0, 0, 0, 0]);
        self.bbox = [b[0] - 1, b[1] - 1, b[2] + 1, b[3] + 1];
    }

    fn centroid(&self, dim: usize) -> i64 {
        (self.bbox[dim] + self.bbox[dim + 2]) / 2
    }
}

fn merge_bbox(a: Option<[i64; 4]>, b: Option<[i64; 4]>) -> Option<[i64; 4]> {
    match (a, b) {
        (Some(a), Some(b)) => Some([a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]),
        (a, None) => a,
        (None, b) => b,
    }
}

fn safe_movement_distance(cfg: &Settings, use_min: bool) -> i64 {
    let d = if use_min {
        cfg.xy_min_distance
    } else {
        cfg.xy_distance
    } + if cfg.z_distance_top_layers.min(cfg.z_distance_bottom_layers) > 0 {
        cfg.min_feature_size
    } else {
        0
    };
    if d == 0 { geo::sc(0.1) } else { d }
}

/// `increase_single_area`. Orca's `safe_union` around each difference is left out: the difference is a
/// boolean's result already, which a union gives back unchanged, and it is empty only when the union is.
fn increase_single_area(
    volumes: &Volumes,
    cfg: &Settings,
    settings: &AreaIncrease,
    layer_idx: i64,
    parent: &Element,
    relevant_offset: &Shapes,
    to_bp_data: &mut Shapes,
    to_model_data: &mut Shapes,
    increased: &mut Shapes,
    overspeed: i64,
    mergelayer: bool,
) -> Option<State> {
    let mut current = parent.state.propagate_down();
    if settings.increase_radius {
        current.effective_radius_height += 1;
    }
    let mut radius = elements::collision_radius(cfg, &current);
    let tiny = geo::tiny_area();
    if settings.mv {
        increased.clone_from(relevant_offset);
        if overspeed > 0 {
            let smd = safe_movement_distance(cfg, current.use_min_xy_dist);
            let wall = volumes.wall_restriction(
                elements::collision_radius(cfg, &parent.state),
                layer_idx,
                parent.state.use_min_xy_dist,
            );
            *increased = safe_offset_inc(increased, overspeed, &wall, smd, smd + radius, 1);
        }
    } else {
        increased.clone_from(&parent.influence_area);
    }
    if mergelayer || current.to_buildplate {
        *to_bp_data = geo::diff(
            increased,
            &volumes.avoidance(
                radius,
                layer_idx - 1,
                settings.t,
                false,
                settings.use_min_distance,
            ),
        );
        if !current.to_buildplate && geo::area(to_bp_data) > tiny {
            current.to_buildplate = true;
        }
    }
    if cfg.support_rests_on_model {
        if mergelayer || current.to_model_gracious {
            *to_model_data = geo::diff(
                increased,
                &volumes.avoidance(radius, layer_idx - 1, settings.t, true, settings.use_min_distance),
            );
        }
        if !current.to_model_gracious {
            if mergelayer && geo::area(to_model_data) >= tiny {
                current.to_model_gracious = true;
            } else {
                *to_model_data = geo::diff(
                    increased,
                    &volumes.collision(radius, layer_idx - 1, settings.use_min_distance),
                );
            }
        }
    }
    let mut check_area = geo::area(if current.to_buildplate {
        to_bp_data
    } else {
        to_model_data
    });
    if settings.increase_radius && check_area > tiny {
        let valid_with_radius = |current: &State, radius: i64, next_radius: i64| -> bool {
            if volumes.ceil_radius(next_radius, settings.use_min_distance)
                <= volumes.ceil_radius(radius, settings.use_min_distance)
            {
                return true;
            }
            let check = if current.to_buildplate {
                geo::diff(
                    increased,
                    &volumes.avoidance(
                        next_radius,
                        layer_idx - 1,
                        settings.t,
                        false,
                        settings.use_min_distance,
                    ),
                )
            } else if cfg.support_rests_on_model {
                let avoid = if current.to_model_gracious {
                    volumes.avoidance(
                        next_radius,
                        layer_idx - 1,
                        settings.t,
                        true,
                        settings.use_min_distance,
                    )
                } else {
                    volumes.collision(next_radius, layer_idx - 1, settings.use_min_distance)
                };
                geo::diff(increased, &avoid)
            } else {
                Vec::new()
            };
            geo::area(&check) > tiny
        };
        let ceil_before = volumes.ceil_radius(radius, settings.use_min_distance);
        let cr = elements::collision_radius(cfg, &current);
        let rr = elements::radius(cfg, &current);
        if cr < cfg.increase_radius_until_radius && cr < rr {
            let target = rr.min(cfg.increase_radius_until_radius);
            let mut current_ceil = volumes.radius_next_ceil(radius, settings.use_min_distance);
            while current_ceil < target
                && valid_with_radius(
                    &current,
                    radius,
                    volumes.radius_next_ceil(current_ceil + 1, settings.use_min_distance),
                )
            {
                current_ceil = volumes.radius_next_ceil(current_ceil + 1, settings.use_min_distance);
            }
            let mut eff = current.effective_radius_height as usize;
            while eff + 1 < current.distance_to_top as usize
                && cfg.get_radius(eff + 1, current.elephant_foot_increases) <= current_ceil
                && cfg.get_radius(eff + 1, current.elephant_foot_increases) <= elements::radius(cfg, &current)
            {
                eff += 1;
            }
            current.effective_radius_height = eff as u32;
        }
        radius = elements::collision_radius(cfg, &current);
        let foot_radius_increase =
            (cfg.bp_radius_increase_per_layer - cfg.branch_radius_increase_per_layer).max(0.0) as i64;
        let ratio = (cfg.recommended_min_radius(layer_idx - 1) - elements::radius(cfg, &current)) as f64
            / foot_radius_increase as f64;
        // `std::min(1.0, ratio)` keeps 1 when the ratio is not a number.
        let planned = if ratio < 1.0 { ratio } else { 1.0 };
        let increase_bp_foot = planned > 0.0 && current.to_buildplate;
        let rr = elements::radius(cfg, &current);
        if increase_bp_foot
            && rr >= cfg.branch_radius
            && rr >= cfg.increase_radius_until_radius
            && valid_with_radius(
                &current,
                radius,
                cfg.get_radius(
                    current.effective_radius_height as usize,
                    current.elephant_foot_increases + planned,
                ),
            )
        {
            current.elephant_foot_increases += planned;
            radius = elements::collision_radius(cfg, &current);
        }
        if ceil_before != volumes.ceil_radius(radius, settings.use_min_distance) {
            if current.to_buildplate {
                *to_bp_data = geo::diff(
                    increased,
                    &volumes.avoidance(
                        radius,
                        layer_idx - 1,
                        settings.t,
                        false,
                        settings.use_min_distance,
                    ),
                );
            }
            if cfg.support_rests_on_model && (!current.to_buildplate || mergelayer) {
                let avoid = if current.to_model_gracious {
                    volumes.avoidance(radius, layer_idx - 1, settings.t, true, settings.use_min_distance)
                } else {
                    volumes.collision(radius, layer_idx - 1, settings.use_min_distance)
                };
                *to_model_data = geo::diff(increased, &avoid);
            }
            check_area = geo::area(if current.to_buildplate {
                to_bp_data
            } else {
                to_model_data
            });
        }
    }
    (check_area > tiny).then_some(current)
}

/// What one element became a layer down: its merging entry, or a lost parent.
enum Grown {
    Area(Box<Merging>),
    Lost,
}

/// `increase_areas_one_layer` for one element of the layer above.
fn grow_one(
    volumes: &Volumes,
    cfg: &Settings,
    layer_idx: i64,
    parent: &Element,
    parent_idx: i32,
    mergelayer: bool,
) -> Grown {
    let mut elem = parent.state.propagate_down();
    let wall = volumes.wall_restriction(
        elements::collision_radius(cfg, &parent.state),
        layer_idx,
        parent.state.use_min_xy_dist,
    );
    let mut to_bp_data: Shapes = Vec::new();
    let mut to_model_data: Shapes = Vec::new();
    let mut radius = elements::collision_radius(cfg, &elem);
    // Orca adds 5 nm here against rounding, less than a plate unit.
    let mut extra_speed: i64 = 0;
    let mut extra_slow_speed: i64 = 0;
    let parent_cr = elements::collision_radius(cfg, &parent.state);
    let ceiled_parent_radius = volumes.ceil_radius(parent_cr, parent.state.use_min_xy_dist);
    let projected_radius_increased = cfg.get_radius(
        parent.state.effective_radius_height as usize + 1,
        parent.state.elephant_foot_increases,
    );
    let projected_radius_delta = projected_radius_increased - parent_cr;
    let smd = safe_movement_distance(cfg, elem.use_min_xy_dist);
    if ceiled_parent_radius == volumes.ceil_radius(projected_radius_increased, parent.state.use_min_xy_dist)
        || projected_radius_increased < cfg.increase_radius_until_radius
    {
        extra_speed += projected_radius_delta;
    } else {
        extra_slow_speed += projected_radius_delta.min(
            (cfg.maximum_move_distance + extra_speed) - (cfg.maximum_move_distance_slow + extra_slow_speed),
        );
    }
    if cfg.layer_start_bp_radius > layer_idx
        && cfg.recommended_min_radius(layer_idx - 1)
            < cfg.get_radius(
                elem.effective_radius_height as usize + 1,
                elem.elephant_foot_increases,
            )
    {
        if ceiled_parent_radius
            == volumes.ceil_radius(
                cfg.get_radius(
                    parent.state.effective_radius_height as usize + 1,
                    parent.state.elephant_foot_increases + 1.0,
                ),
                parent.state.use_min_xy_dist,
            )
        {
            extra_speed = (extra_speed as f64 + cfg.bp_radius_increase_per_layer) as i64;
        } else {
            extra_slow_speed += (cfg.bp_radius_increase_per_layer as i64)
                .min(cfg.maximum_move_distance - (cfg.maximum_move_distance_slow + extra_slow_speed));
        }
    }
    let fast_speed = cfg.maximum_move_distance + extra_speed;
    let slow_speed = cfg.maximum_move_distance_slow + extra_speed + extra_slow_speed;

    let mut order: Vec<AreaIncrease> = Vec::new();
    let insert = |order: &mut Vec<AreaIncrease>, s: AreaIncrease, back: bool| {
        if !order.contains(&s) {
            if back { order.push(s) } else { order.insert(0, s) }
        }
    };
    let ai = |t: AvoidanceType,
              increase_speed: i64,
              increase_radius: bool,
              no_error: bool,
              use_min_distance: bool,
              mv: bool| AreaIncrease {
        t,
        increase_speed,
        increase_radius,
        no_error,
        use_min_distance,
        mv,
    };
    let parent_moved_slow = elem.last_area_increase.increase_speed < cfg.maximum_move_distance;
    let avoidance_speed_mismatch = parent_moved_slow && elem.last_area_increase.t != AvoidanceType::Slow;
    let last = elem.last_area_increase;
    if last.mv
        && last.no_error
        && elem.can_use_safe_radius
        && !mergelayer
        && !avoidance_speed_mismatch
        && (elem.distance_to_top as usize >= cfg.tip_layers || parent_moved_slow)
    {
        let sp = if last.increase_speed < cfg.maximum_move_distance {
            slow_speed
        } else {
            fast_speed
        };
        insert(
            &mut order,
            ai(last.t, sp, true, last.no_error, false, last.mv),
            true,
        );
        insert(
            &mut order,
            ai(last.t, sp, false, last.no_error, false, last.mv),
            true,
        );
    }
    if elem.can_use_safe_radius {
        insert(
            &mut order,
            ai(AvoidanceType::Slow, slow_speed, true, true, false, true),
            true,
        );
        insert(
            &mut order,
            ai(AvoidanceType::Slow, slow_speed, false, true, false, true),
            true,
        );
        if (elem.distance_to_top as usize) < cfg.tip_layers {
            insert(
                &mut order,
                ai(AvoidanceType::FastSafe, slow_speed, true, true, false, true),
                true,
            );
        }
        insert(
            &mut order,
            ai(AvoidanceType::FastSafe, fast_speed, true, true, false, true),
            true,
        );
        insert(
            &mut order,
            ai(AvoidanceType::FastSafe, fast_speed, false, true, false, true),
            true,
        );
    } else {
        insert(
            &mut order,
            ai(AvoidanceType::Slow, slow_speed, true, true, false, false),
            true,
        );
        if i64::from(elem.distance_to_top) < round_up_divide(cfg.tip_layers as i64, 2) {
            insert(
                &mut order,
                ai(AvoidanceType::Fast, slow_speed, true, true, false, false),
                true,
            );
        }
        insert(
            &mut order,
            ai(AvoidanceType::FastSafe, fast_speed, true, true, false, false),
            true,
        );
        insert(
            &mut order,
            ai(AvoidanceType::FastSafe, fast_speed, false, true, false, true),
            true,
        );
        insert(
            &mut order,
            ai(AvoidanceType::Fast, fast_speed, false, true, false, true),
            true,
        );
    }
    if elem.use_min_xy_dist {
        let mut new_order = Vec::with_capacity(order.len() * 2);
        for s in &order {
            new_order.push(*s);
            new_order.push(AreaIncrease {
                use_min_distance: true,
                ..*s
            });
        }
        order = new_order;
    }
    if elem.to_buildplate
        || (elem.to_model_gracious
            && geo::inter(&parent.influence_area, &volumes.placeable(radius, layer_idx)).is_empty())
    {
        insert(
            &mut order,
            ai(
                AvoidanceType::Fast,
                fast_speed,
                false,
                false,
                elem.use_min_xy_dist,
                true,
            ),
            true,
        );
    }
    if elem.distance_to_top < elem.dont_move_until && elem.can_use_safe_radius {
        insert(
            &mut order,
            ai(AvoidanceType::Slow, 0, true, true, false, false),
            false,
        );
    }

    let mut offset_slow: Shapes = Vec::new();
    let mut offset_fast: Shapes = Vec::new();
    let mut inc_wo_collision: Shapes = Vec::new();
    let offset_independent_faster = radius / smd
        - i64::from(cfg.maximum_move_distance + extra_speed < radius + smd)
        > round_up_divide(
            extra_speed + extra_slow_speed + cfg.maximum_move_distance_slow,
            smd,
        );
    let mut add = false;
    let mut bypass_merge = false;
    for settings in &order {
        if settings.mv {
            if offset_slow.is_empty() && (settings.increase_speed == slow_speed || !offset_independent_faster)
            {
                offset_slow = safe_offset_inc(
                    &parent.influence_area,
                    extra_speed + extra_slow_speed + cfg.maximum_move_distance_slow,
                    &wall,
                    smd,
                    if offset_independent_faster {
                        smd + radius
                    } else {
                        0
                    },
                    2,
                );
            }
            if offset_fast.is_empty() && settings.increase_speed != slow_speed {
                offset_fast = if offset_independent_faster {
                    safe_offset_inc(
                        &parent.influence_area,
                        extra_speed + cfg.maximum_move_distance,
                        &wall,
                        smd,
                        smd + radius,
                        1,
                    )
                } else {
                    let delta_slow_fast =
                        cfg.maximum_move_distance - (cfg.maximum_move_distance_slow + extra_slow_speed);
                    safe_offset_inc(&offset_slow, delta_slow_fast, &wall, smd, smd + radius, 1)
                };
            }
        }
        inc_wo_collision.clear();
        let mut result = if settings.no_error {
            let src = if settings.increase_speed == slow_speed {
                &offset_slow
            } else {
                &offset_fast
            };
            increase_single_area(
                volumes,
                cfg,
                settings,
                layer_idx,
                parent,
                src,
                &mut to_bp_data,
                &mut to_model_data,
                &mut inc_wo_collision,
                0,
                mergelayer,
            )
        } else {
            // The area may have collapsed to a line, which no offset grows: give it some width first.
            let lines =
                geo::offset_polylines(&geo::to_polylines(&parent.influence_area), geo::sc(0.005) as f64);
            let base_error_area = geo::union2(&parent.influence_area, &lines);
            let overspeed = ((cfg.maximum_move_distance + extra_speed) as f64 * 1.5) as i64;
            increase_single_area(
                volumes,
                cfg,
                settings,
                layer_idx,
                parent,
                &base_error_area,
                &mut to_bp_data,
                &mut to_model_data,
                &mut inc_wo_collision,
                overspeed,
                mergelayer,
            )
            .map(|mut s| {
                s.lost = true;
                s
            })
        };
        if let Some(r) = result.take() {
            elem = r;
            radius = elements::collision_radius(cfg, &elem);
            elem.last_area_increase = *settings;
            add = true;
            bypass_merge = !settings.mv
                || (settings.use_min_distance && (elem.distance_to_top as usize) < cfg.tip_layers);
            if settings.mv {
                elem.dont_move_until = 0;
            } else {
                elem.result_on_layer = parent.state.result_on_layer;
            }
            elem.can_use_safe_radius = settings.t != AvoidanceType::Fast;
            if !settings.use_min_distance {
                elem.use_min_xy_dist = false;
            }
            break;
        }
    }
    if !add {
        return Grown::Lost;
    }
    let max_influence = safe_union(
        &geo::diff(
            &inc_wo_collision,
            &volumes.collision(radius, layer_idx - 1, elem.use_min_xy_dist),
        ),
        &safe_union(&to_bp_data, &to_model_data),
    );
    let mut m = Merging {
        state: elem,
        parents: vec![parent_idx],
        ..Merging::default()
    };
    m.set_bbox(geo::bbox(&max_influence));
    m.influence = max_influence;
    if !bypass_merge {
        if m.state.to_buildplate {
            m.to_bp = to_bp_data;
        }
        if cfg.support_rests_on_model {
            m.to_model = to_model_data;
        }
    }
    Grown::Area(Box::new(m))
}

/// `merge_support_element_states`.
fn merge_states(cfg: &Settings, first: &State, second: &State, next_position: Pt, layer_idx: i64) -> State {
    let mut out = State {
        next_position,
        layer_idx,
        use_min_xy_dist: first.use_min_xy_dist || second.use_min_xy_dist,
        supports_roof: first.supports_roof || second.supports_roof,
        dont_move_until: first.dont_move_until.max(second.dont_move_until),
        can_use_safe_radius: first.can_use_safe_radius || second.can_use_safe_radius,
        ..State::default()
    };
    out.set_pending_roof_recovery(
        first.missing_roof_layers.max(second.missing_roof_layers),
        first.roof_recovery_dtt.max(second.roof_recovery_dtt),
    );
    if first.target_height > second.target_height {
        out.target_height = first.target_height;
        out.target_position = first.target_position;
    } else {
        out.target_height = second.target_height;
        out.target_position = second.target_position;
    }
    out.effective_radius_height = first.effective_radius_height.max(second.effective_radius_height);
    out.distance_to_top = first.distance_to_top.max(second.distance_to_top);
    out.to_buildplate = first.to_buildplate && second.to_buildplate;
    out.to_model_gracious = first.to_model_gracious && second.to_model_gracious;
    out.elephant_foot_increases = 0.0;
    if cfg.bp_radius_increase_per_layer > 0.0 {
        let foot = (elements::collision_radius(cfg, second).max(elements::collision_radius(cfg, first))
            - elements::collision_radius(cfg, &out))
        .abs();
        out.elephant_foot_increases =
            foot as f64 / (cfg.bp_radius_increase_per_layer - cfg.branch_radius_increase_per_layer);
    }
    let (a, b) = (first.last_area_increase, second.last_area_increase);
    out.last_area_increase = AreaIncrease {
        t: a.t.min(b.t),
        increase_speed: a.increase_speed.min(b.increase_speed),
        increase_radius: a.increase_radius || b.increase_radius,
        no_error: a.no_error || b.no_error,
        use_min_distance: a.use_min_distance && b.use_min_distance,
        mv: a.mv || b.mv,
    };
    out
}

/// `merge_influence_areas_two_elements`: merges `src` into `dst` when one branch can hold up both.
fn merge_two(
    volumes: &Volumes,
    cfg: &Settings,
    layer_idx: i64,
    dst: &mut Merging,
    src: &mut Merging,
) -> bool {
    if dst.state.to_model_gracious != src.state.to_model_gracious
        || dst.state.use_min_xy_dist != src.state.use_min_xy_dist
    {
        return false;
    }
    let dst_bigger =
        elements::collision_radius(cfg, &dst.state) > elements::collision_radius(cfg, &src.state);
    let (smaller, bigger): (&Merging, &Merging) = if dst_bigger { (src, dst) } else { (dst, src) };
    let real_radius_delta =
        (elements::radius(cfg, &bigger.state) - elements::radius(cfg, &smaller.state)).abs();
    {
        let s = smaller.bbox;
        let b = bigger.bbox;
        let s = [
            s[0] - real_radius_delta,
            s[1] - real_radius_delta,
            s[2] + real_radius_delta,
            s[3] + real_radius_delta,
        ];
        if !(s[0] <= b[2] && b[0] <= s[2] && s[1] <= b[3] && b[1] <= s[3]) {
            return false;
        }
    }
    let mut increased_to_model_radius = 0i64;
    let merging_to_bp = dst.state.to_buildplate && src.state.to_buildplate;
    if !merging_to_bp {
        if dst.state.to_buildplate != src.state.to_buildplate {
            let rdst = elements::radius(cfg, &dst.state);
            let rsrc = elements::radius(cfg, &src.state);
            if dst.state.to_buildplate {
                if rsrc < rdst {
                    increased_to_model_radius = src.state.increased_to_model_radius + rdst - rsrc;
                }
            } else if rsrc > rdst {
                increased_to_model_radius = dst.state.increased_to_model_radius + rsrc - rdst;
            }
            if increased_to_model_radius > cfg.max_to_model_radius_increase {
                return false;
            }
        }
        if !dst.state.supports_roof
            && !src.state.supports_roof
            && (src.state.distance_to_top.max(dst.state.distance_to_top) as usize) < cfg.min_dtt_to_model
        {
            return false;
        }
    }
    if !bigger.state.can_use_safe_radius && smaller.state.can_use_safe_radius {
        return false;
    }
    let use_min_radius = bigger.state.use_min_xy_dist && smaller.state.use_min_xy_dist;
    let smaller_cr = elements::collision_radius(cfg, &smaller.state);
    let collision = volumes.collision(smaller_cr, layer_idx - 1, use_min_radius);
    // Orca takes 3 nm off the step against rounding, less than a plate unit.
    let step = 2 * (cfg.xy_distance + smaller_cr);
    let small_with_bigger = |small: &Shapes, big: &Shapes| {
        geo::inter(
            &safe_offset_inc(small, real_radius_delta, &collision, step, 0, 0),
            big,
        )
    };
    let intersect = if merging_to_bp {
        small_with_bigger(&smaller.to_bp, &bigger.to_bp)
    } else {
        small_with_bigger(&smaller.to_model, &bigger.to_model)
    };
    let tiny = geo::tiny_area();
    if geo::area(&intersect) <= tiny {
        return false;
    }
    if geo::area(&geo::offset_miter(&intersect, -(geo::sc(0.025) as f64))) <= tiny {
        return false;
    }
    let new_pos = geo::move_inside_if_outside(&intersect, dst.state.next_position);
    let mut new_state = merge_states(cfg, &dst.state, &src.state, new_pos, layer_idx - 1);
    new_state.increased_to_model_radius = if increased_to_model_radius == 0 {
        dst.state
            .increased_to_model_radius
            .max(src.state.increased_to_model_radius)
    } else {
        increased_to_model_radius
    };
    let influence = safe_union(
        &small_with_bigger(&smaller.influence, &bigger.influence),
        &intersect,
    );
    let to_model = if merging_to_bp && cfg.support_rests_on_model {
        if new_state.to_model_gracious {
            safe_union(
                &small_with_bigger(&smaller.to_model, &bigger.to_model),
                &intersect,
            )
        } else {
            influence.clone()
        }
    } else {
        Vec::new()
    };
    let src_parents = std::mem::take(&mut src.parents);
    dst.parents.extend(src_parents);
    dst.state = new_state;
    dst.influence = influence;
    dst.to_bp.clear();
    dst.to_model.clear();
    if merging_to_bp {
        dst.to_bp = intersect;
        if cfg.support_rests_on_model {
            dst.to_model = to_model;
        }
    } else {
        dst.to_model = intersect;
    }
    let b = merge_bbox(
        merge_bbox(geo::bbox(&dst.influence), geo::bbox(&dst.to_bp)),
        geo::bbox(&dst.to_model),
    );
    dst.set_bbox(b);
    src.influence.clear();
    src.to_bp.clear();
    src.to_model.clear();
    src.parents.clear();
    true
}

/// Two distinct elements of `v`, mutably.
fn pair(v: &mut [Merging], a: usize, b: usize) -> (&mut Merging, &mut Merging) {
    if a < b {
        let (l, r) = v.split_at_mut(b);
        (&mut l[a], &mut r[0])
    } else {
        let (l, r) = v.split_at_mut(a);
        (&mut r[0], &mut l[b])
    }
}

/// `merge_influence_areas_leaves`: every pair of one bucket.
fn merge_leaves(
    volumes: &Volumes,
    cfg: &Settings,
    layer_idx: i64,
    v: &mut [Merging],
    begin: usize,
    mut end: usize,
) -> usize {
    let mut i = begin;
    while i + 1 < end {
        let mut j = i + 1;
        let mut merged = false;
        while j != end {
            let (a, b) = pair(v, i, j);
            if merge_two(volumes, cfg, layer_idx, a, b) {
                end -= 1;
                if j != end {
                    v[j] = std::mem::take(&mut v[end]);
                }
                merged = true;
                break;
            }
            j += 1;
        }
        if !merged {
            i += 1;
        }
    }
    end
}

/// `merge_influence_areas_two_sets`: merges the elements of `src` into those of `dst`.
fn merge_sets(
    volumes: &Volumes,
    cfg: &Settings,
    layer_idx: i64,
    v: &mut [Merging],
    dst_begin: usize,
    mut dst_end: usize,
    mut src_begin: usize,
    src_end: usize,
) -> usize {
    let mut src = src_begin;
    while src != src_end {
        let mut dst = dst_begin;
        let mut merged: Option<usize> = None;
        while dst != dst_end {
            let (a, b) = pair(v, dst, src);
            if merge_two(volumes, cfg, layer_idx, a, b) {
                merged = Some(dst);
                dst += 1;
                if src != src_begin {
                    v[src] = std::mem::take(&mut v[src_begin]);
                }
                src_begin += 1;
                break;
            }
            dst += 1;
        }
        if let Some(m) = merged {
            while dst != dst_end {
                let (a, b) = pair(v, m, dst);
                if merge_two(volumes, cfg, layer_idx, a, b) {
                    dst_end -= 1;
                    if dst != dst_end {
                        v[dst] = std::mem::take(&mut v[dst_end]);
                    }
                } else {
                    dst += 1;
                }
            }
        }
        src += 1;
    }
    if dst_end == src_begin {
        dst_end = src_end;
    } else {
        while src_begin != src_end {
            v[dst_end] = std::mem::take(&mut v[src_begin]);
            dst_end += 1;
            src_begin += 1;
        }
    }
    dst_end
}

/// The order `AABBTreeIndirect::Tree::build_modify_input` leaves its input in: split at the median along the
/// longer side of the box, recursively (quickselect with a median of three).
fn aabb_order(v: &mut [Merging], left: usize, right: usize) {
    if left >= right {
        return;
    }
    let mut b = v[left].bbox;
    for e in &v[left + 1..=right] {
        b = [
            b[0].min(e.bbox[0]),
            b[1].min(e.bbox[1]),
            b[2].max(e.bbox[2]),
            b[3].max(e.bbox[3]),
        ];
    }
    let dim = usize::from(b[3] - b[1] > b[2] - b[0]);
    let center = (left + right) / 2;
    partition(v, dim, left, right, center);
    aabb_order(v, left, center);
    aabb_order(v, center + 1, right);
}

fn partition(v: &mut [Merging], dim: usize, mut left: usize, mut right: usize, k: usize) {
    while left < right {
        let center = (left + right) / 2;
        let mut lv = v[left].centroid(dim);
        let mut cv = v[center].centroid(dim);
        let rv = v[right].centroid(dim);
        if lv > cv {
            v.swap(left, center);
            std::mem::swap(&mut lv, &mut cv);
        }
        if lv > rv {
            v.swap(left, right);
        }
        let rv = v[right].centroid(dim);
        if cv > rv {
            v.swap(center, right);
            cv = rv;
        }
        let pivot = cv;
        if right <= left + 2 {
            break;
        }
        let mut i = left;
        let mut j = right - 1;
        v.swap(center, j);
        loop {
            i += 1;
            while v[i].centroid(dim) < pivot {
                i += 1;
            }
            j -= 1;
            while v[j].centroid(dim) > pivot && i < j {
                j -= 1;
            }
            if i >= j {
                break;
            }
            v.swap(i, j);
        }
        v.swap(i, right - 1);
        match k.cmp(&i) {
            std::cmp::Ordering::Less => right = i - 1,
            std::cmp::Ordering::Equal => break,
            std::cmp::Ordering::Greater => left = i + 1,
        }
    }
}

/// The pieces of `v` in `ranges` (ascending, apart from each other), each with where it starts.
fn disjoint(v: &mut [Merging], ranges: impl Iterator<Item = (usize, usize)>) -> Vec<(usize, &mut [Merging])> {
    let mut out = Vec::new();
    let mut rest = v;
    let mut base = 0;
    for (a, b) in ranges {
        let (_, tail) = std::mem::take(&mut rest).split_at_mut(a - base);
        let (part, tail) = tail.split_at_mut(b - a);
        out.push((a, part));
        rest = tail;
        base = b;
    }
    out
}

/// `merge_influence_areas`: the areas of one layer merged, bucket by bucket in AABB order.
fn merge_influence_areas(volumes: &Volumes, cfg: &Settings, layer_idx: i64, v: &mut [Merging]) {
    let n = v.len();
    if n == 0 {
        return;
    }
    let last = n - 1;
    aabb_order(v, 0, last);
    let num_buckets_min = (n + 2) / 4;
    let num_buckets_max = n / 2;
    let (num_initial, bucket_size) = if num_buckets_min >= MERGE_THREADS {
        (num_buckets_min, 4)
    } else {
        (num_buckets_max, 2)
    };
    let mut buckets: Vec<(usize, usize)> = Vec::with_capacity(num_initial + 1);
    let mut it = 0;
    for _ in 0..num_initial {
        buckets.push((it, it + bucket_size));
        it += bucket_size;
    }
    match buckets.last_mut() {
        Some(b) if b.1 >= n => b.1 = b.1.min(n),
        _ => buckets.push((it, n)),
    }
    // The buckets of a round cover ranges of `v` apart from each other, so they merge in parallel (as Orca's
    // threads do) with the same result as one after another.
    let ends = crate::par::map_owned(
        disjoint(v, buckets.iter().take(num_initial).map(|b| (b.0, b.1))),
        |(at, part)| at + merge_leaves(volumes, cfg, layer_idx, part, 0, part.len()),
    );
    for (b, e) in buckets.iter_mut().zip(ends) {
        b.1 = e;
    }
    while buckets.len() > 1 {
        let pairs: Vec<((usize, usize), (usize, usize))> =
            buckets.as_chunks::<2>().0.iter().map(|&[d, s]| (d, s)).collect();
        let ends = crate::par::map_owned(
            disjoint(v, pairs.iter().map(|(d, s)| (d.0, s.1)))
                .into_iter()
                .zip(&pairs)
                .collect(),
            |((at, part), (d, s))| {
                at + merge_sets(volumes, cfg, layer_idx, part, 0, d.1 - at, s.0 - at, s.1 - at)
            },
        );
        for (idx, e) in ends.into_iter().enumerate() {
            buckets[idx * 2].1 = e;
        }
        let new_size = buckets.len().div_ceil(2);
        for i in 1..new_size {
            buckets[i] = buckets[i * 2];
        }
        buckets.truncate(new_size);
    }
}

/// `create_layer_pathing`: the influence areas of every layer, from the top down.
pub(crate) fn create_layer_pathing(volumes: &Volumes, cfg: &Settings, move_bounds: &mut [Vec<Element>]) {
    let n = move_bounds.len() as i64;
    for layer_idx in (1..n).rev() {
        let li = layer_idx as usize;
        if move_bounds[li].is_empty() {
            continue;
        }
        // Orca's limits on merging only every few layers were written for micrometers but read nanometers, so
        // in effect it merges on every layer; that is done here directly.
        let merge_this_layer = true;
        let grown: Vec<Grown> = {
            let prev = &move_bounds[li];
            crate::par::map_range(0..prev.len() as u32, |i| {
                grow_one(
                    volumes,
                    cfg,
                    layer_idx,
                    &prev[i as usize],
                    i as i32,
                    merge_this_layer,
                )
            })
        };
        let mut influence: Vec<Merging> = Vec::with_capacity(grown.len());
        for (i, g) in grown.into_iter().enumerate() {
            match g {
                Grown::Area(m) => influence.push(*m),
                Grown::Lost => {
                    let p = &mut move_bounds[li][i].state;
                    p.result_on_layer = None;
                    p.to_model_gracious = false;
                    p.verylost = true;
                }
            }
        }
        // Areas that do not merge go straight to the layer below.
        let mut keep: Vec<Merging> = Vec::with_capacity(influence.len());
        for m in influence {
            if m.influence.is_empty() {
                continue;
            }
            if m.to_bp.is_empty() && m.to_model.is_empty() {
                move_bounds[li - 1].push(Element {
                    state: m.state,
                    parents: m.parents,
                    influence_area: m.influence,
                });
            } else {
                keep.push(m);
            }
        }
        let mut influence = keep;
        if merge_this_layer && influence.len() > 1 {
            merge_influence_areas(volumes, cfg, layer_idx, &mut influence);
        }
        for m in influence {
            if !m.influence.is_empty() {
                let area = m.influence;
                move_bounds[li - 1].push(Element {
                    state: m.state,
                    parents: m.parents,
                    influence_area: area,
                });
            }
        }
    }
}

/// `set_points_on_areas`: the points of the elements `elem` holds up, as close as possible to its own.
fn set_points_on_areas(elem: &Element, above: Option<&mut Vec<Element>>) {
    let Some(r) = elem.state.result_on_layer else {
        return;
    };
    let Some(above) = above else { return };
    for &pi in &elem.parents {
        let Some(next) = above.get_mut(pi as usize) else {
            continue;
        };
        if next.state.result_on_layer.is_none() {
            next.state.result_on_layer = Some(geo::move_inside_if_outside(&next.influence_area, r));
        }
        next.state.marked = true;
    }
}

fn set_to_model_contact_simple(elem: &mut Element) {
    elem.state.result_on_layer = Some(geo::move_inside_if_outside(
        &elem.influence_area,
        elem.state.next_position,
    ));
}

/// `set_to_model_contact_to_model_gracious`: rests the branch on the highest layer above where it fits on
/// the model, dropping the elements below.
fn set_to_model_contact_gracious(
    volumes: &Volumes,
    cfg: &Settings,
    move_bounds: &mut [Vec<Element>],
    layer: usize,
    idx: usize,
) {
    let mut last_ok: Option<(usize, usize)> = None;
    {
        let (mut l, mut i) = (layer, idx);
        loop {
            let e = &move_bounds[l][i];
            let r = elements::collision_radius(cfg, &e.state);
            if geo::inter(&e.influence_area, &volumes.placeable(r, l as i64)).is_empty() {
                break;
            }
            last_ok = Some((l, i));
            if e.parents.len() != 1 {
                break;
            }
            let next = e.parents[0] as usize;
            l += 1;
            i = next;
            if l >= move_bounds.len() || i >= move_bounds[l].len() {
                break;
            }
        }
    }
    match last_ok {
        None => {
            let e = &mut move_bounds[layer][idx];
            e.state.to_model_gracious = false;
            set_to_model_contact_simple(e);
        }
        Some((ll, li)) => {
            let (mut l, mut i) = (layer, idx);
            while (l, i) != (ll, li) {
                let e = &mut move_bounds[l][i];
                e.state.deleted = true;
                let next = e.parents[0] as usize;
                l += 1;
                i = next;
            }
            let e = &mut move_bounds[ll][li];
            e.state.result_on_layer = Some(geo::move_inside_if_outside(
                &e.influence_area,
                e.state.next_position,
            ));
        }
    }
}

/// `remove_deleted_elements`: drops deleted elements, moving the last element of a layer into each hole, and
/// fixes the parent indices.
fn remove_deleted_elements(move_bounds: &mut [Vec<Element>]) {
    let mut map_parents: Vec<i32> = Vec::new();
    let mut map_current: Vec<i32> = Vec::new();
    for layer_idx in (0..move_bounds.len()).rev() {
        let layer = &mut move_bounds[layer_idx];
        map_current.clear();
        let mut i = 0usize;
        while i < layer.len() {
            if layer[i].state.deleted {
                if map_current.is_empty() {
                    map_current = (0..layer.len() as i32).collect();
                }
                while i < layer.len() && layer.last().is_some_and(|e| e.state.deleted) {
                    layer.pop();
                    map_current[layer.len()] = -1;
                }
                if i + 1 < layer.len() {
                    let moved = layer.pop().unwrap_or_default();
                    layer[i] = moved;
                    map_current[i] = -1;
                    map_current[layer.len()] = i as i32;
                }
            } else {
                if !map_parents.is_empty() {
                    for p in &mut layer[i].parents {
                        *p = map_parents[*p as usize];
                    }
                }
                i += 1;
            }
        }
        std::mem::swap(&mut map_current, &mut map_parents);
    }
}

/// `create_nodes_from_area`: the point of every element, from the bed up.
pub(crate) fn create_nodes_from_area(volumes: &Volumes, cfg: &Settings, move_bounds: &mut [Vec<Element>]) {
    let n = move_bounds.len();
    if n == 0 {
        return;
    }
    {
        let (first, rest) = move_bounds.split_at_mut(1);
        let mut above = rest.first_mut();
        if let Some(a) = above.as_deref_mut() {
            for e in a.iter_mut() {
                e.state.marked = false;
            }
        }
        for init in &mut first[0] {
            init.state.result_on_layer = Some(geo::move_inside_if_outside(
                &init.influence_area,
                init.state.next_position,
            ));
            set_points_on_areas(init, above.as_deref_mut());
        }
    }
    for layer_idx in 1..n {
        if layer_idx + 1 < n {
            for e in &mut move_bounds[layer_idx + 1] {
                e.state.marked = false;
            }
        }
        for ei in 0..move_bounds[layer_idx].len() {
            let elem = &move_bounds[layer_idx][ei];
            if elem.state.result_on_layer.is_none() {
                if elem.state.to_buildplate
                    || ((elem.state.distance_to_top as usize) < cfg.min_dtt_to_model
                        && !elem.state.supports_roof)
                {
                    move_bounds[layer_idx][ei].state.deleted = true;
                } else if elem.state.to_model_gracious {
                    set_to_model_contact_gracious(volumes, cfg, move_bounds, layer_idx, ei);
                } else {
                    set_to_model_contact_simple(&mut move_bounds[layer_idx][ei]);
                }
            }
            let elem = &mut move_bounds[layer_idx][ei];
            if !elem.state.deleted && !elem.state.marked && elem.state.target_height == layer_idx as i64 {
                elem.state.deleted = true;
            }
            let deleted = elem.state.deleted;
            let parents = elem.parents.clone();
            if deleted {
                if layer_idx + 1 < n {
                    for p in parents {
                        if let Some(pe) = move_bounds[layer_idx + 1].get_mut(p as usize) {
                            pe.state.result_on_layer = None;
                        }
                    }
                }
            } else {
                let (lo, hi) = move_bounds.split_at_mut(layer_idx + 1);
                set_points_on_areas(&lo[layer_idx][ei], hi.first_mut());
            }
        }
    }
    remove_deleted_elements(move_bounds);
}
