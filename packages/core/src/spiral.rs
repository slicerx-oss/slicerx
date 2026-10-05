// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Spiral vase mode (`spiral_mode`).
//!
//! Orca slices the layers above the solid base as the largest outline only (`SlicingMode::
//! PositiveLargestContour`), prints one wall and no infill there, and its `SpiralVase` post-processor
//! raises Z along each layer's single loop from the height of the layer below to its own. The layer
//! planner here does the same on paths: the loop gets a Z for every point, and the first layer ramps its
//! flow up while the last repeats the loop at constant Z with the flow ramping down.

use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::geom::Point;
use crate::output::{Feature, LayerPaths, PathInfo};
use crate::perimeters::Shapes;

/// What a vase layer needs besides the config.
#[derive(Debug, Clone)]
pub(crate) struct VaseLayer {
    /// The first layer printed as a spiral: the flow ramps up along it.
    pub first: bool,
    /// The last layer of the print: a loop at constant Z follows, with the flow ramping down.
    pub last: bool,
    /// The loop starts at the vertex nearest this point, so layers do not depend on each other.
    pub anchor: Point,
    /// `spiral_mode_smooth`: the loop of the layer below.
    pub blend: Option<Blend>,
}

/// The loop below a smoothed spiral layer and how far the blend reaches.
#[derive(Debug, Clone)]
pub(crate) struct Blend {
    pub below: Vec<Point>,
    pub max_xy: f64,
}

/// `spiral_mode_max_xy_smoothing`: mm, or a percent of the nozzle diameter (default 200%).
pub(crate) fn max_xy_smoothing(cfg: &PrintConfig) -> f64 {
    let nozzle = cfg.nozzle_diameter;
    match cfg.raw.get("spiral_mode_max_xy_smoothing") {
        Some(serde_json::Value::String(t)) if t.trim().ends_with('%') => t
            .trim()
            .trim_end_matches('%')
            .trim()
            .parse::<f64>()
            .map_or(2.0 * nozzle, |p| p * nozzle / 100.0),
        Some(_) => cfg.raw_number("spiral_mode_max_xy_smoothing", 2.0 * nozzle),
        None => 2.0 * nozzle,
    }
}

/// The point of the polyline `line` nearest `p` and its distance, mm.
fn nearest_on(p: Point, line: &[Point]) -> Option<(Point, f64)> {
    let (px, py) = (p.x_mm(), p.y_mm());
    let mut best: Option<(Point, f64)> = None;
    for w in line.windows(2) {
        let [a, b] = w else { continue };
        let (ax, ay) = (a.x_mm(), a.y_mm());
        let (dx, dy) = (b.x_mm() - ax, b.y_mm() - ay);
        let len2 = dx * dx + dy * dy;
        let t = if len2 > 0.0 {
            (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (cx, cy) = (ax + t * dx, ay + t * dy);
        let d = (px - cx).m_hypot(py - cy);
        if best.is_none_or(|(_, bd)| d < bd) {
            best = Some((Point::from_mm(cx, cy), d));
        }
    }
    best
}

pub(crate) fn enabled(cfg: &PrintConfig) -> bool {
    crate::firmware::truthy(cfg, "spiral_mode")
}

/// The number of solid base layers (Orca: `bottom_shell_layers`, then on while the layer tops stay
/// under `bottom_shell_thickness`). Layers from this index on are the spiral.
pub(crate) fn base_layers(cfg: &PrintConfig, count: u32, top: impl Fn(u32) -> f64) -> u32 {
    let mut n = cfg.bottom_shell_layers.min(count);
    while n < count && top(n) < cfg.bottom_shell_thickness - 1e-9 {
        n += 1;
    }
    n
}

/// A spiral layer uses the classic wall generator, as Orca does (`process_arachne` is skipped).
pub(crate) fn layer_cfg(cfg: &PrintConfig) -> PrintConfig {
    let mut c = cfg.clone();
    c.raw.insert(
        "wall_generator".to_owned(),
        serde_json::Value::String("classic".to_owned()),
    );
    c
}

/// The neighbor layer the surface classification looks at for `m`, from `layer`. Above the base nothing
/// is a top or a bottom surface, so every neighbor is the layer itself; the last base layer has nothing
/// above it, so it is all top surface.
pub(crate) fn neighbor(base: u32, layer: u32, m: i64) -> Option<i64> {
    if layer >= base && m != i64::from(layer) {
        Some(i64::from(layer))
    } else if layer + 1 == base && m > i64::from(layer) {
        None
    } else {
        Some(m)
    }
}

/// Only the largest outer contour of `shapes`, without holes.
pub(crate) fn largest_contour(shapes: &Shapes) -> Shapes {
    let best = shapes
        .iter()
        .filter_map(|s| s.first())
        .max_by_key(|c| crate::geom::area2_int(c).unsigned_abs());
    best.map(|c| vec![vec![c.clone()]]).unwrap_or_default()
}

/// Gives the wall loop of a planned layer its Z and flow per point. Layers with anything but walls (a
/// support, a brim, infill) stay as they are, as in Orca.
#[allow(clippy::cast_possible_truncation, reason = "coordinates and ratios are small")]
pub(crate) fn apply(out: &mut LayerPaths, cfg: &PrintConfig, v: &VaseLayer, relative_e: bool) {
    let wall = |f: Feature| matches!(f, Feature::OuterWall | Feature::OverhangWall | Feature::InnerWall);
    if out.paths.is_empty()
        || !out
            .paths
            .iter()
            .all(|p| wall(p.feature) || p.feature == Feature::GapFill)
        || !out.paths.iter().any(|p| wall(p.feature))
    {
        return;
    }
    let min_seg = (2.0 * cfg.raw_number("resolution", 0.01)).max(1e-4);
    // Walls first, with points closer than the minimum segment dropped.
    let mut points: Vec<Point> = Vec::with_capacity(out.points.len());
    let mut paths: Vec<PathInfo> = Vec::with_capacity(out.paths.len());
    let mut is_wall: Vec<bool> = Vec::with_capacity(out.paths.len());
    let mut total = 0.0_f64;
    for p in &out.paths {
        let src = out.path_points(p);
        let start = points.len();
        let mut last: Option<Point> = None;
        for &q in src {
            match last {
                Some(l) if wall(p.feature) => {
                    let d = l.dist_mm(q);
                    if d < min_seg {
                        continue;
                    }
                    total += d;
                }
                _ => {}
            }
            points.push(q);
            last = Some(q);
        }
        let mut info = *p;
        info.start = start as u32;
        info.end = points.len() as u32;
        if info.end >= info.start + 2 {
            paths.push(info);
            is_wall.push(wall(p.feature));
        } else {
            points.truncate(start);
        }
    }
    if total <= 0.0 || !paths.iter().zip(&is_wall).any(|(_, w)| *w) {
        return;
    }
    let z0 = f64::from(out.z) - f64::from(out.height);
    let h = f64::from(out.height);
    let start_flow = cfg.raw_number("spiral_starting_flow_ratio", 0.0).clamp(0.0, 1.0);
    let finish_flow = cfg.raw_number("spiral_finishing_flow_ratio", 0.0).clamp(0.0, 1.0);
    let ramp_in = v.first && relative_e;
    let ramp_out = v.last && !v.first && relative_e;
    let mut zs: Vec<f32> = vec![out.z; points.len()];
    let mut flows: Vec<f32> = vec![1.0; points.len()];
    // The fraction of the loop printed at each point, for the duplicate pass of the last layer.
    let mut frac: Vec<f64> = vec![1.0; points.len()];
    let mut len = 0.0_f64;
    // The loop below without its first point, which Orca does not record either (the travel to it is skipped).
    let below: Option<(&[Point], f64)> = v
        .blend
        .as_ref()
        .map(|b| (b.below.get(1..).unwrap_or_default(), b.max_xy));
    let mut last_xy: Option<Point> = below.and_then(|(b, _)| b.last().copied());
    let original = points.clone();
    let mut seen_first = false;
    for (p, w) in paths.iter().zip(&is_wall) {
        if !*w {
            continue;
        }
        let (s, e) = (p.start as usize, p.end as usize);
        let mut prev: Option<Point> = None;
        for i in s..e {
            let Some(&q) = original.get(i) else { continue };
            if let Some(l) = prev {
                len += l.dist_mm(q);
            }
            let at_start = prev.is_none();
            prev = Some(q);
            let f = (len / total).min(1.0);
            // Smooth spiral: the point moves toward the nearest point of the loop below, by the share of
            // the loop still to print; a move that ends up too short is dropped.
            if below.is_some() && seen_first && at_start {
                // A piece of the loop goes on where the last one ended.
                if let (Some(slot), Some(l)) = (points.get_mut(i), last_xy) {
                    *slot = l;
                }
            } else if let (Some((line, reach)), true) = (below, seen_first) {
                let target = match nearest_on(q, line) {
                    Some((near, d)) if d < reach => Some(Point::from_mm(
                        near.x_mm() * (1.0 - f) + q.x_mm() * f,
                        near.y_mm() * (1.0 - f) + q.y_mm() * f,
                    )),
                    _ => None,
                };
                let placed = match (target, last_xy) {
                    (Some(t), Some(l)) if l.dist_mm(t) < min_seg => l,
                    (Some(t), _) => t,
                    (None, _) => q,
                };
                last_xy = Some(placed);
                if let Some(slot) = points.get_mut(i) {
                    *slot = placed;
                }
            }
            seen_first = true;
            if let Some(z) = zs.get_mut(i) {
                *z = (z0 + f * h) as f32;
            }
            if let Some(fl) = flows.get_mut(i) {
                *fl = if ramp_in {
                    (start_flow + f * (1.0 - start_flow)) as f32
                } else {
                    1.0
                };
            }
            if let Some(x) = frac.get_mut(i) {
                *x = f;
            }
        }
    }
    if ramp_out {
        // The loop again at the top height, extruding less and less.
        let walls: Vec<PathInfo> = paths
            .iter()
            .zip(&is_wall)
            .filter(|(_, w)| **w)
            .map(|(p, _)| *p)
            .collect();
        for p in walls {
            let (s, e) = (p.start as usize, p.end as usize);
            let begin = points.len() as u32;
            for i in s..e {
                let Some(&q) = points.get(i) else { continue };
                points.push(q);
                zs.push(out.z);
                let f = frac.get(i).copied().unwrap_or(1.0);
                flows.push((finish_flow + (1.0 - f) * (1.0 - finish_flow)) as f32);
            }
            let mut dup = p;
            dup.start = begin;
            dup.end = points.len() as u32;
            paths.push(dup);
        }
    }
    out.points = points;
    out.paths = paths;
    out.zs = zs;
    out.flows = flows;
    out.spiral = true;
    out.spiral_start = v.first;
}
