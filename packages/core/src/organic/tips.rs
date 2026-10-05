// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Tip placement of organic trees, as Orca's `generate_initial_areas`, `sample_overhang_area` and
//! `RichInterfacePlacer` (Support/TreeSupport3D.cpp):
//!
//! - each overhang, `z_distance_top_layers + 1` layers above, is trimmed by what a tip may not touch and grown
//!   in steps to make up for the tip radius;
//! - with top interfaces, wide overhangs get up to `support_interface_top_layers` roof layers while their area
//!   a layer down stays above the minimum roof area, and the tips go along the interface lines of the lowest
//!   roof; the remaining (thin) overhangs get tips along support base lines at the branch distance, or along
//!   their outline when that gives too few;
//! - the points are resampled along those lines at the connect length (from `tree_support_top_rate`), and each
//!   point becomes a tip element carrying where it can still go (to the bed, safely, or to the model).

#![allow(
    clippy::manual_midpoint,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::indexing_slicing,
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "plate units in i64 and layer indices as Orca's LayerIndex; ports of Orca's long functions"
)]

use super::elements::{Element, LineStatus, State};
use super::geo::{self, Join, Pt};
use super::settings::Settings;
use super::volumes::{AvoidanceType, Volumes};
use super::{Params, Placer};
use crate::perimeters::Shapes;
use std::collections::HashSet;

pub(crate) type LineInfo = Vec<(Pt, LineStatus)>;

fn round_up_divide(x: i64, y: i64) -> i64 {
    (x + y - 1) / y
}

/// `safe_union`: the union, or the outlines grown a hair when the union lost everything.
pub(crate) fn safe_union(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() && b.is_empty() {
        return Vec::new();
    }
    let r = geo::union2(a, b);
    if !r.is_empty() {
        return r;
    }
    let d = geo::sc(0.002) as f64;
    geo::union2(
        &geo::offset_polylines(&geo::to_polylines(a), d),
        &geo::offset_polylines(&geo::to_polylines(b), d),
    )
}

/// `safe_offset_inc`: grows `me` by `distance` in steps of at most `safe_step` (the last
/// `last_step_without_check` in one go), taking `collision` out after each step. Every path ends in a union or
/// a boolean already, whose result Orca's closing union gives back unchanged, so that union is left out.
pub(crate) fn safe_offset_inc(
    me: &Shapes,
    distance: i64,
    collision: &Shapes,
    safe_step: i64,
    last_step_without_check: i64,
    min_amount_offset: usize,
) -> Shapes {
    let mut do_final_difference = last_step_without_check == 0;
    let mut ret = safe_union(me, &Vec::new());
    if distance == 0 {
        return if do_final_difference {
            geo::diff(&ret, collision)
        } else {
            ret
        };
    }
    if safe_step < 0 || last_step_without_check < 0 || safe_step == 0 {
        return if do_final_difference {
            geo::diff(&ret, collision)
        } else {
            ret
        };
    }
    let mut step_size = safe_step;
    let mut steps = if distance > last_step_without_check {
        (distance - last_step_without_check) / step_size
    } else {
        0
    };
    if distance - steps * step_size > last_step_without_check {
        if (steps + 1) * step_size <= distance {
            steps += 1;
        } else {
            do_final_difference = true;
        }
    }
    let extra = i64::from(distance < last_step_without_check || distance % step_size != 0);
    if steps + extra < min_amount_offset as i64 && min_amount_offset > 1 {
        step_size = distance / min_amount_offset as i64;
        if step_size >= safe_step {
            step_size = safe_step;
            steps = min_amount_offset as i64;
        } else if step_size > 0 {
            steps = distance / step_size;
        }
    }
    let tol = geo::sc(0.01) as f64;
    for i in 0..steps {
        ret = geo::diff(&geo::offset(&ret, step_size as f64, Join::Round(tol)), collision);
        if i % 10 == 7 {
            ret = geo::simplify(&ret, geo::sc(0.015) as f64);
        }
    }
    let last = distance - steps * step_size;
    if last > 1 {
        ret = geo::offset(&ret, last as f64, Join::Round(tol));
    }
    ret = geo::simplify(&ret, geo::sc(0.015) as f64);
    if do_final_difference {
        ret = geo::diff(&ret, collision);
    }
    ret
}

/// `get_avoidance_status` and the status test of `convert_lines_to_internal`.
fn status_of(volumes: &Volumes, cfg: &Settings, p: Pt, layer: i64) -> LineStatus {
    let min_xy = cfg.xy_distance > cfg.xy_min_distance;
    let r0 = cfg.get_radius(0, 0.0);
    if !geo::contains(
        &volumes.avoidance(r0, layer, AvoidanceType::FastSafe, false, min_xy),
        p,
    ) {
        LineStatus::ToBpSafe
    } else if !geo::contains(
        &volumes.avoidance(r0, layer, AvoidanceType::Fast, false, min_xy),
        p,
    ) {
        LineStatus::ToBp
    } else if cfg.support_rests_on_model
        && !geo::contains(
            &volumes.avoidance(r0, layer, AvoidanceType::FastSafe, true, min_xy),
            p,
        )
    {
        LineStatus::ToModelGraciousSafe
    } else if cfg.support_rests_on_model
        && !geo::contains(
            &volumes.avoidance(r0, layer, AvoidanceType::Fast, true, min_xy),
            p,
        )
    {
        LineStatus::ToModelGracious
    } else if cfg.support_rests_on_model && !geo::contains(&volumes.collision(r0, layer, min_xy), p) {
        LineStatus::ToModel
    } else {
        LineStatus::Invalid
    }
}

/// `convert_lines_to_internal`: the points of each line with their status; invalid points split the line.
fn convert_lines_to_internal(
    volumes: &Volumes,
    cfg: &Settings,
    lines: &[Vec<Pt>],
    layer: i64,
) -> Vec<LineInfo> {
    let mut out = Vec::new();
    for line in lines {
        let mut res: LineInfo = Vec::new();
        for &p in line {
            let s = status_of(volumes, cfg, p, layer);
            if s == LineStatus::Invalid {
                if !res.is_empty() {
                    out.push(std::mem::take(&mut res));
                }
            } else {
                res.push((p, s));
            }
        }
        if !res.is_empty() {
            out.push(res);
        }
    }
    out
}

/// `evaluate_point_for_next_layer_function`: true when the point is still valid a layer down.
fn valid_next_layer(volumes: &Volumes, cfg: &Settings, current_layer: i64, p: &(Pt, LineStatus)) -> bool {
    let min_xy = cfg.xy_distance > cfg.xy_min_distance;
    let r0 = cfg.get_radius(0, 0.0);
    let t = if p.1 == LineStatus::ToBpSafe {
        AvoidanceType::FastSafe
    } else {
        AvoidanceType::Fast
    };
    if !geo::contains(&volumes.avoidance(r0, current_layer - 1, t, false, min_xy), p.0) {
        return true;
    }
    if cfg.support_rests_on_model && p.1 != LineStatus::ToBp && p.1 != LineStatus::ToBpSafe {
        let area = if p.1 == LineStatus::ToModelGracious || p.1 == LineStatus::ToModelGraciousSafe {
            let t = if p.1 == LineStatus::ToModelGraciousSafe {
                AvoidanceType::FastSafe
            } else {
                AvoidanceType::Fast
            };
            volumes.avoidance(r0, current_layer - 1, t, true, min_xy)
        } else {
            volumes.collision(r0, current_layer - 1, min_xy)
        };
        return !geo::contains(&area, p.0);
    }
    false
}

/// `split_lines`: the runs of points that pass `keep`, and the runs that do not.
fn split_lines(
    lines: &[LineInfo],
    keep: impl Fn(&(Pt, LineStatus)) -> bool,
) -> (Vec<LineInfo>, Vec<LineInfo>) {
    let mut kept = Vec::new();
    let mut freed = Vec::new();
    for line in lines {
        let mut current_keep = true;
        let mut res: LineInfo = Vec::new();
        for me in line {
            if keep(me) != current_keep {
                if !res.is_empty() {
                    if current_keep {
                        kept.push(std::mem::take(&mut res));
                    } else {
                        freed.push(std::mem::take(&mut res));
                    }
                }
                current_keep = !current_keep;
            }
            res.push(*me);
        }
        if !res.is_empty() {
            if current_keep {
                kept.push(res);
            } else {
                freed.push(res);
            }
        }
    }
    (kept, freed)
}

/// `polyline_sample_next_point_at_distance`: the next point `dist` from `start` along `poly` from segment
/// `start_idx` on, with the segment it lies on.
fn sample_next(poly: &[Pt], start: Pt, start_idx: usize, dist: f64) -> Option<(Pt, usize)> {
    let dist2 = dist * dist;
    let dist2i = dist2 as i64;
    let eps = geo::sc(0.01) as f64;
    for i in start_idx + 1..poly.len() {
        let p1 = poly[i];
        if geo::dist2(p1, start) >= dist2i {
            let p0 = poly[i - 1];
            let v = ((p1.0 - p0.0) as f64, (p1.1 - p0.1) as f64);
            let l2v = v.0 * v.0 + v.1 * v.1;
            if l2v < eps * eps {
                let c = ((p0.0 + p1.0) / 2, (p0.1 + p1.1) / 2);
                if (geo::dist(start, c) - dist).abs() < eps {
                    return Some((c, i - 1));
                }
                continue;
            }
            let p0f = ((start.0 - p0.0) as f64, (start.1 - p0.1) as f64);
            let k = (p0f.0 * v.0 + p0f.1 * v.1) / l2v;
            let foot = (v.0 * k, v.1 * k);
            let xf = (p0f.0 - foot.0, p0f.1 - foot.1);
            let l2_from_line = xf.0 * xf.0 + xf.1 * xf.1;
            let mut l2_int = dist2 - l2_from_line;
            if l2_int > -1.0 {
                l2_int = l2_int.max(0.0);
                let vf = (v.0 - foot.0, v.1 - foot.1);
                if vf.0 * vf.0 + vf.1 * vf.1 >= l2_int {
                    let s = (l2_int / l2v).sqrt();
                    let p = (p0.0 + (foot.0 + v.0 * s) as i64, p0.1 + (foot.1 + v.1 * s) as i64);
                    return Some((p, i - 1));
                }
            }
        }
    }
    None
}

fn polyline_length(p: &[Pt]) -> f64 {
    p.windows(2).map(|w| geo::dist(w[0], w[1])).sum()
}

/// The point `len` before the end of `p` (what is left after `Polyline::clip_end(len)`).
fn clip_end_point(p: &[Pt], mut len: f64) -> Pt {
    let mut v = p.to_vec();
    while len > 0.0 && v.len() >= 2 {
        let last = v[v.len() - 1];
        let prev = v[v.len() - 2];
        let l = geo::dist(last, prev);
        if l > len {
            let t = (l - len) / l;
            let q = (
                prev.0 + ((last.0 - prev.0) as f64 * t) as i64,
                prev.1 + ((last.1 - prev.1) as f64 * t) as i64,
            );
            let n = v.len();
            v[n - 1] = q;
            break;
        }
        len -= l;
        v.pop();
    }
    v.last().copied().unwrap_or((0, 0))
}

/// `ensure_maximum_distance_polyline`: points on each line about `distance` apart, at least `min_points`.
fn ensure_maximum_distance_polyline(input: &[Vec<Pt>], distance: f64, min_points: usize) -> Vec<Vec<Pt>> {
    let mut result = Vec::new();
    for orig in input {
        if orig.is_empty() {
            continue;
        }
        let mut part = orig.clone();
        let len = polyline_length(&part);
        let mut line: Vec<Pt> = Vec::new();
        let mut current_distance = distance.max(geo::sc(0.1) as f64);
        if len < 2.0 * distance && min_points <= 1 {
            line.push(clip_end_point(&part, len / 2.0));
        } else {
            let mut optimal_end = part.len() - 1;
            if part.first() == part.last() {
                // A closed outline: start at one of the two vertices farthest apart, and add the other.
                let mut start = 0;
                let mut max_d2 = 0.0;
                let n = part.len();
                for i in 0..n - 1 {
                    for j in 0..n - 1 {
                        let d = geo::dist2(part[i], part[j]) as f64;
                        if d > max_d2 {
                            start = i;
                            optimal_end = j;
                            max_d2 = d;
                        }
                    }
                }
                part[..n - 1].rotate_left(start);
                part[n - 1] = part[0];
                optimal_end = (n + optimal_end - start - 1) % (n - 1);
            }
            while line.len() < min_points && current_distance >= geo::sc(0.1) as f64 {
                line.clear();
                let mut current = part[0];
                line.push(part[0]);
                if min_points > 1 || geo::dist(part[0], part[optimal_end]) > current_distance {
                    line.push(part[optimal_end]);
                }
                let mut current_index = 0;
                let mut next_distance = current_distance;
                while let Some((np, ni)) = sample_next(&part, current, current_index, next_distance) {
                    let min_d = line.iter().map(|&p| geo::dist(p, np)).fold(f64::MAX, f64::min);
                    if min_d >= current_distance {
                        line.push(np);
                        current = np;
                        current_index = ni;
                        next_distance = current_distance;
                    } else {
                        if current == np {
                            if next_distance > 2.0 * current_distance {
                                break;
                            }
                            next_distance += current_distance;
                            continue;
                        }
                        next_distance = (current_distance - min_d).max(geo::sc(0.1) as f64);
                        current = np;
                        current_index = ni;
                    }
                }
                current_distance *= 0.9;
            }
        }
        result.push(line);
    }
    result
}

/// `generate_support_infill_lines`: support base lines (or interface lines for a roof) over `area`.
fn infill_lines(
    area: &Shapes,
    p: &Params,
    roof: bool,
    layer: i64,
    support_infill_distance: i64,
) -> Vec<Vec<Pt>> {
    let (spacing, angle, density, rectilinear) = if roof {
        // Orca means the interface angle turned 45 degrees each way on alternate layers, but its expression
        // (`interface_angle + (layer_idx & 1) ? -45 : 45`) always yields -45; the intended turn is used here.
        let turn = if layer & 1 == 1 { -45.0 } else { 45.0 };
        (
            p.interface_spacing,
            p.base_angle + 90.0 + turn,
            p.top_interface_density,
            p.interface_rectilinear,
        )
    } else {
        let s = geo::sc(p.support_spacing) as f64;
        (
            p.support_spacing,
            p.base_angle,
            s / (s + support_infill_distance as f64),
            p.base_rectilinear,
        )
    };
    if density <= 0.0 {
        return Vec::new();
    }
    // The filler has no object box here, so each island's lines run on a lattice through the middle of its
    // own outline's box (`Fill::_infill_direction`).
    let mut out = Vec::new();
    for island in geo::union(area) {
        let outline: Shapes = vec![vec![island[0].clone()]];
        let Some(b) = geo::bbox(&outline) else { continue };
        let center = [
            ((b[0] + b[2]) / 2) as f64 / crate::geom::SCALE,
            ((b[1] + b[3]) / 2) as f64 / crate::geom::SCALE,
        ];
        let one = vec![island];
        let lines = if rectilinear {
            crate::patterns::support_lines(&one, spacing, spacing / density, angle, false, 0.0, center)
        } else {
            crate::supportfill::support_base(&one, spacing, density, angle, center)
        };
        out.extend(lines.into_iter().map(|l| {
            l.into_iter()
                .map(|q| (i64::from(q.x), i64::from(q.y)))
                .collect::<Vec<Pt>>()
        }));
    }
    out
}

/// Every tip and roof decision one overhang layer makes, replayed in layer order so the result does not
/// depend on threads.
#[derive(Default)]
pub(crate) struct Log {
    ops: Vec<Op>,
}

enum Op {
    Roof {
        rings: Vec<geo::Ring>,
        layer: i64,
        dtt: usize,
    },
    Point {
        p: (Pt, LineStatus),
        layer: i64,
        dont_move_until: usize,
        roof: bool,
        recovery: usize,
        skip_ovalisation: bool,
    },
}

/// `RichInterfacePlacer`'s state shared by the tips of one overhang layer.
struct Rich<'a> {
    volumes: &'a Volumes,
    cfg: &'a Settings,
    params: &'a Params,
    force_tip_to_roof: bool,
    log: Log,
}

impl Rich<'_> {
    fn add_roof(&mut self, rings: Vec<geo::Ring>, layer: i64, dtt: usize) {
        if !rings.is_empty() {
            self.log.ops.push(Op::Roof { rings, layer, dtt });
        }
    }

    /// `add_points_along_lines`.
    fn add_points_along_lines(
        &mut self,
        mut lines: Vec<LineInfo>,
        insert_layer: i64,
        roof_tip_layers: usize,
        supports_roof_layers: usize,
        dont_move_until: usize,
    ) {
        let mut dtt_roof_tip = 0usize;
        while dtt_roof_tip < roof_tip_layers && insert_layer - dtt_roof_tip as i64 >= 1 {
            let this_layer = insert_layer - dtt_roof_tip as i64;
            let recovery = dtt_roof_tip + supports_roof_layers;
            let (kept, freed) = split_lines(&lines, |p| {
                valid_next_layer(self.volumes, self.cfg, this_layer, p)
            });
            // Every roof is taken to print lines, so none is moved to the points.
            lines = kept;
            for line in &freed {
                for &pd in line {
                    self.log.ops.push(Op::Point {
                        p: pd,
                        layer: this_layer,
                        dont_move_until: roof_tip_layers - dtt_roof_tip,
                        roof: recovery > 0,
                        recovery,
                        skip_ovalisation: false,
                    });
                }
            }
            let base = Params::base_circle(self.cfg.min_radius);
            let mut roofs: Vec<geo::Ring> = Vec::new();
            for line in &lines {
                for &(q, _) in line {
                    roofs.push(geo::ring_at(&base, q));
                }
            }
            self.add_roof(roofs, this_layer, recovery);
            dtt_roof_tip += 1;
        }
        let recovery = dtt_roof_tip + supports_roof_layers;
        for line in &lines {
            let disable_ovalisation = self.cfg.min_radius < 3 * self.cfg.support_line_width
                && roof_tip_layers == 0
                && dtt_roof_tip == 0
                && line.len() > 5;
            for &pd in line {
                self.log.ops.push(Op::Point {
                    p: pd,
                    layer: insert_layer - dtt_roof_tip as i64,
                    dont_move_until: dont_move_until.saturating_sub(dtt_roof_tip),
                    roof: recovery > 0,
                    recovery,
                    skip_ovalisation: disable_ovalisation,
                });
            }
        }
    }
}

/// `sample_overhang_area`.
fn sample_overhang_area(
    rich: &mut Rich<'_>,
    mut overhang_area: Shapes,
    large_horizontal_roof: bool,
    layer_idx: i64,
    num_roof_layers: usize,
    connect_length: i64,
) {
    let cfg = rich.cfg;
    let volumes = rich.volumes;
    let params = rich.params;
    let min_xy = cfg.xy_distance > cfg.xy_min_distance;
    let r0 = cfg.get_radius(0, 0.0);
    let roof_lines =
        |a: &Shapes, layer: i64| infill_lines(a, params, true, layer, cfg.support_roof_line_distance);
    let mut overhang_lines: Vec<LineInfo> = Vec::new();
    let mut dtt_roof = 0usize;
    if large_horizontal_roof {
        let mut added_roofs: Vec<Shapes> = vec![Vec::new(); num_roof_layers];
        let mut last_overhang = overhang_area.clone();
        while dtt_roof < num_roof_layers && layer_idx - dtt_roof as i64 >= 1 {
            let raw = if cfg.support_rests_on_model {
                volumes.collision(r0, layer_idx - (dtt_roof as i64 + 1), min_xy)
            } else {
                volumes.avoidance(
                    r0,
                    layer_idx - (dtt_roof as i64 + 1),
                    AvoidanceType::Fast,
                    false,
                    min_xy,
                )
            };
            let forbidden_next = geo::offset_miter(&raw, geo::sc(0.005) as f64);
            let next = geo::diff(&overhang_area, &forbidden_next);
            if geo::area(&next) < cfg.minimum_roof_area {
                if dtt_roof > 0 {
                    let dtt_before = dtt_roof - 1;
                    let lay = layer_idx - dtt_before as i64;
                    let pts = ensure_maximum_distance_polyline(
                        &roof_lines(&last_overhang, lay),
                        connect_length as f64,
                        1,
                    );
                    let lines = convert_lines_to_internal(volumes, cfg, &pts, lay);
                    overhang_lines = split_lines(&lines, |p| valid_next_layer(volumes, cfg, lay, p)).0;
                }
                break;
            }
            added_roofs[dtt_roof].clone_from(&overhang_area);
            last_overhang = std::mem::replace(&mut overhang_area, next);
            dtt_roof += 1;
        }
        if overhang_lines.is_empty()
            && dtt_roof != 0
            && roof_lines(&overhang_area, layer_idx - (dtt_roof.max(1) - 1) as i64).is_empty()
        {
            for (idx, roof) in added_roofs.iter().enumerate().take(dtt_roof) {
                if roof_lines(roof, layer_idx - idx as i64).is_empty() {
                    dtt_roof = idx;
                    break;
                }
            }
        }
        added_roofs.truncate(dtt_roof);
        for (idx, r) in added_roofs.into_iter().enumerate() {
            if !r.is_empty() {
                let rings: Vec<geo::Ring> = geo::rings(&r).cloned().collect();
                rich.add_roof(rings, layer_idx - idx as i64, idx);
            }
        }
    }
    if overhang_lines.is_empty() {
        let supports_roof = dtt_roof > 0;
        let continuous_tips = !supports_roof && large_horizontal_roof;
        let distance = if supports_roof {
            cfg.support_roof_line_distance
        } else {
            cfg.support_tree_branch_distance
        };
        let gen_layer = layer_idx - (dtt_roof.max(1) - 1) as i64;
        let lines = if supports_roof {
            roof_lines(&overhang_area, gen_layer)
        } else {
            infill_lines(&overhang_area, params, false, gen_layer, distance)
        };
        let mut polylines = ensure_maximum_distance_polyline(
            &lines,
            if continuous_tips {
                (cfg.min_radius / 2) as f64
            } else {
                connect_length as f64
            },
            1,
        );
        let point_count: usize = polylines.iter().map(Vec::len).sum();
        let min_support_points =
            1.max(3.min((geo::total_length(&overhang_area) / connect_length as f64) as i64)) as usize;
        if point_count <= min_support_points {
            // Too few points: tips along the outline instead, pulled in so the tip circles cover it.
            let reduced = geo::offset_miter(&overhang_area, -(cfg.support_line_width as f64 / 2.2));
            let use_reduced = !reduced.is_empty() && {
                let rest = geo::diff(&overhang_area, &reduced);
                geo::area(&geo::offset_miter(
                    &rest,
                    cfg.support_line_width.max(connect_length) as f64,
                )) < geo::tiny_area()
            };
            let src = if use_reduced { &reduced } else { &overhang_area };
            polylines = ensure_maximum_distance_polyline(
                &geo::to_polylines(src),
                connect_length as f64,
                min_support_points,
            );
        }
        overhang_lines = convert_lines_to_internal(volumes, cfg, &polylines, layer_idx - dtt_roof as i64);
    }
    if dtt_roof as i64 >= layer_idx && large_horizontal_roof {
        // The roof reached the bed.
        let rings: Vec<geo::Ring> = geo::rings(&overhang_area).cloned().collect();
        rich.add_roof(rings, 0, dtt_roof.min(params.num_top_interface_layers));
    } else {
        let roof_enabled = num_roof_layers > 0;
        rich.add_points_along_lines(
            overhang_lines,
            layer_idx - dtt_roof as i64,
            if rich.force_tip_to_roof {
                num_roof_layers - dtt_roof
            } else {
                0
            },
            dtt_roof,
            if roof_enabled {
                num_roof_layers - dtt_roof
            } else {
                0
            },
        );
    }
}

/// `generate_initial_areas`: the tips (into `move_bounds`) and roofs (into `placer`) under every overhang.
pub(crate) fn generate_initial_areas(
    volumes: &Volumes,
    cfg: &Settings,
    params: &Params,
    overhangs: &[Shapes],
    move_bounds: &mut [Vec<Element>],
    placer: &mut Placer,
) {
    let z_distance_delta = cfg.z_distance_top_layers + 1;
    let min_xy = cfg.xy_distance > cfg.xy_min_distance;
    let connect_length = (cfg.support_line_width as f64 * 100.0 / cfg.support_tree_top_rate
        + (2.0 * cfg.min_radius as f64 - cfg.support_line_width as f64).max(0.0))
        as i64;
    let circle_length_to_half_linewidth_change = if cfg.min_radius < cfg.support_line_width {
        cfg.min_radius / 2
    } else {
        let r = cfg.min_radius as f64;
        let h = (cfg.min_radius - cfg.support_line_width / 2) as f64;
        (r * r - h * h).sqrt() as i64
    };
    let extra_outset = 0.max(cfg.min_radius - cfg.support_line_width / 2)
        + if min_xy { cfg.support_line_width / 2 } else { 0 };
    let num_roof_layers = cfg.support_roof_layers;
    let roof_enabled = num_roof_layers > 0;
    let r_min = cfg.min_radius as f64;
    let force_tip_to_roof = roof_enabled
        && (params.zero_gap_interface_top || r_min * r_min * std::f64::consts::PI > cfg.minimum_roof_area);
    let num_raft = params.num_raft_layers;
    let first_support_layer = (num_raft as i64 - z_distance_delta as i64).max(1) as usize;
    let num_support_layers = (overhangs.len() as i64 - z_distance_delta as i64).max(0) as usize;
    let raw: Vec<usize> = (first_support_layer..num_support_layers)
        .filter(|&l| overhangs.get(l + z_distance_delta).is_some_and(|o| !o.is_empty()))
        .collect();
    let r0 = cfg.get_radius(0, 0.0);
    let logs: Vec<Log> = crate::par::map(&raw, |&layer| {
        let layer_idx = layer as i64;
        let overhang_raw = &overhangs[layer + z_distance_delta];
        let mut rich = Rich {
            volumes,
            cfg,
            params,
            force_tip_to_roof,
            log: Log::default(),
        };
        let forbidden_raw = if cfg.support_rests_on_model {
            volumes.collision(r0, layer_idx, min_xy)
        } else {
            volumes.avoidance(r0, layer_idx, AvoidanceType::Fast, false, min_xy)
        };
        let relevant_forbidden = geo::offset_miter(&forbidden_raw, geo::sc(0.005) as f64);
        let mut overhang_regular = safe_offset_inc(
            overhang_raw,
            cfg.support_offset,
            &relevant_forbidden,
            (r_min * 1.75) as i64 + cfg.xy_min_distance,
            0,
            1,
        );
        let base = if cfg.support_offset == 0 {
            overhang_raw.clone()
        } else {
            geo::offset_miter(overhang_raw, cfg.support_offset as f64)
        };
        let mut remaining = geo::inter(
            &geo::diff(
                &base,
                &geo::offset_miter(&overhang_regular, cfg.support_line_width as f64 * 0.5),
            ),
            &relevant_forbidden,
        );
        let mut acc = 0i64;
        while !remaining.is_empty() && acc + cfg.support_line_width / 8 < extra_outset {
            let step = if acc + 2 * cfg.support_line_width > cfg.min_radius {
                cfg.support_line_width / 8
            } else {
                circle_length_to_half_linewidth_change
            }
            .min(extra_outset - acc);
            acc += step;
            let raw_collision = volumes.collision(0, layer_idx, true);
            let offset_step = cfg.xy_min_distance + cfg.support_line_width;
            remaining = geo::diff(
                &remaining,
                &safe_offset_inc(
                    &overhang_regular,
                    (1.5 * acc as f64) as i64,
                    &raw_collision,
                    offset_step,
                    0,
                    1,
                ),
            );
            overhang_regular = geo::union2(
                &overhang_regular,
                &geo::diff(
                    &safe_offset_inc(&remaining, acc, &raw_collision, offset_step, 0, 1),
                    &relevant_forbidden,
                ),
            );
        }
        if roof_enabled {
            let mut roofs = safe_offset_inc(
                overhang_raw,
                0,
                &relevant_forbidden,
                cfg.min_radius * 2 + cfg.xy_min_distance,
                0,
                1,
            );
            if cfg.minimum_support_area > 0.0 {
                geo::remove_small(&mut roofs, cfg.minimum_roof_area);
            }
            overhang_regular = geo::diff(&overhang_regular, &roofs);
            for part in geo::union(&roofs) {
                sample_overhang_area(
                    &mut rich,
                    vec![part],
                    true,
                    layer_idx,
                    num_roof_layers,
                    connect_length,
                );
            }
        }
        if cfg.minimum_support_area > 0.0 {
            geo::remove_small(&mut overhang_regular, cfg.minimum_support_area);
        }
        for part in geo::union(&overhang_regular) {
            sample_overhang_area(
                &mut rich,
                vec![part],
                false,
                layer_idx,
                num_roof_layers,
                connect_length,
            );
        }
        rich.log
    });
    // Replay in layer order.
    let base_circle = Params::base_circle(geo::sc(0.01));
    let mut inserted: Vec<HashSet<Pt>> = vec![HashSet::new(); num_support_layers.max(move_bounds.len())];
    let hash_div = ((cfg.min_radius + 1) / 10).max(1);
    for log in logs {
        for op in log.ops {
            match op {
                Op::Roof { rings, layer, dtt } => placer.add_roof(rings, layer, dtt),
                Op::Point {
                    p,
                    layer,
                    dont_move_until,
                    roof,
                    recovery,
                    skip_ovalisation,
                } => {
                    let to_bp = matches!(p.1, LineStatus::ToBp | LineStatus::ToBpSafe);
                    let gracious =
                        to_bp || matches!(p.1, LineStatus::ToModelGracious | LineStatus::ToModelGraciousSafe);
                    let safe = matches!(p.1, LineStatus::ToBpSafe | LineStatus::ToModelGraciousSafe);
                    if !cfg.support_rests_on_model && !to_bp {
                        continue;
                    }
                    let Some(set) = inserted.get_mut(layer as usize) else {
                        continue;
                    };
                    let hash = (p.0.0 / hash_div, p.0.1 / hash_div);
                    if !set.insert(hash) {
                        continue;
                    }
                    let mut state = State {
                        target_height: layer,
                        target_position: p.0,
                        next_position: p.0,
                        layer_idx: layer,
                        effective_radius_height: 0,
                        to_buildplate: to_bp,
                        distance_to_top: 0,
                        result_on_layer: Some(p.0),
                        increased_to_model_radius: 0,
                        to_model_gracious: gracious,
                        elephant_foot_increases: 0.0,
                        use_min_xy_dist: min_xy,
                        supports_roof: roof,
                        dont_move_until: dont_move_until as u32,
                        can_use_safe_radius: safe,
                        skip_ovalisation,
                        ..State::default()
                    };
                    state.set_pending_roof_recovery(
                        if force_tip_to_roof {
                            dont_move_until as u32
                        } else {
                            0
                        },
                        recovery as u32,
                    );
                    let circle = vec![vec![geo::ring_at(&base_circle, p.0)]];
                    if let Some(mb) = move_bounds.get_mut(layer as usize) {
                        mb.push(Element {
                            state,
                            parents: Vec::new(),
                            influence_area: circle,
                        });
                    }
                }
            }
        }
    }
    let _ = round_up_divide;
}
