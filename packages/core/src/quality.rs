// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Overhang speed along each wall and bridge, point by point, and the curl estimate it can read.
//!
//! The algorithm is the one `OrcaSlicer` 2.4.2 runs while writing G-code (`GCode/ExtrusionProcessor.hpp`:
//! `estimate_points_properties`, `ExtrusionQualityEstimator::estimate_extrusion_quality`; `PrusaSlicer` has
//! the same code, Bambu Studio keeps step speeds per overhang degree). Every point of a path gets its
//! distance past the layer below (the signed distance to the lower slice plus half the bead), points are
//! added where the path crosses that edge and around it, and each stretch takes the speed interpolated
//! from six overlap levels (90, 75, 50, 25, 13 and 0 percent of the bead resting on the layer below) whose
//! speeds are the wall speed, the four `overhang_*_speed` values and the bridge speed. A speed within
//! 1 mm/s of the last one written is not written again, as Orca's writer does.
//!
//! `slowdown_for_curled_perimeters` adds Orca's curl estimate (`SupportSpotsGenerator::
//! estimate_malformations`): how far each stretch of the outer wall curls up, from how far it hangs past
//! the outer wall below, how sharply it turns and how much the wall below curled. Stretches near curled
//! wall of the layer below are slowed as if they hung further out.

use crate::fm::Fm as _;
use crate::overhang::{Support, seg_dist2};
use crate::perimeters::Shapes;
use i_overlay::i_float::int::point::IntPoint;

type Pt = IntPoint<i32>;

/// Orca's `EPSILON`.
const EPSILON: f64 = 1e-4;
/// Overlap levels in percent, from the most supported (Orca `overhang_overlap_levels`).
const OVERLAPS: [f64; 6] = [90.0, 75.0, 50.0, 25.0, 13.0, 0.0];
/// `SupportSpotsGenerator::Params`.
const BRIDGE_DISTANCE: f32 = 16.0;
const MALFORMATION_FACTORS: (f32, f32) = (0.2, 1.1);
const MAX_CURLED_HEIGHT_FACTOR: f32 = 10.0;
const CURLING_TOLERANCE: f32 = 0.1;

/// A point of a path with what the estimator knows about it, mm.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ExtPoint {
    pub x: f64,
    pub y: f64,
    /// Distance past the edge of the layer below (signed modes: negative inside).
    pub distance: f32,
    pub curvature: f32,
    /// Index of the input point this is, or `None` for a point the estimator added.
    pub src: Option<usize>,
}

fn to_pt(x: f64, y: f64) -> Pt {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "positions on the bed in internal units"
    )]
    Pt::new(
        (x * crate::geom::SCALE).round() as i32,
        (y * crate::geom::SCALE).round() as i32,
    )
}

/// The lines of the layer below a point is measured against.
pub(crate) struct Lines<'a> {
    pub support: &'a Support,
    /// Negative inside the region (a slice outline), else plain distance to the nearest line.
    pub signed: bool,
}

impl Lines<'_> {
    #[allow(clippy::cast_possible_truncation, reason = "distances of a few mm")]
    fn distance(&self, x: f64, y: f64) -> f32 {
        let p = to_pt(x, y);
        if self.signed {
            self.support.signed_distance(p) as f32
        } else {
            self.support.nearest(p).map_or(f32::INFINITY, |(d, _)| d as f32)
        }
    }

    fn crossings(&self, a: (f64, f64), b: (f64, f64)) -> Vec<(f64, f64)> {
        let mut hits = Vec::new();
        self.support
            .crossings(to_pt(a.0, a.1), to_pt(b.0, b.1), &mut hits);
        hits.iter()
            .map(|(_, p)| {
                (
                    f64::from(p.x) / crate::geom::SCALE,
                    f64::from(p.y) / crate::geom::SCALE,
                )
            })
            .collect()
    }
}

fn norm(dx: f64, dy: f64) -> f64 {
    dx.m_hypot(dy)
}

/// Orca `estimate_points_properties` with intersections added. `offset_boundary` adds half the width to
/// every distance and cuts stretches near the edge (`PREV_LAYER_BOUNDARY_OFFSET`); `max_line_length`
/// above zero splits long segments; `min_distance` limits the cuts to stretches that will slow down.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::too_many_lines,
    reason = "Orca mixes float and double the same way"
)]
pub(crate) fn estimate_points(
    input: &[(f64, f64)],
    lines: &Lines<'_>,
    flow_width: f32,
    offset_boundary: bool,
    max_line_length: f32,
    min_distance: f32,
) -> Vec<ExtPoint> {
    let (Some(first), Some(last)) = (input.first(), input.last()) else {
        return Vec::new();
    };
    let looped = to_pt(first.0, first.1) == to_pt(last.0, last.1);
    let prev_index = |idx: usize, count: usize| -> usize {
        if looped {
            if idx == 0 { count - 1 } else { idx - 1 }
        } else {
            idx.saturating_sub(1)
        }
    };
    let next_index = |idx: usize, count: usize| -> usize {
        if looped {
            if idx + 1 == count { 0 } else { idx + 1 }
        } else if idx + 1 < count {
            idx + 1
        } else {
            idx
        }
    };
    let min_spacing = f64::from(flow_width) * 0.25;
    let bo: f32 = if offset_boundary { 0.5 * flow_width } else { 0.0 };
    let far = |a: &ExtPoint, x: f64, y: f64| norm(x - a.x, y - a.y) > min_spacing;

    let mut points: Vec<ExtPoint> = Vec::with_capacity(input.len() * 3 / 2);
    points.push(ExtPoint {
        x: first.0,
        y: first.1,
        distance: lines.distance(first.0, first.1) + bo,
        curvature: 0.0,
        src: Some(0),
    });
    for (i, &(x, y)) in input.iter().enumerate().skip(1) {
        let next = ExtPoint {
            x,
            y,
            distance: lines.distance(x, y) + bo,
            curvature: 0.0,
            src: Some(i),
        };
        if let Some(prev) = points.last().copied() {
            let edge = f64::from(bo) + EPSILON;
            if (f64::from(prev.distance) > edge) != (f64::from(next.distance) > edge) {
                for (ix, iy) in lines.crossings((prev.x, prev.y), (x, y)) {
                    if far(&prev, ix, iy) && norm(x - ix, y - iy) > min_spacing {
                        points.push(ExtPoint {
                            x: ix,
                            y: iy,
                            distance: bo,
                            curvature: 0.0,
                            src: None,
                        });
                    }
                }
            }
        }
        points.push(next);
    }

    // Stretches near the edge are cut where the slowdown starts and ends.
    if offset_boundary {
        let mut out: Vec<ExtPoint> = Vec::with_capacity(points.len() * 2);
        if let Some(f) = points.first() {
            out.push(*f);
        }
        for w in points.windows(2) {
            let [curr, next] = w else { continue };
            let near = |d: f32| d > -bo && d < bo + 2.0;
            if near(curr.distance) || near(next.distance) {
                let line_len = norm(next.x - curr.x, next.y - curr.y);
                let worth = if min_distance > 0.0 {
                    (curr.distance.abs() > min_distance || next.distance.abs() > min_distance)
                        && line_len >= 2.0
                } else {
                    line_len > 4.0
                };
                if worth {
                    let a0 = (f64::from(curr.distance + 3.0 * bo) / line_len).clamp(0.0, 1.0);
                    let a1 = (1.0 - f64::from(next.distance + 3.0 * bo) / line_len).clamp(0.0, 1.0);
                    let (t0, t1) = (a0.min(a1), a0.max(a1));
                    let mut cut = |t: f64| {
                        let (px, py) = (curr.x + t * (next.x - curr.x), curr.y + t * (next.y - curr.y));
                        let raw = lines.distance(px, py);
                        if (raw.abs() > min_distance || min_distance <= 0.0)
                            && far(curr, px, py)
                            && norm(next.x - px, next.y - py) > min_spacing
                        {
                            out.push(ExtPoint {
                                x: px,
                                y: py,
                                distance: raw + bo,
                                curvature: 0.0,
                                src: None,
                            });
                        }
                    };
                    if t0 < 1.0 {
                        cut(t0);
                    }
                    if t1 > 0.0 {
                        cut(t1);
                    }
                }
            }
            out.push(*next);
        }
        points = out;
    }

    if max_line_length > 0.0 {
        let mut out: Vec<ExtPoint> = Vec::with_capacity(points.len() * 2);
        for w in points.windows(2) {
            let [curr, next] = w else { continue };
            out.push(*curr);
            let len2 = (next.x - curr.x).m_powi(2) + (next.y - curr.y).m_powi(2);
            let t = (f64::from(max_line_length) * f64::from(max_line_length) / len2).sqrt();
            let count = (1.0 / t) as usize;
            for j in 1..=count {
                let k = j as f64 * t;
                let (px, py) = (curr.x * (1.0 - k) + next.x * k, curr.y * (1.0 - k) + next.y * k);
                if far(curr, px, py) && norm(next.x - px, next.y - py) > min_spacing {
                    let distance = lines.distance(px, py) + bo;
                    out.push(ExtPoint {
                        x: px,
                        y: py,
                        distance,
                        curvature: 0.0,
                        src: None,
                    });
                }
            }
        }
        if let Some(l) = points.last() {
            out.push(*l);
        }
        points = out;
    }

    // Curvature over windows of 3, 9 and 16 mm, keeping the largest.
    let n = points.len();
    let step: Vec<f32> = (0..n)
        .map(|i| {
            let (a, b) = (points[i], points[prev_index(i, n)]);
            norm(b.x - a.x, b.y - a.y) as f32
        })
        .collect();
    let total: f32 = step.iter().sum();
    if f64::from(total) > EPSILON {
        for window in [3.0f32, 9.0, 16.0] {
            let half = f64::from(window) * 0.5;
            for i in 0..n {
                let cur = points[i];
                let mut back = (cur.x, cur.y);
                let (mut k, mut dist) = (i, 0.0f32);
                while f64::from(dist) < half && k != prev_index(k, n) {
                    let pk = prev_index(k, n);
                    let line = step[pk];
                    if f64::from(dist + line) > half {
                        let (dx, dy) = (points[pk].x - points[k].x, points[pk].y - points[k].y);
                        let l = norm(dx, dy);
                        let r = half - f64::from(dist);
                        back = if l > 0.0 {
                            (points[k].x + r * dx / l, points[k].y + r * dy / l)
                        } else {
                            (points[k].x, points[k].y)
                        };
                        dist += (half - f64::from(dist) + EPSILON) as f32;
                    } else {
                        dist += line;
                        k = pk;
                    }
                }
                let mut front = (cur.x, cur.y);
                let (mut k, mut dist) = (i, 0.0f32);
                while f64::from(dist) < half && k != next_index(k, n) {
                    let nk = next_index(k, n);
                    let line = step[k];
                    if f64::from(dist + line) > half {
                        let (dx, dy) = (points[nk].x - points[k].x, points[nk].y - points[k].y);
                        let l = norm(dx, dy);
                        let r = half - f64::from(dist);
                        front = if l > 0.0 {
                            (points[k].x + r * dx / l, points[k].y + r * dy / l)
                        } else {
                            (points[k].x, points[k].y)
                        };
                        dist += (half - f64::from(dist) + EPSILON) as f32;
                    } else {
                        dist += line;
                        k = nk;
                    }
                }
                let (v1x, v1y) = (cur.x - back.0, cur.y - back.1);
                let (v2x, v2y) = (front.0 - cur.x, front.1 - cur.y);
                let angle = (v1x * v2y - v1y * v2x).m_atan2(v1x * v2x + v1y * v2y);
                let curvature = (angle / f64::from(window)) as f32;
                if points[i].curvature.abs() < curvature.abs() {
                    points[i].curvature = curvature;
                }
            }
        }
    }
    points
}

/// The walls of one layer that curled up (Orca `CurledLine`), for the layer above.
#[derive(Debug, Default)]
pub(crate) struct Curled {
    lines: Support,
    heights: Vec<f32>,
}

/// One outer wall ring of a layer for the curl estimate.
pub(crate) struct CurlLayer {
    pub height: f32,
    /// Outer wall rings, closed (first point repeated), with the wall's width, mm.
    pub rings: Vec<(Vec<Pt>, f32)>,
    /// The slice of the layer (Orca `lslices`).
    pub slice: Shapes,
}

/// Orca `estimate_curled_up_height`.
fn curled_up_height(distance: f32, curvature: f32, layer_height: f32, flow_width: f32, prev: f32) -> f32 {
    let mut h = 0.0f32;
    if distance.abs() < 3.0 * flow_width {
        h = (prev - layer_height * 0.75).max(0.0);
    }
    if distance > MALFORMATION_FACTORS.0 * flow_width && distance < MALFORMATION_FACTORS.1 * flow_width {
        let curling = distance;
        let swelling_radius = f32::midpoint(layer_height, curling);
        h += ((swelling_radius - layer_height) / 2.0).max(0.0);
        if curvature > 0.01 {
            let radius = 1.0 / curvature;
            let t = (radius / 100.0).sqrt();
            let b = t * flow_width;
            h += (curling * curling - b * b).max(0.0).sqrt();
        }
        h = h.min(MAX_CURLED_HEIGHT_FACTOR * layer_height);
    }
    h
}

/// Orca `estimate_malformations` over the layers of an object, bottom up: the curled stretches of every
/// layer's outer wall. The wall below is the outer wall of the layer below; the sign of a distance comes
/// from that layer's slice.
#[allow(clippy::cast_possible_truncation, reason = "distances of a few mm")]
pub(crate) fn curl_plan(layers: &[CurlLayer]) -> Vec<Curled> {
    // The geometry of each layer against the one below does not depend on the heights, so it runs in
    // parallel; the heights then build up layer by layer.
    struct Seg {
        a: Pt,
        b: Pt,
        distance: f32,
        curvature: f32,
        width: f32,
    }
    let count = u32::try_from(layers.len()).unwrap_or(0);
    // The outer wall of each layer as lines; distances to the lines do not depend on how they are split.
    let walls: Vec<Support> = crate::par::map_range(0..count, |l| {
        let mut edges = Vec::new();
        if let Some(layer) = layers.get(l as usize) {
            for (ring, _) in &layer.rings {
                edges.extend(ring.windows(2).map(|w| [w[0], w[1]]));
            }
        }
        Support::from_edges(edges)
    });
    let segs: Vec<Vec<Seg>> = crate::par::map_range(0..count, |l| {
        let l = l as usize;
        let Some(layer) = layers.get(l) else {
            return Vec::new();
        };
        let empty = Support::default();
        let prev_lines = l.checked_sub(1).and_then(|k| walls.get(k)).unwrap_or(&empty);
        let prev_slice = l
            .checked_sub(1)
            .and_then(|k| layers.get(k))
            .map(|p| Support::new(&p.slice))
            .unwrap_or_default();
        let lines = Lines {
            support: prev_lines,
            signed: false,
        };
        let mut out = Vec::new();
        for (ring, width) in &layer.rings {
            let pts: Vec<(f64, f64)> = ring
                .iter()
                .map(|p| {
                    (
                        f64::from(p.x) / crate::geom::SCALE,
                        f64::from(p.y) / crate::geom::SCALE,
                    )
                })
                .collect();
            let ann = estimate_points(&pts, &lines, *width, false, BRIDGE_DISTANCE, -1.0);
            for i in 0..ann.len() {
                let (a, b) = (ann[i.saturating_sub(1)], ann[i]);
                let mid = to_pt(f64::midpoint(a.x, b.x), f64::midpoint(a.y, b.y));
                let dist = prev_lines.nearest(mid).map_or(f32::INFINITY, |(d, _)| d as f32);
                let sign = if (prev_slice.signed_distance(mid) as f32 + 0.5 * width) < 0.0 {
                    -1.0
                } else {
                    1.0
                };
                out.push(Seg {
                    a: to_pt(a.x, a.y),
                    b: to_pt(b.x, b.y),
                    distance: dist * sign,
                    curvature: f32::midpoint(a.curvature, b.curvature),
                    width: *width,
                });
            }
        }
        out
    });
    // Each line takes over what the nearest line of the wall below curled (that layer's annotated lines,
    // in order, as Orca indexes them).
    let lines_of: Vec<Support> = crate::par::map_range(0..count, |l| {
        Support::from_edges(
            segs.get(l as usize)
                .map_or(Vec::new(), |v| v.iter().map(|s| [s.a, s.b]).collect()),
        )
    });
    let mut prev_heights: Vec<f32> = Vec::new();
    let mut plan = Vec::with_capacity(layers.len());
    for (l, (layer, segs)) in layers.iter().zip(&segs).enumerate() {
        let below = l.checked_sub(1).and_then(|k| lines_of.get(k));
        let heights: Vec<f32> = segs
            .iter()
            .map(|s| {
                let mid = Pt::new(i32::midpoint(s.a.x, s.b.x), i32::midpoint(s.a.y, s.b.y));
                let prev = below
                    .and_then(|b| b.nearest(mid))
                    .and_then(|(_, k)| prev_heights.get(k).copied())
                    .unwrap_or(0.0);
                curled_up_height(s.distance, s.curvature, layer.height, s.width, prev)
            })
            .collect();
        let mut edges = Vec::new();
        let mut kept = Vec::new();
        for (s, h) in segs.iter().zip(&heights) {
            if *h > CURLING_TOLERANCE {
                edges.push([s.a, s.b]);
                kept.push(*h);
            }
        }
        plan.push(Curled {
            lines: Support::from_edges(edges),
            heights: kept,
        });
        prev_heights = heights;
    }
    plan
}

/// What one layer's walls and bridges need to set their speed point by point.
#[derive(Debug)]
pub(crate) struct Context {
    /// The slice of the layer below (Orca `lslices`).
    pub lower: std::sync::Arc<Support>,
    /// Curled stretches of the layer below, with `slowdown_for_curled_perimeters`.
    pub curled: Option<std::sync::Arc<Curled>>,
    /// `overhang_1_4_speed` to `overhang_4_4_speed` (0 when unset, a negative value is a percent of the wall).
    pub overhang: [f64; 4],
    pub bridge_speed: f64,
    pub outer_speed: f64,
    pub inner_speed: f64,
    /// `filament_max_volumetric_speed` per filament slot from 1, mm3/s (0 for none).
    pub max_volumetric: Vec<f64>,
    pub height: f32,
    /// Per filament slot from 1: the most of a bead that may rest on the layer below for the overhang fan to
    /// run (`overhang_fan_threshold` 10 to 95 percent as Orca reads it: 0.9, 0.75, 0.5, 0.25, 0.05), or None
    /// when the overhang fan is off or set to 0 percent (every outer wall, which the writer handles).
    pub fan_overlap: Vec<Option<f32>>,
}

/// Orca's overhang fan levels (`GCode::_extrude`, `check_overhang_fan`): the overlap at or under which a
/// stretch counts as overhanging for `overhang_fan_threshold`.
pub(crate) fn fan_overlap_limit(threshold: &str) -> Option<f32> {
    match threshold.trim() {
        "10%" => Some(0.9),
        "25%" => Some(0.75),
        "50%" => Some(0.5),
        "75%" => Some(0.25),
        "95%" => Some(0.05),
        _ => None,
    }
}

/// A filament setting's text for slot `slot` (from 1): its list entry, the last one, or the value itself.
fn slot_text(cfg: &crate::config::PrintConfig, key: &str, slot: u8) -> Option<String> {
    let text = |v: &serde_json::Value| match v {
        serde_json::Value::String(t) => Some(t.clone()),
        serde_json::Value::Bool(b) => Some(if *b { "1" } else { "0" }.to_owned()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    };
    match cfg.raw.get(key)? {
        serde_json::Value::Array(a) => a
            .get(usize::from(slot.max(1) - 1))
            .or_else(|| a.last())
            .and_then(text),
        v => text(v),
    }
}

/// `enable_overhang_speed` (on unless the settings turn it off, as in Orca).
pub(crate) fn overhang_speed_on(cfg: &crate::config::PrintConfig) -> bool {
    crate::tower::flag_or(cfg, "enable_overhang_speed", true)
}

/// A speed setting that may be a percent of the wall speed: mm/s, or minus the percent.
fn speed_or_percent(cfg: &crate::config::PrintConfig, key: &str) -> f64 {
    match cfg.raw.get(key) {
        Some(serde_json::Value::String(t)) if t.trim().ends_with('%') => -t
            .trim()
            .trim_end_matches('%')
            .trim()
            .parse::<f64>()
            .unwrap_or(0.0),
        Some(serde_json::Value::String(t)) => t.trim().parse().unwrap_or(0.0),
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

impl Context {
    pub(crate) fn new(
        cfg: &crate::config::PrintConfig,
        lower: std::sync::Arc<Support>,
        curled: Option<std::sync::Arc<Curled>>,
        height: f32,
    ) -> Self {
        let keys = [
            "overhang_1_4_speed",
            "overhang_2_4_speed",
            "overhang_3_4_speed",
            "overhang_4_4_speed",
        ];
        let overhang = keys.map(|k| speed_or_percent(cfg, k));
        Self {
            lower,
            curled,
            overhang,
            bridge_speed: cfg.bridge_speed,
            outer_speed: cfg.outer_wall_speed,
            inner_speed: cfg.inner_wall_speed,
            max_volumetric: (1..=64u8)
                .map(|slot| crate::tower::per_slot_raw(cfg, "filament_max_volumetric_speed", slot, 0.0))
                .collect(),
            height,
            fan_overlap: (1..=64u8)
                .map(|slot| {
                    let on = slot_text(cfg, "enable_overhang_bridge_fan", slot)
                        .map_or(cfg.enable_overhang_bridge_fan, |t| {
                            !matches!(t.trim(), "0" | "false")
                        });
                    if !on {
                        return None;
                    }
                    // Orca's default is 95 percent (bridges only).
                    fan_overlap_limit(
                        &slot_text(cfg, "overhang_fan_threshold", slot).unwrap_or_else(|| "95%".to_owned()),
                    )
                })
                .collect(),
        }
    }
}

/// One printed stretch: from the previous point to `to`, at `speed` mm/s, with the overhang fan on when `fan`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Stretch {
    pub to: ExtPoint,
    pub speed: f32,
    pub fan: bool,
}

impl Context {
    /// The speed of each stretch of a path (Orca `estimate_extrusion_quality` and the speed rules of
    /// `GCode::_extrude`), or None when no stretch differs from `speed` by more than 1 mm/s.
    /// `outer` tells an outer wall (reference speed the outer wall's) from the other walls and bridges.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::too_many_lines,
        reason = "speeds in float, as Orca keeps them"
    )]
    pub(crate) fn speeds(
        &self,
        pts: &[(f64, f64)],
        width: f32,
        mm3_per_mm: f64,
        speed: f32,
        outer: bool,
        tool: u8,
    ) -> Option<(ExtPoint, Vec<Stretch>)> {
        let max_volumetric = self
            .max_volumetric
            .get(usize::from(tool.max(1) - 1))
            .copied()
            .unwrap_or(0.0);
        let mut ref_speed = if outer { self.outer_speed } else { self.inner_speed };
        if ref_speed == 0.0 && mm3_per_mm > 0.0 {
            ref_speed = max_volumetric / mm3_per_mm;
        }
        if max_volumetric > 0.0 && mm3_per_mm > 0.0 {
            ref_speed = ref_speed.min(max_volumetric / mm3_per_mm);
        }
        let curled = self.curled.as_deref();
        let abs = |v: f64| if v < 0.0 { ref_speed * -v / 100.0 } else { v };
        let level = |v: f64| -> f64 {
            let v = abs(v);
            if v < 0.5 || ref_speed <= 0.0 {
                100.0
            } else {
                v * 100.0 / ref_speed
            }
        };
        let last = if curled.is_some() {
            level(self.overhang[3])
        } else {
            abs(self.bridge_speed) * 100.0 / ref_speed.max(1e-9)
        };
        let percents = [
            100.0,
            level(self.overhang[0]),
            level(self.overhang[1]),
            level(self.overhang[2]),
            level(self.overhang[3]),
            last,
        ];
        let mut sections: Vec<(f32, f32)> = OVERLAPS
            .iter()
            .zip(percents)
            .map(|(ov, pc)| {
                (
                    (f64::from(width) * (1.0 - ov / 100.0)) as f32,
                    (ref_speed * pc / 100.0) as f32,
                )
            })
            .collect();
        crate::sorting::sort_by(&mut sections, |a, b| {
            a.0.total_cmp(&b.0).then(b.1.total_cmp(&a.1))
        });
        let mut last_section = (f32::INFINITY, 0.0f32);
        for s in &mut sections {
            if s.0.to_bits() == last_section.0.to_bits() {
                s.1 = last_section.1;
            } else {
                last_section = *s;
            }
        }
        let min_distance = sections
            .iter()
            .filter(|s| s.1 <= speed)
            .map(|s| s.0)
            .fold(f32::INFINITY, f32::min);
        let min_distance = if min_distance.is_finite() {
            min_distance
        } else {
            -1.0
        };
        let lines = Lines {
            support: &self.lower,
            signed: true,
        };
        let ext = estimate_points(pts, &lines, width, true, -1.0, min_distance);
        let calc = |d: f32| -> f32 {
            let (Some(front), Some(back)) = (sections.first(), sections.last()) else {
                return speed;
            };
            let v = if d <= front.0 {
                speed
            } else if d >= back.0 {
                back.1
            } else {
                let mut k = 0;
                while sections.get(k + 1).is_some_and(|s| d > s.0) {
                    k += 1;
                }
                let (a, b) = (sections[k], sections[k + 1]);
                let t = ((d - a.0) / (b.0 - a.0)).clamp(0.0, 1.0);
                (1.0 - t) * a.1 + t * b.1
            };
            v.round()
        };
        let dist_limit = 10.0 * f64::from(width);
        let mut point_speeds: Vec<f32> = Vec::with_capacity(ext.len());
        // How much of the bead rests on the layer below at each point (Orca `ProcessedPoint::overlap`).
        let mut overlaps: Vec<f32> = Vec::with_capacity(ext.len());
        let width_inv = if width > 0.0 { 1.0 / width } else { 0.0 };
        for i in 0..ext.len() {
            let curr = ext[i];
            let next = ext[(i + 1).min(ext.len() - 1)];
            let mut artificial = 0.0f32;
            if let Some(c) = curled {
                let (mx, my) = (f64::midpoint(curr.x, next.x), f64::midpoint(curr.y, next.y));
                let mid = to_pt(mx, my);
                let mut found = c.lines.within(mid, dist_limit * crate::geom::SCALE);
                if !found.is_empty() {
                    let len = norm(next.x - curr.x, next.y - curr.y);
                    if len > 2.0 {
                        let (dx, dy) = ((next.x - curr.x) / len, (next.y - curr.y) / len);
                        let mut projected = 0.0;
                        for &k in &found {
                            let Some([a, b]) = c.lines.edge(k) else { continue };
                            if let Some((p, q)) =
                                clip_to_band(a, b, (curr.x, curr.y), (dx, dy), len, dist_limit)
                            {
                                projected += (dx * (q.0 - p.0) + dy * (q.1 - p.1)).abs();
                            }
                        }
                        if projected < 0.4 * len {
                            found.clear();
                        }
                    }
                    for &k in &found {
                        let Some(e) = c.lines.edge(k) else { continue };
                        let d = (seg_dist2(mid, &e).sqrt() / crate::geom::SCALE) as f32;
                        let h = c.heights.get(k).copied().unwrap_or(0.0);
                        let f = 1.0 - d / dist_limit as f32;
                        let v = width * f * f * (h / (self.height * 10.0));
                        artificial = artificial.max(v);
                    }
                }
            }
            let mut s = calc(curr.distance).min(calc(next.distance)).min(speed);
            if curled.is_some() {
                s = s.min(calc(artificial));
            }
            point_speeds.push(s);
            overlaps.push(
                (1.0 - (curr.distance + artificial) * width_inv)
                    .min(1.0 - (next.distance + artificial) * width_inv),
            );
        }
        if !point_speeds
            .iter()
            .any(|s| (f64::from(*s) - f64::from(speed)).abs() > 1.0)
        {
            return None;
        }
        // The writer's rule: a new speed is written only when it differs from the last one by more than
        // 1 mm/s, and one within 1 mm/s of the path's own speed is written as that speed.
        let first = *ext.first()?;
        let mut last_set = *point_speeds.first()?;
        let mut out = Vec::with_capacity(ext.len());
        let mut prev = first;
        // The overhang fan runs over a stretch whose both ends overhang past the threshold (Orca `_extrude`:
        // `pre_fan_enabled && cur_fan_enabled`).
        let limit = self
            .fan_overlap
            .get(usize::from(tool.max(1) - 1))
            .copied()
            .flatten();
        let fan_at = |i: usize| limit.is_some_and(|l| overlaps.get(i).is_some_and(|&o| o <= l));
        for (i, to) in ext.iter().enumerate().skip(1) {
            if norm(to.x - prev.x, to.y - prev.y) < EPSILON {
                continue;
            }
            prev = *to;
            let new_speed = point_speeds[i - 1];
            if (last_set - new_speed).abs() > 1.0 {
                last_set = new_speed;
            } else if (speed - new_speed).abs() <= 1.0 {
                last_set = speed;
            }
            out.push(Stretch {
                to: *to,
                speed: last_set,
                fan: fan_at(i - 1) && fan_at(i),
            });
        }
        Some((first, out))
    }
}

/// The part of segment `ab` inside the band of half-width `half` along the stretch from `start` in
/// direction `dir` over `len` mm (Orca's box of influence), mm.
fn clip_to_band(
    a: Pt,
    b: Pt,
    start: (f64, f64),
    dir: (f64, f64),
    len: f64,
    half: f64,
) -> Option<((f64, f64), (f64, f64))> {
    let s = crate::geom::SCALE;
    let (ax, ay) = (f64::from(a.x) / s - start.0, f64::from(a.y) / s - start.1);
    let (bx, by) = (f64::from(b.x) / s - start.0, f64::from(b.y) / s - start.1);
    // Coordinates along the stretch (u) and across it (v).
    let (au, av) = (ax * dir.0 + ay * dir.1, -ax * dir.1 + ay * dir.0);
    let (bu, bv) = (bx * dir.0 + by * dir.1, -bx * dir.1 + by * dir.0);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q, lo, hi) in [(au, bu - au, 0.0, len), (av, bv - av, -half, half)] {
        if q.abs() < 1e-12 {
            if p < lo || p > hi {
                return None;
            }
            continue;
        }
        let (ta, tb) = ((lo - p) / q, (hi - p) / q);
        t0 = t0.max(ta.min(tb));
        t1 = t1.min(ta.max(tb));
    }
    if t0 >= t1 {
        return None;
    }
    let at = |t: f64| (start.0 + ax + t * (bx - ax), start.1 + ay + t * (by - ay));
    Some((at(t0), at(t1)))
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;

    fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        let p = |x: f64, y: f64| to_pt(x, y);
        vec![vec![vec![p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]]]
    }

    fn ctx(lower: &Shapes) -> Context {
        Context {
            lower: std::sync::Arc::new(Support::new(lower)),
            curled: None,
            overhang: [0.0, 50.0, 30.0, 10.0],
            bridge_speed: 50.0,
            outer_speed: 200.0,
            inner_speed: 300.0,
            max_volumetric: Vec::new(),
            height: 0.2,
            fan_overlap: Vec::new(),
        }
    }

    #[test]
    fn a_wall_over_air_slows_where_it_leaves_the_layer_below() {
        // The layer below ends at x = 10; the wall runs from x = 0 to x = 20 at y = 5.
        let c = ctx(&square(0.0, 0.0, 10.0, 10.0));
        let (_, st) = c
            .speeds(&[(1.0, 5.0), (20.0, 5.0)], 0.45, 0.09, 200.0, true, 1)
            .unwrap();
        // Supported at the start, at the bridge speed where it hangs free.
        assert_eq!(st.first().unwrap().speed, 200.0);
        assert_eq!(st.last().unwrap().speed, 50.0);
        // The slowdown starts at the edge less half a bead and is cut there.
        let cut = st.iter().find(|s| s.speed < 200.0).unwrap();
        assert!(cut.to.x > 9.0 && cut.to.x < 11.0, "{cut:?}");
    }

    #[test]
    fn the_overhang_fan_follows_the_threshold() {
        // The same wall leaving the layer below at x = 10. At 95 percent (bridges only) the fan runs where the
        // bead hangs completely free; at 10 percent from where a tenth of it hangs past the edge; with none set,
        // never on its own.
        let wall = [(1.0, 5.0), (20.0, 5.0)];
        let fan_from = |limit: Option<f32>| {
            let mut c = ctx(&square(0.0, 0.0, 10.0, 10.0));
            c.fan_overlap = vec![limit];
            let (_, st) = c.speeds(&wall, 0.45, 0.09, 200.0, true, 1).unwrap();
            assert_eq!(st.last().unwrap().fan, limit.is_some());
            st.iter().find(|s| s.fan).map(|s| s.to.x)
        };
        assert_eq!(fan_overlap_limit("95%"), Some(0.05));
        assert_eq!(fan_overlap_limit("0%"), None);
        let (bridge, early) = (fan_from(Some(0.05)).unwrap(), fan_from(Some(0.9)).unwrap());
        assert!(early < bridge, "{early} {bridge}");
        assert!(fan_from(None).is_none());
    }

    #[test]
    fn a_supported_wall_keeps_its_speed() {
        let c = ctx(&square(0.0, 0.0, 30.0, 30.0));
        assert!(
            c.speeds(
                &[(1.0, 5.0), (20.0, 5.0), (20.0, 20.0)],
                0.45,
                0.09,
                200.0,
                true,
                1
            )
            .is_none()
        );
    }

    #[test]
    fn curling_needs_a_wall_hanging_past_the_one_below() {
        assert_eq!(curled_up_height(0.0, 0.0, 0.2, 0.45, 0.0), 0.0);
        let h = curled_up_height(0.3, 0.0, 0.2, 0.45, 0.0);
        assert!((h - 0.025).abs() < 1e-6, "{h}");
        // A sharp convex turn curls more.
        assert!(curled_up_height(0.3, 0.5, 0.2, 0.45, 0.0) > h);
        // What curled below settles by three quarters of a layer each layer.
        assert!((curled_up_height(0.0, 0.0, 0.2, 0.45, 1.0) - 0.85).abs() < 1e-6);
    }
}
