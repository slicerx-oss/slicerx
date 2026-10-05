// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Scarf joint seams (`seam_slope_type`) and the seam gap (`seam_gap`).
//!
//! Orca (`GCode.cpp` `extrude_loop`, `ExtrusionEntity.cpp` `ExtrusionLoopSloped`, `is_smooth`) ends a
//! closed wall short of its start by the seam gap. With the scarf joint on it instead starts the loop
//! low, rising along the first `seam_slope_min_length` of the wall from `seam_slope_start_height` below
//! the layer to the layer's height while the flow rises with it, and retraces that same stretch at the
//! end at full height with the flow falling away, so the two overlap into a slanted joint. The first
//! `2 gap` of the rising part and the last `2 gap` of the retrace are left out.
//!
//! Each point of a sloped piece carries its own Z and flow (`LayerPaths.zs`, `flows`).

use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use i_overlay::i_float::int::point::IntPoint;

/// Orca's `slope_inner_outer_wall_gap`: an inner wall leaves this share of the slope's length free at its start.
const INNER_GAP: f64 = 0.4;

#[derive(Debug, Clone, Copy)]
#[allow(clippy::struct_excessive_bools, reason = "one flag per scarf setting")]
pub(crate) struct Scarf {
    /// `all`: holes too; otherwise contours only.
    pub all: bool,
    pub conditional: bool,
    pub angle_threshold: f64,
    pub overhang_percent: f64,
    pub inner_walls: bool,
    pub entire_loop: bool,
    pub min_length: f64,
    pub steps: u32,
    pub start_height: f64,
    pub start_percent: bool,
    pub speed: f64,
    pub speed_percent: bool,
    pub flow: f64,
    pub nozzle: f64,
}

/// The `seam_gap` in mm: a number or a percent of the nozzle (10 percent by default).
pub(crate) fn seam_gap(cfg: &PrintConfig) -> f64 {
    match cfg.raw.get("seam_gap") {
        Some(serde_json::Value::String(t)) if t.trim().ends_with('%') => t
            .trim()
            .trim_end_matches('%')
            .trim()
            .parse::<f64>()
            .map_or(0.1 * cfg.nozzle_diameter, |p| p * cfg.nozzle_diameter / 100.0),
        Some(_) => cfg.raw_number("seam_gap", 0.0).max(0.0),
        None => 0.1 * cfg.nozzle_diameter,
    }
}

fn percent_or_number(cfg: &PrintConfig, key: &str, default: f64) -> (f64, bool) {
    match cfg.raw.get(key) {
        Some(serde_json::Value::String(t)) if t.trim().ends_with('%') => (
            t.trim().trim_end_matches('%').trim().parse().unwrap_or(default),
            true,
        ),
        Some(_) => (cfg.raw_number(key, default), false),
        None => (default, false),
    }
}

impl Scarf {
    pub(crate) fn of(cfg: &PrintConfig) -> Option<Self> {
        let all = match cfg.raw.get("seam_slope_type") {
            Some(serde_json::Value::String(s)) if s == "all" => true,
            Some(serde_json::Value::String(s)) if s == "external" => false,
            _ => return None,
        };
        let truthy = |k: &str| crate::firmware::truthy(cfg, k);
        let (start_height, start_percent) = percent_or_number(cfg, "seam_slope_start_height", 0.0);
        let (speed, speed_percent) = percent_or_number(cfg, "scarf_joint_speed", 100.0);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a small step count"
        )]
        Some(Self {
            all,
            conditional: truthy("seam_slope_conditional"),
            angle_threshold: cfg.raw_number("scarf_angle_threshold", 155.0).to_radians(),
            overhang_percent: cfg.raw_number("scarf_overhang_threshold", 40.0),
            inner_walls: truthy("seam_slope_inner_walls"),
            entire_loop: truthy("seam_slope_entire_loop"),
            min_length: cfg.raw_number("seam_slope_min_length", 20.0),
            steps: cfg.raw_number("seam_slope_steps", 10.0).max(1.0) as u32,
            start_height,
            start_percent,
            speed,
            speed_percent,
            flow: cfg.raw_number("scarf_joint_flow_ratio", 1.0),
            nozzle: cfg.nozzle_diameter,
        })
    }

    /// The speed of a sloped piece for a wall that prints at `wall` mm/s: `scarf_joint_speed`, but never faster.
    #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
    pub(crate) fn speed_for(&self, wall: f32) -> f32 {
        let v = if self.speed_percent {
            f64::from(wall) * self.speed / 100.0
        } else {
            self.speed
        };
        wall.min(v as f32)
    }

    /// Whether a loop gets the slope: the type, a smooth outline, and an overhang below the threshold.
    pub(crate) fn applies(
        &self,
        ring: &[IntPoint<i32>],
        hole: bool,
        inner: bool,
        unsupported: f32,
        width: f32,
    ) -> bool {
        if (hole && !self.all) || (inner && !self.inner_walls) {
            return false;
        }
        if self.conditional {
            if !is_smooth(ring, self.angle_threshold, self.nozzle) {
                return false;
            }
            if self.overhang_percent > 0.0
                && f64::from(unsupported) >= self.overhang_percent * 0.01 * f64::from(width)
            {
                return false;
            }
        }
        true
    }
}

/// Orca `ExtrusionLoop::is_smooth`: no vertex turns sharper than `threshold` (the angle between the two
/// edges, 180 degrees for a straight run), read between points `arm` mm along the ring.
pub(crate) fn is_smooth(ring: &[IntPoint<i32>], threshold: f64, arm: f64) -> bool {
    let n = ring.len();
    if n < 3 {
        return true;
    }
    let mm = |p: &IntPoint<i32>| (f64::from(p.x) / SCALE, f64::from(p.y) / SCALE);
    let mut lengths: Vec<f64> = (0..n - 1)
        .map(|i| {
            let (a, b) = (mm(&ring[i]), mm(&ring[i + 1]));
            (a.0 - b.0).m_hypot(a.1 - b.1)
        })
        .collect();
    let (a, b) = (mm(&ring[0]), mm(&ring[n - 1]));
    lengths.push((a.0 - b.0).m_hypot(a.1 - b.1).max(0.1));
    let next = |i: usize| (i + 1) % n;
    let prev = |i: usize| (i + n - 1) % n;
    let (mut ip, mut ic, mut inx) = (0usize, 0usize, 0usize);
    let (mut dp, mut dn) = (0.0f64, 0.0f64);
    let mut guard = 0;
    while dp < arm && guard < 4 * n + 8 {
        ip = prev(ip);
        dp += lengths[ip];
        guard += 1;
    }
    for _ in 0..n {
        let mut guard = 0;
        while dp - lengths[ip] > arm && guard < 4 * n + 8 {
            dp -= lengths[ip];
            ip = next(ip);
            guard += 1;
        }
        let mut guard = 0;
        while dn < arm && guard < 4 * n + 8 {
            dn += lengths[inx];
            inx = next(inx);
            guard += 1;
        }
        let (p0, p1, p2) = (mm(&ring[ip]), mm(&ring[ic % n]), mm(&ring[inx]));
        let (v1, v2) = ((p0.0 - p1.0, p0.1 - p1.1), (p2.0 - p1.0, p2.1 - p1.1));
        let angle = (v1.0 * v2.1 - v1.1 * v2.0).m_atan2(v1.0 * v2.0 + v1.1 * v2.1);
        if if angle > 0.0 {
            angle < threshold
        } else {
            angle > -threshold
        } {
            return false;
        }
        let step = lengths[ic % n];
        ic += 1;
        dp += step;
        dn -= step;
    }
    true
}

/// Which part of a sloped loop a point belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Part {
    /// Rising from below the layer.
    Rise,
    /// The wall at full height.
    Flat,
    /// The retrace over the start, flow falling.
    Retrace,
}

/// A planned scarf loop: points in order with their height ratio (0 a layer below, 1 at the layer)
/// and flow ratio, each of the segment ending at the point, in the three parts.
pub(crate) struct Sloped {
    pub points: Vec<Point>,
    pub z_ratio: Vec<f32>,
    pub flow: Vec<f32>,
    pub parts: Vec<(Part, usize, usize)>,
}

type Pt = (f64, f64);

fn len(a: Pt, b: Pt) -> f64 {
    (a.0 - b.0).m_hypot(a.1 - b.1)
}

fn length(p: &[Pt]) -> f64 {
    p.windows(2).map(|w| len(w[0], w[1])).sum()
}

/// The polyline cut at `at` units from its start: the part before and the part from there on.
fn split_at(p: &[Pt], at: f64) -> (Vec<Pt>, Vec<Pt>) {
    let mut acc = 0.0;
    let mut head = vec![p[0]];
    for (i, w) in p.windows(2).enumerate() {
        let l = len(w[0], w[1]);
        if acc + l >= at && l > 0.0 {
            let t = (at - acc) / l;
            let cut = (w[0].0 + (w[1].0 - w[0].0) * t, w[0].1 + (w[1].1 - w[0].1) * t);
            head.push(cut);
            let mut tail = vec![cut];
            tail.extend(p.iter().skip(i + 1).copied());
            return (head, tail);
        }
        acc += l;
        head.push(w[1]);
    }
    (head, vec![*p.last().unwrap_or(&p[0])])
}

/// Splits long segments in halves until none exceeds `max` (Orca `handle_line`).
fn detail(p: &[Pt], max: f64) -> Vec<Pt> {
    fn rec(a: Pt, b: Pt, max: f64, out: &mut Vec<Pt>) {
        if len(a, b) <= max {
            out.push(b);
        } else {
            let m = (f64::midpoint(a.0, b.0), f64::midpoint(a.1, b.1));
            rec(a, m, max, out);
            rec(m, b, max, out);
        }
    }
    let mut out = vec![p[0]];
    for w in p.windows(2) {
        rec(w[0], w[1], max, &mut out);
    }
    out
}

fn trim_end(p: &mut Vec<Pt>, mut d: f64) {
    while d > 0.0 && p.len() >= 2 {
        let l = len(p[p.len() - 2], p[p.len() - 1]);
        if l <= d {
            p.pop();
            d -= l;
        } else {
            let (a, b) = (p[p.len() - 2], p[p.len() - 1]);
            let t = (l - d) / l;
            let last = p.len() - 1;
            p[last] = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
            break;
        }
    }
}

impl Scarf {
    /// Orca's scarf loop (`ExtrusionLoopSloped`) for a ring that starts at its seam. `gap` is the seam gap
    /// and `height` the layer height, mm; `inner` marks an inner wall.
    pub(crate) fn slope(&self, ring: &[IntPoint<i32>], gap: f64, height: f64, inner: bool) -> Option<Sloped> {
        let mut poly: Vec<Pt> = ring.iter().map(|p| (f64::from(p.x), f64::from(p.y))).collect();
        poly.push(*poly.first()?);
        let unit = SCALE;
        let loop_len = length(&poly) / unit;
        if loop_len <= 0.0 {
            return None;
        }
        let slope_len = if self.entire_loop {
            loop_len
        } else {
            self.min_length.min(loop_len)
        };
        let mut start_ratio = if self.start_percent {
            self.start_height / 100.0
        } else {
            self.start_height / height
        };
        if start_ratio >= 1.0 {
            start_ratio = 0.99;
        }
        let gap_u = gap * unit;
        let max_seg = slope_len * unit / f64::from(self.steps);
        // The slope path and the flat rest.
        let (slope, flat) = if slope_len < loop_len {
            split_at(&poly, slope_len * unit)
        } else {
            (poly.clone(), Vec::new())
        };
        let mut rise = detail(&slope, max_seg);
        // The retrace: the same stretch, less the last gap, flow from 1 - start to what is left.
        let mut retrace = rise.clone();
        let mut end_ratio = 1.0;
        let l = length(&retrace);
        if gap_u > 0.0 {
            if l > gap_u {
                trim_end(&mut retrace, gap_u);
                end_ratio = start_ratio + (1.0 - start_ratio) * ((l - gap_u) / l);
            } else {
                retrace.clear();
            }
        }
        // `clip_slope`: the retrace ends one more gap early and the rise starts two gaps (or a share of
        // its length on an inner wall) late.
        trim_end(&mut retrace, gap_u);
        let rise_len = length(&rise);
        let front = if inner { rise_len * INNER_GAP } else { 2.0 * gap_u };
        rise.reverse();
        trim_end(&mut rise, front);
        rise.reverse();
        if rise.len() < 2 {
            return None;
        }
        let mut out = Sloped {
            points: Vec::new(),
            z_ratio: Vec::new(),
            flow: Vec::new(),
            parts: Vec::new(),
        };
        let to_point = |p: Pt| Point::new(p.0.round() as i32, p.1.round() as i32);
        let flow = self.flow as f32;
        // Rise: both ratios from the start height to 1 along what is left.
        let total = length(&rise);
        let mut cum = 0.0;
        let begin = out.points.len();
        for (i, &p) in rise.iter().enumerate() {
            if i > 0 {
                cum += len(rise[i - 1], p);
            }
            #[allow(clippy::cast_possible_truncation, reason = "ratios between 0 and 1")]
            let r = (start_ratio + (1.0 - start_ratio) * if total > 0.0 { cum / total } else { 1.0 }) as f32;
            out.points.push(to_point(p));
            out.z_ratio.push(r);
            out.flow.push(r * flow);
        }
        out.parts.push((Part::Rise, begin, out.points.len()));
        // The flat wall, from the end of the slope to the seam point.
        if flat.len() >= 2 {
            let begin = out.points.len().saturating_sub(1);
            for &p in flat.iter().skip(1) {
                out.points.push(to_point(p));
                out.z_ratio.push(1.0);
                out.flow.push(1.0);
            }
            out.parts.push((Part::Flat, begin, out.points.len()));
        }
        if retrace.len() >= 2 {
            let total = length(&retrace);
            let mut cum = 0.0;
            // Joined to the end of the loop, which is the seam point where the retrace starts.
            let begin = out.points.len().saturating_sub(1);
            if let (Some(last), Some(&first)) = (out.points.last().copied(), retrace.first())
                && last != to_point(first)
            {
                out.points.push(to_point(first));
                out.z_ratio.push(1.0);
                out.flow.push(1.0);
            }
            for (i, &p) in retrace.iter().enumerate().skip(1) {
                cum += len(retrace[i - 1], p);
                let t = if total > 0.0 { cum / total } else { 1.0 };
                #[allow(clippy::cast_possible_truncation, reason = "ratios between 0 and 1")]
                let e = ((1.0 - start_ratio) + ((1.0 - end_ratio) - (1.0 - start_ratio)) * t) as f32;
                out.points.push(to_point(p));
                out.z_ratio.push(1.0);
                out.flow.push(e * flow);
            }
            out.parts.push((Part::Retrace, begin, out.points.len()));
        }
        Some(out)
    }
}

/// Drops the last `gap` mm of a closed wall's polyline (Orca `clip_end` by `seam_gap`).
pub(crate) fn clip_end(points: &mut Vec<Point>, gap: f64) {
    let mut left = gap * SCALE;
    while left > 0.0 && points.len() >= 2 {
        let (a, b) = (points[points.len() - 2], points[points.len() - 1]);
        #[allow(
            clippy::cast_precision_loss,
            reason = "a distance of a few mm in internal units"
        )]
        let l = (a.dist2(b) as f64).sqrt();
        if l <= left {
            points.pop();
            left -= l;
        } else {
            let t = (l - left) / l;
            let last = points.len() - 1;
            #[allow(
                clippy::cast_possible_truncation,
                reason = "a point on a segment between two points"
            )]
            {
                points[last] = Point::new(
                    (f64::from(a.x) + f64::from(b.x - a.x) * t).round() as i32,
                    (f64::from(a.y) + f64::from(b.y - a.y) * t).round() as i32,
                );
            }
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(side_mm: f64) -> Vec<IntPoint<i32>> {
        let s = (side_mm * SCALE) as i32;
        vec![
            IntPoint::new(0, 0),
            IntPoint::new(s, 0),
            IntPoint::new(s, s),
            IntPoint::new(0, s),
        ]
    }

    fn scarf() -> Scarf {
        Scarf {
            all: false,
            conditional: false,
            angle_threshold: 155f64.to_radians(),
            overhang_percent: 40.0,
            inner_walls: false,
            entire_loop: false,
            min_length: 20.0,
            steps: 10,
            start_height: 0.0,
            start_percent: false,
            speed: 100.0,
            speed_percent: true,
            flow: 1.0,
            nozzle: 0.4,
        }
    }

    #[test]
    fn the_slope_rises_over_the_first_stretch_and_the_retrace_takes_the_flow_back() {
        let s = scarf().slope(&square(40.0), 0.04, 0.2, false).unwrap();
        // Three parts, the rise from a layer below to the layer, the flat wall and the retrace.
        assert_eq!(
            s.parts.iter().map(|p| p.0).collect::<Vec<_>>(),
            [Part::Rise, Part::Flat, Part::Retrace]
        );
        assert!(s.z_ratio[0] < 0.01 && (s.z_ratio[s.parts[0].2 - 1] - 1.0).abs() < 1e-3);
        // The rise is 20 mm long (less the front gap) and the retrace ends near 0 flow.
        let rise_len: f64 = s.points[..s.parts[0].2]
            .windows(2)
            .map(|w| w[0].dist_mm(w[1]))
            .sum();
        assert!((rise_len - 20.0).abs() < 0.2, "{rise_len}");
        assert!(s.flow.last().copied().unwrap() < 0.05);
        // Where the rise and the retrace overlap the flows add to about one.
        let first_flow = s.flow[1];
        let retrace_start = s.parts[2].1 + 1;
        assert!(
            s.flow[retrace_start] > 0.9 && first_flow < 0.1,
            "{} {}",
            s.flow[retrace_start],
            first_flow
        );
    }

    #[test]
    fn the_seam_gap_is_a_share_of_the_nozzle_and_the_end_is_clipped_by_it() {
        let mut c = PrintConfig::default();
        assert!((seam_gap(&c) - 0.04).abs() < 1e-9);
        c.raw.insert("seam_gap".into(), serde_json::json!("25%"));
        assert!((seam_gap(&c) - 0.1).abs() < 1e-9);
        let mut pts: Vec<Point> = vec![
            Point::new(0, 0),
            Point::new(10_000, 0),
            Point::new(10_000, 10_000),
        ];
        clip_end(&mut pts, 0.3);
        assert_eq!(pts.last().copied(), Some(Point::new(10_000, 7_000)));
    }

    #[test]
    fn a_smooth_ring_passes_the_condition_and_a_square_does_not() {
        assert!(!is_smooth(&square(20.0), 155f64.to_radians(), 0.4));
        let round: Vec<IntPoint<i32>> = (0..90)
            .map(|i| {
                let a = std::f64::consts::TAU * f64::from(i) / 90.0;
                IntPoint::new((100_000.0 * a.m_cos()) as i32, (100_000.0 * a.m_sin()) as i32)
            })
            .collect();
        assert!(is_smooth(&round, 155f64.to_radians(), 0.4));
    }
}
